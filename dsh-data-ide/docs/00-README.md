# dsh-data-ide — 文档枢纽

> **项目名**：dsh-data-ide
> **一句话**：DeepSeek Harness（dsh）右栏原生 Sidebar 的新 tab 类型——轻量 SQL 工作台（连接 / 编辑 / 结果网格 / git），附随插件自动安装的 MCP 服务，供人与 agent 共同使用。
> **状态**：M0 完成（脚手架 + 右栏注册 + MCP 自动激活已实机验证），M1 连接管理待启动。本文档是所有文档的索引与举证中心。

---

## 1. 一页纸

| 项 | 内容 |
|---|---|
| 产品形态 | dsh 热插拔插件：右栏**新页面类型 tab**（`sidebarRightTabs.register` + `sidebar.right.pane.tab`，host 0.1.7-rc.2）+ 随插件自动安装的 MCP server |
| 目标用户 | 上海细胞数据 PM/分析师（人）+ dsh agent（机器） |
| MVP 范围 | ① 数据连接管理 ② SQL 编辑 ③ 查询结果呈现 ④ git 拉取/提交/推送 |
| 目标数据库 | Doris（doris.shcell.com:9030，MySQL 协议）、MySQL、Oracle DW（172.26.200.92:1521，M4 里程碑） |
| 设计基调 | DataGrip 网格 UX 骨架 × dsh 原生设计语言（`--dsw-alias-*` token + CSS Modules + ui-primitives） |
| 核心行为锚点 | 分页 `LIMIT n+1` + 独立 COUNT + OFFSET；页大小默认 500；连接测试三态 YES/NO/UNSURE；凭据永不入配置文件 |

## 2. 推荐阅读顺序

| 角色 | 顺序 |
|---|---|
| PM / 评审 | 01-PRD → 03-UIUX-SPEC → 07-MILESTONES |
| 工程师 | 02-ARCHITECTURE → 06-PLUGIN-ENGINEERING → 05-MCP-SPEC → 04-DATA-MODEL → 03-UIUX-SPEC → 07-MILESTONES → 08-RISKS |
| 任何人第一份 | 本文（00） |

## 3. 文档清单

| # | 文件 | 状态 | 门禁 |
|---|---|---|---|
| 00 | `00-README.md`（本文） | ✅ | — |
| 01 | `01-PRD.md` | 待写 | G0 范围冻结 |
| 02 | `02-ARCHITECTURE.md` | 待写 | G1 架构冻结 |
| 03 | `03-UIUX-SPEC.md` | 待写 | G3 |
| 04 | `04-DATA-MODEL.md` | 待写 | G2 契约冻结 |
| 05 | `05-MCP-SPEC.md` | 待写 | G2 |
| 06 | `06-PLUGIN-ENGINEERING.md` | 待写 | G1 |
| 07 | `07-MILESTONES.md` | 待写 | G3 实现就绪 |
| 08 | `08-RISKS.md` | 待写 | 随里程碑复盘更新 |
| 09 | `testing.md` | ✅ 2026-10-17 | 自动化命令 + 人工 smoke 清单（M1 起） |

## 4. 术语表

| 术语 | 含义 |
|---|---|
| dsh / harness | DeepSeek Harness，基于 Cordis 的 "everything is a plugin" agent 框架 |
| Cordis | dsh 使用的插件运行时（vendored 于 `vendor/`）；一切注册即 fiber effect |
| slot / seat | dsh 的声明式 UI 扩展点；`session.pane.right` 是本项目的注册目标 |
| pane / split | 会话分屏；`visible.length > 1` 时才渲染右/底 pane |
| MCP server | 本项目的 SQL/git 工具服务进程（stdio），由 dsh 作为 MCP client 挂载 |
| Java 桥 | 为 Oracle JDBC 按需拉起的 `java -jar` 子进程（stdio JSON-lines） |
| 三态测试 | 连接测试结果 YES / NO / UNSURE（镜像 DataGrip ThreeState） |
| n+1 分页 | 取 `pageSize+1` 行，多出 1 行即"还有下一页"，省一次探测查询 |
| 凭据 seam | dsh 的 `ctx.credentials` 记录存储（key/payload/modifyRecord 排他写） |

