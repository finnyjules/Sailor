# Frame Storyboards — Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Frame gains an optional storyboard: press "Add board", pose the same elements differently on each board, and the animation between boards is derived automatically (matched elements travel, unmatched ones enter/leave) and plays through the Frame's existing motion engine.

**Architecture:** A pure storyboard record (`sailor_storyboard` on the node) plus a pure compiler that turns it into each layer's existing `LayerAnimation` (whole-layer keyframes + In/Out moves) which the shipped motion engine already evaluates and paints. The live layer list always holds the *current* board's poses (materialise-on-switch), so every existing tool stays board-unaware. Slice 1 ships boards + travel + default entries/exits; per-board loops and precise in-transition timing are slice 2.

**Tech Stack:** Vue 3 + TypeScript (Nuxt 4, `frontend/`), Vitest for unit, Playwright for E2E via `/dev/frame-lab`.

**Spec:** `docs/superpowers/specs/2026-09-09-frame-storyboard-design.md`. Approved UI mockup: `.superpowers/brainstorm/78992-1788970762/content/story-tab-v3.html` (the visual spec for Tasks 8–10; the classes and layout there are the target).

## Global Constraints

- **The CONTROLLER commits, by hunk. Subagents DO NOT commit.** This working tree is shared by several live sessions and is currently dirty with dozens of other sessions' uncommitted files (see the opening `git status`). A subagent that runs `git add`/`git commit` will sweep foreign hunks into our commit. So: a subagent implements its task and leaves the working tree changed, then REPORTS the exact paths it touched; the controller (this session) stages ONLY those hunks and commits. Use the private index for every controller commit:
  ```bash
  export GIT_INDEX_FILE=/private/tmp/sb-index
  git read-tree HEAD
  # add ONLY our files; on a file another session also has open, add by hunk:
  git apply --cached <(git diff -- frontend/app/components/vue-canvas/CompositorModal.vue)   # then review
  git add frontend/app/lib/frame/storyboard/... frontend/tests/unit/...                        # our own new files
  git diff --cached --stat        # MUST list only our paths
  git commit -m "..."
  unset GIT_INDEX_FILE
  ```
  Then, in a SEPARATE shell (so `GIT_INDEX_FILE` is unset), resync the shared index: `git restore --staged <modified paths>` and `git reset -q -- <newly added paths>`. Never `git stash`. The commit steps below say "hand back to controller to commit" — a subagent must not run them.
- **Typecheck is baselined, not absolute.** `npm run typecheck` may already be RED at HEAD because another session's uncommitted change does not compile (the tree is dirty). Before Task 1, capture the baseline: `cd frontend && npm run typecheck 2>&1 | grep -c error` and save the error list. The gate for each task is "**no NEW typecheck error in a file this plan creates or modifies**", not a clean run. If a pre-existing error blocks a test file from running, note it and proceed against the isolated unit under test.
- **Copy rules:** sentence case, no lowercase-first labels, no internal identifiers in UI text. Words for people: "Board", "Hold", "Transition", "enters", "leaves", "travels", "loops". "Move" keeps its gallery meaning.
- **Byte-identity:** a Frame with no storyboard must render byte-for-byte as today. New keyframe fields (`scaleX`/`scaleY`/`color`) absent ⇒ identical output.
- **Persistence key:** the storyboard lives at `node.data.properties.sailor_storyboard` (round-trips through the node properties path; do NOT store on `node.data.*`).
- **Commit message co-author line** (per current session attribution):
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```
- **Run unit tests** with `cd frontend && npx vitest run <path>`.

---

## Gaming log — hardening pass 2026-09-13

Adversarial walk of every task against HEAD (the codebase moved several days since the plan was drafted). Fixes are folded into the tasks below; this is the index of what changed and why, so a reviewer can spot-check.

1. **Editor construction signature (Tasks 6, 7) — was wrong, would fail at `useLocalLayerEditor(...)`.** The real signature is `useLocalLayerEditor(opts: EditorOpts)` where `EditorOpts = { node: () => any; dims: () => { w; h }; getRect: () => DOMRect | null; wiredDims?; ... }`. The plan's `useLocalLayerEditor(() => node)` is invalid. Every harness now passes `{ node: () => node, dims: () => ({ w: 1000, h: 1000 }), getRect: () => null }`.
2. **Test node must be `reactive()` (Tasks 6, 7).** `localLayers`/`storyboard` are `computed(() => node()?.data?.properties?.…)`. A plain-object mutation is not tracked, so `commit()` writes but the computed returns stale and the tests read the wrong value. Wrap the harness node in `reactive()`. (The real app node is Vue-Flow-reactive, so this is a test-only concern — but without it the tests fail for a harness reason, masking real logic.)
3. **Keyframe non-uniform scale is NOT read by the painter (Task 4) — confirmed, now a concrete step.** `drawLayerWithMotion` computes `sx = scale * (whole?.scaleX ?? 1)` where `whole` is the per-UNIT state; the keyframe's `scaleX`/`scaleY` land on `st.layer` and are ignored. Task 4 now folds `st.layer.scaleX/scaleY` into `sx`/`sy` with exact code.
4. **Wired layers must be excluded from the compiler (Task 5).** A wired layer duplicated across boards would get poses → keyframes, but wired kinds have no keyframe paint path and their transform write-through to the backend must not be driven by `.animation`. The compiler now skips `layer.kind === 'wired'`; `applyAnimations` also leaves wired layers untouched.
5. **Line-number anchors replaced with search anchors (Tasks 3, 6, 8, 9, 10).** The effects programme (F1–F5) and other work moved `useLocalLayerEditor.ts`, `evaluate.ts`, `CompositorModal.vue`. Every "line ~N" is now "search for `<string>`".
6. **Import cycle checked and clear (Task 3).** `evaluate.ts` → `lib/studio/moves/ease.ts` → `lib/motion/easing.ts` + `./types` only; `ease.ts` does NOT import `evaluate.ts`. Adding `easeSample`/`mixHex` imports to `evaluate.ts` introduces no cycle. Verified 2026-09-13.
7. **`recompile` commits twice per mutation (Tasks 7) — safe, documented.** `applyPoses`→`commit`, then `recompile`→`applyAnimations`→`commit`. `commit()` does NOT call `recordHistory` (verified), so history stays one entry (the explicit `recordHistory()` at the top of each op). The second `commit` reads `localLayers.value` fresh (post-poses), correct under a reactive node.
8. **`applyAnimations` strips `.animation` from unmatched layers — intended, scoped.** Once a storyboard exists all motion is storyboard-derived, so stripping a stale hand-authored `.animation` is correct. It only runs inside `recompile`, which only runs when a storyboard exists.

---

## File Structure

**Create:**
- `frontend/app/lib/frame/storyboard/types.ts` — `Storyboard`, `Board`, `Pose`, `Transition`, `EntryExit` types + `createBoard`/`createStoryboard` factories. Pure.
- `frontend/app/lib/frame/storyboard/poses.ts` — `POSE_KEYS`, `layerSize`/`setLayerSize`, `poseColorOf`, `capturePose`/`applyPose`, `capturePoses`/`applyPoses`. Pure, no Vue/DOM.
- `frontend/app/lib/frame/storyboard/compile.ts` — `compileStoryboard(layers, storyboard) => { animations, motion }`. Pure.
- `frontend/app/composables/useStoryboard.ts` — board ops, materialise/capture on switch, recompile-on-change, board-scoped delete.
- `frontend/app/components/vue-canvas/compositor/StoryPanel.vue` — the left-panel Story tab (board + transition rows, playhead rail).
- `frontend/app/components/vue-canvas/compositor/StoryboardTimeline.vue` — the docked per-element timeline (read/select).
- `frontend/tests/unit/storyboard-poses.unit.spec.ts`, `storyboard-compile.unit.spec.ts`, `storyboard-keyframes.unit.spec.ts`, `storyboard-composable.unit.spec.ts`
- `frontend/tests/frame-storyboard.spec.ts` — E2E.

**Modify:**
- `frontend/app/lib/motion/types.ts` — extend `LayerKeyframe`.
- `frontend/app/lib/motion/evaluate.ts` — extend `evaluateKeyframes`, add `color` to `UnitState`.
- `frontend/app/lib/motion/paint.ts` — apply `color` in `composeEffectiveLayer`.
- `frontend/app/composables/useLocalLayerEditor.ts` — fold `storyboard` into `Snapshot`/`snapshot()`/`restore()`; expose `storyboard` + `writeStoryboard`.
- `frontend/app/components/vue-canvas/CompositorModal.vue` — Story tab, docked timeline, inspector split, delete-scoping, wiring.

---

### Task 1: Storyboard record types

**Files:**
- Create: `frontend/app/lib/frame/storyboard/types.ts`
- Test: `frontend/tests/unit/storyboard-poses.unit.spec.ts` (shared with Task 2; this task adds the construction test)

**Interfaces:**
- Produces: `Storyboard`, `Board`, `Pose`, `Transition`, `EntryExit` types; `createBoard(id: string): Board`; `createStoryboard(firstBoardId: string): Storyboard`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/storyboard-poses.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { createStoryboard, createBoard } from '~/lib/frame/storyboard/types'

describe('storyboard types', () => {
  it('createStoryboard makes a one-board doc with that board current', () => {
    const sb = createStoryboard('b1')
    expect(sb.boards).toHaveLength(1)
    expect(sb.boards[0]!.id).toBe('b1')
    expect(sb.current).toBe('b1')
    expect(sb.loopBack).toBe(false)
    expect(sb.boards[0]!.hold).toBeGreaterThan(0)
    expect(sb.boards[0]!.poses).toEqual({})
  })
  it('createBoard defaults a hold and empty poses/loops', () => {
    const b = createBoard('b2')
    expect(b.hold).toBeGreaterThan(0)
    expect(b.poses).toEqual({})
    expect(b.loops).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/storyboard-poses.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/frame/storyboard/types`.

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/app/lib/frame/storyboard/types.ts
import type { MoveEase } from '~/lib/studio/moves/types'

