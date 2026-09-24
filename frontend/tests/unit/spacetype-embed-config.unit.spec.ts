// The ONE Space Type embed config builder (~/lib/spacetype/embedConfig): the studio's own
// "Export embed" and the Frame export's live route both build their config here. These
// tests pin (1) that the builder is exactly what the studio's old inline export built for a
// non-seamless piece, (2) seamless `loops`/duration, (3) every reason a state is kept on the
// pre-rendered route, and (4) what the node's frame source offers as its live player.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  spaceTypeEmbedConfig, spaceTypeEmbedDuration, liveEmbedBlocker, LIVE_VERIFIED_EFFECTS,
  spaceTypeEmbedFont, spaceTypeWiredEmbed, spaceTypeSubsetText, spaceTypeEmbedFace, DEFAULT_WEIGHT_EFFECTS,
} from '~/lib/spacetype/embedConfig'
import { defaultSpaceTypeState, type SpaceTypeState } from '~/lib/spacetype/state'
import { getEffect } from '~/lib/spacetype/effects'
import { defaultsFromControls } from '~/lib/spacetype/effect'
import { loopMultiplier } from '~/lib/spacetype/loop'
import { effectiveLoopSeconds } from '~/lib/compositor/loopReconcile'
import { DEFAULT_POST } from '~/lib/spacetype/postSettings'
import { setFontCatalog } from '~/lib/font/resolveFamily'
import { makeSpaceTypeFrameSource } from '~/lib/spacetype/frameSource'

function stateFor(effectId: string, params: Record<string, unknown> = {}, extra: Partial<SpaceTypeState> = {}): SpaceTypeState {
  const s = defaultSpaceTypeState()
  s.effectId = effectId
  s.params = { ...defaultsFromControls(getEffect(effectId).controls), ...params } as SpaceTypeState['params']
  return { ...s, ...extra }
}

const ALL = new Set(['ribbon', 'cylinder', 'loft', 'boost', 'stripes', 'showfan', 'ring'])
const verifiedFor = (s: SpaceTypeState) => new Set([getEffect(s.effectId).id])

beforeEach(() => setFontCatalog(null))

describe('spaceTypeEmbedConfig — same config the studio export built', () => {
  // The studio modal's refs for a representative non-seamless piece, and the exact inline
  // object SpaceTypeSurface.vue's exportWebEmbed built from them before the shared builder.
  const refs = {
    effectId: 'ribbon',
    params: { ...defaultsFromControls(getEffect('ribbon').controls), text: 'Hello there', font: 'Fraunces', typeWeight: 600 },
    gradientStops: [{ color: '#112233', on: true }, { color: '#445566', on: false }],
    post: { ...DEFAULT_POST, bloom: true, bloomStrength: 1.3 },
    fps: 24, loopDuration: 5, seamless: false,
    dimsKey: '1080 × 1920 (9:16)', W: 1080, H: 1920, transparent: true, bgColor: '#ff00aa',
    projection: 'isometric' as const, panX: 0.25, panY: -0.4,
  }
  const font = { family: 'Fraunces', weight: 600, dataUrl: 'data:font/ttf;base64,AAAA' }
  function oldInlineConfig() {
    return {
      effectId: getEffect(refs.effectId).id,
      params: { ...refs.params },
      opts: {
        width: refs.W, height: refs.H, fps: refs.fps, loopDuration: refs.loopDuration,
        alpha: refs.transparent, bgColor: refs.bgColor, projection: refs.projection,
        panX: refs.panX, panY: refs.panY,
      },
      duration: refs.loopDuration,
      font,
      gradientStops: refs.gradientStops.map(g => ({ ...g })),
      post: { ...refs.post },
    }
  }
  // What the modal's currentState() (= its save path) builds from those refs.
  const saved: SpaceTypeState = {
    effectId: refs.effectId, params: { ...refs.params }, gradientStops: refs.gradientStops.map(g => ({ ...g })),
    post: { ...refs.post }, fps: refs.fps, loopDuration: refs.loopDuration, seamless: refs.seamless,
    dimsKey: refs.dimsKey, W: refs.W, H: refs.H, transparent: refs.transparent, bgColor: refs.bgColor,
    projection: refs.projection, panX: refs.panX, panY: refs.panY,
  }

  it('equals the old inline export config exactly, with no `loops`', () => {
    const cfg = spaceTypeEmbedConfig(saved, font)
    expect(cfg).toEqual(oldInlineConfig())
    expect('loops' in cfg).toBe(false)
    // …and the export duration is unchanged too.
    expect(spaceTypeEmbedDuration(saved)).toBe(refs.loopDuration)
  })

  it('copies params, stops and post rather than sharing them', () => {
    const cfg = spaceTypeEmbedConfig(saved, font)
    expect(cfg.params).not.toBe(saved.params)
    expect(cfg.gradientStops).not.toBe(saved.gradientStops)
    expect(cfg.gradientStops![0]).not.toBe(saved.gradientStops[0])
    expect(cfg.post).not.toBe(saved.post)
  })

  it('normalizes a mixed-case effect id and fills absent optional fields the way the node does', () => {
    const s = stateFor('ribbon')
    s.effectId = 'RIBBON'
    delete s.post; delete s.projection; delete s.panX; delete s.panY
    const cfg = spaceTypeEmbedConfig(s, null)
    expect(cfg.effectId).toBe('ribbon')
    expect(cfg.opts).toMatchObject({ width: 960, height: 540, projection: 'perspective', panX: 0, panY: 0 })
    expect(cfg.post).toEqual(DEFAULT_POST)
    expect(cfg.font).toBeNull()
  })
})

