import React from 'react'
import type { StandardChartConfig } from '../../protocol.ts'
import { createScale, formatTick, formatValue, shortLabel, type ChartScale } from '../scale.ts'

type Point = StandardChartConfig['data'][number]

interface InteractionProps {
  index: number
  point: Point
  unit?: string
  setActive: (index: number | null) => void
  children: React.ReactNode
}

function Interaction({ index, point, unit, setActive, children }: InteractionProps): React.ReactElement {
  const description = `${point.label}：${formatValue(point.value, unit)}`
  return (
    <g
      className="dsh-vi-hit"
      tabIndex={0}
      role="img"
      aria-label={description}
      onMouseEnter={() => setActive(index)}
      onFocus={() => setActive(index)}
      onBlur={() => setActive(null)}
      onClick={() => setActive(index)}
      onKeyDown={(event) => { if (event.key === 'Escape') setActive(null) }}
    >
      {children}
      <title>{description}</title>
    </g>
  )
}

function YAxis({ scale, left, right, top, bottom }: {
  scale: ChartScale
  left: number
  right: number
  top: number
  bottom: number
}): React.ReactElement {
  return (
    <g aria-hidden="true">
      {scale.ticks.map((tick) => {
        const y = scale.map(tick, bottom, top)
        return (
          <g key={tick}>
            <line className={tick === 0 ? 'dsh-vi-zero' : 'dsh-vi-grid'} x1={left} x2={right} y1={y} y2={y} />
            <text className="dsh-vi-axis-label" x={left - 10} y={y} textAnchor="end" dominantBaseline="middle">{formatTick(tick)}</text>
          </g>
        )
      })}
    </g>
  )
}

function XAxis({ scale, left, right, bottom }: {
  scale: ChartScale
  left: number
  right: number
  bottom: number
}): React.ReactElement {
  return (
    <g aria-hidden="true">
      {scale.ticks.map((tick) => {
        const x = scale.map(tick, left, right)
        return (
          <g key={tick}>
            <line className={tick === 0 ? 'dsh-vi-zero' : 'dsh-vi-grid'} x1={x} x2={x} y1={16} y2={bottom} />
            <text className="dsh-vi-axis-label" x={x} y={bottom + 22} textAnchor="middle">{formatTick(tick)}</text>
          </g>
        )
      })}
    </g>
  )
}

interface PlotProps {
  config: StandardChartConfig
  setActive: (index: number | null) => void
  label: string
}

function BarPlot({ config, setActive, label }: PlotProps): React.ReactElement {
  const width = Math.max(640, config.data.length * 64)
  const height = 280
  const margin = { top: 16, right: 20, bottom: 52, left: 64 }
  const right = width - margin.right
  const bottom = height - margin.bottom
  const values = config.data.flatMap((point) => point.value === null ? [] : [point.value])
  const scale = createScale(values, true)
  const zeroY = scale.map(0, bottom, margin.top)
  const band = (right - margin.left) / config.data.length
  const labelEvery = Math.ceil(config.data.length / 10)
  return (
    <svg className="dsh-vi-chart-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={label} onMouseLeave={() => setActive(null)}>
      <YAxis scale={scale} left={margin.left} right={right} top={margin.top} bottom={bottom} />
      {config.data.map((point, index) => {
        const center = margin.left + band * (index + 0.5)
        const barWidth = Math.min(48, band * 0.64)
        const valueY = point.value === null ? zeroY : scale.map(point.value, bottom, margin.top)
        const descriptionY = Math.max(margin.top + 10, Math.min(bottom - 8, zeroY - 6))
        return (
          <React.Fragment key={point.label}>
            <Interaction index={index} point={point} unit={config.unit} setActive={setActive}>
              <rect x={margin.left + band * index} y={margin.top} width={band} height={bottom - margin.top} fill="transparent" />
              {point.value !== null && (
                <rect className="dsh-vi-bar" x={center - barWidth / 2} y={Math.min(valueY, zeroY)} width={barWidth} height={Math.abs(zeroY - valueY)} rx={2} />
              )}
            </Interaction>
            {point.value === null && <text className="dsh-vi-missing" x={center} y={descriptionY} textAnchor="middle">无数据</text>}
            {(index % labelEvery === 0 || config.data.length <= 10) && (
              <text className="dsh-vi-axis-label" x={center} y={bottom + 23} textAnchor="middle">
                {shortLabel(point.label)}<title>{point.label}</title>
              </text>
            )}
          </React.Fragment>
        )
      })}
    </svg>
  )
}

function LinePlot({ config, setActive, label }: PlotProps): React.ReactElement {
  const width = Math.max(640, config.data.length * 64)
  const height = 280
  const margin = { top: 16, right: 20, bottom: 52, left: 64 }
  const right = width - margin.right
  const bottom = height - margin.bottom
  const values = config.data.flatMap((point) => point.value === null ? [] : [point.value])
  const scale = createScale(values, false)
  const band = (right - margin.left) / config.data.length
  const labelEvery = Math.ceil(config.data.length / 10)
  const segments: string[] = []
  let current: string[] = []
  config.data.forEach((point, index) => {
    if (point.value === null) {
      if (current.length) segments.push(current.join(' '))
      current = []
      return
    }
    const x = margin.left + band * (index + 0.5)
    const y = scale.map(point.value, bottom, margin.top)
    current.push(`${current.length ? 'L' : 'M'} ${x} ${y}`)
  })
  if (current.length) segments.push(current.join(' '))
  return (
    <svg className="dsh-vi-chart-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={label} onMouseLeave={() => setActive(null)}>
      <YAxis scale={scale} left={margin.left} right={right} top={margin.top} bottom={bottom} />
      {segments.map((path) => <path className="dsh-vi-line" d={path} key={path} />)}
      {config.data.map((point, index) => {
        const x = margin.left + band * (index + 0.5)
        const y = point.value === null ? bottom : scale.map(point.value, bottom, margin.top)
        return (
          <React.Fragment key={point.label}>
            <Interaction index={index} point={point} unit={config.unit} setActive={setActive}>
              <circle cx={x} cy={y} r={16} fill="transparent" />
              {point.value !== null && <circle className="dsh-vi-point" cx={x} cy={y} r={4} />}
            </Interaction>
            {point.value === null && <text className="dsh-vi-missing" x={x} y={bottom - 7} textAnchor="middle">无数据</text>}
            {(index % labelEvery === 0 || config.data.length <= 10) && (
              <text className="dsh-vi-axis-label" x={x} y={bottom + 23} textAnchor="middle">
                {shortLabel(point.label)}<title>{point.label}</title>
              </text>
            )}
          </React.Fragment>
        )
      })}
    </svg>
  )
}

