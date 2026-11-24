<script setup lang="ts">
//! 目录选择器（2026-10）：浏览「本机 / 各联邦节点」的目录树并选择。
//!
//! 与文件浏览器（WorkspaceFileBrowser）的区别：选择器面向**未声明的
//! 目录**（新建工作区时挑选），因此走 `RequestBrowseDirectories`——
//! 服务端限「浏览根」（工作区目录并集 ∪ HOME），而不是"会话已声明目录内"。
//!
//! 位置语义：
//! - `local`：当前运行区域（Panel 接入的 core）的本机目录；
//! - `<peer>`：联邦节点（经 activeRegion core 代理 `Query(BrowseDirectories)`，
//!   对端限同浏览根；需对端 allow_queries 含 browse_directories）。
//!
//! 行交互：点击 = 选择该目录（立即回填）；行尾「›」= 进入浏览。

import { computed, ref, watch } from 'vue';
import { state, federatedPeerLabel } from '@echo-agent/panel';
import { scopedKey } from '@echo-agent/panel';
import { sendCommand } from '@echo-agent/panel';
import NeumorphismButton from '@echolab-auto/ui-frame/components/NeumorphismButton';
import NeumorphismSelect from '@echolab-auto/ui-frame/components/NeumorphismSelect';
import PanelIcon from '@echo-agent/panel/components/PanelIcon';
import NeumorphismSpinner from '@echolab-auto/ui-frame/components/NeumorphismSpinner';

const props = defineProps<{
  /** 初始位置（编辑现有目录时可预置；缺省 local）。 */
  initial?: string | null;
}>();

const emit = defineEmits<{
  (e: 'select', path: string): void;
  (e: 'close'): void;
}>();

/** 位置：`local` 或联邦 peer 名。 */
const location = ref<string>(
  props.initial && props.initial !== 'local' ? props.initial : 'local',
);

/** 在线联邦节点（位置可选项）。 */
const peerNames = computed(() =>
  (state.federation?.peers ?? []).filter((p) => p.link === 'Online').map((p) => ({
    name: p.name,
    label: federatedPeerLabel(p.name, p.node_id, p.node_name),
  })),
);

/** 位置下拉选项（库 Select options；'local' = 当前区域，其余 = 联邦节点）。 */
const locationOptions = computed(() => [
  { label: '本机（当前区域）', value: 'local' },
  ...peerNames.value.map((peer) => ({ label: `${peer.label}（联邦节点）`, value: peer.name })),
]);

/** 导航栈：[] = 根视图；每进入一层 push { label, path }。 */
const stack = ref<Array<{ label: string; path: string }>>([]);

/** 当前位置下"根视图"的请求 path（local → null；peer → node://peer）。 */
const rootsRequestPath = computed<string | null>(() =>
  location.value === 'local' ? null : `node://${location.value}`,
);

/** 当前请求键：栈空 = 根视图；否则栈顶 path（与 reducer 写入键一致）。 */
const requestKey = computed(() =>
  scopedKey(state.activeRegion, stack.value.length ? stack.value[stack.value.length - 1].path : (rootsRequestPath.value ?? '')),
);

const listing = computed(() => state.browseDirectories[requestKey.value]);
const roots = computed(() => listing.value?.roots ?? []);
const entries = computed(() => listing.value?.entries ?? []);
const error = computed(() => listing.value?.error ?? null);

/** 请求键的"当前显示请求 path"（发请求用）。 */
function requestPath(): string | null {
  return stack.value.length
    ? stack.value[stack.value.length - 1].path
    : rootsRequestPath.value;
}

/** 发起一次浏览（进入目录 / 切换位置 / 刷新）。 */
function browse(path: string | null) {
  sendCommand({ RequestBrowseDirectories: { path } });
}

/** 切换位置：重置栈并拉根列表。 */
function pickLocation(next: string) {
  location.value = next;
  stack.value = [];
  browse(rootsRequestPath.value);
}

/** 进入一个目录（行尾「›」）。 */
function enter(label: string, path: string) {
  stack.value = [...stack.value, { label, path }];
  browse(path);
}

/** 面包屑回退。 */
function jump(index: number) {
  if (index < 0 || index >= stack.value.length) return;
  stack.value = stack.value.slice(0, index + 1);
  browse(requestPath());
}

function goUp() {
  if (!stack.value.length) return;
  if (stack.value.length === 1) {
    stack.value = [];
    browse(rootsRequestPath.value);
    return;
  }
  jump(stack.value.length - 2);
}

/** 选择：栈空时点根 = 选该根；否则选该行目录。 */
function select(path: string) {
  emit('select', path);
}

/** 选择"当前所在目录"（栈顶；栈空时不可选）。 */
const currentDir = computed(() => stack.value[stack.value.length - 1] ?? null);

function selectCurrent() {
  if (currentDir.value) select(currentDir.value.path);
}

// 打开时拉首屏（根列表）。
browse(rootsRequestPath.value);

/** 路径展示：去掉 node:// 前缀的简洁形式（hover 显示完整）。 */
function displayPath(path: string): string {
  return path;
}

watch(
  () => props.initial,
  (next) => {
    if (next && next.startsWith('node://')) {
      const peer = next.slice('node://'.length).split('/')[0];
      if (peer) {
        location.value = peer;
        stack.value = [];
        browse(rootsRequestPath.value);
      }
    }
  },
);
</script>

