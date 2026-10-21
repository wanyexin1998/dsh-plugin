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

### 修复（2026-10-20）：对象树视图缺失 / 右键菜单失效 / 徽标与箭头

用户现场反馈四条，全部真机复现并修复：

1. **视图缺失**（功能 bug，最严重）：对象清单原先只从 `information_schema.COLUMNS` 折出，而 Doris 的 COLUMNS 不返回视图列 → dwd 的 5 个视图、以及只含视图的 `ods_db` 整库都不显示。改为 TABLES 定对象、COLUMNS 补列（`withObjects`），并校验第三列必须是 TABLE_TYPE。实测 3 库/15 对象/1 视图 → **4 库/21 对象/7 视图**。
2. **右键菜单点了没用**（功能 bug）：关闭监听挂 `window pointerdown` 且无差别关闭，真实点击序列在 pointerdown 阶段就把菜单卸载了，click 到不了按钮。改为菜单内部忽略、外部才关；用例按 pointerdown→pointerup→click 回归。
3. **去掉 T/V 徽标**（视觉）：表/视图已有分组，前缀字母重复。
4. **箭头放大**（视觉）：10px → 13px，hover 提亮。

### 批次 7（2026-10-20）：编辑器内核、对象树正确性、DDL 落点、服务端筛选

用户逐条反馈驱动，六个提交，全部真机验证：

| 提交 | 内容 | 关键点 |
|---|---|---|
| `cd0a244` | 编辑器换 **CodeMirror 6** | 删掉 900 行自研（highlight/editor/caret/补全引擎）；主题走 `EditorView.theme` + `--dsw-*`（不产 CSS 文件）；schema/只读用 Compartment 热切换；`Ctrl-Enter` 三绑定（`Mod-` 在非 Mac 是 Ctrl） |
| `3c857a9` | 对象树两个真 bug | ① 视图缺失：COLUMNS 不返回视图列 → 改 TABLES 定对象；② 右键菜单点击无效：`window pointerdown` 在 click 之前卸载了菜单 → 菜单内忽略 |
| `ea14476` | 视图 DDL 被拒的人话提示 | 拒有两形态：`ok:false` 与 HTTP 5xx 抛异常，两处都要翻 |
| `eda95d0` | DDL 进编辑区 + 错误右下角 + 查询工具栏 | 新开 `ddl_<表名>` 标签；`lastRunSql` 设为 DDL 本身以免带 `*` |
| `624ba75` | 剪贴板三级策略 | `void writeText` 等于放弃错误处理；被拒回退 `execCommand`，再失败给提示 |
| `5296ce3` | 字段筛选改**服务端 WHERE** | 10 个操作符 + 进 COUNT；筛到 0 行仍渲染工具条（否则没出口） |

### 批次 6（2026-10-19）：编辑区/查询区/对象树面板化

参考用户既有插件 `dsh-split`（Dockview + `theme.gap`）的做法：统一圆角、透明 sash、靠间距分隔。对象树移到左栏并默认展开，编辑区/结果区在右上下分屏，三块都可用 8px 缝隙拖拽（并支持方向键微调 / 双击复位 / 收起成 rail）。详见 03 §1 布局与 testing S40–S45。

5 批全部完成。批次 5 的两处**有意偏离** DataGrip：① 它靠小页分页（`Limit page size to`）而不虚拟滚动，我们页大小可到 5000，所以加了窗口化；② 它的状态栏显示连接字符集，我们只能显示面板渲染编码（字符串已被驱动解码），不冒充连接 charset。

### 批次 8（2026-10-21）：agent 结果接入 console（R1–R9 + 对抗性审查）

**做了什么**：agent（就是 dsh 自身）执行的 SQL，结果现在落到它自己的 `ai_<label>` 控制台——与用户的 console 隔离，不抢焦点、不覆盖正在看的结果；多语句一次投递出 N 个结果 tab。完整规格与决策溯源见 **`10-AGENT-CONSOLE-SPEC`**（§2 决策总表、§13 契约、§14 实现状态、§15 审查）。

