# dsh-data-ide：agent 工具面审计（只读）

> 任务：task-2。目标 = 指出「dsh-data-ide 的工具用起来不顺手」的可证据化根因，供后续方案引用。
> 性质：只读分析。未修改 `dsh-data-ide` 任何文件、未安装插件、未启停服务；本文是本次唯一写入。
> 基线：仓库 `E:\dsh-plugin\dsh-data-ide`，分支 `feat/M0-scaffold-and-registration`，HEAD `569f8b7`（2026-10-20），**工作区另有 67 个未提交改动**（即 2026-10-21「批次 8」的 agent console 代码，含 `mcp/server.ts`、`docs/05`）。本文所有行号按**工作区当前内容**。
> 运行时：桌面端 dsh 0.2.1-rc.2（desktop profile）。实测时间 2026-10-26 23:00 前后，MCP 进程在线，`mcp__sql__*` 9 个工具可用，已配置 1 个 Doris 连接（`3762ecba-…`，`writeEnabled:false`）。

**路径缩写**（全文引用格式 `path:line`）

| 缩写 | 实际路径 |
|---|---|
| `sql/` | `packages/client/ui-sql-workbench/`（包 `dsh-data-ide`） |
| `docs/` | `dsh-data-ide/docs/` |
| `AGENTS.md` | `dsh-data-ide/AGENTS.md` |
| 「实测」 | 本文用 `mcp__sql__*` 真实调用得到的结果（附录 §10.2 有原始记录） |

**目录**：§0 一页结论 · §1 约束清单 · §2 运行时工具面 · §3 典型任务调用成本 · §4 ergonomics 缺陷 a–j · §5 spec 漂移 · §6 人侧 vs agent 侧 · §7 agent console 机制 · §8 已记录痛点 · §9 最高杠杆 5 候选 · §10 证据索引与待验证

---

## 0. 一页结论

### 0.1 五条根因（按杠杆排序）

| # | 根因 | 一句话证据 |
|---|---|---|
| R1 | **没有「当前上下文」**：`connId` 是全工具面的必填 36 字符 UUID，而人侧的「激活连接 / 默认库」从未发布给 MCP 进程 | 6 个工具首参都是 `connId`（`sql/mcp/server.ts:238,297,320,379,471`）；宿主发布的 spec 文档只有 `connections`、没有 active（`sql/src/host/runtime-specs.ts:40-45`），而人侧有 active（`sql/src/datasource/store.ts:98-105`、`sql/src/host/web-routes.ts:141-143`） |
| R2 | **没有「结果句柄」**：翻页要重传整段 SQL + connId，`total` 不随页返回，`statementId` 只在语句跑完后才给你、且不接受预铸 | `fetch_page` 入参 = `{connId,sql,offset,pageSize}`（`sql/mcp/server.ts:471`）；`fetchPage` 恒返回 `total:null`（`sql/src/execute/core.ts:407`）；`execute_sql` 不接受 `statementId`（`sql/mcp/server.ts:319-325`），人侧却预铸 `ui-<n>`（`sql/src/client/state/query.ts:49-52,95-100`） |
| R3 | **没有「结果可见」的闭环**：只有带 `label` 的 `execute_sql`/`execute_script` 才投 UI，而调用方拿不到 `consoleId`、没有 `list_consoles`，`fetch_page` 根本不能投递 | 投递只在 label 分支（`sql/mcp/server.ts:364,433`）；返回体不含 consoleId（`sql/mcp/server.ts:365,453-460`）；`fetch_page` 无 label/consoleId（`sql/mcp/server.ts:471`） |
| R4 | **没有「可行动的错误」**：驱动错误变成 isError 纯文本（无 code/hint，且行号被分页包裹整体 +1），拒绝信封又是普通成功调用；同一失败有四套形态 | 实测 `SHOW TABLES` → `Error: errCode = 2 … Syntax error in line 2`；`{ok:false}` 形态见 `sql/src/execute/core.ts:131,146-151`；`execute_script` 内联 `EXEC_ERROR`（`sql/src/execute/script.ts:101`）；SDK 兜底 `isError:true`（`node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:181,192-201`） |
| R5 | **人侧的「元数据/排序/筛选/导出」能力没有映射到 agent 面**：`raw`（SHOW/DESC/EXPLAIN/SHOW CREATE）、`sort`、`filters` 都是共享引擎已支持的请求字段，但只有面板能传 | `ExecuteRequest` 有 `sort/filters/raw/statementId/offset`（`sql/src/execute/core.ts:70-91`）；面板全用（`sql/src/client/state/query.ts:75-85`、`SqlWorkbenchPanel.tsx:702`）；MCP 从不传，`execute_sql` 传了也会被静默忽略（实测：`raw:true` 仍被包进 `SELECT * FROM (SHOW CREATE …)` 报语法错） |

> 一句话：**每次任务 = 更多次调用 × 每次更大更重复的载荷 × 失败时更少的信息**。缺的不是功能数量，而是三个抽象：当前上下文（context）、结果句柄（handle）、可行动失败（error contract）。

### 0.2 本次审计做了什么

1. 通读 `mcp/` 9 个工具注册与实现、`src/execute/` 共享引擎、agent console 全链路（outbox/relay/SSE/registry）、人侧面板与网格、`docs/05`/`docs/10`/`docs/09`/`docs/01`/`docs/08`/`AGENTS.md`、`.workbuddy/memory/2026-10-2*.md`。
2. **对运行时真实调用 15 次只读工具**（ping / list_datasources / test_connection / get_schema ×3 / list_tables / execute_sql ×5 / execute_script ×3 / fetch_page / cancel_statement），覆盖成功、拒绝、语法错、多语句、视图、空结果 6 类返回面；没有执行任何写语句、没有带 `label` 投递（避免污染用户 UI）。
3. 只改了一个文件：本文件。

---

## 1. 约束清单（任何后续方案必须满足；先列，避免方案返工）

### 1.1 AGENTS.md 硬性规则（`AGENTS.md`）

| # | 约束 | 出处 |
|---|---|---|
| C1 | 禁止声明 `@deepseek-ai/dsh*` 的 `peerDependencies`；兼容性靠运行期 Guard，fail-closed | `AGENTS.md:47-48` |
| C2 | 一切注册走 `ctx.effect()`；禁模块级副作用；卸载必须完全回收（页面类型 + 两个 seat） | `AGENTS.md:54` |
| C3 | 禁跨包 `@deepseek-ai/*` **value import**；宿主类型面自建在 `src/client/contract/host.ts` | `AGENTS.md:56` |
| C4 | 动态插件产物是纯 JS，**JSX 必须经构建，禁止直改 `lib/`** | `AGENTS.md:57` |
| C5 | UI 只用 `--dsw-alias-*` 语义 token、禁硬编码色、组件 CSS 禁主题选择器；产品文案中文、代码注释英文；复用 `ui-primitives` | `AGENTS.md:60-62` |
| C6 | **per-file 100% 覆盖率**（vitest thresholds）；豁免仅限不可达分支且写 `/* v8 ignore -- reason */` | `AGENTS.md:65` |
| C7 | 事件型 UI 用例必须按真实事件序列 `pointerdown → pointerup → click` 写 | `AGENTS.md:66` |
| C8 | `void somePromise()` 等于放弃错误处理：凡 `void` 掉的 Promise 必须有内部 `catch` | `AGENTS.md:67` |
| C9 | 不复用 DataGrip 字节码/资源/原文；不抢注商标；**不读取/不导出/不打印任何真实密码/token** | `AGENTS.md:72-74` |
| C10 | 代码与文档不得长期分叉：任何偏离**当场改文档**并在 `docs/00` §9 变更记录登记 | `AGENTS.md:4` |
| C11 | 待办清单唯一事实源 = `docs/09-BACKLOG.md`；新需求先写 09 并判断是否进 §7「不做」 | `AGENTS.md:125` |

### 1.2 已定技术决策（`AGENTS.md` §4，勿重新论证）

| # | 决策 | 对方案的约束 |
|---|---|---|
| D3 | 后端 = MCP server（Node/stdio，同包 `./mcp`）+ mysql2；Oracle 不做 | 新能力只能长在 MCP server / 宿主半 / 客户端半内 | `AGENTS.md:82` |
| D4 | 分页 = 首页 `LIMIT pageSize+1` 探针 + 独立 `COUNT(*)` + OFFSET；默认 500、上限 5000；COUNT 缓存至 schema 变更/手动刷新 | 改分页语义 = 改 AC-2/AC-3，需慎重 | `AGENTS.md:83` |
| D5 | 存储 = storage-json 三文档；凭据走 `ctx.credentials`；**密码永不入配置**；**宿主单写者，MCP server 无状态** | 「结果句柄」只能放 MCP 进程内存或 runtime 目录，不能写配置库 | `AGENTS.md:84` |
| D8 | 安全：agent 默认只读（仅 SELECT）；写需连接级 `writeEnabled`；DDL 黑名单默认拒绝；写操作审计；单单元格 1MB、预览截断 32KB | 任何「放开写/放宽截断」必须过 D8 | `AGENTS.md:87` |
| D10 | MCP：`serverName: sql`；`toolCallTimeoutMs: 120000`；凭据**不经 env**；server 入口路径经 `!!js` 从活动 profile 的 node_modules 解析 | 只能在既有 patch 行上改 config；不能改宿主 mcp-client | `AGENTS.md:89` |
| D12 | 结果筛选 = **服务端 WHERE**（`ExecuteRequest.filters` 进分页包裹与 COUNT）；不做「仅本页」客户端过滤 | agent 侧若加筛选，必须复用同一字段 | `AGENTS.md:91` |
| D13 | 错误文案：驱动错误先经 `client/db-error.ts` 翻译；**拒绝有两形态**：`ok:false` 与 HTTP 5xx 抛异常，两处都要处理 | 错误改造必须覆盖两形态（且 agent 面还有第三/第四形态，见 §4e） | `AGENTS.md:92` |

### 1.3 MCP 契约约束（`docs/05`）

