import {
  InvalidJson, fields, finiteNumber, invalid, optionalText, parseJsonDocument, record, text,
  validateChart, validateVisualizeRoot,
  type ChartConfig, type ChartPoint, type SeriesPoint, type VisualizeConfig,
} from './protocol.ts'

export type Scalar = string | number | boolean
export type Expression = Scalar | RefExpression | CountTrueExpression | ConcatExpression | ArithmeticExpression | RoundExpression
export interface RefExpression { op: 'ref'; key: string }
export interface CountTrueExpression { op: 'countTrue'; args: Expression[] }
export interface ConcatExpression { op: 'concat'; args: Expression[] }
export interface ArithmeticExpression { op: 'add' | 'sub' | 'mul' | 'div'; args: [Expression, Expression] }
export interface RoundExpression { op: 'round'; args: [Expression, number] }
export interface BooleanState { type: 'boolean'; initial: boolean }
export interface NumberState { type: 'number'; initial: number; min: number; max: number; step: number }
export interface EnumState { type: 'enum'; initial: string; options: Array<{ value: string; label: string }> }
export type UiStateDeclaration = BooleanState | NumberState | EnumState
export type UiState = Record<string, UiStateDeclaration>

export const ICON_NAMES = ['check-circle', 'file-text', 'blocks', 'chart-no-axes-combined', 'workflow', 'wrench', 'brain', 'arrow-down', 'arrow-right', 'info'] as const
const TONES = ['default', 'muted', 'accent', 'positive', 'negative', 'warning'] as const
const TOKENS = ['none', 'xs', 'sm', 'md', 'lg'] as const
const ALIGNS = ['start', 'center', 'end', 'stretch'] as const

export interface BoxNode { type: 'box'; children: UiNode[]; variant?: 'plain' | 'card' | 'subtle'; padding?: typeof TOKENS[number]; gap?: typeof TOKENS[number]; align?: typeof ALIGNS[number] }
export interface RowNode { type: 'row'; children: UiNode[]; gap?: typeof TOKENS[number]; align?: typeof ALIGNS[number]; justify?: 'start' | 'center' | 'end' | 'between'; wrap?: boolean }
export interface ColumnNode { type: 'column'; children: UiNode[]; gap?: typeof TOKENS[number]; align?: typeof ALIGNS[number] }
export interface GridNode { type: 'grid'; children: UiNode[]; columns: number; gap?: typeof TOKENS[number] }
export interface TextNode { type: 'text'; text: string | Expression; tone?: typeof TONES[number]; size?: 'xs' | 'sm' | 'md'; weight?: 'normal' | 'medium' | 'semibold' }
export interface TitleNode { type: 'title'; text: string | Expression; tone?: typeof TONES[number]; size?: 'sm' | 'md' | 'lg' }
export interface IconNode { type: 'icon'; name: typeof ICON_NAMES[number]; size?: 'sm' | 'md' | 'lg'; tone?: typeof TONES[number] }
export interface MetricNode { type: 'metric'; label: string; value: number | string | Expression; unit?: string; note?: string }
export interface ProgressNode { type: 'progress'; label: string; value: number | Expression; target: number; unit?: string }
export interface ChartNode { type: 'chart'; chart: ChartConfig['chart']; title?: string; unit?: string; series?: string[]; data: ChartPoint[] | SeriesPoint[] }
export interface SvgNode { type: 'svg'; viewBox: [number, number, number, number]; shapes: SvgShape[]; height?: 'sm' | 'md' | 'lg'; label?: string }
export interface CheckboxNode { type: 'checkbox'; label: string; bind: string; description?: string }
export interface SelectNode { type: 'select'; label: string; bind: string }
export interface SliderNode { type: 'slider'; label: string; bind: string; unit?: string }
export interface ButtonNode { type: 'button'; label: string; action: 'reset' }

export type SvgShape =
  | { type: 'line'; x1: number; y1: number; x2: number; y2: number; tone?: typeof TONES[number]; arrowEnd?: boolean }
  | { type: 'polyline'; points: [number, number][]; tone?: typeof TONES[number]; arrowEnd?: boolean }
  | { type: 'rect'; x: number; y: number; width: number; height: number; rx?: number; tone?: typeof TONES[number]; filled?: boolean }
  | { type: 'circle'; cx: number; cy: number; r: number; tone?: typeof TONES[number]; filled?: boolean }
  | { type: 'text'; x: number; y: number; text: string; tone?: typeof TONES[number]; anchor?: 'start' | 'middle' | 'end' }

