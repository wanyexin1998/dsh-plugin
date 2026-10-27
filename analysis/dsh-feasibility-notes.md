# DSH 0.2.1 宿主扩展面核查：工具降摩擦 + agent↔UI 互操作的可行性证据

> 任务：task-3｜作者：dsh-scout｜状态：完成（只读核查，未修改任何仓库 / 插件 / profile，未安装或启停任何插件）
> 唯一写入文件：本文件。
> 目标：给出「当前宿主到底支持哪些扩展面」的事实清单，让方案里的每条改造都能落到**已有公开 API**、或明确标注为「需宿主未公开能力」。

---

## 0. 环境核对（先纠正一个版本事实）

| 项 | 实测值 | 证据 |
|---|---|---|
| 桌面壳版本 | **0.2.1-rc.3**（不是 rc.2） | `ASAR/package.json:4`，`dshBuildCommit: be72761ee1a6736ebcdf4f3739363b083ae53c98`（`:25`） |
| 内置包版本 | 全部 `0.2.1-rc.3` | 例：`HOST/dsh-tools/package.json:4`；`HOST/dsh-client-ui-sidebar-right/package.json:4` |
| 本会话 profile | `desktop`（Electron 独占） | 运行时上下文；`AGENTS.md` §1 |
| 浏览器实际的 client UI 包 | **团队本地 rebuild 产物**（不是 asar 原样） | `Get-Item C:\Users\wanyexin\.dsh\profiles\desktop\node_modules\@deepseek-ai\dsh-client-ui-*` → `LinkType: Junction`，Target 指向 `E:\dsh-plugin\dsh-split\rebuild-v5\releases\0.5.0-rebuild.8-061d5756acd4\native\@deepseek-ai\*` |
| client inspect provider | **本会话不可用**：`Service.listService` / `Builtin.listBuiltins` / `Slots.listSubTree` 共 4 次均 10s 超时 | host inspect 全部正常；结论未受影响（见 §1 三条替代证据） |

**结论**：`dsh-data-ide/AGENTS.md` 里「目标宿主 0.2.1-rc.2」比实测低一个 RC；0.2.1 系列扩展面按 **rc.3** 记。rebuild 客户端与 asar rc.3 同版本同源，下文两类来源交叉验证过的结论对两者都成立。

---

## 1. 证据来源与方法（可复算）

1. **Inspect（最可靠）**
   - `cordis_inspect_list` → 9 个 Provider：host `Service/Event/Config/Tool`，client `Service/Event/Builtin/Slots/Theme`。
   - `Service.listService`（host，无参）→ **98 个 host 服务**目录；单服务查询取精确契约：`tools`、`storage`、`storageDomain`、`settings`、`commands`、`sessionProjections`、`mcpResources`。
   - `Event.listEvents`（host）→ 68 个事件（含 `tools/pre-execute|execute|post-execute|result`、`domain/changed`、`agent/created`、`session/event` 等）。
   - `Tool.listTools`（host）→ 本 Agent 实际可见的全部工具 schema（含 9 个 `mcp__sql__*` 的真实 schema）。
   - `Config.listConfigs`（host，216 条）→ 活动插件行与 `packageDir`；`{"entry":"include:mcp-sql"}` → MCP client 完整 Config JSON Schema。
2. **安装包 README / 源码（最详细）**：`HOST/<pkg>/README.md`（包级权威文档，含限制与源码 file 映射）、`HOST/<pkg>/lib/index.js`（可读的构建产物，带注释）。
3. **官方 skill**：`SKILL/cordis-plugin-development/references/practices.md`、`.../user-actions.md`、`SKILL/agent-experience/SKILL.md`。
4. **客户端 slot / 服务目录（client inspect 超时的替代）**：`RUNNER`（`E:\dsh-plugin\dsh-split\rebuild-v5\.native-source\dsh-cordis-client-runner.mjs`）。它是从 DSH 源码生成的 `cordis_inspect` 目录数据：**98 个 slot**，每条含 `kind/scope/registerOptions/ownerProps/standardProps/declaredBy/occupants/replaceRisk/example/source`（其中 `source: "packages/client/.../contract/slots.ts:<line>"`）。同时含 8 个 client 服务的精确方法契约（`:1125-1650`）。
5. **在跑插件源码**（同环境的真实先例）：`SQL/`（dsh-data-ide）、`REF/`（ref-ide-workbench）。

**缩写**（下文 `path:line` 均相对这些根）：

| 缩写 | 路径 |
|---|---|
| `HOST/` | `E:\deepseek-harness\resources\app.asar\dsh\node_modules\@deepseek-ai\` |
| `SKILL/` | `HOST/dsh-agent-preset/skills/` |
| `RUNNER` | `E:\dsh-plugin\dsh-split\rebuild-v5\.native-source\dsh-cordis-client-runner.mjs` |
| `SQL/` | `E:\dsh-plugin\dsh-data-ide\packages\client\ui-sql-workbench\` |
| `REF/` | `E:\dsh-plugin\ref-ide-workbench\` |

---

## 2. 结论速览（先看这张表）

| # | 命题 | 结论 | 成本 | 风险 |
|---|---|---|---|---|
| 1 | 改工具描述/参数 schema/output 契约来降摩擦 | **可行**（纯插件权限内） | 低 | 低：只影响模型侧；注意 KV cache（每次 schema 变动才失效） |
| 2 | 用 MCP `server instructions` 给模型注入使用纪律 | **可行**（≤32KB，自动进系统提示） | 低 | 低；注意它是每请求固定 token |
| 3 | 在聊天里给工具结果画自定义表格/按钮 | **可行**：client `tool.call.toolview` 按 wire tool name 注册 | 中 | 中：卡片要自己解析 text JSON；preparing/start/result 三态；PTC 子调用同 key |
| 4 | 回合结束后追加一张结果卡 | **可行**：`conversation.chat.turnTail` list 座位 | 低-中 | 低；渲染位置受 Chat 分组/折叠设置影响 |
| 5 | 工具卡/结果卡按钮「跳到右栏对应位置」 | **可行**：client 侧 `ctx.sidebarRight.openTab(kind,{params})` / `openResource(address,{params})` | 低-中 | 中：需自己维护 params 契约（宿主不运行时校验） |
| 6 | 助手正文文件链接自动开右栏 | **现成能力**（`#L24` 都支持） | 0 | — |
| 7 | Host 的 `presentCall/presentResult` 在 Web 聊天里渲染自定义卡 | **不可行**（Web 客户端不消费；只能 client 座位） | — | — |
| 8 | 往聊天输入框插文本 / `@file`（发送后渲染为引用） | **可行**：`inputActions.captureInsertion/insertText/persistDraft`（纯文本） | 低 | 低：选区塌陷、失败 toast、`persistDraft` 尽力而为 |
| 9 | 程序化插「结构化 @引用 chip」 | **不可行**（公开 API 只插纯文本） | — | — |
| 10 | MCP 工具注解（readOnlyHint 等）影响宿主审批/呈现 | **不可行**（bridge 不读 annotations） | — | — |
| 11 | MCP 进度通知 / elicitation / sampling / 资源订阅 | **不可行**（bridge 不声明/不转发） | — | — |
| 12 | MCP `resources`（list/templates/read） | **可行**（宿主已挂 3 个资源工具） | 低-中 | 低：按需读、不推送 |
| 13 | MCP 工具 `isError` 让模型看到失败 | **已可行**（bridge 把 isError 抛成工具错误） | 0 | — |
| 14 | 插件持久状态（跨重启） | **可行**：`ctx.storageDomain`（zod 校验、同步读、写即持久） | 低-中 | 低：无跨进程可见性、无迁移 |
| 15 | 会话级派生状态推给 client | **可行**：`ctx.sessionProjections`（wire view） | 中 | 中：只能从 session 事件折叠，不能塞任意旁路数据 |
| 16 | MCP server ↔ host 插件共享内存状态 | **不可行**（stdio 子进程无 ctx） | — | — |
| 17 | MCP→host 传数据（比 spool 文件更优） | **可行但需自建**：host 写 origin+token 到 runtime 目录，MCP POST 到 host `webServer` 路由 | 中 | 中：鉴权/重试要自己写对 |
| 18 | host→client 推送（除 SSE/轮询） | 公开面只有 webServer 路由 + 自建 SSE/轮询；in-box 用的 `ctx.remote` 是生成的**内部**命名空间，外部插件注册自己的 namespace 无公开证据 | — | 高：别押注 |
| 19 | UI 操作与 agent 工具「一次实现，两处调用」 | **源码级可行**（共享模块）；**运行期单权威不可行**，除非 MCP 工具改为代理 Host | 中-高 | 中：双写一致性（A1/A4/A10 类） |
| 20 | 右侧栏 tab 的 guide / 动态标题 / keepMounted / 双 pane | **全部存在且可用**（0.2.1 新增双 pane + 浮动面板） | 低 | 低 |