/** One transform/opacity/size/colour value per layer id; absent id ⇒ the
 *  element is not on this board. Only solid (string) paints carry a colour. */
export interface Pose {
  x: number; y: number
  rotation: number
  skewX?: number; skewY?: number
  opacity: number
  size: number            // text: fontSize; w/h shapes: width (h derives via ar); path: scale
  sizeH?: number          // width for the h axis when the kind has independent h (rect/ellipse/image/polygon/star)
  color?: string          // solid hex, only when the layer's paint field is a string
}

/** A move that runs while a board holds (slice 2 populates `loops`). */
export interface Loop { move: string; params?: Record<string, number> }

/** Between this board and the next: matched elements travel with this length
 *  and ease; entries/exits are per-element overrides on top of defaults. */
export interface Transition {
  duration: number
  ease: MoveEase
  entries: Record<string, EntryExit>
  exits: Record<string, EntryExit>
}

export interface EntryExit {
  move: string            // kinetic preset id (see compile.ts default*Preset)
  duration?: number       // slice 2; absent = the transition's duration
  at?: number             // slice 2; offset inside the transition; absent = 0
  auto: boolean           // true = Sailor chose it; recompile may replace it
}

export interface Board {
  id: string
  hold: number            // seconds the pose rests
  poses: Record<string, Pose>
  loops: Loop[]
  transition?: Transition  // into the NEXT board
  bg?: string             // solid frame background for this board (else shared)
}

export interface Storyboard {
  current: string
  boards: Board[]         // ordered; index = time order
  loopBack: boolean
}

const DEFAULT_HOLD = 1.0

export function createBoard(id: string): Board {
  return { id, hold: DEFAULT_HOLD, poses: {}, loops: [] }
}

