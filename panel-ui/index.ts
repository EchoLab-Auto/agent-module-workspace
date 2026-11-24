//! Workspace 模块的 Panel UI 扩展入口。
//! 只有显式加入 PANEL_UI_EXTENSIONS 的构建才会加载本模块。

import { watch } from 'vue';
import {
  currentTeam,
  definePanelExtension,
  registerPanelExtension,
  sendCommand,
  state,
  teamModuleEnabled,
  teamToolAvailable,
  type PanelAppContext,
  type WorkspaceSessionInfo,
} from '@echo-agent/panel';
import WorkspacePanel from './components/WorkspacePanel.vue';
import WorkspaceFilesRail from './components/WorkspaceFilesRail.vue';
import WorkspaceGitCard from './components/WorkspaceGitCard.vue';
import { ensureWorkspaceSessions } from './workspace-prefetch';
import { changedCount, conflictCount } from './git-changes';
import {
  LOCAL_DEFAULT_SESSION,
  decideOnWorkspaceBroadcast,
  localSessionProjection,
  noteLocalActivateIntent,
  parseWorkspaceChannelId,
  hasRecentLocalActivateIntent,
  takeLocalActivateIntent,
  workspacePickIntent,
} from './workspace';
import { consumeEvent, gitSessionKey, resetCaches, workspace, workspaceRevision } from './workspace-store';
import {
  consumeConversationDeleteResult,
  resetConversationDeletes,
} from './workspace-conversation-delete';

function available(teamId: string | null): boolean {
  const team = teamId === null ? currentTeam(state) : state.teams.find((item) => item.id === teamId) ?? null;
  return !!team && teamModuleEnabled(team, 'echo-agent.workspace') && teamToolAvailable(team, 'workspace');
}

function workspaceCard(teamId: string | null): WorkspaceSessionInfo | null {
  const scope = teamId ?? state.teams[0]?.id ?? null;
  if (!available(scope) || workspace.teamId !== scope) return null;
  const own = parseWorkspaceChannelId(state.windowSessionId ?? '')?.workspaceId ?? null;
  const target = own ?? workspace.active;
  if (!target) return null;
  return workspace.sessions.find((session) => session.id === target) ?? null;
}

function sendWorkspaceActivate(context: PanelAppContext, id: string | null, conversation: string | null = null): void {
  noteLocalActivateIntent(id, conversation);
  sendCommand({
    ActivateWorkspaceSession: {
      team_id: context.teamId.value ?? undefined,
      id,
      conversation: id ? conversation : undefined,
    },
  });
}

function recordWorkspaceDecision(entry: {
  active: string | null;
  activeConversation: string | null;
  current: string;
  mine: boolean;
  decision: { kind: string; next?: string };
}): void {
  const w = window as unknown as { __echoPanelWorkspaceLog?: unknown[] };
  const log = (w.__echoPanelWorkspaceLog ??= []);
  log.push({ t: new Date().toISOString(), ...entry, decision: entry.decision.kind, next: entry.decision.next ?? null });
  if (log.length > 20) log.shift();
}

function setup(context: PanelAppContext): void {
  // 依赖**结构版本号**：`workspace` 是普通对象，直接 watch 它的属性不会触发
  //（这些字段是模块自己的，不是壳的 reactive state）。
  watch(
    () => workspaceRevision.value,
    () => {
      if (workspace.teamId !== context.teamId.value) return;
      const mine = takeLocalActivateIntent(workspace.active, workspace.activeConversation);
      const decision = decideOnWorkspaceBroadcast({
        currentSessionId: context.sessionId.value,
        active: workspace.active,
        activeConversation: workspace.activeConversation,
        sessions: workspace.sessions,
        hasLocalIntent: mine,
      });
      recordWorkspaceDecision({
        active: workspace.active,
        activeConversation: workspace.activeConversation,
        current: context.sessionId.value,
        mine,
        decision,
      });
      if (decision.kind !== 'keep' && context.sessionId.value !== decision.next) {
        context.setSession(decision.next, `workspace-${decision.kind}`);
      }
    },
  );

  let fetchKey = '';
  let connectionEpoch = 0;
  let wasConnected = false;
  watch(
    [() => state.connected, () => state.teams, () => context.teamId.value],
    () => {
      if (!state.connected) {
        fetchKey = '';
        wasConnected = false;
        // 断连 = 新基线：未完成的删除请求全部作废，避免旧计时器改新状态。
        resetConversationDeletes();
        return;
      }
      if (!wasConnected) {
        connectionEpoch += 1;
        wasConnected = true;
        // 重连 = 新基线：按路径 / 按会话的缓存全部作废（列表由下面的请求重建）。
        resetCaches();
      }
      const team = currentTeam(state);
      if (!team || !teamModuleEnabled(team, 'echo-agent.workspace')) return;
      const key = `${team.core ?? ''}:${team.id}`;
      if (fetchKey === `${connectionEpoch}:${key}`) return;
      fetchKey = `${connectionEpoch}:${key}`;
      sendCommand({ RequestWorkspaceSessions: { team_id: team.id } });
    },
    { immediate: true },
  );
}

