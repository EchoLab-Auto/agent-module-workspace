<script setup lang="ts">
//! 一个工作区目录的**行 + 展开块**（git 状态卡的子组件）。
//!
//! 为什么拆出来：一张边栏卡同时要管"拉数据 / 门控 / 汇总 / 每目录的行 / 每类
//! 的明细 / 三套展开态"，800 行里没有哪一段能单独看懂。拆开后边界很清楚——
//! 本组件**不持有任何跨行状态**（行展开与类别开关都由父组件传入 / 上报），
//! 只负责把一个 `WorkspaceGitInfo` 画成两截：收起时一行，展开时明细。
//!
//! 交互约定（与卡片测试钉住的契约一致）：
//!
//! - 行只在 `is_repo` 时可点（非仓库行没有 caret，点了也不展开）；
//! - 类别 chip 只在**有明细可列**时可点（老 Core / 跨机老对端只回传计数，
//!   点它没有东西可展开，光标都不该变成手型）；
//! - 明细超过 [`SEARCH_THRESHOLD`] 条才出现过滤框（少的时候它只是多一个输入框）；
//! - 「刷新」只重读**这一个目录**（父组件把 `directories: [本目录]` 发出去），
//!   工作区里其他仓库的 git 子进程一个都不跑。
import { computed, ref } from 'vue';
import { federatedPeerLabel } from '@echo-agent/panel';
import PanelIcon from '@echo-agent/panel/components/PanelIcon';
import type { WorkspaceGitInfo } from '@echo-agent/panel';
import {
  basename,
  changedCount,
  conflictCount,
  conflictUnknown,
  dirPart,
  matchesQuery,
  namePart,
  nodeOf,
  parentOf,
  relativeTime,
  summary,
  tailDir,
  visibleGroups,
  type ChangeKind,
} from '../git-changes';

/** 明细超过这个条数才配过滤框（六个文件一眼看完，多一个输入框只是噪声）。 */
const SEARCH_THRESHOLD = 8;

const props = defineProps<{
  dir: WorkspaceGitInfo;
  /** 同名目录的消歧后缀（空 = 不加，省宽度）。 */
  hint: string;
  /** 行是否展开（父组件持有：单目录默认展开的规则是跨行判断）。 */
  open: boolean;
  /** 某类明细是否展开（同理，父组件持有）。 */
  groupOpen: (kind: ChangeKind) => boolean;
  /** 只刷新本目录时的忙碌态（父组件持有请求与计时器）。 */
  refreshing?: boolean;
}>();

const emit = defineEmits<{
  (event: 'toggle-row'): void;
  (event: 'toggle-group', kind: ChangeKind): void;
  (event: 'refresh-dir'): void;
}>();

/** 明细过滤词（本组件私有：收起再展开就该清空）。 */
const query = ref('');

const node = computed(() => nodeOf(props.dir.directory));
const hasEntries = computed(() => (props.dir.changed_entries ?? []).length > 0);
const entryCount = computed(() => (props.dir.changed_entries ?? []).length);
const groups = computed(() => visibleGroups(props.dir));
const conflicts = computed(() => conflictCount(props.dir));

/** 最近提交的相对时间（没有时间信息时为空 → 不显示，不占位置）。 */
const commitAgo = computed(() => relativeTime(props.dir.last_commit_time));
/** 最近提交的精确时间（悬停提示用；正文只给相对说法）。 */
const commitAt = computed(() => props.dir.last_commit_time ?? '');

/** 展开着的类别里，真正要铺出来的行（应用过滤词）。 */
const openRows = computed(() =>
  groups.value
    .filter((group) => props.groupOpen(group.kind) && group.entries.length > 0)
    .map((group) => ({
      ...group,
      shown: group.entries.filter((entry) => matchesQuery(entry.path, query.value)),
    })),
);

