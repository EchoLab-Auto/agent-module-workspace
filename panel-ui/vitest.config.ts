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
 * 组件。这些只能来自面板仓：`state` 等在 `web/src`，ui-frame 在面板仓的
 * `web/node_modules/@echolab-auto/ui-frame`（2026-11 起是 git 依赖，不再是仓内
 * 快照；扩展本身不 direct-depend ui-frame，构建期由面板 import map 提供）。所以：
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

/**
 * 已安装的 ui-frame 产物目录。
 *
 * 2026-11 之前面板仓在 `web/vendor/ui-frame` 提交一份快照，这里直接指过去；
 * 现在 ui-frame 是面板 web 的 **git 依赖**，构建出的 `dist/` 落在
 * `web/node_modules/@echolab-auto/ui-frame/dist`。路径变了，但语义相同：
 * 扩展测试跑的是「面板实际会加载的那份产物」，不是模块仓自己的副本。
 */
const uiFrameDist = path.join(panelWeb, 'node_modules/@echolab-auto/ui-frame/dist');

// 早失败：路径算错时直接说清楚，别让 16 个测试文件各报一次同样的
// "Failed to resolve import"（那条消息不会提到路径算错）。
if (!existsSync(path.join(panelWeb, 'src', 'extension-api.ts'))) {
  throw new Error(
    `找不到面板源码：${PANEL_SOURCE}\n` +
      `用 PANEL_SOURCE=/path/to/echo-agent-panel/source npm test 指定。`,
  );
}
// 第二个早失败：面板装了依赖才有 ui-frame 产物。缺它时 16 个测试会各报一次
// "Failed to resolve import @echolab-auto/ui-frame/..."，看不出真正原因是
// 「面板那边还没 npm install」。
if (!existsSync(path.join(uiFrameDist, 'ui-frame.js'))) {
  throw new Error(
    `找不到 ui-frame 产物：${uiFrameDist}\n` +
      `先到面板仓 web/ 跑 npm install（ui-frame 是它的 git 依赖）。`,
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
        replacement: path.join(uiFrameDist, 'components/$1/index.js'),
      },
      {
        find: /^@echolab-auto\/ui-frame\/dist\/(.*)$/,
        replacement: path.join(uiFrameDist, '$1'),
      },
      {
        find: /^@echolab-auto\/ui-frame$/, 
        replacement: path.join(uiFrameDist, 'ui-frame.js'),
      },
    ],
  },
  server: { fs: { allow: [here, PANEL_SOURCE] } },
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts', 'components/**/tests/**/*.test.ts'],
    server: { deps: { inline: [/@echolab-auto/] } },
  },
});
