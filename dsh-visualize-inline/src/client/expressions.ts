import type { Expression, Scalar, UiState } from '../protocol-v2.ts'

export type RuntimeState = Record<string, Scalar>

export function initialRuntimeState(state?: UiState): RuntimeState {
  const result: RuntimeState = Object.create(null) as RuntimeState
  for (const [key, declaration] of Object.entries(state ?? {})) result[key] = declaration.initial
  return result
}

function finiteResult(value: number): number {
  if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new Error('invalid numeric result')
  return value
}

function numeric(value: Scalar): number {
  if (typeof value !== 'number') throw new Error('numeric operand required')
  return finiteResult(value)
}

export function evaluateExpression(expression: Expression, state: RuntimeState): Scalar {
  if (typeof expression === 'string' || typeof expression === 'number' || typeof expression === 'boolean') return expression
  if (expression.op === 'ref') {
    if (!Object.hasOwn(state, expression.key)) throw new Error('invalid ref')
    const value = state[expression.key]
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw new Error('invalid ref')
    return value
  }
  if (expression.op === 'countTrue') {
    const values = expression.args.map((arg) => evaluateExpression(arg, state))
    if (values.some((value) => typeof value !== 'boolean')) throw new Error('countTrue type')
    return values.filter((value) => value === true).length
  }
  if (expression.op === 'concat') {
    const output = expression.args.map((arg) => {
      const value = evaluateExpression(arg, state)
      return typeof value === 'string' ? value : String(value)
    }).join('')
    if (output.length > 500) throw new Error('concat output too long')
    return output
  }
  if (expression.op === 'add' || expression.op === 'sub' || expression.op === 'mul' || expression.op === 'div') {
    const left = numeric(evaluateExpression(expression.args[0], state))
    const right = numeric(evaluateExpression(expression.args[1], state))
    if (expression.op === 'add') return finiteResult(left + right)
    if (expression.op === 'sub') return finiteResult(left - right)
    if (expression.op === 'mul') return finiteResult(left * right)
    if (right === 0) throw new Error('division by zero')
    return finiteResult(left / right)
  }
  if (expression.op === 'round') {
    const value = numeric(evaluateExpression(expression.args[0], state))
    return finiteResult(Number(value.toFixed(expression.args[1])))
  }
  throw new Error('unsupported expression')
}

export function evaluateText(expression: string | Expression, state: RuntimeState): string {
  const value = evaluateExpression(expression, state)
  if (typeof value !== 'string') throw new Error('text type')
  return value
}

export function evaluateMetric(expression: number | string | Expression, state: RuntimeState): number | string {
  const value = evaluateExpression(expression, state)
  if (typeof value === 'number') return finiteResult(value)
  if (typeof value !== 'string' || value.length > 64 || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) throw new Error('metric string')
  return value
}

export function evaluateProgress(expression: number | Expression, state: RuntimeState, target: number): number {
  const value = evaluateExpression(expression, state)
  if (typeof value !== 'number' || value < 0 || !Number.isFinite(value / target)) throw new Error('progress number')
  return finiteResult(value)
}
