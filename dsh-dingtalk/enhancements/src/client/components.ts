import { createElement as h } from 'react';
import type { ButtonHTMLAttributes } from 'react';

export type IconName = 'connect' | 'refresh' | 'disconnect' | 'close' | 'hide' | 'copy' | 'external' | 'check' | 'clock' | 'warning' | 'more' | 'user' | 'calendar' | 'file' | 'shield';
const paths: Record<IconName, string> = {
  connect: 'M9 17H7A5 5 0 0 1 7 7h2m6 0h2a5 5 0 0 1 0 10h-2M8 12h8',
  refresh: 'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 3M18 17a7 7 0 0 1-12 2l-2-3',
  disconnect: 'M9 5H4v14h5M13 8l4 4-4 4M8 12h13',
  close: 'M6 6l12 12M18 6 6 18', hide: 'm6 14 6-6 6 6',
  copy: 'M9 8h11v13H9zM15 8V3H4v13h5', external: 'M14 3h7v7M21 3l-11 11M10 4H4v16h16v-6',
  check: 'm5 12 4 4L19 6', clock: 'M12 8v4l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  warning: 'm12 3 10 18H2L12 3Zm0 5v6m0 3v.5', more: 'M5 12h.01M12 12h.01M19 12h.01',
  user: 'M20 21v-2a6 6 0 0 0-6-6h-4a6 6 0 0 0-6 6v2M16 6a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  calendar: 'M3 5h18v16H3zM7 2v6M17 2v6M3 10h18',
  file: 'M14 2H5v20h14V7l-5-5Zm0 0v6h5',
  shield: 'm12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6l8-4Zm-4 10 3 3 5-6',
};
export function icon(name: IconName) { return h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: name === 'more' ? 3 : 1.65, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false }, h('path', { d: paths[name] })); }
export function IconButton({ label, symbol, caption, className = '', ...props }: { label: string; symbol: IconName; caption?: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return h('button', { type: 'button', title: label, 'aria-label': label, ...props, className: 'dsh-dt-icon' + (caption ? ' dsh-dt-caption' : '') + ' ' + className }, icon(symbol), caption ? h('span', null, caption) : null);
}
