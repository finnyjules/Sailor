# Shape Studio Library Base Shape Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shape Studio's base shape can be any of the 100 library shapes (`shape: 'library'` + `libraryShape: <id>`), fitted to `size` like the built-ins, with the picker row, randomize and agent all aware.

**Architecture:** A shared pure helper (`lib/shapes/geometry.ts`) recentres and scales manifest path data; the Compositor's `shapeGeometry` delegates to it. `geoshape/shapes.ts` gains the `'library'` kind, `config.ts` the `libraryShape` field, `controls.ts` a gated `shape`-kind row, `randomize.ts` a random id. No surface code changes: the schema panel already renders `shape` rows through `RowShape`.

**Tech Stack:** Nuxt 4 / Vue 3 / TypeScript, vitest (node; paper.js runs headless in node for geoshape).

Spec: `docs/superpowers/specs/2026-09-02-shape-studio-library-base-shape-design.md`

## Global Constraints

- pnpm from `frontend/`; no new dependencies. Only typecheck errors naming touched files count.
- `BASE_SHAPES` keeps its twelve entries in order and appends `'library'` last.
- Library sizing: the ink box's LARGER side equals `size`; the path is centred on the origin; only `M L C Z` (throw on anything else, naming the shape id).
- `libraryShape` default `'sparkle'`; the normaliser keeps a valid id and falls back to the default otherwise.
- `libraryShape` control: kind `shape`, `allowNone: false`, group `Shape`, visible only when `shape === 'library'`; `roundCorners` and `roundRadius` hidden when `shape === 'library'`.
- `shapeGeometry` in `lib/shapes/pathLayer.ts` keeps its exact contract and its tests.
- Stage own files only; trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; a parallel session has unrelated uncommitted edits — never `git add -A`.

## File map

| Path | Responsibility |
|---|---|
| `frontend/app/lib/shapes/geometry.ts` | `transformShapePath`, `fitShapePath` (pure). |
| `frontend/app/lib/shapes/pathLayer.ts` | `shapeGeometry` delegates to `transformShapePath`. |
| `frontend/app/lib/geoshape/shapes.ts` | `'library'` kind; `libraryShape` opt; `DEFAULT_LIBRARY_SHAPE`. |
| `frontend/app/lib/geoshape/config.ts` | `libraryShape` field + normaliser. |
| `frontend/app/lib/geoshape/render.ts` | passes `libraryShape`. |
| `frontend/app/lib/geoshape/controls.ts` | `libraryShape` row; rounding gates; guidance sentence. |
| `frontend/app/lib/geoshape/randomize.ts` | random library id. |
| Tests | `shapes-geometry.unit.spec.ts` (new); extend `geoshape-shapes`, `geoshape-config`, `geoshape-controls`, `geoshape-render`. |

---

### Task 1: Shared fit helper + the library base shape (lib core)

**Files:**
- Create: `frontend/app/lib/shapes/geometry.ts`
- Modify: `frontend/app/lib/shapes/pathLayer.ts` (`shapeGeometry` body)
- Modify: `frontend/app/lib/geoshape/shapes.ts`, `frontend/app/lib/geoshape/config.ts`, `frontend/app/lib/geoshape/render.ts`
- Test: `frontend/tests/unit/shapes-geometry.unit.spec.ts` (new); `frontend/tests/unit/geoshape-shapes.unit.spec.ts`, `frontend/tests/unit/geoshape-config.unit.spec.ts`, `frontend/tests/unit/geoshape-render.unit.spec.ts` (extend)

**Interfaces:**
- Produces: `transformShapePath(shape: LibraryShape, k: number, cx: number, cy: number): string`; `fitShapePath(shape, size): { d: string; w: number; h: number }`; `BaseShapeKind` includes `'library'`; `BaseShapeOpts.libraryShape?: string`; `DEFAULT_LIBRARY_SHAPE = 'sparkle'`; `GeoShapeConfig.libraryShape: string`.

- [ ] **Step 1: Write the failing tests**

