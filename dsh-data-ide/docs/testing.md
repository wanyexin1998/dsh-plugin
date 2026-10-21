# testing.md — 验证手册

本项目的自动化测试**不需要任何生产凭据**：协议与逻辑层用测试双层（fake 宿主存储 / fake 凭据服务 / mock mysql2 驱动），MCP 侧有真实子进程的端到端 spawn。真实 Doris 连通性属于**人工 smoke**，由你按本文执行。

## 1. 自动化：跑全套

```bash
cd E:\dsh-plugin\dsh-data-ide

pnpm build        # 三入口 bundle + tsc 声明
pnpm test         # vitest
pnpm coverage     # per-file 100% 门禁
pnpm precommit    # 六项自检：构建 / 产物契约 / 测试与覆盖率 / 样式 token / 跨包 import / peerDeps
```

> 本机注意：WorkBuddy 注入的 `NODE_OPTIONS` 会让 pnpm 在 `node_modules` 内 rename 报 `ERR_PNPM_EPERM`、让 vitest 写临时文件报 EPERM；覆盖率还额外踩一个坑——vitest 清理 `coverage/` 时走 `fs.rm`，被 WorkBuddy 的 safe-delete 垫片接管成 `genie-trash` 超时（+ `wmic` 被安全策略拦截），整轮直接失败。
> 因此 `pnpm coverage` 已改为经 `tools/run-coverage.mjs` 起子进程（内部清空 `NODE_OPTIONS`）。手动跑请用 `pnpm coverage` 或 `node tools/run-coverage.mjs`，不要直接 `vitest run --coverage`。

## 2. 装进独立 profile（不动日常环境）

> **2026-10-18：基线切到 0.2.1-rc.2。** 桌面端跑的是 `E:/deepseek-harness`（代码在 `resources/app.asar`），CLI 入口是随客户端发布的 `dsh.cmd`，开发 profile 用 **`dev-sql-021`**。下面的 0.1.7 命令仅作历史参考。

```powershell
cd E:\deepseek-harness
.\resources\runtime\cli\bin\dsh.cmd plugin --profile dev-sql-021 add "link:E:\dsh-plugin\dsh-data-ide\packages\client\ui-sql-workbench"
.\resources\runtime\cli\bin\dsh.cmd --profile dev-sql-021 --port 62380
```

```bash
# 0.1.7（历史，不再作为验收对象）
HARNESS=E:\wyx_code\dsh-official-v0.1.7-rc.2
PKG=E:\dsh-plugin\dsh-data-ide\packages\client\ui-sql-workbench

cd "$HARNESS"
env -u NODE_OPTIONS node apps/cli/lib/bin.js plugin --profile dev-sql add "link:$PKG"
env -u NODE_OPTIONS node apps/cli/lib/bin.js --profile dev-sql --port 62370
```

- profile 由**第一次 `plugin add` 自动创建**；`web` / `desktop` 两个既有 profile 不要动。
- 装完用 `node apps/cli/lib/bin.js --profile dev-sql --dump-config | grep -A6 mcp-sql` 复核两行 insert 都在。
- 若启动后**无端口、无日志**地挂着：多半是 `plugin add` 失败导致包没进 `dsh.profile.bundles`（缺 app）。核对 `package.json` 的 `dsh.profile.bundles` 是否含 `@deepseek-ai/dsh-web-app` 与 `dsh-data-ide`。

## 3. 人工 smoke：连接管理（AC-1 前半）

前置：dev-sql 已启动、浏览器已打开、右侧栏已展开。

| # | 步骤 | 期望 |
|---|---|---|
| S1 | 右栏点「SQL 工作台」 | 显示连接条（选择器 / 配置 / 测试连接 / 新建）+ 空状态提示 |
| S2 | 点「新建」 | 弹窗预填 DBMS=Doris、端口 9030；字段含名称/主机/端口/数据库/用户名/密码/仅本次会话/writeEnabled |
| S3 | 只填名称就点「保存」 | 名称下方红字「名称不能为空」，不落库 |
| S4 | 填完点「保存」 | 弹窗关闭，选择器出现该连接 |
| S5 | 点「测试连接」 | 黄点「正在连接…」→ ≤3s 内出结果 |
| S6 | **正确凭据** | 绿点 + `Doris 5.7.99 (Doris version doris-2.1.10-rc01) · mysql2 <版本>` |
| S7 | **错误密码** | 红点 + `Access denied …` + 提示「检查用户名与密码…」 |
| S8 | **不可达主机**（改成不存在的 host） | 红点 + 网络类提示（检查内网/VPN） |
| S9 | 编辑该连接勾选「仅本次会话」并保存 | 凭据不落盘：`~/.dsh/.credentials.yaml` 里不应出现 `dsh-data-ide/ds-<8hex>` |
| S10 | 删除该连接 | 连接消失；若它是当前选中，则自动切到剩余连接或空 |