| # | 约束 | 出处 |
|---|---|---|
| M1 | server 无状态：不读凭据库、不写配置；**宿主→MCP 唯一通道 = `<dshHome>/data-ide-runtime/conn-specs.json`（0600，原子写，argv 静态路径）** | `docs/05-MCP-SPEC.md:13`、`sql/src/host/runtime-specs.ts:18-24,100-106` |
| M2 | dsh 的 mcp-client **不支持改写调用参数** | `docs/05-MCP-SPEC.md:13` |
| M3 | 入参/输出必须落在 mcp-client 强制的 JSON Schema 子集：**禁 `oneOf` / `patternProperties` 等不支持构造**；注册期校验失败即抛错 | `docs/05-MCP-SPEC.md:116` |
| M4 | 统一错误信封 `{ ok:false, error:{ code, message, hint? } }` | `docs/05-MCP-SPEC.md:117` |
| M5 | 超时：工具调用 120s；连接建立 15s；`cancel_statement`/宿主 abort 转发 | `docs/05-MCP-SPEC.md:121-125` |
| M6 | 契约演进：新增工具自由；**改入参/语义 = minor + 迁移说明**；移除 = major；命名 `snake_case` | `docs/05-MCP-SPEC.md:29,145-147` |
| M7 | 安全边界：MCP stdio 子进程**不受 dsh sandbox 约束**（全权限）；工具集最小化 + 默认只读 | `docs/05-MCP-SPEC.md:131-136` |
| M8 | 重连预算：mcp-client 连续 10 次失败 → **永久注销工具**，只能重启 profile 恢复 | `docs/05-MCP-SPEC.md:140`、`docs/08-RISKS.md:18`（R7） |

### 1.4 agent console 通道约束（`docs/10`）

| # | 约束 | 出处 |
|---|---|---|
| A1 | MCP 是 **stdio 子进程，无 `ctx`**：拿不到 `storageDomain`/`webServer`；argv 静态 → **不知宿主动态端口** | `docs/10-AGENT-CONSOLE-SPEC.md:213-216` |
| A2 | 三段式：MCP 写 spool → 宿主扫/广播（SSE + 轮询兜底）→ 面板应用；**翻页不新建通道**（信封含 connId+sql，复用 `/fetch-page`） | `docs/10-AGENT-CONSOLE-SPEC.md:218-252` |
| A3 | 投递 ≠ 执行成功：广播不改变 agent 拿到的工具返回值 | `docs/10-AGENT-CONSOLE-SPEC.md:252` |
| A4 | `label`/`consoleId` 契约：label 存在即投递；consoleId 缺省新建 `ai_<label>`；指向**用户 console 必须拒绝** `CONSOLE_NOT_AGENT` 且不执行不投递 | `docs/10-AGENT-CONSOLE-SPEC.md:266-286` |
| A5 | 明确不做（v1.1 再说）：promote（复制到自身 console）、流式、多 agent 并发、权限细分 | `docs/10-AGENT-CONSOLE-SPEC.md:101-108` |
| A6 | 不抢焦点、未读角标 + 轻 toast、AI 历史抽屉、`ai_*` 软上限 4 | `docs/10-AGENT-CONSOLE-SPEC.md:86-90`、`sql/src/client/state/documents.ts:46-52,169-194` |

### 1.5 「明确不做」范围（防蔓延）

`AGENTS.md:123` + `docs/09-BACKLOG.md:133-142`：编辑回写、事务/会话管理、SSH/SSL 隧道、远程执行、图表/Geo/Compare、多结果集对比、对话分屏 / per-pane 右栏、Oracle 与 Java 桥。**结果集 `View as`、EXPLAIN 视图、对象树键/索引节点在对列表里是 B15/B16/B17「暂不排期」，不是永久不做**（`docs/09-BACKLOG.md:122-129`）。

### 1.6 对候选方案的直接含义

1. 只能改**本插件三半**（MCP server / node 宿主半 / 浏览器半）+ patch 里已声明的那行 `mcp-sql` 配置；**改不了 dsh 的 mcp-client、也改不了任何 in-box 注册面**（`AGENTS.md:49`）。
2. 「给模型加系统提示 / 改工具结果渲染 / 并行工具调用 / 工具审批」若要宿主配合 → 不在本仓可控范围，需 scout 确认宿主扩展点后才能作为方案前提。
3. 任何工具契约变更：sync `docs/05`+`docs/10`+`docs/09`+`docs/07`+`docs/00 §9`（C10），补 per-file 100% 测试（C6，注意 B11 测试已 ~2m15s），并遵守 minor 迁移说明（M6）。
4. 「结果句柄」若放 MCP 进程内存：不违反 M1（不读凭据库、不写配置）；但要写明进程重启即失效、以及 10 次失败注销后的行为（M8）。
5. 「默认投递」「默认小页」这类改默认值 = 改入参语义 → minor + 迁移说明（M6），并要过 D8（截断策略）与 D4（分页口径）。

---

## 2. 运行时工具面清单

### 2.1 九个工具总表

入参 *=必填。体积：实测（本库 1 连接 / 21 对象 / 约 840 列）或按行宽估算，标注「估」。

| 工具 | 入参 | 默认值 | 输出体积 | 超时 | 拒绝/错误码 | 副作用 | agent 必须重复传什么 |
|---|---|---|---|---|---|---|---|
| `ping` | 无 | — | 实测 98B | 宿主 120s | — | 无 | 无 |
| `list_datasources` | 无 | — | 实测 258B/连接 | 120s | `SPEC_UNAVAILABLE`（`sql/mcp/server.ts:112`） | 无 | 无；但**不返回 database / lastTestState / databaseInfo / isActive**（实测字段只有 id/name/dbms/host/port/writeEnabled） |
| `test_connection` | `connId*` | — | 实测 432B | 120s；驱动 connect 2.5s（`sql/mcp/probe-mysql.ts:44`） | `AUTH_FAILED`/`NETWORK_UNREACHABLE`/`TIMEOUT`/`DRIVER_MISSING`/`UNKNOWN`（`sql/mcp/probe.ts:12-16,29-47`）、`CONN_NOT_FOUND` | 仅探测；**不像人侧那样把 databaseInfo 写回缓存**（人侧 `sql/src/host/panel-service.ts:188`，MCP 侧无） | `connId`；且结果不落盘，下轮要重测 |
| `get_schema` | `connId*`、`table?`、`refresh?` | 全量、缓存 5min、上限 20000 列行（`sql/src/host/metadata.ts:52-53`） | 收窄到 1 表 ≈130B；全量估 50KB（本库 840 列）/理论上限 ~1MB | 120s（内层 2–3 条 SQL，各自 connect 10s，`sql/src/execute/mysql.ts:76`） | `SCHEMA_UNAVAILABLE`（连接不存在与无密码**同一文案**，`sql/src/host/metadata.ts:247`） | 2 条 introspection SQL + 5min 进程内缓存（与面板各一份） | `connId`；每次收窄都要重传；缓存过期还要 `refresh:true` |
| `list_tables` | `connId*`、`refresh?` | 同上一份快照 | 实测 2.35KB/21 对象 | 同上 | 同上 | 与 `get_schema` 共用同一 snapshot | `connId` |
| `execute_sql` | `connId*`、`sql*`、`pageSize?`、`label?`、`consoleId?` | `pageSize=500`（≤5000，`sql/src/execute/core.ts:107,119`） | **默认首页最多 500 行、无总字节上限**；实测 11 列行 ≈175B → 500 行 ≈88KB（估）；110 列宽表 ≈1.5KB/行 → ~750KB/页（估）；单单元格 >1MB 只回前 32 字符（`sql/src/execute/core.ts:252`） | 宿主 120s；COUNT 1.2s 降级为 `total:null`（`core.ts:118,376`） | `EMPTY_SQL`/`DDL_FORBIDDEN`/`WRITE_NOT_ALLOWED`/`CONN_NOT_FOUND`/`BAD_LABEL`/`CONSOLE_NOT_AGENT`/`SPEC_UNAVAILABLE`；**语法/驱动错 = isError 纯文本（无 code）** | 执行 1 条 SQL（**只跑第一条，其余静默丢弃**，`core.ts:238-242`）；`label` 存在则写 spool 投递 | `connId`（36 字符 UUID）+ 整段 `sql`；每次重跑都要重传 |
| `execute_script` | `connId*`、`sql*`、`pageSize?`、`maxStatements?`、`label?`、`consoleId?` | `maxStatements=20`（调用方只能调小，`sql/mcp/server.ts:426`）；回给 agent 的行数**总预算 500 行**（`server.ts:48,57-76`） | N 条语句 × 各自首页（交付完整、回 agent 裁到 500 行总预算） | 120s（含 N×2 次连接） | `TOO_MANY_STATEMENTS`、`EMPTY_SQL`、逐语句 `EXEC_ERROR`/拒绝码 | 顺序执行、遇错即停；`label` 存在则投递一个 `kind:"script"` 信封 | `connId` + 整段脚本；读第 2、3 条结果常要再逐条 `execute_sql`（见 §3.6） |
| `fetch_page` | `connId*`、`sql*`、`offset*`、`pageSize?` | 500；`total` 恒 `null` | 同 `execute_sql` 的页 | 120s | 同 `execute_sql` 的拒绝码（无 `label` 相关） | 再执行一次包裹 SQL；**不投递 UI** | `connId` + **整段原 SQL** + `offset` + 与原页一致的 `pageSize`；`total` 要自己记住（实测首页 200569，第二页拿不到） |
| `cancel_statement` | `statementId*` | — | 实测 20B | 120s | 无（永远 `{cancelled:true}`） | 调 `executor.cancel`；找不到也返回成功（`sql/src/execute/envelope.ts:37-41`、`sql/src/execute/mysql.ts:98-103`） | `statementId`；但这个 id 只有**语句结束后**才拿到，工具又不接受预铸 id → 实际不可用（§4i） |

工具名与注册顺序：`sql/mcp/tools.ts:38-48`；`ping` 也在其中（`server.ts:204-214`）。运行时 `tools/list` 与上表一致（实测 9 个工具都在）。

### 2.2 进程与执行模型（决定「每次调用有多贵」）

