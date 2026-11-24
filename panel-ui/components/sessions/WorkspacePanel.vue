//! 工作区会话面板（workspace 模块）：会话管理（新建/编辑/删除/激活）、
//! 会话内**对话管理**（2026-10 多对话：新建/重命名/删除/切换）与
//! 各目录 git 状态已迁至边栏独立卡片（2026-10 `WorkspaceGitCard`）。文件浏览器已迁至会话视图右侧边栏（2026-09-19，
//! `ChatView` 的 workspace-rail 卡）。
//!
//! 数据流：命令带 team_id 路由到对应 persona（去主智能体后必填）；
//! Core 以 `WorkspaceSessions` / `WorkspaceGitStatus` 事件回推。
//! 弹层几何由 ChatView 的 `PanelPopover` 提供。
//!
//! 对话 CRUD：新建/改名仍经 `SaveWorkspaceSession` 全量 upsert 会话
//!（conversations 整体替换，面板侧镜像 Core `upsert_conversation` 的
//! 物化 / slug / legacy 语义）。**删除对话走模块私有写方法**
//! `workspace.deleteConversation`（通用调用通道 `InvokeModuleOp`）：只删入口、
//! 聊天历史保留、幂等、拒绝删最后一条；不先发 `ClearHistory`，失败也不退回
//! 全量 upsert（配对与反馈见 `../workspace-conversation-delete.ts`）。

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
} from '../../workspace';
import DirectoryPicker from './DirectoryPicker.vue';
import { confirmDialog } from '@echo-agent/panel';
import { ensureWorkspaceSessions, WORKSPACE_SESSIONS_KEY } from '../../workspace-prefetch';
import { workspace, workspaceRevision } from '../../workspace-store';
import {
  conversationDeleteResult,
  conversationDeleteRevision,
  requestConversationDelete,
  retiredConversationIds,
} from '../../workspace-conversation-delete';
import { useSessionJsonForm } from './use-session-json-form';

const props = defineProps<{ teamId: string | null }>();