<template>
  <!-- Teleport 到 body（2026-10 审计修复）：本组件常挂在工作区面板
       （`SessionOverlay` 内）——外壳的 `backdrop-filter` 会把 fixed 后代的
       包含块改为自身、`overflow:auto` 再行裁剪，导致全屏遮罩只罩住面板、
       @click.self 关闭大面积失效。teleport 后 fixed/inset 参照视口。 -->
  <Teleport to="body">
    <div class="dp-overlay" @click.self="emit('close')">
    <div class="dp-panel">
      <div class="dp-head">
        <span class="dp-title">选择目录</span>
        <!-- 位置切换：本机 + 在线联邦节点 -->
        <NeumorphismSelect
          :model-value="location"
          class="dp-location"
          size="small"
          :options="locationOptions"
          @update:model-value="(v) => pickLocation(String(v ?? 'local'))"
        />
        <NeumorphismButton
          size="small"
          variant="glass"
          aria-label="关闭"
          @click="emit('close')"
        >
          <PanelIcon name="close" size="sm" />
        </NeumorphismButton>
      </div>

      <!-- 面包屑：位置 > 各级目录；栈空显示根视图 -->
      <div class="dp-crumbs">
        <button class="dp-crumb" @click="jump(-1)">
          {{ location === 'local' ? '本机' : location }}
        </button>
        <template v-for="(item, index) in stack" :key="item.path">
          <span class="dp-crumb-sep">/</span>
          <button class="dp-crumb" @click="jump(index)">{{ item.label }}</button>
        </template>
        <NeumorphismButton
          v-if="stack.length"
          size="small"
          variant="glass"
          class="dp-up"
          @click="goUp"
        >
          <PanelIcon name="arrow-up" size="sm" /> 上一级
        </NeumorphismButton>
      </div>

      <!-- 列表主体 -->
      <div class="dp-body">
        <div v-if="error" class="dp-error" :title="error">{{ error }}</div>
        <div v-else-if="!listing" class="dp-loading muted">
          <NeumorphismSpinner size="small" /> 读取中…
        </div>
        <template v-else>
          <!-- 根视图：浏览根列表 -->
          <template v-if="!stack.length">
            <div v-if="!roots.length" class="muted dp-empty">（无浏览根）</div>
            <div
              v-for="root in roots"
              :key="root.path"
              class="dp-row"
              :title="displayPath(root.path)"
              @click="select(root.path)"
            >
              <PanelIcon name="home" size="sm" class="dp-row__icon" />
              <span class="dp-row__name">{{ root.label }}</span>
              <span class="dp-row__path muted">{{ displayPath(root.path) }}</span>
              <button class="dp-enter" title="进入浏览" @click.stop="enter(root.label, root.path)">
                <PanelIcon name="chevron-right" size="sm" />
              </button>
            </div>
          </template>
          <!-- 目录视图：子目录 -->
          <template v-else>
            <div v-if="!entries.length" class="muted dp-empty">（无子目录）</div>
            <div
              v-for="entry in entries"
              :key="entry.path"
              class="dp-row"
              :title="displayPath(entry.path)"
              @click="select(entry.path)"
            >
              <PanelIcon name="folder" size="sm" class="dp-row__icon" />
              <span class="dp-row__name">{{ entry.name }}</span>
              <span class="dp-row__path muted">{{ displayPath(entry.path) }}</span>
              <button class="dp-enter" title="进入浏览" @click.stop="enter(entry.name, entry.path)">
                <PanelIcon name="chevron-right" size="sm" />
              </button>
            </div>
          </template>
        </template>
      </div>

      <div class="dp-foot">
        <span class="dp-current muted" :title="currentDir?.path ?? ''">
          {{ currentDir ? `当前：${displayPath(currentDir.path)}` : '点击根目录可选择或进入浏览' }}
        </span>
        <NeumorphismButton
          size="small"
          variant="primary"
          :disabled="!currentDir"
          @click="selectCurrent"
        >
          选择此目录
        </NeumorphismButton>
      </div>
    </div>
    </div>
  </Teleport>
</template>
<style scoped>
.dp-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--nm-mask-bg);
}
.dp-panel {
  width: min(560px, 92vw);
  max-height: 72vh;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-radius: 14px;
  background: var(--nm-surface-raised);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28);
}
.dp-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dp-title { font-weight: 600; flex: 1; }
.dp-location {
  max-width: 220px;
  padding: 4px 6px;
  border-radius: 8px;
  border: 1px solid var(--nm-border-color);
  background: transparent;
}
.dp-crumbs {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-wrap: wrap;
  font-size: 12px;
}
.dp-crumb {
  border: none;
  background: none;
  cursor: pointer;
  color: var(--panel-accent, #546200);
  padding: 2px 4px;
}
.dp-crumb-sep { opacity: 0.5; }
.dp-up { margin-left: 6px; }
.dp-body {
  flex: 1;
  overflow: auto;
  min-height: 180px;
  border: 1px solid var(--nm-border-color);
  border-radius: 10px;
  padding: 4px;
}
.dp-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  cursor: pointer;
}
.dp-row:hover { background: var(--panel-hover); }
/* 图标列：固定槽宽保证名称左缘对齐（emoji 换线框图标后不再依赖字号） */
.dp-row__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--nm-icon-size-md);
  color: var(--nm-text-secondary);
}
.dp-row__name { font-weight: 500; min-width: 0; }
.dp-row__path {
  flex: 1;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
}
.dp-enter {
  border: none;
  background: none;
  cursor: pointer;
  font-size: 14px;
  padding: 2px 6px;
  border-radius: 6px;
}
.dp-enter:hover { background: var(--panel-hover); }
.dp-error {
  padding: 10px;
  color: var(--panel-warn, #9a6700);
  font-size: 12px;
}
.dp-loading { padding: 12px; display: flex; gap: 6px; align-items: center; }
.dp-empty { padding: 12px; }
.dp-foot {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dp-current {
  flex: 1;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
}
</style>
