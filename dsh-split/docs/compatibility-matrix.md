# W002 · 正式扩展契约盘点与缺口（定稿）

**冻结基线**：`DSH-SPLIT-V5-FROZEN-20261015`　**宿主**：`dsh 0.2.0-rc.2`
**相关冻结规则**：F02、F03、F07、F09、F12、F13、F15
**状态**：静态核对完成（六类边界 + 横切项均有 `文件:行号` 证据）；**运行时确认待 W003/W004 探针**。
**口径**：只读核对安装产物副本 `E:/wyx_code/_v5-frozen/host-rc2/`（28 个包）。未运行原生代码、未修改任何原生文件。
W002 步骤 4 排除的伪扩展面（DOM 注入、抢同名 Slot、私有 import、运行时劫持）一律不计入「可用」。
分区证据原文：`E:/wyx_code/_v5-frozen/evidence/w002-main-host.md`、`w002-sidebar.md`、`w002-commands-attachments.md`、`w005-dockview-offline.md`。

## 1. 结论总表

| # | 边界 | 判定 | 关键证据 | 影响面 |
| --- | --- | --- | --- | --- |
| 1 | 主内容宿主：一个生效宿主 + 全局面板仍正常 | **可用（有副作用）+ 需改原生（组合）** | `ui-layout/lib/client.js:117-119`（`entryKey = activePanelId ?? "conversation"`，keyed 槽查表）、`:388`、`renderer:1154-1156` | 注册自建 `main` key + `selectPanel(key)` 即可让原生呈现 **unmount**（不是 CSS 隐藏）；但原生 Header 一并消失、原生右栏转 hidden → 方案 §05.2 区域 1 |
| 2 | 唯一编辑根 | **宿主无约束（缺失）+ 插件纪律可满足** | `ui-conversation/README.zh.md:57`（明确不支持同 Session 多可编辑 root）；`conversation/lib/client.js:9273-9288`+`:8959-8988`（Lexical 清空旧 root 并搬家，**不抛错**）；`:13512-13523`、`:16552-16561`（无计数、单槽覆盖） | F12 没有宿主级检测/租约；第二个 occurrence 会**静默把编辑器 DOM 从第一处搬走** → 必须由「唯一根」纪律保证（探针 W003-b 取证） |
| 3 | 原生 Header / View / Composer 按会话嵌入 | **正文+View+Composer 可用；原生 Header 缺失** | `ui-conversation/README.zh.md:63`（header 在 factory 外，`main.conversation` 独占）、`:16018-16026`、`:18145-18148`；嵌入式 occurrence：`:16215-16216`、`renderer:1040-1050` | F15 可纯插件达成（不替换 `views` 即得原生 View/Composer/附件/审批）；每格标题条**自绘**（v5 已定）。⚠ 同会话两 occurrence 共享 `dsh.conversation.<sessionId>`（View 选择/草稿）：每 pane 独立 View 需改原生（`conversation:3164-3198`、`renderer:1700-1703`） |
| 4 | 两套 Sidebar 分别绑定不同会话且同时可见 | **需改原生（P0 阻断项）** | `sidebar-right/lib/client.js:9138-9149`（`rightbar` 是 **single/root**，只渲染一次）、`:5873-5880`（`visible = activePanelId === null`）、`:9029-9045`（前台 = 全局 `uiSession.adapter.current`）、`README.zh.md:61`（只有前台子树上报列宽，其余 hidden） | 每会话「分座」已成立（store/布局/标签/终端持有：`:4955,4997-5001,5389-5401,9095-9108`），但**同时可见面恒为 0 或 1**；补丁点 = `ui-sidebar-right` 内容与 frame 呈现分离 + `ui-layout` 允许会话内宿主且不占右轨（方案 §05.2 区域 3） |
| 5 | 左侧会话行菜单（F09 唯一分屏入口） | **可用** | `ui-workspace/README.zh.md:98,100,134,153,163`（`sidebar.workspaces.session.menu.item` / `…row.action`，条目只收 `{sessionId, displayTitle}`，必须 `ctx.slots.inject()`） | 目标会话(B)由席位给出；**锚点会话(A)由插件捕获**（`ctx.uiSession.adapter.current.getSnapshot().key`，`ui-session:167-172`），并用 `commandTarget()`+`isTargetCurrent()` 式复核防漂移（`sidebar-right:6537-6563,6615-6624`） |
| 6 | 附件与命令只命中所属会话 | **上传可用 / 接收端需改原生；命令面需改原生或自律** | `file-upload/README.zh.md:28,45,59`（`upload(sessionId,…)`，凭证唯一归属）；`ui-attachment/lib/client.js:539-590`（**document** 级 drop，每挂载视图一份）、`:568-577`（不看落点、**不看 `defaultPrevented`**）、`:621-623`；`shortcuts/lib/client.js:588-612`、`:660-709`（注册与上下文**无 session 维度**） | N12：两个 composer 同时挂载时一次放下会进两个 intake → 必须改原生（命中判定 + 尊重 `defaultPrevented`，或把 intake 提升为带 session 参数的服务）；可用旁路：`conversation.createDrafts(sessionId, files)` + 该会话 `inputActions.addAttachments`（`conversation:3477-3494`、`:13475`、`:13555`） |

