# 02-ARCHITECTURE — 总体架构设计

> 状态：草案（待 G1 架构冻结）｜上游：01-PRD（范围）、06（工程约束）｜下游：03/04/05 引用本文契约
> 所有架构结论可溯源至 dsh 仓库核验（分支 codex/presentation-v2）与 DataGrip 逆向文档（见 00 §5）。

---

## 1. 架构总览

```
┌─────────────────────────────────────────────────────────────────────┐
│ 浏览器（dsh web client）                                              │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ 插件浏览器半 dsh-data-ide（client 半）                        │  │
│  │  sidebarRightTabs.register + sidebar.right.pane.tab{,.title}   │  │
│  │  ┌─────────┬──────────┬───────────┬──────────┬─────────────┐  │  │
│  │  │连接条   │SQL 编辑器│结果网格   │git 面板  │查询历史     │  │  │
│  │  └─────────┴──────────┴───────────┴──────────┴─────────────┘  │  │
│  └──────────────────────────┬────────────────────────────────────┘  │
│              cordis service 面（宿主能力代理，禁跨包 value import）      │
└──────────────────────────────┼──────────────────────────────────────┘
                               │ stdio（JSON-lines，宿主解析凭据后传入）
┌──────────────────────────────┼──────────────────────────────────────┐
│ 宿主 Node 进程（dsh host）   ▼                                       │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ 插件 node 半：连接编排/凭据解析/存储单写者（storage-json）        │  │
│  │ ctx.credentials（key=dsh-data-ide/<connId>，modifyRecord 排他写）│  │
│  └──────────────────────────┬────────────────────────────────────┘  │
│  mcp-client（一个 server 一个实例，serverName=sql）                    │
└──────────────────────────────┼──────────────────────────────────────┘
                               │ MCP stdio
┌──────────────────────────────┼──────────────────────────────────────┐
│ MCP server 子进程（node，lib/mcp/server.js）                          │
│  ┌──────────────┬────────────────────────┬───────────────────────┐  │
│  │ 协议层(12 工具)│ mysql2 连接池          │ Java 桥管理（懒启动）  │  │
│  │ (分页 SQL 生成)│ Doris/MySQL 直连       │ （Oracle 已移出范围）│  │
│  └──────────────┴────────────────────────┴───────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

> Oracle / Java 桥（图中已省略）于 2026-10-17 移出范围，降级 P1（01 §5 N7）。

四进程边界与 DataGrip 对照：DataGrip = IDE 进程 + 独立 java 后端（RemoteJdbcServer + RMI，RUNTIME-FINDINGS §3）；本架构 = 浏览器 UI + 宿主 node + MCP server。**宿主 node 兼任"IDE 进程"角色**（配置/凭据/编排），MCP server 兼任"JDBC 后端"角色（执行/分页），天然获得崩溃隔离（评估 §7 决策 6 的达成方式）。

## 2. 插件包结构（双入口）

见 `06-PLUGIN-ENGINEERING.md` §2。要点：

- **node 半**（`src/index.ts`）：空 apply；宿主侧服务（连接编排、凭据解析、存储单写者）以 cordis service 形式提供，经 `dsh.client.inject` 声明边；
- **浏览器半**（`src/client/index.ts`）：`ctx.sidebarRightTabs.register({id:'dsh-data-ide.sql-workbench', kind, title, guide})` + `slots.inject('sidebar.right.pane.tab' / '…tab.title')`（两者 `key` = 定义 `id`）；UI 只经注入 props（`sessionId` / `actions`）与宿主服务面协作；
- **MCP server**（`mcp/server.ts`，同包 `./mcp` 导出）：无状态执行器——连接规格（host/port/db/user）由宿主每次调用经 stdio 传入，**不读凭据库**（对照 DataGrip 后端同样只收 driver+url+props，SPEC §3.4）。

## 2.1 浏览器半的现代码结构（2026-10-20）

| 模块 | 职责 | 备注 |
|---|---|---|
| `client/index.ts` + `guard.ts` | 右栏 tab 注册与能力守卫 | fail-closed，缺能力时打印可读原因 |
| `client/components/SqlWorkbenchPanel.tsx` | 面板装配：三块布局、console tabs、执行/取消/翻页、DDL 落点 | 只做编排，不含编辑器内部逻辑 |
| `client/editor-cm.ts` | **CodeMirror 6 装配**：扩展、主题、键位、schema→namespace | 编辑器内核的唯一入口；主题走 `EditorView.theme` + `--dsw-*` token，不产 CSS 文件 |
| `client/components/SqlEditor.tsx` | 挂载 `EditorView`，保留 `SqlEditorHandle(insert/getSelection)` 契约 | schema/只读经 Compartment 热切换，避免重建视图丢撤销栈 |
| `client/components/SchemaTree.tsx` + `schema-tree.ts` | 对象树：分组、展开、右键菜单、DDL 目标 | 菜单关闭要忽略自身 pointerdown（否则 click 到不了按钮） |
| `client/components/ResultGrid.tsx` + `grid.ts` / `stats.ts` | 结果网格：格式化、排序、列宽、选区、导出、聚合、列筛选编辑器 | 筛选为服务端；`filterIndexes`（本地页过滤）已不再使用 |
| `client/state/documents.ts` / `query.ts` | console 标签与查询状态机（纯函数） | `QueryState` 含 `sort` / `pageSize` / `filters` |
| `client/db-error.ts` | 驱动错误 → 人话 | 剥 `errCode/detailMessage` 外壳，按模式翻译；两条到达形态都要翻 |
| `client/clipboard.ts` | 剪贴板三级策略 | `writeText` → `execCommand` → 统一失败提示 |

## 3. 逻辑归属表（每类逻辑唯一归属）

| 逻辑 | 归属 | 理由 |
|---|---|---|
| UI 状态/渲染/交互 | 浏览器半 | slot 组件；禁跨包 value import |
| 连接配置 CRUD、序列化 | 宿主 node 半 | **单写者原则**：storage-json 文档只由宿主写 |
| 凭据解析（密码取出） | 宿主 node 半 | `ctx.credentials` 排他写只在宿主可用；MCP 子进程不读凭据库，只读宿主物化的运行时 spec 文件（05 §1） |
| 连接测试编排（三态） | 宿主 → MCP server 执行 | 编排在宿主，探测在 server |
| SQL 执行/取消/分页 SQL 生成 | MCP server | 分页策略（LIMIT n+1+COUNT+OFFSET）集中于 server |
| 结果传输/行截断 | MCP server | 大值保护在 server 侧执行（maxLobLength） |
| Oracle JDBC | Java 桥 | URLClassLoader 隔离 ojdbc（镜像 SPEC §3.3 JdbcClassLoader） |
| git 操作 | MCP server（git CLI 封装） | 与人/agent 共用同一实现；目录隔离 |
| 查询历史 | 宿主（storage-json） | UI 与 agent 共享可见 |

## 4. 混合 SQL 后端设计

### 4.1 路由

| DBMS | 通道 | 库/驱动 |
|---|---|---|
| Doris / MySQL | MCP server 内 mysql2 直连 | mysql2（MIT；Doris FE 兼容 MySQL 协议，9030，实证 RUNTIME-FINDINGS §2.2/§3b） |
| ~~Oracle~~ | ~~Java 桥子进程~~ | **2026-10-17 移出范围（P1）**：不实现桥、不引入 ojdbc11 |
| （P1 候选）PostgreSQL/Hive | mysql2 之外扩展 | pg 原生 / Hive 走桥 |

### 4.2 Java 桥生命周期

- **懒启动**：首次 Oracle 连接时启动；JVM 冷启动实测 ~7s（RUNTIME-FINDINGS §3b），**禁止随用随起**；
- **保活**：空闲 10min 回收；连接前确保就绪（启动中超时 30s → NO 态+原因）；
- **崩溃恢复**：桥进程退出 → 标记不可用 → 下次连接重启；监督器记入 R7 同类重连预算；
- **隔离**：桥内 `URLClassLoader(parent=PlatformClassLoader, urls=[ojdbc])` 加载驱动（镜像 DataGrip 实证的 base loader，RUNTIME-FINDINGS §3b）；
- **协议**：stdio JSON-lines（request: {id, op:'connect'|'query'|'cancel', ...}；response: {id, ok, rows?, columns?, error?}）；请求带 timeout 与取消句柄。

### 4.3 连接与凭据数据流（单写者）

```
人保存连接 → 宿主写 storage-json（无密码） + ctx.credentials（密码）
人/agent 执行 → 宿主读配置 + 取密码 → stdio 传给 MCP server {conn: {host,port,db,user,password}}
             → server 建/取连接（mysql2 pool / 桥 connect）→ 执行 → 结果回传