---

## 3. Q1｜工具的注册面：schema、description、结果渲染

### 3.1 注册契约（Host inspect `Service.listService({"service":"tools"})`）

```
ctx.tools.register(definition: ToolDefinition): () => void   // 全局或调用方 agent scope；同层重名/保留名 run_code 失败
ToolSchema = { deferLoading?: true; name: string; description: string; parameters: Record<string, unknown> }
ToolDefinition extends ToolSchema = {
  output: ToolOutputDefinition
  execute(args, exec): Promise<unknown>
  projectContent?(exec,result): ContentBlock[] | undefined
  finalizeContent?(exec,result): ContentBlock[] | undefined
  timeoutMs?: number
  isConcurrencySafe?(args): boolean
  presentCall?(args): ToolCallView | undefined
  presentResult?(args, result): ToolResultView | undefined
}
ToolOutputDefinition = { schema: JsonSchemaNode; render(args,value): ContentBlock[]; presentationMeta?(args,value): JsonValue }
```

- **description 无长度/格式硬限制**：`ToolSchema` 类型层没有约束，inspect 契约里也没有校验说明；约束来自设计规范而非运行时。官方建议（`SKILL/agent-experience/SKILL.md:15-19`）：描述行为不描述实现、参数规则写在参数上、每条事实只说一次、用首轮 token 量度量改动。→ **可自由重写，但别把规则重复进系统提示**。
- **参数的 JSON Schema 子集**：native 工具首选 `defineTool` 的强类型 DSL；底层 raw JSON Schema 是 `JsonSchemaNode`（`type/oneOf/properties/required/additionalProperties/items/enum/const/description/title/default/examples`，见 inspect `tools` referencedTypes）。`dsh-tools/README.md:64`：raw JSON Schema 是与 subagent/workflow/MCP 共享的 wire 形态。
- **输出 schema 有强制子集**：`assertSupportedJsonSchema`（`HOST/dsh-tools` 的 raw JSON Schema 子集，`dsh-tools/README.md:109,118`）；MCP 桥对服务器 `outputSchema` 先试 `assertSupportedJsonSchema`，不支持就**整体退化为 `{}`**（`HOST/dsh-mcp-client/lib/index.js:162-171`）。
- **MCP 的 inputSchema 原样透传**：`createMcpToolDefinition` 把 `tool.inputSchema` 直接放进 `parameters`（`HOST/dsh-mcp-client/lib/index.js:182-197`）。证据：`Tool.listTools` 里 `mcp__sql__*` 的 `parameters` 带着 MCP SDK 生成的 `$schema: "http://json-schema.org/draft-07/schema#"`——**说明没有重写、没有子集过滤**（但也没有 per-parameter `description`，见 Q7 的摩擦点）。
- 其它注册面：`ctx.tools.restrict()`（只能删）、`ctx.tools.guard()`（同步拒绝）、`ctx.tools.presentAs('native'|'ptc')`（按 scope 声明呈现模式）、事件 `tools/pre-execute`（可 allow/deny/ask）、`tools/execute`（包装超时/重试）、`tools/post-execute`（改写结果）、`tools/result`（只读观察）。`tools/README.md:89,109,126,141`。
- **`timeoutMs` 只是声明，注册表不强制**（`dsh-tools/README.md:235`）；真正超时靠 `@deepseek-ai/dsh-tool-call-timeout-policy` 或 MCP 桥自己的 `toolCallTimeoutMs`。

### 3.2 工具结果怎么渲染（关键限制）

- **Host 的 `presentCall/presentResult` 不被 Web 客户端消费**：`dsh-tools/README.md:95` 原文「A tool can retain pure `presentCall()` and `presentResult()` methods for Host-local consumers. **The built-in Web Client does not consume those values.**」；`ToolResultView` 只是固定联合（generic/diff/read/search/terminal/web，inspect 类型），不是自由组件。
- 实际渲染路径：`ui-tool` 把每个原子调用按**wire tool name** 派发到 keyed slot `tool.call.toolview`；未注册的名字走通用卡（`HOST/dsh-client-ui-tool/README.md:12,36-46`；`RUNNER:5968-6010`）。ownerProps 见 §5.3。
- 结果内容约束：**Session 只记录 `ToolOutputDefinition.render` 产出的 ContentBlock**（canonical value 只给程序化/PTC 调用方，`dsh-tools/README.md:36,109`）。MCP 桥的 render 永远只产 `[{type:'text', text: extractText(...)}]`（`HOST/dsh-mcp-client/lib/index.js:200-220`）；`structuredContent` 只存在 canonical value 里，**不进会话**。
  → 因此「聊天里的 SQL 结果表格」只能由 client 视图**解析结果文本 JSON**（data-ide 的 MCP 工具恰好都返回 `JSON.stringify(...)` 文本，`SQL/mcp/server.ts:212,227,243,282,303,344-345,365,405-406,456-457,476-477`）。
- 图片是唯一被桥持久化的富结果：`image` 块经 attachment 存储后进入 content（`HOST/dsh-mcp-client/lib/index.js:312-353`；`README.md:211` 明确「Image is the only durable rich-result bridge」）。