/** 当前列表归属 (team, core) 与请求目标一致才渲染（避免跨 team/core 串显）。 */
const fresh = computed(() => {
  // 依赖结构版本号：`workspace` 是普通对象（不是响应式），不读它就永远不重算。
  void workspaceRevision.value;
  return (
    workspace.teamId === props.teamId &&
    (workspace.core ?? null) === (state.activeRegion ?? null)
  );
});
// 每个读投影的 computed 都**自己**读一次版本号：只让 `fresh` 读会踩 Vue 的
// 短路——`fresh` 的布尔值没变时下游 computed 不会重算，数据换了也白换。
const sessions = computed(() => {
  void workspaceRevision.value;
  return fresh.value ? workspace.sessions : [];
});
const activeId = computed(() => {
  void workspaceRevision.value;
  return fresh.value ? workspace.active : null;
});
/** 当前激活对话 id（2026-10 多对话；旧 Core 恒 null）。 */
const activeConversationId = computed(() => {
  void workspaceRevision.value;
  return fresh.value ? workspace.activeConversation : null;
});

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
/** 中性提示（导入成功 / JSON 已应用）；与 `actionError` 分开是因为后者是红的。 */
const actionNotice = ref<string | null>(null);
let actionTimer: number | undefined;
function beginAction(key: string): boolean {
  if (actionPending.value) return false;
  actionPending.value = key; actionError.value = null; actionNotice.value = null;
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

// ── JSON 导入 / 编辑（2026-11）──
// 状态与规则在 `use-session-json-form.ts`：粘贴 → 解析（`workspace-json.ts`）
// → 回填下面三个表单字段，或批量提交。本组件只负责调用与派发命令。
// **保存前会自动应用未应用的改动**（见 `save`）——否则「贴了 JSON 直接点保存」
// 会静默丢掉 JSON 里的内容，这是这条路径最容易踩的坑。
const jsonForm = useSessionJsonForm({
  editingId: () => editing.value?.id ?? '',
  formName,
  formDescription,
  formDirs,
  findSession: (id) => sessions.value.find((s) => s.id === id),
  toInput: directoryToInput,
});
/** 解构出的别名与模板/后续逻辑共用（名字沿用改造前的局部变量）。 */
const {
  text: formJson,
  error: jsonError,
  notice: jsonNotice,
  dirty: jsonDirty,
  conversations: formConversations,
  lastConversation: formLastConversation,
  resetFeedback: resetJsonFeedback,
  clear: clearJson,
  seed: seedJson,
} = jsonForm;

function startCreate() {
  editing.value = { id: '' };
  formName.value = '';
  formDescription.value = '';
  formDirs.value = '';
  clearJson();
  actionNotice.value = null;
}

function startEdit(session: WorkspaceSessionInfo) {
  editing.value = { id: session.id };
  formName.value = session.name;
  formDescription.value = session.description ?? '';
  // 规范化：跨机目录 {path,node} → `node://<node>/<path>` 编辑串
  // （此前直接 join 会把对象变成 "[object Object]"）。
  formDirs.value = (session.directories ?? []).map(directoryToInput).join('\n');
  // 对话不进表单（表单只有三个字段），但 JSON 段以它为初始内容。
  seedJson(session);
  actionNotice.value = null;
}

function cancelEdit() {
  editing.value = null;
  resetJsonFeedback();
}

/** 把编辑中的会话重新生成为 JSON（丢弃文本改动）；规则在 composable 内。 */
const resetJson = jsonForm.reset;

/** 解析当前文本并回填表单；规则与校验在 composable 内（含编辑态 id 不可改）。 */
const applyJson = jsonForm.apply;

function applyJsonFromButton(): void {
  applyJson();
}

function save() {
  if (!props.teamId || !editing.value) return;
  const id = editing.value.id;
  // JSON 有未应用的改动 → 先应用；失败即中止，绝不「用旧表单值静默保存」。
  const applied = jsonDirty.value ? applyJson() : null;
  if (jsonDirty.value && !applied) return;
  if (!formName.value.trim() && !applied?.length) return;
  if (!beginAction(id ? `save:${id}` : 'save:new')) return;
  // 批量（仅新建）：JSON 里有多份 → 逐条提交。全部命令在同一 tick 发出，
  // 无需逐条等待；Core 对每条都会广播一次 `WorkspaceSessions`。
  if (!id && applied && applied.length > 1) {
    for (const session of applied) {
      sendCommand({ SaveWorkspaceSession: { team_id: props.teamId, session } });
    }
    finishAction();
    editing.value = null;
    actionNotice.value = `已提交 ${applied.length} 个工作区（逐条落盘；个别失败会单独提示）`;
    return;
  }
  const existing = id ? sessions.value.find((s) => s.id === id) : undefined;
  const session: WorkspaceSessionInfo = {
    ...(existing ?? {}),
    id,
    name: (applied?.[0]?.name ?? formName.value).trim(),
    description: (applied?.[0]?.description ?? formDescription.value).trim(),
    directories: applied?.[0]?.directories
      ?? formDirs.value.split('\n').map((line) => line.trim()).filter(Boolean),
    // SaveWorkspaceSession 是**全量替换**：元数据编辑不能擦掉对话；只有 JSON
    // 明确给了 conversations 才替换（空数组在 Core 侧同样解释为「未提供」）。
    conversations: formConversations.value ?? existing?.conversations ?? [],
    last_conversation: formLastConversation.value ?? existing?.last_conversation ?? null,
  };
  sendCommand({ SaveWorkspaceSession: { team_id: props.teamId, session } });
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
// 新建 / 改名：经 SaveWorkspaceSession 全量 upsert 会话（conversations 整体
// 替换，镜像 Core upsert_conversation 的物化 / slug / legacy 语义）。
// 删除：模块私有写方法 `workspace.deleteConversation`（只删入口、历史保留，
// 见 `../workspace-conversation-delete.ts`）。

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
) {
  if (!props.teamId) return;
  if (actionPending.value || !beginAction(`conversation:${session.id}`)) return;
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
    // 新 id 要避开本窗口删过的 slug：被删对话的通道已退役（历史保留），
    // 后端拒绝复用，撞上只会得到一条「请刷新后重试」的失败。
    const retiredIds = retiredConversationIds(
      props.teamId,
      state.activeRegion ?? null,
      session.id,
    );
    const id = conversationIdForName(name, [...convs.map((c) => c.id), ...retiredIds]);
    // 新对话一律显式 `<ws>/<conv>` 通道：裸通道只属于存量 legacy 对话，
    // 它一旦被删除就退役——不能再分配给新对话（否则新消息落进旧历史）。
    convs.push({ id, name, legacy: false });
  } else {
    const target = convs.find((c) => c.id === convForm.value!.convId);
    if (!target) return;
    target.name = name;
  }
  saveConversations(session, convs);
  convForm.value = null;
}

/** 正在等待回包的删除（同一时刻至多一条：`actionPending` 已单飞）。 */
const pendingConversationDelete = ref<null | {
  requestId: string;
  core: string | null;
  workspaceId: string;
  conversationId: string;
}>(null);

async function removeConversation(session: WorkspaceSessionInfo, conv: WorkspaceConversationInfo) {
  if (!props.teamId || actionPending.value) return;
  const ok = await confirmDialog(
    `删除对话「${conv.name}」的入口？只移除列表条目，聊天历史会保留。`,
    { title: '删除对话', danger: true, confirmText: '删除' },
  );
  if (!ok) return;
  if (!beginAction(`conversation:${session.id}`)) return;
  // 默认删除 = 模块私有写方法（`InvokeModuleOp` → `workspace.deleteConversation`）：
  // 只删入口、保留历史、幂等、拒绝最后一条。**绝不**先发 `ClearHistory`，
  // 失败也不退回 `SaveWorkspaceSession` 全量 upsert（那会整表替换对话列表）。
  const core = state.activeRegion ?? null;
  const requestId = requestConversationDelete(props.teamId, core, session.id, conv.id);
  if (!requestId) {
    finishAction();
    actionError.value =
      conversationDeleteResult(props.teamId, core, session.id, conv.id)?.message
      ?? '无法发送删除请求（未连接，或无法确定该人格所属运行区域）';
    return;
  }
  pendingConversationDelete.value = {
    requestId,
    core,
    workspaceId: session.id,
    conversationId: conv.id,
  };
}