## 2. 逐项详述

### 2.1 主内容宿主（边界 1）

- 中间列是**键位槽查表**：`entryKey = activePanelId ?? "conversation"`（`ui-layout/lib/client.js:117-119`）；key 不存在时中间列为空（`renderer:1155`）。
- 因此「关掉原生呈现」有**公开路径**：`ctx.slots.register({ name: 'main', key })` + `ctx.layout.selectPanel(key)`；原生 conversation entry 被 React **卸载**，符合方案 §06「隐藏仍挂载也算一份」。
- 两个未成文副作用：① 原生 Header（会话标题/菜单/右上角控件）随宿主一起消失；② 原生右栏显示条件 `visible = activePanelId === null`（`sidebar-right:5873-5880`）→ 右栏转 hidden，**直接违反 F03**。
- 插件侧**替换**主宿主不可行：keyed 槽同 key 二次注册抛错（`slots/lib/index.js:175-178`），`conversation` 是保留 key（`ui-layout/README.zh.md:32`）。
- **P-1 的两条新证据（本轮静态定位，替代原先"找不到写方"的悬置）**：
  1. **保活跟随导航，不跟随面板选中**：`ui-workspace/lib/client.js:971-994` 的 `replaceMain()` 用 `sessions.retain(target, { source: 'mainView' })`（`:973`）持有 `mainReference`（`:991`），换会话时释放旧的（`:992`）。因此选中插件的 `main` 键位**不会**让 `retainedBy.mainView` 归零 → **P-1 无需改保活**（探针动作 2 只作确认）。
  2. **`reveal` 导航会强制 `selectPanel(null)`**：同一函数 `:993`（`if (panel === "reveal") this.ctx.layout.selectPanel(null)`），`clearMain()` 同样在 `:969`。→ 一旦插件占用 `main` 键位，**用户点侧栏会话/清空当前会话就会被踢回原生会话面板**。这是 F02/F09 的硬冲突，必须进 P-1 范围（把"呈现宿主归属"与"当前会话导航"解耦）。

### 2.2 唯一编辑根（边界 2）

- **一手代码证据**（本轮亲自核对）：`ui-conversation/lib/client.js:16538-16574` 的 `ComposerContentEditable` 用
  `useLayoutEffect` 安装 `editor.setRootElement(el)`（`:16557`）、卸载时 `setRootElement(null)`（`:16559`）；
  Lexical 的 `setRootElement` 实现（`:9273-9288`）会把 `_rootElement` 指向新元素、`setAttribute('data-lexical-editor','true')`（`:9279`）
  并**解绑旧 root**。→ 任何时刻**只有一个** `[data-lexical-editor="true"]` 元素（应用自己也在 `:9849` 这样查询）。
