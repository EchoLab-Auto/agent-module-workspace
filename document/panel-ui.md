---
id: panel-ui
title: "Panel UI 扩展"
group: 前端
x: 1920
y: 240
---

# Panel UI 扩展

> **定位**：`panel-ui/` 这个前端扩展包——它向 Panel 壳注册了什么、边栏三张卡与主面板各做什么、状态层如何归约事件、多窗口下激活如何决策。Panel 壳只提供布置 UI 的接口与通用身份（`activeRegion` / `activeTeamId`），工作区的领域数据全部在这里。读者：改工作区界面、写其他 Panel 扩展、或排查「卡片不刷新 / 激活被别的窗口抢走」的人。

## 扩展注册面

入口 `panel-ui/index.ts` 用 `definePanelExtension` 声明，`id = echo-agent.workspace`（与后端模块 id 同名）：

| 面 | 内容 |
|---|---|
| `railCardSlots` | `['files', 'git']`——允许这两张卡被用户拖到左右边栏 |
| `entries` | 一条「工作区」入口（图标 `folder`），`when` 命中时出现，`prefetch` 预热会话列表 |
| `overlays` | 工作区会话弹层 → `WorkspacePanel` |
| `railCards(teamId)` | 文件浏览器卡 + Git 状态卡（均随激活工作区出现） |
| hooks | `setup` / `teamLanding` / `acceptEvent` / `toolPresentation` / `sessionPresentation` / `canConfigureSessionApi` / `beforeSessionPick` |

门控只有一条：`available(teamId)` = 该人格 `teamModuleEnabled(team, 'echo-agent.workspace')` **且** `teamToolAvailable(team, 'workspace')`。前端是独立部署选择——模块未挂载时整块入口消失，而不是点进去报错。

## 边栏卡片

| 卡片 | 组件 | 内容 |
|---|---|---|
| 文件浏览器 | `WorkspaceFilesRail` → `WorkspaceFileBrowser` | 限会话已声明目录及其子孙（canonical 前缀校验在后端） |
| Git 状态 | `WorkspaceGitCard` → `WorkspaceGitDir` | 每目录一行：分支 + 领先落后 + 冲突角标 + 三类变更计数；点击展开类别开关、过滤框、父目录、最近提交 |

Git 卡的计数是**各目录 staged + modified + untracked 之和**（`railCards` 里聚合），即边栏标题上的徽标。展开后计数本身是开关：点「已修改 4」列出那 4 个文件及 porcelain 状态字符。变更 ≤ 6 个文件的目录展开后自动铺开，再多只留计数。

**多目录的一屏效率**：顶部一句汇总（几仓库 / 多少变更 / 几个冲突）+「只看变更」开关，把干净的仓库暂时收起；非仓库 / 读失败的行永远保留（那是错误，不是「没改动」）。明细超过 8 条时出现过滤框，按路径子串过滤已铺开的行（不改计数）。

**最近提交时间与 stash**：展开块的附加信息行显示提交的相对时间（`3 小时前`，精确 ISO 时间在悬停提示里）与 stash 条数（行上是描边角标 `⚑N`）。两者都是**有则显示、无则留空**——老 Core 不发这两列、或仓库还没有提交时，不显示，也不显示假值。协议字段是 `last_commit_time`（RFC 3339）与 `stash`（`git stash list` 行数），由模块 `git.rs` 采集（提交时间与摘要同一次 `log` 取出，stash 只数条数、不读内容）。

**只刷新一个目录**：展开块的刷新图标发 `RequestWorkspaceGitStatus` 时带 `directories: [该目录]`，模块只采这几个目录——改完一个仓库不该让其余四个也各跑 5-6 条 git 子进程。字段缺省 = 全部目录（整卡刷新不发这个字段，老 Core 照旧可用）；过滤里写了不在会话中的路径由模块忽略而不报错（它要的是"少采几个"，不是"必须是这些"）。

**两个刷新入口都是图标**（2026-11）：整卡用 `NeumorphismButton`（`refresh` 图标 + 内建 spinner，忙碌时按钮自带旋转且内容隐藏），单目录用 `.wgc-refresh` 里的 `PanelIcon` + 自转动画。文字撤掉后**语义必须落在 aria 上**：`aria-label`（「刷新 git 状态」/「只刷新这个目录的 git 状态」）+ 忙碌态 `aria-busy` / `aria-disabled`，`title` 仍给悬停解释——测试因此断言 aria 而不是可见文本。

纯计算（归类 / 计数 / 路径裁剪 / 相对时间）在 `git-changes.ts`，展开态（行展开 + 类别开关）在 `git-expansion.ts`，两者各自单测；组件只剩取数与版面，`WorkspaceGitDir.vue` 负责单目录的行与明细（含「刷新」与忙碌态）。行与 chip 都是 `role="button"` + `aria-expanded`，Enter / Space 等价于点击。

**不轮询**：挂载 / 切换工作区会话 / 重连时发 `RequestWorkspaceGitStatus`（必须带 `team_id`，否则 Core 路由到默认 agent），其余靠刷新按钮。git 状态只在主动改代码后变，定时拉会把 `git status` 变成常驻后台开销（工作区目录可能是跨机节点）。整个扩展没有 `setInterval`；超时收敛全靠 `setTimeout`（删除 7s——比组件的 8s 早 1s，好先给出模块语义文案）。

