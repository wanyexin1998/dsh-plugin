# dsh-ide-workbench 可借鉴模式分析（面向 dsh-data-ide）

> 只读分析。未修改 `ref-ide-workbench` / `dsh-data-ide` 任何文件，未安装插件、未启停服务。
> 分析对象：`ref-ide-workbench` v0.4.0（`package.json:3`，MIT，`LICENSE:1-3`）。
> 目标：给「用户抱怨 dsh-data-ide 工具用起来不顺手」提供参考侧证据与落点，而不是功能清单。

**缩写（全文引用格式为 `path:line`）**

| 缩写 | 实际路径 |
|---|---|
| `ref/` | `E:\dsh-plugin\ref-ide-workbench` |
| `sql/` | `E:\dsh-plugin\dsh-data-ide\packages\client\ui-sql-workbench` |
| `mcp__sql__*` | agent 侧看到的 9 个 MCP 工具（`sql/mcp/tools.ts:38-48`） |

---

## 0. 一页结论

### 0.1 参考插件「顺手」的 6 条机制（不是功能数量）

| # | 机制 | 参考侧关键实现 | 为什么这让「人 + agent」更顺 | 评级 |
|---|---|---|---|---|
| M1 | **共享地址词汇**：人看到的一切都能写成一句聊天/代码里的地址，agent 输出的地址人能一键落到具体位置 | `@path` 提及语法（`ref/src/client/chat-bridge.js:76-83`）、`dsh-resource://file/...` 地址语法（`ref/src/client/file-address.js:29-54`）、tab 类型按地址 claim（`ref/src/client/index.jsx:317-348`） | 地址是双方共享的**指针**。没有地址，人只能用自然语言说「刚才那个结果」，agent 只能重跑一遍。 | P0 |
| M2 | **动作继承「当前选择」**：项目根、cwd、git 上下文由宿主/会话解析，显式参数只用于覆盖 | `repoEnv()` 自动找 git toplevel 并做 workspace↔repo 路径换算（`ref/src/index.js:72-95`）；终端 cwd 缺省 = 根、shell 缺省 = 设置（`ref/src/index.js:480-485`）；`workspace.list` 返回 `defaultRoot`（`ref/src/index.js:100-122`） | 调用者不必每次重新表达「我在哪」。少参数 = 少犯错 = 少 token = 动作更短。 | P0 |
| M3 | **零成本双向投影**：UI→聊天是「插入到 composer」；聊天→UI 是「claim 地址并落到位置」 | `insertChatText` 在光标处插入、不覆盖选区、持久化草稿（`ref/src/client/chat-bridge.js:48-67`）；`openResource(address,{params:{line},revealIfOpened})`（`ref/src/client/file-link.js:68-102`） | 用户不需要「复制 → 切窗口 → 粘贴」；agent 不需要猜「用户指的是哪一行」。 | P0 |
| M4 | **统一失败语义**：一个信封 + 机器码 + 人话 + 下一步 | `{ok,value}` / `{ok:false,error:{code,message}}`（`ref/src/host/wire.js:4,65-88`）、客户端单一 reader（`ref/src/client/api.js:55-78`）、冲突/失败映射为 409（`ref/src/host/workspace.js:314-318`、`ref/src/host/wire.js:78-85`） | agent 能稳定分支，人能看懂点哪里；失败不会被静默吞掉。 | P0 |
| M5 | **状态属于工作台而不属于当前渲染**：切会话/切面板不丢上下文，落盘防抖 + 原子写 | store 生命周期 = 插件 fiber（`ref/src/client/store.js:1-8`）、按工作区共享（`ref/src/client/workspace-scope.js:74-77,100-105`）、`workspaceState` 恢复标签/展开/布局（`ref/src/client/store.js:692-736`）、防抖 700ms + 原子写（`ref/src/client/store.js:188`、`ref/src/host/settings-store.js:205-219`） | 「人和 agent 穿插操作」时，切走再回来还在原处；这是长期开着的前提。 | P0（原则）/P1（完整持久化） |
| M6 | **可发现 + 默认安全**：菜单可见=快捷键可用、状态常驻、破坏性动作焦点在取消、失败不静默降级 | 入口冗余（`ref/docs/PRD-v2.md:85`）、状态栏（`ref/src/client/Workbench.jsx:151-200`）、确认框 focus 取消 + Esc（`ref/src/client/ui.jsx:116-164`）、回收站失败二次确认（`ref/docs/V3-体验问题与改进说明.md:784-800`） | 顺手的前提是「敢用」；不可发现/不可撤销/静默降级会让人放弃长期使用。 | P0（原则）/P1（打磨） |

### 0.2 直接回答：dsh-data-ide 的「不顺手」是 6 个结构性原因

| # | 原因 | data-ide 证据 | 参考侧的对应解法 | 评级 |
|---|---|---|---|---|
| 1 | **每次调用都要重新表达上下文**：`connId` 全量必填；`fetch_page` 还要把整段 `sql` 再传一次 | `sql/mcp/server.ts:320,471`（inputSchema 必填）、`sql/src/execute/core.ts:70-73`、`sql/docs/05-MCP-SPEC.md:44-77` | M2：宿主发布 active 上下文，参数可省略；动作继承「当前选择」 | P0 |
| 2 | **结果不可寻址**：返回的是行列 JSON；只有 `statementId` 且仅用于取消；翻页/复核靠重传 SQL | `sql/src/execute/core.ts:93-105`、`sql/mcp/server.ts:465-481`、`sql/docs/05-MCP-SPEC.md:53` | M1：`resultId` + 地址语法，让 `fetch_page`/`get_result` 用句柄而不是 SQL | P0 |
| 3 | **人机之间没有共享指针**：人看到的 console / 结果页 / 选中 SQL，无法变成 agent 能读的引用；agent 投递只能「落一个新 console」 | 客户端 inject 列表只有 `slots/locale/sidebarRight/sidebarRightTabs`，**没有** composer 动作（`sql/src/client/index.ts:14`）；投递信封带 `label/connId/consoleId/sql` + 结果预览，但没有 `resultId`/定位意图（`sql/src/execute/agent-delivery.ts:36-50`） | M3：UI→聊天框（`conversation.input.dock`）、agent 投递带 `resultId`/定位意图 | P0 |
| 4 | **失败语义不统一/不可行动**：MCP 失败常以 `content` 里的 `{ok:false}` 返回（模型看到的是成功调用）；HTTP 侧存在 `ok:false` 与 5xx 两形态 | `sql/mcp/server.ts:340-356`（返回 text content，未设 `isError`）、`sql/docs/05-MCP-SPEC.md:114-117`、`sql/docs/03-UIUX-SPEC.md:37-60`（拒绝两形态）、`dsh-data-ide/AGENTS.md:92` | M4：一个信封 + code/message/hint + 映射到 MCP `isError`/结构化错误 | P0 |
| 5 | **状态不连续**：console 文档是纯客户端状态，刷新即丢；页面类型未声明 `keepMounted`（切 tab/会话是否保留挂载需在 0.2.1 实测） | `sql/docs/09-BACKLOG.md:32-39`（B4）、`sql/src/client/index.ts:74-92`（未设 keepMounted） | M5：持久化 + 不因切换销毁执行/结果 | P0（不丢）/P1（持久化） |
| 6 | **缺「数据库工作台」的高频手感**：结果区无查找（B6）、无列显隐（B7）、无面板状态栏、确认框焦点/快捷键作用域未成体系 | `sql/docs/09-BACKLOG.md:50-66`、`sql/docs/03-UIUX-SPEC.md:207-228` | M6 + 第 7 节 Top10 | P1 |

