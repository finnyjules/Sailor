import { describe, it, expect } from 'vitest'
import { candidatesForFrame, planLayout } from '~/lib/frame/patterns/kit/plan'
import type { LayoutPlanArgs } from '~/lib/frame/patterns/kit/plan'
import { LAYOUTS } from '~/lib/frame/patterns/layouts/catalog'
import { makeStubMeasure } from '~/lib/frame/patterns/kit/measure'
import type { El, Kind, LayoutDef } from '~/lib/frame/patterns/kit/types'
import { makeSheet } from '~/lib/frame/patterns/kit/sheet'
import { boxOf } from '~/lib/frame/patterns/kit/check'
import { TEXTS, frameLayers, palette } from './helpers/frameLayoutFixtures'

// ═══════════════════════ the layout matrix (spec §10) ═══════════════════════
// Every layout in the catalog × every kind it fits × {image, no image} × four frame shapes.
// Each combination runs through `candidatesForFrame` — the planner's own run + check, exactly
// as the product applies it (wide-frame side image and Ruling R8 included) — and every
// candidate it returns is planned again with `planLayout` and must have no issues (which
// includes the layout's premise). A combination with NO candidate fails, unless it is listed
// in EXPECTED_EMPTY with a concrete reason. Tasks 10–12 extend this file by adding layouts to
// the catalog; the matrix picks them up by itself.

const FRAMES: [number, number][] = [[895, 1280], [1080, 1080], [1280, 720], [1280, 400]]

type Combo = { id: string; kind: Kind; image: boolean; w: number; h: number }

/** Combinations allowed to have no candidate. Each entry matches by the fields it gives. */
const EXPECTED_EMPTY: (Partial<Combo> & { reason: string })[] = [
  { id: 'photoBehind', image: false, reason: 'needs an image and the frame has none (the product shows it only in image mode, with a stand-in)' },
  { id: 'fullBleed', image: false, reason: 'needs an image and the frame has none (the product shows it only in image mode, with a stand-in)' },
  { id: 'split', image: false, reason: 'needs an image and the frame has none (the product shows it only in image mode, with a stand-in)' },
  // Task 12: every image-led layout (the prototype's `defNew`) and three of the overlap family
  // need an image, for the same reason.
  ...(['plate', 'panel', 'sideSplit', 'cross', 'overlap', 'stamp', 'column', 'rising', 'behindPhoto', 'collage', 'label'] as const)
    .map(id => ({ id, image: false, reason: 'needs an image and the frame has none (the product shows it only in image mode, with a stand-in)' })),
  // Run-off's promise is a title that runs off the page. On a 1280×400 banner with no image the
  // title is height-bound (baseline row 10/12, cap top no higher than row 1, details and foot
  // below): "Echoes" fits at size 22.1 and its ink ends at 68 of 100; the sentence needs 2–4
  // lines and ends at 39. No arrangement can reach the edge, so the layout rightly refuses.
  // (With an image the side image takes the right 38% and the title runs under it — Ruling R8.)
  // "Weather Report" is long enough on one line, so the phrase still has candidates here.
  { id: 'runoff', kind: 'word', image: false, w: 1280, h: 400, reason: 'banner, no image: the height-bound one-word title cannot reach the right edge (ink ends at 68/100)' },
  { id: 'runoff', kind: 'sentence', image: false, w: 1280, h: 400, reason: 'banner, no image: a 2–4-line title is height-bound far short of the right edge (ink ends at 39/100)' },
  // Behind the image's promise is a title that passes behind the image. On a 1280×400 banner the
  // image is a centred 15.8 × 19.8 block (x 42.1–57.9) and the title's size is capped by the
  // image's height (0.8 h / its cap height), so a one-word title ends at 35.6 and a 2–4-line
  // sentence at 13.4–38.4: none reaches the image, and the layout rightly refuses. The phrase
  // ("Weather Report" on one line) is wide enough and still passes.
  { id: 'behindPhoto', kind: 'word', image: true, w: 1280, h: 400, reason: 'banner: the height-capped one-word title ends at 35.6, short of the image at 42.1' },
  { id: 'behindPhoto', kind: 'sentence', image: true, w: 1280, h: 400, reason: 'banner: every height-capped line break of the sentence ends at 38.4 or less, short of the image at 42.1' },
]
const matches = (e: Partial<Combo>, c: Combo) =>
  (Object.keys(e) as (keyof Combo | 'reason')[]).every(k => k === 'reason' || e[k as keyof Combo] === c[k as keyof Combo])
