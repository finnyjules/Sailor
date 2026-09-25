# Stroke fill follows the line — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Compositor stroke option that bends the stroke's patterned/gradient fill along the stroke instead of laying it over the frame.

**Architecture:** Three optional `StrokeInstance` fields. A pure module (`lib/compositor/strokeFollow.ts`) builds the centreline frame, the strip plan and the triangle mesh. One painter (`paintFollowedBand` in `useCompositorLayers.ts`) renders the paint into a straight strip, bends it onto a scratch triangle by triangle, masks it with the existing band painter, dithers ombre, and stamps. A small inspector row exposes it.

**Tech Stack:** Nuxt 4 / Vue 3 / TypeScript, Canvas2D, vitest (node env for pure code, happy-dom for components), Playwright against the running dev server on `http://127.0.0.1:3002`.

**Spec:** `docs/superpowers/specs/2026-09-25-stroke-fill-follows-line.md`

## Global Constraints

- Work in the main checkout (`/Users/julien/Documents/GitHub/Sailor`), no worktree, no branch. Other sessions edit this checkout concurrently: touch ONLY the files your task lists. Never `git stash`.
- **Subagents do NOT commit.** Implement, test, then report the exact file paths changed and the test output. The controller commits.
- **Never run `npm run dev` / `pnpm dev`** and never kill node processes — the dev server on :3002 is shared. Playwright runs use the running server. Run Playwright in the FOREGROUND.
- Absent fields ⇒ byte-identical pixels for every existing frame. The byte-identity guard `npx playwright test tests/compositor-multi-stroke.spec.ts -g "every legacy"` must stay green; NEVER regenerate `tests/fixtures/multi-stroke-legacy.txt`.
- UI copy is sentence case and never shows an internal identifier: "Fill" — "Stays put" / "Follows the line"; "Ombre fades" — "Inner to outer edge" / "Along the line"; "Repeats".
- Inapplicable inspector rows are HIDDEN, never greyed (house rule in `strokeInspector.ts`).
- Unit tests: `cd frontend && npx vitest run <file>`. Playwright: `cd frontend && npx playwright test <file>`.
- Match the surrounding code's comment density and idiom (these files explain WHY in comments).

---

### Task 1: Stored fields, readers and inspector gating

**Files:**
- Create: `frontend/app/lib/compositor/strokeFollow.ts` (only the paint predicate in this task — later tasks add to it)
- Modify: `frontend/app/lib/compositor/strokeStack.ts` (add fields to `StrokeInstance`, add readers)
- Modify: `frontend/app/lib/compositor/strokeInspector.ts` (row order, gating, option lists, patch helper)
- Test: `frontend/tests/unit/compositor-stroke-follow-model.unit.spec.ts`

**Interfaces:**
- Produces (strokeStack.ts):
  - `export const STROKE_FADES = ['across', 'along'] as const; export type StrokeFade = typeof STROKE_FADES[number]`
  - `StrokeInstance` gains `follow?: boolean; fade?: StrokeFade; fadeRepeats?: number`
  - `export const DEFAULT_FADE_REPEATS = 4`
  - `export function strokeFollowsOf(st: Pick<StrokeInstance, 'follow'>): boolean` — `st.follow === true`
  - `export function strokeFadeOf(st: Pick<StrokeInstance, 'fade'>): StrokeFade` — `'along'` iff `st.fade === 'along'`
  - `export function strokeFadeRepeatsOf(st: Pick<StrokeInstance, 'fadeRepeats'>): number` — finite ⇒ `round`, clamp `[1, 50]`; else `DEFAULT_FADE_REPEATS`
- Produces (strokeFollow.ts): `export function paintCanFollow(paint: Paint | undefined): boolean`
- Produces (strokeInspector.ts): row ids `'follow' | 'fade' | 'fadeRepeats'`; `STROKE_FOLLOW_OPTIONS`, `STROKE_FADE_OPTIONS`; `strokeFollowPatch(on: boolean): Partial<StrokeInstance>`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/compositor-stroke-follow-model.unit.spec.ts
import { describe, it, expect } from 'vitest'
import {
  strokeFollowsOf, strokeFadeOf, strokeFadeRepeatsOf, DEFAULT_FADE_REPEATS, strokeStackOf,
  type StrokeInstance,
} from '~/lib/compositor/strokeStack'
import { paintCanFollow } from '~/lib/compositor/strokeFollow'
import {
  strokeInspectorRows, STROKE_ROW_ORDER, STROKE_FOLLOW_OPTIONS, STROKE_FADE_OPTIONS, strokeFollowPatch,
} from '~/lib/compositor/strokeInspector'

const grid = { type: 'grid', a: '#fff', b: '#000', textColor: '#fff', angle: 0, density: 8 }
const ombre = { ...grid, type: 'ombre' }
const stroke = (o: Partial<StrokeInstance> = {}): StrokeInstance =>
  ({ id: 's1', paint: grid as any, width: 0.02, ...o })

describe('stroke follow — readers', () => {
  it('follow is on only for a literal true', () => {
    expect(strokeFollowsOf({})).toBe(false)
    expect(strokeFollowsOf({ follow: true })).toBe(true)
    expect(strokeFollowsOf({ follow: 'yes' as any })).toBe(false)
  })
  it('fade defaults to inner-to-outer (across)', () => {
    expect(strokeFadeOf({})).toBe('across')
    expect(strokeFadeOf({ fade: 'along' })).toBe('along')
    expect(strokeFadeOf({ fade: 'sideways' as any })).toBe('across')
  })
  it('repeats are a whole number from 1 to 50, default 4', () => {
    expect(DEFAULT_FADE_REPEATS).toBe(4)
    expect(strokeFadeRepeatsOf({})).toBe(4)
    expect(strokeFadeRepeatsOf({ fadeRepeats: 2.6 })).toBe(3)
    expect(strokeFadeRepeatsOf({ fadeRepeats: 0 })).toBe(1)
    expect(strokeFadeRepeatsOf({ fadeRepeats: 999 })).toBe(50)
    expect(strokeFadeRepeatsOf({ fadeRepeats: NaN })).toBe(4)
  })
  it('the new fields survive a stack read', () => {
    const layer = { kind: 'rect', strokes: [stroke({ follow: true, fade: 'along', fadeRepeats: 6 })] }
    const [st] = strokeStackOf(layer as any)
    expect(st!.follow).toBe(true)
    expect(st!.fade).toBe('along')
    expect(st!.fadeRepeats).toBe(6)
  })
})

describe('paintCanFollow', () => {
  it('patterns and gradients can follow; flat colours, foil, shader and images cannot', () => {
    expect(paintCanFollow(grid as any)).toBe(true)
    expect(paintCanFollow(ombre as any)).toBe(true)
    expect(paintCanFollow({ ...grid, type: 'stripes' } as any)).toBe(true)
    expect(paintCanFollow({ type: 'linear', angle: 0, stops: [{ offset: 0, color: '#f00' }] })).toBe(true)
    expect(paintCanFollow({ type: 'linear', angle: 0, stops: [] })).toBe(false)
    expect(paintCanFollow('#ff0000')).toBe(false)
    expect(paintCanFollow({ ...grid, type: 'solid' } as any)).toBe(false)
    expect(paintCanFollow({ ...grid, type: 'shader' } as any)).toBe(false)
    expect(paintCanFollow({ type: 'foil', metal: 'gold', brushed: 0.5, pressed: 0.5, grain: 0.4 } as any)).toBe(false)
    expect(paintCanFollow(undefined)).toBe(false)
  })
})