```

对照：DataGrip 的密码仅在后端连接时经 RMI 解析（SPEC §2.3），本架构同构。

## 5. 端到端数据流

**两条调用路，一份引擎（2026-10-18 定稿）**：

| 调用方 | 通道 | 入口 |
|---|---|---|
| 人（右栏面板） | **同源 HTTP**（`src/host/web-routes.ts` 的 exact 路由，挂在 composition 的 `webServer` 上；浏览器 `fetch` 调用，见 `src/client/http-api.ts`） | `/dsh-data-ide/{connections,save,remove,activate,test,execute,execute-script,fetch-page,cancel,schema,client-error}` |
| agent | **MCP stdio**（`mcp/server.ts`，serverName `sql`） | `mcp__sql__*` |

两者都走 `src/execute/`（分页/权限/截断）与 `src/host/panel-service.ts`（连接与测试），所以界面与 agent 的结果口径、拒绝码、截断行为一致。
> **不要让浏览器半去拿 node 服务**：web 前端是另一个进程，`ctx['sqlWorkbench']` 取不到（某些 context 对未知属性直接抛，会把整条 client entry 打挂、web boot 失败）。dsh-chat 的先例也是「node 半挂同源路由 + client 半 fetch」。

1. **保存并测试连接**：表单 → `POST /save`（校验 + 密码入 `ctx.credentials` + 刷新 spec 文件）→ `POST /test`（server `SELECT 1` 探活 + 版本探测）→ 三态 + database-info 缓存；
2. **执行 SQL（首页）**：编辑器 → `POST /execute` → `SELECT ... LIMIT pageSize+1`（包裹用户 SQL，`WrapInSelect` 模式，SPEC-sql §4.2）+ 独立 `SELECT COUNT(*)` → 首页行 + 总数 → 网格；
3. **翻页/跳页**：`POST /fetch-page` → `LIMIT pageSize+1 OFFSET m`（实证形态 RUNTIME-FINDINGS §4）；
4. **排序**：列头点击 → 服务端 `ORDER BY` 重新执行（决策：服务端排序）；
5. **git**：脚本保存 → `git_status/diff/commit/pull/push` 工具 → 目录 `<dshHome>/data-ide-scripts/`；
6. **Oracle**：同 1-3，经桥通道（已降级 P1）。

## 6. 序列图（6 张）

### 6.1 保存并测试连接

```
人→UI: 填表单点[测试]
UI→宿主: testConnection(draft)
宿主→Server: mcp test_connection {spec, password}
Server→DB: SELECT 1 / 版本探测
Server→宿主: {state: YES|NO|UNSURE, info?, error?}
宿主→存储: 写 database-info 缓存（storage-json）
宿主→UI: 三态渲染
```

### 6.2 执行 SQL 取首页

```
UI→宿主: executeSql(connId, sql, pageSize=500)
宿主→Server: mcp execute_sql {spec,password,sql,pageSize}
Server→DB: SELECT * FROM (<sql>) t LIMIT 501   （并行）
Server→DB: SELECT COUNT(*) FROM (<sql>) t
Server→宿主: {columns, rows[≤501], total}
宿主→UI: 网格渲染（多出 1 行 → "还有下一页"）
```

### 6.3 翻页 / 跳页

```
UI→宿主: fetchPage(connId, sql, offset=51786, pageSize=500)
宿主→Server: mcp fetch_page {...}
Server→DB: SELECT * FROM (<sql>) t LIMIT 501 OFFSET 51786
Server→宿主: {rows}
宿主→UI: 页范围更新（COUNT 走缓存，失效条件：schema 变更/手动刷新）
```

### 6.4 git 三连（pull → commit → push）

```
UI→宿主: gitPull() / gitCommit(msg) / gitPush()
宿主→Server: mcp git_pull / git_commit{message,paths} / git_push
Server→git: CLI（隔离目录）  [token 由宿主经 stdio 传入 → 临时 env GIT_ASKPASS 或 credential helper]
Server→宿主: {ok, output?}
宿主→UI: 状态条 + diff 预览
```

### 6.5 Oracle 经桥执行（含冷启动）

```
UI→宿主: executeSql(oracleConn, sql)
宿主→Server: mcp execute_sql {..., channel:'bridge'}
Server→桥: connect{url,user,password}      （桥未启动 → spawn java -jar，≤30s）
桥→Server: ok
Server→桥: query{sql, maxRows=501}
桥→Oracle: JDBC execute → Object[] 行
Server→宿主: {columns, rows}
```

### 6.6 连接测试失败路径

```
Server→DB: SELECT 1 → 抛错（认证失败/网络不可达）
Server→宿主: {state:NO, error:{code, message, hint}}
宿主→UI: NO 态 + ErrorInfo 渲染（可操作提示：检查密码/网络/白名单）
```

## 7. 与 DataGrip 架构映射表

| DataGrip | 本项目 | 说明 |
|---|---|---|
| `datagrip64.exe`（Rust+JVM） | dsh 宿主 node | 不复刻启动器 |
| IDE 主进程（Platform） | 浏览器 UI + 宿主 node 半 | UI 归 client，编排归 host |
| `RemoteJdbcServer` 后端进程 | MCP server 子进程 | 同为独立进程；RMI→MCP stdio |
| `RemoteDriver/Connection/ResultSet` 代理族 | MCP 工具边界（execute_sql/fetch_page） | 工具即接口 |
| `JdbcClassLoader`（URLClassLoader 隔离） | Java 桥 classloader（仅 Oracle 需要） | SPEC §3.3 |
| `MultiPageModel`/`GridLoaderBase` | 前端页模型（宿主→UI 数据流） | LIMIT n+1 策略在 server |
| ThreeState + ErrorInfo | 连接测试三态 + 错误渲染 | SPEC §4 |
| `dataSources.xml`/`.local.xml` 双文件 | storage-json 全量 + credentials 分离 | SPEC §2.1 设计含义 |
| `jdbc-drivers/` Maven 仓库 + Aether | 内置驱动（mysql2/Oracle 桥），无下载生态 | 轻量化降级（评估 §4 #5） |
| 内省模型缓存 `<UUID>.xml` | 不做（N2） | — |

## 8. 关键权衡记录

| 权衡 | 决策 | 依据 |
|---|---|---|
| 进程内 vs 进程外执行 | MCP server 独立进程（白得崩溃隔离）；Java 桥仅 Oracle | 评估 §7 决策 6；MCP 形态天然外置 |
| 配置单写者 | 宿主独占写；MCP server 无状态 | 避免双写；DataGrip 同构（后端只收连接参数） |
| 排序服务端 vs 本地 | 服务端 ORDER BY | 数据量大时本地排序失真；实现简单 |
| 页大小 500 默认 | 500 可调（上限 5000） | DataGrip 实证默认 500（RUNTIME-FINDINGS §4） |
| COUNT 缓存 | 缓存至 schema 变更/手动刷新 | COUNT 在大表代价高；DataGrip 独立 COUNT 同构 |
| MCP 与 UI 同包 | 同包 `./mcp` 导出 | 一次安装装全；版本一致 |
