# Node design, stage 1 (foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shared pieces every canvas node will wear (dark-glass shell, content card, print surface, Open bar, the roomier studio row, the new ports) plus the glass-blur policy and a benchmark that decides whether real blur ships, without changing any existing node yet.

**Architecture:** One global stylesheet (`node-surfaces.css`) holds every surface token so nodes can't drift; thin Vue components wrap it with slots. Real backdrop blur is an optional layer added by one class on the canvas root, decided by a pure policy function (`glassPolicy.ts`) fed by a composable that listens to Vue Flow's move events. Tint-only glass is the guaranteed exit route and looks identical over empty canvas.

**Tech Stack:** Nuxt 4, Vue 3 `<script setup>` + TypeScript, Tailwind, `@vue-flow/core`, Vitest (+ `@vue/test-utils`, happy-dom), Playwright against the shared dev server on `:3002`.

**Spec:** `docs/superpowers/specs/2026-09-27-node-design-design.md` (read it first; where the prototype and the spec differ, the spec wins).

**Scope:** Stage 1 of 6. Stages 2–5 (instruments, studios, content cards, Frame/Timeline) each get their own plan after this one lands, written against the real API built here. Stage 6 (result card) is gated on the runner porting session and Julien's confirmation.

## Global Constraints

- **Do not change** selection, running or failed states, wires, or the Note node (spec: "What stays exactly as it is").
- **No existing node component changes in this stage** except `NodePort.vue` and `StudioRow.vue`, which every node already shares.
- Shell geometry: **16px outer corners, 10px inset, 6px inner corners** (the live `ComfyNode.vue` / `NodeCapsule.vue` values; the capsule must stay equal). This overrides the prototype's 14/8.
- One even 1px border per surface, drawn at **one screen pixel at every zoom**: `border-width: calc(1px / var(--canvas-zoom, 1))`. No inner highlight line, no gradient fill inside a shell.
- Glass: tint `rgba(26,26,28,.58)`; blur `blur(18px) saturate(1.4)`; border `rgba(255,255,255,.10)`.
- Node text: PP Neue Montreal **500**; titles **600**; buttons 600 with the price at 500. User content keeps its own weight.
- Quieter row fills (everywhere): rest `rgba(255,255,255,.03)`, hover/drag `.065`; value band `.10`, in use `.16`; labels `rgba(255,255,255,.55)`. Node row size: **32px**, 11px side padding, 5px gap. Studio inspectors stay 28px.
- **Never** add `will-change`, `translateZ` or any forced layer promotion to the canvas, the viewport or a node (it crashed the tab on 09-04; see memory `compositor-modal-pan-lag-live-loop`).
- UI copy: sentence case, no identifiers, no explanatory small text in panels (hints are tooltips).
- **Subagents never run `npm run dev`** and never restart `:3002`. Playwright runs against the existing `:3002`; if it is down or broken, stop and report.
- **Measurement of frame rate happens only in a visible tab** (the in-app Browser pane runs hidden, which pauses `requestAnimationFrame`). Never conclude "no work is happening" from the pane.
- **Commit with a private index, every commit** (shared checkout; other sessions stage files):

```bash
cd /Users/julien/Documents/GitHub/Sailor
export GIT_INDEX_FILE=$(mktemp /private/tmp/claude-501/-Users-julien-Documents-GitHub-Sailor/c19861ac-b0c0-4e2e-9c8b-40722b73c22c/scratchpad/idx.XXXX); rm -f "$GIT_INDEX_FILE"
git read-tree HEAD
git add <only your exact paths>
git diff --cached --stat          # must list ONLY your files
git commit -m "<message>

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
then, in a **separate** Bash call (variable unset): `git reset -q -- <the same exact paths>`.

---

## File map

| File | Responsibility |
|---|---|
| `frontend/app/lib/canvas/glassPolicy.ts` (new) | Pure rules: may the canvas blur right now, and which nodes have something behind them. |
| `frontend/app/composables/useCanvasGlass.ts` (new) | Listens to Vue Flow (move start/end, zoom, nodes, edges), runs the policy, exposes the root class, the `--canvas-zoom` value and the set of nodes to blur; `provide`/`inject` helpers. |
| `frontend/app/assets/css/node-surfaces.css` (new) | Every surface token: shell, well, content card, print surface, Open bar, node type weights, the zoom-true border. |
| `frontend/app/components/vue-canvas/surfaces/NodeShell.vue` (new) | Instrument/studio shell: header (icon, title, hover actions), body, optional footer. |
| `frontend/app/components/vue-canvas/surfaces/NodeWell.vue` (new) | The recessed well (prompt or preview) with an optional rising Open bar. |
| `frontend/app/components/vue-canvas/surfaces/NodeOpenBar.vue` (new) | The bar that rises over the bottom of a preview: meta text + actions. |
| `frontend/app/components/vue-canvas/surfaces/ContentCard.vue` (new) | Content card: name above, content, floating hover actions. |
| `frontend/app/components/vue-canvas/surfaces/PrintSurface.vue` (new) | Frame/Timeline: thin light-glass edge tinted by the artwork, name + size above, rising bar. |
| `frontend/app/components/vue-canvas/studio/StudioRow.vue` (modify) | Quieter fills; `size: 'compact' \| 'comfortable'` prop. |
| `frontend/app/components/vue-canvas/NodePort.vue` (modify) | Hover: dot grows 12→16px, fills, slides out 5px; name 11px/500. |
| `frontend/app/components/vue-canvas/VueNodeCanvas.vue` (modify, small) | Mount `useCanvasGlass`, bind root class + `--canvas-zoom`, `provide` the blur set. |
| `frontend/nuxt.config.ts` (modify, one line) | Register `node-surfaces.css`. |
| `frontend/app/pages/dev/node-lab.vue` (new) | Every surface with realistic content, for eyes and Playwright. |
| `frontend/app/pages/dev/glass-bench.vue` (new) | Real Vue Flow, 40 glass nodes, auto-pan, frame-time readout, three blur modes. |
| `frontend/tests/unit/glass-policy.unit.spec.ts` (new) | Policy tests. |
| `frontend/tests/unit/canvas-glass.unit.spec.ts` (new) | Composable tests with a fake flow. |
| `frontend/tests/unit/node-surfaces.unit.spec.ts` (new) | Component mount tests + stylesheet guards. |
| `frontend/tests/unit/studio-row-size.unit.spec.ts` (new) | Row size + fills. |
| `frontend/tests/node-lab.spec.ts` (new) | Real-mouse checks: port hover, Open bar rise, row heights. |

---

### Task 1: Glass policy (pure rules)

**Files:**
- Create: `frontend/app/lib/canvas/glassPolicy.ts`
- Test: `frontend/tests/unit/glass-policy.unit.spec.ts`

**Interfaces:**
- Produces:
  - `export const GLASS_LIMITS: { minZoom: number; maxVisibleNodes: number }` = `{ minZoom: 0.5, maxVisibleNodes: 24 }`
  - `export type GlassMode = 'smart' | 'always' | 'never'`
  - `export function blurAllowed(s: { mode: GlassMode; moving: boolean; zoom: number; visibleNodes: number }): boolean`
  - `export interface NodeBox { id: string; x: number; y: number; w: number; h: number }`
  - `export interface Wire { source: string; target: string; sx: number; sy: number; tx: number; ty: number }`
  - `export function sampleWire(w: Wire, n?: number): Array<{ x: number; y: number }>`
  - `export function nodesWithSomethingBehind(nodes: NodeBox[], wires: Wire[]): Set<string>`
  - `export function countVisible(nodes: NodeBox[], view: { x: number; y: number; zoom: number; width: number; height: number }): number`

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/tests/unit/glass-policy.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { blurAllowed, nodesWithSomethingBehind, sampleWire, countVisible, GLASS_LIMITS, type NodeBox, type Wire } from '~/lib/canvas/glassPolicy'

const box = (id: string, x: number, y: number, w = 100, h = 100): NodeBox => ({ id, x, y, w, h })

describe('blurAllowed', () => {
  const base = { mode: 'smart' as const, moving: false, zoom: 1, visibleNodes: 5 }
  it('blurs at rest, in view, uncrowded', () => { expect(blurAllowed(base)).toBe(true) })
  it('never blurs while the canvas moves', () => { expect(blurAllowed({ ...base, moving: true })).toBe(false) })
  it('never blurs below the zoom floor', () => { expect(blurAllowed({ ...base, zoom: GLASS_LIMITS.minZoom - 0.01 })).toBe(false) })
  it('blurs exactly at the zoom floor', () => { expect(blurAllowed({ ...base, zoom: GLASS_LIMITS.minZoom })).toBe(true) })
  it('never blurs when crowded', () => { expect(blurAllowed({ ...base, visibleNodes: GLASS_LIMITS.maxVisibleNodes + 1 })).toBe(false) })
  it("'never' is the exit route", () => { expect(blurAllowed({ ...base, mode: 'never' })).toBe(false) })
  it("'always' ignores every limit (benchmark only)", () => {
    expect(blurAllowed({ mode: 'always', moving: true, zoom: 0.1, visibleNodes: 500 })).toBe(true)
  })
})

describe('nodesWithSomethingBehind', () => {
  it('marks nothing on an empty canvas', () => {
    expect(nodesWithSomethingBehind([box('a', 0, 0), box('b', 300, 0)], [])).toEqual(new Set())
  })
  it('marks both nodes when they overlap', () => {
    expect(nodesWithSomethingBehind([box('a', 0, 0), box('b', 50, 50)], [])).toEqual(new Set(['a', 'b']))
  })
  it('does not mark nodes that only touch', () => {
    expect(nodesWithSomethingBehind([box('a', 0, 0), box('b', 100, 0)], [])).toEqual(new Set())
  })
  it('marks a node a foreign wire passes behind', () => {
    const nodes = [box('a', 0, 0, 20, 20), box('mid', 200, -50, 100, 200), box('b', 480, 0, 20, 20)]
    const wires: Wire[] = [{ source: 'a', target: 'b', sx: 20, sy: 10, tx: 480, ty: 10 }]
    expect(nodesWithSomethingBehind(nodes, wires)).toEqual(new Set(['mid']))
  })
  it("ignores a wire's own ends at its own nodes", () => {
    const nodes = [box('a', 0, 0), box('b', 300, 0)]
    const wires: Wire[] = [{ source: 'a', target: 'b', sx: 100, sy: 50, tx: 300, ty: 50 }]
    expect(nodesWithSomethingBehind(nodes, wires)).toEqual(new Set())
  })
})

describe('sampleWire', () => {
  it('starts and ends on the ports', () => {
    const pts = sampleWire({ source: 'a', target: 'b', sx: 0, sy: 0, tx: 100, ty: 40 }, 8)
    expect(pts[0]).toEqual({ x: 0, y: 0 })
    expect(pts.at(-1)).toEqual({ x: 100, y: 40 })
    expect(pts).toHaveLength(9)
  })
})

describe('countVisible', () => {
  it('counts nodes intersecting the screen', () => {
    const nodes = [box('in', 10, 10), box('out', 5000, 5000)]
    expect(countVisible(nodes, { x: 0, y: 0, zoom: 1, width: 800, height: 600 })).toBe(1)
  })
  it('accounts for pan and zoom', () => {
    // screen = graph * zoom + offset → node at graph 1000 appears at 1000*0.5 - 400 = 100
    expect(countVisible([box('n', 1000, 0)], { x: -400, y: 0, zoom: 0.5, width: 800, height: 600 })).toBe(1)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/glass-policy.unit.spec.ts`
