---
prodoc: true
id: storage
title: "数据与持久化"
group: 后端
x: 640
y: 560
---

# 数据与持久化

> **定位**：工作区数据的形状与生命周期——线类型、per-persona 文档、原子落盘、进程级共享 store、通道身份与退役规则。覆盖「谁写、写到哪、什么时候提交」。命令如何触发这些写入见[命令域与工具](./commands.md)，前端如何消费见[Panel UI 扩展](./panel-ui.md)。读者：改数据模型、接入旧数据、或修「保存后刷新回旧值」这类问题的人。

## 数据模型

线类型在 `wire.rs`，是宿主 `echo-protocol` 的**镜像**（字段名、serde 默认值、`skip_serializing_if` 逐字对齐）：

| 类型 | 关键字段 | 说明 |
|---|---|---|
| `WorkspaceSessionInfo` | `id` / `name` / `description` / `directories` / `conversations` / `last_conversation` | 一个工作区会话；`id` 为空时按名称生成 slug |
| `WorkspaceConversationInfo` | `id` / `name` / `legacy` / `api_profile` | 工作区内一条对话；`api_profile` 为空 = 跟随 persona 级 |
| `WorkspaceDirectory` | `Local(String)` 或 `Qualified { path, node }`（`untagged`） | 本机目录线格式是**纯字符串**；带节点是表形式。`node` 缺省 = 本机 |
| `WorkspaceGitInfo` | `branch` / `ahead` / `behind` / `staged` / `modified` / `untracked` / `changed_entries` / `last_commit` / `error` | 单个目录的 git 快照 |
| `WorkspaceFileEntry` | `name` / `path` / `is_dir` / `size` | 文件浏览器条目 |
| `BrowseRoot` | `label` / `path` | 目录选择器的浏览根 |

持久化文档 `store::WorkspaceDocument` 只多两样东西：

- `active` / `active_conversation`：唯一的激活标记（工作区 id + 对话 id）
- `retired_channels`：已退役的对话通道身份，`serde(default)` + 空表不落键，旧档可直接读

硬上限：每会话最多 `MAX_DIRECTORIES = 32` 个目录（保护提示词与工具输出体量），超出返回可读错误。

`conversations` 为空表示「只有存量主对话」：读取期由 `conversations_view` 惰性补位（`legacy: true`），只有在真正写入时才会物化落盘。

## 落盘与原子写

- 路径：`{state_dir}/echo-workspaces-{team_id}.json`，`state_dir` 来自 `[module.config]`，缺省 `$XDG_CONFIG_HOME/echo-agent-core`
- 读：`WorkspaceStore::load` 对缺失或损坏的文件返回**空文档**，不阻断启动
- 写：`WorkspaceStore` 的保存走 `tmp + rename`（先写 `*.json.tmp`、成功后 `rename`），失败时删掉临时文件——不留半成品误导下一次写入
- 提交语义：需要「落盘成功才提交」的操作（如删除对话入口）先在文档副本上改完并落盘，成功后才替换内存；失败时内存与磁盘都没变
- 进程级注册表：同一文档路径在进程内只对应一个 `Arc<WorkspaceStore>`（弱引用登记），避免同一文件存在多份内存副本互相覆盖

## 共享 store 与变更钩子

每个 persona 有自己的模块实例（`PersonaScope` 用目录工厂重建一批），而 `store(team_id)` 的 `team_id` 来自命令载荷、对任意 team 都合法——跨人格目录选择器与 `all_stores` 正是这么用的。因此：

- `ModuleState::store` 按 `team_id` 缓存，所有实例解析到**同一个** `Arc<WorkspaceStore>`
- 变更钩子按实例分槽（`upsert_on_change(hook_id, …)`）：单槽会让后注册者顶掉前者，被顶掉那层再也收不到 `workspace.changed`
- 钩子持 `Weak<ModuleState>`（`attach_self`）：否则 `state → store → hook → state` 形成强引用环，模块卸载后永不释放

钩子在 store 写锁之外触发，回调里可以安全回读快照并组装 `workspace.changed`。

## 通道身份与退役

工作区对话的会话通道 id 由 `(工作区 id, 对话 id)` 派生：

| 形态 | 通道 id | 说明 |
|---|---|---|
| 带对话 | `local:workspace:<ws>/<conv>:<user>` | 多对话的标准形态 |
| 存量裸通道 | `local:workspace:<ws>:<user>` | `legacy: true`，等价于该工作区的默认对话 |

- `channel_scope_id(ws, conv)` 生成 scope，`parse_workspace_channel(session_id)` 反向解析（解析失败返回 `None`，调用方按「非工作区通道」跳过）
- `retired_channels` 记录被删除入口的对话通道：入口删掉但历史保留，若允许新对话复用同一 id / 同一裸通道，新对话的消息会落进被删对话的 append-only 历史里。因此删除入口时登记通道，自动生成对话 id 时跳过它们
- 两条删除路径语义**不同、不可混用**：`delete_conversation` 是旧路径（触发宿主清历史），`delete_conversation_entry` 是默认路径（只删入口、幂等、拒绝删除最后一条、落盘成功才提交）

## 提示词块

`prompt.rs::render_prompt_text` 是唯一实现，`prompt_text`（全局 active）与 `prompt_text_for`（按会话解析）共用——两处拼装同一段文案必然漂移，而这段文案直接决定模型看到的项目上下文。

- 有 `session_id` 时优先按**本次 turn 的会话**解析，回退全局 active：否则 A 窗口激活工作区后，B 窗口在自己通道里发消息会被注入 A 的工作区上下文（多窗口串台）
- 远程目录渲染为 `- node://<peer>/<绝对路径> [remote:<peer>]`，并说明文件工具用 `path` 前缀、`bash` 用命令前缀可直接在对端操作
- 无目录时输出「尚未配置工作区目录，可用 workspace 工具或面板添加」，而不是留空
