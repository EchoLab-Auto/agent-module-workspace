//! 跨机工作区查询接缝（宿主注入）。
//!
//! ## 为什么 trait 的声明方是**本模块**
//!
//! 工作区目录可以是 `node://<peer>/<path>`——**对端机器**上的目录。查它的
//! git 状态、列文件、浏览子目录都要问到对端，而那份传输属宿主的联邦子系统。
//!
//! 三方关系：
//!
//! | 角色 | 谁 | 需要什么 |
//! |---|---|---|
//! | 声明（消费方） | 本模块 | "我要问这三个问题" |
//! | 实现方 | 组合根（把联邦的 `RemoteQuerier` 适配过来） | 联邦 `QueryKind` |
//! | 取用 | 本模块 `mount` 时按服务键解析 | [`REMOTE_QUERY`] |
//!
//! 历史（2026-11）：这个 trait 曾住在 Core 的 `echo-defs`，于是本模块**根本
//! 无法命名它**（本仓不依赖 Core 的任何 crate，反向依赖就是包级循环，Cargo
//! 拒绝），只能把三个远程能力全部降级成"不可采集"占位。可对端的执行端
//! （`handle_federation_query`）与发送端（`ports.querier`）早就齐全，缺的
//! 只是这一段声明；语义（问 git / 问文件 / 问目录）本就属于消费方，所以
//! 契约归位到本模块，宿主只负责实现与注入。
//!
//! ## 未注入 = 降级
//!
//! 单机部署不需要这个接缝：服务键解析不到时，远程目录继续显示
//! 「远程不可采集」占位，本机功能零影响。与 trait 曾住在 Core 时同款取舍。

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use echo_context::ServiceKey;

/// 一次远程查询的结果（对端回推的 JSON 载荷，或可读错误）。
pub type QueryFuture = Pin<Box<dyn Future<Output = Result<serde_json::Value, String>> + Send>>;

/// 跨机工作区只读查询接缝（宿主注入）。
///
/// 载荷形状（与对端 `handle_federation_query` 一一对应）：
///
/// | 方法 | 对端 `QueryKind` | 成功载荷 |
/// |---|---|---|
/// | [`Self::git_status`] | `WorkspaceGitStatus` | `{"git": WorkspaceGitInfo}` |
/// | [`Self::list_files`] | `WorkspaceFiles` | `{"entries": [WorkspaceFileEntry]}` |
/// | [`Self::browse`] | `BrowseDirectories` | `{"roots": [BrowseRoot], "entries": [...]}` |
pub trait RemoteWorkspaceQuery: Send + Sync {
    /// 对端某目录的 git 状态（`peer` 是联邦节点名，`path` 是对端绝对路径）。
    fn git_status(&self, peer: String, path: String) -> QueryFuture;

    /// 对端某目录的文件清单。
    fn list_files(&self, peer: String, path: String) -> QueryFuture;

    /// 对端目录浏览（`path` 空 = 根列表请求）。
    fn browse(&self, peer: String, path: String) -> QueryFuture;
}

/// 宿主注入的句柄类型（装箱一次，多次查询共用）。
pub type RemoteQueryHandle = Arc<dyn RemoteWorkspaceQuery>;

/// 服务键：组合根在装配期 `provide`，本模块在 `mount` 时取用。
///
/// 键名带 `host.` 前缀是约定（表示"由宿主提供的能力"），与 `echo-module-tools`
/// 的 `echo-agent.host.tools.*` 同款。
pub static REMOTE_QUERY: ServiceKey<RemoteQueryHandle> =
    ServiceKey::new("echo-agent.host.workspace.remote_query");

/// 把 `node://<peer>/<path>` 拆成 `(peer, "/<path>")`。
///
/// 拆分规则与 [`crate::wire::WorkspaceDirectory`] 的线格式一致：第一个 `/`
/// 之后是**对端绝对路径**。对端路径必须带前导 `/`（联邦查询的沙箱校验拿它
/// 做 `canonicalize`，相对路径一律拒绝），所以这里补回来而不是原样返回。
///
/// 不是 `node://` 形式、或 peer 为空时返回 `None`——调用方按"本机路径"处理，
/// 不要在解析失败时猜。
pub fn split_node_path(raw: &str) -> Option<(String, String)> {
    let rest = raw.strip_prefix("node://")?;
    let (peer, path) = match rest.split_once('/') {
        Some((peer, path)) => (peer, path),
        // `node://peer`（无路径）= 对端根目录。
        None => (rest, ""),
    };
    if peer.is_empty() {
        return None;
    }
    Some((peer.to_string(), format!("/{}", path.trim_start_matches('/'))))
}

/// 把 `(peer, path)` 还原成 `node://<peer>/<path>` 的规范写法。
///
/// 反向操作 [`split_node_path`]：`path` 带不带前导 `/` 都接受，`node://peer/`
/// 这种**末尾带斜杠**的形式也统一掉。面板按 `node://` 前缀识别所属节点
/// （见 `panel-ui/workspace.ts` 的 `directoryNode`），所以回填给前端的
/// `WorkspaceGitInfo.directory` 必须是这个规范形状。
pub fn join_node_path(peer: &str, path: &str) -> String {
    format!("node://{peer}/{}", path.trim_start_matches('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_node_path_keeps_absolute_peer_path() {
        assert_eq!(
            split_node_path("node://gpu-box/srv/repo"),
            Some(("gpu-box".to_string(), "/srv/repo".to_string()))
        );
        // 末尾带斜杠 = 对端根目录（`node://peer/`）。
        assert_eq!(
            split_node_path("node://gpu-box/"),
            Some(("gpu-box".to_string(), "/".to_string()))
        );
        // 无路径部件同样是根。
        assert_eq!(
            split_node_path("node://gpu-box"),
            Some(("gpu-box".to_string(), "/".to_string()))
        );
    }

    #[test]
    fn split_node_path_rejects_non_remote_and_empty_peer() {
        assert_eq!(split_node_path("/srv/repo"), None);
        assert_eq!(split_node_path("node:///srv/repo"), None);
    }

    #[test]
    fn join_and_split_round_trip() {
        for raw in ["node://gpu-box/srv/repo", "node://gpu-box/"] {
            let (peer, path) = split_node_path(raw).expect("remote");
            assert_eq!(join_node_path(&peer, &path), raw);
        }
        // 面板的识别前缀：回填值必须仍以 `node://` 开头，否则会被当成
        // 本机目录（`directoryNode` 返回 null）。
        assert!(join_node_path("gpu-box", "/srv/repo").starts_with("node://"));
    }
}
