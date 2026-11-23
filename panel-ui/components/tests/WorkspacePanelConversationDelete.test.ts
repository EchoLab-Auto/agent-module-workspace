//! C3b：Workspace 对话删除的**面板侧目标语义**（C2 现状基线已按目标改写）。
//!
//! C2 曾用本文件钉住现状：删除先发 `ClearHistory`（历史不可恢复）、再发
//! `SaveWorkspaceSession` 全量 upsert（`[]` 被当「未提供」回填），删最后一条
//! 既删不掉入口又已清掉历史。C3b 起默认删除改走**模块私有写方法**
//! `workspace.deleteConversation`（通用调用通道 `InvokeModuleOp`）：
//!
//! 1. 只删入口、聊天历史保留；**绝不**先发 `ClearHistory`；
//! 2. 失败不退回旧协议（不发 `SaveWorkspaceSession` 整表替换）；
//! 3. 业务结果都有明确反馈：最后一条被拒 / 成功 / 超时（失败回执无
//!    `request_id`、无法配对时也按超时说明「未收到可匹配回执」）；
//! 4. 请求按 `request_id` 配对，组件只消费终态。
//!
//! 本文件只进 mock：命令不进 Core，真实会话历史不参与。
//! 存储层证据仍在 Rust 侧（`conversation_delete_regression.rs` 钉 store 现状、
//! `conversation_entry_delete*.rs` 钉新入口），本文件只改 UI 断言。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';

const mocks = vi.hoisted(() => ({
  confirmDialog: vi.fn(async (_message: string, _options?: unknown) => true),
}));

vi.mock('@echo-agent/panel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@echo-agent/panel')>();
  const sendCommand = vi.fn();
  return {
    ...actual,
    sendCommand,
    // 生产里 sendPending = 登记加载 + 发命令；测试等价转发。
    sendPending: vi.fn((command: unknown) => sendCommand(command as never)),
    confirmDialog: mocks.confirmDialog,
  };
});

import WorkspacePanel from '../WorkspacePanel.vue';
import { sendCommand } from '@echo-agent/panel';
import type { WorkspaceSessionInfo } from '@echo-agent/panel';
import { state } from '@echo-agent/panel';
import { notifyChanged, workspace } from '../../workspace-store';
import {
  DELETE_CONVERSATION_METHOD,
  DELETE_TIMEOUT_MS,
  MODULE_ID,
  consumeConversationDeleteResult,
  resetConversationDeletes,
} from '../../workspace-conversation-delete';

type Command = Record<string, any>;

const TEAM = 'EchoCode';

const TWO_CONVERSATIONS: WorkspaceSessionInfo[] = [
  {
    id: 'proj',
    name: 'Proj',
    directories: ['/srv/proj'],
    conversations: [
      { id: 'main', name: '主对话', legacy: true },
      { id: 'docs', name: '文档', legacy: false },
    ],
    last_conversation: 'docs',
  },
];

const ONLY_CONVERSATION: WorkspaceSessionInfo[] = [
  {
    id: 'proj',
    name: 'Proj',
    directories: ['/srv/proj'],
    conversations: [{ id: 'main', name: '主对话', legacy: true }],
    last_conversation: 'main',
  },
];

function seed(
  sessions: WorkspaceSessionInfo[],
  active: string | null = 'proj',
  activeConversation: string | null = 'docs',
) {
  workspace.sessions = sessions;
  workspace.active = active;
  workspace.activeConversation = activeConversation;
  workspace.teamId = TEAM;
  // 与面板 freshness 判据对齐：workspace.core === state.activeRegion。
  workspace.core = null;
  workspace.gitBySession = {};
  workspace.files = {};
  state.activeRegion = null;
  state.connected = true;
  notifyChanged();
}

function commands(): Command[] {
  return vi.mocked(sendCommand).mock.calls.map((call) => call[0] as Command);
}

function clearCalls(): Command[] {
  return commands().filter((command) => 'ClearHistory' in command);
}

function saveCalls(): Command[] {
  return commands().filter((command) => 'SaveWorkspaceSession' in command);
}

function deleteCalls(): Command[] {
  return commands().filter((command) => 'InvokeModuleOp' in command);
}

function lastDeletePayload(): Record<string, any> {
  const calls = deleteCalls();
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]!.InvokeModuleOp.payload;
}

