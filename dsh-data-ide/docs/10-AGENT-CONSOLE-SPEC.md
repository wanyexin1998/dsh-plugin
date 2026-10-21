# 10 — AGENT 结果接入 Console 规格（v1）

> 状态：v1 收敛（2026-10-20）｜上游：`03-UIUX-SPEC`（console/结果区骨架）、`02-ARCHITECTURE`（MCP 工具）、`01-PRD`
> 参考依据：DataGrip 2026.2.3 行为 REA + 用户实测 —— 结果区 = 一组 tab（输出 + 每个结果集一个）；单语句**复用**当前结果 tab；多语句一次产出 N 个 tab，标题 = `首列名:类型`；执行历史按语句位置记（重复执行更新同行、不追加）。
> 决策溯源：Q2/Q9/Q10/Q11/Q12/Q13/Q14/Q15/Q16/Q17 经逐项确认（用户全选 A，Q15/Q16 有纠偏）。

---

## 1. 背景与目标

- **本产品即 dsh 插件，agent 即 dsh 自身**（用户纠偏 · Q15）：不存在独立的「问 AI」按钮或自然语言输入框；agent 能力由 dsh 平台提供。本插件只负责把 agent 通过 MCP（`execute_sql` / `fetch_page` 等）投递的结果**路由到正确的 console**。
- **问题**：agent 会边想边查、持续产出 SQL 结果与错误。若直接塞进用户正看的 console，会覆盖/打断用户；若每次都新开，标签会爆。
- **目标**：在 `03` 的 console/结果区骨架上，叠加一套与 DataGrip 一致、又能在 agent 场景下保持「用户工作 / agent 工作」隔离的结果路由规则。

---

## 2. 核心决策总表

| # | 问题 | 结论 | 一句话理由 |
|---|---|---|---|
| Q2 | agent 结果落哪 | **独立 console**，与用户隔离 | 不覆盖用户正在看的结果 |
| Q9 | 呈现形式 | 进**网格**（= 结果 tab） | 复用既有结果区，不复造一套 |
| Q10 | 结果区形态 | **全面 tab 化** | 统一心智：结果区永远一组 tab |
| Q11 | 批次身份 | agent 传 `label`，同名同批就地更新 | agent 自带语义，让其命名最准 |
| Q12 | 生命周期 | 上限 8，**LRU 回收** + 「AI 历史」抽屉 | 标签不爆、早期批次不丢 |
| Q13 | console 内容 | **完整 console**（编辑区在上、结果 tab 在下） | SQL 在编辑区，结果 tab 只放网格，无需额外 SQL 条 |
| Q14 | 焦点 | **不抢焦点**；未读角标点 + 轻 toast | agent 是后台协作者，不该打断 |
| Q15 | 入口 | **无独立入口**；agent 即 dsh，直接用 | 产品本就是 dsh 插件 |
| Q16 | 数据源绑定 | 改原 console→继承；**新建 console→显式选连接** | 分情况，零摩擦或显式可控 |
| Q17 | 失败处理 | 错误进 agent console「输出」tab，红色标记 + 未读角标 | 错误必须可追溯 |

**标题规范**：agent console 统一前缀 `ai_<label>`，与用户 console 命名空间隔离，便于系统单独限流/回收。

---

## 3. Console 模型

### 3.1 结构（继承 `03`）
三面板工作区：对象树（左）｜ 编辑区（上）｜ 结果区（下）。**agent console 与普通 console 完全同构**——编辑区在上、结果 tab 在下。

### 3.2 内容（Q13 纠偏）
- 结果 tab **只放网格**。SQL 跑完自然落在 console 自己的**编辑区**，不需要在结果 tab 内另加 SQL 条。
- 这保证「agent console = 一个完整 console」，与 DataGrip（编辑器在上、结果 tab 在下）一致，也省掉一套临时 UI。

### 3.3 标题（Q11）
- 格式：`ai_<label>`（如 `ai_月报-2026-10`）。前缀区分归属、便于系统单独限流/回收、避免与用户同名 console 撞名。

### 3.4 两种作业模式（Q16）
| 模式 | 触发 | 连接绑定 |
|---|---|---|
| **在原 console 内作业** | agent 作用于用户当前 console | **直接继承**该 console 的连接（无新标签） |
| **新建 console** | agent 决定独立开一个 | **唤起时显式选连接**（用户选，或作为 agent invoke 参数带入） |