> 一句话：**参考插件把「人看到的」变成「可寻址、可继承、可回放」的对象；data-ide 的工具面目前只有「动作」，没有「对象」。** 这是「不顺手」的机制根源，而不是工具少了一个。

---

## 1. 范围、方法与证据边界

**读过的参考侧文件**

- Host：`src/index.js`（584 行）、`src/host/wire.js`、`workspace.js`、`settings-store.js`（`git.js`/`fileops.js`/`search.js`/`idea.js`/`shell.js` 只做结构级判断，未逐行引用）。
- Client：`chat-bridge.js`、`file-address.js`、`file-link.js`、`api.js`、`workspace-scope.js`、`store.js`（2600+ 行，重点段）、`index.jsx`、`Workbench.jsx`、`EditorArea.jsx`、`ProjectPanel.jsx`、`ui.jsx`、`hooks.js`。
- Docs：`README.md`、`docs/M0-api-findings.md`、`docs/PRD-v2.md`（重点章）、`docs/PRD-v3.md`、`docs/V3-体验问题与改进说明.md`（1354 行，按标题分段读 §0/§1/§2/§7/§8/§9/§10/§11）、`docs/V4-实施进展.md`、`tests/chat-bridge.test.mjs`。
- 许可：`LICENSE`、`package.json`。

**读过目标侧（只做落点映射，不评审工具面细节）**

- `sql/mcp/{tools.ts,server.ts,tools-datasources.ts}`、`sql/src/execute/{core.ts,envelope.ts,console-registry.ts}`、`sql/src/host/{runtime-specs.ts,binding.ts}`、`sql/src/client/{index.ts,entry.ts,agent-stream.ts,state/connections.ts,state/documents.ts,contract/host.ts}`、`sql/src/client/components/{SqlWorkbenchPanel,ResultGrid,SchemaTree,DocumentTabs,SqlEditor}.tsx`、`sql/docs/{05-MCP-SPEC,10-AGENT-CONSOLE-SPEC,03-UIUX-SPEC,09-BACKLOG}.md`。

**边界**

- 未实机运行参考插件；「实机」结论一律来自其 V3 审计文档（`ref/docs/V3-体验问题与改进说明.md:9,89-95` 明示其审计方式）。
- 未对 data-ide 做工具面缺陷审计（另有同事负责）；本文只引用能支撑落点的代码/文档事实。
- 版本对照：参考插件要求 `dsh >= 0.1.7`（`ref/package.json:39-42`），data-ide 目标宿主是 0.2.1-rc.2（`dsh-data-ide/AGENTS.md:8,14`）。V4 用到的若干宿主能力需在 0.2.1 上复核，见第 12 节。

---

## 2. 机制 A：共享地址词汇 —— 人↔agent 的「指针」

这是参考插件最值得抄的机制，**它不是某个功能，而是一条协议**：UI 里的对象 ↔ 聊天里的文本 ↔ 可再次打开的位置。

### A1 UI → 聊天框（「发送到聊天框」）

**实现要点（6 个动作都很小）**

1. **不直接碰别人的 composer**：会话插件把 `inputActions` 作为标准 props 发给 Session 作用域槽位；IDE 在 `conversation.input.dock` 注册一个**不可见组件**收集动作（`ref/src/client/index.jsx:187-199`）。
2. **插入语义是「礼貌」的**：取当前插入点 → 若 composer 里已有选区，塌陷到选区末尾再插入（**绝不覆盖用户已输入内容**）→ 前面补一个空格避免粘连 → 成功后 `persistDraft()`（`ref/src/client/chat-bridge.js:48-67`，测试见 `ref/tests/chat-bridge.test.mjs:81-91`）。
3. **语法就是 composer 自己的 `@` 语法**：普通路径 `@src/app.js`，含空格 `@"my notes/a.md"`，目录保留尾斜杠 `@docs/`（`ref/src/client/chat-bridge.js:76-83`）；因此渲染、发送、后续解析都不用另造一套。
4. **代码选区 = 引用 + 行号 + 围栏**：`@file (L12-L20)` + 按扩展名选语言标记的 ```` ```js ```` 块，超 16000 字符/240 行截断并显式标 `… (truncated)`（`ref/src/client/chat-bridge.js:86-143`）。
5. **失败必须可见**：composer 不在时 toast「暂时无法写入聊天输入框」而不是静默丢弃（`ref/src/client/store.js:470-480`，测试 `ref/tests/chat-bridge.test.mjs:122-132`）。
6. **入口冗余**：项目树右键（`ref/src/client/ProjectPanel.jsx:309-313`）、编辑器/只读视图的选区右键（`ref/src/client/EditorArea.jsx:119-120,159-160`）都能发。

**为什么顺**：用户正在看的对象就是下一句话的主语；「发送」把主语变成引用，不需要复制/切窗口/解释。参考插件自己把它当成战略点：V3 审计时还只是 P2 建议（`ref/docs/V3-体验问题与改进说明.md:1005`「无发送到对话/作为上下文…战略差异点」），V4 已落地并写进 README 能力表（`ref/README.md:112`）。

**SQL 落点（P0）**

- 在 `ResultGrid` 工具栏/右键、`SchemaTree` 右键、`SqlEditor` 选区右键、`DocumentTabs` 右键各加「发送到聊天框」。
- 格式（与 agent 可读性对齐）：
  - SQL 选区：`@console/<consoleId> (L3-L8)` + ```` ```sql ```` 代码块（截断上限建议 8KB/120 行）；
  - 结果页：`@result/<resultId>` + 首行摘要（连接名 · 列数 · 总行数 · 耗时 · 页码）+ ```` ```tsv ```` 前 50 行；
  - 表/列：`@table/<connId>/<schema.table>` + 列定义围栏块。
- 实现位置：新增 `sql/src/client/chat-bridge.ts`（参考侧纯函数可直接改写）+ 在 `sql/src/client/index.ts:14` 的 inject 中补 composer 动作、注册 `conversation.input.dock` 槽位。
- 失败降级：toast + 一键复制到剪贴板（`sql/src/client/clipboard.ts:56-58` 已有能力）。

### A2 聊天 → UI（地址 claim 与三态降级）

参考插件把「聊天里的文件链接」变成「工作台里的位置」，且**每个不可控分支都有可行动降级**：

- tab 类型注册时声明 `patterns: ['dsh-resource://file/session/**','dsh-resource://file/absolute/**']`、`priority:'extension'`（比通用文件类型 pattern 更长从而稳定优先）、`canOpen` 只 claim 工作区内文件、`title(address)` 显示文件名（`ref/src/client/index.jsx:317-348`；设计理由 `ref/docs/V4-实施进展.md:26-32`）。
- `canOpen` 对工作区外文件直接返回 false，交给宿主自带预览，**不出现「不在项目内」报错**（`ref/src/client/index.jsx:338-346`、`ref/docs/V4-实施进展.md:32`）。
- 地址 tab 只是**载体**：打开成功后 `openTab(PANEL_ID,{replaceTab})` 替换自己，避免多留一个空 tab（`ref/src/client/index.jsx:61-68`）。
- 工作区内但不在当前「IDE 项目根」时返回 `needs-project-switch`，弹卡片询问（是/改用侧栏），脏编辑时返回 `dirty` 只给重试/侧栏/关闭（`ref/src/client/store.js:364-400`、`ref/src/client/index.jsx:119-144`）。
- 打开定位同时携带行号：`openResource(address,{params:{line},revealIfOpened:true})`（`ref/src/client/file-link.js:68-75`），落到 `openFile(...,{preview:true,line})`（`ref/src/client/store.js:402-406`）。
- 用户可关闭这套接管：设置 `links.chatFiles: 'ide' | 'sidebar'`（`ref/src/host/settings-store.js:74-78`、`ref/src/client/index.jsx:330`）。

**SQL 落点（P1，条件见 §12）**

- `sql/src/client/contract/host.ts:72-75` 已经声明了 `patterns/priority/canOpen/title`，但 `sql/src/client/index.ts:76-90` 没有使用。可先用于 **`.sql` 文件链接 claim**：聊天里点 `.sql` → 打开 SQL 工作台并载入脚本（依赖 05 §3.3 的脚本读写先落地）。
- 对「agent 投递 → 面板定位」这种无宿主地址支持的场景，用**进程内导航信箱**实现同等效果：投递带 `consoleId/resultId/statementIndex/row`，面板消费后 `openTab(TAB_KIND)` 并定位；不抢焦点，只在 console 上留未读点（未读点已有：`sql/src/client/components/DocumentTabs.tsx:99-101`、`sql/src/client/state/documents.ts:37-40`）。

### A3 地址语法本身（可直接借的纯函数）

`ref/src/client/file-address.js` 是一个**无依赖、可单测**的地址层：

- `session` / `absolute` 两种 scope，解析 query/fragment 后缀、逐段 `decodeURIComponent`、UNC 与盘符处理（`ref/src/client/file-address.js:29-54`）；
- 解析结果再按当前 cwd 归一化成原生路径，`.`/`..` 折叠、分隔符按 cwd 选择（`ref/src/client/file-address.js:74-124`）；
- 反向构造（`sessionFileAddress`/`fileAddressFor`）保证「同一个文件只有一种规范地址」（`ref/src/client/file-address.js:163-186`）；
- 能力判定 + 降级：Office/PDF/压缩包/二进制不 claim，留给宿主（`ref/src/client/file-address.js:126-145`）；
- 生成 `file://` URL 给系统浏览器（`ref/src/client/file-address.js:193-199`）。

