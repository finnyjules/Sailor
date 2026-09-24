import { describe, it, expect } from 'vitest'
import { writeFileSync } from 'node:fs'
import { applyLayoutToFrame, candidatesForFrame, planLayout } from '~/lib/frame/patterns/kit/plan'
import { boxOf, checkPlan } from '~/lib/frame/patterns/kit/check'
import { __registerLayoutForTest } from '~/lib/frame/patterns/layouts/catalog'
import { stTag } from '~/lib/frame/patterns/layouts/street'
import type { LayoutPlanArgs } from '~/lib/frame/patterns/kit/plan'
import { CATALOG, LAYOUTS, layoutsForStyle } from '~/lib/frame/patterns/layouts/catalog'
import { makeStubMeasure } from '~/lib/frame/patterns/kit/measure'
import { makeSheet } from '~/lib/frame/patterns/kit/sheet'
import type { El, Kind, LayoutDef, RoleKey } from '~/lib/frame/patterns/kit/types'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { StyleId } from '~/lib/frame/patterns/kit/styles'
import { FRAME_FORMATS } from '~/lib/frame/formats'
import { AD_LOGO, adFrameLayers, eventFrameLayers, frameLayers, galleryFrameLayers, palette } from './helpers/frameLayoutFixtures'

// ═══════════════════════ the style matrix (Stage 3, Tasks 5–7) ═══════════════════════
// Each style's layouts × six frames (three plain shapes and three formats) × {word, phrase,
// sentence} × {image, no image} × {with action, without} × {with logo, without}, through the real
// planner with the style asked for (its type, its rule 10, its visibility check and its rank all
// run there). For every layout the planner offers:
//   1. every candidate, planned again with `planLayout`, has no issues (every rule, 8–10 and the
//      style's own check included);
//   2. every placed text is at least the floor (the format's 9 px at its viewing width; the sheet's
//      INFO size on a plain frame);
// and 3: each combination offers at least 2 of the style's layouts with an image (1 without),
// unless it is listed in EXPECTED_THIN with its measured count and reason.
// Tasks 6–7 add Editorial and Street to STYLE_RUNS.

type Frame = { id: string; w: number; h: number; preset?: string }
const fmt = (id: string): Frame => { const f = FRAME_FORMATS.find(x => x.id === id)!; return { id, w: f.w, h: f.h, preset: id } }
const FRAMES: Frame[] = [
  { id: 'portrait', w: 895, h: 1280 },
  { id: 'square', w: 1080, h: 1080 },
  { id: 'landscape', w: 1280, h: 720 },
  fmt('meta-story'),
  fmt('meta-feed-4x5'),
  fmt('ad-300x250'),
]
const KINDS: Kind[] = ['word', 'phrase', 'sentence']

type Combo = { style: StyleId; frame: string; kind: Kind; image: boolean; action: boolean; logo: boolean }

/** A style under test: the Frame its content fixture builds. */
const STYLE_RUNS: { style: StyleId; layers: (kind: Kind, o: { image: boolean; action: boolean }) => ReturnType<typeof adFrameLayers> }[] = [
  { style: 'performance', layers: adFrameLayers },
  { style: 'editorial', layers: galleryFrameLayers },
  { style: 'street', layers: eventFrameLayers },
]

const floorOf = (c: Combo) => (c.image ? 2 : 1)
/** The fixture's text layers and the roles the planner reads them as. */
const ROLE_OF_ID: Record<string, RoleKey> = { t: 'title', d: 'details', dt: 'date', c: 'caption', a: 'action' }

// Every Performance layout but Strip is built on the product image (`needs.image`, the
// prototype's `{ image: true }`): with no image layer the product offers them only in image mode,
// with a stand-in. Strip is one row for wide formats (`wideOnly`): offered only when the sheet it
// composes on is wide (H < 70) — of these six frames only the 1280×720 landscape (H 56.3); the
// portrait is 143.0, the square 100, the 4:5 feed 125, the 300×250 banner 83.3 and the story's
// uncovered band 177.8 × (1 − 0.14 − 0.35) = 90.7.
const PERF_NO_IMAGE = 'no image: every Performance layout but Strip needs the image, and Strip is wide-only (this sheet is not wide: H ≥ 70)'
/** Combinations allowed under their floor. Each entry matches by the fields it gives and pins the
 *  count measured when it was written (`offered`), so a change either way is noticed. */
