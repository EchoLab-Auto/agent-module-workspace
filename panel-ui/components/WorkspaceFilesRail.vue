<script setup lang="ts">
import type { WorkspaceSessionInfo } from '@echo-agent/panel';
import { setEntryOverlay, overlayId } from '@echo-agent/panel';
import WorkspaceFileBrowser from './WorkspaceFileBrowser.vue';

defineProps<{ session: WorkspaceSessionInfo; teamId: string | null }>();
</script>

<template>
  <div class="rail-files">
    <button
      type="button"
      class="rail-files__manage"
      title="工作区会话管理（新建 / 编辑 / 激活、多对话）"
      @click="setEntryOverlay(overlayId('echo-agent.workspace', 'sessions'))"
    >
      工作区会话管理 →
    </button>
    <WorkspaceFileBrowser :session="session" :team-id="teamId" />
  </div>
</template>

<style scoped>
.rail-files { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.rail-files__manage {
  flex: 0 0 auto;
  border: 0;
  padding: 9px 14px;
  text-align: left;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
}
.rail-files__manage:hover { color: var(--accent); }
</style>
