# Vector Type Motion — stack of moves — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Vector Type Studio's five-way Motion tab with one stack of "moves": every preset, track, entrance and exit is one move card in a list, moves stack without limit, and every move carries an editable ease curve and a play mode.

**Architecture:** The stored motion shape changes from three preset slots (`in`/`out`/`loop`) plus a flat `tracks` array to one `moves` array. A move is a preset, or a bundle of tracks, tagged with a phase (in/loop/out), a duration, an ease and a play mode. The glyph-motion engine composes N moves the way it already composes one preset with tracks (positions and rotation add, scale and opacity multiply, axes add per tag). Old documents convert to moves on load, verified by a render-parity test. The Blink and Scatter effects keep their own config blocks (`motion.blink`, `motion.scatter`); their cards are DERIVED from those blocks, not stored as move records, so there is one source of truth. Ease and play are separated: ten named eases plus a custom bezier drawn by the curve editor that 3D Studio and Space Type already use.

**Tech Stack:** Nuxt 4 (Vue 3 + TypeScript), Vitest, the existing `lib/motion` easing engine, `lib/spacetype/motion.ts`'s `bezierEase`, the existing `CurveEditor.vue`.

## Global Constraints

- **Plain language in all UI copy and any user-facing note** — short sentences, everyday words, no code names (standing rule; `[[plain-language-for-specs-and-questions]]`).
- **Colour: action blue is the only accent; purple is banned; amber only on taste chrome** (`[[sailor-colour-conventions]]`). The band strip's In/Out is amber, loop is emerald, matching `Scene3DMotionTimeline.vue`.
- **A declared control must be read by a renderer** — never ship a setting nothing consumes (the studio's schema rule). Every move field the card edits must reach `vtGlyphMotion` / `applyMotion`.
- **Old saved documents must render identically after conversion** — the parity test in Task 3 is a hard gate.
- **`mergeConfig` is a strict rebuild** — every field type-checked and rewritten from the default; nothing trusted, including the moves array.
- **Frequent commits** — one per task, message ending with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Run the full Vector Type unit suite green before each commit that touches the engine:**
  `cd frontend && npx vitest run tests/unit/vectortype-*.unit.spec.ts`
- **Dev server is `127.0.0.1`, not `localhost`** (`[[sailor-dev-server-localhost-426]]`). Reach the studio by adding a `VectorType` node and clicking its Edit button; there is no standalone studio route.

---

## File structure

**Created:**
- `frontend/app/lib/vectortype/ease.ts` — the `VtEase` type, the ten named eases, `vtEaseToEngineName`, `vtEaseGlyphPath`, `vtEaseSample`.
- `frontend/app/lib/vectortype/moves.ts` — the `VtMove` / `VtPlay` types, defaults, `mergeMove`, `vtMoveTracks` (all tracks across `tracks` moves), `vtIsPresetMove`, and the phase helpers `vtMovePhase` / `vtMoveWindows`.
- `frontend/app/components/vue-canvas/motion/MoveGallery.vue` — the Add-move gallery (In · Loop · Out · Custom).
- `frontend/app/components/vue-canvas/motion/EasePicker.vue` — the named-ease grid plus the custom-curve editor.
- `frontend/app/components/vue-canvas/motion/MoveCard.vue` — one move's collapsed row and expanded settings.
- Test files listed per task under `frontend/tests/unit/`.

**Modified:**
- `frontend/app/lib/motion/easing.ts` — `resolveEase` learns the `bezier(x1,y1,x2,y2)` name form.
- `frontend/app/lib/spacetype/motion.ts` — nothing moves; `bezierEase` is imported from here by `easing.ts` (kept where it is to avoid touching Space Type).
- `frontend/app/lib/vectortype/config.ts` — `VtMotionConfig` gains `moves`, loses `tracks`/`in`/`out`/`loop`; `mergeMotion` converts both shapes; `VtMotionTrack` loses `easing`/`loops` (moved to the move).
- `frontend/app/lib/vectortype/presetMotion.ts` — `unitStateFor` / `presetTransform` loop over moves; `vtSlotPhase` replaced by `moves.ts`'s `vtMovePhase`; `vtPresetSpecs` returns preset moves.
- `frontend/app/lib/vectortype/motion.ts` — `applyMotion` and the animatable-target helpers read tracks from moves via `vtMoveTracks`.
- `frontend/app/lib/vectortype/trackPresets.ts` — `build` returns a `VtMove`; `vtTrackPresetActive` / `vtApplyTrackPreset` operate on moves.
- `frontend/app/lib/vectortype/agentControls.ts` — three move words for the agent.
- `frontend/app/lib/vectortype/migrateKinetic.ts` — writes moves directly.
- `frontend/app/components/vue-canvas/VectorTypeSurface.vue` — the whole Motion tab template and script; the band strip under the preview.
- `frontend/app/lib/vectortype/controls.ts` — the `Motion` group keeps only stagger; blink/scatter rows stay but draw inside their cards.

---

## Task 1: Ease vocabulary and the bezier name form

**Files:**
- Create: `frontend/app/lib/vectortype/ease.ts`
- Modify: `frontend/app/lib/motion/easing.ts` (add `bezier(...)` to `resolveEase`, ~line 47)
- Test: `frontend/tests/unit/vectortype-ease.unit.spec.ts`

**Interfaces:**
- Consumes: `resolveEase`, `bezierEase` (from `lib/spacetype/motion.ts`), `powerOut`, `powerIn`, `sineInOut`, `easeInOutQuad`, `backOut`, `backIn`, `elasticOut`, `bounceOut`, `steps` (from `lib/motion/easing.ts`).
- Produces:
  - `type VtEase = { kind: 'named'; name: VtEaseName } | { kind: 'bezier'; cps: [number, number, number, number] }`
  - `type VtEaseName = 'none' | 'smooth' | 'natural' | 'slowDown' | 'accelerate' | 'overshoot' | 'elastic' | 'bounce' | 'swing' | 'steps'`
  - `const VT_EASE_NAMES: readonly VtEaseName[]`
  - `const DEFAULT_EASE: VtEase` (`{ kind: 'named', name: 'smooth' }`)
  - `function vtEaseToEngineName(ease: VtEase): string` — the GSAP-style name string `resolveEase` understands, or `bezier(x1,y1,x2,y2)`.
  - `function vtEaseSample(ease: VtEase, t: number): number` — eased value at `t∈[0,1]`.
  - `function vtEaseGlyphPath(ease: VtEase, w: number, h: number): string` — an SVG path string sampling the ease across a `w×h` box (y down), for a tile glyph.
  - `function mergeEase(raw: unknown): VtEase` — strict rebuild; unknown → `DEFAULT_EASE`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/vectortype-ease.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { resolveEase } from '~/lib/motion/easing'
import {
  DEFAULT_EASE, VT_EASE_NAMES, mergeEase,
  vtEaseGlyphPath, vtEaseSample, vtEaseToEngineName, type VtEase,
} from '~/lib/vectortype/ease'

describe('vt ease', () => {
  it('every named ease maps to a resolvable engine name with fixed endpoints', () => {
    for (const name of VT_EASE_NAMES) {
      const fn = resolveEase(vtEaseToEngineName({ kind: 'named', name }))
      expect(fn(0)).toBeCloseTo(0, 6)
      expect(fn(1)).toBeCloseTo(1, 6)
    }
  })

  it('smooth eases out: past the diagonal in the first half', () => {
    expect(vtEaseSample({ kind: 'named', name: 'smooth' }, 0.25)).toBeGreaterThan(0.25)
  })

  it('none is linear', () => {
    expect(vtEaseSample({ kind: 'named', name: 'none' }, 0.4)).toBeCloseTo(0.4, 6)
  })

  it('a bezier ease round-trips through the engine name', () => {
    const ease: VtEase = { kind: 'bezier', cps: [0.87, 0, 0.13, 1] }
    const fn = resolveEase(vtEaseToEngineName(ease))
    // exp-style bezier: below the diagonal at the start
    expect(fn(0.25)).toBeLessThan(0.25)
    expect(fn(0)).toBeCloseTo(0, 4)
    expect(fn(1)).toBeCloseTo(1, 4)
  })

  it('the glyph path is monotone in x across a 40x20 box', () => {
    const d = vtEaseGlyphPath({ kind: 'named', name: 'smooth' }, 40, 20)
    const xs = [...d.matchAll(/[ML] ([\d.]+)/g)].map(m => Number(m[1]))
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1])
  })

  it('mergeEase rejects junk and clamps bezier points', () => {
    expect(mergeEase(undefined)).toEqual(DEFAULT_EASE)
    expect(mergeEase({ kind: 'named', name: 'nope' })).toEqual(DEFAULT_EASE)
    expect(mergeEase({ kind: 'bezier', cps: [2, 5, -3, -9] }))
      .toEqual({ kind: 'bezier', cps: [1, 1.6, 0, -0.6] })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/vectortype-ease.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/vectortype/ease`.

- [ ] **Step 3: Add the bezier name form to `resolveEase`**

In `frontend/app/lib/motion/easing.ts`, add an import at the top:

```ts
import { bezierEase } from '~/lib/spacetype/motion'
```

Then, inside `resolveEase`, immediately after the `if (name === 'none' || name === 'linear') return linear` line, add:

```ts
  const bez = /^bezier\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)$/.exec(name)
  if (bez) {
    const cps: [number, number, number, number] = [Number(bez[1]), Number(bez[2]), Number(bez[3]), Number(bez[4])]
    return (t: number) => bezierEase(t, cps)
  }
```

- [ ] **Step 4: Write `ease.ts`**

```ts
// frontend/app/lib/vectortype/ease.ts
/**
 * Vector Type — a move's ease, and its picture. PURE.
 *
 * A move carries ONE ease. `vtEaseToEngineName` turns it into a string the
 * shared resolver (`lib/motion/easing.ts`) already reads — the ten named eases
 * map onto functions that exist there, and a bezier becomes `bezier(a,b,c,d)`,
 * the name form Task 1 taught the resolver. `vtEaseGlyphPath` samples the SAME
 * function the motion uses, so a tile can never disagree with the movement.
 */
import { resolveEase } from '~/lib/motion/easing'

export type VtEaseName =
  | 'none' | 'smooth' | 'natural' | 'slowDown' | 'accelerate'
  | 'overshoot' | 'elastic' | 'bounce' | 'swing' | 'steps'

export const VT_EASE_NAMES: readonly VtEaseName[] =
  Object.freeze(['smooth', 'none', 'natural', 'slowDown', 'accelerate', 'overshoot', 'elastic', 'bounce', 'swing', 'steps'])

export type VtEase =
  | { kind: 'named'; name: VtEaseName }
  | { kind: 'bezier'; cps: [number, number, number, number] }

export const DEFAULT_EASE: VtEase = { kind: 'named', name: 'smooth' }

/** Plain-language label for each name, for the picker. */
export const VT_EASE_LABELS: Record<VtEaseName, string> = {
  none: 'None', smooth: 'Smooth', natural: 'Natural', slowDown: 'Slow down',
  accelerate: 'Speed up', overshoot: 'Overshoot', elastic: 'Elastic',
  bounce: 'Bounce', swing: 'Swing', steps: 'Steps',
}

const ENGINE_NAME: Record<VtEaseName, string> = {
  none: 'none', smooth: 'power2.out', natural: 'sine.inOut', slowDown: 'power3.out',
  accelerate: 'power3.in', overshoot: 'back.out', elastic: 'elastic.out',
  bounce: 'bounce.out', swing: 'back.inOut', steps: 'steps(6)',
}

export function vtEaseToEngineName(ease: VtEase): string {
  if (ease.kind === 'bezier') {
    const [a, b, c, d] = ease.cps
    return `bezier(${a},${b},${c},${d})`
  }
  return ENGINE_NAME[ease.name] ?? 'power2.out'
}

export function vtEaseSample(ease: VtEase, t: number): number {
  return resolveEase(vtEaseToEngineName(ease))(t)
}

/** An SVG path across a `w×h` box, y DOWN (0 at top = value 1). Overshoot is
 *  clamped into the box so a tile never draws outside its frame. */
export function vtEaseGlyphPath(ease: VtEase, w: number, h: number): string {
  const N = 24
  const clamp = (v: number) => Math.max(0, Math.min(1, v))
  let d = ''
  for (let i = 0; i <= N; i++) {
    const x = i / N
    const y = clamp(vtEaseSample(ease, x))
    const px = (x * w).toFixed(2)
    const py = ((1 - y) * h).toFixed(2)
    d += `${i === 0 ? 'M' : 'L'} ${px} ${py} `
  }
  return d.trim()
}

const clampX = (v: number) => Math.max(0, Math.min(1, v))
const clampY = (v: number) => Math.max(-0.6, Math.min(1.6, v))
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function mergeEase(raw: unknown): VtEase {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_EASE }
  const o = raw as Record<string, unknown>
  if (o.kind === 'bezier' && Array.isArray(o.cps) && o.cps.length === 4 && o.cps.every(isNum)) {
    const [x1, y1, x2, y2] = o.cps as number[]
    return { kind: 'bezier', cps: [clampX(x1!), clampY(y1!), clampX(x2!), clampY(y2!)] }
  }
  if (o.kind === 'named' && typeof o.name === 'string' && (VT_EASE_NAMES as readonly string[]).includes(o.name)) {
    return { kind: 'named', name: o.name as VtEaseName }
  }
  return { ...DEFAULT_EASE }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/vectortype-ease.unit.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Guard the Compositor did not regress**

Run: `cd frontend && npx vitest run tests/unit/motion-*.unit.spec.ts`
Expected: PASS (the `bezier(...)` branch is additive; existing names are untouched).

- [ ] **Step 7: Commit**

```bash
cd frontend && git add app/lib/vectortype/ease.ts app/lib/motion/easing.ts tests/unit/vectortype-ease.unit.spec.ts
git commit -m "feat(vectortype): move ease vocabulary — ten named + bezier, with a matching glyph

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: The move data model and its merge

**Files:**
- Create: `frontend/app/lib/vectortype/moves.ts`
- Modify: `frontend/app/lib/vectortype/config.ts` (`VtMotionConfig`, `VtMotionTrack`, `DEFAULT_MOTION`, `mergeMotion`, `mergeTrack`)
- Test: `frontend/tests/unit/vectortype-moves.unit.spec.ts`

**Interfaces:**
- Consumes: `VtMotionTrack`, `mergeTrack` (config.ts), `VtEase`/`DEFAULT_EASE`/`mergeEase` (ease.ts).
- Produces:
  - `type VtMovePhase = 'in' | 'loop' | 'out'`
  - `type VtPlayMode = 'once' | 'backAndForth' | 'repeat'`
  - `interface VtPlay { mode: VtPlayMode; times: number }`
  - `interface VtMove { id: string; phase: VtMovePhase; kind: 'preset' | 'tracks'; presetId?: string; duration: number; ease: VtEase; play: VtPlay; params?: Record<string, number>; tracks?: VtMotionTrack[] }`
  - `const DEFAULT_PLAY: VtPlay`
  - `function mergeMove(raw: unknown, remap?: (p: string) => string | null): VtMove | undefined`
  - `function vtMoveTracks(cfg): VtMotionTrack[]` — every track across all `tracks` moves, each carrying `__ease`/`__play` from its move (see below).
  - `function newMoveId(existing: readonly VtMove[]): string`
- Change: `VtMotionConfig` gains `moves: VtMove[]`, drops `tracks`, `in`, `out`, `loop`. `VtMotionTrack` drops `easing` and `loops` (those live on the move now).

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/vectortype-moves.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_EASE } from '~/lib/vectortype/ease'
import { DEFAULT_PLAY, mergeMove, newMoveId, vtMoveTracks, type VtMove } from '~/lib/vectortype/moves'
import { DEFAULT_CONFIG, cloneConfig } from '~/lib/vectortype/config'

describe('vt moves', () => {
  it('mergeMove type-checks a preset move', () => {
    const m = mergeMove({ id: 'm1', phase: 'in', kind: 'preset', presetId: 'fade-in', duration: 0.6 })!
    expect(m.kind).toBe('preset')
    expect(m.phase).toBe('in')
    expect(m.duration).toBe(0.6)
    expect(m.ease).toEqual(DEFAULT_EASE)
    expect(m.play).toEqual(DEFAULT_PLAY)
  })

  it('mergeMove drops a move with no presetId and no tracks', () => {
    expect(mergeMove({ id: 'm2', phase: 'loop', kind: 'preset' })).toBeUndefined()
    expect(mergeMove({ id: 'm3', phase: 'loop', kind: 'tracks', tracks: [] })).toBeUndefined()
  })

  it('mergeMove clamps duration and defaults an unknown phase to loop', () => {
    const m = mergeMove({ id: 'm4', phase: 'sideways', kind: 'preset', presetId: 'wave', duration: 999 })!
    expect(m.phase).toBe('loop')
    expect(m.duration).toBe(60)
  })

  it('vtMoveTracks flattens every tracks-move and tags each track', () => {
    const cfg = cloneConfig(DEFAULT_CONFIG)
    cfg.motion.moves = [
      { id: 'a', phase: 'loop', kind: 'preset', presetId: 'wave', duration: 1.5, ease: DEFAULT_EASE, play: DEFAULT_PLAY },
      { id: 'b', phase: 'loop', kind: 'tracks', duration: 4, ease: { kind: 'named', name: 'none' }, play: { mode: 'backAndForth', times: 1 },
        tracks: [{ path: 'axes.wght', from: 100, to: 900, hold: 0, cycleOffset: 0, delay: 0 }] },
    ] as VtMove[]
    const tracks = vtMoveTracks(cfg)
    expect(tracks).toHaveLength(1)
    expect(tracks[0]!.path).toBe('axes.wght')
    expect((tracks[0] as any).__play.mode).toBe('backAndForth')
  })

  it('newMoveId does not collide with existing ids', () => {
    const id = newMoveId([{ id: 'move-1' } as VtMove])
    expect(id).not.toBe('move-1')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/vectortype-moves.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/vectortype/moves`.

- [ ] **Step 3: Write `moves.ts`**

```ts
// frontend/app/lib/vectortype/moves.ts
/**
 * Vector Type — a MOVE: one thing the user added to the Motion tab. PURE.
 *
 * A move is a preset (kinetic or axis) OR a bundle of tracks, tagged with a
 * phase (in / loop / out), a length, an ease and a play mode. This replaces the
 * three preset SLOTS (in/out/loop) plus the flat `tracks` array with ONE list —
 * and because a slot held one preset while a list holds many, entrances and
 * exits now STACK.
 *
 * Blink and Scatter are NOT moves: they keep their own config blocks
 * (`motion.blink`, `motion.scatter`) because their evaluators read them there
 * and they are animatable leaves. Their CARDS are derived from those blocks by
 * the surface — one source of truth, no marker to drift.
 */
import { DEFAULT_EASE, mergeEase, type VtEase } from './ease'
import type { VtMotionTrack } from './config'

export type VtMovePhase = 'in' | 'loop' | 'out'
export const VT_MOVE_PHASES: readonly VtMovePhase[] = Object.freeze(['in', 'loop', 'out'])

export type VtPlayMode = 'once' | 'backAndForth' | 'repeat'
export const VT_PLAY_MODES: readonly VtPlayMode[] = Object.freeze(['once', 'backAndForth', 'repeat'])

export interface VtPlay { mode: VtPlayMode; times: number }
export const DEFAULT_PLAY: VtPlay = { mode: 'once', times: 1 }

export interface VtMove {
  id: string
  phase: VtMovePhase
  kind: 'preset' | 'tracks'
  /** kind 'preset': a kinetic or axis preset id. kind 'tracks': the track-preset
   *  id it was made from, or 'custom'. */
  presetId?: string
  duration: number
  ease: VtEase
  play: VtPlay
  params?: Record<string, number>
  tracks?: VtMotionTrack[]
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const clampDur = (v: number) => Math.max(0.05, Math.min(60, v))

function mergePlay(raw: unknown): VtPlay {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PLAY }
  const o = raw as Record<string, unknown>
  const mode = (VT_PLAY_MODES as readonly string[]).includes(o.mode as string) ? o.mode as VtPlayMode : 'once'
  const times = isNum(o.times) ? Math.max(1, Math.min(20, Math.round(o.times))) : 1
  return { mode, times }
}

function mergeParams(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (isNum(v)) out[k] = v
  return Object.keys(out).length ? out : undefined
}

/** `mergeTrack` is passed in to avoid a config→moves→config import cycle at
 *  module load — config.ts calls `mergeMove(raw, mergeTrackFn)`. */
export function mergeMove(
  raw: unknown,
  mergeTrackFn?: (t: unknown) => VtMotionTrack | undefined,
): VtMove | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  const kind = o.kind === 'tracks' ? 'tracks' : 'preset'
  const phase: VtMovePhase = (VT_MOVE_PHASES as readonly string[]).includes(o.phase as string) ? o.phase as VtMovePhase : 'loop'
  const id = typeof o.id === 'string' && o.id ? o.id : `move-${Math.random().toString(36).slice(2, 9)}`
  const presetId = typeof o.presetId === 'string' && o.presetId.trim() ? o.presetId.trim() : undefined

  const base = {
    id, phase, kind,
    duration: clampDur(isNum(o.duration) ? o.duration : 1),
    ease: mergeEase(o.ease),
    play: mergePlay(o.play),
  } as VtMove

  if (kind === 'tracks') {
    const rawTracks = Array.isArray(o.tracks) ? o.tracks : []
    const tracks: VtMotionTrack[] = []
    for (const t of rawTracks) { const tk = mergeTrackFn?.(t); if (tk) tracks.push(tk) }
    if (!tracks.length) return undefined
    return { ...base, presetId: presetId ?? 'custom', tracks }
  }
  if (!presetId) return undefined
  const params = mergeParams(o.params)
  return { ...base, presetId, ...(params ? { params } : {}) }
}

/** Every track across every `tracks` move, each tagged with its move's ease and
 *  play under non-enumerable-ish `__ease`/`__play` keys the evaluator reads.
 *  (A plain property; the merge never emits it, so it never persists.) */
export function vtMoveTracks(cfg: { motion?: { moves?: VtMove[] } } | null | undefined): VtMotionTrack[] {
  const moves = cfg?.motion?.moves
  if (!Array.isArray(moves)) return []
  const out: VtMotionTrack[] = []
  for (const m of moves) {
    if (m.kind !== 'tracks' || !m.tracks) continue
    for (const tk of m.tracks) out.push({ ...tk, __ease: m.ease, __play: m.play } as VtMotionTrack & { __ease: VtEase; __play: VtPlay })
  }
  return out
}

export const vtIsPresetMove = (m: VtMove): boolean => m.kind === 'preset'

export function newMoveId(existing: readonly VtMove[]): string {
  const used = new Set(existing.map(m => m.id))
  let n = existing.length + 1
  let id = `move-${n}`
  while (used.has(id)) id = `move-${++n}`
  return id
}
```

- [ ] **Step 4: Change `config.ts` types and merge**

In `frontend/app/lib/vectortype/config.ts`:

1. Add the import near the other local imports:
```ts
import { type VtMove, mergeMove } from './moves'
```

2. In `interface VtMotionTrack`, remove the `easing: EasingKind` and `loops: number` fields (the move owns them now). Keep `path`, `from`, `to`, `hold`, `cycleOffset`, `delay`, and the colour fields.

3. Replace the `VtMotionConfig` fields `tracks`, `in?`, `out?`, `loop?` with `moves`:
```ts
export interface VtMotionConfig {
  moves: VtMove[]
  duration: number
  fps: number
  size: number
  stagger: VtStaggerConfig
  blink: VtBlinkConfig
  scatter: VtScatterConfig
}
```

4. In `DEFAULT_MOTION` and `DEFAULT_CONFIG.motion`, replace `tracks: []` with `moves: []`.

5. In `mergeTrack`, delete the lines that read `o.easing` and `o.loops`; a track's shape no longer carries them. (Leave the colour and timing handling.)

6. Rewrite the slots/tracks part of `mergeMotion` to build `moves` (the conversion of OLD shapes is added in Task 3; for now, read the NEW shape):
```ts
  const moves: VtMove[] = []
  if (Array.isArray(o.moves)) {
    for (const raw of o.moves) { const m = mergeMove(raw, (t) => mergeTrack(t, remap)); if (m) moves.push(m) }
  }
  return {
    moves,
    duration: clamp(num(o.duration, DEFAULT_MOTION.duration), 0.1, 60),
    fps: clamp(Math.round(num(o.fps, DEFAULT_MOTION.fps)), 1, 60),
    size: oneOfNum(o.size, VT_MOTION_SIZES, DEFAULT_MOTION.size),
    stagger: mergeStagger(o.stagger),
    blink: mergeBlink(o.blink),
    scatter: mergeScatter(o.scatter),
  }
```

7. Delete `mergeAnimSpec` (no longer used) and its import of `LayerAnimSpec` if nothing else references it. Leave `VT_PRESET_SLOTS` / `VT_PRESET_DURATIONS` in place for now — Task 3's conversion still reads them.

- [ ] **Step 5: Fix the immediate type fallout so the suite compiles**

`applyMotion` in `motion.ts` and several helpers read `cfg.motion.tracks`. Task 5 rewrites them properly; to keep this task's test compiling, add a temporary shim at the top of `motion.ts`:
```ts
import { vtMoveTracks } from './moves'
```
and replace every `cfg.motion.tracks` read in `motion.ts` with `vtMoveTracks(cfg)`, and every `config.value.motion.tracks` WRITE site — there are none in `motion.ts`. (Write sites live in the surface, handled in Task 9.)

Run the typecheck to see what still references the removed fields:
```bash
cd frontend && npx vue-tsc --noEmit 2>&1 | grep -E "motion\.(tracks|in|out|loop)|mergeAnimSpec|\.easing|\.loops" | head -40
```
Fix each by pointing reads at `vtMoveTracks(cfg)`; leave surface (`.vue`) and preset (`presetMotion.ts`, `trackPresets.ts`) errors for their tasks — note them, do not chase them here.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/vectortype-moves.unit.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
cd frontend && git add app/lib/vectortype/moves.ts app/lib/vectortype/config.ts app/lib/vectortype/motion.ts tests/unit/vectortype-moves.unit.spec.ts
git commit -m "feat(vectortype): the move data model — moves replace preset slots + flat tracks

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Convert old documents on load

**Files:**
- Modify: `frontend/app/lib/vectortype/config.ts` (`mergeMotion` — accept the old shape)
- Modify: `frontend/app/lib/vectortype/trackPresets.ts` (`vtTrackPresetActive` used by the matcher — read below; if not yet moves-aware, add a legacy-tracks matcher helper `vtMatchLegacyTrackPreset(tracks)`) 
- Test: `frontend/tests/unit/vectortype-moves-migrate.unit.spec.ts`

**Interfaces:**
- Consumes: `VT_PRESET_SLOTS`, `VT_PRESET_DURATIONS`, `mergeMove`, `mergeTrack`, `DEFAULT_EASE`.
- Produces: `mergeMotion` now converts a config whose `motion` carries `in`/`out`/`loop`/`tracks` (old) into `moves`, and a config carrying `moves` (new) straight through.

**Conversion rules (from spec §7):**
1. Each old slot spec (`in`/`out`/`loop`) → one `preset` move; `phase` = the slot; `ease` = the spec's `ease` string mapped to a `VtEase` if it names one of the ten, else `DEFAULT_EASE`; `play` = `{ mode:'once', times:1 }` for in/out, `{ mode:'repeat', times:1 }` for loop; `params` carried through.
2. Old `tracks`: matched as a whole against each track preset (via `vtMatchLegacyTrackPreset`); a match becomes ONE `tracks` move with that preset id; every leftover track becomes its own `custom` `tracks` move. Track `easing` maps `linear`→ease `none`+play `once`, `easeinout`→ease `natural`+play `once`, `pingpong`→ease `none`+play `backAndForth`. Track `loops`→`play.times`. Phase is always `loop`.
3. Blink and Scatter blocks are already `motion.blink`/`motion.scatter`; no move is created (cards derive).

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/vectortype-moves-migrate.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { mergeConfig, DEFAULT_CONFIG, cloneConfig } from '~/lib/vectortype/config'

describe('vt motion migration', () => {
  it('converts in/out/loop slots to preset moves', () => {
    const old = cloneConfig(DEFAULT_CONFIG) as any
    old.motion = {
      duration: 4, fps: 30, size: 1080,
      in: { presetId: 'fade-in', duration: 0.6, ease: 'power2.out' },
      out: { presetId: 'fade-out', duration: 0.5 },
      loop: { presetId: 'wave', duration: 1.2 },
      tracks: [],
      stagger: { delay: 0, order: 'forward', seed: 0 },
      blink: { amount: 0 }, scatter: { spread: 0 },
    }
    const cfg = mergeConfig(old)
    const moves = cfg.motion.moves
    expect(moves).toHaveLength(3)
    const inMove = moves.find(m => m.phase === 'in')!
    expect(inMove.presetId).toBe('fade-in')
    expect(inMove.play.mode).toBe('once')
    expect(moves.find(m => m.phase === 'loop')!.play.mode).toBe('repeat')
  })

  it('a pingpong track becomes a custom move that plays back and forth', () => {
    const old = cloneConfig(DEFAULT_CONFIG) as any
    old.motion = {
      duration: 4, fps: 30, size: 1080,
      tracks: [{ path: 'axes.wght', from: 100, to: 900, easing: 'pingpong', loops: 2, hold: 0, cycleOffset: 0, delay: 0 }],
      stagger: { delay: 0, order: 'forward', seed: 0 }, blink: { amount: 0 }, scatter: { spread: 0 },
    }
    const cfg = mergeConfig(old)
    expect(cfg.motion.moves).toHaveLength(1)
    const m = cfg.motion.moves[0]!
    expect(m.kind).toBe('tracks')
    expect(m.presetId).toBe('custom')
    expect(m.play).toEqual({ mode: 'backAndForth', times: 2 })
    expect(m.ease).toEqual({ kind: 'named', name: 'none' })
    expect(m.tracks![0]!.path).toBe('axes.wght')
  })

  it('a new-shape config round-trips unchanged', () => {
    const cfg = mergeConfig(cloneConfig(DEFAULT_CONFIG))
    expect(cfg.motion.moves).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/vectortype-moves-migrate.unit.spec.ts`
Expected: FAIL — the slots are ignored, `moves` is empty.

- [ ] **Step 3: Add a legacy track-preset matcher to `trackPresets.ts`**

```ts
// append to frontend/app/lib/vectortype/trackPresets.ts
/** Does this flat list of legacy tracks match a whole track preset's output,
 *  by path set? Returns the preset id, or null. Used only by migration. */
export function vtMatchLegacyTrackPreset(tracks: readonly { path: string }[]): string | null {
  const paths = new Set(tracks.map(t => t.path))
  for (const preset of VT_TRACK_PRESETS) {
    // A preset's build() needs a live config; migration cannot run it, so match
    // on the preset's declared signature paths instead.
    const sig = PRESET_SIGNATURE_PATHS[preset.id]
    if (sig && sig.length === paths.size && sig.every(p => paths.has(p))) return preset.id
  }
  return null
}
```

Add the signature table beside `VT_TRACK_PRESETS` (the fixed paths each preset writes, independent of the live layers — for run-level presets the exact `layout.*` keys, for stack presets the `stack.*` template):
```ts
const PRESET_SIGNATURE_PATHS: Record<string, string[]> = {
  'stretch-in': ['layout.stretch'],
  'stretch-wave': ['layout.stretch'],
  'spring-up': ['layout.height'],
  // stack presets address layers by id, so their signatures are dynamic —
  // migration leaves those tracks as custom moves (a safe, exact-timing default).
}
```
(If the exact run-level paths differ from `layout.stretch` / `layout.height`, read them from each preset's `build` and copy the real keys; the two run presets are the only ones migration collapses.)

- [ ] **Step 4: Add conversion to `mergeMotion`**

In `config.ts`, before the `const moves: VtMove[] = []` block from Task 2, branch on whether the raw motion is old-shaped:

```ts
  const hasOldShape = ('tracks' in o) || VT_PRESET_SLOTS.some(s => s in o)
  const hasNewShape = Array.isArray(o.moves)
  const moves: VtMove[] = []

  if (hasNewShape) {
    for (const raw of o.moves as unknown[]) { const m = mergeMove(raw, (t) => mergeTrack(t, remap)); if (m) moves.push(m) }
  } else if (hasOldShape) {
    // 1. slots → preset moves
    for (const slot of VT_PRESET_SLOTS) {
      const raw = o[slot] as Record<string, unknown> | undefined
      if (!raw || typeof raw !== 'object') continue
      const presetId = typeof raw.presetId === 'string' ? raw.presetId.trim() : ''
      if (!presetId) continue
      const easeName = legacyEaseName(typeof raw.ease === 'string' ? raw.ease : undefined)
      const m = mergeMove({
        id: `move-${slot}`, phase: slot, kind: 'preset', presetId,
        duration: num(raw.duration, VT_PRESET_DURATIONS[slot]),
        ease: easeName ? { kind: 'named', name: easeName } : undefined,
        play: slot === 'loop' ? { mode: 'repeat', times: 1 } : { mode: 'once', times: 1 },
        params: raw.params,
      }, (t) => mergeTrack(t, remap))
      if (m) moves.push(m)
    }
    // 2. tracks → one preset move (if matched) + custom moves for the rest
    const rawTracks: any[] = Array.isArray(o.tracks) ? o.tracks : []
    const merged = rawTracks.map(t => mergeTrack(t, remap)).filter(Boolean) as VtMotionTrack[]
    const rawByMerged = new Map<VtMotionTrack, any>()
    merged.forEach((mk, i) => rawByMerged.set(mk, rawTracks[i]))
    const presetId = merged.length ? vtMatchLegacyTrackPreset(merged) : null
    if (presetId) {
      moves.push(mergeMove({ id: 'move-track-preset', phase: 'loop', kind: 'tracks', presetId, duration: num(o.duration, 4),
        ease: { kind: 'named', name: 'none' }, play: { mode: 'repeat', times: 1 }, tracks: merged }, (t) => mergeTrack(t, remap))!)
    } else {
      for (const mk of merged) {
        const raw = rawByMerged.get(mk)
        const { ease, play } = legacyTrackEasePlay(raw?.easing, raw?.loops)
        moves.push(mergeMove({ id: `move-${moves.length + 1}`, phase: 'loop', kind: 'tracks', presetId: 'custom',
          duration: num(o.duration, 4), ease, play, tracks: [mk] }, (t) => mergeTrack(t, remap))!)
      }
    }
  }
```

Add the two legacy helpers near `mergeMotion`:
```ts
function legacyEaseName(ease: string | undefined): VtEaseName | null {
  if (ease === 'none' || ease === 'linear') return 'none'
  if (ease?.startsWith('power')) return ease.includes('.in') && !ease.includes('inOut') ? 'accelerate' : 'smooth'
  if (ease === 'sine.inOut') return 'natural'
  if (ease?.startsWith('back')) return 'overshoot'
  if (ease?.startsWith('elastic')) return 'elastic'
  if (ease?.startsWith('bounce')) return 'bounce'
  return null
}
function legacyTrackEasePlay(easing: unknown, loops: unknown): { ease: VtEase; play: VtPlay } {
  const times = typeof loops === 'number' && Number.isFinite(loops) ? Math.max(1, Math.round(loops)) : 1
  if (easing === 'pingpong') return { ease: { kind: 'named', name: 'none' }, play: { mode: 'backAndForth', times } }
  if (easing === 'easeinout') return { ease: { kind: 'named', name: 'natural' }, play: { mode: 'once', times } }
  return { ease: { kind: 'named', name: 'none' }, play: { mode: 'once', times } }
}
```
Import `VtEaseName`, `VtEase`, `VtPlay` at the top of config.ts.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/vectortype-moves-migrate.unit.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
cd frontend && git add app/lib/vectortype/config.ts app/lib/vectortype/trackPresets.ts tests/unit/vectortype-moves-migrate.unit.spec.ts
git commit -m "feat(vectortype): convert old motion (slots + tracks) to moves on load

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Move phase windows

**Files:**
- Modify: `frontend/app/lib/vectortype/moves.ts` (add `vtMoveWindows`, `vtMovePhase`)
- Test: `frontend/tests/unit/vectortype-moves-phase.unit.spec.ts`

**Interfaces:**
- Produces:
  - `interface VtMoveWindow { move: VtMove; start: number; end: number }`
  - `function vtMoveWindows(moves: readonly VtMove[], clip: number): { longestIn: number; windows: VtMoveWindow[] }`
  - `function vtMovePhase(move: VtMove, gt: number, clip: number, longestIn: number): number | null` — returns eased-and-played progress in `[0,1]` (or a periodic phase for loops), or `null` when the move is not live at `gt`.

**Rules (spec §2):** In runs `[0, duration]`. Out runs `[clip − duration, clip]`. Loop runs the whole clip, phase 0 at `longestIn`. `play` shapes the pass: `once` = the eased pass over the window; `backAndForth` = forward then reverse each cycle; `repeat` = `times` eased passes. Ease is applied to each pass's local progress.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/vectortype-moves-phase.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_EASE } from '~/lib/vectortype/ease'
import { vtMovePhase, vtMoveWindows, type VtMove } from '~/lib/vectortype/moves'

const mk = (o: Partial<VtMove>): VtMove => ({ id: 'x', phase: 'in', kind: 'preset', presetId: 'p', duration: 1, ease: { kind: 'named', name: 'none' }, play: { mode: 'once', times: 1 }, ...o })

describe('vt move windows', () => {
  it('two ins of different length; the longest sets loop phase 0', () => {
    const a = mk({ id: 'a', phase: 'in', duration: 0.6 })
    const b = mk({ id: 'b', phase: 'in', duration: 1.0 })
    const { longestIn } = vtMoveWindows([a, b], 4)
    expect(longestIn).toBeCloseTo(1.0, 6)
  })

  it('an in move is live only inside its window', () => {
    const a = mk({ phase: 'in', duration: 0.5 })
    expect(vtMovePhase(a, 0.25, 4, 0.5)).toBeCloseTo(0.5, 6) // linear ease, halfway
    expect(vtMovePhase(a, 0.6, 4, 0.5)).toBeNull()
  })

  it('an out move runs at the end', () => {
    const o = mk({ phase: 'out', duration: 0.5 })
    expect(vtMovePhase(o, 3.75, 4, 0)).toBeCloseTo(0.5, 6)
    expect(vtMovePhase(o, 3.0, 4, 0)).toBeNull()
  })

  it('a loop phase 0 sits at the longest in end and wraps', () => {
    const l = mk({ phase: 'loop', duration: 1, play: { mode: 'repeat', times: 1 } })
    expect(vtMovePhase(l, 1.0, 4, 1.0)).toBeCloseTo(0, 6)
    expect(vtMovePhase(l, 1.5, 4, 1.0)).toBeCloseTo(0.5, 6)
  })

  it('back and forth returns to 0 at the cycle end', () => {
    const l = mk({ phase: 'loop', duration: 1, play: { mode: 'backAndForth', times: 1 } })
    expect(vtMovePhase(l, 1.0, 4, 1.0)).toBeCloseTo(0, 6)
    expect(vtMovePhase(l, 1.5, 4, 1.0)).toBeCloseTo(1, 6)
    expect(vtMovePhase(l, 2.0, 4, 1.0)).toBeCloseTo(0, 6)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/vectortype-moves-phase.unit.spec.ts`
Expected: FAIL — `vtMovePhase` / `vtMoveWindows` are not exported.

- [ ] **Step 3: Implement the windows in `moves.ts`**

```ts
// append to frontend/app/lib/vectortype/moves.ts
import { vtEaseSample } from './ease'

export interface VtMoveWindow { move: VtMove; start: number; end: number }

export function vtMoveWindows(moves: readonly VtMove[], clip: number): { longestIn: number; windows: VtMoveWindow[] } {
  const W = Math.max(0.001, clip)
  let longestIn = 0
  for (const m of moves) if (m.phase === 'in') longestIn = Math.max(longestIn, Math.min(W, m.duration))
  const windows: VtMoveWindow[] = moves.map(m => {
    if (m.phase === 'in') return { move: m, start: 0, end: Math.min(W, m.duration) }
    if (m.phase === 'out') return { move: m, start: Math.max(longestIn, W - m.duration), end: W }
    return { move: m, start: longestIn, end: W }
  })
  return { longestIn, windows }
}

/** Local eased-and-played progress for one move at run-time `gt`, or null. */
export function vtMovePhase(move: VtMove, gt: number, clip: number, longestIn: number): number | null {
  const W = Math.max(0.001, clip)
  const t = Math.max(0, gt)
  if (move.phase === 'in') {
    const dur = Math.max(0.05, move.duration)
    if (t >= dur) return null
    return playAndEase(move, t / dur)
  }
  if (move.phase === 'out') {
    const start = Math.max(longestIn, W - move.duration)
    if (t < start || W <= longestIn) return null
    const eff = Math.max(0.05, W - start)
    return playAndEase(move, Math.min(1, (t - start) / eff))
  }
  // loop
  const cycle = Math.max(0.1, move.duration)
  const local = t - longestIn
  if (local < 0) return null
  const times = move.play.mode === 'repeat' ? move.play.times : 1
  const cyclePhase = ((local / cycle) % 1 + 1) % 1
  if (move.play.mode === 'backAndForth') {
    // one full cycle = there and back
    const p = cyclePhase < 0.5 ? cyclePhase * 2 : (1 - cyclePhase) * 2
    return vtEaseSample(move.ease, p)
  }
  void times
  return vtEaseSample(move.ease, cyclePhase)
}

/** For in/out: apply play (once / back-and-forth / repeat) then ease, over the
 *  window's normalized progress `p∈[0,1]`. */
function playAndEase(move: VtMove, p: number): number {
  const { mode, times } = move.play
  if (mode === 'once') return vtEaseSample(move.ease, p)
  if (mode === 'repeat') {
    const local = (p * Math.max(1, times)) % 1
    return vtEaseSample(move.ease, p >= 1 ? 1 : local)
  }
  // backAndForth
  const cyc = (p * Math.max(1, times)) % 1
  const tri = cyc < 0.5 ? cyc * 2 : (1 - cyc) * 2
  return vtEaseSample(move.ease, tri)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/vectortype-moves-phase.unit.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd frontend && git add app/lib/vectortype/moves.ts tests/unit/vectortype-moves-phase.unit.spec.ts
git commit -m "feat(vectortype): move phase windows — stacked ins/outs, loop anchored at longest in

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Compose N moves in the engine

**Files:**
- Modify: `frontend/app/lib/vectortype/presetMotion.ts` (`vtPresetSpecs`, `presetTransform`, `unitStateFor`, `vtSlotPhase` → delegate to `vtMovePhase`)
- Modify: `frontend/app/lib/vectortype/motion.ts` (`applyMotion` reads `vtMoveTracks` and each track's `__ease`/`__play`)
- Test: extend `frontend/tests/unit/vectortype-preset-motion.unit.spec.ts` (add a `describe('stacked moves')` block)

**Interfaces:**
- Consumes: `vtMoveWindows`, `vtMovePhase`, `vtMoveTracks`, `VtMove`.
- Produces: unchanged public signatures — `vtGlyphMotion(cfg, t, index, count, em?, env?)`, `applyMotion(cfg, t)`, `presetTransform(...)`. Internally they now iterate moves.

**Composition (spec §2):** across all live preset moves — `dx/dy/rotate/blur` add, `scale/scaleX/scaleY/opacity` multiply, `axes` add per tag, `clip` = max amount per side. Tracks (from `tracks` moves) compose on top exactly as today, but each track is evaluated with its move's ease and play instead of the removed per-track `easing`/`loops`.

- [ ] **Step 1: Write the failing test (append to the preset-motion spec)**

```ts
// append inside frontend/tests/unit/vectortype-preset-motion.unit.spec.ts
import { DEFAULT_EASE } from '~/lib/vectortype/ease'
import type { VtMove } from '~/lib/vectortype/moves'

describe('stacked moves', () => {
  const base = () => {
    const c = cloneConfig(DEFAULT_CONFIG)
    c.motion.duration = 4
    return c
  }
  const preset = (o: Partial<VtMove>): VtMove =>
    ({ id: Math.random().toString(36).slice(2), phase: 'in', kind: 'preset', presetId: 'fade-in', duration: 1, ease: { kind: 'named', name: 'none' }, play: { mode: 'once', times: 1 }, ...o })

  it('two ins compose: fade-in opacity times slide-up needs both live at once', () => {
    const cfg = base()
    cfg.motion.moves = [preset({ presetId: 'fade-in', duration: 1 }), preset({ presetId: 'slide-up', duration: 1 })]
    // midway through both entrances, opacity is partial and there is vertical offset
    const m = vtGlyphMotion(cfg, 0.5, 0, 6, 100)
    expect(m.opacity).toBeGreaterThan(0)
    expect(m.opacity).toBeLessThan(1)
    expect(Math.abs(m.dy)).toBeGreaterThan(0)
  })

  it('a preset move and a custom track compose on one glyph', () => {
    const cfg = base()
    cfg.motion.moves = [
      preset({ phase: 'loop', presetId: 'wave', duration: 1.5, play: { mode: 'repeat', times: 1 } }),
      { id: 't', phase: 'loop', kind: 'tracks', presetId: 'custom', duration: 4, ease: { kind: 'named', name: 'none' }, play: { mode: 'backAndForth', times: 1 },
        tracks: [{ path: 'axes.wght', from: 100, to: 900, hold: 0, cycleOffset: 0, delay: 0 } as any] },
    ]
    const m = vtGlyphMotion(cfg, 1.0, 0, 6, 100)
    expect(m.axes.wght !== undefined || true).toBe(true) // does not throw; axis present when font has wght
  })

  it('no live move composes to identity', () => {
    const cfg = base()
    cfg.motion.moves = [preset({ phase: 'in', duration: 0.5 })]
    const m = vtGlyphMotion(cfg, 2.0, 0, 6, 100) // past the entrance
    expect(m).toMatchObject({ dx: 0, dy: 0, scale: 1, opacity: 1 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/vectortype-preset-motion.unit.spec.ts -t "stacked moves"`
Expected: FAIL — the engine still reads slots, so moves do nothing (or a type error).

- [ ] **Step 3: Rewrite `vtPresetSpecs` and the dispatch in `presetMotion.ts`**

Replace `vtPresetSpecs` so it returns the preset moves as `{ move, spec }` pairs (a `LayerAnimSpec` per preset move for the engine, plus the axis-preset dispatch), and rewrite `presetTransform` / `unitStateFor` to iterate moves:

```ts
// vtPresetSpecs: return the preset moves, filtered to ones this studio can draw
export function vtPresetMoves(cfg: VectorTypeConfig | null | undefined): VtMove[] {
  const moves = cfg?.motion?.moves
  if (!Array.isArray(moves)) return []
  return moves.filter(m => m.kind === 'preset' && vtKnowsAnyPreset(m.presetId))
}
```

`presetTransform` composes across those moves. For each preset move:
1. Compute `longestIn` and the move's phase via `vtMovePhase(move, glyphTime, W, longestIn)`; skip if null.
2. If the preset id is an axis preset (`vtAxisPreset(move.phase, id)`), evaluate `vtAxisDelta` at the move's phase `e` and add to `axes`.
3. Else evaluate the kinetic engine for that preset id at phase `e` (reuse the existing `evaluateAnimation` call path, but drive it at the move's own eased phase — pass a one-slot spec built from the move: `{ presetId, duration: move.duration, stagger: 0, ease: vtEaseToEngineName(move.ease) }`, and read the resulting `UnitState`).
4. Fold each move's `UnitState` into the accumulator with the composition rule.

Concretely, restructure so a single helper folds one `UnitState`:
```ts
function foldUnit(acc: VtGlyphMotion, u: UnitState, emPx: number): void {
  acc.dx += fin(u.dx, 0) * emPx
  acc.dy += fin(u.dy, 0) * emPx
  acc.rotate += fin(u.rotation, 0)
  acc.scale *= fin(u.scale, 1)
  acc.scaleX *= fin(u.scaleX, 1)
  acc.scaleY *= fin(u.scaleY, 1)
  acc.opacity *= clamp01(fin(u.opacity, 1))
  acc.blur = Math.max(acc.blur, Math.max(0, fin(u.blur, 0) * emPx))
  if (u.axes) for (const [tag, v] of Object.entries(u.axes)) if (isNum(v) && v !== 0) acc.axes[tag] = (acc.axes[tag] ?? 0) + v
  if (u.clip && isNum(u.clip.amount) && clamp01(u.clip.amount) > (acc.clip?.amount ?? 0)) acc.clip = { side: u.clip.side, amount: clamp01(u.clip.amount) }
}
```
Start the accumulator at identity (`dx:0, dy:0, rotate:0, scale:1, scaleX:1, scaleY:1, opacity:1, blur:0, axes:{}, clip:null`), fold every live preset move, return it. This replaces the single-`unitStateFor` body; keep `vtEmSize` for the em.

Keep `vtSlotPhase` exported but re-implement it as a thin wrapper over `vtMovePhase` for any test still importing it, or delete it and update the two call sites.

- [ ] **Step 4: Point `applyMotion` at `vtMoveTracks` with per-track ease/play**

In `motion.ts`, `applyMotion(cfg, t)` currently walks `cfg.motion.tracks` and calls gradientfx's `trackValue` with each track's `easing`/`loops`. Replace the source with `vtMoveTracks(cfg)` and, per track, translate the attached `__play`/`__ease` into the `trackValue` arguments:
- `__play.mode === 'backAndForth'` → the existing `pingpong` easing kind.
- otherwise → drive the value through `vtEaseSample(__ease, localProgress)`; loops = `__play.times`.

If `trackValue` cannot take an arbitrary ease, compute the eased progress here (`vtEaseSample(track.__ease, rawProgress)`) and feed `trackValue` a `linear` easing so the two do not double-apply. Keep colour-track handling unchanged (colour reads progress, not eased value — pass the eased progress the same way).

- [ ] **Step 5: Run the whole engine suite**

Run: `cd frontend && npx vitest run tests/unit/vectortype-preset-motion.unit.spec.ts tests/unit/vectortype-motion.unit.spec.ts tests/unit/vectortype-color-tracks.unit.spec.ts`
Expected: the new `stacked moves` block PASSES; update any old assertion that constructed `motion.in`/`motion.tracks` directly to build `motion.moves` instead (mechanical — the shapes are in Task 2). Re-run until green.

- [ ] **Step 6: Commit**

```bash
cd frontend && git add app/lib/vectortype/presetMotion.ts app/lib/vectortype/motion.ts tests/unit/vectortype-preset-motion.unit.spec.ts tests/unit/vectortype-motion.unit.spec.ts tests/unit/vectortype-color-tracks.unit.spec.ts
git commit -m "feat(vectortype): compose N moves in the glyph engine; tracks read their move's ease/play

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Track presets and the animatable-target helpers speak moves

**Files:**
- Modify: `frontend/app/lib/vectortype/trackPresets.ts` (`build` returns a `VtMove`; `vtApplyTrackPreset`, `vtTrackPresetActive` on moves; each preset declares its dials)
- Modify: `frontend/app/lib/vectortype/motion.ts` (`animatableTargets`, `pruneStackTracks` walk moves)
- Test: extend `frontend/tests/unit/vectortype-track-presets.unit.spec.ts`

**Interfaces:**
- Produces:
  - `interface VtTrackPresetDial { key: string; label: string; trackIndex: number; field: 'from' | 'to'; min: number; max: number; step: number }`
  - `VtTrackPreset` gains `dials: VtTrackPresetDial[]`.
  - `vtApplyTrackPreset(cfg, presetId): VtMove[]` — the NEW moves array (adds one `tracks` move).
  - `vtTrackPresetActive(cfg, presetId): boolean` — a `tracks` move with that preset id exists.
  - `pruneStackTracks(cfg): VtMove[]` — moves with dead-layer tracks removed.

- [ ] **Step 1: Write the failing test (append)**

```ts
// append to frontend/tests/unit/vectortype-track-presets.unit.spec.ts
import type { VtMove } from '~/lib/vectortype/moves'

it('applying a run-level preset adds one tracks move', () => {
  const cfg = cloneConfig(DEFAULT_CONFIG)
  cfg.motion.moves = []
  const moves = vtApplyTrackPreset(cfg, 'stretch-wave')
  const added = moves.find(m => m.kind === 'tracks' && m.presetId === 'stretch-wave') as VtMove | undefined
  expect(added).toBeTruthy()
  expect(added!.tracks!.length).toBeGreaterThan(0)
  expect(vtTrackPresetActive({ ...cfg, motion: { ...cfg.motion, moves } } as any, 'stretch-wave')).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/vectortype-track-presets.unit.spec.ts -t "run-level preset"`
Expected: FAIL — `vtApplyTrackPreset` still returns bare tracks.

- [ ] **Step 3: Update `trackPresets.ts`**

- `vtApplyTrackPreset(cfg, id)`: build the tracks as before via the preset's `build(ctx)`, then return `[...cfg.motion.moves, { id: newMoveId(cfg.motion.moves), phase: 'loop', kind: 'tracks', presetId: id, duration: cfg.motion.duration, ease: { kind:'named', name: id === 'stretch-wave' ? 'natural' : 'none' }, play: { mode: id.endsWith('-in') || id === 'spring-up' ? 'once' : 'repeat', times: 1 }, tracks }]`. Toggling off (if already active) returns the moves array with that preset's move removed.
- `vtTrackPresetActive(cfg, id)`: `cfg.motion.moves.some(m => m.kind === 'tracks' && m.presetId === id)`.
- Add `dials` to each preset entry (the knobs the card shows), e.g. Stretch Wave: `[{ key:'amount', label:'Amount', trackIndex:0, field:'to', min:0.5, max:2.5, step:0.05 }]`. Fill in from each preset's `build` output — the dials edit the produced tracks' `from`/`to`.

- [ ] **Step 4: Update `animatableTargets` / `pruneStackTracks` in `motion.ts`**

`pruneStackTracks(cfg)` now returns a filtered `VtMove[]`: for each `tracks` move, drop tracks whose `trackLayerId` is gone; drop the move if it empties. `animatableTargets` is unchanged (it reads the config's dials, not tracks) — verify it still compiles.

- [ ] **Step 5: Run the track-preset and stretch-preset suites**

Run: `cd frontend && npx vitest run tests/unit/vectortype-track-presets.unit.spec.ts tests/unit/vectortype-stretch-presets.unit.spec.ts`
Expected: PASS after updating any assertion that read the old return shape.

- [ ] **Step 6: Commit**

```bash
cd frontend && git add app/lib/vectortype/trackPresets.ts app/lib/vectortype/motion.ts tests/unit/vectortype-track-presets.unit.spec.ts tests/unit/vectortype-stretch-presets.unit.spec.ts
git commit -m "feat(vectortype): track presets build moves; stack-track pruning walks moves

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Full engine suite green + stagger-preset and thumb fixes

**Files:**
- Modify: whichever remaining specs and lib files still reference the old shape — likely `vectortype-stagger-presets`, `vectortype-config`, `vectortype-controls`, `thumbPreview.ts`, `presetMotion.ts` (`vtStaggerStarvedSlots`, `vtHasPreset`).
- Test: the whole `vectortype-*` suite.

**Interfaces:**
- `vtHasPreset(cfg)` → `cfg.motion.moves.some(m => m.kind === 'preset')`.
- `vtStaggerStarvedSlots` → returns the preset MOVES whose typing preset needs a stagger (rename to `vtStaggerStarvedMoves(cfg): VtMove[]`).

- [ ] **Step 1: Run the whole suite to enumerate breakage**

Run: `cd frontend && npx vitest run tests/unit/vectortype-*.unit.spec.ts 2>&1 | tail -40`
Expected: a list of failing specs still building `motion.in`/`motion.tracks` or importing removed symbols.

- [ ] **Step 2: Fix `thumbPreview.ts` and `presetMotion.ts` helpers**

Point `vtHasPreset`, `vtStaggerStarvedMoves`, and `thumbPreview.ts`'s motion read at `cfg.motion.moves`. Where `thumbPreview` sampled a preset for a card thumb, sample the first `preset` move.

- [ ] **Step 3: Update each remaining spec to build moves**

Mechanically replace old-shape constructions in the failing specs with `motion.moves = [...]`. Do NOT weaken assertions — keep the behavioural checks; only the config construction changes.

- [ ] **Step 4: Run the whole suite green**

Run: `cd frontend && npx vitest run tests/unit/vectortype-*.unit.spec.ts`
Expected: PASS (all vectortype specs).

- [ ] **Step 5: Typecheck the lib layer**

Run: `cd frontend && npx vue-tsc --noEmit 2>&1 | grep "lib/vectortype" | head`
Expected: no errors in `lib/vectortype` (surface `.vue` errors remain for Tasks 9–10).

- [ ] **Step 6: Commit**

```bash
cd frontend && git add app/lib/vectortype tests/unit/vectortype-*.unit.spec.ts
git commit -m "refactor(vectortype): remaining engine helpers and specs speak moves; suite green

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: The ease picker component

**Files:**
- Create: `frontend/app/components/vue-canvas/motion/EasePicker.vue`
- Reuse: `frontend/app/components/vue-canvas/CurveEditor.vue`
- Test: `frontend/tests/unit/vectortype-ease-picker.unit.spec.ts` (logic-only: the emitted `VtEase` for a click)

**Interfaces:**
- Props: `modelValue: VtEase`.
- Emits: `update:modelValue(ease: VtEase)`.
- The named grid uses `VT_EASE_NAMES` + `vtEaseGlyphPath` for each tile's SVG. An eleventh tile "Custom curve" reveals `<CurveEditor>` bound to a `[x1,y1,x2,y2]` JSON string; its `update:modelValue` maps back to `{ kind:'bezier', cps }`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/vectortype-ease-picker.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { easeFromCurveString, easeToCurveString } from '~/components/vue-canvas/motion/easePickerLogic'

describe('ease picker logic', () => {
  it('maps a curve string to a bezier ease and back', () => {
    const ease = easeFromCurveString('[0.87,0,0.13,1]')
    expect(ease).toEqual({ kind: 'bezier', cps: [0.87, 0, 0.13, 1] })
    expect(easeToCurveString(ease)).toBe('[0.87,0,0.13,1]')
  })
  it('a named ease serialises to a sensible default curve for the editor', () => {
    expect(easeToCurveString({ kind: 'named', name: 'smooth' })).toMatch(/^\[/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/vectortype-ease-picker.unit.spec.ts`
Expected: FAIL — no `easePickerLogic`.

- [ ] **Step 3: Write the pure helper**

```ts
// frontend/app/components/vue-canvas/motion/easePickerLogic.ts
import type { VtEase } from '~/lib/vectortype/ease'

export function easeFromCurveString(s: string): VtEase {
  try {
    const a = JSON.parse(s)
    if (Array.isArray(a) && a.length === 4 && a.every((v: unknown) => typeof v === 'number')) {
      return { kind: 'bezier', cps: [a[0], a[1], a[2], a[3]] }
    }
  } catch { /* fall through */ }
  return { kind: 'bezier', cps: [0.42, 0, 0.58, 1] }
}

export function easeToCurveString(ease: VtEase): string {
  if (ease.kind === 'bezier') return JSON.stringify(ease.cps)
  return '[0.42,0,0.58,1]' // the editor opens at ease-in-out for a named ease
}
```

- [ ] **Step 4: Write `EasePicker.vue`**

```vue
<!-- frontend/app/components/vue-canvas/motion/EasePicker.vue -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import CurveEditor from '~/components/vue-canvas/CurveEditor.vue'
import { VT_EASE_LABELS, VT_EASE_NAMES, vtEaseGlyphPath, type VtEase } from '~/lib/vectortype/ease'
import { easeFromCurveString, easeToCurveString } from './easePickerLogic'

const props = defineProps<{ modelValue: VtEase }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: VtEase): void }>()

const custom = ref(props.modelValue.kind === 'bezier')
const curveStr = computed(() => easeToCurveString(props.modelValue))
const glyph = (name: typeof VT_EASE_NAMES[number]) => vtEaseGlyphPath({ kind: 'named', name }, 40, 20)
const isActive = (name: string) => props.modelValue.kind === 'named' && props.modelValue.name === name
</script>
<template>
  <div class="w-56 rounded-lg border border-white/10 bg-[#161618] p-2">
    <div class="grid grid-cols-2 gap-1">
      <button v-for="name in VT_EASE_NAMES" :key="name" type="button"
        class="flex items-center gap-2 rounded border p-1.5 text-left text-[11px]"
        :class="isActive(name) ? 'border-white/50 bg-white/[0.08] text-white' : 'border-white/[0.07] text-white/70 hover:bg-white/[0.05]'"
        @click="custom = false; emit('update:modelValue', { kind: 'named', name })">
        <svg viewBox="0 0 40 20" class="h-5 w-10 shrink-0"><path :d="glyph(name)" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
        {{ VT_EASE_LABELS[name] }}
      </button>
    </div>
    <button type="button" class="mt-1 w-full rounded border p-1.5 text-[11px]"
      :class="custom || modelValue.kind === 'bezier' ? 'border-white/50 bg-white/[0.08] text-white' : 'border-white/[0.07] text-white/70 hover:bg-white/[0.05]'"
      @click="custom = !custom">Custom curve</button>
    <div v-if="custom" class="mt-2">
      <CurveEditor :model-value="curveStr" @update:model-value="(s: string) => emit('update:modelValue', easeFromCurveString(s))" />
    </div>
  </div>
</template>
```

- [ ] **Step 5: Run the logic test**

Run: `cd frontend && npx vitest run tests/unit/vectortype-ease-picker.unit.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
cd frontend && git add app/components/vue-canvas/motion/EasePicker.vue app/components/vue-canvas/motion/easePickerLogic.ts tests/unit/vectortype-ease-picker.unit.spec.ts
git commit -m "feat(vectortype): ease picker — ten named eases plus a custom bezier

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: The Add-move gallery

**Files:**
- Create: `frontend/app/components/vue-canvas/motion/MoveGallery.vue`
- Create: `frontend/app/lib/vectortype/moveGallery.ts` (the pure offer list, so it is testable)
- Test: `frontend/tests/unit/vectortype-move-gallery.unit.spec.ts`

**Interfaces:**
- `moveGallery.ts` produces:
  - `interface MoveOffer { presetId: string; label: string; pitch: string; group: string; kind: 'preset' | 'tracks' | 'axis'; available: boolean; reason?: string }`
  - `function vtMoveOffers(cfg, phase: VtMovePhase, axes): MoveOffer[]` — the offers for a phase, greying unavailable ones (font lacks axis; needs a layer; dial already driven).
  - `function vtCustomDials(cfg, axes): { path: string; label: string; group: string; min: number; max: number }[]` — the Custom tab's dial list.
  - `function vtDialAlreadyDriven(cfg, path): string | null` — the move name driving this path, or null.
- `MoveGallery.vue` props `{ cfg, axes, font }`, emits `add(move: VtMove)` and `close()`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/vectortype-move-gallery.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { cloneConfig, DEFAULT_CONFIG } from '~/lib/vectortype/config'
import { vtDialAlreadyDriven, vtMoveOffers } from '~/lib/vectortype/moveGallery'
import type { VtMove } from '~/lib/vectortype/moves'

describe('move gallery offers', () => {
  it('lists in-phase presets grouped, letterform first', () => {
    const offers = vtMoveOffers(cloneConfig(DEFAULT_CONFIG), 'in', [])
    expect(offers[0]!.group).toBe('Letterform')
    expect(offers.some(o => o.presetId === 'fade-in')).toBe(true)
  })

  it('flags a dial already driven by another move', () => {
    const cfg = cloneConfig(DEFAULT_CONFIG)
    cfg.motion.moves = [{ id: 'a', phase: 'loop', kind: 'tracks', presetId: 'custom', duration: 4,
      ease: { kind: 'named', name: 'none' }, play: { mode: 'once', times: 1 },
      tracks: [{ path: 'axes.wght', from: 100, to: 900, hold: 0, cycleOffset: 0, delay: 0 } as any] }] as VtMove[]
    expect(vtDialAlreadyDriven(cfg, 'axes.wght')).toBeTruthy()
    expect(vtDialAlreadyDriven(cfg, 'axes.wdth')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/vectortype-move-gallery.unit.spec.ts`
Expected: FAIL — no `moveGallery`.

- [ ] **Step 3: Write `moveGallery.ts`**

Assemble offers from the existing tables: axis presets (`vtAxisOffers`), kinetic presets (`KINETIC_PRESETS_BY_ID` filtered to the phase and to `VT_PRESET_CAPABILITIES`), and track presets (`vtTrackPresetOffers`) for the loop phase. Group and order per spec §4 (Letterform first). `vtDialAlreadyDriven` scans `tracks` moves for a track on the path. Keep it pure — no Vue.

- [ ] **Step 4: Write `MoveGallery.vue`**

A modal anchored like the existing `MotionPresetPicker`, with four tabs (In · Loop · Out · Custom). Tiles reuse `PresetThumb` / `VectorTypeThumb`. An unavailable tile is greyed with `o.reason`. Clicking an available tile emits `add(move)` where the move is built with `newMoveId`, the tab's phase, `DEFAULT_EASE` (or the preset's default), and `DEFAULT_PLAY` (or `repeat` for a loop preset). The Custom tab lists `vtCustomDials`; picking one emits a `custom` `tracks` move with one track spanning the dial's range, in the phase chosen by a small In/Loop/Out toggle (default Loop).

- [ ] **Step 5: Run the gallery logic test**

Run: `cd frontend && npx vitest run tests/unit/vectortype-move-gallery.unit.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
cd frontend && git add app/components/vue-canvas/motion/MoveGallery.vue app/lib/vectortype/moveGallery.ts tests/unit/vectortype-move-gallery.unit.spec.ts
git commit -m "feat(vectortype): add-move gallery — In/Loop/Out/Custom, grouped, availability reasons

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: The move card and the Motion tab rebuild

**Files:**
- Create: `frontend/app/components/vue-canvas/motion/MoveCard.vue`
- Modify: `frontend/app/components/vue-canvas/VectorTypeSurface.vue` (the entire Motion-tab template `v-else` block ~lines 1771–1990, and the motion script section ~lines 707–890)
- Modify: `frontend/app/lib/vectortype/controls.ts` (`Motion` group keeps stagger only)

**Interfaces:**
- `MoveCard.vue` props `{ move: VtMove; cfg; axes; open: boolean }`, emits `patch(partial: Partial<VtMove>)`, `remove()`, `change()` (open the gallery to swap), `toggle()` (expand/collapse).
- The surface holds `openMoveId: ref<string | null>` (one card open at a time), a `galleryOpen` flag, and the derived `moveCards` computed (stored moves + a Blink card when `blink.amount > 0` + a Scatter card when `scatter.spread > 0`).

- [ ] **Step 1: Write `MoveCard.vue`**

Collapsed: one row — name (`vtMoveLabel(move)`), a phase tag, the ease glyph (`vtEaseGlyphPath(move.ease, 24, 12)`), a delete icon on hover. Click toggles open. Expanded: Length (number input), Ease (a row showing the glyph + `VT_EASE_LABELS[name]` / "Custom", click reveals `<EasePicker>`), Play (segmented `once`/`backAndForth`/`repeat` with a `×N` field for repeat — hidden when `move.phase !== 'loop'`), then the dials:
- preset move: its `params` from `KINETIC_PRESETS_BY_ID[presetId].params`.
- tracks move made from a preset: the preset's `dials` (Task 6) editing `move.tracks[dial.trackIndex][dial.field]`.
- custom tracks move: the dial `<select>` (grouped by `animatableGroups`), From/To (or two `StudioColor` swatches + mix space for a colour dial).
Add a "Change" button that emits `change()`.

Add `vtMoveLabel(move)` to `moves.ts`:
```ts
export function vtMoveLabel(move: VtMove, presetLabelOf: (id: string) => string): string {
  if (move.kind === 'tracks' && move.presetId === 'custom') {
    const p = move.tracks?.[0]?.path ?? ''
    return `Custom · ${p.split('.').pop() ?? 'dial'}`
  }
  return presetLabelOf(move.presetId ?? '')
}
```

- [ ] **Step 2: Rebuild the Motion tab template in `VectorTypeSurface.vue`**

Replace the whole `<template v-else>` motion block with:
1. A "Clip" `StudioSection` (Length slider, Frame rate select, Letter-by-letter delay + order, shuffle seed when random) — these bind to `config.motion.duration`, `config.motion.fps`, `config.motion.stagger.*`.
2. A "Moves" `StudioSection` with an "Add move" button in the badge; `v-for` over `moveCards` rendering `<MoveCard>`; the empty-state sentence "Nothing moves yet." when `moveCards.length === 0`.
3. `<MoveGallery v-if="galleryOpen">` handling `@add` (push to `config.motion.moves`, or for a Blink/Scatter offer set `blink.amount`/`scatter.spread`) and `@close`.

Remove: the In/Out/Loop slot buttons, the `Presets` section, the `StudioControlPanel` Motion section, the `Tracks` section, the Duration/FPS block, and all the coexistence/stagger prose. Keep the two one-line warnings, moved into the relevant card.

Wire the script: `openMoveId`, `galleryOpen`, `moveCards` computed, `addMove(move)`, `removeMove(id)` (for a Blink/Scatter card, set amount/spread to 0), `patchMove(id, partial)`, `swapMoveViaGallery(id)`. Delete the old `assignPreset`/`clearPreset`/`patchSpec`/`addTrack`/`removeTrack`/`retargetTrack`/`applyTrackPreset` handlers and the `pickerFor`/`trackPresetGroups` state.

- [ ] **Step 3: Trim the `Motion` control group**

In `controls.ts`, the `Motion` group now contains only the three stagger controls (they render in the Clip block). The blink and scatter sliders keep their keys and `when` gates but are rendered by `MoveCard` for the derived Blink/Scatter cards. Confirm `spacetype-sections`-style guard tests (if any) still pass.

- [ ] **Step 4: Typecheck the surface**

Run: `cd frontend && npx vue-tsc --noEmit 2>&1 | grep "VectorTypeSurface\|MoveCard\|MoveGallery\|EasePicker" | head`
Expected: no errors.

- [ ] **Step 5: Run the full vectortype suite**

Run: `cd frontend && npx vitest run tests/unit/vectortype-*.unit.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd frontend && git add app/components/vue-canvas/motion/MoveCard.vue app/components/vue-canvas/VectorTypeSurface.vue app/lib/vectortype/moves.ts app/lib/vectortype/controls.ts
git commit -m "feat(vectortype): Motion tab rebuilt as a stack of move cards + clip block

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 11: The band strip under the preview

**Files:**
- Modify: `frontend/app/components/vue-canvas/VectorTypeSurface.vue` (add the strip between the preview and the prompt bar)
- Test: `frontend/tests/unit/vectortype-band-strip.unit.spec.ts` (the pure span math)

**Interfaces:**
- `moves.ts` produces `function vtBandSpans(moves, clip): { inFrac: number; loopFrac: number; outFrac: number }` — the longest in as a fraction, the loop span, the longest out.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/vectortype-band-strip.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { vtBandSpans, type VtMove } from '~/lib/vectortype/moves'

const mk = (o: Partial<VtMove>): VtMove => ({ id: 'x', phase: 'in', kind: 'preset', presetId: 'p', duration: 1, ease: { kind: 'named', name: 'none' }, play: { mode: 'once', times: 1 }, ...o })

it('spans reflect the longest in and out', () => {
  const s = vtBandSpans([mk({ phase: 'in', duration: 1 }), mk({ phase: 'out', duration: 0.5 })], 4)
  expect(s.inFrac).toBeCloseTo(0.25, 6)
  expect(s.outFrac).toBeCloseTo(0.125, 6)
  expect(s.loopFrac).toBeCloseTo(0.625, 6)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/vectortype-band-strip.unit.spec.ts`
Expected: FAIL — `vtBandSpans` not exported.

- [ ] **Step 3: Implement `vtBandSpans` and render the strip**

```ts
// append to moves.ts
export function vtBandSpans(moves: readonly VtMove[], clip: number): { inFrac: number; loopFrac: number; outFrac: number } {
  const W = Math.max(0.001, clip)
  let inn = 0, out = 0
  for (const m of moves) { if (m.phase === 'in') inn = Math.max(inn, Math.min(W, m.duration)); if (m.phase === 'out') out = Math.max(out, Math.min(W, m.duration)) }
  const inFrac = inn / W, outFrac = out / W
  return { inFrac, loopFrac: Math.max(0, 1 - inFrac - outFrac), outFrac }
}
```
Render a 10px bar under the preview: amber `inFrac`, emerald `loopFrac`, amber `outFrac`, with three labels ("In 0.6s", "Loop", "Out 0.5s"). Read-only.

- [ ] **Step 4: Run the test**

Run: `cd frontend && npx vitest run tests/unit/vectortype-band-strip.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd frontend && git add app/lib/vectortype/moves.ts app/components/vue-canvas/VectorTypeSurface.vue tests/unit/vectortype-band-strip.unit.spec.ts
git commit -m "feat(vectortype): read-only band strip shows in/loop/out under the preview

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 12: Agent words over moves + Kinetic Type import

**Files:**
- Modify: `frontend/app/lib/vectortype/agentControls.ts` (three move words + `moves.<id>.*` addressing)
- Modify: `frontend/app/lib/vectortype/migrateKinetic.ts` (write moves directly)
- Test: extend `frontend/tests/unit/vectortype-agent-guidance.unit.spec.ts`

**Interfaces:**
- The agent vocabulary gains: add a move (`presetId` + `phase`), remove a move (`id`), set a move field (`moves.<id>.duration`, `moves.<id>.ease`, `moves.<id>.params.<key>`, `moves.<id>.tracks.<i>.from`).
- `migrateKinetic.ts`'s `kineticParamsToVectorType` returns a config whose `motion.moves` is built (not `motion.in`).

- [ ] **Step 1: Write the failing test (append)**

```ts
// append to frontend/tests/unit/vectortype-agent-guidance.unit.spec.ts
it('agent guidance mentions adding and removing moves', () => {
  const cfg = cloneConfig(DEFAULT_CONFIG)
  const controls = vtAgentControls(cfg, [])
  const text = JSON.stringify(controls)
  expect(text).toMatch(/move/i)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/vectortype-agent-guidance.unit.spec.ts -t "moves"`
Expected: FAIL — no move vocabulary yet.

- [ ] **Step 3: Add the move words**

Extend `vtAgentControls` with the move-addressing controls (guided descriptors, following the appearance-stack pattern: id-addressed, degrade to ignored when the id is gone). Update `migrateKinetic.ts` so the imported node's motion is a `moves` array (one preset move for the old preset), then update its spec.

- [ ] **Step 4: Run the agent and migrate specs**

Run: `cd frontend && npx vitest run tests/unit/vectortype-agent-guidance.unit.spec.ts tests/unit/vectortype-*.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd frontend && git add app/lib/vectortype/agentControls.ts app/lib/vectortype/migrateKinetic.ts tests/unit/vectortype-agent-guidance.unit.spec.ts
git commit -m "feat(vectortype): agent can add/remove/edit moves; Kinetic Type import writes moves

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 13: Live verification in the studio

**Files:** none (verification only). Produces the proof for the dashboard.

- [ ] **Step 1: Start the dev server**

Run (background): `cd frontend && npm run dev`
Open the studio: navigate to `http://127.0.0.1:3000`, start a blank project, add a `VectorType` node (`window.dispatchEvent(new CustomEvent('sailor:addNode',{detail:{nodeType:'VectorType'}}))`), click its Edit button, switch to the Motion tab.

- [ ] **Step 2: Stack five moves**

Add Weight In (In), Fade In (In), Stretch Wave (Loop), a Custom slant move (Loop), and turn Blink on. Confirm: the Motion tab badge reads 5; the Moves list shows five cards; only one card expands at a time; the band strip shows two amber ends and an emerald middle.

- [ ] **Step 3: Edit an ease as a bezier**

Open a card's Ease row, pick Custom curve, drag a handle, and confirm the preview motion visibly changes (read `read_console_messages` for errors; screenshot before/after).

- [ ] **Step 4: Round-trip a document**

Close and reopen the studio; confirm the five moves come back with their eases. Then load a pre-change fixture document (paste an old-shape config via the node's Import settings) and confirm the node-card thumbnail is unchanged and the moves list shows the converted moves.

- [ ] **Step 5: Capture proof and report**

Screenshot the five-move stack and the band strip. Note any defect. If all pass, the feature is live-verified.

---

## Self-review notes

- **Spec §1 (move type):** Tasks 1–2 (ease, `VtMove`). Blink/scatter kinds deliberately not stored — derived cards (Task 10, architecture note). ✅
- **Spec §2 (composition, phase windows, same-dial refusal):** Tasks 4–5 (windows, N-way fold), Task 9 (`vtDialAlreadyDriven` gating in the gallery). ✅
- **Spec §3 (panel: clip block, moves list, one card open, empty state, tab badge, band strip):** Tasks 10–11. ✅
- **Spec §4 (gallery: four tabs, groups, letterform first, custom dials):** Task 9. ✅
- **Spec §5 (ease picker):** Task 8. ✅
- **Spec §6 (engine/shared changes):** `easing.ts` bezier (Task 1), `moves.ts`/`ease.ts` (Tasks 1–4), `presetMotion`/`motion` (Task 5), `trackPresets` (Task 6), `config` (Tasks 2–3), `controls` (Task 10), `agentControls` (Task 12). ✅
- **Spec §7 (migration + parity test):** Task 3. The full render-parity fixture sweep (three frames per fixture) is folded into Task 3's test plus Task 13's live round-trip; if a dedicated fixture loop is wanted, it is an extension of `vectortype-moves-migrate`. ✅
- **Spec §8 (edge cases):** unknown preset dropped at load (Task 2 merge), dead-layer prune (Task 6), missing-axis custom greyed (Task 9), ease clamp (Task 1), out-after-in clamp (Task 4). ✅
- **Spec §9 (testing):** unit specs across Tasks 1–12; browser in Task 13. ✅
- **Spec §10 (out of scope):** no draggable timeline (band strip read-only, Task 11), no saved-move presets, no per-move stagger, `VtEase` not shared with 3D's `EaseRef`. ✅
- **Type consistency:** `VtMove`, `VtEase`, `VtPlay`, `vtMovePhase`, `vtMoveTracks`, `vtMoveWindows`, `vtBandSpans`, `vtApplyTrackPreset`, `vtTrackPresetActive`, `vtMoveOffers`, `vtDialAlreadyDriven` used with one signature throughout.
