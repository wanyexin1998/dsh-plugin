// @vitest-environment jsdom
import * as React from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ParamsForm } from '../src/client/components/ParamsForm.tsx'

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
})

const byLabel = (label: string): HTMLElement | undefined =>
  [...container.querySelectorAll(`[aria-label="${label}"]`)][0] as HTMLElement | undefined

const typeInto = (label: string, value: string): void => {
  const input = byLabel(label) as HTMLInputElement
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('ParamsForm', () => {
  it('renders nothing while closed', () => {
    act(() => {
      root.render(<ParamsForm open={false} names={[]} onSubmit={vi.fn()} onCancel={vi.fn()} />)
    })
    expect(container.querySelector('[data-params-form]')).toBeNull()
  })

  it('collects one value per name and submits them', () => {
    const onSubmit = vi.fn()
    act(() => {
      root.render(<ParamsForm open names={['id', 'name']} onSubmit={onSubmit} onCancel={vi.fn()} />)
    })
    expect(container.textContent).toContain(':id')
    typeInto('参数 id', '42')
    typeInto('参数 name', 'Bob')
    act(() => {
      byLabel('执行带参数的语句')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onSubmit).toHaveBeenCalledWith({ id: '42', name: 'Bob' })
  })

  it('cancels on Escape and on the cancel button', () => {
    const onCancel = vi.fn()
    act(() => {
      root.render(<ParamsForm open names={['id']} onSubmit={vi.fn()} onCancel={onCancel} />)
    })
    act(() => {
      container
        .querySelector('[data-params-overlay]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }))
    })
    expect(onCancel).toHaveBeenCalledTimes(1)
    act(() => {
      byLabel('取消参数')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onCancel).toHaveBeenCalledTimes(2)
  })

  it('asks the browser to submit the form on Enter', () => {
    const onSubmit = vi.fn()
    act(() => {
      root.render(<ParamsForm open names={['id']} onSubmit={onSubmit} onCancel={vi.fn()} />)
    })
    act(() => {
      container
        .querySelector('form[data-params-form]')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })
})
