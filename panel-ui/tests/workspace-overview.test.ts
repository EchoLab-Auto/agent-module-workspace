//! `workspace.overview` 面板侧契约：请求形状、request_id 配对、core/team 校验、
//! 超时收敛与迟到回包丢弃。
//!
//! 这些断言对应 C4 试点的**真实风险点**——`ModuleInvokeResult` 只回显
//! `module` / `method`，没有宿主级请求 id；失败回包更是 `data:null`。如果
//! 不做配对与超时，并发 / 切 agent / 模块未挂载都会表现为界面永久转圈，
//! 或者把 A 人格的计数显示到 B 人格上。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@echo-agent/panel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@echo-agent/panel')>();
  return {
    ...actual,
    sendCommand: vi.fn(() => true),
  };
});

import { sendCommand, serializeCommand } from '@echo-agent/panel';
import {
  MODULE_ID,
  OVERVIEW_FRESH_MS,
  OVERVIEW_METHOD,
  OVERVIEW_TIMEOUT_MS,
  consumeOverviewResult,
  overviewFor,
  requestOverview,
  resetOverview,
  type WorkspaceOverview,
} from '../workspace-overview';

type Command = {
  InvokeModuleOp: {
    module: string;
    method: string;
    payload: { team_id: string; request_id: string };
  };
};

function sent(): Command[] {
  return vi.mocked(sendCommand).mock.calls.map((call) => call[0] as Command);
}

function lastSent(): Command {
  const all = sent();
  return all[all.length - 1]!;
}

function lastRequestId(): string {
  return lastSent().InvokeModuleOp.payload.request_id;
}

function result(
  requestId: string | null,
  data: Partial<WorkspaceOverview> = {},
  extra: { ok?: boolean; error?: string; core?: string | null } = {},
): unknown {
  return {
    ModuleInvokeResult: {
      module: MODULE_ID,
      method: OVERVIEW_METHOD,
      ok: extra.ok ?? true,
      data:
        requestId === null
          ? null
          : {
              team_id: 't',
              request_id: requestId,
              workspaces: 2,
              conversations: 3,
              directories: 4,
              remote_directories: 1,
              active: 'proj',
              ...data,
            },
      error: extra.error,
      ...(extra.core !== undefined ? { core: extra.core } : {}),
    },
  };
}

beforeEach(() => {
  resetOverview();
  vi.mocked(sendCommand).mockClear();
  vi.mocked(sendCommand).mockReturnValue(true);
});

afterEach(() => {
  resetOverview();
  vi.useRealTimers();
});

describe('请求形状', () => {
  it('发通用调用通道：模块 id + 点分方法名 + 显式 team_id + request_id', () => {
    expect(requestOverview('alix', 'core-a')).toBe(true);
    const command = lastSent();
    expect(command.InvokeModuleOp.module).toBe(MODULE_ID);
    expect(command.InvokeModuleOp.method).toBe(OVERVIEW_METHOD);
    expect(command.InvokeModuleOp.payload.team_id).toBe('alix');
    expect(typeof command.InvokeModuleOp.payload.request_id).toBe('string');
    expect(command.InvokeModuleOp.payload.request_id.length).toBeGreaterThan(8);
    // 目标 core 必须显式传给 sendCommand（多上游路由；单上游为 undefined）。
    expect(vi.mocked(sendCommand).mock.calls[0]![1]).toBe('core-a');

    // 线协议能原样序列化：证明用的是 Core 已有的 `InvokeModuleOp` 变体。
    const wire = JSON.parse(serializeCommand(command));
    expect(wire.type).toBe('command');
    expect(wire.payload.InvokeModuleOp).toEqual(command.InvokeModuleOp);
  });

  it('没有人格 id 不发；无法路由（sendCommand=false）立即显式失败', () => {
    expect(requestOverview(null, 'core-a')).toBe(false);
    expect(sendCommand).not.toHaveBeenCalled();

    vi.mocked(sendCommand).mockReturnValueOnce(false);
    expect(requestOverview('alix', null)).toBe(false);
    const entry = overviewFor('alix', null);
    expect(entry?.status).toBe('error');
    expect(entry?.error).toContain('无法路由');
    expect(entry?.requestId).toBeNull();
  });
});

