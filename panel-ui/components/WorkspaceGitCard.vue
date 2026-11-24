<script setup lang="ts">
//! 工作区 git 状态卡（workspace 模块，2026-10 从「工作区会话管理」面板里提出）。
//!
//! 为什么单独成卡：git 状态是**常看**的信息（改代码时反复扫一眼「现在哪条
//! 分支、几个文件没提交」），而工作区会话管理是**偶尔**的操作。挤在弹层里
//! 意味着每次都要开一次弹层；提成边栏卡后常驻可见，且与文件浏览器卡并列
//! （同一个工作区、同一批目录）。
//!
//! **默认每目录一行**：边栏一列同时开 3-4 张卡时，本卡内容区只有约 100px——
//! 按目录平铺「分支 + 计数 + 提交 + 文件 chip」五六个目录就溢出了。改成行式后
//! 5 个目录一屏可见，点行展开细节（类别开关 / 父目录 / 最近提交）。工作区只有
//! 一个目录时默认展开（单仓项目占比最高，那正是想看细节的场景）。
//!
//! **四类变更，冲突排最前**：`冲突 / 已暂存 / 已修改 / 未跟踪`。冲突（porcelain
//! 的 unmerged：`UU`/`AA`/`DD`/`AU`/`UA`/`DU`/`UD`）此前被算进"已暂存 + 已
//! 修改"，行上只是数字多两个——而"有冲突没解决"才是必须先处理的那件事。现在
//! 它在行上有红色角标、在明细里是第一个 chip，且**默认铺开**（不受"改动少才
//! 自动展开"的限制）。
//!
//! **多目录时给一句汇总 + 「只看变更」开关**：5 个目录里常常 4 个是干净的，
//! 一屏的有效信息被干净的 `✓` 挤掉了。汇总行说清"几个仓库 / 多少变更 / 几个
//! 冲突"，开关把干净的目录暂时收起。
//!
//! 数据流：挂载 / 切换工作区会话 / 重连时发 `RequestWorkspaceGitStatus`
//! （必须带 `team_id`，否则 Core 路由到默认 agent），Core 以
//! `WorkspaceGitStatus` 回推按目录分组的快照，落 `workspace.gitBySession`。
//! 不做轮询 —— git 状态只在用户主动改代码后变，刷新按钮 + 上述时机足够；
//! 定时拉会把 `git status` 变成常驻后台开销（工作区目录可能是跨机节点）。
//!
//! 纯计算（归类 / 计数 / 路径裁剪）在 `../git-changes.ts`，展开态（行展开 +
//! 类别开关）在 `../git-expansion.ts`，单目录的行与明细在
//! `WorkspaceGitDir.vue`——本文件只管取数、门控、汇总与刷新。
//!
//! 绑定对象与文件浏览器卡同源（`index.ts::workspaceCard`）：本窗口会话是工作区
//! 通道就用该通道，否则退回全局激活工作区——两卡不会指向不同的工作区。
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import NeumorphismButton from '@echolab-auto/ui-frame/components/NeumorphismButton';
import { state } from '@echo-agent/panel';
import { sendCommand } from '@echo-agent/panel';
import { sessionKey } from '@echo-agent/panel';
import PanelIcon from '@echo-agent/panel/components/PanelIcon';
import type { WorkspaceGitInfo, WorkspaceSessionInfo } from '@echo-agent/panel';
import { workspace, workspaceRevision } from '../workspace-store';
import WorkspaceGitDir from './WorkspaceGitDir.vue';
import {
  basename,
  changedCount,
  conflictCount,
  dupNames,
  parentTail,
  repoSummary,
} from '../git-changes';
import { useGitExpansion } from '../git-expansion';

const props = defineProps<{
  teamId: string | null;
  session: WorkspaceSessionInfo | null;
}>();

/** 整卡请求的加载态（事件回推或 8s 超时收敛，无挂死）。 */
const loading = ref(false);
let settleTimer: number | undefined;

