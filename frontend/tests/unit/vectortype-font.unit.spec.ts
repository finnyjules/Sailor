/**
 * Vector Type font layer — the pure parts.
 *
 * Deliberately no network: fetching a real ttf is verified live in the browser,
 * not here. What IS worth locking down is catalog integrity, because the axis
 * list is baked into the repo filename and a hand-curated path can drift from
 * the axes an entry declares (Inter declared a `slnt` axis its file has never
 * had, which is exactly the bug the filename check below catches offline).
 */
import { describe, it, expect } from 'vitest'
import { VARIABLE_FONTS, VARIABLE_FONTS_BY_ID } from '~/data/variable-fonts'
import {
  normaliseAxes,
  isValidAxisTag,
  variableFontUrl,
  defaultCoords,
  clampCoords,
  type VtFont,
} from '~/lib/vectortype/font'

/** `ofl/inter/Inter[opsz,wght].ttf` → ['opsz','wght'] */
function axesFromFilename(ttfPath: string): string[] {
  const m = ttfPath.match(/\[([^\]]+)\]\.ttf$/)
  return m ? m[1]!.split(',').map(s => s.trim()) : []
}

describe('variable font catalog', () => {
  it('gives every family a repo-relative variable ttf path', () => {
    for (const f of VARIABLE_FONTS) {
      expect(f.ttfPath, f.id).toBeTruthy()
      // Repo-relative, so the proxy can never be pointed at another host.
      expect(f.ttfPath, f.id).not.toMatch(/^(https?:)?\/\//)
      expect(f.ttfPath, f.id).toMatch(/^(ofl|apache|ufl)\/[a-z0-9]+\/[^/]+\.ttf$/)
    }
  })

  it('points at a variable file, not a static cut', () => {
    for (const f of VARIABLE_FONTS) {
      expect(axesFromFilename(f.ttfPath), f.id).not.toHaveLength(0)
    }
  })

  it('only declares axes the file actually carries', () => {
    for (const f of VARIABLE_FONTS) {
      const inFile = axesFromFilename(f.ttfPath)
      for (const axis of f.axes) {
        expect(inFile, `${f.id}: declares ${axis.tag}, file has [${inFile.join(',')}]`).toContain(axis.tag)
      }
    }
  })

  it('declares well-formed axis tags with sane ranges', () => {
    for (const f of VARIABLE_FONTS) {
      for (const a of f.axes) {
        expect(isValidAxisTag(a.tag), `${f.id}/${a.tag}`).toBe(true)
        expect(a.min, `${f.id}/${a.tag}`).toBeLessThan(a.max)
        expect(a.default, `${f.id}/${a.tag}`).toBeGreaterThanOrEqual(a.min)
        expect(a.default, `${f.id}/${a.tag}`).toBeLessThanOrEqual(a.max)
        expect(a.label, `${f.id}/${a.tag}`).toBeTruthy()
      }
    }
  })

  it('has unique ids and no two families sharing a file', () => {
    expect(new Set(VARIABLE_FONTS.map(f => f.id)).size).toBe(VARIABLE_FONTS.length)
    expect(new Set(VARIABLE_FONTS.map(f => f.ttfPath)).size).toBe(VARIABLE_FONTS.length)
    expect(Object.keys(VARIABLE_FONTS_BY_ID)).toHaveLength(VARIABLE_FONTS.length)
  })
})

describe('isValidAxisTag', () => {
  it('accepts four printable-ASCII characters, in either case', () => {
    expect(isValidAxisTag('wght')).toBe(true)
    expect(isValidAxisTag('XOPQ')).toBe(true)
  })
  it('rejects wrong lengths, non-strings and non-ASCII', () => {
    expect(isValidAxisTag('wgh')).toBe(false)
    expect(isValidAxisTag('weight')).toBe(false)
    expect(isValidAxisTag('wgh†')).toBe(false)
    expect(isValidAxisTag(42)).toBe(false)
    expect(isValidAxisTag(undefined)).toBe(false)
  })
})

describe('normaliseAxes', () => {
  it('flattens fontkit\'s keyed record to an array', () => {
    expect(normaliseAxes({ wght: { name: 'Weight', min: 100, default: 400, max: 900 } }))
      .toEqual([{ tag: 'wght', name: 'Weight', min: 100, default: 400, max: 900 }])
  })

  it('falls back to the tag when the font names no axis', () => {
    expect(normaliseAxes({ XOPQ: { min: 27, default: 96, max: 175 } })[0]!.name).toBe('XOPQ')
  })

  it('orders common axes first, then the exotic ones alphabetically', () => {
    const a = normaliseAxes({
      YTAS: { min: 0, default: 0, max: 1 },
      GRAD: { min: 0, default: 0, max: 1 },
      opsz: { min: 8, default: 14, max: 144 },
      wght: { min: 100, default: 400, max: 900 },
      wdth: { min: 25, default: 100, max: 151 },
    })
    expect(a.map(x => x.tag)).toEqual(['wght', 'wdth', 'opsz', 'GRAD', 'YTAS'])
  })

  it('drops malformed axes rather than failing the whole font', () => {
    const a = normaliseAxes({
      wght: { min: 100, default: 400, max: 900 },
      bad1: { min: 'x', default: 1, max: 2 },
      bad2: { min: 10, default: 1, max: 2 },   // max < min
      toolong: { min: 0, default: 0, max: 1 }, // not a 4-char tag
      nul: null,
    })
    expect(a.map(x => x.tag)).toEqual(['wght'])
  })

  it('clamps a default that sits outside the declared range', () => {
    expect(normaliseAxes({ wght: { min: 100, default: 4000, max: 900 } })[0]!.default).toBe(900)
    expect(normaliseAxes({ wght: { min: 100, default: 0, max: 900 } })[0]!.default).toBe(100)
  })

  it('returns [] for a static font, or for junk', () => {
    expect(normaliseAxes({})).toEqual([])
    expect(normaliseAxes(undefined)).toEqual([])
    expect(normaliseAxes('nope')).toEqual([])
  })
})

describe('variableFontUrl', () => {
  it('passes the catalog id, never a font URL', () => {
    expect(variableFontUrl('roboto-flex')).toBe('/api/fonts/variable?id=roboto-flex')
  })
  it('encodes so an id can\'t smuggle extra query params', () => {
    expect(variableFontUrl('a&b=c')).toBe('/api/fonts/variable?id=a%26b%3Dc')
  })
})

describe('coords helpers', () => {
  const font = {
    id: 'test',
    unitsPerEm: 1000,
    raw: null,
    axes: [
      { tag: 'wght', name: 'Weight', min: 100, default: 400, max: 900 },
      { tag: 'wdth', name: 'Width', min: 50, default: 100, max: 150 },
    ],
  } as unknown as VtFont

  it('seeds every axis at the font default', () => {
    expect(defaultCoords(font)).toEqual({ wght: 400, wdth: 100 })
  })

  it('clamps to range and drops axes the font does not have', () => {
    expect(clampCoords(font, { wght: 5000, wdth: -20, GRAD: 50 })).toEqual({ wght: 900, wdth: 50 })
  })

  it('drops non-numeric values instead of passing NaN to fontkit', () => {
    expect(clampCoords(font, { wght: Number.NaN, wdth: 120 })).toEqual({ wdth: 120 })
  })
})

// Below: still no *real* network — fetch is stubbed to serve fixture bytes
// from disk, so the "no network" promise above holds.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, vi } from 'vitest'
import { clearVariableFontCache, loadVariableFont, loadVectorFont } from '~/lib/vectortype/font'

const STATIC = fileURLToPath(new URL('../fixtures/inter-subset-static.ttf', import.meta.url))
const VAR = fileURLToPath(new URL('../fixtures/inter-subset-var.ttf', import.meta.url))
function serve(map: Record<string, string>) {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(String(url))
    const file = Object.entries(map).find(([prefix]) => String(url).startsWith(prefix))?.[1]
    if (!file) return new Response(null, { status: 404 })
    return new Response(readFileSync(file), { status: 200 })
  }))
  return calls
}
afterEach(() => { vi.unstubAllGlobals(); clearVariableFontCache() })

