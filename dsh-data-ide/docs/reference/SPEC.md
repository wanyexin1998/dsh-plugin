# SPEC — 数据库客户端「数据源连接管理」行为与数据流规范

> 来源：对 DataGrip 2026.2.3（build DB-262.9437.163）安装目录的**纯静态分析**（REA CLI 6.5.0 + PE/ZIP/class 常量池检查），未运行目标程序、未修改任何文件。
> 本文档描述**可复现的行为与数据流**，供以开源方式实现同类功能参考。不含任何专有代码、资源或字节码；所有类名/字符串仅作为事实证据引用。

---

## 1. 总体架构（OBSERVED）

```
┌─────────────────────────────────────────────────────────────┐
│ IDE 主进程（Swing UI，IntelliJ Platform 模块系统）            │
│  ├─ 数据源模型  com.intellij.database.dataSource.*            │
│  ├─ 配置持久化  DataSourceStorageShared / DataSourceStorageLocal│
│  ├─ 驱动管理    DatabaseDriverManagerImpl / ClasspathManager  │
│  └─ 连接测试 UI DataSourceTestConnectionManager               │
├─────────────────────────────────────────────────────────────┤
│ 连接建立层  DatabaseConnectionManager / DatabaseConnectionEstablisher│
│  ├─ 拦截器：SshConnectionInterceptor / SslConnectionInterceptor      │
│  └─ RemoteDriver.connect(url, Properties, Map)                       │
├─────────────────────────────────────────────────────────────┤
│ JDBC 执行后端（独立进程或进程内工厂）                           │
│  intellij.database.jdbcConsole 模块                            │
│  ├─ JdbcClassLoader（URLClassLoader 隔离加载驱动 jar）          │
│  ├─ RemoteDriverImpl / RemoteConnectionImpl / Remote*Statement   │
│  └─ helpers/JdbcHelperImpl + 各 DBMS Helper（MySQL/Oracle/Hive…）│
└─────────────────────────────────────────────────────────────┘
```

关键 jar（均在 `plugins/DatabaseTools/lib/modules/`，OBSERVED）：

| jar | 职责 |
|---|---|
| `intellij.database.core.impl.jar` | 数据源模型、驱动模型、序列化、存储组件 |
| `intellij.database.connectivity.jar` | 连接建立、会话、SSH/SSL 拦截器 |
| `intellij.database.impl.jar` | UI（配置面板、连接测试管理器、动作） |
| `intellij.database.jdbcConsole.jar` | 进程外 JDBC 后端（Remote* 代理族） |
| `intellij.database.dialects.*.jar` | 方言 + 驱动声明 `databaseDrivers/*-drivers.xml` |

---

## 2. 连接配置的存储

### 2.1 存储文件与作用域（OBSERVED）

| 文件 | 作用域 | 组件 / 注解 | 证据 |
|---|---|---|---|
| `dataSources.xml` | 应用级 **和** 项目级 | `DataSourceStorageShared`，`@State(name="dataSourceStorage", storages={@Storage(value="dataSources.xml", category=TOOLS)})`，内部类 `$App` / `$Prj` | `com/intellij/database/dataSource/DataSourceStorageShared.class` 常量 `STATE_FILE="dataSources.xml"`、`COMPONENT_NAME="dataSourceStorage"` |
| `dataSources.local.xml` | 项目级，**禁用漫游同步** | `DataSourceStorageLocal`，`@Service(Level.PROJECT)`，`@State(..., roamingType=RoamingType.DISABLED)` | 同类常量 `STATE_FILE_PATH="dataSources.local.xml"` |
| `databaseDrivers.xml` | 用户修改过的驱动定义 | `DatabaseDriverManagerImpl`（`PersistentStateComponent`） | 类中 `@State` storages 常量 `databaseDrivers.xml` |
| `jdbc-drivers/` 目录 | 下载的驱动 jar | `DatabaseDriverManagerUtil.DRIVER_DIR="jdbc-drivers"`，可用系统属性 `datagrip.driver.path` 覆盖 | 同类常量 |
| `<UUID>.xml`（每数据源一个） | 内省模型缓存（表结构等） | `DataSourceModelStorageImpl.getStorageDir` / `cleanupOldFiles`（UUID 正则 `\p{XDigit}{8}(?:-\p{XDigit}{4}){3}-\p{XDigit}{12}(?:\.xml)?`） | 同类常量；读写经 `com.intellij.database.model.serialization.ModelImporter` |
| `test-database-drivers.xml` | 测试驱动加载 | `DatabaseDriverManagerImpl.loadTestDrivers` | 同类常量 |

