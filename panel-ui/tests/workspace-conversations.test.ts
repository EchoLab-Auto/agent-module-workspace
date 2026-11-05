//! 工作区多对话（2026-10）面板侧契约。
//!
//! 覆盖：
//! 1. 协议镜像：`WorkspaceSessions.active_conversation` /
//!    `WorkspaceSessionInfo.conversations` / `ActivateWorkspaceSession.conversation`；
//! 2. 通道 id 解析：legacy（裸 ws）与 `<ws>/<conv>` 两种形态；
//! 3. 投影与点选意图：(工作区, 对话) 激活对；
//! 4. SessionSwitcher：scope_id 含 `/` 的工作区通道仍归入 Local 分组、
//!    标签「工作区」、按会话行展开。

import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { parseEvent, serializeCommand, type BackendEvent, type WorkspaceSessionInfo } from '@echo-agent/panel';
import {
  LOCAL_DEFAULT_SESSION,
  conversationsView,
  conversationIdForName,
  localSessionProjection,
  parseWorkspaceChannelId,
  workspaceChannelSessionId,
  workspaceIdOfChannel,
  workspacePickIntent,
} from '../workspace';
import '../index';
import SessionSwitcher from '@echo-agent/panel/components/SessionSwitcher';
import { state } from '@echo-agent/panel';
import type { SessionInfo } from '@echo-agent/panel';
import { initialState, reduce } from '@echo-agent/panel';

// ── 1. 协议镜像 ──────────────────────────────────────────────────────────

describe('协议：WorkspaceSessions 多对话字段', () => {
  it('解析 active_conversation 与 conversations（含 legacy 标记）', () => {
    const frame = JSON.stringify({
      type: 'event',
      payload: {
        WorkspaceSessions: {
          team_id: 't1',
          active: 'proj',
          active_conversation: 'docs',
          sessions: [
            {
              id: 'proj',
              name: 'Proj',
              conversations: [
                { id: 'main', name: '主对话', legacy: true },
                { id: 'docs', name: '文档线', legacy: false },
              ],
              last_conversation: 'docs',
            },
          ],
        },
      },
    });
    const event = parseEvent(frame);
    expect(event && 'WorkspaceSessions' in event).toBe(true);
    if (!event || !('WorkspaceSessions' in event)) return;
    const e = event.WorkspaceSessions;
    expect(e.active).toBe('proj');
    expect(e.active_conversation).toBe('docs');
    expect(e.sessions[0].last_conversation).toBe('docs');
    expect(e.sessions[0].conversations).toEqual([
      { id: 'main', name: '主对话', legacy: true },
      { id: 'docs', name: '文档线', legacy: false },
    ]);
  });

  it('旧 Core 帧（无新字段）解析缺省', () => {
    const frame = JSON.stringify({
      type: 'event',
      payload: { WorkspaceSessions: { sessions: [{ id: 'proj', name: 'Proj' }], active: 'proj' } },
    });
    const event = parseEvent(frame);
    if (!event || !('WorkspaceSessions' in event)) throw new Error('expect WorkspaceSessions');
    expect(event.WorkspaceSessions.active_conversation).toBeUndefined();
    expect(event.WorkspaceSessions.sessions[0].conversations).toBeUndefined();
  });

  it('ActivateWorkspaceSession 命令携带 conversation', () => {
    const json = JSON.parse(
      serializeCommand({
        ActivateWorkspaceSession: { team_id: 't1', id: 'proj', conversation: 'docs' },
      }),
    );
    expect(json.type).toBe('command');
    expect(json.payload.ActivateWorkspaceSession).toEqual({
      team_id: 't1',
      id: 'proj',
      conversation: 'docs',
    });
  });
});

// ── 2. 通道 id 解析（legacy / 非 legacy） ───────────────────────────────

