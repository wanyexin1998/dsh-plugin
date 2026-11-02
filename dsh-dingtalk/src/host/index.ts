import type { Context } from '@deepseek-ai/cordis';
import { createConnectionService } from '../shared/service.js';
import type { DingtalkConnectionService } from '../shared/models.js';
import { parseConfig } from '../shared/config.js';
import { createLocalBackend } from '../adapters/local/index.js';

declare module '@deepseek-ai/cordis' {
  interface Context { dingtalkConnection: DingtalkConnectionService }
}
export const name = 'dsh-dingtalk';
export const provide = ['dingtalkConnection'];
export function apply(ctx: Context, config: unknown): void {
  parseConfig(config);
  const owner = createConnectionService(createLocalBackend());
  ctx.effect(() => () => owner.dispose());
  ctx.provide('dingtalkConnection', owner.service);
}