describe('配对', () => {
  it('按 request_id 落账；同一回包第二次到达被丢弃', () => {
    requestOverview('t', 'core-a');
    const id = lastRequestId();
    expect(consumeOverviewResult(result(id))).toBe(true);
    const entry = overviewFor('t', 'core-a');
    expect(entry?.status).toBe('ok');
    expect(entry?.data).toMatchObject({
      workspaces: 2,
      conversations: 3,
      directories: 4,
      remote_directories: 1,
      active: 'proj',
      team_id: 't',
    });

    // 迟到 / 重复：pending 已销账，不得再改状态。
    expect(consumeOverviewResult(result(id, { workspaces: 99 }))).toBe(true);
    expect(overviewFor('t', 'core-a')?.data?.workspaces).toBe(2);
  });

  it('并发两次请求不会串账：各自 request_id 独立', () => {
    requestOverview('a', 'core-a');
    const idA = lastRequestId();
    requestOverview('b', 'core-a');
    const idB = lastRequestId();
    expect(idA).not.toBe(idB);

    consumeOverviewResult(result(idB, { team_id: 'b', workspaces: 7 }));
    expect(overviewFor('b', 'core-a')?.data?.workspaces).toBe(7);
    expect(overviewFor('a', 'core-a')?.status).toBe('loading');

    consumeOverviewResult(result(idA, { team_id: 'a', workspaces: 1 }));
    expect(overviewFor('a', 'core-a')?.data?.workspaces).toBe(1);
  });

  it('回包 team_id 与请求不一致：显式错误，不把别人的数据落账', () => {
    requestOverview('t', 'core-a');
    const id = lastRequestId();
    consumeOverviewResult(result(id, { team_id: 'other' }));
    const entry = overviewFor('t', 'core-a');
    expect(entry?.status).toBe('error');
    expect(entry?.error).toContain('team_id');
    expect(entry?.data).toBeNull();
  });

  it('多上游回包 core 与请求目标不一致：不落账，等超时收敛', () => {
    vi.useFakeTimers();
    requestOverview('t', 'core-a');
    const id = lastRequestId();
    consumeOverviewResult(result(id, {}, { core: 'core-b' }));
    expect(overviewFor('t', 'core-a')?.status).toBe('loading');
    vi.advanceTimersByTime(OVERVIEW_TIMEOUT_MS);
    expect(overviewFor('t', 'core-a')?.status).toBe('error');
  });

  it('别的窗口 / 别的模块的回包不认领，也不进入本能力的错误态', () => {
    requestOverview('t', 'core-a');
    const before = overviewFor('t', 'core-a');
    expect(consumeOverviewResult(result('someone-else-request'))).toBe(true);
    expect(overviewFor('t', 'core-a')).toBe(before);
    expect(overviewFor('t', 'core-a')?.status).toBe('loading');

    expect(consumeOverviewResult({ ModuleEvent: { module: MODULE_ID, name: 'x' } })).toBe(false);
    expect(
      consumeOverviewResult({
        ModuleInvokeResult: {
          module: 'echo-agent.checklist',
          method: 'checklist.snapshot',
          ok: true,
          data: {},
        },
      }),
    ).toBe(false);
  });

  it('失败回包 data:null（无 request_id）：单条 pending 也不认领，超时说明未收到可匹配回执', () => {
    vi.useFakeTimers();
    requestOverview('t', 'core-a');
    expect(
      consumeOverviewResult(
        result(null, {}, { ok: false, error: 'workspace.overview 必须指定 team_id（没有默认智能体）' }),
      ),
    ).toBe(true);
    // 回执没有 request_id：无法证明它属于本窗口，保持等待。
    expect(overviewFor('t', 'core-a')?.status).toBe('loading');

    vi.advanceTimersByTime(OVERVIEW_TIMEOUT_MS);
    const entry = overviewFor('t', 'core-a');
    expect(entry?.status).toBe('error');
    expect(entry?.error).toContain('未收到可匹配回执');
    expect(entry?.requestId).toBeNull();
  });

  it('匹配的失败回执（data 带 request_id）仍然正常落账', () => {
    requestOverview('t', 'core-a');
    const id = lastRequestId();
    consumeOverviewResult(result(id, {}, { ok: false, error: '模块返回失败' }));
    const entry = overviewFor('t', 'core-a');
    expect(entry?.status).toBe('error');
    expect(entry?.error).toContain('模块返回失败');
  });

  it('失败回包 data:null 且有多条 pending：同样不认领，等超时各自收敛', () => {
    vi.useFakeTimers();
    requestOverview('a', 'core-a');
    requestOverview('b', 'core-a');
    consumeOverviewResult(result(null, {}, { ok: false, error: 'boom' }));
    expect(overviewFor('a', 'core-a')?.status).toBe('loading');
    expect(overviewFor('b', 'core-a')?.status).toBe('loading');
    vi.advanceTimersByTime(OVERVIEW_TIMEOUT_MS);
    expect(overviewFor('a', 'core-a')?.status).toBe('error');
    expect(overviewFor('b', 'core-a')?.status).toBe('error');
    expect(overviewFor('a', 'core-a')?.error).toContain('未收到可匹配回执');
    expect(overviewFor('b', 'core-a')?.error).toContain('未收到可匹配回执');
  });

  it('回归：双窗口各一条 pending 收到同一条失败 → 都不认领；随后 A 正确成功、B 超时', async () => {
    vi.useFakeTimers();
    vi.mocked(sendCommand).mockClear();

    // 两个浏览器窗口 = 两份独立的模块实例（各自一份 pending 表）。
    // 用查询串强制 Vite 生成两个模块实例，精确复现「各窗口恰好一条 pending」。
    const windowA = await import('../workspace-overview?window=a');
    const windowB = await import('../workspace-overview?window=b');
    windowA.resetOverview();
    windowB.resetOverview();

    expect(windowA.requestOverview('team-a', 'core-a')).toBe(true);
    expect(windowB.requestOverview('team-b', 'core-a')).toBe(true);
    const calls = vi.mocked(sendCommand).mock.calls;
    const payloadA = (calls[calls.length - 2]![0] as Command).InvokeModuleOp.payload;
    const payloadB = (calls[calls.length - 1]![0] as Command).InvokeModuleOp.payload;
    expect(payloadA.request_id).not.toBe(payloadB.request_id);

    // Core 对 Err 统一回 data:null，并经事件广播送到两个窗口。
    const broadcastFailure = result(null, {}, { ok: false, error: '模块挂载失败' });
    expect(windowA.consumeOverviewResult(broadcastFailure)).toBe(true);
    expect(windowB.consumeOverviewResult(broadcastFailure)).toBe(true);
    // 旧实现会各自认领（各窗口唯一 pending）→ 双双变 error；现在都必须保持等待。
    expect(windowA.overviewFor('team-a', 'core-a')?.status).toBe('loading');
    expect(windowB.overviewFor('team-b', 'core-a')?.status).toBe('loading');

    // A 收到带自己 request_id 的成功回执：仍然正常落账。
    const successA = result(payloadA.request_id, { team_id: 'team-a', workspaces: 5 });
    windowA.consumeOverviewResult(successA);
    windowB.consumeOverviewResult(successA);
    expect(windowA.overviewFor('team-a', 'core-a')?.status).toBe('ok');
    expect(windowA.overviewFor('team-a', 'core-a')?.data?.workspaces).toBe(5);
    expect(windowB.overviewFor('team-b', 'core-a')?.status).toBe('loading');

    // B 没收到可匹配回执：超时收敛并说明原因。
    vi.advanceTimersByTime(OVERVIEW_TIMEOUT_MS);
    const b = windowB.overviewFor('team-b', 'core-a');
    expect(b?.status).toBe('error');
    expect(b?.error).toContain('未收到可匹配回执');

    windowA.resetOverview();
    windowB.resetOverview();
  });
});

