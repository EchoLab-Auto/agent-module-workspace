---
id: remote
title: "跨机目录"
group: 后端
x: 1280
y: 560
---

# 跨机目录

> **定位**：`node://<peer>/<path>` 目录的三类只读查询——谁声明契约、谁实现、失败如何降级。覆盖「接缝为什么在本模块而不在 Core」这条与包级循环依赖直接相关的取舍。命令入口见[命令域与工具](./commands.md)，前端如何显示远端占位见[Panel UI 扩展](./panel-ui.md)。读者：多机部署的维护者、改远程采集行为的人。

## 接缝归属

工作区目录可以是 `node://<peer>/<path>`——**对端机器**上的目录。查它的 git 状态、列文件、浏览子目录都要问到对端，而那份传输属宿主的联邦子系统。三方关系：

| 角色 | 谁 | 需要什么 |
|---|---|---|
| 声明（消费方） | 本模块 `remote.rs::RemoteWorkspaceQuery` | 「我要问这三个问题」 |
| 实现方 | 组合根（把联邦的 `RemoteQuerier` 适配过来） | 联邦 `QueryKind` |
| 取用 | 本模块 `mount` 时按服务键解析 | `REMOTE_QUERY` = `echo-agent.host.workspace.remote_query` |

trait 曾住在 Core 的 `echo-defs`，于是本仓**无法命名它**（不依赖 Core crate 是硬约束），三个远程能力只能全部降级成「不可采集」，而可对端的执行端与发送端早已齐全——缺的只是归属。语义（问 git / 问文件 / 问目录）本就属于消费方，契约因此回到本模块，宿主只负责实现与注入。

## 三种查询

`RemoteWorkspaceQuery` 的三个方法都是 `QueryFuture = Pin<Box<dyn Future<Output = Result<Value, String>> + Send>>`，载荷形状与对端 `handle_federation_query` 一一对应：

| 方法 | 对端 `QueryKind` | 成功载荷 |
|---|---|---|
| `git_status(peer, path)` | `WorkspaceGitStatus` | `{"git": WorkspaceGitInfo}` |
| `list_files(peer, path)` | `WorkspaceFiles` | `{"entries": [WorkspaceFileEntry]}` |
| `browse(peer, path)` | `BrowseDirectories` | `{"roots": [BrowseRoot], "entries": [...]}` |

句柄装箱一次（`RemoteQueryHandle = Arc<dyn RemoteWorkspaceQuery>`），`mount` 时填入 `ModuleState` 的槽位，多次查询共用。

## 降级策略

**未注入 = 降级**：单机部署 / 联邦关闭时服务键解析不到，远程目录显示「跨机查询未接线（宿主未注入联邦查询能力：单机部署属正常）」，本机功能零影响。

单目录三级降级（`commands.rs::remote_git_status`）：

| 情形 | 结果 |
|---|---|
| 接缝未注入 | 占位条目 + 未接线原因 |
| 查询失败（对端离线 / 未授权 / 沙箱拒绝 / 超时） | 占位条目 + 对端给的原因 |
| 载荷解析失败（对端版本不匹配） | 占位条目 + 解析错误 |

三级都只影响**这一个目录**：一个有问题的对端不该让同会话的本机目录也看不到。混合目录的采集是并行的——本机目录先 `spawn_blocking` 发车，再逐个 await 远程查询（典型只有 1–2 个远程目录，并发收益不抵多一个依赖 crate；对端离线时每个最多等联邦侧超时）。

## 路径规范

- 拆分：`split_node_path("node://gpu-box/srv/repo")` → `("gpu-box", "/srv/repo")`。第一个 `/` 之后是对端**绝对路径**，必须带前导 `/`（联邦查询的沙箱校验拿它做 `canonicalize`，相对路径一律拒绝），因此这里补回来而不是原样返回
- 还原：`join_node_path(peer, path)` → `node://<peer>/<path>`（`path` 带不带前导 `/` 都接受，`node://peer/` 的尾斜杠统一掉）
- 不是 `node://` 形式或 peer 为空时返回 `None`，调用方按「本机路径」处理——解析失败时不猜
- 对端回推的 `WorkspaceGitInfo.directory` 是**对端本机视角的绝对路径**，必须改写成本机视角的 `node://` 规范形状：面板按 `node://` 前缀识别所属节点，原样透传会让 git 卡片归错组
