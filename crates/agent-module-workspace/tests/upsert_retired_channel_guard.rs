//! C3d：`WorkspaceStore::upsert` 的**退役通道原子防护**（直接 store 回归）。
//!
//! C3b 把退役检查放在 `commands.rs` 的 `save_session` 里：那是独立读锁，释放后
//! 才调 `store.upsert`——并发删除可以插在两者之间；工具 `create`（空 id）与任何
//! 直接 `store.upsert` 的调用方则完全绕过它。本文件不经过命令层，直接钉住
//! **存储层最终契约**（C3d）：
//!
//! 1. 直接 `upsert` 陈旧全量快照 → 退役通道的对话不能被写回来（整条拒绝、
//!    不写盘、不通知、内存不变）；
//! 2. `conversations: []`（metadata 编辑）仍按「未提供」继承既有列表，判定
//!    对继承后的最终列表做——元数据保存不受影响；
//! 3. 空 id 新建工作区：名称 slug 命中「拥有退役记录的旧工作区 id」时自动
//!    绕开（`proj` → `proj-2`），不继承旧身份/旧裸通道；
//! 4. 显式重用旧 id：最终列表会恢复**已退役的裸通道** → 拒绝；只带非 legacy
//!    对话（走 `<ws>/<conv>`）→ 允许（不是"一律拒绝显式重用"）；
//! 5. 历史遗留的多条 legacy 共用裸通道：删一条后裸通道退役，**仍存活的同 id
//!    同通道**条目可以继续保存（改名/元数据编辑），只有把被删的那条写回才是
//!    复活、才拒绝；
//! 6. 落盘失败（临时文件路径被占成目录）：内存、磁盘、钩子都不被污染。
//!
//! 全部使用进程私有临时文件（`echo-workspace-c3d-upsert-*`），不读不写真实
//! `echo-workspaces-*.json`，也不产生任何真实会话历史。

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use agent_module_workspace::store::{channel_scope_id, ConversationEntryRemoval, WorkspaceStore};
use agent_module_workspace::wire::{WorkspaceConversationInfo, WorkspaceSessionInfo};

/// 临时文档守卫：测试结束（含 panic）时删掉 json 与可能的 `.json.tmp`。
struct TempDoc {
    path: PathBuf,
}

