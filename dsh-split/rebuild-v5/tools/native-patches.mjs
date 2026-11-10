import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { openAsar, sha256 } from './read-asar.mjs';

export const CONTRACT = 'dsh-split/native-v5.1';
export const DSH_VERSION = '0.2.2-rc.1';
export const ASAR_SHA256 = '5fa8a6b21bceb8f3e99e30efa2270efd0cc773a11e42aa0488f804a64b34e637';
export const BASELINES = Object.freeze({
  layout: '54df2f30af9575c7fee78eac407d9db6aacc4fd0cd595f8ba6b7fc6f6fffc2bf',
  workspace: '0180cefb85c1a71a1d441a8f9533663a8933d5e3f65f8dd23187c5f6147fe12f',
  conversation: '210640100a1431a31a307f31d8258801d0042bec60b4c4a18576b6775487d73e',
  'sidebar-right': 'd1585437d2444518c1ba668e81fd57ee9ed99cf6b629d9a02253422bd610d0b5',
  attachment: 'a347e19878bdc4da4d0adcf52478d6664528a21317ce08359a894dbd0d1e186b',
  chat: '1533ace9d805604cf89d575900ea4b0a1dced9b2c7eaaba619c3909bb9f0fe58',
  deliverables: '2ec8e1f2a60193f2b2b9d38c419472eff91fce651fb9d9ada5267106b2c45c9d',
  plan: '7b41f9684131b8effc1f83af2b47661f4b57770fedeee6ac6bebc5ade5a6485f',
  reference: '64f62538326e8fdb44117d312b1b352845a4b93ce9f9da053b4427fb8adb7aea',
  schedule: '3c007e56fd452ad04ef9a68ea04dd0584adbb31b73a9f66d94b3ded53e8e7097',
  skill: '755aef44830659d1a15434d58717365d97dc33275b48f4e8230e9ead89170ead',
  subagent: '1d74df55b7465b1fcf0298030d8ab94d51c52858f48e47b984359feec3a2544b',
});