`frontend/tests/unit/shapes-geometry.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { LibraryShape } from '../../shared/shape-library'
import { fitShapePath, transformShapePath } from '../../app/lib/shapes/geometry'
import { shapeById } from '../../app/lib/shapes/catalog'

const tall: LibraryShape = { id: 'tall', name: 'Tall', d: 'M10,10L30,10L30,50L10,50Z', fillRule: 'nonzero', box: [10, 10, 20, 40], sourceColor: '#000' }
const nums = (d: string) => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)

describe('transformShapePath', () => {
  it('recentres on (cx, cy) and scales by k, keeping only M L C Z', () => {
    expect(transformShapePath(tall, 0.5, 20, 30)).toBe('M-5,-10L5,-10L5,10L-5,10Z')
  })
  it('rejects arcs and a leading number', () => {
    expect(() => transformShapePath({ ...tall, d: 'M0,0A1,1 0 0 1 2,2' }, 1, 0, 0)).toThrow(/unsupported/)
    expect(() => transformShapePath({ ...tall, d: '1,2L3,4Z' }, 1, 0, 0)).toThrow(/must start with a command/)
  })
})

describe('fitShapePath', () => {
  it('fits the larger ink side to size, centred on the origin', () => {
    const g = fitShapePath(tall, 100)          // 20×40 box → height is the larger side → k = 2.5
    expect(g.w).toBeCloseTo(50, 9); expect(g.h).toBeCloseTo(100, 9)
    const xs = nums(g.d).filter((_, i) => i % 2 === 0), ys = nums(g.d).filter((_, i) => i % 2 === 1)
    expect(Math.min(...xs)).toBeCloseTo(-25, 9); expect(Math.max(...xs)).toBeCloseTo(25, 9)
    expect(Math.min(...ys)).toBeCloseTo(-50, 9); expect(Math.max(...ys)).toBeCloseTo(50, 9)
  })
  it('a real wide shape fits by width', () => {
    const s = shapeById('sun-rectangle')!
    const [, , bw, bh] = s.box
    const g = fitShapePath(s, 180)
    if (bw >= bh) { expect(g.w).toBeCloseTo(180, 6); expect(g.h).toBeCloseTo(180 * bh / bw, 6) }
    else { expect(g.h).toBeCloseTo(180, 6) }
  })
  it('throws on a degenerate box, naming the shape', () => {
    expect(() => fitShapePath({ ...tall, box: [0, 0, 0, 5] }, 10)).toThrow(/tall/)
  })
})
```

Append to `frontend/tests/unit/geoshape-shapes.unit.spec.ts` (and change the "12 named shapes" expectation to the 13-entry list ending in `'library'`):

```ts
describe('library base shape', () => {
  it('BASE_SHAPES ends with library', () => {
    expect(BASE_SHAPES[BASE_SHAPES.length - 1]).toBe('library')
    expect(BASE_SHAPES.length).toBe(13)
  })
  it('renders a library shape fitted to size', () => {
    const d = baseShapePath('library', { ...base, libraryShape: 'circle' })
    expect(d).toMatch(/^M/); expect(d.trim().endsWith('Z')).toBe(true); expect(d).toMatch(/C/)
    const n = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
    const xs = n.filter((_, i) => i % 2 === 0), ys = n.filter((_, i) => i % 2 === 1)
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(base.size, 1)
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(base.size, 1)
  })
  it('falls back to the default library shape for an unknown id', () => {
    expect(baseShapePath('library', { ...base, libraryShape: 'unicorn' })).toBe(baseShapePath('library', { ...base, libraryShape: DEFAULT_LIBRARY_SHAPE }))
  })
})
```

(import `DEFAULT_LIBRARY_SHAPE` from `~/lib/geoshape/shapes`.)

Append to `frontend/tests/unit/geoshape-config.unit.spec.ts` (follow its existing `mergeConfig` style):

```ts
describe('libraryShape', () => {
  it('defaults to sparkle and keeps a valid id', () => {
    expect(mergeConfig({}).libraryShape).toBe('sparkle')
    expect(mergeConfig({ libraryShape: 'sun-rays' }).libraryShape).toBe('sun-rays')
  })
  it('falls back on an unknown id and accepts the library kind', () => {
    expect(mergeConfig({ libraryShape: 'unicorn' }).libraryShape).toBe('sparkle')
    expect(mergeConfig({ shape: 'library' }).shape).toBe('library')
  })
})
```

Append to `frontend/tests/unit/geoshape-render.unit.spec.ts`:

