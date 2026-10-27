# 从 dsh-ide-workbench 借鉴什么：dsh-data-ide「工具顺手感」改造方案

> 性质：**方案分析，不改代码**。本文件由 Lead 汇总三份只读分析产出（末尾有索引）。
> 分析对象：`LiangshouX/dsh-ide-workbench` v0.4.0（MIT，已克隆到 `E:\dsh-plugin\ref-ide-workbench`）→ 目标插件 `dsh-data-ide`（`E:\dsh-plugin\dsh-data-ide`）。
> 运行环境实测版本：**DSH 0.2.1-rc.3**（桌面壳 `app.asar/package.json:4`；比 `AGENTS.md` 写的 0.2.1-rc.2 高一个 RC）。

---

## 0. 结论先行

### 0.1 一句话

**IDE Workbench 值得抄的不是功能，而是一套「人机共享对象 + 双向投影」的协议；dsh-data-ide 已经做到了「引擎共用」，缺的是「对象共用」。**

参考插件没有 MCP 工具（它是纯 UI 插件），所以不能照抄工具定义；但它解决了同一类问题：
**如何让人看到的东西可被 agent/聊天引用，如何让 agent 的产出回到界面，而不是只回一堆文字。**

### 0.2 五个判断

| # | 判断 | 依据 |
|---|---|---|
| 1 | data-ide「工具不顺手」的第一因不是工具少，而是**每次调用都要重新表达上下文**：6/9 个工具首参是 36 字符 UUID `connId`，翻页还要重传整段 SQL | 审计实测：查表结构 2–3 次、跑 SQL+翻 2 页 4–5 次、视图列 3–4 次且常失败、DDL/EXPLAIN **0 成功路径**、取消**不可达** |
| 2 | 第二因是**结果不可寻址**：`statementId` 只在语句结束后出现且不能预铸，`fetch_page` 不返回 `total`，没有 `resultId`/`consoleId` 回执 | 实测首页 `total=200569`，第二页 `total=null`；投递后拿不到 `consoleId`，无 `list_consoles` |
| 3 | 第三因是**失败不可行动**：驱动错误是 isError 纯文本（无 code/hint，行号还因分页包裹 +1），拒绝却是「成功调用」，同一失败有四套形态 | 实测 `SHOW TABLES`/`SELEC 1`/权限拒绝/空结果四类返回 |
| 4 | 最大的「抄点」是参考插件的三条机制：**共享地址词汇**、**动作继承当前选择**、**统一可行动失败**；落地手段在 0.2.1 都有公开 API（已逐条核查） | 见 §2、§3 与 `dsh-feasibility-notes.md` |
| 5 | 高性价比顺序：**先改工具契约（1 周内、零 UI 风险）→ 再做聊天↔工作台双向通道（2–3 周）→ 最后补人侧手感** | 见 §5 里程碑 |

### 0.3 建议先做的最小包（M1，约 3–5 人日）

只动 MCP 契约与共享层，不动 UI：
1. 工具描述 + 参数 `.describe()` + MCP `server instructions`（发现性）
2. 失败统一 `isError:true` + `code/message/hint/nextAction`，`db-error` 翻译下沉到共享层
3. `list_datasources` 补 `activeId/database`，6 个工具 `connId` 改可选（宿主发布 active）
4. `execute_sql` 返回 `resultId`，`fetch_page` 支持句柄；补预铸 `statementId`，修 `cancel` 假成功
5. 暴露 `raw`（SHOW/DESC/EXPLAIN/SHOW CREATE）与人侧已有的 `sort/filters`（共享引擎本来就支持）

做完这一包，**常见任务的调用次数与重复载荷会明显下降**，且不改变任何界面、不碰 AC-1~AC-8。

---

## 1. 先厘清：参考插件有什么、没有什么

| 维度 | dsh-ide-workbench | dsh-data-ide |
|---|---|---|
| 形态 | 纯 UI 插件：右栏 JetBrains 式工作台 + Host JSON API（`/ide-workbench/api/<method>`）+ 终端 WS；**无 MCP 工具** | 右栏 SQL 工作台 + **MCP server（serverName `sql`，9 个工具）** + 宿主 HTTP 路由 |
| 与 agent 协作方式 | 全部通过**聊天**：聊天文件链接→工作台打开定位；工作台右键「发送到聊天框」 | 全部通过**工具**：agent 调 `mcp__sql__*`；结果靠带 `label` 的投递进面板 |
| 「上下文」 | 会话/工作区里解析一次（默认项目根、git toplevel、终端 cwd），动作继承 | 每次调用重新传 `connId` + SQL |
| 「对象」 | 文件有 `@path` 语法、`dsh-resource://file/...` 地址、`#L24` 行号；标签/结果都按地址寻址 | 结果只有一次性 JSON；无 `resultId`、无 console 地址、无"当前结果" |
| 「失败」 | 一个 `{ok:false,error:{code,message}}` 信封 + 状态码语义 + 可操作文案 | 四套形态（isError 文本 / `ok:false` / 语句内 `EXEC_ERROR` / 静默空） |
| 「状态」 | store 生命周期=插件，按工作区共享，防抖+原子写，切面板不丢 | console 是纯客户端状态，刷新即丢；页面类型未 `keepMounted` |

