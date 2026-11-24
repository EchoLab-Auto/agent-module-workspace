//! 工作区 git 状态卡契约（workspace 模块，2026-10 从「工作区会话管理」面板迁入边栏）。
//!
//! 本卡只做三件事：按绑定的工作区会话拉一次 `RequestWorkspaceGitStatus`、
//! 把 `wsStore.gitBySession` 的快照渲染成**每目录一行**（点行展开细节）、
//! 提供手动刷新。锁定：请求时机（挂载 / 切会话 / 重连 / 手动）、行式渲染
//! （名称 / 分支 / 同步 / 变更数 / 非仓库错误）、展开态默认值（单目录展开、
//! 多目录收起、点过之后以用户为准）、按类别展开明细（计数即开关、小改动自动
//! 铺开、`MM` 同属两类、截断有提示、老 Core 退回扁平路径表）、以及「加载态
//! 不挂死」。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';

vi.mock('@echo-agent/panel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@echo-agent/panel')>();
  const sendCommand = vi.fn();
  return {
    ...actual, sendCommand, sendPending: vi.fn() };
});

import WorkspaceGitCard from '../WorkspaceGitCard.vue';
import { state } from '@echo-agent/panel';
import { sendCommand } from '@echo-agent/panel';
import { sessionKey } from '@echo-agent/panel';
import type { WorkspaceGitInfo, WorkspaceSessionInfo } from '@echo-agent/panel';
//! store 里的 `workspace` 与本文件的工厂函数 `workspace()` 同名，取别名避免遮蔽。
import { notifyChanged, workspace as wsStore } from '../../workspace-store';

function workspace(over: Partial<WorkspaceSessionInfo> = {}): WorkspaceSessionInfo {
  return {
    id: 'core',
    name: '框架',
    description: '',
    directories: ['/srv/core'],
    ...over,
  } as WorkspaceSessionInfo;
}

function info(over: Partial<WorkspaceGitInfo> = {}): WorkspaceGitInfo {
  return { directory: '/srv/core', is_repo: true, ...over } as WorkspaceGitInfo;
}

/** 本次测试里发出的 git 请求（按顺序）。 */
function gitCalls() {
  return vi
    .mocked(sendCommand)
    .mock.calls.map((c) => c[0])
    .filter(
      (c): c is {
        RequestWorkspaceGitStatus: {
          team_id?: string | null;
          session_id: string;
          directories?: string[] | null;
        };
      } => typeof c === 'object' && c !== null && 'RequestWorkspaceGitStatus' in c,
    );
}

