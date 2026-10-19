window.__ModuleLoader__.load({
  id: 'dsh-chat',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    /**
     * Client half of dsh-chat.
     *
     * Contributes one frame-wide entry into the shell's `shell.overlay` slot: a
     * capsule in the top-center that switches the whole window between the DSH
     * conversation and the DeepSeek Chat web app, plus the overlay that hosts
     * the framed app. The framed page is the real chat.deepseek.com served
     * through the plugin's loopback proxy; its session lives in the browser's
     * storage for that loopback origin, so switching back and forth, or
     * reloading DSH, keeps the user signed in.
     *
     * This bundle is a plain-JavaScript platform module: React and the slot
     * service come from the shell's module table, so the package needs no build
     * step. The registration id above must equal the package name declared in
     * package.json, because the host attaches a package's half to the Loader row
     * whose specifier is the bare package name.
     */
    const React = require('react')
    const { createElement: h } = React

    /** Host route returning the proxy origin and this boot's session token. */
    const SESSION_API = '/dsh-chat/api/session'
    /** Host route minting a one-shot ticket for an external browser window. */
    const TICKET_API = '/dsh-chat/api/ticket'

    /** Frame-wide floating layer; the capsule and the takeover share this seat. */
    const SLOT_NAME = 'shell.overlay'
    /** Registration id; also the entry's order key inside the slot. */
    const ENTRY_ID = 'dsh-chat'
    /** Accessible name of the switch strip; tests and the takeover use it to find the entry. */
    const STRIP_LABEL = 'DeepSeek Chat 切换'
    /** Accessible name of the takeover panel; the isolation effect anchors on it. */
    const PANEL_LABEL = 'DeepSeek Chat 网页版'
    /** Server-rendered startup view: the host injects this into the document head. */
    const SNAPSHOT_ID = 'dsh-chat-startup'
    /** Startup view meaning "open the chat takeover on load". */
    const VIEW_CHAT = 'chat'

    /**
     * The shell paints the Windows caption band with this token. While the chat
     * view owns the window, publishing a translucent value removes the band's
     * fill so the floating switch does not sit on a stripe of its own.
     */
    const CAPTION_FILL = '--dsw-specific-sidebar-fill'
    const CAPTION_TRANSPARENT = 'color-mix(in srgb, var(--dsw-alias-label-primary, #1a1a1a) 3%, transparent)'

    /**
     * Open the bridged DeepSeek Chat in a browser window.
     *
     * The host mints a one-shot ticket for the trip, and `window.open` runs inside
     * the caller's own click gesture so the popup is not blocked. The ticket is
     * consumed on first use, so the URL cannot be replayed after that click.
     *
     * @param onError - receives the failure message when the ticket cannot be had.
     */
    function openOutsideWindow(onError) {
      fetch(TICKET_API, { method: 'POST' })
        .then(response => (response.ok ? response.json() : describeFailure(response)))
        .then(payload => { window.open(payload.url, '_blank', 'noopener,noreferrer') })
        .catch(error => { if (typeof onError === 'function') onError(String(error.message ?? error)) })
    }

    /**
     * Read the deployment's startup view from the host's head injection.
     *
     * Read at render time rather than through a request, so the first paint
     * already shows the configured view instead of flashing the other one.
     *
     * @returns true when the takeover should open on load.
     */
    function readStartupView() {
      try {
        const node = document.getElementById(SNAPSHOT_ID)
        return node !== null && node.dataset.view === VIEW_CHAT
      } catch {
        // A document without the injection (or a blocked read) keeps the switch
        // on the conversation, which is the safe default.
        return false
      }
    }

    /**
     * Turn a non-OK route response into an error that keeps the server's own
     * message. The host answers refusals with a short plain-text reason, and
     * that reason is the whole diagnosis; dropping it would leave a bare status
     * code on screen.
     */
    async function describeFailure(response) {
      let detail = ''
      try {
        const text = await response.text()
        detail = text.trim().slice(0, 200)
      } catch {
        // A body that cannot be read leaves the status alone.
      }
      throw new Error(detail === '' ? 'HTTP ' + String(response.status) : 'HTTP ' + String(response.status) + ' · ' + detail)
    }

    /** Theme tokens owned by the shell; the capsule inherits light/dark on its own. */
    const TOKENS = {
      surface: 'var(--dsw-alias-bg-overlay, #ffffff)',
      border: 'var(--dsw-alias-border-l1, rgba(0,0,0,.12))',
      label: 'var(--dsw-alias-label-primary, #1a1a1a)',
      secondary: 'var(--dsw-alias-label-secondary, rgba(0,0,0,.6))',
      idle: 'var(--dsw-alias-state-idle-primary, rgba(0,0,0,.35))',
    }

    /**
     * The switch's surfaces, fixed on purpose.
     *
     * This shell publishes neither the `--dsw-alias-*` fills (a token read
     * computes to nothing and falls back to white) nor a theme signal that
     * survives a repaint, so a palette derived from the page drifts between
     * whatever the shell happened to be painting when it was measured. One pair
     * of colours, readable on a light and on a dark page, is the stable choice:
     * a translucent ink track, a white pill, the shell's own text colours.
     */
    const SEGMENT_TRACK = 'rgba(15,17,21,.08)'
    const SEGMENT_PILL = '#ffffff'
    /**
     * Label colours for the switch, fixed like its surfaces.
     *
     * The shell's own label tokens are theme-driven: in dark mode they turn
     * near-white, which disappears against the white slider. These are chosen for
     * the surfaces this control draws itself, so the switch reads the same in
     * either theme.
     */
    const SEGMENT_LABEL_ON = '#15171b'
    const SEGMENT_LABEL_OFF = '#454b54'

    /**
     * The shell publishes how much of the window top belongs to system chrome:
     * `--dsh-frame-overlay-top` is the y where a frame-wide floating entry must
     * start and `--dsh-frame-top-clearance` is the reserved height itself. On
     * Windows Electron that strip is the window caption, where the caption row
     * above the content carries `-webkit-app-region: drag`; an entry drawn
     * inside it is visible but receives no pointer input unless it opts out.
     * Both values are read from the shell instead of guessed, with a
     * titlebar-sized fallback for a platform that publishes neither.
     */
    const FRAME_TOP_CLEARANCE = 'var(--dsh-frame-top-clearance, 40px)'
    /** The strip's own height, and the band it floats over. */
    const STRIP_HEIGHT_PX = 40

    const NO_DRAG = { WebkitAppRegion: 'no-drag' }

    /**
     * The strip floats over the top of the page instead of reserving a row for
     * itself: the application keeps its original height and nothing is pushed
     * down.
     *
     * The layer spans the window so the switch can be centred on it, but it takes
     * **no** input — neither pointer nor native window dragging.
     *
     * `-webkit-app-region` is the reason this matters. It is a **native** hit
     * region: it swallows clicks *before* the page sees them, so `pointer-events`
     * cannot opt out of it. Measured on the desktop build, a `drag` band across
     * this row ate the clicks of the app's own top-right controls (分栏 / 全屏 /
     * 收起右侧栏), which sit in exactly this band. Dropping `drag` from the layer
     * therefore matters as much as dropping pointer input: the window stays
     * movable by the shell's caption above, and this row belongs to the app.
     */
    const STRIP_STYLE = {
      position: 'fixed',
      // Below the window chrome, so the strip never covers the app's own top
      // toolbar and its handle never lands on a control there.
      top: FRAME_TOP_CLEARANCE,
      left: 0,
      right: 0,
      height: `${String(STRIP_HEIGHT_PX)}px`,
      zIndex: 510,
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'center',
      background: 'transparent',
      font: '500 12.5px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif',
      color: TOKENS.label,
      // Click-through, and outside the native drag region: only the control's own
      // rectangle takes input, and it takes it as a plain element, not as a window
      // handle. The rest of this row reaches the app underneath.
      pointerEvents: 'none',
      ...NO_DRAG,
    }

    /**
     * The switch track: a capsule one step off the page it sits on, with the
     * raised slider drawn inside it. Matches the reference design's proportions —
     * a large radius, a light track, one white pill.
     */
    const segmentStyle = () => ({
      position: 'relative',
      display: 'flex',
      alignItems: 'center',
      padding: '4px',
      borderRadius: '999px',
      background: SEGMENT_TRACK,
      WebkitAppRegion: 'no-drag',
    })

    /**
     * The takeover fills the page area and starts below the window chrome, so
     * the chrome stays visible above it exactly as it does over the app.
     */
    const overlayStyleFor = (open) => ({
      position: 'fixed',
      left: 0,
      right: 0,
      bottom: 0,
      top: FRAME_TOP_CLEARANCE,
      zIndex: 500,
      background: TOKENS.surface,
      display: 'flex',
      flexDirection: 'column',
      pointerEvents: 'auto',
      ...NO_DRAG,
      ...(open ? {} : { visibility: 'hidden', pointerEvents: 'none' }),
    })

    /**
     * The strip's side slots. The switch is centred by absolute positioning, so
     * the panel's own controls ride the same line without displacing it.
     */
    const STRIP_SIDE_STYLE = {
      position: 'absolute',
      top: 0,
      height: '100%',
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      font: '500 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif',
      color: TOKENS.secondary,
      whiteSpace: 'nowrap',
    }

    const FRAME_STYLE = { flex: '1 1 auto', width: '100%', border: '0', display: 'block', background: '#fff' }

    /**
     * Poll the host half until its loopback bridge reports ready.
     *
     * The proxy comes up asynchronously with the host half, so the first request
     * can legitimately answer 503; polling instead of latching keeps the panel and
     * the sidebar tab from showing a permanent failure on a slow start.
     *
     * @returns `{ session, error }`, where `session` is the ready payload.
     */
    function useBridgeSession() {
      const [session, setSession] = React.useState(undefined)
      const [error, setError] = React.useState(undefined)
      React.useEffect(() => {
        let cancelled = false
        let timer
        const load = () => {
          if (cancelled) return
          fetch(SESSION_API, { headers: { accept: 'application/json' } })
            .then(response => (response.ok ? response.json() : describeFailure(response)))
            .then(payload => {
              if (cancelled) return
              if (payload.ready === true) setSession(payload)
              else timer = setTimeout(load, 1200)
            })
            .catch(failure => {
              if (cancelled) return
              setError(String(failure.message ?? failure))
              timer = setTimeout(load, 2000)
            })
        }
        load()
        return () => { cancelled = true; clearTimeout(timer) }
      }, [])
      return { session, error }
    }

    /**
     * The framed chat page, sized to fill whatever box it is given.
     *
     * Both surfaces — the frame-wide panel and the right sidebar's tab — show the
     * same document, so the URL rules live here once:
     *
     *   - the token rides in the URL, because the panel's frame is cross-site and
     *     Chromium drops the bridge's cookie there (measured: the redirected leg
     *     arrives with neither token nor cookie);
     *   - the nonce rides along too, so a frame that already holds a failure page
     *     from an earlier attempt is never reused just because its `src` would be
     *     identical.
     *
     * @param props - `session` from {@link useBridgeSession}, `reloadKey` to force a
     *   fresh navigation, and `onLoad` to clear a loading state.
     */
    function BridgeFrame(props) {
      const [internalKey, setInternalKey] = React.useState(0)
      const session = props.session
      const reloadKey = (props.reloadKey ?? 0) + internalKey
      if (session === undefined) {
        return h('div', {
          style: { padding: '24px', font: '13px/1.6 system-ui, sans-serif', color: TOKENS.secondary },
        }, props.error === undefined ? '正在启动本地桥接代理…' : '桥接代理尚未就绪：' + props.error)
      }
      const url = session.origin + '/?__bridge_session=' + encodeURIComponent(session.sessionToken)
        + '&__bridge_nonce=' + String(reloadKey)
      return h('iframe', {
        key: reloadKey,
        src: url,
        title: props.title ?? 'DeepSeek Chat',
        style: { ...FRAME_STYLE, ...(props.style ?? {}) },
        // The framed app is a first-party session for the loopback origin: it
        // needs its own storage and cookies, so `allow-same-origin` is required
        // (the proxy origin is loopback-only and token-gated).
        sandbox: 'allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals allow-storage-access-by-user-activation',
        allow: 'clipboard-write; clipboard-read',
        onLoad: props.onLoad,
        'data-bridge-frame': '',
      })
    }

    /**
     * The switch itself: a pill track whose selected cell is a raised pill that
     * slides between the two labels. The cells are laid out by real buttons, so
     * the geometry comes from the DOM rather than from fixed widths, and the
     * slider is measured after every layout change and translated with a
     * transition — that is the horizontal slide the design asks for.
     *
     * @param props - `open` selects the chat cell, `onSelect` reports a click.
     */
    function Switch(props) {
      const track = React.useRef(null)
      const [slider, setSlider] = React.useState({ left: 0, width: 0, ready: false })
      // A geometry change — first measure, a label or font change, a resize —
      // must land instantly; only a selection change slides. Without this the
      // pill would grow out of nothing on first paint.
      const [animate, setAnimate] = React.useState(false)

      const open = props.open
      React.useLayoutEffect(() => {
        const node = track.current
        if (node === null) return undefined
        const measure = () => {
          setAnimate(false)
          const buttons = node.querySelectorAll('button')
          const target = open ? buttons[1] : buttons[0]
          if (target === undefined) return
          setSlider({ left: target.offsetLeft, width: target.offsetWidth, ready: true })
        }
        measure()
        if (typeof ResizeObserver === 'undefined') return undefined
        const observer = new ResizeObserver(measure)
        observer.observe(node)
        return () => { observer.disconnect() }
        // The selection is read through a ref-free closure: `open` is only a
        // trigger here, while `measure` re-reads the live buttons.
      }, [open])

      // Once the pill sits on its cell, re-enable the transition so the next
      // selection change is the animated one.
      React.useLayoutEffect(() => {
        if (slider.ready && !animate) setAnimate(true)
      }, [slider, animate])

      const cellStyle = (active) => ({
        position: 'relative',
        zIndex: 1,
        appearance: 'none',
        border: '0',
        background: 'transparent',
        cursor: 'pointer',
        padding: '7px 30px',
        borderRadius: '999px',
        font: 'inherit',
        fontSize: '14px',
        lineHeight: '20px',
        color: active ? SEGMENT_LABEL_ON : SEGMENT_LABEL_OFF,
        transition: 'color 260ms cubic-bezier(.4,0,.2,1)',
      })

      return h('div', {
        ref: track,
        'data-bridge-segment': '',
        role: 'group',
        'aria-label': STRIP_LABEL,
        style: segmentStyle(),
      }, [
        h('span', {
          key: 'slider',
          'aria-hidden': true,
          style: {
            position: 'absolute',
            top: '4px',
            bottom: '4px',
            left: 0,
            width: slider.width === 0 ? 0 : slider.width,
            transform: 'translateX(' + String(slider.left) + 'px)',
            borderRadius: '999px',
            background: SEGMENT_PILL,
            boxShadow: '0 2px 8px rgba(0,0,0,.14), 0 1px 1px rgba(0,0,0,.06)',
            opacity: slider.ready ? 1 : 0,
            transition: animate
              ? 'transform 260ms cubic-bezier(.4,0,.2,1), width 260ms cubic-bezier(.4,0,.2,1)'
              : 'none',
          },
        }),
        h('button', {
          key: 'work',
          type: 'button',
          onClick: () => { props.onSelect(false) },
          'aria-pressed': !props.open,
          style: cellStyle(!props.open),
        }, '工作'),
        h('button', {
          key: 'chat',
          type: 'button',
          onClick: () => { props.onSelect(true) },
          'aria-pressed': props.open,
          style: cellStyle(props.open),
        }, '聊天'),
      ])
    }

    /** A small square control riding the strip's trailing edge. */
    function IconButton(props) {
      return h('button', {
        type: 'button',
        onClick: props.onClick,
        title: props.title,
        'aria-label': props.title,
        disabled: props.disabled === true,
        style: {
          appearance: 'none',
          border: '0',
          cursor: props.disabled === true ? 'default' : 'pointer',
          borderRadius: '999px',
          width: '26px',
          height: '26px',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          font: 'inherit',
          color: SEGMENT_LABEL_OFF,
          background: 'transparent',
          // Electron would otherwise treat a click here as the start of a window
          // drag, which is what made these two icons do nothing on the desktop.
          ...NO_DRAG,
        },
      }, props.children)
    }

    /** Registration id of the sidebar tab type; also the slot dispatch key. */
    const TAB_ID = 'dsh-chat'
    /** The tab kind recorded in a session layout. */
    const TAB_KIND = 'dsh-chat'
    /** Locale namespace for the tab's copy. */
    const TAB_NS = 'dsh-chat'

    /**
     * Open the chat tab in the right sidebar for the active session.
     *
     * The sidebar renders one session's tabs at a time, so this needs an active
     * session; without one there is nowhere to place the tab and the shell's own
     * `openTab` would throw. The caller reports that instead of failing silently.
     *
     * @param sidebarRight - the `ctx.sidebarRight` service.
     * @returns true when a tab was placed.
     */
    function openChatTab(sidebarRight) {
      try {
        sidebarRight.openTab(TAB_KIND)
        return 'opened'
      } catch (error) {
        return 'failed: ' + String(error.message ?? error)
      }
    }

    /**
     * The chat tab's body: the same framed document as the frame-wide panel, with
     * the panel's own controls attached.
     *
     * @param props - `hooks` carries the shell's tab hooks; the rest is our own.
     */
    function ChatTabBody(props) {
      const { session, error } = useBridgeSession()
      const [reloadKey, setReloadKey] = React.useState(0)
      const [loading, setLoading] = React.useState(true)
      const actions = props.actions
      return h('div', {
        style: { display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0 },
        'data-bridge-tab': '',
      }, [
        h('div', {
          key: 'bar',
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: '6px',
            padding: '4px 8px',
            flex: '0 0 auto',
            font: '500 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif',
            color: SEGMENT_LABEL_OFF,
          },
        }, [
          loading
            ? h('span', { key: 'state', style: { marginRight: 'auto' } }, '正在加载 DeepSeek 网页版…')
            : null,
          h(IconButton, {
            key: 'reload',
            title: '刷新网页版',
            onClick: () => { setLoading(true); setReloadKey(value => value + 1) },
          }, '⟳'),
          h(IconButton, {
            key: 'outside',
            title: '在浏览器窗口中打开',
            onClick: () => { openOutsideWindow(props.onError) },
          }, '↗'),
          actions !== undefined && typeof actions.closeTab === 'function'
            ? h(IconButton, {
              key: 'close',
              title: '关闭此标签',
              onClick: () => { actions.closeTab() },
            }, '✕')
            : null,
        ]),
        h('div', {
          key: 'frame',
          style: { position: 'relative', flex: '1 1 auto', minHeight: 0, display: 'flex' },
        }, h(BridgeFrame, {
          session,
          error,
          reloadKey,
          title: 'DeepSeek Chat',
          onLoad: () => { setLoading(false) },
        })),
      ])
    }

    /** The chat tab's chip in the tab strip. */
    function ChatTabTitle() {
      return h('span', null, 'DeepSeek Chat')
    }

    /**
     * The chat tab's glyph in the right column's guide.
     *
     * The guide card is the shell's — it renders the row, the hover, and the pick.
     * All a tab type supplies is this artwork, which the card draws at its own
     * size, so the entry matches the shipped rows instead of approximating them.
     *
     * @param props - `size` from the card; `className` carries its placeholder ink.
     */
    function ChatTabArtwork(props) {
      const size = props.size ?? 26
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        'aria-hidden': 'true', className: props.className,
      }, [
        h('rect', {
          key: 'bubble',
          x: '2.6', y: '3.4', width: '18.8', height: '13.4', rx: '3.6',
          stroke: 'currentColor', strokeWidth: '1.6',
        }),
        h('path', {
          key: 'tail',
          d: 'M8 16.8v3.4l3.6-3.4',
          stroke: 'currentColor', strokeWidth: '1.6', strokeLinejoin: 'round', strokeLinecap: 'round',
        }),
        h('path', {
          key: 'spark',
          d: 'M9.4 10.1l1.1-2.7 1.1 2.7 2.7 1.1-2.7 1.1-1.1 2.7-1.1-2.7-2.7-1.1z',
          fill: 'currentColor',
        }),
      ])
    }

    /**
     * The sidebar foot's entry point: one click opens the chat tab.
     *
     * The sidebar renders one session's tabs, so the tab can only be placed while
     * a session is open; without one this says so instead of throwing inside the
     * shell's `openTab`.
     *
     * @param props - `hooks.sidebarRight` and `hooks.openTab`; `wide` comes from the
     *   shell and decides whether the label fits beside the icon.
     */
    function ChatFooterAction(props) {
      const wide = props.wide === true
      return h('div', {
        role: 'button',
        tabIndex: 0,
        title: '在右侧边栏打开 DeepSeek 网页版',
        'aria-label': '在右侧边栏打开 DeepSeek 网页版',
        'data-bridge-footer-action': '',
        // The foot is a small shared container: the simplest element that works
        // there is the safest, so this is a plain row with a click handler and no
        // state of its own.
        onClick: (event) => {
          const outcome = typeof props.openTab === 'function' ? props.openTab() : 'no-inject'
          // The button carries its own result, which is also how a test reads it.
          try { event.currentTarget.setAttribute('data-bridge-open-tab', String(outcome)) } catch { /* a blocked write leaves the click a no-op */ }
        },
        onKeyDown: (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          if (typeof props.openTab === 'function') props.openTab()
        },
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          width: wide ? '100%' : 'auto',
          padding: wide ? '6px 8px' : '6px',
          borderRadius: '8px',
          cursor: 'pointer',
          font: 'inherit',
          color: 'inherit',
          textAlign: 'left',
          userSelect: 'none',
        },
      }, [
        h('span', { key: 'glyph', 'aria-hidden': 'true', style: { display: 'inline-flex', width: '16px', justifyContent: 'center' } },
          h('svg', { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none' },
            h('path', {
              d: 'M3.2 3.2h9.6v7.2H8.4L5.2 12.8v-2.4H3.2z',
              stroke: 'currentColor', strokeWidth: '1.4', strokeLinejoin: 'round',
            }))),
        wide
          ? h('span', { key: 'label' }, 'DeepSeek Chat')
          : null,
      ])
    }

    /**
     * Register the sidebar tab type and its two seats.
     *
     * The right sidebar dispatches a tab body by the registered definition's `id`,
     * so the slots below are keyed by {@link TAB_ID} — the same contract the
     * shipped Browser tab uses. `multiple: false` keeps one chat tab per session:
     * opening it again focuses the tab that is already there.
     *
     * @param ctx - client root context carrying `slots` and `sidebarRightTabs`.
     */
    function registerChatTab(ctx) {
      ctx.effect(() => ctx.locale.register(TAB_NS, {
        zh: { 'tab.title': 'DeepSeek Chat', 'tab.guide': '打开 DeepSeek 网页版' },
        en: { 'tab.title': 'DeepSeek Chat', 'tab.guide': 'Open the DeepSeek web app' },
      }), 'dsh-chat: tab copy')
      const t = ctx.locale.bind(TAB_NS)
      // The right column's empty state lists one card per tab type, which is the
      // request's actual target: the chat entry belongs beside the shipped
      // 工作区文件 / 新建终端 / 浏览器 rows. The card is the shell's, so the pick
      // path is the shell's too; the type only supplies its identity and artwork.
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: TAB_ID,
        kind: TAB_KIND,
        multiple: false,
        title: () => t('tab.title'),
        guide: [{
          id: TAB_ID,
          order: 40,
          title: () => t('tab.title'),
          description: () => t('tab.guide'),
          icon: ChatTabArtwork,
        }],
      }), 'dsh-chat: sidebar tab type')
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: TAB_ID,
        inject: (sessionId, actions) => ({ sessionId, actions }),
      }, ChatTabBody)), 'dsh-chat: sidebar tab body')
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab.title',
        key: TAB_ID,
      }, ChatTabTitle)), 'dsh-chat: sidebar tab title')
      ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: TAB_ID,
        inject: () => ({
          openTab: () => { openChatTab(ctx.sidebarRight) },
        }),
      }, ChatFooterAction)), 'dsh-chat: sidebar footer action')
    }

    /** The bridge panel: the thin switch strip plus the frame-wide takeover. */
    function BridgeEntry() {
      const { session, error: sessionError } = useBridgeSession()
      const [open, setOpen] = React.useState(readStartupView)
      const [reloadKey, setReloadKey] = React.useState(0)
      /**
       * The last navigation this panel asked for. Every open of the takeover
       * bumps it, so the framed document is always fetched afresh: a frame that
       * already holds a failure page from an earlier attempt is not reused just
       * because its `src` would otherwise be identical.
       */
      const [navigationKey, setNavigationKey] = React.useState(0)
      const [loading, setLoading] = React.useState(false)
      /** True while the pointer is on the strip, which is what opens it. */
      const [hovered, setHovered] = React.useState(false)
      /** The strip is open exactly while the pointer is on it. */
      const expanded = hovered

      // Count the opening transitions, not the state itself, so re-renders while
      // the panel is already open do not re-navigate it. The ref is compared
      // before the update, which keeps this safe to run during render.
      const wasOpen = React.useRef(open)
      if (open !== wasOpen.current) {
        wasOpen.current = open
        if (open) setNavigationKey(value => value + 1)
      }


      // While the takeover is up, the DSH interface behind it must not take
      // focus, keyboard input, or clicks. Both the takeover and the switch strip
      // are rendered into the frame-wide overlay layer, so the interface to
      // disable is that layer's large siblings.
      //
      // The layer is identified structurally, not by counting wrapper levels:
      // it is the nearest ancestor of the strip that also contains the takeover
      // panel AND has a viewport-sized sibling. A candidate that contains the
      // strip is never marked, so no ancestor of the switch can be disabled and
      // the panel can always be closed. Only that one level is marked.
      React.useEffect(() => {
        if (!open) return undefined
        const strip = document.querySelector('[aria-label="' + STRIP_LABEL + '"]')
        const panel = document.querySelector('[aria-label="' + PANEL_LABEL + '"]')
        if (strip === null || panel === null) return undefined
        const area = window.innerWidth * window.innerHeight
        let marked = []
        for (let node = strip.parentElement; node !== null && node !== document.body; node = node.parentElement) {
          if (!node.contains(panel)) continue
          const siblings = [...(node.parentElement?.children ?? [])].filter((sibling) => {
            if (sibling === node || sibling.contains(strip)) return false
            const rect = sibling.getBoundingClientRect()
            return rect.width * rect.height >= area * 0.3
          })
          if (siblings.length === 0) continue
          marked = siblings
          break
        }
        for (const sibling of marked) sibling.setAttribute('inert', '')
        return () => { for (const element of marked) element.removeAttribute('inert') }
      }, [open])

      // The strip's own ground is transparent, but on Windows the band it sits
      // in belongs to the shell's caption, which paints a fill across the window
      // top. While the chat view owns the window, publish a transparent caption
      // fill so the strip reads as the floating control the design asks for; the
      // work view restores the shell's own value on the next render.
      React.useEffect(() => {
        if (!open) return undefined
        const root = document.documentElement
        const previous = root.style.getPropertyValue(CAPTION_FILL)
        root.style.setProperty(CAPTION_FILL, CAPTION_TRANSPARENT)
        return () => {
          if (previous === '') root.style.removeProperty(CAPTION_FILL)
          else root.style.setProperty(CAPTION_FILL, previous)
        }
      }, [open])

      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        window.addEventListener('keydown', onKey)
        return () => { window.removeEventListener('keydown', onKey) }
      }, [open])

      /**
       * The framed document URL, authorized by this boot's session token.
       *
       * The plugin's own reload counter rides along as a nonce: without it the
       * iframe's `src` is unchanged between attempts and the renderer keeps the
       * frame it already has — including a failure page from an earlier, broken
       * bridge. The proxy ignores the extra parameter and the token stays in
       * front, so this only guarantees a fresh navigation.
       */
      const frameUrl = session === undefined
        ? undefined
        : session.origin + '/?__bridge_session=' + encodeURIComponent(session.sessionToken) + '&__bridge_nonce=' + String(reloadKey + navigationKey)

      /**
       * The switch selects the view.
       *
       * The chat view is the embedded panel. That is the only way this plugin can
       * put a browser surface inside the application: the shell's own native view
       * (`WebContentsView`) is private to shipped plugins, and the host forbids
       * `<webview>` guests. A real browser window stays available beside it, for
       * anything the frame cannot do.
       */
      const selectView = (next) => {
        setOpen(next === true)
      }

      // The strip floats over the window's chrome band and stays out of the way:
      // it appears when the pointer is on it and fades as soon as the pointer
      // leaves, and its own little arrow is the affordance that says so. Nothing
      // is reserved for it, so the page underneath keeps its full height.
      //
      // The layer takes **no** pointer input. A full-width band would swallow
      // every click in that row, including the app's own toolbar buttons, so the
      // only interactive part is the control's own rectangle — and the arrow that
      // opens the strip is part of it. The layer still keeps `drag`, so the row
      // remains a window handle.
      //
      // Where the pointer has to be for the strip to stay open is the switch's
      // rectangle plus the trailing icons' rectangle once they exist. A plain
      // `mouseenter` on a wrapper cannot express that: a wrapper as wide as the
      // control would collapse the strip the moment the pointer travelled from the
      // switch towards the icons, because they sit outside it. So the regions are
      // measured and tested instead.
      const regions = React.useRef([])
      const measureRegions = () => {
        const found = []
        const switchNode = document.querySelector('[data-bridge-segment]')
        if (switchNode !== null) found.push(switchNode)
        const actionsNode = document.querySelector('[data-bridge-actions]')
        if (actionsNode !== null) found.push(actionsNode)
        regions.current = found.map(node => node.getBoundingClientRect())
      }
      const pointerWithinStrip = (x, y) => regions.current.some(rect =>
        x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)

      // Track the pointer only while the strip is open, so an idle window pays
      // nothing for this.
      React.useEffect(() => {
        if (!expanded) return undefined
        const onMove = (event) => {
          measureRegions()
          if (!pointerWithinStrip(event.clientX, event.clientY)) setHovered(false)
        }
        window.addEventListener('mousemove', onMove)
        measureRegions()
        return () => { window.removeEventListener('mousemove', onMove) }
      }, [expanded])

      const strip = h('div', {
        style: STRIP_STYLE,
        'data-bridge-strip': '',
        'data-bridge-expanded': expanded ? '' : undefined,
      }, [
        h('div', {
          key: 'content',
          'data-bridge-content': '',
          onMouseEnter: () => { setHovered(true) },
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            opacity: expanded ? 1 : 0,
            transition: 'opacity 140ms ease',
            // Always interactive: the collapsed arrow is what the pointer lands
            // on, and that rectangle is exactly the hit area the design asks for.
            pointerEvents: 'auto',
            ...NO_DRAG,
          },
        }, [
          h(Switch, { key: 'switch', open, onSelect: selectView }),
          h('button', {
            key: 'handle',
            type: 'button',
            title: '展开切换条',
            'aria-label': '展开切换条',
            'aria-expanded': expanded,
            // The arrow is the hint that something is up here, so it shows while
            // the strip is collapsed and hides once the strip is open. Putting the
            // pointer on the control's rectangle expands the strip; moving it away
            // collapses the strip again, which is why there is no control to close
            // it. The negative margin keeps it inside that rectangle instead of
            // widening the row.
            onClick: () => { setHovered(true) },
            'data-bridge-handle': '',
            style: {
              width: '30px',
              height: '12px',
              marginLeft: '-30px',
              padding: 0,
              appearance: 'none',
              border: '0',
              background: 'transparent',
              cursor: 'pointer',
              color: SEGMENT_LABEL_OFF,
              opacity: expanded ? 0 : 0.6,
              transition: 'opacity 140ms ease',
              lineHeight: 0,
              ...NO_DRAG,
            },
          }, h('svg', {
            width: 14, height: 8, viewBox: '0 0 14 8', fill: 'none', 'aria-hidden': 'true',
          }, h('path', {
            d: 'M1 1.5 L7 6.5 L13 1.5',
            stroke: 'currentColor', strokeWidth: '1.6', strokeLinecap: 'round', strokeLinejoin: 'round',
          }))),
        ]),
        open
          ? h('div', { key: 'actions', 'data-bridge-actions': '', style: { ...STRIP_SIDE_STYLE, right: '10px', pointerEvents: 'auto', ...NO_DRAG } }, [
            h(IconButton, { key: 'reload', title: '刷新网页版', onClick: () => { setLoading(true); setReloadKey(value => value + 1) } }, '⟳'),
            h(IconButton, { key: 'outside', title: '在浏览器窗口中打开', onClick: () => { openOutsideWindow(message => { setSessionError(message) }) } }, '↗'),
          ])
          : null,
      ])

      let body
      if (session === undefined) {
        body = h('div', { style: { padding: '24px', font: '13px/1.6 system-ui, sans-serif', color: TOKENS.secondary } },
          sessionError === undefined ? '正在启动本地桥接代理…' : '桥接代理尚未就绪：' + sessionError)
      } else {
        body = h('iframe', {
          key: reloadKey + navigationKey,
          src: frameUrl,
          title: 'DeepSeek Chat',
          style: FRAME_STYLE,
          // The framed app is a first-party session for the loopback origin:
          // it needs its own storage and cookies, so `allow-same-origin` is
          // required (the proxy origin is loopback-only and token-gated).
          sandbox: 'allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals allow-storage-access-by-user-activation',
          allow: 'clipboard-write; clipboard-read',
          onLoad: () => { setLoading(false) },
        })
      }

      // The overlay stays mounted once created: moving a nested browsing
      // context out of the document discards it, so hiding the takeover keeps
      // the chat session, its draft, and its scroll position alive.
      const overlayStyle = overlayStyleFor(open)
      return h(React.Fragment, null, [
        h('div', { key: 'overlay', style: overlayStyle, 'aria-hidden': !open, 'aria-label': PANEL_LABEL }, [
          loading && open
            ? h('div', {
              key: 'loading',
              style: {
                position: 'absolute', bottom: '12px', left: '50%', transform: 'translateX(-50%)',
                padding: '4px 12px', borderRadius: '999px', background: 'rgba(127,127,127,.14)',
                font: '12px system-ui, sans-serif', color: TOKENS.secondary,
              },
            }, '正在加载 DeepSeek 网页版…')
            : null,
          body,
        ]),
        h('div', { key: 'strip', style: STRIP_STYLE }, [strip]),
      ])
    }

    /** Services required before mounting: the slot registry only. */
    // The sidebar seats need the shell's own sidebar services: the tab-type
    // registry and the controller that places a tab in the active session.
    exports.inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']

    /**
     * Register the bridge entry into the frame-wide overlay slot.
     * @param ctx - the client cordis context.
     */
    exports.apply = function apply(ctx) {
      registerChatTab(ctx)
      ctx.slots.inject(SLOT_NAME, () => ctx.slots.register({
        name: SLOT_NAME,
        id: ENTRY_ID,
        order: 100,
        label: 'DeepSeek Chat',
      }, BridgeEntry))
    }

    return module.exports
  },
})
