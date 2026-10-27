# SQL 手写流畅度 · 当前实现事实清单（只读盘点）

> 产出方：teammate `editor-inventory`（task-4）。**只读分析，未修改仓库任何文件**；本文件为唯一写入。
> 仓库：`E:\dsh-plugin\dsh-data-ide`（HEAD `569f8b7`，工作区 **67 个未提交改动**，行号以工作区当前内容为准）。
> 本文只列「现状事实 + 可推出的摩擦点」，**不含改进方案**（合成是 Lead 的工作）。

## 0. 路径与证据约定

- `src/…`、`tests/…`、`mcp/…`、`node_modules/…` 均相对包目录 `E:\dsh-plugin\dsh-data-ide\packages\client\ui-sql-workbench\`。
- `docs/…`、`.workbuddy/…` 相对仓库根 `E:\dsh-plugin\dsh-data-ide\`。
- `@codemirror/*` 的行为证据给 `node_modules/.pnpm/<pkg>/node_modules/…/dist/index.js:<行>`（库源码，非本仓代码）。
- 带「**本地实测**」的条目，是用 `node --input-type=module` + 包内真实依赖（`@codemirror/lang-sql@6.10.0`）跑的探针，只读、未落任何文件；命令见附录 A。
- 现状规模：编辑器 `src/client/editor-cm.ts` 367 行 + 适配层 `src/client/components/SqlEditor.tsx` 230 行；面板 `SqlWorkbenchPanel.tsx` 1075 行。

---

## 1. 编辑器能力清单

内核：**CodeMirror 6**（2026-10-20 迁移，`src/client/editor-cm.ts:1-19` 头部注释即迁移说明；`docs/03-UIUX-SPEC.md:28`）。下表逐项以**当前装配**为准，而不是以文档承诺为准。

| 能力 | 结论 | 边界 / 具体行为 | 证据 |
|---|---|---|---|
| 语法高亮 | 已实现 | MySQL 方言（`@codemirror/lang-sql`）+ 自定义 `HighlightStyle`：keyword/string/number/comment/operator/type 六类，颜色全走 `--dsw-alias-*` 变量，亮暗跟随壳 | `src/client/editor-cm.ts:30,111-118,343-346`；`docs/03:32` |
| 行号 | 已实现 | `lineNumbers()`，gutter 透明背景 | `editor-cm.ts:331,140-145` |
| 当前行高亮 | 已实现 | `highlightActiveLine()` + `highlightActiveLineGutter()`（行背景 `interactive-bg-hover`） | `editor-cm.ts:332-333,146-150` |
| 括号匹配 | 已实现 | `bracketMatching()`（成对高亮 + outline）；另有 `Ctrl+Shift+\` 跳到匹配括号 | `editor-cm.ts:338,155-158`；`@codemirror/commands dist:1813` |
| 自动闭合 | 已实现 | `closeBrackets()`；括号集来自方言 `closeBrackets: { brackets: ["(", "[", "{", "'", '"', "`"] }`；Backspace 可删成对括号 | `editor-cm.ts:339,360`；`@codemirror/lang-sql dist:679-681`；`@codemirror/autocomplete dist:1885-1887` |
| 缩进（Tab / 自动缩进） | **部分** | ① Tab/Shift+Tab = `indentWithTab` → 对**整行**做 `indentMore/indentLess`，不是「在光标处插入缩进」；② Enter 自动缩进由 `indentOnInput()` + 方言 `Statement: continuedIndent()` 提供；③ **全仓未配置 `tabSize` / `indentUnit`**（grep 无命中），因此沿用库默认值：缩进单位 `"  "`（2 空格）、`tabSize` 4 | `editor-cm.ts:337,361`；`@codemirror/commands dist:1824`；`@codemirror/language dist:808-816`；`@codemirror/state dist:2890-2892`；`@codemirror/lang-sql dist:604-612` |
| 注释切换 | 已实现 | `Mod-/` → `toggleComment`（`defaultKeymap` 里也有同一绑定，重复但无害）；方言提供 `commentTokens: { line: '--', block: /* */ }`，故对 SQL 走 `--` | `editor-cm.ts:362`；`@codemirror/commands dist:1814`；`@codemirror/lang-sql dist:678-679` |
| 查找 / 替换 | 已实现（替换被窄面板裁掉） | `search({ top: true })` + `searchKeymap`；中文 phrases；**容器宽度 ≤460px 时**.cm-search 的替换输入/按钮被 CSS 隐藏（只留查找） | `editor-cm.ts:341,90-108`；`components/sqlWorkbench.css:1295-1305`；`docs/03:34` |
| 多光标 | 已实现 | `Ctrl+Alt+↑/↓` 增光标；`Ctrl+D` 选中下一个相同出现；Alt+点击（CM 内置）；`drawSelection()` | `@codemirror/commands dist:1803-1804`；`@codemirror/search dist:1058`；`editor-cm.ts:334` |
| 撤销 / 重做 | 已实现（跨 console 有串味风险） | `history()` + `historyKeymap`；schema/只读通过 Compartment 热切换**不重建视图**，所以撤销栈与选区在 schema 刷新后保留；但**所有 console 共用一个 EditorView**，切 console 用「整文档替换」（见 §8-15） | `editor-cm.ts:335,359,296-303`；`components/SqlEditor.tsx:94-130,134-144` |
| 折叠 | 已实现（SQL 粒度粗糙） | `foldGutter({openText:'▾',closedText:'▸'})` + `foldKeymap`；折叠区由方言 `foldNodeProp` 决定：`Statement`（从语句首行 +100 字符到语句尾）与 `BlockComment`——**单行语句折叠无收益**，多行语句才可折 | `editor-cm.ts:336,358,159-165`；`@codemirror/lang-sql dist:609-612`；`@codemirror/language dist:1510-1515` |
| 补全 | 已实现（schema 感知但无作用域解析） | 详见 §4。来源 = 方言关键字/类型/builtin + schema 命名空间（表/列/别名）+ 12 个 live templates；`activateOnTyping: true`、`maxRenderedOptions: 40`；`Ctrl+Space` 手动触发 | `editor-cm.ts:266-283,340,343-344`；`src/client/completion-rank.ts` |
| 悬停（hover tooltip / 列类型提示） | **无** | 全仓无 `hoverTooltip`；列表里没有列类型提示 | grep `hoverTooltip` 无命中；`editor-cm.ts:330-366` 扩展清单无该项 |
| 诊断 / 错误标记（行内 lint、错误行高亮） | **无** | 无 `linter`、无 diagnostic；SQL 错误只出现在结果区（单语句：`role="alert"` 网格；脚本：失败 tab + 「输出」tab） | grep `linter` 无命中；`components/ResultGrid.tsx:178-187`；`components/ScriptResults.tsx:41-49`；对照 `docs/03:213` 声称「错误行高亮」 |
| 格式化 / 美化 | **无** | 无格式化依赖（`package.json` 依赖里无 sql-formatter/prettier）、无键位、无按钮；`docs/09-BACKLOG` 里也**没有**格式化条目（连待办都没排） | `package.json:42-54`；`editor-cm.ts:330-366`；`docs/09-BACKLOG.md:16-129` |
| 片段 / 参数占位 | 已实现 | 12 个 live templates（`sel/selc/selw/selagg/ins/upd/del/jo/lj/gb/ob/lim`），`snippetCompletion` + `${}` 占位，**Tab 可在占位间跳转**（`snippet()` 自动追加 `addSnippetKeymap`，`Prec.highest`，优先于 `indentWithTab`）；两字符起才出（`matchingTemplates`），`boost: 30` 高于关键字 | `editor-cm.ts:266-283`；`completion-rank.ts:105-130`；`@codemirror/autocomplete dist:1622,1675-1689`；`tests/completion-ranking.spec.ts:54-72` |
| 选区执行 | 已实现（有边界 bug） | 有选中 → `source = 选区`；`splitStatements(source).length > 1` 时只跑选区；**若选区只含一条语句，走单语句分支，实际下发的是整个编辑器文本**（`query.sql`），服务端再经 `firstStatement()` 取第一条 → 选中第 2 条时执行的是第 1 条 | `components/SqlWorkbenchPanel.tsx:885-896`；`src/client/state/query.ts:75-107`；`src/execute/core.ts:238-242,342`；`tests/panel-script.spec.tsx:205-221`（只断言「走了 execute 而非 executeScript」，未断言 SQL 内容）；`docs/03:23` |
| 跳转（到行 / 到定义 / 到对象） | **部分** | 到行：`Ctrl+Alt+G`（`gotoLine`，phrases 有「跳到行」）；到匹配括号：`Ctrl+Shift+\`；**无**「跳到表定义 / 跳到对象树选中 / 从 SQL 词跳对象」 | `@codemirror/search dist:1057`；`editor-cm.ts:106-107`；`@codemirror/commands dist:1813` |
| 软换行 | **无** | 扩展里没有 `EditorView.lineWrapping`；长行只能水平滚动（`.cm-scroller{overflow:auto}`），在 ~300–500px 的右栏里更明显 | `editor-cm.ts:133-137,330-366`；右栏实测宽度见 `.workbuddy/memory/2026-10-19.md:142` |
| 状态栏（行:列 / 选区长度） | **无** | 工具栏只有「N 行」（`sql.split('\n').length`）；无光标位置、无选区字符数 | `components/SqlEditor.tsx:163,211-213` |
| 只读态 | 已实现 | 只读 = **无连接**（`disabled`）；执行中**不禁写**（见 §3） | `SqlEditor.tsx:156-161`；`editor-cm.ts:286-288` |
| 占位提示 | 已实现 | 硬编码示例：`SELECT * FROM dwd_order WHERE dt = '2026-10-01'` | `editor-cm.ts:348` |
| 中文 UI 文案 | 已实现 | `EditorState.phrases` 覆盖查找/替换/跳行等 16 个串 | `editor-cm.ts:90-108` |

---

## 2. 快捷键总表

作用域说明：**编辑器** = CodeMirror 内容区聚焦；**网格** = 结果网格滚动容器聚焦；**全局** = `window` 监听。

### 2.1 编辑器聚焦时

| 键位 | 动作 | 证据 | 冲突 / 备注 |
|---|---|---|---|
| `Ctrl/Cmd+Enter` | 执行（见 §3） | `editor-cm.ts:320-324,353-354` | `Prec.high` 覆盖了 CodeMirror `defaultKeymap` 的 `Mod-Enter = insertBlankLine`（`@codemirror/commands dist:1806`）。**执行中仍可触发，无重入守卫**（§8-9） |
| `Esc` | ① 补全弹窗开 → 关弹窗；② 有非空选区/多光标 → 收缩为光标（`simplifySelection`）；③ 都不满足 → 取消执行（`onCancel`） | ① `@codemirror/autocomplete dist:2063-2073`（`closeCompletion` 无弹窗时返回 false，`dist:1116-1121`）；② `@codemirror/commands dist:1805` + `simplifySelection` 实现；③ `editor-cm.ts:325-328,365` | 注意 ② 会「吃掉」Esc：**有选区时 Esc 不取消执行**；取消只在编辑器聚焦时生效（全局无 Esc 监听） |
| `Ctrl+Space`（mac `Alt+\``、`Alt+i`） | 手动触发补全 | `@codemirror/autocomplete dist:2064-2066` | Windows 中文输入法惯例也用 `Ctrl+Space` 切换中英（环境冲突，未在本仓验证） |
| `↑/↓/PageUp/PageDown` / `Enter` | 补全列表移动 / 接受 | `@codemirror/autocomplete dist:2068-2072` | `autocompletion()` 默认 `defaultKeymap: true` 以 `Prec.highest` 装载，故这些键在弹窗打开时优先 |
| `Tab` / `Shift+Tab` | 整行缩进 / 反缩进 | `editor-cm.ts:361`；`@codemirror/commands dist:1824` | 片段激活时 Tab 先走「跳到下一占位」（snippet keymap `Prec.highest`） |
| `Ctrl+/` | 切换行注释 | `editor-cm.ts:362`；`@codemirror/commands dist:1814` | 与 `defaultKeymap` 重复绑定，无害 |
| `Ctrl+F` | 查找替换面板（顶部） | `editor-cm.ts:341`；`@codemirror/search dist:1052` | 面板内 `Esc` 关面板（`dist:1055`，scope 限 search-panel） |
| `F3` / `Shift+F3`、`Ctrl+G` / `Ctrl+Shift+G` | 下一个 / 上一个匹配 | `@codemirror/search dist:1053-1054` | |
| `Ctrl+Shift+L` | 选中相同文本（`selectSelectionMatches`） | `@codemirror/search dist:1056` | **与全局「打开 SQL 工作台」同键**：CM 只在绑定声明 `stopPropagation` 时才阻止冒泡（`@codemirror/view dist:9217-9248`），该绑定没有声明 → 事件继续到达 window 的全局监听（`src/client/entry.ts:43-52`）→ **两个动作同时发生** |
| `Ctrl+Alt+G` | 跳到行 | `@codemirror/search dist:1057`；`editor-cm.ts:106-107` | |
| `Ctrl+D` | 选中下一个相同出现（多光标） | `@codemirror/search dist:1058` | |
| `Ctrl+Z` / `Ctrl+Y`（mac `Cmd+Shift+Z`）/ `Ctrl+U` / `Alt+U`(mac `Cmd+Shift+U`) | 撤销 / 重做 / 撤销选区 / 重做选区 | `@codemirror/commands dist:569-574` | |
| `Ctrl+Shift+[` / `Ctrl+Shift+]`（mac `Cmd+Alt+[`…） | 折叠 / 展开 | `@codemirror/language dist:1510-1515` | |
| `Ctrl+Alt+[` / `Ctrl+Alt+]` | 全部折叠 / 展开 | 同上 | |
| `Ctrl+Alt+↑/↓` | 添加上 / 下光标 | `@codemirror/commands dist:1803-1804` | Windows 部分显卡驱动抢占 Ctrl+Alt+方向键（环境冲突，未在本仓验证） |
| `Ctrl+[` / `Ctrl+]` | 反缩进 / 缩进（选区） | `@codemirror/commands dist:1809-1810` | |
| `Ctrl+Alt+\` | 缩进选区 | `@codemirror/commands dist:1811` | |
| `Shift+Ctrl+K` | 删除行 | `@codemirror/commands dist:1812` | |
| `Shift+Ctrl+\` | 跳到匹配括号 | `@codemirror/commands dist:1813` | |
| `Alt+L`（mac `Ctrl+L`） | 选择当前行 | `@codemirror/commands dist:1807` | |
| `Ctrl+M`（mac `Shift+Alt+M`） | 切换 Tab 焦点模式 | `@codemirror/commands dist:1816` | |
| `Alt+↑/↓`、`Shift+Alt+↑/↓` | 移动行 / 复制行 | `@codemirror/commands dist:1799-1802` | |
| `Ctrl+A` 等 | 标准编辑键（`standardKeymap`） | `@codemirror/commands dist:1743-1795` | |
| `Enter`（无补全弹窗） | 换行 + 自动缩进 | `@codemirror/commands` `standardKeymap`；`editor-cm.ts:337` | 中文输入法**组字期间**按键被 CM 忽略（`@codemirror/view dist:4581,4674-4690`）→ Enter 选词不会误触发执行 |
| `Backspace` | 删除成对括号 | `@codemirror/autocomplete dist:1885-1887` | |

### 2.2 结果网格聚焦时（`role="grid"` 容器 `tabIndex=0`）

| 键位 | 动作 | 证据 |
|---|---|---|
| `↑/↓/←/→` | 单格移动（无 Shift 扩选、无行/列选择）；首次按键从左上角开始；窗口化时自动滚动带回可见区 | `components/ResultGrid.tsx:338-358`；`src/client/rowwindow.ts:73-84` |
| `Ctrl/Cmd+C` | 复制矩形选区为 TSV（无选区时无动作） | `ResultGrid.tsx:322-330,260-263`；`src/client/grid.ts:71-89` |
| `Ctrl/Cmd+Shift+C` | 复制聚合读数 | `ResultGrid.tsx:325-327` |
| `Shift+Enter` | 打开值查看器（数据选区存在时） | `ResultGrid.tsx:332-337` |
| `Esc` | 关闭值查看器——**仅当焦点在浮层内部时**（浮层 `div` 无 `tabIndex`，双击打开时焦点仍在网格上） | `ResultGrid.tsx:571-582`（无 tabIndex）vs `321-359`（网格 keydown 不处理 Esc） |
| 列筛选输入框内 `Enter` / `Esc` | 应用 / 取消筛选 | `ResultGrid.tsx:447-450` |

### 2.3 对象树 / 菜单 / 面板

| 键位 | 动作 | 证据 | 备注 |
|---|---|---|---|
| `Esc` | 关闭对象右键菜单（window 监听，仅菜单打开时注册） | `components/SchemaTree.tsx:134-139` | |
| `Enter` / `F4` / `Ctrl+B` | **仅作为菜单右侧提示文字显示，全仓无对应键盘绑定** | `SchemaTree.tsx:164-167`（`hint` 字符串）；grep `F4`/`Ctrl+B` 只在注释与 hint 中出现 | 菜单项本身可点击；DataGrip 习惯的 F4/Enter/Ctrl+B 不可用 |
| sash 聚焦时 `←/→`（竖向）或 `↑/↓`（横向） | 面板尺寸 ±16px | `components/WorkbenchPanel.tsx:117-124`；`src/client/split.ts:33` | |
| sash 双击 | 复位默认尺寸 | `WorkbenchPanel.tsx:116`；`SqlWorkbenchPanel.tsx:841-843,912-914` | |

### 2.4 全局

| 键位 | 动作 | 证据 | 冲突 / 备注 |
|---|---|---|---|
| `Ctrl/Cmd+Shift+L` | 打开 / 聚焦 SQL 工作台 tab（`sidebarRight.openTab`） | `src/client/entry.ts:13,29-34,43-52`；`src/client/index.ts:134-140`；`tests/entry.spec.ts:36-47` | 与编辑器 `selectSelectionMatches` 同键（见上）；`Alt` 按下时让给系统（`entry.ts:30`） |
| 浏览器自身 | `Ctrl+F` 被 CM 拦截（preventDefault） | `editor-cm.ts:341` | 结果网格没有查找（见 §6） |

**未实现但文档写过的键**：`Ctrl/Cmd+S` 保存脚本（`docs/03:228`；全仓无绑定、也无脚本文件功能）、F4/Enter/Ctrl+B（见上）。

---

## 3. 执行语义

### 3.1 `Ctrl/Cmd+Enter` / 工具栏「执行」到底执行什么

入口唯一：`SqlEditor` 工具栏按钮 + 编辑器 keymap 都调 `onRun`（`SqlEditor.tsx:171-182`；`editor-cm.ts:320-324`）。面板实现是**四步分支**（`SqlWorkbenchPanel.tsx:885-896`）：

1. `selection = editorRef.getSelection()`（选区的 `sliceDoc`，`SqlEditor.tsx:80-86`）；
2. `source = selection.trim() === '' ? query.sql : selection`；
3. `markRun(source)` → 记 `lastRunSql`（`SqlWorkbenchPanel.tsx:541-543`，只用于 `*` 脏标记，`documents.ts:113-116`）；
4. 分支：
   - `splitStatements(source).length <= 1` → **单语句路径**：`setScript(null)`，然后 `executeQuery(api, query, connId, publish)`。
     ⚠ 这里传的是 `query`（= 当前 console 的**整段编辑器文本**），不是 `source`。服务端 `executeSql` 再用 `firstStatement()` 截到第一个分号前（`execute/core.ts:238-242,342`）。因此：
     - 无选区 + 单语句：正常（整段 = 那条语句）；
     - 无选区 + 多语句：不会走这里（`split > 1`）；
     - **有选区 + 选区只含 1 条语句：执行的是全文第一条语句，而不是选区**（选第 2 条 → 跑第 1 条）；
     - 有选区 + 选区是某条语句的片段：同样执行全文第一条。
   - `splitStatements(source).length > 1` → **脚本路径**：`runScript(source)` → `api.executeScript({ connId, sql: source, pageSize })`。
5. 结果渲染：单语句结果被包装成「1 个结果 tab」的 `ScriptResults`（`SqlWorkbenchPanel.tsx:117-122,918-965`），脚本结果每语句 1 个 tab（`980-1007`）。

**结论**：「有选中只跑选段」只在**选区跨 ≥2 条语句**时成立（`docs/03:23` 的表述与单语句选区情形不符，`tests/panel-script.spec.tsx:205-221` 也只覆盖了「走 execute 路径」）。

### 3.2 多语句如何拆分

- 拆分器：`src/execute/split.ts:30-89`，手写扫描器，**字符串/反引号/`--` `#` 行注释/`/* */` 块注释内的 `;` 不切**；`\\` 与双引号转义处理；去空白语句；上限 `MAX_SCRIPT_STATEMENTS = 50`（超出丢弃，`split.ts:22,41`）；`start` 记录首字符偏移。
- 单语句路径**不用**这个拆分器：`firstStatement()` 是裸 `sql.split(';')[0]`（`execute/core.ts:238-242`），**不识别字符串/注释** → 例如 `SELECT * FROM t WHERE a = 'x;y'` 单语句执行会被截成 `SELECT * FROM t WHERE a = 'x`。
- 服务端脚本执行：`src/execute/script.ts:62-121`，按 `splitStatements` 顺序逐条 `executeSql`，**遇错即停**（`script.ts:87-114`），每条语句都各跑一次分页包裹 + 独立 COUNT。
- MCP 侧 `execute` 的语义也是「只执行第一条」（`docs/05-MCP-SPEC.md:51`），并有 `execute_script`（`docs/05:64-67`）。

