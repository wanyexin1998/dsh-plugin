# 专业 SQL IDE 的编辑手感模型 — 从仓库内 DataGrip 逆向材料提炼

> **任务**：task-5。为「手写 SQL 怎么才流畅」方案提供参照：从 `dsh-data-ide` 仓库已有的 DataGrip 逆向材料 + 交互规格里，提炼「专业 SQL IDE 的编辑手感模型」，并划清本项目「已实现 / 未实现 / 明确不做」的边界。
> **只读声明**：本报告只读取 `E:\dsh-plugin\dsh-data-ide` 内文件；唯一写入是本文 `E:\dsh-plugin\analysis\datagrip-handfeel.md`。仓库内任何文件均未修改。
> **引用约定**：`path:line` 相对 `E:\dsh-plugin\dsh-data-ide`。行号以 2026-10-26 本次读取结果为准。
> **证据等级**（全文每条都标注）：
> - **A = REA 材料 OBSERVED**：4 份逆向材料里的类名 / 字符串 / 配置 / 日志直接实证。
> - **B = REA 材料 INFERRED**：REA 作者由 A 推出的结论（材料自身标注 INFERRED）。
> - **C = 项目内对 DataGrip 的转述**：来源是用户桌面截图、JetBrains 官方文档或用户实测，不是本仓 4 份 REA 材料。**C 级不能当 A 级用。**
> - **D = 本项目实现事实**：代码 / `docs/07` / 人工 smoke（`docs/testing.md` S 编号）。
> - **E = UNKNOWN**：4 份 REA 材料与其余仓库材料都未覆盖，不许拿常识补。
>
> **四类成本定义**（下文统一使用）：
> - **记忆**：人需要记住的知识（表、列、方言、引号字符、大小写、语法）。
> - **表达**：把意图变成 SQL 的击键/结构成本（骨架、模板、生成、改写）。
> - **验证**：确认「对不对」的成本（静态检查、错误定位、结果比对、历史对照）。
> - **等待**：等库、等 UI 的时间（首页、COUNT、取数、渲染、翻页）。

---

## 0. 摘要（先看这 8 条）

1. **4 份 REA 材料只覆盖两条线：连接管理 + 执行/结果网格。编辑器手感（补全、格式化、重构、意图动作、快捷键、历史、对象导航）根本没有被采集**。材料自述「连接管理与执行网格两条线的架构机制 100% 有证据」（`docs/reference/COMPREHENSIVE-ASSESSMENT.md:44`），对编辑器只有一句难度评述（同文件 `:101`）。用户 2026-10-19 曾直接问「DataGrip 逆向分析里找不到补全吗」（`.workbuddy/memory/2026-10-19.md:23`）——本报告确认：**不是漏掉，是材料范围没有**。
2. 材料能支撑的手感骨架是：**信息前置（内省模型 / database-info / 方言 jar / 标识符规则）→ 语句级执行（拆语句、识别结果集子查询）→ 等待被切分（`LIMIT n+1`、独立 COUNT、execution/fetching 分段计时）→ 结果区可退可进（三层索引、排序过滤、查找、转置、导出、生成 SQL）→ 错误进结果区（输出 tab、异常识别链）**。
3. **「输入中」这一段是证据黑洞**：REA 对补全只有「PSI 全家桶（词法/解析/语义/补全/检查）」一个词（`docs/reference/COMPREHENSIVE-ASSESSMENT.md:101`），无触发方式、无候选排序、无模板、无格式化、无快捷键。凡把这些写成「DataGrip 就是这样」的，都是 C 级转述（`docs/03-UIUX-SPEC.md:30` 的 `sel/ins` 习惯、`:105` 的 Value Editor）。
4. **本项目比 REA 材料更完整的是「网格 + 对象树 + 编辑器内核」三件套**：CM6 已带来高亮/行号/折叠/Tab 缩进/`Ctrl+/`/查找替换/补全/撤销（`packages/client/ui-sql-workbench/src/client/editor-cm.ts:330-366`；`docs/testing.md:114-115`）。但仍缺：语法位置感知补全、静态检查、查询历史、console 持久化、SQL 格式化、结果内查找、列显隐、INSERT/JSON 导出、脚本级取消与快捷键绑定。
5. **规格与实现之间有 20 处落差**，其中 3 处是**文档漂移**（不是没做）：`docs/09-BACKLOG.md:86-93` 的 B10 仍写「脚本结果不显示漏斗」，但 2026-10-21 R6 已解锁（`docs/07-MILESTONES.md:182`、`docs/testing.md:129` S64）；`docs/07-MILESTONES.md:143` 的旧缺口「服务端筛选/定位到行」已过时；`docs/03-UIUX-SPEC.md:79-80` 同 B10 一起过期。
6. **手写 SQL 最卡的 4 个动作**：回头找昨天那条 SQL、刷新后草稿还在、跑之前知道写错了、把结果变成能复用的东西（INSERT/只看几列/在结果里搜值）。
7. **一处第一性原理级的差异**：DataGrip 的 **console 手写 SQL 不分页**（`docs/reference/RUNTIME-FINDINGS.md:218`），分页只属于数据编辑器；本项目对**所有**手写 SELECT 都包 `SELECT * FROM (…) t LIMIT/COUNT`（`AGENTS.md:83`、`src/execute/core.ts:180,361,366`）。这换来了 AC-2/AC-3 的确定性，代价是**改写用户 SQL + 等 COUNT**——讨论「手写流畅」时应把它摆到桌面上。
8. **能给方案用的最短清单**见 §5：10 个用户动作里现在 5 个顺畅、3 个半通、2 个卡住。

---

## 1. DataGrip 的 SQL 编辑手感模型（按「输入前 / 输入中 / 执行前 / 执行后」四阶段）

### 1.0 先说材料覆盖边界（否则会把 C 级当 A 级）

**材料自述的研究范围**：

| 事实 | 证据 |
|---|---|
| 4 份材料 = 连接管理（SPEC）+ 执行/网格（SPEC-sql）+ 运行时观察（RUNTIME-FINDINGS）+ 综合评估（ASSESSMENT） | `docs/reference/COMPREHENSIVE-ASSESSMENT.md:1-7` |
| 自述覆盖率：「连接管理与执行网格两条线的架构机制 100% 有 OBSERVED 或 INFERRED 证据」 | `docs/reference/COMPREHENSIVE-ASSESSMENT.md:44` |
| 方法限制：纯静态（REA 常量池）+ 只读运行时；**无反汇编**（Ghidra 未配置、objdump 不可用）→ 字节码级/交互级细节只能是 UNKNOWN | `docs/reference/COMPREHENSIVE-ASSESSMENT.md:30-36`；`.workbuddy/memory/2026-10-16.md:8` |
| 4 份材料「最大意外发现」四项均为后端/分页/凭据/Doris，无编辑器项 | `docs/reference/COMPREHENSIVE-ASSESSMENT.md:24` |
| 仓库证据地图列出的 9 条结论全部属于连接/驱动/分页/三层索引/复刻评估 | `docs/00-README.md:63-75` |
| 用户的疑问「DataGrip 逆向分析里找不到补全吗」 | `.workbuddy/memory/2026-10-19.md:23` |

**对 4 份 `docs/reference/*.md` 做关键词检索的结果**（本次实测）：

| 关键词 | 命中 | 结论 |
|---|---|---|
| `completion` / `补全` | 0 / 3 | 3 次全是「PSI 难度评述」，无交互机制（`COMPREHENSIVE-ASSESSMENT.md:101,148,158`） |
| `重构` / `refactor` / `意图` / `intention` | 0 | 编辑器重构/意图动作完全未采集 |
| `快捷键` / `shortcut` | 0 | 未采集 |
| `历史` / `history` | 2 / 0 | `历史` 仅指「历史日志文件」（`RUNTIME-FINDINGS.md:17,88`），非查询历史 |
| `导航` / `navigation` | 0 | 对象导航未采集 |
| `折叠` / `folding` / `多光标` / `multi-cursor` | 0 | 未采集 |
| `live template` / `片段` / `snippet` | 0 | 未采集 |
| `格式化` / `EXPLAIN` / `执行计划` | 1 / 0 / 0 | `格式化` 仅指网格值格式化（`SPEC-sql-execution-grid.md:127`），非 SQL 格式化 |
| `检查` / `inspection` | 4 / 0 | 唯一相关是 `COMPREHENSIVE-ASSESSMENT.md:101` 的「检查」一词 |

