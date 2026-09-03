# Compositor Shape Library Layers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Insert any of the 100 library shapes into the Frame (Compositor) as an ordinary path layer, from the toolbar, the inspector (swap) and the agent (`addShape`).

**Architecture:** A pure module turns a manifest shape into PathLayer geometry (recentred on its ink box, scaled to a target width in width-fraction units). PathLayer gains an optional `shapeId`. The Shapes toolbar menu gets a "Shape library…" row that opens the existing `ShapePicker`; the picked shape becomes the face for repeat stamping. The inspector shows a Shape row for shape-backed paths and swaps geometry while keeping transforms. The agent gets an `addShape` op and sees library ids and per-layer shape names.

**Tech Stack:** Nuxt 4 / Vue 3 / TypeScript, vitest (node), Tailwind, lucide icons. Shape library foundation from `frontend/app/lib/shapes/*` (landed 2026-09-02).

Spec: `docs/superpowers/specs/2026-09-02-compositor-shape-library-layer-design.md`

## Global Constraints

- pnpm from `frontend/` (`pnpm vitest run <file>`). No new dependencies. Typecheck baseline has pre-existing errors: only errors naming touched files count.
- A library shape is a `path` layer plus optional `shapeId`; no new `LocalLayerKind`.
- Default insert: centred (`x 0.5, y 0.5`), ink width `0.3` of the canvas, fill = `createPathLayer`'s default `'#3b82f6'`. The manifest's `sourceColor` is never used to paint.
- `shapeGeometry` is pure arithmetic over the manifest's absolute `M L C Z` path data; throws on any other command letter or a degenerate ink box.
- Swap keeps `id, x, y, rotation, opacity, fill, stroke, strokeWidth, scale` and the current `bbox.w`; replaces `d, bbox, fillRule, shapeId`.
- Toolbar: `TOOLBAR_SHAPES` keeps its five rows in order and appends `{ id: 'library', label: 'Shape library…' }`. `resolveShapeFace(id, hasLibraryShape = false)` returns `'library'` only when `hasLibraryShape` is true.
- Agent op `addShape` args `{ shape, x?, y?, w?, fill?, id? }`; unknown id ⇒ `{ ok: false, reason: 'invalid' }`; duplicate id ⇒ invalid; x/y clamped to `[-1, 2]`, w to `[0.02, 2]`.
- Plain language in user-facing copy. Action blue is the only accent; purple banned. Selected picker tile stays the existing white chip.
- Commit after every task with trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Stage own files only (`git add <paths>`), never `git add -A` — a parallel session shares this checkout with uncommitted edits in `StudioRow.vue`, `RowSlider.vue` and others.

## File map

| Path | Responsibility |
|---|---|
| `frontend/app/lib/shapes/pathLayer.ts` | `shapeGeometry`, `createShapeLayer`, `swapShapeLayer`, `SHAPE_LAYER_DEFAULT_WIDTH`. Pure. |
| `frontend/app/composables/useCompositorLayers.ts` | `PathLayer.shapeId?: string` (one line). |
| `frontend/app/lib/compositor/toolbarMenus.ts` | `'library'` id + row; `resolveShapeFace(id, hasLibraryShape)`. |
| `frontend/app/lib/agent/surfaces/compositor.ts` | `addShape` op (spec + handler + summary); `describeCompositor` shape name + `shapeLibrary`. |
| `frontend/app/components/vue-canvas/CompositorModal.vue` | Menu row → picker; library face + stamp; inspector Shape row + swap. |
| Tests | `shapes-path-layer.unit.spec.ts` (new), `compositor-toolbar-menus.unit.spec.ts` (extend), `agent-compositor-shape.unit.spec.ts` (new). |

---

### Task 1: Shape → PathLayer geometry (pure module)

**Files:**
- Create: `frontend/app/lib/shapes/pathLayer.ts`
- Modify: `frontend/app/composables/useCompositorLayers.ts` (the `PathLayer` interface, ~line 467)
- Test: `frontend/tests/unit/shapes-path-layer.unit.spec.ts`

**Interfaces:**
- Consumes: `LibraryShape` (`~/lib/shapes/catalog`), `PathLayer`, `Paint` types.
- Produces: `shapeGeometry(shape, targetWidth): { d, bbox }`, `createShapeLayer(shape, opts?)`, `swapShapeLayer(layer, shape)`, `SHAPE_LAYER_DEFAULT_WIDTH = 0.3`. `PathLayer.shapeId?: string`.

- [ ] **Step 1: Write the failing test**

