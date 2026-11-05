//! 工作区会话数据的**按需预取**（2026-10）。
//!
//! ## 为什么需要
//!
//! 工作区面板的打开过程原本是**两段串行等待**：
//!
//! ```text
//! 点击 → 下载 WorkspacePanel chunk → 组件挂载 → onMounted
//!      → 发 RequestWorkspaceSessions → WS 往返 → 卡片出现
//! ```
//!
//! 两个网络往返（chunk + 数据）互不依赖，却被串在一起。实测弱网（800ms RTT
//! / 200kbps）点开工作区：1102ms 面板才出现，5552ms 才看到卡片里的按钮。
//!
//! 现在把数据请求提到**用户意图**那一刻（hover / focus / touch / 点开），
//! 与 chunk 下载并行；面板挂载时若数据或请求已在路上就**不再重发**。
//!
//! ## 三条判据（顺序即优先级）
//!
//! 1. **没有 team**：不发（Core 会拒绝无 `team_id` 的会话类命令）；
//! 2. **本地已新鲜**：`(team, core)` 都对得上且有数据 → 不发。跨 agent /
//!    跨 core 的旧数据**不算新鲜**（`WorkspaceSessions` 带 `team_id`/`core`，
//!    迟到或错位的响应会被 reducer 过滤，不能用它冒充本 agent 的数据）；
//! 3. **已有请求在飞**：不发（见 `pending.ts::isPending`）——预取与挂载补拉
//!    可能落在同一 tick，各发一次就成了两个请求。
//!
//! 显式「刷新」不走这里：用户明确要求重新拉，`requestSessions()` 无条件发。

import { sendPending } from '@echo-agent/panel';
import { isPending } from '@echo-agent/panel';
import { state } from '@echo-agent/panel';

/** 等待键（与 `pending.ts::REQUEST_RESPONSES` 的登记键一致）。 */
export const WORKSPACE_SESSIONS_KEY = 'workspace:sessions';

/** 本地是否已有**本 agent** 的新鲜会话列表。 */
export function workspaceSessionsFresh(teamId: string | null, core: string | null): boolean {
  if (!teamId) return false;
  return (
    state.workspaceTeamId === teamId &&
    (state.workspaceCore ?? null) === (core ?? null) &&
    state.workspaceSessions.length > 0
  );
}

/**
 * 确保本 agent 的工作区会话列表可用（缺则发请求）。
 *
 * 返回 `true` = 本次真的发了请求（调用方可据此判断"是否进入了等待"）。
 * 幂等：重复调用（意图预取 + 挂载 + 切 core）只会有一次在飞。
 */
export function ensureWorkspaceSessions(teamId: string | null, core: string | null): boolean {
  if (!teamId) return false;
  if (workspaceSessionsFresh(teamId, core)) return false;
  if (isPending(WORKSPACE_SESSIONS_KEY)) return false;
  sendPending({ RequestWorkspaceSessions: { team_id: teamId } }, WORKSPACE_SESSIONS_KEY);
  return true;
}