**结论**：可抄的是**协作协议与工程纪律**（§2），不是「终端/Git/文件树」这些舞台不同的功能（§3.8 列出不抄清单）。另外参考插件是 MIT，**纯函数级构件可以复制**（需署名），状态机/UI/构建产物不要搬（见 §3.9）。

---

## 2. 可借鉴的七条机制（总表）

> 每条都给「参考证据 → data-ide 现状 → 怎么抄 → 评级」。
> 缩写：`REF/`=`ref-ide-workbench/`，`SQL/`=`dsh-data-ide/packages/client/ui-sql-workbench/`，`HOST/`=`app.asar/dsh/node_modules/@deepseek-ai/`。

| # | 机制 | 参考证据 | data-ide 落点 | 评级 |
|---|---|---|---|---|
| M1 | **共享地址词汇**：人看到的一切能写成聊天/代码里的地址，agent 输出的地址人能一键落到位置 | `REF/src/client/chat-bridge.js:76-83,136-143`；`REF/src/client/file-address.js:29-124` | `resultId` + `dsql://` 地址 + toolview 卡按钮 + `.sql` 链接 claim | **P0** |
| M2 | **动作继承当前选择**：默认根/上下文在会话里解析一次，显式参数只用于覆盖 | `REF/src/index.js:72-95,100-122,480-488`；`REF/src/client/store.js:527-534` | 宿主发布 `activeConnId`；工具 `connId` 可选；新增 `get_context` | **P0** |
| M3 | **双向零成本投影**：UI→聊天是插入 composer（不覆盖选区、失败可见）；聊天→UI 是 claim 地址并定位 | `REF/src/client/chat-bridge.js:48-67`；`REF/src/client/file-link.js:68-102` | 「发送到聊天框」+ 结果卡「在工作台打开」+ 右栏带参 | **P0** |
| M4 | **统一失败语义**：一个信封 + 机器码 + 人话 + 下一步 | `REF/src/host/wire.js:10-22,65-88`；`REF/docs/V3-体验问题与改进说明.md:981` | MCP `isError` + 四件套 + 共享 `db-error` 翻译 | **P0** |
| M5 | **状态属于工作台**：切会话/面板不丢，落盘防抖+原子写，恢复标签/布局 | `REF/src/client/store.js:1-8,692-736`；`REF/src/host/settings-store.js:196-219` | `keepMounted` + console 持久化（B4）+ 执行中语句不因切面板取消 | P1 |
| M6 | **默认安全 + 可发现**：破坏性确认默认焦点在取消、只读内容可复制、入口冗余、状态常驻 | `REF/src/client/ui.jsx:116-164`；`REF/docs/V3-体验问题与改进说明.md:669-697` | 写 SQL/DDL/删连接确认框；结果/DDL 可复制；状态栏 | P1 |
| M7 | **单一 API 面 + 契约只增不改**：一个入口、一道围栏、一次往返带齐 | `REF/src/index.js:43,263-276,436-464`；`REF/docs/PRD-v3.md:105-114` | 新增 `src/contract/tools.ts` 单源；HTTP/MCP 同信封；一次返回 `nextOffset` | P2 |

**总纲一句话**：参考插件把「人看到的」变成**可寻址、可继承、可回放**的对象；data-ide 当前的工具体系只有「动作」，没有「对象」。这是"不顺手"的机制根源。

---

## 3. 逐项方案

### 3.1 【P0-A】上下文默认值：让工具知道「你在哪」

**参考怎么做**：`repoEnv()` 以请求 root 为工作区、自动探测 git toplevel 并做路径换算（`REF/src/index.js:72-95`）；`workspace.list` 返回 `defaultRoot`（`:100-122`）；终端 cwd 缺省=根、shell 缺省=设置（`:480-488`）。调用方永远只说相对路径。

**data-ide 现状**：6 个工具首参必填 `connId`（`SQL/mcp/server.ts:238,273,297,320,378,471`），connId 是 36 字符 UUID；宿主发布的 `conn-specs.json` 只有 `connections`、**没有 active**（`SQL/src/host/runtime-specs.ts:40-45`），而人侧明明有 active（`SQL/src/datasource/store.ts:98-105`、`host/web-routes.ts:141-143`）。