## 5. 证据引用地图

所有结论按 OBSERVED / INFERRED / UNKNOWN 分级，来源如下：

### 5.1 DataGrip 逆向（本仓 `../rea-datagrip/`，相对本文档目录）

| 结论 | 来源 |
|---|---|
| 连接配置 XStream 格式（driver-ref/jdbc-url/secret-storage 元素）、shared/local 双文件、密码不入 XML | `SPEC.md` §2；RUNTIME-FINDINGS §2.2/§2.3 |
| 凭据后端 = KeePass KDBX（`c.kdbx` 文件头 03d9a29a67fb4bb5）、`secret-storage=master_key` | RUNTIME-FINDINGS §2.3 |
| 驱动声明式 XML（driver-class/url-template/artifact/option/property/constraints/based-on）、Maven 本地仓库布局、URLClassLoader 隔离（parent=PlatformClassLoader） | `SPEC.md` §3；RUNTIME-FINDINGS §2.4/§3b |
| 连接测试三态 + ErrorInfo、`DatabaseConnectionEstablisher` 日志链 | `SPEC.md` §4；RUNTIME-FINDINGS §3b |
| 分页 `LIMIT 501` + `SELECT COUNT(*)` + `LIMIT 501 OFFSET 51786`；页大小默认 500 | RUNTIME-FINDINGS §4 |
| Doris 走 MySQL 协议（9030）、运行时 `@@version_comment: Doris version doris-2.1.10-rc01` | RUNTIME-FINDINGS §2.2/§3b |
| 后端进程 = 独立 java（RemoteJdbcServer）+ RMI(SSL) 回环；JVM 冷启动 ~7s | RUNTIME-FINDINGS §3/§3b |
| 三层索引（Raw/Model/View）、排序/过滤模型、单元格图像缓存、格式缓存 | `SPEC-sql-execution-grid.md` §5/§6 |
| 开源复刻可行性与工作量（P0 2-3 人月 / P1 6-12 人月 / P2 2 人年+）、合规边界 | `COMPREHENSIVE-ASSESSMENT.md` §6/§7/§9 |

### 5.2 dsh 仓库核验（`E:/wyx_code/deepseek-harness`，分支 codex/presentation-v2）

