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

function available(teamId: string | null): boolean {
  const team = teamId === null ? currentTeam(state) : state.teams.find((item) => item.id === teamId) ?? null;
  return !!team && teamModuleEnabled(team, 'echo-agent.workspace') && teamToolAvailable(team, 'workspace');
}

function workspaceCard(teamId: string | null): WorkspaceSessionInfo | null {
  const scope = teamId ?? state.teams[0]?.id ?? null;
  if (!available(scope) || state.workspaceTeamId !== scope) return null;
  const own = parseWorkspaceChannelId(state.windowSessionId ?? '')?.workspaceId ?? null;
  const target = own ?? state.workspaceActive;
  if (!target) return null;
  return state.workspaceSessions.find((session) => session.id === target) ?? null;
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
  watch(
    [() => state.workspaceTeamId, () => state.workspaceActive, () => state.workspaceActiveConversation],
    () => {
      if (state.workspaceTeamId !== context.teamId.value) return;
      const mine = takeLocalActivateIntent(state.workspaceActive, state.workspaceActiveConversation);
      const decision = decideOnWorkspaceBroadcast({
        currentSessionId: context.sessionId.value,
        active: state.workspaceActive,
        activeConversation: state.workspaceActiveConversation,
        sessions: state.workspaceSessions,
        hasLocalIntent: mine,
      });
      recordWorkspaceDecision({
        active: state.workspaceActive,
        activeConversation: state.workspaceActiveConversation,
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
        return;
      }
      if (!wasConnected) {
        connectionEpoch += 1;
        wasConnected = true;
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
      if (state.workspaceTeamId !== teamId) return LOCAL_DEFAULT_SESSION;
      return localSessionProjection(state.workspaceActive, state.workspaceActiveConversation, state.workspaceSessions);
    },
    acceptEvent(event) {
      const error = (event as { Error?: { session_id?: string | null; message?: string } }).Error;
      if (!error || error.session_id || typeof error.message !== 'string') return true;
      const activationNotice = /^(已激活工作区会话|已取消工作区会话激活)/.test(error.message);
      return !activationNotice || hasRecentLocalActivateIntent();
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
        state.workspaceActive,
        state.workspaceActiveConversation,
        state.workspaceTeamId === context.teamId.value,
        state.workspaceSessions,
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
  overlays: [{ id: 'sessions', label: '工作区会话', component: WorkspacePanel }],
  railCards(teamId) {
    const session = workspaceCard(teamId);
    if (!session) return [];
    const scoped = sessionKey(state.activeRegion, session.id);
    const dirs = state.workspaceGitBySession[scoped] ?? [];
    const changed = dirs.reduce((sum, dir) => sum + (dir.staged ?? 0) + (dir.modified ?? 0) + (dir.untracked ?? 0), 0);
    return [
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
