# 09 — 待办清单（唯一事实源）

> 本文件是**唯一的待办清单**。`07-MILESTONES.md` 只记录「做过什么」，不再维护「还要做什么」——避免两份清单打架。
> 每项都基于代码事实（不是猜测），括号里给出可核对的入口。完成一项就删掉一项并把记录写进 07。

**最后盘点**：2026-10-20（本次开发收尾）
**当前状态**：M0–M2 全部完成；右栏面板可用（连接 / 对象树 / 编辑 / 结果 / git），agent 侧 6 个 MCP 工具可用。

---

## 1. 优先级总览

| 级别 | 含义 | 项 |
|---|---|---|
| **P0** | 小改动、天天受益，且能立刻验收 | （本轮已清空） |
| **P1** | 明显提升手感/效率 | B4 console 持久化 · B5 查询历史 · B6 结果区查找 · B7 列显隐 · B8 导出增强 |
| **P2** | 工程债与打磨 | B9 补全标签中文化 · B10 脚本结果按语句筛选 · B11 测试耗时 · B12 bundle 体积 · B13 审计日志 |
| **不做** | 明确排除，见 §4 | — |

建议执行顺序：**B4 → B5**（都是「小改动 + 立刻可验证」），再做 P1 的 B6–B8。

> **已完成并移除**：B1 MCP schema 工具、B2 「打开 SQL 工作台」入口、B3 布局尺寸持久化（均 2026-10-21，记录见 `07-MILESTONES` §7 的「批次 8」与「补齐（2026-10-21）」两节）。

---

## 2. P0：小改动、天天受益

**已清空**（2026-10-21）：B1 MCP schema 工具、B2 工作台入口、B3 布局尺寸持久化 全部完成并从本文件移除，记录见 `07-MILESTONES` §7。新的 P0 候选出现时再加回本节。

## 3. P1 / P2

### B4 console 内容持久化

| 项 | 内容 |
|---|---|
| 现状 | 刷新页面后 console 里的 SQL 全丢：documents 是纯客户端状态，宿主没有持久化对应物 |
| 影响 | 误刷新就丢工作（用户已明确提过） |
| 成本 | 小～中（documents → KvStore，注意防抖与多 tab 顺序） |
| 验收 | ① 刷新后 tab 标题、SQL、活动 tab、页大小都回来；② 不持久化结果集（太大）；③ 存储超限时降级为「只留活动 tab」 |

### B5 查询历史

| 项 | 内容 |
|---|---|
| 现状 | 未做；`host/binding.ts:39` 预留了 `history` 文档名 |
| 影响 | 昨天跑过的 SQL 找不回来 |
| 成本 | 小～中（环形存储 N 条 + 编辑器上方历史下拉；成功/失败都记，标记耗时与时间） |
| 验收 | ① 每次执行入库（含失败）；② 最多保留 N 条（建议 200）且按连接区分；③ 点历史项插入或替换当前 SQL；④ 不记录密码类字面量（可选：提示而非自动脱敏） |

### B6 结果区查找（Find on Current Page）

| 项 | 内容 |
|---|---|
| 现状 | `Ctrl+F` 只在 CodeMirror 里生效；结果网格没有查找 |
| 影响 | 500 行结果里找一个值只能靠肉眼 |
| 成本 | 小～中（在当前页已加载的行里定位并高亮 + 上下跳） |
| 验收 | ① `Ctrl+F` 在网格聚焦时打开查找框；② 命中高亮、`Enter`/`Shift+Enter` 上下跳；③ 与列筛选共存（在筛选后的行里找）；④ 明确标注「仅当前页」 |

### B7 列显隐 + Reset（View Options 的核心那半）

| 项 | 内容 |
|---|---|
| 现状 | 只有列宽拖拽，没有隐藏列；宽表（100+ 列）横向滚动很难用 |
| 影响 | 宽结果集要一直横向滚 |
| 成本 | 小（列清单勾选 + 状态栏提示 + Reset） |
| 验收 | ① 勾选控制显示列；② 至少保留一列；③ Reset 恢复全列与默认列宽；④ 选择跨页保持 |

### B8 导出增强（INSERT / JSON）