export function createStoryboard(firstBoardId: string): Storyboard {
  return { current: firstBoardId, boards: [createBoard(firstBoardId)], loopBack: false }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/storyboard-poses.unit.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit** (use the private-index block from Global Constraints)

```bash
git add frontend/app/lib/frame/storyboard/types.ts frontend/tests/unit/storyboard-poses.unit.spec.ts
git commit -m "feat(frame): storyboard record types"
```

---

### Task 2: Pose capture / apply

**Files:**
- Create: `frontend/app/lib/frame/storyboard/poses.ts`
- Test: `frontend/tests/unit/storyboard-poses.unit.spec.ts` (extend)

**Interfaces:**
- Consumes: `Pose` from Task 1; `LocalLayer` from `~/composables/useCompositorLayers`.
- Produces:
  - `POSE_KEYS: readonly (keyof Pose)[]` — the exhaustive pose field list.
  - `layerSize(layer): { size: number; sizeH?: number }`
  - `setLayerSize(layer, size: number, sizeH?: number): LocalLayer` (returns a patched clone)
  - `poseColorOf(layer): string | undefined` (paint field only when it is a string)
  - `capturePose(layer): Pose`
  - `applyPose(layer, pose): LocalLayer` (clone with pose fields written; shared fields untouched)
  - `capturePoses(layers): Record<string, Pose>`
  - `applyPoses(layers, poses): LocalLayer[]` (only layers whose id is in `poses`; order preserved)

- [ ] **Step 1: Write the failing test** (append to the existing file)

```ts
import { capturePose, applyPose, capturePoses, applyPoses, POSE_KEYS, layerSize } from '~/lib/frame/storyboard/poses'
import type { LocalLayer, TextLayer, RectLayer } from '~/composables/useCompositorLayers'

const text = (over: Partial<TextLayer> = {}): TextLayer => ({
  id: 't1', kind: 'text', x: 0.5, y: 0.3, rotation: 0, opacity: 1,
  text: 'DROP', fontFamily: 'Inter', fontWeight: 700, fontSize: 0.2,
  color: '#151515', align: 'left', lineHeight: 1, strokeColor: '', strokeWidth: 0,
  ...over,
}) as TextLayer
const rect = (over: Partial<RectLayer> = {}): RectLayer => ({
  id: 'r1', kind: 'rect', x: 0.4, y: 0.4, rotation: 0, opacity: 1,
  w: 0.3, h: 0.1, radius: 0, fill: '#e2432c', stroke: '', strokeWidth: 0,
  ...over,
}) as RectLayer

describe('storyboard poses', () => {
  it('captures pose fields including size and solid colour', () => {
    const p = capturePose(text())
    expect(p).toMatchObject({ x: 0.5, y: 0.3, rotation: 0, opacity: 1, size: 0.2, color: '#151515' })
  })
  it('rect captures independent width/height as size/sizeH', () => {
    const p = capturePose(rect())
    expect(p.size).toBe(0.3); expect(p.sizeH).toBe(0.1); expect(p.color).toBe('#e2432c')
  })
  it('applyPose round-trips pose fields and leaves shared fields untouched', () => {
    const original = text({ fontFamily: 'Inter', text: 'DROP' })
    const moved = applyPose(original, { ...capturePose(original), x: 0.1, size: 0.4 })
    expect(moved.x).toBe(0.1); expect((moved as TextLayer).fontSize).toBe(0.4)
    expect((moved as TextLayer).text).toBe('DROP') // shared, untouched
    expect((moved as TextLayer).fontFamily).toBe('Inter')
  })
  it('does not capture a colour when the paint is a gradient', () => {
    const grad = rect({ fill: { type: 'linear', stops: [] } as any })
    expect(capturePose(grad).color).toBeUndefined()
  })
  it('applyPoses only touches layers present in the map', () => {
    const ls: LocalLayer[] = [text(), rect()]
    const out = applyPoses(ls, { t1: { ...capturePose(text()), x: 0.9 } })
    expect(out[0]!.x).toBe(0.9); expect(out[1]!.x).toBe(0.4)
  })
  it('POSE_KEYS is the exhaustive pose field list', () => {
    expect([...POSE_KEYS].sort()).toEqual(['color','opacity','rotation','size','sizeH','skewX','skewY','x','y'].sort())
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/storyboard-poses.unit.spec.ts`
Expected: FAIL — cannot resolve `poses`.

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/app/lib/frame/storyboard/poses.ts
import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { Pose } from './types'

export const POSE_KEYS = ['x', 'y', 'rotation', 'skewX', 'skewY', 'opacity', 'size', 'sizeH', 'color'] as const

/** Kinds whose h axis is independent of w (so a pose carries both). */
const H_KINDS = new Set(['rect', 'ellipse', 'image', 'polygon', 'star'])

export function layerSize(layer: LocalLayer): { size: number; sizeH?: number } {
  if (layer.kind === 'text') return { size: (layer as any).fontSize }
  if (layer.kind === 'path') return { size: (layer as any).scale }
  const w = (layer as any).w as number
  if (H_KINDS.has(layer.kind)) return { size: w, sizeH: (layer as any).h as number }
  return { size: w } // line, brush: single dimension
}

export function setLayerSize(layer: LocalLayer, size: number, sizeH?: number): LocalLayer {
  if (layer.kind === 'text') return { ...layer, fontSize: size } as LocalLayer
  if (layer.kind === 'path') return { ...layer, scale: size } as LocalLayer
  if (H_KINDS.has(layer.kind)) return { ...layer, w: size, h: sizeH ?? (layer as any).h } as LocalLayer
  return { ...layer, w: size } as LocalLayer
}

function paintField(layer: LocalLayer): 'color' | 'fill' | null {
  if (layer.kind === 'text') return 'color'
  if ('fill' in (layer as any)) return 'fill'
  return null
}

export function poseColorOf(layer: LocalLayer): string | undefined {
  const f = paintField(layer)
  if (!f) return undefined
  const v = (layer as any)[f]
  return typeof v === 'string' && v !== '' && v !== 'none' ? v : undefined
}

export function capturePose(layer: LocalLayer): Pose {
  const { size, sizeH } = layerSize(layer)
  const p: Pose = {
    x: layer.x, y: layer.y, rotation: layer.rotation, opacity: layer.opacity, size,
  }
  if (sizeH != null) p.sizeH = sizeH
  if ((layer as any).skewX != null) p.skewX = (layer as any).skewX
  if ((layer as any).skewY != null) p.skewY = (layer as any).skewY
  const color = poseColorOf(layer)
  if (color != null) p.color = color
  return p
}

export function applyPose(layer: LocalLayer, pose: Pose): LocalLayer {
  let next: LocalLayer = {
    ...layer, x: pose.x, y: pose.y, rotation: pose.rotation, opacity: pose.opacity,
  } as LocalLayer
  if (pose.skewX != null) (next as any).skewX = pose.skewX
  if (pose.skewY != null) (next as any).skewY = pose.skewY
  next = setLayerSize(next, pose.size, pose.sizeH)
  if (pose.color != null) {
    const f = paintField(next)
    if (f && typeof (next as any)[f] === 'string') (next as any)[f] = pose.color
  }
  return next
}

export function capturePoses(layers: LocalLayer[]): Record<string, Pose> {
  const out: Record<string, Pose> = {}
  for (const l of layers) out[l.id] = capturePose(l)
  return out
}

export function applyPoses(layers: LocalLayer[], poses: Record<string, Pose>): LocalLayer[] {
  return layers.map(l => (poses[l.id] ? applyPose(l, poses[l.id]!) : l))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/storyboard-poses.unit.spec.ts`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/lib/frame/storyboard/poses.ts frontend/tests/unit/storyboard-poses.unit.spec.ts
git commit -m "feat(frame): storyboard pose capture/apply"
```

---

### Task 3: Keyframe engine additions (scaleX/scaleY, colour, ease vocabulary)

**Files:**
- Modify: `frontend/app/lib/motion/types.ts` (the `LayerKeyframe` interface)
- Modify: `frontend/app/lib/motion/evaluate.ts` (`UnitState`, `evaluateKeyframes`)
- Test: `frontend/tests/unit/storyboard-keyframes.unit.spec.ts`

**Interfaces:**
- Consumes: `MoveEase`, `easeSample` from `~/lib/studio/moves/ease`; `mixHex` from `~/lib/color/mix`.
- Produces: `LayerKeyframe` now carries optional `scaleX`, `scaleY`, `color`, and `ease?: MoveEase | 'linear' | 'easeInOut'`; `UnitState.color?: string`; `evaluateKeyframes` interpolates all of them.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/storyboard-keyframes.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { evaluateKeyframes } from '~/lib/motion/evaluate'

describe('evaluateKeyframes new channels', () => {
  it('interpolates scaleX/scaleY independently', () => {
    const s = evaluateKeyframes([
      { t: 0, scaleX: 1, scaleY: 1 },
      { t: 1, scaleX: 3, scaleY: 0.5 },
    ], 0.5)
    expect(s.scaleX).toBeCloseTo(2, 5)
    expect(s.scaleY).toBeCloseTo(0.75, 5)
  })
  it('interpolates colour in OKLCH and is exact at the ends', () => {
    const kfs = [{ t: 0, color: '#000000' }, { t: 1, color: '#ffffff' }]
    expect(evaluateKeyframes(kfs, 0).color).toBe('#000000')
    expect(evaluateKeyframes(kfs, 1).color).toBe('#ffffff')
    const mid = evaluateKeyframes(kfs, 0.5).color!
    expect(mid).not.toBe('#000000'); expect(mid).not.toBe('#ffffff')
  })
  it('a MoveEase named curve is honoured', () => {
    const lin = evaluateKeyframes([{ t: 0, dx: 0, ease: { kind: 'named', name: 'accelerate' } }, { t: 1, dx: 1 }], 0.5).dx
    const smooth = evaluateKeyframes([{ t: 0, dx: 0, ease: { kind: 'named', name: 'smooth' } }, { t: 1, dx: 1 }], 0.5).dx
    expect(lin).not.toBeCloseTo(smooth, 3) // different curves move differently at t=0.5
  })
  it('legacy keyframes with no new fields are unchanged (identity defaults)', () => {
    const s = evaluateKeyframes([{ t: 0, dx: 0 }, { t: 1, dx: 0.4 }], 0.5)
    expect(s.dx).toBeCloseTo(0.2, 5)
    expect(s.color).toBeUndefined()
    expect(s.scaleX).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/storyboard-keyframes.unit.spec.ts`
Expected: FAIL — `scaleX`/`color` are not interpolated (undefined) and MoveEase object not handled.

- [ ] **Step 3a: Extend the `LayerKeyframe` interface**

In `frontend/app/lib/motion/types.ts`, search for `export interface LayerKeyframe` and replace the whole interface with:

```ts
export interface LayerKeyframe {
  t: number
  dx?: number           // normalized canvas-width offset (additive)
  dy?: number           // normalized canvas-HEIGHT offset (additive)
  scale?: number        // multiplicative, 1 = none
  scaleX?: number       // non-uniform width scale, multiplied with scale; 1 = none
  scaleY?: number       // non-uniform height scale; 1 = none
  rotation?: number     // degrees, additive
  opacity?: number      // multiplicative, 1 = none
  color?: string        // solid hex, interpolated in OKLCH; absent = inherit
  // Storyboards author the wider ease vocabulary; hand-authored legacy docs may
  // still carry the narrow union, both accepted.
  ease?: import('~/lib/studio/moves/types').MoveEase | 'linear' | 'easeInOut'
}
```

- [ ] **Step 3b: Add `color` to `UnitState`**

In `frontend/app/lib/motion/evaluate.ts`, add to the `UnitState` interface (after `opacity`):

```ts
  /** Whole-layer solid colour override from a keyframe; absent = keep the
   *  layer's own paint. Only the Compositor colour/fill paint fields honour it. */
  color?: string
```

- [ ] **Step 3c: Rewrite `evaluateKeyframes`**

In `frontend/app/lib/motion/evaluate.ts`, search for `export function evaluateKeyframes` and replace the whole function. Add these imports near the existing `import { resolveEase, easeInOutQuad, linear } from './easing'` line: `import { easeSample } from '~/lib/studio/moves/ease'`, `import { mixHex } from '~/lib/color/mix'`, `import type { MoveEase } from '~/lib/studio/moves/types'`. (Verified cycle-free 2026-09-13: `ease.ts` imports only `~/lib/motion/easing` + `./types`, never `evaluate.ts`.)

```ts
export function evaluateKeyframes(kfs: LayerKeyframe[], t: number): UnitState {
  if (!kfs.length) return IDENTITY_UNIT
  const sorted = [...kfs].sort((a, b) => a.t - b.t)
  const fill = (k: LayerKeyframe) => ({
    t: k.t, dx: k.dx ?? 0, dy: k.dy ?? 0,
    scale: k.scale ?? 1, scaleX: k.scaleX ?? 1, scaleY: k.scaleY ?? 1,
    rotation: k.rotation ?? 0, opacity: k.opacity ?? 1, color: k.color,
  })
  const at = (k: ReturnType<typeof fill>): UnitState =>
    u({ dx: k.dx, dy: k.dy, scale: k.scale, scaleX: k.scaleX, scaleY: k.scaleY,
        rotation: k.rotation, opacity: k.opacity, color: k.color })
  if (t <= sorted[0]!.t) return at(fill(sorted[0]!))
  const last = sorted[sorted.length - 1]!
  if (t >= last.t) return at(fill(last))
  let lo = sorted[0]!, hi = sorted[1]!
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.t >= t) { lo = sorted[i - 1]!; hi = sorted[i]!; break }
  }
  const a = fill(lo), b = fill(hi)
  const span = Math.max(1e-6, b.t - a.t)
  const raw = (t - a.t) / span
  // ease: accept a MoveEase object, or the legacy 'linear'/'easeInOut' strings.
  const e = lo.ease
  const p = typeof e === 'object' ? easeSample(e as MoveEase, raw)
    : e === 'linear' ? linear(raw) : easeInOutQuad(raw)
  const lerp = (x: number, y: number) => x + (y - x) * p
  const color = a.color != null && b.color != null ? mixHex(a.color, b.color, p, 'oklch')
    : (a.color ?? b.color)
  return u({
    dx: lerp(a.dx, b.dx), dy: lerp(a.dy, b.dy),
    scale: lerp(a.scale, b.scale), scaleX: lerp(a.scaleX, b.scaleX), scaleY: lerp(a.scaleY, b.scaleY),
    rotation: lerp(a.rotation, b.rotation), opacity: lerp(a.opacity, b.opacity), color,
  })
}
```

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run tests/unit/storyboard-keyframes.unit.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Guard byte-identity of the existing motion suite**

Run: `cd frontend && npx vitest run tests/unit/motion-evaluate.unit.spec.ts` (and any `tests/**/*motion*`/`*keyframe*` specs). 
Expected: PASS — no existing test regresses. If a golden/parity test moved, STOP and inspect: legacy keyframes must be byte-identical.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/lib/motion/types.ts frontend/app/lib/motion/evaluate.ts frontend/tests/unit/storyboard-keyframes.unit.spec.ts
git commit -m "feat(motion): keyframes gain scaleX/scaleY, colour, ease vocabulary"
```

---

### Task 4: Apply keyframe colour + non-uniform scale in the painter

**Files:**
- Modify: `frontend/app/lib/motion/paint.ts` (`composeEffectiveLayer`)
- Test: `frontend/tests/unit/storyboard-keyframes.unit.spec.ts` (extend)

**Interfaces:**
- Consumes: `UnitState.color`, `scaleX`, `scaleY` from Task 3.
- Produces: `composeEffectiveLayer` writes `st.layer.color` onto the clone's paint field (`color` for text, `fill` otherwise, only when currently a string) and folds `scaleX`/`scaleY` into the returned clone's size fields.

- [ ] **Step 1: Write the failing test** (append)

```ts
import { composeEffectiveLayer } from '~/lib/motion/paint'
import type { LayerMotionState } from '~/lib/motion/evaluate'

describe('composeEffectiveLayer colour + non-uniform scale', () => {
  const rect: any = { id: 'r', kind: 'rect', x: 0.5, y: 0.5, rotation: 0, opacity: 1, w: 0.2, h: 0.1, fill: '#000000' }
  it('overrides a string fill with the keyframe colour', () => {
    const st: LayerMotionState = { visible: true, layer: { dx:0,dy:0,scale:1,rotation:0,opacity:1, color:'#ff0000' } }
    const out: any = composeEffectiveLayer(rect, st, 1000, 1000)
    expect(out.fill).toBe('#ff0000')
  })
  it('does not touch a non-string fill', () => {
    const grad: any = { ...rect, fill: { type: 'linear', stops: [] } }
    const st: LayerMotionState = { visible: true, layer: { dx:0,dy:0,scale:1,rotation:0,opacity:1, color:'#ff0000' } }
    expect(composeEffectiveLayer(grad, st, 1000, 1000).fill).toEqual(grad.fill)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/storyboard-keyframes.unit.spec.ts -t "colour"`
Expected: FAIL — `out.fill` still `#000000`.

- [ ] **Step 3: Extend `composeEffectiveLayer`**

In `frontend/app/lib/motion/paint.ts`, inside `composeEffectiveLayer`, before `return { ...layer, ... }`, capture the existing return object into a `const next`, then after building it apply colour and non-uniform scale. The existing function returns `{ ...layer, x, y, rotation, opacity }` plus scale handled by the caller's ctx transform. Replace the `return { ... }` with:

```ts
  const next: any = {
    ...layer,
    x: layer.x + dx,
    y: layer.y + dy,
    rotation: layer.rotation + k.rotation + (whole?.rotation ?? 0),
    opacity: layer.opacity * k.opacity * (whole?.opacity ?? 1),
  }
  // Whole-layer solid colour from a keyframe overrides a string paint only.
  if (k.color != null) {
    const f = next.kind === 'text' ? 'color' : ('fill' in next ? 'fill' : null)
    if (f && typeof next[f] === 'string' && next[f] !== '' && next[f] !== 'none') next[f] = k.color
  }
  return next
```

- [ ] **Step 3b: Wire the keyframe's non-uniform scale into `drawLayerWithMotion` (REQUIRED — confirmed missing 2026-09-13)**

The painter currently reads only the per-UNIT `scaleX`/`scaleY`, so a keyframe's `st.layer.scaleX/scaleY` (a rect going wide and short between boards) does nothing. In `frontend/app/lib/motion/paint.ts`, search for `const sx = scale * (whole?.scaleX ?? 1)` and replace those two lines with:

```ts
  const sx = scale * (st.layer.scaleX ?? 1) * (whole?.scaleX ?? 1)
  const sy = scale * (st.layer.scaleY ?? 1) * (whole?.scaleY ?? 1)
```

`scale` already carries `st.layer.scale` (via `motionScale`), so uniform scale is unchanged; this adds the independent axes.

- [ ] **Step 3c: Add a test proving non-uniform keyframe scale reaches the transform**

Append to `storyboard-keyframes.unit.spec.ts` a test that builds a `LayerMotionState` with `layer.scaleX = 3, scaleY = 0.5` and asserts, via a stub `ctx` recording `scale` calls passed to `drawLayerWithMotion` (or via a direct check of the computed `sx`/`sy` if you extract them into a tiny exported helper), that the horizontal scale is 3× and vertical 0.5×. If a full `ctx` stub is heavy, extract `function motionScaleXY(st): [number, number]` and unit-test that instead, then use it in `drawLayerWithMotion`.

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run tests/unit/storyboard-keyframes.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/lib/motion/paint.ts frontend/tests/unit/storyboard-keyframes.unit.spec.ts
git commit -m "feat(motion): painter applies keyframe colour and non-uniform scale"
```

---

### Task 5: The compiler

**Files:**
- Create: `frontend/app/lib/frame/storyboard/compile.ts`
- Test: `frontend/tests/unit/storyboard-compile.unit.spec.ts`

**Interfaces:**
- Consumes: `Storyboard`, `Board`, `Pose` (Task 1); `LocalLayer`; `LayerAnimation`, `LayerAnimSpec`, `FrameMotion`, `DEFAULT_FRAME_MOTION` from `~/lib/motion/types`; `layerSize` (Task 2).
- Produces: `compileStoryboard(layers: LocalLayer[], sb: Storyboard) => { animations: Record<string, LayerAnimation>; motion: FrameMotion }`; helpers `defaultEntryPreset(kind)`, `defaultExitPreset(kind)`, `shortArc(fromDeg, toDeg)`.

Rules (from the spec):
- Board start times cumulative: `start[i] = Σ_{j<i}(hold[j] + transition[j].duration)`; frame duration = Σ all holds + all transitions (+ loop-back transition if `loopBack`).
- Poses in the compiler are the boards' **absolute** poses. Keyframes are **relative to the current board's pose** (which is what the live layer holds): for a layer `l`, `dx = pose.x - live.x`, etc. `live` = the current board's pose for `l` (fall back to `capturePose(layer)` — they are equal by the materialise invariant).
- Matched element (present on ≥2 boards): one keyframe per present board at that board's hold-start, plus one at hold-end holding the same value (so it rests during a hold and moves during a transition). `scale = pose.size / live.size`; for kinds with `sizeH`, `scaleX = pose.size / live.size`, `scaleY = pose.sizeH / live.sizeH`. `rotation = shortArc(live.rotation, pose.rotation)`. `opacity = live.opacity < 1e-4 ? pose.opacity : pose.opacity / live.opacity`. `color = pose.color` when present. Ease on each keyframe = the outgoing transition's ease.
- Interior gap (present, absent, present): keyframes with `opacity: 0` across the absent board's hold, fading over the adjacent transitions.
- Absent at start (present from board n): `offset = start[n] - (n>0 ? transition[n-1].duration : 0)`, `in = { presetId: entry.move, duration: entry.duration ?? transition.duration }`.
- Absent at end (present until board m): window ends after board m's hold; `out = { presetId: exit.move, duration }`.
- Present on exactly one board with >1 boards total: it enters (default In) at that board and leaves (default Out) after — both auto.
- `bg` colour interpolation is handled by the Frame background, not per-layer; the compiler returns the board bg timeline via `motion` untouched in slice 1 EXCEPT it must set `motion.duration`/`motion.fps`.

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/tests/unit/storyboard-compile.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { compileStoryboard, shortArc } from '~/lib/frame/storyboard/compile'
import { createStoryboard, type Storyboard } from '~/lib/frame/storyboard/types'
import type { LocalLayer, TextLayer } from '~/composables/useCompositorLayers'

const DEFAULT_EASE = { kind: 'named', name: 'smooth' } as const
const text = (id: string, over: Partial<TextLayer> = {}): TextLayer => ({
  id, kind: 'text', x: 0.5, y: 0.5, rotation: 0, opacity: 1, text: 'X',
  fontFamily: 'Inter', fontWeight: 700, fontSize: 0.2, color: '#111', align: 'left',
  lineHeight: 1, strokeColor: '', strokeWidth: 0, ...over,
}) as TextLayer

// two boards: title at 0.5,0.5 then 0.5,0.2; subtitle absent then present
function twoBoards(): { layers: LocalLayer[]; sb: Storyboard } {
  const sb = createStoryboard('b1')
  sb.boards[0]!.hold = 1
  sb.boards[0]!.transition = { duration: 0.6, ease: DEFAULT_EASE, entries: {}, exits: {} }
  sb.boards.push({ id: 'b2', hold: 1, poses: {}, loops: [] })
  // current board is b1; live layers = b1 poses
  sb.current = 'b1'
  sb.boards[0]!.poses = { title: { x: 0.5, y: 0.5, rotation: 0, opacity: 1, size: 0.2 } }
  sb.boards[1]!.poses = {
    title: { x: 0.5, y: 0.2, rotation: 0, opacity: 1, size: 0.1 },
    subtitle: { x: 0.5, y: 0.7, rotation: 0, opacity: 1, size: 0.05 },
  }
  const layers: LocalLayer[] = [text('title', { fontSize: 0.2 }), text('subtitle', { fontSize: 0.05, x: 0.5, y: 0.7 })]
  return { layers, sb }
}

describe('compileStoryboard', () => {
  it('sums duration over holds and transitions', () => {
    const { layers, sb } = twoBoards()
    const { motion } = compileStoryboard(layers, sb)
    expect(motion.duration).toBeCloseTo(1 + 0.6 + 1, 5) // hold + transition + hold
  })
  it('a matched element travels: keyframes carry the y delta and size ratio', () => {
    const { layers, sb } = twoBoards()
    const { animations } = compileStoryboard(layers, sb)
    const kfs = animations.title!.keyframes!
    // last keyframe (board 2) should move up (dy negative) and shrink (scale 0.5)
    const lastMoving = kfs[kfs.length - 1]!
    expect(lastMoving.dy).toBeCloseTo(0.2 - 0.5, 5)
    expect(lastMoving.scale).toBeCloseTo(0.1 / 0.2, 5)
  })
  it('an element absent at the start gets an offset and a default In', () => {
    const { layers, sb } = twoBoards()
    const { animations } = compileStoryboard(layers, sb)
    const a = animations.subtitle!
    expect(a.offset).toBeCloseTo(1 + 0.6 - 0.6, 5) // start[1] - transition.duration = 1
    expect(a.in?.presetId).toBeTruthy()
  })
  it('short-arc rotation takes the near side', () => {
    expect(shortArc(350, 10)).toBeCloseTo(20, 5)   // +20, not -340
    expect(shortArc(10, 350)).toBeCloseTo(-20, 5)
  })
  it('a hand-picked entry (auto:false) is not replaced', () => {
    const { layers, sb } = twoBoards()
    sb.boards[0]!.transition!.entries = { subtitle: { move: 'blur-in', duration: 0.3, auto: false } }
    const { animations } = compileStoryboard(layers, sb)
    expect(animations.subtitle!.in?.presetId).toBe('blur-in')
  })
  it('loopBack adds the return transition to the duration', () => {
    const { layers, sb } = twoBoards()
    sb.loopBack = true
    sb.boards[1]!.transition = { duration: 0.5, ease: DEFAULT_EASE, entries: {}, exits: {} }
    const { motion } = compileStoryboard(layers, sb)
    expect(motion.duration).toBeCloseTo(1 + 0.6 + 1 + 0.5, 5)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/storyboard-compile.unit.spec.ts`
Expected: FAIL — cannot resolve `compile`.

- [ ] **Step 3: Write the implementation**

```ts
// frontend/app/lib/frame/storyboard/compile.ts
import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { LayerAnimation, LayerAnimSpec, FrameMotion } from '~/lib/motion/types'
import { DEFAULT_FRAME_MOTION } from '~/lib/motion/types'
import type { Storyboard, Board, Pose, EntryExit } from './types'
import { layerSize } from './poses'

export function shortArc(fromDeg: number, toDeg: number): number {
  let d = (toDeg - fromDeg) % 360
  if (d > 180) d -= 360
  if (d < -180) d += 360
  return d
}

export function defaultEntryPreset(kind: string): string {
  return kind === 'text' ? 'slide-up' : 'grow-in'
}
export function defaultExitPreset(kind: string): string {
  return kind === 'text' ? 'slide-out-down' : 'shrink-out'
}

interface Times { start: number[]; total: number }
function boardTimes(sb: Storyboard): Times {
  const start: number[] = []
  let t = 0
  sb.boards.forEach((b, i) => {
    start.push(t)
    t += b.hold
    if (i < sb.boards.length - 1) t += b.transition?.duration ?? 0
  })
  if (sb.loopBack) t += sb.boards[sb.boards.length - 1]?.transition?.duration ?? 0
  return { start, total: t }
}

/** indices of boards that hold a pose for this layer id, in order. */
function presence(sb: Storyboard, id: string): number[] {
  const out: number[] = []
  sb.boards.forEach((b, i) => { if (b.poses[id]) out.push(i) })
  return out
}

export function compileStoryboard(
  layers: LocalLayer[], sb: Storyboard,
): { animations: Record<string, LayerAnimation>; motion: FrameMotion } {
  const { start, total } = boardTimes(sb)
  const curIdx = Math.max(0, sb.boards.findIndex(b => b.id === sb.current))
  const animations: Record<string, LayerAnimation> = {}

  for (const layer of layers) {
    const id = layer.id
    if (layer.kind === 'wired') continue          // wired layers are static across boards in slice 1
    const present = presence(sb, id)
    if (!present.length) continue
    const live = sb.boards[curIdx]?.poses[id] ?? poseFromLayer(layer)
    const liveSize = live.size || layerSize(layer).size || 1

    const first = present[0]!, last = present[present.length - 1]!
    const holdEnd = (i: number) => start[i]! + sb.boards[i]!.hold
    const anim: LayerAnimation = { offset: 0 }

    // window: from the incoming transition of `first` to the end of `last`'s hold
    const inTrans = first > 0 ? sb.boards[first - 1]!.transition : undefined
    anim.offset = first > 0 ? start[first]! - (inTrans?.duration ?? 0) : 0
    const windowEnd = last < sb.boards.length - 1 ? holdEnd(last) : total
    anim.duration = Math.max(0.001, windowEnd - anim.offset)

    // default / overridden entry & exit
    if (first > 0) {
      const e = sb.boards[first - 1]!.transition!.entries[id]
      anim.in = entrySpec(e, defaultEntryPreset(layer.kind), sb.boards[first - 1]!.transition!.duration)
    }
    if (last < sb.boards.length - 1) {
      const x = sb.boards[last]!.transition!.exits[id]
      anim.out = entrySpec(x, defaultExitPreset(layer.kind), sb.boards[last]!.transition!.duration)
    }

    // travel keyframes (relative to `live`, in seconds relative to offset)
    const kfs: NonNullable<LayerAnimation['keyframes']> = []
    for (let i = first; i <= last; i++) {
      const pose = sb.boards[i]!.poses[id]
      const trans = sb.boards[i]!.transition
      const ease = trans?.ease
      if (pose) {
        const k = keyframeFrom(pose, live, liveSize, layer, ease)
        kfs.push({ ...k, t: start[i]! - anim.offset })       // arrive/rest at hold start
        kfs.push({ ...k, t: holdEnd(i) - anim.offset })      // hold through the hold
      } else {
        // interior gap: opacity 0 across this board's hold
        kfs.push({ t: start[i]! - anim.offset, opacity: 0, ease })
        kfs.push({ t: holdEnd(i) - anim.offset, opacity: 0, ease })
      }
    }
    if (kfs.length) anim.keyframes = kfs
    animations[id] = anim
  }

  return { animations, motion: { ...DEFAULT_FRAME_MOTION, duration: total } }
}

function poseFromLayer(layer: LocalLayer): Pose {
  const { size, sizeH } = layerSize(layer)
  const p: Pose = { x: layer.x, y: layer.y, rotation: layer.rotation, opacity: layer.opacity, size }
  if (sizeH != null) p.sizeH = sizeH
  return p
}

function entrySpec(e: EntryExit | undefined, fallbackPreset: string, dur: number): LayerAnimSpec {
  return { presetId: e?.move ?? fallbackPreset, duration: e?.duration ?? dur }
}

function keyframeFrom(pose: Pose, live: Pose, liveSize: number, layer: LocalLayer, ease: any) {
  const scale = pose.size / (liveSize || 1)
  const k: any = {
    dx: pose.x - live.x,
    dy: pose.y - live.y,
    rotation: shortArc(live.rotation, pose.rotation),
    opacity: live.opacity < 1e-4 ? pose.opacity : pose.opacity / live.opacity,
    ease,
  }
  if (pose.sizeH != null && live.sizeH != null) {
    k.scaleX = pose.size / (live.size || 1)
    k.scaleY = pose.sizeH / (live.sizeH || 1)
  } else {
    k.scale = scale
  }
  if (pose.color != null) k.color = pose.color
  return k
}
```

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run tests/unit/storyboard-compile.unit.spec.ts`
Expected: PASS (6 tests). Then add these THREE required cases and make them pass (do not skip — each is a distinct code path the six above don't cover):
- **Interior gap:** title present on boards 1 and 3, absent on 2 → its keyframes include an `opacity: 0` pair spanning board 2's hold, and the window (`offset`+`duration`) still covers boards 1..3.
- **Absent at end:** title present on boards 1 and 2, absent on 3 → `animations.title.out?.presetId` is set and the window ends at board 2's hold-end.
- **Wired layer skipped:** a `kind: 'wired'` layer with poses on both boards produces NO entry in `animations`.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/lib/frame/storyboard/compile.ts frontend/tests/unit/storyboard-compile.unit.spec.ts
git commit -m "feat(frame): storyboard compiler → keyframes + frame motion"
```

---

### Task 6: Editor storage + undo

**Files:**
- Modify: `frontend/app/composables/useLocalLayerEditor.ts`
- Test: `frontend/tests/unit/storyboard-composable.unit.spec.ts` (create; extended in Task 7)

**Interfaces:**
- Consumes: `Storyboard` (Task 1).
- Produces on the editor's returned object: `storyboard: ComputedRef<Storyboard | null>` (reads `node().data.properties.sailor_storyboard`), `writeStoryboard(next: Storyboard | null): void` (writes the property; part of the same commit choke point); the existing `Snapshot`/`snapshot()`/`restore()` now carry `storyboard`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/storyboard-composable.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { reactive } from 'vue'
import { createStoryboard } from '~/lib/frame/storyboard/types'
import { useLocalLayerEditor } from '~/composables/useLocalLayerEditor'

// REAL signature: useLocalLayerEditor({ node, dims, getRect, ... }). The node MUST
// be reactive() or the composable's computeds never invalidate on commit() writes.
function makeEditor(layers: any[] = []) {
  const node = reactive<any>({ data: { properties: { sailor_localLayers: layers } } })
  const ed = useLocalLayerEditor({
    node: () => node,
    dims: () => ({ w: 1000, h: 1000 }),
    getRect: () => null,
  })
  return { node, ed }
}

describe('editor storyboard storage + undo', () => {
  it('writeStoryboard round-trips through node properties', () => {
    const { node, ed } = makeEditor()
    ed.writeStoryboard(createStoryboard('b1'))
    expect(ed.storyboard.value?.boards).toHaveLength(1)
    expect(node.data.properties.sailor_storyboard.current).toBe('b1')
  })
  it('undo restores the previous storyboard', () => {
    const { ed } = makeEditor()
    ed.writeStoryboard(createStoryboard('b1'))
    ed.recordHistory()
    const sb2 = createStoryboard('b1'); sb2.boards.push({ id: 'b2', hold: 1, poses: {}, loops: [] })
    ed.writeStoryboard(sb2)
    ed.undo()
    expect(ed.storyboard.value?.boards).toHaveLength(1)
  })
})
```

Note: `EditorOpts` may declare more optional callbacks (`wiredDims?`, a host content resolver) — they are optional; the three required ones above are enough for the unit harness. Confirm the exact returned key names (`localLayers`, `commit`, `recordHistory`, `undo`, `snapshot`, `restore`, `selectedId`) from the composable's final `return { … }` block; the plan assumes these exist (verified at HEAD 2026-09-13).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/storyboard-composable.unit.spec.ts`
Expected: FAIL — `writeStoryboard`/`storyboard` do not exist.

- [ ] **Step 3: Implement**

In `frontend/app/composables/useLocalLayerEditor.ts`:

1. Add imports: `import type { Storyboard } from '~/lib/frame/storyboard/types'`.
2. Add a `storyboard` computed next to `localLayers`:
```ts
const storyboard = computed<Storyboard | null>(() =>
  (node()?.data?.properties?.sailor_storyboard as Storyboard) ?? null)
function writeStoryboard(next: Storyboard | null) {
  const n = node(); if (!n) return
  if (!n.data.properties) n.data.properties = {}
  if (next) n.data.properties.sailor_storyboard = next
  else delete n.data.properties.sailor_storyboard
}
```
3. Search for `type Snapshot = {` and add `storyboard: Storyboard | null` to it; in `function snapshot()` add `storyboard: storyboard.value ? JSON.parse(JSON.stringify(storyboard.value)) : null`.
4. Search for `function restore(` and add `writeStoryboard(s.storyboard)` inside it.
5. Add `storyboard` and `writeStoryboard` to the composable's final `return { … }` object.

Note: do NOT rely on any line number — the file moved since this plan was drafted (effects programme F1–F5). Anchor every edit on a search string.

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run tests/unit/storyboard-composable.unit.spec.ts`
Expected: PASS. Also run the existing editor spec (`tests/**/*useLocalLayerEditor*` or `*localLayer*`) — Expected: unchanged.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/composables/useLocalLayerEditor.ts frontend/tests/unit/storyboard-composable.unit.spec.ts
git commit -m "feat(frame): editor stores storyboard, folded into undo"
```

---

### Task 7: Storyboard composable (board ops, materialise/capture, recompile, delete-scoping)

**Files:**
- Create: `frontend/app/composables/useStoryboard.ts`
- Test: `frontend/tests/unit/storyboard-composable.unit.spec.ts` (extend)

**Interfaces:**
- Consumes: the editor object from Task 6 (`localLayers`, `commit`, `storyboard`, `writeStoryboard`, `recordHistory`, `setMotion`-equivalent). Because `setMotion` lives in `CompositorModal.vue`, the composable takes a `writeMotion(motion)` callback and an `applyAnimations(map)` callback (which writes each layer's `.animation`).
- Produces: `useStoryboard(deps)` returning:
  - `boards`, `current` (computed)
  - `hasStoryboard` (computed)
  - `addBoard()` — creates the record on first call (duplicating the live board), else appends a duplicate of the current board; selects the new board
  - `selectBoard(id)` — captures current poses into the outgoing board, applies the incoming board's poses to the live layers, sets `current`
  - `duplicateBoard(id)`, `deleteBoard(id)`, `reorderBoards(from, to)`
  - `deleteFromBoard(layerId)` — removes the pose from the current board (board-scoped delete); if only one board exists, returns `false` so the caller does the normal layer delete
  - internal `recompile()` — runs `compileStoryboard`, calls `applyAnimations` + `writeMotion`; called after every mutation
- All mutations call `recordHistory()` once, then mutate, then `recompile()`.

- [ ] **Step 1: Write the failing tests** (append)

```ts
import { reactive } from 'vue'
import { useStoryboard } from '~/composables/useStoryboard'

function harness() {
  const node = reactive<any>({ data: { properties: { sailor_localLayers: [
    { id: 'title', kind: 'text', x: 0.5, y: 0.5, rotation: 0, opacity: 1, text: 'X',
      fontFamily: 'Inter', fontWeight: 700, fontSize: 0.2, color: '#111', align: 'left', lineHeight: 1, strokeColor: '', strokeWidth: 0 },
  ] } } }
  const ed = useLocalLayerEditor({ node: () => node, dims: () => ({ w: 1000, h: 1000 }), getRect: () => null })
  const motions: any[] = []; const animMaps: any[] = []
  const sbApi = useStoryboard({
    editor: ed,
    writeMotion: (m: any) => motions.push(m),
    applyAnimations: (map: any) => animMaps.push(map),
  })
  return { node, ed, sbApi, motions, animMaps }
}
// NOTE the reactive() node: without it, ed.localLayers/ed.storyboard are cached
// computeds that never see commit()'s writes, and selectBoard's capture reads stale.

describe('useStoryboard', () => {
  it('addBoard creates the record and a second board that duplicates the first', () => {
    const { ed, sbApi } = harness()
    sbApi.addBoard()
    expect(ed.storyboard.value?.boards).toHaveLength(2)
    // both boards carry the title pose
    expect(ed.storyboard.value!.boards[0]!.poses.title).toBeTruthy()
    expect(ed.storyboard.value!.boards[1]!.poses.title).toBeTruthy()
  })
  it('selectBoard captures live poses into the outgoing board then applies the incoming', () => {
    const { ed, node, sbApi } = harness()
    sbApi.addBoard()                       // now on board 2
    node.data.properties.sailor_localLayers[0].x = 0.1   // user nudges on board 2
    sbApi.selectBoard(ed.storyboard.value!.boards[0]!.id) // back to board 1
    expect(ed.storyboard.value!.boards[1]!.poses.title!.x).toBeCloseTo(0.1, 5) // captured into board 2
    expect(node.data.properties.sailor_localLayers[0].x).toBeCloseTo(0.5, 5)   // board 1 pose restored
  })
  it('recompile runs after a mutation (writeMotion + applyAnimations called)', () => {
    const { sbApi, motions, animMaps } = harness()
    sbApi.addBoard()
    expect(motions.length).toBeGreaterThan(0)
    expect(animMaps.length).toBeGreaterThan(0)
  })
  it('deleteFromBoard removes the pose on this board only when >1 board', () => {
    const { ed, sbApi } = harness()
    sbApi.addBoard()
    const ok = sbApi.deleteFromBoard('title')
    expect(ok).toBe(true)
    const cur = ed.storyboard.value!.boards.find(b => b.id === ed.storyboard.value!.current)!
    expect(cur.poses.title).toBeUndefined()
  })
  it('deleteFromBoard returns false with a single board (caller does normal delete)', () => {
    const { sbApi } = harness()
    expect(sbApi.deleteFromBoard('title')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/storyboard-composable.unit.spec.ts`
Expected: FAIL — cannot resolve `useStoryboard`.

- [ ] **Step 3: Implement**

```ts
// frontend/app/composables/useStoryboard.ts
import { computed } from 'vue'
import { createStoryboard, createBoard, type Storyboard, type Board } from '~/lib/frame/storyboard/types'
import { capturePoses, applyPoses } from '~/lib/frame/storyboard/poses'
import { compileStoryboard } from '~/lib/frame/storyboard/compile'
import type { FrameMotion } from '~/lib/motion/types'
import type { LayerAnimation, LocalLayer } from '~/composables/useCompositorLayers'

interface Deps {
  editor: {
    localLayers: { value: LocalLayer[] }
    commit: (next: LocalLayer[]) => void
    storyboard: { value: Storyboard | null }
    writeStoryboard: (sb: Storyboard | null) => void
    recordHistory: () => void
  }
  writeMotion: (m: FrameMotion) => void
  applyAnimations: (map: Record<string, LayerAnimation>) => void
}

let seq = 0
const mintBoardId = () => `bd-${Date.now().toString(36)}-${(seq++).toString(36)}`

export function useStoryboard(deps: Deps) {
  const { editor } = deps
  const storyboard = computed(() => editor.storyboard.value)
  const boards = computed(() => storyboard.value?.boards ?? [])
  const current = computed(() => storyboard.value?.current ?? null)
  const hasStoryboard = computed(() => (storyboard.value?.boards.length ?? 0) > 0)

  function recompile() {
    const sb = editor.storyboard.value
    if (!sb) return
    const { animations, motion } = compileStoryboard(editor.localLayers.value, sb)
    deps.applyAnimations(animations)
    deps.writeMotion(motion)
  }

  // capture the live layers into the CURRENT board's poses (no history/recompile)
  function captureCurrent(sb: Storyboard) {
    const b = sb.boards.find(x => x.id === sb.current)
    if (b) b.poses = capturePoses(editor.localLayers.value)
  }

  function addBoard() {
    editor.recordHistory()
    let sb = editor.storyboard.value
    if (!sb) {
      // first call: create with the live layers as board 1's poses
      sb = createStoryboard(mintBoardId())
      sb.boards[0]!.poses = capturePoses(editor.localLayers.value)
      sb.boards[0]!.transition = { duration: 0.6, ease: { kind: 'named', name: 'smooth' }, entries: {}, exits: {} }
    } else {
      captureCurrent(sb)
    }
    const dupFrom = sb.boards.find(b => b.id === sb!.current) ?? sb.boards[sb.boards.length - 1]!
    const nb: Board = { id: mintBoardId(), hold: dupFrom.hold, loops: [],
      poses: JSON.parse(JSON.stringify(dupFrom.poses)) }
    // give the previous last board a transition into this one
    const prev = sb.boards[sb.boards.length - 1]!
    if (!prev.transition) prev.transition = { duration: 0.6, ease: { kind: 'named', name: 'smooth' }, entries: {}, exits: {} }
    sb.boards.push(nb)
    sb.current = nb.id
    editor.writeStoryboard(sb)
    editor.commit(applyPoses(editor.localLayers.value, nb.poses))
    recompile()
  }

  function selectBoard(id: string) {
    const sb = editor.storyboard.value
    if (!sb || sb.current === id) return
    editor.recordHistory()
    captureCurrent(sb)                                   // save outgoing
    sb.current = id
    editor.writeStoryboard(sb)
    const target = sb.boards.find(b => b.id === id)!
    editor.commit(applyPoses(editor.localLayers.value, target.poses))
    recompile()
  }

  function duplicateBoard(id: string) {
    const sb = editor.storyboard.value; if (!sb) return
    editor.recordHistory(); captureCurrent(sb)
    const src = sb.boards.find(b => b.id === id); if (!src) return
    const nb: Board = { id: mintBoardId(), hold: src.hold, loops: [],
      poses: JSON.parse(JSON.stringify(src.poses)),
      transition: src.transition ? JSON.parse(JSON.stringify(src.transition)) : undefined }
    const at = sb.boards.findIndex(b => b.id === id)
    sb.boards.splice(at + 1, 0, nb)
    editor.writeStoryboard(sb); recompile()
  }

  function deleteBoard(id: string) {
    const sb = editor.storyboard.value; if (!sb || sb.boards.length <= 1) return
    editor.recordHistory()
    const at = sb.boards.findIndex(b => b.id === id)
    sb.boards.splice(at, 1)
    if (sb.current === id) sb.current = sb.boards[Math.max(0, at - 1)]!.id
    editor.writeStoryboard(sb)
    editor.commit(applyPoses(editor.localLayers.value, sb.boards.find(b => b.id === sb.current)!.poses))
    recompile()
  }

  function reorderBoards(from: number, to: number) {
    const sb = editor.storyboard.value; if (!sb) return
    editor.recordHistory(); captureCurrent(sb)
    const [m] = sb.boards.splice(from, 1); sb.boards.splice(to, 0, m!)
    editor.writeStoryboard(sb); recompile()
  }

  function deleteFromBoard(layerId: string): boolean {
    const sb = editor.storyboard.value
    if (!sb || sb.boards.length <= 1) return false
    editor.recordHistory(); captureCurrent(sb)
    const cur = sb.boards.find(b => b.id === sb.current)!
    delete cur.poses[layerId]
    editor.writeStoryboard(sb); recompile()
    return true
  }

  return { boards, current, hasStoryboard, addBoard, selectBoard, duplicateBoard,
    deleteBoard, reorderBoards, deleteFromBoard, recompile }
}
```

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run tests/unit/storyboard-composable.unit.spec.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/composables/useStoryboard.ts frontend/tests/unit/storyboard-composable.unit.spec.ts
git commit -m "feat(frame): storyboard composable — boards, materialise, recompile"
```

---

### Task 8: Story tab (left panel)

**Files:**
- Create: `frontend/app/components/vue-canvas/compositor/StoryPanel.vue`
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` (mount the tab + wire `useStoryboard`)
- Test: manual/visual (covered by E2E in Task 11); no unit test for the SFC.

**Interfaces:**
- Consumes: `useStoryboard` API (Task 7); the modal's `inspectorTab` ref (search `inspectorTab`); `setMotion` (search `function setMotion`); the editor's per-layer `.animation` writer.
- Produces: a `'story'` value on the left-panel tab; `StoryPanel` emits `select-board`, `add-board`, and (slice 2) transition/ease edits.

The visual target is `.superpowers/brainstorm/78992-1788970762/content/story-tab-v3.html`. Reproduce the left-panel structure: a toolbar (play/pause, `mm:ss.d / mm:ss.d`, "Loop back" toggle), then a vertical list alternating board rows and transition rows, with a playhead rail down the left.

- [ ] **Step 1: Wire `useStoryboard` in `CompositorModal.vue`**

Near where the editor is created, add:
```ts
import { useStoryboard } from '~/composables/useStoryboard'
// setMotion(patch) already exists — search for `function setMotion` in the modal.
const story = useStoryboard({
  editor: layerEditor,   // the object returned by useLocalLayerEditor — match its real local name
  writeMotion: (m) => setMotion(m),   // setMotion merges: {...motionDoc.value, ...patch}, so {fps,duration} sets both
  applyAnimations: (map) => {
    // write each layer's .animation through the editor's commit choke point.
    // Skip wired layers (they are static in slice 1 and their transform write-through
    // to the backend must not be driven by .animation).
    const next = layerEditor.localLayers.value.map(l => {
      if (l.kind === 'wired') return l
      if (map[l.id]) return { ...l, animation: map[l.id] }
      return l.animation ? { ...l, animation: undefined } : l
    })
    layerEditor.commit(next)
  },
})
```
Confirm the real editor variable name (search the modal for `useLocalLayerEditor(`) and that `setMotion` merges into `motionDoc` (search `function setMotion`). Also confirm the modal exposes `storyboard` from the editor for Tasks 9–10 — if not, add `const storyboard = computed(() => layerEditor.storyboard.value)`.

- [ ] **Step 2: Add a `'story'` tab button**

The left panel already has a tab strip (Layers / Templates). Add a "Story" button that sets the left tab to `'story'`. Find the existing left-tab ref (search for the Layers/Templates tab state in `CompositorModal.vue`) and extend its union with `'story'`. Add:
```html
<button :class="leftTab === 'story' ? activeClass : idleClass" @click="leftTab = 'story'">Story</button>
```

- [ ] **Step 3: Create `StoryPanel.vue`**

```vue
<!-- frontend/app/components/vue-canvas/compositor/StoryPanel.vue -->
<script setup lang="ts">
import { computed } from 'vue'
import type { Board } from '~/lib/frame/storyboard/types'
const props = defineProps<{
  boards: Board[]; current: string | null; playheadT: number; duration: number; playing: boolean; loopBack: boolean
}>()
const emit = defineEmits<{
  (e: 'select-board', id: string): void
  (e: 'add-board'): void
  (e: 'toggle-play'): void
  (e: 'toggle-loop'): void
  (e: 'scrub', t: number): void
}>()
const fmt = (s: number) => {
  const m = Math.floor(s / 60); const sec = (s % 60)
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`
}
// interleave board / transition rows
const rows = computed(() => props.boards.flatMap((b, i) => {
  const r: any[] = [{ kind: 'board', board: b, index: i }]
  if (i < props.boards.length - 1 || props.loopBack) r.push({ kind: 'trans', board: b, index: i })
  return r
}))
</script>

<template>
  <div class="flex flex-col h-full text-white">
    <div class="flex items-center gap-2 px-2 py-2 text-white/60 text-[12px]">
      <button class="w-6 h-6 rounded bg-white/10 grid place-items-center" @click="emit('toggle-play')">
        {{ playing ? '❚❚' : '▶' }}
      </button>
      <span class="tabular-nums">{{ fmt(playheadT) }} / {{ fmt(duration) }}</span>
      <button class="ml-auto px-2 py-0.5 rounded-full border border-white/10"
        :class="loopBack ? 'text-white bg-white/10' : ''" @click="emit('toggle-loop')">Loop back</button>
    </div>
    <div class="flex-1 overflow-auto px-2 pb-2">
      <template v-for="row in rows" :key="row.kind + row.board.id">
        <div v-if="row.kind === 'board'"
          class="grid grid-cols-[64px_1fr] gap-2 p-2 mb-1.5 rounded-[10px] border"
          :class="row.board.id === current ? 'border-[--action] bg-[--action]/10' : 'border-white/10 bg-white/[0.04]'"
          @click="emit('select-board', row.board.id)">
          <div class="w-16 h-20 rounded bg-[#efe9dc]"><!-- thumbnail: rendered still, wired in a follow-up --></div>
          <div class="flex flex-col gap-1 min-w-0">
            <div class="font-semibold flex items-center gap-1.5">Board {{ row.index + 1 }}</div>
            <div class="inline-flex items-center gap-1.5 text-white/60">Hold
              <span class="px-1.5 py-0.5 rounded bg-white/10 tabular-nums">{{ row.board.hold.toFixed(1) }}s</span>
            </div>
          </div>
        </div>
        <div v-else class="ml-1.5 pl-2 py-1.5 border-l-2 border-white/10 text-white/60 text-[11.5px]">
          Transition
          <span class="px-1.5 py-0.5 rounded bg-white/10 tabular-nums ml-1">
            {{ (row.board.transition?.duration ?? 0).toFixed(1) }}s</span>
          <!-- entries/exits lines + ease chip land with the compile read-back; slice 2 makes them editable -->
        </div>
      </template>
      <button class="mt-1 w-full p-2 rounded-[10px] border border-dashed border-white/20 text-white/60"
        @click="emit('add-board')">＋ Add board</button>
    </div>
  </div>
</template>
```

- [ ] **Step 4: Mount it in the modal's left panel**

Inside the left-panel `v-if="leftTab === 'story'"` block:
```html
<StoryPanel
  :boards="story.boards.value" :current="story.current.value"
  :playhead-t="previewT ?? 0" :duration="effectiveMotion.duration" :playing="isPlaying"
  :loop-back="storyboard?.loopBack ?? false"
  @add-board="story.addBoard()" @select-board="story.selectBoard($event)"
  @toggle-play="togglePlay()" @toggle-loop="story.toggleLoopBack()" @scrub="scrubTo($event)" />
```
(Use the modal's real playhead ref name — earlier code shows `previewT` and `scrubTo`; confirm and match. `togglePlay`/`isPlaying`: match the modal's real play state.)

Add `toggleLoopBack()` to `useStoryboard` (Task 7): `recordHistory(); sb.loopBack = !sb.loopBack; writeStoryboard(sb); recompile()` — and add it to the returned object. (Small addition; fold into Task 7 if executing in order.)

- [ ] **Step 5: Verify the tab renders and Add board works, then commit**

Run the dev server per CLAUDE.md (check `lsof` first; use `:3002`), open a Frame, switch to Story, press Add board twice, drag the title, press play. The piece should animate. If the preview does not update, confirm `applyAnimations` writes `.animation` and `setMotion` sets the duration.

```bash
git add frontend/app/components/vue-canvas/compositor/StoryPanel.vue frontend/app/components/vue-canvas/CompositorModal.vue
git commit -m "feat(frame): Story tab — boards, add board, materialise on select"
```

---

### Task 9: Docked timeline (read + select)

**Files:**
- Create: `frontend/app/components/vue-canvas/compositor/StoryboardTimeline.vue`
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` (dock it under the canvas while a storyboard exists)
- Test: E2E (Task 11).

**Interfaces:**
- Consumes: the compiled per-layer `animation` on each `LocalLayer`; board start times (recompute locally via the same cumulative formula, or expose `boardTimes` from `compile.ts` — export it and import here); `previewT`/`scrubTo` from the modal.
- Produces: emits `select-move` (`{ layerId, slot: 'in'|'out'|'keyframe' }`) to flip the inspector to Motion; emits `scrub`.

Visual target: the docked timeline block in the v3 mockup — a two-tier ruler with board markers `B1/B2/B3`, one lane per layer with an on-screen band, keyframe diamonds, shaded transition spans and In/Out pills, a playhead line, and a collapse control.

- [ ] **Step 1: Export `boardTimes` from `compile.ts`**

Change `function boardTimes` to `export function boardTimes` (Task 5 file). Add a unit assertion in `storyboard-compile.unit.spec.ts` that `boardTimes(sb).start` matches the cumulative formula for a 3-board doc. Run it.

- [ ] **Step 2: Create `StoryboardTimeline.vue`**

```vue
<!-- frontend/app/components/vue-canvas/compositor/StoryboardTimeline.vue -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { boardTimes } from '~/lib/frame/storyboard/compile'
import type { Storyboard } from '~/lib/frame/storyboard/types'
import type { LocalLayer } from '~/composables/useCompositorLayers'
const props = defineProps<{
  storyboard: Storyboard; layers: LocalLayer[]; playheadT: number; duration: number
}>()
const emit = defineEmits<{
  (e: 'select-move', p: { layerId: string; slot: 'in' | 'out' | 'keyframe' }): void
  (e: 'scrub', t: number): void
}>()
const collapsed = ref(false)
const times = computed(() => boardTimes(props.storyboard))
const pct = (t: number) => `${(t / Math.max(1e-6, props.duration)) * 100}%`
const lanes = computed(() => props.layers.filter(l => l.animation).map(l => ({ id: l.id, name: l.name ?? l.kind, anim: l.animation! })))
function onRulerClick(e: MouseEvent) {
  const el = e.currentTarget as HTMLElement
  const x = (e.clientX - el.getBoundingClientRect().left) / el.clientWidth
  emit('scrub', x * props.duration)
}
</script>

<template>
  <div class="bg-[#0f0f12] border-t border-white/10 px-3 pt-2 pb-1.5 text-white/70">
    <div class="flex items-center gap-2.5 text-[11px] mb-1">
      <span>Timeline</span>
      <span class="px-1.5 py-0.5 rounded bg-white/10 tabular-nums">{{ playheadT.toFixed(1) }}s</span>
      <button class="ml-auto px-2 py-0.5 rounded bg-white/[0.06]" @click="collapsed = !collapsed">
        {{ collapsed ? 'Expand' : 'Collapse' }}</button>
    </div>
    <div v-show="!collapsed">
      <div class="relative h-6 border-b border-white/10 cursor-pointer" @click="onRulerClick">
        <template v-for="(s, i) in times.start" :key="i">
          <div class="absolute top-0 bottom-0 w-px bg-[--action]/60" :style="{ left: pct(s) }"></div>
          <span class="absolute top-0 -translate-x-1/2 text-[--action] font-semibold text-[10px] bg-[#0f0f12] px-0.5"
            :style="{ left: pct(s) }">B{{ i + 1 }}</span>
        </template>
      </div>
      <div v-for="lane in lanes" :key="lane.id" class="grid grid-cols-[110px_1fr] h-[22px] items-center odd:bg-white/[0.02]">
        <div class="text-white/50 pl-1.5 truncate">{{ lane.name }}</div>
        <div class="relative h-full">
          <div class="absolute top-1 h-3.5 rounded bg-white/80"
            :style="{ left: pct(lane.anim.offset ?? 0), width: pct(lane.anim.duration ?? duration) }"></div>
          <div v-if="lane.anim.in" class="absolute top-[7px] w-2 h-2 bg-[--action] rotate-45 cursor-pointer"
            :style="{ left: pct(lane.anim.offset ?? 0) }"
            @click="emit('select-move', { layerId: lane.id, slot: 'in' })"></div>
          <div v-if="lane.anim.out" class="absolute top-[7px] w-2 h-2 bg-[--action] rotate-45 cursor-pointer"
            :style="{ left: pct((lane.anim.offset ?? 0) + (lane.anim.duration ?? duration)) }"
            @click="emit('select-move', { layerId: lane.id, slot: 'out' })"></div>
          <div class="absolute top-0 bottom-0 w-px bg-[--action]" :style="{ left: pct(playheadT) }"></div>
        </div>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 3: Dock it under the canvas**

In `CompositorModal.vue`, under the stage area, add (only when a storyboard exists and the Story tab is active, so it does not steal canvas height from ordinary Frames):
```html
<StoryboardTimeline v-if="storyboard && leftTab === 'story'"
  :storyboard="storyboard" :layers="layerEditor.localLayers.value"
  :playhead-t="previewT ?? 0" :duration="effectiveMotion.duration"
  @scrub="scrubTo($event)" @select-move="onSelectMove" />
```
Add the handler:
```ts
function onSelectMove(p: { layerId: string; slot: 'in' | 'out' | 'keyframe' }) {
  selectedId.value = p.layerId
  inspectorTab.value = 'motion'
}
```

- [ ] **Step 4: Verify + commit**

Dev-server check: with two boards and a moving title, the lane shows a band and the playhead tracks play. Clicking an In pill selects the layer and flips the inspector to Motion.

```bash
git add frontend/app/components/vue-canvas/compositor/StoryboardTimeline.vue frontend/app/components/vue-canvas/CompositorModal.vue frontend/app/lib/frame/storyboard/compile.ts frontend/tests/unit/storyboard-compile.unit.spec.ts
git commit -m "feat(frame): docked storyboard timeline (read + select)"
```

---

### Task 10: Inspector split + board-scoped delete + node/bake proof

**Files:**
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue`
- Test: E2E (Task 11) covers delete-scoping; a small unit already covers `deleteFromBoard` (Task 7).

- [ ] **Step 1: Route delete to board-scope when a storyboard exists**

Find the modal's layer-delete handler (the Backspace/Delete key path and the layer-panel delete). Wrap it:
```ts
function deleteSelectedLayer() {
  if (storyboard.value && story.deleteFromBoard(selectedId.value!)) return // removed from this board only
  // ... existing full-delete path unchanged ...
}
```
When `deleteFromBoard` returns `false` (single board), the existing full delete runs.

- [ ] **Step 2: Split the Design inspector into "On this board" / "Every board"**

In the Design side of the inspector, when a storyboard exists, group the selected layer's controls: position, size, rotation, opacity and (solid) colour under a **"…on this board"** heading; everything else (text, font, tracking, effects, strokes) under **"…every board"**. This is a presentational regroup of existing controls — no new control logic. Use the exact field split from `POSE_KEYS` (Task 2) to decide which controls sit in the board group.

- [ ] **Step 3: Confirm the node tile and video bake consume the compiled record**

No code change expected: `paintLayerStack(ctx, W, H, ..., t)` and `bakeMotion()` already read each layer's `.animation` and the frame motion. Verify by baking a two-board Frame to video (footer "Generate as video") and scrubbing the node card on the canvas — the piece animates. If the node tile shows a still, confirm `effectiveMotion` picks up the storyboard's `setMotion` duration.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/components/vue-canvas/CompositorModal.vue
git commit -m "feat(frame): board-scoped delete + inspector board/shared split"
```

---

### Task 11: End-to-end proof

**Files:**
- Create: `frontend/tests/frame-storyboard.spec.ts`
- Uses: `/dev/frame-lab` (`window.__frameLab`).

**Interfaces:**
- Consumes: the real Compositor mounted at `/dev/frame-lab`; `window.__frameLab.reset()` / `.save()`.

- [ ] **Step 1: Write the E2E**

```ts
// frontend/tests/frame-storyboard.spec.ts
import { test, expect } from '@playwright/test'

test('storyboard: add board, move title, midpoint shows it between poses', async ({ page }) => {
  await page.goto('/dev/frame-lab')
  await page.evaluate(() => (window as any).__frameLab.reset())
  // open the Frame, seed a title, switch to Story, add a board, nudge the title up, play to the midpoint.
  // Drive via the real UI (buttons/drags), not synthetic pointer events on the canvas where avoidable.
  // Assert: at the midpoint the title's rendered centre-Y sits between board 1 and board 2 positions.
  // Pixel approach: sample the composited canvas at t=0, t=mid, t=end; the title's bright band moves up.
  const shot = async () => (await page.locator('canvas#frame-preview').screenshot())
  // ... follow the frame-templates.spec.ts pattern for canvas readback + a control run with no storyboard.
  expect(true).toBe(true) // replace with the real pixel assertions below
})
```

- [ ] **Step 2: Fill in the real assertions**

Model on `frontend/tests/frame-templates.spec.ts` (same harness): mount, seed layers via `__frameLab`, drive the Story tab, scrub via the timeline ruler, screenshot the preview canvas at three times, and assert the title's vertical centroid decreases from t=0 to t=end (it moves up), with a no-storyboard control run pinning the noise floor. Add a second case: an element absent on board 1 and present on board 2 is invisible at t=0 and visible at t=end (mean-alpha in its region rises).

- [ ] **Step 3: Run the E2E**

Run: `cd frontend && npx playwright test tests/frame-storyboard.spec.ts`
Expected: PASS. (Per CLAUDE.md, if the E2E subagent starts its own dev server it must use `PORT=3002` and must not kill the shared server; confirm the port with `curl`, not the Vite log.)

- [ ] **Step 4: Commit**

```bash
git add frontend/tests/frame-storyboard.spec.ts
git commit -m "test(frame): storyboard end-to-end on the real Compositor"
```

---

## Self-Review

**Spec coverage:**
- Boards inside one Frame, one cast/many poses → Tasks 1, 2, 7. ✓
- Materialise/capture keeps tools board-unaware → Task 7 `selectBoard`/`applyPoses`. ✓
- Compile: cumulative timing, travel, entries/exits, interior gap, short-arc, loop-back, duration → Task 5. ✓
- Engine additions (scaleX/scaleY, colour OKLCH, ease vocabulary, non-uniform scale in paint) → Tasks 3, 4. Frame **background** colour interpolation between boards is specced for slice 1 but only the per-layer path is built here; **added note:** board `bg` interpolation is deferred to the Task 10 background wiring — if not implemented there, it carries to slice 2. Flag to reviewer.
- Story tab (vertical, board/transition rows) → Task 8. ✓
- Docked timeline (read/select, board markers, collapse) → Task 9. ✓
- Inspector split, board-scoped delete, node tile + bake → Task 10. ✓
- Undo folds storyboard into history → Task 6. ✓
- Persistence at `sailor_storyboard` → Task 6. ✓
- E2E on the real Compositor → Task 11. ✓
- Wired layers static across boards → **RESOLVED in the hardening pass:** the compiler skips `kind === 'wired'` (Task 5) AND `applyAnimations` leaves wired layers untouched (Task 8), so their backend transform write-through is never driven by `.animation`.

**Placeholder scan:** the two thumbnail/entries-line spots in Tasks 8/9 are explicitly marked as follow-ups within slice 1's read-only timeline; they are not blocking behaviour. The E2E body (Task 11 Step 1) is a scaffold completed in Step 2 against the frame-templates pattern — acceptable because the exact pixel assertions depend on the harness's real canvas id, which the implementer confirms live.

**Type consistency:** `Storyboard`/`Board`/`Pose`/`Transition`/`EntryExit` are used identically across Tasks 1–10. `compileStoryboard` return shape `{ animations, motion }` matches Task 7's `recompile`. `POSE_KEYS` drives both Task 2 and the Task 10 inspector split. `boardTimes` is exported in Task 5 Step... (Task 9 Step 1) and consumed in Task 9.

**Open flags for the executing session (resolve as they arise, do not block):**
1. Confirm the real local variable name of the `useLocalLayerEditor(...)` result in `CompositorModal.vue` and the real left-tab state ref before Tasks 8–10.
2. Confirm `scaleX`/`scaleY` are read in `drawLayerWithMotion`'s ctx transform (Task 4 note); wire them if not.
3. Board `bg` interpolation (background colour across boards) — decide in Task 10 or defer to slice 2.
