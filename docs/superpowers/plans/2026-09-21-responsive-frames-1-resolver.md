# Responsive Frames — Slice 1: the resolver — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pure function `resolveLayout(frame, W, H, opts)` that re-lays a Frame's layers out for any box size using per-layer pins, plus the one painter hook it needs — with nothing visible in the app yet.

**Architecture:** Everything lives in a new folder `frontend/app/lib/frame/responsive/` of small pure modules (axis maths, pin inference, rigid units, per-kind stretch, motion remap, orchestrator). The painter (`paintLayerStack`) gains one transient per-layer number, `layoutScale`, applied at the sites where a layer's own draw scale is already set up — the same contract as motion's `motionScale`. Every existing Frame is untouched: the resolver is called by nobody yet, and when called at the design size it returns its inputs by reference.

**Tech Stack:** TypeScript (Nuxt 4 app code, no Vue in this slice), Vitest unit tests under `frontend/tests/unit/**/*.unit.spec.ts` (node environment, no DOM — text measuring is injected), the existing recording-context test pattern (`tests/unit/compositor-corner-radius.unit.spec.ts`).

Spec: `docs/superpowers/specs/2026-09-21-frame-responsive-constraints-design.md`. This plan covers **Build order slice 1** only. Slices 2–5 (the editor UI, editing at a viewing size, arranged groups, the export) get their own plans.

## Global Constraints

- Work directly in the main checkout; no worktree, no feature branch (CLAUDE.md).
- **Never run `npm run dev`** — a shared dev server already runs on :3002. This slice needs no dev server at all.
- **Commit with a private git index, by exact path, every time** (several sessions share this checkout). Run this as ONE Bash call:
  ```bash
  cd /Users/julien/Documents/GitHub/Sailor && IDX=$(mktemp) && export GIT_INDEX_FILE=$IDX && git read-tree HEAD && git add -- <exact paths> && git diff --cached --name-only && git commit -q -m "<message>

  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && rm -f "$IDX" && unset GIT_INDEX_FILE && git reset -q -- <the same exact paths> && git log --oneline -1
  ```
  `git diff --cached --name-only` must list ONLY your paths. Never `cp .git/index`, never bare `git commit`, never `git stash`.
- Unit tests: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/<file>` (config: `frontend/vitest.config.ts`, include `tests/unit/**/*.unit.spec.ts`, environment `node`). Run only your own spec files; the whole suite is slow and its counts lie under load.
- The typecheck baseline is not zero; do not chase pre-existing errors. Check only your own files: `cd frontend && npx vue-tsc --noEmit 2>&1 | grep 'lib/frame/responsive\|useCompositorLayers'` must print nothing new.
- Layer geometry units (from `useCompositorLayers.ts`): `x`, `y` are the layer CENTRE as fractions of frame width / height; every size (`w`, `h`, `fontSize`, `strokeWidth`, `boxW`, `boxH`, path `bbox`) is a fraction of frame WIDTH.
- `import type` only from `~/composables/useCompositorLayers` inside `lib/frame/responsive/` files that the export will later bundle (`types.ts`, `axis.ts`, `infer.ts`, `motion.ts`, `resolve.ts`). `units.ts` and `stretch.ts` may import the runtime helpers named in their tasks (`localLayerBox`, `wrappedTextLines`, `expandClones`, `layerMaskRef`, `topGroupOf`, `layersInGroup`).
- No new dependencies in this slice.
- Byte-identical rule: no existing call site of `paintLayerStack` may change output. Every painter edit is guarded by "absent ⇒ exactly the old code path".

---

## Plain-language summary

What this slice builds: the maths. Give it a Frame and a box size and it hands back the same kind of layer list the painter already eats, with every layer moved (and, where its pin says so, stretched or re-wrapped) for that box. It also tells the painter to draw each layer a little bigger or smaller with one number per layer. Nothing in the app calls it yet; slice 2 adds the "Responsive" choice, the draggable edges and the pins card.

Why it is safe: a Frame that is not marked responsive never reaches the resolver, and a responsive Frame at its own design size comes back unchanged, object for object.

What is risky and settled first: the painter hook. Task 9 is the "spike" the spec asks for — it is written as an ordinary task with a failing test, and its test defines what correct means.

## File structure

| File | Responsibility |
|---|---|
| `frontend/app/lib/frame/responsive/types.ts` | `Pins`, `PinH`, `PinV`, `FrameDoc`, `ResolveOptions`, `LayoutResult`, `AxisMap` |
| `frontend/app/lib/frame/responsive/axis.ts` | fit scale, spare room, the guard, the five per-axis maps forwards and backwards |
| `frontend/app/lib/frame/responsive/infer.ts` | `inferPins` — the replaceable default rule |
| `frontend/app/lib/frame/responsive/sections.ts` | grid resolved at a box with a unit width; which section a box sits in |
| `frontend/app/lib/frame/responsive/units.ts` | rigid units (free groups, shape-mask pairs, cloners) and their design boxes |
| `frontend/app/lib/frame/responsive/stretch.ts` | per-kind stretch, image cover-and-crop, text re-wrap height |
| `frontend/app/lib/frame/responsive/motion.ts` | map `layers.<id>.x` / `.y` tracks |
| `frontend/app/lib/frame/responsive/resolve.ts` | `resolveLayout` — orchestrator and identity fast path |
| `frontend/app/lib/frame/responsive/layoutScale.ts` | `layoutScaleOf` — dependency-free, shared by painter and resolver |
| `frontend/app/lib/frame/responsive/fromNode.ts` | `frameDocFromProps`, `isResponsiveFrame` — the read of a node's `sailor_*` bag |
| `frontend/app/lib/frame/grid.ts` (modify) | optional `unitW` argument for `resolveGrid` |
| `frontend/app/composables/useCompositorLayers.ts` (modify) | `pins?` on `LayerCommon`; `layoutScale` applied at the per-layer draw-scale sites |
| `frontend/app/lib/compositor/layerGroups.ts` (modify) | `pins?` on `LayerGroup` |
| `frontend/tests/unit/responsive-*.unit.spec.ts` | one spec per module |

---

### Task 1: Types and the per-axis maps

**Files:**
- Create: `frontend/app/lib/frame/responsive/types.ts`
- Create: `frontend/app/lib/frame/responsive/axis.ts`
- Test: `frontend/tests/unit/responsive-axis.unit.spec.ts`

**Interfaces:**
- Produces: `PinH`, `PinV`, `Pins`, `AxisMap`, `fitScale(W0,H0,W,H)`, `spareRoom(...)`, `axisMap(pin, ref, s, spare, refStart)`, `applyMap`, `invertMap` (exact signatures in Step 3).

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/responsive-axis.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { fitScale, spareRoom, axisMap, applyMap, invertMap, guardedRoom } from '~/lib/frame/responsive/axis'

describe('fitScale', () => {
  it('is the tighter of the two ratios', () => {
    expect(fitScale(1920, 1080, 960, 1080)).toBe(0.5)      // width binds
    expect(fitScale(1920, 1080, 3840, 1080)).toBe(1)       // height binds
    expect(fitScale(1920, 1080, 1920, 1080)).toBe(1)
  })
})

describe('spareRoom', () => {
  it('is zero on the binding axis and the leftover on the other', () => {
    expect(spareRoom(1920, 1080, 3840, 1080)).toEqual({ x: 1920, y: 0 })
    expect(spareRoom(1920, 1080, 1920, 2160)).toEqual({ x: 0, y: 1080 })
    expect(spareRoom(1920, 1080, 960, 540)).toEqual({ x: 0, y: 0 })
  })
})

describe('guardedRoom', () => {
  it('uses spare room only up to the fitted design extent, the rest becomes an outer offset', () => {
    // fitted design width 1920, spare 1920 → all usable, no offset
    expect(guardedRoom(1920, 1920)).toEqual({ u: 1920, o: 0 })
    // spare 5000 → usable 1920, the remaining 3080 split evenly
    expect(guardedRoom(5000, 1920)).toEqual({ u: 1920, o: 1540 })
    expect(guardedRoom(0, 1920)).toEqual({ u: 0, o: 0 })
  })
})

describe('axisMap (design px → box px)', () => {
  // design width 1000, fit scale 2, usable spare 400, outer offset 50
  const s = 2, u = 400, o = 50, ref = 1000
  it('left keeps its distance from the near edge', () => {
    const m = axisMap('left', ref, s, u, o)
    expect(applyMap(m, 100)).toBe(o + s * 100)
  })
  it('right keeps its distance from the far edge', () => {
    const m = axisMap('right', ref, s, u, o)
    expect(applyMap(m, 900)).toBe(o + s * 900 + u)
  })
  it('center stays centred', () => {
    const m = axisMap('center', ref, s, u, o)
    expect(applyMap(m, 500)).toBe(o + s * 500 + u / 2)
  })
  it('relative slides proportionally', () => {
    const m = axisMap('relative', ref, s, u, o)
    expect(applyMap(m, 250)).toBe(o + s * 250 + u * 0.25)
    expect(applyMap(m, 0)).toBe(o)
    expect(applyMap(m, ref)).toBe(o + s * ref + u)
  })
  it('both maps the near edge as left and the far edge as right (a stretch)', () => {
    const m = axisMap('both', ref, s, u, o)
    expect(m.kind).toBe('both')
    expect(applyMap(m, 100, 'near')).toBe(o + s * 100)
    expect(applyMap(m, 900, 'far')).toBe(o + s * 900 + u)
  })
  it('every map is a straight line: mapping a midpoint equals the midpoint of the mapped ends', () => {
    for (const pin of ['left', 'right', 'center', 'relative'] as const) {
      const m = axisMap(pin, ref, s, u, o)
      const a = applyMap(m, 100), b = applyMap(m, 700)
      expect(applyMap(m, 400)).toBeCloseTo((a + b) / 2, 9)
    }
  })
  it('invertMap round-trips', () => {
    for (const pin of ['left', 'right', 'center', 'relative'] as const) {
      const m = axisMap(pin, ref, s, u, o)
      expect(invertMap(m, applyMap(m, 333))).toBeCloseTo(333, 9)
    }
  })
  it('with no spare room every pin is the plain fit scale', () => {
    for (const pin of ['left', 'right', 'center', 'relative'] as const) {
      const m = axisMap(pin, ref, 2, 0, 0)
      expect(applyMap(m, 123)).toBe(246)
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/responsive-axis.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/frame/responsive/axis`.

- [ ] **Step 3: Write the types and the axis module**

```ts
// frontend/app/lib/frame/responsive/types.ts
import type { LocalLayer, StackKey } from '~/composables/useCompositorLayers'
import type { LayerGroup } from '~/lib/compositor/layerGroups'
import type { FrameGrid } from '~/lib/frame/grid'
import type { FrameMotion } from '~/lib/motion/types'

/** One pin per axis. 'both' = stretch; 'relative' = slide proportionally (today's behaviour). */
export type PinH = 'left' | 'right' | 'both' | 'center' | 'relative'
export type PinV = 'top' | 'bottom' | 'both' | 'middle' | 'relative'

/** Stored on a layer or a group. Absent field = automatic. */
export interface Pins {
  h?: PinH
  v?: PinV
  keepSize?: boolean
  /** 'frame' = hold to the whole frame even when inside a grid section. Absent = automatic. */
  holdTo?: 'frame'
}

/** The axis-neutral pin name the maths works in. */
export type AxisPin = 'left' | 'right' | 'both' | 'center' | 'relative'

/** A straight-line map from design px to box px on one axis: box = o + s·p + u·k(p). */
export interface AxisMap {
  kind: AxisPin
  s: number      // fit scale
  u: number      // usable spare room on this axis (after the guard)
  o: number      // outer offset (the guarded remainder, split evenly)
  ref: number    // the reference extent in design px (frame or section)
  refStart: number // where the reference rectangle starts, in design px
}

/** Everything the resolver reads. Built by the caller from the node's sailor_* properties. */
export interface FrameDoc {
  responsive: boolean
  designW: number
  designH: number
  layers: LocalLayer[]
  stackOrder: StackKey[]
  groups: LayerGroup[]
  grid: FrameGrid | null
  motion: FrameMotion | null
}

export interface ResolveOptions {
  /** A scratch 2D context for text measuring. null ⇒ text keeps its centre (no re-wrap). */
  measureCtx?: CanvasRenderingContext2D | null
}

export interface ResolvedBox { x: number; y: number; w: number; h: number } // box px, top-left

export interface LayoutResult {
  layers: LocalLayer[]
  motion: FrameMotion | null
  /** Resolved grid lines/regions in box px, or null when the grid is off. */
  grid: { xs: number[]; ys: number[]; regions: ResolvedBox[] } | null
  boxes: Map<string, ResolvedBox>
  maps: Map<string, { h: AxisMap; v: AxisMap }>
  /** True when the inputs were returned by reference. */
  identity: boolean
}
```