| 项 | 内容 | 关键点 |
|---|---|---|
| **R1** 结果回推 | MCP → 文件出箱 → 宿主扫描 → SSE / 轮询 → 面板 | MCP 是 stdio 子进程、**无 ctx**、argv 静态（拿不到宿主端口），所以只能走文件；中继是**至少一次**语义（先广播后删），重复由面板幂等吸收 |
| **R2** 多语句 | 新增 MCP 工具 `execute_script` | 复用 `src/execute/script.ts`；`MAX_SCRIPT_STATEMENTS=20` 且**硬 clamp**；回给 agent 的行数按 500 行总预算裁剪并标 `rowsTruncated`，**投递仍保留完整首页** |
| **R3** 契约 | `execute_sql` / `execute_script` 增加 `label?` / `consoleId?` | **有 label 才投递**（agent 纯取数不污染界面）；同名 + 同 SQL 就地更新，异 SQL 开 `ai_<label>#2`；新增**归属注册表**（面板 → 宿主 `consoles.json` → MCP 执行前校验），指向用户 console 时返回 `CONSOLE_NOT_AGENT` 且不执行 |
| **R6** 结果 tab 状态 | `ScriptTab` 自带 `sort / filters / pageSize / total` | 修掉三个真实缺陷：同一列表头点两次**永远 ASC**、每次 refetch **丢排序**、页大小是**全局**的；顺带解锁脚本 tab 的服务端筛选 |
| **R8 / R9** 标题与输出 | 标题 = `首列名:类型`（重名 ` (2)`）；新增「输出」tab | 错误**两处都显示**：失败 tab 即时可见、输出 tab 带错误码可追溯（只移进输出会让失败语句显示「执行查询以查看结果」，更误导） |
| 生命周期 | `ai_` 池软上限 4 + **「AI 历史」抽屉** | 只归档**已读且非激活**的 console；未读的永不隐藏（宁可超上限也不藏没看过的结果） |
| 焦点 | 不抢焦点；未读角标点 + 轻 toast | 恢复历史是用户点击，允许聚焦 |

**对抗性审查 15 条全闭合**（详见 `10` §15.6）：A1 换连接不再复用旧 console；A2/A4 改为至少一次（宁可重复不丢）；A3 抽屉落地；A5 上限不可被调用方调大；A6 补 `Last-Event-ID` 续传；A7 改按 **UTF-8 字节**（`TextEncoder`，共享模块不能用 `Buffer`）；A8 信封结构校验；A9 行预算；A10 复用换 label 同步标题；A11 spool 24h 清理；A12–A15 无障碍、文案与测试稳定性。

**验证**：745 测试通过（54 文件；基线 712）、`tsc --noEmit` 干净、`build.mjs` 三产物成功。

**留下的尾巴**：无未闭合项。刻意不做：一键把 agent SQL 发到自己的 console（promote）、流式投递、多 agent 并发、连接级写权限细分。

### 补齐（2026-10-21）：对象树收起不占位 + 布局持久化

**「收起后被挤压」的真因**：不是 rail 太宽，而是收起时内联 `gridTemplateColumns` 变成 `undefined`，而 `.workspace` 没有默认模板 → Grid 按 `grid-auto-flow: row` 把 rail 与面板列**排成上下两行**。改为两态都显式写模板（收起 = 单列 `minmax(0, 1fr)`，并补 `gridTemplateRows: minmax(0, 1fr)` 让单行吃满高度），列与 sash 一起消失。

**按钮位置**：从「树面板头 `«` + 收起后 22px 竖排 rail」改为**单一常驻开关**，放在 console 标签条最左端（`«` / `»`，`aria-expanded` 表状态）；标签条横向滚动时 `position: sticky` 吸左，不会被滚走；展开时按当前工作区重新 clamp 宽度。顺带把 `+`、AI 历史、开关移出 `role="tablist"`（内层 `display: contents` 保持一行 flex）。

**布局持久化（09 B3，已完成并从待办移除）**：新增宿主 `layout` 文档（`documents` 表 key `layout`，内容 `{treeOpen, treeWidth, editorHeight}`），面板经 `GET / POST /dsh-data-ide/layout` 读写。恢复时**按当前工作区 clamp**（只有浏览器知道面板现在多宽），`0` / 负数 / 非有限值回落默认（不是 clamp 到最小值）；写入 400ms 去抖，且必须等恢复完成才允许写，避免把默认值覆盖存档。职责划分：宿主只存不校验，浏览器负责解释。

**验证**：758 测试（55 文件）、`tsc --noEmit` 干净、`build.mjs` 成功。

### 补齐（2026-10-21）：MCP schema 工具、工作台入口、补全排序

**B1 · MCP `get_schema` / `list_tables`**：agent 之前看不到任何表结构，只能 `SELECT * … LIMIT 1` 猜列。两个工具复用**面板同一个** `createSchemaReader`（同一解析路径、5 分钟缓存），所以树和 agent 不可能对「有什么表」产生分歧。`get_schema` 支持 `table` 收窄（`表名` 或 `库.表名`）；`list_tables` 只给名字/类型/列数，先摸底用。工具面 7 → **9 个**。

**B2 · 「打开 SQL 工作台」入口**：tab 被关掉、或右栏收起时没有任何可点入口。加 `Ctrl/⌘+Shift+L` 快捷键（`entry.ts`，判定是纯函数），调用 `sidebarRight.openTab(kind)`——页类型是 `multiple: false`，宿主据此「已开则聚焦、未开则打开、右栏收起则展开」。绑定函数在非 DOM 环境自动降级（`client.spec` 跑在 node 环境，直接摸 `window` 会把整个入口打挂）。

