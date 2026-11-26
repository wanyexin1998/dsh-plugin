export const MAX_JSON_BYTES = 32 * 1024
export const MAX_DATA_POINTS = 120

export interface MetricConfig {
  version: 1
  type: 'metric'
  label: string
  value: number | string
  unit?: string
  note?: string
}

export interface ProgressConfig {
  version: 1
  type: 'progress'
  label: string
  value: number
  target: number
  unit?: string
}

export interface ChartPoint {
  label: string
  value: number | null
}

export interface SeriesPoint {
  label: string
  values: Array<number | null>
}

interface ChartBase {
  version: 1
  type: 'chart'
  title?: string
  unit?: string
}

export interface StandardChartConfig extends ChartBase {
  chart: 'bar' | 'horizontal-bar' | 'line'
  series?: never
  data: ChartPoint[]
}

export interface MultiSeriesChartConfig extends ChartBase {
  chart: 'bar' | 'line'
  series: string[]
  data: SeriesPoint[]
}

export interface DistributionChartConfig extends ChartBase {
  chart: 'donut' | 'funnel'
  series?: never
  data: ChartPoint[]
}

export type ChartConfig = StandardChartConfig | MultiSeriesChartConfig | DistributionChartConfig

export interface MetricGroupConfig {
  version: 1
  type: 'metric-group'
  title?: string
  metrics: Array<Omit<MetricConfig, 'version' | 'type'>>
}

export interface FlowNode {
  id: string
  label: string
  kind: 'start' | 'process' | 'decision' | 'end'
}

export interface FlowConfig {
  version: 1
  type: 'flow'
  title?: string
  nodes: FlowNode[]
  edges: Array<{ from: string; to: string; label?: string }>
}

export interface CalculatorConfig {
  version: 1
  type: 'calculator'
  label: string
  operation: 'add' | 'subtract' | 'multiply' | 'divide'
  operands: number[]
  unit?: string
  note?: string
}

export type VisualizeConfig = MetricConfig | ProgressConfig | ChartConfig | MetricGroupConfig | FlowConfig | CalculatorConfig
export type ParseVisualizeResult =
  | { ok: true; config: VisualizeConfig }
  | { ok: false; reason: string }

export class InvalidJson extends Error {}

export function invalid(reason: string): never {
  throw new InvalidJson(reason)
}

function validUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

class StrictJsonParser {
  private index = 0

  constructor(private readonly source: string) {}

  parse(): unknown {
    const value = this.value(0)
    this.space()
    if (this.index !== this.source.length) invalid('JSON 末尾存在额外内容')
    return value
  }

  private space(): void {
    while (this.index < this.source.length && /[\x20\t\r\n]/.test(this.source[this.index]!)) this.index += 1
  }

  private value(depth: number): unknown {
    if (depth > 32) invalid('JSON 嵌套过深')
    this.space()
    const char = this.source[this.index]!
    if (char === '{') return this.object(depth)
    if (char === '[') return this.array(depth)
    if (char === '"') return this.string()
    if (char === '-' || (char >= '0' && char <= '9')) return this.number()
    for (const [literal, value] of [['true', true], ['false', false], ['null', null]] as const) {
      if (this.source.startsWith(literal, this.index)) {
        this.index += literal.length
        return value
      }
    }
    return invalid('JSON 语法无效')
  }

  private object(depth: number): Record<string, unknown> {
    this.index += 1
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    const keys = new Set<string>()
    this.space()
    if (this.source[this.index] === '}') {
      this.index += 1
      return result
    }
    while (this.index < this.source.length) {
      this.space()
      if (this.source[this.index] !== '"') invalid('对象键必须是字符串')
      const key = this.string()
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') invalid('包含不安全的对象键')
      if (keys.has(key)) invalid(`对象键重复：${key}`)
      keys.add(key)
      this.space()
      if (this.source[this.index] !== ':') invalid('对象键后缺少冒号')
      this.index += 1
      result[key] = this.value(depth + 1)
      this.space()
      const char = this.source[this.index]
      this.index += 1
      if (char === '}') return result
      if (char !== ',') invalid('对象字段之间缺少逗号')
    }
    return invalid('对象未闭合')
  }