```ts
  it('renders a library base shape into shapes and an SVG', async () => {
    const cfg = { ...DEFAULT_CONFIG, shape: 'library' as const, libraryShape: 'swirl', count: 6 }
    const shapes = await renderShapes(cfg)
    expect(shapes.length).toBeGreaterThanOrEqual(1)
    expect(shapes.some(s => s.commands.length > 4)).toBe(true)
    const svg = await toSvg(cfg)
    expect(svg).toMatch(/<path/)
  })
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && pnpm vitest run tests/unit/shapes-geometry.unit.spec.ts tests/unit/geoshape-shapes.unit.spec.ts tests/unit/geoshape-config.unit.spec.ts tests/unit/geoshape-render.unit.spec.ts`
Expected: FAIL (missing module, 12 vs 13, unknown kind, missing field).

- [ ] **Step 3: Write `geometry.ts`**

```ts
/**
 * Pure path arithmetic over the shape library's absolute `M L C Z` data.
 * Two consumers: the Compositor's path layers (fit by width) and Shape
 * Studio's base shape (fit by the larger side). No DOM, no paper.js.
 */
import type { LibraryShape } from '~~/shared/shape-library'

const r5 = (v: number) => { const x = Math.round(v * 1e5) / 1e5; return Object.is(x, -0) ? 0 : x }

/** Every coordinate becomes ((x − cx)·k, (y − cy)·k). Only M L C Z; throws otherwise. */
export function transformShapePath(shape: LibraryShape, k: number, cx: number, cy: number): string {
  let out = ''
  const re = /([A-Za-z])|(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/g
  let m: RegExpExecArray | null
  let pending: number | null = null
  while ((m = re.exec(shape.d))) {
    if (m[1]) {
      if (!'MLCZ'.includes(m[1])) throw new Error(`transformShapePath: unsupported path command "${m[1]}" in shape "${shape.id}"`)
      if (pending !== null) throw new Error(`transformShapePath: odd coordinate count in shape "${shape.id}"`)
      out += m[1]
    } else {
      if (!out) throw new Error(`transformShapePath: path data must start with a command in shape "${shape.id}"`)
      const v = Number(m[2])
      if (pending === null) { pending = v; continue }
      const x = (pending - cx) * k, y = (v - cy) * k
      out += (/[MLC]$/.test(out) ? '' : ',') + `${r5(x)},${r5(y)}`
      pending = null
    }
  }
  if (pending !== null) throw new Error(`transformShapePath: odd coordinate count in shape "${shape.id}"`)
  return out
}

/** Ink box's larger side = `size`, centred on the origin. */
export function fitShapePath(shape: LibraryShape, size: number): { d: string; w: number; h: number } {
  const [bx, by, bw, bh] = shape.box
  if (!(bw > 0) || !(bh > 0) || !(size > 0)) throw new Error(`fitShapePath: degenerate box for shape "${shape.id}"`)
  const k = size / Math.max(bw, bh)
  return { d: transformShapePath(shape, k, bx + bw / 2, by + bh / 2), w: bw * k, h: bh * k }
}
```

Then in `pathLayer.ts` replace `shapeGeometry`'s body with:

```ts
export function shapeGeometry(shape: LibraryShape, targetWidth: number): ShapeGeometry {
  const [bx, by, bw, bh] = shape.box
  if (!(bw > 0) || !(bh > 0) || !(targetWidth > 0)) throw new Error(`shapeGeometry: degenerate box for shape "${shape.id}"`)
  const k = targetWidth / bw
  return { d: transformShapePath(shape, k, bx + bw / 2, by + bh / 2), bbox: { w: bw * k, h: bh * k } }
}
```

importing `transformShapePath` from `./geometry` and deleting the now-duplicated tokeniser and `r5`. The existing `shapes-path-layer` tests must still pass unchanged (their error regexes match `unsupported`, `odd coordinate count`, `must start with a command`, and the id).

- [ ] **Step 4: geoshape core**

`shapes.ts`:

