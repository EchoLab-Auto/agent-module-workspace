//! 工作区文件浏览器契约（2026-09-19 起迁出 WorkspacePanel，位于会话视图右侧边栏）。
//!
//! 2026-10 树模型重构（对齐 VS Code 资源管理器）：路径栈导航 → 全部根分区
//! 同时呈现、目录原地展开/折叠（懒加载）。覆盖：展开 = 请求 / 折叠不发请求、
//! 多根分区、加载指示、错误与空目录内联行、根行悬停速览、工具栏
//! （刷新/折叠全部）、team 未选择不发命令。

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

import WorkspaceFileBrowser from '../WorkspaceFileBrowser.vue';
import { state } from '@echo-agent/panel';
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

function mountBrowser() {
  const session = state.workspaceSessions[0] ?? null;
  return mount(WorkspaceFileBrowser, {
    props: { teamId: state.workspaceTeamId, session },
  });
}

/** 发出过的 RequestWorkspaceFiles 路径序列（按发出顺序）。 */
function requestedPaths(): string[] {
  const out: string[] = [];
  for (const call of vi.mocked(sendCommand).mock.calls) {
    const command = call[0];
    if (typeof command === 'object' && command && 'RequestWorkspaceFiles' in command) {
      out.push(
        (command as { RequestWorkspaceFiles: { path: string } }).RequestWorkspaceFiles.path,
      );
    }
  }
  return out;
}

/** 行按钮（目录/根；文件行是静态 div 不在其列）按文本查找。 */
function rowButton(wrapper: ReturnType<typeof mount>, text: string) {
  return wrapper.findAll('button.wfb-tbtn').find((b) => b.text().includes(text));
}

/** 工具栏按钮（NeumorphismButton）按文本精确查找。 */
function toolbarButton(wrapper: ReturnType<typeof mount>, text: string) {
  return wrapper.findAll('button').find((b) => b.text().trim() === text);
}

