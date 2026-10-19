# 补丁记录（M-A1：原件 + 最小差异）

**生成方式**：`node tools/apply-patches.mjs`（每次从 `patches/originals/**` 重建，原件哈希先校验、锚点缺失即中止、产物用 esbuild 解析校验）。
**标记契约**：插件占用主内容宿主期间在 `<html>` 上设 `data-dsh-plugin-main-host`；补丁只认这个标记，不认插件名。

## 已应用

| # | 包 | 文件 | 改动 |
| --- | --- | --- | --- |
| P-1a | `dsh-client-ui-workspace` | `lib/client.js` | clearMain() 不再把面板选择强拉回会话界面（插件占用 main 键位时） |
| P-1b | `dsh-client-ui-workspace` | `lib/client.js` | reveal 导航不再把面板选择强拉回会话界面 |
| P-1c | `dsh-client-ui-sidebar-right` | `lib/client.js` | 插件占用主内容宿主期间右栏保持可见（原判定只看 activePanelId === null） |
| P-1d | `dsh-client-ui-sidebar-right` | `lib/client.js` | 侧栏控制器的 show() 用同一判定，否则轨道被释放 |
| P-3a | `dsh-client-ui-attachment` | `lib/client.js` | 尊重捕获阶段的 veto（插件拦截本次拖放） |
| P-3b | `dsh-client-ui-attachment` | `lib/client.js` | 同上：不显示"可放下"覆盖层 |
| P-3c | `dsh-client-ui-attachment` | `lib/client.js` | 本次放下已由插件定向到一个会话，原生 intake 不再处理 |
| P-2a | `dsh-client-ui-sidebar-right` | `lib/client.js` | SessionView 接受 hosted：宿主内呈现的会话侧栏不受"只显示前台"判定约束 |
| P-2b | `dsh-client-ui-sidebar-right` | `lib/client.js` | hosted 时按会话自身是否在屏判定 active（每格一块侧栏同时可见） |
| P-2c | `dsh-client-ui-sidebar-right` | `lib/client.js` | 每会话侧栏 portal 进 [data-dsh-sidebar-host="<sessionId>"]（CSS.escape 防注入），按宿主实测宽度下发 width（0 宽回退轨道宽度），viewportWidth 保持应用视口以保住 autoFullscreen 启发式；响应 dsh-sidebar-host-change 与窗口 resize |
| P-2d | `dsh-client-ui-sidebar-right` | `lib/client.js` | F07/V02：分屏视图下 PanelChrome 整体不渲染（返回 null 于组件级，绝不把 null 传进 Tooltip 子节点） |
| P-2g | `dsh-client-ui-sidebar-right` | `lib/client.js` | W014/P-2「内容与 frame 呈现分离」：分屏期间 frame 右栏轨道不再打开（内容已 portal 进各会话宿主），回到单窗口时原生行为原样恢复 |
| P-2h | `dsh-client-ui-sidebar-right` | `lib/client.js` | F07：宿主内呈现时侧栏内容的显隐由插件拥有（data-dsh-sidebar-collapsed），不再被原生 expanded 状态滑出屏幕 |

## 逐条差异

### P-1a — clearMain() 不再把面板选择强拉回会话界面（插件占用 main 键位时）

```diff
- 				this.ctx.layout.selectPanel(null);
+ 				if (!document.documentElement.hasAttribute("data-dsh-plugin-main-host")) this.ctx.layout.selectPanel(null);
```

### P-1b — reveal 导航不再把面板选择强拉回会话界面

```diff
- 				if (panel === "reveal") this.ctx.layout.selectPanel(null);
+ 				if (panel === "reveal" && !document.documentElement.hasAttribute("data-dsh-plugin-main-host")) this.ctx.layout.selectPanel(null);
```

### P-1c — 插件占用主内容宿主期间右栏保持可见（原判定只看 activePanelId === null）

```diff
- const visible = usePanelInfo((info) => info.activePanelId === null);
+ const visible = usePanelInfo((info) => info.activePanelId === null || document.documentElement.hasAttribute("data-dsh-plugin-main-host"));
```

### P-1d — 侧栏控制器的 show() 用同一判定，否则轨道被释放

```diff
- show(layout.panelInfo.getSnapshot().activePanelId === null ? selected?.sessionId : void 0);
+ show(layout.panelInfo.getSnapshot().activePanelId === null || document.documentElement.hasAttribute("data-dsh-plugin-main-host") ? selected?.sessionId : void 0);
```

### P-3a — 尊重捕获阶段的 veto（插件拦截本次拖放）

```diff
- 			const onDragEnter = (event) => {
- 
+ 			const onDragEnter = (event) => {
+ 				if (event.defaultPrevented) return;
+ 
```