Expected: FAIL, cannot resolve `~/lib/canvas/glassPolicy`.

- [ ] **Step 3: Implement**

```ts
// frontend/app/lib/canvas/glassPolicy.ts
/**
 * When the canvas may pay for real backdrop blur, and which nodes would show it.
 *
 * The glass LOOK never depends on blur: tint, border and shadow carry it, and a blur of
 * the flat canvas behind a node is the same flat colour. So blur only earns its cost where
 * something is actually behind a node — another node, or a wire — and only while nothing
 * is moving. Everything here is pure so it can be tested without a canvas.
 *
 * 'never' is the exit route: if the benchmark says blur costs frames, the canvas runs
 * 'never' and nothing else in the design changes.
 */
export const GLASS_LIMITS = { minZoom: 0.5, maxVisibleNodes: 24 }

export type GlassMode = 'smart' | 'always' | 'never'

export function blurAllowed(s: { mode: GlassMode; moving: boolean; zoom: number; visibleNodes: number }): boolean {
  if (s.mode === 'never') return false
  if (s.mode === 'always') return true
  if (s.moving) return false
  if (s.zoom < GLASS_LIMITS.minZoom) return false
  if (s.visibleNodes > GLASS_LIMITS.maxVisibleNodes) return false
  return true
}

export interface NodeBox { id: string; x: number; y: number; w: number; h: number }
export interface Wire { source: string; target: string; sx: number; sy: number; tx: number; ty: number }

/**
 * Points along a wire, using the same control points as Vue Flow's bezier edge
 * (horizontal handles, offset by half the horizontal distance, at least 25px).
 * An approximation is fine: it only decides whether a node MIGHT show a wire through it.
 */
export function sampleWire(w: Wire, n = 16): Array<{ x: number; y: number }> {
  const off = Math.max(25, Math.abs(w.tx - w.sx) * 0.5)
  const c1x = w.sx + off, c1y = w.sy, c2x = w.tx - off, c2y = w.ty
  const pts: Array<{ x: number; y: number }> = []
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t
    pts.push({
      x: u * u * u * w.sx + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * w.tx,
      y: u * u * u * w.sy + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * w.ty,
    })
  }
  return pts
}

/** Strictly inside, so a port sitting on the edge never counts. */
function inside(p: { x: number; y: number }, b: NodeBox, inset = 2): boolean {
  return p.x > b.x + inset && p.x < b.x + b.w - inset && p.y > b.y + inset && p.y < b.y + b.h - inset
}

function overlaps(a: NodeBox, b: NodeBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

export function nodesWithSomethingBehind(nodes: NodeBox[], wires: Wire[]): Set<string> {
  const out = new Set<string>()
  // Overlap: sort by x and sweep, so a big canvas is not n² in the common case.
  const byX = [...nodes].sort((a, b) => a.x - b.x)
  for (let i = 0; i < byX.length; i++) {
    const a = byX[i]!
    for (let j = i + 1; j < byX.length && byX[j]!.x < a.x + a.w; j++) {
      const b = byX[j]!
      if (overlaps(a, b)) { out.add(a.id); out.add(b.id) }
    }
  }
  for (const w of wires) {
    const pts = sampleWire(w)
    for (const n of nodes) {
      if (out.has(n.id) || n.id === w.source || n.id === w.target) continue
      if (pts.some(p => inside(p, n))) out.add(n.id)
    }
  }
  return out
}

export function countVisible(nodes: NodeBox[], view: { x: number; y: number; zoom: number; width: number; height: number }): number {
  let count = 0
  for (const n of nodes) {
    const left = n.x * view.zoom + view.x, top = n.y * view.zoom + view.y
    const right = left + n.w * view.zoom, bottom = top + n.h * view.zoom
    if (right > 0 && bottom > 0 && left < view.width && top < view.height) count++
  }
  return count
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/glass-policy.unit.spec.ts`
Expected: PASS (15 tests).

- [ ] **Step 5: Commit** (private-index recipe): `frontend/app/lib/canvas/glassPolicy.ts`, `frontend/tests/unit/glass-policy.unit.spec.ts` — message `feat(nodes): glass policy — blur only where something is behind a node, never while moving`.