```ts
// frontend/app/lib/frame/responsive/axis.ts
import type { AxisMap, AxisPin } from './types'

/** The scale at which a W0×H0 design fits inside a W×H box. */
export function fitScale(W0: number, H0: number, W: number, H: number): number {
  return Math.min(W / W0, H / H0)
}

/** Room left over after fitting: ≥ 0 on both axes, 0 on at least one. */
export function spareRoom(W0: number, H0: number, W: number, H: number): { x: number; y: number } {
  const s = fitScale(W0, H0, W, H)
  return { x: Math.max(0, W - s * W0), y: Math.max(0, H - s * H0) }
}

/**
 * The guard: pins use spare room only up to the fitted design's own extent on that
 * axis; the rest is split evenly as an outer offset so the arrangement stops
 * spreading and sits centred. Continuous in `spare`.
 */
export function guardedRoom(spare: number, fittedExtent: number): { u: number; o: number } {
  const u = Math.min(spare, fittedExtent)
  return { u, o: (spare - u) / 2 }
}

/** Build the map for one axis. `ref` = reference extent in design px; `refStart` = its start. */
export function axisMap(kind: AxisPin, ref: number, s: number, u: number, o: number, refStart = 0): AxisMap {
  return { kind, s, u, o, ref, refStart }
}

/**
 * Map a design-px coordinate to box px. For 'both', say which edge the point is:
 * the near edge maps like 'left', the far edge like 'right'. Every other kind
 * ignores `edge`.
 */
export function applyMap(m: AxisMap, p: number, edge: 'near' | 'far' = 'near'): number {
  const local = p - m.refStart
  const base = m.o + m.s * p
  switch (m.kind) {
    case 'left': return base
    case 'right': return base + m.u
    case 'center': return base + m.u / 2
    case 'relative': return base + m.u * (m.ref > 0 ? local / m.ref : 0)
    case 'both': return edge === 'far' ? base + m.u : base
  }
}

/** The inverse of applyMap for the same kind/edge (design px from box px). */
export function invertMap(m: AxisMap, q: number, edge: 'near' | 'far' = 'near'): number {
  switch (m.kind) {
    case 'left': return (q - m.o) / m.s
    case 'right': return (q - m.o - m.u) / m.s
    case 'center': return (q - m.o - m.u / 2) / m.s
    case 'relative': {
      // q = o + s·p + u·(p − refStart)/ref  ⇒  p = (q − o + u·refStart/ref) / (s + u/ref)
      const k = m.ref > 0 ? m.u / m.ref : 0
      return (q - m.o + k * m.refStart) / (m.s + k)
    }
    case 'both': return edge === 'far' ? (q - m.o - m.u) / m.s : (q - m.o) / m.s
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/responsive-axis.unit.spec.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

Paths: `frontend/app/lib/frame/responsive/types.ts frontend/app/lib/frame/responsive/axis.ts frontend/tests/unit/responsive-axis.unit.spec.ts`
Message: `feat(frame): responsive resolver — pin types and per-axis maps`

---

### Task 2: Stored `pins` on layers and groups

**Files:**
- Modify: `frontend/app/composables/useCompositorLayers.ts:320-364` (`LayerCommon`)
- Modify: `frontend/app/lib/compositor/layerGroups.ts:23-36` (`LayerGroup`)
- Test: `frontend/tests/unit/responsive-pins-field.unit.spec.ts`

**Interfaces:**
- Produces: `LayerCommon.pins?: Pins`, `LayerGroup.pins?: Pins` (plain optional data, absent = automatic).

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/responsive-pins-field.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { createRectLayer, createTextLayer } from '~/composables/useCompositorLayers'
import type { LayerGroup } from '~/lib/compositor/layerGroups'
import type { Pins } from '~/lib/frame/responsive/types'

describe('pins field', () => {
  it('a layer created today carries no pins (automatic)', () => {
    expect(createRectLayer().pins).toBeUndefined()
    expect(createTextLayer().pins).toBeUndefined()
  })
  it('pins are plain data on a layer and on a group', () => {
    const pins: Pins = { h: 'right', v: 'bottom', keepSize: true }
    const l = createRectLayer({ pins })
    expect(l.pins).toEqual(pins)
    const g: LayerGroup = { id: 'g1', pins: { h: 'both' } }
    expect(g.pins?.h).toBe('both')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/responsive-pins-field.unit.spec.ts`
Expected: the runtime assertions pass but the file fails typecheck under vitest? No — vitest does not typecheck. So instead: `cd frontend && npx vue-tsc --noEmit 2>&1 | grep responsive-pins-field` Expected: errors "Object literal may only specify known properties, and 'pins' does not exist".

- [ ] **Step 3: Add the field in both places**

In `useCompositorLayers.ts`, inside `interface LayerCommon` after the `feather?:` line (line ~363):

```ts
  /** Responsive Frames: how this layer holds to the frame (or its grid section)
   *  when the box changes shape. Absent ⇒ automatic (inferred from where it sits).
   *  Ignored while the Frame is fixed. See lib/frame/responsive. */
  pins?: import('~/lib/frame/responsive/types').Pins
```

In `layerGroups.ts`, inside `interface LayerGroup` after `expressiveBox?`:

```ts
  /** Responsive Frames: the group's pins (a free group adapts as one rigid unit).
   *  Absent ⇒ automatic. See lib/frame/responsive. */
  pins?: import('~/lib/frame/responsive/types').Pins
```

- [ ] **Step 4: Verify**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/responsive-pins-field.unit.spec.ts && npx vue-tsc --noEmit 2>&1 | grep 'responsive-pins-field\|lib/frame/responsive'`
Expected: PASS (2 tests) and the grep prints nothing.

- [ ] **Step 5: Commit**

Paths: `frontend/app/composables/useCompositorLayers.ts frontend/app/lib/compositor/layerGroups.ts frontend/tests/unit/responsive-pins-field.unit.spec.ts`
Message: `feat(frame): optional pins field on layers and groups (absent = automatic)`

---

### Task 3: `inferPins` — the replaceable default rule

**Files:**
- Create: `frontend/app/lib/frame/responsive/infer.ts`
- Test: `frontend/tests/unit/responsive-infer.unit.spec.ts`

**Interfaces:**
- Consumes: `AxisPin` from `./types`.
- Produces: `inferAxisPin(start, extent, refStart, refExtent, canStretch): AxisPin`, `inferPins(box, ref, canStretch): { h: PinH; v: PinV }` where boxes are `{x,y,w,h}` top-left in design px.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/responsive-infer.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { inferAxisPin, inferPins, SPAN_STRETCH, CENTER_TOL } from '~/lib/frame/responsive/infer'

describe('inferAxisPin', () => {
  const ref = 1000
  it('spans ≥ 80% and can stretch → both', () => {
    expect(inferAxisPin(100, 800, 0, ref, true)).toBe('both')
    expect(SPAN_STRETCH).toBe(0.8)
  })
  it('touches both edges → both, even below 80%? no — touching both edges means spanning 100%', () => {
    expect(inferAxisPin(0, 1000, 0, ref, true)).toBe('both')
  })
  it('spans ≥ 80% but cannot stretch → center', () => {
    expect(inferAxisPin(100, 800, 0, ref, false)).toBe('center')
  })
  it('centre within 4% of the reference centre → center', () => {
    expect(CENTER_TOL).toBe(0.04)
    expect(inferAxisPin(450, 100, 0, ref, false)).toBe('center')   // centre 500
    expect(inferAxisPin(420, 100, 0, ref, false)).toBe('center')   // centre 470, 3% off
  })
  it('otherwise the nearer edge', () => {
    expect(inferAxisPin(100, 100, 0, ref, false)).toBe('left')     // centre 150
    expect(inferAxisPin(800, 100, 0, ref, false)).toBe('right')    // centre 850
  })
  it('measures against the reference rectangle, not the frame', () => {
    // section from 500 to 900; a box at 520..600 is near the section's near edge
    expect(inferAxisPin(520, 80, 500, 400, false)).toBe('left')
    expect(inferAxisPin(820, 80, 500, 400, false)).toBe('right')
    expect(inferAxisPin(660, 80, 500, 400, false)).toBe('center') // centre 700 = section centre
  })
  it('never infers relative', () => {
    for (let x = 0; x < 900; x += 37) expect(inferAxisPin(x, 90, 0, ref, true)).not.toBe('relative')
  })
})

describe('inferPins', () => {
  it('a full-frame layer is a background: stretches both ways', () => {
    expect(inferPins({ x: 0, y: 0, w: 1920, h: 1080 }, { x: 0, y: 0, w: 1920, h: 1080 }, true))
      .toEqual({ h: 'both', v: 'both' })
  })
  it('uses vertical names on the vertical axis', () => {
    expect(inferPins({ x: 40, y: 40, w: 200, h: 60 }, { x: 0, y: 0, w: 1920, h: 1080 }, false))
      .toEqual({ h: 'left', v: 'top' })
    expect(inferPins({ x: 1600, y: 950, w: 200, h: 60 }, { x: 0, y: 0, w: 1920, h: 1080 }, false))
      .toEqual({ h: 'right', v: 'bottom' })
    expect(inferPins({ x: 860, y: 510, w: 200, h: 60 }, { x: 0, y: 0, w: 1920, h: 1080 }, false))
      .toEqual({ h: 'center', v: 'middle' })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/responsive-infer.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/frame/responsive/infer`.

- [ ] **Step 3: Write the module**

```ts
// frontend/app/lib/frame/responsive/infer.ts
import type { AxisPin, PinH, PinV } from './types'

/** Spanning this fraction of the reference (or more) reads as "stretch". */
export const SPAN_STRETCH = 0.8
/** A centre within this fraction of the reference centre reads as "centred". */
export const CENTER_TOL = 0.04

export interface Box { x: number; y: number; w: number; h: number }

/**
 * The default pin for one axis, from where a box sits inside its reference
 * rectangle (design px). This is THE replaceable rule: a later "Suggest pins"
 * step writes ordinary stored pins instead of changing this.
 *
 *   1. spans ≥ SPAN_STRETCH of the axis, or touches both edges, and can stretch → 'both'
 *   2. centre within CENTER_TOL of the reference centre → 'center'
 *   3. otherwise the nearer edge
 * 'relative' is never inferred.
 */
export function inferAxisPin(start: number, extent: number, refStart: number, refExtent: number, canStretch: boolean): AxisPin {
  if (refExtent <= 0) return 'center'
  const span = extent / refExtent
  const touchesBoth = start <= refStart + 1e-6 && start + extent >= refStart + refExtent - 1e-6
  if (span >= SPAN_STRETCH || touchesBoth) return canStretch ? 'both' : 'center'
  const c = start + extent / 2
  const refC = refStart + refExtent / 2
  if (Math.abs(c - refC) <= CENTER_TOL * refExtent) return 'center'
  return c < refC ? 'left' : 'right'
}

const V_NAME: Record<AxisPin, PinV> = { left: 'top', right: 'bottom', both: 'both', center: 'middle', relative: 'relative' }

/** Both axes at once, with the vertical axis spelled in its own names. */
export function inferPins(box: Box, ref: Box, canStretch: boolean): { h: PinH; v: PinV } {
  const h = inferAxisPin(box.x, box.w, ref.x, ref.w, canStretch)
  const v = V_NAME[inferAxisPin(box.y, box.h, ref.y, ref.h, canStretch)]
  return { h, v }
}

/** Vertical pin name → the axis-neutral name the maths uses. */
export function axisOfV(v: PinV): AxisPin {
  return v === 'top' ? 'left' : v === 'bottom' ? 'right' : v === 'middle' ? 'center' : v
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/responsive-infer.unit.spec.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

Paths: `frontend/app/lib/frame/responsive/infer.ts frontend/tests/unit/responsive-infer.unit.spec.ts`
Message: `feat(frame): inferPins — automatic pins from where a layer sits`

---

### Task 4: Grid at a box (`unitW`) and section lookup

**Files:**
- Modify: `frontend/app/lib/frame/grid.ts:195-236` (`resolveGrid`)
- Create: `frontend/app/lib/frame/responsive/sections.ts`
- Test: `frontend/tests/unit/responsive-sections.unit.spec.ts`

**Interfaces:**
- Consumes: `resolveGrid(grid, w, h)` today.
- Produces: `resolveGrid(grid, w, h, unitW = w)` — margins, gutter and base module are fractions of `unitW` instead of `w`; `sectionOf(box, regions, tol): number` (index or -1); `sectionsAt(grid, W0, H0, s, W, H)`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/responsive-sections.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { defaultGrid, resolveGrid } from '~/lib/frame/grid'
import { sectionOf, sectionsAt } from '~/lib/frame/responsive/sections'

describe('resolveGrid unitW', () => {
  it('omitted unitW is byte-identical to today', () => {
    const g = { ...defaultGrid(), mode: 'explicit' as const, columns: 3, rows: 2, margin: 0.1, gutter: 0.02 }
    expect(resolveGrid(g, 1200, 800, 1200)).toEqual(resolveGrid(g, 1200, 800))
  })
  it('margins and gutters scale with unitW, not with the box width', () => {
    const g = { ...defaultGrid(), mode: 'explicit' as const, columns: 2, rows: 1, margin: 0.1, gutter: 0 }
    // design 1000 wide, fitted (s = 1) into a 3000-wide box: margin stays 100px, not 300px
    const { xs } = resolveGrid(g, 3000, 1000, 1000)
    expect(xs[0]).toBe(100)
    expect(xs[xs.length - 1]).toBe(2900)
  })
  it('a generated grid keeps its region ORDER across sizes', () => {
    const g = { ...defaultGrid(), mode: 'generated' as const }
    const a = resolveGrid(g, 1200, 800)
    const b = resolveGrid(g, 2400, 800, 1200)
    expect(b.regions.length).toBe(a.regions.length)
    expect(b.xs.length).toBe(a.xs.length)
    expect(b.ys.length).toBe(a.ys.length)
  })
})

describe('sectionOf', () => {
  const regions = [
    { x: 0, y: 0, w: 500, h: 500 }, { x: 500, y: 0, w: 500, h: 500 },
  ]
  it('finds the single section a box lies inside (within tol)', () => {
    expect(sectionOf({ x: 40, y: 40, w: 300, h: 200 }, regions, 10)).toBe(0)
    expect(sectionOf({ x: 540, y: 40, w: 300, h: 200 }, regions, 10)).toBe(1)
    expect(sectionOf({ x: 495, y: 40, w: 300, h: 200 }, regions, 10)).toBe(1)  // 5px over, inside tol
  })
  it('returns -1 when it straddles or falls outside', () => {
    expect(sectionOf({ x: 300, y: 40, w: 400, h: 200 }, regions, 10)).toBe(-1)
    expect(sectionOf({ x: 40, y: 600, w: 100, h: 100 }, regions, 10)).toBe(-1)
  })
})

describe('sectionsAt', () => {
  it('returns the design regions and the box regions in the same order, or null when off', () => {
    expect(sectionsAt(null, 1000, 1000, 1, 1000, 1000)).toBeNull()
    const g = { ...defaultGrid(), mode: 'explicit' as const, columns: 2, rows: 2, margin: 0, gutter: 0 }
    const r = sectionsAt(g, 1000, 1000, 1, 2000, 1000)!
    expect(r.design.regions).toHaveLength(4)
    expect(r.box.regions).toHaveLength(4)
    expect(r.box.regions[1]).toEqual({ x: 1000, y: 0, w: 1000, h: 500 })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/responsive-sections.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/frame/responsive/sections`; the `unitW` test fails with margin 300.

