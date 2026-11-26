import React from 'react'
import type { MetricConfig } from '../../protocol.ts'

export function Metric({ config }: { config: MetricConfig }): React.ReactElement {
  return (
    <section className="dsh-vi-metric" aria-label={config.label}>
      <div className="dsh-vi-metric-label">{config.label}</div>
      <div className="dsh-vi-metric-value">
        <span>{config.value}</span>
        {config.unit && <span className="dsh-vi-unit">{config.unit}</span>}
      </div>
      {config.note && <div className="dsh-vi-note">{config.note}</div>}
    </section>
  )
}