### 3.3 执行 / 取消状态机

`src/client/state/query.ts`：

```
idle --run()--> running --ok--> done
                       |--refusal/throw--> error
running --cancel()--> error(CANCELLED)      // 仅当 statementId != null
```

- `run()`：先 `onStart?.(running)` 再 `await`（注释明确「先发布，网格显示正在执行…且取消有目标」，`query.ts:96-98`）；失败时 `result:null,total:null,statementId:null`（`102-106`）。
- `statementId`：面板自己铸 `ui-<n>`，**允许在响应回来前取消**（`query.ts:47-53,95`；`docs/05:53`）。注意 `state.statementId ?? nextStatementId()`：若已有在飞 id 会**复用**。
- `goPage()`：分页/排序都走它；失败时保留旧 `result`（`query.ts:115-133`）。
- `cancel()`：`api.cancel(statementId)` 成功后把状态置 `error(CANCELLED, 查询已取消)`（`query.ts:153-162`）；`statementId===null` 是空操作（`tests/workbench-exec.spec.tsx:132-139` 断言未调 `api.cancel`）。**取消不 abort 前端的原始 Promise**：原请求若之后返回，`run()` 的返回会再次写状态（`query.ts:99-107` + 面板 `withConnection` 无条件回写，`SqlWorkbenchPanel.tsx:635-659`）→ 存在「取消后又显示结果」的竞态。
- 取消入口：编辑器 `Esc`（编辑器聚焦时）、工具栏「取消」（`running` 时可用，`SqlEditor.tsx:183-185`）、面板 `onCancel → cancelQuery`（`SqlWorkbenchPanel.tsx:897-899`）。**网格聚焦时 Esc 不取消**。
- 脚本运行**没有 statementId、没有取消通道**：`runScript` 只用一个 `script.running` 防重入（`SqlWorkbenchPanel.tsx:398-440`，`docs/05:64-67` 无 cancel）；`.workbuddy/memory/2026-10-19.md:162` 亦记「脚本执行无法取消」。

