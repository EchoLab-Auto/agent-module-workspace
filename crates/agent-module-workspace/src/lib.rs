//! # agent-module-workspace — 工作区会话模块（独立交付）
//!
//! 工作区会话 = 用户从 Panel 管理的一组工作目录（创建 / 改名 / 删除 / 激活），
//! 可逐目录查看 `git status`、浏览文件、选择目录。激活会话的目录会注入系统
//! 提示词，让模型知道自己该在哪里干活；`workspace` 工具把 list / status /
//! use / create / delete / conversations 暴露给模型。
//!
//! ## 与宿主的关系（本仓能独立存在的原因）
//!
//! 本模块**不依赖 EchoAgentCore 的任何 crate**，只依赖框架仓 `echo-fabric-arch`
//! 的 `echo-module` / `echo-context`。这不是洁癖，而是硬约束：Core 以 git 依赖
//! 引入本仓，本仓若再依赖 Core 的 crate 就是**包级循环依赖**，Cargo 直接拒绝。
//!
//! 代价与对策：
//!
//! | 原本依赖的 | 现在 |
//! |---|---|
//! | `echo-protocol` 的线类型 | [`wire`] 里的镜像（字段名逐字一致） |
//! | 宿主的 `WorkspaceStore` | [`store`] 自己拥有（per-persona，原子落盘） |
//! | 宿主的 `emit` / 会话通道 | 向宿主发**模块事件**（见下） |
//! | 联邦 `remote_query` | 远程目录降级为「不可采集」占位（见 README 的能力边界） |
//!
//! ## 模块事件协议（本仓 → 宿主）
//!
//! 模块通过 `MountContext::emit` 发三类事件，宿主订阅后翻译成会话子系统的
//! 动作。这是"模块负责语义、宿主负责路由"的分界：
//!
//! - `workspace.backend_event` — 载荷就是要发给前端的 `BackendEvent` JSON
//!   （外部标签形状，如 `{"WorkspaceSessions": {…}}`）。宿主反序列化后原样 emit。
//! - `workspace.changed` — `{ team_id, active, active_conversation, sessions }`。
//!   宿主负责：active 存在时确保工作区会话通道已注册（会话名 = 工作区名 +
//!   对话名）、推 `SessionUpdated`、广播 `WorkspaceSessions`。**这些是宿主的
//!   会话子系统，模块不认识它们**——模块只报告"状态变了"。
//! - `workspace.conversation_deleted` — `{ team_id, workspace_id, conversation }`。
//!   宿主负责清空该对话的通道历史（事件日志 / 投影 / 时间线）。
//!
//! ## 启用
//!
//! 由宿主（EchoAgentCore）以 `kind = "builtin"` 挂载；模块本身零参数——
//! 需要的一切（落盘目录）来自 `[module.config]`：
//!
//! ```toml
//! [module.config]
//! state_dir = "/home/me/.config/echo-agent-core"   # 缺省 = $XDG_CONFIG_HOME/echo-agent-core
//! ```

pub mod commands;
pub mod files;
pub mod git;
pub mod prompt;
pub mod remote;
pub mod store;
pub mod tool;
pub mod wire;

// ── 迁移兼容 re-export ────────────────────────────────────────────────────
//
// 宿主（EchoAgentCore）此前用 `echo_agent::workspace::X` 引用这些条目
// （`pub use agent_module_workspace as workspace`）。模块迁仓后这些路径由本仓
// 继续提供，宿主侧不必改调用点——只有真正属于宿主的接线（会话通道、广播）
// 需要动。