| 项 | 内容 |
|---|---|
| 现状 | 导出只有 CSV / TSV / XLSX（`grid.ts` 的 `toCsv`、`ResultGrid` 的导出格式） |
| 影响 | 拿结果去造测试数据、喂给别的系统不方便 |
| 成本 | 小（加两个序列化器 + 菜单项） |
| 验收 | ① INSERT 语句按表名/列名生成，字符串正确转义、NULL 用 `NULL`；② JSON 为数组对象；③ 与列筛选/排序后的当前结果一致 |

### B9 补全弹窗类型标签中文化

| 项 | 内容 |
|---|---|
| 现状 | CodeMirror 自带的 `keyword` / `table` / `column` 文案仍是英文 |
| 影响 | 中文界面里混英文标签 |
| 成本 | 小（自定义 completion source 的 label，或覆写 `completion.type` 文案） |
| 验收 | 补全项显示「关键字 / 表 / 列」 |

### B10 脚本结果按语句筛选

| 项 | 内容 |
|---|---|
| 现状 | 多语句执行后的结果标签**不显示漏斗**（`ScriptResults` 传 `filterEnabled={false}`） |
| 影响 | 脚本里某条语句的结果无法筛选 |
| 成本 | 中（筛选状态要从 console 级下沉到 statement 级） |
| 验收 | 每个语句标签各自维护筛选条件，互不影响 |

### B11 测试耗时（CodeMirror 之后）

| 项 | 内容 |
|---|---|
| 现状 | 全量套件 ~17s → **~2m15s**：每个 jsdom 测试文件都要初始化 CodeMirror |
| 影响 | 每次 precommit 要等两分多钟 |
| 成本 | 中（可选：`isolate:false` 复用模块、把不碰编辑器的面板 spec 里的 EditorView mock 掉、或把 editor 相关用例集中到一个文件） |
| 验收 | 全量回到 1 分钟内，覆盖率仍 per-file 100% |

### B12 bundle 体积

| 项 | 内容 |
|---|---|
| 现状 | `client.js` 176KB → **513KB**（gzip 167KB），已开 `minify` |
| 影响 | 加载/解析变慢；仓库产物变大 |
| 成本 | 小（评估裁掉 `@codemirror/search` 或折叠扩展）～中（改按需加载） |
| 验收 | 保持现有功能的前提下，说明每一项被裁掉的代价；不裁也行，但要在 06 里写明当前体积基线 |

### B13 审计日志

| 项 | 内容 |
|---|---|
| 现状 | 只读门禁、DDL 黑名单都有，但没有「谁在什么时候跑了什么」 |
| 影响 | agent 侧安全追溯缺一环（风险 R6 的缓解项） |
| 成本 | 小～中（执行入口统一记一条：时间/连接/语句摘要/是否放行/耗时） |
| 验收 | 本地可查最近 N 条；不记录密码；写操作与拒绝都要记 |

### 其它（暂不排期）

| # | 项 | 现状 |
|---|---|---|
| B14 | 复制连接 | 未做（建同类连接要重填） |
| B15 | 执行计划 / EXPLAIN 视图 | 未做 |
| B16 | 对象树的键/索引/触发器节点 | 未做（PRD N2 已注明） |
| B17 | 结果集 `View as`（Transpose / Tree / Text） | 未做 |

---

## 4. 明确不做（防范围蔓延，改主意需先改本节）

| 项 | 理由 |
|---|---|
| 单元格编辑回写（N1） | 只读定位；改数据回 DataGrip |
| 事务 / 手动提交、会话管理 | 同上，且引入连接池语义复杂度 |
| SSH / SSL 隧道（N3） | 现有数据源都内网直连 |
| Oracle / Java 桥（N7） | 基本不用，且随包分发有 OTN 负担 |
| 多结果集（`CALL` 多结果） | 场景少；mysql2 只取第一个结果集需较大改造 |
| 图表 / Geo Viewer / Compare Data / Copy to Database | 超出「轻量 SQL 工作台」定位 |

---

## 5. 本次开发已收尾的范围（2026-10-20）