describe('inspector rows', () => {
  it('the three rows sit straight after Colour', () => {
    expect(STROKE_ROW_ORDER.slice(0, 4)).toEqual(['paint', 'follow', 'fade', 'fadeRepeats'])
  })
  it('Fill row: band stroke, real outline, followable paint', () => {
    expect(strokeInspectorRows('rect', stroke())).toContain('follow')
    expect(strokeInspectorRows('path', stroke())).toContain('follow')
    expect(strokeInspectorRows('text', stroke())).not.toContain('follow')
    expect(strokeInspectorRows('rect', stroke({ paint: '#f00' }))).not.toContain('follow')
    expect(strokeInspectorRows('rect', stroke({ style: 'shapes' }))).not.toContain('follow')
  })
  it('Ombre fades: only when following with an ombre fill', () => {
    expect(strokeInspectorRows('ellipse', stroke({ paint: ombre as any }))).not.toContain('fade')
    expect(strokeInspectorRows('ellipse', stroke({ paint: ombre as any, follow: true }))).toContain('fade')
    expect(strokeInspectorRows('ellipse', stroke({ follow: true }))).not.toContain('fade')
  })
  it('Repeats: only for an along-the-line fade', () => {
    const rows = (o: Partial<StrokeInstance>) => strokeInspectorRows('ellipse', stroke({ paint: ombre as any, follow: true, ...o }))
    expect(rows({})).not.toContain('fadeRepeats')
    expect(rows({ fade: 'along' })).toContain('fadeRepeats')
  })
  it('labels are sentence case and never identifiers', () => {
    expect(STROKE_FOLLOW_OPTIONS).toEqual([
      { value: 'still', label: 'Stays put' },
      { value: 'follow', label: 'Follows the line' },
    ])
    expect(STROKE_FADE_OPTIONS).toEqual([
      { value: 'across', label: 'Inner to outer edge' },
      { value: 'along', label: 'Along the line' },
    ])
  })
  it('turning follow off removes the field rather than storing false', () => {
    expect(strokeFollowPatch(true)).toEqual({ follow: true })
    expect(strokeFollowPatch(false)).toEqual({ follow: undefined })
  })
})
```

- [ ] **Step 2: Run it — expect failures** (`paintCanFollow` module missing, readers missing)

Run: `cd frontend && npx vitest run tests/unit/compositor-stroke-follow-model.unit.spec.ts`

- [ ] **Step 3: Implement**

In `strokeStack.ts`, next to `STROKE_WOBBLES`:

```ts
/** How an ombre band's grain fades when its fill FOLLOWS THE LINE: from the band's inner edge
 *  to its outer edge, or thickening and thinning along the line. Ombre only — see
 *  `strokeFollow.ts`. */
export const STROKE_FADES = ['across', 'along'] as const
export type StrokeFade = typeof STROKE_FADES[number]
export const DEFAULT_FADE_REPEATS = 4
```

Add to `StrokeInstance` (after `wobblePhase`):

```ts
  /** true ⇒ the paint is bent along the stroke instead of laid over the frame. Absent ⇒ the
   *  paint stays put, exactly as before this existed. Read through `strokeFollowsOf`. */
  follow?: boolean
  /** Ombre only, and only while following. Absent ⇒ 'across'. Read through `strokeFadeOf`. */
  fade?: StrokeFade
  /** Ombre + 'along' only: out-and-back cycles round the line. Read through `strokeFadeRepeatsOf`. */
  fadeRepeats?: number
```

Add the readers near `wobbleSpecOf`:

```ts
/** The ONE answer to "does this stroke's paint follow the line". A literal `true` only, so a
 *  stored string or number cannot switch it on. Whether the PAINT can follow is a separate
 *  question — `paintCanFollow` in strokeFollow.ts. */
export function strokeFollowsOf(st: Pick<StrokeInstance, 'follow'>): boolean {
  return st.follow === true
}
export function strokeFadeOf(st: Pick<StrokeInstance, 'fade'>): StrokeFade {
  return st.fade === 'along' ? 'along' : 'across'
}
export function strokeFadeRepeatsOf(st: Pick<StrokeInstance, 'fadeRepeats'>): number {
  const r = st.fadeRepeats
  return typeof r === 'number' && Number.isFinite(r) ? Math.max(1, Math.min(50, Math.round(r))) : DEFAULT_FADE_REPEATS
}
```

Create `strokeFollow.ts`:

```ts
/**
 * A stroke whose fill FOLLOWS THE LINE: the paint is drawn into a straight strip as long as the
 * band's centreline and as deep as the band, then bent round the stroke piece by piece.
 *
 * Pure: no canvas, no DOM. `paintFollowedBand` in useCompositorLayers.ts is the one painter.
 * Spec: docs/superpowers/specs/2026-09-25-stroke-fill-follows-line.md
 */
import { isFill, isGradient, type Paint } from '~/lib/compositor/paint'

/** Which paints have anything to bend. A flat colour looks the same either way; foil and
 *  image fills are not in scope; a shader fill is a live field with no tile to repeat. */
export function paintCanFollow(paint: Paint | undefined): boolean {
  if (isGradient(paint)) return paint.stops.length > 0
  if (isFill(paint)) return paint.type !== 'solid' && paint.type !== 'shader'
  return false
}
```

In `strokeInspector.ts`:
- import `paintCanFollow` from `~/lib/compositor/strokeFollow` and `strokeFollowsOf, strokeFadeOf, type StrokeFade` from strokeStack; import `isFill` from `~/lib/compositor/paint`.
- `STROKE_ROW_ORDER` becomes `['paint', 'follow', 'fade', 'fadeRepeats', 'width', 'distance', 'wobble', 'wobbleAmount', 'wobbleLength', 'wobblePhase', 'join', 'align', 'dash', 'style', 'shapes']`.
- In `strokeInspectorRows`, straight after `const rows: StrokeRowId[] = ['paint']`:

```ts
  // Follows the line: the painter only takes that route for a BAND on a real outline with a
  // paint that has something to bend (`paintFollowedBand` is reached from the band arms of
  // `paintStrokeStack`, which text never enters).
  const canFollow = band && shapeable && paintCanFollow(stroke.paint)
  if (canFollow) {
    rows.push('follow')
    const ombre = isFill(stroke.paint) && stroke.paint.type === 'ombre'
    if (strokeFollowsOf(stroke) && ombre) {
      rows.push('fade')
      if (strokeFadeOf(stroke) === 'along') rows.push('fadeRepeats')
    }
  }
```

- Next to `STROKE_WOBBLE_OPTIONS`:

```ts
/** The Fill select's two values. `'still'` / `'follow'` are select values only — the stored
 *  field is the boolean `follow`, written through `strokeFollowPatch`. */
export const STROKE_FOLLOW_OPTIONS: { value: 'still' | 'follow'; label: string }[] = [
  { value: 'still', label: 'Stays put' },
  { value: 'follow', label: 'Follows the line' },
]
export const STROKE_FADE_OPTIONS: { value: StrokeFade; label: string }[] = [
  { value: 'across', label: 'Inner to outer edge' },
  { value: 'along', label: 'Along the line' },
]
/** Off REMOVES the field (`undefined` drops out of the saved JSON) so a stroke switched on and
 *  off again is stored exactly as one never switched on. */