**Q1 结论**：工具 schema/description 可自由改（无硬限制）；输出 schema 受限；**自定义结果卡片只能走 client slot，不能走 host presenter**；卡片只能看到渲染后的 text，因此**必须把结果文本设计成可解析且稳定的 JSON**（这本身也是一条低成本改进）。

---

## 4. Q2｜工具结果 → 可点击 UI 引用：宿主有哪些「现成的指针」

| 通路 | 谁触发 | 证据 | 适合场景 |
|---|---|---|---|
| a. **助手正文里的文件链接** `[x](rel/path#L24)` | 模型输出 markdown | `HOST/dsh-client-ui-chat/README.md:38`：消息结算后打开右栏文本预览，支持 `#L24`/`#L24-L30`、复用已有 tab、缺文件显示错误态 | 让 agent 在结论里给「可点位置」；deliverables 的 system-prompt 指引就是在教模型这么做（`HOST/dsh-client-ui-deliverables/README.md:96`） |
| b. **工具卡里的文件路径摘要** | 工具调用 | `HOST/dsh-client-ui-tool/README.md:82`：卡片 `filePath` 摘要调 `openFile` → 右栏文本预览；`openFile` 是 owner prop（`RUNNER:5980`） | read/edit/grep 类工具已有；SQL 工具不产文件，用不上 |
| c. **插件自绘按钮 → 打开自己的右栏 tab 并传参** | 插件 client 代码 | `HOST/dsh-client-ui-sidebar-right/README.md:93`：`openResource(address, options?)` / `openTab(kind, options?)`，`params` 经 navigation 传给 tab body；`README.md:84`：body 用框架注入的 `useTabInfo()` 拿 `tab.navigation` | **本方案主通路**：卡片按钮 → `openTab('dsh-data-ide.sql-workbench', {params:{...}})` |
| d. **`present` 工具 + turnTail 卡** | 模型调用内建工具 | `HOST/dsh-client-ui-deliverables/README.md:37-39`：`present(files)` → 回合尾部交付卡 → 点击在右栏预览；卡片/动作通过 `conversation.chat.turnTail` + `deliverables.file.actions` slot 实现 | 交付「结果文件」（CSV/报告）时直接复用；SQL 结果集不落地文件，故只能学结构 |
| e. **用户文本 mention**（`@[label](dsh-session:…)`、`@path`） | 用户在 composer 输入 | `HOST/dsh-client-ui-reference/README.md:30-34,60` | 用户→agent 方向，不是 agent→UI |
| f. **HTTP(S) 链接** | 模型输出 | `HOST/dsh-client-ui-chat/README.md:48`：按设置开「内置右栏 Browser tab」或外部浏览器 | 只适合外链 |

**deliverables 是「一次实现、两个调用方 + 聊天卡 + 右栏 tab」的完整官方样板**（建议照抄结构）：
Host 静态 system-prompt 段 + `present` 工具 + `workspace/changes` Host 数据 + client `conversation.chat.turnTail` 卡 + 注册 `changes-review` 右栏 tab 类型（`builtin` band、pattern 为 `dsh-resource://changes-review/...`）→ 行点击 `ctx.sidebarRight.openResource(address, {params: fileIndex})`（`HOST/dsh-client-ui-deliverables/README.md:67`）。

**Q2 结论**：助手正文文件链接（a）零成本可用；工具结果 → 右栏定位（c）需要插件自绘卡片 + 自己注册 tab 类型，**可行**；宿主没有「工具返回里带一个通用 UI 引用对象」的机制（presentCall 不消费），别按那条路设计。

---

## 5. Q3｜Chat 输入面可编程性 & 助手消息里的自定义行

### 5.1 输入框：只能插纯文本（但足够做「发送到聊天框」）

- `InputActions.captureInsertion()` 捕获草稿选区+revision；`insertText(text, span)` 只在 revision 仍有效且编辑器可编辑时插入**一次可撤销的纯文本编辑**（`HOST/dsh-client-ui-conversation/README.md:165`）。
- 拿到 `inputActions` 的公开姿势：注册一个 **session 作用域**的 composer 座位，它的 standardProps 里有 `inputActions` 与 `sessionId`；推荐 `conversation.input.dock`（list，输入卡下方的环境条目区，`RUNNER:3004-3058`）。REF 就是「隐形组件」：`REF/src/client/index.jsx:187-199,376-379`、`REF/src/client/chat-bridge.js:26-67`。
- 插入 `@path` 是**纯文本**；发送后由 `ui-reference` 的 `ctx.uiConversation.userText` 匹配器 + `conversation.user.text.node` 渲染器显示为文件引用（`HOST/dsh-client-ui-reference/README.md:30-34,62`）。→ **不能程序化生成原子 chip，但效果等价**（REF 的注释与测试就是这么做的：`REF/src/client/chat-bridge.js:11-14,100-143`）。
- 插入语义（照抄 REF 的坑）：选区塌陷到末尾、前面补空格、`persistDraft()` 尽力而为、失败要 toast（`REF/src/client/chat-bridge.js:48-67`）。
- 其它 composer 座位（`RUNNER:2623-3330`）：`conversation.composer`（chain，整块替换编辑器，用于 pendingInteraction takeover）、`conversation.composer.bar`（single，整条 bar，shadows-shipped-ui，别碰）、`conversation.composer.dock`（list，输入卡下方环境条目，ui-chat 的统计条就在这，`RUNNER:2752`）、`conversation.input.activity`（single，模型选择器与发送之间的可展开控件）、`conversation.input.{left,right,model,overlay,attachments,permission,plan}`。全部带 `inputActions/useSession/useProjection` 等标准 props。

### 5.2 助手消息里的插件自定义行

| 方式 | 机制 | 成本/风险 | 证据 |
|---|---|---|---|
| **A. 回合尾部卡片（推荐）** | `conversation.chat.turnTail`（list，`id/order/label`），ownerProps `{turn, seq, openFile}`；渲染在完成回合的动作行之前 | 低-中；受 Work details 折叠影响 | `RUNNER:2565-2620`；deliverables/plan/schedule 均在此 |
| B. 自定义工具调用卡 | `tool.call.toolview`（key = wire tool name，任意名字可注册） | 中；三阶段 + PTC 子调用 | `RUNNER:5968-6010`；`ui-tool/README.md:12,36-46` |
| C. 全新 Chat 行类型 | `ctx.uiConversation.events.register(definition)` + `conversation.chat.node` 按 definition 的 `kind` 注册视图 | **高**：kind 域被 ui-chat 的 `ChatNodeKind` 表固定（`RUNNER:2535` 已列全部 kind），且新 session 事件类型被禁（`SKILL/.../practices.md:21`），只能匹配已有事件 | `SKILL/.../practices.md:37`（官方推荐写法）；`ui-conversation/README.md:31`（events/views 注册） |

其它可复用座位：`conversation.chat.assistant-actions`（助手行动作）、`conversation.chat.turnTail`、`conversation.session.header.utilities`（会话头按钮，REF 用）、`conversation.session.header.corner`、`sidebar.footer.action`、`conversation.hero.options`（`RUNNER` 各条；`REF/src/client/index.jsx:359-389`）。

