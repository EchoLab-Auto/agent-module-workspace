//! 工作区会话面板（workspace 模块）：会话管理（新建/编辑/删除/激活）、
//! 会话内**对话管理**（2026-10 多对话：新建/重命名/删除/切换）与
//! 各目录 git 状态已迁至边栏独立卡片（2026-10 `WorkspaceGitCard`）。文件浏览器已迁至会话视图右侧边栏（2026-09-19，
//! `ChatView` 的 workspace-rail 卡）。
//!
//! 数据流：命令带 team_id 路由到对应 persona（去主智能体后必填）；
//! Core 以 `WorkspaceSessions` / `WorkspaceGitStatus` 事件回推。
//! 弹层几何由 ChatView 的 `PanelPopover` 提供。
//!
//! 对话 CRUD：Core 无独立协议命令——经 `SaveWorkspaceSession` 全量
//! upsert 会话（conversations 数组整体替换，面板侧镜像 Core
//! `upsert_conversation` 的物化/slug/legacy 语义）；删除对话额外按通道
//! id 发 `ClearHistory` 清空其聊天历史（两步确认，不可恢复）。

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import NeumorphismButton from '@echolab-auto/ui-frame/components/NeumorphismButton';
import { state } from '@echo-agent/panel';
import { sendCommand, sendPending } from '@echo-agent/panel';
import { releasePending, usePending } from '@echo-agent/panel';
import LoadHint from '@echo-agent/panel/components/LoadHint';
import PanelIcon from '@echo-agent/panel/components/PanelIcon';
import type { WorkspaceConversationInfo, WorkspaceSessionInfo } from '@echo-agent/panel';
import {
  conversationsView,
  conversationIdForName,
  directoryNode,
  directoryPath,
  directoryToInput,
  noteLocalActivateIntent,
  workspaceChannelSessionId,
} from '../workspace';
import DirectoryPicker from './DirectoryPicker.vue';
import { confirmDialog } from '@echo-agent/panel';
import { ensureWorkspaceSessions, WORKSPACE_SESSIONS_KEY } from '../workspace-prefetch';

const props = defineProps<{ teamId: string | null }>();

/** 当前列表归属 (team, core) 与请求目标一致才渲染（避免跨 team/core 串显）。 */
const fresh = computed(
  () =>
    state.workspaceTeamId === props.teamId &&
    (state.workspaceCore ?? null) === (state.activeRegion ?? null),
);
const sessions = computed(() => (fresh.value ? state.workspaceSessions : []));
const activeId = computed(() => (fresh.value ? state.workspaceActive : null));
/** 当前激活对话 id（2026-10 多对话；旧 Core 恒 null）。 */
const activeConversationId = computed(() =>
  fresh.value ? state.workspaceActiveConversation : null,
);

const selectedId = ref<string>('');
const selected = computed(
  () => sessions.value.find((s) => s.id === selectedId.value) ?? sessions.value[0] ?? null,
);

// 列表变化时校正选择（删除/切换 team 后回退到激活会话或首个）。
watch(
  sessions,
  (list) => {
    if (!list.some((s) => s.id === selectedId.value)) {
      selectedId.value = activeId.value && list.some((s) => s.id === activeId.value)
        ? activeId.value
        : (list[0]?.id ?? '');
    }
  },
  { immediate: true },
);

function requestSessions(): void {
  if (!props.teamId) return; // 未选择智能体：不发（Core 会拒绝无 team_id 的会话类命令）
  sendPending({ RequestWorkspaceSessions: { team_id: props.teamId } }, WORKSPACE_SESSIONS_KEY);
}

/**
 * 挂载时按需补拉：**本地已有本 agent 的新鲜数据、或已有请求在飞时都不发**。
 *
 * 为什么不能无条件发：`App.vue` 在切换 agent 时已经拉过一次；打开面板再发一次
 * 只是把 `LoadHint` 点亮。实测（3G）：面板 961ms 出现时 5 张卡片、50 个按钮全
 * 都已渲染，却在 1127ms 挂上「正在加载工作区会话…」，6.8 秒后才消失 —— 一次
 * 完全没有必要的"假加载"。
 *
 * 判据与「点开前的意图预取」共用 `workspace-prefetch.ts`（team + core 都要对
 * 得上；跨 agent / 跨 core 的旧数据不算新鲜）。「刷新」按钮仍无条件重发。
 */
