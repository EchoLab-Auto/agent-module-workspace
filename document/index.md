---
prodoc: true
id: index
title: "工作区会话模块"
group: 总览
x: 160
y: 40
link: ["module | 模块与宿主接缝", "panel-ui | Panel UI 扩展"]
---

# 工作区会话模块

> **定位**：`echo-agent.workspace` 模块（独立仓库 `agent-module-workspace`）的文档入口。工作区会话 = 用户从 Panel 管理的一组工作目录（创建 / 改名 / 删除 / 激活），可逐目录查看 `git status`、浏览文件、选择目录；激活会话的目录注入系统提示词，`workspace` 工具把会话与目录操作暴露给模型。本文只做导航与要点，机制细节在下列各篇。读者：改本模块行为、写 Panel 扩展、或排查「切了目录模型还在老地方干活」的开发者。

## 模块一览

| 层 | 内容 | 入口 |
|---|---|---|
| 模块与宿主 | 身份、为什么独立成仓、`mount` 接缝（配置 / 事件出口 / 跨机查询）、模块事件协议、门控 | [模块与宿主接缝](./module.md) |
| 数据与持久化 | 会话/目录/对话的线类型、per-persona 文档、原子写、共享 store、通道身份与退役 | [数据与持久化](./storage.md) |
| 命令与工具 | 面板 7 条命令、宿主内部 2 条、模块私有方法 2 条、`workspace` 工具的 6 个操作 | [命令域与工具](./commands.md) |
| 跨机 | `node://<peer>/<path>` 目录的三类查询、服务键归属、逐目录降级 | [跨机目录](./remote.md) |
| 前端扩展 | 边栏卡片、主面板、状态层与事件流、跨机呈现 | [Panel UI 扩展](./panel-ui.md) |

一句要点：**模块是唯一写者，宿主只读镜像**——store 落盘、模块事件都在模块里，会话通道注册与列表广播都在宿主侧。

## 阅读路径

- 第一次接触本模块 → 先读[模块与宿主接缝](./module.md)，那里回答「它贡献了什么、宿主怎么接」
- 要改持久化或数据模型 → [数据与持久化](./storage.md)（`WorkspaceDocument` 与 `retired_channels` 的语义都在那）
- 要加/改面板命令或工具操作 → [命令域与工具](./commands.md)
- 排查远程目录显示「不可采集」→ [跨机目录](./remote.md)
- 只关心界面 → [Panel UI 扩展](./panel-ui.md)

## 文档图

```prodoc-flow
graph LR
  Index[文档入口|/index.md]
  Module[模块与宿主接缝|/module.md]
  Storage[数据与持久化|/storage.md]
  Commands[命令域与工具|/commands.md]
  Remote[跨机目录|/remote.md]
  Panel[Panel UI 扩展|/panel-ui.md]

  Index --> Module
  Index --> Panel
  Module --> Storage
  Module --> Commands
  Module --> Remote
```

## 与宿主仓文档的关系

宿主仓 `EchoAgentCore` 的 `document/modules/workspace.md` 记录的是迁出前的形态；本模块迁出为独立仓库后，身份、命令清单与跨机能力都以本仓文档为准。宿主的会话通道、事件日志与联邦实现属宿主范围，本文档群只在必要处引用其契约，不复述其机制。