| 提交 | 内容 |
|---|---|
| `cd0a244` | 编辑器换 CodeMirror 6：删除 900 行自研编辑器（highlight/editor/caret/completion 引擎），bundle 513KB（gzip 167KB） |
| `3c857a9` | 对象树：视图缺失（COLUMNS 不返回视图列）、右键菜单点击失效两个真 bug；去掉 T/V 徽标、放大箭头 |
| `ea14476` | 视图 DDL 被拒时给人话提示（剥 `errCode` 外壳 + 按模式翻译），覆盖「返回 ok:false」与「抛异常」两种到达形态 |
| `eda95d0` | DDL 进编辑区（新 console 标签）、错误改右下角提示、补齐查询工具栏（执行/取消/复制/清空/行数/ⓘ） |
| `624ba75` | 剪贴板三级策略：被拒不再冒未处理拒绝并给出提示 |
| `5296ce3` | 字段筛选升级为服务端 WHERE（10 个操作符，进 COUNT）；顺带修 BIGINT 识别与工具栏溢出 |

已验证：51 个测试文件全绿、per-file 100%、`precommit` 通过；真机逐项确认（对象树 4 库/21 对象/7 视图、DDL 进标签、筛选 SUM 变化、复制失败提示）。

**安装位置（2026-10-20）**：插件已 link 到 **`desktop` profile**（桌面应用默认用的那个，Electron 独占）与 `dev-sql-021`（开发验证）。`web` profile 曾误装，已回滚。桌面应用**无法用 CLI 端到端验证**，需人点桌面快捷方式确认右栏出现「SQL 工作台」。

---

## 6. 2026-10-27 夜间批次：SQL 手写流畅度（已完成 / 新增待办）

> 来源：`analysis/SQL-writing-first-principles.md` 与 `analysis/TASKS-sql-writing.md`（57 条任务）。本批次按 P0 优先落地；下面 §6.1 是**已完成并从 P1 区移除**的项，§6.2 是**未完成、保留待办**的项。

### 6.1 已完成（2026-10-27）

| # | 内容 | 证据 |
|---|---|---|
| N1 | 执行语义：`Ctrl/Cmd+Enter` 执行**光标所在语句**（无选区）；`Ctrl/Cmd+Shift+Enter` 执行全部；`Ctrl/Cmd+Alt+Enter` 重跑上次；修「单条选区反而跑全文第一条」bug；`firstStatement` 复用字符串感知拆分器 | `src/execute/split.ts`、`src/client/editor-cm.ts`、`src/client/components/SqlWorkbenchPanel.tsx`、`tests/statement-at-cursor.spec.ts`、`tests/panel-script.spec.tsx` |
| N2 | 执行重入守卫 + 取消竞态（run token）；脚本执行拒绝与失败写入历史 | 同上 |
| N3 | **direct / paged 双模式**：手写 SELECT 原样执行 + 外层探针 LIMIT、不 COUNT；SHOW/DESC/EXPLAIN 原样执行；结果区显示「前 N 行 · 未统计总数」+「统计总数」切分页；分页/排序/筛选自动切 paged | `src/execute/core.ts`、`src/client/state/query.ts`、`src/client/components/ScriptResults.tsx`、`tests/mcp-direct-mode.spec.ts`、`tests/panel-direct.spec.tsx` |
| N4 | 错误行号映射（direct/paged 偏移）+ 编辑器错误行高亮/滚动 + 错误可行动 | `src/client/db-error.ts`、`src/client/state/query.ts`、`src/client/editor-cm.ts` |
| N5 | console 持久化（B4）+ 刷新恢复光标/页大小；**查询历史（B5）** + 收藏 + 历史抽屉（`Ctrl/Cmd+Shift+H`） | `src/client/state/history.ts`、`HistoryPanel.tsx`、`src/host/binding.ts`、`src/host/web-routes.ts`、`tests/panel-history.spec.tsx` |
| N6 | 编辑器智能：schema 补全增强（FROM 出表/表达式出列/函数字典）、格式化、`*` 展开、lint（语法/未知表/别名列/无 WHERE DML）、表/列 hover；均通过 `sql-extras.ts` 一次接入 | `src/client/{sql-functions,completion-extra,sql-format,expand-star,sql-lint,sql-extras}.ts` |
| N7 | EXPLAIN（`Ctrl/Cmd+Shift+E`/工具栏「计划」）→ 新 console 显示原始计划；格式化（`Ctrl+Alt+L`）；展开星号（`Ctrl+Alt+S`） | `SqlEditor.tsx`、`SqlWorkbenchPanel.tsx`、`tests/panel-direct.spec.tsx` |
| N8 | 对象树：F4/回车/Ctrl+B 真快捷键、右键「生成 SELECT/添加全部列」、双击打开数据改为**新 console**（不再覆盖草稿）、列类型 title、筛选 Esc | `SchemaTree.tsx`、`schema-tree.ts`、`tests/schema-tree.spec.tsx` |
| N9 | 排序/筛选生命周期：换 SQL 时清旧条件并提示；`Ctrl+Shift+L` 在编辑器内让位给「选中相同」 | `SqlWorkbenchPanel.tsx`、`entry.ts` |
| N10 | 文档：AGENTS 宿主版本更正为 0.2.1-rc.3；03 交互、00 变更记录、07 里程碑、testing smoke 同步 | 本文件 + `docs/03/00/07/testing` |

