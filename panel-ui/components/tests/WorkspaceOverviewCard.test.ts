//! 工作区概览卡的渲染契约（三态 + 刷新）。
//!
//! 数据源是模块私有方法 `workspace.overview` 的回包；本测试只验证组件
//! 如何呈现 store 的三态，不重复 store 的配对逻辑（那在
//! `panel-ui/tests/workspace-overview.test.ts`）。

import { mount } from '@vue/test-utils';
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@echo-agent/panel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@echo-agent/panel')>();
  return { ...actual, sendCommand: vi.fn(() => true) };
});

import { sendCommand, state } from '@echo-agent/panel';
import WorkspaceOverviewCard from '../WorkspaceOverviewCard.vue';
import {
  MODULE_ID,
  OVERVIEW_METHOD,
  OVERVIEW_TIMEOUT_MS,
  consumeOverviewResult,
  resetOverview,
  requestOverview,
} from '../../workspace-overview';

function success(requestId: string, teamId = 't'): unknown {
  return {
    ModuleInvokeResult: {
      module: MODULE_ID,
      method: OVERVIEW_METHOD,
      ok: true,
      data: {
        team_id: teamId,
        request_id: requestId,
        workspaces: 4,
        conversations: 7,
        directories: 9,
        remote_directories: 2,
        active: 'proj',
      },
    },
  };
}

function currentRequestId(): string {
  const calls = vi.mocked(sendCommand).mock.calls;
  const command = calls[calls.length - 1]![0] as {
    InvokeModuleOp: { payload: { request_id: string } };
  };
  return command.InvokeModuleOp.payload.request_id;
}

beforeEach(() => {
  resetOverview();
  state.connected = true;
  vi.mocked(sendCommand).mockClear();
  vi.mocked(sendCommand).mockReturnValue(true);
});

describe('WorkspaceOverviewCard', () => {
  it('成功快照：显示工作区 / 对话 / 目录与激活标识，刷新可重新请求', async () => {
    requestOverview('t', 'core-a');
    consumeOverviewResult(success(currentRequestId()));
    const wrapper = mount(WorkspaceOverviewCard, { props: { teamId: 't', core: 'core-a' } });
    const text = wrapper.text();
    expect(text).toContain('工作区概览');
    expect(text).toContain('4');
    expect(text).toContain('7');
    expect(text).toContain('9');
    expect(text).toContain('远程目录 2');
    expect(text).toContain('proj');

    // 用户点刷新：即使刚成功过（新鲜窗口内）也必须重新发请求。
    vi.mocked(sendCommand).mockClear();
    await wrapper.find('button').trigger('click');
    expect(sendCommand).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('加载态 → 超时错误：不显示半份数据，刷新按钮可再次发起', async () => {
    vi.useFakeTimers();
    requestOverview('t', 'core-a');
    const wrapper = mount(WorkspaceOverviewCard, { props: { teamId: 't', core: 'core-a' } });
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('正在读取');
    await vi.advanceTimersByTimeAsync(8_000);
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('超时');

    vi.mocked(sendCommand).mockClear();
    await wrapper.find('button').trigger('click');
    expect(sendCommand).toHaveBeenCalledTimes(1);
    wrapper.unmount();
    vi.useRealTimers();
  });

  it('失败回执 data:null（无 request_id）不认领：保持加载，超时说明未收到可匹配回执', async () => {
    vi.useFakeTimers();
    requestOverview('t', 'core-a');
    consumeOverviewResult({
      ModuleInvokeResult: {
        module: MODULE_ID,
        method: OVERVIEW_METHOD,
        ok: false,
        data: null,
        error: 'workspace.overview 必须指定 team_id（没有默认智能体）',
      },
    });
    const wrapper = mount(WorkspaceOverviewCard, { props: { teamId: 't', core: 'core-a' } });
    await wrapper.vm.$nextTick();
    // 没有可配对的 request_id：不得把别的窗口的失败显示成自己的。
    expect(wrapper.text()).toContain('正在读取');

    await vi.advanceTimersByTimeAsync(OVERVIEW_TIMEOUT_MS);
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('未收到可匹配回执');
    wrapper.unmount();
    vi.useRealTimers();
  });
});