设计含义（INFERRED）：**共享配置与机密分离**——`dataSources.xml` 存非机密定义，密码等机密走凭据存储（见 2.3）；`.local.xml` 用于不可同步的本地数据源（本地文件库等）。

### 2.2 序列化格式（OBSERVED）

- 序列化引擎：**XStream**（`com.thoughtworks.xstream.io.HierarchicalStreamWriter/Reader`，来自 `plugins/libraries-misc-plugin/lib/modules/intellij.libraries.xstream.jar`）。
- 入口类：`com.intellij.database.dataSource.LocalDataSourceSerialization`（`serialize` / `deserialize`，含 `NoopSubstitutor`）。
- XML 元素名（常量池实证）：`connection-mode`、`single-connection`、`driver-ref`、`jdbc-driver`、`driverClass`、`jdbc-url`、`user-name`、`secret-storage`、`user-pass`、`driver-properties`、`schema-mapping`、`ssh-properties`、`ssl-config`、`domain-auth`、`vm-options`、`imported`、`configured-by-url`。
- 序列化分节方法：`serializeHeader` / `serializeDatabaseInfo` / `serializeAdditionalProperties` / `serializeLinkedDataSources` / `serializeBeforeTasks` / `serializeSessionTemplates` / `serializeLayoutConfigurations`。

### 2.3 密码与凭据（OBSERVED）

- 密码存储模式枚举 `LocalDataSource$Storage`：`PERSIST` / `MEMORY` / `SESSION`（序列化值另见 `MASTER_KEY` / `FORGET` / `FOR_SESSION`）。
- 认证提供者 `DatabaseAuthProviderNames`：`user-pass` / `ms-sso` / `no-auth`。
- 凭据读写：`GlobalCredentialManager` → `com.intellij.ide.passwordSafe.PasswordSafe`；`GlobalStrictCredentialManager` → `com.intellij.credentialStore.{CredentialAttributes, Credentials, OneTimeString}`。
- 连接建立时的密码解析：`DatabaseConnectionEstablisher$Companion.resolvePasswordIssues`；SSH/SOCKS 代理侧 `SocksServerHandler` / `DatabaseProxyServer$Companion` 使用 `OneTimeString` 传递一次性口令。
- 实际加密方式、存储后端（OS keychain / 文件）**未分析 → UNKNOWN**。

### 2.4 数据源模型字段（OBSERVED，`LocalDataSource` 常量池）

`url`、`username`、`passwordStorage`、`driverClass`、`driverRef`、`driverProperties`、`sshConfiguration`（`DataSourceSshTunnelConfiguration`）、`sslCfg`（`DataSourceSslConfiguration`）、`connectionMode`、`introspectionLevel`、`schemaMapping`、`codeStyleName`、`vmOptions`、`comment`、`imported`、`configuredByUrl`。
`DatabaseConnectionConfig` 为连接时使用的最终配置（url / user / properties / credentials）。

---

## 3. 驱动定义与加载逻辑

### 3.1 驱动声明（OBSERVED，声明式 XML）

各方言 jar 内 `databaseDrivers/*-drivers.xml`，经插件扩展点 `com.intellij.database.driversConfig` 注册（见各 jar 的 `*.xml` 中 `<driversConfig config="..."/>`）。结构：

