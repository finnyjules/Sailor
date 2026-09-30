// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  surfacesStatusFor, surfacesImageFor, surfacesMessageFor, surfacesWasPaidFor,
  requestSurfaces, retrySurfaces, onSurfacesChange, __resetSurfacesRegistry,
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
})
