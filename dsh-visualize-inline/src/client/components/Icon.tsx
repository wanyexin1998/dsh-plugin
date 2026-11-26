import React from 'react'
import type { IconNode } from '../../protocol-v2.ts'

const icons: Record<IconNode['name'], React.ReactNode> = {
  'check-circle': <><circle cx="12" cy="12" r="9" /><path d="m8 12 2.5 2.5L16 9" /></>,
  'file-text': <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h4M9 12h6M9 16h6" /></>,
  blocks: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
  'chart-no-axes-combined': <><path d="M4 19V5M4 19h17" /><path d="m7 15 4-5 4 3 5-7" /></>,
  workflow: <><rect x="3" y="3" width="6" height="5" rx="1" /><rect x="15" y="16" width="6" height="5" rx="1" /><path d="M9 5.5h5a3 3 0 0 1 3 3V16M12 18.5H7a3 3 0 0 1-3-3V8" /></>,
  wrench: <><path d="M14 6a5 5 0 0 0-6.5 6.5L3 17l4 4 4.5-4.5A5 5 0 0 0 18 10l-3 3-4-4z" /></>,
  brain: <><path d="M9 4a3 3 0 0 0-5 2 3 3 0 0 0-1 5 4 4 0 0 0 2 7 4 4 0 0 0 7 2V5a3 3 0 0 0-3-1ZM15 4a3 3 0 0 1 5 2 3 3 0 0 1 1 5 4 4 0 0 1-2 7 4 4 0 0 1-7 2" /><path d="M7 9h2M15 9h2M8 15h4M12 15h4" /></>,
  'arrow-down': <><path d="M12 4v15M6 13l6 6 6-6" /></>,
  'arrow-right': <><path d="M4 12h15M13 6l6 6-6 6" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></>,
}

export function Icon({ node }: { node: IconNode }): React.ReactElement {
  const size = { sm: 14, md: 18, lg: 24 }[node.size ?? 'md']
  return <svg className={`dsh-vi-icon dsh-vi-tone-${node.tone ?? 'default'}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{icons[node.name]}</svg>
}
