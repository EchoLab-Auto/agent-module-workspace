//! 工作区命令域（`Contribution::Command` 实现）+ 工具调用入口。
//!
//! 这 7 条命令原本是宿主 `echo-agent` 里的 `impl Agent` 方法，后来搬进内置
//! 模块，现在搬进**独立仓库**。搬动改变了三件事，都不改变对外语义：
//!
//! 1. **载荷解析**：不再重建宿主的 `BackendCommand`（那要依赖 Core crate，
//!    形成包级循环），改成直接读 JSON 字段——字段名与线格式逐字一致。
//! 2. **store**：模块自己拥有（per-persona，落盘在 `[module.config] state_dir`）。
//! 3. **事件**：宿主侧发布（`emit`）变成模块发**模块事件**（见 `lib.rs` 的
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
use crate::ModuleState;

/// 本模块处理的命令（`Contribution::Command` 的 `name`）。
///
/// 前 7 条是**面板线协议命令**；后 2 条是**宿主内部命令**（面板不发它们）：
/// 宿主原本直接调 store 的两个动作（会话级 API 覆盖的持久化、供应商改名传播）
/// 现在跨了仓库边界，只能经命令通道回来。
pub const COMMANDS: [&str; 9] = [
    "RequestWorkspaceSessions",
    "SaveWorkspaceSession",
    "DeleteWorkspaceSession",
    "ActivateWorkspaceSession",
    "RequestWorkspaceGitStatus",
    "RequestWorkspaceFiles",
    "RequestBrowseDirectories",
    // ── 宿主内部命令（见模块文档）──
    "WorkspaceSetConversationApiProfile",
    "WorkspaceRenameApiProfile",
];

/// `workspace` 工具的调用入口名（宿主把工具调用转发到这里）。
///
/// 为什么单独一个名字：工具不是线协议命令（面板不会发它），但**调用通道**
/// 与命令域相同（`ModuleHost` 的命令分发），所以复用一个显式命名，避免与
/// 7 条真命令混淆。
pub const TOOL_CALL: &str = "WorkspaceToolCall";

/// 处理一条命令；`None` = 不归本模块管（宿主继续找别人）。
pub async fn handle(
    state: &Arc<ModuleState>,
    name: &str,
    payload: Value,
) -> Option<Result<Value, String>> {
    // 工具调用单独一路（不属于线协议命令域）。
    if name == TOOL_CALL {
        return Some(crate::tool::call(state, payload).await);
    }
    // **先认领再解析**：契约上 `None` = 不归本模块管。与本域无关的载荷畸形
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
        "WorkspaceSetConversationApiProfile" => {
            set_conversation_api_profile(state, team_id.as_deref(), &payload)
        }
        "WorkspaceRenameApiProfile" => rename_api_profile(state, team_id.as_deref(), &payload),
        other => {
            return Some(Err(format!("命令 {other} 被声明但处理器没有认领它")));
        }
    };
    Some(outcome)
}

// ── 命令实现 ─────────────────────────────────────────────────────────────

/// 读快照并广播（`RequestWorkspaceSessions`）。
fn request_sessions(state: &ModuleState, team_id: Option<&str>) -> Result<Value, String> {
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
    state: &ModuleState,
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
    state: &ModuleState,
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
    state: &ModuleState,
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
    // `workspace.changed` 事件时完成（模块不认识"会话通道"），这里只报回执。
    let message = match (&id, &conversation) {
        (Some(id), Some(conv)) => format!("已激活工作区会话：{id}（对话 {conv}）"),
        (Some(id), None) => format!("已激活工作区会话：{id}"),
        (None, _) => "已取消工作区会话激活".into(),
    };
    mutate(state, team_id, move |store| {
        store.set_active(id, conversation).map(|()| message)
    })
}

