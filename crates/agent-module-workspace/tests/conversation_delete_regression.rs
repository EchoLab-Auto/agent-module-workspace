//! C2 第二阶段：Workspace 删除回归（**生产语义未改，只钉现状**）。
//!
//! C1 静态核实的事实：
//! 1. 面板 `removeConversation` 先发 `ClearHistory`，再发 `SaveWorkspaceSession`；
//! 2. `WorkspaceStore::upsert` 把 `conversations: []` 解释为「本次未提供」，
//!    并恢复旧列表（含 `last_conversation`）；
//! 3. 工具删除走 `delete_conversation` → `conversation_deleted` 钩子（宿主清历史）；
//! 4. 整工作区删除（`WorkspaceStore::delete`）不触发该钩子（不清历史）。
//!
//! 这些用例只使用**进程私有临时文件**（`echo-workspace-c2-delete-*`），
//! 不读不写真实 `echo-workspaces-*.json`，也不产生任何真实会话历史。
//!
//! ⚠️ 本文件是 **C2 现状基线**：C3 一旦改变删除语义（默认不清历史 /
//! 允许删最后一条），这些断言必须与 C3 同批改写，不能当作目标行为沿用。
//!
//! C3b 接线状态（2026-11）：面板默认删除已改走模块私有方法
//! `workspace.deleteConversation`、工具 `conversations delete` 已改走
//! `delete_conversation_entry`（两者都不发历史清理钩子）。本文件**保留**为
//! 旧入口 `delete_conversation` / 全量 upsert 的 store 级证据（断言未改；
//! 它们仍描述 store 的既有语义），命令与工具层的目标语义见
//! `conversation_entry_delete_command.rs` 与
//! `panel-ui/components/tests/WorkspacePanelConversationDelete.test.ts`。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use agent_module_workspace::store::WorkspaceStore;
use agent_module_workspace::wire::{WorkspaceConversationInfo, WorkspaceSessionInfo};

/// 临时文档守卫：测试结束（含 panic）时删掉 json 与可能残留的 `.json.tmp` 目录。
struct TempDoc {
    path: PathBuf,
}

impl TempDoc {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "echo-workspace-c2-delete-{}-{name}.json",
            std::process::id()
        ));
        std::fs::remove_file(&path).ok();
        std::fs::remove_dir_all(path.with_extension("json.tmp")).ok();
        Self { path }
    }

    fn path(&self) -> PathBuf {
        self.path.clone()
    }

    fn store(&self) -> WorkspaceStore {
        WorkspaceStore::load(Some(self.path()))
    }
}

impl Drop for TempDoc {
    fn drop(&mut self) {
        std::fs::remove_file(&self.path).ok();
        std::fs::remove_dir_all(self.path.with_extension("json.tmp")).ok();
    }
}

fn conv(id: &str, name: &str, legacy: bool) -> WorkspaceConversationInfo {
    WorkspaceConversationInfo {
        id: id.into(),
        name: name.into(),
        legacy,
        api_profile: None,
    }
}

fn session_with(
    conversations: Vec<WorkspaceConversationInfo>,
    last: Option<&str>,
) -> WorkspaceSessionInfo {
    WorkspaceSessionInfo {
        id: "proj".into(),
        name: "Proj".into(),
        directories: vec!["/srv/proj".into()],
        conversations,
        last_conversation: last.map(str::to_string),
        ..Default::default()
    }
}

/// 钩子调用记录：(工作区 id, 对话 id)。
#[derive(Clone, Default)]
struct DeletedLog {
    calls: Arc<Mutex<Vec<(String, String)>>>,
}

impl DeletedLog {
    fn install(&self, store: &WorkspaceStore) {
        let calls = Arc::clone(&self.calls);
        store.set_on_conversation_deleted(Arc::new(move |ws, conv| {
            calls
                .lock()
                .unwrap()
                .push((ws.to_string(), conv.id.clone()));
        }));
    }

    fn count(&self) -> usize {
        self.calls.lock().unwrap().len()
    }
}

fn persisted_json(path: &Path) -> serde_json::Value {
    let raw = std::fs::read_to_string(path).expect("workspace doc should exist");
    serde_json::from_str(&raw).expect("workspace doc should be valid json")
}