```ts
import { shapeById } from '~/lib/shapes/catalog'
import { fitShapePath } from '~/lib/shapes/geometry'

export type BaseShapeKind =
  | 'circle' | 'square' | 'triangle' | 'diamond' | 'pentagon' | 'hexagon'
  | 'octagon' | 'star' | 'semicircle' | 'cross' | 'leaf' | 'irregular' | 'library'

/** Canonical order for menus/validation — append, don't reorder. */
export const BASE_SHAPES: BaseShapeKind[] = [
  'circle', 'square', 'triangle', 'diamond', 'pentagon', 'hexagon',
  'octagon', 'star', 'semicircle', 'cross', 'leaf', 'irregular', 'library',
]

/** The library shape a fresh Library base shape shows, and the fallback for an id the catalog no longer has. */
export const DEFAULT_LIBRARY_SHAPE = 'sparkle'

export interface BaseShapeOpts {
  sides: number; starInner: number; irregularSeed: number
  size: number; roundCorners: number; roundRadius: number
  /** `library` only: a shape-library id. */
  libraryShape?: string
}

/** A library shape fitted so its larger ink side spans `size`, centred like every other base shape. */
function libraryPath(id: string | undefined, size: number): string {
  const shape = (id && shapeById(id)) || shapeById(DEFAULT_LIBRARY_SHAPE)!
  return fitShapePath(shape, size).d
}
```

and in `baseShapePath`'s switch: `case 'library':   return libraryPath(o.libraryShape, o.size)`.

`config.ts`: add `libraryShape: string` to `GeoShapeConfig` (right after `shape`), `libraryShape: 'sparkle'` to `DEFAULT_CONFIG`, and in `mergeConfig`: `libraryShape: isShapeId(o.libraryShape) ? o.libraryShape : d.libraryShape,` (import `isShapeId` from `~/lib/shapes/catalog`; config.ts must stay free of `three`/`paper` — the catalog is pure JSON, fine).

`render.ts`: add `libraryShape: cfg.libraryShape,` to the `baseShapePath` options.

- [ ] **Step 5: Run the four test files plus the Compositor geometry tests**

Run: `cd frontend && pnpm vitest run tests/unit/shapes-geometry.unit.spec.ts tests/unit/shapes-path-layer.unit.spec.ts tests/unit/geoshape-shapes.unit.spec.ts tests/unit/geoshape-config.unit.spec.ts tests/unit/geoshape-render.unit.spec.ts tests/unit/geoshape-controls.unit.spec.ts`
Expected: all PASS except `geoshape-controls` drift guard ("every config key has a control" — `libraryShape` has none yet; Task 2 adds it). Report that one expected failure explicitly.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/lib/shapes/geometry.ts frontend/app/lib/shapes/pathLayer.ts frontend/app/lib/geoshape/shapes.ts frontend/app/lib/geoshape/config.ts frontend/app/lib/geoshape/render.ts frontend/tests/unit/shapes-geometry.unit.spec.ts frontend/tests/unit/geoshape-shapes.unit.spec.ts frontend/tests/unit/geoshape-config.unit.spec.ts frontend/tests/unit/geoshape-render.unit.spec.ts
git commit -m "feat(geoshape): Library base shape — any of the 100 library shapes, fitted to size via a shared pure helper

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Controls, randomize, guidance

**Files:**
- Modify: `frontend/app/lib/geoshape/controls.ts`, `frontend/app/lib/geoshape/randomize.ts`
- Test: `frontend/tests/unit/geoshape-controls.unit.spec.ts` (extend; drift guard goes green), a randomize assertion in the same file or `geoshape-randomize` if one exists.

**Interfaces:**
- Consumes: Task 1's `libraryShape` field/opt, `SHAPES` (`~/lib/shapes/catalog`).
- Produces: `GEO_CONTROLS` entry `libraryShape`; `rollShape` includes `libraryShape`.

- [ ] **Step 1: Tests first** — append to `geoshape-controls.unit.spec.ts`:

```ts
describe('library base shape controls', () => {
  it('shows the Library shape row only for the library kind, hides rounding under it', () => {
    const lib = { ...DEFAULT_CONFIG, shape: 'library' as const }
    const keys = (c: GeoShapeConfig) => visibleGeoControls(c).map(x => x.key)
    expect(keys(lib)).toContain('libraryShape')
    expect(keys(lib)).not.toContain('roundCorners')
    expect(keys(lib)).not.toContain('roundRadius')
    expect(keys(lib)).not.toContain('sides')
    expect(keys(DEFAULT_CONFIG)).not.toContain('libraryShape')
    expect(keys(DEFAULT_CONFIG)).toContain('roundCorners')
  })
  it('declares the row as a shape control without None and with sparkle as default', () => {
    const c = GEO_CONTROLS.find(x => x.key === 'libraryShape')!
    expect(c.kind).toBe('shape'); expect((c as any).allowNone).toBe(false); expect(c.default).toBe('sparkle'); expect(c.group).toBe('Shape')
  })
  it('guidance names the library family', () => {
    expect(GEO_GUIDANCE).toMatch(/library/)
  })
  it('re-roll yields a valid library id', () => {
    for (let i = 0; i < 5; i++) {
      const out = reroll(DEFAULT_CONFIG, `seed-${i}`)
      expect(typeof out.libraryShape).toBe('string')
      expect(out.libraryShape.length).toBeGreaterThan(0)
    }
  })
})
```

