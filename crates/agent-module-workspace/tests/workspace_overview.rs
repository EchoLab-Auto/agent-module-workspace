//! `workspace.overview` —— **模块私有只读方法**的专属契约测试。
//!
//! 这条方法的存在意义不是"多一个统计接口"，而是验证一种**演进方式**：
//! 模块新增一个自己的操作，宿主（Core / Panel）**不新增 `BackendCommand`
//! 变体、不加模块 id 特判**，只经框架已有的通用调用通道
//! `InvokeModuleOp { module, method, payload }` → `ModuleInvokeResult { data }`
//! 往返。因此本文件除了业务语义（计数 / 只读 / team_id 必填），还钉住：
//!
//! 1. 方法在 `COMMANDS` 里**声明**（否则宿主按 id 分发时找不到归属）；
//! 2. 框架 `ModuleRegistry` 的 `command_owner` + `dispatch_command_async`
//!    就能完成 Core `dispatch_to_module` 的内置模块分支（无需任何宿主代码）；
//! 3. 未声明的方法返回 `None`——宿主据此回显式错误，而不是静默超时。
//!
//! 注意：本文件**不**依赖 Core crate（独立仓库对 Core 是包级循环依赖）。
//! Core 侧边界用框架注册表 + 其源码里 `dispatch_to_module` 的同一段判据
//! （`command_owner(name) == module`）在测试里原样复现。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use agent_module_workspace::commands::{self, handle};
use agent_module_workspace::{Config, ModuleState, MODULE_ID};

/// 每个测试独占一个临时目录（进程内并行 + 重复运行都不串）。
struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "echo-ws-overview-{tag}-{}-{nanos}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("创建临时目录");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn state_with(dir: &Path) -> Arc<ModuleState> {
    let state = Arc::new(ModuleState::new(Config {
        state_dir: dir.to_string_lossy().into_owned(),
    }));
    state.attach_self();
    state
}

async fn call(state: &Arc<ModuleState>, name: &str, payload: Value) -> Result<Value, String> {
    handle(state, name, payload)
        .await
        .expect("本模块应认领该命令")
}

async fn save(state: &Arc<ModuleState>, session: Value) {
    call(
        state,
        commands::SAVE_SESSION,
        json!({ "team_id": "t", "session": session }),
    )
    .await
    .expect("保存工作区会话");
}

/// 方法已声明 + 已认领（前者决定宿主能否按 id 找到本模块，后者决定不会
/// 落到「声明了但处理器没认领」的兜底错误）。
#[tokio::test]
async fn overview_is_declared_and_claimed() {
    assert_eq!(commands::OVERVIEW, "workspace.overview");
    assert!(
        commands::COMMANDS.contains(&commands::OVERVIEW),
        "未在 COMMANDS 里声明 = 宿主按模块 id 分发时找不到归属"
    );
    let dir = TempDir::new("declare");
    let state = state_with(dir.path());
    let data = call(&state, commands::OVERVIEW, json!({"team_id": "t"}))
        .await
        .expect("空人格也有权威快照");
    assert_eq!(data["team_id"], "t");
    assert_eq!(data["workspaces"], 0);
    assert_eq!(data["conversations"], 0);
    assert_eq!(data["directories"], 0);
    assert!(data["active"].is_null());
    assert!(
        data.get("request_id").is_none(),
        "未提供 request_id 时不应凭空生成"
    );
}

/// `team_id` 必填：缺失 / 空串都是显式错误，且**不发**后端错误事件。
///
/// 通用调用通道的错误由 `ModuleInvokeResult { ok:false, error }` 承载；这里
/// 再发一条 `Error` 会让面板同时弹 toast + 显示调用失败，且多窗口串台。
#[tokio::test]
async fn overview_requires_explicit_team_id_without_events() {
    let dir = TempDir::new("team");
    let state = state_with(dir.path());
    let seen: Arc<std::sync::Mutex<Vec<Value>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
    {
        let seen = seen.clone();
        state.set_event_sink(Arc::new(move |event| {
            seen.lock().unwrap().push(event.payload);
        }));
    }

    for payload in [json!({}), json!({"team_id": ""}), json!({"team_id": null})] {
        let error = call(&state, commands::OVERVIEW, payload)
            .await
            .expect_err("缺 team_id 必须失败");
        assert!(error.contains("team_id"), "error: {error}");
        assert!(error.contains(commands::OVERVIEW), "error: {error}");
    }
    assert!(
        seen.lock().unwrap().is_empty(),
        "概览不得发后端事件：{:?}",
        seen.lock().unwrap()
    );
}