```xml
<driver id="mysql.8" name="MySQL" based-on="mysql.base">
  <url-template name="default" template="jdbc:mysql://{host::localhost}?[:{port::3306}][/{database}?]..."/>
  <artifact id="MySQL ConnectorJ" use="true" rolling="true"/>
  <option name="auto-sync" value="true"/>
  <property name="..." value="..."/>
  <constraints><constraint dbms="ORACLE" from="11.2"/></constraints>
</driver>
```

实证样例（OBSERVED）：

| DBMS | driver-class | URL 模板 | 备注 |
|---|---|---|---|
| MySQL | `com.mysql.cj.jdbc.Driver`（`mysql.base`，abstract；`mysql.8`/`mysql` 基于它） | `jdbc:mysql://{host::localhost}?[:{port::3306}][/{database}?]...`，另含 `address=(protocol=tcp)...` 与 Unix Socket 模板 | 5.1 用 `com.mysql.jdbc.Driver` |
| Oracle | `oracle.jdbc.OracleDriver`（`oracle.base` abstract） | SID / Service Name / TNS / Long 四种模板，端口默认 1521 | 附带 `<property name="v$session.program" value="DataGrip"/>`；`oracle.19` 约束 `dbms=ORACLE from=11.2` |
| Apache Hive | `org.apache.hive.jdbc.HiveDriver` | `jdbc:hive2://{host::localhost}?[:{port::10000}][/{database}?][;user={user},password={password}...]` | artifact `Hive` `rolling=true`；方言 `HiveQL` |
| Apache Spark | `org.apache.hive.jdbc.HiveDriver` | 同 hive2 模板 | dialect `SparkSQL` |
| **Apache Doris** | **无专有驱动/方言** | — | 见 §7 |

派生机制（OBSERVED）：`based-on`（继承基础驱动）、`abstract`、`group-with`（UI 分组）、`constraints`（按 DBMS 版本选择驱动，如 `oracle.19` vs `oracle`）。

### 3.2 驱动制品解析与下载（OBSERVED）

- 制品清单：`intellij.database.core.impl.jar :: resources/database-artifacts.xml`：
  - `<item type="maven" url="com.mysql:mysql-connector-j:9.7.0"/>` 等 Maven 坐标；
  - `<item url="https://download.jetbrains.com/idea/jdbc-drivers/..."/>` 直链 jar；
  - `<item type="license" .../>` 许可文件；
  - `<repository id="alibaba" url="https://maven.aliyun.com/repository/public/"/>`。
- 解析引擎：**Eclipse Aether**（`org.eclipse.aether.repository.RemoteRepository`，见 `DatabaseArtifactLoaderImpl`）。
- 关键类：`DatabaseArtifactLoaderImpl`（下载/解压，含 `-win-auth.jar` 平台变体）、`DatabaseArtifactList`（版本/条目/架构）、`LocalArtifactStorage`（本地缓存）、`ArtifactFilesSource`、`DownloadableFileSetDescription`。
- 用户级覆盖：`databaseDrivers.xml`（PersistentStateComponent）；测试驱动 `test-database-drivers.xml`（`DatabaseDriverManagerImpl.loadTestDrivers` / `loadPre141` 兼容旧版）。
- 驱动状态检查：`DatabaseDriverUtils.isDriverFilesUpToDate`、`DatabaseDriver$ArtifactRef`、`ArtifactProblemFix`（缺失/过期时的修复动作）。

### 3.3 classpath 组装与隔离（OBSERVED）

- `DatabaseDriverClasspathManagerImpl`：`getClasspathElements` / `getAdditionalClasspathElements` / `getAdditionalClasspathDir` / `hasDriverFiles`，产出 `SimpleClasspathElement` 列表；支持把驱动文件传输到远端后端（`collectTransferRunnables` / `localClassPath` / `localNativeLibs`，配合 `ClasspathModificationTracker`）。
- 隔离加载器：`com.intellij.database.remote.jdbc.impl.JdbcClassLoader$JdbcClassLoaderImpl extends java.net.URLClassLoader`，构造参数 `(parent, base, URL[])`，方法 `parseClassPath` / `cleanClassLoader`；失败信息 `"Failed to isolate classpath. No parent for ..."`、`"Failed to parse JDBC classpath"`。
- 是否隔离由 `JdbcDriverManagerImpl.shouldIsolateClassPath` / `getIsolatedClassPath` / `setClassPath` 决定（INFERRED：默认按驱动隔离，避免驱动间类冲突）。