### P-3b — 同上：不显示"可放下"覆盖层

```diff
- 			const onDragOver = (event) => {
- 
+ 			const onDragOver = (event) => {
+ 				if (event.defaultPrevented) return;
+ 
```

### P-3c — 本次放下已由插件定向到一个会话，原生 intake 不再处理

```diff
- 			const onDrop = (event) => {
- 
+ 			const onDrop = (event) => {
+ 				if (event.defaultPrevented) return;
+ 
```

### P-2a — SessionView 接受 hosted：宿主内呈现的会话侧栏不受"只显示前台"判定约束

```diff
- 		function SessionView({ view, visible, SessionProvider, renderSlot, mountView, width, viewportWidth, canShow }) {
+ 		function SessionView({ view, visible, hosted, SessionProvider, renderSlot, mountView, width, viewportWidth, canShow }) {
```

### P-2b — hosted 时按会话自身是否在屏判定 active（每格一块侧栏同时可见）

```diff
- 			const active = visible && view.selected;
+ 			const active = hosted === true ? true : visible && view.selected;
```

### P-2c — 每会话侧栏 portal 进 [data-dsh-sidebar-host="<sessionId>"]（CSS.escape 防注入），按宿主实测宽度下发 width（0 宽回退轨道宽度），viewportWidth 保持应用视口以保住 autoFullscreen 启发式；响应 dsh-sidebar-host-change 与窗口 resize

```diff
- 			return (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: useViews((value) => value).map((view) => (0, react_jsx_runtime.jsx)(SessionView, {
- 				...props,
- 				view,
- 				visible
- 			}, view.sessionId)) });
+ 			const [hostVersion, setHostVersion] = react.useState(0);
+ 			react.useEffect(() => {
+ 				const onChange = () => setHostVersion((value) => value + 1);
+ 				const onResize = () => setHostVersion((value) => value + 1);
+ 				document.addEventListener("dsh-sidebar-host-change", onChange);
+ 				window.addEventListener("resize", onResize);
+ 				return () => { document.removeEventListener("dsh-sidebar-host-change", onChange); window.removeEventListener("resize", onResize); };
+ 			}, []);
+ 			return (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: useViews((value) => value).map((view) => {
+ 				void hostVersion;
+ 				const host = document.querySelector('[data-dsh-sidebar-host="' + CSS.escape(view.sessionId) + '"]');
+ 				const hostWidth = host === null ? 0 : Math.max(0, host.clientWidth);
+ 				const face = (0, react_jsx_runtime.jsx)(SessionView, {
+ 					...props,
+ 					view,
+ 					visible,
+ 					hosted: host !== null,
+ 					width: host === null || hostWidth === 0 ? props.width : hostWidth,
+ 					viewportWidth: props.viewportWidth,
+ 					canShow: host === null ? props.canShow : true
+ 				}, view.sessionId);
+ 				return host === null ? face : (0, react_dom.createPortal)(face, host);
+ 			}) });
```

### P-2d — F07/V02：分屏视图下 PanelChrome 整体不渲染（返回 null 于组件级，绝不把 null 传进 Tooltip 子节点）

```diff
- 			const toggle = shortcuts.find((entry) => entry.id === "sidebar.right.toggle");
- 			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
+ 			const toggle = shortcuts.find((entry) => entry.id === "sidebar.right.toggle");
+ 			const splitView = typeof document !== "undefined" && document.documentElement.hasAttribute("data-dsh-plugin-main-host");
+ 			return splitView ? null : (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
```

### P-2g — W014/P-2「内容与 frame 呈现分离」：分屏期间 frame 右栏轨道不再打开（内容已 portal 进各会话宿主），回到单窗口时原生行为原样恢复

```diff
- 			const shown = active && surface !== void 0 && surface.layout.expanded;
+ 			const shown = active && surface !== void 0 && surface.layout.expanded && !(typeof document !== "undefined" && document.documentElement.hasAttribute("data-dsh-plugin-main-host"));
```

### P-2h — F07：宿主内呈现时侧栏内容的显隐由插件拥有（data-dsh-sidebar-collapsed），不再被原生 expanded 状态滑出屏幕

```diff
- 				"data-sidebar-right-open": expanded || void 0,
- 				"aria-hidden": !expanded || void 0,
+ 				"data-sidebar-right-open": expanded || typeof document !== "undefined" && document.documentElement.hasAttribute("data-dsh-plugin-main-host") || void 0,
+ 				"aria-hidden": (!expanded && !(typeof document !== "undefined" && document.documentElement.hasAttribute("data-dsh-plugin-main-host"))) || void 0,
```

## 回退

删除 `patches/patched/**`、移除 profile 里的 `link:` 依赖与对应 patch 行、重启 DSH —— 原文件从未被修改。