## 3.1 人工 smoke：页面上跑 SQL（AC-2 / AC-3 / AC-6 前半）

前置：已有一个测试连通性为绿点的连接。**这一步全程由你本人在页面上操作，不需要把口令交给 AI。**

| # | 步骤 | 期望 |
|---|---|---|
| S11 | 在编辑器输入 `SELECT 1`，点「执行」（或 Ctrl/Cmd+Enter） | 出现 1 行 1 列结果；分页条显示 `第 1-1 行 / 共 1 行`；耗时 <1s |
| S12 | 输入 `SELECT * FROM <一张 10 万行以上的表>`，点执行 | 首屏 ≤2s（AC-2）；分页条显示 `第 1-500 行 / 共 N 行`；末页可点 |
| S13 | 连点「下一页」3 次 | 每页 offset 递增 500，行不重不漏（AC-3）；范围文字随页码变化 |
| S14 | 把页大小改成 1000，再点「下一页」 | 下一跳 offset 按 1000 计；`页大小` 立即生效 |
| S15 | 点任一列头 1 次 / 2 次 / 3 次 | 依次 ASC（▲）→ DESC（▼）→ 无序，每次都回到第 1 页；中文列名不报错 |
| S16 | 执行 `DELETE FROM <表> WHERE 1=0` | 红条 `WRITE_NOT_ALLOWED`；连接未开 writeEnabled 时不会真的写库（AC-6） |
| S17 | 执行 `SELECT SLEEP(20)` 后立刻点「取消」 | 显示「查询已取消」；数据库侧语句结束（可在会话列表核对） |
| S18 | 选一张含中文列名的表执行并排序 | 排序生效，无「非法排序列名」 |
| S19 | 大文本列（>1MB 单元格） | 分页条右侧出现「n 个值过大已截断」；单元格显示前 32 字符 + 「值过大」 |
| S20 | 编辑器里输入 `SE` | 弹出补全下拉，首项 `SELECT`；Enter/Tab 接受，Esc 关闭 |
| S21 | 输入 `SELECT * FROM `（FROM 后有空格） | 下拉列出该连接下的表名；前缀过滤生效 |
| S22 | 输入 `SELECT a. FROM dwd_order a`，光标放到 `a.` 后 | 列出 `dwd_order` 的列（detail 显示「表 · 类型」） |
| S23 | 输入过程中按 Ctrl+Space | 无条件弹出当前上下文的补全（即使刚删过字） |
| S24 | 断开表结构（把连接密码改成错的后重进面板） | 补全降级为仅关键字，不报错、不阻塞执行 |
| S25 | 在 console_2 执行一条慢查询，结果返回**前**点回 console_1 | 结果落在 console_2；console_1 仍是空的 SQL 和空结果区（2026-10-19 报告过反例：console_2 的 SQL 和结果整份出现在 console_1） |
| S26 | console_2 通过连接栏改绑 zanmal_read，切回 console_1 执行 | 请求的 `connId` 是 doris（标签自己的绑定），不是全局最后选中的那个 |
| S27 | 关闭当前 console，让同屏邻居是另一个数据源的 console | 连接栏自动切到邻居的连接；随后执行用的是邻居的库 |

> S25 可脚本化：`node tools/check-console-pinning.mjs --url <带 token 的地址>`（页面内把 `/dsh-data-ide/execute` 延迟 2.5s 制造竞态，退出码 0 表示结果钉在发起标签）。
| S28 | 点「对象」展开树 | 层级是 数据源 → 库 → 表/视图 两个分组 → 表 → 列；摘要显示 `N 个库 · N 个对象 · 含 N 视图`；默认展开第一个库的「表」 |
| S29 | 右键一张表 | 菜单 5 项：打开数据(F4) / 插入名称(Enter) / 复制引用 / 查看 DDL(Ctrl+B) / 刷新表结构；标题是该表的反引号引用名 |
| S30 | 右键「打开数据」 | 编辑器被填成 `SELECT * FROM \`库\`.\`表\` LIMIT 100` 并执行，结果区出首页数据 |
| S31 | 右键「查看 DDL」 | 右下浮层显示 `SHOW CREATE TABLE` 的原文，可复制；库不返回语句时提示「数据库没有返回 DDL」 |
| S32 | 在树里键入筛选词（表名或列名） | 命中项自动展开；只命中列时该表只剩下匹配的列 |
| S33 | 关闭当前 console（邻居属于另一个库） | 连接栏与对象树一起切到邻居的库 |