### 3.4 JDBC 执行位置（OBSERVED）

- 后端模块 `intellij.jdbcConsole` 提供 `RemoteDriver(Factory)`、`RemoteConnectionImpl`、`RemoteStatementImpl`、`RemoteResultSetImpl`、`RemoteDatabaseMetaDataImpl`、`RemoteProcessController` 等——**JDBC 调用发生在独立后端进程（或进程内工厂）中，前端通过代理对象访问**。
- 进程支撑：`JdbcRemoteConsoleProcessSupport` / `RemoteConsoleProcessSupport`（`acquireInProcessFactory` 进程内回退；`publishPort` / `forwardLocalPort` / `EelTunnelsApi` 远端端口转发）。
- DBMS 适配：`helpers/JdbcHelperImpl` + `MysqlBaseJdbcHelper` / `OraJdbcHelper` / `HiveJdbcHelper` / `PgJdbcHelper` 等（方言相关的 SQL 差异、类型映射、`JdbcInjection` 时间戳注入）。

---

## 4. 连接测试流程（OBSERVED）

入口：`com.intellij.database.dataSource.ui.DataSourceTestConnectionManager`（UI 组件 `DataSourceTestConnectionComponent`）。

```
testConnection / testConnectionAsync
  └─ handleIncompleteConfiguration           # 配置完整性检查
       ├─ DatabaseDriverUtils.isDriverFilesUpToDate(driver)
       ├─ ArtifactRef.resolveVersion(...)     # 解析应使用的驱动版本
       └─ 弹窗：DataSourceConfigurable.drivers.not.downloaded / download.driver /
                 switch.to.latest / drivers.not.configured
  └─ performTestConnection(DatabaseConnectionConfig, TestInfo, ErrorHandler)
       └─ DatabaseConnectionManager.establishConnectionAndPrepare
            └─ DatabaseConnectionEstablisher
                 ├─ createProtoConnection → ProtoConnectionBuilder.processInterceptors
                 │    （SSH / SSL 拦截器链，getActiveInterceptors）
                 ├─ tryConnect → tryConnectInner → connect
                 │    ├─ 日志 "Connecting to: {url}" / "Connecting to (rewritten): {url}"
                 │    ├─ RemoteDriver.connect(url, Properties, Map)  → RemoteConnection
                 │    ├─ resolvePasswordIssues（密码失败时交互重试）
                 │    └─ processConnected / processNullConnection
                 │      / processConnectionFailure / handleConnectionFailure / tryReconnect
                 └─ pingDatabase
                      ├─ SmartStatements → SimpleSmartStatement / BarrenStatement
                      ├─ setPing / setKeepAliveResult / setKeepAliveError / setSslState
                      └─ DatabaseConnectionCore.getSslState → ThreeState
  └─ processTestConnectionResult → ProcessedTestConnectionResult
       ├─ ThreeState（YES / NO / UNSURE）+ stateText
       ├─ 状态键：test.connection.status.succeeded / .failed / .keep.alive.fail /
                 .database.returned.warning / .in.progress / .last.known
       ├─ createSuccessSummary（含数据库版本、驱动版本）
       ├─ 错误处理：com.intellij.database.connection.throwable.info.ErrorInfo（含 Fix）
       └─ 版本未知时 manuallySpecifyDbVersion（"dialog.title.database.version"）
```

失败路径（OBSERVED 字符串）：`"Null connection returned for: "`、`connection.canceled`、`expected.to.connect.to.0.but.have.only.1`、`ReboundNotPossibleException`。

---

## 5. SSH / SSL 隧道（OBSERVED）

