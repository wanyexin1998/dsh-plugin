# 07-MILESTONES — 里程碑与任务拆解

> 状态：草案（待 G3 实现就绪）｜上游：01/02/03/04/05/06/08 定稿后本文基线化
> 排期假设：1-2 名工程师（1 名熟悉 dsh 插件体系 + 1 名全栈），与 COMPREHENSIVE-ASSESSMENT §6.2 的 P0/P1 对齐。

---

## 1. 总体判断

| 评估基准 | 本项目 | 差异原因 |
|---|---|---|
| COMPREHENSIVE-ASSESSMENT P0：2-3 人月（自研全栈） | **M0-M2 约 4-6 周**（连接+执行+网格） | 复用 dsh 底座：UI 组件/token/插件机制/MCP 挂载全免；mysql2 直连免 JDBC 驱动生态与 Aether；无编辑回写/内省 |
| P1：6-12 人月 | M3-M4 约 3-5 周（git + Oracle 桥） | git 走 CLI 封装；Oracle 桥是最重单项 |
| P2：2 人年+ | 不做 | 远程执行/补全/introspection 明确非目标 |

## 2. P0/P1 对齐映射

| 评估条目 | 本项目里程碑 | 处置 |
|---|---|---|
| 连接配置存储（#2） | M1 | ✅ 保留（storage-json + credentials，等价设计） |
| 凭据管理（#3） | M1 | ✅ 保留（ctx.credentials seam） |
| 驱动声明体系（#4） | M1（降级） | ⚠️ 驱动内置（mysql2/Oracle 桥），无下载生态 |
| 驱动制品解析 Aether（#5） | — | ❌ 剔除（轻量化） |
| classloader 隔离（#6） | M4（仅桥需要） | ⚠️ 缩窄 |
| 连接建立/测试（#7） | M1 | ✅ 保留（三态） |
| 执行后端进程外（#8） | M0（白得） | ✅ 保留（MCP server 天然外置） |
| 分页取数（#9） | M2 | ✅ 保留（LIMIT n+1+COUNT+OFFSET） |
| 结果网格渲染（#10） | M2 | ⚠️ 简化（无图像/格式缓存、服务端排序） |
| 编辑回写（#11） | — | ❌ 非目标 N1 |
| 内省缓存（#12） | — | ❌ 非目标 N2 |
| SSH/SSL（#7 部分） | — | ❌ 非目标 N3 |

## 3. WBS（任务拆到 2-5 天）

### M0 脚手架与注册（1.5 周）— 状态：进行中（2026-10-17 启动）

> 2026-10-17 修订：开发位置由 monorepo 内改为外部独立仓库（见 06 §1），M0-1/M0-2/M0-3 相应调整；M0-3 的最终注册形态以 S1 spike 结论（06 §12）为准。

| ID | 任务 | 产出 | 验收 | 依赖 | 状态 |
|---|---|---|---|---|---|
| M0-1 | 建独立 git 仓 `E:/dsh-plugin/dsh-data-ide`；确认目标宿主 = dsh 0.1.7-rc.2；建 `dev-sql` profile | 开发仓 + 独立 profile + 可启动 dsh | 独立 profile 可启动，不污染 `web` / `desktop` profile | 06 §12.7 | ✅ 仓库已建；宿主已定位；profile 待建 |
| M0-2 | 建包 `packages/client/ui-sql-workbench`（裸包名 `dsh-data-ide`；双入口 + `./mcp` 子路径 + `dsh.bundle.patch`；零 peerDeps） | 可 bundle 的插件包 | `pnpm build` 三入口产出 + tsc 声明 | M0-1 | ✅ 已完成（lib/{index,client,mcp/server}.js + types） |
| M0-3 | 右栏页面类型注册（`sidebarRightTabs.register` + `sidebar.right.pane.tab`/`.title`，key = `dsh-data-ide.sql-workbench`）+ 运行期守卫 + 空 tab | 右栏出现「SQL 工作台」tab | AC-7 初步；每会话独立面板 | M0-2 | ✅ **实机通过**（dev-sql + dsh 0.1.7-rc.2，用户确认入口可见）；期间修复浏览器半产物契约（06 §12.7.8） |
| M0-4 | MCP server（stdio，`ping` 工具）+ patch 内 `mcp-sql` 实例（serverName `sql`、超时 120s、路径经 `!!js` 解析） | 可被 dsh spawn 的 server | 装进 dev-sql 后 agent 见 `mcp__sql__ping` | M0-2 | ✅ **AC-5 实机通过**：agent 返回 `{"ok":true,"pong":"pong","server":"dsh-data-ide"}` |
| M0-5 | 测试骨架（vitest client/node/MCP/manifest/产物契约/端到端 spawn；per-file 100% thresholds）+ `tools/precommit.sh` 六项自检 | 绿 | 06 §11 清单过 | M0-2 | ✅ 32 测试全绿、per-file 100%、precommit 通过 |