registerPanelExtension(definePanelExtension({
  id: 'echo-agent.workspace',
  hooks: {
    setup,
    teamLanding(teamId) {
      if (workspace.teamId !== teamId) return LOCAL_DEFAULT_SESSION;
      return localSessionProjection(workspace.active, workspace.activeConversation, workspace.sessions);
    },
    acceptEvent(event) {
      // 模块私有方法的回执（`ModuleInvokeResult`）按 request_id 配对；
      // 命中、迟到、别的窗口的回包都由本扩展消化，不进入壳的通用 reducer。
      if (consumeConversationDeleteResult(event)) return false;
      // 工作区自己的三帧（会话列表 / git 状态 / 目录浏览）由本扩展归约，
      // 不进壳的通用 reducer——壳里没有工作区的字段。
      if (consumeEvent(event)) return false;
      const error = (event as { Error?: { session_id?: string | null; message?: string } }).Error;
      if (!error || error.session_id || typeof error.message !== 'string') return true;
      const activationNotice = /^(已激活工作区会话|已取消工作区会话激活)/.test(error.message);
      return !activationNotice || hasRecentLocalActivateIntent();
    },
    toolPresentation(tool) {
      // 工作区工具（`workspace`）的图标归本模块；壳不认识这个名字。
      return tool.name === 'workspace' ? { icon: 'workspace' } : null;
    },
    sessionPresentation(session) {
      return parseWorkspaceChannelId(session.id) ? { tag: '工作区', tagTone: 'accent' } : null;
    },
    canConfigureSessionApi(session) {
      return parseWorkspaceChannelId(session.id) !== null;
    },
    beforeSessionPick(id, context) {
      const intent = workspacePickIntent(
        id,
        workspace.active,
        workspace.activeConversation,
        workspace.teamId === context.teamId.value,
        workspace.sessions,
      );
      if (intent.kind === 'activate') sendWorkspaceActivate(context, intent.workspaceId, intent.conversation);
      else if (intent.kind === 'deactivate') sendWorkspaceActivate(context, null);
    },
  },
  railCardSlots: ['files', 'git'],
  entries: [{
    id: 'sessions',
    label: '工作区',
    title: '工作区会话',
    icon: 'folder',
    when: ({ teamId }) => available(teamId),
    prefetch: ({ teamId, core }) => { ensureWorkspaceSessions(teamId, core); },
  }],
  // 入口按钮（entries）与弹层（overlays）是**两个独立注册面**：只登记 entries
  // 会有按钮但点开无内容（2026-11 事故：编辑时误删这一行）。两处 `id` 必须
  // 都是 `sessions`——点击时 Panel 用 `extension:<id>:sessions` 去 overlays 里
  // 找同 id 的组件。
  overlays: [{ id: 'sessions', label: '工作区会话', component: WorkspacePanel }],
  railCards(teamId) {
    // 读一次结构版本号：`workspace` 是**普通对象**（见 workspace-store.ts），
    // 不读它就等于卡片列表不依赖它——回包晚到时会一直沿用首帧算出的空列表，
    // 直到某个无关的 `state.*` 变化碰巧把 computed 顶翻（2026-11 用户看到的
    // 「文件浏览器时有时无、过一会儿又自己出现」就是这个）。
    void workspaceRevision.value;
    const session = workspaceCard(teamId);
    if (!session) return [];
    const scope = teamId ?? state.teams[0]?.id ?? null;
    // 键与卡片同源（`gitSessionKey` 含人格 + core）：写在这里的第二套拼法迟早
    // 与卡片不一致，表现为徽标有数字、点开却是一张空卡。
    const dirs =
      workspace.gitBySession[gitSessionKey(state.activeRegion, scope, session.id)] ??
      workspace.gitBySession[gitSessionKey(state.activeRegion, null, session.id)] ??
      [];
    // 徽标口径与卡内一致（`git-changes.ts::changedCount`：按文件去重，冲突只算
    // 一次）；冲突另算一句提示——它是要最早看到的那条信息，但不该把徽标数字再
    // 放大一份。
    const changed = dirs.reduce((sum, dir) => sum + changedCount(dir), 0);
    const conflicts = dirs.reduce((sum, dir) => sum + conflictCount(dir), 0);
    const countTitle = conflicts
      ? `${changed} 项变更，其中 ${conflicts} 个冲突未解决`
      : changed
        ? `${changed} 项变更`
        : undefined;
    return [
      {
        id: 'files',
        title: `文件浏览器 · ${session.name}`,
        component: WorkspaceFilesRail,
        componentProps: { session, teamId: scope },
      },
      {
        id: 'git',
        title: 'Git 状态',
        count: changed,
        countTitle,
        component: WorkspaceGitCard,
        componentProps: { session, teamId: scope },
      },
    ];
  },
}));
