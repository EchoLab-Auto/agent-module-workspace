//! C3a：Workspace「只删对话入口」存储契约（**新操作专属测试**）。
//!
//! C2 已用隔离夹具钉住现状：面板先 `ClearHistory` 再 `SaveWorkspaceSession`、
//! `conversations: []` 被 `upsert` 当「未提供」回填、工具删除旧接口
//! （`delete_conversation`）会触发 `conversation_deleted` 让宿主清历史、且
//! 先改内存后落盘（失败无回滚）。C2 的断言**不在这里改**。
//!
//! 本文件只验证新增的 [`WorkspaceStore::delete_conversation_entry`]：
//!
//! 1. 只删入口：不发历史清理钩子（`conversation_deleted` 计数 0），只发一次
//!    变更通知；
//! 2. 幂等：重复删除 / 陈旧 id / 不存在 → `AlreadyAbsent`，**不写盘**、不通知；
//! 3. 拒绝最后一条：`RefusedLastConversation`（含"空列表惰性补位主对话"的档），
//!    不写盘、不物化；
//! 4. 落盘失败原子回滚：内存、磁盘、退役元数据都不变，钩子/通知都不发；
//! 5. 通道身份不复用：被删对话的通道退役，新对话（自动 id / 裸 legacy）不会
//!    再落进同一通道；
//! 6. 退役元数据可缺省：旧档（无该键）照常读，键只在删除发生后才出现，重载保留。
//!
//! 全部使用进程私有临时文件（`echo-workspace-c3a-entry-*`），不读不写真实
//! `echo-workspaces-*.json`，也不产生任何真实会话历史。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use agent_module_workspace::store::{channel_scope_id, ConversationEntryRemoval, WorkspaceStore};
use agent_module_workspace::wire::{WorkspaceConversationInfo, WorkspaceSessionInfo};

/// 临时文档守卫：测试结束（含 panic）时删掉 json 与可能的 `.json.tmp`。
struct TempDoc {
    path: PathBuf,
}

impl TempDoc {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "echo-workspace-c3a-entry-{}-{name}.json",
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

    fn raw(&self) -> String {
        std::fs::read_to_string(&self.path).expect("workspace doc should exist")
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

/// 变更通知计数（`on_change`）。
#[derive(Clone, Default)]
struct Changes(Arc<AtomicUsize>);

impl Changes {
    fn install(&self, store: &WorkspaceStore) {
        let counter = Arc::clone(&self.0);
        store.set_on_change(Arc::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        }));
    }

    fn count(&self) -> usize {
        self.0.load(Ordering::SeqCst)
    }
}

/// 历史清理钩子调用记录（`on_conversation_deleted`）。
#[derive(Clone, Default)]
struct DeletedLog(Arc<Mutex<Vec<(String, String)>>>);

impl DeletedLog {
    fn install(&self, store: &WorkspaceStore) {
        let calls = Arc::clone(&self.0);
        store.set_on_conversation_deleted(Arc::new(move |ws, conv| {
            calls
                .lock()
                .unwrap()
                .push((ws.to_string(), conv.id.clone()));
        }));
    }

    fn count(&self) -> usize {
        self.0.lock().unwrap().len()
    }
}

fn json_of(path: &Path) -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(path).expect("doc exists")).expect("valid json")
}

/// 只删入口：目标条目消失、指针回退、只发一次变更通知、**不发**历史清理钩子。
#[test]
fn entry_delete_removes_only_target_and_never_fires_history_hook() {
    let doc = TempDoc::new("only-entry");
    let store = doc.store();
    store
        .upsert(session_with(
            vec![conv("main", "主对话", true), conv("docs", "文档线", false)],
            Some("docs"),
        ))
        .unwrap();
    store
        .set_active(Some("proj".into()), Some("docs".into()))
        .unwrap();
    assert_eq!(store.active_pair().unwrap().1.id, "docs");

    let changes = Changes::default();
    changes.install(&store);
    let deletes = DeletedLog::default();
    deletes.install(&store);

    match store.delete_conversation_entry("proj", "docs").unwrap() {
        ConversationEntryRemoval::Deleted(removed) => {
            assert_eq!(removed.id, "docs");
            assert!(!removed.legacy);
        }
        other => panic!("expected Deleted, got {other:?}"),
    }

    assert_eq!(deletes.count(), 0, "只删入口不得发历史清理钩子");
    assert_eq!(changes.count(), 1, "成功变更只通知一次");

    // 内存：条目移除、last/active 指回剩余的 main。
    let stored = store.get("proj").expect("session");
    assert_eq!(stored.conversations, vec![conv("main", "主对话", true)]);
    assert_eq!(stored.last_conversation.as_deref(), Some("main"));
    assert_eq!(store.active_pair().unwrap().1.id, "main");
    assert_eq!(store.conversations_of("proj").len(), 1);

    // 磁盘与内存一致。
    let disk = WorkspaceStore::load(Some(doc.path()))
        .get("proj")
        .expect("disk");
    assert_eq!(disk.conversations, vec![conv("main", "主对话", true)]);
    assert_eq!(disk.last_conversation.as_deref(), Some("main"));

    // 通道退役（与删除同一次落盘）。
    assert_eq!(
        store.retired_channels_of("proj"),
        vec!["proj/docs".to_string()]
    );
}