describe('工作区通道 id（多对话两种形态）', () => {
  it('legacy 裸 ws 格式：conversationId = null', () => {
    expect(parseWorkspaceChannelId('local:workspace:proj:local_user')).toEqual({
      workspaceId: 'proj',
      conversationId: null,
    });
    expect(workspaceIdOfChannel('local:workspace:proj:local_user')).toBe('proj');
  });

  it('非 legacy `<ws>/<conv>` 格式：scope_id 含 `/` 正确拆出', () => {
    expect(parseWorkspaceChannelId('local:workspace:proj/docs:local_user')).toEqual({
      workspaceId: 'proj',
      conversationId: 'docs',
    });
    expect(workspaceIdOfChannel('local:workspace:proj/docs:local_user')).toBe('proj');
  });

  it('通道 id 构造与解析往返（legacy / 非 legacy）', () => {
    const legacy = workspaceChannelSessionId('proj', { id: 'main', name: '主对话', legacy: true });
    expect(legacy).toBe('local:workspace:proj:local_user');
    expect(parseWorkspaceChannelId(legacy)).toEqual({ workspaceId: 'proj', conversationId: null });

    const conv = workspaceChannelSessionId('proj', { id: 'docs', name: '文档', legacy: false });
    expect(conv).toBe('local:workspace:proj/docs:local_user');
    expect(parseWorkspaceChannelId(conv)).toEqual({ workspaceId: 'proj', conversationId: 'docs' });
  });

  it('畸形/非工作区 id 不解析', () => {
    expect(parseWorkspaceChannelId('local:workspace:/docs:local_user')).toBeNull();
    expect(parseWorkspaceChannelId('local:workspace:proj/:local_user')).toBeNull();
    expect(parseWorkspaceChannelId('local:tui::local_user')).toBeNull();
    expect(parseWorkspaceChannelId('qq:dm::42')).toBeNull();
  });
});

// ── 3. 对话视图 / slug / 投影 / 点选意图 ────────────────────────────────

describe('对话读取视图与 id 生成', () => {
  it('conversations 缺省/空 → 隐式主对话（legacy）', () => {
    expect(conversationsView({ id: 'proj', name: 'Proj' })).toEqual([
      { id: 'main', name: '主对话', legacy: true },
    ]);
    expect(conversationsView({ id: 'proj', name: 'Proj', conversations: [] })).toEqual([
      { id: 'main', name: '主对话', legacy: true },
    ]);
  });

  it('conversationIdForName：slug、去重、CJK 回退', () => {
    expect(conversationIdForName('Docs Line', [])).toBe('docs-line');
    expect(conversationIdForName('Docs Line', ['docs-line'])).toBe('docs-line-2');
    expect(conversationIdForName('文档线', [])).toBe('conv');
    expect(conversationIdForName('2026', [])).toBe('conv');
    expect(conversationIdForName('文档线', ['conv'])).toBe('conv-2');
  });
});

describe('本地会话投影（工作区, 对话）', () => {
  const sessions: WorkspaceSessionInfo[] = [
    {
      id: 'proj',
      name: 'Proj',
      conversations: [
        { id: 'main', name: '主对话', legacy: true },
        { id: 'docs', name: '文档', legacy: false },
      ],
    },
  ];

  it('active 空 → 默认会话；无对话维度 → 旧格式通道', () => {
    expect(localSessionProjection(null, null, sessions)).toBe(LOCAL_DEFAULT_SESSION);
    expect(localSessionProjection('proj', null, sessions)).toBe(
      'local:workspace:proj:local_user',
    );
  });

  it('非 legacy 对话 → `<ws>/<conv>` 通道；legacy 对话 → 旧格式通道', () => {
    expect(localSessionProjection('proj', 'docs', sessions)).toBe(
      'local:workspace:proj/docs:local_user',
    );
    expect(localSessionProjection('proj', 'main', sessions)).toBe(
      'local:workspace:proj:local_user',
    );
  });

  it('快照未知但已知激活对话：按新格式乐观投影', () => {
    expect(localSessionProjection('proj', 'docs', null)).toBe(
      'local:workspace:proj/docs:local_user',
    );
  });
});

