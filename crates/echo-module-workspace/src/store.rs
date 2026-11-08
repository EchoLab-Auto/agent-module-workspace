//! 工作区会话存储（每个 persona 一份 JSON，原子写）。
//!
//! 本模块是从 Core 内置模块原样搬出来的**业务核心**：会话 / 对话的增删改查、
//! 激活标记、通道 id 派生、持久化。它与宿主的唯一联系是 [`ChangeHook`]——
//! 变更成功后触发一次，由模块装配层接成「向宿主发事件」（见 `lib.rs`）。
//!
//! 与 Core 版本的区别只有一处：不再依赖 `echo-protocol` 的类型，改用
//! [`crate::wire`] 的线镜像（见该模块文档：包级循环依赖所致）。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, RwLock, Weak};

use crate::wire::{WorkspaceConversationInfo, WorkspaceSessionInfo};

/// Cap on directories per session (protects the prompt/tool output size).
pub const MAX_DIRECTORIES: usize = 32;

/// 持久化文档：会话列表 + 唯一的激活标记。
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub(crate) struct WorkspaceDocument {
    #[serde(default)]
    pub(crate) active: Option<String>,
    /// 当前激活对话 id（`active` 仍为工作区 id）。
    #[serde(default)]
    pub(crate) active_conversation: Option<String>,
    #[serde(default)]
    pub(crate) sessions: Vec<WorkspaceSessionInfo>,
}

/// 变更通知钩子：store 每次成功变更（新建/重命名/删除/激活）后触发一次。
///
/// 组合根（本仓 `lib.rs`）在装配期注入——「变更 → 广播」的唯一入口
/// （面板命令与模型 `use` 工具共用同一条广播路径）。
pub type ChangeHook = std::sync::Arc<dyn Fn() + Send + Sync + 'static>;

/// 对话删除钩子：删除成功后触发，参数 = (工作区 id, 被删对话)。
///
/// 宿主据此清空该对话的通道历史（事件日志 / 投影 / 时间线）。模块不认识
/// "通道历史"这件事，只负责把事实通知出去。
pub type ConversationDeleteHook =
    std::sync::Arc<dyn Fn(&str, &WorkspaceConversationInfo) + Send + Sync + 'static>;

/// Per-persona workspace store. All mutations persist atomically.
pub struct WorkspaceStore {
    doc: RwLock<WorkspaceDocument>,
    persist: Option<PathBuf>,
    /// 变更钩子**按注册方分槽**（key = 注册方自报的身份，见
    /// [`Self::upsert_on_change`]）。
    ///
    /// 为什么不是单个 `Option`：同一个文档可能被**多个模块实例**持有
    /// （每个 persona 一个模块实例，而 `store(team_id)` 对任意 team 都合法
    /// ——`all_stores` / 跨人格目录选择器就是跨 team 访问）。共享同一个
    /// `Arc<WorkspaceStore>` 之后，若钩子仍是单槽，后注册的实例会把前面的
    /// 顶掉，被顶掉那层就再也不会广播 `workspace.changed`（面板停在旧快照，
    /// 正是 2026-11 "会话 API 刷新后不保留"的现场）。分槽后各注册方都收得到。
    on_change: RwLock<Vec<(u64, ChangeHook)>>,
    on_conversation_deleted: RwLock<Vec<(u64, ConversationDeleteHook)>>,
}

impl std::fmt::Debug for WorkspaceStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let (sessions, active) = self.snapshot();
        f.debug_struct("WorkspaceStore")
            .field("sessions", &sessions.len())
            .field("active", &active)
            .field("persist", &self.persist)
            .finish()
    }
}

impl Default for WorkspaceStore {
    fn default() -> Self {
        Self {
            doc: RwLock::new(WorkspaceDocument::default()),
            persist: None,
            on_change: RwLock::new(Vec::new()),
            on_conversation_deleted: RwLock::new(Vec::new()),
        }
    }
}

/// 进程级 store 注册表：**文档路径 → 唯一内存副本**（弱引用）。
///
/// 为什么在 `store` 这一层做，而不是在模块实例里做：workspace 文档不是
/// 某个模块实例的私有物——`echo-workspaces-<team>.json` 属于那个 persona，
/// 而任何一层（任意人格的模块实例）都可能经由 `store(team_id)` 访问它
/// （跨人格目录选择器、`all_stores`、宿主 `dispatch_raw`）。缓存若挂在实例上，
/// 同一文件就有多份内存视图：
///
/// - 写命令改 A 副本 + 落盘；
/// - 读命令返回 B 副本的旧值。
///
/// 2026-11 用户报障就是这个：磁盘里 `api_profile` 已经是新值，广播里还是旧的
/// ——"改完刷新又回去了"。
///
/// 用 `Weak` 而不是 `Arc`：没有访问者时允许回收，回收后下次 `shared()` 重新
/// 读盘（磁盘是权威），不会留下永久驻留的缓存。
static STORES: OnceLock<Mutex<HashMap<PathBuf, Weak<WorkspaceStore>>>> = OnceLock::new();

