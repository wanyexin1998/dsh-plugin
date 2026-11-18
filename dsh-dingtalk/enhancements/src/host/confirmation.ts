import { catalog, integration } from '../catalog/index.js';
import type { Command } from '../catalog/index.js';
import type { DwsInput } from '../shared/models.js';
import { parseConfig } from '../shared/config.js';

const reviewedCommit = 'f215043e676d6889e1ddce3464828d8b1ec40c31';
const reviewed = new Map([
  ['doc create', { canonical: 'doc.create_document', note: '仅传 name，在「我的文档」根目录新建空文档' }],
  ['aitable base create', { canonical: 'aitable.base_create', note: '仅传 name，在默认位置新建空多维表' }],
  ['todo tag create', { canonical: 'todo.create_todo_tag', note: '仅传 name，为当前账号创建待办标签' }],
]);
const knownCommands = new Map(catalog.products.flatMap(product => product.tools.map(command => [command.cli_path, command] as const)));

export type ConfirmationAllowlist = ReadonlySet<string>;

/** Describe the exact invocation granted an exception on the reviewed DWS revision. */
export function confirmationException(command: Command): string | undefined {
  const rule = reviewed.get(command.cli_path);
  if (catalog.commit !== reviewedCommit || !rule || rule.canonical !== command.canonical_path ||
    integration(command) !== 'available' || command.effect !== 'write' ||
    command.risk !== 'medium' || command.confirmation !== 'not_required' ||
    command.parameters.name?.type !== 'string' || command.parameters.name.required !== true) return undefined;
  return rule.note;
}

/** An omitted or false entry leaves the original policy intact. Reject unsafe or stale true entries at load. */
export function parseConfirmationAllowlist(value: unknown = {}): ConfirmationAllowlist {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(value)))
    throw new Error('dsh-dingtalk: confirmationAllowlist must be a command-to-boolean map');
  const enabled = new Set<string>();
  for (const [name, flag] of Object.entries(value)) {
    const command = knownCommands.get(name);
    if (!command) throw new Error(`dsh-dingtalk: unknown command in confirmationAllowlist: ${name}`);
    if (typeof flag !== 'boolean') throw new Error(`dsh-dingtalk: confirmationAllowlist value for "${name}" must be true or false`);
    if (!flag) continue;
    if (!confirmationException(command)) throw new Error(`dsh-dingtalk: "${name}" is not eligible for confirmationAllowlist`);
    enabled.add(name);
  }
  return enabled;
}

/** Validate Host-owned command rules against the pinned catalog before mounting the tool. */
export function parseHostConfig(value?: unknown) {
  const { confirmationAllowlist, ...config } = parseConfig(value);
  return { ...config, confirmationAllowlist: parseConfirmationAllowlist(confirmationAllowlist) };
}

/** The exception is limited to a foreground command using a single literal name. */
export function skipsConfirmation(input: DwsInput, enabled: ConfirmationAllowlist): boolean {
  if (input.operationId !== 'dws.execute' || input.args.background || !enabled.has(input.args.command)) return false;
  const command = knownCommands.get(input.args.command);
  if (!command || !confirmationException(command)) return false;
  const parameters = input.args.parameters;
  if (Object.keys(parameters).length !== 1 || !Object.hasOwn(parameters, 'name')) return false;
  const name = parameters.name;
  return typeof name === 'string' && name.length <= 50 && name === name.trim() &&
    name.length > 0 && name !== '-' && !name.startsWith('@') && !/[\u0000-\u001f\u007f\u2028\u2029]/.test(name);
}
