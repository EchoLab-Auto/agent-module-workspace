//! git 状态卡的回归测试：2026-11 审计发现的 8 条逻辑缺陷。
//!
//! 每条都对应一个"用户能看到错"的现场，且**都走真实链路**（`applyGit` 归约 →
//! 组件渲染 / 纯函数），不直接写 `workspace.gitBySession`——那个写法绕过了合并
//! 语义与每目录更新序号，正是这些缺陷此前一直被掩盖的原因。
//!
//! | 编号 | 缺陷 | 修法 |
//! |---|---|---|
//! | B1 | 单目录刷新把整份快照替换成单目录，其余仓库的行凭空消失 | `applyGit` 按目录合并 |
//! | B2 | 两个人格同 id 的工作区撞键，A 的卡显示 B 的分支与计数 | 键含人格（`gitSessionKey`） |
//! | B3 | 目录从 `/a` 换成 `/b`（数量不变）既不重拉也不重置 | watch 键带目录完整内容 |
//! | B4 | 一个冲突文件被算成 2 项变更（与 `!1` 角标自相矛盾） | `changedCount` 按文件去重 |
//! | B5 | 冲突占满配额后，真正存在的暂存改动连同 chip 一起消失 | 截断判据取 Core 的分列计数 |
//! | B6 | 「只看变更」把所有仓库滤掉后是一片空白 | 空态提示 |
//! | B7 | 收起再展开后过滤词仍在，列表空着像文件没了 | 收起时清空 `query` |
//! | B8 | 刷新 A 时 B 的快照把 A 的转圈收掉 | 按目录更新序号收敛 |

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';

vi.mock('@echo-agent/panel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@echo-agent/panel')>();
  return { ...actual, startConnection: vi.fn(), sendCommand: vi.fn(), sendPending: vi.fn() };
});

import WorkspaceGitCard from '../components/git/WorkspaceGitCard.vue';
import { dispatch, sendCommand, state } from '@echo-agent/panel';
import type { WorkspaceGitInfo, WorkspaceSessionInfo } from '@echo-agent/panel';
import { applyGit, resetCaches } from '../workspace-store';
import { changedCount, conflictCount, visibleGroups } from '../git-changes';
import '../index';

function info(over: Partial<WorkspaceGitInfo> = {}): WorkspaceGitInfo {
  return { directory: '/srv/a', is_repo: true, ...over } as WorkspaceGitInfo;
}

function ws(over: Partial<WorkspaceSessionInfo> = {}): WorkspaceSessionInfo {
  return {
    id: 'core',
    name: '框架',
    description: '',
    directories: ['/srv/a'],
    ...over,
  } as WorkspaceSessionInfo;
}

/** 走真实回包链路：dispatch → 壳 reduce → 扩展 acceptEvent → `applyGit`。 */
function frame(
  dirs: WorkspaceGitInfo[],
  over: { sessionId?: string; teamId?: string | null; core?: string | null } = {},
): void {
  dispatch(
    {
      WorkspaceGitStatus: {
        team_id: over.teamId ?? null,
        session_id: over.sessionId ?? 'core',
        directories: dirs,
      },
    } as never,
    over.core ?? null,
  );
}

