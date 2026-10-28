import React from 'react'

/**
 * Conversation-only status island.
 * Width is capped in CSS at half the chat column. The drawer does not use this.
 */
export function Island(props: {
  title: string
  status: string
  marker?: string
  defaultExpanded?: boolean
  children?: React.ReactNode
}): React.ReactElement {
  const [open, setOpen] = React.useState(props.defaultExpanded === true)
  return (
    <article className="boop-island" data-expanded={open ? 'true' : 'false'} data-task-id={props.marker}>
      <button type="button" className="boop-island-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="boop-island-title">{props.title}</span>
        <span className="boop-island-status">{props.status}</span>
      </button>
      {open ? <div className="boop-island-body">{props.children}</div> : null}
    </article>
  )
}
