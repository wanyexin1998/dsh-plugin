# SPEC — SQL 执行、结果集获取、分页/缓存与结果表格渲染

> 来源：DataGrip 2026.2.3（DB-262.9437.163）纯静态分析（REA CLI 6.5.0 + class 常量池证据），未运行程序、未修改文件。
> 本文档描述可复现的行为与数据流，供开源实现参考；不含任何专有代码/资源，类名与字符串仅作事实证据。

---

## 1. 模块地图（OBSERVED）

| 模块（jar） | 位置 | 职责 |
|---|---|---|
| `intellij.database.sql.impl.jar` | `plugins/DatabaseTools/lib/modules/` | SQL 编辑器（`com.intellij.sql.editor.*`） |
| `intellij.database.connectivity.jar` | 同上 | 执行编排：`run/ConsoleDataRequest`、`datagrid/ConsoleGridDataHookUp`、`datagrid/DatabaseGridDataHookUp` |
| `intellij.database.jdbcConsole.jar` | 同上 | 进程外 JDBC 后端：`remote/RemoteJdbcServer`（main）、`remote/jdbc/impl/*`、`helpers/*` |
| `intellij.database.core.impl.jar` | 同上 | 数据请求模型 `datagrid/DataRequest`、页大小属性 |
| `intellij.grid.core.impl.jar` | `plugins/grid-core-plugin/lib/modules/` | 网格内核：`datagrid/{CoreGrid,GridRow,GridColumn,MultiPageModel,GridPagingModelImpl,GridLoaderBase,DataConsumer,DataProducer,GridFilteringModel,GridSortingModel,Index*}` |
| `intellij.grid.impl.jar` | 同上 | Swing 表格视图：`run/ui/table/TableResultView`、`run/ui/grid/{GridModelUpdater,TableCellImageCache,FormatsCache,Formatter*}` |

---

## 2. 执行链路（OBSERVED）

```
SQL 编辑器(com.intellij.sql.editor.*)
  → run/ConsoleDataRequest：按语句拆分（ScriptModel$StatementIt）
      produceResultSet / getResultSetSubQueries（识别返回结果集的子查询）
      ResultSetSubQuery{subQueryIndex, resultSetIndex}
  → datagrid/ConsoleGridDataHookUp / DatabaseGridDataHookUp$DatabaseLoader
      createQueryText（按 DBMS 生成带 limit/offset 的查询，supportsOffset/canUseOffset）
      GridRequestSource{Phase.COUNT} → updateTotalRowCount/countAll（单独 COUNT 查询取总数）
  → core.impl datagrid/DataRequest.newConstraints(offset, limit, maxLobLength, …)
      Constraints{limit, maxLobLength, …}；GridDataRequest{query, offset, limit, subQueryIndex}
  → console/JdbcEngine → DatabaseConnectionEstablisher（见前序 SPEC）
  → 后端进程 RemoteJdbcServer.main → RemoteDriverFactoryImpl → RemoteDriver
      RemoteStatementImpl.executeQuery(sql) → setMaxRows/setFetchSize/setQueryTimeout
      → RemoteResultSetImpl 包装 java.sql.ResultSet
  → DataBusGridDataHookUp / DatabaseGridDataHookUp：DataProducer → DataConsumer
      DataConsumer.addRows(List<GridRow>) / afterLastRowAdded(firstRowNum, source)
  → grid-core：GridLoaderBase 应用行 → MultiPageModel 页窗口 → UI 模型
```

后端通信：**Java RMI**（`java.rmi.Remote`、`RemoteException`、`com.intellij.execution.rmi.ssl.SslEntityReader`/`BCSslEntityReader`，即 RMI over SSL）（OBSERVED）。

后端进程启动（OBSERVED，`run/EelDatabaseHelperKt.buildRawCommandLine`）：
- `SimpleJavaParameters`（VM 参数 + classpath）→ `java -jar <jar>` 或 `java -cp … <mainClass>`；
- `findJavaOrThrow`：JAVA_HOME → `java.exe` →  bundled JBR（失败键 `eel.remote.process.no.jdk.found`）；
- 额外 classpath 目录：`CLASSPATH_DIR` / `ADDITIONAL_CLASSPATH_DIR`（`additional-classpath`，来自 `DatabaseDriverClasspathManager`）；
- 远端主机用 Eel API（`EelExecApi`/`EelPath`）解析路径与启动；SSH 场景端口转发见前序 SPEC。

---

## 3. 结果集获取（OBSERVED）

`com/intellij/database/remote/jdbc/impl/RemoteResultSetImpl`（extends `JdbcRemoteObjectWithHelper`，包装 `java.sql.ResultSet`）：

