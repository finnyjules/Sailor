import { describe, it, expect } from 'vitest'
import { candidatesForFrame, planLayout } from '~/lib/frame/patterns/kit/plan'
import type { LayoutPlanArgs } from '~/lib/frame/patterns/kit/plan'
import { LAYOUTS } from '~/lib/frame/patterns/layouts/catalog'
import { makeStubMeasure } from '~/lib/frame/patterns/kit/measure'
import type { Kind, LayoutDef } from '~/lib/frame/patterns/kit/types'
import { createEllipseLayer, createImageLayer, createTextLayer } from '~/composables/useCompositorLayers'
import type { LocalLayer } from '~/composables/useCompositorLayers'

// ═══════════════════════ the layout matrix (spec §10) ═══════════════════════
// Every layout in the catalog × every kind it fits × {image, no image} × four frame shapes.
// Each combination runs through `candidatesForFrame` — the planner's own run + check, exactly
// as the product applies it (wide-frame side image and Ruling R8 included) — and every
// candidate it returns is planned again with `planLayout` and must have no issues (which
// includes the layout's premise). A combination with NO candidate fails, unless it is listed
// in EXPECTED_EMPTY with a concrete reason. Tasks 10–12 extend this file by adding layouts to
// the catalog; the matrix picks them up by itself.

const KIND_TITLES: Record<Kind, string> = {
  word: 'Echoes',
  phrase: 'Weather Report',
  sentence: 'Everything slow is still moving',
}
const TEXTS = {
  details: 'Ines Vollmer',
  date: '19.09.–15.11.2026',
  caption: 'Kunstraum Lenz\nLenzgasse 14, 4056 Basel',
}
const FRAMES: [number, number][] = [[895, 1280], [1080, 1080], [1280, 720], [1280, 400]]
const palette = { field: '#f2f0ef', ink: '#121212', accent: '#dd2200' }

/** A real Frame: four TextLayers (sizes make the inference unambiguous), plus an image layer
 *  when `image`, plus a shape layer when the layout needs one. */
function frameLayers(kind: Kind, o: { image: boolean; shape: boolean }): LocalLayer[] {
  const t = (id: string, text: string, fontSize: number) =>
    createTextLayer({ id, text, fontSize, fontFamily: 'Inter', fontWeight: 600, color: '#111111' }) as LocalLayer
  const out = [
    t('t', KIND_TITLES[kind], 0.12),
    t('d', TEXTS.details, 0.04),
    t('dt', TEXTS.date, 0.03),
    t('c', TEXTS.caption, 0.02),
  ]
  if (o.image) out.push(createImageLayer('x.png', 1.25, { id: 'img', w: 0.5, h: 0.625 }) as LocalLayer)
  if (o.shape) out.push(createEllipseLayer({ id: 'shp', x: 0.5, y: 0.5, w: 0.3, h: 0.3 }) as LocalLayer)
  return out
}

type Combo = { id: string; kind: Kind; image: boolean; w: number; h: number }

/** Combinations allowed to have no candidate. Each entry matches by the fields it gives. */
const EXPECTED_EMPTY: (Partial<Combo> & { reason: string })[] = [
  { id: 'photoBehind', image: false, reason: 'needs an image and the frame has none (the product shows it only in image mode, with a stand-in)' },
  { id: 'fullBleed', image: false, reason: 'needs an image and the frame has none (the product shows it only in image mode, with a stand-in)' },
  // Run-off's promise is a title that runs off the page. On a 1280×400 banner with no image the
  // title is height-bound (baseline row 10/12, cap top no higher than row 1, details and foot
  // below): "Echoes" fits at size 22.1 and its ink ends at 68 of 100; the sentence needs 2–4
  // lines and ends at 39. No arrangement can reach the edge, so the layout rightly refuses.
  // (With an image the side image takes the right 38% and the title runs under it — Ruling R8.)
  // "Weather Report" is long enough on one line, so the phrase still has candidates here.
  { id: 'runoff', kind: 'word', image: false, w: 1280, h: 400, reason: 'banner, no image: the height-bound one-word title cannot reach the right edge (ink ends at 68/100)' },
  { id: 'runoff', kind: 'sentence', image: false, w: 1280, h: 400, reason: 'banner, no image: a 2–4-line title is height-bound far short of the right edge (ink ends at 39/100)' },
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
      const roles = new Set(cand.out.els.map(e => (e.k === 't' ? (e.role ?? '').replace(/\d+$/, '') : '')))
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
    const ids = LAYOUTS.map(l => l.id)
    expect(PROTOTYPE_ORDER.filter(id => ids.includes(id))).toEqual(ids)
  })

  it('every EXPECTED_EMPTY entry names a layout in the catalog', () => {
    for (const e of EXPECTED_EMPTY) expect(LAYOUTS.some(l => l.id === e.id), e.id).toBe(true)
  })
})
