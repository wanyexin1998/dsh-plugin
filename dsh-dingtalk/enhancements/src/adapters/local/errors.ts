import type { ReasonCode } from '../../shared/models.js';
/** DWS v1.0.66 legacy error envelope; never inspect prose, hints or raw RPC bodies. */
export function normalizeDwsError(exit: number | null, stderr: string, stdout: string): ReasonCode {
  for (const channel of [stderr, stdout]) {
    try {
      const envelope = JSON.parse(channel);
      // Frozen PAT protocol in upstream internal/errors/pat.go, exit=4.
      // Organization PAT scope policy is distinct from the enterprise CLI switch.
      if (exit === 4 && envelope?.success === false) {
        if (envelope.code === 'PAT_ORG_POLICY_DENIED') return 'org_policy_denied';
        if (envelope.code === 'PAT_SCOPE_AUTH_REQUIRED') return 'scope_authorization_required';
        if (['PAT_NO_PERMISSION', 'PAT_LOW_RISK_NO_PERMISSION', 'PAT_MEDIUM_RISK_NO_PERMISSION', 'PAT_HIGH_RISK_NO_PERMISSION'].includes(envelope.code)) return 'permission_denied';
      }
      const value = envelope?.error;
      if (!value || value.code !== exit) continue;
      if (exit === 1 && value.category === 'api') {
        if (value.reason === 'rate_limited' && value.server_error_code === 'RATE_LIMIT_ERROR') return 'rate_limited';
        if (['request_timeout', 'http_client_timeout', 'tls_timeout', 'connection_refused', 'dns_resolution_failed', 'io_timeout', 'backend_dependency_unavailable'].includes(value.reason)) return 'service_unavailable';
      }
      if (exit === 2 && value.category === 'auth') return 'connection_unknown';
    } catch {}
  }
  return 'cli_failed';
}