---

### Task 2: Canvas glass composable

**Files:**
- Create: `frontend/app/composables/useCanvasGlass.ts`
- Test: `frontend/tests/unit/canvas-glass.unit.spec.ts`

**Interfaces:**
- Consumes: everything exported by Task 1.
- Produces:
  - `export interface GlassFlow { onMoveStart(cb: () => void): void; onMoveEnd(cb: () => void): void; viewport: Ref<{ x: number; y: number; zoom: number }>; boxes: () => NodeBox[]; wires: () => Wire[]; size: () => { width: number; height: number } }`
  - `export function createCanvasGlass(flow: GlassFlow, opts?: { mode?: Ref<GlassMode>; settleMs?: number }): { rootClass: ComputedRef<string>; rootStyle: ComputedRef<Record<string, string>>; blurIds: Ref<Set<string>>; recompute(): void; moving: Ref<boolean> }`
  - `export const CANVAS_GLASS_KEY: InjectionKey<{ blurIds: Ref<Set<string>> }>`
  - `export function provideCanvasGlass(g: { blurIds: Ref<Set<string>> }): void`
  - `export function useNodeGlass(nodeId: MaybeRefOrGetter<string | undefined>): ComputedRef<boolean>` — false when nothing is provided (dev pages, studios).
  - Root class: `'canvas-glass'` always; plus `'canvas-glass--blur'` when blur is allowed. Root style: `{ '--canvas-zoom': String(zoom) }`, updated **only at move end** (never per frame — a per-frame custom property change would restyle every node while zooming).

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/tests/unit/canvas-glass.unit.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, nextTick } from 'vue'
import { createCanvasGlass, type GlassFlow } from '~/composables/useCanvasGlass'

function fakeFlow() {
  let start = () => {}, end = () => {}
  const viewport = ref({ x: 0, y: 0, zoom: 1 })
  const state = {
    boxes: [{ id: 'a', x: 0, y: 0, w: 100, h: 100 }, { id: 'b', x: 50, y: 50, w: 100, h: 100 }, { id: 'c', x: 400, y: 0, w: 100, h: 100 }],
    wires: [] as any[],
  }
  const flow: GlassFlow = {
    onMoveStart: (cb) => { start = cb }, onMoveEnd: (cb) => { end = cb },
    viewport, boxes: () => state.boxes, wires: () => state.wires, size: () => ({ width: 1200, height: 800 }),
  }
  return { flow, viewport, state, fireStart: () => start(), fireEnd: () => end() }
}