**SQL 落点（P0~P1）**：把它改写成 `sql/src/shared/address.ts`，语法建议：

```
dsql://console/<consoleId>                 # 一个查询标签/console
dsql://console/<consoleId>/result/<resultId>#r12c3
dsql://script/<path>#L24
dsql://table/<connId>/<schema.table>
```

解析层只做「字符串 ↔ 结构化引用」，不依赖宿主；面板内跳转、日志、`@` 引用、投递协议、将来的聊天链接共用一套。参考侧「构造/解析/归一化/降级」四件套正是它稳的原因（`ref/src/client/file-address.js:1-12` 注释自述）。

### A4 评级

| 子机制 | 迁移价值 | 成本 | 评级 |
|---|---|---|---|
| composer 插入 + `@` 引用 + 失败 toast | 直接消灭「人→agent」断点 | 低（1 个模块 + 1 个槽位） | **P0** |
| 结果/SQL/表 的 `@` 占位格式 | 与 agent 可读性对齐 | 低 | **P0** |
| 地址语法 + 解析器 | 给「结果/脚本/表」一个稳定身份 | 中 | **P0**（先做 result/console 两种） |
| 聊天→UI 的宿主地址 claim | 依赖 `.sql` 脚本功能与宿主 pattern 语义 | 中 | **P1**（条件满足再做） |
| 三态降级卡片 | 避免「打开失败就报错」 | 低 | **P1** |

---

## 3. 机制 B：上下文默认值 —— 动作继承「当前选择」

### B1 参考侧的三层默认

1. **宿主派生上下文，不让调用方拼**：`repoEnv()` 以请求的 root 为工作区，自动探测 git toplevel、算出 workspace↔repo 的 `prefix`，之后所有 git 方法在仓库根执行、路径自动换算（`ref/src/index.js:64-95`）。调用方永远只说「工作区相对路径」，不必知道仓库在哪。
2. **接口参数缺省**：`fs.tree` 的 `path` 为空即根（`ref/src/index.js:137-143`）；`git.log` 的 `path` 可选（`ref/src/index.js:358-372`）；终端 `cwd` 缺省 = 根、`shell` 缺省 = 设置、cols/rows 有钳制（`ref/src/index.js:480-488`）。
3. **客户端按「上次 / 最近 / 默认」三级挑默认根**：`#pickRoot` 依次尝试 `settings.lastRoot` → `workspaceRegistry` 最近更新 → 宿主 defaultDirectory（`ref/src/client/store.js:527-534`，宿主侧候选校验 `ref/src/index.js:100-122`）。

> **一处需要纠正的直觉**：参考侧的 `canonicalRoot` 本身**不提供缺省**——缺 root 直接 400（`ref/src/host/workspace.js:35-47`）。它的「默认值」发生在**客户端状态与 `workspace.list` 的 `defaultRoot`**：默认根被选中一次后成为 `state.root`，之后每个请求都带同一个值。因此要抄的不是「宿主猜默认」，而是「**默认在会话里解析一次，动作继承它**」；这对 MCP 的含义是：可以在**宿主/面板侧**解析 active 上下文并发布，也可以让 server 从已发布状态解析，但不要在每次调用里重新推导。

还有两个很值得抄的「默认值纪律」：

- **一次性初始化，之后用户显式选择优先**：git 日志的分支筛选只在第一次 status 时用当前分支初始化（`branchInitialized`），之后轮询不会重置用户选择（`ref/src/client/store.js:848-872`）。
- **按作用域存默认**：`projectRoots[workspace]`（该项目上次选的 IDE 项目根，`ref/src/client/store.js:566-582`）与 `workspaceState[root]`（展开目录/标签/布局，`ref/src/client/store.js:692-736`）—— 默认值是「这个作用域的记忆」，不是全局单值。

### B2 对比 dsh-data-ide

| 维度 | 参考侧 | data-ide 现状 | 差距后果 |
|---|---|---|---|
| 连接/工作区 | 请求可省略 root，宿主挑默认并校验 | `connId` 全量必填（`sql/mcp/server.ts:238,272,297,320,471`） | agent 每次都要先 `list_datasources` 再抄 id；人问「这个表结构」时 agent 不知道指哪个连接 |
| 当前选择 | 客户端 `root` 即当前选择，动作全部继承 | 宿主已有 active 连接并持久化（`sql/src/client/state/connections.ts:54-57`、`sql/src/host/binding.ts:91-92`），但**运行时规格文件只发布连接、不发布 active**（`sql/src/host/runtime-specs.ts:40-45`） | MCP server（独立进程）无法得知用户当前在看哪个连接 |
| 当前对象 | 「当前打开文件」可被文件链接/动作引用 | 没有「当前 console / 当前选中 SQL」的发布或被工具读取的通道 | agent 无法「跑一下你选中的 SQL」「给当前结果翻页」 |
| 显式覆盖 | 传参即覆盖，不传即继承 | 只有显式必填 | — |

### B3 SQL 落点（P0）