**结论**：§1 分两层写——① **A/B 级（REA 可证）**：执行/结果/信息前置类机制；② **C 级（项目内转述）**：截图、官方文档、用户实测看到的编辑器行为，单独标注，不冒充逆向结论。

---

### 1.1 输入前（我要写什么）

| # | 机制 | 证据（path:line） | 等级 | 降低的成本 |
|---|---|---|---|---|
| M1 | **数据源级「方言与标识符事实」缓存**：连接测试/内省结果写回 `database-info`（product / version / dbms / driver-version / exact-version）、`identifier-quote-string`（反引号）、`case-sensitivity`（`plain-identifiers="exact"`）、`extra-name-characters` | `docs/reference/RUNTIME-FINDINGS.md:55-61,68` | A（字段实证）；把用途接到「写 SQL 时的引号/大小写」是 INFERRED | **记忆**（引号字符、大小写规则不用人记） |
| M2 | **内省范围配置 + 本地模型缓存**：数据源上有 `introspectionLevel` / `schemaMapping`；项目侧写 `schema-mapping/introspection-scope`；模型缓存落 `data-source/<hash>/entities.dat*`（即 `<UUID>.xml`） | `docs/reference/SPEC.md:74`；`docs/reference/RUNTIME-FINDINGS.md:64,86`；`docs/reference/SPEC.md:52` | A（字段/文件实证）；「缓存供补全与导航使用」为 INFERRED | **记忆 + 等待**（知道库里有什么，且不必每次问库） |
| M3 | **每数据源 `codeStyleName`**：SQL 代码风格按数据源绑定 | `docs/reference/SPEC.md:74` | A（字段存在）；语义/用途材料未展开（**UNKNOWN**） | **记忆 / 表达**（推测：生成 SQL 时自动套该库风格） |
| M4 | **每 DBMS 独立 dialect jar**：解析器 / 高亮 / 类型系统 / Helper（约 50 个） | `docs/reference/COMPREHENSIVE-ASSESSMENT.md:100`；`docs/reference/SPEC.md:38` | A（jar 清单实证） | **记忆**（语法与类型规则随 DBMS 装好，不靠人记） |
| M5 | **编辑器工具条常驻执行上下文**：截图顶部有 `Tx 自动 ▾`、`Playground ▾`、`schema ▾`，与运行/取消/解释按钮同一行 | `.workbuddy/datagrip-now.png`（用户桌面 DataGrip 截图，1930×1042） | **C** | **记忆 + 等待**（事务模式/执行目标不用进两级菜单） |
| M6 | **对象树导航**：左侧「数据库资源管理器」目录树（doris.shcell.com → 库 → dwd/dws/ods_db/information_schema…；含「服务对象」「查询文件」「模拟视图」节点） | 同上截图；项目转述见 `docs/03-UIUX-SPEC.md:24`（来源为 JetBrains 官方 explorer 文档，见 `.workbuddy/memory/2026-10-19.md:119`） | **C**（REA 未覆盖） | **记忆**（表名不用背） |
| M7 | **查询历史 / 片段**：4 份材料 0 命中；项目文档里「执行历史按语句位置记」来自「行为 REA + 用户实测」的转述 | `docs/10-AGENT-CONSOLE-SPEC.md:4` | **C**（且 REA 无对应段落） | **记忆**（这条对 DataGrip 只能算待验证） |

**本阶段材料缺口**：DataGrip 让「我要写什么」变轻的核心机制——对象树、查询历史、最近打开、脚本文件标签——REA 全部没采集。截图只能证明「有树」，证明不了「树怎么影响写」。

---

### 1.2 输入中（怎么写出来）

| # | 机制 | 证据（path:line） | 等级 | 降低的成本 |
|---|---|---|---|---|
| M8 | **编辑器是一个独立模块**（`intellij.database.sql.impl.jar` → `com.intellij.sql.editor.*`），通过 `ConsoleDataRequest` 与执行层相接 | `docs/reference/SPEC-sql-execution-grid.md:12,24` | A | —（存在性） |
| M9 | **PSI 全家桶**：词法 / 解析 / 语义 / **补全** / **检查** | `docs/reference/COMPREHENSIVE-ASSESSMENT.md:101` | A（类/难度级评述）；具体交互（触发、排序、候选类型）**UNKNOWN** | **记忆**（补全）**+ 表达**（解析/高亮）**+ 验证**（检查） |
| M10 | **方言 jar 提供解析器 / 高亮 / 类型系统** → 高亮与类型感知按 DBMS 走 | `docs/reference/COMPREHENSIVE-ASSESSMENT.md:100` | A（jar 清单）；「高亮/类型感知的行为」INFERRED | **表达 + 验证** |
| M11 | **状态栏常驻输入上下文**：截图右下角显示 `289:1 (39 字符, 1 行 换行符) CRLF UTF-8 4 个空格`（行:列、字符数、换行符、编码、缩进宽度） | `.workbuddy/datagrip-now.png` | **C** | **验证**（光标位置/文件格式不用猜） |
| M12 | **SQL 格式化 / 重构 / 意图动作 / live template / 多光标 / 代码折叠 / 跳转 / 快捷键** | 4 份材料 grep 全 0（见 §1.0 表） | **E（UNKNOWN）** | — |
| M13 | 「DataGrip 的 `sel`/`ins` 习惯」「Value Editor `Shift+Enter`」「aggregator `Ctrl+Shift+C`」「`Ctrl+B` Go to DDL」等项目文档里的说法 | `docs/03-UIUX-SPEC.md:30,102,105,96` | **C**（来自 JetBrains 官方文档/用户习惯，非 REA；见 `.workbuddy/memory/2026-10-19.md:119,128`） | 只能作为「立项假设」，不能作为逆向结论 |

**本阶段结论（对方案最重要的一条）**：「专业 SQL IDE 写起来快」的**输入中机制在本仓库的材料里没有一行可引用证据**。任何以「DataGrip 补全/模板/格式化就是……」为依据的设计，都必须先承认这是外部常识或转述，而不是本仓 REA 结论。

---

### 1.3 执行前（对不对）

| # | 机制 | 证据（path:line） | 等级 | 降低的成本 |
|---|---|---|---|---|
| M14 | **按语句拆分**：`ConsoleDataRequest` 用 `ScriptModel$StatementIt` 把脚本拆成语句，执行单位是「语句」而非整块文本 | `docs/reference/SPEC-sql-execution-grid.md:25,143` | A | **表达 + 验证**（一条一条跑、一条一条看） |
| M15 | **识别「会返回结果集的子查询」**：`produceResultSet` / `getResultSetSubQueries`，产物 `ResultSetSubQuery{subQueryIndex, resultSetIndex}` | `docs/reference/SPEC-sql-execution-grid.md:26-27` | A（类/字段）；用途为 INFERRED | **验证 + 等待**（知道哪段会产生结果、不白跑/不白等） |
| M16 | **查询改写 / SQL 代码生成**：`WrapInSelectResult`、`SelectUsingKeys`（DML 生成器 `/script/generator/dml/*`） | `docs/reference/SPEC-sql-execution-grid.md:134`；`docs/reference/COMPREHENSIVE-ASSESSMENT.md:147` | A/B（名称与用途来自 REA，细节来自「前序 SPEC」引用） | **表达**（把一段查询/一行数据变成可执行 SQL） |
| M17 | **静态检查（inspections）**：PSI 的「检查」能力 | `docs/reference/COMPREHENSIVE-ASSESSMENT.md:101` | A（仅一个词）；检什么、报在哪 **UNKNOWN** | **验证**（跑之前发现问题） |
| M18 | **事务自动提交可按数据源配置**：真实 `dataSources.xml` 里 Oracle 源有 `<auto-commit>false</auto-commit>` | `docs/reference/RUNTIME-FINDINGS.md:47`；截图 `Tx 自动 ▾` 为 **C** | A（配置实证）/ C（UI 控件） | **记忆 + 验证**（不用每次显式写 BEGIN/COMMIT） |
| M19 | **执行计划 / EXPLAIN**：4 份材料 0 命中 | grep 结果见 §1.0 | **E（UNKNOWN）** | —（项目 B15 也未做） |

