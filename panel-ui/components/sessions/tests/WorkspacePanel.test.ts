//! 工作区会话面板契约（workspace 模块，2026-09-13）。
//!
//! 面板按 team 寻址（去主智能体后会话类命令 team_id 必填）：
//! - 打开面板即请求会话列表（git 状态已迁至边栏 Git 卡片，2026-10）；
//! - 新建/编辑经 `SaveWorkspaceSession` 提交（目录按行解析为列表）；
//! - 激活/取消激活经 `ActivateWorkspaceSession`；
//! - team 未选择时不发任何命令（Core 会拒绝无 team_id 的请求）。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';

vi.mock('@echo-agent/panel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@echo-agent/panel')>();
  const sendCommand = vi.fn();
  return {
    ...actual,
    sendCommand,
    // sendPending = 登记加载跟踪 + 发命令（生产语义）：测试等价转发，
    // 调用记录并入 sendCommand 的 mock，请求类断言无需两处查。
    sendPending: vi.fn((command: unknown) => sendCommand(command as never)),
  };
});

import WorkspacePanel from '../WorkspacePanel.vue';
import { state } from '@echo-agent/panel';
import { releasePending, trackRequest } from '@echo-agent/panel';
import { sendCommand } from '@echo-agent/panel';
import type { WorkspaceSessionInfo } from '@echo-agent/panel';
import { notifyChanged, workspace } from '../../../workspace-store';

function seed(
  sessions: WorkspaceSessionInfo[],
  active: string | null = null,
  team = 'EchoCode',
  core: string | null = null,
) {
  workspace.sessions = sessions;
  workspace.active = active;
  workspace.teamId = team;
  // core 也要对齐：面板的 `fresh` 判据是 `(workspace.core) === (state.activeRegion)`，
  // 种子只改 team 会留下一份"属于别的 core"的投影，组件按设计拒绝渲染。
  workspace.core = core;
  workspace.gitBySession = {};
  workspace.files = {};
  state.connected = true;
  // 直接写投影必须显式通知（`workspace` 不是响应式对象）。
  notifyChanged();
}

