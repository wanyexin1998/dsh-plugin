import { catalog, integration } from '../lib/catalog/index.js';

const chineseDescriptions = new Map([
  ['aicard explain', '按名称查询卡片字段、示例和注意事项'],
  ['aicard lint', '检查现有 A2UI 卡片文件的语法和协议结构'],
  ['aicard preview', '将新的完整卡片发送给当前用户以预览'],
]);
const lines = [
  `# DWS ${catalog.version}（${catalog.commit}），共 ${catalog.toolCount} 个命令入口。`,
  '# 加入 dsh-dingtalk/web 的 config 后，所有可执行的 DWS 命令免确认。',
  '# 不想免确认的命令可改设为 false 或从配置删除。命令可用性和资源授权不变。',
  'confirmationAllowlist:',
];
for (const product of catalog.products) {
  lines.push(`  # 产品：${product.id}`);
  for (const command of product.tools) {
    const description = chineseDescriptions.get(command.cli_path) ?? command.agent_summary.replace(/\s+/g, ' ').trim();
    const comment = integration(command) === 'available' ? description : `不开放给机器人执行；${description}`;
    lines.push(`  ${JSON.stringify(command.cli_path)}: true # ${comment}`);
  }
}
process.stdout.write([...lines, ''].join(String.fromCharCode(10)));
