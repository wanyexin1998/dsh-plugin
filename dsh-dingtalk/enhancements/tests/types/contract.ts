import type { AuthStart, ConnectionStatus, DingtalkBackend, DingtalkConnectionService, InvokeInput } from 'dsh-dingtalk/shared';

const self: InvokeInput = { operationId: 'identity.getSelf', args: {} };
const calendar: InvokeInput = { operationId: 'calendar.listEvents', args: { start: '2026-11-02T00:00:00+08:00', limit: 10 } };
const status: ConnectionStatus = { state: 'unknown', reasonCode: 'backend_not_ready' };
// @ts-expect-error No write operation is part of the public contract.
const write: InvokeInput = { operationId: 'message.send', args: {} };
// @ts-expect-error A caller cannot choose a DWS profile.
const profile: InvokeInput = { operationId: 'identity.getSelf', args: { profile: 'other' } };
// @ts-expect-error No arbitrary CLI argv.
const command: InvokeInput = { operationId: 'docs.search', args: { argv: ['auth', 'logout'] } };
// @ts-expect-error Public status has no token field.
const secretStatus: ConnectionStatus = { state: 'connected', accessToken: 'forbidden' };
// @ts-expect-error Authorization result has no code field.
const secretAuth: AuthStart = { transactionId: 'a'.repeat(32), authorizeUrl: 'https://example.invalid', expiresAt: '2026-11-02T01:00:00Z', authCode: 'forbidden' };

function acceptsBothAdapters(local: DingtalkBackend, cellgent: DingtalkBackend): DingtalkConnectionService[] {
  return [local, cellgent];
}
void [self, calendar, status, write, profile, command, secretStatus, secretAuth, acceptsBothAdapters];
