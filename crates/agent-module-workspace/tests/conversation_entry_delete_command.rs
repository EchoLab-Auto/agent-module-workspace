//! C3b：`workspace.deleteConversation`（模块私有写方法）的专属契约测试。
//!
//! C3a 已在 store 层写好 [`WorkspaceStore::delete_conversation_entry`]（只删入口、
//! 保留历史、幂等、拒绝最后一条、通道退役）。本文件只验证**接线**这一层：
//!
//! 1. 方法在 `COMMANDS` 里声明、被 `handle` 认领（宿主按模块 id 分发时找得到）；
//! 2. 默认删除**不清历史**：全程不发 `workspace.conversation_deleted`，也不发
//!    `Error` 后端事件（失败由 `ModuleInvokeResult.error` 承载，避免双提示）；
//! 3. 三种业务结果都是 `Ok` + 明确 `result`：`deleted` / `already_absent` /
//!    `refused_last_conversation`，并原样回显 `request_id`（面板配对靠它）；
//! 4. 硬失败（缺参 / 落盘失败）走 `Err`，内存与磁盘都不变；
//! 5. 安全审查：陈旧快照的全量 `SaveWorkspaceSession` 不能把已退役通道的对话
//!    写回来（fail-closed），正常保存与元数据编辑不受影响。
//!
//! 全部使用进程私有临时目录，不读不写真实 `echo-workspaces-*.json`，
//! 不产生任何真实会话历史。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
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
            "echo-ws-c3b-delete-{tag}-{}-{nanos}",
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

async fn delete(state: &Arc<ModuleState>, payload: Value) -> Result<Value, String> {
    let mut body = payload;
    let object = body.as_object_mut().expect("payload 必须是对象");
    object.insert("team_id".into(), json!("t"));
    object.insert("workspace_id".into(), json!("proj"));
    object
        .entry("conversation_id")
        .or_insert_with(|| json!("docs"));
    call(state, commands::DELETE_CONVERSATION, body).await
}

/// 收集模块事件（`(name, payload)`）。
#[derive(Clone, Default)]
struct Events {
    seen: Arc<Mutex<Vec<(String, Value)>>>,
}

impl Events {
    fn install(&self, state: &Arc<ModuleState>) {
        let seen = Arc::clone(&self.seen);
        state.set_event_sink(Arc::new(move |event| {
            seen.lock()
                .unwrap()
                .push((event.name.clone(), event.payload));
        }));
    }

    fn count(&self, name: &str) -> usize {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .filter(|(event, _)| event == name)
            .count()
    }

    fn backend_error_count(&self) -> usize {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .filter(|(event, payload)| {
                event == agent_module_workspace::events::BACKEND_EVENT
                    && payload.get("Error").is_some()
            })
            .count()
    }
}

fn two_conversations() -> Value {
    json!({
        "id": "proj",
        "name": "Proj",
        "directories": ["/srv/proj"],
        "conversations": [
            {"id": "main", "name": "主对话", "legacy": true},
            {"id": "docs", "name": "文档线"},
        ],
        "last_conversation": "docs",
    })
}

/// 方法已声明 + 已认领；成功返回带 `request_id` 回显的 `deleted` 结果。
#[tokio::test]
async fn delete_entry_is_declared_and_returns_paired_result() {
    assert_eq!(
        commands::DELETE_CONVERSATION,
        "workspace.deleteConversation"
    );
    assert!(
        commands::COMMANDS.contains(&commands::DELETE_CONVERSATION),
        "未在 COMMANDS 里声明 = 宿主按模块 id 分发时找不到归属"
    );
    let dir = TempDir::new("declare");
    let state = state_with(dir.path());
    save(&state, two_conversations()).await;

    let data = delete(&state, json!({"request_id": "req-del-1"}))
        .await
        .expect("删除非最后一条应成功");
    assert_eq!(data["team_id"], "t");
    assert_eq!(data["workspace_id"], "proj");
    assert_eq!(data["conversation_id"], "docs");
    assert_eq!(data["result"], "deleted");
    assert_eq!(data["conversation"]["id"], "docs");
    assert_eq!(data["conversation"]["name"], "文档线");
    assert_eq!(data["request_id"], "req-del-1", "request_id 必须原样回显");
    assert!(
        data["message"].as_str().unwrap().contains("历史保留"),
        "data: {data}"
    );

    let session = state.store("t").get("proj").expect("工作区仍在");
    assert_eq!(session.conversations.len(), 1, "只删目标入口");
    assert_eq!(session.conversations[0].id, "main");
    assert_eq!(session.last_conversation.as_deref(), Some("main"));
}

