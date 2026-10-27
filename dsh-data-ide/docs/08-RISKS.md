# 08-RISKS — 风险登记册

> 状态：初版（Day 1）｜随里程碑复盘更新｜概率/影响：高/中/低
> 关联：01-PRD（范围）、02（架构）、06（工程）、08 自身每条附验证实验（spike）计划。

---

## 1. 风险主表

| ID | 类别 | 描述 | 概率 | 影响 | 缓解策略 | 触发信号 | 关联 |
|---|---|---|---|---|---|---|---|
| R1 | 工程基线 | **已发生并已处置**：原定基线 `codex/presentation-v2`（0.1.1/0.1.2-rc.1）已被现役 0.1.7-rc.2 超越，`session.pane.right`/`requestCapacity` 在现役中不存在；本项目已切到 `sidebar.right.pane.tab` 口径（2026-10-17）。残余风险：0.1.7 之后的右栏扩展点再次改名/重构 | 中 | 中 | ① 锁定 0.1.7-rc.2 为验收基线；② 运行期守卫（`src/client/guard.ts`）fail-closed；③ 每次 harness 升级重跑 M0 冒烟（tab 可见 + `mcp__sql__ping`） | 升级 dsh 后 tab 消失 / Guard 打印原因 | 06 §12.7 |
| R2 | 工程基线 | **peer semver 硬门禁**（0.1.7 实证）：声明了 `@deepseek-ai/dsh*` peerDeps 且不满足运行时 → 整包被 skip（现场：dsh-workbench 因钉 `0.1.1-rc.2` 被反复跳过） | 高 | 高 | 本插件**不声明任何 `@deepseek-ai/dsh*` peerDeps**（`plugin-compatibility.ts:69` 对无 peerDeps 的包免检）；产品兼容交给运行期 Guard；回归测试断言 manifest 无 peerDependencies | 启动日志出现 `skipping profile bundle … incompatible` | 06 §12.7.5 |
| R3 | 数据正确性 | mysql2 × Doris 2.1.10 方言差异：`@@default_authentication_plugin` 已实证 errCode 1193（DataGrip 忽略）；事务/批量/类型映射/timezone 待探测 | 高 | 中 | M1 spike：对 doris.shcell.com:9030 跑差异矩阵（事务、批量、`SELECT 1`、时区、大结果集）；连接属性默认集对齐 DataGrip 实证值 | 查询结果与 DataGrip 不一致 | 02 §4 |
| R4 | 数据正确性 | Oracle Java 桥（JRE 分发/隔离/保活/崩溃恢复/OTN 许可）——**2026-10-17 降级 P1，本轮不做** | 低 | 低 | M4 独立里程碑；懒启动+空闲保活（如 10min）+崩溃重启；错误映射到三态；许可声明随包 | Oracle 查询超时/桥僵死 | 02 §4 |
| R5 | git 安全 | git 凭据与目录卫生：误提交宿主仓库、remote 凭据泄露、大文件入库 | 中 | 高 | 脚本目录与宿主仓库物理隔离（`<dshHome>/data-ide-scripts/`）；`.gitignore`；token 走 `ctx.credentials`；单文件上限 | 误提交报警 / 仓库体积异常 | 04 §7 |
| R6 | 安全 | MCP stdio 子进程**不受 dsh sandbox 约束**（MCP SDK 直接 spawn，宿主用户全权限）；agent 可借工具执行任意 SQL | 高 | 高 | 默认只读（AC-6）；写操作连接级 writeEnabled；env 清洗（凭据不经 env）；命令黑名单（DROP/TRUNCATE 等默认拒绝，可配置）；审计日志 | agent 越权写 / 异常 DDL | 05 §6 |
| R7 | 可用性 | mcp-client 重连预算：连续 10 次失败后**永久注销工具**，agent 侧工具静默消失，只能重启恢复 | 中 | 中 | server 崩溃自动重启（监督器）；健康检查；文档告知运维动作（重启 profile） | agent 报告"工具不存在" | 05 §7 |
| R8 | 性能 | 大结果集内存：500 行 × 宽表 × 多页缓存 × 多 tab | 中 | 中 | 页大小默认 500 可调；上限 5000；当前页外缓存限制（如 ±2 页）；大值 1MB/单元格截断 | OOM / UI 卡顿 | 04 §6 |
| R9 | 工程效率 | per-file 100% coverage 门禁拖累迭代 | 高 | 低 | 先写测试再写实现（TASP）；豁免仅限不可达分支并附 reason；UI 测试聚焦渲染状态矩阵 | 迭代速度下降 | 06 §9 |
| R10 | UI 正确性 | ~~分屏 capacity 生命周期~~ → **已关闭**：0.1.7 右栏不需要 `requestCapacity`，改为页面类型注册 + `rightbar.session` 按会话实例化 | 低 | 低 | 保留「打开 SQL 工作台」入口（`sidebarRight.openTab(kind)`），不依赖任何容量协商 | 右栏里找不到 tab 入口 | 06 §12.7.3 |
| R11 | 范围 | 编辑回写/introspection/SSH 请求回流（N1-N3） | 中 | 中 | PRD 非目标清单 + P1 候选登记；变更走 RFC 与 G0 复审 | 迭代中范围争议 | 01 §5 |
| R13 | 安装 | **2026-10-20 更正**：桌面应用（`DeepSeek Harness.exe`）用的是 **`desktop` profile**，不是 `web`；且 `desktop` 由 Electron 独占，CLI 连 `--dump-config` 都会被拒 → 装完**无法用 CLI 端到端验证**，只能由人点快捷方式肉眼确认。`web` 是另一套手工环境 | 中 | 中 | 装前备份 profile 配置（本次：`/tmp/desktop-profile-backup-20261020-132115`、`/tmp/web-profile-backup-20261020-130142`）；`plugin add` 后看 `package.json` 的 `dsh.profile.bundles` 是否多出 `dsh-data-ide`；`dev-sql-021` 同步 link 同一份源码，用它做自动化验证；启动失败时看 `~/.dsh/logs/startup-*.log`（**只在失败时写**，没有新日志即启动成功） | 桌面端启动异常 / 右栏找不到 tab | 06 §12.1 |
| R17 | 工程效率 | **测试套件变慢**（CodeMirror 迁移后 ~17s → ~2m15s）：每个 jsdom 文件都要初始化 EditorView，测量回调还需 `Range.getClientRects` 补丁 | 高 | 低 | 已加 `tests/setup/jsdom-cm.ts`；进一步优化见 09 B11 | 每次 precommit 等两分钟，久而久之绕过门禁 | 07 §8.1.1 |
| R18 | 性能 | **client bundle 变大**（176KB → 513KB / gzip 167KB）：CodeMirror 自带 view 引擎 277KB + 方言 61KB + 查找补全 58KB | 中 | 低 | 已对 client 目标开 `minify`；体积基线写进 06；进一步裁剪见 09 B12 | 首屏变慢 / 产物膨胀 | 06 §3、07 §8.1.1 |
| R19 | 数据正确性 | **Doris 的 `information_schema.COLUMNS` 不返回视图列**：以 COLUMNS 为对象清单会整类丢视图（真实库 21 对象丢到 15）。已改为 TABLES 定对象（2026-10-20） | 中 | 中 | `withObjects()` 合并 + 第三列 TABLE_TYPE 校验；无列对象在树里保留并显示「无列信息（视图）」 | 用户以为库是空的 / 找不到视图 | 07 批次 7 |
| R12 | 合规 | 商标与命名：不得使用 JetBrains/DataGrip 名称/Logo；Oracle 驱动 OTN 许可；mysql2 MIT（无 GPL 传染，记录为选型收益） | 低 | 高 | 品牌三层命名（00 §7）；驱动许可声明随包；法务评审发布物 | 发布物含商标元素 | 00 §8 |

