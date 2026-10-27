# 夜间执行报告：dsh-data-ide SQL 手写流畅度批次（2026-10-27）

> 用户目标：按 `analysis/TASKS-sql-writing.md` 完成功能优化/开发，逐项测试、审查、验收，最后整体优化 UI/UX。
> 执行方式：Lead + 2 个并行实现 teammate（history/editor-intelligence），Lead 负责执行内核、direct 模式、面板/编辑器接线、对象树、UI 与验收。
> 代码位置：`E:\dsh-plugin\dsh-data-ide`，分支 **`feat/sql-fluency`**（基于 `backup/agent-console-wip` 的 a616632 WIP 备份分支，`main` 未动）。

## 一、结论（先看这段）

**已交付并全部通过自动化验收**：执行语义（光标语句/执行全部/重跑/取消竞态）、direct/paged 双模式、错误行号回编辑器、console 持久化、查询历史+收藏、编辑器智能（补全增强/格式化/`*` 展开/诊断/hover）、EXPLAIN、对象树真快捷键+生成 SQL+新 console 打开数据、UI 工具栏/直跑条/历史抽屉打磨。

**未完成、已登记**：结果区查找（B6）、列显隐（B7）、导出 INSERT/JSON（B8）、结果→SQL、命令面板、全局对象搜索、参数化查询、表概览、结果 tab 命名/pin、agent 结对、更深一轮 UI/UX。详见 `docs/09-BACKLOG.md` §6.2。

**验收状态**：
- 79 个测试文件 / **1134 个用例全绿**；
- **per-file 100% coverage**（`compute-budget` 门禁通过，exit 0）；
- `tsc -b` 0 错误；
- `build.mjs` 成功，client bundle **606KB**（minify；gzip 约 190KB）；
- 产物契约 / 禁用硬编码色 / 禁主题选择器 / 禁 `::-webkit-scrollbar` / 禁跨包 value import / peerDeps 门禁：**0 违规**；
- **真机 smoke 未跑**（桌面 profile 由 Electron 独占，需要你早上点一遍，清单见 `docs/testing.md` §7 S73–S90）。

## 二、逐项交付（对应 TASKS 的 SQL-xxx）

