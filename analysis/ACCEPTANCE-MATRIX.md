# 逐项验收矩阵（2026-10-27 夜间批次）

> 对照 `analysis/TASKS-sql-writing.md` 的 57 项任务；状态：✅ 已实现并有测试 ｜ 🟡 部分实现/有限制 ｜ ❌ 未做。
> 统计：**✅ 50 ｜ 🟡 6 ｜ ❌ 1**。自动化证据：100 测试文件 / 1372 用例全绿、per-file 100%、`tsc -b` 0 错误、build 683,019 bytes。

## 基线（SQL-001~004）

| # | 状态 | 说明 |
|---|---|---|
| 001 基准任务与埋点基线 | 🟡 | 自动化基线（测试/覆盖率/体积）有；真实 Doris 指标基线未跑 |
| 002 文档漂移修正 | ✅ | AGENTS 宿主版本更正、03/07/08/09/00/testing 同步 |
| 003 宿主键位占用探测 | 🟡 | 键位按冲突分析选取并避免抢 CM；未做运行时探测 |
| 004 formatter/lint 依赖与体积评估 | ✅ | 不引新依赖，自研模块；体积前后有记录 |

## 执行与编辑（SQL-101~111, 201~218）

| # | 状态 | 证据 |
|---|---|---|
| 101 语句边界纯函数 | ✅ | `execute/split.ts` + statement-at-cursor spec |
| 102 Ctrl+Enter 光标语句 | ✅ | panel/editor specs |
| 103 单条选区 bug/firstStatement | ✅ | panel-script/statement specs |
| 104 Ctrl+Shift+Enter 全部 | ✅ | panel-script spec |
| 105 执行重入守卫 | ✅ | query-mode/panel specs |
| 106 取消竞态 | ✅ | run token + panel specs |
| 107 脚本执行可取消 | ✅ | 客户端 statementIds 随脚本下发，取消停当前语句并终止循环 |
| 108 重跑上次 | ✅ | editor-component/panel specs |
| 109 结果 tab「重跑这条」 | 🟡 | 结果区刷新按钮等价；未做逐 tab 文案 |
| 110 执行上下文提示/软换行/状态栏 | ✅ | SqlEditor meta + lineWrapping |
| 111 快捷键作用域与冲突 | ✅ | entry/editor specs |
| 201 console 持久化 | ✅ | history/host/web-route specs |
| 202 刷新恢复现场 | ✅ | panel-history spec |
| 203/204/205 历史与收藏 | ✅ | history panel/specs |
| 206/207/208 补全增强 | ✅ | completion-extra/sql-functions specs |
| 209 关键字大小写跟随选项 | ✅ | 命令面板循环 大写/小写/保持原样，格式化跟随 |
| 210 格式化 | ✅ | sql-format + panel specs |
| 211 `*` 展开 | ✅ | expand-star + panel specs |
| 212 生成骨架/全部列/JOIN | ✅ | 生成 SELECT/插入列/JOIN 骨架/表概览 |
| 213 命令面板 | ✅ | commands/palette/panel specs |
| 214 全局对象搜索 | ✅ | object-search + panel specs |
| 215 hover | ✅ | sql-extras spec |
| 216 多光标+列对齐+最近对象 | 🟡 | CM 原生多光标可用并写入提示；列对齐未做 |
| 217 对象树快捷键 | ✅ | schema-tree/editor specs |
| 218 打开数据非破坏性 | ✅ | 新 console + panel spec |
| 301~306 direct/元数据/双模式/错误行/预览/EXPLAIN | ✅ | core/query/panel/editor specs |
| 307~309 lint（语法/未知表列/无 WHERE DML）+ 开关 | ✅ | sql-lint + palette toggle spec |
| 310 错误下一步动作 | ✅ | 复制/定位/EXPLAIN/问 agent + panel spec |
| 311 结果查找 / 312 列显隐 / 313 网格键盘 | ✅ | grid-actions spec |
| 314 结果 tab 命名/pin | ✅ | 主表/JOIN 命名 + 双击重命名 + 右键 pin（跨下一次执行保留） |
| 315 排序/筛选生命周期 | ✅ | panel-direct spec |
| 401/402 导出 INSERT·JSON / 结果→SQL | ✅ | result-actions + grid specs |
| 403 参数化查询 | ✅ | params/ParamsForm/panel-params specs |
| 404 表概览 | ✅ | 弹窗：总行数/非空/空值/空值率 + 前 20 行样例 + DDL，限高可滚动 |
| 405 发送到聊天框 | ✅ | `conversation.input.dock` 隐藏桥真插入 composer，无 composer 降级剪贴板 |
| 406 Agent 解释/优化/修复 diff | 🟡 | 解释/优化 prompt + diff 接受/拒绝 UI 已做；提案目前经剪贴板，agent 自动推送未接 |

## 验收文档（SQL-501~503）

| # | 状态 | 说明 |
|---|---|---|
| 501 基准 smoke 写入手册 | 🟡 | docs/testing.md 已扩到 S73–S110；真实「5 个基准」未写 |
| 502 指标复测与对比 | ❌ | 需真实 Doris 与本机 desktop，无法在 jsdom 完成 |
| 503 文档同步收尾 | ✅ | 00/03/07/08/09/testing/AGENTS + 报告 |

## 未做项的收口建议

- **314**：实现主表名解析 + 内联重命名 + pin（预计半天，纯前端）。
- **107**：脚本级取消需 executeScript 回传每语句 statementId（契约改动）。
- **209**：格式化选项 `keywordCase: 'upper'|'lower'|'preserve'`，UI 放命令面板。
- **502 / 001 / 003 / 501**：必须真机 + 真实数据源，建议 30 分钟人工 smoke 时顺带记录。
- **404 剩余 / 405 / 406 / 216**：P2 增强，不影响「手写 SQL 顺手」的主线体验。