`frontend/tests/unit/shapes-path-layer.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { LibraryShape } from '../../shared/shape-library'
import { shapeById } from '../../app/lib/shapes/catalog'
import { shapeGeometry, createShapeLayer, swapShapeLayer, SHAPE_LAYER_DEFAULT_WIDTH } from '../../app/lib/shapes/pathLayer'

// A 20×40 rectangle whose ink box starts at (10,10): centre (20,30).
const tall: LibraryShape = { id: 'tall', name: 'Tall', d: 'M10,10L30,10L30,50L10,50Z', fillRule: 'evenodd', box: [10, 10, 20, 40], sourceColor: '#123456' }

/** Parse "M1,2L3,4…Z" back into number pairs for assertions. */
const pairs = (d: string) => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)

describe('shapeGeometry', () => {
  it('recentres on the ink box and scales to the target width', () => {
    const g = shapeGeometry(tall, 0.5)
    // k = 0.5 / 20 = 0.025 → half extents 0.25 × 0.5
    expect(g.bbox.w).toBeCloseTo(0.5, 9)
    expect(g.bbox.h).toBeCloseTo(1.0, 9)
    const xs = pairs(g.d).filter((_, i) => i % 2 === 0)
    const ys = pairs(g.d).filter((_, i) => i % 2 === 1)
    expect(Math.min(...xs)).toBeCloseTo(-0.25, 9); expect(Math.max(...xs)).toBeCloseTo(0.25, 9)
    expect(Math.min(...ys)).toBeCloseTo(-0.5, 9); expect(Math.max(...ys)).toBeCloseTo(0.5, 9)
    expect(g.d.replace(/[0-9.,-]/g, '')).toBe('MLLLZ')
  })
  it('keeps cubic commands and the fill rule', () => {
    const s = shapeById('circle')!
    const g = shapeGeometry(s, 0.3)
    expect(g.d.startsWith('M')).toBe(true)
    expect(g.d).toMatch(/C/)
    expect(g.bbox.w).toBeCloseTo(0.3, 9)
    expect(g.bbox.h).toBeCloseTo(0.3 * s.box[3] / s.box[2], 9)
  })
  it('rejects a command letter outside M L C Z and a degenerate box', () => {
    expect(() => shapeGeometry({ ...tall, d: 'M0,0A5,5 0 0 1 10,10' }, 0.3)).toThrow(/unsupported/)
    expect(() => shapeGeometry({ ...tall, box: [0, 0, 0, 10] }, 0.3)).toThrow(/tall/)
  })
})

describe('createShapeLayer', () => {
  it('builds a centred path layer at the default width with provenance', () => {
    const l = createShapeLayer(tall)
    expect(l.kind).toBe('path')
    expect(l.shapeId).toBe('tall')
    expect(l.x).toBe(0.5); expect(l.y).toBe(0.5); expect(l.rotation).toBe(0); expect(l.opacity).toBe(1)
    expect(l.scale).toBe(1)
    expect(l.bbox.w).toBeCloseTo(SHAPE_LAYER_DEFAULT_WIDTH, 9)
    expect(l.fill).toBe('#3b82f6')
    expect(l.fillRule).toBe('evenodd')
    expect(l.stroke).toBe(''); expect(l.strokeWidth).toBe(0)
    expect(l.id).toMatch(/^shape-/)
  })
  it('honours position, width, fill and id', () => {
    const l = createShapeLayer(tall, { x: 0.2, y: 0.8, targetWidth: 0.1, fill: '#ff0000', id: 'my-shape' })
    expect([l.x, l.y, l.fill, l.id]).toEqual([0.2, 0.8, '#ff0000', 'my-shape'])
    expect(l.bbox.w).toBeCloseTo(0.1, 9)
  })
  it('survives a JSON round trip with its shapeId', () => {
    const l = createShapeLayer(tall)
    expect(JSON.parse(JSON.stringify(l)).shapeId).toBe('tall')
  })
})

describe('swapShapeLayer', () => {
  it('keeps the layout and paint, replaces the geometry', () => {
    const base = { ...createShapeLayer(tall, { x: 0.3, y: 0.6, targetWidth: 0.4, fill: '#00ff00', id: 'k' }), rotation: 15, opacity: 0.5, stroke: '#000000', strokeWidth: 0.01, scale: 1.5 }
    const circle = shapeById('circle')!
    const out = swapShapeLayer(base, circle)
    expect(out.id).toBe('k'); expect(out.x).toBe(0.3); expect(out.y).toBe(0.6)
    expect(out.rotation).toBe(15); expect(out.opacity).toBe(0.5); expect(out.scale).toBe(1.5)
    expect(out.fill).toBe('#00ff00'); expect(out.stroke).toBe('#000000'); expect(out.strokeWidth).toBe(0.01)
    expect(out.bbox.w).toBeCloseTo(0.4, 9)
    expect(out.shapeId).toBe('circle')
    expect(out.fillRule).toBe(circle.fillRule)
    expect(out.d).not.toBe(base.d)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && pnpm vitest run tests/unit/shapes-path-layer.unit.spec.ts`
