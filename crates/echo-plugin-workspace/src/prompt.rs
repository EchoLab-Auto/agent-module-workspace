//! 工作区提示词块正文。
//!
//! 单一实现，供 `WorkspaceStore::prompt_text`（全局 active）与
//! `prompt_text_for`（按会话解析）两条路径共用——两处拼装同一段文案极易漂移，
//! 而这段文案直接决定模型看到的项目上下文。

use crate::wire::{WorkspaceConversationInfo, WorkspaceSessionInfo};

/// 工作区提示词正文。
pub fn render_prompt_text(
    session: &WorkspaceSessionInfo,
    conv: &WorkspaceConversationInfo,
) -> String {
    if session.directories.is_empty() && session.name.is_empty() {
        return String::new();
    }
    let mut text = format!("# 当前工作区会话\n{}", session.name);
    if !session.description.is_empty() {
        text.push_str(&format!("（{}）", session.description));
    }
    // 多对话：标注当前对话名——各对话上下文独立，名称帮助模型区分任务线。
    text.push_str(&format!("\n当前对话：{}（id: {}）", conv.name, conv.id));
    if !session.directories.is_empty() {
        text.push_str("\n工作区目录：\n");
        for dir in &session.directories {
            match dir.node() {
                // 跨机文件协作：远程目录可操作——文件工具的 path 参数用
                // `node://<peer>/<绝对路径>` 前缀，经联邦 Invoke 在对端沙箱内执行。
                Some(node) => text.push_str(&format!(
                    "- node://{node}/{} [remote:{node}]（远程节点：文件工具的 path 用 node://{node}/<绝对路径> 前缀直接读写/列目录/搜索；bash 工具可用 node://{node}/<命令> 在对端执行，如 node://{node}/cargo test）\n",
                    dir.path().trim_start_matches('/')
                )),
                None => text.push_str(&format!("- {}\n", dir.path())),
            }
        }
        text.push_str("在本机目录范围内工作；标注 [remote:<peer>] 的远程目录以 node:// 前缀路径直接操作（文件工具用 path 前缀，bash 用命令前缀；对端白名单/沙箱裁决，拒绝会原样返回）；git 状态与其它会话可用 workspace 工具查询/切换。");
    } else {
        text.push_str("\n（尚未配置工作区目录，可用 workspace 工具或面板添加）");
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::WorkspaceDirectory;

    /// P3-1：远程目录在提示词中标注 [remote:<peer>] 且说明 node:// 可操作。
    #[test]
    fn prompt_marks_remote_dirs_as_operable() {
        let session = WorkspaceSessionInfo {
            id: "r".into(),
            name: "R".into(),
            description: String::new(),
            directories: vec![
                WorkspaceDirectory::local("/srv/local"),
                WorkspaceDirectory::Qualified {
                    path: "/srv/repo".into(),
                    node: Some("gpu-box".into()),
                },
            ],
            ..Default::default()
        };
        let conv = WorkspaceConversationInfo {
            id: "main".into(),
            name: "主对话".into(),
            legacy: true,
            api_profile: None,
        };
        let text = render_prompt_text(&session, &conv);
        assert!(text.contains("[remote:gpu-box]"), "text: {text}");
        assert!(text.contains("node://gpu-box/srv/repo"), "text: {text}");
        assert!(text.contains("node://gpu-box/<绝对路径>"), "操作说明: {text}");
        assert!(text.contains("- /srv/local\n"), "本机目录不带标注: {text}");
        assert!(text.contains("当前对话：主对话"), "text: {text}");
    }

    /// 无目录：提示词给出「如何添加」而不是空白。
    #[test]
    fn prompt_without_directories_explains_next_step() {
        let session = WorkspaceSessionInfo {
            name: "空项目".into(),
            ..Default::default()
        };
        let conv = WorkspaceConversationInfo {
            id: "main".into(),
            name: "主对话".into(),
            legacy: true,
            api_profile: None,
        };
        let text = render_prompt_text(&session, &conv);
        assert!(text.contains("尚未配置工作区目录"), "{text}");
    }

    /// 名称与目录都空 → 不贡献文本块（宿主据此丢弃空块）。
    #[test]
    fn empty_session_contributes_nothing() {
        let session = WorkspaceSessionInfo::default();
        let conv = WorkspaceConversationInfo::default();
        assert!(render_prompt_text(&session, &conv).is_empty());
    }
}
