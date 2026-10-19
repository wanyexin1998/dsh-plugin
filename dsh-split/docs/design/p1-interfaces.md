# P1 接口规格（设计稿，**G0 通过前不落代码**）

**冻结基线**：`DSH-SPLIT-V5-FROZEN-20261015`　**宿主**：`dsh 0.2.0-rc.2`
**依据**：`docs/design/p1-skeleton.md`（模块职责）+ 方案 §04.3（状态归属）+ 本轮已核实的宿主契约
**用途**：G0 放行后按本文件机械落地；每个接口都标注它服务哪条冻结规则与哪个工程任务。

## 0. 四条硬约束（从一手证据得出，写代码前必须内化）

0. **客户端产物必须自带模块加载器外壳**（2026-10-15 事故教训，见
   `docs/evidence/incident-20261015-probe-web-boot.md`）：加载器把 `client.js` 原样服务给浏览器，`require`/`module`/`exports`
   只存在于工厂闭包里（模板见 `dsh-client-modules/lib/client.js:3-6`）。产物必须形如
   `window.__ModuleLoader__.load({ id, factory: (require) => { var module = { exports: {} }; var exports = module.exports; … ; return module.exports } })`。
   缺少外壳 → 浏览器按 ES module 求值 → `require is not defined` → 条目激活失败 → **整个窗口打不开**。
   构建脚本生成它，dry-run 守卫断言它；P1 的 `src/` 构建沿用同一条规则。

1. **绝不挂第二份可编辑呈现**（F12）：`ComposerContentEditable` 的 `editor.setRootElement(el)`（`ui-conversation/lib/client.js:16557`）
   会把唯一 Lexical 编辑器**搬**到最新宿主，且**卸载不会自动夺回**（`:16559` 只清空绑定）。⇒ 一个 `sessionId` 在一个窗口内只有一个呈现宿主；
   "只读镜像"不可实现（composer 由 content factory 无条件渲染）。
2. **`main` 键位的归属不被导航改写**（P-1）：`ui-workspace` 在 `reveal` 导航与 `clearMain` 里调用 `ctx.layout.selectPanel(null)`
   （`ui-workspace/lib/client.js:969,993`）⇒ 插件占着 `main` 时，用户点侧栏会话不应把工作台顶掉（补丁范围）。
3. **Sidebar 的可见性与几何必须逐宿主**（P-2）：现行 `active = visible && view.selected`、`visible = panelInfo.activePanelId === null`
   是全局门（`ui-sidebar-right/lib/client.js:5873-5880`），`width/viewportWidth/canShow` 来自帧右轨（`:5849-5866`）。

## 1. `workbench/`（外层：一份 Dockview）

```ts
export interface WorkbenchHost {
  readonly element: HTMLElement
  addSession(sessionId: string, opts?: { referencePanelId?: string }): string   // → panelId
  move(panelId: string, target: { referencePanelId: string; direction: 'left'|'right'|'above'|'below' }): void
  remove(panelId: string): void
  maximize(panelId: string): void
  exitMaximized(): void
  focus(panelId: string): void
  snapshot(): WorkbenchSnapshot        // toJSON() 的受控子集
  restore(snapshot: WorkbenchSnapshot): void   // 仅初次加载/显式重置/错误恢复
  dispose(): void
}
export function createWorkbenchHost(options: {
  element: HTMLElement
  renderSurface: (panelId: string, host: HTMLElement) => void   // 由 session-surface 提供
  onEvent: (event: WorkbenchEvent) => void
}): WorkbenchHost
```

- 引擎配置**只用**已验证的受限集合（`docs/evidence/dockview-version.md` §2）：组件选项 + 组级 `locked: 'no-drop-target'`、`hideHeader: true`。
- **禁止**：popout、浮动、标签合并、edge group、`fromJSON` 做普通操作。
- 身份规则：`panelId` 是几何身份，`sessionId` 是业务身份，二者不互相派生（方案 §04.3）；移动只走 `move()`，绝不 remove+add。
- 服务：W009（单一主内容宿主）、W015/W016（整会话移动与透明调尺寸）、N05/N09。

## 2. `session-surface/`（内层：每会话 CSS 分栏）

```ts
export type SidebarSide = 'left' | 'right' | 'top' | 'bottom'
export interface SidebarPlacement { side: SidebarSide; horizontalRatio: number; verticalRatio: number }

export interface SessionSurface {
  readonly panelId: string
  readonly sessionId: string
  setSidebarPlacement(placement: SidebarPlacement): void   // 只改 Grid 区域，不搬 DOM 父节点
  setSidebarVisible(visible: boolean): void                // 收起只隐藏，不清空 Tab 记录
  focus(): void                                            // 只切轻灰遮罩，不重建会话、不重开 Sidebar
  dispose(): void
}
export function createSessionSurface(options: {
  panelId: string
  sessionId: string
  host: HTMLElement
  adapter: Adapter
  onIntent: (intent: SurfaceIntent) => void                // 拖动/换边/分隔条意图，提交前由 workbench 复核
}): SessionSurface
```

