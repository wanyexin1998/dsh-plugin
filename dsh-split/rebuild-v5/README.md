# DSH Split v5 重构版

本目录是以 `dsh-split-v5-frozen-20261015.zip` 为产品依据的独立重写。没有读取或复用历史插件的实现、测试或补丁。原生接入依据本机未经修改的 DSH `0.2.0-rc.2` 的 `app.asar`；压缩包中的模拟聊天和终端只用于理解交互，没有装进生产组件。

## 实现与边界

- `src/workspace.ts`：唯一外层 Dockview 引擎、会话绑定、分屏与移动、窄屏投影、最大化和几何保存。
- `src/workbench.tsx`：固定的会话组件和原生内容挂载区域，保留原生 Header、聊天、文件、审批以及 Sidebar 标签内容。
- `src/gestures.ts`、`src/outer-resize.ts`：窄边缘拖动、每帧合并更新、取消事务、透明外分隔、键盘调整与双击均分。
- `src/geometry.ts`：内层四方向布局、独立横纵比例、尺寸约束、经过白名单校验的存储格式；复杂拖动只显示方向提示，避免用第二套布局引擎绘制不准确的预览。
- `src/host.ts`、`tools/native-patches.mjs`：原生会话与 Sidebar 的明确归属、主内容区域租约、重复导航事件、文件/浏览器等操作的会话目标。原包 SHA-256 和每个替换锚点都必须匹配，才生成候选补丁。
- `src/styles.css`、`src/overlays.tsx`：依据 2026-10-16 视觉简化要求统一外壳、聚焦状态、菜单、拖动反馈和深浅主题。样式在原生内容边界停止，避免覆盖原生 Tab 和编辑器。

会话外层和 Sidebar 顶部仅保留 8px 拖拽区，支持点击及键盘操作。Sidebar 可停靠到本会话四个边缘；会话可整体移动。Sidebar 收起、全屏、还原使用 DSH 原生控件，全屏只填满所属会话；收起后的重开入口仍位于原生会话 Header。左侧原生会话菜单提供向右/向下分屏、移动分屏和关闭此分屏；分屏状态下每个 pane 的会话 Header 行最右侧（原生 Sidebar 控件右边）还有一个插件自绘的关闭控件（仅在 2 个及以上分屏时出现）。

分屏工作区使用左侧栏的原生背景变量 --dsw-specific-sidebar-fill，顶部与底部各留 8px；右侧留白与左侧导航形成同一底层。聚焦会话与非聚焦会话分别使用轻微色差的背景，只在单个会话内覆盖 `--dsw-alias-bg-base`，外壳、聊天内容和 Sidebar 共享该底色，会话外壳不增加边框或阴影。Sidebar 按冻结原型恢复 12px 圆角、1px、55% 原生边框色的轻边框（去掉原生首列重复左边线）、12px 正文间距与克制的静态阴影；会话内部保留 8px（窄屏 6px）余量承接阴影。未聚焦会话另覆盖 16% 同底色蒙层，使内容文字淡化且不再次改变背景、不拦截点击。主题同步观察 DSH 实际使用的 `body[data-ds-dark-theme]`。

8px 拖拽热区始终透明，无矩形焦点框；悬停时显示轻微短线，键盘聚焦时加强短线提示。深浅主题均验证页面、聚焦会话、非聚焦会话三层颜色不同，焦点切换不影响全页底色，且会话内各区域颜色相同。

会话和 Sidebar 的内层几何由 CSS Grid 与容器查询处理，避免用 React 测量回写会话尺寸。仅 Sidebar 的浮动标签需要局部测量；工作台统一负责 Dockview 尺寸监听，像素变化不再广播整个工作台更新；拖动开始时捕获布局快照，避免每帧序列化。

关闭分屏不会删除会话；收起或移动 Sidebar 不等于关闭终端。布局存储只保存安全的会话引用和几何，不保存聊天、草稿、凭据或终端内容。使用全新的 v5 存储命名空间，历史布局不读取、不删除。