## 主面板

`WorkspacePanel.vue` 是工作区管理与对话入口，自上而下：

- 会话管理：列表、「新建 / 编辑」表单、首屏骨架
- 加载 / 慢 / 超时重试放在**列表之前**——状态先于内容，避免用户以为列表为空
- 会话卡片上的对话管理：点选 = 切换激活对话；删除只删入口（聊天历史保留，`workspace.deleteConversation`）
- 目录选择器：浏览本机与联邦节点目录树，选中的远端目录以 `node://` 形式回填

会话级 API 覆盖的入口也在这里：`canConfigureSessionApi` 只对工作区通道返回 true。

## 状态与事件流

`workspace-store.ts` 持有投影（`workspace` 是**普通对象**，不是响应式；组件依赖 `workspaceRevision` 版本号驱动重算）：

| 字段 | 来源 |
|---|---|
| `sessions` / `active` / `activeConversation` / `teamId` / `core` / `generation` | `WorkspaceSessions` 归约（`applySessions`） |
| `gitBySession` | `WorkspaceGitStatus` 按 `(core, session)` 键缓存 |
| `files` | `WorkspaceFiles` 按 `(core, path)` 键缓存 |

归约规则：

1. **过滤别的 core**：响应属于当前运行区域才接受，重连 / 切 core 后到达的旧响应不能覆盖新鲜列表
2. **过滤别的 persona**：store 是 per-persona 的，而 `WorkspaceSessions` 经进程级 EventSink 广播给所有 Panel 连接；不过滤时另一个窗口（或模型用 `use` 工具）激活工作区会覆盖本窗口的单槽。放行条件是 `team_id` 缺省（旧 Core 帧）或本端尚未确定 agent
3. **拒绝旧快照**：`generation` 只增，切 team / core 后迟到的列表不认
4. **边界**：`BrowseDirectories` 回执**不由本扩展归约**——目录浏览是壳的通用能力，落在壳的 `state.browseDirectories`，由 `DirectoryPicker` 读取

1. **过滤别的 core**：响应属于当前运行区域才接受，重连 / 切 core 后到达的旧响应不能覆盖新鲜列表
2. **过滤别的 persona**：store 是 per-persona 的，而 `WorkspaceSessions` 经进程级 EventSink 广播给所有 Panel 连接；不过滤时另一个窗口（或模型用 `use` 工具）激活工作区会覆盖本窗口的单槽。放行条件是 `team_id` 缺省（旧 Core 帧）或本端尚未确定 agent
3. **拒绝旧快照**：`generation` 只增，切 team / core 后迟到的列表不认

**卡片列表本身就是响应式消费者**：`railCards(teamId)` 是 `PanelSidebar` 里 `railCardsFor` computed 的数据源，而 `workspace` 不是响应式对象——不读 `workspaceRevision` 就等于「这张列表不依赖工作区数据」：首帧算出的空列表会被缓存，回包到达也不重算（表现为右栏只剩内置卡；过一会儿某个无关的 `state.*` 变化碰巧顶翻 computed 又自己冒出来）。回归测试 `panel-ui/tests/rail-cards-reactivity.test.ts` 钉住这条时序。

拉取时机由 `setup` 里的 watch 决定：连接状态 + teams + 当前人格变化 → `RequestWorkspaceSessions`。断连时作废未完成的删除请求并按新基线重置缓存（`resetCaches` / `resetConversationDeletes`）。

`acceptEvent` 是扩展的归约入口：命中工作区三帧或删除回执时返回 `false`（已消费，不进壳的通用 reducer），壳里没有工作区的字段。

## 多窗口与激活规则

激活是**全局单槽**，但每个窗口有自己的观察对象，串台的真实成本是「点一下就抢走别人的激活」：

- `noteLocalActivateIntent` / `takeLocalActivateIntent`：本窗口刚发出的激活意图先记账，广播回来时能认出「这是我干的」
- `decideOnWorkspaceBroadcast`：收到 `WorkspaceSessions` 时决定 `keep` 还是切到 `next`——自己发起的激活直接跟随；别人的激活不抢当前正在看的通道
- 卡片绑定对象先看 `state.windowSessionId`（本窗口在看哪个工作区），再退回全局 `active`：多窗口下卡片只反映「我这一格」

## 跨机呈现

- `directoryNode(dir)` 只认 `node://` 前缀，据此判断目录属于哪个对端；`directoryToInput` / `isRemoteDirectoryInput` 负责输入框与展示的规范形状
- 远端目录的 git / 文件结果由后端降级为占位条目（原因文本来自对端或「跨机查询未接线」），前端照常渲染该目录行与错误说明，不隐藏、不合并进本机结果
- 显示名用 `federatedPeerLabel` 转成人读的节点名；原始 `node://` 串只用于路径与识别
- 删除对话入口后，扩展侧也维护一份 `retired` 集合（按 `(core, team, workspace)` 作用域），只用于**新建对话的 id 避让**——不得用它过滤保存载荷，否则会把服务端已退役的对话写回
