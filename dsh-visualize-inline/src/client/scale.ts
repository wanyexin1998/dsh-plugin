export interface ChartScale {
  min: number
  max: number
  ticks: number[]
  map(value: number, start: number, end: number): number
}

function niceStep(value: number): number {
  const power = 10 ** Math.floor(Math.log10(value))
  const fraction = value / power
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10
  return nice * power
}

export function createScale(values: number[], includeZero: boolean): ChartScale {
  let min = values.length ? Math.min(...values) : 0
  let max = values.length ? Math.max(...values) : 1
  if (includeZero) {
    min = Math.min(0, min)
    max = Math.max(0, max)
  }
  if (min === max) {
    if (includeZero && min === 0) max = 1
    else {
      const padding = Math.abs(min) * 0.1 || 1
      min -= padding
      max += padding
    }
  }
  const step = niceStep((max - min) / 4)
  min = Math.floor(min / step) * step
  max = Math.ceil(max / step) * step
  const ticks: number[] = []
  const count = Math.round((max - min) / step)
  for (let index = 0; index <= count; index += 1) ticks.push(min + step * index)
  return {
    min,
    max,
    ticks,
    map(value, start, end) {
      return start + ((value - min) / (max - min)) * (end - start)
    },
  }
}

export function formatValue(value: number | string | null, unit?: string): string {
  const suffix = unit ? ` ${unit}` : ''
  return value === null ? '无数据' : `${String(value)}${suffix}`
}

export function formatTick(value: number): string {
  if (value === 0) return '0'
  if (Math.abs(value) < 0.01 || Math.abs(value) >= 1e9) return String(Number(value.toPrecision(3)))
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value)
}

export function shortLabel(value: string, maximum = 12): string {
  const characters = Array.from(value)
  return characters.length <= maximum ? value : `${characters.slice(0, maximum - 1).join('')}…`
}
