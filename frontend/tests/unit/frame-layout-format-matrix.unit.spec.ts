import { describe, it, expect } from 'vitest'
import { writeFileSync } from 'node:fs'
import { candidatesForFrame, planLayout } from '~/lib/frame/patterns/kit/plan'
import type { LayoutPlanArgs } from '~/lib/frame/patterns/kit/plan'
import { LAYOUTS } from '~/lib/frame/patterns/layouts/catalog'
import { makeStubMeasure } from '~/lib/frame/patterns/kit/measure'
import type { Kind, LayoutDef } from '~/lib/frame/patterns/kit/types'
import { makeSheet } from '~/lib/frame/patterns/kit/sheet'
import { boxOf } from '~/lib/frame/patterns/kit/check'
import { FRAME_FORMATS } from '~/lib/frame/formats'
import type { FrameFormat } from '~/lib/frame/formats'
import { frameLayers, palette } from './helpers/frameLayoutFixtures'

// ═══════════════════════ the format matrix (Stage 2, Task 7) ═══════════════════════
// Every ad and social format × {word, phrase, sentence} × {image, no image} × four contents (the
// Stage 1 dates, a number: date "–30%", two lines: title and details, and three lines: title,
// details and caption), through the real planner. The Frame stores the
// format's preset (`sailor_frame.preset`) and has the format's own size. For every layout the
// planner offers there:
//   1. every candidate, planned again with `planLayout`, has no issues (checker rule 8 included);
//   2. every placed text element is at least the format's INFO floor (9px at the viewing width);
//   4. the levels the format does not carry are hidden (layer `visible: false`, and not placed);
//   5. with keep-clear areas, every text box lies inside the uncovered band — measured with
//      `boxOf` directly, independent of the checker.
// And 3: the number of layouts offered meets the format's floor (ruling P6), unless the
// combination is listed in EXPECTED_THIN with its measured count and reason.

type Content = 'dates' | 'number' | 'two' | 'three'
/** Each content: the date's text (absent: the Stage 1 date) and which of the four text layers the
 *  Frame has, most important first (their sizes make that the inferred order). */
const CONTENTS: Record<Content, { date?: string; ids: readonly string[] }> = {
  dates: { ids: ['t', 'd', 'dt', 'c'] },
  number: { date: '–30%', ids: ['t', 'd', 'dt', 'c'] },
  two: { ids: ['t', 'd'] },
  three: { ids: ['t', 'd', 'c'] },
}
const TEXT_IDS = new Set(['t', 'd', 'dt', 'c'])
const KINDS: Kind[] = ['word', 'phrase', 'sentence']

/** Ruling P6: at least this many layouts offered. */
const FLOOR: Record<string, number> = { 'ad-160x600': 3, 'ad-970x250': 3, 'ad-300x600': 3, 'ad-728x90': 2, 'ad-320x50': 1 }
const floorOf = (f: FrameFormat) => FLOOR[f.id] ?? 6

type Combo = { format: string; kind: Kind; image: boolean; content: Content }

// Pinterest is seen at 236 px, so its INFO floor is 9/236 = 3.81 units, and the Stage 1 date
// "19.09.–15.11.2026" is one line 35.7 wide. The quarter-width info column most layouts give the
// date is 29.6 wide on 2:3 and 20.1 on 9:16 (its 18% right keep sets both side margins to 18.1).
// Until Layout decisions Task 3 the date never broke (the renderer wraps only at spaces), so it
// ran into the caption or off the page: 3 layouts offered (Index, Tilt, Number behind) with no
// image, 5 for the 9:16 sentence with one. Since Task 3 a date too wide for its box may break
// after the dash between its two dates ("19.09.–" / "15.11.2026", 14.7 and 21.0 wide at the
// floor), tried only when a choice fails without it — Pinterest now meets its floor everywhere.
// The measured counts are pinned in 'the format findings, pinned' below.
/** Combinations allowed under their floor. Each entry matches by the fields it gives, and pins
 *  the count measured when it was written (`offered`), so a change either way is noticed. */
const EXPECTED_THIN: (Partial<Combo> & { offered: number; reason: string })[] = []
const matches = (e: Partial<Combo>, c: Combo) =>
  (['format', 'kind', 'image', 'content'] as const).every(k => e[k] === undefined || e[k] === c[k])
const expectedThin = (c: Combo) => EXPECTED_THIN.find(e => matches(e, c))

const argsFor = (def: LayoutDef, f: FrameFormat, c: Combo): Omit<LayoutPlanArgs, 'choice'> => ({
  props: {
    sailor_localLayers: frameLayers(c.kind, { image: c.image, shape: !!def.needs?.shape, date: CONTENTS[c.content].date })
      .filter(l => !TEXT_IDS.has(l.id) || CONTENTS[c.content].ids.includes(l.id)),
    sailor_frame: { preset: f.id },
  },
  frameW: f.w, frameH: f.h, layoutId: def.id, palette, connectedSlots: [], measure: makeStubMeasure(),
})

