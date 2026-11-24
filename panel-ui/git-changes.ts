//! git 状态卡的**纯函数层**（不碰 Vue、不碰 DOM，可单测）。
//!
//! 为什么单独成文件：这张卡原来 800 行里有一半是"porcelain 两列字符怎么归类""长
//! 路径怎么裁"这类纯计算。它们夹在组件的 ref/watch/展开态之间，改一处得到组件里
//! 找半天，测试也只能整卡挂载。抽出来之后组件只剩"取数据 + 摆版面"，这些判断
//! 各有一条独立断言。
//!
//! ## 归类是展示侧的决定
//!
//! 协议只传事实（两列 porcelain 字符 + 三类计数），不传"这属于哪一类"。原因：
//! 一个文件可以同时落在两类（`MM` = 暂存后又改），也可以是**冲突**（`UU`/`AA`/
//! `DD`…，porcelain 里叫 unmerged）——冲突条目在 Core 的计数里同时算进"已暂存"
//! 与"已修改"，但用户看到的第一件事应该是"有冲突要解决"，而不是"有两个已暂存
//! 文件"。所以这里给出第四类 `conflicted`，且冲突条目**只**归入它。
//!
//! ## 计数从哪来
//!
//! Core 每类最多回传 [`ENTRY_CAP`] 条明细（防未跟踪产物刷屏把暂存改动挤掉）。
//! 因此：明细没被截断时**以明细为准**（这样冲突条目不会被重复算进另外两类）；
//! 一旦某类回传满额，就退回 Core 报的真数（详情见 [`countOf`]）。

import type { WorkspaceChangedEntry, WorkspaceGitInfo } from '@echo-agent/panel';

/** 一类变更。`conflicted` 是本卡新增的第四类（Core 的计数里没有这一列）。 */
export type ChangeKind = 'conflicted' | 'staged' | 'modified' | 'untracked';

/** 展示顺序：冲突最先（必须处理），然后按一次提交的推进顺序（越靠前越接近提交）。 */
export const CHANGE_KINDS: readonly { kind: ChangeKind; label: string }[] = [
  { kind: 'conflicted', label: '冲突' },
  { kind: 'staged', label: '已暂存' },
  { kind: 'modified', label: '已修改' },
  { kind: 'untracked', label: '未跟踪' },
];

/**
 * porcelain v1 的 unmerged 状态组合（X 列 + Y 列）。
 *
 * 取自 `git status` 文档里 "Unmerged paths" 一节：`DD`/`AA`/`UU` 是双方都改
 * （或删），`AU`/`UA`/`DU`/`UD` 是一方改动另一方删除。注意 `AD`/`DA` **不是**
 * 冲突（索引新增、工作区删除），别顺手把"含 D 或 A"都算进去。
 */
const CONFLICT_CODES = new Set(['DD', 'AA', 'UU', 'AU', 'UA', 'DU', 'UD']);

/** 变更总数不超过此值时，展开目录行后**自动铺开**明细。 */
export const AUTO_OPEN_TOTAL = 6;

/**
 * Core 每类明细的回传上限（与 `crates/.../git.rs::CHANGED_FILES_CAP` 对齐）。
 *
 * 只用来判断"明细是否被截断"：某类恰好回传满额就说明还有没列出来的，计数得
 * 退回 Core 的真数。
 */
export const ENTRY_CAP = 30;

/** 一类变更的展示单元。 */
export interface GroupRow {
  kind: ChangeKind;
  label: string;
  /** 该类的总条数（明细被截断时仍是真数）。 */
  count: number;
  /** 已回传的明细（可能少于 `count`）。 */
  entries: { path: string; letter: string }[];
  /** 明细之外还剩多少条（`count - entries.length`）。 */
  more: number;
}

function chars(entry: { index?: string; worktree?: string }): [string, string] {
  return [(entry.index ?? '').trim(), (entry.worktree ?? '').trim()];
}

/** 该条明细是否是一个**未解决的冲突**。 */
export function isConflict(entry: { index?: string; worktree?: string }): boolean {
  const [x, y] = chars(entry);
  return CONFLICT_CODES.has(`${x}${y}`);
}

/** 一条明细属于哪几类（冲突条目只属 `conflicted`；`MM` 同属暂存与修改）。 */
export function kindsOf(entry: WorkspaceChangedEntry): ChangeKind[] {
  if (isConflict(entry)) return ['conflicted'];
  const [index, worktree] = chars(entry);
  if (index === '?' && worktree === '?') return ['untracked'];
  const kinds: ChangeKind[] = [];
  if (index && index !== '?') kinds.push('staged');
  if (worktree && worktree !== '?') kinds.push('modified');
  return kinds;
}

