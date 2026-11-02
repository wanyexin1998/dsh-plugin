import { readFileSync } from 'node:fs';
import { ConnectionServiceError } from '../shared/models.js';
import type { JsonValue } from '../shared/models.js';

export interface Parameter { type: string; required?: boolean; cli_required?: boolean; description?: string; enum?: JsonValue[]; default?: JsonValue; [key: string]: unknown }
export interface Command {
  cli_path: string; canonical_path: string; agent_summary: string; description: string;
  effect: string; risk: string; confirmation: string; availability: string;
  interface_mode: string; parameters: Record<string, Parameter>; [key: string]: unknown;
}
export interface Product { id: string; summary: string; tools: Command[] }
export const catalog = JSON.parse(readFileSync(new URL('./catalog.json', import.meta.url), 'utf8')) as { version: string; commit: string; toolCount: number; surfaceHash: string; products: Product[] };
const commands = new Map(catalog.products.flatMap(product => product.tools.map(command => [command.cli_path, command] as const)));
// These affect the host's credentials, execution boundary or other Agent runtimes.
// The remaining product commands keep the exact bound profile and official contracts.
export function integration(command: Command): 'available' | 'upstream_unavailable' | 'host_managed' {
  if (command.availability !== 'available') return 'upstream_unavailable';
  if (/^(?:audit |pat |dev connect(?: |$)|dingtalk-tag (?:connect|login|auth)(?: |$)|mcp (?:call|resolve)(?: |$))/.test(command.cli_path)
    || /(?:credential|secret|token)/.test(command.cli_path)
    || ['token', 'agent-cmd', 'command', 'robot-client-secret', 'webhook-token', 'token-auth-config'].some(key => Object.hasOwn(command.parameters, key))) return 'host_managed';
  return 'available';
}
export function commandFor(path: string): Command {
  const command = commands.get(path);
  if (!command) throw new ConnectionServiceError('unknown_command');
  return command;
}
export function discover(args: { product?: string; query?: string; offset?: number; limit?: number }): JsonValue {
  if (!args.product && !args.query) return { version: catalog.version, commands: catalog.toolCount, products: catalog.products.map(p => ({ id: p.id, summary: p.summary, total: p.tools.length, callable: p.tools.filter(t => integration(t) === 'available').length })) };
  const terms = (args.query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const found = catalog.products.filter(p => !args.product || p.id === args.product).flatMap(p => p.tools)
    .filter(t => terms.every(term => `${t.cli_path} ${t.agent_summary} ${t.description}`.toLowerCase().includes(term)));
  const offset = args.offset || 0, limit = args.limit || 20;
  return { total: found.length, offset, nextOffset: offset + limit < found.length ? offset + limit : null, commands: found.slice(offset, offset + limit).map(t => ({ command: t.cli_path, summary: t.agent_summary, effect: t.effect, risk: t.risk, integration: integration(t) })) };
}
export function describe(path: string): JsonValue {
  const command = commandFor(path);
  return { ...command, parameters: Object.entries(command.parameters).filter(([name]) => !['yes', 'user-say-yes'].includes(name)).map(([name, spec]) => ({ name, ...spec })), integration: integration(command), usage: 'Execute with dws.execute and parameters. Credentials/profile and yes/user-say-yes are owned by Host. Output format is managed except the product export-type flag. Local file paths are relative to the current session workspace.' } as unknown as JsonValue;
}