### 6.2 仍未完成（保留为待办，按优先级）

- **B6 结果区查找**、**B7 列显隐**、结果键盘扩选/全选（P1，`ResultGrid.tsx` 未改）
- **B8 导出 INSERT/JSON**、结果→SQL（`WHERE IN`/`INSERT`/`UPDATE`）（P1）
- **命令面板、全局对象搜索**（P1；`ObjectSearch/CommandPalette` 未落地）
- **参数化查询**、表概览（行数/空值率/样例）（P1）
- **Agent 结对**（解释/优化/修复 diff、发送到聊天框）（P2）
- 多光标列对齐、结果 tab 命名/pin、快捷键帮助页（P2）
- 1-2 处 coverage 死分支收尾（P2）

> 说明：本批次的代码在分支 `feat/sql-fluency`，未合入 `main`；人工真机 smoke 待用户验收。

### 6.1.1 第二轮已完成（2026-10-27 深夜）

| # | 内容 | 证据 |
|---|---|---|
| N11 | **结果区查找 B6**：Ctrl/Cmd+F 或「查找」；仅当前页、命中高亮 + 当前项描边、1/N 计数、Enter/Shift+Enter 跳转、Esc 关闭、500 条上限 | ResultGrid.tsx、	ests/grid-actions.spec.tsx |
| N12 | **列显隐 B7**：「列」菜单勾选/重置/复制列名；至少保留一列；翻页/刷新后保持 | 同上 |
| N13 | **网格键盘**：Shift+方向扩选、Ctrl/Cmd+A 全页、Ctrl/Cmd+C TSV（保留聚合复制）、值查看器自动聚焦 + Esc | 同上 |
| N14 | **导出 INSERT/JSON B8** + **结果→SQL（SQL-402）**：选区复制 WHERE col IN (…) / INSERT INTO … VALUES … / 列名清单；esult-actions.ts 纯函数（字面量转义/去重/200 上限） | esult-actions.ts、	ests/result-actions.spec.ts |
| N15 | **命令面板（SQL-213）**：Ctrl/Cmd+Shift+P；8 个命令（执行光标/全部/重跑/格式化/展开星号/计划/历史/对象搜索），模糊过滤 + 前缀优先 + ↑↓/Enter/Esc | commands.ts、CommandPalette.tsx、	ests/command-palette.spec.tsx、	ests/panel-palette.spec.tsx |
| N16 | **全局对象搜索（SQL-214）**：Ctrl/Cmd+Shift+O；跨库表/列模糊搜索（表优先、50 上限），↑↓/Enter 插入限定名/列名 | ObjectSearch.tsx、schema-tree.ts:searchObjects、	ests/object-search.spec.tsx |

### 6.1.2 第三轮已完成（2026-10-27 收尾）

| # | 内容 | 证据 |
|---|---|---|
| N17 | **快捷键速查面板**：? 或命令面板「快捷键说明」打开分组清单，Esc/关闭按钮关闭；与命令面板、对象搜索共用覆盖层视觉 | ShortcutsHelp.tsx、	ests/shortcuts-help.spec.tsx、	ests/panel-palette.spec.tsx |
| N18 | **UI 打磨**：工具栏分组分隔线 + 横向滚动、统一 :focus-visible 焦点环、结果空态给出快捷键提示 | sqlWorkbench.css、SqlEditor.tsx、ResultGrid.tsx |

### 6.1.3 第四轮已完成（2026-10-27 凌晨）