/// 取某份文档的**进程内唯一** store（不存在或已被回收则读盘新建）。
pub fn shared(path: PathBuf) -> Arc<WorkspaceStore> {
    let registry = STORES.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(mut map) = registry.lock() {
        // 顺手清理已回收的条目，避免长跑进程里 key 无限增长（人格增删、测试）。
        map.retain(|_, weak| weak.strong_count() > 0);
        if let Some(existing) = map.get(&path).and_then(Weak::upgrade) {
            return existing;
        }
        let store = Arc::new(WorkspaceStore::load(Some(path.clone())));
        map.insert(path, Arc::downgrade(&store));
        return store;
    }
    // 锁中毒（持有者 panic）：退回"每层一份"的旧行为，绝不 panic 在热路径上。
    Arc::new(WorkspaceStore::load(Some(path)))
}

impl WorkspaceStore {
    /// Load a store from `persist` (missing/corrupt file → empty document;
    /// the file is rewritten on the next mutation).
    pub fn load(persist: Option<PathBuf>) -> Self {
        let doc = persist
            .as_deref()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .and_then(|raw| serde_json::from_str::<WorkspaceDocument>(&raw).ok())
            .unwrap_or_default();
        Self {
            doc: RwLock::new(doc),
            persist,
            on_change: RwLock::new(Vec::new()),
            on_conversation_deleted: RwLock::new(Vec::new()),
        }
    }

    /// 注册变更钩子（装配期注入一次；重复调用替换**同一个 key** 的旧钩子）。
    pub fn set_on_change(&self, hook: ChangeHook) {
        self.upsert_on_change(0, hook);
    }

    /// 按注册方身份注册/替换变更钩子（`key` 由注册方自己保证唯一）。
    ///
    /// 共享 store（同一文档被多个模块实例持有）时每个实例用自己的 key 注册，
    /// 彼此不会覆盖。同一 key 反复调用是幂等的——`ModuleState::store` 每次
    /// 命中缓存都会重注册，若不幂等，槽位会随调用次数增长。
    pub fn upsert_on_change(&self, key: u64, hook: ChangeHook) {
        if let Ok(mut slots) = self.on_change.write() {
            if let Some(slot) = slots.iter_mut().find(|(k, _)| *k == key) {
                slot.1 = hook;
            } else {
                slots.push((key, hook));
            }
        }
    }

    /// 注册对话删除钩子（装配期注入一次；用于清空被删对话的通道历史）。
    /// 钩子在 doc 锁释放后触发。
    pub fn set_on_conversation_deleted(&self, hook: ConversationDeleteHook) {
        self.upsert_on_conversation_deleted(0, hook);
    }

    /// 按注册方身份注册/替换对话删除钩子（语义同 [`Self::upsert_on_change`]）。
    pub fn upsert_on_conversation_deleted(&self, key: u64, hook: ConversationDeleteHook) {
        if let Ok(mut slots) = self.on_conversation_deleted.write() {
            if let Some(slot) = slots.iter_mut().find(|(k, _)| *k == key) {
                slot.1 = hook;
            } else {
                slots.push((key, hook));
            }
        }
    }

    /// 触发变更通知。必须在释放 `doc` 写锁**之后**调用（钩子会回读 store），
    /// 且钩子只做广播、不得再次修改 store（避免递归）。
    fn notify_change(&self) {
        let hooks: Vec<ChangeHook> = self
            .on_change
            .read()
            .map(|slots| slots.iter().map(|(_, hook)| hook.clone()).collect())
            .unwrap_or_default();
        for hook in hooks {
            hook();
        }
    }

    /// `(sessions, active)` snapshot.
    pub fn snapshot(&self) -> (Vec<WorkspaceSessionInfo>, Option<String>) {
        let doc = self.doc.read().unwrap_or_else(|e| e.into_inner());
        (doc.sessions.clone(), doc.active.clone())
    }

    /// One session by id.
    pub fn get(&self, id: &str) -> Option<WorkspaceSessionInfo> {
        let doc = self.doc.read().unwrap_or_else(|e| e.into_inner());
        doc.sessions.iter().find(|s| s.id == id).cloned()
    }

    /// The active session (if any).
    pub fn active(&self) -> Option<WorkspaceSessionInfo> {
        let doc = self.doc.read().unwrap_or_else(|e| e.into_inner());
        let id = doc.active.as_deref()?;
        doc.sessions.iter().find(|s| s.id == id).cloned()
    }