export function strokeFollowPatch(on: boolean): Partial<StrokeInstance> {
  return { follow: on ? true : undefined }
}
```

- [ ] **Step 4: Run the new test, then the existing stroke suites**

Run: `cd frontend && npx vitest run tests/unit/compositor-stroke-follow-model.unit.spec.ts tests/unit/compositor-stroke-inspector.unit.spec.ts tests/unit/compositor-stroke-stack.unit.spec.ts`
Expected: all PASS. If an existing inspector test pins `STROKE_ROW_ORDER` exactly, update that expectation to the new order (the only allowed change to an existing test) and say so in the report.

- [ ] **Step 5: Report** the changed paths and the test output. Do not commit.

---

### Task 2: The pure geometry — frame, strip plan, triangles, fade

**Files:**
- Modify: `frontend/app/lib/compositor/strokeFollow.ts`
- Modify: `frontend/app/lib/spacetype/fillTile.ts` (extract `ombreHash`; `ombrePicker` calls it — identical arithmetic)
- Test: `frontend/tests/unit/compositor-stroke-follow-geometry.unit.spec.ts`

**Interfaces:**
- Consumes: `paintCanFollow` (Task 1); `FlatPoint` from `~/lib/compositor/pathFlatten`; `isFill`, `isGradient`, `Paint` from `~/lib/compositor/paint`.
- Produces (strokeFollow.ts):
  - `export interface FollowFrame { pts: FlatPoint[]; normals: FlatPoint[]; arc: number[]; length: number; closed: boolean }` — `arc[i]` = distance along the line to `pts[i]`; `arc` has `segs + 1` entries (`segs = closed ? n : n - 1`), last = `length`.
  - `export function followFrame(pts: readonly FlatPoint[], closed: boolean, halfWidth: number): FollowFrame | null`
  - `export type Affine = [number, number, number, number, number, number]`
  - `export function triangleAffine(s0, s1, s2, d0, d1, d2: FlatPoint): Affine | null` — the canvas `transform(a,b,c,d,e,f)` mapping each `sK` to `dK`.
  - `export interface StripTriangle { src: [FlatPoint, FlatPoint, FlatPoint]; dst: [FlatPoint, FlatPoint, FlatPoint] }`
  - `export function bandTriangles(f: FollowFrame, halfWidth: number): StripTriangle[]` — strip `x` = arc length, `y` 0 (inner edge) … `2·halfWidth` (outer edge).
  - `export type FollowStripPlan = { kind: 'fade' } | { kind: 'stretch'; mirror: boolean } | { kind: 'tiles'; tiles: number; box: { w: number; h: number } }`
  - `export function followStripPlan(paint: Paint | undefined, box: { w: number; h: number }, length: number, closed: boolean): FollowStripPlan | null`
  - `export function fadeStops(fade: 'across' | 'along', repeats: number): { axis: 'across' | 'along'; stops: { offset: number; t: number }[] }` — `t` 0 = colour A, 1 = colour B.
- Produces (fillTile.ts): `export function ombreHash(px: number, py: number): number` — in `[0, 1)`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/compositor-stroke-follow-geometry.unit.spec.ts
import { describe, it, expect } from 'vitest'
import {
  followFrame, triangleAffine, bandTriangles, followStripPlan, fadeStops,
} from '~/lib/compositor/strokeFollow'
import { ombreHash, ombrePicker } from '~/lib/spacetype/fillTile'
import { resamplePolyline } from '~/lib/compositor/strokeShapes'

type P = { x: number; y: number }
const circle = (r: number, n: number, cw = true): P[] =>
  Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2 * (cw ? 1 : -1)
    return { x: r * Math.cos(t), y: r * Math.sin(t) }
  })
// A RECT is the fixture that matters: its edges flatten to two points each, which is the trap
// the wobble build fell into (see memory "frame-multi-stroke-landed"). Resample first, as the
// painter does.
const rect = (w: number, h: number, cw = true): P[] => {
  const c = [{ x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 }, { x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 }]
  return resamplePolyline(cw ? c : c.slice().reverse(), true, 1)
}

describe('followFrame', () => {
  it('measures the loop, closing chord included', () => {
    const f = followFrame(rect(100, 50), true, 10)!
    expect(f.length).toBeCloseTo(300, 0)
    expect(f.arc.length).toBe(f.pts.length + 1)
    expect(f.arc[f.arc.length - 1]).toBeCloseTo(f.length, 6)
  })
  it('normals point OUT of a closed shape, whichever way it is drawn', () => {
    for (const cw of [true, false]) {
      const f = followFrame(rect(100, 50, cw), true, 10)!
      // the sample nearest the middle of the top edge (y = -25, x ≈ 0)
      const i = f.pts.reduce((best, p, k) => (Math.abs(p.x) + Math.abs(p.y + 25) < Math.abs(f.pts[best]!.x) + Math.abs(f.pts[best]!.y + 25) ? k : best), 0)
      expect(f.normals[i]!.y, `cw=${cw}`).toBeLessThan(-0.99)
    }
  })
  it('normals are unit length and turn smoothly round a corner', () => {
    const f = followFrame(rect(100, 50), true, 10)!
    for (const n of f.normals) expect(Math.hypot(n.x, n.y)).toBeCloseTo(1, 6)
    // the sample nearest the top-right corner leans diagonally, not straight up or right
    const i = f.pts.reduce((b, p, k) => (Math.hypot(p.x - 50, p.y + 25) < Math.hypot(f.pts[b]!.x - 50, f.pts[b]!.y + 25) ? k : b), 0)
    expect(f.normals[i]!.x).toBeGreaterThan(0.3)
    expect(f.normals[i]!.y).toBeLessThan(-0.3)
  })
  it('an open line has one fewer segment and no wrap', () => {
    const f = followFrame([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }], false, 2)!
    expect(f.arc).toEqual([0, 5, 10])
    expect(f.length).toBe(10)
  })
  it('refuses a degenerate line', () => {
    expect(followFrame([{ x: 1, y: 1 }], true, 5)).toBeNull()
    expect(followFrame([{ x: 1, y: 1 }, { x: 1, y: 1 }], false, 5)).toBeNull()
  })
})

describe('triangleAffine', () => {
  it('maps each source corner onto its destination corner', () => {
    const s = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 4 }] as const
    const d = [{ x: 5, y: 5 }, { x: 5, y: 15 }, { x: 1, y: 5 }] as const
    const m = triangleAffine(s[0], s[1], s[2], d[0], d[1], d[2])!
    for (let k = 0; k < 3; k++) {
      const x = m[0] * s[k].x + m[2] * s[k].y + m[4], y = m[1] * s[k].x + m[3] * s[k].y + m[5]
      expect(x).toBeCloseTo(d[k].x, 9); expect(y).toBeCloseTo(d[k].y, 9)
    }
  })
  it('returns null for a flat source triangle', () => {
    const p = { x: 0, y: 0 }
    expect(triangleAffine(p, { x: 1, y: 0 }, { x: 2, y: 0 }, p, p, p)).toBeNull()
  })
})

describe('bandTriangles', () => {
  it('two per segment round a circle, none dropped, strip spans the band', () => {
    const f = followFrame(circle(100, 200), true, 10)!
    const tris = bandTriangles(f, 10)
    expect(tris.length).toBe(400)
    const ys = tris.flatMap(t => t.src.map(p => p.y))
    expect(Math.min(...ys)).toBe(0); expect(Math.max(...ys)).toBe(20)
    // strip y = 0 is the INNER edge: its band point is closer to the centre
    const t0 = tris[0]!
    expect(Math.hypot(t0.dst[0].x, t0.dst[0].y)).toBeCloseTo(90, 0)
    expect(Math.hypot(t0.dst[2].x, t0.dst[2].y)).toBeCloseTo(110, 0)
  })
  it('drops the triangles that fold over at a tight inner corner', () => {
    // a thin star: inner corners much tighter than the band is wide
    const star: P[] = Array.from({ length: 10 }, (_, i) => {
      const t = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 20 : 100
      return { x: r * Math.cos(t), y: r * Math.sin(t) }
    })
    const f = followFrame(resamplePolyline(star, true, 1), true, 15)!
    const segs = f.pts.length
    const tris = bandTriangles(f, 15)
    expect(tris.length).toBeLessThan(segs * 2)
    expect(tris.length).toBeGreaterThan(segs)   // most of the band survives
  })
})

describe('followStripPlan', () => {
  const box = { w: 100, h: 80 }
  const fill = (type: string) => ({ type, a: '#fff', b: '#000', textColor: '#fff', angle: 0, density: 8 }) as any
  it('patterns repeat a whole number of the layer tile round the loop', () => {
    const p = followStripPlan(fill('grid'), box, 314, true)!
    expect(p.kind).toBe('tiles')
    if (p.kind !== 'tiles') return
    expect(p.tiles).toBe(3)
    expect(p.box.w * p.tiles).toBeCloseTo(314, 9)            // closes exactly
    expect(p.box.h / p.box.w).toBeCloseTo(box.h / box.w, 9)  // same aspect: cells stay square
  })
  it('a short line still gets one whole tile', () => {
    const p = followStripPlan(fill('checkerboard'), box, 30, true)!
    expect(p).toEqual({ kind: 'tiles', tiles: 1, box: { w: 30, h: 24 } })
  })
  it('gradients stretch, mirrored only round a closed outline', () => {
    expect(followStripPlan(fill('gradient'), box, 300, true)).toEqual({ kind: 'stretch', mirror: true })
    expect(followStripPlan(fill('gradient'), box, 300, false)).toEqual({ kind: 'stretch', mirror: false })
    const lin = { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#f00' }, { offset: 1, color: '#00f' }] }
    expect(followStripPlan(lin as any, box, 300, true)).toEqual({ kind: 'stretch', mirror: true })
  })
  it('ombre fades; paints that cannot follow get no plan', () => {
    expect(followStripPlan(fill('ombre'), box, 300, true)).toEqual({ kind: 'fade' })
    expect(followStripPlan('#f00', box, 300, true)).toBeNull()
    expect(followStripPlan(fill('solid'), box, 300, true)).toBeNull()
  })
})

describe('fadeStops', () => {
  it('across: A at the inner edge, B at the outer edge', () => {
    expect(fadeStops('across', 4)).toEqual({ axis: 'across', stops: [{ offset: 0, t: 0 }, { offset: 1, t: 1 }] })
  })
  it('along: out and back `repeats` times, starting and ending on A', () => {
    const f = fadeStops('along', 2)
    expect(f.axis).toBe('along')
    expect(f.stops).toEqual([
      { offset: 0, t: 0 }, { offset: 0.25, t: 1 }, { offset: 0.5, t: 0 }, { offset: 0.75, t: 1 }, { offset: 1, t: 0 },
    ])
  })
})

describe('ombreHash', () => {
  it('is the exact hash ombrePicker already used', () => {
    const pick = ombrePicker(10, 10, 0)
    for (const [x, y] of [[0, 0], [3, 7], [9, 2]] as const) {
      const t = x / 10 // angle 0: t runs along x over the 10-px tile (pmin 0, range 10)
      expect(pick(x, y)).toBe(ombreHash(x, y) < t)
      expect(ombreHash(x, y)).toBeGreaterThanOrEqual(0); expect(ombreHash(x, y)).toBeLessThan(1)
    }
  })
})
```

- [ ] **Step 2: Run — expect failures** (functions not exported)

Run: `cd frontend && npx vitest run tests/unit/compositor-stroke-follow-geometry.unit.spec.ts`

- [ ] **Step 3: Implement**

In `fillTile.ts`, just above `ombrePicker`, and make `ombrePicker` use it (same arithmetic, so every existing ombre pixel is unchanged):