| # | 内容 | 证据 |
|---|---|---|
| N19 | **表概览 SQL-404**：对象树右键「表概览」→ 新建 overview_N console 并执行「总行数 + 每列非空数」聚合 SQL | schema-tree.ts:overviewSql、SchemaTree.tsx、SqlWorkbenchPanel.tsx、	ests/schema-tree.spec.tsx、	ests/panel-direct.spec.tsx |
| N20 | **命名参数 SQL-403**：:name 占位符（跳过字符串/注释/反引号/:: cast）；执行/脚本/EXPLAIN 前弹填写表单，数字与 NULL 原样、其余按字符串加引号；取消不执行；无参数不打扰 | params.ts、ParamsForm.tsx、	ests/params.spec.ts、	ests/params-form.spec.tsx、	ests/panel-params.spec.tsx |
| N21 | **AI 结对（复制给 AI）SQL-405/406 的一半**：命令面板新增「解释当前语句」「审查/优化当前语句」，生成自包含 prompt（含 SQL 围栏与输出要求）复制到剪贴板并提示粘贴到对话 | gent-prompts.ts、	ests/agent-prompts.spec.ts、	ests/panel-palette.spec.tsx |

### 6.1.4 第五轮已完成（2026-10-27 凌晨）

| # | 内容 | 证据 |
|---|---|---|
| N22 | **错误面板下一步动作 SQL-310**：失败卡新增「复制错误」「定位到第 N 行」「EXPLAIN」「问 agent（复制错误 prompt）」；单语句与脚本 tab 都接线；无行号时隐藏定位 | `ResultGrid.tsx`、`ScriptResults.tsx`、`agent-prompts.ts:errorSqlPrompt`、`tests/grid-actions.spec.tsx`、`tests/script-results.spec.tsx`、`tests/panel-direct.spec.tsx` |

### 6.1.5 第六轮已完成（2026-10-27 凌晨）

| # | 内容 | 证据 |
|---|---|---|
| N23 | **JOIN 生成 SQL-212 收尾**：对象树右键「JOIN 另一张表…」→ 对象搜索选第二张表 → 按同名列生成 `JOIN … ON a.x = b.x`（无同名列留 TODO ON）；`joinSql` 纯函数 | `schema-tree.ts`、`SchemaTree.tsx`、`ObjectSearch.tsx`、`tests/schema-tree.spec.tsx`、`tests/panel-direct.spec.tsx` |
| N24 | **诊断开关 SQL-309**：命令面板「开启/关闭诊断（lint）」切换波浪线诊断并提示；默认开；编辑器 extras 随开关热重配 | `SqlEditor.tsx`、`SqlWorkbenchPanel.tsx`、`tests/panel-palette.spec.tsx` |

### 6.1.6 第七轮已完成（2026-10-27 凌晨）

| # | 内容 | 证据 |
|---|---|---|
| N25 | **格式化关键字大小写 SQL-209**：命令面板「切换格式化关键字大小写」在 大写/小写/保持原样 间循环并提示，格式化真正使用该选项 | `SqlWorkbenchPanel.tsx`、`tests/panel-palette.spec.tsx` |
| N26 | **结果 tab 主表命名 SQL-314（命名部分）**：`parseTableTitle` 从 FROM/JOIN 取主表（JOIN 显示 `a+b`，去 schema 与反引号），单结果与脚本结果 tab 优先显示表名；重命名/pin 仍未做 | `result-tabs.ts`、`ScriptResults.tsx`、`tests/result-tabs.spec.ts`、`tests/script-results.spec.tsx` |

### 6.1.7 第八轮已完成（2026-10-27 凌晨）

| # | 内容 | 证据 |
|---|---|---|
| N27 | **结果 tab 重命名/pin SQL-314 收尾**：双击 tab 内联重命名（Enter 提交、Esc 取消、空名忽略、blur 提交）；右键固定/取消固定；pin 的 tab 在下一次脚本执行时保留，新结果追加在后 | `ScriptResults.tsx`、`SqlWorkbenchPanel.tsx`、`tests/script-results.spec.tsx`、`tests/panel-script.spec.tsx` |

### 6.1.8 第九轮已完成（2026-10-27 凌晨）

| # | 内容 | 证据 |
|---|---|---|
| N28 | **脚本执行可取消 SQL-107**：`ScriptRequest.statementIds`（客户端预生成每语句 id）→ host 逐语句透传；脚本执行中点「取消」会 cancel 当前语句，驱动报错后循环停止。执行核心/MCP 契约向后兼容（不传则保持旧行为） | `execute/script.ts`、`SqlWorkbenchPanel.tsx`、`tests/script.spec.ts`、`tests/panel-script.spec.tsx` |

