# 补丁记录（M-A1：原件 + 最小差异）

**生成方式**：`node tools/apply-patches.mjs`（每次从 `patches/originals/**` 重建，原件哈希先校验、锚点缺失即中止、产物用 esbuild 解析校验）。
**标记契约**：`data-dsh-plugin-main-host` 标识分屏宿主；`data-dsh-sidebar-host` 与 `dsh-sidebar-host-change` 管理侧栏持有；附件按 `data-conversation-session` 和独立 Composer 锚点路由，缺省回退限定在 `data-dsh-split-session` 正文内。

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
| P-2i | `dsh-client-ui-sidebar-right` | `lib/client.js` | 每个在屏分屏会话都有独立 Sidebar View 持有，与前台会话选择分离 |
| P-2j | `dsh-client-ui-sidebar-right` | `lib/client.js` | 创建全部已知宿主 View，目录就绪可重试；retain/release 同步通知不会重入创建 |
| P-2k | `dsh-client-ui-sidebar-right` | `lib/client.js` | 只剪枝既非前台、非分屏宿主、也无 keepMounted tab 的 View；保留延后释放语义 |
| P-2l | `dsh-client-ui-sidebar-right` | `lib/client.js` | 会话目录的无关更新不重发等价 View 快照，避免控制器通知反馈循环 |
| P-2m | `dsh-client-ui-sidebar-right` | `lib/client.js` | Sidebar 卸载清除宿主持有，引用只释放一次 |
| P-2n | `dsh-client-ui-sidebar-right` | `lib/client.js` | 监听分屏宿主集合与真实 sessions.list，首次目录未到时自动恢复，关闭分屏或卸载时撤销监听 |
| P-2o | `dsh-client-ui-sidebar-right` | `lib/client.js` | 以会话 ID 固定 Sidebar portal 身份，插入或关闭前序会话不重挂载其余会话的草稿 DOM |
| P-3d | `dsh-client-ui-attachment` | `lib/client.js` | 文件拖放按实际 conversation DOM 目标选唯一 Composer；非焦点、监听顺序、嵌套子会话不改变收件人；外部/歧义目标拒收，veto/离开/卸载清理覆盖层 |
| P-3e | `dsh-client-ui-attachment` | `lib/client.js` | 每个原生 Composer 持有独立 DOM 锚点，保留原 onAddFiles 与目录识别链 |
| P-3f | `dsh-client-ui-attachment` | `lib/client.js` | 原生 Composer 的监听器绑定到自身 DOM 实例，不读取全局焦点 |
| P-3g | `dsh-client-ui-attachment` | `lib/client.js` | 在真实 conversation 子树放置零布局锚点；DropOverlay 保持原生外观和单窗行为 |

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

### P-2i — 每个在屏分屏会话都有独立 Sidebar View 持有，与前台会话选择分离

```diff
- 			viewsByReference = /* @__PURE__ */ new Map();
- 			selected;
- 			closed = false;
+ 			viewsByReference = /* @__PURE__ */ new Map();
+ 			hostedIds = /* @__PURE__ */ new Set();
+ 			reconciling = false;
+ 			reconcileAgain = false;
+ 			selected;
+ 			closed = false;
```

### P-2j — 创建全部已知宿主 View，目录就绪可重试；retain/release 同步通知不会重入创建

```diff
- 			select(sessionId) {
- 				if (this.closed || this.selected === sessionId) return;
- 				this.selected = sessionId;
- 				if (sessionId !== void 0 && !this.views.has(sessionId)) {
- 					const view = new SidebarSessionView(sessionId, this.sessions, (disposed) => {
- 						this.viewsByReference.delete(disposed.reference);
- 					}, (released) => {
- 						this.prune(released);
- 					});
- 					this.views.set(sessionId, view);
- 					this.viewsByReference.set(view.reference, view);
- 				}
- 				for (const view of this.views.values()) this.prune(view);
- 				this.publish();
- 			}
+ 			select(sessionId, hostedIds = this.hostedIds) {
+ 				if (this.closed) return;
+ 				this.selected = sessionId;
+ 				this.hostedIds = new Set(hostedIds);
+ 				this.reconcile();
+ 			}
+ 			reconcile() {
+ 				if (this.closed) return;
+ 				if (this.reconciling) { this.reconcileAgain = true; return; }
+ 				this.reconciling = true;
+ 				const attempted = new Set();
+ 				try {
+ 					do {
+ 						this.reconcileAgain = false;
+ 						const wanted = new Set(this.hostedIds);
+ 						if (this.selected !== void 0) wanted.add(this.selected);
+ 						for (const sessionId of wanted) {
+ 							if (this.views.has(sessionId) || attempted.has(sessionId)) continue;
+ 							if (this.sessions.list.getSnapshot().byId[sessionId] === void 0) continue;
+ 							attempted.add(sessionId);
+ 							try {
+ 								const view = new SidebarSessionView(sessionId, this.sessions, (disposed) => {
+ 									this.viewsByReference.delete(disposed.reference);
+ 								}, () => { this.reconcile(); });
+ 								if (this.closed) { view.dispose(); break; }
+ 								this.views.set(sessionId, view);
+ 								this.viewsByReference.set(view.reference, view);
+ 							} catch (error) {
+ 								console.error("Sidebar Session view retain failed:", sessionId, error);
+ 							}
+ 						}
+ 						for (const view of [...this.views.values()]) this.prune(view);
+ 						this.publish();
+ 					} while (this.reconcileAgain && !this.closed);
+ 				} finally { this.reconciling = false; }
+ 			}
```

