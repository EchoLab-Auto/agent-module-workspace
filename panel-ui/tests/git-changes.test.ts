//! `git-changes.ts` 的纯函数契约。
//!
//! 这些判断原来散在 800 行的卡片里（归类 / 计数 / 路径裁剪），只能靠整卡挂载
//! 间接验证。抽出来之后逐条钉住：
//!
//! - **冲突**（porcelain unmerged）单独成类，不再被算成"已暂存 + 已修改"；
//! - 冲突不受"改动少才自动铺开"的限制（那是 `git-expansion.ts` 的事，这里锁
//!   归类的输入）；
//! - 计数在"明细被截断"与"老 Core 不发明细"两种退化路径上都退回正确的来源；
//! - 长路径只留末两段，文件名不参与收缩。

import { describe, expect, it } from 'vitest';
import type { WorkspaceGitInfo } from '@echo-agent/panel';
import {
  AUTO_OPEN_TOTAL,
  ENTRY_CAP,
  basename,
  changedCount,
  conflictCount,
  conflictUnknown,
  countOf,
  dirPart,
  displayPath,
  dupNames,
  extrasLabel,
  groupRows,
  isConflict,
  kindsOf,
  letterOf,
  matchesQuery,
  namePart,
  nodeOf,
  parentOf,
  parentTail,
  relativeTime,
  repoSummary,
  summary,
  tailDir,
  visibleGroups,
} from '../git-changes';

function info(over: Partial<WorkspaceGitInfo> = {}): WorkspaceGitInfo {
  return { directory: '/srv/core', is_repo: true, ...over } as WorkspaceGitInfo;
}

function entry(path: string, index: string, worktree: string) {
  return { path, index, worktree };
}

