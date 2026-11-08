<script setup lang="ts">
//! 工作区 git 状态卡（workspace 模块，2026-10 从「工作区会话管理」面板里提出）。
//!
//! 为什么单独成卡：git 状态是**常看**的信息（改代码时反复扫一眼「现在哪条
//! 分支、几个文件没提交」），而工作区会话管理是**偶尔**的操作。挤在弹层里
//! 意味着每次都要开一次弹层；提成边栏卡后常驻可见，且与文件浏览器卡并列
//! （同一个工作区、同一批目录）。
//!
//! **默认每目录一行**（2026-10 实测后的形态）：边栏一列同时开 3-4 张卡时，
//! 本卡内容区只有约 100px——按目录平铺「分支 + 计数 + 提交 + 文件 chip」
//! 五六个目录就溢出了，一屏只能看一个仓库。改成行式后 5 个目录一屏可见，
//! 点行展开细节（类别开关 / 父目录 / 最近提交）。工作区只有一个目录时默认展开
//! （单仓项目占比最高，那正是想看细节的场景）。
//!
//! **展开后按类别看文件**（2026-10 补）：`已暂存 1 · 已修改 4 · 未跟踪 2` 这
//! 三个数字本身就是开关——点「已修改 4」列出那 4 个文件（带 porcelain 状态字符
//! `M`/`A`/`D`/`?`），再点收起。此前只有一句计数加一串不分组的路径 chip：看得出
//! 有几个改动，却看不出**哪个文件属于哪一类**，而「这条改了还没加进暂存区」
//! 恰是这类信息里最要紧的一条。变更 ≤ 6 个文件的目录展开行后自动铺开（一眼
//! 看完，不值得再点一次），再多就只留计数。
//!
//! **长路径的取舍**：卡片正文宽约 260px，整条仓库相对路径放不下。文件名不参与
//! 收缩、目录前缀只留末两段（`…/src/components/`）——掐掉的永远是信息量最低的
//! 前段。此前整条 chip 从尾部省略，长路径只剩开头的 `web/src/…`，恰恰是最没用
//! 的部分，文件名也一起没了。
//!
//! 数据流：挂载 / 切换工作区会话 / 重连时发 `RequestWorkspaceGitStatus`
//! （必须带 `team_id`，否则 Core 路由到默认 agent），Core 以
//! `WorkspaceGitStatus` 回推按目录分组的快照，落 `state.workspaceGitBySession`。
//! 不做轮询 —— git 状态只在用户主动改代码后变，刷新按钮 + 上述时机足够；
//! 定时拉会把 `git status` 变成常驻后台开销（工作区目录可能是跨机节点）。
//!
//! 绑定对象与文件浏览器卡同源（`rail-cards.ts::workspaceCardFor`）：本窗口
//! 会话是工作区通道就用该通道，否则退回全局激活工作区——两卡不会指向不同
//! 的工作区。
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import NeumorphismButton from '@echolab-auto/ui-frame/components/NeumorphismButton';
import { state, federatedPeerLabel } from '@echo-agent/panel';
import { sendCommand } from '@echo-agent/panel';
import { sessionKey } from '@echo-agent/panel';
import type {
  WorkspaceChangedEntry,
  WorkspaceGitInfo,
  WorkspaceSessionInfo,
} from '@echo-agent/panel';

/** 一类变更（Core 只回传两列状态字符，归类是这里的事）。 */
type ChangeKind = 'staged' | 'modified' | 'untracked';

/** 三类的展示顺序与文案：先「已暂存」后「未跟踪」，与 `git status` 的
 *  阅读顺序一致（越靠前越接近一次提交）。 */
const GROUPS: { kind: ChangeKind; label: string }[] = [
  { kind: 'staged', label: '已暂存' },
  { kind: 'modified', label: '已修改' },
  { kind: 'untracked', label: '未跟踪' },
];

/**
 * 变更总数不超过此值时，展开目录行后**自动铺开**明细。
 *
 * 六个文件在 11px 正文下约 100px，一眼看完；再多就只留计数（卡片内容区
 * 常被压到 100px 上下，全铺开会把「最近提交」等别的东西顶出视野）。
 */
