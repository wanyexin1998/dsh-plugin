# dsh-split 故障检查与本地修复记录

日期：2026-10-16（Asia/Shanghai）。检查对象：用户截图、v5 冻结 ZIP、当前插件源码/加载产物，以及本机 DSH 0.2.0-rc.2 安装产物。

## 结论与交付状态

第一阶段已在 `src/` 修复 5 项问题：回调注入错误直接产生“无法保留该会话”；缺少作用域声明阻止后续会话渲染；容器定位和基础 CSS 缺失共同产生覆盖导航栏、顶部短条布局；恢复布局早于目录到达时不会重试。第二阶段继续修复附件错投与侧栏保活，共 7 项。

**2026-10-16 11:00（+08:00）已备份并更新本机加载的 `lib/` 和两份宿主补丁。** profile 的插件/3 个宿主包 junction 均已核对；从实际加载路径读取的文件哈希与候选测试版本一致，28 个补丁文件校验通过。没有修改 `app.asar`、profile 配置或自动重启 DSH。安装和回退见 [本机安装记录](local-install-20261016.md)。

以下两项宿主缺陷现已修复。41 项自动化回归、真实 Chrome 几何、类型与构建检查通过；仍不能标记为 v5 全功能验收通过，功能差距见第 4 节。

## 1. 已修复的问题

| 编号 | 触发与结果 | 已核实原因 | 本地修复 |
| --- | --- | --- | --- |
| BUG-01 / P1 | 打开分屏后所有格子显示“无法保留该会话”；点击聚焦、侧栏开关等回调也无法正常使用 | `client.ts` 的 inject face 把普通回调对象放进顶层 `hooks`。rc.2 renderer 的 `bindInjectSources()` 会移除该字段，将其中成员转换为 `useRetain` 等订阅 hook。`Workbench` 读到的 `face.hooks` 为 undefined，调用 `.retain` 抛错后被转为占位文案。并非证据表明原会话丢失。 | 改为 `workbenchActions`，与宿主保留字段分开。见 `src/client.ts:250`、`src/workbench.tsx:332`。 |
| BUG-02 / P1 | 即使修好 retain，正文仍无法装配；每格的加载/空会话状态不能正确绑定 | `main` 注册没有声明 session 子槽。rc.2 只在声明非 root 子槽时授予 `SessionProvider`。原代码还在 root 组件读取并不存在的 `useSession/useConversation`，在 Provider 外计算 phase。 | 声明 `dsh-split.session` 严格会话子槽，在每格自己的 Provider 内由 `SessionConversation` 计算 phase 并渲染原生 `conversation.content`。见 `src/client.ts:352`、`src/workbench.tsx:154`。 |
| BUG-03 / P1 | 分屏覆盖左侧目录和窗口顶部 | 根工作台使用 `position:absolute; inset:0`，宿主中心栏没有 position，最近定位祖先是整个 AppFrame。 | 根工作台改为中心栏正常 flex 子项、relative、100% 尺寸。见 `src/styles.ts:25`。 |
| BUG-04 / P1 | 左右分屏被排成顶部上下短条，缺少内容高度 | `dockview-core@8.5.1` 的 ESM 入口不含基础 CSS；`.dv-view` 等依赖 CSS 绝对定位。包中没有独立 `.css` 文件，不代表不需要 CSS：匹配样式位于带样式 UMD 内。 | 构建时读取锁定版本的 CSS 字符串，保留 MIT，用 `@scope` 限于工作台。不执行或再打包一份 UMD 引擎。见 `tools/dockview-css.mjs`、`build.mjs:42`。 |
| BUG-05 / P2 | 重启后恢复已保存的面板，目录稍后才就绪，格子持续显示无法保留 | 宿主对未知 session 同步拒绝 retain。旧 effect 只依赖面板列表和回调；目录补齐不会再次尝试。 | 订阅目标会话在目录中的可用性变化，只补充缺失引用，保留现有引用/草稿。见 `src/workbench.tsx:336`。 |

宿主依据来自本机 `E:/deepseek-harness/resources/app.asar` 内：

- `/dsh/node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js`：`bindInjectSources` 在 424 行；`standardKit` 在 715 行；738 行按 children 契约提供 `SessionProvider`。
- `/dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/client.js`：`resolveTarget()` 对未知 session 抛错；`retain()` 同步取得引用，随后处理 opening。
- `/dsh/node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js`：中心栏为无定位的 flex/grid 项，AppFrame 为 relative。