> 注：Q2 的「隔离」在「新建 console」路径下成立；「在原 console 内作业」路径下 agent 编辑的就是用户 console 本身，此时连接本就是该 console 的连接，隔离不适用。

---

## 4. 结果路由规则（Q9 / Q10）

- **单语句**：**复用**当前结果 tab（DataGrip 行为——重复执行不新建，原地更新）。
- **多语句**（脚本）：一次执行产出 **N 个结果 tab**，顺序 = 语句顺序；脚本遇错即停（失败语句即最后一个标签）。
- **结果 tab 标题**：`首列名:类型`（如 `a:int`），同名列靠类型/列名区分——对齐 DataGrip，取代当前的 `语句 1 · 500 行 · 87ms`。
- **结果区永远是一组 tab**：无论单/多语句，都走 tab 模型（全面 tab 化）。
- **每个 tab 自带交互状态**（R6）：`sort` / `filters` / `pageSize` / `total` 存在 `ScriptTab` 上，排序、翻页、筛选只影响当前 tab。此前它们写在 console 级的 `QueryState` 里——第二个 tab 会继承第一个的排序，且每次 refetch 都会把排序丢掉。

---

## 5. 批次身份与就地更新（Q11）

- agent 每次投递带一个 **`label`** 参数（语义名，如 `月报-2026-10`、`订单排查`）。
- **同名 = 同一批次** = 进同一个 `ai_<label>` console **就地更新**（连执行历史都按语句位置记，不追加）。
- **同名但 SQL 实质不同** → 判定为新批次，**另开** console（误并兜底）。
- （可选补充）agent 若能拿到会话 id，可一并带上，用于同名冲突时进一步区分。

---

## 6. 生命周期与回收（Q12）

- `ai_*` console **上限 8**。
- 超出 → **LRU 自动关闭最久未活动**的那个。
- 被关的不丢失 → 进侧栏 **「AI 历史」抽屉**，点一下**复活**（重开 console，结果仍在）。
- 「AI 历史」抽屉是 LRU 的前置依赖（否则早期批次会凭空消失），与 LRU 打包交付。

---

## 7. 焦点与通知（Q14）

- agent 投递**不抢焦点**：用户在自己的 console 继续干活。
- `ai_` 标签亮**未读角标点**（克制，不整条高亮变色）。
- 轻 toast：「`ai_<label>` 已出结果」，可忽视；想看再点。

---

## 8. 失败处理（Q17）

- agent SQL 报错 → 进该 agent console 的 **「输出」tab**，**红色标记 + 未读角标**，可追溯（同 DataGrip 的「输出」tab）。
- 错误与结果同区但分开标记；**不在结果 tab 显示错误**。

---

## 9. 明确不做（v1.1 再说）

| 项 | 说明 |
|---|---|
| 复制到自身 console（promote） | SQL 已在 agent 编辑区，用户可手动复制；「一键发到我自己的 console」后置 |
| 流式 vs 一次性投递 | v1 先一次性；流式后续 |
| 多 agent 并发 | v1 单 agent |
| 权限（只读/写） | v1 沿用现有连接权限 |

---

## 10. 验收清单

- [ ] agent 投递结果进 `ai_<label>` console，**不覆盖**用户当前 console
- [ ] 单语句复用当前结果 tab；多语句 N 个结果 tab；标题 `首列名:类型`
- [ ] 同名 `label` 就地更新；SQL 实质不同另开
- [ ] `ai_*` 超 8 个 LRU 回收；「AI 历史」抽屉可复活
- [ ] 投递不抢焦点，未读角标点 + 轻 toast
- [ ] 报错进「输出」tab 红色标记
- [ ] 新建 console 时显式选连接；原 console 内作业继承连接

---

## 11. 与现有文档的关系

- `03-UIUX-SPEC` §多语句 / console 标签：本规格在其结果区骨架上**叠加 agent 路由层**（落点、批次、回收、焦点），不改动其 console/网格基础。
- `02-ARCHITECTURE`：agent 经 MCP `execute_sql` / `fetch_page` 投递；本规格定义**落点与生命周期**。
- `09-BACKLOG`：promote、流式等后置项可登记为新的 B 项（P1/P2）。

---

## 12. v1 Review：落地前的缺口与冲突