/** 单目录刷新中（目录名 → 真；同一时刻可多个，各自收敛）。 */
const refreshingDirs = ref<Set<string>>(new Set());

/** 读一次结构版本号，只为把本 computed 挂到它上面（见 `dirs`）。 */
function revision(): number {
  return workspaceRevision.value;
}

/** 当前会话的 git 快照（按目录）。 */
const dirs = computed<WorkspaceGitInfo[]>(() => {
  // `workspace` 是普通对象（不是 reactive），属性变化只由 bump 推进版本号
  // 体现——不显式读它，快照到达后这里不会重算。
  revision();
  if (!props.session) return [];
  return workspace.gitBySession[sessionKey(state.activeRegion, props.session.id)] ?? [];
});

/** 行展开 / 类别开关（规则见 `git-expansion.ts`）。 */
const expansion = useGitExpansion(dirs);

/**
 * 发一次 git 状态请求。
 *
 * `only` 有值时只重采这些目录（面板的「刷新此目录」）：一个工作区常有 5 个
 * 仓库，改完其中一个不该让其余四个也各跑 5-6 条 git 子进程（跨机目录还得
 * 过一遍网络）。协议里 `directories` 缺省 = 全部目录，所以整卡刷新仍走同一
 * 条命令。
 */
function request(only?: string[]) {
  const session = props.session;
  if (!state.connected || !props.teamId || !session) return;
  // 已有快照（手动刷新）就直接显示旧数据，不闪「读取中…」；只有没有数据可
  // 显示时才进加载态。
  if (only?.length) {
    refreshingDirs.value = new Set([...refreshingDirs.value, ...only]);
  } else {
    loading.value = dirs.value.length === 0;
  }
  sendCommand({
    RequestWorkspaceGitStatus: {
      team_id: props.teamId,
      session_id: session.id,
      ...(only?.length ? { directories: only } : {}),
    },
  });
  window.clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => {
    loading.value = false;
    // 事件丢了也要收敛：否则那一个目录的「读取中」会一直转。
    refreshingDirs.value = new Set();
  }, 8000);
}

/** 只刷新一个目录（本目录的刷新按钮）。 */
function requestDir(directory: string): void {
  request([directory]);
}

// 快照到达 → 收掉加载态（比计时器精确：跨机目录可能要几秒）。
watch(dirs, () => {
  loading.value = false;
  // 快照里出现过的目录就算刷新完成（无法分辨是哪次请求的结果，但"出现在
  // 新快照里"已经足够收掉转圈）。
  if (refreshingDirs.value.size) {
    refreshingDirs.value = new Set();
  }
});

/** 是否只看有变更的目录（多目录时的一屏效率开关）。 */
const onlyChanged = ref(false);

/** 有哪怕一个干净仓库时，这个开关才有意义。 */
const canFilter = computed(
  () =>
    dirs.value.length > 1 &&
    dirs.value.some((dir) => dir.is_repo && changedCount(dir) === 0 && conflictCount(dir) === 0),
);

/** 实际渲染的目录行（"只看变更"时跳过干净的仓库；非仓库行永远保留——那是错误）。 */
const visibleDirs = computed(() =>
  onlyChanged.value
    ? dirs.value.filter(
        (dir) => !dir.is_repo || changedCount(dir) > 0 || conflictCount(dir) > 0,
      )
    : dirs.value,
);

/** 同名目录的集合（收起态只显示末段时靠父目录末段消歧）。 */
const dups = computed(() => dupNames(dirs.value));

/** 有真实仓库的目录数（徽标；非仓 / 读失败不计）。 */
const repoCount = computed(() => dirs.value.filter((dir) => dir.is_repo).length);