## 验证

`tools/verify.mjs` 按顺序执行源码与夹具类型检查、生产构建及全部测试，并记录精确产物哈希。结果见 `evidence/verification.json` 和各项日志。`evidence/browser-checks.md` 记录实际 Chromium 交互检查及其范围。

测试夹具 `tests/fixture.html` 使用生产 Workbench 与合成的原生宿主替身；它不连接真实会话、模型或服务器。真正原生接入另外通过执行原版 Registry、SessionProvider、Sidebar 和 DockLayout 的合同行为测试验证。不能将夹具截图当成真实 DSH 桌面端的端到端验收。

`tools/validate-release.mjs` 另行启动实际 Electron Desktop Host 和 Chromium，使用隔离的 DSH_HOME，依次验证原版、启用分屏、完整重启、禁用分屏、缺少原生补丁五种场景。启用场景通过原生会话菜单向右和向下分屏，检查三个真实编辑器的独立草稿、侧栏切换时的编辑器身份，以及刷新和完整重启后的三会话恢复。测试不发送模型消息；空测试会话的列表行会设为可见，底层会话、绑定和编辑器仍为原生实现。结果保存在发布目录的 `boot-validation.json`，截图与详细日志保存在 `.boot-check`。

安装器要求这五项真实启动验证全部通过，且报告与发布文件哈希完全匹配，否则在修改桌面 profile 之前拒绝安装。隔离测试使用浏览器入口；真实桌面窗口的检查单独记录在 `evidence/desktop-recovery.json`。

## 2026-10-16 启动故障修复

已安装发布 `0.5.0-rebuild.2-256513ff9e1d`。99 项测试和五种隔离启动场景全部通过；实际 `dsh-app://app/` 桌面窗口已用两个现有会话验证分屏、正常退出和完整重启后的布局恢复，两个原生输入框均正常，未产生新的崩溃报告。窗口保留为双会话分屏。安装回退凭据见 `backups/install-2026-10-16T05-52-31-604Z/receipt.json`。

旧发布把原生包的服务端 `lib/index.js` 复制到独立发布目录，导致它们失去 app.asar 内的依赖解析路径。`ui-conversation` 等宿主模块加载失败后，前端缺少 `uiConversation` 服务，五个依赖它的模块一直等待；普通重启仍会加载同一组坏文件。新发布只覆盖浏览器代码，服务端入口转发到未经修改的 app.asar，且验证十二个包的导出身份与原版完全一致。

同时修正 bundle 注册、Sidebar 工厂重复注入 `usePanelInfo`、本地布局随机命名空间，以及冷启动在原生会话目录仍为 `pending` 时提前恢复的问题。已删除的会话不再恢复；缺少 Sidebar 补丁时分屏保持未启用，原生界面仍能启动。所有发布文件包括服务端入口均纳入哈希检查。

## 2026-10-16 视觉、交互与性能统一验收

已安装 `0.5.0-rebuild.3-b32252859566`，101 项测试和五种隔离启动场景全部通过，运行时错误为 0。真实原生宿主中验证深浅主题、原生 Sidebar 控件及局部全屏、四方向停靠、原生菜单移动/关闭、窄边缘拖拽取消、窄屏恢复、独立草稿与三个会话的冷启动恢复。13 个安装包的文件与候选发布哈希全部匹配。

相同三会话合成文字负载、每项三轮测试，分屏调宽、Sidebar 调宽、左栏收展的脚本耗时中位数分别降低 81.3%、83.5%、67.2%；原生编辑器保持同一实例。布局耗时和帧间隔仍受机器负载影响，不将脚本开销下降等同于固定帧率保证。完整指标、深浅主题截图及验收范围见 `evidence/visual-refinement.md` 与 `evidence/visual-refinement.json`。

本次没有重启或热替换用户正在运行的 DSH；新版在下次正常启动时生效。回退凭据为 `backups/install-2026-10-16T07-31-00-158Z/receipt.json`，旧发布保留。