describe('loadVectorFont', () => {
  it('loads a Google cut through the google-file route and yields a font with NO axes', async () => {
    const calls = serve({ '/api/fonts/google-file?family=Inter%20Tight&weight=700': STATIC })
    const f = await loadVectorFont('google:Inter Tight@700')
    expect(calls).toEqual(['/api/fonts/google-file?family=Inter%20Tight&weight=700'])
    expect(f.id).toBe('google:Inter Tight@700'); expect(f.axes).toEqual([]); expect(f.unitsPerEm).toBe(2048)
  })
  it('still loads a curated family through the variable route with its axes', async () => {
    serve({ '/api/fonts/variable?id=inter': VAR })
    const f = await loadVectorFont('inter')
    expect(f.axes.map(a => a.tag).sort()).toEqual(['opsz', 'wght'])
    expect(await loadVariableFont('inter')).toBe(f)             // alias shares the cache
  })
  it('rejects an invalid token without fetching, and evicts a failed load', async () => {
    const calls = serve({})
    await expect(loadVectorFont('no-such-font')).rejects.toThrow(/font token/i)
    expect(calls).toEqual([])
    await expect(loadVectorFont('google:Nope@400')).rejects.toThrow(/HTTP 404/)
    serve({ '/api/fonts/google-file?family=Nope&weight=400': STATIC })
    await expect(loadVectorFont('google:Nope@400')).resolves.toBeTruthy()   // not poisoned
  })
})
