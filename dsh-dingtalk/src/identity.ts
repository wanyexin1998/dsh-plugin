/** Identity from the official event, not model arguments or browser display data. */
export interface DingTalkIdentity {
  readonly corpId: string
  readonly userId: string
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

export function messageIdentity(value: unknown): DingTalkIdentity | undefined {
  if (!value || typeof value !== 'object') return undefined
  const event = value as Record<string, unknown>
  // Do not infer a sender's enterprise from the active Web account. Robot-corp
  // fallback requires a separately verified internal-bot event contract.
  if (!identifier(event.senderCorpId) || !identifier(event.senderStaffId)) return undefined
  return Object.freeze({ corpId: event.senderCorpId, userId: event.senderStaffId })
}

export function sameIdentity(a: DingTalkIdentity | undefined, b: DingTalkIdentity | undefined): boolean {
  return !!a && !!b && a.corpId === b.corpId && a.userId === b.userId
}