### M1 连接管理（1.5 周）

| ID | 任务 | 产出 | 验收 | 依赖 |
|---|---|---|---|---|
| M1-1 | S2 spike：mysql2×Doris 差异矩阵 | 差异记录表 + 连接默认属性 | S2 成功标准（08 §2） | M0-4 |
| M1-2 | 存储层：`KvStore` 端口 + 连接定义单写者 + schemaVersion + 坏记录隔离 | 04 §3 落地 | 单测覆盖 | M0-5 | ✅ 已完成（含宿主绑定层：域声明 + 表适配 + spec 自动重发布） |
| M1-3 | 凭据层：凭据端口封装（key 规范化、session 态、孤儿清理）+ 运行时 spec 文件通道 | 04 §4 落地 | 密码永不入文档（测试断言） | M1-2 | ✅ 已完成 |
| M1-4 | 连接 CRUD UI（表单/列表/删除/复制） | 03 §4.2 线框 | AC-1 部分 | M1-2 | 🟡 连接条 + 配置弹窗 + 删除已实现；**「复制连接」仍未做** |
| M1-5 | 测试连接三态（server 探测 + database-info 缓存 + 三态渲染） | 03 §4.5 | AC-1 全过 | M1-1/M1-3 | 🟡 三态渲染与探测已实现；**待真实 Doris 连通性 smoke**（用户执行） |
| M1-6 | MCP 工具：list_datasources / test_connection | 05 §3.1 | agent 可见可用 | M1-5 | ✅ 已实现（宿主绑定层与 UI 待接） |

### M2 执行与网格（2 周）

| ID | 任务 | 产出 | 验收 | 依赖 |
|---|---|---|---|---|
| M2-1 | execute_sql/fetch_page/cancel_statement（分页 SQL 生成 + COUNT + 大值保护 + 只读门禁 + 审计位） | 05 §3.2 | AC-2/AC-3 | M1-6 | ✅ 引擎 + 工具 + 界面共用通道（`src/execute/`，宿主服务 `execute/fetchPage/cancel`）；per-file 100%；**审计位与历史未接** |
| M2-2 | 编辑器区（CodeBlock SQL 高亮 + sub-tab + 执行/取消/保存） | 03 §4.3 上部 | 交互状态矩阵过 | M2-1 | 🟡 已做：执行/取消 + Ctrl/Cmd+Enter、Esc + 光标锚定补全 + 轻量高亮 + 行号/当前行/括号匹配 + **多 SQL tab（console_N，每 tab 绑连接与颜色）** + 多语句执行（每语句一个结果标签）+ 选中只跑选段 + 面板化三栏；**未做**：代码折叠、查找替换、注释/缩进快捷键、多光标、跳转到行、SQL 格式化、保存脚本 |
| M2-3 | 结果网格（表/列宽/格式化/复制 TSV/CSV/选择） | 03 §6 | AC-2 | M2-1 | 🟡 已做：类型化格式化 + sticky 表头 + 服务端排序 + 列头筛选（本页）+ 列宽拖拽 + 矩形选区复制 TSV + CSV/TSV/XLSX 导出 + 刷新 + **状态栏聚合（SUM/AVG/MIN/MAX/COUNT/DISTINCT）** + 窗口化渲染 + 值查看器；**未做**：服务端筛选、导出 INSERT、转置、列显隐 |
| M2-4 | 分页条 + 页大小菜单 + COUNT 展示/降级 | 03 §4.3 下部 | AC-3 | M2-3 | ✅ 首页/上一页/下一页/末页 + 页大小菜单 + 总数与"总数未知"降级 + 行数/耗时/截断提示 |
| M2-5 | 服务端排序（列头三态） | 03 §6.3 | 排序后分页一致 | M2-4 | ✅ 已实现（`sortBy`，排序后回第 1 页；中文列名可用） |
| M2-6 | 查询历史（UI + agent 共享） | 04 §5 | 环形清理生效 | M2-1 | ⬜ **未做** |
| M2-7 | 权限默认只读 + writeEnabled 开关 + DDL 黑名单 + 审计日志 | 05 §6 | AC-6 | M2-1 | 🟡 只读门禁/DDL 黑名单/writeEnabled 已实现；**审计日志未做** |
| M2-8 | "打开 SQL 工作台"命令入口（split 兜底） | 03 §1 | R10 缓解验证 | M2-2 | ⬜ **未做**（契约里有 `openTab`，但没有命令/DOM 入口真正调用它） |

