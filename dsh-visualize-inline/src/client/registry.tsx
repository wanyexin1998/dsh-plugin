import React from 'react'
import type { VisualizeConfig } from '../protocol.ts'
import { Calculator } from './components/Calculator.tsx'
import { Chart } from './components/Chart.tsx'
import { DistributionChart } from './components/Distribution.tsx'
import { Flow } from './components/Flow.tsx'
import { Metric } from './components/Metric.tsx'
import { MetricGroup } from './components/MetricGroup.tsx'
import { MultiSeriesChart } from './components/MultiSeriesChart.tsx'
import { Progress } from './components/Progress.tsx'

export function VisualizeComponent({ config }: { config: VisualizeConfig }): React.ReactElement {
  switch (config.type) {
    case 'metric': return <Metric config={config} />
    case 'progress': return <Progress config={config} />
    case 'metric-group': return <MetricGroup config={config} />
    case 'flow': return <Flow config={config} />
    case 'calculator': return <Calculator config={config} />
    case 'chart':
      if (config.chart === 'donut' || config.chart === 'funnel') return <DistributionChart config={config} />
      if (config.chart === 'bar' || config.chart === 'line') {
        if (config.series) return <MultiSeriesChart config={config} />
        return <Chart config={config} />
      }
      if (config.chart === 'horizontal-bar') return <Chart config={config} />
      throw new Error('unreachable chart kind')
  }
}
