import React from 'react'
import type { CalculatorConfig } from '../../protocol.ts'

export function calculate(config: CalculatorConfig): number {
  switch (config.operation) {
    case 'add': return config.operands.reduce((sum, value) => sum + value, 0)
    case 'subtract': return config.operands[0]! - config.operands[1]!
    case 'multiply': return config.operands.reduce((product, value) => product * value, 1)
    case 'divide': return config.operands[0]! / config.operands[1]!
  }
}

export function Calculator({ config }: { config: CalculatorConfig }): React.ReactElement {
  const result = calculate(config)
  const symbol = { add: ' + ', subtract: ' − ', multiply: ' × ', divide: ' ÷ ' }[config.operation]
  const rounded = Number(result.toPrecision(12))
  const exactDisplay = rounded === result || Math.abs(result - rounded) <= Number.EPSILON * Math.max(1, Math.abs(result)) * 4
  const resultText = new Intl.NumberFormat('zh-CN', { useGrouping: false, maximumSignificantDigits: 12 }).format(result)
  return (
    <section className="dsh-vi-calculator" aria-label={`${config.label}，结果 ${resultText}${config.unit ? ` ${config.unit}` : ''}`}>
      <div className="dsh-vi-metric-label">{config.label}</div>
      <div className="dsh-vi-calculation">{config.operands.join(symbol)}</div>
      <div className="dsh-vi-calculator-result">
        <span>{exactDisplay ? '=' : '≈'} {resultText}</span>
        {config.unit && <span className="dsh-vi-unit">{config.unit}</span>}
      </div>
      {config.note && <div className="dsh-vi-note">{config.note}</div>}
    </section>
  )
}