function requestSessionsIfStale(): void {
  // 判定与「点开前的意图预取」共用一处（`workspace-prefetch.ts`）：本地已新鲜
  // 或已有请求在飞时都不再发。否则预取与挂载会各发一次，白挂两条等待。
  ensureWorkspaceSessions(props.teamId, state.activeRegion ?? null);
}

// ── 选中 ──

/** 选中会话（只影响本面板的编辑目标；git 状态已由边栏 Git 卡片自理）。 */
function select(session: WorkspaceSessionInfo) {
  selectedId.value = session.id;
}

// ── 新建 / 编辑 ──
const editing = ref<null | { id: string }>(null);
const formName = ref('');
const formDescription = ref('');
const formDirs = ref('');
const actionPending = ref<string | null>(null);
const actionError = ref<string | null>(null);
let actionTimer: number | undefined;
function beginAction(key: string): boolean {
  if (actionPending.value) return false;
  actionPending.value = key; actionError.value = null;
  if (actionTimer) window.clearTimeout(actionTimer);
  actionTimer = window.setTimeout(() => {
    if (actionPending.value === key) { actionPending.value = null; actionError.value = '操作超时，请检查连接后重试；当前内容已保留。'; }
  }, 8000);
  return true;
}
function finishAction(): void {
  actionPending.value = null;
  if (actionTimer) window.clearTimeout(actionTimer);
  actionTimer = undefined;
}

function startCreate() {
  editing.value = { id: '' };
  formName.value = '';
  formDescription.value = '';
  formDirs.value = '';
}

function startEdit(session: WorkspaceSessionInfo) {
  editing.value = { id: session.id };
  formName.value = session.name;
  formDescription.value = session.description ?? '';
  // 规范化：跨机目录 {path,node} → `node://<node>/<path>` 编辑串
  // （此前直接 join 会把对象变成 "[object Object]"）。
  formDirs.value = (session.directories ?? []).map(directoryToInput).join('\n');
}

function cancelEdit() {
  editing.value = null;
}

// ── 目录选择器（2026-10）：浏览本机/联邦节点目录树挑选 ──
const pickerOpen = ref(false);

/** 选择器回填：追加一行目录到编辑框（去重，保留手写能力）。 */
function onPickDirectory(path: string) {
  const lines = formDirs.value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (!lines.includes(path)) {
    lines.push(path);
  }
  formDirs.value = lines.join('\n');
  pickerOpen.value = false;
}

function save() {
  if (!props.teamId || !editing.value) return;
  const id = editing.value.id;
  if (!formName.value.trim() || !beginAction(id ? `save:${id}` : 'save:new')) return;
  const existing = id ? sessions.value.find((s) => s.id === id) : undefined;
  const session: WorkspaceSessionInfo = {
    ...(existing ?? {}),
    id,
    name: formName.value.trim(),
    description: formDescription.value.trim(),
    directories: formDirs.value.split('\n').map((line) => line.trim()).filter(Boolean),
    // SaveWorkspaceSession is a full replacement: never erase conversations on metadata edit.
    conversations: existing?.conversations ?? [],
    last_conversation: existing?.last_conversation ?? null,
  };
  sendCommand({ SaveWorkspaceSession: { team_id: props.teamId, session } });
}

// ── 激活 / 删除 ──
function toggleActive(session: WorkspaceSessionInfo) {
  if (!props.teamId || actionPending.value) return;
  const id = session.id === activeId.value ? null : session.id;
  // 本窗口意图：回推到达时据此让视图跟随（他端广播不跟随，见 workspace.ts）。
  noteLocalActivateIntent(id);
  sendCommand({ ActivateWorkspaceSession: { team_id: props.teamId, id } });
}