**怎么抄（设计）**：
1. 宿主发布 active 上下文：`conn-specs.json` 升 `schemaVersion: 2`，增加
   `activeConnId`、`consoles: [{id,label,owner}]`、`updatedAt`；连接变更/切换/console 激活时防抖写。
   > 约束：M1 仍是唯一通道、0600、原子写；`SQL/mcp/runtime-specs.ts:37-47` 的解析器要同步保留新字段（现在会丢未知字段）。
2. 6 个工具 `connId` 改 **optional**：缺省用 active；无 active 时返回
   `NO_ACTIVE_CONNECTION` + `hint: "可用连接: Doris(3762ecba…)、…；先调用 list_datasources"`。
3. 新增只读工具 **`get_context()`** → `{activeConnId, datasources, activeConsole?: {id,label,sql}, recentlyExecuted?}`（等价于参考插件"工作台知道你在哪"）。
4. `list_datasources` 补 `activeId` 与每连接 `database/lastTestState`（参考 `defaultRoot` 思路：让调用方不必自己算默认）。
5. 未来可选：`execute_sql({useCurrent: true})` 直接跑当前编辑器/选区 SQL（参考机制 M3 的反向）。

**验收**：
- 用户已激活连接时，`get_schema({table:"orders"})` / `execute_sql({sql:"SELECT 1"})` 不带 `connId` 可成功；
- 无连接时错误含可用列表与下一步；
- agent 从「list_datasources → 抄 UUID → 调用」变成「直接调用」。

### 3.2 【P0-B】结果对象：`resultId` + `dsql://` 地址

**参考怎么做**：文件地址语法 `dsh-resource://file/session/<sid>/<path>` + `#L24` 行号（`REF/src/client/file-address.js:29-54,163-186`）；一次往返带齐（`git.status` 永远返回 ignored 条目，`REF/src/index.js:263-276`）。

**data-ide 现状**：`fetch_page` 必须重传 `{connId,sql,offset,pageSize}`（`SQL/mcp/server.ts:471`）；`fetchPage` 恒返回 `total:null`（`SQL/src/execute/core.ts:407`）；`statementId` 每页新铸、结束即 forget（`core.ts:394,374`）；`execute_sql` 不接受预铸 `statementId`（`server.ts:319-325`，而 `docs/05 §3.2` 却写了有这个参数——契约漂移）。

**怎么抄（设计）**：
1. `ExecuteRequest` 已有 `statementId?`（`SQL/src/execute/core.ts:82`）——**只需在 MCP schema 暴露**，让 agent 能在同一轮内先铸 id 再（并行）取消。
2. MCP 进程内维护 **结果注册表**（LRU，如 32 条，条目：`{resultId, connId, sql, pageSize, total, createdAt}`）：
   - `execute_sql` / `execute_script` 返回 `resultId`；
   - 新增/改造 `fetch_page({resultId, offset, pageSize?})`（`connId/sql` 保留为兼容旧形态）；
   - `fetch_page` 返回 `total`/`pageSize`/`nextOffset`/`totalKnown`；
   - 定义失效语义：进程重启/连续 10 次失败注销后返回 `RESULT_EXPIRED` + hint（重跑 SQL）。
3. 稳定输出 JSON：`define schemaVersion: 2`，字段固定、命名稳定（为 §3.3 的聊天卡与将来的导出/资源复用）。
4. 地址语法（人类可读、可出现在聊天与日志）：
   `dsql://<conn>/<schema>/<table>`（对象）、`dsql://result/<resultId>`、`dsql://console/<consoleId>`。只做解析/格式化纯函数 + 引用提示，**不承诺聊天自动变成可点链接**（宿主只认文件链接）。
5. `cancel_statement` 未命中返回 `{cancelled:false, code:"STATEMENT_GONE"}`，不再假成功。

**验收**：
- 翻 3 页只有第 1 次带 SQL；第 2 页起只传 `{resultId, offset}`；
- 首页 `total` 在后续页保持可见；
- 同一轮内 `execute_sql({statementId:"q-1"})` 可被 `cancel_statement({statementId:"q-1"})` 命中；
- 取消不存在 id 返回 `cancelled:false`。

### 3.3 【P0-C】聊天内结果卡：把「结果留在 UI、对话只留摘要」

**参考怎么做**：IDE 的所有产出都落在面板里，聊天只是入口/出口（README「与聊天协作」；`REF/src/client/index.jsx:317-348` 的 tab claim）。

**data-ide 现状**：`execute_sql` 默认把最多 500 行（≈88KB，宽表 ~750KB）JSON 塞进对话；投递只在 `label` 分支（`SQL/mcp/server.ts:362-364`），返回体无 `consoleId`，无 `list_consoles`，`fetch_page` 不能投递。

