//! git 状态卡的**展开态**（目录行展开 + 按类别展开明细）。
//!
//! 为什么单独成文件：这套状态有两条独立的"自动 vs 手动"规则（单目录默认展开、
//! 小改动自动铺开），规则一多，"点一下会不会把别的类一起关掉"就成了最容易出
//! bug 的地方；把它从 800 行组件里拿出来，行为和断言才对得上。
//!
//! 两条规则共用同一个模式——**未动过时按推断说话，动过之后以用户为准**：
//!
//! | 状态 | 未动过（推断） | 动过（照做） |
//! |---|---|---|
//! | 目录行的展开 | 工作区只有一个目录就展开 | `rows` 里有什么就是什么 |
//! | 某类明细的展开 | 改动 ≤ [`AUTO_OPEN_TOTAL`] 或**有冲突**就铺开 | `groups` 里有什么就是什么 |
//!
//! 冲突类不受"改动数"限制：有冲突就要铺开（那是必须先处理的东西，藏起来只
//! 会让人以为工作区没大事）。

import { ref } from 'vue';
import type { WorkspaceGitInfo } from '@echo-agent/panel';
import { AUTO_OPEN_TOTAL, changedCount, conflictCount, countOf, type ChangeKind } from '../../git-changes';

/** 类别开关的键（同一个目录内按类别区分；多个目录可同开）。 */
function groupKey(directory: string, kind: ChangeKind): string {
  return `${directory}#${kind}`;
}

export function useGitExpansion(dirs: { readonly value: readonly WorkspaceGitInfo[] }) {
  const rows = ref<Set<string>>(new Set());
  /** 用户是否动过目录行的展开态。 */
  const rowsTouched = ref(false);
  /** 用户展开着的类别明细。 */
  const groups = ref<Set<string>>(new Set());
  /** 动过类别开关的目录（动过之后该目录就按 `groups` 说话）。 */
  const groupsTouched = ref<Set<string>>(new Set());

  /** 单目录工作区默认展开（单仓项目占比最高，那正是想看细节的场景）。 */
  function defaultRows(): Set<string> {
    return dirs.value.length === 1 ? new Set([dirs.value[0].directory]) : new Set<string>();
  }

  function isRowOpen(dir: WorkspaceGitInfo): boolean {
    if (rowsTouched.value) return rows.value.has(dir.directory);
    return dirs.value.length === 1;
  }

  function toggleRow(dir: WorkspaceGitInfo): void {
    const next = new Set(rowsTouched.value ? rows.value : defaultRows());
    rowsTouched.value = true;
    if (next.has(dir.directory)) next.delete(dir.directory);
    else next.add(dir.directory);
    rows.value = next;
  }

  /** 未动过开关时：小改动直接铺开；冲突不论多少个都铺开。 */
  function autoOpen(dir: WorkspaceGitInfo, kind: ChangeKind): boolean {
    if (kind === 'conflicted') return conflictCount(dir) > 0;
    return changedCount(dir) <= AUTO_OPEN_TOTAL;
  }

  function isGroupOpen(dir: WorkspaceGitInfo, kind: ChangeKind): boolean {
    if (groupsTouched.value.has(dir.directory)) return groups.value.has(groupKey(dir.directory, kind));
    return autoOpen(dir, kind);
  }

  function toggleGroup(dir: WorkspaceGitInfo, kind: ChangeKind): void {
    const next = new Set(groups.value);
    if (!groupsTouched.value.has(dir.directory)) {
      // 首次点某个类别：先把「自动铺开」的现状落成显式状态，本次点击才有确定
      // 含义（否则点开一类会把其他类一起关掉似的，看着像 bug）。
      groupsTouched.value = new Set(groupsTouched.value).add(dir.directory);
      for (const candidate of ['conflicted', 'staged', 'modified', 'untracked'] as ChangeKind[]) {
        const key = groupKey(dir.directory, candidate);
        if (autoOpen(dir, candidate) && countOf(dir, candidate) > 0) next.add(key);
        else next.delete(key);
      }
    }
    const key = groupKey(dir.directory, kind);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    groups.value = next;
  }

  /** 切会话 / 目录集变化：旧会话的行与本会话对不上，全部重置。 */
  function reset(): void {
    rows.value = new Set();
    rowsTouched.value = false;
    groups.value = new Set();
    groupsTouched.value = new Set();
  }

  return { isRowOpen, toggleRow, isGroupOpen, toggleGroup, reset };
}