/// 宿主内部：把会话级 API 覆盖写进对应工作区对话（`profile` 空 = 清除）。
///
/// 为什么是命令而不是让宿主直接写：store 在模块里（独立仓库），宿主只读镜像，
/// 写入必须回到唯一写者。`session_id` 是**工作区通道** id
/// （`local:workspace:<ws>[/<conv>]:<user>`），解析规则同模块侧。
fn set_conversation_api_profile(
    state: &ModuleState,
    team_id: Option<&str>,
    payload: &Value,
) -> Result<Value, String> {
    let session_id = payload
        .get("session_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "WorkspaceSetConversationApiProfile 缺少 session_id".to_string())?;
    let profile = payload
        .get("profile")
        .and_then(|v| v.as_str())
        .filter(|p| !p.is_empty());
    let Some((ws_id, conv_id)) = crate::store::parse_workspace_channel(session_id) else {
        // 非工作区通道：静默成功（宿主侧也是"直接跳过"）。
        return Ok(Value::Null);
    };
    let store = store_or_err(state, team_id)?;
    match conv_id.as_deref() {
        Some(conv_id) => store.set_conversation_api_profile(&ws_id, conv_id, profile)?,
        // legacy 裸通道：按 `legacy == true` 定位（不猜 id=="main"）。
        None => store.set_legacy_conversation_api_profile(&ws_id, profile)?,
    };
    Ok(Value::Null)
}

/// 宿主内部：供应商改名后传播到全部工作区对话的 `api_profile` 引用。
fn rename_api_profile(
    state: &ModuleState,
    team_id: Option<&str>,
    payload: &Value,
) -> Result<Value, String> {
    let from = payload
        .get("from")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "WorkspaceRenameApiProfile 缺少 from".to_string())?;
    let to = payload
        .get("to")
        .and_then(|v| v.as_str())
        .filter(|t| !t.is_empty());
    let store = store_or_err(state, team_id)?;
    let changed = store.rename_api_profile(from, to)?;
    Ok(json!({ "changed": changed }))
}

