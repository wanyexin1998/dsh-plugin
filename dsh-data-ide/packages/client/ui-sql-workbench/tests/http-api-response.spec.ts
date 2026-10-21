import { describe, expect, it, vi } from 'vitest'

import { createHttpApi } from '../src/client/http-api.ts'

/** A fetch that always answers the same body. */
function fetchReturning(body: string, status = 200) {
  return vi.fn(async () => new Response(body, { status }))
}

describe('http api: response decoding', () => {
  it('names an empty body as such instead of a JSON parse error', async () => {
    const api = createHttpApi(fetchReturning('', 404))

    // The reported symptom was `SyntaxError: Unexpected end of JSON input`,
    // which said nothing about the real cause (route missing / wrong host).
    await expect(api.list()).rejects.toThrow(/EMPTY_RESPONSE/)
    await expect(api.list()).rejects.toThrow(/HTTP 404/)
  })

  it('rejects a non-JSON body with the status and a snippet', async () => {
    const api = createHttpApi(fetchReturning('<html>not json</html>'))

    await expect(api.list()).rejects.toThrow(/BAD_RESPONSE/)
    await expect(api.list()).rejects.toThrow(/<html>/)
  })

  it('still decodes a normal envelope', async () => {
    const api = createHttpApi(fetchReturning(JSON.stringify({ ok: true, connections: [], activeId: null })))

    await expect(api.list()).resolves.toEqual([])
  })

  it('surfaces the host refusal code', async () => {
    const api = createHttpApi(
      fetchReturning(JSON.stringify({ ok: false, error: { code: 'UNTRUSTED', message: '未通过信任校验' } }), 403),
    )

    await expect(api.list()).rejects.toThrow(/UNTRUSTED/)
  })

  it('lets the layout read fail cleanly when the route is missing', async () => {
    const api = createHttpApi(fetchReturning('', 404))

    // The panel catches this and keeps the defaults, but the failure itself
    // must stay readable rather than becoming a SyntaxError.
    await expect(api.layout?.()).rejects.toThrow(/EMPTY_RESPONSE/)
  })
})
