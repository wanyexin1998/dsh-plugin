import type { InvokeInput } from '../../shared/models.js';
import { parseInvokeInput } from '../../shared/validation.js';

export const OPERATIONS = Object.freeze({
  'identity.getSelf': Object.freeze(['contact', 'user', 'get-self']),
  'calendar.listEvents': Object.freeze(['calendar', 'event', 'list']),
  'docs.search': Object.freeze(['doc', 'search']),
});
export function operationArguments(input: InvokeInput, profile: string): string[] {
  const request = parseInvokeInput(input);
  const args = [...OPERATIONS[request.operationId]];
  // Equals-form prevents flag-shaped query/cursor strings becoming new CLI flags.
  for (const [key, value] of Object.entries(request.args)) args.push(`--${key}=${value}`);
  if (request.operationId === 'calendar.listEvents') args.push('--calendar-id=primary');
  return [...args, `--profile=${profile}`, '--format=json'];
}
