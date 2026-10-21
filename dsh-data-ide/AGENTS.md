# AGENTS.md — dsh-data-ide 工程规则（浓缩版）

> 上游权威：`docs/00-README.md`（枢纽）→ 01-PRD / 02-ARCHITECTURE / 03-UIUX-SPEC / 04-DATA-MODEL / 05-MCP-SPEC / 06-PLUGIN-ENGINEERING / 07-MILESTONES / 08-RISKS；证据源 `docs/reference/`（DataGrip 逆向 4 份）。
> 冲突时以 `docs/` 为准；**代码与文档不得长期分叉**——任何偏离当场改文档并在 `docs/00` §9 变更记录登记（含理由）。

## 0. 项目一句话

dsh（DeepSeek Harness，**0.2.1-rc.2**）右栏的**新页面类型 tab**——轻量 SQL 工作台（连接 / SQL 编辑 / 结果网格 / git），同包附带 MCP server（serverName `sql`），人与 agent 共用同一套能力。

## 1. 宿主与仓库

| 项 | 值 |
|---|---|
| 目标宿主 | **dsh 0.2.1-rc.2**（桌面端 `E:/deepseek-harness`，代码在 `resources/app.asar`）。**2026-10-18 基线切换**：原 0.1.7-rc.2（`E:/wyx_code/dsh-official-v0.1.7-rc.2`）仅留作只读参照——用户最终要装的就是桌面端这一版 |
| 桌面端启动（0.2.1） | **桌面应用 = `E:/deepseek-harness/DeepSeek Harness.exe`**（Electron，桌面快捷方式指向它）。它默认使用 **`desktop` profile**，且该 profile **由 Electron 独占**：`dsh.cmd --profile desktop …` 会直接报 `profile "desktop" is managed exclusively by the Electron application`，连 `--dump-config` 都不行 |
| profile 三分（2026-10-20 实测更正） | ① **`desktop`** = 桌面应用默认用，Electron 独占，装插件要 `dsh.cmd plugin --profile desktop add link:<包目录>`；② **`dev-sql-021`** = 本项目的开发验证 profile，CLI 可自由启停，`dsh.cmd --profile dev-sql-021 --port <n>`；③ `web` = 另一套手工环境，与桌面应用无关（此前文档误写「桌面端跑 web profile」，2026-10-20 更正） |
| 开发验证 profile | **`dev-sql-021`**（0.2.1 上新建，`dsh.cmd plugin --profile dev-sql-021 add link:<包目录>` 自动创建）；旧的 `dev-sql` 属于 0.1.7。改 `web` / `desktop` 前需用户明确批准 |
| 开发仓库 | `E:/dsh-plugin/dsh-data-ide`（独立 git 仓，pnpm workspace） |
| 包目录 / 包名 | `packages/client/ui-sql-workbench/` / **`dsh-data-ide`**（裸包名；`@deepseek-ai/*` 是官方命名空间，外部插件不占用） |
| dsh monorepo（只读参照） | `E:/wyx_code/deepseek-harness`（本地 checkout 在 master）。**不切用户分支、不改 monorepo** |
| 已废弃路线 | `codex/presentation-v2` 分支（0.1.1/0.1.2-rc.1，游离快照）上的 `session.pane.right` + `requestCapacity`——0.1.7 已无此 slot，见 `docs/06 §12` |
| 运行时 | Node ^22.19 ｜ >=24；pnpm；M4 需 JDK/JRE 17+（本机 `java` 不在 PATH） |

## 2. 目录结构

```
packages/client/ui-sql-workbench/     # 包名 dsh-data-ide
├── package.json            # dsh.bundle.patch + dsh.client{platform,inject} + exports['./client']；无 peerDependencies
├── cordis.patch.yml        # insert 两行：插件行 + mcp-sql 行
├── build.mjs               # esbuild 三入口 + tsc 声明
├── src/index.ts            # node 半：空 apply（宿主单写者逻辑随 M1 加入）
├── src/client/
│   ├── index.ts            # 浏览器半：右栏 tab 两段式注册
│   ├── guard.ts            # 运行期能力守卫（fail-closed）
│   ├── locales.ts          # zh/en 字典
│   ├── contract/           # constants.ts（id/slot 名）、host.ts（宿主类型面，自建）
│   ├── components/         # 面板 / tab chip / guide 图标 + *.module.css
├── mcp/server.ts tools.ts  # MCP server（stdio）
└── tests/                  # *.spec.ts(x)，per-file 100% coverage
tools/                      # precommit.sh、pack-plugin.mjs
docs/                       # 00-08 + reference/
```

## 3. 硬性规则（违反即回退重做）

