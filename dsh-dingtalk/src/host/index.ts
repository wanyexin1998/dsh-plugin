import type { Context } from '@deepseek-ai/cordis';
import { createConnectionService } from '../shared/service.js';
import type { DingtalkConnectionService } from '../shared/models.js';
import { parseConfig } from '../shared/config.js';
import { createLocalBackend } from '../adapters/local/index.js';
import { loadLocalSettings } from '../adapters/local/settings.js';

declare module '@deepseek-ai/cordis' {
  interface Context { dingtalkConnection: DingtalkConnectionService }
}
export const name = 'dsh-dingtalk';
export const provide = ['dingtalkConnection'];
export async function apply(ctx: Context, config: unknown): Promise<void> {
  const parsed = parseConfig(config);
  const owner = createConnectionService(createLocalBackend(await loadLocalSettings(), parsed.execution));
  ctx.effect(() => () => owner.dispose());
  ctx.provide('dingtalkConnection', owner.service);
}