```ts
/** The per-pixel hash ombre's grain is drawn from, in [0, 1). Shared with the Compositor's
 *  follow-the-line stroke, which dithers a BENT fade with it so its grain matches a flat ombre's. */
export function ombreHash(px: number, py: number): number {
  const hsh = Math.sin(px * 12.9898 + py * 78.233) * 43758.5453
  return hsh - Math.floor(hsh)
}
```

and inside `ombrePicker` replace the two hash lines with `return ombreHash(px, py) < t`.

Append to `strokeFollow.ts` (add `import type { FlatPoint } from '~/lib/compositor/pathFlatten'`):

```ts
/** The centreline, measured and given a normal at every sample. */
export interface FollowFrame {
  pts: FlatPoint[]
  /** Unit normals. Closed: pointing OUT of the shape. Open: the left-hand side of travel. */
  normals: FlatPoint[]
  /** `arc[i]` = distance along the line to `pts[i]`; one extra entry, the full length. */
  arc: number[]
  length: number
  closed: boolean
}

/**
 * Measure an evenly-sampled centreline and give each sample a normal.
 *
 * The normal at a sample is taken across a WINDOW of ±0.8·halfWidth of arc length, not from its
 * immediate neighbours. That is what rounds the bend at a corner: at a rect's corner the
 * neighbour normal would snap through 90° in one sample and the strip would tear open on the
 * outside and fold on the inside. The window is clamped to a quarter of the loop so a tiny
 * outline cannot average its normals away.
 */
export function followFrame(pts: readonly FlatPoint[], closed: boolean, halfWidth: number): FollowFrame | null {
  const n = pts.length
  if (n < 2) return null
  const segs = closed ? n : n - 1
  const arc = [0]
  for (let i = 0; i < segs; i++) {
    const a = pts[i]!, b = pts[(i + 1) % n]!
    arc.push(arc[i]! + Math.hypot(b.x - a.x, b.y - a.y))
  }
  const length = arc[segs]!
  if (!(length > 0)) return null
  const step = length / segs
  const k = Math.max(1, Math.min(Math.max(1, Math.floor(n / 4)), Math.round((0.8 * Math.max(0, halfWidth)) / step)))
  let sign = 1
  if (closed) {
    let area = 0
    for (let i = 0; i < n; i++) { const a = pts[i]!, b = pts[(i + 1) % n]!; area += a.x * b.y - b.x * a.y }
    sign = area > 0 ? 1 : -1
  }
  const at = (i: number) => (closed ? pts[((i % n) + n) % n]! : pts[Math.max(0, Math.min(n - 1, i))]!)
  const normals = pts.map((_, i) => {
    const a = at(i - k), b = at(i + k)
    let tx = b.x - a.x, ty = b.y - a.y
    const l = Math.hypot(tx, ty) || 1
    tx /= l; ty /= l
    return { x: ty * sign, y: -tx * sign }
  })
  return { pts: pts.slice(), normals, arc, length, closed }
}

export type Affine = [number, number, number, number, number, number]

/** The canvas `transform(a, b, c, d, e, f)` that carries triangle s0-s1-s2 onto d0-d1-d2.
 *  `null` when the source triangle has no area (nothing to map). */
export function triangleAffine(
  s0: FlatPoint, s1: FlatPoint, s2: FlatPoint, d0: FlatPoint, d1: FlatPoint, d2: FlatPoint,
): Affine | null {
  const den = (s1.x - s0.x) * (s2.y - s0.y) - (s2.x - s0.x) * (s1.y - s0.y)
  if (!(Math.abs(den) > 1e-12)) return null
  const a = ((d1.x - d0.x) * (s2.y - s0.y) - (d2.x - d0.x) * (s1.y - s0.y)) / den
  const c = ((d2.x - d0.x) * (s1.x - s0.x) - (d1.x - d0.x) * (s2.x - s0.x)) / den
  const b = ((d1.y - d0.y) * (s2.y - s0.y) - (d2.y - d0.y) * (s1.y - s0.y)) / den
  const d = ((d2.y - d0.y) * (s1.x - s0.x) - (d1.y - d0.y) * (s2.x - s0.x)) / den
  return [a, b, c, d, d0.x - a * s0.x - c * s0.y, d0.y - b * s0.x - d * s0.y]
}

export interface StripTriangle { src: [FlatPoint, FlatPoint, FlatPoint]; dst: [FlatPoint, FlatPoint, FlatPoint] }

const orient = (a: FlatPoint, b: FlatPoint, c: FlatPoint) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)

/**
 * The strip → band mesh: two triangles per centreline segment. Strip `x` is arc length, strip
 * `y` runs 0 (inner edge, `p − n·h`) to `2h` (outer edge, `p + n·h`).
 *
 * On the inside of a corner tighter than the band is deep, the inner edge runs BACKWARDS and
 * its triangles turn inside out. Those are dropped — found as the ones whose orientation
 * (relative to their source) disagrees with the majority, which is the right test whichever
 * way the outline is drawn. The band mask trims what remains.
 */
export function bandTriangles(f: FollowFrame, halfWidth: number): StripTriangle[] {
  const n = f.pts.length, segs = f.closed ? n : n - 1, W = 2 * halfWidth
  const all: { t: StripTriangle; s: number }[] = []
  const push = (t: StripTriangle) => {
    const o = orient(t.dst[0], t.dst[1], t.dst[2]) * Math.sign(orient(t.src[0], t.src[1], t.src[2]))
    if (o !== 0) all.push({ t, s: Math.sign(o) })
  }
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n
    const p = f.pts[i]!, q = f.pts[j]!, np = f.normals[i]!, nq = f.normals[j]!
    const inP = { x: p.x - np.x * halfWidth, y: p.y - np.y * halfWidth }
    const outP = { x: p.x + np.x * halfWidth, y: p.y + np.y * halfWidth }
    const inQ = { x: q.x - nq.x * halfWidth, y: q.y - nq.y * halfWidth }
    const outQ = { x: q.x + nq.x * halfWidth, y: q.y + nq.y * halfWidth }
    const s0 = f.arc[i]!, s1 = f.arc[i + 1]!
    push({ src: [{ x: s0, y: 0 }, { x: s1, y: 0 }, { x: s0, y: W }], dst: [inP, inQ, outP] })
    push({ src: [{ x: s1, y: 0 }, { x: s1, y: W }, { x: s0, y: W }], dst: [inQ, outQ, outP] })
  }
  let vote = 0
  for (const e of all) vote += e.s
  const keep = vote >= 0 ? 1 : -1
  return all.filter(e => e.s === keep).map(e => e.t)
}

export type FollowStripPlan =
  | { kind: 'fade' }
  | { kind: 'stretch'; mirror: boolean }
  | { kind: 'tiles'; tiles: number; box: { w: number; h: number } }

/**
 * How the straight strip gets its paint.
 *
 * - ombre: a FADE map, dithered after bending (see `fadeStops`).
 * - gradients: stretched over the strip, and mirrored round a closed outline so the two ends
 *   meet on the same colour.
 * - everything else: the layer's OWN paint tile repeated along the strip, scaled so a whole
 *   number of tiles fits — the pattern closes without a seam and cells stay (almost) the size
 *   they are when the fill stays put. Scaling the whole tile (not re-deriving cell counts per
 *   fill type) is what makes this one rule serve grid, checkerboard, stripes, qr, shapes,
 *   noise and paper alike: every tile builder already fits whole cells across its tile.
 */
export function followStripPlan(
  paint: Paint | undefined, box: { w: number; h: number }, length: number, closed: boolean,
): FollowStripPlan | null {
  if (!paintCanFollow(paint)) return null
  if (isFill(paint) && paint.type === 'ombre') return { kind: 'fade' }
  if (isGradient(paint) || (isFill(paint) && paint.type === 'gradient')) return { kind: 'stretch', mirror: closed }
  const bw = box.w > 0 ? box.w : length
  const tiles = Math.max(1, Math.round(length / bw))
  const f = length / (tiles * bw)
  return { kind: 'tiles', tiles, box: { w: bw * f, h: (box.h > 0 ? box.h : bw) * f } }
}

/** The ombre fade as gradient stops: `t` 0 is colour A, 1 is colour B. 'across' runs inner
 *  edge → outer edge; 'along' goes out and back `repeats` times, so a closed loop meets itself
 *  on A with no seam. */
export function fadeStops(fade: 'across' | 'along', repeats: number): { axis: 'across' | 'along'; stops: { offset: number; t: number }[] } {
  if (fade === 'across') return { axis: 'across', stops: [{ offset: 0, t: 0 }, { offset: 1, t: 1 }] }
  const k = Math.max(1, Math.round(repeats))
  const stops: { offset: number; t: number }[] = []
  for (let i = 0; i < k; i++) stops.push({ offset: i / k, t: 0 }, { offset: (i + 0.5) / k, t: 1 })
  stops.push({ offset: 1, t: 0 })
  return { axis: 'along', stops }
}
```

