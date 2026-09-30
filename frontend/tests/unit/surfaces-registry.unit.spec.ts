// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  surfacesStatusFor, surfacesImageFor, surfacesMessageFor, surfacesWasPaidFor,
  requestSurfaces, retrySurfaces, peekSurfacesFor, onSurfacesChange, __resetSurfacesRegistry, SURFACES_STILL_READING,
} from '~/lib/compositor/surfacesRegistry'

class FakeImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  crossOrigin = ''
  set src(_v: string) { setTimeout(() => this.onload?.(), 0) }
}

beforeEach(() => {
  __resetSurfacesRegistry()
  vi.restoreAllMocks()
  vi.stubGlobal('Image', FakeImage)
})

describe('surfacesRegistry', () => {
  it('starts idle and reads synchronously as null', () => {
    expect(surfacesStatusFor('a.png')).toBe('idle')
    expect(surfacesImageFor('a.png')).toBeNull()
    expect(surfacesMessageFor('a.png')).toBeNull()
    expect(surfacesWasPaidFor('a.png')).toBe(false)
  })

  it('only makes one request per key while in flight', () => {
    const f = vi.fn(() => new Promise(() => {}))
    vi.stubGlobal('fetch', f)
    requestSurfaces('a.png'); requestSurfaces('a.png'); requestSurfaces('a.png')
    expect(f).toHaveBeenCalledTimes(1)
    expect(surfacesStatusFor('a.png')).toBe('loading')
    expect(surfacesWasPaidFor('a.png')).toBe(true)
  })

  it('ready loads the image and notifies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ normalsFilename: 'moge_abc.png', subfolder: 'sailor_depth', cached: false }),
    })))
    const seen = vi.fn()
    onSurfacesChange(seen)
    requestSurfaces('a.png')
    await vi.waitFor(() => expect(surfacesStatusFor('a.png')).toBe('ready'))
    expect(seen).toHaveBeenCalled()
    expect(surfacesImageFor('a.png')).not.toBeNull()
    expect(surfacesWasPaidFor('a.png')).toBe(false)
  })

  it('a cache hit is never shown as paid once it answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ normalsFilename: 'moge_abc.png', subfolder: 'sailor_depth', cached: true }),
    })))
    requestSurfaces('a.png')
    expect(surfacesWasPaidFor('a.png')).toBe(true)
    await vi.waitFor(() => expect(surfacesStatusFor('a.png')).toBe('ready'))
    expect(surfacesWasPaidFor('a.png')).toBe(false)
  })

  it('a server off answer lands as status off, not retried automatically', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ off: true }) })))
    requestSurfaces('a.png')
    await vi.waitFor(() => expect(surfacesStatusFor('a.png')).toBe('off'))
    expect(surfacesWasPaidFor('a.png')).toBe(false)
  })

  it('retrySurfaces does not call again while off', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ off: true }) }))
    vi.stubGlobal('fetch', f)
    requestSurfaces('a.png')
    await vi.waitFor(() => expect(surfacesStatusFor('a.png')).toBe('off'))
    retrySurfaces('a.png')
    expect(f).toHaveBeenCalledTimes(1)
    expect(surfacesStatusFor('a.png')).toBe('off')
  })

  it('error status carries the message, and retrySurfaces calls again', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 502, json: async () => ({ message: 'boom' }) }))
    vi.stubGlobal('fetch', f)
    requestSurfaces('a.png')
    await vi.waitFor(() => expect(surfacesStatusFor('a.png')).toBe('error'))
    expect(surfacesMessageFor('a.png')).toBe('boom')
    retrySurfaces('a.png')
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('requestSurfaces on a ready key does nothing', async () => {
    const f = vi.fn(async () => ({
      ok: true,
      json: async () => ({ normalsFilename: 'moge_abc.png', subfolder: 'sailor_depth', cached: false }),
    }))
    vi.stubGlobal('fetch', f)
    requestSurfaces('a.png')
    await vi.waitFor(() => expect(surfacesStatusFor('a.png')).toBe('ready'))
    requestSurfaces('a.png')
    expect(f).toHaveBeenCalledTimes(1)
  })

  // Final-review fix 1 (money loop): the Frame editor re-requests on every layer change, so an
  // 'error' entry that requestSurfaces restarted would call the PAID route again on each edit.
  it('requestSurfaces never restarts an error entry — only retrySurfaces does', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 502, json: async () => ({ message: 'boom' }) }))
    vi.stubGlobal('fetch', f)
    requestSurfaces('a.png')
    await vi.waitFor(() => expect(surfacesStatusFor('a.png')).toBe('error'))
    requestSurfaces('a.png'); requestSurfaces('a.png')
    expect(f).toHaveBeenCalledTimes(1)
    expect(surfacesStatusFor('a.png')).toBe('error')
  })

  it('requestSurfaces never restarts an off entry', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ off: true }) }))
    vi.stubGlobal('fetch', f)
    requestSurfaces('a.png')
    await vi.waitFor(() => expect(surfacesStatusFor('a.png')).toBe('off'))
    requestSurfaces('a.png')
    expect(f).toHaveBeenCalledTimes(1)
  })

  // Fix 8: a hosted refusal (no balance, unpriced) is quiet — local depth only, no line.
  it('a 402 (no balance) lands as off, quietly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 402, json: async () => ({ message: 'insufficient credits' }) })))
    requestSurfaces('a.png')
    await vi.waitFor(() => expect(surfacesStatusFor('a.png')).toBe('off'))
    expect(surfacesWasPaidFor('a.png')).toBe(false)
  })

  // Fix 7: a read that outlasts the server's poll is an error the user can retry later.
  it('a 503 { retryLater } lands as error with the still-reading message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ retryLater: true, message: 'fal request timed out' }) })))
    requestSurfaces('a.png')
    await vi.waitFor(() => expect(surfacesStatusFor('a.png')).toBe('error'))
    expect(surfacesMessageFor('a.png')).toBe(SURFACES_STILL_READING)
    expect(SURFACES_STILL_READING).toBe('Still reading — try again in a minute')
  })
})