**本阶段结论**：REA 能证明的是「执行以语句为单位 + 会识别结果集子查询 + 会生成/改写 SQL」；**不能**证明「跑之前会做语法/语义检查并标在编辑器里」。截图右侧边缘有红/橙色标记条（`.workbuddy/datagrip-now.png`），含义在仓库材料里没有说明，**不得当作「DataGrip 会静态检查」的证据**。

---

### 1.4 执行后（结果验证）

| # | 机制 | 证据（path:line） | 等级 | 降低的成本 |
|---|---|---|---|---|
| M20 | **结果区 = 一组 tab**：固定「输出」tab + 每个结果集一个 tab；单语句复用当前 tab；多语句一次产出 N 个；标题 `首列名:类型`；「执行历史按语句位置记（重复执行更新同行、不追加）」 | `docs/10-AGENT-CONSOLE-SPEC.md:4,60-62,96`（项目文档自述「行为 REA + 用户实测」）；截图里可见多个 `console_N [数据源]` 标签与结果区底部「控制台 / 输出」 | **C**（REA 材料无对应段落） | **等待 + 验证**（新结果不覆盖旧结果；错误可追溯） |
| M21 | **分页取数 = `LIMIT pageSize+1` 探针 + 独立 `SELECT COUNT(*)` + OFFSET**（页大小默认 500） | `docs/reference/RUNTIME-FINDINGS.md:156-160`；`docs/reference/SPEC-sql-execution-grid.md:80-82` | A（日志里真实 SQL 三连） | **等待 + 验证**（首页不被 COUNT 拖死；总量可知） |
| M22 | **页大小可调**：`ChangePageSizeActionGroup` / `SetCustomPageSizeAction` / `CustomPageSizeForm`；属性键 `datagrip.default.page.size` 等 | `docs/reference/SPEC-sql-execution-grid.md:83,87-93,195` | A | **等待** |
| M23 | **console 手写 SQL 不分页**：分页只发生在数据编辑器；console 查询按原样执行 | `docs/reference/RUNTIME-FINDINGS.md:218,162` | A（作者明确写明） | **表达**（不改写用户 SQL）**+ 等待**（一次取结果，不来回翻页） |
| M24 | **execution / fetching 分段计时 + 语句级日志**（statement id、`results received`、`total result sets count`） | `docs/reference/RUNTIME-FINDINGS.md:150,161,180` | A | **验证**（慢在库还是慢在取数） |
| M25 | **DB 异常识别链**：`RemoteSeanceImpl.execute → JdbcIntermediateSeance → BaseExceptionRecognizer`；连接测试侧另有 `ErrorInfo`（含 Fix） | `docs/reference/RUNTIME-FINDINGS.md:140-145`；`docs/reference/SPEC.md:160-166` | A | **验证**（错误可分类、可给修复建议） |
| M26 | **大值保护**：`DataRequest.Constraints.maxLobLength` / `getBytesLimitPerValue`、`UnparsedValue`、LOB 落 `FileBlob/FileClob` | `docs/reference/SPEC-sql-execution-grid.md:59-60` | A | **等待 + 验证**（单个大字段不拖死页面；知道被截断） |
| M27 | **三层索引 Raw / Model / View + 排序/过滤模型**：排序筛选不改原始行身份 | `docs/reference/SPEC-sql-execution-grid.md:120-125` | A（类/索引名）；行为为 INFERRED（材料明示） | **验证**（结果可重排/可筛选且不丢行） |
| M28 | **网格内查找**：`MySearchRowFilter` | `docs/reference/SPEC-sql-execution-grid.md:117` | A | **验证** |
| M29 | **转置视图**：`MyTransposedViewColumnFilter`（含 `myWasAutomaticallyTransposed`） | `docs/reference/SPEC-sql-execution-grid.md:117` | A | **验证**（宽表换成行看） |
| M30 | **渲染/格式缓存**：单元格图像缓存（`database.grid.render.cache`、`.fast.scroll`）、列缓存、`database.grid.cache.factor`、`FormatsCache` | `docs/reference/SPEC-sql-execution-grid.md:101-106` | A | **等待**（滚动流畅） |
| M31 | **值格式化按列类型分发**：`FormatterImpl/CompositeFormatter/NumberFormatter/DateAndTimeFormatter/…` | `docs/reference/SPEC-sql-execution-grid.md:127` | A | **验证**（日期/数字/NULL 读得懂） |
| M32 | **结果 → SQL / 文件的回流**：导出器 112 类（`SqlInsertValuesExtractor`、`SqlUpdateValuesExtractor`、`DisplayHtmlValuesExtractor`、`WhereClauseExtractorFactory`…）+ `grid-loader-json/xls`；编辑回写经 `MutationsStorage` → `Insert/Update/DeleteRequest` → DML 生成器 | `docs/reference/SPEC-sql-execution-grid.md:133-135` | A（类清单）；「用户怎么触发」**UNKNOWN** | **表达**（把结果变成下一段 SQL / 文件） |
| M33 | **单元格编辑**：`GridTableCellEditor` / `GridCellEditorHelper` | `docs/reference/SPEC-sql-execution-grid.md:116` | A（类存在）；交互细节 **UNKNOWN** | **表达**（改数据不用写 UPDATE） |
| M34 | **选区与悬停**：`GridSelectionGrower`、`HoveredRowBgHighlightMode`、`PaintingSession` | `docs/reference/SPEC-sql-execution-grid.md:116-118` | A（类存在） | **验证**（少误选、看得清行） |

**本阶段结论**：这是 4 份材料**证据最厚**的一段——DataGrip 的「结果手感」几乎每条都有类名/日志支撑。但它回答的是「结果出来后怎么不难受」，不是「手写时怎么快」。

---

### 1.5 归纳：7 条手感公式（每条标明降什么成本）

> 说明：以下是从 §1.1–§1.4 的 A/C 级机制**归纳**出来的模型，不是材料原文；每条后标注证据强度。

| # | 手感公式 | 降低的成本 | 证据强度 |
|---|---|---|---|
| F1 | **先有模型，再动手**：连接/内省/方言/标识符规则/代码风格都在用户敲第一个字之前就位，编辑器可以直接"知道"这个库长什么样 | **记忆** | A（M1–M4 字段/文件实证）+ INFERRED（服务编辑器） |
| F2 | **写的时候有护栏**：PSI 级解析/语义/补全/检查按方言工作 | **记忆 + 表达 + 验证** | 仅存在性（M9/M10/M17）；**交互细节全 UNKNOWN** |
| F3 | **执行单位是语句，不是整块文本**：拆语句、识别结果集子查询、每语句一个结果 tab | **表达 + 验证** | A（M14/M15）+ C（M20 的 tab 行为） |
| F4 | **等待被切碎且可见**：n+1 首页、独立 COUNT、execution/fetching 分段计时、页大小随手改、渲染缓存 | **等待** | A（M21/M22/M24/M26/M30） |
| F5 | **结果永远可退可进**：排序筛选不改原始、结果内查找、转置、复制/导出/生成 SQL、单元格编辑 | **验证 + 表达** | A（M27–M33） |
| F6 | **错误在结果区，不在弹窗**：异常识别链 + 输出 tab 集中错误 | **验证** | A（M25）+ C（M20 输出 tab） |
| F7 | **状态常驻可见**：行:列/编码/换行/缩进、执行目标、事务模式常驻在状态栏与工具条 | **记忆 + 验证** | **C**（截图；REA 未采集） |

**这 7 条对手写 SQL 的权重**：F1/F3/F5/F6 是"少出错、少往返"；F4 是"少等"；F7 是"少猜"；**F2 才是"写得快"的主力，而它恰好是唯一只有存在性证据的一条**。方案若以"专业 IDE 手感"为参照，必须把 F2 的投入视为独立课题，不能从本仓材料里推。

---

### 1.6 四类成本由谁承担（小结）

| 成本 | DataGrip 材料可证的承担机制 | 本项目现状（D 级，详见 §2/§3） |
|---|---|---|
| **记忆** | M1–M4（信息前置）、M6（对象树，C）、M7（历史，C） | 信息前置部分已做（对象树/database-info/schema+补全）；历史未做 |
| **表达** | M14/M16（语句化 + 生成/改写）、M23（不改写 console SQL）、M32/M33（结果回流） | 语句化已做；生成/改写只做了补全与模板；**结果回流只到 CSV/TSV/XLSX**；且所有 SELECT 都被分页包裹（与 M23 反向） |
| **验证** | M17（检查）、M20/M24/M25/M27–M31/M34（结果与错误的可读性） | 结果侧做得较全（排序/筛选/聚合/值查看/输出 tab）；**检查 = 0**，错误无行号 |
| **等待** | M2（本地模型）、M21/M22/M26/M30 | n+1+COUNT+超时降级+窗口化+大值截断都已做；COUNT 仍是被用户感知过的痛点 |