### 3.4 执行中能否继续编辑

- **能**：只读只跟 `disabled`（无连接）走（`SqlEditor.tsx:156-161,880`；`editor-cm.ts:286-288`），与 `running` 无关；`running` 只用于禁用工具栏「执行」按钮并点亮「取消」（`SqlEditor.tsx:174,183`）。
- 但键盘绕过按钮：`Ctrl+Enter` 的 keymap 无 `running` 判断（`editor-cm.ts:312-324`；`SqlWorkbenchPanel.tsx:885-896` 也无守卫）→ **执行中再按 Ctrl+Enter 会并发发起第二个请求**；`tests/workbench-exec.spec.tsx:114-130` 连按两次断言 `execute` 调用两次。
- 执行中最后一次成功的页仍留在网格上（`query.ts:22-23,96`），不闪空。

### 3.5 结果落点、pin 与覆盖规则

- **pin 到发起时的 console**：执行/翻页/脚本都在 await 前捕获 `docId = activeDocId`，写回用 `writeDoc(docId, …)`（`SqlWorkbenchPanel.tsx:128-156,635-659,457-479`；注释记录了 2026-10-19 串台缺陷）。切 console 后慢结果仍落在原 tab。
- 单语句结果**覆盖**该 console 上一次的 `result`（`query.ts:99-107`）；脚本结果覆盖该 console 的 `script`（`SqlWorkbenchPanel.tsx:405-439`）。
- 切 console 不清结果（`switchingTab` 标志，`SqlWorkbenchPanel.tsx:259-271,551-559`）。
- **切数据源**（连接栏 select / 关掉当前 tab 后落到邻居）会清 `script` 与 `result/error/total`（`SqlWorkbenchPanel.tsx:261-271,750-760,577-585`）。
- 排序/筛选**粘在 console 上**：`QueryState.sort/filters` 在 `request()` 里始终带上（`query.ts:75-85`），换一条 SQL 重跑不会重置 → 旧 ORDER BY/WHERE 仍生效。
- Agent 投递不会切走当前 console（`documents.ts:215-221,230-293`）。

