//! `workspace` 工具（模型可见）。
//!
//! 内置时代的工具实现是 `echo-tool::Tool` 的一个 `impl`——依赖 Core 的
//! `echo-tool` crate。独立仓里改成**纯 JSON 入口**：
//!
//! - 工具的描述与参数 schema 是 [`description`] / [`parameters`]（宿主按这两份
//!   JSON 注册成真工具，见本仓 README 的「宿主侧接线」）；
//! - 调用走的是命令分发通道（[`crate::commands::TOOL_CALL`]），
//!   `payload` = 模型给的参数对象，返回值 = 工具输出文本（包在 `{"content":…}`）。
//!
//! 语义与内置版本逐条一致（list / status / use / create / delete /
//! conversations），含两处容易做错的地方：
//! - `status` 缺 `id` = 当前激活会话；没有激活会话时报错而不是返回空；
//! - `conversations` 的 `id` 缺省 = 当前激活工作区。

use std::sync::Arc;

use serde_json::{json, Value};

use crate::store;
use crate::wire::{WorkspaceConversationInfo, WorkspaceSessionInfo};
use crate::ModuleState;

/// 工具名（宿主据此注册）。
pub const TOOL_NAME: &str = "workspace";

/// 工具描述（宿主注册时原样使用）。
pub fn description() -> &'static str {
    "工作区会话管理。操作: list 列出全部会话与激活状态, status 查看某会话各目录的 git \
     状态(默认激活会话), use 激活会话(需要 id，可选 conversation 指定工作区内对话), \
     create 新建会话(需要 name，可选 directories), delete 删除会话(需要 id), \
     conversations 管理工作区内对话(需要 conversation_action: list/create/rename/delete；\
     id 缺省 = 激活工作区；create/rename 需要 name；rename/delete 需要 conversation_id)。\
     目录为绝对路径。"
}

/// 工具参数 JSON Schema（宿主注册时原样使用）。
pub fn parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "operation": {
                "type": "string",
                "enum": ["list", "status", "use", "create", "delete", "conversations"],
                "description": "要执行的操作"
            },
            "id": {
                "type": "string",
                "description": "会话 id（status/use/delete/conversations 使用；status/conversations 缺省 = 激活会话）"
            },
            "conversation": {
                "type": "string",
                "description": "对话 id（operation=use 时可选：激活该工作区的指定对话；缺省 = 最近使用的对话）"
            },
            "conversation_action": {
                "type": "string",
                "enum": ["list", "create", "rename", "delete"],
                "description": "对话操作（operation=conversations 时使用；缺省 = list）"
            },
            "conversation_id": {
                "type": "string",
                "description": "对话 id（conversation_action=rename/delete 时必填）"
            },
            "name": {
                "type": "string",
                "description": "会话名称（operation=create 时必填）"
            },
            "directories": {
                "type": "array",
                "items": { "type": "string" },
                "description": "工作区目录列表（operation=create 时可选）：本机绝对路径，或跨机目录 `node://<联邦peer>/<绝对路径>`"
            }
        },
        "required": ["operation"]
    })
}

/// 执行一次工具调用。
///
/// `payload` 是模型给的工具参数对象；`ctx` 里的 `team_id` 由宿主经
/// `InvokeContext`（或命令载荷）注入——见 [`crate::commands::handle`]。
pub async fn call(state: &Arc<ModuleState>, payload: Value) -> Result<Value, String> {
    let team_id = payload
        .get("team_id")
        .and_then(|v| v.as_str())
        .or_else(|| payload.get("__team_id").and_then(|v| v.as_str()))
        .map(str::to_string);
    let Some(team_id) = team_id else {
        return Err("workspace 工具需要 team_id（宿主未注入人格归属）".into());
    };
    let store = state.store(&team_id);
    let output = execute(&store, &payload)?;
    // 工具输出形状：`{"content": "..."}`（宿主取 content 作为工具结果文本）。
    Ok(json!({ "content": output }))
}