**Q3 结论**：输入框可编程（纯文本+失败可见）；「发送到聊天框」完全可行且已有生产先例；助手侧自定义行首选 turnTail 卡 / toolview 卡，**不要做新 Chat 行类型**。

---

## 6. Q4｜会话 / 工作区级状态 & MCP↔host 共享

### 6.1 插件可用的 Host 服务（inspect host `Service.listService`）

| 服务 | 关键契约 | 适合存什么 |
|---|---|---|
| `storageDomain` | `open(DomainSpec)` → `Domain{ global, table(name), close() }`；`KvTable`：同步 `get/entries/keys/size`、`put/delete/update`（写持久化后才 resolve）；`defineDomain(name,version,tables:zod)`；写后发 `domain/changed`（进程内） | **插件持久数据**（data-ide 已用：`SQL/src/index.ts:22`、`SQL/src/host/binding.ts:193`） |
| `storage` | backend 注册表 + 数据形态挂载（`ctx.storage.<form>`） | 一般不用直接碰 |
| `credentials` | 两套 key：`resolve/describe/set/unset`（ref）与记录型 `readRecord/modifyRecord/listRecords/deleteRecord`；无"列出明文"接口 | 密码/token（data-ide 已用：`SQL/src/index.ts:22`、`SQL/src/host/credentials.ts:4,27`） |
| `workingDirectory` | `defaultDirectory`、`get(session)`、`ensure(agent)`、`set(agent,path)` | 会话 cwd（插件一般只读） |
| `workspaceRegistry` | `create/get/list/delete/resolveByPath/archiveSession…` | 工作区注册表（只读消费） |
| `workspaceController` / `workspaceFiles` / `workspaceChanges` | `@Remote` 的 workspace CRUD / 文件读写观察 / 变更摘要 | client 侧已经能通过 `ctx.remote.*` 用的现成能力 |
| `sessionProjections` | `register({key,stateSchema,init,apply,wire?,stateVersion})`；`stateOf(session,key)`；`snapshot(session,keys)`；`onChanged` | **会话级派生状态**：只能从 `SessionEvent` 纯函数折叠；`wire.view` 的值会随 snapshot 到 client |
| `settings` | `describe/update/mutate/replace`：把插件 `Config` 投影成设置页表单；`configure({auto})` 控制是否自动生成页 | 用户可见的插件偏好（等于"把 Config 变成 UI 设置"） |
| `commands` | `register({name,description,input?,handler})` + `@Remote list/execute` | 人可用的 `/命令`，且是官方推荐的"UI 调用 Host 操作"入口 |
| `webServer` | `register(route)`（原始 `IncomingMessage/ServerResponse`）、`getOrigin()`、`registerUpgrade`、`tapIndex` | 插件自建 HTTP/SSE/WS（data-ide/REF 都在用） |
| `webApp` | `getAdvertisedUrl()` | 拿到本进程对外 origin（供 MCP 子进程回连用） |
| `mcpResources` | `register(server, provider)`（`resources/list|templates/list|read`） | 只用来发布 MCP 资源，**不是**调用 MCP 工具的通道 |
| `fs` / `subprocess` / `attachments` / `systemPrompt` / `tools` / `approval` / `userQuestions` | 见 `Service.listService` 单服务契约 | 按需 |

### 6.2 session 级 vs workspace 级生命周期

- **没有 workspace 级 KV 服务**。workspace 级插件状态只能：`storageDomain` 里建表、用 workspaceId/路径做 key（自己负责生命周期）；或 `settings` 存 profile 级配置。
- **session 级**：`sessionProjections`（从事件折叠、可 wire 到 client）；或以 sessionId 为 key 的 `storageDomain` 表；或 `agent/created` 里挂 `agent.ctx` 注册（`agent/disposed` 自动回收，`practices.md:19`）。
- client 侧"每 session 状态"的官方先例：右侧栏把每个 Session 的布局存 localStorage `dsh.sidebar-right.v1.<sessionId>`（`HOST/dsh-client-ui-sidebar-right/README.md:74`）；Host 侧偏好的先例：`ui-chat.linkOpening` 走 Host settings（`HOST/dsh-client-ui-chat/README.md:48`）。
- **存储域限制**（`HOST/dsh-storage-domain/README.md:12,73,146`）：单进程可见（`domain/changed` 不跨进程）、无跨表事务/二级索引、无自动迁移（版本不同直接拒绝打开）。

### 6.3 MCP server ↔ host 插件：为什么不能共享状态

- MCP server 是 **stdio 子进程**（`HOST/dsh-mcp-client/README.md:28,59`；`lib/index.js:40-46` spawn），**没有 Cordis ctx** → 不能 `storageDomain.open`、不能注册 `webServer` 路由、不能调任何 host 服务。
- host 也**不能调 MCP 工具**：`mcpResources` 只注册 provider（只读资源），`mcp-client` 不暴露"callTool"给 host。→ 反向 RPC 不可行。
- 现状（data-ide）：MCP 写 spool（`SQL/mcp/agent-outbox.ts`：`.tmp`+`rename`）→ host 1s 轮询扫描（`SQL/src/host/agent-relay.ts:6-17,90-133`）→ host SSE `GET /dsh-data-ide/agent-events` + 轮询兜底（`SQL/src/host/agent-routes.ts`、`SQL/src/index.ts:69-72`）→ client EventSource（`SQL/src/client/agent-stream.ts`）。全部落在公开面（`ctx.fs`/`ctx.webServer`/`ctx.dshHomePath`），**架构上可行，已实现**。
- **更优通道（可选升级，非必须）**：
  1. host 在启动时把 `ctx.webServer.getOrigin()`（或 `ctx.webApp.getAdvertisedUrl()`）+ 一次性 token 写入 MCP 已读的 runtime 目录；
  2. MCP 执行完带 token POST 到 host `/dsh-data-ide/agent-events`；
  3. host 用 `ctx.connection.requestRejection`（data-ide 已用它做面板路由 fence，`SQL/src/index.ts:56-61`）或自定义 token 校验；
  - 收益：去掉最多 1s 扫描延迟、天然 ack/背压、无需"删文件"竞态（现 A2/A4 类风险）；成本：MCP 加 HTTP 客户端 + token 文件 + 重试；风险：`webServer` 路由是裸 `IncomingMessage`，鉴权/方法分派/错误体全要自己写对（data-ide 已被 405 空 body 坑过一次，`SQL/docs/10-AGENT-CONSOLE-SPEC.md:414-430`）。
  - 建议：**v1 保留 spool 做兜底，HTTP 作为主路**；不要引入 storageDomain 共享（不可行），也不要等宿主提供跨进程总线（不存在）。

### 6.4 host → client 推送

- 公开可用的手段只有：自建 webServer 路由 + SSE/轮询（REF、data-ide 都用）；或 client 主动 `fetch`。
- in-box 客户端包广泛使用 `ctx.remote.<namespace>.*`（`ui-plan` 的 `ctx.remote.commands.execute`、`ui-reference` 的 `ctx.remote.fileReferences.list`、`session-controller` 的 `ctx.remote.$on(...)`、`RUNNER:6585-6686` 自身也用 `ctx.remote.dynamicCordisRunner.*`）。这些命名空间由 typert 从 in-box 包**生成**；`RUNNER:1719` 的类型 `ClientRemote & TypertRemoteScopeApi<'agent'>` 印证它是生成面。**外部插件注册自己的 remote namespace 没有公开文档/证据** → 不要押注（见 §10 待验证项 1）。

