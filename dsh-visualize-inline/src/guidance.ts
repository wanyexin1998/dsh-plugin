export const VISUALIZE_GUIDANCE_EXAMPLES = [
  { version: 1, type: 'metric', label: '指标', value: 123, unit: '元' },
  { version: 1, type: 'progress', label: '目标', value: 80, target: 100 },
  { version: 1, type: 'chart', chart: 'bar', unit: '元', data: [{ label: 'A', value: 123 }] },
  { version: 1, type: 'chart', chart: 'donut', title: '占比', data: [{ label: 'A', value: 60 }, { label: 'B', value: 40 }] },
  { version: 1, type: 'chart', chart: 'funnel', title: '转化', data: [{ label: '访问', value: 1000 }, { label: '注册', value: 400 }] },
  { version: 1, type: 'chart', chart: 'line', title: '实际与预测', series: ['实际', '预测'], data: [{ label: '1月', values: [100, 110] }, { label: '2月', values: [120, 125] }] },
  { version: 1, type: 'metric-group', title: '核心指标', metrics: [{ label: '收入', value: 100, unit: '元' }, { label: '用户', value: 80, unit: '人' }] },
  { version: 1, type: 'flow', title: '审批流程', nodes: [{ id: 'start', label: '提交申请', kind: 'start' }, { id: 'review', label: '是否通过', kind: 'decision' }, { id: 'end', label: '完成', kind: 'end' }], edges: [{ from: 'start', to: 'review' }, { from: 'review', to: 'end', label: '通过' }] },
  { version: 1, type: 'calculator', label: '剩余预算', operation: 'subtract', operands: [1000, 350], unit: '元' },
] as const

export const VISUALIZE_GUIDANCE = `当可视化明显有助于理解时，可在 Markdown 正文原位输出独立的 visualize 围栏。围栏内为严格 JSON，version 固定为 1。只使用已获得的准确数据，标明单位、时间及实际/预测区别；不要编造数据，不在思考过程中输出，不嵌套其他代码块。普通文字或表格已经足够时不要画图，每轮建议最多 6 个组件。

【最重要的判别规则】type 只能是 metric、progress、chart、metric-group、flow、calculator。bar、horizontal-bar、line、donut、funnel 都只是 chart 字段，绝不是 type。禁止 {"type":"bar"}；柱图必须同时写 {"type":"chart","chart":"bar"}。仅输出示例中的字段，不自行发明字段或省略 type/chart。

metric: ${JSON.stringify(VISUALIZE_GUIDANCE_EXAMPLES[0])}
progress: ${JSON.stringify(VISUALIZE_GUIDANCE_EXAMPLES[1])}
单系列 chart: ${JSON.stringify(VISUALIZE_GUIDANCE_EXAMPLES[2])}
chart 支持 bar、horizontal-bar、line、donut、funnel；保持原数据顺序，缺失用 null。donut/funnel 数据非负且最多 12 项。
donut: ${JSON.stringify(VISUALIZE_GUIDANCE_EXAMPLES[3])}
funnel: ${JSON.stringify(VISUALIZE_GUIDANCE_EXAMPLES[4])}

多系列对比使用 series + values，不要使用 value；series 为 2–4 个明确标签，每项 values 必须与 series 等长，仅支持 bar/line。实际、目标、预测必须分成有标识的系列：
${JSON.stringify(VISUALIZE_GUIDANCE_EXAMPLES[5])}

多个并列指标用 metric-group，每项指标不写 version/type：
${JSON.stringify(VISUALIZE_GUIDANCE_EXAMPLES[6])}

流程、判断分支和步骤关系用 flow。节点 kind 只能是 start/process/decision/end；edges 用节点 id 引用，分支条件写 edge.label；V1 仅支持无环流程，不提供任意坐标、HTML 或 Mermaid：
${JSON.stringify(VISUALIZE_GUIDANCE_EXAMPLES[7])}

需要确定性的加减乘除时用 calculator，operation 只能是 add/subtract/multiply/divide；operands 为数值数组，subtract/divide 恰好两项。不要输出任意表达式或代码：
${JSON.stringify(VISUALIZE_GUIDANCE_EXAMPLES[8])}`


export const VISUALIZE_V2_GUIDANCE_EXAMPLES = [
  {
    version: 2, type: 'ui',
    root: { type: 'grid', columns: 2, gap: 'sm', children: [
      { type: 'box', variant: 'card', padding: 'md', children: [{ type: 'icon', name: 'file-text' }, { type: 'title', text: 'Markdown' }, { type: 'text', text: '轻量、直接、可读' }] },
      { type: 'box', variant: 'card', padding: 'md', children: [{ type: 'icon', name: 'blocks' }, { type: 'title', text: 'UI 树' }, { type: 'text', text: '组合布局与局部交互' }] },
    ] },
  },
  {
    version: 2, type: 'ui',
    state: { task1: { type: 'boolean', initial: true }, task2: { type: 'boolean', initial: false } },
    root: { type: 'box', variant: 'card', padding: 'md', gap: 'sm', children: [
      { type: 'title', text: '验收任务' },
      { type: 'text', tone: 'muted', text: { op: 'concat', args: [{ op: 'countTrue', args: [{ op: 'ref', key: 'task1' }, { op: 'ref', key: 'task2' }] }, ' / 2 已完成'] } },
      { type: 'progress', label: '完成度', value: { op: 'countTrue', args: [{ op: 'ref', key: 'task1' }, { op: 'ref', key: 'task2' }] }, target: 2 },
      { type: 'checkbox', label: '插件开发', bind: 'task1' },
      { type: 'checkbox', label: '兼容测试', bind: 'task2' },
    ] },
  },
  {
    version: 2, type: 'ui',
    root: { type: 'box', variant: 'card', padding: 'md', gap: 'sm', children: [
      { type: 'title', text: 'Agent / LLM' },
      { type: 'svg', viewBox: [0, 0, 320, 36], height: 'sm', label: 'Agent 连接到 DSH Runtime', shapes: [{ type: 'line', x1: 160, y1: 0, x2: 160, y2: 32, tone: 'muted', arrowEnd: true }] },
      { type: 'box', variant: 'subtle', padding: 'md', align: 'center', children: [{ type: 'title', text: 'DSH Runtime' }, { type: 'text', tone: 'muted', text: '流式传输与会话存储' }] },
    ] },
  },
] as const