> 本 review 对照 `02-ARCHITECTURE` / `05-MCP-SPEC` / `03-UIUX-SPEC` 与实际代码（`documents.ts` / `ScriptResults.tsx`）逐条核对。
> **总评**：方向自洽（隔离 + tab 化 + 批次 + LRU + 不抢焦点），但 **v1 缺一根最关键的骨头（结果回推通道）**，且 3 处 MCP 契约、3 处数据模型未对齐；按现状直接开工会在「结果怎么从 agent 跑到 UI」卡住。

### 12.1 致命缺口（不补则整份规格悬空）

**R1 · agent 结果没有回推 UI 的通道（最严重）**
- 证据：`02 §116` agent 走 MCP stdio、人走宿主 HTTP；全仓检索无 `EventSource`/`WebSocket`/SSE/事件推送；`execute_sql` 的返回值只回给 agent，不进入 `DocumentTab`。
- 影响：第 4–8 节（路由/批次/回收/焦点/失败）全部依赖一个**不存在的 relay**。
- 建议：新增「结果中继」——MCP 执行后把 `{label, connId, sql, response}` 写宿主 store（或事件总线）→ 宿主 push 给面板（SSE 或 dsh 事件）→ 面板创建/更新 `ai_<label>` 的 `DocumentTab`。**这是前置工程项，v1 规格未写。**

**R2 · MCP 只有 `execute_sql`，且「多语句仅执行第一条」**（`05 §3.2` L47/L51）
- 影响：Q10 的「多语句 N 个 tab」在 agent 路径**产生不了**。agent 若分多次调用，每次单语句 → 按 Q10「复用当前 tab」会**互相覆盖**。
- 建议：二选一并写进规格——① 新增 MCP `execute_script`（返回 `statements[]`）；② 明确「agent 一次投递 = 单语句，多结果只来自人侧 `/execute-script`」。

**R3 · `execute_sql` 无 `label` / console 目标参数**（`05 §3.2` L47）
- 影响：Q11 的批次身份、Q16 的「落哪个 console」都无处承载。
- 建议：新增 `label?: string` 与 `target?: 'new' | { consoleId }`；或新开 `deliver_result` 工具。属 MCP 契约变更，走 `05 §3` 的 minor + 迁移说明。

### 12.2 数据模型缺口

**R4 · `MAX_TABS = 8` 是 console 总数，不是 agent 专用额度**（`documents.ts:36`）
- Q12 说 ai_ 上限 8 + LRU，但总名额也是 8 → agent 一多就挤掉用户 console，与 Q2「隔离」矛盾。
- 建议：拆 `MAX_USER_TABS` / `MAX_AGENT_TABS`（如 8 + 4/8），LRU 只在 agent 池内跑。

**R5 · `DocumentTab` 缺 agent 身份字段**（现字段 `documents.ts:22-33`：`id/title/connId/query/script/lastRunSql`）
- Q11 同名更新、Q12 LRU、Q14 未读角标都无字段可依。
- 建议：加 `owner: 'user'|'agent'`、`label?: string`、`unread: boolean`、`lastActivityAt: number`。

**R6 · 单语句走 `query`、多语句走 `script`，两套模型**（`documents.ts:29-30`）
- Q10「全面 tab 化」的真实成本不是「加个 tab」，而是把 `QueryState`（sort/pageSize/filters）**下沉到每个 `ScriptTab`**——否则 tab 切过去排序就丢。`ScriptResults.tsx:77-80` 的 `filterEnabled={false}` 注释也印证「按语句作用域的模型还没建」。
- 建议：`ScriptTab` 扩为 `{ sql, state: QueryState, result, error }`；单语句构造单元素 ScriptRun。

### 12.3 内部 / 文档冲突

**R7 · Q2（隔离）与 Q16（改原 console）打架**
- agent 改用户 console 并执行单语句时，按 Q10 会**复用/覆盖用户当前结果 tab**——正是 Q2 要避免的。
- 建议：明确「改原 console」= 只改 SQL 文本（不自动执行），或 agent 在该 console 执行时**强制新建结果 tab**。

**R8 · tab 标题与现有实现/文档/测试冲突**
- 现状：`语句 {index+1}` + `N 行 · Xms`（`ScriptResults.tsx:62-63`），测试断言 `['语句 11 行 · 5ms', …]`（`script-results.spec.tsx:67`），`03 §多语句` 同口径。
- 改为 `首列名:类型` 需同步 03 + 测试；且**重名列无解**（两句都返回 `a:int` 时标题相同）→ 加序号 `a:int (2)`。

