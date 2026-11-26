import React from 'react'
import { parseAnyVisualize, type AnyVisualizeConfig } from '../protocol-v2.ts'
import { UiTree } from './UiTree.tsx'
import { VisualizeComponent } from './registry.tsx'

export interface VisualizeFenceProps {
  lang: string
  code: string
  streaming: boolean
  meta?: string
  children?: React.ReactNode
}

function Fallback({ children, code }: Pick<VisualizeFenceProps, 'children' | 'code'>): React.ReactElement {
  return <div className="dsh-vi-fallback"><p className="dsh-vi-error" role="alert">可视化配置无效，已保留原始代码。</p>{children ?? <pre><code className="language-visualize">{code}</code></pre>}</div>
}

interface BoundaryProps extends Pick<VisualizeFenceProps, 'children' | 'code'> {
  config: AnyVisualizeConfig
  streaming: boolean
}
interface BoundaryState { failed: boolean; code: string }

class VisualizeBoundary extends React.Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { failed: false, code: this.props.code }
  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): BoundaryState | null {
    return props.code === state.code ? null : { failed: false, code: props.code }
  }
  static getDerivedStateFromError(): Partial<BoundaryState> { return { failed: true } }
  override componentDidCatch(error: unknown): void { console.error('[visualize-inline] component render failed', error) }
  override render(): React.ReactNode {
    if (this.state.failed) return <Fallback code={this.props.code}>{this.props.children}</Fallback>
    if (this.props.config.version === 2) return <UiTree key={this.props.code} spec={this.props.config} streaming={this.props.streaming} />
    return <VisualizeComponent config={this.props.config} />
  }
}

function ValidFence({ config, streaming, children, code }: { config: AnyVisualizeConfig; streaming: boolean; children?: React.ReactNode; code: string }): React.ReactElement {
  return <div className="dsh-vi-root" data-streaming={streaming || undefined}>
    {streaming && <span className="dsh-vi-preview">{config.version === 2 ? '只读预览' : '实时预览'}</span>}
    <VisualizeBoundary config={config} streaming={streaming} code={code}>{children}</VisualizeBoundary>
  </div>
}

export function VisualizeFence({ code, streaming, children }: VisualizeFenceProps): React.ReactElement {
  const result = React.useMemo(() => parseAnyVisualize(code), [code])
  if (result.ok) return <ValidFence config={result.config} streaming={streaming} code={code}>{children}</ValidFence>
  if (streaming) return <div className="dsh-vi-root dsh-vi-loading" role="status" aria-label="正在生成可视化"><span /><span /><span /><span className="dsh-vi-sr-only">正在生成可视化</span></div>
  return <Fallback code={code}>{children}</Fallback>
}
