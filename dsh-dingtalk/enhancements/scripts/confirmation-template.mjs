import { catalog, integration } from '../lib/catalog/index.js';
import { confirmationException } from '../lib/host/confirmation.js';

const chineseDescriptions = new Map([
  ['aicard explain', '按名称查询卡片字段、示例和注意事项'],
  ['aicard lint', '检查现有 A2UI 卡片文件的语法和协议结构'],
  ['aicard preview', '将新的完整卡片发送给当前用户以预览'],
]);
const lines = [
  `# DWS ${catalog.version}（${catalog.commit}），共 ${catalog.toolCount} 个命令入口。`,
  '# 复制需要的条目到 dsh-dingtalk/web 的 config。只可把注明「可免确认」的条目改为 true。',
  '# false 或省略沿用现有规则；原来无需确认的查询仍无需确认。',
  'confirmationAllowlist:',
];
for (const product of catalog.products) {
  lines.push(`  # 产品：${product.id}`);
  for (const command of product.tools) {
    const note = confirmationException(command);
    const state = note ? `可免确认：${note}` :
      integration(command) === 'available' ? '沿用现有规则' : '不开放给机器人执行';
    const description = chineseDescriptions.get(command.cli_path) ?? command.agent_summary.replace(/\s+/g, ' ').trim();
    lines.push(`  ${JSON.stringify(command.cli_path)}: false # ${state}；${description}`);
  }
}
process.stdout.write([...lines, ''].join(String.fromCharCode(10)));