export type UiNode = BoxNode | RowNode | ColumnNode | GridNode | { type: 'divider' } | { type: 'spacer' }
  | TextNode | TitleNode | IconNode | MetricNode | ProgressNode | ChartNode | SvgNode | CheckboxNode | SelectNode | SliderNode | ButtonNode

export interface UiSpec { version: 2; type: 'ui'; state?: UiState; root: UiNode }
export type AnyVisualizeConfig = VisualizeConfig | UiSpec
export type ParseAnyVisualizeResult = { ok: true; config: AnyVisualizeConfig } | { ok: false; reason: string }

interface ValidationContext {
  state: UiState
  nodes: number
  shapes: number
  chartPoints: number
  expressionNodes: number
}

function choice<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) invalid(`${path} 不受支持`)
  return value as T
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') invalid(`${path} 必须是布尔值`)
  return value
}

function childrenOf(value: Record<string, unknown>, ctx: ValidationContext, depth: number, parent: UiNode['type']): UiNode[] {
  if (!Array.isArray(value.children)) invalid(`${parent}.children 必须是数组`)
  if (value.children.length > 20) invalid(`${parent} 最多 20 个直接子节点`)
  return value.children.map((child) => validateNode(child, ctx, depth + 1, parent))
}

function validateState(value: unknown): UiState {
  if (value === undefined) return {}
  const declarations = record(value, 'state')
  const keys = Object.keys(declarations)
  if (keys.length > 20) invalid('state 最多 20 个声明')
  const result: UiState = Object.create(null) as UiState
  for (const key of keys) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(key)) invalid('状态键格式无效')
    const declaration = record(declarations[key], `state.${key}`)
    if (declaration.type === 'boolean') {
      fields(declaration, ['type', 'initial'], ['type', 'initial'], `state.${key}`)
      result[key] = { type: 'boolean', initial: booleanValue(declaration.initial, `state.${key}.initial`) }
    } else if (declaration.type === 'number') {
      fields(declaration, ['type', 'initial', 'min', 'max', 'step'], ['type', 'initial', 'min', 'max', 'step'], `state.${key}`)
      const initial = finiteNumber(declaration.initial, `state.${key}.initial`)
      const min = finiteNumber(declaration.min, `state.${key}.min`)
      const max = finiteNumber(declaration.max, `state.${key}.max`)
      const step = finiteNumber(declaration.step, `state.${key}.step`)
      if (min >= max || step <= 0 || initial < min || initial > max) invalid(`state.${key} 数值范围无效`)
      const steps = (initial - min) / step
      if (Math.abs(steps - Math.round(steps)) > 1e-9) invalid(`state.${key}.initial 不在有效步进点`)
      result[key] = { type: 'number', initial, min, max, step }
    } else if (declaration.type === 'enum') {
      fields(declaration, ['type', 'initial', 'options'], ['type', 'initial', 'options'], `state.${key}`)
      if (!Array.isArray(declaration.options) || declaration.options.length < 1 || declaration.options.length > 12) invalid('enum 必须包含 1–12 个选项')
      const values = new Set<string>()
      const options = declaration.options.map((entry, index) => {
        const option = record(entry, `state.${key}.options[${index}]`)
        fields(option, ['value', 'label'], ['value', 'label'], `state.${key}.options[${index}]`)
        const optionValue = text(option.value, 'enum.value', 100, true)
        if (values.has(optionValue)) invalid('enum 选项 value 必须唯一')
        values.add(optionValue)
        return { value: optionValue, label: text(option.label, 'enum.label', 500, true) }
      })
      const initial = text(declaration.initial, `state.${key}.initial`, 100, true)
      if (!values.has(initial)) invalid('enum.initial 必须属于选项集合')
      result[key] = { type: 'enum', initial, options }
    } else invalid('状态 type 不受支持')
  }
  return result
}