function entriesOf(dir: WorkspaceGitInfo, kind: ChangeKind): WorkspaceChangedEntry[] {
  return (dir.changed_entries ?? []).filter((entry) => kindsOf(entry).includes(kind));
}

/** 该类在快照里的总条数。 */
export function countOf(dir: WorkspaceGitInfo, kind: ChangeKind): number {
  const entries = dir.changed_entries ?? [];
  const listed = entriesOf(dir, kind).length;
  if (kind === 'conflicted') {
    // 协议里没有"冲突数"这一列：老 Core 也不发 `changed_entries`。两个来源都
    // 没有时只能报 0（"看不到冲突"，而不是"没有冲突"，见 `conflictUnknown`）。
    return listed;
  }
  const reported = kind === 'staged' ? dir.staged : kind === 'modified' ? dir.modified : dir.untracked;
  // 老 Core / 跨机老对端：没有明细可数，只有计数。
  if (!entries.length) return reported ?? 0;
  // 明细被截断（满额）：只有 Core 知道真数。
  return listed >= ENTRY_CAP ? (reported ?? 0) : listed;
}

/** 变更文件总数（行右侧的数字 / 干净判定；口径与边栏徽标一致）。 */
export function changedCount(dir: WorkspaceGitInfo): number {
  return (dir.staged ?? 0) + (dir.modified ?? 0) + (dir.untracked ?? 0);
}

/** 冲突条数（只在有明细时可知）。 */
export function conflictCount(dir: WorkspaceGitInfo): number {
  return countOf(dir, 'conflicted');
}

/**
 * 明细可能被截断 / 缺失时，"没有冲突"这个结论是否可疑。
 *
 * 明细一条都没有 = 老 Core（不发明细）或跨机老对端：此时冲突不可知，UI 不该
 * 因为"没报冲突"就让人以为干净。
 */
export function conflictUnknown(dir: WorkspaceGitInfo): boolean {
  return !(dir.changed_entries ?? []).length && changedCount(dir) > 0;
}

/** 行首状态字符（未跟踪恒为 `?`；冲突取两列里非空格的那个）。 */
export function letterOf(entry: WorkspaceChangedEntry, kind: ChangeKind): string {
  const [index, worktree] = chars(entry);
  if (kind === 'untracked') return '?';
  if (kind === 'conflicted') return index || worktree || '!';
  return (kind === 'staged' ? index : worktree) || 'M';
}

/** 三类（或四类）分组，含计数与已回传明细；没有明细时返回空表（老 Core 路径）。 */
export function groupRows(dir: WorkspaceGitInfo): GroupRow[] {
  const entries = dir.changed_entries ?? [];
  if (!entries.length) return [];
  return CHANGE_KINDS.map(({ kind, label }) => {
    const picked = entriesOf(dir, kind);
    const count = countOf(dir, kind);
    return {
      kind,
      label,
      count,
      entries: picked.map((entry) => ({ path: entry.path, letter: letterOf(entry, kind) })),
      more: Math.max(0, count - picked.length),
    };
  });
}

/** 非空类别（计数为 0 的类不占位置）。 */
export function visibleGroups(dir: WorkspaceGitInfo): GroupRow[] {
  return groupRows(dir).filter((group) => group.count > 0 || group.entries.length > 0);
}

/** 一行文字：「冲突 1 · 已暂存 3 · 已修改 5」；全零时是「工作区干净」。 */
export function summary(dir: WorkspaceGitInfo): string {
  const parts: string[] = [];
  const conflicts = conflictCount(dir);
  if (conflicts) parts.push(`冲突 ${conflicts}`);
  if (dir.staged) parts.push(`已暂存 ${dir.staged}`);
  if (dir.modified) parts.push(`已修改 ${dir.modified}`);
  if (dir.untracked) parts.push(`未跟踪 ${dir.untracked}`);
  return parts.length ? parts.join(' · ') : '工作区干净';
}

/** 多目录卡片顶部的一句汇总（单目录不显示：行上已经说清了）。 */
export function repoSummary(dirs: readonly WorkspaceGitInfo[]): {
  repos: number;
  changes: number;
  conflicts: number;
} {
  let repos = 0;
  let changes = 0;
  let conflicts = 0;
  for (const dir of dirs) {
    if (!dir.is_repo) continue;
    repos += 1;
    changes += changedCount(dir);
    conflicts += conflictCount(dir);
  }
  return { repos, changes, conflicts };
}

/** 目录的显示名：取末段（`node://host/a/b` → `b`）。 */
export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.split('/').filter(Boolean).pop() ?? path;
}

/**
 * 父目录（不含末段）。去掉 `node://host` 前缀后取 dirname——`node://` 的两段
 * 会被当路径段混进父目录里，先剥掉再算。
 */