function HorizontalBarPlot({ config, setActive, label }: PlotProps): React.ReactElement {
  const width = 640
  const margin = { top: 16, right: 24, bottom: 44, left: 128 }
  const rowHeight = 38
  const bottom = Math.max(176, margin.top + config.data.length * rowHeight)
  const height = bottom + margin.bottom
  const right = width - margin.right
  const values = config.data.flatMap((point) => point.value === null ? [] : [point.value])
  const scale = createScale(values, true)
  const zeroX = scale.map(0, margin.left, right)
  return (
    <svg className="dsh-vi-chart-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={label} onMouseLeave={() => setActive(null)}>
      <XAxis scale={scale} left={margin.left} right={right} bottom={bottom} />
      {config.data.map((point, index) => {
        const centerY = margin.top + rowHeight * (index + 0.5)
        const valueX = point.value === null ? zeroX : scale.map(point.value, margin.left, right)
        const missingAfter = zeroX < right - 60
        return (
          <React.Fragment key={point.label}>
            <text className="dsh-vi-axis-label" x={margin.left - 12} y={centerY} textAnchor="end" dominantBaseline="middle">
              {shortLabel(point.label, 14)}<title>{point.label}</title>
            </text>
            <Interaction index={index} point={point} unit={config.unit} setActive={setActive}>
              <rect x={margin.left} y={centerY - rowHeight / 2} width={right - margin.left} height={rowHeight} fill="transparent" />
              {point.value !== null && (
                <rect className="dsh-vi-bar" x={Math.min(zeroX, valueX)} y={centerY - 10} width={Math.abs(valueX - zeroX)} height={20} rx={2} />
              )}
            </Interaction>
            {point.value === null && (
              <text className="dsh-vi-missing" x={missingAfter ? zeroX + 8 : zeroX - 8} y={centerY} textAnchor={missingAfter ? 'start' : 'end'} dominantBaseline="middle">无数据</text>
            )}
          </React.Fragment>
        )
      })}
    </svg>
  )
}

function DataTable({ config, id }: { config: StandardChartConfig; id: string }): React.ReactElement {
  return (
    <div className="dsh-vi-table-wrap" id={id}>
      <table className="dsh-vi-table">
        <caption className="dsh-vi-sr-only">{config.title ?? '图表'}原始数据</caption>
        <thead><tr><th scope="col">类别</th><th scope="col">数值{config.unit ? `（${config.unit}）` : ''}</th></tr></thead>
        <tbody>
          {config.data.map((point) => (
            <tr key={point.label}><th scope="row">{point.label}</th><td>{formatValue(point.value)}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function Chart({ config }: { config: StandardChartConfig }): React.ReactElement {
  const [activeIndex, setActiveIndex] = React.useState<number | null>(null)
  const [showTable, setShowTable] = React.useState(false)
  const tableId = React.useId()
  const chartName = config.chart === 'bar' ? '柱状图' : config.chart === 'horizontal-bar' ? '条形图' : '折线图'
  const accessibleLabel = `${config.title ?? chartName}，共 ${config.data.length} 项${config.unit ? `，单位 ${config.unit}` : ''}`
  const activePoint = activeIndex === null ? undefined : config.data[activeIndex]
  const plotProps = { config, setActive: setActiveIndex, label: accessibleLabel }
  return (
    <figure className="dsh-vi-chart">
      {(config.title || config.unit) && (
        <div className="dsh-vi-chart-header">
          {config.title && <h3 className="dsh-vi-chart-title">{config.title}</h3>}
          {config.unit && <span className="dsh-vi-unit">{config.unit}</span>}
        </div>
      )}
      <figcaption className="dsh-vi-sr-only">{accessibleLabel}。可聚焦数据点读取数值，或打开原始数据表。</figcaption>
      <div className="dsh-vi-chart-scroll">
        {config.chart === 'bar' && <BarPlot {...plotProps} />}
        {config.chart === 'horizontal-bar' && <HorizontalBarPlot {...plotProps} />}
        {config.chart === 'line' && <LinePlot {...plotProps} />}
      </div>
      <div className="dsh-vi-data-tip" data-active={activePoint !== undefined} aria-live="polite">
        {activePoint ? `${activePoint.label}：${formatValue(activePoint.value, config.unit)}` : '悬停、点击或用 Tab 聚焦数据点查看数值'}
      </div>
      <button className="dsh-vi-table-toggle" type="button" aria-expanded={showTable} aria-controls={tableId} onClick={() => setShowTable((visible) => !visible)}>
        {showTable ? '收起数据' : '查看数据'}
      </button>
      {showTable && <DataTable config={config} id={tableId} />}
    </figure>
  )
}
