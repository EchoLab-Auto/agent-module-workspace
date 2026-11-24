---
id: panel-ui
title: "Panel UI 扩展"
group: 前端
x: 1920
y: 240
---

# Panel UI 扩展

> **定位**：`panel-ui/` 这个前端扩展包——它向 Panel 壳注册了什么、边栏三张卡与主面板各做什么、状态层如何归约事件、多窗口下激活如何决策。Panel 壳只提供布置 UI 的接口与通用身份（`activeRegion` / `activeTeamId`），工作区的领域数据全部在这里。读者：改工作区界面、写其他 Panel 扩展、或排查「卡片不刷新 / 激活被别的窗口抢走」的人。

## 目录结构

两层判据：**一个子目录 = 一块界面**（组件、它专属的状态模块与单测就近放）；顶层平铺的只有**被多个面共用**的状态与纯计算。

```text
panel-ui/
├── index.ts                          注册入口（definePanelExtension）
├── components/
│   ├── sessions/                     工作区会话弹层（overlay）
│   │   ├── WorkspacePanel.vue        会话 / 对话管理主面板
│   │   ├── DirectoryPicker.vue       目录选择器（嵌入上者）
│   │   ├── use-session-json-form.ts  JSON 段的状态与规则
│   │   ├── workspace-json.ts         三种 JSON 形态的解析（纯函数）
│   │   └── tests/
│   ├── files/                        文件浏览器（rail card: files）
│   │   ├── WorkspaceFilesRail.vue    卡外壳
│   │   ├── WorkspaceFileBrowser.vue  树主体
│   │   └── tests/
│   └── git/                          git 状态（rail card: git）
│       ├── WorkspaceGitCard.vue      取数 / 汇总
│       ├── WorkspaceGitDir.vue       单目录行与明细
│       ├── git-expansion.ts          展开态（行展开 + 类别开关）
│       └── tests/
├── workspace.ts                      会话与通道 id 的纯函数 + 激活决策取证
├── workspace-store.ts                三帧事件的归约与缓存
├── workspace-conversation-delete.ts  删除回执配对
├── workspace-prefetch.ts             会话列表预热（index + sessions 共用）
├── git-changes.ts                    归类 / 计数 / 路径裁剪（纯计算，跨面共用）
└── tests/                            跨组件的行为与协议测试
```

**归位规则**（新增文件时按这个判断，不要回填到 `components/` 根）：

| 情况 | 放哪 |
|---|---|
| 只被一块界面用到（哪怕它没有 Vue 依赖） | 该面的子目录，与父组件同层 |
| 被两块以上界面或 `index.ts` 用到 | 顶层 |
| 纯计算但有跨面语义（如计数口径） | 顶层，便于两面共用同一份 |

`sessions/workspace-json.ts` 与 `git/git-expansion.ts` 是「只被一块界面用到」的例子——它们是纯函数 / composable，但只有对应面会调，所以跟着面走；反例是 `git-changes.ts`：它是纯计算，可文件浏览器的路径裁剪与 Git 卡的计数口径都要用，留在顶层。

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

Git 卡的计数是**各目录变更文件数之和**（`railCards` 里聚合，按文件去重），即边栏标题上的徽标。展开后计数本身是开关：点「已修改 4」列出那 4 个文件及 porcelain 状态字符。变更 ≤ 6 个文件的目录展开后自动铺开，再多只留计数。

**多目录的一屏效率**：顶部一句汇总（几仓库 / 多少变更 / 几个冲突）+「只看变更」开关，把干净的仓库暂时收起；非仓库 / 读失败的行永远保留（那是错误，不是「没改动」）。明细超过 8 条时出现过滤框，按路径子串过滤已铺开的行（不改计数）。

**最近提交时间与 stash**：展开块的附加信息行显示提交的相对时间（`3 小时前`，精确 ISO 时间在悬停提示里）与 stash 条数（行上是描边角标 `⚑N`）。两者都是**有则显示、无则留空**——老 Core 不发这两列、或仓库还没有提交时，不显示，也不显示假值。协议字段是 `last_commit_time`（RFC 3339）与 `stash`（`git stash list` 行数），由模块 `git.rs` 采集（提交时间与摘要同一次 `log` 取出，stash 只数条数、不读内容）。

**只刷新一个目录**：展开块的刷新图标发 `RequestWorkspaceGitStatus` 时带 `directories: [该目录]`，模块只采这几个目录——改完一个仓库不该让其余四个也各跑 5-6 条 git 子进程。字段缺省 = 全部目录（整卡刷新不发这个字段，老 Core 照旧可用）；过滤里写了不在会话中的路径由模块忽略而不报错（它要的是"少采几个"，不是"必须是这些"）。

**两个刷新入口都是图标**（2026-11）：整卡用 `NeumorphismButton`（`refresh` 图标 + 内建 spinner，忙碌时按钮自带旋转且内容隐藏），单目录用 `.wgc-refresh` 里的 `PanelIcon` + 自转动画。文字撤掉后**语义必须落在 aria 上**：`aria-label`（「刷新 git 状态」/「只刷新这个目录的 git 状态」）+ 忙碌态 `aria-busy` / `aria-disabled`，`title` 仍给悬停解释——测试因此断言 aria 而不是可见文本。

## 快照缓存与计数口径（2026-11 审计后的形状）

`WorkspaceGitStatus` 的缓存有两条必须遵守的规则，破坏任一条都会让用户看到**错的行**：

- **按目录合并，不整份替换**。单目录刷新的回包只含被采的那几个目录（见上），整份替换会把其余仓库的行一起抹掉，直到下一次整卡刷新才回来。合并后渲染时再按会话声明的目录顺序重排，并丢掉已不属于该会话的残留条目（合并语义不会主动删目录）。
- **键含人格**（`gitSessionKey(core, team, 工作区 id)`）。`WorkspaceGitStatus` 带 `team_id`，两个人格各有一个同 id 的工作区是常态；只按 `(core, session)` 存会让后到者覆盖前者（A 人格的卡显示 B 人格的分支与计数）。读侧与 `gitDirRevision` 都做「带人格 → 不带人格」两级回退，兼容旧 Core 的裸键回包。

计数只有**一个**口径（`changedCount`）：**变更文件数**，按文件去重。`MM`（暂存后又改）是一个文件，冲突（`UU` 等）也是一个文件——早前用 `staged + modified + untracked` 相加，把冲突算成 2 项，于是行上写「2」、旁边的冲突角标写「!1」。这个数字同时驱动行右侧计数、边栏徽标、顶部汇总、干净判定与「自动铺开」阈值。

明细（`changed_entries`）**不完整**时的降级规则：Core 的分列计数到上限（`ENTRY_CAP`）或整份明细缺失（老 Core / 跨机老对端）时无法去重，退回三列计数之和；`countOf` 的截断判据也取 Core 的**分列计数**而不是「本类明细条数」——后者会被冲突排除规则骗到（30 个 `UU` 占满 staged 列后，staged 类自己的明细数是 0，于是被当成没截断而报 0，整个「已暂存」chip 消失）。

**忙碌态按目录收敛**：每个目录最后一次被回包更新的序号记在 `workspace.gitRevByDir`，卡片只收掉「序号推进了」的那些目录。任意回包就清空全部会让「刷新 A 时 B 的回包把 A 的转圈收掉」。

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
