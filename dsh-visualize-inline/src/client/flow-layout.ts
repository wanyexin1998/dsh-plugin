import type { FlowConfig, FlowNode } from '../protocol.ts'

export interface PositionedFlowNode extends FlowNode {
  x: number
  y: number
}

export function layoutFlow(config: FlowConfig): { width: number; height: number; nodes: PositionedFlowNode[] } {
  const depths = new Map<string, number>(config.nodes.map((node) => [node.id, 0]))
  const indegree = new Map<string, number>(config.nodes.map((node) => [node.id, 0]))
  for (const edge of config.edges) indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1)
  const queue = config.nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id)
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor]!
    for (const edge of config.edges.filter((item) => item.from === id)) {
      depths.set(edge.to, Math.max(depths.get(edge.to) ?? 0, (depths.get(id) ?? 0) + 1))
      const next = (indegree.get(edge.to) ?? 1) - 1
      indegree.set(edge.to, next)
      if (next === 0) queue.push(edge.to)
    }
  }
  const columns = new Map<number, string[]>()
  for (const node of config.nodes) {
    const depth = depths.get(node.id) ?? 0
    columns.set(depth, [...(columns.get(depth) ?? []), node.id])
  }
  const width = Math.max(320, Math.max(...columns.keys()) * 220 + 240)
  const height = Math.max(180, Math.max(...[...columns.values()].map((column) => column.length)) * 104 + 56)
  const nodes = config.nodes.map((node) => {
    const depth = depths.get(node.id) ?? 0
    const column = columns.get(depth) ?? []
    return { ...node, x: 120 + depth * 220, y: 56 + column.indexOf(node.id) * 104 }
  })
  return { width, height, nodes }
}
