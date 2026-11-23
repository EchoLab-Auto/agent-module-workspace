---
id: module
title: "模块与宿主接缝"
group: 后端
x: 960
y: 240
link: ["storage | 数据与持久化", "commands | 命令域与工具", "remote | 跨机目录"]
---

# 模块与宿主接缝

> **定位**：`echo-agent.workspace` 的身份声明、它为什么必须是独立仓库、`mount` 时从宿主拿到什么、往宿主发什么事件，以及启停与门控的实际效果。覆盖「模块能独立存在」的硬约束（包级循环依赖），不覆盖数据模型与命令细节（见[数据与持久化](./storage.md)、[命令域与工具](./commands.md)）。读者：装配本模块、或判断某个能力该放模块侧还是宿主侧的人。

## 身份与归属

身份写在 `crates/agent-module-workspace/module.toml`，代码用 `include_str!` 读它构造 manifest（`lib.rs::manifest`）——清单是编译期常量，避免「同一二进制在不同机器上表现不同」。

| 项 | 值 |
|---|---|
| 模块 id | `echo-agent.workspace`（唯一真值在模块侧；宿主的 `WORKSPACE_MODULE_ID` 是别名，`module_id_tests::module_id_matches_manifest` 钉住两者一致） |
| 名称 | 工作区会话 |
| kind | `tool`（persona 白名单参与） |
| 来源 / 标签 | `builtin = true`、`tag = inner`：随 Core 发布、以 git 依赖参与构建，不随运行期配置变化 |
| 运行形态 | 进程内（`BuiltinModule`），编译进 Core 二进制 |
| 落盘位置 | `[module.config] state_dir`，缺省 `$XDG_CONFIG_HOME/echo-agent-core`，文件名 `echo-workspaces-{team}.json` |

`MODULE_ID` 分叉的后果是沉默的：宿主门控与包标签都按这个字符串匹配，写错表现为「模块挂上了但门控认不出」或「面板出现名字对不上的条目」，两者都不报错。

## 为什么是独立仓库

本仓**不依赖 EchoAgentCore 的任何 crate**，只依赖框架仓 `echo-fabric-arch` 的 `echo-module` / `echo-context`。这不是洁癖：Core 以 git 依赖引入本仓，若本仓再依赖 Core crate 就是包级循环依赖，Cargo 直接拒绝。

代价与对策：

| 原本依赖的 | 现状 |
|---|---|
| `echo-protocol` 的线类型 | `wire` 模块里的镜像（字段名逐字一致，`wire_contract` 测试钉住） |
| 宿主的 store | `store` 模块自己拥有（per-persona、原子落盘） |
| 宿主的 `emit` / 会话通道 | 向宿主发**模块事件**，由宿主翻译 |
| 联邦的远程查询 | 本仓自己声明 trait（`remote::RemoteWorkspaceQuery`），宿主实现并注入 |

「同一份 Rust 类型」不是必需品，「同一份字段名」才是——两侧交换的都是 JSON，镜像只需要键名与 serde 默认值对齐。

## 宿主接缝

模块在 `mount` 时从 `MountContext` 取三样东西（`lib.rs::module_with_state`）：

| 来源 | 取什么 | 缺失时 |
|---|---|---|
| `ctx.config()` | `Config { state_dir }` | 解析失败打 `warn` 并按缺省目录继续——配置错误不该挡住启动 |
| `ctx.events` | 事件出口（`EventSink`） | 无出口时事件静默丢弃（单测 / 裸装配场景） |
| `ctx.service(&REMOTE_QUERY)` | 跨机查询句柄 | 单机部署 / 联邦关闭时保持降级，本机功能零影响 |

贡献面同样在装配期声明：

- `with_commands(COMMANDS + TOOL_CALL)`：11 条命令名 + 工具入口。**工具入口必须一起声明**——宿主的命令分发只问声明过的名字，漏了它 `WorkspaceToolCall` 永远到不了模块，表现为「工具存在但每次都说模块未启用」
- `with_text_blocks`：键 `workspace`、标题「工作区会话」、`order = 50`（与迁出前一致）
- `with_text_block_content`：按 `context` 里的 `team_id` 定位 store，按 `session_id` 解析本次 turn 的工作区，无 `team_id` 时不贡献内容（进程级模块服务多个人格，缺人格无法定位 store）

## 模块事件协议

模块用 `MountContext::emit` 发三类事件，宿主订阅后翻译成会话子系统的动作。分界是「模块负责语义、宿主负责路由」：

| 事件 | 载荷 | 宿主职责 |
|---|---|---|
| `workspace.backend_event` | 一个 `BackendEvent` 的 JSON（如 `{"WorkspaceSessions":{…}}`） | 反序列化后原样发给前端 |
| `workspace.changed` | `{team_id, active, active_conversation, sessions}` | active 存在时确保工作区通道已注册（会话名 = 工作区名 + 对话名）、推 `SessionUpdated`、广播 `WorkspaceSessions` |
| `workspace.conversation_deleted` | `{team_id, workspace_id, conversation}` | 清空该对话的通道历史（事件日志 / 投影 / 时间线） |

第三条现在只在旧删除路径触发：面板与工具都走 `delete_conversation_entry`（只删入口、保留历史），仓内已无生产调用方。

`workspace.changed` 由 store 的变更钩子产生（`ModuleState::on_store_changed`），钩子在写锁**之外**触发，因此可以安全回读同一份 store。面板命令与模型 `use` 工具共用这一条广播路径——「变更 → 广播」只有一个入口。

## 启停与门控

- `kind = tool`，`enabled_modules` / `enabled_tools` 都能按 persona 收窄；全局关闭后 `workspace` 工具从工具表消失、面板命令无人处理（宿主回明确错误，不静默）
- 禁用模块**不删除**已存的工作区文档，重新启用即恢复
- 模块被 unmount / remount 时 store 不丢：内容在磁盘，`ModuleState` 只是内存视图与事件出口，重建实例等于重新读盘
- 前端是**独立的部署选择**：只装 Core 模块不装 UI 时模型仍可调用工具；只装 UI 而模块未挂载时，扩展按 team 能力隐藏入口（见 [Panel UI 扩展](./panel-ui.md)）

模块状态是**进程级单例**（`ModuleState`）：`stores` 按 `team_id` 缓存 `Arc<WorkspaceStore>`，同一份文档在进程内只有一个内存副本——否则写命令命中一份、读命令命中另一份，表现为「设置生效了、落盘也写了，但界面刷新后回到旧值」。细节见[数据与持久化](./storage.md)。