### M3 git 面板（1-1.5 周）

| ID | 任务 | 产出 | 验收 | 依赖 |
|---|---|---|---|---|
| M3-1 | S4 spike：脚本目录隔离 + git CLI 封装 | git 核心模块 | S4 成功标准（08 §2） | M0-4 |
| M3-2 | MCP 工具 git_status/diff/commit/pull/push + list/read/write_scripts | 05 §3.3/§3.4 | AC-4（agent 侧） | M3-1 |
| M3-3 | git 面板 UI（status/diff(DiffBlock)/commit message/pull/push） | 03 §4.4 | AC-4（人侧） | M3-2 |
| M3-4 | remote 凭据流（token → 临时 credential helper） | 04 §4/§7 | 不落盘不断泄 | M3-2 |

### M4 Oracle Java 桥 —— **已降级为 P1，本轮不做**（2026-10-17 用户决定：基本不用 Oracle）

> 下表保留作 backlog 存档；若恢复，先解决 R4（java 运行时、ojdbc11 OTN 许可分发、冷启动策略）。

| ID | 任务 | 产出 | 验收 | 依赖 |
|---|---|---|---|---|
| M4-1 | S3 spike：桥最小闭环（ojdbc + URLClassLoader + stdio JSON-lines） | 桥 jar + 协议 | S3 成功标准（08 §2） | M2-1 |
| M4-2 | 桥生命周期（懒启动/保活 10min/崩溃恢复/冷启动超时） | 02 §4.2 | 冷启动 ≤30s 见 NO 态 | M4-1 |
| M4-3 | server 路由 oracle → 桥；错误码映射 | AC-1（Oracle） | Oracle 连接三态 | M4-2 |
| M4-4 | OTN 许可声明 + 桥分发（随 bundle） | 06 §10 | R12 合规检查过 | M4-3 |

### M5 打磨与发布（0.5-1 周）

| ID | 任务 | 产出 | 验收 |
|---|---|---|---|
| M5-1 | AC-1~AC-8 全量回归 | 验收报告 | G4 |
| M5-2 | per-file 100% coverage + Agent Note | 06 §11 清单 | 全过 |
| M5-3 | 本地 bundle + `dsh plugin add` 安装验证 | 可安装产物 | 干净环境装后即用 |
| M5-4 | 文档定稿 + 风险复盘更新 | 00-08 定稿 | G3/G4 |

## 4. 依赖图与关键路径

```
M0-1 → M0-2 → M0-3 ──┐
              └→ M0-4 → M1-1 → M1-5 → M1-6 → M2-1 → M2-3 → M2-4 → M2-5
                                  │                            └→ M2-6
                                  ├→ M2-7 ──────────────────────→ M2-8
                                  └→ M3-1 → M3-2 → M3-3 → M3-4
                                  └→ M4-1 → M4-2 → M4-3 → M4-4（可并行后置）
M5-* 依赖全部
```

关键路径：M0-2 → M1-6 → M2-1 → M2-3 → M2-4（执行+网格主链）。M3/M4 与 M2 尾段可并行。

## 5. 每里程碑验收门槛（引用 PRD 编号）

| 里程碑 | 门槛 |
|---|---|
| M0 | AC-5（ping 工具可见）；06 §11 清单 | ✅ 2026-10-17 全过（AC-5 实机 + 六项自检） |
| M1 | AC-1；AC-6 前半（默认只读生效） |
| M2 | AC-2/AC-3/AC-6/AC-7 |
| M3 | AC-4 |
| M4 | AC-1（Oracle） |
| M5 | AC-1~AC-8 全过；G4 |

## 6. 明确不做（P2，防范围蔓延）

远程执行（WSL/Docker）、SQL 智能补全/解析器、编辑回写、SSH/SSL 隧道、多结果集对比、图表、驱动下载生态。需求回流走 RFC + G0 复审（R11）。

