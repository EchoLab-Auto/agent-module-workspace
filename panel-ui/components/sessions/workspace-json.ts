//! 工作区 JSON 的导入 / 编辑（2026-11）。
//!
//! ## 为什么要有
//!
//! 表单只能填名称 / 描述 / 目录三样，而一份工作区**真正落盘**的字段还包含
//! `conversations`（每个对话的 id / legacy / api_profile）与 `last_conversation`。
//! 迁移机器、复制一个既有项目、批量建多个工作区时，用户手上往往正好有一段
//! `echo-workspaces-<team>.json` 的原文——表单填不了，只能手工 repeat。
//!
//! 本模块是这条路径的**唯一**解析入口（纯函数，无 Vue / 无命令副作用），
//! 面板只负责把结果灌进表单或直接提交。
//!
//! ## 接受三种形态
//!
//! ```text
//! 1) 单份会话      { "name": "框架", "directories": ["/srv/core"] }
//! 2) 会话数组      [ {...}, {...} ]
//! 3) 整份落盘文档  { "active": "core", "active_conversation": "main",
//!                   "sessions": [ {...} ] }
//! ```
//!
//! 第 3 种是磁盘文件的原文——用户最可能的操作就是 `cat` 之后整段粘贴。
//! `active` / `active_conversation` 只作为提示返回：激活是**全局单一标记**，
//! 由 `ActivateWorkspaceSession` 命令控制，不随 `SaveWorkspaceSession` 落盘
//! （Core 的 upsert 也不看这两个字段）。
//!
//! ## 校验原则
//!
//! 报错必须能指到具体字段（`sessions[2].directories[1]: …`），因为用户是在
//! 手改 JSON——「格式错误」这种笼统提示等于让人逐行猜。所有校验都在**发命令
//! 之前**做完：Core 的 upsert 是全量替换，半条坏数据落盘比拒绝更难收拾。

import type {
  WorkspaceConversationInfo,
  WorkspaceDirectory,
  WorkspaceSessionInfo,
} from '@echo-agent/panel';

/** 每份工作区的目录上限（与 Core `store.rs::MAX_DIRECTORIES` 对齐）。 */
export const MAX_DIRECTORIES = 32;
/** 工作区 id 上限（超过这个长度的通道 id 没人能读）。 */
export const MAX_ID_LENGTH = 64;

export interface WorkspaceJsonOk {
  ok: true;
  sessions: WorkspaceSessionInfo[];
  /** 文档形态里的 `active`（不写盘，仅提示）。 */
  active: string | null;
  /** 文档形态里的 `active_conversation`（不写盘，仅提示）。 */
  activeConversation: string | null;
  /** 输入是整份文档（`{sessions:[…]}`）而非裸数组/单对象。 */
  document: boolean;
}

export interface WorkspaceJsonErr {
  ok: false;
  error: string;
}

export type WorkspaceJsonResult = WorkspaceJsonOk | WorkspaceJsonErr;