/** The text layers a format hides: of the lines the Frame has, those past the levels it carries
 *  (final fix C2 — "carries N" counts the Frame's own lines, not fixed slots). */
const hiddenIdsOf = (f: FrameFormat, c: Combo) => CONTENTS[c.content].ids.slice(f.carries ?? 4)

const combos: Combo[] = (Object.keys(CONTENTS) as Content[]).flatMap(content =>
  FRAME_FORMATS.flatMap(f => KINDS.flatMap(kind => [false, true].map(image => ({ format: f.id, kind, image, content })))))

const results = new Map<string, string[]>()
const keyOf = (c: Combo) => `${c.format}|${c.kind}|${c.image ? 'image' : 'none'}|${c.content}`
let checked = 0

describe('format matrix — every format × kind × image through the real planner', () => {
  it.each(combos.map(c => [`${c.format} · ${c.kind} · ${c.image ? 'image' : 'no image'} · ${c.content}`, c] as const))('%s', (_label, c) => {
    const f = FRAME_FORMATS.find(x => x.id === c.format)!
    const H = 100 * f.h / f.w
    const floor = 900 / f.view! - 0.01
    const hiddenIds = hiddenIdsOf(f, c)
    const keep = f.keep
    const band = keep && { x0: keep.left * 100, y0: keep.top * H, x1: 100 - keep.right * 100, y1: H * (1 - keep.bottom) }
    const S = makeSheet({ frameW: f.w, frameH: f.h, measure: makeStubMeasure(), format: { view: f.view, nc: f.nc } })
    const offered: string[] = []
    for (const def of LAYOUTS) {
      const a = argsFor(def, f, c)
      const cands = candidatesForFrame(a)
      if (!cands.length) continue
      offered.push(def.id)
      for (const cand of cands) {
        const label = `${def.id} ${JSON.stringify(cand.choice)}`
        const plan = planLayout({ ...a, choice: cand.choice })
        expect.soft(plan, label).not.toBeNull()
        // 1. the checker, rule 8 included.
        expect.soft(plan!.issues, label).toEqual([])
        // 4. the levels the format does not carry (by layer; the roles are the planner's).
        expect.soft(plan!.format?.id, label).toBe(f.id)
        const roleOf = Object.fromEntries(Object.entries(plan!.posterState.roles).map(([r, id]) => [id, r]))
        const hidden = hiddenIds.map(id => roleOf[id])
        expect.soft([...plan!.format!.hidden].sort(), label).toEqual([...hidden].sort())
        for (const id of CONTENTS[c.content].ids) {
          const layer = plan!.layers.find(l => l.id === id) as { visible?: boolean } | undefined
          if (hiddenIds.includes(id)) expect.soft(layer?.visible, `${id} not hidden · ${label}`).toBe(false)
          else expect.soft(layer?.visible, `${id} hidden though carried · ${label}`).not.toBe(false)
        }
        for (const e of cand.out.els) {
          if (e.k !== 't' && e.k !== 'ring') continue
          const role = (e.role ?? '').replace(/\d+$/, '')
          expect.soft((hidden as string[]).includes(role), `${role} placed though hidden · ${label}`).toBe(false)
          // 2. the minimum text size from the viewing width.
          expect.soft(e.size, `${e.role} size · ${label}`).toBeGreaterThanOrEqual(floor)
          // 5. text inside the band, measured directly.
          if (band) {
            // Sideways, a display title is set optically: `x: M − 0.04·size` flush left and
            // `+ 0.03·size` flush right (the prototype's side-bearing compensation), so the real
            // glyph's ink starts on the margin while the stub measure's box (no side bearings)
            // starts that far outside it. That offset, on the title only, is allowed on x; the
            // top and bottom are exact.
            const b = boxOf(e, S)!
            const optical = (role === 'title' ? 0.04 * e.size : 0) + 1e-6
            const at = `${e.role} ${JSON.stringify(b)} outside ${JSON.stringify(band)} · ${label}`
            expect.soft(b.x0, at).toBeGreaterThanOrEqual(band.x0 - optical)
            expect.soft(b.y0, at).toBeGreaterThanOrEqual(band.y0 - 1e-6)
            expect.soft(b.x1, at).toBeLessThanOrEqual(band.x1 + optical)
            expect.soft(b.y1, at).toBeLessThanOrEqual(band.y1 + 1e-6)
          }
        }
        checked++
      }
    }
    results.set(keyOf(c), offered)
    // 3. layouts offered (ruling P6).
    const thin = expectedThin(c)
    if (thin) {
      expect(offered.length, `EXPECTED_THIN (${thin.reason}): offered ${offered.join(', ')}`).toBe(thin.offered)
      expect(thin.offered, 'listed in EXPECTED_THIN but meets its floor').toBeLessThan(floorOf(f))
    } else {
      expect(offered.length, `below the floor of ${floorOf(f)}: offered ${offered.join(', ') || 'nothing'}`).toBeGreaterThanOrEqual(floorOf(f))
    }
  })

  it('covers every format and checks a real number of candidates', () => {
    expect(new Set(combos.map(c => c.format))).toEqual(new Set(FRAME_FORMATS.map(f => f.id)))
    // eslint-disable-next-line no-console
    console.info(`[format matrix] ${combos.length} combinations, ${checked} candidates checked`)
    expect(checked).toBeGreaterThan(combos.length)
    if (process.env.FORMAT_MATRIX_DUMP) writeFileSync(process.env.FORMAT_MATRIX_DUMP, JSON.stringify({ checked, offered: Object.fromEntries(results) }, null, 1))
  })

  it('every EXPECTED_THIN entry names a format', () => {
    for (const e of EXPECTED_THIN) expect(FRAME_FORMATS.some(f => f.id === e.format), e.format).toBe(true)
  })
})