/// 工具主体（与宿主解耦的纯逻辑，便于单测）。
pub fn execute(store: &store::WorkspaceStore, arguments: &Value) -> Result<String, String> {
    let operation = arguments
        .get("operation")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "缺少 operation".to_string())?;
    match operation {
        "list" => {
            let (sessions, active) = store.snapshot();
            Ok(serde_json::to_string_pretty(&json!({
                "active": active,
                "sessions": sessions,
            }))
            .unwrap_or_else(|_| "{}".into()))
        }
        "status" => {
            let session = match arguments.get("id").and_then(|v| v.as_str()) {
                Some(id) if !id.trim().is_empty() => store
                    .get(id)
                    .ok_or_else(|| format!("工作区会话 {id} 不存在"))?,
                _ => store
                    .active()
                    .ok_or_else(|| "没有激活的工作区会话".to_string())?,
            };
            // 本机目录同步采集（git 有硬超时，单目录最多 5s）；远程目录降级为
            // 占位条目并保持声明顺序。
            let directories: Vec<crate::wire::WorkspaceGitInfo> = session
                .directories
                .iter()
                .map(|dir| match dir.node() {
                    Some(node) => crate::wire::WorkspaceGitInfo {
                        directory: format!("node://{node}/{}", dir.path().trim_start_matches('/')),
                        is_repo: false,
                        error: Some(
                            "跨机 git 状态需宿主联邦能力（本模块未接线：降级为不可采集）".into(),
                        ),
                        ..Default::default()
                    },
                    None => crate::git::collect_dir_git(dir.path()),
                })
                .collect();
            Ok(serde_json::to_string_pretty(&json!({
                "session": session.id,
                "name": session.name,
                "directories": directories,
            }))
            .unwrap_or_else(|_| "{}".into()))
        }
        "use" => {
            let id = arguments
                .get("id")
                .and_then(|v| v.as_str())
                .filter(|v| !v.trim().is_empty())
                .ok_or_else(|| "use 需要 id".to_string())?;
            let conversation = arguments
                .get("conversation")
                .and_then(|v| v.as_str())
                .filter(|v| !v.trim().is_empty())
                .map(str::to_string);
            store.set_active(Some(id.to_string()), conversation.clone())?;
            Ok(match conversation {
                Some(conv) => format!("已激活工作区会话 {id}（对话 {conv}）"),
                None => format!("已激活工作区会话 {id}"),
            })
        }
        "conversations" => conversations(store, arguments),
        "create" => {
            let name = arguments
                .get("name")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "create 需要 name".to_string())?;
            let directories = arguments
                .get("directories")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(crate::wire::WorkspaceDirectory::local))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let session = store.upsert(WorkspaceSessionInfo {
                id: String::new(),
                name: name.to_string(),
                directories,
                ..Default::default()
            })?;
            Ok(format!(
                "已创建工作区会话 {}（{}，{} 个目录）",
                session.id,
                session.name,
                session.directories.len()
            ))
        }
        "delete" => {
            let id = arguments
                .get("id")
                .and_then(|v| v.as_str())
                .filter(|v| !v.trim().is_empty())
                .ok_or_else(|| "delete 需要 id".to_string())?;
            if store.delete(id)? {
                Ok(format!("已删除工作区会话 {id}"))
            } else {
                Err(format!("工作区会话 {id} 不存在"))
            }
        }
        other => Err(format!("未知操作: {other}")),
    }
}

