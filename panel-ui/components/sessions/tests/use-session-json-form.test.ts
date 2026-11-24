//! `useSessionJsonForm` 契约（2026-11）。
//!
//! 这个 composable 从 `WorkspacePanel.vue` 里提出（原先 155 行散在组件中），
//! 提出来的目的是**让规则能脱离组件验证**——所以这里直接调它，不挂载组件。
//! 组件侧仍由 `WorkspacePanel.test.ts` 的三个挂载用例钉住「贴 JSON 直接保存」
//! 的端到端行为，两边职责不重叠：
//!
//! | 在哪测 | 测什么 |
//! |---|---|
//! | 本文件 | 解析结果如何回填表单、脏判定、编辑态 id 不可改、批量 / 单份的提示文案 |
//! | `WorkspacePanel.test.ts` | 上述规则经真实 DOM + 保存按钮 + 命令派发之后的行为 |

import { describe, it, expect } from 'vitest';
import { ref } from 'vue';
import type { WorkspaceSessionInfo } from '@echo-agent/panel';
import { useSessionJsonForm } from '../use-session-json-form';
import { directoryToInput } from '../../../workspace';

/** 建一个最小的表单环境；返回值即 composable 的全部依赖。 */
function setupForm(editingId = '', existing: WorkspaceSessionInfo[] = []) {
  const formName = ref('');
  const formDescription = ref('');
  const formDirs = ref('');
  const id = ref(editingId);
  const api = useSessionJsonForm({
    editingId: () => id.value,
    formName,
    formDescription,
    formDirs,
    findSession: (target) => existing.find((s) => s.id === target),
    toInput: directoryToInput,
  });
  return { api, formName, formDescription, formDirs, id };
}

describe('useSessionJsonForm', () => {
  it('脏判定：空文本不算脏，改过未应用算脏，应用后回到不脏', () => {
    const { api } = setupForm();
    expect(api.dirty.value).toBe(false);
    api.text.value = JSON.stringify({ name: '框架' });
    expect(api.dirty.value).toBe(true);
    expect(api.apply()).not.toBeNull();
    expect(api.dirty.value).toBe(false);
  });

  it('新建：回填表单并返回全部会话（多份 = 批量）', () => {
    const { api, formName, formDescription, formDirs } = setupForm();
    api.text.value = JSON.stringify([
      { name: 'A', description: '甲', directories: ['/srv/a'] },
      { name: 'B', directories: ['/srv/b'] },
    ]);
    const applied = api.apply();
    expect(applied).toHaveLength(2);
    // 只回填第一份：让用户看到即将创建什么
    expect(formName.value).toBe('A');
    expect(formDescription.value).toBe('甲');
    expect(formDirs.value).toBe('/srv/a');
    expect(api.notice.value).toContain('2 份');
  });

  it('新建：单份时提示「点保存创建」，且不携带 conversations', () => {
    const { api } = setupForm();
    api.text.value = JSON.stringify({ name: '框架', directories: ['/srv/core'] });
    expect(api.apply()).toHaveLength(1);
    expect(api.notice.value).toContain('点「保存」创建');
    expect(api.conversations.value).toBeNull();
  });

  it('跨机目录对象回填成 node:// 编辑串（不能变成 [object Object]）', () => {
    const { api, formDirs } = setupForm();
    api.text.value = JSON.stringify({
      name: '跨机',
      directories: [{ path: '/srv/repo', node: 'gpu-box' }],
    });
    expect(api.apply()).not.toBeNull();
    expect(formDirs.value).toBe('node://gpu-box/srv/repo');
  });

  it('编辑：单份且 id 一致才通过；改 id 被拒绝且不回填表单', () => {
    const { api, formName, id } = setupForm('core');
    formName.value = '原名';
    id.value = 'core';

    api.text.value = JSON.stringify({ id: 'other', name: '想改名' });
    expect(api.apply()).toBeNull();
    expect(api.error.value).toContain('不能修改工作区 id');
    // 关键：拒绝时表单保持原样（否则用户点保存会写入半截数据）
    expect(formName.value).toBe('原名');
  });

  it('编辑：多份被拒绝', () => {
    const { api } = setupForm('core');
    api.text.value = JSON.stringify([{ name: 'A' }, { name: 'B' }]);
    expect(api.apply()).toBeNull();
    expect(api.error.value).toContain('编辑时只能有一份');
  });

  it('整份落盘文档：sessions 被解析，active 只作提示（编辑态明说不随保存写入）', () => {
    // 编辑态：id 必须与正在编辑的一致，否则被拒（见上一个用例）
    const { api, formName } = setupForm('core');
    api.text.value = JSON.stringify({
      active: 'core',
      active_conversation: 'main',
      sessions: [{ id: 'core', name: '框架' }],
    });
    expect(api.apply()).not.toBeNull();
    expect(formName.value).toBe('框架');
    expect(api.notice.value).toContain('不随保存写入');
  });

  it('新建态：整份文档的 active 不进表单，按普通导入提示', () => {
    const { api, formName } = setupForm();
    api.text.value = JSON.stringify({ active: '别的', sessions: [{ name: '框架' }] });
    expect(api.apply()).not.toBeNull();
    expect(formName.value).toBe('框架');
    // 新建不涉及「保存会写坏 active」，给常规提示即可
    expect(api.notice.value).toContain('点「保存」创建');
  });

  it('解析失败：错误写进 error，表单不动', () => {
    const { api, formName } = setupForm();
    formName.value = '原名';
    api.text.value = '{ 坏 JSON';
    expect(api.apply()).toBeNull();
    expect(api.error.value).toBeTruthy();
    expect(formName.value).toBe('原名');
  });

  it('clear / seed：新建清空，编辑以既有会话为初值且不算脏', () => {
    const existing: WorkspaceSessionInfo = {
      id: 'core',
      name: '框架',
      directories: ['/srv/core'],
    };
    const { api } = setupForm('core', [existing]);

    api.text.value = '乱七八糟';
    api.clear();
    expect(api.text.value).toBe('');
    expect(api.dirty.value).toBe(false);

    api.seed(existing);
    expect(api.text.value).toContain('框架');
    // seed 后基线 = 文本：不能一进编辑态就显示「有未应用的修改」
    expect(api.dirty.value).toBe(false);
  });

  it('reset：回到既有会话的文本，丢弃用户改动', () => {
    const existing: WorkspaceSessionInfo = { id: 'core', name: '框架', directories: [] };
    const { api } = setupForm('core', [existing]);
    api.seed(existing);
    api.text.value = JSON.stringify({ name: '改过的' });
    api.reset();
    expect(api.text.value).toContain('框架');
    expect(api.dirty.value).toBe(false);
  });
});