/** 构造一条 `ModuleInvokeResult` 回包（模块侧线形状）。 */
function moduleResult(
  requestId: string | null,
  data: Record<string, unknown> | null,
  options: { ok?: boolean; error?: string; core?: string | null } = {},
): unknown {
  return {
    ModuleInvokeResult: {
      module: MODULE_ID,
      method: DELETE_CONVERSATION_METHOD,
      ok: options.ok ?? true,
      data:
        data === null
          ? null
          : { team_id: TEAM, request_id: requestId, ...data },
      error: options.error,
      ...(options.core !== undefined ? { core: options.core } : {}),
    },
  };
}

async function mountPanel(): Promise<VueWrapper> {
  const wrapper = mount(WorkspacePanel, { props: { teamId: TEAM } });
  await nextTick();
  // 丢弃挂载期可能的 RequestWorkspaceSessions（本用例只看删除命令）。
  vi.mocked(sendCommand).mockClear();
  return wrapper;
}

async function deleteConversation(wrapper: VueWrapper, name: string) {
  const row = wrapper
    .findAll('.ws-conv')
    .find(
      (candidate) =>
        candidate.find('.ws-conv__name').exists() &&
        candidate.find('.ws-conv__name').text() === name,
    );
  expect(row, `找不到对话行：${name}`).toBeTruthy();
  const button = row!.findAll('button').find((item) => item.text() === '删除');
  expect(button, `对话 ${name} 缺少删除按钮`).toBeTruthy();
  await button!.trigger('click');
  // removeConversation 先 await confirmDialog，再同步发请求。
  await flushPromises();
}

beforeEach(() => {
  resetConversationDeletes();
  vi.useRealTimers();
  vi.mocked(sendCommand).mockClear();
  vi.mocked(sendCommand).mockReturnValue(true);
  mocks.confirmDialog.mockReset();
  mocks.confirmDialog.mockResolvedValue(true);
  seed(JSON.parse(JSON.stringify(TWO_CONVERSATIONS)));
});

afterEach(() => {
  resetConversationDeletes();
  vi.useRealTimers();
});

