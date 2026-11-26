import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import NeumorphismSelect from '@echolab-auto/ui-frame/components/NeumorphismSelect';
import DirectoryPicker from '../DirectoryPicker.vue';
import { state } from '@echo-agent/panel';

vi.mock('@echo-agent/panel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@echo-agent/panel')>();
  return { ...actual, sendCommand: vi.fn(), sendPending: vi.fn() };
});
describe('DirectoryPicker 联邦节点显示名', () => {
  it('显示 ai_station，但请求仍使用原 peer 配置名', () => {
    const node = 'node-01m436f84jtxye5ga61dmnz94p';
    const peer = {
      name: 'node-01m436f8', node_id: node, node_name: 'ai-station-ubuntu24-test',
      url: '', token_set: true, allow_tools: ['*'], allow_subagent: true,
      require_confirm: [], allow_queries: ['*'], link: 'Online' as const,
    };
    state.upstreams = [{ name: 'ai_station', source: 'manual' } as never];
    state.federations.ai_station = { enabled: true, node_id: node, listen: '', peers: [] };
    state.federation = { enabled: true, node_id: 'local', listen: '', peers: [peer] };
    const wrapper = mount(DirectoryPicker);
    const options = wrapper.findComponent(NeumorphismSelect).props('options');
    expect(options).toContainEqual({ label: 'ai_station（联邦节点）', value: 'node-01m436f8' });
    wrapper.unmount();
  });
});

describe('DirectoryPicker 浮层归属（2026-11「点一下就闪退」）', () => {
  it('teleport 出去的遮罩根节点声明 data-panel-floating-layer', () => {
    // 本组件 Teleport 到 body，DOM 不在工作区面板子树里。少了这个属性，面板的
    // 「点外面关闭」会把选择器里的一切按下当成外部点：点面包屑 / 目录行 / 标题
    // 空白都会先卸掉整个工作区面板（编辑表单内容一起丢）。
    //
    // 属性名是跨仓契约字面量（面板侧 `floating-layer.ts` 的
    // PANEL_FLOATING_LAYER_ATTR，两处必须一致）。
    const wrapper = mount(DirectoryPicker);
    const overlay = document.querySelector('.dp-overlay');
    expect(overlay, '选择器遮罩应已 teleport 到 body').not.toBeNull();
    expect(overlay!.hasAttribute('data-panel-floating-layer')).toBe(true);
    wrapper.unmount();
  });
});