**Q4 结论**：持久状态用 `storageDomain`，会话派生状态用 `sessionProjections`，配置用 `settings`，UI→Host 用 `commands`/`webServer`；MCP 子进程与 host 只能文件或 HTTP，**没有共享内存/反向调用**。

---

## 7. Q5｜右栏（right Sidebar）0.2.1 事实

### 7.1 仍然存在且是推荐扩展面

- 类型注册：`ctx.sidebarRightTabs.register({ id, kind, patterns?, priority?, canOpen?, title, guide?, keepMounted?, multiple? })`（`HOST/dsh-client-ui-sidebar-right/README.md:83`；slot 目录对应 body 座位 `RUNNER:5113`）。**data-ide 已在用**：`SQL/src/client/contract/host.ts:65-82`、`SQL/src/client/index.ts:74-92`。
- body 座位：`sidebar.right.pane.tab`（keyed/session，**key = definition.id**），standardProps 含 `inputActions/useConversation/useProjection/sessionId/useResource/usePanelInfo/useTrajectory` 等（`RUNNER:5113-5161`）；可选动态标题：`sidebar.right.pane.tab.title`（keyed，`RUNNER:5163-5209`）；缺省标题在 open 时由 `title(address)` 固定（`sidebar-right/README.md:146`）。
- guide：`guide: [{id, order, title, description?, icon?}]`，渲染 `sidebar.right.tab.guide`(chain)/`.guide.entry`(keyed)（`RUNNER:5502-5580`；`sidebar-right/README.md:113-121`）。
- 其它：`sidebar.right.tab.menu.item`（list，追加 tab 菜单项，`RUNNER:5582`）；`sidebar.right.tab.document*`（文件预览渲染器，可替换）；`sidebar.right.tab.files.actions`。
- **patterns 匹配语义（回答 ref-notes §12-3）**：patterns 是 `dsh-resource://` 地址上的 glob；**带 `:` 的 pattern 匹配整串地址**（如 `dsh-resource://file/**`），**不带 `:` 的匹配 URI 路径任意深度、忽略大小写**（如 `*.md`）；地址不是 URI 则不匹配任何 patterns；页类型不带 patterns，按 kind 打开；`canOpen(address)` 可否决。排序：priority band（`extension` 最高且默认 > `builtin` > `fallback`）→ 最长匹配 pattern → 注册顺序（`sidebar-right/README.md:83,86`）。→ `.sql` 文件 claim 可行（P1-7），需注意 band 与 `canOpen`。
- **0.2.1 新增（相对 data-ide 文档里 0.1.7 结论）**：
  - 正常/全屏两种呈现（`README.md:39-48`）；
  - **双水平 pane**（可拆/拖，20%–80%，`README.md:121`）+ 浮动面板（`README.md:50,72`）；
  - `openTab/openResource` 的 options 有 `paneId / replaceTab / revealIfOpened / preferNewPane / params`（`README.md:93,95`）；
  - `keepMounted: true` 保留已访问 body（跨 tab/会话切换、折叠、docking，`README.md:106`）；
  - `multiple: true` 支持独立实例（`README.md:117`）。
  → **AGENTS.md「对话分屏 / per-pane 右栏 0.1.7 起就无」在 0.2.1 已过时**：现在 agent 结果可以开在第二 pane，不打断用户当前 tab（对 Q14「不抢焦点」是最优解）。

### 7.2 「点击聊天里的链接打开右栏 tab 并传参」

- 文件链接：**现成**（助手正文 → `openResource(fileAddress,{params:{line}})`，`sidebar-right/README.md:93`；`chat/README.md:38`）。
- 任意插件 tab + 参数：**可行**，但触发点必须是插件自己的 UI（工具卡按钮 / turnTail 卡按钮 / 侧栏入口），调用 `ctx.sidebarRight.openTab(kind, {params})`；`params` 在 `SidebarRightTabParamsMap` 里按 kind 声明，JSON 形状、运行时不校验（`sidebar-right/README.md:93`）。**deliverables 的 changes-review 是完整先例**（`deliverables/README.md:67`）。
- 聊天正文里写自定义 `dsh-resource://` 地址是否会被 chat 的 markdown 委托打开：**未验证**（chat 文档只承诺"文件链接/技能名"走 file opener，`chat/README.md:38,48`）。→ 不要依赖；用按钮。

**Q5 结论**：0.2.1 右栏能力**强于** data-ide 文档认知（双 pane/全屏/keepMounted/params 都在）；两段式注册不变；「聊天→右栏带参」用插件自绘卡按钮最稳。

---

## 8. Q6｜MCP 侧能力清单（逐项，含证据）

以下全部以 `HOST/dsh-mcp-client/lib/index.js` + README + `Config.listConfigs(include:mcp-sql)` 为准。

| 能力 | 事实 | 证据 |
|---|---|---|
| 工具命名 | `mcp__<serverName>__<rawName>`；serverName `[A-Za-z0-9_-]{1,32}`；public name 规范到 `[A-Za-z0-9_-]`、≤64 字符，发生字符替换/截断时末尾加 12 hex SHA-256；wire 永远发 rawName | `README.md:58,75`；`lib/index.js:64-102,767`；`Config` schema（serverName pattern） |
| serverName 冲突 | 同一 registration scope 内重复 → 后加载者失败；不同 Agent scope 可复用 | `README.md:75-79`；`lib/index.js:772-773,818` |
| 超时 | 每次 `tools/call`/资源请求 `toolCallTimeoutMs`，默认 **60000** | `README.md:61`；Config schema |
| 工具注解（readOnlyHint/destructiveHint/title） | **不读**：只取 name/description/inputSchema/outputSchema/execution.taskSupport | `lib/index.js:130-149` |
| 任务型工具 | `execution.taskSupport==="required"` → 调用时直接抛错（不支持 task 扩展） | `README.md:213`；`lib/index.js:139,229` |
| 错误 | MCP `isError` → 抛 Error(text) → 工具失败，模型看到 `Error: <message>`；SDK 结果/schema 校验失败也变错误 | `README.md:85`；`lib/index.js:231-236` |
| 结果 | canonical `{content, structuredContent?}`；模型/历史只拿渲染后的 text；图片（png/jpeg/webp/gif）是唯一持久富结果（需模型声明 image 输入）；audio/embedded resource → 诊断文本；`resource_link` → `Resource link: name (uri)` 文本 | `README.md:177,208-213`；`lib/index.js:200-220,369-414` |
| 进度通知 | **未接**：`callTool` 只传 `{signal,timeout,toolDefinition}`，无 `onprogress` | `lib/index.js:140-147` |
| elicitation / sampling / roots | **不可用**：Client 以 `capabilities: {}` 连接，无 handler | `lib/index.js:596-609` |
| 资源 | 支持 `resources/list`、`resources/templates/list`、`resources/read`（按需读），由 host `mcpResources` 提供 3 个模型工具（本会话可见 `list_mcp_resources/list_mcp_resource_templates/read_mcp_resource`）；**资源订阅不支持**；MCP prompt 模板不支持 | `lib/index.js:685-699`；`README.md:208`；inspect `mcpResources`；`Tool.listTools` |
| server instructions | 支持：非空则作为字面文本进系统提示（`### MCP server: <name>`），上限 `maxInstructionBytes=32768`，超限拒绝连接 | `README.md:62,187-191`；`lib/index.js:654-656` |
| 工具列表热更新 | `listChanged` 自动 re-sync；失败保留上一代；重名冲突整代回滚 | `README.md:89-93,129`；`lib/index.js:602-608,127-161` |
| 断线重连 | 指数退避 500ms→30s，maxAttempts 10；中断期旧工具保留但调用失败；超限后卸载工具 | `README.md:93`；`lib/index.js:433-471,557-584` |
| 环境变量 | stdio 子进程从 `scrubbedParentEnv()` 起（丢弃 `*KEY|PASSWORD|SECRET|TOKEN*` 与 `DSH_*`），配置 env 覆盖其上 | `README.md:137`；`lib/index.js:26-31` |

