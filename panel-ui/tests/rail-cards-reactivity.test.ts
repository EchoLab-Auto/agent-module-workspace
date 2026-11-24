//! 边栏卡片列表必须依赖工作区投影的**结构版本号**（2026-11 回归）。
//!
//! 症状（用户报告）：删掉概览卡之后，右栏在「先渲染、回包后到」的时序下
//! 整列只剩连接状态 / 当前会话 / Shell——文件浏览器与 Git 状态都不出现；
//! 过一会儿（某个无关的 `state.*` 变化碰巧把 computed 顶翻）又自己冒出来。
//!
//! 根因：`workspace` 是**普通对象**（见 `workspace-store.ts` 开头的说明），
//! 响应式只由 `workspaceRevision` 承担。扩展的 `railCards()` 直接读了
//! `workspace.sessions` / `workspace.gitBySession` 却**没有读**版本号，于是
//! `PanelSidebar` 里 `railCardsFor` 的 computed 不依赖这份数据：首帧算出的空
//! 列表被缓存下来，回包到达也不重算。
//!
//! 本测试钉住的是「时序」而不是「数据」：先挂载（此时投影为空）→ 再喂
//! `WorkspaceSessions` → 断言卡片出现，且期间**不碰任何 `state.*` 字段**。
//! 少了 `void workspaceRevision.value` 这行，本测试会停在空列表上。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';

vi.mock('@echo-agent/panel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@echo-agent/panel')>();
  return { ...actual, startConnection: vi.fn(), sendCommand: vi.fn() };
});

import { dispatch, state } from '@echo-agent/panel';
import PanelSidebar from '@echo-agent/panel/components/PanelSidebar';
import { workspace } from '../workspace-store';
import '../index';

/** 线上真实回包形状（单上游：无 `core` 字段）。 */
const SESSIONS_FRAME = {
  WorkspaceSessions: {
    team_id: 'base',
    active: 'echoagent',
    active_conversation: 'workspace',
    sessions: [
      {
        id: 'echoagent',
        name: 'EchoAgent 框架',
        description: '',
        directories: ['/root/.local/share/echo-agent-core/source'],
        conversations: [{ id: 'workspace', name: 'workspace', legacy: false }],
        last_conversation: 'workspace',
      },
    ],
  },
};

function seedShell(): void {
  state.connected = true;
  state.teams = [
    {
      id: 'base',
      name: 'base',
      core: 'core',
      available_modules: [],
      available_tools: [],
      enabled: true,
      running: true,
    } as never,
  ];
  state.activeRegion = 'core';
  state.activeTeamId = 'base';
  // 本窗口停在中立会话：卡片只能靠 `workspace.active` 解析归属。
  state.windowSessionId = 'local:tui::local_user';
  workspace.teamId = null;
  workspace.sessions = [];
  workspace.active = null;
  workspace.activeConversation = null;
}

describe('边栏卡片的响应式依赖（回归 2026-11）', () => {
  beforeEach(() => {
    localStorage.clear();
    seedShell();
  });

  it('回包晚到：投影变化后卡片自己出现（不依赖任何 state.* 变化）', async () => {
    const wrapper = mount(PanelSidebar, { props: { teamId: 'base', side: 'right' } });
    await nextTick();
    // 首帧：投影还没到，两张扩展卡都不该在。
    expect(wrapper.text()).not.toContain('文件浏览器');

    dispatch(SESSIONS_FRAME as never, null);
    await nextTick();
    await nextTick();

    const text = wrapper.text();
    expect(text, '回包到达后应渲染文件浏览器卡').toContain('文件浏览器 · EchoAgent 框架');
    expect(text, '回包到达后应渲染 Git 状态卡').toContain('Git 状态');
  });
});
