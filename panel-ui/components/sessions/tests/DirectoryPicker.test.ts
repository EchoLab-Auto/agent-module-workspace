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