/// 默认删除**不清历史**：不发 `conversation_deleted`（宿主历史清理钩子），
/// 只发一次 `workspace.changed`（列表广播由宿主完成）。
#[tokio::test]
async fn delete_entry_never_clears_history() {
    let dir = TempDir::new("no-clear");
    let state = state_with(dir.path());
    save(&state, two_conversations()).await;
    let events = Events::default();
    events.install(&state);

    delete(&state, json!({})).await.expect("删除成功");

    assert_eq!(
        events.count(agent_module_workspace::events::CONVERSATION_DELETED),
        0,
        "只删入口不得触发历史清理"
    );
    assert_eq!(
        events.count(agent_module_workspace::events::CHANGED),
        1,
        "成功删除应通知宿主刷新列表"
    );
    assert_eq!(events.backend_error_count(), 0, "成功路径不得发错误事件");
}

/// 拒绝最后一条是**业务结果**（`Ok` + `refused_last_conversation`），不是传输
/// 失败：面板要能按 `request_id` 配对并显示明确提示。文档字节级不变。
#[tokio::test]
async fn refuses_last_conversation_as_paired_business_result() {
    let dir = TempDir::new("refuse-last");
    let state = state_with(dir.path());
    save(
        &state,
        json!({
            "id": "proj",
            "name": "Proj",
            "directories": ["/srv/proj"],
            "conversations": [{"id": "main", "name": "主对话", "legacy": true}],
            "last_conversation": "main",
        }),
    )
    .await;
    let events = Events::default();
    events.install(&state);
    let path = state.config().document_path("t");
    let before = std::fs::read(&path).expect("保存后应有文档");

    let data = delete(
        &state,
        json!({"conversation_id": "main", "request_id": "req-last"}),
    )
    .await
    .expect("最后一条应返回业务结果而不是 Err");
    assert_eq!(data["result"], "refused_last_conversation");
    assert_eq!(data["request_id"], "req-last");
    assert_eq!(data["conversation"]["id"], "main");
    let message = data["message"].as_str().unwrap_or_default();
    assert!(message.contains("最后一条"), "message: {message}");
    assert!(message.contains("历史保留"), "message: {message}");

    assert_eq!(
        std::fs::read(&path).expect("文档仍在"),
        before,
        "拒绝不得写盘"
    );
    assert_eq!(events.count(agent_module_workspace::events::CHANGED), 0);
    assert_eq!(events.backend_error_count(), 0, "业务拒绝不应冒成错误事件");
}

/// 幂等：重复删除返回 `already_absent`，不写盘、不通知、不报错。
#[tokio::test]
async fn repeated_delete_is_idempotent_without_side_effects() {
    let dir = TempDir::new("idempotent");
    let state = state_with(dir.path());
    save(&state, two_conversations()).await;
    delete(&state, json!({"request_id": "first"}))
        .await
        .expect("首次");
    let path = state.config().document_path("t");
    let after_first = std::fs::read(&path).expect("首次删除后应有文档");

    let events = Events::default();
    events.install(&state);
    let data = delete(&state, json!({"request_id": "second"}))
        .await
        .expect("重复删除不是错误");
    assert_eq!(data["result"], "already_absent");
    assert_eq!(data["request_id"], "second");
    assert!(data["conversation"].is_null());
    assert_eq!(std::fs::read(&path).expect("文档仍在"), after_first);
    assert_eq!(events.count(agent_module_workspace::events::CHANGED), 0);
    assert_eq!(events.backend_error_count(), 0);
}

/// 缺参 / 参数类型错误 → `Err`，且**不发**后端错误事件（避免面板双提示）。
#[tokio::test]
async fn rejects_malformed_payload_without_events() {
    let dir = TempDir::new("malformed");
    let state = state_with(dir.path());
    let events = Events::default();
    events.install(&state);

    for payload in [
        json!({"workspace_id": "proj", "conversation_id": "docs"}),
        json!({"team_id": "", "workspace_id": "proj", "conversation_id": "docs"}),
        json!({"team_id": "t", "conversation_id": "docs"}),
        json!({"team_id": "t", "workspace_id": "proj"}),
        json!({"team_id": "t", "workspace_id": "proj", "conversation_id": "docs", "request_id": 7}),
    ] {
        let error = call(&state, commands::DELETE_CONVERSATION, payload)
            .await
            .expect_err("畸形载荷必须失败");
        assert!(
            error.contains(commands::DELETE_CONVERSATION),
            "错误要指向方法名（否则面板不知是哪条调用失败）: {error}"
        );
    }
    assert_eq!(events.backend_error_count(), 0);
    assert_eq!(events.count(agent_module_workspace::events::CHANGED), 0);
}