| 事实 | 证据 | 后果 |
|---|---|---|
| **每条 SQL 新开一条 TCP+认证连接**（无连接池） | `sql/src/execute/mysql.ts:69-79`（每次 `createConnection`），结束即 `end()`（92-95） | `execute_sql` 一次 = 2 条连接（COUNT + 首页，`core.ts:360-373`）；`execute_script` N 条语句 = **2N 条连接**；`get_schema` 首次 = 2–3 条（`metadata.ts:250,255`）。实测 `SELECT 1` 首次 173ms、热后 19–42ms，3 条 `SELECT 1` 脚本 85ms |
| COUNT 与首页**并行**，COUNT 超时即 `total=null` | `core.ts:359-377`（`withTimeout`，`COUNT_TIMEOUT_MS=1200`） | 大表永远「总数未知」，agent 无法靠 total 规划翻页 |
| MCP 进程与宿主进程**各有一份 schema 缓存** | MCP：`sql/mcp/server.ts:258-263`；面板：`sql/src/host/binding.ts:235-238` | 人与 agent 交替使用 → 同一 information_schema 查询付两遍 |
| MCP 侧 schema 解析**没有**「存量回退」 | MCP 直接 `readSpecs().connections[connId]`（`server.ts:261`）；面板 resolver 额外回退到 store+credentials（`sql/src/host/binding.ts:108-149`） | 刚保存、还没 publish 的连接：面板能读 schema，agent 只看到 `SCHEMA_UNAVAILABLE` |
| server 每次调用重读 spec 文件 | `server.ts:133-140`（`loadRuntimeSpecs` 每次 `readFile`） | 连接变更即时生效（好），代价是每次多一次文件读（可忽略） |
| 没有服务端语句超时 / abort 通道 | `core.ts:335-378` 全链路无 timeout（除 COUNT）；宿主 120s 只是**放弃等待**（`sql/cordis.patch.yml:39`） | 超时后查询继续在 DB 侧跑，连接泄漏在 `open` map 里直到 finally（`mysql.ts:66,79,92-95`） |
| MCP 结果只有 text content，无 structuredContent/outputSchema | 全部 `JSON.stringify` 进 `{type:'text'}`（如 `server.ts:212,243,365`）；SDK 支持 `outputSchema` 但未用（`node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts:161-168`） | 模型面前是一段 JSON 文本，宿主拿不到结构化结果（宿主是否另做截断未验证，见 §10.3） |

### 2.3 输出体积实测/估算（供方案定预算）

| 调用 | 实测 | 推算 |
|---|---|---|
| `list_datasources` | 258B（1 连接） | 每连接 ~250B |
| `test_connection` | 432B | 固定 ~430B |
| `list_tables` | 2,350B（21 对象） | ~110B/对象；对象数无上限（受 20000 列行截断影响） |
| `get_schema`（1 表） | 130B（视图返回空列时 105B） | — |
| `get_schema`（全量） | 未实测（避免灌满上下文） | 本库 ~840 列 ≈ 50KB；规格上限 20000 列行 ≈ 0.8–1.2MB（`metadata.ts:53`） |
| `execute_sql`（pageSize=3） | 11 列 3 行 ≈ 700B（含表头） | 每行 ~175B → **默认 500 行 ≈ 88KB**；`list_tables` 显示本库有 110/112 列的宽表（`ads_trade_self_service_report_agent_1d` 等），同页数 ≈ 750KB |
| `execute_script` | 3 条 `SELECT` ≈ 1.1KB | N×首页；回 agent 侧总行预算 500（`server.ts:48`），但每行宽度不受控 |

**关键事实**：`execute_sql` 没有任何总字节/总行预算（只有单单元格 1MB 截断与 pageSize 上限），而 `execute_script` 有 500 行总预算（A9 修复）。这意味着「agent 只想看一眼」也会默认吞下整页 500 行；「agent 想看宽表」一次可能几十万 token。AGENTS D8 与 01-PRD 的「预览截断 32KB」（`AGENTS.md:87`、`docs/01-PRD.md:58`、`docs/03-UIUX-SPEC.md:217`）**只存在于规格的人侧大值预览**，agent 面的实现是「>1MB 单元格只留前 32 字符」（`core.ts:249-253`），不是 32KB 预览。

---

## 3. 典型任务调用成本（用户问题里最重要的一节）

假设：连接已配置、agent 不知 connId（新会话常态）。「重复传」列只计跨调用重复的部分。

### 3.1 查表结构（「orders 表有哪些列」）

| 步 | 工具 | 重复传 | 返回 | 可能失败 |
|---|---|---|---|---|
| 1 | `list_datasources` | — | 258B；**无 database/默认库** | `SPEC_UNAVAILABLE`（宿主未发布连接时，`server.ts:112`） |
| 2 | `get_schema({connId, table:'orders'})` | connId UUID | 命中≈130B | ① 过滤是**内存后置**（`sql/tools-schema.ts:75-84`）：写 `库.表名` 才精确，只写 `表名` 在跨库重名时会漏；② **未命中返回 `{ok:true,tables:[]}`，无 note/无建议**（实测 `dwd.dwd_trade_order_all` → `{"ok":true,…,"tables":[]}`）；③ **视图列永远空**（实测 `dwd_trade_order_all_v` / `dwd_trade_performance_v` → `columns:[]`），因为 Doris 的 `information_schema.COLUMNS` 不返回视图列（`metadata.ts:138-146`、`docs/08-RISKS.md:26` R19） |

- 调用数：**2 次**（不知库时 +1 次 `list_tables`）；若目标是视图 → 结构**拿不到**，只能再花 1 次 `SELECT * … LIMIT 1` 猜列（正是 `get_schema` 想避免的），或再 1 次 `SHOW CREATE VIEW`（必失败，见 §3.7）。
- 每次重复：36 字符 connId。
- 返回体积：全量 dump 时 50KB～1MB（无「分页/只看表名」粒度）。

### 3.2 跑一条 SQL 看结果

| 步 | 工具 | 重复传 | 返回 | 失败点 |
|---|---|---|---|---|
| 1 | `execute_sql({connId, sql})` | connId + SQL | 默认最多 500 行（≈88KB～750KB，见 §2.3），含 total/hasNextPage/offset/statementId | 语法/驱动错 → isError 纯文本；`>`1MB 单元格只剩前 32 字符 |

- 调用数：**1 次**，但**一次就把整页塞进上下文**——没有 `limit`-like 的「只回前 N 行/只回列名+总数」选项（`pageSize` 能调小，但 agent 得先想到；工具描述未提示默认 500）。
- 多语句时：`firstStatement` 只取第一个 `;` 之前（`core.ts:238-242`），**其余静默丢弃**，没有 `EXEC_MULTI` 提示；工具描述只说「执行一条语句」，没警告「多条会丢」。

### 3.3 翻页 / 跳页

| 步 | 工具 | 重复传 | 返回 | 失败点 |
|---|---|---|---|---|
| 每页 | `fetch_page({connId, sql, offset, pageSize})` | **connId + 整段 SQL + pageSize** | 页数据；**`total` 恒 `null`**（实测：首页 total=200569，fetch_page total=null） | offset 语义是「行偏移」不是「页码」，工具描述只有一句「LIMIT n+1 OFFSET m，不重新计数」；页大小若与首页不一致，偏移会错位；**不能投递 UI** |

- 调用数：**1 次/页**；翻 3 页 = 3 次，每次把 SQL 原文（可能几百字）再传一遍。
- 人侧对照：面板把 SQL/pageSize/sort/filters/total/statementId 收在一个 `QueryState` 里（`sql/src/client/state/query.ts:19-45`），翻页只传 offset（`query.ts:75-85,115-133`），total 跨页保留（`query.ts:30,114`）。**agent 侧没有这个状态对象，只能靠模型自己复述**。
- 另：`statementId` 每页都新铸（`core.ts:394`），不能拿来当「结果句柄」。

### 3.4 看结果（让用户在 UI 里看到）

| 步 | 工具 | 重复传 | 返回 | 失败点 |
|---|---|---|---|---|
| 1 | `execute_sql({..., label:'月报-2026-10'})` | connId + SQL + **自己想 label**（1–64 位中文/字母/数字/`_`/`-`，`sql/src/execute/agent-delivery.ts:58-66`） | 结果；**不含 consoleId** | 忘传 label = **UI 零痕迹**（`server.ts:362-364` 注释：不带 label 视为 agent 自用）；label 不合法 → `BAD_LABEL`；同名不同 SQL → 新开 `ai_<label>#2`（`sql/src/client/state/documents.ts:248-253`） |
| 2 | 想复用/更新同一 console | `consoleId` | — | **拿不到 consoleId**：返回体不含（`server.ts:365`），也没有 `list_consoles` 工具；`consoleId` 参数事实上不可用（只能靠 label+SQL 归一化相等来「撞」到同一 console） |

- 调用数：投递 = 0 额外调用（搭车），但**可见性依赖 agent 恰好知道 label 语义**；人侧「AI 历史」与未读点只在面板内部（`documents.ts:174,296-298`、`SqlWorkbenchPanel.tsx:178-196`），右侧栏 tab chip 是静态文字「SQL 工作台」（`SqlWorkbenchTitle.tsx:6-8`）——用户不在这个 tab 时，agent 出结果没有任何全局提示。
- 反向（人→agent）：agent 读不到用户当前 console 的 SQL/结果/选段，PRD 的「人验证过的 SQL 与结果，agent 可直接引用」（`docs/01-PRD.md:24`）**没有实现通道**。

### 3.5 改 SQL 再跑（迭代）

| 步 | 工具 | 重复传 | 失败点 |
|---|---|---|---|
| 每轮 | `execute_sql`（或 `execute_script`） | connId + 整段新 SQL | 想更新同一个 agent console：SQL 变了 → `sameBatch` 为 false → 新开 `#2`（`agent-delivery.ts:75-87`、`documents.ts:248-253`）；想指定旧 console：`consoleId` 不可得（§3.4） |
| — | 想「编辑现有 console 的 SQL 再跑」 | — | 无此能力：agent 既改不了用户 console（`CONSOLE_NOT_AGENT`，`server.ts:156-166`），也无法定位自己的旧 console |

- 10 轮迭代 ≈ 10 次调用 + 最多 10 个 `ai_*` tab（软上限 4，超出后已读的进「AI 历史」抽屉，`documents.ts:183-194`、`SqlWorkbenchPanel.tsx:200-206`）。tab 会脏，但结果不丢（这是设计选择，可接受）。

### 3.6 多语句脚本

| 步 | 工具 | 重复传 | 返回 | 失败点 |
|---|---|---|---|---|
| 1 | `execute_script({connId, sql})` | connId + 整段脚本 | 逐语句 `{index, sql, ok, response|error}`；**回 agent 总行预算 500**（`server.ts:48,57-76`：按语句顺序扣预算，后面的语句常 0 行 + `rowsTruncated`） | ① >20 条 → `TOO_MANY_STATEMENTS` 拒绝（需 agent 自己拆成多次调用 → +N 次）；② 第 2 条起的结果经常读不到（预算被第 1 条吃光）→ 要逐条 `execute_sql` 再跑一遍（+N 次，且重复执行）；③ 遇错即停（符合规格）但**没有 `stoppedAt` 字段**，只有 `stopped:true`（`server.ts:71-75`），要靠 `statements[last].index` 自己推 |
| 2 | 想让人看到 | label | 一次投递 N 个结果 tab（`server.ts:433-452`） | 与 §3.4 同 |

- 实测定界：3 条 `SELECT 1` → 3 条语句各 2 条连接、总耗时 85ms；第 2 条 `SELEC 2` → 第 1 条 ok、第 2 条 `{code:'EXEC_ERROR', message:'errCode = 2, detailMessage = Syntax error in line 2…'}`、整体 `ok:true`、`stopped:true`。