impl TempDoc {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "echo-workspace-c3d-upsert-{}-{name}.json",
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

/// id 固定为 `proj` 的工作区（大多数用例的工作区）。
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

fn delete_entry(store: &WorkspaceStore, conv_id: &str) {
    match store.delete_conversation_entry("proj", conv_id) {
        Ok(ConversationEntryRemoval::Deleted(_)) => {}
        other => panic!("expected Deleted for {conv_id}, got {other:?}"),
    }
}

/// ① 直接 `upsert`（工具 / 任何绕过命令层的调用方）不能把退役通道的对话写回。
///
/// 场景与 C3b 命令层测试相同，但这里**不经过** `save_session` 的独立读锁检查：
/// 证明防护已经落在 `upsert` 自己的写锁里。
#[test]
fn direct_upsert_cannot_resurrect_retired_channel() {
    let doc = TempDoc::new("direct-resurrect");
    let store = doc.store();
    store
        .upsert(session_with(
            vec![conv("main", "主对话", true), conv("docs", "文档线", false)],
            Some("docs"),
        ))
        .unwrap();
    delete_entry(&store, "docs");
    assert_eq!(
        store.retired_channels_of("proj"),
        vec!["proj/docs".to_string()]
    );
    let after_delete = doc.raw();

    let changes = Changes::default();
    changes.install(&store);

    // 陈旧面板快照：整表里仍带着被删的 docs（同一通道、同一历史）。
    let error = store
        .upsert(session_with(
            vec![conv("main", "主对话", true), conv("docs", "文档线", false)],
            Some("docs"),
        ))
        .expect_err("直接 upsert 复用退役通道必须拒绝");
    assert!(error.contains("退役"), "unexpected error: {error}");
    assert!(error.contains("docs"), "unexpected error: {error}");

    assert_eq!(changes.count(), 0, "拒绝不得发变更通知");
    assert_eq!(
        store.get("proj").unwrap().conversations,
        vec![conv("main", "主对话", true)],
        "被删对话不得复活"
    );
    assert_eq!(
        store.get("proj").unwrap().last_conversation.as_deref(),
        Some("main")
    );
    assert_eq!(doc.raw(), after_delete, "拒绝不得写盘");
    assert_eq!(
        store.retired_channels_of("proj"),
        vec!["proj/docs".to_string()],
        "拒绝不得改退役元数据"
    );
}

/// ② 兼容 metadata 不带 conversations：删除退役后只改名称/目录仍然成功，
/// 判定看的是继承后的最终列表，而不是空载荷。
#[test]
fn metadata_edit_without_conversations_still_allowed_after_retirement() {
    let doc = TempDoc::new("metadata-edit");
    let store = doc.store();
    store
        .upsert(session_with(
            vec![conv("main", "主对话", true), conv("docs", "文档线", false)],
            Some("docs"),
        ))
        .unwrap();
    delete_entry(&store, "docs");

    let saved = store
        .upsert(WorkspaceSessionInfo {
            id: "proj".into(),
            name: "Proj Renamed".into(),
            description: "只改元数据".into(),
            directories: vec!["/srv/proj2".into()],
            conversations: Vec::new(),
            last_conversation: None,
        })
        .expect("metadata edit must pass");
    assert_eq!(saved.name, "Proj Renamed");
    assert_eq!(saved.directories[0].path(), "/srv/proj2");
    assert_eq!(
        saved.conversations,
        vec![conv("main", "主对话", true)],
        "空列表 = 未提供，不得清空对话"
    );
    assert_eq!(saved.last_conversation.as_deref(), Some("main"));
    assert_eq!(
        store.retired_channels_of("proj"),
        vec!["proj/docs".to_string()],
        "元数据保存不得丢退役记录"
    );
    assert_eq!(
        WorkspaceStore::load(Some(doc.path()))
            .get("proj")
            .unwrap()
            .name,
        "Proj Renamed"
    );
}

/// ③ 空 id 新建工作区：名称 slug 命中「已被整条删除、只剩退役记录的旧 id」时
/// 自动绕开，不继承旧工作区身份（旧实现只看存活会话，会直接复用 `proj`）。
#[test]
fn empty_id_creation_routes_around_retired_workspace_id() {
    let doc = TempDoc::new("auto-id");
    let store = doc.store();
    store
        .upsert(session_with(
            vec![conv("main", "主对话", true), conv("docs", "文档线", false)],
            Some("docs"),
        ))
        .unwrap();
    delete_entry(&store, "docs");
    assert!(store.delete("proj").unwrap(), "整条删除工作区");
    assert!(store.get("proj").is_none());
    assert_eq!(
        store.retired_channels_of("proj"),
        vec!["proj/docs".to_string()],
        "整条删除保留退役记录（id 不得被新工作区继承）"
    );

    // 工具 `create` / 面板新建：id 为空，名称仍是 Proj。
    let created = store
        .upsert(WorkspaceSessionInfo {
            id: String::new(),
            name: "Proj".into(),
            directories: vec!["/srv/new".into()],
            ..Default::default()
        })
        .expect("auto id creation");
    assert_eq!(created.id, "proj-2", "必须绕开拥有退役记录的旧 id");

    // 新工作区读取视图 = legacy 主对话；它的裸通道是 proj-2，不在旧退役表里。
    let view = store.conversations_of("proj-2");
    assert_eq!(view.len(), 1);
    assert_eq!(view[0].id, "main");
    assert!(view[0].legacy);
    assert_eq!(channel_scope_id("proj-2", &view[0]), "proj-2");
    assert!(store.retired_channels_of("proj-2").is_empty());

    // 旧 id 仍是「无会话、有退役记录」；重载后同样不复用。
    assert!(store.get("proj").is_none());
    let reloaded = WorkspaceStore::load(Some(doc.path()));
    assert_eq!(reloaded.snapshot().0[0].id, "proj-2");
    assert_eq!(
        reloaded.retired_channels_of("proj"),
        vec!["proj/docs".to_string()]
    );
}

/// ④ 显式重用旧工作区 id：会恢复退役裸通道 → 拒绝；只带非 legacy 对话
/// （走 `<ws>/<conv>`）→ 允许。
#[test]
fn explicit_reuse_rejected_only_when_restoring_retired_bare_channel() {
    let doc = TempDoc::new("explicit-reuse");
    let store = doc.store();
    store
        .upsert(session_with(
            vec![
                conv("main", "主对话", true),
                conv("docs", "文档线", false),
                conv("ideas", "想法", false),
            ],
            Some("ideas"),
        ))
        .unwrap();
    delete_entry(&store, "docs"); // 退役 proj/docs
    delete_entry(&store, "main"); // 退役裸通道 proj（仍剩 ideas，不是最后一条）
    assert_eq!(
        store.retired_channels_of("proj"),
        vec!["proj/docs".to_string(), "proj".to_string()]
    );
    assert!(store.delete("proj").unwrap());

    // 显式 id + 空 conversations：新建工作区的读取视图就是 legacy 主对话，
    // 会恢复已退役的裸通道 proj → 拒绝。
    let error = store
        .upsert(WorkspaceSessionInfo {
            id: "proj".into(),
            name: "Proj".into(),
            directories: vec!["/srv/proj".into()],
            ..Default::default()
        })
        .expect_err("显式重用不得恢复退役裸通道");
    assert!(error.contains("退役"), "unexpected error: {error}");
    assert!(store.get("proj").is_none(), "拒绝不得写入任何会话");

    // 显式 legacy 条目同样命中裸通道（legacy 通道 = 裸 ws）。
    let error = store
        .upsert(session_with(
            vec![conv("main", "主对话", true), conv("fresh", "新线", false)],
            Some("fresh"),
        ))
        .expect_err("显式 legacy 条目不得恢复退役裸通道");
    assert!(error.contains("退役"), "unexpected error: {error}");
    assert!(store.get("proj").is_none());

    // 但显式重用 + 只带非 legacy 对话（通道 proj/fresh）不恢复裸通道 → 允许。
    let reused = store
        .upsert(WorkspaceSessionInfo {
            id: "proj".into(),
            name: "Proj".into(),
            directories: vec!["/srv/proj".into()],
            conversations: vec![conv("fresh", "新线", false)],
            last_conversation: Some("fresh".into()),
            ..Default::default()
        })
        .expect("非 legacy 通道不是复活，应放行");
    assert_eq!(reused.id, "proj");
    let view = store.conversations_of("proj");
    assert_eq!(view, vec![conv("fresh", "新线", false)]);
    assert_eq!(channel_scope_id("proj", &view[0]), "proj/fresh");
}

/// ⑤ 历史遗留的「多条 legacy 共用裸通道」：删掉一条后裸通道退役，另一条
/// **同 id 同通道仍存活**，它的保存（元数据/改名）必须放行；把被删的那条
/// 写回来才是复活 → 拒绝。
#[test]
fn still_live_legacy_conversation_survives_peer_retirement() {
    let doc = TempDoc::new("live-legacy");
    let store = doc.store();
    store
        .upsert(session_with(
            vec![conv("main", "主对话", true), conv("backup", "备份", true)],
            Some("main"),
        ))
        .unwrap();
    delete_entry(&store, "main");
    assert_eq!(store.retired_channels_of("proj"), vec!["proj".to_string()]);

    // 元数据编辑（不带 conversations）：backup 仍存活，不得被退役规则拦住。
    store
        .upsert(WorkspaceSessionInfo {
            id: "proj".into(),
            name: "Proj Renamed".into(),
            directories: vec!["/srv/proj".into()],
            ..Default::default()
        })
        .expect("存活 legacy 的元数据保存应放行");

    // 显式整表重存 backup（同 id 同通道）→ 放行。
    let saved = store
        .upsert(session_with(
            vec![conv("backup", "备份（改名）", true)],
            Some("backup"),
        ))
        .expect("同 id 同通道的存活条目不是复活");
    assert_eq!(
        saved.conversations,
        vec![conv("backup", "备份（改名）", true)]
    );

    // 把已删的 main 写回来 → 拒绝，内存保持 backup。
    let error = store
        .upsert(session_with(
            vec![
                conv("main", "主对话", true),
                conv("backup", "备份（改名）", true),
            ],
            Some("main"),
        ))
        .expect_err("已删对话不得复活");
    assert!(error.contains("退役"), "unexpected error: {error}");
    assert_eq!(
        store.get("proj").unwrap().conversations,
        vec![conv("backup", "备份（改名）", true)]
    );
}

/// ⑥ 落盘失败（`.json.tmp` 被占成目录）：候选文档不提交，内存/磁盘/通知都不变。
#[test]
fn temp_file_failure_does_not_pollute_memory_disk_or_hooks() {
    let doc = TempDoc::new("save-failure");
    let store = doc.store();
    store
        .upsert(session_with(
            vec![conv("main", "主对话", true), conv("docs", "文档线", false)],
            Some("docs"),
        ))
        .unwrap();
    let before = doc.raw();
    std::fs::create_dir_all(doc.path().with_extension("json.tmp")).expect("tmp dir");

    let changes = Changes::default();
    changes.install(&store);

    // 更新已有会话：内存必须保持旧值（旧实现先改内存再落盘）。
    let error = store
        .upsert(session_with(
            vec![conv("main", "主对话", true)],
            Some("main"),
        ))
        .expect_err("save must fail");
    assert!(error.contains("写入"), "unexpected error: {error}");
    assert_eq!(changes.count(), 0, "落盘失败不得通知");
    let stored = store.get("proj").expect("memory session");
    assert_eq!(
        stored.conversations,
        vec![conv("main", "主对话", true), conv("docs", "文档线", false)],
        "失败不得改内存"
    );
    assert_eq!(stored.last_conversation.as_deref(), Some("docs"));
    assert_eq!(doc.raw(), before, "失败不得改磁盘");

    // 新建会话同样失败且不进入内存。
    let error = store
        .upsert(WorkspaceSessionInfo {
            id: "new".into(),
            name: "New".into(),
            ..Default::default()
        })
        .expect_err("save must fail");
    assert!(error.contains("写入"), "unexpected error: {error}");
    assert!(store.get("new").is_none(), "失败不得留下新会话");
    assert_eq!(store.snapshot().0.len(), 1);
    assert_eq!(doc.raw(), before, "失败不得改磁盘");
}

/// 边缘：`retired_channels` 里的空列表不算「拥有退役记录」，不触发空 id 绕开。
#[test]
fn empty_retired_list_does_not_route_around_workspace_id() {
    let doc = TempDoc::new("empty-retired");
    std::fs::write(
        doc.path(),
        serde_json::to_string_pretty(&serde_json::json!({
            "sessions": [],
            "retired_channels": {"proj": []}
        }))
        .unwrap(),
    )
    .expect("write doc");

    let store = WorkspaceStore::load(Some(doc.path()));
    let created = store
        .upsert(WorkspaceSessionInfo {
            id: String::new(),
            name: "Proj".into(),
            ..Default::default()
        })
        .expect("create");
    assert_eq!(created.id, "proj", "空退役列表 = 没有记录，不必绕开");
}

/// ⑦ 历史遗留（C3d 之前写入的档）里已恢复的**非 legacy** 条目：只要它仍活着
/// （同 id 同通道），保存必须放行——不能因为通道在退役表里就把现有对话锁死。
#[test]
fn historically_restored_live_conversation_stays_editable() {
    let doc = TempDoc::new("historical-restored");
    std::fs::write(
        doc.path(),
        serde_json::to_string_pretty(&serde_json::json!({
            "sessions": [{
                "id": "proj",
                "name": "Proj",
                "directories": ["/srv/proj"],
                "conversations": [
                    {"id": "main", "name": "主对话", "legacy": true},
                    {"id": "docs", "name": "文档线"}
                ],
                "last_conversation": "docs"
            }],
            "retired_channels": {"proj": ["proj/docs"]}
        }))
        .unwrap(),
    )
    .expect("write historical doc");
    let store = WorkspaceStore::load(Some(doc.path()));

    // 元数据编辑（不带 conversations）→ 放行，列表原样保留。
    store
        .upsert(WorkspaceSessionInfo {
            id: "proj".into(),
            name: "Proj Renamed".into(),
            directories: vec!["/srv/proj".into()],
            ..Default::default()
        })
        .expect("存活条目的元数据保存应放行");

    // 显式整表重存（docs 改名，通道不变）→ 放行。
    let saved = store
        .upsert(session_with(
            vec![
                conv("main", "主对话", true),
                conv("docs", "文档线（改名）", false),
            ],
            Some("docs"),
        ))
        .expect("同 id 同通道的存活条目不是复活");
    assert_eq!(saved.conversations[1].name, "文档线（改名）");
    assert_eq!(
        store.retired_channels_of("proj"),
        vec!["proj/docs".to_string()],
        "放行不得清退役记录"
    );
}

/// ⑧ 并发删除 vs 直接 upsert（C3b 竞态窗口回归）。
///
/// 旧结构里「检查退役」是独立读锁，释放后才 `upsert`：删除可以插在中间，
/// 让陈旧快照把已退役通道写回来。现在判定与写入在同一把写锁内，无论线程
/// 如何交错，终态都不允许出现「通道已退役、但对话又被写回」。
#[test]
fn concurrent_delete_and_stale_upsert_never_resurrect() {
    let doc = TempDoc::new("race");
    let store = Arc::new(doc.store());
    store
        .upsert(session_with(
            vec![conv("main", "主对话", true), conv("docs", "文档线", false)],
            Some("docs"),
        ))
        .unwrap();

    let writer = {
        let store = Arc::clone(&store);
        std::thread::spawn(move || {
            for _ in 0..500 {
                // 结果允许成功（删除前）或失败（删除后）；唯一禁止的是写回。
                let _ = store.upsert(session_with(
                    vec![conv("main", "主对话", true), conv("docs", "文档线", false)],
                    Some("docs"),
                ));
            }
        })
    };
    let deleter = {
        let store = Arc::clone(&store);
        std::thread::spawn(move || {
            std::thread::yield_now();
            match store.delete_conversation_entry("proj", "docs") {
                Ok(ConversationEntryRemoval::Deleted(_))
                | Ok(ConversationEntryRemoval::AlreadyAbsent) => {}
                other => panic!("unexpected delete outcome: {other:?}"),
            }
        })
    };
    writer.join().expect("writer thread");
    deleter.join().expect("deleter thread");

    assert_eq!(
        store.retired_channels_of("proj"),
        vec!["proj/docs".to_string()],
        "删除必须完成并退役"
    );
    let live = store.get("proj").expect("session");
    assert!(
        live.conversations.iter().all(|c| c.id != "docs"),
        "退役后不得再写回 docs（竞态复活）: {live:?}"
    );
    let disk = WorkspaceStore::load(Some(doc.path()))
        .get("proj")
        .expect("disk session");
    assert!(
        disk.conversations.iter().all(|c| c.id != "docs"),
        "磁盘同样不得复活: {disk:?}"
    );
}