describe('seamless loops', () => {
  const seamless = stateFor('cylinder', { waveSpeed: 0.5, spinSpeed: 0 }, { seamless: true, loopDuration: 4 })
  const k = loopMultiplier(getEffect('cylinder').loopRates!(seamless.params))

  it('a seamless piece carries loops = k and lasts loopDuration × k', () => {
    expect(k).toBe(2)
    const cfg = spaceTypeEmbedConfig(seamless, null)
    expect(cfg.loops).toBe(k)
    expect(spaceTypeEmbedDuration(seamless)).toBe(effectiveLoopSeconds(4, k))
    expect(spaceTypeEmbedDuration(seamless)).toBe(8)
    expect(cfg.duration).toBe(8)
  })

  it('the same piece without seamless has no loops and one base loop', () => {
    const plain = { ...seamless, seamless: false }
    expect('loops' in spaceTypeEmbedConfig(plain, null)).toBe(false)
    expect(spaceTypeEmbedDuration(plain)).toBe(effectiveLoopSeconds(4, 1))
  })
})

describe('liveEmbedBlocker', () => {
  it('LIVE_VERIFIED_EFFECTS starts empty, so every effect is blocked as not yet checked', () => {
    expect(LIVE_VERIFIED_EFFECTS.size).toBe(0)
    expect(liveEmbedBlocker(stateFor('ribbon'))).toMatch(/not been checked/)
  })

  it('a clean state on a verified effect is not blocked', () => {
    const s = stateFor('ribbon')
    expect(liveEmbedBlocker(s, verifiedFor(s))).toBeNull()
    expect(liveEmbedBlocker(s, ALL)).toBeNull()
  })

  it('Boost (font outlines loaded from the web)', () => {
    const s = stateFor('boost')
    expect(liveEmbedBlocker(s, verifiedFor(s))).toMatch(/outlines loaded from the web/)
  })

  it('Loft word shape (glyph outlines), but not its other shapes', () => {
    const word = stateFor('loft', { shape: 'word' })
    expect(liveEmbedBlocker(word, verifiedFor(word))).toMatch(/word shape/)
    const legacyWord = stateFor('loft', { shape: '', profileKind: 'word' })
    expect(liveEmbedBlocker(legacyWord, verifiedFor(legacyWord))).toMatch(/word shape/)
    const oval = stateFor('loft', { shape: 'oval' })
    expect(liveEmbedBlocker(oval, verifiedFor(oval))).toBeNull()
  })

  it('a Showcase photo card, in the new and the legacy shape; a solid card is fine', () => {
    const id = 'showfan'
    const photo = stateFor(id, { content: JSON.stringify([{ id: 'a', kind: 'card', fillKind: 'image', src: '/view?filename=a.png' }]) })
    expect(liveEmbedBlocker(photo, verifiedFor(photo))).toMatch(/photos/)
    const legacy = stateFor(id, { content: JSON.stringify([{ id: 'a', kind: 'image', src: '/view?filename=a.png' }]) })
    expect(liveEmbedBlocker(legacy, verifiedFor(legacy))).toMatch(/photos/)
    const solid = stateFor(id, { content: JSON.stringify([{ id: 'a', kind: 'card', fillKind: 'solid', src: '/old.png', fill: { type: 'solid', a: '#fff' } }]) })
    expect(liveEmbedBlocker(solid, verifiedFor(solid))).toBeNull()
  })

  it('a shader fill in any fill list (Holographic is one)', () => {
    const s = stateFor('ribbon', { fills: JSON.stringify([{ type: 'solid', a: '#fff' }, { type: 'shader', shader: { effectId: 'holographic_surface' } }]) })
    expect(liveEmbedBlocker(s, verifiedFor(s))).toMatch(/shader fill/)
    const word = stateFor('slot', { wordFill: JSON.stringify({ type: 'shader', shader: {} }) })
    expect(liveEmbedBlocker(word, verifiedFor(word))).toMatch(/shader fill/)
  })

  it('a library font', () => {
    const s = stateFor('ribbon', { font: 'local:Right Grotesk@700' })
    expect(liveEmbedBlocker(s, verifiedFor(s))).toMatch(/library/)
  })

  it('a single-weight font at a weight other than 400; fine at 400 or on a variable family', () => {
    setFontCatalog([{ family: 'Satisfy', weights: [400], axes: [] }, { family: 'Inter', weights: [100, 900], axes: [{ tag: 'wght' }] }])
    const bold = stateFor('ribbon', { font: 'Satisfy', typeWeight: 700 })
    expect(liveEmbedBlocker(bold, verifiedFor(bold))).toMatch(/single-weight/)
    const regular = stateFor('ribbon', { font: 'Satisfy', typeWeight: 400 })
    expect(liveEmbedBlocker(regular, verifiedFor(regular))).toBeNull()
    const variable = stateFor('ribbon', { font: 'Inter', typeWeight: 700 })
    expect(liveEmbedBlocker(variable, verifiedFor(variable))).toBeNull()
  })

  it('Pile and the default-weight effects ask the same weight in the app and the player, so a static family is fine', () => {
    setFontCatalog([{ family: 'Satisfy', weights: [400], axes: [] }])
    const pile = stateFor('pile', { font: 'Satisfy', typeWeight: 700 })
    expect(liveEmbedBlocker(pile, verifiedFor(pile))).toBeNull()
    const contour = stateFor('contour', { font: 'Satisfy', typeWeight: 700 })
    expect(liveEmbedBlocker(contour, verifiedFor(contour))).toBeNull()
  })

  it('an unset text case on an effect whose own default is not capitals', () => {
    const s = stateFor('stripes')
    delete (s.params as Record<string, unknown>).textCase
    expect(liveEmbedBlocker(s, verifiedFor(s))).toMatch(/capitalise/)
    const stored = stateFor('stripes', { textCase: null })
    expect(liveEmbedBlocker(stored, verifiedFor(stored))).toMatch(/capitalise/)
    const set = stateFor('stripes', { textCase: 'asis' })
    expect(liveEmbedBlocker(set, verifiedFor(set))).toBeNull()
  })

  it('reports a cannot-carry reason ahead of "not checked"', () => {
    expect(liveEmbedBlocker(stateFor('boost'))).toMatch(/outlines/)
  })
})

