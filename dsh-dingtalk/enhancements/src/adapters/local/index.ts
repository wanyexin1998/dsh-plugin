import { ConnectionServiceError } from '../../shared/models.js';
import type { CallOptions, ConnectionStatus, DingtalkBackend, InvokeInput, InvokeResult, ReasonCode } from '../../shared/models.js';
import { DEFAULT_LIMITS, parseLimits } from '../../shared/config.js';
import type { ExecutionLimits } from '../../shared/config.js';
import { parseInvokeInput } from '../../shared/validation.js';
import { DwsExecutor } from './executor.js';
import type { LocalRuntime } from './executor.js';
import { operationArguments } from './operations.js';
import { discover, describe, commandFor } from '../../catalog/index.js';
import { prepareCommand } from './command.js';
import { CommandJobs } from './jobs.js';
import { ExecutionQueue } from './queue.js';
import { redactData } from './redaction.js';
import { parseLocalSettings } from './settings.js';
import type { LocalSettings } from './settings.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConnectionServiceError('invalid_cli_output');
  return value as Record<string, unknown>;
}
const failure = (error: unknown): ReasonCode => error instanceof ConnectionServiceError ? error.reasonCode : 'service_unavailable';

export function createLocalBackend(settings: LocalSettings = {}, limits: ExecutionLimits = { ...DEFAULT_LIMITS }, runtime: LocalRuntime = {}): DingtalkBackend {
  const binding = parseLocalSettings(settings);
  const resources = parseLimits(limits);
  const executor = new DwsExecutor(binding, resources, runtime);
  const queue = new ExecutionQueue(resources);
  const verified = new Set<string>();
  const jobs = new CommandJobs();
  let closed = false;
  let verifiedAt: string | undefined;
  const [corpId, userId] = binding.profile?.split(':') ?? [];
  async function snapshot(signal: AbortSignal): Promise<ConnectionStatus> {
    if (!binding.profile) { await executor.check(signal); return { state: 'unlinked', reasonCode: 'not_connected' }; }
    const status = object(await executor.execute(['auth', 'status', '--readonly', `--profile=${binding.profile}`, '--format=json'], signal));
    if (status.success !== true || typeof status.authenticated !== 'boolean') throw new ConnectionServiceError('invalid_cli_output');
    if (status.reason !== undefined) { verified.clear(); return { state: 'unknown', reasonCode: 'connection_unknown' }; }
    if (!status.authenticated) { verified.clear(); return { state: 'unlinked', reasonCode: 'not_connected' }; }
    if (status.corp_id !== corpId || status.user_id !== userId) { verified.clear(); return { state: 'identity_mismatch', reasonCode: 'identity_mismatch' }; }
    if (status.token_valid !== true) { verified.clear(); return { state: 'unknown', reasonCode: 'token_refresh_pending' }; }
    if (!verified.size) return { state: 'unknown', reasonCode: 'business_verification_required' };
    return { state: 'connected', ...(verifiedAt ? { checkedAt: verifiedAt } : {}), capabilitySummary: [...verified] };
  }
  function businessResult(value: unknown, operationId?: InvokeInput['operationId']): unknown {
    const result = object(value);
    if (result.success !== true || result.isError === true || result.error !== undefined) throw new ConnectionServiceError('cli_failed');
    if ('result' in result) return result.result;
    if ('data' in result) return result.data;
    // Official document search projects its successful payload at the root.
    // This is operation-specific; arbitrary success-only objects remain invalid.
    if (operationId === 'docs.search' && Array.isArray(result.documents)) {
      if ((result.hasMore !== undefined && typeof result.hasMore !== 'boolean') || (result.nextPageToken !== undefined && typeof result.nextPageToken !== 'string')) throw new ConnectionServiceError('invalid_cli_output');
      return { documents: result.documents, ...(result.hasMore !== undefined ? { hasMore: result.hasMore } : {}), ...(result.nextPageToken !== undefined ? { nextPageToken: result.nextPageToken } : {}) };
    }
    throw new ConnectionServiceError('invalid_cli_output');
  }
  function verifyIdentity(value: unknown): unknown {
    const data = businessResult(value);
    const entries = Array.isArray(data) ? data : object(data).result;
    if (!Array.isArray(entries) || entries.length !== 1) throw new ConnectionServiceError('identity_mismatch');
    const identity = object(object(entries[0]).orgEmployeeModel);
    if (identity.corpId !== corpId || identity.userId !== userId) throw new ConnectionServiceError('identity_mismatch');
    return data;
  }
  async function identityCheck(signal: AbortSignal) {
    if (!binding.profile) throw new ConnectionServiceError('not_connected');
    const status = await snapshot(signal);
    if (status.state === 'unlinked') throw new ConnectionServiceError('not_connected');
    if (status.state === 'identity_mismatch') throw new ConnectionServiceError('identity_mismatch');
    if (status.state !== 'connected' && !['business_verification_required','token_refresh_pending'].includes(status.reasonCode || '')) throw new ConnectionServiceError(status.reasonCode || 'connection_unknown');
    verifyIdentity(await executor.execute(operationArguments({ operationId: 'identity.getSelf', args: {} }, binding.profile), signal));
  }
  async function generic(request: import('../../shared/models.js').DwsInput, options: CallOptions): Promise<InvokeResult> {
    let executing = false;
    try {
      if (request.operationId === 'dws.catalog') return { status: 'ok', data: discover(request.args) };
      if (request.operationId === 'dws.describe') return { status: 'ok', data: describe(request.args.command) };
      if (request.operationId === 'dws.jobs') return { status: 'ok', data: await jobs.access(options.sessionId, request.args) };
      if (!binding.profile) return { status: 'auth_required', reasonCode: 'not_connected' };
      const prepared = await prepareCommand(request.args, binding.profile, options, binding.configDirectory);
      if (prepared.needsApproval) {
        if (!options.approve) return { status: 'denied', reasonCode: 'confirmation_required', retryable: false };
        if (!await options.approve(prepared.summary)) return { status: 'denied', reasonCode: 'confirmation_rejected', retryable: false };
      }
      if (closed || options.signal?.aborted) throw new ConnectionServiceError('execution_cancelled');
      // Revalidate paths after the potentially long user decision, then verify the bound identity.
      const ready = await prepareCommand(request.args, binding.profile, options, binding.configDirectory);
      return await queue.run(async signal => {
        await identityCheck(signal);
        if (closed || signal.aborted) throw new ConnectionServiceError('execution_cancelled');
        if (request.args.background) {
          const data = jobs.start(options.sessionId, ready.contract.cli_path, (jobSignal, emit) => executor.execute(ready.argv, jobSignal, '', false, { ...(options.workingDirectory ? { cwd: options.workingDirectory } : {}), timeoutMs: 6 * 60 * 60 * 1000, onValue: emit }));
          return { status: 'ok', data };
        }
        executing = true;
        const value = await executor.execute(ready.argv, signal, '', true, { ...(options.workingDirectory ? { cwd: options.workingDirectory } : {}), timeoutMs: 120000 });
        const data = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
        if (data && (data.success === false || data.isError === true || data.error !== undefined)) throw new ConnectionServiceError('cli_failed');
        verified.add('dws.execute'); verifiedAt = new Date().toISOString();
        return { status: 'ok', data: redactData(data && 'result' in data ? data.result : data && 'data' in data ? data.data : value) };
      }, options.signal, 120000);
    } catch (error) {
      const reasonCode = failure(error);
      if (['not_connected','authorization_expired','scope_authorization_required'].includes(reasonCode)) return { status: 'auth_required', reasonCode };
      if (executing && request.operationId === 'dws.execute' && commandFor(request.args.command).effect !== 'read' && !['permission_denied','app_permission_denied','org_policy_denied'].includes(reasonCode)
        && ['execution_timeout','execution_cancelled','invalid_cli_output','output_limit_exceeded','cli_failed','service_unavailable'].includes(reasonCode)) return { status: 'failed', reasonCode: 'outcome_unknown', retryable: false };
      return { status: ['identity_mismatch','file_access_denied','host_managed_operation','command_unavailable'].includes(reasonCode) ? 'denied' : 'failed', reasonCode, retryable: false };
    }
  }
  return {
    mode: 'local',
    async status(options: CallOptions = {}) {
      try { return await queue.run(signal => snapshot(signal), options.signal); }
      catch (error) { return { state: 'unknown', reasonCode: failure(error) }; }
    },
    beginAuthorization: async () => { throw new ConnectionServiceError('backend_not_ready'); },
    getAuthorizationStatus: async () => ({ state: 'unknown', reasonCode: 'backend_not_ready' }),
    disconnect: async () => ({ disconnected: false }),
    async invoke(input: InvokeInput, options: CallOptions = {}): Promise<InvokeResult> {
      let request: InvokeInput;
      try { request = parseInvokeInput(input); } catch { return { status: 'failed', reasonCode: 'invalid_request', retryable: false }; }
      if (request.operationId === 'dws.catalog' || request.operationId === 'dws.describe' || request.operationId === 'dws.execute' || request.operationId === 'dws.jobs') return generic(request, options);
      try {
        return await queue.run(async signal => {
          if (!binding.profile) { await executor.check(signal); return { status: 'auth_required', reasonCode: 'not_connected' }; }
          const status = await snapshot(signal);
          if (status.state === 'unlinked') return { status: 'auth_required', reasonCode: 'not_connected' };
          if (status.state === 'identity_mismatch') return { status: 'denied', reasonCode: 'identity_mismatch', retryable: false };
          if (status.reasonCode !== 'token_refresh_pending' && status.reasonCode !== 'business_verification_required' && status.state !== 'connected') {
            return { status: 'failed', reasonCode: status.reasonCode ?? 'connection_unknown', retryable: true };
          }
          const self = await executor.execute(operationArguments({ operationId: 'identity.getSelf', args: {} }, binding.profile), signal);
          const identity = verifyIdentity(self);
          const data = request.operationId === 'identity.getSelf' ? identity : businessResult(await executor.execute(operationArguments(request, binding.profile), signal), request.operationId);
          const result = redactData(data);
          verified.add('identity.getSelf'); verified.add(request.operationId);
          verifiedAt = new Date().toISOString();
          return { status: 'ok', data: result };
        }, options.signal);
      } catch (error) {
        const reasonCode = failure(error);
        if (['identity_mismatch', 'authorization_expired', 'not_connected', 'connection_unknown'].includes(reasonCode)) verified.clear();
        if (['org_policy_denied', 'permission_denied', 'app_permission_denied'].includes(reasonCode)) return { status: 'denied', reasonCode, retryable: false };
        if (reasonCode === 'scope_authorization_required') return { status: 'auth_required', reasonCode };
        if (reasonCode === 'identity_mismatch') { verified.clear(); return { status: 'denied', reasonCode, retryable: false }; }
        return { status: 'failed', reasonCode, retryable: ['service_unavailable', 'execution_timeout', 'queue_full', 'queue_timeout'].includes(reasonCode) };
      }
    },
    async dispose() { closed = true; verified.clear(); await jobs.dispose(); await queue.dispose(); },
  };
}