    /// Insert or update a session (upsert by id). Empty id → slugified name
    /// (deduplicated with a numeric suffix). Validation errors are returned
    /// as user-facing strings.
    pub fn upsert(
        &self,
        mut session: WorkspaceSessionInfo,
    ) -> Result<WorkspaceSessionInfo, String> {
        session.name = session.name.trim().to_string();
        if session.name.is_empty() {
            return Err("会话名称不能为空".into());
        }
        session.description = session.description.trim().to_string();
        // 规范化目录：去首尾空白/尾随斜杠；重复项去重（节点 + 路径联合判重）。
        // 允许暂时不存在的目录（项目可能还没克隆），存在性由 git 采集时呈现。
        let mut dirs: Vec<crate::wire::WorkspaceDirectory> = Vec::new();
        for raw in &session.directories {
            // 跨机工作区：目录字符串支持 `node://<peer>/<绝对路径>` 写法——
            // untagged 线格式下面板仍发纯字符串数组，在这里解析为远程目录。
            let (node, path_raw) = match raw.path().strip_prefix("node://") {
                Some(rest) => match rest.split_once('/') {
                    Some((p, r)) if !p.is_empty() => (
                        Some(p.to_string()),
                        format!("/{}", r.trim_start_matches('/')),
                    ),
                    _ => (None, raw.path().to_string()),
                },
                None => (raw.node().map(str::to_string), raw.path().to_string()),
            };
            let normalized = normalize_directory(&path_raw);
            if normalized.is_empty() {
                continue;
            }
            let entry = match node {
                Some(node) => crate::wire::WorkspaceDirectory::Qualified {
                    path: normalized,
                    node: Some(node),
                },
                None => crate::wire::WorkspaceDirectory::Local(normalized),
            };
            if dirs
                .iter()
                .any(|d| d.node() == entry.node() && d.path() == entry.path())
            {
                continue;
            }
            dirs.push(entry);
        }
        if dirs.len() > MAX_DIRECTORIES {
            return Err(format!("工作区目录最多 {MAX_DIRECTORIES} 个"));
        }
        session.directories = dirs;

        let result = {
            let mut doc = self.doc.write().unwrap_or_else(|e| e.into_inner());
            if session.id.trim().is_empty() {
                let base = slugify(&session.name);
                let mut candidate = base.clone();
                let mut n = 2;
                while doc.sessions.iter().any(|s| s.id == candidate) {
                    candidate = format!("{base}-{n}");
                    n += 1;
                }
                session.id = candidate;
            }
            match doc.sessions.iter_mut().find(|s| s.id == session.id) {
                Some(existing) => {
                    // 元数据编辑防护：面板编辑名称/目录时可能不携带
                    // conversations / last_conversation（协议 serde(default)
                    // = 空 / None），不能整条覆盖把它们清掉——否则该工作区的
                    // 全部对话入口丢失。空数组只解释为「本次未提供」。
                    if session.conversations.is_empty() {
                        session.conversations = existing.conversations.clone();
                        if session.last_conversation.is_none() && !session.conversations.is_empty()
                        {
                            session.last_conversation = existing.last_conversation.clone();
                        }
                    }
                    *existing = session.clone();
                }
                None => doc.sessions.push(session.clone()),
            }
            let result = session;
            self.save_locked(&doc)?;
            result
        };
        self.notify_change();
        Ok(result)
    }

    /// Delete a session; clears the active marker when it pointed at it.
    pub fn delete(&self, id: &str) -> Result<bool, String> {
        let removed = {
            let mut doc = self.doc.write().unwrap_or_else(|e| e.into_inner());
            let before = doc.sessions.len();
            doc.sessions.retain(|s| s.id != id);
            if doc.sessions.len() == before {
                false
            } else {
                if doc.active.as_deref() == Some(id) {
                    doc.active = None;
                }
                self.save_locked(&doc)?;
                true
            }
        };
        if removed {
            self.notify_change();
        }
        Ok(removed)
    }

    /// Activate a session (`None` clears the marker). The id must exist.
    ///
    /// `conversation` 指定工作区内的对话；`None` = 进入 `last_conversation`
    /// （无有效值时取首条；对话列表为空时物化存量主对话 `main`）。
    /// 激活即更新 `last_conversation`。
    pub fn set_active(
        &self,
        id: Option<String>,
        conversation: Option<String>,
    ) -> Result<(), String> {
        {
            let mut doc = self.doc.write().unwrap_or_else(|e| e.into_inner());
            match id {
                None => {
                    if conversation.is_some() {
                        return Err("指定对话时必须同时指定工作区".into());
                    }
                    doc.active = None;
                    doc.active_conversation = None;
                }
                Some(ref ws_id) => {
                    let Some(session) = doc.sessions.iter_mut().find(|s| &s.id == ws_id) else {
                        return Err(format!("工作区会话 {ws_id} 不存在"));
                    };
                    materialize_conversations(session);
                    let conv_id = match conversation {
                        Some(conv) => {
                            if !session.conversations.iter().any(|c| c.id == conv) {
                                return Err(format!("工作区 {ws_id} 不存在对话 {conv}"));
                            }
                            conv
                        }
                        None => session
                            .last_conversation
                            .as_deref()
                            .filter(|last| session.conversations.iter().any(|c| &c.id == last))
                            .unwrap_or(&session.conversations[0].id)
                            .to_string(),
                    };
                    session.last_conversation = Some(conv_id.clone());
                    doc.active = Some(ws_id.clone());
                    doc.active_conversation = Some(conv_id);
                }
            }
            self.save_locked(&doc)?;
        }
        self.notify_change();
        Ok(())
    }