### P-2k — 只剪枝既非前台、非分屏宿主、也无 keepMounted tab 的 View；保留延后释放语义

```diff
- 			prune(view) {
- 				if (view.sessionId === this.selected || view.hasRetainedTabs || this.views.get(view.sessionId) !== view) return;
- 				this.views.delete(view.sessionId);
- 				this.publish();
- 				view.retire();
- 			}
+ 			prune(view) {
+ 				if (view.sessionId === this.selected || this.hostedIds.has(view.sessionId) || view.hasRetainedTabs || this.views.get(view.sessionId) !== view) return;
+ 				this.views.delete(view.sessionId);
+ 				view.retire();
+ 			}
```

### P-2l — 会话目录的无关更新不重发等价 View 快照，避免控制器通知反馈循环

```diff
- 			publish() {
- 				this.source.set([...this.views.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId)).map((view) => ({
- 					sessionId: view.sessionId,
- 					reference: view.reference,
- 					selected: view.sessionId === this.selected,
- 					retainTab: view.retainTab
- 				})));
- 			}
+ 			publish() {
+ 				const next = [...this.views.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId)).map((view) => ({
+ 					sessionId: view.sessionId,
+ 					reference: view.reference,
+ 					selected: view.sessionId === this.selected,
+ 					retainTab: view.retainTab
+ 				}));
+ 				const previous = this.source.getSnapshot();
+ 				if (previous.length === next.length && previous.every((view, index) => view.reference === next[index].reference && view.selected === next[index].selected)) return;
+ 				this.source.set(next);
+ 			}
```

### P-2m — Sidebar 卸载清除宿主持有，引用只释放一次

```diff
- 			/** Plugin shutdown releases every view, including any awaiting a React unmount. */
- 			dispose() {
- 				this.closed = true;
+ 			/** Plugin shutdown releases every view, including any awaiting a React unmount. */
+ 			dispose() {
+ 				if (this.closed) return;
+ 				this.closed = true;
+ 				this.hostedIds.clear();
```

### P-2n — 监听分屏宿主集合与真实 sessions.list，首次目录未到时自动恢复，关闭分屏或卸载时撤销监听

```diff
- 			const views = new SidebarSessionViews(ctx.sessions);
- 			ctx.effect(() => {
- 				const current = ctx.uiSession.adapter.current;
- 				const sync = () => {
- 					views.select(current.getSnapshot().key);
- 				};
- 				const unsubscribe = current.subscribe(sync);
- 				sync();
- 				return () => {
- 					unsubscribe();
- 					views.dispose();
- 				};
- 			}, "ui-sidebar-right: retained Session views");
+ 			const views = new SidebarSessionViews(ctx.sessions);
+ 			ctx.effect(() => {
+ 				const current = ctx.uiSession.adapter.current;
+ 				const sync = () => {
+ 					const hosted = document.documentElement.hasAttribute("data-dsh-plugin-main-host")
+ 						? [...document.querySelectorAll("[data-dsh-sidebar-host]")].map((element) => element.getAttribute("data-dsh-sidebar-host")).filter((id) => id !== null && id !== "")
+ 						: [];
+ 					views.select(current.getSnapshot().key, hosted);
+ 				};
+ 				const unsubscribe = current.subscribe(sync);
+ 				const unsubscribeCatalog = ctx.sessions.list.subscribe(sync);
+ 				document.addEventListener("dsh-sidebar-host-change", sync);
+ 				sync();
+ 				return () => {
+ 					unsubscribe();
+ 					unsubscribeCatalog();
+ 					document.removeEventListener("dsh-sidebar-host-change", sync);
+ 					views.dispose();
+ 				};
+ 			}, "ui-sidebar-right: retained Session views");
```

### P-2o — 以会话 ID 固定 Sidebar portal 身份，插入或关闭前序会话不重挂载其余会话的草稿 DOM

