/**
 * Constants shared by both halves of dsh-chat. The client
 * bundle cannot import this module (it is a platform-module CJS closure), so
 * these literals are repeated there deliberately and pinned by that file's own
 * test; keep the two lists identical when editing.
 */

/** Package name; also the client module id the browser factory registers under. */
export const PLUGIN_ID = 'dsh-chat'

/** Route prefix owned by the host half (`prefix` kind: matches the path and everything under it). */
export const ROUTE_PREFIX = '/dsh-chat'

/** Host route answering the client's session request with the proxy origin and its token. */
export const SESSION_PATH = `${ROUTE_PREFIX}/api/session`

/** Host route minting a one-shot ticket for an externally opened bridge window. */
export const TICKET_PATH = `${ROUTE_PREFIX}/api/ticket`

/** Query parameter exchanged for the bridge session cookie on first navigation. */
export const SESSION_QUERY = '__bridge_session'

/** Query parameter carrying a one-shot external-open ticket. */
export const TICKET_QUERY = '__bridge_ticket'

/**
 * Query parameter naming the panel's navigation. A client that has already been
 * authorized once may keep this marker in its URL, and the proxy accepts it as
 * proof of that authorization.
 *
 * It exists because the bridge's cookie is third-party in the panel's cross-site
 * frame, where Chromium refuses to store it: without this marker the redirect
 * that strips the one-time session token would leave the frame with nothing to
 * authorize it, and the panel would fail on every desktop launch.
 */
export const NONCE_QUERY = '__bridge_nonce'

/** Cookie the bridge proxy sets once a session token has been exchanged. */
export const SESSION_COOKIE = 'dsh_bridge_session'

/** Health route served by the bridge proxy itself (never forwarded upstream). */
export const HEALTH_PATH = '/__bridge/health'