/// 幂等：重复删除 / 陈旧 id 都是 `AlreadyAbsent`，**不写盘**、不通知、不发钩子。
#[test]
fn entry_delete_is_idempotent_and_never_writes_on_noop() {
    let doc = TempDoc::new("idempotent");
    let store = doc.store();
    store
        .upsert(session_with(
            vec![conv("main", "主对话", true), conv("docs", "文档线", false)],
            Some("docs"),
        ))
        .unwrap();

    let changes = Changes::default();
    changes.install(&store);
    let deletes = DeletedLog::default();
    deletes.install(&store);

    assert!(matches!(
        store.delete_conversation_entry("proj", "docs").unwrap(),
        ConversationEntryRemoval::Deleted(_)
    ));
    assert_eq!(changes.count(), 1);

    // 删掉磁盘文件：任何一次真正的写入都会把它重建出来，据此证明 no-op 零写。
    std::fs::remove_file(doc.path()).expect("remove doc to detect writes");

    assert_eq!(
        store.delete_conversation_entry("proj", "docs").unwrap(),
        ConversationEntryRemoval::AlreadyAbsent,
        "重复删除应为幂等 no-op"
    );
    assert_eq!(
        store.delete_conversation_entry("proj", "ghost").unwrap(),
        ConversationEntryRemoval::AlreadyAbsent,
        "陈旧/不存在的 id 也是 no-op"
    );
    assert_eq!(deletes.count(), 0, "no-op 不发历史清理钩子");
    assert_eq!(changes.count(), 1, "no-op 不通知");

    // 不存在的工作区仍是错误（不是"幂等 no-op"）。
    let error = store
        .delete_conversation_entry("nope", "docs")
        .expect_err("missing workspace");
    assert!(error.contains("不存在"), "{error}");

    assert!(!doc.path().exists(), "no-op 不得写盘");
}

/// 拒绝最后一条：显式列表的 last 与「空列表惰性补位主对话」的档都拒绝，
/// 且不写盘、不物化、不发钩子。
#[test]
fn refuses_last_conversation_without_writing() {
    // ① 显式只有一条。
    let doc = TempDoc::new("refuse-last-explicit");
    let store = doc.store();
    store
        .upsert(session_with(
            vec![conv("main", "主对话", true)],
            Some("main"),
        ))
        .unwrap();
    let changes = Changes::default();
    changes.install(&store);
    let deletes = DeletedLog::default();
    deletes.install(&store);
    std::fs::remove_file(doc.path()).expect("remove doc to detect writes");

    match store.delete_conversation_entry("proj", "main").unwrap() {
        ConversationEntryRemoval::RefusedLastConversation(refused) => {
            assert_eq!(refused.id, "main");
        }
        other => panic!("expected RefusedLastConversation, got {other:?}"),
    }
    assert_eq!(store.conversations_of("proj").len(), 1);
    assert_eq!(deletes.count(), 0);
    assert_eq!(changes.count(), 0);
    assert!(
        store.retired_channels_of("proj").is_empty(),
        "拒绝不得退役通道"
    );
    assert!(!doc.path().exists(), "拒绝不得写盘");

    // ② 旧档 conversations 缺省（读取视图惰性补位 main:legacy）：同样拒绝，
    //    且不把补位结果物化进磁盘。
    let implicit = TempDoc::new("refuse-last-implicit");
    let store = implicit.store();
    store
        .upsert(WorkspaceSessionInfo {
            id: "proj".into(),
            name: "Proj".into(),
            ..Default::default()
        })
        .unwrap();
    assert!(
        json_of(&implicit.path())["sessions"][0]
            .get("conversations")
            .is_none(),
        "前置：空列表不落键，读取端靠惰性补位"
    );
    assert_eq!(store.conversations_of("proj").len(), 1);

    let changes = Changes::default();
    changes.install(&store);
    match store.delete_conversation_entry("proj", "main").unwrap() {
        ConversationEntryRemoval::RefusedLastConversation(refused) => {
            assert_eq!(refused.id, "main");
            assert!(refused.legacy, "补位主对话是存量裸通道");
        }
        other => panic!("expected RefusedLastConversation, got {other:?}"),
    }
    assert_eq!(changes.count(), 0);
    let raw = implicit.raw();
    assert!(
        !raw.contains("\"conversations\""),
        "拒绝不得把惰性补位物化: {raw}"
    );
    assert!(store.retired_channels_of("proj").is_empty());
}

