# Space Type "Pile" effect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Space Type effect, **Pile**, in which words, letters, and library shapes fall under gravity and settle into a heap — physics simulated once and baked into a trajectory that `update(t01)` plays back.

**Architecture:** A pure token *planner* turns params into a deterministic list of rectangular token specs (world-unit extents + kind + fill index). A pure physics *baker* drops those rectangles into a Matter.js world, steps to rest, and records an `{x, y, angle}` trajectory of fixed length. The `pile` effect module renders each spec to a textured mesh (+ optional box), calls the baker in `buildScene`, and in `update(t01)` samples the trajectory. Physics runs only at build time; nothing physics-related is on the render hot path.

**Tech Stack:** Nuxt 4 / Vue 3 / TypeScript, three.js (existing Space Type engine), **matter-js** (new, offline 2D rigid-body baker), seeded RNG from `lib/spacetype/rng.ts`.

## Global Constraints

- Frontend is Nuxt 4 + Vue 3 + TypeScript under `frontend/`; package manager is **pnpm** (see `frontend/pnpm-lock.yaml`).
- **UI copy:** sentence case, no internal identifiers in labels/hints; every `select` whose `options` are internal values MUST carry positionally-paired `optionLabels`. (memory: ui-copy-sentence-case-no-identifiers)
- **Determinism:** all randomness comes from `mulberry32(hashSeed(...))` (`lib/spacetype/rng.ts`). No `Math.random`, no wall-clock, no variable physics timestep. Same params ⇒ identical token list and identical trajectory.
- **Shared checkout / commits:** the controller commits each task with a **private git index seeded from `git read-tree HEAD`** (NEVER `cp .git/index`), staging only the task's exact paths, verifying with `git diff --cached --name-only` before commit. (memory: private-git-index-is-the-fix-for-shared-staging)
- **Never run `npm run dev` / a dev server from a subagent** — it kills the shared `:3002`. Live checks use the harness in a controlled way only when the controller runs them. (memory: frame-drag-to-generate-landed)
- Commit-message trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Space Type effect contract (`lib/spacetype/effect.ts`): `buildScene(three, params, textTexture, env?) => THREE.Object3D`, `update(t01, params, root?) => void`, optional `liveKeys`. `GLOBAL_LIVE_KEYS = ['speed','scale','rotateX','rotateY','rotateZ']` are already live (engine applies scale/rotate globally), so Pile omits `liveKeys` — every Pile param is structural (rebuild + re-bake).

## File Structure

- Create `frontend/app/lib/spacetype/pile/tokens.ts` — pure token planner (`planPileTokens`). No canvas, no three, no matter. Fully unit-testable.
- Create `frontend/app/lib/spacetype/pile/physics.ts` — pure Matter.js baker (`bakePile`). Numbers in, trajectory out. Unit-testable in node.
- Create `frontend/app/lib/spacetype/pile/render.ts` — `renderTokenTexture(three, spec, fill)` (canvas when available, fallback `DataTexture` headless) and box/mesh helpers. Browser-drawing; headless-safe.
- Create `frontend/app/lib/spacetype/effects/pile.ts` — the `SpaceTypeEffect` (controls, `buildScene`, `update`).
- Modify `frontend/app/lib/spacetype/effects/index.ts` — register `pileEffect`.
- Modify `frontend/app/lib/spacetype/effect.ts:142` — add `'pile'` to `RAW_WORD_EFFECTS` (separator-ineligible).
- Modify `frontend/package.json` / `frontend/pnpm-lock.yaml` — add `matter-js` + `@types/matter-js`.
- Tests: `frontend/tests/unit/spacetype-pile-tokens.unit.spec.ts`, `frontend/tests/unit/spacetype-pile-physics.unit.spec.ts`, `frontend/tests/unit/spacetype-pile-effect.unit.spec.ts`, `frontend/tests/unit/spacetype-pile-matter-smoke.unit.spec.ts`.

---

### Task 1: Add the matter-js dependency (proven deterministic)

**Files:**
- Modify: `frontend/package.json`, `frontend/pnpm-lock.yaml`
- Test: `frontend/tests/unit/spacetype-pile-matter-smoke.unit.spec.ts`

**Interfaces:**
- Produces: a working `matter-js` import — `import { Engine, Bodies, Composite, Body } from 'matter-js'` — usable by later tasks.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/spacetype-pile-matter-smoke.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { Engine, Bodies, Composite, Body } from 'matter-js'

// A body dropped from rest onto a static floor lands, and does so IDENTICALLY
// across two runs with a fixed timestep — the determinism the bake relies on.
function dropOnce(): { y: number; angle: number } {
  const engine = Engine.create()
  engine.gravity.y = -1 // world is y-UP; gravity pulls toward -y
  const floor = Bodies.rectangle(0, -50, 400, 10, { isStatic: true })
  const box = Bodies.rectangle(0, 40, 20, 20, { restitution: 0.1, friction: 0.3 })
  Composite.add(engine.world, [floor, box])
  for (let i = 0; i < 600; i++) Engine.update(engine, 1000 / 60)
  return { y: box.position.y, angle: box.angle }
}