/// 变更类命令的公共骨架：取 store → 执行 → 回执。
///
/// **列表/激活广播不在这里发**：store 的变更钩子会发 `workspace.changed`，
/// 宿主据此走完「确保通道会话 + 恢复会话级 API + 发 SessionUpdated /
/// WorkspaceSessions」。模块因此不需要知道宿主的会话子系统存在。
fn mutate<F>(state: &ModuleState, team_id: Option<&str>, f: F) -> Result<Value, String>
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
    state: &ModuleState,
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
/// 远程目录（`node://`）走宿主注入的 [`crate::remote::RemoteWorkspaceQuery`]
/// 接缝：git 采集必须在**对端**机器上跑，网络那一半属宿主的联邦子系统。
/// 宿主没注入（单机部署 / 联邦关闭）或查询失败时，该目录降级为占位条目，
/// 同会话的本机目录照常返回——见 [`remote_git_status`]。
async fn git_status(
    state: &ModuleState,
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
    let mut remote: Vec<(usize, String, String)> = Vec::new();
    for (index, dir) in directories.iter().enumerate() {
        match dir.node() {
            Some(peer) => remote.push((index, peer.to_string(), dir.path().to_string())),
            None => local.push((index, dir.path().to_string())),
        }
    }
    // 本机采集先发车（`spawn_blocking`：多次 git 子进程，几十毫秒到几秒），
    // 再 await 远程查询——两段并行，混合目录不必串行等待。
    let local_handle = if local.is_empty() {
        None
    } else {
        let paths: Vec<String> = local.iter().map(|(_, p)| p.clone()).collect();
        Some(tokio::task::spawn_blocking(move || {
            paths.iter().map(|p| collect_dir_git(p)).collect::<Vec<_>>()
        }))
    };
    // 远程目录逐个 await：典型场景只有 1-2 个；并发要引 `futures` 依赖，
    // 收益不抵多一个 crate。对端离线时每个最多等联邦侧超时（30s）。
    for (index, peer, path) in remote {
        results[index] = Some(remote_git_status(state, &peer, &path).await);
    }
    if let Some(handle) = local_handle {
        let collected = handle
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

/// 远程目录降级原因（宿主未注入 [`crate::remote::REMOTE_QUERY`] 时）。
const NOT_WIRED_QUERY: &str = "跨机查询未接线（宿主未注入联邦查询能力：单机部署属正常）";

/// 单个远程目录的 git 快照。
///
/// 三级降级，逐级都只影响**这一个目录**——一个有问题的对端不该让同会话的
/// 本机目录也看不到：
///
/// 1. 接缝未注入 → 占位（单机部署的常态，与改造前文案一致）；
/// 2. 查询失败（对端离线 / 未授权 / 沙箱拒绝 / 超时）→ 占位 + 对端给的原因；
/// 3. 载荷解析失败（对端版本不匹配）→ 占位 + 解析错误。
async fn remote_git_status(state: &ModuleState, peer: &str, path: &str) -> WorkspaceGitInfo {
    let qualified = crate::remote::join_node_path(peer, path);
    let Some(query) = state.remote_query() else {
        return remote_git_placeholder(&qualified, NOT_WIRED_QUERY.to_string());
    };
    match query.git_status(peer.to_string(), path.to_string()).await {
        Ok(payload) => decode_remote_git(&payload, &qualified),
        Err(message) => remote_git_placeholder(&qualified, message),
    }
}

/// 解析对端回推的 `{"git": WorkspaceGitInfo}`，并把目录名换成本机视角的
/// 规范写法。
///
/// `directory` 必须改写：对端回的是**它本机**的绝对路径（`/srv/repo`），
/// 原样透传会让面板把它当本机目录（`panel-ui/workspace.ts` 的 `directoryNode`
/// 只认 `node://` 前缀），git 卡片于是归错组。
fn decode_remote_git(payload: &Value, qualified: &str) -> WorkspaceGitInfo {
    let raw = payload.get("git").cloned().unwrap_or(Value::Null);
    match serde_json::from_value::<WorkspaceGitInfo>(raw) {
        Ok(mut info) => {
            info.directory = qualified.to_string();
            info
        }
        Err(error) => remote_git_placeholder(
            qualified,
            format!("对端返回的 git 载荷无法解析（对端版本可能较旧）: {error}"),
        ),
    }
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
    state: &ModuleState,
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
    // 跨机目录：走宿主注入的联邦查询接缝；未接线 / 失败都给明确的空结果
    // + 原因（面板显示为错误条，而不是永不返回的转圈）。
    if path.starts_with("node://") {
        let (entries, error) = match crate::remote::split_node_path(&path) {
            None => (
                Vec::new(),
                Some("远程路径格式不合法（应为 node://<节点>/<绝对路径>）".to_string()),
            ),
            Some((peer, remote_path)) => remote_files(state, &peer, &remote_path).await,
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
async fn browse(state: &ModuleState, payload: &Value) -> Result<Value, String> {
    let path = payload
        .get("path")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    // 远程路径：走联邦查询接缝；未接线 / 失败都给空结果 + 原因。
    if let Some(raw) = path.as_deref() {
        if raw.starts_with("node://") {
            let (roots, entries, error) = match crate::remote::split_node_path(raw) {
                None => (
                    Vec::new(),
                    Vec::new(),
                    Some("远程路径格式不合法（应为 node://<节点>/<绝对路径>）".to_string()),
                ),
                Some((peer, remote_path)) => remote_browse(state, &peer, &remote_path).await,
            };
            state.emit_backend(json!({
                "BrowseDirectories": {
                    "path": raw,
                    "roots": roots,
                    "entries": entries,
                    "error": error,
                }
            }));
            return Ok(Value::Null);
        }
    }
    // 浏览根 = **全部已加载 persona** 的工作区目录并集 ∪ HOME。
    // 模块自己拥有所有 store，所以这件事不再需要宿主代劳。
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

/// 远程目录的文件清单（`(entries, error)`，两者互斥地表达成功与失败）。
///
/// 错误**不外抛**：`WorkspaceFiles` 事件里的 `error` 字段是面板错误条的
/// 唯一来源，抛出去会让前端一直转圈。
async fn remote_files(
    state: &ModuleState,
    peer: &str,
    path: &str,
) -> (Vec<WorkspaceFileEntry>, Option<String>) {
    let Some(query) = state.remote_query() else {
        return (Vec::new(), Some(NOT_WIRED_QUERY.to_string()));
    };
    match query.list_files(peer.to_string(), path.to_string()).await {
        Ok(payload) => {
            let raw = payload.get("entries").cloned().unwrap_or(Value::Null);
            match serde_json::from_value::<Vec<WorkspaceFileEntry>>(raw) {
                Ok(entries) => (entries, None),
                Err(error) => (
                    Vec::new(),
                    Some(format!(
                        "对端返回的文件清单无法解析（对端版本可能较旧）: {error}"
                    )),
                ),
            }
        }
        Err(message) => (Vec::new(), Some(message)),
    }
}

/// 远程目录浏览（`(roots, entries, error)`）。
///
/// 根列表请求由模块侧先解析：`node://<peer>/` 剥完前缀是 `"/"`，对端把
/// `"/"` 与空串都当"列根"，所以这里不做额外归一化——两端口径一致，
/// 多一层本地特判只会在对端换实现时对不上。
async fn remote_browse(
    state: &ModuleState,
    peer: &str,
    path: &str,
) -> (
    Vec<BrowseRoot>,
    Vec<WorkspaceFileEntry>,
    Option<String>,
) {
    let Some(query) = state.remote_query() else {
        return (Vec::new(), Vec::new(), Some(NOT_WIRED_QUERY.to_string()));
    };
    match query.browse(peer.to_string(), path.to_string()).await {
        Ok(payload) => {
            let roots = payload
                .get("roots")
                .cloned()
                .map(serde_json::from_value::<Vec<BrowseRoot>>)
                .transpose();
            let entries = payload
                .get("entries")
                .cloned()
                .map(serde_json::from_value::<Vec<WorkspaceFileEntry>>)
                .transpose();
            match (roots, entries) {
                (Ok(roots), Ok(entries)) => (
                    roots.unwrap_or_default(),
                    entries.unwrap_or_default(),
                    None,
                ),
                (Err(error), _) | (_, Err(error)) => (
                    Vec::new(),
                    Vec::new(),
                    Some(format!(
                        "对端返回的目录浏览结果无法解析（对端版本可能较旧）: {error}"
                    )),
                ),
            }
        }
        Err(message) => (Vec::new(), Vec::new(), Some(message)),
    }
}

/// 目录选择器的浏览根：HOME + 全部已加载 persona 的工作区目录（去重）。
fn browse_roots(state: &ModuleState) -> Vec<BrowseRoot> {
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

    fn state_with(dir: &std::path::Path) -> Arc<ModuleState> {
        let state = Arc::new(ModuleState::new(Config {
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
        assert!(handle(&state, "SendMessage", json!({"team_id": "t"}))
            .await
            .is_none());
        assert!(
            handle(&state, "RequestWorkspaceSessions", json!({"team_id": "t"}))
                .await
                .is_some()
        );
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

    // ── 跨机查询接缝（`node://` 目录）──────────────────────────────────

    /// 假的跨机查询：记录收到的 `(peer, path)`，按预设回包或报错。
    ///
    /// 用真的 trait 而不是桩函数：这样"模块确实按服务键取到了句柄、并按
    /// 语义方法调用"这件事被端到端覆盖，而不只是测到我们自己的分支。
    struct FakeQuery {
        git: Result<Value, String>,
        files: Result<Value, String>,
        browse: Result<Value, String>,
        calls: Arc<std::sync::Mutex<Vec<(String, String, String)>>>,
    }

    impl FakeQuery {
        fn new(git: Result<Value, String>) -> Self {
            Self {
                git,
                files: Ok(json!({"entries": []})),
                browse: Ok(json!({"roots": [], "entries": []})),
                calls: Arc::new(std::sync::Mutex::new(Vec::new())),
            }
        }

        fn record(&self, kind: &str, peer: &str, path: &str) {
            self.calls
                .lock()
                .unwrap()
                .push((kind.to_string(), peer.to_string(), path.to_string()));
        }
    }

    impl crate::remote::RemoteWorkspaceQuery for FakeQuery {
        fn git_status(&self, peer: String, path: String) -> crate::remote::QueryFuture {
            self.record("git", &peer, &path);
            let result = self.git.clone();
            Box::pin(async move { result })
        }

        fn list_files(&self, peer: String, path: String) -> crate::remote::QueryFuture {
            self.record("files", &peer, &path);
            let result = self.files.clone();
            Box::pin(async move { result })
        }

        fn browse(&self, peer: String, path: String) -> crate::remote::QueryFuture {
            self.record("browse", &peer, &path);
            let result = self.browse.clone();
            Box::pin(async move { result })
        }
    }

    /// 建一个含远程目录的会话，并把事件出口接上。
    async fn state_with_remote_dir(
        dir: &std::path::Path,
        directories: Value,
    ) -> (Arc<ModuleState>, Arc<std::sync::Mutex<Vec<Value>>>) {
        let _ = std::fs::remove_dir_all(dir);
        let state = state_with(dir);
        let seen: Arc<std::sync::Mutex<Vec<Value>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
        {
            let seen = seen.clone();
            state.set_event_sink(Arc::new(move |event| {
                if event.name == crate::events::BACKEND_EVENT {
                    seen.lock().unwrap().push(event.payload);
                }
            }));
        }
        handle(
            &state,
            "SaveWorkspaceSession",
            json!({
                "team_id": "t",
                "session": {"id": "s", "name": "s", "directories": directories},
            }),
        )
        .await
        .expect("claimed")
        .expect("saved");
        (state, seen)
    }

    /// 注入接缝后，远程目录真的去问了宿主，且 `directory` 被换回
    /// `node://` 规范形状（否则面板按本机目录归组）。
    #[tokio::test]
    async fn remote_git_status_uses_injected_query() {
        let dir = std::env::temp_dir().join(format!("echo-ws-cmd-rgit-{}", std::process::id()));
        let fake = Arc::new(FakeQuery::new(Ok(json!({
            "git": {
                "directory": "/srv/repo",
                "is_repo": true,
                "branch": "main",
                "modified": 3,
            }
        }))));
        let (state, seen) =
            state_with_remote_dir(&dir, json!(["node://gpu-box/srv/repo"])).await;
        state.set_remote_query(Some(fake.clone()));

        handle(
            &state,
            "RequestWorkspaceGitStatus",
            json!({"team_id": "t", "session_id": "s"}),
        )
        .await
        .expect("claimed")
        .expect("ok");

        let calls = fake.calls.lock().unwrap().clone();
        assert_eq!(
            calls,
            vec![("git".into(), "gpu-box".into(), "/srv/repo".into())],
            "应按语义方法问到对端绝对路径"
        );
        let status = seen
            .lock()
            .unwrap()
            .iter()
            .find_map(|value| value.get("WorkspaceGitStatus").cloned())
            .expect("应有 WorkspaceGitStatus 事件");
        let git = &status["directories"][0];
        assert_eq!(git["directory"], "node://gpu-box/srv/repo");
        assert_eq!(git["is_repo"], true);
        assert_eq!(git["branch"], "main");
        assert!(git["error"].is_null());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 对端报错 → 只该目录降级成占位（带对端原因），不抛错、不拖累别的目录。
    #[tokio::test]
    async fn remote_git_status_failure_degrades_to_placeholder() {
        let dir = std::env::temp_dir().join(format!("echo-ws-cmd-rgitf-{}", std::process::id()));
        let fake = Arc::new(FakeQuery::new(Err(
            "远程节点「gpu-box」不在线或不存在（跨机工作区查询）".to_string(),
        )));
        let (state, seen) =
            state_with_remote_dir(&dir, json!(["node://gpu-box/srv/repo"])).await;
        state.set_remote_query(Some(fake));

        handle(
            &state,
            "RequestWorkspaceGitStatus",
            json!({"team_id": "t", "session_id": "s"}),
        )
        .await
        .expect("claimed")
        .expect("远程失败不该让整条命令失败");

        let status = seen
            .lock()
            .unwrap()
            .iter()
            .find_map(|value| value.get("WorkspaceGitStatus").cloned())
            .expect("应有 WorkspaceGitStatus 事件");
        let git = &status["directories"][0];
        assert_eq!(git["directory"], "node://gpu-box/srv/repo");
        assert_eq!(git["is_repo"], false);
        assert!(
            git["error"].as_str().unwrap_or_default().contains("不在线"),
            "错误文案应透传对端原因: {git:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 未注入接缝（单机部署）→ 占位，文案说明是"未接线"。
    #[tokio::test]
    async fn remote_git_status_without_seam_is_placeholder() {
        let dir = std::env::temp_dir().join(format!("echo-ws-cmd-rgitn-{}", std::process::id()));
        let (state, seen) =
            state_with_remote_dir(&dir, json!(["node://gpu-box/srv/repo"])).await;
        handle(
            &state,
            "RequestWorkspaceGitStatus",
            json!({"team_id": "t", "session_id": "s"}),
        )
        .await
        .expect("claimed")
        .expect("ok");
        let status = seen
            .lock()
            .unwrap()
            .iter()
            .find_map(|value| value.get("WorkspaceGitStatus").cloned())
            .expect("应有 WorkspaceGitStatus 事件");
        let git = &status["directories"][0];
        assert_eq!(git["is_repo"], false);
        assert!(git["error"]
            .as_str()
            .unwrap_or_default()
            .contains("未接线"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 文件浏览：远程路径走接缝（面板要的是空结果 + error，不是抛错）。
    #[tokio::test]
    async fn remote_files_use_injected_query() {
        let dir = std::env::temp_dir().join(format!("echo-ws-cmd-rfiles-{}", std::process::id()));
        let fake = Arc::new(FakeQuery {
            git: Ok(json!({})),
            files: Ok(json!({"entries": [
                {"name": "Cargo.toml", "path": "/srv/repo/Cargo.toml", "is_dir": false, "size": 42}
            ]})),
            browse: Ok(json!({"roots": [], "entries": []})),
            calls: Arc::new(std::sync::Mutex::new(Vec::new())),
        });
        let (state, seen) =
            state_with_remote_dir(&dir, json!(["node://gpu-box/srv/repo"])).await;
        state.set_remote_query(Some(fake.clone()));

        handle(
            &state,
            "RequestWorkspaceFiles",
            json!({"team_id": "t", "session_id": "s", "path": "node://gpu-box/srv/repo"}),
        )
        .await
        .expect("claimed")
        .expect("ok");

        assert_eq!(
            fake.calls.lock().unwrap().clone(),
            vec![("files".into(), "gpu-box".into(), "/srv/repo".into())]
        );
        let event = seen
            .lock()
            .unwrap()
            .iter()
            .find_map(|value| value.get("WorkspaceFiles").cloned())
            .expect("应有 WorkspaceFiles 事件");
        assert_eq!(event["entries"][0]["name"], "Cargo.toml");
        assert!(event["error"].is_null());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 目录浏览：根列表请求（`node://peer/`）剥成对端 `"/"`。
    #[tokio::test]
    async fn remote_browse_uses_injected_query() {
        let dir = std::env::temp_dir().join(format!("echo-ws-cmd-rbrowse-{}", std::process::id()));
        let fake = Arc::new(FakeQuery {
            git: Ok(json!({})),
            files: Ok(json!({"entries": []})),
            browse: Ok(json!({
                "roots": [{"label": "gpu-box", "path": "/srv"}],
                "entries": [],
            })),
            calls: Arc::new(std::sync::Mutex::new(Vec::new())),
        });
        let (state, seen) =
            state_with_remote_dir(&dir, json!(["node://gpu-box/srv/repo"])).await;
        state.set_remote_query(Some(fake.clone()));

        handle(
            &state,
            "RequestBrowseDirectories",
            json!({"team_id": "t", "path": "node://gpu-box/"}),
        )
        .await
        .expect("claimed")
        .expect("ok");

        assert_eq!(
            fake.calls.lock().unwrap().clone(),
            vec![("browse".into(), "gpu-box".into(), "/".into())],
            "`node://peer/` 应剥成对端根目录"
        );
        let event = seen
            .lock()
            .unwrap()
            .iter()
            .find_map(|value| value.get("BrowseDirectories").cloned())
            .expect("应有 BrowseDirectories 事件");
        assert_eq!(event["roots"][0]["path"], "/srv");
        assert!(event["error"].is_null());
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