### 3.7 定位错误（最重要的失败面）

| 失败类型 | agent 看到什么 | 证据 | 可行动性 |
|---|---|---|---|
| SQL 语法错 / 驱动错（`execute_sql`） | MCP `isError:true` 的**纯文本**：`errCode = 2, detailMessage = Syntax error in line 2:\n…`——无 code、无 hint、无「下一步」 | 实测；SDK 兜底见 `…/server/mcp.js:181,192-201`；`sql/src/execute/envelope.ts:17-28` 无 try/catch | ❌ 行号来自**分页包裹**（`buildPagedQuery` 把用户 SQL 放第 2 行，`core.ts:190`），agent 自己的 SQL 是第 1 行 → **行号 +1 误导**；无人话翻译（`db-error.ts` 只在 client 用：`sql/src/client/state/query.ts:10,105,111`） |
| 同一错（`execute_script` 内） | 普通成功调用 + `statements[i].error = {code:'EXEC_ERROR', message:'errCode = 2 …'}` | 实测；`sql/src/execute/script.ts:95-105` | ⚠️ 有 index/sql 可定位，但 message 仍是驱动原文、无 hint、无翻译 |
| 权限/写拒绝 | `{ok:false,error:{code:'WRITE_NOT_ALLOWED', message:'…请在连接配置里显式开启'}}` | 实测；`core.ts:145-151` | ✅ 文案可读；但 agent 无法自己开启（人工 UI），且**即使开启 DML 也会被包裹成 `SELECT * FROM (INSERT …)` 报语法错**（`core.ts:353-373`；实测 `raw:true` 被静默忽略） |
| 连接 id 错 | `{ok:false,error:{code:'CONN_NOT_FOUND', message:'未知连接 does-not-exist'}}`——**没有**「先调 list_datasources」提示 | 实测；`core.ts:290`。而 `test_connection` 走的 `resolveSpec` **有**该提示（`sql/mcp/runtime-specs.ts:74`）——两套实现不一致 | ⚠️ 靠模型自己想到 list |
| schema 读失败 | `{ok:false,error:{code:'SCHEMA_UNAVAILABLE', message:'…连接不存在或没有可用密码…'}}` | 实测；`sql/src/host/metadata.ts:247` | ❌ 把「connId 打错」和「没密码」合并成一条，agent 无法区分先修哪个 |
| 表名不存在（get_schema） | `{"ok":true,…,"tables":[]}` | 实测 | ❌ **静默成功**，agent 可能据此断言「表不存在」，而实际可能是 `库.表` 前缀写错/无权限 |
| 元数据语句（SHOW/DESC/EXPLAIN/SHOW CREATE） | 语法错（同上 isError 文本） | 实测 `SHOW TABLES`、`SHOW CREATE TABLE`、`SELEC 1` 都失败；`core.ts:350-352` 注释明确说元数据语句不能进包裹，但 `raw` 只有面板能传 | ❌ agent **永远拿不到 DDL / EXPLAIN / SHOW**，也无法用 `DESC` 补视图列 |
| 工具超时（>120s） | 宿主侧超时（细节取决于宿主）；服务端无 abort | `sql/cordis.patch.yml:39`；`core.ts` 无 timeout | ❌ 查询继续跑；无法取消（§3.8） |

- 定位成本：语法错至少 1 次失败调用 + 1 次重试；元数据需求（DDL/EXPLAIN）**0 成功路径**；表/权限歧义要再花 1 次 `SELECT * LIMIT 1` 或 list_tables 才能区分。
- 人侧对照：同一条驱动错误，人侧经 `readableDbError` 翻成人话（`sql/src/client/db-error.ts:41-65`）、进输出 tab/右下角提示（`docs/03-UIUX-SPEC.md:37-60`、`sql/src/client/components/SqlWorkbenchPanel.tsx:188-193`），且能看 DDL（`SqlWorkbenchPanel.tsx:696-743`）。

### 3.8 取消 / 长查询

- 设计上：`cancel_statement({statementId})`（`server.ts:484-496`）→ `cancelStatement`（`envelope.ts:37-41`）→ `executor.cancel`（`mysql.ts:98-103`，destroy socket）。
- 实际：① `execute_sql` **不接受** `statementId` 入参（`server.ts:319-325`），而返回的 `statementId` 在语句**结束后**才产生（`core.ts:348,374` 结束即 `forget`，registry 的 `forget` 还是空实现，`core.ts:263-272`）；② 于是 agent 只有在「另一条并行调用」里拿到 id 才能取消，而 MCP 是请求-响应，工具调用本身阻塞；③ `cancel` 找不到也返回 `{cancelled:true}`（实测传 `no-such-statement` → `{"cancelled":true}`），**假成功**。
- 结论：**agent 侧「取消」在物理上不可达**。人侧相反：面板在发请求前就铸 `ui-<n>`（`query.ts:49-52,95-100`），`cancel` 路由随时可打（`web-routes.ts:247-249`），且有取消按钮（`SqlEditor.tsx:183`）。
- 长查询：120s 宿主超时后，server 侧仍在 `executor.query` 里（`mysql.ts:81`），没有 abort；只有 COUNT 有 1.2s 超时。

### 3.9 调用数汇总（回答「一个常见任务要几次调用」）

| 任务 | 最少调用 | 常见调用 | 每次重复载荷 | 失败/空结果概率 |
|---|---|---|---|---|
| 查一张表结构 | 2（list_datasources + get_schema） | 2–3 | connId ×2–3 | 中（视图必空、过滤未命中静默空、跨库重名易漏） |
| 跑一次并看到结果 | 2 | 2 | connId + SQL | 低（但**忘了 label 就 0 可见性**） |
| 跑一次 + 翻 2 页 | 4 | 4–5 | connId ×4 + SQL ×3（fetch_page 两次） | 中（total 丢失） |
| 查视图列 | 3–4 | 4+ | connId ×4 | **高**（get_schema 空 → SHOW 失败 → SELECT * 猜列） |
| 3 条语句脚本 + 读第 2/3 条结果 | 3 | 3–5 | connId + 脚本（+ 逐条重跑） | 中（500 行预算只喂饱第一条） |
| DDL / EXPLAIN | **无成功路径** | — | — | 100% 失败 |
| 出错后定位 | 2 | 2–4 | connId + SQL | 高（无 code/hint/翻译、行号误导、无 EXPLAIN/历史） |
| 取消长查询 | **不可达** | — | — | 100% 不可用 |

**对比人侧**：同一批操作里，人的「上下文/结果/失败」都由客户端状态机承载（`sql/src/client/state/query.ts:19-45,95-133`），agent 每步都要用参数重新表达一遍。这是「不顺手」最直接的来源。

---

## 4. Ergonomics 缺陷逐项（a–j，对应任务说明）

严重度：P0 = 每个任务都受影响；P1 = 常见任务受影响；P2 = 边界。

### a) 上下文参数：`connId` 每调用必传、无「当前连接」默认值 — **P0**

- 6 个工具首参是必填 `connId`：`test_connection`（`server.ts:238`）、`get_schema`（`server.ts:273`）、`list_tables`（`server.ts:297`）、`execute_sql`（`server.ts:320`）、`execute_script`（`server.ts:378`）、`fetch_page`（`server.ts:471`）。
- connId 是原始 UUID（实测 `3762ecba-7da5-4269-9e6c-583f93795d46`，36 字符；`ds-<8hex>` 只用于凭据 key，`sql/src/datasource/model.ts:136-139`、`AGENTS.md:84`）。
- 人侧有「激活连接」：`dataSources.active()`/`setActive`（`sql/src/datasource/store.ts:98-105`）、`GET /connections` 同时返回 `activeId`（`web-routes.ts:141-143`）、连接条 UI。
- **但运行时 spec 文件不含 active**：`RuntimeSpecDocument = {schemaVersion, generatedAt, connections}`（`sql/src/host/runtime-specs.ts:40-45`），`parseRuntimeSpecs` 只保留 connections（`sql/mcp/runtime-specs.ts:37-47`）→ MCP 进程无法知道「用户现在选的是哪个」。
- 后果：每次调用重复 ~12 token；更要紧的是**每次都要模型记住/复述这个 UUID**（长会话里容易抄错 → `CONN_NOT_FOUND`）。

### b) 翻页要重传完整 `sql`+`connId`，无 statement/result 句柄 — **P0**

- 入参：`{connId, sql, offset, pageSize}`（`server.ts:471`）；`fetchPage` 重新 `firstStatement`+权限检查+包裹（`core.ts:381-407`）——**重新执行**，不是复用结果。
- `total` 不返回（`core.ts:407` 传 `null`）；`statementId` 每页新铸（`core.ts:394`）；docs 里说的「total 由首页的 COUNT 缓存提供」（`docs/05-MCP-SPEC.md:72`）**没有实现**（实测 `total:null`，全仓无 total 缓存）。
- 人侧有 per-console `QueryState`（`query.ts:19-45`）：sql/pageSize/sort/filters/total/statementId 都在，翻页只传 offset（`query.ts:75-85`）。

### c) 结果内联塞对话；无预算参数 — **P0**

- `execute_sql` 默认 500 行、无字节上限（`core.ts:107,119`；仅 `pageSize ≤5000`），实测 11 列行 ~175B → 88KB/页（估），宽表（本库 110–112 列，实测 `list_tables`）可达 ~750KB/页（估）。
- 唯一保护：单单元格 >1MB → 只留前 32 字符（`core.ts:249-253`），这不是「预览截断 32KB」（`AGENTS.md:87`/`docs/01-PRD.md:58` 的 32KB 是**人侧**大值预览规格，agent 面未实现）。
- `execute_script` 有 500 行总预算（`server.ts:44-48,57-76`，A9 修复）；但单条 `execute_sql` 没有对应 A9 预算 → 保护不一致。
- 无「只要列/前 N 行/聚合/摘要」参数；无 `outputSchema`/`structuredContent`（`server.ts` 全部 text JSON）。
- 人侧有窗口化行渲染、值查看器看完整值（`sql/src/client/format.ts:127-148`、`ResultGrid.tsx:571-622`）——agent 反而看不到大值内容。

### d) 工具描述只说实现、不说「何时用/下一步」；**零参数级说明** — **P1（发现成本高）**