Expected: FAIL — cannot resolve `../../app/lib/shapes/pathLayer`.

- [ ] **Step 3: Add `shapeId` to PathLayer**

In `frontend/app/composables/useCompositorLayers.ts`, inside `export interface PathLayer` after the `strokeWidth` line add:

```ts
  /** Provenance when the geometry came from the shape library (lib/shapes): the
   *  manifest id. Lets the inspector offer a swap and the agent name the shape.
   *  Absent on imported / drawn / boolean-result paths. Node editing rebuilds the
   *  layer through createPathLayer, which never sets it — so hand-edited geometry
   *  drops the id by construction. */
  shapeId?: string
```

- [ ] **Step 4: Write the module**

`frontend/app/lib/shapes/pathLayer.ts`:

```ts
/**
 * Shape library → Compositor path layer. Pure: recentre the manifest's
 * absolute path data on its ink box and scale it into the PathLayer local
 * frame (units = canvas width, centred on 0,0). No paper.js — the manifest
 * only carries M L C Z, so a number-pair transform is exact.
 */
import type { PathLayer } from '~/composables/useCompositorLayers'
import type { Paint } from '~/lib/compositor/paint'
import type { LibraryShape } from '~/lib/shapes/catalog'

export const SHAPE_LAYER_DEFAULT_WIDTH = 0.3
const DEFAULT_FILL = '#3b82f6'   // createPathLayer's default — the manifest colour is a hint only

export interface ShapeGeometry { d: string; bbox: { w: number; h: number } }

const r5 = (v: number) => { const x = Math.round(v * 1e5) / 1e5; return Object.is(x, -0) ? 0 : x }

/** Ink box → `targetWidth` wide, centred on (0,0). Throws on a non-MLCZ command or a degenerate box. */
export function shapeGeometry(shape: LibraryShape, targetWidth: number): ShapeGeometry {
  const [bx, by, bw, bh] = shape.box
  if (!(bw > 0) || !(bh > 0) || !(targetWidth > 0)) throw new Error(`shapeGeometry: degenerate box for shape "${shape.id}"`)
  const k = targetWidth / bw
  const cx = bx + bw / 2, cy = by + bh / 2
  let out = ''
  const re = /([A-Za-z])|(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/g
  let m: RegExpExecArray | null
  let pending: number | null = null
  while ((m = re.exec(shape.d))) {
    if (m[1]) {
      if (!'MLCZ'.includes(m[1])) throw new Error(`shapeGeometry: unsupported path command "${m[1]}" in shape "${shape.id}"`)
      out += m[1]
      pending = null
    } else {
      const v = Number(m[2])
      if (pending === null) { pending = v; continue }
      const x = (pending - cx) * k, y = (v - cy) * k
      out += (out.endsWith('M') || out.endsWith('L') || out.endsWith('C') ? '' : ',') + `${r5(x)},${r5(y)}`
      pending = null
    }
  }
  if (pending !== null) throw new Error(`shapeGeometry: odd coordinate count in shape "${shape.id}"`)
  return { d: out, bbox: { w: bw * k, h: bh * k } }
}

let seq = 0
const newId = () => `shape-${Date.now().toString(36)}-${++seq}`

export interface CreateShapeLayerOpts { x?: number; y?: number; targetWidth?: number; fill?: Paint; id?: string }

export function createShapeLayer(shape: LibraryShape, o: CreateShapeLayerOpts = {}): PathLayer {
  const g = shapeGeometry(shape, o.targetWidth ?? SHAPE_LAYER_DEFAULT_WIDTH)
  return {
    id: o.id ?? newId(), kind: 'path',
    x: o.x ?? 0.5, y: o.y ?? 0.5, rotation: 0, opacity: 1,
    d: g.d, bbox: g.bbox, scale: 1,
    fill: o.fill ?? DEFAULT_FILL, fillRule: shape.fillRule, stroke: '', strokeWidth: 0,
    shapeId: shape.id,
  }
}

/** Same layer, new shape: layout and paint kept, geometry regenerated at the current ink width. */
export function swapShapeLayer(layer: PathLayer, shape: LibraryShape): PathLayer {
  const g = shapeGeometry(shape, layer.bbox.w > 0 ? layer.bbox.w : SHAPE_LAYER_DEFAULT_WIDTH)
  return { ...layer, d: g.d, bbox: g.bbox, fillRule: shape.fillRule, shapeId: shape.id }
}
```