## 2. 第二阶段已修复的宿主缺陷

### BUG-06 / P1：文件拖到 B，可能进 A

修复前的 `installDocumentDropEvents()` 为每个挂载视图注册 document 级监听。drop 只检查 `defaultPrevented`，没有检查落点属于哪一个会话。第一个注册的监听器会接收文件并消费事件，后面的正确目标反而跳过。原代码保存在 `evidence/bugfix-20261016/before-host-fixes/patched/`。

已执行真实补丁函数的隔离复现：先注册 A、再注册 B，向 B 的 DOM 派发合成文件 drop；实际接收者为 A。只使用合成文件名，没有上传文件或访问真实会话。

已修复：每个真实 Composer 注册自身 DOM 锚点，按实际 `data-conversation-session` 区域匹配唯一接收者，正确区分 Sidebar 内子会话；缺省回退只在分屏正文内。无归属/歧义/禁用目标不上传，仍阻止浏览器文件导航；veto、离开、结束和卸载都清理拖放状态。保留原生 `onAddFiles`、目录判定及单窗单 Composer 全页接收。实现见 `tools/patches/attachment-routing.mjs`（P-3d～P-3g），对应 F12/F15、W024、N12。

真实附件模块的 `apply()` → Composer 挂载 → DOM 事件 → 原生回调边界回归 **11/11**；历史版本 1/11，通过项为目录识别，10 项失败包含双监听顺序下的错投。结果见 [附件回归日志](evidence/bugfix-20261016/attachment-routing-after.txt)。

### BUG-07 / P1：切换焦点后另一格 Sidebar 消失

修复前的 Sidebar portal 只改变 DOM 放置位置，没有改变 Sidebar 视图集合的生命周期；`prune()` 仍移除非 selected、且无 `keepMounted` Tab 引用的 View。

已执行真实 `SidebarSessionView/SidebarSessionViews` 的隔离复现：A 仍处于挂载状态，选中 B 后，渲染源只剩 B；A 随其渲染根卸载释放。即使插件仍保留 A 的会话引用，也不会保留该 Sidebar View。带保活 Tab 的场景可能暂时掩盖问题。

已修复：所有已挂载分屏会话均持有独立 Sidebar View，与 selected 分离；监听真实 `sessions.list` 以恢复迟到目录；重入保护和等价快照抑制避免 retain/release 通知反馈。关闭或退出分屏时撤销该持有，保留原生 keepMounted Tab 及等待 React 卸载后释放语义；折叠不卸载。portal 以 sessionId 固定 key，插入/关闭前序会话不重挂载其他会话。实现见 `tools/patches/sidebar-retention.mjs`（P-2i～P-2o），对应 F03/F13、W014、N07。

真实类、effect、RightbarRoot/SessionView 和 React portal 回归 **8/8**；历史版本 0/8。仅移除 portal key 的负向实验可独立复现 C 的草稿 DOM 在插入 B 时被重建。结果见 [侧栏回归日志](evidence/bugfix-20261016/sidebar-retention-after.txt)。

以上两项的历史版本诊断（脚本已固定读取安装前备份，不检查当前修复版）：

```powershell
node tools/reproduce-host-gaps.mjs
```

结果见 [remaining-host-gaps.json](evidence/bugfix-20261016/remaining-host-gaps.json)。`reproduced: true` 表示缺陷被复现，不能解读成验收通过。

## 3. 验证证据与边界

| 检查 | 结果 / 边界 |
| --- | --- |
| TypeScript 类型检查 | 通过。 |
| 构建与客户端产物守卫 | 通过；DSH module-loader 包装、外部 React 和导出检查通过。 |
| 原布局状态机 | 17/17 通过。只证明纯状态逻辑，不证明真实 UI。 |
| rc.2 真实 renderer 回归 | 旧版 0/5（预期失败），修复版 5/5 通过。执行安装产物中的 SlotRegistry、SlotCore、scope/Factory 分发；结果见 [host-contract-results.json](evidence/bugfix-20261016/host-contract-results.json)。业务会话、Cordis effect 所有权及几何为隔离夹具，正文使用合成观察组件。 |
| 真实 Chrome + Dockview 几何 | 左/右、上/下、12px 间隔、容器缩放、样式不外溢、隐藏标签栏及普通状态透明分隔线通过。没有把该测试扩大解释为全部拖动/键盘验收。 |
| 附件模块回归 | 11/11。实际模块/Composer/原生目录函数，合成 DOM 拖放，不上传真实文件。 |
| 侧栏保活回归 | 8/8。实际类/effect/React portal，合成会话分配器和同步快照；快照及目录契约由本机 ASAR 核实。 |
| 宿主补丁一致性 | 28 个文件与重新生成结果一致；当前生成器应用 24 处修改。先隔离验证，再安装两份变化的 client.js。 |
| 本机安装 | 已安装；插件及 3 个宿主 profile junction 正确，实际文件哈希匹配候选。完整备份及专用 restore.ps1 见安装记录。 |
| 真实 Electron / 原生 Composer / 模型 / PTY | 本次未在正在运行的应用中操作，未进行端到端验收。合成 textarea 的 DOM 保留不等于 Lexical、中文输入法和真实发送均已验收。 |