1. **宿主发布 active 上下文**（扩展已有运行时目录，参考 `sql/src/host/runtime-specs.ts:25` 的 `data-ide-runtime/`）：`context.json = { activeConnId, activeConsoleId, activeDocSql?, selection?, updatedAt }`，在连接切换/console 激活/编辑器选区变化时**防抖**写（参考 `ref/src/host/settings-store.js:205-219` 的串行 + 原子写）。
2. **工具参数改为「可选 + 宿主/服务器解析」**：`get_schema` / `list_tables` / `execute_sql` / `execute_script` / `fetch_page` 的 `connId` 改为 optional，缺省取 active；没有 active 时返回 `NO_ACTIVE_CONNECTION` + hint（`可用连接：...；先调用 list_datasources`）——参考侧 `toRepoPath` 越界即 403 的「明确拒绝」风格（`ref/src/index.js:84-92`）。
3. **新增「读取当前上下文」工具**：`get_context()` → `{ activeConnId, datasources, activeConsole: {id,title,sql}, selection?, recentlyExecuted }`。效果等价于参考插件的「工作台知道你在哪」；也让 agent 不必先 `list_datasources`。
4. **`execute_sql` 允许 `sql` 来源 = 显式文本 | `useCurrent: true`（当前编辑器/选区）**。参考侧对应能力是「聊天文件链接 → 打开当前文件 → 定位行」，方向相反但机制相同：**当前 UI 状态是合法输入**。
5. **`list_datasources` 返回值补 `activeId`**（对齐 `ref/src/index.js:100-122` 的 `defaultRoot` 思路：让调用方不必自己算默认）。

验收：agent 在用户已选连接、编辑器有 SQL 时，`mcp__sql__execute_sql` 不带参数也能跑当前语句；错误提示能直接告诉它缺什么。

---

## 4. 机制 C：单一 API 面 + 统一信封 + 边界校验

### C1 参考侧实现

- **一个入口**：`POST /ide-workbench/api/<method>`，方法名即路由末段；非 POST → 405，未知方法 → 404（`ref/src/index.js:43,436-464`）。
- **一道围栏**：每个 HTTP 请求先过 `ctx.connection.requestRejection(req)`（与宿主 `/api` 同一准入），失败 403（`ref/src/index.js:62,440-443`）；WebSocket upgrade 同样围栏（`ref/src/index.js:557-568`）。
- **一个信封**：成功 `{ok:true,value}`（`ref/src/host/wire.js:65-67`）；失败 `{ok:false,error:{code,message}}`，`ApiError` 携带 HTTP 状态（`ref/src/host/wire.js:10-22,70-88`）；未知异常 → 500 `internal`（`ref/src/host/wire.js:86-88`）。
- **领域错误单独映射**：git 错误保留 stderr 文本， `not a git repository` → 409 `not-repo`，其余 → 400 `git-error`（`ref/src/host/wire.js:78-85`）。**用户输入的错不是插件故障**，状态码要能区分。
- **边界校验集中在 wire 层**：`requireString`（含 `allowEmpty` 给编辑器空 buffer）、`stringArray`、`optionalBoolean`、`optionalInteger`；body 上限 8MB；非法 JSON 400（`ref/src/host/wire.js:24-52,96-127`）。
- **传输细节防御**：`writeJson` headers-sent 安全（`ref/src/host/wire.js:55-62`）；`cache-control:no-store`；客户端一个 `call()` 负责 URL 前缀、JSON、信封解包、`ApiError(code,message)`（`ref/src/client/api.js:55-78`）。
- **一次往返带齐**：`git.status` 永远返回 `ignored` 条目，客户端本地切换显隐不必二次请求（`ref/src/index.js:263-276`）。
- **契约只增不改**：V3 新增 API 用一张增量表列出「请求/返回/新增可选字段」，例如 `fs.write` 加 `expectedMtimeMs?`、冲突码 `stale-file`；`fs.delete` 加 `allowPermanent?`（`ref/docs/PRD-v3.md:105-114`）。

### C2 对「agent 可复用性」的含义（4 点）

1. **一套语义两个消费者**：同一 `envelope + code` 能让 UI 渲染 banner、agent 分支；参考侧没有 MCP 工具，所以它把「agent 通道」放在聊天；data-ide 有 MCP，**更应把两者收敛到同一信封**（`sql/docs/05-MCP-SPEC.md:114-117` 已经写了统一信封，但 MCP 侧实际是 `content[0].text = JSON`，见 `sql/mcp/server.ts:212`）。
2. **拒绝必须是「可判定」的**：agent 不能靠读自然语言判断。参考侧每个失败都有 `code`（`forbidden`/`not-found`/`stale-file`/`trash-failed`…）；data-ide 的 `Refusal` 已有 code（`sql/src/execute/envelope.ts:12-14`），但 MCP 外层没把 `ok:false` 映射为工具失败。
3. **参数校验要在边界一次做完**：参考侧所有方法先 `requireString` 再干活，错误是 `bad-request` + 字段名（`ref/src/host/wire.js:96-102`）。data-ide 用 zod 定义 MCP schema 已很好（`sql/mcp/server.ts:319-325`），但**HTTP 面板路由与 MCP 的校验是两套**（`sql/docs/05-MCP-SPEC.md:94-112`）；建议抽「契约单源」：一张表同时生成 zod schema、MCP 注册、HTTP 路由与测试。
4. **默认值 + 可选参数直接降低 agent 调用成本**：参考侧「root/path/cwd 可省」让调用短；data-ide 的 `connId/sql` 必填让每次调用更长。C 与 B 是同一件事的两面。

### C3 落点

| 动作 | 落点 | 评级 |
|---|---|---|
| MCP 失败内容统一：`{ok:false,...}` 时返回 `isError: true` + 结构化 `content`（或 SDK 支持的 `structuredContent`） | `sql/mcp/server.ts` 各 handler 的返回包装 | **P0** |
| `code/message/hint/nextAction` 四件套统一（参考侧只有 code/message；`hint` 已在 data-ide 类型里，`sql/mcp/tools-datasources.ts:17-19`） | `sql/src/execute/*`、`sql/mcp/*` | **P0** |
| 契约单源（tool name/schema/errors 一处定义，HTTP 与 MCP 都从它派生） | 新增 `sql/src/contract/tools.ts`，替代 `TOOL_NAMES` + 手写注册 | P1 |
| 错误码枚举文档化 + 每码一个 hint 模板 | `sql/docs/05-MCP-SPEC.md` §3/§4 | P1 |

---

## 5. 机制 D：状态与连续性

### D1 参考侧做对的 8 件事

| # | 做法 | 证据 |
|---|---|---|
| 1 | store 生命周期 = 插件 fiber，切回对话再回来保留 tabs/展开/layout | `ref/src/client/store.js:1-8` |
| 2 | 按工作区分 store（同 cwd 的会话共享一份），无 cwd 回退 session key | `ref/src/client/workspace-scope.js:56-77` |
| 3 | 切会话时只在「离开时可见 + 同工作区」才自动重开 IDE | `ref/src/client/workspace-scope.js:100-105` |
| 4 | 设置单文档 + 深合并默认 + 版本迁移前备份 `.bak` | `ref/src/host/settings-store.js:17-128,175-193` |
| 5 | 写设置串行化 + temp 文件 rename 原子替换 | `ref/src/host/settings-store.js:196-219` |
| 6 | UI 持久化 700ms 防抖；面板卸载/切走立即 `persistNow` | `ref/src/client/store.js:188,738-802` |
| 7 | 每工作区恢复「展开目录 / 打开的标签（最多 24）/ 活动标签 / 布局」 | `ref/src/client/store.js:692-736` |
| 8 | 恢复时先同步状态再**延后加载**，避免展开目录出现永久「加载中」 | `ref/src/client/store.js:964-973` |

还有 3 个「不丢」的细节：

- **后台 store 不得抢写 `lastRoot`**：只有可见工作台写（`ref/src/client/store.js:762-766`）。
- **请求代数（token）防旧响应**：目录/搜索/git 详情都用 token，旧响应直接丢弃（`ref/src/client/store.js:190-194,928-955,1117-1149`）。
- **轮询只在可见时跑**（`document.visibilityState`），且用单飞标志（`ref/src/client/store.js:804-809`）。

### D2 参考侧踩过的坑（V3 审计结论，直接对 data-ide 有用）

