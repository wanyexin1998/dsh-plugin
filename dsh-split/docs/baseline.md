# W001 · 基线：宿主、交付包、旧插件与依赖许可

**冻结基线**：`DSH-SPLIT-V5-FROZEN-20261015`（工程任务 v1.0）
**本文件状态**：W001 执行记录（P0）。未开始任何原生改动；本轮只做只读核对与记录。
**相关冻结规则**：F01（宿主固定）、F16（不做范围外能力）

> 本文件属于 v5 冻结包的执行产物。仓库 `docs/` 下原有的 `architecture.md`、`layout-spec.md`、`refactor-plan.md`
> 属于重构前的历史方案，按用户决定**原样保留、不迁入 v5 工程**，也不作为实现依据。v5 以冻结包内
> `dsh-split-final-plan.html`（行为）与 `engineering-tasks.md`（任务与验收）为准。

## 1. 宿主基线

| 项 | 值 | 来源 |
| --- | --- | --- |
| 运行目标 | Windows 桌面应用，profile `desktop` | `~\.dsh\profiles\desktop\package.json` |
| 宿主版本 | **`0.2.0-rc.2`** | 安装包内 `/dsh/package.json`（`@deepseek-ai/dsh-desktop-runtime`）与 `/dsh/node_modules/@deepseek-ai/dsh/package.json`（`@deepseek-ai/dsh`） |
| 冻结 tag | `dsh-v0.2.0-rc.2` | 冻结包 `manifest.json` / `README.md` |
| 冻结 commit | `639ed015397290b3745d163aafe02ffee4aa3f84` | 冻结包声明 |
| commit 可否本地复核 | **否** —— 安装产物不含 `gitHead` 或 build 元数据；按“声明值”记录，未独立复核 | `/dsh/package.json`、`/dsh/node_modules/@deepseek-ai/dsh/package.json` 均无该字段 |
| 应用安装位置 | `E:\deepseek-harness`（`resources\app.asar`，121,348,951 字节 / 12,967 项） | 本地只读读取 |
| 宿主源码可读性 | **可读**：`app.asar` 内含 `/dsh/node_modules/@deepseek-ai/*`（`dsh-client-ui-layout`、`dsh-client-ui-sidebar-right`、`dsh-client-ui-conversation`、`dsh-client-ui-slots`、`dsh-client-ui-renderer`、`dsh-api-session-controller` 等） | W002 的只读核对依据 |
| 构建/运行工具链 | Node `v24.21.0`、pnpm（随宿主运行时提供）：`~\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\{node,pnpm}` | 本机探测 |
| 网络 | npm registry 可达（`registry.npmjs.org` HTTP 200）——W005 拉取候选 Dockview 包的前提 | 本机探测 |

**只读读取方式**：`E:/wyx_code/_v5-frozen/tools/read-asar.mjs`（读 asar 头 + 按需取文件，不修改安装）。该工具在工作区临时目录，不属于插件工程。

## 2. 冻结交付包校验

| 文件 | 字节 | SHA-256（与 `SHA256SUMS.txt` 一致） |
| --- | ---: | --- |
| `dsh-split-final-plan.html` | 258,629 | `03ca5765…7ba39cb` ✔ |
| `dsh-split-interactive-demo.html` | 90,107 | `463c4260…97dd31a` ✔ |
| `engineering-tasks.html` | 104,463 | `c3c985d0…40ab2b3` ✔ |
| `engineering-tasks.json` | 59,232 | `2dc0c458…8f308f8` ✔ |
| `engineering-tasks.md` | 69,556 | `0c7dfef9…884e4f166` ✔ |
| `index.html` | 6,255 | `523462d7…4f1c1` ✔ |
| `manifest.json` | 3,207 | `5c11ed6e…afa25cc` ✔ |
| `README.md` | 4,377 | `9910d41b…8249af` ✔ |
| `QA-DELIVERY.md` | 3,789 | `8c1d4152…a97dd0` ✔ |

九份文件全部与包内校验和一致（本地重算 SHA-256）。两份冻结 HTML 未重新格式化、未改动。
校验和只用于完整性检查，不构成签名的真实性认证。

## 3. 旧插件记录（只记录，不卸载、不覆盖）