  private array(depth: number): unknown[] {
    this.index += 1
    const result: unknown[] = []
    this.space()
    if (this.source[this.index] === ']') {
      this.index += 1
      return result
    }
    while (this.index < this.source.length) {
      result.push(this.value(depth + 1))
      this.space()
      const char = this.source[this.index]
      this.index += 1
      if (char === ']') return result
      if (char !== ',') invalid('数组项之间缺少逗号')
    }
    return invalid('数组未闭合')
  }

  private string(): string {
    const start = this.index
    this.index += 1
    let escaped = false
    while (this.index < this.source.length) {
      const char = this.source[this.index]!
      if (!escaped && char === '"') {
        this.index += 1
        let value: unknown
        try {
          value = JSON.parse(this.source.slice(start, this.index))
        } catch {
          return invalid('字符串转义无效')
        }
        if (typeof value !== 'string' || !validUnicode(value)) invalid('字符串包含无效 Unicode')
        return value
      }
      if (!escaped && char.charCodeAt(0) < 0x20) invalid('字符串包含控制字符')
      if (!escaped && char === '\\') escaped = true
      else escaped = false
      this.index += 1
    }
    return invalid('字符串未闭合')
  }

  private number(): number {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.source.slice(this.index))
    if (!match) invalid('数值格式无效')
    this.index += match[0].length
    const value = Number(match[0])
    if (!Number.isFinite(value)) invalid('数值必须有限')
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) invalid('整数超出安全范围')
    return value
  }
}

export function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${path} 必须是对象`)
  return value as Record<string, unknown>
}

export function fields(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[], path: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`${path} 包含未知字段：${key}`)
  for (const key of required) if (!Object.hasOwn(value, key)) invalid(`${path} 缺少字段：${key}`)
}

export function text(value: unknown, path: string, maximum: number, required = false): string {
  if (typeof value !== 'string') invalid(`${path} 必须是字符串`)
  if (required && value.trim().length === 0) invalid(`${path} 不能为空`)
  if (Array.from(value).length > maximum) invalid(`${path} 超过长度限制`)
  return value
}

export function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${path} 必须是有限数值`)
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) invalid(`${path} 超出安全整数范围`)
  return value
}

export function optionalText(value: Record<string, unknown>, key: string, maximum: number): void {
  if (Object.hasOwn(value, key)) text(value[key], key, maximum)
}

function metricValue(value: unknown, path: string): number | string {
  if (typeof value === 'string') {
    const exact = text(value, path, 64, true)
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(exact)) invalid(`${path} 数值字符串格式无效`)
    return exact
  }
  return finiteNumber(value, path)
}

function validateMetric(value: Record<string, unknown>): MetricConfig {
  fields(value, ['version', 'type', 'label', 'value', 'unit', 'note'], ['version', 'type', 'label', 'value'], 'metric')
  const label = text(value.label, 'label', 100, true)
  const current = metricValue(value.value, 'metric.value')
  optionalText(value, 'unit', 30)
  optionalText(value, 'note', 300)
  return { ...value, label, value: current } as unknown as MetricConfig
}

function validateProgress(value: Record<string, unknown>): ProgressConfig {
  fields(value, ['version', 'type', 'label', 'value', 'target', 'unit'], ['version', 'type', 'label', 'value', 'target'], 'progress')
  const label = text(value.label, 'label', 100, true)
  const current = finiteNumber(value.value, 'progress.value')
  const target = finiteNumber(value.target, 'progress.target')
  if (current < 0) invalid('progress.value 不能为负数')
  if (target <= 0) invalid('progress.target 必须大于 0')
  if (!Number.isFinite(current / target)) invalid('progress 达成率不可计算')
  optionalText(value, 'unit', 30)
  return { ...value, label, value: current, target } as unknown as ProgressConfig
}