- SSH：本地 **SOCKS 代理**实现——`DatabaseProxyServer`、`SocksServerInitializer`、`SocksServerConnectHandler`、`SocksServerHandler`、`RelayHandler`、`DirectClientHandler`、`DatabaseSshTunnel` / `DatabaseSshTunnelsManager` / `DatabaseSshTunnelsProvider`；`BaseSshConnectionInterceptor` / `SshConnectionInterceptor` 在连接建立前介入。
- 代理凭据以 `OneTimeString` 传递（`SocksServerHandler.getPassword`）。
- SSL：`SslConnectionInterceptor`（`initClientCert` / `tryLoadUserCertificatesWithNewPassword` / `UserKeyPasswordErrorInfo`），客户端证书加载与密码交互。
- 远端执行时端口转发：`JdbcRemoteConsoleProcessSupport.publishPort` / `forwardLocalPort`（Eel Tunnels API）。

---

## 6. 数据流总览（端到端）

```
用户编辑表单(AbstractDatabaseConfigurable/DatabaseConfigEditor)
  → LocalDataSource 模型(url/user/driverRef/props/ssh/ssl)
  → 保存：XStream → dataSources.xml(shared) / dataSources.local.xml(local, 禁漫游)
          密码 → PasswordSafe/CredentialStore（secret-storage=user-pass）
  → 连接时：DataSourceStorage 读取 → DatabaseConnectionConfig
  → 驱动解析：databaseDrivers/*-drivers.xml(预定义) + databaseDrivers.xml(用户) 
              → database-artifacts.xml + Aether → jdbc-drivers/<driver>/<version>/*.jar
  → classpath：DatabaseDriverClasspathManager → JdbcClassLoader(URLClassLoader)
  → 后端：RemoteConsoleProcess(进程外) 或 acquireInProcessFactory(进程内)
  → RemoteDriver.connect(url, props) → RemoteConnection
  → 测试：pingDatabase(SmartStatements) → ThreeState + 摘要/ErrorInfo
  → 成功后：内省(introspection)结果写 <UUID>.xml 模型缓存
```

---

## 7. Doris 说明（OBSERVED 缺失 + INFERRED 建议）

- 静态扫描全部 DatabaseTools 模块 jar 与整个安装目录：**无 `doris` 驱动声明、方言或类**（`intellij.database.core.impl.jar` 中唯一 "doris" 命中是大地测量 CSV 数据 `DORIS observations`，无关）。
- Doris FE 兼容 MySQL 协议（INFERRED，社区常识，非本产品观察）→ 实践上用 MySQL 驱动（`com.mysql.cj.jdbc.Driver`，URL `jdbc:mysql://host:9030/db`）连接。若需 Doris 专属能力（FE/BE 区分、`jdbc:mysql://` 9030 端口、Stream Load 等），需自建驱动定义——正好对应 §8 的扩展点设计。

---

## 8. 开源实现对照（设计映射，非代码复制）

| DataGrip 机制 | 开源替代 |
|---|---|
| `dataSources.xml` / `.local.xml`（XStream） | 自有 XML/JSON/YAML 存储（Jackson/JAXB/XStream 均可）；建议同样分离 shared/local 两个文件 |
| PasswordSafe / CredentialStore | OS keychain：`java-keyring`、macOS Keychain、Windows Credential Manager、libsecret；内存态用 `OneTimeString` 式一次性字符串 |
| `databaseDrivers/*-drivers.xml` 声明式驱动 | 自有 driver registry：id / class / url-template / artifact / options；支持 `based-on` 继承与版本约束 |
| Aether 解析 + `jdbc-drivers/` 缓存 | Maven Resolver（`maven-resolver` + `aether-connector-basic`）解析 GAV，本地缓存目录 |
| `JdbcClassLoader`（URLClassLoader 父子链） | 每驱动一个 `URLClassLoader(parent=platform, urls=driver jars)`，`cleanClassLoader` 式关闭；驱动间类隔离 |
| 进程外 JDBC 后端 + Remote* 代理 | 可选：进程内 `DriverManager.getConnection`（简单场景）或 fork 子进程 + RPC（稳定场景，驱动崩溃不拖死 UI） |
| `DataSourceTestConnectionManager` | `Driver.connect(url, props)` + 验证查询（`SELECT 1` / `SELECT VERSION()`）；结果分 YES/NO/UNSURE 三态 + ErrorInfo（可修复建议） |
| SSH 隧道（本地 SOCKS） | JSch/sshd-core 起本地 SOCKS5，或 JVM 端口转发（`ServerSocket` 隧道到 SSH channel） |
| SSL 客户端证书 | 标准 `SslContext`/KeyStore 加载，密码交互后重试 |
| `<UUID>.xml` 内省缓存 | 自建 schema 缓存（库/表/列 JSON），按数据源 UUID 分文件，启动时清理孤儿文件 |
| DBMS Helper（方言差异） | 策略接口 `JdbcHelper`，按 driver-class/URL 前缀分发（MySQL/Oracle/Hive/PG…） |