- **两个推论（比"搬走"更尖锐）**：① 第二份呈现挂载 = 静默夺走 composer，第一处留下一个 `contenteditable` 属性还在、但**已无编辑器绑定**的空壳（正是之前"提示词不消失、消息发不出去"的现象）；② **卸载第二份并不会让第一处自动夺回** —— 它的 effect 依赖 `[editor]` 不变，不会重跑，只有**重挂**才恢复。→ F12 的唯一根纪律是硬要求，且插件**绝不能**为了省事"挂一份只读镜像"。
- 后果：F12 是**设计纪律**（每个 Session 一个可编辑呈现根），不是运行时保证；「同会话只读镜像」也无正式面（composer 由 content factory 无条件渲染，`conversation.view` 第三方不可渲染：`:16301-16328`、`renderer:326-343`）。
- 旧实现的「覆盖层 + generation 抢回编辑器 + 双 bump」正是方案 §05.1 点名要**消除**的补偿机制：不继承。

### 2.3 Header / View / Composer（边界 3）

- `main.conversation` 外壳把常驻 `conversation.header` 放在 `conversation.content` Factory **之外**；Factory 拥有共享正文与 Composer，并公开 strict-Session `views` 与 root-scoped `widthControls`（`ui-conversation/README.zh.md:63`）。
- **嵌入式 occurrence** 是官方留的缝：可替换 `views`、省略宽度拖拽条、不渲染主 Header（同上）；`variant:'embedded'` 有 CSS 一等支持，但**冻结集内没有官方调用方**（探针 W003-b 会实测）。
- 可追加但不独占：`conversation.session.header.actions` / `.utilities`（list/session，`conversation:18268-18275`）。
- 不可占：`conversation.session.header.corner` 等 single 席位已被 `sidebar-right` 的 ExpandButton 占用（`conversation:18276-18279`、`sidebar-right:9187-9192`）——**v5 的显隐入口正是复用它，勿抢**（F07 后半原生已有）。
- 同会话两 occurrence 共享 `dsh.conversation.<sessionId>`（View 选择、草稿）：每 pane 独立 View 需改原生。

### 2.4 每会话 Sidebar（边界 4）

- **一手代码（本轮亲自核对）**：`RightbarRoot`（`client.js:5873-5880`）对**每个被跟踪的会话视图**各渲染一个 `SessionView`，可见性 `active = visible && view.selected`，其中 `visible = usePanelInfo((info) => info.activePanelId === null)` 是**全局门**；`SessionView`（`:5849-5866`）为每个会话建自己的 `SessionProvider` + `renderSlot('rightbar.session', { width, viewportWidth, canShow, active, retainTab })`，并打上 `data-sidebar-right-session={sessionId}`、`hidden={!active}`。
- **席位结构**：`rightbar` 是 **single/root**（`:9138-9149`，只渲染一次）；其子槽 `rightbar.session` 为 `single + scope:'session'`，注册时即带 `store` 与 `inject(sessionId)`（`:9150-9185`）→ **逐会话分座早已成立**。
- **结论修正（比"内容与 frame 分离"更精确）**：缺的不是"每会话内容"，而是三件小事——① **同时可见**（去掉全局门，让宿主自决）；② **逐宿主几何**（`width/viewportWidth/canShow` 现来自帧右轨）；③ **任意宿主可承载**某会话的 Sidebar（现由 root 席位独占渲染）。
  已经存在、**不得重做**：逐会话子树与 provider、逐会话 store（`dsh.sidebar-right.v1.<sessionId>`）、Tab 域/occurrence、`keepMounted` 保活、关闭 handler 语义、资源持有。
- 每会话状态已完备且独立：布局/标签/选中/分栏比例/浮窗/身份计数存 `dsh.sidebar-right.v1.<sessionId>`（`:9095-9108`）；`keepMounted` 正文在切 tab/切会话/收起期间保留（`:5519-5528`、`README.zh.md:106`）；`openTabs` 发布全部会话的标签元数据（`:6187-6236`）。
- **F13 原生语义正确（可用）**：关闭 handler 唯一调用点是显式关闭/替换（`:6439-6442`，调用者 `:6435`、`:6488`）；折叠只写布局（`:5247-5251`、`:6515-6519`）；插件卸载不调用（`README.zh.md:108`）。
  ⚠ 补丁不得改坏的断言点：`tab.visible` 公式依赖全局 `active`（`:8982`）——若后台会话 Sidebar 真正可见而 `active` 仍按全局 current 传参，终端尺寸测量与浏览器 keepMounted 会误判。
