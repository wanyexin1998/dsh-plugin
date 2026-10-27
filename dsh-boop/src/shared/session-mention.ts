/**
 * Canonical session mention codec.
 *
 * This matches the public root exports of `@deepseek-ai/dsh-session-reference`
 * at dsh-v0.2.1-rc.2 (`687f282e8625c6b8d11ff58211a90524be2e4317`,
 * `packages/context/session-reference/src/uri.ts`). The plugin does not bundle
 * that package: a second copy would not be the host's parser, and the package
 * is not a direct dependency. The wire format is the base64url JSON session id
 * inside `dsh-session:`, not the raw id.
 *
 * Source notice: encoding rules are reimplemented from that file so BOOP chips
 * and the host pre-read parser agree. No other session-reference code is copied.
 */

export interface SessionMention {
  sessionId: string
  label: string
}

export interface ParsedSessionMentionText {
  text: string
  references: SessionMention[]
}

export const SESSION_REFERENCE_SCHEME = 'dsh-session:'

export function encodeSessionReferenceUri(sessionId: string): string {
  const payload = Buffer.from(JSON.stringify(sessionId), 'utf8').toString('base64url')
  return `${SESSION_REFERENCE_SCHEME}${payload}`
}

export function decodeSessionReferenceUri(uri: string): string {
  if (!uri.startsWith(SESSION_REFERENCE_SCHEME)) throw new Error(`invalid session reference URI ${JSON.stringify(uri)}`)
  const payload = uri.slice(SESSION_REFERENCE_SCHEME.length)
  if (!/^[A-Za-z0-9_-]+$/u.test(payload)) throw new Error(`invalid session reference URI ${JSON.stringify(uri)}`)
  const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  if (typeof parsed !== 'string') throw new Error(`invalid session reference URI ${JSON.stringify(uri)}`)
  if (encodeSessionReferenceUri(parsed) !== uri) throw new Error(`invalid session reference URI ${JSON.stringify(uri)}`)
  return parsed
}

function escapeLabel(label: string): string {
  return label.replace(/[\\\]]/gu, (match) => `\\${match}`)
}

function unescapeLabel(label: string): string {
  return label.replace(/\\(.)/gu, '$1')
}

export function formatSessionReferenceMention(reference: { sessionId: string; label?: string }): string {
  const label = escapeLabel(reference.label ?? reference.sessionId)
  return `@[${label}](${encodeSessionReferenceUri(reference.sessionId)})`
}

export function parseSessionReferenceText(text: string): ParsedSessionMentionText {
  const references: SessionMention[] = []
  const pattern = /@\[((?:\\.|[^\\\]])*)\]\((dsh-session:[^\s)]*)\)|(dsh-session:[A-Za-z0-9_-]+)/gu
  const rendered = text.replace(pattern, (_match, rawLabel: string | undefined, markdownUri: string | undefined, bareUri: string | undefined) => {
    const uri = markdownUri ?? bareUri
    if (uri === undefined) throw new Error('session reference URI is missing')
    const sessionId = decodeSessionReferenceUri(uri)
    const label = rawLabel === undefined ? sessionId : unescapeLabel(rawLabel)
    references.push({ sessionId, label })
    return `@${label}`
  })
  return { text: rendered, references }
}