// 2026-09-30 (Read shape button): the Frame editor peeks for free instead of starting a
// paid read on its own; the button is what calls requestSurfaces for an 'absent' entry.
describe('surfacesRegistry — peekSurfacesFor', () => {
  it('an absent photo lands as status absent, never marked paid', async () => {
    const f = vi.fn(async (_url: string, init: any) => {
      expect(JSON.parse(init.body).peek).toBe(true)
      return { ok: true, status: 200, json: async () => ({ absent: true }) }
    })
    vi.stubGlobal('fetch', f)
    peekSurfacesFor('a.png')
    await vi.waitFor(() => expect(surfacesStatusFor('a.png')).toBe('absent'))
    expect(surfacesWasPaidFor('a.png')).toBe(false)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('a cached photo peeks straight to ready, never marked paid', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ normalsFilename: 'moge_abc.png', subfolder: 'sailor_depth', cached: true }),
    })))
    peekSurfacesFor('a.png')
    expect(surfacesWasPaidFor('a.png')).toBe(false)          // never true, not even while the peek is in flight
    await vi.waitFor(() => expect(surfacesStatusFor('a.png')).toBe('ready'))
    expect(surfacesImageFor('a.png')).not.toBeNull()
    expect(surfacesWasPaidFor('a.png')).toBe(false)
  })

  it('a kill-switch peek answer lands as off, quietly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ off: true }) })))
    peekSurfacesFor('a.png')
    await vi.waitFor(() => expect(surfacesStatusFor('a.png')).toBe('off'))
    expect(surfacesWasPaidFor('a.png')).toBe(false)
  })

  it('an ordinary peek failure leaves no entry (quiet — no error line for a read nobody asked for)', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ message: 'boom' }) }))
    vi.stubGlobal('fetch', f)
    peekSurfacesFor('a.png')
    await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(1))
    await Promise.resolve(); await Promise.resolve()
    expect(surfacesStatusFor('a.png')).toBe('idle')
  })

  it('watch-style repeated peeks before the answer lands make only one request', async () => {
    let resolve!: (v: unknown) => void
    const f = vi.fn(() => new Promise((r) => { resolve = r }))
    vi.stubGlobal('fetch', f)
    peekSurfacesFor('a.png'); peekSurfacesFor('a.png'); peekSurfacesFor('a.png')
    expect(f).toHaveBeenCalledTimes(1)
    resolve({ ok: true, status: 200, json: async () => ({ absent: true }) })
    await vi.waitFor(() => expect(surfacesStatusFor('a.png')).toBe('absent'))
    // Once it has landed as 'absent', the rule is: an existing entry is never re-peeked.
    peekSurfacesFor('a.png')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('peekSurfacesFor is a no-op once a real read is already in flight for that key', async () => {
    const f = vi.fn(() => new Promise(() => {}))
    vi.stubGlobal('fetch', f)
    requestSurfaces('a.png')
    expect(surfacesStatusFor('a.png')).toBe('loading')
    peekSurfacesFor('a.png')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('absent → requestSurfaces (the button) starts a real, paid read exactly once', async () => {
    const f = vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body)
      if (body.peek) return { ok: true, status: 200, json: async () => ({ absent: true }) }
      return { ok: true, status: 200, json: async () => ({ normalsFilename: 'moge_abc.png', subfolder: 'sailor_depth', cached: false }) }
    })
    vi.stubGlobal('fetch', f)
    peekSurfacesFor('a.png')
    await vi.waitFor(() => expect(surfacesStatusFor('a.png')).toBe('absent'))
    expect(surfacesWasPaidFor('a.png')).toBe(false)
    requestSurfaces('a.png')
    expect(surfacesStatusFor('a.png')).toBe('loading')
    expect(surfacesWasPaidFor('a.png')).toBe(true)
    await vi.waitFor(() => expect(surfacesStatusFor('a.png')).toBe('ready'))
    expect(f).toHaveBeenCalledTimes(2)                        // one peek, one read
    requestSurfaces('a.png')
    expect(f).toHaveBeenCalledTimes(2)                        // ready: requestSurfaces is a no-op again
  })
})
