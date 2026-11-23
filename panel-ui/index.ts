//! Workspace 模块的 Panel UI 扩展入口。
//! 只有显式加入 PANEL_UI_EXTENSIONS 的构建才会加载本模块。

import { watch } from 'vue';
import {
  currentTeam,
  definePanelExtension,
  registerPanelExtension,
  sendCommand,
  sessionKey,
  state,
  teamModuleEnabled,
  teamToolAvailable,
  type PanelAppContext,
  type WorkspaceSessionInfo,
} from '@echo-agent/panel';
import WorkspacePanel from './components/WorkspacePanel.vue';
import WorkspaceFilesRail from './components/WorkspaceFilesRail.vue';
import WorkspaceGitCard from './components/WorkspaceGitCard.vue';
import WorkspaceOverviewCard from './components/WorkspaceOverviewCard.vue';
import { ensureWorkspaceSessions } from './workspace-prefetch';
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
import { consumeEvent, resetCaches, workspace, workspaceRevision } from './workspace-store';
import { consumeOverviewResult, requestOverview, resetOverview } from './workspace-overview';
import {
  consumeConversationDeleteResult,
  resetConversationDeletes,
} from './workspace-conversation-delete';

function available(teamId: string | null): boolean {
  const team = teamId === null ? currentTeam(state) : state.teams.find((item) => item.id === teamId) ?? null;
  return !!team && teamModuleEnabled(team, 'echo-agent.workspace') && teamToolAvailable(team, 'workspace');
}

/**
 * 某人格所属 Core：优先取 `(id, activeRegion)` 命中的那一条（多上游同名
 * 人格是常态），再退回同 id 首条 / activeRegion。
 *
 * 概览请求与卡片展示**必须用同一个 core 键**，否则 `(core, team)` 投影查
 * 不到自己刚发的请求（表现为卡片一直「暂无概览」）。
 */
function teamCore(teamId: string | null): string | null {
  const region = state.activeRegion ?? null;
  const team = teamId === null
    ? currentTeam(state)
    : state.teams.find((item) => item.id === teamId && (item.core ?? null) === region)
      ?? state.teams.find((item) => item.id === teamId)
      ?? null;
  return team?.core ?? region;
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
        // 断连 = 新基线：未完成的概览 / 删除请求全部作废，避免旧计时器改新状态。
        resetOverview();
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
      // 概览走**模块私有方法**（通用调用通道 `InvokeModuleOp`），不经宿主
      // `BackendCommand`。与列表同批触发；回包丢失由 overview store 的 8s
      // 计时器收敛，不阻塞列表与面板。
      requestOverview(team.id, teamCore(team.id) ?? context.core.value ?? null);
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
      // 删除（C3b）与概览（C4）是两条独立方法，各自配对。
      if (consumeConversationDeleteResult(event)) return false;
      if (consumeOverviewResult(event)) return false;
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
  railCardSlots: ['files', 'git', 'overview'],
  entries: [{
    id: 'sessions',
    label: '工作区',
    title: '工作区会话',
    icon: 'folder',
    when: ({ teamId }) => available(teamId),
    prefetch: ({ teamId, core }) => { ensureWorkspaceSessions(teamId, core); },
  }],
  overlays: [{ id: 'sessions', label: '工作区会话', component: WorkspacePanel }],
  railCards(teamId) {
    const scope = teamId ?? state.teams[0]?.id ?? null;
    // 概览不依赖「当前有激活工作区」：没有人格级激活时也能看数量。
    const overviewCards = available(scope)
      ? [{
          id: 'overview',
          title: '工作区概览',
          component: WorkspaceOverviewCard,
          componentProps: { teamId: scope, core: teamCore(scope) },
        }]
      : [];
    const session = workspaceCard(teamId);
    if (!session) return overviewCards;
    const scoped = sessionKey(state.activeRegion, session.id);
    const dirs = workspace.gitBySession[scoped] ?? [];
    const changed = dirs.reduce((sum, dir) => sum + (dir.staged ?? 0) + (dir.modified ?? 0) + (dir.untracked ?? 0), 0);
    return [
      ...overviewCards,
      {
        id: 'files',
        title: `文件浏览器 · ${session.name}`,
        component: WorkspaceFilesRail,
        componentProps: { session, teamId: teamId ?? state.teams[0]?.id ?? null },
      },
      {
        id: 'git',
        title: 'Git 状态',
        count: changed,
        countTitle: changed ? `${changed} 项变更` : undefined,
        component: WorkspaceGitCard,
        componentProps: { session, teamId: teamId ?? state.teams[0]?.id ?? null },
      },
    ];
  },
}));
