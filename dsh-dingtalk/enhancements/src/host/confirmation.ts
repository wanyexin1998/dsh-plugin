import { catalog } from '../catalog/index.js';
import { parseConfig } from '../shared/config.js';

const knownCommands = new Set(catalog.products.flatMap(product => product.tools.map(command => command.cli_path)));

export type ConfirmationAllowlist = ReadonlySet<string>;

/** Read explicit confirmation choices. Command availability and authorizations are checked at execution. */
export function parseConfirmationAllowlist(value: unknown = {}): ConfirmationAllowlist {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(value)))
    throw new Error('dsh-dingtalk: confirmationAllowlist must be a command-to-boolean map');
  const enabled = new Set<string>();
  for (const [name, flag] of Object.entries(value)) {
    if (!knownCommands.has(name)) throw new Error(`dsh-dingtalk: unknown command in confirmationAllowlist: ${name}`);
    if (typeof flag !== 'boolean') throw new Error(`dsh-dingtalk: confirmationAllowlist value for "${name}" must be true or false`);
    if (flag) enabled.add(name);
  }
  return enabled;
}

/** Validate Host-owned command rules against the pinned catalog before mounting the tool. */
export function parseHostConfig(value?: unknown) {
  const { confirmationAllowlist, ...config } = parseConfig(value);
  return { ...config, confirmationAllowlist: parseConfirmationAllowlist(confirmationAllowlist) };
}
