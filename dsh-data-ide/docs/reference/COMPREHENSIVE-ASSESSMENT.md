# DataGrip 逆向与开源复刻综合评估报告

> **评估对象**：DataGrip 2026.2.3（JetBrains，build DB-262.9437.163）
> **评估方法**：REA CLI 6.5.0 静态分析（PE/ZIP/JAR/class 常量池）+ 运行时被动观察（进程/端口/jstack/配置/日志，全程只读）
> **评估目的**：为以开源方式复刻同类「数据库 IDE / 数据源连接 + SQL 编辑 + 结果网格」能力提供架构依据与工作量评估
> **关联文档**：`SPEC.md`（连接管理）、`SPEC-sql-execution-grid.md`（执行与网格）、`RUNTIME-FINDINGS.md`（运行时实证）
> **日期**：2026-10-17

---

## 1. 摘要

DataGrip 的本质是：**一个 Rust 薄启动器 + 内嵌 JVM 的 IntelliJ Platform 应用 + 进程外 JDBC 后端 + 声明式驱动体系 + 三层索引的结果网格**。其架构并不神秘，核心机制（连接配置存储、驱动解析与隔离、分页取数、结果渲染）均已通过静态+运行时双重证据闭环，**开源复刻在技术上完全可行**。

关键结论：

| 维度 | 结论 |
|---|---|
| 架构复杂度 | 中高。难点不在单点技术，而在子系统数量（驱动生态、方言、执行后端、网格渲染、编辑回写） |
| 复刻 MVP | 2–3 人月（单 DBMS、进程内 JDBC、基础分页网格） |
| 复刻「可用」产品 | 6–12 人月（多 DBMS、驱动下载管理、SSH/SSL、排序过滤、编辑回写） |
| 复刻「生产级」 | 2 人年以上（进程外后端、方言体系、内省缓存、虚拟滚动、远程开发） |
| 合规风险 | 低——复刻的是**架构与行为模式**，非代码/资源；注意 JetBrains 商标与驱动许可 |
| 最大意外发现 | ① 后端是**独立 Java 进程 + RMI(SSL)**；② 分页是 **`LIMIT n+1` + 独立 COUNT + OFFSET**；③ 凭据用 **KeePass KDBX**；④ **Doris 无专有驱动，走 MySQL 协议**（9030） |

---

## 2. 评估方法与证据体系

### 2.1 方法

| 阶段 | 手段 | 约束 |
|---|---|---|
| 静态 | REA CLI：`inspect-pe-resources`、`inspect-artifact`、`inspect-managed-artifact`、`inspect-rust-binary`；JAR/class 常量池提取 | 不运行目标、不修改文件 |
| 运行时 | 进程信息（CIM）、网络连接、`jstack`（IDE + 后端）、配置文件、`idea.log`、`database.0.log` | 只读；不注入；不绕过许可；不读取密码内容 |
| 反汇编 | 不可用（Ghidra 未配置、objdump provider 限 Linux）→ 字节码级细节列为 UNKNOWN | — |

### 2.2 证据分级约定

- **OBSERVED**：文件/日志/进程/网络中的直接证据（附路径、类名、字符串、命令行）。
- **INFERRED**：由 OBSERVED 证据组合得出的合理推断（标注依据）。
- **UNKNOWN**：无证据或需更强手段（反汇编/授权插桩）；重要且可代价接受的已标注获取方式。

**覆盖率**：连接管理与执行网格两条线的架构机制 100% 有 OBSERVED 或 INFERRED 证据；剩余 UNKNOWN 均为数值型实现细节，已决议关闭（见 §8）。

---

## 3. 架构画像（整合版）