/// 落盘失败 → `Err`（面板显示保存失败），内存与磁盘都不变、不发任何事件。
#[tokio::test]
async fn persist_failure_is_explicit_error_without_state_change() {
    let dir = TempDir::new("save-failure");
    let state = state_with(dir.path());
    save(&state, two_conversations()).await;
    let path = state.config().document_path("t");
    let before = std::fs::read(&path).expect("保存后应有文档");

    // 让 save_locked 的临时文件路径变成一个目录：write 必失败。
    std::fs::create_dir_all(path.with_extension("json.tmp")).expect("tmp dir");
    let events = Events::default();
    events.install(&state);

    let error = delete(&state, json!({"request_id": "req-fail"}))
        .await
        .expect_err("落盘失败必须报错");
    assert!(error.contains("写入"), "unexpected error: {error}");
    assert_eq!(events.count(agent_module_workspace::events::CHANGED), 0);
    assert_eq!(events.backend_error_count(), 0);

    let session = state.store("t").get("proj").expect("内存会话");
    assert_eq!(session.conversations.len(), 2, "失败不得改内存");
    assert!(state.store("t").retired_channels_of("proj").is_empty());
    let disk = std::fs::read(&path).expect("磁盘文档仍在");
    assert_eq!(disk, before, "失败不得改磁盘");
}

/// 安全审查：陈旧快照的全量保存**不能**把已退役通道的对话写回来。
///
/// `SaveWorkspaceSession` 用面板快照整表替换 `conversations`；删除成功但广播
/// 尚未到达时，面板再发一次保存就会让被删对话（同一通道、同一历史）复活。
/// 这里对退役通道 fail-closed：整条保存拒绝、工作区文档不变。
#[tokio::test]
async fn stale_full_save_cannot_resurrect_retired_channel() {
    let dir = TempDir::new("resurrect");
    let state = state_with(dir.path());
    save(&state, two_conversations()).await;
    delete(&state, json!({})).await.expect("删掉 docs");
    let path = state.config().document_path("t");
    let after_delete = std::fs::read(&path).expect("文档");

    // 陈旧快照：仍带着被删的 docs。
    let error = call(
        &state,
        commands::SAVE_SESSION,
        json!({"team_id": "t", "session": two_conversations()}),
    )
    .await
    .expect_err("复用退役通道必须拒绝");
    assert!(error.contains("退役"), "unexpected error: {error}");
    assert!(error.contains("docs"), "unexpected error: {error}");
    assert_eq!(
        std::fs::read(&path).expect("文档仍在"),
        after_delete,
        "拒绝不得写盘"
    );
    let session = state.store("t").get("proj").expect("会话");
    assert_eq!(session.conversations.len(), 1, "被删对话不得复活");

    // 正常路径不受影响：剩下的对话改名（通道不变）可以保存。
    call(
        &state,
        commands::SAVE_SESSION,
        json!({
            "team_id": "t",
            "session": {
                "id": "proj",
                "name": "Proj",
                "directories": ["/srv/proj"],
                "conversations": [{"id": "main", "name": "主对话（改名）", "legacy": true}],
                "last_conversation": "main",
            },
        }),
    )
    .await
    .expect("不含退役通道的保存应放行");
}

/// legacy 裸通道退役后同样不得复用：陈旧快照带 `legacy: true` 的新对话会被拒。
#[tokio::test]
async fn retired_legacy_channel_is_not_reusable_via_full_save() {
    let dir = TempDir::new("legacy-retired");
    let state = state_with(dir.path());
    save(&state, two_conversations()).await;
    delete(
        &state,
        json!({"conversation_id": "main", "request_id": "legacy"}),
    )
    .await
    .expect("删掉 legacy 主对话（不是最后一条）");
    assert_eq!(
        state.store("t").retired_channels_of("proj"),
        vec!["proj".to_string()],
        "裸通道必须退役"
    );

    let error = call(
        &state,
        commands::SAVE_SESSION,
        json!({
            "team_id": "t",
            "session": {
                "id": "proj",
                "name": "Proj",
                "directories": ["/srv/proj"],
                "conversations": [
                    {"id": "main", "name": "主对话", "legacy": true},
                    {"id": "docs", "name": "文档线"},
                ],
                "last_conversation": "docs",
            },
        }),
    )
    .await
    .expect_err("裸通道已退役，不能再用 legacy 身份写回");
    assert!(error.contains("退役"), "unexpected error: {error}");

    // 新对话走 `<ws>/<conv>` 通道（`legacy: false`）则完全合法。
    call(
        &state,
        commands::SAVE_SESSION,
        json!({
            "team_id": "t",
            "session": {
                "id": "proj",
                "name": "Proj",
                "directories": ["/srv/proj"],
                "conversations": [
                    {"id": "docs", "name": "文档线"},
                    {"id": "notes", "name": "笔记", "legacy": false},
                ],
                "last_conversation": "notes",
            },
        }),
    )
    .await
    .expect("非退役通道应放行");
}