function fail(error: string): WorkspaceJsonErr {
  return { ok: false, error };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 工作区 id 不能破坏通道 id（`local:workspace:<ws>[/<conv>]:<user>`）。 */
function checkId(raw: string, where: string): string | null {
  const id = raw.trim();
  if (!id) return `${where}：id 不能为空字符串`;
  if (id.length > MAX_ID_LENGTH) return `${where}：id 超过 ${MAX_ID_LENGTH} 个字符`;
  if (/[/:\s]/.test(id)) return `${where}：id 不能含 "/"、":" 或空白（会破坏会话通道 id）`;
  return null;
}

type ItemResult<T> = { value: T } | { error: string };

function normalizeDirectory(raw: unknown, where: string): ItemResult<WorkspaceDirectory> {
  if (typeof raw === 'string') {
    const path = raw.trim();
    if (!path) return { error: `${where}：目录不能是空字符串` };
    return { value: path };
  }
  if (isPlainObject(raw)) {
    if (typeof raw.path !== 'string' || !raw.path.trim()) {
      return { error: `${where}：目录对象的 path 必须是非空字符串` };
    }
    const nodeRaw = raw.node;
    if (nodeRaw !== undefined && nodeRaw !== null && typeof nodeRaw !== 'string') {
      return { error: `${where}：node 必须是字符串` };
    }
    const node = typeof nodeRaw === 'string' ? nodeRaw.trim() : '';
    // node 为空 = 本机：收窄成纯字符串，与 Core 的「读旧写新」一致。
    if (!node) return { value: raw.path.trim() };
    return { value: { path: raw.path.trim(), node } };
  }
  return { error: `${where}：目录必须是字符串或 { "path": …, "node": … } 对象` };
}

function normalizeConversation(
  raw: unknown,
  where: string,
): ItemResult<WorkspaceConversationInfo> {
  if (!isPlainObject(raw)) {
    return { error: `${where}：对话必须是对象` };
  }
  if (typeof raw.name !== 'string' || !raw.name.trim()) {
    return { error: `${where}：name 必须是非空字符串` };
  }
  // id 必填：`SaveWorkspaceSession` 是**全量替换**，不像 Core 的
  // `upsert_conversation` 那样会为缺 id 的对话生成 slug——缺 id 会落进
  // 两条空 id 的对话，之后谁也点不开。
  if (typeof raw.id !== 'string' || !raw.id.trim()) {
    return { error: `${where}：id 必须是非空字符串（可用对话名的小写 slug）` };
  }
  const idError = checkId(raw.id, `${where}.id`);
  if (idError) return { error: idError };
  if (raw.legacy !== undefined && typeof raw.legacy !== 'boolean') {
    return { error: `${where}：legacy 必须是 true / false` };
  }
  const profile = raw.api_profile;
  if (profile !== undefined && profile !== null && typeof profile !== 'string') {
    return { error: `${where}：api_profile 必须是字符串或 null` };
  }
  const conv: WorkspaceConversationInfo = {
    id: raw.id.trim(),
    name: raw.name.trim(),
    legacy: raw.legacy === true,
  };
  const apiProfile = typeof profile === 'string' ? profile.trim() : '';
  if (apiProfile) conv.api_profile = apiProfile;
  return { value: conv };
}

function normalizeSession(raw: unknown, where: string): ItemResult<WorkspaceSessionInfo> {
  if (!isPlainObject(raw)) return { error: `${where}：必须是一个工作区对象` };

  if (typeof raw.name !== 'string' || !raw.name.trim()) {
    return { error: `${where}.name：必须是非空字符串` };
  }
  const name = raw.name.trim();

  let id = '';
  if (raw.id !== undefined && raw.id !== null) {
    if (typeof raw.id !== 'string') return { error: `${where}.id：必须是字符串` };
    // 空串 = 让 Core 依名称生成 slug（与表单新建一致）。
    if (raw.id.trim()) {
      const idError = checkId(raw.id, `${where}.id`);
      if (idError) return { error: idError };
      id = raw.id.trim();
    }
  }

  if (raw.description !== undefined && raw.description !== null && typeof raw.description !== 'string') {
    return { error: `${where}.description：必须是字符串` };
  }
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';

  const dirs: WorkspaceDirectory[] = [];
  if (raw.directories !== undefined && raw.directories !== null) {
    if (!Array.isArray(raw.directories)) {
      return { error: `${where}.directories：必须是数组（本机目录写成字符串，跨机写成 {path,node}）` };
    }
    for (let index = 0; index < raw.directories.length; index += 1) {
      const result = normalizeDirectory(raw.directories[index], `${where}.directories[${index}]`);
      if ('error' in result) return { error: result.error };
      const path = typeof result.value === 'string' ? result.value : result.value.path;
      const node = typeof result.value === 'string' ? null : (result.value.node ?? null);
      // 与 Core 一致：node + path 联合去重（同一目录写两遍没有意义）。
      const duplicate = dirs.some((entry) => {
        const entryPath = typeof entry === 'string' ? entry : entry.path;
        const entryNode = typeof entry === 'string' ? null : (entry.node ?? null);
        return entryPath === path && entryNode === node;
      });
      if (!duplicate) dirs.push(result.value);
    }
    if (dirs.length > MAX_DIRECTORIES) {
      return { error: `${where}.directories：最多 ${MAX_DIRECTORIES} 个目录（当前 ${dirs.length}）` };
    }
  }

  let conversations: WorkspaceConversationInfo[] | undefined;
  if (raw.conversations !== undefined && raw.conversations !== null) {
    if (!Array.isArray(raw.conversations)) {
      return { error: `${where}.conversations：必须是数组` };
    }
    const list: WorkspaceConversationInfo[] = [];
    for (let index = 0; index < raw.conversations.length; index += 1) {
      const result = normalizeConversation(
        raw.conversations[index],
        `${where}.conversations[${index}]`,
      );
      if ('error' in result) return { error: result.error };
      if (list.some((conv) => conv.id === result.value.id)) {
        return { error: `${where}.conversations[${index}].id：对话 id「${result.value.id}」重复` };
      }
      list.push(result.value);
    }
    if (list.length) conversations = list;
  }

  let lastConversation: string | undefined;
  if (raw.last_conversation !== undefined && raw.last_conversation !== null) {
    if (typeof raw.last_conversation !== 'string') {
      return { error: `${where}.last_conversation：必须是字符串或 null` };
    }
    const last = raw.last_conversation.trim();
    if (last) {
      if (conversations && !conversations.some((conv) => conv.id === last)) {
        return {
          error: `${where}.last_conversation：「${last}」不在 conversations 里（可选值：${conversations
            .map((conv) => conv.id)
            .join(' / ')}）`,
        };
      }
      lastConversation = last;
    }
  }

  const session: WorkspaceSessionInfo = {
    id,
    name,
    description,
    directories: dirs,
  };
  if (conversations) session.conversations = conversations;
  if (lastConversation) session.last_conversation = lastConversation;
  return { value: session };
}

/**
 * 解析用户粘贴的 JSON。三种形态见模块文档；任何校验失败都返回**第一条**
 * 错误（带字段路径）——一次报一条，改了再看下一条，比糊一屏更好定位。
 */
export function parseWorkspaceJson(raw: string): WorkspaceJsonResult {
  const text = raw.trim();
  if (!text) return fail('没有内容：请粘贴一份工作区 JSON');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(`不是合法 JSON：${message}`);
  }

  let entries: unknown[];
  let active: string | null = null;
  let activeConversation: string | null = null;
  let document = false;

  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (isPlainObject(parsed) && Array.isArray(parsed.sessions)) {
    document = true;
    entries = parsed.sessions;
    if (typeof parsed.active === 'string' && parsed.active.trim()) {
      active = parsed.active.trim();
    }
    if (typeof parsed.active_conversation === 'string' && parsed.active_conversation.trim()) {
      activeConversation = parsed.active_conversation.trim();
    }
  } else if (isPlainObject(parsed)) {
    entries = [parsed];
  } else {
    return fail('顶层必须是对象、数组，或含 sessions 数组的文档');
  }

  if (!entries.length) return fail('sessions 为空：没有可导入的工作区');

  const sessions: WorkspaceSessionInfo[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const where = document ? `sessions[${index}]` : entries.length > 1 ? `[${index}]` : '工作区';
    const result = normalizeSession(entries[index], where);
    if ('error' in result) return fail(result.error);
    sessions.push(result.value);
  }

  const seenIds = new Set<string>();
  for (const session of sessions) {
    if (!session.id) continue;
    if (seenIds.has(session.id)) return fail(`工作区 id「${session.id}」重复`);
    seenIds.add(session.id);
  }

  return { ok: true, sessions, active, activeConversation, document };
}

/**
 * 会话 → 规范 JSON 文本（编辑段的初始内容）。
 *
 * `directories` 保留 wire 形态：本机目录是字符串，跨机是 `{path,node}` ——
 * 与 Core 落盘一致，导回去语义不变（写成 `node://` 编辑串会把「带节点」和
 * 「路径里恰好有 node://」两种东西混起来）。
 *
 * `conversations` 为空时**省略**：Core 的 upsert 把空数组解释成「本次未提供」
 * 并保留原值，写个 `[]` 出来只会让人以为能清空对话列表。
 */
export function sessionToJson(session: WorkspaceSessionInfo): string {
  const directories = (session.directories ?? []).map((entry) => {
    if (typeof entry === 'string') return entry;
    return entry.node ? { path: entry.path, node: entry.node } : entry.path;
  });
  const doc: Record<string, unknown> = {
    id: session.id,
    name: session.name,
    description: session.description ?? '',
    directories,
  };
  if (session.conversations?.length) doc.conversations = session.conversations;
  if (session.last_conversation) doc.last_conversation = session.last_conversation;
  return JSON.stringify(doc, null, 2);
}