describe('matter-js smoke', () => {
  it('a dropped box settles above the floor', () => {
    const { y } = dropOnce()
    expect(y).toBeGreaterThan(-50) // came to rest on top of the floor, not through it
    expect(y).toBeLessThan(40)     // and it actually fell
  })

  it('is deterministic across runs with a fixed timestep', () => {
    const a = dropOnce()
    const b = dropOnce()
    expect(b.y).toBe(a.y)
    expect(b.angle).toBe(a.angle)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/spacetype-pile-matter-smoke.unit.spec.ts`
Expected: FAIL — `Cannot find module 'matter-js'`.

- [ ] **Step 3: Install the dependency**

Run: `cd frontend && pnpm add matter-js@^0.20.0 && pnpm add -D @types/matter-js`
(If `0.20.0` is unavailable, take the latest `0.x`; pin whatever resolves.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/spacetype-pile-matter-smoke.unit.spec.ts`
Expected: PASS (both tests). If the named import throws under vitest, switch to `import Matter from 'matter-js'` and use `Matter.Engine` etc.; keep whichever import style passes and use it consistently in later tasks.

- [ ] **Step 5: Commit**

```bash
# controller: private index seeded from HEAD, stage ONLY these paths
git add frontend/package.json frontend/pnpm-lock.yaml frontend/tests/unit/spacetype-pile-matter-smoke.unit.spec.ts
git commit -m "chore(spacetype): add matter-js for the Pile physics baker

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Pure token planner (`planPileTokens`)

**Files:**
- Create: `frontend/app/lib/spacetype/pile/tokens.ts`
- Test: `frontend/tests/unit/spacetype-pile-tokens.unit.spec.ts`

**Interfaces:**
- Consumes: `mulberry32`, `hashSeed` from `~/lib/spacetype/rng`; `shapeById`, `shapeAspect` (via `~/lib/shapes/path2d`), `SHAPES` from `~/lib/shapes/catalog`.
- Produces:
  ```ts
  export interface PileTokenSpec {
    kind: 'word' | 'letter' | 'shape'
    text?: string          // word or single letter (kinds word/letter)
    shapeId?: string       // library shape id (kind shape)
    w: number              // OUTER box half-widths are w/2, h/2 — world units
    h: number
    fillIndex: number      // index into the fills list (cycled)
  }
  export function planPileTokens(params: Params, frame: { width: number; height: number }): PileTokenSpec[]
  ```
- `FRAME_HALF_H` (world half-height the camera frames) is shared with the baker; export it from `physics.ts` (Task 3) and import here. For Task 2, define token world size as `worldPerPx = (2 * FRAME_HALF_H) / frame.height` and `hWorld = typeSize * worldPerPx`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/spacetype-pile-tokens.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { planPileTokens } from '~/lib/spacetype/pile/tokens'
import { pileEffect } from '~/lib/spacetype/effects/pile'
import { defaultsFromControls } from '~/lib/spacetype/effect'

const FRAME = { width: 960, height: 540 }
function p(over: Record<string, unknown>) {
  return { ...defaultsFromControls(pileEffect.controls), ...over }
}

describe('planPileTokens', () => {
  it('words: one token per whitespace-split word', () => {
    const specs = planPileTokens(p({ text: 'MOVE FAST AND BREAK', textAs: 'words', shapeCount: 0 }), FRAME)
    expect(specs.filter(s => s.kind === 'word')).toHaveLength(4)
    expect(specs.every(s => s.kind === 'word')).toBe(true)
  })

  it('letters: one token per non-space glyph', () => {
    const specs = planPileTokens(p({ text: 'AB CD', textAs: 'letters', shapeCount: 0 }), FRAME)
    expect(specs.filter(s => s.kind === 'letter')).toHaveLength(4) // A B C D, space dropped
  })

  it('shapes are additive to text tokens', () => {
    const specs = planPileTokens(p({ text: 'HI', textAs: 'words', shapeCount: 5 }), FRAME)
    expect(specs.filter(s => s.kind === 'word')).toHaveLength(1)
    expect(specs.filter(s => s.kind === 'shape')).toHaveLength(5)
  })

  it('empty pile when text is off and no shapes', () => {
    expect(planPileTokens(p({ textAs: 'off', shapeCount: 0 }), FRAME)).toEqual([])
  })

  it('deterministic: same params -> identical extents; seed changes shape sizes', () => {
    const a = planPileTokens(p({ textAs: 'off', shapeCount: 6, seed: 1 }), FRAME)
    const b = planPileTokens(p({ textAs: 'off', shapeCount: 6, seed: 1 }), FRAME)
    const c = planPileTokens(p({ textAs: 'off', shapeCount: 6, seed: 2 }), FRAME)
    expect(b.map(s => s.w)).toEqual(a.map(s => s.w))
    expect(c.map(s => s.w)).not.toEqual(a.map(s => s.w)) // size jitter reshuffles
  })

  it('token extents are positive world units', () => {
    const specs = planPileTokens(p({ text: 'W', textAs: 'letters', shapeCount: 0, typeSize: 200 }), FRAME)
    expect(specs[0]!.w).toBeGreaterThan(0)
    expect(specs[0]!.h).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/spacetype-pile-tokens.unit.spec.ts`
Expected: FAIL — cannot find `pile/tokens` (and `effects/pile`, created in Task 5; if the import blocks the run, temporarily inline a minimal `controls` fixture, but prefer implementing Task 5's control list first if executing out of order — see note).

> Note: this test imports `pileEffect.controls` for `defaultsFromControls`. If executing strictly in order, define the control list in `effects/pile.ts` as part of Task 5. To keep Task 2 self-contained, the executor may instead build `params` from a literal defaults object here; the canonical control list lives in Task 5. Pick one and keep it consistent.

- [ ] **Step 3: Write the implementation**

```ts
// frontend/app/lib/spacetype/pile/tokens.ts
import type { Params } from '../effect'
import { mulberry32, hashSeed } from '../rng'
import { SHAPES } from '~/lib/shapes/catalog'
import { shapeAspect } from '~/lib/shapes/path2d'
import { FRAME_HALF_H } from './physics'

export interface PileTokenSpec {
  kind: 'word' | 'letter' | 'shape'
  text?: string
  shapeId?: string
  w: number
  h: number
  fillIndex: number
}

const num = (p: Params, k: string, d = 0): number => { const v = Number(p[k]); return Number.isFinite(v) ? v : d }
const str = (p: Params, k: string, d = ''): string => (p[k] == null ? d : String(p[k]))

// Rough advance width for a text string at height 1 (world), before per-glyph
// canvas measurement. Physics colliders and the fitted mesh use this same estimate,
// so text and box stay consistent even though it is approximate.
const TEXT_ADVANCE = 0.62 // avg glyph width / cap height for condensed display faces

export function planPileTokens(params: Params, frame: { width: number; height: number }): PileTokenSpec[] {
  const rng = mulberry32(hashSeed(`${str(params, 'text')}|${num(params, 'seed')}|pile`))
  const worldPerPx = (2 * FRAME_HALF_H) / Math.max(1, frame.height)
  const specs: PileTokenSpec[] = []
  let fillIndex = 0

  const textAs = str(params, 'textAs', 'words')
  const text = str(params, 'text')
  if (textAs === 'words') {
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const h = num(params, 'typeSize', 200) * worldPerPx
      const w = h * TEXT_ADVANCE * Math.max(1, word.length)
      specs.push({ kind: 'word', text: word, w, h, fillIndex: fillIndex++ })
    }
  } else if (textAs === 'letters') {
    for (const ch of [...text]) {
      if (/\s/.test(ch)) continue
      const h = num(params, 'typeSize', 200) * worldPerPx
      const w = h * TEXT_ADVANCE
      specs.push({ kind: 'letter', text: ch, w, h, fillIndex: fillIndex++ })
    }
  }

  const shapeCount = Math.max(0, Math.round(num(params, 'shapeCount')))
  if (shapeCount > 0) {
    const shapeId = str(params, 'shape', 'none')
    const chosen = shapeId && shapeId !== 'none' ? shapeId : (SHAPES[0]?.id ?? 'none')
    const shape = SHAPES.find(s => s.id === chosen)
    const aspect = shape ? shapeAspect(shape) : 1 // width / height
    const baseH = num(params, 'shapeSize', 120) * worldPerPx
    const variation = Math.min(0.95, Math.max(0, num(params, 'sizeVariation')))
    for (let i = 0; i < shapeCount; i++) {
      const jitter = 1 + (rng() * 2 - 1) * variation
      const h = baseH * jitter
      specs.push({ kind: 'shape', shapeId: chosen, w: h * aspect, h, fillIndex: fillIndex++ })
    }
  }

  return specs
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/spacetype-pile-tokens.unit.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/lib/spacetype/pile/tokens.ts frontend/tests/unit/spacetype-pile-tokens.unit.spec.ts
git commit -m "feat(spacetype): Pile token planner (words/letters/shapes, seeded)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Pure physics baker (`bakePile`)

**Files:**
- Create: `frontend/app/lib/spacetype/pile/physics.ts`
- Test: `frontend/tests/unit/spacetype-pile-physics.unit.spec.ts`

**Interfaces:**
- Consumes: `PileTokenSpec` from `./tokens`; `mulberry32`, `hashSeed` from `../rng`; matter-js (import style from Task 1).
- Produces:
  ```ts
  export const FRAME_HALF_H: number // = tan(22.5°) * 14, mirrors engine ORTHO_HALF_H
  export const PILE_SAMPLES = 160    // fixed trajectory length, fps-independent
  export interface Pose { x: number; y: number; angle: number }
  export type PileTrajectory = Pose[][] // [sampleIndex][tokenIndex]
  export function bakePile(specs: PileTokenSpec[], params: Params, frame: { width: number; height: number }): PileTrajectory
  ```
- World is y-UP; gravity is negative-y. Floor rests at `y = -FRAME_HALF_H`; side walls at `x = ±containerHalf` where `containerHalf = container * FRAME_HALF_H * (frame.width / frame.height)`. Tokens start stacked ABOVE `+FRAME_HALF_H` at seeded x within the container and seeded small angle, higher tokens arriving later (natural stagger). `mesh` transforms use these world coords directly — no sign flips.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/spacetype-pile-physics.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { bakePile, FRAME_HALF_H, PILE_SAMPLES } from '~/lib/spacetype/pile/physics'
import type { PileTokenSpec } from '~/lib/spacetype/pile/tokens'

const FRAME = { width: 960, height: 540 }
function boxes(n: number): PileTokenSpec[] {
  return Array.from({ length: n }, (_, i) => ({ kind: 'shape' as const, shapeId: 'x', w: 0.8, h: 0.8, fillIndex: i }))
}
const params = (over: Record<string, unknown> = {}) =>
  ({ container: 0.8, gravity: 1, bounciness: 0.1, dropSpread: 0.5, settleTime: 0.6, seed: 1, ...over }) as any

describe('bakePile', () => {
  it('produces a fixed-length trajectory, one pose per token per sample', () => {
    const traj = bakePile(boxes(5), params(), FRAME)
    expect(traj).toHaveLength(PILE_SAMPLES)
    expect(traj[0]).toHaveLength(5)
    expect(traj[PILE_SAMPLES - 1]).toHaveLength(5)
  })

  it('every token rests ON or ABOVE the floor at the final sample', () => {
    const traj = bakePile(boxes(8), params(), FRAME)
    const last = traj[PILE_SAMPLES - 1]!
    for (const pose of last) {
      // token centre minus half-height stays at/above the floor line (small tolerance)
      expect(pose.y - 0.4).toBeGreaterThanOrEqual(-FRAME_HALF_H - 0.15)
    }
  })

  it('tokens have descended by the final sample (they fell)', () => {
    const traj = bakePile(boxes(6), params(), FRAME)
    for (let t = 0; t < 6; t++) {
      expect(traj[PILE_SAMPLES - 1]![t]!.y).toBeLessThan(traj[0]![t]!.y)
    }
  })

  it('holds the settled pose after settleTime (last sample == settle sample)', () => {
    const traj = bakePile(boxes(4), params({ settleTime: 0.5 }), FRAME)
    const settleIdx = Math.round((PILE_SAMPLES - 1) * 0.5)
    expect(traj[PILE_SAMPLES - 1]).toEqual(traj[settleIdx])
  })

  it('deterministic: identical trajectories for identical inputs', () => {
    const a = bakePile(boxes(7), params(), FRAME)
    const b = bakePile(boxes(7), params(), FRAME)
    expect(b).toEqual(a)
  })

  it('empty specs -> empty-per-sample trajectory', () => {
    const traj = bakePile([], params(), FRAME)
    expect(traj).toHaveLength(PILE_SAMPLES)
    expect(traj[0]).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/spacetype-pile-physics.unit.spec.ts`
Expected: FAIL — cannot find `pile/physics`.

- [ ] **Step 3: Write the implementation**

```ts
// frontend/app/lib/spacetype/pile/physics.ts
import { Engine, Bodies, Composite, Body } from 'matter-js'
import type { Params } from '../effect'
import type { PileTokenSpec } from './tokens'
import { mulberry32, hashSeed } from '../rng'

// Mirrors engine.ts ORTHO_HALF_H: half-height the camera frames at z=14, FOV 45°.
export const FRAME_HALF_H = Math.tan((45 / 2) * Math.PI / 180) * 14
export const PILE_SAMPLES = 160

export interface Pose { x: number; y: number; angle: number }
export type PileTrajectory = Pose[][]

const num = (p: Params, k: string, d = 0): number => { const v = Number(p[k]); return Number.isFinite(v) ? v : d }

const WALL_T = 2            // static wall thickness (world units)
const STEPS_PER_SAMPLE = 4  // physics sub-steps recorded per trajectory sample
const DT = 1000 / 60        // fixed timestep (ms) — determinism

export function bakePile(specs: PileTokenSpec[], params: Params, frame: { width: number; height: number }): PileTrajectory {
  const rng = mulberry32(hashSeed(`${num(params, 'seed')}|bake|${specs.length}`))
  const aspect = Math.max(0.1, frame.width / Math.max(1, frame.height))
  const halfW = Math.max(0.2, num(params, 'container', 0.8)) * FRAME_HALF_H * aspect
  const floorY = -FRAME_HALF_H
  const spread = Math.min(1, Math.max(0, num(params, 'dropSpread', 0.5)))

  const engine = Engine.create()
  engine.gravity.y = -Math.max(0.05, num(params, 'gravity', 1))

  const floor = Bodies.rectangle(0, floorY - WALL_T / 2, halfW * 2 + WALL_T * 2, WALL_T, { isStatic: true, friction: 0.6 })
  const left = Bodies.rectangle(-halfW - WALL_T / 2, 0, WALL_T, FRAME_HALF_H * 6, { isStatic: true, friction: 0.4 })
  const right = Bodies.rectangle(halfW + WALL_T / 2, 0, WALL_T, FRAME_HALF_H * 6, { isStatic: true, friction: 0.4 })
  Composite.add(engine.world, [floor, left, right])

  const restitution = Math.min(0.9, Math.max(0, num(params, 'bounciness', 0.1)))
  const bodies: Body[] = specs.map((s, i) => {
    // Seeded x within the container; stacked upward so higher tokens arrive later.
    const x = (rng() * 2 - 1) * halfW * (0.2 + 0.8 * spread)
    const y = FRAME_HALF_H + 1 + i * (Math.max(s.h, 0.4) * (1.1 + spread))
    const angle = (rng() * 2 - 1) * spread * 0.6
    const b = Bodies.rectangle(x, y, Math.max(0.05, s.w), Math.max(0.05, s.h), { restitution, friction: 0.5, angle })
    return b
  })
  Composite.add(engine.world, bodies)

  const fallSamples = Math.max(1, Math.round((PILE_SAMPLES - 1) * Math.min(1, Math.max(0.05, num(params, 'settleTime', 0.6)))))
  const traj: PileTrajectory = []
  for (let i = 0; i < fallSamples; i++) {
    for (let s = 0; s < STEPS_PER_SAMPLE; s++) Engine.update(engine, DT)
    traj.push(bodies.map(b => ({ x: b.position.x, y: b.position.y, angle: b.angle })))
  }
  // Hold the settled pose for the remainder of the loop.
  const settled = traj[traj.length - 1] ?? specs.map(() => ({ x: 0, y: floorY, angle: 0 }))
  while (traj.length < PILE_SAMPLES) traj.push(settled.map(p => ({ ...p })))
  return traj
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/spacetype-pile-physics.unit.spec.ts`
Expected: PASS (6 tests). If "rests above floor" fails, raise `fallSamples` headroom by increasing `STEPS_PER_SAMPLE` and re-run; keep the value that settles boxes for the default params.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/lib/spacetype/pile/physics.ts frontend/tests/unit/spacetype-pile-physics.unit.spec.ts
git commit -m "feat(spacetype): Pile physics baker (Matter.js -> fixed-length trajectory)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Token/box render helpers (headless-safe)

**Files:**
- Create: `frontend/app/lib/spacetype/pile/render.ts`
- Test: (covered by Task 5's effect test; no standalone test — this module is a thin three.js/canvas adapter whose only testable contract is "returns a Texture headlessly", asserted via `buildScene` in Task 5.)

**Interfaces:**
- Consumes: `PileTokenSpec` from `./tokens`; `Fill` + `fillPrimary`, `fillTextColor` from `../fills`; `shapeById` from `~/lib/shapes/catalog`, `drawShape` from `~/lib/shapes/path2d`.
- Produces:
  ```ts
  export function renderTokenTexture(three: typeof THREE, spec: PileTokenSpec, fill: Fill): THREE.Texture
  export function makeTokenMesh(three: typeof THREE, spec: PileTokenSpec, fill: Fill, boxStyle: string, paddingFrac: number, radiusFrac: number): THREE.Object3D
  ```
- `makeTokenMesh` returns a `Group` positioned at the origin (the effect places it per-frame). It contains: the token plane (size `w,h` shrunk by padding) textured by `renderTokenTexture`, and for `boxStyle==='filled'` a `PlaneGeometry(w,h)` `MeshBasicMaterial({color: fillPrimary})` behind; for `'outline'` a `LineSegments(EdgesGeometry(PlaneGeometry(w,h)))`; for `'bare'` no box. Stash created textures on `mesh.userData.tex` (array) so the effect can dispose them on rebuild.

- [ ] **Step 1: Write the implementation** (no separate failing test — exercised by Task 5)

```ts
// frontend/app/lib/spacetype/pile/render.ts
import type * as THREE from 'three'
import type { PileTokenSpec } from './tokens'
import type { Fill } from '../fillTile'
import { fillPrimary, fillTextColor } from '../fills'
import { shapeById } from '~/lib/shapes/catalog'
import { drawShape } from '~/lib/shapes/path2d'

const TEX_H = 128 // token texture height in px; width follows the spec aspect

function canvasAvailable(): boolean {
  return typeof document !== 'undefined' && typeof document.createElement === 'function'
}

export function renderTokenTexture(three: typeof THREE, spec: PileTokenSpec, fill: Fill): THREE.Texture {
  if (!canvasAvailable()) {
    // Headless (unit tests): a 1x1 opaque texture keeps buildScene working without a DOM.
    const tex = new three.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, three.RGBAFormat)
    tex.needsUpdate = true
    return tex
  }
  const aspect = Math.max(0.05, spec.w / Math.max(0.05, spec.h))
  const w = Math.max(2, Math.round(TEX_H * aspect))
  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = TEX_H
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, w, TEX_H)
  if (spec.kind === 'shape' && spec.shapeId) {
    const shape = shapeById(spec.shapeId)
    if (shape) {
      ctx.fillStyle = `#${fillPrimary(three, fill).getHexString()}`
      drawShape(ctx, shape, { x: 0, y: 0, width: w, height: TEX_H, color: ctx.fillStyle })
    }
  } else if (spec.text) {
    ctx.fillStyle = `#${fillTextColor(three, fill).getHexString()}`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.font = `700 ${Math.round(TEX_H * 0.8)}px Anton, system-ui, sans-serif`
    ctx.fillText(spec.text, w / 2, TEX_H / 2 + TEX_H * 0.02)
  }
  const tex = new three.CanvasTexture(canvas)
  tex.needsUpdate = true
  return tex
}

export function makeTokenMesh(
  three: typeof THREE, spec: PileTokenSpec, fill: Fill, boxStyle: string, paddingFrac: number, _radiusFrac: number,
): THREE.Object3D {
  const group = new three.Group()
  const texs: THREE.Texture[] = []
  const w = Math.max(0.05, spec.w), h = Math.max(0.05, spec.h)

  if (spec.kind !== 'shape' && boxStyle === 'filled') {
    const boxMat = new three.MeshBasicMaterial({ color: fillPrimary(three, fill) })
    group.add(new three.Mesh(new three.PlaneGeometry(w, h), boxMat))
  } else if (spec.kind !== 'shape' && boxStyle === 'outline') {
    const edges = new three.LineSegments(
      new three.EdgesGeometry(new three.PlaneGeometry(w, h)),
      new three.LineBasicMaterial({ color: fillPrimary(three, fill) }),
    )
    group.add(edges)
  }

  const pad = spec.kind === 'shape' ? 1 : (1 - 2 * Math.min(0.4, Math.max(0, paddingFrac)))
  const tex = renderTokenTexture(three, spec, fill)
  texs.push(tex)
  const tokenMat = new three.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
  const token = new three.Mesh(new three.PlaneGeometry(w * pad, h * pad), tokenMat)
  token.position.z = 0.01 // sit above the box
  group.add(token)

  group.userData.tex = texs
  return group
}
```

- [ ] **Step 2: Commit** (committed together with Task 5, since its only test lives there)

No commit yet — proceed to Task 5.

---

### Task 5: The `pile` effect (controls, buildScene, update)

**Files:**
- Create: `frontend/app/lib/spacetype/effects/pile.ts`
- Test: `frontend/tests/unit/spacetype-pile-effect.unit.spec.ts`

**Interfaces:**
- Consumes: `planPileTokens`/`PileTokenSpec` (Task 2), `bakePile`/`PileTrajectory`/`PILE_SAMPLES` (Task 3), `makeTokenMesh` (Task 4); `parseFills` from `../fillTile`; `defaultFillsFor` from `../palette`; `ControlSpec`, `SpaceTypeEffect` from `../effect`.
- Produces: `export const pileEffect: SpaceTypeEffect` with `id: 'pile'`.
- Per-scene state on `root.userData.pileState = { meshes: THREE.Object3D[]; trajectory: PileTrajectory }`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/spacetype-pile-effect.unit.spec.ts
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { pileEffect } from '~/lib/spacetype/effects/pile'
import { defaultsFromControls } from '~/lib/spacetype/effect'
import { PILE_SAMPLES } from '~/lib/spacetype/pile/physics'

const env = { width: 960, height: 540, imageTextures: new Map() }
function p(over: Record<string, unknown>) {
  return { ...defaultsFromControls(pileEffect.controls), ...over }
}

describe('pileEffect', () => {
  it('is registered with the raw-word (separator-ineligible) id "pile"', () => {
    expect(pileEffect.id).toBe('pile')
  })

  it('builds one mesh per token and a full-length trajectory', () => {
    const root = pileEffect.buildScene(THREE, p({ text: 'MOVE FAST AND BREAK', textAs: 'words', shapeCount: 3 }), new THREE.Texture(), env)
    const st = (root as any).userData.pileState
    expect(st.meshes).toHaveLength(4 + 3)
    expect(st.trajectory).toHaveLength(PILE_SAMPLES)
  })

  it('update(t01) drives every mesh from the sampled trajectory', () => {
    const params = p({ text: 'HELLO WORLD', textAs: 'words', shapeCount: 0 })
    const root = pileEffect.buildScene(THREE, params, new THREE.Texture(), env)
    const st = (root as any).userData.pileState
    pileEffect.update!(0, params, root)
    const first = st.meshes.map((m: THREE.Object3D) => m.position.clone())
    pileEffect.update!(1, params, root)
    const last = st.meshes.map((m: THREE.Object3D) => m.position.clone())
    // The pile moves between the start of the drop and the settled end.
    const moved = first.some((v: THREE.Vector3, i: number) => v.distanceTo(last[i]) > 1e-3)
    expect(moved).toBe(true)
    // Settled (t=1) matches the final trajectory sample for token 0.
    const end = st.trajectory[PILE_SAMPLES - 1][0]
    expect(st.meshes[0].position.x).toBeCloseTo(end.x, 5)
    expect(st.meshes[0].position.y).toBeCloseTo(end.y, 5)
  })

  it('empty pile builds zero meshes without throwing', () => {
    const root = pileEffect.buildScene(THREE, p({ textAs: 'off', shapeCount: 0 }), new THREE.Texture(), env)
    expect((root as any).userData.pileState.meshes).toHaveLength(0)
  })

  it('every value-select control carries optionLabels', () => {
    for (const c of pileEffect.controls) {
      if (c.kind === 'select') expect(Array.isArray((c as any).optionLabels)).toBe(true)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/spacetype-pile-effect.unit.spec.ts`
Expected: FAIL — cannot find `effects/pile`.

- [ ] **Step 3: Write the implementation**

```ts
// frontend/app/lib/spacetype/effects/pile.ts
import * as THREE from 'three'
import type { ControlSpec, Params, SpaceTypeEffect } from '../effect'
import { parseFills } from '../fillTile'
import { defaultFillsFor } from '../palette'
import { planPileTokens } from '../pile/tokens'
import { bakePile, PILE_SAMPLES, type PileTrajectory } from '../pile/physics'
import { makeTokenMesh } from '../pile/render'

const controls: ControlSpec[] = [
  // TYPE
  { key: 'text', label: 'Text', kind: 'textList', default: 'MOVE FAST', group: 'Type' },
  { key: 'font', label: 'Font', kind: 'font', default: 'Anton', group: 'Type' },
  { key: 'typeSize', label: 'Type size', kind: 'slider', min: 60, max: 360, step: 2, default: 200, group: 'Type' },
  // CONTENT
  { key: 'textAs', label: 'Text as', kind: 'select', options: ['off', 'words', 'letters'], optionLabels: ['None', 'Words', 'Letters'], default: 'words', group: 'Content' },
  { key: 'boxStyle', label: 'Box style', kind: 'select', options: ['filled', 'bare', 'outline'], optionLabels: ['Filled box', 'Just words', 'Outline'], default: 'filled', group: 'Content' },
  { key: 'padding', label: 'Padding', kind: 'slider', min: 0, max: 0.4, step: 0.01, default: 0.14, group: 'Content', showIf: { key: 'boxStyle', notEquals: 'bare' } },
  // SHAPES
  { key: 'shapeCount', label: 'Shape count', kind: 'slider', min: 0, max: 40, step: 1, default: 0, group: 'Shapes' },
  { key: 'shape', label: 'Shape', kind: 'shape', default: 'none', allowNone: true, group: 'Shapes', showIf: { key: 'shapeCount', notEquals: 0 } },
  { key: 'shapeSize', label: 'Shape size', kind: 'slider', min: 30, max: 260, step: 2, default: 120, group: 'Shapes', showIf: { key: 'shapeCount', notEquals: 0 } },
  { key: 'sizeVariation', label: 'Size variation', kind: 'slider', min: 0, max: 0.9, step: 0.05, default: 0.3, group: 'Shapes', showIf: { key: 'shapeCount', notEquals: 0 } },
  // PHYSICS
  { key: 'container', label: 'Container', kind: 'slider', min: 0.3, max: 1, step: 0.02, default: 0.8, group: 'Physics' },
  { key: 'gravity', label: 'Gravity', kind: 'slider', min: 0.2, max: 3, step: 0.1, default: 1, group: 'Physics' },
  { key: 'bounciness', label: 'Bounciness', kind: 'slider', min: 0, max: 0.9, step: 0.05, default: 0.1, group: 'Physics' },
  { key: 'dropSpread', label: 'Drop spread', kind: 'slider', min: 0, max: 1, step: 0.05, default: 0.5, group: 'Physics' },
  { key: 'settleTime', label: 'Settle time', kind: 'slider', min: 0.2, max: 1, step: 0.05, default: 0.6, group: 'Physics' },
  { key: 'seed', label: 'Seed', kind: 'slider', min: 0, max: 999, step: 1, default: 1, group: 'Physics' },
  // COLOR
  { key: 'fills', label: 'Fills', kind: 'fillList', default: defaultFillsFor(6, 'pile'), group: 'Color' },
  // TRANSFORM (applied globally by the engine via GLOBAL_LIVE_KEYS)
  { key: 'scale', label: 'Scale', kind: 'slider', min: 0.4, max: 2.5, step: 0.05, default: 1.1, group: 'Transform' },
  { key: 'rotateX', label: 'Camera rotate X', kind: 'slider', min: -1.8, max: 1.8, step: 0.01, default: 0, group: 'Transform' },
  { key: 'rotateY', label: 'Camera rotate Y', kind: 'slider', min: -1.8, max: 1.8, step: 0.01, default: 0, group: 'Transform' },
  { key: 'rotateZ', label: 'Camera rotate Z', kind: 'slider', min: -1.8, max: 1.8, step: 0.01, default: 0, group: 'Transform' },
]

interface PileState { meshes: THREE.Object3D[]; trajectory: PileTrajectory }

export const pileEffect: SpaceTypeEffect = {
  id: 'pile',
  label: 'Pile',
  controls,

  buildScene(three, params: Params, _textTexture, env) {
    const root = new three.Group()
    const frame = { width: env?.width ?? 960, height: env?.height ?? 540 }
    const specs = planPileTokens(params, frame)
    const fills = parseFills(params.fills)
    const boxStyle = String(params.boxStyle ?? 'filled')
    const padding = Number(params.padding ?? 0.14)

    const meshes: THREE.Object3D[] = specs.map((s) => {
      const fill = fills[s.fillIndex % Math.max(1, fills.length)]!
      const mesh = makeTokenMesh(three, s, fill, s.kind === 'shape' ? 'bare' : boxStyle, padding, 0)
      root.add(mesh)
      return mesh
    })

    const trajectory = bakePile(specs, params, frame)
    root.userData.pileState = { meshes, trajectory } as PileState
    pileEffect.update(0, params, root)
    return root
  },

  update(t01, _params, root) {
    const st = root?.userData?.pileState as PileState | undefined
    if (!st || st.meshes.length === 0) return
    const n = PILE_SAMPLES - 1
    const f = Math.min(n, Math.max(0, t01 * n))
    const i0 = Math.floor(f), i1 = Math.min(n, i0 + 1), a = f - i0
    const s0 = st.trajectory[i0]!, s1 = st.trajectory[i1]!
    for (let k = 0; k < st.meshes.length; k++) {
      const p0 = s0[k]!, p1 = s1[k]!
      const m = st.meshes[k]!
      m.position.set(p0.x + (p1.x - p0.x) * a, p0.y + (p1.y - p0.y) * a, m.position.z)
      m.rotation.z = p0.angle + (p1.angle - p0.angle) * a
    }
  },
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/spacetype-pile-effect.unit.spec.ts tests/unit/spacetype-pile-tokens.unit.spec.ts`
Expected: PASS (both files — the tokens test's `pileEffect.controls` import now resolves).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/lib/spacetype/effects/pile.ts frontend/app/lib/spacetype/pile/render.ts frontend/tests/unit/spacetype-pile-effect.unit.spec.ts
git commit -m "feat(spacetype): Pile effect — render tokens, bake, play trajectory

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Register the effect + separator ineligibility

**Files:**
- Modify: `frontend/app/lib/spacetype/effects/index.ts` (import + array entry)
- Modify: `frontend/app/lib/spacetype/effect.ts:142` (`RAW_WORD_EFFECTS`)
- Test: `frontend/tests/unit/spacetype-pile-effect.unit.spec.ts` (extend with a registry assertion)

**Interfaces:**
- Consumes: `pileEffect` (Task 5), `SPACE_TYPE_EFFECTS`, `getEffect`, `separatorEligible`.

- [ ] **Step 1: Write the failing test** (append to the effect spec)

```ts
// append to frontend/tests/unit/spacetype-pile-effect.unit.spec.ts
import { SPACE_TYPE_EFFECTS, getEffect } from '~/lib/spacetype/effects'
import { separatorEligible } from '~/lib/spacetype/separator'

describe('pile registration', () => {
  it('is in the effect registry and resolvable by id', () => {
    expect(SPACE_TYPE_EFFECTS.some(e => e.id === 'pile')).toBe(true)
    expect(getEffect('pile').id).toBe('pile')
  })
  it('is separator-ineligible (raw-word effect)', () => {
    expect(separatorEligible('pile')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/spacetype-pile-effect.unit.spec.ts -t "pile registration"`
Expected: FAIL — `pile` not in `SPACE_TYPE_EFFECTS`; `separatorEligible('pile')` returns true.

- [ ] **Step 3: Implement the registration**

In `frontend/app/lib/spacetype/effects/index.ts`: add `import { pileEffect } from './pile'` beside the other effect imports, and add `pileEffect,` as an entry inside the `/* @__PURE__ */ [ ... ]` array (keep the annotation). 

In `frontend/app/lib/spacetype/effect.ts:142`, change:
```ts
export const RAW_WORD_EFFECTS: ReadonlySet<string> = new Set(['coil', 'elastic', 'echo'])
```
to:
```ts
export const RAW_WORD_EFFECTS: ReadonlySet<string> = new Set(['coil', 'elastic', 'echo', 'pile'])
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/spacetype-pile-effect.unit.spec.ts`
Expected: PASS (all groups).

- [ ] **Step 5: Run the broader Space Type + embed suites (no regressions)**

Run: `cd frontend && npx vitest run tests/unit/spacetype-sections.unit.spec.ts tests/unit/embed-build-output.unit.spec.ts tests/unit/spacetype-separator-controls.unit.spec.ts`
Expected: PASS. If `embed-build-output` asserts a built `public/embed/spacetype-pile.js` and fails because no build has run, run the embed build (check `frontend/package.json` scripts for the embed/build command, e.g. `pnpm run build:embed` or the vite embed config build) and re-run; expected artifact `frontend/public/embed/spacetype-pile.js`. If that test is gated on prebuilt artifacts and is skipped without them, note it and move on — the registry + list-script (`scripts/spacetype-effect-list.mjs`) picking up `pile` is the load-bearing assertion.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/lib/spacetype/effects/index.ts frontend/app/lib/spacetype/effect.ts frontend/tests/unit/spacetype-pile-effect.unit.spec.ts
git commit -m "feat(spacetype): register Pile effect, mark it separator-ineligible

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Live verification in the Space Type harness (controller-run)

**Files:** none (verification only). This task is run by the controller, never a subagent (a dev server kill would take `:3002`/ComfyUI down).

**Interfaces:** Consumes the shipped effect end-to-end.

- [ ] **Step 1: Confirm the effect renders a real pile**

With the existing dev server (do NOT start a new one — reuse `:3002` if healthy per CLAUDE.md), open the Space Type harness (`frontend/app/pages/dev/spacetype-harness.vue`) or the Expressive Studio, select **Pile**, and confirm at a mid `t01` the tokens are mid-fall and at `t01 → settle` they rest in a heap within the container. A hidden Browser pane pauses rAF (blank/paused capture), so foreground the pane before capturing. (memory: browser-pane-hidden-raf-paused, scene3d-treatments-s4-landed)

- [ ] **Step 2: Exercise the three content modes + the box-style toggle**

Set `Text as` = Words, then Letters; set `Shape count` > 0 with a picked shape; toggle `Box style` filled / just words / outline. Confirm: words+shapes and letters+shapes both pile together; the box toggle changes the look; changing `Seed`/`Gravity`/`Container` re-runs the bake and reshuffles/reshapes the pile.

- [ ] **Step 3: Capture proof**

Screenshot a settled pile and a mid-fall frame; note them in the completion report. No commit (verification only).

---

## Self-Review

**1. Spec coverage:**
- Baked-trajectory model, deterministic seeding, free scrubbing, zero per-frame physics → Tasks 3 & 5. ✓
- Matter.js offline synchronous baker → Tasks 1 & 3. ✓
- Mixable content (text as words/letters + additive shapes) via one token-producer seam → Task 2. ✓
- Box style filled/bare/outline + padding → Tasks 4 & 5 controls. ✓
- Control set, sentence-case + optionLabels on value selects → Task 5 (+ test asserting optionLabels). ✓
- Registration + separator ineligibility + embed note → Task 6. ✓
- Hold-and-cut loop (fall over settleTime then hold) → Task 3 (`settleTime` hold), tested. ✓
- Deterministic-trajectory tests (primary oracle) + live harness check → Tasks 2, 3, 7. ✓
- Corner radius: the spec listed `Corner radius`; **deferred** — three.js `PlaneGeometry` boxes are rectangular and rounded-corner box geometry adds scope with no physics effect. Not in the control list; noted here so it is a conscious cut, not a gap. Reinstate as a future polish if wanted.

**2. Placeholder scan:** No TBD/TODO; every code step shows full code; no "handle edge cases" hand-waves. ✓

**3. Type consistency:** `PileTokenSpec` (kind/text/shapeId/w/h/fillIndex) is consistent across tokens.ts, physics.ts, render.ts, pile.ts. `PileTrajectory = Pose[][]`, `PILE_SAMPLES`, `FRAME_HALF_H` exported from physics.ts and consumed unchanged. `planPileTokens(params, frame)`, `bakePile(specs, params, frame)`, `makeTokenMesh(three, spec, fill, boxStyle, paddingFrac, radiusFrac)`, `pileEffect` names match every call site. ✓
