/**
 * Host-surface probe (E00-01; re-baselined on DSH 0.2.1-rc.2).
 *
 * Enumerates the live Cordis service registry (`ctx.reflect.props`) and probes
 * the specific adapter surfaces BOOP's DshAdapter depends on. The result is the
 * adapter capability matrix: what exists, what is missing, and which frozen
 * adapter method therefore stays disabled.
 *
 * This probe NEVER calls business methods; it only records presence and shape.
 * Runtime behavior of each surface is verified separately by
 * tests/host/*.test.mjs against the installed payload.
 */

export interface ProbeEntry {
  name: string
  present: boolean
  kind?: string
  note?: string
}

export interface ProbeResult {
  schemaVersion: 1
  probedAt: string
  /** Every service name registered in the live root context. */
  services: string[]
  /** Probes for the surfaces BOOP's adapter contract maps onto. */
  matrix: ProbeEntry[]
}

/**
 * Adapter-relevant service keys (03§04 适配矩阵).
 *
 * Names are the REAL Cordis service keys observed on the installed payload
 * (see `services` in boop/bootstrap), not row ids. `schedule` is mounted by the
 * 0.2.1-rc.2 web profile (it was absent on 0.2.0-rc.2); presence is always read
 * from the live registry, never assumed.
 */
const ADAPTER_SURFACES: Array<{ name: string; adapter: string; note?: string }> = [
  { name: 'profileContext', adapter: 'scope identity / profile facts' },
  { name: 'sessions', adapter: 'ensureMain / listTargets / cold history' },
  { name: 'sessionController', adapter: 'prompt submit / queue / cancel' },
  { name: 'workspaceRegistry', adapter: 'workspace registry management' },
  { name: 'typertGateway', adapter: 'BOOP logical API remote plane' },
  { name: 'connection', adapter: 'authenticated client transport' },
  { name: 'tools', adapter: 'BOOP management tool registration' },
  { name: 'agentLoop', adapter: 'execution loop observation' },
  { name: 'llm', adapter: 'model routing / capability probe (E05-00)' },
  { name: 'credentials', adapter: 'credential references (never raw secrets)' },
  { name: 'approval', adapter: 'native approval reuse' },
  { name: 'schedule', adapter: 'native automation binding (optional row)' },
  { name: 'jobs', adapter: 'background job carrier' },
]

function classify(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  const t = typeof value
  if (t === 'object') {
    const proto = Object.getPrototypeOf(value)
    const ctor = proto?.constructor?.name
    return ctor && ctor !== 'Object' ? `object:${ctor}` : 'object'
  }
  return t
}

/**
 * Probe one service by name without triggering the inject error path.
 * `ctx.reflect.get(name, false)` reads the store directly and returns
 * undefined for absent names.
 */
export function probeService(ctx: any, name: string): { present: boolean; kind?: string } {
  try {
    const value = ctx?.reflect?.get?.(name, false)
    if (value === undefined || value === null) return { present: false }
    return { present: true, kind: classify(value) }
  } catch {
    return { present: false }
  }
}

export function probeHostSurface(ctx: any): ProbeResult {
  const services: string[] = []
  try {
    const props = ctx?.reflect?.props
    if (props && typeof props === 'object') services.push(...Object.keys(props).sort())
  } catch {
    /* probe stays best-effort; absence is recorded, not thrown */
  }
  const matrix: ProbeEntry[] = ADAPTER_SURFACES.map(({ name, adapter, note }) => {
    const { present, kind } = probeService(ctx, name)
    return { name, present, kind, note: `${adapter}${note ? ` — ${note}` : ''}` }
  })
  return { schemaVersion: 1, probedAt: new Date().toISOString(), services, matrix }
}