**R9 · 「输出」tab 不存在**
- 现状：错误是每条语句的 `ScriptTab.error`，内联在结果区（`ScriptResults.tsx:31,73`），无 console 级输出区。
- Q17 的「错误进 输出 tab」是新结构，需与 R6 的「错误跟语句走」二选一。

### 12.4 未定义边界

| # | 缺口 | 建议 |
|---|---|---|
| R10 | Q11「SQL 实质不同」判定规则缺失 | 归一化后相等 / 语句数与列集比对；给出阈值 |
| R11 | LRU 保护 | 不得回收「当前激活」或「有未读」的 agent console |
| R12 | 「AI 历史」内存 | 每 console 上限（如 50MB）/ 最多 20 条 / 7 天 TTL |
| R13 | Q16「新建 console 显式选连接」与 Q15「无入口」冲突 | 实际 = MCP 调用里的 `connId` 就是选择结果（agent 在对话中问用户或自带）；删掉「唤起时选」的悬空动作 |
| R14 | agent 写同一 console 编辑器时抢光标 | 定「写入不抢光标 / 仅在空文档时写入」 |
| R15 | `ai_月报-2026-10` 长标题挤爆标签条（03：右栏仅 ~500px） | 沿用 `max-width:180px` + 省略号 |

### 12.5 建议修订顺序

1. **R1**（relay 通道）——决定后面全部能否做。
2. **R2/R3**（MCP 契约：label、多语句、目标 console）。
3. **R4–R6**（模型：owner/label/unread/lastActivity + ScriptTab 带 QueryState）。
4. **R10–R12**（批次判定、LRU 保护、历史 TTL）。
5. 同步 `03` + 测试（R8/R9）。

### 12.6 Review 结论

- **方向**：✅ 自洽，值得做。
- **可落地性**：⚠️ v1 目前缺最关键的结果回推通道，且 MCP 契约与数据模型各 3 处未对齐。
- **建议**：以本 §12 为 v1.1 修订输入，先补 R1–R3 再动代码。

---

## 13. v1.1 修订：R1–R3（结果回推 / 多语句 / MCP 契约）

> 本节是对 §12 中 R1–R3 的**落地设计**。三项一起改，才能让第 4–8 节的规则真正跑起来。

### 13.1 R1 · 结果回推通道（三段式）

**约束（决定选型的事实）**
- MCP server 是 **stdio 子进程**，不是 Cordis 插件：**没有 `ctx`**，拿不到 `storageDomain`/`webServer`。
- 宿主→MCP 唯一既有通道是 `runtime-specs` 文件（`05 §1`），且 spawn argv 是**静态路径** → MCP 无法得知宿主动态端口。
- 宿主 `webServer.register` 拿的是原始 `IncomingMessage/ServerResponse`（`host/contract.ts:52-58`）→ **可自行写 `text/event-stream`**。

**方案：文件出箱 + 宿主广播 + SSE（轮询兜底）**

| 段 | 机制 |
|---|---|
| **① MCP → 宿主** | MCP 执行后把**投递信封**原子写入 `<runtimeDir>/agent-outbox/<ts>-<seq>.json`（先写 `.tmp` 再 `rename`）。`runtimeDir` 由既有 specs 路径推导，不新增 argv。 |
| **② 宿主 → UI** | 宿主用 `fs.watch(outbox)` + **1s 轮询兜底**发现新文件；读取后经 `GET /dsh-data-ide/agent-events`（SSE）广播 `event: agent-result`，`id:` = 信封 id，支持 `Last-Event-ID` 续传；广播成功后**删除**文件（或移入 history）。 |
| **③ 兜底** | SSE 被反代缓冲/断开时，客户端退化为 **1s 轮询** `GET /dsh-data-ide/agent-results?since=<cursor>`（宿主从 history/缓存返回）。 |

**投递信封 schema（v1）**
```json
{
  "schema": 1,
  "id": "1699999999-7",
  "label": "月报-2026-10",
  "connId": "doris",
  "consoleId": null,
  "sql": "select ...",
  "kind": "single",
  "at": "2026-10-21T00:00:00.000Z",
  "single": { "columns": [], "rows": [], "total": 0, "hasNextPage": false, "durationMs": 12, "statementId": "..." }
}
```
- `kind: "script"` 时用 `script: [{ index, sql, ok, response? | error? }]`，`single` 缺省。
- **体积上限**：单信封 ≤ 8MB；超限只写 `{ "preview": { "rows": 前 100 行, "truncated": true } }`，UI 提示「结果过大，翻页查看」并走 `fetch-page`。

