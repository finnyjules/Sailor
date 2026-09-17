# Unified Motion — Phase 2: Frame adapter + flagged render wiring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let the `motionx` core drive Frame's render: a Frame adapter that applies resolved property values onto layers, plus one fold wired into `paintLayerStack` gated on the presence of `motion.motionx` tracks — so with none present (no author path until Phase 3) the app is byte-identical.

**Architecture:** A new `app/lib/motionx/adapter/frame.ts` — the ONE intentionally Frame-coupled file (the `motionx/` core stays pure). It parses Frame-scoped track paths (`layers.<id>.<prop>`), evaluates them via the core's `evaluateTracks`, and applies each resolved value onto a cloned `LocalLayer`: transform/opacity direct; effect dials via `effectStackOf`/`writeStackToLayer`; fill via `gradientPaint` helpers. A thin fold `applyMotionxTracks(layers, tracks, t)` joins the existing fold chain in `useCompositorLayers.paintLayerStack`, gated on `tracks?.length`.

**Tech Stack:** TypeScript (strict), Vitest, Vue 3 (compositor).

**Depends on:** Phase 1 `app/lib/motionx/` (landed): `evaluateTracks`, `Track`, `PropertyValue`. `gradientPaint.ts` (landed): `withScrolledStops`, `withGradientStops`, `paintStopsToColor`. `effectStack.ts`: `effectStackOf`, `writeStackToLayer`. `paint.ts`: `isGradient`.

## Global Constraints

- **The adapter is the ONLY Frame-coupled motionx file.** `app/lib/motionx/adapter/frame.ts` may import compositor types/helpers; nothing in `app/lib/motionx/*.ts` (the core) may. Do not add compositor imports to the core.
- **Byte-identity:** `applyMotionxTracks` returns the SAME array reference when `tracks` is empty/absent or nothing resolves; non-targeted layers returned by identity. Gated on presence in the render, so an un-authored Frame is byte-identical.
- **Frame track paths:** `layers.<id>.<prop>` where `<prop>` ∈ `x | y | rotation | scale | opacity | fill | fill.phase | effects.<effectId>.<dialKey>`. Values: number for transform/opacity/fill.phase/numeric dials; hex string for colour dials; `GradientStop[]` ({pos,color}) for `fill`.
- **Stop shapes:** the core/`fill` gradient value is `{pos,color}` (`GradientStop` from `~/lib/color/harmony`); the layer fill is `{offset,color}`. Convert only via `gradientPaint`'s `withGradientStops`/`paintStopsToColor`.
- **Shared-file commits:** `useCompositorLayers.ts` is edited by a parallel session — commit it ONLY via a private git index (`GIT_INDEX_FILE=$(mktemp); git read-tree HEAD; git add -- <file>; git commit …`), never `git add -A`/bare. New adapter file + tests commit via pathspec. End messages with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Tests:** `tests/unit/motionx/**/*.unit.spec.ts`, `npm run test:unit` (from `frontend/`), `~` alias.
- **Spec:** `docs/superpowers/specs/2026-09-17-unified-motion-model-design.md`. Paths relative to `frontend/`.

## File Structure

- `app/lib/motionx/adapter/frame.ts` — `applyResolvedValue`, `applyMotionxTracks`, `frameTarget`, `animatableProperties`.
- `app/composables/useCompositorLayers.ts` — add `motionx?: Track[]` to the `motion` param type; add the fold to the chain (private-index commit).
- tests: `tests/unit/motionx/adapter-frame.unit.spec.ts`.

---

### Task 1: `applyResolvedValue` — apply one property to a cloned layer

**Files:**
- Create: `app/lib/motionx/adapter/frame.ts`
- Test: `tests/unit/motionx/adapter-frame.unit.spec.ts`