describe('WorkspaceGitCard（工作区 git 状态卡）', () => {
  beforeEach(() => {
    vi.mocked(sendCommand).mockClear();
    state.connected = true;
    state.activeRegion = null;
    wsStore.gitBySession = {};
  notifyChanged();
    state.upstreams = [];
    state.federations = {};
    state.federation = null;
  });

  it('挂载即拉取：命令带 team_id 与 session_id', async () => {
    const wrapper = mount(WorkspaceGitCard, {
      props: { teamId: 'EchoCode', session: workspace() },
    });
    await nextTick();
    const calls = gitCalls();
    expect(calls.length).toBe(1);
    expect(calls[0].RequestWorkspaceGitStatus.team_id).toBe('EchoCode');
    expect(calls[0].RequestWorkspaceGitStatus.session_id).toBe('core');
    wrapper.unmount();
  });

  it('无会话 / 未连接 / 无 team 都不发请求，并给出空态', async () => {
    const noSession = mount(WorkspaceGitCard, { props: { teamId: 'EchoCode', session: null } });
    await nextTick();
    expect(gitCalls().length).toBe(0);
    expect(noSession.text()).toContain('没有激活的工作区会话');
    noSession.unmount();

    const noTeam = mount(WorkspaceGitCard, { props: { teamId: null, session: workspace() } });
    await nextTick();
    expect(gitCalls().length).toBe(0);
    noTeam.unmount();

    state.connected = false;
    const offline = mount(WorkspaceGitCard, { props: { teamId: 'EchoCode', session: workspace() } });
    await nextTick();
    expect(gitCalls().length).toBe(0);
    offline.unmount();
    state.connected = true;
  });

  it('单目录默认展开：分支/同步/计数/父目录/最近提交/文件 chip 全渲染', async () => {
    wsStore.gitBySession = {
      [sessionKey(null, 'core')]: [
        info({
          directory: '/home/evence/code_file/gitlab/echo-tech/ui-frame',
          branch: 'main',
          ahead: 2,
          behind: 1,
          staged: 1,
          modified: 3,
          untracked: 2,
          changed_files: ['src/main.rs', 'README.md'],
          last_commit: 'abc1234 初始提交',
        }),
      ],
    };
  notifyChanged();
    const wrapper = mount(WorkspaceGitCard, {
      props: { teamId: 'EchoCode', session: workspace() },
    });
    await nextTick();
    const text = wrapper.text();
    // 行：目录名取末段 + 分支 + 同步 + 变更总数（1+3+2=6）
    expect(text).toContain('ui-frame');
    expect(text).toContain('main');
    expect(wrapper.find('.wgc-sync').text()).toBe('↑2');
    expect(wrapper.findAll('.wgc-sync')[1].text()).toBe('↓1');
    expect(wrapper.find('.wgc-row__count').text()).toBe('6');
    // 展开块：计数全称 + 父目录 + 提交 + 文件 chip
    expect(text).toContain('已暂存 1');
    expect(text).toContain('已修改 3');
    expect(text).toContain('未跟踪 2');
    expect(text).toContain('/home/evence/code_file/gitlab/echo-tech');
    expect(text).toContain('abc1234 初始提交');
    expect(text).toContain('src/main.rs');
    // 行 title = 全路径 + 分支/计数/提交（收起态下也读得到全部）
    const rowTip = wrapper.find('.wgc-row').attributes('title') ?? '';
    expect(rowTip).toContain('/home/evence/code_file/gitlab/echo-tech/ui-frame');
    expect(rowTip).toContain('已修改 3');
    expect(rowTip).toContain('abc1234 初始提交');
    // 快照到达即收掉加载态（不必等 8s 超时）。刷新控件是图标按钮，
    // 忙碌态看 `aria-busy`（文字在 2026-11 从按钮里撤掉了）。
    expect(wrapper.find('button').attributes('aria-busy')).toBeUndefined();
    wrapper.unmount();
  });

  it('多目录默认收起：行上只有分支/计数，点行展开才出细节', async () => {
    wsStore.gitBySession = {
      [sessionKey(null, 'core')]: [
        info({ directory: '/srv/a', branch: 'main', modified: 2, changed_files: ['a.rs'] }),
        info({ directory: '/srv/b', branch: 'dev', untracked: 1 }),
      ],
    };
  notifyChanged();
    const wrapper = mount(WorkspaceGitCard, {
      props: { teamId: 'EchoCode', session: workspace() },
    });
    await nextTick();
    expect(wrapper.findAll('.wgc-row').length).toBe(2);
    expect(wrapper.findAll('.wgc-detail').length).toBe(0);
    expect(wrapper.findAll('.wgc-row__branch').map((e) => e.text())).toEqual(['⑂ main', '⑂ dev']);
    expect(wrapper.findAll('.wgc-row__count').map((e) => e.text())).toEqual(['2', '1']);
    expect(wrapper.findAll('.wgc-row__name').map((e) => e.text())).toEqual(['a', 'b']);

    await wrapper.findAll('.wgc-row')[0].trigger('click');
    expect(wrapper.findAll('.wgc-detail').length).toBe(1);
    expect(wrapper.text()).toContain('a.rs');
    await wrapper.findAll('.wgc-row')[0].trigger('click');
    expect(wrapper.findAll('.wgc-detail').length).toBe(0);
    wrapper.unmount();
  });

  it('单目录默认展开，但点一下收起后以用户为准（刷新不再自动展开）', async () => {
    wsStore.gitBySession = {
      [sessionKey(null, 'core')]: [info({ branch: 'main', modified: 1 })],
    };
  notifyChanged();
    const wrapper = mount(WorkspaceGitCard, {
      props: { teamId: 'EchoCode', session: workspace() },
    });
    await nextTick();
    expect(wrapper.findAll('.wgc-detail').length).toBe(1);
    await wrapper.find('.wgc-row').trigger('click');
    expect(wrapper.findAll('.wgc-detail').length).toBe(0);
    // 刷新（新快照）后仍保持收起
    wsStore.gitBySession = {
      [sessionKey(null, 'core')]: [info({ branch: 'main', modified: 1 })],
    };
  notifyChanged();
    await nextTick();
    expect(wrapper.findAll('.wgc-detail').length).toBe(0);
    wrapper.unmount();
  });

  it('干净仓库行显示 ✓；非仓库行显示 Core 的错误原因且不可展开', async () => {
    wsStore.gitBySession = {
      [sessionKey(null, 'core')]: [
        info({ directory: '/srv/core', branch: 'main' }),
        info({ directory: '/srv/missing', is_repo: false, error: '目录不存在' }),
      ],
    };
  notifyChanged();
    const wrapper = mount(WorkspaceGitCard, {
      props: { teamId: 'EchoCode', session: workspace() },
    });
    await nextTick();
    expect(wrapper.findAll('.wgc-row__count').map((e) => e.text())).toEqual(['✓']);
    expect(wrapper.findAll('.wgc-row__count')[0].classes()).toContain('wgc-row__count--clean');
    expect(wrapper.text()).toContain('目录不存在');
    // 非仓库行没有 caret / 分支，点它也不会展开
    const errRow = wrapper.findAll('.wgc-row')[1];
    expect(errRow.find('.wgc-caret').exists()).toBe(false);
    expect(errRow.find('.wgc-row__branch').exists()).toBe(false);
    await errRow.trigger('click');
    expect(wrapper.findAll('.wgc-detail').length).toBe(0);
    wrapper.unmount();
  });

  it('重名目录：补父目录末段消歧；唯一目录不加后缀', async () => {
    wsStore.gitBySession = {
      [sessionKey(null, 'core')]: [
        info({ directory: '/w/echo-agent-core/source', branch: 'main' }),
        info({ directory: '/w/echo-agent-panel/source', branch: 'main' }),
        info({ directory: '/w/ui-frame', branch: 'main' }),
      ],
    };
  notifyChanged();
    const wrapper = mount(WorkspaceGitCard, {
      props: { teamId: 'EchoCode', session: workspace() },
    });
    await nextTick();
    const names = wrapper.findAll('.wgc-row__name').map((e) => e.text());
    expect(names).toEqual(['source', 'source', 'ui-frame']);
    // 两个 source 各带父目录末段；ui-frame 唯一 → 无后缀
    expect(wrapper.findAll('.wgc-row__hint').map((e) => e.text())).toEqual([
      'echo-agent-core',
      'echo-agent-panel',
    ]);
    wrapper.unmount();
  });

  it('跨机目录：显示节点徽标，父目录剥掉 node://host 前缀', async () => {
    wsStore.gitBySession = {
      [sessionKey(null, 'core')]: [
        info({ directory: 'node://A100-40g/home/evence/echo-agent-ui', branch: 'main' }),
      ],
    };
  notifyChanged();
    const wrapper = mount(WorkspaceGitCard, {
      props: { teamId: 'EchoCode', session: workspace() },
    });
    await nextTick();
    expect(wrapper.find('.wgc-node').text()).toBe('A100-40g');
    // 单目录 → 展开：父目录剥掉 node://host 前缀，只留本机路径
    expect(wrapper.text()).toContain('/home/evence');
    expect(wrapper.text()).not.toContain('node://A100-40g/home/evence');
    wrapper.unmount();
  });

  it('跨机目录徽标按 node_id 显示人工接入点名', async () => {
    const node = 'node-01m436f84jtxye5ga61dmnz94p';
    state.upstreams = [{ name: 'ai_station', source: 'manual' } as never];
    state.federations.ai_station = { enabled: true, node_id: node, listen: '', peers: [] };
    state.federation = { enabled: true, node_id: 'local', listen: '', peers: [{
      name: 'node-01m436f8', node_id: node, url: '', token_set: true, allow_tools: ['*'],
      allow_subagent: true, require_confirm: [], allow_queries: ['*'], link: 'Online',
    }] };
    wsStore.gitBySession = {
      [sessionKey(null, 'core')]: [info({ directory: 'node://node-01m436f8/root/repo' })],
    };
  notifyChanged();
    const wrapper = mount(WorkspaceGitCard, { props: { teamId: 'EchoCode', session: workspace() } });
    await nextTick();
    expect(wrapper.find('.wgc-node').text()).toBe('ai_station');
    expect(wrapper.find('.wgc-row').attributes('title')).toContain('node://node-01m436f8/root/repo');
    wrapper.unmount();
  });

  it('切换会话 → 重新拉取新会话的状态（旧快照不串台，展开态重置）', async () => {
    wsStore.gitBySession = {
      [sessionKey(null, 'core')]: [info({ branch: 'main', modified: 1 })],
    };
  notifyChanged();
    const wrapper = mount(WorkspaceGitCard, {
      props: { teamId: 'EchoCode', session: workspace({ id: 'core' }) },
    });
    await nextTick();
    expect(wrapper.findAll('.wgc-detail').length).toBe(1);
    // 新会话没有快照 → 回到「正在读取」空态（不残留旧会话的行）
    await wrapper.setProps({ session: workspace({ id: 'panel', name: '面板' }) });
    await nextTick();
    const calls = gitCalls();
    expect(calls.length).toBe(2);
    expect(calls[1].RequestWorkspaceGitStatus.session_id).toBe('panel');
    expect(wrapper.findAll('.wgc-row').length).toBe(0);
    expect(wrapper.text()).toContain('正在读取 git 状态');
    wrapper.unmount();
  });

  it('重连后重新拉取（缓存已被连接层清空）', async () => {
    const wrapper = mount(WorkspaceGitCard, {
      props: { teamId: 'EchoCode', session: workspace() },
    });
    await nextTick();
    const before = gitCalls().length;
    state.connected = false;
    await nextTick();
    state.connected = true;
    await nextTick();
    expect(gitCalls().length).toBe(before + 1);
    wrapper.unmount();
  });

  it('刷新按钮：再发一次同一会话的请求；未连接时禁用', async () => {
    // 已有快照 → 挂载时不进加载态（按钮可点）。刷新控件自 2026-11 是**图标
    // 按钮**（不再是「刷新」文字），语义与忙碌态都落在 aria 属性上。
    wsStore.gitBySession = {
      [sessionKey(null, 'core')]: [info({ branch: 'main' })],
    };
  notifyChanged();
    const wrapper = mount(WorkspaceGitCard, {
      props: { teamId: 'EchoCode', session: workspace() },
    });
    await nextTick();
    expect(wrapper.find('button').attributes('aria-label')).toBe('刷新 git 状态');
    expect(wrapper.find('button').attributes('aria-busy')).toBeUndefined();
    const before = gitCalls().length;
    await wrapper.find('button').trigger('click');
    expect(gitCalls().length).toBe(before + 1);

    state.connected = false;
    await nextTick();
    expect(wrapper.find('button').attributes('disabled')).toBeDefined();
    wrapper.unmount();
    state.connected = true;
  });

  it('加载态不挂死：请求后固定 8s 收敛回可点（事件缺失也不永久转圈）', async () => {
    vi.useFakeTimers();
    const wrapper = mount(WorkspaceGitCard, {
      props: { teamId: 'EchoCode', session: workspace() },
    });
    await nextTick();
    expect(wrapper.find('button').attributes('aria-busy')).toBe('true');
    vi.advanceTimersByTime(8000);
    await nextTick();
    expect(wrapper.find('button').attributes('aria-busy')).toBeUndefined();
    expect(wrapper.find('button').attributes('aria-label')).toBe('刷新 git 状态');
    wrapper.unmount();
    vi.useRealTimers();
  });

  // ── 按类别展开明细（2026-10）────────────────────────────────────────

  /** 三类各一条明细的快照（总数 3 ≤ 自动铺开阈值）。 */
  function detail(over: Partial<WorkspaceGitInfo> = {}): WorkspaceGitInfo {
    return info({
      branch: 'main',
      staged: 1,
      modified: 1,
      untracked: 1,
      changed_entries: [
        { path: 'web/src/components/WorkspaceGitCard.vue', index: 'A', worktree: ' ' },
        { path: 'web/src/store.ts', index: ' ', worktree: 'M' },
        { path: 'README.md', index: '?', worktree: '?' },
      ],
      ...over,
    });
  }

  function mountWith(dirs: WorkspaceGitInfo[]) {
    wsStore.gitBySession = { [sessionKey(null, 'core')]: dirs };
  notifyChanged();
    return mount(WorkspaceGitCard, {
      props: { teamId: 'EchoCode', session: workspace() },
    });
  }

  it('计数即开关：小改动展开行后自动铺开，行首带 porcelain 状态字符', async () => {
    const wrapper = mountWith([detail()]);
    await nextTick();
    // 三个类别各一个 chip（文案沿用旧口径，能被一眼扫到）
    const chips = wrapper.findAll('.wgc-group').map((e) => e.text());
    expect(chips.length).toBe(3);
    expect(chips[0]).toContain('已暂存');
    expect(chips[1]).toContain('已修改');
    expect(chips[2]).toContain('未跟踪');
    // 总数 3 ≤ 6 → 不需要再点一次，明细直接铺开
    expect(wrapper.findAll('.wgc-file').length).toBe(3);
    expect(wrapper.findAll('.wgc-file__st').map((e) => e.text())).toEqual(['A', 'M', '?']);
    // 文件名永不参与收缩；目录前缀只留末两段（长路径的前段是信息量最低的）
    const dirs = wrapper.findAll('.wgc-file__dir').map((e) => e.text());
    // 两段以内原样保留（`web/src/` 不算长），超过才掐前段
    expect(dirs).toEqual(['…/src/components/', 'web/src/', '']);
    const names = wrapper.findAll('.wgc-file__name').map((e) => e.text());
    expect(names).toEqual(['WorkspaceGitCard.vue', 'store.ts', 'README.md']);
    // 全路径仍在 title 里（截图看不到、悬停看得到）
    expect(wrapper.findAll('.wgc-file')[0].attributes('title')).toContain(
      'web/src/components/WorkspaceGitCard.vue',
    );
    wrapper.unmount();
  });

  it('大改动默认折叠：点类别只列该类的文件，再点收起，多类可同开', async () => {
    const wrapper = mountWith([
      detail({
        staged: 2,
        modified: 2,
        untracked: 7, // 合计 11 > 6 → 默认不铺开
        changed_entries: [
          { path: 'src/a.ts', index: 'A', worktree: ' ' },
          { path: 'src/b.ts', index: 'A', worktree: ' ' },
          { path: 'src/c.ts', index: ' ', worktree: 'M' },
          { path: 'src/d.ts', index: ' ', worktree: 'M' },
          ...Array.from({ length: 7 }, (_, i) => ({
            path: `src/new-${i}.ts`,
            index: '?',
            worktree: '?',
          })),
        ],
      }),
    ]);
    await nextTick();
    expect(wrapper.findAll('.wgc-file').length).toBe(0);

    const chip = (label: string) =>
      wrapper.findAll('.wgc-group').find((c) => c.text().includes(label))!;
    await chip('已修改').trigger('click');
    expect(wrapper.findAll('.wgc-file__name').map((e) => e.text())).toEqual(['c.ts', 'd.ts']);
    // 多类可同开（点一类不会把另一类关掉）
    await chip('已暂存').trigger('click');
    expect(wrapper.findAll('.wgc-file').length).toBe(4);
    // 再点收起
    await chip('已修改').trigger('click');
    expect(wrapper.findAll('.wgc-file__name').map((e) => e.text())).toEqual(['a.ts', 'b.ts']);
    wrapper.unmount();
  });

  it('`MM`（暂存后又改）同时出现在已暂存与已修改两类', async () => {
    const wrapper = mountWith([
      detail({
        staged: 1,
        modified: 1,
        untracked: 0,
        changed_entries: [{ path: 'both.txt', index: 'M', worktree: 'M' }],
      }),
    ]);
    await nextTick();
    // 两类各开一份（同一文件两行），状态字符分别取索引列 / 工作区列
    expect(wrapper.findAll('.wgc-file__name').map((e) => e.text())).toEqual(['both.txt', 'both.txt']);
    expect(wrapper.findAll('.wgc-file__st').map((e) => e.text())).toEqual(['M', 'M']);
    wrapper.unmount();
  });

  it('明细被截断：计数取 Core 真数，并在清单末尾说明还有多少未列出', async () => {
    const wrapper = mountWith([
      detail({
        staged: 0,
        modified: 40,
        untracked: 0,
        changed_entries: Array.from({ length: 30 }, (_, i) => ({
          path: `src/f-${i}.ts`,
          index: ' ',
          worktree: 'M',
        })),
      }),
    ]);
    await nextTick();
    // chip 上是 40（真数），而不是 30（回传条数）
    const chip = wrapper.findAll('.wgc-group').find((c) => c.text().includes('已修改'))!;
    expect(chip.text()).toContain('40');
    await chip.trigger('click');
    expect(wrapper.findAll('.wgc-file').length).toBe(30);
    expect(wrapper.text()).toContain('另有 10 个未列出');
    wrapper.unmount();
  });

  it('老 Core 不发 changed_entries → 退回扁平路径表（同一套行式布局）', async () => {
    const wrapper = mountWith([
      info({ branch: 'main', modified: 2, changed_files: ['web/src/a.ts', 'b.rs'] }),
    ]);
    await nextTick();
    // 没有类别 chip（无从归类），退回一句计数全称
    expect(wrapper.findAll('.wgc-group').length).toBe(0);
    expect(wrapper.text()).toContain('已修改 2');
    expect(wrapper.findAll('.wgc-file').length).toBe(2);
    expect(wrapper.findAll('.wgc-file__st').map((e) => e.text())).toEqual(['·', '·']);
    expect(wrapper.findAll('.wgc-file__name').map((e) => e.text())).toEqual(['a.ts', 'b.rs']);
    wrapper.unmount();
  });

  it('重命名路径只展示箭头右侧（旧名留在 title 里）', async () => {
    const wrapper = mountWith([
      detail({
        staged: 1,
        modified: 0,
        untracked: 0,
        changed_entries: [{ path: 'src/old.ts -> src/new.ts', index: 'R', worktree: ' ' }],
      }),
    ]);
    await nextTick();
    expect(wrapper.findAll('.wgc-file__name').map((e) => e.text())).toEqual(['new.ts']);
    expect(wrapper.find('.wgc-file').attributes('title')).toContain('src/old.ts -> src/new.ts');
    wrapper.unmount();
  });
  // ── 冲突 / 汇总 / 过滤 / 可访问性（2026-10 拓展）──────────────────────

  it('冲突：行上红色角标 + 明细里第一个 chip，且默认铺开', async () => {
    const wrapper = mountWith([
      detail({
        staged: 1,
        modified: 1,
        untracked: 0,
        changed_entries: [{ path: 'src/conflict.ts', index: 'U', worktree: 'U' }],
      }),
    ]);
    await nextTick();
    expect(wrapper.find('.wgc-conflict').text()).toBe('!1');
    expect(wrapper.find('.wgc-conflict').attributes('title')).toContain('1 个未解决的冲突');
    // 冲突排在最前（"必须先处理"的那一类）
    expect(wrapper.findAll('.wgc-group')[0].text()).toContain('冲突');
    // 冲突条目只归入冲突类：不再同时出现在已暂存 / 已修改的清单里
    expect(wrapper.findAll('.wgc-file__name').map((e) => e.text())).toEqual(['conflict.ts']);
    expect(wrapper.find('.wgc-file__st').text()).toBe('U');
    wrapper.unmount();
  });

  it('冲突不受「改动少才自动铺开」限制：大改动也能一眼看到冲突文件', async () => {
    const wrapper = mountWith([
      detail({
        staged: 0,
        modified: 10,
        untracked: 0,
        changed_entries: [
          { path: 'src/conflict.ts', index: 'U', worktree: 'U' },
          ...Array.from({ length: 10 }, (_, i) => ({
            path: `src/m-${i}.ts`,
            index: ' ',
            worktree: 'M',
          })),
        ],
      }),
    ]);
    await nextTick();
    // 冲突铺开、已修改（10 个 > 阈值）仍保持折叠
    expect(wrapper.findAll('.wgc-file__name').map((e) => e.text())).toEqual(['conflict.ts']);
    wrapper.unmount();
  });

  it('多目录：一句汇总 + 「只看变更」把干净仓库暂时收起', async () => {
    const wrapper = mountWith([
      info({
        directory: '/srv/dirty',
        branch: 'main',
        modified: 3,
        changed_entries: [
          { path: 'a.ts', index: ' ', worktree: 'M' },
          { path: 'b.ts', index: ' ', worktree: 'M' },
          { path: 'c.ts', index: ' ', worktree: 'M' },
        ],
      }),
      info({ directory: '/srv/clean', branch: 'main' }),
    ]);
    await nextTick();
    expect(wrapper.find('.wgc-summary').text()).toContain('2 个仓库');
    expect(wrapper.find('.wgc-summary').text()).toContain('3 项变更');
    expect(wrapper.findAll('.wgc-row').length).toBe(2);

    const toggle = wrapper.find('.wgc-only-changed');
    expect(toggle.attributes('aria-pressed')).toBe('false');
    await toggle.trigger('click');
    expect(toggle.attributes('aria-pressed')).toBe('true');
    expect(wrapper.findAll('.wgc-row__name').map((e) => e.text())).toEqual(['dirty']);
    // 再点恢复：干净的仓库回到列表
    await toggle.trigger('click');
    expect(wrapper.findAll('.wgc-row__name').map((e) => e.text())).toEqual(['dirty', 'clean']);
    wrapper.unmount();
  });

  it('单目录不显示汇总行（行上已经说清了，省一行高度）', async () => {
    const wrapper = mountWith([info({ branch: 'main', modified: 1 })]);
    await nextTick();
    expect(wrapper.find('.wgc-summary').exists()).toBe(false);
    wrapper.unmount();
  });

  it('明细多时出现过滤框：按文件名过滤，命中为零时说明一句', async () => {
    const wrapper = mountWith([
      detail({
        staged: 0,
        modified: 9,
        untracked: 0,
        changed_entries: Array.from({ length: 9 }, (_, i) => ({
          path: `src/f-${i}.ts`,
          index: ' ',
          worktree: 'M',
        })),
      }),
    ]);
    await nextTick();
    // 9 个 > 自动铺开阈值 → 先点开已修改
    const chip = wrapper.findAll('.wgc-group').find((c) => c.text().includes('已修改'))!;
    await chip.trigger('click');
    expect(wrapper.findAll('.wgc-file').length).toBe(9);
    expect(wrapper.find('.wgc-search').exists()).toBe(true);

    await wrapper.find('.wgc-search').setValue('f-7');
    expect(wrapper.findAll('.wgc-file__name').map((e) => e.text())).toEqual(['f-7.ts']);
    await wrapper.find('.wgc-search').setValue('no-such-file');
    expect(wrapper.findAll('.wgc-file').length).toBe(0);
    expect(wrapper.text()).toContain('没有匹配');
    wrapper.unmount();
  });

  it('可访问性：行可聚焦、带 aria-expanded，Enter 也能展开 / 收起', async () => {
    const wrapper = mountWith([info({ branch: 'main', modified: 1 })]);
    await nextTick();
    const row = wrapper.find('.wgc-row');
    expect(row.attributes('role')).toBe('button');
    expect(row.attributes('tabindex')).toBe('0');
    // 单目录默认展开
    expect(row.attributes('aria-expanded')).toBe('true');
    await row.trigger('keydown', { key: 'Enter' });
    expect(wrapper.findAll('.wgc-detail').length).toBe(0);
    expect(wrapper.find('.wgc-row').attributes('aria-expanded')).toBe('false');
    wrapper.unmount();
  });

  it('非仓库行不是按钮（不可展开，也就不该进 Tab 序）', async () => {
    const wrapper = mountWith([info({ directory: '/srv/x', is_repo: false, error: '目录不存在' })]);
    await nextTick();
    const row = wrapper.find('.wgc-row');
    expect(row.attributes('role')).toBeUndefined();
    expect(row.attributes('tabindex')).toBeUndefined();
    wrapper.unmount();
  });

  // ── 提交时间 / stash / 单目录刷新（2026-10 拓展二）───────────────────

  it('最近提交时间按相对说法显示，精确时间留在悬停提示里', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    const wrapper = mountWith([
      info({ branch: 'main', last_commit: 'abc1234 init', last_commit_time: twoHoursAgo }),
    ]);
    await nextTick();
    const time = wrapper.find('.wgc-meta__time');
    expect(time.text()).toBe('2 小时前');
    expect(time.attributes('title')).toBe(twoHoursAgo);
    // 行提示里也有相对时间（收起态读得到）
    expect(wrapper.find('.wgc-row').attributes('title')).toContain('2 小时前');
    wrapper.unmount();
  });

  it('没有提交时间（老 Core / 空仓库）→ 不显示时间，也不显示假时间', async () => {
    const wrapper = mountWith([info({ branch: 'main', last_commit: 'abc1234 init' })]);
    await nextTick();
    expect(wrapper.find('.wgc-meta__time').exists()).toBe(false);
    expect(wrapper.find('.wgc-row').attributes('title')).not.toContain('前');
    wrapper.unmount();
  });

  it('stash 数：行上描边角标 + 展开块里也标出，悬停说明条数', async () => {
    const wrapper = mountWith([info({ branch: 'main', modified: 1, stash: 3 })]);
    await nextTick();
    expect(wrapper.find('.wgc-stash').text()).toBe('⚑3');
    expect(wrapper.find('.wgc-stash').attributes('title')).toContain('3 条 stash');
    expect(wrapper.find('.wgc-meta__stash').text()).toBe('⚑3');
    wrapper.unmount();
  });

  it('没有 stash 时不出角标（不给 0 占位置）', async () => {
    const wrapper = mountWith([info({ branch: 'main', modified: 1, stash: 0 })]);
    await nextTick();
    expect(wrapper.find('.wgc-stash').exists()).toBe(false);
    expect(wrapper.find('.wgc-meta__stash').exists()).toBe(false);
    wrapper.unmount();
  });

  it('「刷新」只重读本目录：载荷带 directories: [本目录]', async () => {
    const wrapper = mountWith([
      info({ directory: '/srv/a', branch: 'main', modified: 1 }),
      info({ directory: '/srv/b', branch: 'main' }),
    ]);
    await nextTick();
    const before = gitCalls().length;
    // 展开第一行才看到刷新图标
    await wrapper.findAll('.wgc-row')[0].trigger('click');
    const buttons = wrapper.findAll('.wgc-refresh');
    expect(buttons.length).toBe(1);
    await buttons[0].trigger('click');

    const calls = gitCalls();
    expect(calls.length).toBe(before + 1);
    expect(calls[calls.length - 1].RequestWorkspaceGitStatus.directories).toEqual(['/srv/a']);
    wrapper.unmount();
  });

  it('单目录刷新期间只有本目录进入忙碌态，整卡按钮不受影响', async () => {
    const wrapper = mountWith([info({ directory: '/srv/a', branch: 'main', modified: 1 })]);
    await nextTick();
    await wrapper.find('.wgc-refresh').trigger('click');
    // 图标按钮没有文字：忙碌态看 aria-label / aria-disabled，转动由
    // `.wgc-refresh__spin` 承担（这里只钉语义，不钉动画）。
    expect(wrapper.find('.wgc-refresh').attributes('aria-label')).toBe('正在读取该目录的 git 状态');
    expect(wrapper.find('.wgc-refresh').attributes('aria-disabled')).toBe('true');
    expect(wrapper.find('.wgc-refresh__spin').exists()).toBe(true);
    expect(wrapper.find('button').attributes('aria-label')).toBe('刷新 git 状态');
    expect(wrapper.find('button').attributes('aria-busy')).toBeUndefined();
    wrapper.unmount();
  });

  it('整卡刷新不带 directories（= 全部目录，老 Core 也照旧能用）', async () => {
    const wrapper = mountWith([info({ branch: 'main' })]);
    await nextTick();
    await wrapper.find('button').trigger('click');
    const calls = gitCalls();
    expect(calls[calls.length - 1].RequestWorkspaceGitStatus.directories).toBeUndefined();
    wrapper.unmount();
  });

  it('单目录刷新的忙碌态在快照到达后收掉（不永久转圈）', async () => {
    const wrapper = mountWith([info({ directory: '/srv/a', branch: 'main', modified: 1 })]);
    await nextTick();
    await wrapper.find('.wgc-refresh').trigger('click');
    expect(wrapper.find('.wgc-refresh').attributes('aria-label')).toBe('正在读取该目录的 git 状态');
    // 新快照到达
    wsStore.gitBySession = {
      [sessionKey(null, 'core')]: [info({ directory: '/srv/a', branch: 'main' })],
    };
    notifyChanged();
    await nextTick();
    expect(wrapper.find('.wgc-refresh').attributes('aria-label')).toBe('只刷新这个目录的 git 状态');
    expect(wrapper.find('.wgc-refresh__spin').exists()).toBe(false);
    wrapper.unmount();
  });
});
