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
//! 类别开关）在 `git-expansion.ts`，单目录的行与明细在
//! `WorkspaceGitDir.vue`——本文件只管取数、门控、汇总与刷新。
//!
//! 绑定对象与文件浏览器卡同源（`index.ts::workspaceCard`）：本窗口会话是工作区
//! 通道就用该通道，否则退回全局激活工作区——两卡不会指向不同的工作区。
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import NeumorphismButton from '@echolab-auto/ui-frame/components/NeumorphismButton';
import { state } from '@echo-agent/panel';
import { sendCommand } from '@echo-agent/panel';
import PanelIcon from '@echo-agent/panel/components/PanelIcon';
import type { WorkspaceGitInfo, WorkspaceSessionInfo } from '@echo-agent/panel';
import { gitDirRevision, gitSessionKey, workspace, workspaceRevision } from '../../workspace-store';
import { directoryToInput } from '../../workspace';
import WorkspaceGitDir from './WorkspaceGitDir.vue';
import {
  basename,
  changedCount,
  conflictCount,
  dupNames,
  parentTail,
  repoSummary,
} from '../../git-changes';
import { useGitExpansion } from './git-expansion';

const props = defineProps<{
  teamId: string | null;
  session: WorkspaceSessionInfo | null;
}>();

/** 整卡请求的加载态（事件回推或 8s 超时收敛，无挂死）。 */
const loading = ref(false);
/** 整卡与单目录两条独立的兜底计时器：单目录刷新不能取消整卡的超时收敛。 */
let cardTimer: number | undefined;
let dirTimer: number | undefined;

/** 单目录刷新中（目录名 → 真；同一时刻可多个，各自收敛）。 */
const refreshingDirs = ref<Set<string>>(new Set());

/**
 * 单目录 `git fetch` 中（与 `refreshingDirs` 分开）。
 *
 * 为什么不复用同一个集合：两件事的耗时差一个量级（本地采集几十毫秒 / fetch
 * 连远端可能几十秒），合并成一个转圈会让"刷新"看起来变慢，也会让 8s 的收敛
 * 计时器在 fetch 上误报超时。
 */
const fetchingDirs = ref<Set<string>>(new Set());
/** fetch 的兜底计时器：Core 侧每个目录最多 45s，这里留一点余量。 */
let fetchTimer: number | undefined;
const FETCH_TIMEOUT_MS = 50_000;

/**
 * 本次整卡刷新是否在等"任何一个回包"。
 *
 * 首拉时 `dirs` 还是空的，没有目录名可以逐个比对——此时只要求"收到了回包"。
 */
let awaitingWholeCard = false;

/** 发出请求时各目录的更新序号（用来判断"我等的那个目录回来了"）。 */
const requestedRev = new Map<string, number>();

/** 目录名归一（末尾斜杠不算差异：Core 回传与会话声明可能差一个 `/`）。 */
function normalizeDir(directory: string): string {
  return directory.replace(/\/+$/, '');
}

/** 读一次结构版本号，只为把本 computed 挂到它上面（见 `dirs`）。 */
function revision(): number {
  return workspaceRevision.value;
}

/**
 * 当前会话的 git 快照（按目录）。
 *
 * 三处必须这样写（都是 2026-11 审计出的缺陷）：
 * 1. 键含人格（[`gitSessionKey`]）——否则两个人格同 id 的工作区互相覆盖；
 * 2. 按**会话声明的目录顺序**输出，并丢掉已不属于该会话的残留条目——store
 *    的合并语义不会主动删目录（`applyGit`），换目录后旧行会留在快照里；
 * 3. 键做两级回退（带人格 → 不带人格）：旧 Core 的回包可能没有 `team_id`。
 */
const dirs = computed<WorkspaceGitInfo[]>(() => {
  // `workspace` 是普通对象（不是 reactive），属性变化只由 bump 推进版本号
  // 体现——不显式读它，快照到达后这里不会重算。
  revision();
  const session = props.session;
  if (!session) return [];
  const core = state.activeRegion ?? null;
  const stored =
    workspace.gitBySession[gitSessionKey(core, props.teamId, session.id)] ??
    workspace.gitBySession[gitSessionKey(core, null, session.id)] ??
    [];
  const wanted = session.directories ?? [];
  if (!wanted.length) return stored;
  const byDir = new Map(stored.map((dir) => [normalizeDir(dir.directory), dir]));
  const ordered: WorkspaceGitInfo[] = [];
  const used = new Set<string>();
  for (const entry of wanted) {
    const key = normalizeDir(directoryToInput(entry));
    const found = byDir.get(key);
    if (!found) continue;
    ordered.push(found);
    used.add(key);
  }
  // 写法对不上的（跨机目录的 `/` 差异、旧 Core 的回传形状）追加在后面，
  // 而不是静默丢掉——丢掉就等于整行消失，那正是这张卡最不该有的表现。
  for (const [key, dir] of byDir) if (!used.has(key)) ordered.push(dir);
  return ordered;
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
    refreshingDirs.value = new Set([...refreshingDirs.value, ...only.map(normalizeDir)]);
    for (const dir of only) {
      const key = normalizeDir(dir);
      requestedRev.set(key, gitDirRevision(state.activeRegion, props.teamId, session.id, key));
    }
  } else {
    loading.value = dirs.value.length === 0;
    // 整卡刷新：先把已知目录的当前序号钉住，回包推进任何一个都算"回过了"。
    awaitingWholeCard = true;
    for (const dir of dirs.value) {
      const key = normalizeDir(dir.directory);
      requestedRev.set(key, gitDirRevision(state.activeRegion, props.teamId, session.id, key));
    }
  }
  sendCommand({
    RequestWorkspaceGitStatus: {
      team_id: props.teamId,
      session_id: session.id,
      ...(only?.length ? { directories: only } : {}),
    },
  });
  if (only?.length) {
    window.clearTimeout(dirTimer);
    dirTimer = window.setTimeout(() => {
      // 事件丢了也要收敛：否则那一个目录的「读取中」会一直转。
      refreshingDirs.value = new Set();
    }, 8000);
  } else {
    window.clearTimeout(cardTimer);
    cardTimer = window.setTimeout(() => {
      loading.value = false;
      awaitingWholeCard = false;
    }, 8000);
  }
}

