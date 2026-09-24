// ensureSpaceTypeFont / ensureSpaceTypeStateFont (~/lib/spacetype/state): a Space Type build
// rasterizes its text atlas ONCE, so the face must be loaded before it. The bug these pin: the
// loader appended the family's Google stylesheet and called document.fonts.load straight away.
// Before the sheet arrives there is no @font-face to load, so that load resolved with nothing,
// and the wired renderer baked a fallback face into a Frame's pre-rendered export frames. The
// order must be: the catalog (it decides the stylesheet href and static-weight pinning), the
// stylesheet has LOADED, then document.fonts.load for each exact weight with the text drawn.
//
// A fake document stands in for the DOM, so the test controls exactly when a stylesheet lands.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setFontCatalog, type GoogleFontLike } from '~/lib/font/resolveFamily'

const log: string[] = []
let releaseCatalog!: (c: GoogleFontLike[]) => void
let catalogPromise: Promise<GoogleFontLike[]>
let catalogLoaded = false

vi.mock('~/data/google-fonts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/data/google-fonts')>()),
  loadGoogleCatalog: () => catalogPromise,
  // The real one reads the catalog: every weight once it has loaded, 400 only before.
  googleFontCssUrl: (family: string) => `css:${family}:${catalogLoaded ? 'all' : '400'}`,
}))

const { ensureSpaceTypeFont, ensureSpaceTypeStateFont, defaultSpaceTypeState } = await import('~/lib/spacetype/state')

class FakeLink extends EventTarget {
  rel = ''
  href = ''
  sheet: object | null = null
  private attrs = new Map<string, string>()
  setAttribute(k: string, v: string) { this.attrs.set(k, v) }
  getAttribute(k: string) { return k === 'href' ? this.href : (this.attrs.get(k) ?? null) }
  land() { log.push(`sheet ${this.href}`); this.sheet = {}; this.dispatchEvent(new Event('load')) }
  fail() { log.push(`sheet-error ${this.href}`); this.dispatchEvent(new Event('error')) }
}

let links: FakeLink[] = []
const fontsLoad = vi.fn(async (font: string, text?: string) => { log.push(`load ${font} [${text ?? ''}]`); return [] })

function freshCatalog() {
  catalogLoaded = false
  catalogPromise = new Promise((res) => {
    releaseCatalog = (c) => { setFontCatalog(c); catalogLoaded = true; log.push('catalog'); res(c) }
  })
}

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

beforeEach(() => {
  log.length = 0
  links = []
  fontsLoad.mockClear()
  setFontCatalog(null)
  freshCatalog()
  vi.stubGlobal('document', {
    head: { appendChild: (l: FakeLink) => { links.push(l); log.push(`link ${l.href}`) } },
    createElement: () => new FakeLink(),
    querySelectorAll: (sel: string) => {
      const key = /data-stg-font="([^"]+)"/.exec(sel)?.[1]
      return links.filter(l => l.getAttribute('data-stg-font') === key)
    },
    fonts: { load: fontsLoad },
  })
})
afterEach(() => { vi.unstubAllGlobals(); setFontCatalog(null) })