async function remove(session: WorkspaceSessionInfo) {
  if (!props.teamId || !beginAction(`delete:${session.id}`)) return;
  const ok = await confirmDialog(
    `删除工作区会话「${session.name}」？（不影响磁盘目录与对话历史）`,
    { title: '删除工作区会话', danger: true, confirmText: '删除' },
  );
  if (!ok) { finishAction(); return; }
  sendCommand({ DeleteWorkspaceSession: { team_id: props.teamId, id: session.id } });
}

// ── 对话管理（2026-10 多对话）──
// Core 无独立对话 CRUD 命令：经 SaveWorkspaceSession 全量 upsert 会话
//（conversations 整体替换，镜像 Core upsert_conversation 的物化/slug/
// legacy 语义）；删除对话额外按通道 id 发 ClearHistory 清空其聊天历史。

/** (工作区, 对话) 是否当前激活对。 */
function isActiveConversation(
  session: WorkspaceSessionInfo,
  conv: WorkspaceConversationInfo,
): boolean {
  return session.id === activeId.value && conv.id === activeConversationId.value;
}

/** 全量 upsert 会话（仅替换 conversations / last_conversation，其余字段原样回传）。 */
function saveConversations(
  session: WorkspaceSessionInfo,
  conversations: WorkspaceConversationInfo[],
  lastConversation?: string | null,
  alreadyPending = false,
) {
  if (!props.teamId) return;
  if (!alreadyPending && (actionPending.value || !beginAction(`conversation:${session.id}`))) return;
  sendCommand({
    SaveWorkspaceSession: {
      team_id: props.teamId,
      session: {
        ...session,
        id: session.id,
        name: session.name,
        description: session.description ?? '',
        directories: session.directories ?? [],
        conversations,
        last_conversation:
          lastConversation === undefined ? (session.last_conversation ?? null) : lastConversation,
      },
    },
  });
}

/** 点选对话 = 激活 (工作区, 对话)；已是当前对 → 不重发。 */
function switchConversation(session: WorkspaceSessionInfo, conv: WorkspaceConversationInfo) {
  if (!props.teamId || isActiveConversation(session, conv)) return;
  noteLocalActivateIntent(session.id, conv.id);
  sendCommand({
    ActivateWorkspaceSession: { team_id: props.teamId, id: session.id, conversation: conv.id },
  });
}

/** 对话内联表单：convId = null 新建，否则重命名该对话。 */
const convForm = ref<null | { wsId: string; convId: string | null }>(null);
const convFormName = ref('');

function startConvCreate(session: WorkspaceSessionInfo) {
  convForm.value = { wsId: session.id, convId: null };
  convFormName.value = '';
}

function startConvRename(session: WorkspaceSessionInfo, conv: WorkspaceConversationInfo) {
  convForm.value = { wsId: session.id, convId: conv.id };
  convFormName.value = conv.name;
}

function cancelConvForm() {
  convForm.value = null;
}

function saveConvForm(session: WorkspaceSessionInfo) {
  if (actionPending.value) return;
  const name = convFormName.value.trim();
  if (!name || !convForm.value) return;
  // 物化隐式主对话（旧档 conversations 为空时补位 {id:"main", legacy:true}），
  // 与 Core 写入路径 materialize_conversations 一致。
  const convs = conversationsView(session).map((c) => ({ ...c }));
  if (convForm.value.convId === null) {
    const id = conversationIdForName(name, convs.map((c) => c.id));
    // 镜像 Core：存量裸通道（legacy）每工作区至多一条；legacy 对话被删后
    // 新对话可再次占用裸通道（其历史已在删除时清空）。
    convs.push({ id, name, legacy: !convs.some((c) => c.legacy) });
  } else {
    const target = convs.find((c) => c.id === convForm.value!.convId);
    if (!target) return;
    target.name = name;
  }
  saveConversations(session, convs);
  convForm.value = null;
}