### 安装与兼容（0.1.7 特有，最易踩）
- **禁止声明任何 `@deepseek-ai/dsh*` 的 `peerDependencies`**——不兼容即硬失败、整包被 skip（`packages/boot/plugin-manager/src/index.ts:301-302`；现场证据：`dsh-desktop-server.log` 里 dsh-workbench 正被跳过）。未声明 `peerDependencies` 的包免检（`app-boot/src/plugin-compatibility.ts:69`）。
- 产品兼容性靠**运行期 Guard**：`ctx.sidebarRight` / `ctx.sidebarRightTabs` 缺失 → 打印可读原因并跳过注册，不抛异常、不静默。
- 外部插件**不需要**改 monorepo（三处注册面是 in-box 专属）。挂载只靠包内四件套：`dsh.bundle.patch` + `dsh.client{platform:'web',inject}` + `exports['./client']` 落到真实文件 + `cordis.patch.yml` 一行 insert（`name` 用裸包名）。
- 0.1.7 的 `!!js` 表达式只能看到 `process` 与 Loader ctx 上的 `dshHomePath`（`app-boot/src/index.ts:995`），**没有 `require` / `import.meta`**——一切路径解析必须落在这两者之内。

### 注册
- 右栏页面类型两段式：`ctx.sidebarRightTabs.register({id, kind, title, guide})` + `slots.inject('sidebar.right.pane.tab' / '…tab.title')`，两处 `key` **必须等于定义的 `id`**。
- 一切注册走 `ctx.effect()`；禁模块级副作用；卸载必须完全回收（页面类型 + 两个 seat）。
- **勿注册** `root` / `sidebar` / `conversation` / `details` / `rightbar` 本体（会抹掉整帧）。
- 禁跨包 `@deepseek-ai/*` **value import**（服务由 ctx 提供；产物对宿主零依赖）。宿主类型面自建在 `src/client/contract/host.ts`。
- 动态插件产物是纯 JS；**JSX 必须经构建，禁止直改 `lib/`**。

### UI
- 只用 `--dsw-alias-*` 语义 token（映射表见 03 §2）；**禁硬编码颜色**；组件 CSS 禁主题选择器；浮层需 rebind `--dsh-scrollbar-thumb` 到 l2 对（禁写组件级 `::-webkit-scrollbar`）。
- 产品文案中文，代码注释英文。复用 `ui-primitives`，禁重复造轮子。
- 面板外壳抄 `ui-conversation/.../DetailsPanel.tsx`；tab 栏 / 表格抄 `ui-trajectory` 的 `.detailTabs/.detailTab/.table`。

### 质量
- **per-file 100% 覆盖率**（vitest；`vitest.config.ts` 已开 thresholds）。豁免仅限不可达分支且写 `/* v8 ignore -- reason */`。
- **事件型 UI 用例必须按真实事件序列写**：`pointerdown → pointerup → click`。直接 `.click()` 会漏掉「在 pointerdown 里卸载节点」这类 bug（2026-10-20 右键菜单实测踩过）。
- **`void somePromise()` 等于放弃错误处理**：凡 `void` 掉的 Promise 必须有内部 `catch`（2026-10-20 剪贴板实测踩过）。
- 测试环境：jsdom 无布局，CodeMirror 需要 `tests/setup/jsdom-cm.ts` 的 `Range.getClientRects` 补丁；网格类用例用 `EditorView.findFromDOM` 驱动（`tests/support/editor.ts`）。
- 先写失败测试再写实现；每完成一个里程碑更新 `docs/07` 状态 + `docs/08` 风险复盘 + `docs/00` 变更记录。

### 合规
- 不复用 DataGrip 任何字节码/资源/文档原文；不抢注 JetBrains/DataGrip 商标；UI 文案用自有品牌「SQL 工作台 / dsh-data-ide」。
- Oracle 驱动（ojdbc11）随包分发必须附 OTN 许可声明；mysql2 为 MIT。
- **不读取、不导出、不打印任何真实密码/token**；测试一律用本地凭据或假数据。

## 4. 已定技术决策（速查，勿重新论证）