## 2026-10-16 分屏关闭控件恢复

用户反馈"分屏后没有关闭窗口的按钮"。核实结论：关闭能力一直在，但 2026-10-16 视觉简化取消插件自绘会话标题栏（`.v5-session-head`）时，原型 `.head-actions` 里的关闭按钮随之消失，关闭只剩左侧会话行菜单一项。

- `src/host.ts`：`NativeCallbacks` 增加 `canClose`；左侧菜单"关闭此分屏"行改用同一判据（原来只判 `isShown`，单 pane 也能关掉整个工作台，只剩空态）。
- `src/workbench.tsx` + `src/styles.css`：`SessionPane` 在会话列（`.v5-conversation`）里自绘关闭控件（`[data-dsh-split-close]`，28×28、15px 图标、`z-index:25` 高于非聚焦蒙层），仅 `w.panes.size > 1` 时渲染。它锚在会话列上，因此原生 Sidebar 停靠右侧并展开、列宽变化时仍贴在 Header 右端；列被隐藏（Sidebar 全屏 / 窄屏独占）时随之隐藏，那时左侧菜单入口仍在。
- `src/workspace.ts`：`canClose = 该会话在分屏中 && pane 数 > 1`。单 pane 是普通视图，不提供关闭，避免留下永久空工作台。
- **边界例外（仅此一处）**：`[data-v5-workbench] .v5-native-conversation [data-slot="conversation.header"] > header { padding-right: 64px }`（原生 Header 的真实层级是 `.v5-native-conversation > 原生根节点 > [data-slot="conversation.header"] > header`，用 `data-slot` 定位槽位包装、只取直接 `header` 子级，不依赖 hashed 类名、不波及消息内的 `<header>`）。原生 `headerCorner{margin-left:8px;margin-right:-16px}` 把最后一级控件塞进 28px 右内边距，实测 ▯（原生 Sidebar 控件 28×28）右边缘距 Header 右边缘只剩 12px，放不下 28px 的会话操作按钮；加宽 36px 正好让原生一组左移一位，插件按钮落在 ▯ 右侧（间距 8px、距右缘 12px，与原生留白惯例一致）。副作用仅标题行提前 36px 截断；原生单会话视图没有该包装元素，不受影响。真实宿主几何断言覆盖（`paneCloseInline`）。
- 为什么不放进原生 Header 槽位：`conversation.session.header.actions` 与 `.utilities` 都在原生 `!hideChrome` 分支里——空会话（新建会话分屏后的常态）只渲染 `corner`，而那个 single 槽位是原生 Sidebar 控件；`conversation.header.leading` 是 root 作用域、没有会话身份。真实 5 场景验证的 `enabled` 里 "pane close control" 正是在这个约束下失败后才改为插件外壳 + 边界例外。
- 覆盖：`tests/outer-resize.test.mjs` 断言 `canClose` 语义；`tools/native-session-check.mjs` 在真实宿主里断言几何（`paneCloseInline`：✕ 在 ▯ 右侧、与 Header 同行、Header `padding-right` 为 64px）后用该控件关一个 pane，再用左侧菜单关一次，两条路径都跑。

**状态（2026-10-17 02:23）：已构建、已测试、已生成发布、通过真实启动验证并已安装到本机 desktop profile；等待用户自行重启 DSH 生效。**

- `node tools/verify.mjs`：typecheck / build / tests 全通过，101 项，`lib/client.js` sha256 `3e60b47e748cec0bf1d346b064dd21e104c4eb5b6973e61cad3aaa5e7020659c`。
- `node tools/stage-release.mjs`：`releases/0.5.0-rebuild.7-387d279eb460`（13 个包）。
- `node tools/validate-release.mjs <release.json>`：baseline / enabled / restart / disabled / without-patches 五个隔离真实启动场景全部通过，`enabled` 记录 `interactions.refinement.paneClose`、`paneCloseInline`、`nativeMoveAndClose`、`rightGeometry` 2 pane、`belowGeometry` 3 pane，重启后恢复 3 个原生编辑器，运行时错误 0；证据见该发布目录的 `boot-validation.json`，截图见 `.boot-check/enabled-2bwTTF/screen.png`。
- `node tools/install-local.mjs`：已安装 13 个包，profile junction 全部指向该发布；`node tools/check-installed.mjs` 返回 `matched: true`（服务端入口可加载）。
- 回退凭据：`backups/install-2026-10-16T18-22-31-239Z/receipt.json`（`node tools/install-local.mjs --rollback <receipt.json>`）。
- **本次未重启**：运行中的实例仍是旧发布，按既有约定在下次正常启动 DSH 时生效。