- 停靠面只支持 **push / fullscreen**（`:4951`），停靠分栏只接受 `axis === "row"`（`:4976`），`split()` 只向右（`:6652-6673`）；**左/上/下停靠没有原生契约**（`layout:595-627` 的 root 席位只有 sidebar/main/rightbar/shell.overlay/shell.leading）→ F03 的四边停靠是新做。
- 视觉项（F07/V02）：标题右上两个控件画在 `sidebar-right:5628-5661`（PanelChrome 的 iconButton×2），经 chrome 席位 `:5703-5709` 挂载，**没有可摘的席位**（`README.zh.md:88` 明说没有面向折叠态控件的席位）→ 需改原生。
- 阴影/细边框（F08）：`sidebar-right:5409` 的 `.panel` 无 border/box-shadow；`dockkit` 不是独立 npm 包（代码内联在客户端 bundle 里）。
  **结论调整**：既然 P-2 要把 Sidebar 的呈现宿主改为「每会话一个由我们持有的宿主」，面板外壳的边框与静态阴影就由我们的 token 自绘（方案 §02 已给出浅色阴影取值），**不再依赖 shipped 面板的令牌** → F08 从「未验证的补丁项」降级为「P-2 内的视觉实现」，仅在补丁保留原面板时才是补丁项。

### 2.5 左侧会话行菜单（边界 5）

- 席位：`sidebar.workspaces.session.menu.item`（“…”菜单）+ `sidebar.workspaces.session.row.action`（行尾悬停），都是 WorkspaceBrowser 声明的 **list** 子槽（`ui-workspace/README.zh.md:98`）；条目只收 `{ sessionId, displayTitle }`（`:100`）；注册必须 `ctx.slots.inject()`（`:163`）。
- 锚点会话（F09 的 A）：`ctx.uiSession.adapter.current.getSnapshot().key`（`ui-session:167-172`）或 `ctx.layout.panelInfo`；捕获后必须复核（`commandTarget()`/`isTargetCurrent()` 形态，`sidebar-right:6537-6563,6615-6624`）。
- 「打开菜单不导航」= 不调 `openResource`/`openTab`（`sidebar-right:6443-6447` 即菜单自身的行为边界）。

### 2.6 附件与命令（边界 6）

- 上传是**按 Session 寻址**的公开 API（`file-upload/README.zh.md:28,45,59`）✔。
- 接收端没有 broker：`ui-attachment` 在 **document** 上监听 dragenter/dragover/dragleave/drop（`:539-590`），每个已挂载视图各装一份（`:621-623`），命中判定不看落点、也不看 `defaultPrevented`（`:568-577`）→ 两个 composer 同时挂载时一次放下进两处（**N12 直接失败**）。
- 可用旁路（不改原生时的自律路径）：外层在捕获阶段 `stopPropagation()`，再走 `conversation.createDrafts(sessionId, files)`（`conversation:3477-3494`）或该会话 `inputActions.addAttachments`（`:13475`、`:13555`）；但**只有当原生 intake 被正确拦下才成立**，需探针实测。
- 命令面**分两层**（W002-C 复核后的修正）：
  - **快捷键注册没有 session 维度**：`{id,label,aliases,defaults,regions,modals,resolve}`（`shortcuts:588-612`），dispatch 上下文只有 `{region,modal,target}`（`:660-709`、`:784-788`），持久化按 `runtime:platform`、键 `dsh.keybindings.v1`（`protocol.js:169-178`、`:846`）。
  - **`ctx.commandUi` 有会话级命令目录**：业务包注册 popupSelect / action，「空格与回车**根据会话目录**解析命令行」，`CommandDirectory` 负责会话级协议缓存（`ui-commands/README.zh.md:2,12,28,58`）→ 斜杠命令的会话归属可以做到**纯插件**表达 ✔。
  - 会话级"命令→会话"的其余手段：`commandUi.available(session)/run(session)`（消费侧 `conversation:18111-18125`）+ `inputTriggers.sessionOf(scope)`（`ui-input-trigger:929-952`）。
- **N13 真冲突**：`observeFixedInput` 按注册插入序派发（`shortcuts:1917-1942`）；插件 Esc 观察者若早于 ui-conversation 的停止观察者注册并 consume，会静默压掉原生双 Esc 停止（`conversation:17816-17885`、`:18090-18107`）。安全窗口 = 落点不在 `[data-conversation-region]` 内，且不得用可编辑命令绑裸 Esc（`protocol.js:203-221` 将裸 Esc 列为 reserved）。