export function validateChart(value: Record<string, unknown>): ChartConfig {
  fields(value, ['version', 'type', 'chart', 'title', 'unit', 'series', 'data'], ['version', 'type', 'chart', 'data'], 'chart')
  if (!['bar', 'horizontal-bar', 'line', 'donut', 'funnel'].includes(String(value.chart))) invalid('chart.chart 类型不受支持')
  optionalText(value, 'title', 120)
  optionalText(value, 'unit', 30)
  if (!Array.isArray(value.data) || value.data.length === 0) invalid('chart.data 必须是非空数组')
  if (value.data.length > MAX_DATA_POINTS) invalid('chart.data 超过 120 个数据点')
  if ((value.chart === 'donut' || value.chart === 'funnel') && value.data.length > 12) invalid('donut/funnel 最多 12 项')
  const labels = new Set<string>()
  if (Object.hasOwn(value, 'series')) {
    if (value.chart !== 'bar' && value.chart !== 'line') invalid('多系列仅支持 bar 和 line')
    if (!Array.isArray(value.series) || value.series.length < 2 || value.series.length > 4) invalid('chart.series 必须包含 2–4 个系列')
    const series = value.series.map((entry) => text(entry, 'chart.series', 100, true))
    if (new Set(series).size !== series.length) invalid('chart.series 标签必须唯一')
    const data = value.data.map((entry, index) => {
      const point = record(entry, `chart.data[${index}]`)
      fields(point, ['label', 'values'], ['label', 'values'], `chart.data[${index}]`)
      const label = text(point.label, `chart.data[${index}].label`, 100, true)
      if (labels.has(label)) invalid('同图内 label 必须唯一')
      labels.add(label)
      if (!Array.isArray(point.values) || point.values.length !== series.length) invalid('每个 values 必须与 series 等长')
      const values = point.values.map((item, seriesIndex) => item === null ? null : finiteNumber(item, `chart.data[${index}].values[${seriesIndex}]`))
      return { label, values }
    })
    return { ...value, series, data } as unknown as ChartConfig
  }
  const data = value.data.map((entry, index) => {
    const point = record(entry, `chart.data[${index}]`)
    fields(point, ['label', 'value'], ['label', 'value'], `chart.data[${index}]`)
    const label = text(point.label, `chart.data[${index}].label`, 100, true)
    if (labels.has(label)) invalid('同图内 label 必须唯一')
    labels.add(label)
    const pointValue = point.value === null ? null : finiteNumber(point.value, `chart.data[${index}].value`)
    if ((value.chart === 'donut' || value.chart === 'funnel') && pointValue !== null && pointValue < 0) invalid('donut/funnel 不支持负值')
    return { label, value: pointValue }
  })
  if (value.chart === 'donut' || value.chart === 'funnel') {
    const total = data.reduce((sum, point) => sum + (point.value ?? 0), 0)
    if (!Number.isFinite(total) || total <= 0) invalid('donut/funnel 至少需要一个正值')
  }
  return { ...value, data } as unknown as ChartConfig
}

function validateMetricGroup(value: Record<string, unknown>): MetricGroupConfig {
  fields(value, ['version', 'type', 'title', 'metrics'], ['version', 'type', 'metrics'], 'metric-group')
  optionalText(value, 'title', 120)
  if (!Array.isArray(value.metrics) || value.metrics.length === 0 || value.metrics.length > 6) invalid('metric-group.metrics 必须包含 1–6 项')
  const labels = new Set<string>()
  const metrics = value.metrics.map((entry, index) => {
    const metric = record(entry, `metric-group.metrics[${index}]`)
    fields(metric, ['label', 'value', 'unit', 'note'], ['label', 'value'], `metric-group.metrics[${index}]`)
    const label = text(metric.label, `metric-group.metrics[${index}].label`, 100, true)
    if (labels.has(label)) invalid('指标组内 label 必须唯一')
    labels.add(label)
    optionalText(metric, 'unit', 30)
    optionalText(metric, 'note', 300)
    return { ...metric, label, value: metricValue(metric.value, `metric-group.metrics[${index}].value`) } as MetricGroupConfig['metrics'][number]
  })
  return { ...value, metrics } as unknown as MetricGroupConfig
}

