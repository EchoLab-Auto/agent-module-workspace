//! 工作区会话面板契约（workspace 插件，2026-09-13）。
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

function seed(sessions: WorkspaceSessionInfo[], active: string | null = null, team = 'EchoCode') {
  state.workspaceSessions = sessions;
  state.workspaceActive = active;
  state.workspaceTeamId = team;
  state.workspaceGitBySession = {};
  state.workspaceFiles = {};
  state.connected = true;
}

describe('WorkspacePanel 工作区会话', () => {
  beforeEach(() => {
    vi.mocked(sendCommand).mockClear();
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
