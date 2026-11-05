<script setup lang="ts">
//! 工作区文件浏览器（workspace 模块）：只读浏览选中会话的工作区目录。
//!
//! 按需加载：展开目录时向 Core 发 `RequestWorkspaceFiles`，Core 以
//! `WorkspaceFiles` 事件回推条目（目录在前、文件在后，隐藏项跳过）。
//! 服务端用 canonical 前缀校验限定在会话目录及其子孙内，越界返回错误。
//!
//! 树模型（2026-10，对齐 VS Code 资源管理器）：全部目录根以顶层分区同时
//! 呈现，目录**原地展开/折叠**（替代原先的路径栈导航 + 面包屑）；子目录
//! 首次展开时才懒加载，展开等待中在 twistie 位显示加载指示，失败以内联
//! 错误行展示。行点击即展开/折叠（chevron 随状态旋转）；14px/级缩进 +
//! 垂直导引线（对齐 VS Code 的 indent guides）。
//!
//! 目录根行的悬停速览（绝对路径）：根行只显示目录 basename，多根同名时
//! （如两个 `source/`）无法区分；悬停显示**绝对路径**。自绘 + Teleport，
//! 不复用原生 `title`（约 1s 延迟、样式不可控、长路径被系统截断）。
//! 也不复用库 `NeumorphismTooltip`：它自 ui-frame 1.3.2 起已 teleport 到 body
//! （不再被祖先 `overflow` 裁剪，当年的裁剪问题已消失），但内容仍是单行
//! `white-space: nowrap` 的字符串 + 库定样式——长路径不换行、非等宽字体、
//! 宽度不可调，给不出「整条绝对路径一次看全」的效果，故仍自绘。

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import NeumorphismButton from '@echolab-auto/ui-frame/components/NeumorphismButton';
import NeumorphismSpinner from '@echolab-auto/ui-frame/components/NeumorphismSpinner';
import { state } from '@echo-agent/panel';
import { sendCommand } from '@echo-agent/panel';
import { scopedKey } from '@echo-agent/panel';
import type { WorkspaceSessionInfo } from '@echo-agent/panel';
import { directoryToInput, isRemoteDirectoryInput } from '../workspace';
import PanelIcon from '@echo-agent/panel/components/PanelIcon';

const props = defineProps<{
  teamId: string | null;
  session: WorkspaceSessionInfo | null;
}>();

/** 目录根（规范化为字符串：本机路径 / 跨机 node:// 串）——Core 线格式
 * 中跨机目录是 `{path,node}` 表，直接当字符串用（basename/startsWith）
 * 会崩，这里统一规范化（2026-10）。 */
const roots = computed(() => (props.session?.directories ?? []).map(directoryToInput));

/** 展开集合（路径）：目录根与子目录共用。折叠 = 移除，展开 = 加入。 */
const expanded = ref<Set<string>>(new Set());

/** 某目录的缓存列表（Core 回推的 WorkspaceFiles）。 */
function listingFor(path: string) {
  return state.workspaceFiles[scopedKey(state.activeRegion, path)];
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.split('/').filter(Boolean).pop() ?? path;
}

// ── 扁平化行模型（树 → 行数组） ──────────────────────────────────────
//
// VS Code 的资源管理器是"展平可见节点"的虚拟列表；这里同构但省略虚拟化
// （侧边栏规模小）：树按「展开集合 + 列表缓存」派生为行数组，每行携带
// 缩进层级 depth，模板直接 v-for 渲染。

/** 扁平行（v-for 渲染单位）。 */
interface TreeRow {
  /** v-for key：真实路径；status 行加前缀避免与路径撞。 */
  key: string;
  path: string;
  label: string;
  depth: number;
  kind: 'root' | 'dir' | 'file' | 'error' | 'empty';
  /** 目录根行的跨机标注（节点名；本机 null）。 */
  remoteNode: string | null;
  /** 目录/根：是否展开（chevron 方向）。 */
  isOpen: boolean;
  /** 目录/根：已展开且列表尚未回推（twistie 位显示加载指示）。 */
  loading: boolean;
  /** 文件体积（目录为 0）。 */
  size: number;
}

