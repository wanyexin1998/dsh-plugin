import React from 'react'
import type { MetricGroupConfig } from '../../protocol.ts'
import { Metric } from './Metric.tsx'

export function MetricGroup({ config }: { config: MetricGroupConfig }): React.ReactElement {
  return (
    <section className="dsh-vi-metric-group" aria-label={config.title ?? '指标组'}>
      {config.title && <h3 className="dsh-vi-chart-title">{config.title}</h3>}
      <div className="dsh-vi-metric-grid" style={{ gridTemplateColumns: `repeat(${Math.min(3, config.metrics.length)}, minmax(0, 1fr))` }}>
        {config.metrics.map((metric) => <Metric key={metric.label} config={{ version: 1, type: 'metric', ...metric }} />)}
      </div>
    </section>
  )
}