```
┌────────────────────────────────────────────────────────────────────┐
│ 启动层  datagrip64.exe（Rust 编写，xplat_launcher + jni crate）        │
│   ├─ JNI 加载 jbr/bin/server/jvm.dll，进程内创建 JVM                   │
│   ├─ 读取 product-info.json → 拼 boot classpath（lib/*.jar 427 个）    │
│   ├─ mainClass: com.intellij.idea.Main（intellij.platform.bootstrap） │
│   └─ 内嵌 Chromium sandbox/crashpad（JCEF 浏览器，非 Electron）         │
├────────────────────────────────────────────────────────────────────┤
│ IDE 主进程（内嵌 JVM，IntelliJ Platform 模块系统）                     │
│   ├─ 数据源模型 LocalDataSource / 序列化 XStream                       │
│   ├─ 存储：dataSources.xml(shared) / dataSources.local.xml(local,禁漫游)│
│   │        databaseDrivers.xml(用户驱动) / jdbc-drivers/(驱动jar仓库)   │
│   │        凭据：KeePass c.kdbx（secret-storage=master_key）            │
│   ├─ 驱动管理：databaseDrivers/*-drivers.xml 声明 + Aether 解析          │
│   ├─ 连接测试：DataSourceTestConnectionManager → ThreeState + ErrorInfo│
│   └─ 结果网格：MultiPageModel / GridLoaderBase / 三层索引(Raw-Model-View)│
│      TableResultView(JTable) + TableCellImageCache(图像缓存)           │
├────────────────────────────────────────────────────────────────────┤
│ 执行层  DatabaseConnectionManager / DatabaseConnectionEstablisher      │
│   └─ SSH(SOCKS5 本地代理) / SSL 拦截器 → RemoteDriver.connect()         │
├────────────────────────────────────────────────────────────────────┤
│ JDBC 后端（独立 Java 进程）                                            │
│   java -Djava.rmi.server.hostname=127.0.0.1 ...                        │
│        com.intellij.database.remote.RemoteJdbcServer <DriverClass>     │
│   ├─ JdbcClassLoader(URLClassLoader, parent=PlatformClassLoader)      │
│   ├─ RemoteDriver/Connection/Statement/ResultSet(Impl) + JdbcHelper    │
│   └─ RMI over SSL（注册端口 60491 / 服务对象端口 58804，回环）            │
└────────────────────────────────────────────────────────────────────┘
```

数据流一句话：**编辑器 → 请求模型(offset/limit/maxLobLength) → RMI → 后端进程内驱动执行 → List<Object[]> 回传 → 消费者入页模型 → JTable 渲染（图像缓存 + 三层索引）**。

---

## 4. 子系统评估矩阵

| # | 子系统 | 核心机制（证据等级） | 复刻难度 | 关键依赖 |
|---|---|---|---|---|
| 1 | **启动与平台** | Rust 启动器 + JNI 建 JVM + boot classpath（OBSERVED：PE 字符串、product-info.json） | 低（可跳过：直接用 `java -jar`） | 无 |
| 2 | **连接配置存储** | XStream XML；shared/local 双文件；`driver-ref/jdbc-url/secret-storage` 元素（OBSERVED：真实 dataSources.xml） | **低** | XStream/Jackson + 自有文件布局 |
| 3 | **凭据管理** | KeePass KDBX + master_key；user-name 明文、密码入库（OBSERVED：c.kdbx 文件头 + .local.xml） | 低 | KeePassJava 或 OS keychain（libsecret/Keychain/CredMan） |
| 4 | **驱动声明体系** | 声明式 XML：`driver-class/url-template/artifact/option/property/constraints/based-on`（OBSERVED：*-drivers.xml） | **低**（这是最值得抄的“设计”） | 无 |
| 5 | **驱动制品解析** | database-artifacts.xml（GAV + 直链 + 许可）+ Eclipse Aether + 本地 Maven 布局仓库（OBSERVED：jdbc-drivers 目录 + RemoteProcessSupport 日志） | 中 | maven-resolver（aether） |
| 6 | **驱动隔离加载** | URLClassLoader(parent=Platform, urls=driver jars)（OBSERVED：日志 base loader 实证） | 低 | JDK 原生 |
| 7 | **连接建立/测试** | 拦截器链(SSH/SSL) → RemoteDriver.connect(url,props) → ping(SmartStatements) → ThreeState（OBSERVED：日志链 + 类清单） | 中 | JDBC + SSH 库（JSch/sshd-core） |
| 8 | **执行后端** | **独立进程 + RMI(SSL)**（OBSERVED：完整命令行 + 端口 + 线程） | 中（MVP 可进程内） | Java RMI 或 gRPC/自研 RPC |
| 9 | **分页取数** | `LIMIT pageSize+1` + 独立 COUNT + OFFSET（OBSERVED：database.0.log 真实 SQL） | **低** | SQL 生成（按方言） |
| 10 | **结果网格渲染** | JTable + 三层索引(Raw/Model/View) + 排序/过滤模型 + 单元格图像缓存（OBSERVED：类清单 + 属性键） | 中高 | Swing/JavaFX；或 Web 前端 |
| 11 | **编辑回写** | MutationsStorage → DML 生成器 → Insert/Update/Delete 请求（OBSERVED：类清单） | 中 | 方言 DML 生成 |
| 12 | **内省(introspection)** | metadata 查询 + `<UUID>.xml` 模型缓存 + schema-mapping scope（OBSERVED：.local.xml + data-source 缓存目录） | 中 | JDBC metadata + 自研缓存 |
| 13 | **方言体系** | 每 DBMS 独立 dialect jar：解析器/高亮/类型系统/Helper（OBSERVED：~50 个 dialect jar） | **高** | 自研 SQL 解析或用 JSQLParser/ANTLR |
| 14 | **SQL 编辑器** | IntelliJ PSI 全家桶（词法/解析/语义/补全/检查） | **很高** | JSQLParser/ANTLR + LSP 思路降级 |

