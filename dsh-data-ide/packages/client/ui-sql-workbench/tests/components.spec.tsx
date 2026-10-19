import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { SqlWorkbenchArtwork } from '../src/client/components/SqlWorkbenchArtwork.tsx'
import { SqlWorkbenchPanel } from '../src/client/components/SqlWorkbenchPanel.tsx'
import { SqlWorkbenchTitle } from '../src/client/components/SqlWorkbenchTitle.tsx'

describe('tab body', () => {
  it('marks itself and carries the session it was addressed to', () => {
    const html = renderToStaticMarkup(<SqlWorkbenchPanel sessionId="session-7" />)

    expect(html).toContain('data-sql-workbench=""')
    expect(html).toContain('data-session-id="session-7"')
    expect(html).toContain('SQL 工作台')
  })

  it('tolerates a body mounted without host actions', () => {
    const html = renderToStaticMarkup(<SqlWorkbenchPanel sessionId="s1" actions={undefined} />)

    expect(html).toContain('data-session-id="s1"')
  })
})

describe('tab chip', () => {
  it('names the workbench', () => {
    expect(renderToStaticMarkup(<SqlWorkbenchTitle />)).toContain('SQL 工作台')
  })
})

describe('guide artwork', () => {
  it('draws at the size the card asks for', () => {
    const html = renderToStaticMarkup(<SqlWorkbenchArtwork size={40} className="ink" />)

    expect(html).toContain('width="40"')
    expect(html).toContain('class="ink"')
  })

  it('falls back to the host default size', () => {
    expect(renderToStaticMarkup(<SqlWorkbenchArtwork />)).toContain('width="26"')
  })
})