> S28–S31 可脚本化：`node tools/check-object-tree.mjs --url <带 token 的地址> --shot out.png`（走完 树→菜单→DDL→打开数据，退出码 0 表示两项动作都成功）。
| S34 | 执行一条返回 ≥300 行的查询 | 状态栏显示 `整页 N 行 × M 列`；DOM 里的数据行远少于 N（窗口化），滚动条长度仍对应全部行 |
| S35 | 拖动滚轮到底 | 行号跟着换（如首行变成 N-20 附近），DOM 行数保持不变 |
| S36 | 选中一列数值单元格（拖选若干行） | 状态栏变 `选区 R 行 × C 列`，读数为 `SUM(列) = 数字`；切换 AVG/MIN/MAX/COUNT/DISTINCT 数值随之变化 |
| S37 | 按 `Ctrl+Shift+C` | 剪贴板得到**未分组**的数字（如 `3500`，不是 `3,500`）；`Ctrl+C` 仍是复制单元格 TSV |
| S38 | 双击单元格 / 选中后按 `Shift+Enter` | 右下角弹出值查看器，显示完整值、字符数、列名与行号；JSON 会美化；`Esc` 或「关闭」收起 |
| S39 | 把编辑器拖得很高、面板较矮 | 结果区仍保有可读高度（不会被工具条+状态栏挤没），必要时编辑器自动让位 |

> S34–S38 可脚本化：`node tools/check-grid-batch5.mjs --url <带 token 的地址> --shot out.png`（500 行页实测 DOM 只渲染 20 行、滚动后窗口移动、选区聚合出数、值查看器打开，退出码 0 表示全过）。
| S40 | 打开面板 | 三块：对象树在左（默认展开）、编辑区在上、结果区在下；面板是圆角卡片，之间只有间距没有分隔线 |
| S41 | 拖动对象树与编辑区之间的 8px 缝隙 | 出现 2px 抓手，左栏变宽/变窄；编辑区不低于 320px |
| S42 | 拖动编辑区与结果区之间的缝隙 | 编辑区变高/变矮；结果区保底 132px；双击缝隙回到默认 200px |
| S43 | 聚焦缝隙后按 ←/→（或 ↑/↓） | 每次 16px 微调，`aria-valuenow` 同步变化 |
| S44 | 点 console 标签条最左的「«」 | 左栏连同 sash 一起消失，编辑区占满整幅宽度（无 rail、无残留列）；同一按钮变「»」并 `aria-expanded=false`，点回恢复；展开宽度沿用收起前的值并按当前工作区重新 clamp |
| S45 | 把 dsh 右栏拉窄到 ~500px | 左栏自动收窄（≈169px），编辑区不被挤没；结果区状态栏隐藏编码与函数下拉，读数仍可读 |
| S46 | 看 console 标签条的位置 | 它在**编辑区面板内部**顶部（与 执行/取消 同一块面板），不在对象树与编辑区之间横跨整个工作台；标签多时横向滚动 |

> S40–S43 可脚本化：`node tools/check-panels.mjs --url <带 token 的地址> --shot out.png`（量三面板几何、竖拖 +80 / 横拖 +60 后断言尺寸真的变了，退出码 0 表示布局与拖拽都成立）。
| S47 | 在编辑区输入 `sel` | 弹出补全，首项 `SELECT`；Tab/Enter 接受，Esc 关闭 |
| S48 | 输入 `SELECT a. FROM dwd_order a`，光标放到 `a.` 后 | 列出该表列名（schema 来自当前连接） |
| S49 | 按 `Ctrl/Cmd+Enter` | 执行当前语句（有选中则只跑选段） |
| S50 | 按 `Ctrl+F` | 顶部出现「查找」面板（中文）；面板宽度 <460px 时只显示查找、不显示替换 |
| S51 | 按 `Ctrl+/`、`Tab`、`Ctrl+Z` | 注释切换 / 缩进 / 撤销都由 CodeMirror 处理，行为与普通编辑器一致 |
| S52 | 长脚本里点行号左侧的折叠箭头 | 语句块可折叠/展开 |