describe('spaceTypeWiredEmbed', () => {
  const size = { width: 960, height: 540 }
  const font = { family: 'Inter', weight: 700, dataUrl: 'data:font/ttf;base64,AAAA' }

  it('null (without fetching the font) when blocked — including by the empty verified list', async () => {
    const loadFont = vi.fn(async () => font)
    expect(await spaceTypeWiredEmbed(stateFor('ribbon'), size, { loadFont })).toBeNull()
    const boost = stateFor('boost')
    expect(await spaceTypeWiredEmbed(boost, size, { verified: verifiedFor(boost), loadFont })).toBeNull()
    expect(loadFont).not.toHaveBeenCalled()
  })

  it('null when the font could not be inlined for a non-system family', async () => {
    const s = stateFor('ribbon', { font: 'Inter' })
    expect(await spaceTypeWiredEmbed(s, size, { verified: verifiedFor(s), loadFont: async () => null })).toBeNull()
  })

  it('a system family needs no inlined font', async () => {
    const s = stateFor('ribbon', { font: 'sans-serif' })
    const e = await spaceTypeWiredEmbed(s, size, { verified: verifiedFor(s), loadFont: async () => null })
    expect(e).not.toBeNull()
    expect((e!.config as { font: unknown }).font).toBeNull()
  })

  it('the full embed otherwise: surface, per-effect bundle, shared config, native size, pass length', async () => {
    const s = stateFor('cylinder', { font: 'Inter', waveSpeed: 0.5, spinSpeed: 0 }, { seamless: true, loopDuration: 3 })
    const e = await spaceTypeWiredEmbed(s, { width: 1280, height: 720 }, { verified: verifiedFor(s), loadFont: async () => font })
    expect(e).toEqual({
      surface: 'spacetype',
      bundle: 'spacetype-cylinder',
      config: spaceTypeEmbedConfig(s, font),
      width: 1280,
      height: 720,
      duration: 6,
    })
  })
})