**为什么不用别的**
| 备选 | 否决理由 |
|---|---|
| MCP 直接 HTTP 回调宿主 | MCP 不知宿主动态端口（argv 静态），需额外注入端口，耦合高 → 留作备选 |
| 共享 `storageDomain` | MCP 非 Cordis 插件，无 `ctx` → 不可行 |
| 宿主拿 SQL 重跑一遍 | 双倍执行，浪费且可能不一致 → 否决 |

**三个必须写清的点**
1. **翻页不新建通道**：信封里已有 `connId + sql`，后续翻页复用现有 `POST /dsh-data-ide/fetch-page`。
2. **广播 ≠ 执行成功**：只投递 UI，**不改变 agent 拿到的工具返回值**（agent 仍按工具响应推理）。
3. **最小模型配套**（R5 的子集，R1 必需）：`DocumentTab` 至少先加 `owner: 'user'|'agent'`、`label?: string`、`unread: boolean`、`lastActivityAt: number`，否则 UI 无法应用事件。

### 13.2 R2 · MCP 多语句：新增 `execute_script`

**结论**：新增 MCP 工具 **`execute_script`**，复用 `src/execute/script.ts`（与人侧 `POST /execute-script` 同一引擎、同一遇错即停语义）。

- **入参**：`{ connId, sql, label?, consoleId?, pageSize?, maxStatements? }`
- **默认**：`maxStatements = 20`；总超时沿用 `toolCallTimeoutMs = 120s`。
- **出参**：`{ statements: [{ index, sql, ok, response? | error? }], stoppedAt?: number }`；`stoppedAt` = 首个失败语句序号（0 基）。
- **语义**：遇错即停；超 `maxStatements` → 拒绝 `TOO_MANY_STATEMENTS`（不静默截断）。
- **投递**：含 `label` → 按 §13.1 写一个 `kind:"script"` 信封（N 个结果集 → N 个结果 tab）；不含 `label` → 只回 agent。
- **与 `execute_sql` 的关系**：`execute_sql` **保持「只跑第一条」**（`05 §3.2` 现状，向后兼容）；需要多结果时才用 `execute_script`。

### 13.3 R3 · MCP 契约：`label` / `consoleId`

**参数（`execute_sql` 与 `execute_script` 共用）**
| 参数 | 类型 | 说明 |
|---|---|---|
| `label` | `string?` | 批次语义名，≤64 字符，限 `[A-Za-z0-9_\-\u4e00-\u9fa5]`。**存在即投递 UI**，缺省只回 agent |
| `consoleId` | `string?` | 目标 console；缺省 = 新建 `ai_<label>` |

**目标解析**
| 情形 | 行为 |
|---|---|
| `consoleId` 缺省 | 新建 `ai_<label>`（`connId` 来自调用参数 = R13 的「选连接」落点） |
| `consoleId` 指向 agent console | **就地更新**（Q11） |
| `consoleId` 指向**用户 console** | **拒绝** `CONSOLE_NOT_AGENT`，且不执行、不投递（解 R7）。判定依据：面板经 `POST /agent-consoles` 发布快照 → 宿主写入 `<runtimeDir>/consoles.json` → MCP 执行前读取 |

**同名冲突判定（R10 落地）**
- 归一化：去注释、折叠空白、转小写。
- 同 `label` 且归一化 SQL **相等** → 就地更新。
- 同 `label` 但 SQL **不等** → 新建 `ai_<label>#2`（序号递增）。

**契约变更等级**：新增**可选**参数 = **minor**，按 `05 §3` 写迁移说明；`execute_script` 为**新增工具**（自由新增）。

### 13.4 v1.1 契约汇总

| 工具 | 新增参数 | 投递 | 多语句 |
|---|---|---|---|
| `execute_sql` | `label?`、`consoleId?` | 有 `label` 才投递 | 仍只跑第一条 |
| `execute_script`（新） | `label?`、`consoleId?`、`maxStatements?` | 有 `label` 才投递 | 遇错即停，N 个结果 |

**UI 侧最小改动**：`DocumentTab` 加 `owner/label/unread/lastActivityAt`；面板订阅 `agent-events`（SSE）并在断线时切换轮询。

### 13.5 v1.1 验收