/** 展开目录的子行；未回推 = 无子行（父行 loading 指示）。 */
function pushChildren(out: TreeRow[], path: string, depth: number): void {
  if (depth > 64) return; // 符号链接环兜底
  const listing = listingFor(path);
  if (!listing) return;
  if (listing.error) {
    out.push({
      key: `err:${path}`,
      path,
      label: listing.error,
      depth,
      kind: 'error',
      remoteNode: null,
      isOpen: false,
      loading: false,
      size: 0,
    });
    return;
  }
  if (!listing.entries.length) {
    out.push({
      key: `empty:${path}`,
      path,
      label: '（空目录）',
      depth,
      kind: 'empty',
      remoteNode: null,
      isOpen: false,
      loading: false,
      size: 0,
    });
    return;
  }
  for (const entry of listing.entries) {
    const open = entry.is_dir && expanded.value.has(entry.path);
    out.push({
      key: entry.path,
      path: entry.path,
      label: entry.name,
      depth,
      kind: entry.is_dir ? 'dir' : 'file',
      remoteNode: null,
      isOpen: open,
      loading: open && !listingFor(entry.path),
      size: entry.size,
    });
    if (open) pushChildren(out, entry.path, depth + 1);
  }
}

const rows = computed<TreeRow[]>(() => {
  const out: TreeRow[] = [];
  for (const root of roots.value) {
    const open = expanded.value.has(root);
    out.push({
      key: root,
      path: root,
      label: basename(root),
      depth: 0,
      kind: 'root',
      remoteNode: isRemoteDirectoryInput(root)
        ? root.slice('node://'.length).split('/')[0]
        : null,
      isOpen: open,
      loading: open && !listingFor(root),
      size: 0,
    });
    if (open) pushChildren(out, root, 1);
  }
  return out;
});

// ── 请求与交互 ───────────────────────────────────────────────────────

function requestFiles(path: string) {
  if (!state.connected || !props.teamId || !props.session || !path) return;
  sendCommand({
    RequestWorkspaceFiles: { team_id: props.teamId, session_id: props.session.id, path },
  });
}

/** 行点击：展开（顺手刷新）/ 折叠。 */
function toggle(path: string) {
  if (expanded.value.has(path)) {
    const next = new Set(expanded.value);
    next.delete(path);
    expanded.value = next;
  } else {
    expanded.value = new Set([...expanded.value, path]);
    requestFiles(path);
  }
}

/** 刷新：重读全部已展开目录；全折叠时回到首个根（重开视图语义）。 */
function refresh() {
  if (expanded.value.size) {
    for (const path of expanded.value) requestFiles(path);
    return;
  }
  const first = roots.value[0];
  if (first) {
    expanded.value = new Set([first]);
    requestFiles(first);
  }
}

/** 折叠全部（等价 VS Code 工具栏的 Collapse Folders）。 */
function collapseAll() {
  expanded.value = new Set();
}

// ── 目录根行的悬停速览（绝对路径） ────────────────────────────────────
//
// 定位用 `position: fixed` + 视口坐标：Teleport 到 body 后不受卡片滚动容器
// 裁剪；宽上限与 CSS 的 max-width 保持一致（超长路径换行、不截断）。

/** 速览宽度上限（px）——与 `.wfb-root-tip` 的 max-width 保持一致。 */
const ROOT_TIP_MAX_WIDTH = 340;

interface RootTip {
  path: string;
  x: number;
  y: number;
  /** true = 悬于根行上方（默认）；顶部空间不足时翻到下方。 */
  above: boolean;
}

const rootTip = ref<RootTip | null>(null);

function onRootEnter(row: TreeRow, event: Event) {
  if (row.kind !== 'root') return;
  const el = event.currentTarget as HTMLElement | null;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  // 视口内夹取：根行在窗口右侧栏内，靠右时左移使整条路径可见。
  const x = Math.max(
    8,
    Math.min(rect.left, window.innerWidth - ROOT_TIP_MAX_WIDTH - 8),
  );
  const above = rect.top > 72; // 上方留得下（约两行路径）就悬于上方
  rootTip.value = { path: row.path, x, y: above ? rect.top - 6 : rect.bottom + 6, above };
}

function onRootLeave(row: TreeRow) {
  if (row.kind !== 'root') return;
  rootTip.value = null;
}

/** 定位样式：`above` 时以上边缘为锚点整体上移。 */
const rootTipStyle = computed(() => {
  const tip = rootTip.value;
  if (!tip) return undefined;
  return {
    left: `${tip.x}px`,
    top: `${tip.y}px`,
    transform: tip.above ? 'translateY(-100%)' : 'none',
  };
});