- **行式批量导出**：`getRows(RemoteResultSet$DataRetrievingOptions, rowCount) → List<Object[]>`（常量池方法签名 `p(L...DataRetrievingOptions;)Ljava/util/List<[Ljava/lang/Object;>;`）；`myExportedResults` 持有已导出批次，`dropExportedResults()` 释放。
- **游标控制**：`first/beforeFirst/isFirst/isBeforeFirst/findColumn`；`getFetchSize/setFetchSize/getFetchDirection/setFetchDirection`（直接透传驱动）。
- **元数据**：`RemoteResultSetMetaDataImpl`（列名/类型）。
- **LOB 处理**：`java.sql.Blob/Clob` → `RemoteBlobImpl/RemoteClobImpl`，底层 `impl/FileBlob`、`impl/FileClob`（大对象落盘，INFERRED 为临时文件缓冲）。
- **大值保护**：`DataRequest.Constraints.maxLobLength`、`getBytesLimitPerValue`；超出解析能力的值在 UI 侧表现为 `run/ui/grid/UnparsedValue`（含 `UnparsedValue$ParsingError`）。
- **语句侧**：`RemoteStatementImpl`：`execute/executeQuery/executeUpdate/executeBatch/cancel/getMaxRows/setMaxRows/getQueryTimeout/setQueryTimeout/getResultSetType/Concurrency/Holdability`。

数据流：后端按 `DataRetrievingOptions`（含 rowCount）从驱动 ResultSet 取 ≤N 行 → 转 `Object[]` → RMI 回传 → 前端 `DataConsumer` 逐行 `addRows` → `GridRow` 入页模型。

---

## 4. 分页模型（OBSERVED）

### 4.1 核心类

| 类 | 关键成员（常量池实证） |
|---|---|
| `datagrid/MultiPageModel(Impl)` | `setPageStart` / `setPageEnd` / `setTotalRowCount` / `setTotalRowCountUpdateable` / `getFirstRowIndex` / `PageModelListener` |
| `datagrid/GridPagingModelImpl` | `getPageStart` / `getPageEnd` / `forRow(GridModel,int)→ModelIndex` / `findRow(int)` / `SinglePage` 内部类 |
| `datagrid/GridLoaderBase` | `loadFirstPage` / `loadNextPage` / `loadPreviousPage` / `loadLastPage` / `reloadCurrentPage` / `getPageSize` / `isPageSizeUnlimited` / `getPositiveOffset` / `getTotalRowCount` / `updateTotalRowCount` / `updateIsTotalRowCountUpdateable` / `afterLastRowAdded(int,GridRequestSource)` / `addRows(List<GridRow>,int)` / `removeRows` / `setRows(int,List,GridRequestSource)` |
| `datagrid/NestedTableGridPagingModel` | 嵌套表分页（`StaticMultiPageModel`） |

### 4.2 行为归纳（INFERRED，基于上述成员组合）

1. **页窗口**：`MultiPageModel` 持 `[pageStart, pageEnd)` 窗口；翻页时 `GridLoaderBase` 以 `offset`/`limit` 重新生成查询（`DatabaseGridDataHookUp$DatabaseLoader.createQueryText`，属性键 `database.grid.paging.offset` 控制 offset 式翻页是否启用，`supportsOffset`/`canUseOffset` 判断 DBMS 支持）。
2. **总数**：独立 COUNT 查询（`GridRequestSource$Phase.COUNT`、`countAll`、`canCountRows`、`updateTotalRowCount`），结果驱动 `setTotalRowCount`；不可计数时 `setTotalRowCountUpdateable(false)`。
3. **行落地**：`addRows(rows, firstRowNum)` 按页内偏移插入；`afterLastRowAdded` 收尾（触发后续请求/滚动加载）；`setRows(offset, list, source)` 整页替换。
4. **页大小可调**：`ChangePageSizeActionGroup` / `SetCustomPageSizeAction` / `CustomPageSizeForm`（"limit.page.size.to" 复选框）；`isPageSizeUnlimited` 对应 `DataRequest.newLimitlessRequest`（导出/单次全量场景）。

### 4.3 配置属性（OBSERVED，常量池键名）

| 键 | 出处 | 含义 |
|---|---|---|
| `datagrip.default.page.size` | `GridHelperPropertyProviderImpl` | 默认页大小 |
| `datagrip.limit.default.page.size` | 同上 | 是否限制默认页大小 |
| `database.grid.paging.offset` | `DatabaseGridDataHookUp$DatabaseLoader` | offset 式分页开关 |
| `database.mongodb.page.size` / `.limit` | `DbGridPageSizePropertyKt` | Mongo 专用页大小 |
| `settings.limit.page.size.to` | `DatabaseSettingsDataViews` | 设置项 |