const expectedEmpty = (c: Combo) => EXPECTED_EMPTY.find(e => matches(e, c))

const baseArgs = (def: LayoutDef, c: Combo): Omit<LayoutPlanArgs, 'choice'> => ({
  props: { sailor_localLayers: frameLayers(c.kind, { image: c.image, shape: !!def.needs?.shape }) },
  frameW: c.w, frameH: c.h, layoutId: def.id, palette, connectedSlots: [], measure: makeStubMeasure(),
})

const combos: Combo[] = LAYOUTS.flatMap(def => def.fits.flatMap(kind =>
  [false, true].flatMap(image => FRAMES.map(([w, h]) => ({ id: def.id, kind, image, w, h })))))

const TEXT_ROLES = ['title', 'details', 'date', 'caption'] as const
let checked = 0

describe('layout matrix — every candidate passes the checker and keeps its premise', () => {
  it.each(combos.map(c => [`${c.id} · ${c.kind} · ${c.image ? 'image' : 'no image'} · ${c.w}×${c.h}`, c] as const))('%s', (_label, c) => {
    const def = LAYOUTS.find(l => l.id === c.id)!
    const a = baseArgs(def, c)
    const cands = candidatesForFrame(a)
    const allowed = expectedEmpty(c)
    if (allowed) {
      expect(cands, `listed in EXPECTED_EMPTY (${allowed.reason}) but has candidates`).toEqual([])
      return
    }
    expect(cands.length, 'no valid candidate').toBeGreaterThan(0)
    for (const cand of cands) {
      const plan = planLayout({ ...a, choice: cand.choice })
      expect(plan, JSON.stringify(cand.choice)).not.toBeNull()
      expect(plan!.issues, JSON.stringify(cand.choice)).toEqual([])
      // Nothing the user wrote is dropped: every text role on the frame is placed by the layout.
      // (Ring sets the title on a `ring` element, which the planner turns into a text path.)
      const roles = new Set(cand.out.els.map(e => (e.k === 't' || e.k === 'ring' ? (e.role ?? '').replace(/\d+$/, '') : '')))
      for (const r of TEXT_ROLES) expect(roles.has(r), `${r} not placed (${JSON.stringify(cand.choice)})`).toBe(true)
      checked++
    }
  })

  it('covers every layout and checks a real number of candidates', () => {
    expect(new Set(combos.map(c => c.id))).toEqual(new Set(LAYOUTS.map(l => l.id)))
    // eslint-disable-next-line no-console
    console.info(`[layout matrix] ${combos.length} combinations, ${checked} candidates checked`)
    expect(checked).toBeGreaterThan(combos.length)
  })
})

describe('the catalog', () => {
  it('keeps the prototype order (Ruling R9: the index seeds each layout\'s randomness)', () => {
    const PROTOTYPE_ORDER = [
      'runoff', 'statement', 'index', 'shapeCounter', 'photoBehind', 'fullBleed', 'tilt', 'bottomHeavy', 'fourCorners',
      'spacedLines', 'ragged', 'edges', 'staircase', 'block', 'knockout', 'shapeBleed', 'badge', 'split', 'diagonal',
      'wall', 'scatter', 'cascade', 'ring', 'cells', 'kicker', 'sidebar', 'footer',
      'plate', 'panel', 'sideSplit', 'cross', 'overlap', 'stamp', 'column', 'rising',
      'overprint', 'dateBehind', 'tightStack', 'behindPhoto', 'collage', 'label', 'ghost',
    ]
    // All 42 are ported: the catalog IS the prototype order, so every seed is final.
    expect(LAYOUTS.map(l => l.id)).toEqual(PROTOTYPE_ORDER)
  })

  it('every EXPECTED_EMPTY entry names a layout in the catalog', () => {
    for (const e of EXPECTED_EMPTY) expect(LAYOUTS.some(l => l.id === e.id), e.id).toBe(true)
  })
})