**难度解读**：
- **低难度高价值区（#2/#4/#6/#9）**：存储格式、驱动声明、classloader 隔离、分页模型——这些都是**设计模式**级能力，复刻成本极低，直接决定产品可用性。
- **中难度区（#5/#7/#8/#10/#11/#12）**：需要 2–6 周单项投入，有成熟开源替代。
- **高难度区（#13/#14）**：方言与编辑器是 JetBrains 十年积累，开源复刻应**主动降级**（见 §7 路线图）。

---

## 5. 运行时验证汇总（静态推断 → 运行时确认）

| 静态推断（SPEC） | 运行时证据 | 结论 |
|---|---|---|
| Rust 启动器 JNI 建 JVM | 进程树：datagrip64.exe 无独立 IDE java.exe 子进程 | ✅ 确认 |
| 后端独立进程 | PID 6892 `RemoteJdbcServer com.mysql.cj.jdbc.Driver` | ✅ 确认 |
| RMI 通信 | `RMI TCP Accept-60491` 线程 + netstat 双回环 Listen + 日志 `Port/ServicesPort/ID` | ✅ 确认（60491/58804） |
| 驱动 classpath 隔离 | 日志 `base loader = PlatformClassLoader` + `Using classpath: [driver jar, protobuf, shim]` | ✅ 确认 |
| XStream 序列化 | 真实 dataSources.xml 元素与常量池预测逐一吻合 | ✅ 确认 |
| 密码不进 XML | `.local.xml` 仅 `user-name` 明文 + `secret-storage=master_key`；c.kdbx 为 KDBX | ✅ 确认 |
| Doris 走 MySQL 驱动 | `driver-ref=mysql.8` + 日志 `@@version_comment: Doris version doris-2.1.10` + 9030 连接 | ✅ 确认（原 INFERRED 升级） |
| 连接测试类链 | 日志 `DatabaseConnectionEstablisher - Connecting to: / Auth provider: user-pass` + `DatabaseCredentialsAuthProvider - Connecting as:` | ✅ 确认 |
| 分页 LIMIT+COUNT+OFFSET | `LIMIT 501` / `SELECT COUNT(*)` / `LIMIT 501 OFFSET 51786` | ✅ 确认（页大小 500+1 探针） |
| 整页加载非流式 | LIMIT 501 一次取整页入模型（DataConsumer.addRows 整批） | ✅ 确认 |
| 异常识别链 | RMI 异常栈：`RemoteSeanceImpl → JdbcIntermediateSeance → BaseExceptionRecognizer` | ✅ 确认 |
| 后端 JVM 参数（原 UNKNOWN） | 完整命令行（JBR、-Xmx750m、add-opens 白名单、UTC） | ✅ 解决 |

**12/12 项推断得到运行时确认**——两轮 SPEC 的架构判断可信度极高。

---

## 6. 开源复刻可行性评估

### 6.1 技术栈映射（DataGrip → 开源替代）