> 注：introspection/schema 树已由 N2 窄版与后续「对象树层级化 + 右键菜单」覆盖，不再是「不做」项；仍未做的是键/索引/触发器节点与结构比对。

## 7. DataGrip 差距补齐（2026-10-19 起的 5 批）

用户按 DataGrip 截图排的批次，逐批落地并各自带真机检查脚本：

| 批次 | 内容 | 状态 |
|---|---|---|
| 1 | 编辑器基本功：行号、当前行高亮、括号匹配 | ✅ `91c3391` |
| 2 | 结果区：列头筛选、列宽拖拽、矩形选区复制 TSV、CSV/TSV/XLSX 导出、刷新 | ✅ `064aebb` |
| 3 | 多 SQL 标签（console_N）+ 每标签绑连接与颜色；结果钉在发起标签 | ✅ `e139283` / `b6fac66` |
| 4 | 对象树层级化（数据源→库→表/视图）+ 右键菜单（打开数据 / 复制引用 / 查看 DDL / 刷新） | ✅ 本轮 |
| 5 | 状态栏聚合（SUM/AVG/MIN/MAX/COUNT/DISTINCT + 范围 + 编码）、窗口化渲染、值查看器 | ✅ 本轮 |

已知缺口（未做）：编辑器折叠（需真正的编辑模型）、服务端筛选（现仅当前页）、DataGrip 的「定位到行」、脚本执行的取消（statementId 未回传）。

### 批次 6（2026-10-19）：编辑区/查询区/对象树面板化

参考用户既有插件 `dsh-split`（Dockview + `theme.gap`）的做法：统一圆角、透明 sash、靠间距分隔。对象树移到左栏并默认展开，编辑区/结果区在右上下分屏，三块都可用 8px 缝隙拖拽（并支持方向键微调 / 双击复位 / 收起成 rail）。详见 03 §1 布局与 testing S40–S45。

5 批全部完成。批次 5 的两处**有意偏离** DataGrip：① 它靠小页分页（`Limit page size to`）而不虚拟滚动，我们页大小可到 5000，所以加了窗口化；② 它的状态栏显示连接字符集，我们只能显示面板渲染编码（字符串已被驱动解码），不冒充连接 charset。

## 8. 未完成清单（2026-10-19 盘点）

按「用户能感觉到的影响」排序，全部有代码/文档证据（不是猜测）。

### 8.1 功能缺口（DataGrip 有、我们没有）

| # | 功能 | 现状 | 影响 | 粗略成本 |
|---|---|---|---|---|
| G1 | **编辑器不是真正的代码编辑器** | `SqlEditor` 是透明 textarea 叠着色层（`SqlEditor`+`highlight`+`completion`+`editor`+`caret` 共 ~900 行自研）：没有查找替换、注释切换（Ctrl+/）、Tab/Shift+Tab 缩进、多光标、代码折叠、跳转到行 | 写复杂 SQL 时手感明显弱于 DataGrip | 大（换编辑器内核） |
| G2 | **代码折叠** | 未做（依赖 G1 的编辑模型） | 长脚本难读 | 中（随 G1 一起做） |
| G3 | **服务端筛选** | 只有当前页客户端筛选（工具栏明说「本页」） | 大表里"找一行"必须先回数据库改 SQL | 中（WHERE 包裹 + 与分页/排序共存） |
| G4 | **查询历史** | 未做（`M2-6`）；宿主表名早就预留了 `history` 文档 | 昨天跑过的 SQL 找不回来 | 小～中（环形存储 + 面板下拉） |
| G5 | **脚本保存 / 控制台内容持久化** | 未做：刷新页面后 console 里的 SQL 全丢（客户端无 localStorage，宿主也没有 documents 持久化） | 误刷新就丢工作 | 小（把 documents 落到 KvStore） |
| G6 | **审计日志** | 未做（`M2-7` 的后半）：只读门禁/DDL 黑名单有了，但没有"谁在什么时候跑了什么" | agent 侧安全追溯缺一环（R6 的缓解项） | 小～中 |
| G7 | **「打开 SQL 工作台」命令入口** | 未做（`M2-8`）：契约里有 `openTab`，没有命令/DOM 入口调用它 | 右栏 tab 被关或布局异常时没有兜底入口（R10） | 小 |
| G8 | **复制连接** | 未做（`M1-4` 尾项） | 建同类连接要重填一遍 | 小 |
| G9 | **导出 INSERT / 转置 / 列显隐** | 未做；导出只有 CSV/TSV/XLSX | 拿结果去造测试数据不方便 | 小～中 |
| G10 | **执行计划 / EXPLAIN 视图** | 未做 | 慢查询只能自己跑 EXPLAIN 看网格 | 中 |
| G11 | **事务 / 自动提交开关、会话管理** | 未做（连接一律自动提交） | 需要显式事务的场景做不了 | 中～大 |
| G12 | **多结果集**（存储过程 `CALL` 返回多个结果集） | 未做（`mysql2` 只取第一个结果集） | 调存储过程时看不到后续结果 | 中 |
| G13 | **单元格编辑回写**（N1） | 明确不做（P1） | 分析场景够用；要改数据得回 DataGrip | 大 |
| G14 | **SSH/SSL 隧道**（N3） | 明确不做（P1）：现有数据源都内网直连 | 换到需要跳板的环境就用不了 | 中 |
| G15 | **Oracle / Java 桥**（N7） | 明确不做（P1，2026-10-17 决定） | 基本不用 Oracle | 很大 |
| G16 | **对象树的键/索引/触发器节点、结构比对、拖拽生成 JOIN** | 未做（PRD N2 已注明"仍不做"） | 设计表/查约束时要切回 DataGrip | 中～大 |