- [ ] **Step 3: Add `unitW` to `resolveGrid`**

In `frontend/app/lib/frame/grid.ts`, change the signature and the three places that multiply by `w`:

```ts
/**
 * `unitW` (default `w`): the width every normalized grid dimension (margin, gutter,
 * base module) is a fraction OF. Today's callers omit it, so it is `w` and the
 * result is byte-identical. The responsive resolver passes the FITTED design width
 * so margins and gutters follow the fit scale while the columns share the box.
 */
export function resolveGrid(grid: FrameGrid, w: number, h: number, unitW: number = w): { xs: number[]; ys: number[]; regions: Rect[] } {
  if (grid.mode === 'off') return { xs: [], ys: [], regions: [] }
  const m = Math.min(Math.max(grid.margin, 0), 0.45)
  const mx = m * unitW, my = m * unitW   // margin normalized to the UNIT width on both axes (uniform inset)
  ...
    const modulePx = grid.baseModule * unitW
  ...
  const gutterPx = grid.gutter * unitW
  return { xs, ys, regions: applyGutter(regions, gutterPx) }
}
```

(Only the three `* w` → `* unitW` edits; everything else in the function stays.)

- [ ] **Step 4: Write `sections.ts`**

```ts
// frontend/app/lib/frame/responsive/sections.ts
import { resolveGrid, type FrameGrid, type Rect } from '~/lib/frame/grid'

export interface Box { x: number; y: number; w: number; h: number }

/** Index of the single region `box` lies inside (edges may overhang by `tol` px), else -1. */
export function sectionOf(box: Box, regions: Rect[], tol: number): number {
  let found = -1
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i]!
    const inside = box.x >= r.x - tol && box.y >= r.y - tol
      && box.x + box.w <= r.x + r.w + tol && box.y + box.h <= r.y + r.h + tol
    if (!inside) continue
    if (found >= 0) return -1   // inside two overlapping regions: ambiguous → frame
    found = i
  }
  return found
}

/**
 * The grid resolved twice: at the design size (design px) and at the box (box px,
 * with margins/gutters following the fit scale `s`). Region order is stable
 * between the two, so index i is the same section in both. null when the grid is off.
 */
export function sectionsAt(grid: FrameGrid | null, W0: number, H0: number, s: number, W: number, H: number):
  { design: ReturnType<typeof resolveGrid>; box: ReturnType<typeof resolveGrid> } | null {
  if (!grid || grid.mode === 'off') return null
  return { design: resolveGrid(grid, W0, H0), box: resolveGrid(grid, W, H, s * W0) }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/responsive-sections.unit.spec.ts tests/unit/frame-grid.unit.spec.ts`
