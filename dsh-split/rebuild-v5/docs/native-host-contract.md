# v5 原生宿主契约与验证范围

本实现只读取冻结 v5 规格和 `E:/deepseek-harness/resources/app.asar`，没有读取或移植历史 dsh-split 实现。原始安装包版本为 `0.2.0-rc.2`，ASAR SHA-256 为 `983ca71114e6dfd353fc79af5a1f9481a250ee64c2a3c757673029b811b23bc2`。冻结规格指定的上游 commit 是 `639ed015397290b3745d163aafe02ffee4aa3f84`；包内版本已核实，不能仅凭版本号声称重新验证了 commit 对应源码。

用户已要求本机重构修复；本子任务制作候选原生补丁，不修改当前 ASAR、活动 profile 或重启进程。安装与切换由主任务的独立安装步骤负责。

## 原始接口证据

下表路径均相对 ASAR 的 `dsh/node_modules/@deepseek-ai/`；具体原文件 SHA、替换锚点 SHA/次数及候选 SHA 在 `host-patches/manifest.json`。

| 原始来源 | 查实的契约 | v5 使用方式 |
| --- | --- | --- |
| `dsh-client-ui-layout/lib/client.js` / MainPanel、LayoutController | `main` 是 keyed 根槽；`activePanelId:null` 表示会话区域 | 新增独占 conversationHost lease，只替换此区域渲染 key；设置等全局面板正常选择 |
| `dsh-client-ui-renderer/lib/client.js` / SlotRegistry、standardKit、scopeAreaProvider | `snapshot('factory:name')` 返回声明树数组；有 session child 时标准 props 包含 SessionProvider；每项都含 renderFactorySlot | 公开 snapshot 验证两项 factory 的名称与 scope，声明严格 session child，不使用私有 `_core` 或不存在的公开 factory() |
| `dsh-client-ui-session/lib/client.js` / bindingSource | Reference 的 binding 必须等于当前 Controller 的 `sessions.binding(sessionId)` | bridge 返回原始 ClientSessionReference 对象，保留 getter、ready、Symbol.dispose；只附加幂等释放联动 |
| `dsh-api-session-controller/lib/client.js` / ClientSessionReference | 原生引用持有、释放及 readiness 属于 Controller | `<SessionProvider session={reference}>`；内容与 Sidebar 同一 Provider 下两个固定区域 |
| `dsh-client-ui-conversation/lib/client.js` / ConversationRoot、ConversationHeader | 原生 Header + conversation.content factory，View 仍由原生注册表选择 | 新增 conversation.surface factory 包住原有根，保留 Header/View/Inspect；嵌入 Header 取消窗口拖动属性 |
| `dsh-client-ui-sidebar-right/lib/client.js` / SidebarSessionViews、RightbarSeat、TabDomain | SidebarView 引用、keepMounted、occurrence、Tab 导航和 close handler 已存在 | 新增嵌入引用 lease 和 sidebar.right.surface factory；原生命令捕获明确 session，原生右轨道让位 |
| `dsh-client-ui-workspace/lib/client.js` / replaceMain | 原生导航可能重复打开同一 Session，单看 current ID 变化会漏掉 | 成功提交后发布 `{revision,sessionId,reveal}`；A→A 也有事件；abort 不发布，后台恢复不切走全局面板 |
| `dsh-client-ui-attachment/lib/client.js` / installDocumentDropEvents | 每个 Composer 安装 document 级文件拖放监听 | 依真实事件目标的原生 `data-conversation-session` 判归属；编辑可用且可见才接收；同一事件只接受一次 |
| `dsh-web-frontend/dist/assets/index-5SrrfWpU.js` / 内置 SlotCore、DockLayout | DockLayout 按 tab.id 保留内容树；float 同内容树，菜单 portal 到 body | 仅作为验证输入，不修改 frontend asset；保留原生内部 Tab/两格/浮动逻辑 |

前端内置模块原文件 SHA-256：`af3ff948cf3f132edbddebea93e2f9f02233b390a94bd4c9842182300be811bb`。

## 对工作台的接口

`installNativeHost(ctx, Workbench, SessionPane)` 注册 `main[dsh-split.workbench]` 和严格 session 子槽 `dsh-split.session`。主组件得到原生标准 props 加 `bridge`，用原生 SessionProvider 包住子槽；SessionPane 使用标准 `renderFactorySlot`。这两个区域保持同一 React 树与同一 Session binding，换边仅改变工作台几何。

`renderNativeConversation(props)` 呈现原生完整会话；`renderNativeSidebar(props,{width,height,active})` 呈现原生 Sidebar。`active` 表示整个会话是否被投影显示，不能使用 `sidebar.open && visible`，否则收起后原生命令无法重新打开。Sidebar 收起仍保留组件，宽高可以为 0。

bridge 提供 `currentStore`、`catalogStore`、`getSummary`、`retain`、`focusSession`、`setCallbacks`、`notifyLayout`、`setSidebarExpanded`、`toggleSidebar`、`setSidebarFullscreen`。fullscreen 用原生 `actions.setMode(id,'fullscreen'|'push')`，收起用原生 `setExpanded`；二者是独立状态。嵌入 fullscreen 由本会话工作台几何呈现，不改变全局轨道。

菜单打开时冻结当前会话为 anchor；选择右/下分屏前再校验；取消不导航。布局变化通过 notifyLayout 更新 disabled 原因。明确打开会话由原生 navigationRequests 驱动，已显示会话可定位，关闭最后一格后同 A 仍可打开。