## 2. 高风险项的验证实验（spike）排期

| Spike | 对应风险 | 时点 | 成功标准 |
|---|---|---|---|
| S1 切分支 + 空 tab 注册 + requestCapacity | R1/R10 | M0 D1-D2 | presentation-v2 上右栏出现空 SQL tab；split 打开/关闭行为符合预期 |
| S2 mysql2 × Doris 差异矩阵 | R3 | M1 D1-D3 | 事务/批量/时区/`SELECT 1`/大结果集行为记录成表；连接默认属性定稿 |
| S3 Java 桥最小闭环 | R4 | M4 D1-D3 | `java -jar` 桥经 stdio 完成 Oracle `SELECT 1`；冷启动/保活/崩溃恢复策略验证 |
| S4 git 目录隔离与凭据 | R5 | M3 D1 | 临时 repo 完成 status/diff/commit/pull/push；token 不经 env 不经日志 |
| S5 MCP 权限默认策略 | R6 | M2 D2 | 默认拒绝写；writeEnabled 放行；审计日志可见 |

## 2.3 批次 8 复盘（2026-10-21）

| 风险 | 状态 | 说明 |
|---|---|---|
| R22 同路径重复注册 | **已处置** | `ROUTES.layout` 同时被 `carrier.register`（GET）与 `post()`（POST）注册，宿主路由表是**一个路径一个 handler**，后者顶掉前者 → GET 打到 POST handler，宿主直接回 **405 且响应体为空**。规则：**一条路径只注册一次**，多方法在 handler 内按 `req.method` 分派；用例断言「路由表无重复路径」 |
| R23 `response.json()` 当成安全操作 | **已处置** | 空 body（404/405/204/连接中断）会让 `json()` 抛 `SyntaxError: Unexpected end of JSON input`，把真实原因（路由/方法不对）伪装成 JSON 语法错误。规则：**先 `text()` 再解析**，空 body 报 `EMPTY_RESPONSE` 并带上路由与状态码 |
| R24 后台调用未接错误 | **已处置** | 执行链路全是 `void xxx()`，一旦拒绝就变成 unhandled rejection；现在 `withConnection` 统一 try/catch + 3 处链式调用补 catch，错误进右下角提示 |

