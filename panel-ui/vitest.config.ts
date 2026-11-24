import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 面板源码所在目录（**测试专用依赖**）。
 *
 * ## 为什么测试需要面板源码，构建不需要
 *
 * 构建把 `vue` / `@echo-agent/panel` / `@echolab-auto/ui-frame` 全部 externalize
 * ——它们由面板的 import map 在运行期提供。所以 `npm run build` 在**任何机器**
 * 上都能跑，不需要面板仓。
 *
 * 但测试要真的拿到 `state` / `sendCommand` 这些**运行时值**，以及 ui-frame 的
 * 组件。这些只能来自面板仓（ui-frame 的源码不在任何模块仓里，面板仓的
 * `vendor/ui-frame` 是全站唯一那份）。所以：
 *
 * - 开发机（与面板仓同机）：默认路径即可；
 * - 其他环境：`PANEL_SOURCE=/path/to/echo-agent-panel/source npm test`；
 * - 拿不到面板源码时 `npm test` 会明确报"找不到模块"，而不是假装通过。
 */

// 默认值假定本仓与面板仓是**同机同级**的两棵树：
//   <home>/src/agent-module-workspace/panel-ui   ← here
//   <home>/.local/share/echo-agent-panel/source  ← 面板
// 从 `here` 上跳三级（panel-ui → agent-module-workspace → src → home）才是
// `<home>`；少跳一级会得到 `<home>/src/.local/...`，一个永远不存在的路径，
// 症状是所有测试都报 "Failed to resolve import @echo-agent/panel"。
const PANEL_SOURCE =
  process.env.PANEL_SOURCE ??
  path.resolve(here, '../../../.local/share/echo-agent-panel/source');
const panelWeb = path.join(PANEL_SOURCE, 'web');

// 早失败：路径算错时直接说清楚，别让 16 个测试文件各报一次同样的
// "Failed to resolve import"（那条消息不会提到路径算错）。
if (!existsSync(path.join(panelWeb, 'src', 'extension-api.ts'))) {
  throw new Error(
    `找不到面板源码：${PANEL_SOURCE}\n` +
      `用 PANEL_SOURCE=/path/to/echo-agent-panel/source npm test 指定。`,
  );
}

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: [
      // 顺序有理：具体路径先于通配（`@echo-agent/panel/components/X` 不能被
      // `@echo-agent/panel` 那条吃掉）。
      {
        find: /^@echo-agent\/panel\/components\/(.+)$/,
        replacement: path.join(panelWeb, 'src/components/$1.vue'),
      },
      { find: /^@echo-agent\/panel\/App$/, replacement: path.join(panelWeb, 'src/App.vue') },
      { find: /^@echo-agent\/panel$/, replacement: path.join(panelWeb, 'src/extension-api.ts') },
      // ui-frame 的子路径是**带 exports 映射**的包（`components/X` →
      // `dist/components/X/index.js`）。直接 alias 到包目录不会走 exports，
      // 所以显式补两条最常用的映射；其余子路径靠上面那条兜底（它们本来就
      // 是文件路径，不走映射）。
      {
        find: /^@echolab-auto\/ui-frame\/components\/(.+)$/,
        replacement: path.join(panelWeb, 'vendor/ui-frame/dist/components/$1/index.js'),
      },
      {
        find: /^@echolab-auto\/ui-frame\/dist\/(.*)$/,
        replacement: path.join(panelWeb, 'vendor/ui-frame/dist/$1'),
      },
      {
        find: /^@echolab-auto\/ui-frame$/, 
        replacement: path.join(panelWeb, 'vendor/ui-frame/dist/ui-frame.js'),
      },
    ],
  },
  server: { fs: { allow: [here, PANEL_SOURCE] } },
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts', 'components/tests/**/*.test.ts'],
    server: { deps: { inline: [/@echolab-auto/] } },
  },
});