| # | 决策 | 取值 |
|---|---|---|
| 1 | 右栏宿主 | 0.1.7-rc.2 右栏页面类型：`sidebarRightTabs.register` + `sidebar.right.pane.tab` / `.title`（keyed/session）；**无** `requestCapacity`、**无** per-pane 右栏（0.1.7 无对话分屏） |
| 2 | 包标识 | 包名 `dsh-data-ide`；tab `id = kind = dsh-data-ide.sql-workbench`；MCP `serverName = sql` → 工具 `mcp__sql__*` |
| 3 | 后端 | MCP server（Node/stdio，同包 `./mcp`）+ mysql2 直连 Doris/MySQL。**Oracle / Java 桥已降级 P1，不做**（故不引入 ojdbc11，也无 OTN 分发负担） |
| 4 | 分页 | 首页 `LIMIT pageSize+1` 探针 + 独立 `SELECT COUNT(*)` + OFFSET；页大小默认 500（上限 5000）；COUNT 缓存至 schema 变更/手动刷新 |
| 5 | 存储 | storage-json 三文档 `datasources/history/layout`（schemaVersion）；凭据走 `ctx.credentials`（key `dsh-data-ide/<connId>`，UUID 规范化为 `ds-<8hex>`）；**密码永不入配置**；宿主单写者，MCP server 无状态 |
| 6 | 连接测试 | 三态 YES/NO/UNSURE + database-info 缓存（字段镜像 04 §2） |
| 7 | git | 隔离脚本目录 `<dshHome>/data-ide-scripts/`；token 走 credentials → 临时 credential helper（不落盘） |
| 8 | 安全 | agent 默认只读（仅 SELECT）；写操作需连接级 `writeEnabled`；DDL 黑名单默认拒绝；写操作审计；单单元格 1MB、预览截断 32KB |
| 9 | 分发 | 开发期 `link:` 装进 dev-sql；验收后经用户批准装进 `web` profile；终态 tgz |
| 10 | MCP | `serverName: sql`；`toolCallTimeoutMs: 120000`；凭据**不经 env**；server 入口路径经 `!!js` 表达式从活动 profile 的 node_modules 解析 |
| 11 | 编辑器内核 | **CodeMirror 6**（2026-10-20，用户拍板）：`client/editor-cm.ts` 装配 + `SqlEditor.tsx` 适配；主题走 `EditorView.theme` + `--dsw-*`（不产 CSS 文件）；client 目标开 `minify`（513KB / gzip 167KB）。不引入 Monaco |
| 12 | 结果筛选 | **服务端 WHERE**：`ExecuteRequest.filters` 进分页包裹与 COUNT；不做"仅本页"客户端过滤（`grid.filterIndexes` 仅为历史遗留，勿再用） |
| 13 | 错误文案 | 驱动错误先经 `client/db-error.ts` 翻译（剥 `errCode` 外壳、按模式成人话）；**注意拒绝有两形态**：`ok:false` 与 HTTP 5xx 抛异常，两处都要处理 |

## 5. 工作流

任务循环：**读对应文档章节 → 写失败测试 → 实现 → 绿 → 更新文档状态 → 提交**。

命令：`pnpm build`（三入口 bundle + 声明）→ `pnpm test` → `pnpm coverage` → `pnpm typecheck`；提交前 `pnpm precommit`（bundle / vitest / coverage / 硬编码色 / 跨包 import 五项自检）。

分支：`main` 保护；功能分支 `feat/M<x>-<slug>`；conventional commits（`feat(ui): …` / `fix(mcp): …` / `docs: …`）。

阻塞处理：按文档默认值自主推进；仅当「文档未覆盖且阻塞 >30 分钟」才停下，用结构化问题提问（选项 + 推荐项 + 影响）。

验证手册：`docs/testing.md`——自动化命令、dev profile 安装步骤、**人工 smoke 清单**（连接管理 S1-S10、agent 侧 A1-A4）、运行时产物位置与故障对照表。真实 Doris 连通性由人执行，自动化测试不需要任何生产凭据。

## 6. 验收标准（AC-1~AC-8，唯一真理）

| # | 标准 |
|---|---|
| AC-1 | 新建 Doris 连接测试 ≤3s 三态反馈，失败有可读原因 |
| AC-2 | 内网大表首页（500+1）≤2s；COUNT 与探针一致 |
| AC-3 | 翻页/跳页/改页大小均 `LIMIT n+1 OFFSET m`；连翻 3 页无重无漏 |
| AC-4 | 脚本保存→commit→push UI 全流程；agent 经 MCP 完成同样流程 |
| AC-5 | 插件安装后 agent 自动可见 `mcp__sql__*`（无手工配置） |
| AC-6 | 默认拒绝非 SELECT；`writeEnabled` 放行；错误明确 |
| AC-7 | 全界面 `--dsw-alias-*`；亮暗切换无硬编码色残留 |
| AC-8 | per-file 100% coverage；Agent Note / 变更记录随提交 |

## 7. 明确不做（防范围蔓延）

**已实现，不要当成"不做"**：introspection/对象树（2026-10-19 起，含表/视图分组、右键菜单、DDL）、SQL 语法高亮与 schema 补全（2026-10-20 由 CodeMirror 6 提供）。

明确不做：编辑回写、事务/会话管理、SSH/SSL 隧道、远程执行、图表/Geo/Compare、多结果集对比、**对话分屏 / per-pane 右栏**（0.1.7 起就无此能力，见 08-RISKS R1）、**Oracle 连接与 Java 桥**（2026-10-17 降级 P1）。

待办清单的唯一事实源是 `docs/09-BACKLOG.md`；新需求先写进 09（并判断是否要进 §7 的不做清单），不擅自扩范围。
