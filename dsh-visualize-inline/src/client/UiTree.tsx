import React from 'react'
import type { ChartConfig } from '../protocol.ts'
import type { Scalar, UiNode, UiSpec, UiState } from '../protocol-v2.ts'
import { evaluateMetric, evaluateProgress, evaluateText, initialRuntimeState, type RuntimeState } from './expressions.ts'
import { VisualizeComponent } from './registry.tsx'
import { Graphics } from './components/Graphics.tsx'
import { Icon } from './components/Icon.tsx'
import { Metric } from './components/Metric.tsx'
import { Progress } from './components/Progress.tsx'

interface RenderContext {
  state: RuntimeState
  declarations: UiState
  update: (key: string, value: Scalar) => void
  reset: () => void
  disabled: boolean
}

function classes(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(' ')
}

function children(node: { children: UiNode[] }, ctx: RenderContext, path: string): React.ReactNode {
  return node.children.map((child, index) => <TreeNode key={`${path}.${index}`} node={child} ctx={ctx} path={`${path}.${index}`} />)
}

function derived(callback: () => string): string {
  try {
    return callback()
  } catch {
    return '无法计算'
  }
}

function TreeNode({ node, ctx, path }: { node: UiNode; ctx: RenderContext; path: string }): React.ReactElement {
  switch (node.type) {
    case 'box': {
      const variant = node.variant ?? 'plain'
      const padding = node.padding ?? (variant === 'plain' ? 'none' : 'md')
      return <section className={classes('dsh-vi-box', `dsh-vi-box-${variant}`, `dsh-vi-pad-${padding}`, `dsh-vi-gap-${node.gap ?? 'sm'}`, `dsh-vi-align-${node.align ?? 'stretch'}`)}>{children(node, ctx, path)}</section>
    }
    case 'row':
      return <div className={classes('dsh-vi-row', `dsh-vi-gap-${node.gap ?? 'sm'}`, `dsh-vi-align-${node.align ?? 'stretch'}`, `dsh-vi-justify-${node.justify ?? 'start'}`, node.wrap === false && 'dsh-vi-nowrap')}>{children(node, ctx, path)}</div>
    case 'column':
      return <div className={classes('dsh-vi-column', `dsh-vi-gap-${node.gap ?? 'sm'}`, `dsh-vi-align-${node.align ?? 'stretch'}`)}>{children(node, ctx, path)}</div>
    case 'grid':
      return <div className={`dsh-vi-grid dsh-vi-gap-${node.gap ?? 'sm'}`} style={{ '--dsh-vi-grid-columns': node.columns } as React.CSSProperties}>{children(node, ctx, path)}</div>
    case 'divider': return <hr className="dsh-vi-divider" />
    case 'spacer': return <span className="dsh-vi-spacer" aria-hidden="true" />
    case 'text':
      return <p className={classes('dsh-vi-text', `dsh-vi-tone-${node.tone ?? 'default'}`, `dsh-vi-text-${node.size ?? 'md'}`, `dsh-vi-weight-${node.weight ?? 'normal'}`)}>{derived(() => evaluateText(node.text, ctx.state))}</p>
    case 'title':
      return <h3 className={classes('dsh-vi-title', `dsh-vi-tone-${node.tone ?? 'default'}`, `dsh-vi-title-${node.size ?? 'md'}`)}>{derived(() => evaluateText(node.text, ctx.state))}</h3>
    case 'icon': return <Icon node={node} />
    case 'metric': {
      try {
        return <Metric config={{ version: 1, type: 'metric', label: node.label, value: evaluateMetric(node.value, ctx.state), unit: node.unit, note: node.note }} />
      } catch {
        return <div className="dsh-vi-derived-error" role="status">{node.label}：无法计算</div>
      }
    }
    case 'progress': {
      try {
        return <Progress config={{ version: 1, type: 'progress', label: node.label, value: evaluateProgress(node.value, ctx.state, node.target), target: node.target, unit: node.unit }} />
      } catch {
        return <div className="dsh-vi-derived-error" role="status">{node.label}：无法计算</div>
      }
    }
    case 'chart': return <VisualizeComponent config={{ ...node, version: 1 } as ChartConfig} />
    case 'svg': return <Graphics node={node} />
    case 'checkbox':
      return <label className={classes('dsh-vi-checkbox', ctx.disabled && 'dsh-vi-disabled')}>
        <input type="checkbox" checked={ctx.state[node.bind] === true} disabled={ctx.disabled} onChange={(event) => ctx.update(node.bind, event.target.checked)} />
        <span className="dsh-vi-checkbox-copy"><strong>{node.label}</strong>{node.description && <small>{node.description}</small>}</span>
      </label>
    case 'select': {
      const declaration = ctx.declarations[node.bind]
      if (declaration?.type !== 'enum') return <div className="dsh-vi-derived-error">无法计算</div>
      return <label className="dsh-vi-control"><span>{node.label}</span><select value={String(ctx.state[node.bind])} disabled={ctx.disabled} onChange={(event) => ctx.update(node.bind, event.target.value)}>{declaration.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
    }
    case 'slider': {
      const declaration = ctx.declarations[node.bind]
      if (declaration?.type !== 'number') return <div className="dsh-vi-derived-error">无法计算</div>
      const value = typeof ctx.state[node.bind] === 'number' ? ctx.state[node.bind] as number : declaration.initial
      return <label className="dsh-vi-control dsh-vi-slider"><span className="dsh-vi-control-heading"><span>{node.label}</span><output>{value}{node.unit ? ` ${node.unit}` : ''}</output></span><input type="range" min={declaration.min} max={declaration.max} step={declaration.step} value={value} disabled={ctx.disabled} aria-label={node.label} aria-valuetext={`${value}${node.unit ? ` ${node.unit}` : ''}`} onInput={(event) => ctx.update(node.bind, Number(event.currentTarget.value))} onChange={(event) => ctx.update(node.bind, Number(event.currentTarget.value))} /></label>
    }
    case 'button': return <button className="dsh-vi-reset" type="button" disabled={ctx.disabled} onClick={ctx.reset}>{node.label}</button>
  }
}

export function UiTree({ spec, streaming }: { spec: UiSpec; streaming: boolean }): React.ReactElement {
  const [state, setState] = React.useState<RuntimeState>(() => initialRuntimeState(spec.state))
  const declarations = spec.state ?? {}
  const update = React.useCallback((key: string, value: Scalar) => {
    const declaration = declarations[key]
    if (!declaration) return
    if (declaration.type === 'boolean' && typeof value !== 'boolean') return
    if (declaration.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < declaration.min || value > declaration.max) return
      const steps = (value - declaration.min) / declaration.step
      if (Math.abs(steps - Math.round(steps)) > 1e-9) return
    }
    if (declaration.type === 'enum' && (typeof value !== 'string' || !declaration.options.some((option) => option.value === value))) return
    setState((current) => {
      const next = Object.create(null) as RuntimeState
      Object.assign(next, current)
      next[key] = value
      return next
    })
  }, [declarations])
  const reset = React.useCallback(() => setState(initialRuntimeState(spec.state)), [spec.state])
  const interactive = Object.keys(declarations).length > 0
  return (
    <div className="dsh-vi-ui" data-streaming={streaming || undefined}>
      {interactive && !streaming && <span className="dsh-vi-local-badge">本地交互</span>}
      <TreeNode node={spec.root} ctx={{ state, declarations, update, reset, disabled: streaming }} path="root" />
    </div>
  )
}