describe('createCanvasGlass', () => {
  beforeEach(() => { vi.useFakeTimers() })

  it('blurs only overlapping nodes at rest', () => {
    const f = fakeFlow()
    const g = createCanvasGlass(f.flow)
    g.recompute()
    expect(g.rootClass.value).toContain('canvas-glass--blur')
    expect(g.blurIds.value).toEqual(new Set(['a', 'b']))
  })

  it('drops blur the moment the canvas moves, restores it after settling', async () => {
    const f = fakeFlow()
    const g = createCanvasGlass(f.flow, { settleMs: 150 })
    g.recompute()
    f.fireStart()
    expect(g.rootClass.value).not.toContain('canvas-glass--blur')
    f.fireEnd()
    expect(g.rootClass.value).not.toContain('canvas-glass--blur') // still settling
    vi.advanceTimersByTime(150)
    await nextTick()
    expect(g.rootClass.value).toContain('canvas-glass--blur')
  })

  it('updates --canvas-zoom only at move end', () => {
    const f = fakeFlow()
    const g = createCanvasGlass(f.flow, { settleMs: 0 })
    f.fireStart()
    f.viewport.value = { x: 0, y: 0, zoom: 2 }
    expect(g.rootStyle.value['--canvas-zoom']).toBe('1')
    f.fireEnd(); vi.advanceTimersByTime(0)
    expect(g.rootStyle.value['--canvas-zoom']).toBe('2')
  })

  it("mode 'never' keeps the root un-blurred", () => {
    const f = fakeFlow()
    const g = createCanvasGlass(f.flow, { mode: ref('never') })
    g.recompute()
    expect(g.rootClass.value).toBe('canvas-glass')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/canvas-glass.unit.spec.ts`
Expected: FAIL, cannot resolve `~/composables/useCanvasGlass`.

- [ ] **Step 3: Implement**

```ts
// frontend/app/composables/useCanvasGlass.ts
import { computed, inject, provide, ref, toValue, type ComputedRef, type InjectionKey, type MaybeRefOrGetter, type Ref } from 'vue'
import { blurAllowed, countVisible, nodesWithSomethingBehind, type GlassMode, type NodeBox, type Wire } from '~/lib/canvas/glassPolicy'

export interface GlassFlow {
  onMoveStart(cb: () => void): void
  onMoveEnd(cb: () => void): void
  viewport: Ref<{ x: number; y: number; zoom: number }>
  boxes: () => NodeBox[]
  wires: () => Wire[]
  size: () => { width: number; height: number }
}

/**
 * The canvas's glass switch. Blur is decided once per REST, never per frame: move start
 * turns it off with a single class change on the root, move end (after a short settle)
 * recomputes which nodes have something behind them and turns it back on. The zoom used
 * for the one-screen-pixel border is also published only at rest, so a pinch never
 * restyles every node on every frame.
 */
export function createCanvasGlass(flow: GlassFlow, opts: { mode?: Ref<GlassMode>; settleMs?: number } = {}) {
  const mode = opts.mode ?? ref<GlassMode>('smart')
  const settleMs = opts.settleMs ?? 150
  const moving = ref(false)
  const zoomAtRest = ref(flow.viewport.value.zoom)
  const visible = ref(0)
  const blurIds = ref<Set<string>>(new Set())
  let settle: ReturnType<typeof setTimeout> | null = null

  function recompute() {
    const boxes = flow.boxes()
    const { width, height } = flow.size()
    visible.value = countVisible(boxes, { ...flow.viewport.value, width, height })
    blurIds.value = nodesWithSomethingBehind(boxes, flow.wires())
  }

  flow.onMoveStart(() => {
    if (settle) { clearTimeout(settle); settle = null }
    moving.value = true
  })
  flow.onMoveEnd(() => {
    if (settle) clearTimeout(settle)
    settle = setTimeout(() => {
      settle = null
      zoomAtRest.value = flow.viewport.value.zoom
      recompute()
      moving.value = false
    }, settleMs)
  })

  const allowed = computed(() => blurAllowed({ mode: mode.value, moving: moving.value, zoom: zoomAtRest.value, visibleNodes: visible.value }))
  const rootClass = computed(() => (allowed.value ? 'canvas-glass canvas-glass--blur' : 'canvas-glass'))
  const rootStyle = computed(() => ({ '--canvas-zoom': String(zoomAtRest.value) }))
  return { rootClass, rootStyle, blurIds, recompute, moving }
}

export const CANVAS_GLASS_KEY: InjectionKey<{ blurIds: Ref<Set<string>> }> = Symbol('canvas-glass')

export function provideCanvasGlass(g: { blurIds: Ref<Set<string>> }) {
  provide(CANVAS_GLASS_KEY, g)
}

/** True when this node should carry real blur. False outside a canvas (dev pages, studios). */
export function useNodeGlass(nodeId: MaybeRefOrGetter<string | undefined>): ComputedRef<boolean> {
  const g = inject(CANVAS_GLASS_KEY, null)
  return computed(() => {
    const id = toValue(nodeId)
    return !!g && !!id && g.blurIds.value.has(id)
  })
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/canvas-glass.unit.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**: `frontend/app/composables/useCanvasGlass.ts`, `frontend/tests/unit/canvas-glass.unit.spec.ts` — `feat(nodes): canvas glass composable — one root class, blur decided at rest`.

---

### Task 3: Surface stylesheet and node typography

**Files:**
- Create: `frontend/app/assets/css/node-surfaces.css`
- Modify: `frontend/nuxt.config.ts` (the `css: [` array, around line 241): add `'~/assets/css/node-surfaces.css',` after `main.css`.
- Test: `frontend/tests/unit/node-surfaces.unit.spec.ts` (stylesheet guards only in this task; Task 4 adds mount tests to the same file)

**Interfaces:**
- Produces these class names, used by every later task and stage:
  `.node-shell`, `.node-shell__head`, `.node-shell__title`, `.node-shell__actions`, `.node-shell__body`, `.node-shell__foot`, `.node-well`, `.node-openbar`, `.node-openbar__meta`, `.content-card`, `.content-card__name`, `.content-card__media`, `.node-float-actions`, `.print-surface`, `.print-surface__glow`, `.print-surface__art`, `.print-surface__name`, `.print-surface__size`, `.node-btn`, `.node-btn--primary`, `.node-btn__price`.
  Attribute `data-glass-blur` on `.node-shell` turns on real blur **only** under `.canvas-glass--blur`.

- [ ] **Step 1: Write the failing guard tests**

```ts
// frontend/tests/unit/node-surfaces.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CSS = readFileSync(fileURLToPath(new URL('../../app/assets/css/node-surfaces.css', import.meta.url)), 'utf8')
const rule = (sel: string) => {
  const i = CSS.indexOf(`${sel} {`)
  if (i < 0) throw new Error(`rule ${sel} not found`)
  return CSS.slice(i, CSS.indexOf('}', i))
}

describe('node-surfaces.css guards', () => {
  it('shell fill is flat: no gradient inside a shell (a lighter top reads as a dark seam)', () => {
    expect(rule('.node-shell')).not.toMatch(/gradient/)
  })
  it('shell has no inner highlight line (it doubles the top edge)', () => {
    expect(rule('.node-shell')).not.toMatch(/inset\s+0\s+1px/)
  })
  it('borders stay one screen pixel at every zoom', () => {
    expect(rule('.node-shell')).toMatch(/calc\(1px \/ var\(--canvas-zoom, 1\)\)/)
  })
  it('real blur only under the canvas switch AND the node flag', () => {
    expect(CSS).toMatch(/\.canvas-glass--blur \.node-shell\[data-glass-blur\] \{[^}]*backdrop-filter: blur\(18px\) saturate\(1\.4\)/)
    expect(CSS.replace(/\.canvas-glass--blur \.node-shell\[data-glass-blur\] \{[^}]*\}/, '')).not.toMatch(/backdrop-filter: blur\(18px\)/)
  })
  it('never promotes layers', () => {
    expect(CSS).not.toMatch(/will-change|translateZ/)
  })
  it('node text is 500, titles 600', () => {
    expect(rule('.node-shell')).toMatch(/font-weight: 500/)
    expect(rule('.node-shell__title')).toMatch(/font-weight: 600/)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/node-surfaces.unit.spec.ts`
Expected: FAIL, ENOENT on `node-surfaces.css`.

- [ ] **Step 3: Write the stylesheet**

```css
/* frontend/app/assets/css/node-surfaces.css
 *
 * Every canvas node surface, in one place, so nodes cannot drift apart again.
 * Spec: docs/superpowers/specs/2026-09-27-node-design-design.md
 *
 * Rules that cost a real bug to learn (see the spec):
 * - one even border, nothing else on the edge: no inner highlight, no gradient fill;
 * - border thickness divided by the canvas zoom, published only at rest;
 * - real blur is optional and only switched on under .canvas-glass--blur;
 * - never force a GPU layer here (it crashed the tab on 09-04).
 */

:root {
  --node-glass-tint: rgba(26, 26, 28, 0.58);
  --node-edge: rgba(255, 255, 255, 0.10);
  --node-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
  --node-radius: 16px;
  --node-inset: 10px;
  --node-control-radius: 6px;
  --node-hair: calc(1px / var(--canvas-zoom, 1));
}

/* ---------- instrument / studio shell ---------- */
.node-shell {
  position: relative;
  border-radius: var(--node-radius);
  border: var(--node-hair) solid var(--node-edge);
  background: var(--node-glass-tint);
  box-shadow: var(--node-shadow);
  color: rgba(255, 255, 255, 0.92);
  font-weight: 500;
}
/* The only place real blur exists. Same tint as without blur, so over empty canvas
   (a flat colour, which blurs to itself) switching it on or off changes nothing. */
.canvas-glass--blur .node-shell[data-glass-blur] {
  backdrop-filter: blur(18px) saturate(1.4);
  -webkit-backdrop-filter: blur(18px) saturate(1.4);
}
.node-shell__head {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 42px;
  padding: 0 var(--node-inset) 0 14px;
}
.node-shell__icon { flex: none; width: 15px; height: 15px; color: rgba(255, 255, 255, 0.6); }
.node-shell__title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
}
.node-shell__actions { display: flex; gap: 2px; opacity: 0; transition: opacity 0.15s; }
.node-shell:hover .node-shell__actions,
.node-shell:focus-within .node-shell__actions,
.node-shell[data-selected] .node-shell__actions { opacity: 1; }
.node-shell__body {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 0 var(--node-inset) var(--node-inset);
}
.node-shell__foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px var(--node-inset) var(--node-inset) 14px;
  border-top: var(--node-hair) solid rgba(255, 255, 255, 0.06);
}

/* ---------- wells (prompt, preview) ---------- */
.node-well {
  position: relative;
  border-radius: var(--node-control-radius);
  background: rgba(0, 0, 0, 0.35);
  overflow: hidden;
}
.node-well::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);
  pointer-events: none;
  z-index: 4;
}

/* ---------- the Open bar: rises over the bottom of a preview ---------- */
.node-openbar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 38px;
  padding: 0 5px 0 11px;
  background: rgba(22, 22, 22, 0.82);
  border-top: 1px solid rgba(255, 255, 255, 0.07);
  transform: translateY(100%);
  opacity: 0;
  transition: transform 0.2s cubic-bezier(0.3, 0.7, 0.4, 1), opacity 0.15s;
}
/* Frosted only when the canvas allows blur; the bar is 82% opaque either way. */
.canvas-glass--blur .node-openbar { backdrop-filter: blur(14px) saturate(1.3); -webkit-backdrop-filter: blur(14px) saturate(1.3); }
.node-openbar-host:hover .node-openbar,
.node-openbar-host:focus-within .node-openbar,
.node-openbar-host[data-selected] .node-openbar { transform: none; opacity: 1; }
.node-openbar__meta {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.6);
}

/* ---------- buttons ---------- */
.node-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border-radius: var(--node-control-radius);
  font-size: 12px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.6);
}
.node-btn:hover { background: rgba(255, 255, 255, 0.08); color: rgba(255, 255, 255, 0.92); }
.node-btn--primary { background: #f2f2f2; color: #111; }
.node-btn--primary:hover { background: #fff; color: #111; }
.node-btn__price { font-weight: 500; color: rgba(0, 0, 0, 0.45); }

/* ---------- content card ---------- */
.content-card { position: relative; font-weight: 500; }
.content-card__name {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.4);
  transition: color 0.15s;
}
.content-card:hover .content-card__name,
.content-card[data-selected] .content-card__name { color: rgba(255, 255, 255, 0.6); }
.content-card__media {
  position: relative;
  border-radius: 12px;
  overflow: hidden;
  background: #1a1a1c;
  box-shadow: var(--node-shadow);
}
.content-card__media::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);
  pointer-events: none;
  z-index: 4;
}
.node-float-actions {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 3;
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.15s;
}
.content-card:hover .node-float-actions,
.content-card:focus-within .node-float-actions,
.content-card[data-selected] .node-float-actions { opacity: 1; }
.node-float-actions > button {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: var(--node-control-radius);
  background: rgba(20, 20, 20, 0.72);
  color: rgba(255, 255, 255, 0.92);
}

/* ---------- print surface (Frame, Timeline) ---------- */
.print-surface { position: relative; font-weight: 500; }
.print-surface__label { display: flex; align-items: baseline; gap: 8px; height: 26px; font-size: 13px; }
.print-surface__name { font-weight: 600; color: rgba(255, 255, 255, 0.92); }
.print-surface__size { font-size: 12px; color: rgba(255, 255, 255, 0.4); font-variant-numeric: tabular-nums; }
.print-surface__glass {
  position: relative;
  padding: 6px;
  border-radius: 8px;
  overflow: hidden;
  /* One even ring, nothing along the top: the same rule as the shells. */
  box-shadow: inset 0 0 0 var(--node-hair) rgba(255, 255, 255, 0.24), 0 26px 70px rgba(0, 0, 0, 0.55), 0 4px 14px rgba(0, 0, 0, 0.35);
}
/* The glass takes its colour from the artwork: the picture itself, heavily blurred,
   under a white veil. Painted once per artwork change; it does not re-blur on pan. */
.print-surface__glow { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.print-surface__glow > img {
  position: absolute;
  inset: -30%;
  width: 160%;
  height: 160%;
  object-fit: cover;
  filter: blur(28px) saturate(1.6) brightness(1.1);
  opacity: 0.75;
}
.print-surface__glow::after {
  content: '';
  position: absolute;
  inset: 0;
  background: rgba(255, 255, 255, 0.2);
}
.print-surface__art { position: relative; z-index: 1; border-radius: 3px; overflow: hidden; }
```

- [ ] **Step 4: Register it**

In `frontend/nuxt.config.ts`, inside `css: [` add the line `'~/assets/css/node-surfaces.css',` directly after `'~/assets/css/main.css',`.

- [ ] **Step 5: Run to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/node-surfaces.unit.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**: the three files — `feat(nodes): shared node surface stylesheet — shell, wells, cards, print surface`.

Note for the reviewer: the print surface's `filter: blur(28px)` is on a **static image inside the node**, not a backdrop filter; it is rasterised once and moves with the node like any picture. It is not subject to the glass policy.

---

### Task 4: Shell, well, Open bar, content card and print surface components

**Files:**
- Create: `frontend/app/components/vue-canvas/surfaces/NodeShell.vue`, `NodeWell.vue`, `NodeOpenBar.vue`, `ContentCard.vue`, `PrintSurface.vue`
- Test: append to `frontend/tests/unit/node-surfaces.unit.spec.ts`

**Interfaces:**
- Consumes: Task 2 `useNodeGlass`; Task 3 classes.
- Produces (props / slots):
  - `NodeShell` props `{ title: string; nodeId?: string; selected?: boolean }`; slots `icon`, `actions`, default (body), `foot`. Renders `data-glass-blur` when `useNodeGlass(nodeId)` is true, `data-selected` when selected.
  - `NodeWell` props `{ selected?: boolean }`; slots default, `openbar`. When the `openbar` slot is used, the well gets class `node-openbar-host`.
  - `NodeOpenBar` props `{ meta?: string }`; default slot = actions.
  - `ContentCard` props `{ name: string; selected?: boolean }`; slots `icon`, default (media), `actions`.
  - `PrintSurface` props `{ name: string; size?: string; artwork?: string; selected?: boolean }`; slots default (art, used instead of `artwork` when given), `openbar`.

- [ ] **Step 1: Write the failing mount tests** (append; add `// @vitest-environment happy-dom` as the FIRST line of the file)

```ts
import { mount } from '@vue/test-utils'
import { ref, h } from 'vue'
import NodeShell from '~/components/vue-canvas/surfaces/NodeShell.vue'
import NodeWell from '~/components/vue-canvas/surfaces/NodeWell.vue'
import NodeOpenBar from '~/components/vue-canvas/surfaces/NodeOpenBar.vue'
import ContentCard from '~/components/vue-canvas/surfaces/ContentCard.vue'
import PrintSurface from '~/components/vue-canvas/surfaces/PrintSurface.vue'
import { CANVAS_GLASS_KEY } from '~/composables/useCanvasGlass'

describe('NodeShell', () => {
  it('renders title, body and foot', () => {
    const w = mount(NodeShell, { props: { title: 'Generate an image' }, slots: { default: 'BODY', foot: 'FOOT' } })
    expect(w.find('.node-shell__title').text()).toBe('Generate an image')
    expect(w.find('.node-shell__body').text()).toBe('BODY')
    expect(w.find('.node-shell__foot').text()).toBe('FOOT')
  })
  it('omits the foot when no foot slot is given', () => {
    const w = mount(NodeShell, { props: { title: 'Gradient' } })
    expect(w.find('.node-shell__foot').exists()).toBe(false)
  })
  it('asks for real blur only when the canvas marks this node', () => {
    const blurIds = ref(new Set(['n1']))
    const on = mount(NodeShell, { props: { title: 't', nodeId: 'n1' }, global: { provide: { [CANVAS_GLASS_KEY as symbol]: { blurIds } } } })
    const off = mount(NodeShell, { props: { title: 't', nodeId: 'n2' }, global: { provide: { [CANVAS_GLASS_KEY as symbol]: { blurIds } } } })
    expect(on.find('.node-shell').attributes('data-glass-blur')).toBeDefined()
    expect(off.find('.node-shell').attributes('data-glass-blur')).toBeUndefined()
  })
})

describe('NodeWell + NodeOpenBar', () => {
  it('becomes an Open bar host only with an openbar slot', () => {
    const plain = mount(NodeWell, { slots: { default: 'x' } })
    const host = mount(NodeWell, { slots: { default: 'x', openbar: () => h(NodeOpenBar, { meta: '3 colours · mesh' }, () => 'Open') } })
    expect(plain.classes()).not.toContain('node-openbar-host')
    expect(host.classes()).toContain('node-openbar-host')
    expect(host.find('.node-openbar__meta').text()).toBe('3 colours · mesh')
  })
})

describe('ContentCard', () => {
  it('names the card above its media', () => {
    const w = mount(ContentCard, { props: { name: 'beach-dog.jpg' }, slots: { default: '<img>' } })
    expect(w.find('.content-card__name').text()).toContain('beach-dog.jpg')
    expect(w.find('.content-card__media img').exists()).toBe(true)
  })
})

describe('PrintSurface', () => {
  it('uses the artwork for both the art and the glass tint', () => {
    const w = mount(PrintSurface, { props: { name: 'Frame', size: '4:5 · 1080 × 1350', artwork: '/a.jpg' } })
    expect(w.find('.print-surface__name').text()).toBe('Frame')
    expect(w.find('.print-surface__size').text()).toBe('4:5 · 1080 × 1350')
    expect(w.findAll('img').map(i => i.attributes('src'))).toEqual(['/a.jpg', '/a.jpg'])
    expect(w.find('.print-surface__glow img').attributes('alt')).toBe('')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/node-surfaces.unit.spec.ts`
Expected: FAIL, cannot resolve `surfaces/NodeShell.vue`.

- [ ] **Step 3: Implement the five components**

```vue
<!-- frontend/app/components/vue-canvas/surfaces/NodeShell.vue -->
<script setup lang="ts">
/** The instrument/studio shell. Chrome only: each node fills the slots. See node-surfaces.css. */
import { useNodeGlass } from '~/composables/useCanvasGlass'
const props = defineProps<{ title: string; nodeId?: string; selected?: boolean }>()
const glass = useNodeGlass(() => props.nodeId)
</script>

<template>
  <div class="node-shell" :data-glass-blur="glass || undefined" :data-selected="selected || undefined">
    <div class="node-shell__head">
      <span class="node-shell__icon"><slot name="icon" /></span>
      <span class="node-shell__title">{{ title }}</span>
      <div v-if="$slots.actions" class="node-shell__actions"><slot name="actions" /></div>
    </div>
    <div class="node-shell__body"><slot /></div>
    <div v-if="$slots.foot" class="node-shell__foot"><slot name="foot" /></div>
  </div>
</template>
```

```vue
<!-- frontend/app/components/vue-canvas/surfaces/NodeWell.vue -->
<script setup lang="ts">
defineProps<{ selected?: boolean }>()
</script>

<template>
  <div class="node-well" :class="{ 'node-openbar-host': !!$slots.openbar }" :data-selected="selected || undefined">
    <slot />
    <slot name="openbar" />
  </div>
</template>
```

```vue
<!-- frontend/app/components/vue-canvas/surfaces/NodeOpenBar.vue -->
<script setup lang="ts">
defineProps<{ meta?: string }>()
</script>

<template>
  <div class="node-openbar nodrag">
    <span class="node-openbar__meta">{{ meta }}</span>
    <slot />
  </div>
</template>
```

```vue
<!-- frontend/app/components/vue-canvas/surfaces/ContentCard.vue -->
<script setup lang="ts">
defineProps<{ name: string; selected?: boolean }>()
</script>

<template>
  <div class="content-card" :data-selected="selected || undefined">
    <div class="content-card__name"><slot name="icon" /><span class="truncate">{{ name }}</span></div>
    <div class="content-card__media">
      <slot />
      <div v-if="$slots.actions" class="node-float-actions nodrag"><slot name="actions" /></div>
    </div>
  </div>
</template>
```

```vue
<!-- frontend/app/components/vue-canvas/surfaces/PrintSurface.vue -->
<script setup lang="ts">
defineProps<{ name: string; size?: string; artwork?: string; selected?: boolean }>()
</script>

<template>
  <div class="print-surface" :data-selected="selected || undefined">
    <div class="print-surface__label">
      <span class="print-surface__name">{{ name }}</span>
      <span v-if="size" class="print-surface__size">{{ size }}</span>
    </div>
    <div class="print-surface__glass node-openbar-host" :data-selected="selected || undefined">
      <div v-if="artwork" class="print-surface__glow"><img :src="artwork" alt=""></div>
      <div class="print-surface__art">
        <slot><img v-if="artwork" :src="artwork" alt="" class="block w-full"></slot>
      </div>
      <slot name="openbar" />
    </div>
  </div>
</template>
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/node-surfaces.unit.spec.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**: the five components + the spec file — `feat(nodes): NodeShell, NodeWell, NodeOpenBar, ContentCard, PrintSurface`.

---

### Task 5: StudioRow — quieter fills and a comfortable size

**Files:**
- Modify: `frontend/app/components/vue-canvas/studio/StudioRow.vue` (props block ~line 25; row container ~line 330; band ~line 338; handle ~line 356; the two label spans ~lines 390 and 393)
- Test: `frontend/tests/unit/studio-row-size.unit.spec.ts`

**Interfaces:**
- Produces: new optional prop `size?: 'compact' | 'comfortable'` (default `'compact'` = today's 28px). Stage 2+ passes `size="comfortable"` on nodes. The quieter fills apply at both sizes.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment happy-dom
// frontend/tests/unit/studio-row-size.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import StudioRow from '~/components/vue-canvas/studio/StudioRow.vue'

const spec = { key: 'strength', label: 'Reference strength', kind: 'slider', min: 0, max: 100, step: 1, default: 70 } as any
const row = (w: ReturnType<typeof mount>) => w.find('[data-studio-row]')

describe('StudioRow size', () => {
  it('is 28px by default (studio inspectors)', () => {
    const w = mount(StudioRow, { props: { spec, modelValue: 70 } })
    expect(row(w).classes()).toContain('h-7')
    expect(row(w).classes()).toContain('px-2.5')
  })
  it('is 32px with 11px padding on nodes', () => {
    const w = mount(StudioRow, { props: { spec, modelValue: 70, size: 'comfortable' } })
    expect(row(w).classes()).toContain('h-8')
    expect(row(w).classes()).toContain('px-[11px]')
  })
})

describe('StudioRow quieter fills', () => {
  it('rests at 3% and answers hover at 6.5%', () => {
    const w = mount(StudioRow, { props: { spec, modelValue: 70 } })
    expect(row(w).classes()).toContain('bg-white/[0.03]')
    expect(row(w).classes()).toContain('hover:bg-white/[0.065]')
  })
  it('paints the value band at 10%', () => {
    const w = mount(StudioRow, { props: { spec, modelValue: 70 } })
    expect(w.find('[data-row-band]').attributes('style')).toMatch(/rgba\(255,\s*255,\s*255,\s*0\.1\)/)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/studio-row-size.unit.spec.ts`
Expected: FAIL, `[data-studio-row]` not found.

- [ ] **Step 3: Implement**

1. Props: change the `withDefaults(defineProps<{…}>(), { bound: null, bindable: true })` block to add `size?: 'compact' | 'comfortable'` and default `size: 'compact'`.
2. The row container `<div class="group relative flex h-7 select-none items-center justify-between overflow-hidden rounded-[6px] bg-white/[0.05] px-2.5"`: add `data-studio-row`, remove `h-7`, `px-2.5` and `bg-white/[0.05]` from the static class, and extend its `:class` to:

```ts
:class="[
  numeric && !bound && !editing ? 'cursor-ew-resize' : '',
  size === 'comfortable' ? 'h-8 px-[11px]' : 'h-7 px-2.5',
  dragging ? 'bg-white/[0.065]' : 'bg-white/[0.03] hover:bg-white/[0.065]',
  'transition-colors duration-150',
]"
```

3. The band `<div v-if="band" …>`: add `data-row-band` and change its background to
   `bound ? 'rgba(244,114,182,0.32)' : (dragging ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.1)')`,
   and add the class `transition-[background-color] duration-150`. The band brightens only while dragging; hover is answered by the row fill, not the band.
4. Comfortable handle: in the handle `<div … h-3.5 w-[2px] …>` replace `h-3.5` with `:class`-driven `size === 'comfortable' ? 'h-4' : 'h-3.5'` (merge into its existing `:class` array form).
5. Labels: in both label spans change `text-white/72` to `text-white/55`.
6. Update the comment above the row container ("6px. Every input…") to say the node size is 32px with a 10px shell inset (16 − 10 = 6), and remove the stale "shell is 14 … 14 - 8" sentence.

- [ ] **Step 4: Run to verify it passes, then the existing studio suites**

Run: `cd frontend && npx vitest run tests/unit/studio-row-size.unit.spec.ts && npx vitest run tests/unit -t "StudioRow|studio row|studio-row"`
Expected: PASS. If an existing spec asserts `bg-white/[0.05]`, `text-white/72` or `h-7` on every row, update that assertion to the new values and say so in the commit message. Do not change any other behaviour.

- [ ] **Step 5: Commit**: `StudioRow.vue` + the new spec (+ any updated spec) — `feat(studio): quieter row fills everywhere; a 32px comfortable row for nodes`.

---

### Task 6: NodePort — grow, fill and slide out on hover

**Files:**
- Modify: `frontend/app/components/vue-canvas/NodePort.vue` (template dot + label spans; `<style scoped>`)
- Test: covered by Task 8's Playwright spec (hover is a real-mouse behaviour); add a small mount test here.
- Test: `frontend/tests/unit/node-port-hover.unit.spec.ts`

**Interfaces:**
- No prop or API change. Keeps: the 16px `<Handle>` hit target above the card (see its comment — a half-covered target made drags from the inner half move the node), `forceLabel` during a compatible wire drag, `disabled`, `connectable`.
- **Deviation from the spec, on purpose:** the spec says the hover area is only the half outside the node. The existing full-size hit target fixed a real bug, so it stays; the visual grow still triggers from the handle hover. Flag this in the commit message and to Julien at the stage-1 review.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/node-port-hover.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = readFileSync(fileURLToPath(new URL('../../app/components/vue-canvas/NodePort.vue', import.meta.url)), 'utf8')

describe('NodePort hover look', () => {
  it('grows the dot to 16px and fills it on hover', () => {
    expect(SRC).toMatch(/\.node-port:hover \.node-port__dot \{[^}]*width: 16px;[^}]*height: 16px;[^}]*background: var\(--port-color\)/)
  })
  it('slides the dot out from under the node edge', () => {
    expect(SRC).toMatch(/\.node-port--left:hover \.node-port__dot \{[^}]*translate\(calc\(-50% - 5px\), -50%\)/)
    expect(SRC).toMatch(/\.node-port--right:hover \.node-port__dot \{[^}]*translate\(calc\(-50% \+ 5px\), -50%\)/)
  })
  it('names the port at 11px, weight 500', () => {
    expect(SRC).toMatch(/node-port__label[^"]*text-\[11px\]/)
    expect(SRC).toMatch(/node-port__label[^"]*font-medium/)
  })
  it('keeps the full-size hit target above the card', () => {
    expect(SRC).toMatch(/zIndex: 20/)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/node-port-hover.unit.spec.ts`
Expected: FAIL on the first three.

- [ ] **Step 3: Implement**

1. Wrapper `<div class="node-port absolute size-4 …">`: add `side === 'left' ? 'node-port--left' : 'node-port--right'` to its `:class` array, and add `'--port-color': color` to a `:style` (merge with the existing `top` style object).
2. Dot span: replace the Tailwind positioning/size classes `left-1/2 top-1/2 size-3 -translate-x-1/2 -translate-y-1/2` with nothing (the scoped CSS below positions it) and keep `pointer-events-none absolute rounded-full border-2 bg-[#1a1a1a]`. Remove `transition-shadow duration-150`.
3. Label span: change `text-[9px]` to `text-[11px] font-medium`, `px-1.5 py-0.5` to `px-[7px] py-[3px]`, and `rounded` to `rounded-[6px]`; change `bg-[#12141a]` to `bg-[#222]`; change the label side offsets `right-5` / `left-5` to `right-6` / `left-6` so it clears the grown dot.
4. Replace the `<style scoped>` block with:

```css
/* Hover reveals this port's name, and only this port's. CSS, not JS: a canvas can hold
   hundreds of ports. */
.node-port__dot {
  left: 50%;
  top: 50%;
  width: 12px;
  height: 12px;
  transform: translate(-50%, -50%);
  transition: width 0.16s cubic-bezier(0.3, 0.7, 0.4, 1), height 0.16s cubic-bezier(0.3, 0.7, 0.4, 1),
    transform 0.16s cubic-bezier(0.3, 0.7, 0.4, 1), background-color 0.16s, box-shadow 0.16s;
}
.node-port:hover .node-port__label { opacity: 1; }
.node-port:hover .node-port__dot {
  width: 16px;
  height: 16px;
  background: var(--port-color);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--port-color) 22%, transparent);
}
/* Out from under the node's edge, so the grown dot is grabbable. */
.node-port--left:hover .node-port__dot { transform: translate(calc(-50% - 5px), -50%); }
.node-port--right:hover .node-port__dot { transform: translate(calc(-50% + 5px), -50%); }
```

5. The dot's existing inline `boxShadow` for `forceLabel` stays (it is the wire-drag cue).

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/node-port-hover.unit.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**: `NodePort.vue` + the spec — `feat(canvas): ports grow, fill and slide out on hover; one name at a time (hit target kept full-size on purpose)`.

---

### Task 7: Wire the glass into the canvas

**Files:**
- Modify: `frontend/app/components/vue-canvas/VueNodeCanvas.vue` (script: after the `useVueFlow()` destructure ~line 1247; template: the root element with `ref="canvasRootRef"` ~line 8481)

**Interfaces:**
- Consumes: Task 2 `createCanvasGlass`, `provideCanvasGlass`.
- Produces: `.canvas-glass` (and at rest `.canvas-glass--blur`) plus `--canvas-zoom` on the canvas root; `provide(CANVAS_GLASS_KEY)` for every node below. No node reads it yet (stage 2 does), so nothing on screen changes in this task.

- [ ] **Step 1: Add the composable**

After the `} = useVueFlow()` destructure, add (import `createCanvasGlass, provideCanvasGlass` from `~/composables/useCanvasGlass`, and `onMoveStart, onMoveEnd, getNodes, getEdges` from the same `useVueFlow()` call if not already destructured — add them to the existing destructure rather than calling `useVueFlow()` twice):

```ts
// Glass: real blur only at rest and only on nodes with something behind them.
// Decided once per rest, never per frame (docs/superpowers/specs/2026-09-27-node-design-design.md).
const canvasGlass = createCanvasGlass({
  onMoveStart: (cb) => onMoveStart(cb),
  onMoveEnd: (cb) => onMoveEnd(cb),
  viewport: vfViewport,
  boxes: () => getNodes.value
    .filter(n => n.dimensions.width > 0)
    .map(n => ({ id: n.id, x: n.computedPosition.x, y: n.computedPosition.y, w: n.dimensions.width, h: n.dimensions.height })),
  wires: () => getEdges.value
    .filter(e => e.sourceX != null && e.targetX != null)
    .map(e => ({ source: e.source, target: e.target, sx: e.sourceX, sy: e.sourceY, tx: e.targetX, ty: e.targetY })),
  size: () => ({ width: canvasRootRef.value?.clientWidth ?? 0, height: canvasRootRef.value?.clientHeight ?? 0 }),
})
provideCanvasGlass(canvasGlass)
onNodeDragStop(() => canvasGlass.recompute())
onMounted(() => canvasGlass.recompute())
```

If `onNodeDragStop` is already registered elsewhere, register a second listener (Vue Flow hooks accept several); do not edit the existing one.

- [ ] **Step 2: Bind on the root**

On the element carrying `ref="canvasRootRef"`, add `:class="canvasGlass.rootClass.value"` and `:style="canvasGlass.rootStyle.value"`. If the element already has `:class` / `:style`, merge into array form (`:class="[existing, canvasGlass.rootClass.value]"`); do not drop existing bindings.

- [ ] **Step 3: Typecheck the file**

Run: `cd frontend && npx vue-tsc --noEmit -p . 2>&1 | grep -E "VueNodeCanvas|useCanvasGlass|glassPolicy" | head`
Expected: no lines for these files. (The repo has a typecheck baseline with unrelated errors; only new errors in these three files count.)

- [ ] **Step 4: Check the live canvas**

On the existing `:3002` (do not start a server), open a project and run in the page:

```js
const r = document.querySelector('.canvas-glass'); [r?.className, getComputedStyle(r).getPropertyValue('--canvas-zoom')]
```
Expected: a class string containing `canvas-glass` and a zoom value. Pan the canvas and run it again after stopping: the zoom value matches the new zoom. Nothing on screen looks different (no node uses the shells yet).

- [ ] **Step 5: Commit**: `VueNodeCanvas.vue` only, by hunk if another session has it open (`git diff -- <file>` → pick only your hunks with `git apply --cached`) — `feat(canvas): the glass switch on the canvas root; blur decided at rest`.

---

### Task 8: Node lab page and real-mouse checks

**Files:**
- Create: `frontend/app/pages/dev/node-lab.vue`
- Create: `frontend/tests/node-lab.spec.ts`

**Interfaces:**
- Consumes: Tasks 3–6.
- Produces: `/dev/node-lab`, a page showing, on the dark dotted canvas colour: a Generate-an-image instrument (prompt well, four comfortable `StudioRow`s including a slider, footer with "Not run yet" and "Run $0.03"), a Gradient studio (preview well + Open bar "3 colours · mesh" / Open), an image content card (name "beach-dog.jpg", Download + More hover actions), a Frame print surface (name "Frame", size "4:5 · 1080 × 1350"), each with ports (`NodePort` needs Vue Flow's handle context, so wrap the lab in a `<VueFlow>` with the four nodes as custom node types — the same wrapper pattern as `pages/dev/capsule-lab.vue` but with `VueFlow`). Images: use any picture already under `frontend/public/` (e.g. `/hero/hero_rotateimage.png`); do not add binaries.

- [ ] **Step 1: Write the Playwright spec (it fails: page missing)**

```ts
// frontend/tests/node-lab.spec.ts
import { test, expect } from '@playwright/test'

test.describe('node lab', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dev/node-lab')
    await expect(page.locator('.node-shell').first()).toBeVisible()
  })

  test('a port grows, fills and names only itself on hover', async ({ page }) => {
    const ports = page.locator('.node-port')
    await ports.first().hover()
    const dot = ports.first().locator('.node-port__dot')
    await expect.poll(async () => (await dot.boundingBox())?.width).toBeGreaterThan(15)
    const shown = await page.locator('.node-port__label').evaluateAll(els => els.filter(e => getComputedStyle(e).opacity === '1').length)
    expect(shown).toBe(1)
  })

  test('the Open bar rises on hover and is hidden at rest', async ({ page }) => {
    const host = page.locator('.node-openbar-host').first()
    const bar = host.locator('.node-openbar')
    await page.mouse.move(5, 5)
    await expect.poll(() => bar.evaluate(e => getComputedStyle(e).opacity)).toBe('0')
    await host.hover()
    await expect.poll(() => bar.evaluate(e => getComputedStyle(e).opacity)).toBe('1')
  })

  test('node rows are 32px', async ({ page }) => {
    const h = await page.locator('.node-shell [data-studio-row]').first().evaluate(e => e.getBoundingClientRect().height)
    expect(h).toBe(32)
  })

  test('shell edges are one even colour and width on all four sides', async ({ page }) => {
    const s = await page.locator('.node-shell').first().evaluate(e => {
      const c = getComputedStyle(e)
      return [c.borderTopWidth, c.borderRightWidth, c.borderBottomWidth, c.borderLeftWidth, c.borderTopColor, c.borderLeftColor]
    })
    expect(new Set(s.slice(0, 4)).size).toBe(1)
    expect(s[4]).toBe(s[5])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx playwright test tests/node-lab.spec.ts`
Expected: FAIL (404 / `.node-shell` not visible). If `:3002` itself is down or answering 500, stop and report instead.

- [ ] **Step 3: Build the page** with the content listed under Interfaces. Copy (sentence case, no identifiers): "Generate an image", prompt text "The dog from the reference, grinning on a beach at noon, shot on 35mm, warm light", rows Model "Nano Banana 2", Size "Square 1:1", References (one thumbnail), slider "Reference strength" 70%; footer "Not run yet" and a primary `node-btn` "Run" with price "$0.03" in `node-btn__price`. Studio: "Gradient", Open bar meta "3 colours · mesh", button "Open". Card: "beach-dog.jpg". Print: "Frame", "4:5 · 1080 × 1350", Open bar with "Render" and "Open". Wrap the page root in a div with classes `canvas-glass canvas-glass--blur` so the lab shows the at-rest look, and give the Generate node and the Gradient overlapping positions so one shell shows real blur over the other.

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx playwright test tests/node-lab.spec.ts`
Expected: PASS (4 tests). Also take one screenshot of `/dev/node-lab` for the stage review.

- [ ] **Step 5: Commit**: the page + the spec — `feat(dev): node lab — every shared node surface with real-mouse checks`.

---

### Task 9: Glass benchmark and the blur decision

**Files:**
- Create: `frontend/app/pages/dev/glass-bench.vue`

**Interfaces:**
- Consumes: Tasks 1–4 and 7's wiring pattern (use `createCanvasGlass` with a `mode` ref).
- Produces: `/dev/glass-bench` — a real `<VueFlow>` with **40 `NodeShell` nodes** (half overlapping in pairs, 30 wires, several passing behind other nodes), a mode switch **Always / Smart / Never**, a **Pan** button that animates `setViewport` in a figure-eight for 6 seconds (then a 6-second pinch zoom 1 → 0.6 → 1), and a readout of frame times from `requestAnimationFrame` deltas during the run: median, 95th percentile, and dropped frames (deltas > 20 ms). Results also go to `console.table` and to `window.__glassBench` so they can be read back.

- [ ] **Step 1: Build the page**

Core of the measurement (put in the page's script):

```ts
async function runBench(label: string) {
  const deltas: number[] = []
  let last = performance.now(), running = true
  const tick = (t: number) => { deltas.push(t - last); last = t; if (running) requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
  const start = performance.now()
  await new Promise<void>((resolve) => {
    const step = () => {
      const t = (performance.now() - start) / 1000
      if (t > 12) { resolve(); return }
      if (t <= 6) setViewport({ x: Math.sin(t * 2) * 400, y: Math.sin(t * 4) * 150, zoom: 1 })
      else setViewport({ x: 0, y: 0, zoom: 1 - 0.4 * Math.sin(((t - 6) / 6) * Math.PI) })
      requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  })
  running = false
  const s = deltas.slice(5).sort((a, b) => a - b)
  const result = { label, median: s[Math.floor(s.length / 2)], p95: s[Math.floor(s.length * 0.95)], dropped: s.filter(d => d > 20).length, frames: s.length }
  ;(window as any).__glassBench = [...((window as any).__glassBench ?? []), result]
  console.table([result])
  return result
}
```

Note: `setViewport` pans programmatically and does **not** fire Vue Flow's move events, so the bench must call `canvasGlass`'s move start before the run and move end after it when in Smart mode (expose small `beginMove()` / `endMove()` wrappers in the page that call the same callbacks registered through `onMoveStart` / `onMoveEnd`). State this in a comment on the page.

- [ ] **Step 2: Self-check it renders** (in the Browser pane is fine for this: it only checks rendering, not timing)

Open `/dev/glass-bench` on `:3002`; expect 40 shells, wires, and the three mode buttons. Do not read any timing from the pane.

- [ ] **Step 3: Commit**: the page — `feat(dev): glass benchmark — 40 glass nodes, auto pan and zoom, frame times`.

- [ ] **Step 4: The measurement (controller, not a subagent), in a visible tab**

Either drive Julien's Chrome through the Claude in Chrome extension (if `list_connected_browsers` shows one), or ask Julien to open `http://127.0.0.1:3002/dev/glass-bench` in his own browser at his normal window size, click Pan once in each mode, and paste `copy(JSON.stringify(window.__glassBench))` output back. Record the three results.

- [ ] **Step 5: Decide, and write it down**

Rule: keep **Smart** if its median ≤ 17 ms and p95 ≤ 25 ms and it drops no more frames than **Never** + 5. Otherwise ship **Never** (the exit route: tint-only glass; set the default `mode` in `useCanvasGlass` to `'never'`, and for permanent Never raise the flat tint to `rgba(26,26,28,.86)` in `node-surfaces.css` under `.canvas-glass:not(.canvas-glass--blur) .node-shell` so a wire behind a node doesn't show sharply through it). Add a short "Glass decision" section with the numbers to the spec, and commit the spec (and the mode/tint change if Never) — `docs(nodes): glass benchmark results — <Smart|Never> ships`.

---

## After stage 1

- Update the build dashboard (standing rule): one line in Landed, move the Node design row in Your decisions to "stage 1 built — look at /dev/node-lab".
- Write the **stage 2 plan (instruments)** against the real `NodeShell` API: `ComfyNode.vue` (frame and template only, hunk-staged), Gate, Shader effect, Subgraph in/out; `StudioRow size="comfortable"` on nodes; header actions to the `actions` slot; the price moves onto Run. Then stages 3, 4, 5 the same way.
- Owed to Julien at the stage-1 review: the port hit-target deviation (Task 6), the 16/10/6 geometry, and the glass decision.