/// 面板删「最后一条对话」的 payload = 空数组 + null；store 把它当「未提供」，
/// 恢复旧列表 —— 删不掉条目。而面板在发这条命令**之前**已经发了 ClearHistory。
#[test]
fn panel_delete_last_conversation_payload_is_restored_by_upsert() {
    let doc = TempDoc::new("last-conv-via-upsert");
    let store = doc.store();
    let original = session_with(vec![conv("main", "主对话", true)], Some("main"));
    store.upsert(original.clone()).unwrap();

    // 面板 removeConversation：rest = []，last_conversation 回退 null。
    let mut panel_payload = original.clone();
    panel_payload.conversations = Vec::new();
    panel_payload.last_conversation = None;

    let saved = store.upsert(panel_payload).expect("upsert 本身会成功");
    assert_eq!(
        saved.conversations,
        vec![conv("main", "主对话", true)],
        "空数组被解释为「未提供」，对话被恢复"
    );
    assert_eq!(saved.last_conversation.as_deref(), Some("main"));

    // 落盘后重新加载仍是旧列表：删除没有持久化。
    let reloaded = WorkspaceStore::load(Some(doc.path()));
    let stored = reloaded.get("proj").expect("session");
    assert_eq!(stored.conversations.len(), 1);
    assert_eq!(stored.last_conversation.as_deref(), Some("main"));
}

/// 元数据编辑（名称/目录）不带 conversations：读取侧恢复、落盘后仍保留。
/// 这是现有 upsert 的保护；本用例补上「重新加载后」的持久化断言。
#[test]
fn metadata_edit_without_list_keeps_conversations_after_reload() {
    let doc = TempDoc::new("metadata-keeps-convs");
    let store = doc.store();
    store
        .upsert(session_with(
            vec![conv("main", "主对话", true), conv("docs", "文档线", false)],
            Some("docs"),
        ))
        .unwrap();

    let edited = store
        .upsert(WorkspaceSessionInfo {
            id: "proj".into(),
            name: "Proj Renamed".into(),
            description: "只改元数据".into(),
            directories: vec!["/srv/proj2".into()],
            conversations: Vec::new(),
            last_conversation: None,
            ..Default::default()
        })
        .expect("metadata edit");

    assert_eq!(edited.name, "Proj Renamed");
    assert_eq!(edited.conversations.len(), 2, "元数据编辑不得清对话");
    assert_eq!(edited.last_conversation.as_deref(), Some("docs"));

    let reloaded = WorkspaceStore::load(Some(doc.path()));
    let stored = reloaded.get("proj").expect("session");
    assert_eq!(stored.conversations.len(), 2);
    assert_eq!(stored.conversations[1].id, "docs");
    assert_eq!(stored.last_conversation.as_deref(), Some("docs"));
}

/// 删除「非最后一条」走 upsert：只替换为目标列表，其他对话原样保留。
#[test]
fn upsert_delete_non_last_conversation_removes_only_target() {
    let doc = TempDoc::new("delete-middle-via-upsert");
    let store = doc.store();
    store
        .upsert(session_with(
            vec![conv("main", "主对话", true), conv("docs", "文档线", false)],
            Some("docs"),
        ))
        .unwrap();

    let rest = vec![conv("main", "主对话", true)];
    let saved = store
        .upsert(session_with(rest.clone(), Some("main")))
        .expect("delete docs");

    assert_eq!(saved.conversations, rest);
    assert_eq!(saved.last_conversation.as_deref(), Some("main"));
    assert_eq!(
        WorkspaceStore::load(Some(doc.path()))
            .get("proj")
            .unwrap()
            .conversations,
        rest
    );
}

/// 工具/宿主路径的重复删除：第二次返回 None，钩子只触发一次（历史只清一次）。
#[test]
fn repeated_tool_delete_is_idempotent_and_hook_fires_once() {
    let doc = TempDoc::new("repeat-tool-delete");
    let store = doc.store();
    store
        .upsert(session_with(
            vec![conv("main", "主对话", true), conv("docs", "文档线", false)],
            Some("docs"),
        ))
        .unwrap();
    let log = DeletedLog::default();
    log.install(&store);

    let first = store.delete_conversation("proj", "docs").expect("first");
    assert_eq!(first.as_ref().map(|c| c.id.as_str()), Some("docs"));
    let second = store.delete_conversation("proj", "docs").expect("second");
    assert!(second.is_none(), "重复删除应为 no-op");
    assert_eq!(log.count(), 1, "conversation_deleted 只应触发一次");
    assert_eq!(
        store.get("proj").unwrap().conversations,
        vec![conv("main", "主对话", true)]
    );
}