---

## 4. 补全行为

### 4.1 装配与来源

- `autocompletion({ activateOnTyping: true, maxRenderedOptions: 40 })`（`editor-cm.ts:340`）；`Ctrl+Space` 手动触发（库 keymap）。
- 三个候选源：
  1. **方言关键字/类型/builtin**：`sql({ dialect: MySQL, upperCaseKeywords: true, keywordCompletion, schema })`（`editor-cm.ts:244-257`）→ `completeKeywords(MySQL.dialect.words, true, build)`（`@codemirror/lang-sql dist:691-693,712-720`）。MySQL 的 `builtin` 只有 `charset/clear/edit/ego/…/tee` 这类 **mysql CLI 命令**（`dist:738,751-753`），**不含 `date_format`/`ifnull`/`concat` 等 SQL 函数**；`group_concat` 是显式补进关键字表的（`dist:751`）。
  2. **schema 命名空间**：`toSqlNamespace(SchemaIndex)`（`editor-cm.ts:65-82`）→ `{ schema: { table: [cols] } }`；无 schema 名的表折进顶层（`flat`）。
  3. **live templates**：`EditorState.languageData.of(() => [{ autocomplete: templateCompletion }])`（`editor-cm.ts:344`），两字符起（`completion-rank.ts:126-130`），`boost: 30`。
- 排序：关键字 `boost` 表约 55 个高频词（`completion-rank.ts:25-86`，`sql({keywordCompletion})` 注入，`editor-cm.ts:249-254`）；模板 boost 最高。`boost` 参与「匹配分 + boost」只改顺序不隐藏（`docs/03:30`；`tests/completion-ranking.spec.ts:41-59`）。
- 触发细节：位置是空白/行首时自动补全**不弹**（两源都返回 null），要 `Ctrl+Space`（`@codemirror/lang-sql dist:551-554`：`if (empty && !context.explicit) return null`；`completeFromList` 对空 span 且非 explicit 也返回 null；本地实测见附录 A）。

### 4.2 本地实测矩阵（真实 `@codemirror/lang-sql@6.10.0` + 按 `toSqlNamespace` 形状构造的两库命名空间）

| 输入（光标在末尾） | 自动弹（敲字触发） | `Ctrl+Space`（explicit） | 说明 |
|---|---|---|---|
| `SELECT * FROM ` | 无候选（null） | 库名 `dwd|ads` + 关键字 | 顶层只有**库名**与别名，表名在库里一层 |
| `SELECT * FROM dwd_o` | **无候选**（顶层候选是库名 `dwd`，前缀不匹配表名） | 同上 | **手打表名前缀拿不到表名** |
| `SELECT * FROM dwd.` | 表 `dwd_order|dwd_customer` | — | 必须先打库名 + 点 |
| `SELECT * FROM dwd.dwd_o` | 表名 | — | |
| `SELECT * FROM dwd.dwd_order o WHERE o.` | 列 `order_id|amount` | — | **别名解析有效**（`dist:555-556`） |
| `SELECT * FROM dwd_order o WHERE o.`（无 schema 的平铺命名空间） | 列 | — | 平铺时表在顶层，别名同样有效 |
| `SELECT * FROM `（平铺命名空间） | 表名 `dwd_order|v_daily` | 同左 | 只有「表没有 schema 名」时顶层才给表 |
| `SELECT * FROM dwd.dwd_order WHERE ` | 无候选 | 库名 + 关键字 | **WHERE 这类空白位置不给列，即使 Ctrl+Space** |
| 无 schema（连接未加载/失败） | 关键字 only | 关键字 | `sqlExtension(undefined)` 不传 schema（`editor-cm.ts:255`；`docs/03:31`） |

### 4.3 真实快照为什么命中「顶层只有库名」

- 宿主 introspection 第一条 SELECT 就把 `TABLE_SCHEMA` 作为第 1 列（`src/host/metadata.ts:69-76`），`foldSchema` 只要 4 列就带 `schema`（`metadata.ts:108-135`）；SHOW 回退也写 `schema: database`（`metadata.ts:215-223`）。
- 因此真实 `information_schema` 快照里**每张表都带 schema**，`toSqlNamespace` 会把它们全部塞进命名空间子层（`editor-cm.ts:67-81`），顶层只剩库名；`sql()` 也没有传 `defaultSchema`（`editor-cm.ts:246-256`），所以 `FROM <表前缀>` 没有任何表名候选。
- `.workbuddy/memory/2026-10-21.md:115` 也自述「补全仍**无语法位置感知**（`FROM` 后仍给关键字、`WHERE` 后不做别名解析）；关键字大小写不跟随输入（恒大写）」——第一条与本地实测一致，第二条该记忆表述偏保守：**别名解析其实有效**（库内实测 + `dist:555-556`），真正缺的是表名在顶层不可见。

### 4.4 大小写与引号

- 关键字**恒定大写**：`upperCaseKeywords: true`（`editor-cm.ts:248`）+ `keywordCompletion` 再 `label.toUpperCase()`（`editor-cm.ts:254`）→ 即便用户习惯小写 `select`，接受后也是 `SELECT`。
- 表/列名保留快照原样（`completion.ts:16-38` → `editor-cm.ts:70`）；不符合 `^[a-z_][a-z_\d]*$` 的名字（大写、中文、含空格）由 lang-sql 自动加反引号（`@codemirror/lang-sql dist:525-529`，MySQL `identifierQuotes: '`'`，`dist:750`）。
- 用户在反引号内时按引号上下文补全（`dist:575-585`），`validFor` 用 `QuotedSpan`。

### 4.5 schema 缓存与刷新

