export const v2Tasks = {
  version: 2, type: 'ui',
  state: { task1: { type: 'boolean', initial: true }, task2: { type: 'boolean', initial: false }, task3: { type: 'boolean', initial: false } },
  root: { type: 'box', variant: 'card', padding: 'md', gap: 'md', children: [
    { type: 'row', align: 'center', children: [
      { type: 'title', text: 'MVP 工程任务' }, { type: 'spacer' },
      { type: 'text', tone: 'muted', text: { op: 'concat', args: [{ op: 'countTrue', args: [{ op: 'ref', key: 'task1' }, { op: 'ref', key: 'task2' }, { op: 'ref', key: 'task3' }] }, ' / 3 已完成'] } },
    ] },
    { type: 'progress', label: '完成度', value: { op: 'countTrue', args: [{ op: 'ref', key: 'task1' }, { op: 'ref', key: 'task2' }, { op: 'ref', key: 'task3' }] }, target: 3 },
    { type: 'checkbox', label: '插件开发', description: '完成插件注册与安装', bind: 'task1' },
    { type: 'checkbox', label: '组件渲染', description: '完成基础组件与布局', bind: 'task2' },
    { type: 'checkbox', label: '兼容性测试', description: '验证历史与普通 Markdown', bind: 'task3' },
  ] },
}

export const v2Comparison = {
  version: 2, type: 'ui',
  root: { type: 'grid', columns: 2, gap: 'sm', children: [
    { type: 'box', variant: 'card', padding: 'md', gap: 'sm', children: [
      { type: 'icon', name: 'file-text', size: 'lg' }, { type: 'title', text: 'Markdown 正文' },
      { type: 'text', text: '回答、说明与精确表格' }, { type: 'divider' }, { type: 'text', tone: 'muted', text: '轻量、直接、可读' },
    ] },
    { type: 'box', variant: 'card', padding: 'md', gap: 'sm', children: [
      { type: 'icon', name: 'blocks', size: 'lg' }, { type: 'title', text: 'Generative UI' },
      { type: 'text', text: '信息组织与局部交互' }, { type: 'divider' }, { type: 'text', tone: 'muted', text: '可组合、原生、受控' },
    ] },
  ] },
}

export const v2Architecture = {
  version: 2, type: 'ui',
  root: { type: 'box', variant: 'card', padding: 'md', gap: 'sm', children: [
    { type: 'column', align: 'center', children: [{ type: 'title', text: 'Agent / LLM' }, { type: 'text', tone: 'muted', text: 'Markdown + UI JSON' }] },
    { type: 'svg', viewBox: [0, 0, 320, 36], height: 'sm', label: 'Agent 连接运行时', shapes: [{ type: 'line', x1: 160, y1: 0, x2: 160, y2: 32, tone: 'muted', arrowEnd: true }] },
    { type: 'box', variant: 'subtle', padding: 'md', align: 'center', children: [{ type: 'title', text: 'DSH Runtime' }, { type: 'text', tone: 'muted', text: '流式传输与会话存储' }] },
    { type: 'svg', viewBox: [0, 0, 320, 36], height: 'sm', label: '运行时连接两个输出', shapes: [{ type: 'line', x1: 160, y1: 0, x2: 160, y2: 12, tone: 'muted' }, { type: 'polyline', points: [[80, 34], [80, 12], [240, 12], [240, 34]], tone: 'muted' }] },
    { type: 'grid', columns: 2, gap: 'sm', children: [
      { type: 'box', variant: 'card', padding: 'md', align: 'center', children: [{ type: 'icon', name: 'file-text' }, { type: 'title', text: 'Markdown' }] },
      { type: 'box', variant: 'card', padding: 'md', align: 'center', children: [{ type: 'icon', name: 'blocks' }, { type: 'title', text: 'UI 组件树' }] },
    ] },
  ] },
}

export const v2Markdown = `以下是本次工程迭代需要验收的任务：

\`\`\`visualize
${JSON.stringify(v2Tasks)}
\`\`\`

全部验收通过后再进行正式发布。下面比较两种表达方式：

\`\`\`visualize
${JSON.stringify(v2Comparison)}
\`\`\`

最后看一下原生架构关系：

\`\`\`visualize
${JSON.stringify(v2Architecture)}
\`\`\`

后续正文仍然保持原生 Markdown。`


export const p1Parameters = {
  version: 2, type: 'ui',
  state: {
    customers: { type: 'number', initial: 20, min: 0, max: 100, step: 1 },
    price: { type: 'number', initial: 500, min: 100, max: 1000, step: 100 },
    view: { type: 'enum', initial: 'summary', options: [{ value: 'summary', label: '摘要' }, { value: 'detail', label: '详细说明' }] },
  },
  root: { type: 'box', variant: 'card', padding: 'md', gap: 'md', children: [
    { type: 'title', text: '预计收入测算' },
    { type: 'text', tone: 'muted', text: '模拟：仅计算声明的假设，不代表实际收入。' },
    { type: 'slider', label: '客户数', bind: 'customers', unit: '人' },
    { type: 'slider', label: '客单价', bind: 'price', unit: '元' },
    { type: 'select', label: '阅读方式', bind: 'view' },
    { type: 'text', tone: 'muted', text: { op: 'concat', args: ['当前选择：', { op: 'ref', key: 'view' }] } },
    { type: 'metric', label: '预计收入', value: { op: 'mul', args: [{ op: 'ref', key: 'customers' }, { op: 'ref', key: 'price' }] }, unit: '元' },
    { type: 'metric', label: '人均分摊', value: { op: 'round', args: [{ op: 'div', args: [10000, { op: 'ref', key: 'customers' }] }, 2] }, unit: '元' },
    { type: 'button', label: '重置', action: 'reset' },
  ] },
}

export const p1Markdown = `下面是一个只影响当前界面的参数测算：

\`\`\`visualize
${JSON.stringify(p1Parameters)}
\`\`\`

调整参数不会修改真实业务数据。`