**怎么抄（设计）**：
1. 闭合投递环：
   - `execute_sql/execute_script` 增加 `deliver?: boolean`（缺省 false；`label` 仍等价开启）；返回 `delivered?: {label, consoleId}`；
   - 新增 `list_consoles()`（id/label/owner/unread/lastActivity）与 `deliver_result({label, sql, resultId?})`；
   - `fetch_page` 支持 `label/consoleId` 投递翻页（面板不用重跑）。
2. 客户端注册 **`tool.call.toolview`**（key = wire 名 `mcp__sql__execute_sql` / `execute_script` / `get_schema` / `list_tables`）：
   - 三种 phase（preparing/start/result）都要容错；结果文本按 stable JSON 解析（MCP 桥只给渲染后的 text，`HOST/dsh-client-ui-tool` 的槽目录明确「任意 wire 名可注册」）；
   - 卡内容：SQL 摘要（可折叠）、行×列、耗时、前 3 行迷你表、错误码+hint；
   - 按钮：有 `delivered.consoleId` → 「在 SQL 工作台打开」；无 → 显示「未投递到面板」提示（或引导 agent 传 `deliver:true`）。
   - 打开方式不依赖宿主 params：插件 client 与面板同一个 bundle，用**模块级 store 传递 `{consoleId}` + `ctx.sidebarRight.openTab(TAB_KIND)`**，面板消费 pending focus（规避 0.2.1 `navigation.params` 的类型合并与运行时风险）。
3. 助手侧「回合尾部卡」可选（`conversation.chat.turnTail`，低风险）：汇总「本回合 agent 投递了 N 个 `ai_*` 结果」，点击开对应 console。v1 可先不做。
4. **失败也要有卡**：isError 的结果卡显示 code/hint/nextAction（见 P0-D）。

**验收**：
- agent 跑一条 500 行查询且 `deliver:true`：对话里只出现摘要卡；点按钮打开 `ai_*` console 并看到完整网格；
- 宽表（110 列）不再把整页 JSON 灌进上下文；
- 卡在 `execute_script` 多语句、错误、空结果三种情况下不崩。

### 3.4 【P0-D】统一可行动错误

**参考怎么做**：`ApiError(code,message,status)`；git stderr 原样带出；未知异常→500 internal；错误按动作命名（`REF/src/host/wire.js:10-22,70-88`；`REF/docs/V3-...md:981`）。

**data-ide 现状**：同一失败有四套形态——MCP isError 纯文本（驱动原文，行号被分页包裹 +1）、`{ok:false,error}` 普通成功调用、`execute_script` 内联 `EXEC_ERROR`、`get_schema` 未命中静默 `{ok:true,tables:[]}`；人话翻译 `db-error.ts` 只在浏览器半（`SQL/src/client/db-error.ts:41-65`），MCP 侧没有。

**怎么抄（设计）**：
1. 所有工具失败 → `content` 里仍给结构化 JSON，但 **`isError: true`**（宿主 mcp-client 会把它抛成工具失败，模型看到 `Error:`，`HOST/dsh-mcp-client/lib/index.js:231-236`）。
2. 统一错误体：`{ok:false, error:{code, message, hint?, nextAction?, stage?, statementIndex?, lineOffset?}}`；覆盖 `docs/05 §4` 既有码，新增 `RESULT_EXPIRED/NO_ACTIVE_CONNECTION/EXEC_MULTI/METADATA_FORBIDDEN` 等。
3. 把 `db-error.ts` 翻译逻辑下沉到 `src/execute/db-error.ts`（纯函数），MCP 与面板共用；行号按包裹偏移回正，或直接标「错误行号=你的 SQL 第 N 行」。
4. `execute_sql` 多语句不再静默丢弃：返回 `EXEC_MULTI` 或提示改用 `execute_script`；`get_schema` 空结果区分「不存在/无权限/前缀写错」并给近似建议；`SCHEMA_UNAVAILABLE` 拆分 `CONN_NOT_FOUND` 与 `NO_PASSWORD`。
5. `execute_sql` 默认输出预算：新增 `maxRows`（agent 缺省 200，面板不变）与 `columnsOnly?`；保留 `pageSize` 作为页大小语义（D4/AC-2/AC-3 不变）。

**验收**：语法错误 / 权限拒绝 / 表不存在 / 超时 / 取消 五类错误，模型侧都能看到 `isError` 且带 `code+hint+nextAction`；行号与用户 SQL 一致。

### 3.5 【P0-E】「发送到聊天框」：人→agent 的单向桥梁（可抄代码）

**参考怎么做**：`conversation.input.dock` 注册隐形组件拿 `inputActions`（`REF/src/client/index.jsx:187-199`）；插入时塌陷选区到末尾、补空格、成功后 `persistDraft()`、失败 toast（`REF/src/client/chat-bridge.js:48-67`）；代码选区=`@file (L12-L20)` + 围栏代码块，超限截断并标记（`:136-143`）；入口冗余（树右键/编辑器右键）。

