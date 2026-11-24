//! 工作区 JSON 导入 / 编辑的解析契约（2026-11）。
//!
//! 这三条路径都要能走通，因为它们分别对应三种真实操作：
//! 1. 手写一份新工作区（单对象）；
//! 2. 一次搬多个项目（数组）；
//! 3. 直接把 `echo-workspaces-<team>.json` 的原文整段粘贴（文档形态）。
//!
//! 以及一条硬约束：**校验必须发生在发命令之前**——`SaveWorkspaceSession` 是
//! 全量替换，半条坏数据落盘比拒绝更难收拾。

import { describe, expect, it } from 'vitest';
import {
  MAX_DIRECTORIES,
  MAX_ID_LENGTH,
  parseWorkspaceJson,
  sessionToJson,
} from '../workspace-json';

describe('parseWorkspaceJson：三种形态', () => {
  it('单份会话：名称/描述/目录规范化', () => {
    const result = parseWorkspaceJson(
      JSON.stringify({ name: '  框架  ', description: ' 核心仓 ', directories: [' /srv/core ', '/srv/core'] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document).toBe(false);
    expect(result.sessions).toHaveLength(1);
    const [session] = result.sessions;
    expect(session.name).toBe('框架');
    expect(session.description).toBe('核心仓');
    // 去空白 + 联合去重（同一路径写两遍只留一份）
    expect(session.directories).toEqual(['/srv/core']);
    // 缺省的 id 留空 = 交给 Core 依名称生成 slug
    expect(session.id).toBe('');
  });

  it('会话数组：逐条校验并保留顺序', () => {
    const result = parseWorkspaceJson(
      JSON.stringify([
        { id: 'core', name: '框架', directories: ['/srv/core'] },
        { id: 'panel', name: '面板', directories: ['/srv/panel'] },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sessions.map((s) => s.id)).toEqual(['core', 'panel']);
  });

  it('整份落盘文档：取 sessions，active 只作为提示返回', () => {
    const raw = JSON.stringify({
      active: 'core',
      active_conversation: 'main',
      sessions: [
        {
          id: 'core',
          name: '框架',
          description: '',
          directories: ['/srv/core', { path: '/srv/remote', node: 'gpu-box' }],
          conversations: [
            { id: 'main', name: '主对话', legacy: true },
            { id: 'review', name: '评审', legacy: false, api_profile: 'kimi' },
          ],
          last_conversation: 'review',
        },
      ],
    });
    const result = parseWorkspaceJson(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document).toBe(true);
    expect(result.active).toBe('core');
    expect(result.activeConversation).toBe('main');
    const [session] = result.sessions;
    // 跨机目录保留 {path,node}（与 Core 线格式一致，导回去语义不变）
    expect(session.directories).toEqual(['/srv/core', { path: '/srv/remote', node: 'gpu-box' }]);
    expect(session.conversations?.map((c) => c.api_profile ?? null)).toEqual([null, 'kimi']);
    expect(session.last_conversation).toBe('review');
  });
});

describe('parseWorkspaceJson：拒绝坏数据', () => {
  it('空内容 / 非法 JSON / 顶层形态不对', () => {
    expect(parseWorkspaceJson('   ')).toMatchObject({ ok: false });
    const broken = parseWorkspaceJson('{ name: 框架 }');
    expect(broken.ok).toBe(false);
    if (broken.ok) return;
    expect(broken.error).toContain('不是合法 JSON');
    const scalar = parseWorkspaceJson('42');
    expect(scalar.ok).toBe(false);
  });

  it('空 sessions 数组 = 没有可导入的东西', () => {
    const result = parseWorkspaceJson(JSON.stringify({ sessions: [] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('sessions 为空');
  });

  it('缺名称：错误指到字段', () => {
    const result = parseWorkspaceJson(JSON.stringify([{ name: 'ok' }, { directories: [] }]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('[1].name');
  });

  it('目录类型错与超上限', () => {
    const bad = parseWorkspaceJson(
      JSON.stringify({ name: 'x', directories: ['/a', 42] }),
    );
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error).toContain('directories[1]');

    const tooMany = parseWorkspaceJson(
      JSON.stringify({
        name: 'x',
        directories: Array.from({ length: MAX_DIRECTORIES + 1 }, (_, i) => `/d${i}`),
      }),
    );
    expect(tooMany.ok).toBe(false);
    if (tooMany.ok) return;
    expect(tooMany.error).toContain(`最多 ${MAX_DIRECTORIES}`);
  });

  it('id 不能破坏通道 id（含 / : 空白）、不能超长、不能重复', () => {
    for (const id of ['a/b', 'a:b', 'a b']) {
      const result = parseWorkspaceJson(JSON.stringify({ id, name: 'x' }));
      expect(result.ok, id).toBe(false);
    }
    const tooLong = parseWorkspaceJson(
      JSON.stringify({ id: 'a'.repeat(MAX_ID_LENGTH + 1), name: 'x' }),
    );
    expect(tooLong.ok).toBe(false);

    const duplicated = parseWorkspaceJson(
      JSON.stringify([{ id: 'core', name: 'a' }, { id: 'core', name: 'b' }]),
    );
    expect(duplicated.ok).toBe(false);
    if (duplicated.ok) return;
    expect(duplicated.error).toContain('重复');
  });

  it('对话缺 id / last_conversation 指向不存在的对话', () => {
    const noId = parseWorkspaceJson(
      JSON.stringify({ name: 'x', conversations: [{ name: '主对话' }] }),
    );
    expect(noId.ok).toBe(false);

    const dangling = parseWorkspaceJson(
      JSON.stringify({
        name: 'x',
        conversations: [{ id: 'main', name: '主对话' }],
        last_conversation: 'ghost',
      }),
    );
    expect(dangling.ok).toBe(false);
    if (dangling.ok) return;
    expect(dangling.error).toContain('last_conversation');
    expect(dangling.error).toContain('main');
  });
});

describe('sessionToJson：编辑段初始文本', () => {
  it('往返：生成 → 解析得到同一份会话', () => {
    const session = {
      id: 'core',
      name: '框架',
      description: '核心仓',
      directories: ['/srv/core', { path: '/srv/remote', node: 'gpu-box' }],
      conversations: [{ id: 'main', name: '主对话', legacy: true }],
      last_conversation: 'main',
    };
    const result = parseWorkspaceJson(sessionToJson(session));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sessions[0]).toMatchObject({
      id: 'core',
      name: '框架',
      description: '核心仓',
      directories: session.directories,
      last_conversation: 'main',
    });
  });

  it('空 conversations 不写出来：Core 把空数组解释成「本次未提供」', () => {
    const text = sessionToJson({
      id: 'x',
      name: 'x',
      description: '',
      directories: [],
      conversations: [],
    });
    expect(text).not.toContain('conversations');
    expect(text).not.toContain('last_conversation');
  });
});