| 结论 | 来源（绝对路径 / 行号） |
|---|---|
| `session.pane.right` slot 合同（kind=list/scope=session/owner `{focused}`） | 实证①工作树 HEAD `c5a387cd2f`：`packages/client/ui-layout/src/client/index.ts` L90（children 声明 L174），渲染点 `AppFrame.tsx` L296；实证②分支 tip `82de604afc`：同文件 L86（children L162-169），`AppFrame.tsx` L270-275。owner props 仅 `{ focused }`（L131-135） |
| pane 渲染与 `:empty{display:none}` | `AppFrame.tsx` L224-226：`presentation.visible.length <= 1 ? renderSlot('conversation') : <分屏分支>`；pane.right 只在分屏分支内渲染；`:empty{display:none}` 在 `AppFrame.module.css` L155-158（不在 tsx 内） |
| `requestCapacity(2)` 语义（effect 生命周期、最大请求胜出） | **路径随提交变化**：工作树 `c5a387cd2f` → `packages/api/session-controller/src/client/contract/sessions.ts` L50；分支 tip `82de604afc` → `packages/client/runtime/src/client/contract/sessions.ts` L50-55（实现 `service.ts` L884-900：有效容量 = 任一方请求 2 则 2，disposer 幂等） |
| tab 注册先例（slots.inject/register + label thunk + locale NS） | `packages/client/ui-trajectory/src/client/index.ts` L43-64；`inject = ['slots','conversationEvents','conversationViews','sessions','locale']`（L23）；**label 必须 thunk `() => t(...)`** |
| 最小包契约（空 apply / peerDeps / dsh.client.inject） | `packages/client/ui-user-questions/{package.json,src/index.ts}`；node 半 `apply` 为空（src/index.ts L14）；peerDeps 在 monorepo 内为 `workspace:^` |
| 面板外壳先例（header 14/12/12、28px 关闭钮、body 12/16） | `packages/client/ui-conversation/src/client/skeleton/DetailsPanel.tsx`（分支） |
| 设计 token 权威规则（只用 `--dsw-alias-*`、禁硬编码色、禁主题选择器） | `docs/web-styling.md` L15-21（Component rules 全文）；滚动条 rebind 契约在 `packages/client/ui-theme/README.md` L11 + `ui-theme/src/styles/scrollbar.css` L11-15（浮层 rebind `--dsh-scrollbar-thumb` 到 l2 对，禁写组件级 `::-webkit-scrollbar`） |
| 图标存在性 | `packages/client/ui-primitives/src/icons/index.tsx`：**IconBranchOutline16 L149** / IconPlayOutline16 L553 / **IconDataOutline16 L731**（原文把 Data 与 Branch 的行号写反，已订正）。另：无 Save/Database/Table 命名图标（保存用 IconDownloadOutline16 L543 替代） |
| MCP client 契约 | `packages/mcp/mcp-client/src/index.ts`：serverName 正则 `/^[A-Za-z0-9_-]{1,32}$/`（L36-37）；`DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000`（L33-34）；一实例一 server（L148-161 抛重名）；工具名 `mcp__<server>__<tool>` 组装在 `src/tools.ts` L111-117 |
| MCP 实例 cordis.yml 格式 | `examples/mcp-memory/mcp-reference-memory.cordis.yml`（13 行，`- insert:` + `name: '@deepseek-ai/dsh-mcp-client'` + `config`）；**注意**：`packages/bundle/web-app/cordis.patch.yml` 内没有任何 mcp 实例声明 |
| `dsh plugin add` → reconcilePlugins 自动激活链路 | `apps/cli/src/plugin.ts` L59 `reconcilePlugins`、L144 调用点 |
| 凭据 seam（record/modifyRecord 排他写、key 段模式） | `packages/credentials/credentials/src/index.ts`：key 段正则 `/^[a-z][a-z0-9-]*$/`（L18-19，确认为小写开头）；`modifyRecord(key, mutate)` L254-257（mutate 返回 undefined = 不改） |
| per-file 100% coverage、Agent Note、Cordis peerDeps 规则 | `packages/client/AGENTS.md`（Cordis peerDeps **L61**、per-file 100% coverage **L117**、Agent Note **L150**）；新建包清单 L132-141（含三处注册面 L137） |
| 注册三面锚点（仅 monorepo 内开发需要） | `tsconfig.client.json` L88-89；`packages/bundle/web-app/cordis.patch.yml` L294-295（ui-trajectory 行）；`packages/bundle/web-app/package.json` |

## 6. 基线声明

| 项 | 值 |
|---|---|
| dsh 本地 checkout | `E:/wyx_code/deepseek-harness`（`master`）——**只读参照**，不改不切 |
| **目标宿主** | **dsh 0.1.7-rc.2**（`E:/wyx_code/dsh-official-v0.1.7-rc.2`），用户本地 dsh desktop 实际加载的版本 |
| 桌面端启动 | `dsh-desktop.exe` → `node <harness>/apps/cli/lib/bin.js --profile web --no-open --port N`（`src-tauri/src/lib.rs` L138-160）→ **桌面端跑 `web` profile** |
| 桌面端 client 包 | `web` profile 把 12 个官方包 `link:` 覆盖为 `dsh-split/rebuild-v5/.../0.5.0-rebuild.7`（含 ui-layout、ui-sidebar-right，版本 0.2.0-rc.2） |
| 已废弃基线 | `codex/presentation-v2`（0.1.1/0.1.2-rc.1，游离快照 `c5a387cd2f` 不属任何 ref）上的 `session.pane.right` + `requestCapacity`——0.1.7 已无此 slot |
| peer 门禁 | 0.1.7 对声明 `@deepseek-ai/dsh*` peerDeps 的插件做 semver 校验，不兼容即**整包跳过**；未声明则免检 |
| DataGrip 参照版本 | 2026.2.3 / DB-262.9437.163 |
| Node | dsh 要求 ^22.19 ｜ >=24；本项目 MCP server 与前端构建随 dsh |