- 9 个工具描述全是一句话，例如 `execute_sql`：「执行一条语句并返回首页（500+1 探针）与总行数；默认只允许 SELECT。带上 label 时结果同时投递到面板的 ai_<label> 控制台。」（`server.ts:317-318`）。未说明：默认 500 行、多语句只跑第一条、pageSize 上限、label 的「批次身份」语义、`consoleId` 只能指向 agent console。
- `fetch_page`：「翻页或跳页：LIMIT n+1 OFFSET m，不重新计数。」（`server.ts:470`）——未说明 offset 是行偏移、必须重传 SQL、total 恒 null、不能投递 UI。
- **所有参数零 `.describe()`**：`inputSchema` 只有 `z.string()`/`z.number().optional()`（`server.ts:238,273-276,297,319-325,377-384,471,490`）→ 模型看不到 `pageSize` 上限、`offset` 单位、`table` 接受 `库.表名`（该点只在工具描述里）、`refresh` 的 5 分钟缓存、`label` 字符集、`maxStatements` 被 clamp。
- 没有 server-level `instructions`（`new McpServer(SERVER_INFO)`，`server.ts:132`；SDK 支持，见 `…/server/index.d.ts:11-15`）；没有 `annotations`（readOnlyHint 等；SDK 支持 `mcp.d.ts:161-168`）→ 宿主无法区分只读/有副作用工具。
- `ping` 描述是英文（`server.ts:209`），其余中文（产品规则要求中文，`AGENTS.md:61`）。
- 发现链没有「下一步」：`list_datasources` 不提示「把 id 传给 get_schema/execute_sql」；`get_schema` 不提示「下一步 execute_sql」；`execute_sql` 不提示「翻页用 fetch_page、多语句用 execute_script、给人看加 label」。

### e) 错误信封对 agent 不可行动（四套形态 + 行号误导 + 无翻译） — **P0**

| 形态 | 到达方式 | 模型能否稳定分支 | 证据 |
|---|---|---|---|
| ① 普通内容 `{ok:false,error:{code,message}}` | 工具调用**成功**，isError 未置 | 要 JSON parse + 查 ok | `server.ts:345-356`、`core.ts` refusals |
| ② isError 纯文本（驱动/语法错） | `isError:true`，无 code/hint | ❌ 只能读自然语言 | 实测；SDK `mcp.js:181,192-201` |
| ③ `execute_script` 内联逐语句 error | 整体 `ok:true` | 要遍历 statements | `script.ts:95-105` |
| ④ `SCHEMA_UNAVAILABLE` 合并原因 | 普通内容 ok:false | ❌ 无法区分 connId 错/没密码 | `metadata.ts:247` |
- 行号偏移：分页包裹让「用户 SQL 第 1 行」变成错误里的 `line 2`（`core.ts:190`；实测 3 次都是 line 2）。
- 无翻译：`db-error.ts` 只在浏览器半使用（`sql/src/client/state/query.ts:10,105,111`），MCP 侧没有等价物；D13 要求的「先翻译」只覆盖了人侧。
- `CONN_NOT_FOUND` 文案两套（`core.ts:290` vs `mcp/runtime-specs.ts:74`）。
- 空结果不区分「不存在/无权限/前缀错」（`tools-schema.ts:75-84`）。
- 实测 `cancel_statement` 假成功（`{cancelled:true}`）也属于「错误语义不可信」。

### f) 写操作的确认/拒绝发现成本 — **P1（且写路径实际不可用）**

- 默认只读有清晰拒绝（实测 `DELETE` → `WRITE_NOT_ALLOWED` + 「请在连接配置里显式开启」）——**这是全工具面最好的一条错误文案**。
- 但：① agent 无法自己开启 writeEnabled，只能请人开（设计如此，但工具描述/错误里没让 agent「告诉用户去哪开」的明确指向 UI 文案）；② **即使开了也写不了**：所有非 `raw` 语句都被包进 `SELECT * FROM ( … ) AS t LIMIT …`（`core.ts:353-373`），DML 必然语法错；③ `mysql.ts:84-91` 假设 `rows` 是数组（`.map`），非结果集语句（INSERT/UPDATE/DELETE）mysql2 返回 OkPacket 对象 → `.map` 会抛 TypeError（静态证据，需 writeEnabled 连接真机确认，见 §10.3）；④ DDL 黑名单永久拒绝，无 dry-run、无 affectedRows 回执；⑤ 审计日志（B13）未做，`docs/05-MCP-SPEC.md:136` 的「所有写操作记审计」与代码不符。
- 人侧：写权限只有连接表单开关（`ConnectionDialog`），同样不做写操作（N1 不做），所以这条对「人」不是痛点——但它让 AC-6 的「writeEnabled 放行」在 agent 面形同虚设。

### g) 工具数量与粒度 — **P1**

- 9 个：`ping`（噪声，且英文）、`list_datasources`、`test_connection`、`get_schema`/`list_tables`（同一快照的两个入口）、`execute_sql`/`execute_script`（单/多语句，边界模糊：单语句也能用 script，但 script 有行预算/20 条上限/逐语句包装）、`fetch_page`（无句柄）、`cancel_statement`（不可用）。
- 缺失的粒度：无 `describe_table`（列+类型+注释+主键+DDL 一次给全）、无 `explain`、无 `deliver_result`（只投递不执行）、无 `list_consoles`、无 `open_workbench`/`focus`、无 `get_result`（按句柄取结果/统计）、无 `list_scripts`/`write_script`/`git_*`（`docs/05-MCP-SPEC.md:79-91` 6 个未实现 → AC-4 agent 侧未达，`AGENTS.md:113`、`docs/07-MILESTONES.md:76` M3-2）。
- `execute_sql` 内部支持 `offset`（`core.ts:347`）但工具不暴露 → `execute_sql` 不能直接跳页，只能先首页再 fetch_page。
- `get_schema` 的 `table` 过滤是**内存后置**：仍会跑全量 information_schema（≤20000 列行）再在 JS 里 filter（`tools-schema.ts:75-84`）——「收窄」省的是上下文，不是数据库开销。

### h) 正向通道：agent→UI 只有「带 label 的投递」这一条，且无句柄/无发现 — **P0**

- 边界确认：**确实只有 outbox 投递**。通道 = MCP 写 spool（`sql/mcp/agent-outbox.ts:18-20,28-36`）→ 宿主 1s 扫描 + 环形历史 + SSE（`sql/src/host/agent-relay.ts:76-153`、`agent-routes.ts:88-158`）→ 面板订阅（`sql/src/client/agent-stream.ts:70-145`、`SqlWorkbenchPanel.tsx:178-196`）。反向只有**两份快照**：spec 文件（凭据/连接）与 `consoles.json`（console 归属，用于拒绝，`mcp/console-registry.ts:20-26`）。
- 触发：仅 `label !== undefined`（`server.ts:364,433`）；`fetch_page`/`get_schema`/`test_connection` 不能投递。
- 无回执：返回体不含 `consoleId`/`label` 回显（`server.ts:365,453-460`）；agent 无法知道「投递到了哪个 tab、用户看没看」。
- 无列表：没有 `list_consoles`，`consoleId` 参数理论上能让 agent 更新指定 console（`documents.ts:237-241`），实际不可发现。
- 无文本通道：agent 不能在 UI 「输出」tab 里留言（Q17 的「输出」只承接投递失败的语句错误，`docs/10-AGENT-CONSOLE-SPEC.md:94-97`、`ScriptResults.tsx:131`）。
- 无全局提示：投递后的未读点/ toast 都在面板内部（`SqlWorkbenchPanel.tsx:188-193`），右侧栏 chip 无徽标（`SqlWorkbenchTitle.tsx:6-8`）→ 用户不在该 tab 时「agent 跑完了」不可见（除非 dsh 宿主对它自己的 tab 有提示，插件没接）。
- 已知限制（规格已承认或审查已记录）：至少一次投递（重复可容忍，`agent-relay.ts:10-17`）、8MB 上限→preview 100 行（`agent-delivery.ts:53-56,107-120`）、AI 池软上限 4 + 历史 20（`documents.ts:46-52,174`）、无 streaming/promote/多 agent（`docs/10:101-108`）。
- 投递 ≠ 工具返回（`docs/10:252`）：agent 仍要按自己的返回体推理，UI 里是另一份（超 8MB 时 UI 只有前 100 行）。

### i) 取消 / 长查询 — **P1（但取消是 P0 级不可用）**

- 见 §3.8：入参缺 `statementId`、id 只在结束后可得、`cancel` 假成功、服务端无超时/abort、120s 宿主超时后 DB 侧继续跑。
- 额外：`createStatementRegistry().forget()` 是空实现（`core.ts:263-272`），已结束语句的 id 永远不会被清理语义上「忘记」；`mysql.ts` 的 `open` map 在 finally 删除（正确），所以取消窗口 = 语句执行中——但 agent 拿不到窗口。

### j) schema 发现链路 — **P0（每次会话入口都付）**

- 链路：`list_datasources` →（`list_tables`）→ `get_schema(table)` = 2–3 次；每次都传 UUID。
- 缺「当前库」：`list_datasources` 不返回 `database`（实测只有 id/name/dbms/host/port/writeEnabled；`mcp/runtime-specs.ts:55-65` 有 database 字段但本连接未配置）→ `list_tables`/`get_schema` 全库扫描（实测跨 4 个 schema：ads/dim/dwd/ods_db）。
- 视图死路：`columns:[]`（实测 2 个视图）；`get_schema` 无 SHOW FULL COLUMNS 回退（`metadata.ts:182-229` 的 SHOW 回退只在「整个目录为空」时触发）。
- 空过滤静默（§3.1/§4e）。
- 双份缓存（§2.2）；MCP 侧无 store 回退（§2.2）。
- 无注释/主键/可空/默认值：`schemaQuery` 只选 4 列（`metadata.ts:71-75`）——LLM 最需要的列注释（Doris 中文 comment）与主键信息完全缺失；人侧可通过 DDL 看到（`SHOW CREATE`）。

---

## 5. spec ↔ 代码 ↔ 运行时 漂移表（供方案引用时避坑）