Expected: PASS for both files (the existing grid spec proves byte-identity for today's callers).

- [ ] **Step 6: Commit**

Paths: `frontend/app/lib/frame/grid.ts frontend/app/lib/frame/responsive/sections.ts frontend/tests/unit/responsive-sections.unit.spec.ts`
Message: `feat(frame): resolveGrid unitW + section lookup for responsive pins`

---

### Task 5: Rigid units and design boxes

**Files:**
- Create: `frontend/app/lib/frame/responsive/units.ts`
- Test: `frontend/tests/unit/responsive-units.unit.spec.ts`

**Interfaces:**
- Consumes: `localLayerBox(ctx, layer, W, H)` (px, un-rotated, centred), `layerMaskRef(layer)`, `expandClones(cloner, aspect)`, `topGroupOf(id, groups)`, `layersInGroup(id, layers, groups)` (all existing), `Pins`.
- Produces:
  ```ts
  interface Unit { id: string; kind: 'layer' | 'group' | 'maskPair' | 'cloner'; memberIds: string[]; box: Box; pins: Pins | undefined; canStretch: boolean }
  buildUnits(layers, groups, ctx, W0, H0): Unit[]
  layerDesignBox(layer, ctx, W0, H0): Box   // outer box incl. rotation and cloner, design px, top-left
  ```

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/responsive-units.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { createRectLayer, createTextLayer, createImageLayer } from '~/composables/useCompositorLayers'
import { DEFAULT_CLONER } from '~/composables/useCloner'
import { buildUnits, layerDesignBox } from '~/lib/frame/responsive/units'

const W0 = 1000, H0 = 500

describe('layerDesignBox', () => {
  it('a rect: centre and width-normalized size → top-left px box', () => {
    const r = createRectLayer({ x: 0.5, y: 0.5, w: 0.2, h: 0.1 })
    expect(layerDesignBox(r, null, W0, H0)).toEqual({ x: 400, y: 200, w: 200, h: 100 })
  })
  it('a rotated rect uses its axis-aligned outer box', () => {
    const r = createRectLayer({ x: 0.5, y: 0.5, w: 0.2, h: 0.1, rotation: 90 })
    const b = layerDesignBox(r, null, W0, H0)
    expect(b.w).toBeCloseTo(100, 6); expect(b.h).toBeCloseTo(200, 6)
    expect(b.x).toBeCloseTo(450, 6); expect(b.y).toBeCloseTo(150, 6)
  })
  it('a cloner uses the full stamped extent', () => {
    const r = createRectLayer({ x: 0.2, y: 0.5, w: 0.1, h: 0.1, cloner: { ...DEFAULT_CLONER, enabled: true, mode: 'linear', countX: 3, countY: 1, spacingX: 0.2, spacingY: 0 } })
    const b = layerDesignBox(r, null, W0, H0)
    expect(b.x).toBeCloseTo(150, 6)         // first stamp at x=0.2 → 200 − 50
    expect(b.w).toBeCloseTo(500, 6)         // stamps at 0.2, 0.4, 0.6 → 150..650
  })
})

describe('buildUnits', () => {
  it('a plain layer is its own unit; shapes can stretch, images too, text only with a box', () => {
    const rect = createRectLayer({ id: 'r' })
    const img = createImageLayer('a.png', 1, { id: 'i' })
    const boxed = createTextLayer({ id: 't1', boxW: 0.3 })
    const free = createTextLayer({ id: 't2' })
    const units = buildUnits([rect, img, boxed, free], [], null, W0, H0)
    const by = Object.fromEntries(units.map(u => [u.id, u]))
    expect(by.r.canStretch).toBe(true)
    expect(by.i.canStretch).toBe(true)
    expect(by.t1.canStretch).toBe(true)
    expect(by.t2.canStretch).toBe(false)
  })
  it('rotated, skewed or corner-pinned layers cannot stretch', () => {
    const rot = createRectLayer({ id: 'a', rotation: 10 })
    const skew = createRectLayer({ id: 'b', skewX: 5 })
    const units = buildUnits([rot, skew], [], null, W0, H0)
    expect(units.every(u => !u.canStretch)).toBe(true)
  })
  it('members of a group form one group unit with the union box and the group pins', () => {
    const a = createRectLayer({ id: 'a', x: 0.2, y: 0.5, w: 0.1, h: 0.1, groupId: 'g' })
    const b = createRectLayer({ id: 'b', x: 0.6, y: 0.5, w: 0.1, h: 0.1, groupId: 'g' })
    const units = buildUnits([a, b], [{ id: 'g', pins: { h: 'right' } }], null, W0, H0)
    expect(units).toHaveLength(1)
    expect(units[0]!.kind).toBe('group')
    expect(units[0]!.memberIds.sort()).toEqual(['a', 'b'])
    expect(units[0]!.box).toEqual({ x: 150, y: 225, w: 500, h: 50 })
    expect(units[0]!.pins).toEqual({ h: 'right' })
    expect(units[0]!.canStretch).toBe(false)
  })
  it('a nested group belongs to its outermost group', () => {
    const a = createRectLayer({ id: 'a', groupId: 'inner' })
    const b = createRectLayer({ id: 'b', groupId: 'outer' })
    const units = buildUnits([a, b], [{ id: 'outer' }, { id: 'inner', parentId: 'outer' }], null, W0, H0)
    expect(units).toHaveLength(1)
    expect(units[0]!.id).toBe('outer')
  })
  it('a mask source and the layers it clips form one maskPair unit boxed by the source', () => {
    const src = createRectLayer({ id: 's', x: 0.5, y: 0.5, w: 0.4, h: 0.4 })
    const clipped = createImageLayer('p.png', 1, { id: 'c', x: 0.5, y: 0.5, w: 0.9, maskedByKey: 'l:s' })
    const units = buildUnits([src, clipped], [], null, W0, H0)
    expect(units).toHaveLength(1)
    expect(units[0]!.kind).toBe('maskPair')
    expect(units[0]!.box).toEqual({ x: 300, y: 150, w: 400, h: 400 })
    expect(units[0]!.pins).toBeUndefined()
  })
  it('a maskPair takes the SOURCE layer\'s pins', () => {
    const src = createRectLayer({ id: 's', pins: { h: 'left' } })
    const clipped = createImageLayer('p.png', 1, { id: 'c', maskedByKey: 'l:s', pins: { h: 'right' } })
    const units = buildUnits([src, clipped], [], null, W0, H0)
    expect(units[0]!.pins).toEqual({ h: 'left' })
  })
  it('a cloner layer is a cloner unit that cannot stretch', () => {
    const r = createRectLayer({ id: 'r', cloner: { ...DEFAULT_CLONER, enabled: true, countX: 2, countY: 1, spacingX: 0.2 } })
    const units = buildUnits([r], [], null, W0, H0)
    expect(units[0]!.kind).toBe('cloner')
    expect(units[0]!.canStretch).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/responsive-units.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/frame/responsive/units`.

- [ ] **Step 3: Write the module**

```ts
// frontend/app/lib/frame/responsive/units.ts
import { localLayerBox, layerMaskRef, cornerPinActive, type LocalLayer } from '~/composables/useCompositorLayers'
import { expandClones } from '~/composables/useCloner'
import { topGroupOf, layersInGroup, type LayerGroup } from '~/lib/compositor/layerGroups'
import type { Pins } from './types'

export interface Box { x: number; y: number; w: number; h: number }

export interface Unit {
  id: string
  kind: 'layer' | 'group' | 'maskPair' | 'cloner'
  memberIds: string[]
  /** Outer box at the design size, px, top-left. */
  box: Box
  /** The stored pins that apply to the whole unit (group's, mask source's, or the layer's). */
  pins: Pins | undefined
  /** Whether a 'both' pin may really change this unit's box (vs. placing it). */
  canStretch: boolean
}

const STRETCH_KINDS = new Set(['rect', 'ellipse', 'polygon', 'star', 'line', 'image', 'wired'])

/** Can this single layer's box be stretched by a 'both' pin? */
export function layerCanStretch(l: LocalLayer): boolean {
  if (l.rotation || l.skewX || l.skewY || cornerPinActive(l.cornerPin)) return false
  if (l.cloner?.enabled) return false
  if (l.kind === 'text') return (l.boxW ?? 0) > 0 && !l.path
  return STRETCH_KINDS.has(l.kind)
}

function unionBox(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}

/** Axis-aligned outer box of a w×h box rotated by `deg` about its centre. */
function rotatedExtent(w: number, h: number, deg: number): { w: number; h: number } {
  if (!deg) return { w, h }
  const a = (deg * Math.PI) / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a))
  return { w: w * c + h * s, h: w * s + h * c }
}

/**
 * A layer's outer box at the design size in px, top-left: the un-rotated box from
 * `localLayerBox`, rotated, then unioned across every cloner stamp.
 */
export function layerDesignBox(layer: LocalLayer, ctx: CanvasRenderingContext2D | null, W0: number, H0: number): Box {
  const base = localLayerBox(ctx, layer, W0, H0)
  const ext = rotatedExtent(base.w, base.h, layer.rotation || 0)
  let out: Box | null = null
  for (const c of expandClones(layer.cloner, W0 / H0)) {
    const cx = (layer.x + c.dx) * W0, cy = (layer.y + c.dy) * H0
    const e = rotatedExtent(base.w * c.dscale, base.h * c.dscale, (layer.rotation || 0) + c.drot)
    const b = { x: cx - e.w / 2, y: cy - e.h / 2, w: e.w, h: e.h }
    out = out ? unionBox(out, b) : b
  }
  return out ?? { x: layer.x * W0 - ext.w / 2, y: layer.y * H0 - ext.h / 2, w: ext.w, h: ext.h }
}

/**
 * Partition the layers into rigid units. Order of precedence: outermost group,
 * then shape-mask pair, then cloner, then a plain layer. Every layer lands in
 * exactly one unit.
 */
export function buildUnits(layers: LocalLayer[], groups: LayerGroup[], ctx: CanvasRenderingContext2D | null, W0: number, H0: number): Unit[] {
  const byId = new Map(layers.map(l => [l.id, l]))
  const boxOf = new Map<string, Box>()
  for (const l of layers) boxOf.set(l.id, layerDesignBox(l, ctx, W0, H0))
  const claimed = new Set<string>()
  const units: Unit[] = []
  const union = (ids: string[]): Box => ids.map(id => boxOf.get(id)!).reduce(unionBox)

  // 1. Groups: every member of an outermost group, including nested groups' members.
  const groupById = new Map(groups.map(g => [g.id, g]))
  for (const l of layers) {
    if (!l.groupId || claimed.has(l.id)) continue
    const top = topGroupOf(l.groupId, groups)
    const memberIds = layersInGroup(top, layers, groups).filter(id => byId.has(id))
    if (memberIds.length === 0) continue
    for (const id of memberIds) claimed.add(id)
    units.push({ id: top, kind: 'group', memberIds, box: union(memberIds), pins: groupById.get(top)?.pins, canStretch: false })
  }
  // 2. Shape-mask pairs: a local mask source plus everything it clips.
  const clippedBySource = new Map<string, string[]>()
  for (const l of layers) {
    const ref = layerMaskRef(l)
    if (!ref || !ref.startsWith('l:')) continue
    const srcId = ref.slice(2)
    if (!byId.has(srcId)) continue
    const list = clippedBySource.get(srcId)
    if (list) list.push(l.id); else clippedBySource.set(srcId, [l.id])
  }
  for (const [srcId, clippedIds] of clippedBySource) {
    if (claimed.has(srcId)) continue
    const memberIds = [srcId, ...clippedIds.filter(id => !claimed.has(id))]
    for (const id of memberIds) claimed.add(id)
    units.push({ id: srcId, kind: 'maskPair', memberIds, box: boxOf.get(srcId)!, pins: byId.get(srcId)!.pins, canStretch: false })
  }
  // 3. Cloners, then plain layers.
  for (const l of layers) {
    if (claimed.has(l.id)) continue
    claimed.add(l.id)
    if (l.cloner?.enabled) units.push({ id: l.id, kind: 'cloner', memberIds: [l.id], box: boxOf.get(l.id)!, pins: l.pins, canStretch: false })
    else units.push({ id: l.id, kind: 'layer', memberIds: [l.id], box: boxOf.get(l.id)!, pins: l.pins, canStretch: layerCanStretch(l) })
  }
  return units
}
```

Note: `localLayerBox` with `ctx = null` uses a rough text fallback (`chars × fontSize × 0.6`) — fine for tests; the app passes a scratch context.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/responsive-units.unit.spec.ts`
Expected: PASS (10 tests). If `layersInGroup` returns ids in a different order, sort in the test only (already done).

- [ ] **Step 5: Commit**

Paths: `frontend/app/lib/frame/responsive/units.ts frontend/tests/unit/responsive-units.unit.spec.ts`
Message: `feat(frame): rigid units — groups, mask pairs, cloners — and design boxes`

---

### Task 6: Per-kind stretch, image cover, text re-wrap

**Files:**
- Create: `frontend/app/lib/frame/responsive/stretch.ts`
- Test: `frontend/tests/unit/responsive-stretch.unit.spec.ts`

**Interfaces:**
- Consumes: `wrappedTextLines(ctx, layer, W)`, `wiredLayerHeight(layer)` from `~/lib/compositor/wiredLayer`.
- Produces:
  ```ts
  /** Rewrite ONE layer for its resolved box. `k` = layoutScale the painter will apply
   *  (box px per stored-unit px = s·W0/W, or W0/W for keepSize). Returns a NEW layer
   *  (or the same reference when nothing changes). */
  placeLayer(layer, target: { cx: number; cy: number; w?: number; h?: number }, W, H, k, ctx): LocalLayer
  textNaturalHeightPx(layer, boxWpx, ctx, W0): number   // design px, for pinned-edge anchoring
  ```

The painter draws a layer at box px = `stored × W × k` (Task 9). So a target size `T` px becomes stored `T / (W·k)`. Position: stored `x = cx / W`, `y = cy / H`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/responsive-stretch.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { createRectLayer, createTextLayer, createImageLayer } from '~/composables/useCompositorLayers'
import { placeLayer, textNaturalHeightPx } from '~/lib/frame/responsive/stretch'

const W = 2000, H = 1000, k = 0.5   // e.g. design 1000 wide fitted ×1 into a 2000 box → k = 0.5

describe('placeLayer', () => {
  it('position only: writes x/y, keeps every size field, new object', () => {
    const r = createRectLayer({ w: 0.2, h: 0.1 })
    const out = placeLayer(r, { cx: 1500, cy: 250 }, W, H, k, null)
    expect(out).not.toBe(r)
    expect(out.x).toBe(0.75); expect(out.y).toBe(0.25)
    expect((out as any).w).toBe(0.2); expect((out as any).h).toBe(0.1)
  })
  it('returns the same reference when nothing changes', () => {
    const r = createRectLayer({ x: 0.75, y: 0.25 })
    expect(placeLayer(r, { cx: 1500, cy: 250 }, W, H, k, null)).toBe(r)
  })
  it('a stretched rect gets the target size in stored units (T / (W·k)); radius untouched', () => {
    const r = createRectLayer({ w: 0.2, h: 0.1, radius: 0.02 })
    const out = placeLayer(r, { cx: 1000, cy: 500, w: 1800, h: 100 }, W, H, k, null) as any
    expect(out.w).toBeCloseTo(1.8, 9)      // 1800 / (2000 × 0.5)
    expect(out.h).toBeCloseTo(0.1, 9)
    expect(out.radius).toBe(0.02)
  })
  it('a stretched image is never distorted: it covers the box and gets a crop', () => {
    const img = createImageLayer('a.png', 2, { w: 0.4 })   // aspect 2 ⇒ h = 0.2
    const out = placeLayer(img, { cx: 1000, cy: 500, w: 1800, h: 300 }, W, H, k, null) as any
    // box in stored units: 1.8 × 0.3; image aspect 2 ⇒ cover ⇒ w = 1.8, h = 0.9 (too tall) → crop
    expect(out.w).toBeCloseTo(1.8, 9)
    expect(out.h).toBeCloseTo(0.9, 9)
    expect(out.mask).toEqual({ kind: 'rect', x: 0.5, y: 0.5, w: 1.8, h: 0.3 })
  })
  it('an image whose box is taller than its aspect covers by height', () => {
    const img = createImageLayer('a.png', 2, { w: 0.4 })
    const out = placeLayer(img, { cx: 1000, cy: 500, w: 200, h: 600 }, W, H, k, null) as any
    expect(out.h).toBeCloseTo(0.6, 9)
    expect(out.w).toBeCloseTo(1.2, 9)
  })
  it('a boxed text layer stretches its boxW; fontSize untouched', () => {
    const t = createTextLayer({ boxW: 0.3, fontSize: 0.05 })
    const out = placeLayer(t, { cx: 1000, cy: 500, w: 1500 }, W, H, k, null) as any
    expect(out.boxW).toBeCloseTo(1.5, 9)
    expect(out.fontSize).toBe(0.05)
  })
})

describe('textNaturalHeightPx', () => {
  const measure = (charPx: number) => ({
    measureText: (s: string) => ({ width: s.length * charPx }),
    set font(_v: string) {},
    letterSpacing: '0px', fontKerning: 'normal',
  } as unknown as CanvasRenderingContext2D)
  it('counts wrapped lines × line height at the design width', () => {
    // fontSize 0.05 of W0=1000 → 50px; 10px per char; box 300px → 30 chars per line
    const t = createTextLayer({ text: 'a'.repeat(25) + ' ' + 'b'.repeat(25), fontSize: 0.05, lineHeight: 1.2, boxW: 0.3 })
    expect(textNaturalHeightPx(t, 300, measure(10), 1000)).toBe(2 * 50 * 1.2)
    expect(textNaturalHeightPx(t, 600, measure(10), 1000)).toBe(1 * 50 * 1.2)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/responsive-stretch.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/frame/responsive/stretch`.

- [ ] **Step 3: Write the module**

```ts
// frontend/app/lib/frame/responsive/stretch.ts
import { wrappedTextLines, type LocalLayer, type TextLayer, type ImageLayer } from '~/composables/useCompositorLayers'

const EPS = 1e-9
const same = (a: number, b: number) => Math.abs(a - b) < EPS

export interface Target { cx: number; cy: number; w?: number; h?: number }

/**
 * Rewrite one layer for its resolved box (box px). `k` is the layoutScale the
 * painter will apply, so a size of T px is stored as T / (W·k). Position only
 * when `w`/`h` are absent. Returns the SAME reference when nothing changes.
 */
export function placeLayer(layer: LocalLayer, t: Target, W: number, H: number, k: number, ctx: CanvasRenderingContext2D | null): LocalLayer {
  const x = t.cx / W, y = t.cy / H
  const unit = W * k
  const patch: Record<string, unknown> = {}
  if (!same(layer.x, x)) patch.x = x
  if (!same(layer.y, y)) patch.y = y
  if (t.w != null || t.h != null) stretchInto(layer, t, unit, x, y, patch)
  if (Object.keys(patch).length === 0) return layer
  return { ...layer, ...patch } as LocalLayer
}

// `cx`/`cy` = the layer's resolved centre in the box's normalized space: a crop mask
// (`LayerMask`) is stored in CANVAS space, so a cover-and-crop mask is centred there.
function stretchInto(layer: LocalLayer, t: Target, unit: number, cx: number, cy: number, patch: Record<string, unknown>) {
  const tw = t.w != null ? t.w / unit : undefined
  const th = t.h != null ? t.h / unit : undefined
  switch (layer.kind) {
    case 'rect': case 'ellipse': case 'polygon': case 'star': {
      if (tw != null && !same(layer.w, tw)) patch.w = tw
      if (th != null && !same(layer.h, th)) patch.h = th
      return
    }
    case 'line': {
      if (tw != null && !same(layer.w, tw)) patch.w = tw
      return
    }
    case 'text': {
      if (tw != null && (layer.boxW ?? 0) > 0 && !same(layer.boxW!, tw)) patch.boxW = tw
      if (th != null && (layer.boxH ?? 0) > 0 && !same(layer.boxH!, th)) patch.boxH = th
      return
    }
    case 'image': case 'wired': {
      // Never distort: cover the target box, crop the overflow with a rect mask
      // centred on the layer (mask coords are normalized like the layer's own).
      const aspect = layer.kind === 'image' ? (layer as ImageLayer).h / (layer as ImageLayer).w : (layer as { lastAspect: number }).lastAspect
      const boxW = tw ?? layer.w, boxH = th ?? layer.w * aspect
      const byW = { w: boxW, h: boxW * aspect }
      const cover = byW.h >= boxH - EPS ? byW : { w: boxH / aspect, h: boxH }
      if (!same(layer.w, cover.w)) patch.w = cover.w
      if (layer.kind === 'image' && !same((layer as ImageLayer).h, cover.h)) patch.h = cover.h
      const needsCrop = cover.w > boxW + EPS || cover.h > boxH + EPS
      if (needsCrop) patch.mask = { kind: 'rect', x: cx, y: cy, w: boxW, h: boxH }
      return
    }
    default: return   // path, brush, deal, scatter: placed only
  }
}

/** Natural height of a boxed text layer at `boxWpx` (design px) — wrapped lines × line height. */
export function textNaturalHeightPx(layer: TextLayer, boxWpx: number, ctx: CanvasRenderingContext2D | null, W0: number): number {
  const probe: TextLayer = { ...layer, boxW: boxWpx / W0 }
  const lines = wrappedTextLines(ctx, probe, W0)
  const lineH = layer.fontSize * W0 * layer.lineHeight
  return Math.max(lines.length, 1) * lineH
}
```

`LayerMask` (useCompositorLayers.ts:295) is in CANVAS space ("normalized center X of width / Y of height"), which is why the crop mask is written at the layer's resolved centre `cx, cy`; in the test that centre is `0.5, 0.5`. The mask's `w`/`h` are width-normalized like every other size.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/responsive-stretch.unit.spec.ts`
Expected: PASS (7 tests). `wrappedTextLines` calls `applyFont(ctx, …)`, which sets `ctx.font` and reads `ctx.letterSpacing`; the fake context in the test provides both.

- [ ] **Step 5: Commit**

Paths: `frontend/app/lib/frame/responsive/stretch.ts frontend/tests/unit/responsive-stretch.unit.spec.ts`
Message: `feat(frame): per-kind stretch — shapes, image cover-and-crop, text box`

---

### Task 7: Motion remap

**Files:**
- Create: `frontend/app/lib/frame/responsive/motion.ts`
- Test: `frontend/tests/unit/responsive-motion.unit.spec.ts`

**Interfaces:**
- Consumes: `FrameMotion` (`~/lib/motion/types`), `Track`/`Keyframe` (`~/lib/motionx/types`), `evaluateTracks`, `AxisMap`, `applyMap`.
- Produces: `remapMotion(motion, maps, W0, H0, W, H): FrameMotion | null` — same reference when no `layers.<id>.x|y` track targets a mapped layer.

Track values for `x`/`y` are the layer's normalized centre (0..1 of design W/H, see `animatableProperties` min 0 max 1). Mapped value: `applyMap(m.h, v·W0) / W` (and `/H` for y).

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/responsive-motion.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { remapMotion } from '~/lib/frame/responsive/motion'
import { axisMap, applyMap } from '~/lib/frame/responsive/axis'
import { evaluateTracks } from '~/lib/motionx/evaluate'
import type { FrameMotion } from '~/lib/motion/types'
import type { Track } from '~/lib/motionx/types'

const W0 = 1000, H0 = 500, W = 2000, H = 500   // fit s = 1, spare x = 1000
const maps = new Map([['a', { h: axisMap('right', W0, 1, 1000, 0), v: axisMap('center', H0, 1, 0, 0) }]])

const track = (path: string, a: number, b: number): Track => ({
  path, type: 'number',
  keyframes: [{ t: 0, value: a, ease: { type: 'linear' } as any }, { t: 1, value: b, ease: { type: 'linear' } as any }],
})

describe('remapMotion', () => {
  it('returns the same reference when nothing targets a mapped layer', () => {
    const m: FrameMotion = { fps: 30, duration: 1, motionx: [track('layers.zzz.x', 0, 1)] }
    expect(remapMotion(m, maps, W0, H0, W, H)).toBe(m)
    expect(remapMotion(null, maps, W0, H0, W, H)).toBeNull()
  })
  it('maps x keyframes through the layer\'s horizontal map and y through the vertical', () => {
    const m: FrameMotion = { fps: 30, duration: 1, motionx: [track('layers.a.x', 0.1, 0.5), track('layers.a.y', 0.2, 0.8)] }
    const out = remapMotion(m, maps, W0, H0, W, H)!
    expect(out).not.toBe(m)
    const [tx, ty] = out.motionx!
    expect(tx.keyframes[0]!.value).toBeCloseTo(applyMap(maps.get('a')!.h, 0.1 * W0) / W, 9)   // (100 + 1000)/2000
    expect(tx.keyframes[1]!.value).toBeCloseTo((500 + 1000) / 2000, 9)
    expect(ty.keyframes[0]!.value).toBeCloseTo(0.2, 9)   // vertical: no spare, s = 1
  })
  it('map-then-interpolate equals interpolate-then-map (the map is a straight line)', () => {
    const m: FrameMotion = { fps: 30, duration: 1, motionx: [track('layers.a.x', 0.1, 0.9)] }
    const out = remapMotion(m, maps, W0, H0, W, H)!
    for (const t of [0.25, 0.5, 0.75]) {
      const mapped = evaluateTracks(out.motionx!, t).get('layers.a.x') as number
      const raw = evaluateTracks(m.motionx!, t).get('layers.a.x') as number
      expect(mapped).toBeCloseTo(applyMap(maps.get('a')!.h, raw * W0) / W, 9)
    }
  })
  it('leaves scale, rotation, opacity and effect tracks untouched (same track reference)', () => {
    const s = track('layers.a.scale', 1, 2), r = track('layers.a.rotation', 0, 90)
    const m: FrameMotion = { fps: 30, duration: 1, motionx: [s, r, track('layers.a.x', 0, 1)] }
    const out = remapMotion(m, maps, W0, H0, W, H)!
    expect(out.motionx![0]).toBe(s); expect(out.motionx![1]).toBe(r)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/responsive-motion.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/frame/responsive/motion`.

- [ ] **Step 3: Write the module**

```ts
// frontend/app/lib/frame/responsive/motion.ts
import type { FrameMotion } from '~/lib/motion/types'
import type { Track } from '~/lib/motionx/types'
import { applyMap } from './axis'
import type { AxisMap } from './types'

const POS = /^layers\.([^.]+)\.(x|y)$/

/**
 * Map every `layers.<id>.x` / `.y` track through that layer's per-axis map so a
 * keyframed position adapts exactly like the resting position. Same reference
 * when no track is affected. Tracks for other properties come back by identity.
 */
export function remapMotion(
  motion: FrameMotion | null,
  maps: Map<string, { h: AxisMap; v: AxisMap }>,
  W0: number, H0: number, W: number, H: number,
): FrameMotion | null {
  if (!motion?.motionx?.length) return motion
  let changed = false
  const motionx = motion.motionx.map((tr): Track => {
    const m = tr.path.match(POS)
    if (!m) return tr
    const lm = maps.get(m[1]!)
    if (!lm) return tr
    const isX = m[2] === 'x'
    const map = isX ? lm.h : lm.v
    const design = isX ? W0 : H0, box = isX ? W : H
    changed = true
    return {
      ...tr,
      keyframes: tr.keyframes.map(kf => typeof kf.value === 'number'
        ? { ...kf, value: applyMap(map, kf.value * design) / box }
        : kf),
    }
  })
  return changed ? { ...motion, motionx } : motion
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/responsive-motion.unit.spec.ts`
Expected: PASS (4 tests). If `Ease` needs a specific shape for `'linear'`, read `frontend/app/lib/motionx/types.ts:1-15` and use the `NamedEase` literal it defines.

- [ ] **Step 5: Commit**

Paths: `frontend/app/lib/frame/responsive/motion.ts frontend/tests/unit/responsive-motion.unit.spec.ts`
Message: `feat(frame): remap position keyframes through the layer's pin maps`

---

### Task 8: `resolveLayout` — the orchestrator

**Files:**
- Create: `frontend/app/lib/frame/responsive/resolve.ts`
- Create: `frontend/app/lib/frame/responsive/index.ts`
- Test: `frontend/tests/unit/responsive-resolve.unit.spec.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `resolveLayout(frame: FrameDoc, W: number, H: number, opts?: ResolveOptions): LayoutResult`; `layoutScaleOf(layer): number` (reads the transient field, default 1). The transient field on a resolved layer is `layoutScale?: number` — declared on `LayerCommon` in Task 9; until then written through a cast.

Algorithm:
1. `if (!frame.responsive || frame.layers.length === 0) return identity`.
2. `s = fitScale`, `spare = spareRoom`. `k = s·W0/W` (the layoutScale for every non-keepSize layer; keepSize → `W0/W`).
3. `sections = sectionsAt(grid, W0, H0, s, W, H)`.
4. `units = buildUnits(layers, groups, ctx, W0, H0)`.
5. For each unit: reference rect = the design section it sits in (`sectionOf(unit.box, sections.design.regions, 0.01·W0)`) unless `pins.holdTo === 'frame'` or none → the frame `{0,0,W0,H0}`. The box-side reference is the matching box region or `{0,0,W,H}`.
   - Per axis: pin = stored or `inferAxisPin(...)` with `canStretch = unit.canStretch`. Spare for the reference: `refBoxExtent − s·refDesignExtent`, guarded with `guardedRoom(spareRef, s·refDesignExtent)`; `o` is added to the box reference start. `AxisMap = { kind, s, u, o: refBoxStart + o, ref: refDesignExtent, refStart: refDesignStart }`.
   - A `'both'` pin on a unit that cannot stretch is treated as `'center'` for placement.
   - A `'both'` pin whose design gap to the reference edge is ≤ 0 on that side holds to the real box edge on that side (background bleed): near edge → `refBoxStart`, far edge → `refBoxStart + refBoxExtent`.
6. Unit box → target: near/far edges through the maps. For a stretching unit the target has `w`/`h`; otherwise the target is the mapped centre (`applyMap(m, cx)`), sized `unit.box × k_size` implicitly by the painter.
7. Members: for a multi-member unit, each member's centre is mapped by the unit's centre map: `member_cx' = unit_cx' + (member_cx − unit_cx)·s` (rigid). Text re-wrap anchoring (top/bottom pin keeps that edge) applies to single-layer boxed-text units only: compute `textNaturalHeightPx` at the new box width (in design px = target.w / s), then place the centre at `top' + naturalH·s/2` (top pin) or `bottom' − naturalH·s/2` (bottom pin); centre/relative pins keep the mapped centre.
8. `layers' = layers.map(placeLayer(...))` with `layoutScale` attached when `k ≠ 1` (or `W0/W ≠ 1` for keepSize). Stack order is untouched.
9. `boxes`, `maps` per unit member; `motion' = remapMotion`.
10. Identity: when every mapped layer came back by reference and no `layoutScale` was attached → return the input arrays/objects.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/responsive-resolve.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { createRectLayer, createTextLayer, createImageLayer } from '~/composables/useCompositorLayers'
import { defaultGrid } from '~/lib/frame/grid'
import { resolveLayout, layoutScaleOf } from '~/lib/frame/responsive'
import type { FrameDoc } from '~/lib/frame/responsive/types'

const doc = (layers: FrameDoc['layers'], extra: Partial<FrameDoc> = {}): FrameDoc => ({
  responsive: true, designW: 1000, designH: 500, layers, stackOrder: layers.map(l => `l:${l.id}` as any),
  groups: [], grid: null, motion: null, ...extra,
})

describe('resolveLayout identity', () => {
  it('a fixed Frame comes back by reference', () => {
    const l = [createRectLayer()]
    const r = resolveLayout(doc(l, { responsive: false }), 3000, 500)
    expect(r.identity).toBe(true); expect(r.layers).toBe(l)
  })
  it('the design size comes back by reference', () => {
    const l = [createRectLayer(), createTextLayer()]
    const r = resolveLayout(doc(l), 1000, 500)
    expect(r.identity).toBe(true); expect(r.layers).toBe(l); expect(r.layers[0]).toBe(l[0])
  })
  it('the same shape at another size is identity too (k = 1) unless a layer keeps its size', () => {
    const l = [createRectLayer()]
    expect(resolveLayout(doc(l), 2000, 1000).identity).toBe(true)
    const keep = [createRectLayer({ pins: { keepSize: true } })]
    const r = resolveLayout(doc(keep), 2000, 1000)
    expect(r.identity).toBe(false)
    expect(layoutScaleOf(r.layers[0]!)).toBeCloseTo(0.5, 9)   // W0/W
  })
})

describe('resolveLayout pins (wider box: 1000×500 design in 3000×500)', () => {
  // s = 1, spare x = 2000, guard: u = 1000, o = 500
  it('a left-hugging layer keeps its distance from the left edge (plus the guard offset)', () => {
    const l = createRectLayer({ x: 0.1, y: 0.5, w: 0.1, h: 0.1 })   // centre 100, box 50..150
    const r = resolveLayout(doc([l]), 3000, 500)
    expect(r.layers[0]!.x * 3000).toBeCloseTo(500 + 100, 6)
    expect(r.layers[0]!.y).toBeCloseTo(0.5, 9)
    expect(layoutScaleOf(r.layers[0]!)).toBeCloseTo(1000 / 3000, 9)   // s·W0/W
    expect(r.boxes.get(l.id)).toEqual({ x: 550, y: 225, w: 100, h: 50 })
  })
  it('a right-hugging layer keeps its distance from the right edge', () => {
    const l = createRectLayer({ x: 0.9, y: 0.5, w: 0.1, h: 0.1 })   // centre 900
    const r = resolveLayout(doc([l]), 3000, 500)
    expect(r.layers[0]!.x * 3000).toBeCloseTo(500 + 900 + 1000, 6)
  })
  it('a centred layer stays centred', () => {
    const l = createRectLayer({ x: 0.5, y: 0.5, w: 0.1, h: 0.1 })
    const r = resolveLayout(doc([l]), 3000, 500)
    expect(r.layers[0]!.x).toBeCloseTo(0.5, 9)
  })
  it('a full-frame background stretches to the REAL box edges (bleed), ignoring the guard', () => {
    const bg = createRectLayer({ x: 0.5, y: 0.5, w: 1, h: 0.5 })
    const r = resolveLayout(doc([bg]), 3000, 500)
    expect(r.boxes.get(bg.id)).toEqual({ x: 0, y: 0, w: 3000, h: 500 })
  })
  it('an explicit relative pin slides proportionally', () => {
    const l = createRectLayer({ x: 0.25, y: 0.5, w: 0.1, h: 0.1, pins: { h: 'relative' } })
    const r = resolveLayout(doc([l]), 3000, 500)
    expect(r.layers[0]!.x * 3000).toBeCloseTo(500 + 250 + 1000 * 0.25, 6)
  })
  it('a wide boxed text stretches its box and, top-pinned, keeps its top edge', () => {
    const t = createTextLayer({ x: 0.5, y: 0.1, boxW: 0.9, fontSize: 0.05, lineHeight: 1, text: 'x' })
    const measure = { measureText: (s: string) => ({ width: s.length * 10 }), set font(_v: string) {}, letterSpacing: '0px' } as unknown as CanvasRenderingContext2D
    const r = resolveLayout(doc([t]), 3000, 500, { measureCtx: measure })
    const out = r.layers[0]! as any
    expect(out.boxW * 3000 * layoutScaleOf(out)).toBeCloseTo(900 + 1000, 6)   // stretched by u
  })
})

describe('resolveLayout narrower box (1000×500 design in 500×500)', () => {
  // s = 0.5, spare y = 250, guard u = 250, o = 0
  it('everything shrinks; a top layer keeps its top gap scaled, a bottom layer its bottom gap', () => {
    const top = createRectLayer({ id: 'top', x: 0.5, y: 0.1, w: 0.1, h: 0.1 })     // top edge y = 25
    const bot = createRectLayer({ id: 'bot', x: 0.5, y: 0.9, w: 0.1, h: 0.1 })     // bottom edge y = 475
    const r = resolveLayout(doc([top, bot]), 500, 500)
    expect(r.boxes.get('top')!.y).toBeCloseTo(12.5, 6)
    expect(r.boxes.get('bot')!.y + r.boxes.get('bot')!.h).toBeCloseTo(500 - 12.5, 6)
    expect(layoutScaleOf(r.layers[0]!)).toBeCloseTo(1, 9)   // s·W0/W = 0.5·1000/500
  })
})

describe('resolveLayout units and sections', () => {
  it('a group moves as one rigid unit by the group\'s pins', () => {
    const a = createRectLayer({ id: 'a', x: 0.1, y: 0.5, w: 0.1, h: 0.1, groupId: 'g' })
    const b = createRectLayer({ id: 'b', x: 0.3, y: 0.5, w: 0.1, h: 0.1, groupId: 'g' })
    const r = resolveLayout(doc([a, b], { groups: [{ id: 'g', pins: { h: 'right' } }] }), 3000, 500)
    const ax = r.layers[0]!.x * 3000, bx = r.layers[1]!.x * 3000
    expect(bx - ax).toBeCloseTo(200, 6)                   // arrangement kept (s = 1)
    expect(ax).toBeCloseTo(500 + 100 + 1000, 6)           // right pin
  })
  it('a layer inside a grid section holds to that section', () => {
    const grid = { ...defaultGrid(), mode: 'explicit' as const, columns: 2, rows: 1, margin: 0, gutter: 0 }
    // section 0 spans 0..500 at the design; layer near its right edge
    const l = createRectLayer({ x: 0.45, y: 0.5, w: 0.05, h: 0.1 })   // box 425..475
    const r = resolveLayout(doc([l], { grid }), 3000, 500)
    // box grid: 2 columns of 1500 (s = 1, spare shared); section 0 = 0..1500, spare 1000 → u 500 o 250
    // right pin inside section 0: 250 + 450 + 500 = 1200
    expect(r.layers[0]!.x * 3000).toBeCloseTo(1200, 6)
    expect(r.grid!.regions[0]).toEqual({ x: 0, y: 0, w: 1500, h: 500 })
  })
  it('holdTo: frame overrides the section', () => {
    const grid = { ...defaultGrid(), mode: 'explicit' as const, columns: 2, rows: 1, margin: 0, gutter: 0 }
    const l = createRectLayer({ x: 0.45, y: 0.5, w: 0.05, h: 0.1, pins: { holdTo: 'frame' } })
    const r = resolveLayout(doc([l], { grid }), 3000, 500)
    expect(r.layers[0]!.x * 3000).toBeCloseTo(500 + 450, 6)   // left of the frame centre → left pin
  })
  it('motion tracks are remapped and non-position tracks kept', () => {
    const l = createRectLayer({ id: 'a', x: 0.1, y: 0.5, w: 0.1, h: 0.1 })
    const motion = { fps: 30, duration: 1, motionx: [{ path: 'layers.a.x', type: 'number', keyframes: [{ t: 0, value: 0.1, ease: { type: 'linear' } }, { t: 1, value: 0.2, ease: { type: 'linear' } }] }] } as any
    const r = resolveLayout(doc([l], { motion }), 3000, 500)
    expect(r.motion!.motionx![0]!.keyframes[0]!.value).toBeCloseTo((500 + 100) / 3000, 9)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/responsive-resolve.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/frame/responsive`.

- [ ] **Step 3: Write `resolve.ts` and `index.ts`**

```ts
// frontend/app/lib/frame/responsive/layoutScale.ts
// No imports on purpose: the painter (useCompositorLayers.ts) imports this at runtime,
// and units.ts imports the painter at runtime, so nothing here may import the resolver.

/** The transient draw-time scale a responsive layout asks the painter for. 1 when absent. */
export function layoutScaleOf(layer: { layoutScale?: number }): number {
  const v = layer.layoutScale
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 1
}
```

```ts
// frontend/app/lib/frame/responsive/index.ts
export { resolveLayout } from './resolve'
export { layoutScaleOf } from './layoutScale'
export type { Pins, PinH, PinV, FrameDoc, ResolveOptions, LayoutResult, ResolvedBox, AxisMap } from './types'
```

```ts
// frontend/app/lib/frame/responsive/resolve.ts
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { fitScale, spareRoom, guardedRoom, applyMap } from './axis'
import { inferAxisPin, axisOfV } from './infer'
import { sectionsAt, sectionOf } from './sections'
import { buildUnits, type Box } from './units'
import { placeLayer, textNaturalHeightPx } from './stretch'
import { remapMotion } from './motion'
import type { AxisMap, AxisPin, FrameDoc, LayoutResult, ResolveOptions, ResolvedBox } from './types'

interface Ref { design: Box; box: Box }

function identityResult(frame: FrameDoc, gridBox: LayoutResult['grid']): LayoutResult {
  return { layers: frame.layers, motion: frame.motion, grid: gridBox, boxes: new Map(), maps: new Map(), identity: true }
}

/** One axis of one unit: the map plus the resolved near/far edges in box px. */
function resolveAxis(
  kind: AxisPin, canStretch: boolean, s: number,
  uStart: number, uExtent: number,          // the unit's design box on this axis
  ref: { dStart: number; dExtent: number; bStart: number; bExtent: number },
  kSize: number, W: number,                 // kSize: px per design px for this unit's SIZE (s, or 1 for keepSize)
): { map: AxisMap; near: number; far: number; stretched: boolean } {
  const spare = ref.bExtent - s * ref.dExtent
  const { u, o } = guardedRoom(Math.max(0, spare), s * ref.dExtent)
  const effective: AxisPin = kind === 'both' && !canStretch ? 'center' : kind
  const map: AxisMap = { kind: effective, s, u, o: ref.bStart + o, ref: ref.dExtent, refStart: ref.dStart }
  const size = uExtent * kSize
  if (effective === 'both') {
    // Bleed: a side whose design gap to the reference edge is ≤ 0 holds the REAL edge.
    const nearGap = uStart - ref.dStart, farGap = ref.dStart + ref.dExtent - (uStart + uExtent)
    const near = nearGap <= 1e-6 ? ref.bStart : applyMap(map, uStart, 'near')
    const far = farGap <= 1e-6 ? ref.bStart + ref.bExtent : applyMap(map, uStart + uExtent, 'far')
    return { map, near, far, stretched: true }
  }
  const c = applyMap(map, uStart + uExtent / 2)
  return { map, near: c - size / 2, far: c + size / 2, stretched: false }
}

export function resolveLayout(frame: FrameDoc, W: number, H: number, opts: ResolveOptions = {}): LayoutResult {
  const { designW: W0, designH: H0 } = frame
  if (!frame.responsive || frame.layers.length === 0 || !(W0 > 0) || !(H0 > 0)) return identityResult(frame, null)
  const s = fitScale(W0, H0, W, H)
  const spare = spareRoom(W0, H0, W, H)
  const k = s * W0 / W                       // layoutScale for every non-keepSize layer
  const kKeep = W0 / W                        // layoutScale for a keepSize layer
  const ctx = opts.measureCtx ?? null
  const sections = sectionsAt(frame.grid, W0, H0, s, W, H)
  const gridOut: LayoutResult['grid'] = sections ? { xs: sections.box.xs, ys: sections.box.ys, regions: sections.box.regions } : null
  const units = buildUnits(frame.layers, frame.groups, ctx, W0, H0)
  const hasKeep = units.some(u => u.pins?.keepSize)
  if (spare.x === 0 && spare.y === 0 && Math.abs(k - 1) < 1e-12 && !hasKeep) return identityResult(frame, gridOut)

  const frameRef: Ref = { design: { x: 0, y: 0, w: W0, h: H0 }, box: { x: 0, y: 0, w: W, h: H } }
  const byId = new Map(frame.layers.map(l => [l.id, l]))
  const boxes = new Map<string, ResolvedBox>()
  const maps = new Map<string, { h: AxisMap; v: AxisMap }>()
  const placed = new Map<string, LocalLayer>()

  for (const unit of units) {
    // Reference rectangle: the design section the unit sits in, unless held to the frame.
    let ref = frameRef
    if (sections && unit.pins?.holdTo !== 'frame') {
      const i = sectionOf(unit.box, sections.design.regions, 0.01 * W0)
      if (i >= 0) ref = { design: sections.design.regions[i]!, box: sections.box.regions[i]! }
    }
    const keep = !!unit.pins?.keepSize
    const kSize = keep ? 1 : s
    const kLayer = keep ? kKeep : k
    const hPin: AxisPin = unit.pins?.h ?? inferAxisPin(unit.box.x, unit.box.w, ref.design.x, ref.design.w, unit.canStretch)
    const vPin: AxisPin = unit.pins?.v ? axisOfV(unit.pins.v) : inferAxisPin(unit.box.y, unit.box.h, ref.design.y, ref.design.h, unit.canStretch)
    const hx = resolveAxis(hPin, unit.canStretch, s, unit.box.x, unit.box.w, { dStart: ref.design.x, dExtent: ref.design.w, bStart: ref.box.x, bExtent: ref.box.w }, kSize, W)
    const vy = resolveAxis(vPin, unit.canStretch, s, unit.box.y, unit.box.h, { dStart: ref.design.y, dExtent: ref.design.h, bStart: ref.box.y, bExtent: ref.box.h }, kSize, W)
    const unitBox: ResolvedBox = { x: hx.near, y: vy.near, w: hx.far - hx.near, h: vy.far - vy.near }
    const ucx = unit.box.x + unit.box.w / 2, ucy = unit.box.y + unit.box.h / 2
    const ucx2 = unitBox.x + unitBox.w / 2, ucy2 = unitBox.y + unitBox.h / 2

    for (const id of unit.memberIds) {
      const layer = byId.get(id)!
      maps.set(id, { h: hx.map, v: vy.map })
      let target: { cx: number; cy: number; w?: number; h?: number }
      if (unit.kind === 'layer') {
        target = { cx: ucx2, cy: ucy2 }
        if (hx.stretched) target.w = unitBox.w
        if (vy.stretched) target.h = unitBox.h
        // A boxed text with a stretched width: its height changes with the re-wrap, so a
        // top/bottom pin keeps THAT edge instead of the centre.
        if (layer.kind === 'text' && hx.stretched && !vy.stretched && ctx) {
          const natural = textNaturalHeightPx(layer, unitBox.w / kSize, ctx, W0) * kSize
          if (vPin === 'left') target.cy = vy.near + natural / 2
          else if (vPin === 'right') target.cy = vy.far - natural / 2
        }
        boxes.set(id, { x: target.cx - (target.w ?? unit.box.w * kSize) / 2, y: target.cy - (target.h ?? unit.box.h * kSize) / 2, w: target.w ?? unit.box.w * kSize, h: target.h ?? unit.box.h * kSize })
      } else {
        // Rigid unit: members keep their arrangement, scaled by kSize about the unit centre.
        // Selection and pins act on the UNIT, so every member reports the unit's box.
        const lcx = layer.x * W0, lcy = layer.y * H0
        target = { cx: ucx2 + (lcx - ucx) * kSize, cy: ucy2 + (lcy - ucy) * kSize }
        boxes.set(id, unitBox)
      }
      let out = placeLayer(layer, target, W, H, kLayer, ctx)
      if (Math.abs(kLayer - 1) > 1e-12) out = { ...out, layoutScale: kLayer } as unknown as LocalLayer
      placed.set(id, out)
    }
  }

  let changed = false
  const layers = frame.layers.map(l => { const p = placed.get(l.id) ?? l; if (p !== l) changed = true; return p })
  const motion = remapMotion(frame.motion, maps, W0, H0, W, H)
  if (!changed && motion === frame.motion) return identityResult(frame, gridOut)
  return { layers, motion, grid: gridOut, boxes, maps, identity: false }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/responsive-resolve.unit.spec.ts`
Expected: PASS (13 tests). Work through failures one at a time; the expected numbers in the tests are derived by hand from the spec's formulas and are the source of truth — if a number disagrees with the code, re-derive it with the formula in the test's comment before changing either.

- [ ] **Step 5: Run every responsive spec together, then commit**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/responsive-`
Expected: all PASS.

Paths: `frontend/app/lib/frame/responsive/resolve.ts frontend/app/lib/frame/responsive/layoutScale.ts frontend/app/lib/frame/responsive/index.ts frontend/tests/unit/responsive-resolve.unit.spec.ts`
Message: `feat(frame): resolveLayout — pins, sections, units, text anchoring, identity fast path`

---

### Task 9: The painter hook — `layoutScale` (the spike)

**Files:**
- Modify: `frontend/app/composables/useCompositorLayers.ts` — `LayerCommon` (add the transient field), the per-layer draw-scale sites (see Step 3), `localLayerBox` (no change), `drawLayerSilhouette` / stroke-mask transform (`:2160-2180`).
- Test: `frontend/tests/unit/responsive-paint-scale.unit.spec.ts`

**Interfaces:**
- Consumes: `layoutScaleOf(layer)` from `~/lib/frame/responsive/layoutScale` (dependency-free, so the composable can import it at runtime without a cycle).
- Produces: a resolved layer with `layoutScale = k` draws with every size multiplied by `k` about its OWN centre — content, stroke, crop, cloner stamps, mask silhouette, stroke mask — and a layer without it draws byte-identically to today.

Why this is the spike: today's `motionScale` wraps a whole item in `paintLayerStack` (line ~5704) by scaling about the CONTENT layer's centre, so a mask source drawn inside that wrapper gets scaled about the wrong point. `layoutScale` must instead be applied where each layer's own transform is built. The candidate sites, found with `grep -n "c.dscale\|applyXform(\|ctx.rotate((layer.rotation" app/composables/useCompositorLayers.ts`:

1. `const applyXform = (c, lx2, ly2, lrot2, ls2)` at `:2651` and its callers `:2871`, `:2885`, `:2986` — the effected path; `ls` comes from `const ls = c.dscale` at `:2827`.
2. The plain cloner loop at `:6017-6021` — `ctx.scale(layer.scale * c.dscale, layer.scale * c.dscale)`.
3. The mask silhouette / stroke-mask transform at `:2177` (`mctx.rotate(...)` after `mctx.translate(...)`).
4. `drawLayerSilhouette` at `:2107` — read it; if it builds its own transform, add the scale there too.

Rule for each site: right after the layer's `translate(+rotate)` and before any size-bearing draw, multiply the existing scale (or add `c.scale(k, k)` where there is none) with `k = layoutScaleOf(layer)`, guarded so `k === 1` adds no call.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/responsive-paint-scale.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { createRectLayer, paintLayerStack, type LocalLayer } from '~/composables/useCompositorLayers'

/** A recording context that tracks the CTM and logs every roundRect with the CTM at that moment. */
function recorder() {
  let m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
  const stack: typeof m[] = []
  const rects: { x: number; y: number; w: number; h: number; m: typeof m }[] = []
  const ctx: any = {
    canvas: { width: 1000, height: 500 },
    globalAlpha: 1, globalCompositeOperation: 'source-over', filter: 'none',
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
    shadowColor: 'transparent', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
    save() { stack.push({ ...m }) }, restore() { m = stack.pop() ?? m },
    translate(x: number, y: number) { m = { ...m, e: m.e + m.a * x + m.c * y, f: m.f + m.b * x + m.d * y } },
    scale(sx: number, sy: number) { m = { ...m, a: m.a * sx, b: m.b * sx, c: m.c * sy, d: m.d * sy } },
    rotate() {}, transform() {}, setTransform(a: any) { if (typeof a === 'object') m = { ...a } },
    getTransform() { return { ...m } },
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, rect() {}, ellipse() {},
    clip() {}, fill() {}, stroke() {}, fillRect() {}, clearRect() {}, drawImage() {},
    setLineDash() {}, getLineDash() { return [] },
    roundRect(x: number, y: number, w: number, h: number) { rects.push({ x, y, w, h, m: { ...m } }) },
  }
  return { ctx: ctx as CanvasRenderingContext2D, rects }
}

/** Device-space box of a recorded rect: apply its CTM to the local rect. */
function deviceBox(r: { x: number; y: number; w: number; h: number; m: any }) {
  const { a, d, e, f } = r.m
  return { x: e + a * r.x, y: f + d * r.y, w: a * r.w, h: d * r.h }
}

function paint(layer: LocalLayer, W = 1000, H = 500) {
  const { ctx, rects } = recorder()
  paintLayerStack(ctx, W, H, [{ type: 'local', key: `l:${layer.id}`, layer }], [layer])
  return rects.map(deviceBox)
}

describe('layoutScale in the painter', () => {
  it('absent ⇒ exactly today\'s geometry', () => {
    const r = createRectLayer({ x: 0.5, y: 0.5, w: 0.2, h: 0.1, radius: 0.02 })
    const [box] = paint(r)
    expect(box).toEqual({ x: 400, y: 200, w: 200, h: 50 })
  })
  it('layoutScale k scales every size about the layer\'s own centre; the centre stays put', () => {
    const r = { ...createRectLayer({ x: 0.5, y: 0.5, w: 0.2, h: 0.1, radius: 0.02 }), layoutScale: 0.5 } as unknown as LocalLayer
    const [box] = paint(r)
    expect(box.x).toBeCloseTo(450, 6); expect(box.y).toBeCloseTo(225, 6)
    expect(box.w).toBeCloseTo(100, 6); expect(box.h).toBeCloseTo(25, 6)
  })
  it('layoutScale 1 records no scale call (byte-identical path)', () => {
    const r = { ...createRectLayer({ x: 0.5, y: 0.5, w: 0.2, h: 0.1 }), layoutScale: 1 } as unknown as LocalLayer
    const [box] = paint(r)
    expect(box).toEqual({ x: 400, y: 200, w: 200, h: 50 })
  })
  it('a mask source drawn for a clipped layer is scaled about the SOURCE\'s centre, not the content\'s', () => {
    const src = { ...createRectLayer({ id: 's', x: 0.25, y: 0.5, w: 0.2, h: 0.2 }), layoutScale: 0.5 } as unknown as LocalLayer
    const content = { ...createRectLayer({ id: 'c', x: 0.75, y: 0.5, w: 0.2, h: 0.2, maskedByKey: 'l:s' }), layoutScale: 0.5 } as unknown as LocalLayer
    const { ctx, rects } = recorder()
    ;(globalThis as any).document = { createElement: () => ({ width: 0, height: 0, getContext: () => recorder().ctx }) }
    try {
      paintLayerStack(ctx, 1000, 500, [
        { type: 'local', key: 'l:s', layer: src }, { type: 'local', key: 'l:c', layer: content },
      ], [src, content])
    } finally { delete (globalThis as any).document }
    // Whatever surfaces were used, every recorded rect must be centred on either the source
    // centre (250, 250) or the content centre (750, 250) — never displaced by the other's scale.
    const centres = rects.map(deviceBox).map(b => Math.round(b.x + b.w / 2))
    for (const c of centres) expect([250, 750]).toContain(c)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/responsive-paint-scale.unit.spec.ts`
Expected: test 1 and 3 PASS (today's geometry), test 2 FAILS (box is 200×50, not 100×25). Test 4 may pass or fail today — record which.

- [ ] **Step 3: Implement**

a. In `LayerCommon` (after `pins?`):
```ts
  /** TRANSIENT (never persisted): the draw-time scale a responsive layout asks for, applied
   *  about the layer's own centre at every site that builds the layer's transform. Written
   *  only on clones by lib/frame/responsive/resolve. Absent/1 ⇒ byte-identical draw. */
  layoutScale?: number
```
b. At the top of `useCompositorLayers.ts`, with the other imports:
```ts
import { layoutScaleOf } from '~/lib/frame/responsive/layoutScale'
```
One definition, used by the painter and the resolver alike.

c. Effected path — `const ls = c.dscale` at `:2827` becomes:
```ts
    const ls = c.dscale * layoutScaleOf(layer)
```
d. Plain cloner loop at `:6017-6021` — after the rotate:
```ts
    const kl = layoutScaleOf(layer)
    ctx.scale(layer.scale * c.dscale * kl, layer.scale * c.dscale * kl)
```
(If `layer.scale` is only defined for image/path there, keep the existing expression and multiply `kl` into it.)

e. Stroke-mask transform at `:2177` — after `mctx.rotate(...)`:
```ts
  const kl = layoutScaleOf(layer)
  if (kl !== 1) mctx.scale(kl, kl)
```
f. `drawLayerSilhouette` (`:2107`) and `paintLayerCropped` (`:2126`): read both. Wherever they `translate` to the layer centre and then draw sizes in `W` units, add the same guarded `scale(kl, kl)` right after the rotate. Wherever they delegate to `paintLayer`, nothing to add.

g. Run `grep -n "\* W\b" app/composables/useCompositorLayers.ts | grep -i "shadow"` — drop-shadow offsets/blur (`:2247`, `:2954`) are in device px and are NOT under the CTM. Multiply those by `layoutScaleOf(layer)` too, so a shadow scales with its layer.

- [ ] **Step 4: Run the test and the existing painter specs**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/responsive-paint-scale.unit.spec.ts tests/unit/compositor-corner-radius.unit.spec.ts tests/unit/compositor-clip-paint.unit.spec.ts tests/unit/compositor-stroke-style.unit.spec.ts tests/unit/compositor-stroke-band.unit.spec.ts tests/unit/wired-layer.unit.spec.ts`
Expected: all PASS. The five existing specs prove the absent-field path is unchanged.

- [ ] **Step 5: Record the spike's outcome in the plan**

Append to this task, under a heading "Outcome", three lines: which sites took the scale, whether test 4 passed before the change, and anything the next slice must know (for example "shadows now scale; `motionScale` still wraps the item and is unchanged").

- [ ] **Step 6: Commit**

Paths: `frontend/app/composables/useCompositorLayers.ts frontend/tests/unit/responsive-paint-scale.unit.spec.ts docs/superpowers/plans/2026-09-21-responsive-frames-1-resolver.md`
Message: `feat(frame): layoutScale — per-layer draw-time scale for responsive layouts (absent = byte-identical)`

#### Outcome

- **Sites that took the scale** (all in `frontend/app/composables/useCompositorLayers.ts`): `paintLayer`'s per-clone `ls` (`:2838` + `:2851` — feeds `applyXform`, i.e. the effected path, the raster-stamp path, the Vary-scratch path and the fast inline path, four call sites in one edit); the drop shadow and the inner shadow, via one `shs = s * k` device-px scale (`:2877`, `:2938`, `:2983-2985`); `applyStrokeMask`'s own translate+rotate transform (`:2192-2193`); and `drawWiredImageLayer`'s plain cloner stamp (`:6048` + `:6059-6060`, with a transient `layoutScale?` added to `WiredTransform` at `:5944` so that site is not dead — nothing writes it yet). The field itself is declared on `LayerCommon` at `:371-374` and the import sits at `:79`. One consequence worth knowing: `k !== 1` puts a clone on the uncached branch of the silhouette raster (the `ls === 1` gate at `:2898`), exactly as a cloner falloff scale already did. `drawLayerSilhouette` and `paintLayerCropped` needed NOTHING: the first spreads the layer into a ghost that reaches `paintLayer`, and the second only adds the crop clip — which is deliberately left in canvas units (see below).
- **Test 4 (mask source scaled about its own centre) PASSED before the change** — with `layoutScale` ignored entirely, both layers drew at their unscaled centres. It has teeth after the change: a mutation that scales about the frame origin rather than the layer centre fails tests 2 and 4.
- **For slice 2:** the scale is applied INSIDE each layer's own transform, never by scaling the context around `drawLocalLayer`/`paintLayerCropped` — a `LayerMask` crop is clipped by `applyMaskClip` in CANVAS space before `paintLayer` runs, so the resolver must keep storing the crop already-resized in canvas units (a context-wide scale would put it out by 1/k). Shadows scale (blur AND offsets). `motionScale` still wraps the whole item in `paintLayerStack` about the CONTENT layer's centre and is unchanged — the two are independent and compose. NOT scaled, and left for a later slice if it matters: the other device-px effect params that ride on `s` (layer blur radii, torn-edge/grain/bloom scale, the trailing-blur `ctx.filter`), and the backdrop treatments (`applyBackdropBlur`, `applyGlassFromLayer`, `applyDisplaceFromLayer`), none of which read `layoutScale`. **The motion path already carries `layoutScale` and must NOT scale again:** `lib/motion/paint.ts`'s `composeEffectiveLayer` spreads the layer (`...layer`), so `layoutScale` rides into `drawLocalLayer` → `paintLayer` → `applyXform` untouched, and the `ctx.scale` in `drawLayerWithMotion` is `motionScale` — a different field (`st.layer.scale`) that composes multiplicatively with it. Adding a second `layoutScale` in `paint.ts` would square it.

---

### Task 10: Pixel-equivalence tests (fit-and-bleed and top-left)

**Files:**
- Test: `frontend/tests/unit/responsive-equivalence.unit.spec.ts`

**Interfaces:**
- Consumes: `resolveLayout`, `paintLayerStack`, the recorder from Task 9 (copy it into this file; the harness is ten lines and the two specs must not share mutable state).

These are the spec's pixel tests 11 and 12, expressed as recorded device-space geometry (this suite has no rasterizer). Test 11: every layer pinned Center/Middle must equal painting the design at the fit scale, centred in the box. Test 12: every layer pinned Left/Top must equal the design at the fit scale at the box's top-left (plus the guard offset when the box is more than twice as wide).

- [ ] **Step 1: Write the test**

```ts
// frontend/tests/unit/responsive-equivalence.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { createRectLayer, paintLayerStack, type LocalLayer } from '~/composables/useCompositorLayers'
import { resolveLayout } from '~/lib/frame/responsive'
import type { FrameDoc } from '~/lib/frame/responsive/types'

function recorder(W: number, H: number) {
  let m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
  const stack: typeof m[] = []
  const rects: { x: number; y: number; w: number; h: number }[] = []
  const ctx: any = {
    canvas: { width: W, height: H },
    globalAlpha: 1, globalCompositeOperation: 'source-over', filter: 'none',
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
    shadowColor: 'transparent', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
    save() { stack.push({ ...m }) }, restore() { m = stack.pop() ?? m },
    translate(x: number, y: number) { m = { ...m, e: m.e + m.a * x, f: m.f + m.d * y } },
    scale(sx: number, sy: number) { m = { ...m, a: m.a * sx, d: m.d * sy } },
    rotate() {}, transform() {}, setTransform(a: any) { if (typeof a === 'object') m = { ...a } },
    getTransform() { return { ...m } },
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, rect() {}, ellipse() {},
    clip() {}, fill() {}, stroke() {}, fillRect() {}, clearRect() {}, drawImage() {},
    setLineDash() {}, getLineDash() { return [] },
    roundRect(x: number, y: number, w: number, h: number) { rects.push({ x: m.e + m.a * x, y: m.f + m.d * y, w: m.a * w, h: m.d * h }) },
  }
  return { ctx: ctx as CanvasRenderingContext2D, rects }
}

const W0 = 1000, H0 = 500
const design: LocalLayer[] = [
  createRectLayer({ id: 'a', x: 0.15, y: 0.2, w: 0.2, h: 0.1 }),
  createRectLayer({ id: 'b', x: 0.5, y: 0.5, w: 0.3, h: 0.3 }),
  createRectLayer({ id: 'c', x: 0.85, y: 0.85, w: 0.1, h: 0.1 }),
]
const doc = (layers: LocalLayer[]): FrameDoc => ({
  responsive: true, designW: W0, designH: H0, layers, stackOrder: layers.map(l => `l:${l.id}` as any), groups: [], grid: null, motion: null,
})
const paintAll = (layers: LocalLayer[], W: number, H: number) => {
  const { ctx, rects } = recorder(W, H)
  paintLayerStack(ctx, W, H, layers.map(l => ({ type: 'local' as const, key: `l:${l.id}`, layer: l })), layers)
  return rects
}
/** The design painted at scale s and offset (ox, oy) — the export's fit-and-bleed transform. */
const fitted = (s: number, ox: number, oy: number) => paintAll(design, W0, H0).map(r => ({ x: ox + s * r.x, y: oy + s * r.y, w: s * r.w, h: s * r.h }))
const near = (a: { x: number; y: number; w: number; h: number }[], b: typeof a) => {
  expect(a.length).toBe(b.length)
  a.forEach((r, i) => { for (const key of ['x', 'y', 'w', 'h'] as const) expect(r[key]).toBeCloseTo(b[i]![key], 6) })
}

describe('equivalence with fit-and-bleed and with top-left', () => {
  const pinned = (h: any, v: any) => design.map(l => ({ ...l, pins: { h, v } }))
  it('every layer Center/Middle == the design fitted and centred (wider box)', () => {
    const W = 3000, H = 500   // fit s = min(3, 1) = 1; spare 2000 → u 1000, o 500 → centred either way
    const r = resolveLayout(doc(pinned('center', 'middle')), W, H)
    near(paintAll(r.layers, W, H), fitted(1, (W - W0) / 2, 0))
  })
  it('every layer Center/Middle == the design fitted and centred (taller box)', () => {
    const W = 1000, H = 2000   // s = 1, spare y 1500 → guard u 500 o 500 → centred anyway
    const r = resolveLayout(doc(pinned('center', 'middle')), W, H)
    near(paintAll(r.layers, W, H), fitted(1, 0, (H - H0) / 2))
  })
  it('every layer Center/Middle == fitted and centred when the box is smaller', () => {
    const W = 500, H = 500     // s = 0.5, spare y 250
    const r = resolveLayout(doc(pinned('center', 'middle')), W, H)
    near(paintAll(r.layers, W, H), fitted(0.5, 0, 125))
  })
  it('every layer Left/Top == the design fitted at the top-left (within the guard)', () => {
    const W = 1800, H = 500    // s = 1, spare x 800 ≤ 1000 → u 800, o 0
    const r = resolveLayout(doc(pinned('left', 'top')), W, H)
    near(paintAll(r.layers, W, H), fitted(1, 0, 0))
  })
  it('every layer Left/Top beyond the guard sits at the guard offset', () => {
    const W = 4000, H = 500    // spare 3000 → u 1000, o 1000
    const r = resolveLayout(doc(pinned('left', 'top')), W, H)
    near(paintAll(r.layers, W, H), fitted(1, 1000, 0))
  })
})
```

- [ ] **Step 2: Run the test**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/responsive-equivalence.unit.spec.ts`
Expected: PASS (5 tests). A failure here is a real disagreement between the resolver and the painter's `layoutScale` — fix in `resolve.ts` or Task 9's sites, never by loosening the tolerance.

- [ ] **Step 3: Commit**

Paths: `frontend/tests/unit/responsive-equivalence.unit.spec.ts`
Message: `test(frame): responsive resolver equals fit-and-bleed (centre pins) and top-left (left/top pins)`

---

### Task 11: Reading a `FrameDoc` from a node, and the `responsive` flag

**Files:**
- Create: `frontend/app/lib/frame/responsive/fromNode.ts`
- Test: `frontend/tests/unit/responsive-from-node.unit.spec.ts`

**Interfaces:**
- Consumes: the `sailor_*` property names (`useLocalLayerEditor.ts:170-250`): `sailor_localLayers`, `sailor_stackOrder`, `sailor_localGroups`, `sailor_localGrid` (via `readGrid`), `sailor_motion`, `sailor_frame.responsive`; the node's `width`/`height` widgets (`readNodeIntWidget` pattern in `CompositorModal.vue:4082`: `data.widgetDefs[i].name === 'width'` → `data.widgetsValues[i]`).
- Produces: `frameDocFromProps(props, designW, designH): FrameDoc`, `isResponsiveFrame(props): boolean`. Slice 2 wires these to the editor; this task only makes the read pure and tested.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/responsive-from-node.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { createRectLayer } from '~/composables/useCompositorLayers'
import { frameDocFromProps, isResponsiveFrame } from '~/lib/frame/responsive/fromNode'

describe('frameDocFromProps', () => {
  it('reads the sailor_* bag into a FrameDoc; missing keys default', () => {
    const l = createRectLayer({ id: 'a' })
    const props = { sailor_localLayers: [l], sailor_stackOrder: ['l:a'], sailor_frame: { responsive: true } }
    const d = frameDocFromProps(props, 1920, 1080)
    expect(d.responsive).toBe(true)
    expect(d.layers).toBe(props.sailor_localLayers)   // by reference — the identity fast path depends on it
    expect(d.stackOrder).toEqual(['l:a'])
    expect(d.groups).toEqual([]); expect(d.grid).toBeNull(); expect(d.motion).toBeNull()
    expect(d.designW).toBe(1920); expect(d.designH).toBe(1080)
  })
  it('a grid that is off reads as null; on reads through readGrid defaults', () => {
    expect(frameDocFromProps({ sailor_localGrid: { mode: 'off' } }, 10, 10).grid).toBeNull()
    expect(frameDocFromProps({ sailor_localGrid: { mode: 'explicit', columns: 3 } }, 10, 10).grid?.columns).toBe(3)
  })
  it('isResponsiveFrame is false for every Frame that exists today', () => {
    expect(isResponsiveFrame(undefined)).toBe(false)
    expect(isResponsiveFrame({})).toBe(false)
    expect(isResponsiveFrame({ sailor_frame: { preset: '16:9' } })).toBe(false)
    expect(isResponsiveFrame({ sailor_frame: { responsive: true } })).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/responsive-from-node.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/frame/responsive/fromNode`.

- [ ] **Step 3: Write the module**

```ts
// frontend/app/lib/frame/responsive/fromNode.ts
import type { LocalLayer, StackKey } from '~/composables/useCompositorLayers'
import type { LayerGroup } from '~/lib/compositor/layerGroups'
import type { FrameMotion } from '~/lib/motion/types'
import { readGrid } from '~/lib/frame/gridConfig'
import type { FrameDoc } from './types'

type Props = Record<string, unknown> | undefined

/** True only when the Frame was explicitly made responsive. Every existing Frame is fixed. */
export function isResponsiveFrame(props: Props): boolean {
  return (props?.sailor_frame as { responsive?: unknown } | undefined)?.responsive === true
}

/**
 * The resolver's read of a Frame node's `sailor_*` bag. Arrays are passed by
 * REFERENCE (never copied) so the identity fast path can hand them straight back.
 */
export function frameDocFromProps(props: Props, designW: number, designH: number): FrameDoc {
  const grid = readGrid(props)
  return {
    responsive: isResponsiveFrame(props),
    designW, designH,
    layers: (props?.sailor_localLayers as LocalLayer[] | undefined) ?? [],
    stackOrder: (props?.sailor_stackOrder as StackKey[] | undefined) ?? [],
    groups: (props?.sailor_localGroups as LayerGroup[] | undefined) ?? [],
    grid: grid.mode === 'off' ? null : grid,
    motion: (props?.sailor_motion as FrameMotion | undefined) ?? null,
  }
}
```

Add to `index.ts`: `export { frameDocFromProps, isResponsiveFrame } from './fromNode'`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/responsive-from-node.unit.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck the folder, run every responsive spec, commit**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vue-tsc --noEmit 2>&1 | grep 'lib/frame/responsive\|tests/unit/responsive-'; npx vitest run tests/unit/responsive-`
Expected: the grep prints nothing; all responsive specs PASS.

Paths: `frontend/app/lib/frame/responsive/fromNode.ts frontend/app/lib/frame/responsive/index.ts frontend/tests/unit/responsive-from-node.unit.spec.ts`
Message: `feat(frame): frameDocFromProps + isResponsiveFrame — the resolver's read of a node`

---

### Task 12: Dashboard and memory

**Files:**
- Modify: `docs/STATE.md` (one entry under the Frame section — follow the file's existing entry style).

- [ ] **Step 1: Add the entry**

Under the Frame section of `docs/STATE.md`, add:

```
- Responsive Frames — slice 1 LANDED <date>: pure `resolveLayout(frame, W, H)` in `frontend/app/lib/frame/responsive/` (pins, grid sections, rigid units, image cover, text re-wrap, motion remap) + the painter's transient `layoutScale`. Nothing in the app calls it yet; slices 2–5 (editor UI, editing at a viewing size, arranged groups, export "Adapt") follow. Spec: docs/superpowers/specs/2026-09-21-frame-responsive-constraints-design.md.
```

- [ ] **Step 2: Commit**

Paths: `docs/STATE.md`
Message: `docs: STATE — responsive Frames slice 1 (resolver) landed`

---

## Self-review against the spec (slice 1 scope)

| Spec section | Task |
|---|---|
| The one rule (fit, spare room) | 1 |
| Pins (five maps, straight lines, invert) | 1 |
| Keep size | 8 (`kKeep`, `kSize`) |
| Holding to a grid section (unitW, stable order, automatic attachment, holdTo) | 4, 8 |
| Automatic pins (80%, 4%, nearer edge, never relative) | 3 |
| The guard | 1 (`guardedRoom`), 8 (bleed rule) |
| Stretch per kind, image cover-and-crop, text box | 6 |
| Rigid units (free groups, mask pairs, cloners) | 5, 8 |
| Motion (position tracks mapped, others untouched) | 7, 8 |
| Stored data (`pins`, `responsive`) | 2, 11 |
| `layoutScale` contract and the rendering spike | 9 |
| Identity fast path / back-compat | 8, 9, 10, 11 |
| Testing 1–7, 9–12 (unit + recorded geometry) | 1–10 |
| Testing 8 (drop rule), real-mouse check | slice 3 |
| Frame-level things (background, post) | unchanged by this slice — the painter already paints them across W×H |

Out of this slice by design: the "Responsive" size choice, draggable edges, the size readout, the pins card, guide lines (slice 2); editing at a viewing size and the drop rule (slice 3); arranged groups and Yoga (slice 4); the export's "Adapt" (slice 5).
