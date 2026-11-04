//! 工作区命令域（`Contribution::Command` 实现）+ 工具调用入口。
//!
//! 这 7 条命令原本是宿主 `echo-agent` 里的 `impl Agent` 方法，后来搬进内置
//! 插件，现在搬进**独立仓库**。搬动改变了三件事，都不改变对外语义：
//!
//! 1. **载荷解析**：不再重建宿主的 `BackendCommand`（那要依赖 Core crate，
//!    形成包级循环），改成直接读 JSON 字段——字段名与线格式逐字一致。
//! 2. **store**：插件自己拥有（per-persona，落盘在 `[plugin.config] state_dir`）。
//! 3. **事件**：宿主侧发布（`emit`）变成插件发**插件事件**（见 `lib.rs` 的
//!    协议说明），由宿主翻译成 `BackendEvent` 与会话子系统动作。
//!
//! `team_id` 语义仍是**必填**（去主智能体后没有默认人格），缺失即报错。

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{json, Value};

use crate::files;
use crate::git::collect_dir_git;
use crate::wire::{
    BrowseRoot, WorkspaceDirectory, WorkspaceFileEntry, WorkspaceGitInfo, WorkspaceSessionInfo,
};
use crate::PluginState;

/// 本插件处理的 7 条命令（`Contribution::Command` 的 `name`）。
pub const COMMANDS: [&str; 7] = [
    "RequestWorkspaceSessions",
    "SaveWorkspaceSession",
    "DeleteWorkspaceSession",
    "ActivateWorkspaceSession",
    "RequestWorkspaceGitStatus",
    "RequestWorkspaceFiles",
    "RequestBrowseDirectories",
];

/// `workspace` 工具的调用入口名（宿主把工具调用转发到这里）。
///
/// 为什么单独一个名字：工具不是线协议命令（面板不会发它），但**调用通道**
/// 与命令域相同（`PluginHost` 的命令分发），所以复用一个显式命名，避免与
/// 7 条真命令混淆。
pub const TOOL_CALL: &str = "WorkspaceToolCall";

/// 处理一条命令；`None` = 不归本插件管（宿主继续找别人）。
pub async fn handle(
    state: &Arc<PluginState>,
    name: &str,
    payload: Value,
) -> Option<Result<Value, String>> {
    // 工具调用单独一路（不属于线协议命令域）。
    if name == TOOL_CALL {
        return Some(crate::tool::call(state, payload).await);
    }
    // **先认领再解析**：契约上 `None` = 不归本插件管。与本域无关的载荷畸形
    // 本应"不是我的事"，不能被认领成一个错误。
    if !COMMANDS.contains(&name) {
        return None;
    }
    let team_id = payload
        .get("team_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let outcome = match name {
        "RequestWorkspaceSessions" => request_sessions(state, team_id.as_deref()),
        "SaveWorkspaceSession" => save_session(state, team_id.as_deref(), &payload),
        "DeleteWorkspaceSession" => delete_session(state, team_id.as_deref(), &payload),
        "ActivateWorkspaceSession" => activate_session(state, team_id.as_deref(), &payload),
        "RequestWorkspaceGitStatus" => git_status(state, team_id.as_deref(), &payload).await,
        "RequestWorkspaceFiles" => files_list(state, team_id.as_deref(), &payload).await,
        "RequestBrowseDirectories" => browse(state, &payload).await,
        other => {
            return Some(Err(format!("命令 {other} 被声明但处理器没有认领它")));
        }
    };
    Some(outcome)
}

// ── 命令实现 ─────────────────────────────────────────────────────────────

/// 读快照并广播（`RequestWorkspaceSessions`）。
fn request_sessions(state: &PluginState, team_id: Option<&str>) -> Result<Value, String> {
    let store = store_or_err(state, team_id)?;
    let (sessions, active) = store.snapshot();
    let active_conversation = store.active_pair().map(|(_, conv)| conv.id);
    state.emit_backend(json!({
        "WorkspaceSessions": {
            "team_id": team_id,
            "sessions": sessions,
            "active": active,
            "active_conversation": active_conversation,
        }
    }));
    Ok(Value::Null)
}

/// 新建/更新会话（`SaveWorkspaceSession`）。
fn save_session(
    state: &PluginState,
    team_id: Option<&str>,
    payload: &Value,
) -> Result<Value, String> {
    let session: WorkspaceSessionInfo = match payload.get("session") {
        Some(value) => serde_json::from_value(value.clone())
            .map_err(|e| format!("SaveWorkspaceSession 的 session 解析失败: {e}"))?,
        None => return Err("SaveWorkspaceSession 缺少 session".into()),
    };
    mutate(state, team_id, |store| {
        store
            .upsert(session)
            .map(|saved| format!("工作区会话已保存：{}（{}）", saved.name, saved.id))
    })
}