describe('WorkspaceFileBrowser 文件浏览器（右侧边栏）', () => {
  beforeEach(() => {
    vi.mocked(sendCommand).mockClear();
    seed([]);
  });

  it('打开即展开首个根并请求；目录点击原地展开/折叠（懒加载）', async () => {
    seed([{ id: 'core', name: '框架', directories: ['/srv/core', '/srv/panel'] }]);
    const wrapper = mountBrowser();
    await nextTick();

    // mount 即展开首个根并请求（列表未回推时 twistie 位为加载指示）
    expect(requestedPaths()).toEqual(['/srv/core']);
    expect(wrapper.findAll('.wfb-trow--root').length).toBe(2);
    expect(wrapper.find('.wfb-trow--root.is-open')).toBeTruthy();
    expect(wrapper.find('.wfb-trow--root .nm-spinner').exists()).toBe(true);

    // 回推目录内容：src/ 子目录 + 文件。
    state.workspaceFiles['/srv/core'] = {
      entries: [
        { name: 'src', path: '/srv/core/src', is_dir: true, size: 0 },
        { name: 'Cargo.toml', path: '/srv/core/Cargo.toml', is_dir: false, size: 2048 },
      ],
      error: null,
    };
    await nextTick();
    expect(wrapper.text()).toContain('src');
    expect(wrapper.text()).toContain('Cargo.toml');
    expect(wrapper.text()).toContain('2.0 KB');
    expect(wrapper.find('.nm-spinner').exists()).toBe(false);

    // 点击 src/ → 请求子目录 + 进入展开态（无缓存 → 加载指示）。
    vi.mocked(sendCommand).mockClear();
    expect(rowButton(wrapper, 'src')).toBeTruthy();
    await rowButton(wrapper, 'src')!.trigger('click');
    expect(requestedPaths()).toEqual(['/srv/core/src']);
    expect(wrapper.find('.wfb-trow--dir.is-open')).toBeTruthy();

    // 回推子目录内容 → 子行出现。
    state.workspaceFiles['/srv/core/src'] = {
      entries: [{ name: 'main.rs', path: '/srv/core/src/main.rs', is_dir: false, size: 100 }],
      error: null,
    };
    await nextTick();
    expect(wrapper.text()).toContain('main.rs');

    // 再点 → 折叠：子行消失、不发请求。
    vi.mocked(sendCommand).mockClear();
    await rowButton(wrapper, 'src')!.trigger('click');
    await nextTick();
    expect(wrapper.text()).not.toContain('main.rs');
    expect(requestedPaths()).toEqual([]);
    wrapper.unmount();
  });

  it('全部根分区同时呈现，逐个展开互不影响；空目录占位', async () => {
    seed([{ id: 'core', name: '框架', directories: ['/srv/core', '/srv/panel'] }]);
    const wrapper = mountBrowser();
    await nextTick();
    expect(wrapper.findAll('.wfb-trow--root').length).toBe(2);
    expect(wrapper.text()).toContain('core');
    expect(wrapper.text()).toContain('panel');

    // 展开第二个根 → 请求之（首个根保持展开）。
    vi.mocked(sendCommand).mockClear();
    await rowButton(wrapper, 'panel')!.trigger('click');
    expect(requestedPaths()).toEqual(['/srv/panel']);

    // 空目录回推 → （空目录）占位行；两根均展开。
    state.workspaceFiles['/srv/panel'] = { entries: [], error: null };
    await nextTick();
    expect(wrapper.text()).toContain('（空目录）');
    expect(wrapper.findAll('.wfb-trow--root.is-open').length).toBe(2);
    wrapper.unmount();
  });

  it('目录读取失败以内联错误行展示（树保持可交互）', async () => {
    seed([{ id: 'core', name: '框架', directories: ['/srv/core'] }]);
    const wrapper = mountBrowser();
    await nextTick();
    state.workspaceFiles['/srv/core'] = {
      entries: [],
      error: '路径不在该会话的工作区目录内',
    };
    await nextTick();
    const err = wrapper.find('.wfb-trow--error');
    expect(err.exists()).toBe(true);
    expect(err.text()).toContain('路径不在该会话的工作区目录内');
    // 错误行不是按钮（不可点击）；树仍在
    expect(wrapper.find('.wfb-trow--root.is-open').exists()).toBe(true);
    wrapper.unmount();
  });

  it('根行悬停显示绝对路径速览（Teleport 到 body），离开/滚动即收起', async () => {
    seed([{ id: 'core', name: '框架', directories: ['/srv/core', '/srv/panel'] }]);
    const wrapper = mountBrowser();
    await nextTick();

    // 悬停第二个根 → body 中渲染速览，内容为绝对路径
    await rowButton(wrapper, 'panel')!.trigger('mouseenter');
    await nextTick();
    const tip = document.body.querySelector('.wfb-root-tip');
    expect(tip, '悬停后出现速览').toBeTruthy();
    expect(tip!.textContent).toContain('/srv/panel');

    // 离开 → 收起
    await rowButton(wrapper, 'panel')!.trigger('mouseleave');
    await nextTick();
    expect(document.body.querySelector('.wfb-root-tip')).toBeNull();

    // 悬停第一个 → 显示第一条路径（不残留上一条）
    await rowButton(wrapper, 'core')!.trigger('mouseenter');
    await nextTick();
    expect(document.body.querySelector('.wfb-root-tip')!.textContent).toContain('/srv/core');

    // 任意容器滚动 → 收起（fixed 定位不追随滚动；捕获阶段监听）
    document.body.dispatchEvent(new Event('scroll', { bubbles: false }));
    await nextTick();
    expect(document.body.querySelector('.wfb-root-tip')).toBeNull();

    // 卸载（切走视图）→ 速览不残留
    await rowButton(wrapper, 'core')!.trigger('mouseenter');
    await nextTick();
    expect(document.body.querySelector('.wfb-root-tip')).toBeTruthy();
    wrapper.unmount();
    await nextTick();
    expect(document.body.querySelector('.wfb-root-tip')).toBeNull();
  });

  it('team 未选择时不发任何命令；无会话显示空态', async () => {
    seed([{ id: 'core', name: '框架', directories: ['/srv/core'] }]);
    const w1 = mount(WorkspaceFileBrowser, {
      props: { teamId: null, session: state.workspaceSessions[0] ?? null },
    });
    await nextTick();
    expect(requestedPaths()).toEqual([]);
    w1.unmount();

    seed([]);
    const w2 = mountBrowser();
    await nextTick();
    expect(w2.text()).toContain('（暂无工作区会话）');
    expect(requestedPaths()).toEqual([]);
    w2.unmount();
  });

  it('工具栏：折叠全部收起所有目录；刷新重读已展开目录（全折叠时重开首个根）', async () => {
    seed([{ id: 'core', name: '框架', directories: ['/srv/core'] }]);
    const wrapper = mountBrowser();
    await nextTick();
    state.workspaceFiles['/srv/core'] = {
      entries: [{ name: 'src', path: '/srv/core/src', is_dir: true, size: 0 }],
      error: null,
    };
    await nextTick();

    // 展开子目录（当前展开 = 根 + src）
    vi.mocked(sendCommand).mockClear();
    await rowButton(wrapper, 'src')!.trigger('click');
    expect(requestedPaths()).toEqual(['/srv/core/src']);

    // 刷新 → 已展开的两个目录都重读
    vi.mocked(sendCommand).mockClear();
    await toolbarButton(wrapper, '刷新')!.trigger('click');
    expect(requestedPaths().sort()).toEqual(['/srv/core', '/srv/core/src']);

    // 折叠全部 → 无展开行
    await toolbarButton(wrapper, '折叠')!.trigger('click');
    await nextTick();
    expect(wrapper.findAll('.wfb-trow.is-open').length).toBe(0);

    // 全折叠时刷新 → 重开首个根
    vi.mocked(sendCommand).mockClear();
    await toolbarButton(wrapper, '刷新')!.trigger('click');
    expect(requestedPaths()).toEqual(['/srv/core']);
    expect(wrapper.find('.wfb-trow--root.is-open')).toBeTruthy();
    wrapper.unmount();
  });
});