describe('spaceTypeEmbedFont', () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks() })

  it('fetches the face (with a timeout), subsets it to everything the effect draws, and inlines it as a data URL', async () => {
    const calls: string[] = []
    let subsetText = ''
    let fontSignal: AbortSignal | undefined
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(url))
      if (String(url).startsWith('/api/scene3d/google-font-file')) {
        fontSignal = init?.signal ?? undefined
        return new Response(new Uint8Array([1, 2, 3]))
      }
      subsetText = JSON.parse(String(init!.body)).text
      return new Response(JSON.stringify({ font: 'U1VCU0VU' }))
    }) as typeof fetch
    const s = stateFor('ribbon', { font: 'Embed Test Face', typeWeight: 500, text: 'crème' })
    expect(await spaceTypeEmbedFont(s)).toEqual({ family: 'Embed Test Face', weight: 500, dataUrl: 'data:font/ttf;base64,U1VCU0VU' })
    expect(calls[0]).toBe('/api/scene3d/google-font-file?family=Embed+Test+Face&weight=500')
    expect(calls[1]).toBe('/sailor/font_subset')
    expect(subsetText).toBe(spaceTypeSubsetText(s))
    expect(subsetText).toContain('È')
    expect(fontSignal).toBeInstanceOf(AbortSignal)
  })

  it('a default-weight effect inlines the 400 face even on a multi-weight family', async () => {
    setFontCatalog([{ family: 'Work Sans', weights: [100, 900], axes: [{ tag: 'wght' }] }])
    const calls: string[] = []
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(String(url))
      if (String(url).startsWith('/api/scene3d/google-font-file')) return new Response(new Uint8Array([4, 5, 6]))
      return new Response(JSON.stringify({ font: 'U1VCU0VU' }))
    }) as typeof fetch
    const s = stateFor('contour', { font: 'Work Sans', typeWeight: 700 })
    expect(await spaceTypeEmbedFont(s)).toMatchObject({ family: 'Work Sans', weight: 400 })
    expect(calls[0]).toBe('/api/scene3d/google-font-file?family=Work+Sans&weight=400')
  })

  it('null when the face cannot be fetched, and a later try fetches again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const f = vi.fn(async () => new Response('nope', { status: 404 }))
    globalThis.fetch = f as unknown as typeof fetch
    const s = stateFor('ribbon', { font: 'Missing Face', typeWeight: 700 })
    expect(await spaceTypeEmbedFont(s)).toBeNull()
    expect(await spaceTypeEmbedFont(s)).toBeNull()
    expect(f).toHaveBeenCalledTimes(2)
  })
})

describe('makeSpaceTypeFrameSource — embed passthrough', () => {
  const deps = { getClock: () => ({ duration: 6, fps: 30, width: 960, height: 540 }), renderAt: () => null }

  it('exposes embed() when the dep is given', async () => {
    const embed = vi.fn(async () => null)
    const src = makeSpaceTypeFrameSource({ ...deps, embed })
    expect(typeof src.embed).toBe('function')
    expect(await src.embed!()).toBeNull()
    expect(embed).toHaveBeenCalledTimes(1)
  })

  it('has no embed when the dep is absent (frames only)', () => {
    const src = makeSpaceTypeFrameSource(deps)
    expect(src.embed).toBeUndefined()
    expect(src.duration).toBe(6)
  })
})