/// `conversations` 子操作（list / create / rename / delete）。
fn conversations(store: &store::WorkspaceStore, arguments: &Value) -> Result<String, String> {
    let action = arguments
        .get("conversation_action")
        .and_then(|v| v.as_str())
        .unwrap_or("list");
    // 目标工作区：id 缺省 = 当前激活工作区。
    let workspace_id = match arguments.get("id").and_then(|v| v.as_str()) {
        Some(id) if !id.trim().is_empty() => id.to_string(),
        _ => store
            .active()
            .map(|s| s.id)
            .ok_or_else(|| "conversations 需要 id（当前无激活工作区）".to_string())?,
    };
    match action {
        "list" => {
            let conversations = store.conversations_of(&workspace_id);
            if conversations.is_empty() {
                return Err(format!("工作区会话 {workspace_id} 不存在"));
            }
            let active_conversation = store
                .active_pair()
                .filter(|(ws, _)| ws.id == workspace_id)
                .map(|(_, conv)| conv.id);
            Ok(serde_json::to_string_pretty(&json!({
                "workspace": workspace_id,
                "active_conversation": active_conversation,
                "conversations": conversations,
            }))
            .unwrap_or_else(|_| "{}".into()))
        }
        "create" => {
            let name = arguments
                .get("name")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "create 需要 name".to_string())?;
            let conv = store.upsert_conversation(
                &workspace_id,
                WorkspaceConversationInfo {
                    id: String::new(),
                    name: name.to_string(),
                    legacy: false,
                    api_profile: None,
                },
            )?;
            Ok(format!("已创建对话 {}（{}）", conv.id, conv.name))
        }
        "rename" => {
            let conversation_id = arguments
                .get("conversation_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "rename 需要 conversation_id".to_string())?;
            let name = arguments
                .get("name")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "rename 需要 name".to_string())?;
            let conv = store.upsert_conversation(
                &workspace_id,
                WorkspaceConversationInfo {
                    id: conversation_id.to_string(),
                    name: name.to_string(),
                    legacy: false,
                    api_profile: None,
                },
            )?;
            Ok(format!("已重命名对话 {}（{}）", conv.id, conv.name))
        }
        "delete" => {
            let conversation_id = arguments
                .get("conversation_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "delete 需要 conversation_id".to_string())?;
            match store.delete_conversation(&workspace_id, conversation_id)? {
                Some(_) => Ok(format!("已删除对话 {conversation_id}（其通道历史已清空）")),
                None => Err(format!(
                    "工作区 {workspace_id} 不存在对话 {conversation_id}"
                )),
            }
        }
        other => Err(format!("未知 conversation_action: {other}")),
    }
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

    /// 工具入口：缺 team_id 直接报错（宿主必须注入人格归属）。
    #[tokio::test]
    async fn tool_requires_team_id() {
        let dir = std::env::temp_dir().join(format!("echo-ws-tool-team-{}", std::process::id()));
        let state = state_with(&dir);
        let error = call(&state, json!({"operation": "list"}))
            .await
            .expect_err("需要 team_id");
        assert!(error.contains("team_id"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// create → list → use → conversations 全链路（纯逻辑部分）。
    #[tokio::test]
    async fn tool_lifecycle_over_store() {
        let dir = std::env::temp_dir().join(format!("echo-ws-tool-life-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let state = state_with(&dir);
        let created = call(
            &state,
            json!({"team_id": "t", "operation": "create", "name": "Proj", "directories": ["/srv/a"]}),
        )
        .await
        .expect("create");
        assert!(created["content"]
            .as_str()
            .unwrap()
            .contains("已创建工作区会话"));

        let listed = call(&state, json!({"team_id": "t", "operation": "list"}))
            .await
            .expect("list");
        assert!(listed["content"].as_str().unwrap().contains("\"proj\""));

        let used = call(
            &state,
            json!({"team_id": "t", "operation": "use", "id": "proj"}),
        )
        .await
        .expect("use");
        assert!(used["content"].as_str().unwrap().contains("已激活"));

        let convs = call(
            &state,
            json!({"team_id": "t", "operation": "conversations", "id": "proj"}),
        )
        .await
        .expect("conversations");
        assert!(convs["content"].as_str().unwrap().contains("main"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// status 缺 id = 当前激活会话；没有激活会话 → 明确报错。
    #[tokio::test]
    async fn status_uses_active_or_errors() {
        let dir = std::env::temp_dir().join(format!("echo-ws-tool-status-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let state = state_with(&dir);
        let error = call(&state, json!({"team_id": "t", "operation": "status"}))
            .await
            .expect_err("没有激活会话");
        assert!(error.contains("没有激活的工作区会话"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 参数 schema 自洽：required 只含 operation，枚举值齐备。
    #[test]
    fn parameters_schema_is_coherent() {
        let params = parameters();
        assert_eq!(params["required"], json!(["operation"]));
        let operations = params["properties"]["operation"]["enum"]
            .as_array()
            .expect("enum");
        assert_eq!(operations.len(), 6);
        assert!(params["properties"]["conversation_action"]["enum"]
            .as_array()
            .expect("enum")
            .contains(&json!("rename")));
    }
}
