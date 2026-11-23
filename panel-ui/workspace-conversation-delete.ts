//! 对话删除：模块私有写方法 `workspace.deleteConversation` 的面板 helper。
//!
//! 默认删除**只删入口**（C3b）：不再先发 `ClearHistory`，也不再退回
//! `SaveWorkspaceSession` 全量 upsert（那条路整表替换 `conversations`，陈旧
//! 快照能把刚删的对话写回来、落进被删对话的历史）。面板发的是通用调用：
//!
//! ```text
//! {"InvokeModuleOp":{"module":"echo-agent.workspace",
//!                    "method":"workspace.deleteConversation",
//!                    "payload":{"team_id":"t","workspace_id":"proj",
//!                               "conversation_id":"docs","request_id":"…"}}}
//! ```
//!
//! 模块把它作为 `ModuleInvokeResult { module, method, ok, data, error }` 回推。
//! 配对规则与概览（C4）共用同一套思路：
//!
//! 1. 每次请求生成唯一 `request_id`，模块原样回显在 `data.request_id`；
//! 2. 回包 `data.team_id` 必须与请求一致；信封注入的 `core` 双方都已知时必须
//!    一致（多上游）；
//! 3. **失败回包没有 `data`**（Core 对 `Err` 统一回 `data:null`），也就没有
//!    `request_id`。Core 把 `ModuleInvokeResult` **广播给所有 Panel 窗口**，
//!    「本窗口恰好一条 pending」不能证明这条失败属于本窗口（两个窗口各一条
//!    pending 时会同时错认同一条失败）；因此无 id 的回执一律不认领，统一按
//!    超时收敛，超时文案说明「未收到可匹配回执」；
//! 4. 每次请求都有 [`DELETE_TIMEOUT_MS`] 计时器：超时给出明确提示，不会永远
//!    转圈；迟到的回包因 pending 已删而被丢弃。
//!
//! ## 三种业务结果
//!
//! `deleted` / `already_absent` / `refused_last_conversation` 都是 `Ok` ——
//! 「最后一条不可删」是策略性拒绝而不是传输失败，面板据此给明确提示。真正的
//! 失败（缺参 / 落盘失败 / 工作区不存在）是 `ok:false`，但 Core 统一回
//! `data:null`，`error` 里的人读原因没有 `request_id`、无法安全归属到本窗口
//! 的请求（见上），所以面板最终以「未收到可匹配回执」的超时提示收敛。

import { ref } from 'vue';
import { sendCommand } from '@echo-agent/panel';

/** 工作区模块 id（与 Rust `MODULE_ID` 同值）。 */
export const MODULE_ID = 'echo-agent.workspace';
/** 模块私有方法名（与 Rust `commands::DELETE_CONVERSATION` 同值）。 */
export const DELETE_CONVERSATION_METHOD = 'workspace.deleteConversation';
/**
 * 回包收敛窗口。
 *
 * 比面板动作自身的 8s 超时**早 1s**：先拿到模块语义的明确文案（「未收到
 * 回执」），并立即 `finishAction()` 清掉那条通用的「操作超时」。反过来若
 * 组件计时器先到，用户看到的就只是笼统的「操作超时」。
 */
export const DELETE_TIMEOUT_MS = 7_000;

/** 模块回包的业务结果（都是 `ok:true`）。 */
export type ConversationDeleteOutcome =
  | 'deleted'
  | 'already_absent'
  | 'refused_last_conversation';

export type ConversationDeleteStatus = 'pending' | 'ok' | 'refused' | 'error';

/** 一次删除请求的展示态（按 `(core, team, workspace, conversation)` 存放）。 */
export interface ConversationDeleteEntry {
  status: ConversationDeleteStatus;
  /** 终态的业务结果（`pending` / `error` 时为 `null`）。 */
  outcome: ConversationDeleteOutcome | null;
  /** 人读提示（拒绝 / 失败 / 超时必填；成功也有一句）。 */
  message: string | null;
  /** 最近一次请求 id（保留到下一次请求覆盖：组件据此判断「这是我的回包」）。 */
  requestId: string;
  teamId: string;
  core: string | null;
  workspaceId: string;
  conversationId: string;
  startedAt: number;
}

