# Unified Motion 6b — Retire Legacy Motion Authoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the band timeline the only Motion authoring surface in the Frame compositor: when a frame opens, convert old effect-dial tracks AND old In/Loop/Out layer animations into timeline bands, show the few animations that cannot be converted as a locked bar with a Remove action, and delete the hidden legacy authoring UI.

**Architecture:** (B) `sailor_motion.tracks` (effect-dial keyframes) maps 1:1 onto `sailor_motion.motionx` bands — same paths, same interpolation — once motionx colour tracks can use the legacy colour-mix spaces. (A) `layer.animation` (In/Loop/Out presets + keyframes) is converted by **sampling the old evaluator** on the frame grid and simplifying each property (x, y, rotation, scale, opacity) into one band — general, and verified by a parity test against the old engine. User decision 2026-09-19: "just convert" — accepted losses are per-letter staggering on text layers (the layer animates as a whole) and the blur of the blur presets. Animations that use masks, axis flips or tiled copies, or that sit on a layer which already has transform bands, are NOT converted: they keep playing through the old engine and show as a locked bar with Remove. The old engine (`lib/motion/evaluate.ts`, `paint.ts`) stays regardless — the video Timeline and Vector Type use it. Prerequisite found while planning: the motionx `scale` property only works on path/image layers today, so Task 0 makes it work on every layer kind.

**Tech Stack:** Nuxt 4 / Vue 3 `<script setup>` / TypeScript / Tailwind; Vitest (`tests/unit/**/*.unit.spec.ts`); pure motion core in `frontend/app/lib/motionx/`.

## Global Constraints

- Work in the main checkout `/Users/julien/Documents/GitHub/Sailor`. No worktree, no branch, never `git stash`, never `git add -A`.
- **Never run `npm run dev`.** A dev server for this checkout is already running (check `lsof -nP -iTCP -sTCP:LISTEN | grep node`; on 2026-09-18 it was `127.0.0.1:3000`). Use `127.0.0.1`, not `localhost`.
- **Every commit uses a private git index** (the shared index is hostile here):
  ```bash
  GIT_INDEX_FILE=$(mktemp); export GIT_INDEX_FILE; git read-tree HEAD
  git add -- <exact paths>; git commit -q -m "<msg>" -- <exact paths>
  rm -f "$GIT_INDEX_FILE"; unset GIT_INDEX_FILE
  ```
  For deletions use `git rm -q --cached -- <path>` inside the private index after deleting the file on disk.
- End every commit message with: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
- Run unit tests from `frontend/`: `npm run test:unit -- <filter>`. Typecheck: `npx vue-tsc --noEmit 2>&1 | grep -E "<your files>"`. `CompositorModal.vue` has 6 and `useLocalLayerEditor.ts` ~18 **pre-existing** errors on lines you did not touch — they are the baseline, not yours.
- UI copy is sentence case, plain words, no internal identifiers.
- Colours/font stay Sailor's: surfaces `#1a1a1a` / `#0e0e10`, `border-white/10`, accent `#7c9cff`, behaviour bars emerald, warnings amber.
- Byte-identity: a frame with no legacy data must render and serialize exactly as before every task.
- Do **not** delete `frontend/app/lib/motion/evaluate.ts`, `paint.ts`, `animatedText.ts`, `types.ts`, `bake.ts`, or `app/data/kinetic-presets.ts` — the video Timeline (`lib/engine/motionClipRenderer.ts`), Vector Type (`lib/vectortype/presetMotion.ts`) and `PresetThumb.vue` use them.

---

### Task 0: `scale` bands work on every layer kind

Today `applyResolvedValue` writes `scale` onto the layer clone, but only `path` and `image` layers have a `scale` field the painter reads. On rect / ellipse / text / polygon / star / … the Grow in, Pulse and Shrink out behaviours and the "Scale" property do nothing. The old engine scales at draw time about the layer centre (`lib/motion/paint.ts`, `needScale` block) — do the same.

