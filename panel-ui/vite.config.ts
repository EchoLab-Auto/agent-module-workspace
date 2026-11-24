//! 工作区模块的 Panel UI 扩展构建。
//!
//! ## 产物形态
//!
//! 一个**标准 ES 模块**：`dist/index.js`。Panel 在运行期 `import()` 它，
//! 模块顶层调用 `registerPanelExtension(...)` 完成注册。
//!
//! ## 为什么这些必须 externalize
//!
//! | 裸标识符 | 理由 |
//! |---|---|
//! | `vue` | 两份 vue = 两套响应式系统：组件能渲染但 `ref` 不触发更新、`provide/inject` 拿不到。表现隐晦，报错通常指向别处 |
//! | `@echo-agent/panel` | 里面是 Panel 的**单例**（`state` / `dispatch` / 注册表）。打一份副本等于扩展改的是自己的影子状态，界面永远不更新 |
//! | `@echo-agent/panel/components/*` | 同上：组件实例要共享壳的 props 契约与内部状态 |
//! | `@echolab-auto/ui-frame/*` | 19 MB 源码 + 312 KB 样式；每个扩展各打一份既慢又会让设计令牌出现多套 |
//!
//! 运行期这些裸标识符由 Panel 的 **import map** 解析（见 Panel 仓
//! `panel-shared.entries.json`）。所以产物里保留 `import ... from 'vue'`
//! 是**正确**的，浏览器会去 import map 里查。
//!
//! ## CSS
//!
//! 组件里的 `<style>` 会被抽成独立 CSS，而浏览器原生 ES 模块**不支持
//! `import "x.css"`**。所以用 `cssInjectedByJsPlugin` 等价物：把 CSS 拼成
//! 字符串、在模块加载时插进 `<head>`。这样产物是纯 JS，动态 `import()` 即可。

import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * 把抽取出来的 CSS 注入到 JS 里（运行期追加 `<style>`）。
 *
 * 为什么不用现成的 `vite-plugin-css-injected-by-js`：只用到它最核心的十行，
 * 引一个额外依赖换十行代码不划算，而且它的注入时机（`document.head` 是否
 * 就绪）在本场景下不需要考虑——Panel 加载扩展时 DOM 一定已经在。
 */
function inlineCss(): import('vite').Plugin {
  return {
    name: 'echo-panel-ui-inline-css',
    enforce: 'post',
    generateBundle(_options, bundle) {
      /** 被抽出来的 CSS 内容（按文件名累积）。 */
      const styles: string[] = [];
      for (const [file, asset] of Object.entries(bundle)) {
        if (asset.type === 'asset' && file.endsWith('.css')) {
          styles.push(String(asset.source));
          delete bundle[file];
        }
      }
      if (!styles.length) return;
      const payload = JSON.stringify(styles.join('\n'));
      const injection =
        `\n// 扩展的样式（构建期从 SFC 抽出，运行期插进 <head>）\n` +
        `const __css = ${payload};\n` +
        `if (typeof document !== 'undefined') {\n` +
        `  const el = document.createElement('style');\n` +
        `  el.dataset.panelExtension = ${JSON.stringify('echo-agent.workspace')};\n` +
        `  el.textContent = __css;\n` +
        `  document.head.appendChild(el);\n` +
        `}\n`;
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === 'chunk' && chunk.isEntry) chunk.code += injection;
      }
    },
  };
}

export default defineConfig({
  plugins: [vue(), inlineCss()],
  build: {
    // 产物必须叫 index.js：Core 侧登记的 bundle 路径是
    // `panel-extensions/echo-agent.workspace/index.js`（固定，不带 hash——
    // 面板靠这个路径 import，名字一变就失联）。
    lib: {
      entry: 'index.ts',
      formats: ['es'],
      fileName: () => 'index.js',
    },
    outDir: 'dist',
    emptyOutDir: true,
    // 不要把 CSS 拆成独立文件：下面的 inlineCss 插件会把它塞回 JS。
    cssCodeSplit: false,
    rollupOptions: {
      external: (id) =>
        id === 'vue' ||
        id.startsWith('@echo-agent/panel') ||
        id.startsWith('@echolab-auto/ui-frame'),
    },
    // sourcemap 便于在浏览器里定位扩展代码（产物是对外服务的静态文件，
    // 体积不是瓶颈）。
    sourcemap: true,
    target: 'es2022',
  },
});