const AUTO_OPEN_TOTAL = 6;

/** 一类变更的展示单元：计数（Core 的真数）+ 已回传的明细。 */
interface GroupRow {
  kind: ChangeKind;
  label: string;
  /** Core 报的总条数——明细被截断时它仍是真的。 */
  count: number;
  /** 已回传的明细（可能少于 `count`）。 */
  entries: { path: string; letter: string }[];
  /** 明细之外还剩多少条（`count - entries.length`）。 */
  more: number;
}

const props = defineProps<{
  teamId: string | null;
  session: WorkspaceSessionInfo | null;
}>();

/** 本次请求的加载态（事件回推或 8s 超时收敛，无挂死）。 */
const loading = ref(false);
let settleTimer: number | undefined;

/** 当前会话的 git 快照（按目录）。 */
const dirs = computed(() =>
  props.session
    ? (state.workspaceGitBySession[sessionKey(state.activeRegion, props.session.id)] ?? [])
    : [],
);

function request() {
  const session = props.session;
  if (!state.connected || !props.teamId || !session) return;
  // 已有快照（手动刷新）就直接显示旧数据，不闪「读取中…」；只有没有数据可
  // 显示时才进加载态。
  loading.value = dirs.value.length === 0;
  sendCommand({
    RequestWorkspaceGitStatus: { team_id: props.teamId, session_id: session.id },
  });
  window.clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => {
    loading.value = false;
  }, 8000);
}

// 快照到达 → 收掉加载态（比计时器精确：跨机目录可能要几秒）。
watch(dirs, () => {
  loading.value = false;
});
/** 用户手动展开/收起的行（未点过时按「单目录自动展开」推断）。 */
const expanded = ref<Set<string>>(new Set());
/** 用户是否动过展开态（动过就以用户的选择为准，不再自动展开）。 */
const touched = ref(false);

/**
 * 已经点开明细的类别（键 `${directory}#${kind}`，多个目录 / 多类可同开）。
 *
 * 默认不在这里：未点过任何一个类别的目录按「变更 ≤ AUTO_OPEN_TOTAL 就铺开」
 * 推断（见 `isGroupOpen`）——小改动一眼看完，大改动只留计数。
 */
const openGroups = ref<Set<string>>(new Set());
/** 动过明细开关的目录（动过之后该目录就按 `openGroups` 说话）。 */
const touchedGroupDirs = ref<Set<string>>(new Set());

// 切会话（或目录集变化）→ 立刻拉一份；展开态重置（旧会话的行对不上）。
watch(
  () => [props.session?.id ?? '', (props.session?.directories ?? []).length].join('|'),
  () => {
    expanded.value = new Set();
    touched.value = false;
    openGroups.value = new Set();
    touchedGroupDirs.value = new Set();
    if (props.session) request();
    else loading.value = false;
  },
  { immediate: true },
);

// 重连后缓存已清空（connection.ts 清 workspaceGitBySession）：重拉。
watch(
  () => state.connected,
  (connected) => {
    if (connected) request();
  },
);

onBeforeUnmount(() => window.clearTimeout(settleTimer));

// ── 展开态 ───────────────────────────────────────────────────────────

/** 单目录工作区默认展开（点过任意行后以用户选择为准）。 */
function isExpanded(dir: WorkspaceGitInfo): boolean {
  if (touched.value) return expanded.value.has(dir.directory);
  return dirs.value.length === 1;
}

function toggle(dir: WorkspaceGitInfo) {
  const next = new Set(touched.value ? expanded.value : autoExpanded());
  touched.value = true;
  if (next.has(dir.directory)) next.delete(dir.directory);
  else next.add(dir.directory);
  expanded.value = next;
}

function autoExpanded(): Set<string> {
  return dirs.value.length === 1 ? new Set([dirs.value[0].directory]) : new Set<string>();
}

// ── 展示 ─────────────────────────────────────────────────────────────

/** 目录的显示名：取末段（`node://host/a/b` → `b`），悬停给全路径。 */
function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.split('/').filter(Boolean).pop() ?? path;
}