**Files:**
- Modify: `frontend/app/lib/motionx/adapter/frame.ts`
- Modify: `frontend/app/composables/useCompositorLayers.ts` (inside `paintLayerStack`'s per-item loop — SHARED file, smallest possible diff)
- Test: `frontend/tests/unit/motionx/adapter-frame.unit.spec.ts`

**Interfaces:**
- Produces: a transient, never-persisted clone field `motionScale?: number` on layers WITHOUT a native numeric `scale`; layers WITH one keep receiving `scale`. `frameTarget(layer).get('scale')` returns the native scale or `1`.

- [ ] **Step 1: Failing test** — append to `adapter-frame.unit.spec.ts`:

```ts
describe('scale on every layer kind', () => {
  it('a layer with a native scale field still gets `scale`', () => {
    const l = layer({ kind: 'path', scale: 2 })
    expect((applyResolvedValue(l, 'scale', 3) as any).scale).toBe(3)
    expect((applyResolvedValue(l, 'scale', 3) as any).motionScale).toBeUndefined()
  })
  it('a layer without one gets the transient motionScale and keeps no `scale` key', () => {
    const { scale: _drop, ...rect } = layer({ kind: 'rect', w: 0.3, h: 0.2 }) as any
    const out = applyResolvedValue(rect, 'scale', 1.5) as any
    expect(out.motionScale).toBe(1.5)
    expect('scale' in out).toBe(false)
  })
  it('behaviours read a base scale of 1 on such layers', () => {
    const { scale: _drop, ...rect } = layer({ kind: 'rect', w: 0.3, h: 0.2 }) as any
    expect(frameTarget(rect).get('scale')).toBe(1)
  })
})
```

(Add `applyResolvedValue, frameTarget` to the spec's import from `~/lib/motionx/adapter/frame` if missing. Note the spec's `layer()` helper sets `scale: 1` by default, hence the destructuring.)

- [ ] **Step 2: Run, expect failure** — `cd frontend && npm run test:unit -- motionx/adapter-frame`.

- [ ] **Step 3: Adapter.** In `applyResolvedValue`, replace the TRANSFORM branch with:

```ts
  if (TRANSFORM.has(prop) && typeof value === 'number') {
    // Only path/image layers have a native `scale` the painter reads. Everything else gets a
    // transient `motionScale` that paintLayerStack applies as a draw-time scale about the
    // layer centre (what the old motion engine did). Clones only — never persisted.
    if (prop === 'scale' && typeof (layer as unknown as { scale?: unknown }).scale !== 'number') {
      return { ...layer, motionScale: value } as unknown as LocalLayer
    }
    return { ...layer, [prop]: value } as LocalLayer
  }
```

In `frameTarget().get`, make `scale` fall back to 1: before the generic TRANSFORM line add `if (prop === 'scale' && typeof rec.scale !== 'number') return 1`.

- [ ] **Step 4: Painter.** In `useCompositorLayers.ts`, find the per-item draw loop inside `paintLayerStack` (the `for` whose body contains `const motionActive = t !== undefined && motion && _motionPainterImpl`). The body has several `continue`s, so do NOT wrap it in try/finally (huge diff in a shared file). Instead add three small insertions:

  1. Immediately before that `for`: `let motionScaleOpen = false`
  2. As the FIRST statements of the loop body:
     ```ts
     if (motionScaleOpen) { ctx.restore(); motionScaleOpen = false }
     ```
  3. At the point where the local `layer` for this item is known and BEFORE any drawing for it (just above `const ref = layerMaskRef(layer)`):
     ```ts
     // motionx `scale` on a layer kind with no native scale: draw-time scale about the centre.
     const ms = (layer as unknown as { motionScale?: number }).motionScale
     if (typeof ms === 'number' && Math.abs(ms - 1) > 1e-4) {
       ctx.save()
       ctx.translate(layer.x * W, layer.y * H)
       ctx.scale(Math.max(0.001, ms), Math.max(0.001, ms))
       ctx.translate(-layer.x * W, -layer.y * H)
       motionScaleOpen = true
     }
     ```
  4. Immediately after the loop's closing brace: `if (motionScaleOpen) ctx.restore()`

  If `layer` is only defined inside a `it.type === 'local'` branch, put insertion 3 inside that branch. Byte-identity: with no `motionScale`, none of this runs.

- [ ] **Step 5: Verify.** `npm run test:unit -- motionx compositor` → pass. `npx vue-tsc --noEmit 2>&1 | grep -E "adapter/frame|useCompositorLayers"` → only pre-existing lines (compare with `git stash`-free method: run the same grep on HEAD's count before editing and confirm the count is unchanged). Live (browser pane must be VISIBLE — a hidden pane pauses rendering): open a Frame, add a rectangle, Motion → Add behaviour → Pulse → press Space: the rectangle visibly grows and shrinks about its centre; selection handles and other layers are unaffected.

- [ ] **Step 6: Commit** (private index) — `fix(motionx): scale bands work on every layer kind (draw-time scale about the centre)`.

---

### Task 1: Colour bands can use the legacy colour-mix spaces

Legacy colour dial tracks mix with `mixHex(a, b, p, 'oklch' | 'rgb')` (default `oklch`). motionx colour tracks mix with `blendHex(a, b, p, 'oklab' | 'hybrid')`. Without this task a converted colour track would show different in-between colours.

**Files:**
- Modify: `frontend/app/lib/motionx/types.ts` (the `Track.space` field)
- Modify: `frontend/app/lib/motionx/interpolate.ts`
- Test: `frontend/tests/unit/motionx/interpolate.unit.spec.ts`

**Interfaces:**
- Produces: `Track.space?: 'oklab' | 'hybrid' | 'oklch' | 'srgb'`; `InterpOpts.space` has the same union. `'oklch'` / `'srgb'` are honoured for `type: 'color'` only; gradient tracks treat them as `'oklab'`.

- [ ] **Step 1: Write the failing test** — append to `frontend/tests/unit/motionx/interpolate.unit.spec.ts`:

```ts
import { mixHex } from '~/lib/color/mix'
import { blendHex } from '~/lib/color/gradientTween'

describe('colour tracks: legacy mix spaces', () => {
  const a = '#ff0000', b = '#0000ff'
  it('default is unchanged (oklab via blendHex)', () => {
    expect(interpolateValue('color', a, b, 0.5)).toBe(blendHex(a, b, 0.5, 'oklab'))
  })
  it("space 'oklch' and 'srgb' route to mixHex, and really differ from the default", () => {
    expect(interpolateValue('color', a, b, 0.5, { space: 'oklch' })).toBe(mixHex(a, b, 0.5, 'oklch'))
    expect(interpolateValue('color', a, b, 0.5, { space: 'srgb' })).toBe(mixHex(a, b, 0.5, 'rgb'))
    expect(interpolateValue('color', a, b, 0.5, { space: 'srgb' })).toBe('#800080')
    expect(interpolateValue('color', a, b, 0.5, { space: 'oklch' })).not.toBe(interpolateValue('color', a, b, 0.5))
  })
  it('gradient tracks ignore the colour-only spaces (treated as oklab)', () => {
    const g1 = [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }]
    const g2 = [{ pos: 0, color: '#ff0000' }, { pos: 1, color: '#0000ff' }]
    expect(interpolateValue('gradient', g1, g2, 0.5, { space: 'oklch' })).toEqual(interpolateValue('gradient', g1, g2, 0.5, { space: 'oklab' }))
  })
})
```

If the file does not already import `interpolateValue`, `describe`, `it`, `expect`, add: `import { describe, it, expect } from 'vitest'` and `import { interpolateValue } from '~/lib/motionx/interpolate'`.

- [ ] **Step 2: Run it, expect failure**

Run: `cd frontend && npm run test:unit -- motionx/interpolate`
Expected: FAIL — the `'oklch'`/`'srgb'` expectations (TypeScript may also flag the `space` literal; vitest still runs). If `'#800080'` is the only failure, print `mixHex('#ff0000','#0000ff',0.5,'rgb')` and use its actual value — the point of that line is a hard-coded anchor, not a second call to the same function.

- [ ] **Step 3: Implement**

`frontend/app/lib/motionx/types.ts` — replace the `space` line of `Track`:

```ts
  /** Colour-blend space. Gradient + colour tracks: 'oklab' (default) | 'hybrid'. Colour tracks
   *  may also use 'oklch' | 'srgb' — the mix spaces of the legacy effect-dial tracks, so a
   *  converted colour track shows the same in-between colours. */
  space?: 'oklab' | 'hybrid' | 'oklch' | 'srgb'
```

`frontend/app/lib/motionx/interpolate.ts` — full replacement:

```ts
import { blendHex, crossfadeStops, travelStops } from '~/lib/color/gradientTween'
import { mixHex } from '~/lib/color/mix'
import type { GradientStop } from '~/lib/color/harmony'
import type { PropertyType, PropertyValue } from './types'

export interface InterpOpts { mode?: 'crossfade' | 'travel'; space?: 'oklab' | 'hybrid' | 'oklch' | 'srgb' }

export function interpolateValue(
  type: PropertyType, a: PropertyValue, b: PropertyValue, p: number, opts: InterpOpts = {},
): PropertyValue {
  if (type === 'number') return (a as number) + ((b as number) - (a as number)) * p
  if (type === 'color') {
    // 'oklch' | 'srgb' are the legacy effect-dial mix spaces (mixHex names sRGB 'rgb').
    if (opts.space === 'oklch' || opts.space === 'srgb') return mixHex(a as string, b as string, p, opts.space === 'srgb' ? 'rgb' : 'oklch')
    return blendHex(a as string, b as string, p, opts.space ?? 'oklab')
  }
  const space = opts.space === 'hybrid' ? 'hybrid' : 'oklab'
  const from = a as GradientStop[], to = b as GradientStop[]
  return (opts.mode ?? 'crossfade') === 'travel'
    ? travelStops(from, to, p, space)
    : crossfadeStops(from, to, p, space)
}
```

- [ ] **Step 4: Run the whole motionx suite + typecheck**

Run: `npm run test:unit -- motionx` → all pass (142+ with the 3 new).
Run: `npx vue-tsc --noEmit 2>&1 | grep -E "motionx/|MotionInspector|MotionBandTimeline|bands.ts"` → no output. If a consumer narrowed `Track.space` to `'oklab' | 'hybrid'` (e.g. a gradient CSS helper in `bands.ts`), pass `tr.space === 'hybrid' ? 'hybrid' : 'oklab'` at that call site.

- [ ] **Step 5: Commit** — `feat(motionx): colour tracks can mix in the legacy oklch / srgb spaces` — paths: `frontend/app/lib/motionx/types.ts`, `frontend/app/lib/motionx/interpolate.ts`, `frontend/tests/unit/motionx/interpolate.unit.spec.ts` (+ any one-line consumer fix).

---

### Task 2: Pure converter — effect-dial tracks → motionx bands

**Files:**
- Create: `frontend/app/lib/motionx/adapter/migrateDialTracks.ts`
- Test: `frontend/tests/unit/motionx/migrate-dial-tracks.unit.spec.ts`

**Interfaces:**
- Consumes: `EffectDialTrack`, `DialKeyframe`, `isGradientValue`, `evaluateDialTrack`, `applyEffectDialTracks` from `~/lib/motion/effectTracks`; `Track` from `~/lib/motionx`; `evaluateTrack` from `~/lib/motionx`; `applyMotionxTracks` from `~/lib/motionx/adapter/frame`; Task 1's `Track.space` union.
- Produces:
  - `dialTrackToMotionx(tr: EffectDialTrack): Track | null` — `null` when the track cannot be expressed (empty, mixed value types, non-hex colour strings).
  - `migrateDialTracks<M extends MotionLike>(motion: M): { motion: M; converted: number; dropped: number }` where `type MotionLike = { tracks?: EffectDialTrack[]; motionx?: Track[] }`. Returns the **same `motion` reference** when there is nothing to do.

Rules (each has a test below):
1. Path is copied verbatim (`layers.<id>.effects.<fx>.<dial>`, `layers.<id>.fill.phase`, `layers.<id>.fill` are already motionx paths).
2. Type: all finite numbers → `'number'`; all `#rgb/#rrggbb/#rrggbbaa` → `'color'`; all stop arrays → `'gradient'`; anything else → not convertible, stays in `tracks`.
3. Keyframe `{t, v, ease}` → `{t, value: v, ease: ease ?? 'easeInOut'}` (the legacy default; legacy `easeInOut` is `easeInOutQuad`, identical to motionx `'easeInOut'`). Keyframes are sorted by `t`.
4. Gradient: `mode` copies; `blendSpace` → `space`. Colour: `space ?? 'oklch'` → `space` (`'oklch' | 'srgb'`). Number: no `space`.
5. If **any** existing motionx track already targets the path, the legacy track is **dropped**, not converted — the render fold applied motionx *after* dial tracks, so the legacy track was already fully overridden and invisible.
6. Leftover (unconvertible) tracks stay in `tracks`; when none are left the `tracks` key is removed.

- [ ] **Step 1: Write the failing tests** — create `frontend/tests/unit/motionx/migrate-dial-tracks.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { dialTrackToMotionx, migrateDialTracks } from '~/lib/motionx/adapter/migrateDialTracks'
import { evaluateDialTrack, applyEffectDialTracks, type EffectDialTrack } from '~/lib/motion/effectTracks'
import { evaluateTrack } from '~/lib/motionx'
import { applyMotionxTracks } from '~/lib/motionx/adapter/frame'
import type { LocalLayer } from '~/composables/useCompositorLayers'

const P = 'layers.L1.effects.fx1.intensity'
const num: EffectDialTrack = { target: P, keyframes: [{ t: 3, v: 10, ease: 'linear' }, { t: 1, v: 0, ease: 'linear' }] }
const g1 = [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }]
const g2 = [{ pos: 0, color: '#ff0000' }, { pos: 1, color: '#0000ff' }]
const SAMPLES = [-0.5, 0, 1, 1.25, 1.5, 2, 2.75, 3, 9]

describe('dialTrackToMotionx', () => {
  it('number track: path verbatim, sorted keyframes, value + ease carried', () => {
    expect(dialTrackToMotionx(num)).toEqual({
      path: P, type: 'number',
      keyframes: [{ t: 1, value: 0, ease: 'linear' }, { t: 3, value: 10, ease: 'linear' }],
    })
  })
  it('a missing ease becomes easeInOut (the legacy default)', () => {
    const tr = dialTrackToMotionx({ target: P, keyframes: [{ t: 0, v: 0 }, { t: 4, v: 8 }] })!
    expect(tr.keyframes.map((k) => k.ease)).toEqual(['easeInOut', 'easeInOut'])
    expect(evaluateTrack(tr, 1)).toBeCloseTo(1, 9)   // easeInOutQuad(0.25) = 0.125 → 8 · 0.125
  })
  it('colour track keeps its mix space (default oklch)', () => {
    const c = { target: 'layers.L1.effects.fx1.tint', keyframes: [{ t: 0, v: '#ff0000' }, { t: 2, v: '#0000ff' }] }
    expect(dialTrackToMotionx(c)!.type).toBe('color')
    expect(dialTrackToMotionx(c)!.space).toBe('oklch')
    expect(dialTrackToMotionx({ ...c, space: 'srgb' })!.space).toBe('srgb')
  })
  it('gradient track: mode copies, blendSpace becomes space', () => {
    const tr = dialTrackToMotionx({ target: 'layers.L1.fill', keyframes: [{ t: 0, v: g1 }, { t: 2, v: g2 }], mode: 'travel', blendSpace: 'hybrid' })!
    expect(tr).toMatchObject({ type: 'gradient', mode: 'travel', space: 'hybrid' })
  })
  it('refuses what it cannot express', () => {
    expect(dialTrackToMotionx({ target: P, keyframes: [] })).toBeNull()
    expect(dialTrackToMotionx({ target: P, keyframes: [{ t: 0, v: 1 }, { t: 1, v: '#ffffff' }] })).toBeNull()
    expect(dialTrackToMotionx({ target: P, keyframes: [{ t: 0, v: 'rgba(0,0,0,1)' }, { t: 1, v: '#ffffff' }] })).toBeNull()
  })
})

describe('converted tracks evaluate IDENTICALLY to the legacy evaluator', () => {
  const cases: Record<string, EffectDialTrack> = {
    'number linear': num,
    'number default ease': { target: P, keyframes: [{ t: 1, v: 2 }, { t: 2, v: -4 }, { t: 3, v: 7, ease: 'linear' }] },
    'single keyframe': { target: P, keyframes: [{ t: 2, v: 0.4 }] },
    'colour oklch': { target: P, keyframes: [{ t: 1, v: '#ff0000' }, { t: 3, v: '#00ff88' }] },
    'colour srgb': { target: P, keyframes: [{ t: 1, v: '#ff0000' }, { t: 3, v: '#00ff88' }], space: 'srgb' },
    'gradient crossfade': { target: 'layers.L1.fill', keyframes: [{ t: 1, v: g1 }, { t: 3, v: g2 }] },
    'gradient travel hybrid': { target: 'layers.L1.fill', keyframes: [{ t: 1, v: g1 }, { t: 3, v: g2 }], mode: 'travel', blendSpace: 'hybrid' },
  }
  for (const [name, legacy] of Object.entries(cases)) {
    it(name, () => {
      const conv = dialTrackToMotionx(legacy)!
      for (const t of SAMPLES) expect(evaluateTrack(conv, t), `${name} @ ${t}`).toEqual(evaluateDialTrack(legacy, t))
    })
  }
  it('anchor (not just parity): 0→10 linear over 1..3 is 5 at t=2', () => {
    expect(evaluateTrack(dialTrackToMotionx(num)!, 2)).toBe(5)
  })
  it('the render fold gives the same layer either way', () => {
    const l = { id: 'L1', x: 0.5, y: 0.5, rotation: 0, scale: 1, opacity: 1, effects: [{ id: 'fx1', type: 'bloom', threshold: 0.5, radius: 0.1, intensity: 1 }] } as unknown as LocalLayer
    for (const t of SAMPLES) {
      expect(applyMotionxTracks([l], [dialTrackToMotionx(num)!], t)).toEqual(applyEffectDialTracks([l], [num], t))
    }
  })
})

describe('migrateDialTracks', () => {
  it('no legacy tracks → the very same object (byte-identity)', () => {
    const m = { fps: 30, duration: 4, motionx: [] }
    expect(migrateDialTracks(m).motion).toBe(m)
    const m2 = { fps: 30, duration: 4, tracks: [] as EffectDialTrack[] }
    expect(migrateDialTracks(m2).motion).toBe(m2)
  })
  it('moves convertible tracks into motionx and removes the tracks key', () => {
    const out = migrateDialTracks({ fps: 30, duration: 4, tracks: [num] })
    expect(out.converted).toBe(1)
    expect('tracks' in out.motion).toBe(false)
    expect(out.motion.motionx).toEqual([dialTrackToMotionx(num)])
  })
  it('appends after existing bands and never touches them', () => {
    const band = { path: 'layers.L1.opacity', type: 'number' as const, keyframes: [{ t: 0, value: 1, ease: 'linear' as const }] }
    expect(migrateDialTracks({ motionx: [band], tracks: [num] }).motion.motionx).toEqual([band, dialTrackToMotionx(num)])
  })
  it('drops a legacy track whose path a band already drives (it was already overridden)', () => {
    const band = { path: P, type: 'number' as const, keyframes: [{ t: 0, value: 3, ease: 'linear' as const }] }
    const out = migrateDialTracks({ motionx: [band], tracks: [num] })
    expect(out).toMatchObject({ converted: 0, dropped: 1 })
    expect(out.motion.motionx).toEqual([band])
    expect('tracks' in out.motion).toBe(false)
  })
  it('leaves unconvertible tracks where they are', () => {
    const odd: EffectDialTrack = { target: 'layers.L1.effects.fx1.mode', keyframes: [{ t: 0, v: 'soft' }, { t: 1, v: 'hard' }] }
    const out = migrateDialTracks({ tracks: [num, odd] })
    expect(out.motion.tracks).toEqual([odd])
    expect(out.converted).toBe(1)
  })
  it('is idempotent', () => {
    const once = migrateDialTracks({ tracks: [num] }).motion
    expect(migrateDialTracks(once).motion).toBe(once)
  })
})
```

- [ ] **Step 2: Run, expect failure** — `npm run test:unit -- motionx/migrate-dial` → FAIL "Cannot find module … migrateDialTracks".

- [ ] **Step 3: Implement** — create `frontend/app/lib/motionx/adapter/migrateDialTracks.ts`:

```ts
// One-way conversion of the legacy effect-dial tracks (`sailor_motion.tracks`, F8) into motionx
// bands. Paths are already motionx paths and the interpolation is identical (see the parity
// spec), so a converted frame renders the same. Pure; lives in adapter/ because it knows the
// Frame's legacy shape — the motionx core stays compositor-free.
import { isGradientValue, type DialKeyframe, type EffectDialTrack } from '~/lib/motion/effectTracks'
import type { Keyframe, PropertyType, Track } from '../types'

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i

function typeOf(kfs: DialKeyframe[]): PropertyType | null {
  if (!kfs.length) return null
  if (kfs.every((k) => typeof k.v === 'number' && Number.isFinite(k.v))) return 'number'
  if (kfs.every((k) => typeof k.v === 'string' && HEX_RE.test(k.v))) return 'color'
  if (kfs.every((k) => isGradientValue(k.v))) return 'gradient'
  return null   // mixed types / non-hex strings STEP in the legacy evaluator — not expressible
}

export function dialTrackToMotionx(tr: EffectDialTrack): Track | null {
  const type = typeOf(tr?.keyframes ?? [])
  if (!type || typeof tr.target !== 'string' || !tr.target) return null
  const keyframes: Keyframe[] = [...tr.keyframes]
    .sort((a, b) => a.t - b.t)
    .map((k) => ({ t: k.t, value: k.v as Keyframe['value'], ease: k.ease ?? 'easeInOut' }))
  const out: Track = { path: tr.target, type, keyframes }
  if (type === 'gradient') {
    if (tr.mode) out.mode = tr.mode
    if (tr.blendSpace) out.space = tr.blendSpace
  } else if (type === 'color') {
    out.space = tr.space ?? 'oklch'
  }
  return out
}

export interface MotionLike { tracks?: EffectDialTrack[]; motionx?: Track[] }

export function migrateDialTracks<M extends MotionLike>(motion: M): { motion: M; converted: number; dropped: number } {
  const legacy = motion?.tracks
  if (!legacy || !legacy.length) return { motion, converted: 0, dropped: 0 }
  const existing = motion.motionx ?? []
  const taken = new Set(existing.map((t) => t.path))
  const added: Track[] = [], left: EffectDialTrack[] = []
  let dropped = 0
  for (const tr of legacy) {
    // motionx folded AFTER dial tracks, so a band on the same path already hid this track.
    if (tr && taken.has(tr.target)) { dropped++; continue }
    const conv = tr ? dialTrackToMotionx(tr) : null
    if (conv) { added.push(conv); taken.add(conv.path) } else left.push(tr)
  }
  if (!added.length && !dropped) return { motion, converted: 0, dropped: 0 }
  const next = { ...motion, motionx: [...existing, ...added] } as M
  if (left.length) next.tracks = left
  else delete next.tracks
  return { motion: next, converted: added.length, dropped }
}
```

- [ ] **Step 4: Run** — `npm run test:unit -- motionx/migrate-dial` → all pass. If a *parity* case fails, the converter or Task 1 is wrong — do **not** loosen the test to `toBeCloseTo`. Then `npm run test:unit -- motionx effect-tracks` → all pass.

- [ ] **Step 5: Commit** — `feat(motionx): pure converter from legacy effect-dial tracks to bands (parity-tested)`.

---

### Task 3: Convert on open, and let the agent author bands

**Files:**
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` (script only)
- Modify: `frontend/app/lib/agent/surfaces/compositor.ts` (the `animateDial` case, the state-doc comment near line 82, the diff label near line 1542)
- Test: `frontend/tests/unit/agent-compositor-animate-dial.unit.spec.ts` (create), update `frontend/tests/unit/effect-tracks-agent-reject.unit.spec.ts` only if it asserts `motion.tracks`
- E2E (edit expectations only): `frontend/tests/agent-compositor-vocab.spec.ts` lines ~119-150

**Interfaces:**
- Consumes: `migrateDialTracks` (Task 2); `setBandTrack(tracks: Track[], path: string, next: Track | null): Track[]` from `~/lib/motionx/bandEdit`.
- Produces: the agent's `animateDial` op writes `state.motion.motionx` (an untagged two-keyframe band) and no longer touches `state.motion.tracks`.

- [ ] **Step 1: Failing agent test** — create `frontend/tests/unit/agent-compositor-animate-dial.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { applyCompositorCommand, type CompositorState } from '~/lib/agent/surfaces/compositor'

const state = (): CompositorState => ({
  layers: [{
    id: 'L1', kind: 'rect', x: 0.5, y: 0.5, rotation: 0, opacity: 1, w: 0.4, h: 0.3,
    fill: '#fff', stroke: '', strokeWidth: 0, radius: 0,
    effects: [
      { id: 'e-grain', type: 'grain', amount: 0.5, size: 3, visible: true },
      { id: 'e-duo', type: 'duotone', shadows: '#000000', highlights: '#ffffff', mix: 1, visible: true },
    ],
  } as any] as LocalLayer[],
})
const GRAIN = 'layers.L1.effects.e-grain.amount'

describe('animateDial authors timeline bands (motionx), not legacy dial tracks', () => {
  it('writes one two-point band and leaves motion.tracks alone', () => {
    const r = applyCompositorCommand(state(), { op: 'animateDial', target: 'L1', args: { effect: 'grain', dial: 'amount', from: 0, to: 0.9, start: 1, end: 3 } })
    expect(r.ok).toBe(true); if (!r.ok) return
    expect(r.template.motion?.tracks ?? []).toEqual([])
    expect(r.template.motion?.motionx).toEqual([
      { path: GRAIN, type: 'number', keyframes: [{ t: 1, value: 0, ease: 'easeInOut' }, { t: 3, value: 0.9, ease: 'linear' }] },
    ])
  })
  it('re-animating the same dial replaces its band', () => {
    const s = state()
    applyCompositorCommand(s, { op: 'animateDial', target: 'L1', args: { effect: 'grain', dial: 'amount', from: 0, to: 0.9 } })
    const r = applyCompositorCommand(s, { op: 'animateDial', target: 'L1', args: { effect: 'grain', dial: 'amount', from: 0.2, to: 0.4 } })
    expect(r.ok).toBe(true); if (!r.ok) return
    const bands = (r.template.motion?.motionx ?? []).filter((t) => t.path === GRAIN)
    expect(bands).toHaveLength(1)
    expect(bands[0]!.keyframes.map((k) => k.value)).toEqual([0.2, 0.4])
  })
  it('a colour dial band mixes in oklch, like the old tracks did', () => {
    const r = applyCompositorCommand(state(), { op: 'animateDial', target: 'L1', args: { effect: 'duotone', dial: 'shadows', from: '#ff0000', to: '#0000ff' } })
    expect(r.ok).toBe(true); if (!r.ok) return
    expect(r.template.motion?.motionx?.[0]).toMatchObject({ path: 'layers.L1.effects.e-duo.shadows', type: 'color', space: 'oklch' })
  })
})
```

If `applyCompositorCommand` returns a NEW state rather than mutating its argument, change the second test to pass `r1.template` into the second call. Also flip the existing assertion in `frontend/tests/unit/effect-tracks-agent-reject.unit.spec.ts` ("animateDial authors a two-keyframe track on the frame motion doc"): read `r.template.motion?.motionx`, find by `path`, and compare `keyframes[0].value` / `keyframes.at(-1).value` instead of `.v`.

- [ ] **Step 2: Run, expect failure** — `npm run test:unit -- agent-compositor-animate-dial` → FAIL (`motionx` undefined, `tracks` has one entry).

- [ ] **Step 3: Rewrite the `animateDial` tail** in `frontend/app/lib/agent/surfaces/compositor.ts`. Keep everything down to `const target = …`; replace from `const seeded = addDialTrack(` to the `state.motion = { … tracks … }` assignment with:

```ts
      // Author a plain motionx band (the timeline's own model): two control points, replacing
      // any band already on this dial. Colour bands keep the oklch mix the old tracks used.
      const band: MotionxTrack = {
        path: target,
        type: spec.kind === 'color' ? 'color' : 'number',
        keyframes: [{ t: start, value: from, ease: 'easeInOut' }, { t: end, value: to, ease: 'linear' }],
        ...(spec.kind === 'color' ? { space: 'oklch' as const } : {}),
      }
      const base = state.motion ?? DEFAULT_FRAME_MOTION
      state.motion = { ...base, motionx: setBandTrack(base.motionx ?? [], target, band) }
```

Imports: remove `addDialTrack, addKeyframe, setTrack` from the `~/lib/motion/effectTracks` import (keep anything else on that line that is still used); add `import { setBandTrack } from '~/lib/motionx/bandEdit'` and `import type { Track as MotionxTrack } from '~/lib/motionx'`. Update the two comments that say the agent writes `tracks` (state doc ~line 82, op hint ~line 828, diff label ~line 1542) to say "timeline bands (`motion.motionx`)"; if the diff label compares `motion.tracks`, compare `motion.motionx` instead.

- [ ] **Step 4: Modal — flow bands back from the agent, and convert on open.** In `CompositorModal.vue`:

Replace the agent `setState` block

```ts
    if (JSON.stringify(s.motion?.tracks ?? []) !== JSON.stringify(motionDoc.value.tracks ?? [])) {
      setMotion({ tracks: s.motion?.tracks ?? [] })
      commitMotionTimeline()
    }
```

with

```ts
    // Only the agent's timeline BANDS flow back (animateDial authors them) — fps/duration are
    // the timeline's own controls, never touched by the agent.
    if (JSON.stringify(s.motion?.motionx ?? []) !== JSON.stringify(motionDoc.value.motionx ?? [])) {
      setMotion({ motionx: s.motion?.motionx ?? [] })
      commitMotionTimeline()
    }
```

Directly after the `setMotion` function, add:

```ts
// 6b: a frame saved with the old effect-dial tracks opens with them converted to timeline
// bands (same paths, same interpolation — see migrateDialTracks + its parity spec). Runs once
// per node; writes only when something actually converted, so untouched frames stay byte-identical.
watch(() => compositor.value?.id, () => {
  const node = compositor.value
  const stored = (node?.data?.properties as Record<string, any> | undefined)?.sailor_motion
  if (!node || !stored) return
  const { motion, converted, dropped } = migrateDialTracks(stored)
  if (converted || dropped) (node.data.properties as Record<string, any>).sailor_motion = motion
}, { immediate: true })
```

and the import `import { migrateDialTracks } from '~/lib/motionx/adapter/migrateDialTracks'`. (`motionDoc` is a computed over `sailor_motion`, so the dock picks the bands up reactively. The bake cache key hashes the motion doc, so a converted frame shows "Re-bake" once — expected.)

- [ ] **Step 5: Run** — `npm run test:unit -- agent-compositor effect-tracks motionx` → pass. `npx vue-tsc --noEmit 2>&1 | grep -E "agent/surfaces/compositor|CompositorModal"` → only the 6 baseline `CompositorModal.vue` errors.

- [ ] **Step 6: Update the e2e expectation** in `frontend/tests/agent-compositor-vocab.spec.ts` (~119-150): wherever it reads `sailor_motion.tracks` after `animateDial`, read `sailor_motion.motionx` and match `{ path, type: 'number', keyframes: [{ value: from }, { value: to }] }`. Do not run the Playwright suite against the shared dev server unless the user asks; note in the commit body that the expectation was updated but not executed.

- [ ] **Step 7: Live check** (browser pane on the already-running dev server; hard-reload first). Open a Frame → Motion tab. Confirm: existing bands and behaviours still list and play; adding a behaviour, reloading the page and reopening the frame keeps it; `read_console_messages onlyErrors` is clean. The conversion itself is proven by Task 2's parity spec — a saved frame with old dial tracks is not needed for this step, but if the user has one, open it and confirm its dial rows now appear as ordinary bands and the picture is unchanged while scrubbing.

- [ ] **Step 8: Commit** (private index; `CompositorModal.vue` is a shared file) — `feat(compositor): old effect-dial tracks open as timeline bands; agent animateDial authors bands`.

---

### Task 4: Pure converter — In/Loop/Out layer animations → bands (by sampling the old engine)

**Files:**
- Create: `frontend/app/lib/motionx/adapter/migrateLayerAnimation.ts`
- Test: `frontend/tests/unit/motionx/migrate-layer-animation.unit.spec.ts`

**Interfaces:**
- Consumes: `evaluateAnimation(anim, t, motion, n)`, `layerWindow` from `~/lib/motion/evaluate`; `composeEffectiveLayer(layer, st, W, H)` from `~/lib/motion/paint`; `LayerAnimation`, `FrameMotion` from `~/lib/motion/types`; `Track` from `~/lib/motionx`.
- Produces:
  - `UNCONVERTIBLE_PRESETS: ReadonlySet<string>` = `mask-up, mask-down, mask-out-up, mask-out-down, card-flip-h, card-flip-v, card-flip-h-out, card-flip-v-out, inward-echoes, grid-scroll-x, grid-scroll-y, noise-tile`.
  - `layerAnimationToTracks(layer: LocalLayer, motion: FrameMotion, dims: { w: number; h: number }, existing: Track[]): Track[] | null` — `null` = leave it legacy.
  - `migrateLayerAnimations(layers: LocalLayer[], motion: FrameMotion & { motionx?: Track[] }, dims): { layers: LocalLayer[]; motionx: Track[]; converted: string[] }` — same `layers` reference and `converted: []` when nothing converts.

Rules:
1. `null` when: no `animation`; no `in`/`loop`/`out`/`keyframes`; any spec's `presetId` is in `UNCONVERTIBLE_PRESETS`; or `existing` already has a track on any of the layer's `x|y|rotation|scale|opacity` paths (the old engine composed ON TOP of bands — not expressible).
2. Sample times: every frame `k / fps` for `k = 0 … ceil(duration · fps)`, plus the window/phase boundaries `start`, `start + inDur`, `start + outStart`, `end` (same formulas as `evaluateAnimation`), clamped to `[0, duration]`, de-duplicated, sorted.
3. At each `t`: `st = evaluateAnimation(anim, t, motion, 1)` — **n = 1 on purpose** (whole layer; per-letter staggering is the accepted loss). Hidden (`!st.visible`) → `{x, y, rotation, scale: base, opacity: 0}` with the layer's own x/y/rotation. Visible → `eff = composeEffectiveLayer(layer, st, w, h)` gives x/y/rotation/opacity; `scale = baseScale · st.layer.scale · (st.units?.[0]?.scale ?? 1)` with `baseScale = typeof layer.scale === 'number' ? layer.scale : 1`.
4. A property whose samples never differ from the layer's base value (|Δ| ≤ 1e-9) gets no band.
5. Simplify each property with Ramer–Douglas–Peucker in (t, value) space, tolerance `0.002` for x/y/scale/opacity and `0.25` for rotation (time axis unscaled). Keyframes are `{ t, value, ease: 'linear' }`.
6. Output tracks are untagged, `type: 'number'`, path `layers.<id>.<prop>`.

- [ ] **Step 1: Failing tests** — create `frontend/tests/unit/motionx/migrate-layer-animation.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { layerAnimationToTracks, migrateLayerAnimations, UNCONVERTIBLE_PRESETS } from '~/lib/motionx/adapter/migrateLayerAnimation'
import { evaluateAnimation } from '~/lib/motion/evaluate'
import { composeEffectiveLayer } from '~/lib/motion/paint'
import { applyMotionxTracks } from '~/lib/motionx/adapter/frame'
import type { LocalLayer } from '~/composables/useCompositorLayers'

const motion = { fps: 30, duration: 4 }
const dims = { w: 1000, h: 1000 }
const rect = (animation: any, over: any = {}) => ({ id: 'L1', kind: 'rect', x: 0.5, y: 0.5, rotation: 10, opacity: 0.8, w: 0.3, h: 0.2, fill: '#fff', stroke: '', strokeWidth: 0, radius: 0, animation, ...over }) as unknown as LocalLayer

/** What the OLD engine shows at t (whole layer). */
function legacy(l: LocalLayer, t: number) {
  const st = evaluateAnimation((l as any).animation, t, motion as any, 1)
  if (!st.visible) return { x: l.x, y: l.y, rotation: l.rotation, opacity: 0, scale: 1 }
  const e = composeEffectiveLayer(l, st, dims.w, dims.h)
  return { x: e.x, y: e.y, rotation: e.rotation, opacity: e.opacity, scale: st.layer.scale * (st.units?.[0]?.scale ?? 1) }
}
/** What the converted bands show at t. */
function converted(l: LocalLayer, tracks: any[], t: number) {
  const { animation: _a, ...bare } = l as any
  const out = applyMotionxTracks([bare], tracks, t)[0] as any
  return { x: out.x, y: out.y, rotation: out.rotation, opacity: out.opacity, scale: out.motionScale ?? out.scale ?? 1 }
}
function expectParity(l: LocalLayer) {
  const tracks = layerAnimationToTracks(l, motion as any, dims, [])!
  expect(tracks).not.toBeNull()
  for (let k = 0; k <= 120; k++) {
    const t = k / 30
    // window edges are a 1-frame ramp in band form; skip the frame right at an edge
    const a = legacy(l, t), b = converted(l, tracks, t)
    const edge = a.opacity === 0 && legacy(l, t + 1 / 30).opacity > 0 || a.opacity > 0 && legacy(l, Math.max(0, t - 1 / 30)).opacity === 0
    if (edge) continue
    expect(b.x, `x @${t}`).toBeCloseTo(a.x, 2)
    expect(b.y, `y @${t}`).toBeCloseTo(a.y, 2)
    expect(b.opacity, `opacity @${t}`).toBeCloseTo(a.opacity, 2)
    expect(b.scale, `scale @${t}`).toBeCloseTo(a.scale, 2)
    expect(Math.abs(b.rotation - a.rotation), `rotation @${t}`).toBeLessThan(0.6)
  }
  return tracks
}

describe('layerAnimationToTracks', () => {
  it('fade in: one opacity band from 0 to the layer opacity, nothing else', () => {
    const tracks = expectParity(rect({ offset: 0, in: { presetId: 'fade-in', duration: 0.8 } }))
    expect(tracks.map((t) => t.path)).toEqual(['layers.L1.opacity'])
    const kf = tracks[0]!.keyframes
    expect(kf[0]).toMatchObject({ t: 0, value: 0 })
    expect(kf.at(-1)!.value).toBeCloseTo(0.8, 6)
  })
  it('slide up + float loop + fade out, inside a 0.5s–3.5s window', () => {
    const tracks = expectParity(rect({ offset: 0.5, duration: 3, in: { presetId: 'slide-up', duration: 0.6 }, loop: { presetId: 'float', duration: 1.5 }, out: { presetId: 'fade-out', duration: 0.5 } }))
    expect(new Set(tracks.map((t) => t.path))).toEqual(new Set(['layers.L1.x', 'layers.L1.y', 'layers.L1.opacity']))
  })
  it('spin + grow in (rotation, scale, opacity) and an elastic drop', () => {
    expectParity(rect({ offset: 0, in: { presetId: 'spin-in', duration: 1 } }))
    expectParity(rect({ offset: 0, in: { presetId: 'elastic-drop', duration: 1.2 } }))
  })
  it('hand keyframes compose with a preset, exactly as the old engine did', () => {
    expectParity(rect({ offset: 0, keyframes: [{ t: 0, dx: 0 }, { t: 2, dx: 0.2, rotation: 45 }], in: { presetId: 'fade-in', duration: 0.5 } }))
  })
  it('bands stay small: a 4s sine loop simplifies to far fewer points than frames', () => {
    const tracks = layerAnimationToTracks(rect({ offset: 0, loop: { presetId: 'sway', duration: 2 } }), motion as any, dims, [])!
    expect(tracks[0]!.keyframes.length).toBeLessThan(60)
  })
  it('refuses masks / flips / copies, empty shells, and layers that already have transform bands', () => {
    for (const id of UNCONVERTIBLE_PRESETS) {
      expect(layerAnimationToTracks(rect({ offset: 0, in: { presetId: id, duration: 1 } }), motion as any, dims, [])).toBeNull()
    }
    expect(layerAnimationToTracks(rect({ offset: 0 }), motion as any, dims, [])).toBeNull()
    expect(layerAnimationToTracks(rect(undefined), motion as any, dims, [])).toBeNull()
    const band = { path: 'layers.L1.rotation', type: 'number' as const, keyframes: [{ t: 0, value: 0, ease: 'linear' as const }] }
    expect(layerAnimationToTracks(rect({ offset: 0, in: { presetId: 'fade-in', duration: 1 } }), motion as any, dims, [band])).toBeNull()
  })
})

describe('migrateLayerAnimations', () => {
  it('nothing to convert → same references', () => {
    const layers = [rect(undefined)]
    const out = migrateLayerAnimations(layers, motion as any, dims)
    expect(out.layers).toBe(layers)
    expect(out.converted).toEqual([])
  })
  it('removes `animation` from converted layers and appends their bands; leaves the rest', () => {
    const a = rect({ offset: 0, in: { presetId: 'fade-in', duration: 1 } })
    const b = rect({ offset: 0, in: { presetId: 'mask-up', duration: 1 } }, { id: 'L2' })
    const out = migrateLayerAnimations([a, b], { ...motion, motionx: [] } as any, dims)
    expect(out.converted).toEqual(['L1'])
    expect('animation' in (out.layers[0] as any)).toBe(false)
    expect((out.layers[1] as any).animation).toBeTruthy()
    expect(out.motionx.map((t) => t.path)).toEqual(['layers.L1.opacity'])
  })
})
```

- [ ] **Step 2: Run, expect failure** — `npm run test:unit -- motionx/migrate-layer-animation`.

- [ ] **Step 3: Implement** — create `frontend/app/lib/motionx/adapter/migrateLayerAnimation.ts`:

```ts
// One-way conversion of the old In/Loop/Out layer animation (`layer.animation`) into motionx
// bands, by SAMPLING the old evaluator on the frame grid and simplifying each property. General
// (presets, hand keyframes, windows and their composition all come out right) and checked by a
// parity spec against the old engine. Accepted losses (user decision 2026-09-19): per-letter
// staggering on text layers — the layer animates as a whole (n = 1) — and preset blur.
import { evaluateAnimation, layerWindow } from '~/lib/motion/evaluate'
import { composeEffectiveLayer } from '~/lib/motion/paint'
import type { FrameMotion, LayerAnimation } from '~/lib/motion/types'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { Keyframe, Track } from '../types'

/** Presets whose look is a mask, an axis flip or tiled copies — no band can express them. */
export const UNCONVERTIBLE_PRESETS: ReadonlySet<string> = new Set([
  'mask-up', 'mask-down', 'mask-out-up', 'mask-out-down',
  'card-flip-h', 'card-flip-v', 'card-flip-h-out', 'card-flip-v-out',
  'inward-echoes', 'grid-scroll-x', 'grid-scroll-y', 'noise-tile',
])

const PROPS = ['x', 'y', 'rotation', 'scale', 'opacity'] as const
type Prop = typeof PROPS[number]
const TOLERANCE: Record<Prop, number> = { x: 0.002, y: 0.002, scale: 0.002, opacity: 0.002, rotation: 0.25 }

/** Ramer–Douglas–Peucker on (t, v); distance is vertical (value) error, which is what the eye sees. */
function simplify(pts: Array<[number, number]>, eps: number): Array<[number, number]> {
  if (pts.length <= 2) return pts
  const keep = new Array<boolean>(pts.length).fill(false)
  keep[0] = keep[pts.length - 1] = true
  const stack: Array<[number, number]> = [[0, pts.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    const [ta, va] = pts[a]!, [tb, vb] = pts[b]!
    let worst = -1, dist = eps
    for (let i = a + 1; i < b; i++) {
      const [t, v] = pts[i]!
      const onLine = tb === ta ? va : va + ((vb - va) * (t - ta)) / (tb - ta)
      const d = Math.abs(v - onLine)
      if (d > dist) { dist = d; worst = i }
    }
    if (worst > 0) { keep[worst] = true; stack.push([a, worst], [worst, b]) }
  }
  return pts.filter((_, i) => keep[i])
}

export function layerAnimationToTracks(layer: LocalLayer, motion: FrameMotion, dims: { w: number; h: number }, existing: Track[]): Track[] | null {
  const anim = (layer as unknown as { animation?: LayerAnimation }).animation
  if (!anim) return null
  const specs = [anim.in, anim.loop, anim.out].filter(Boolean) as Array<{ presetId: string; duration: number }>
  if (!specs.length && !anim.keyframes?.length) return null
  if (specs.some((s) => UNCONVERTIBLE_PRESETS.has(s.presetId))) return null
  const prefix = `layers.${layer.id}.`
  if (existing.some((t) => PROPS.some((p) => t.path === prefix + p))) return null

  const fps = Math.max(1, motion.fps || 30), duration = Math.max(0.05, motion.duration || 4)
  const { start, end } = layerWindow(anim, motion)
  const inDur = anim.in ? Math.max(0.01, anim.in.duration) : 0
  const outDur = anim.out ? Math.max(0.01, anim.out.duration) : 0
  const outStart = Math.max(inDur, (end - start) - outDur)
  const times = new Set<number>()
  for (let k = 0; k <= Math.ceil(duration * fps); k++) times.add(Math.min(duration, k / fps))
  for (const t of [start, start + inDur, start + outStart, end]) times.add(Math.min(duration, Math.max(0, t)))
  const ts = [...times].sort((a, b) => a - b)

  const rec = layer as unknown as Record<string, number>
  const baseScale = typeof rec.scale === 'number' ? rec.scale : 1
  const base: Record<Prop, number> = { x: layer.x, y: layer.y, rotation: layer.rotation, scale: baseScale, opacity: layer.opacity }
  const series: Record<Prop, Array<[number, number]>> = { x: [], y: [], rotation: [], scale: [], opacity: [] }
  for (const t of ts) {
    const st = evaluateAnimation(anim, t, motion, 1)
    let v: Record<Prop, number>
    if (!st.visible) v = { ...base, opacity: 0 }
    else {
      const eff = composeEffectiveLayer(layer, st, dims.w, dims.h)
      v = { x: eff.x, y: eff.y, rotation: eff.rotation, opacity: eff.opacity, scale: baseScale * st.layer.scale * (st.units?.[0]?.scale ?? 1) }
    }
    for (const p of PROPS) series[p].push([t, v[p]])
  }

  const tracks: Track[] = []
  for (const p of PROPS) {
    if (series[p].every(([, v]) => Math.abs(v - base[p]) <= 1e-9)) continue
    const keyframes: Keyframe[] = simplify(series[p], TOLERANCE[p]).map(([t, value]) => ({ t, value, ease: 'linear' }))
    tracks.push({ path: prefix + p, type: 'number', keyframes })
  }
  return tracks
}

export function migrateLayerAnimations(
  layers: LocalLayer[], motion: FrameMotion & { motionx?: Track[] }, dims: { w: number; h: number },
): { layers: LocalLayer[]; motionx: Track[]; converted: string[] } {
  const motionx = [...(motion.motionx ?? [])]
  const converted: string[] = []
  const next = layers.map((l) => {
    const tracks = layerAnimationToTracks(l, motion, dims, motionx)
    if (!tracks) return l
    motionx.push(...tracks)
    converted.push(l.id)
    const { animation: _gone, ...rest } = l as LocalLayer & { animation?: unknown }
    return rest as LocalLayer
  })
  return converted.length ? { layers: next, motionx, converted } : { layers, motionx: motion.motionx ?? [], converted }
}
```

- [ ] **Step 4: Run** — `npm run test:unit -- motionx/migrate-layer-animation` → pass. If a parity case fails by a hair, first check it is a genuine window-edge frame (the helper skips those) before touching a tolerance; tightening `TOLERANCE` is fine, loosening the test is not. Then `npm run test:unit -- motionx motion-` → all pass (old-engine specs untouched).

- [ ] **Step 5: Commit** — `feat(motionx): convert old In/Loop/Out layer animations to bands by sampling the old engine (parity-tested)`.

---

### Task 5: Convert layer animations on open; leftovers are visible and removable in the dock

Run Task 4's converter when the frame opens. Whatever it refuses (masks, flips, copies, or a layer that already has transform bands) keeps rendering through the untouched old engine — and must not be invisible: give it one locked bar and one way out.

**On-open hook** (add to `CompositorModal.vue` next to the dial-track watcher from Task 3, same `watch(() => compositor.value?.id, …, { immediate: true })` pattern; import `migrateLayerAnimations` from `~/lib/motionx/adapter/migrateLayerAnimation`):

```ts
  const res = migrateLayerAnimations(localLayers.value, motionDoc.value, { w: canvasDisplay.w, h: canvasDisplay.h })
  if (res.converted.length) { commit(res.layers); setMotion({ motionx: res.motionx } as Partial<FrameMotion>) }
```

No `recordHistory()` — opening a frame is not an undoable edit. If `canvasDisplay` is not yet sized when the watcher first runs (w or h is 0), defer with `nextTick` and bail if still 0; only the W/H *ratio* matters to the converter.

**Files:**
- Modify: `frontend/app/lib/motionx/bands.ts`
- Modify: `frontend/app/components/vue-canvas/compositor/MotionBandTimeline.vue`
- Modify: `frontend/app/components/vue-canvas/compositor/MotionInspector.vue`
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue`
- Test: `frontend/tests/unit/motionx/bands.unit.spec.ts`

**Interfaces:**
- Produces:
  - `BandKind` gains `'legacy'`.
  - `legacyBandForLayer(layer: { id: string; animation?: { offset?: number; duration?: number; in?: { presetId: string }; loop?: { presetId: string }; out?: { presetId: string }; keyframes?: unknown[] } }, timelineDuration: number): Band | null` — `key: 'legacy:' + id`, `path: 'legacy:' + id`, `kind: 'legacy'`, `type: 'number'`, `label` e.g. `Older animation · Fade in, Float`, `start = max(0, offset)`, `end = duration == null ? timelineDuration : min(timelineDuration, start + max(0, duration))` (the same window rule as `layerWindow` in `lib/motion/evaluate.ts`), `keyframes: []`.
  - Selection kind `'legacy'`: `MotionSelection = { kind: 'band' | 'point' | 'behaviour' | 'legacy'; path: string; index?: number }` where `path` is the layer id for `'legacy'`.
  - Dock emits `'select-legacy': [layerId: string]`; inspector emits `'legacy-remove': [layerId: string]`.

- [ ] **Step 1: Failing test** — append to `frontend/tests/unit/motionx/bands.unit.spec.ts`:

```ts
describe('legacyBandForLayer — an older In/Loop/Out animation, shown as one locked bar', () => {
  it('no animation → null', async () => {
    const { legacyBandForLayer } = await import('~/lib/motionx/bands')
    expect(legacyBandForLayer({ id: 'a' }, 4)).toBeNull()
    expect(legacyBandForLayer({ id: 'a', animation: { offset: 0 } }, 4)).toBeNull()   // empty shell
  })
  it('spans the layer window and names its presets in plain words', async () => {
    const { legacyBandForLayer } = await import('~/lib/motionx/bands')
    const b = legacyBandForLayer({ id: 'a', animation: { offset: 0.5, duration: 2, in: { presetId: 'fade-in' }, loop: { presetId: 'float' } } }, 4)!
    expect(b).toMatchObject({ key: 'legacy:a', kind: 'legacy', start: 0.5, end: 2.5, label: 'Older animation · Fade in, Float' })
  })
  it('no duration → runs to the end of the timeline; never past it', async () => {
    const { legacyBandForLayer } = await import('~/lib/motionx/bands')
    expect(legacyBandForLayer({ id: 'a', animation: { offset: 1, out: { presetId: 'fade-out' } } }, 4)!.end).toBe(4)
    expect(legacyBandForLayer({ id: 'a', animation: { offset: 3, duration: 9, in: { presetId: 'grow-in' } } }, 4)!.end).toBe(4)
  })
  it('keyframes-only animations still get a bar', async () => {
    const { legacyBandForLayer } = await import('~/lib/motionx/bands')
    expect(legacyBandForLayer({ id: 'a', animation: { offset: 0, keyframes: [{ t: 0 }, { t: 1 }] } }, 4)!.label).toBe('Older animation · Keyframes')
  })
})
```

- [ ] **Step 2: Run, expect failure** — `npm run test:unit -- motionx/bands`.

- [ ] **Step 3: Implement in `bands.ts`** — change `BandKind` to include `'legacy'`, and add:

```ts
const words = (presetId: string) => {
  const s = presetId.replace(/-/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}
/** An older In/Loop/Out layer animation (`layer.animation`). It still renders through the old
 *  engine — per-letter staggering, masks, blur and copies have no band equivalent — so the dock
 *  shows it as ONE locked bar over the layer's window. */
export function legacyBandForLayer(
  layer: { id: string; animation?: { offset?: number; duration?: number; in?: { presetId: string }; loop?: { presetId: string }; out?: { presetId: string }; keyframes?: unknown[] } },
  timelineDuration: number,
): Band | null {
  const a = layer.animation
  if (!a) return null
  const parts = [a.in, a.loop, a.out].filter((s): s is { presetId: string } => !!s?.presetId).map((s) => words(s.presetId))
  if (a.keyframes?.length) parts.push('Keyframes')
  if (!parts.length) return null
  const start = Math.max(0, a.offset ?? 0)
  const end = a.duration == null ? timelineDuration : Math.min(timelineDuration, start + Math.max(0, a.duration))
  return { key: `legacy:${layer.id}`, kind: 'legacy', type: 'number', label: `Older animation · ${parts.join(', ')}`, path: `legacy:${layer.id}`, start, end: Math.max(start, end), keyframes: [] }
}
```

- [ ] **Step 4: Dock row.** In `MotionBandTimeline.vue`: import `legacyBandForLayer`; add `'select-legacy': [layerId: string]` to `defineEmits`; widen the `selection` prop's `kind` union with `'legacy'`; include the legacy bar in `rowCountFor`:

```ts
const legacyFor = (l: LocalLayer) => legacyBandForLayer(l as never, props.duration)
const rowCountFor = (l: LocalLayer) => behBandsFor(l.id).length + propBandsFor(l).length + (legacyFor(l) ? 1 : 0)
const isLegacySel = (l: LocalLayer) => props.selection?.kind === 'legacy' && props.selection.path === l.id
```

In the template, inside `<template v-if="!collapsedLayers.has(l.id)">`, **before** the `v-for="r in rowsFor(l)"` template, add:

```html
          <template v-if="legacyFor(l)">
            <span class="truncate text-left text-[10px] pl-5 self-center text-white/45">Older animation</span>
            <div data-band-lane class="relative my-0.5 h-6">
              <div v-if="playheadVisible" class="absolute inset-y-0 w-px bg-[#7c9cff]/50 pointer-events-none z-30" :style="{ left: px(playheadX) }" />
              <button type="button" :data-testid="'legacy-band-' + l.id"
                class="absolute inset-y-0 flex items-center gap-1.5 overflow-hidden rounded-md border border-dashed px-2 text-left text-[9.5px] cursor-pointer select-none"
                :class="isLegacySel(l) ? 'ring-2 ring-[#7c9cff] border-white/40 text-white' : 'border-white/25 text-white/60 hover:border-white/45'"
                :style="{ left: px(xOf(legacyFor(l)!.start)), width: px(wOf(legacyFor(l)!.start, legacyFor(l)!.end)), background: 'rgba(255,255,255,.05)' }"
                title="Made with the older animation tools — it still plays, but can't be edited here"
                @click.stop="emit('select-legacy', l.id)">
                <span class="truncate">{{ legacyFor(l)!.label.replace('Older animation · ', '') }}</span>
              </button>
            </div>
          </template>
```

- [ ] **Step 5: Inspector branch.** In `MotionInspector.vue`: widen `MotionSelection.kind` with `'legacy'`; add `'legacy-remove': [layerId: string]` to `defineEmits`; add a prop `legacyLabel?: string`; add as the **first** branch of the template (before `v-if="behaviour"`, turning that into `v-else-if`):

```html
  <div v-if="selection?.kind === 'legacy'" data-testid="motion-inspector"
    class="rounded-lg border border-white/10 bg-[#0e0e10]/80 px-3 py-2.5 text-[11px] text-white/70">
    <div class="mb-2 flex items-center justify-between border-b border-white/10 pb-2">
      <span class="font-medium text-white/85">Older animation</span>
      <button class="cursor-pointer text-white/40 hover:text-white/80" @click="emit('clear')">Done</button>
    </div>
    <p class="mb-1 text-white/85">{{ legacyLabel }}</p>
    <p class="mb-3 leading-snug text-white/50">This was made with the older animation tools. It still plays exactly as before, but it can't be edited on this timeline. Remove it to animate this layer with behaviours instead.</p>
    <button type="button" data-testid="legacy-remove"
      class="rounded border border-white/15 px-2 py-0.5 text-white/70 hover:border-rose-400/60 hover:text-rose-300 hover:bg-rose-500/10 cursor-pointer"
      @click="emit('legacy-remove', selection.path)">Remove animation</button>
  </div>
```

- [ ] **Step 6: Modal wiring.** In `CompositorModal.vue`: widen the `motionSel` ref's `kind` union with `'legacy'`; add

```ts
function selectLegacyMotion(layerId: string) { selectLocal(layerId); nextTick(() => { motionSel.value = { kind: 'legacy', path: layerId } }) }
function removeLegacyAnimation(layerId: string) {
  recordHistory()
  commit(localLayers.value.map((l) => {
    if (l.id !== layerId) return l
    const { animation: _gone, ...rest } = l as LocalLayer & { animation?: unknown }
    return rest as LocalLayer
  }))
  motionSel.value = null
}
const legacyMotionLabel = computed(() => {
  const s = motionSel.value
  const l = s?.kind === 'legacy' ? localLayers.value.find((x) => x.id === s.path) : null
  return l ? (legacyBandForLayer(l as never, motionDoc.value.duration ?? 4)?.label.replace('Older animation · ', '') ?? '') : ''
})
```

(`selectLocal` must run first because the existing `watch(() => selectedLocal.value?.id, …)` clears `motionSel`; hence the `nextTick`.) In the stale-selection watcher added earlier, return early for `s.kind === 'legacy'` unless the layer no longer has `animation` (then clear). In `deleteMotionSelection()`, handle `kind === 'legacy'` by calling `removeLegacyAnimation(s.path)`. Wire the dock `@select-legacy="selectLegacyMotion"` and the inspector `:legacy-label="legacyMotionLabel" @legacy-remove="removeLegacyAnimation"`. Import `legacyBandForLayer` from `~/lib/motionx/bands`.

- [ ] **Step 7: Verify** — unit: `npm run test:unit -- motionx frame-undo` pass; typecheck your files clean. Live: open `/dev/frame-lab` (its fixture at `app/pages/dev/frame-lab.vue:119-127` sets `.animation` on a layer) → Motion tab → a dashed "Older animation" bar spans the layer's window → click → inspector explains → **Remove animation** → bar disappears, layer stops animating on play → Cmd+Z brings both back.

- [ ] **Step 8: Commit** — `feat(compositor): older In/Loop/Out animations show as one locked bar with a Remove action`.

---

### Task 6: The Design inspector's "animated" dot follows bands

`animatedDialKeysFor` in `CompositorModal.vue` (~line 3933) marks a dial as animated from `motion.tracks` only. After Task 3 there are no new tracks, so the dot would never light.

**Files:**
- Modify: `frontend/app/lib/motion/effectTracks.ts` (`animatedDialKeysOf`)
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` (the one call site)
- Test: `frontend/tests/unit/effect-tracks-animated-keys.unit.spec.ts`

**Interfaces:**
- Produces: `animatedDialKeysOf(targets: DialTargetSpec[], effectId: string, tracks: EffectDialTrack[] | undefined, bandPaths?: Iterable<string>): Set<string>` — a dial is animated when a legacy track **or** a band path targets it.

- [ ] **Step 1: Failing test** — append to `effect-tracks-animated-keys.unit.spec.ts` (reuse the `targets` fixture already defined at the top of that file; it lists dial specs with `path`, `effectId`, `dialKey`):

```ts
it('a timeline band on the dial counts as animated too', () => {
  const spec = targets[0]!
  expect(animatedDialKeysOf(targets, spec.effectId, [], [spec.path]).has(spec.dialKey)).toBe(true)
  expect(animatedDialKeysOf(targets, spec.effectId, [], []).has(spec.dialKey)).toBe(false)
  expect(animatedDialKeysOf(targets, spec.effectId, undefined).size).toBe(0)   // old signature still fine
})
```

- [ ] **Step 2: Run, expect failure**, then **Step 3: implement** — in `animatedDialKeysOf`, change the signature to add `bandPaths: Iterable<string> = []` and build the driven set from both:

```ts
  const driven = new Set<string | undefined>([...(tracks ?? []).map((tr) => tr?.target), ...bandPaths])
```

(keep the function's existing early-return for empty input only if it still checks **both** sources). Call site in the modal:

```ts
  return animatedDialKeysOf(effectDialTargets(layer as any), (fx as any).id, motionTracks.value, motionxTracks.value.map((t) => t.path))
```

- [ ] **Step 4: Run** `npm run test:unit -- effect-tracks` → pass. **Step 5: Commit** — `fix(compositor): the "animated" dial marker follows timeline bands`.

---

### Task 7: Delete the hidden legacy authoring UI

Only after Tasks 3–6 are committed.

**Files:**
- Delete: `frontend/app/components/vue-canvas/compositor/MotionLayerEditor.vue`
- Delete: `frontend/app/components/vue-canvas/compositor/CompositorMotionTimeline.vue`
- Delete: `frontend/app/lib/motion/timelineBands.ts`, `frontend/tests/unit/motion-timeline-bands.unit.spec.ts`
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue`
- Modify: `frontend/app/lib/motion/effectTracks.ts` (remove authoring reducers), delete `frontend/tests/unit/effect-tracks-reducer.unit.spec.ts` and `frontend/tests/unit/effect-tracks-keyframes.unit.spec.ts`; trim reducer cases from `frontend/tests/unit/motion/effectTracksGradient.unit.spec.ts`
- Modify (e2e): `frontend/tests/compositor-layer-effects.spec.ts` (~2198-2500)

- [ ] **Step 1: Prove nothing else uses what you delete.** Run from `frontend/`:

```bash
grep -rn "MotionLayerEditor\|CompositorMotionTimeline\|motion/timelineBands" app tests | grep -v "^app/components/vue-canvas/compositor/\(MotionLayerEditor\|CompositorMotionTimeline\)\.vue"
grep -rn "addDialTrack\|removeDialTrack\|addKeyframe\|moveKeyframe\|removeKeyframe\|setTrack\b" app | grep -v "lib/motion/effectTracks.ts"
```

Expected: the first prints only `CompositorModal.vue` import/usage lines and the `timelineBands` spec; the second prints only `CompositorModal.vue` lines (the agent no longer imports them after Task 3). Anything else → stop and report; do not delete.

- [ ] **Step 2: `CompositorModal.vue`** — remove: the `legacyMotionUi` ref; the three template blocks gated on it (`data-testid="dial-picker"` block, the `<CompositorMotionTimeline v-if="legacyMotionUi" …>` element, the `<MotionLayerEditor v-if="selectedLocal && legacyMotionUi" …>` element and their lead-in comments); the imports of `CompositorMotionTimeline`, `MotionLayerEditor`, and from the `effectTracks` import line everything except `effectDialTargets`, `animatedDialKeysOf` and the types still referenced; the dial-picker script block (`motionDialTargets`/`addDialTrackFor`/`removeDialTrackFor`-style functions between "Motion tab · animate an effect dial" and the motionx section — delete each function and computed whose only reader was the removed template; keep `motionTracks` because Task 6's call site reads it); the `fillDialTargets` import if it loses its last reader. After each removal run `npx vue-tsc --noEmit 2>&1 | grep CompositorModal` — the list must return to exactly the 6 baseline errors (an unused-import or missing-symbol error means you removed too little or too much).

- [ ] **Step 3: `effectTracks.ts`** — delete `addDialTrack`, `removeDialTrack`, `addKeyframe`, `moveKeyframe`, `removeKeyframe`, `setTrack` and their doc comments. Keep types, `effectDialTargets`, `animatedDialKeysOf`, `isGradientValue`, `evaluateDialTrack`, `applyEffectDialTracks` (the read-only render fallback for frames that were never reopened). Update the file's header comment: "Authoring moved to the band timeline (motionx); this file keeps the dial enumeration and the read-only render fold for frames saved before 2026-09."

- [ ] **Step 4: Tests** — delete the two reducer spec files; in `effectTracksGradient.unit.spec.ts` delete only the `it(...)` blocks that call a deleted reducer. In `tests/compositor-layer-effects.spec.ts` delete the tests that click `[data-testid="dial-picker"]` or the old timeline's dial rows; keep the tests that seed `sailor_motion.tracks` directly and assert render/bake parity (they now guard the fallback fold).

- [ ] **Step 5: Delete the files on disk**, then run everything:

```bash
cd frontend && npm run test:unit -- motionx effect-tracks motion frame-undo agent-compositor 2>&1 | grep -E "Tests |Test Files|FAIL"
npx vue-tsc --noEmit 2>&1 | grep -E "CompositorModal|effectTracks|MotionBandTimeline|MotionInspector|agent/surfaces" 
```

Expected: all pass; only the 6 baseline `CompositorModal.vue` errors. Timeline/Vector Type specs (`motion-clip-*`, `vectortype-*`) must still pass — run `npm run test:unit -- motion-clip vectortype`.

- [ ] **Step 6: Live check** — hard-reload the running app, open a Frame → Motion tab: the dock and inspector work (add behaviour, add property, play, undo), the console has no errors, and nothing on the tab references the removed surfaces.

- [ ] **Step 7: Commit** (private index; use `git rm -q --cached` for the deleted paths) — `refactor(compositor): delete the legacy Motion authoring UI (In/Loop/Out editor, old timeline, dial picker)`.

---

### Task 8: Close out

- [ ] Append a dated section to `.superpowers/sdd/progress-unified-motion.md` (local, gitignored): 6b done, what was deleted, what deliberately remains (`evaluate.ts`/`paint.ts` engine for `layer.animation`, Timeline and Vector Type; the read-only `applyEffectDialTracks` fold) and why.
- [ ] Update the memory file `~/.claude/projects/-Users-julien-Documents-GitHub-Sailor/memory/unified-motion-model-programme.md` with the same three facts.
- [ ] Update `docs/superpowers/HANDOFF-unified-motion-phase3-band-ui.md`: mark Phase 3 complete and point at this plan. Commit the doc via private index.

---

## Non-goals (decided, with reasons)

- **Per-letter staggering is not reproduced.** Text layers convert as a whole layer (user decision 2026-09-19, "just convert"). Same for the blur of `blur-in` / `blur-slide-up` / `blur-out`: they convert as fades/slides.
- **Masks, axis flips and tiled copies are not converted** (12 presets). No band can express them; they keep playing through the old engine and show as a locked bar with Remove.
- **Converted bands are ABSOLUTE; the old animation was RELATIVE.** An old animation moved/faded the layer relative to wherever it sat (x += dx, opacity ×=). Converted bands pin the values sampled from the layer's position and opacity at conversion time — like every other band. If the layer is later moved or its opacity changed in Design, the converted bands do not follow. Found by the final review; accepted, and called out to the user.
- **Converted bands are refit into tidy eased two-point bands where the old curve allows, sampled curves otherwise.** Fidelity over tidiness; the gallery is there to rebuild a move cleanly.
- **The legacy dial-track render fold stays.** Frames that are never reopened (card previews, batch bakes) still carry `tracks`; deleting the fold would silently stop their animation. It is ~50 pure, tested lines.