- 结构固定为「标题条（自绘）+ 正文 + 分隔条 + Sidebar 宿主」；换边只改 CSS Grid 的 `grid-template-areas`/比例变量。
- 视觉：会话与 Sidebar 共享 `--session-radius`（初值 12px）；会话外壳**无边框、无阴影**；非当前会话用**独立伪元素**极淡遮罩，
  `pointer-events: none`，**不得**用根 `opacity`/`filter`/`inert`（方案 §02.2）；会话间**不画分割线**（保留命中区、光标、双击均分）。
- 服务：W010（唯一会话呈现）、W014/W017/W018（Sidebar 四边停靠）、W019/W020（v5 视觉与轻灰聚焦）、F05/F06/F08。

## 3. `dsh-adapter/rc.2/`（唯一接触宿主的目录）

```ts
export interface Adapter {
  retain(sessionId: string): SessionReference                       // source: 'splitPane'
  openSession(sessionId: string): void                              // 应用级导航（跟随右侧栏用）
  currentSessionId(): string | undefined                            // uiSession.adapter.current / panelInfo
  panelId(): string | null                                          // ctx.layout.panelInfo.activePanelId
  selectPanel(key: string | null): void
  sidebarExpanded(sessionId: string): boolean
  toggleSidebar(sessionId: string): void
  uploadFile(sessionId: string, file: File): Promise<void>          // ctx.fileUpload.upload(sessionId, …)
  addAttachments(sessionId: string, ids: string[]): void            // 会话作用域 inputActions
  menuSeat(): void                                                  // sidebar.workspaces.session.menu.item
  commandTarget(): unknown                                          // 捕获+复核（isTargetCurrent 形态）
}
```

- 会话内容一律走 `SessionProvider` + `renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero: false })`，
  **不替换 `views`**（换来原生 View/Composer/附件/审批/菜单）；每格标题条自绘（`conversation.header` 归 `main.conversation` 独占）。
- 席位注册全部经 `ctx.slots.inject(...)`；注册/释放成对，插件卸载不留监听与屏障。
- 服务：W010、W011–W013、W023–W026、F15。

## 4. `persistence/`（只存外层 + 逐会话 Sidebar 停靠）

```ts
export interface Snapshot {
  schemaVersion: 1
  hostBaseline: string            // 'dsh 0.2.0-rc.2'
  engineVersion: string           // 'dockview 8.5.1'
  panels: Array<{ panelId: string; sessionId: string }>   // 去重、去草稿
  layout: WorkbenchSnapshot
  sidebar: Record<string, SidebarPlacement>               // 按 sessionId
}
export function load(): Snapshot | null                  // 校验类型/深度/重复/畸形，失败即 null（内存兜底）
export function migrateLegacy(raw: unknown): Snapshot | null   // 只迁移可验证且去重的会话引用（旧 dsh.split.v1）
export function save(snapshot: Snapshot): void           // 防抖提交 + 结束时 flush；失败只提示，不阻塞
```

- 键：`dsh.split.workbench.v1.<connectionScope>`；**不写**原生 key（`dsh.sidebar-right.v1.<sessionId>` 只读不动）。
- 恢复顺序：宿主身份就绪 → 校验快照 → 准备引用 → 唯一性校验 → 采用原生 Sidebar 已存状态 → 一次恢复外层布局 → 报告真实可见范围。
- 服务：W027/W028、F14、N16。

## 5. 交互与命令（`client.ts` 装配层）

| 动作 | 路径 | 约束 |
| --- | --- | --- |
| 分屏唯一入口 | `sidebar.workspaces.session.menu.item` 两项（向右/向下） | 目标=行身份；锚点=捕获的当前会话；已显示→"定位此会话"并禁用分屏；空间不足/放大→禁用并说明（F09/F10） |
| 打开/取消菜单 | 不调 `openResource`/`openTab` | 原布局与活动会话不变（F10） |
| 点击会话 | 已显示→只定位；未显示→在当前明确激活的窗口内切换 | 不自动建标签组（§3.1） |
| 拖动 | 标题条空白/把手；阈值后才进入拖动；Esc/pointercancel 取消 | 松手才提交一次移动；不拖系统窗（F11、N13/N14） |
| 分隔条 | 每帧最多一次几何更新；松手提交 | 不画分割线；双击均分（F06） |
| 快捷键 | `Ctrl+]`/`Ctrl+[` 环绕焦点；`Ctrl+Alt+\`/`Ctrl+Alt+-`；`Ctrl+Alt+W`；`Ctrl+Alt+方向键` | 命令面**无会话维度**，一律用捕获身份 + 复核（A-1、F12） |
| 文件拖放 | 外层捕获阶段拦截 → 定向到所属会话 `uploadFile` + `addAttachments` | 补丁前为自律路径，补丁后走原生路由（F15、N12） |

## 6. 验收映射（P1 起可用）

| 不变量 | 校验手段 |
| --- | --- |
| 唯一编辑根 | 只看 `[data-lexical-editor="true"]` 的数量与所属宿主（一手证据见 §0.1） |
| 目标不漂移 | 异步动作携带 `{panelId, sessionId, epoch}`，提交前复核；过期即丢弃 |
| 移动 ≠ 销毁 | 移动前后比对组件 DOM 节点身份（Node 夹具已验证该方法可行） |
| 隐藏 ≠ 结束 | 收起 Sidebar / 隐藏视图后，`ctx.sidebarRight.openTabs` 与终端进程不变 |
| 单一宿主 | 一变二、二变一不重建宿主；`selectPanel` 集合不变 |