**Q6 结论**：**能用的**是工具名/描述/inputSchema/服务器 instructions/resources/isError/超时/reconnect；**不能用的**是 annotations、progress、elicitation、sampling、资源订阅、tasks。→ 想"降摩擦"，可动的是 schema 设计、描述、instructions、结构化文本结果、错误文本；不要指望靠 MCP 协议特性给 UI 送进度或表单。

---

## 9. Q7｜「一件操作同时给人按钮和给 agent 工具」的推荐架构 vs data-ide 现状

### 9.1 官方推荐（`SKILL/cordis-plugin-development/references/user-actions.md:5-11`）

1. 操作**只实现一次**，作为 **Host 服务方法**（返回结果或显式状态，失败带原因）；
2. UI 动作通过**client 可调用的 Host 入口**（文中示例：session command，`ctx.remote.commands.execute()`）调用它并展示失败；
3. agent 工具用**相同参数与语义**调同一个方法、返回同一结果；
4. 授权类动作（批准、回答问题、放宽策略）永远 user-only，不得让 agent 代做。
5. `practices.md:3`：注册是 effect、有 owner context；`practices.md:9-10`：用最弱的扩展点；`practices.md:7`：session log 是唯一真相，插件内存只是派生缓存。

### 9.2 data-ide 现状对照

| 推荐项 | data-ide 做法 | 差额 |
|---|---|---|
| 单次实现 | `src/execute/*` 共享引擎源码，**host 半与 MCP 子进程各自加载** | 源码单份、**运行期两份** |
| UI→Host 入口 | 自建 `webServer.register` HTTP 路由 + client `fetch`（`SQL/src/index.ts:47-74`、`host/web-routes.ts`、`client/http-api.ts`） | 不是命令/`ctx.remote`，鉴权/方法分派/错误体全自管 |
| agent 工具 | MCP 工具（同引擎） | 与 UI 走**不同进程** |
| 一致性 | label+归一化 SQL 去重；spool at-least-once | `docs/10 §15` 的 A1/A4/A10 都是双写/竞态类 |
| 权限 user-only | 面板写操作 + 连接 `writeEnabled`；MCP 侧默认只读 | 分散在两处判断（不是同一个 Host 方法） |

**结论**：data-ide 的路线**与推荐的"单一实现"精神一致，但物理上是双进程双副本**。这在当前扩展面下是**可行的**（因为 MCP 子进程不能调 host），不是错误；但代价是自建鉴权/路由/SSE/轮询/清理，并且一致性要靠 spool+幂等补。

**若要真正对齐官方推荐（可选升级）**：把权威操作收进 **host 半的 Cordis 服务**（或 `commands`）；UI 用 `commands.execute`（外部 client 插件是否可用 `ctx.remote` 待验证，§10-1）或保留 HTTP；**MCP 工具改为薄代理**：调 host HTTP（origin+token 写在 runtime 目录）。这样 agent 与 UI 命中同一个执行器、同一个连接池、同一份状态；spool/SSE 退化为"通知"而不是"唯一通道"。成本中-高，收益是消灭 A1/A4 与双连接池。

---

## 10. Q8｜明确「不可行 / 高成本」清单（含原因）

| # | 想做 | 判定 | 原因（证据） |
|---|---|---|---|
| 1 | Host `presentCall/presentResult` 在 Web 聊天渲染自定义卡 | **不可行** | Web 客户端不消费（`dsh-tools/README.md:95`）；只有固定 card 联合（inspect `tools` types）。替代：`tool.call.toolview` |
| 2 | 把 MCP `structuredContent` 直接给 UI 卡片 | **不可行** | Session 只记录 render 出的 ContentBlock（`dsh-tools/README.md:36`）；MCP render 只产 text（`lib/index.js:200-220`）。替代：文本 JSON 约定 + 卡片解析 |
| 3 | MCP 进度通知 / elicitation / sampling / 资源订阅 | **不可行** | `lib/index.js:596-609`（capabilities `{}`、无 handler）、`:140-147`（无 onprogress）、`README.md:208` |
| 4 | MCP 工具注解影响 DSH 审批/卡片 | **不可行** | 注解被丢弃（`lib/index.js:130-149`）；审批由 DSH `tools/pre-execute`+permission presets 决定 |
| 5 | 插件追加自定义 session 事件类型 | **不可行** | `practices.md:21`：未知类型只有 `ignorable:true` 才能读回，而 live `Session.append()` 设不了；`appendPluginRecord()` 只给 DSH 实验包 |
| 6 | 程序化插入结构化 `@` 引用 chip | **不可行** | `InputActions` 只 `insertText` 纯文本（`ui-conversation/README.md:165`）；结构化引用是内部 codec（`ui-conversation/README.md:79`）。可用纯文本 `@path` 替代（发送后渲染为引用） |
| 7 | 在助手正文里插任意可点击控件 | **不可行** | 没有助手文本的通用扩展点；只有 markdown 链接（宿主渲染）、工具卡、turnTail 卡、用户文本 `conversation.user.text.node` |
| 8 | 外部插件注册自己的 `ctx.remote` 命名空间 | **未验证 / 高风险** | `ctx.remote` 是 typert 生成面（`RUNNER:1719`），仅见 in-box 包使用（`ui-plan/ui-reference/session-controller` 等）；无外部插件文档。不建议作为方案依赖 |
| 9 | MCP server 调 host 服务 / host 调 MCP 工具 | **不可行** | stdio 子进程无 ctx（`mcp-client/README.md:28,59`）；host 侧 `mcpResources` 只有资源读，没有 callTool（inspect `mcpResources`） |
| 10 | workspace 级插件 KV | **不存在** | 只有 `storageDomain`（profile 级，自 key）与 `workspaceRegistry`（工作区注册表） |
| 11 | 新 Chat 行类型（自定义 kind） | **高成本/不建议** | kind 表被 ui-chat 固定（`RUNNER:2535`），且只能匹配已有事件（`practices.md:21`）；用 turnTail 卡替代 |
| 12 | 客户端 inspect provider 在本次会话可用 | **不可用（环境问题）** | 4 次 10s 超时；不影响扩展面结论（已用 slot 目录+README+在跑源码交叉验证）。建议在正常页面重试确认 |

