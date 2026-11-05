//! 多窗口互不干扰（2026-10 用户反馈）。
//!
//! 问题：多个浏览器窗口连同一个 Panel 时，A 窗口点选工作区会话（或选默认
//! 会话取消激活）会把 B 窗口一起跳走。根因是 Core 的 workspace `active` 为
//! **全局单例**，`WorkspaceSessions` 广播给所有连接，而 App 的跟随 watcher
//! 此前**无条件**把本地 activeSessionId 改成 active 投影。
//!
//! 修复：只有「本窗口自己发起的激活」才跟随投影（意图标记 + 一次性消费），
//! 他端广播只同步 workspace 状态；另加「本地通道已失效则回退」的安全网。
//!
//! 本测试锁两层：① 纯函数决策规则；② App 集成（广播不改本窗口视图）。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick } from 'vue';

vi.mock('@echo-agent/panel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@echo-agent/panel')>();
  return {
  ...actual,
  startConnection: vi.fn(),
  sendCommand: vi.fn(),
  // App 拉时间线走统一入口 `requestTimeline`（2026-10 分页：全量带窗口上限、
  // 增量原样请求）。mock 必须与真实导出对齐，否则调用处变成 undefined。
  requestTimeline: vi.fn(),
  requestActiveRegionManagement: vi.fn(),
  };
});

import App from '@echo-agent/panel/App';
import { state } from '@echo-agent/panel';
import { dispatch } from '@echo-agent/panel';
import {
  LOCAL_DEFAULT_SESSION,
  __resetLocalActivateIntentForTest,
  decideOnWorkspaceBroadcast,
  noteLocalActivateIntent,
  takeLocalActivateIntent,
} from '../workspace';
import type { WorkspaceSessionInfo } from '@echo-agent/panel';

// ── fixture：一个带两条对话的工作区 ──
const wsA: WorkspaceSessionInfo = {
  id: 'wsA',
  name: '项目 A',
  conversations: [
    { id: 'main', name: '主线', legacy: true },
    { id: 'c2', name: '分支二' },
  ],
} as WorkspaceSessionInfo;

const wsB: WorkspaceSessionInfo = {
  id: 'wsB',
  name: '项目 B',
  conversations: [{ id: 'main', name: '主线', legacy: true }],
} as WorkspaceSessionInfo;

const WS_A_LEGACY = 'local:workspace:wsA:local_user';
const WS_A_C2 = 'local:workspace:wsA/c2:local_user';
const WS_B_LEGACY = 'local:workspace:wsB:local_user';

beforeEach(() => {
  __resetLocalActivateIntentForTest();
});

describe('意图标记：一次性消费', () => {
  it('匹配 → true 并清空；再问一次则为 false', () => {
    noteLocalActivateIntent('wsA');
    expect(takeLocalActivateIntent('wsA')).toBe(true);
    expect(takeLocalActivateIntent('wsA')).toBe(false);
  });

  it('不匹配（他端改的）→ false，且不残留', () => {
    noteLocalActivateIntent('wsA');
    expect(takeLocalActivateIntent('wsB')).toBe(false);
    // 残留会让下一次他端变更被误判成自己的
    expect(takeLocalActivateIntent('wsA')).toBe(false);
  });

  it('取消激活意图（id = null）与 active = null 匹配', () => {
    noteLocalActivateIntent(null);
    expect(takeLocalActivateIntent(null)).toBe(true);
  });
});