**G1 的两条路线（尚未决策，需要 spike）**

| 方案 | 体积/集成 | 收益 | 代价 |
|---|---|---|---|
| **CodeMirror 6**（优先） | 按需拼装，通常 150–300KB 打进 bundle；样式走 JS 注入（`EditorView.theme`），不额外产 CSS 文件；无 worker | `@codemirror/lang-sql` 自带 MySQL 方言 + schema 补全/别名解析，可直接吃掉我们现在的 `completion`/`highlight`/`editor`/`caret`；折叠、查找、多光标、Tab 缩进、注释开箱即用 | 要重写 `SqlEditor` 适配层；IME（中文输入）、大文本粘贴、撤销栈与受控状态同步要逐项真机验证 |
| Monaco | 2–5MB，需要 worker + 独立 CSS，`__ModuleLoader__` 工厂内加载 worker 很别扭 | IDE 级（诊断、跳转定义、多文件） | 对"跑一条 SQL 看结果"过重，包体与加载成本不划算 |

我们的约束不影响打包：`build.mjs` 只把 `react`/`react-dom` 当壳模块，第三方依赖由 esbuild 打进 `client.js`（产物门禁只拦 `require("@deepseek-ai/…")` 与 `require("react/…")`）。spike 的验收线建议定为：bundle 增量 ≤150KB、5000 行脚本输入不卡、中文 IME 与 Ctrl+Enter/Ctrl+Space/Esc 全部行为保持、per-file 100% 只算我们自己的适配层。

**在此之前可以先做不换内核的低成本补齐**：Tab/Shift+Tab 缩进、Ctrl+/ 注释、跳转行、以及「格式化 SQL」（可复用 SQL 分词器，不必引入库）。

### 8.2 已做但还差一口气

| # | 项 | 差什么 |
|---|---|---|
| P1 | 布局尺寸 | 拖动后的左栏宽度/编辑区高度**不持久化**，重开回到 244/224；`dsh-split` 是落盘的 |
| P2 | 脚本执行的取消 | 多语句执行没有回传 `statementId`，脚本跑到一半无法取消（单语句可取消） |
| P3 | 值查看器 | 只读；DataGrip 的 Value Editor 可编辑 |
| P4 | 补全 | 表/列启发式已够用；但跨库同名表不区分前缀、不支持函数/关键字的上下文排序 |
| P5 | 状态栏聚合 | 只对"当前列"聚合；DataGrip 的 Aggregate View 能对多列同时给摘要 |
| P6 | MCP 工具面 | 只有 6 个（ping/list_datasources/test_connection/execute_sql/fetch_page/cancel_statement）；**agent 读不到表结构**（面板有 `schema` 路由，MCP 没有对应工具） |
| P7 | 分发 | 只在 `dev-sql-021` profile 里跑；装进 `web` profile（桌面端实际用的那个）需要用户明确批准（R13），`pack-plugin` 打包校验也没做过完整一轮 |

### 8.3 明确不做（维持原判）

N5 多结果集对比/图表、N6 远程执行（WSL/Docker）、M3 整段（git 脚本目录 + agent git 工具 + git 面板）、M4 Oracle 桥。这些都在 PRD「非目标」或 P1 候选里登记过，改动要走 RFC。