function validateFlow(value: Record<string, unknown>): FlowConfig {
  fields(value, ['version', 'type', 'title', 'nodes', 'edges'], ['version', 'type', 'nodes', 'edges'], 'flow')
  optionalText(value, 'title', 120)
  if (!Array.isArray(value.nodes) || value.nodes.length === 0 || value.nodes.length > 24) invalid('flow.nodes 必须包含 1–24 个节点')
  if (!Array.isArray(value.edges) || value.edges.length > 48) invalid('flow.edges 最多 48 条')
  const ids = new Set<string>()
  const nodes = value.nodes.map((entry, index) => {
    const node = record(entry, `flow.nodes[${index}]`)
    fields(node, ['id', 'label', 'kind'], ['id', 'label', 'kind'], `flow.nodes[${index}]`)
    const id = text(node.id, `flow.nodes[${index}].id`, 40, true)
    if (ids.has(id)) invalid('flow 节点 id 必须唯一')
    ids.add(id)
    if (!['start', 'process', 'decision', 'end'].includes(String(node.kind))) invalid('flow 节点 kind 不受支持')
    return { id, label: text(node.label, `flow.nodes[${index}].label`, 100, true), kind: node.kind } as FlowNode
  })
  const pairs = new Set<string>()
  const edges = value.edges.map((entry, index) => {
    const edge = record(entry, `flow.edges[${index}]`)
    fields(edge, ['from', 'to', 'label'], ['from', 'to'], `flow.edges[${index}]`)
    const from = text(edge.from, `flow.edges[${index}].from`, 40, true)
    const to = text(edge.to, `flow.edges[${index}].to`, 40, true)
    if (!ids.has(from) || !ids.has(to)) invalid('flow 边引用了不存在的节点')
    if (pairs.has(`${from}\0${to}`)) invalid('flow 不允许重复边')
    pairs.add(`${from}\0${to}`)
    optionalText(edge, 'label', 100)
    return { ...edge, from, to } as FlowConfig['edges'][number]
  })
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) invalid('flow V1 仅支持无环流程')
    if (visited.has(id)) return
    visiting.add(id)
    for (const edge of edges) if (edge.from === id) visit(edge.to)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of ids) visit(id)
  return { ...value, nodes, edges } as unknown as FlowConfig
}

function validateCalculator(value: Record<string, unknown>): CalculatorConfig {
  fields(value, ['version', 'type', 'label', 'operation', 'operands', 'unit', 'note'], ['version', 'type', 'label', 'operation', 'operands'], 'calculator')
  const label = text(value.label, 'label', 100, true)
  if (!['add', 'subtract', 'multiply', 'divide'].includes(String(value.operation))) invalid('calculator.operation 不受支持')
  if (!Array.isArray(value.operands) || value.operands.length < 2 || value.operands.length > 6) invalid('calculator.operands 必须包含 2–6 项')
  if ((value.operation === 'subtract' || value.operation === 'divide') && value.operands.length !== 2) invalid('subtract/divide 仅支持两个操作数')
  const operands = value.operands.map((entry, index) => finiteNumber(entry, `calculator.operands[${index}]`))
  if (value.operation === 'divide' && operands[1] === 0) invalid('除数不能为 0')
  const result = value.operation === 'add' ? operands.reduce((sum, item) => sum + item, 0)
    : value.operation === 'multiply' ? operands.reduce((product, item) => product * item, 1)
      : value.operation === 'subtract' ? operands[0]! - operands[1]!
        : operands[0]! / operands[1]!
  finiteNumber(result, 'calculator.result')
  optionalText(value, 'unit', 30)
  optionalText(value, 'note', 300)
  return { ...value, label, operands } as unknown as CalculatorConfig
}

export function parseJsonDocument(code: string): Record<string, unknown> {
  if (new TextEncoder().encode(code).byteLength > MAX_JSON_BYTES) invalid('JSON 超过 32 KiB')
  return record(new StrictJsonParser(code).parse(), '根节点')
}

export function validateVisualizeRoot(root: Record<string, unknown>): VisualizeConfig {
  if (root.version !== 1) invalid('V1 version 必须固定为 1')
  if (root.type === 'metric') return validateMetric(root)
  if (root.type === 'progress') return validateProgress(root)
  if (root.type === 'chart') return validateChart(root)
  if (root.type === 'metric-group') return validateMetricGroup(root)
  if (root.type === 'flow') return validateFlow(root)
  if (root.type === 'calculator') return validateCalculator(root)
  return invalid('type 不受支持')
}

export function parseVisualize(code: string): ParseVisualizeResult {
  try {
    return { ok: true, config: validateVisualizeRoot(parseJsonDocument(code)) }
  } catch (error) {
    if (error instanceof InvalidJson) return { ok: false, reason: error.message }
    return { ok: false, reason: '无法解析可视化配置' }
  }
}