export function parentOf(path: string): string {
  const remote = path.startsWith('node://');
  const local = remote ? path.slice(7).split('/').slice(1).join('/') : path;
  const trimmed = local.replace(/\/+$/, '');
  const cut = trimmed.lastIndexOf('/');
  if (cut <= 0) return '';
  const parent = trimmed.slice(0, cut);
  // 本机路径自带前导 `/`；跨机路径剥掉 `node://host` 后要以 `/` 补回
  return remote ? `/${parent}` : parent;
}

/** 父目录最后一段（同名目录的消歧后缀）。 */
export function parentTail(path: string): string {
  return parentOf(path).split('/').filter(Boolean).pop() ?? '';
}

/** 目录是否跨机（`node://` 前缀）→ 返回节点名。 */
export function nodeOf(directory: string): string | null {
  return directory.startsWith('node://') ? (directory.slice(7).split('/')[0] ?? null) : null;
}

/**
 * 重名目录的集合（basename 冲突）。
 *
 * 工作区常把多个仓库的 `source/` 子目录并列为目录（本机实测 5 个目录里就有
 * 两个叫 `source`），收起态只显示末段时无法区分——冲突时补一段父目录的末段
 * （`source / echo-agent-core`）作为消歧，唯一的目录不加（省宽度）。
 */
export function dupNames(dirs: readonly WorkspaceGitInfo[]): Set<string> {
  const counts = new Map<string, number>();
  for (const dir of dirs) {
    const name = basename(dir.directory);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n > 1).map(([name]) => name));
}

/**
 * 路径切成「目录前缀」与「文件名」两段（前者含末尾 `/`）。
 *
 * 重命名 / 复制（porcelain 的 `旧 -> 新`）只取箭头右侧：旧名对"现在改的是
 * 哪个文件"没有帮助，全量原样留在 `title` 里。
 */
export function displayPath(path: string): string {
  const arrow = path.lastIndexOf(' -> ');
  return arrow < 0 ? path : path.slice(arrow + 4);
}

export function dirPart(path: string): string {
  const shown = displayPath(path);
  const cut = shown.lastIndexOf('/');
  return cut < 0 ? '' : shown.slice(0, cut + 1);
}

export function namePart(path: string): string {
  const shown = displayPath(path);
  const cut = shown.lastIndexOf('/');
  return cut < 0 ? shown : shown.slice(cut + 1);
}

/**
 * 目录前缀只留末两段：`web/src/components/` → `…/src/components/`。
 *
 * 卡片正文宽约 260px（11px 字），整条仓库相对路径放不下，必须取舍——留下
 * **离文件名最近的两段**，掐掉信息量最低的前段。此前整条 chip 从尾部省略，
 * 长路径只剩开头的 `web/src/…`，恰恰是最没用的部分；文件名也一起被吃掉。
 */
export function tailDir(dir: string, keep = 2): string {
  const segs = dir.split('/').filter(Boolean);
  return segs.length <= keep ? dir : `…/${segs.slice(-keep).join('/')}/`;
}

/** 明细过滤：空查询命中所有条目；否则按路径子串（忽略大小写）。 */
export function matchesQuery(path: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || path.toLowerCase().includes(needle);
}
/**
 * 提交时间的相对说法：`刚刚` / `3 分钟前` / `2 小时前` / `5 天前`。
 *
 * 为什么不直接显示 ISO 时间：这张卡的用途是"现在这堆改动是怎么来的"——需要
 * 的是"多久以前",不是精确到秒的时间戳（精确值放悬停提示里）。解析失败
 * （老 Core 没有这一列 / 时间格式认不出）返回 null，调用方不显示，而不是
 * 显示一个假时间。
 *
 * `now` 可注入：测试不该依赖真实时钟。
 */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const seconds = Math.round((now - at) / 1000);
  // 时钟偏差 / 未来时间（跨机节点时间不同步很常见）：不说"负 3 分钟前"。
  if (seconds < 0) return '刚刚';
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  return `${Math.floor(months / 12)} 年前`;
}

/**
 * 快照里"值得看一眼"的附加信息，拼成一行：`stash 2 · 3 小时前`。
 *
 * stash 与提交时间都是**补充信息**：没有就什么都不显示（不占位置），
 * 有就挨着最近提交放一起——它们是同一个问题的两面（"这堆改动从哪来"）。
 */
export function extrasLabel(
  dir: WorkspaceGitInfo,
  now = Date.now(),
): { stash: number; time: string | null } {
  return {
    stash: dir.stash ?? 0,
    time: relativeTime(dir.last_commit_time, now),
  };
}