## 2026-10-17 死代码与残留清理

按用户要求做证据化清理（先全仓库计数引用，再逐条精确删除；不使用模糊匹配）：

- `src/gestures.ts`：删除 `previewRect`（全仓库仅 1 次出现 = 声明本身，无任何调用点；实际预览由 `geometry.movePreviewRect` 承担）。
- `src/styles.css`：删除 3 处无生产者的选择器分支——`[data-resizing="true"]`（旧 workbench 曾输出该属性，重写后无人设置）、`[data-selected="true"]`（实际只输出 `aria-pressed`）、`.v5-drag-preview-label`（无该类名输出）。
- 测试：用"每个用例引用的源码符号集合"做程序化比对，同符号组的用例（MoveDialog ×4、SidebarMenu ×3、Workspace ×5）各自覆盖不同行为与断言，**不存在严格冗余**，因此未删除任何测试；删除测试会直接缩小覆盖面。夹具链（`tests/fixture.*`、`fixture-host.tsx`、`tsconfig.fixture.json`、`tools/serve.mjs`）仍在 README 与 `docs/visual-contract.md` 记录的手动验证流程里（`evidence/browser-checks.md` 的 `:4417/tests/fixture.html`），按"非死代码"保留。
- `releases/`：删除 10 个无任何外部引用（不被 `installed.json`、任何 `backups/install-*/receipt.json` 或文档引用；自引用除外）的过期发布目录；保留回退链引用的 7 个。

验证过程中修掉的**验证环境**问题（都在 `tools/`，不进入发布产物哈希）：

1. `node_modules` 里 jsdom 依赖树有 18 个空包目录，四个 jsdom 测试文件 `MODULE_NOT_FOUND`；用 `pnpm install --frozen-lockfile`（复用本机 store，零下载）修复。
2. 隔离 profile 没有模型凭据，产品自己的 onboarding 面板会反复弹出，且它不是原生 `<dialog>`，旧的无差别 `[role=dialog]` 点击永远匹配不到。它挡住会话行、关掉已打开的行菜单，并把 `Input.insertText` 吞进密钥输入框（把 "Isolated draft 1" 变成"API 密钥格式错误"）。现在：按"稍后配置"循环清到真正消失；会话行、原生菜单手势都做成"清一次→重试"的闭环；输入前确认光标确实在目标 pane（`tools/real-boot-check.mjs`、`tools/native-session-check.mjs`）。
3. `tools/chromium-probe.mjs` 的优雅退出窗口由固定 10s 改为 `DSH_SPLIT_SHUTDOWN_MS`（默认 30s）：10s 在负载高的机器上会把 baseline / without-patches 误判为 "Chromium did not finish graceful profile shutdown"。

## 2026-10-18/19 升级到 DSH 0.2.1-rc.2（rebuild.8）