/** Every mutation proves the complete archive member and an exact anchor count. */
export function transformNative(name, original) {
  if (sha256(original) !== BASELINES[name]) throw new Error(`Unsupported original ${name}: SHA-256 does not match ${DSH_VERSION}`);
  let source = String(original);
  const anchors = [];
  const replace = (label, before, after, count = 1) => {
    const matches = source.split(before).length - 1;
    if (matches !== count) throw new Error(`${name}/${label}: expected ${count} exact anchors, found ${matches}`);
    anchors.push({ label, count, sha256: sha256(before) });
    source = source.split(before).join(after);
  };
  const between = (label, start, end, after) => {
    const at = source.indexOf(start), finish = source.indexOf(end, at + start.length);
    if (at < 0 || finish < 0) throw new Error(`${name}/${label}: missing boundary`);
    replace(label, source.slice(at, finish), after);
  };

  if (name === 'layout') {
    replace('main-host-key', 'const panelId = usePanelInfo((info) => info.activePanelId);', 'const panelId = usePanelInfo((info) => info.activePanelId);\n            const conversationHostId = usePanelInfo((info) => info.conversationHostId);');
    replace('main-key', 'entryKey: panelId ?? "conversation"', 'entryKey: panelId ?? conversationHostId ?? "conversation"');
    replace('host-state', 'panelInfo: { activePanelId: null }', 'panelInfo: { activePanelId: null, conversationHostId: null }');
    replace('host-action', 'selectPanel: (d, panelId) => {', 'setConversationHost: (d, key) => { d.panelInfo.conversationHostId = key; },\n\t\t\t\t\tselectPanel: (d, panelId) => {');
    replace('host-lease', 'var LayoutController = class {', `var LayoutController = class {
      splitContract = ${JSON.stringify(CONTRACT)};
      conversationHostLease;
      claimConversationHost(key) {
        if (!this.hasMainPanel(key)) throw new Error('Conversation host main key is not registered');
        if (this.conversationHostLease) throw new Error('Conversation host is already claimed');
        const lease = {};
        this.conversationHostLease = lease;
        this.panels.setConversationHost(key);
        let live = true;
        return () => {
          if (!live) return;
          live = false;
          if (this.conversationHostLease !== lease) return;
          this.conversationHostLease = undefined;
          this.panels.setConversationHost(null);
        };
      }`);
  }

  if (name === 'workspace') {
    replace('navigation-request-contract', 'var UiWorkspaceService = class extends _deepseek_ai_cordis.Service {', `var UiWorkspaceService = class extends _deepseek_ai_cordis.Service {
      splitContract = ${JSON.stringify(CONTRACT)};
      navigationRevision = 0;
      navigationRequests = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)(undefined);`);
    replace('navigation-request-commit', 'if (panel === "reveal") this.ctx.layout.selectPanel(null);', `if (panel === "reveal") this.ctx.layout.selectPanel(null);
        this.navigationRequests.set({ revision: ++this.navigationRevision, sessionId: reference.sessionId, reveal: panel === "reveal" });`);
  }

  if (name === 'conversation') {
    between('conversation-factory', '\t\t\tconst registerConversationRoot = () =>', '\t\t\tconst registerConversationContent =', `
      const registerConversationRoot = () => {
        const surface = slots.registerFactory({
          name: "conversation.surface", scope: "session-maybe",
          children: { "conversation.header": { kind: "single", scope: "session-maybe" } }
        }, ConversationRoot);
        const entry = slots.register({ name: "main.conversation" },
          (props) => props.renderFactorySlot("conversation.surface", {}));
        return () => { entry(); surface(); };
      };
`);
    replace('header-embedded-owner', 'children: [renderSlot("conversation.header", {}), renderFactorySlot', 'children: [renderSlot("conversation.header", { embedded: props.embedded }), renderFactorySlot');
    replace('header-embedded-input', 'function ConversationHeader({ sessionId, useSession, useConversation, renderSlot })', 'function ConversationHeader({ sessionId, embedded, useSession, useConversation, renderSlot })');
    replace('header-no-window-drag', '"data-window-drag": true,\n\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("div", {\n\t\t\t\t\tclassName: ConversationRoot_module_css_default.headerLeading', '"data-window-drag": embedded ? void 0 : true,\n\t\t\t\tstyle: embedded ? { WebkitAppRegion: "no-drag" } : void 0,\n\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("div", {\n\t\t\t\t\tclassName: ConversationRoot_module_css_default.headerLeading');
    replace('editor-owner-map', 'function ComposerContentEditable({ editor, editable, ...rest })', 'const splitEditorOwners = new WeakMap();\n\t\tfunction ComposerContentEditable({ editor, editable, ...rest })');
    replace('editor-unique-root', 'editor.setRootElement(el);\n\t\t\t\treturn () => {\n\t\t\t\t\teditor.setRootElement(null);', `const owner = splitEditorOwners.get(editor);
        if (owner && owner !== el) throw new Error('A Session editor is already presented in another view');
        splitEditorOwners.set(editor, el);
        editor.setRootElement(el);
        return () => {
          if (splitEditorOwners.get(editor) !== el) return;
          splitEditorOwners.delete(editor);
          editor.setRootElement(null);`);
  }

  if (name === 'sidebar-right') {
    replace('embedded-tab-no-window-drag', 'tag.textContent = css;', 'tag.textContent = css + "[data-sidebar-right-embedded] [data-window-drag]{-webkit-app-region:no-drag}";');
    replace('view-external-holds', 'var SidebarSessionViews = class {', `var SidebarSessionViews = class {
      embedded = new Map();
      ensure(sessionId) {
        if (this.closed) throw new Error('Sidebar views are disposed');
        if (!this.views.has(sessionId)) {
          const view = new SidebarSessionView(sessionId, this.sessions,
            disposed => this.viewsByReference.delete(disposed.reference), released => this.prune(released));
          this.views.set(sessionId, view);
          this.viewsByReference.set(view.reference, view);
        }
        return this.views.get(sessionId);
      }
      acquire(sessionId) {
        const view = this.ensure(sessionId);
        this.embedded.set(sessionId, (this.embedded.get(sessionId) ?? 0) + 1);
        const unmount = view.mount();
        this.publish();
        let live = true;
        return { reference: view.reference, retainTab: view.retainTab, release: () => {
          if (!live) return;
          live = false;
          const count = this.embedded.get(sessionId) ?? 0;
          if (count <= 1) this.embedded.delete(sessionId); else this.embedded.set(sessionId, count - 1);
          this.prune(view);
          unmount();
          this.publish();
        } };
      }`);
    replace('view-prune', 'if (view.sessionId === this.selected || view.hasRetainedTabs ||', 'if (this.embedded.has(view.sessionId) || view.sessionId === this.selected || view.hasRetainedTabs ||');
    replace('view-target-embedded', 'selected: view.sessionId === this.selected,', 'selected: view.sessionId === this.selected,\n\t\t\t\t\tembedded: this.embedded.has(view.sessionId),');
    replace('global-excludes-embedded', 'useViews((value) => value).map((view)', 'useViews((value) => value).filter((view) => !view.embedded).map((view)');
    replace('global-session-yields', 'const visible = usePanelInfo((info) => info.activePanelId === null);', 'const visible = usePanelInfo((info) => info.activePanelId === null && info.conversationHostId == null);');
    replace('view-dispose-embedded', 'this.closed = true;\n\t\t\t\tthis.views.clear();', 'this.closed = true;\n\t\t\t\tthis.embedded.clear();\n\t\t\t\tthis.views.clear();');
    // A per-session face shares native store, inventory, occurrence and close-handler ownership.
    replace('controller-session-face', 'var SidebarRightController = class {', `var SidebarRightController = class {
      embeddedHostActive = () => false;
      commandVisible = (id) => this.mounted.getSnapshot() === id;
      forSession(sessionId) {
        const adoption = this.adopted.get(sessionId);
        const face = Object.create(this);
        face.mounted = { getSnapshot: () => adoption && this.adopted.get(sessionId) === adoption ? sessionId : undefined, subscribe: () => () => {} };
        return face;
      }`);
    for (const method of ['openTabFromTarget', 'closeTarget', 'isTargetCurrent', 'splitBlock', 'toggleFullscreen']) {
      const signature = method === 'openTabFromTarget' ? 'openTabFromTarget(kind, target) {' : `${method}(target) {`;
      const call = method === 'openTabFromTarget' ? 'openTabFromTarget(kind, target)' : `${method}(target)`;
      replace(`target-${method}`, signature, `${signature}\n        if (target.sessionId !== this.mounted.getSnapshot()) return this.forSession(target.sessionId).${call};`);
    }
    // A stale/adoption-less face must not recurse indefinitely.
    replace('target-expiration', 'if (target.sessionId !== this.mounted.getSnapshot()) return this.forSession(target.sessionId).isTargetCurrent(target);', 'if (!this.commandVisible(target.sessionId) || !this.adopted.has(target.sessionId)) return false;\n        if (target.sessionId !== this.mounted.getSnapshot()) return this.forSession(target.sessionId).isTargetCurrent(target);');
    for (const method of ['openTabFromTarget', 'closeTarget', 'splitBlock', 'toggleFullscreen']) {
      const call = method === 'openTabFromTarget' ? 'openTabFromTarget(kind, target)' : `${method}(target)`;
      const stale = method === 'splitBlock' || method === 'closeTarget' ? '"stale"' : 'undefined';
      replace(`target-live-${method}`, `if (target.sessionId !== this.mounted.getSnapshot()) return this.forSession(target.sessionId).${call};`, `if (!this.commandVisible(target.sessionId) || !this.adopted.has(target.sessionId)) return ${stale};
        if (target.sessionId !== this.mounted.getSnapshot()) return this.forSession(target.sessionId).${call};`);
    }
    replace('focused-explicit-owner', 'focusedTarget(element = document.activeElement) {', `focusedTarget(element = document.activeElement) {
        const owner = element?.closest?.('[data-sidebar-right-session]')?.dataset.sidebarRightSession;
        if (owner && owner !== this.mounted.getSnapshot()) {
          if (!this.commandVisible(owner) || !this.adopted.has(owner)) return;
          return this.forSession(owner).focusedTarget(element);
        }`);
    replace('prefer-split-visible', 'this.mounted.getSnapshot() === sessionId && this.canSplitPane', 'this.commandVisible(sessionId) && this.canSplitPane');
    replace('shortcut-split-explicit', 'if (kind === "split") sidebar.split(target.paneId);', 'if (kind === "split") sidebar.forSession(target.sessionId).split(target.paneId);');
    replace('shortcut-toggle-explicit', 'if (sidebar.isTargetCurrent(target)) sidebar.toggleExpanded();', 'if (sidebar.isTargetCurrent(target)) sidebar.forSession(target.sessionId).toggleExpanded();');
    replace('no-window-close-fallback', 'if (shortcuts.runtime !== "desktop") return {', 'if (sidebar.embeddedHostActive() || shortcuts.runtime !== "desktop") return {');
    // Dockkit's existing float nodes stay in their original React tree. Only
    // presentation rects and user gesture coordinates are local to this seat.
    replace('embedded-float-projection', 'function SidebarPanel(panel) {', `function embeddedFloatTop() {
      const root = document.documentElement;
      if (!root.hasAttribute("data-windows-titlebar")) return 0;
      return (root.hasAttribute("data-fullscreen") ? 0 : Number.parseFloat(root.style.getPropertyValue("--dsh-windows-titlebar-height")) || 0) + 20;
    }
    function embeddedFloatRect(rect, panel) {
      const width = Math.max(1, panel.width), height = Math.max(1, panel.hostHeight);
      const top = Math.min(embeddedFloatTop(), Math.max(0, height - 1));
      const w = Math.max(1, Math.min(rect.width, width)), h = Math.max(1, Math.min(rect.height, height - top));
      return { x: Math.max(0, Math.min(rect.x, width - w)), y: Math.max(top, Math.min(rect.y, height - h)), width: w, height: h };
    }
    function embeddedDockLayout(panel) {
      const layout = panel.surface.layout;
      if (!panel.embedded || !layout.floats.length) return layout;
      const nodes = { ...layout.nodes };
      for (const id of layout.floats) nodes[id] = { ...nodes[id], rect: embeddedFloatRect(nodes[id].rect, panel) };
      return { ...layout, nodes };
    }
    function embeddedDockIntents(panel, intents) {
      if (!panel.embedded) return intents;
      return { ...intents,
        floatTab: (tabId, rect) => {
          const bounds = panel.panelRef.current?.getBoundingClientRect();
          const local = rect && bounds ? { ...rect, x: rect.x - bounds.left, y: rect.y - bounds.top } : { x: 24, y: 24, width: 480, height: 320 };
          intents.floatTab(tabId, embeddedFloatRect(local, panel));
        },
        moveFloat: (paneId, x, y) => {
          const node = panel.surface.layout.nodes[paneId];
          if (!node?.rect) return;
          const rect = embeddedFloatRect({ ...node.rect, x, y }, panel);
          intents.moveFloat(paneId, rect.x, rect.y);
        },
        resizeFloat: (paneId, rect) => intents.resizeFloat(paneId, embeddedFloatRect(rect, panel))
      };
    }
    function SidebarPanel(panel) {`);
    replace('embedded-float-view-state', 'state: surface.layout,', 'state: embeddedDockLayout(panel),');
    replace('embedded-float-intents', 'intents: intentsFor(sessionId, actions, openTab, panel.closeTab, panel.splitPane),', 'intents: embeddedDockIntents(panel, intentsFor(sessionId, actions, openTab, panel.closeTab, panel.splitPane)),');
    // Embedded chrome uses its own containing block and never reports an application right track.
    replace('panel-embedded-layout', 'width: fullscreen ? "100vw" : width,\n\t\t\t\t\t"--dsh-sidebar-width": fullscreen ? "100vw" : `${width}px`', `width: panel.embedded ? "100%" : fullscreen ? "100vw" : width,
          "--dsh-sidebar-width": panel.embedded ? "100%" : fullscreen ? "100vw" : \`\${width}px\`,
          ...(panel.embedded ? { position: "relative", inset: "auto", height: "100%", maxWidth: "none", transform: "none", transition: "none", borderRadius: 0, boxShadow: "none", contain: "layout" } : {})`);
    replace('panel-embedded-data', '"data-sidebar-right-panel": fullscreen ? "fullscreen" : "push",', '"data-sidebar-right-panel": fullscreen ? "fullscreen" : "push",\n\t\t\t\t"data-sidebar-right-embedded": panel.embedded || void 0,');
    // Keep the original PanelChrome and product artwork inside the Sidebar.
    replace('embedded-seat-props', 'function RightbarSeat({ sessionId, width, viewportWidth, canShow,', 'function RightbarSeat({ sessionId, embedded = false, onPresentation, setEmbeddedVisible, hostHeight, width, viewportWidth, canShow,');
    replace('embedded-no-auto-fullscreen', 'const autoFullscreen = viewportWidth < 768;', 'const autoFullscreen = !embedded && viewportWidth < 768;');
    replace('seat-visibility-contract', 'const panelRef = (0, react.useRef)(null);', `const panelRef = (0, react.useRef)(null);
      (0, react.useLayoutEffect)(() => {
        if (!embedded) return;
        setEmbeddedVisible(active);
        return () => setEmbeddedVisible(false);
      }, [embedded, active, setEmbeddedVisible]);
      (0, react.useLayoutEffect)(() => {
        if (embedded && surface) onPresentation?.({ expanded: surface.layout.expanded, fullscreen });
      }, [embedded, surface?.layout.expanded, fullscreen, onPresentation]);`);
    replace('seat-not-global-fullscreen', 'reportAutoFullscreen(autoFullscreen);', 'if (!embedded) reportAutoFullscreen(autoFullscreen);');
    replace('seat-no-global-presentation', 'if (!active) return;\n\t\t\t\tlet disposed = false;', 'if (!active || embedded) return;\n\t\t\t\tlet disposed = false;');
    replace('seat-no-global-cleanup', '(0, react.useLayoutEffect)(() => active ? () => {', '(0, react.useLayoutEffect)(() => active && !embedded ? () => {');
    replace('seat-forward-embedding', 'return (0, react_jsx_runtime.jsx)(SidebarPanel, {\n\t\t\t\tsessionId,', 'return (0, react_jsx_runtime.jsx)(SidebarPanel, {\n\t\t\t\tembedded, hostHeight,\n\t\t\t\tsessionId,');
    // Host ownership is an explicit lease, with multiple visible sessions and one command focus.
    replace('host-coordinator-state', 'const views = new SidebarSessionViews(ctx.sessions);', `const views = new SidebarSessionViews(ctx.sessions);
      let embeddedClaimed = false, embeddedActive, embeddedHostVisible = true;
      const embeddedVisible = new Map();
      let syncOnScreen = () => {};`);
    replace('host-screen-selection', 'show(layout.panelInfo.getSnapshot().activePanelId === null ? selected?.sessionId : void 0);', 'show(embeddedClaimed ? embeddedHostVisible ? embeddedActive : void 0 : layout.panelInfo.getSnapshot().activePanelId === null ? selected?.sessionId : void 0);');
    replace('host-sync-reference', 'const unsubscribeViews = views.source.subscribe(sync);', 'syncOnScreen = sync;\n\t\t\t\tconst unsubscribeViews = views.source.subscribe(sync);');
    replace('controller-visible-contract', 'const disposeRegistry = ctx.reflect.provide("sidebarRightTabs", tabs);', `controller.embeddedHostActive = () => embeddedClaimed;
      controller.commandVisible = id => embeddedClaimed ? embeddedHostVisible && embeddedVisible.get(id) === true : controller.mounted.getSnapshot() === id;
      const disposeRegistry = ctx.reflect.provide("sidebarRightTabs", tabs);`);
    replace('global-track-yields', 'if (shown) layout.openRightbar(track, fullscreen);', 'if (embeddedClaimed) layout.closeRightbar();\n\t\t\t\t\t\telse if (shown) layout.openRightbar(track, fullscreen);');
    replace('surface-factory', 'yield ctx.slots.register({\n\t\t\t\t\t\tname: "rightbar.session",', `yield ctx.slots.register({ name: "rightbar.session" }, ({renderFactorySlot, width, viewportWidth, canShow, active}) => renderFactorySlot("sidebar.right.surface", {width, viewportWidth, canShow, active}));
          yield ctx.slots.registerFactory({
            name: "sidebar.right.surface", scope: "session",`);
    replace('surface-explicit-commands', '...injected,\n\t\t\t\t\t\t\thooks:', `...injected,
              retainTab: views.views.get(sessionId)?.retainTab ?? (() => () => {}),
              setEmbeddedVisible: visible => { embeddedVisible.set(sessionId, visible); },
              openTab: (kind, options) => controller.openTabIn(sessionId, kind, options),
              splitPane: paneId => controller.forSession(sessionId).split(paneId),
              toggleFullscreen: () => { const face = controller.forSession(sessionId); const target = face.commandTarget(null); if (target) face.toggleFullscreen(target); },
              hooks:`);
    replace('publish-host-after-factories', 'const disposeExpand = ctx.slots.inject("conversation.session.header.corner",', `const disposeHost = ctx.reflect.provide("sidebarRightHost", {
          contract: ${JSON.stringify(CONTRACT)},
          claim() {
            if (embeddedClaimed) throw new Error('Sidebar host already claimed');
            embeddedClaimed = true;
            layout.closeRightbar(); syncOnScreen();
            let live = true;
            return () => { if (!live) return; live = false; embeddedClaimed = false; embeddedActive = undefined; embeddedVisible.clear(); syncOnScreen(); };
          },
          acquire(sessionId) { return views.acquire(sessionId); },
          setActive(sessionId) { embeddedActive = sessionId; syncOnScreen(); },
          setHostVisible(visible) { embeddedHostVisible = visible; syncOnScreen(); },
          setExpanded(sessionId, value) { controller.actionsFor(sessionId)?.setExpanded(sessionId, value); },
          setFullscreen(sessionId, value) { controller.actionsFor(sessionId)?.setMode(sessionId, value ? "fullscreen" : "push"); },
          toggleExpanded(sessionId) { controller.actionsFor(sessionId)?.toggleExpanded(sessionId); }
        });
        const disposeExpand = ctx.slots.inject("conversation.session.header.corner",`);
    replace('release-host-face', 'disposeGuideTitle();\n\t\t\t\t\tdisposeGuide();', 'disposeHost();\n\t\t\t\t\tdisposeGuideTitle();\n\t\t\t\t\tdisposeGuide();');
  }

  if (name === 'attachment') {
    replace('drop-owner-input', 'function installDocumentDropEvents(canAcceptDrop, onAddFiles, dragDepth, setDragActive, readFileDrag)', 'function installDocumentDropEvents(canAcceptDrop, onAddFiles, dragDepth, setDragActive, readFileDrag, sessionId)');
    replace('drop-true-target', 'const fileTransfer = (event) => {\n\t\t\t\tconst dataTransfer', `const fileTransfer = (event) => {
        const owner = event.target?.closest?.('[data-conversation-session]');
        if (!owner || owner.dataset.conversationSession !== sessionId || owner.closest('[hidden], [aria-hidden="true"]') || !owner.querySelector('[contenteditable="true"]')) { reset(); return null; }
        const dataTransfer`);
    replace('drop-single-claim', 'if (canAcceptDrop) {\n\t\t\t\t\tconst image =', `if (canAcceptDrop && !event[Symbol.for("dsh.attachment.claimed")]) {
          event[Symbol.for("dsh.attachment.claimed")] = sessionId;
          const image =`);
    replace('attachment-session-prop', 'function ComposerAttachments({ attachments,', 'function ComposerAttachments({ sessionId, attachments,');
    replace('install-session-drop', 'return installDocumentDropEvents(canAcceptDrop, onAddFiles, dragDepth, setDragActive, readFileDrag);', 'return installDocumentDropEvents(canAcceptDrop, onAddFiles, dragDepth, setDragActive, readFileDrag, sessionId);');
    replace('install-session-deps', '\t\t\t\treadFileDrag\n\t\t\t]);', '\t\t\t\treadFileDrag,\n\t\t\t\tsessionId\n\t\t\t]);');
    // Drop overlays no longer cover other Session surfaces. The native content root is already positioned.
    replace('local-drop-overlay-call', 'labels: dropOverlayLabels(t, canAcceptDrop, dropLimits)', 'labels: dropOverlayLabels(t, canAcceptDrop, dropLimits),\n\t\t\t\t\tcontainer: [...document.querySelectorAll("[data-conversation-session]")].find(el => el.dataset.conversationSession === sessionId && !el.closest("[hidden], [aria-hidden=\\"true\\"]"))');
    replace('local-drop-overlay-prop', 'function DropOverlay({ disabled, labels })', 'function DropOverlay({ disabled, labels, container })');
    const overlayStart = source.indexOf('function DropOverlay('), overlayEnd = source.indexOf('\n\t\t//#endregion', overlayStart);
    const overlay = source.slice(overlayStart, overlayEnd);
    if (!overlay.includes('document.body')) throw new Error('attachment/drop-overlay: missing portal anchor');
    replace('local-drop-overlay-render', overlay, overlay.replace('className: DropOverlay_module_css_default.mask,', 'className: DropOverlay_module_css_default.mask,\n\t\t\t\tstyle: container ? { position: "absolute", inset: 0 } : void 0,').replace('document.body', 'container ?? document.body'));
  }

  if (name === 'chat') {
    replace('chat-file-explicit', 'ctx.sidebarRight.openResource(url);', 'ctx.sidebarRight.openResourceIn(sessionId, url);');
    replace('chat-line-explicit', 'ctx.sidebarRight.openResource(url, { params:', 'ctx.sidebarRight.openResourceIn(sessionId, url, { params:');
    replace('chat-browser-explicit', 'ctx.sidebarRight.openTab("browser", { params:', 'ctx.sidebarRight.openTabIn(sessionId, "browser", { params:');
  }
  if (name === 'reference' || name === 'skill') replace('reference-explicit', 'ctx.sidebarRight.openResource(fileAddressFor(session.sessionId, cwd, path));', 'ctx.sidebarRight.openResourceIn(session.sessionId, fileAddressFor(session.sessionId, cwd, path));');
  if (name === 'plan') {
    replace('plan-explicit', 'ctx.sidebarRight.openResource(planAddress({', 'ctx.sidebarRight.openResourceIn(sessionId, planAddress({');
    replace('review-explicit', 'ctx.sidebarRight.openResource(reviewPreviewAddress(sessionId,', 'ctx.sidebarRight.openResourceIn(sessionId, reviewPreviewAddress(sessionId,');
  }
  if (name === 'deliverables') replace('review-explicit', 'ctx.sidebarRight.openResource(changesReviewAddress(coordinates),', 'ctx.sidebarRight.openResourceIn(coordinates.sessionId, changesReviewAddress(coordinates),');
  if (name === 'schedule') replace('schedule-explicit', 'ctx.sidebarRight.openTab(SCHEDULE_TASK_KIND,', 'ctx.sidebarRight.openTabIn(sessionId, SCHEDULE_TASK_KIND,', 2);
  if (name === 'subagent') {
    replace('subagent-parent-explicit', 'const catalogActions = (_parentSessionId) =>', 'const catalogActions = (parentSessionId) =>');
    replace('subagent-open-explicit', 'ctx.sidebarRight.openResource(subagentChatAddress(address),', 'ctx.sidebarRight.openResourceIn(parentSessionId, subagentChatAddress(address),');
  }

  if (source === String(original)) throw new Error(`No patch implemented for ${name}`);
  new vm.Script(source, { filename: `${name}/client.js` });
  return { source, anchors, originalSha256: BASELINES[name], patchedSha256: sha256(source) };
}

