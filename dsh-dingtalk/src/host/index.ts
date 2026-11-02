import type { Context } from '@deepseek-ai/cordis';
import { createConnectionService } from '../shared/service.js';
import type { DingtalkConnectionService } from '../shared/models.js';
import { parseConfig } from '../shared/config.js';
import { loadLocalSettings } from '../adapters/local/settings.js';
import { loadPrivateSettings } from './private-settings.js';
import { createManagedConnection } from './managed-connection.js';
import { createUIRpc } from './ui-rpc.js';
import type { HostConnection } from './ui-rpc.js';
import { dingtalkTool } from './tool.js';
import { readFile } from 'node:fs/promises';

declare module '@deepseek-ai/cordis' {
  interface Context { dingtalkConnection: DingtalkConnectionService }
}
export const name = 'dsh-dingtalk';
export const provide = ['dingtalkConnection'];
export async function apply(ctx: Context, config: unknown): Promise<void> {
  const parsed = parseConfig(config);
  const profile = ctx.get('profileContext') as { dir?: string } | undefined;
  const managed = await createManagedConnection(await loadLocalSettings(), await loadPrivateSettings(profile?.dir), parsed.execution);
  const owner = createConnectionService(managed.backend);
  ctx.effect(() => () => owner.dispose());
  ctx.provide('dingtalkConnection', owner.service);
  ctx.inject(['connection', 'webServer'], scope => {
    const connection = (scope as unknown as { connection: HostConnection }).connection;
    scope.effect(() => createUIRpc(connection, managed, owner.service));
  });
  ctx.inject(['tools'], scope => { (scope as unknown as { tools: { register(tool: ReturnType<typeof dingtalkTool>): unknown } }).tools.register(dingtalkTool(owner.service)); });
  ctx.inject(['skills'], async scope => {
    const content = await readFile(new URL('../../skills/dingtalk-readonly/SKILL.md', import.meta.url), 'utf8');
    (scope as unknown as { skills: { register(skill: object): unknown } }).skills.register({ name: 'dingtalk-readonly', description: '读取钉钉本人信息、日程和文档；由用户完成连接授权。', content, source: 'bundled', provider: 'dsh-dingtalk' });
  });
}