function expression(value: unknown, ctx: ValidationContext, depth: number, counter: { count: number }): { value: Expression; kind: 'boolean' | 'number' | 'string' } {
  counter.count += 1
  ctx.expressionNodes += 1
  if (counter.count > 32 || ctx.expressionNodes > 256) invalid('表达式节点超过限制')
  if (depth > 6) invalid('表达式嵌套过深')
  if (typeof value === 'string') return { value: text(value, '表达式字符串', 500), kind: 'string' }
  if (typeof value === 'number') return { value: finiteNumber(value, '表达式数值'), kind: 'number' }
  if (typeof value === 'boolean') return { value, kind: 'boolean' }
  const object = record(value, '表达式')
  if (object.op === 'ref') {
    fields(object, ['op', 'key'], ['op', 'key'], 'ref')
    const key = text(object.key, 'ref.key', 40, true)
    if (!Object.hasOwn(ctx.state, key)) invalid('ref 引用了未声明状态')
    const declaration = ctx.state[key]!
    return { value: { op: 'ref', key }, kind: declaration.type === 'boolean' ? 'boolean' : declaration.type === 'number' ? 'number' : 'string' }
  }
  if (object.op === 'countTrue' || object.op === 'concat') {
    fields(object, ['op', 'args'], ['op', 'args'], object.op)
    if (!Array.isArray(object.args) || object.args.length < 1 || object.args.length > 20) invalid(`${object.op}.args 必须包含 1–20 项`)
    const args = object.args.map((arg) => expression(arg, ctx, depth + 1, counter))
    if (object.op === 'countTrue') {
      if (args.some((arg) => arg.kind !== 'boolean')) invalid('countTrue 仅接受布尔参数')
      return { value: { op: 'countTrue', args: args.map((arg) => arg.value) }, kind: 'number' }
    }
    return { value: { op: 'concat', args: args.map((arg) => arg.value) }, kind: 'string' }
  }
  if (object.op === 'add' || object.op === 'sub' || object.op === 'mul' || object.op === 'div') {
    fields(object, ['op', 'args'], ['op', 'args'], object.op)
    if (!Array.isArray(object.args) || object.args.length !== 2) invalid(`${object.op} 必须包含两个参数`)
    const args = object.args.map((arg) => expression(arg, ctx, depth + 1, counter))
    if (args.some((arg) => arg.kind !== 'number')) invalid(`${object.op} 仅接受数值参数`)
    return { value: { op: object.op, args: args.map((arg) => arg.value) as [Expression, Expression] }, kind: 'number' }
  }
  if (object.op === 'round') {
    fields(object, ['op', 'args'], ['op', 'args'], 'round')
    if (!Array.isArray(object.args) || object.args.length !== 2) invalid('round 必须包含两个参数')
    const value = expression(object.args[0], ctx, depth + 1, counter)
    if (value.kind !== 'number') invalid('round 第一项必须是数值')
    const digits = object.args[1]
    if (!Number.isSafeInteger(digits) || (digits as number) < 0 || (digits as number) > 6) invalid('round 小数位必须为 0–6 的整数')
    return { value: { op: 'round', args: [value.value, digits as number] }, kind: 'number' }
  }
  return invalid('表达式 op 不受支持')
}

function validateExpression(value: unknown, ctx: ValidationContext, expected?: 'boolean' | 'number' | 'string'): Expression {
  const result = expression(value, ctx, 0, { count: 0 })
  if (expected && result.kind !== expected) invalid(`表达式必须返回 ${expected}`)
  return result.value
}

function metricValue(value: unknown, ctx: ValidationContext): number | string | Expression {
  if (typeof value === 'string') {
    const exact = text(value, 'metric.value', 64, true)
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(exact)) invalid('metric.value 数值字符串格式无效')
    return exact
  }
  if (typeof value === 'number') return finiteNumber(value, 'metric.value')
  const result = expression(value, ctx, 0, { count: 0 })
  if (result.kind === 'boolean') invalid('metric.value 不能返回布尔值')
  return result.value
}

function coordinate(value: unknown, path: string): number {
  const result = finiteNumber(value, path)
  if (Math.abs(result) > 10000) invalid('SVG 坐标超过限制')
  return result
}