/**
 * 父目录（不含末段）。去掉 `node://host` 前缀后取 dirname——`node://` 的
 * 两段会被当路径段混进父目录里，先剥掉再算。
 */
function parentOf(path: string): string {
  const remote = path.startsWith('node://');
  const local = remote ? path.slice(7).split('/').slice(1).join('/') : path;
  const trimmed = local.replace(/\/+$/, '');
  const cut = trimmed.lastIndexOf('/');
  if (cut <= 0) return '';
  const parent = trimmed.slice(0, cut);
  // 本机路径自带前导 `/`；跨机路径剥掉 `node://host` 后要以 `/` 补回
  return remote ? `/${parent}` : parent;
}

/**
 * 重名目录的集合（basename 冲突）。
 *
 * 工作区常把多个仓库的 `source/` 子目录并列为目录（本机实测 5 个目录里就
 * 有两个叫 `source`），收起态只显示末段时无法区分——冲突时补一段父目录的
 * 末段（`source / echo-agent-core`）作为消歧，唯一的目录不加（省宽度）。
 */
const dupNames = computed(() => {
  const counts = new Map<string, number>();
  for (const dir of dirs.value) {
    const name = basename(dir.directory);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n > 1).map(([name]) => name));
});

/** 父目录最后一段（消歧后缀）。 */
function parentTail(path: string): string {
  return parentOf(path).split('/').filter(Boolean).pop() ?? '';
}

/** 目录是否跨机（`node://` 前缀）——跨机节点用徽标标注。 */
function nodeOf(directory: string): string | null {
  return directory.startsWith('node://') ? (directory.slice(7).split('/')[0] ?? null) : null;
}

/** 变更文件总数（行右侧的数字 / 干净判定）。 */
function changedCount(dir: {
  staged?: number;
  modified?: number;
  untracked?: number;
}): number {
  return (dir.staged ?? 0) + (dir.modified ?? 0) + (dir.untracked ?? 0);
}

/** 「已暂存 3 · 已修改 5 · 未跟踪 2」，全零时是一句「工作区干净」。 */
/** 「已暂存 3 · 已修改 5 · 未跟踪 2」，全零时是一句「工作区干净」。 */
function summary(dir: {
  staged?: number;
  modified?: number;
  untracked?: number;
}): string {
  const parts: string[] = [];
  if (dir.staged) parts.push(`已暂存 ${dir.staged}`);
  if (dir.modified) parts.push(`已修改 ${dir.modified}`);
  if (dir.untracked) parts.push(`未跟踪 ${dir.untracked}`);
  return parts.length ? parts.join(' · ') : '工作区干净';
}

// ── 变更明细（按类别分组展开，2026-10）────────────────────────────────
//
// 此前展开块只有一句「已暂存 1 · 已修改 4」加一串不分组的路径 chip：看得出
// 有几个改动，却看不出**哪个文件属于哪一类**——而「这条改了没加进暂存区」
// 正是这类信息里最要紧的一条。现在计数本身就是开关：点「已修改 4」列出这
// 4 个文件（带 porcelain 状态字符 M/A/D/?）。

/** 一条明细属于哪几类（`MM` 同时属已暂存与已修改；`??` 独属未跟踪）。 */
function kindsOf(entry: WorkspaceChangedEntry): ChangeKind[] {
  const index = (entry.index ?? '').trim();
  const worktree = (entry.worktree ?? '').trim();
  if (index === '?' && worktree === '?') return ['untracked'];
  const kinds: ChangeKind[] = [];
  if (index && index !== '?') kinds.push('staged');
  if (worktree && worktree !== '?') kinds.push('modified');
  return kinds;
}

/** 该类在快照里的总条数——以 Core 的计数为准（明细可能被截断）。 */
function countOf(dir: WorkspaceGitInfo, kind: ChangeKind): number {
  if (kind === 'staged') return dir.staged ?? 0;
  if (kind === 'modified') return dir.modified ?? 0;
  return dir.untracked ?? 0;
}