interface Pending {
  key: string;
  teamId: string;
  core: string | null;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
}

const entries = new Map<string, ConversationDeleteEntry>();
const pending = new Map<string, Pending>();
/** 本窗口确认删除过的对话 id（按 `(core, team, workspace)`）：只用于新 id 避让。 */
const retired = new Map<string, Set<string>>();

let counter = 0;

/** 结构版本号：`entries` 是普通 Map，组件依赖它驱动重算。 */
export const conversationDeleteRevision = ref(0);

function bump(): void {
  conversationDeleteRevision.value += 1;
}

function scopeKey(core: string | null | undefined, teamId: string, workspaceId: string): string {
  return [core ?? '', teamId, workspaceId].join('\u0000');
}

function entryKey(
  core: string | null | undefined,
  teamId: string,
  workspaceId: string,
  conversationId: string,
): string {
  return `${scopeKey(core, teamId, workspaceId)}\u0000${conversationId}`;
}

function newRequestId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  counter += 1;
  return `ws-del-${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2, 10)}`;
}

function defaultMessage(outcome: ConversationDeleteOutcome): string {
  switch (outcome) {
    case 'deleted':
      return '已删除对话入口（聊天历史保留）';
    case 'already_absent':
      return '该对话已不在列表中（可能已在其他窗口删除）';
    case 'refused_last_conversation':
      return '最后一条对话不能删除：每个工作区至少保留一条（聊天历史保留）';
  }
}

/**
 * 请求删除一条对话入口。
 *
 * @returns 请求 id（用于组件配对）；`null` = 没有发出（未连接 / 无法路由），
 *          此时对应条目已是 `error` 态，调用方可直接读 `message` 提示。
 */
export function requestConversationDelete(
  teamId: string | null,
  core: string | null,
  workspaceId: string,
  conversationId: string,
): string | null {
  if (!teamId || !workspaceId || !conversationId) return null;
  const key = entryKey(core, teamId, workspaceId, conversationId);
  const now = Date.now();
  // 同键去重：还在等就复用这次请求；已过收敛窗口的僵尸 pending 先清掉。
  for (const [requestId, item] of pending) {
    if (item.key !== key) continue;
    if (now - item.startedAt < DELETE_TIMEOUT_MS) return requestId;
    clearTimeout(item.timer);
    pending.delete(requestId);
  }

  const requestId = newRequestId();
  const entry: ConversationDeleteEntry = {
    status: 'pending',
    outcome: null,
    message: null,
    requestId,
    teamId,
    core: core ?? null,
    workspaceId,
    conversationId,
    startedAt: now,
  };
  entries.set(key, entry);

  const sent = sendCommand(
    {
      InvokeModuleOp: {
        module: MODULE_ID,
        method: DELETE_CONVERSATION_METHOD,
        payload: {
          team_id: teamId,
          workspace_id: workspaceId,
          conversation_id: conversationId,
          request_id: requestId,
        },
      },
    },
    core ?? undefined,
  );
  if (!sent) {
    // 多上游解析不出目标 / 未连接：当场失败，不登记 pending（否则只会等超时）。
    entry.status = 'error';
    entry.message = '无法路由到 Core（未连接，或尚未确定该人格所属运行区域）';
    bump();
    return null;
  }

  const timer = setTimeout(() => {
    const item = pending.get(requestId);
    if (!item) return;
    pending.delete(requestId);
    const target = entries.get(item.key);
    if (!target || target.requestId !== requestId) return;
    target.status = 'error';
    target.message =
      '删除请求超时：未收到可匹配回执，列表可能未更新（聊天历史未被清除）。请刷新后重试。';
    bump();
  }, DELETE_TIMEOUT_MS);
  pending.set(requestId, { key, teamId, core: core ?? null, startedAt: now, timer });
  bump();
  return requestId;
}

/**
 * 消费一条事件。返回 `true` = 这是本模块 `workspace.deleteConversation` 的回包
 * （无论配对是否成功），调用方应拦下、不再进入壳的通用 reducer。
 */