- [ ] **Step 5: Run the test**

Run: `cd frontend && pnpm vitest run tests/unit/shapes-path-layer.unit.spec.ts`
Expected: PASS (8 tests). If the `MLLLZ` assertion fails, check the comma logic: pairs are separated by `,` only between pairs, commands carry no separator.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/lib/shapes/pathLayer.ts frontend/app/composables/useCompositorLayers.ts frontend/tests/unit/shapes-path-layer.unit.spec.ts
git commit -m "feat(shapes): library shape → Compositor path layer (pure geometry, provenance shapeId, swap)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Agent — `addShape` op, shape names, library ids

**Files:**
- Modify: `frontend/app/lib/agent/surfaces/compositor.ts` (`COMPOSITOR_COMMANDS` ~line 113–132; `describeCompositor` ~140; `applyCompositorCommand` switch ~207; `summarizeCompositorChange` ~465)
- Test: `frontend/tests/unit/agent-compositor-shape.unit.spec.ts`

**Interfaces:**
- Consumes: `createShapeLayer`, `SHAPE_LAYER_DEFAULT_WIDTH` (Task 1); `shapeById`, `SHAPES` (catalog).
- Produces: op `addShape`; `describeCompositor` document `current.shapeLibrary: string[]`; path objects `current.shape`.

- [ ] **Step 1: Write the failing test**

`frontend/tests/unit/agent-compositor-shape.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { applyCompositorCommand, describeCompositor, summarizeCompositorChange } from '~/lib/agent/surfaces/compositor'
import type { CompositorState } from '~/lib/agent/surfaces/compositor'

const base = (): CompositorState => ({ layers: [] })

describe('addShape', () => {
  it('adds a centred library shape as a path layer', () => {
    const r = applyCompositorCommand(base(), { op: 'addShape', args: { shape: 'sparkle' } })
    expect(r.ok).toBe(true)
    const l = (r as any).template.layers[0]
    expect(l.kind).toBe('path'); expect(l.shapeId).toBe('sparkle')
    expect(l.x).toBe(0.5); expect(l.y).toBe(0.5)
    expect(l.bbox.w).toBeCloseTo(0.3, 9)
    expect(l.id).toBe('l_1_shape')
  })
  it('honours x, y, w, fill and id, clamping the numbers', () => {
    const r = applyCompositorCommand(base(), { op: 'addShape', args: { shape: 'sun-rays', x: 0.85, y: -5, w: 9, fill: '#ff8800', id: 'sun' } })
    expect(r.ok).toBe(true)
    const l = (r as any).template.layers[0]
    expect(l.id).toBe('sun'); expect(l.x).toBe(0.85); expect(l.y).toBe(-1); expect(l.bbox.w).toBeCloseTo(2, 9); expect(l.fill).toBe('#ff8800')
  })
  it('rejects unknown ids and duplicate layer ids', () => {
    expect(applyCompositorCommand(base(), { op: 'addShape', args: { shape: 'unicorn' } })).toMatchObject({ ok: false, reason: 'invalid' })
    const s1 = (applyCompositorCommand(base(), { op: 'addShape', args: { shape: 'heart', id: 'h' } }) as any).template
    expect(applyCompositorCommand(s1, { op: 'addShape', args: { shape: 'heart', id: 'h' } })).toMatchObject({ ok: false, reason: 'invalid' })
  })
  it('is undoable through the inverse snapshot', () => {
    const r = applyCompositorCommand(base(), { op: 'addShape', args: { shape: 'plus' } }) as any
    const back = applyCompositorCommand(r.template, r.inverse) as any
    expect(back.ok).toBe(true); expect(back.template.layers.length).toBe(0)
  })
  it('is listed in the command menu with a hint', () => {
    const d = describeCompositor(base())
    const cmd = d.commands.find(c => c.op === 'addShape')
    expect(cmd?.hint).toMatch(/shape library/i)
  })
})

describe('describeCompositor with shapes', () => {
  it('names the shape on shape-backed paths and lists the library on the document', () => {
    const s = (applyCompositorCommand(base(), { op: 'addShape', args: { shape: 'leaf', id: 'leaf1' } }) as any).template as CompositorState
    const d = describeCompositor(s)
    const leaf = d.objects.find(o => o.id === 'leaf1')!
    expect(leaf.type).toBe('path'); expect(leaf.current.shape).toBe('leaf')
    const doc = d.objects.find(o => o.id === 'document')!
    expect(Array.isArray(doc.current.shapeLibrary)).toBe(true)
    expect((doc.current.shapeLibrary as string[]).length).toBe(100)
    expect(doc.current.shapeLibrary).toContain('sparkle')
  })
  it('summarises the change', () => {
    expect(summarizeCompositorChange(base(), { op: 'addShape', args: { shape: 'leaf' } })).toEqual({ label: 'Add shape', before: '', after: 'leaf' })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && pnpm vitest run tests/unit/agent-compositor-shape.unit.spec.ts`