/** 明细行首的状态字符（未跟踪恒为 `?`，其余取该类对应那一列）。 */
function letterOf(entry: WorkspaceChangedEntry, kind: ChangeKind): string {
  if (kind === 'untracked') return '?';
  const raw = kind === 'staged' ? entry.index : entry.worktree;
  return (raw ?? '').trim() || 'M';
}

/** 三类分组（含计数与已回传明细）；老 Core 没发明细时返回空表。 */
function groups(dir: WorkspaceGitInfo): GroupRow[] {
  const entries = dir.changed_entries ?? [];
  if (!entries.length) return [];
  return GROUPS.map(({ kind, label }) => {
    const picked = entries.filter((e) => kindsOf(e).includes(kind));
    const count = countOf(dir, kind);
    return {
      kind,
      label,
      count,
      entries: picked.map((e) => ({ path: e.path, letter: letterOf(e, kind) })),
      more: Math.max(0, count - picked.length),
    };
  });
}

/** 该目录有带状态的明细（否则退回扁平路径表——老 Core / 跨机老对端）。 */
function hasEntries(dir: WorkspaceGitInfo): boolean {
  return (dir.changed_entries ?? []).length > 0;
}

/** 非空类别（计数为 0 的类不占位置）。 */
function visibleGroups(dir: WorkspaceGitInfo): GroupRow[] {
  return groups(dir).filter((g) => g.count > 0);
}

/** 类别是否展开（未动过开关的目录按「小改动自动铺开」推断）。 */
function isGroupOpen(dir: WorkspaceGitInfo, kind: ChangeKind): boolean {
  if (touchedGroupDirs.value.has(dir.directory)) {
    return openGroups.value.has(`${dir.directory}#${kind}`);
  }
  return changedCount(dir) <= AUTO_OPEN_TOTAL;
}

/** 展开着的、且真有明细可列的类别。 */
function openRows(dir: WorkspaceGitInfo): GroupRow[] {
  return visibleGroups(dir).filter((g) => isGroupOpen(dir, g.kind) && g.entries.length > 0);
}

function toggleGroup(dir: WorkspaceGitInfo, kind: ChangeKind) {
  const next = new Set(openGroups.value);
  if (!touchedGroupDirs.value.has(dir.directory)) {
    // 首次点某个类别：先把「自动铺开」的现状落成显式状态，本次点击才有确定
    // 含义（否则点开一类会把其他类一起关掉似的，看着像 bug）。
    touchedGroupDirs.value = new Set(touchedGroupDirs.value).add(dir.directory);
    const auto = changedCount(dir) <= AUTO_OPEN_TOTAL;
    for (const g of GROUPS) {
      const key = `${dir.directory}#${g.kind}`;
      if (auto && countOf(dir, g.kind) > 0) next.add(key);
      else next.delete(key);
    }
  }
  const key = `${dir.directory}#${kind}`;
  if (next.has(key)) next.delete(key);
  else next.add(key);
  openGroups.value = next;
}

/** 类别开关的悬停提示（条数是 Core 的真数，明细可能少于它）。 */
function groupTip(dir: WorkspaceGitInfo, group: GroupRow): string {
  const open = isGroupOpen(dir, group.kind) ? '收起' : '展开';
  const capped =
    group.more > 0 ? `\nCore 只回传每类前 30 条，另有 ${group.more} 个未列出` : '';
  return `点击${open}「${group.label}」的文件清单（${group.count} 个）${capped}`;
}

/**
 * 路径切成「目录前缀」与「文件名」两段（前者含末尾 `/`）。
 *
 * 重命名 / 复制（porcelain 的 `旧 -> 新`）只取箭头右侧：旧名对「现在改的是
 * 哪个文件」没有帮助，全量原样留在 `title` 里。
 */
function displayPath(path: string): string {
  const arrow = path.lastIndexOf(' -> ');
  return arrow < 0 ? path : path.slice(arrow + 4);
}

function dirPart(path: string): string {
  const shown = displayPath(path);
  const cut = shown.lastIndexOf('/');
  return cut < 0 ? '' : shown.slice(0, cut + 1);
}