export function consumeConversationDeleteResult(event: unknown): boolean {
  const body = (
    event as {
      ModuleInvokeResult?: {
        module?: unknown;
        method?: unknown;
        ok?: unknown;
        data?: unknown;
        error?: unknown;
        core?: unknown;
      };
    } | null
  )?.ModuleInvokeResult;
  if (!body || body.module !== MODULE_ID || body.method !== DELETE_CONVERSATION_METHOD) return false;

  const raw = (body.data ?? null) as Record<string, unknown> | null;
  const rawRequestId = raw && typeof raw.request_id === 'string' ? raw.request_id : null;
  // 失败回包（`data:null`）没有 request_id，无法证明它属于本窗口的哪次请求。
  // Core 把 ModuleInvokeResult 广播给所有 Panel 窗口：两个窗口各有一条 pending
  // 时会同时认领同一条失败，随后真正成功的那条还会因 pending 被销掉而丢失。
  // 因此无 id 的回执一律不认领，让每个请求按自己的超时收敛。
  if (!rawRequestId) return true; // 本模块的回执，但没有可配对的 id：拦下丢弃
  const requestId = rawRequestId;
  const item = pending.get(requestId);
  if (!item) return true; // 迟到 / 别的窗口 / 已超时：丢弃

  const envelopeCore = typeof body.core === 'string' && body.core ? body.core : null;
  if (envelopeCore && item.core && envelopeCore !== item.core) {
    // 不是发给这个 core 的回包：保留 pending，让它按自己的超时收敛。
    return true;
  }

  clearTimeout(item.timer);
  pending.delete(requestId);
  const entry = entries.get(item.key);
  // 已被更新的请求取代：旧回包不覆盖新状态。
  if (!entry || entry.requestId !== requestId) return true;

  if (body.ok === false) {
    entry.status = 'error';
    entry.message =
      typeof body.error === 'string' && body.error ? body.error : '删除失败（模块未给出原因）';
    bump();
    return true;
  }

  const teamId = raw && typeof raw.team_id === 'string' ? raw.team_id : null;
  if (teamId !== item.teamId) {
    entry.status = 'error';
    entry.message = '删除回包的 team_id 与请求不一致';
    bump();
    return true;
  }

  const result = raw?.result;
  if (
    result !== 'deleted' &&
    result !== 'already_absent' &&
    result !== 'refused_last_conversation'
  ) {
    entry.status = 'error';
    entry.message = '删除回包的 result 不完整（模块版本可能较旧）';
    bump();
    return true;
  }

  entry.outcome = result;
  entry.status = result === 'refused_last_conversation' ? 'refused' : 'ok';
  entry.message =
    typeof raw?.message === 'string' && raw.message ? raw.message : defaultMessage(result);
  if (result === 'deleted') {
    // 本窗口已知的删除：新建对话生成 id 时避让（后端也会拒绝复用已退役通道）。
    const key = scopeKey(entry.core, entry.teamId, entry.workspaceId);
    const ids = retired.get(key) ?? new Set<string>();
    ids.add(entry.conversationId);
    retired.set(key, ids);
  }
  bump();
  return true;
}

/** 某 `(team, core, workspace, conversation)` 的最近一次删除态（未请求 → `null`）。 */
export function conversationDeleteResult(
  teamId: string | null,
  core: string | null,
  workspaceId: string,
  conversationId: string,
): Readonly<ConversationDeleteEntry> | null {
  if (!teamId) return null;
  return entries.get(entryKey(core, teamId, workspaceId, conversationId)) ?? null;
}

/**
 * 本窗口确认删除过的对话 id。
 *
 * **只用于新建对话的 id 避让**（否则同名新建会拿回刚退役的 slug，保存被模块
 * 拒绝）。不要用它过滤保存载荷：静默丢条目比明确报错更糟。
 */
export function retiredConversationIds(
  teamId: string | null,
  core: string | null,
  workspaceId: string,
): string[] {
  if (!teamId) return [];
  return [...(retired.get(scopeKey(core, teamId, workspaceId)) ?? [])];
}

/** 清空投影与所有 pending（断连 / 重连 = 新基线，旧计时器不得改新状态）。 */
export function resetConversationDeletes(): void {
  for (const item of pending.values()) clearTimeout(item.timer);
  pending.clear();
  entries.clear();
  retired.clear();
  bump();
}