`storageScope` 只采用已查实字段：远程 Web origin/path + 原生 `connection.generation.host.home`。原版 rc.2 没有公开可靠 profile/server 唯一 ID；本机、loopback 或无法确认身份时使用临时 UUID，因此这些环境不承诺跨重载恢复几何。未创造 serverId/profileId 字段，也不落盘凭证或连接对象。

## 补丁边界与清理

12 个包：ui-layout、ui-workspace、ui-conversation、ui-sidebar-right、ui-attachment、ui-chat、ui-deliverables、ui-plan、ui-reference、ui-schedule、ui-skill、ui-subagent。后 7 个资源打开调用改用其现有闭包捕获的 sessionId；不在延迟执行时回读全局 current。

Sidebar 的原始 Store、registry、TabDomain、occurrence、provider、close handler 和终端 openTabs 持有不另建副本。每会话 face 绑定明确 adoption；adoption 失效时拒绝操作，不回退到当前会话。关闭快捷键没有合法原生目标时，不回退关闭应用窗口。

原生 float 的显示矩形在本会话中作只读投影；拖放首次位置从 viewport 换算到本 Sidebar，实际用户 move/resize 仍经原生 actions。仅布局移动/缩放不改写原生业务 Store。Windows float 保留原版 titlebar 安全顶距；极小尺寸和真实桌面拖动边界未完成平台验收。本期不新增 Tab 拆出、跨会话 Tab 迁移或浮窗功能。

native Tab strip 的窗口拖动 CSS 在嵌入范围覆盖为 no-drag；未修改系统标题栏。原生菜单与 Tooltip 的全局 portal 仍归原生管理。

dispose 清理布局/导航订阅、注册槽、菜单贡献和独占 lease；按引用释放策略交还原生持有，不调用关闭全部 Tab、停止 Agent、结束 PTY 或删除 Session。引用释放延后到微任务，给 React layout cleanup 留出解绑顺序。启用失败在 claim 之前检查版本与 factory；后续安装失败逆序释放已占有资源。无损热卸载、HMR 和实际 provider 回原生仍需真实端到端验收，当前只承诺受控重载安装流程。

## 可重现验证

运行 `node tools/native-patches.mjs <原始ASAR> <rebuild-v5/host-patches绝对路径>`；输出目录必须是本候选 host-patches。脚本先校验 ASAR SHA、版本、各成员 SHA、每个精确锚点次数和完整 bundle 语法，再输出候选文件。它不能修改 live 目录；不同基线或重复补丁会拒绝。

原生测试：

- `tests/native-contract.test.mjs`：12 个原始输入的 SHA/锚点/完整 bundle 语法；原生布局 lease；成功/重复/取消导航；原生 Sidebar 引用持有与明确目标；同一 document drop 只接收一次且保留目录数据。
- `tests/native-host.test.mjs`：编译并执行 fresh host.ts，配合原版 SlotCore、SlotRegistry、ClientSessionReference、SessionProvider 函数和 UiWorkspaceService。验证严格 child、真实 ref/binding、snapshot 返回形状、A→A、设置保持、缺 factory 拒绝、释放与订阅清理。外部连接与 Cordis 生命周期使用受限 stub。
- `tests/native-sidebar-mount.test.mjs`：在 ReactDOM/jsdom 中运行实际补丁 RightbarSeat、SidebarPanel 和原版内置 DockLayout。选中 Tab 显示→收起/0 尺寸→恢复，body/iframe DOM 身份与 textarea 未提交中文草稿保持；mount=1、unmount=0、close=0；最终卸载只 unmount，不执行 Tab close。Tab provider 内容为明确标注的 probe，不能替代真实 terminal/browser transport 验证。

以上不是完整原生端到端通过声明。中文 IME、真实并行输出、审批、桌面文件路径上传、真实 PTY 运行/失败重试、原生浏览器 transport、代表性第三方 provider、浮动拖动平台边界、重载/停用后的输入恢复与性能仍需要原生验收。冻结 N01–N21/V01–V03 不能据此全部勾为完成。

## 逆向工具证据

使用 reverse-engineer-anything skill。REA MCP 未注册，`rea doctor --client codex --json` 仅检查并报告该状态，未修改客户端配置；随后用现有 REA CLI 对原始 ASAR 中 layout、session、sidebar-right、conversation、attachment 的 5 个选定 bundle 执行 inert JavaScript 静态分析。证据 ID：`ev_c922f3f8678634d0de6d5faee9f21884a0673235f243261ed49a387b6a919cc4`。

原始分析输出在本候选 `.native-source/rea-analysis.json`，属于临时证据且体积较大，不进入插件包。该分析没有执行应用；未选文件与不完整调用图不能作为未审计代码的兼容保证。新 ASAR 读取器是 `tools/read-asar.mjs`，只读、检查边界、不跟随链接和 unpacked 成员，不复用历史工具。

## 加载元数据

原版 ui-layout/ui-sidebar-right 的 `lib/index.js` 只导出空 apply；客户端由 package 的 `exports['./client']` 和 `dsh.client` 声明发现。本候选 `src/index.ts` 同样只提供空 apply。

`dsh.client.platform` 是字符串 `"web"`，不是数组；`dsh.client.inject` 是原生包 ID 列表。客户端导出的 `inject` 则是 Cordis 服务名：`slots`、`sessions`、`uiSession`、`uiWorkspace`、`layout`、`sidebarRightHost`、`connection`。React 和原生 primitives 必须复用宿主单例。