    /// 当前激活的 `(工作区, 对话)`（读取期惰性补位：激活工作区但
    /// `active_conversation` 无效时回退首条对话 / 存量主对话）。
    pub fn active_pair(&self) -> Option<(WorkspaceSessionInfo, WorkspaceConversationInfo)> {
        let doc = self.doc.read().unwrap_or_else(|e| e.into_inner());
        let ws_id = doc.active.as_deref()?;
        let session = doc.sessions.iter().find(|s| s.id == ws_id)?;
        let convs = conversations_view(session);
        let conv = doc
            .active_conversation
            .as_deref()
            .and_then(|id| convs.iter().find(|c| c.id == id))
            .or_else(|| convs.first())?;
        Some((session.clone(), conv.clone()))
    }

    /// 某工作区的对话列表（读取视图：空列表 = 存量主对话惰性补位，
    /// 不落盘）。
    pub fn conversations_of(&self, ws_id: &str) -> Vec<WorkspaceConversationInfo> {
        let doc = self.doc.read().unwrap_or_else(|e| e.into_inner());
        match doc.sessions.iter().find(|s| s.id == ws_id) {
            Some(session) => conversations_view(session),
            None => Vec::new(),
        }
    }

    /// 新建/重命名一条对话（`conv.id` 空 = 依名称生成 slug，工作区内去重；
    /// 既有 id = 重命名，`legacy` 以既有条目为准——不可由输入伪造）。
    pub fn upsert_conversation(
        &self,
        ws_id: &str,
        mut conv: WorkspaceConversationInfo,
    ) -> Result<WorkspaceConversationInfo, String> {
        conv.name = conv.name.trim().to_string();
        if conv.name.is_empty() {
            return Err("对话名称不能为空".into());
        }
        let result = {
            let mut doc = self.doc.write().unwrap_or_else(|e| e.into_inner());
            let Some(session) = doc.sessions.iter_mut().find(|s| s.id == ws_id) else {
                return Err(format!("工作区会话 {ws_id} 不存在"));
            };
            materialize_conversations(session);
            match session.conversations.iter_mut().find(|c| c.id == conv.id) {
                Some(existing) => {
                    existing.name = conv.name.clone();
                    conv.legacy = existing.legacy;
                }
                None => {
                    if conv.id.trim().is_empty() {
                        let base = slugify_conv(&conv.name);
                        let mut candidate = base.clone();
                        let mut n = 2;
                        while session.conversations.iter().any(|c| c.id == candidate) {
                            candidate = format!("{base}-{n}");
                            n += 1;
                        }
                        conv.id = candidate;
                    } else if session.conversations.iter().any(|c| c.id == conv.id) {
                        return Err(format!("对话 id {} 已存在", conv.id));
                    }
                    // 存量裸通道 id（legacy）每工作区至多一条：列表中已有
                    // legacy 对话时新对话一律走 `<ws>/<conv>` 格式。
                    conv.legacy = !session.conversations.iter().any(|c| c.legacy);
                    session.conversations.push(conv.clone());
                }
            }
            self.save_locked(&doc)?;
            conv
        };
        self.notify_change();
        Ok(result)
    }

