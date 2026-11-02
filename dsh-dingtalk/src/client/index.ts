import { createElement as h } from 'react';
import type { ReactNode } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import { parseConfig } from '../shared/config.js';

interface SettingsSlots {
  register(options: { name: 'settings.section'; id: string; order: number; label: string },
    component: (props: { close: () => void }) => ReactNode): () => void;
}
export const name = 'dsh-dingtalk';
export const inject = ['slots'];
export function ConnectionSection(): ReactNode {
  return h('section', { 'aria-label': '钉钉连接', 'data-dsh-dingtalk': 'foundation' },
    h('h2', null, '钉钉连接'),
    h('p', { role: 'status' }, '连接功能尚未启用'),
    h('p', null, '钉钉连接功能正在开发，暂时无法授权或读取钉钉数据。'),
    h('button', { type: 'button', disabled: true }, '连接钉钉（即将开放）'));
}
export function apply(ctx: Context & { slots: SettingsSlots }, config: unknown): void {
  parseConfig(config);
  ctx.effect(() => ctx.slots.register({ name: 'settings.section', id: 'dsh-dingtalk', order: 60, label: '钉钉连接' }, ConnectionSection));
}
