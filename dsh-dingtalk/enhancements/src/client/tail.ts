import type { ReasonCode } from '../shared/models.js';

interface ToolBlock {
  kind?: string; name?: string; callId?: string;
  content?: readonly { type: string; text?: string }[];
  subCalls?: readonly ToolBlock[];
}
export interface ChatSnapshot {
  nodes: { values(): readonly {
    kind: string; anchorSeq: number;
    location: { kind: string; turn?: { turn: number } };
    data: { root?: ToolBlock };
  }[] };
}
/** Read durable tool results, including folded and nested PTC calls. Never infer
 * authorization from assistant prose or whether a ToolView happens to mount.
 * Return a stable primitive for the host's selector hook.
 */
export function authorizationTail(snapshot: ChatSnapshot): string {
  let selected: { turn: number; callId: string; reason: ReasonCode } | undefined;
  const nodes = [...snapshot.nodes.values()].sort((a, b) => a.anchorSeq - b.anchorSeq);
  for (const node of nodes) {
    if (node.kind !== 'tool-call' || !node.location.turn || !node.data.root) continue;
    const visit = (block: ToolBlock) => {
      if (block.kind === 'tool-result' && block.name === 'dingtalk_call' && block.callId) {
        try {
          const text = block.content?.filter(part => part.type === 'text').map(part => part.text || '').join('\n') || '';
          const result = JSON.parse(text);
          if (result?.status === 'auth_required' || result?.reasonCode === 'authorization_expired') {
            const turn = node.location.turn!.turn;
            selected = { turn, callId: selected?.turn === turn ? selected.callId : block.callId, reason: result.reasonCode || 'not_connected' };
          }
        } catch { /* Malformed business results do not request authorization. */ }
      }
      for (const child of block.subCalls || []) visit(child);
    };
    visit(node.data.root);
  }
  return selected ? JSON.stringify(selected) : '';
}