- 宿主缓存：按 connId，`SCHEMA_TTL_MS = 5 * 60 * 1000`、`SCHEMA_MAX_ROWS = 20000`（`src/host/metadata.ts:52-53,236-243`）；`refresh: true` 绕过缓存（`metadata.ts:240-241`）。
- 面板拉取时机：`api` 或 `tabConnId` 变化时拉一次（`SqlWorkbenchPanel.tsx:273-297`）；面板头「↻」调 `refreshSchema`（`299-315`，按钮 `804-813`）；树内刷新按钮被关掉（`showRefresh={false}`，`818`）。
- 失败降级：`schemaError` 写进树的面板 meta/note（`SqlWorkbenchPanel.tsx:610-613,798-802`；`SchemaTree.tsx:339-343`），编辑器退化为「仅关键字」，不弹错误横幅。
- 空清单/截断/SHOW 回退都有 note（`metadata.ts:226-228,281-283`）。

### 4.6 无候选时的表现

- 自动触发时无候选 → 弹窗不出现（没有「无建议」提示）。
- 未加载 schema / 无连接 → 只剩关键字与模板。
- 模板不足 2 字符不出现（`completion-rank.ts:126-130`）。
- 弹窗最多渲染 40 项（`editor-cm.ts:340`），超出靠滚动。
- 类型标签仍为英文 `keyword/table/column/property`（`docs/09-BACKLOG.md:77-84` B9，未做）。

### 4.7 已知限制（来自代码/注释/测试）

- 无作用域解析、无 CTE 分析、无类型推断（`src/client/completion.ts:9-13` 自述；`docs/03:31`）。
- 别名解析只覆盖 `别名.` 一级路径（`dist:555-556` 的 `parents.length == 1`），嵌套/子查询不做。
- 无函数补全（见 4.1）；无「根据语句位置给 SELECT/FROM/WHERE 专属项」。
- 关键字候选来源是整份方言词表，任何位置都参与（`dist:601` 只在字符串/注释/点后屏蔽）。

---

## 5. 对象树交互

组件 `components/SchemaTree.tsx` + 纯模型 `src/client/schema-tree.ts`；数据来自 `SchemaSnapshot`（`host/metadata.ts:17-26`）。

| 交互 | 现状 | 证据 |
|---|---|---|
| 层级 | 数据源（caption）→ 库/Schema → 表 / 视图 两个分组 → 对象 → 列（`groupBySchema` 拆 tables/views，按 `localeCompare('zh-Hans-CN')` 排序） | `schema-tree.ts:57-73`；`SchemaTree.tsx:334-338` |
| 单层命名空间 | 快照没有 schema 名时不渲染库层（`named = groups.length > 1 || schema !== ''`） | `SchemaTree.tsx:92,346-353` |
| 默认展开 | 第一个库 + 有表的「表」分组（无表则展开「视图」）；按「schema 组成签名」播种，刷新不弹回用户折叠 | `SchemaTree.tsx:101-119` |
| 单击表/视图 | **向编辑器插入表名（未加引号、未限定库名）**，并把焦点移到编辑器 | `SchemaTree.tsx:193-203`；`SqlWorkbenchPanel.tsx:824-826`；`SqlEditor.tsx:69-79` |
| 单击列 | 插入列名（同样不加引号） | `SchemaTree.tsx:217-222` |
| 双击表 | **打开数据**：把 `SELECT * FROM \`库\`.\`表\` LIMIT 100` 写入**当前 console** 并立即执行（没有新 tab、没有确认、会覆盖正在手写的 SQL） | `SchemaTree.tsx:199-201`；`schema-tree.ts:120-125`；`SqlWorkbenchPanel.tsx:690-694` |
| 右键菜单（表/视图） | 打开数据（hint F4）/ 插入名称（hint Enter）/ 复制引用（`\`库\`.\`表\``）/ 查看 DDL（hint Ctrl+B）/ 刷新表结构 | `SchemaTree.tsx:163-169`；`schema-tree.ts:113-117,179` |
| 右键菜单（列） | 插入名称 / 复制列名 | `SchemaTree.tsx:223-228` |
| 右键菜单（库） | 复制库名 / 刷新表结构 | `SchemaTree.tsx:278-283` |
| 菜单行为 | 贴点击点弹出，靠边翻转（`menuPosition`）；点外部/滚动/Esc 关闭；点菜单项先关菜单再执行（避免 pointerdown 卸载节点导致 click 丢失） | `SchemaTree.tsx:123-145,309-313,369-384`；`schema-tree.ts:154-167` |
| 菜单提示的快捷键 | **只是文字**，F4/Enter/Ctrl+B 全仓没有绑定（见 §2.3） | `SchemaTree.tsx:164-167`；grep 证据 |
| 过滤 | 顶部输入框，**本地子串匹配（不分大小写）**：表名命中保留整表，仅列名命中则只保留命中的列；过滤时强制展开 | `SchemaTree.tsx:317-332,155`；`schema-tree.ts:82-95` |
| 拖拽 | **无**（无 drag 相关实现） | 无 draggable/onDragStart |
| Enter 键 / 键盘导航 | **无**（除按钮原生 Tab 焦点） | `SchemaTree.tsx` 无 onKeyDown |
| 视图/列展示 | 对象行右侧显示列数；列行显示列名 + 类型；无列信息显示「无列信息（视图）」+「视图」提示；不显示 T/V 徽标 | `SchemaTree.tsx:204-213,230-233`；`docs/03:18-19` |
| 面板头摘要 | `N 个对象 · 含 N 视图 · information_schema/SHOW`，加载中/错误文案 | `SqlWorkbenchPanel.tsx:795-815`；`schema-tree.ts:98-107` |
| DDL 入口 | 右键「查看 DDL」→ `SHOW CREATE TABLE|VIEW` 走 `raw` 执行（不包裹、不 COUNT、pageSize 1）→ **新开 console tab，标题 `ddl_<表>`**，写入 DDL 文本，标为非脏；tab 满 8 个时右下角提示；失败走右下角 notice | `SqlWorkbenchPanel.tsx:696-746`；`schema-tree.ts:128-145`；`docs/03:26,96` |
| 未实现 | Keys/Indexes/Triggers/Server Objects、`Jump to Query Console` 独立 console、DDL diff | `SchemaTree.tsx:70-72`；`docs/03:27`；`docs/09:126-129` B16 |

---

## 6. 结果区交互

组件 `components/ResultGrid.tsx`（625 行）、`ScriptResults.tsx`、`Pager.tsx`；纯逻辑 `src/client/grid.ts`、`format.ts`、`rowwindow.ts`、`stats.ts`。

### 6.1 选择模型

- 只有**矩形选区**一种：`GridSelection {fromRow,fromColumn,toRow,toColumn}`，`mousedown` 定锚点 + `mousemove`（左键按下）扩展（`ResultGrid.tsx:501-513`；`grid.ts:13-34`）。
- 键盘只能单格移动（无 Shift 扩选、无行/列头选择）；`docs/03:227` 声称「单元格/行/列/区域（Shift 扩展）」与实现不符。
- 换页 / 新结果 / 筛选变化都会清空选区与值查看器（`ResultGrid.tsx:122-128,168-176`）。

### 6.2 复制

- 工具条「复制」（选区 → TSV，`ResultGrid.tsx:280-288,260-263`）；`Ctrl+C` 同效；`Ctrl+Shift+C` 复制聚合读数；空选区时按钮禁用。
- TSV 生成：`selectionToTsv`（`grid.ts:71-89`）；**复制只支持整块 TSV**，没有 CSV 到剪贴板、没有带表头、没有「复制整页」。
- 剪贴板三级策略 + 统一失败提示（`src/client/clipboard.ts:55-67`；`SqlWorkbenchPanel.tsx:229-238`）。

### 6.3 排序与筛选送服务端的方式