- **切面板就杀长驻进程**是「不能常开」的头号原因；修法是保持挂载（`display:none`）+ 宿主持有会话 + 重连回放（`ref/docs/V3-体验问题与改进说明.md:699-730`）。落地证据：Workbench 里终端即使隐藏也保持挂载（`ref/src/client/Workbench.jsx:409-430`）。
- **每次切换面板重新 `loadLog(true)`** 导致滚动/选中丢失（`ref/docs/V3-体验问题与改进说明.md:928,979`）。
- **全量快照订阅**导致光标移动触发全树重渲（`ref/docs/V3-体验问题与改进说明.md:959`）。

### D3 SQL 落点

| 动作 | 说明 | 落点 | 评级 |
|---|---|---|---|
| 页面类型加 `keepMounted` 并保持执行中的语句 | 切到聊天/再回来，结果与运行中语句不能消失（参考侧终端教训的直接类比） | `sql/src/client/index.ts:76-90`、面板生命周期 | **P0** |
| console 文档持久化（B4） | 用宿主 KV + 防抖 + 原子写；按连接/会话 scope；只存 SQL 与元信息，不存结果 | `sql/src/client/state/documents.ts`（当前纯客户端）、`sql/src/host/binding.ts:151-174` 的 `saveLayout` 同款通道 | P1（已在 B4） |
| 恢复「活动 tab / 页大小 / 编辑器光标 / 滚动」 | 参考侧恢复 `tabs[].scrollTop`/`activePath`/`expanded` | `sql/src/client/state/documents.ts` | P1 |
| 请求 token / Abort 全量覆盖 | schema 树、执行、翻页 | `sql/src/client/http-api.ts`、`schema-tree.ts` | P1 |
| 轮询/自动刷新可见性门控 | 若将来做连接状态轮询 | — | P2 |

---

## 6. 机制 E：错误可行动、冲突不覆盖、破坏性可确认

| 原则 | 参考侧证据 | SQL 落点 | 评级 |
|---|---|---|---|
| 领域错误 → 机器码 + 人话 | `ApiError(code,message,status)`（`ref/src/host/wire.js:10-22`）；git stderr 原样带出（`ref/src/host/wire.js:78-85`） | 已有 `db-error.ts` 翻译 + `Refusal.code`；补 `hint/nextAction`，并让 MCP 也走同一套 | **P0** |
| 写冲突绝不静默覆盖 | 保存带 `expectedMtimeMs`，mtime 不一致 → 409 `stale-file`，**拒绝写**（`ref/src/host/workspace.js:304-318`）；前端三选一「重新加载/覆盖/取消」（`ref/src/client/store.js:1793-1815`），工具栏常驻冲突 chip（`ref/src/client/EditorArea.jsx:316-328`） | 脚本文件保存（将来）必须带 mtime；执行前若有未保存 SQL 不应静默替换 | **P0**（原则） |
| 外部修改检测要「内容判等」而不是只看 mtime | 只有内容不同才报冲突，同内容 touch 只更新基线（`ref/src/client/store.js:811-846`） | 脚本/连接配置文件同理 | P1 |
| 破坏性操作二次确认且默认焦点在取消 | `ConfirmModal` focus Cancel、Esc 取消、点遮罩取消（`ref/src/client/ui.jsx:116-164`） | **SQL 写操作**（`writeEnabled` 下的 UPDATE/DELETE/DDL）、删除连接、取消执行；确认框默认焦点 = 取消 | **P0** |
| 失败不静默降级（回收站→永久删除必须再问） | `ref/docs/V3-体验问题与改进说明.md:784-800`；客户端二次确认实现 `ref/src/client/store.js:1345-1359` | 写操作审计/失败重试；连接测试失败给「检查密码/白名单」级别 hint（`sql/docs/03-UIUX-SPEC.md:198-205` 已有设计） | **P0** |
| 错误标题按动作命名，不共用「提交失败」 | `ref/docs/V3-体验问题与改进说明.md:981`（UX-09） | SQL：区分「连接失败/权限拒绝/超时/语法错误/取消」；不要统一「执行失败」 | P1 |
| 错误详情可复制 | 参考侧 P2-10 仍缺（`ref/docs/V3-体验问题与改进说明.md:999`），说明这是易漏项 | 结果错误 / 连接错误面板加「复制详情」 | P1 |
| 失败有下一步 | 文件链接失败卡片给「重试/默认侧栏/关闭」（`ref/src/client/index.jsx:119-144`）；加载失败行给重试（`ref/src/client/ProjectPanel.jsx:555-556`） | 空态/失败态给按钮：重试、换连接、去测试连接、复制 SQL | P1 |

---

## 7. 交互手感 Top 10（只挑与「数据库工作台」强相关）

| # | 细节 | 参考侧证据 | SQL 落点 | 评级 |
|---|---|---|---|---|
| 1 | **单击预览、双击固定**；预览 tab 复用同一个槽位；脏预览先转正再开新预览，绝不丢未保存内容 | `openFile` 语义与预览复用（`ref/src/client/store.js:1505-1571`，脏预览转正 `1550-1566`）；双击固定（`ref/src/client/EditorArea.jsx:174`）；设置项 `singleClickOpen`（`ref/src/host/settings-store.js:44-49`） | 结果 tab / console tab 引入「预览（被下一次单击替换）vs 固定」；对象树单击只选中，双击插入/打开 | P1 |
| 2 | **「打开」与「选中」是两种视觉、可同时存在** | V3 审计把它列为 P0 状态语义（`ref/docs/V3-体验问题与改进说明.md:523-598`）；PRD-v3 定为「选中=蓝底、打开=强调条」（`ref/docs/PRD-v3.md:99-103`） | 活动 console（打开）/ 结果 tab 选中 / 未读角标 / 焦点，四者正交 | P1 |
| 3 | **常驻状态栏**：分支、改动数、光标行列、行数、编码/换行、快捷键提示 | `ref/src/client/Workbench.jsx:151-200` | 连接名 · 库 · 方言 · 页码/行数 · 总行数 · 耗时 · 只读/可写标识 · 页大小 | P1 |
| 4 | **惰性加载 + 请求代数 + 永不永久 loading** | `loadDir` token 与「stale 不覆盖」（`ref/src/client/store.js:928-955`）、恢复树时补加载（`964-973`）、`loadRestoredTree` | schema 树按需展开；翻页/筛选用 token；重新加载出现骨架/重试行 | P1 |
| 5 | **大内容截断 + 只读降级**：>2MB 只读前 2MB 并标 `truncated`；二进制不渲染；写有上限 | `readFileForPreview`（`ref/src/host/workspace.js:203-269`）、写上限与 symlink 拒绝（`304-333`）、编辑器按大小决定可编辑（`ref/src/client/store.js:1494-1503`） | 单元格 1MB 预览（已有 `sql/docs/03-UIUX-SPEC.md:217`）、脚本 >1MB 只读、结果首屏 500 行 | 已有/保持 |
| 6 | **确认框：默认焦点取消、Esc 取消、遮罩取消** | `ref/src/client/ui.jsx:116-164`（V3 审计判为 P0 的 UX-01，`ref/docs/V3-体验问题与改进说明.md:871-882`） | 写操作/DDL/删连接/取消执行 | **P0** |
| 7 | **外部修改三选一 + 内容判等** | `ref/src/client/store.js:811-846,1793-1815` | 脚本保存；连接配置文件被外部改 | P1 |
| 8 | **快捷键按焦点作用域**：编辑类快捷键不进输入框；宿主保留键只在本插件聚焦时接管 | `ref/src/client/index.jsx:422-513`；V3 审计把它列为 P0（`ref/docs/V3-体验问题与改进说明.md:809-869`） | `Ctrl+Enter` 只在编辑器聚焦时执行；`Ctrl+F` 不抢结果网格；聊天框内不触发工作台快捷键 | P1 |
| 9 | **只读内容必须可选中复制**（不要全局 `user-select:none`） | V3 审计最重的一条（`ref/docs/V3-体验问题与改进说明.md:669-697`）；修法是只读也复用 CodeMirror（`ref/src/client/EditorArea.jsx:145-161`） | 结果网格/DDL 面板/错误详情/连接信息右键复制；TSV/CSV 已有（`sql/docs/03-UIUX-SPEC.md:226`） | **P0**（低成本高感知） |
| 10 | **空态/失败态给「下一步」+ toast 分级可关闭** | 空态、fatal 重试（`ref/src/client/Workbench.jsx:443-456`）；toast error 9s / 其它 4.5s（`ref/src/client/store.js:224-233`） | 无连接空态（`sql/src/client/components/SqlWorkbenchPanel.tsx:1013-1018` 已有）；notice 可关闭（`1021-1040` 已有）；补错误分级与重试按钮 | P1 |