**补全排序（用户反馈：打 `S` 不出 `select`）**：实测确认**弹窗有开、候选也有**，问题是 `lang-sql` 的关键字表按**字母序**排：`S` 的前 40 条是 `SAVEPOINT/SCHEDULE/SCHEMA/SCHEMA_NAME/SCHEMAS/SCROLL/SEARCH/SECOND`，`SELECT` 在折叠线以下；空前缀时 559 条从 `ABSOLUTE` 开始。修法：`completion-rank.ts` 提供约 45 个高频词的 `boost`（参与匹配打分，只改顺序）+ 12 个 live templates（`sel`/`selw`/`ins`/…，两字符起、展开为带光标占位的骨架，boost 高于关键字）。

**验证**：773 测试（58 文件）、`tsc --noEmit` 干净、`build.mjs` 成功（client 538KB）。

### 收尾（2026-10-21）：死代码清理、文档定稿

| 项 | 内容 |
|---|---|
| **清理** | 删除 5 处确认无人引用的导出：`entry.ts: OPEN_SHORTCUT_HINT`（文案已在 locales）、`contract/host.ts: SidebarRightTabActions`、`PanelBoundary.tsx: PanelBoundaryElement`、`grid.ts: filterIndexes`（早已被服务端筛选取代，docs/02 有注）、`metadata.ts: toSchemaIndex`（`{tables}` 的薄包装） |
| **接活** | `documents.ts: isAgentPoolFull` 此前只有测试在用，现接入投递提示：「ai_X 已出结果（AI 控制台已达 4 个，可关闭不用的）」——补上软上限缺的那个信号 |
| **测试** | 随死代码删掉 7 条失效用例（filterIndexes 5 条 + toSchemaIndex 1 条 + 收尾合并 1 条），净 **782 → 775**；没有为凑数保留死代码 |
| **文档** | `00` 索引补 10 号文档；`09` P0 段改为「已清空」并指回本节；`08` 新增批次 8 复盘 **R22（同路径只注册一次）/ R23（先 text 后 json）/ R24（void 必须接 catch）**；`10` 新增 §16「上线后修复」；`03` 补全策略与布局持久化说明；`05` 工具清单 9 个 |
| **验证** | 775 测试（60 文件）、`tsc --noEmit` 干净、`build.mjs` 三产物成功（client 539KB） |

**收尾时仍明确不做**：补全的语法位置感知（`FROM` 后只给表、别名解析）、关键字大小写跟随、promote（一键把 agent SQL 发到自己的 console）、流式投递、多 agent 并发。

## 8. 未完成清单

**已迁移**：唯一待办清单改为 `09-BACKLOG.md`（2026-10-20）。本文件只记录「做过什么」与「做过之后留下的尾巴」，避免两份清单打架。

历史沿革：本节的 G1（编辑内核）、G2（折叠）、G3（服务端筛选）三项已于 2026-10-20 完成，其余 G4–G16 已并入 09 的 B1–B17。

### 8.1.1 编辑器迁移留下的尾巴

| 项 | 说明 |
|---|---|
| bundle 体积 | client 半 176KB → **539KB**（2026-10-21 收尾；gzip 约 175KB），已开 `minify`；拆解：核心 view 277KB / 语言+折叠 +9KB / lang-sql +61KB / search+autocomplete +58KB / agent 流+注册表+补全排序 +26KB。若要更小见 09 B12 |
| 测试耗时 | 全量套件从 ~17s → ~2m15s：每个 jsdom 测试文件都要初始化 CodeMirror。已加 `Range.getClientRects` 补丁（否则会报未处理异常） |
| 补全的类型标签 | CodeMirror 自带的 `keyword/table/column` 文案仍是英文，未本地化 |
| 窄面板替换 | <460px 宽时隐藏「替换」控件（只能查找），加宽面板后恢复 |

### 8.2 已做但还差一口气

| # | 项 | 差什么 |
|---|---|---|
| P2 | 脚本执行的取消 | 多语句执行没有回传 `statementId`，脚本跑到一半无法取消（单语句可取消） |
| P3 | 值查看器 | 只读；DataGrip 的 Value Editor 可编辑 |
| P4 | 补全 | 表/列启发式已够用；但跨库同名表不区分前缀、不支持函数/关键字的上下文排序 |
| P5 | 状态栏聚合 | 只对"当前列"聚合；DataGrip 的 Aggregate View 能对多列同时给摘要 |
| P6 | MCP 工具面 | 9 个（ping / list_datasources / test_connection / **get_schema / list_tables** / execute_sql / execute_script / fetch_page / cancel_statement），agent 已能读表结构；仍缺脚本目录与 git 的 6 个工具（M3） |
| P7 | 分发 | 只在 `dev-sql-021` profile 里跑；装进 `web` profile（桌面端实际用的那个）需要用户明确批准（R13），`pack-plugin` 打包校验也没做过完整一轮 |

### 8.3 明确不做（维持原判）

N5 多结果集对比/图表、N6 远程执行（WSL/Docker）、M3 整段（git 脚本目录 + agent git 工具 + git 面板）、M4 Oracle 桥。这些都在 PRD「非目标」或 P1 候选里登记过，改动要走 RFC。
