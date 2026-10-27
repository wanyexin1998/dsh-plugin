# 反馈批次 2 报告（2026-10-27 下午）：DataGrip 式表格交互 + 补全键位

分支 `feat/sql-fluency`（未合 `main`）。代码已提交，工作区干净；串行门禁全绿。

## 逐项交付

| # | 需求 | 状态 | 实现 |
|---|---|---|---|
| 1 | 快捷键增加「提示补全代码」（回车补全） | ✅ | 快捷键设置面板 editor 组新增两行：**唤起代码补全**（默认 `Ctrl+Space`）与 **接受补全（回车）**（默认 `Enter`）；可录制新键（Tab 也可，录制态 Enter/Tab 不再被当确认）；持久化与冲突检测自动覆盖。编辑器：`startCompletion` / `acceptCompletion`；**有补全弹层时 Enter 接受候选，无弹层时 Enter 正常换行**。速查表同步两行 |
| 2 | 仿 DataGrip 图1：字段升降序与筛选按钮 | ✅ | ①列头视觉左侧漏斗（点开筛选器），DOM 排序钮仍第一（兼容既有绑定）；②排序三态图标 `⇅ / ↑ / ↓`，点列名或图标循环 无→升→降→无，active 高亮 + title；③筛选器升级为浮动「本地筛选器」：搜索框 + 值列表（复选框 + **本页计数**，计数降序、上限 200、NULL 排除）+ 条件模式（保留原 10 操作符）；④勾选值应用后生成**服务端 IN 筛选**（`FilterOp 'in'`、`FilterSpec.values`，空列表 `1=0`、字符串转义、数字 raw 兜底）；提示「本页计数 · 应用后服务端筛选」；已有 in 筛选重开恢复勾选 |
| 3 | 图2 单元格还是被拉长 | ✅ | `.table` 由 `width:100%` 改 `width:max-content`（inline `min-width=Σ列宽`）：单列只占默认 120/160px，右侧留背景，选中行不再横跨整行；列多/拖宽横向滚动；sticky 表头、window padding、选区、导出、值查看器未回归 |

### 关于 DataGrip 图1 的设计（回答“它是怎么设计的”）

- **两个独立控件**：漏斗=筛选（值列表本地筛选器），列名/旁边的指示箭头=排序；互不抢点击区域。
- **筛选是“本地”的**：标题「xxx 的本地筛选器」、搜索框、值列表 + 每值出现次数、复选框多选；它过滤的是已加载到客户端的数据（DataGrip 会把结果集缓存在本地，所以能统计全量值）。
- **排序是三态**：未排序显示 ⇅，点击升序 ↑、再点降序 ↓、再点取消。
- 我们的差异（有意为之）：工作台结果可能只加载一页（direct/paged），所以**计数明确标“本页”**，勾选后不是本地隐藏行，而是**转成服务端 `IN (...)` 重新查询**——这样分页/总数/排序仍正确；需要 NULL 时用「条件」模式。

## Q3：为什么图2 仍被拉长

上一轮把 `table-layout` 改成了 fixed，但 `.table` 还是 `width:100%`；在 `table-layout:fixed` 下浏览器会把剩余宽度分给列，所以单列（`SUM(order_amount_d)`）被拉到整个面板宽、选中行横跨整行。现在表格宽度改为**列宽总和**（`max-content` + `min-width=Σ列宽`），单列保持默认 120/160px，剩余区域留背景；列多或手动拖宽时横向滚动。

## 验收证据（串行）

- `tsc -b packages/client/ui-sql-workbench/tsconfig.json`：**0 错误**
- `vitest run`：**100 文件 / 1403 用例全绿**
- `node tools/run-coverage.mjs`：**exit 0，per-file 100%**（ResultGrid、execute/core.ts、shortcut-settings、editor-cm、SqlEditor、ShortcutsHelp 等均 100%）
- `build.mjs`：成功，`lib/client.js` **690,739 bytes（约 675KB，minify）**
- 门禁：产物契约 ✓、禁用 require 0、CSS 硬编码色 0、主题选择器 0、滚动条选择器 0、跨包 value import 0、peerDeps 0
- 人工 smoke：`docs/testing.md` §11 S126–S130

## 已知取舍/限制

- 值列表计数是**本页**计数（非全表 distinct）；应用后服务端 IN 结果准确。
- IN 列表上限 200 值、单字符串截 200 字符；空选择=永不匹配（`1=0`）。
- 筛选浮层不做外部点击关闭（与列菜单/查找条一致），点漏斗/应用/取消/移除关闭。
- 速查表仍显示默认键位（自定义键位以设置面板为准）。