describe('spaceTypeSubsetText — every character the player can draw', () => {
  const has = (t: string, ...chars: string[]) => chars.every(c => t.includes(c))

  it('"crème" in capitals keeps "È" as well as "è"', () => {
    const t = spaceTypeSubsetText(stateFor('ribbon', { text: 'crème', textCase: 'upper' }))
    expect(has(t, 'è', 'È')).toBe(true)
  })

  it('an effect with no Case control is capitalised; an unset case on one that has it too', () => {
    expect(spaceTypeSubsetText(stateFor('elastic', { text: 'brûlée' }))).toContain('Û')
    const unset = stateFor('stripes', { text: 'éte' })
    delete (unset.params as Record<string, unknown>).textCase
    expect(spaceTypeSubsetText(unset)).toContain('É')
  })

  it('as typed leaves the capitals out', () => {
    const t = spaceTypeSubsetText(stateFor('stripes', { text: 'crème', textCase: 'asis' }))
    expect(t).toContain('è')
    expect(t).not.toContain('È')
  })

  it("Slot's filler tokens and every message line", () => {
    const t = spaceTypeSubsetText(stateFor('slot', { text: 'ÇA VA\nÑU', fillerSource: 'custom', fillerTokens: '★ Ø' }))
    expect(has(t, 'Ç', 'Ñ', '★', 'Ø')).toBe(true)
  })

  it("Showcase's word cards (their text lives in the content list)", () => {
    const content = JSON.stringify([
      { id: 'w', kind: 'word', text: 'Straße', resolution: 'whole' },
      { id: 'c', kind: 'card', fillKind: 'solid', fill: { type: 'solid', a: '#fff' } },
    ])
    const t = spaceTypeSubsetText(stateFor('showfan', { content }))
    expect(has(t, 'ß', 'S')).toBe(true)
  })

  it("Loft's word", () => {
    expect(spaceTypeSubsetText(stateFor('loft', { shape: 'word', text: 'Ωmega' }))).toContain('Ω')
  })

  it('always holds basic Latin, and each character once', () => {
    const t = spaceTypeSubsetText(stateFor('ribbon', { text: 'aaa' }))
    for (let cp = 0x20; cp <= 0x7e; cp++) expect(t).toContain(String.fromCharCode(cp))
    expect(new Set(t).size).toBe([...t].length)
  })
})

describe('spaceTypeEmbedFace — the weight the effect draws', () => {
  beforeEach(() => setFontCatalog([
    { family: 'Work Sans', weights: [100, 900], axes: [{ tag: 'wght' }] },
    { family: 'Satisfy', weights: [400], axes: [] },
  ]))

  it('the Type weight on a multi-weight family, 400 on a single-weight one', () => {
    expect(spaceTypeEmbedFace(stateFor('ribbon', { font: 'Work Sans', typeWeight: 700 }))).toEqual({ family: 'Work Sans', weight: 700 })
    expect(spaceTypeEmbedFace(stateFor('ribbon', { font: 'Satisfy', typeWeight: 700 }))).toEqual({ family: 'Satisfy', weight: 400 })
  })

  it('400 for the effects that draw at the default weight, whatever the Type weight', () => {
    for (const id of DEFAULT_WEIGHT_EFFECTS) {
      expect(spaceTypeEmbedFace(stateFor(id, { font: 'Work Sans', typeWeight: 700 }))).toEqual({ family: 'Work Sans', weight: 400 })
    }
  })

  it('an unset font is Inter, as in the app', () => {
    const s = stateFor('ribbon')
    delete (s.params as Record<string, unknown>).font
    expect(spaceTypeEmbedFace(s).family).toBe('Inter')
  })

  it('DEFAULT_WEIGHT_EFFECTS is exactly the effects whose own canvas text names no weight', () => {
    const dir = join(process.cwd(), 'app/lib/spacetype/effects')
    const found = new Set<string>()
    for (const f of readdirSync(dir).filter(n => n.endsWith('.ts'))) {
      const src = readFileSync(join(dir, f), 'utf8')
      // `x.font = \`${size}px "…"` — a size first, so the weight is the CSS default.
      if (!/\.font\s*=\s*`\$\{[^}]*\}px/.test(src)) continue
      const id = /\bid:\s*'([^']+)'/.exec(src)?.[1]
      expect(id, f).toBeTruthy()
      found.add(id!)
    }
    expect(found).toEqual(new Set(DEFAULT_WEIGHT_EFFECTS))
  })
})