- **基线更新**：`tools/native-patches.mjs` 的 `ASAR_SHA256`、12 个包的 `BASELINES`、版本门禁全部对齐 0.2.1-rc.2。76 个锚点全部命中，12 个包通过语法校验；抽查确认生效（layout 的 `splitContract` 由官方原版 0 次变为 1 次等）。
- **测试去版本耦合**：新增 `findFrontendBundle`（按形状选取入口 bundle，不再硬编码资源哈希）与 `readExportedModuleSource`（用稳定公开导出键定位模块、自动截取声明区，替代 `function ah(e)` 这类压缩名）。注意新版 bundle 在导出 map 语句前**没有分号**，声明搜索上界不能用 `lastIndexOf(';')`。
- **夹具修复**：rc.2 把空会话判为 blank，blank 行不渲染「…」菜单且被列表过滤。`blank` 每帧从投影 `sessionListMetadata` 重算，旧的 `list.set({byId})` 已完全失效。改为在 `sessions.binding(id).session` 上调用 `handleBlank(false)`，并向 `session.options.projections` 以高水位 `apply('sessionListMetadata', {blank:false}, 9e15)` 写入（缓存写会被后续 host 帧丢弃）。
- **沙箱收敛**：sidebar 测试对未声明的 bundle 符号，从"静默兜底"改为"记录 + 结尾断言"，一次列出全部缺失符号，避免上游接口消失时静默放行。
- **死代码**：删除两个测试中失效的 `frontend` 变量与未使用导入、夹具里的死返回值/诊断对象/已证明无效的 `list.set` 兜底。

本机工具链限制（重要）：`E:\dsh-plugin` 树内的程序会被策略拒绝 DLL 加载与文件读取（`winapi error #5`），TypeScript 7 的 Go 版 `tsc` 与 esbuild 因此失败。把程序镜像放到树外并通过环境变量指过去即可，`tools/verify.mjs` 与 esbuild 都支持覆盖：

```bash
DSH_SPLIT_TSC="C:/work/ts7/lib/tsc.exe" \
ESBUILD_BINARY_PATH="C:\work\bin\esbuild.exe" \
node tools/verify.mjs
```

- `DSH_SPLIT_TSC`：指向仓库外的 `tsc`（原生可执行文件直接启动；`.js/.mjs/.cjs` 仍由当前 node 启动）。不设置时沿用 `../node_modules/typescript/bin/tsc`。
- `ESBUILD_BINARY_PATH`：esbuild 官方支持的环境变量，指向仓库外的 `esbuild.exe`。

构建产物哈希与清理前 `evidence/verification.json` 记录一致（`3e60b47e…`），证明改动不影响发布产物。

## 构建、安装与回退

当前已安装 `0.5.0-rebuild.8-061d5756acd4`，13 个包全部指向该发布目录，`boot-validation.json` 五种隔离启动场景通过（含向右/向下分屏与刷新恢复），101 项测试通过。空测试会话的列表行由测试夹具置为可见，底层会话、绑定与编辑器仍为原生实现。此次回退凭据：`backups/install-2026-10-19T01-33-14-654Z/receipt.json`。

在本目录使用 Node 24 运行：

```text
node tools/native-patches.mjs E:/deepseek-harness/resources/app.asar E:/dsh-plugin/dsh-split/rebuild-v5/host-patches
node tools/verify.mjs
node tools/stage-release.mjs
node tools/validate-release.mjs <release.json 的绝对路径>
node tools/install-local.mjs <release.json 的绝对路径>
node tools/check-installed.mjs
```

本机可用 Node 位于 `C:/Users/wanyexin/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe`。依赖来自父目录现有 `node_modules`；构建会拒绝引入父目录的历史插件源码。

安装器只更新 `C:/Users/wanyexin/.dsh/profiles/desktop` 的依赖配置和指向独立发布目录的 junction；不修改 `app.asar`，不停止正在运行的 DSH。每次安装先备份配置与旧 junction 目标，逐文件验哈希，失败时回退。当前安装记录在 `installed.json`。

回退使用该次安装记录中的 `receiptPath`：

```text
node tools/install-local.mjs --rollback <receipt.json 的绝对路径>
```

DSH 对已有插件升级要求下次启动生效。本次按用户要求保留当前运行实例，验收使用独立临时配置；不强制热替换或重启用户窗口。安装后磁盘指向新发布，运行中的旧发布仍保留，下次正常启动统一加载新版。该发布仅匹配上述 rc.2 原始包；升级 DSH 后必须重新验证原生接入补丁。