export function buildNativePatches(asarPath, outputDirectory) {
  const output = path.resolve(outputDirectory);
  const candidateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (output !== path.join(candidateRoot, 'host-patches')) throw new Error('Output must be this candidate\'s rebuild-v5/host-patches directory');
  if (sha256(fs.readFileSync(asarPath)) !== ASAR_SHA256) throw new Error('Unsupported ASAR identity; no outputs written');
  const archive = openAsar(asarPath);
  const version = JSON.parse(archive.text('dsh/package.json')).version;
  if (version !== DSH_VERSION) throw new Error(`Unsupported DSH version ${version}`);
  const prepared = Object.keys(BASELINES).map(name => {
    const member = `dsh/node_modules/@deepseek-ai/dsh-client-ui-${name}/lib/client.js`;
    return { name, member, ...transformNative(name, archive.read(member)) };
  });
  fs.mkdirSync(output, { recursive: true });
  const manifest = { schemaVersion: 1, contract: CONTRACT, dshVersion: version, asarSha256: ASAR_SHA256,
    source: 'E:/deepseek-harness/resources/app.asar', generatedBy: 'rebuild-v5/tools/native-patches.mjs',
    liveApplied: false, restartPerformed: false,
    files: prepared.map(({ source, ...rest }) => ({ ...rest, output: `@deepseek-ai/dsh-client-ui-${rest.name}/client.js` })) };
  for (const item of prepared) {
    const folder = path.join(output, '@deepseek-ai', `dsh-client-ui-${item.name}`);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'client.js'), item.source);
  }
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const archive = process.argv[2] ?? 'E:/deepseek-harness/resources/app.asar';
  const output = process.argv[3] ?? path.resolve('rebuild-v5/host-patches');
  const manifest = buildNativePatches(archive, output);
  console.log(JSON.stringify({ contract: manifest.contract, files: manifest.files.length, asarSha256: manifest.asarSha256, output, liveApplied: false }));
}