export const VISUALIZE_V2_GUIDANCE = `V2 只用于多个组件需要布局关系或局部状态联动时；单个指标、进度或图表仍优先 V1，普通 Markdown 足够时不要用 UI 树。V2 根结构为 {"version":2,"type":"ui","root":节点,"state":可选状态}，不要输出 version:2 的单个 chart。

P0 节点仅有 box/row/column/grid/divider/spacer/text/title/icon/metric/progress/chart/svg/checkbox。容器 children 为数组；grid 还需要 columns:1–4；text/title 使用 text 字段；gap/padding 仅 none/xs/sm/md/lg，box.variant 仅 plain/card/subtle；icon.name 仅 check-circle/file-text/blocks/chart-no-axes-combined/workflow/wrench/brain/arrow-down/arrow-right/info。不要输出 DOM props、className、style、HTML、JS、CSS 或专用 comparison/checklist/architecture 组件。

V2 的 metric/progress/chart 沿用 V1 字段但不带 version。chart 的判别规则不变：type 是 chart，chart 才是 bar/line 等类型。SVG 只接受数值 viewBox 和 shapes；图元仅 line/polyline/rect/circle/text，不输出原始 SVG、path、URL 或事件。

状态键格式为 [A-Za-z][A-Za-z0-9_-]{0,39}。checkbox.bind 引用已声明的 boolean 键。派生值仅用于 text/title/metric.value/progress.value，基础操作包括 {"op":"ref","key":"..."}、{"op":"countTrue","args":[...]}、{"op":"concat","args":[...]}。countTrue 只接受布尔表达式；需要拼接文本时用 concat，不能直接返回布尔。交互只是本围栏临时状态，不能声称已更新真实任务或保存数据。

双列对比示例：${JSON.stringify(VISUALIZE_V2_GUIDANCE_EXAMPLES[0])}
任务联动示例：${JSON.stringify(VISUALIZE_V2_GUIDANCE_EXAMPLES[1])}
架构连接示例：${JSON.stringify(VISUALIZE_V2_GUIDANCE_EXAMPLES[2])}
优先最小结构，不滥用卡片、颜色和大标题。`


export const VISUALIZE_V2_P1_GUIDANCE_EXAMPLE = {
  version: 2, type: 'ui',
  state: {
    customers: { type: 'number', initial: 20, min: 0, max: 100, step: 1 },
  },
  root: { type: 'box', variant: 'card', padding: 'md', gap: 'md', children: [
    { type: 'title', text: '预计收入测算' },
    { type: 'text', tone: 'muted', text: '模拟：仅计算声明的假设，不代表实际收入。' },
    { type: 'slider', label: '客户数', bind: 'customers', unit: '人' },
    { type: 'metric', label: '预计收入', value: { op: 'mul', args: [{ op: 'ref', key: 'customers' }, 500] }, unit: '元' },
    { type: 'button', label: '重置', action: 'reset' },
  ] },
} as const

export const VISUALIZE_V2_P1_SELECT_EXAMPLE = {
  version: 2, type: 'ui', state: { view: { type: 'enum', initial: 'summary', options: [{ value: 'summary', label: '摘要' }, { value: 'detail', label: '详细说明' }] } },
  root: { type: 'box', children: [{ type: 'select', label: '阅读方式', bind: 'view' }, { type: 'text', text: { op: 'concat', args: ['当前选择：', { op: 'ref', key: 'view' }] } }] },
} as const

export const VISUALIZE_V2_P1_GUIDANCE = `V2 参数交互已支持 number/enum 状态、slider/select/button。number 声明必须包含 initial/min/max/step，min < max、step > 0，初值位于范围和有效步进点；slider.bind 必须引用 number。enum 声明包含 initial/options，options 为 1–12 个唯一 {value,label}，initial 必须属于选项；select 节点只有 type/label/bind，选项来自状态，不自行添加 options。button 只使用 {"type":"button","label":"重置","action":"reset"}，重置当前围栏全部状态，不接受其他 action。

数值表达式新增 add/sub/mul/div，统一为两个参数的 {"op":"mul","args":[表达式,表达式]}；不支持多参数算术或隐式字符串转数值。round 为 {"op":"round","args":[数值表达式,小数位]}，小数位是 0–6 的整数字面量。除零时显示无法计算，不要输出 NaN/Infinity。参数模拟必须明确标注“模拟/假设”，不能当成真实取数或已保存结果。

参数测算完整示例：${JSON.stringify(VISUALIZE_V2_P1_GUIDANCE_EXAMPLE)}
Select 独立枚举示例：${JSON.stringify(VISUALIZE_V2_P1_SELECT_EXAMPLE)}`
