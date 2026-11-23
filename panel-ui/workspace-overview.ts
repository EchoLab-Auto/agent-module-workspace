//! 工作区概览：模块私有方法 `workspace.overview` 在面板扩展里的投影 + 配对。
//!
//! ## 为什么这条通路值得单列
//!
//! 概览**不是**宿主协议里的一个业务事件：Core 没有 `RequestWorkspaceOverview`
//! 这种 `BackendCommand`，也不认识返回的 `workspaces` / `conversations`。
//! 面板发的是通用调用：
//!
//! ```text
//! {"InvokeModuleOp":{"module":"echo-agent.workspace",
//!                    "method":"workspace.overview",
//!                    "payload":{"team_id":"alix","request_id":"…"}}}
//! ```
//!
//! 模块把它作为 `ModuleInvokeResult { module, method, ok, data, error }` 回推。
//! 壳只搬运，语义全在模块与扩展之间。
//!
//! ## 配对为什么需要 `request_id`
//!
//! `ModuleInvokeResult` **只回显 `module` / `method`**——没有宿主级请求 id。
//! 同一个窗口并发两次概览（A 人格切 B 人格）时，仅凭 module+method 无法判断
//! 哪条回包属于哪次请求。因此模块把调用方给的 `request_id` 原样放进 `data`，
//! 本文件按它配对：
//!
//! 1. 每次请求生成唯一 id（`crypto.randomUUID`，降级为时间戳+计数）；
//! 2. 回包 `data.request_id` 命中 pending 才落账；迟到 / 别的窗口的回包丢弃；
//! 3. 回包若带 Core 信封注入的 `core`（多上游），必须与请求目标 core 一致；
//! 4. `data.team_id` 必须与请求 team 一致；
//! 5. **失败回包没有 `data`**（Core 对 `Err` 统一回 `data:null`），也就没有
//!    `request_id`。Core 把 `ModuleInvokeResult` **广播给所有 Panel 窗口**，
//!    「本窗口唯一 pending」不能证明这条失败属于本窗口（两个窗口各一条
//!    pending 时会同时错认同一条失败）。无 id 的回执因此一律不认领，统一按
//!    超时收敛，超时文案说明「未收到可匹配回执」。
//!
//! ## 不会长久挂起
//!
//! 每次请求都有 [`OVERVIEW_TIMEOUT_MS`] 计时器：超时把条目置为 `error` 并
//! 清掉 pending。迟到的成功回包因 pending 已删而被丢弃（下一次刷新会重新
//! 取），界面最多等一个超时窗口，不会永远转圈。无法配对的失败回执也走这条
//! 路径：超时文案明确说「未收到可匹配回执」，而不是猜一个失败原因。
//!
//! ## 只读语义
//!
//! 请求只带 `team_id`（+ 配对 id）；模块只读一次内存快照，不扫目录、不跑
//! git、不写盘。UI 只展示计数，不提供任何变更动作。

import { ref } from 'vue';
import { sendCommand } from '@echo-agent/panel';

/** 工作区模块 id（与 Rust `MODULE_ID` 同值）。 */
export const MODULE_ID = 'echo-agent.workspace';
/** 模块私有方法名（与 Rust `commands::OVERVIEW` 同值）。 */
export const OVERVIEW_METHOD = 'workspace.overview';
/** 回包丢失 / 模块未挂载时的收敛窗口。 */
export const OVERVIEW_TIMEOUT_MS = 8_000;
/** 同一 `(core, team)` 的成功快照在此窗口内不重复请求（watcher 抖动去重）。 */
export const OVERVIEW_FRESH_MS = 10_000;

/** 模块回包里的数据形状（只列本扩展消费的字段）。 */
export interface WorkspaceOverview {
  team_id: string;
  request_id?: string;
  workspaces: number;
  conversations: number;
  directories: number;
  remote_directories: number;
  active: string | null;
}