| # | 文档处的说法 | 代码/运行时事实 | 证据 |
|---|---|---|---|
| 1 | `execute_sql` 入参 `{connId, sql, pageSize?, statementId?}` | 实际 `{connId, sql, pageSize?, label?, consoleId?}`——**没有 statementId**，多了 label/consoleId | `docs/05-MCP-SPEC.md:47` vs `sql/mcp/server.ts:319-325` |
| 2 | `execute_sql` 输出 `rows: object[]` | 实际 `rows: unknown[][]`（数组的数组），另多 `offset` | `docs/05-MCP-SPEC.md:48` vs `core.ts:93-105`；实测 `rows:[[1,"x"]]` |
| 3 | `fetch_page` 入参含 `statementId?` | 实际无 | `docs/05-MCP-SPEC.md:71` vs `server.ts:471` |
| 4 | `fetch_page` 的 `total` 由首页 COUNT 缓存提供 | 实际恒 `null`，全仓无 total 缓存 | `docs/05-MCP-SPEC.md:72` vs `core.ts:407`；实测 |
| 5 | `list_datasources`/`test_connection` 输出 `{datasources:[…]}` / `{state,info,error}` | 运行时多包一层 `payload`：`{ok:true,payload:{…}}` | `docs/05-MCP-SPEC.md:35,40` vs 实测；`tools-datasources.ts:32-34,43-57` |
| 6 | `execute_sql` 副作用「写查询历史」 | 未实现（B5 未做；无 history 存储） | `docs/05-MCP-SPEC.md:49` vs `docs/09-BACKLOG.md:41-48`、`sql/src/host/binding.ts:39`（只预留注释） |
| 7 | 所有写操作记审计日志 | 未实现（B13 未做） | `docs/05-MCP-SPEC.md:136` vs `docs/09-BACKLOG.md:113-120` |
| 8 | `docs/05 §3` 标题「9 个已实现」、§3.3/§3.4 列 6 个脚本/git 工具 | 9 个 = 8 业务 + `ping`；6 个脚本/git 工具均未实现 | `docs/05-MCP-SPEC.md:27,79-91` vs `tools.ts:38-48` |
| 9 | `execute_script` 输出 `stoppedAt?: number` | 实际 `stopped?: true`（无位置） | `docs/10-AGENT-CONSOLE-SPEC.md:261` vs `script.ts:116-120`、`server.ts:71-75` |
| 10 | 「连接建立 15s」 | 执行路径 `connectTimeout: 10000`；探测路径 2500 | `docs/05-MCP-SPEC.md:123` vs `mysql.ts:76`、`probe-mysql.ts:44` |
| 11 | connId 形如 `ds-<8hex>`（AGENTS 决策 5） | 仅**凭据 key** 是 `ds-<8hex>`；connId 仍是 UUID | `AGENTS.md:84` vs `model.ts:136-139`；实测者 id |
| 12 | `docs/09` 状态「agent 侧 6 个 MCP 工具可用」 | 运行时 9 个 | `docs/09-BACKLOG.md:7` vs 实测 |
| 13 | AGENTS D8「预览截断 32KB」 | agent 面无 32KB 预览；单元格 >1MB 只回前 32 字符 | `AGENTS.md:87` vs `core.ts:249-253` |
| 14 | `docs/10 §13.1` 信封 schema 有 `durationMs` 等 | 一致（`ExecuteResponseLike` 有）；但信封**没有** consoleId 回执（设计如此，不是漂移；列此提醒） | `docs/10:227-241` vs `agent-delivery.ts:16-50` |

> 漂移本身不是「不顺手」的根因，但会让后续方案在错误契约上施工：**任何契约改动前先把 §5 的 1–4 项对齐，否则文档冻结（05 §3「契约冻结」）就是假的**。

---

## 6. 人侧已有 vs agent 侧缺失（能力对照）

| # | 能力 | 人侧（面板）证据 | agent 侧现状 |
|---|---|---|---|
| 1 | 当前激活连接 | `store.active/setActive`（`store.ts:98-105`）、`GET /connections` 回 activeId（`web-routes.ts:141-143`）、连接条 UI | ❌ spec 不含 active；每次必填 connId |
| 2 | 默认库/schema 上下文 | 连接表单 `database` 字段；对象树按 schema 分组（`SchemaTree.tsx`） | ❌ `list_datasources` 不返回 database（实测） |
| 3 | **DDL 查看 / raw 元数据执行** | `api.execute({…, raw:true})`（`SqlWorkbenchPanel.tsx:702`）；`ddlSql`=`SHOW CREATE …`（`schema-tree.ts:127-131`）；Ctrl+B 进 `ddl_<表名>` 标签（`SqlWorkbenchPanel.tsx:718-736`） | ❌ MCP 无 `raw` → 元数据语句必被包裹报语法错（实测） |
| 4 | 服务端排序 | 列头 → `sort: SortSpec`（`ResultGrid.tsx:377`、`query.ts:136-150`、`SqlWorkbenchPanel.tsx:511`） | ❌ 只能改 SQL 文本自己写 ORDER BY |
| 5 | 服务端列筛选（10 操作符，进 WHERE+COUNT） | 漏斗 UI（`ResultGrid.tsx:385,425-468`）、`filters` 进请求（`query.ts:75-85`）、`filterClause`（`core.ts:232-235`） | ❌ 只能改 SQL 文本自己写 WHERE |
| 6 | 聚合（SUM/AVG/MIN/MAX/COUNT/DISTINCT，选区/整页） | 状态栏聚合器（`ResultGrid.tsx:530-569`、`stats.ts`） | ❌ 须自己写聚合 SQL 重跑 |
| 7 | 分页控件（首页/上页/页码/下页/末页/页大小下拉/总数未知降级） | `Pager.tsx:32-99`、`PAGE_SIZES=[100,500,1000,5000]`（`query.ts:14`） | ⚠️ 只有 offset 算术；total 只在首页出现，fetch_page 不返回 |
| 8 | 导出 CSV/TSV/XLSX | 导出菜单（`ResultGrid.tsx:250-258,297-306`）、`xlsx.ts` | ❌ 无导出工具（只能拿 JSON 自己算） |
| 9 | 复制选区 TSV / 复制聚合值 / 复制全部 SQL | `ResultGrid.tsx:260-262,284-287,551-565`、`SqlEditor.tsx:190-195` | ❌ 无 |
| 10 | 值查看器（完整值、JSON 美化、二进制 hex 预览、字符数） | 双击单元格（`ResultGrid.tsx:504-506,571-622`）、`fullValue`（`format.ts:127-148`） | ⚠️ >1MB 单元格只回前 32 字符；JSON 不美化 |
| 11 | 对象树浏览/筛选/插入/复制引用 | `SchemaTree.tsx:166-167,316-330`、`schema-tree.ts` | ⚠️ 只有 `list_tables`/`get_schema`（无分页、无注释、视图无列） |
| 12 | 多 console / tab 管理 / AI 历史 / 未读 | `DocumentTabs.tsx`、`documents.ts:183-213,296-298` | ❌ 拿不到 consoleId、无 list_consoles、无未读回执、不能 reopen |
| 13 | 取消执行（预铸 id + 按钮） | `query.ts:49-52,95-100,153-162`、`SqlEditor.tsx:183`、`/cancel`（`web-routes.ts:247-249`） | ❌ 实际不可达（§3.8） |
| 14 | 错误人话翻译 + 输出 tab + 右下角提示 | `db-error.ts:41-65`、`ScriptResults.tsx`（输出 tab）、`SqlWorkbenchPanel.tsx:188-193` | ❌ 驱动错误原文（实测）、无翻译、无 hint |
| 15 | 三态连接测试 + durationMs + databaseInfo 缓存 | `panel-service.ts:180-193`、`TestStateBadge.tsx` | ⚠️ `test_connection` 有 state/info，但**无 durationMs、不写缓存**；list_datasources 不回 lastTestState |
| 16 | 打开/聚焦工作台（Ctrl/⌘+Shift+L、openTab） | `entry.ts`、`client/index.ts:127-140` | ❌ 无（agent 无法把用户带到结果） |
| 17 | 布局尺寸持久化 | `layout.ts`、`/layout` 路由 | —（与 agent 无关） |
| 18 | 查询历史（B5） | ❌ 未做 | ❌ 未做 |
| 19 | 结果区查找（B6）/ 列显隐（B7）/ 导出 INSERT·JSON（B8） | ❌ 未做 | ❌ 未做 |
| 20 | EXPLAIN 视图（B15）/ 结果 View as（B17） | ❌ 未做 | ❌ 未做 |
| 21 | 结果钉住 / pin | ❌ 两侧都没有（代码全仓无 pin 实现；`.workbuddy/pin-final.png` 只是截图） | ❌ 同左 |

---

## 7. agent console 机制梳理（通道方向 / 数据结构 / 触发者 / 已知限制）

### 7.1 通道图（实际实现）

```
                 ┌────────────── dsh 宿主进程（node 半，有 ctx）───────────────┐
                 │  startHostServices: storageDomain/credentials → panel API   │
  凭据/连接 ────▶│  publish() → <dshHome>/data-ide-runtime/conn-specs.json     │
                 │      （0600 原子写；插件卸载即删）                          │
                 │  agentRelay: 每 1s 扫 <runtimeDir>/agent-outbox/*.json      │
                 │      → 环形历史(200) → SSE /agent-events + 轮询 /agent-results│
                 └───────────────▲───────────────────────────┬─────────────────┘
                                 │ spool 文件（.tmp+rename）  │ SSE / poll
                                 │                           ▼
   MCP server（stdio 子进程，无 ctx）│                 浏览器半（面板）
   - 读 conn-specs.json（每次调用） │                  - subscribeAgentDeliveries()
   - 读 consoles.json（执行前判归属）│                  - applyAgentDelivery → ai_<label> tab
   - execute 后写投递信封 ──────────┘                  - publishConsoles()（300ms 去抖）
                                                       → POST /agent-consoles → consoles.json
```

证据：spec 路径与写入 `sql/src/host/runtime-specs.ts:18-24,100-106`、`sql/cordis.patch.yml:28-38`；relay `sql/src/host/agent-relay.ts:76-153`；SSE/轮询 `sql/src/host/agent-routes.ts:88-158`；spool `sql/mcp/agent-outbox.ts:18-36`；面板订阅 `sql/src/client/agent-stream.ts:70-145`；投递应用 `sql/src/client/state/documents.ts:230-293`；归属发布 `SqlWorkbenchPanel.tsx:213-227`。

### 7.2 数据结构

| 结构 | 字段 | 出处 |
|---|---|---|
| 投递信封 `AgentDelivery` | `schema:1, id, label, connId, consoleId\|null, sql, kind:'single'\|'script', at, single?, script?, previewRows?` | `sql/src/execute/agent-delivery.ts:36-50` |
| console 归属 `ConsoleEntry` | `{id, owner:'user'\|'agent', title, label?}` | `sql/src/execute/console-registry.ts:13-24` |
| 面板 tab `DocumentTab`（agent 子集） | `owner?, label?, unread?, lastActivityAt?` | `sql/src/client/state/documents.ts:24-43` |
| 脚本投递语句 | `{index, sql, ok, response?\|error?}` | `agent-delivery.ts:16-22`、`server.ts:443-450` |

### 7.3 谁触发

