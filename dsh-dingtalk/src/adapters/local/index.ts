import { ConnectionServiceError } from '../../shared/models.js';
import type { DingtalkBackend } from '../../shared/models.js';

/** Issue #5 placeholder; no CLI, network, profile or credential access. */
export function createLocalBackend(): DingtalkBackend {
  return {
    mode: 'local',
    status: async () => ({ state: 'unknown', reasonCode: 'backend_not_ready' }),
    beginAuthorization: async () => { throw new ConnectionServiceError('backend_not_ready'); },
    getAuthorizationStatus: async () => ({ state: 'unknown', reasonCode: 'backend_not_ready' }),
    disconnect: async () => ({ disconnected: false }),
    invoke: async () => ({ status: 'failed', reasonCode: 'backend_not_ready', retryable: false }),
    dispose() {},
  };
}