(Adapt the `reroll` call to its real signature — read `randomize.ts`'s export; if it takes `(cfg, seed)` use that, otherwise follow the existing tests in the file. Import `isShapeId` and assert it on `out.libraryShape` if the signature allows.)

Run: `cd frontend && pnpm vitest run tests/unit/geoshape-controls.unit.spec.ts` — Expected: FAIL (no control, drift guard).

- [ ] **Step 2: Implement**

`controls.ts`: add gates `const isLibrary = (c: GeoShapeConfig) => c.shape === 'library'` and `const notLibrary = (c: GeoShapeConfig) => c.shape !== 'library'`. After the `select('shape', …)` entry insert:

```ts
  { key: 'libraryShape', label: 'Library shape', kind: 'shape', allowNone: false, default: DEFAULT_CONFIG.libraryShape, group: 'Shape',
    hint: 'library only: which of the 100 drawn shapes is cloned (sparkle, sun-rays, leaf, heart, swirl…)', when: isLibrary } as GeoControl,
```

Update the `shape` select's hint to `'polygon/star/irregular use Sides; hexagon is a fixed 6-gon; library clones one of the 100 drawn shapes (Library shape)'`. Add `{ when: notLibrary }` to the `roundCorners` slider and change `roundRadius`'s `when` to `(c) => hasRoundCorners(c) && notLibrary(c)`. In `GEO_GUIDANCE`'s BASE SHAPE sentence, after `irregular (…)` add `, library (one of the 100 drawn library shapes, chosen by libraryShape — sparkle, sun-rays, leaf, heart, swirl…; sides and corner rounding do not apply)`.

`randomize.ts`: import `SHAPES` from `~/lib/shapes/catalog`; `const LIBRARY_IDS = SHAPES.map(s => s.id)`; add `'libraryShape'` to `ShapeGroup`'s Pick; in `rollShape` add `libraryShape: r.pick(LIBRARY_IDS),`.

- [ ] **Step 3: Run** `cd frontend && pnpm vitest run tests/unit/geoshape-controls.unit.spec.ts tests/unit/geoshape-config.unit.spec.ts tests/unit/geoshape-studio-doc.unit.spec.ts` — Expected: PASS (drift guard green).

- [ ] **Step 4: Commit**

```bash
git add frontend/app/lib/geoshape/controls.ts frontend/app/lib/geoshape/randomize.ts frontend/tests/unit/geoshape-controls.unit.spec.ts
git commit -m "feat(geoshape): Library shape row (shape kind), rounding gated off under library, re-roll picks a library id, agent guidance

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Live verification (controller)

- [ ] Browser pane: `preview_start` `frontend`; open a project; add a Shape Studio node (start-modal "Shape" craft); Edit. Set Shape = Library: the "Library shape" row appears with Sparkle; Round corners rows disappear. Click the row → picker → Swirl: the mark re-renders as cloned swirls. Escape inside the picker leaves the studio open. Re-roll a few times: some rolls land on Library with a random shape. Render footer bakes a PNG. Screenshot proof; reset viewport; stop the server.
- [ ] If Escape closes the studio, apply the same `defaultPrevented` gate pattern used in `CompositorModal.vue` to the studio shell's Escape handler, with a test if the handler is pure.

## Self-review

Spec coverage: geometry helper + shapes/config/render → Task 1; controls/randomize/guidance/agent → Task 2; surface untouched by design, verified in Task 3. Types: `fitShapePath` returns `{ d, w, h }`; `baseShapePath('library', { libraryShape })`; `GeoShapeConfig.libraryShape: string`; the control key equals the config key (drift guard).