**Interfaces:**
- Consumes: `withScrolledStops`, `withGradientStops` from `~/lib/compositor/gradientPaint`; `isGradient` from `~/lib/compositor/paint`; `effectStackOf`, `writeStackToLayer` from `~/lib/compositor/effectStack`; `PropertyValue` from `~/lib/motionx`; `LocalLayer` (type) from `~/composables/useCompositorLayers`; `GradientStop as ColorStop` from `~/lib/color/harmony`.
- Produces: `applyResolvedValue(layer: LocalLayer, prop: string, value: PropertyValue): LocalLayer` — returns a NEW layer with `prop` set. `x`/`y`/`rotation`/`scale`/`opacity` → direct number field. `fill.phase` → `withScrolledStops(fill, value)` when the fill is a gradient (else unchanged). `fill` → `withGradientStops(fill, value as ColorStop[])` when the fill is a gradient. `effects.<id>.<dial>` → materialise the stack via `effectStackOf`, set `[dial]=value` on the matching effect id, `writeStackToLayer`. Unknown/inapplicable prop → the input layer unchanged (same ref).

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/motionx/adapter-frame.unit.spec.ts
import { describe, it, expect } from 'vitest'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { applyResolvedValue } from '~/lib/motionx/adapter/frame'
import type { GradientStop } from '~/lib/color/harmony'