## 2.2 批次 7 复盘（2026-10-20）

| 风险 | 状态 | 说明 |
|---|---|---|
| R17 测试耗时 | **开放** | CodeMirror 每文件初始化是硬成本；已把 jsdom 补丁固化，剩余优化见 09 B11 |
| R18 体积 | **缓解中** | minify 已开；基线写入 06 §3，若继续涨就裁扩展或改按需加载 |
| R19 视图缺失 | **已处置** | 对象清单改以 TABLES 为准；同一根因也解释了「ods_db 整库不见」 |
| R20 事件型 bug 逃过测试 | **已处置** | 右键菜单失效是因为测试直接 `.click()`、跳过 pointerdown。规则：菜单/浮层类用例必须按真实事件序列（pointerdown→pointerup→click）写 |
| R21 错误路径只覆盖一半 | **已处置** | 数据库拒绝有「返回 ok:false」与「HTTP 5xx 抛异常」两形态，之前只翻了前者。规则：凡"对结果做后处理"的逻辑，返回值与异常两条路都要有用例 |

## 2.1 M0 复盘（2026-10-17）

| 风险 | 状态 | 说明 |
|---|---|---|
| R1 工程基线 | **已处置** | 换成 0.1.7-rc.2 + `sidebar.right.pane.tab`，实机注册成功；残余风险转为「harness 再升级导致扩展点改名」，由运行期守卫 + 每次升级重跑 M0 冒烟覆盖 |
| R2 peer 门禁 | **已缓解** | 零 peerDeps 策略落地，并由 `tools/precommit.sh` 第 6 项 + 单测双重把关 |
| R10 capacity | **已关闭** | 0.1.7 不需要容量协商 |
| R13 装桌面端 | **开放** | dev-sql 已验证；装 `web` profile 需用户批准（会改其 package.json + 一次 pnpm install） |
| 新增 R14 | **开放** | profile 装残（包已装但未进 `dsh.profile.bundles`）会让 CLI **静默挂死**，无端口无日志。缓解：`plugin add` 后用 `--dump-config` 复核 bundles；缺 app 的 profile 不要直接启动 |
| 新增 R15 | **开放** | pnpm 11 `ERR_PNPM_IGNORED_BUILDS` 使 `plugin add` 返回非零并阻断 reconcile。缓解：profile 的 `pnpm-workspace.yaml` 声明 `onlyBuiltDependencies` |
| 新增 R16 | **已处置（2026-10-18）** | **宿主内嵌契约的隐式约束**（单元测试不可能发现，只有真机启动才暴露）：① storage-json 单元名正则 `/^[a-z][a-z0-9_]*$/` 拒绝连字符 → 域名改 `dsh_data_ide`；② 右栏 body seat 的 `inject` 必须是 **props 记录**（宿主 `SlotInjectFace<I extends object>` 展开），写成函数时 seat 不渲染、面板一片空白；③ **浏览器半取不到 node 服务**：web 前端是独立进程，`ctx['sqlWorkbench']` 既不可达、某些 context 还会抛错 → 面板改走 `webServer` 同源路由；④ **`ctx.effect` 只能交回函数或 null**：把 `{ service, api, dispose }` 当返回值让 cordis 抛 `TypeError: Invalid effect`，node entry 整条不激活、面板一路空白，而宿主只打一行 `1 entry did not activate`（2026-10-18 真机定位，`c90c045`）。缓解：四条都进单测，并列进 testing.md 故障表 |