| 任务 | 状态 | 交付物 |
|---|---|---|
| SQL-101 语句边界定位 | ✅ | `src/execute/split.ts`（end 偏移 + `statementAt` + 注释感知） |
| SQL-102/104 Ctrl+Enter 光标语句 / 执行全部 | ✅ | `editor-cm.ts` RunTarget、`SqlEditor.tsx`、`panel` onRun 分支 |
| SQL-103 单条选区 bug + firstStatement | ✅ | 选区文本真正被执行；字符串/注释内 `;` 不截断 |
| SQL-105 重入守卫 | ✅ | 执行中再按执行键只发一个请求 |
| SQL-106 取消竞态 | ✅ | run token；取消后旧响应不再覆盖 |
| SQL-108/109 重跑上次 / 单条重跑 | ✅（重跑键）/ 🟡（结果 tab 单条重跑沿用既有刷新入口） | Ctrl/Cmd+Alt+Enter；结果区刷新 |
| SQL-110 执行提示 + 软换行 + 状态栏 | ✅ | 「将执行/光标位置/选区/语句数」；`EditorView.lineWrapping` |
| SQL-111 快捷键冲突 | ✅ | 编辑器内 `Ctrl+Shift+L` 让位选中相同；Esc 分层 |
| SQL-201/202 持久化 + 现场恢复 | ✅ | `state/history.ts` workspace 快照、宿主 storage 路由；刷新恢复 SQL/tab/光标/页大小 |
| SQL-203/204/205 历史/收藏 | ✅ | 历史环形 200、搜索、双击插入/替换、收藏钉住/删除、`Ctrl+Shift+H` 抽屉 |
| SQL-206/207/208 补全增强 | ✅ | FROM 出跨库表、表达式位置出列（别名感知）、114 个函数字典 |
| SQL-210 格式化 | ✅ | 自研确定性格式化（幂等/字面量保留），Ctrl+Alt+L |
| SQL-211 `*` 展开 | ✅ | 按当前语句目标表展开，未知/多表给提示 |
| SQL-212 生成骨架 | 🟡 | 「生成 SELECT」「添加全部列」已上；FK/命名约定 JOIN 生成未做 |
| SQL-213 命令面板 | ❌ | 见 09 §6.2 |
| SQL-214 全局对象搜索 | ❌ | 见 09 §6.2 |
| SQL-215 hover | ✅ | 表/视图/列/函数卡片 |
| SQL-216 多光标 | 🟡 | CM 内置已可用并写入提示；列对齐未做 |
| SQL-217 树快捷键 | ✅ | Enter/F4/Ctrl+B 真绑定，焦点不在树时不抢 |
| SQL-218 打开数据非破坏性 | ✅ | 新 `data_N` console，原草稿保留 |
| SQL-301/302/303 direct 模式 | ✅ | 原样 SELECT + 探针 LIMIT 不 COUNT；元数据原样；结果区模式条 +「统计总数」切 paged |
| SQL-304 错误行号映射 | ✅ | direct/paged 偏移换算，编辑器高亮+滚动 |
| SQL-305 前 N 行预览 | ✅ | direct 默认 |
| SQL-306 EXPLAIN | ✅ | 新 console + 原始计划；Ctrl+Shift+E |
| SQL-307/308/309 lint | ✅ | 语法错误 / 未知表 / 未知 alias.col / 无 WHERE 的 UPDATE·DELETE（可关，保守） |
| SQL-310 错误下一步 | 🟡 | 行号跳转+复制已有；「问 agent/EXPLAIN」入口未串 |
| SQL-311 结果查找 B6 | ❌ | 见 09 §6.2 |
| SQL-312 列显隐 B7 | ❌ | 见 09 §6.2 |
| SQL-313 网格键盘 | ❌ | 见 09 §6.2 |
| SQL-315 排序/筛选生命周期 | ✅ | 换 SQL 清旧条件并提示 |
| SQL-401/402 导出/结果→SQL | ❌ | 见 09 §6.2 |
| SQL-403/404 参数化/表概览 | ❌ | 见 09 §6.2 |
| SQL-405/406 agent 结对 | ❌ | 见 09 §6.2 |
| SQL-501/502/503 验收/文档 | 🟡 | smoke 清单与文档已写；指标复测待真机 |

## 三、验证命令（可直接复跑）

```powershell
cd E:\dsh-plugin\dsh-data-ide
node node_modules/typescript/bin/tsc -b packages/client/ui-sql-workbench/tsconfig.json   # 类型
node node_modules/vitest/vitest.mjs run                                                 # 1134 用例
node tools/run-coverage.mjs                                                             # per-file 100%
node packages/client/ui-sql-workbench/build.mjs                                         # bundle
```

真机验收：重启 DeepSeek Harness（插件包已 link 到 desktop profile，构建产物已更新），打开右栏「SQL 工作台」，按 `docs/testing.md` §7 S73–S90 逐条点。

## 四、主要代码改动（模块级）