/// 历史遗留的「多条 legacy 共用裸通道」档位：退役只拦**复活**，不拦现存对话。
///
/// 老档可能手写过两条 `legacy: true` 对话（共用裸通道）。删掉其中一条后裸通道
/// 退役；另一条仍存活，它的改名保存必须放行——否则这条无辜对话永远存不回去。
#[tokio::test]
async fn retired_legacy_channel_allows_still_live_conversation() {
    let dir = TempDir::new("legacy-live");
    let state = state_with(dir.path());
    save(
        &state,
        json!({
            "id": "proj",
            "name": "Proj",
            "directories": ["/srv/proj"],
            "conversations": [
                {"id": "main", "name": "主对话", "legacy": true},
                {"id": "backup", "name": "备份", "legacy": true},
            ],
            "last_conversation": "main",
        }),
    )
    .await;
    delete(
        &state,
        json!({"conversation_id": "main", "request_id": "retire-bare"}),
    )
    .await
    .expect("删掉一条 legacy（不是最后一条）");
    assert_eq!(
        state.store("t").retired_channels_of("proj"),
        vec!["proj".to_string()]
    );

    // 存活的 backup 也是裸通道：改名必须可以保存（不是复活）。
    call(
        &state,
        commands::SAVE_SESSION,
        json!({
            "team_id": "t",
            "session": {
                "id": "proj",
                "name": "Proj",
                "directories": ["/srv/proj"],
                "conversations": [
                    {"id": "backup", "name": "备份（改名）", "legacy": true},
                ],
                "last_conversation": "backup",
            },
        }),
    )
    .await
    .expect("现存对话的保存不应被退役规则拦住");

    // 但把已删的 main 写回来仍是复活 → 拒绝。
    let error = call(
        &state,
        commands::SAVE_SESSION,
        json!({
            "team_id": "t",
            "session": {
                "id": "proj",
                "name": "Proj",
                "directories": ["/srv/proj"],
                "conversations": [
                    {"id": "main", "name": "主对话", "legacy": true},
                    {"id": "backup", "name": "备份", "legacy": true},
                ],
                "last_conversation": "main",
            },
        }),
    )
    .await
    .expect_err("已删对话不得复活");
    assert!(error.contains("退役"), "unexpected error: {error}");
}

/// **真实宿主边界**：框架注册表就是 Core 内置模块分发的执行面。
///
/// 与概览（C4）用同一条判据：`command_owner(method) == Some(module)` →
/// `dispatch_command_async`；未声明的方法仍然 `None`。证明删除方法**零宿主
/// 改动**（没有新 `BackendCommand` 变体、没有模块 id 特判）即可调用。
#[tokio::test]
async fn framework_registry_dispatches_delete_without_host_code() {
    let dir = TempDir::new("registry");
    let registry = echo_module::ModuleRegistry::new();
    let (module, _state) = agent_module_workspace::module_with_state("test");
    registry.register(module).expect("注册模块");
    registry.set_config(MODULE_ID, json!({"state_dir": dir.path()}));
    registry
        .mount(MODULE_ID, &echo_module::MountContext::new())
        .expect("挂载模块");

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

    assert_eq!(
        registry
            .command_owner(commands::DELETE_CONVERSATION)
            .as_deref(),
        Some(MODULE_ID),
        "归属必须是本模块 id（按 id 分发的唯一依据）"
    );

    dispatch(
        commands::SAVE_SESSION,
        json!({"team_id": "t", "session": two_conversations()}),
    )
    .await
    .expect("声明的命令必须有人处理")
    .expect("保存应成功");

    let data = dispatch(
        commands::DELETE_CONVERSATION,
        json!({
            "team_id": "t",
            "workspace_id": "proj",
            "conversation_id": "docs",
            "request_id": "via-registry",
        }),
    )
    .await
    .expect("声明的模块方法必须有人处理")
    .expect("删除应成功");
    assert_eq!(data["result"], "deleted");
    assert_eq!(data["request_id"], "via-registry");

    assert_eq!(registry.command_owner("workspace.deleteEverything"), None);
    assert!(
        dispatch("workspace.deleteEverything", json!({}))
            .await
            .is_none(),
        "未声明的方法必须无人处理，由宿主回显式错误"
    );
}

/// `ModuleState` 的其它行为不受影响：未声明的方法仍然 `None`（宿主有显式错误）。
#[tokio::test]
async fn undeclared_method_is_not_claimed() {
    let dir = TempDir::new("undeclared");
    let state = state_with(dir.path());
    assert!(handle(&state, "workspace.deleteEverything", json!({}))
        .await
        .is_none());
    assert_eq!(MODULE_ID, "echo-agent.workspace");
}