---

## 11. 候选改造可行性（面向「工具更顺手 + agent↔UI 互操作」）

> 每条给：判定 / 落点 / 成本 / 风险。host/client 侧分开标注，便于排期。

| # | 改造 | 判定 | 落点（可引用 API/座位） | 成本 | 风险 |
|---|---|---|---|---|---|
| T1 | MCP **server instructions** 注入使用纪律（先 list_tables→get_schema；execute_sql 只读/默认行数；翻页用 fetch_page 不要重跑 SQL；label 语义/字符集） | **可行** | MCP server `instructions` 字段（`mcp-client/README.md:187-191`，≤32KB） | 低 | 低：每请求固定 token；超限会**拒绝连接**（`lib/index.js:654-656`），要测字节数 |
| T2 | 工具参数/描述补全（`connId` 说明、`label`/`consoleId` 语义与上限、`pageSize` 上限、错误时下一步） | **可行** | `SQL/mcp/server.ts` 各 `inputSchema`/description | 低 | 低：schema 变动才破 KV cache；`agent-experience` 建议"参数规则写参数上" |
| T3 | 结果 JSON 稳定化（`schemaVersion`、`resultId`/句柄、`rows` 截断标记、`durationMs`、错误码） | **可行** | `SQL/src/execute/*` 信封 + `mcp/server.ts` | 中 | 中：agent 契约变更要迁移说明；但为 T4/T5 提供稳定解析面 |
| T4 | **聊天内 SQL 结果卡**：`tool.call.toolview` 注册 `mcp__sql__execute_sql/execute_script/get_schema/list_tables`，渲染行数/耗时/列名/错误摘要；按钮开右栏 tab | **可行** | `RUNNER:5968-6010`（key=wire name，任意名可注册）；ownerProps `callId/toolName/phase/block/cwd/home/openFile/inspect/loadImage`；按钮用 client `ctx.sidebarRight.openTab(kind,{params})` | 中 | 中：三阶段（preparing/start/result）、大结果截断、PTC 子调用同 key（`ui-tool/README.md:46,135`）；不能依赖 host presenter |
| T5 | **回合尾部投递卡**：`conversation.chat.turnTail` 显示「本回合 agent 投递了 N 个 ai_<label> 结果」，点击开对应 console | **可行** | `RUNNER:2565-2620`（turnTail ownerProps turn/seq/openFile） | 低-中 | 低：只在完成回合出现；collapsed Work details 下位置随折叠 |
| T6 | **输入框上方状态 chip**（agent console 未读数/当前 label） | **可行** | `conversation.composer.dock`（list，`RUNNER:2704-2755`，standardProps 含 sessionId/useProjection） | 低 | 低：数据来自现有 `agent-stream` 状态 |
| T7 | **「发送到聊天框」**：面板选中 SQL/表名/结果 → `@` 引用 + 代码块/TSV 插到 composer | **可行** | `conversation.input.dock` 隐形桥取 `inputActions`（`RUNNER:3004-3058`）；`captureInsertion/insertText/persistDraft`（`ui-conversation/README.md:165`）；REF 先例 `REF/src/client/index.jsx:187-199`、`chat-bridge.js:48-143` | 低 | 低：只插纯文本；选区塌陷、补空格、失败 toast；`persistDraft` 尽力 |
| T8 | **双 pane 投递**：agent 结果开在第二 pane / 浮动面板，不抢用户 tab | **可行** | `openTab(kind,{preferNewPane:true})` 或 `{paneId}`（`sidebar-right/README.md:93,95,121`） | 低 | 低-中：需实测 pane 行为与 `mounted` 时序（REF 已踩过 openTab 在 store 未 adopt 时 no-op 的坑，`REF/src/client/index.jsx:240-292`） |
| T9 | `keepMounted: true` 让 SQL 面板切 tab/会话不丢挂载 | **可行** | `sidebarRightTabs.register({...,keepMounted:true})`（`sidebar-right/README.md:106`） | 低 | 低：需实测内存/执行状态语义（ref-notes P0-5 的验证项） |
| T10 | `.sql` 文件链接 claim（点聊天里的 .sql 打开工作台） | **可行** | `patterns`（带/不带 `:` 两种语义）+ `canOpen` + band（`sidebar-right/README.md:83,86`） | 中 | 中：与出厂 text preview 的优先级（extension band 最高）；错误 claim 会让文件打不开 |
| T11 | **MCP resources** 暴露连接/表结构/执行历史（模型按需 read，不占每次请求） | **可行** | MCP server 注册 resources（host 已挂 3 个资源工具，`lib/index.js:685-699`；`mcpResources` inspect） | 低-中 | 低：资源是"按需读"，不会自动进上下文；注意别把大结果做资源 |
| T12 | MCP 工具失败统一走 `isError`（而不是 `{ok:false}` 文本） | **可行** | MCP SDK server `isError:true` → bridge 抛错（`lib/index.js:236`） | 低 | 低：现有 `{ok:false}` 是成功调用，模型会误判——ref-notes P0-4 已指出，可直接改 |
| T13 | **单执行链**：MCP 工具代理 host（host 服务权威、MCP 薄壳） | **可行但成本高** | host `webServer` 路由 + origin/token 文件；MCP HTTP 客户端 | 高 | 中-高：鉴权、幂等、离线降级；收益是消灭双写/A1/A4，需单独里程碑 |
| T14 | MCP 注解/进度/elicitation/subscription | **不可行** | — | — | 别做 |
| T15 | 新 Chat 行类型承载「agent 结果」 | **不建议** | 用 T4/T5 替代 | — | kind 表固定 + 事件类型限制 |

---

## 12. 直接回答 `analysis/ref-notes.md §12` 遗留的宿主待验证项

