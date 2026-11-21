//! 工作区在**面板扩展**里的投影。
//!
//! 这份状态原先住在 Panel 壳的 `AppState` 里（8 个字段 + 3 个 reducer 臂），
//! 因为壳"顺手"替工作区存了它的领域数据。按外壳边界（见 Panel 仓
//! `docs/ui-extensions.md`），模块的投影归模块：壳只给 `acceptEvent` 钩子与
//! 通用身份（`activeRegion` / `activeTeamId`），剩下的在这里。
//!
//! ## 三条事件
//!
//! | 事件 | 语义 | 归约要点 |
//! |---|---|---|
//! | `WorkspaceSessions` | 某人格的全部工作区会话 + 当前激活 | 过滤别的 core / 别的 persona；整体替换并推进 generation |
//! | `WorkspaceGitStatus` | 某会话目录的 git 状态 | 按 `(core, session)` 键缓存 |
//! | `WorkspaceFiles` | 某目录的浏览结果 | 按 `(core, path)` 键缓存 |
//!
//! ## 为什么必须过滤（2026-10 多窗口审计的结论，照抄不丢）
//!
//! workspace store 是 **per-persona** 的，而 `WorkspaceSessions` 经进程级
//! EventSink 广播给**所有** Panel 连接。不过滤时：另一个窗口（或模型用 `use`
//! 工具）在别的 agent 上激活工作区 → 通播覆盖本窗口的单槽 → 文件浏览器门控
//! 失败、落点错、点一下就把全局 active 抢走。
//!
//! 放行条件：`team_id` 缺省（旧 Core 帧）或本端尚未确定 agent（等 TeamsList
//! 校正后 App 会按新 agent 重拉）。

import { ref } from 'vue';
import { scopedKey, sessionKey, state, type WorkspaceFileEntry, type WorkspaceGitInfo, type WorkspaceSessionInfo } from '@echo-agent/panel';

/** 工作区模块 id（人格门控 / 挂载判据都用它）。 */
export const MODULE_ID = 'echo-agent.workspace';

/** 一次 `WorkspaceSessions` 的载荷（模块与宿主约定的线形状）。 */
interface WorkspaceSessionsPayload {
  team_id?: string | null;
  sessions: WorkspaceSessionInfo[];
  active?: string | null;
  active_conversation?: string | null;
  core?: string | null;
}

/**
 * 工作区投影（模块私有）。
 *
 * 字段名保持与旧壳内字段一一对应（`sessions` ← `workspaceSessions` 等），
 * 迁移只改**归属**不改语义——这样行为等价可以逐条核对，而不是"重写一遍
 * 看起来一样"。
 */
export const workspace = {
  /** 当前加载归属的人格（null = 未知）。 */
  teamId: null as string | null,
  /** 上述列表归属的 core（多上游；与 `teamId` 一起判定新鲜度）。 */
  core: null as string | null,
  /** 该人格的全部工作区会话。 */
  sessions: [] as WorkspaceSessionInfo[],
  /** 激活的工作区会话 id（null = 未激活）。 */
  active: null as string | null,
  /** 激活的工作区对话 id（2026-10 多对话；旧 Core 恒 null）。 */
  activeConversation: null as string | null,
  /** 列表请求代数：拒绝切换 team/core 后到达的旧快照。 */
  generation: 0,
  /** 各会话目录 git 状态的缓存（`(core, session)` → 目录结果）。 */
  gitBySession: {} as Record<string, WorkspaceGitInfo[]>,
  /** 文件浏览器缓存（`(core, path)` → 条目 / 错误）。 */
  files: {} as Record<string, { entries: WorkspaceFileEntry[]; error: string | null }>,
};

/** 结构版本号：组件对它的依赖驱动重算（`workspace` 是普通对象，不是响应式）。 */
export const workspaceRevision = ref(0);

function bump(): void {
  workspaceRevision.value += 1;
}

/** `WorkspaceSessions` 归约；返回 true = 本帧属于当前作用域并被接受。 */
export function applySessions(payload: WorkspaceSessionsPayload, core: string | null): boolean {
  // 响应必须属于当前运行区域；重连/切换 core 后到达的旧响应不能覆盖新鲜列表
  //（单上游 / 旧 Core 的 core=null 仍兼容放行）。
  if (core != null && state.activeRegion != null && core !== state.activeRegion) return false;
  // 响应必须属于当前 agent（多 persona 广播过滤，见文件头）。
  if (
    payload.team_id != null &&
    state.activeTeamId != null &&
    payload.team_id !== state.activeTeamId
  ) {
    return false;
  }
  workspace.sessions = payload.sessions ?? [];
  workspace.active = payload.active ?? null;
  workspace.activeConversation = payload.active_conversation ?? null;
  workspace.teamId = payload.team_id ?? null;
  workspace.core = core ?? null;
  workspace.generation += 1;
  bump();
  return true;
}

/** `WorkspaceGitStatus` 归约。 */
export function applyGit(payload: {
  session_id: string;
  directories: WorkspaceGitInfo[];
}, core: string | null): void {
  workspace.gitBySession[sessionKey(core, payload.session_id)] = payload.directories ?? [];
  bump();
}

/** `WorkspaceFiles` 归约。 */
export function applyFiles(payload: {
  path: string;
  entries: WorkspaceFileEntry[];
  error?: string | null;
}, core: string | null): void {
  workspace.files[scopedKey(core, payload.path)] = {
    entries: payload.entries ?? [],
    error: payload.error ?? null,
  };
  bump();
}

/**
 * 手动通知一次结构变更。
 *
 * 只给"直接写 `workspace.*` 的调用方"用（单测与集成测试的种子数据）：
 * 生产路径一律走 `applySessions` / `applyGit` / `applyFiles`，它们自己 bump。
 * 没有这个口子，测试写种子后组件不会重算（`workspace` 不是响应式对象）。
 */
export function notifyChanged(): void {
  bump();
}

/** 重连 / 切区域后清掉按路径与按会话的缓存（列表由下一次请求重建）。 */
export function resetCaches(): void {
  workspace.gitBySession = {};
  workspace.files = {};
  bump();
}

/**
 * 从 `AppState` 之外的帧里消费工作区事件（`acceptEvent` 钩子的实现体）。
 *
 * 返回 true = 已消费，壳的通用 reducer 不必再看。
 */
export function consumeEvent(event: unknown): boolean {
  const frame = event as Record<string, unknown>;
  // core 由 `dispatch` 注入到**载荷体内**（`{WorkspaceSessions: {...core}}`），
  // 不是外层帧——与壳的 `evtCore` 同一口径。
  const coreOf = (payload: unknown): string | null =>
    (payload as { core?: string | null } | null | undefined)?.core ?? null;
  const sessions = frame.WorkspaceSessions as WorkspaceSessionsPayload | undefined;
  if (sessions) {
    applySessions(sessions, coreOf(sessions));
    return true;
  }
  const git = frame.WorkspaceGitStatus as
    | { session_id: string; directories: WorkspaceGitInfo[] }
    | undefined;
  if (git) {
    applyGit(git, coreOf(git));
    return true;
  }
  const files = frame.WorkspaceFiles as
    | { path: string; entries: WorkspaceFileEntry[]; error?: string | null }
    | undefined;
  if (files) {
    applyFiles(files, coreOf(files));
    return true;
  }
  return false;
}
