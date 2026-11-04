# echo-plugin-workspace

工作区会话插件（EchoAgent 插件，**独立仓库交付**）。

从 `EchoAgentCore` 的内置插件 `source/plugin/echo-plugin-workspace` 迁出。业务逻辑
（store / git 采集 / 文件浏览 / 提示词文案 / 命令域 / 工具）全部在本仓；Core 只保留
通用接线（见「宿主侧接线」）。

## 能力

- **工作区会话**：多会话、每会话多目录、目录内对话（多任务线），激活态唯一
- **git 快照**：分支 / 领先落后 / 三类变更计数 + 按类分组的明细（porcelain 两列状态）
- **文件浏览器**：限会话已声明目录及其子孙（canonical 前缀校验）
- **目录选择器**：浏览根 = 家目录 + 全部已声明目录（避免「要浏览才能选、要选才能浏览」）
- **提示词块**：激活工作区的名称 / 当前对话 / 目录清单注入系统提示词（`order = 50`）
- **`workspace` 工具**：`list` / `status` / `use` / `create` / `delete` / `conversations`

## 宿主侧接线（EchoAgentCore）

1. Core 的 `Cargo.toml` 加依赖：

   ```toml
   echo-plugin-workspace = { git = "https://github.com/EchoLab-Auto/echo-plugin-workspace", branch = "main" }
   ```

2. 内置插件目录登记（`builtin_plugins.rs`）：

   ```rust
   push_plugin(&mut catalog, echo_plugin_workspace::plugin(version))?;
   ```

3. `plugins.toml` 可给它配置落盘目录（省略 = `$XDG_CONFIG_HOME/echo-agent-core`）：

   ```toml
   [[plugin]]
   id = "echo-agent.workspace"
   kind = "builtin"
   name = "工作区会话"

   [plugin.config]
   # state_dir = "/home/me/.config/echo-agent-core"
   ```

4. **订阅插件事件**，翻译成宿主的会话子系统动作（否则面板看到的列表不会刷新、
   激活也不会建通道）：

   | 事件 | 载荷 | 宿主该做什么 |
   |---|---|---|
   | `workspace.backend_event` | 一个 `BackendEvent` 的 JSON（如 `{"WorkspaceSessions":{…}}`） | 反序列化后 `agent.emit(...)` 发给面板 |
   | `workspace.changed` | `{team_id, active, active_conversation, sessions}` | active 存在时确保工作区会话通道已注册（会话名 = 工作区名 + 对话名）、推 `SessionUpdated`、广播 `WorkspaceSessions` |
   | `workspace.conversation_deleted` | `{team_id, workspace_id, conversation}` | 清空该对话的通道历史（事件日志 / 投影 / 时间线） |

5. **注册工具**：用 `echo_plugin_workspace::tool::{TOOL_NAME, description(),
   parameters()}` 建一个转发型 `Tool`，`execute` 时把参数 + `team_id` 交给

   ```rust
   plugin_host.dispatch_raw(
       "WorkspaceToolCall",
       serde_json::json!({ "team_id": team_id, "operation": ... }),
   )
   ```

   （`payload` 原样透传模型的参数对象，返回值形状 `{"content": "…"}`。）

## 能力边界（相对 Core 内置版本）

| 项 | 状态 |
|---|---|
| 会话 / 对话 / 激活 / 持久化 | 一致（同一份 `echo-workspaces-{team}.json`，旧数据可直接读） |
| git 快照 / 文件浏览 / 目录选择器 | 一致（本机目录） |
| 提示词块 / `workspace` 工具 | 一致 |
| **跨机（`node://`）git 状态** | **降级**：返回「不可采集」占位 + 原因 |
| **跨机（`node://`）文件浏览 / 目录选择器** | **降级**：空结果 + 原因 |

降级原因：跨机查询用的是宿主的联邦能力（`echo-defs::workspace::RemoteWorkspaceQuery`
→ 联邦 `Invoke`），而本仓**不依赖 Core 的任何 crate**（Core 以 git 依赖引入本仓，
反向依赖就是包级循环，Cargo 拒绝）。单机部署完全不受影响；多机部署要在宿主侧补一个
「远程目录代理」（可做成宿主订阅的另一个插件事件，属后续工作）。

## 开发

```bash
cargo test          # 32 个用例（store / git / files / prompt / wire / 命令域 / 工具）
cargo clippy --all-targets -- -D warnings
```

框架类型（`echo-plugin` / `echo-context`）按 tag `v0.11.2` 取自
`echo-fabric-arch`，与 Core 根 `Cargo.toml` 保持同一 tag——同一进程里不能出现两份
`Box<dyn Plugin>`。本地联调框架改动时，把这两个依赖临时换成 `path` 即可。

## 许可

MIT
