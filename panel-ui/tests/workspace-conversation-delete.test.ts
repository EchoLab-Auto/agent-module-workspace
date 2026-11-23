//! `workspace.deleteConversation` 面板 helper 的契约测试（C3b）。
//!
//! 删除是**写操作**：配对错了不只是显示问题，用户可能以为删掉了/没删掉。
//! 因此这里钉住与概览（C4）同源的配对规则，以及三种业务结果与超时的收敛：
//!
//! 1. 请求形状：`InvokeModuleOp` + 模块 id + 点分方法名 + `request_id`；
//! 2. `request_id` 命中才落账；迟到 / 重复 / 别的窗口的回包丢弃；
//! 3. `team_id` 与信封 `core` 校验；多上游串台不得落账；
//! 4. **失败回包 `data:null` 没有 `request_id`，一律不认领**：Core 的
//!    `ModuleInvokeResult` 广播给所有 Panel 窗口，「本窗口唯一 pending」
//!    不能证明归属；两窗口各一条 pending 时会同时错认同一条失败；
//! 5. 超时明确报错（说明未收到可匹配回执），迟到成功回包不再改写。

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
  DELETE_CONVERSATION_METHOD,
  DELETE_TIMEOUT_MS,
  MODULE_ID,
  conversationDeleteResult,
  consumeConversationDeleteResult,
  requestConversationDelete,
  resetConversationDeletes,
  retiredConversationIds,
} from '../workspace-conversation-delete';

type Command = {
  InvokeModuleOp: {
    module: string;
    method: string;
    payload: {
      team_id: string;
      workspace_id: string;
      conversation_id: string;
      request_id: string;
    };
  };
};

function sent(): Command[] {
  return vi.mocked(sendCommand).mock.calls.map((call) => call[0] as Command);
}

function lastRequestId(): string {
  const all = sent();
  return all[all.length - 1]!.InvokeModuleOp.payload.request_id;
}

function result(
  requestId: string | null,
  data: Record<string, unknown> | null,
  options: { ok?: boolean; error?: string; core?: string | null } = {},
): unknown {
  return {
    ModuleInvokeResult: {
      module: MODULE_ID,
      method: DELETE_CONVERSATION_METHOD,
      ok: options.ok ?? true,
      data: data === null ? null : { team_id: 't', request_id: requestId, ...data },
      error: options.error,
      ...(options.core !== undefined ? { core: options.core } : {}),
    },
  };
}

beforeEach(() => {
  resetConversationDeletes();
  vi.mocked(sendCommand).mockClear();
  vi.mocked(sendCommand).mockReturnValue(true);
});

afterEach(() => {
  resetConversationDeletes();
  vi.useRealTimers();
});

