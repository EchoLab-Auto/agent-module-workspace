//! 工作区会话数据的按需预取（2026-10）。
//!
//! 契约：**同一份数据最多一次在飞**，已有新鲜数据时不打扰。
//! 三条判据的顺序（无 team → 本地新鲜 → 已有请求在飞）就是行为本身，
//! 任何一条写反都会退回"点开面板发两次请求 / 白挂一条加载态"。

import { describe, it, expect, beforeEach, vi } from 'vitest';

// mock 的 sendPending 必须**照生产语义**登记（先发、发成功才 track）——
// 否则 `isPending` 永远 false，"已有请求在飞就不再发"这条根本测不到。
vi.mock('@echo-agent/panel', async () => {
  const pending = await vi.importActual<typeof import('@echo-agent/panel')>('@echo-agent/panel');
  const sendCommand = vi.fn((_command?: unknown) => true);
  return {
    ...pending,
    sendCommand,
    sendPending: vi.fn((command: never, key: string, core?: string | null) => {
      if (!sendCommand(command)) return;
      pending.trackRequest(key, command, core ?? null);
    }),
  };
});

import { sendCommand, sendPending } from '@echo-agent/panel';
import { releasePending } from '@echo-agent/panel';
import { state } from '@echo-agent/panel';
import {
  WORKSPACE_SESSIONS_KEY,
  ensureWorkspaceSessions,
  workspaceSessionsFresh,
} from '../workspace-prefetch';

function requestsSent(): number {
  return vi
    .mocked(sendCommand)
    .mock.calls.filter(
      (c) => typeof c[0] === 'object' && 'RequestWorkspaceSessions' in (c[0] as object),
    ).length;
}

describe('工作区会话预取', () => {
  beforeEach(() => {
    vi.mocked(sendCommand).mockClear();
    vi.mocked(sendPending).mockClear();
    releasePending(WORKSPACE_SESSIONS_KEY);
    state.workspaceSessions = [];
    state.workspaceTeamId = null;
    state.workspaceCore = null;
  });

  it('没有 team 时不发（Core 会拒绝无 team_id 的会话类命令）', () => {
    expect(ensureWorkspaceSessions(null, null)).toBe(false);
    expect(requestsSent()).toBe(0);
  });

  it('本地已有本 agent 的新鲜数据时不发', () => {
    state.workspaceSessions = [{ id: 'core', name: '框架', directories: [] }];
    state.workspaceTeamId = 'EchoCode';
    state.workspaceCore = 'core-a';

    expect(workspaceSessionsFresh('EchoCode', 'core-a')).toBe(true);
    expect(ensureWorkspaceSessions('EchoCode', 'core-a')).toBe(false);
    expect(requestsSent()).toBe(0);
  });

  it('数据属于别的 agent / 别的 core 时不算新鲜，必须重发', () => {
    state.workspaceSessions = [{ id: 'core', name: '框架', directories: [] }];
    state.workspaceTeamId = 'Alice';
    state.workspaceCore = 'core-a';

    // 换 agent
    expect(workspaceSessionsFresh('EchoCode', 'core-a')).toBe(false);
    // 同 agent 换 core（多上游：同名 agent 在两个 core 上都有）
    state.workspaceTeamId = 'EchoCode';
    expect(workspaceSessionsFresh('EchoCode', 'core-b')).toBe(false);
  });

  it('已有同一条请求在飞时不再发第二次（预取 + 挂载不会各发一次）', () => {
    // 第一次：真的发
    expect(ensureWorkspaceSessions('EchoCode', null)).toBe(true);
    expect(requestsSent()).toBe(1);
    // 第二次（同一 tick 里另一个调用方）：跳过
    expect(ensureWorkspaceSessions('EchoCode', null)).toBe(false);
    expect(requestsSent()).toBe(1);
  });

  it('上一条请求销账后可以再次预取（响应失败/过期不影响下次打开）', () => {
    ensureWorkspaceSessions('EchoCode', null);
    expect(requestsSent()).toBe(1);
    releasePending(WORKSPACE_SESSIONS_KEY);
    // 数据仍未到达（例如 Core 离线），下次打开应能重新发
    expect(ensureWorkspaceSessions('EchoCode', null)).toBe(true);
    expect(requestsSent()).toBe(2);
  });
});