// 滚动/缩放时根行的视口坐标会漂移：直接收起（重新悬停即可）。
function hideRootTip() {
  rootTip.value = null;
}

onMounted(() => {
  window.addEventListener('scroll', hideRootTip, true);
  window.addEventListener('resize', hideRootTip);
});
onBeforeUnmount(() => {
  window.removeEventListener('scroll', hideRootTip, true);
  window.removeEventListener('resize', hideRootTip);
});

// 会话切换（或目录配置变化）→ 重置树：只展开第一个根并请求。
watch(
  () => [props.session?.id ?? '', roots.value.join('\n')].join('|'),
  () => {
    const first = roots.value[0];
    expanded.value = first ? new Set([first]) : new Set();
    if (first) requestFiles(first);
  },
  { immediate: true },
);

// 重连后缓存已清空：重拉全部已展开目录。
watch(
  () => state.connected,
  (connected) => {
    if (connected) for (const path of expanded.value) requestFiles(path);
  },
);

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
</script>

<template>
  <div class="wfb">
    <div class="wfb-head">
      <span class="wfb-title">文件浏览器</span>
      <div class="wfb-actions">
        <NeumorphismButton
          size="small"
          variant="glass"
          :disabled="!session || !roots.length"
          title="重新读取全部已展开目录"
          @click="refresh"
        >
          刷新
        </NeumorphismButton>
        <NeumorphismButton
          size="small"
          variant="glass"
          :disabled="!expanded.size"
          title="折叠全部目录"
          @click="collapseAll"
        >
          折叠
        </NeumorphismButton>
      </div>
    </div>

    <!-- 根行悬停速览（绝对路径）：Teleport 到 body + fixed 定位，
         不被卡片滚动容器（overflow: auto）裁剪（见脚本区注释） -->
    <Teleport to="body">
      <div
        v-if="rootTip"
        class="wfb-root-tip"
        :style="rootTipStyle"
        role="tooltip"
      >
        {{ rootTip.path }}
      </div>
    </Teleport>

    <!-- 树（全部根分区同时呈现；行 = 缩进 + twistie + 图标 + 名称） -->
    <div class="wfb-tree">
      <div v-if="!session" class="muted wfb-empty">（暂无工作区会话）</div>
      <div v-else-if="!roots.length" class="muted wfb-empty">（未配置目录）</div>
      <template v-else>
        <div
          v-for="row in rows"
          :key="row.key"
          class="wfb-trow"
          :class="[`wfb-trow--${row.kind}`, { 'is-open': row.isOpen }]"
          :style="{ paddingLeft: `${6 + row.depth * 14}px` }"
        >
          <!-- 缩进导引线（每级一条，对齐 VS Code indent guides） -->
          <span
            v-for="g in row.depth"
            :key="g"
            class="wfb-guide"
            :style="{ left: `${13 + (g - 1) * 14}px` }"
            aria-hidden="true"
          />

          <!-- 目录 / 目录根：整行按钮（点击 = 展开/折叠） -->
          <button
            v-if="row.kind === 'root' || row.kind === 'dir'"
            type="button"
            class="wfb-tbtn"
            :title="row.kind === 'dir' ? row.path : undefined"
            :aria-expanded="row.isOpen"
            @click="toggle(row.path)"
            @mouseenter="onRootEnter(row, $event)"
            @mouseleave="onRootLeave(row)"
          >
            <span class="wfb-twistie">
              <NeumorphismSpinner v-if="row.loading" :size="12" label="读取中" />
              <PanelIcon v-else class="wfb-chevron" name="chevron-right" size="xs" />
            </span>
            <span class="wfb-ico" aria-hidden="true">
              <PanelIcon :name="row.isOpen ? 'folder-open' : 'folder'" size="sm" />
            </span>
            <span v-if="row.remoteNode" class="wfb-badge">
              {{ row.remoteNode }}
              <PanelIcon name="link" size="xs" aria-label="远程节点" />
            </span>
            <span class="wfb-name">{{ row.label }}</span>
          </button>

          <!-- 文件行：只读（无打开动作），右侧显示体积 -->
          <div v-else-if="row.kind === 'file'" class="wfb-tbtn wfb-tbtn--file" :title="row.path">
            <span class="wfb-twistie" aria-hidden="true" />
            <span class="wfb-ico wfb-ico--file" aria-hidden="true">
              <PanelIcon name="file" size="sm" />
            </span>
            <span class="wfb-name">{{ row.label }}</span>
            <span class="wfb-size">{{ formatSize(row.size) }}</span>
          </div>

          <!-- 错误 / 空目录占位行（与子级名称对齐） -->
          <div
            v-else
            class="wfb-trow__note"
            :class="{ 'is-error': row.kind === 'error' }"
            :title="row.kind === 'error' ? row.label : undefined"
          >
            {{ row.label }}
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.wfb {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.wfb-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.wfb-title { font-size: 12px; font-weight: 700; color: var(--nm-text-primary); }
.wfb-actions { display: flex; gap: 6px; }

/* 悬停速览（绝对路径）。
   注意：本节是 Teleport 到 body 的节点，**不属于 rail 卡片**——scoped 样式
   通过组件 id 属性仍能命中（Vue 给 teleport 内容加同一 scope id）。
   z-index 40：高于边栏（4）/入口行（6）/清单浮层（25）/Agent 菜单（30），
   低于模态与浮层遮罩（50+）。 */
.wfb-root-tip {
  position: fixed;
  z-index: 40;
  max-width: 340px; /* 与脚本 ROOT_TIP_MAX_WIDTH 保持一致 */
  padding: 4px 8px;
  border-radius: 8px;
  border: 1px solid var(--nm-border-color);
  background: var(--nm-surface-color);
  color: var(--nm-text-primary);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
  font-family: var(--nm-font-mono, monospace);
  font-size: 11px;
  line-height: 1.45;
  word-break: break-all; /* 长路径按任意字符换行，不截断 */
  pointer-events: none; /* 不抢 hover，避免闪烁 */
}

/* ── 树 ── */
.wfb-tree {
  display: flex;
  flex-direction: column;
  max-height: 48vh;
  overflow-y: auto;
  overflow-x: hidden;
}

.wfb-trow { position: relative; min-width: 0; }
.wfb-guide {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--nm-border-color);
  opacity: 0.55;
  pointer-events: none;
}