pub use files::{
    browse_roots, collect_child_dirs, collect_dir_files, resolve_within_browse_roots,
    resolve_within_directories, FILES_CAP,
};
pub use git::{collect_dir_git, CHANGED_FILES_CAP, GIT_TIMEOUT};
pub use remote::{
    join_node_path, split_node_path, QueryFuture, RemoteQueryHandle, RemoteWorkspaceQuery,
    REMOTE_QUERY,
};
pub use store::{
    channel_scope_id, parse_workspace_channel, ConversationDeleteHook, WorkspaceStore,
    MAX_DIRECTORIES,
};
pub use tool::{
    call as tool_call, description as tool_description, execute as tool_execute,
    parameters as tool_parameters, TOOL_NAME,
};
pub use wire::{
    BrowseRoot, WorkspaceChangedEntry, WorkspaceConversationInfo, WorkspaceDirectory,
    WorkspaceFileEntry, WorkspaceGitInfo, WorkspaceSessionInfo,
};

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use echo_module::{BuiltinModule, Module, ModuleManifest, ModuleTextBlock};
use serde_json::{json, Value};

/// 模块 id（**唯一真值**在这里；宿主的 `WORKSPACE_MODULE_ID` 是它的别名）。
pub const MODULE_ID: &str = "echo-agent.workspace";

/// 提示词块键（宿主按 key 定位块，`order = 50` 与迁移前一致）。
pub const TEXT_BLOCK_KEY: &str = "workspace";

/// 模块事件名（见模块文档）。
pub mod events {
    /// 载荷 = 要发给前端的 `BackendEvent` JSON。
    pub const BACKEND_EVENT: &str = "workspace.backend_event";
    /// 工作区状态变更（宿主据ensure 通道 + 广播列表）。
    pub const CHANGED: &str = "workspace.changed";
    /// 对话被删除（宿主据此清空该对话的通道历史）。
    pub const CONVERSATION_DELETED: &str = "workspace.conversation_deleted";
}

/// 模块配置（`modules.toml` 的 `[module.config]`）。
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    /// 工作区文档落盘目录（`echo-workspaces-{team}.json` 放在这里）。
    ///
    /// 缺省 = `$XDG_CONFIG_HOME/echo-agent-core`（与 Core 迁出前的路径一致，
    /// 因此旧数据可直接读）。空串等价于缺省。
    pub state_dir: String,
}

impl Config {
    /// 解析生效的落盘目录（配置为空时回退 XDG / HOME）。
    pub fn effective_state_dir(&self) -> PathBuf {
        if !self.state_dir.trim().is_empty() {
            return PathBuf::from(self.state_dir.trim());
        }
        let base = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|path| !path.as_os_str().is_empty())
            .or_else(|| std::env::var_os("HOME").map(|home| Path::new(&home).join(".config")))
            .unwrap_or_else(|| PathBuf::from("."));
        base.join("echo-agent-core")
    }

    /// 某个 persona 的文档路径。
    pub fn document_path(&self, team_id: &str) -> PathBuf {
        self.effective_state_dir()
            .join(format!("echo-workspaces-{team_id}.json"))
    }
}

/// 模块运行期状态（进程级单例：模块被 unmount/remount 时 store 不丢）。
///
/// store 的内容本身在磁盘上，这里只是内存视图 + 事件出口；因此重建实例
/// （`mount` 再来一次）不会丢数据，只会重新读盘。
pub struct ModuleState {
    config: RwLock<Config>,
    stores: RwLock<HashMap<String, Arc<store::WorkspaceStore>>>,
    /// 宿主注入的事件出口（`MountContext::events`）。
    emit: RwLock<Option<echo_module::EventSink>>,
    /// 跨机查询接缝（宿主按 [`remote::REMOTE_QUERY`] 注入；`None` = 单机部署）。
    ///
    /// 与 `emit` 同款：进程级单例上的一个槽，`mount` 时填一次。未注入时远程
    /// 目录降级为「不可采集」占位——本机功能不受影响。
    remote_query: RwLock<Option<remote::RemoteQueryHandle>>,
    /// 自引用（弱）：store 的变更钩子需要回调本状态，而本状态持有 store。
    /// 用 `Weak` 断开这条环，钩子在模块被卸载后自然失效。
    self_ref: RwLock<std::sync::Weak<ModuleState>>,
    /// 本实例在**共享 store** 上的钩子槽位 id（见 `store::WorkspaceStore::
    /// upsert_on_change`）。
    ///
    /// 为什么需要：同一份 workspace 文档会被多个模块实例持有（每个 persona
    /// 一个模块实例，而 `store(team_id)` 对任意 team 都合法）。store 进程级
    /// 共享后，钩子必须按实例分槽——单槽会让后注册者顶掉前者，被顶掉那层
    /// 就再也收不到 `workspace.changed`。
    hook_id: u64,
}