- 执行内核：`execute/split.ts`、`execute/core.ts`（direct 模式/行偏移）、`execute/envelope.ts`
- 执行界面：`state/query.ts`（mode/重跑/错误行）、`utils? no`、`components/SqlWorkbenchPanel.tsx`（onRun/runSource/explain/openData/历史/持久化）、`components/SqlEditor.tsx`（RunTarget/状态栏/格式化/展开/历史按钮）、`editor-cm.ts`（快捷键/错误行装饰/extras 槽）
- 编辑器智能（teammate 新增 6 模块）：`sql-functions.ts`、`completion-extra.ts`、`sql-format.ts`、`expand-star.ts`、`sql-lint.ts`、`sql-extras.ts`
- 记忆（teammate）：`state/history.ts`、`components/HistoryPanel.tsx`、`host/binding.ts`、`host/web-routes.ts`、`client/api.ts`、`client/http-api.ts`
- 对象树：`SchemaTree.tsx`、`schema-tree.ts`
- UI：`sqlWorkbench.css`（工具栏横向滚动、直跑条、历史抽屉、错误行样式）、`entry.ts`
- 文档：`AGENTS.md`、`docs/00/03/07/08/09/testing`
- 测试：新增 18 个 spec 文件（含 direct 模式、query 模式、面板直跑/历史、语句定位等）

## 五、已知限制（务必读）

1. **AC-2/AC-3 只属于 paged 模式**；手写栏默认 direct（不 COUNT），这是本次刻意的语义拆分。
2. **真机未验证**：所有 UI 结论来自 jsdom 单测；右栏宽度、滚动、桌面主题需你点一遍。
3. lint/格式化是**启发式/自研**，不是 PSI 级；对 CTE/派生表保守跳过，快照截断时可能漏报。
4. 历史只记录**面板执行**；agent/MCP 跑的不入历史（MCP 无宿主状态）。
5. 脚本执行仍走旧的逐条 paged 路径（direct 未透传），脚本取消未做。
6. `coverage-run.log` 等临时产物已清理；未合入 `main`。

## 六、下一步建议（按优先级）

1. 你早上按 S73–S90 点一遍，把「不顺手」的具体步骤反馈给我；
2. 继续 09 §6.2：结果区 B6/B7/B8/结果→SQL（一个批次）、命令面板+全局搜索（一个批次）；
3. 若接受 direct 默认语义，再更新 `docs/05`/MCP 侧工具契约与 agent 协作（上一份 `PLAN-borrow-from-ide-workbench.md` 的 M1/M2）。

---

## 七、凌晨续跑（第二轮 ~ 第四轮，全部已提交）

用户睡着后继续按清单推进，分支 `feat/sql-fluency` 目前有 5 个提交：

| 提交 | 内容 | 测试 |
|---|---|---|
| `0ec1f3f` | 第一轮：执行语义 / direct-paged / 持久化 / 历史 / 编辑器智能 / EXPLAIN / 对象树 | 79 文件 / 1134 用例 |
| `a397090` | 第二轮：结果区查找 B6、列显隐 B7、键盘、INSERT/JSON 导出 B8、结果→SQL、命令面板、全局对象搜索 | 83 文件 / 1185 用例 |
| `0289ae8` | 第三轮：快捷键速查（?）、工具栏分组/滚动、焦点环、空态 | 86 文件 / 1189 用例 |
| `f5d5fe0` | 第四轮：表概览（新 console 统计 SQL）、命名参数 `:name`（执行前表单 + 字面量替换）、AI 结对 prompt（复制到剪贴板） | 90 文件 / 1211 用例 |
| `docs` 修正 | 00 变更记录补齐第二轮~第四轮 | — |

### 最终验证（2026-10-27 00:45 左右，最新一次）

- `tsc -b`：**0 错误**
- `vitest run`：**90 个测试文件 / 1211 个用例全绿**
- `tools/run-coverage.mjs`：**exit 0（per-file 100%）**
- `build.mjs`：成功；`lib/client.js` **646,267 bytes（minify，约 631KB）**
- 门禁：产物 `__ModuleLoader__.load` 契约 ✓；`require("@deepseek-ai/…")` / `require("react/…")` 0；CSS 硬编码色 0；主题选择器 0（仅注释提及）；`::-webkit-scrollbar` 0；跨包 value import 0；`@deepseek-ai/dsh*` peerDeps 0
- 真机 smoke：仍未跑（桌面 profile 由 Electron 独占，需人工按 `docs/testing.md` §7/§8/§9 S73–S106）

