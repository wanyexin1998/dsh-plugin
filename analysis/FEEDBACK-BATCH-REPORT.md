# 反馈批次报告（2026-10-27 上午）：8 项需求落地

分支 `feat/sql-fluency`（未合 `main`）。全部改动已通过串行门禁（见文末证据）。

## 逐项交付

| # | 需求 | 状态 | 实现要点 | 主要落点 |
|---|---|---|---|---|
| 1 | 右上角 icon 打开「快捷键设置面板」 | ✅ | 页面右上角 `⌨`；面板分组列出 10 个动作，可录制新键（Esc 取消录制/面板 Esc 关闭）、冲突标红、恢复默认；localStorage 持久化（坏数据回默认）；编辑器 keymap 用 Compartment 热重配（不重建 view，保留 undo/选区），面板全局键（命令面板/对象搜索）按设置匹配 | `shortcut-settings.ts`、`ShortcutSettings.tsx`、`ConnectionBar.tsx`、`editor-cm.ts`、`SqlEditor.tsx`、`SqlWorkbenchPanel.tsx` |
| 2 | 对象树层级颜色克制区分 | ✅ | 数据源根 primary+600、schema 行 secondary + layer-2 底、表/视图文件夹 secondary、对象名 primary、列名 secondary、列类型 tertiary；内联 token，不改 CSS，DOM/aria 不变 | `SchemaTree.tsx` |
| 3 | SQL/错误直发聊天框 + diff 提案接受/拒绝 | ✅ / 🟡 | 在 `conversation.input.dock` 注册隐藏桥，拿宿主 `inputActions`（captureInsertion/insertText/persistDraft）把文本插入**对话输入框**，无 composer 降级剪贴板；命令面板 3 动作（发 SQL / 发错误 / 粘贴 Agent 提案）；错误卡新增「发到聊天」；`DiffProposal` 行级 diff +N/-M、接受替换、拒绝/Esc。**提案来源目前为剪贴板**，agent 自动推送待接 | `chat-bridge.ts`、`index.ts`、`diff` 模块、`DiffProposal.tsx`、panel 接线 |
| 4 | 多光标列对齐 | ✅ | CodeMirror `rectangularSelection()` + `crosshairCursor()`；Alt+拖动列选择/Shift+Alt+方向扩列，已写入工具栏 ⓘ 提示 | `editor-cm.ts`、`SqlEditor.tsx` |
| 5 | 表概览补空值率/样例 + DDL，窗口限高可滚动 | ✅ | 对象树右键「表概览」改为弹窗：统计（总行数/每列非空/空值/空值率）、样例（前 20 行、横向滚动）、DDL（等宽）；三块并行加载、各自 loading/error；`max-height:78vh、max-width:min(900px,92vw)`，内容区滚动，Esc/关闭 | `TableOverview.tsx`、`schema-tree.ts`（overviewStatsSql/overviewSampleSql/nullRateText）、`SchemaTree.tsx`、panel |
| 6 | 时间显示统一 yyyy-mm-dd hh:mm:ss | ✅ | **原因**：历史面板原来显示相对时间（「N 分钟前 / HH:mm / M月D日」），结果日期列/值查看器用 `toISOString()`（UTC 带 T/Z）。**修法**：历史改本地绝对时间；Date 与 ISO 日期时间字符串统一按**本地时区** `yyyy-mm-dd hh:mm:ss`，date-only/自由文本原样 | `state/history.ts`、`format.ts` |
| 7 | 结果单元格不被宽度无限拉长 | ✅ | `table-layout:fixed` + 每列固定默认宽（文本 160 / 数字 120，可拖拽覆盖）；`table min-width=Σ列宽`，列多/拖宽时横向滚动不压缩；td nowrap+ellipsis+title（全文走值查看器） | `ResultGrid.tsx`、`sqlWorkbench.css` |
| 8 | 每个字段的筛选按钮 | ✅ | 列头独立 22×22 SVG 漏斗（title「筛选该列」、aria-label「筛选 {name}」/aria-pressed、active token 底色、hover/focus-visible、隐藏列即消失），复用既有服务端 WHERE 筛选 | `ResultGrid.tsx`、css |

## Q6 直接回答

之前不是 `yyyy-mm-dd hh:mm:ss` 的原因有两处：
1. **查询历史/收藏面板**用的是相对时间文案（`formatWhen`：`N 分钟前`、当天 `HH:mm`、更早 `M月D日 HH:mm`）。
2. **结果网格的日期列与值查看器**对 `Date` 用 `toISOString()`，所以显示的是 UTC 的 `2026-10-27T01:02:03.000Z` 形态。

现在两处都统一为**本地时区** `yyyy-mm-dd hh:mm:ss`（date-only 与自由文本保持原样）。

## 验收证据（串行跑，2026-10-27 09:5x）

- `tsc -b packages/client/ui-sql-workbench/tsconfig.json`：**0 错误**
- `vitest run`：**100 文件 / 1372 用例全绿**
- `node tools/run-coverage.mjs`：**exit 0（per-file 100%）**
- `build.mjs`：成功；`lib/client.js` **683,019 bytes（约 667KB，minify）**
- 门禁：`__ModuleLoader__` 契约 ✓、禁用 require 0、CSS 硬编码色 0、主题选择器 0、滚动条选择器 0、跨包 value import 0、peerDeps 0
- 人工 smoke：`docs/testing.md` §10 S116–S125（8 项逐条）

## 剩余/限制

- 406 的 **agent 自动推送 diff 提案**未接（当前「复制提案 → 命令面板粘贴 → 接受/拒绝」已可用）。
- 快捷键：Ctrl/Cmd 镜像绑定不可分平台；录制拒收无修饰字母键；`ShortcutsHelp` 速查表仍列默认键位。
- 聊天直发依赖宿主 `conversation.input.dock` 与打开的 composer，否则降级剪贴板（面板会提示实际去向）。
- 表概览统计对超大表可能较重（用户显式触发、可关闭；查询仍在跑）。