describe('WorkspacePanel 删除对话（C3b 目标语义）', () => {
  it('删非最后一条：只发模块私有方法，不清历史、不做全量 upsert', async () => {
    const wrapper = await mountPanel();
    await deleteConversation(wrapper, '文档');

    // 确认文案改为「保留历史」：不再承诺不可恢复的清空。
    expect(mocks.confirmDialog.mock.calls[0]?.[0]).toContain('聊天历史会保留');

    const deletes = deleteCalls();
    expect(deletes).toHaveLength(1);
    const op = deletes[0]!.InvokeModuleOp;
    expect(op.module).toBe(MODULE_ID);
    expect(op.method).toBe(DELETE_CONVERSATION_METHOD);
    expect(op.payload).toMatchObject({
      team_id: TEAM,
      workspace_id: 'proj',
      conversation_id: 'docs',
    });
    expect(typeof op.payload.request_id).toBe('string');
    expect(op.payload.request_id.length).toBeGreaterThan(8);

    // 目标语义：**绝不**先发 ClearHistory，也不退回全量 upsert。
    expect(clearCalls()).toHaveLength(0);
    expect(saveCalls()).toHaveLength(0);
    wrapper.unmount();
  });

  it('删最后一条：模块拒绝 → 面板明确提示，仍不清历史', async () => {
    seed(JSON.parse(JSON.stringify(ONLY_CONVERSATION)), 'proj', 'main');
    const wrapper = await mountPanel();
    await deleteConversation(wrapper, '主对话');

    const payload = lastDeletePayload();
    consumeConversationDeleteResult(
      moduleResult(payload.request_id, {
        conversation_id: 'main',
        result: 'refused_last_conversation',
        message: '「主对话」是该工作区的最后一条对话，不能删除：每个工作区至少保留一条（聊天历史保留）',
      }),
    );
    await nextTick();

    expect(wrapper.text()).toContain('最后一条');
    expect(wrapper.text()).toContain('聊天历史保留');
    expect(clearCalls()).toHaveLength(0);
    expect(saveCalls()).toHaveLength(0);
    // 反馈后动作结束：错误条之外不应继续显示「保存中…」之类的进行态。
    wrapper.unmount();
  });

  it('成功回包：列表随宿主广播刷新，动作正常结束', async () => {
    const wrapper = await mountPanel();
    await deleteConversation(wrapper, '文档');
    const payload = lastDeletePayload();

    // 宿主广播：被删对话已不在列表里。
    seed(
      [
        {
          ...TWO_CONVERSATIONS[0]!,
          conversations: [{ id: 'main', name: '主对话', legacy: true }],
          last_conversation: 'main',
        },
      ],
      'proj',
      'main',
    );
    await nextTick();
    consumeConversationDeleteResult(
      moduleResult(payload.request_id, {
        conversation_id: 'docs',
        result: 'deleted',
        message: '已删除对话「文档」的入口（聊天历史保留）',
      }),
    );
    await nextTick();

    const names = wrapper.findAll('.ws-conv__name').map((node) => node.text());
    expect(names).toEqual(['主对话']);
    expect(wrapper.text()).not.toContain('最后一条');
    expect(clearCalls()).toHaveLength(0);
    expect(saveCalls()).toHaveLength(0);
    wrapper.unmount();
  });

  it('失败回执 data:null 不认领：不误报别人的错，超时说明未收到可匹配回执，且不退回旧协议', async () => {
    vi.useFakeTimers();
    const wrapper = mount(WorkspacePanel, { props: { teamId: TEAM } });
    await nextTick();
    vi.mocked(sendCommand).mockClear();

    const row = wrapper
      .findAll('.ws-conv')
      .find((candidate) => candidate.find('.ws-conv__name').text() === '文档');
    const button = row!.findAll('button').find((item) => item.text() === '删除');
    await button!.trigger('click');
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(deleteCalls()).toHaveLength(1);

    // Core 的失败回执是 data:null（无 request_id），且广播给所有窗口：
    // 本窗口不能把这条无法配对的失败当成自己的。
    consumeConversationDeleteResult(
      moduleResult(null, null, { ok: false, error: '写入工作区文档失败：No space left on device' }),
    );
    await nextTick();
    expect(wrapper.text()).not.toContain('写入工作区文档失败');
    expect(wrapper.text()).not.toContain('No space left on device');

    vi.advanceTimersByTime(DELETE_TIMEOUT_MS);
    await nextTick();
    expect(wrapper.text()).toContain('未收到可匹配回执');
    expect(wrapper.text()).toContain('聊天历史未被清除');
    expect(clearCalls()).toHaveLength(0);
    expect(saveCalls()).toHaveLength(0);
    wrapper.unmount();
    vi.useRealTimers();
  });

  it('超时：明确提示未收到回执，且说明历史未被清除', async () => {
    vi.useFakeTimers();
    const wrapper = mount(WorkspacePanel, { props: { teamId: TEAM } });
    await nextTick();
    vi.mocked(sendCommand).mockClear();

    const row = wrapper
      .findAll('.ws-conv')
      .find((candidate) => candidate.find('.ws-conv__name').text() === '文档');
    const button = row!.findAll('button').find((item) => item.text() === '删除');
    await button!.trigger('click');
    for (let i = 0; i < 5; i += 1) await Promise.resolve();

    expect(deleteCalls()).toHaveLength(1);
    vi.advanceTimersByTime(DELETE_TIMEOUT_MS);
    await nextTick();

    expect(wrapper.text()).toContain('超时');
    expect(wrapper.text()).toContain('聊天历史未被清除');
    expect(clearCalls()).toHaveLength(0);
    expect(saveCalls()).toHaveLength(0);
    wrapper.unmount();
  });

  it('陈旧列表重复删除：幂等回 already_absent，面板补拉列表', async () => {
    const wrapper = await mountPanel();
    await deleteConversation(wrapper, '文档');
    consumeConversationDeleteResult(
      moduleResult(lastDeletePayload().request_id, {
        conversation_id: 'docs',
        result: 'deleted',
        message: '已删除对话「文档」的入口（聊天历史保留）',
      }),
    );
    await nextTick();
    // 模拟「广播尚未到达」：列表仍是旧的，同一行还能再点一次。
    seed(JSON.parse(JSON.stringify(TWO_CONVERSATIONS)));
    await nextTick();
    vi.mocked(sendCommand).mockClear();
    await deleteConversation(wrapper, '文档');

    expect(deleteCalls()).toHaveLength(1);
    consumeConversationDeleteResult(
      moduleResult(lastDeletePayload().request_id, {
        conversation_id: 'docs',
        result: 'already_absent',
        message: '该对话已不在列表中（可能已在其他窗口删除）',
      }),
    );
    await nextTick();

    // 陈旧快照 → 主动补拉一次权威列表（不再二次清同一个通道）。
    const refreshes = commands().filter((command) => 'RequestWorkspaceSessions' in command);
    expect(refreshes).toHaveLength(1);
    expect(clearCalls()).toHaveLength(0);
    expect(saveCalls()).toHaveLength(0);
    wrapper.unmount();
  });

  it('删整工作区：只发 DeleteWorkspaceSession，不发 ClearHistory（历史保留）', async () => {
    const wrapper = await mountPanel();
    const actions = wrapper.find('.ws-card__actions');
    const remove = actions.findAll('button').find((item) => item.text() === '删除');
    expect(remove, '工作区卡片缺少删除按钮').toBeTruthy();
    await remove!.trigger('click');
    await flushPromises();

    expect(clearCalls()).toHaveLength(0);
    const deletes = commands().filter((command) => 'DeleteWorkspaceSession' in command);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.DeleteWorkspaceSession).toEqual({ team_id: TEAM, id: 'proj' });
    wrapper.unmount();
  });

  it('编辑元数据：SaveWorkspaceSession 携带现有 conversations，不误清', async () => {
    const wrapper = await mountPanel();
    const actions = wrapper.find('.ws-card__actions');
    const edit = actions.findAll('button').find((item) => item.text() === '编辑');
    expect(edit).toBeTruthy();
    await edit!.trigger('click');
    await nextTick();

    await wrapper.find('.ws-input').setValue('Proj 2');
    const save = wrapper.findAll('button').find((item) => item.text() === '保存');
    expect(save).toBeTruthy();
    await save!.trigger('click');
    await flushPromises();

    const saves = saveCalls();
    expect(saves).toHaveLength(1);
    const sent = saves[0]!.SaveWorkspaceSession;
    expect(sent.session.name).toBe('Proj 2');
    expect(sent.session.conversations).toEqual(
      (TWO_CONVERSATIONS[0]!.conversations ?? []).map((conv) => ({ ...conv })),
    );
    expect(sent.session.last_conversation).toBe('docs');
    wrapper.unmount();
  });

  it('删除后新建同名对话：走显式通道并避开已退役 slug（不再复用裸通道）', async () => {
    const wrapper = await mountPanel();
    await deleteConversation(wrapper, '文档');
    consumeConversationDeleteResult(
      moduleResult(lastDeletePayload().request_id, {
        conversation_id: 'docs',
        result: 'deleted',
        message: '已删除对话「文档」的入口（聊天历史保留）',
      }),
    );
    await nextTick();
    seed(
      [
        {
          ...TWO_CONVERSATIONS[0]!,
          conversations: [{ id: 'main', name: '主对话', legacy: true }],
          last_conversation: 'main',
        },
      ],
      'proj',
      'main',
    );
    await nextTick();
    vi.mocked(sendCommand).mockClear();

    const create = wrapper.findAll('button').find((item) => item.text() === '新建对话');
    expect(create, '缺少「新建对话」按钮').toBeTruthy();
    await create!.trigger('click');
    await nextTick();
    const input = wrapper.find('.ws-conv__input');
    expect(input.exists()).toBe(true);
    await input.setValue('Docs');
    const confirm = wrapper.findAll('button').find((item) => item.text() === '创建');
    expect(confirm).toBeTruthy();
    await confirm!.trigger('click');
    await flushPromises();

    const saves = saveCalls();
    expect(saves).toHaveLength(1);
    const conversations = saves[0]!.SaveWorkspaceSession.session.conversations;
    expect(conversations).toEqual([
      { id: 'main', name: '主对话', legacy: true },
      // 退役的 'docs' 被跳过；新对话一律 `legacy: false`（显式 `<ws>/<conv>` 通道）。
      { id: 'docs-2', name: 'Docs', legacy: false },
    ]);
    expect(clearCalls()).toHaveLength(0);
    expect(deleteCalls()).toHaveLength(0);
    wrapper.unmount();
  });
});