> 附加一条常被忽略的：**面板切换保留长驻状态**（滚动、选中、展开、运行中语句）——参考侧 V3 明确列为 P0（`ref/docs/V3-体验问题与改进说明.md:973-982` UX-07）。SQL 工作台的「长驻」对象是**执行中的语句与结果集**，不是 PTY。

---

## 8. `docs/V3-体验问题与改进说明.md`：按类归纳（问题 → 修法 → 通用原则）

> 不逐条抄。每类给：他们的证据 → 修法方向 → 可迁移到 data-ide 的原则。

| 类别 | 他们的典型问题（证据） | 修法方向 | 可迁移的通用 UX 原则 | SQL 落点 | 评级 |
|---|---|---|---|---|---|
| 搜索/查找 | 只读态 `Ctrl+F` 无反应、全局查找是死快捷键、树过滤只覆盖已加载（`ref/docs/V3-体验问题与改进说明.md:34,188-225`） | 三个入口共用一套 `SearchQuery` 模型；树过滤明确「仅已加载」 | **同一能力不要有多个质量不同的入口；不可用的入口要么实现要么隐藏** | 编辑器查找（已有 CM）、schema 树过滤（已有）、结果区查找（B6 未做）；结果查找要标「仅当前页」 | P1 |
| 布局/导航 | Git 详情上下堆叠只剩 5 行、面板切换丢滚动/选中（`ref/docs/V3-体验问题与改进说明.md:62,73,928,979`） | 日志全高 + 右侧 Drawer；保持面板挂载 | **内容区给主对象全高；辅助信息用非模态抽屉；切换不重建** | 结果区/对象树/编辑器三栏已定；避免切 tab 重建结果 | P1 |
| 状态语义 | 打开与选中同色（`ref/docs/V3-体验问题与改进说明.md:108`、§5） | 四状态（Open/Selected/Inactive/Focus）+ 失焦弱化 | **状态视觉必须正交且可同时表达** | 活动 console / 选中 result tab / 未读 / 焦点 | P1 |
| 数据安全 | 只读不可复制、关脏标签无「保存」、保存覆盖外部改动、回滚不彻底、回收站失败静默永久删（`ref/docs/V3-体验问题与改进说明.md:669-807`） | 只读可复制、三选一关闭、mtime 冲突、真回滚、失败二次确认 | **默认安全 > 默认顺手；任何「丢失/覆盖/永久化」都必须显式** | 写操作 gate、删除连接、脚本保存、结果导出覆盖文件 | **P0** |
| 键盘/焦点 | 十多个承诺的快捷键无实现、`Ctrl+A` 泄漏到宿主侧栏、F11/Ctrl+K 抢聊天框（`ref/docs/V3-体验问题与改进说明.md:809-869`） | Action Registry + `scope: tree/editor/global` + 菜单与设置同源 | **「菜单可见 = 快捷键可用」；快捷键必须有作用域** | `Ctrl+Enter`、`Ctrl+S`、`Esc` 取消、`Ctrl+F`、`F4/F5` 类动作先定义作用域 | P1 |
| 确认/破坏性 | 确认框默认聚焦「确认」，Enter 直接执行（`ref/docs/V3-体验问题与改进说明.md:871-882`） | 默认焦点取消、Esc、列出影响面 | **危险按钮永不默认聚焦；确认框必须说明影响** | 写 SQL/DDL/连接删除 | **P0** |
| 性能/竞态 | 2s 轮询跑 3 条 git 子进程、全量快照重渲、无取消（`ref/docs/V3-体验问题与改进说明.md:954-962`） | 轮询最小化 + 可见性门控 + token/Abort + 错误退避 | **后台开销要可解释；旧响应必须有代数** | COUNT 缓存（已有）、schema 5 分钟缓存（已有）、翻页/执行 token | P1 |
| 设置/i18n | 死设置项、术语混用、CodeMirror 英文面板（`ref/docs/V3-体验问题与改进说明.md:942-952`） | 每个设置要么实现要么删除；术语表 | **不存在的开关比没有开关更伤信任** | 设置页（目前主要是连接配置）；快捷键说明 | P2 |
| 视觉/可访问性 | 硬编码暗色主题、文本字形图标、无 ARIA（`ref/docs/V3-体验问题与改进说明.md:964-971`） | token 化、SVG、ARIA/focus trap | **语义 token + 键盘可达** | data-ide 已只用 `--dsw-alias-*`（`dsh-data-ide/AGENTS.md:60,116`），补 focus trap/aria-live | P2 |
| 错误文案 | checkout/revert/discard 全用「提交失败」（`ref/docs/V3-体验问题与改进说明.md:981`） | 按动作的错误 key + 可复制 | **错误文案要说明「哪个动作 + 什么原因 + 下一步」** | DB 错误分类已有基础，补 nextAction | P1 |
| 文档/验收 | PRD 写「上下分栏」但交互写「单击选中双击打开」，根因在文档（`ref/docs/V3-体验问题与改进说明.md:73,1010-1054`） | 交互契约写清「读/写、前置条件、失败态」；验收给输入/操作/期望/观测 | **文档必须定义交互状态与失败态，否则实现者各写一套** | `03-UIUX-SPEC` 已较完整；给新工具补「失败态/下一步」栏 | P1 |

**他们的审计方法本身值得抄（低成本、高收益）**：源码逐行走查 + 自动化测试通过 ≠ 体验正确 + 真实 git 复现 + 实机 UI 走查（40+ 截图）+ **「实机修正」先前的推断**（`ref/docs/V3-体验问题与改进说明.md:84-95,809-818`）。其中「实机修正」尤其重要：他们公开推翻了此前基于通用 Chromium 的结论，避免把猜测写进方案。data-ide 的下一步方案也应要求「每个 P0 有可执行的人机验收脚本」，而不是只写单测。

---

## 9. 不可借鉴 / 不适用（含理由）