---

## 5. 缓存（OBSERVED）

| 缓存 | 类 / 键 | 说明 |
|---|---|---|
| 单元格图像缓存 | `run/ui/grid/TableCellImageCache`（`myCacheEnabled`、`installFastScrollingCaching`、`CachingCellRendererWrapper`、`CellStateInfo`） | 键 `database.grid.render.cache`、`database.grid.render.cache.fast.scroll`；缓存单元格渲染图像，快速滚动时复用 |
| 表格列缓存 | `run/ui/table/TableResultView$MyTableColumnCache`（`Entry`） | 列宽/列模型缓存 |
| 结果视图缓存因子 | `TableResultView` 引用键 `database.grid.cache.factor` | 控制视图层缓存行数倍率（INFERRED：按可视区×factor 预取） |
| 格式缓存 | `run/ui/grid/FormatsCache`（`FormatProvider`/`BaseFormatProvider`） | 日期/数字格式对象复用 |
| 嵌套表缓存 | `datagrid/NestedTablesDataGridModel$CacheStrategy`、`$NestedTableCache`、`RowCacheStrategy`、`ColumnCacheStrategy` | 嵌套表按坐标缓存 |
| 模型缓存失效 | `DatabaseGridDataHookUp$DatabaseLoader.notifyDropModelDependentCache` | 模型变更后清缓存 |

---

## 6. 结果表格渲染（OBSERVED）

`run/ui/table/TableResultView`（基于 `javax.swing.JTable`/`JBTable`，实现 `ResultViewWithRows`）：

- 表格模型 `RegularGridTableModel`；列模型 `MyTableColumnModel`；列布局 `GridColumnLayout`/`DummyGridColumnLayout`。
- 单元格渲染 `MyCellRenderer` + `Renderers` + `GridCellRendererWrapper`（包一层图像缓存）；表头 `MyTableHeader` / `MyHeaderCellComponent`；`LabelWithFallbackFont`。
- 索引转换 `TableRawIndexConverter`（Raw↔View）；选区扩展 `GridSelectionGrower`；单元格编辑 `run/ui/GridTableCellEditor` + `GridCellEditorHelper`。
- 交互过滤器：`MySearchRowFilter`（表内搜索）、`MyTransposedViewColumnFilter`（转置视图，`myWasAutomaticallyTransposed`）；悬停行高亮 `ResultView$HoveredRowBgHighlightMode`。
- 绘制会话 `TableResultView$PaintingSession`（INFERRED：一次绘制批量取单元格值，配合图像缓存）。

**三层索引架构**（OBSERVED，grid-core 常量池）：
- `RawIndex`/`RawIndexConverter`：后端原始行号；
- `ModelIndex`/`ModelIndexSet`：模型层（排序/过滤后的逻辑行）；
- `ViewIndex`/`ViewIndexSet`：视图层（可见行/列）。
- 排序 `GridSortingModel`（`RowSortOrder`、`Listener`）、过滤 `GridFilteringModel`、选区 `SelectionModel`/`GridSelection`、多列层级 `HierarchicalColumnsDataGridModel`。
- 单元格取值请求 `GridCellRequest`（`rowIdx/columnIdx`、`FixedValue`）、`ActualGridCellRequest`、`FixedGridCellRequest`（INFERRED：渲染器按需向模型取当前窗口内的值）。

**值格式化**（`run/ui/grid`）：`FormatterImpl`/`CompositeFormatter`/`NumberFormatter`/`DateAndTimeFormatter`/`TimestampDelegate`/`ZonedTimestampDelegate` 等，按列类型分发（INFERRED）。

---

## 7. 编辑回写（OBSERVED，简述）

- `datagrid/DatabaseMutator(Impl)` / `GridMutator{ColumnsMutator,RowsMutator,DatabaseMutator}` / `MutationsStorage` / `TypesMutationsStorage`：暂存用户编辑。
- 提交时经 `DataRequest$InsertRequest/UpdateRequest/DeleteRequest`（DML 生成器 `script/generator/dml/*`，如前序 SPEC 的 `SelectUsingKeys`/`WrapInSelectResult`）生成 SQL 执行。
- 导出：`extractors/`（`SqlInsertValuesExtractor`、`SqlUpdateValuesExtractor`、`DisplayHtmlValuesExtractor`、`WhereClauseExtractorFactory` 等 112 类）与 `grid-loader-json`/`grid-loader-xls`/`grid-plugin` 的 `intellij.grid.{csv,json,images,charts,scripting}.impl.jar`。

---

## 8. 端到端数据流（汇总）