function shape(value: unknown): SvgShape {
  const item = record(value, 'svg.shapes')
  const tone = item.tone === undefined ? undefined : choice(item.tone, TONES, 'shape.tone')
  if (item.type === 'line') {
    fields(item, ['type', 'x1', 'y1', 'x2', 'y2', 'tone', 'arrowEnd'], ['type', 'x1', 'y1', 'x2', 'y2'], 'line')
    if (item.arrowEnd !== undefined) booleanValue(item.arrowEnd, 'line.arrowEnd')
    return { ...item, x1: coordinate(item.x1, 'x1'), y1: coordinate(item.y1, 'y1'), x2: coordinate(item.x2, 'x2'), y2: coordinate(item.y2, 'y2'), tone } as SvgShape
  }
  if (item.type === 'polyline') {
    fields(item, ['type', 'points', 'tone', 'arrowEnd'], ['type', 'points'], 'polyline')
    if (!Array.isArray(item.points) || item.points.length < 2 || item.points.length > 32) invalid('polyline 必须包含 2–32 个点')
    const points = item.points.map((point) => {
      if (!Array.isArray(point) || point.length !== 2) invalid('polyline 点必须是坐标对')
      return [coordinate(point[0], 'point.x'), coordinate(point[1], 'point.y')] as [number, number]
    })
    if (item.arrowEnd !== undefined) booleanValue(item.arrowEnd, 'polyline.arrowEnd')
    return { ...item, points, tone } as SvgShape
  }
  if (item.type === 'rect') {
    fields(item, ['type', 'x', 'y', 'width', 'height', 'rx', 'tone', 'filled'], ['type', 'x', 'y', 'width', 'height'], 'rect')
    const width = coordinate(item.width, 'rect.width')
    const height = coordinate(item.height, 'rect.height')
    if (width <= 0 || height <= 0) invalid('rect 尺寸必须大于 0')
    if (item.rx !== undefined && coordinate(item.rx, 'rect.rx') < 0) invalid('rect.rx 不能为负')
    if (item.filled !== undefined) booleanValue(item.filled, 'rect.filled')
    return { ...item, width, height, tone } as SvgShape
  }
  if (item.type === 'circle') {
    fields(item, ['type', 'cx', 'cy', 'r', 'tone', 'filled'], ['type', 'cx', 'cy', 'r'], 'circle')
    const radius = coordinate(item.r, 'circle.r')
    if (radius <= 0) invalid('circle.r 必须大于 0')
    if (item.filled !== undefined) booleanValue(item.filled, 'circle.filled')
    return { ...item, r: radius, tone } as SvgShape
  }
  if (item.type === 'text') {
    fields(item, ['type', 'x', 'y', 'text', 'tone', 'anchor'], ['type', 'x', 'y', 'text'], 'svg.text')
    if (item.anchor !== undefined) choice(item.anchor, ['start', 'middle', 'end'] as const, 'text.anchor')
    return { ...item, x: coordinate(item.x, 'text.x'), y: coordinate(item.y, 'text.y'), text: text(item.text, 'text.text', 500), tone } as SvgShape
  }
  return invalid('SVG 图元不受支持')
}