| 模块 | 为什么不能搬 | 能借的只有 |
|---|---|---|
| 终端 WebSocket / PTY（`ref/src/index.js:466-568`、`TerminalPanel.jsx`） | data-ide 明确不做终端；`ws`/xterm 依赖与 PTY 生命周期模型完全不同 | 「长驻会话 + 面板隐藏不销毁 + detach/reattach + 回放」的**思想**，用于「执行中语句/结果集不应因切面板消失」 |
| Git CLI 适配器（`ref/src/host/git.js`） | data-ide 的 git 只作用于隔离脚本目录且脚本功能尚未实现（`sql/docs/05-MCP-SPEC.md:85-91`）；git 状态解析器是大体量专用代码 | 「argv 数组、绝不用 shell 字符串、stderr 原样透传、状态解析用 `-z`」的纪律（`ref/README.md:118`），将来写脚本 git 时用 |
| 文件树 / fileops（`ref/src/host/fileops.js`、`ProjectPanel.jsx`） | 对象树是**远程元数据**（information_schema），不是本地 FS；拖拽/回收站语义无对象 | 惰性加载、截断提示、重试行、树内过滤 vs 全量索引的分工 |
| IDE 项目根 / DSH 工作区容器（`ref/README.md:103-105`） | data-ide 没有 workspace 容器概念，页面类型是右栏全局一个 | 「作用域键」思想：`connId` 可当 scope key 存布局/页大小/最近 SQL |
| Diff / Markdown / QuickOpen / Git Drawer / Changelist / Local History | 舞台不同，迁过去没有对象 | 仅「Drawer 非模态 + 单击选中双击展开」的交互模式可用于结果详情/值查看器 |
| Office/PDF 预览降级（`ref/src/client/file-address.js:126-145`） | SQL 结果没有「文件类型」概念 | 「不能处理的类型交还默认查看器」的降级原则可用于二进制单元格 |
| 布局引擎（Docked/Floating/Split/Stripe、`ref/src/client/store.js:2540-2635`） | 右栏宽度受限，data-ide 已选择简单两栏 | 只借「窄屏折叠 + 记住宽度」 |
| 参考侧 `dist/client.js`（约 2332 KiB 打包产物） | 含 xterm/ws 与 React 外置约定，构建链不同（`ref/docs/V4-实施进展.md:48`） | 不借 |
| 参考侧文档原文 | 语境是 IDE 工具窗，直接搬会产生「文档与代码分叉」 | 借结构与原则，改写成本地条款 |

---

## 10. 许可与合规

### 10.1 事实

- 参考插件 **MIT**：`ref/LICENSE:1-3`（`Copyright (c) 2026 dsh-ide-workbench contributors`），包声明 `"license": "MIT"`（`ref/package.json:70`）。
- MIT 义务很轻但必须做：**任何复制（含实质性片段）都必须在副本中保留版权声明与许可声明**（`ref/LICENSE:6-13`）。修改、商用、闭源分发都允许。
- 其 `dist/client.js` 内联了第三方 MIT 代码（xterm 等），**不要复制打包产物**；要复用的源码模块按其自身许可（本项目内即 MIT）。
- data-ide 自己的合规底线（`dsh-data-ide/AGENTS.md:71-72`、`dsh-data-ide/docs/00-README.md:118-120`）针对的是 **DataGrip 逆向材料**（不得复用字节码/资源/文档原文、不抢注商标）。参考插件是 MIT 公开源码，**不属于该禁止范围**，但需遵守 MIT 署名。

### 10.2 「可复制代码级构件」vs「只能借鉴思路」

**可复制（建议重写为 TS + 补测试 + 文件头留 MIT 出处声明）**

| 构件 | 规模/依赖 | 复制建议 |
|---|---|---|
| `ref/src/host/wire.js`（错误类 + body 读取 + 窄化校验） | 128 行、零依赖 | 改成 `sql/src/shared/wire.ts` 的 `ApiError` + `requireString/optionalInteger` 等；与现有 zod schema 不冲突（HTTP 面板路由用） |
| `ref/src/client/file-address.js`（地址解析/归一化/降级） | 199 行、纯函数 | 改写成 `dsql://` 地址解析器；解析逻辑（scope/编码/UNC/query 后缀）几乎可逐段对应 |
| `ref/src/client/chat-bridge.js` 的 `formatFileMention/fenceLabelForPath/composeCodeReference` | 纯函数、可单测 | 直接改造成 SQL 版 `formatSqlMention/composeResultReference`；插入语义（塌陷选区、补空格、persistDraft）照抄逻辑 |
| `ref/src/client/workspace-scope.js` 的归一化/包含判定 | 105 行、纯函数 | 只借「scope key + 路径归一化」；路径逻辑在本项目用得少（可简化） |
| `ref/src/host/settings-store.js` 的 `deepMerge` + 原子写 + 串行 update 模式 | 小 | 与 data-ide KV 持久化合并时参考（不要照搬 profile 路径逻辑，data-ide 已有 `storage-json`） |
| `ref/src/client/ui.jsx` 的 `ConfirmModal` 焦点策略 | 约 20 行核心 | 直接按语义重写，保留「默认取消 + Esc + 遮罩」 |
| `ref/src/client/util.js` 的 `debounce` | 极小 | 直接用/重写 |

**只能借鉴思路（不要复制）**

- `store.js`（2600+ 行状态机）：领域不同（文件/标签/git vs console/结果/连接），TS strict + React 18 + 宿主版本也不同；复制会引入大量死代码。
- 全部 `.jsx` UI 组件与 `styles.js`（类名 `iwb-*`、令牌体系不同；data-ide 用 `--dsw-alias-*` 与 `*.module.css`）。
- 终端/PTY、git 适配、fileops、search、idea 启动器。
- 布局引擎、Stripe/Dock 逻辑。
- 其 PRD/V3 文档的**整段文字**：法律上 MIT 覆盖文档，但工程上会造成「两份规格」；只借表格结构与原则，按 data-ide 语境重写。
- 其 locale 文案（中英文措辞是插件品牌的一部分；data-ide 需自有术语表）。

### 10.3 落地纪律建议

1. 建 `THIRD-PARTY-NOTICES.md`：写明「部分实现参考 dsh-ide-workbench（MIT, Copyright (c) 2026 dsh-ide-workbench contributors）」并附 MIT 全文。
2. 每个改编文件头加 2 行注释：`Derived from dsh-ide-workbench (MIT). Copyright (c) 2026 dsh-ide-workbench contributors.` + 本仓库许可证。
3. 复制必须配**本项目风格的测试**（data-ide 要求 per-file 100% 覆盖），不复制其测试文件（测试也受 MIT 覆盖，但断言针对其领域）。
4. 不复制 `dist/client.js`、不复制其 `locale/*.json` 全量文案、不复制其 README 段落。

---

## 11. 建议纳入方案的落地清单（按 P0/P1/P2）

> 每条都给出「参考侧依据 → data-ide 落点 → 验收」。P0 = 直接高价值、低成本、与 SQL 工作台强相关。

### P0（建议本轮就做）