Expected: FAIL — `addShape` is an unknown op (the switch's default returns invalid) and `shapeLibrary` is undefined.

- [ ] **Step 3: Implement**

In `frontend/app/lib/agent/surfaces/compositor.ts`:

Imports (add):

```ts
import { shapeById, SHAPES } from '~/lib/shapes/catalog'
import { createShapeLayer, SHAPE_LAYER_DEFAULT_WIDTH } from '~/lib/shapes/pathLayer'
```

In `COMPOSITOR_COMMANDS`, directly after the `addLayer` entry add:

```ts
  { op: 'addShape', hint: 'Add a SHAPE from the shape library (sparkle, sun-rays, leaf, heart, plus, stairs, hexagon, swirl…) as a vector layer. args: { shape (an id from document.shapeLibrary), x?, y? (0..1, centre; default 0.5,0.5), w? (0..1 of canvas width; default 0.3), fill? ("#RRGGBB" or a gradient object), id? (choose one so you can target it next) }. This is what "add a sparkle", "put a sun top-right", "drop in a heart" mean. Recolour later with setFill, resize with setSize scale, rotate with setLayerProps.' },
```

In `describeCompositor`, change the path branch

```ts
    else if (l.kind === 'path') { cur.fill = paintLabel(l.fill) }
```

to

```ts
    else if (l.kind === 'path') { cur.fill = paintLabel(l.fill); if (l.shapeId && shapeById(l.shapeId)) cur.shape = l.shapeId }
```

and in the `document` object's `current` add (after `coordinateSpace`):

```ts
      // Every id addShape accepts. ~1 KB; listed so the model never guesses a name.
      shapeLibrary: SHAPES.map(s => s.id),
```

In `applyCompositorCommand`, after the `addLayer` case add:

```ts
    case 'addShape': {
      const a = (cmd.args ?? {}) as Record<string, unknown>
      const shape = typeof a.shape === 'string' ? shapeById(a.shape) : undefined
      if (!shape) return { ok: false, reason: 'invalid', detail: `unknown shape id '${String(a.shape)}' — use one from document.shapeLibrary` }
      const id = typeof a.id === 'string' && a.id ? a.id : `l_${state.layers.length + 1}_shape`
      if (state.layers.some(l => l.id === id)) return { ok: false, reason: 'invalid', detail: `layer id '${id}' already exists` }
      const layer = createShapeLayer(shape, {
        id,
        x: clamp(a.x, PROP_CLAMP.x![0], PROP_CLAMP.x![1], 0.5),
        y: clamp(a.y, PROP_CLAMP.y![0], PROP_CLAMP.y![1], 0.5),
        targetWidth: clamp(a.w, 0.02, 2, SHAPE_LAYER_DEFAULT_WIDTH),
        fill: isValidPaint(a.fill) ? (a.fill as Paint) : undefined,
      })
      return { ok: true, template: { ...state, layers: [...state.layers, layer] }, inverse: snapshot() }
    }
```

`clamp(value, lo, hi, fallback)` already exists in this file (used by `setSize`); `isValidPaint` is whatever predicate the `setFill` case uses to accept a paint — read that case (~line 253) and call the same function; if it validates inline, extract that check into a small `isValidPaint(v: unknown): boolean` helper next to `clamp` and use it in both places (no behaviour change for `setFill`).

In `summarizeCompositorChange`, after the `addLayer` case add:

```ts
    case 'addShape': return { label: 'Add shape', before: '', after: String(a.shape ?? 'shape') }
```

- [ ] **Step 4: Run the new test and the existing agent suites**

Run: `cd frontend && pnpm vitest run tests/unit/agent-compositor-shape.unit.spec.ts tests/unit/agent-compositor-surface.unit.spec.ts tests/unit/agent-torn-edge.unit.spec.ts tests/unit/agent-feather.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/lib/agent/surfaces/compositor.ts frontend/tests/unit/agent-compositor-shape.unit.spec.ts
git commit -m "feat(agent): Compositor addShape — library shapes by id, shape names and the id list in the description

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Toolbar menu data

**Files:**
- Modify: `frontend/app/lib/compositor/toolbarMenus.ts`
- Test: `frontend/tests/unit/compositor-toolbar-menus.unit.spec.ts` (extend)

**Interfaces:**
- Produces: `ToolbarShapeId` includes `'library'`; `TOOLBAR_SHAPES` sixth row `{ id: 'library', label: 'Shape library…' }`; `resolveShapeFace(id, hasLibraryShape = false)`; `shapeFaceLabel(id, hasLibraryShape = false)`.

- [ ] **Step 1: Update the tests first**

In `frontend/tests/unit/compositor-toolbar-menus.unit.spec.ts` change the first two expectations to:

```ts
    expect(TOOLBAR_SHAPES.map(s => s.id)).toEqual(['rect', 'ellipse', 'line', 'polygon', 'star', 'library'])
    expect(TOOLBAR_SHAPES.map(s => s.label)).toEqual(['Rectangle', 'Ellipse', 'Line', 'Polygon', 'Star', 'Shape library…'])
```

and add a test:

```ts
  it('wears the library face only once a library shape is known', () => {
    expect(resolveShapeFace('library')).toBe('rect')
    expect(resolveShapeFace('library', false)).toBe('rect')
    expect(resolveShapeFace('library', true)).toBe('library')
    expect(shapeFaceLabel('library', true)).toBe('Shape library…')
    expect(shapeFaceLabel('library')).toBe('Rectangle')
  })
```

Run: `cd frontend && pnpm vitest run tests/unit/compositor-toolbar-menus.unit.spec.ts` — Expected: FAIL on the row list.

- [ ] **Step 2: Implement**

In `frontend/app/lib/compositor/toolbarMenus.ts`:

```ts
export type ToolbarShapeId = 'rect' | 'ellipse' | 'line' | 'polygon' | 'star' | 'library'
```

Append to `TOOLBAR_SHAPES`:

```ts
  // Opens the shape library picker instead of stamping; the picked shape then
  // becomes the face so repeat stamping stays one click (see CompositorModal).
  { id: 'library', label: 'Shape library…' },
```

Replace `resolveShapeFace` / `shapeFaceLabel`:

```ts
/** Last-used-face reducer: anything unknown falls back to the default, so a
 *  stale or hand-set value can never leave the button without an icon. The
 *  library face is only valid while the modal knows which library shape to
 *  stamp (`hasLibraryShape`); a fresh modal has none, so it falls back too. */
export function resolveShapeFace(id: string | null | undefined, hasLibraryShape = false): ToolbarShapeId {
  if (id === 'library') return hasLibraryShape ? 'library' : DEFAULT_SHAPE_FACE
  return TOOLBAR_SHAPES.some(s => s.id === id) ? id as ToolbarShapeId : DEFAULT_SHAPE_FACE
}

/** Label for a face id (used in the face button's tooltip). */
export function shapeFaceLabel(id: string | null | undefined, hasLibraryShape = false): string {
  const face = resolveShapeFace(id, hasLibraryShape)
  return TOOLBAR_SHAPES.find(s => s.id === face)!.label
}
```

- [ ] **Step 3: Run the test**

Run: `cd frontend && pnpm vitest run tests/unit/compositor-toolbar-menus.unit.spec.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/lib/compositor/toolbarMenus.ts frontend/tests/unit/compositor-toolbar-menus.unit.spec.ts
git commit -m "feat(compositor): Shapes menu gains a Shape library row; library face gated on a known shape

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Modal — picker from the menu, library face, inspector swap

**Files:**
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` (imports ~88–100; face state ~4198–4240; Shapes menu template ~5330–5365; path inspector block ~6297)

**Interfaces:**
- Consumes: `ShapePicker` (`~/components/vue-canvas/studio/ShapePicker.vue`, props `modelValue, allowNone, anchor {x,y}, ignore?`, emits `update:modelValue`, `close`), `SHAPE_PICKER_WIDTH`, `shapeById`, `createShapeLayer`, `swapShapeLayer`, `addLocal`, `setLocal`, `selectedLocal`, `resolveShapeFace(id, has)`, `shapeFaceLabel(id, has)`.

- [ ] **Step 1: Imports**

Add to the `lucide-vue-next` import list: `Shapes`. Add after the `toolbarMenus` import:

```ts
import ShapePicker from '~/components/vue-canvas/studio/ShapePicker.vue'
import { shapeById } from '~/lib/shapes/catalog'
import { createShapeLayer, swapShapeLayer } from '~/lib/shapes/pathLayer'
import { SHAPE_PICKER_WIDTH } from '~/lib/shapes/pickerLayout'
```

- [ ] **Step 2: Face state and handlers**

Replace the `SHAPE_ICONS` / `SHAPE_STAMP` records and `pickShape` / `stampFaceShape` with:

```ts
/** The library shape the face wears once one has been picked; null on a fresh
 *  modal (component state on purpose — no persistence, like shapeFace). */
const libraryShapeId = ref<string | null>(null)
const libraryShape = computed(() => (libraryShapeId.value ? shapeById(libraryShapeId.value) : undefined))
const hasLibraryShape = computed(() => !!libraryShape.value)
const libraryPickerOpen = ref(false)
const libraryPickerAnchor = ref({ x: 0, y: 0 })
const shapesClusterRef = ref<HTMLElement | null>(null)
const SHAPE_ICONS: Record<ToolbarShapeId, Component> = {
  rect: Square, ellipse: Circle, line: Minus, polygon: Hexagon, star: Star, library: Shapes,
}
function stampLibraryShape() {
  const s = libraryShape.value
  if (!s) { openLibraryPicker(); return }
  addLocal(createShapeLayer(s))
}
const SHAPE_STAMP: Record<ToolbarShapeId, () => void> = {
  rect: addRect, ellipse: addEllipse, line: addLine, polygon: addPolygon, star: addStar, library: stampLibraryShape,
}
/** Anchor the picker above the Shapes cluster; the picker clamps itself to the viewport. */
function openLibraryPicker() {
  const r = shapesClusterRef.value?.getBoundingClientRect()
  libraryPickerAnchor.value = r ? { x: r.left, y: Math.max(8, r.top - 340) } : { x: 16, y: 16 }
  shapesMenuOpen.value = false
  libraryPickerOpen.value = true
}
function onLibraryPick(id: string) {
  const s = shapeById(id)
  if (!s) return
  libraryShapeId.value = id
  shapeFace.value = 'library'
  addLocal(createShapeLayer(s))
}
/** Menu row → stamp it now AND wear it, so repeat stamping is one click.
 *  The library row opens the picker instead; the pick both stamps and wears. */
function pickShape(id: ToolbarShapeId) {
  if (id === 'library') { openLibraryPicker(); return }
  shapeFace.value = id
  shapesMenuOpen.value = false
  SHAPE_STAMP[id]()
}
/** The face button itself: stamp the current shape without opening anything. */
function stampFaceShape() { closeToolbarMenus(); SHAPE_STAMP[resolveShapeFace(shapeFace.value, hasLibraryShape.value)]() }
```

Also add `libraryPickerOpen.value = false` inside `closeToolbarMenus()`.

- [ ] **Step 3: Toolbar template**

On the Shapes cluster wrapper `<div class="relative flex items-center" @click.stop>` add `ref="shapesClusterRef"`. Change the face button to render the library glyph when it is worn:

```vue
          <button
            class="flex items-center justify-center h-8 w-7 rounded-l hover:bg-white/10 text-white/80 cursor-pointer"
            data-testid="shapes-face" :title="'Add ' + (resolveShapeFace(shapeFace, hasLibraryShape) === 'library' && libraryShape ? libraryShape.name : shapeFaceLabel(shapeFace, hasLibraryShape)).toLowerCase()"
            @click="stampFaceShape()">
            <svg v-if="resolveShapeFace(shapeFace, hasLibraryShape) === 'library' && libraryShape" viewBox="0 0 96 96" class="size-4" fill="currentColor" aria-hidden="true">
              <path :d="libraryShape.d" :fill-rule="libraryShape.fillRule" />
            </svg>
            <component v-else :is="SHAPE_ICONS[resolveShapeFace(shapeFace, hasLibraryShape)]" class="size-4" />
          </button>
```

The menu rows loop stays as is (the `library` row renders the `Shapes` icon from `SHAPE_ICONS`). After the `</Transition>` of the shapes menu, inside the cluster wrapper, add:

```vue
          <ShapePicker
            v-if="libraryPickerOpen"
            :model-value="libraryShapeId ?? 'none'"
            :allow-none="false"
            :anchor="libraryPickerAnchor"
            :ignore="shapesClusterRef"
            @update:model-value="onLibraryPick"
            @close="libraryPickerOpen = false"
          />
```

- [ ] **Step 4: Inspector Shape row**

Add state next to the face state:

```ts
const selectedShape = computed(() => {
  const l = selectedLocal.value
  return l && l.kind === 'path' && l.shapeId ? shapeById(l.shapeId) : undefined
})
const inspectorShapePickerOpen = ref(false)
const inspectorShapeAnchor = ref({ x: 0, y: 0 })
const inspectorShapeButtonRef = ref<HTMLElement | null>(null)
function openInspectorShapePicker() {
  const r = inspectorShapeButtonRef.value?.getBoundingClientRect()
  inspectorShapeAnchor.value = r ? { x: r.right - SHAPE_PICKER_WIDTH, y: r.bottom + 4 } : { x: 16, y: 16 }
  inspectorShapePickerOpen.value = true
}
function onInspectorShapePick(id: string) {
  const l = selectedLocal.value
  const s = shapeById(id)
  if (!l || l.kind !== 'path' || !s) return
  setLocal(l.id, swapShapeLayer(l, s))
}
```

In the template, as the FIRST child of `<template v-if="selectedLocal.kind === 'path'">` add:

```vue
            <div v-if="selectedShape">
              <div class="panel-label mb-1.5">Shape</div>
              <button
                ref="inspectorShapeButtonRef"
                type="button"
                class="w-full flex items-center gap-2 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 cursor-pointer transition-colors"
                title="Swap for another library shape"
                @click="openInspectorShapePicker"
              >
                <svg viewBox="0 0 96 96" class="size-4 shrink-0" fill="currentColor" aria-hidden="true"><path :d="selectedShape.d" :fill-rule="selectedShape.fillRule" /></svg>
                <span class="flex-1 text-left">{{ selectedShape.name }}</span>
              </button>
              <ShapePicker
                v-if="inspectorShapePickerOpen"
                :model-value="selectedShape.id"
                :allow-none="false"
                :anchor="inspectorShapeAnchor"
                :ignore="inspectorShapeButtonRef"
                @update:model-value="onInspectorShapePick"
                @close="inspectorShapePickerOpen = false"
              />
            </div>
```

- [ ] **Step 5: Typecheck the touched files and run the compositor-adjacent suites**

Run: `cd frontend && pnpm nuxt typecheck 2>&1 | grep -E "CompositorModal.vue|toolbarMenus|pathLayer|surfaces/compositor" || echo "no new errors"`
Expected: `no new errors` (a pre-existing unrelated error in another file may print; only lines naming these files count — compare against `git stash`-free means: `git show HEAD:frontend/app/components/vue-canvas/CompositorModal.vue` is not needed; just list which errors name these files and whether their line is one you touched).

Run: `cd frontend && pnpm vitest run tests/unit/compositor-toolbar-menus.unit.spec.ts tests/unit/agent-compositor-shape.unit.spec.ts tests/unit/shapes-path-layer.unit.spec.ts tests/unit/shape-picker.unit.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/components/vue-canvas/CompositorModal.vue
git commit -m "feat(compositor): Shape library in the Frame — menu row opens the picker, picked shape becomes the face, inspector swap

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Live verification

**Files:** none expected.

- [ ] **Step 1: Browser pane** — `preview_start` the `frontend` launch config; open `http://127.0.0.1:3002/`, start a blank project, add a Frame (the "Frame"/"Compositor" craft in the start modal, or Add → Frame), open it with Edit (viewport 1440×900).
- [ ] **Step 2:** Shapes ▾ → "Shape library…" → pick Sparkle. Confirm: a blue sparkle centred, ~30% wide; the face button shows the sparkle glyph; clicking the face twice adds two more.
- [ ] **Step 3:** With one selected: inspector shows "Shape · Sparkle"; change Fill to a colour; open the Shape row → pick Sun rays: position and width unchanged, geometry swapped, row reads "Sun rays".
- [ ] **Step 4:** Add a Rectangle over it, select both, boolean Subtract: a path results (no shape row on it).
- [ ] **Step 5:** Render on canvas → As image: the baked node image shows the shapes. Save proof via `/api/dev-scratch` from the baked `<img>` as in the previous project (WebGL canvases read back black; the Frame's canvas is 2D so a direct `toDataURL` may also work).
- [ ] **Step 6:** Agent path (no model key on this machine): call `applyCompositorCommand` through the existing unit tests only; note that the live prompt-bar run is owed like the other agent checks.
- [ ] **Step 7:** Reset the viewport (`preset: desktop`), stop the server. Nothing to commit unless a bug was found; fix bugs in their own commits.

---

## Self-review

**Spec coverage.** Geometry + provenance → Task 1. Toolbar row/face/stamp → Tasks 3–4. Inspector swap → Task 4. Agent op, description, summary → Task 2. Node-edit drops `shapeId` → by construction (`commitNodeEdit` replaces the layer with `segmentsToPathLayer`'s `createPathLayer(...)` result, which never sets `shapeId`); noted in the interface comment in Task 1, no extra code. Persistence round trip → Task 1 test. Live checklist → Task 5.

**Placeholders.** None: every step has code or an exact command.

**Type consistency.** `createShapeLayer(shape, { x, y, targetWidth, fill, id })` is what Task 2's handler and Task 4's stamps call; `swapShapeLayer(layer, shape)` is what the inspector calls; `resolveShapeFace(id, hasLibraryShape)` / `shapeFaceLabel(id, hasLibraryShape)` are used with the boolean in Task 4; `PathLayer.shapeId` is read by `describeCompositor` and `selectedShape`.