/** 行悬停提示：全路径 + 分支 / 同步 / 计数 / stash / 提交 / 时间（收起态也读得到）。 */
const rowTip = computed(() => {
  const dir = props.dir;
  const head = `${dir.directory}${node.value ? `（节点 ${node.value}）` : ''}`;
  if (!dir.is_repo) return `${head}\n${dir.error || '不是 git 仓库'}`;
  const bits = [`⑂ ${dir.branch || '（未知分支）'}`];
  if (dir.ahead) bits.push(`领先 ${dir.ahead}`);
  if (dir.behind) bits.push(`落后 ${dir.behind}`);
  bits.push(summary(dir));
  // 老 Core / 跨机老对端不发明细：此时"没报冲突"不等于"没有冲突"，说清楚。
  if (conflictUnknown(dir)) bits.push('（未回传变更明细，冲突状态未知）');
  if (dir.stash) bits.push(`stash ${dir.stash}`);
  if (dir.last_commit) bits.push(dir.last_commit);
  // 相对时间放最后：它回答的是"多久以前"，不是"改了什么"。
  if (commitAgo.value) bits.push(commitAgo.value);
  return `${head}\n${bits.join(' · ')}`;
});

/** chip 的悬停提示（条数是真数，明细可能少于它）。 */
function groupTip(group: { kind: ChangeKind; label: string; count: number; more: number }): string {
  const open = props.groupOpen(group.kind) ? '收起' : '展开';
  const capped = group.more > 0 ? `\nCore 只回传每类前 30 条，另有 ${group.more} 个未列出` : '';
  return `点击${open}「${group.label}」的文件清单（${group.count} 个）${capped}`;
}

/** 键盘等价物：行 / chip / 刷新都是可点元素，Enter / Space 要能触发。 */
function activate(event: KeyboardEvent, run: () => void): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  run();
}

function onRowKey(event: KeyboardEvent): void {
  if (!props.dir.is_repo) return;
  activate(event, () => emit('toggle-row'));
}

function onGroupKey(event: KeyboardEvent, group: { kind: ChangeKind; entries: unknown[] }): void {
  if (!group.entries.length) return;
  activate(event, () => emit('toggle-group', group.kind));
}

function onRefreshKey(event: KeyboardEvent): void {
  if (props.refreshing) return;
  activate(event, () => emit('refresh-dir'));
}
</script>

