import type { Context } from '@deepseek-ai/cordis';
import { createConnectionService } from '../shared/service.js';
import type { DingtalkConnectionService } from '../shared/models.js';
import { parseConfig } from '../shared/config.js';
import { loadLocalSettings } from '../adapters/local/settings.js';
import { loadPrivateSettings } from './private-settings.js';
import { createManagedConnection } from './managed-connection.js';
import { createUIRpc } from './ui-rpc.js';
import type { HostConnection } from './ui-rpc.js';
import { catalog } from '../catalog/index.js';
import type { ToolHost } from './tool.js';
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
  ctx.inject(['tools'], scope => { (scope as unknown as { tools: { register(tool: ReturnType<typeof dingtalkTool>): unknown } }).tools.register(dingtalkTool(owner.service, () => ({ approval: scope.get('approval'), workingDirectory: scope.get('workingDirectory') } as ToolHost))); });
  ctx.inject(['skills'], async scope => {
    const guide = await readFile(new URL('../../skills/dingtalk-workspace/SKILL.md', import.meta.url), 'utf8');
    const registry = (scope as unknown as { skills: { register(skill: object): unknown } }).skills;
    registry.register({ name: 'dingtalk-workspace', description: '通过当前授权账号使用钉钉完整工作能力；发现、执行、文件和后台任务。', content: guide, source: 'bundled', provider: 'dsh-dingtalk' });
    for (const product of catalog.products) registry.register({ name: `dingtalk-${product.id}`, description: product.summary, content: `${guide}\n\n本技能对应官方产品：${product.id}。${product.summary}\n先调用 dws.catalog，args={"product":"${product.id}"}，按返回的 nextOffset 翻页；选中命令后调用 dws.describe。`, source: 'bundled', provider: 'dsh-dingtalk' });
  });
}
