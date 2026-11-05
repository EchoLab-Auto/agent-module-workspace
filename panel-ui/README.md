# Workspace Panel UI 扩展

这是 `echo-agent.workspace` 的前端扩展，包含工作区会话管理、目录选择、文件浏览器、
Git 状态卡、工作区通道标签与多窗口激活规则。Panel 仓本身不再包含这些实现。

通过 Panel 安装器显式组合：

```bash
/path/to/EchoAgentPanel/scripts/install.sh --scope system \
  --ui-extension /path/to/crate-workspace/panel-ui
```

Core 后端模块和 Panel UI 扩展是两项独立部署选择。只装 UI 而 Core 未挂载模块时，扩展
通过 team 能力隐藏入口；只装后端而不装 UI 时，工具仍可由模型调用，但 Panel 不出现
工作区管理界面。

从 Panel 的 `web/` 目录构建和测试：

```bash
PANEL_UI_EXTENSIONS=/path/to/crate-workspace/panel-ui npm run build
PANEL_UI_EXTENSIONS=/path/to/crate-workspace/panel-ui npm test
```