async function removeConversation(session: WorkspaceSessionInfo, conv: WorkspaceConversationInfo) {
  if (!props.teamId || actionPending.value) return;
  const ok = await confirmDialog(
    `删除对话「${conv.name}」？该对话的聊天历史将被清空，不可恢复。`,
    { title: '删除对话', danger: true, confirmText: '删除' },
  );
  if (!ok) return;
  if (!beginAction(`conversation:${session.id}`)) return;
  // 先清通道历史（legacy → 裸 ws 通道；其余 → <ws>/<conv> 通道）。
  sendCommand({
    ClearHistory: {
      team_id: props.teamId,
      session_id: workspaceChannelSessionId(session.id, conv),
    },
  });
  const rest = conversationsView(session).filter((c) => c.id !== conv.id).map((c) => ({ ...c }));
  // last_conversation 指向被删对话时回退首条（Core set_active 亦有兜底）。
  const last =
    session.last_conversation === conv.id ? (rest[0]?.id ?? null) : undefined;
  saveConversations(session, rest, last, true);
}

const { phase: sessionsPhase } = usePending(WORKSPACE_SESSIONS_KEY);

/**
 * 首屏骨架：**正在等第一批数据**且本地一条都没有时才显示。
 *
 * 为什么不只用 `LoadHint`：提示条是一行文字 + 转圈，列表区仍是空白，视觉上
 * 依旧"什么都没发生"。骨架先把卡片的形状铺出来（标题条 + 两行说明），等数据
 * 到达原地替换——感知延迟从"等"变成"内容正在成形"。
 *
 * 条件里的 `!sessions.length` 很关键：已有数据时的刷新**不能**用骨架盖住内容
 * （那会把"刷新"变成"清空再重画"，比不动更糟）。
 */
const showSkeleton = computed(
  () =>
    sessions.value.length === 0 &&
    (sessionsPhase.value === 'pending' || sessionsPhase.value === 'slow'),
);
watch(sessions, (list) => {
  const key = actionPending.value;
  if (key?.startsWith('save:') || key?.startsWith('delete:') || key?.startsWith('conversation:')) {
    const id = key.split(':')[1];
    const confirmed = (key.startsWith('delete:') && !list.some((s) => s.id === id))
      || (!key.startsWith('delete:') && list.some((s) => s.id === id));
    if (confirmed) {
      finishAction();
      if (key.startsWith('save:')) editing.value = null;
      if (key.startsWith('conversation:')) convForm.value = null;
    }
  }
}, { deep: true });

onMounted(() => {
  if (!state.connected) return;
  requestSessionsIfStale();
});

onUnmounted(() => {
  releasePending(WORKSPACE_SESSIONS_KEY);
  if (actionTimer) window.clearTimeout(actionTimer);
});

watch(
  () => state.connected,
  (connected) => {
    // 重连：本地快照可能已过期（Core 可能重启过），故这里**无条件**重拉
    // ——与 `onMounted` 的"有数据就不打扰"是两种场景。
    if (connected) requestSessions();
  },
);

</script>

