import React from 'react'
import type { DistributionChartConfig } from '../../protocol.ts'
import { formatTick, formatValue } from '../scale.ts'
import { ChartHeader, seriesColor, SingleDataTable } from './ChartShared.tsx'

function percent(value: number, total: number): string {
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format((value / total) * 100)}%`
}

function Donut({ config }: { config: DistributionChartConfig }): React.ReactElement {
  const [active, setActive] = React.useState<number | null>(null)
  const [showTable, setShowTable] = React.useState(false)
  const tableId = React.useId()
  const total = config.data.reduce((sum, point) => sum + (point.value ?? 0), 0)
  const radius = 64
  const circumference = 2 * Math.PI * radius
  let offset = 0
  const activePoint = active === null ? undefined : config.data[active]
  return (
    <figure className="dsh-vi-chart dsh-vi-distribution">
      <ChartHeader title={config.title} unit={config.unit} />
      <figcaption className="dsh-vi-sr-only">环图，已知合计 {total}{config.unit ? ` ${config.unit}` : ''}。图例列出各项数值和占比。</figcaption>
      <div className="dsh-vi-donut-layout">
        <svg className="dsh-vi-donut" width="230" height="200" viewBox="0 0 230 200" role="group" aria-label={`环图，已知合计 ${total}`} onMouseLeave={() => setActive(null)}>
          <circle className="dsh-vi-donut-track" cx="100" cy="100" r={radius} />
          {config.data.map((point, index) => {
            const fraction = point.value === null ? 0 : point.value / total
            const dashOffset = -offset * circumference
            offset += fraction
            const description = `${point.label}：${formatValue(point.value, config.unit)}${point.value === null ? '' : `，${percent(point.value, total)}`}`
            return point.value === null ? null : (
              <circle
                key={point.label}
                className="dsh-vi-donut-segment"
                cx="100" cy="100" r={radius}
                stroke={seriesColor(index)}
                strokeDasharray={`${fraction * circumference} ${circumference}`}
                strokeDashoffset={dashOffset}
                tabIndex={0} role="img" aria-label={description}
                onMouseEnter={() => setActive(index)} onFocus={() => setActive(index)} onBlur={() => setActive(null)} onClick={() => setActive(index)}
              ><title>{description}</title></circle>
            )
          })}
          <text className="dsh-vi-donut-total" x="100" y="98" textAnchor="middle">{formatTick(total)}</text>
          <text className="dsh-vi-donut-total-label" x="100" y="119" textAnchor="middle">已知合计{config.unit ? `（${config.unit}）` : ''}</text>
        </svg>
        <div className="dsh-vi-donut-legend">
          {config.data.map((point, index) => (
            <div key={point.label} tabIndex={0} onMouseEnter={() => setActive(index)} onFocus={() => setActive(index)} onBlur={() => setActive(null)}>
              <i style={{ background: seriesColor(index) }} />
              <span>{point.label}</span>
              <strong>{formatValue(point.value, config.unit)}</strong>
              <small>{point.value === null ? '未计入合计' : percent(point.value, total)}</small>
            </div>
          ))}
        </div>
      </div>
      <div className="dsh-vi-data-tip" data-active={activePoint !== undefined} aria-live="polite">
        {activePoint ? `${activePoint.label}：${formatValue(activePoint.value, config.unit)}${activePoint.value === null ? '，未计入合计' : `，${percent(activePoint.value, total)}`}` : '聚焦扇区或图例查看数值与占比'}
      </div>
      <button className="dsh-vi-table-toggle" type="button" aria-expanded={showTable} aria-controls={tableId} onClick={() => setShowTable((value) => !value)}>{showTable ? '收起数据' : '查看数据'}</button>
      {showTable && <div id={tableId}><SingleDataTable title={config.title} unit={config.unit} data={config.data} /></div>}
    </figure>
  )
}

function Funnel({ config }: { config: DistributionChartConfig }): React.ReactElement {
  const [showTable, setShowTable] = React.useState(false)
  const tableId = React.useId()
  const maximum = Math.max(...config.data.map((point) => point.value ?? 0))
  return (
    <figure className="dsh-vi-chart dsh-vi-distribution">
      <ChartHeader title={config.title} unit={config.unit} />
      <figcaption className="dsh-vi-sr-only">漏斗图，按输入顺序展示阶段，不重新排序。</figcaption>
      <div className="dsh-vi-funnel">
        {config.data.map((point, index) => {
          const previous = index === 0 ? undefined : config.data[index - 1]?.value
          const conversion = point.value !== null && previous !== undefined && previous !== null && previous > 0 ? percent(point.value, previous) : undefined
          return (
            <div className="dsh-vi-funnel-row" key={point.label} tabIndex={0} aria-label={`${point.label}：${formatValue(point.value, config.unit)}${conversion ? `，上一步转化 ${conversion}` : ''}`}>
              <div className="dsh-vi-funnel-label"><span>{point.label}</span><strong>{formatValue(point.value, config.unit)}</strong></div>
              <div className="dsh-vi-funnel-bar-wrap">
                {point.value !== null && <div className="dsh-vi-funnel-bar" style={{ width: `${point.value === 0 ? 0 : Math.max(2, (point.value / maximum) * 100)}%`, background: seriesColor(index) }} />}
                {point.value === null && <span className="dsh-vi-missing-label">无数据</span>}
              </div>
              <small>{index === 0 ? '起始阶段' : conversion ? `上一步转化 ${conversion}` : '上一步转化率不可用'}</small>
            </div>
          )
        })}
      </div>
      <button className="dsh-vi-table-toggle" type="button" aria-expanded={showTable} aria-controls={tableId} onClick={() => setShowTable((value) => !value)}>{showTable ? '收起数据' : '查看数据'}</button>
      {showTable && <div id={tableId}><SingleDataTable title={config.title} unit={config.unit} data={config.data} /></div>}
    </figure>
  )
}

export function DistributionChart({ config }: { config: DistributionChartConfig }): React.ReactElement {
  return config.chart === 'donut' ? <Donut config={config} /> : <Funnel config={config} />
}