/// 计数来自**同一次快照**，对话数用读视图规则（空列表 = 存量主对话）。
#[tokio::test]
async fn overview_counts_workspaces_and_conversations_from_one_snapshot() {
    let dir = TempDir::new("counts");
    let state = state_with(dir.path());
    // A：两条明文对话 + 一个本机目录 + 一个远程目录。
    save(
        &state,
        json!({
            "id": "a",
            "name": "A",
            "directories": ["/srv/a", {"path": "/srv/remote", "node": "peer-a"}],
            "conversations": [
                {"id": "main", "name": "主对话", "legacy": true},
                {"id": "docs", "name": "文档线"},
            ],
        }),
    )
    .await;
    // B：没有 conversations 字段 = 读取期惰性补位一条 legacy 主对话。
    save(
        &state,
        json!({"id": "b", "name": "B", "directories": ["/srv/b"]}),
    )
    .await;
    call(
        &state,
        commands::ACTIVATE_SESSION,
        json!({"team_id": "t", "id": "a", "conversation": "docs"}),
    )
    .await
    .expect("激活");

    let data = call(
        &state,
        commands::OVERVIEW,
        json!({"team_id": "t", "request_id": "req-1"}),
    )
    .await
    .expect("概览");
    assert_eq!(data["team_id"], "t");
    assert_eq!(data["request_id"], "req-1", "request_id 必须原样回显");
    assert_eq!(data["workspaces"], 2);
    assert_eq!(data["conversations"], 3, "A:2 + B:惰性主对话 1");
    assert_eq!(data["directories"], 3);
    assert_eq!(data["remote_directories"], 1);
    assert_eq!(data["active"], "a");
    // 对话维度刻意不返回：`snapshot()` 不含 active_conversation，二次读取会
    // 破坏「同一次快照」的承诺。
    assert!(data.get("active_conversation").is_none());
}

/// 只读：不建文件、不写盘、不物化惰性主对话；重复调用字节级不变。
#[tokio::test]
async fn overview_has_no_side_effects_on_disk() {
    let dir = TempDir::new("readonly");
    let state = state_with(dir.path());
    let ghost = state.config().document_path("ghost");
    assert!(!ghost.exists());

    let zeros = call(&state, commands::OVERVIEW, json!({"team_id": "ghost"}))
        .await
        .expect("未知人格 = 空文档，而不是错误");
    assert_eq!(zeros["workspaces"], 0);
    assert!(
        !ghost.exists(),
        "只读概览不得创建 echo-workspaces-ghost.json"
    );

    save(
        &state,
        json!({"id": "a", "name": "A", "directories": ["/srv/a"]}),
    )
    .await;
    let path = state.config().document_path("t");
    let before = std::fs::read(&path).expect("保存后应有文档");
    for _ in 0..2 {
        let data = call(&state, commands::OVERVIEW, json!({"team_id": "t"}))
            .await
            .expect("概览");
        assert_eq!(data["conversations"], 1);
    }
    let after = std::fs::read(&path).expect("文档仍在");
    assert_eq!(before, after, "概览不得改写工作区文档");
}

/// `request_id` 类型错误必须显式失败：静默丢弃会让调用方永远等回包。
#[tokio::test]
async fn overview_rejects_malformed_request_id() {
    let dir = TempDir::new("reqid");
    let state = state_with(dir.path());
    let error = call(
        &state,
        commands::OVERVIEW,
        json!({"team_id": "t", "request_id": 7}),
    )
    .await
    .expect_err("非字符串 request_id 必须失败");
    assert!(error.contains("request_id"), "error: {error}");
}

/// **真实宿主边界**：框架注册表就是 Core 内置模块分发的执行面。
///
/// Core 的 `ModuleHost::dispatch_to_module` 对内置模块只做两件事：
/// 1. `registry.command_owner(method) == Some(module)` → `dispatch_command_async`；
/// 2. 否则 `None` → 宿主回「模块未挂载，或未声明方法」。
///
/// 本测试原样复现这两行判据，断言新方法**零宿主改动**即可调用；未声明的方法
/// 仍然 `None`（宿主有显式错误，不会静默）。
#[tokio::test]
async fn framework_registry_dispatches_private_method_without_host_code() {
    let dir = TempDir::new("registry");
    let registry = echo_module::ModuleRegistry::new();
    let (module, _state) = agent_module_workspace::module_with_state("test");
    registry.register(module).expect("注册模块");
    registry.set_config(MODULE_ID, json!({"state_dir": dir.path()}));
    registry
        .mount(MODULE_ID, &echo_module::MountContext::new())
        .expect("挂载模块");

    // Core 内置模块分支的判据（逐字复现，见 Core modules.rs）。
    let dispatch = |method: &'static str, payload: Value| {
        let registry = &registry;
        async move {
            match registry.command_owner(method) {
                Some(owner) if owner == MODULE_ID => {
                    registry.dispatch_command_async(method, payload).await
                }
                Some(owner) => Some(Err(format!("方法 {method} 属于模块 {owner}"))),
                None => None,
            }
        }
    };

    let outcome = dispatch(commands::OVERVIEW, json!({"team_id": "t"}))
        .await
        .expect("声明的模块方法必须有人处理")
        .expect("概览应成功");
    assert_eq!(outcome["team_id"], "t");
    assert_eq!(outcome["workspaces"], 0);

    assert_eq!(
        registry.command_owner(commands::OVERVIEW).as_deref(),
        Some(MODULE_ID),
        "归属必须是本模块 id（按 id 分发的唯一依据）"
    );
    assert_eq!(registry.command_owner("workspace.unknown"), None);
    assert!(
        dispatch("workspace.unknown", json!({})).await.is_none(),
        "未声明的方法必须无人处理，由宿主回显式错误"
    );
}