describe('WorkspacePanel 工作区会话', () => {
  beforeEach(() => {
    vi.mocked(sendCommand).mockClear();
    state.activeRegion = null;
    seed([]);
  });

  it('没有本地数据时才请求会话列表（git 状态归边栏 Git 卡片，本面板不再请求）', async () => {
    // 空列表 = 确实没有数据 → 发请求
    seed([]);
    const wrapper = mount(WorkspacePanel, { props: { teamId: 'EchoCode' } });
    await nextTick();
    const calls = vi.mocked(sendCommand).mock.calls.map((c) => c[0]);
    const list = calls.find(
      (c) => typeof c === 'object' && 'RequestWorkspaceSessions' in (c as object),
    ) as { RequestWorkspaceSessions: { team_id: string } };
    expect(list).toBeTruthy();
    expect(list.RequestWorkspaceSessions.team_id).toBe('EchoCode');
    // 2026-10 迁出：面板不再发 git 请求，也不再渲染 git 区块
    expect(
      calls.some((c) => typeof c === 'object' && 'RequestWorkspaceGitStatus' in (c as object)),
    ).toBe(false);
    expect(wrapper.text()).not.toContain('git 状态 ·');
    wrapper.unmount();
  });

  it('已有本 agent 的新鲜数据时**不**重发（否则会白挂一条"正在加载"）', async () => {
    // 背景：切换 agent 时 App.vue 已经拉过一次；打开面板再发一次只是把
    // LoadHint 点亮 —— 实测 3G 下有 6.8 秒的假加载，而内容早已在本地。
    seed([{ id: 'core', name: '框架', directories: ['/srv/core', '/srv/panel'] }]);
    const wrapper = mount(WorkspacePanel, { props: { teamId: 'EchoCode' } });
    await nextTick();
    const calls = vi.mocked(sendCommand).mock.calls.map((c) => c[0]);
    expect(
      calls.some((c) => typeof c === 'object' && 'RequestWorkspaceSessions' in (c as object)),
    ).toBe(false);
    // 内容照常渲染（不因为跳过请求就空掉）
    expect(wrapper.text()).toContain('框架');
    wrapper.unmount();
  });

  it('本地数据属于别的 agent 时仍要重拉（陈旧快照不算数）', async () => {
    seed([{ id: 'core', name: '框架', directories: ['/srv/core'] }], null, 'Alice');
    const wrapper = mount(WorkspacePanel, { props: { teamId: 'EchoCode' } });
    await nextTick();
    const calls = vi.mocked(sendCommand).mock.calls.map((c) => c[0]);
    expect(
      calls.some((c) => typeof c === 'object' && 'RequestWorkspaceSessions' in (c as object)),
    ).toBe(true);
    wrapper.unmount();
  });

  it('首屏无数据时先铺骨架卡，数据到达后原地换成真卡片', async () => {
    // 背景：此前只有一行 LoadHint，列表区仍是一片空白 —— 感知上"什么都没发生"。
    // 骨架先把卡片形状铺出来（3 张占位），数据到达后被真卡片替换。
    vi.useFakeTimers();
    try {
      seed([]);
      vi.mocked(sendCommand).mockClear();
      // 真正的登记发生在 sendPending 里，而本测试把 `connection` 整个 mock 掉了
      // ——这里直接调 pending 的 trackRequest 复现"请求在飞"的状态。
      trackRequest('workspace:sessions', { RequestWorkspaceSessions: { team_id: 'EchoCode' } });
      const wrapper = mount(WorkspacePanel, { props: { teamId: 'EchoCode' } });
      await nextTick();
      // 150ms 内不闪加载态（pending.ts::PENDING_VISIBLE_AFTER_MS）
      expect(wrapper.findAll('.ws-card--skeleton')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(300);
      await nextTick();
      expect(wrapper.findAll('.ws-card--skeleton').length).toBe(3);

      // 数据到达：骨架消失、真卡片出现（同一份 DOM 不要同时有两种卡）
      seed([{ id: 'core', name: '框架', directories: ['/srv/core'] }]);
      await nextTick();
      expect(wrapper.findAll('.ws-card--skeleton')).toHaveLength(0);
      expect(wrapper.text()).toContain('框架');
      wrapper.unmount();
      releasePending('workspace:sessions');
    } finally {
      vi.useRealTimers();
    }
  });

  it('team 未选择（null）时不发任何命令', async () => {
    const wrapper = mount(WorkspacePanel, { props: { teamId: null } });
    await nextTick();
    expect(vi.mocked(sendCommand)).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('新建：目录按行解析、空行剔除，命令带 team_id', async () => {
    const wrapper = mount(WorkspacePanel, { props: { teamId: 'EchoCode' } });
    await nextTick();
    vi.mocked(sendCommand).mockClear();
    // 点「新建」
    const newBtn = wrapper.findAll('button').find((b) => b.text() === '新建');
    expect(newBtn).toBeTruthy();
    await newBtn!.trigger('click');
    await nextTick();
    await wrapper.find('.ws-input').setValue('EchoAgent 框架');
    await wrapper.find('.ws-textarea').setValue('/srv/core\n\n/srv/panel\n');
    const saveBtn = wrapper.findAll('button').find((b) => b.text() === '保存');
    await saveBtn!.trigger('click');
    const calls = vi.mocked(sendCommand).mock.calls.map((c) => c[0]);
    const save = calls.find(
      (c) => typeof c === 'object' && 'SaveWorkspaceSession' in (c as object),
    ) as { SaveWorkspaceSession: { team_id: string; session: WorkspaceSessionInfo } };
    expect(save).toBeTruthy();
    expect(save.SaveWorkspaceSession.team_id).toBe('EchoCode');
    expect(save.SaveWorkspaceSession.session.name).toBe('EchoAgent 框架');
    expect(save.SaveWorkspaceSession.session.directories).toEqual(['/srv/core', '/srv/panel']);
    wrapper.unmount();
  });

  it('激活/取消激活：已激活会话发出 id=null', async () => {
    seed([{ id: 'core', name: '框架', directories: [] }], 'core');
    const wrapper = mount(WorkspacePanel, { props: { teamId: 'EchoCode' } });
    await nextTick();
    vi.mocked(sendCommand).mockClear();
    const deactivate = wrapper.findAll('button').find((b) => b.text() === '取消激活');
    expect(deactivate).toBeTruthy();
    await deactivate!.trigger('click');
    const calls = vi.mocked(sendCommand).mock.calls.map((c) => c[0]);
    const act = calls.find(
      (c) => typeof c === 'object' && 'ActivateWorkspaceSession' in (c as object),
    ) as { ActivateWorkspaceSession: { team_id: string; id: string | null } };
    expect(act).toBeTruthy();
    expect(act.ActivateWorkspaceSession.id).toBeNull();
    wrapper.unmount();
  });

  it('跨 team 的陈旧列表不渲染（freshness 校验）', async () => {
    seed([{ id: 'other', name: '别的会话', directories: [] }], null, 'self-coding');
    const wrapper = mount(WorkspacePanel, { props: { teamId: 'EchoCode' } });
    await nextTick();
    expect(wrapper.text()).not.toContain('别的会话');
    wrapper.unmount();
  });
});

describe('WorkspacePanel JSON 导入 / 编辑（2026-11）', () => {
  beforeEach(() => {
    vi.mocked(sendCommand).mockClear();
    state.activeRegion = null;
    seed([]);
  });

  it('新建：粘贴 JSON 后直接点保存，自动应用并带上 conversations', async () => {
    // 背景：表单只有名称/描述/目录，落盘字段还有 conversations（含 api_profile）
    // 与 last_conversation。没有自动应用这一步，"贴了 JSON 直接点保存"会静默
    // 丢掉 JSON 里的内容——最容易踩的坑。
    const wrapper = mount(WorkspacePanel, { props: { teamId: 'EchoCode' } });
    await nextTick();
    vi.mocked(sendCommand).mockClear();
    const newBtn = wrapper.findAll('button').find((b) => b.text() === '新建');
    await newBtn!.trigger('click');
    await nextTick();
    const saveBtn = wrapper.findAll('button').find((b) => b.text() === '保存');
    // 空表单（名称也空、JSON 也空）：不可保存
    expect(saveBtn!.attributes('disabled')).toBe('');

    await wrapper.find('.ws-json__input').setValue(JSON.stringify({
      name: '框架',
      directories: ['/srv/core', { path: '/srv/remote', node: 'gpu-box' }],
      conversations: [
        { id: 'main', name: '主对话', legacy: true },
        { id: 'review', name: '评审', api_profile: 'kimi' },
      ],
      last_conversation: 'review',
    }));
    // 名称留空（只在 JSON 里给）：贴了 JSON 就应可保存——否则"贴进去没生效"。
    expect(saveBtn!.attributes('disabled')).toBeUndefined();
    await saveBtn!.trigger('click');

    const calls = vi.mocked(sendCommand).mock.calls.map((c) => c[0]);
    const saves = calls.filter(
      (c) => typeof c === 'object' && 'SaveWorkspaceSession' in (c as object),
    ) as Array<{ SaveWorkspaceSession: { team_id: string; session: WorkspaceSessionInfo } }>;
    expect(saves).toHaveLength(1);
    const { session } = saves[0].SaveWorkspaceSession;
    expect(session.name).toBe('框架');
    expect(session.directories).toEqual(['/srv/core', { path: '/srv/remote', node: 'gpu-box' }]);
    expect(session.conversations?.map((c) => c.id)).toEqual(['main', 'review']);
    expect(session.conversations?.[1].api_profile).toBe('kimi');
    expect(session.last_conversation).toBe('review');
    wrapper.unmount();
  });

  it('新建：数组 JSON = 批量导入，逐条提交', async () => {
    const wrapper = mount(WorkspacePanel, { props: { teamId: 'EchoCode' } });
    await nextTick();
    vi.mocked(sendCommand).mockClear();
    await wrapper.findAll('button').find((b) => b.text() === '新建')!.trigger('click');
    await nextTick();
    await wrapper.find('.ws-json__input').setValue(JSON.stringify([
      { id: 'core', name: '框架', directories: ['/srv/core'] },
      { id: 'panel', name: '面板', directories: ['/srv/panel'] },
    ]));
    await wrapper.findAll('button').find((b) => b.text() === '保存')!.trigger('click');

    const saves = vi.mocked(sendCommand).mock.calls
      .map((c) => c[0])
      .filter((c) => typeof c === 'object' && 'SaveWorkspaceSession' in (c as object)) as Array<{
        SaveWorkspaceSession: { session: WorkspaceSessionInfo };
      }>;
    expect(saves.map((s) => s.SaveWorkspaceSession.session.id)).toEqual(['core', 'panel']);
    // 批量导入后表单关闭、并留下中性提示（不是红色错误）
    expect(wrapper.find('.ws-form').exists()).toBe(false);
    expect(wrapper.find('.ws-notice').text()).toContain('2 个工作区');
    wrapper.unmount();
  });

  it('编辑：JSON 改描述生效；试图改 id 被拒绝且不发命令', async () => {
    seed([{
      id: 'core',
      name: '框架',
      description: '旧描述',
      directories: ['/srv/core'],
      conversations: [{ id: 'main', name: '主对话', legacy: true }],
    }]);
    const wrapper = mount(WorkspacePanel, { props: { teamId: 'EchoCode' } });
    await nextTick();
    await wrapper.findAll('button').find((b) => b.text() === '编辑')!.trigger('click');
    await nextTick();
    // 编辑段的初始文本 = 当前会话（含对话，表单里改不了这些）
    const initial = (wrapper.find('.ws-json__input').element as HTMLTextAreaElement).value;
    expect(initial).toContain('"main"');

    vi.mocked(sendCommand).mockClear();
    // 改 id → 拒绝
    await wrapper.find('.ws-json__input').setValue(JSON.stringify({
      id: 'renamed',
      name: '框架',
      directories: ['/srv/core'],
    }));
    await wrapper.findAll('button').find((b) => b.text() === '保存')!.trigger('click');
    expect(
      vi.mocked(sendCommand).mock.calls.some(
        (c) => typeof c[0] === 'object' && 'SaveWorkspaceSession' in (c[0] as object),
      ),
    ).toBe(false);
    expect(wrapper.find('.ws-error').text()).toContain('不能修改工作区 id');

    // 只改描述 → 生效，且 id 保持原值
    await wrapper.find('.ws-json__input').setValue(JSON.stringify({
      name: '框架',
      description: '新描述',
      directories: ['/srv/core'],
    }));
    await wrapper.findAll('button').find((b) => b.text() === '保存')!.trigger('click');
    const save = vi.mocked(sendCommand).mock.calls
      .map((c) => c[0])
      .find((c) => typeof c === 'object' && 'SaveWorkspaceSession' in (c as object)) as {
        SaveWorkspaceSession: { session: WorkspaceSessionInfo };
      };
    expect(save.SaveWorkspaceSession.session.id).toBe('core');
    expect(save.SaveWorkspaceSession.session.description).toBe('新描述');
    wrapper.unmount();
  });
});