```
编辑器语句
  → ConsoleDataRequest 拆语句/子查询
  → DatabaseLoader.createQueryText(+limit/offset) + COUNT 查询
  → DataRequest.newConstraints(offset, limit, maxLobLength)
  → JdbcEngine → RMI → RemoteJdbcServer(后端进程, java -jar, 驱动 classpath 目录)
  → RemoteStatementImpl.executeQuery → java.sql.ResultSet
  → RemoteResultSetImpl.getRows(options,rowCount) → List<Object[]> → RMI
  → DataConsumer.addRows/afterLastRowAdded → GridRow
  → GridLoaderBase(页窗口) → MultiPageModel[pageStart,pageEnd)
  → GridModelUpdater → RegularGridTableModel → TableResultView(JTable)
     渲染: MyCellRenderer/Renderers + TableCellImageCache(图像缓存) + FormatsCache(格式缓存)
     索引: Raw ↔ Model(排序/过滤) ↔ View(可见)
     取值: GridCellRequest 按需拉取; 大值 UnparsedValue/FileBlob
```

---

## 9. 未决议项登记（2026-10-17 决议：均为实现细节，开源复刻时自行定义）

| 项 | 原状态 | 决议 |
|---|---|---|
| 预取触发阈值（距页边缘多少行触发加载） | UNKNOWN | **实现细节**。运行时证据已确认整页加载模型（`LIMIT n+1` 一次取整页入模型，非流式）；预取阈值自研时自定（建议：距页尾 ≤1 页或 10% 时触发） |
| `getRows` 单批行数 / `myExportedResults` 切分 | UNKNOWN | **实现细节**。批大小只影响单次 RMI 传输切分；自研时按页大小 × 固定系数（如 1–2 页）即可 |
| `database.grid.cache.factor` 默认值 | UNKNOWN | **实现细节**。渲染缓存倍率，自研时按可视区行数 × 2–3 定义 |

其他仍未静态确认的部分（如需精确答案的代价）：

| 项 | 状态 | 获取方式 |
|---|---|---|
| RMI 端口 | **已由运行时解决**（60491 注册 / 58804 服务对象，见 RUNTIME-FINDINGS.md §3b） | — |
| 后端 JVM 启动参数 | **已由运行时解决**（完整命令行见 RUNTIME-FINDINGS.md §3） | — |
| Swing 渲染器绘制代码（`MyCellRenderer`/`PaintingSession`） | UNKNOWN | Ghidra 反编译 `TableResultView` |
| 虚拟滚动策略（`installFastScrollingCaching` 机制） | UNKNOWN | Ghidra 反编译 `TableCellImageCache` |
| 驱动在 `JdbcClassLoader` 中的 parent-first/child-first 细节 | UNKNOWN | Ghidra 反编译 `JdbcClassLoaderImpl` |

---

## 10. 证据索引

- `plugins/DatabaseTools/lib/modules/intellij.database.jdbcConsole.jar`
  - `com/intellij/database/remote/RemoteJdbcServer.class`（main/start）
  - `com/intellij/database/remote/jdbc/impl/{RemoteResultSetImpl,RemoteStatementImpl,RemoteConnectionImpl,JdbcClassLoader}.class`
  - `com/intellij/database/remote/jdbc/RemoteResultSet$DataRetrievingOptions.class`、`helpers/JdbcHelperImpl.class`
- `plugins/DatabaseTools/lib/modules/intellij.database.connectivity.jar`
  - `com/intellij/database/run/{ConsoleDataRequest,EelDatabaseHelperKt}.class`
  - `com/intellij/database/datagrid/{ConsoleGridDataHookUp,DatabaseGridDataHookUp$DatabaseLoader,DataBusGridDataHookUp,GridTablesModelBuilder}.class`
- `plugins/DatabaseTools/lib/modules/intellij.database.core.impl.jar`
  - `com/intellij/database/datagrid/DataRequest.class`、`com/intellij/database/util/DbGridPageSizePropertyKt.class`
- `plugins/grid-core-plugin/lib/modules/intellij.grid.core.impl.jar`
  - `com/intellij/database/datagrid/{MultiPageModel,GridPagingModelImpl,GridLoaderBase,DataConsumer,GridCellRequest,CoreGrid,GridFilteringModel,GridSortingModel,NestedTablesDataGridModel}.class`
  - `com/intellij/database/run/ui/grid/GridModelUpdater.class`
- `plugins/grid-core-plugin/lib/modules/intellij.grid.impl.jar`
  - `com/intellij/database/run/ui/table/TableResultView*.class`、`com/intellij/database/run/ui/grid/{TableCellImageCache,FormatsCache,Formatter*}.class`
  - `com/intellij/database/datagrid/GridHelperPropertyProviderImpl.class`、`ChangePageSizeActionGroup.class`