    /// 删除一条对话；返回被删对话（含 `legacy`，调用方据此定位通道并清空
    /// 其历史）。删除当前激活对话时切换到同工作区其余对话。
    pub fn delete_conversation(
        &self,
        ws_id: &str,
        conv_id: &str,
    ) -> Result<Option<WorkspaceConversationInfo>, String> {
        let removed = {
            let mut doc = self.doc.write().unwrap_or_else(|e| e.into_inner());
            let was_active = doc.active.as_deref() == Some(ws_id)
                && doc.active_conversation.as_deref() == Some(conv_id);
            let Some(session) = doc.sessions.iter_mut().find(|s| s.id == ws_id) else {
                return Err(format!("工作区会话 {ws_id} 不存在"));
            };
            materialize_conversations(session);
            match session
                .conversations
                .iter()
                .find(|c| c.id == conv_id)
                .cloned()
            {
                None => None,
                Some(removed_conv) => {
                    session.conversations.retain(|c| c.id != conv_id);
                    if session.last_conversation.as_deref() == Some(conv_id) {
                        session.last_conversation =
                            session.conversations.first().map(|c| c.id.clone());
                    }
                    if was_active {
                        doc.active_conversation =
                            session.conversations.first().map(|c| c.id.clone());
                    }
                    self.save_locked(&doc)?;
                    Some(removed_conv)
                }
            }
        };
        if let Some(ref conv) = removed {
            let hooks: Vec<ConversationDeleteHook> = self
                .on_conversation_deleted
                .read()
                .map(|slots| slots.iter().map(|(_, hook)| hook.clone()).collect())
                .unwrap_or_default();
            for hook in hooks {
                hook(ws_id, conv);
            }
        }
        if removed.is_some() {
            self.notify_change();
        }
        Ok(removed)
    }

    /// System-prompt text for the **active** workspace (`None` = nothing to inject).
    ///
    /// ⚠️ 这是 **per-persona 全局** active——与"本次 turn 是哪个会话"无关。
    /// 多窗口场景下必须用 [`Self::prompt_text_for`]（按会话解析）。
    pub fn prompt_text(&self) -> Option<String> {
        let (session, conv) = self.active_pair()?;
        Some(crate::prompt::render_prompt_text(&session, &conv))
    }

    /// System-prompt text for the workspace **owning `session_id`**
    /// （`None` = 该会话不是工作区通道，调用方决定回退策略）。
    ///
    /// 2026-10 多窗口修复：工作区上下文必须按**本次 turn 的会话**解析，不能
    /// 读全局 active。`local:workspace:<ws>[/<conv>]:<user>` → 取该工作区 +
    /// 该对话；非通道会话 → `None`。
    pub fn prompt_text_for(&self, session_id: &str) -> Option<String> {
        let (ws_id, conv_id) = parse_workspace_channel(session_id)?;
        let session = self.get(&ws_id)?;
        let convs = conversations_view(&session);
        let conv = match conv_id {
            Some(id) => convs.into_iter().find(|c| c.id == id)?,
            None => convs.into_iter().find(|c| c.legacy)?,
        };
        Some(crate::prompt::render_prompt_text(&session, &conv))
    }

    /// API profile 改名传播：把全部工作区对话里 `api_profile == from` 的引用
    /// 改写为 `to`（`None` = 清空引用，供删除语义复用）。一次 doc 锁内改完、
    /// 只写一次盘；返回改写条数（0 = 无引用，不触发变更通知）。
    pub fn rename_api_profile(&self, from: &str, to: Option<&str>) -> Result<usize, String> {
        let changed = {
            let mut doc = self.doc.write().unwrap_or_else(|e| e.into_inner());
            let mut changed = 0usize;
            for session in doc.sessions.iter_mut() {
                for conv in session.conversations.iter_mut() {
                    if conv.api_profile.as_deref() == Some(from) {
                        conv.api_profile = to.map(str::to_string);
                        changed += 1;
                    }
                }
            }
            if changed > 0 {
                self.save_locked(&doc)?;
            }
            changed
        };
        if changed > 0 {
            self.notify_change();
        }
        Ok(changed)
    }

    /// 显式对话定位的覆盖写入（见 [`Self::set_conversation_api_profile`]）。
    pub fn set_conversation_api_profile(
        &self,
        ws_id: &str,
        conv_id: &str,
        profile: Option<&str>,
    ) -> Result<bool, String> {
        self.update_conversation_api_profile(ws_id, Some(conv_id), profile)
    }

    /// 同上，但定位该工作区的 **legacy 对话**（存量裸通道，`legacy == true`）
    /// ——不依赖其 id 恰好为 `main`。
    pub fn set_legacy_conversation_api_profile(
        &self,
        ws_id: &str,
        profile: Option<&str>,
    ) -> Result<bool, String> {
        self.update_conversation_api_profile(ws_id, None, profile)
    }

    fn update_conversation_api_profile(
        &self,
        ws_id: &str,
        target: Option<&str>,
        profile: Option<&str>,
    ) -> Result<bool, String> {
        let profile = profile.filter(|p| !p.is_empty());
        let changed = {
            let mut doc = self.doc.write().unwrap_or_else(|e| e.into_inner());
            let Some(session) = doc.sessions.iter_mut().find(|s| s.id == ws_id) else {
                return Ok(false);
            };
            materialize_conversations(session);
            let Some(conv) = session.conversations.iter_mut().find(|c| match target {
                Some(id) => c.id == id,
                None => c.legacy,
            }) else {
                return Ok(false);
            };
            if conv.api_profile.as_deref() == profile {
                false
            } else {
                conv.api_profile = profile.map(str::to_string);
                self.save_locked(&doc)?;
                true
            }
        };
        if changed {
            self.notify_change();
        }
        Ok(true)
    }