### 相对第一轮新增的完成项（TASKS 编号）

- SQL-311 结果查找 B6、SQL-312 列显隐 B7、SQL-313 网格键盘、SQL-401/402 导出 INSERT/JSON + 结果→SQL
- SQL-213 命令面板、SQL-214 全局对象搜索
- SQL-404 表概览、SQL-403 命名参数、SQL-405/406 的一半（解释/优化 prompt 复制给 AI；真正直发对话未做）
- SQL-309 的 UI 入口仍缺（lint 已有模块与波浪线，未做开关）
- 快捷键速查（SQL-2xx 可发现性）

### 仍未完成（诚实清单）

1. **SQL-314 结果 tab 命名/pin**、**SQL-212 的 JOIN 生成**、**SQL-309 诊断开关**、**SQL-310 错误下一步按钮**（行号跳转已有）
2. **SQL-405/406 的真正聊天集成**：需要 `conversation.input.dock` / toolview 桥（Reference 方案里的 deferred 部分），当前只到「复制 prompt」
3. 多光标列对齐（SQL-216 剩余一半）、更深一轮视觉打磨（第一次 UI 打磨已落地）
4. 真机 smoke / 指标复测（需人工）

### 建议验收顺序

1. 重启桌面端（插件是 link 安装，构建产物已更新）→ 右栏「SQL 工作台」；
2. 按 `docs/testing.md` §7 S73–S90（第一轮）→ §8 S91–S98（结果区/全局）→ §9 S102–S106（表概览/参数/结对）；
3. 重点体感：光标语句执行、direct 模式不等 COUNT、历史抽屉、格式化/展开星、结果查找/列显隐/复制 IN、Ctrl+Shift+P、对象树右键表概览。

---

## 八、第五轮（错误下一步）与最终状态

新增提交 `fbd6800`：失败结果卡支持 **复制错误 / 定位到第 N 行 / EXPLAIN / 问 agent（复制错误 prompt）**，单语句与脚本 tab 共用；无行号时自动隐藏定位。

### 最终验证（最新）

- `tsc -b`：0 错误
- `vitest run`：**90 个测试文件 / 1219 个用例全绿**
- `run-coverage`：**exit 0（per-file 100%）**
- `build.mjs`：成功；`lib/client.js` **648,112 bytes（约 633KB，minify）**
- 门禁：产物契约 ✓ / 禁用 require 0 / CSS 硬编码色 0 / 主题选择器 0（仅注释）/ 滚动条选择器 0 / 跨包 value import 0 / peerDeps 0
- 最终提交链（分支 feat/sql-fluency）：`0ec1f3f` → `a397090` → `0289ae8` → `f5d5fe0` → `6c696a4`（文档）→ `fbd6800`

### 剩余未做（诚实清单，按优先级）

1. **SQL-212 JOIN 生成**：右键「生成 SELECT/添加全部列/表概览」已上，按同名列猜 ON 的 JOIN 生成未做。
2. **SQL-309 诊断开关**：lint（语法/未知表/别名列/无 WHERE DML）已实现并有波浪线，但没有设置开关。
3. **SQL-314 结果 tab 命名/pin**：tab 仍用「首列:类型」，未支持主表名/重命名/pin。
4. **SQL-405/406 的真正聊天直发**：目前是「复制 prompt 到剪贴板」；直发需要 conversation.input.dock / toolview 桥。
5. SQL-216 多光标列对齐（CM 原生多光标可用，列对齐未做）；更深一轮视觉打磨。
6. 真机 smoke 与指标复测（需人工；清单 docs/testing.md §7–§9，S73–S110）。

> 结论：57 项里绝大多数已落地并逐项单测；上面 3–6 属剩余 P2/需要宿主桥或人工执行。目标在会话里保持 active，未虚报完成。

---

## 九、第六轮（JOIN 生成 / 诊断开关）与收尾状态

