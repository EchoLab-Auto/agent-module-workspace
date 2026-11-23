---
id: commands
title: "命令域与工具"
group: 后端
x: 960
y: 560
---

# 命令域与工具

> **定位**：模块对外暴露的三层入口——面板线协议命令 7 条、宿主内部命令 2 条、模块私有方法 2 条，以及模型侧的 `workspace` 工具。覆盖每条命令的载荷契约、回执形态与错误口径。数据如何落盘见[数据与持久化](./storage.md)，跨机路径见[跨机目录](./remote.md)。读者：改面板交互、加命令、或排查「命令成功但界面没变」的人。

## 面板命令域

7 条线协议命令（`commands::COMMANDS` 的前 7 项）。`team_id` 一律**必填**——去主智能体后没有默认人格，缺失即报错（`store_or_err` 发一条 `Error` 事件并返回可读错误，不静默回落到某个人格）。

| 命令 | 载荷要点 | 行为 | 回执 |
|---|---|---|---|
| `RequestWorkspaceSessions` | `team_id` | 读快照并广播 | `WorkspaceSessions {team_id, sessions, active, active_conversation}` |
| `SaveWorkspaceSession` | `session`（完整对象） | upsert（`id` 空则按名称生成 slug） | 变更提示（`Error` 事件承载文案） |
| `DeleteWorkspaceSession` | `id` | 删除会话 | 不存在时报「工作区会话 {id} 不存在」 |
| `ActivateWorkspaceSession` | `id`（空 = 取消激活）、`conversation` | 设置/清除激活标记 | 激活回执文案；通道注册与广播由宿主完成 |
| `RequestWorkspaceGitStatus` | `session_id`（**历史命名，实际是工作区 id**） | 采集各目录 git 快照 | `WorkspaceGitStatus {team_id, session_id, directories}` |
| `RequestWorkspaceFiles` | `session_id`、`path` | 列目录 | `WorkspaceFiles` 回推（`entries`），见 `files.rs` |
| `RequestBrowseDirectories` | `path`（空 = 根列表） | 目录选择器 | `BrowseDirectories` 回推（`roots` + `entries`） |

变更类命令共用一个骨架 `mutate`：取 store → 执行 → 成功发提示、失败发 `Error`。**列表/激活广播不在这里发**——store 的变更钩子会发 `workspace.changed`，宿主据此走完「确保通道会话 + 恢复会话级 API + 发 `SessionUpdated` / `WorkspaceSessions`」。模块因此不需要知道宿主的会话子系统存在。

## 宿主内部命令

两条**不进线协议**的命令，宿主经命令通道回来（原先宿主直接调 store，跨仓后只能请求唯一写者）：

| 命令 | 用途 | 语义 |
|---|---|---|
| `WorkspaceSetConversationApiProfile` | 会话级 API 覆盖写进对应工作区对话 | `profile` 空 = 清除；`session_id` 是工作区通道 id，非工作区通道静默成功（宿主侧也是直接跳过）；裸通道按 `legacy == true` 定位，不猜 `id == "main"` |
| `WorkspaceRenameApiProfile` | 供应商改名后传播 `api_profile` 引用 | 返回 `{changed: N}`，`to` 空 = 清除引用 |

## 模块私有方法

两条**模块自己的词汇**，面板经通用调用通道 `InvokeModuleOp { module, method, payload }` 点名调用，结果作为 `ModuleInvokeResult.data` 返回——宿主只搬运，不认识 `workspaces` / `conversations` 这些字段，也不需要在协议里加变体。

| 方法 | 类型 | 语义 |
|---|---|---|
| `workspace.overview` | 只读 | 工作区数 / 对话数 / 目录数 / 远程目录数 + `active` |
| `workspace.deleteConversation` | 写 | 删除一条对话**入口**，聊天历史保留 |

`workspace.overview` 的低风险来自约束：只读一次 `snapshot`（计数与 `active` 同源，不会跨读拼接）；不扫文件系统、不跑 git、不发起联邦查询；不写盘、不物化惰性主对话。返回 `request_id` 原样回显（`ModuleInvokeResult` 只回显 `module` / `method`），非字符串的 `request_id` 明确报错而不静默丢弃。

`workspace.deleteConversation` 的三种业务结果都走 `Ok`（面板要能按 `request_id` 配对并给提示），只有「工作区不存在」「落盘失败」才是 `Err`：

| `result` | 含义 |
|---|---|
| `deleted` | 已删除并落盘，附对话对象与提示文案 |
| `already_absent` | 目标本来就不在（重复调用 / 陈旧 id），幂等成功，不写盘 |
| `refused_last_conversation` | 这是该工作区最后一条对话，拒绝删除（每个工作区至少保留一条） |

## workspace 工具

模型看到的是宿主的**代理壳**，描述与 schema 直接取自本模块的 `tool::description` / `tool::parameters`——模型面与实现只有一个真值。调用时宿主把 `ToolContext.team_id` 补进载荷，转发到 `WorkspaceToolCall`，模块按 `team_id` 定位 store。

`operation` 六个取值：

| 操作 | 作用 |
|---|---|
| `list` | 列出工作区会话（含对话视图） |
| `status` | 当前激活工作区与会话级信息 |
| `use` | 切换激活工作区（与面板激活走同一条广播路径） |
| `create` | 新建工作区（名称 + 目录列表） |
| `delete` | 删除工作区 |
| `conversations` | 列出某工作区的对话 |

第二层 `directory` 动作支持 `list` / `create` / `rename` / `delete`，用于在工具里管理目录条目。工具入口必须出现在 `with_commands` 声明里，否则宿主的命令分发不会把它送过来。

## 校验与错误口径

- 认领优先于解析：`handle` 先判断「这条命令是不是本模块的」，不相关时返回 `None`，畸形载荷不该被认领成一个错误
- 声明过的名字若无处理器，返回「命令 X 被声明但处理器没有认领它」——避免面板转圈
- git 采集有硬超时（`git.rs::GIT_TIMEOUT = 5s`），明细每类最多 `CHANGED_FILES_CAP = 30` 条；文件列表最多 `files.rs::FILES_CAP = 500` 条，目录在前、文件在后，各自按名称不区分大小写排序
- 文件访问用 **canonical 前缀 + `/` 的字面比较**（不是 `Path::starts_with`）判定是否落在会话已声明目录内，避免 `/a/bc` 被误判为在 `/a/b` 之下
