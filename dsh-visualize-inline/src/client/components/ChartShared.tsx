import React from 'react'
import type { ChartPoint } from '../../protocol.ts'
import { formatValue } from '../scale.ts'

export function seriesColor(index: number): string {
  return `var(--dsh-vi-series-${index % 6})`
}

export function ChartHeader({ title, unit }: { title?: string; unit?: string }): React.ReactElement | null {
  if (!title && !unit) return null
  return (
    <div className="dsh-vi-chart-header">
      {title && <h3 className="dsh-vi-chart-title">{title}</h3>}
      {unit && <span className="dsh-vi-unit">{unit}</span>}
    </div>
  )
}

export function SingleDataTable({ title, unit, data }: { title?: string; unit?: string; data: ChartPoint[] }): React.ReactElement {
  return (
    <div className="dsh-vi-table-wrap">
      <table className="dsh-vi-table">
        <caption className="dsh-vi-sr-only">{title ?? '图表'}原始数据</caption>
        <thead><tr><th scope="col">类别</th><th scope="col">数值{unit ? `（${unit}）` : ''}</th></tr></thead>
        <tbody>{data.map((point) => <tr key={point.label}><th scope="row">{point.label}</th><td>{formatValue(point.value)}</td></tr>)}</tbody>
      </table>
    </div>
  )
}

export function SeriesLegend({ series }: { series: string[] }): React.ReactElement {
  return (
    <div className="dsh-vi-series-legend" aria-label="图例">
      {series.map((label, index) => <span key={label}><i style={{ background: seriesColor(index) }} />{label}</span>)}
    </div>
  )
}