describe('shape and letter layouts on a real frame', () => {
  it.each(FRAMES)('Ring: the title survives the planner as a text path round the ring (%i×%i)', (w, h) => {
    const def = LAYOUTS.find(l => l.id === 'ring')!
    for (const image of [false, true]) {
      const a = baseArgs(def, { id: 'ring', kind: 'word', image, w, h })
      const cand = candidatesForFrame(a)[0]!
      const ringEl = cand.out.els.find(e => e.k === 'ring')!
      const plan = planLayout({ ...a, choice: cand.choice })!
      const title = plan.layers.find(l => l.id === 't') as { path?: { follow: string; radius: number; start: number }; fontSize: number; x: number; y: number }
      expect(title.path).toMatchObject({ follow: 'circle', start: 0.5 })
      expect(ringEl.k === 'ring' && title.path!.radius).toBeCloseTo(ringEl.k === 'ring' ? ringEl.R / 100 : 0, 6)
      expect(title.fontSize).toBeGreaterThan(0)
    }
  })

  it.each(FRAMES)('Badge: the date\'s real ink sits inside the badge, never spilling past it (%i×%i)', (w, h) => {
    const def = LAYOUTS.find(l => l.id === 'badge')!
    const m = makeStubMeasure()
    for (const kind of def.fits) {
      for (const image of [false, true]) {
        const a = baseArgs(def, { id: 'badge', kind, image, w, h })
        const cands = candidatesForFrame(a)
        expect(cands.length).toBeGreaterThan(0)
        for (const cand of cands) {
          const date = cand.out.els.find(e => e.k === 't' && e.role === 'date')
          const circle = cand.out.els.find(e => e.k === 'c' && e.role === 'shape')
          if (date?.k !== 't' || circle?.k !== 'c') throw new Error('badge lost its date or its circle')
          expect(date.inside).toBe('shape')
          // The unclipped ink: the date never breaks (no spaces), so it is one line of its full width.
          const ink = m.w100(date.s, 'date', date.ls) * date.size / 100
          const cx = date.x + date.w! / 2
          const top = date.top!, bottom = top + 0.7 * date.size
          for (const [x, y] of [[cx - ink / 2, top], [cx + ink / 2, top], [cx - ink / 2, bottom], [cx + ink / 2, bottom]] as const) {
            expect(Math.hypot(x - circle.cx, y - circle.cy)).toBeLessThanOrEqual(circle.r * 0.97)
          }
        }
      }
    }
  })

  it.each(FRAMES)('Knockout: the band moves the user\'s own shape layer, no owned band (%i×%i)', (w, h) => {
    const def = LAYOUTS.find(l => l.id === 'knockout')!
    for (const image of [false, true]) {
      const a = baseArgs(def, { id: 'knockout', kind: 'phrase', image, w, h })
      const cand = candidatesForFrame(a)[0]!
      const band = cand.out.els.find(e => e.k === 'r' && e.role === 'shape')
      if (band?.k !== 'r') throw new Error('knockout lost its band')
      const plan = planLayout({ ...a, choice: cand.choice })!
      const shp = plan.layers.find(l => l.id === 'shp') as { x: number; y: number; w: number; h: number }
      const H = 100 * h / w
      expect(shp.x).toBeCloseTo((band.x + band.w / 2) / 100, 9)
      expect(shp.y).toBeCloseTo((band.y + band.h / 2) / H, 9)
      expect(shp.w).toBeCloseTo(band.w / 100, 9)
      expect(shp.h).toBeCloseTo(band.h / 100, 9)
      expect(plan.layers.some(l => (l as { owner?: { by: string } }).owner?.by === 'layout' && l.kind === 'rect' && (l as { owner?: { key: string } }).owner?.key.startsWith('shape'))).toBe(false)
    }
  })

  it('the checker catches a badge date that overflows its circle (rule 5 on the real ink)', async () => {
    const { makeSheet } = await import('~/lib/frame/patterns/kit/sheet')
    const { checkPlan } = await import('~/lib/frame/patterns/kit/check')
    const S = makeSheet({ frameW: 1280, frameH: 400, measure: makeStubMeasure() })
    // The prototype's row-5 badge on a banner: radius 4.3, a text box 6.0 wide, the date's ink 8.5.
    const rad = 4.3, cx = 50, cy = 10
    const els = [
      { k: 'c' as const, cx, cy, r: rad, color: 'ink' as const, role: 'shape', ok: true },
      { k: 't' as const, s: TEXTS.date, x: cx - rad * 0.7, w: rad * 1.4, top: cy - 0.35 * S.INFO.size, size: S.INFO.size, ls: 0, lh: 1.3, align: 'center' as const, role: 'date', ok: true, inside: 'shape' },
    ]
    expect(checkPlan(els, S)).toContain('date does not fit inside its shape')
  })
})

