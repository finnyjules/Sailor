// @vitest-environment happy-dom
/**
 * exportEmbedHtml with nested players: a Frame whose wired layer plays live carries that studio's
 * bundle BEFORE its own, with the registration JS between them, all fetched before the poster
 * bake. And the poster bake, which runs inside the app, resolves nested players from the app's
 * registry — every Space Type bundle name through the one app-side Space Type surface.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const loadCalls: string[] = []
const mount = vi.fn(async (box: HTMLElement) => {
  const c = document.createElement('canvas')
  ;(c as unknown as { toDataURL: () => string }).toDataURL = () => 'data:image/png;base64,AAAA'
  box.appendChild(c)
  return { setSize() {}, setTime() {}, destroy() {} }
})

vi.mock('~/lib/embed/surfaces', async () => {
  const actual = await vi.importActual<typeof import('~/lib/embed/surfaces')>('~/lib/embed/surfaces')
  return {
    bundleNameFor: actual.bundleNameFor,
    bundleNamesFor: actual.bundleNamesFor,
    loadEmbedSurface: async (kind: string) => {
      loadCalls.push(kind)
      return { kind, caps: { alpha: true }, mount }
    },
  }
})

const { exportEmbedHtml } = await import('~/lib/embed/export')
const { nestedRegistrationJs, resolveNestedSurface } = await import('~/lib/embed/nested')

const JS: Record<string, string> = {
  '/embed/gradient.js': '(function(){globalThis.__SAILOR_SURFACE__={n:"gradient"}})();',
  '/embed/frame-lean.js': '(function(){globalThis.__SAILOR_SURFACE__={n:"frame"}})();',
}
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  loadCalls.length = 0
  mount.mockClear()
  fetchMock = vi.fn(async (url: string) => (url in JS ? new Response(JS[url], { status: 200 }) : new Response('', { status: 404 })))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.unstubAllGlobals() })

const frameConfig = {
  needsOutlines: false,
  wired: { 0: { kind: 'live', surface: 'gradient', bundle: 'gradient', config: {}, width: 800, height: 450, duration: 4 } },
}
const base = { kind: 'frame', config: frameConfig, duration: 4, width: 8, height: 8, framing: 'box' as const }

describe('exportEmbedHtml — nested players', () => {
  it('fetches the nested bundle then the Frame\'s, and files the nested one between them', async () => {
    const html = await exportEmbedHtml(base)
    expect(fetchMock.mock.calls.map(c => c[0])).toEqual(['/embed/gradient.js', '/embed/frame-lean.js'])
    const joined = JS['/embed/gradient.js'] + nestedRegistrationJs('gradient') + JS['/embed/frame-lean.js']
    expect(html).toContain(joined)
  })

  it('a missing nested bundle fails before the poster bake', async () => {
    delete JS['/embed/gradient.js']
    try {
      await expect(exportEmbedHtml(base)).rejects.toThrow('/embed/gradient.js missing')
      expect(mount).not.toHaveBeenCalled()
    } finally {
      JS['/embed/gradient.js'] = '(function(){globalThis.__SAILOR_SURFACE__={n:"gradient"}})();'
    }
  })

  it('the app resolves nested players from its registry, Space Type through its one surface', async () => {
    await resolveNestedSurface('spacetype-ball')
    await resolveNestedSurface('gradient')
    expect(loadCalls).toEqual(['spacetype', 'gradient'])
  })
})