/// 钩子槽位 id 发号器（进程级单调）。
static NEXT_HOOK_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

impl std::fmt::Debug for ModuleState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let teams = self.stores.read().map(|s| s.len()).unwrap_or(0);
        f.debug_struct("ModuleState")
            .field("teams", &teams)
            .field(
                "state_dir",
                &self.config.read().map(|c| c.effective_state_dir()).ok(),
            )
            .finish()
    }
}

impl Default for ModuleState {
    fn default() -> Self {
        Self::new(Config::default())
    }
}

impl ModuleState {
    /// 用配置构造。
    pub fn new(config: Config) -> Self {
        Self {
            config: RwLock::new(config),
            stores: RwLock::new(HashMap::new()),
            emit: RwLock::new(None),
            remote_query: RwLock::new(None),
            self_ref: RwLock::new(std::sync::Weak::new()),
            hook_id: NEXT_HOOK_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        }
    }

    /// 建立自引用（构造 `Arc` 之后调用一次）。
    ///
    /// 没有它，store 的变更钩子就拿不到本状态（钩子要回调 `on_store_changed`）；
    /// 而让钩子直接持有 `Arc<ModuleState>` 会形成
    /// `state → store → hook → state` 的强引用环，模块卸载后永不释放。
    pub fn attach_self(self: &Arc<Self>) {
        *self.self_ref.write().unwrap_or_else(|e| e.into_inner()) = Arc::downgrade(self);
    }
    /// 当前配置快照。
    pub fn config(&self) -> Config {
        self.config
            .read()
            .map(|c| c.clone())
            .unwrap_or_else(|e| e.into_inner().clone())
    }

    /// 覆盖配置（`mount` 时由 `modules.toml` 注入）。
    pub fn set_config(&self, config: Config) {
        *self.config.write().unwrap_or_else(|e| e.into_inner()) = config;
    }

    /// 注入事件出口（`mount` 时一次）。
    pub fn set_event_sink(&self, sink: echo_module::EventSink) {
        *self.emit.write().unwrap_or_else(|e| e.into_inner()) = Some(sink);
    }

    /// 注入跨机查询接缝（`mount` 时一次；`None` = 宿主没提供，保持降级）。
    pub fn set_remote_query(&self, query: Option<remote::RemoteQueryHandle>) {
        *self.remote_query.write().unwrap_or_else(|e| e.into_inner()) = query;
    }

    /// 当前的跨机查询接缝（克隆一次 `Arc`：调用方可能跨 await 持有）。
    pub fn remote_query(&self) -> Option<remote::RemoteQueryHandle> {
        self.remote_query
            .read()
            .ok()
            .and_then(|slot| slot.clone())
    }

    /// 发一条模块事件（无出口时静默丢弃——单测/裸装配场景）。
    pub fn emit_event(&self, name: &str, payload: Value) {
        let sink = self
            .emit
            .read()
            .ok()
            .and_then(|slot| slot.as_ref().cloned());
        if let Some(sink) = sink {
            sink(echo_module::ModuleEvent::new(MODULE_ID, name, payload));
        }
    }

    /// 发一条「要送到前端的后端事件」（载荷是 `BackendEvent` 的 JSON 形状）。
    pub fn emit_backend(&self, event: Value) {
        self.emit_event(events::BACKEND_EVENT, event);
    }

    /// 发一条错误事件（`BackendEvent::Error` 的线形状）。
    pub fn emit_error(&self, session_id: Option<&str>, message: impl Into<String>) {
        self.emit_backend(json!({
            "Error": {
                "session_id": session_id,
                "message": message.into(),
            }
        }));
    }