const EXPECTED_THIN: (Partial<Combo> & { offered: number; reason: string })[] = [
  ...['portrait', 'square', 'meta-story', 'meta-feed-4x5', 'ad-300x250'].map(frame =>
    ({ style: 'performance' as const, frame, image: false, offered: 0, reason: PERF_NO_IMAGE })),
  // With an image, the product visibility check (bands, cards and panels may hide at most 55% of
  // the visible image — 70% under 336 px of design width since Layout decisions Task 3; a fade
  // counts 0.35) is what thins these out: a logo adds a band at the top,
  // a button adds a row at the foot, and on a small or tall-and-covered frame the bands then hide
  // too much. Price tag (a half-page panel: always 50.0%) survives. The least-covered choice of
  // each refused layout, measured across every choice (all kinds unless named):
  // Story, action and logo — only 90.7 of its 177.8 height is seen: Offer 65.4–65.7%, Sticker
  // 66.5–69.9%, Card 55.8%, Centred 77.8–78.8%. Stage 4 Task 3 (ruling R7) adds the
  // platform's-own-button choice: its `cta: 'native'` candidates draw no button and so would
  // otherwise clear this frame's 55% limit, but ruling R11 (fix round 1) refuses a layout unless
  // a DRAWN candidate passes on its own — a native candidate never rescues an otherwise-thin
  // layout — so the Stage 3 count stays exactly the button-drawn measurement above: 1 (Price tag).
  // No longer thin since Stage 4 Task 5: Post-it (`needsContent: []`, the product under a note and
  // one foot band) is offered too — 2 layouts, the floor. The Stage 3 count is pinned below.
  // 300×250, logo only: Offer 69.5%, Sticker 55.9–58.6%, Card 56.4%, Centred 69.2–69.5% — of the
  // Stage 3 layouts only Price tag (50.0%) is offered. No longer thin since Stage 4 Task 4: this
  // Frame has a number, so Offer first (its image under the panel, no button band) is offered too
  // — 2 layouts, the floor. The Stage 3 layouts' own count here is unchanged (1).
  // 300×250, action only: Offer 56.5%, Sticker 64.2–67.0%, Card 55.6%, Centred 77.5–77.9% — of the
  // Stage 3 layouts only Price tag (50.0%). No longer thin since Stage 4 Task 5: Post-it is offered
  // too — 2 layouts, the floor. The Stage 3 count (1) is pinned below.
  // 300×250, action and logo: Offer 73.6%, Card 66.7%, Centred 88.6–88.9% hidden; Sticker's
  // "–30%" no longer fits a readable sticker; Price tag's half-page panel has no height left for
  // the title between the logo and the offer (fitted size −4.95, floor 3.00). Stage 4 Task 5: Post-it
  // (it draws no logo, as the prototype) is offered — 1, still under the floor; Stage 3's own: 0.
  // No longer thin since Layout decisions Task 3: a Frame under 336 px of design width may hide up
  // to 70% of its image, so Card (66.7–68.9% hidden) is offered beside Post-it — 2, the floor.
  // The small-format limit on 300×250 (measured on the phrase, every choice; Task 3 pins them
  // below): logo only, Offer 69.5–72.5% (2 of 8 choices pass), Sticker 55.9–61.8%, Card
  // 56.4–58.5%, Centred 69.2–71.7% (2 pass) — all four now offered; action only, Offer
  // 56.5–64.6%, Sticker 64.2–70.1% (6 pass), Card 55.6–57.8% now offered, Centred 77.5–80.0%
  // still refused; neither, Centred 58.1–60.6% now offered too.
]
const matches = (e: Partial<Combo>, c: Combo) =>
  (['style', 'frame', 'kind', 'image', 'action', 'logo'] as const).every(k => e[k] === undefined || e[k] === c[k])
const expectedThin = (c: Combo) => EXPECTED_THIN.find(e => matches(e, c))

const argsFor = (def: LayoutDef, f: Frame, c: Combo): Omit<LayoutPlanArgs, 'choice'> => {
  const run = STYLE_RUNS.find(r => r.style === c.style)!
  return {
    props: {
      sailor_localLayers: run.layers(c.kind, { image: c.image, action: c.action }),
      ...(f.preset ? { sailor_frame: { preset: f.preset } } : {}),
    },
    frameW: f.w, frameH: f.h, layoutId: def.id, palette, connectedSlots: [], measure: makeStubMeasure(),
    style: c.style, ...(c.logo ? { brandLogo: { ...AD_LOGO } } : {}),
  }
}

const combos: Combo[] = STYLE_RUNS.flatMap(({ style }) => FRAMES.flatMap(f => KINDS.flatMap(kind =>
  [false, true].flatMap(image => [false, true].flatMap(action => [false, true].map(logo =>
    ({ style, frame: f.id, kind, image, action, logo })))))))

const results = new Map<string, string[]>()
const keyOf = (c: Combo) => `${c.style}|${c.frame}|${c.kind}|${c.image ? 'image' : 'none'}|${c.action ? 'action' : '-'}|${c.logo ? 'logo' : '-'}`
let checked = 0