## 7. 命名规范（三层分离）

| 层 | 取值 | 约束 |
|---|---|---|
| 品牌名（产品/文档/UI 文案） | `dsh-data-ide` | 人类可读；UI 内显示名建议 "SQL 工作台 / Data IDE" |
| 插件包名 | `dsh-data-ide`（**裸包名**；`@deepseek-ai/*` 是官方命名空间，外部插件不占用。与同机外部插件 `dsh-chat` 惯例一致） |
| MCP serverName | `sql` | 须匹配 `[A-Za-z0-9_-]{1,32}` 且全局唯一；工具名前缀 `mcp__sql__*` |
| tab id / kind | `dsh-data-ide.sql-workbench` | 同时作为 `sidebar.right.pane.tab` / `.title` 两个 keyed seat 的 `key` |

## 8. 合规红线（继承 COMPREHENSIVE-ASSESSMENT §9）

- 不复用 DataGrip 任何字节码/资源；不抢注 JetBrains/DataGrip 商标；产品命名与视觉须自有品牌；
- mysql2 为 MIT，无 Connector/J 的 GPL 传染问题（这是选 Node+mysql2 路线的附带收益）；
- Oracle JDBC 驱动（ojdbc11）走 OTN 许可，随 Java 桥分发时需附许可声明；
- 逆向结论仅用于架构参考。

## 9. 变更记录