<template>
  <div class="ws-panel">
    <p v-if="actionError" class="ws-error">{{ actionError }}</p>
    <!-- 会话管理 -->
    <section class="ws-pane--main">
      <div class="ws-head">
      <div class="ws-head__text">
        <h2>工作区会话</h2>
        <p class="ws-head__sub">多会话 · 多工作区目录 · 每会话多对话（git 状态见侧边栏「Git」卡片）</p>
      </div>
      <div class="ws-head__actions">
        <NeumorphismButton size="small" variant="glass" :disabled="!state.connected" @click="startCreate">
          新建
        </NeumorphismButton>
        <NeumorphismButton size="small" variant="glass" :disabled="!state.connected" @click="requestSessions">
          刷新
        </NeumorphismButton>
      </div>
    </div>

    <!-- 加载 / 慢 / 超时重试：**必须在列表之前**（2026-10 修复）。
         此前它在 `.ws-list` 之后：实测 5 张卡片内容 1717px、可视 654px，
         提示条落在 ~1710px 处——要向下滚 1000 多像素才看得到，于是"正在加载"
         与"超时重试"在用户眼里**等于不存在**，面板就是一片空白卡片区。
         `sticky` 让它在长列表里也始终贴着面板顶边。 -->
    <LoadHint :phase="sessionsPhase" label="工作区会话" @retry="requestSessions" />

    <p v-if="!teamId" class="muted ws-hint">（请先在上方选择智能体）</p>

    <!-- 新建 / 编辑表单 -->
    <div v-if="editing" class="ws-form">
      <label class="ws-field">
        <span>名称</span>
        <input v-model="formName" class="ws-input" placeholder="例如：EchoAgent 框架" />
      </label>
      <label class="ws-field">
        <span>描述</span>
        <input v-model="formDescription" class="ws-input" placeholder="可选" />
      </label>
      <label class="ws-field">
        <span class="ws-form__dirs-head">
          工作区目录（每行一个绝对路径；跨机工作区（2026-10）支持
          <code>node://&lt;联邦peer&gt;/&lt;绝对路径&gt;</code> 远程目录，
          如 <code>node://gpu-box/srv/repo</code>——需联邦在线且对端
          allow_queries 放行 workspace_files / workspace_git_status /
          browse_directories）
          <NeumorphismButton size="small" variant="glass" @click="pickerOpen = true">
            浏览…
          </NeumorphismButton>
        </span>
        <textarea
          v-model="formDirs"
          class="ws-textarea"
          rows="4"
          placeholder="/home/evence/.local/share/echo-agent-core/source&#10;node://gpu-box/srv/remote-repo"
        />
      </label>
      <div class="ws-form__actions">
        <NeumorphismButton size="small" variant="glass" :disabled="!formName.trim() || !!actionPending" @click="save">
          {{ actionPending?.startsWith('save:') ? '保存中…' : '保存' }}
        </NeumorphismButton>
        <NeumorphismButton size="small" variant="glass" @click="cancelEdit">取消</NeumorphismButton>
      </div>
    </div>

    <!-- 首屏骨架：等第一批数据时先铺出卡片形状（见 `showSkeleton` 注释）。 -->
    <div v-if="showSkeleton" class="ws-list ws-list--skeleton" aria-hidden="true">
      <div v-for="n in 3" :key="n" class="ws-card ws-card--skeleton">
        <div class="ws-skeleton__line ws-skeleton__line--title"></div>
        <div class="ws-skeleton__line"></div>
        <div class="ws-skeleton__line ws-skeleton__line--short"></div>
      </div>
    </div>
    <!-- 会话列表 -->
    <div v-else class="ws-list">
      <div
        v-for="session in sessions"
        :key="session.id"
        class="ws-card"
        :class="{ 'is-active': session.id === activeId, 'is-selected': session.id === selected?.id }"
        @click="select(session)"
      >
        <div class="ws-card__head">
          <span class="ws-card__name">{{ session.name }}</span>
          <span v-if="session.id === activeId" class="ws-badge">已激活</span>
        </div>
        <p v-if="session.description" class="ws-card__desc">{{ session.description }}</p>
        <div class="ws-card__dirs">
          <span
            v-for="(dir, index) in session.directories ?? []"
            :key="directoryToInput(dir) + index"
            class="ws-dir-chip"
            :title="directoryToInput(dir)"
          >
            <span v-if="directoryNode(dir)" class="ws-dir-chip__node">
              {{ directoryNode(dir) }}
              <PanelIcon name="link" size="xs" aria-label="远程节点" />
            </span>{{ directoryPath(dir) }}
          </span>
          <span v-if="!(session.directories ?? []).length" class="muted">（尚未配置目录）</span>
        </div>
        <!-- 对话管理（2026-10 多对话）：点选 = 切换激活对话；删除两步确认并清历史 -->
        <div class="ws-convs" @click.stop>
          <div class="ws-convs__head">
            <span class="ws-convs__title">对话</span>
            <NeumorphismButton
              size="small"
              variant="glass"
              :disabled="!state.connected"
              @click="startConvCreate(session)"
            >
              新建对话
            </NeumorphismButton>
          </div>
          <div
            v-for="conv in conversationsView(session)"
            :key="conv.id"
            class="ws-conv"
            :class="{ 'is-active': isActiveConversation(session, conv) }"
            :title="workspaceChannelSessionId(session.id, conv)"
            @click="switchConversation(session, conv)"
          >
            <template v-if="convForm && convForm.wsId === session.id && convForm.convId === conv.id">
              <input
                v-model="convFormName"
                class="ws-input ws-conv__input"
                placeholder="对话名称"
                @click.stop
                @keyup.enter="saveConvForm(session)"
                @keyup.esc="cancelConvForm"
              />
              <span class="ws-conv__actions">
                <NeumorphismButton
                  size="small"
                  variant="glass"
                  :disabled="!convFormName.trim()"
                  @click="saveConvForm(session)"
                >
                  保存
                </NeumorphismButton>
                <NeumorphismButton size="small" variant="glass" @click="cancelConvForm">
                  取消
                </NeumorphismButton>
              </span>
            </template>
            <template v-else>
              <span class="ws-conv__name">{{ conv.name }}</span>
              <span v-if="isActiveConversation(session, conv)" class="ws-badge">当前</span>
              <span class="ws-conv__actions">
                <NeumorphismButton size="small" variant="glass" @click.stop="startConvRename(session, conv)">
                  改名
                </NeumorphismButton>
                <NeumorphismButton size="small" variant="glass" @click.stop="removeConversation(session, conv)">
                  删除
                </NeumorphismButton>
              </span>
            </template>
          </div>
          <div
            v-if="convForm && convForm.wsId === session.id && convForm.convId === null"
            class="ws-conv ws-conv--form"
          >
            <input
              v-model="convFormName"
              class="ws-input ws-conv__input"
              placeholder="新对话名称"
              @click.stop
              @keyup.enter="saveConvForm(session)"
              @keyup.esc="cancelConvForm"
            />
            <span class="ws-conv__actions">
              <NeumorphismButton
                size="small"
                variant="glass"
                :disabled="!convFormName.trim()"
                @click="saveConvForm(session)"
              >
                创建
              </NeumorphismButton>
              <NeumorphismButton size="small" variant="glass" @click="cancelConvForm">
                取消
              </NeumorphismButton>
            </span>
          </div>
        </div>
        <div class="ws-card__actions" @click.stop>
          <NeumorphismButton size="small" variant="glass" @click="toggleActive(session)">
            {{ session.id === activeId ? '取消激活' : '激活' }}
          </NeumorphismButton>
          <NeumorphismButton size="small" variant="glass" @click="startEdit(session)">编辑</NeumorphismButton>
          <NeumorphismButton size="small" variant="glass" :disabled="!!actionPending" @click="remove(session)">删除</NeumorphismButton>
        </div>
      </div>
      <div v-if="teamId && !sessions.length && sessionsPhase === 'idle'" class="muted ws-empty">
        （暂无工作区会话，点击「新建」创建第一个）
      </div>
    </div>
    </section>
  </div>

  <!-- 目录选择器（2026-10）：浏览本机/联邦节点目录树 -->
  <DirectoryPicker
    v-if="pickerOpen"
    @select="onPickDirectory"
    @close="pickerOpen = false"
  />