- [ ] **Step 4: Run the new test and every ombre/fill suite**

Run: `cd frontend && npx vitest run tests/unit/compositor-stroke-follow-geometry.unit.spec.ts tests/unit/compositor-stroke-follow-model.unit.spec.ts tests/unit/paint-tile.unit.spec.ts tests/unit/paint-spread.unit.spec.ts`
Expected: PASS. If the star case's bounds fail, report the measured counts rather than loosening the test silently.

- [ ] **Step 5: Report** paths + output. Do not commit.

---

### Task 3: The painter, wired into the stroke stack, proven with pixels

**Files:**
- Modify: `frontend/app/composables/useCompositorLayers.ts` (new `paintFollowedBand`; two insertions in `paintStrokeStack`; imports)
- Test: `frontend/tests/compositor-stroke-follow.spec.ts` (new Playwright spec)

**Interfaces:**
- Consumes: Task 1 readers (`strokeFollowsOf`, `strokeFadeOf`, `strokeFadeRepeatsOf`) and `paintCanFollow`; Task 2 (`followFrame`, `bandTriangles`, `triangleAffine`, `followStripPlan`, `fadeStops`, `ombreHash`); existing `longestSubpath`, `offsetPolyline`, `resamplePolyline`, `resolvePaint`, `scratchLike`, `stampScratch`, `paintStrokeBand`, `paintWobbledBand`, `strokeAlignOf`, `_fieldCtx`, `hexBytes` (fillTile).
- Produces: `export function paintFollowedBand(ctx, o): boolean` — `false` ⇒ nothing painted, caller paints the ordinary band.

- [ ] **Step 1: Write the failing Playwright spec**

```ts
// frontend/tests/compositor-stroke-follow.spec.ts
import { test, expect, type Page } from '@playwright/test'
import { openCompositor, stackPixels } from './_helpers'

/**
 * A stroke whose fill FOLLOWS THE LINE — proven on pixels.
 *
 * Geometry is width-normalized (as in compositor-multi-stroke.spec.ts): an ellipse w = h = 0.4
 * centred at (0.5, 0.5) is a circle of radius 0.2·canvasWidth in device pixels. Every probe is
 * taken in DEVICE pixels from that, so a non-square canvas cannot skew it.
 */

const ring = (stroke: Record<string, unknown>) => [{
  id: 'e', kind: 'ellipse', x: 0.5, y: 0.5, w: 0.4, h: 0.4, rotation: 0, opacity: 1, visible: true,
  fill: 'none', strokes: [{ id: 's1', width: 0.06, distance: 0, align: 'center', join: 'sharp', ...stroke }],
}]

/** RGBA at `n` points round a circle of radius `rNorm` (width-normalized) about the centre. */
async function around(page: Page, rNorm: number, n: number): Promise<number[][]> {
  return page.evaluate(({ rNorm, n }) => {
    const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
    const g = cv.getContext('2d')!
    const cx = cv.width / 2, cy = cv.height / 2, r = rNorm * cv.width
    const out: number[][] = []
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2
      const d = g.getImageData(Math.round(cx + r * Math.cos(t)), Math.round(cy + r * Math.sin(t)), 1, 1).data
      out.push([d[0]!, d[1]!, d[2]!, d[3]!])
    }
    return out
  }, { rNorm, n })
}
async function render(page: Page, layers: unknown[]): Promise<string> {
  await page.evaluate((ls) => (window as any).__compositorSetLayers(ls), layers)
  return stackPixels(page)
}
const dark = (p: number[]) => p[3]! > 200 && p[0]! < 100
const light = (p: number[]) => p[3]! > 200 && p[0]! > 155

const STRIPES = { type: 'stripes', a: '#ffffff', b: '#000000', textColor: '#fff', angle: 0, density: 8 }
const OMBRE = { type: 'ombre', a: '#ffffff', b: '#000000', textColor: '#fff', angle: 0, density: 8 }

test.beforeEach(async ({ page }) => { await openCompositor(page) })

test('follow off, or absent, paints the very same pixels', async ({ page }) => {
  const absent = await render(page, ring({ paint: STRIPES }))
  const off = await render(page, ring({ paint: STRIPES, follow: false }))
  expect(off).toBe(absent)
})

test('a flat colour ignores follow: same pixels either way', async ({ page }) => {
  const still = await render(page, ring({ paint: '#ff0000' }))
  const follow = await render(page, ring({ paint: '#ff0000', follow: true }))
  expect(follow).toBe(still)
})

test('followed stripes are RADIAL: inner and outer edge agree at every angle', async ({ page }) => {
  // Stripes at angle 0 are bars ACROSS the strip, so bent round a ring they become spokes: the
  // same colour at the band's inner and outer edge. Laid over the frame they are vertical bars,
  // and inner/outer disagree wherever a bar edge crosses the band.
  const agree = async (stroke: Record<string, unknown>) => {
    await render(page, ring(stroke))
    const inner = await around(page, 0.2 - 0.02, 720)
    const outer = await around(page, 0.2 + 0.02, 720)
    let same = 0, both = 0
    for (let i = 0; i < 720; i++) {
      const a = inner[i]!, b = outer[i]!
      if (a[3]! < 200 || b[3]! < 200) continue
      both++
      if ((a[0]! > 127) === (b[0]! > 127)) same++
    }
    return { share: same / Math.max(1, both), both }
  }
  const follow = await agree({ paint: STRIPES, follow: true })
  const still = await agree({ paint: STRIPES })
  expect(follow.both, 'both edges inked').toBeGreaterThan(600)
  expect(follow.share, `followed: inner/outer agree ${follow.share}`).toBeGreaterThan(0.9)
  expect(still.share, `stays put: inner/outer agree ${still.share}`).toBeLessThan(follow.share - 0.1)
})

test('followed stripes close round the loop: an even number of colour runs', async ({ page }) => {
  await render(page, ring({ paint: STRIPES, follow: true }))
  const mid = await around(page, 0.2, 1440)
  const cls = mid.filter(p => p[3]! > 200).map(p => (p[0]! > 127 ? 1 : 0))
  let runs = 0
  for (let i = 0; i < cls.length; i++) if (cls[i] !== cls[(i + 1) % cls.length]) runs++
  expect(runs).toBeGreaterThan(8)
  expect(runs % 2, `runs=${runs}`).toBe(0)
})

test('followed ombre fades inner edge → outer edge at EVERY angle', async ({ page }) => {
  await render(page, ring({ paint: OMBRE, follow: true }))
  const inner = await around(page, 0.2 - 0.025, 720)
  const outer = await around(page, 0.2 + 0.025, 720)
  // Four quadrants, each on its own: laid over the frame, an angle-0 ombre would be light on the
  // LEFT and dark on the RIGHT whatever the radius.
  for (let q = 0; q < 4; q++) {
    const slice = (xs: number[][]) => xs.slice(q * 180, (q + 1) * 180).filter(p => p[3]! > 200)
    const darkShare = (xs: number[][]) => slice(xs).filter(dark).length / Math.max(1, slice(xs).length)
    expect(darkShare(inner), `quadrant ${q} inner`).toBeLessThan(0.3)
    expect(darkShare(outer), `quadrant ${q} outer`).toBeGreaterThan(0.7)
  }
})

test('followed ombre is still GRAIN, not a smooth blend', async ({ page }) => {
  await render(page, ring({ paint: OMBRE, follow: true }))
  const mid = await around(page, 0.2, 720)
  const inked = mid.filter(p => p[3]! > 200)
  const grey = inked.filter(p => p[0]! > 60 && p[0]! < 195).length
  expect(inked.length).toBeGreaterThan(600)
  expect(grey / inked.length, 'pixels are A or B, not mid-greys').toBeLessThan(0.1)
  expect(inked.filter(light).length).toBeGreaterThan(100)
  expect(inked.filter(dark).length).toBeGreaterThan(100)
})

test('ombre along the line: repeats set how many times it thickens round the loop', async ({ page }) => {
  await render(page, ring({ paint: OMBRE, follow: true, fade: 'along', fadeRepeats: 3 }))
  const mid = await around(page, 0.2, 720)
  // Smooth the grain: dark share in 24 windows of 15°. Then count the times the share RISES
  // through one half, going round once — one per repeat, wherever round the loop the strip
  // happens to start (a peak count would depend on that phase).
  const share = Array.from({ length: 24 }, (_, w) => {
    const xs = mid.slice(w * 30, (w + 1) * 30).filter(p => p[3]! > 200)
    return xs.filter(dark).length / Math.max(1, xs.length)
  })
  let rises = 0
  for (let i = 0; i < 24; i++) if (share[i]! < 0.5 && share[(i + 1) % 24]! >= 0.5) rises++
  expect(rises, `window shares ${share.map(s => s.toFixed(2)).join(' ')}`).toBe(3)
})

test('a followed stroke on a RECT, a STAR and a WOBBLED band inks its whole band', async ({ page }) => {
  // Coverage, not looks: the followed band must ink at least ~as much as the same band stays put.
  const red = { type: 'stripes', a: '#ff0000', b: '#e00000', textColor: '#fff', angle: 0, density: 8 }
  const count = async (layers: unknown[]) => {
    await render(page, layers)
    return page.evaluate(() => {
      const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
      const d = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data
      let n = 0
      for (let i = 0; i < d.length; i += 4) if (d[i]! > 150 && d[i + 1]! < 90 && d[i + 3]! > 200) n++
      return n
    })
  }
  const base = { rotation: 0, opacity: 1, visible: true, fill: 'none' }
  const cases: [string, (s: Record<string, unknown>) => unknown[]][] = [
    ['rect', (s) => [{ id: 'r', kind: 'rect', x: 0.5, y: 0.5, w: 0.4, h: 0.3, radius: 0, ...base, strokes: [{ id: 's1', width: 0.03, ...s }] }]],
    ['star', (s) => [{ id: 't', kind: 'star', x: 0.5, y: 0.5, w: 0.4, h: 0.4, points: 5, innerRatio: 0.5, cornerRadius: 0, ...base, strokes: [{ id: 's1', width: 0.02, ...s }] }]],
    ['wobble', (s) => [{ id: 'w', kind: 'ellipse', x: 0.5, y: 0.5, w: 0.4, h: 0.4, ...base, strokes: [{ id: 's1', width: 0.03, wobble: 'wave', wobbleAmount: 0.01, wobbleLength: 0.08, ...s }] }]],
  ]
  for (const [name, make] of cases) {
    const still = await count(make({ paint: red }))
    const follow = await count(make({ paint: red, follow: true }))
    expect(still, `${name}: control inks`).toBeGreaterThan(500)
    expect(follow / still, `${name}: followed ${follow} vs still ${still}`).toBeGreaterThan(0.85)
    expect(follow / still, `${name}: followed ${follow} vs still ${still}`).toBeLessThan(1.15)
  }
})
```