describe('style matrix — each style\'s layouts through the real planner', () => {
  it.each(combos.map(c => [`${c.style} · ${c.frame} · ${c.kind} · ${c.image ? 'image' : 'no image'} · ${c.action ? 'action' : 'no action'} · ${c.logo ? 'logo' : 'no logo'}`, c] as const))('%s', (_label, c) => {
    const f = FRAMES.find(x => x.id === c.frame)!
    const format = f.preset ? FRAME_FORMATS.find(x => x.id === f.preset)! : null
    const S = makeSheet({ frameW: f.w, frameH: f.h, measure: makeStubMeasure(), style: c.style, ...(format ? { format: { view: format.view, nc: format.nc } } : {}) })
    const floor = (format ? 900 / format.view! : S.INFO.size) - 0.01
    const offered: string[] = []
    for (const def of layoutsForStyle(c.style)) {
      const a = argsFor(def, f, c)
      const cands = candidatesForFrame(a)
      if (!cands.length) continue
      offered.push(def.id)
      // Ruling R11 (fix round 1): the platform's own button is an alternative, never a rescue —
      // a layout's candidates are never ALL `cta: 'native'`; at least one drawn one must pass on
      // its own for the layout to be offered at all.
      expect.soft(cands.some(cd => (cd.choice.cta ?? 'drawn') === 'drawn'), `${def.id}: every candidate is cta: 'native'`).toBe(true)
      // Ruling R11b (fix round 2): the FIRST candidate — what applies when the user simply picks
      // the layout — is always drawn (ruling R7's "Default: In the image"), on every
      // platform-button format with an action line, logo or no logo.
      if (format?.platformButton && c.action) {
        expect.soft((cands[0]!.choice.cta ?? 'drawn') === 'drawn', `${def.id}: first candidate is cta: 'native'`).toBe(true)
      }
      for (const cand of cands) {
        const label = `${def.id} ${JSON.stringify(cand.choice)}`
        const plan = planLayout({ ...a, choice: cand.choice })
        expect.soft(plan, label).not.toBeNull()
        // 1. every rule, the style's own check included.
        expect.soft(plan!.issues, label).toEqual([])
        expect.soft(plan!.format?.id ?? null, label).toBe(f.preset ?? null)
        // 2. the floor.
        for (const e of cand.out.els) {
          if (e.k !== 't' && e.k !== 'ring') continue
          expect.soft(e.size, `${e.role} size · ${label}`).toBeGreaterThanOrEqual(floor)
        }
        // A line the layout does not place is hidden (fix round 1); every line it places shows.
        const placed = new Set(cand.out.els.filter(e => e.k === 't' || e.k === 'ring').map(e => (e.role ?? '').replace(/\d+$/, '')))
        for (const [id, role] of Object.entries(ROLE_OF_ID)) {
          const layer = plan!.layers.find(l => l.id === id) as { visible?: boolean } | undefined
          if (!layer) continue
          const hidden = !placed.has(role) || !!plan!.format?.hidden.includes(role)
          expect.soft(layer.visible === false, `${id} (${role}) ${hidden ? 'not hidden' : 'hidden though placed'} · ${label}`).toBe(hidden)
        }
        expect.soft(plan!.notPlaced.map(n => n.role).every(r => !placed.has(r)), label).toBe(true)
        // The pieces the Frame has are the ones drawn: a logo only from the brand kit, a button
        // only for an action line.
        if (!c.logo) expect.soft(cand.out.els.some(e => e.k === 'logo'), `logo without a kit logo · ${label}`).toBe(false)
        if (!c.action) expect.soft(cand.out.els.some(e => e.k === 'btn'), `button without an action · ${label}`).toBe(false)
        checked++
      }
    }
    results.set(keyOf(c), offered)
    // 3. layouts offered.
    const thin = expectedThin(c)
    if (thin) {
      expect(offered.length, `EXPECTED_THIN (${thin.reason}): offered ${offered.join(', ')}`).toBe(thin.offered)
      expect(thin.offered, 'listed in EXPECTED_THIN but meets its floor').toBeLessThan(floorOf(c))
    } else {
      expect(offered.length, `below the floor of ${floorOf(c)}: offered ${offered.join(', ') || 'nothing'}`).toBeGreaterThanOrEqual(floorOf(c))
    }
  })

  it('checks a real number of candidates', () => {
    // eslint-disable-next-line no-console
    console.info(`[style matrix] ${combos.length} combinations, ${checked} candidates checked`)
    expect(checked).toBeGreaterThan(combos.length)
    if (process.env.STYLE_MATRIX_DUMP) writeFileSync(process.env.STYLE_MATRIX_DUMP, JSON.stringify({ checked, offered: Object.fromEntries(results) }, null, 1))
  })

  it('the combinations Stage 4 lifted: the Stage 3 layouts\' own counts are unchanged', () => {
    // Task 4 fix round 1: Offer first (Stage 4, `needsContent`) lifted 300×250 with a logo and no
    // action to the floor; Task 5's Post-it lifted the story with action and logo, and 300×250 with
    // action. Without the Stage 4 layouts each offers exactly what it did before.
    const stage4 = new Set(CATALOG.filter(l => l.needsContent).map(l => l.id))
    const PINS: [Partial<Combo>, string[]][] = [
      // Layout decisions Task 3: under 336 px of design width up to 70% of the image may be hidden
      // (measured percentages in EXPECTED_THIN's notes above) — 300×250 now offers these Stage 3
      // layouts. The story (1080 px) keeps the 55% limit, so its count is unchanged.
      [{ frame: 'ad-300x250', action: false, logo: false }, ['perfOffer', 'perfSticker', 'perfPriceTag', 'perfCard', 'perfCentred']],
      [{ frame: 'ad-300x250', action: false, logo: true }, ['perfOffer', 'perfSticker', 'perfPriceTag', 'perfCard', 'perfCentred']],
      [{ frame: 'ad-300x250', action: true, logo: false }, ['perfOffer', 'perfSticker', 'perfPriceTag', 'perfCard']],
      [{ frame: 'ad-300x250', action: true, logo: true }, ['perfCard']],
      [{ frame: 'meta-story', action: true, logo: true }, ['perfPriceTag']],
    ]
    for (const [c, stage3] of PINS) for (const kind of KINDS) {
      const offered = results.get(keyOf({ style: 'performance', kind, image: true, ...c } as Combo))
      expect(offered, `${c.frame} ${kind}`).toBeDefined()
      expect(offered!.filter(id => !stage4.has(id)), `${JSON.stringify(c)} ${kind}`).toEqual(stage3)
    }
  })

  it('every EXPECTED_THIN entry names a frame of the matrix', () => {
    for (const e of EXPECTED_THIN) expect(FRAMES.some(f => f.id === e.frame), e.frame).toBe(true)
  })
})

