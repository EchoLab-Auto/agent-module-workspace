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
import { state, federatedPeerLabel } from '@echo-agent/panel';
import { sendCommand } from '@echo-agent/panel';
import { scopedKey } from '@echo-agent/panel';
import type { WorkspaceSessionInfo } from '@echo-agent/panel';
import { directoryToInput, isRemoteDirectoryInput } from '../../workspace';
import PanelIcon from '@echo-agent/panel/components/PanelIcon';
import { workspace, workspaceRevision } from '../../workspace-store';

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
  void workspaceRevision.value; // 非响应式对象：靠结构版本号建立依赖
  return workspace.files[scopedKey(state.activeRegion, path)];
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
        <!-- 卡头图标钮（2026-11）：外框 26×26 / 圆角 8px / 14px 图标——与
             「当前会话」卡的刷新钮（`SessionContextCard` 的 `.session-context__refresh`）
             逐像素同形，同一右栏里两处刷新不出现两套尺寸。
             材质用 `raised`（实色凸起）而不是 `glass`：见样式段「高度模型」的说明。
             文字撤掉后语义必须落在 aria 上——`aria-label` 供读屏，`title`
             供鼠标悬停解释，两者同文案。
             图标走 `PanelIcon`（= ui-frame `NeumorphismIcon` 的薄封装：几何来自
             ui-frame 注册表，另加 Panel 的语义色调）：**扩展只能导入 Panel 的
             import map 里登记过的裸标识符**，而 `components/NeumorphismIcon`
             目前不在 `panel-shared.entries.json` 里——直接 import ui-frame 的
             组件会在运行期解析失败（构建期不报错，报错发生在用户浏览器里）。 -->
        <NeumorphismButton
          :size="32"
          variant="raised"
          class="wfb-ibtn"
          :disabled="!session || !roots.length"
          aria-label="重新读取全部已展开目录"
          title="重新读取全部已展开目录"
          @click="refresh"
        >
          <PanelIcon name="refresh" size="sm" />
        </NeumorphismButton>
        <NeumorphismButton
          :size="32"
          variant="raised"
          class="wfb-ibtn"
          :disabled="!expanded.size"
          aria-label="折叠全部目录"
          title="折叠全部目录"
          @click="collapseAll"
        >
          <PanelIcon name="minimize" size="sm" />
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
              {{ federatedPeerLabel(row.remoteNode) }}
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

/* 卡头图标钮的外框（2026-11）：26×26 / 圆角 8px，与「当前会话」卡的刷新钮
   （`SessionContextCard` 的 `.session-context__refresh`）逐像素一致。

   为什么要覆盖而不是传 prop：`NeumorphismButton` 的 `size` 只有 small(32px)
   / medium(44px) / large(56px) 三档，没有 26px；`shape="circle"` 更是锁在
   `--nm-button-min-height`（44px）。26px 不在枚举档内，属于**这一个位置**
   的尺寸，所以用局部选择器收口，不去挑战库的档位体系。

   选择器写成 `.wfb-actions .wfb-ibtn`（0,2,0）：要盖住组件内的
   `.nm-button--small { min-height: 32px; padding: … }` 与
   `.nm-button--rounded { border-radius: 16px }`（各 0,1,0）。`min-width` 也要
   显式给——small 档在 `(pointer: coarse)` 下被 `nm-touch-min` 抬到 44px，
  媒体查询不加特异性，这条规则同样盖得住它。 */
.wfb-actions .wfb-ibtn {
  width: 26px;
  height: 26px;
  min-width: 26px;
  min-height: 26px;
  padding: 0;
  border-radius: var(--nm-border-radius-sm);
}

/* 图标钮的高度模型（2026-11）：静止 = 0，悬停 = +，按下 = −。
   三态只动 `box-shadow` 与 `transform`，不碰尺寸——26px 是固定档，按下时若改
   宽高会带动卡头高度抖动。

   材质是 `variant="raised"`（实色新拟态），不是玻璃档：
   - 玻璃档的半透明底 + `backdrop-filter` 在卡片底色上等于没底，静止态必须靠
     1px 高光描边才看得见按钮，那描边本身就是一层"假立体"；而且悬停/按下两态
     都被本文件的规则接管，玻璃真正的价值（磨砂）只剩一层看不见的模糊。
   - `raised` 的实色底（`--nm-surface-color`）自带轮廓，静止态可以做到**真·高度
     0**：没有投影，也没有为了"看得见"而加的描边。

   三态的深度（26px 小钮，深度整体收一档——库内 `nm-raised` 的 4px/8px 是给
   44px 按钮的，用在 26px 上像个凸出来的方块）：
   - 静止 0：`box-shadow: none`，贴平；焦点环改由 `outline` 画（见下），不占用
     `box-shadow`——否则静止态的 none 会把库自带的 focus 环一起抹掉。
   - 悬停 +：`2px 2px 5px` 暗 + `-2px -2px 5px` 亮（凸起双阴影，与
     `nm-raised-strong` 同公式，深度减半），配 `translateY(-1px)`。
   - 按下 −：反向 `inset 2px 2px 4px` / `inset -2px -2px 4px`，视觉陷进表面。

   都带 `:not(.nm-button--disabled)`：禁用钮不该因悬停浮起来。

   三条规则写成**平铺选择器**而不是嵌套 `&`：本文件 `<style scoped>` 是纯 CSS
   （无 `lang="scss"`），嵌套要靠浏览器原生 CSS nesting——能跑，但与文件内其余
   两百行平铺写法不一致，且多一层兼容面。 */
.wfb-actions .wfb-ibtn {
  box-shadow: none;
  transition:
    box-shadow 0.2s ease,
    transform 0.2s ease;
}

/* 焦点环独立画：静止态把 `box-shadow` 清零了，库自带的 `:focus-visible` 环
   也走 `box-shadow`，会被一起抹掉。用 `outline` 补回来——它不占布局、也不与
   深度模型抢同一个属性。 */
.wfb-actions .wfb-ibtn:focus-visible {
  outline: 2px solid var(--nm-primary-color);
  outline-offset: 2px;
}

@media (hover: hover) {
  .wfb-actions .wfb-ibtn:not(.nm-button--disabled):hover {
    transform: translateY(-1px);
    box-shadow:
      2px 2px 5px var(--nm-shadow-dark),
      -2px -2px 5px var(--nm-shadow-light);
  }
}

.wfb-actions .wfb-ibtn:not(.nm-button--disabled):active {
  transform: translateY(0);
  box-shadow:
    inset 2px 2px 4px var(--nm-shadow-dark-deep),
    inset -2px -2px 4px var(--nm-shadow-light-deep);
}

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
