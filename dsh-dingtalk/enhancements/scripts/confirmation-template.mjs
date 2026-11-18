import { catalog, integration } from '../lib/catalog/index.js';
import { confirmationException } from '../lib/host/confirmation.js';

const chineseDescriptions = new Map([
  ['aicard explain', '按名称查询卡片字段、示例和注意事项'],
  ['aicard lint', '检查现有 A2UI 卡片文件的语法和协议结构'],
  ['aicard preview', '将新的完整卡片发送给当前用户以预览'],
]);
const hasReviewedCommands = catalog.products.some(product => product.tools.some(confirmationException));
const lines = [
  `# DWS ${catalog.version}（${catalog.commit}），共 ${catalog.toolCount} 个命令入口。`,
  '# 复制到 dsh-dingtalk/web 的 config 后，只有未注释的条目会启用免确认。',
  '# 注释掉不想开启的条目。其他命令仅供查阅；无需确认的查询仍可直接执行。',
  hasReviewedCommands ? 'confirmationAllowlist:' : 'confirmationAllowlist: {}',
];
for (const product of catalog.products) {
  lines.push(`  # 产品：${product.id}`);
  for (const command of product.tools) {
    const note = confirmationException(command);
    const description = chineseDescriptions.get(command.cli_path) ?? command.agent_summary.replace(/\s+/g, ' ').trim();
    const comment = note ? `可免确认：${note}；${description}` :
      integration(command) === 'available' ? description : `不开放给机器人执行；${description}`;
    lines.push(`  ${note ? '' : '# '}${JSON.stringify(command.cli_path)}: true # ${comment}`);
  }
}
process.stdout.write([...lines, ''].join(String.fromCharCode(10)));
