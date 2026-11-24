//! 扩展注册面成对约束（回归 2026-11「点工作区按钮弹不出来」）。
//!
//! ## 事故
//!
//! 删除概览卡时手动编辑 `panel-ui/index.ts`，把 `overlays` 那一行连带删掉了。
//! 结果：入口行的「工作区」按钮**还在**（`entries` 未受影响，点击也真的把
//! `entryOverlay` 切到了 `extension:echo-agent.workspace:sessions`），但 Panel
//! 的 `panelOverlays()` 返回空数组 —— 没有任何 `SessionOverlay` 可渲染，于是
//! 「点了没反应」。
//!
//! 为什么没有测试抓到：入口按钮与弹层是**两个独立的注册面**，各自都有测试。
//! `ChatViewPopover.test.ts` 用的是自己的 stub 扩展（entries + overlays 都写了）；
//! 扩展仓这边从未断言过「我声明的每个入口都有对应弹层」。
//!
//! ## 本测试钉住的规则
//!
//! 对**每一个** entry，必须存在同 id 的 overlay（Panel 用
//! `extension:<扩展 id>:<entry id>` 交叉匹配）。反过来不要求：可以只提供弹层
//! 而由其它入口打开（当前没有，但不算错）。
//!
//! 断言只看扩展自己声明的注册对象，不碰壳的内部模块——它拦的是「编辑时的
//! 误删」，而不是 Panel 的渲染行为（后者归 Panel 仓的测试）。

import { describe, it, expect, vi } from 'vitest';

/** `registerPanelExtension` 收到的那个对象（扩展的完整注册面）。 */
const captured = vi.hoisted(() => ({ value: null as unknown }));

vi.mock('@echo-agent/panel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@echo-agent/panel')>();
  return {
    ...actual,
    startConnection: vi.fn(),
    sendCommand: vi.fn(),
    definePanelExtension: (extension: unknown) => extension,
    registerPanelExtension: (extension: unknown) => {
      captured.value = extension;
    },
  };
});

import '../index';

interface Registration {
  entries?: Array<{ id: string; label: string }>;
  overlays?: Array<{ id: string }>;
  railCardSlots?: string[];
}

function registration(): Registration {
  expect(captured.value, '扩展必须注册（import ../index 的副作用）').toBeTruthy();
  return captured.value as Registration;
}

describe('工作区扩展的注册面', () => {
  it('每个入口都有同 id 的弹层（2026-11 事故：按钮在、弹层没了）', () => {
    const ext = registration();
    const entryIds = (ext.entries ?? []).map((entry) => entry.id);
    const overlayIds = new Set((ext.overlays ?? []).map((overlay) => overlay.id));
    expect(entryIds.length, '至少要有「工作区」入口').toBeGreaterThan(0);
    for (const id of entryIds) {
      expect(overlayIds.has(id), `入口 ${id} 缺少同 id 的 overlays 项`).toBe(true);
    }
  });

  it('「工作区」入口与弹层都在，且弹层带组件', () => {
    const ext = registration();
    expect(ext.entries?.some((entry) => entry.id === 'sessions')).toBe(true);
    const overlay = (ext.overlays ?? []).find((item) => item.id === 'sessions') as
      | { label?: string; component?: unknown }
      | undefined;
    expect(overlay, '「工作区」弹层必须存在').toBeTruthy();
    expect(overlay?.component, '弹层必须带可渲染组件').toBeTruthy();
  });

  it('边栏卡槽位只登记实际会渲染的卡（概览卡已删）', () => {
    const ext = registration();
    expect(ext.railCardSlots).toEqual(['files', 'git']);
  });
});