describe('styles filter the library (ruling S4)', () => {
  const PERF = ['perfOffer', 'perfSticker', 'perfPriceTag', 'perfCard', 'perfCentred', 'perfStrip']
  // Stage 4 (Tasks 4–5): the Performance ad layouts, appended after Street (seed order).
  const ADS = ['perfOfferFirst', 'perfStat', 'perfReview', 'perfVersus',
    'perfBeforeAfter', 'perfCallouts', 'perfListicle', 'perfNotes', 'perfPostit']
  const ED = ['edCover', 'edFramed', 'edQuiet', 'edDiptych']
  const ST = ['stFill', 'stTag', 'stDrop', 'stRepeat', 'stStrip']

  it('the catalog is the 42 Swiss layouts, then Performance, Editorial and Street (seed order)', () => {
    expect(CATALOG.slice(0, 42)).toEqual(LAYOUTS)
    expect(LAYOUTS).toHaveLength(42)
    expect(CATALOG.slice(42).map(l => l.id)).toEqual([...PERF, ...ED, ...ST, ...ADS])
    expect(layoutsForStyle('performance').map(l => l.id)).toEqual([...PERF, ...ADS])
    expect(layoutsForStyle('editorial').map(l => l.id)).toEqual(ED)
    expect(layoutsForStyle('street').map(l => l.id)).toEqual(ST)
    expect(layoutsForStyle('swiss')).toBe(LAYOUTS)
    expect(layoutsForStyle()).toBe(LAYOUTS)
    for (const l of CATALOG.slice(42, 48)) {
      expect(l.style, l.id).toBe('performance')
      expect(l.oneLineFirst, l.id).toBe(true)
    }
    for (const l of CATALOG.slice(48, 52)) expect(l.style, l.id).toBe('editorial')
    for (const l of CATALOG.slice(52, 57)) expect(l.style, l.id).toBe('street')
    expect(CATALOG.slice(42).filter(l => l.wideOnly).map(l => l.id)).toEqual(['perfStrip', 'stStrip'])
  })

  const plain = { frameW: 1280, frameH: 720, palette, connectedSlots: [], measure: makeStubMeasure() }
  const withImage = (kind: Kind) => ({ sailor_localLayers: adFrameLayers(kind, { image: true, action: true }) })

  it('a Performance layout is never offered to Swiss (no style, or \'swiss\')', () => {
    for (const id of PERF) for (const style of [undefined, 'swiss'] as const) {
      expect(candidatesForFrame({ ...plain, props: withImage('phrase'), layoutId: id, ...(style ? { style } : {}) }), `${id} ${style}`).toEqual([])
    }
    // …while the same Frame, asked for Performance, is offered them.
    expect(candidatesForFrame({ ...plain, props: withImage('phrase'), layoutId: 'perfOffer', style: 'performance' }).length).toBeGreaterThan(0)
  })

  it('a Swiss layout is never offered to Performance', () => {
    for (const def of LAYOUTS) {
      const props = { sailor_localLayers: frameLayers('phrase', { image: true, shape: !!def.needs?.shape }) }
      expect(candidatesForFrame({ ...plain, props, layoutId: def.id, style: 'performance' }), def.id).toEqual([])
    }
  })

  it('Strip is offered only on a wide sheet', () => {
    const at = (w: number, h: number) => candidatesForFrame({ ...plain, frameW: w, frameH: h, props: withImage('phrase'), layoutId: 'perfStrip', style: 'performance' }).length
    expect(at(1280, 720)).toBeGreaterThan(0)            // H 56.3
    expect(at(1080, 1080)).toBe(0)                      // H 100
    expect(at(895, 1280)).toBe(0)                       // H 143
  })

  it('a style\'s layouts are offered only to that style', () => {
    for (const id of [...ED, ...ST]) {
      // Strip beside a side image has no room for the title with a button (see the report): no image.
      const props = { sailor_localLayers: eventFrameLayers('phrase', { image: id !== 'stStrip', action: true }) }
      const own = ED.includes(id) ? 'editorial' : 'street'
      for (const style of [undefined, 'swiss', 'performance', 'editorial', 'street'] as const) {
        if (style === own) continue
        expect(candidatesForFrame({ ...plain, props, layoutId: id, ...(style ? { style } : {}) }), `${id} ${style}`).toEqual([])
      }
      expect(candidatesForFrame({ ...plain, props, layoutId: id, style: own }).length, id).toBeGreaterThan(0)
    }
  })

  it('Street Strip is offered only on a wide sheet', () => {
    const props = { sailor_localLayers: eventFrameLayers('phrase', { image: false, action: true }) }
    const at = (w: number, h: number) => candidatesForFrame({ ...plain, frameW: w, frameH: h, props, layoutId: 'stStrip', style: 'street' }).length
    expect(at(1280, 720)).toBeGreaterThan(0)            // H 56.3
    expect(at(1080, 1080)).toBe(0)                      // H 100
    expect(at(895, 1280)).toBe(0)                       // H 143
  })
})

