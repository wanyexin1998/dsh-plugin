# 全盘审查与冻结包对齐报告（2026-10-15 第二轮）

> 2026-10-16 后续复核：下文为历史审查记录。本轮真实 rc.2 renderer 和浏览器测试发现其关于回调注入、会话作用域及 Dockview 样式的部分结论不成立。当前修复状态、剩余缺陷与验证边界见 [故障检查报告](bug-report-20261016.md)；不要把下文历史通过项作为本轮原生验收证据。

**审查范围**：`src/`（client / workbench / layout / styles / index）、`patches/`、`tools/`（守卫、安装器、补丁生成器）、构建与测试链。
**对齐基准**：`DSH-SPLIT-V5-FROZEN-20261015` 的 `engineering-tasks.md`（W001–W036、F01–F16、N01–N21 / V01–V03）。
**结论**：本次审查发现并修复 **9 个 bug / 缺陷**；冻结包逐条对齐结论见下文矩阵。仍缺 P2/P3 的大部分交互任务（W015–W017、W020–W022、W024–W026）与全部真实环境验收证据（N 矩阵）。

---

## 1. 本次审查发现并修复的问题

| # | 位置 | 问题 | 修复 |
| --- | --- | --- | --- |
| B1 | `src/client.ts` / `workbench.tsx` | **工作台挂载后不再刷新**：注入面是一次性快照，`notify()` 没有任何订阅者 → 挂载之后的任何分屏/关闭/聚焦都不生效 | 注入面改为**活面**（`getPanels/getFocusedId/getPendingDirection/subscribe/getVersion` + 稳定 `hooks`），工作台用 `useSyncExternalStore` 订阅 |
| B2 | `src/workbench.tsx` | **方向丢失**：`pendingDirection` 被设置但从未被读取，`向下分屏` 实际总是向右 | 同步 effect 读 `face.getPendingDirection()`，逐面板按用户所选方向放置 |
| B3 | `src/workbench.tsx` | **会话引用在卸载时泄漏**：retain effect 没有清理函数，退出工作台后引用永不释放 | effect 返回清理，卸载时释放全部引用 |
| B4 | `src/workbench.tsx` | **面板关闭后 portal 槽残留**（`dispose: () => {}` 空实现） | `dispose` 同步移除槽位，杜绝指向已死面板的 portal |
| B5 | `src/workbench.tsx` | **每次点击（含输入框打字）都触发聚焦** → 布局 churn + 侧栏导航 | `onPointerDown` 增加"已聚焦则忽略"闸门（F05：首次点击仍能聚焦） |
| B6 | `src/client.ts` | **已显示会话被置灰而非定位**，违反 F10/N20（"已显示 B 只定位，不复制"） | 菜单行改为 `定位此会话`，点击走 `reveal` + 选中工作台，不复制、不导航 |
| B7 | `src/client.ts` | 死代码：空生命周期 effect、未用的 `options` 参数、未用的 `shortcuts` 注入 | 全部移除；`inject` 收敛为实际使用的 7 个服务 |
| B8 | `tools/workbench-install.mjs` | **卸载回滚会失败**：旧备份目录名带尾随点，Windows 规范化后 `cpSync` 找不到路径；恢复失败还会留下被删空的 `lib/` | 优先从 `lib.legacy`（原实现的干净副本）恢复；`\\?\` 前缀兜底；失败时给出明确恢复指引 |
| B9 | `tools/probe-install.mjs` | 备份文件名尾随点（同样的 Windows 路径陷阱） | 时间戳去掉尾随点 |
| B10 | `tools/check-client-bundle.mjs` | 求值桩对 `class extends React.Component` 不兼容（`__toESM` 拷贝 + 桩无自有属性） | 桩的 `construct` 返回普通对象；插件源码改用 esbuild 标准 default 导入（真实运行时行为不变） |

**审查中确认无误的项**（曾是最可能出错的地方，逐一核对了真身）：

- 会话挂载形状与探针 W003-b 实测**逐字一致**（`SessionProvider session={reference}` + `renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'settling', hero: false })`）✔
- Dockview 四个受限选项（`singleTabMode`/`disableFloatingGroups`/`hideBorders`/`noPanelsOverlay`）都在 8.5.1 的 `options.d.ts` 里 ✔
- `ctx.sessions.retain(sessionId, { source: 'splitPane' })`、`ctx.uiWorkspace.openSession`、`ctx.sidebarRight.isExpanded` 与旧实现（已验证可用）完全一致 ✔
- 宿主补丁（P-1×4 / P-2×5 / P-3×3，共 12 处编辑）经"原件哈希 + 锚点 + 解析 + 逐行零丢失"复核 ✔

---

## 2. 冻结规则对齐（F01–F16）

| 规则 | 状态 | 说明 |
| --- | --- | --- |
| F01 宿主 rc.2 锁定 | ✅ | `docs/baseline.md`；补丁按哈希验证的 rc.2 原件生成 |
| F02 一份 Dockview / 一 Panel 一 Group 一会话 | ✅（设计保证） | `place()` 拒绝重复会话；dockview 每面板独立组、无标签条（CSS 隐藏 + `singleTabMode`） |
| F03 会话内正文＋一块原生 Sidebar，四边停靠 | 🔶 | 每会话原生 Sidebar 经 P-2 portal 就位；**四边停靠未实现（W017）** |
| F04 同圆角 12px、无边框无阴影 | ✅ | `styles.ts`（初值 12px；外壳无 border/shadow） |
| F05 极淡灰层、不拦首次点击、无厚焦点框 | ✅ | `bg-base` 5.5% 遮罩 + `pointer-events: none` + 聚焦闸门 |
| F06 会话间不画分割线 | ✅（待视觉复核） | dockview-core 8.5.1 **不带任何 CSS**（冻结包内无 .css 文件），引擎不绘制分割线；真实外观待 N/V 验收 |
| F07/V02 侧栏标题右上角无两个额外图标 | ✅ | 补丁 P-2d 组件级 `return splitView ? null : …`（不向 Tooltip 传 null）；单窗口原生右栏不受影响 |
| F08 侧栏细边框＋静态轻阴影 | 🔶 | 沿用原生样式；宿主内精细调整未做 |
| F09 分屏唯一入口为左侧会话菜单 | ✅ | 仅注册 `sidebar.workspaces.session.menu.item` 两项 |
| F10 打开/取消不导航；已显示只定位 | ✅ | 本次修复 B6 后满足；"无参照/放大时禁用并说明"待 W013/W022 |
| F11 拖会话整体移动 | ❌ | 未实现（W015，P2） |
| F12 同会话唯一可编辑根 | ✅（设计） | 数据层拒绝重复；每会话只渲染一次 |
| F13 隐藏/移动不关资源；关闭走原生规则 | ✅（部分） | 关闭=释放引用、不删会话、不调停止；真实验收待 N07/N08 |
| F14 只持久化外层与 Sidebar 比例 | 🔶 | 目前持久化面板表与焦点；**Dockview 几何与 Sidebar 比例未持久化（W027）** |
| F15 保留原生 View/附件/审批/provider | ✅（设计） | 走 `conversation.content` 原生工厂，无删减 |
| F16 不新增禁止项 | ✅ | 无标签组/全局侧栏/popout/模板库/布局协同 |

---

## 3. 工程任务状态（W001–W036）

| 任务 | 状态 | 备注 |
| --- | --- | --- |
| W001–W007（P0 契约与授权） | ✅ | G0 有条件通过（`docs/gates/P0.md`）；三补丁全批授权 |
| W008 干净工程与装配 | ✅ | `src/` + esbuild + tsc + 守卫；产物 `dist/`，`lib/` 仅产物 |
| W009 单一主内容宿主 | 🔶 | `main` 键位宿主 + 标记契约；1→2→1 不重建待真机验证 |
| W010 稳定 SessionSurface 与引用 | 🔶 | 引用按需 retain/release；本次补错误边界与卸载释放 |
| W011 目录菜单右/下分屏 | ✅ | 唯一入口；本次补定位语义 |
| W012 分屏异步事务 | 🔶 | 基本顺序流程；**无 epoch/过期拒绝**（竞态防护待补） |
| W013 关闭/放大/恢复 | 🔶 | 关闭→释放→归零回单窗口；**临时放大未实现** |
| W014 显式绑定原生 Sidebar | 🔶 | P-2 portal 宿主就位；**宿主尺寸报告未做**（viewport 仍按右栏轨道） |
| W015 四方向整会话移动 | ❌ | P2 |
| W016 无分割线调尺寸 | ✅（待视觉复核） | 见 F06 |
| W017 Sidebar 四边停靠 | ❌ | P2 |
| W018 Sidebar 标题与收起入口 | 🔶 | 两个额外图标已隐藏；**标题拖动/方向菜单未实现** |
| W019 圆角/轻灰/轻阴影 | ✅ | F04/F05 落地；阴影沿用原生 |
| W020 焦点路由与 iframe 归属 | ❌ | P2 |
| W021 手势取消与拖窗边界 | ❌ | P2 |
| W022 窄屏投影与空间不足 | ❌ | P2 |
| W023 原生 View/Header/浮层保留 | 🔶 | 按原生工厂呈现；未专项验证 |
| W024 附件/粘贴/拖放保留 | 🔶 | **P-3 钩子已就位**（`defaultPrevented` 三守卫）；插件侧定向未实现（N12 尚不满足） |
| W025 发送/审批/快捷键/关闭对齐 | ❌ | P3 |
| W026 provider 隐藏/移动/关闭语义 | ❌ | P3 |
| W027 布局持久化与校验 | 🔶 | 面板表已持久化（新存储键，带防御性反序列化）；几何未存 |
| W028 安全恢复与旧布局迁移 | ✅ | 新存储键独立于旧插件；坏数据丢弃不崩溃 |
| W029 启停/HMR 清理/回退 | 🔶 | 安装器含备份/回滚（本次加固）；HMR 未专项处理 |
| W030 自动化契约测试集 | 🔶 | 布局 17 项、产物守卫、补丁生成器自校验；缺组件级测试 |
| W031–W034 | ❌ | 真机/视觉/性能/对抗性验证未执行 |
| W035 安装与回滚说明 | 🔶 | `tools/workbench-install.mjs` 干跑/安装/卸载 + 回滚路径 |
| W036 最终放行 | ❌ | 依赖上述各项 |

---

## 4. 原生验收矩阵（N01–N21 / V01–V03）

当前**全部为"待验证"**（未在真机复测本次修复）。代码侧已具备/仍缺的对应关系：

| 用例 | 代码侧状态 |
| --- | --- |
| N01（1→2→1 同宿主无竞争编辑根） | 结构就位；待真机 |
| N20（打开/取消 B 菜单零变化；已显示不重复） | ✅ 本次修复（定位语义） |
| N12（一次拖放仅一个接收目标） | ❌ 只有补丁钩子，插件侧定向未接 |
| N05/N09/N15/N19/N21 | 未实现或未验证（对应 W015/W017/W022/W019/W012） |
| V01（分割线全不可见） | 代码侧成立（引擎无 CSS）；待视觉复核 |
| V02（两个额外图标缺席） | ✅ 本次实现（宿主内 CSS 隐藏） |
| V03（仅侧栏静态轻阴影） | 🔶 沿用原生，未专项调整 |

---

## 5. 遗留风险与下一步建议

1. **P-2 portal 侧栏的尺寸语义**：`RightbarRoot` 仍以框架右栏的 `width/viewportWidth` 下发 → 嵌入格内时"两格判断"可能读到错误空间（W014 步骤 4）。建议下一轮在补丁中按宿主元素实测宽高下发改值。
2. **W012 竞态防护**：无 epoch/过期拒绝；快速连点与迟到回调按顺序执行，暂不满足 N21 的对抗性要求。
3. **Dockview 几何持久化**：`onDidLayoutChange` 只持久化面板表；需序列化 dockview `toJSON()` 并防御性恢复。
4. **W024/N12 拖放定向**：需先确定"把文件投递给指定会话 composer"的公开路径（`ui-attachment` 的 `onAddFiles` 是内部实现）；若不存在，需追加一次宿主授权。
5. 全部 N 矩阵条目仍需按 `engineering-tasks.md` §05 的证据格式在真机取证。

**构建与校验（本次审查后）**：`tsc` exit 0 ✔ · 产物守卫 PASS（含 apply/inject 真求值）✔ · 布局测试 17/17 ✔ · 守卫自检 PASS ✔ · 补丁生成器 `--check` ✔ · 安装器干跑 PASS ✔。

---

# 附：第二轮对抗复查结果（2026-10-16）

第二轮（交叉对抗：前端 flash 验证后端主张、后端 pro 验证前端主张）结论 **REJECT**，发现 2 blocker + 6 major + 若干 nit，全部已修复。修复与现状：

| 第二轮发现 | 修复 |
| --- | --- |
| R2-01 Tooltip 收到 `null` 子节点崩溃 | P-2d 改为**组件级** `return splitView ? null : jsxs(...)`（不再向 Tooltip 传 null） |
| R2-02 边框/阴影画在 `display:contents` 节点上永不生效 | 宿主改为**真实盒子**（`position:relative; width:320px; max-width:45%; overflow:hidden`），border/radius/shadow 直接画在宿主上 |
| R2-03/P2C-ZERO-WIDTH 宿主宽度结构为 0 → 100vw 全屏循环 | 宿主 CSS 定宽（320px）+ P-2c 在 `clientWidth===0` 时回退 `props.width`；`viewportWidth` 保持应用视口（保住 `autoFullscreen<768` 启发式） |
| R2-04 暗色 token 跟随错误信号 | 改为 `body[data-ds-dark-theme] [data-dsh-split-workbench]`（跟随应用内 Appearance 偏好） |
| R2-05/FIRST-GROUP-HEADER 首格标签条未隐藏 | 首组事后 `group.header.hidden = true` + 恢复 `.dv-tabs-and-actions-container{display:none}` 兜底 |
| R2-06 圆角被同色 groupview 盖住 | 移除 groupview 背景绘制（圆角由 surface 自身呈现，对比度取决于宿主画布） |
| R2-07 标题栏顺序与芯片样式 | 恢复 grip→letter→title 顺序；芯片 `border:0; background:interactive-bg-hover`；grip hover 提亮 |
| R2-08 侧栏开关 | 冻结 SVG 图标 + `aria-pressed` + **P-2g**（宿主内呈现时 `shown` 不受原生 `expanded` 约束，显隐由插件拥有） |
| R2-09 菜单语义 | 恢复冻结组成：独立「定位此会话」行（仅已显示会话出现）+ 两个固定文案分屏行，**已显示/自拆分/无参照时禁用**（不静默改行为） |
| R2-10 几何重测 | `onGeometryChange` 100ms 合并后派发 `dsh-sidebar-host-change` |
| REMOVE-LIVE-ARRAY | 删除循环遍历 `[...(api.panels ?? [])]` 副本 |
| STRICTMODE-REBIND / 首帧占位闪烁 | retain 移入 `useLayoutEffect`（首帧前完成，无占位闪烁） |
| P2C-SELECTOR-INJECTION | `CSS.escape(view.sessionId)` |
| OE-R2-01..04 | 未用类名清理、theme 标识注释、face 去掉未消费的 `ctx`、`:empty` 死规则删除 |
| R2-B02 --check 无法发现手改 | `--check` 现在**在临时树重建并逐字节比对** `patches/patched/**`（28 文件） |

**明确记录的未实现项（不静默）**：MIN-11 会话删除订阅（N16/P3）；`<connectionScope>` 存储键后缀（需确认连接作用域来源，属待确认项）；W013 临时放大（证据：`docs/gates/P0.md` 记录真机 `maximizeGroup` 抛 `parentElement`）；W020 iframe 焦点桥（P2）；自拆分"新格留空"草稿格（冻结 §20，需先定草稿模型）；菜单禁用原因文案（宿主原语 API 未知）；标题状态槽（demo 的 title-status 无数据源，未实现）。


---

# 附：第三轮终验结果（2026-10-16）

后端（pro）**ACCEPTED**：全部修复主张核实，仅 1 minor + 文档 nit。前端（flash）再抓 1 blocker + 2 major，已修复：

| 第三轮发现 | 修复 |
| --- | --- |
| F-01（blocker）P-2g 把原生右栏轨道撑开成 ~45% 空白列 | P-2g 语义反转：分屏期间 frame 呈现 `shown=false`（轨道关闭、无拖拽把手），内容只在格内宿主呈现；回单窗口原生恢复 —— 这正是 W014/P-2「内容与 frame 呈现分离」 |
| F-02（major）收起后 resize 的 stale 宽度 | `onToggleSidebar` 现在会触发合并的 `dsh-sidebar-host-change` 重测（320px 宿主立即重读） |
| F-03（major）格内 body 仍被原生 `expanded` 门控滑出 | 新增 P-2h：宿主内呈现时 `data-sidebar-right-open/aria-hidden` 以插件显隐为准（F07 单一事实来源） |
| F-04（minor）canShow 无条件覆盖 | `canShow: host === null ? props.canShow : true`（无宿主路径与官方逐字一致） |
| F-05/F-06 + 后端 nit | 文档口径统一（编辑数 12、测试 17、face 无 ctx）、芯片 muted/焦点 ink、窄屏隐藏 grip、定时器 dispose 清理、splitFor 提交时复查（已显示→定位） |

**注意**：F-01 意味着分屏期间原生右栏（frame 轨道）是关闭的 —— 每会话 Sidebar 只存在于各自格内（F03）。若在真机上这不符合你的预期（例如你希望保留一条跟随焦点格的右栏），告诉我，这属于可在 P-2 授权范围内再调整的呈现策略。
---

# 附：用户实机确认的两处缺陷修复（2026-10-16）

用户以安装版宿主代码/CSS 证据确认：

| # | 缺陷 | 根因（宿主证据） | 修复 |
| --- | --- | --- | --- |
| 1 | 分屏会话**永久 settling**，整个输入区隐藏 | 宿主 `ConversationRoot.module.css`：`[data-content-phase=settling] .composerSeat{visibility:hidden}`；调用方把 `phase:'settling'` 写死 | `src/workbench.tsx` 复刻宿主 `ConversationMainPanel` 的推导：`conversationPhase()`（active/engaging/blank）→ settling（加载中）/ hero（空白会话，布尔）→ active（已加载）；`hero` 参数改为**布尔**（与主面板一致，不再是 `hero:false`）。探针 `probe/src/probe.js` 的第二份呈现同步改为推导 |
| 2 | 探针第二份呈现抢占同一 Lexical editor，卸载后原绑定不恢复 | 两份 `ComposerContentEditable` 共用实例；copy 挂载 `setRootElement(copyEl)`、卸载 `setRootElement(null)`，原生 effect 不重跑 | 利用 Lexical 在根元素上的 **`__lexicalEditor` 实例回引**：open 时捕获原生根+实例；close 时 `editor.setRootElement(原生根)` 恢复所有权。验收改为实例级：`editor.getRootElement() === 原生根` + 人工输入确认，不再只数 DOM/看 isConnected |

证据链：宿主 `ui-conversation` 客户端产物 15792-15794（conversationPhase）、16011-16017（settling/hero/phase 推导）、15797/…（settling 隐藏 CSS）、9273-9286（setRootElement + `__lexicalEditor` 回引）、16552-16561（ComposerContentEditable 绑定/解绑）。
注：2→1（关到只剩一格）按 N01 语义**留在工作台**（同一宿主），修复后该状态输入区同样可见 ✔。