**0.2.1 可行性（已核对）**：`conversation.input.dock` 存在（session 作用域 list）；standardProps 含 `inputActions`；`InputActions` 提供 `captureInsertion/insertText`（`HOST/dsh-client-ui-conversation/README.md:165`），`persistDraft` 在实测代码中存在；只能插**纯文本**（结构化 @ chip 不可编程，但发送后 `@path` 会被 ui-reference 渲染成引用）。

**怎么抄（设计）**：
1. 新增 `SQL/src/client/chat-bridge.ts`（可复用参考的纯函数，按 MIT 署名）：`formatSqlMention / fenceLabelForPath / composeCodeReference / composeResultReference / insertChatText`。
2. 在 `client/index.ts` 注册隐形组件到 `conversation.input.dock`，把 `inputActions` 存进模块级 store（按 sessionId）。
3. 三个入口/模板：
   - 编辑器选中 SQL → 右键「发送到聊天框」：`sql` 围栏代码块 + 一行上下文「连接 Doris · 库 dwd」；
   - 结果区选中单元格 → `tsv` 围栏（≤50 行 / 8KB，超限标 `… (truncated)`）；
   - 对象树表/列 → 纯文本「表 `dwd.orders`（连接 Doris，112 列）」+ 列名摘要。
   若将来脚本文件落地，再升级为 `@scripts/xxx.sql (L12-L20)` 引用。
4. 行为纪律照抄：不覆盖用户已有输入、不抢焦点、composer 不在时 toast「暂时无法写入聊天输入框」。

**验收**：结果区/编辑器/对象树三处右键都能插入；聊天框有选区时不被覆盖；插入内容发送后模型可读；composer 关闭时有可见失败提示。

### 3.6 【P1-F】右栏连续性：`keepMounted`、双 pane、`.sql` 链接

**0.2.1 事实（比 `AGENTS.md` 认知新）**：`sidebarRightTabs.register` 支持 `keepMounted/multiple/patterns/priority/canOpen`（`HOST/dsh-client-ui-sidebar-right/README.md:83,86,106`）；`openTab/openResource` 支持 `paneId/replaceTab/revealIfOpened/params`；右栏已有**双水平 pane + 浮动面板**（`:50,72,121`）。`AGENTS.md:123` 的「对话分屏 / per-pane 右栏 0.1.7 起就无」在 0.2.1 已过时。

**抄什么**：
1. **立刻**：`sidebarRightTabs.register({..., keepMounted: true})`——切聊天/切会话不销毁面板，执行中语句与结果不丢（参考的终端教训：`REF/docs/V3-...md:699-730`）。
2. 二期：agent 投递可开在第二 pane（`openTab(kind,{preferNewPane:true})` 或 `paneId`），不打断用户当前 tab；需要先决定页面类型是否改为 `multiple:true` + 按 console 参数实例化（中等改动，先 spike）。
3. `.sql` 文件链接 claim：`patterns:['*.sql']` + `canOpen` 检查扩展名（0.2.1 glob 语义已确认）；**但脚本读写工具（list/read/write_script）尚未实现**（`docs/05 §3.3` 未实现），所以先做 P2，等脚本落地后再接；否则会抢走 `.sql` 文件的正常预览却打不开。

**验收**：长查询执行中切到聊天再回来，查询仍在、结果仍在；未读/活动 tab 状态正确；keepMounted 不导致内存/状态泄漏（需观察）。

### 3.7 【P2-G】人侧手感（借原则，不借代码）

| 项 | 参考原则 | data-ide 落点 | 来源 |
|---|---|---|---|
| 确认框默认焦点在「取消」 | 危险按钮永不默认聚焦，Esc/遮罩取消 | 写 SQL/DDL/删除连接/取消执行 | `REF/src/client/ui.jsx:116-164` |
| 只读内容可复制 | 不要全局 `user-select:none` | 结果网格/DDL/错误详情/连接信息 | `REF/docs/V3-...md:669-697` |
| 常驻状态栏 | 连接·库·方言·行数·总行数·耗时·只读/可写·页大小 | 工作台底栏（目前无） | `REF/src/client/Workbench.jsx:151-200` |
| 结果区查找 / 列显隐 | 高频手感 | 已是 `docs/09` 的 B6/B7 | `REF/docs/V3-...md:34,215-225` |
| 快捷键作用域 | 菜单可见=快捷键可用；不抢聊天框 | `Ctrl+Enter` 只在编辑器聚焦时执行 | `REF/docs/V3-...md:809-869` |

### 3.8 不要抄的部分（重要）