| DataGrip 机制 | 开源替代 | 成熟度 |
|---|---|---|
| XStream 序列化 | Jackson XML / JAXB（推荐 Jackson） | ★★★ |
| KeePass KDBX 凭据 | KeePassJava / `java-keyring`（OS keychain） | ★★★ |
| `databaseDrivers/*-drivers.xml` 声明式驱动 | **直接沿用该模式**（自研 schema） | ★★★ |
| Aether 驱动解析 | `maven-resolver`（aether 官方开源版） | ★★★ |
| URLClassLoader 隔离 | JDK 原生 | ★★★ |
| 进程外 JDBC 后端 | MVP 进程内；进阶用 gRPC 或 Java RMI 原生 | ★★☆ |
| SSH 隧道 | JSch / sshj / apache-mina-sshd（SOCKS5 自研） | ★★★ |
| SSL 客户端证书 | 标准 `SslContext`/KeyStore | ★★★ |
| 三层索引 + 排序/过滤 | 自研（模式简单：Raw↔Model↔View 索引转换） | ★★☆ |
| JTable 渲染 + 图像缓存 | Swing JTable 自研 renderer；或 Web（AG-Grid/TanStack Table 有现成虚拟滚动） | ★★★ |
| DML 生成器 | 自研（按方言拼 SQL，参考 `SelectUsingKeys`/`WrapInSelect` 思路） | ★★☆ |
| SQL 解析/补全/高亮 | JSQLParser / ANTLR 语法 / tree-sitter | ★★☆ |
| 方言体系 | 降级：MySQL/PG/Oracle 三方言手工 Helper（参考 `JdbcHelperImpl` 差异点） | ★★☆ |
| 内省缓存 | 自研 JSON 缓存（按数据源 UUID 分文件，参考 `entities.dat` 模式） | ★★★ |

### 6.2 工作量估算（1 名熟练 Java 工程师）

| 阶段 | 范围 | 工作量 | 产出 |
|---|---|---|---|
| **P0 MVP** | 驱动声明体系 + 配置存储(Jackson) + 凭据(keychain) + 进程内 JDBC + 单方言(MySQL/Doris) + LIMIT n+1 分页 + JTable 渲染 + 连接测试 | **2–3 人月** | 能连 Doris/MySQL、能浏览大表、能跑 SQL |
| **P1 可用** | + Aether 驱动下载 + SSH/SSL + 排序/过滤/三层索引 + 编辑回写 + 多方言 Helper(PG/Oracle) + 导出(CSV/JSON/INSERT) | **+4–9 人月** | 内部团队可日常替代 DataGrip 主力功能 |
| **P2 生产级** | + 进程外执行后端(RPC) + 内省缓存 + SQL 解析器/补全 + 虚拟滚动 + 远程执行(WSL/Docker/Eel 类似物) | **+12–24 人月** | 完整产品级；投入接近 2 人年 |

### 6.3 不建议复刻的部分（主动降级）

| 部分 | 原因 | 降级方案 |
|---|---|---|
| 完整 SQL 编辑器（PSI 级） | JetBrains 十年积累；自研成本无限 | 嵌入 Monaco/CodeMirror（Web）或 JEditParser + JSQLParser 提示 |
| 50+ 方言 | 长尾价值低 | MySQL/Doris、PostgreSQL、Oracle、Hive 四个手工 Helper |
| 远程开发（Eel/Gateway） | 基础设施级投入 | P2 再做，或用 SSH + 文件同步近似 |
| JCEF 嵌入式浏览器 | 与核心链路无关 | 不需要 |

---

## 7. 复刻路线图（针对你的场景：上海细胞 / Doris + MySQL + Oracle）

```
P0（第 1–6 周）
├─ W1-2  驱动声明 schema + 配置存储(Jackson XML) + 凭据(OS keychain)
├─ W3-4  MySQL/Doris 驱动加载(URLClassLoader) + 连接建立 + 连接测试(ThreeState)
├─ W5-6  结果网格：LIMIT n+1 + COUNT + OFFSET 分页 + JTable 渲染 + 三层索引骨架
└─ 里程碑：Doris 9030 连接 + 大表浏览 + console 执行 ✅（复制 DataGrip 已证实的核心行为）

P1（第 7–16 周）
├─ Aether 驱动下载管理（jdbc-drivers 本地仓库布局照抄）
├─ SSH 隧道（本地 SOCKS5）+ SSL 客户端证书
├─ 排序/过滤/单元格编辑回写（MutationsStorage 模式）
├─ PG/Oracle 方言 Helper + DML 生成
└─ 里程碑：MySQL + Doris + PG + Oracle 日常可用

P2（第 17 周+，可选）
├─ 进程外执行后端（gRPC）—— 崩溃隔离
├─ 内省缓存（UUID 分文件 JSON）
├─ 虚拟滚动（图像缓存 + cache factor）
└─ 远程执行
```

