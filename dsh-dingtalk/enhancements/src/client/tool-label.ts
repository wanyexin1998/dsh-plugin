import { commandLabels } from './command-labels.js';

/** The native argument view is lazy and grows during preparation; read on every render. */
export interface ToolArgumentView { text(key: string): string | undefined; value(key: string): unknown }
export function toolLabel(view: ToolArgumentView | undefined, language: string): { label: string; title: string } | undefined {
  if (!view) return;
  try {
    const operation = view.text('operationId'), value = view.value('args');
    const args = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const command = typeof args.command === 'string' && Object.hasOwn(commandLabels, args.command) ? args.command : undefined;
    const zh = language.startsWith('zh');
    const shortNames: Record<string, string> = { 'chat message send': '发送消息', 'chat +messages-send': '发送消息', 'chat thread reply': '回复消息' };
    const name = command ? (zh ? shortNames[command] || commandLabels[command]! : command) : undefined;
    let label: string | undefined;
    if (operation === 'dws.execute') label = name;
    else if (operation === 'dws.describe') label = (zh ? '查看参数' : 'Inspect command') + (name ? `：${name}` : '');
    else if (operation === 'dws.catalog') label = zh ? '查找功能' : 'Find commands';
    else if (operation === 'dws.jobs') label = args.action === 'stop' ? (zh ? '停止后台任务' : 'Stop task') : args.action === 'read' ? (zh ? '读取后台结果' : 'Read task output') : (zh ? '查看后台任务' : 'List tasks');
    else if (operation === 'identity.getSelf') label = zh ? '读取账号' : 'Read account';
    else if (operation === 'calendar.listEvents') label = zh ? '查询日程' : 'List calendar events';
    else if (operation === 'docs.search') label = zh ? '搜索文档' : 'Search documents';
    if (label) return { label, title: command ? `${label} · ${operation} · ${command}` : `${label} · ${operation}` };
  } catch { /* Missing historical arguments must not break the transcript. */ }
}