/** 一次请求 / 一份快照的展示态。 */
export interface OverviewEntry {
  status: 'loading' | 'ok' | 'error';
  /** 最近一次成功数据；加载 / 失败时保留（显示旧值 + 错误条）。 */
  data: WorkspaceOverview | null;
  error: string | null;
  /** 正在等待的请求 id（`loading` 时有效；收敛后清空）。 */
  requestId: string | null;
  /** 请求目标 core（配对时校验回包信封注入的 core）。 */
  core: string | null;
  teamId: string;
  /** 最近一次成功 / 发起时刻（ms）。 */
  requestedAt: number;
}

interface Pending {
  key: string;
  teamId: string;
  core: string | null;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
}

const entries = new Map<string, OverviewEntry>();
const pending = new Map<string, Pending>();
let counter = 0;

/** 结构版本号：`entries` 是普通 Map，组件依赖它驱动重算。 */
export const overviewRevision = ref(0);

function bump(): void {
  overviewRevision.value += 1;
}

function keyOf(core: string | null | undefined, teamId: string): string {
  return `${core ?? ''}\u0000${teamId}`;
}

function newRequestId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  counter += 1;
  return `ws-${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 请求一次概览。返回是否**真的发出**（`false` = 未连接 / 无法路由 / 命中
 * 去重，调用方无需特别处理）。
 *
 * @param teamId 必填的人格 id；空 = 不发（与 Core「无默认人格」一致）
 * @param core   目标 Core（多上游时必须显式指定；单上游可为 null）
 * @param force  忽略「刚成功过」的新鲜窗口（用户点刷新时用）；**不**绕过
 *               同键 pending 去重——已在飞的请求不重复发。
 */
export function requestOverview(
  teamId: string | null,
  core: string | null,
  force = false,
): boolean {
  if (!teamId) return false;
  const key = keyOf(core, teamId);
  const now = Date.now();
  const current = entries.get(key);

  // 同键去重：还在等待就复用这次请求；已过收敛窗口的僵尸 pending 先清掉。
  for (const [requestId, item] of pending) {
    if (item.key !== key) continue;
    if (now - item.startedAt < OVERVIEW_TIMEOUT_MS) return false;
    clearTimeout(item.timer);
    pending.delete(requestId);
  }
  // 刚成功过（同一 core/team）：watcher 抖动不重复打模块。手动刷新（force）
  // 必须穿透这层，否则用户点「刷新」看不到任何变化。
  if (!force && current && current.status === 'ok' && now - current.requestedAt < OVERVIEW_FRESH_MS) {
    return false;
  }

  const requestId = newRequestId();
  const entry: OverviewEntry = {
    status: 'loading',
    data: current?.data ?? null,
    error: null,
    requestId,
    core: core ?? null,
    teamId,
    requestedAt: now,
  };
  entries.set(key, entry);

  const sent = sendCommand(
    {
      InvokeModuleOp: {
        module: MODULE_ID,
        method: OVERVIEW_METHOD,
        payload: { team_id: teamId, request_id: requestId },
      },
    },
    core ?? undefined,
  );
  if (!sent) {
    // 多上游解析不出目标 / 未连接：明确失败，不登记 pending（否则只会等超时）。
    entry.status = 'error';
    entry.error = '无法路由到 Core（未连接，或尚未确定该人格所属运行区域）';
    entry.requestId = null;
    bump();
    return false;
  }

  const timer = setTimeout(() => {
    const item = pending.get(requestId);
    if (!item) return;
    pending.delete(requestId);
    const target = entries.get(item.key);
    if (!target || target.requestId !== requestId) return;
    target.status = 'error';
    target.error = '概览请求超时：未收到可匹配回执（模块未挂载 / 未声明方法，或回包丢失）';
    target.requestId = null;
    bump();
  }, OVERVIEW_TIMEOUT_MS);
  pending.set(requestId, { key, teamId, core: core ?? null, startedAt: now, timer });
  bump();
  return true;
}

function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

/**
 * 消费一条事件。返回 `true` = 这是本模块 `workspace.overview` 的回包（无论
 * 是否配对成功），调用方应拦下它、不再进入壳的通用 reducer；`false` = 与
 * 本能力无关的事件。
 */
export function consumeOverviewResult(event: unknown): boolean {
  const body = (event as {
    ModuleInvokeResult?: {
      module?: unknown;
      method?: unknown;
      ok?: unknown;
      data?: unknown;
      error?: unknown;
      core?: unknown;
    };
  } | null)?.ModuleInvokeResult;
  if (!body || body.module !== MODULE_ID || body.method !== OVERVIEW_METHOD) return false;

  const raw = (body.data ?? null) as Record<string, unknown> | null;
  const rawRequestId = raw && typeof raw.request_id === 'string' ? raw.request_id : null;

  // 失败回包（`data:null`）没有 request_id，无法证明它属于本窗口的哪次请求。
  // Core 把 ModuleInvokeResult 广播给所有 Panel 窗口：两个窗口各有一条 pending
  // 时会同时认领同一条失败，随后真正成功的那条还会因 pending 被销掉而丢失。
  // 因此无 id 的回执一律不认领，让每个请求按自己的超时收敛。
  if (!rawRequestId) return true; // 本模块的回执，但没有可配对的 id：拦下丢弃
  const item = pending.get(rawRequestId);
  if (!item) return true; // 迟到 / 别的窗口 / 已超时：丢弃
  const requestId = rawRequestId;

  // 多上游信封注入的 core：只有双方都已知才校验（单上游没有信封）。
  const envelopeCore = typeof body.core === 'string' && body.core ? body.core : null;
  if (envelopeCore && item.core && envelopeCore !== item.core) {
    // 不是发给这个 core 的请求：保留 pending，让它按自己的超时收敛。
    return true;
  }

  const entry = entries.get(item.key);
  if (entry && entry.requestId !== requestId) {
    // 条目已被更新的请求取代：旧回包不覆盖新状态，但仍要销掉这条 pending。
    clearTimeout(item.timer);
    pending.delete(requestId);
    return true;
  }

  clearTimeout(item.timer);
  pending.delete(requestId);
  if (!entry) return true;
  entry.requestId = null;

  if (body.ok === false) {
    entry.status = 'error';
    entry.error =
      typeof body.error === 'string' && body.error ? body.error : '概览调用失败（模块未给出原因）';
    bump();
    return true;
  }

  const teamId = raw && typeof raw.team_id === 'string' ? raw.team_id : null;
  if (teamId !== item.teamId) {
    entry.status = 'error';
    entry.error = '概览回包的 team_id 与请求不一致';
    bump();
    return true;
  }
  const workspaces = asCount(raw?.workspaces);
  const conversations = asCount(raw?.conversations);
  const directories = asCount(raw?.directories);
  const remote = asCount(raw?.remote_directories);
  const active =
    raw?.active === null || typeof raw?.active === 'string'
      ? (raw?.active as string | null)
      : undefined;
  if (
    workspaces === null ||
    conversations === null ||
    directories === null ||
    remote === null ||
    active === undefined
  ) {
    entry.status = 'error';
    entry.error = '概览回包字段不完整（模块版本可能较旧）';
    bump();
    return true;
  }
  entry.status = 'ok';
  entry.error = null;
  entry.requestedAt = Date.now();
  entry.data = {
    team_id: teamId,
    request_id: requestId,
    workspaces,
    conversations,
    directories,
    remote_directories: remote,
    active,
  };
  bump();
  return true;
}
/** 某 `(core, team)` 的展示态（未请求 / 已清理 → `null`）。 */
export function overviewFor(
  teamId: string | null,
  core: string | null,
): Readonly<OverviewEntry> | null {
  if (!teamId) return null;
  return entries.get(keyOf(core, teamId)) ?? null;
}

/**
 * 清空投影与所有 pending（断连 / 重连 = 新基线）。
 *
 * 必须清计时器：否则旧请求超时后会把新基线的条目改成 error。
 */
export function resetOverview(): void {
  for (const item of pending.values()) clearTimeout(item.timer);
  pending.clear();
  entries.clear();
  bump();
}
