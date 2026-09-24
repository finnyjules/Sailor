// @vitest-environment happy-dom
/**
 * exportEmbedHtml's fallback poster: a lossless PNG only where the picture can carry alpha, a JPEG
 * otherwise. The pre-rendered `frames` player declares alpha (its frames CAN be transparent), but
 * its frames are opaque unless the export is transparent — so it says so with `posterAlpha`, and
 * an opaque 3D export gets the smaller JPEG. Every other surface keeps what it had.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

let alphaCap = true
const toDataURL = vi.fn((mime?: string) => `data:${mime ?? 'image/png'};base64,AAAA`)

vi.mock('~/lib/embed/surfaces', () => ({
  bundleNameFor: (kind: string) => kind,
  bundleNamesFor: (kind: string) => [kind],
  loadEmbedSurface: async (kind: string) => ({
    kind,
    caps: { alpha: alphaCap },
    async mount(box: HTMLElement) {
      const c = document.createElement('canvas')
      ;(c as unknown as { toDataURL: typeof toDataURL }).toDataURL = toDataURL
      box.appendChild(c)
      return { setSize() {}, setTime() {}, destroy() {} }
    },
  }),
}))

const { exportEmbedHtml } = await import('~/lib/embed/export')

beforeEach(() => {
  alphaCap = true
  toDataURL.mockClear()
  vi.stubGlobal('fetch', vi.fn(async () => new Response('window.__x=1', { status: 200 })))
})
afterEach(() => { vi.unstubAllGlobals() })

const base = { kind: 'frames', config: {}, duration: 1, width: 8, height: 8 }
const posterMime = () => toDataURL.mock.calls.at(-1)![0]

describe('exportEmbedHtml — the poster format', () => {
  it('frames player, opaque export: a JPEG poster', async () => {
    await exportEmbedHtml({ ...base, transparent: false, posterAlpha: false })
    expect(posterMime()).toBe('image/jpeg')
  })

  it('frames player, transparent export: a PNG poster (JPEG would paint the clear area black)', async () => {
    const html = await exportEmbedHtml({ ...base, transparent: true, posterAlpha: true })
    expect(posterMime()).toBe('image/png')
    expect(html).toContain('data:image/png')
  })

  it('a surface that says nothing keeps what it had: PNG with alpha, JPEG without', async () => {
    await exportEmbedHtml({ ...base, kind: 'spacetype' })
    expect(posterMime()).toBe('image/png')
    alphaCap = false
    await exportEmbedHtml({ ...base, kind: 'shader' })
    expect(posterMime()).toBe('image/jpeg')
  })

  it('never turns alpha on for a surface that cannot render it', async () => {
    alphaCap = false
    await exportEmbedHtml({ ...base, kind: 'gradient', transparent: true, posterAlpha: true })
    expect(posterMime()).toBe('image/jpeg')
  })
})