---

## 7. 2026-10-27 上午批次：8 项用户反馈落地

| # | 需求 | 状态 | 落点 |
|---|---|---|---|
| 1 | 右上角 icon 打开快捷键设置面板（可改键位并持久化） | ✅ | `shortcut-settings.ts`（10 动作、录制、冲突、localStorage 安全读写）、`ShortcutSettings.tsx`、`ConnectionBar` 右上角 ⌨、`editor-cm.ts` keymap Compartment 热重配、panel 全局键位按设置匹配 |
| 2 | 对象树层级颜色克制区分 | ✅ | `SchemaTree.tsx` 内联 token tint：root/schema/文件夹/对象/列名/列类型逐级 label+背景，不改 CSS、不动 DOM/aria |
| 3 | SQL/错误直发聊天框 + 接受/拒绝 agent diff 提案 | ✅（405）/ 🟡（406） | `chat-bridge.ts` + `index.ts` 在 `conversation.input.dock` 注册隐藏桥，`inputActions.captureInsertion/insertText/persistDraft` 真插入，无 composer 降级剪贴板；命令面板 3 个动作（发 SQL/发错误/粘贴提案）；错误卡「发到聊天」；`DiffProposal.tsx` 行级 diff + 接受替换/拒绝。**提案目前来自剪贴板**，agent 自动推送待后续 |
| 4 | 多光标列对齐 | ✅ | `editor-cm.ts` 无条件装 `rectangularSelection()` + `crosshairCursor()`，Alt+拖动列选择；工具栏 ⓘ 提示更新 |
| 5 | 表概览：空值率/样例 + DDL，限高可滚动 | ✅ | 新 `TableOverview.tsx`（统计/样例 L20/DDL 三块，max-height 78vh + 内容滚动，Esc/关闭）；`schema-tree.ts` 新增 `overviewStatsSql/overviewSampleSql/nullRateText`；对象树「表概览」改为弹窗（不再开 console） |
| 6 | 时间统一 yyyy-mm-dd hh:mm:ss | ✅ | `state/history.ts` 相对时间改本地绝对时间；`format.ts` Date 与 ISO 字符串归一为本地 `yyyy-mm-dd hh:mm:ss`（date-only/自由文本原样）；价值查看器同步 |
| 7 | 结果单元格不被无限拉长 | ✅ | `ResultGrid` `.table{table-layout:fixed}` + 每列固定宽（文本 160/数字 120，拖拽覆盖）+ `min-width=Σ列宽` 横向滚动 + ellipsis/title |
| 8 | 每个字段明确筛选按钮 | ✅ | 列头独立 22×22 SVG 漏斗（title「筛选该列」、aria-label/pressed、active token 底色、隐藏列即消失），复用既有服务端筛选 |

## 8. 2026-10-27 下午批次：DataGrip 式表格交互与补全键位

| # | 需求 | 状态 | 落点 |
|---|---|---|---|
| 1 | 快捷键设置补「代码补全」 | ✅ | `shortcut-settings.ts` 新增 complete（默认 Ctrl+Space，唤起补全）与 acceptCompletion（默认 Enter，接受补全），入设置面板/冲突检测/持久化；`editor-cm.ts` handler：complete→startCompletion，acceptCompletion 返回库布尔（无弹层 Enter 继续换行）；设置面板录制态允许 Enter/Tab 作为候选键；速查表补两行 |
| 2 | 仿 DataGrip 的列头排序/筛选 | ✅ | 列头漏斗视觉居左（DOM 排序钮仍第一，兼容既有测试）；排序三态图标 ⇅/↑/↓ + title + active 高亮；筛选弹层改浮动「本地筛选器」：值列表（默认，搜索+复选框+本页计数，计数降序、上限 200、NULL 排除）与条件双模式；应用转服务端 `IN` 筛选（`FilterOp 'in'` + `FilterSpec.values`，空列表 `1=0`，字符串转义/数字兜底）；提示「本页计数 · 应用后服务端筛选」 |
| 3 | 单列单元格仍被拉长 | ✅ | `.table` 由 `width:100%` 改 `width:max-content`（保留 inline min-width=Σ列宽）：单列只占 120/160px，右侧留背景；宽表横向滚动；选区/表头/窗口垫/导出/值查看器未回归 |