describe('decideOnWorkspaceBroadcast 决策规则', () => {
  const base = {
    active: 'wsA' as string | null,
    activeConversation: null as string | null,
    sessions: [wsA, wsB] as WorkspaceSessionInfo[] | null,
    hasLocalIntent: false,
  };

  it('本窗口意图 → 跟随投影', () => {
    expect(
      decideOnWorkspaceBroadcast({ ...base, currentSessionId: WS_B_LEGACY, hasLocalIntent: true }),
    ).toEqual({ kind: 'follow', next: WS_A_LEGACY });
  });

  it('本窗口意图但当前停在 QQ 会话 → 不抢回（keep）', () => {
    expect(
      decideOnWorkspaceBroadcast({
        ...base,
        currentSessionId: 'qq:dm::42',
        hasLocalIntent: true,
      }),
    ).toEqual({ kind: 'keep' });
  });

  it('他端激活 wsA：本地停在 wsB 通道 → keep（核心修复：不再串台）', () => {
    expect(
      decideOnWorkspaceBroadcast({ ...base, currentSessionId: WS_B_LEGACY, hasLocalIntent: false }),
    ).toEqual({ kind: 'keep' });
  });

  it('他端取消激活：本地停在残留通道但工作区仍在 → keep', () => {
    expect(
      decideOnWorkspaceBroadcast({
        ...base,
        active: null,
        currentSessionId: WS_A_LEGACY,
        hasLocalIntent: false,
      }),
    ).toEqual({ kind: 'keep' });
  });

  it('他端广播、本地停在默认本地会话 → keep', () => {
    expect(
      decideOnWorkspaceBroadcast({
        ...base,
        currentSessionId: LOCAL_DEFAULT_SESSION,
        hasLocalIntent: false,
      }),
    ).toEqual({ kind: 'keep' });
  });

  it('安全网：本地工作区已被删除 → reset 到落点', () => {
    expect(
      decideOnWorkspaceBroadcast({
        ...base,
        sessions: [wsB], // wsA 被删
        currentSessionId: WS_A_LEGACY,
        hasLocalIntent: false,
      }),
    ).toEqual({ kind: 'reset', next: LOCAL_DEFAULT_SESSION });
  });

  it('安全网：本地对话已被删除 → reset', () => {
    const noC2: WorkspaceSessionInfo = {
      id: 'wsA',
      name: '项目 A',
      conversations: [{ id: 'main', name: '主线', legacy: true }],
    } as WorkspaceSessionInfo;
    expect(
      decideOnWorkspaceBroadcast({
        ...base,
        sessions: [noC2],
        currentSessionId: WS_A_C2,
        hasLocalIntent: false,
      }),
    ).toEqual({ kind: 'reset', next: LOCAL_DEFAULT_SESSION });
  });

  it('快照尚未到达（sessions = null）不猜 → keep', () => {
    expect(
      decideOnWorkspaceBroadcast({
        ...base,
        sessions: null,
        currentSessionId: WS_A_LEGACY,
        hasLocalIntent: false,
      }),
    ).toEqual({ kind: 'keep' });
  });
});

// ── App 集成：广播不改本窗口视图 ──
const Stub = defineComponent({ name: 'Stub', setup: () => () => h('div', { class: 'stub' }) });
/** ChatView 替身：把收到的 session-id 渲染成文本，便于断言「本窗口在看哪个会话」。 */
const ChatViewStub = defineComponent({
  name: 'ChatView',
  props: { sessionId: { type: String, default: '' } },
  setup: (props) => () => h('div', { class: 'stub-chat' }, props.sessionId),
});

function mountApp() {
  return mount(App, {
    global: {
      stubs: {
        ChatView: ChatViewStub,
        PanelSidebar: Stub,
        TasksPanel: Stub,
        SettingsView: Stub,
        ShellPanel: Stub,
        BranchModal: Stub,
        ThemeToggleButton: Stub,
      },
    },
  });
}

/** 广播一次 WorkspaceSessions（模拟 Core 推给本窗口）。 */
function broadcastWorkspace(active: string | null, conversation: string | null) {
  dispatch({
    WorkspaceSessions: {
      team_id: 'alix',
      sessions: [wsA, wsB],
      active,
      active_conversation: conversation,
    },
  } as never);
}