describe('ensureSpaceTypeFont — the face is loaded only after its stylesheet has', () => {
  it('catalog → stylesheet loaded → document.fonts.load at each exact weight, with the text', async () => {
    let settled = false
    const done = ensureSpaceTypeFont('Work Sans', { weights: [400, 700], text: 'CRÈME' }).then((ok) => { settled = true; return ok })
    await flush()
    // Nothing is injected before the catalog: its href would ask for 400 only.
    expect(links).toHaveLength(0)
    releaseCatalog([{ family: 'Work Sans', weights: [100, 900], axes: [{ tag: 'wght' }] }])
    await flush()
    expect(links.map(l => l.href)).toEqual(['css:Work Sans:all'])
    // The stylesheet has not arrived: asking for the face now would find no @font-face.
    expect(fontsLoad).not.toHaveBeenCalled()
    expect(settled).toBe(false)
    links[0]!.land()
    expect(await done).toBe(true)
    expect(log).toEqual([
      'catalog',
      'link css:Work Sans:all',
      'sheet css:Work Sans:all',
      'load 400 32px "Work Sans" [CRÈME]',
      'load 700 32px "Work Sans" [CRÈME]',
    ])
  })

  it('an already-loaded stylesheet is reused, not injected again, and the face loads at once', async () => {
    releaseCatalog([])
    const first = ensureSpaceTypeFont('Anton', { weights: [400] })
    await flush()
    links[0]!.land()
    await first
    fontsLoad.mockClear()
    expect(await ensureSpaceTypeFont('Anton', { weights: [400] })).toBe(true)
    expect(links).toHaveLength(1)
    expect(fontsLoad).toHaveBeenCalledWith('400 32px "Anton"', undefined)
  })

  it('a stylesheet injected before the catalog (400 only) gets the full one beside it', async () => {
    // Another caller injected the 400-only sheet before the catalog loaded.
    const early = new FakeLink(); early.href = 'css:Work Sans:400'; early.setAttribute('data-stg-font', 'Work_Sans'); links.push(early)
    early.land()
    releaseCatalog([{ family: 'Work Sans', weights: [100, 900], axes: [{ tag: 'wght' }] }])
    const done = ensureSpaceTypeFont('Work Sans', { weights: [700] })
    await flush()
    expect(links.map(l => l.href)).toEqual(['css:Work Sans:400', 'css:Work Sans:all'])
    expect(fontsLoad).not.toHaveBeenCalled()
    links[1]!.land()
    expect(await done).toBe(true)
    expect(fontsLoad).toHaveBeenCalledWith('700 32px "Work Sans"', undefined)
  })

  it('a stylesheet that fails still settles (best-effort load, true)', async () => {
    releaseCatalog([])
    const done = ensureSpaceTypeFont('Nope Sans', { weights: [700] })
    await flush()
    links[0]!.fail()
    expect(await done).toBe(true)
    expect(log.indexOf('sheet-error css:Nope Sans:all')).toBeLessThan(log.indexOf('load 700 32px "Nope Sans" []'))
  })

  it('false when the wait runs out, without asking for the face early', async () => {
    releaseCatalog([])
    expect(await ensureSpaceTypeFont('Slow Sans', { weights: [700], timeoutMs: 20 })).toBe(false)
    expect(fontsLoad).not.toHaveBeenCalled()
  })

  it('a google:Family@weight token loads the family it names', async () => {
    releaseCatalog([{ family: 'Archivo Black', weights: [400], axes: [] }])
    const done = ensureSpaceTypeFont('google:Archivo Black@700', { weights: [400] })
    await flush()
    expect(links.map(l => l.href)).toEqual(['css:Archivo Black:all'])
    links[0]!.land()
    await done
    expect(fontsLoad).toHaveBeenCalledWith('400 32px "Archivo Black"', undefined)
  })
})

describe('ensureSpaceTypeStateFont — the faces this state builds with', () => {
  it('reads the weight AFTER the catalog: a static family is loaded at 400 only', async () => {
    const s = { ...defaultSpaceTypeState(), effectId: 'ribbon' }
    s.params = { ...s.params, font: 'Anton', text: 'hi', typeWeight: 800 }
    const done = ensureSpaceTypeStateFont(s)
    await flush()
    // Before the catalog, Anton is unknown and would be taken as variable (800).
    releaseCatalog([{ family: 'Anton', weights: [400], axes: [] }])
    await flush()
    links[0]!.land()
    expect(await done).toBe(true)
    expect(fontsLoad.mock.calls.map(c => c[0])).toEqual(['400 32px "Anton"'])
    expect(String(fontsLoad.mock.calls[0]![1])).toContain('HI')
  })

  it('a variable family loads 400 and the Type weight', async () => {
    releaseCatalog([{ family: 'Work Sans', weights: [100, 900], axes: [{ tag: 'wght' }] }])
    const s = { ...defaultSpaceTypeState(), effectId: 'ribbon' }
    s.params = { ...s.params, font: 'Work Sans', typeWeight: 600 }
    const done = ensureSpaceTypeStateFont(s)
    await flush()
    links[0]!.land()
    await done
    expect(fontsLoad.mock.calls.map(c => c[0])).toEqual(['400 32px "Work Sans"', '600 32px "Work Sans"'])
  })
})