---

## 2. 三栏表：规格应有 / 已实现 / 明确不做

> 口径：**「规格应有」= `docs/03-UIUX-SPEC.md`（交互规格）+ `docs/01-PRD.md`（R2/R3/N 表）**；**「已实现」= 代码 + `docs/07` 已交付记录 + `docs/testing.md` 人工 smoke（S 编号）**；**「明确不做」= `AGENTS.md` §7 + `docs/01-PRD.md` §5（N1–N7）+ `docs/09-BACKLOG.md` §4**。三栏里出现「—」表示该类没有对应项。

### 2.1 输入前

| 规格应有（03/01 交互项；出处） | 已实现（证据） | 明确不做（出处） |
|---|---|---|
| **对象树**：数据源 → 库/Schema → 表/视图两个分组 → 对象 → 列；筛选自动展开；单击插入光标处、双击打开数据（`docs/03-UIUX-SPEC.md:24`） | ✅ 已实现（`docs/07-MILESTONES.md:140` 批次 4；`SchemaTree.tsx:196-201`；`docs/testing.md:85-90` S28/S30/S32） | 树里的 **Keys / Indexes / Triggers / Server Objects**（`docs/03-UIUX-SPEC.md:27`；`docs/01-PRD.md:75` N2；`docs/09-BACKLOG.md:128` B16） |
| **对象右键 5 动作**：打开数据 / 插入名称 / 复制引用 / 查看 DDL / 刷新（`docs/03-UIUX-SPEC.md:25`） | ✅ 已实现（`SchemaTree.tsx:163-169`；`docs/testing.md:86` S29、`:120` S55、`:122-123` S57/S58） | **Jump to Query Console 的独立 console 分派、DDL 差异比较**（`docs/03-UIUX-SPEC.md:27`） |
| **菜单上的快捷键提示** F4 / Enter / Ctrl+B（`docs/03-UIUX-SPEC.md:25`；`docs/testing.md:86` S29 以「(F4)(Enter)(Ctrl+B)」验收） | ⚠️ 只有菜单文案 hint，**没有键盘绑定**（`SchemaTree.tsx:164-167` 仅 `hint` 字段；树内 `keydown` 只处理 Esc，`SchemaTree.tsx:134-138`） | —（未实现，见 §3） |
| **三面板工作区**：对象树左 / 编辑上下 / 结果；8px sash 拖拽、方向键微调、双击复位、收起不占位、布局持久化（`docs/03-UIUX-SPEC.md:12-17`） | ✅ 已实现（`docs/07-MILESTONES.md:195-201`；`docs/testing.md:101-106` S40-S45、`:132-133` S67/S68；09 B3 已完成移除） | **对话分屏 / per-pane 右栏**（`AGENTS.md:123`；`docs/08-RISKS.md:12`） |
| **DDL 落点**：右键查看 DDL 新开 `ddl_<表名>` console 标签，可编辑/复制/再执行（`docs/03-UIUX-SPEC.md:96`） | ✅ 已实现（`docs/07-MILESTONES.md:163`；`docs/testing.md:123` S58） | — |
| **工作台入口**：`Ctrl/⌘+Shift+L` 打开或聚焦（`docs/07-MILESTONES.md:207`） | ✅ 已实现（`entry.ts:45-52`；`docs/testing.md:131` S66） | — |
| **复制连接**（`docs/07-MILESTONES.md:54` 标为未做） | ❌ 未做（`docs/09-BACKLOG.md:126` B14） | — |
| **查询历史**：每连接最近 N 条（默认 200），SQL/状态/耗时/行数/时间（`docs/01-PRD.md:60`） | ❌ 未做（`docs/07-MILESTONES.md:67` M2-6；`docs/09-BACKLOG.md:41-48` B5） | — |
| **console 内容持久化**：刷新后 tab/SQL/活动 tab/页大小回来（`docs/09-BACKLOG.md:32-39` B4） | ❌ 未做（`docs/09-BACKLOG.md:36`；`.workbuddy/memory/2026-10-19.md:158`） | — |

### 2.2 输入中

| 规格应有（03 交互项；出处） | 已实现（证据） | 明确不做（出处） |
|---|---|---|
| **编辑器自带**：行号/当前行/括号匹配/折叠、多光标、`Ctrl+/` 注释、`Tab` 缩进、`Ctrl+F` 查找替换、`Ctrl+Space` 补全、撤销栈（`docs/03-UIUX-SPEC.md:28`） | ✅ 大部分已实现：行号/当前行/括号匹配/折叠/`Tab`/`Ctrl+/`/查找替换/补全/撤销（`editor-cm.ts:330-366`；`docs/testing.md:114-115` S51/S52、`:113` S50）；⚠️ **多光标未启用**：扩展表未设 `EditorState.allowMultipleSelections`（`editor-cm.ts:330-366`，而 CM6 该 facet 默认关闭）→ 标称能力悬空 | — |
| **补全**：`@codemirror/lang-sql` 提供表/列/别名（`docs/03-UIUX-SPEC.md:29`） | ✅ 已实现（`editor-cm.ts:65-82,244-257`；`docs/testing.md:75-79` S20-S24、`:111-112` S48） | **语法位置感知**（`FROM` 后只给表、`WHERE` 后只给列并做别名解析）、**关键字大小写跟随设置**（`docs/03-UIUX-SPEC.md:31`；`docs/01-PRD.md:77` N4；`docs/07-MILESTONES.md:223`） |
| **补全排序 + live templates**：约 45 个高频词 boost，`sel/selc/selw/selagg/ins/upd/del/jo/lj/gb/ob/lim` 两字符起（`docs/03-UIUX-SPEC.md:30`） | ✅ 已实现（`completion-rank.ts:25-129`；`docs/testing.md:130` S65；`editor-cm.ts:266-283`） | — |
| **补全弹窗类型标签中文化**（`docs/09-BACKLOG.md:77-84` B9） | ❌ 未做（`docs/07-MILESTONES.md:237`：仍是 `keyword/table/column` 英文） | — |
| **中文界面**：`EditorState.phrases` 覆盖查找/替换等英文串（`docs/03-UIUX-SPEC.md:34`） | ✅ 已实现（`editor-cm.ts:90-108`；`docs/testing.md:113` S50） | — |
| **窄面板降级**：<460px 隐藏替换控件（`docs/03-UIUX-SPEC.md:34`、`:22`） | ✅ 已实现（`components/sqlWorkbench.css:1298`；`docs/testing.md:113` S50） | — |
| **多 SQL tab（console_N）**：每 tab 绑连接与颜色（`docs/03-UIUX-SPEC.md:21`；`docs/07-MILESTONES.md:139` 批次 3） | ✅ 已实现（`docs/testing.md:80-82` S25-S27、`:90` S33、`:107` S46） | — |
| **SQL 格式化**（`docs/07-MILESTONES.md:63` 未做清单里的历史项） | ❌ 未做，**且 03 没有这条交互、09 没有对应待办**（悬空，见 §3） | — |
| **保存脚本**：`Ctrl/Cmd+S` 保存 `.sql`（`docs/03-UIUX-SPEC.md:228`；`docs/01-PRD.md:50`） | ❌ 未做（M3 整段未做：`docs/07-MILESTONES.md:251-253`；`AGENTS.md:113` AC-4 未验收） | **git 脚本目录/面板本轮不做**（`docs/07-MILESTONES.md:251-253`） |
| **git 面板**：`Ctrl/Cmd+Shift+G`（`docs/03-UIUX-SPEC.md:228`、`:187-196`） | ❌ 未做（同上） | 同上（本轮） |
| **编辑器错误态**：错误行高亮 + hint（`docs/03-UIUX-SPEC.md:213` 交互状态矩阵） | ❌ 未实现：错误只有 `{code,message}`（`ScriptResults.tsx:15`），编辑器无 diagnostics/lint 扩展（`editor-cm.ts:330-366`） | — |

### 2.3 执行前