describe('the overlap family: the premise sweep', () => {
  // The crossing is the whole idea of these layouts, so it is asserted here directly with `boxOf`,
  // not only through the checker's rule 7 — a premise asserted only through the checker could
  // agree with a checker bug (this is the sweep that caught two prototype layouts passing while
  // not overlapping). For every combination the matrix offers and every candidate in it, each
  // premise pair must have SOME element of each role (base role: `title1` counts as `title`)
  // whose measured boxes intersect with positive area.
  const OVERLAP_FAMILY = ['overprint', 'dateBehind', 'tightStack', 'behindPhoto', 'collage', 'label', 'ghost']
  const base = (r: string | undefined) => (r ?? '').replace(/\d+$/, '')

  it('every layout of the family with a crossing declares it as a premise (Tight stack crosses inside one element)', () => {
    const withPairs = LAYOUTS.filter(l => l.premise?.overlap?.length).map(l => l.id)
    expect(withPairs).toEqual(OVERLAP_FAMILY.filter(id => id !== 'tightStack'))
    expect(LAYOUTS.find(l => l.id === 'overprint')!.premise!.overlap).toEqual([['title', 'details']])
    expect(LAYOUTS.find(l => l.id === 'dateBehind')!.premise!.overlap).toEqual([['title', 'date']])
    expect(LAYOUTS.find(l => l.id === 'ghost')!.premise!.overlap).toEqual([['title', 'details']])
    expect(LAYOUTS.find(l => l.id === 'behindPhoto')!.premise!.overlap).toEqual([['title', 'photo']])
    expect(LAYOUTS.find(l => l.id === 'collage')!.premise!.overlap).toEqual([['title', 'photo'], ['shape', 'photo']])
    expect(LAYOUTS.find(l => l.id === 'label')!.premise!.overlap).toEqual([['label', 'photo']])
  })

  const family = LAYOUTS.filter(l => l.premise?.overlap?.length)
  it.each(family.map(l => [l.id, l] as const))('%s: its premise pairs really intersect in every candidate offered', (_id, def) => {
    let offered = 0
    for (const c of combos.filter(x => x.id === def.id)) {
      const a = baseArgs(def, c)
      const S = makeSheet({ frameW: c.w, frameH: c.h, measure: makeStubMeasure() })
      for (const cand of candidatesForFrame(a)) {
        offered++
        const boxes = (role: string) => cand.out.els
          .filter((e): e is Exclude<El, { k: 'missing' }> => e.k !== 'missing' && base(e.role) === role)
          .map(e => boxOf(e, S)!)
        for (const [ra, rb] of def.premise!.overlap!) {
          const A = boxes(ra), B = boxes(rb)
          const label = `${ra} × ${rb} · ${c.kind} · ${c.image ? 'image' : 'no image'} · ${c.w}×${c.h} · ${JSON.stringify(cand.choice)}`
          expect(A.length, `no ${ra}: ${label}`).toBeGreaterThan(0)
          expect(B.length, `no ${rb}: ${label}`).toBeGreaterThan(0)
          const crosses = A.some(p => B.some(q =>
            Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0) > 0 && Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0) > 0))
          expect(crosses, `does not cross: ${label}`).toBe(true)
        }
      }
    }
    expect(offered, 'the sweep checked nothing').toBeGreaterThan(0)
  })
})