<template>
  <div
    class="wgc-row"
    :class="{ 'wgc-row--open': dir.is_repo && open, 'wgc-row--error': !dir.is_repo }"
    :title="rowTip"
    :role="dir.is_repo ? 'button' : undefined"
    :tabindex="dir.is_repo ? 0 : undefined"
    :aria-expanded="dir.is_repo ? open : undefined"
    @click="dir.is_repo && emit('toggle-row')"
    @keydown="onRowKey"
  >
    <span v-if="dir.is_repo" class="wgc-caret" aria-hidden="true">›</span>
    <span class="wgc-row__name">{{ basename(dir.directory) }}</span>
    <span v-if="hint" class="wgc-row__hint" title="同名的其他目录，用父目录末段消歧">
      {{ hint }}
    </span>
    <span v-if="dir.is_repo" class="wgc-row__branch">⑂ {{ dir.branch || '？' }}</span>
    <span v-if="dir.ahead" class="wgc-sync" title="领先上游的提交数">↑{{ dir.ahead }}</span>
    <span v-if="dir.behind" class="wgc-sync" title="落后上游的提交数">↓{{ dir.behind }}</span>
    <span v-if="node" class="wgc-node" :title="`跨机节点 ${node}`">
      {{ federatedPeerLabel(node) }}
    </span>
    <!-- 冲突角标：收起态也要看得见（这是唯一"必须先处理"的一类） -->
    <span
      v-if="dir.is_repo && conflicts > 0"
      class="wgc-conflict"
      :title="`${conflicts} 个未解决的冲突`"
    >
      !{{ conflicts }}
    </span>
    <!-- stash 角标：次要信息，用描边而不是实底（不抢冲突的视觉优先级） -->
    <span
      v-if="dir.is_repo && (dir.stash ?? 0) > 0"
      class="wgc-stash"
      :title="`有 ${dir.stash} 条 stash 未清理`"
    >
      ⚑{{ dir.stash }}
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

  <!-- 展开：类别开关（计数即开关）+ 过滤 + 附加信息 + 明细清单 -->
  <div v-if="dir.is_repo && open" class="wgc-detail">
    <div v-if="changedCount(dir) === 0" class="wgc-detail__counts wgc-detail__counts--clean">
      工作区干净
    </div>
    <!-- 带状态明细：计数本身就是开关，点一类就展开那一类的文件 -->
    <div v-else-if="hasEntries" class="wgc-groups">
      <span
        v-for="group in groups"
        :key="group.kind"
        class="wgc-group"
        :class="{
          'wgc-group--open': groupOpen(group.kind),
          'wgc-group--no-detail': !group.entries.length,
          'wgc-group--conflict': group.kind === 'conflicted',
        }"
        :title="groupTip(group)"
        :role="group.entries.length ? 'button' : undefined"
        :tabindex="group.entries.length ? 0 : undefined"
        :aria-expanded="group.entries.length ? groupOpen(group.kind) : undefined"
        @click="group.entries.length && emit('toggle-group', group.kind)"
        @keydown="onGroupKey($event, group)"
      >
        <span class="wgc-caret wgc-group__caret" aria-hidden="true">›</span>
        {{ group.label }}
        <span class="wgc-group__n">{{ group.count }}</span>
      </span>
    </div>
    <!-- 老 Core（不发 changed_entries）：退回一句计数全称 + 扁平路径表 -->
    <div v-else class="wgc-detail__counts">{{ summary(dir) }}</div>

    <!-- 明细多时的过滤框（只过滤已铺开的行，不改变计数） -->
    <input
      v-if="hasEntries && entryCount > SEARCH_THRESHOLD"
      v-model="query"
      class="wgc-search"
      type="search"
      placeholder="过滤文件名"
      aria-label="过滤变更文件"
    />

    <!-- 附加信息一行：父目录 · stash · 提交相对时间 · 只刷新本目录 -->
    <div class="wgc-meta">
      <span class="wgc-detail__path" :title="parentOf(dir.directory)">
        {{ parentOf(dir.directory) }}
      </span>
      <span
        v-if="(dir.stash ?? 0) > 0"
        class="wgc-meta__stash"
        :title="`${dir.stash} 条 stash 未清理`"
      >
        ⚑{{ dir.stash }}
      </span>
      <span v-if="commitAgo" class="wgc-meta__time" :title="commitAt">{{ commitAgo }}</span>
      <span
        class="wgc-refresh"
        :class="{ 'wgc-refresh--busy': refreshing }"
        role="button"
        tabindex="0"
        :aria-disabled="refreshing ? 'true' : undefined"
        :aria-label="refreshing ? '正在读取该目录的 git 状态' : '只刷新这个目录的 git 状态'"
        :title="refreshing ? '正在读取该目录…' : '只重新读取这个目录的 git 状态（不重采其他仓库）'"
        @click.stop="!refreshing && emit('refresh-dir')"
        @keydown.stop="onRefreshKey"
      >
        <PanelIcon name="refresh" size="xs" :class="{ 'wgc-refresh__spin': refreshing }" />
      </span>
    </div>

    <div v-if="dir.last_commit" class="wgc-commit" :title="dir.last_commit">
      {{ dir.last_commit }}
    </div>

    <!-- 按类别铺开的明细（可多类同开）：一行一个文件，文件名不被截断 -->
    <div v-for="row in openRows" :key="`files-${row.kind}`" class="wgc-files">
      <div
        v-for="entry in row.shown"
        :key="`${row.kind}-${entry.path}`"
        class="wgc-file"
        :title="`${entry.path}（${row.label}）`"
      >
        <span class="wgc-file__st" :class="`wgc-file__st--${row.kind}`">{{ entry.letter }}</span>
        <span class="wgc-file__dir">{{ tailDir(dirPart(entry.path)) }}</span>
        <span class="wgc-file__name">{{ namePart(entry.path) }}</span>
      </div>
      <div v-if="row.entries.length && !row.shown.length" class="wgc-more">
        …没有匹配「{{ query }}」的文件
      </div>
      <div v-if="row.more > 0" class="wgc-more">
        …另有 {{ row.more }} 个未列出（Core 每类最多回传 30 条）
      </div>
    </div>

    <!-- 老 Core 的扁平路径表：无状态可分组，行首给 `·`，布局与上面同一套 -->
    <div v-if="!hasEntries && (dir.changed_files ?? []).length" class="wgc-files">
      <div v-for="file in dir.changed_files" :key="file" class="wgc-file" :title="file">
        <span class="wgc-file__st wgc-file__st--flat">·</span>
        <span class="wgc-file__dir">{{ tailDir(dirPart(file)) }}</span>
        <span class="wgc-file__name">{{ namePart(file) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
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
.wgc-row:focus-visible {
  outline: 1px solid var(--panel-accent);
  outline-offset: -1px;
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
.wgc-conflict {
  flex: 0 0 auto;
  padding: 0 4px;
  border-radius: 6px;
  background: var(--panel-err);
  color: var(--nm-text-on-primary);
  font-size: 10px;
  font-weight: 700;
  line-height: 14px;
}
/* stash 角标：次要信息，用描边而不是实底（不抢冲突的视觉优先级） */
.wgc-stash {
  flex: 0 0 auto;
  padding: 0 4px;
  border: 1px solid var(--panel-warn);
  border-radius: 6px;
  color: var(--panel-warn);
  font-size: 10px;
  line-height: 12px;
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
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  color: var(--nm-text-secondary);
  opacity: 0.7;
}

/* 附加信息行：父目录（可缩）+ stash / 时间 / 刷新（不可缩） */
.wgc-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 10px;
}
.wgc-meta__stash {
  flex: 0 0 auto;
  color: var(--panel-warn);
  font-weight: 700;
}
.wgc-meta__time {
  flex: 0 0 auto;
  color: var(--nm-text-secondary);
  opacity: 0.75;
}
/* 只刷新本目录：窄卡里用最小的可点元素，悬停才显形（不抢正文注意力）。
   文字换成图标后靠 `display:flex` 定住图标盒：`line-height` 对 svg 不起作用，
   不显式撑开的话可点区域会塌成图标本身那一小块。 */
.wgc-refresh {
  flex: 0 0 auto;
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 14px;
  border-radius: 5px;
  background: var(--panel-hover);
  color: var(--nm-text-secondary);
  cursor: pointer;
  user-select: none;
  opacity: 0.75;
}
.wgc-refresh:hover {
  background: var(--panel-accent-soft);
  color: var(--panel-accent);
  opacity: 1;
}
.wgc-refresh:focus-visible {
  outline: 1px solid var(--panel-accent);
}
.wgc-refresh--busy {
  cursor: default;
  opacity: 0.55;
}
/* 忙碌态：图标自转（与整卡按钮里 ui-frame 的内建 spinner 同语义） */
.wgc-refresh__spin {
  animation: wgc-refresh-spin 1s linear infinite;
}
@keyframes wgc-refresh-spin {
  to {
    transform: rotate(360deg);
  }
}

.wgc-commit {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  font-family: var(--nm-font-mono, monospace);
  color: var(--nm-text-secondary);
}

/* 过滤框：和正文同一套字号，避免在窄卡里抢注意力 */
.wgc-search {
  width: 100%;
  min-width: 0;
  padding: 1px 5px;
  border: 1px solid var(--nm-border-color);
  border-radius: 6px;
  background: transparent;
  color: var(--nm-text-primary);
  font-size: 10px;
  line-height: 16px;
}
.wgc-search::placeholder {
  color: var(--nm-text-secondary);
  opacity: 0.6;
}

/* 类别开关：看起来是 chip，实际是「展开这一类的文件清单」的按钮。
   计数用真数（明细可能被截断），点击才铺开清单。 */
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
.wgc-group:focus-visible {
  outline: 1px solid var(--panel-accent);
}
.wgc-group--open {
  background: var(--panel-accent-soft);
  color: var(--panel-accent);
}
/* 冲突：唯一有"必须先处理"含义的一类，用错误色而不是警告色 */
.wgc-group--conflict {
  color: var(--panel-err);
  font-weight: 700;
}
.wgc-group--conflict.wgc-group--open {
  background: var(--panel-err);
  color: var(--nm-text-on-primary);
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
.wgc-file__st--conflicted {
  color: var(--panel-err);
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