1. **MCP**：`execute_sql`/`execute_script` 且 `label` 存在 → 写一个信封（`server.ts:364,433`）；`consoleId` 命中用户 console → `CONSOLE_NOT_AGENT` 且不执行不投递（`server.ts:156-166`）。
2. **宿主**：1s 扫描（`agent-relay.ts:78,131`）；至少一次语义（广播后才 unlink，`agent-relay.ts:110-123`）；启动清 24h 旧文件（`agent-relay.ts:88`）。
3. **面板**：订阅 SSE，`error` 时退 1s 轮询（`agent-stream.ts:114-134`）；应用时**不改 activeId**（`documents.ts:215-221`）；同名同 SQL 就地更新，否则 `#2`（`documents.ts:230-293`）；300ms 去抖发布 console 归属（`SqlWorkbenchPanel.tsx:213-227`）；点击 console 清未读（`SqlWorkbenchPanel.tsx:565-566`）。

### 7.4 已知限制（规格/审查已承认 + 本次补充）

| 限制 | 影响 | 出处 |
|---|---|---|
| 投递**无回执**（返回体无 consoleId） | agent 无法后续定位/更新自己的 console，`consoleId` 参数不可用 | `server.ts:365,453-460`；`documents.ts:237-241` |
| 只有 `label` 一条触发路径 | `fetch_page`/元数据/文本消息都不能进 UI | `server.ts:471` |
| 至少一次 + 多实例共享 spool | 可能重复投递（UI 幂等容忍）或互相删文件 | `agent-relay.ts:10-17`；`docs/10:344-346`（A4） |
| 8MB 上限 → 前 100 行 preview | UI 结果与 agent 看到的不一致；需面板翻页补齐 | `agent-delivery.ts:53-56,107-120` |
| AI 池软上限 4 + 历史 20；不销毁未读 | tab 可能超 4 个；用户需手动关 | `documents.ts:46-52,169-194` |
| 不抢焦点（设计） | 用户可能完全不知道有结果（chip 无徽标） | `documents.ts:215-221`、`SqlWorkbenchTitle.tsx:6-8` |
| 无 streaming / promote / 多 agent / 权限细分 | v1.1 再说 | `docs/10:101-108` |
| 「输出」tab 只承接投递语句的错误 | agent 不能给人留言 | `ScriptResults.tsx:131`、`docs/10:94-97` |

---

## 8. 已记录的痛点与未完成项（与本次目标相关的）

### 8.1 `.workbuddy/memory`（2026-10-16 … 10-21，最近 6 天）

- **没有**关于「agent 工具用起来不顺手」的用户原话；memory 里的用户反馈都是**人侧**：补全打 `S` 不出 `select`（`memory/2026-10-21.md:111`）、DDL 别弹小窗要放编辑区 + 工具栏（`memory/2026-10-20.md:25`）、多语句不生效（旧进程，`memory/2026-10-19.md:74`）、console tab 位置（`memory/2026-10-19.md:147`）。→ 本次抱怨是**新信息**，本审计是 agent 面的第一份「用户视角」证据。
- 与 agent 面相关的既有记录：`consoleId→用户 console` 拒绝曾「客户端忽略并新建」（`memory/2026-10-21.md:28`，后续已修）；A9「N×500 行灌 agent」的对抗性审查与修复（`memory/2026-10-21.md:36,44`）；spool 至少一次语义（`:40`）；`EMPTY_RESPONSE`/`405` 两轮线上故障（`:117-135`）——说明**人侧链路打磨过多轮，agent 契约侧没有对等的一轮**。

### 8.2 docs/10 §12/§15/§16（已闭环，可当「已知边界」引用）

- §12 R1–R15：结果回推通道、多语句、label/consoleId、模型字段、tab 标题冲突、输出 tab……**全部闭合**（`docs/10:132-204,309-332`）。
- §15 A1–A15：连接串错并、先删后广播、AI 历史缺失、多实例、maxStatements 放大、Last-Event-ID、UTF-8 字节、信封校验、脚本行预算、复用不更新 label……**全部闭合**（`docs/10:335-408`）。
- §16：空响应、同路径重复注册、`void` 未接错误（`docs/10:412-435`）。
- 对本次审计的含义：**不要重复提「加投递通道/加 label/加多语句」——那些已经做了**；缺口在「上下文、句柄、错误、可发现性、人侧能力映射」。

### 8.3 docs/09-BACKLOG（唯一待办源）与本次相关项

| 项 | 与 agent 工具面的关系 |
|---|---|
| B4 console 内容持久化（`docs/09:32-39`） | agent console 刷新即丢；也影响「agent 结果可追溯」 |
| B5 查询历史（`docs/09:41-48`） | `docs/05:49` 声称的「写查询历史」未实现；agent 也无法回看 |
| B6 结果区查找（`docs/09:50-57`） | 仅人侧 |
| B7 列显隐（`docs/09:59-66`） | 仅人侧 |
| B8 导出 INSERT/JSON（`docs/09:68-75`） | 人侧有 CSV/TSV/XLSX，agent 侧一个都没有 |
| B13 审计日志（`docs/09:113-120`） | `docs/05:136` 声称有；agent 写/拒绝都无留痕 |
| B15 EXPLAIN 视图（`docs/09:122-129`） | agent 连 `EXPLAIN` 语句都跑不了（§3.7） |
| B14/B16/B17 | 复制连接 / 索引节点 / View as（暂不排期） |

### 8.4 里程碑与验收缺口

- `M3-2`「MCP 工具 git_status/diff/commit/pull/push + list/read/write_scripts」未做（`docs/07-MILESTONES.md:76`）→ **AC-4「agent 经 MCP 完成脚本保存→commit→push」未达**（`AGENTS.md:113`、`docs/01-PRD.md:118` US-7）。
- AC-6「writeEnabled 放行」在 agent 面实际不成立（§4f）。
- AC-5 已达成（实测 9 工具可见）。
- `docs/testing.md:142-153` 的 agent smoke 只有 A1–A4（ping/list/test_connection/坏 connId），**没有一条覆盖 execute_sql 的成功/失败/翻页/投递**——这解释了为什么上述缺口没被冒烟捕获。

---

## 9. 若只改 tool 契约，最高杠杆的 5 个候选（只列，不展开方案）

> 排序按「每个任务都受影响 × 改动局限在本仓 × 不破既有 AC」。方案细节留给 lead/后续任务；每条都注明落点与必须满足的约束。

| # | 候选 | 直接消灭的缺陷 | 主要落点 | 必须满足 |
|---|---|---|---|---|
| 1 | **上下文缺省**：宿主在 `conn-specs.json` 发布 `activeConnId`（+ 每连接的 `database`），所有工具 `connId` 改可选、缺省用 active；`list_datasources` 补 `database/lastTestState/databaseInfo/isActive` | §4a、§4j、§3.1/§3.2/§3.3 的重复载荷 | `sql/src/host/runtime-specs.ts`、`sql/mcp/server.ts`、`sql/mcp/runtime-specs.ts`（parse 需保留新字段）、`sql/src/host/binding.ts` | M1（spec 仍是唯一通道、0600）、M3（JSON Schema 子集：可选字段 OK）、C10 文档同步；`parseRuntimeSpecs` 现在会**丢弃**未知字段（`mcp/runtime-specs.ts:37-47`），必须同步改 |
| 2 | **结果句柄**：`execute_sql` 返回 `resultId`（MCP 进程内 registry 持有 connId/sql/pageSize/total），`fetch_page` 接受 `resultId`+`offset`（不必再传 SQL，`total` 随页返回）；`execute_sql`/`fetch_page` 接受预铸 `statementId` 让 `cancel_statement` 可用，取消未命中返回 `cancelled:false`+code | §4b、§3.3、§4i 的翻页/取消/重复 SQL | `sql/src/execute/core.ts`（registry 真正持有状态、`fetchPage` 支持句柄）、`sql/mcp/server.ts`、`sql/src/execute/envelope.ts` | M1（内存态不落配置）、M6（新增可选参数 = minor + 迁移说明）、D5、C6 覆盖；需定义进程重启/10 次失败注销后的失效语义（M8） |
| 3 | **投递闭环**：`execute_sql`/`execute_script` 默认投递（或 `deliver:false` 显式关闭）+ 返回 `{consoleId,label}`；新增 `list_consoles`（含 owner/unread/lastActivity）与 `deliver_result`（只投递 SQL+结果/说明，不执行）；`fetch_page` 支持 `label/consoleId` 投递翻页 | §4h、§3.4、§3.5 的可见性/不可定位 | `sql/mcp/server.ts`、`sql/mcp/console-registry.ts`（正向读 owner 而非只做拒绝）、`sql/src/execute/agent-delivery.ts`（schema 兼容/升版本）、`sql/src/client/state/documents.ts` | A1–A4（spool 通道、label 校验、用户 console 拒绝）、A3（投递不改返回值）、`docs/10` 同步；chip 徽标/聚焦需宿主扩展点（scout 确认） |
| 4 | **agent 面输出预算 + 元数据/排序/筛选透传**：`execute_sql` 默认小页（如 50）或加 `maxRows/maxBytes`、`columnsOnly/summary` 模式；透传 `raw:true`（SHOW/DESC/EXPLAIN/SHOW CREATE）与 `sort/filters`；`get_schema` 视图列走 `SHOW FULL COLUMNS` 回退、未命中返回近似建议/错误 | §4c、§4j、§3.7 的 DDL/EXPLAIN 缺失、§3.1 视图死路 | `sql/mcp/server.ts`、`sql/src/execute/core.ts`（`raw`/`sort`/`filters` 已在 `ExecuteRequest`，只需透传）、`sql/src/host/metadata.ts`（视图列 + 建议）、`sql/mcp/tools-schema.ts` | D4（分页口径不变，只改默认值/新增字段）、D8（截断策略）、D12（筛选必须服务端）、M3、M6、C6；`raw` 要过权限门（`core.ts:343-344` 已在执行前） |
| 5 | **统一可行动错误信封**：所有失败（含驱动抛出）都返回 `{ok:false,error:{code,message,hint,stage?,statementIndex?,lineOffset?}}` 且 isError=true；把 `db-error.ts` 的翻译搬到 `src/execute/` 共享（纯函数）；`execute_sql` 多语句不再静默丢弃（`EXEC_MULTI` 或提示用 `execute_script`）；`get_schema` 空结果区分「不存在/无权限/前缀错」 | §4e、§3.7、§4f 的不可行动失败 | `sql/src/execute/envelope.ts`、`sql/src/execute/core.ts`、`sql/mcp/server.ts`、`sql/src/client/db-error.ts` → 移到 `sql/src/execute/db-error.ts`（客户端同步引用） | D13（两形态）、M4（信封）、C6（`db-error.ts` 现有测试 `tests/db-error.spec.ts` 要跟着搬）、C10；行号需减去包裹偏移（或错误里回「yourSQL 第 1 行」） |

