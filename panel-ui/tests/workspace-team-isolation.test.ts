//! 跨 team 广播隔离（2026-10 多窗口 / 多智能体审计）。
//!
//! 背景：Core 的 workspace store 是 **per-persona**（每个 agent 一份），
//! `WorkspaceSessions` 广播经进程级 EventSink 发给**所有** Panel 连接，且
//! 载荷带 `team_id`。而 Panel 侧的工作区状态是**单槽**（`workspace.sessions`
//! / `workspaceActive` / `workspaceTeamId` …）。
//!
//! 缺 team 过滤时的后果（本测试锁定的缺陷）：
//! - 窗口 A 在 t2、窗口 B 在 t1 → A 的任何工作区变更广播到 B，把 B 的单槽
//!   状态覆盖成 t2 的 → B 的 `workspaceTeamId !== activeTeamId`：
//!   · 文件浏览器卡门控失败（显示空态）
//!   · `localLanding` 退回默认本地会话（点会话时落点错）
//!   · `workspacePickIntent` 因 `synced=false` **每次都发激活** —— B 点一下
//!     工作区通道就把全局 `active` 抢走，反过来影响 A（跨窗口副作用）
//! - 同窗口切 agent 时，旧 agent 的迟到响应/广播同样会覆盖新 agent 的快照。
//!
//! 修复：reducer 只接受 `team_id` 与当前 `activeTeamId` 一致的快照（`team_id`
//! 为 null 的旧 Core 帧仍放行；`activeTeamId` 未定时不猜、放行等待校正）。

import { describe, it, expect, beforeEach } from 'vitest';
import { initialState, state as live } from '@echo-agent/panel';
import type { AppState } from '@echo-agent/panel';
import type { WorkspaceSessionInfo } from '@echo-agent/panel';
import { consumeEvent, workspace } from '../workspace-store';

const wsT1: WorkspaceSessionInfo = {
  id: 'alpha',
  name: 'Alpha 项目',
  conversations: [{ id: 'main', name: '主线', legacy: true }],
} as WorkspaceSessionInfo;

const wsT2: WorkspaceSessionInfo = {
  id: 'beta',
  name: 'Beta 项目',
  conversations: [{ id: 'main', name: '主线', legacy: true }],
} as WorkspaceSessionInfo;

/**
 * 测试口径：这些过滤逻辑现在住在**模块自己的扩展**里（壳不再有工作区字段），
 * 所以断言对象是 `workspace`（模块投影）+ 壳的通用身份 `live.activeTeamId` /
 * `live.activeRegion`。行为与迁移前逐条等价——这正是本文件要守的东西。
 */
function base(): AppState {
  const s = initialState();
  s.activeTeamId = 't1';
  s.activeRegion = null;
  // 投影回到干净状态（模块级单例）。
  workspace.teamId = null;
  workspace.core = null;
  workspace.sessions = [];
  workspace.active = null;
  workspace.activeConversation = null;
  workspace.generation = 0;
  Object.assign(live, { activeTeamId: s.activeTeamId, activeRegion: s.activeRegion });
  return s;
}

/** 造一条 WorkspaceSessions 事件（形状与 Core 一致）。 */
function ev(team_id: string | null, sessions: WorkspaceSessionInfo[], active: string | null) {
  return { WorkspaceSessions: { team_id, sessions, active, active_conversation: null } } as never;
}

describe('WorkspaceSessions 跨 team 隔离', () => {
  let s: AppState;
  beforeEach(() => {
    s = base();
  });

  it('本 team 的快照正常落入单槽', () => {
    consumeEvent(ev('t1', [wsT1], 'alpha'));
    expect(workspace.teamId).toBe('t1');
    expect(workspace.sessions.map((w) => w.id)).toEqual(['alpha']);
    expect(workspace.active).toBe('alpha');
  });

  it('他 team 的广播被丢弃（不覆盖本 team 的单槽状态）', () => {
    consumeEvent(ev('t1', [wsT1], 'alpha'));
    // 另一窗口（或模型的 use 工具）在 t2 上激活了工作区 → 广播打到本窗口
    consumeEvent(ev('t2', [wsT2], 'beta'));
    // 单槽仍是 t1 的快照 —— 这是修复点
    expect(workspace.teamId).toBe('t1');
    expect(workspace.sessions.map((w) => w.id)).toEqual(['alpha']);
    expect(workspace.active).toBe('alpha');
  });

  it('切 agent 后，旧 agent 的迟到快照不污染新 agent', () => {
    consumeEvent(ev('t1', [wsT1], 'alpha'));
    live.activeTeamId = 't2'; // App 切 agent
    consumeEvent(ev('t2', [wsT2], 'beta')); // 新 agent 的快照到达并生效
    expect(workspace.teamId).toBe('t2');
    // t1 的迟到广播（请求在切换前发出）此时才到 → 必须丢弃
    consumeEvent(ev('t1', [wsT1], 'alpha'));
    expect(workspace.teamId).toBe('t2');
    expect(workspace.sessions.map((w) => w.id)).toEqual(['beta']);
    expect(workspace.active).toBe('beta');
  });

  it('旧 Core 帧 team_id = null 仍放行（兼容）', () => {
    consumeEvent(ev(null, [wsT1], 'alpha'));
    expect(workspace.sessions.map((w) => w.id)).toEqual(['alpha']);
  });

  it('activeTeamId 未定时不猜、放行（等 TeamsList 校正后 App 会重拉）', () => {
    live.activeTeamId = null;
    consumeEvent(ev('t9', [wsT1], 'alpha'));
    expect(workspace.teamId).toBe('t9');
  });

  it('跨 core 的旧过滤仍生效（core 不匹配直接丢弃）', () => {
    live.activeRegion = 'coreA';
    consumeEvent({ WorkspaceSessions: { team_id: 't1', sessions: [wsT1], active: 'alpha', core: 'coreB' } } as never);
    expect(workspace.sessions).toEqual([]);
  });
});