- **排序**：列头点击循环 `无 → ASC → DESC → 无`（`query.ts:136-139`）；触发 `sortBy → goPage(offset 0)` → `api.fetchPage`（**不重跑 COUNT**，`query.ts:142-150,115-133`；`ResultGrid.tsx:377-380`）。排序实现为 SQL 包裹：`SELECT * FROM (<用户 SQL>) AS t ORDER BY \`col\` ASC/DESC LIMIT … OFFSET …`（`execute/core.ts:168-191`；列名有注入闸门 `quoteIdentifier`）。
- **筛选**：列头漏斗 → 条件编辑器（运算符 + 值；10 个运算符：contains/notContains/eq/ne/gt/ge/lt/le/isNull/notNull，`ResultGrid.tsx:51-62`）；应用后**重新执行**（重查 + 重算 COUNT），单语句路径 `executeQuery`（`SqlWorkbenchPanel.tsx:949-964`），脚本路径 `refetchScript({offset:0,filters})`（`527-537`）。
- 筛选进 WHERE：与 COUNT 共用 `filterClause`；字面量转义 `''`/`\\`、截 200 字符、数字列不加引号（`execute/core.ts:198-235`）；列名同闸门。
- 每列**只保留一个条件**（同列覆盖），多列 AND；无 OR、无 IN、无区间（`SqlWorkbenchPanel.tsx:949-958`；`ResultGrid.tsx:411-474`）。
- 工具条显示 `N 行（已筛选）` + `清除筛选（k）`；筛选到 0 行仍渲染工具条（`ResultGrid.tsx:197-205,275-279`；`docs/03:78`）。
- 脚本结果**现在也支持**每语句筛选（`ScriptResults.tsx:205-212` 按 `onFilter !== undefined` 打开漏斗；面板 1001-1006 传入）——与 `docs/09-BACKLOG.md:86-93` 的 B10「未做」、`docs/03:79-80` 的「不显示漏斗」**已不一致**（记忆 `2026-10-21.md:77` 确认已解锁）。

### 6.4 值查看器

- 双击单元格或 `Shift+Enter` 打开右下角卡片：列名 · 行号 · 字符数；JSON 可解析则美化；二进制前 64 字节 hex + 总字节；Uint8Array/Date 特判；可复制；换页自动关闭（`ResultGrid.tsx:571-622`；`format.ts:99-149`；`docs/03:105`）。
- 关闭方式：按钮、或焦点在浮层内时 `Esc`（浮层 `div` **无 `tabIndex`**，见 §2.2）。

### 6.5 导出

- 下拉格式：`CSV / TSV / XLSX`，默认 CSV；导出的是**当前页**（`visibleIndexes` 全部，只受服务端筛选影响），不是全部数据；无选区导出（`ResultGrid.tsx:239-258,294-308`）。
- CSV 走 RFC4180 引号 + 文本格式加 UTF-8 BOM（`grid.ts:92-107`；`ResultGrid.tsx:256-257`）；TSV 不加引号；XLSX 由客户端小工具生成（`src/client/xlsx.ts`）。
- 无 INSERT / JSON 导出（`docs/09:68-75` B8）。

### 6.6 翻页

- 首页 / 上一页 / 下一页 / 末页 + 页大小下拉 `100/500/1000/5000`（`Pager.tsx:41-98`；`query.ts:14-15`）。
- 「末页」依赖已知总数；`total === null` 时禁用（`Pager.tsx:39,62-71`；`docs/05:138-142` COUNT 降级）。
- 范围文案 `第 a-b 行 / 共 N 行` 或 `总数未知`（`Pager.tsx:19-24`）；meta 显示 `N 行 · Xms` + 被截断单元格数（`93-96`）。
- **没有页码输入框、没有自定义页大小**（`docs/03:224` 声称有，与实现不符）。
- 改页大小**不会立刻重查**：只写入状态，下一页/下次执行才生效（`query.ts:69-72`；`Pager.tsx:74-91` → `onPageSize`）。

### 6.7 空态 / 错态

- 空：`执行查询查看结果` / `正在执行…`（`ResultGrid.tsx:189-195`）；成功但 0 行：`查询成功，没有返回行`（`199-205`）；筛选后 0 行：`没有匹配的行`（`477-483`）。
- 错：`role="alert"` 显示 `code` + 人性化 message（`ResultGrid.tsx:178-187`；`src/client/db-error.ts` 翻译；`docs/03:37-60`）。脚本失败：失败 tab 显示错误 + 「输出」tab 汇总整轮错误与错误码（`ScriptResults.tsx:41-49,131-176`）。

### 6.8 网格性能手段

- 行窗口化：>200 行只渲染「一屏 + 上下各 8 行」，用等高 spacer 撑滚动高度；行高固定 30px（`src/client/rowwindow.ts:14-21,43-64`；`ResultGrid.tsx:155-159,484-525`；`docs/03:104`）。
- 整页格式化只做一次（`formatRows` memo，含预先小写以省 filter 重复计算）（`grid.ts:50-68`；`ResultGrid.tsx:132-135`）。
- 拖选时目标未变不 setState（`ResultGrid.tsx:507-513`）。
- 视口高度在结果变化时量一次（`161-166`）。
- 列宽拖拽为本地 state（`112,221-237`），**不持久化**。

### 6.9 状态栏

- 左：范围（`整页 R 行 × C 列` / `选区 R 行 × C 列`）；中：聚合器（SUM/AVG/MIN/MAX/COUNT/DISTINCT，作用于选区，无选区作用于整页；从**原始值**算，跳过 NULL/空串/非数字；读数可点击复制；`Ctrl+Shift+C`）；右：面板渲染编码（`stats.ts:17,63-151`；`ResultGrid.tsx:531-569`；`docs/03:102`）。
- 窄容器（≤360px）隐藏编码与聚合下拉（`components/sqlWorkbench.css:1281-1293`；`docs/03:22`）。

---

## 7. 状态与历史

### 7.1 console / 标签生命周期

- 模型：`DocumentTab { id, title(console_N / ai_label / ddl_表名), connId, query, script, lastRunSql, owner?, label?, unread?, lastActivityAt? }`（`src/client/state/documents.ts:24-43`）。
- 上限：用户 console **8 个**（`MAX_TABS`，`documents.ts:46`；`+` 在满时禁用 `SqlWorkbenchPanel.tsx:571-575,873`）；agent console 软上限 4（`MAX_AGENT_TABS`，`documents.ts:52,169-171`）。
- 新建：`+` → `createTab` 绑定当前 `tabConnId`，标题取最小未占用 `console_N`（`documents.ts:57-75`；`SqlWorkbenchPanel.tsx:570-575`）。
- 关闭：`×` **直接关闭，无确认、无未保存保护**；关掉最后一个会补一个新的空 console；关掉当前 tab 时 `followTab` 让数据源跟随邻居（`documents.ts:99-111`；`SqlWorkbenchPanel.tsx:577-585`；`DocumentTabs.tsx:106-117`）。
- 切换：`onSelect` 清 unread、`followTab` 调 `api.setActive`（`SqlWorkbenchPanel.tsx:562-568`）。
- 脏标记 `*`：`query.sql.trim() !== '' && query.sql !== lastRunSql`（`documents.ts:113-116`；`DocumentTabs.tsx:104`）。注意单语句选区执行时 `lastRunSql = 选区`（§3.1 step 3）→ 可能与实际执行内容不符，`*` 语义漂移。
- 重命名 / 复制 console / 排序 tab / 拖拽 tab：**无**。（`docs/09:126` B14 也记「复制连接」未做）
- agent console：投递创建/复用（同 label + 同连接 + 等价 SQL 复用；不同 SQL → `ai_label#2`；换连接不复用），不抢焦点，`AI 历史` 抽屉保留 20 条可恢复（`documents.ts:137-298`；`DocumentTabs.tsx:131-165`）。

### 7.2 刷新持久化（docs/09 B4）