**没进的候选（也重要，但杠杆/成本比低于上面 5 条）**：工具描述 + `.describe()` + server `instructions` + `annotations`（一次性文本改动，治「发现性」但需确认宿主是否透出 instructions——见 §10.3）；`get_schema`/`list_tables` 合并为 `describe_table`（一次给列/类型/注释/主键/DDL）；删 `ping` 或挪出工具面；`test_connection` 回 `durationMs` 并写回 databaseInfo 缓存；`execute_sql` 支持 `offset`（少一次 fetch_page 往返）。

---

## 10. 证据索引与待验证

### 10.1 关键文件行号索引（按主题）

| 主题 | 引用 |
|---|---|
| 工具注册与描述 | `sql/mcp/server.ts:42,132,204-214,216-230,232-246,265-289,291-310,312-368,370-463,465-482,484-496`；`sql/mcp/tools.ts:10-48` |
| 投递与 console 归属 | `sql/mcp/server.ts:149-202`；`sql/mcp/agent-outbox.ts:18-36`；`sql/src/execute/agent-delivery.ts:36-120,160-195`；`sql/src/execute/console-registry.ts:13-58`；`sql/mcp/console-registry.ts:15-26` |
| 执行引擎 | `sql/src/execute/core.ts:70-152,180-196,238-272,284-407`；`sql/src/execute/envelope.ts:17-41`；`sql/src/execute/mysql.ts:65-104`；`sql/src/execute/script.ts:62-121`；`sql/src/execute/split.ts:22,30-44` |
| schema | `sql/src/host/metadata.ts:52-53,69-90,108-135,148-177,179-229,232-295`；`sql/mcp/tools-schema.ts:44-84` |
| 宿主半 | `sql/src/host/binding.ts:39,108-149,189-252`；`sql/src/host/runtime-specs.ts:18-24,40-92,100-106`；`sql/src/host/web-routes.ts:25-40,132-249`；`sql/src/host/panel-service.ts:180-217`；`sql/src/host/agent-relay.ts:76-153`；`sql/src/host/agent-routes.ts:16-21,88-199` |
| 客户端半 | `sql/src/client/index.ts:63-140`；`sql/src/client/state/query.ts:14-45,49-52,75-133,136-162`；`sql/src/client/state/documents.ts:24-52,137-213,230-298`；`sql/src/client/agent-stream.ts:13-61,70-145`；`sql/src/client/db-error.ts:41-65`；`sql/src/client/format.ts:88-97,127-148`；`SqlWorkbenchPanel.tsx:178-227,696-743`；`ResultGrid.tsx:67-86,250-306,371-468,530-622`；`Pager.tsx:32-99`；`SqlWorkbenchTitle.tsx:6-8` |
| 配置 | `sql/cordis.patch.yml:13-42`；`sql/package.json:42-54`；`sql/build.mjs:65-70` |
| 规格 | `docs/05-MCP-SPEC.md:10-13,27-91,114-125,127-148`；`docs/10-AGENT-CONSOLE-SPEC.md:11,45-97,101-108,132-204,207-306,309-408,412-435`；`docs/09-BACKLOG.md:7,32-129,133-142`；`docs/01-PRD.md:18-24,32-80,91-94,111-140`；`docs/08-RISKS.md:18-19,26-27`；`docs/07-MILESTONES.md:76`；`docs/testing.md:142-153,164-177` |
| 规则 | `AGENTS.md:4,46-74,76-92,94-125` |

### 10.2 本次运行时实测记录（2026-10-26，只读；原始返回已按上文引用）

| # | 调用 | 结果摘要 |
|---|---|---|
| 1 | `ping` | `{"ok":true,"pong":"pong","server":"dsh-data-ide","at":"2026-10-26T15:00:00.211Z"}` |
| 2 | `list_datasources` | `{ok:true,payload:{datasources:[{id:"3762ecba-…",name:"Doris",dbms:"doris",host:"doris.shcell.com",port:9030,writeEnabled:false}]}}`（无 database） |
| 3 | `test_connection(真连接)` | `{ok:true,payload:{state:"YES",info:{product:"Doris",version:"5.7.99",driverVersion:"mysql2 3.24.6",dbms:"MYSQL",exactVersion:"Doris version doris-2.1.10-rc01-…",identifierQuoteString:"\`",caseSensitivity:{plain:"lower",quoted:"exact"}}}}`（无 durationMs） |
| 4 | `list_tables(真连接)` | 21 个对象 / 4 schema（ads/dim/dwd/ods_db）；110–112 列宽表存在；**5 个视图 columns:0** |
| 5 | `get_schema(table:"dwd.dwd_trade_order_all_v")` | `{ok:true,…,tables:[{schema:"dwd",name:"…",kind:"view",columns:[]}]}` |
| 6 | `get_schema(table:"dwd_trade_performance_v")` | 同上（简名也能命中） |
| 7 | `get_schema(table:"dwd.dwd_trade_order_all")` | `{ok:true,…,tables:[]}` ← **静默空** |
| 8 | `get_schema(connId:"does-not-exist")` | `{ok:false,error:{code:"SCHEMA_UNAVAILABLE",message:"无法读取表结构：连接不存在或没有可用密码…"}}` |
| 9 | `execute_sql(SELECT 1 AS a,'x' AS b)` | `{ok:true,columns:[{name:"a",typeName:"TINY"},{name:"b",typeName:"STRING"}],rows:[[1,"x"]],total:1,hasNextPage:false,offset:0,durationMs:173,statementId:"stmt-1"}` |
| 10 | `execute_sql(SELECT * FROM dwd.dwd_zanmall_user_score_log, pageSize:3)` | 11 列 3 行；`total:200569`；行宽 ≈175B/行 |
| 11 | `execute_sql(SHOW TABLES)` | **isError 文本**：`Error: errCode = 2, detailMessage = Syntax error in line 2:\nSHOW TABLES\n^\nEncountered: SHOW\nExpected` |
| 12 | `execute_sql(SELEC 1)` | 同上（line 2、`Encountered: IDENTIFIER`） |
| 13 | `execute_sql(SHOW CREATE TABLE dwd.…, raw:true)` | 同上——**`raw` 被静默忽略**（仍在第 2 行被包裹） |
| 14 | `execute_sql(connId:"does-not-exist")` | `{ok:false,error:{code:"CONN_NOT_FOUND",message:"未知连接 does-not-exist"}}`（无 hint） |
| 15 | `fetch_page(同一 SQL, offset:0)` | `{ok:true,…,rows:[[1,"x"]],"total":null,statementId:"stmt-4"}` ← total 丢失、id 新铸 |
| 16 | `execute_script(3×SELECT 1, pageSize:5)` | `{ok:true,statements:[3 条各自 response…],durationMs:85}`（各语句 statementId `stmt-5/6/7`，`total:1` 各自 COUNT） |
| 17 | `execute_script(SELECT 1; SELEC 2)` | `{ok:true,statements:[ok, {index:1,ok:false,error:{code:"EXEC_ERROR",message:"errCode = 2, detailMessage = Syntax error in line 2…"}}],stopped:true}` |
| 18 | `execute_script(DELETE …)` | `{ok:true,statements:[{index:0,ok:false,error:{code:"WRITE_NOT_ALLOWED",message:"该连接未开启 writeEnabled，只允许 SELECT；如需写入请在连接配置里显式开启"}}],stopped:true}` |
| 19 | `execute_script(21 条)` | `{ok:false,error:{code:"TOO_MANY_STATEMENTS",message:"脚本包含 21 条语句，超过上限 20 条"}}` |
| 20 | `cancel_statement("no-such-statement")` | `{"cancelled":true}` ← **假成功** |

### 10.3 待验证（超出本审计范围，交接 scout/lead）

1. **宿主是否截断/渲染 MCP 工具文本结果**（决定 §2.3 的体积估算是否要再乘系数）：本会话 checkout `E:\deepseek-harness\resources\app.asar\dsh` 是 asar 包（无源码目录，`resources\app.asar.unpacked\dsh` 只有原生模块），无法静态确认；需要 dsh-scout 的宿主侧结论。
2. **宿主是否消费 `initialize.instructions` / tool `annotations` / `structuredContent`**：SDK 1.32.1 都支持（`…/server/index.d.ts:11-15`、`…/server/mcp.d.ts:161-168,280-284`），但 dsh 0.2.1 的 mcp-client 是 `^1.12.0`（`docs/05-MCP-SPEC.md:10`），是否透传到模型/审批 UI 未知 → 影响候选 5 之外的「描述/注释」方案价值。
3. **写路径真机验证**：需要一个 `writeEnabled:true` 的连接，验证 ① DML 是否被包裹成 `SELECT * FROM (INSERT …)` 语法错；② 非结果集语句是否在 `mysql.ts:84-91` 的 `.map` 处抛 TypeError。当前无该连接（避免改配置），仅静态证据。
4. **多实例/多 profile 的 spool 行为**（A4 已定义为「接受重复」）；如果 lead 的方案要加「投递回执」，需先确认是否需要 per-instance 区分。
5. **`raw` 透传后的权限口径**：`checkPermission` 对 `SHOW`/`EXPLAIN` 放行（`core.ts:126-131` 只拦写前缀/DDL 黑名单），但 `SHOW CREATE` 在 Doris 走对象权限（`docs/08-RISKS.md:26`、`db-error.ts:44-50`）；方案里要把这类失败也归进「可行动错误」。

---

### 附：本审计用到的全部仓库文件清单（只读）

`AGENTS.md`；`docs/00`（未读全文）、`docs/01`、`docs/03`（相关章节）、`docs/05`、`docs/07`（M3-2 行）、`docs/08`、`docs/09`、`docs/10`、`docs/testing.md`；`packages/client/ui-sql-workbench/` 下：`package.json`、`cordis.patch.yml`、`build.mjs`、`mcp/{server,tools,tools-schema,tools-datasources,agent-outbox,console-registry,runtime-specs,probe,probe-mysql}.ts`、`src/index.ts`、`src/execute/{core,envelope,mysql,script,split,agent-delivery,console-registry}.ts`、`src/host/{binding,runtime-specs,metadata,panel-service,web-routes,agent-relay,agent-routes,console-registry}.ts`、`src/client/{index,http-api,agent-stream,db-error,format}.ts`、`src/client/state/{query,documents}.ts`、`src/client/components/{SqlWorkbenchPanel,ResultGrid,Pager,SqlWorkbenchTitle,SqlEditor,ScriptResults}.tsx`；`src/datasource/{model,store}.ts`；`.workbuddy/memory/2026-10-19..21.md`；`node_modules/@modelcontextprotocol/sdk` 类型与 `dist/esm/server/mcp.js`。