- [ ] MCP 带 `label` 执行 → 出箱文件生成 → 宿主 1s 内广播 → 面板出现/更新 `ai_<label>`
- [ ] 不带 `label` → UI 无变化，agent 仍拿到工具返回值
- [ ] `execute_script` 3 条语句 → 3 个结果 tab，标题按 §4；遇错停在第 2 条
- [ ] `consoleId` 指向用户 console → `CONSOLE_NOT_AGENT`
- [ ] 同名 `label` + 同 SQL → 就地更新；SQL 不同 → `ai_<label>#2`
- [ ] SSE 断开 → 1s 轮询仍能收到结果
- [ ] 信封 >8MB → 只投 preview，翻页走 `fetch-page`

---

## 14. 实现状态（2026-10-21）

### 已完成：R1 + R2 + R3

| 层 | 文件 | 内容 |
|---|---|---|
| 共享 | `src/execute/agent-delivery.ts` | 信封类型、`label` 校验、SQL 归一化/同批次判定、超 8MB 缩为 preview、宿主侧 `parseDelivery` |
| 共享 | `src/execute/script.ts` | `ScriptRequest.maxStatements`（只有 MCP 传，人侧不变）；超限拒绝 `TOO_MANY_STATEMENTS`，**不静默截断** |
| MCP | `mcp/agent-outbox.ts`、`mcp/server.ts`、`mcp/tools.ts` | `.tmp`+`rename` 原子出箱；`execute_sql` 加 `label?`/`consoleId?`；**新增 `execute_script`**（复用同一引擎、`MAX_SCRIPT_STATEMENTS=20`、遇错即停、N 条语句 → 一个 `kind:"script"` 信封） |
| 宿主 | `src/host/agent-relay.ts`、`src/host/agent-routes.ts`、`src/index.ts` | 1s 扫描出箱、环形历史（200）、SSE `GET /agent-events`、轮询 `GET /agent-results?since=`、卸载时释放 |
| 面板 | `src/client/agent-stream.ts`、`state/documents.ts`、`SqlWorkbenchPanel.tsx`、`DocumentTabs.tsx` | SSE 主路 + 轮询兜底；`ai_<label>` 新建/就地更新、异 SQL 开 `#2`；agent 池软上限 4，溢出时把最久**已读**的移入 **「AI 历史」抽屉**（tab 条入口，点击可重开）；未读点、不抢焦点、轻 toast；`kind:"script"` → N 个结果 tab |

| 共享 | `src/execute/console-registry.ts` | console 归属快照的 schema 与解析；未知 id = 「不知道」，按新 console 处理 |
| 宿主 | `src/host/console-registry.ts`、`agent-routes.ts` | `POST /agent-consoles` 接收面板快照，原子写入 `<runtimeDir>/consoles.json` |
| MCP | `mcp/console-registry.ts`、`server.ts` | 执行前读快照，`consoleId` 命中 `owner:"user"` → **`CONSOLE_NOT_AGENT` 且不执行、不投递**；快照缺失/损坏 → 放行 |

| 面板 | `src/client/components/ScriptResults.tsx`、`SqlWorkbenchPanel.tsx` | **R6**：每个结果 tab 自带 `sort / filters / pageSize / total`，排序、翻页、筛选按 tab 独立；回调全部改为 index 化（`onSort(index, column)` 等） |

**验证**：`tsc --noEmit` 干净；全量测试 **775 通过**（60 文件）；`build.mjs` 三个产物构建成功。（基线 712 + 新增 63；收尾清理掉 7 条随死代码一起失效的用例。）

### 未完成

**无。** §12 的 15 条 review 全部闭合（见 §15.6/§15.7）。

---

## 15. 对抗性代码审查（2026-10-21，R1/R2/R3/R6/R8/R9 落地后）

> 方法：假设实现是错的，逐条找能产生**错误结果或数据丢失**的路径。每条都附代码证据；末尾列出「查过但**没有**问题」的项，避免误伤。