describe('the cta axis is offered in every style that draws a button (Task 2)', () => {
  const metaFeed = FRAME_FORMATS.find(f => f.id === 'meta-feed-4x5')!
  const platform = { frameW: metaFeed.w, frameH: metaFeed.h, palette, connectedSlots: [], measure: makeStubMeasure() }

  it('Editorial and Street offer both the drawn and the platform\'s own button on a platform format with an action line', () => {
    const cases: [StyleId, string, LocalLayer[]][] = [
      ['editorial', 'edCover', galleryFrameLayers('phrase', { image: true, action: true })],
      ['street', 'stFill', eventFrameLayers('phrase', { image: true, action: true })],
    ]
    for (const [style, layoutId, layers] of cases) {
      const a = { ...platform, style, layoutId, props: { sailor_localLayers: layers, sailor_frame: { preset: 'meta-feed-4x5' } } }
      const cands = candidatesForFrame(a)
      expect(cands.length, `${style} ${layoutId}`).toBeGreaterThan(0)
      expect(cands.some(c => c.choice.cta === 'native'), `${style} ${layoutId}: no native candidate offered`).toBe(true)
      expect(cands.some(c => (c.choice.cta ?? 'drawn') === 'drawn'), `${style} ${layoutId}: no drawn candidate offered`).toBe(true)
    }
  })

  it('Swiss never offers the cta axis, even on a platform format with an action line (it hides the action line instead)', () => {
    const a = {
      ...platform, layoutId: 'statement',
      props: { sailor_localLayers: adFrameLayers('phrase', { image: true, action: true }), sailor_frame: { preset: 'meta-feed-4x5' } },
    }
    const cands = candidatesForFrame(a)
    expect(cands.length).toBeGreaterThan(0)
    expect(cands.every(c => !('cta' in c.choice))).toBe(true)
  })

  it('a non-platform format with the same action line still offers no cta axis', () => {
    const a = {
      frameW: 895, frameH: 1280, palette, connectedSlots: [], measure: makeStubMeasure(),
      style: 'editorial' as const, layoutId: 'edCover',
      props: { sailor_localLayers: galleryFrameLayers('phrase', { image: true, action: true }) },
    }
    const cands = candidatesForFrame(a)
    expect(cands.length).toBeGreaterThan(0)
    expect(cands.every(c => !('cta' in c.choice))).toBe(true)
  })

  it('a platform format with no action line still offers no cta axis', () => {
    const a = {
      ...platform, style: 'street' as const, layoutId: 'stFill',
      props: { sailor_localLayers: eventFrameLayers('phrase', { image: true, action: false }), sailor_frame: { preset: 'meta-feed-4x5' } },
    }
    const cands = candidatesForFrame(a)
    expect(cands.length).toBeGreaterThan(0)
    expect(cands.every(c => !('cta' in c.choice))).toBe(true)
  })
})

describe('the Performance findings, pinned', () => {
  const S300 = { frameW: 300, frameH: 250, palette, connectedSlots: [], measure: makeStubMeasure(), style: 'performance' as const }
  const props300 = (o: { action: boolean }) => ({ sailor_localLayers: adFrameLayers('word', { image: true, ...o }), sailor_frame: { preset: 'ad-300x250' } })

  it('Price tag on a 300×250 banner: the product name wraps to two lines and still clears the headline', () => {
    const cands = candidatesForFrame({ ...S300, props: props300({ action: false }), layoutId: 'perfPriceTag' })
    expect(cands.length).toBeGreaterThan(0)
    const S = makeSheet({ frameW: 300, frameH: 250, measure: makeStubMeasure(), style: 'performance', format: { view: 300 } })
    for (const cand of cands) {
      const details = cand.out.els.find(e => e.k === 't' && e.role === 'details')!
      const title = cand.out.els.find(e => e.k === 't' && e.role === 'title')!
      expect(details.k === 't' && S.countLines(details.s, details.w ?? 60, S.SECOND, details.size), 'the half-page column wraps it').toBe(2)
      // Before the fix the offer stepped up one line and the headline sat on the second one.
      const db = (details.k === 't' && details.base) as number
      const tb = (title.k === 't' && title.base) as number
      expect(tb).toBeLessThan(db - (details.k === 't' ? S.blockH(2, details.size, details.lh) : 0))
    }
  })

  it('Card on a square: the card is padded by the margin, so the offer is offered with a button', () => {
    const a = { frameW: 1080, frameH: 1080, palette, connectedSlots: [], measure: makeStubMeasure(), style: 'performance' as const,
      props: { sailor_localLayers: adFrameLayers('word', { image: true, action: true }) }, layoutId: 'perfCard' }
    expect(candidatesForFrame(a).length).toBeGreaterThan(0)
  })
})