| 规格应有（03/01 交互项；出处） | 已实现（证据） | 明确不做（出处） |
|---|---|---|
| **执行**：`Ctrl/Cmd+Enter`；有选中只跑选段（`docs/03-UIUX-SPEC.md:33,23`） | ✅ 已实现（`editor-cm.ts:320-324`；`docs/testing.md:112` S49） | — |
| **取消**：`Esc` / 取消按钮，补全弹窗打开时先关弹窗（`docs/03-UIUX-SPEC.md:33`） | ✅ 单语句已实现（`docs/testing.md:72` S17；`cancel_statement`）；❌ 脚本执行取消未做（`docs/07-MILESTONES.md:244` P2：多语句无 statementId 回传） | — |
| **多语句**：一条脚本跑完，每语句一个结果标签；有选中只跑选段；遇错即停（`docs/03-UIUX-SPEC.md:23`） | ✅ 已实现（`docs/10-AGENT-CONSOLE-SPEC.md:61`；`docs/testing.md:129` S64） | — |
| **只读门禁**：默认只允许 SELECT，写操作需 `writeEnabled`，DDL 黑名单（`AGENTS.md:87`、`:115` AC-6） | ✅ 已实现（`docs/07-MILESTONES.md:68`；`docs/testing.md:71` S16） | **事务 / 会话管理**（`AGENTS.md:123`；`docs/09-BACKLOG.md:138`） |
| **审计日志**：执行入口统一记时间/连接/语句摘要/是否放行/耗时（`docs/09-BACKLOG.md:113-120` B13；`docs/07-MILESTONES.md:68`） | ❌ 未做（`docs/07-MILESTONES.md:68`） | — |
| **错误定位**：语句级错误定位（行号）（`docs/01-PRD.md:49`） | ❌ 未做：错误对象只有 code/message，无行号（`ScriptResults.tsx:15`） | — |
| **服务端分页**：首页 `pageSize+1` 探针 + 独立 COUNT + OFFSET；页大小默认 500、上限 5000；COUNT 缓存（`AGENTS.md:83`、`:111-112` AC-2/3） | ✅ 已实现（`src/execute/core.ts:180,194,361,366`；`docs/testing.md:67-70` S12-S15） | — |
| **元数据语句 raw 模式**：`SHOW`/`DDL`/`DESCRIBE` 不被分页包裹（`.workbuddy/memory/2026-10-19.md:121`） | ✅ 已实现（`src/execute/core.ts:90,353-356`） | — |
| **EXPLAIN / 执行计划视图**（`docs/09-BACKLOG.md:127` B15） | ❌ 未做 | — |
| **查询历史**：见 2.1 | ❌ 未做 | — |

### 2.4 执行后

| 规格应有（03/01/10 交互项；出处） | 已实现（证据） | 明确不做（出处） |
|---|---|---|
| **结果区一组 tab**：固定「输出」tab + 每语句结果 tab；标题 `首列名:类型`（重名 ` (2)`）；错误同时在失败 tab 与输出 tab（`docs/03-UIUX-SPEC.md:23`；`docs/10-AGENT-CONSOLE-SPEC.md:60-62,96`） | ✅ 已实现（`docs/10-AGENT-CONSOLE-SPEC.md:319-325` §14；`docs/07-MILESTONES.md:183`；`docs/testing.md:129` S64） | — |
| **每个结果 tab 独立状态**：`sort/filters/pageSize/total` 按 tab 存（`docs/10-AGENT-CONSOLE-SPEC.md:64`） | ✅ 已实现（`docs/07-MILESTONES.md:182`；`docs/testing.md:129` S64） | — |
| **分页条**：首页/上页/页码/下页/末页 + 页大小菜单（100/500/1000/5000/自定义）+ COUNT「总数未知」降级（`docs/03-UIUX-SPEC.md:224`） | ✅ 已实现（`docs/testing.md:67-70` S12-S15） | — |
| **服务端排序**：列头 无→ASC→DESC，回第 1 页（`docs/03-UIUX-SPEC.md:223`） | ✅ 已实现（`docs/testing.md:70` S15、`:81` S18） | — |
| **服务端字段筛选**：10 个操作符，进 WHERE 与 COUNT；筛到 0 行仍显示工具条（`docs/03-UIUX-SPEC.md:62-81`） | ✅ 已实现（`docs/07-MILESTONES.md:165`；`docs/testing.md:126-128` S61-S63） | — |
| **类型化格式化**：NULL 弱文本、日期 ISO、数字千分位右对齐、布尔、二进制 hex（`docs/03-UIUX-SPEC.md:225`） | ✅ 已实现（`format.ts:31,64,88,127`） | — |
| **列宽拖拽**（`docs/03-UIUX-SPEC.md:222`） | ✅ 已实现（`ResultGrid.tsx:112,226-229`；`docs/07-MILESTONES.md:138`） | — |
| **列宽「存连接级布局」**（`docs/03-UIUX-SPEC.md:222`） | ❌ 未实现：列宽只存组件 state，不持久化（`ResultGrid.tsx:112`） | — |
| **列显隐 + Reset**（`docs/09-BACKLOG.md:59-66` B7） | ❌ 未做 | — |
| **结果区查找**：`Ctrl+F` 在网格聚焦时打开，命中高亮、上下跳、「仅当前页」（`docs/09-BACKLOG.md:50-57` B6） | ❌ 未做（`Ctrl+F` 目前只作用于 CodeMirror） | — |
| **复制**：选中单元格/区域/整列 → TSV 或 CSV；表头可选（`docs/03-UIUX-SPEC.md:226`） | ✅ 矩形选区复制 TSV + `Ctrl+C`（`docs/testing.md:96` S37）；⚠️「表头可选」未实现（`grid.ts:71,102` 无该开关） | — |
| **导出**：CSV / TSV / XLSX（`docs/07-MILESTONES.md:138` 批次 2） | ✅ 已实现（`ResultGrid.tsx:93,244-255`） | **导出 INSERT / JSON**：未做（`docs/09-BACKLOG.md:68-75` B8）；**图表 / Geo / Compare / Copy to Database** 明确不做（`docs/09-BACKLOG.md:142`） |
| **状态栏聚合器**：SUM/AVG/MIN/MAX/COUNT/DISTINCT，`Ctrl+Shift+C` 复制汇总值（`docs/03-UIUX-SPEC.md:102`） | ✅ 已实现（`docs/testing.md:95-96` S36/S37） | — |
| **值查看器**：双击 / `Shift+Enter`，完整值/字符数/列名/行号，JSON 美化，`Esc` 关闭（`docs/03-UIUX-SPEC.md:105`） | ✅ 已实现，但只读（`docs/testing.md:97` S38；`docs/07-MILESTONES.md:245` P3） | — |
| **窗口化渲染**：>200 行只把一屏 + overscan 放 DOM（`docs/03-UIUX-SPEC.md:104`） | ✅ 已实现（`docs/testing.md:93-94` S34/S35） | **虚拟滚动**：有意偏离，不做（`docs/03-UIUX-SPEC.md:104`；`docs/07-MILESTONES.md:171`） |
| **网格查找 / 转置 / View as**（`docs/09-BACKLOG.md:129` B17） | ❌ 未做 | — |
| **编码显示**（`docs/03-UIUX-SPEC.md:102-103`） | ✅ 已实现 `document.characterSet` | **冒充连接 charset 不做**（`docs/03-UIUX-SPEC.md:103`） |
| **错误提示**：右下角 notice、不阻塞、可关闭（`docs/03-UIUX-SPEC.md:37-60`） | ✅ 已实现（`docs/testing.md:122` S57、`:125` S60） | — |
| **剪贴板三级策略**（`docs/03-UIUX-SPEC.md:82-92`） | ✅ 已实现（`docs/testing.md:125` S60） | — |
| **大值保护**：单单元格 1MB、预览 32KB、超限标记（`docs/01-PRD.md:58`） | ✅ 已实现（`docs/testing.md:74` S19） | — |
| **结果刷新**：单语句重跑 / 脚本重取当前页（`docs/07-MILESTONES.md:64`） | ✅ 已实现（`ScriptResults.tsx:61,190-194`；`ResultGrid.tsx:289`） | — |
| **单元格编辑回写**（`docs/01-PRD.md:74` N1；`docs/09-BACKLOG.md:137`） | — | ❌ **明确不做**（`docs/09-BACKLOG.md:137`；`AGENTS.md:123`） |
| **多结果集（`CALL` 多结果）**（`docs/09-BACKLOG.md:141`） | — | ❌ **明确不做**（同上） |
| **图表 / Geo Viewer / Compare Data / Copy to Database**（`docs/09-BACKLOG.md:142`） | — | ❌ **明确不做** |
| **SSH / SSL 隧道**（`docs/01-PRD.md:76` N3；`docs/09-BACKLOG.md:139`） | — | ❌ **明确不做** |
| **Oracle 连接与 Java 桥**（`docs/01-PRD.md:80` N7） | — | ❌ **明确不做（降级 P1）**（`AGENTS.md:123`） |