/// 删除会话（`DeleteWorkspaceSession`）。
fn delete_session(
    state: &PluginState,
    team_id: Option<&str>,
    payload: &Value,
) -> Result<Value, String> {
    let id = payload
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "DeleteWorkspaceSession 缺少 id".to_string())?
        .to_string();
    mutate(state, team_id, move |store| match store.delete(&id) {
        Ok(true) => Ok(format!("工作区会话已删除：{id}")),
        Ok(false) => Err(format!("工作区会话 {id} 不存在")),
        Err(message) => Err(message),
    })
}

/// 激活/取消激活（`ActivateWorkspaceSession`）。
fn activate_session(
    state: &PluginState,
    team_id: Option<&str>,
    payload: &Value,
) -> Result<Value, String> {
    let id = payload
        .get("id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let conversation = payload
        .get("conversation")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    // 激活 = 进入项目对话：通道会话注册 + 列表广播由**宿主**在收到
    // `workspace.changed` 事件时完成（插件不认识"会话通道"），这里只报回执。
    let message = match (&id, &conversation) {
        (Some(id), Some(conv)) => format!("已激活工作区会话：{id}（对话 {conv}）"),
        (Some(id), None) => format!("已激活工作区会话：{id}"),
        (None, _) => "已取消工作区会话激活".into(),
    };
    mutate(state, team_id, move |store| {
        store.set_active(id, conversation).map(|()| message)
    })
}

/// 变更类命令的公共骨架：取 store → 执行 → 回执。
///
/// **列表/激活广播不在这里发**：store 的变更钩子会发 `workspace.changed`，
/// 宿主据此走完「确保通道会话 + 恢复会话级 API + 发 SessionUpdated /
/// WorkspaceSessions」。插件因此不需要知道宿主的会话子系统存在。
fn mutate<F>(state: &PluginState, team_id: Option<&str>, f: F) -> Result<Value, String>
where
    F: FnOnce(&crate::store::WorkspaceStore) -> Result<String, String>,
{
    let store = store_or_err(state, team_id)?;
    match f(&store) {
        Ok(message) => {
            state.emit_backend(json!({
                "Error": { "session_id": null, "message": message }
            }));
            Ok(Value::Null)
        }
        Err(message) => {
            state.emit_error(team_id, message.clone());
            Err(message)
        }
    }
}

fn store_or_err(
    state: &PluginState,
    team_id: Option<&str>,
) -> Result<Arc<crate::store::WorkspaceStore>, String> {
    let Some(team_id) = team_id else {
        let message = "该命令必须指定 team_id（没有默认智能体）".to_string();
        state.emit_error(None, message.clone());
        return Err(message);
    };
    Ok(state.store(team_id))
}

// ── git 状态 ─────────────────────────────────────────────────────────────

/// 某会话各目录的 git 快照（`RequestWorkspaceGitStatus`）。
///
/// 远程目录（`node://`）在本仓**降级为占位条目**：Git 采集要在对端机器上跑，
/// 而跨机查询是宿主的联邦能力（插件仓不依赖联邦实现）。降级是刻意的——
/// 单机部署根本不走这条路，多机部署的远程 git 由宿主另行补齐（见 README
/// 的「能力边界」）。
async fn git_status(
    state: &PluginState,
    team_id: Option<&str>,
    payload: &Value,
) -> Result<Value, String> {
    let store = store_or_err(state, team_id)?;
    // 历史命名：这里的 session_id 实际是**工作区 id**（`WorkspaceStore` 的键），
    // 不是对话会话 id。改名会破坏线协议，故只注记。
    let workspace_id = payload
        .get("session_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "RequestWorkspaceGitStatus 缺少 session_id".to_string())?
        .to_string();
    let Some(session) = store.get(&workspace_id) else {
        let message = format!("工作区会话 {workspace_id} 不存在");
        state.emit_error(team_id, message.clone());
        return Err(message);
    };
    let directories = session.directories.clone();
    let mut results: Vec<Option<WorkspaceGitInfo>> = vec![None; directories.len()];
    let mut local: Vec<(usize, String)> = Vec::new();
    for (index, dir) in directories.iter().enumerate() {
        match dir.node() {
            Some(node) => {
                let qualified = format!("node://{node}/{}", dir.path().trim_start_matches('/'));
                results[index] = Some(remote_git_placeholder(
                    &qualified,
                    "跨机 git 状态需宿主联邦能力（本插件未接线：降级为不可采集）".into(),
                ));
            }
            None => local.push((index, dir.path().to_string())),
        }
    }
    if !local.is_empty() {
        let paths: Vec<String> = local.iter().map(|(_, p)| p.clone()).collect();
        let collected = tokio::task::spawn_blocking(move || {
            paths.iter().map(|p| collect_dir_git(p)).collect::<Vec<_>>()
        })
        .await
        .map_err(|e| format!("git 采集失败: {e}"))?;
        for ((index, _), info) in local.into_iter().zip(collected) {
            results[index] = Some(info);
        }
    }
    let directories: Vec<WorkspaceGitInfo> = results.into_iter().flatten().collect();
    state.emit_backend(json!({
        "WorkspaceGitStatus": {
            "team_id": team_id,
            "session_id": workspace_id,
            "directories": directories,
        }
    }));
    Ok(Value::Null)
}

/// 远程 git 状态占位（对端不可采集）：保留 `node://` 标注与原因。
fn remote_git_placeholder(qualified_directory: &str, message: String) -> WorkspaceGitInfo {
    WorkspaceGitInfo {
        directory: qualified_directory.to_string(),
        is_repo: false,
        error: Some(message),
        ..Default::default()
    }
}

// ── 文件浏览 ─────────────────────────────────────────────────────────────

/// 列某工作区目录下的文件（`RequestWorkspaceFiles`）。
async fn files_list(
    state: &PluginState,
    team_id: Option<&str>,
    payload: &Value,
) -> Result<Value, String> {
    let store = store_or_err(state, team_id)?;
    let workspace_id = payload
        .get("session_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "RequestWorkspaceFiles 缺少 session_id".to_string())?
        .to_string();
    let path = payload
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "RequestWorkspaceFiles 缺少 path".to_string())?
        .to_string();
    let Some(session) = store.get(&workspace_id) else {
        let message = format!("工作区会话 {workspace_id} 不存在");
        state.emit_error(team_id, message.clone());
        return Err(message);
    };
    // 跨机目录：本仓不接联邦 → 明确的空结果 + 原因（面板显示为错误条，
    // 而不是永不返回的转圈）。
    if path.starts_with("node://") {
        state.emit_backend(json!({
            "WorkspaceFiles": {
                "team_id": team_id,
                "session_id": workspace_id,
                "path": path,
                "entries": Vec::<WorkspaceFileEntry>::new(),
                "error": "跨机文件浏览需宿主联邦能力（本插件未接线）",
            }
        }));
        return Ok(Value::Null);
    }
    let directories = session.directories.clone();
    let requested = path.clone();
    let collected = tokio::task::spawn_blocking(move || {
        let resolved = files::resolve_within_directories(&directories, &requested)?;
        files::collect_dir_files(&resolved)
    })
    .await;
    let (entries, error) = match collected {
        Ok(Ok(entries)) => (entries, None),
        Ok(Err(message)) => (Vec::new(), Some(message)),
        Err(error) => (Vec::new(), Some(format!("目录读取失败: {error}"))),
    };
    state.emit_backend(json!({
        "WorkspaceFiles": {
            "team_id": team_id,
            "session_id": workspace_id,
            "path": path,
            "entries": entries,
            "error": error,
        }
    }));
    Ok(Value::Null)
}

/// 目录选择器浏览（`RequestBrowseDirectories`）。
async fn browse(state: &PluginState, payload: &Value) -> Result<Value, String> {
    let path = payload
        .get("path")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    // 远程路径：本仓不接联邦 → 空根 + 原因。
    if let Some(raw) = path.as_deref() {
        if raw.starts_with("node://") {
            state.emit_backend(json!({
                "BrowseDirectories": {
                    "path": raw,
                    "roots": Vec::<BrowseRoot>::new(),
                    "entries": Vec::<WorkspaceFileEntry>::new(),
                    "error": "跨机目录浏览需宿主联邦能力（本插件未接线）",
                }
            }));
            return Ok(Value::Null);
        }
    }
    // 浏览根 = **全部已加载 persona** 的工作区目录并集 ∪ HOME。
    // 插件自己拥有所有 store，所以这件事不再需要宿主代劳。
    let roots = browse_roots(state);
    match path {
        None => {
            state.emit_backend(json!({
                "BrowseDirectories": {
                    "path": null,
                    "roots": roots,
                    "entries": Vec::<WorkspaceFileEntry>::new(),
                    "error": null,
                }
            }));
        }
        Some(requested) => {
            let wanted = requested.clone();
            let roots_for_task = roots.clone();
            let collected = tokio::task::spawn_blocking(move || {
                let resolved = files::resolve_within_browse_roots(&roots_for_task, &wanted)?;
                files::collect_child_dirs(&resolved)
            })
            .await;
            let (entries, error) = match collected {
                Ok(Ok(entries)) => (entries, None),
                Ok(Err(message)) => (Vec::new(), Some(message)),
                Err(error) => (Vec::new(), Some(format!("目录浏览失败: {error}"))),
            };
            state.emit_backend(json!({
                "BrowseDirectories": {
                    "path": requested,
                    "roots": Vec::<BrowseRoot>::new(),
                    "entries": entries,
                    "error": error,
                }
            }));
        }
    }
    Ok(Value::Null)
}

/// 目录选择器的浏览根：HOME + 全部已加载 persona 的工作区目录（去重）。
fn browse_roots(state: &PluginState) -> Vec<BrowseRoot> {
    let mut directories: Vec<WorkspaceDirectory> = Vec::new();
    let mut labels: HashMap<String, String> = HashMap::new();
    for store in state.all_stores() {
        let (sessions, _) = store.snapshot();
        for session in sessions {
            for dir in session.directories {
                if !labels.contains_key(dir.path()) {
                    labels.insert(dir.path().to_string(), session.name.clone());
                }
                directories.push(dir);
            }
        }
    }
    files::browse_roots(&directories, &labels)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Config;

    fn state_with(dir: &std::path::Path) -> Arc<PluginState> {
        let state = Arc::new(PluginState::new(Config {
            state_dir: dir.to_string_lossy().into_owned(),
        }));
        state.attach_self();
        state
    }

    /// 认领语义：无关命令返回 `None`（不抢别人的命令域）。
    #[tokio::test]
    async fn unknown_command_is_not_claimed() {
        let dir = std::env::temp_dir().join(format!("echo-ws-cmd-claim-{}", std::process::id()));
        let state = state_with(&dir);
        assert!(handle(&state, "RequestState", json!({})).await.is_none());
        assert!(handle(&state, "SendMessage", json!({"team_id": "t"})).await.is_none());
        assert!(handle(&state, "RequestWorkspaceSessions", json!({"team_id": "t"}))
            .await
            .is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 缺 team_id → 明确报错（没有默认人格兜底）。
    #[tokio::test]
    async fn missing_team_id_is_an_error() {
        let dir = std::env::temp_dir().join(format!("echo-ws-cmd-team-{}", std::process::id()));
        let state = state_with(&dir);
        let outcome = handle(&state, "RequestWorkspaceSessions", json!({}))
            .await
            .expect("claimed");
        assert!(outcome.unwrap_err().contains("team_id"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 保存 → 请求列表：事件里带 sessions 与 active。
    #[tokio::test]
    async fn save_then_list_emits_sessions_event() {
        let dir = std::env::temp_dir().join(format!("echo-ws-cmd-save-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let state = state_with(&dir);
        let seen: Arc<std::sync::Mutex<Vec<Value>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
        {
            let seen = seen.clone();
            state.set_event_sink(Arc::new(move |event| {
                if event.name == crate::events::BACKEND_EVENT {
                    seen.lock().unwrap().push(event.payload);
                }
            }));
        }
        let saved = handle(
            &state,
            "SaveWorkspaceSession",
            json!({
                "team_id": "t",
                "session": {"name": "Proj", "directories": ["/srv/a"]}
            }),
        )
        .await
        .expect("claimed");
        assert!(saved.is_ok(), "{saved:?}");
        handle(&state, "RequestWorkspaceSessions", json!({"team_id": "t"}))
            .await
            .expect("claimed")
            .expect("ok");
        let events = seen.lock().unwrap().clone();
        let sessions = events
            .iter()
            .find_map(|value| value.get("WorkspaceSessions"))
            .expect("应有 WorkspaceSessions 事件");
        assert_eq!(sessions["sessions"][0]["id"], "proj");
        assert!(sessions["active"].is_null());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// git 状态：不存在的会话 → 错误（而不是空结果）。
    #[tokio::test]
    async fn git_status_rejects_unknown_workspace() {
        let dir = std::env::temp_dir().join(format!("echo-ws-cmd-git-{}", std::process::id()));
        let state = state_with(&dir);
        let outcome = handle(
            &state,
            "RequestWorkspaceGitStatus",
            json!({"team_id": "t", "session_id": "ghost"}),
        )
        .await
        .expect("claimed");
        assert!(outcome.unwrap_err().contains("不存在"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 浏览根：没有会话时只有家目录。
    #[tokio::test]
    async fn browse_roots_without_sessions_are_home_only() {
        let dir = std::env::temp_dir().join(format!("echo-ws-cmd-roots-{}", std::process::id()));
        let state = state_with(&dir);
        let roots = browse_roots(&state);
        assert!(roots.iter().all(|root| std::env::var("HOME")
            .map(|home| root.path == home || !root.path.is_empty())
            .unwrap_or(true)));
        assert!(roots.len() <= 1, "roots: {roots:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
