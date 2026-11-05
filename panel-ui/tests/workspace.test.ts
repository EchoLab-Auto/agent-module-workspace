//! 工作区通道规则（激活 = 进入项目对话，2026-09-14）。
//!
//! 契约：Core 的 active 标记是单一事实来源；面板「本地当前对话」= active
//! 投影；切换器 Local 分组双向绑定（选通道 = 激活、选默认 = 取消激活）。

import { describe, it, expect } from 'vitest';
import {
  LOCAL_DEFAULT_SESSION,
  directoryNode,
  directoryPath,
  directoryToInput,
  isRemoteDirectoryInput,
  localSessionProjection,
  workspaceChannelSessionId,
  workspaceIdOfChannel,
  workspacePickIntent,
} from '../workspace';

describe('工作区通道 id 与投影', () => {
  it('通道 id 构造/解析往返', () => {
    const id = workspaceChannelSessionId('echo-agent');
    expect(id).toBe('local:workspace:echo-agent:local_user');
    expect(workspaceIdOfChannel(id)).toBe('echo-agent');
  });

  it('非通道会话不进投影解析', () => {
    expect(workspaceIdOfChannel('local:tui::local_user')).toBeNull();
    expect(workspaceIdOfChannel('qq:dm::42')).toBeNull();
    expect(workspaceIdOfChannel('local:workspace::local_user')).toBeNull();
  });

  it('投影：active 空 → 默认会话；active=W → W 通道', () => {
    expect(localSessionProjection(null)).toBe(LOCAL_DEFAULT_SESSION);
    expect(localSessionProjection('echo-agent')).toBe('local:workspace:echo-agent:local_user');
  });
});

describe('切换器点选意图（双向绑定）', () => {
  it('选通道 = 激活（未激活或未同步都发）', () => {
    const id = workspaceChannelSessionId('docs');
    expect(workspacePickIntent(id, 'core', null, true)).toEqual({
      kind: 'activate',
      workspaceId: 'docs',
      conversation: null,
    });
    expect(workspacePickIntent(id, null, null, true)).toEqual({
      kind: 'activate',
      workspaceId: 'docs',
      conversation: null,
    });
    expect(workspacePickIntent(id, null, null, false)).toEqual({
      kind: 'activate',
      workspaceId: 'docs',
      conversation: null,
    });
  });

  it('选已激活通道（快照已同步）不重发', () => {
    const id = workspaceChannelSessionId('docs');
    expect(workspacePickIntent(id, 'docs', null, true)).toEqual({ kind: 'none' });
  });

  it('选默认会话 = 取消激活（仅当已知存在激活）', () => {
    expect(workspacePickIntent(LOCAL_DEFAULT_SESSION, 'docs', null, true)).toEqual({
      kind: 'deactivate',
    });
    // 未激活 / 快照未知：不猜，不发命令
    expect(workspacePickIntent(LOCAL_DEFAULT_SESSION, null, null, true)).toEqual({ kind: 'none' });
    expect(workspacePickIntent(LOCAL_DEFAULT_SESSION, 'docs', null, false)).toEqual({
      kind: 'none',
    });
  });

  it('QQ/global 会话点选不触发激活语义', () => {
    expect(workspacePickIntent('qq:dm::42', 'docs', null, true)).toEqual({ kind: 'none' });
    expect(workspacePickIntent('global', 'docs', null, true)).toEqual({ kind: 'none' });
  });
});

describe('已删除工作区的残留通道（历史保留）', () => {
  const sessions = [{ id: 'alive-ws', name: 'Alive' }];

  it('快照已知且不含该 id → 仅查看（不激活，避免 Core 报错）', () => {
    const stale = 'local:workspace:deleted-ws:local_user';
    expect(workspacePickIntent(stale, null, null, true, sessions)).toEqual({ kind: 'none' });
    // 已是激活态（不太可能，但防御）：依然不激活
    expect(workspacePickIntent(stale, 'deleted-ws', null, true, sessions)).toEqual({
      kind: 'none',
    });
  });

  it('存在的工作区不受影响（正常激活；裸通道解析到 legacy 主对话）', () => {
    const alive = 'local:workspace:alive-ws:local_user';
    expect(workspacePickIntent(alive, null, null, true, sessions)).toEqual({
      kind: 'activate',
      workspaceId: 'alive-ws',
      // 快照已知：裸 ws 旧格式通道解析到该工作区的 legacy 对话（隐式主对话）
      conversation: 'main',
    });
  });

  it('快照未同步（synced=false）→ 不校验（保持旧行为）', () => {
    const id = 'local:workspace:some-ws:local_user';
    expect(workspacePickIntent(id, null, null, false, [])).toEqual({
      kind: 'activate',
      workspaceId: 'some-ws',
      conversation: null,
    });
  });

  it('未提供快照 → 不校验', () => {
    const id = 'local:workspace:some-ws:local_user';
    expect(workspacePickIntent(id, null, null, true)).toEqual({
      kind: 'activate',
      workspaceId: 'some-ws',
      conversation: null,
    });
  });
});

describe('工作区目录条目规范化（跨机线格式 {path,node}）', () => {
  it('字符串（本机）三助手直通', () => {
    const dir = '/srv/local';
    expect(directoryPath(dir)).toBe('/srv/local');
    expect(directoryNode(dir)).toBeNull();
    expect(directoryToInput(dir)).toBe('/srv/local');
    expect(isRemoteDirectoryInput(dir)).toBe(false);
  });

  it('表形式（跨机）规范化：path/node 提取 + node:// 编辑串', () => {
    const dir = { path: '/srv/remote', node: 'gpu-box' };
    expect(directoryPath(dir)).toBe('/srv/remote');
    expect(directoryNode(dir)).toBe('gpu-box');
    // 单斜杠格式（与 Core Display / 提示词一致）
    expect(directoryToInput(dir)).toBe('node://gpu-box/srv/remote');
    expect(isRemoteDirectoryInput(directoryToInput(dir))).toBe(true);
  });

  it('node 缺失的表形式视为本机', () => {
    const dir = { path: '/srv/maybe', node: null };
    expect(directoryNode(dir)).toBeNull();
    expect(directoryToInput(dir)).toBe('/srv/maybe');
  });

  it('node:// 编辑串往返：Core upsert 解析 → 表形式 → 回编辑串', () => {
    // Core 侧 upsert 把 node:// 串解析为 Qualified{path,node}，
    // 回推线格式为 {path,node} 表——面板规范化应还原同一编辑串。
    const roundtrip = directoryToInput({ path: '/srv/repo', node: 'gpu-box' });
    expect(roundtrip).toBe('node://gpu-box/srv/repo');
  });
});