/// 落盘失败：内存、磁盘、退役元数据都不变；不发钩子、不通知。
#[test]
fn persist_failure_leaves_memory_disk_and_retirement_untouched() {
    let doc = TempDoc::new("save-failure");
    let store = doc.store();
    store
        .upsert(session_with(
            vec![conv("main", "主对话", true), conv("docs", "文档线", false)],
            Some("docs"),
        ))
        .unwrap();

    // 让 save_locked 的临时文件路径变成一个目录：write 必失败。
    std::fs::create_dir_all(doc.path().with_extension("json.tmp")).expect("tmp dir");

    let changes = Changes::default();
    changes.install(&store);
    let deletes = DeletedLog::default();
    deletes.install(&store);

    let error = store
        .delete_conversation_entry("proj", "docs")
        .expect_err("save must fail");
    assert!(error.contains("写入"), "unexpected error: {error}");

    assert_eq!(deletes.count(), 0, "落盘失败不得发历史清理钩子");
    assert_eq!(changes.count(), 0, "落盘失败不得通知");

    let stored = store.get("proj").expect("memory session");
    assert_eq!(
        stored.conversations,
        vec![conv("main", "主对话", true), conv("docs", "文档线", false)],
        "失败不得改内存"
    );
    assert_eq!(stored.last_conversation.as_deref(), Some("docs"));

    let disk = WorkspaceStore::load(Some(doc.path()))
        .get("proj")
        .expect("disk");
    assert_eq!(disk.conversations.len(), 2, "失败不得改磁盘");
    assert_eq!(disk.last_conversation.as_deref(), Some("docs"));
    assert!(
        store.retired_channels_of("proj").is_empty(),
        "失败不得留下退役元数据"
    );
}

/// 被删对话的通道不得被新对话复用（自动 id 跳过退役通道；显式 id 拒绝）。
#[test]
fn deleted_channel_is_not_reused_by_new_conversation() {
    let doc = TempDoc::new("no-reuse-id");
    let store = doc.store();
    store
        .upsert(session_with(
            vec![conv("main", "主对话", true), conv("docs", "文档线", false)],
            Some("docs"),
        ))
        .unwrap();

    assert!(matches!(
        store.delete_conversation_entry("proj", "docs").unwrap(),
        ConversationEntryRemoval::Deleted(_)
    ));

    // 同名新对话：slug 撞上退役通道 → 自动改用 docs-2（通道不同）。
    let created = store
        .upsert_conversation("proj", conv("", "Docs", false))
        .expect("create conversation");
    assert_eq!(created.id, "docs-2", "退役通道的 id 不得被重新分配");
    assert!(!created.legacy);
    assert_eq!(channel_scope_id("proj", &created), "proj/docs-2");

    // 显式拿退役 id 建新对话 → 明确拒绝，且原状态不变。
    let error = store
        .upsert_conversation("proj", conv("docs", "Docs Again", false))
        .expect_err("retired id must be refused");
    assert!(error.contains("不能复用"), "{error}");
    assert_eq!(
        store.get("proj").unwrap().conversations,
        vec![conv("main", "主对话", true), conv("docs-2", "Docs", false)]
    );
    assert_eq!(
        WorkspaceStore::load(Some(doc.path()))
            .get("proj")
            .unwrap()
            .conversations
            .len(),
        2
    );
}