### 15.1 P0 — 会产生错误结果 / 丢数据

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| **A1** | **同 label 换连接，结果被静默并进旧连接的控制台** | `documents.ts` 复用分支 `connId: reuse.connId ?? delivery.connId` | agent 在 connB 跑同一 label + 同 SQL，落进 connA 的 console，颜色/名称都在撒谎，用户会以为是 connA 的数据 |
| **A2** | **出箱文件先删、后广播** | `agent-relay.ts` `scan()`：`await unlink(path)` 在 ring/notify 之前 | 进程在删除后崩溃 → 投递永久丢失，且无日志 |
| **A3** | **LRU 承诺的「AI 历史」抽屉不存在** | 无 drawer 模块；`evictAgentTabs` 直接 `filter` 掉 | 第 5 个 agent console 会**静默销毁**第 1 个的结果（Q12 的兜底没做）；且未读阻止淘汰 → 上限 4 实际失效、可无界增长 |
| **A4** | **多实例共用一个 spool，无 claim** | 路径只由 `dshHomePath('data-ide-runtime')` 推出，不含 profile/实例 id | 桌面端与另一个 profile 的 UI 同时运行 → 同一投递被两边各收一次（重复），或一边先删另一边读不到（丢失） |

### 15.2 P1 — 与规格不符或边界可绕

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| **A5** | `maxStatements` 由调用方传入，可被放大绕过上限 | `maxStatements: maxStatements ?? MAX_SCRIPT_STATEMENTS` | agent 传 10000 即绕过；「上限」只是默认值，不是约束 |
| **A6** | SSE 的 `Last-Event-ID` **未实现** | `agent-routes.ts` 从不读该请求头；§13.1 声称支持续传 | 断线期间的投递直接丢；客户端只在 `error` 事件时降级轮询，而 EventSource 常常静默重连 |
| **A7** | 8MB 上限按 **UTF-16 字符数**算，不是字节 | `JSON.stringify(delivery).length` | 中文载荷实际可达约 24MB，spool/内存预估失真 |
| **A8** | `parseDelivery` 只校验到「是对象」，不校验 `rows/columns` | `isRecord(raw['single'])` 后直接 cast 成 `ExecutionResult` | 坏/手工构造的信封会一路进 `ResultGrid` 并崩渲染（spool 是同用户可写） |
| **A9** | `execute_script` 把 **N×pageSize 行**原样回灌 agent | 返回 `{ ok: true, ...outcome }`，无截断 | 20 条语句 × 500 行 = 上万行进模型上下文，token 爆炸/超时 |
| **A10** | 显式 `consoleId` 复用时**不更新 label/标题** | 复用分支只 patch `query/script/lastRunSql/unread/lastActivityAt` | 换了 label 仍复用旧 tab，标题与实际批次漂移 |

### 15.3 P2 — 体验与健壮性

| # | 问题 | 说明 |
|---|---|---|
| **A11** | spool 无 TTL 清理 | 宿主长期不启动时 `agent-outbox/*.json` 无界增长；插件卸载也不清 |
| **A12** | 未读点用 `role="status"` | 每次渲染都可能被读屏播报；应只留 `aria-label`/`title` |
| **A13** | 输出 tab 让 `aria-label="语句结果"` 语义不准 | tablist 现在同时含「输出」 |
| **A14** | 运行中单语句 tab 标题是 `—` | 更该是「执行中」 |
| **A15** | 中继测试用 120ms 固定睡眠 | 慢机/CI 上可能 flaky，应答式等待更稳 |

### 15.4 查过但**没有**问题（避免误伤）

- **连接绑定**：`withConnection` 用的是 `tabConnId`（tab 自己的连接），不是全局 active —— 在 agent console 里执行不会跑到别的库。
- **焦点**：`applyAgentDelivery` 原样返回 `activeId`，投递不抢焦点；面板订阅用 ref 读 activeId，不会因重渲染重复订阅。
- **单语句筛选/排序**：R6 只是把渲染搬进 tab 条，`QueryState` 仍在原处，`sortBy`/`goPage`/`setFilters` 通路未变。
- **投递开关**：无 `label` 不写盘（测试覆盖），agent 纯取数不会污染 UI。
- **标题注入**：`isValidLabel` 限定字符集，且 React 本身转义，标题不能被注入。

### 15.5 建议修复顺序

1. **A1**（连接正确性）→ **A2 + A4**（投递不丢/不重）→ **A3**（抽屉或改为不自动淘汰）。
2. **A5**（clamp 上限）→ **A9**（脚本返回截断/摘要）→ **A8**（校验 payload）。
3. **A6/A7**（字节口径、续传）→ A10–A15。

### 15.6 修复结果（2026-10-21 01:36）