    /// 某个 persona 的 store（惰性创建：首次访问时读盘 + 接变更钩子）。
    ///
    /// **进程级共享**（2026-11）：同一份 workspace 文档在进程内只对应一个
    /// `Arc<WorkspaceStore>`，无论它被哪个 persona 的模块实例、经由哪个
    /// `team_id` 访问到。
    ///
    /// 为什么必须共享：每个 persona 有自己的模块实例（`PersonaScope` 用目录
    /// 工厂重建一批），而 `store(team_id)` 的参数来自命令载荷、对任意 team 都
    /// 合法（跨人格目录选择器 / `all_stores` 就是这么用的）。若缓存按实例分，
    /// 同一文件会同时存在于多份内存副本里：
    /// - 写命令（`SetSessionApi` → `WorkspaceSetConversationApiProfile`）命中
    ///   一份，改内存 + 落盘；
    /// - 读命令（`RequestWorkspaceSessions`）命中另一份，返回**旧值**。
    ///
    /// 表现就是"设置生效了、落盘也写了，但界面刷新后回到旧值"（2026-11
    /// 用户报障的确切现场：磁盘 `api_profile=deepseek`，广播里是 `kimi`）。
    pub fn store(&self, team_id: &str) -> Arc<store::WorkspaceStore> {
        if let Some(existing) = self
            .stores
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(team_id)
        {
            return existing.clone();
        }
        let config = self.config();
        let store = store::shared(config.document_path(team_id));
        // 「store 变更 → 广播」的唯一入口（面板命令与模型 `use` 工具共用）。
        // 钩子持 `Weak`：见 [`ModuleState::attach_self`] 的说明。
        {
            let weak = self
                .self_ref
                .read()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            let team_id = team_id.to_string();
            store.upsert_on_change(
                self.hook_id,
                Arc::new(move || {
                    if let Some(state) = weak.upgrade() {
                        state.on_store_changed(&team_id);
                    }
                }),
            );
        }
        {
            let weak = self
                .self_ref
                .read()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            let team_id = team_id.to_string();
            store.upsert_on_conversation_deleted(self.hook_id, Arc::new(move |workspace_id, conversation| {
                if let Some(state) = weak.upgrade() {
                    state.emit_event(
                        events::CONVERSATION_DELETED,
                        json!({
                            "team_id": team_id,
                            "workspace_id": workspace_id,
                            "conversation": conversation,
                        }),
                    );
                }
            }));
        }
        self.stores
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .insert(team_id.to_string(), store.clone());
        store
    }

    /// store 变更 → 报告宿主（由宿主完成通道注册与列表广播）。
    ///
    /// 钩子在 store 的写锁**之外**触发，所以这里可以安全地回读同一份 store。
    fn on_store_changed(&self, team_id: &str) {
        let store = self.store(team_id);
        let (sessions, active) = store.snapshot();
        let active_conversation = store.active_pair().map(|(_, conv)| conv.id);
        self.emit_event(
            events::CHANGED,
            json!({
                "team_id": team_id,
                "active": active,
                "active_conversation": active_conversation,
                "sessions": sessions,
            }),
        );
    }

    /// 全部 persona 的 store 快照（目录选择器要跨 persona 取目录并集）。
    pub fn all_stores(&self) -> Vec<Arc<store::WorkspaceStore>> {
        self.stores
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect()
    }

    /// 已加载过的 team id（诊断/测试用）。
    pub fn loaded_teams(&self) -> Vec<String> {
        self.stores
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .cloned()
            .collect()
    }

    /// 提示词块内容（`context` 带 `team_id` / `session_id`，由宿主注入）。
    pub fn prompt_text(&self, context: &Value) -> Option<String> {
        let team_id = context
            .get("team_id")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        if team_id.is_empty() {
            return None;
        }
        let store = self.store(team_id);
        // 按**本次 turn 的会话**解析，回退全局 active——否则 A 窗口激活工作区
        // 后，B 窗口在自己通道里发消息会被注入 A 的工作区上下文（多窗口串台）。
        match context.get("session_id").and_then(|v| v.as_str()) {
            Some(session_id) if !session_id.is_empty() => store
                .prompt_text_for(session_id)
                .or_else(|| store.prompt_text()),
            _ => store.prompt_text(),
        }
    }
}