function namePart(path: string): string {
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
function tailDir(dir: string, keep = 2): string {
  const segs = dir.split('/').filter(Boolean);
  return segs.length <= keep ? dir : `…/${segs.slice(-keep).join('/')}/`;
}

/** 行悬停提示：全路径 + 分支 / 同步 / 计数 / 最近提交（收起态也能读到全部）。 */
function rowTip(dir: WorkspaceGitInfo): string {
  const head = `${dir.directory}${nodeOf(dir.directory) ? `（节点 ${nodeOf(dir.directory)}）` : ''}`;
  if (!dir.is_repo) return `${head}\n${dir.error || '不是 git 仓库'}`;
  const bits = [`⑂ ${dir.branch || '（未知分支）'}`];
  if (dir.ahead) bits.push(`领先 ${dir.ahead}`);
  if (dir.behind) bits.push(`落后 ${dir.behind}`);
  bits.push(summary(dir));
  if (dir.last_commit) bits.push(dir.last_commit);
  return `${head}\n${bits.join(' · ')}`;
}

/** 有真实仓库的目录数（徽标；非仓 / 读失败不计）。 */
const repoCount = computed(() => dirs.value.filter((d) => d.is_repo).length);
</script>

<template>
  <div class="wgc">
    <div class="wgc-head">
      <span class="wgc-title">
        工作区 git 状态
        <span v-if="repoCount > 1" class="wgc-badge" title="工作区内的仓库数">
          {{ repoCount }}
        </span>
      </span>
      <NeumorphismButton
        size="small"
        variant="glass"
        :disabled="loading || !state.connected || !session"
        title="重新读取各目录的 git 状态"
        @click="request()"
      >
        {{ loading ? '读取中…' : '刷新' }}
      </NeumorphismButton>
    </div>

    <p v-if="!session" class="muted wgc-empty">（当前没有激活的工作区会话）</p>
    <p v-else-if="!dirs.length" class="muted wgc-empty">
      {{ loading ? '（正在读取 git 状态…）' : '（该工作区没有目录）' }}
    </p>

    <div class="wgc-list">
      <template v-for="dir in dirs" :key="dir.directory">
        <!-- 行：目录名 + 分支 + 同步 + 变更数（非仓库行不可展开，直接给错误） -->
        <div
          class="wgc-row"
          :class="{
            'wgc-row--open': dir.is_repo && isExpanded(dir),
            'wgc-row--error': !dir.is_repo,
          }"
          :title="rowTip(dir)"
          @click="dir.is_repo && toggle(dir)"
        >
          <span v-if="dir.is_repo" class="wgc-caret" aria-hidden="true">›</span>
          <span class="wgc-row__name">{{ basename(dir.directory) }}</span>
          <span
            v-if="dupNames.has(basename(dir.directory))"
            class="wgc-row__hint"
            title="同名的其他目录，用父目录末段消歧"
          >
            {{ parentTail(dir.directory) }}
          </span>
          <span v-if="dir.is_repo" class="wgc-row__branch">
            ⑂ {{ dir.branch || '？' }}
          </span>
          <span v-if="dir.ahead" class="wgc-sync" title="领先上游的提交数">↑{{ dir.ahead }}</span>
          <span v-if="dir.behind" class="wgc-sync" title="落后上游的提交数">↓{{ dir.behind }}</span>
          <span v-if="nodeOf(dir.directory)" class="wgc-node" :title="`跨机节点 ${nodeOf(dir.directory)}`">
            {{ nodeOf(dir.directory) ? federatedPeerLabel(nodeOf(dir.directory) as string) : '' }}
          </span>
          <span
            v-if="dir.is_repo"
            class="wgc-row__count"
            :class="{ 'wgc-row__count--clean': changedCount(dir) === 0 }"
            :title="summary(dir)"
          >
            {{ changedCount(dir) || '✓' }}
          </span>
          <span v-else class="wgc-row__err">{{ dir.error || '不是 git 仓库' }}</span>
        </div>

        <!-- 展开：类别开关（计数即开关）+ 父目录 + 最近提交 + 明细清单 -->
        <div v-if="dir.is_repo && isExpanded(dir)" class="wgc-detail">
          <div
            v-if="changedCount(dir) === 0"
            class="wgc-detail__counts wgc-detail__counts--clean"
          >
            工作区干净
          </div>
          <!-- 新 Core 带状态明细：计数本身就是开关，点一类就展开那一类的文件 -->
          <div v-else-if="hasEntries(dir)" class="wgc-groups">
            <span
              v-for="g in visibleGroups(dir)"
              :key="g.kind"
              class="wgc-group"
              :class="{
                'wgc-group--open': isGroupOpen(dir, g.kind),
                'wgc-group--no-detail': !g.entries.length,
              }"
              :title="groupTip(dir, g)"
              @click="g.entries.length && toggleGroup(dir, g.kind)"
            >
              <span class="wgc-caret wgc-group__caret" aria-hidden="true">›</span>
              {{ g.label }}
              <span class="wgc-group__n">{{ g.count }}</span>
            </span>
          </div>
          <!-- 老 Core（不发 changed_entries）：退回一句计数全称 + 扁平路径表 -->
          <div v-else class="wgc-detail__counts">{{ summary(dir) }}</div>

          <div class="wgc-detail__path">{{ parentOf(dir.directory) }}</div>
          <div v-if="dir.last_commit" class="wgc-commit" :title="dir.last_commit">
            {{ dir.last_commit }}
          </div>

          <!-- 按类别铺开的明细（可多类同开）：一行一个文件，文件名不被截断 -->
          <div v-for="g in openRows(dir)" :key="`files-${g.kind}`" class="wgc-files">
            <div
              v-for="e in g.entries"
              :key="`${g.kind}-${e.path}`"
              class="wgc-file"
              :title="`${e.path}（${g.label}）`"
            >
              <span class="wgc-file__st" :class="`wgc-file__st--${g.kind}`">{{ e.letter }}</span>
              <span class="wgc-file__dir">{{ tailDir(dirPart(e.path)) }}</span>
              <span class="wgc-file__name">{{ namePart(e.path) }}</span>
            </div>
            <div v-if="g.more > 0" class="wgc-more">
              …另有 {{ g.more }} 个未列出（Core 每类最多回传 30 条）
            </div>
          </div>

          <!-- 老 Core 的扁平路径表：无状态可分组，行首给 `·`，布局与上面同一套 -->
          <div v-if="!hasEntries(dir) && (dir.changed_files ?? []).length" class="wgc-files">
            <div v-for="file in dir.changed_files" :key="file" class="wgc-file" :title="file">
              <span class="wgc-file__st wgc-file__st--flat">·</span>
              <span class="wgc-file__dir">{{ tailDir(dirPart(file)) }}</span>
              <span class="wgc-file__name">{{ namePart(file) }}</span>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