/* 行主体：目录 = button（可点击），文件 = 静态 div；两者同构保证名称对齐 */
.wfb-tbtn {
  display: flex;
  align-items: center;
  gap: 2px;
  width: 100%;
  min-width: 0;
  padding: 3px 8px 3px 0;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--nm-text-primary);
  font-family: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.wfb-tbtn:hover { background: var(--panel-hover); }
.wfb-trow--root .wfb-name { font-weight: 600; }
.wfb-trow--dir .wfb-tbtn { color: var(--panel-accent); }
.wfb-trow--dir .wfb-tbtn:hover { background: var(--panel-accent-soft); }
.wfb-ico {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  color: var(--nm-text-secondary);
}
.wfb-ico--file { opacity: 0.6; }
/* 目录图标跟随目录行的主色（accent），文件图标保持次级灰 */
.wfb-trow--dir .wfb-ico,
.wfb-trow--root .wfb-ico { color: var(--panel-accent); }
/* twistie 固定槽宽 14px：图标 12px 居中 + 两侧各 1px——
   保证展开/折叠/加载三态切换时行内名称左缘不位移；
   占位行缩进 34px = 14(twistie) + 2(gap) + 16(图标) + 2(gap) 与此一致。 */
.wfb-twistie {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
}
.wfb-chevron { transition: transform 0.12s ease; }
.wfb-trow.is-open .wfb-chevron { transform: rotate(90deg); }

.wfb-badge {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: none;
  margin-right: 2px;
  color: var(--panel-accent, #546200);
  font-size: 10px;
  font-weight: 600;
}

.wfb-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wfb-size {
  margin-left: auto;
  flex: none;
  padding-left: 8px;
  font-size: 10px;
  color: var(--nm-text-secondary);
  font-family: var(--nm-font-mono, monospace);
}

/* 错误 / 空目录占位行：与子级名称起点对齐（twistie 14 + gap 2 + 图标 16 + gap 2） */
.wfb-trow__note {
  padding: 2px 8px 2px 34px;
  font-size: 11px;
  color: var(--nm-text-secondary);
  overflow-wrap: anywhere;
}
.wfb-trow__note.is-error { color: var(--panel-err); }

.wfb-empty { font-size: 11px; }
</style>