/// 删掉存量裸通道（legacy）后，裸通道退役：新对话必须走 `<ws>/<conv>`，
/// 否则它会落进被删对话的历史（`local:workspace:<ws>:<user>`）。
#[test]
fn deleting_legacy_entry_retires_bare_channel() {
    let doc = TempDoc::new("no-reuse-legacy");
    let store = doc.store();
    store
        .upsert(session_with(
            vec![conv("main", "主对话", true), conv("docs", "文档线", false)],
            Some("docs"),
        ))
        .unwrap();

    match store.delete_conversation_entry("proj", "main").unwrap() {
        ConversationEntryRemoval::Deleted(removed) => {
            assert!(removed.legacy, "被删的是存量裸通道");
        }
        other => panic!("expected Deleted, got {other:?}"),
    }
    assert_eq!(store.retired_channels_of("proj"), vec!["proj".to_string()]);

    // 即使输入谎报 legacy=true（旧面板的镜像逻辑），也不得再分到裸通道：
    // 剩余列表里没有 legacy 条目，旧实现会因此给出 legacy=true。
    let created = store
        .upsert_conversation("proj", conv("", "Ideas", true))
        .expect("create conversation");
    assert!(!created.legacy, "裸通道退役后新对话一律非 legacy");
    assert_eq!(channel_scope_id("proj", &created), "proj/ideas");
    assert_eq!(store.conversations_of("proj").len(), 2);
}

/// 退役元数据可缺省、可回滚：旧档（无该键）照常读；键只在删除发生后出现；
/// 重载后防复用仍然生效。
#[test]
fn retirement_metadata_is_optional_and_survives_reload() {
    let doc = TempDoc::new("metadata");
    // 旧档：没有 retired_channels 键，也没有任何新字段。
    let old = serde_json::json!({
        "active": null,
        "active_conversation": null,
        "sessions": [{
            "id": "proj",
            "name": "Proj",
            "directories": ["/srv/proj"],
            "conversations": [
                {"id": "main", "name": "主对话", "legacy": true},
                {"id": "docs", "name": "文档线"}
            ],
            "last_conversation": "docs"
        }]
    });
    std::fs::write(doc.path(), serde_json::to_string_pretty(&old).unwrap()).expect("write old doc");

    let store = WorkspaceStore::load(Some(doc.path()));
    assert_eq!(store.conversations_of("proj").len(), 2, "旧档照常读");
    assert!(store.retired_channels_of("proj").is_empty());

    assert!(matches!(
        store.delete_conversation_entry("proj", "docs").unwrap(),
        ConversationEntryRemoval::Deleted(_)
    ));
    let persisted = json_of(&doc.path());
    assert_eq!(
        persisted["retired_channels"]["proj"],
        serde_json::json!(["proj/docs"]),
        "删除后落盘退役元数据"
    );

    // 重载（进程重启）后仍不复用被删通道。
    let reloaded = WorkspaceStore::load(Some(doc.path()));
    assert_eq!(
        reloaded.retired_channels_of("proj"),
        vec!["proj/docs".to_string()]
    );
    let created = reloaded
        .upsert_conversation("proj", conv("", "Docs", false))
        .expect("create after reload");
    assert_eq!(created.id, "docs-2");
}

/// 元数据编辑可保留退役记录；陈旧全量快照不能重新引入退役通道。
#[test]
fn retirement_survives_panel_full_save() {
    let doc = TempDoc::new("panel-save");
    let store = doc.store();
    store
        .upsert(session_with(
            vec![conv("main", "主对话", true), conv("docs", "文档线", false)],
            Some("docs"),
        ))
        .unwrap();
    assert!(matches!(
        store.delete_conversation_entry("proj", "docs").unwrap(),
        ConversationEntryRemoval::Deleted(_)
    ));

    // 面板只改元数据（不带 conversations）：对话列表与退役元数据都保留。
    store
        .upsert(WorkspaceSessionInfo {
            id: "proj".into(),
            name: "Proj Renamed".into(),
            directories: vec!["/srv/proj2".into()],
            ..Default::default()
        })
        .unwrap();
    assert_eq!(store.conversations_of("proj").len(), 1);
    assert_eq!(
        store.retired_channels_of("proj"),
        vec!["proj/docs".to_string()]
    );

    // 陈旧面板快照不能恢复已退役的通道，内存和磁盘均应保持不变。
    let before = std::fs::read(doc.path()).unwrap();
    let error = store
        .upsert(session_with(
            vec![conv("main", "主对话", true), conv("docs", "文档线", false)],
            Some("docs"),
        ))
        .expect_err("陈旧快照不得恢复退役通道");
    assert!(error.contains("退役"), "{error}");
    assert_eq!(std::fs::read(doc.path()).unwrap(), before);
    assert_eq!(store.conversations_of("proj").len(), 1);
    assert_eq!(
        store.retired_channels_of("proj"),
        vec!["proj/docs".to_string()]
    );
}
