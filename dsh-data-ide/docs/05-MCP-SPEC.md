# 05-MCP-SPEC — MCP 服务规范

> 状态：草案（待 G2 契约冻结）｜上游：01-PRD（范围）、02（执行位置/数据流）、04（connId/凭据语义）
> 契约性质：工具 schema 定稿后即接口——宿主/UI/server 三方并行编码的起点；后续变更走 RFC。

---

## 1. 定位与形态

- dsh 是 **MCP client**（`packages/mcp/mcp-client`，`@modelcontextprotocol/sdk ^1.12.0`）；本项目提供 **一个 MCP server**（stdio，Node），实例经 `cordis.patch.yml` 一行声明（格式见 06 §7）；
- serverName = `sql`（须匹配 `[A-Za-z0-9_-]{1,32}` 且全局唯一）；agent 侧工具名形如 `mcp__sql__execute_sql`；
- **一份引擎、两条调用路**：执行/分页/权限/截断全部在 `src/execute/`（`core.ts` 纯逻辑 + `mysql.ts` 驱动适配 + `envelope.ts` 信封）。agent 走 MCP 工具（`mcp/server.ts`），面板走宿主服务（`src/host/binding.ts` 的 `execute/fetchPage/cancel`，密码在宿主进程内解析、不落 spec 文件）。两条路共享同一个 `ExecuteResponse`，界面与 agent 的口径不可能分叉；
- server 无状态：不读凭据库、不写配置。**2026-10-17 定的密钥通道（偏离 04 §9「每次调用经 stdio 传入」）**：dsh 的 mcp-client 不支持改写调用参数，而 `test_connection` 只收 `connId`，因此宿主把解析好的连接规格物化成 `<dshHome>/data-ide-runtime/conn-specs.json`（0600、原子写、连接变更即重写、插件卸载即删），并在 spawn argv 里用 `--dsh-data-ide-specs <path>` 告知 server。被否决的替代方案是让 server 直读凭据库——那会让常驻子进程长期持有全部密钥的读权限。实现见 `src/host/runtime-specs.ts` 与 `mcp/runtime-specs.ts`。

## 2. 安装与自动激活链路

```
dsh plugin add <ui-sql-workbench pkg>
  → reconcilePlugins()（apps/cli/src/plugin.ts）把 bundle patch 加入 profile bundles
  → 下次 dsh 启动：mcp-client 实例化 → spawn "node <plugin>/lib/mcp/server.js"
  → MCP initialize → tools/list → ctx.tools.register（每个工具一个 effect）
  → agent loop 每轮 assemble 收集 → 模型自动可见 mcp__sql__*
```

无需任何手工编目；工具增减经 `tools/change` 事件通知。cordis.yml 片段见 06 §7。

## 3. 工具清单（12 个）

命名规则：`snake_case`；破坏性变更策略：新增工具自由，修改入参/语义 = minor 版本 + 迁移说明，移除 = major。

### 3.1 连接管理

**`list_datasources`** — 列出数据源（不含密码）✅ 已实现
- 入参：无
- 输出：`{ datasources: [{ id, name, dbms, host, port, database, writeEnabled }] }`
- 副作用：无｜超时：5s｜实现：`mcp/tools-datasources.ts`

**`test_connection`** — 测试连接（三态）✅ 已实现（mysql2 探测）
- 入参：`{ connId: string }`
- 输出：`{ state: "YES"|"NO"|"UNSURE", info?: { product, version, driverVersion, dbms }, error?: { code, message, hint? } }`
- 副作用：写 database-info 缓存｜超时：15s
- 错误码：`AUTH_FAILED` / `NETWORK_UNREACHABLE` / `TIMEOUT` / `DRIVER_MISSING` / `UNKNOWN`

### 3.2 SQL 执行

**`execute_sql`** — 执行 SQL 并返回首页+总数（只读默认）
- 入参：`{ connId: string, sql: string, pageSize?: number(默认500,≤5000), statementId?: string }`
- 输出：`{ columns: [{name, typeName}], rows: object[](≤pageSize+1), total: number|null, hasNextPage: boolean, durationMs, statementId, truncated?: {cells: number} }`
- 副作用：执行查询；写查询历史｜超时：120s（`toolCallTimeoutMs`）
- 权限：默认仅 SELECT；非 SELECT 且连接未开 `writeEnabled` → 拒绝（`WRITE_NOT_ALLOWED`）
- 行为：首页 `LIMIT pageSize+1` + 独立 COUNT（02 §6.2）；多语句仅执行第一条（与 PRD R2 一致）
- `columns.typeName` 是驱动报的线协议类型名（`LONG` / `VAR_STRING` / `DATETIME` …），网格按它决定格式化与对齐（03 §6.5）
- `statementId` 回显给调用方，`cancel_statement` 用它定位**正在执行**的语句；人侧面板自己铸 id（`ui-<n>`），因此尚未拿到响应也能取消

**`fetch_page`** — 翻页/跳页
- 入参：`{ connId: string, sql: string, offset: number≥0, pageSize?: number, statementId?: string }`
- 输出：`{ columns, rows, hasNextPage, statementId, total: null }`（不重新计数，`total` 由首页的 COUNT 缓存提供）
- 副作用：写查询历史｜超时：120s

**`cancel_statement`** — 取消进行中的语句
- 入参：`{ statementId: string }`
- 输出：`{ cancelled: boolean }`｜超时：5s