<style scoped>
<style scoped>
/* 边栏卡内容：窄（右栏 ~300px）、可用高度小，一切尺寸按 11px 正文写 */
.wgc {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.wgc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.wgc-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--nm-text-secondary);
}
.wgc-badge {
  padding: 0 5px;
  border-radius: 8px;
  background: var(--panel-accent-soft);
  color: var(--panel-accent);
  font-size: 10px;
  font-weight: 700;
  line-height: 15px;
}

.wgc-empty {
  margin: 0;
  font-size: 11px;
}

.wgc-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

/* 行：单行 20px，一屏塞得下五六个目录 */
.wgc-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 2px 4px;
  border-radius: 7px;
  font-size: 11px;
  cursor: pointer;
}
.wgc-row:hover {
  background: var(--panel-hover);
}
.wgc-row--error {
  cursor: default;
}

.wgc-caret {
  flex: 0 0 auto;
  width: 8px;
  color: var(--nm-text-secondary);
  opacity: 0.7;
  transition: transform 0.15s ease-out;
}
.wgc-row--open .wgc-caret {
  transform: rotate(90deg);
}

.wgc-row__name {
  /* 名字不参与收缩（超长才用 max-width 兜底）：一行里最该看清的是目录名，
     分支名再长也只是补充信息，让分支先截断。 */
  flex: 0 0 auto;
  max-width: 62%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  color: var(--nm-text-primary);
}
.wgc-row__hint {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  color: var(--nm-text-secondary);
  opacity: 0.65;
}
.wgc-row__branch {
  flex: 1 1 auto;
  min-width: 24px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--nm-text-secondary);
  opacity: 0.85;
}
.wgc-sync {
  flex: 0 0 auto;
  font-weight: 700;
  color: var(--panel-accent);
}
.wgc-node {
  flex: 0 0 auto;
  padding: 0 4px;
  border-radius: 6px;
  background: var(--panel-hover);
  color: var(--panel-warn);
  font-size: 10px;
  line-height: 14px;
}
.wgc-row__count {
  flex: 0 0 auto;
  min-width: 16px;
  text-align: right;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--panel-warn);
}
.wgc-row__count--clean {
  color: var(--nm-text-secondary);
  opacity: 0.7;
}
.wgc-row__err {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  color: var(--panel-err);
}