| 项 | 原因 |
|---|---|
| 终端/PTY、Git adapter、文件树/fileops、Diff/Markdown/QuickOpen | 舞台不同；SQL 工作台的对象是远程元数据，不是本地 FS |
| 参考的 `store.js`（2600+ 行状态机）、全部 JSX/styles/locale、`dist/client.js` | 领域/令牌/构建链不同；复制会带来大量死代码（`REF/dist/client.js` 2.4MB） |
| 完整 JetBrains 快捷键体系 | 右栏宽度有限、数据工作台场景集中；只借"作用域+可发现"原则 |
| 布局引擎 Docked/Floating/Split/Stripe | 右栏已选定简单两栏；只借"记住宽度/窄屏折叠" |
| MCP 注解/进度/elicitation/资源订阅 | 0.2.1 的 mcp-client 不读/不转发（`HOST/dsh-mcp-client/lib/index.js:130-149,596-609`） |
| 把 MCP 工具改成 native host 工具 | Web 客户端**不消费** `presentCall/presentResult`（`HOST/dsh-tools/README.md:95`），改完得不到聊天渲染收益；还会改动已冻结的 MCP 可见性契约（AC-5）与 `05-MCP-SPEC`，成本高收益低 |
| 新建 Chat 行类型承载 agent 结果 | kind 表被 ui-chat 固定，事件类型受限；用 `toolview`/`turnTail` 替代 |
| `.sql` claim（现在） | 脚本读写未实现，claim 会把文件"抢"进一个打不开的页面 |
| MCP 工具代理 host（单执行链） | 能消灭双写/竞态，但成本高（origin+token、重试、降级）；本轮不做，spool 兜底够用 |

### 3.9 可复制的代码级构件（MIT）

| 构件 | 规模 | 怎么用 |
|---|---|---|
| `REF/src/client/chat-bridge.js` 的 `formatFileMention/fenceLabelForPath/composeCodeReference/insertChatText` | 143 行，纯函数 | 改写成 SQL 版 `chat-bridge.ts`，换 `@` 语法与模板；插入语义照抄 |
| `REF/src/client/file-address.js` 的解析/归一化/编码 | 199 行，纯函数 | 改写成 `dsql://` 地址解析器 |
| `REF/src/host/wire.js` 的 `ApiError` + 窄化校验 + writeOk/writeError | 128 行，零依赖 | 改写成 `SQL/src/shared/wire.ts`；与 zod 不冲突（HTTP 侧用） |
| `REF/src/client/ui.jsx` 的 ConfirmModal 焦点策略 | ~20 行核心 | 按语义重写（默认取消/Esc/遮罩） |
| `REF/src/host/settings-store.js` 的 deepMerge + 原子写 + 串行 update | 小 | console 持久化（B4）时参考 |

**MIT 义务**：复制任何片段都要保留版权与许可声明；建议建 `THIRD-PARTY-NOTICES.md`，每个改编文件头留 2 行出处。参考插件是 MIT 公开源码，不属于 `AGENTS.md` 里禁止复用的 DataGrip 逆向材料范围。

---

## 4. 工具契约 v2 草案（P0 的落地形态）

> 约束：JSON Schema 子集（禁 `oneOf`）；工具名 `snake_case`；入参变更=minor + 迁移说明（`docs/05 §8`）；宿主发布通道不变（M1）；server 无状态（D5，结果注册表只在 MCP 进程内存）。

### 4.1 工具面变化总表

| 工具 | 现在 | v2 建议 | 收益 |
|---|---|---|---|
| `get_context` | — | **新增**：无参 → active 连接/console/最近执行 | 会话入口 1 次搞定，替代「list_datasources→抄 id」 |
| `list_datasources` | `{ok,payload:{datasources}}`（无 database/active） | 补 `activeId` + 每连接 `database/lastTestState` | 少一次询问/猜测 |
| `test_connection` | `{connId*}`，无 durationMs/不写缓存 | `connId?`；补 `durationMs`；写回 databaseInfo 缓存 | 与面板同口径 |
| `get_schema` | `connId*`、`table?`、`refresh?`；视图列空、未命中静默空 | `connId?`；视图列回退 `SHOW FULL COLUMNS`；未命中给 `NOT_FOUND/SUGGEST` | 消除"视图死路"与静默空 |
| `list_tables` | `connId*`、`refresh?` | `connId?` | 上下文继承 |
| `execute_sql` | `connId*,sql*,pageSize?,label?,consoleId?`；500 行无字节预算；无 raw/sort/filters；多语句静默丢弃 | `connId?`；`sql?`（或 `useCurrent`）；`maxRows?`（agent 缺省 200）；`columnsOnly?`；`raw?`；`sort?`；`filters?`；`statementId?`；`deliver?`；返回 `resultId` 与 `nextOffset`；多语句 → `EXEC_MULTI` | 一次调用即得"能看的结果"；DDL/EXPLAIN 可用 |
| `execute_script` | `connId*,sql*,pageSize?,maxStatements?,label?,consoleId?`；500 行预算只喂第 1 条 | `connId?`；`statementRows?`（每语句预算）；`stoppedAt`；`resultId` | 第 2/3 条结果可读 |
| `fetch_page` | `connId*,sql*,offset*,pageSize?`；`total` 恒 null | `resultId`（必需或与旧形态二选一）；返回 `total/pageSize/nextOffset`；可 `label/consoleId` 投递 | 翻页不再重传 SQL |
| `cancel_statement` | `statementId*`；永远 true | 未命中 `cancelled:false` + code；配合 `statementId` 预铸 | 取消真正可达 |
| `list_consoles` | — | **新增**：id/label/owner/unread/lastActivity | 能找到/复用 ai_ console |
| `deliver_result` | — | **新增**（可选）：把"SQL+说明"投递到面板，不执行 | 人机交接 |
| `ping` | 有 | 保留（不占上下文可考虑 `deferLoading`，需宿主支持确认） | 诊断 |