- [ ] **Step 2: Run it — expect the follow-specific tests to fail** (nothing reads `follow` yet; the two "same pixels" tests already pass)

Run: `cd frontend && npx playwright test tests/compositor-stroke-follow.spec.ts`

- [ ] **Step 3: Implement `paintFollowedBand`** — place it directly after `paintWobbledBand` in `useCompositorLayers.ts`. Add imports: `resamplePolyline` to the existing strokeShapes import; `followFrame, bandTriangles, triangleAffine, followStripPlan, fadeStops, paintCanFollow` from `~/lib/compositor/strokeFollow`; `hexBytes, ombreHash` added to the existing `~/lib/spacetype/fillTile` import; `strokeFollowsOf, strokeFadeOf, strokeFadeRepeatsOf` added to the existing strokeStack import. Check each import line first — do not duplicate an import that already exists.

```ts
/** Longest side of the straight strip a followed fill is drawn into, and its total pixels. */
const FOLLOW_STRIP_MAX_W = 16384
const FOLLOW_STRIP_MAX_AREA = 16_000_000

/**
 * A band whose paint FOLLOWS THE LINE. Returns `false` when it painted nothing (no outline,
 * no scratch, a paint with nothing to bend) so the caller paints the ordinary band instead —
 * a follow the geometry cannot express must not cost the stroke its ink.
 *
 * 1. The band's centreline is the SAME line `paintWobbledBand` strokes (same `centre` offset,
 *    same wobble), resampled evenly and given smoothed normals (`followFrame`).
 * 2. The paint is drawn into a straight strip, `length × width` in this ctx's units, rastered
 *    at device resolution (`followStripPlan` says how).
 * 3. The strip is bent onto a scratch, two triangles per centreline segment, each clipped
 *    (grown 0.6 device px so neighbours overlap instead of leaving hairline seams) and drawn
 *    under the affine map from strip to band.
 * 4. The band itself — painted by `mask`, i.e. the ordinary band painter in solid ink — is
 *    applied with `destination-in`, so distance, alignment, dash and wobble cut the result
 *    exactly as they cut a plain band. On its OWN scratch: `strokeAligned`'s inside arm draws
 *    under a clip, and a `destination-in` confined to a clip would leave the bent paint
 *    outside it untouched.
 * 5. Ombre: the bent strip is a FADE map (black = A, white = B); every device pixel becomes A
 *    or B through `ombreHash`, the same hash the flat ombre tile uses, so the grain stays crisp
 *    however far the strip was bent.
 */
export function paintFollowedBand(ctx: CanvasRenderingContext2D, o: {
  pathData: string
  tolerance?: number
  width: number
  distance?: number
  align?: StrokeAlign
  wobble?: WobbleSpec | null
  paint: Paint
  paintBox: { w: number; h: number }
  fade: 'across' | 'along'
  fadeRepeats: number
  /** Paint the band in solid ink on `c` — the ordinary band painter with `style: () => ink`. */
  mask: (c: CanvasRenderingContext2D) => void
}): boolean {
  if (!(o.width > 0) || !paintCanFollow(o.paint)) return false
  const d = typeof o.distance === 'number' && Number.isFinite(o.distance) ? o.distance : 0
  const align = strokeAlignOf(o.align)
  const centre = align === 'outside' ? d + o.width / 2 : align === 'inside' ? d - o.width / 2 : d
  const sub = longestSubpath(o.pathData, o.tolerance ? { tolerance: o.tolerance } : undefined)
  if (!sub) return false
  const line = offsetPolyline(sub.pts, sub.closed, centre, o.wobble ?? undefined)
  const m = ctx.getTransform()
  const sx = Math.hypot(m.a, m.b) || 1                      // device px per ctx unit
  const pts = resamplePolyline(line, sub.closed, Math.max(2 / sx, o.width / 24))
  const h = o.width / 2
  const frame = followFrame(pts, sub.closed, h)
  if (!frame) return false
  const plan = followStripPlan(o.paint, o.paintBox, frame.length, sub.closed)
  if (!plan) return false

  // ── 2. the straight strip ──
  const Lpx = frame.length * sx, Hpx = o.width * sx
  const k = Math.min(1, FOLLOW_STRIP_MAX_W / Lpx, Math.sqrt(FOLLOW_STRIP_MAX_AREA / Math.max(1, Lpx * Hpx)))
  const px = sx * k                                          // strip px per ctx unit
  if (typeof document === 'undefined') return false
  const strip = document.createElement('canvas')
  strip.width = Math.max(2, Math.ceil(Lpx * k / 2) * 2)      // even: the mirror splits it in half
  strip.height = Math.max(1, Math.ceil(Hpx * k))
  const sc = strip.getContext('2d')
  if (!sc) return false
  sc.setTransform(px, 0, 0, px, 0, 0)
  const L = frame.length, W = o.width
  if (plan.kind === 'fade') {
    const f = fadeStops(o.fade, o.fadeRepeats)
    const g = f.axis === 'across' ? sc.createLinearGradient(0, 0, 0, W) : sc.createLinearGradient(0, 0, L, 0)
    for (const s of f.stops) { const v = Math.round(s.t * 255); g.addColorStop(s.offset, `rgb(${v},${v},${v})`) }
    sc.fillStyle = g; sc.fillRect(0, 0, L, W)
  } else if (plan.kind === 'stretch') {
    const len = plan.mirror ? L / 2 : L
    sc.save(); sc.translate(len / 2, W / 2)
    sc.fillStyle = resolvePaint(sc, o.paint, { w: len, h: W }, _fieldCtx, 'extend')
    sc.fillRect(-len / 2, -W / 2, len, W)
    sc.restore()
    if (plan.mirror) {
      const half = strip.width / 2
      sc.save(); sc.setTransform(-1, 0, 0, 1, strip.width, 0)
      sc.drawImage(strip, 0, 0, half, strip.height, 0, 0, half, strip.height)
      sc.restore()
    }
  } else {
    // The layer's own tile, scaled so `plan.tiles` of them span the strip; its left edge at 0.
    sc.save(); sc.translate(plan.box.w / 2, W / 2)
    sc.fillStyle = resolvePaint(sc, o.paint, plan.box, _fieldCtx, 'extend')
    sc.fillRect(-plan.box.w / 2, -W / 2, L, W)
    sc.restore()
  }

  // ── 3. bend it ──
  const bent = scratchLike(ctx)
  const maskS = scratchLike(ctx)
  if (!bent || !maskS) return false
  const grow = 0.6 / sx
  for (const t of bandTriangles(frame, h)) {
    const aff = triangleAffine(t.src[0], t.src[1], t.src[2], t.dst[0], t.dst[1], t.dst[2])
    if (!aff) continue
    const gx = (t.dst[0].x + t.dst[1].x + t.dst[2].x) / 3, gy = (t.dst[0].y + t.dst[1].y + t.dst[2].y) / 3
    bent.save()
    bent.beginPath()
    t.dst.forEach((p, i) => {
      const dx = p.x - gx, dy = p.y - gy, l = Math.hypot(dx, dy) || 1
      const x = p.x + (dx / l) * grow, y = p.y + (dy / l) * grow
      if (i) bent.lineTo(x, y); else bent.moveTo(x, y)
    })
    bent.closePath()
    bent.clip()
    bent.transform(aff[0], aff[1], aff[2], aff[3], aff[4], aff[5])
    const x0 = Math.max(0, Math.min(t.src[0].x, t.src[1].x, t.src[2].x) - 2 / px)
    const x1 = Math.min(L, Math.max(t.src[0].x, t.src[1].x, t.src[2].x) + 2 / px)
    if (x1 > x0) bent.drawImage(strip, x0 * px, 0, (x1 - x0) * px, strip.height, x0, 0, x1 - x0, W)
    bent.restore()
  }

  // ── 4. cut it to the band ──
  o.mask(maskS)
  bent.save()
  bent.setTransform(1, 0, 0, 1, 0, 0)
  bent.globalCompositeOperation = 'destination-in'
  bent.drawImage(maskS.canvas, 0, 0)
  bent.restore()

  // ── 5. ombre grain ──
  if (plan.kind === 'fade' && isFill(o.paint)) {
    // Only the band's device-space bounds, not the whole canvas.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of frame.pts) {
      const X = m.a * p.x + m.c * p.y + m.e, Y = m.b * p.x + m.d * p.y + m.f
      if (X < minX) minX = X; if (X > maxX) maxX = X; if (Y < minY) minY = Y; if (Y > maxY) maxY = Y
    }
    const pad = Math.ceil(h * sx) + 2
    const bx = Math.max(0, Math.floor(minX) - pad), by = Math.max(0, Math.floor(minY) - pad)
    const bw = Math.min(bent.canvas.width, Math.ceil(maxX) + pad) - bx
    const bh = Math.min(bent.canvas.height, Math.ceil(maxY) + pad) - by
    if (bw > 0 && bh > 0) {
      const img = bent.getImageData(bx, by, bw, bh), dd = img.data
      const A = hexBytes(o.paint.a), B = hexBytes(o.paint.b)
      for (let i = 0; i < dd.length; i += 4) {
        if (!dd[i + 3]) continue
        const q = i / 4, x = bx + (q % bw), y = by + Math.floor(q / bw)
        const C = ombreHash(x, y) < dd[i]! / 255 ? B : A
        dd[i] = C[0]; dd[i + 1] = C[1]; dd[i + 2] = C[2]
      }
      bent.putImageData(img, bx, by)
    }
  }
  stampScratch(ctx, bent)
  return true
}
```