### 3.3 脚本文件

**`list_scripts`** — 列出脚本目录 `.sql` 文件（`{ path, size, modifiedAt }[]`）
**`read_script`** — 读脚本（`{ path, content }`；>1MB 拒绝 `FILE_TOO_LARGE`）
**`write_script`** — 写脚本（`{ path, content }`；路径必须位于脚本目录内，防目录穿越 `PATH_ESCAPE`）

### 3.4 git（作用于隔离脚本目录）

**`git_status`** — `{ branch, ahead, behind, changes: [{path, status}] }`
**`git_diff`** — `{ path?, staged?: boolean }` → `{ diff: string }`（>256KB 截断）
**`git_commit`** — `{ message: string, paths?: string[] }` → `{ commitId }`
**`git_pull`** — `{ }` → `{ ok, output }`（remote 凭据由宿主经 stdio 传入，server 转临时 credential helper，不落盘）
**`git_push`** — `{ }` → `{ ok, output }`


## 3.2 面板通道（同源 HTTP，非 MCP）

> agent 走 MCP stdio；**人**走这些路由。两条路共用 `src/execute/` 与 `src/host/panel-service.ts`，所以分页、拒绝码、截断口径一致（02 §5）。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/dsh-data-ide/connections` | 连接列表 + 当前选中 |
| POST | `/dsh-data-ide/save` | 新建/更新连接（含密码入凭据） |
| POST | `/dsh-data-ide/remove` | 删除连接 |
| POST | `/dsh-data-ide/activate` | 切换当前连接 |
| POST | `/dsh-data-ide/test` | 三态连通性测试 |
| POST | `/dsh-data-ide/execute` | 执行首页 |
| POST | `/dsh-data-ide/execute-script` | 多语句：每条语句一个结果（遇错停），返回 `{statements:[{ok,response|error}]}` |
| POST | `/dsh-data-ide/fetch-page` | 翻页 |
| GET | `/dsh-data-ide/schema?connId=&refresh=1` | 补全用表结构（`information_schema.COLUMNS`，按连接缓存 5 分钟） |
| POST | `/dsh-data-ide/cancel` | 取消语句 |
| POST | `/dsh-data-ide/client-error` | 浏览器半注册失败的自诊断上报 |

路由挂在 composition 的 `webServer` 上（`src/host/web-routes.ts`），并接 `connection.requestRejection` 作为信任围栏。

## 4. schema 约束

- 全部入参/输出必须落在 mcp-client 强制的 JSON Schema 子集（`packages/core/tools/src/json-schema.ts`）——**禁 oneOf/patternProperties 等不支持构造**；注册期校验失败即抛错；
- 统一错误信封：`{ ok: false, error: { code, message, hint? } }`；code 枚举见各工具。

## 5. 超时与取消

| 项 | 值 | 说明 |
|---|---|---|
| 工具调用超时 | `toolCallTimeoutMs: 120000` | 覆盖 SDK/宿主默认 60s（mcp-client `DEFAULT_TOOL_CALL_TIMEOUT_MS=60_000`） |
| 连接建立 | 15s | 含 Java 桥冷启动预算（~7s 实测 + 余量） |
| 语句取消 | `cancel_statement` / 宿主 abort | server 转发 abort signal 到 mysql2/桥 |

## 6. 安全边界

| 面 | 事实 | 缓解 |
|---|---|---|
| 进程沙箱 | stdio 子进程**不受 dsh sandbox 约束**，以宿主用户全权限运行 | 既定事实；工具集最小化 + 权限默认只读 |
| agent 执行权限 | agent 可调全部工具 | **默认仅 SELECT**；写操作需连接级 `writeEnabled`（宿主侧配置，UI 可见）；DDL 黑名单（DROP/TRUNCATE/ALTER/GRANT）默认拒绝、可配置 |
| 凭据传递 | env 被 `scrubbedParentEnv()` 清洗（丢凭据形状名与 DSH_*） | 密码**不经 env**：宿主每次调用经 stdio 参数传入；server 不记日志 |
| git 凭据 | remote 需 token | token 经 stdio 传入 → 临时 `GIT_ASKPASS`/credential helper（内存态，进程退出即消失）；不写 `~/.git-credentials` |
| 路径穿越 | write_script/read_script 路径 | 规范化后必须位于脚本目录内，否则 `PATH_ESCAPE` |
| 审计 | — | 所有写操作（execute 非 SELECT、git commit/push、write_script）记审计日志（宿主 storage） |

## 7. 重连与降级

- mcp-client 重连预算：连续 10 次失败 → **永久注销工具**，只能重启 profile 恢复（connection.ts）。缓解：server 加监督器（崩溃自动重启 + 健康检查）；文档告知运维动作；
- Java 桥崩溃：server 标记桥不可用，Oracle 连接返回 `DRIVER_MISSING`+hint，下次连接重启桥（R4）；
- COUNT 失败降级：COUNT 查询失败时 `total=null`，网格显示"总数未知"，不影响首页数据。

## 8. 命名与演进

- serverName `sql` 全局唯一（重复即 load 失败）；
- 工具集演进：新增=patch；入参变更=minor+迁移；移除=major；
- 版本号随插件包 semver；peerDeps 与 dsh 运行时兼容见 06 §3。