function validateNode(value: unknown, ctx: ValidationContext, depth: number, parent?: UiNode['type']): UiNode {
  ctx.nodes += 1
  if (ctx.nodes > 80 || depth > 8) invalid('UI 树节点或深度超过限制')
  const node = record(value, 'UI 节点')
  switch (node.type) {
    case 'box': {
      fields(node, ['type', 'children', 'variant', 'padding', 'gap', 'align'], ['type', 'children'], 'box')
      if (node.variant !== undefined) choice(node.variant, ['plain', 'card', 'subtle'] as const, 'box.variant')
      if (node.padding !== undefined) choice(node.padding, TOKENS, 'box.padding')
      if (node.gap !== undefined) choice(node.gap, TOKENS, 'box.gap')
      if (node.align !== undefined) choice(node.align, ALIGNS, 'box.align')
      return { ...node, children: childrenOf(node, ctx, depth, 'box') } as BoxNode
    }
    case 'row': {
      fields(node, ['type', 'children', 'gap', 'align', 'justify', 'wrap'], ['type', 'children'], 'row')
      if (node.gap !== undefined) choice(node.gap, TOKENS, 'row.gap')
      if (node.align !== undefined) choice(node.align, ALIGNS, 'row.align')
      if (node.justify !== undefined) choice(node.justify, ['start', 'center', 'end', 'between'] as const, 'row.justify')
      if (node.wrap !== undefined) booleanValue(node.wrap, 'row.wrap')
      return { ...node, children: childrenOf(node, ctx, depth, 'row') } as RowNode
    }
    case 'column': {
      fields(node, ['type', 'children', 'gap', 'align'], ['type', 'children'], 'column')
      if (node.gap !== undefined) choice(node.gap, TOKENS, 'column.gap')
      if (node.align !== undefined) choice(node.align, ALIGNS, 'column.align')
      return { ...node, children: childrenOf(node, ctx, depth, 'column') } as ColumnNode
    }
    case 'grid': {
      fields(node, ['type', 'children', 'columns', 'gap'], ['type', 'children', 'columns'], 'grid')
      if (!Number.isSafeInteger(node.columns) || (node.columns as number) < 1 || (node.columns as number) > 4) invalid('grid.columns 必须为 1–4 的整数')
      if (node.gap !== undefined) choice(node.gap, TOKENS, 'grid.gap')
      return { ...node, children: childrenOf(node, ctx, depth, 'grid') } as GridNode
    }
    case 'divider':
    case 'spacer': {
      fields(node, ['type'], ['type'], node.type)
      if (node.type === 'spacer' && parent !== 'row' && parent !== 'column') invalid('spacer 仅允许直接位于 row/column')
      return { type: node.type }
    }
    case 'text': {
      fields(node, ['type', 'text', 'tone', 'size', 'weight'], ['type', 'text'], 'text')
      if (node.tone !== undefined) choice(node.tone, TONES, 'text.tone')
      if (node.size !== undefined) choice(node.size, ['xs', 'sm', 'md'] as const, 'text.size')
      if (node.weight !== undefined) choice(node.weight, ['normal', 'medium', 'semibold'] as const, 'text.weight')
      return { ...node, text: typeof node.text === 'string' ? text(node.text, 'text.text', 500) : validateExpression(node.text, ctx, 'string') } as TextNode
    }
    case 'title': {
      fields(node, ['type', 'text', 'tone', 'size'], ['type', 'text'], 'title')
      if (node.tone !== undefined) choice(node.tone, TONES, 'title.tone')
      if (node.size !== undefined) choice(node.size, ['sm', 'md', 'lg'] as const, 'title.size')
      return { ...node, text: typeof node.text === 'string' ? text(node.text, 'title.text', 500) : validateExpression(node.text, ctx, 'string') } as TitleNode
    }
    case 'icon': {
      fields(node, ['type', 'name', 'size', 'tone'], ['type', 'name'], 'icon')
      if (node.size !== undefined) choice(node.size, ['sm', 'md', 'lg'] as const, 'icon.size')
      if (node.tone !== undefined) choice(node.tone, TONES, 'icon.tone')
      return { ...node, name: choice(node.name, ICON_NAMES, 'icon.name') } as IconNode
    }
    case 'metric': {
      fields(node, ['type', 'label', 'value', 'unit', 'note'], ['type', 'label', 'value'], 'metric')
      optionalText(node, 'unit', 30)
      optionalText(node, 'note', 300)
      return { ...node, label: text(node.label, 'metric.label', 100, true), value: metricValue(node.value, ctx) } as MetricNode
    }
    case 'progress': {
      fields(node, ['type', 'label', 'value', 'target', 'unit'], ['type', 'label', 'value', 'target'], 'progress')
      const target = finiteNumber(node.target, 'progress.target')
      if (target <= 0) invalid('progress.target 必须大于 0')
      optionalText(node, 'unit', 30)
      let progressValue: number | Expression
      if (typeof node.value === 'number') {
        progressValue = finiteNumber(node.value, 'progress.value')
        if (progressValue < 0 || !Number.isFinite(progressValue / target)) invalid('progress.value 无效')
      } else progressValue = validateExpression(node.value, ctx, 'number')
      return { ...node, label: text(node.label, 'progress.label', 100, true), value: progressValue, target } as ProgressNode
    }
    case 'chart': {
      const chart = validateChart({ ...node, version: 1 })
      ctx.chartPoints += chart.data.length
      if (ctx.chartPoints > 360) invalid('单围栏图表数据点超过 360')
      const { version: _version, ...config } = chart
      return config as ChartNode
    }
    case 'svg': {
      fields(node, ['type', 'viewBox', 'shapes', 'height', 'label'], ['type', 'viewBox', 'shapes'], 'svg')
      if (!Array.isArray(node.viewBox) || node.viewBox.length !== 4) invalid('svg.viewBox 必须包含四个数值')
      const viewBox = node.viewBox.map((entry, index) => coordinate(entry, `viewBox[${index}]`)) as [number, number, number, number]
      if (viewBox[2] <= 0 || viewBox[3] <= 0) invalid('viewBox 宽高必须大于 0')
      if (!Array.isArray(node.shapes)) invalid('svg.shapes 必须是数组')
      ctx.shapes += node.shapes.length
      if (ctx.shapes > 120) invalid('单围栏 SVG 图元超过 120')
      if (node.height !== undefined) choice(node.height, ['sm', 'md', 'lg'] as const, 'svg.height')
      optionalText(node, 'label', 500)
      return { ...node, viewBox, shapes: node.shapes.map(shape) } as SvgNode
    }
    case 'checkbox': {
      fields(node, ['type', 'label', 'bind', 'description'], ['type', 'label', 'bind'], 'checkbox')
      const bind = text(node.bind, 'checkbox.bind', 40, true)
      if (!Object.hasOwn(ctx.state, bind)) invalid('checkbox 绑定未声明状态')
      optionalText(node, 'description', 500)
      return { ...node, label: text(node.label, 'checkbox.label', 500, true), bind } as CheckboxNode
    }
    case 'select': {
      fields(node, ['type', 'label', 'bind'], ['type', 'label', 'bind'], 'select')
      const bind = text(node.bind, 'select.bind', 40, true)
      if (ctx.state[bind]?.type !== 'enum') invalid('select 必须绑定 enum 状态')
      return { ...node, label: text(node.label, 'select.label', 500, true), bind } as SelectNode
    }
    case 'slider': {
      fields(node, ['type', 'label', 'bind', 'unit'], ['type', 'label', 'bind'], 'slider')
      const bind = text(node.bind, 'slider.bind', 40, true)
      if (ctx.state[bind]?.type !== 'number') invalid('slider 必须绑定 number 状态')
      optionalText(node, 'unit', 30)
      return { ...node, label: text(node.label, 'slider.label', 500, true), bind } as SliderNode
    }
    case 'button': {
      fields(node, ['type', 'label', 'action'], ['type', 'label', 'action'], 'button')
      if (node.action !== 'reset') invalid('button.action 仅支持 reset')
      return { ...node, label: text(node.label, 'button.label', 500, true), action: 'reset' } as ButtonNode
    }
    default: return invalid('UI 节点 type 不受支持')
  }
}

export function validateUiRoot(root: Record<string, unknown>): UiSpec {
  fields(root, ['version', 'type', 'state', 'root'], ['version', 'type', 'root'], 'ui')
  if (root.version !== 2 || root.type !== 'ui') invalid('V2 根节点必须为 version:2,type:ui')
  const state = validateState(root.state)
  const ctx: ValidationContext = { state, nodes: 0, shapes: 0, chartPoints: 0, expressionNodes: 0 }
  const uiRoot = validateNode(root.root, ctx, 0)
  return { version: 2, type: 'ui', ...(Object.keys(state).length ? { state } : {}), root: uiRoot }
}

export function parseAnyVisualize(code: string): ParseAnyVisualizeResult {
  try {
    const root = parseJsonDocument(code)
    return { ok: true, config: root.version === 2 ? validateUiRoot(root) : validateVisualizeRoot(root) }
  } catch (error) {
    if (error instanceof InvalidJson) return { ok: false, reason: error.message }
    return { ok: false, reason: '无法解析可视化配置' }
  }
}