| 项 | 记录 |
| --- | --- |
| 包名/版本 | `dsh-split` `0.1.0`（`private`，`type: module`） |
| profile 状态 | 已启用：`~\.dsh\profiles\desktop\package.json` 的 `dependencies["dsh-split"] = "link:E:/dsh-plugin/dsh-split"`，且列在 `dsh.profile.bundles` |
| 包入口约定 | `main: lib/index.js`；`exports["./client"] → lib/client.js`；`dsh.bundle.patch → ./cordis.patch.yml`；`dsh.client.platform = web` |
| 唯一数据键 | `dsh.split.v1`（`localStorage`，读写各一处：`lib/client.js`）→ W028 一次性迁移的**唯一来源** |
| 旧实现规模 | `lib/client.js` 是单文件手写 bundle（无构建、无 src/）——按 W008 必须改成 src 源码 + 构建产物 |
| 处置决定（用户） | **就地重建**：新工程建在 `E:\dsh-plugin\dsh-split`；旧包入口路径（`lib/client.js`、`lib/index.js`）在切换前继续可用，避免开发期间破坏用户正在用的分屏 |

## 4. 依赖与许可清单（初稿）

**宿主侧（只读，不作为插件依赖）**：`/dsh/node_modules/@deepseek-ai/*` 共 100+ 个包，已抽样核对全部为
`0.2.0-rc.2` + `MIT`。插件不打包宿主 React（W008 验收项：不得打包第二份 React）。

**插件侧（待 W005 锁定后进入 lockfile）**：

| 候选 | 版本 / 许可 | 依赖关系 | 状态 |
| --- | --- | --- | --- |
| `dockview` | `8.5.1` · MIT（183 个已发布版本） | 依赖 `dockview-core@^8.5.1` | 候选（`latest`），**未锁定** |
| `dockview-react` | `8.5.1` · MIT | React 为 **peer**（`^16.8 \|\| ^17 \|\| ^18 \|\| ^19`），依赖 `dockview@^8.5.1` | 候选；宿主 React 单例可满足 peer，不得打包第二份 |
| `dockview-core` | `8.5.1` · MIT | 无依赖 | 候选（被上面两者传递引入） |
| 构建工具（esbuild） | 待定 | — | 用户已确认采用“Dockview + esbuild + TypeScript” |
| TypeScript / 测试框架 | 待定 | — | W008 要求 lint + 类型检查 + 单测 + 构建脚本 |

registry 元数据查询时间：2026-10-15；`dockview` 系列最近发布 2026-10-10。
**候选 ≠ 锁定**：W005 必须在锁定的 rc.2 上验证受限配置（一 Group 一会话、隐藏标签、禁中心合并/浮动/popout、
公开 add/move/resize/maximize/state API、源移除后的落点预览与 Esc 取消）后，才把具体版本写入 lockfile；
不以文档网站当前主版本替代验证。

**放行规则（W001 验收）**：依赖许可未确认、或构建出现第二份 React 时，
**不批准后续打包**。

## 5. 明确不迁入生产（W001 步骤 4）

- 旧 bundle：`lib/client.js` 现有实现（浮层 + 编辑器 generation 抢回 + 二叉树布局）——**只作历史与 `dsh.split.v1` 迁移参考**。
- v5 原型内的演示数据与布局树：`dsh-split-interactive-demo.html` 是交互与视觉对照，不是生产实现；其存储键 `dsh-split-demo.final.v4` 属演示产物。
- 仓库 `docs/` 下三份历史方案文档：不迁入 v5 工程、不作为依据。
- 其他定制项目假设：不引入（F01）。

## 6. 结论与移交

- ✅ 宿主 tag 与冻结方案一致（`0.2.0-rc.2`）；安装产物无 commit 元数据，commit 按声明记录、未独立复核 —— 不构成阻断，但**不得据此自动升级宿主**。
- ✅ 两份冻结 HTML 哈希匹配，未被修改。
- ✅ 旧插件与唯一数据键已记录，未做任何环境改动。
- ⏳ `dockview` 版本/许可未锁定 → 由 W005 完成，是本 P0 的未决项之一。
- 移交下一任务：**W002**（正式扩展契约盘点，产出 `docs/compatibility-matrix.md`）。

## 7. 本任务验收对照

| 验收条件 | 结果 |
| --- | --- |
| tag/commit 与冻结方案一致，或明确阻断而非自动升级 | tag 一致；commit 无本地元数据 → 已明确记录为“声明值”，并写下“不自动升级”规则 |
| 两份冻结 HTML 哈希匹配；未重新格式化或修改其内容 | 通过（见 §2） |
| 依赖许可未确认或出现第二份 React 时，不批准后续打包 | 规则已写入 §4；Dockview 许可待 W005 |