describe('点选意图（多对话）', () => {
  const sessions: WorkspaceSessionInfo[] = [
    {
      id: 'proj',
      name: 'Proj',
      conversations: [
        { id: 'main', name: '主对话', legacy: true },
        { id: 'docs', name: '文档', legacy: false },
      ],
    },
  ];

  it('选非 legacy 通道 → 激活 (proj, docs)', () => {
    expect(
      workspacePickIntent('local:workspace:proj/docs:local_user', null, null, true, sessions),
    ).toEqual({ kind: 'activate', workspaceId: 'proj', conversation: 'docs' });
  });

  it('选 legacy 通道 → 解析到 legacy 对话（main），不带 conversation=null', () => {
    expect(
      workspacePickIntent('local:workspace:proj:local_user', 'proj', 'docs', true, sessions),
    ).toEqual({ kind: 'activate', workspaceId: 'proj', conversation: 'main' });
  });

  it('已是当前激活对 → 不重发；同工作区不同对话 → 换对话', () => {
    expect(
      workspacePickIntent('local:workspace:proj/docs:local_user', 'proj', 'docs', true, sessions),
    ).toEqual({ kind: 'none' });
    expect(
      workspacePickIntent('local:workspace:proj/docs:local_user', 'proj', 'main', true, sessions),
    ).toEqual({ kind: 'activate', workspaceId: 'proj', conversation: 'docs' });
  });
});

// ── 4. SessionSwitcher 分组（scope_id 含 `/`） ──────────────────────────

describe('SessionSwitcher 工作区多对话通道分组', () => {
  function session(id: string, nickname: string): SessionInfo {
    return {
      id,
      team_id: 't1',
      platform: 'local',
      scope: 'workspace',
      user_id: 'local_user',
      nickname,
      group_name: null,
      last_active: 1,
      last_message: '',
    };
  }

  it('legacy 与 `<ws>/<conv>` 通道都归入 Local 分组、标签「工作区」、各占一行', () => {
    state.teams = [];
    state.sessions = [
      session('local:workspace:proj:local_user', 'Proj'),
      session('local:workspace:proj/docs:local_user', 'Proj · 文档线'),
    ];
    const wrapper = mount(SessionSwitcher, {
      props: { activeTeamId: 't1', activeSessionId: '' },
    });
    const titles = wrapper.findAll('.sw-group__title').map((el) => el.text());
    // 两种形态都识别为 local 分组（不落入「其他」）
    expect(titles).toEqual(['Local']);
    const items = wrapper.findAll('.sw-item');
    expect(items).toHaveLength(2);
    const tags = wrapper.findAll('.sw-tag').map((el) => el.text());
    expect(tags).toEqual(['工作区', '工作区']);
    const labels = wrapper.findAll('.sw-label').map((el) => el.text());
    expect(labels).toEqual(['Proj', 'Proj · 文档线']);
  });
});

// ── 5. sessionApiOverrides：WorkspaceSessions 只替换工作区键 ─────────────

describe('sessionApiOverrides：WorkspaceSessions 只替换工作区键', () => {
  it('非工作区会话（QQ 等）的乐观覆盖值被保留', () => {
    let s = initialState();
    // 非工作区键（如 QQ 会话的乐观覆盖）+ 一个旧的工作区键（应被权威数据替换）。
    s.sessionApiOverrides = {
      'qq:group:12345:67890': 'qq-profile',
      'local:workspace:old:local_user': 'stale-profile',
    };
    s = reduce(s, {
      WorkspaceSessions: {
        team_id: 't1',
        active: 'proj',
        sessions: [
          {
            id: 'proj',
            name: 'Proj',
            conversations: [
              { id: 'main', name: '主对话', legacy: true, api_profile: 'alpha' },
              { id: 'docs', name: '文档线', legacy: false },
            ],
          },
        ],
      },
    } as unknown as BackendEvent);

    // 非工作区键：保留（此前整体替换会误清）。
    expect(s.sessionApiOverrides['qq:group:12345:67890']).toBe('qq-profile');
    // 工作区键：按权威快照重算——旧键消失、新覆盖出现。
    expect(s.sessionApiOverrides['local:workspace:old:local_user']).toBeUndefined();
    expect(s.sessionApiOverrides['local:workspace:proj:local_user']).toBe('alpha');
  });
});