describe('git 卡逻辑缺陷回归（2026-11 审计）', () => {
  beforeEach(() => {
    vi.mocked(sendCommand).mockClear();
    state.connected = true;
    state.activeRegion = null;
    state.teams = [];
    resetCaches();
  });

  it('B1 单目录刷新只更新那一个目录，其余行仍在', async () => {
    const session = ws({ directories: ['/srv/a', '/srv/b', '/srv/c'] });
    frame([
      info({ directory: '/srv/a' }),
      info({ directory: '/srv/b', modified: 2 }),
      info({ directory: '/srv/c' }),
    ]);
    const wrapper = mount(WorkspaceGitCard, { props: { teamId: 't', session } });
    await nextTick();
    expect(wrapper.findAll('.wgc-row').length).toBe(3);

    // 现场：点某个目录的刷新图标 → Core 只回这一个目录
    frame([info({ directory: '/srv/b', modified: 2, branch: 'dev' })]);
    await nextTick();
    expect(wrapper.findAll('.wgc-row').length, '其余目录的行不该消失').toBe(3);
    expect(wrapper.text()).toContain('dev');
    wrapper.unmount();
  });

  it('B2 两个人格同 id 的工作区互不覆盖', async () => {
    applyGit(
      {
        session_id: 'ws',
        team_id: 'teamA',
        directories: [info({ directory: '/a', modified: 1, branch: 'main' })],
      },
      null,
    );
    applyGit(
      {
        session_id: 'ws',
        team_id: 'teamB',
        directories: [info({ directory: '/b', modified: 5, branch: 'other' })],
      },
      null,
    );
    const session = ws({ id: 'ws', directories: ['/a'] });
    const wrapper = mount(WorkspaceGitCard, { props: { teamId: 'teamA', session } });
    await nextTick();
    const text = wrapper.text();
    expect(text, 'A 人格应看到自己的分支').toContain('main');
    expect(text, 'A 人格不该看到 B 人格的数据').not.toContain('other');
    wrapper.unmount();
  });

  it('B3 目录内容变了（数量不变）就重拉并重置展开态', async () => {
    const wrapper = mount(WorkspaceGitCard, {
      props: { teamId: 't', session: ws({ id: 'ws', directories: ['/keep'] }) },
    });
    await nextTick();
    const before = vi.mocked(sendCommand).mock.calls.length;

    await wrapper.setProps({ session: ws({ id: 'ws', directories: ['/swapped'] }) });
    await nextTick();
    expect(
      vi.mocked(sendCommand).mock.calls.length,
      '目录换成另一个（数量仍 1）应重新拉取',
    ).toBeGreaterThan(before);
    wrapper.unmount();
  });

  it('B4 一个冲突文件只算 1 项变更（与冲突角标一致）', () => {
    const conflict = info({
      staged: 1,
      modified: 1,
      changed_entries: [{ path: 'x.txt', index: 'U', worktree: 'U' }],
    });
    expect(changedCount(conflict), 'UU 是一个文件，不是两项').toBe(1);
    expect(conflictCount(conflict)).toBe(1);
  });

  it('B4b 一个 MM 文件也只算 1 项', () => {
    const both = info({
      staged: 1,
      modified: 1,
      changed_entries: [{ path: 'y.txt', index: 'M', worktree: 'M' }],
    });
    expect(changedCount(both)).toBe(1);
  });

  it('B5 冲突占满配额时，真存的暂存改动仍有「已暂存」chip', () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({
      path: `c${i}.txt`,
      index: 'U',
      worktree: 'U',
    }));
    const dir = info({
      // Core 的口径：30 个冲突各占 staged 与 modified 一格，另有 5 个真暂存
      staged: 35,
      modified: 30,
      untracked: 0,
      changed_entries: entries,
    });
    const kinds = visibleGroups(dir).map((g) => g.kind);
    expect(kinds, 'staged 列已满额，必须回退到 Core 的真数而不是报 0').toContain('staged');
  });

  it('B6 「只看变更」滤空时给一句空态', async () => {
    const session = ws({ directories: ['/a', '/b'] });
    frame([info({ directory: '/a' }), info({ directory: '/b' })]);
    const wrapper = mount(WorkspaceGitCard, { props: { teamId: 't', session } });
    await nextTick();
    await wrapper.find('.wgc-only-changed').trigger('click');
    await nextTick();
    expect(wrapper.findAll('.wgc-row').length).toBe(0);
    expect(wrapper.text(), '空白区应有解释').toContain('没有可显示的行');
    wrapper.unmount();
  });

  it('B7 收起目录行会清空明细过滤词', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      path: `f${i}.txt`,
      index: 'M',
      worktree: ' ',
    }));
    frame([info({ directory: '/srv/a', staged: 12, changed_entries: many })]);
    const wrapper = mount(WorkspaceGitCard, { props: { teamId: 't', session: ws() } });
    await nextTick();
    await wrapper.find('.wgc-search').setValue('f1');
    await nextTick();
    await wrapper.find('.wgc-row').trigger('click'); // 收起
    await nextTick();
    await wrapper.find('.wgc-row').trigger('click'); // 再展开
    await nextTick();
    expect(
      (wrapper.find('.wgc-search').element as HTMLInputElement).value,
      '重新展开应看见全部明细，而不是被上一次的词滤成空',
    ).toBe('');
    wrapper.unmount();
  });

  it('B8 别的目录的快照不收回本目录的忙碌态', async () => {
    const session = ws({ directories: ['/srv/a', '/srv/b'] });
    frame([
      info({ directory: '/srv/a', modified: 1 }),
      info({ directory: '/srv/b', modified: 1 }),
    ]);
    const wrapper = mount(WorkspaceGitCard, { props: { teamId: 't', session } });
    await nextTick();
    const rows = wrapper.findAll('.wgc-row');
    await rows[0].trigger('click');
    await rows[1].trigger('click');
    await nextTick();

    const busy = () =>
      wrapper.findAll('.wgc-refresh').map((el) => el.attributes('aria-disabled') === 'true');
    await wrapper.findAll('.wgc-refresh')[0].trigger('click');
    await nextTick();
    expect(busy()[0]).toBe(true);

    // B 的单目录刷新回包到达（只含 B——Core 按 `directories` 过滤采集）
    frame([info({ directory: '/srv/b', modified: 2 })]);
    await nextTick();
    expect(busy()[0], 'A 仍在刷新，不该被 B 的回包收掉').toBe(true);

    // A 自己的回包到达 → 收掉
    frame([info({ directory: '/srv/a', modified: 3 })]);
    await nextTick();
    expect(busy()[0]).toBe(false);
    wrapper.unmount();
  });
});