describe('App 集成：他端广播不切换本窗口视图', () => {
  const originalWidth = window.innerWidth;

  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      value: 1280,
      configurable: true,
      writable: true,
    });
    state.teams = [{ id: 'alix', name: 'Alix', enabled: true, sessions: 0 } as never];
    state.activeTeamId = 'alix';
    state.activeRegion = null;
    state.workspaceTeamId = 'alix';
    state.workspaceActive = null;
    state.workspaceActiveConversation = null;
    state.workspaceSessions = [wsA, wsB];
  });

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      value: originalWidth,
      configurable: true,
      writable: true,
    });
    __resetLocalActivateIntentForTest();
  });

  it('另一窗口激活 wsA → 本窗口仍停在原会话', async () => {
    const wrapper = mountApp();
    await nextTick();
    const before = wrapper.find('.stub-chat').text();

    // 他端广播（本窗口没有任何意图）
    broadcastWorkspace('wsA', null);
    await nextTick();

    // workspace 状态同步了（面板高亮 / 激活标记照常更新）……
    expect(state.workspaceActive).toBe('wsA');
    // ……但本窗口视图没被动过
    expect(wrapper.find('.stub-chat').text()).toBe(before);
    wrapper.unmount();
  });

  it('本窗口自己激活 wsA → 视图跟随到 wsA 通道', async () => {
    const wrapper = mountApp();
    await nextTick();

    noteLocalActivateIntent('wsA'); // 等价于本窗口点了切换器里的 wsA 通道
    broadcastWorkspace('wsA', null);
    await nextTick();

    expect(wrapper.find('.stub-chat').text()).toBe(WS_A_LEGACY);
    wrapper.unmount();
  });

  it('本窗口取消激活 → 回落到默认本地会话', async () => {
    const wrapper = mountApp();
    await nextTick();
    // 先让本窗口处在 wsA 通道（watcher 必须已挂载，否则广播时无人消费意图）
    noteLocalActivateIntent('wsA');
    broadcastWorkspace('wsA', null);
    await nextTick();
    expect(wrapper.find('.stub-chat').text()).toBe(WS_A_LEGACY);

    noteLocalActivateIntent(null);
    broadcastWorkspace(null, null);
    await nextTick();

    expect(wrapper.find('.stub-chat').text()).toBe(LOCAL_DEFAULT_SESSION);
    wrapper.unmount();
  });
});

// ── 二次修复回归（2026-10）：意图残留与 reset 落点 ──
//
// 首轮修复只做了「有意图才跟随」，但意图本身可能**永久残留**：
// 消费点在 `state.workspaceTeamId !== activeTeamId` 时提前 return（切 agent 中 /
// 快照未到 / 跨 core 竞态），意图没被消费就留着 —— 之后任意窗口激活同一工作区
// 都会命中残留，本窗口莫名跳转。故加 TTL + 对话维度匹配。
describe('意图 TTL：残留不会长期生效', () => {
  beforeEach(() => {
    __resetLocalActivateIntentForTest();
  });

  it('刚登记（TTL 内）→ 命中', () => {
    noteLocalActivateIntent('wsA');
    expect(takeLocalActivateIntent('wsA')).toBe(true);
  });

  it('超过 TTL 的残留意图 → 不命中（模拟消费点被跳过后的迟到广播）', () => {
    vi.useFakeTimers();
    try {
      noteLocalActivateIntent('wsA');
      // 消费点因 team 未同步被跳过，5s 后另一窗口激活同一工作区
      vi.advanceTimersByTime(5_001);
      expect(takeLocalActivateIntent('wsA')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('TTL 内但目标工作区不同 → 不命中', () => {
    noteLocalActivateIntent('wsA');
    expect(takeLocalActivateIntent('wsB')).toBe(false);
  });

  it('本窗口指定了对话：回推必须命中同一对话', () => {
    noteLocalActivateIntent('wsA', 'c2');
    expect(takeLocalActivateIntent('wsA', 'main')).toBe(false);
    noteLocalActivateIntent('wsA', 'c2');
    expect(takeLocalActivateIntent('wsA', 'c2')).toBe(true);
  });

  it('本窗口未指定对话（交给 Core 决定）：只按工作区匹配', () => {
    noteLocalActivateIntent('wsA', null);
    expect(takeLocalActivateIntent('wsA', 'main')).toBe(true);
  });
});

describe('reset 落点：回默认本地会话，不跳到他人激活的工作区', () => {
  it('本地工作区被删 → reset 到 LOCAL_DEFAULT_SESSION（不是 active 投影）', () => {
    const decision = decideOnWorkspaceBroadcast({
      currentSessionId: 'local:workspace:dead:local_user',
      active: 'wsB', // 另��窗口刚激活 wsB
      activeConversation: null,
      sessions: [wsB], // dead 已被删
      hasLocalIntent: false,
    });
    expect(decision).toEqual({ kind: 'reset', next: LOCAL_DEFAULT_SESSION });
  });

  it('本地对话被删 → 同样回默认本地会话', () => {
    const decision = decideOnWorkspaceBroadcast({
      currentSessionId: 'local:workspace:wsA/gone:local_user',
      active: 'wsB',
      activeConversation: null,
      sessions: [wsA, wsB],
      hasLocalIntent: false,
    });
    expect(decision).toEqual({ kind: 'reset', next: LOCAL_DEFAULT_SESSION });
  });
});