新增提交：JOIN 骨架生成（对象树右键 JOIN → 对象搜索选第二表 → 按同名列 ON，无同名列留 TODO）+ 命令面板诊断开关（lint 波浪线可关）。

### 收尾验证

- `tsc -b`：0 错误
- `vitest run`：**90 文件 / 1223 用例全绿**
- `run-coverage`：**exit 0（per-file 100%）**
- `build`：**649,014 bytes（约 634KB，minify）**
- 门禁：产物契约 / 无禁用 require / 无硬编码色 / 无主题选择器 / 无滚动条选择器 / 无跨包 value import / 无 peerDeps —— 全过
- 提交链（feat/sql-fluency）：0ec1f3f → a397090 → 0289ae8 → f5d5fe0 → 6c696a4 → fbd6800 → （本轮 JOIN/诊断）

### 最终剩余（P2 / 需人工或宿主桥）

1. SQL-314 结果 tab 命名/pin（当前仍「首列:类型」）
2. SQL-405/406 真正直发聊天（当前复制 prompt；需 conversation.input.dock 桥）
3. SQL-216 多光标列对齐（CM 原生多光标可用）
4. 真机 smoke 与 AC/指标复测（需人工，清单 docs/testing.md §7–§9 S73–S110）

结论：57 项任务中除以上 P2/需宿主能力项外均已落地并有 per-file 100% 单测；不虚报完成，目标保持 active。

---

## 十、第七轮（格式化大小写 / 结果 tab 命名）与最终状态

- 格式化关键字大小写（SQL-209）：命令面板循环 大写/小写/保持原样，格式化跟随。
- 结果 tab 主表命名（SQL-314 命名部分）：`parseTableTitle` 从 FROM/JOIN 取主表（JOIN `a+b`，去 schema/反引号），单结果与脚本结果 tab 优先显示表名；重命名/pin 仍在待办。
- 验收矩阵更新：**✅ 46 ｜ 🟡 9 ｜ ❌ 2**（剩 SQL-107 脚本取消、SQL-502 真机指标复测）。
- 最终验证：`tsc -b` 0 错误；**91 文件 / 1229 用例全绿**；覆盖率 exit 0（100%）；build **649,919 bytes（约 635KB）**。

---

## 十一、第八轮（结果 tab 重命名/pin）与最终状态

- 双击结果 tab 内联重命名（Enter/focusout 提交、Esc 取消、空名忽略）；右键固定/取消固定（📌）。
- pin 的 tab 在下一次脚本执行时保留，新结果 tab 追加在后。
- 验收矩阵：**✅ 47 ｜ 🟡 8 ｜ ❌ 2**（仅剩 SQL-107 脚本取消、SQL-502 真机指标复测）。
- 最终验证：`tsc -b` 0 错误；**91 文件 / 1234 用例全绿**；coverage exit 0（100%）；build **651,238 bytes（约 636KB）**。

---

## 十二、第九轮（脚本执行取消）与最终状态

- 新增 `ScriptRequest.statementIds`：客户端为每条语句预生成 id，host 逐语句透传给执行核心；脚本运行中按「取消」会 cancel 当前语句，驱动拒绝后循环停止（SQL-107 完成）。
- 契约向后兼容：不传 `statementIds` 的 MCP/旧客户端行为不变。
- 最终验收矩阵：**✅ 48 ｜ 🟡 8 ｜ ❌ 1**；唯一 ❌ 是 **SQL-502 指标复测**（需真实 Doris + 本机 desktop，jsdom 无法完成，属人工验收步骤）。
- 最终验证：`tsc -b` 0 错误；**91 文件 / 1236 用例全绿**；coverage exit 0（per-file 100%）；build **651,398 bytes（约 636KB）**；7 项门禁全过；工作区干净。
- 分支 `feat/sql-fluency`：10 个功能提交 + 2 个文档提交。人工验收清单：docs/testing.md S73–S115。