/// 模块声明文件——身份写在 TOML 里（单一真值）。
///
/// `include_str!` 而不是运行期读盘：清单是编译期常量，散在部署目录里会让
/// "同一个二进制在不同机器上表现不同"。
pub const MANIFEST_TOML: &str = include_str!("../module.toml");

/// 模块 manifest：从 [`MANIFEST_TOML`] 解析，只把版本号留给宿主注入。
pub fn manifest(version: &str) -> ModuleManifest {
    ModuleManifest::from_toml(MANIFEST_TOML, version)
        .expect("agent-module-workspace 的 module.toml 解析失败")
}

/// 构造模块（宿主装配期调用一次；模块被禁用/未挂载时不监听、不落盘）。
pub fn module(version: &str) -> Arc<dyn Module> {
    module_with_state(version).0
}

/// 构造模块并交出内部状态句柄。
///
/// 两个用途：
/// 1. **宿主测试**：需要直接观察/注入 store（如"预置一个激活工作区，再验证
///    提示词块内容"）时，拿 `Arc<ModuleState>` 比走一遍命令快得多；
/// 2. **嵌入式集成**（可选）：宿主想把模块事件桥与自己的事件循环对齐。
///
/// 生产装配用 [`module`] 即可——状态是模块自己的事，宿主不该依赖它。
pub fn module_with_state(version: &str) -> (Arc<dyn Module>, Arc<ModuleState>) {
    let state = Arc::new(ModuleState::default());
    // 变更钩子要靠自引用回调本状态（见 `attach_self`）。
    state.attach_self();
    let mount_state = state.clone();
    let command_state = state.clone();
    let text_state = state.clone();

    let built = Arc::new(
        BuiltinModule::new(manifest(version), move |ctx| {
            // 配置解析失败不该挡住启动：按缺省目录继续（与宿主的"配置缺失
            // 不阻断启动"同款取舍），但把可读错误留在日志里。
            let config: Config = if ctx.config().is_null() {
                Config::default()
            } else {
                match serde_json::from_value(ctx.config().clone()) {
                    Ok(config) => config,
                    Err(error) => {
                        tracing::warn!(
                            module = MODULE_ID,
                            %error,
                            "workspace 模块配置解析失败，按缺省目录继续"
                        );
                        Config::default()
                    }
                }
            };
            tracing::info!(
                module = MODULE_ID,
                state_dir = %config.effective_state_dir().display(),
                "workspace 模块已挂载"
            );
            mount_state.set_config(config);
            if let Some(sink) = &ctx.events {
                mount_state.set_event_sink(sink.clone());
            }
            // 跨机查询接缝（组合根装配期注册）：`None` = 宿主没提供
            // （单机部署 / 联邦关闭），远程目录按「不可采集」降级。
            let remote_query = ctx.service(&remote::REMOTE_QUERY);
            if remote_query.is_some() {
                tracing::debug!(
                    module = MODULE_ID,
                    "workspace 模块已接入跨机查询（node:// 目录可采集）"
                );
            }
            mount_state.set_remote_query(remote_query);
            Ok(Vec::new())
        })
        // 命令域：面板 7 条 + 宿主内部 2 条 + 工具入口 1 条。
        //
        // 工具入口必须一起声明：宿主的命令分发**只问声明过的名字**
        // （`handled_commands`），漏了它 `WorkspaceToolCall` 永远到不了这里，
        // 表现为"工具存在但每次都说模块未启用"。
        .with_commands(
            commands::COMMANDS
                .iter()
                .copied()
                .chain(std::iter::once(commands::TOOL_CALL)),
        )
        .with_command_handler_async(move |name, payload| {
            let state = command_state.clone();
            Box::pin(async move {
                // `with_commands` 声明过的名字宿主管道才会调过来；`handle`
                // 仍按"认领语义"返回 `Option`（工具调用与未来扩展共用同一入口），
                // 这里把 `None` 兜成明确错误，避免面板转圈。
                match commands::handle(&state, &name, payload).await {
                    Some(outcome) => outcome,
                    None => Err(format!("命令 {name} 未被 workspace 模块认领")),
                }
            })
        })
        // 提示词块：键 / 标题 / 顺序与迁移前一致（order = 50）。
        .with_text_blocks([ModuleTextBlock::new(TEXT_BLOCK_KEY, "工作区会话", 50)])
        .with_text_block_content(move |key, context| {
            if key != TEXT_BLOCK_KEY {
                return None;
            }
            text_state.prompt_text(context)
        }),
    );
    (built, state)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 配置缺省：落到 `$XDG_CONFIG_HOME/echo-agent-core`，文档名与迁移前一致
    /// （旧数据可直接读）。
    #[test]
    fn default_state_dir_matches_core_layout() {
        let config = Config::default();
        let dir = config.effective_state_dir();
        assert!(dir.ends_with("echo-agent-core"), "{dir:?}");
        assert_eq!(
            config.document_path("assistant").file_name().unwrap(),
            "echo-workspaces-assistant.json"
        );
    }

    #[test]
    fn explicit_state_dir_wins() {
        let config = Config {
            state_dir: "/tmp/echo-ws-state".into(),
        };
        assert_eq!(
            config.document_path("t"),
            PathBuf::from("/tmp/echo-ws-state/echo-workspaces-t.json")
        );
    }

    /// 提示词块：没有 team_id 不贡献内容（进程级模块服务多个人格，
    /// 缺人格就无法定位 store）。
    #[test]
    fn prompt_block_requires_team_id() {
        let state = ModuleState::default();
        assert!(state.prompt_text(&json!({})).is_none());
        assert!(state
            .prompt_text(&json!({"team_id": "", "session_id": "s"}))
            .is_none());
    }

    /// 变更钩子 → `workspace.changed` 事件（宿主据此广播列表）。
    #[test]
    fn store_change_emits_changed_event() {
        let dir = std::env::temp_dir().join(format!("echo-ws-module-hook-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let state = Arc::new(ModuleState::new(Config {
            state_dir: dir.to_string_lossy().into_owned(),
        }));
        state.attach_self();
        let seen: Arc<std::sync::Mutex<Vec<(String, Value)>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        {
            let seen = seen.clone();
            state.set_event_sink(Arc::new(move |event| {
                seen.lock().unwrap().push((event.name, event.payload));
            }));
        }
        let store = state.store("assistant");
        store
            .upsert(wire::WorkspaceSessionInfo {
                id: "proj".into(),
                name: "Proj".into(),
                directories: vec![wire::WorkspaceDirectory::local("/srv/a")],
                ..Default::default()
            })
            .unwrap();
        let recorded = seen.lock().unwrap().clone();
        let changed = recorded
            .iter()
            .find(|(name, _)| name == events::CHANGED)
            .expect("应发出 workspace.changed");
        assert_eq!(changed.1["team_id"], "assistant");
        assert_eq!(changed.1["sessions"][0]["id"], "proj");
        assert!(changed.1["active"].is_null(), "未激活");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// store 是进程级单例：同一 team 反复取到同一个实例（不会重复读盘，
    /// 也不会出现两份内存视图互相覆盖）。
    #[test]
    fn store_is_cached_per_team() {
        let dir = std::env::temp_dir().join(format!("echo-ws-module-cache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let state = ModuleState::new(Config {
            state_dir: dir.to_string_lossy().into_owned(),
        });
        let a = state.store("t1");
        let b = state.store("t1");
        assert!(Arc::ptr_eq(&a, &b));
        assert_eq!(state.loaded_teams(), vec!["t1".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