| # | 动作 | 参考依据 | data-ide 落点 | 验收 |
|---|---|---|---|---|
| P0-1 | **结果/console 稳定句柄**：`execute_sql`/`execute_script` 返回 `resultId`；`fetch_page` 支持 `{resultId, offset}`；新增 `dsql://` 地址解析 | 地址层 `ref/src/client/file-address.js:29-124`；一次往返带齐 `ref/src/index.js:263-276` | `sql/src/execute/core.ts:93-105`、`sql/mcp/server.ts:465-481`、`sql/docs/05-MCP-SPEC.md:44-77` | agent 第二次取页不再重传整段 SQL；同结果可被 UI/投递/日志引用 |
| P0-2 | **active 上下文发布**：`context.json`（activeConnId/activeConsoleId/selection）；工具 `connId` 可选；新增 `get_context` | 默认值哲学 `ref/src/index.js:72-143,480-488`、`ref/src/client/store.js:527-534` | `sql/src/host/runtime-specs.ts:25,40-45`、`sql/mcp/server.ts` 各工具 schema | 用户已选连接时，不带 `connId` 的 `get_schema`/`execute_sql` 成功；无 active 时错误含可用列表 |
| P0-3 | **发送到聊天框**：composer 槽位 + `@` 引用 + SQL/结果/表 三种格式 + 失败 toast | `ref/src/client/index.jsx:193-199`、`ref/src/client/chat-bridge.js:48-143`、失败提示 `ref/src/client/store.js:470-480` | 新增 `sql/src/client/chat-bridge.ts`；`sql/src/client/index.ts:14` inject 补 `conversation.input.dock` 注册；`ResultGrid`/`SchemaTree`/`SqlEditor`/`DocumentTabs` 加右键项 | 结果区右键 → 聊天框出现 `@result/...` + TSV；composer 有选区时不被覆盖；composer 不在时 toast |
| P0-4 | **MCP 失败语义**：`ok:false` → `isError:true`；`code/message/hint/nextAction` 四件套；拒绝两形态统一 | `ref/src/host/wire.js:4,10-22,70-88`；参考侧「错误按动作命名」`ref/docs/V3-体验问题与改进说明.md:981` | `sql/mcp/server.ts` 所有 handler 返回包装（可抽 `toolResult()` 小函数）；`sql/src/execute/envelope.ts:12-14` 扩展 | 模型在权限拒绝/语法错误时看到 `isError`；每条错误都有可执行 hint |
| P0-5 | **不丢状态**：页面类型声明 `keepMounted`（先在 0.2.1 实测宿主语义）；执行中语句不因切面板/切会话取消；结果与活动 tab 保留 | 终端教训 `ref/docs/V3-体验问题与改进说明.md:699-730`、长驻挂载 `ref/src/client/Workbench.jsx:409-430` | `sql/src/client/index.ts:76-90`、面板卸载清理逻辑 | 执行长查询 → 切聊天 → 回来，语句仍在跑/结果仍在；未读点正确 |
| P0-6 | **确认与只读可复制**：写操作/DDL/删连接确认框默认焦点取消 + Esc；结果/DDL/错误详情可复制 | `ref/src/client/ui.jsx:116-164`、`ref/docs/V3-体验问题与改进说明.md:669-697` | `sql/src/client/components/*` 对话框；`sql/src/client/clipboard.ts` | Enter 不误执行；Ctrl+C 可复制网格/DDL/错误 |

### P1（紧随其后）

| # | 动作 | 参考依据 | 落点 |
|---|---|---|---|
| P1-1 | console 文档持久化（B4）+ scope=connId + 防抖/原子写 | `ref/src/client/store.js:738-779`、`ref/src/host/settings-store.js:196-219` | `sql/src/client/state/documents.ts`、`sql/src/host/binding.ts` |
| P1-2 | agent 投递带 `resultId/reveal` 意图，面板定位到 console/statement/行；仍不抢焦点 | 参考侧「聊天→UI 定位」`ref/src/client/index.jsx:101-103`、`ref/src/client/store.js:402-406` | `sql/src/execute/agent-delivery.ts:36-50`、`sql/src/client/agent-stream.ts`、`sql/src/client/state/documents.ts:226-284` |
| P1-3 | 结果区/面板状态栏（连接·库·行数·耗时·页·只读/写） | `ref/src/client/Workbench.jsx:151-200` | `sql/src/client/components/WorkbenchPanel.tsx`/`SqlWorkbenchPanel.tsx` |
| P1-4 | 请求 token/Abort 覆盖执行/翻页/schema 刷新；错误退避与重试 | `ref/src/client/store.js:190-194,928-955,1117-1149`、`ref/docs/V3-体验问题与改进说明.md:954-962` | `sql/src/client/http-api.ts`、`schema-tree.ts`、`SqlWorkbenchPanel.tsx` |
| P1-5 | 快捷键作用域 + 快捷键说明（菜单可见=可用；不抢聊天框） | `ref/src/client/index.jsx:422-513`、`ref/docs/V3-体验问题与改进说明.md:809-869` | `sql/src/client/components/SqlEditor.tsx:170-222`、`sql/src/client/entry.ts` |
| P1-6 | 契约单源（tool/schema/errors 一张表派生 MCP + HTTP） | `ref/docs/PRD-v3.md:105-114` 的「增量表」写法 | 新增 `sql/src/contract/tools.ts`；`sql/mcp/server.ts:204-496` 改为表驱动 |
| P1-7 | `.sql` 文件链接 claim（`patterns`/`canOpen`/`title` 模式照抄） | `ref/src/client/index.jsx:317-348`、`ref/docs/V4-实施进展.md:26-32` | `sql/src/client/index.ts:76-90`（前提：脚本读写落地） |

### P2（打磨）

| # | 动作 | 参考依据 |
|---|---|---|
| P2-1 | 结果区查找（B6）与列显隐（B7） | `ref/docs/V3-体验问题与改进说明.md:34,215-225` |
| P2-2 | 对象树/结果 tab「预览 vs 固定」语义 | `ref/src/client/store.js:1505-1571` |
| P2-3 | 错误详情复制 + 通知历史 | `ref/docs/V3-体验问题与改进说明.md:999` |
| P2-4 | 设置页注册（`settings.section`）+ 快捷键可重绑 | `ref/src/client/index.jsx:415-420`、`ref/docs/M0-api-findings.md:16-17` |
| P2-5 | i18n/术语表/focus trap/ARIA 补齐 | `ref/docs/V3-体验问题与改进说明.md:942-971` |

---

## 12. 待验证 / 需拍板（交给 Lead）

1. **宿主 0.2.1 是否提供 `conversation.input.dock` 与 `inputActions`**（`captureInsertion/insertText/persistDraft`）。参考侧在 0.3/0.4 依赖它（`ref/src/client/index.jsx:187-199`）；data-ide 的 `contract/host.ts` 只建模了 sidebar/slots/locale，没有 conversation 面。若没有，P0-3 退化为「复制到剪贴板 + 提示」。
2. **`sidebarRight.openResource` 的 `params/kind/replaceTab/revealIfOpened` 在 0.2.1 是否可用**（参考侧用了：`ref/src/client/file-link.js:68-75`、`ref/src/client/index.jsx:61-68`）。data-ide 的 `host.ts:84-94` 只声明了 `preferNewPane/paneId`，是 0.1.7 面；需按 0.2.1 实测后扩类型。
3. **`sidebarRightTabs.patterns` 的匹配语义**（glob？前缀？长度优先？参考侧结论在 `ref/docs/V4-实施进展.md:31`）。决定 P1-7 是否可行。
4. **`resultId` 的生命周期**：内存 LRU？持久化？跨 MCP 重连是否稳定？建议：MCP server 无状态 → 由宿主/面板发布「结果注册表」到运行时目录（复用 console-registry 的通道，`sql/src/execute/console-registry.ts:11-24`），server 只读。
5. **`@` 引用是否需要 agent 侧解析**：若 MCP 工具要接受 `@result/...` 文本，需要写解析与「找不到/过期」的可行动错误；否则 `@` 只作为人读提示。
6. **与同事「工具面审计」的对账点**：本文从机制侧建议「可选 connId / resultId / isError / get_context」；同事可能从 schema/描述/参数设计侧提出重叠建议，建议 Lead 合并为一张「工具契约 v2」表，避免两份方案。
7. **参考侧取舍**：参考侧把「面向人的 UI 状态」当一等公民；data-ide 当前以「一份引擎两条路」为荣（`sql/docs/05-MCP-SPEC.md:12`）。建议保持后者，同时补上「共享对象模型（result/console/table 地址）」——两句话可概括为：**引擎共用已做到，对象共用还没做。**

---

*本文件是只读分析的产物，未对任何仓库做修改。*