describe('超时与去重', () => {
  it('回包丢失：超时置错误，迟到成功回包不再改写', () => {
    vi.useFakeTimers();
    requestOverview('t', 'core-a');
    const id = lastRequestId();
    expect(overviewFor('t', 'core-a')?.status).toBe('loading');

    vi.advanceTimersByTime(OVERVIEW_TIMEOUT_MS);
    const entry = overviewFor('t', 'core-a');
    expect(entry?.status).toBe('error');
    expect(entry?.error).toContain('超时');
    expect(entry?.requestId).toBeNull();

    consumeOverviewResult(result(id));
    expect(overviewFor('t', 'core-a')?.status).toBe('error');
    expect(overviewFor('t', 'core-a')?.data).toBeNull();
  });

  it('pending 去重；成功后在新鲜窗口内不重复请求，过期或 force 才允许刷新', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    expect(requestOverview('t', 'core-a')).toBe(true);
    expect(requestOverview('t', 'core-a')).toBe(false);
    expect(sendCommand).toHaveBeenCalledTimes(1);

    consumeOverviewResult(result(lastRequestId()));
    expect(overviewFor('t', 'core-a')?.status).toBe('ok');
    expect(requestOverview('t', 'core-a')).toBe(false);

    // 用户点「刷新」必须穿透新鲜窗口（force）；在飞的请求仍不重复发。
    expect(requestOverview('t', 'core-a', true)).toBe(true);
    expect(requestOverview('t', 'core-a', true)).toBe(false);
    expect(sendCommand).toHaveBeenCalledTimes(2);
    consumeOverviewResult(result(lastRequestId()));

    vi.setSystemTime(1_000 + OVERVIEW_FRESH_MS + 1);
    expect(requestOverview('t', 'core-a')).toBe(true);
    expect(sendCommand).toHaveBeenCalledTimes(3);
  });

  it('断连重置：pending 计时器清掉，旧超时不会污染新基线', () => {
    vi.useFakeTimers();
    requestOverview('t', 'core-a');
    resetOverview();
    expect(overviewFor('t', 'core-a')).toBeNull();
    vi.advanceTimersByTime(OVERVIEW_TIMEOUT_MS);
    expect(overviewFor('t', 'core-a')).toBeNull();
  });

  it('字段不完整（旧模块 / 协议漂移）→ 显式错误，不显示半份数据', () => {
    requestOverview('t', 'core-a');
    const id = lastRequestId();
    consumeOverviewResult({
      ModuleInvokeResult: {
        module: MODULE_ID,
        method: OVERVIEW_METHOD,
        ok: true,
        data: { team_id: 't', request_id: id, workspaces: 1 },
      },
    });
    const entry = overviewFor('t', 'core-a');
    expect(entry?.status).toBe('error');
    expect(entry?.error).toContain('字段不完整');
    expect(entry?.data).toBeNull();
  });
});