- **未实现**：documents 是纯 React state（`SqlWorkbenchPanel.tsx:103-108`），宿主没有对应持久化；`WorkbenchApi` 只有 `layout/saveLayout`，无文档读写（`src/client/api.ts:31-53`）；宿主 KV 里只存 `layout`（`src/host/panel-service.ts:31-32,209-214`；`src/host/binding.ts:39` 注释仅「later history/layout」）。→ **刷新即丢全部 console 与 SQL**（`docs/09:36-39`）。

### 7.3 查询历史（docs/09 B5）

- **未实现**：无环形存储、无历史下拉、无 `history` 路由；`WorkbenchApi`/`http-api.ts` 路由表里都没有 history（`api.ts:31-53`；`src/client/http-api.ts:21-33`）；`docs/09:41-48` 记「未做；`host/binding.ts:39` 预留了 `history` 文档名」，而宿主 KV 实际只写 `datasources`/`active`/`layout` 三个键（`src/datasource/store.ts:10-11`；`src/host/panel-service.ts:32`）。

### 7.4 布局持久化（已完成项）

- 存 `{ treeOpen, treeWidth, editorHeight }` 到宿主 `layout` 文档；恢复时按当前工作区重新 clamp；`0`/负数/非有限值回落默认；写入 400ms 防抖且等恢复完成（`SqlWorkbenchPanel.tsx:350-395`；`src/client/state/layout.ts:43-60`；`src/host/web-routes.ts:146-184`；`docs/03:16`）。
- 默认尺寸：树宽 244（min 168）、编辑区高 224（min 96）、结果区 min 132、panel gap 8、右列保底 320（`src/client/split.ts:16-34`）。

### 7.5 未保存保护

- 只有 `*` 视觉标记；关闭 tab、关闭页面、切连接均无确认/无草稿（`DocumentTabs.tsx:104`；`SqlWorkbenchPanel.tsx:577-585`；`beforeunload` 全仓无）。

---

## 8. 现状摩擦点清单（按「影响手写流畅度」从高到低）

> 只列能从代码 / 测试 / 文档 / 本地探针推出的；排序依据是「写 SQL 时被卡住的频率 × 卡住的代价」。不含改进建议。

| # | 摩擦点 | 现象与边界 | 证据 |
|---|---|---|---|
| 1 | **`Ctrl+Enter` 不认「光标所在语句」**：无选区且多语句时整段脚本全跑（遇错即停）；有选区但只含一条语句时**反而跑全文第一条**（选区被忽略） | 与 DataGrip「默认执行光标语句」的习惯相反；文案「有选中则只跑选段」只对跨多语句选区成立 | `SqlWorkbenchPanel.tsx:885-896`；`state/query.ts:75-107`；`execute/core.ts:238-242,342`；`docs/03:23` 与 `docs/05:51`；`tests/panel-script.spec.tsx:205-221` |
| 2 | **`FROM` / `JOIN` 后补不出表名**（真实快照每张表都带 schema → 顶层只有库名+别名；`FROM dwd_o` 零候选） | 手写必须记住并敲 `库名.` 才能拿到表；库多时顶层候选只有库名 | `editor-cm.ts:65-82,244-257`；`host/metadata.ts:69-76,108-135,215-223`；`@codemirror/lang-sql dist:551-574`；**本地实测**（附录 A）；`memory/2026-10-21.md:115` |
| 3 | **条件位置补不出列**：`WHERE ` 这类空白位置不自动弹；即使 `Ctrl+Space` 也只给库名+关键字（必须 `alias.` 或 `表名.`） | 与 DataGrip「WHERE 后只给列」差距最大的一处；别名解析本身是可用的 | 同上（`dist:551-556,573-574`）；本地实测表 |
| 4 | **无格式化 / 无软换行 / 窄面板**：没有美化键位与依赖；扩展里无 `lineWrapping`，长行只能横向滚；右栏实测约 497px，树展开后编辑区更窄 | 长脚本可读性完全靠手写排版；SQL 格式化连 `docs/09` 待办都没排 | `editor-cm.ts:330-366`（无 lineWrapping/格式化）；`package.json:42-54`；`docs/09:16-129`（无格式化条目）；`memory/2026-10-19.md:142`；`sqlWorkbench.css:1295-1305` |
| 5 | **刷新即丢全部 console 与 SQL（B4）+ 无查询历史（B5）** | 手写草稿与「昨天跑过的 SQL」都拿不回来；只剩布局尺寸持久化 | `SqlWorkbenchPanel.tsx:103-108`；`api.ts:31-53`；`docs/09:32-48`；`host/binding.ts:39-53` |
| 6 | **单语句执行路径用裸 `split(';')[0]`**，不识别字符串/注释 → SQL 里出现分号字符串（如 `LIKE '%a;b%'`）会被截断成非法语句 | 只影响单语句路径；脚本路径用的是 `splitStatements`（字符串感知） | `execute/core.ts:238-242,342` vs `execute/split.ts:30-89` |
| 7 | **补全/关键字恒大写，不跟随输入大小写** | 习惯小写的人每次接受都被改写成大写；无法配置 | `editor-cm.ts:248,254`；`docs/03:31`；`memory/2026-10-21.md:115` |
| 8 | **SQL 函数名基本无补全**（MySQL 方言的 builtin 是 mysql CLI 命令集，`date_format/ifnull/concat/cast` 等不在候选里） | 函数签名/名字靠记忆；只有零星词（`group_concat`、`count`、`sum` 等）因在关键字表里才出现 | `@codemirror/lang-sql dist:738,751-753`；`editor-cm.ts:244-257`（关键字链路）；本地实测（关键字只到 `FALSE/TRUE/UNKNOWN/NULL/…`） |
| 9 | **执行中 `Ctrl+Enter` 无重入守卫**：会并发发第二个请求，结果互相覆盖；`statementId` 被复用 | 「执行」按钮执行中禁用，但键盘绕过；用户连按两下很常见 | `editor-cm.ts:312-324`；`SqlWorkbenchPanel.tsx:885-896`；`query.ts:95`；`tests/workbench-exec.spec.tsx:114-130` |
| 10 | **`Tab` 是整行缩进而非「在光标处插入缩进」**；缩进单位是库默认 2 空格、`tabSize` 4，仓内不可配；无对齐/格式化 | 期望 Tab 补缩进或对齐的用户会得到「行首被移一格」；片段激活时 Tab 又是跳占位 | `editor-cm.ts:337,361`；`@codemirror/commands dist:1824`；`@codemirror/language dist:808-816`；`@codemirror/state dist:2890-2892` |
| 11 | **排序 / 筛选状态粘在 console 上**：换一条 SQL 重跑仍带旧 `ORDER BY` / `WHERE`，列不存在时直接报错或被意外过滤 | 面板执行入口不重置 `sort/filters`；只能手动点「清除筛选」/再点列头 | `query.ts:75-85`；`SqlWorkbenchPanel.tsx:885-896,949-964`；`ResultGrid.tsx:375-380` |
| 12 | **多语句脚本不可取消，且逐条串行 + 每条独立 COUNT（1200ms 上限）** | 10 条语句的脚本最坏要等 10×COUNT 超时；没有 statementId 可取消 | `execute/script.ts:62-121`；`execute/core.ts:118,360-376`；`SqlWorkbenchPanel.tsx:398-440`；`docs/05:64-67`；`memory/2026-10-19.md:162` |
| 13 | **文档承诺但未实现的编辑/结果交互**：错误行高亮（`docs/03:213`）、Shift 扩选/行列选择（`docs/03:227`）、页码输入/自定义页大小（`docs/03:224`）、`Ctrl+S` 保存脚本（`docs/03:228`）、菜单 hint 的 F4/Enter/Ctrl+B（`SchemaTree.tsx:164-167`） | 都是「看起来有、按了没有」的类型，直接打断手写心流 | 见左列逐条；`ResultGrid.tsx:338-358`；`Pager.tsx:74-91`；`query.ts:14-15`；grep 无绑定 |
| 14 | **对象树双击「打开数据」直接覆盖当前 console 的 SQL 并执行** | 没有新 tab、没有确认；正在手写的语句被替换（`hasSingleResult` 后旧结果也被替换） | `SqlWorkbenchPanel.tsx:690-694`；`SchemaTree.tsx:199-201` |
| 15 | **所有 console 共用一个 EditorView**：切 tab 用整文档替换 → 光标跳到文末，撤销栈跨 console 串味（Tab A 撤销可能把 Tab B 的文本写回来） | 由代码结构推出（未写测试）；`undo` 是 CM 状态的一部分，而替换文档是普通事务 | `SqlEditor.tsx:94-130,134-144`；`SqlWorkbenchPanel.tsx:876-884`；`editor-cm.ts:335` |
| 16 | **取消存在竞态**：取消后原请求返回仍会写回结果，覆盖「查询已取消」 | 无 AbortController/请求代次校验 | `query.ts:99-107,153-162`；`SqlWorkbenchPanel.tsx:635-659`；`tests/workbench-exec.spec.tsx:347-374` |
| 17 | **网格键盘能力弱**：只有单格移动；无 Shift 扩选、无行/列选择、无 `Ctrl+A` 全选、无「复制整页」（复制必须先用鼠标拖出选区） | 500 行结果里纯键盘几乎不可用 | `ResultGrid.tsx:321-359,260-263`；`grid.ts:71-89` |
| 18 | **结果区无查找（B6）、无列显隐（B7）**；宽表只能横向滚 | `Ctrl+F` 只在 CodeMirror 内生效 | `docs/09:50-66`；`ResultGrid.tsx` 无 find 相关；`editor-cm.ts:341` |
| 19 | **值查看器 `Esc` 可能无效**：浮层 `div` 无 `tabIndex`，双击打开后焦点仍在网格，Esc 不是浮层的 keydown | 按钮关闭始终可用 | `ResultGrid.tsx:571-582` vs `321-359` |
| 20 | **无错误标记/诊断/悬停**：SQL 语法错误只能在执行后从结果区/输出 tab 看到，编辑器里没有下划线或行标记 | 手写时常要「执行一次才知道错在哪一步」 | grep `linter/hoverTooltip` 无命中；`ResultGrid.tsx:178-187`；`ScriptResults.tsx:41-49` |
| 21 | **快捷键与宿主/输入法耦合**：`Ctrl+Shift+L` 在编辑器内会**同时**触发「选中相同文本」与「打开工作台」；`Ctrl+Space` 与中文输入法切换惯例同键 | 前者是事件冒泡层面的事实；后者是环境惯例（未在本仓验证）；IME 组字期间按键被 CM 忽略（不会误触发 Enter 执行） | `entry.ts:43-52`；`@codemirror/search dist:1056`；`@codemirror/view dist:9217-9248,4581,4674-4690`；`tests/client-shortcut.spec.ts:15-44` |
| 22 | **首次打开成本**：client bundle 从 176KB 涨到 513KB（gzip 167KB），已开 minify | 影响面板首次加载/刷新后的就绪时间（B12 未做） | `memory/2026-10-21.md:114`；`docs/09:104-111`；`docs/03:35` |
| 23 | **文档/待办与代码漂移**（不影响手感，但会让方案基于错误前提）：`docs/09` B10 说脚本结果不支持筛选（已支持）；`docs/03:23` 的选区口径；`docs/03:33` 只列了 4 个快捷键（实际一大把）；`AGENTS.md`/`docs/00` 目标宿主仍写 0.2.1-rc.2（本任务背景是 rc.3） | 建议 Lead 合成时以代码为准，或先修文档 | `docs/09:86-93`；`SqlWorkbenchPanel.tsx:1001-1006`；`ScriptResults.tsx:205-212`；`docs/03:23,33`；`memory/2026-10-21.md:77` |

