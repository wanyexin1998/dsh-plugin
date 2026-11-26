import React from 'react'
import type { ProgressConfig } from '../../protocol.ts'

export function Progress({ config }: { config: ProgressConfig }): React.ReactElement {
  const percent = (config.value / config.target) * 100
  const percentText = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(percent)
  const valueText = `${config.value}${config.unit ? ` ${config.unit}` : ''}`
  const targetText = `${config.target}${config.unit ? ` ${config.unit}` : ''}`
  return (
    <section className="dsh-vi-progress" aria-label={`${config.label}，${percentText}%`}>
      <div className="dsh-vi-progress-heading">
        <span className="dsh-vi-progress-label">{config.label}</span>
        <strong>{percentText}%</strong>
      </div>
      <div
        className="dsh-vi-progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, percent)}
        aria-valuetext={`${valueText} / ${targetText}，${percentText}%`}
      >
        <div className="dsh-vi-progress-fill" style={{ width: `${Math.min(100, percent)}%` }} />
      </div>
      <div className="dsh-vi-progress-values">
        <span>{valueText}</span>
        <span>目标 {targetText}</span>
      </div>
    </section>
  )
}
