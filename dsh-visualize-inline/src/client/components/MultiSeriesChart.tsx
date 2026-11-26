import React from 'react'
import type { MultiSeriesChartConfig } from '../../protocol.ts'
import { createScale, formatTick, formatValue, shortLabel, type ChartScale } from '../scale.ts'
import { ChartHeader, seriesColor, SeriesLegend } from './ChartShared.tsx'

function YAxis({ scale, left, right, top, bottom }: { scale: ChartScale; left: number; right: number; top: number; bottom: number }): React.ReactElement {
  return <g aria-hidden="true">{scale.ticks.map((tick) => {
    const y = scale.map(tick, bottom, top)
    return <g key={tick}><line className={tick === 0 ? 'dsh-vi-zero' : 'dsh-vi-grid'} x1={left} x2={right} y1={y} y2={y} /><text className="dsh-vi-axis-label" x={left - 10} y={y} textAnchor="end" dominantBaseline="middle">{formatTick(tick)}</text></g>
  })}</g>
}

export function MultiSeriesChart({ config }: { config: MultiSeriesChartConfig }): React.ReactElement {
  const [active, setActive] = React.useState<{ point: number; series: number } | null>(null)
  const [showTable, setShowTable] = React.useState(false)
  const tableId = React.useId()
  const width = Math.max(640, config.data.length * config.series.length * 36)
  const height = 300
  const margin = { top: 18, right: 20, bottom: 52, left: 64 }
  const right = width - margin.right
  const bottom = height - margin.bottom
  const band = (right - margin.left) / config.data.length
  const values = config.data.flatMap((point) => point.values.filter((value): value is number => value !== null))
  const scale = createScale(values, config.chart === 'bar')
  const zeroY = scale.map(0, bottom, margin.top)
  const labelEvery = Math.ceil(config.data.length / 10)
  const activePoint = active ? config.data[active.point] : undefined
  const activeValue = active ? activePoint?.values[active.series] : undefined
  const description = (point: number, series: number) => `${config.data[point]!.label} · ${config.series[series]}：${formatValue(config.data[point]!.values[series] ?? null, config.unit)}`
  const interaction = (point: number, series: number, children: React.ReactNode) => (
    <g className="dsh-vi-hit" key={`${point}-${series}`} tabIndex={0} role="img" aria-label={description(point, series)}
      onMouseEnter={() => setActive({ point, series })} onFocus={() => setActive({ point, series })} onBlur={() => setActive(null)} onClick={() => setActive({ point, series })}>
      {children}<title>{description(point, series)}</title>
    </g>
  )
  return (
    <figure className="dsh-vi-chart dsh-vi-multi-series">
      <ChartHeader title={config.title} unit={config.unit} />
      <SeriesLegend series={config.series} />
      <figcaption className="dsh-vi-sr-only">多系列{config.chart === 'bar' ? '柱状图' : '折线图'}，共 {config.series.length} 个系列。数据表按系列列出原始值。</figcaption>
      <div className="dsh-vi-chart-scroll">
        <svg className="dsh-vi-chart-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={config.title ?? '多系列图表'} onMouseLeave={() => setActive(null)}>
          <YAxis scale={scale} left={margin.left} right={right} top={margin.top} bottom={bottom} />
          {config.chart === 'line' && config.series.map((series, seriesIndex) => {
            const segments: string[] = []
            let current: string[] = []
            config.data.forEach((point, pointIndex) => {
              const value = point.values[seriesIndex]
              if (value === null || value === undefined) {
                if (current.length) segments.push(current.join(' '))
                current = []
                return
              }
              const x = margin.left + band * (pointIndex + 0.5)
              const y = scale.map(value, bottom, margin.top)
              current.push(`${current.length ? 'L' : 'M'} ${x} ${y}`)
            })
            if (current.length) segments.push(current.join(' '))
            return segments.map((path) => <path className="dsh-vi-line" key={`${series}-${path}`} d={path} style={{ stroke: seriesColor(seriesIndex), strokeDasharray: ['none', '6 4', '2 3', '8 3 2 3'][seriesIndex] }} />)
          })}
          {config.data.map((point, pointIndex) => {
            const center = margin.left + band * (pointIndex + 0.5)
            return <React.Fragment key={point.label}>
              {config.chart === 'bar' && point.values.map((value, seriesIndex) => {
                if (value === null) return null
                const groupWidth = band * 0.72
                const barWidth = Math.min(28, groupWidth / config.series.length)
                const x = center - groupWidth / 2 + seriesIndex * (groupWidth / config.series.length)
                const y = scale.map(value, bottom, margin.top)
                return interaction(pointIndex, seriesIndex, <rect x={x} y={Math.min(y, zeroY)} width={barWidth} height={Math.abs(zeroY - y)} rx={2} style={{ fill: seriesColor(seriesIndex) }} />)
              })}
              {config.chart === 'line' && point.values.map((value, seriesIndex) => {
                if (value === null) return null
                const y = scale.map(value, bottom, margin.top)
                return interaction(pointIndex, seriesIndex, <>
                  <circle cx={center} cy={y} r={14} fill="transparent" />
                  <circle className="dsh-vi-multi-point" cx={center} cy={y} r={4} style={{ stroke: seriesColor(seriesIndex) }} />
                </>)
              })}
              {(pointIndex % labelEvery === 0 || config.data.length <= 10) && <text className="dsh-vi-axis-label" x={center} y={bottom + 23} textAnchor="middle">{shortLabel(point.label)}<title>{point.label}</title></text>}
            </React.Fragment>
          })}
        </svg>
      </div>
      <div className="dsh-vi-data-tip" data-active={active !== null} aria-live="polite">
        {active && activePoint ? `${activePoint.label} · ${config.series[active.series]}：${formatValue(activeValue ?? null, config.unit)}` : '悬停、点击或用 Tab 聚焦数据点查看数值'}
      </div>
      <button className="dsh-vi-table-toggle" type="button" aria-expanded={showTable} aria-controls={tableId} onClick={() => setShowTable((value) => !value)}>{showTable ? '收起数据' : '查看数据'}</button>
      {showTable && <div className="dsh-vi-table-wrap" id={tableId}><table className="dsh-vi-table"><caption className="dsh-vi-sr-only">{config.title ?? '图表'}多系列原始数据</caption>
        <thead><tr><th scope="col">类别</th>{config.series.map((series) => <th scope="col" key={series}>{series}{config.unit ? `（${config.unit}）` : ''}</th>)}</tr></thead>
        <tbody>{config.data.map((point) => <tr key={point.label}><th scope="row">{point.label}</th>{point.values.map((value, index) => <td key={config.series[index]}>{formatValue(value)}</td>)}</tr>)}</tbody>
      </table></div>}
    </figure>
  )
}