---

## 9. 事实边界（未验证 / 无法从本仓推出）

- 未在本仓验证的环境级冲突：`Ctrl+Space` 与 Windows 中文输入法切换、`Ctrl+Alt+↑/↓` 与显卡驱动热键、`Ctrl+Shift+L` 是否被 dsh 壳层另有绑定。仓内只能证明「编辑器侧与全局侧都会收到该键」。
- 未做真机数据库验证（只读任务不装/不跑插件）；补全行为用真实 lang-sql 库 + 按 `toSqlNamespace` 形状构造的命名空间实测，**未连真实 Doris**。
- 「撤销栈跨 console 串味」「取消竞态」「值查看器 Esc 无效」是从代码结构推出的行为，仓内没有对应测试用例。
- 本文行号基于当前未提交工作区（HEAD `569f8b7` + 67 个改动文件）；提交后行号可能漂移。

---

## 附录 A：补全探针（只读、可复现）

在包目录 `packages/client/ui-sql-workbench` 下执行（`node --input-type=module`，stdin 输入，不落文件）：

```js
import { EditorState } from '@codemirror/state'
import { sql, MySQL } from '@codemirror/lang-sql'
import { CompletionContext } from '@codemirror/autocomplete'

function probe(label, doc, explicit, schema) {
  const state = EditorState.create({
    doc,
    extensions: [sql({ dialect: MySQL, upperCaseKeywords: true, ...(schema ? { schema } : {}) })],
  })
  const ctx = new CompletionContext(state, doc.length, explicit)
  const out = state.languageDataAt('autocomplete', doc.length).map(source => {
    const r = source(ctx)
    return r === null || r === undefined ? 'null' : r.options.slice(0, 10).map(o => o.label).join('|')
  })
  console.log(label + ' -> ' + JSON.stringify(out))
}

const named = { dwd: { dwd_order: ['order_id','amount'], dwd_customer: ['customer_id'] }, ads: { v_daily: ['day'] } }
const flat  = { dwd_order: ['order_id','amount'], v_daily: ['day'] }
probe('named FROM 空白',      'SELECT * FROM ', false, named)
probe('named FROM 空白 ctrl', 'SELECT * FROM ', true,  named)
probe('named FROM 表前缀',    'SELECT * FROM dwd_o', false, named)
probe('named FROM 库点',      'SELECT * FROM dwd.', false, named)
probe('named 别名点',         'SELECT * FROM dwd.dwd_order o WHERE o.', false, named)
probe('flat  FROM 表前缀',    'SELECT * FROM dwd_o', false, flat)
probe('named WHERE ctrl',     'SELECT * FROM dwd.dwd_order WHERE ', true, named)
probe('无 schema 表前缀',      'SELECT * FROM dwd_o', false, undefined)
```

输出（2026-10-26 本地实测，已在正文表格引用）：

```
named FROM 空白      -> ["null","null"]
named FROM 空白 ctrl -> ["dwd|ads","FALSE|TRUE|UNKNOWN|NULL|ABSOLUTE|ACTION|ADD|AFTER|ALL|ALLOCATE|ALTER|AND"]
named FROM 表前缀    -> ["dwd|ads","FALSE|TRUE|UNKNOWN|NULL|ABSOLUTE|ACTION|ADD|AFTER|ALL|ALLOCATE|ALTER|AND"]
named FROM 库点      -> ["dwd_order|dwd_customer","null"]
named 别名点         -> ["order_id|amount","null"]
flat  FROM 表前缀    -> ["dwd_order|v_daily","FALSE|TRUE|UNKNOWN|NULL|ABSOLUTE|ACTION|ADD|AFTER|ALL|ALLOCATE|ALTER|AND"]
named WHERE ctrl     -> ["dwd|ads","FALSE|TRUE|UNKNOWN|NULL|ABSOLUTE|ACTION|ADD|AFTER|ALL|ALLOCATE|ALTER|AND"]
无 schema 表前缀      -> ["FALSE|TRUE|UNKNOWN|NULL|ABSOLUTE|ACTION|ADD|AFTER|ALL|ALLOCATE|ALTER|AND"]
```