- [ ] **Step 4: Wire it into `paintStrokeStack`**

In the WOBBLE arm, inside `if (outline) {`, before `const band = (c, ink?) => paintWobbledBand(...)`:

```ts
        // FOLLOWS THE LINE — the same wobbled centreline, bent paint; the mask is this arm's own
        // band in ink with round corners (a bent fill cannot turn a sharp point).
        if (strokeFollowsOf(st) && !foil && paintFollowedBand(ctx, {
          pathData: outline,
          tolerance: o.outlineTolerance ?? DEFAULT_FLATTEN_TOLERANCE * o.widthScale,
          width: st.width * o.widthScale,
          distance: (st.distance ?? 0) * o.widthScale,
          align: st.align,
          wobble,
          paint: st.paint,
          paintBox,
          fade: strokeFadeOf(st),
          fadeRepeats: strokeFadeRepeatsOf(st),
          mask: (c) => paintWobbledBand(c, {
            pathData: outline, width: st.width * o.widthScale, distance: (st.distance ?? 0) * o.widthScale,
            wobble, align: st.align, join: 'round', dash: strokeDashSegments(st.dash, o.widthScale),
            style: () => '#000',
            tolerance: o.outlineTolerance ?? DEFAULT_FLATTEN_TOLERANCE * o.widthScale,
          }),
        })) continue
```

In the STRAIGHT arm, after the `const band = ...` definition and before `if (foil) paintFoilRegion(...)`:

```ts
    // FOLLOWS THE LINE. Needs the outline to bend along; without one (or with a paint that has
    // nothing to bend) it paints the ordinary band below. The mask is this very band in ink,
    // with round corners — at distance 0 `strokeAligned` strokes with the scratch's own
    // `lineJoin`, so it is set here as well as passed.
    if (strokeFollowsOf(st) && !foil) {
      const outline = outlineData()
      if (outline && paintFollowedBand(ctx, {
        pathData: outline,
        tolerance: o.outlineTolerance ?? DEFAULT_FLATTEN_TOLERANCE * o.widthScale,
        width: st.width * o.widthScale,
        distance: (st.distance ?? 0) * o.widthScale,
        align: st.align,
        paint: st.paint,
        paintBox,
        fade: strokeFadeOf(st),
        fadeRepeats: strokeFadeRepeatsOf(st),
        mask: (c) => {
          if (o.build && !o.path) o.build(c)
          c.lineJoin = 'round'
          paintStrokeBand(c, {
            width: st.width * o.widthScale, distance: (st.distance ?? 0) * o.widthScale,
            style: () => '#000', align: st.align, join: 'round',
            dash: strokeDashSegments(st.dash, o.widthScale), path: o.path, fillRule: o.fillRule, build: o.build,
          })
        },
      })) continue
    }
```

(`foil` is already declared in that scope as `isFoilFill(st.paint) ? st.paint : null` — confirm by reading the arm; `paintCanFollow` refuses foil anyway, the `!foil` is belt and braces.)

- [ ] **Step 5: Run the spec until green, then the guards**

Run:
```
cd frontend && npx playwright test tests/compositor-stroke-follow.spec.ts
cd frontend && npx playwright test tests/compositor-multi-stroke.spec.ts
cd frontend && npx vitest run tests/unit/compositor-stroke-band.unit.spec.ts tests/unit/compositor-stroke-style.unit.spec.ts tests/unit/compositor-stroke-wobble.unit.spec.ts tests/unit/compositor-stroke-follow-geometry.unit.spec.ts tests/unit/compositor-stroke-follow-model.unit.spec.ts
```
Expected: all PASS, including `every legacy stroked layer renders identically`. If a follow assertion fails, diagnose with the numbers the failure message prints — do not loosen a threshold without reporting the measured value and why. Save a screenshot of a followed grid ring, a followed ombre ring and a followed star to `/tmp/claude-501/.../scratchpad/follow-*.png` (use `page.screenshot` in a throwaway test or `locator.screenshot`) and list their paths in the report.

- [ ] **Step 6: Report** paths, test output, screenshot paths. Do not commit.

---

### Task 4: The inspector row