| 日期 | 变更 | 作者 |
|---|---|---|
| 2026-10-17 | 初始化文档枢纽 | PM + AI |
| 2026-10-17 | 证据文档自包含：`../rea-datagrip/` 4 份（SPEC / SPEC-sql-execution-grid / RUNTIME-FINDINGS / COMPREHENSIVE-ASSESSMENT）归档至本仓 `docs/reference/` | AI |
| 2026-10-17 | **开发启动**：建独立 git 仓库、写 `AGENTS.md`；开发位置由「monorepo 内」改为外部独立仓库 `E:/dsh-plugin/dsh-data-ide`（理由见 06 §1 修订），验证走本地 bundle + `dsh plugin add` 到独立 dev profile | AI |
| 2026-10-19 | **SQL 补全（N4 的可落地一半）**：编辑器接入补全下拉 —— 关键字 + 表名（FROM/JOIN 后）+ 列名（`alias.` 或已引用表），Ctrl+Space 手动唤起、↑↓ 选择、Enter/Tab 接受、Esc 关闭；元数据经 `GET /dsh-data-ide/schema` 读 `information_schema.COLUMNS`（按连接 5 分钟缓存，凭据解析走与面板执行同一路径，session 密码同样可用）。**不引入解析器**：仍是 token/关键字启发式，无作用域推导、无语义校验 | AI + PM |
| 2026-10-18 | **基线切到 dsh 0.2.1-rc.2**：用户最终要装的是桌面端 `E:/deepseek-harness`（`resources/app.asar`），0.1.7-rc.2 降为只读参照；开发 profile 改 `dev-sql-021`（同一份插件已 link 装好，`--dump-config` 确认两行 insert 正常）。CLI 入口 `resources/runtime/cli/bin/dsh.cmd`（`ELECTRON_RUN_AS_NODE=1` 跑 `dsh-desktop-host/lib/cli.js`）。0.2.1 仍保留 `sidebarRightTabs` + `sidebar.right.pane.tab(.title)` + `webServer.register`，本仓现有接口方向不变 | AI + PM |
| 2026-10-18 | **面板通道改为同源 HTTP（架构修正）**：web 前端是独立进程，浏览器半**无法**通过 Cordis context 取到 node 服务（`ctx['sqlWorkbench']` 取不到或直接抛，导致 client entry 不激活、web boot 失败）。改为 node 半在 composition 的 `webServer` 上挂 8 条 `/dsh-data-ide/*` exact 路由（dsh-chat 同款），client 半用同源 `fetch`；`PanelApi` 顺带补上 M1 起就缺失的 save/remove/test 实现。见 02 §5 | AI + PM |
| 2026-10-18 | **首次真机启动修复（两处阻塞）**：① 存储域名 `dsh-data-ide` 被 storage-json 的 `UNIT_NAME_RE=/^[a-z][a-z0-9_]*$/` 拒绝（`invalid unit name`），改为 **`dsh_data_ide`**；② 右栏 body seat 的 `inject` 误写成函数，宿主是把它当**props 记录**展开的（对齐 `ui-sidebar-files`），导致 tab 打开后一片空白 → 改为 `{ api }` 记录并补 `locale`。另加 `PanelBoundary`：面板渲染异常时显示可读文案而非空白面板。见 04 §3、08 R16 | AI + PM |
| 2026-10-17 | **M2 界面侧落地（最小可用闭环）**：编辑器（执行/取消、Ctrl/Cmd+Enter、Esc）+ 结果网格（类型化格式化、sticky 表头、列头三态排序）+ 分页条（首/上/下/末页、页大小菜单、COUNT 降级、截断提示）；执行中状态在请求返回前即发布，取消可命中未返回的语句。**人可在页面上自行配置连接并跑 SQL**，无需向 AI 提供口令 | AI + PM |
| 2026-10-17 | **M2 执行侧落地**：`execute_sql` / `fetch_page` / `cancel_statement`（WrapInSelect 分页 + 独立 COUNT + 只读门禁 + 大值截断 + 单语句）；执行核心抽到 `src/execute/`，**界面与 agent 共用一份引擎**；`columns` 补 `typeName`、响应补 `statementId`（取消可用）；排序列白名单放宽到中文列名；mysql2 进包依赖 + node 半 bundle external。**修复**：node 半入口 `lib/index.js` 自 M1 起未被构建（stale 124B 占位），宿主服务从未真正打进产物 | AI + PM |
| 2026-10-17 | **M1 连接管理落地**：存储域/凭据缝绑定 + 运行时 spec 密钥通道 + `list_datasources`/`test_connection` + 连接条与配置弹窗（三态渲染）；新增 `docs/testing.md` 验证手册。测试 19 文件 172 用例、per-file 100% | AI + PM |
| 2026-10-17 | **M0 完成**：dev-sql + dsh 0.1.7-rc.2 实机验证——右栏「SQL 工作台」入口可见（人侧）、agent 实调 `mcp__sql__ping` 返回 pong（AC-5）；期间修复浏览器半产物契约（`__ModuleLoader__` 工厂，06 §12.7.8）。证据见 `.agents/notes/2026-10-17-m0-scaffolding.md` | AI + PM |
| 2026-10-17 | **宿主基线切换（重大）**：目标宿主定为 **dsh 0.1.7-rc.2**（用户本地 desktop 实际运行版）；右栏扩展点由 `session.pane.right` 改为 `sidebarRightTabs.register` + `sidebar.right.pane.tab` / `.title`；包名改裸包名 `dsh-data-ide`；**取消** `requestCapacity` 与「对话分屏 / per-pane 右栏」语义（0.1.7 无此能力）。依据与证据见 06 §12 | AI + PM |
