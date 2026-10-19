/**
 * Bridge configuration normalization.
 *
 * The host half deliberately has no runtime dependency: the Loader row's
 * `config` map arrives as plain data, and a malformed value fails loud here
 * instead of surfacing as a broken panel later. `apply(ctx, config)` therefore
 * receives the resolved object this module returns.
 */

/** Highest usable TCP port; `0` means "ask the OS". */
const PORT_CEILING = 65_535

/** Default upstream: the DeepSeek Chat web app. */
const DEFAULT_TARGET = 'https://chat.deepseek.com'

/**
 * Validate and default one bridge configuration.
 *
 * @param raw - the Loader row's `config` value, or undefined when omitted.
 * @returns the resolved configuration.
 * @throws when a supplied field has the wrong type or an unusable value.
 */
export function resolveBridgeConfig(raw) {
  const input = raw === undefined || raw === null ? {} : raw
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('dsh-chat: config must be a mapping')
  }
  return {
    target: origin(input.target ?? DEFAULT_TARGET, 'target'),
    port: port(input.port ?? 0),
    seed: seedOf(input.seed),
    startInChat: booleanOf(input.startInChat, 'startInChat'),
  }
}

/** Accept an optional boolean switch. */
function booleanOf(value, field) {
  if (value === undefined || value === null) return false
  if (typeof value !== 'boolean') {
    throw new Error(`dsh-chat: config.${field} must be a boolean`)
  }
  return value
}

/** Require an absolute HTTP(S) origin. */
function origin(value, field) {
  if (typeof value !== 'string') throw new Error(`dsh-chat: config.${field} must be a string`)
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`dsh-chat: config.${field} is not a URL: ${value}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`dsh-chat: config.${field} must be http or https`)
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error(`dsh-chat: config.${field} must be a bare origin`)
  }
  return url.origin
}

/** Require a usable TCP port. */
function port(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > PORT_CEILING) {
    throw new Error('dsh-chat: config.port must be an integer between 0 and 65535')
  }
  return value
}

/**
 * Accept the optional storage seed as a flat string map.
 *
 * The seed is what a *chat* session token would need, and the desktop app
 * stores no such token, so this stays empty unless a deployment supplies one.
 */
function seedOf(value) {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('dsh-chat: config.seed must be a mapping of storage key to string')
  }
  const seed = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      throw new Error(`dsh-chat: config.seed.${key} must be a string`)
    }
    seed[key] = entry
  }
  return seed
}