describe('the format findings, pinned', () => {
  /** The layouts offered for one combination, computed here (not read from the matrix above), so
   *  each pin passes when run on its own. */
  const offeredCount = (fid: string, kind: Kind, image: boolean, content: Content) => {
    const f = FRAME_FORMATS.find(x => x.id === fid)!
    return LAYOUTS.filter(def => candidatesForFrame(argsFor(def, f, { format: fid, kind, image, content })).length).length
  }

  it('the long date breaks after its dash where it must (Task 3): the counts it changed, pinned', () => {
    // Measured with the stub measure when Task 3 landed, "19.09.–15.11.2026" (the `dates` content).
    // Every change is an addition: a choice that failed with the date on one line passes with it
    // broken ("19.09.–" / "15.11.2026"). Every other format and content is unchanged.
    const PINS: Record<string, [number, number, number, number, number, number]> = {
      // word none, word image, phrase none, phrase image, sentence none, sentence image
      'meta-story': [17, 30, 24, 37, 21, 35], // before: 17 / 29 / 22 / 34 / 19 / 32
      'meta-story-hd': [17, 30, 24, 37, 21, 35], // before: 17 / 29 / 22 / 34 / 19 / 32
      'pinterest-2x3': [19, 33, 26, 40, 23, 37], // before: 3 / 8 / 3 / 8 / 3 / 8
      'pinterest-9x16': [10, 18, 14, 22, 13, 16], // before: 3 / 7 / 3 / 7 / 3 / 5
      'link-preview': [19, 32, 26, 39, 23, 37], // before: 19 / 31 / 26 / 36 / 23 / 34
      // pmax-landscape phrase + image 24 → 25 (fix 2026-09-24, Run-off with the side image on the
      // left): Run-off's title now fits the design columns beside the image instead of the whole
      // page, so its "Left edge" variation no longer reaches under the app's interface — Run-off is
      // offered there (1 variation; before: "date overlaps caption", "title: under the app's interface").
      'pmax-landscape': [14, 15, 21, 25, 18, 17], // before: 14 / 11 / 19 / 11 / 16 / 9
      'pmax-square': [16, 28, 24, 34, 21, 32], // before: 16 / 27 / 22 / 31 / 19 / 29
      'ad-300x250': [18, 33, 26, 40, 23, 37], // before: 18 / 32 / 24 / 37 / 21 / 34
      'ad-300x600': [19, 33, 26, 40, 23, 37], // before: 19 / 32 / 24 / 37 / 21 / 34
      'ad-160x600': [18, 31, 23, 36, 20, 33], // before: 13 / 21 / 19 / 27 / 15 / 23
    }
    for (const [fid, counts] of Object.entries(PINS)) {
      const got = (['word', 'phrase', 'sentence'] as Kind[]).flatMap(kind => [false, true].map(image => offeredCount(fid, kind, image, 'dates')))
      expect(got, fid).toEqual(counts)
    }
  })

  const offeredOn = (id: string, fid: string, kind: Kind, image: boolean) => {
    const f = FRAME_FORMATS.find(x => x.id === fid)!
    const def = LAYOUTS.find(l => l.id === id)!
    return candidatesForFrame(argsFor(def, f, { format: fid, kind, image, content: 'dates' })).length
  }

  it('Run-off is never offered where the app covers the right side: its title runs off under it (rule 8)', () => {
    for (const fid of ['meta-story', 'meta-story-hd', 'pinterest-9x16', 'pmax-square'])
      for (const kind of ['word', 'phrase', 'sentence'] as Kind[])
        for (const image of [false, true]) expect(offeredOn('runoff', fid, kind, image), `${fid} ${kind} ${image}`).toBe(0)
  })

  it('Ring is not offered on a 320×50 banner: its title on the ring would be 1.89, under the 2.81 floor (rule 2 covers rings)', () => {
    for (const image of [false, true]) expect(offeredOn('ring', 'ad-320x50', 'word', image)).toBe(0)
    // …and it still is where the ring's title clears the floor.
    expect(offeredOn('ring', 'meta-feed-1x1', 'word', false)).toBeGreaterThan(0)
  })
})