> S47–S51 可脚本化：`node tools/check-editor.mjs --url <带 token 的地址> --shot out.png`（自动开会话→右栏→SQL 面板，输入文字、Ctrl+Enter 出结果、补全弹窗、Ctrl+F 面板，并断言查找面板是中文，退出码 0 表示全过）。
| S53 | 看对象树摘要与 dwd 展开 | 摘要包含全部库与对象（现场 4 库/21 对象/7 视图）；dwd 下「表 5」「视图 5」都在；只含视图的库也出现 |
| S54 | 展开一个视图 | 显示「无列信息（视图）」（Doris 的 COLUMNS 不返回视图列），而不是空白 |
| S55 | 右键一张表 → 用鼠标点「打开数据」 | 菜单项真的执行：编辑器出现 `SELECT * FROM …` 且结果区跑出数据（旧实现里菜单在 pointerdown 就被卸载，点击无效） |
| S56 | 看对象行前缀与箭头 | 没有 T/V 字母徽标；展开箭头明显可点（13px），hover 提亮 |
| S57 | 对无权限的视图右键「查看 DDL」 | 右下角出现中文提示（「没有查看 dwd.xxx 的权限：账号 ai_reader 缺少 SHOW VIEW…」），无弹窗，可关闭 |
| S58 | 对有权限的表右键「查看 DDL」 | 新开 `ddl_<表名>` 标签，编辑区显示 `CREATE TABLE …`；标签不带 `*`；对象树与结果区不受影响 |
| S59 | 看编辑区顶部 | 有正式工具栏：执行 / 取消 / 复制 / 清空 / 「N 行」/ ⓘ 快捷键说明（悬浮） |
| S60 | 在拒绝剪贴板权限的环境点「复制」 | 右下角提示「复制失败：当前环境拒绝了剪贴板权限…」；**不出现**「未处理的 Promise 拒绝」诊断条 |
| S61 | 打开 long 查询（如 information_schema.columns），点列头漏斗设 `>` 5 | 编辑器/结果区刷新，请求体带 `filters`；首行值 > 5；状态栏 SUM 随之变化；工具条显示「N 行（已筛选）」与「清除筛选（1）」 |
| S62 | 再点该列漏斗 → 移除 | 条件消失并重查，请求不再带 `filters` |
| S63 | 构造一个筛出 0 行的条件 | 仍显示工具条与「清除筛选」，不会变成死路 |
| S64 | 多语句脚本执行后的结果标签 | **每个语句标签都有漏斗**（R6 起支持按语句筛选）：筛选只作用于该语句并重新取第 1 页，切换标签互不影响 |
| S65 | 编辑器输入 `S` | 补全首条是 `SELECT`（不再是 `SAVEPOINT/SCHEMA` 开头）；输入 `sel` 时模板 `sel` 排第一，展开为 `SELECT * FROM ` |
| S66 | 任意界面按 `Ctrl/⌘+Shift+L` | 打开或聚焦「SQL 工作台」；右栏收起时也会展开；按一次只开一个（`multiple:false`） |
| S67 | 点 console 标签条最左的 `«` | 对象树连同 sash 一起消失，编辑区占满整幅宽度（无 22px 空条）；同一按钮变 `»`，点回恢复 |
| S68 | 拖动左栏宽度/编辑区高度后关闭标签再打开（或重启应用） | 尺寸与对象树收起状态**保持**（宿主 `layout` 文档）；异常值回落默认 |
| S69 | 让 agent 带 `label` 执行 SQL | 出现 `ai_<label>` 控制台、带未读点、**不抢焦点**；同 label + 同 SQL 就地更新，SQL 不同则开 `ai_<label>#2` |
| S70 | agent 控制台满 4 个后再投递 | 提示里带「AI 控制台已达 4 个」；已读的最近一个进入「AI 历史」，点条目可重开；未读的不会被收走 |
| S71 | agent 传 `consoleId` 指向**用户** console | 返回 `CONSOLE_NOT_AGENT`，不执行、不投递 |
| S72 | 让 agent 调 `get_schema` / `list_tables` | 能拿到表、视图与列（`get_schema` 支持 `库.表名` 收窄），不再靠 `SELECT * LIMIT 1` 猜列 |
| S65 | 装进 `web` profile 后启动桌面端 | 右栏出现「SQL 工作台」；面板三项（连接/对象树/编辑）正常；`Ctrl+Enter` 能跑；agent 侧 `mcp__sql__ping` 返回 pong |

