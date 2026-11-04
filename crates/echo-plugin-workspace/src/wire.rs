//! 线类型（与宿主 `echo-protocol` 的字段名逐字一致）。
//!
//! 为什么独立仓库里要**复制**这些类型，而不是依赖 Core 仓的 `echo-protocol`：
//!
//! - 插件仓被 Core 以 git 依赖引入（`Cargo.toml`），若插件再反过来依赖 Core
//!   仓的 crate，就成了**包级循环依赖**，Cargo 直接拒绝。
//! - 这些类型在插件里的用途只有两个：反序列化面板命令的载荷、序列化插件发给
//!   宿主的事件载荷。**两侧都是 JSON**，所以"同一份 Rust 类型"不是必需品，
//!   "同一份字段名"才是。
//!
//! 因此这里的每个 `struct` 都是**线格式的镜像**：字段名、`serde` 默认值、
//! `skip_serializing_if` 与 `echo-protocol/src/event.rs` 保持一致。改线格式时
//! 两边必须同批改（Core 仓有契约测试钉住字段名，本仓的 `wire_contract` 测试
//! 钉住镜像这边）。

use serde::{Deserialize, Serialize};

/// 工作区内的一条对话。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceConversationInfo {
    /// 稳定 id（slug；工作区内唯一，不含 `/`）。
    #[serde(default)]
    pub id: String,
    pub name: String,
    /// 通道 id 是否为存量裸 ws 格式（`local:workspace:<ws>:<user>`）。
    #[serde(default)]
    pub legacy: bool,
    /// 会话级 API 覆盖；`None` = 跟随 persona 级。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_profile: Option<String>,
}

/// 工作区目录条目：本机（线格式 = 纯字符串）或带节点归属。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum WorkspaceDirectory {
    /// 本机目录（线格式：纯字符串）。
    Local(String),
    /// 带节点归属的目录；`node: None` 等价于本机。
    Qualified {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        node: Option<String>,
    },
}

impl WorkspaceDirectory {
    /// 本机目录条目。
    pub fn local(path: impl Into<String>) -> Self {
        Self::Local(path.into())
    }

    /// 目录路径（远程条目返回其绝对路径部分）。
    pub fn path(&self) -> &str {
        match self {
            Self::Local(path) => path,
            Self::Qualified { path, .. } => path,
        }
    }

    /// 归属节点（本机为 `None`）。
    pub fn node(&self) -> Option<&str> {
        match self {
            Self::Local(_) => None,
            Self::Qualified { node, .. } => node.as_deref(),
        }
    }

    /// 是否声明为远程目录。
    pub fn is_remote(&self) -> bool {
        self.node().is_some()
    }
}

impl From<&str> for WorkspaceDirectory {
    fn from(value: &str) -> Self {
        Self::Local(value.to_string())
    }
}

impl From<String> for WorkspaceDirectory {
    fn from(value: String) -> Self {
        Self::Local(value)
    }
}

/// 一个工作区会话：名称 + 多个工作区目录 + 对话列表。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceSessionInfo {
    /// 稳定 id（空 = 依名称生成 slug）。
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub directories: Vec<WorkspaceDirectory>,
    /// 空 = 仅存量主对话（读取期惰性补位，不落盘）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conversations: Vec<WorkspaceConversationInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_conversation: Option<String>,
}

/// 变更文件明细（路径 + porcelain 两列状态字符）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceChangedEntry {
    pub path: String,
    #[serde(default)]
    pub index: String,
    #[serde(default)]
    pub worktree: String,
}

/// 单个目录的 git 快照。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceGitInfo {
    pub directory: String,
    pub is_repo: bool,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub ahead: u32,
    #[serde(default)]
    pub behind: u32,
    #[serde(default)]
    pub staged: u32,
    #[serde(default)]
    pub modified: u32,
    #[serde(default)]
    pub untracked: u32,
    #[serde(default)]
    pub changed_files: Vec<String>,
    #[serde(default)]
    pub changed_entries: Vec<WorkspaceChangedEntry>,
    #[serde(default)]
    pub last_commit: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

/// 文件浏览器中的一个条目。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceFileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    #[serde(default)]
    pub size: u64,
}

/// 目录选择器的浏览根。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct BrowseRoot {
    pub label: String,
    pub path: String,
}

#[cfg(test)]
mod wire_contract {
    use super::*;

    /// 目录条目的线格式与 Core 的 `echo-protocol` 一致：本机 = 纯字符串，
    /// 带节点 = 表形式。这是面板/旧数据兼容的**唯一**依据。
    #[test]
    fn directory_wire_shape_matches_core() {
        let local = serde_json::to_value(WorkspaceDirectory::local("/srv/a")).unwrap();
        assert_eq!(local, serde_json::json!("/srv/a"));
        let qualified = WorkspaceDirectory::Qualified {
            path: "/srv/b".into(),
            node: Some("gpu".into()),
        };
        assert_eq!(
            serde_json::to_value(&qualified).unwrap(),
            serde_json::json!({"path": "/srv/b", "node": "gpu"})
        );
        // untagged：两种形态都能读回来（旧数据迁移路径）。
        let back: Vec<WorkspaceDirectory> = serde_json::from_value(
            serde_json::json!(["/srv/a", {"path": "/srv/b", "node": "gpu"}, {"path": "/srv/c"}]),
        )
        .unwrap();
        assert_eq!(back[0].path(), "/srv/a");
        assert!(back[0].node().is_none());
        assert_eq!(back[1].node(), Some("gpu"));
        assert!(!back[2].is_remote(), "node 缺省 = 本机");
    }

    /// 会话 JSON 的键名：面板命令载荷按这些名字发来。
    #[test]
    fn session_keys_are_stable() {
        let session = WorkspaceSessionInfo {
            id: "proj".into(),
            name: "Proj".into(),
            description: String::new(),
            directories: vec![WorkspaceDirectory::local("/srv/a")],
            conversations: vec![],
            last_conversation: None,
        };
        let value = serde_json::to_value(&session).unwrap();
        assert_eq!(value["id"], "proj");
        assert_eq!(value["directories"][0], "/srv/a");
        // 空的 conversations / last_conversation 不落键（与 Core 相同）。
        assert!(value.get("conversations").is_none());
        assert!(value.get("last_conversation").is_none());
    }
}