## 3. 风险燃尽机制

- 每个里程碑复盘会更新本表（状态：开放/缓解中/已关闭/已接受）；
- R1/R6 为持续监控项（每次 rebase / 每次发布前）；
- 已接受风险须记录接受人与理由。

## 2026-10-27 夜间批次新增风险

| # | 风险 | 说明 | 缓解 |
|---|---|---|---|
| R30 | **direct 模式改变手动执行的语义** | 手写 SELECT 现在是「原样 + 探针 LIMIT、不 COUNT」；AC-2/AC-3 由 paged 模式承担，验收时必须先说清楚跑的是哪个模式 | 03 §6.11.2 明确边界；结果区有模式文案与「统计总数」入口；本批次不改 MCP 侧默认（仍 paged） |
| R31 | lint 为启发式 | 语法错误来自 Lezer、未知表/列只做高置信度检查；CTE/派生表保守跳过（宁缺不误报），快照截断时可能漏报 | 可关闭；文案不称「语义检查」；后续若做 PSI 级需单独立项 |
| R32 | 格式化器是自研保守实现 | 不逐项拆分 SELECT 列表；幂等/字面量保留有测试，但复杂方言结构可能与团队风格不一致 | 只在显式触发时格式化；样式选项后续可加 |
| R33 | 补全函数名可能与 lang-sql 关键字行重复（如 SUM） | 两路 completion source 并存，仅函数-关键字重叠项会出现一行重复 | 已记录；后续去重需按 label 合并两路结果 |
| R34 | agent/MCP 路径未享受本批次能力 | 历史只记录面板执行；MCP 工具仍走 paged 默认；direct 模式未透传脚本执行 | 保留在 09 §6.2；agent 工具面重构见 `analysis/PLAN-borrow-from-ide-workbench.md` |
| R35 | 真机 smoke 未执行 | 桌面端 profile 由 Electron 独占，自动化只能到 jsdom；本轮所有 UI 结论均为单测级 | 新增 `docs/testing.md` §7 S73–S90，请用户按清单点一遍 |