/**
 * 删除回包 → 组件反馈（配对在扩展入口的 `acceptEvent` 里完成，这里只消费终态）。
 *
 * - 成功：行随宿主广播消失；`already_absent` 说明本地快照陈旧 → 主动补拉一次；
 * - 拒绝 / 超时：把模块给的原因显示在面板错误条上并结束动作。
 * - 失败回执 `data:null` 没有 `request_id`，无法与请求配对（Core 广播给所有
 *   窗口）：不认领、不误报，等本请求自己的超时提示「未收到可匹配回执」。
 */
watch(conversationDeleteRevision, () => {
  const waiting = pendingConversationDelete.value;
  if (!waiting) return;
  const result = conversationDeleteResult(
    props.teamId,
    waiting.core,
    waiting.workspaceId,
    waiting.conversationId,
  );
  if (!result || result.requestId !== waiting.requestId || result.status === 'pending') return;
  pendingConversationDelete.value = null;
  finishAction();
  if (result.status === 'ok') {
    if (result.outcome === 'already_absent') requestSessions();
    return;
  }
  actionError.value = result.message ?? '删除对话失败';
});

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
    <p v-if="actionNotice" class="ws-notice">{{ actionNotice }}</p>
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
      <!-- JSON 导入 / 编辑（2026-11）：表单填不了 conversations / api_profile /
           last_conversation；迁移或复制既有工作区时用户手上正好是一段落盘
           JSON，这里直接接收（三种形态见 `workspace-json.ts`）。
           默认折叠：日常建一个工作区只用上面三个字段，不该被 20 行 JSON 干扰。 -->
      <details class="ws-json">
        <summary class="ws-json__summary">
          JSON（导入 / 编辑）
          <span v-if="jsonDirty" class="ws-json__dirty">· 有未应用的修改</span>
        </summary>
        <p class="ws-json__hint">
          可粘贴单份工作区、会话数组，或整份文档 <code>{ "sessions": [ … ] }</code>；
          <code>directories</code> 里的 <code>{ "path": …, "node": … }</code> 是跨机目录。
          改完点「应用 JSON」，或直接保存（保存前会自动应用）。
        </p>
        <textarea
          v-model="formJson"
          class="ws-textarea ws-json__input"
          rows="10"
          spellcheck="false"
          placeholder='{&#10;  "name": "示例工作区",&#10;  "directories": ["/srv/repo"],&#10;  "conversations": [{ "id": "main", "name": "主对话", "legacy": true }]&#10;}'
        />
        <div class="ws-json__actions">
          <NeumorphismButton size="small" variant="glass" :disabled="!formJson.trim()" @click="applyJsonFromButton">
            应用 JSON
          </NeumorphismButton>
          <NeumorphismButton v-if="editing.id" size="small" variant="glass" @click="resetJson">
            重置
          </NeumorphismButton>
        </div>
        <p v-if="jsonError" class="ws-error ws-json__msg">{{ jsonError }}</p>
        <p v-else-if="jsonNotice" class="ws-notice ws-json__msg">{{ jsonNotice }}</p>
      </details>
      <div class="ws-form__actions">
        <!-- 贴了 JSON 但没点「应用」时表单名称可能还是空的：脏 JSON 也算可保存，
             否则按钮禁用会让人以为「贴进去没生效」。 -->
        <NeumorphismButton
          size="small"
          variant="glass"
          :disabled="(!formName.trim() && !jsonDirty) || !!actionPending"
          @click="save"
        >
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
        <!-- 对话管理（2026-10 多对话）：点选 = 切换激活对话；删除只删入口（聊天历史保留，C3b） -->
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
.ws-notice { margin: 4px 0; color: var(--nm-text-secondary); font-size: 12px; }
.ws-notice::before { content: '· '; }

/* JSON 导入 / 编辑段：折叠态只占一行，展开后自己滚（不把面板整体撑高）。 */
.ws-json {
  padding-top: 6px;
  border-top: 1px dashed var(--nm-border-color);
}
.ws-json__summary {
  cursor: pointer;
  font-size: 11px;
  color: var(--nm-text-secondary);
  user-select: none;
}
.ws-json__dirty { color: var(--panel-warn, #b8860b); }
.ws-json__hint {
  margin: 4px 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--nm-text-placeholder);
}
.ws-json__input {
  width: 100%;
  min-height: 160px;
  max-height: 45vh;
  font-size: 11px;
  line-height: 1.45;
  tab-size: 2;
}
.ws-json__actions { display: flex; gap: 6px; justify-content: flex-end; margin-top: 4px; }
.ws-json__msg { white-space: pre-wrap; }
</style>