---

## 3. 规格 / 待办写了、实现没跟上的交互

> 排序：按对「手写 SQL 手感」的影响从大到小。`性质` 列区分 **未做**（真差距）、**漂移**（实现已超规格/待办，文档没跟上）、**悬空**（规格声称但代码无对应能力）。

| # | 交互 | 规格/待办出处 | 现状（证据） | 性质 |
|---|---|---|---|---|
| G1 | **刷新页面后 console 全丢**（tab 标题/SQL/活动 tab/页大小） | `docs/09-BACKLOG.md:32-39` B4；成因 `docs/09-BACKLOG.md:36` | 纯客户端 state，宿主无持久化；`.workbuddy/memory/2026-10-19.md:158`「刷新页面丢全部 console SQL」 | 未做（P1） |
| G2 | **查询历史**（每连接 200 条、成功/失败都记、点击插入） | `docs/01-PRD.md:60`；`docs/09-BACKLOG.md:41-48` B5 | `docs/07-MILESTONES.md:67` M2-6 未做；仅 `mcp-tools`/`binding.ts` 预留了 `history` 文档名（`docs/09-BACKLOG.md:45`） | 未做（P1） |
| G3 | **跑之前知道写错了**（静态检查 / 错误行高亮 / 行号定位） | `docs/03-UIUX-SPEC.md:213`；`docs/01-PRD.md:49` | 无 lint/diagnostics 扩展（`editor-cm.ts:330-366`）；错误只有 `{code,message}`（`ScriptResults.tsx:15`） | 未做（且无待办项） |
| G4 | **结果区查找**（`Ctrl+F` 在网格） | `docs/09-BACKLOG.md:50-57` B6 | `Ctrl+F` 仅 CodeMirror（`editor-cm.ts:341`） | 未做（P1） |
| G5 | **列显隐 + Reset**（宽表只看几列） | `docs/09-BACKLOG.md:59-66` B7 | 只有列宽拖拽（`ResultGrid.tsx:112`） | 未做（P1） |
| G6 | **导出 INSERT / JSON**（把结果变成可复用 SQL/数据） | `docs/09-BACKLOG.md:68-75` B8 | 只有 CSV/TSV/XLSX（`ResultGrid.tsx:93,244-255`） | 未做（P1） |
| G7 | **脚本级取消**（多语句跑到一半能停） | `docs/07-MILESTONES.md:244` P2 | 单语句可取消；脚本无 statementId 回传 | 未做（已知尾巴） |
| G8 | **保存脚本 `Ctrl+S` / git 面板 `Ctrl+Shift+G`** | `docs/03-UIUX-SPEC.md:228`、`:187-196`；`docs/01-PRD.md:50` | M3 整段未做（`docs/07-MILESTONES.md:251-253`）；AC-4 未验收（`AGENTS.md:113`） | 未做（本轮不做） |
| G9 | **SQL 格式化** | 仅 `docs/07-MILESTONES.md:63`（M2-2 未做清单） | 无实现；03 没这条交互、09 没有 B 项 | **悬空**（规格/待办都没有着落） |
| G10 | **多光标** | `docs/03-UIUX-SPEC.md:28` 列为「自带」 | 扩展表无 `EditorState.allowMultipleSelections`（`editor-cm.ts:330-366`）；CM6 该 facet 默认关 | **悬空**（标称能力未启用，未验证） |
| G11 | **对象树快捷键 F4 / Enter / Ctrl+B** | `docs/03-UIUX-SPEC.md:25`；`docs/testing.md:86` S29 以「(F4)...(Ctrl+B)」验收 | 只有菜单 hint 字段（`SchemaTree.tsx:164-167`），无 keydown 绑定（`SchemaTree.tsx:134-138` 只处理 Esc） | **悬空**（验收文案把 hint 当快捷键） |
| G12 | **列宽存连接级布局** | `docs/03-UIUX-SPEC.md:222` | 列宽只存组件 state（`ResultGrid.tsx:112`） | 未做（无待办） |
| G13 | **复制「表头可选」** | `docs/03-UIUX-SPEC.md:226` | `selectionToTsv` 无表头开关（`grid.ts:71,102`） | 未做（无待办） |
| G14 | **补全类型标签中文化** | `docs/09-BACKLOG.md:77-84` B9 | 仍是英文（`docs/07-MILESTONES.md:237`） | 未做（P2） |
| G15 | **跳转行** | `docs/07-MILESTONES.md:143` 旧缺口；03 未写 | CM6 `searchKeymap` 自带 `Mod-Alt-g`（`editor-cm.ts:356`；`node_modules/@codemirror/search` 的 keymap）；材料未记录 DataGrip 用哪个键，**本项目未登记、无 smoke** | 部分实现/未登记 |
| G16 | **`docs/09-BACKLOG.md:86-93` B10「脚本结果不显示漏斗」** | 09 B10；`docs/03-UIUX-SPEC.md:79-80` 同口径 | **已实现**：R6 把 `sort/filters/pageSize/total` 下沉到每个 `ScriptTab`（`docs/07-MILESTONES.md:182`；`docs/10-AGENT-CONSOLE-SPEC.md:325`；`docs/testing.md:129` S64） | **漂移（文档落后实现）** |
| G17 | **`docs/07-MILESTONES.md:143`「已知缺口：编辑器折叠 / 服务端筛选 / 定位到行」** | 07 §7 批次 1–5 段 | CM6 已带来折叠（`editor-cm.ts:336,358`；`docs/testing.md:115` S52）；服务端筛选 2026-10-20 落地（`docs/07-MILESTONES.md:165`） | **漂移（历史段落未更新）** |
| G18 | **`docs/07-MILESTONES.md:63` M2-2 未做清单**（折叠/查找替换/注释缩进/多光标/跳转行/SQL 格式化/保存脚本） | 07 M2-2 | CM6 已覆盖折叠/查找替换/注释/缩进（`editor-cm.ts:330-366`；S50-S52），清单未标已解决；剩下的格式化/保存脚本仍缺 | **漂移 + 未做混合** |
| G19 | **错误态「错误行高亮」** | `docs/03-UIUX-SPEC.md:213` | 无编辑器 diagnostics；见 G3 | 未做 |
| G20 | **查询历史/审计写入**（宿主单写者 vs MCP 无状态） | `docs/07-MILESTONES.md:62` 注「审计位与历史未接」 | 仅留 spool/预留名；B5/B13 未做 | 未做 |

**漂移的根因（可复用教训）**：`docs/00-README.md:4` 要求「代码与文档不得长期分叉」，但 09/03/07 是三个不同时间点写的：09 停在 2026-10-20 收尾盘点（`docs/09-BACKLOG.md:6`），07 的 §7 是逐批追加，03 的 §6.10 也是旧口径。**任何下游方案若以 09 为唯一事实源，会误判「脚本级筛选不可用」**——实际已可用。

---

## 4. 用户已表达过的偏好 / 痛点（原话/结论 + 来源）

### 4.1 偏好（P）