```diff
- return host === null ? face : (0, react_dom.createPortal)(face, host);
+ return host === null ? face : (0, react_dom.createPortal)(face, host, view.sessionId);
```

### P-3d — 文件拖放按实际 conversation DOM 目标选唯一 Composer；非焦点、监听顺序、嵌套子会话不改变收件人；外部/歧义目标拒收，veto/离开/卸载清理覆盖层

```diff
- 		function installDocumentDropEvents(canAcceptDrop, onAddFiles, dragDepth, setDragActive) {
- 			const fileTransfer = (event) => {
- 				const dataTransfer = event.dataTransfer;
- 				if (dataTransfer === null || !dataTransfer.types.includes("Files")) return null;
- 				return dataTransfer;
- 			};
- 			const reset = () => {
- 				dragDepth.current = 0;
- 				setDragActive(false);
- 			};
- 			const onDragEnter = (event) => {
- 				if (event.defaultPrevented) return;
- 				if (fileTransfer(event) === null) return;
- 				event.preventDefault();
- 				dragDepth.current += 1;
- 				setDragActive(true);
- 			};
- 			const onDragOver = (event) => {
- 				if (event.defaultPrevented) return;
- 				const dataTransfer = fileTransfer(event);
- 				if (dataTransfer === null) return;
- 				event.preventDefault();
- 				dataTransfer.dropEffect = canAcceptDrop ? "copy" : "none";
- 			};
- 			const onDragLeave = (event) => {
- 				if (fileTransfer(event) === null) return;
- 				dragDepth.current = Math.max(0, dragDepth.current - 1);
- 				if (dragDepth.current === 0) setDragActive(false);
- 				const leftViewport = event.clientX <= 0 || event.clientY <= 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight;
- 				if ((event.target === document.documentElement || event.target === document.body) && leftViewport) reset();
- 			};
- 			const onDrop = (event) => {
- 				if (event.defaultPrevented) return;
- 				const dataTransfer = fileTransfer(event);
- 				if (dataTransfer === null) return;
- 				event.preventDefault();
- 				reset();
- 				if (canAcceptDrop) {
- 					const files = [...dataTransfer.files];
- 					onAddFiles(files, droppedDirectories(dataTransfer, files));
- 				}
- 			};
- 			document.addEventListener("dragenter", onDragEnter);
- 			document.addEventListener("dragover", onDragOver);
- 			document.addEventListener("dragleave", onDragLeave);
- 			document.addEventListener("drop", onDrop);
- 			window.addEventListener("dragend", reset);
- 			return () => {
- 				document.removeEventListener("dragenter", onDragEnter);
- 				document.removeEventListener("dragover", onDragOver);
- 				document.removeEventListener("dragleave", onDragLeave);
- 				document.removeEventListener("drop", onDrop);
- 				window.removeEventListener("dragend", reset);
- 			};
- 		}
+ 		function installDocumentDropEvents(canAcceptDrop, onAddFiles, dragDepth, setDragActive, dropAnchor) {
+ 			const asElement = (node) => node?.nodeType === 1 ? node : node?.parentElement ?? null;
+ 			const regionFor = (node) => {
+ 				const element = asElement(node);
+ 				if (element === null) return null;
+ 				const conversation = element.closest("[data-conversation-session]");
+ 				const sidebar = element.closest("[data-dsh-sidebar-host]");
+ 				if (conversation !== null) return sidebar !== null && !sidebar.contains(conversation) ? null : conversation;
+ 				if (sidebar !== null || element.closest("[data-dsh-split-titlebar]") !== null) return null;
+ 				const body = element.closest("[data-dsh-split-body]");
+ 				const surface = element.closest("[data-dsh-split-session]");
+ 				const content = body?.firstElementChild;
+ 				return surface !== null && content?.contains(element) ? content : null;
+ 			};
+ 			const receiverFor = (event) => {
+ 				const target = event.composedPath?.().find((node) => node?.nodeType === 1) ?? event.target;
+ 				const region = regionFor(target);
+ 				const anchors = [...document.querySelectorAll("[data-dsh-attachment-drop-anchor]")];
+ 				if (region !== null) {
+ 					const matches = anchors.filter((anchor) => regionFor(anchor) === region);
+ 					return matches.length === 1 ? matches[0] : null;
+ 				}
+ 				const split = document.documentElement.hasAttribute("data-dsh-plugin-main-host") || anchors.some((anchor) => anchor.closest("[data-dsh-split-session]") !== null);
+ 				return !split && anchors.length === 1 ? anchors[0] : null;
+ 			};
+ 			const fileTransfer = (event) => {
+ 				const dataTransfer = event.dataTransfer;
+ 				if (dataTransfer == null || !dataTransfer.types.includes("Files")) return null;
+ 				return dataTransfer;
+ 			};
+ 			const reset = () => {
+ 				dragDepth.current = 0;
+ 				setDragActive(false);
+ 			};
+ 			const owns = (event, dataTransfer) => {
+ 				const receiver = receiverFor(event);
+ 				if (receiver === null) {
+ 					// Refuse ambiguous/outside drops without letting the browser navigate to a file.
+ 					event.preventDefault();
+ 					dataTransfer.dropEffect = "none";
+ 				}
+ 				return receiver !== null && receiver === dropAnchor.current && receiver.isConnected;
+ 			};
+ 			const onDragEnter = (event) => {
+ 				const dataTransfer = fileTransfer(event);
+ 				if (dataTransfer === null) return;
+ 				if (!owns(event, dataTransfer) || event.defaultPrevented) { reset(); return; }
+ 				event.preventDefault();
+ 				dragDepth.current += 1;
+ 				setDragActive(true);
+ 			};
+ 			const onDragOver = (event) => {
+ 				const dataTransfer = fileTransfer(event);
+ 				if (dataTransfer === null) return;
+ 				if (!owns(event, dataTransfer) || event.defaultPrevented) { reset(); return; }
+ 				event.preventDefault();
+ 				dataTransfer.dropEffect = canAcceptDrop ? "copy" : "none";
+ 				dragDepth.current = Math.max(1, dragDepth.current);
+ 				setDragActive(true);
+ 			};
+ 			const onDragLeave = (event) => {
+ 				if (fileTransfer(event) === null) return;
+ 				const leftViewport = event.clientX <= 0 || event.clientY <= 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight;
+ 				if ((event.target === document.documentElement || event.target === document.body) && leftViewport) { reset(); return; }
+ 				// A's dragleave can arrive after B's dragenter; it must not clear B's overlay.
+ 				if (receiverFor(event) !== dropAnchor.current) return;
+ 				if (event.relatedTarget != null && regionFor(event.relatedTarget) !== regionFor(dropAnchor.current)) { reset(); return; }
+ 				dragDepth.current = Math.max(0, dragDepth.current - 1);
+ 				if (dragDepth.current === 0) setDragActive(false);
+ 			};
+ 			const onDrop = (event) => {
+ 				// Cleanup is unconditional, including a capture-phase veto or another receiver.
+ 				reset();
+ 				const dataTransfer = fileTransfer(event);
+ 				if (dataTransfer === null || !owns(event, dataTransfer) || event.defaultPrevented) return;
+ 				event.preventDefault();
+ 				if (canAcceptDrop) {
+ 					const files = [...dataTransfer.files];
+ 					onAddFiles(files, droppedDirectories(dataTransfer, files));
+ 				}
+ 			};
+ 			document.addEventListener("dragenter", onDragEnter);
+ 			document.addEventListener("dragover", onDragOver);
+ 			document.addEventListener("dragleave", onDragLeave);
+ 			document.addEventListener("drop", onDrop);
+ 			window.addEventListener("dragend", reset);
+ 			return () => {
+ 				document.removeEventListener("dragenter", onDragEnter);
+ 				document.removeEventListener("dragover", onDragOver);
+ 				document.removeEventListener("dragleave", onDragLeave);
+ 				document.removeEventListener("drop", onDrop);
+ 				window.removeEventListener("dragend", reset);
+ 				reset();
+ 			};
+ 		}
```

### P-3e — 每个原生 Composer 持有独立 DOM 锚点，保留原 onAddFiles 与目录识别链

```diff
- 			const dragDepth = (0, react.useRef)(0);
+ 			const dragDepth = (0, react.useRef)(0);
+ 			const dropAnchor = (0, react.useRef)(null);
```

### P-3f — 原生 Composer 的监听器绑定到自身 DOM 实例，不读取全局焦点

```diff
- return installDocumentDropEvents(canAcceptDrop, onAddFiles, dragDepth, setDragActive);
+ return installDocumentDropEvents(canAcceptDrop, onAddFiles, dragDepth, setDragActive, dropAnchor);
```

### P-3g — 在真实 conversation 子树放置零布局锚点；DropOverlay 保持原生外观和单窗行为

```diff
- 			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
- 				dragActive &&
+ 			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
+ 				(0, react_jsx_runtime.jsx)("span", { ref: dropAnchor, "data-dsh-attachment-drop-anchor": "", "aria-hidden": true, style: { display: "none" } }),
+ 				dragActive &&
```

## 回退

回退本轮修复时同时恢复安装前的 `lib/` 与宿主补丁备份，具体路径见 `docs/local-install-20261016.md`。`app.asar` 与 `patches/originals` 保持原样。
