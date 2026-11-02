import { ConnectionServiceError } from './models.js';
import type { DingtalkBackend, DingtalkConnectionService, InvokeResult } from './models.js';
import { parseAuthorizationContext, parseInvokeInput, publicAuthStart, publicInvokeResult, publicStatus, transactionId } from './validation.js';

export function createConnectionService(backend: DingtalkBackend): { service: DingtalkConnectionService; dispose(): Promise<void> } {
  let active = true;
  const assertActive = (): void => { if (!active) throw new ConnectionServiceError('service_disposed'); };
  function project<T>(action: () => T): T {
    try { return action(); } catch { throw new ConnectionServiceError('service_unavailable'); }
  }
  async function execute<T>(action: () => Promise<T>): Promise<T> {
    assertActive();
    try {
      const result = await action();
      assertActive();
      return result;
    } catch (error) {
      if (!active) throw new ConnectionServiceError('service_disposed');
      if (error instanceof ConnectionServiceError) throw error;
      throw new ConnectionServiceError('service_unavailable');
    }
  }
  const service: DingtalkConnectionService = Object.freeze<DingtalkConnectionService>({
    status: options => execute(async () => { const value = await backend.status(options); return project(() => publicStatus(value)); }),
    beginAuthorization: context => execute(async () => {
      const value = await backend.beginAuthorization(parseAuthorizationContext(context)); return project(() => publicAuthStart(value));
    }),
    getAuthorizationStatus: id => execute(async () => { const value = await backend.getAuthorizationStatus(transactionId(id)); return project(() => publicStatus(value)); }),
    disconnect: () => execute(async () => {
      const result = await backend.disconnect();
      if (typeof result.disconnected !== 'boolean') throw new ConnectionServiceError('service_unavailable');
      return { disconnected: result.disconnected };
    }),
    invoke: async (input, options) => {
      try { return await execute(async () => { const value = await backend.invoke(parseInvokeInput(input), options); return project(() => publicInvokeResult(value)); }); }
      catch (error) {
        const reasonCode = error instanceof ConnectionServiceError ? error.reasonCode : 'service_unavailable';
        return { status: 'failed', reasonCode, retryable: reasonCode === 'service_unavailable' } satisfies InvokeResult;
      }
    },
  });
  return { service, async dispose() { if (active) { active = false; await backend.dispose(); } } };
}