</template>

<style scoped>
/* 外层几何由 ChatView 的 PanelPopover 提供：这里只负责内部排版。 */
.ws-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  width: 100%;
}
.ws-pane--main {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  min-height: 0;
}

.ws-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.ws-head__text { min-width: 0; }
.ws-head h2 { margin: 0; font-size: 15px; font-weight: 700; color: var(--nm-text-primary); }
.ws-head__sub { margin: 2px 0 0; font-size: 11px; color: var(--nm-text-secondary); }
.ws-head__actions { display: flex; gap: 6px; flex: 0 0 auto; }

.ws-hint { margin: 0; font-size: 12px; }

/* 加载提示：贴住面板顶边（长列表里滚动了也看得见）。
   子组件根元素会带上本组件的 scope id，这里可以直接选中。 */
.ws-pane--main > .load-hint {
  position: sticky;
  top: 0;
  z-index: 2;
}

/* ── 首屏骨架（见 showSkeleton 注释） ──
   只用背景色块，不用动画条：等待通常只有几百毫秒，扫光动画反而更"闹"。
   色块用 `--nm-border-color` 的低透明度，深浅主题自动跟随。 */
.ws-list--skeleton { pointer-events: none; }
.ws-card--skeleton { cursor: default; gap: 8px; }
.ws-skeleton__line {
  height: 10px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--nm-border-color) 55%, transparent);
}
.ws-skeleton__line--title { height: 14px; width: 42%; }
.ws-skeleton__line--short { width: 64%; }

