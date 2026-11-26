import React from 'react'
import type { SvgNode } from '../../protocol-v2.ts'

export function Graphics({ node }: { node: SvgNode }): React.ReactElement {
  const markerId = `dsh-vi-svg-arrow-${React.useId().replaceAll(':', '')}`
  const height = { sm: 36, md: 96, lg: 180 }[node.height ?? 'md']
  const shapeProps = (tone?: string, filled?: boolean) => ({
    className: `dsh-vi-svg-shape dsh-vi-tone-${tone ?? 'default'}${filled ? ' dsh-vi-svg-filled' : ''}`,
  })
  return (
    <svg className="dsh-vi-graphics" width="100%" height={height} viewBox={node.viewBox.join(' ')} preserveAspectRatio="xMidYMid meet" role="img" aria-label={node.label ?? '图示'}>
      {node.label && <title>{node.label}</title>}
      <defs><marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path className="dsh-vi-svg-arrow" d="M0 0 10 5 0 10z" /></marker></defs>
      {node.shapes.map((shape, index) => {
        const key = `${shape.type}-${index}`
        const arrow = 'arrowEnd' in shape && shape.arrowEnd ? { markerEnd: `url(#${markerId})` } : {}
        if (shape.type === 'line') return <line key={key} {...shapeProps(shape.tone)} x1={shape.x1} y1={shape.y1} x2={shape.x2} y2={shape.y2} {...arrow} />
        if (shape.type === 'polyline') return <polyline key={key} {...shapeProps(shape.tone)} points={shape.points.map((point) => point.join(',')).join(' ')} {...arrow} />
        if (shape.type === 'rect') return <rect key={key} {...shapeProps(shape.tone, shape.filled)} x={shape.x} y={shape.y} width={shape.width} height={shape.height} rx={shape.rx} />
        if (shape.type === 'circle') return <circle key={key} {...shapeProps(shape.tone, shape.filled)} cx={shape.cx} cy={shape.cy} r={shape.r} />
        return <text key={key} {...shapeProps(shape.tone, true)} x={shape.x} y={shape.y} textAnchor={shape.anchor ?? 'start'}>{shape.text}</text>
      })}
    </svg>
  )
}