/** 顶部一句汇总（只有多目录时才显示：单目录行上已经说清了）。 */
const summaryText = computed(() => {
  const { repos, changes, conflicts } = repoSummary(dirs.value);
  const parts = [`${repos} 个仓库`];
  if (conflicts) parts.push(`${conflicts} 个冲突`);
  parts.push(changes ? `${changes} 项变更` : '全部干净');
  return parts.join(' · ');
});

function toggleOnlyChanged(event?: KeyboardEvent): void {
  if (event && event.key !== 'Enter' && event.key !== ' ') return;
  event?.preventDefault();
  onlyChanged.value = !onlyChanged.value;
}

// 切会话（或目录集变化）→ 立刻拉一份；展开态与过滤重置（旧会话的行对不上）。
watch(
  () => [props.session?.id ?? '', (props.session?.directories ?? []).length].join('|'),
  () => {
    expansion.reset();
    onlyChanged.value = false;
    if (props.session) request();
    else loading.value = false;
  },
  { immediate: true },
);

// 重连后缓存已清空（connection.ts 清 gitBySession）：重拉。
watch(
  () => state.connected,
  (connected) => {
    if (connected) request();
  },
);

onBeforeUnmount(() => window.clearTimeout(settleTimer));
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
        :loading="loading"
        :disabled="loading || !state.connected || !session"
        :aria-label="loading ? '正在读取 git 状态' : '刷新 git 状态'"
        :title="loading ? '正在读取…' : '重新读取各目录的 git 状态'"
        @click="request()"
      >
        <PanelIcon name="refresh" size="xs" />
      </NeumorphismButton>
    </div>

    <p v-if="!session" class="muted wgc-empty">（当前没有激活的工作区会话）</p>
    <p v-else-if="!dirs.length" class="muted wgc-empty">
      {{ loading ? '（正在读取 git 状态…）' : '（该工作区没有目录）' }}
    </p>

    <template v-else>
      <div v-if="dirs.length > 1" class="wgc-summary">
        <span class="wgc-summary__text">{{ summaryText }}</span>
        <span
          v-if="canFilter"
          class="wgc-only-changed"
          :class="{ 'wgc-only-changed--on': onlyChanged }"
          role="button"
          tabindex="0"
          :aria-pressed="onlyChanged"
          title="隐藏没有改动的仓库（一屏看更多有变更的）"
          @click="toggleOnlyChanged()"
          @keydown="toggleOnlyChanged"
        >
          只看变更
        </span>
      </div>

      <div class="wgc-list">
        <template v-for="dir in visibleDirs" :key="dir.directory">
          <WorkspaceGitDir
            :dir="dir"
            :hint="dups.has(basename(dir.directory)) ? parentTail(dir.directory) : ''"
            :open="dir.is_repo && expansion.isRowOpen(dir)"
            :group-open="(kind) => expansion.isGroupOpen(dir, kind)"
            :refreshing="refreshingDirs.has(dir.directory)"
            @toggle-row="expansion.toggleRow(dir)"
            @toggle-group="(kind) => expansion.toggleGroup(dir, kind)"
            @refresh-dir="requestDir(dir.directory)"
          />
        </template>
      </div>
    </template>
  </div>
</template>

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

/* 汇总行：一句汇总 + 「只看变更」开关，都按 10px 写（它是辅助信息） */
.wgc-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
  font-size: 10px;
  color: var(--nm-text-secondary);
}
.wgc-summary__text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.85;
}
.wgc-only-changed {
  flex: 0 0 auto;
  padding: 0 6px;
  border-radius: 6px;
  background: var(--panel-hover);
  color: var(--nm-text-secondary);
  line-height: 15px;
  cursor: pointer;
  user-select: none;
}
.wgc-only-changed:hover {
  background: var(--panel-accent-soft);
}
.wgc-only-changed:focus-visible {
  outline: 1px solid var(--panel-accent);
}
.wgc-only-changed--on {
  background: var(--panel-accent-soft);
  color: var(--panel-accent);
  font-weight: 700;
}

.wgc-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
</style>
