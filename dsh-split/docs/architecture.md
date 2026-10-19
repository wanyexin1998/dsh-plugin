# 架构：单份 Dockview + 逐会话 SessionSurface

> 本文件于 2026-10-15 多 agent 审查后重写，对齐**实际实现**（`src/` + `patches/`）。
> 旧版描述的自研 StagePool/GridDom/CenterClaim 引擎与"面板 id 保持 null"路径已废止：
> 冻结方案 F02 规定一份外层 Dockview（W005 已验证 8.5.1），工作台占用插件的 `main` 键位，
> `activePanelId === 'dsh-split-workbench'`，宿主补丁只认 `data-dsh-plugin-main-host` 标记。
> 权威依据：冻结包 `engineering-tasks.md`、`docs/design/p1-interfaces.md`、`docs/host-change-decision.md`。

## 1. 体验不变量（与冻结规则对应）

1. **一份外层 Dockview**（F02）。每个 Panel 是一个完整会话，每个 Group 只装一个会话
   （新 Group 创建即 `locked: 'no-drop-target'` + `hideHeader: true`）。
2. **同 Session 全窗口唯一可编辑根**（F12）：`place()`/`deserialize()` 在数据层拒绝重复，
   每个会话只经 `conversation.content` 工厂渲染一次。
3. **聚焦不重挂会话**：聚焦只改 `focusedId` 并 `setActivePanel`（dockview 8.5.1 的
   `activePanel` 是只读 getter，赋值在严格模式抛错），引用与 React 根不动。
4. **移动/换边不重建内容**（W010/N05/N09）：几何变化只经过 Dockview 的公开移动 API；
   面板 id ↔ sessionId ↔ 引用三者解耦。
5. **隐藏不是关闭资源**（F13）：关闭一格 = 释放该会话的插件引用，不删会话、不调停止、
   不关终端 Tab；Sidebar 收起 = 宿主内 `display:none`，子树保持挂载。
6. **右侧栏跟随焦点格**（焦点同步见 §4.3）：聚焦新格时经 `uiWorkspace.openSession`
   把原生右栏切到该会话（右栏收起时不导航）。
7. **分屏唯一入口**：左侧逐会话菜单（F09）；已显示会话只定位（F10/N20）。

## 2. 模块与数据流

| 模块 | 职责 | 产物 |
| --- | --- | --- |
| `src/layout.ts` | 纯布局状态机：面板表、焦点、放置/关闭/移动/循环、序列化与防御性反序列化 | `dist/layout.mjs`（测试直用） |
| `src/client.ts` | 客户端半边：注入服务、布局 store（订阅/版本）、主宿主占领与标记契约、菜单注册、持久化 | 打进 `dist/client.js` |
| `src/workbench.tsx` | `main` 键位宿主组件：一份 DockviewComponent、逐面板 React portal、引用生命周期、聚焦同步 | 打进 `dist/client.js` |
| `src/styles.ts` | 插件自有样式（冻结 F04–F08/V01–V03 token） | 打进 `dist/client.js` |
| `src/index.ts` | 宿主半边（仅 name/inject/apply，保证 Loader 行可挂载浏览器半边） | `dist/index.js` |
| `patches/**` | M-A1 宿主补丁副本（原件哈希锁定 + 锚点重建，见 `patches/PATCHES.md`） | profile `link:` 覆盖 |
| `tools/**` | 产物守卫、补丁生成器、安装/卸载器（干跑默认、备份、回滚） | — |

### 2.1 活注入面契约（client ⇄ workbench）

`client.ts` 向 `main` 键位注入一个**活面**（非一次性快照）：

```
{ getPanels(), getFocusedId(), getPendingDirection(), isSidebarCollapsed(sid),
  subscribe(listener), getVersion(), hooks: { retain, onFocus, onClose, onToggleSidebar, onGeometryChange } }
```

- `update(next)`：换布局 → `version += 1` → `notify()` → 防抖持久化 → 重算标记。
- `hooks` 身份稳定（只建一次，闭包读当前 `layout` 变量）；`retain/release` 只出现在
  effect 体内，绝不进 state updater（updater 必须纯，否则宿主侧调用失败）。
- workbench 用 `useSyncExternalStore(subscribe, getVersion)` 订阅；版本号是稳定快照。

### 2.2 宿主补丁契约

- `data-dsh-plugin-main-host`（`<html>` 属性）：恰好当 `panelInfo.activePanelId === MAIN_KEY`
  时存在；插件卸载时由 effect 清理移除。补丁 P-1（ui-workspace 导航不夺宿主、
  ui-sidebar-right 右栏可见性）与 P-2d/e/f（PanelChrome 控件缺席）只读这个标记——
  标记缺失时行为与官方逐字节一致。
- `[data-dsh-sidebar-host="<sessionId>"]` + `dsh-sidebar-host-change` 事件：补丁 P-2c 把该
  会话的 Sidebar portal 进宿主，并按**宿主实测宽度**（`clientWidth`，响应窗口 resize 与
  宿主增删）下发 `width/viewportWidth/canShow`（W014 步骤 4）。
- P-3（ui-attachment 三处 `if (event.defaultPrevented) return;`）：尊重捕获阶段 veto，
  供 W024/N12 的拖放定向使用（插件侧定向未接，属 P3 遗留）。

## 3. 持久化（F14）

- 键：`dsh.split.workbench.v1`，仅存 `{ schemaVersion: 1, panels, focusedId }`。
  - 非 1 的 schemaVersion 整体拒绝；重复/空 id、重复会话、未知焦点全部丢弃（N16）。
  - `nonce` 不持久化（面板 id 内嵌 sessionId，不会碰撞）。
- 写入：变更防抖 200ms + `pagehide` 刷盘。
- **已知缺口（P3/W027）**：外层几何（Dockview `toJSON()`）、每会话 Sidebar 停靠边与比例、
  `<connectionScope>` 键后缀未实现 —— 见 `docs/alignment-review.md` §5。

## 4. 生命周期与安全

### 4.1 引用（retain/release）
首次出现在布局时 `ctx.sessions.retain(sid, { source: 'splitPane' })`；会话离开布局时
release；**仅卸载时**全量 release。布局变化用 diff 处理，绝不释放-重取未变会话（W010）。

### 4.2 激活安全
`apply()` 全程 try/catch（客户端条目激活失败会阻断整个 web boot，见
`docs/evidence/incident-20261015-probe-web-boot.md`）。`inject` 只声明真实存在的服务。

### 4.3 聚焦回声闸门
Dockview 的 `onDidActivePanelChange` 与同步 effect 都可能改写活动面板：`focusRef` 记录
已上报 id，两侧都只在"确实不同"时才行动，杜绝 ping-pong 冻结。

### 4.4 局部错误隔离
每个 Surface 的会话内容包在 `SurfaceBoundary` 里（W010：一格崩溃不影响其他格）；
Dockview 创建失败只显示错误态，不拖垮插件。

## 5. 已知差异与演进路线

- `docs/alignment-review.md`：审查结论、遗留风险（portal 侧栏尺寸语义已由 P-2c 修正；
  竞态防护、几何持久化、拖放定向、最大化仍属 P2/P3）。
- `docs/refactor-plan.md`：**已废止**（与冻结 Dockview 路线冲突），保留仅作历史记录。
