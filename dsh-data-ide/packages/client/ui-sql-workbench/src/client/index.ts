import { SqlWorkbenchArtwork } from './components/SqlWorkbenchArtwork.tsx'
import { SqlWorkbenchPane } from './components/SqlWorkbenchPane.tsx'
import { ChatInputBridge } from './chat-bridge.ts'
import { workbenchApi } from './api.ts'
import { createHttpApi } from './http-api.ts'
import { SqlWorkbenchTitle } from './components/SqlWorkbenchTitle.tsx'
import { TAB_BODY_SLOT, TAB_ID, TAB_KIND, TAB_NS, TAB_TITLE_SLOT } from './contract/constants.ts'
import type { ClientContext } from './contract/host.ts'
import { sidebarRightSupported, UNSUPPORTED_REASON } from './guard.ts'
import { bindOpenShortcut } from './entry.ts'
import { installDiagnostics, reportFailure } from './diagnostics.ts'
import { en, zh } from './locales.ts'

/** Host services this half needs; `sidebarRight*` are checked at run time. */
export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']

/**
 * Host slot carrying the composer action face per Session.
 *
 * The conversation plugin publishes `inputActions` as standard props to its
 * Session-scoped slots; one hidden entry here is enough to hand that face to
 * `chat-bridge.ts` for the "send to chat" actions.
 */
const CHAT_INPUT_DOCK = 'conversation.input.dock'

/**
 * Browser half: register the SQL workbench as a right-sidebar page type.
 *
 * Three registrations:
 *   1. `sidebarRightTabs.register` declares the page type (identity, copy, guide card);
 *   2. the two keyed seats under `rightbar.session` carry the body and the chip,
 *      both addressed by `key: TAB_ID` — the same id the definition declares;
 *   3. a hidden composer-dock entry publishes the host composer actions to
 *      `chat-bridge.ts` ("send to chat", SQL-405).
 *
 * Every registration is wrapped in `ctx.effect`, so unloading the plugin
 * releases the page type, both seats and the chat bridge.
 *
 * A throw here fails the whole client entry — the host renders "web boot: 1
 * entry did not activate" and the pane stays blank with the reason only in the
 * browser console. So the body is wrapped: the reason is logged, posted to the
 * node half's diagnostics route, and the tab still opens.
 */
export function apply(ctx: ClientContext): void {
  installDiagnostics()
  try {
    register(ctx)
  } catch (error) {
    reportRegistrationFailure(error)
  }
}

/** Diagnostics route mounted by `src/host/web-routes.ts`. */
const CLIENT_ERROR_PATH = '/dsh-data-ide/client-error'

/** Explain a registration failure where the operator can actually see it. */
function reportRegistrationFailure(error: unknown): void {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  console.error(`dsh-data-ide: 客户端注册失败 — ${message}`, error)
  reportFailure(message)

  try {
    const stack = error instanceof Error ? error.stack : undefined
    void fetch(CLIENT_ERROR_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, ...(stack === undefined ? {} : { stack }) }),
    }).catch(() => undefined)
  } catch {
    // Older hosts may not expose fetch to plugin scripts; the console line stands.
  }
}

/** The registrations themselves. */
function register(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(TAB_NS, { zh, en }), 'dsh-data-ide: tab copy')
  const t = ctx.locale.bind(TAB_NS)

  // "Send to chat" bridge (SQL-405). Chat and workbench are independent
  // surfaces, so publish the composer face even on a host whose right sidebar
  // is unavailable: the panel falls back to the clipboard there.
  ctx.effect(
    () =>
      ctx.slots.inject(CHAT_INPUT_DOCK, () =>
        ctx.slots.register({ name: CHAT_INPUT_DOCK, id: 'dsh-data-ide-chat-bridge', order: 80 }, ChatInputBridge),
      ),
    'dsh-data-ide: chat input bridge',
  )

  if (!sidebarRightSupported(ctx)) {
    // Fail closed and loudly: a host without the right-sidebar face would
    // otherwise drop the tab with no trace in the UI.
    console.error(UNSUPPORTED_REASON)
    return
  }

  ctx.effect(
    () =>
      ctx.sidebarRightTabs!.register({
        id: TAB_ID,
        kind: TAB_KIND,
        multiple: false,
        title: () => t('tab.title'),
        guide: [
          {
            id: TAB_ID,
            order: 40,
            title: () => t('tab.title'),
            description: () => t('tab.guide'),
            icon: SqlWorkbenchArtwork,
          },
        ],
      }),
    'dsh-data-ide: sidebar tab type',
  )

  ctx.effect(
    () =>
      ctx.slots.inject(TAB_BODY_SLOT, () =>
        ctx.slots.register(
          {
            name: TAB_BODY_SLOT,
            key: TAB_ID,
            locale: TAB_NS,
            // The host *calls* `inject` to build the entry's props — it is a
            // function, not a record (0.2.1: `TypeError: inject is not a
            // function`, which crashes the seat and leaves the pane blank).
            // Building the API lazily also keeps the HTTP face off the boot path.
            inject: () => ({
              // An in-process carrier still wins when one exists; in the web
              // frontend the node half is another process, so this is the
              // same-origin HTTP face `src/host/web-routes.ts` mounts.
              api: workbenchApi(ctx as unknown as Record<string, unknown>) ?? createHttpApi(),
            }),
          },
          SqlWorkbenchPane,
        ),
      ),
    'dsh-data-ide: sidebar tab body',
  )

  ctx.effect(
    () =>
      ctx.slots.inject(TAB_TITLE_SLOT, () =>
        ctx.slots.register({ name: TAB_TITLE_SLOT, key: TAB_ID }, SqlWorkbenchTitle),
      ),
    'dsh-data-ide: sidebar tab title',
  )

  /**
   * Keyboard entry (docs/09 B2).
   *
   * The tab can be closed, and the right sidebar can be collapsed — neither
   * leaves anything to click. `openTab` handles both cases because the page type
   * is `multiple: false`: it opens when closed and focuses when already open.
   */
  ctx.effect(() => {
    // The capability guard above proved this controller exists.
    const controller = ctx.sidebarRight!
    return bindOpenShortcut(() => {
      controller.openTab(TAB_KIND)
    })
  }, 'dsh-data-ide: open shortcut')
}