| R36 | 结果→SQL 是骨架而非可执行保证 | 结果集无主键元数据：INSERT INTO esult` 表名占位、UPDATE 以首列作 WHERE 且带 LIMIT 1/注释；复制后需人工改表名并核对唯一性 | 文案与注释明确；不自动执行生成的语句 |
| R37 | 全局快捷键与浏览器/宿主冲突 | Ctrl+Shift+P/O 在极少数环境可能被占用；两个入口也都能从命令面板进入（对象搜索） | 只在非表单元素上响应；未注册为编辑器 keymap，避免抢 CM 的键 |

| R38 | 命名参数是字面量替换，不是服务端绑定 | :name 在客户端被替换为 SQL 字面量后发送；执行核心/MCP 契约不变，但没有预编译语句的注入防护收益（字符串已转义，仍是文本拼接） | 转义实现有单测；文档写明「不是绑定」；若日后要真绑定需改 ExecuteRequest 契约 |
| R39 | 表概览可能很重 | COUNT(*) + 每列 COUNT 在大表上可能数十秒；无超时/采样 | 用户显式右键触发；结果在新 console，可取消；后续可加「估算行数」开关 |
| R40 | AI 结对没有真正连到聊天 | 只复制 prompt，仍需用户切到对话粘贴 | 明确文案「已复制…粘贴到对话里」；真正直发需 conversation.input.dock 集成，单独立项 |

| R41 | 「直发聊天框」依赖宿主槽与 composer 在场 | 通过 `conversation.input.dock` 的隐藏组件拿 `inputActions`；宿主隐藏对话/无 composer/旧版本时只能降级复制剪贴板并提示 | bridge 全异常兜底；面板提示实际去向；`client.spec` 断言注册存在 |
| R42 | 快捷键设置存 localStorage，且速查表仍是默认键位 | 仅当前浏览器 profile 生效；`ShortcutsHelp` 静态展示默认组合，改键后以设置面板为准；Ctrl/Cmd 镜像不可分平台 | 设置面板标注「仅本机」；速查表后续可消费 settings |
| R43 | 结果列固定宽度会截断长文本 | `table-layout:fixed` + 默认 160/120px，长文本只缺省省略号；完整值走 title / 双击值查看器 | 列宽可拖拽；横向滚动保留 |
| R44 | 表概览统计对大表可能较重 | `COUNT(*)` + 每列 COUNT 在大表上耗时；弹窗内可关闭但查询仍在跑 | 用户显式右键触发；后续可加「估算行数」开关 |
| R45 | diff 提案来源目前是剪贴板 | agent 自动推送提案未接（需 agent→面板通道约定）；接受后是整段替换，不是逐 hunk 接受 | 文档写明；后续可接 agent console 投递 |

| R46 | 值列表筛选的计数只来自当前已加载页 | 大数据集下计数是「本页计数」而非全表 distinct；应用后走服务端 IN，结果准确但计数不完整 | 弹层文案明确「本页计数 · 应用后服务端筛选」；需要精确 distinct 可后续加「全表 distinct」动作（成本高） |
| R47 | 值列表过滤用 IN，值多时 SQL 变长 | 单列勾选上限 200，字符串单值截 200 字符，空列表→`1=0`；极大 IN 列表可能影响性能 | UI 上限 + 提示；后续可改分批/临时表 |
| R48 | 筛选弹层未做外部点击关闭 | 目前点漏斗/应用/取消/移除关闭；点网格其它区域不会自动关 | 与列菜单/查找条风格一致；后续统一加 outside-click 关闭 |
| R49 | 补全快捷键与库 keymap 优先级 | 自定义 keymap 为 Prec.high，autocomplete 自身 Prec.highest 仍最优先；本版库默认无 Tab 接受，可在设置里把接受键录成 Tab | 设置面板可改；文档说明「有弹层时 Enter 接受、无弹层换行」 |
| R50 | 表格宽度改为列宽总和后的空白 | 列少时右侧留背景空白（DataGrip 同款）；不是把列拉伸填满 | 拖列宽/列多横向滚动；值查看器可看全文 |

| R51 | 客户端/宿主半版本不一致会产生“悬空 WHERE” | 新版 client 发送 `in` 筛选、旧 node half 的 `conditionSql` 不识别该 op 时，旧实现会拼出 `) AS t WHERE  LIMIT 5001 OFFSET 0`（驱动语法错误）。已加防御：未知 op 条件返回空并被 `filterClause` 丢弃，整句退化为无 WHERE；但**旧宿主仍会先报错**，需要重启桌面端让 node half 加载新 bundle | 升级插件后必须重启应用（不只是刷新页面）；新增单测锁定“未知 op 不产生 WHERE”；排查见 docs/testing 故障对照 |