**Files:**
- Create: `frontend/app/components/vue-canvas/compositor/StrokeFollowRow.vue`
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` (stroke inspector template, ~line 11106, right after the Colour `FillControl`)
- Test: `frontend/tests/unit/compositor-stroke-follow-row.unit.spec.ts` (happy-dom) and a case in `frontend/tests/compositor-stroke-inspector-wiring.spec.ts`

**Interfaces:**
- Consumes: `STROKE_FOLLOW_OPTIONS`, `STROKE_FADE_OPTIONS`, `strokeFollowPatch` (strokeInspector.ts); `strokeFollowsOf`, `strokeFadeOf`, `strokeFadeRepeatsOf`, `type StrokeFade` (strokeStack.ts); modal's `hasStrokeRow`, `updateActiveStroke`, `activeStroke`.
- Produces: `StrokeFollowRow` props `{ follow: boolean; fade: StrokeFade; fadeRepeats: number; showFollow: boolean; showFade: boolean; showFadeRepeats: boolean }`, emits `update:follow(boolean)`, `update:fade(StrokeFade)`, `update:fadeRepeats(number)`. Data attributes: `data-stroke-follow`, `data-stroke-fade`, `data-stroke-fade-repeats`.

- [ ] **Step 1: Write the failing component test.** Look at an existing happy-dom component spec in `tests/unit` first (grep for `@vitest-environment happy-dom` and `mount(`) and copy its setup exactly. Then:

```ts
// @vitest-environment happy-dom
// frontend/tests/unit/compositor-stroke-follow-row.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import StrokeFollowRow from '~/components/vue-canvas/compositor/StrokeFollowRow.vue'

const base = { follow: false, fade: 'across' as const, fadeRepeats: 4, showFollow: true, showFade: false, showFadeRepeats: false }

describe('StrokeFollowRow', () => {
  it('shows the Fill select with plain words', () => {
    const w = mount(StrokeFollowRow, { props: base })
    const opts = w.findAll('[data-stroke-follow] option').map(o => o.text())
    expect(opts).toEqual(['Stays put', 'Follows the line'])
    expect(w.find('[data-stroke-fade]').exists()).toBe(false)
  })
  it('emits a boolean for Fill', async () => {
    const w = mount(StrokeFollowRow, { props: base })
    await w.find('[data-stroke-follow]').setValue('follow')
    expect(w.emitted('update:follow')![0]).toEqual([true])
    await w.find('[data-stroke-follow]').setValue('still')
    expect(w.emitted('update:follow')![1]).toEqual([false])
  })
  it('Ombre fades and Repeats appear only when asked, and emit their values', async () => {
    const w = mount(StrokeFollowRow, { props: { ...base, follow: true, showFade: true, showFadeRepeats: true, fade: 'along' } })
    expect(w.findAll('[data-stroke-fade] option').map(o => o.text())).toEqual(['Inner to outer edge', 'Along the line'])
    await w.find('[data-stroke-fade]').setValue('across')
    expect(w.emitted('update:fade')![0]).toEqual(['across'])
    await w.find('[data-stroke-fade-repeats]').setValue('7')
    expect(w.emitted('update:fadeRepeats')![0]).toEqual([7])
  })
  it('renders nothing when no row applies', () => {
    const w = mount(StrokeFollowRow, { props: { ...base, showFollow: false } })
    expect(w.find('select').exists()).toBe(false)
  })
})
```

- [ ] **Step 2: Run it — expect failure** (component missing)

Run: `cd frontend && npx vitest run tests/unit/compositor-stroke-follow-row.unit.spec.ts`

- [ ] **Step 3: Implement the component** in the same style as `StrokeStyleRow.vue` (same `numClass`/`selClass`, `panel-label`, `v-scrubnum` on the number input — check how `StrokeStyleRow` gets `v-scrubnum` and do the same):

```vue
<script setup lang="ts">
/**
 * The rows a stroke gets when its fill can FOLLOW THE LINE: the Fill choice itself, and — for an
 * ombre that follows — which way its grain fades and, along the line, how many times.
 *
 * Every row is gated by `strokeInspectorRows` (the modal passes the answers in as `show*`), the
 * same way StrokeStyleRow is: the painter decides what is live, this only draws it.
 * Emits ONE value per edit; the host writes it onto the stroke in a single `setLocal`.
 */
import { STROKE_FOLLOW_OPTIONS, STROKE_FADE_OPTIONS } from '~/lib/compositor/strokeInspector'
import type { StrokeFade } from '~/lib/compositor/strokeStack'

defineProps<{
  follow: boolean
  fade: StrokeFade
  fadeRepeats: number
  showFollow: boolean
  showFade: boolean
  showFadeRepeats: boolean
}>()
const emit = defineEmits<{
  (e: 'update:follow', v: boolean): void
  (e: 'update:fade', v: StrokeFade): void
  (e: 'update:fadeRepeats', v: number): void
}>()
const numClass = 'w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none'
const selClass = numClass + ' cursor-pointer'
</script>

<template>
  <div v-if="showFollow" class="space-y-1.5">
    <div>
      <div class="panel-label mb-1.5">Fill</div>
      <select :value="follow ? 'follow' : 'still'" :class="selClass" data-stroke-follow
        @change="emit('update:follow', ($event.target as HTMLSelectElement).value === 'follow')">
        <option v-for="o in STROKE_FOLLOW_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </div>
    <div v-if="showFade">
      <div class="panel-label mb-1.5">Ombre fades</div>
      <select :value="fade" :class="selClass" data-stroke-fade
        @change="emit('update:fade', ($event.target as HTMLSelectElement).value as StrokeFade)">
        <option v-for="o in STROKE_FADE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </div>
    <div v-if="showFadeRepeats">
      <div class="panel-label mb-1">Repeats</div>
      <input v-scrubnum type="number" min="1" max="50" step="1" :value="fadeRepeats" :class="numClass" data-stroke-fade-repeats
        @input="emit('update:fadeRepeats', Math.max(1, Math.min(50, Math.round(parseFloat(($event.target as HTMLInputElement).value) || 1))))">
    </div>
  </div>
</template>
```

- [ ] **Step 4: Wire it into CompositorModal.vue**, directly after the Colour `<FillControl … />` in the stroke inspector (before the Width block). Import the component and the readers next to the existing `StrokeStyleRow` / strokeInspector imports (read the import block first; extend existing import lines):

```vue
            <StrokeFollowRow class="mt-1.5"
              :follow="strokeFollowsOf(activeStroke!)" :fade="strokeFadeOf(activeStroke!)"
              :fade-repeats="strokeFadeRepeatsOf(activeStroke!)"
              :show-follow="hasStrokeRow('follow')"
              :show-fade="hasStrokeRow('fade')"
              :show-fade-repeats="hasStrokeRow('fadeRepeats')"
              @update:follow="(v: boolean) => updateActiveStroke(strokeFollowPatch(v))"
              @update:fade="(v: StrokeFade) => updateActiveStroke({ fade: v })"
              @update:fadeRepeats="(v: number) => updateActiveStroke({ fadeRepeats: v })" />
```

- [ ] **Step 5: Add a live-DOM wiring case** to `tests/compositor-stroke-inspector-wiring.spec.ts`. Read that file first and follow how it opens a stroke inspector for a layer with a given stroke and asserts rows; add one test: an ellipse with a grid stroke shows `[data-stroke-follow]`; choosing "Follows the line" writes `follow: true` onto the stroke (read the layer back the same way the file's other tests do); switching the paint to ombre shows `[data-stroke-fade]` with "Inner to outer edge" selected; choosing "Along the line" shows `[data-stroke-fade-repeats]`; a text layer's stroke never shows `[data-stroke-follow]`.

- [ ] **Step 6: Run**

```
cd frontend && npx vitest run tests/unit/compositor-stroke-follow-row.unit.spec.ts tests/unit/compositor-stroke-inspector.unit.spec.ts
cd frontend && npx playwright test tests/compositor-stroke-inspector-wiring.spec.ts
```
Expected: PASS. Also `cd frontend && npx vue-tsc --noEmit -p . 2>&1 | grep -E "StrokeFollowRow|strokeFollow|CompositorModal.vue:(1110|1111)" | head` should print nothing new (the repo has a typecheck baseline; compare only lines touching your files).

- [ ] **Step 7: Report** paths + output. Do not commit.

---

### Task 5: Agent vocabulary, Frame embed rebuild, docs

**Files:**
- Modify: `frontend/app/lib/agent/surfaces/compositor.ts` (`STROKE_PROPS` ~line 673 and `strokePatch` ~684–743)
- Modify: the agent unit test that covers `strokePatch` (`frontend/tests/unit/compositor-stroke-agent.unit.spec.ts`)
- Rebuild: `frontend/public/embed/frame-lean.js`, `frontend/public/embed/frame.js` via `npm run build:embed`
- Modify: `docs/STATE.md` (one entry, same style as neighbours)

**Interfaces:**
- Consumes: `STROKE_FADES`, `strokeFadeRepeatsOf` (strokeStack.ts).

- [ ] **Step 1: Failing agent test.** Read `strokePatch` and its test file. Add cases: `{ follow: true }` is accepted and stored as `true`; `{ follow: false }` removes the field; `{ fade: 'along' }` accepted; `{ fade: 'sideways' }` rejected the same way the file's other invalid values are rejected; `{ fadeRepeats: 7 }` stored as 7, `{ fadeRepeats: 500 }` stored clamped to 50.

- [ ] **Step 2: Run — expect failure.** `cd frontend && npx vitest run tests/unit/compositor-stroke-agent.unit.spec.ts`

- [ ] **Step 3: Implement** — add `'follow', 'fade', 'fadeRepeats'` to `STROKE_PROPS` and validate each in `strokePatch` in the file's existing style (`follow`: boolean, `false` ⇒ delete; `fade`: one of `STROKE_FADES`; `fadeRepeats`: finite number → `strokeFadeRepeatsOf({ fadeRepeats: v })`). If the agent's prompt/vocabulary text lists stroke props, add one plain sentence for each.

- [ ] **Step 4: Run the agent test — PASS.**

- [ ] **Step 5: Rebuild the embed and check its size ceiling**

```
cd frontend && npm run build:embed
cd frontend && npx vitest run tests/unit/embed-build-output.unit.spec.ts
cd frontend && npx playwright test tests/frame-embed-parity.spec.ts
```
Expected: PASS, `frame-lean.js` under its 430,000-byte ceiling. Report the new size.

- [ ] **Step 6: docs/STATE.md** — add a short entry for "Stroke fill follows the line" in the section and format the neighbouring Frame/Compositor entries use: what it does in plain words, the three fields, the spec path, the follow-up (Motion-tab motion running the fill along the edge).

- [ ] **Step 7: Report** paths, test output, embed size. Do not commit.