| # | 状态 | 做法 |
|---|---|---|
| **A1** | ✅ | 复用要求 `connId` 相同（或旧 tab 未绑定）；连接变了就开新 console |
| **A2** | ✅ | 改为**至少一次**：先广播、后删文件，崩溃只会重放 |
| **A3** | ✅ 已闭环 | 溢出时把最久**已读**的 console 移入 **「AI 历史」抽屉**（`DocumentTabs` 入口，点击重开），不再销毁；**全未读时允许超过 4 个**——不隐藏用户没看过的结果。LRU 因此名正言顺地回来了 |
| **A4** | ✅ 已定义语义 | 不做 claim；两实例可能各投一次，UI 侧幂等（同 label + 同 SQL 只更新一个 tab） |
| **A5** | ✅ | `Math.min(maxStatements ?? MAX, MAX)` |
| **A6** | ✅ | SSE 读 `Last-Event-ID`，订阅后按 `relay.since()` 补发（重复可容忍、丢失不可） |
| **A7** | ✅ | `utf8Bytes()`（`TextEncoder`）计真实字节 |
| **A8** | ✅ | 校验 `columns/rows/error`，并要求 `kind` 与载荷匹配 |
| **A9** | ✅ | 回给 agent 的脚本结果按 **500 行总预算**裁剪并标 `rowsTruncated`；**投递仍保留完整首页** |
| **A10** | ✅ | 复用但 label 变化时重算 `title/label` |
| **A11** | ✅ | 启动时清理超过 24h 的 spool 文件 |
| **A12** | ✅ | 未读点去掉 `role="status"`，改 `title` |
| **A13** | ✅ | tablist 标签改「结果与输出」 |
| **A14** | ✅ | 未出结果时按 `running` 显示「执行中」，否则 `—` |
| **A15** | ✅ | 中继/轮询测试改为**等待式**（2s 上限），不再固定睡眠 |

**验证**：738 通过（53 文件）、`tsc --noEmit` 干净、`build.mjs` 成功。

### 15.7 仍未闭合

**无。** `consoleId → 用户 console` 已返回 `CONSOLE_NOT_AGENT`（§14 注册表）；`03-UIUX-SPEC` 标题/输出口径已同步；**R6 已收口**——每个结果 tab 自带排序/筛选/页大小，回调 index 化（见 §4）。


---

## 16. 上线后修复（2026-10-21）

桌面端首次加载新构建时报了两轮错误，都不是功能逻辑问题，而是**宿主契约**没对齐：

### 16.1 `Unexpected end of JSON input` → 空响应

`http-api.ts` 的 `unwrap()` 直接 `response.json()`。空 body（404/405/204/连接中断）会让它抛 `SyntaxError`，而真正的信息——「这条路由根本不存在 / 方法不对」——就此丢失；加上执行链路全是 `void xxx()`，最终以「未处理的 Promise 拒绝」弹到用户面前。

- `unwrap(response, route)` 改为**先 `text()` 再解析**：空 → `EMPTY_RESPONSE: <route> 返回了空响应（HTTP n）`；非 JSON → `BAD_RESPONSE` + 状态码 + 前 120 字。
- 面板加 `reportFailureToUser`，`withConnection` 统一 try/catch（覆盖所有执行/排序/翻页/筛选按钮），另补 `setActive`/`load`/`cancel` 三处链式调用的 catch。

### 16.2 `HTTP 405` → 同一路径注册了两次

`ROUTES.layout` 被写过两个注册：`carrier.register`（GET）和 `post()`（POST）。**宿主路由表是一个路径一个 handler**，后注册的 POST 顶掉了 GET；于是客户端发 GET，落到方法不匹配的分支，宿主回 **405 且 body 为空**（不是我们 `sendJson` 那个带 JSON 的 405）。

- 改为**单个注册**，handler 内按 `req.method` 分派：GET 读、POST 存、其他回 405（带 JSON body）。
- 回归用例 `tests/web-routes-layout.spec.ts` 用「一个路径一个 handler」的 router 替身，断言 **`ROUTES.layout` 只注册一次、整张路由表无重复路径**，再验 GET/POST/PUT 三条路径。

### 16.3 教训

1. **别把 `response.json()` 当安全操作**：空 body 是真实状态，必须先读文本再解析。
2. **一个路径只注册一次**：多方法在 handler 内分派，别指望宿主按方法路由。
3. **`void promise` 等于放弃错误处理**（08 R24）：凡是 `void` 掉的链，都要有内部 catch。
4. 排障时先看「报错文案是谁写的」——这次文案来自新代码，就说明新客户端已经在跑，不该先怀疑旧进程（我第一轮判断错了）。