describe('lines a style layout does not place are hidden (fix round 1)', () => {
  const wide = { frameW: 1280, frameH: 720, palette, connectedSlots: [], measure: makeStubMeasure() }
  const editorInto = (sink: { layers: LocalLayer[] }) => ({
    recordHistory() {}, writeOrder() {}, writeGroups() {},
    commit(next: LocalLayer[]) { sink.layers = next },
  })
  const vis = (layers: LocalLayer[], id: string) => (layers.find(l => l.id === id) as { visible?: boolean }).visible

  it('Strip on a wide Frame hides the details and the fine print; a later Swiss apply shows them again', () => {
    const layers = adFrameLayers('phrase', { image: true, action: true })
    const a = { ...wide, props: { sailor_localLayers: layers }, layoutId: 'perfStrip', style: 'performance' as const }
    const cand = candidatesForFrame(a)[0]!
    const plan = planLayout({ ...a, choice: cand.choice })!
    expect(plan.issues).toEqual([])
    expect(plan.format).toBeNull()
    expect(plan.notPlaced).toEqual([
      { role: 'details', text: 'Halden Trail 2' },
      { role: 'caption', text: 'Offer ends 12 October. While stocks last.' },
    ])
    const sink = { layers }
    expect(applyLayoutToFrame({ ...a, choice: cand.choice, editor: editorInto(sink) }).ok).toBe(true)
    expect(vis(sink.layers, 'd')).toBe(false)
    expect(vis(sink.layers, 'c')).toBe(false)
    for (const id of ['t', 'dt', 'a']) expect(vis(sink.layers, id), id).not.toBe(false)

    // Swiss places the details and the caption again: their layers come back. It never places the
    // action line: that one is hidden and quoted instead (ruling R9).
    const s = { ...wide, props: { sailor_localLayers: sink.layers }, layoutId: 'statement' }
    const swissCand = candidatesForFrame(s)[0]!
    const swiss = planLayout({ ...s, choice: swissCand.choice })!
    expect(swiss.notPlaced).toEqual([{ role: 'action', text: 'Shop now' }])
    expect(applyLayoutToFrame({ ...s, choice: swissCand.choice, editor: editorInto(sink) }).ok).toBe(true)
    expect(vis(sink.layers, 'd')).not.toBe(false)
    expect(vis(sink.layers, 'c')).not.toBe(false)
  })

  it('a Performance layout that places every line hides nothing', () => {
    const a = { ...wide, frameW: 895, frameH: 1280, props: { sailor_localLayers: adFrameLayers('phrase', { image: true, action: true }) }, layoutId: 'perfOffer', style: 'performance' as const }
    const cand = candidatesForFrame(a)[0]!
    const plan = planLayout({ ...a, choice: cand.choice })!
    expect(plan.issues).toEqual([])
    expect(plan.notPlaced).toEqual([])
    for (const id of ['t', 'd', 'dt', 'c', 'a']) expect(vis(plan.layers, id), id).not.toBe(false)
  })

  it('Swiss hides and quotes the action line only (ruling R9); a later Performance apply shows it again', () => {
    const layers = adFrameLayers('phrase', { image: true, action: true })
    const a = { ...wide, props: { sailor_localLayers: layers }, layoutId: 'statement' }
    const cand = candidatesForFrame(a)[0]!
    const plan = planLayout({ ...a, choice: cand.choice })!
    expect(plan.notPlaced).toEqual([{ role: 'action', text: 'Shop now' }])
    expect(vis(plan.layers, 'a')).toBe(false)
    for (const id of ['t', 'd', 'dt', 'c']) expect(vis(plan.layers, id), id).not.toBe(false)
    const sink = { layers }
    expect(applyLayoutToFrame({ ...a, choice: cand.choice, editor: editorInto(sink) }).ok).toBe(true)
    expect(vis(sink.layers, 'a')).toBe(false)
    // Performance places the action on its button: the line comes back.
    const p = { ...wide, frameW: 895, frameH: 1280, props: { sailor_localLayers: sink.layers }, layoutId: 'perfOffer', style: 'performance' as const }
    const pc = candidatesForFrame(p)[0]!
    expect(applyLayoutToFrame({ ...p, choice: pc.choice, editor: editorInto(sink) }).ok).toBe(true)
    expect(vis(sink.layers, 'a')).not.toBe(false)
  })

  it('Swiss hides nothing on a Frame without an action line', () => {
    const a = { ...wide, props: { sailor_localLayers: adFrameLayers('phrase', { image: false, action: false }) }, layoutId: 'statement' }
    const plan = planLayout({ ...a, choice: candidatesForFrame(a)[0]!.choice })!
    expect(plan.notPlaced).toEqual([])
    for (const l of plan.layers) if (l.kind === 'text') expect((l as { visible?: boolean }).visible, l.id).not.toBe(false)
  })
})