    /// Atomic save (temp file + rename). No-op when no persist path is set.
    fn save_locked(&self, doc: &WorkspaceDocument) -> Result<(), String> {
        let Some(path) = self.persist.as_deref() else {
            return Ok(());
        };
        let raw =
            serde_json::to_string_pretty(doc).map_err(|e| format!("工作区会话序列化失败: {e}"))?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建 {} 失败: {e}", parent.display()))?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, raw.as_bytes())
            .map_err(|e| format!("写入 {} 失败: {e}", tmp.display()))?;
        std::fs::rename(&tmp, path).map_err(|e| format!("替换 {} 失败: {e}", path.display()))?;
        Ok(())
    }
}

/// Trim + strip trailing separators (`/`); keeps the path otherwise verbatim.
fn normalize_directory(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let mut end = trimmed.len();
    while end > 1 && trimmed[..end].ends_with('/') {
        end -= 1;
    }
    trimmed[..end].to_string()
}

/// 对话读取视图：空列表（旧档/新建工作区）惰性补位存量主对话——
/// `legacy: true` 表示其通道 id 为裸 ws 格式 `local:workspace:<ws>:<user>`
///（旧数据的历史挂在该 id 下，事件日志 append-only 不可改写）。
pub(crate) fn conversations_view(session: &WorkspaceSessionInfo) -> Vec<WorkspaceConversationInfo> {
    if session.conversations.is_empty() {
        vec![WorkspaceConversationInfo {
            id: "main".into(),
            name: "主对话".into(),
            legacy: true,
            api_profile: None,
        }]
    } else {
        session.conversations.clone()
    }
}

/// 写入路径物化：把读取视图的惰性主对话落进列表（之后随 doc 持久化）。
fn materialize_conversations(session: &mut WorkspaceSessionInfo) {
    if session.conversations.is_empty() {
        session.conversations = conversations_view(session);
    }
}

/// 对话通道的 `scope_id`：legacy 对话 = 裸 ws_id；其余 = `<ws_id>/<conv_id>`。
pub fn channel_scope_id(ws_id: &str, conv: &WorkspaceConversationInfo) -> String {
    if conv.legacy {
        ws_id.to_string()
    } else {
        format!("{ws_id}/{}", conv.id)
    }
}

/// 解析工作区通道的会话 id（`local:workspace:<ws>[/<conv>]:<user>`）。
///
/// 返回 `(ws_id, Some(conv_id))`（多对话通道）或 `(ws_id, None)`（legacy 裸
/// 通道）。非工作区会话（前缀不匹配）→ `None`。user 段允许 `@<account>`
/// 后缀（多实例维度），按最后一个 `:` 剥离。
pub fn parse_workspace_channel(session_id: &str) -> Option<(String, Option<String>)> {
    let rest = session_id.strip_prefix("local:workspace:")?;
    let channel = match rest.rsplit_once(':') {
        Some((channel, _user)) => channel,
        None => rest,
    };
    if channel.is_empty() {
        return None;
    }
    match channel.split_once('/') {
        Some((ws, conv)) if !ws.is_empty() && !conv.is_empty() => {
            Some((ws.to_string(), Some(conv.to_string())))
        }
        Some(_) => None, // `ws/` 或 `/conv`：形态非法，不猜测
        None => Some((channel.to_string(), None)),
    }
}

/// 对话 id slug（slugify 的 CJK 回退改为 `conv`）。
fn slugify_conv(name: &str) -> String {
    let slug = slugify(name);
    if slug == "ws" {
        "conv".into()
    } else {
        slug
    }
}