**关键设计决策建议**（从 DataGrip 架构直接吸收）：
1. **驱动声明与代码分离**——`drivers.xml` 声明式注册（driver-class/url-template/artifact），新 DBMS 不加代码；
2. **shared/local 双文件存储**——可入 VCS 的共享配置与含本地机密的配置分离；
3. **凭据永不进配置文件**——密码一律走 OS keychain/KDBX，配置里只存引用；
4. **`LIMIT n+1` 分页**——页大小 +1 行探针判断“还有下一页”，避免额外 COUNT 探测（总数用独立 COUNT 查询）；
5. **三层索引**——Raw（后端行号）/ Model（排序过滤后）/ View（可见），渲染只碰 View；
6. **MVP 不要进程外后端**——DataGrip 的进程外是为崩溃隔离和远程执行，MVP 进程内 JDBC 足够，P2 再拆。

---

## 8. 未决议项登记（已关闭）

| 项 | 决议（2026-10-17） |
|---|---|
| 预取触发阈值 | **实现细节，自行定义**（建议距页尾 ≤1 页触发） |
| `getRows` 批大小 / 批次切分 | **实现细节，自行定义**（页大小 ×1–2） |
| `database.grid.cache.factor` 默认值 | **实现细节，自行定义**（可视区 ×2–3） |
| RMI 端口 / 后端 JVM 参数 | **已由运行时解决**（见 RUNTIME-FINDINGS.md §3/§3b） |
| Swing 渲染绘制 / 虚拟滚动策略 | 保持 UNKNOWN；仅当自研高性能网格渲染器时装 Ghidra 反编译 `TableResultView`/`TableCellImageCache` |
| 许可机制 | 不深究（不绕过、不分析） |

---

## 9. 合规与法律边界

| 事项 | 边界 |
|---|---|
| 代码/资源 | **不复用** DataGrip 任何字节码、JAR、资源、文档原文；本报告所有类名/字符串仅作**事实引用与架构说明** |
| 商标 | 复刻产品**不得使用** JetBrains/DataGrip 名称、Logo、配色；产品命名需自有品牌 |
| 驱动许可 | 下载的 JDBC 驱动（MySQL GPL、Oracle OTN、PG BSD）需遵守各自许可——注意 MySQL Connector/J 的 GPL 传染性（商用闭源产品建议用 MariaDB Connector 或评估许可） |
| KDBX 格式 | 凭据存储若用 KeePassJava 需遵守其许可；更简单方案是 OS keychain（无格式依赖） |
| 逆向行为 | 本次评估为**被动静态分析 + 只读运行时观察**：未运行目标做恶意操作、未绕过许可、未提取密码、未修改文件——结论可用于架构参考，不构成对 TLP/CLUF 的法律意见 |

---

## 10. 结论

1. **技术可行性：高**。DataGrip 的核心架构（声明式驱动、双文件存储、classloader 隔离、LIMIT n+1 分页、三层索引、RMI 后端）全部有充分证据且均有成熟开源替代；无任何受保护的技术黑箱阻断复刻。
2. **工作量现实**：MVP 2–3 人月可覆盖 Doris/MySQL 日常主力场景（对你当前的 BI 数据源管理需求足够）；达到 DataGrip 80% 体验需 6–12 人月；完全对标是 2 人年工程。
3. **最高性价比动作**：P0 阶段直接吸收四个已验证设计（驱动声明 schema、shared/local 分离、凭据外置、n+1 分页）——这四个是 DataGrip 架构中**最廉价也最正确**的部分。
4. **剩余未知项不影响决策**：3 项数值型细节已决议为“自行定义”；渲染绘制级细节仅在自研高性能网格时才需要 Ghidra 补充。

---

### 附录：证据文件索引

- 静态：`plugins/DatabaseTools/lib/modules/*.jar`（databaseDrivers/*-drivers.xml、database-artifacts.xml、核心 class）、`product-info.json`、`datagrip64.exe`
- 配置：`%APPDATA%\JetBrains\DataGrip2026.2\options\{databaseDrivers,other,recentProjects}.xml`、`{c.kdbx,c.pwd}`、`jdbc-drivers\`
- 项目：`<project>/.idea/{dataSources.xml,dataSources.local.xml}`
- 日志：`%LOCALAPPDATA%\JetBrains\DataGrip2026.2\log\idea{,.1,.2}.log`、`database-log\database.0.log`
- 运行时：进程 PID 7192/6892、netstat（60491/58804/9030）、jstack（后端 44 线程 / IDE 7572 行）
- 详细证据：见 `SPEC.md`、`SPEC-sql-execution-grid.md`、`RUNTIME-FINDINGS.md`