### 4.2 描述与 instructions（最低成本、最高感知）

**示例（`execute_sql`）**
> 现在：「执行一条语句并返回首页（500+1 探针）与总行数；默认只允许 SELECT。带上 label 时结果同时投递到面板的 ai_<label> 控制台。」
>
> v2：「执行单条 SQL 并返回结果首页。用于需要真实数据或验证 SQL 的问题；用户已选连接时可省略 `connId`。默认最多返回 200 行；多语句会被拒绝，请改用 `execute_script`。返回 `resultId`，翻页用 `fetch_page(resultId, offset)`，不要重传 SQL。需要让用户在面板看到结果时传 `label` 或 `deliver:true`。」

要点（按 `agent-experience`）：**描述行为不描述实现**；每个参数的默认值/范围/何时设置写在参数 `.describe()` 上；说清"何时用/何时不用/下一步"；错误信息只说一次。
**参数命名不改**：现有 `connId/pageSize` 是 camelCase，`docs/05` 的 `snake_case` 规则理解为"工具名命名"；大面积改参数名只会制造迁移成本，除新增参数外保持现状（若确要对齐，单独 RFC，不混在本次）。

**MCP `server instructions`**（≤32KB，自动进系统提示，`HOST/dsh-mcp-client/README.md:187-191`）建议正文 &lt;2KB：
```
- 数据源：先 get_context 拿 active 连接；用户没指定连接时不要猜。
- 结构：先 list_tables（便宜）→ get_schema(table)（只取一张表）；视图列可能为空，用 raw:"SHOW FULL COLUMNS FROM ..." 回退。
- 执行：单条用 execute_sql；多语句用 execute_script；翻页用 fetch_page(resultId)，不要重传 SQL。
- 让用户看到：需要看结果时传 label（语义名）或 deliver:true；不要为探索性查询投递。
- 失败：看 error.code/hint/nextAction；RESULT_EXPIRED 表示重跑 SQL。
```

> 注意：instructions 超限会**拒绝连接**（`HOST/dsh-mcp-client/lib/index.js:654-656`），实现时要测字节数。

### 4.3 一次典型任务的调用形状（改造后）

| 任务 | 现在 | v2 |
|---|---|---|
| 查一张表结构 | `list_datasources` → `get_schema(connId,table)`（2–3 次，UUID×2） | `get_schema({table})`（1 次） |
| 跑 SQL + 翻 2 页 | `execute_sql(connId,sql)` → `fetch_page(connId,sql,offset)×2`（3 次，SQL×3） | `execute_sql({sql})` → `fetch_page({resultId,offset})×2`（3 次，SQL×1） |
| 让用户看到结果 | 传 label，返回无 consoleId | `deliver:true` → 返回 `{label,consoleId}`，聊天出摘要卡 |
| 出语法错 | isError 纯文本、行号 +1 | `isError` + `{code:"SQL_SYNTAX", message,hint,lineOffset:0}` |
| 视图列 | 3–4 次且常失败 | `get_schema({table})` 走 `SHOW FULL COLUMNS` 回退（1 次） |

---

## 5. 里程碑与验收

> 纪律：每个里程碑先写失败测试（C6 per-file 100%）、同步 `docs/05/10/09/07/00 §9`（C10）、不动 `AGENTS.md` 已定决策 D4/D5/D8/D10/D12（除非用户拍板）。

