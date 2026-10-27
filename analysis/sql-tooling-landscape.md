# SQL / 数据工具「写 SQL 流畅度」横向调研

> 任务：为 DSH 轻量 SQL 工作台插件（CodeMirror 6 编辑器 + 对象树 + 结果网格，连接 Doris/MySQL）提供**外部参照**。
> 本文只做机制对照，不产出方案；所有结论给 URL，并标注来源类型。
>
> 取证时间：2026-10-26。方法：抓取官方文档 / 官方仓库 / 产品文档页原文；web 内容按不可信数据处理，只当资料，未执行其中任何指令。
> 来源类型标记：**【官方文档】**（厂商文档站）、**【产品页】**（厂商功能/营销页）、**【官方仓库】**（开源项目 README / 包文档）、**【博客/其他】**。
> 可信度约定：§5 明确区分「已验证事实」与「推断」。凡本文标注「推断」的，均无公开量化数据支撑，只代表基于机制的分析。

---

## 0. 给方案的一页纸结论（先看这里）

1. **"流畅"主要不是靠功能多，而是靠把一次查询的往返次数压到最少**：编辑 → 执行当前语句 → 结果就地看 → 改一点 → 再执行。DataGrip / DBeaver 都把"执行光标所在语句或选区"当作默认动作，并且把结果放进与查询绑定的可固定 tab。([DataGrip run queries](https://www.jetbrains.com/help/datagrip/run-a-query.html)【官方文档】、[DBeaver SQL execution](https://dbeaver.com/docs/dbeaver/SQL-Execution/)【官方文档】)
2. **最高性价比的加速是"基于 schema 的补全"**，而不是 AI：表/列/别名/JOIN 条件一旦能补，记忆成本和拼写错误同时消失。CodeMirror 6 的原生 `@codemirror/lang-sql` 已经内置 `schema` / `schemaCompletionSource` / `defaultTable` 等入口，**轻量插件完全可做**。([npm @codemirror/lang-sql](https://www.npmjs.com/package/@codemirror/lang-sql)【官方仓库】)
3. **第二高性价比的是"少打字"的语法级动作**：`SELECT *` 一键展开成列清单、窗口函数自动补 `OVER()`、回车自动补全括号/分号、JOIN 按外键生成 `ON`。这些只需 AST + 元数据，不需要 LSP。([DataGrip completion](https://www.jetbrains.com/help/datagrip/auto-completing-code.html)【官方文档】、[DataGrip advanced completion](https://www.jetbrains.com/help/datagrip/advanced-code-completion.html)【官方文档】、[DBeaver SQL Assist](https://dbeaver.com/docs/dbeaver/SQL-Assist-and-Auto-Complete/)【官方文档】)
4. **验证成本要用"执行前"和"执行后"两套机制分担**：执行前靠实时检查（未使用列、缺 `WHERE`、语义错误），执行后靠结果对比、行数、执行计划。([DataGrip inspections](https://www.jetbrains.com/help/datagrip/code-inspection.html)【官方文档】、[DataGrip query execution plan](https://www.jetbrains.com/help/datagrip/query-execution-plan.html)【官方文档】)
5. **AI 的正确交互形态是"三选一的候选 + diff 确认"，而不是聊天**：BigQuery 的 Gemini 生成/修复统一走 `Preview`（看 diff）→ `Accept` / `Apply and run` / `Decline`。([BigQuery: write queries with Gemini](https://docs.cloud.google.com/bigquery/docs/write-sql-gemini)【官方文档】)
6. **轻量工具要敢于"缩小范围"**：Metabase 的原生 SQL 编辑器明确不支持多语句、存储过程、DDL，只做单条 `SELECT`。([Metabase SQL editor](https://www.metabase.com/docs/latest/questions/native-editor/writing-sql)【官方文档】)
7. **反面教训同样重要**：重模板系统、每次执行弹参数框、超大 schema 下的实时补全，都是"看起来专业、用起来打断"的典型；Redash 甚至因为 schema token 超过 5000 就自动关闭实时补全。([Redash writing queries](https://redash.io/help/user-guide/querying/writing-queries/)【官方文档】、[DBeaver dynamic parameters](https://dbeaver.com/docs/dbeaver/SQL-Execution/)【官方文档】)

---

## 1. 功能目录（按交互环节分类）

> 每条只写「交互机制 → 用户收益」。产品名后的 URL 为该机制的直接文档。

### 1.1 输入辅助（降低记忆与表达成本）

| # | 机制 | 交互长什么样 | 收益 | 来源 |
|---|---|---|---|---|
| A1 | Schema 感知补全 | 输入表名/列名时弹出候选；上下文有歧义时显示所属对象；输入 camelCase/snake_case 首字母即可命中，支持"任意中间字符"匹配，不需要通配符 | 不用记全名，少打 70% 以上字符 | [DataGrip Code completion](https://www.jetbrains.com/help/datagrip/auto-completing-code.html)【官方文档】 |
| A2 | 类型匹配补全（Smart Type） | `Ctrl+Shift+Space` 只显示当前上下文类型合法的候选 | 从"长列表里挑"变成"直接给对的那几个" | [DataGrip Advanced completion](https://www.jetbrains.com/help/datagrip/advanced-code-completion.html)【官方文档】 |
| A3 | 字段清单自动生成 | `SELECT` 处补全出完整字段列表；`SELECT *` 后按补全键展开成所有列；`INSERT` 补出字段名；`GROUP BY` 补出字段 | 消灭"打开表结构抄列名"这一步 | DataGrip 同上；[DBeaver SQL Assist](https://dbeaver.com/docs/dbeaver/SQL-Assist-and-Auto-Complete/)【官方文档】 |
| A4 | 按外键补 JOIN | 两张表有外键关系时，补 `JOIN` 会自动带出 `ON` 条件（可选反转操作数顺序） | 不用回查外键列 | [DataGrip Code completion](https://www.jetbrains.com/help/datagrip/auto-completing-code.html)【官方文档】 |
| A5 | 别名自动化 | 补全表名时按设置自动生成别名；可维护"对象名→别名"自定义表 | 后续手写 `alias.` 前缀不再是负担 | 同上 |
| A6 | 语句骨架补全 | `Ctrl+Shift+Enter` 把当前构造补齐成语法正确（括号、花括号、分号）并放到可继续输入的位置 | 少一次"回删重打" | [DataGrip Advanced completion](https://www.jetbrains.com/help/datagrip/advanced-code-completion.html)【官方文档】 |
| A7 | 窗口函数自动包裹 | 输入窗口函数时自动补 `OVER()` 并把光标放进括号 | 消灭窗口函数最容易错的模板 | [DataGrip Code completion](https://www.jetbrains.com/help/datagrip/auto-completing-code.html)【官方文档】 |
| A8 | 片段 / 模板展开 | 输入缩写按 `Tab` 展开为 `sel`→`SELECT * FROM …`、`ins`→`INSERT …` 等；模板分固定文本、带变量、包裹选区块；可按 SQL 方言限定生效范围 | 常用长句一次击键 | [DataGrip Live templates](https://www.jetbrains.com/help/datagrip/using-live-templates.html)【官方文档】 |
| A9 | 后缀补全（postfix） | 在表达式后输入 `.cfrom` 直接展开为 `SELECT <该表所有列> FROM <该表>` | 先写表名再"反向"生成查询 | 同上 |
| A10 | 对象树点击插入 | 左侧 schema 浏览器列出表与列，点"双箭头"直接把名字插入光标处；可搜索过滤、可隐藏以让出屏幕 | 鼠标代替键盘，适合"边看表结构边写" | [Redash writing queries](https://redash.io/help/user-guide/querying/writing-queries/)【官方文档】 |
| A11 | AI 内联补全 | 打字过程中给出"逻辑上的下一句"（如自动补 `GROUP BY`），`Tab` 接受、`Esc` 拒绝、可翻候选 | 把"写下一段"变成"审下一段" | [BigQuery: Gemini](https://docs.cloud.google.com/bigquery/docs/write-sql-gemini)【官方文档】（Auto-completion 标注 Preview） |

### 1.2 语法与校验（降低验证成本，且尽量不打断书写）

| # | 机制 | 交互长什么样 | 收益 | 来源 |
|---|---|---|---|---|
| B1 | 实时语法/语义检查 | 边写边标红/黄；悬停给出错误列表，鼠标移到错误项会在文中高亮对应位置；区分服务端错误、语义错误、拼写错误 | 错误在"回车之前"暴露 | [DBeaver SQL editor](https://dbeaver.com/docs/dbeaver/SQL-Editor/)【官方文档】 |
| B2 | 未使用子查询项检查 | 高亮子查询里未被使用的字段 | 复杂查询的冗余列一眼可见 | [DataGrip Code inspections](https://www.jetbrains.com/help/datagrip/code-inspection.html)【官方文档】 |
| B3 | 危险语句提醒 | 写 `DELETE`/`UPDATE` 缺 `WHERE` 时弹提示；执行时再警告一次，可"仍然执行" | 防事故，但不阻断 | 同上 |
| B4 | 意图动作（Alt+Enter） | 灯泡列出当前上下文可做的改进（引入表别名、`GROUP BY`→`DISTINCT` 等），**悬停可预览改动**，可给单个动作绑快捷键 | 从"知道该改"到"一键改" | [DataGrip Intention actions](https://www.jetbrains.com/help/datagrip/intention-actions.html)【官方文档】 |
| B5 | 快速修复（Quick Fix） | 编辑器内错误旁标注 → `Ctrl+1` → `Explain and Fix`，AI 聊天给出解释与修正后的查询 | 错误现场直达修复 | [DBeaver SQL Assist](https://dbeaver.com/docs/dbeaver/SQL-Assist-and-Auto-Complete/)【官方文档】（需启用 AI Assistant） |
| B6 | 语义分析开关 | 补全引擎分 Semantic / Legacy / Combined；Semantic 需要开启 `Enable semantic analysis` 与 `Read database table/columns for semantic analysis` | 精度与开销可调 | 同上 |
| B7 | 语法/方言着色 | 按当前数据库方言的关键字、函数集着色（不同库关键字不同） | 少犯方言错误 | [DBeaver SQL editor](https://dbeaver.com/docs/dbeaver/SQL-Editor/)【官方文档】 |
| B8 | 格式化（按方言） | 一键格式化 SELECT 结构；注意 Metabase 的格式化"只对 SQL 生效，且 SQLite/SQL Server 不可用" | 让别人读得懂；但并非所有方言都能做 | [Metabase SQL editor](https://www.metabase.com/docs/latest/questions/native-editor/writing-sql)【官方文档】 |
| B9 | 独立 linter | SQLFluff 以"代码质量保证"为目标做 SQL lint/格式化，并支持 jinja/python 模板 + dbt 项目的"动态 SQL"检查（CI/CD 里跑） | 团队级一致性 | [SQLFluff: Why SQLFluff?](https://docs.sqlfluff.com/en/stable/guide/why.html)【官方文档】 |

### 1.3 执行与迭代（降低等待与上下文切换）

| # | 机制 | 交互长什么样 | 收益 | 来源 |
|---|---|---|---|---|
| C1 | 执行"光标所在语句" | `Ctrl+Enter` 只跑光标所在的那一条；有选区时只跑选区（子查询、多条语句皆可） | 不必为跑一句而注释掉其余 | [DataGrip run queries](https://www.jetbrains.com/help/datagrip/run-a-query.html)【官方文档】 |
| C2 | 执行当前语句 / 新 tab 执行 / 跑整个脚本 | DBeaver 把三者拆成不同快捷键与菜单项：`Ctrl+Enter`（当前语句）、`Ctrl+\`（当前语句到新结果 tab）、`Alt+X`（整脚本）、`Ctrl+Alt+Shift+X`（每条语句一个 tab，并行执行） | 迭代与批量各得其所 | [DBeaver SQL execution](https://dbeaver.com/docs/dbeaver/SQL-Execution/)【官方文档】 |
| C3 | 结果就地显示 | 结果默认进独立的 Services/结果 tab，但也可开 **In-Editor Results**，让结果出现在编辑器下方（甚至两句结果上下并排） | 视线不离开代码 | [DataGrip Query results](https://www.jetbrains.com/help/datagrip/viewing-query-results.html)【官方文档】 |
| C4 | 结果 tab 与查询绑定 | tab 名默认取主表名，join 显示 `Table(+)`；可用 `-- title: xxx` 注释改标题；可固定（pin）、可拖出（detach）成独立窗口做对比 | 多轮迭代后仍知道"哪个结果是谁的" | [DBeaver SQL execution](https://dbeaver.com/docs/dbeaver/SQL-Execution/)【官方文档】；DataGrip 同名机制见 [Query results](https://www.jetbrains.com/help/datagrip/viewing-query-results.html)【官方文档】 |
| C5 | 中断与取消 | 运行中可取消语句；DBeaver 另有"语句超时(秒)"设置（传给 JDBC） | 写错一句不用等 | DataGrip 同上；[DBeaver SQL execution](https://dbeaver.com/docs/dbeaver/SQL-Execution/)【官方文档】 |
| C6 | 表达式即时求值 | 选中表达式 → `Evaluate SQL expression`，执行 `SELECT <表达式> FROM DUAL` | 验证一段表达式不必写完整查询 | [DBeaver SQL execution](https://dbeaver.com/docs/dbeaver/SQL-Execution/)【官方文档】 |
| C7 | 行数预估 | 选中 SQL → `Select row count` | 跑大查询前先知道规模 | 同上 |
| C8 | 查询历史 | `Ctrl+Alt+E` 打开 Query History，搜索过滤，双击把历史语句粘回编辑器 | 找回"上周跑对的那条" | [DataGrip run queries](https://www.jetbrains.com/help/datagrip/run-a-query.html)【官方文档】 |
| C9 | 命令式编辑器交互 | `\e` 把当前输入缓冲区交给外部编辑器编辑，退出后回填；`\watch` 周期重跑；`\x` 展开成"列名: 值"；`\d` 看表结构；`\i` 执行文件 | 终端里也有"编辑器 + 重跑" | [PostgreSQL psql 文档](https://www.postgresql.org/docs/current/app-psql.html)【官方文档】 |
| C10 | 终端内上下文补全 | usql 交互式 shell 里 `Tab` 补 SQL 关键字/回斜杠命令（如 `\gexec`、`\gx`） | 命令行也具备"半补全" | [usql README](https://github.com/xo/usql)【官方仓库】 |

### 1.4 结果与验证（把"跑完看数"升级为"跑完能判断对错"）

| # | 机制 | 交互长什么样 | 收益 | 来源 |
|---|---|---|---|---|
| D1 | 结果集对比 | 两个结果集 `Compare Data`，可设容差（差值列数 ≤ 容差即视为同一条） | 改 SQL 前后直接看差异 | [DataGrip Query results](https://www.jetbrains.com/help/datagrip/viewing-query-results.html)【官方文档】 |
| D2 | 结果直接改数并提交 | 双击单元格改值 → `Submit` → 生成 DML 预览对话框确认后提交；支持多表 JOIN 结果，但 **UNION、自连接、计算列、NoSQL 不支持** | 小数据修正不用另写 UPDATE | 同上 |
| D3 | 从结果继续探索 | Metabase 的 `Explore results` 把 SQL 结果变成 Query Builder 的数据源；可视化上支持点击过滤/缩放等有限下钻 | 结果不是终点，而是下一问的起点 | [Metabase SQL editor](https://www.metabase.com/docs/latest/questions/native-editor/writing-sql)【官方文档】 |
| D4 | 执行计划（解释） | `EXPLAIN` 只看计划；`EXPLAIN ANALYSE` 实际执行并给毫秒级运行统计；结果分树/表/Raw/火焰图（总成本、启动成本） | 定位慢在哪 | [DataGrip Query execution plan](https://www.jetbrains.com/help/datagrip/query-execution-plan.html)【官方文档】 |
| D5 | 执行计划（图形化 + 重路径高亮） | 图节点显示 Cost / Rows / 占比；自动把最贵执行路径（heavy route）涂红；"折叠除重路径外全部节点"；可选 `ANALYSE/VERBOSE/COSTS/BUFFERS/TIMING` | 一眼看到瓶颈节点 | [DBeaver Query execution plan](https://dbeaver.com/docs/dbeaver/Query-Execution-Plan/)【官方文档】 |
| D6 | 表结构就地查看 | 光标停在表名上 `Ctrl+Q`，弹窗含该表的 `CREATE` DDL 等 | 不用切对象树/另开窗口 | [DataGrip run queries](https://www.jetbrains.com/help/datagrip/run-a-query.html)【官方文档】 |
| D7 | 结果导出 | 右击查询 `Export From Query` / `Execute to File`，直接落文件 | 大结果不必先进网格 | DataGrip 同上；[DBeaver SQL execution](https://dbeaver.com/docs/dbeaver/SQL-Execution/)【官方文档】 |
| D8 | AI 解释执行计划 | 图视图工具栏 `Ask AI`：解释计划并给优化建议 | 计划看不懂时的兜底 | [DBeaver Query execution plan](https://dbeaver.com/docs/dbeaver/Query-Execution-Plan/)【官方文档】 |

### 1.5 状态与复用（降低重复劳动）

| # | 机制 | 交互长什么样 | 收益 | 来源 |
|---|---|---|---|---|
| E1 | 会话/数据源随编辑器切换 | DBeaver 用 `Ctrl+9` 换连接、`Ctrl+0` 换库/schema，**保留 SQL 文本**；可"链接到当前对象树焦点" | 同一段 SQL 换环境重跑 | [DBeaver SQL editor](https://dbeaver.com/docs/dbeaver/SQL-Editor/)【官方文档】 |
| E2 | 解析模式 | DataGrip 区分 `Playground`（多条互不相关语句共用一个上下文）与 `Script`（`USE`/`SET search_path` 生效），据此决定补全与解析 | 补全在"随手写"与"整脚本"两种场景都准 | [DataGrip run queries](https://www.jetbrains.com/help/datagrip/run-a-query.html)【官方文档】 |
| E3 | 参数与变量 | DBeaver：`:param` 命名参数 + `@set` 变量 + `${var}` 插值，执行时弹 `Bind parameter(s)` 窗口；DataGrip：`?` 位置参数或 `?name` 命名参数，执行前填值 | 一条 SQL 反复跑不同输入 | [DBeaver SQL execution](https://dbeaver.com/docs/dbeaver/SQL-Execution/)【官方文档】、[DataGrip run queries](https://www.jetbrains.com/help/datagrip/run-a-query.html)【官方文档】 |
| E4 | 变量面板 | DBeaver 在编辑器侧边开 Variables tab，可增删改变量、可搜索；不必手写 `@set` | 变量可见、可管理 | [DBeaver Variables panel](https://dbeaver.com/docs/dbeaver/Variables-panel/)【官方文档】 |
| E5 | 片段库 | Metabase `Snippets` 保存/复用/共享 SQL 片段；Redash 的 Query Snippets 标题会进入补全候选 | 团队公共 CTE / 过滤条件一处维护 | [Metabase SQL editor](https://www.metabase.com/docs/latest/questions/native-editor/writing-sql)【官方文档】、[Redash writing queries](https://redash.io/help/user-guide/querying/writing-queries/)【官方文档】 |
| E6 | 收藏 / Fork / 归档 | SQLTools 有 history + bookmarks；Redash 可 fork 他人查询、归档后直链仍可用 | 复用别人写好的查询 | [SQLTools 文档](https://vscode-sqltools.mteixeira.dev/)【官方文档】、[Redash writing queries](https://redash.io/help/user-guide/querying/writing-queries/)【官方文档】 |
| E7 | 版本历史 | Metabase 对 question/dashboard/model 保留最近 15 个版本 | 改坏了能回退 | [Metabase SQL editor](https://www.metabase.com/docs/latest/questions/native-editor/writing-sql)【官方文档】 |
| E8 | 代码生成 | `Alt+Insert` 生成 function/view/index/trigger 等数据库实体骨架；结果网格里的"编辑"也能反向生成 DML | 写 DDL 不必记模板 | [DataGrip Generate code](https://www.jetbrains.com/help/datagrip/generating-code.html)【官方文档】 |
| E9 | 目录式 LLM 指令 | Snowflake Cortex Analyst 允许在语义视图中配置自定义指令（custom instructions）来约束生成 | 把业务口径固化进生成过程 | [Snowflake Cortex Analyst: custom instructions](https://docs.snowflake.cn/en/user-guide/views-semantic/custom-instructions)【官方文档（中文镜像站）】 |

### 1.6 协作与 AI

| # | 机制 | 交互长什么样 | 收益 | 来源 |
|---|---|---|---|---|
| F1 | 自然语言 → SQL（工具式） | BigQuery `SQL generation tool`：输入自然语言 → 生成 SQL；可 `Edit Table Sources` 指定表、`Refine` 追加约束（如 `limit to 1000`）、`Show diff` 对比、`Query Summary` 看自然语言摘要 | 从 0 到可跑草稿 | [BigQuery: Gemini](https://docs.cloud.google.com/bigquery/docs/write-sql-gemini)【官方文档】 |
| F2 | 注释即提示词 | 在编辑器里写 `# 自然语言` 或 `/* 自然语言 */` 注释 → 回车/点浮动 Gemini → 生成 SQL 并 `Tab` 接受；可"把注释转成 SQL"并保留原注释 | 不离开编辑器、不切换面板 | 同上 |
| F3 | AI 补全（inline） | 打字中给"下一段逻辑"，`Space`/`Enter` 触发，`Tab` 接受、`Esc` 关闭、可循环看备选 | 减少"想下一句"的停顿 | 同上 |
| F4 | AI 解释查询 | 选中 SQL → 浮动 `Gemini` → `Explain this query`，解释出现在侧边面板 | 接手陌生 SQL 的成本剧降 | 同上 |
| F5 | AI 报错修复（执行前/执行后两处入口） | 执行前：选中错误文本 → `Refine` → `Fix it`；执行后：结果面板错误旁 `Gemini suggested fixes`；都可 `Preview`(diff) / `Apply & run` | 错误现场直达修复 | 同上 |
| F6 | AI 快速修复（客户端集成） | DBeaver 编辑器错误标注 → `Ctrl+1` → `Explain and Fix` → AI Chat 给出解释与修正查询 | 同上，且与桌面客户端打通 | [DBeaver SQL Assist](https://dbeaver.com/docs/dbeaver/SQL-Assist-and-Auto-Complete/)【官方文档】 |
| F7 | AI 对话式探索 | DBeaver AI Chat；Metabase 的 Metabot 可直接"写一条 SQL 查询…" | 低门槛探索 | [DBeaver AI Assistant](https://dbeaver.com/docs/dbeaver/AI-Smart-Assistance/)【官方文档】、[Metabase SQL editor](https://www.metabase.com/docs/latest/questions/native-editor/writing-sql)【官方文档】 |
| F8 | Agent / MCP 接入 | DBeaver 文档把数据库动作按 `Data transfer / Data read / View and editor / Script / User interaction` 分类暴露给 AI 工具，并提供 MCP server | 外部 agent 可操作数据库客户端 | [DBeaver MCP server](https://dbeaver.com/docs/dbeaver/Model-Context-Protocol-Server/)【官方文档】 |

---

## 2. 真正显著提速手写 SQL 的 15 个机制

> 入选标准（三条满足其一）：(a) 直接减少击键/记忆量；(b) 减少"看别处"的上下文切换；(c) 减少一次数据库往返或等待。
> 成本类型用四类：**记忆**（想不起名字/结构）、**表达**（知道要什么但写得慢）、**验证**（不确定对不对）、**等待**（执行/往返/重跑）。

| # | 机制 | 降哪种成本 | 为什么有效（基于交互事实，不是宣传） | 来源 |
|---|---|---|---|---|
| 1 | **schema 感知补全**（表/列/别名） | 记忆 + 表达 | 补全候选来自真实元数据，用户输入首字母/中间字符即可命中；不需要先查结构再回来写 | [DataGrip Code completion](https://www.jetbrains.com/help/datagrip/auto-completing-code.html)【官方文档】 |
| 2 | **任意中间字符 + camel/snake 首字母匹配** | 记忆 | 候选过滤不要求前缀匹配，`_` 与大小写不再是障碍（DataGrip 明确"不需要通配符"） | 同上 |
| 3 | **`SELECT *` / 字段清单一键展开** | 表达 | 把"列表名"变成一次选择；DBeaver 明确：`SELECT *` 后 `Ctrl+Space` 展开所有列 | [DBeaver SQL Assist](https://dbeaver.com/docs/dbeaver/SQL-Assist-and-Auto-Complete/)【官方文档】 |
| 4 | **按外键生成 JOIN…ON** | 记忆 + 验证 | 关联条件由元数据生成，直接消灭"忘了关联列/写错关联列"两类错误 | [DataGrip Code completion](https://www.jetbrains.com/help/datagrip/auto-completing-code.html)【官方文档】 |
| 5 | **窗口函数自动 `OVER()` + 光标定位** | 表达 | 窗口函数是语法模板最固定、最容易写漏的部分，自动补全框架后只需填 `PARTITION BY/ORDER BY` | 同上 |
| 6 | **`Ctrl+Shift+Enter` 语法补全 / 括号闭合** | 表达 | 一次按键把当前构造变合法（括号、分号），省掉回删重打 | [DataGrip Advanced completion](https://www.jetbrains.com/help/datagrip/advanced-code-completion.html)【官方文档】 |
| 7 | **执行光标所在语句 / 选区** | 等待 | 是"改一句→跑一句"的核心闭环；不跑整脚本，循环周期从几十秒降到一两秒 | [DataGrip run queries](https://www.jetbrains.com/help/datagrip/run-a-query.html)、[DBeaver SQL execution](https://dbeaver.com/docs/dbeaver/SQL-Execution/)【官方文档】 |
| 8 | **结果就地显示（in-editor results）+ 结果 tab 与查询绑定** | 等待 + 上下文切换 | 结果贴着眼睛、tab 名带主表名/可 pin，迭代多轮后仍能对号入座 | [DataGrip Query results](https://www.jetbrains.com/help/datagrip/viewing-query-results.html)【官方文档】 |
| 9 | **对象导航（Ctrl+click 标识符 / F4 打开定义 / Outline 跟随光标）** | 记忆 + 上下文切换 | 从 SQL 里的表名直接跳到对象编辑器；Outline 与光标双向联动，长查询里定位段落 | [DBeaver SQL editor](https://dbeaver.com/docs/dbeaver/SQL-Editor/)【官方文档】 |
| 10 | **实时检查 + 快速修复入口（灯泡/`Ctrl+1`）** | 验证 | 错误在书写阶段暴露；修复入口就在错误旁边，不需要复制报错去搜 | [DataGrip Intention actions](https://www.jetbrains.com/help/datagrip/intention-actions.html)、[DBeaver SQL Assist](https://dbeaver.com/docs/dbeaver/SQL-Assist-and-Auto-Complete/)【官方文档】 |
| 11 | **执行计划内联查看（含 `Explain Analyse` 实测耗时、重路径高亮）** | 验证 + 等待 | 从"猜为什么慢"变成"看哪一步贵"；DBeaver 还把最贵路径直接标红 | [DataGrip Query execution plan](https://www.jetbrains.com/help/datagrip/query-execution-plan.html)、[DBeaver Query execution plan](https://dbeaver.com/docs/dbeaver/Query-Execution-Plan/)【官方文档】 |
| 12 | **查询历史可搜索、双击回填** | 记忆 + 表达 | 复用"上次跑通过的那条"，比重新组织 SQL 快一个数量级 | [DataGrip run queries](https://www.jetbrains.com/help/datagrip/run-a-query.html)【官方文档】 |
| 13 | **片段库进入补全候选** | 表达 | Redash 把 Query Snippets 的标题并入补全候选：公共片段和表名一样被"想得起来" | [Redash writing queries](https://redash.io/help/user-guide/querying/writing-queries/)【官方文档】 |
| 14 | **AI 生成/修复走"预览 diff → 接受/拒绝"** | 表达 + 验证 | 把 AI 输出当候选补丁而非黑盒答案：`Preview` 看 diff、`Apply & run` 直接跑、`Decline` 丢弃 | [BigQuery: Gemini](https://docs.cloud.google.com/bigquery/docs/write-sql-gemini)【官方文档】 |
| 15 | **命令式兜底交互（`\e` 外部编辑器、`\watch` 重跑、`\gexec`）** | 等待 + 表达 | 终端里也保留"写—跑—重跑"的闭环，且能把一组查询结果再当 SQL 执行 | [PostgreSQL psql 文档](https://www.postgresql.org/docs/current/app-psql.html)【官方文档】、[usql README](https://github.com/xo/usql)【官方仓库】 |

补充说明（避免误读）：
- 第 1–6 项是**纯前端可完成的"少打字"层**，与是否连上 AI 无关；它们的收益在 DataGrip/DBeaver 这类 IDE 上被文档明确描述，但**没有公开的量化节省数据**，故不引用任何百分比。
- 第 14 项真正的价值不只是"生成"，而是**把接受动作做成可比较的补丁**；BigQuery 的 `Refine`/`Show diff`/`Preview` 是这一点的直接证据。
- 第 15 项的 psql 命令属于长期稳定的官方行为；本文引用其文档页，但未逐条抓取命令说明原文，若需引用具体命令语义建议二次核对（见 §5 尾部说明）。

---

## 3. 重客户端依赖 vs 轻量插件可做

判断依据分四类：
- **是否需要 LSP / 完整语义解析器**（类型推断、作用域、跨语句 resolve）；
- **是否需要数据库连接与方言知识**（元数据、EXPLAIN 结构、DML 生成）；
- **是否需要本地文件/进程/运行时**（Python、CLI、IDE 平台能力）；
- **是否需要模型与数据出境授权**（AI 类）。

| 机制 | 轻量插件可做？ | 判断依据 | 来源 |
|---|---|---|---|
| schema 感知补全（表/列） | ✅ **可做** | CodeMirror 6 的 `@codemirror/lang-sql` 原生提供 `schema`、`schemaCompletionSource`、`defaultTable`、`defaultSchema`、`keywordCompletion`，只要把对象树/元数据喂进去即可，不需要 LSP | [npm @codemirror/lang-sql](https://www.npmjs.com/package/@codemirror/lang-sql)【官方仓库】 |
| 关键字/方言补全 | ✅ 可做 | 同一 API 支持自定义 `SQLDialect`（keywords/builtin/types…）与 `keywordCompletionSource`；内置 PostgreSQL/MySQL/MariaSQL/MSSQL/SQLite 等方言 | 同上 |
| 字段清单展开、`SELECT *` 展开 | ✅ 可做 | 属于"AST + 元数据"级操作；列清单来自元数据，不需要服务端解析 | [DBeaver SQL Assist](https://dbeaver.com/docs/dbeaver/SQL-Assist-and-Auto-Complete/)【官方文档】（机制存在） |
| 括号/分号补全、别名生成 | ✅ 可做 | 纯本地文本/语法操作；DataGrip 的 statement completion 本质是语法层 | [DataGrip Advanced completion](https://www.jetbrains.com/help/datagrip/advanced-code-completion.html)【官方文档】 |
| 执行光标所在语句/选区 | ✅ 可做 | 只需一个"按方言切分语句 + 找光标所在区间"的轻量分段器，然后发一次请求 | [DataGrip run queries](https://www.jetbrains.com/help/datagrip/run-a-query.html)【官方文档】 |
| 结果就地显示、结果 tab 绑定 | ✅ 可做 | 插件已有结果网格，属于布局与状态管理 | [DataGrip Query results](https://www.jetbrains.com/help/datagrip/viewing-query-results.html)【官方文档】 |
| 查询历史/收藏/片段 | ✅ 可做 | 本地存储即可；点击回填是编辑器 API 操作 | [DataGrip run queries](https://www.jetbrains.com/help/datagrip/run-a-query.html)、[SQLTools 文档](https://vscode-sqltools.mteixeira.dev/)【官方文档】 |
| 参数化查询 | ✅ 可做（需注意注入） | 前端弹窗收集值 + 生成最终 SQL；DBeaver/DataGrip 的"绑定参数"都是客户端侧替换 | [DBeaver SQL execution](https://dbeaver.com/docs/dbeaver/SQL-Execution/)【官方文档】 |
| 对象导航（Ctrl+click 名字） | ✅ 可做 | 对象树已有元数据，编辑器侧做"点击名字→定位树节点"即可 | [DBeaver SQL editor](https://dbeaver.com/docs/dbeaver/SQL-Editor/)【官方文档】 |
| 语法级实时检查（括号/未闭合/关键字顺序） | 🟡 可做，但有限 | CodeMirror 有语法树可查，但没有类型系统；"未使用子查询列"这类**语义级**检查需要自行实现规则 | [DataGrip Code inspections](https://www.jetbrains.com/help/datagrip/code-inspection.html)【官方文档】（该类检查依赖 IDE 语义模型） |
| 语义级检查（列是否存在、类型是否可比、作用域解析） | 🔴 偏重 | DataGrip 需要为每条语句建立 resolve 上下文（Playground/Script 两种模式、schema selector），DBeaver 的 Semantic 引擎要"读全库表/列"并依赖通用 SQL 语法；这是解析器+元数据工程 | [DataGrip run queries](https://www.jetbrains.com/help/datagrip/run-a-query.html)、[DBeaver SQL Assist](https://dbeaver.com/docs/dbeaver/SQL-Assist-and-Auto-Complete/)【官方文档】 |
| 意图动作/重构（重命名、提取） | 🟡 有限可做 | 单文件内的字符串级动作可做；跨对象重命名需要可靠的作用域解析与全库引用 | [DataGrip Code refactoring](https://www.jetbrains.com/help/datagrip/refactoring-source-code.html)【官方文档】 |
| 执行计划可视化 | 🟡 树/表格可做，图形化偏重 | 取计划只需发 `EXPLAIN`（连接已有），但**解析与可视化各数据库输出格式不同**；DBeaver 的图视图与 heavy-route 判断是逐库适配的 | [DataGrip Query execution plan](https://www.jetbrains.com/help/datagrip/query-execution-plan.html)、[DBeaver Query execution plan](https://dbeaver.com/docs/dbeaver/Query-Execution-Plan/)【官方文档】 |
| 结果对比 | 🟡 可做（只读） | 两结果集 diff 是纯前端；DataGrip 还提供容差参数 | [DataGrip Query results](https://www.jetbrains.com/help/datagrip/viewing-query-results.html)【官方文档】 |
| 结果单元格编辑并回写数据库 | 🔴 偏重 | 需要主键/唯一键识别、生成 DML、事务与 diff 预览；DataGrip 明确列出多种不支持场景（UNION、自连接、计算列、NoSQL），说明这不是"顺手做"的功能 | 同上 |
| 格式化成因 | 🟡 可做（要选型） | 纯 JS 格式化器可以嵌进插件；SQLFluff 是 Python 项目、面向 CI/CLI，嵌入桌面插件需要带运行时 | [SQLFluff: Why SQLFluff?](https://docs.sqlfluff.com/en/stable/guide/why.html)【官方文档】 |
| AI 内联补全 / 注释生成 / 修复 | 🟡 可做（依赖模型与授权） | 需要模型端点 + schema 上下文 + 数据出境/隐私策略；BigQuery 的实现把生成、refine、diff、table sources 都做在服务端，客户端只负责交互 | [BigQuery: Gemini](https://docs.cloud.google.com/bigquery/docs/write-sql-gemini)【官方文档】 |
| Agent / MCP 工具化 | 🔴 依赖宿主能力 | 需要"工具调用 + 权限 + 审计"的宿主支持；DBeaver 的做法是把动作分类后暴露为 MCP 工具 | [DBeaver MCP server](https://dbeaver.com/docs/dbeaver/Model-Context-Protocol-Server/)【官方文档】 |
| 多方言支持 | 🔴 重（长期） | DataGrip/DBeaver 的核心资产是方言语法 + 驱动生态；插件若只支持 Doris/MySQL，可把"方言库"成本压到很低 | [DataGrip Code completion](https://www.jetbrains.com/help/datagrip/auto-completing-code.html)【官方文档】（SQL 方言设置贯穿补全/模板） |

**一句话判断（推断）**：轻量插件的甜蜜区是「**元数据驱动的补全 + 语法级少打字动作 + 单语句执行 + 就地结果**」这四层；**语义级检查、结果回写、图形化执行计划、agent 化**属于重客户端能力，仓促实现会变成"看起来有、实际不敢用"。

---

## 4. 反面清单：哪些"功能"实际增加摩擦

> 规则：**有文档证据的写证据；没有证据、只有机制推理的明确标「推断」**。本节不针对任何产品的整体评价，只针对机制。

| # | 反模式 | 证据 / 理由 | 标记 |
|---|---|---|---|
| N1 | **重模板系统**（多类型、多变量、多上下文） | DataGrip 的 live templates 同时存在"固定文本 / 带变量 / 包裹选区"三类，模板有变量编辑、上下文（可按 SQL 方言限定）、展开键、是否按代码风格重排等设置；功能完备，但**要用户先学会一整套概念**。 | 证据（[Live templates](https://www.jetbrains.com/help/datagrip/using-live-templates.html)【官方文档】）+ **推断**（学习成本→低使用率；无公开使用率数据） |
| N2 | **参数化查询每次执行都弹参数框** | DBeaver 文档原文：*"Upon every execution of the parameterized query, DBeaver brings up the Bind parameter(s) window."*；DataGrip 同样在运行参数化语句前要求填值。 | 证据（[DBeaver SQL execution](https://dbeaver.com/docs/dbeaver/SQL-Execution/)【官方文档】）+ **推断**（对"改一个字再跑"的迭代节奏是打断） |
| N3 | **超大 schema 下的实时补全** | Redash 明确：schema 超过 5000 个 token（表/列）时，默认**关闭** live autocomplete，只能手动 `Ctrl+Space`。这说明补全本身有可观开销。 | 证据（[Redash writing queries](https://redash.io/help/user-guide/querying/writing-queries/)【官方文档】）+ **推断**（重客户端把开销藏起来了，轻量端更容易被感知为卡） |
| N4 | **语义分析/全量元数据读取默认开启** | DBeaver 的 Semantic 补全引擎要求同时开启 `Enable semantic analysis` 与 `Read database table/columns for semantic analysis`，否则精度下降；文档还提示该引擎"对某些库特有语法可能不正确"，建议有问题时切回 Legacy。 | 证据（[DBeaver SQL Assist](https://dbeaver.com/docs/dbeaver/SQL-Assist-and-Auto-Complete/)【官方文档】）+ **推断**（连接慢/权限受限时体验反而更差） |
| N5 | **强制格式化 / 保存即格式化** | 可以作为"团队一致性"的正解（SQLFluff 就是以 lint 强制风格为目标），但探索式写作阶段格式化会打断节奏；Metabase 的格式化还只支持部分方言（SQLite/SQL Server 不可用）。 | 证据（[Metabase SQL editor](https://www.metabase.com/docs/latest/questions/native-editor/writing-sql)、[SQLFluff](https://docs.sqlfluff.com/en/stable/guide/why.html)【官方文档】）+ **推断**（探索期摩擦） |
| N6 | **危险操作二次确认过多** | DBeaver：执行 `DROP TABLE/SCHEMA` 前弹确认（"Possible data loss. Are you sure?"），可 `Yes to All` 或"不再询问"；DataGrip：`DELETE/UPDATE` 无 `WHERE` 时编辑期提示 + 执行期再警告一次（可"仍然执行"）。两家都给了"关闭/跳过"出口。 | 证据（[DBeaver SQL execution](https://dbeaver.com/docs/dbeaver/SQL-Execution/)、[DataGrip Code inspections](https://www.jetbrains.com/help/datagrip/code-inspection.html)【官方文档】）+ **推断**（若不提供跳过出口就是摩擦；提供后是净收益） |
| N7 | **结果网格直接编辑回写当卖点** | DataGrip 的"编辑结果并 Submit"在 `UNION`、表自连接、含计算列（如 `CONCAT`）的结果集和 NoSQL 上**不支持**，且需要每行有能唯一定位的字段。也就是说：查询越复杂，这个功能越不可用——用它当核心卖点会误导。 | 证据（[DataGrip Query results](https://www.jetbrains.com/help/datagrip/viewing-query-results.html)【官方文档】）+ **推断**（复杂查询下用户会先被试错） |
| N8 | **全量 IDE 化（检查配置、严重级别、profile）** | DataGrip 的 inspections 有 severity 分级、profile 分组、按 scope 扫描、可"默认禁用新检查"等设置。能力很强，但为"偶尔写 SQL"的用户引入了配置面。 | 证据（[DataGrip Code inspections](https://www.jetbrains.com/help/datagrip/code-inspection.html)【官方文档】）+ **推断**（配置面 vs 收益不匹配时是负担） |
| N9 | **范围过窄导致"看似能写其实不能写"** | Metabase 原生 SQL 编辑器明确不支持多语句、存储过程/函数调用、DDL；在 impersonation 下强制单条 `SELECT`。对 BI 场景合理，但如果用户把它当 SQL 工作台会撞墙。 | 证据（[Metabase SQL editor](https://www.metabase.com/docs/latest/questions/native-editor/writing-sql)【官方文档】）+ **推断**（边界要显式告知） |
| N10 | **功能入口分散在多个快捷键/面板** | DataGrip：执行/执行全部/Explain/Explain Analyse/In-Editor Results/Query History 分属不同按钮与快捷键；DBeaver：执行当前语句、新 tab 执行、跑脚本、每条语句独立 tab 四个动作四个快捷键。功能都对，但**新用户很难建立"我该按哪个"的直觉**。 | 证据（[DataGrip run queries](https://www.jetbrains.com/help/datagrip/run-a-query.html)、[DBeaver SQL execution](https://dbeaver.com/docs/dbeaver/SQL-Execution/)【官方文档】）+ **推断**（入口数量与学习成本正相关） |

---

## 5. 事实 vs 推断（明确分栏）

### 5.1 已验证事实（均来自上列官方文档原文）

1. DataGrip 的补全会按上下文给出字段列表、按外键生成 JOIN 条件、自动生成表别名、窗口函数补 `OVER()`、支持任意中间字符匹配与 camel/snake 首字母匹配，且补全弹窗默认随输入自动出现。([Code completion](https://www.jetbrains.com/help/datagrip/auto-completing-code.html)【官方文档】)
2. DataGrip 有"语句补全"（`Ctrl+Shift+Enter` 补齐括号/分号）与"类型匹配补全"（`Ctrl+Shift+Space`）。([Advanced completion](https://www.jetbrains.com/help/datagrip/advanced-code-completion.html)【官方文档】)
3. DataGrip 的意图动作可悬停预览、可给单个动作绑定快捷键；示例包含"引入表别名"与"`GROUP BY` 改 `DISTINCT`"。([Intention actions](https://www.jetbrains.com/help/datagrip/intention-actions.html)【官方文档】)
4. DataGrip 有"未使用子查询项"检查，以及 `DELETE/UPDATE` 无 `WHERE` 的编辑期+执行期双重提醒（执行期可点 Execute 继续）。([Code inspections](https://www.jetbrains.com/help/datagrip/code-inspection.html)【官方文档】)
5. DataGrip 支持 `EXPLAIN`（只计划）与 `EXPLAIN ANALYSE`（实际执行并给毫秒统计），计划可分树/Raw/火焰图视图，并可复制数据库原生格式计划。([Query execution plan](https://www.jetbrains.com/help/datagrip/query-execution-plan.html)【官方文档】)
6. DataGrip 可把结果放进编辑器（In-Editor Results），结果 tab 可由查询前注释自定义标题、可 pin、可对比两个结果集（带容差参数）、可直接改单元格并生成 DML 预览后提交（UNION/自连接/计算列/NoSQL 不支持）。([Query results](https://www.jetbrains.com/help/datagrip/viewing-query-results.html)【官方文档】)
7. DataGrip 执行时"只跑光标所在语句或选区"，并有 Query History（`Ctrl+Alt+E`）双击回填；`Ctrl+Q` 可看表结构 DDL；参数支持位置式与命名式两种模式。([Run queries](https://www.jetbrains.com/help/datagrip/run-a-query.html)【官方文档】)
8. DBeaver 的补全有三种引擎（Semantic/Legacy/Combined）；Semantic 需开启语义分析与"读取库表/列"；`SELECT *` 后 `Ctrl+Space` 可展开列；错误旁 `Ctrl+1` → `Explain and Fix` 需要启用 AI Assistant。([SQL Assist and Auto Complete](https://dbeaver.com/docs/dbeaver/SQL-Assist-and-Auto-Complete/)【官方文档】)
9. DBeaver 明确区分"执行光标所在语句/选区"、"在新 tab 执行当前语句"、"执行整个脚本"、"每条语句独立 tab 并行执行"四种动作，并给 `DROP` 加确认。([SQL execution](https://dbeaver.com/docs/dbeaver/SQL-Execution/)【官方文档】)
10. DBeaver 参数化：`:param` 命名参数、`?` 匿名参数、`@set` 定义变量、`${var}`/`:var` 插值；**参数化查询每次执行都会弹出绑定窗口**。([SQL execution](https://dbeaver.com/docs/dbeaver/SQL-Execution/)【官方文档】)
11. DBeaver 的执行计划图视图会把最贵路径（heavy route）标红、按 Cost/Rows/占比着色，可"只展开重路径"，并支持 `ANALYSE/VERBOSE/COSTS/BUFFERS/TIMING` 等选项与 `Ask AI` 解释。([Query execution plan](https://dbeaver.com/docs/dbeaver/Query-Execution-Plan/)【官方文档】)
12. DBeaver 编辑器支持 `Ctrl+click` 把标识符当超链接打开对象编辑器；Outline 与光标双向联动；错误提示区分服务端/语义/拼写错误。([SQL Editor](https://dbeaver.com/docs/dbeaver/SQL-Editor/)【官方文档】)
13. Redash：`Alt+D` 切换 schema 浏览器，点击双箭头把表/列插入查询；补全候选包含 schema token、语法关键字与 Query Snippets 标题；**schema 超过 5000 token 时默认关闭实时补全**；`Ctrl+Enter` 执行、`Ctrl+Space` 切换补全。([Writing queries](https://redash.io/help/user-guide/querying/writing-queries/)【官方文档】)
14. Metabase 原生 SQL 编辑器：`Ctrl/Cmd+Enter` 执行、可只跑选中部分；有"格式化"按钮但仅对 SQL 且 SQLite/SQL Server 不可用；支持 Snippets、SQL 变量/参数过滤控件、`Explore results` 转 Query Builder、最近 15 版历史；**不支持多语句、存储过程、DDL**。([SQL editor](https://www.metabase.com/docs/latest/questions/native-editor/writing-sql)【官方文档】)
15. BigQuery Gemini：支持按自然语言/注释生成 SQL（`#` 或 `/* */` 注释，`Tab` 接受）、SQL 生成工具（指定 table sources、`Refine`、`Show diff`、`Query Summary`）、内联补全（Preview）、`Explain this query`、执行前 `Fix it` 与执行后 `Gemini suggested fixes`；均提供 `Preview`/`Apply & run`/`Decline` 一类确认动作。([Write queries with Gemini](https://docs.cloud.google.com/bigquery/docs/write-sql-gemini)【官方文档】)
16. CodeMirror 6 的 `@codemirror/lang-sql` 提供 `sql({dialect, schema, defaultTable, defaultSchema, upperCaseKeywords, keywordCompletion})`，并导出 `schemaCompletionSource` / `keywordCompletionSource`，还允许自定义 `SQLDialect`。([npm @codemirror/lang-sql](https://www.npmjs.com/package/@codemirror/lang-sql)【官方仓库】)
17. SQLFluff 的定位是"SQL linter"，目标是代码质量保证（可读性/一致性），并支持 jinja/python 模板与 dbt 项目以在 CI/CD 中检查动态 SQL。([Why SQLFluff?](https://docs.sqlfluff.com/en/stable/guide/why.html)【官方文档】)
18. SQLTools（VS Code）提供：SQL 美化/格式化、查询运行器、历史与收藏、连接浏览器、INSERT 生成器、可插拔驱动架构。([SQLTools 文档](https://vscode-sqltools.mteixeira.dev/)【官方文档】)
19. usql 支持 psql 风格的变量、反斜杠命令、`Tab` 上下文补全（含 `\gexec`/`\gx` 等）、交互式语法高亮、`\pset` 显示格式设置。([usql README](https://github.com/xo/usql)【官方仓库】)
20. DBeaver 文档目录中存在 MCP server 与按"数据传输/数据读取/视图与编辑器/脚本/用户交互"分类的 AI 工具页。([MCP server](https://dbeaver.com/docs/dbeaver/Model-Context-Protocol-Server/)【官方文档】)

### 5.2 推断（无公开数据，仅为机制分析，供方案取舍时质疑）

1. **"补全比 AI 更值得先做"**：因为补全的收益不依赖模型质量，且 CodeMirror 原生支持；但**没有公开 A/B 数据**证明补全对比 AI 的提速比例。
2. **N1/N2/N8/N10 的"摩擦"结论**：都是基于"需要额外学习/额外弹窗/额外入口"的机制推理，缺少使用率与耗时实测。
3. **"结果就地显示优于独立结果 tab"**：DataGrip 同时提供两种模式（可切换），说明**不存在单一最优**；插件右栏空间有限时，就地显示的边际收益可能更高，但这只是推断。
4. **"轻量插件不应做结果回写"**：依据是 DataGrip 的支持范围限制（UNION/自连接/计算列不支持），推断"若要覆盖这些边界，成本会迅速超过收益"。
5. **"SQLFluff 不适合内嵌轻量插件"**：依据是其 Python 生态与 CI 定位；未验证是否存在可嵌入的 WASM/JS 端口，也未评估启动成本。
6. **"agent 式数据探索会成为主流入口"**：DBeaver 提供 MCP、BigQuery 提供对话式生成，说明方向存在；但**采用率、留存、真实提速均无数据**，不应在方案里当作既定趋势。
7. **关于 §0 第 1 条的"往返次数决定流畅度"**：是对多个产品默认动作（执行当前语句 + 就地结果 + 历史回填）的归纳，不是任何文档的原话。

### 5.3 取证缺口（未覆盖 / 需要补的）

- **PopSQL、Hex**：本次未取得可引用的官方文档原文（站点抓取成本高/页面结构重），故正文未给出其机制结论，避免臆测。
- **Databricks Assistant**：检索到的 `learn.microsoft.com/.../use-databricks-assistant` 已 404（内容迁移），未取得有效原文，正文未引用。
- **Rainbow CSV**：未取证，正文未引用（仅任务范围内提及，属结果侧着色，对"写 SQL"影响弱）。
- **sql-formatter**：仓库 README 抓取失败（npm 页 403），正文只在"格式化成因可选型"层面提及，未引用其具体参数。
- **psql 具体命令语义**（`\e`/`\watch`/`\x`/`\gexec`）：正文按长期稳定的官方命令引用其文档页，未逐条抓取命令说明；若方案要照搬，建议以该文档页二次核对。
- **任何"提速百分比/使用率"数据**：本次未找到可信公开来源，正文刻意不写数字。

---

## 附录 A：本报告引用的 URL 清单（按产品）

**JetBrains DataGrip（官方文档，2026.2 版）**
- 补全：<https://www.jetbrains.com/help/datagrip/auto-completing-code.html>
- 高级补全：<https://www.jetbrains.com/help/datagrip/advanced-code-completion.html>
- 意图动作：<https://www.jetbrains.com/help/datagrip/intention-actions.html>
- 代码检查：<https://www.jetbrains.com/help/datagrip/code-inspection.html>
- Live templates：<https://www.jetbrains.com/help/datagrip/using-live-templates.html>
- 生成代码：<https://www.jetbrains.com/help/datagrip/generating-code.html>
- 重构：<https://www.jetbrains.com/help/datagrip/refactoring-source-code.html>
- 执行查询：<https://www.jetbrains.com/help/datagrip/run-a-query.html>
- 查询结果：<https://www.jetbrains.com/help/datagrip/viewing-query-results.html>
- 执行计划：<https://www.jetbrains.com/help/datagrip/query-execution-plan.html>

**DBeaver（官方文档）**
- SQL Editor：<https://dbeaver.com/docs/dbeaver/SQL-Editor/>
- SQL Assist / 补全：<https://dbeaver.com/docs/dbeaver/SQL-Assist-and-Auto-Complete/>
- SQL 执行（参数/变量/结果 tab）：<https://dbeaver.com/docs/dbeaver/SQL-Execution/>
- 变量面板：<https://dbeaver.com/docs/dbeaver/Variables-panel/>
- 执行计划：<https://dbeaver.com/docs/dbeaver/Query-Execution-Plan/>
- AI Assistant：<https://dbeaver.com/docs/dbeaver/AI-Smart-Assistance/>
- MCP server：<https://dbeaver.com/docs/dbeaver/Model-Context-Protocol-Server/>

**VS Code SQL 生态**
- SQLTools：<https://vscode-sqltools.mteixeira.dev/>（官方仓库 <https://github.com/mtxr/vscode-sqltools>）
- SQLFluff：<https://docs.sqlfluff.com/en/stable/guide/why.html>
- sql-formatter（仅提及，未取证细节）：<https://github.com/sql-formatter-org/sql-formatter>

**现代 Web SQL / BI**
- Redash 写查询：<https://redash.io/help/user-guide/querying/writing-queries/>
- Metabase SQL 编辑器：<https://www.metabase.com/docs/latest/questions/native-editor/writing-sql>
- Metabase Snippets：<https://www.metabase.com/docs/latest/questions/native-editor/snippets>
- Metabase SQL 参数：<https://www.metabase.com/docs/latest/questions/native-editor/sql-parameters>

**终端 / DB shell**
- PostgreSQL psql：<https://www.postgresql.org/docs/current/app-psql.html>
- usql：<https://github.com/xo/usql>

**AI（2025–2026）**
- BigQuery Gemini 写 SQL：<https://docs.cloud.google.com/bigquery/docs/write-sql-gemini>
- Snowflake Cortex Analyst 自定义指令：<https://docs.snowflake.cn/en/user-guide/views-semantic/custom-instructions>（中文镜像站）

**编辑器基础设施（决定轻量插件可行性）**
- `@codemirror/lang-sql`：<https://www.npmjs.com/package/@codemirror/lang-sql>
- CodeMirror 官方文档：<https://codemirror.net/docs/>

## 附录 B：本插件的对照速查（仅外部参照，不是方案）

| 本插件已有 | 外部对应机制 | 差距（事实层面） |
|---|---|---|
| CodeMirror 6 编辑器 | DataGrip 编辑器 / CodeMirror 原生 lang-sql | 是否已接 `schema`/`schemaCompletionSource`、是否配置方言（MySQL vs Doris 差异）需确认 |
| 对象树 | DBeaver Database Navigator / Redash Schema Browser | 外部产品把"树 → 编辑器"做成双向：点击插入名字、Ctrl+click 回跳对象、Outline 跟随光标 |
| 结果网格 | DataGrip Data Editor / DBeaver Data Editor | 外部常见"结果 tab 与查询绑定 + pin + 对比 + 导出 + 历史"；是否已有这些状态管理需确认 |
| 连接 Doris/MySQL | 多方言支持 | 方言差异会影响补全关键字、格式化、`EXPLAIN` 解析；CodeMirror 内置 MySQL 方言但 Doris 需自定义 `SQLDialect` |

（对照表只列"外部有、需要核对自己有没有"的机制，不构成实现建议。）