## 3. 与方案 §05.2 的对照 → W006 补丁清单

| # | 补丁 | 位置 | 冻结规则 | 影响面 |
| --- | --- | --- | --- | --- |
| P-1 | 唯一生效主内容宿主：面板选中态与右栏可见性**解耦**；自建宿主期间 `retainedBy.mainView` 保持持有；原生关闭呈现但服务继续 | `ui-layout`（`panelInfo`/右栏条件/轨道报告）× Conversation 宿主组合 | F02、F03、F12 | 触及 `activePanelId` 语义与右栏 `visible` 判定；不改 Agent/服务端协议 |
| P-2 | Sidebar 内容与 frame 呈现分离：每会话独立可见宿主（会话面板内嵌 + 尺寸/可见性显式绑定），并移除标题栏两个控件 | `ui-sidebar-right`（`rightbar` single/root → 多宿主；PanelChrome×2）；`ui-layout` 允许会话内宿主 | F03、F07、F08 | 触碰 `tab.visible` 公式（`:8982`）与终端尺寸测量；不得改 provider/终端 controller |
| P-3 | 一次拖放只命中所属会话 | `ui-attachment` 命中判定 + 尊重 `defaultPrevented`（或把 intake 提升为带 session 参数的服务） | F15、N12 | 只改接收端；不得重做上传/审批路径 |
| A-1 | （适配，非补丁）命令与快捷键的会话归属 | 插件侧：`commandUi.available/run` + `inputTriggers.sessionOf` + 捕获身份复核；Esc 观察者注册顺序让位 | F12、N13 | 不改原生，但需写下顺序与作用域纪律 |

全部落在方案 §05.2 预列范围；**未获授权前不实施任何原生改动**。

## 4. 待运行时确认（探针已就绪）

探针包 `probe/`（已挂进 profile，重启后生效）按下列映射取证：

| 探针动作 | 回答的问题 | 对应冻结项 |
| --- | --- | --- |
| 1 能力发现 | 真实服务面（`ctx.sidebarRight.*`、`ctx.uiSession.adapter.current`、`retainInfo`、会话数） | W002 静态结论的运行时校验 |
| 2 切到自建主面板 | 自建 `main` key 是否真的卸载原生呈现；**`retainedBy.mainView` 是否仍持有**；右栏是否 hidden；可编辑 root 数 | 边界 1、2；P-1 的判据 |
| 3 挂第二份呈现 | `conversation.content` embedded 是否渲染成功；原生编辑根是否被搬走（节点身份）；两份 root 数 | 边界 2、3；F12 |
| 4 卸下并还原 | 卸载后原生编辑根是否回位；引用释放 | F12、生命周期 |
| 5 Sidebar 切换 | 切会话时 `[data-sidebar-right-session]` 数量与 hidden 变化；展开态是否保持 | 边界 4；P-2 的判据 |

## 5. 材料与未验证

- **已补齐**（本次抽取，共 30 包）：`ui-workspace`（含行菜单席位）、`ui-dockkit` 相关者不独立成包、`ui-primitives`、`ui-commands`、`ui-settings`、`api-terminal-controller`、`client-resources`、`client-locale`、`ui-theme`、`dsh-web-frontend`、`dsh-web-app`。
- **`dockkit` 的归属已定界**：它不是独立 npm 包，而是**内联在 `dsh-client-ui-sidebar-right/lib/client.js`**（该 bundle 内 `dockkit` 命中 68 处；`sidebar-browser`/`sidebar-terminal` 各 1 处）。对补丁的含义：P-2 的补丁面就是 `ui-sidebar-right` 自身（含其内部 dockkit 装配）+ `ui-layout`，不存在"另一个待补丁的 dockkit 包"。
- **未验证清单**（不得当作已完成）：`retainedBy.mainView` 写方；embedded occurrence 的真实渲染；两 occurrence 的编辑根归属；`ui-attachment` 拦断可行性；`sidebarRight.mounted` 在自建主面板下的取值；dockkit chrome 的边框/阴影来源；`commandUi` provider（`ui-commands` 已补抽，待读）。