> 若 S11 出「宿主服务不可用（未注入 sqlWorkbench）」：说明 node 半没有激活。先 `pnpm build` 确认 `lib/index.js` 不是 124 字节的占位产物，再重装 dev-sql。

## 4. 人工 smoke：agent 侧（AC-5 / AC-6 前半）

dev-sql profile 需要模型配置才能跑 agent 对话（把 `llm-pi-ai` + `agent-default-model` 两行放进该 profile 的 `cordis.patch.yml`，只有环境变量名、没有密钥明文）。

在 dev-sql 对话框依次发：

| # | 提示词 | 期望 |
|---|---|---|
| A1 | `调用 mcp__sql__ping，把返回的 JSON 原样贴给我` | `{"ok":true,"pong":"pong","server":"dsh-data-ide","at":"…"}` |
| A2 | `调用 mcp__sql__list_datasources，列出所有数据源` | 只返回 id/name/dbms/host/port/database/writeEnabled，**不得出现 password 字段** |
| A3 | `调用 mcp__sql__test_connection，connId 用 A2 里第一个` | 三态结果与人侧 UI 一致 |
| A4 | `调用 mcp__sql__test_connection，connId 用一个不存在的 id` | `CONN_NOT_FOUND` + 提示先调 list |

## 5. 运行时产物在哪

| 内容 | 路径 |
|---|---|
| 连接定义（无密码） | profile 的 storage 域 `dsh-data-ide` → JSON 后端单元 |
| 密码（master_key） | `~/.dsh/.credentials.yaml`，key `dsh-data-ide/ds-<8hex>` |
| 密码（session） | 仅内存，进程退出即失 |
| 给 MCP server 的运行时规格 | `~/.dsh/data-ide-runtime/conn-specs.json`（0600，插件卸载即删） |

## 6. 出问题先看这里

| 症状 | 多半原因 |
|---|---|
| 页面报 `dsh-data-ide: web boot: 1 entry did not activate / import failed` | `lib/client.js` 不是宿主工厂形态；跑 `pnpm build` 后**硬刷新**（precommit 第 2 项会拦） |
| 右栏看不到「SQL 工作台」 | client 半被守卫拦下（宿主缺 `sidebarRight`/`sidebarRightTabs`），看浏览器 Console |
| 面板显示「宿主服务不可用」 | node 半未激活：profile 缺 `storageDomain`/`credentials`，或域声明被拒 | 启动日志若出现 `StorageError: invalid unit name`，说明域名含非法字符（storage-json 只允许 `^[a-z][a-z0-9_]*$`） |
| tab 打开后一片空白 | body seat 的 `inject` 不是 props 记录（宿主按对象展开），或其他渲染异常 | 先看 Console 的 `dsh-data-ide:` 报错；面板已加 `PanelBoundary`，正常应显示「SQL 工作台渲染失败」+ 原因 |
| 启动页显示 `Failed to load plugins / web boot: 1 entry did not activate` | client 或 node 半的 entry 抛异常（整条 entry 失败） | 看**启动日志**里 `dsh-data-ide (dsh-data-ide): ...` 那行；`TypeError: Invalid effect` = `ctx.effect` 返回了非函数（必须是 disposer）。**不要在 client 里直接访问 ctx 上的 node 服务**（会抛），面板数据一律走 `/dsh-data-ide/*` 路由 |
| 面板能开但列表/执行全报错 | node 半没挂上路由 | 启动日志应有 `dsh-data-ide: 宿主未提供 webServer…`；确认 composition 含 `webServer` 服务 |
| MCP 工具调不通 | 启动日志有 `skipping profile bundle … incompatible`（peerDeps 门禁，本包应为零 peerDeps）；或 spec 文件缺失（宿主还没发布连接） |
| 提示 `EMPTY_RESPONSE: /dsh-data-ide/xxx 返回了空响应（HTTP n）` | 该路由没挂上或方法不对：确认 `lib/index.js` 是新构建、**完全退出 dsh 后重启**；`405` 表示同路径被注册了别的方法（见 08 R22） |
| 提示 `BAD_RESPONSE: … 不是 JSON` | 请求打到了别的服务（端口被另一个实例占用）或反代插入了 HTML 错误页 |
| pnpm 报 `ERR_PNPM_EPERM` / vitest 报 EPERM | `NODE_OPTIONS` 未清，见 §1 |
