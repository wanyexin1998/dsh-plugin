import React from 'react'
import type { FlowConfig } from '../../protocol.ts'
import { layoutFlow } from '../flow-layout.ts'
import { shortLabel } from '../scale.ts'
import { ChartHeader } from './ChartShared.tsx'

export function Flow({ config }: { config: FlowConfig }): React.ReactElement {
  const [showList, setShowList] = React.useState(false)
  const listId = React.useId()
  const markerId = `dsh-vi-arrow-${React.useId().replaceAll(':', '')}`
  const layout = React.useMemo(() => layoutFlow(config), [config])
  const positions = new Map(layout.nodes.map((node) => [node.id, node]))
  const labels = new Map(config.nodes.map((node) => [node.id, node.label]))
  return (
    <figure className="dsh-vi-chart dsh-vi-flow">
      <ChartHeader title={config.title} />
      <figcaption className="dsh-vi-sr-only">流程图，共 {config.nodes.length} 个节点。可打开节点列表阅读所有连接和分支条件。</figcaption>
      <div className="dsh-vi-chart-scroll">
        <svg className="dsh-vi-chart-svg" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="group" aria-label={config.title ?? '流程图'}>
          <defs><marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path className="dsh-vi-flow-arrow" d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
          {config.edges.map((edge) => {
            const from = positions.get(edge.from)!
            const to = positions.get(edge.to)!
            const startX = from.x + 80
            const endX = to.x - 86
            const middle = (startX + endX) / 2
            const path = `M ${startX} ${from.y} C ${middle} ${from.y}, ${middle} ${to.y}, ${endX} ${to.y}`
            return (
              <g key={`${edge.from}-${edge.to}`}>
                <path className="dsh-vi-flow-edge" d={path} markerEnd={`url(#${markerId})`}><title>{labels.get(edge.from)} → {labels.get(edge.to)}{edge.label ? `：${edge.label}` : ''}</title></path>
                {edge.label && <text className="dsh-vi-flow-edge-label" x={middle} y={(from.y + to.y) / 2 - 7} textAnchor="middle">{shortLabel(edge.label, 18)}<title>{edge.label}</title></text>}
              </g>
            )
          })}
          {layout.nodes.map((node) => (
            <g className={`dsh-vi-flow-node dsh-vi-flow-${node.kind}`} key={node.id} tabIndex={0} role="img" aria-label={`${node.label}，${node.kind}`}>
              {node.kind === 'decision' ? <polygon points={`${node.x},${node.y - 38} ${node.x + 86},${node.y} ${node.x},${node.y + 38} ${node.x - 86},${node.y}`} />
                : <rect x={node.x - 80} y={node.y - 26} width="160" height="52" rx={node.kind === 'start' || node.kind === 'end' ? 26 : 6} />}
              <text x={node.x} y={node.y} textAnchor="middle" dominantBaseline="middle">{shortLabel(node.label, 14)}<title>{node.label}</title></text>
            </g>
          ))}
        </svg>
      </div>
      <button className="dsh-vi-table-toggle" type="button" aria-expanded={showList} aria-controls={listId} onClick={() => setShowList((value) => !value)}>{showList ? '收起节点' : '查看节点'}</button>
      {showList && <div className="dsh-vi-flow-list" id={listId}>
        <ol>{config.nodes.map((node) => <li key={node.id}><strong>{node.label}</strong><span>{node.kind}</span></li>)}</ol>
        {config.edges.length > 0 && <ul>{config.edges.map((edge) => <li key={`${edge.from}-${edge.to}`}>{labels.get(edge.from)} → {labels.get(edge.to)}{edge.label ? `（${edge.label}）` : ''}</li>)}</ul>}
      </div>}
    </figure>
  )
}