const grad = () => ({ type: 'linear' as const, angle: 0, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ff0000' }] })
const layer = (over: Partial<any> = {}) => ({ id: 'L1', x: 0.5, y: 0.5, rotation: 0, scale: 1, opacity: 1, fill: grad(), effects: [], ...over } as unknown as LocalLayer)

describe('applyResolvedValue', () => {
  it('sets a transform/opacity number field on a clone', () => {
    const out = applyResolvedValue(layer(), 'opacity', 0.4)
    expect((out as any).opacity).toBe(0.4)
    expect(out).not.toBe(layer())
  })
  it('fill gradient value rebuilds the fill (offset shape, type/angle kept)', () => {
    const stops: GradientStop[] = [{ pos: 0, color: '#0000ff' }, { pos: 1, color: '#ffffff' }]
    const out = applyResolvedValue(layer(), 'fill', stops) as any
    expect(out.fill.type).toBe('linear'); expect(out.fill.stops[0]).toHaveProperty('offset')
  })
  it('fill.phase scrolls the gradient stops', () => {
    const out = applyResolvedValue(layer(), 'fill.phase', 0.25) as any
    expect(out.fill.stops.length).toBeGreaterThan(2) // scrolled wheel resample
  })
  it('unknown prop returns the input unchanged', () => {
    const l = layer(); expect(applyResolvedValue(l, 'nope', 1)).toBe(l)
  })
})
```

- [ ] **Step 2: Run test to verify it fails** — `npm run test:unit -- adapter-frame` → FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
// app/lib/motionx/adapter/frame.ts
import type { PropertyValue } from '~/lib/motionx'
import type { GradientStop as ColorStop } from '~/lib/color/harmony'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { isGradient } from '~/lib/compositor/paint'
import { withScrolledStops, withGradientStops } from '~/lib/compositor/gradientPaint'
import { effectStackOf, writeStackToLayer } from '~/lib/compositor/effectStack'

const TRANSFORM = new Set(['x', 'y', 'rotation', 'scale', 'opacity'])

export function applyResolvedValue(layer: LocalLayer, prop: string, value: PropertyValue): LocalLayer {
  if (TRANSFORM.has(prop) && typeof value === 'number') {
    return { ...layer, [prop]: value } as LocalLayer
  }
  const fill = (layer as unknown as { fill?: unknown }).fill
  if (prop === 'fill.phase' && typeof value === 'number' && isGradient(fill)) {
    return { ...layer, fill: withScrolledStops(fill, value) } as LocalLayer
  }
  if (prop === 'fill' && Array.isArray(value) && isGradient(fill)) {
    return { ...layer, fill: withGradientStops(fill, value as ColorStop[]) } as LocalLayer
  }
  const eff = prop.match(/^effects\.([^.]+)\.(.+)$/)
  if (eff) {
    const [, effectId, dial] = eff as unknown as [string, string, string]
    const stack = effectStackOf(layer)
    let changed = false
    const next = stack.map((e) => (e.id === effectId ? (changed = true, { ...e, [dial]: value }) : e))
    if (!changed) return layer
    return { ...layer, ...writeStackToLayer(next) } as LocalLayer
  }
  return layer
}
```

- [ ] **Step 4: Run test to verify it passes** — `npm run test:unit -- adapter-frame` → PASS.

- [ ] **Step 5: Commit** (pathspec — new file)

```bash
git add -- app/lib/motionx/adapter/frame.ts tests/unit/motionx/adapter-frame.unit.spec.ts
git commit -m "feat(motionx): frame adapter — applyResolvedValue (transform/fill/effects)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" -- app/lib/motionx/adapter/frame.ts tests/unit/motionx/adapter-frame.unit.spec.ts
```

---

### Task 2: `applyMotionxTracks` — the fold

**Files:**
- Modify: `app/lib/motionx/adapter/frame.ts`
- Test: `tests/unit/motionx/adapter-frame.unit.spec.ts` (extend)

**Interfaces:**
- Consumes: `evaluateTracks`, `Track` from `~/lib/motionx`; `applyResolvedValue`.
- Produces: `applyMotionxTracks(layers: LocalLayer[], tracks: Track[] | undefined, t: number | undefined): LocalLayer[]` — parses each track's path `layers.<id>.<prop>`, evaluates ALL tracks at `t` via `evaluateTracks`, groups resolved values by layer id, and applies them onto cloned layers via `applyResolvedValue` (folding multiple props onto one clone). SAME array reference when `tracks` empty/absent or `t == null` or nothing resolves; non-targeted layers by identity.

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/unit/motionx/adapter-frame.unit.spec.ts
import { applyMotionxTracks } from '~/lib/motionx/adapter/frame'
import type { Track } from '~/lib/motionx'

describe('applyMotionxTracks', () => {
  const opacityTrack: Track = { path: 'layers.L1.opacity', type: 'number', keyframes: [
    { t: 0, value: 0, ease: 'linear' }, { t: 1, value: 1, ease: 'linear' } ] }
  it('same reference when idle', () => {
    const arr = [layer()]
    expect(applyMotionxTracks(arr, undefined, 0)).toBe(arr)
    expect(applyMotionxTracks(arr, [], 0)).toBe(arr)
  })
  it('applies a resolved value onto the targeted layer', () => {
    const out = applyMotionxTracks([layer()], [opacityTrack], 0.5)
    expect((out[0] as any).opacity).toBeCloseTo(0.5, 6)
  })
  it('leaves non-targeted layers by identity', () => {
    const other = layer({ id: 'L2' })
    const out = applyMotionxTracks([layer(), other], [opacityTrack], 0.5)
    expect(out[1]).toBe(other)
  })
})
```

- [ ] **Step 2: Run test to verify it fails** — `npm run test:unit -- adapter-frame` → FAIL.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to app/lib/motionx/adapter/frame.ts
import { evaluateTracks, type Track } from '~/lib/motionx'

export function applyMotionxTracks(layers: LocalLayer[], tracks: Track[] | undefined, t: number | undefined): LocalLayer[] {
  if (!tracks || tracks.length === 0 || t == null) return layers
  const resolved = evaluateTracks(tracks, t) // Map<fullpath, value>
  if (resolved.size === 0) return layers
  // Group resolved (path -> value) by layer id, keeping the property remainder.
  const byLayer = new Map<string, Array<[string, import('~/lib/motionx').PropertyValue]>>()
  for (const [path, value] of resolved) {
    const m = path.match(/^layers\.([^.]+)\.(.+)$/)
    if (!m) continue
    const [, layerId, prop] = m as unknown as [string, string, string]
    const list = byLayer.get(layerId)
    if (list) list.push([prop, value]); else byLayer.set(layerId, [[prop, value]])
  }
  if (byLayer.size === 0) return layers
  let cloned = false
  const next = layers.map((layer) => {
    const props = byLayer.get(layer.id)
    if (!props) return layer
    let l = layer
    for (const [prop, value] of props) l = applyResolvedValue(l, prop, value)
    if (l !== layer) cloned = true
    return l
  })
  return cloned ? next : layers
}
```

- [ ] **Step 4: Run test to verify it passes** — `npm run test:unit -- adapter-frame` → PASS.

- [ ] **Step 5: Commit** (pathspec)

```bash
git commit -m "feat(motionx): frame adapter — applyMotionxTracks fold (one fold, byte-identity)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" -- app/lib/motionx/adapter/frame.ts tests/unit/motionx/adapter-frame.unit.spec.ts
```

---

### Task 3: `frameTarget` + `animatableProperties`

**Files:**
- Modify: `app/lib/motionx/adapter/frame.ts`
- Test: `tests/unit/motionx/adapter-frame.unit.spec.ts` (extend)

**Interfaces:**
- Consumes: `BehaviourTarget` from `~/lib/motionx`; `isGradient` from `~/lib/compositor/paint`; `paintStopsToColor` from `~/lib/compositor/gradientPaint`; `effectStackOf`.
- Produces:
  - `frameTarget(layer: LocalLayer): BehaviourTarget` — `get(prop)`: `'opacity'|'x'|'y'|'rotation'|'scale'` → the layer field; `'fill'` → `paintStopsToColor(fill)` when gradient, else `undefined`; else `undefined`. `has(prop)`: true when `get` would return a value or the effect/property exists.
  - `animatableProperties(layer: LocalLayer): Array<{ path: string; type: 'number'|'color'|'gradient'; label: string }>` — transform+opacity (number), `layers.<id>.fill` (gradient) + `layers.<id>.fill.phase` (number) when the fill is a gradient, and one entry per effect dial from `effectStackOf` (kind mapped: number/color→number/color; the gradientMap `stops`→gradient). (This is the seed for Phase 3's picker/gallery; keep it a plain data list.)

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/unit/motionx/adapter-frame.unit.spec.ts
import { frameTarget, animatableProperties } from '~/lib/motionx/adapter/frame'

describe('frameTarget + animatableProperties', () => {
  it('target reads current values', () => {
    const tg = frameTarget(layer({ opacity: 0.7 }))
    expect(tg.get('opacity')).toBe(0.7)
    expect(Array.isArray(tg.get('fill'))).toBe(true) // gradient -> {pos,color}[]
    expect(tg.get('nope')).toBeUndefined()
  })
  it('enumerates transform + fill properties for a gradient-filled layer', () => {
    const paths = animatableProperties(layer()).map(p => p.path)
    expect(paths).toContain('layers.L1.opacity')
    expect(paths).toContain('layers.L1.fill')
    expect(paths).toContain('layers.L1.fill.phase')
  })
})
```

- [ ] **Step 2: Run test to verify it fails** — `npm run test:unit -- adapter-frame` → FAIL.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to app/lib/motionx/adapter/frame.ts
import type { BehaviourTarget } from '~/lib/motionx'
import { paintStopsToColor } from '~/lib/compositor/gradientPaint'

export function frameTarget(layer: LocalLayer): BehaviourTarget {
  const rec = layer as unknown as Record<string, unknown>
  const fill = rec.fill
  return {
    get(prop) {
      if (TRANSFORM.has(prop) && typeof rec[prop] === 'number') return rec[prop] as number
      if (prop === 'fill' && isGradient(fill)) return paintStopsToColor(fill)
      return undefined
    },
    has(prop) { return this.get(prop) !== undefined },
  }
}

export function animatableProperties(layer: LocalLayer): Array<{ path: string; type: 'number' | 'color' | 'gradient'; label: string }> {
  const id = layer.id
  const out: Array<{ path: string; type: 'number' | 'color' | 'gradient'; label: string }> = [
    { path: `layers.${id}.x`, type: 'number', label: 'Position X' },
    { path: `layers.${id}.y`, type: 'number', label: 'Position Y' },
    { path: `layers.${id}.scale`, type: 'number', label: 'Scale' },
    { path: `layers.${id}.rotation`, type: 'number', label: 'Rotation' },
    { path: `layers.${id}.opacity`, type: 'number', label: 'Opacity' },
  ]
  const fill = (layer as unknown as { fill?: unknown }).fill
  if (isGradient(fill)) {
    out.push({ path: `layers.${id}.fill`, type: 'gradient', label: 'Fill · Gradient' })
    out.push({ path: `layers.${id}.fill.phase`, type: 'number', label: 'Fill · Scroll' })
  }
  for (const e of effectStackOf(layer)) {
    // Minimal: expose the gradientMap ramp; scalar dials come with the full registry in Phase 3.
    if ((e as { type?: string }).type === 'gradientMap') {
      out.push({ path: `layers.${id}.effects.${e.id}.stops`, type: 'gradient', label: 'Gradient map · Ramp' })
    }
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes** — `npm run test:unit -- adapter-frame` → PASS.

- [ ] **Step 5: Commit** (pathspec)

```bash
git commit -m "feat(motionx): frame adapter — frameTarget + animatableProperties (Phase 3 seed)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" -- app/lib/motionx/adapter/frame.ts tests/unit/motionx/adapter-frame.unit.spec.ts
```

---

### Task 4: Wire the fold into the render (gated; flag-off = byte-identical)

**Files:**
- Modify: `app/composables/useCompositorLayers.ts` (import; the `motion` param type ~5443; the fold chain ~5470)

**Interfaces:**
- Consumes: `applyMotionxTracks` from `~/lib/motionx/adapter/frame`; `Track` from `~/lib/motionx`.
- Produces: no new export — `paintLayerStack` now also folds `motion.motionx` tracks. Gated on presence: with `motion.motionx` absent/empty, `applyMotionxTracks` returns the same reference → byte-identical.

- [ ] **Step 1: Add the import** (near line 27, beside the effectTracks import)

```ts
import { applyMotionxTracks } from '~/lib/motionx/adapter/frame'
import type { Track as MotionxTrack } from '~/lib/motionx'
```

- [ ] **Step 2: Extend the `motion` param type** (line ~5443) — add `motionx?`:

```ts
  motion?: { fps: number; duration: number; tracks?: EffectDialTrack[]; motionx?: MotionxTrack[] },
```

- [ ] **Step 3: Add the fold to the chain** (the `applyFillPhaseTracks(applyEffectDialTracks(...))` at ~5470). Wrap it:

```ts
  const animatedLocals = applyMotionxTracks(
    applyFillPhaseTracks(
      applyEffectDialTracks(localLayers, motion?.tracks, t),
      motion?.tracks,
      t,
    ),
    motion?.motionx,
    t,
  )
```

(All three folds share nothing; each ignores inputs it doesn't own; `applyMotionxTracks` returns its input by reference when `motion.motionx` is absent → the whole expression is byte-identical for every existing call site, none of which pass `motionx`.)

- [ ] **Step 4: Verify**

Run: `npm run test:unit` (no regressions; motionx + adapter green).
Then confirm the app still compiles: load `http://127.0.0.1:3002/` in the browser (reuse the running dev server; do NOT `npm run dev`) and check the console for errors — an un-authored Frame renders exactly as before.

- [ ] **Step 5: Commit** (PRIVATE INDEX — `useCompositorLayers.ts` is shared)

```bash
GIT_INDEX_FILE="$(mktemp -t mxidx)"; export GIT_INDEX_FILE
git read-tree HEAD
git add -- app/composables/useCompositorLayers.ts
git commit -m "feat(compositor): fold motionx tracks in the render (gated on presence; off = byte-identical)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
rm -f "$GIT_INDEX_FILE"; unset GIT_INDEX_FILE
```

---

## Self-Review

**Spec coverage (Phase 2):**
- Frame adapter = the ONE coupled file; core stays pure — Tasks 1–3, Global Constraints. ✓
- Apply resolved values (transform/opacity/effects/fill/scroll) — Task 1. ✓
- One fold, byte-identity — Task 2. ✓
- Property registry + BehaviourTarget (Phase 3 seed) — Task 3. ✓
- Wire into render behind a presence-gate (off = byte-identical) — Task 4. ✓
- **Deferred to Phase 3:** the full effect-dial registry (only gradientMap ramp exposed here), the kinetic-preset behaviour port, the previewing gallery, the unified timeline UI + value editor, and storing `motion.motionx` from an author path. **Deferred to Phase 4:** deleting the old folds.

**Placeholder scan:** none — pure tasks carry full code; Task 4 gives exact edits + before/after.

**Type consistency:** `Track`/`PropertyValue`/`BehaviourTarget` come from `~/lib/motionx`; `applyResolvedValue`/`applyMotionxTracks`/`frameTarget`/`animatableProperties` signatures are consistent across tasks; the `layers.<id>.<prop>` path convention is used identically in Task 2 (parse) and Task 3 (emit).

## Notes / risks
- Effect-dial application re-materialises the stack per effect property; acceptable (matches the existing fold's cost), batched per layer clone.
- `motion.motionx` has no writer yet — Phase 3 adds the author path. Until then the render fold is inert (byte-identity), which is the intended "flag off" state.