describe('the title drawn as several lines is never hidden (ruling R4)', () => {
  const at = (layoutId: string, kind: Kind, image: boolean) => {
    const a = { frameW: 895, frameH: 1280, palette, connectedSlots: [], measure: makeStubMeasure(), style: 'street' as const,
      props: { sailor_localLayers: eventFrameLayers(kind, { image, action: true }) }, layoutId }
    return { a, cands: candidatesForFrame(a) }
  }
  const titleEls = (els: El[]) => els.filter(e => e.k === 't' && /^title\d*$/.test(e.role ?? ''))

  it.each([['stFill', 'phrase'], ['stFill', 'sentence'], ['stTag', 'sentence'], ['stRepeat', 'phrase'], ['stRepeat', 'word']] as const)('%s (%s): every choice keeps the title layer shown, as ONE layer', (id, kind) => {
    const { a, cands } = at(id, kind, id === 'stTag')
    expect(cands.length).toBeGreaterThan(0)
    let several = 0
    for (const cand of cands) {
      const plan = planLayout({ ...a, choice: cand.choice })!
      expect(plan.issues).toEqual([])
      expect(plan.notPlaced.map(n => n.role)).not.toContain('title')
      const title = plan.layers.find(l => l.id === 't') as { visible?: boolean; runs?: unknown[] }
      expect(title.visible, JSON.stringify(cand.choice)).not.toBe(false)
      // Several title elements (title, title1, …) become runs of the one title layer — no new text layers.
      const n = titleEls(cand.out.els).length
      if (n > 1) { several++; expect(title.runs?.length ?? 0).toBeGreaterThanOrEqual(n) }
      expect(plan.layers.filter(l => l.kind === 'text').length).toBe(5)
    }
    expect(several, 'some choice draws the title as several elements').toBeGreaterThan(0)
  })

  it('Editorial places every line: nothing hidden', () => {
    for (const id of ['edCover', 'edFramed', 'edQuiet', 'edDiptych']) {
      const a = { frameW: 895, frameH: 1280, palette, connectedSlots: [], measure: makeStubMeasure(), style: 'editorial' as const,
        props: { sailor_localLayers: galleryFrameLayers('sentence', { image: true, action: true }) }, layoutId: id }
      const plan = planLayout({ ...a, choice: candidatesForFrame(a)[0]!.choice })!
      expect(plan.notPlaced, id).toEqual([])
      for (const l of plan.layers) if (l.kind === 'text') expect((l as { visible?: boolean }).visible, `${id} ${l.id}`).not.toBe(false)
    }
  })
})