describe('image and overlap layouts on a real frame', () => {
  const layersOf = (id: string, kind: Kind, w: number, h: number, image = true) => {
    const def = LAYOUTS.find(l => l.id === id)!
    const a = baseArgs(def, { id, kind, image, w, h })
    const cand = candidatesForFrame(a)[0]!
    return { cand, plan: planLayout({ ...a, choice: cand.choice })! }
  }
  type Layer = { id: string; kind: string; opacity?: number; blend?: string; crop?: { fit: string }; mask?: { kind: string }; standIn?: boolean; x: number; y: number; w: number }

  it.each(FRAMES)('blend and opacity reach the layers: Overprint, Number behind, Ghost (%i×%i)', (w, h) => {
    const over = layersOf('overprint', 'phrase', w, h, false).plan.layers as unknown as Layer[]
    expect(over.find(l => l.id === 'd')!.blend).toBe('multiply')          // the details overprint in accent, multiplied
    const behind = layersOf('dateBehind', 'phrase', w, h, false).plan.layers as unknown as Layer[]
    expect(behind.find(l => l.id === 't')!.blend).toBe('multiply')        // the title multiplies over the date
    const ghost = layersOf('ghost', 'phrase', w, h, false).plan.layers as unknown as Layer[]
    expect(ghost.find(l => l.id === 'd')!.opacity).toBeCloseTo(0.16, 9)   // the faint ghost
    expect(ghost.find(l => l.id === 't')!.opacity ?? 1).toBe(1)             // the title itself stays solid
  })

  it.each(FRAMES)('the frame\'s image is placed with a cover crop by every image-led layout (%i×%i)', (w, h) => {
    for (const id of ['plate', 'panel', 'sideSplit', 'cross', 'overlap', 'stamp', 'column', 'rising', 'behindPhoto', 'collage', 'label']) {
      const { cand, plan } = layersOf(id, 'phrase', w, h)
      const p = cand.out.els.find(e => e.k === 'p' && e.role === 'photo')
      if (p?.k !== 'p') throw new Error(`${id} lost its image`)
      const img = (plan.layers as unknown as Layer[]).find(l => l.id === 'img')!
      expect(img.crop, id).toEqual({ fit: 'cover' })
      expect(img.x, id).toBeCloseTo((p.x + p.w / 2) / 100, 9)
      expect(img.w, id).toBeCloseTo(p.w / 100, 9)
    }
  })

  it('with no image layer, image mode places a stand-in where the prototype drew one', () => {
    for (const def of LAYOUTS.filter(l => l.needs?.image)) {
      const a = { ...baseArgs(def, { id: def.id, kind: 'phrase', image: false, w: 895, h: 1280 }), imageMode: true }
      const cands = candidatesForFrame(a)
      expect(cands.length, def.id).toBeGreaterThan(0)
      const plan = planLayout({ ...a, choice: cands[0]!.choice })!
      expect(plan.issues, def.id).toEqual([])
      expect((plan.layers as unknown as Layer[]).some(l => l.kind === 'image' && l.standIn), def.id).toBe(true)
    }
  })

  it.each(FRAMES)('Collage: the circle moves the user\'s own shape layer (%i×%i)', (w, h) => {
    const { cand, plan } = layersOf('collage', 'phrase', w, h)
    const circle = cand.out.els.find(e => e.k === 'c' && e.role === 'shape')
    if (circle?.k !== 'c') throw new Error('collage lost its circle')
    const shp = (plan.layers as unknown as Layer[]).find(l => l.id === 'shp')!
    expect(shp.x).toBeCloseTo(circle.cx / 100, 9)
    expect(shp.w).toBeCloseTo(2 * circle.r / 100, 9)
  })
})