布局复现数据（CSS 像素）：

| 场景 | 中心栏 | 工作台 / 面板 |
| --- | --- | --- |
| 修复前 | x=280, y=40, 600×760 | 工作台 x=0, y=0, 1200×800；两格都在 x=0，y=0/107。 |
| 仅补基础 CSS | 同上 | 两格可以左右排列，但工作台仍覆盖整个 frame。 |
| 两项布局修复完成 | 同上 | 工作台等于中心栏；左右两格 x=280/586，各 294×760，中间 12px。 |
| 中心栏缩至 400px | x=280, y=40, 400×760 | ResizeObserver 重新布局；所有格子仍限制在中心栏内。 |

复验命令（本机 PATH 中的 `node` 无法正常执行；本轮使用 DSH 自带 Node）：

```powershell
$taskNode = 'C:\Users\wanyexin\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $taskNode build.mjs
& $taskNode node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
& $taskNode tests/layout.test.mjs
& $taskNode tests/host-contract.test.mjs
& $taskNode tests/host-contract.test.mjs --before # 预期失败：证明旧版缺陷可复现
& $taskNode tests/workbench-layout.browser.test.mjs
& $taskNode tests/attachment-routing.test.mjs --patch-root patches/patched
& $taskNode tests/sidebar-retention.test.mjs --patch-root patches/patched
& $taskNode tools/check-client-bundle.mjs dist/client.js dsh-split
& $taskNode tools/apply-patches.mjs --check
```

## 4. 与压缩包功能范围的差距

ZIP 是规划和演示交付物，不含生产插件。四边停靠、整会话拖动、临时放大、几何比例持久化、完整快捷键/iframe 归属和窄屏投影等仍未在当前源码中实现或验收。`serialize()` 目前只保存面板表和焦点，`onGeometryChange()` 没有序列化 Dockview 布局树；刷新不能恢复用户调整的分屏方向和比例。

这些功能差距与本轮已修复的截图故障分别记录；没有把修复几处渲染错误当成完成 v5 的 36 个任务/24 项原生验收。

## 5. 基线、备份与文件状态

- ZIP SHA-256：`6b3d535d880eddf278e00668f035f72233a147bf6cacca411dbc1106db1f435b`。
- 本机 `app.asar` SHA-256：`983ca71114e6dfd353fc79af5a1f9481a250ee64c2a3c757673029b811b23bc2`；内含 DSH 包版本 `0.2.0-rc.2`。安装包不含 commit 证明，冻结 commit 仍是方案声明值。
- 安装前 `lib/client.js` SHA-256：`b958ad8240b2331998930bedbe1bfc86657be9b9776e216fd0697a4b8a990918`。
- 已安装的 `dist/client.js` / `lib/client.js` SHA-256：`8ecdbc972d5a4c7bf24a5b0eb0b8b7b5a82f1182b5bd61cc90edbe2e547b1053`。
- 附件与侧栏补丁哈希、实际 profile 路径、备份路径见 [install-receipt.json](evidence/bugfix-20261016/install-receipt.json)。
- 本轮修复前源文件保存在 [before](evidence/bugfix-20261016/before/)；当前目录不是 Git 仓库，未创建提交或 PR。
- 隔离 Chrome 测试使用独立临时 profile。自动审批拒绝清理临时目录，返回原因仅为 `blocked by policy`；保留目录，没有进一步尝试删除。

历史 `alignment-review.md` 的“挂载形状已完全核对”“无 CSS 即无需基础样式”等结论已被本轮实测推翻；以本报告和对应回归证据为准。
