# 04-DATA-MODEL — 数据模型与存储设计

> 状态：草案（待 G2 契约冻结）｜上游：02（边界/单写者）、05（跨进程传递内容）、06（可用服务清单）
> 原则（继承 DataGrip 实证设计）：**配置与机密分离**；密码永不入配置文档；宿主单写者。

---

## 1. 存储总览

| 数据 | 住哪 | 写者 | 说明 |
|---|---|---|---|
| 数据源定义（无密码） | dsh storage-json 文档（宿主） | 宿主 node 半（唯一） | key 如 `dsh-data-ide/datasources`；schemaVersion 版本化 |
| 密码/凭据 | `ctx.credentials` record | 宿主 | key=`dsh-data-ide/<connId>`；opaque JSON payload；`modifyRecord` 排他写 |
| database-info（测试/版本缓存） | 同 storage-json（数据源文档内嵌） | 宿主 | 连接测试成功后写 |
| 查询历史 | 同 storage-json（独立文档） | 宿主 | 上限 200/连接，环形清理 |
| UI 布局（列宽/面板折叠/页大小） | 同 storage-json（布局文档） | 宿主（经 UI 事件） | 连接级 + 全局默认 |
| SQL 脚本 | 文件系统 `<dshHome>/data-ide-scripts/` | 人/agent/git | git 仓库，物理隔离 |
| git remote 凭据 | `ctx.credentials`（key=`dsh-data-ide/git-remote`） | 宿主 | 每次 pull/push 经 stdio 传给 server |
| 结果数据 | 内存（当前页 ±2 页） | 不落盘 | 显式不做持久化（轻量化） |

## 2. 数据源模型（对齐 DataGrip `LocalDataSource` 子集）

字段依据：SPEC §2.4 的 `LocalDataSource` 常量池实证（myUrl/myUsername/myDriverClass/myDriverProperties/mySshConfiguration/mySslCfg/connectionMode/introspectionLevel/schemaMapping…），取轻量子集：