describe('git-changes（git 状态卡的纯函数层）', () => {
  describe('冲突识别', () => {
    it('porcelain 的 7 种 unmerged 组合都算冲突', () => {
      for (const [index, worktree] of [
        ['U', 'U'],
        ['A', 'A'],
        ['D', 'D'],
        ['A', 'U'],
        ['U', 'A'],
        ['D', 'U'],
        ['U', 'D'],
      ]) {
        expect(isConflict(entry('x', index, worktree))).toBe(true);
      }
    });

    it('`AD` / `DA` / `MM` 不是冲突（索引新增+工作区删除 ≠ 合并冲突）', () => {
      expect(isConflict(entry('x', 'A', 'D'))).toBe(false);
      expect(isConflict(entry('x', 'D', 'A'))).toBe(false);
      expect(isConflict(entry('x', 'M', 'M'))).toBe(false);
      expect(isConflict(entry('x', '?', '?'))).toBe(false);
    });

    it('冲突条目只归入 conflicted（不再同时算作已暂存 + 已修改）', () => {
      expect(kindsOf(entry('x', 'U', 'U'))).toEqual(['conflicted']);
      // 非冲突的两列字符仍按列归类
      expect(kindsOf(entry('x', 'M', 'M'))).toEqual(['staged', 'modified']);
      expect(kindsOf(entry('x', 'A', ' '))).toEqual(['staged']);
      expect(kindsOf(entry('x', ' ', 'M'))).toEqual(['modified']);
      expect(kindsOf(entry('x', '?', '?'))).toEqual(['untracked']);
    });
  });

  describe('计数来源', () => {
    it('明细未截断 → 以明细为准，冲突不从另外两类重复计', () => {
      const dir = info({
        staged: 1,
        modified: 1,
        untracked: 0,
        changed_entries: [entry('conflict.ts', 'U', 'U')],
      });
      expect(countOf(dir, 'conflicted')).toBe(1);
      expect(countOf(dir, 'staged')).toBe(0);
      expect(countOf(dir, 'modified')).toBe(0);
    });

    it('某类明细满额 → 退回 Core 的真数（其余未回传）', () => {
      const dir = info({
        modified: 40,
        changed_entries: Array.from({ length: ENTRY_CAP }, (_, i) =>
          entry(`f-${i}.ts`, ' ', 'M'),
        ),
      });
      expect(countOf(dir, 'modified')).toBe(40);
    });

    it('老 Core 不发明细 → 只有 Core 的计数可用，冲突数不可知', () => {
      const dir = info({ staged: 2, modified: 3, untracked: 1 });
      expect(countOf(dir, 'staged')).toBe(2);
      expect(countOf(dir, 'modified')).toBe(3);
      expect(countOf(dir, 'untracked')).toBe(1);
      expect(countOf(dir, 'conflicted')).toBe(0);
      // 有变更却没有明细 → "没报冲突"不能当成"没有冲突"
      expect(conflictUnknown(dir)).toBe(true);
    });

    it('干净仓库不算"冲突未知"', () => {
      expect(conflictUnknown(info())).toBe(false);
    });

    it('changedCount 保持旧口径（徽标 / 行计数与面板侧一致）', () => {
      expect(changedCount(info({ staged: 2, modified: 3, untracked: 1 }))).toBe(6);
      // 老 Core 的缺省字段按 0 处理
      expect(changedCount(info())).toBe(0);
    });
  });

  describe('分组与文案', () => {
    it('分组顺序：冲突最先，其余按一次提交的推进顺序', () => {
      const dir = info({
        staged: 1,
        modified: 1,
        changed_entries: [
          entry('c.ts', 'U', 'U'),
          entry('a.ts', 'A', ' '),
          entry('b.ts', ' ', 'M'),
        ],
      });
      expect(groupRows(dir).map((g) => g.kind)).toEqual([
        'conflicted',
        'staged',
        'modified',
        'untracked',
      ]);
      // 计数为 0 的类不占位置
      expect(visibleGroups(dir).map((g) => g.label)).toEqual(['冲突', '已暂存', '已修改']);
    });

    it('行首字符：冲突取非空那一列，未跟踪恒为 `?`', () => {
      expect(letterOf(entry('x', 'U', 'U'), 'conflicted')).toBe('U');
      expect(letterOf(entry('x', 'A', 'U'), 'conflicted')).toBe('A');
      expect(letterOf(entry('x', '?', '?'), 'untracked')).toBe('?');
      expect(letterOf(entry('x', ' ', 'M'), 'modified')).toBe('M');
    });

    it('summary 把冲突放在最前；干净仓库是一句「工作区干净」', () => {
      const dir = info({
        staged: 1,
        modified: 2,
        changed_entries: [entry('c.ts', 'U', 'U'), entry('a.ts', ' ', 'M')],
      });
      expect(summary(dir)).toBe('冲突 1 · 已暂存 1 · 已修改 2');
      expect(summary(info())).toBe('工作区干净');
    });

    it('repoSummary 只统计真实仓库', () => {
      expect(
        repoSummary([
          info({ staged: 1, changed_entries: [entry('a.ts', 'A', ' ')] }),
          info({ directory: '/srv/x', is_repo: false, error: '目录不存在' }),
          info({ directory: '/srv/b', modified: 3, changed_entries: [entry('u.ts', 'U', 'U')] }),
        ]),
      ).toEqual({ repos: 2, changes: 4, conflicts: 1 });
    });

    it('自动铺开阈值是小型改动（≤ 6 个文件）', () => {
      expect(AUTO_OPEN_TOTAL).toBe(6);
    });
  });

  describe('路径裁剪', () => {
    it('目录名取末段；跨机路径先剥掉 node://host', () => {
      expect(basename('/w/echo-agent-core/source/')).toBe('source');
      expect(basename('node://gpu/root/repo')).toBe('repo');
      expect(parentOf('/w/echo-agent-core/source')).toBe('/w/echo-agent-core');
      expect(parentOf('node://gpu/root/repo')).toBe('/root');
      expect(parentTail('/w/echo-agent-core/source')).toBe('echo-agent-core');
      expect(nodeOf('node://gpu/root/repo')).toBe('gpu');
      expect(nodeOf('/srv/core')).toBeNull();
    });

    it('目录前缀只留末两段（前段是信息量最低的）', () => {
      expect(tailDir('web/src/components/')).toBe('…/src/components/');
      expect(tailDir('web/src/')).toBe('web/src/');
      expect(tailDir('')).toBe('');
      expect(dirPart('web/src/a.ts')).toBe('web/src/');
      expect(namePart('web/src/a.ts')).toBe('a.ts');
    });

    it('重命名只展示箭头右侧（旧名留在 title 里）', () => {
      expect(displayPath('src/old.ts -> src/new.ts')).toBe('src/new.ts');
      expect(namePart('src/old.ts -> src/new.ts')).toBe('new.ts');
      expect(displayPath('src/plain.ts')).toBe('src/plain.ts');
    });

    it('同名目录只给重名的加消歧后缀', () => {
      const dirs = [
        info({ directory: '/w/core/source' }),
        info({ directory: '/w/panel/source' }),
        info({ directory: '/w/ui-frame' }),
      ];
      expect([...dupNames(dirs)].sort()).toEqual(['source']);
    });

    it('过滤词为空命中全部；否则按路径子串（忽略大小写）', () => {
      expect(matchesQuery('web/src/A.ts', '')).toBe(true);
      expect(matchesQuery('web/src/A.ts', 'a.TS')).toBe(true);
      expect(matchesQuery('web/src/A.ts', 'zzz')).toBe(false);
    });
  });

  it('冲突数只从明细来（协议里没有这一列）', () => {
    expect(conflictCount(info({ staged: 5 }))).toBe(0);
    expect(conflictCount(info({ changed_entries: [entry('x', 'U', 'U')] }))).toBe(1);
  });

  describe('提交时间的相对说法', () => {
    const NOW = Date.parse('2026-10-19T12:00:00Z');
    const at = (ago: number) => new Date(NOW - ago).toISOString();

    it('按分 / 时 / 天 / 月 / 年分档', () => {
      expect(relativeTime(at(30 * 1000), NOW)).toBe('刚刚');
      expect(relativeTime(at(3 * 60 * 1000), NOW)).toBe('3 分钟前');
      expect(relativeTime(at(2 * 3600 * 1000), NOW)).toBe('2 小时前');
      expect(relativeTime(at(5 * 24 * 3600 * 1000), NOW)).toBe('5 天前');
      expect(relativeTime(at(70 * 24 * 3600 * 1000), NOW)).toBe('2 个月前');
      expect(relativeTime(at(400 * 24 * 3600 * 1000), NOW)).toBe('1 年前');
    });

    it('缺值 / 无法解析 → null（调用方不显示，不显示假时间）', () => {
      expect(relativeTime(null, NOW)).toBeNull();
      expect(relativeTime(undefined, NOW)).toBeNull();
      expect(relativeTime('', NOW)).toBeNull();
      expect(relativeTime('not-a-time', NOW)).toBeNull();
    });

    it('未来时间（跨机时钟不同步）不说「负 3 分钟前」', () => {
      expect(relativeTime(at(-90 * 1000), NOW)).toBe('刚刚');
    });

    it('extrasLabel 汇总 stub 与时间；没有列表零', () => {
      expect(extrasLabel(info({ stash: 2, last_commit_time: at(3600 * 1000) }), NOW)).toEqual({
        stash: 2,
        time: '1 小时前',
      });
      expect(extrasLabel(info(), NOW)).toEqual({ stash: 0, time: null });
    });
  });
});