| # | 偏好 / 原话 | 来源 | 对设计的含义 |
|---|---|---|---|
| P1 | 以 DataGrip 为手感基准：「用户按 DataGrip 截图排的批次」；「用户拿 DataGrip 截图问差距，选定先做『多语句 + 结果标签』」 | `docs/07-MILESTONES.md:133`；`.workbuddy/memory/2026-10-19.md:70` | 差距要按「看得见的行为」逐项对齐，而不是按功能名 |
| P2 | 「先看逆向分析，能复用就复用」；同时追问「DataGrip 逆向分析里找不到补全吗」 | `.workbuddy/memory/2026-10-19.md:39,23` | 用户默认以为 REA 材料覆盖编辑器——**这是本报告要纠正的预期**（§1.0） |
| P3 | 对「手感」的具体不满：「补全缺表列 / 下拉跟光标 / 高亮太淡 / 编辑区与结果可拖拽 / 对象树」 | `.workbuddy/memory/2026-10-19.md:39` | 手感是逐点可见的（位置、对比度、可拖拽），不是笼统的「智能」 |
| P4 | 「打 S 不出 select」（补全排序） | `.workbuddy/memory/2026-10-21.md:112`；`docs/07-MILESTONES.md:209` | 候选顺序＝手感；已用 boost + live templates 修（`completion-rank.ts:25-129`） |
| P5 | 「多语句没生效」 | `.workbuddy/memory/2026-10-19.md:74` | 用户用「现象」验收；功能做了但进程没重启＝没做 |
| P6 | 「console 的 tab 应该跟编辑区在一起」 | `.workbuddy/memory/2026-10-19.md:147`；`docs/03-UIUX-SPEC.md:21` | 面板归属感（tab 在编辑器上）是手感的一部分 |
| P7 | 「DDL 别弹小窗，直接放编辑区；报错放右下角小窗；查询区工具栏没做」 | `.workbuddy/memory/2026-10-20.md:26`；`docs/03-UIUX-SPEC.md:96-98` | 输出去向（编辑区 vs 弹窗）比功能本身更影响连续感 |
| P8 | agent「不抢焦点」；未读角标点 + 轻 toast（Q14 用户选 A） | `docs/10-AGENT-CONSOLE-SPEC.md:27,86-91`；`.workbuddy/memory/2026-10-20.md:90` | 后台协作者不能打断人的输入流 |
| P9 | 右栏只有 ~497px，窄面板必须可读：「dsh 右栏实测只有 497px」 | `.workbuddy/memory/2026-10-19.md:142`；`docs/03-UIUX-SPEC.md:15,22` | 任何「抄桌面 IDE」的方案必须先过窄面板这一关 |
| P10 | 结果区「一组 tab」的心智（Q10 全面 tab 化，用户逐项选 A） | `docs/10-AGENT-CONSOLE-SPEC.md:23,60-62`；`.workbuddy/memory/2026-10-20.md:82-86` | 结果不是「一个网格」，是「一组可切换的视图」 |
| P11 | 「先加固查询区、前端交互优化、性能优化」 | `.workbuddy/memory/2026-10-19.md:86` | 优先级：稳定性/性能先于新功能 |
| P12 | 追问「CodeMirror/Monaco 是什么，为什么没放进建议」 | `.workbuddy/memory/2026-10-19.md:166` | 用户要的是「选项 + 代价 + 触发条件」，不是被隐藏的判断 |
| P13 | 「还有哪些功能没做完」的盘点发现里程碑失真 | `.workbuddy/memory/2026-10-19.md:154` | 用户会拿文档当事实核对；文档漂移会直接损害信任（见 §3 G16–G18） |

### 4.2 痛点 / 卡点（X）

| # | 痛点 | 证据 | 影响的手写动作 |
|---|---|---|---|
| X1 | 刷新就丢工作（「误刷新就丢工作（用户已明确提过）」） | `docs/09-BACKLOG.md:38` | 写长脚本不敢刷新/不敢切走 |
| X2 | 昨天跑过的 SQL 找不回来 | `docs/09-BACKLOG.md:45` | 重复劳动；验证断档 |
| X3 | 500 行结果里找一个值只能靠肉眼 | `docs/09-BACKLOG.md:54` | 结果验证慢 |
| X4 | 宽表（100+ 列）要一直横向滚 | `docs/09-BACKLOG.md:62` | 看结果慢 |
| X5 | 结果拿出去造数据/喂系统不方便（无 INSERT/JSON） | `docs/09-BACKLOG.md:73` | 结果→下一段 SQL 的回路断 |
| X6 | 补全无作用域：`FROM` 后仍给关键字、无别名解析、大小写不跟随 | `docs/03-UIUX-SPEC.md:31`；`docs/07-MILESTONES.md:246` P4 | 写得快只到「前缀命中」，到不了「上下文命中」 |
| X7 | 首页曾被 COUNT 拖住（「卡」）→ 已改超时降级 | `.workbuddy/memory/2026-10-19.md:92-94`；`docs/07-MILESTONES.md:65` | 等待成本；用户对"慢"极敏感 |
| X8 | 编辑器在 444px 高右栏里被工具条+状态栏挤成 0（真机才暴露） | `.workbuddy/memory/2026-10-19.md:131`；`docs/03-UIUX-SPEC.md:106` | 布局即手感；jsdom 全绿不等于真机可用 |
| X9 | 「按钮消失」实为 flex 溢出（缺 `min-width:0`） | `.workbuddy/memory/2026-10-20.md:53-54` | 窄面板下工具栏必须可收缩 |
| X10 | 切标签/切连接时 SQL 与结果串到别的 console（真 bug） | `.workbuddy/memory/2026-10-19.md:107-111` | 「我现在在哪个上下文」的信任成本 |
| X11 | 改完看不到效果，常因旧进程/旧构建 | `.workbuddy/memory/2026-10-19.md:74` | 验证反馈的噪音成本（开发/验收层面） |
| X12 | CM6 带来的工程代价：测试 ~17s→~2m15s、bundle 176KB→539KB | `docs/08-RISKS.md:24-25`；`docs/07-MILESTONES.md:235-236`；`docs/09-BACKLOG.md:95-111` | 手感升级的可持续性（不是 UI 手感，但会拖慢每次迭代） |

### 4.3 这 13 条偏好 + 12 条痛点对方案的 5 条硬含义

1. **用户要的是「可见的连续感」**：tab 在编辑区上（P6）、DDL 进编辑区（P7）、结果 tab 不覆盖（P10）、agent 不抢焦点（P8）——共同点是「我的上下文不被夺走」。
2. **最容易换来好感的三件事是「不丢、可找、可留」**：console 持久化（X1/G1）、查询历史（X2/G2）、结果可复用（X5/G6）。这三项都不需要解析器，成本小，属于第一性原理上的低垂果实。
3. **补全的「有没有」已经解决，「准不准」才刚开始**：P3/P4 已闭环；X6（无作用域）是下一个台阶，但 01 N4/07:223 明确不做解析器 → **方案要么接受「前缀+模板」的上限，要么单独立项**，不能含糊。
4. **窄面板是硬约束**（P9/X8/X9）：任何从 DataGrip 抄来的布局/工具栏/状态栏都要按 ~500px 宽重算，否则抄得越像越难用。
5. **文档漂移会破坏信任**（P13/G16–G18）：改动前先把 09/03/07 的口径对齐，否则方案会建立在「脚本筛选不可用」这类错误事实上。

---

## 5. 结论：「专业 SQL 手写」最短 10 个动作（用户动作，不是功能名）

> 判定标准：**顺畅** = 有实现且有真机/smoke 证据；**半通** = 有实现但缺一环；**卡住** = 无实现或实现不可用。证据列只给最直接的一条。

