// @vitest-environment jsdom
import * as React from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PanelBoundary } from '../src/client/components/PanelBoundary.tsx'
import { SqlWorkbenchPane } from '../src/client/components/SqlWorkbenchPane.tsx'

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.restoreAllMocks()
})

/** A component that always fails, standing in for a render-time bug. */
function Boom(): React.ReactElement {
  throw new Error('渲染炸了')
}

describe('panel boundary', () => {
  it('renders the pane when nothing throws', async () => {
    await act(async () => {
      root.render(<SqlWorkbenchPane />)
    })

    expect(container.textContent).toContain('SQL 工作台')
    expect(container.querySelector('[data-phase="crashed"]')).toBeNull()
  })

  it('turns a render crash into readable text instead of a blank pane', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    await act(async () => {
      root.render(
        <PanelBoundary>
          <Boom />
        </PanelBoundary>,
      )
    })

    expect(container.textContent).toContain('SQL 工作台渲染失败')
    expect(container.textContent).toContain('渲染炸了')
    expect(container.querySelector('[data-phase="crashed"]')).not.toBeNull()
    expect(logged).toHaveBeenCalled()
  })
})
