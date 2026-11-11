import { realpath, lstat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname, basename, sep } from 'node:path';
import { commandFor, integration } from '../../catalog/index.js';
import type { Command } from '../../catalog/index.js';
import { ConnectionServiceError } from '../../shared/models.js';
import type { CallOptions, DwsInput, JsonValue } from '../../shared/models.js';

const localFlags = new Set(['file','file-path','content-file','contents-file','config-file','records-file','groups-file','additional-files','form-cover-file','media-files','output','output-dir','export-output','qr-file','knowledge-dir']);
const forbiddenFlags = /^(?:profile|format|client-id|client-secret|token|debug|verbose|mock|yes|user-say-yes|jq|agent-cmd|agent-workdir|command|robot-client-secret|webhook-token|token-auth-config|personal-event-base-url|stream-ticket-url|debug-raw-events)$/;
const fail = (reason: 'invalid_request' | 'file_access_denied' = 'invalid_request'): never => { throw new ConnectionServiceError(reason); };
function inside(root: string, path: string) { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)); }
async function workspaceFile(value: string, workspace: string | undefined, privateDirectory: string | undefined, allowRoot = false): Promise<string> {
  if (!workspace || !value || /[\u0000-\u001f]/.test(value) || value === '-' || value.startsWith('~') || value.startsWith('\\\\')) return fail('file_access_denied');
  const root = await realpath(workspace).catch(() => fail('file_access_denied'));
  let path = resolve(root, value);
  // Windows temp/workspace paths may use an 8.3 alias; normalize that trusted prefix.
  const suppliedRoot = resolve(workspace);
  if (isAbsolute(value) && inside(suppliedRoot, path)) path = resolve(root, relative(suppliedRoot, path));
  const privateRoot = privateDirectory ? await realpath(privateDirectory).catch(() => resolve(privateDirectory)) : undefined;
  if (relative(root, path).includes(':') || !inside(root, path) || (path === root && !allowRoot) || (privateRoot && inside(privateRoot, path))) return fail('file_access_denied');
  if (relative(root, path).split(sep).some(part => /^(?:\.git|\.ssh|\.aws|\.azure|\.dws|\.dsh|\.codex|\.env(?:\..*)?)$/i.test(part))) return fail('file_access_denied');
  if (path === root && allowRoot) return '.';
  // Inspect every existing component, including the final file; reject links/junctions.
  let current = root;
  for (const part of relative(root, path).split(sep)) {
    current = resolve(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) return fail('file_access_denied'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const parent = await realpath(dirname(path)).catch(() => fail('file_access_denied'));
  if (!inside(root, parent)) return fail('file_access_denied');
  return relative(root, resolve(parent, basename(path)));
}
export interface PreparedCommand { contract: Command; argv: string[]; parameters: Record<string, JsonValue>; needsApproval: boolean; summary: string }
export async function prepareCommand(input: Extract<DwsInput, { operationId: 'dws.execute' }>['args'], profile: string, options: CallOptions, privateDirectory?: string): Promise<PreparedCommand> {
  const contract = commandFor(input.command), availability = integration(contract);
  if (availability !== 'available') throw new ConnectionServiceError(availability === 'upstream_unavailable' ? 'command_unavailable' : 'host_managed_operation');
  const parameters: Record<string, JsonValue> = {};
  let files = false;
  for (const [key, value] of Object.entries(input.parameters)) {
    const spec = contract.parameters[key];
    if (!spec || (forbiddenFlags.test(key) && !(key === 'format' && contract.cli_path === 'aitable +export-data')) || !/^[A-Za-z][A-Za-z0-9-]*$/.test(key)) return fail();
    if (spec.type === 'boolean' && typeof value !== 'boolean') return fail();
    if (spec.type === 'integer' && (typeof value !== 'number' || !Number.isSafeInteger(value))) return fail();
    if (spec.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return fail();
    if (spec.type === 'array' && (!Array.isArray(value) || value.some(item => typeof item !== spec.item_type))) return fail();
    if (spec.type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) return fail();
    if (spec.type === 'string' && typeof value !== 'string' && !(spec.format === 'json' || /JSON/i.test(spec.description || ''))) return fail();
    if (value === null || (typeof value === 'string' && value.includes('\0'))) return fail();
    if (spec.enum?.length && !spec.enum.includes(value)) return fail();
    // CLI @file expansion must not become an implicit arbitrary file read.
    if (typeof value === 'string' && !/media-id$/.test(key) && /^@(?:[-A-Za-z0-9./~_\\])/.test(value)) return fail('file_access_denied');
    if (localFlags.has(key)) {
      files = true;
      if (Array.isArray(value)) parameters[key] = await Promise.all(value.map(v => typeof v === 'string' ? workspaceFile(v, options.workingDirectory, privateDirectory) : fail()));
      else if (typeof value === 'string') parameters[key] = await workspaceFile(value, options.workingDirectory, privateDirectory, key.endsWith('-dir'));
      else return fail();
    } else parameters[key] = value;
  }
  for (const [key, spec] of Object.entries(contract.parameters)) if ((spec.required || spec.cli_required) && parameters[key] === undefined) return fail();
  if (typeof parameters.filename === 'string' && /[\\/:]|^\.\.?$/.test(parameters.filename)) return fail('file_access_denied');
  const argv = contract.cli_path.split(' ');
  if (argv.some(part => !/^[a-z0-9+_-]+$/.test(part))) return fail();
  for (const [key, value] of Object.entries(parameters)) {
    const spec = contract.parameters[key]!;
    if (spec.type === 'array' && Array.isArray(value)) {
      if (spec.cli_encoding === 'repeat') { for (const item of value) argv.push(`--${key}=${item}`); }
      else argv.push(`--${key}=${value.map(item => typeof item === 'string' && /[,\"\r\n]/.test(item) ? '\"' + item.replaceAll('\"', '\"\"') + '\"' : String(item)).join(',')}`);
    } else argv.push(`--${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`);
  }
  const decision = approvalOf(contract, parameters, files, input.background);
  if ((files || /(?:download|export|render|preview|consume)/.test(contract.cli_path)) && !options.workingDirectory) return fail('file_access_denied');
  // Event consumers remain owned by our process/job lifecycle, never detach a daemon.
  if (contract.cli_path === 'event consume') {
    if (!input.background) return fail();
    argv.push('--foreground=true');
  }
  if (process.platform === 'win32' && argv.join(' ').length > 28000) return fail();
  // --yes is supplied only after Host confirmation (or when official contract requires none).
  argv.push(`--profile=${profile}`, '--yes');
  if (Object.hasOwn(contract.parameters, 'user-say-yes')) argv.push('--user-say-yes=true');
  // This product-local flag selects the exported attachment type, not stdout encoding.
  if (contract.cli_path !== 'aitable +export-data') argv.push(`--format=${input.background ? 'ndjson' : 'json'}`);
  return { contract, argv, parameters, needsApproval: decision.needsApproval, summary: decision.summary };
}
function approvalOf(contract: Command, parameters: Record<string, JsonValue>, files: boolean, background: boolean | undefined): { needsApproval: boolean; summary: string } {
  const localEffect = /(?:download|export|render|preview|consume)/.test(contract.cli_path);
  const needsApproval = localEffect || contract.effect !== 'read' || contract.confirmation === 'user_required' || contract.risk === 'high' || files || !!background;
  const summary = `钉钉操作：${contract.agent_summary}\n命令：dws ${contract.cli_path}\n账号：当前已连接账号\n${JSON.stringify(parameters, null, 2)}${background ? '\n将在后台持续运行，可用 dws.jobs 停止。' : ''}`;
  return { needsApproval, summary };
}
/** Host-side confirmation decision. File bytes are still checked by the process that runs DWS. */
export function hostApproval(input: { command: string; parameters: Record<string, JsonValue>; background?: boolean }): { needsApproval: boolean; summary: string } {
  const contract = commandFor(input.command);
  const availability = integration(contract);
  if (availability !== 'available') throw new ConnectionServiceError(availability === 'upstream_unavailable' ? 'command_unavailable' : 'host_managed_operation');
  return approvalOf(contract, input.parameters, Object.keys(input.parameters).some(key => localFlags.has(key)), input.background);
}