| # | 用户动作（不是功能名） | 状态 | 现在靠什么做到 / 卡在哪（证据） |
|---|---|---|---|
| A1 | **扫一眼库表，把要查的对象点进编辑器**（而不是凭记忆敲表名） | ✅ 顺畅 | 对象树层级 + 单击插入 + 双击打开数据（`SchemaTree.tsx:196-201`；`docs/testing.md:85-90` S28/S30/S32）；DSH 右栏窄但仍可用 499/500px 布局（S45） |
| A2 | **敲两个字母就拿到语句骨架**（`sel` → `SELECT * FROM `） | ✅ 顺畅 | live templates + 高频词 boost（`completion-rank.ts:25-129`；`editor-cm.ts:266-283`；`docs/testing.md:130` S65） |
| A3 | **列名不用背，补全给表/列/别名** | 🟡 半通 | `@codemirror/lang-sql` + schema namespace（`editor-cm.ts:65-82`；S20-S24/S48）；但无作用域/别名解析/大小写跟随（`docs/03-UIUX-SPEC.md:31`；X6） |
| A4 | **只跑选中的那一条语句**（不被整脚本拖着跑） | ✅ 顺畅 | 有选中只跑选段（`docs/03-UIUX-SPEC.md:23`；`docs/testing.md:112` S49） |
| A5 | **改一个条件，只重跑改过的那条**（而不是整脚本从头跑） | 🟡 半通 | 选中执行（A4）+ 结果区单语句「刷新」可重跑（`ScriptResults.tsx:190-194`）；但改 SQL 后要重新选中，脚本级没有「只重跑第 N 条且保留其他结果」的动作；服务端筛选可替代「只看子集」，但它仍会重查 COUNT（`src/execute/core.ts:361`） |
| A6 | **跑之前就知道有没有写错**（语法/别名/类型） | ❌ 卡住 | 无 lint/diagnostics；错误只有执行后的 `{code,message}`（`ScriptResults.tsx:15`；§3 G3/G19）；补全不做语义检查（`docs/01-PRD.md:77` N4） |
| A7 | **大表先看到首页，不用等总数** | ✅ 顺畅 | `LIMIT n+1` + COUNT 1200ms 超时降级（`docs/07-MILESTONES.md:65`；`.workbuddy/memory/2026-10-19.md:92-94`；S12） |
| A8 | **在结果里换排序/翻页/筛条件/看大值，不回头改 SQL** | 🟡 半通 | 服务端排序/筛选/分页/值查看器/聚合（S15/S61/S36-S38）；**但「在结果里搜一个值」「只看几列」不行**（B6/B7 未做）→ 拆开看是 2 个顺畅 + 2 个卡住 |
| A9 | **跑完逐条看结果，错误一眼知道是哪条**（含错误码） | ✅ 顺畅 | 每语句结果 tab + 输出 tab + 错误码（`docs/10-AGENT-CONSOLE-SPEC.md:96,319-325`；`docs/07-MILESTONES.md:183`；S64）；缺「错误在编辑器里高亮行号」 |
| A10 | **回头还能拿起昨天/刚才的 SQL，并把它变成能复用的东西** | ❌ 卡住 | 查询历史未做（B5/G2）、刷新丢 SQL（B4/G1）、导出无 INSERT/JSON（B8/G6）、脚本无保存（M3 未做）——这一格集中了 4 个未做项 |

**读法**：
- **顺畅的 5 个（A1/A2/A4/A7/A9）** 都建立在「网格 + CM6 + 对象树」上，说明这三件套已经把「起手、执行、看结果」做通了。
- **真正卡住手写流畅的是 A6（跑前检查）、A10（不回头的资产）和 A8 的两小项（查找/列显隐）**——恰好都不需要解析器，也不与「不做清单」冲突。
- **半通的 A3/A5** 说明补全与重跑都停在「够用」：A3 差作用域，A5 差脚本级粒度。

---

## 6. 本报告的盲区 + 需要真机复核的 8 项

### 6.1 盲区（不要拿本文当答案的部分）

1. **DataGrip 输入中行为的机制细节**（补全触发/排序/模板/格式化/重构/快捷键/历史/导航）——4 份材料 0 证据；本文只能标注 UNKNOWN，不能用「DataGrip 一般如何」补齐（`AGENTS.md:72` 也禁止复用其资源与文档原文）。
2. **DataGrip 会不会静态检查**：只有 PSI「检查」一个词（`COMPREHENSIVE-ASSESSMENT.md:101`）+ 截图右侧色条；**不足以证明**「跑前会在编辑器标错」。方案若要抄这一点，需另找证据（官方文档/实机）。
3. **DataGrip console 的结果 tab 行为**：C 级（`docs/10-AGENT-CONSOLE-SPEC.md:4` 自述「REA + 用户实测」），4 份 REA 里找不到对应类/日志；只能作为产品设计输入，不能作为逆向事实。
4. **「DataGrip 网格是分页不是虚拟滚动」**：证据来自用户机器的 `databaseSettings.xml`（`paging-display-mode=DATA_EDITOR_TOOLBAR`）与 JetBrains 文档（`.workbuddy/memory/2026-10-19.md:93,128`），同样不是 4 份 REA 材料——引用时需注明。

### 6.2 要真机复核的 8 项（给方案组）

| # | 待复核 | 为什么重要 | 复核方式 |
|---|---|---|---|
| V1 | CM6 多光标是否真的可用 | 03:28 标称「自带」，代码未开 `allowMultipleSelections`（§3 G10） | 真机按 `Ctrl+D` / `Alt+Click`，看是否出现第二光标 |
| V2 | 对象树 F4 / Ctrl+B / Enter 是否触发 | 只是菜单 hint（§3 G11），S29 把 hint 当快捷键验收 | 真机按 F4，看是否等同「打开数据」 |
| V3 | 跳转行 `Mod-Alt-g` 是否可用、是否该换一个更顺手的键 | §3 G15；03 未写 | 真机测试 + 决定是否补文档 |
| V4 | 脚本结果按语句筛选是否真如 S64 所述 | 09 B10 与 S64 冲突（§3 G16） | 跑两语句脚本，点列头漏斗，确认互不影响 |
| V5 | 编辑器错误是否可以拿到行号 | 01-PRD:49 要求（§3 G3） | 触发一个语法错误，看驱动是否回传位置信息 |
| V6 | 列宽拖拽是否该持久化到 layout 文档 | 03:222 要求（§3 G12） | 结合已完成的 B3 layout 文档（`docs/07-MILESTONES.md:199`）评估成本 |
| V7 | 手写 SQL 被分页包裹是否影响语义 | DataGrip console 不分页（RUNTIME-FINDINGS:218）vs 本项目全包裹（AGENTS:83） | 用 `ORDER BY`+`LIMIT` 的 SQL 看二次包裹后的结果一致性 |
| V8 | 历史/持久化的存储位置与单写者约束 | 决策 #5 宿主单写者、MCP 无状态（`AGENTS.md:84`；`docs/07-MILESTONES.md:62`） | 复用 B3 layout 的通道（宿主 `documents` 表 + HTTP）是否足够 |

---

## 7. 证据索引（本次读过的材料）

**DataGrip 逆向 4 份（A/B 级来源）**

- `docs/reference/SPEC.md`（连接管理：存储/凭据/驱动/测试/SSH-SSL；§2.4 `LocalDataSource` 字段；§8 开源对照）
- `docs/reference/RUNTIME-FINDINGS.md`（运行时被动观察：配置实锤 §2、后端进程/RMI §3、分页日志 §4、§3b 实时抓取、§5 未决议项）
- `docs/reference/SPEC-sql-execution-grid.md`（执行链路 §2、结果集 §3、分页 §4、缓存 §5、渲染 §6、编辑回写/导出 §7）
- `docs/reference/COMPREHENSIVE-ASSESSMENT.md`（方法 §2、子系统矩阵 §4、运行验证 §5、复刻路线 §6–§7、合规 §9）

**项目事实（D 级来源）**

- `docs/03-UIUX-SPEC.md`（交互规格：布局 §1、§6.6–§6.10、状态矩阵 §5、网格 UX §6）
- `docs/01-PRD.md`（R2/R3、N1–N7 非目标）
- `docs/07-MILESTONES.md`（做过什么、批次 1–8、§8.2 已做但差一口气、§8.3 明确不做）
- `docs/09-BACKLOG.md`（B4–B17、§4 明确不做）
- `docs/10-AGENT-CONSOLE-SPEC.md`（结果 tab/输出 tab 决策、§14 实现状态、§15 审查闭合）
- `docs/testing.md`（人工 smoke S1–S72，本报告引用 S12–S68 中与编辑/结果相关的条目）
- `AGENTS.md`（§4 已定决策、§6 AC-1~AC-8、§7 明确不做）
- `docs/00-README.md`（§5.1 证据地图、§9 变更记录）
- `docs/08-RISKS.md`（R17 测试耗时、R18 bundle 体积、R22–R24 教训）
- 代码：`packages/client/ui-sql-workbench/src/client/editor-cm.ts`、`completion-rank.ts`、`components/SchemaTree.tsx`、`components/ScriptResults.tsx`、`components/ResultGrid.tsx`、`execute/core.ts`、`docs/testing.md` 引用处

**C 级来源（截图 / 记忆 / 官方文档转述）**

- `.workbuddy/datagrip-now.png`（用户桌面 DataGrip 截图：布局、console tabs、状态栏、工具条）
- `.workbuddy/memory/2026-10-16.md` ~ `2026-10-21.md`（REA 过程、真机验证、用户反馈、失败与修复）
- 第三方文档转述（经 memory 记录）：JetBrains explorer / data-editor 文档（`.workbuddy/memory/2026-10-19.md:119,128`）