/* 展开块：左侧缩进对齐目录名（caret 8 + gap 6） */
.wgc-detail {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin: 0 0 4px 14px;
  padding-left: 8px;
  border-left: 1px solid var(--nm-border-color);
}
.wgc-detail__counts {
  font-size: 11px;
  color: var(--panel-warn);
}
.wgc-detail__counts--clean {
  color: var(--nm-text-secondary);
  opacity: 0.8;
}
.wgc-detail__path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  color: var(--nm-text-secondary);
  opacity: 0.7;
}
.wgc-commit {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  font-family: var(--nm-font-mono, monospace);
  color: var(--nm-text-secondary);
}

/* 类别开关：看起来是 chip，实际是「展开这一类的文件清单」的按钮。
   计数用 Core 的真数（明细可能被截断），点击才铺开清单。 */
.wgc-groups {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
}
.wgc-group {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0 6px;
  border-radius: 6px;
  background: var(--panel-hover);
  font-size: 10px;
  line-height: 17px;
  color: var(--panel-warn);
  cursor: pointer;
  user-select: none;
}
.wgc-group:hover {
  background: var(--panel-accent-soft);
}
.wgc-group--open {
  background: var(--panel-accent-soft);
  color: var(--panel-accent);
}
/* 没有明细可列（老 Core 只回传计数 / 该类条数全被截断）：不可点 */
.wgc-group--no-detail {
  opacity: 0.55;
  cursor: default;
}
.wgc-group__caret {
  width: 6px;
  font-size: 10px;
  opacity: 0.8;
}
.wgc-group--open .wgc-group__caret {
  transform: rotate(90deg);
}
.wgc-group__n {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

/* 明细清单：一行一个文件，多则内部滚动（文件可能上百） */
.wgc-files {
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: 116px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

/* 行布局的关键：目录前缀可缩、文件名不可缩。
   卡片宽约 260px，整条仓库相对路径放不下——先掐目录（信息量低的段先走，
   且 JS 侧已把前缀裁到末两段），文件名始终完整；只有名字本身比整行还长时
   才省略。此前整条 chip 尾部省略，长路径的文件名一起没了。 */
.wgc-file {
  display: flex;
  align-items: baseline;
  gap: 4px;
  min-width: 0;
  padding: 0 4px;
  border-radius: 5px;
  font-size: 10px;
  line-height: 16px;
  color: var(--nm-text-secondary);
}
.wgc-file:hover {
  background: var(--panel-hover);
}
.wgc-file__st {
  flex: 0 0 auto;
  width: 8px;
  text-align: center;
  font-family: var(--nm-font-mono, monospace);
  font-weight: 700;
}
.wgc-file__st--staged {
  color: var(--panel-ok);
}
.wgc-file__st--modified {
  color: var(--panel-warn);
}
.wgc-file__st--untracked {
  color: var(--nm-text-secondary);
  opacity: 0.7;
}
.wgc-file__st--flat {
  color: var(--nm-text-secondary);
  opacity: 0.5;
}
.wgc-file__dir {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.6;
}
.wgc-file__name {
  flex: 0 0 auto;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  color: var(--nm-text-primary);
}
.wgc-more {
  padding: 0 4px 0 12px;
  font-size: 10px;
  font-style: italic;
  color: var(--nm-text-secondary);
  opacity: 0.7;
}
</style>
