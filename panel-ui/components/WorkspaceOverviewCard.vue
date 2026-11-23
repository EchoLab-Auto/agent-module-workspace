<script setup lang="ts">
//! 工作区概览卡（workspace 模块，C4 试点）。
//!
//! 数据来自**模块私有方法** `workspace.overview`（通用调用通道
//! `InvokeModuleOp` → `ModuleInvokeResult`），不是宿主协议里的业务事件。
//! 配对 / 超时 / core 校验都在 `../workspace-overview.ts`，本组件只负责把
//! 三态（加载 / 成功 / 失败但有旧值）画出来，并提供手动刷新。
//!
//! 为什么是边栏卡而不是改进「工作区会话管理」弹层：这是一眼级别的数字
//! （几个工作区、几条对话），放进弹层等于每次都要开一次；卡片与文件浏览器 /
//! git 卡同列，切 agent 时一起更新。概览**只读**，没有任何写操作。
import { computed } from 'vue';
import NeumorphismButton from '@echolab-auto/ui-frame/components/NeumorphismButton';
import { state } from '@echo-agent/panel';
import { overviewFor, overviewRevision, requestOverview } from '../workspace-overview';

const props = defineProps<{ teamId: string | null; core: string | null }>();

const entry = computed(() => {
  // `entries` 是普通 Map：依赖结构版本号才会在回包 / 超时后重算。
  const revision = overviewRevision.value;
  if (revision < 0 || !props.teamId) return null;
  const found = overviewFor(props.teamId, props.core) ?? overviewFor(props.teamId, null);
  // **必须返回新对象**：回包 / 超时是原地改 `status`，若 computed 返回同一个
  // 引用，Vue 判定「值没变」，loading / data 两个下游 computed 不会重算
  //（实测：版本号已变、卡片仍停在「正在读取…」）。
  return found ? { ...found } : null;
});
const data = computed(() => entry.value?.data ?? null);
const loading = computed(() => entry.value?.status === 'loading');
const error = computed(() => (entry.value?.status === 'error' ? entry.value.error : null));

function refresh(): void {
  requestOverview(props.teamId, props.core, true);
}
</script>

<template>
  <div class="woc">
    <div class="woc-head">
      <span class="woc-title">工作区概览</span>
      <NeumorphismButton
        size="small"
        variant="glass"
        :disabled="loading || !state.connected || !teamId"
        title="重新读取工作区 / 对话数量（只读）"
        @click="refresh()"
      >
        {{ loading ? '读取中…' : '刷新' }}
      </NeumorphismButton>
    </div>

    <p v-if="!teamId" class="muted woc-empty">（未选择 agent）</p>
    <p v-else-if="!data && loading" class="muted woc-empty">（正在读取工作区概览…）</p>
    <p v-else-if="!data" class="muted woc-empty">{{ error ?? '（暂无概览）' }}</p>
    <template v-else>
      <div class="woc-grid">
        <div class="woc-stat">
          <strong>{{ data.workspaces }}</strong>
          <span>工作区</span>
        </div>
        <div class="woc-stat">
          <strong>{{ data.conversations }}</strong>
          <span>对话</span>
        </div>
        <div class="woc-stat">
          <strong>{{ data.directories }}</strong>
          <span>目录</span>
        </div>
      </div>
      <p v-if="data.remote_directories" class="muted woc-note">
        其中远程目录 {{ data.remote_directories }}
      </p>
      <p class="muted woc-note">
        当前激活：{{ data.active ?? '（未激活）' }}
      </p>
      <p v-if="error" class="woc-error">{{ error }}（下方为上次快照）</p>
    </template>
  </div>
</template>

<style scoped>
.woc {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.woc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.woc-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--nm-text-secondary);
}
.woc-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}
.woc-stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  padding: 6px 4px;
  border-radius: 8px;
  background: var(--panel-accent-soft);
}
.woc-stat strong {
  font-size: 15px;
  font-weight: 700;
  color: var(--panel-accent);
  line-height: 18px;
}
.woc-stat span {
  font-size: 10px;
  color: var(--nm-text-secondary);
}
.woc-empty,
.woc-note {
  margin: 0;
  font-size: 11px;
}
.woc-error {
  margin: 0;
  font-size: 11px;
  color: var(--danger, #d9534f);
}
</style>