.ws-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--panel-accent);
  border-radius: 12px;
  background: var(--panel-accent-soft);
}
.ws-field { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--nm-text-secondary); }
.ws-form__dirs-head {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.ws-input, .ws-textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 8px;
  font-size: 12px;
  color: var(--nm-text-primary);
  background: var(--nm-surface-raised);
  border: 1px solid var(--nm-border-color);
  border-radius: 8px;
  resize: vertical;
}
.ws-textarea { font-family: var(--nm-font-mono, monospace); min-height: 64px; }
.ws-form__actions { display: flex; gap: 6px; justify-content: flex-end; }

.ws-list {
  min-width: 0;
  padding: 2px; display: flex; flex-direction: column; gap: 8px; }
.ws-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--nm-border-color);
  border-radius: 12px;
  background: var(--nm-surface-raised);
  cursor: pointer;
  transition: border-color 0.15s ease;
}
.ws-card:hover { border-color: var(--panel-accent); }
.ws-card.is-selected { border-color: var(--panel-accent); }
.ws-card.is-active { background: var(--panel-accent-soft); }
.ws-card__head { display: flex; align-items: center; gap: 8px; }
.ws-card__name { font-size: 13px; font-weight: 600; color: var(--nm-text-primary); }
.ws-badge {
  font-size: 10px;
  font-weight: 700;
  color: var(--panel-ok, #2ea46e);
  background: color-mix(in srgb, var(--panel-ok, #2ea46e) 14%, transparent);
  border-radius: 999px;
  padding: 1px 8px;
}
.ws-card__desc { margin: 0; font-size: 11px; color: var(--nm-text-secondary); }
.ws-card__dirs { display: flex; flex-wrap: wrap; gap: 4px; }
.ws-dir-chip__node {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: var(--panel-accent, #546200);
  font-weight: 600;
  margin-right: 2px;
}
.ws-card__actions { display: flex; gap: 6px; justify-content: flex-end; }

/* 对话管理（2026-10 多对话）：卡内嵌列表，风格对齐会话切换器行。 */
.ws-convs {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 6px;
  border-top: 1px dashed var(--nm-border-color);
}
.ws-convs__head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ws-convs__title {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--nm-text-secondary);
}
.ws-conv {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: 1px solid transparent;
  border-radius: 8px;
  font-size: 12px;
  color: var(--nm-text-primary);
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.ws-conv:hover { background: var(--panel-hover); }
.ws-conv.is-active {
  border-color: var(--panel-accent);
  background: var(--panel-accent-soft);
}
.ws-conv--form { cursor: default; }
.ws-conv__name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ws-conv__input { flex: 1 1 auto; min-width: 0; }
.ws-conv__actions { display: flex; gap: 4px; flex: 0 0 auto; }
.ws-dir-chip {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--nm-font-mono, monospace);
  font-size: 10px;
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid var(--nm-border-color);
  background: var(--panel-hover);
  color: var(--nm-text-secondary);
}
.ws-card__actions { display: flex; gap: 6px; justify-content: flex-end; }

.ws-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 4px;
  border-top: 1px solid var(--nm-border-color);
}
.ws-section__head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ws-section h3 { margin: 0; font-size: 12px; font-weight: 700; color: var(--nm-text-primary); }

.ws-empty { margin: 0; font-size: 12px; }
.ws-error { margin: 4px 0; color: var(--panel-err, #d9534f); font-size: 12px; }
</style>