describe('请求形状', () => {
  it('发通用调用通道：模块 id + 点分方法名 + 显式 id + request_id', () => {
    const requestId = requestConversationDelete('t', 'core-a', 'proj', 'docs');
    expect(requestId).toBeTruthy();
    const command = sent()[0]!;
    expect(command.InvokeModuleOp.module).toBe(MODULE_ID);
    expect(command.InvokeModuleOp.method).toBe(DELETE_CONVERSATION_METHOD);
    expect(command.InvokeModuleOp.payload).toMatchObject({
      team_id: 't',
      workspace_id: 'proj',
      conversation_id: 'docs',
      request_id: requestId,
    });
    // 目标 core 必须显式传给 sendCommand（多上游路由）。
    expect(vi.mocked(sendCommand).mock.calls[0]![1]).toBe('core-a');

    // 线协议能原样序列化：用的是 Core 已有的 `InvokeModuleOp` 变体。
    const wire = JSON.parse(serializeCommand(command));
    expect(wire.payload.InvokeModuleOp).toEqual(command.InvokeModuleOp);
    expect(conversationDeleteResult('t', 'core-a', 'proj', 'docs')?.status).toBe('pending');
  });

  it('缺 team / 目标：不发请求', () => {
    expect(requestConversationDelete(null, 'core-a', 'proj', 'docs')).toBeNull();
    expect(requestConversationDelete('t', 'core-a', '', 'docs')).toBeNull();
    expect(requestConversationDelete('t', 'core-a', 'proj', '')).toBeNull();
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('无法路由（sendCommand=false）：当场失败，不给用户留 pending', () => {
    vi.mocked(sendCommand).mockReturnValueOnce(false);
    expect(requestConversationDelete('t', 'core-a', 'proj', 'docs')).toBeNull();
    const entry = conversationDeleteResult('t', 'core-a', 'proj', 'docs');
    expect(entry?.status).toBe('error');
    expect(entry?.message).toContain('无法路由');
  });
});

describe('配对', () => {
  it('按 request_id 落账：deleted 结果 + 历史保留文案 + 记录已删 id', () => {
    requestConversationDelete('t', 'core-a', 'proj', 'docs');
    const id = lastRequestId();
    expect(
      consumeConversationDeleteResult(
        result(id, {
          workspace_id: 'proj',
          conversation_id: 'docs',
          result: 'deleted',
          conversation: { id: 'docs', name: '文档', legacy: false },
          message: '已删除对话「文档」的入口（聊天历史保留）',
        }),
      ),
    ).toBe(true);
    const entry = conversationDeleteResult('t', 'core-a', 'proj', 'docs');
    expect(entry?.status).toBe('ok');
    expect(entry?.outcome).toBe('deleted');
    expect(entry?.message).toContain('历史保留');
    // 本窗口已知删除 → 新建 id 避让（否则同名新建会撞上退役通道）。
    expect(retiredConversationIds('t', 'core-a', 'proj')).toEqual(['docs']);
  });

  it('refused_last_conversation 是业务拒绝：保留提示、不当作错误码', () => {
    requestConversationDelete('t', 'core-a', 'proj', 'main');
    const id = lastRequestId();
    consumeConversationDeleteResult(
      result(id, {
        result: 'refused_last_conversation',
        conversation: { id: 'main', name: '主对话', legacy: true },
        message: '「主对话」是该工作区的最后一条对话，不能删除：每个工作区至少保留一条（聊天历史保留）',
      }),
    );
    const entry = conversationDeleteResult('t', 'core-a', 'proj', 'main');
    expect(entry?.status).toBe('refused');
    expect(entry?.outcome).toBe('refused_last_conversation');
    expect(entry?.message).toContain('最后一条');
    expect(retiredConversationIds('t', 'core-a', 'proj')).toEqual([]);
  });

  it('迟到 / 重复回包不改状态；别的窗口的 request_id 不认领', () => {
    requestConversationDelete('t', 'core-a', 'proj', 'docs');
    const id = lastRequestId();
    consumeConversationDeleteResult(
      result(id, { result: 'deleted', message: '已删除' }),
    );
    consumeConversationDeleteResult(
      result(id, { result: 'refused_last_conversation', message: '迟到' }),
    );
    expect(conversationDeleteResult('t', 'core-a', 'proj', 'docs')?.outcome).toBe('deleted');

    requestConversationDelete('t', 'core-a', 'proj2', 'x');
    const before = conversationDeleteResult('t', 'core-a', 'proj2', 'x');
    expect(consumeConversationDeleteResult(result('someone-else', { result: 'deleted' }))).toBe(true);
    expect(conversationDeleteResult('t', 'core-a', 'proj2', 'x')).toBe(before);
    expect(before?.status).toBe('pending');
  });

  it('回包 team_id / core 与请求不一致：不落账', () => {
    requestConversationDelete('t', 'core-a', 'proj', 'docs');
    const id = lastRequestId();
    consumeConversationDeleteResult(
      result(id, { team_id: 'other', result: 'deleted' }),
    );
    expect(conversationDeleteResult('t', 'core-a', 'proj', 'docs')?.status).toBe('error');
    expect(conversationDeleteResult('t', 'core-a', 'proj', 'docs')?.message).toContain('team_id');

    vi.mocked(sendCommand).mockClear();
    requestConversationDelete('t', 'core-a', 'proj', 'docs');
    const id2 = lastRequestId();
    consumeConversationDeleteResult(result(id2, { result: 'deleted' }, { core: 'core-b' }));
    // 不是发给这个 core 的请求：保留 pending，等自己的超时收敛。
    expect(conversationDeleteResult('t', 'core-a', 'proj', 'docs')?.status).toBe('pending');
  });

  it('别的模块 / 非 ModuleInvokeResult 事件不认领', () => {
    expect(consumeConversationDeleteResult({ ModuleEvent: { module: MODULE_ID, name: 'x' } })).toBe(false);
    expect(
      consumeConversationDeleteResult({
        ModuleInvokeResult: {
          module: MODULE_ID,
          method: 'workspace.overview',
          ok: true,
          data: {},
        },
      }),
    ).toBe(false);
    expect(
      consumeConversationDeleteResult({
        ModuleInvokeResult: { module: 'echo-agent.checklist', method: DELETE_CONVERSATION_METHOD, ok: true, data: {} },
      }),
    ).toBe(false);
  });

  it('错误回包 data:null（无 request_id）：单条 pending 也不认领，超时说明未收到可匹配回执', () => {
    vi.useFakeTimers();
    requestConversationDelete('t', 'core-a', 'proj', 'docs');
    expect(
      consumeConversationDeleteResult(
        result(null, null, { ok: false, error: '写入工作区文档失败：No space left on device' }),
      ),
    ).toBe(true);
    // 回执没有 request_id：无法证明它属于本窗口，保持 pending。
    expect(conversationDeleteResult('t', 'core-a', 'proj', 'docs')?.status).toBe('pending');

    vi.advanceTimersByTime(DELETE_TIMEOUT_MS);
    const entry = conversationDeleteResult('t', 'core-a', 'proj', 'docs');
    expect(entry?.status).toBe('error');
    expect(entry?.message).toContain('未收到可匹配回执');
    // 失败文案不得声称删除成功 / 历史已清除。
    expect(entry?.message).toContain('聊天历史未被清除');
  });

  it('匹配的失败回执（data 带 request_id）仍然正常落账', () => {
    requestConversationDelete('t', 'core-a', 'proj', 'docs');
    const id = lastRequestId();
    consumeConversationDeleteResult(result(id, {}, { ok: false, error: '模块返回失败' }));
    const entry = conversationDeleteResult('t', 'core-a', 'proj', 'docs');
    expect(entry?.status).toBe('error');
    expect(entry?.message).toContain('模块返回失败');
  });

  it('错误回包且多条 pending：同样不认领，各自超时收敛', () => {
    vi.useFakeTimers();
    requestConversationDelete('a', 'core-a', 'proj', 'docs');
    requestConversationDelete('b', 'core-a', 'proj', 'docs');
    consumeConversationDeleteResult(result(null, null, { ok: false, error: 'boom' }));
    expect(conversationDeleteResult('a', 'core-a', 'proj', 'docs')?.status).toBe('pending');
    expect(conversationDeleteResult('b', 'core-a', 'proj', 'docs')?.status).toBe('pending');
    vi.advanceTimersByTime(DELETE_TIMEOUT_MS);
    expect(conversationDeleteResult('a', 'core-a', 'proj', 'docs')?.status).toBe('error');
    expect(conversationDeleteResult('b', 'core-a', 'proj', 'docs')?.status).toBe('error');
    expect(conversationDeleteResult('a', 'core-a', 'proj', 'docs')?.message).toContain('未收到可匹配回执');
    expect(conversationDeleteResult('b', 'core-a', 'proj', 'docs')?.message).toContain('未收到可匹配回执');
  });

  it('回归：双窗口各一条 pending 收到同一条失败 → 都不认领；随后 A 正确成功、B 超时', async () => {
    vi.useFakeTimers();
    vi.mocked(sendCommand).mockClear();

    // 两个浏览器窗口 = 两份独立的模块实例（各自一份 pending 表）。
    // 用查询串强制 Vite 生成两个模块实例，精确复现「各窗口恰好一条 pending」。
    const windowA = await import('../workspace-conversation-delete?window=a');
    const windowB = await import('../workspace-conversation-delete?window=b');
    windowA.resetConversationDeletes();
    windowB.resetConversationDeletes();

    expect(windowA.requestConversationDelete('team-a', 'core-a', 'proj', 'docs')).toBeTruthy();
    expect(windowB.requestConversationDelete('team-b', 'core-a', 'proj', 'docs')).toBeTruthy();
    const calls = vi.mocked(sendCommand).mock.calls;
    const payloadA = (calls[calls.length - 2]![0] as Command).InvokeModuleOp.payload;
    const payloadB = (calls[calls.length - 1]![0] as Command).InvokeModuleOp.payload;
    expect(payloadA.request_id).not.toBe(payloadB.request_id);

    // Core 对 Err 统一回 data:null，并经事件广播送到两个窗口。
    const broadcastFailure = result(null, null, {
      ok: false,
      error: '写入工作区文档失败：No space left on device',
    });
    expect(windowA.consumeConversationDeleteResult(broadcastFailure)).toBe(true);
    expect(windowB.consumeConversationDeleteResult(broadcastFailure)).toBe(true);
    // 旧实现会各自认领（各窗口唯一 pending）→ 双双变 error；现在都必须保持等待。
    expect(windowA.conversationDeleteResult('team-a', 'core-a', 'proj', 'docs')?.status).toBe('pending');
    expect(windowB.conversationDeleteResult('team-b', 'core-a', 'proj', 'docs')?.status).toBe('pending');

    // A 收到带自己 request_id 的成功回执：仍然正常落账。
    const successA = result(payloadA.request_id, {
      team_id: 'team-a',
      workspace_id: 'proj',
      conversation_id: 'docs',
      result: 'deleted',
      message: '已删除对话「文档」的入口（聊天历史保留）',
    });
    windowA.consumeConversationDeleteResult(successA);
    windowB.consumeConversationDeleteResult(successA);
    expect(windowA.conversationDeleteResult('team-a', 'core-a', 'proj', 'docs')?.status).toBe('ok');
    expect(windowA.conversationDeleteResult('team-a', 'core-a', 'proj', 'docs')?.outcome).toBe('deleted');
    expect(windowB.conversationDeleteResult('team-b', 'core-a', 'proj', 'docs')?.status).toBe('pending');

    // B 没收到可匹配回执：超时收敛并说明原因。
    vi.advanceTimersByTime(DELETE_TIMEOUT_MS);
    const b = windowB.conversationDeleteResult('team-b', 'core-a', 'proj', 'docs');
    expect(b?.status).toBe('error');
    expect(b?.message).toContain('未收到可匹配回执');

    windowA.resetConversationDeletes();
    windowB.resetConversationDeletes();
  });
});

describe('超时与重置', () => {
  it('回包丢失：超时置错误，迟到成功回包不再改写', () => {
    vi.useFakeTimers();
    requestConversationDelete('t', 'core-a', 'proj', 'docs');
    const id = lastRequestId();
    vi.advanceTimersByTime(DELETE_TIMEOUT_MS);
    const entry = conversationDeleteResult('t', 'core-a', 'proj', 'docs');
    expect(entry?.status).toBe('error');
    expect(entry?.message).toContain('超时');
    expect(entry?.message).toContain('聊天历史未被清除');

    consumeConversationDeleteResult(result(id, { result: 'deleted', message: '迟到' }));
    expect(conversationDeleteResult('t', 'core-a', 'proj', 'docs')?.outcome).toBeNull();
  });

  it('断连重置：pending 计时器作废，不把新基线改成错误', () => {
    vi.useFakeTimers();
    requestConversationDelete('t', 'core-a', 'proj', 'docs');
    resetConversationDeletes();
    vi.advanceTimersByTime(DELETE_TIMEOUT_MS);
    expect(conversationDeleteResult('t', 'core-a', 'proj', 'docs')).toBeNull();
    expect(retiredConversationIds('t', 'core-a', 'proj')).toEqual([]);
  });
});