| ref-notes 问题 | 回答 | 证据 |
|---|---|---|
| ① 0.2.1 是否有 `conversation.input.dock` 与 `inputActions`（captureInsertion/insertText/persistDraft） | **有**。`conversation.input.dock` 是 session 作用域 list 座位，standardProps 含 `inputActions: InputActions` 与 `sessionId`；`InputActions` 方法为 `captureInsertion/insertText`（`persistDraft` 在 REF 先例中出现，属输入模型能力） | `RUNNER:3004-3058`；`HOST/dsh-client-ui-conversation/README.md:165`；`REF/src/client/index.jsx:187-199` |
| ② `sidebarRight.openResource` 的 `params/kind/replaceTab/revealIfOpened` 在 0.2.1 是否可用 | **可用**，且还有 `paneId/preferNewPane`；body 经 `useTabInfo().navigation.params` 读取；页面参数类型合并进 `SidebarRightTabParamsMap`（运行时按 JSON 约定、不校验） | `HOST/dsh-client-ui-sidebar-right/README.md:84,93,95` |
| ③ `sidebarRightTabs.patterns` 匹配语义 | 带 `:` → 匹配整串 `dsh-resource://` 地址；不带 `:` → 匹配 URI 路径任意深度、忽略大小写；band 排序 extension > builtin > fallback → 最长 pattern → 注册顺序；`canOpen` 可否决 | `HOST/dsh-client-ui-sidebar-right/README.md:83,86` |
| ④ `resultId` 生命周期 | **宿主无内置 resultId/结果注册表**；这是插件自己的数据模型。可用 `storageDomain`（跨重启、profile 级）或 host 内存 LRU；MCP 侧要跨进程共享 → 仍走 runtime 文件/HTTP。提示：`storageDomain` 单进程可见、无迁移（`storage-domain/README.md:73,146`） | inspect `storageDomain`；`HOST/dsh-storage-domain/README.md` |
| ⑤ `@` 引用是否需要 agent 侧解析 | 宿主没有"引用解析器"可复用给 MCP 工具；若 MCP 工具要接受 `@result/...`，解析与过期错误得插件自己实现（`@path` 语法本身见 `HOST/dsh-client-ui-reference/README.md:30-34`） | `ui-reference/README.md:30-34,58-62` |
| ⑥ 与「工具面审计」对账 | 本文 §11 T1/T2/T3/T12 是可执行的工具契约改进项，可与另一路审计合并成「工具契约 v2」表 | — |
| ⑦ 参考侧 vs data-ide 取舍 | 维持"引擎共用"，补"对象共用"（resultId/console 地址/UI 座位）；本文 T3/T4/T5/T7 是宿主侧可落地的"对象共用"入口 | 本文 §3-§5 |

其它 ref-notes 关心点：
- **keepMounted**：注册项存在（`sidebar-right/README.md:106`），data-ide 目前未声明（`SQL/src/client/index.ts:74-92`）→ 可加，需实测切 tab/会话/折叠/双 pane 下的挂载保留。
- **双 pane**：`multiple`/`paneId`/`preferNewPane` 都在；data-ide 现有 `contract/host.ts:84-94` 只声明了 `preferNewPane/paneId`，是旧面，需扩 `params/replaceTab/revealIfOpened/keepMounted/multiple`。
- **`conversation.chat.node` 的替换风险**：`replaceRisk: "shadows-shipped-ui"`（`RUNNER:2560`），用 keyed 座位替换出厂行要谨慎；turnTail/toolview 的 replaceRisk 也是 shadows-shipped-ui（`RUNNER:6069` 附近），但我们的 key 是自有 MCP 工具名，不冲突。

---

## 13. 未验证项与建议探针（不阻塞方案，但要在实现前拍板）

1. **外部动态 client 插件能否用 `ctx.remote.*`**（尤其 `ctx.remote.commands.execute`）→ 决定 T13/UI→Host 入口是否可用"官方推荐"路径。建议在 dev profile 写一次性探针插件（不装 desktop）调一次 `ctx.remote.commands.execute`。
2. **PTC 模式下 `tool.call.toolview` 的行为**：PTC 的每次子调用也会 dispatch 到同一 keyed slot（`ui-tool/README.md:46,135`），卡片需容错"无 root tool row"的情况；建议用 `presentAs`/PTC 实测一次。
3. **`openTab(kind,{params})` 的运行时行为**（0.2.1 rebuilt 客户端）与 store 未 adopt 时 no-op 的时序（REF 已有 workaround，`REF/src/client/index.jsx:240-292`）。建议在 dev profile 实测。
4. **助手正文里的任意 `dsh-resource://` markdown 链接**是否走右栏 opener（文档只承诺文件/技能）。
5. **client inspect provider 超时**原因（重启页面后重试一次；若稳定可用，可替代 `RUNNER` 目录做二次核对）。

---

## 14. 证据索引（按被引次数）

**Host inspect（本会话实查）**：`Service.listService`（98 服务）、`Service.listService({"service":"tools"|"storage"|"storageDomain"|"settings"|"commands"|"sessionProjections"|"mcpResources"}`）、`Event.listEvents`（68 事件）、`Tool.listTools`（含 9 个 `mcp__sql__*` 真实 schema）、`Config.listConfigs`（216 条；`include:mcp-sql` schema）。

**asar 包文档/源码**（`HOST/` 前缀）：`dsh-tools/README.md:36,64,89,95,109,118,126,141,235`；`dsh-mcp-client/README.md:28,58-62,75-93,137,177,187-191,208-213` + `lib/index.js:26-31,64-102,127-171,182-220,226-255,312-353,369-414,433-471,596-609,654-656,685-699,763-800`；`dsh-client-ui-sidebar-right/README.md:12,39-50,61-62,74,83-88,93,95,106,113-121,146`；`dsh-client-ui-conversation/README.md:31,79,165`；`dsh-client-ui-chat/README.md:38,48,71`；`dsh-client-ui-tool/README.md:12,36-46,82,95-99,135`；`dsh-client-ui-deliverables/README.md:37-39,67,96`；`dsh-client-ui-reference/README.md:30-34,58-62`；`dsh-storage-domain/README.md:12,73,146`。

**官方 skill**（`SKILL/` 前缀）：`cordis-plugin-development/references/practices.md:3,7,9-10,19,21,37,38`；`.../references/user-actions.md:5-11`；`agent-experience/SKILL.md:6-19`。

**客户端 slot/服务目录**：`RUNNER`（生成数据，`source` 指向 DSH 源码 `packages/client/**/contract/slots.ts`）：服务目录 `:1125-1650`；`conversation.chat.node:2498`；`conversation.chat.turnTail:2565`；`conversation.composer:2623`；`conversation.composer.bar:2671`；`conversation.composer.dock:2704`；`conversation.input.dock:3004`；`conversation.input.activity:2932`；`conversation.session.header.utilities:3625`；`main:3884`；`rightbar:4238`；`shell.overlay:4816`；`sidebar.footer.action:5021`；`sidebar.right.pane.tab:5113`；`sidebar.right.pane.tab.title:5163`；`sidebar.right.tab.guide:5502`；`sidebar.right.tab.guide.entry:5542`；`sidebar.right.tab.menu.item:5582`；`tool.call.toolview:5968`。

**在跑插件**（同环境先例）：`REF/src/client/index.jsx:187-199,240-292,317-389`；`REF/src/client/chat-bridge.js:26-143`；`REF/src/client/api.js:1-78`；`SQL/src/index.ts:21-83`；`SQL/src/host/agent-relay.ts:6-17,90-133`；`SQL/src/host/contract.ts:38-68`；`SQL/src/client/index.ts:14,63-141`；`SQL/src/client/contract/host.ts:56-106`；`SQL/mcp/server.ts:205-497`；`SQL/docs/10-AGENT-CONSOLE-SPEC.md:211-306,309-435`。

---

*本文只读核查产物：未修改 `dsh-data-ide` / `ref-ide-workbench` / profile / 任何 DSH 安装文件；未安装、未启停插件。*