最小可行实现顺序建议：驱动注册表 → 凭据存储 → XStream/JAXB 持久化 → URLClassLoader 隔离 → DriverManager 连接 + ping → SSH 隧道 → 方言 Helper → 模型缓存。

---

## 9. 无法通过本次静态分析确认的部分（UNKNOWN）

1. **方法内部控制流**：本机无 Ghidra/objdump provider（Windows 限制），仅有常量池/字符串级证据；`tryConnect` 等内部精确顺序为 INFERRED。
2. **凭据加密细节**：PasswordSafe/CredentialStore 的后端（是否 OS keychain、主密码机制）未分析。
3. **许可/保护机制**：`plugins/DatabaseTools/lib/intellij.platform.commercial.verifier.jar` 与 `datagrip-impl` 同名 jar 存在，但内容未分析（且按要求未尝试绕过）。
4. **后端进程启动命令行**：RemoteConsoleProcess 的确切 java 参数、类路径、进程名未提取。
5. **下载端点可达性与内容**：仅见到 URL 字符串（download.jetbrains.com、maven.aliyun.com），未发起任何网络请求。
6. **运行时行为**：全部结论均为静态；线程模型、超时值、重试策略等需运行时观察。
7. **Doris**：无任何产品内证据；§7 建议为外部知识推断。

---

## 10. 证据索引（主要文件）

- `plugins/DatabaseTools/lib/modules/intellij.database.core.impl.jar`
  - `com/intellij/database/dataSource/{DataSourceStorageShared,DataSourceStorageLocal,LocalDataSource,LocalDataSourceSerialization,DatabaseDriverManagerImpl,DatabaseConnectionConfig}.class`
  - `resources/database-artifacts.xml`
- `plugins/DatabaseTools/lib/modules/intellij.database.connectivity.jar`
  - `com/intellij/database/dataSource/{DatabaseConnectionEstablisher,DatabaseDriverClasspathManagerImpl,RemoteProcessInitializer,DatabaseDriverImpl}.class`
  - `com/intellij/database/console/{JdbcEngine,JdbcDriverManagerImpl,JdbcRemoteConsoleProcessSupport}.class`
  - `com/intellij/database/console/ssh/*`（SOCKS 代理族）
- `plugins/DatabaseTools/lib/modules/intellij.database.impl.jar`
  - `com/intellij/database/dataSource/ui/DataSourceTestConnectionManager*.class`
  - `com/intellij/database/dataSource/LocalDataSourceManager.class`
- `plugins/DatabaseTools/lib/modules/intellij.database.jdbcConsole.jar`
  - `com/intellij/database/remote/jdbc/impl/JdbcClassLoader*.class`、`RemoteDriver*.class`、`helpers/*`
- `plugins/DatabaseTools/lib/modules/intellij.database.dialects.{mysql,oracle,hive}.jar`
  - `databaseDrivers/{mysql,oracle,hive}-drivers.xml`
- `plugins/libraries-misc-plugin/lib/modules/intellij.libraries.xstream.jar`
- `product-info.json`（版本/构建/插件清单）
