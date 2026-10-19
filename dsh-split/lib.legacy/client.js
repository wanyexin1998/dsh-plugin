window.__ModuleLoader__.load({
  id: 'dsh-split',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    /**
     * Client half of dsh-split.
     *
     * The split view is an *overlay* on the `shell.overlay` seat, sized to the
     * centre column. Floating above the conversation instead of replacing it as a
     * global panel is what keeps the right sidebar usable: ui-sidebar-right shows
     * its seat and keeps the column open only while `panelInfo.activePanelId` is
     * null, and an overlay leaves the panel selection alone.
     *
     * Each pane renders the *shipped* Conversation body: the overlay entry
     * declares one session-scoped child slot, wraps it in the framework
     * `SessionProvider` bound to a `SessionReference` this plugin retains, and
     * renders the `conversation.content` Component Factory inside it. No
     * conversation UI is reimplemented and no shipped slot is shadowed.
     *
     * Two consequences of the overlay are handled here:
     *
     * 1. The conversation panel stays mounted underneath, and a Session owns
     *    exactly one composer editor (`input/editor/runtime.ts`), so the pane and
     *    the hidden panel would both try to bind it. While the overlay is open
     *    that is harmless — the column underneath is `inert` and unseen, and the
     *    pane holds the editor. On close the covered column must therefore be
     *    remounted so its composer binds a fresh editor: the close sequence parks
     *    the column on an empty panel (hidden behind the overlay), then hands it
     *    back to the conversation in one commit, whose cleanups run before its
     *    effects. The same repair runs on teardown.
     * 2. The Conversation header cannot be rendered per pane: `conversation.header`
     *    is declared by the shipped `main.conversation` registration, and a second
     *    entry may not declare an already-declared child. Each pane therefore
     *    carries a 30px title strip for its title, its close control, and the drag
     *    handle that swaps two panes.
     *
     * This bundle is a plain-JavaScript platform module: React and the
     * design-system primitives come from the shell's module table, so the package
     * needs no build step. The registration id above must equal the package name
     * declared in package.json, because the host attaches a package's half to the
     * Loader row whose specifier is exactly that name.
     */

    const React = require('react')
    const h = React.createElement
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const Button = primitives.Button
    const Tooltip = primitives.Tooltip
    const StateDot = primitives.StateDot
    const MenuItemButton = primitives.MenuItemButton
    const IconCloseOutlineRegular = primitives.IconCloseOutlineRegular
    const IconCompareSplitOutlineRegular = primitives.IconCompareSplitOutlineRegular
    const IconPanelLeftOutlineRegular = primitives.IconPanelLeftOutlineRegular

    /** Overlay entry id; also the package name. */
    const PANEL_ID = 'dsh-split'
    /**
     * An empty `main` panel used only as a switch target when the covered
     * conversation column must be remounted (see the close sequence).
     */
    const VOID_PANEL_ID = 'dsh-split-void'
    /** Locale namespace owned by this plugin. */
    const NS = 'dsh-split'
    /** Layout persistence key; the panel's geometry is browser-local state. */
    const STORAGE_KEY = 'dsh.split.v1'
    /** Reference source label; deliberately not `mainView`. */
    const REFERENCE_SOURCE = 'splitPane'
    /** Pane ceiling: each pane renders a full transcript and holds one follow stream. */
    const MAX_PANES = 4
    /** Smallest share of a split one side may take. */
    const MIN_RATIO = 0.12
    /** Pointer travel that turns a title-bar press into a pane drag. */
    const DRAG_THRESHOLD = 5
    /** Per-boot id salt, so restored ids from an earlier boot can never collide. */
    const BOOT = Math.random().toString(36).slice(2, 8)
    let idSeq = 0

    /** Allocate one stable node id. */
    function nextId(prefix) {
      idSeq += 1
      return prefix + '-' + BOOT + '-' + String(idSeq)
    }

    /* ------------------------------------------------------------------ *
     * Layout tree
     *
     * A node is a pane (`{ t: 'p', id, s }`, `s` being the Session id or
     * null) or a split (`{ t: 's', id, dir, r, a, b }`, `r` the first
     * child's share of the axis). A closed child is left as null rather than
     * collapsed, so the surviving pane keeps its DOM position and identity —
     * collapsing would remount the shipped conversation and drop its editor.
     * ------------------------------------------------------------------ */

    /** Every live pane node, left to right. */
    function listPanes(node) {
      if (node === null) return []
      if (node.t === 'p') return [node]
      return listPanes(node.a).concat(listPanes(node.b))
    }

    /** Replace one pane with the node `make` returns, sharing untouched subtrees. */
    function replacePane(node, paneId, make) {
      if (node === null) return null
      if (node.t === 'p') return node.id === paneId ? make(node) : node
      const a = replacePane(node.a, paneId, make)
      const b = replacePane(node.b, paneId, make)
      return a === node.a && b === node.b ? node : { t: 's', id: node.id, dir: node.dir, r: node.r, a, b }
    }

    /** Drop one pane; a split keeps its shape with a null child. */
    function removePane(node, paneId) {
      if (node === null) return null
      if (node.t === 'p') return node.id === paneId ? null : node
      const a = removePane(node.a, paneId)
      const b = removePane(node.b, paneId)
      if (a === null && b === null) return null
      return a === node.a && b === node.b ? node : { t: 's', id: node.id, dir: node.dir, r: node.r, a, b }
    }

    /** Set one split's first-child share. */
    function setRatio(node, splitId, ratio) {
      if (node === null || node.t === 'p') return node
      const a = setRatio(node.a, splitId, ratio)
      const b = setRatio(node.b, splitId, ratio)
      if (node.id !== splitId) return a === node.a && b === node.b ? node : { t: 's', id: node.id, dir: node.dir, r: node.r, a, b }
      return { t: 's', id: node.id, dir: node.dir, r: ratio, a, b }
    }

    /** Replace one pane's Session id. */
    function withSession(node, paneId, sessionId) {
      return replacePane(node, paneId, (pane) => ({ t: 'p', id: pane.id, s: sessionId }))
    }

    /** A copy without closed children, for persistence. */
    function prune(node) {
      if (node === null) return null
      if (node.t === 'p') return { t: 'p', id: node.id, s: node.s }
      const a = prune(node.a)
      const b = prune(node.b)
      if (a === null && b === null) return null
      if (a === null) return b
      if (b === null) return a
      return { t: 's', id: node.id, dir: node.dir, r: node.r, a, b }
    }

    /** One pane node, or null when the stored value is not a valid tree. */
    function sanitize(node, depth) {
      if (node === null || typeof node !== 'object' || (depth ?? 0) > 12) return null
      if (node.t === 'p') {
        if (typeof node.id !== 'string' || node.id === '') return null
        const sessionId = typeof node.s === 'string' && node.s !== '' ? node.s : null
        return { t: 'p', id: node.id, s: sessionId }
      }
      if (node.t === 's') {
        if (typeof node.id !== 'string' || node.id === '') return null
        const dir = node.dir === 'col' ? 'col' : 'row'
        const raw = typeof node.r === 'number' && Number.isFinite(node.r) ? node.r : 0.5
        const r = Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, raw))
        const a = sanitize(node.a, (depth ?? 0) + 1)
        const b = sanitize(node.b, (depth ?? 0) + 1)
        if (a === null && b === null) return null
        return { t: 's', id: node.id, dir, r, a, b }
      }
      return null
    }

    /** Keep at most `left` panes, left to right; the rest are dropped. */
    function stripExtraPanes(node, budget) {
      if (node === null) return null
      if (node.t === 'p') {
        if (budget.left <= 0) return null
        budget.left -= 1
        return node
      }
      const a = stripExtraPanes(node.a, budget)
      const b = stripExtraPanes(node.b, budget)
      if (a === null && b === null) return null
      if (a === node.a && b === node.b) return node
      return { t: 's', id: node.id, dir: node.dir, r: node.r, a, b }
    }

    /**
     * Clear the Session of every pane that repeats one already taken.
     *
     * One Session owns one composer editor, so two panes on the same Session fight
     * over it. Every operation in this plugin maintains that; this is the boundary
     * that enforces it for a stored layout the plugin did not write.
     */
    function uniqueSessions(node, seen) {
      if (node === null) return null
      if (node.t === 'p') {
        if (node.s === null) return node
        if (seen.has(node.s)) return { t: 'p', id: node.id, s: null }
        seen.add(node.s)
        return node
      }
      const a = uniqueSessions(node.a, seen)
      const b = uniqueSessions(node.b, seen)
      return a === node.a && b === node.b ? node : { t: 's', id: node.id, dir: node.dir, r: node.r, a, b }
    }

    /** Clamp one split share. */
    function clampRatio(value) {
      if (!Number.isFinite(value)) return 0.5
      return Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, value))
    }

    /* ------------------------------------------------------------------ *
     * Styles
     *
     * Local plugins have no `styles.insert` seat, so the sheet is one injected
     * element owned by an effect. Every colour derives from a `--dsw-*` token,
     * so light and dark both hold.
     *
     * The overlay paints `--dsw-specific-sidebar-fill` itself, the app's own
     * grey, and each pane paints `--dsw-alias-bg-base`, the conversation's own
     * surface. That second choice is not cosmetic: the shipped transcript leaves
     * its body transparent and the sticky composer masks it with a `bg-base`
     * gradient (`ConversationRoot.module.css:448-452`), so a pane on any other
     * token shows that mask as a foreign band at the bottom in the dark theme.
     * Focus is a frame, never a repaint.
     *
     * Windows are clipped to their own radius so their content can sit flush, exactly as
     * the shipped Conversation column (`.centerCol { overflow: hidden }`) and the shipped
     * floating panel already do. That stays safe for what a Conversation renders inside a
     * pane: menus, tooltips and the lightbox are portal or fixed layers, and `overflow`
     * does not clip those as long as no ancestor gains a transform, filter, or
     * containment — none here does.
     * ------------------------------------------------------------------ */

    const CSS = [
      // One window language for all three surfaces — the split panes, the right column,
      // and the single-window Conversation column. Every window rule below reads these
      // and nothing else, so the three cannot drift apart again.
      //
      // Declared on `body`, not `:root`: a custom property's `var()` references are
      // substituted on the element that declares it, and the design tokens these point at
      // are declared on `body` (ui-theme/design-platform.css:4/166 light, :276 dark,
      // `--dsw-specific-sidebar-fill` at :267/:377). On `html` those names do not exist,
      // so every token here would compute to the guaranteed-invalid value and each rule
      // would fall back.
      //
      // Only the *aliases* live here; the design tokens stay unresolved on purpose, so that
      // a rule reading `var(--dsh-split-surface, var(--dsw-alias-bg-base, …))` re-resolves
      // them on the element that actually uses them. Baking a fallback into an alias (as an
      // earlier revision did for the border) hides the failure from every reader and removes
      // that recovery.
      'body {',
      '  --dsh-split-inset: 10px;',
      '  --dsh-split-gap: 10px;',
      '  --dsh-split-radius: 10px;',
      '  --dsh-split-border: 0.5px solid var(--dsw-alias-border-l1);',
      '  --dsh-split-surface: var(--dsw-alias-bg-base);',
      '  --dsh-split-backdrop: var(--dsw-specific-sidebar-fill);',
      '  --dsh-split-ink-mix: 6%;',
      '  --dsh-split-scrim-mix: 5%;',
      '  --dsh-split-track-duration: 150ms;',
      '}',
      '[data-split-root] {',
      '  position: absolute;',
      // Full-layer fallback for the first render; the measurement effect replaces
      // all four with the centre column's own rect before the first paint, so the
      // panes never cover the app's caption band (menu and window controls, which
      // are a native drag region that would swallow pointer events).
      '  top: 0;',
      '  bottom: 0;',
      '  left: 0;',
      '  right: 0;',
      '  display: flex;',
      '  flex-direction: column;',
      '  box-sizing: border-box;',
      '  padding: var(--dsh-split-inset, 10px);',
      // Compositor-only: the fade never reflows or repaints the transcripts under it.
      '  animation: dsh-split-in var(--dsh-split-duration, 120ms) ease-out;',
      '  transition: opacity var(--dsh-split-duration, 120ms) ease-out;',
      // While the frame animates its tracks the panes' box is frozen, and the one re-measure at
      // the end is hidden behind this brief dim — compositor-only, so the transcripts never move
      // during the sidebar's own slide.
      '[data-split-root][data-split-animating] { opacity: 0.45; }',
      // The frame's own track slide runs at `--ds-transition-duration-slow` (0.3s); while the
      // split is open it is shortened so the frozen window stays brief. The attribute sits on
      // the frame itself, so the override is closer than the theme's `:root` and always wins.
      '[data-dsh-split-open] { --ds-transition-duration-slow: var(--dsh-split-track-duration, 150ms); }',
      // The backdrop's last resort is `transparent`, not a system colour: if the chain ever
      // breaks, the frame's own grey shows through and the split view still reads correctly.
      // `Canvas` here would reproduce the reported "whole page turned white/near-black".
      // (The surface keeps `Canvas` below: an opaque wrong shade beats a see-through window.)
      '  background: var(--dsh-split-backdrop, var(--dsw-specific-sidebar-fill, transparent));',
      '  color: var(--dsw-alias-label-primary);',
      '  pointer-events: auto;',
      // Subtract the covered rows' drag regions. On macOS the conversation header is
      // one (`data-window-drag`), and Electron composes app regions from geometry, so
      // without this a pane's title strip would drag the window instead of swapping
      // panes. The shipped stylesheet documents the same subtraction for overlays.
      '  -webkit-app-region: no-drag;',
      '}',
      // The same window language for the native right column, so every window in
      // the frame reads alike. Appearance only: the column keeps its own
      // behaviour (drag width, dockkit tabs, fullscreen) untouched.
      // Scoped to the *open* panel. `data-sidebar-right-session` also sits on the
      // collapsed panel, which stays mounted at full width with only its children
      // slid off the frame edge and hidden (SidebarRight.module.css:44-62) — an
      // opaque background there paints a blank board over the centre column's right
      // side. The *column* stays unclipped on purpose: that is what lets the collapsed
      // panel slide off the frame edge and a panel hang over the centre.
      '[data-rightbar-col] [data-sidebar-right-open] {',
      '  box-sizing: border-box;',
      // The surface actually seen inside this panel is the dock host, which paints
      // `bg-base` edge to edge with square corners (ui-dockkit dockkit.module.css:168-171).
      // Without clipping, those corners cover the rounded ones and the card reads as a
      // plain square window. The shipped floating panel clips its own body for exactly
      // this reason. Fixed float children escape the clip at rest (no transform or
      // containment on the panel); during the ~300ms dock entrance the host itself carries
      // `transform: translateX(...)` (SidebarRight.module.css:49), which makes it the float's
      // containing block — so a floating panel is clipped for that transition only.
      '  overflow: hidden;',
      '  border: var(--dsh-split-border, 0.5px solid var(--dsw-alias-border-l1));',
      '  border-radius: var(--dsh-split-radius, 10px);',
      '  background: var(--dsh-split-surface, var(--dsw-alias-bg-base, Canvas));',
      '}',
      // Docked presentation: vertical gutter only. The panel must NOT be pulled left: the
      // split view is an overlay over the covered column, and its 4px outer inset *is* the gap
      // to this panel — a pull would eat exactly that gap and the two windows would read as one
      // surface. In single-window mode the Conversation column's own 4px margin is the gap.
      // (Fullscreen is excluded: it covers the frame by design, and the collapsed panel
      // carries no `data-sidebar-right-open`, so the shipped slide-off is untouched.)
      // The gap between the last pane and the right panel has to match the gap between panes,
      // otherwise the two windows read as different kinds of neighbour. The panel keeps its
      // shipped fixed width and slide-in (no width override, no pull), so the extra 4px comes
      // from the overlay's own right inset — the split root is the only thing that moves.
      // `:has()` is the one selector that can see the panel's open attribute from here; where it
      // is unsupported the rule is simply dropped and the gap stays at one inset.
      // Same gutter in single-window mode, so the Conversation card and the panel keep the same
      // distance in both modes. The covered state is excluded: while splitting, the column has no
      // margin at all and that box is what the overlay measures.
      '[data-rightbar-col] [data-sidebar-right-open]:not([data-sidebar-right-panel="fullscreen"]) {',
      '  top: var(--dsh-split-inset, 10px);',
      '  bottom: var(--dsh-split-inset, 10px);',
      '}',
      // The dock's first column draws the hairline that normally separates it from the
      // Conversation; the card's own border takes that job, so it would double up. The
      // column attribute is load-bearing: without it this selector is (0,3,0) and loses to
      // the shipped `.tabCell[data-dockkit-host][data-dockkit-column='0'] > .tabHost` (0,4,0).
      '[data-rightbar-col] [data-sidebar-right-open] [data-dockkit-host="dock"][data-dockkit-column="0"] > * { border-left: none; }',
      // The Conversation column joins the same language in single-window mode. The app
      // already rounds that column against the grey frame on Windows
      // (AppFrame.module.css:34-36) — this makes the language uniform instead of leaving
      // a tucked sheet beside a floating card. The plugin supplies the hook because the
      // column itself carries no attribute; `data-dsh-covered` returns it to the flat
      // backdrop while the split view's panes are the cards (and makes it fill its track,
      // which is the box the overlay measures).
      '[data-dsh-center] {',
      '  margin: var(--dsh-split-inset, 10px);',
      '  box-sizing: border-box;',
      '  border: var(--dsh-split-border, 0.5px solid var(--dsw-alias-border-l1));',
      '  border-radius: var(--dsh-split-radius, 10px);',
      '  background: var(--dsh-split-surface, var(--dsw-alias-bg-base, Canvas));',
      '}',
      // The shipped Windows radius is `16px 0 0 0`; same specificity, later source.
      '[data-windows-titlebar] [data-dsh-center] { border-radius: var(--dsh-split-radius, 10px); }',
      // macOS: the shipped darwin rules give this column a `border-left` in l3, and none at
      // all while the left sidebar is collapsed. Matching their specificity and coming later
      // in source is what keeps the card's four sides one weight.
      '[data-platform="darwin"] [data-dsh-center] { border-left: var(--dsh-split-border, 0.5px solid var(--dsw-alias-border-l1)); }',
      '[data-platform="darwin"] [data-sidebar-collapsed] [data-dsh-center] { border-left: var(--dsh-split-border, 0.5px solid var(--dsw-alias-border-l1)); }',
      '[data-dsh-center][data-dsh-covered] {',
      '  margin: 0;',
      '  border: none;',
      '  border-radius: 0;',
      '  background: var(--dsh-split-backdrop, var(--dsw-specific-sidebar-fill, transparent));',
      // Nothing of the covered Conversation should paint. Hidden rather than merely clipped,
      // because a Conversation renders `position: fixed` descendants that escape every
      // ancestor clip and outrank the overlay layer's z-index 20
      // (ui-layout/AppFrame.module.css:259-262); hiding the subtree also makes it cost no
      // paint. Two limits, both known and accepted: a *portalled* surface is not a descendant
      // and stays painted (the context meter is `createPortal(…, document.body)`,
      // ui-conversation/skeleton/ContextMeter.tsx:133 — it floats over a shipped global panel
      // the same way), and a descendant may opt back in with `visibility: visible`
      // (ui-chat request-prompt.ts:146), which the overlay's opaque backdrop covers instead.
      '  visibility: hidden;',
      '}',
      // The native right panel is itself a column the user can expand to cover
      // the centre; the split view yields rather than covering it.
      '[data-split-root][data-split-yield] { display: none; }',
      '[data-split-root] .dsh-split-split { display: flex; flex: 1 1 auto; min-width: 0; min-height: 0; }',
      '[data-split-root] .dsh-split-cell { display: flex; min-width: 0; min-height: 0; }',
      '[data-split-root] .dsh-split-cell > * { flex: 1 1 auto; min-width: 0; min-height: 0; }',
      '[data-split-root] .dsh-split-handle { position: relative; flex: 0 0 var(--dsh-split-gap, 10px); align-self: stretch; border: 0; padding: 0; background: transparent; }',
      '[data-split-root] .dsh-split-handle.is-row { cursor: col-resize; }',
      '[data-split-root] .dsh-split-handle.is-col { cursor: row-resize; }',
      '[data-split-root] .dsh-split-handle::before { content: ""; position: absolute; inset: 0; }',
      '[data-split-root] .dsh-split-handle.is-row::before { left: -4px; right: -4px; }',
      '[data-split-root] .dsh-split-handle.is-col::before { top: -4px; bottom: -4px; }',
      '[data-split-root] .dsh-split-handle::after { content: ""; position: absolute; border-radius: 2px; background: transparent; transition: background-color var(--dsh-split-duration, 120ms) ease-out; }',
      '[data-split-root] .dsh-split-handle.is-row::after { width: 2px; top: 20%; bottom: 20%; left: 50%; transform: translateX(-50%); }',
      '[data-split-root] .dsh-split-handle.is-col::after { height: 2px; left: 20%; right: 20%; top: 50%; transform: translateY(-50%); }',
      '[data-split-root] .dsh-split-handle:hover::after { background: var(--dsw-alias-border-l2); }',
      '[data-split-root] .dsh-split-handle.is-dragging::after { background: var(--dsw-alias-label-secondary); }',
      '@keyframes dsh-split-in { from { opacity: 0; } }',
      '@keyframes dsh-split-out { from { opacity: 1; } to { opacity: 0; } }',
      '@keyframes dsh-split-pane-in { from { opacity: 0; transform: translateY(3px); } }',
      // The closing shell: the panes are gone, only the grey backdrop remains and fades out
      // over the restored conversation. Inert — it must never swallow the restored composer.
      '[data-split-root][data-split-closing] {',
      '  animation: dsh-split-out var(--dsh-split-duration, 120ms) ease-out forwards;',
      '  pointer-events: none;',
      '}',
      '[data-split-root] .dsh-split-pane {',
      '  position: relative;',
      '  display: flex;',
      '  flex-direction: column;',
      '  box-sizing: border-box;',
      '  min-width: 0;',
      '  min-height: 0;',
      // Same window as the right column and the single-window Conversation column:
      // surface, border, radius, and a clip so the hosted content can sit flush.
      '  overflow: hidden;',
      '  border: var(--dsh-split-border, 0.5px solid var(--dsw-alias-border-l1));',
      '  border-radius: var(--dsh-split-radius, 10px);',
      '  background: var(--dsh-split-surface, var(--dsw-alias-bg-base, Canvas));',
      '  transition: border-color var(--dsh-split-duration, 120ms) ease-out, box-shadow var(--dsh-split-duration, 120ms) ease-out, opacity var(--dsh-split-duration, 120ms) ease-out;',
      '  animation: dsh-split-pane-in var(--dsh-split-duration, 120ms) ease-out;',
      '}',
      '[data-split-root][data-split-multi="true"] .dsh-split-pane.is-focused {',
      // The resting window edge is a faint `l1` hairline (see the token block), so focus is the
      // restrained step up to `l3` — a border, not a coloured ring, which is what the window
      // language asks for. The 8px gap and the panel gutter carry window separation, so this
      // border has something to stand out from.
      '  border-color: var(--dsw-alias-border-l3);',
      '  box-shadow: 0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) var(--dsh-split-ink-mix, 6%), transparent);',
      '}',
      '[data-split-root] .dsh-split-pane.is-dragging { opacity: 0.55; }',
      '[data-split-root] .dsh-split-pane.is-drop-target {',
      '  border-color: var(--dsw-alias-brand-primary);',
      '  box-shadow: 0 0 0 1px color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, transparent);',
      '}',
      '[data-split-root] .dsh-split-chrome { display: flex; align-items: center; gap: 2px; flex: 0 0 auto; height: 30px; padding: 0 var(--dsh-split-inset, 10px) 0 10px; border-bottom: var(--dsh-split-border, 0.5px solid var(--dsw-alias-border-l1)); cursor: grab; }',
      '[data-split-root] .dsh-split-pane.is-dragging .dsh-split-chrome { cursor: grabbing; }',
      '[data-split-root] .dsh-split-title { flex: 1 1 auto; min-width: 0; padding: 4px 6px; font-size: 12px; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; user-select: none; color: var(--dsw-alias-label-secondary); }',
      '[data-split-root] .dsh-split-pane.is-focused .dsh-split-title { color: var(--dsw-alias-label-primary); }',
      // Pane controls stay out of the way until the pane is used; while hidden
      // they take no pointer events, so a stray click can never close a pane.
      '[data-split-root] .dsh-split-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 2px; opacity: 0; pointer-events: none; transition: opacity var(--dsh-split-duration, 120ms) ease-out; }',
      '[data-split-root] .dsh-split-pane:hover .dsh-split-actions,',
      '[data-split-root] .dsh-split-actions:focus-within { opacity: 1; pointer-events: auto; }',
      // The panel-toggle glyph is a leaf, so mirroring it cannot affect the
      // containing block of anything the native conversation renders.
      '[data-split-root] .dsh-split-mirror { display: inline-flex; transform: scaleX(-1); }',
      '[data-split-root] .dsh-split-body { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; min-height: 0; }',
      '[data-split-root] .dsh-split-body > * { flex: 1 1 auto; min-width: 0; min-height: 0; }',
      '[data-split-root] .dsh-split-picker { display: flex; flex: 1 1 auto; flex-direction: column; gap: 2px; min-width: 0; min-height: 0; overflow: auto; padding: 8px; }',
      '[data-split-root] .dsh-split-hint { flex: 0 0 auto; padding: 2px 10px 8px; font-size: 11.5px; line-height: 1.4; color: var(--dsw-alias-label-secondary); }',
      '[data-split-root] .dsh-split-row { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; padding: 7px 10px; border: 0; border-radius: 8px; background: none; font: inherit; text-align: left; cursor: pointer; color: inherit; }',
      '[data-split-root] .dsh-split-row:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) var(--dsh-split-ink-mix, 6%), transparent); }',
      '[data-split-root] .dsh-split-row-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }',
      '[data-split-root] .dsh-split-row-title { font-size: 12.5px; line-height: 1.25; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
      '[data-split-root] .dsh-split-row-meta { font-size: 11px; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--dsw-alias-label-secondary); }',
      '[data-split-root] .dsh-split-notice { position: absolute; left: 12px; bottom: 10px; z-index: 2; max-width: 62ch; padding: 5px 10px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-overlay); font-size: 11px; line-height: 1.4; color: var(--dsw-alias-label-secondary); }',
      // Non-focused panes take a very light veil so the eye can tell them apart at a glance. The
      // veil is mixed from the theme's own primary ink, so it darkens in the light theme and
      // lightens in the dark one without a single hard-coded colour; 5% keeps it a hint rather
      // than a shade, and `pointer-events: none` keeps the pane behind it clickable.
      '[data-split-root][data-split-multi="true"] .dsh-split-pane::after {',
      '  content: "";',
      '  position: absolute;',
      '  inset: 0;',
      '  pointer-events: none;',
      '  border-radius: inherit;',
      '  background: color-mix(in srgb, var(--dsw-alias-label-primary) var(--dsh-split-scrim-mix, 5%), transparent);',
      '  transition: opacity var(--dsh-split-duration, 120ms) ease-out;',
      '}',
      '[data-split-root][data-split-multi="true"] .dsh-split-pane.is-focused::after { opacity: 0; }',
      '@media (prefers-reduced-motion: reduce) {',
      '  [data-split-root],',
      '  [data-split-root] .dsh-split-pane,',
      '  [data-split-root] .dsh-split-actions,',
      '  [data-split-root] .dsh-split-pane::after,',
      '  [data-split-root] .dsh-split-handle::after { transition: none; animation: none; }',
      '}',
    ].join('\n')

    /* ------------------------------------------------------------------ *
     * Controller — layout tree, retained references, navigation, storage
     * ------------------------------------------------------------------ */

    /**
     * Own the split layout, one retained SessionReference per pane, and the
     * overlay's open state.
     *
     * @param ctx - the plugin's client context.
     * @returns the controller surface: `source` for the renderer-bound hook plus
     *   the operations components call.
     */
    function createController(ctx) {
      const sessions = ctx.sessions
      const layout = ctx.layout
      const disposers = []
      const listeners = new Set()

      let state = { ...readLayout(), open: false, closing: false }
      let refs = new Map()
      /** Per-pane binding generation: a bump remounts that pane's conversation. */
      let gens = new Map()
      /**
       * Bumped by every open/close request. A close parks the column and finishes a
       * frame later, so a request arriving inside that window must not be undone by
       * the pending restore.
       */
      let overlayToken = 0
      /** One retry for the centre-column hook, for a frame that mounts after this plugin. */
      let centerRetried = false
      /** Pane ids whose retain is in flight, so a re-entrant pass cannot retain them twice. */
      const pendingRefs = new Set()
      /**
       * Set once this instance is torn down. Late callbacks (the close sequence's frame and
       * fallback timer, the repair timer, the retry timers) outlive the fiber, and after a
       * hot reload a *new* instance owns the same DOM and services: a disposed instance must
       * hand the column back but must not write anything a live instance owns.
       */
      let disposed = false
      /** True while a focus change is handing the app's current Session to another pane. */
      let navigating = false
      /** True while the right column is being reconciled for the Session we just navigated to. */
      let rightbarOpening = false
      /** The Session a collapsed right column will navigate to once it is opened. */
      let deferredSession = null
      /** The last follow target of a burst of focus changes; applied by `followTimer`. */
      let followQueued = null
      /** Timer for the coalesced follow navigation; one per burst. */
      let followTimer = null
      /** The Session a follow navigation is handing over; set while its covered mount may still be pending. */
      let pendingFollow = null
      /** Last persisted payload, so a focus move or divider drag writes nothing new. */
      let persisted = null
      let persistTimer = null
      let published = snapshot()

      /** The published snapshot; its identity only moves when the state does. */
      function snapshot() {
        return Object.freeze({ root: state.root, focus: state.focus, refs, gens, open: state.open, closing: state.closing })
      }

      function notify() {
        published = snapshot()
        schedulePersist()
        for (const listener of Array.from(listeners)) listener()
      }

      /**
       * Persist the layout, coalescing bursts.
       *
       * Publication is on the hot path — a divider drag publishes once per animation
       * frame — so the write is deferred and deduplicated instead of running inside
       * every notify. {@link controller.dispose} flushes it.
       */
      function schedulePersist() {
        if (persistTimer !== null) return
        persistTimer = window.setTimeout(() => {
          persistTimer = null
          writeLayout()
        }, 200)
      }

      function readLayout() {
        try {
          const raw = window.localStorage.getItem(STORAGE_KEY)
          if (raw !== null) {
            const parsed = JSON.parse(raw)
            if (parsed !== null && typeof parsed === 'object' && parsed.v === 1) {
              const stored = sanitize(parsed.root, 0)
              // Storage is outside this plugin: apply the pane ceiling and the
              // one-Session-per-pane rule here rather than mounting an arrangement
              // the plugin's own operations would never produce.
              const root = stored === null ? null : uniqueSessions(prune(stripExtraPanes(stored, { left: MAX_PANES })), new Set())
              if (root !== null) {
                const pane = listPanes(root).find((candidate) => candidate.id === parsed.focus)
                return { root, focus: pane === undefined ? listPanes(root)[0].id : pane.id }
              }
            }
          }
        } catch (error) {
          // Malformed or unreadable storage is a fresh layout, not a failure.
          console.warn('[dsh-split] ignored stored layout', error)
        }
        const pane = { t: 'p', id: nextId('pane'), s: null }
        return { root: pane, focus: pane.id }
      }

      function writeLayout() {
        const next = JSON.stringify({ v: 1, root: prune(state.root), focus: state.focus })
        if (next === persisted) return
        try {
          window.localStorage.setItem(STORAGE_KEY, next)
          persisted = next
        } catch (error) {
          // Persistence is a convenience; a refused write leaves the session layout-only.
          console.warn('[dsh-split] could not persist layout', error)
        }
      }

      function panes() {
        return listPanes(state.root)
      }

      function paneOfSession(sessionId) {
        if (sessionId === null || sessionId === undefined) return undefined
        const pane = panes().find((candidate) => candidate.s === sessionId)
        return pane === undefined ? undefined : pane.id
      }

      /** The Session the shell currently treats as current, if any. */
      function currentSessionId() {
        try {
          const key = ctx.uiSession.adapter.current.getSnapshot().key
          return typeof key === 'string' && key !== '' ? key : undefined
        } catch (error) {
          console.warn('[dsh-split] could not read the current session', error)
          return undefined
        }
      }

      /**
       * The centre column the overlay covers, when the document has one.
       *
       * `shell.overlay` is a frame-wide layer, so covering only the conversation
       * column needs that column's box. The frame marks its overlay layer
       * (`data-shell-overlay`) and its right column (`data-rightbar-col`), and the
       * centre column is the right column's previous sibling — the same columns
       * the frame's own grid template lays out.
       */
      function centerColumn() {
        try {
          const layer = document.querySelector('[data-shell-overlay]')
          const frame = layer === null ? null : layer.parentElement
          if (frame === null) return null
          const rightbar = frame.querySelector('[data-rightbar-col]')
          const center = rightbar === null ? frame.children[1] : rightbar.previousElementSibling
          return center === undefined || center === null ? null : center
        } catch (error) {
          console.warn('[dsh-split] could not find the centre column', error)
          return null
        }
      }

      /**
       * Mark the centre column, and take it out of the interaction tree while the
       * overlay covers it.
       *
       * The column carries no attribute of its own, so the window stylesheet cannot
       * reach it: `data-dsh-center` is that hook, and it is what puts the Conversation
       * into the same window language as the right column and the panes.
       * `data-dsh-covered` says the panes are the cards instead, so the column goes
       * back to being the flat backdrop — and fills its track, which is the box the
       * overlay measures.
       */
      function setCovered(covered) {
        const center = centerColumn()
        if (center === null) return
        try {
          center.setAttribute('data-dsh-center', '')
          if (covered) {
            center.setAttribute('data-dsh-covered', '')
            center.setAttribute('inert', '')
            center.setAttribute('aria-hidden', 'true')
          } else {
            center.removeAttribute('data-dsh-covered')
            center.removeAttribute('inert')
            center.removeAttribute('aria-hidden')
          }
        } catch (error) {
          console.warn('[dsh-split] could not update the covered column', error)
        }
      }

      /**
       * Publish the centre-column hook at startup.
       *
       * Answers for a frame that is not mounted yet with one retry, because the
       * single-window card depends on this attribute being present before the user
       * ever opens the split view.
       */
      function markCenter() {
        if (centerColumn() !== null) {
          setCovered(false)
          return
        }
        if (centerRetried) return
        centerRetried = true
        window.setTimeout(() => {
          if (!disposed) controller.markCenter()
        }, 500)
      }

      /** Leave the frame exactly as it was found. */
      function releaseCenter() {
        const center = centerColumn()
        if (center === null) return
        try {
          center.removeAttribute('data-dsh-center')
          center.removeAttribute('data-dsh-covered')
          center.removeAttribute('inert')
          center.removeAttribute('aria-hidden')
        } catch (error) {
          console.warn('[dsh-split] could not release the centre column', error)
        }
      }

      /** True while the centre column is parked on the empty panel. */
      function isParked() {
        try {
          return layout.panelInfo.getSnapshot().activePanelId === VOID_PANEL_ID
        } catch (error) {
          console.warn('[dsh-split] could not read the panel selection', error)
          return false
        }
      }

      /**
       * The most recent Session that no pane shows, ignoring `skip`.
       *
       * A split has to produce two real conversations, so when the Session the user asked for is
       * already on screen this is what the new pane shows instead: a pane that only asks the user
       * to choose is not a split of anything.
       */
      function nextOffScreenSession(skip) {
        let list
        try {
          list = sessions.list.getSnapshot()
        } catch (error) {
          return undefined
        }
        if (list.phase !== 'ready') return undefined
        for (const id of list.ids) {
          if (id === skip) continue
          if (paneOfSession(id) !== undefined) continue
          // A brand-new Session that is still blank is not a conversation to put beside
          // anything: filling the new pane with it reads as "the split became a new session".
          const summary = list.byId[id]
          if (summary !== undefined && summary.blank === true) continue
          return id
        }
        return undefined
      }

      /** Forget one pane's retained reference and the binding generation recorded for it. */
      function forgetPane(paneId) {
        dropReference(paneId)
        if (!gens.has(paneId)) return
        const next = new Map(gens)
        next.delete(paneId)
        gens = next
      }

      /**
       * Retain one Session for one pane.
       *
       * `retain` opens the Session and publishes the session list again, so the pass that
       * fills missing references can be re-entered before this pane's reference is
       * recorded. Marking the pane in flight is what keeps the second pass from retaining
       * it twice — that extra reference would never be released, because a pane releases
       * exactly one.
       */
      function retainFor(paneId, sessionId) {
        pendingRefs.add(paneId)
        try {
          return sessions.retain(sessionId, { source: REFERENCE_SOURCE })
        } finally {
          pendingRefs.delete(paneId)
        }
      }

      /** Drop one pane's reference; the Session keeps whatever other owners hold. */
      function dropReference(paneId) {
        const reference = refs.get(paneId)
        if (reference === undefined) return
        const next = new Map(refs)
        next.delete(paneId)
        refs = next
        try {
          reference.release()
        } catch (error) {
          console.warn('[dsh-split] reference release failed', error)
        }
      }

      /**
       * Ask the native navigation for this Session.
       *
       * Called only when the layout collapses to a single pane, so the window the
       * user lands in is the Session that survived. Clicking a pane deliberately
       * does *not* call this: navigating would remount the covered conversation
       * panel and take the shared composer editor away from the pane.
       */
      function followCurrent(paneId) {
        const pane = panes().find((candidate) => candidate.id === paneId)
        if (pane === undefined || pane.s === null) return
        if (refs.get(paneId) === undefined) return
        let alreadyCurrent = false
        try {
          const summary = sessions.list.getSnapshot().byId[pane.s]
          const retained = summary === undefined ? undefined : summary.retainedBy
          alreadyCurrent = retained !== undefined && (retained.mainView ?? 0) > 0
        } catch (error) {
          console.warn('[dsh-split] could not read retention counts', error)
        }
        if (alreadyCurrent) return
        try {
          ctx.uiWorkspace.openSession(pane.s)
        } catch (error) {
          console.warn('[dsh-split] could not follow the focused pane', error)
        }
      }

      /** Read the column's open state; false when there is no session surface to read. */
      function rightbarDrawnOpen() {
        try {
          return ctx.sidebarRight.isExpanded() === true
        } catch (error) {
          return false
        }
      }

      /** How many frames the open-state reconcile may confirm itself over (see below). */
      const RECONCILE_ATTEMPTS = 3

      /**
       * Navigate the app's current Session to one pane's Session and keep the column open.
       *
       * The column draws whatever Session is current (`ui-sidebar-right/contract/slots.ts` marks
       * its slot `scope: 'session'`), so this navigation is the only way to show another pane's
       * content there — the same call {@link followCurrent} makes. The navigation also remounts
       * the covered conversation and the pane showing the target (a Session owns one editor), so
       * it is only made while the column is visible; a collapsed column defers instead.
       */
      function applyFollow(sessionId) {
        // The marker tells `bumpPaneShown` that this navigation is ours: the publication can
        // land before the covered conversation's own mount commits, and the pane must re-take
        // the shared editor after that commit, not before it.
        pendingFollow = sessionId
        navigating = true
        let opened = false
        try {
          ctx.uiWorkspace.openSession(sessionId)
          opened = true
        } catch (error) {
          console.warn('[dsh-split] could not follow the focused pane', error)
        } finally {
          navigating = false
        }
        if (opened) reconcileRightbar(true, RECONCILE_ATTEMPTS)
        else pendingFollow = null
        window.setTimeout(() => {
          if (pendingFollow === sessionId) pendingFollow = null
        }, 300)
        return opened
      }

      /**
       * Bring the column's open state back to `wantOpen` for whichever Session is current now.
       *
       * The open state is stored *per Session* (`stores.ts` seats its state by session id), so a
       * navigation can land on a Session whose column is the opposite of what the user had.
       * Opening a Session's column also gives a Session that never had one its first tab (the
       * store mints one when an empty seat is expanded), which is the start page.
       *
       * The surface the service reads can lag the navigation by a commit, so a matching read still
       * re-verifies, and a mismatch toggles at most once per pass. The chain is short (a few
       * frames) and never polls; a manual toggle inside that window can be overridden once.
       */
      function reconcileRightbar(wantOpen, attemptsLeft) {
        if (disposed || attemptsLeft <= 0) return
        if (rightbarOpening) {
          window.requestAnimationFrame(() => { reconcileRightbar(wantOpen, attemptsLeft) })
          return
        }
        if (rightbarDrawnOpen() === wantOpen) {
          window.requestAnimationFrame(() => { reconcileRightbar(wantOpen, attemptsLeft - 1) })
          return
        }
        rightbarOpening = true
        controller.toggleRightbar()
        window.requestAnimationFrame(() => {
          rightbarOpening = false
          reconcileRightbar(wantOpen, attemptsLeft - 1)
        })
      }

      /**
       * Make the right column follow the pane the focus ring is on.
       *
       * While the column is collapsed nothing visible depends on the current Session, and a
       * navigation here costs the two most expensive remounts in the split view, so the follow is
       * remembered and applied when the column opens. While it is open, rapid focus changes are
       * coalesced: one deferred navigation to the last target, with every gate re-run when it
       * fires.
       */
      function syncRightbarToFocus() {
        if (!state.open || navigating || isParked()) return
        const pane = panes().find((candidate) => candidate.id === state.focus)
        if (pane === undefined || pane.s === null) return
        const sessionId = currentSessionId()
        if (sessionId === undefined || sessionId === pane.s) return
        followQueued = pane.s
        if (followTimer !== null) return
        followTimer = window.setTimeout(() => {
          followTimer = null
          const target = followQueued
          followQueued = null
          // The burst may have closed the view, parked the column or moved the focus since.
          if (disposed || !state.open || isParked()) return
          const focused = panes().find((candidate) => candidate.id === state.focus)
          if (focused === undefined || focused.s !== target) return
          if (rightbarDrawnOpen()) applyFollow(target)
          else deferredSession = target
        }, 0)
      }

      /** The pane element showing a Session, or null (absent in the harness and while staged). */
      function paneElementFor(sessionId) {
        if (typeof document.querySelectorAll !== 'function') return null
        const root = document.querySelector('[data-split-root]')
        if (root === null || typeof root.querySelectorAll !== 'function') return null
        for (const pane of root.querySelectorAll('[data-split-pane]')) {
          if (typeof pane.getAttribute !== 'function') continue
          if (pane.getAttribute('data-split-session') === String(sessionId)) return pane
        }
        return null
      }

      /** The pane's own scroll offset, captured before a remount and restored after it. */
      const paneScroll = new Map()

      function capturePaneScroll(paneId, sessionId) {
        const element = paneElementFor(sessionId)
        if (element === null || typeof element.querySelectorAll !== 'function') return
        for (const node of element.querySelectorAll('*')) {
          if (typeof node.scrollHeight !== 'number' || typeof node.clientHeight !== 'number') continue
          if (node.scrollHeight > node.clientHeight + 1) {
            paneScroll.set(paneId, { sessionId, top: node.scrollTop })
            return
          }
        }
      }

      function restorePaneScroll(paneId) {
        const entry = paneScroll.get(paneId)
        if (entry === undefined) return
        paneScroll.delete(paneId)
        let settled = false
        const restore = () => {
          if (settled || disposed) return
          settled = true
          const element = paneElementFor(entry.sessionId)
          if (element === null || typeof element.querySelectorAll !== 'function') return
          for (const node of element.querySelectorAll('*')) {
            if (typeof node.scrollHeight !== 'number') continue
            if (node.scrollHeight > node.clientHeight + 1) {
              node.scrollTop = entry.top
              return
            }
          }
        }
        if (typeof window.requestAnimationFrame === 'function') {
          window.requestAnimationFrame(() => { window.requestAnimationFrame(restore) })
        }
        window.setTimeout(restore, 250)
      }

      /**
       * Remount the pane showing this Session.
       *
       * A Session owns one composer editor, and the covered conversation panel
       * shares it with a pane. Whenever the native navigation moves onto a Session
       * a pane already shows, the panel's composer mounts and binds that editor to
       * its own (hidden) div. Remounting the pane in the same commit takes the
       * binding back: the overlay is a later sibling of the centre column, so its
       * layout effects run after the column's.
       */
      function bumpPaneShown(sessionId) {
        const paneId = paneOfSession(sessionId)
        if (paneId === undefined) return
        const bump = () => {
          if (disposed || paneOfSession(sessionId) !== paneId) return
          // The remount resets the transcript's scroll: capture it now and put it back once the
          // remount commits, so a follow navigation does not read as a jump in the pane being
          // read. Scroll preservation is best-effort: it must never keep the editor from
          // rebinding, so anything it throws is swallowed.
          try {
            capturePaneScroll(paneId, sessionId)
          } catch (error) {
            console.warn('[dsh-split] could not capture pane scroll', error)
          }
          const next = new Map(gens)
          next.set(paneId, (next.get(paneId) ?? 0) + 1)
          gens = next
          notify()
          try {
            restorePaneScroll(paneId)
          } catch (error) {
            console.warn('[dsh-split] could not restore pane scroll', error)
          }
        }
        bump()
        if (pendingFollow !== sessionId) return
        // A follow navigation publishes before the covered conversation's own mount commits:
        // its composer can bind the shared editor after this bump and leave the pane dead. Re-take
        // the editor once the app has committed — one frame round, with the usual paused-frame
        // fallback. The extra remount is why a follow switch costs two mounts, but never a dead
        // composer.
        let settled = false
        const retake = () => {
          if (settled || disposed) return
          settled = true
          bump()
        }
        if (typeof window.requestAnimationFrame === 'function') {
          window.requestAnimationFrame(() => { window.requestAnimationFrame(retake) })
        }
        window.setTimeout(retake, 250)
      }

      /**
       * Adopt the Session the user just navigated to into the focused pane.
       *
       * This is what makes a Sidebar click (or New Session) fill a pane instead
       * of taking the window over; the overlay itself never moves, and with one
       * pane it is closed, so the native single-window view keeps that gesture.
       */
      function adoptCurrent() {
        if (!state.open) return
        const list = panes()
        if (list.length < 2) return
        const sessionId = currentSessionId()
        if (sessionId === undefined) return
        const owner = paneOfSession(sessionId)
        if (owner !== undefined) {
          // Already on screen: this navigation was about the pane showing it.
          if (state.focus !== owner) {
            state = { ...state, focus: owner }
            notify()
          }
          return
        }
        const target = state.focus === null || !list.some((pane) => pane.id === state.focus)
          ? list[0].id
          : state.focus
        controller.assignSession(target, sessionId)
      }

      const controller = {
        source: {
          getSnapshot: () => published,
          subscribe: (listener) => {
            listeners.add(listener)
            return () => { listeners.delete(listener) }
          },
        },

        /**
         * Move the focus ring, and hand the app-level current Session to the pane that now has
         * focus.
         *
         * This is the single choke point for focus (clicks, `Ctrl+Alt+1..4`, drag focus), so the
         * follow lives here rather than at each call site; {@link syncRightbarToFocus} re-checks
         * every gate, defers while the column is collapsed, and coalesces rapid switches.
         */
        focusPane(paneId) {
          if (state.focus === paneId) return
          state = { ...state, focus: paneId }
          notify()
          syncRightbarToFocus()
        },

        /**
         * Show the overlay.
         *
         * A single pane is single-window territory — the native view already shows
         * it, and everything this overlay adds (adoption, focus, the pane ring)
         * assumes a split — so the overlay is only ever open with at least two panes.
         */
        openOverlay() {
          overlayToken += 1
          if (state.open || panes().length < 2) return
          // The overlay covers the native conversation, so one pane has to stand in for what the
          // user was reading. A restored layout can hold older Sessions (or none), and opening the
          // split on those is what read as "my window was replaced": adopt the current Session
          // into the focused pane first. When `splitWith` just placed it, this is a no-op.
          const sessionId = currentSessionId()
          if (sessionId !== undefined && paneOfSession(sessionId) === undefined) {
            const list = panes()
            const target = state.focus !== null && list.some((pane) => pane.id === state.focus)
              ? state.focus
              : list[0].id
            controller.assignSession(target, sessionId)
          }
          state = { ...state, open: true, closing: false }
          setCovered(true)
          notify()
        },

        /**
         * Hide the overlay and hand the column back to a *fresh* conversation
         * mount.
         *
         * The covered conversation panel has been sharing the panes' composer
         * editors, and a pane's unmount releases the editor root, so the column
         * is parked on the empty panel first (hidden behind the overlay) and
         * returned to the conversation in the frame after the overlay is gone.
         * One commit then runs the pane cleanups before the conversation's
         * effects, which rebinds each session's editor to its own composer.
         */
        closeOverlay() {
          if (!state.open) return
          // Single-window mode owns the navigation again: nothing deferred may leak across.
          deferredSession = null
          pendingFollow = null
          followQueued = null
          if (followTimer !== null) {
            window.clearTimeout(followTimer)
            followTimer = null
          }
          const token = ++overlayToken
          let previous = null
          try {
            previous = layout.panelInfo.getSnapshot().activePanelId
          } catch (error) {
            previous = null
          }
          try {
            layout.selectPanel(VOID_PANEL_ID)
          } catch (error) {
            console.warn('[dsh-split] could not park the column', error)
          }
          if (!isParked()) {
            // Unreachable while the empty panel is registered; if it ever happens the
            // covered composer cannot be released, so the failure must not be silent.
            console.warn('[dsh-split] the conversation column did not park: the single-window composer may need a session switch')
          }
          let settled = false
          const restore = () => {
            if (settled) return
            settled = true
            // A disposed instance still hands the column back — leaving it parked would blank
            // the centre column — but it no longer touches the DOM or the panel selection
            // beyond that, because a reloaded instance owns those now.
            if (!disposed) {
              if (overlayToken === token) {
                state = { ...state, open: false, closing: true }
                setCovered(false)
                notify()
                // The closing backdrop fades out over the restored conversation. It unmounts once
                // the fade is done, long after the editor handoff below has committed, so the
                // fade can never delay or reorder it.
                window.setTimeout(() => {
                  if (disposed || state.open || !state.closing) return
                  state = { ...state, closing: false }
                  notify()
                }, 150)
              } else {
                // A request arrived inside the parked frame, so the overlay stays up.
                // The column is still handed back, which remounts the covered
                // conversation; every pane therefore re-takes its composer editor.
                const next = new Map(gens)
                for (const pane of panes()) next.set(pane.id, (next.get(pane.id) ?? 0) + 1)
                gens = next
                notify()
              }
            }
            try {
              layout.selectPanel(previous === VOID_PANEL_ID ? null : previous)
            } catch (error) {
              console.warn('[dsh-split] could not restore the conversation', error)
            }
          }
          // A frame is the ordering the repair needs; the timer is the fallback for a
          // window where animation frames are paused (hidden or occluded), where a
          // pending park would otherwise keep `open` true and swallow the next chord.
          if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(restore)
          else window.setTimeout(restore, 0)
          window.setTimeout(restore, 250)
        },

        /** Enter the split view, or hand the column back. */
        toggleOverlay() {
          if (state.open) controller.closeOverlay()
          else controller.openOverlay()
        },

        /** Bind a Session to one pane, refusing a Session that is already shown. */
        assignSession(paneId, sessionId) {
          const owner = paneOfSession(sessionId)
          if (owner === paneId) return true
          if (owner !== undefined) {
            controller.focusPane(owner)
            return false
          }
          let reference
          try {
            reference = retainFor(paneId, sessionId)
          } catch (error) {
            console.warn('[dsh-split] cannot retain session ' + String(sessionId), error)
            return false
          }
          const previous = refs.get(paneId)
          const next = new Map(refs)
          next.set(paneId, reference)
          refs = next
          state = { ...state, root: withSession(state.root, paneId, sessionId) }
          notify()
          if (previous !== undefined) {
            try {
              previous.release()
            } catch (error) {
              console.warn('[dsh-split] reference release failed', error)
            }
          }
          // Binding a Session into the focused pane changes what the column should follow. The
          // `state.open` gate keeps this out of split setup, where panes are filled before the
          // overlay exists.
          if (state.open && state.focus === paneId) syncRightbarToFocus()
          return true
        },

        /**
         * The Sidebar menu's split action: put this Session beside what the user
         * is looking at.
         *
         * A Session already on screen is focused instead of duplicated: one
         * Session owns exactly one conversation editor, so two panes on the same
         * Session would fight over it.
         */
        splitWith(sessionId, dir) {
          const owner = paneOfSession(sessionId)
          const list = panes()
          // A Session already on screen is focused rather than duplicated: one Session owns
          // one editor. With a single pane there is nothing to focus into, and the user did
          // ask for a split — so it opens one beside it and leaves the new pane to choose.
          if (owner !== undefined && list.length >= 2) {
            controller.openOverlay()
            controller.focusPane(owner)
            return true
          }
          if (list.length >= MAX_PANES) return false
          // The pane to split: whatever shows the current Session, else the focused
          // pane, else the first one. `state.root` always holds at least one pane
          // (sanitize and closePane both guarantee it), so an empty tree cannot
          // reach here — and splitPane below still validates the id.
          let anchor = paneOfSession(currentSessionId())
          if (anchor === undefined) {
            anchor = state.focus !== null && list.some((pane) => pane.id === state.focus)
              ? state.focus
              : list[0].id
          }
          // The anchor has to show what the user is looking at. The overlay covers the native
          // conversation, and a persisted layout can hold an older Session, so seeding an *empty*
          // anchor is not enough: opening a split on a stale pane is what read as "my window was
          // replaced". Seeding is skipped when the Session being split is not on screen yet, so
          // the new pane still gets what the user asked for.
          const current = currentSessionId()
          const anchorPane = list.find((pane) => pane.id === anchor)
          if (anchorPane !== undefined && current !== undefined && anchorPane.s !== current) {
            controller.assignSession(anchor, current)
          }
          // A split must produce two real conversations: the requested Session when it is not on
          // screen yet, otherwise the most recent Session that is not on screen either. A pane
          // that only asks the user to choose is never the outcome of a split.
          const target = paneOfSession(sessionId) === undefined
            ? sessionId
            : nextOffScreenSession(sessionId)
          if (target === undefined) return false
          const created = controller.splitPane(anchor, dir)
          if (created === null) return false
          controller.assignSession(created, target)
          // Opened last: the overlay only opens once the split actually exists.
          controller.openOverlay()
          // The new pane holds the focus now; let the column follow it (deferred while collapsed).
          syncRightbarToFocus()
          return true
        },

        /** Split one pane in two, leaving the new pane empty and focused. */
        splitPane(paneId, dir) {
          if (panes().length >= MAX_PANES) return null
          const current = panes().find((pane) => pane.id === paneId)
          if (current === undefined) return null
          const created = { t: 'p', id: nextId('pane'), s: null }
          const split = { t: 's', id: nextId('split'), dir: dir === 'col' ? 'col' : 'row', r: 0.5, a: current, b: created }
          state = { ...state, root: replacePane(state.root, paneId, () => split), focus: created.id }
          notify()
          return created.id
        },

        /**
         * Trade two panes' contents.
         *
         * The references travel with the Sessions, so nothing is re-retained and
         * no history is reopened; the two conversations remount because their
         * provider key changed, which is what a deliberate drag costs.
         */
        swapPanes(fromId, toId) {
          if (fromId === toId) return
          const list = panes()
          const from = list.find((pane) => pane.id === fromId)
          const to = list.find((pane) => pane.id === toId)
          if (from === undefined || to === undefined) return
          const fromRef = refs.get(fromId)
          const toRef = refs.get(toId)
          const next = new Map(refs)
          if (toRef === undefined) next.delete(fromId)
          else next.set(fromId, toRef)
          if (fromRef === undefined) next.delete(toId)
          else next.set(toId, fromRef)
          refs = next
          state = {
            ...state,
            root: withSession(withSession(state.root, fromId, to.s), toId, from.s),
          }
          notify()
        },

        /** Close one pane; the last one stays as an empty pane instead of vanishing. */
        closePane(paneId) {
          if (panes().length <= 1) {
            // Empty the pane *before* releasing its reference: a release publishes the
            // session list, and a re-entrant pass has to see a pane that is already
            // consistent (no Session, no reference) or it re-retains it as an orphan.
            state = { ...state, root: withSession(state.root, paneId, null), focus: paneId }
            forgetPane(paneId)
            notify()
            controller.closeOverlay()
            return
          }
          const removed = removePane(state.root, paneId)
          const root = removed ?? { t: 'p', id: nextId('pane'), s: null }
          const remaining = listPanes(root)
          const focusMoved = state.focus === paneId
          const focus = focusMoved ? (remaining[0] === undefined ? null : remaining[0].id) : state.focus
          state = { ...state, root, focus }
          forgetPane(paneId)
          notify()
          // The focus moved off the closed pane: the column follows the survivor (deferred while
          // collapsed). Collapsing to one pane is single-window territory, where `followCurrent`
          // below already owns the navigation.
          if (focusMoved && remaining.length > 1) syncRightbarToFocus()
          if (remaining.length <= 1) {
            // One pane is single-window territory: hand the window back, showing
            // the Session that survived.
            if (focus !== null) followCurrent(focus)
            controller.closeOverlay()
          }
        },

        /** Move one split's divider. */
        setRatio(splitId, ratio) {
          const next = setRatio(state.root, splitId, clampRatio(ratio))
          if (next === state.root) return
          state = { ...state, root: next }
          notify()
        },

        /** Focus the Nth pane from the window keyboard. */
        focusIndex(index) {
          const pane = panes()[index]
          if (pane === undefined) return
          controller.openOverlay()
          controller.focusPane(pane.id)
        },

        /** Close the focused pane from the window keyboard. */
        closeFocused() {
          // A closed overlay has no visible pane to close; opening one to close
          // something in it would only thrash the covered column.
          if (!state.open) return
          if (state.focus !== null) controller.closePane(state.focus)
        },

        /**
         * Toggle the right column through its own service, the same call the
         * shipped shortcut makes. The shipped expand button lives in the
         * conversation header, which the overlay covers, so the pane chrome
         * carries its own.
         *
         * It acts on the app-wide current Session, not on the clicked pane: the
         * right column is a single Session-scoped surface and this plugin
         * deliberately adds no focus-following to it.
         */
        toggleRightbar() {
          const toggle = () => {
            if (disposed) return false
            try {
              ctx.sidebarRight.toggleExpanded()
              return true
            } catch (error) {
              // No session surface is mounted yet: the contract reports it, and
              // a retry on the next turn usually finds the surface.
              console.warn('[dsh-split] right sidebar toggle failed', error)
              return false
            }
          }
          // The column is about to become visible: apply the follow that was deferred while it
          // was collapsed, so what it shows is the focused pane's Session (and its start page).
          if (!rightbarDrawnOpen() && deferredSession !== null) {
            const sessionId = deferredSession
            deferredSession = null
            if (applyFollow(sessionId)) return
          }
          if (toggle()) return
          window.setTimeout(() => { toggle() }, 0)
        },

        /** True when this Session already occupies a pane. */
        isOpen(sessionId) {
          return paneOfSession(sessionId) !== undefined
        },

        /** Publish the centre-column hook; see {@link markCenter}. */
        markCenter() {
          markCenter()
        },

        /**
         * True when the menu action can put this Session on screen.
         *
         * With the Session already on screen the action focuses it, or opens a split beside it —
         * which needs another Session to show. Without one the entry would only open a pane that
         * asks the user to choose, so it greys out instead.
         */
        canSplit(sessionId) {
          if (panes().length >= MAX_PANES) return false
          if (paneOfSession(sessionId) === undefined) return true
          return panes().length >= 2 || nextOffScreenSession(sessionId) !== undefined
        },

        /** The inject face the overlay and the Sidebar menu rows receive. */
        injectFace() {
          return {
            hooks: { split: controller.source },
            closePane: (paneId) => { controller.closePane(paneId) },
            assignSession: (paneId, sessionId) => controller.assignSession(paneId, sessionId),
            focusPane: (paneId) => { controller.focusPane(paneId) },
            setRatio: (splitId, ratio) => { controller.setRatio(splitId, ratio) },
            swapPanes: (fromId, toId) => { controller.swapPanes(fromId, toId) },
            toggleRightbar: () => { controller.toggleRightbar() },
            isOpen: (sessionId) => controller.isOpen(sessionId),
          }
        },

        /**
         * Repair the covered conversation after this plugin goes away.
         *
         * The overlay takes the panes' composer bindings with it, so the column
         * is parked and returned once React has committed that unmount. Runs late
         * in teardown (its effect is created before the registrations it must
         * outlive).
         */
        repairOnTeardown() {
          if (!state.open) return
          let previous = null
          try {
            previous = layout.panelInfo.getSnapshot().activePanelId
          } catch (error) {
            previous = null
          }
          try {
            layout.selectPanel(VOID_PANEL_ID)
          } catch (error) {
            console.warn('[dsh-split] could not park the column on teardown', error)
          }
          let settled = false
          const restore = () => {
            if (settled) return
            settled = true
            try {
              layout.selectPanel(previous === VOID_PANEL_ID ? null : previous)
            } catch (error) {
              console.warn('[dsh-split] could not restore the conversation', error)
            }
          }
          // After the renderer has removed the overlay and released the editors. Two frames
          // are the honest signal that React has committed that unmount; the timer covers a
          // window where frames are paused. `releaseCenter` is deliberately NOT called here:
          // teardown already released the frame, and a late call from a disposed instance
          // would strip the centre-column marker that a reloaded instance has just published.
          if (typeof window.requestAnimationFrame === 'function') {
            window.requestAnimationFrame(() => { window.requestAnimationFrame(restore) })
          }
          window.setTimeout(restore, 250)
        },

        /**
         * Retain a reference for every restored pane Session once the catalog is ready.
         *
         * `retain` opens the Session and publishes the list synchronously, so this pass is
         * re-entered while its own work is still in flight — from `assignSession` too, which
         * retains outside this method. Two rules keep that safe: skip a pane that is already
         * filled (or being filled), and commit each reference onto the *current* map one at a
         * time. A snapshot taken before the loop would drop the nested pass's work and leave
         * its references held by nobody, so they would never be released.
         */
        materialize() {
          let list
          try {
            list = sessions.list.getSnapshot()
          } catch (error) {
            console.warn('[dsh-split] could not read the session list', error)
            return
          }
          if (list.phase !== 'ready') return
          let changed = false
          // A Session that left the catalogue can no longer be rendered: empty the pane
          // first, release after — so anything the release publishes sees a consistent tree.
          // Both indexes must agree before a pane is emptied.
          for (const pane of panes()) {
            if (pane.s === null) continue
            if (list.ids.indexOf(pane.s) !== -1 || list.byId[pane.s] !== undefined) continue
            state = { ...state, root: withSession(state.root, pane.id, null) }
            dropReference(pane.id)
            changed = true
          }
          for (const pane of panes()) {
            if (pane.s === null || refs.has(pane.id) || pendingRefs.has(pane.id)) continue
            let reference
            try {
              reference = retainFor(pane.id, pane.s)
            } catch (error) {
              // The pre-pass above already emptied every pane whose Session left the
              // catalogue, so reaching here means the Session is listed but cannot be
              // opened: leave the pane on its picker rather than guessing.
              console.warn('[dsh-split] cannot restore session ' + String(pane.s), error)
              continue
            }
            const next = new Map(refs)
            next.set(pane.id, reference)
            refs = next
            changed = true
          }
          if (!changed) return
          notify()
        },

        /** Release every reference and every subscription. */
        dispose() {
          disposed = true
          if (followTimer !== null) {
            window.clearTimeout(followTimer)
            followTimer = null
          }
          followQueued = null
          deferredSession = null
          pendingFollow = null
          releaseCenter()
          if (persistTimer !== null) {
            window.clearTimeout(persistTimer)
            persistTimer = null
          }
          // Flush the pending write: teardown (including an HMR reload) must not lose
          // a layout the user just arranged.
          writeLayout()
          for (const reference of refs.values()) {
            try {
              reference.release()
            } catch (error) {
              console.warn('[dsh-split] reference release failed', error)
            }
          }
          refs = new Map()
          for (const dispose of disposers) dispose()
          disposers.length = 0
          listeners.clear()
        },
      }

      // A Session the user navigated to is adopted while the overlay is up, and
      // the pane already showing it takes its composer editor back.
      try {
        disposers.push(ctx.uiSession.adapter.current.subscribe(() => {
          adoptCurrent()
          const sessionId = currentSessionId()
          if (sessionId !== undefined) bumpPaneShown(sessionId)
        }))
      } catch (error) {
        console.warn('[dsh-split] could not watch the current session', error)
      }
      try {
        disposers.push(sessions.list.subscribe(() => { controller.materialize() }))
      } catch (error) {
        console.warn('[dsh-split] could not watch the session list', error)
      }
      controller.materialize()
      return controller
    }

    /* ------------------------------------------------------------------ *
     * Components
     * ------------------------------------------------------------------ */

    /** One draggable divider; it is also the gap between two panes. */
    function Splitter(props) {
      const element = React.useRef(null)
      const [dragging, setDragging] = React.useState(false)
      const latest = React.useRef({ ratio: props.ratio, drag: null })

      /** The two cells this divider separates, in render order. */
      function cells() {
        const node = element.current
        const container = node === null ? null : node.parentElement
        if (container === null || container.children.length < 3) return null
        return { first: container.children[0], second: container.children[2] }
      }

      /**
       * Show a share immediately.
       *
       * A drag writes the two cells rather than publishing a ratio: a published ratio
       * changes the layout tree's identity and re-renders every mounted transcript,
       * once per frame. The commit happens on release.
       */
      function preview(ratio) {
        const target = cells()
        if (target === null) return
        target.first.style.flex = String(ratio) + ' 1 0%'
        target.second.style.flex = String(1 - ratio) + ' 1 0%'
      }

      function endDrag(commit) {
        const drag = latest.current.drag
        if (drag === null) return
        latest.current.drag = null
        if (drag.element.hasPointerCapture(drag.pointerId)) drag.element.releasePointerCapture(drag.pointerId)
        setDragging(false)
        if (commit) props.onRatio(latest.current.ratio)
      }

      React.useEffect(() => () => endDrag(false), [])

      /** The share under one pointer event, or null when no drag is armed. */
      function ratioAt(event) {
        const drag = latest.current.drag
        if (drag === null) return null
        const at = props.dir === 'row' ? event.clientX : event.clientY
        return clampRatio(drag.start + (at - drag.origin) / drag.along)
      }

      function onPointerDown(event) {
        if (event.button !== 0) return
        const node = element.current
        const container = node === null ? null : node.parentElement
        if (node === null || container === null) return
        event.preventDefault()
        const box = container.getBoundingClientRect()
        const handle = node.getBoundingClientRect()
        // The cells share the container minus this handle, so the handle's own extent
        // belongs out of the denominator — otherwise the divider lags the pointer.
        const along = props.dir === 'row' ? box.width - handle.width : box.height - handle.height
        if (along <= 0) return
        latest.current = {
          ratio: props.ratio,
          drag: {
            element: node,
            pointerId: event.pointerId,
            start: props.ratio,
            origin: props.dir === 'row' ? event.clientX : event.clientY,
            along,
          },
        }
        node.setPointerCapture(event.pointerId)
        setDragging(true)
      }

      function onPointerMove(event) {
        const drag = latest.current.drag
        if (drag === null || drag.pointerId !== event.pointerId) return
        const ratio = ratioAt(event)
        if (ratio === null) return
        latest.current.ratio = ratio
        preview(ratio)
      }

      function onPointerUp(event) {
        const drag = latest.current.drag
        if (drag === null || drag.pointerId !== event.pointerId) return
        const ratio = ratioAt(event)
        if (ratio !== null) latest.current.ratio = ratio
        endDrag(true)
      }

      return h('div', {
        ref: element,
        role: 'separator',
        'aria-orientation': props.dir === 'row' ? 'vertical' : 'horizontal',
        className: 'dsh-split-handle ' + (props.dir === 'row' ? 'is-row' : 'is-col') + (dragging ? ' is-dragging' : ''),
        onPointerDown,
        onPointerMove,
        onPointerUp,
        // A cancelled or lost capture must not leave the divider armed: the next move
        // with the same pointer id would resume from a stale origin.
        onPointerCancel: () => endDrag(true),
        onLostPointerCapture: () => endDrag(true),
        onDoubleClick: () => { props.onRatio(0.5) },
      })
    }

    /** One icon control in a pane's title bar. */
    function ChromeButton(props) {
      return h(Tooltip, { label: props.label, side: 'bottom', align: 'end', delayMs: 400, portal: true },
        h(Button, {
          size: 'sm',
          variant: 'ghost',
          'aria-label': props.label,
          onClick: props.onClick,
          icon: props.icon,
        }))
    }

    /** The pane id under one viewport point, or null. */
    function paneAt(x, y) {
      const element = document.elementFromPoint(x, y)
      if (element === null) return null
      const section = element.closest('[data-split-pane]')
      return section === null ? null : section.getAttribute('data-split-pane')
    }

    /**
     * One pane's title strip: the Session title, the hover-revealed controls, and
     * — over the whole strip — the drag handle that swaps two panes.
     *
     * This strip is not a session switcher: the title is plain text. It stands in
     * for a header the framework cannot render per pane (see the module doc).
     */
    function PaneChrome(props) {
      const { sessionId, dragApi, paneId, useSessions, t } = props
      const title = useSessions((state) => {
        const summary = sessionId === null ? undefined : state.byId[sessionId]
        return summary === undefined ? undefined : summary.displayTitle
      })
      const running = useSessions((state) => {
        const summary = sessionId === null ? undefined : state.byId[sessionId]
        return summary !== undefined && summary.running
      })
      /** Set by a finished drag so the click it would otherwise deliver is dropped. */
      const suppressClick = React.useRef(false)
      /** The window listeners of the drag in progress, so unmount can end it. */
      const dragListeners = React.useRef(null)

      const stopDrag = React.useCallback(() => {
        const current = dragListeners.current
        if (current === null) return
        dragListeners.current = null
        window.removeEventListener('pointermove', current.move)
        window.removeEventListener('pointerup', current.up)
        window.removeEventListener('pointercancel', current.up)
      }, [])

      // Closing the overlay, closing the pane, or collapsing to one pane can all
      // unmount this strip mid-drag: the window listeners must not outlive it, or
      // every later pointer move keeps hit-testing a tree that is gone.
      React.useEffect(() => stopDrag, [stopDrag])

      function onPointerDown(event) {
        suppressClick.current = false
        if (event.button !== 0) return
        stopDrag()
        const origin = { x: event.clientX, y: event.clientY }
        let dragging = false
        const onMove = (moveEvent) => {
          if (!dragging) {
            const travelled = Math.abs(moveEvent.clientX - origin.x) + Math.abs(moveEvent.clientY - origin.y)
            if (travelled < DRAG_THRESHOLD) return
            dragging = true
            dragApi.start(paneId)
          }
          dragApi.target(paneAt(moveEvent.clientX, moveEvent.clientY))
        }
        const onUp = (upEvent) => {
          stopDrag()
          if (!dragging) return
          suppressClick.current = true
          dragApi.drop(paneId, paneAt(upEvent.clientX, upEvent.clientY))
        }
        dragListeners.current = { move: onMove, up: onUp }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onUp)
      }

      const label = title ?? t('pane.empty')
      return h('header', {
        className: 'dsh-split-chrome',
        onPointerDown,
        onClickCapture: (event) => {
          if (!suppressClick.current) return
          suppressClick.current = false
          event.stopPropagation()
          event.preventDefault()
        },
      },
      running ? h(StateDot, { state: 'ongoing', size: 12 }) : null,
      h('span', { className: 'dsh-split-title', title: label }, label),
      h('div', { className: 'dsh-split-actions' },
        h(ChromeButton, {
          label: t('pane.toggleRightbar'),
          onClick: () => { props.onToggleRightbar() },
          icon: h('span', { className: 'dsh-split-mirror' }, h(IconPanelLeftOutlineRegular, { size: 15 })),
        }),
        h(ChromeButton, {
          label: t('pane.close'),
          onClick: () => { props.onClose() },
          icon: h(IconCloseOutlineRegular, { size: 14 }),
        })))
    }

    /** The Session picker: the body of a pane that has no Session bound. */
    function PanePicker(props) {
      const { useSessions, excluding, hint } = props
      const ids = useSessions((state) => state.ids)
      const byId = useSessions((state) => state.byId)
      const rows = []
      for (const id of ids) {
        if (id === excluding) continue
        if (props.isOpen(id)) continue
        rows.push(h(SessionRow, {
          key: id,
          sessionId: id,
          summary: byId[id],
          onPick: () => { props.onPick(id) },
        }))
      }
      return h('div', { className: 'dsh-split-picker' },
        h('div', { className: 'dsh-split-hint' }, hint),
        rows)
    }

    /**
     * One picker row. The summary arrives as plain data from its parent, which
     * reads the whole `byId` record in one hook call: a hook per row inside a
     * loop would break the rules of hooks.
     */
    function SessionRow(props) {
      const summary = props.summary
      const label = summary === undefined ? props.sessionId : summary.displayTitle
      const meta = summary === undefined ? '' : (summary.cwd === undefined ? '' : summary.cwd)
      return h('button', {
        type: 'button',
        className: 'dsh-split-row',
        onClick: props.onPick,
      },
      summary !== undefined && summary.running ? h(StateDot, { state: 'ongoing', size: 12 }) : null,
      h('span', { className: 'dsh-split-row-text' },
        h('span', { className: 'dsh-split-row-title' }, label),
        meta === '' ? null : h('span', { className: 'dsh-split-row-meta' }, meta)))
    }

    /**
     * Pin one pane to the Conversation view.
     *
     * An embedded occurrence otherwise follows the Session's own selected view, and
     * a pane has no header to switch it back (see the module doc), so the pane would
     * silently show a trajectory or diff. Declaring the factory's `views` local slot
     * is the same move the shipped Sidebar chat makes for its embedded occurrence.
     */
    function FixedChatView(props) {
      return h(React.Fragment, null, props.renderSlot('conversation.session', { view: 'chat' }))
    }

    /**
     * One pane's conversation: the shipped Factory, bound to this pane's Session
     * by the surrounding `SessionProvider`.
     */
    function PaneConversation(props) {
      const { sessionId, useSession, useConversation, useSessions, renderFactorySlot } = props
      const session = useSession((value) => value)
      const conversation = useConversation((value) => value)
      const summaryBlank = useSessions((state) => {
        const summary = sessionId === undefined ? undefined : state.byId[sessionId]
        return summary === undefined ? undefined : summary.blank
      })
      if (session === undefined || conversation === undefined) {
        return renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'settling', hero: false },
          { slots: { views: FixedChatView } })
      }
      // Phase derivation follows the shipped embedded host (ui-subagent): the
      // main host's helper is package-private, these facts are the public face.
      // The host's own phase vocabulary collapses to one distinction here — a
      // Session with no activity yet, which is the only case it presents
      // differently — so this keeps the boolean rather than a phase name.
      const active = conversation.activeTargets.size > 0
        || (!session.blank && !session.awaitingFirstTurn)
        || session.running
      const noActivity = !active && !session.promptAttempted
      const subagent = session.subagent
      const parentPending = subagent !== undefined && subagent !== null
        && subagent.address.mode === 'continuable' && subagent.parentAvailable === undefined
      const settling = (noActivity && session.openState === 'loading' && summaryBlank !== true) || parentPending
      const hero = noActivity && (session.openState === 'open' || summaryBlank === true)
      const phase = settling ? 'settling' : hero ? 'hero' : 'active'
      return renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero },
        { slots: { views: FixedChatView } })
    }

    /**
     * One pane: its title strip and, once staged in, its shipped conversation.
     *
     * Memoized on purpose. The layout tree is built with structural sharing, so any
     * interaction that leaves this pane's node, reference, generation, and stage
     * untouched hands React identical prop values and skips the whole subtree —
     * including a mounted transcript. That is why the focus ring and the drag
     * highlight are *not* props: the overlay paints them onto the DOM instead, which
     * is what keeps a click or a hover off every conversation in the split.
     *
     * @param props - pane data, its retained reference, its stage, and the operations
     *   the pane calls back into.
     * @returns the pane section.
     */
    const Pane = React.memo(function Pane(props) {
      const {
        pane, reference, generation, staged, useSessions, isOpen, assignSession,
        closePane, focusPane, toggleRightbar, dragApi, renderSlot, SessionProvider, t, onNotice,
      } = props
      // The chrome reads `pane.s` while the body reads the retained reference, so a
      // disagreement would draw one Session's title over another's transcript. Both come
      // from the same tree node, so this can only fire if some operation ever updates one
      // side without the other — and then an empty pane is the honest state, not a wrong
      // one. It also turns that failure into a console line instead of a silent mismatch.
      const mismatch = reference !== undefined && pane.s !== reference.sessionId
      // Warned from an effect, not from render: React may render without committing, and a
      // mismatch that persists would otherwise repeat the same line on every render and bury
      // the one line that matters.
      React.useEffect(() => {
        if (!mismatch) return
        console.warn('[dsh-split] pane/session mismatch',
          pane.id, String(pane.s), String(reference.sessionId))
      }, [mismatch, pane.id, pane.s, reference])
      let body = null
      if (staged) {
        if (reference === undefined || mismatch) {
          body = h(PanePicker, {
            useSessions,
            excluding: pane.s,
            isOpen,
            hint: t(pane.s === null ? 'picker.hint' : 'pane.unavailable'),
            onPick: (sessionId) => {
              // The picker hides Sessions already on screen, so a refusal here means
              // the Session could not be retained: it is gone or unreachable.
              if (!assignSession(pane.id, sessionId)) {
                onNotice(t(isOpen(sessionId) ? 'notice.taken' : 'notice.unavailable'))
              }
            },
          })
        } else {
          body = h(SessionProvider, {
            key: reference.sessionId + '#' + String(generation),
            session: reference,
            empty: () => h('div', { className: 'dsh-split-picker' },
              h('div', { className: 'dsh-split-hint' }, t('pane.unavailable'))),
          }, h('div', { className: 'dsh-split-body' }, renderSlot('split.pane', { paneId: pane.id })))
        }
      }
      return h('section', {
        className: 'dsh-split-pane',
        'data-split-pane': pane.id,
        'data-split-session': pane.s === null ? '' : pane.s,
        // Clicking a pane only moves the focus ring. It deliberately does not
        // navigate: making a pane's Session current would remount the covered
        // conversation panel, whose composer mounts onto the shared editor and takes
        // it away from this pane. Sidebar navigation still fills a pane (see
        // adoptCurrent), and that path remounts the pane in the same commit.
        onPointerDownCapture: () => { focusPane(pane.id) },
        onFocus: () => { focusPane(pane.id) },
      },
      h(PaneChrome, {
        useSessions,
        sessionId: pane.s,
        paneId: pane.id,
        dragApi,
        t,
        onToggleRightbar: () => { toggleRightbar() },
        onClose: () => { closePane(pane.id) },
      }),
      body)
    })

    /**
     * The overlay: a split tree of panes, sized to the conversation column.
     *
     * The box is measured rather than guessed: the layer the entry renders into
     * spans the whole frame, so covering only the centre column means reading that
     * column's box and following it while the columns move.
     */
    function SplitOverlay(props) {
      const {
        useSplit, closePane, assignSession, focusPane, swapPanes,
        toggleRightbar, isOpen,
        renderSlot, SessionProvider, useSessions, t,
      } = props
      const root = useSplit((state) => state.root)
      const focus = useSplit((state) => state.focus)
      const refs = useSplit((state) => state.refs)
      const gens = useSplit((state) => state.gens)
      const open = useSplit((state) => state.open)
      const closing = useSplit((state) => state.closing)
      const panes = listPanes(root)
      const [notice, setNotice] = React.useState('')
      const [drag, setDrag] = React.useState({ source: null, target: null })
      const [staged, setStaged] = React.useState(0)
      const element = React.useRef(null)
      const noticeTimer = React.useRef(null)

      React.useEffect(() => () => {
        if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
      }, [])

      /**
       * The order pane bodies mount in: the focused pane first, then left to right.
       *
       * Opening the split mounts a full transcript per pane, and a transcript is the
       * most expensive subtree in the app. Mounting them one per frame keeps every
       * frame short, so the overlay paints and stays interactive immediately instead
       * of blocking on the widest commit the layout can produce.
       */
      const stages = React.useMemo(() => {
        const list = listPanes(root)
        const focused = list.filter((pane) => pane.id === focus)
        return focused.concat(list.filter((pane) => pane.id !== focus)).map((pane) => pane.id)
      }, [root, focus])

      React.useEffect(() => {
        if (!open) {
          setStaged(0)
          // A drag that was interrupted by closing the view must not come back with the
          // highlight still painted when it reopens.
          setDrag((previous) => (previous.source === null && previous.target === null
            ? previous
            : { source: null, target: null }))
          return undefined
        }
        if (staged >= stages.length) return undefined
        let settled = false
        const step = () => {
          if (settled) return
          settled = true
          setStaged((value) => value + 1)
        }
        // A frame is when the next transcript should mount; the timer is the fallback for a
        // window where frames are paused, which would otherwise leave every pane as empty
        // chrome until the window is shown again.
        const frame = window.requestAnimationFrame(step)
        const timer = window.setTimeout(step, 250)
        return () => {
          window.cancelAnimationFrame(frame)
          window.clearTimeout(timer)
        }
      }, [open, staged, stages.length])

      /**
       * Paint the interaction chrome onto the panes.
       *
       * Runs after every render and is idempotent: a focus move or a drag hover
       * changes only these classes, so the panes themselves keep identical props and
       * the memo boundary holds. A structural render repaints them here too.
       */
      React.useLayoutEffect(() => {
        const node = element.current
        if (node === null) return
        for (const section of node.querySelectorAll('[data-split-pane]')) {
          const id = section.getAttribute('data-split-pane')
          section.classList.toggle('is-focused', id === focus)
          section.classList.toggle('is-dragging', drag.source === id)
          section.classList.toggle('is-drop-target',
            drag.source !== null && drag.target === id && drag.source !== id)
        }
      })

      /**
       * Slide surviving panes into their new places when one is closed.
       *
       * FLIP on transforms only: the pane boxes before the removal are remembered each render,
       * and when a pane disappears the survivors are translated from their old spot to the new
       * one on the compositor — no layout or paint work over the transcripts. Pane bodies are
       * memoized, so the slide is a class/style write, never a re-render.
       */
      const paneRects = React.useRef(new Map())
      React.useLayoutEffect(() => {
        if (!open) {
          paneRects.current = new Map()
          return undefined
        }
        const node = element.current
        if (node === null || typeof node.querySelectorAll !== 'function') return undefined
        const now = new Map()
        const sections = []
        for (const section of node.querySelectorAll('[data-split-pane]')) {
          const id = section.getAttribute('data-split-pane')
          if (id === null) continue
          sections.push(section)
          const rect = section.getBoundingClientRect()
          if (rect !== null && typeof rect === 'object'
            && typeof rect.left === 'number' && typeof rect.top === 'number') {
            now.set(id, rect)
          }
        }
        const previous = paneRects.current
        const lost = [...previous.keys()].some((id) => !now.has(id))
        if (lost) {
          for (const [id, rect] of now) {
            const before = previous.get(id)
            if (before === undefined) continue
            const section = sections.find((candidate) => candidate.getAttribute('data-split-pane') === id)
            if (section === undefined || typeof section.style === 'undefined') continue
            const dx = before.left - rect.left
            const dy = before.top - rect.top
            if (dx === 0 && dy === 0) continue
            section.style.transition = 'none'
            section.style.transform = 'translate(' + dx + 'px, ' + dy + 'px)'
            if (typeof section.offsetWidth === 'number') void section.offsetWidth
            section.style.transition = 'transform var(--dsh-split-duration, 120ms) ease-out'
            section.style.transform = ''
            window.setTimeout(() => {
              section.style.transition = ''
            }, 150)
          }
        }
        paneRects.current = now
      })

      /** The centre column the overlay covers, the layer it renders into, and the frame. */
      function targets() {
        const layer = element.current === null ? null : element.current.closest('[data-shell-overlay]')
        const frame = layer === null ? null : layer.parentElement
        if (frame === null) return null
        const rightbar = frame.querySelector('[data-rightbar-col]')
        const center = rightbar === null ? frame.children[1] : rightbar.previousElementSibling
        if (center === undefined || center === null) return null
        return { frame, layer, center }
      }

      // Follow the column while the frame's tracks move (sidebar collapse, a
      // dragged width, the right column opening or closing, a window resize).
      //
      // Written straight to the element instead of through state: a track move
      // must never re-render the panes, or opening the right column would repaint
      // every mounted transcript.
      //
      // The box comes from the column's own viewport rect rather than its offset
      // parent's: the overlay layer spans the frame's padding box, which includes
      // the Windows caption band, so a layer-relative zero would put the panes
      // over the app's menu and window controls — and the top-right pane's own
      // controls under them. A layout effect, so this lands before the first paint.
      React.useLayoutEffect(() => {
        if (!open) return undefined
        const measure = () => {
          const found = targets()
          const node = element.current
          if (node === null) return
          if (found === null) {
            // No column to measure: stay clear of the caption band rather than
            // falling back to the full layer, which would swallow its controls.
            node.style.top = 'var(--dsh-windows-titlebar-height, 0px)'
            return
          }
          const layerRect = found.layer.getBoundingClientRect()
          const rect = found.center.getBoundingClientRect()
          node.style.left = String(rect.left - layerRect.left) + 'px'
          node.style.top = String(rect.top - layerRect.top) + 'px'
          node.style.width = String(rect.width) + 'px'
          node.style.height = String(rect.height) + 'px'
        }
        measure()
        const found = targets()
        const animating = new MutationObserver(() => {
          const current = targets()
          const node = element.current
          if (current === null || node === null) return
          if (current.frame.hasAttribute('data-animating')) {
            node.setAttribute('data-split-animating', '')
          } else {
            node.removeAttribute('data-split-animating')
            measure()
          }
        })
        let trailing = null
        const settle = () => {
          const node = element.current
          if (node !== null) node.removeAttribute('data-split-animating')
          measure()
        }
        const observer = new ResizeObserver(() => {
          const found = targets()
          if (found !== null && found.frame.hasAttribute('data-animating')) {
            // The box is frozen for the slide. The frame's animating marker outlives its own
            // (now shortened) motion, so settle on motion silence instead: a moment after the
            // last change, re-measure once — still hidden behind the dim.
            if (trailing === null) {
              trailing = window.setTimeout(() => { trailing = null; settle() }, 90)
            }
            return
          }
          measure()
        })
        if (found !== null) {
          observer.observe(found.center)
          observer.observe(found.frame)
          animating.observe(found.frame, { attributes: true, attributeFilter: ['data-animating'] })
        }
        window.addEventListener('resize', measure)
        return () => {
          if (trailing !== null) window.clearTimeout(trailing)
          animating.disconnect()
          observer.disconnect()
          window.removeEventListener('resize', measure)
        }
      }, [open])

      // While the split is open, the frame's track slide runs at the split's shorter duration
      // (see the sheet's `[data-dsh-split-open]` override) so the frozen window stays brief.
      // A layout effect, so the marker is present before the first paint.
      React.useLayoutEffect(() => {
        const found = targets()
        if (found === null) return undefined
        found.frame.setAttribute('data-dsh-split-open', '')
        return () => { found.frame.removeAttribute('data-dsh-split-open') }
      }, [open])

      // The native right panel can take the whole frame; the split view yields to
      // it instead of covering it (the frame states the mode as an attribute).
      // Attributes, like the box above, are written to the DOM to avoid a render.
      React.useEffect(() => {
        if (!open) return undefined
        const found = targets()
        const node = element.current
        if (found === null || node === null) return undefined
        const sync = () => {
          if (found.frame.hasAttribute('data-rightbar-fullscreen')) node.setAttribute('data-split-yield', '')
          else node.removeAttribute('data-split-yield')
        }
        sync()
        const observer = new MutationObserver(sync)
        observer.observe(found.frame, { attributes: true, attributeFilter: ['data-rightbar-fullscreen'] })
        return () => { observer.disconnect() }
      }, [open])

      /** Stable identity, so a notice never invalidates a memoized pane. */
      const showNotice = React.useCallback((text) => {
        setNotice(text)
        if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
        noticeTimer.current = window.setTimeout(() => { setNotice('') }, 4000)
      }, [])

      /** Stable for the same reason: the drag handle lives inside a pane's chrome. */
      const dragApi = React.useMemo(() => ({
        start: (paneId) => { setDrag({ source: paneId, target: null }) },
        target: (paneId) => {
          setDrag((previous) => {
            if (previous.source === null || previous.target === paneId) return previous
            return { source: previous.source, target: paneId }
          })
        },
        drop: (paneId, target) => {
          setDrag({ source: null, target: null })
          if (target === null || target === paneId) return
          swapPanes(paneId, target)
        },
      }), [swapPanes])

      /**
       * Carry a file drag out of this subtree.
       *
       * The shipped attachment rail installs its intake on `document` in the bubble
       * phase and its `canAcceptDrop` does not consider focus, so one drop inside a
       * split view would feed every pane's composer. Fencing the bubble at the
       * overlay root keeps the drop from reaching any of them — including a drop on a
       * divider or the outer padding, which no pane covers — and the notice explains
       * the way that still works inside the target pane.
       */
      function fenceFiles(event) {
        const types = event.dataTransfer === null ? [] : Array.from(event.dataTransfer.types)
        if (types.indexOf('Files') === -1) return
        if (event.type !== 'dragleave') event.preventDefault()
        event.stopPropagation()
        if (event.type === 'dragover' && event.dataTransfer !== null) event.dataTransfer.dropEffect = 'none'
        if (event.type === 'drop') showNotice(t('notice.drop'))
      }

      function renderNode(node) {
        if (node === null) return null
        if (node.t === 'p') {
          return h(Pane, {
            key: node.id,
            pane: node,
            reference: refs.get(node.id),
            generation: gens.get(node.id) ?? 0,
            staged: staged > stages.indexOf(node.id),
            useSessions,
            isOpen,
            assignSession,
            closePane,
            focusPane,
            toggleRightbar,
            dragApi,
            renderSlot,
            SessionProvider,
            t,
            onNotice: showNotice,
          })
        }
        const children = []
        if (node.a !== null) {
          children.push(h('div', { key: node.a.id + ':a', className: 'dsh-split-cell', style: { flex: node.b === null ? '1 1 0%' : String(node.r) + ' 1 0%' } }, renderNode(node.a)))
        }
        if (node.a !== null && node.b !== null) {
          children.push(h(Splitter, {
            key: node.id + ':h',
            dir: node.dir,
            ratio: node.r,
            onRatio: (ratio) => { props.setRatio(node.id, ratio) },
          }))
        }
        if (node.b !== null) {
          children.push(h('div', { key: node.b.id + ':b', className: 'dsh-split-cell', style: { flex: node.a === null ? '1 1 0%' : String(1 - node.r) + ' 1 0%' } }, renderNode(node.b)))
        }
        return h('div', { key: node.id, className: 'dsh-split-split', style: { flexDirection: node.dir === 'row' ? 'row' : 'column' } }, children)
      }

      if (!open) {
        if (!closing) return null
        // Fade the backdrop out over the restored conversation. The panes and their editors are
        // already unmounted — the handoff committed before this render — so this shell is inert
        // and must stay clear of the caption band it was measured to avoid.
        return h('div', {
          'data-split-root': '',
          'data-split-closing': '',
          style: { top: 'var(--dsh-windows-titlebar-height, 0px)' },
        })
      }
      return h('div', {
        ref: element,
        'data-split-root': '',
        'data-split-multi': panes.length > 1 ? 'true' : 'false',
        'data-split-panes': String(panes.length),
        'data-split-staged': String(staged),
        'data-split-refs': String(refs.size),
        'data-split-focus': focus === null ? '' : focus,
        // Fenced here rather than per pane: a drop on a divider or on the overlay's
        // own padding is outside every pane, and would otherwise reach the shipped
        // document-level intake and feed every mounted composer.
        onDragEnter: fenceFiles,
        onDragLeave: fenceFiles,
        onDragOver: fenceFiles,
        onDrop: fenceFiles,
      },
      notice === '' ? null : h('div', { className: 'dsh-split-notice' }, notice),
      renderNode(root))
    }

    /** One Sidebar row-menu entry: open one Session in the split view. */
    function SplitMenuRow(props) {
      const { sessionId, useMenuOpenState, labelKey, run, canSplit, t } = props
      const setMenuOpen = useMenuOpenState()[1]
      return h(MenuItemButton, {
        icon: h(IconCompareSplitOutlineRegular, { size: 16 }),
        disabled: !canSplit(sessionId),
        onSelect: () => {
          setMenuOpen(false)
          run(sessionId)
        },
      }, t(labelKey))
    }

    /* ------------------------------------------------------------------ *
     * Apply
     * ------------------------------------------------------------------ */

    /**
     * Fixed commands, one row per action.
     *
     * The shortcut seat's registration, the reservation it holds, and the action a
     * chord runs all read from this table: a chord can neither be reserved without
     * an action nor matched without a reservation.
     */
    const COMMANDS = [
      {
        id: 'toggle',
        label: 'shortcut.toggle',
        keys: ['Ctrl+Alt+S'],
        codes: ['KeyS'],
        run: (controller) => { controller.toggleOverlay() },
      },
      {
        id: 'focus',
        label: 'shortcut.focus',
        keys: ['Ctrl+Alt+1', 'Ctrl+Alt+2', 'Ctrl+Alt+3', 'Ctrl+Alt+4'],
        codes: ['Digit1', 'Digit2', 'Digit3', 'Digit4'],
        run: (controller, index) => { controller.focusIndex(index) },
      },
      {
        id: 'close',
        label: 'shortcut.close',
        keys: ['Ctrl+Alt+W'],
        codes: ['KeyW'],
        run: (controller) => { controller.closeFocused() },
      },
    ]

    /** Every command in this plugin shares one chord family. */
    const COMMAND_MODIFIERS = ['control', 'alt']

    /** Services this plugin reads. */
    exports.inject = [
      'slots', 'sessions', 'layout', 'uiSession', 'uiWorkspace', 'sidebarRight', 'locale', 'shortcuts',
    ]

    /**
     * Activate the split view.
     * @param ctx - the client context carrying the declared services.
     */
    exports.apply = function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, {
        zh: {
          'pane.empty': '未选择会话',
          'pane.close': '关闭此格',
          'pane.toggleRightbar': '展开／收起右侧栏',
          'pane.unavailable': '会话不可用，请重新选择',
          'picker.hint': '选择一个会话放入这个分屏格子',
          'menu.splitRight': '向右分屏',
          'menu.splitDown': '向下分屏',
          'notice.taken': '该会话已在其它分屏格中',
          'notice.drop': '分屏内已停用文件拖放：请在目标格内用回形针或 /file 添加附件',
          'notice.unavailable': '这个会话现在打不开，可能已被删除',
          'shortcut.toggle': '切换分屏视图',
          'shortcut.focus': '聚焦第 N 个分屏格',
          'shortcut.close': '关闭当前分屏格',
        },
        en: {
          'pane.empty': 'No session',
          'pane.close': 'Close pane',
          'pane.toggleRightbar': 'Toggle right sidebar',
          'pane.unavailable': 'Session unavailable — choose another',
          'picker.hint': 'Choose a session for this pane',
          'menu.splitRight': 'Split right',
          'menu.splitDown': 'Split down',
          'notice.taken': 'That session is already in another pane',
          'notice.drop': 'File drop is disabled in split view — use the paperclip or /file inside the target pane',
          'notice.unavailable': 'That session cannot be opened right now — it may have been deleted',
          'shortcut.toggle': 'Toggle split view',
          'shortcut.focus': 'Focus pane N',
          'shortcut.close': 'Close the focused pane',
        },
      }), 'dsh-split: dictionaries')
      const t = ctx.locale.bind(NS)

      ctx.effect(() => {
        const element = document.createElement('style')
        element.textContent = CSS
        document.head.appendChild(element)
        // A resolved window style degrades silently when a design token is missing, and
        // probing the sheet's own aliases is not enough to see it: an alias that bakes a
        // fallback (a border resolving to `transparent`) reads healthy while every border
        // paints nothing, and the twelve direct `--dsw-*` usages have no alias to read at
        // all. So probe the design tokens themselves, on the element that declares them.
        const probe = window.setTimeout(() => {
          if (typeof window.getComputedStyle !== 'function') return
          if (document.body === undefined || document.body === null) return
          const style = window.getComputedStyle(document.body)
          const needed = [
            '--dsw-alias-bg-base', '--dsw-specific-sidebar-fill', '--dsw-alias-border-l1', '--dsw-alias-border-l3',
            '--dsw-alias-border-l2', '--dsw-alias-label-primary', '--dsw-alias-label-secondary',
            '--dsw-alias-brand-primary', '--dsw-alias-bg-overlay',
          ]
          const missing = needed.filter((name) => style.getPropertyValue(name).trim() === '')
          if (missing.length > 0) {
            console.warn('[dsh-split] design tokens the window styles read are missing:', missing.join(', '))
          }
        }, 1500)
        return () => {
          window.clearTimeout(probe)
          element.remove()
        }
      }, 'dsh-split: styles')

      const controller = createController(ctx)
      // Publish the centre-column hook immediately: the single-window window styles
      // depend on it, not only the split view.
      controller.markCenter()

      // Created first, disposed last: the empty panel is the switch target the
      // teardown repair needs, and it has to outlive the overlay registration.
      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: VOID_PANEL_ID,
      }, () => null)), 'dsh-split: empty switch panel')

      // Created before the overlay registration so its disposer runs after the
      // overlay's, once the panes have released their composer editors.
      ctx.effect(() => () => { controller.repairOnTeardown() }, 'dsh-split: restore the conversation panel')

      ctx.effect(() => () => { controller.dispose() }, 'dsh-split: layout and references')

      // The overlay itself. `shell.overlay` is additive and frame-wide, so this
      // never replaces a shipped seat — and it leaves the panel selection, and
      // with it the right column, untouched.
      ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: PANEL_ID,
        order: 20,
        locale: NS,
        children: { 'split.pane': { kind: 'single', scope: 'session' } },
        inject: () => controller.injectFace(),
      }, SplitOverlay)), 'dsh-split: overlay')

      // The single occupant of that session-scoped child: the shipped Factory.
      ctx.effect(() => ctx.slots.inject('split.pane', () => ctx.slots.register({
        name: 'split.pane',
      }, PaneConversation)), 'dsh-split: pane conversation')

      // The Sidebar Session menu carries the entry point into the split view: two
      // directions, both acting on the row's own Session.
      const menuEntries = [
        { id: 'dsh-split.right', order: 300, dir: 'row', key: 'menu.splitRight' },
        { id: 'dsh-split.down', order: 310, dir: 'col', key: 'menu.splitDown' },
      ]
      for (const entry of menuEntries) {
        ctx.effect(() => ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: entry.id,
          order: entry.order,
          locale: NS,
          inject: () => ({
            labelKey: entry.key,
            canSplit: (sessionId) => controller.canSplit(sessionId),
            run: (sessionId) => controller.splitWith(sessionId, entry.dir),
          }),
        }, SplitMenuRow)), 'dsh-split: session menu ' + entry.id)
      }

      for (const command of COMMANDS) {
        ctx.effect(() => ctx.shortcuts.registerFixed({
          id: 'dsh-split.' + command.id,
          label: () => t(command.label),
          keys: command.keys,
          bindings: command.codes.map((code) => ({ code, modifiers: COMMAND_MODIFIERS })),
          group: 'application',
        }), 'dsh-split: ' + command.id + ' shortcut')
      }

      ctx.effect(() => ctx.shortcuts.observeFixedInput((input) => {
        if (input.type !== 'keydown') return
        const gesture = input.gesture
        if (gesture.repeat || gesture.composing || gesture.defaultPrevented) return
        if (!gesture.control || !gesture.alt || gesture.shift || gesture.meta) return
        const context = input.context
        // A foreground modal owns the keyboard, whatever this plugin reserved.
        if (context !== undefined && context !== null && context.modal !== null) return
        for (const command of COMMANDS) {
          const index = command.codes.indexOf(gesture.code)
          if (index === -1) continue
          input.consume()
          command.run(controller, index)
          return
        }
      }), 'dsh-split: fixed input')
    }

    return module.exports
  },
})