/// 工具删「最后一条对话」：内存列表清空，但**读取视图**又把隐式主对话补回来，
/// 且持久化 JSON 因 `skip_serializing_if` 省略空数组 —— 「删了等于没删」，
/// 但历史已经被钩子清掉。这是「空数组无法表达已删除」的根因证据。
#[test]
fn tool_delete_last_conversation_rematerializes_implicit_main() {
    let doc = TempDoc::new("delete-last-tool");
    let store = doc.store();
    store
        .upsert(session_with(
            vec![conv("main", "主对话", true)],
            Some("main"),
        ))
        .unwrap();
    let log = DeletedLog::default();
    log.install(&store);

    let removed = store
        .delete_conversation("proj", "main")
        .expect("delete last");
    assert_eq!(removed.as_ref().map(|c| c.id.as_str()), Some("main"));
    assert_eq!(log.count(), 1, "历史清理钩子已触发");

    let raw = store.get("proj").expect("session");
    assert!(raw.conversations.is_empty(), "内存里对话已被移除");
    assert_eq!(raw.last_conversation, None);

    // 读取视图会把空列表补成 {id:"main", legacy:true}：条目看起来还在。
    let view = store.conversations_of("proj");
    assert_eq!(view.len(), 1);
    assert_eq!(view[0].id, "main");
    assert!(view[0].legacy);

    // 线格式省略空 conversations：落盘 JSON 没有该字段，读取端无法区分
    // 「空」与「未提供」。
    let persisted = persisted_json(&doc.path());
    let session = &persisted["sessions"][0];
    assert!(
        session.get("conversations").is_none(),
        "空 conversations 被 serde 省略: {session}"
    );
}

/// 整工作区删除不触发 conversation_deleted：历史保留（C1 的现状语义）。
#[test]
fn delete_workspace_does_not_fire_conversation_delete_hook() {
    let doc = TempDoc::new("delete-workspace");
    let store = doc.store();
    store
        .upsert(session_with(
            vec![conv("main", "主对话", true), conv("docs", "文档线", false)],
            Some("docs"),
        ))
        .unwrap();
    let log = DeletedLog::default();
    log.install(&store);

    assert!(store.delete("proj").expect("delete workspace"));
    assert!(store.get("proj").is_none());
    assert_eq!(log.count(), 0, "整工作区删除不得清对话历史");
}

/// 落盘失败时：delete_conversation 返回 Err、**不触发** conversation_deleted
/// （历史不被清），磁盘上的旧对话仍在。
///
/// 注意：现有实现先改内存再落盘，失败无回滚（内存里对话已消失、磁盘未变），
/// 所以不能把失败后的内存当权威——本用例把它作为现状一并钉住。
#[test]
fn conversation_delete_persist_failure_keeps_history_and_disk() {
    let doc = TempDoc::new("delete-save-failure");
    let store = doc.store();
    store
        .upsert(session_with(
            vec![conv("main", "主对话", true), conv("docs", "文档线", false)],
            Some("docs"),
        ))
        .unwrap();

    // 让 save_locked 的临时文件路径变成一个目录：write 必失败。
    let tmp = doc.path().with_extension("json.tmp");
    std::fs::create_dir_all(&tmp).expect("create tmp dir to force write failure");

    let log = DeletedLog::default();
    log.install(&store);
    let error = store
        .delete_conversation("proj", "docs")
        .expect_err("save must fail");
    assert!(error.contains("写入"), "unexpected error: {error}");
    assert_eq!(log.count(), 0, "落盘失败不得清历史");

    let reloaded = WorkspaceStore::load(Some(doc.path()));
    let disk = reloaded.get("proj").expect("disk session");
    assert_eq!(disk.conversations.len(), 2, "磁盘仍是旧列表");
    assert_eq!(disk.last_conversation.as_deref(), Some("docs"));

    // 现状：内存已改（无回滚），与磁盘分叉。
    assert_eq!(
        store.get("proj").unwrap().conversations.len(),
        1,
        "现状：失败前已改内存"
    );
}