describe('the Editorial and Street findings, pinned', () => {
  const base = { frameW: 895, frameH: 1280, palette, connectedSlots: [], measure: makeStubMeasure() }

  it('Editorial\'s action is a link: the user\'s text underlined, no button shape (ruling R3)', () => {
    const a = { ...base, style: 'editorial' as const, props: { sailor_localLayers: galleryFrameLayers('phrase', { image: true, action: true }) }, layoutId: 'edCover' }
    const cand = candidatesForFrame(a)[0]!
    expect(cand.out.els.find(e => e.k === 'btn')).toMatchObject({ shape: 'link' })
    const plan = planLayout({ ...a, choice: cand.choice })!
    expect(plan.issues).toEqual([])
    expect(plan.layers.some(l => (l as { owner?: { key: string } }).owner?.key.startsWith('button'))).toBe(false)
    expect((plan.layers.find(l => l.id === 'a') as { underline?: boolean }).underline).toBe(true)
  })

  it('Street\'s tag holds the user\'s own number: the date layer, rotated on an owned accent rect', () => {
    const a = { ...base, style: 'street' as const, props: { sailor_localLayers: eventFrameLayers('phrase', { image: false, action: true }) }, layoutId: 'stFill' }
    const cand = candidatesForFrame(a)[0]!
    const tagText = cand.out.els.find(e => e.k === 't' && e.role === 'date')!
    expect(tagText).toMatchObject({ s: 'Sat 4.10., 18–23h', inside: 'tag', origin: 'center' })
    expect(tagText.k === 't' && tagText.rot).toBe(-7)
    const plan = planLayout({ ...a, choice: cand.choice })!
    expect(plan.issues).toEqual([])
    expect((plan.layers.find(l => l.id === 'dt') as { rotation: number }).rotation).toBe(-7)
    expect(plan.layers.some(l => (l as { owner?: { key: string } }).owner?.key === 'tag-0')).toBe(true)
    // The tag holds the number; the details go in the foot with the fine print (ruling R10),
    // right-aligned in the same column, above it.
    expect(plan.notPlaced).toEqual([])
    const det = cand.out.els.find(e => e.k === 't' && e.role === 'details')!
    const cap = cand.out.els.find(e => e.k === 't' && e.role === 'caption')!
    expect(det).toMatchObject({ s: 'Mara Lind and guests', align: 'right', x: (cap as { x: number }).x, w: (cap as { w: number }).w })
    const S = makeSheet({ frameW: 895, frameH: 1280, measure: makeStubMeasure(), style: 'street' })
    expect(boxOf(det, S)!.y1).toBeLessThan(boxOf(cap, S)!.y0)
    expect((plan.layers.find(l => l.id === 'd') as { visible?: boolean }).visible).not.toBe(false)
  })

  it('Street (ruling R10): the details stay out where the foot has no room — Strip has no foot', () => {
    const a = { ...base, frameW: 1280, frameH: 720, style: 'street' as const, props: { sailor_localLayers: eventFrameLayers('phrase', { image: false, action: true }) }, layoutId: 'stStrip' }
    const plan = planLayout({ ...a, choice: candidatesForFrame(a)[0]!.choice })!
    expect(plan.issues).toEqual([])
    expect(plan.notPlaced.map(n => n.role)).toContain('details')
  })

  it('Street Tag (ruling S5): the title and the fine print sit on a band — the prototype set them straight on the image', () => {
    const props = { sailor_localLayers: eventFrameLayers('phrase', { image: true, action: true }) }
    const a = { ...base, style: 'street' as const, props, layoutId: 'stTag' }
    const cands = candidatesForFrame(a)
    expect(cands.length).toBeGreaterThan(0)
    for (const cand of cands) {
      const band = cand.out.els.find(e => e.k === 'band')!
      const title = cand.out.els.find(e => e.k === 't' && e.role === 'title')!
      expect(band.k === 'band' && title.k === 't' && band.y + band.h * (1 - band.solid) <= title.top!, 'the band is solid from the title\'s cap line down').toBe(true)
    }
    // The prototype's geometry — the same layout without the band — fails rule 10.
    const proto: LayoutDef = { ...stTag, id: 'protoStTag', fn: (S, ctx) => { const out = stTag.fn(S, ctx); return { ...out, els: out.els.filter(e => e.k !== 'band') } } }
    const undo = __registerLayoutForTest(proto)
    try {
      const plan = planLayout({ ...a, layoutId: 'protoStTag', choice: cands[0]!.choice })!
      expect(plan.issues).toContain('title: sits on the raw image')
      expect(plan.issues).toContain('caption: sits on the raw image')
    } finally { undo() }
  })

  it('Street Repeat (ruling S5): the real title never overlaps the image; the image sits above it', () => {
    for (const [w, h] of [[895, 1280], [1080, 1080], [1080, 1920]]) {
      const a = { ...base, frameW: w, frameH: h, style: 'street' as const, props: { sailor_localLayers: eventFrameLayers('phrase', { image: true, action: true }) }, layoutId: 'stRepeat' }
      const S = makeSheet({ frameW: w, frameH: h, measure: makeStubMeasure(), style: 'street' })
      for (const cand of candidatesForFrame(a)) {
        const photo = cand.out.els.find(e => e.k === 'p')
        const title = cand.out.els.find(e => e.k === 't' && e.role === 'title')!
        if (!photo) continue
        const pb = boxOf(photo, S)!, tb = boxOf(title, S)!
        expect(pb.y1, `${w}×${h}`).toBeLessThan(tb.y0)
        // No repeat crosses the image or the real title.
        for (const e of cand.out.els) {
          if (e.k !== 't' || !/^title\d+$/.test(e.role ?? '')) continue
          const b = boxOf(e, S)!
          expect(b.y1 <= pb.y0 || b.y0 >= pb.y1, `${e.role} vs image`).toBe(true)
          expect(b.y1 <= tb.y0 || b.y0 >= tb.y1, `${e.role} vs title`).toBe(true)
        }
      }
    }
  })
})

describe('rule 6 rounds (ruling R5)', () => {
  const S = makeSheet({ frameW: 1080, frameH: 1080, measure: makeStubMeasure(), style: 'performance' })
  const at = (pad: number) => {
    const t = S.info('Offer ends', { x: 0, top: 0, role: 'caption' })
    const b = boxOf(t, S)!
    const panel: El = { k: 'r', x: b.x0 - pad, y: b.y0 - pad, w: b.x1 - b.x0 + 2 * pad, h: b.y1 - b.y0 + 2 * pad, role: 'panel', color: 'field', ok: true }
    const shifted = { ...t, x: t.x + 20, top: 20 }
    const p = { ...panel, x: panel.x + 20, y: panel.y + 20 } as El
    return checkPlan([p, shifted], S)
  }
  it('a pad of exactly the minimum passes; a hair less still fails', () => {
    const min = 0.9 * S.M
    expect(at(min)).toEqual([])
    expect(at(min - 1e-4)).toEqual(['too close to the edge of its panel'])
  })
})