/** 只刷新一个目录（本目录的刷新按钮）。 */
function requestDir(directory: string): void {
  request([directory]);
}

/**
 * 对一个目录执行 `git fetch`（本目录的「获取远端」按钮）。
 *
 * ## 为什么回包不用另立一条事件
 *
 * 模块 fetch 完之后发的是**同一条** `WorkspaceGitStatus`，面板的 `applyGit`
 * 按目录合并——所以这里只要把该目录的当前序号钉住，回包一推进就收掉转圈，
 * 而且 `↑/↓` 与 `基准 N 分钟前` 会同时变成新值。
 *
 * ## 跨机目录
 *
 * 模块不处理（它得在对端跑，这一版不支持），也不会回该目录的快照。所以这里
 * 根本不发：按钮在跨机目录上不出现（见 `WorkspaceGitDir` 的 `isRemote`）。
 */
function requestFetch(directory: string): void {
  const session = props.session;
  if (!state.connected || !props.teamId || !session) return;
  const key = normalizeDir(directory);
  if (fetchingDirs.value.has(key)) return;
  fetchingDirs.value = new Set([...fetchingDirs.value, key]);
  requestedRev.set(key, gitDirRevision(state.activeRegion, props.teamId, session.id, key));
  sendCommand({
    FetchWorkspaceGit: {
      team_id: props.teamId,
      session_id: session.id,
      directories: [directory],
    },
  });
  window.clearTimeout(fetchTimer);
  fetchTimer = window.setTimeout(() => {
    // 事件丢了也要收敛（否则那个目录的「获取远端」会一直转）。
    // 文案不在这里给：这个按钮没有 toast 位，转圈停下 + 基准时间没变
    // 本身就是"没成功"的信号，而具体原因在 `dir.error` 里（模块会填）。
    fetchingDirs.value = new Set();
  }, FETCH_TIMEOUT_MS);
}

/**
 * 快照到达 → 收掉**确实回来了**的那部分忙碌态。
 *
 * 不能"任意回包就清空全部"（2026-11 缺陷）：同时刷新 A、B 两个目录时，B 的
 * 快照会先把 A 的转圈收掉，而 A 的请求还在飞——用户看到 A 不转了却仍是旧数据。
 * 判据是 `workspace.gitRevByDir` 里该目录的序号是否推进（见 `applyGit`）。
 */
watch(workspaceRevision, () => {
  if (awaitingWholeCard) {
    awaitingWholeCard = false;
    loading.value = false;
  }
  if (!props.session) return;
  // 两条忙碌态共用同一套"序号是否推进"的判据，但各自收敛：一次 fetch 的回包
  // 不该把同目录上还在飞的刷新也收掉（反之亦然）。
  const converge = (busy: Set<string>): Set<string> => {
    const next = new Set(busy);
    for (const dir of next) {
      const rev = gitDirRevision(state.activeRegion, props.teamId, props.session!.id, dir);
      if (rev > (requestedRev.get(dir) ?? 0)) next.delete(dir);
    }
    return next;
  };
  if (refreshingDirs.value.size) {
    const next = converge(refreshingDirs.value);
    if (next.size !== refreshingDirs.value.size) refreshingDirs.value = next;
  }
  if (fetchingDirs.value.size) {
    const next = converge(fetchingDirs.value);
    if (next.size !== fetchingDirs.value.size) fetchingDirs.value = next;
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

/**
 * 会话或**目录列表内容**变化 → 重拉 + 重置视图态。
 *
 * 键里必须带目录的完整内容而不只是条数（2026-11 缺陷）：把工作区从 `/a` 改成
 * `/b` 时条数不变，此前既不重拉也不重置展开态——卡片继续显示 `/a` 的旧快照。
 */
watch(
  () => [
    props.session?.id ?? '',
    (props.session?.directories ?? []).map(directoryToInput).join('\n'),
  ].join('\u0000'),
  () => {
    expansion.reset();
    onlyChanged.value = false;
    requestedRev.clear();
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

onBeforeUnmount(() => {
  window.clearTimeout(cardTimer);
  window.clearTimeout(dirTimer);
  window.clearTimeout(fetchTimer);
});
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
        :size="32"
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
            :refreshing="refreshingDirs.has(normalizeDir(dir.directory))"
            :fetching="fetchingDirs.has(normalizeDir(dir.directory))"
            @toggle-row="expansion.toggleRow(dir)"
            @toggle-group="(kind) => expansion.toggleGroup(dir, kind)"
            @refresh-dir="requestDir(dir.directory)"
            @fetch-dir="requestFetch(dir.directory)"
          />
        </template>
        <!-- 「只看变更」把所有仓库都滤掉时说一句：此前这里是一片空白，
             顶部却还写着「N 个仓库 · 全部干净」，看起来像加载失败 -->
        <p v-if="!visibleDirs.length" class="muted wgc-empty">
          （所有仓库都干净，「只看变更」暂时没有可显示的行）
        </p>
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