| 里程碑 | 内容 | 工作量 | 风险 | 验收 |
|---|---|---|---|---|
| **M1 契约降摩擦**（P0-A/B/C/D 的纯契约部分） | active 上下文发布 + connId 可选 + get_context；resultId/fetch_page/statementId/cancel；isError + 四件套 + db-error 下沉；raw/sort/filters；maxRows/columnsOnly；描述 + `.describe()` + instructions；list_datasources/get_schema 补字段与回退 | 3–5 人日 | 低（只动契约与共享层；MCP 契约 minor 迁移） | 上表 §4.3 全部成立；现有 51 个测试文件全绿 + 新增单测；AC-1~AC-8 不回归 |
| **M2 结果进 UI**（3.3） | 投递闭环（deliver/consoleId/list_consoles）+ `tool.call.toolview` 卡 + 打开工作台 | 3–5 人日 | 中（客户端新座位、需 dev profile spike） | 500 行查询只回摘要卡；点开看到完整网格；脚本/错误/空结果三态不崩 |
| **M3 双向通道**（3.5 + 3.6-1） | 发送到聊天框（composer 桥 + 三模板）+ keepMounted | 2–3 人日 | 低-中（纯文本插入；只影响本插件） | 三处右键可插入；不覆盖选区；失败 toast；切面板执行不丢 |
| **M4 人侧手感 + 深化**（3.6-2/3、3.7、M7） | 第二 pane 投递（spike 后）、`.sql` claim（脚本落地后）、状态栏、B4/B5/B6/B7、契约单源 | 5–8 人日 | 中 | 按各条验收；不破坏现有布局 |

**建议**：本会话先做 **M1**（或只做 M1 里的 1–3 项）。M1 不碰 UI、不改布局、不动现有 AC，是最稳的"立刻变顺手"。

---

## 6. 风险与待拍板

### 6.1 已知风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| MCP 契约变更影响现有使用习惯 | 默认行数 500→200、多语句从"静默丢弃"变"报错"、新增可选参数，都是语义变更 | minor + 迁移说明；保留旧参数别名一版；`docs/05 §8` |
| `tool.call.toolview` 对 `mcp__sql__*` 的 dispatch | 槽目录说"任意 wire 名可注册"，但 MCP 前缀名未实测 | dev profile 做 1 个 spike：注册卡 → 调一次工具 → 看是否渲染 |
| `resultId` 生命周期 | MCP 进程内存，重启/注销即失效 | 返回 `RESULT_EXPIRED` + 重跑 hint；LRU 上限 32 |
| 双 pane / keepMounted 行为 | 0.2.1 新能力，boundary 行为需实测 | 先用 `keepMounted`；双 pane 单独 spike |
| 客户端 inspect 曾超时 | 本次 scout 侧 4 次 10s 超时（Lead 侧正常） | 以 slot 目录 + 包 README + 在跑源码交叉验证；实现前再实测一次 |
| 测试耗时 | B11：全量已 ~2m15s | 新增单测优先纯函数；M1 不给 UI 加测试负担 |
| 版本基线过时 | `AGENTS.md` 写 0.2.1-rc.2；实际 rc.3；14 条 spec 漂移 | 方案落地前先做一次"文档对齐"小任务 |

### 6.2 需要你拍板的 3 件事

1. **范围**：本轮只做 M1（纯契约，3–5 天，零 UI 风险），还是 M1+M2（加聊天结果卡，约 1.5–2 周）？
2. **版本/文档**：是否把基线更正为 0.2.1-rc.3，并修正 `AGENTS.md`「无双 pane」等过时断言 + `docs/05` 的 14 条漂移（建议"是"，否则契约冻结是假的）？
3. **契约演进方式**：工具契约 v2 是一次性 minor 升级（新增可选参数 + 默认值变化 + 迁移说明），还是先只做纯增量（描述/instructions/isError/activeConnId，不改参数名与默认值）？

---

## 7. 证据索引

| 文件 | 内容 |
|---|---|
| `analysis/ref-notes.md` | 参考插件可借鉴机制（M1–M6、Top10 手感、V3 体验问题归纳、MIT 合规、P0/P1/P2 清单） |
| `analysis/data-ide-notes.md` | data-ide 工具面审计（9 工具表、典型任务调用成本、a–j 缺陷、14 条 spec 漂移、人侧对照 21 行、console 机制、最高杠杆 5 候选、20 次运行时实测） |
| `analysis/dsh-feasibility-notes.md` | 宿主扩展面核查（工具注册/渲染限制、chat 输入面、右栏 0.2.1 事实、MCP 能力清单、user-actions 推荐架构、不可行清单、T1–T15 可行性表） |
| 参考仓库 | `E:\dsh-plugin\ref-ide-workbench`（MIT，v0.4.0） |
| 目标仓库 | `E:\dsh-plugin\dsh-data-ide`（工作区另有 67 个未提交改动，行号以当前工作区为准） |

*本文件是方案分析产物；未修改 `dsh-data-ide` / `ref-ide-workbench` 任何文件，未安装/启停插件。*