/// ASCII slug from a display name; CJK-only names fall back to `ws`.
fn slugify(name: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = true; // 不以下划线/短横开头
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            slug.push('-');
            last_dash = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    // 纯数字或空（CJK-only 名称）时回退 `ws`——id 尽量含字母，便于辨认。
    if slug.is_empty() || slug.chars().all(|ch| ch.is_ascii_digit()) {
        "ws".to_string()
    } else {
        slug
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::WorkspaceDirectory;

    fn temp_store(name: &str) -> (std::sync::Arc<WorkspaceStore>, PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "echo-workspace-module-test-{}-{name}.json",
            std::process::id()
        ));
        std::fs::remove_file(&path).ok();
        (
            std::sync::Arc::new(WorkspaceStore::load(Some(path.clone()))),
            path,
        )
    }

    #[test]
    fn upsert_generates_id_normalizes_and_persists() {
        let (store, path) = temp_store("upsert");
        let session = store
            .upsert(WorkspaceSessionInfo {
                id: String::new(),
                name: "My Project".into(),
                description: "  desc  ".into(),
                directories: vec![WorkspaceDirectory::local("/tmp/proj/"), "/tmp/proj".into()],
                ..Default::default()
            })
            .expect("upsert");
        assert_eq!(session.id, "my-project");
        assert_eq!(session.description, "desc");
        assert_eq!(session.directories.len(), 1, "重复目录去重");
        assert_eq!(session.directories[0].path(), "/tmp/proj");

        let reloaded = WorkspaceStore::load(Some(path.clone()));
        let (sessions, active) = reloaded.snapshot();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "my-project");
        assert!(active.is_none());
        std::fs::remove_file(&path).ok();
    }

    /// 元数据编辑防护：面板编辑名称/目录时不携带 conversations，
    /// upsert 不得整条覆盖清空对话。
    #[test]
    fn upsert_preserves_conversations_on_metadata_edit() {
        let (store, path) = temp_store("keep-convs");
        store
            .upsert(WorkspaceSessionInfo {
                id: "proj".into(),
                name: "Proj".into(),
                directories: vec!["/srv/a".into()],
                conversations: vec![
                    WorkspaceConversationInfo {
                        id: "main".into(),
                        name: "主对话".into(),
                        legacy: true,
                        api_profile: None,
                    },
                    WorkspaceConversationInfo {
                        id: "api".into(),
                        name: "API".into(),
                        legacy: false,
                        api_profile: Some("alpha".into()),
                    },
                ],
                last_conversation: Some("api".into()),
                ..Default::default()
            })
            .unwrap();

        let saved = store
            .upsert(WorkspaceSessionInfo {
                id: "proj".into(),
                name: "Proj".into(),
                directories: vec!["/srv/b".into()],
                conversations: vec![],
                last_conversation: None,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(saved.directories[0].path(), "/srv/b");
        assert_eq!(saved.conversations.len(), 2, "对话不被清空: {saved:?}");
        assert_eq!(saved.conversations[1].api_profile.as_deref(), Some("alpha"));
        assert_eq!(saved.last_conversation.as_deref(), Some("api"));
        std::fs::remove_file(&path).ok();
    }

    /// 激活/删除/多对话通道解析的完整往返。
    #[test]
    fn activation_and_conversation_lifecycle() {
        let (store, path) = temp_store("conv-active");
        store
            .upsert(WorkspaceSessionInfo {
                id: "proj".into(),
                name: "Proj".into(),
                ..Default::default()
            })
            .unwrap();
        let c2 = store
            .upsert_conversation(
                "proj",
                WorkspaceConversationInfo {
                    id: String::new(),
                    name: "支线".into(),
                    legacy: false,
                    api_profile: None,
                },
            )
            .unwrap();
        store.set_active(Some("proj".into()), None).unwrap();
        assert_eq!(store.active_pair().unwrap().1.id, "main");
        store
            .set_active(Some("proj".into()), Some(c2.id.clone()))
            .unwrap();
        assert_eq!(store.active_pair().unwrap().1.id, c2.id);
        assert_eq!(
            channel_scope_id("proj", &store.conversations_of("proj")[1]),
            format!("proj/{}", c2.id)
        );
        // 多对话通道 id 往返
        let parsed =
            parse_workspace_channel(&format!("local:workspace:proj/{}:local_user", c2.id)).unwrap();
        assert_eq!(parsed.0, "proj");
        assert_eq!(parsed.1.as_deref(), Some(c2.id.as_str()));
        // 删除激活对话 → 切回 main
        assert!(store.delete_conversation("proj", &c2.id).unwrap().is_some());
        assert_eq!(store.active_pair().unwrap().1.id, "main");
        std::fs::remove_file(&path).ok();
    }

    /// 变更钩子只在真实变更时触发，且可在钩子里回读 store（不死锁）。
    /// 2026-11 用户报障回归：同一份文档被**两个模块实例**持有（每个 persona
    /// 一个 workspace 模块实例，而 `store(team_id)` 对任意 team 都合法）。
    ///
    /// 修前：缓存按实例分 → 写命令改 A 的内存 + 落盘，读命令返回 B 的旧内存
    /// （表观症状："设置生效，刷新后回到旧值"，而磁盘其实是新值）。
    #[test]
    fn shared_returns_one_copy_per_document_path() {
        let dir = std::env::temp_dir().join(format!("echo-ws-shared-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("mkdir");
        let path = dir.join("echo-workspaces-team.json");

        let a = shared(path.clone());
        let b = shared(path.clone());
        assert!(
            Arc::ptr_eq(&a, &b),
            "同一文档路径必须映射到同一个 store 实例（否则读写走不同内存副本）"
        );

        // 写经 a、读经 b：必须看到同一份内存（不是磁盘回读，是同一个实例）
        a.upsert(crate::wire::WorkspaceSessionInfo {
            id: "ws".into(),
            name: "WS".into(),
            description: String::new(),
            directories: Vec::new(),
            conversations: Vec::new(),
            last_conversation: None,
        })
        .expect("upsert");
        let (sessions, _) = b.snapshot();
        assert_eq!(sessions.len(), 1, "另一份副本必须立刻看到写入");
        assert_eq!(sessions[0].id, "ws");

        // 不同路径 → 不同实例（不能串味）
        let other = shared(dir.join("echo-workspaces-other.json"));
        assert!(!Arc::ptr_eq(&a, &other));

        drop(a);
        drop(b);
        drop(other);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 共享 store 上的钩子必须**按注册方分槽**：后注册者不能顶掉前者
    /// （被顶掉那层再也收不到 `workspace.changed`，面板停在旧快照）。
    #[test]
    fn change_hooks_are_per_registrant() {
        let store = WorkspaceStore::default();
        let first = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let second = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        {
            let counter = first.clone();
            store.upsert_on_change(
                1,
                std::sync::Arc::new(move || {
                    counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }),
            );
        }
        {
            let counter = second.clone();
            store.upsert_on_change(
                2,
                std::sync::Arc::new(move || {
                    counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }),
            );
        }
        store
            .upsert(crate::wire::WorkspaceSessionInfo {
                id: "ws".into(),
                name: "WS".into(),
                description: String::new(),
                directories: Vec::new(),
                conversations: Vec::new(),
                last_conversation: None,
            })
            .expect("upsert");
        assert_eq!(first.load(std::sync::atomic::Ordering::SeqCst), 1, "先注册者必须仍被通知");
        assert_eq!(second.load(std::sync::atomic::Ordering::SeqCst), 1);

        // 同 key 重注册是幂等的（`ModuleState::store` 每次命中缓存都会重注册）
        let before = first.load(std::sync::atomic::Ordering::SeqCst);
        {
            let counter = first.clone();
            store.upsert_on_change(
                1,
                std::sync::Arc::new(move || {
                    counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }),
            );
        }
        store
            .upsert(crate::wire::WorkspaceSessionInfo {
                id: "ws2".into(),
                name: "WS2".into(),
                description: String::new(),
                directories: Vec::new(),
                conversations: Vec::new(),
                last_conversation: None,
            })
            .expect("upsert");
        // 只多触发一次（槽位没被复制成两份）
        assert_eq!(first.load(std::sync::atomic::Ordering::SeqCst), before + 1);
    }

    #[test]
    fn change_hook_fires_on_mutations_only() {
        let (store, path) = temp_store("hook");
        let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        {
            let hits = hits.clone();
            store.set_on_change(std::sync::Arc::new(move || {
                hits.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }));
        }
        store
            .upsert(WorkspaceSessionInfo {
                id: "p".into(),
                name: "P".into(),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1);
        let _ = store.snapshot();
        let _ = store.prompt_text();
        assert_eq!(
            hits.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "读不触发"
        );
        store.set_active(Some("p".into()), None).unwrap();
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 2);
        store.set_active(None, None).unwrap();
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 3);
        assert!(store.set_active(Some("nope".into()), None).is_err());
        assert_eq!(
            hits.load(std::sync::atomic::Ordering::SeqCst),
            3,
            "无效操作不触发"
        );
        std::fs::remove_file(&path).ok();
    }

    /// `node://` 字符串解析为远程目录，持久化后重载仍保留归属。
    #[test]
    fn upsert_parses_node_qualified_directories() {
        let (store, path) = temp_store("node-dirs");
        let session = store
            .upsert(WorkspaceSessionInfo {
                id: String::new(),
                name: "cross-machine".into(),
                directories: vec![
                    WorkspaceDirectory::local("/srv/local-repo"),
                    WorkspaceDirectory::from("node://gpu-box/srv/remote-repo"),
                ],
                ..Default::default()
            })
            .expect("upsert");
        assert_eq!(session.directories.len(), 2);
        assert_eq!(session.directories[1].node(), Some("gpu-box"));
        assert_eq!(session.directories[1].path(), "/srv/remote-repo");
        let reloaded = WorkspaceStore::load(Some(path.clone()));
        assert!(reloaded.snapshot().0[0].directories[1].is_remote());
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn parse_workspace_channel_covers_legacy_multi_and_non_workspace() {
        assert_eq!(
            parse_workspace_channel("local:workspace:ws1:local_user"),
            Some(("ws1".to_string(), None))
        );
        assert_eq!(
            parse_workspace_channel("local:workspace:ws1/docs:local_user@work"),
            Some(("ws1".to_string(), Some("docs".to_string())))
        );
        assert_eq!(parse_workspace_channel("local:tui::local_user"), None);
        assert_eq!(parse_workspace_channel("local:workspace:"), None);
    }
}