```typescript
interface DataSource {
  schemaVersion: 1
  id: string                 // connId，UUID（规范化为 credentials key 安全段）
  name: string               // 显示名（如 doris.shcell.com）
  dbms: 'doris' | 'mysql' | 'oracle'   // P1: postgres/hive
  host: string
  port: number               // doris 默认 9030；mysql 3306；oracle 1521
  database?: string          // 默认 schema
  username: string
  // —— 以下不入配置文档 ——
  // password: 见 credentials（secretStorage: 'master_key'|'session'）
  driverProperties: Record<string, string>   // 如 rewriteBatchedStatements=TRUE
  writeEnabled: boolean      // 默认 false（05 §6 权限面）
  comment?: string
  // P1 预留（MVP 不接受）：
  // sshConfiguration, sslCfg, schemaMapping/introspectionScope
  // —— 运行时缓存（测试成功后写）——
  databaseInfo?: {
    product: string           // "MySQL" / "Oracle"
    version: string           // "5.7.99" / "Oracle Database 11g ..."
    jdbcVersion?: string      // "4.2"
    driverVersion: string     // "mysql-connector-j-9.5.0" / 桥版本
    dbms: string              // "MYSQL" / "ORACLE"
    exactVersion?: string     // "11.2.0.1.0"
    identifierQuoteString: string  // "`" / "\""
    extraNameCharacters?: string
    caseSensitivity: { plain: 'upper'|'lower'|'exact', quoted: 'exact' }
  }
  lastTestedAt?: string      // ISO
  lastTestState?: 'YES'|'NO'|'UNSURE'
}
```

`databaseInfo` 字段直接镜像 DataGrip `dataSources.local.xml` 实证结构（RUNTIME-FINDINGS §2.3）——连接测试的产物模型，前端状态点与版本展示都消费它。

## 3. 存储文档 schema（storage-json）

> **2026-10-17 适配 0.1.7**：宿主存储不再是「按 key 取文档」的简单 KV，而是**域（domain）制**——插件声明 `DomainSpec`（`name` / `version` / `layout: 'single'` / `tables` / `global`，schema 用 zod），经 `ctx.storageDomain.open(spec)` 得到 `DomainImpl`，其 `global` 单元与 `table(name)` 提供 `get/put/update/delete/entries`（`packages/storage/storage-domain/lib/types/spec.d.ts` L31-67）。本仓把这层收敛成 `src/host/kv.ts` 的 `KvStore` 端口，`src/datasource/store.ts` 只依赖该端口，因此可脱离宿主单测；schema 校验与域声明留在绑定层。
>
> **域名的硬约束（2026-10-18 实机踩到）**：storage-json 用 `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/` 校验单元名与表名（`packages/storage/storage/lib/index.js:80`，`storage-json/lib/index.js:590`），**不接受连字符**。因此域名为 **`dsh_data_ide`**（下划线），首次真机启动才没有 `StorageError: invalid unit name 'dsh-data-ide'`。注意与凭据 key 前缀 `dsh-data-ide/<connId>` 区分：后者是 credentials 服务的记录 key，不走该正则。

```jsonc
// 文档 key: "dsh-data-ide/datasources"
{
  "schemaVersion": 1,
  "dataSources": [ DataSource, ... ],     // 不含 password
  "activeConnId": "f02da6e0-..." | null
}
// 文档 key: "dsh-data-ide/history"
{ "schemaVersion": 1, "byConn": { "<connId>": [ QueryHistoryEntry, ... ] } }
// 文档 key: "dsh-data-ide/layout"
{ "schemaVersion": 1, "pageSizeDefault": 500, "perConn": { "<connId>": { "columnWidths": {}, "gitPanelOpen": true } } }
```

QueryHistoryEntry：`{ id, connId, sql, state: 'OK'|'ERROR'|'CANCELLED', durationMs, rowCount|null, at, source: 'ui'|'agent' }`。

迁移策略：`schemaVersion` + 迁移函数表（v1→v2…）；旧文档读取失败时隔离备份（`*.corrupt-<ts>`）而非丢弃（对照 DataGrip "Unable to save model. File is readonly" 的失败显式化，SPEC §2.1）。

## 4. 凭据设计（ctx.credentials）

- API（已核验 `packages/credentials/credentials/src/index.ts`）：`credentialKey(scope, id)`、record 读写、`modifyRecord` 排他写；key 两段须匹配 `[a-z][a-z0-9-]*`——**UUID  connId 需规范化为短 id 或连字符形式**（建议 `ds-<8hex>`）；
- key 形如 `dsh-data-ide/<connId>`，payload：`{ "password": "...", "secretStorage": "master_key"|"session" }`（session = 仅内存，不落 record——镜像 DataGrip `LocalDataSource$Storage{MEMORY,SESSION}`，SPEC §2.3）；
- **宿主单点解析**：MCP 子进程不读凭据库；每次执行由宿主取出密码经 stdio 传入（02 §4.3）；server 不记日志、不落盘；
- git remote token：`dsh-data-ide/git-remote`，同上传递路径。

## 5. 查询历史

- 字段见 §3；上限 200/连接（环形）；agent 与人共享可见（`source` 区分）；
- 存储于 storage-json 文档（非文件），随 profile 备份/迁移。

## 6. 结果缓存策略（显式轻量化）

| 缓存 | 策略 |
|---|---|
| 当前页数据 | 内存（宿主→UI 传输后 UI 持当前页） |
| 邻页预取 | **MVP 不做**（翻页即时加载；预取阈值类细节参照 COMPREHENSIVE-ASSESSMENT §8 决议：实现细节自行定义） |
| COUNT | 缓存至 schema 变更/手动刷新/DDL 语句执行后失效 |
| 单元格图像/格式缓存 | **显式不做**（DataGrip 的 TableCellImageCache/FormatsCache 为性能优化，轻量化路线省略；SPEC-sql §5） |
| 大值 | 1MB/单元格上限；预览截断 32KB（03 §5 交互矩阵） |

## 7. SQL 脚本 git 目录

```
<dshHome>/data-ide-scripts/
├── .git/                     # git init（插件首次使用时）
├── .gitignore                # *.tmp, .DS_Store
├── <connName>/               # 按连接分目录（防重名冲突）
│   ├── query_1.sql
│   └── analysis/dt_check.sql
└── README.md                 # 自动生成：用途与安全说明
```

- **与 dsh 宿主仓库物理隔离**（R5）：永不把宿主仓库当脚本目录；防误提交；
- 单文件上限 1MB（read/write_script 强制，05 §3.3）；
- remote 配置由用户第一次 push 时引导设置（UI 表单 + token 入 credentials）。

## 8. 数据保留与清理

- 孤儿凭据：数据源删除时同步删 credentials record（宿主编排，防泄露残留——对照 DataGrip `cleanupOldFile` 的显式清理模式，SPEC §2.1）；
- 损坏文档隔离备份（§3）；
- 历史环形清理（§5）；
- 会话态密码（secretStorage=session）随宿主会话消失。

## 9. 跨进程传递内容（契约摘要，详见 05）

```
宿主 → MCP server（每次调用）：
{ conn: { dbms, host, port, database, username, password, driverProperties, writeEnabled },
  sql, pageSize?, offset? , paths?, message? }
```

- 不含任何 credentials key；server 侧不持久化上述任何内容；
- 取消：`statementId` + abort signal（mysql2 `connection.destroy()` / 桥 cancel op）。
