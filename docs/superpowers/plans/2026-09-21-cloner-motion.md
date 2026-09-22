# Cloner Motion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Duplicating a Frame layer keeps its Motion-tab work; a cloned layer's copies can stagger their motion; the Cloner's dials are motion properties with five gallery tiles.

**Architecture:** Three independent pure cores (`duplicateMotion.ts`, `copies.ts`, cloner properties in `adapter/frame.ts` + `behaviour.ts`) each wired into one seam (the layer editor, `paintLayerStack`, the property picker / gallery). Spec: `docs/superpowers/specs/2026-09-21-cloner-motion-design.md`.

**Tech Stack:** Nuxt 4 / Vue 3 / TypeScript, vitest (`npm run test:unit -- <pattern>` from `frontend/`), Studio control family.

## Global Constraints

- Work in the main checkout; no worktree, no branch. Never `git stash`, never `git add -A`, never `git checkout --` / `git restore` / `git reset --hard`. Never start, stop or restart a dev server. Commit with a PRIVATE index, ONE shell call: `GIT_INDEX_FILE=$(mktemp); export GIT_INDEX_FILE; git read-tree HEAD; git add -- <paths>; git commit -q -m '…'; rm -f "$GIT_INDEX_FILE"; unset GIT_INDEX_FILE; git reset -q -- <same paths>` then `git show --stat HEAD`. Commit body ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Stage only your own paths. Other sessions have uncommitted edits in this checkout — leave every file you did not write alone.
- Every default is the identity: a Frame saved before this renders byte-for-byte as before. Stagger 0 / no cloner must take the EXISTING code path, not a re-implementation.
- UI copy: sentence case, no identifiers. Controls: `StudioSlider`, `StudioSelect`, `StudioSegmentedRow` (label in the row), `StudioSwitch`, `StudioButton` from `app/components/vue-canvas/studio/`. Section titles use the `mi-heading` class pattern of `MotionInspector.vue`.
- ONE BEHAVIOUR = ONE PROPERTY (`behaviour.ts`): every compiler emits exactly one track. Multi-property moves are gallery RECIPES.
- SFC safety: a `.vue` file that fails to compile for ONE save kills the dev server's worker permanently. Make single, valid edits; run `npx vue-tsc --noEmit -p tsconfig.json 2>&1 | grep <file>` (the file has 6 pre-existing errors in `CompositorModal.vue`; none may be added) after each `.vue` edit.
- Read vitest's "Test Files" line as well as "Tests" — a spec with a syntax error runs zero tests.
- Motion-tab UI only: never add motion controls to the Design tab's cloner panel.

---

### Task 1: `motionForCopies` — the pure re-target

**Files:**
- Create: `frontend/app/lib/motionx/adapter/duplicateMotion.ts`
- Modify: `frontend/app/lib/compositor/layerEdits.ts:45-69` (`duplicateLayers` returns `idMap`)
- Test: `frontend/tests/unit/motionx/duplicate-motion.unit.spec.ts`, `frontend/tests/unit/layer-edits.unit.spec.ts`

**Interfaces:**
- Produces: `motionForCopies(motion, idMap, newBehaviourId)` as in the spec; `duplicateLayers(...)` return gains `idMap: Map<string, string>`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/motionx/duplicate-motion.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { motionForCopies } from '~/lib/motionx/adapter/duplicateMotion'

const ids = () => { let n = 0; return () => `b${++n}` }
const band = (id: string, prop: string, behaviourId?: string) => ({
  path: `layers.${id}.${prop}`, type: 'number' as const,
  keyframes: [{ t: 0, value: 0, ease: 'linear' as const }, { t: 1, value: 1 }], ...(behaviourId ? { behaviourId } : {}),
})

describe('motionForCopies', () => {
  const motion = {
    motionx: [band('a', 'opacity', 'bh1'), band('a', 'reveal', 'bh2'), band('z', 'x')],
    behaviours: [
      { id: 'bh1', kind: 'fade', layerId: 'a', timing: { start: 0, duration: 1 }, params: { dir: 'in' } },
      { id: 'bh2', kind: 'settle', layerId: 'a', timing: { start: 0.5, duration: 1 }, params: { effect: 'slice' } },
      { id: 'bh9', kind: 'fade', layerId: 'z', timing: { start: 0, duration: 1 } },
    ],
    tracks: [{ target: 'layers.a.effects.fx1.amount', keyframes: [{ t: 0, v: 1 }] }, { target: 'layers.z.effects.fx1.amount', keyframes: [] }],
  }
  const idMap = new Map([['a', 'a2']])

  it('re-targets every band, behaviour and dial track of a mapped layer, and nothing else', () => {
    const r = motionForCopies(motion as any, idMap, ids())
    expect(r.motionx.map((t) => t.path)).toEqual(['layers.a2.opacity', 'layers.a2.reveal'])
    expect(r.behaviours.map((b) => b.layerId)).toEqual(['a2', 'a2'])
    expect(r.tracks.map((t) => t.target)).toEqual(['layers.a2.effects.fx1.amount'])
  })
  it('gives behaviours fresh ids and keeps each compiled track pointing at its copy', () => {
    const r = motionForCopies(motion as any, idMap, ids())
    expect(r.behaviours.map((b) => b.id)).toEqual(['b1', 'b2'])
    expect(r.motionx.map((t) => t.behaviourId)).toEqual(['b1', 'b2'])
    expect(r.behaviours[1]).toMatchObject({ kind: 'settle', timing: { start: 0.5, duration: 1 }, params: { effect: 'slice' } })
  })
  it('deep-copies: mutating the result leaves the input alone', () => {
    const r = motionForCopies(motion as any, idMap, ids())
    r.motionx[0]!.keyframes[0]!.value = 99
    ;(r.behaviours[0]!.params as any).dir = 'out'
    expect(motion.motionx[0]!.keyframes[0]!.value).toBe(0)
    expect(motion.behaviours[0]!.params!.dir).toBe('in')
  })
  it('an empty motion doc or an unmapped selection gives empty lists', () => {
    expect(motionForCopies({}, idMap, ids())).toEqual({ motionx: [], behaviours: [], tracks: [] })
    expect(motionForCopies(motion as any, new Map([['q', 'q2']]), ids())).toEqual({ motionx: [], behaviours: [], tracks: [] })
  })
})
```

And in `frontend/tests/unit/layer-edits.unit.spec.ts` (append):

```ts
describe('duplicateLayers idMap', () => {
  it('maps every duplicated id to its copy', async () => {
    const { duplicateLayers } = await import('~/lib/compositor/layerEdits')
    const L = (id: string): any => ({ id, kind: 'rect', x: 0.2, y: 0.2, rotation: 0, opacity: 1, w: 0.1, h: 0.1 })
    let n = 0
    const r = duplicateLayers([L('a'), L('b'), L('c')], [], new Set(['a', 'c']), 0.02, () => `n${++n}`, () => 'g')
    expect([...r.idMap.entries()]).toEqual([['a', 'n1'], ['c', 'n2']])
    expect(r.newIds).toEqual(['n1', 'n2'])
  })
})
```

- [ ] **Step 2: Run to verify it fails**: `npx vitest run tests/unit/motionx/duplicate-motion.unit.spec.ts tests/unit/layer-edits.unit.spec.ts` — fails: module not found / `idMap` undefined.

- [ ] **Step 3: Implement**

```ts
// frontend/app/lib/motionx/adapter/duplicateMotion.ts
// Duplicate keeps the motion (spec Part 1). Motion is stored on the FRAME keyed by layer id
// — bands `layers.<id>.<prop>`, behaviours by `layerId`, legacy dial tracks by id-path — so a
// duplicated layer needs every entry aimed at its original re-targeted at its new id. Pure.
import type { Track, StoredBehaviour } from '../types'
import type { EffectDialTrack } from '~/lib/motion/effectTracks'

export interface MotionDoc { motionx?: Track[]; behaviours?: StoredBehaviour[]; tracks?: EffectDialTrack[] }

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const swapId = (path: string, idMap: ReadonlyMap<string, string>): string | null => {
  const m = path.match(/^layers\.([^.]+)\.(.+)$/)
  if (!m) return null
  const to = idMap.get(m[1]!)
  return to ? `layers.${to}.${m[2]}` : null
}

/** Every band, behaviour and effect-dial track aimed at a layer in `idMap`'s keys,
 *  re-targeted at the mapped id. Fresh behaviour ids; a compiled track keeps pointing at
 *  its (fresh) behaviour. Deep copies — nothing shared with the originals. */
export function motionForCopies(
  motion: MotionDoc,
  idMap: ReadonlyMap<string, string>,
  newBehaviourId: () => string,
): { motionx: Track[]; behaviours: StoredBehaviour[]; tracks: EffectDialTrack[] } {
  const behaviourIds = new Map<string, string>()
  const behaviours: StoredBehaviour[] = []
  for (const b of motion.behaviours ?? []) {
    const layerId = idMap.get(b.layerId)
    if (!layerId) continue
    const id = newBehaviourId()
    behaviourIds.set(b.id, id)
    behaviours.push({ ...clone(b), id, layerId })
  }
  const motionx: Track[] = []
  for (const tr of motion.motionx ?? []) {
    const path = swapId(tr.path, idMap)
    if (!path) continue
    const next: Track = { ...clone(tr), path }
    if (tr.behaviourId) {
      const mapped = behaviourIds.get(tr.behaviourId)
      if (mapped) next.behaviourId = mapped; else delete next.behaviourId
    }
    motionx.push(next)
  }
  const tracks: EffectDialTrack[] = []
  for (const tr of motion.tracks ?? []) {
    const target = swapId(tr.target, idMap)
    if (target) tracks.push({ ...clone(tr), target })
  }
  return { motionx, behaviours, tracks }
}
```

In `layerEdits.ts` `duplicateLayers`: add `const idMap = new Map<string, string>()`, set `idMap.set(l.id, c.id)` where `c.id = mkId()` is assigned, and return `{ layers, groups, newIds, idMap }` on BOTH return statements (the empty one returns `new Map()`). Update the return type.

- [ ] **Step 4: Run tests** — both files green; also `npm run test:unit -- layer` stays green.
- [ ] **Step 5: Commit** `feat(motionx): motionForCopies re-targets a layer's bands, behaviours and dial tracks at its duplicate`

---

### Task 2: Duplicate and paste carry the motion

**Files:**
- Modify: `frontend/app/composables/useLocalLayerEditor.ts` (`duplicateSelection` ~line 580, `pasteClipboard` ~line 621, `copySelection` ~603)
- Modify: `frontend/app/lib/compositor/layerClipboard.ts` (`ClipboardPayload`, `extractForCopy`, `materializePaste`)
- Test: `frontend/tests/unit/layer-clipboard.unit.spec.ts`, new `frontend/tests/unit/local-layer-editor-duplicate-motion.unit.spec.ts`

**Interfaces:**
- Consumes: `motionForCopies`, `duplicateLayers().idMap`, the editor's `readMotionSnap` / `writeMotionSnap` (useLocalLayerEditor.ts:232-247).
- Produces: `ClipboardPayload.motion?: MotionDoc` (entries for the copied ids, un-remapped); `materializePaste` returns `idMap` too.

- [ ] **Step 1: Read** `useLocalLayerEditor.ts` 220-260 and 575-640, `layerClipboard.ts` whole, and `tests/unit/layer-clipboard.unit.spec.ts` to see how the editor is constructed in tests (search `tests/unit` for `useLocalLayerEditor(` — if no test constructs it, build the minimal harness the composable's `opts` need: a `node()` returning `{ data: { properties: { sailor_motion } } }` and refs for layers/groups; look at how `CompositorModal.vue:648` calls it).

- [ ] **Step 2: Write the failing tests**

`layer-clipboard.unit.spec.ts` (append):
```ts
describe('clipboard motion', () => {
  it('extractForCopy carries the motion aimed at the copied ids, un-remapped', () => {
    const motion = { motionx: [{ path: 'layers.a.opacity', type: 'number', keyframes: [] }, { path: 'layers.b.opacity', type: 'number', keyframes: [] }],
      behaviours: [{ id: 'bh', kind: 'fade', layerId: 'a', timing: { start: 0, duration: 1 } }], tracks: [] }
    const p = extractForCopy([L('a', 0.2, 0.2), L('b', 0.5, 0.5)], [], new Set(['a']), motion as any)!
    expect(p.motion?.motionx.map((t: any) => t.path)).toEqual(['layers.a.opacity'])
    expect(p.motion?.behaviours.map((b: any) => b.id)).toEqual(['bh'])
  })
  it('materializePaste remaps the motion onto the pasted ids', () => {
    const payload: any = { layers: [L('a', 0.2, 0.2)], groups: [],
      motion: { motionx: [{ path: 'layers.a.opacity', type: 'number', keyframes: [], behaviourId: 'bh' }],
        behaviours: [{ id: 'bh', kind: 'fade', layerId: 'a', timing: { start: 0, duration: 1 } }], tracks: [] } }
    const r = materializePaste(payload, [], [], 0.02, ids(), gids(), () => 'nb1')
    expect(r.motion.motionx[0]).toMatchObject({ path: 'layers.p1.opacity', behaviourId: 'nb1' })
    expect(r.motion.behaviours[0]).toMatchObject({ id: 'nb1', layerId: 'p1' })
  })
  it('an old payload without motion pastes with empty motion', () => {
    const r = materializePaste({ layers: [L('a', 0.2, 0.2)], groups: [] } as any, [], [], 0.02, ids(), gids(), () => 'nb1')
    expect(r.motion).toEqual({ motionx: [], behaviours: [], tracks: [] })
  })
})
```

`local-layer-editor-duplicate-motion.unit.spec.ts`: construct the editor with a node whose `sailor_motion` holds one band + one Settle behaviour on layer `a`; select `a`; `await editor.duplicateSelection()`; assert the node's `sailor_motion.motionx` now has two bands (paths `layers.a.opacity` and `layers.<new>.opacity`) and two behaviours with distinct ids and the same `timing`; then `editor.undo()` → one band, one behaviour, one layer. Exact harness shape depends on Step 1 — it must go through the real `duplicateSelection`, not call `motionForCopies` by hand.

- [ ] **Step 3: Implement**
  - `layerClipboard.ts`: `ClipboardPayload` gains `motion?: MotionDoc`. `extractForCopy(layers, groups, selectedIds, motion?: MotionDoc)` filters `motion` to entries whose layer id ∈ selectedIds (reuse `motionForCopies` with an identity map `id → id` and a throwaway id generator, then deep-copied — or a small local filter; either way un-remapped ids). `materializePaste(payload, layers, groups, offset, mkId, mkGid, mkBehaviourId: () => string)` builds its `idMap` (old → new, in the order it re-ids) and returns `{ ...existing, idMap, motion: motionForCopies(payload.motion ?? {}, idMap, mkBehaviourId) }`.
  - `useLocalLayerEditor.ts`: a module-level `let _behSeq = 0; const mkBehaviourId = () => \`bh-${Date.now().toString(36)}-${++_behSeq}\`` (match the style of `_dupSeq`). Add a helper `appendMotion(extra)` that reads `readMotionSnap()`, appends `extra.motionx/behaviours/tracks` to the corresponding lists (creating them when absent, and leaving a list absent when both the existing and the extra are empty), and `writeMotionSnap`s it. In `duplicateSelection`, after `commitBoth`: `appendMotion(motionForCopies(readMotionSnap() as MotionDoc, r.idMap, mkBehaviourId))`. In `copySelection`, pass `readMotionSnap()` as the 4th argument of `extractForCopy`. In `pasteClipboard`, pass `mkBehaviourId` and `appendMotion(r.motion)` after the commit. The OS-clipboard serialisation (`serializeLayersForOS` / `parseLayersFromOS`) must round-trip the `motion` field — check and extend its test if it strips unknown fields.

- [ ] **Step 4: Run** `npm run test:unit -- clipboard` and the new spec; then `npm run test:unit -- layer` — all green, "Test Files" counted.
- [ ] **Step 5: Commit** `feat(compositor): duplicate and paste carry a layer's Motion-tab bands and behaviours`

---

### Task 3: `copies.ts` — ranks and clocks; Cloner fields; `expandClones(…, only)`

**Files:**
- Create: `frontend/app/lib/motionx/copies.ts`
- Modify: `frontend/app/composables/useCloner.ts` (interface `Cloner` ~line 25-64, `DEFAULT_CLONER` ~87, `expandClones` ~162)
- Test: `frontend/tests/unit/motionx/copies.unit.spec.ts`, `frontend/tests/unit/cloner.unit.spec.ts` (append)

**Interfaces:**
- Produces: `type CopyOrder = 'first' | 'last' | 'centre' | 'random'`; `COPY_ORDERS: readonly CopyOrder[]` (that order); `COPY_ORDER_LABELS: Record<CopyOrder, string>` = First to last · Last to first · Centre out · Random; `copyRanks(n, order, seed): number[]`; `copyClock(t, k, n, cloner): number`; `staggerOf(cloner): number` (finite, ≥ 0, else 0); `Cloner.motionStagger? / motionOrder? / motionSeed?`; `expandClones(cloner, aspect, only?: number)`.

- [ ] **Step 1: Failing tests**

```ts
// frontend/tests/unit/motionx/copies.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { copyRanks, copyClock, staggerOf, COPY_ORDERS } from '~/lib/motionx/copies'
import { DEFAULT_CLONER } from '~/composables/useCloner'

describe('copyRanks', () => {
  it('first to last: the original goes first', () => { expect(copyRanks(4, 'first', 1)).toEqual([0, 1, 2, 3]) })
  it('last to first', () => { expect(copyRanks(4, 'last', 1)).toEqual([3, 2, 1, 0]) })
  it('centre out, odd and even (ties: the lower index first)', () => {
    expect(copyRanks(5, 'centre', 1)).toEqual([4, 2, 0, 1, 3])
    expect(copyRanks(4, 'centre', 1)).toEqual([2, 0, 1, 3])
  })
  it('random is a repeatable permutation that changes with the seed', () => {
    const a = copyRanks(8, 'random', 7), b = copyRanks(8, 'random', 7), c = copyRanks(8, 'random', 8)
    expect(a).toEqual(b)
    expect([...a].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(c).not.toEqual(a)
  })
  it('n ≤ 1 is a single rank 0; a bad order reads as first to last', () => {
    expect(copyRanks(1, 'random', 1)).toEqual([0])
    expect(copyRanks(3, 'bogus' as any, 1)).toEqual([0, 1, 2])
  })
  it('lists the four orders in gallery order', () => { expect(COPY_ORDERS).toEqual(['first', 'last', 'centre', 'random']) })
})

describe('copyClock', () => {
  const cl = { ...DEFAULT_CLONER, enabled: true, motionStagger: 0.25, motionOrder: 'last' as const }
  it('shifts copy k back by rank × stagger', () => {
    expect(copyClock(2, 0, 4, cl)).toBeCloseTo(2 - 3 * 0.25)
    expect(copyClock(2, 3, 4, cl)).toBeCloseTo(2)
  })
  it('no stagger, or a bad one, is the frame clock', () => {
    expect(copyClock(2, 1, 4, DEFAULT_CLONER)).toBe(2)
    expect(copyClock(2, 1, 4, { ...cl, motionStagger: NaN })).toBe(2)
    expect(copyClock(2, 1, 4, { ...cl, motionStagger: -1 })).toBe(2)
  })
  it('staggerOf', () => { expect(staggerOf(cl)).toBe(0.25); expect(staggerOf(DEFAULT_CLONER)).toBe(0); expect(staggerOf(undefined)).toBe(0) })
})
```

`cloner.unit.spec.ts` (append):
```ts
describe('expandClones only', () => {
  it('returns just the k-th transform, identical to that entry of the full list', async () => {
    const { expandClones, DEFAULT_CLONER } = await import('~/composables/useCloner')
    const cl = { ...DEFAULT_CLONER, enabled: true, mode: 'radial' as const, count: 5, radius: 0.3, stepRotation: 10, stepOpacity: 0.8 }
    const all = expandClones(cl, 1.5)
    for (const c of all) expect(expandClones(cl, 1.5, c.k)).toEqual([c])
    expect(expandClones(cl, 1.5, 99)).toEqual([])
  })
  it('DEFAULT_CLONER has no motion stagger', async () => {
    const { DEFAULT_CLONER } = await import('~/composables/useCloner')
    expect(DEFAULT_CLONER.motionStagger).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run** — fails.
- [ ] **Step 3: Implement**

```ts
// frontend/app/lib/motionx/copies.ts
// Copies stagger (spec Part 2): which copy of a cloned layer goes first, and what clock copy k
// sees. Pure. `k` is expandClones' own index (0 = the original), `n` its copy count.
import type { Cloner } from '~/composables/useCloner'

export type CopyOrder = 'first' | 'last' | 'centre' | 'random'
export const COPY_ORDERS: readonly CopyOrder[] = ['first', 'last', 'centre', 'random']
export const COPY_ORDER_LABELS: Record<CopyOrder, string> = {
  first: 'First to last', last: 'Last to first', centre: 'Centre out', random: 'Random',
}

/** mulberry32 — the same tiny seeded generator the letter behaviours' shuffle uses; any
 *  deterministic one would do, but a copy order must be repeatable frame to frame. */
function rng(seed: number): () => number {
  let a = (seed >>> 0) || 1
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/** rank per copy index k: rank 0 goes first. */
export function copyRanks(n: number, order: CopyOrder, seed: number): number[] {
  const count = Math.max(1, Math.floor(n) || 1)
  const ks = Array.from({ length: count }, (_, k) => k)
  if (order === 'last') return ks.map((k) => count - 1 - k)
  if (order === 'centre') {
    const mid = (count - 1) / 2
    const sorted = [...ks].sort((a, b) => (Math.abs(a - mid) - Math.abs(b - mid)) || (a - b))
    const rank = new Array<number>(count)
    sorted.forEach((k, r) => { rank[k] = r })
    return rank
  }
  if (order === 'random') {
    const r = rng(Number.isFinite(seed) ? seed : 1)
    const perm = [...ks]
    for (let i = perm.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [perm[i], perm[j]] = [perm[j]!, perm[i]!] }
    const rank = new Array<number>(count)
    perm.forEach((k, r) => { rank[k] = r })
    return rank
  }
  return ks
}

export function staggerOf(cloner: Pick<Cloner, 'motionStagger'> | undefined | null): number {
  const s = cloner?.motionStagger
  return typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : 0
}

/** The clock copy k of n sees: the frame clock, minus its rank × stagger. */
export function copyClock(t: number, k: number, n: number, cloner: Cloner): number {
  const s = staggerOf(cloner)
  if (s === 0) return t
  const ranks = copyRanks(n, (cloner.motionOrder ?? 'first') as CopyOrder, cloner.motionSeed ?? 1)
  return t - (ranks[k] ?? 0) * s
}
```

Check whether the letter behaviours already export a seeded rng (grep `mulberry` / `seededRandom` in `app/lib/motionx/text/`); if so import it instead of re-declaring.

`useCloner.ts`: add the three optional fields to `Cloner` (doc comments from the spec; nothing in `DEFAULT_CLONER`); `expandClones(cloner, aspect, only?: number)` — compute the full list as today, then `return only === undefined ? list : list.filter((c) => c.k === only)` (one line at the end; the transforms are otherwise untouched, and the identity return for a disabled cloner stays: `only` on a disabled cloner returns the single identity when `only === 0`, `[]` otherwise — pin that in the test if you find it matters to Task 4).

- [ ] **Step 4: Run** `npm run test:unit -- copies` and `-- cloner` — green.
- [ ] **Step 5: Commit** `feat(motionx): copy ranks and clocks for a staggered cloner; expandClones can narrow to one copy`

---

### Task 4: `paintLayerStack` paints a staggered cloner once per copy

**Files:**
- Modify: `frontend/app/composables/useCompositorLayers.ts` (fold site ~5551-5571; the two `expandClones(layer.cloner, W / H)` call sites at ~2821 and ~6015)
- Test: `frontend/tests/unit/compositor-copies-stagger.unit.spec.ts`

**Interfaces:**
- Consumes: `copyClock`, `staggerOf`, `expandClones(cloner, aspect, only)`.
- Produces: a transient `motionCopy?: number` on a layer clone (never persisted; add `'motionCopy'` to `SILHOUETTE_KEY_STRIP` in `lib/compositor/silhouetteCache.ts`), read by both `expandClones` call sites as the `only` argument: `expandClones(layer.cloner, W / H, (layer as any).motionCopy)`.

- [ ] **Step 1: Read** `paintLayerStack` from its signature to the end of the drawing loop, and `tests/unit/compositor-clip-paint.unit.spec.ts` (the recorder harness that drives the REAL `paintLayerStack` and reads `_cloneSlot` per copy) — reuse its `makeCtx` pattern.

- [ ] **Step 2: Failing test** — a rect (or text) layer with a radial cloner of 3 and `motionStagger: 0.5, motionOrder: 'first'`, and a motion doc with one opacity band `layers.<id>.opacity` 0 → 1 over 0–1 s. Paint at `t = 0.75` through `paintLayerStack`. Assert from the recording context's `globalAlpha` at each `drawImage`/fill (whichever the layer kind produces) that the three copies were painted with three DIFFERENT alphas, in the order `expandClones` lists them, equal to the band evaluated at `0.75`, `0.25` and `-0.25 → 0` (clamped by the evaluator: a clock before the band's first key holds its first value). Second case: the same layer with `motionStagger: 0` painted at 0.75 produces a call log **deep-equal** to the log of the same paint on a build where the layer has no `motionStagger` field at all (i.e. the existing path) — record both and compare.

- [ ] **Step 3: Implement.** After the fold (right after the `if (animatedLocals !== localLayers) { … }` block), expand:

```ts
  // Copies stagger (spec Part 2 / approach A): a cloned local layer with a stagger is painted
  // ONCE PER COPY, each copy folded at its own clock and its Cloner narrowed to that copy
  // (`motionCopy` → expandClones' `only`). Stagger 0 / no cloner never enters this block, so
  // the existing single-fold path is what every old Frame still takes.
  if (t !== undefined) {
    let expanded: typeof items | null = null
    items.forEach((it, i) => {
      if (it.type !== 'local') return
      const source = localLayersById.get(it.layer.id) // the UNFOLDED layer (see note)
      const cloner = source?.cloner
      if (!cloner?.enabled || staggerOf(cloner) === 0) return
      const copies = expandClones(cloner, W / H)
      if (copies.length <= 1) return
      const perCopy = copies.map((c) => {
        const [folded] = foldMotion([source!], motion, copyClock(t, c.k, c.n, cloner))
        return { ...it, layer: { ...(folded ?? source!), motionCopy: c.k } as LocalLayer }
      })
      expanded ??= [...items]
      expanded.splice(expanded.indexOf(it), 1, ...perCopy)   // in stamp order
    })
    if (expanded) items = expanded
  }
```

where `foldMotion(layers, motion, t)` is the existing five-call fold chain extracted into a local function (used both for the main fold and here — one definition, no duplicated chain) and `localLayersById` is a `Map` over the PRE-fold `localLayers` (capture before the main fold reassigns it). Keep the shape of `items` entries exactly as the loop expects. Then change the two `expandClones(layer.cloner, W / H)` call sites to pass `(layer as { motionCopy?: number }).motionCopy` as the third argument. Add `'motionCopy'` to `SILHOUETTE_KEY_STRIP`.

Note: the expansion iterates `items` (draw order), so copies land where the layer was in the stack. The `_cloneSlot` set inside the clone loop still sees `c.k`/`c.n` from the narrowed list, so a living clip's Phase keeps working per copy.

- [ ] **Step 4: Run** the new spec, `npm run test:unit -- compositor` (57 files today) and `-- motionx` — green; run `npx vue-tsc --noEmit -p tsconfig.json 2>&1 | grep -c useCompositorLayers` → 0.
- [ ] **Step 5: Commit** `feat(compositor): a cloned layer with a motion stagger is painted once per copy, each at its own clock`

---

### Task 5: The Copies card in the Motion tab

**Files:**
- Create: `frontend/app/components/vue-canvas/compositor/MotionCopiesPanel.vue`
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` (~8383, beside `CompositorAnimatePanel`)
- Test: `frontend/tests/unit/motionx/copies-ui.unit.spec.ts`

**Interfaces:**
- Props: `cloner: Cloner`. Emits: `update: [cloner: Cloner]`, `before-change: []` (the modal wires `@before-change="recordHistory"` and `@update="(cl) => setLocal(selectedLocal!.id, { cloner: cl } as any)"`, the same pair the Design tab's cloner panel uses — see `CompositorModal.vue:10749`).
- Testids: `copies-stagger`, `copies-order` (buttons carry `data-value`), `copies-shuffle`.

- [ ] **Step 1: Read** `settle-ui.unit.spec.ts` for the mount pattern and `MotionInspector.vue` 600-660 for the `mi-heading` + `StudioSegmentedRow` usage.
- [ ] **Step 2: Failing tests**: mounts with `DEFAULT_CLONER` enabled → heading "Copies", stagger slider at 0, order "First to last"; setting stagger emits `before-change` then `update` with `motionStagger`; picking `random` shows the shuffle button and emits `motionOrder: 'random'`; shuffle emits a changed `motionSeed`; non-random hides shuffle.
- [ ] **Step 3: Implement** — a `<div class="mi-heading">Copies</div>`, `StudioSlider` label "Stagger" 0–2 step 0.01 default 0 with the seconds unit the timing sliders use, `StudioSegmentedRow` label "Order" over `COPY_ORDERS` with `COPY_ORDER_LABELS`, a `StudioButton` shuffle (icon-only, `title="New order"`) when `random`. In the modal: `<MotionCopiesPanel v-if="selectedLocal?.cloner?.enabled" :cloner="selectedLocal.cloner" @before-change="recordHistory" @update="(cl) => setLocal(selectedLocal!.id, { cloner: cl } as any)" />` placed after `MotionInspector` and before `CompositorAnimatePanel`. Update the empty-state sentence only if it now reads wrong.
- [ ] **Step 4: Run** the spec, `-- motionx`; `vue-tsc` grep for both files → no new errors.
- [ ] **Step 5: Commit** `feat(motion): Copies card — Stagger and Order for a cloned layer's motion`

---

### Task 6: Cloner dials as motion properties

**Files:**
- Modify: `frontend/app/lib/motionx/adapter/frame.ts` (`applyResolvedValue` ~20, `frameTarget` ~187, `PropertyGroup`/`animatableProperties` ~201-252)
- Test: `frontend/tests/unit/motionx/adapter-frame.unit.spec.ts` (append)

**Interfaces:**
- Produces: `PropertyGroup` gains `'Copies'`; paths `layers.<id>.cloner.<key>`; `CLONER_PROPERTIES` table exported from `frame.ts`:

```ts
export const CLONER_PROPERTIES: ReadonlyArray<{ key: keyof Cloner & string; label: string; mode: 'linear' | 'radial' | 'both'; min: number; max: number }> = [
  { key: 'countX', label: 'Count X', mode: 'linear', min: 1, max: 50 },
  { key: 'countY', label: 'Count Y', mode: 'linear', min: 1, max: 50 },
  { key: 'spacingX', label: 'Spacing X', mode: 'linear', min: -1, max: 1 },
  { key: 'spacingY', label: 'Spacing Y', mode: 'linear', min: -1, max: 1 },
  { key: 'nudgeX', label: 'Nudge X', mode: 'linear', min: -0.5, max: 0.5 },
  { key: 'nudgeY', label: 'Nudge Y', mode: 'linear', min: -0.5, max: 0.5 },
  { key: 'count', label: 'Count', mode: 'radial', min: 1, max: 100 },
  { key: 'radius', label: 'Radius', mode: 'radial', min: 0, max: 1 },
  { key: 'startAngle', label: 'Start angle', mode: 'radial', min: -360, max: 360 },
  { key: 'sweepAngle', label: 'Sweep', mode: 'radial', min: 0, max: 360 },
  { key: 'stepRotation', label: 'Step rotation', mode: 'both', min: -180, max: 180 },
  { key: 'stepScale', label: 'Step scale', mode: 'both', min: 0, max: 2 },
  { key: 'stepOpacity', label: 'Step opacity', mode: 'both', min: 0, max: 1 },
]
```

- [ ] **Step 1: Failing tests** — `animatableProperties`: no Copies entries without an enabled cloner; a linear cloner lists exactly the linear + both keys as `layers.<id>.cloner.<key>` with labels/ranges from the table, group `'Copies'`, after the Effects entries; a radial one lists radial + both. `applyResolvedValue(layer, 'cloner.count', 4)` returns a NEW layer with `cloner.count === 4` and the original untouched; on a layer without a cloner returns the same reference. `frameTarget(layer).get('cloner.radius')` returns the value, `has` true; without a cloner `undefined` / false. `applyMotionxTracks` with a `layers.<id>.cloner.count` band 1 → 6 over 0–1 s: at t = 0.5 `expandClones(folded.cloner, 1)` has 3 copies (floor(3.5)); at t = 1, 6.
- [ ] **Step 2: Run** — fails.
- [ ] **Step 3: Implement** the three edits. In `applyResolvedValue`, before the effects match: `const cl = prop.match(/^cloner\.([^.]+)$/); if (cl && typeof value === 'number') { const c = (layer as { cloner?: Cloner }).cloner; if (!c) return layer; return { ...layer, cloner: { ...c, [cl[1]!]: value } } as LocalLayer }`. `frameTarget.get`: `if (prop.startsWith('cloner.')) { const c = rec.cloner as Cloner | undefined; const v = c?.[prop.slice(7) as keyof Cloner]; return typeof v === 'number' ? v : undefined }` — also expose `get('cloner.mode')` returning the mode STRING (Task 7 needs it; extend `PropertyValue` handling only if `get`'s return type forbids a string — it is `PropertyValue | undefined`; if strings are not a `PropertyValue`, add a separate `frameTarget(layer).mode` … no: keep it simple and have Task 7's compilers receive the mode via `target.get('cloner.count')` being defined ⇒ radial, `target.get('cloner.countX')` defined ⇒ linear; document that in `frameTarget`). `animatableProperties`: after the effects loop, `const cloner = (layer as { cloner?: Cloner }).cloner; if (cloner?.enabled) for (const p of CLONER_PROPERTIES) if (p.mode === 'both' || p.mode === cloner.mode) out.push({ path: \`layers.${id}.cloner.${p.key}\`, type: 'number', label: p.label, group: 'Copies', min: p.min, max: p.max })`.
- [ ] **Step 4: Run** `-- motionx`, `-- adapter`; check the property picker (`MotionPropertyPicker.vue`) orders groups from a list — add `'Copies'` last if it has one; check the agent's band vocabulary (`adapter/agentBands.ts` + its spec) still passes and note the hint size it reports.
- [ ] **Step 5: Commit** `feat(motionx): the Cloner's dials are motion properties (Copies group)`

---

### Task 7: The five Copies behaviours and gallery tiles

**Files:**
- Modify: `frontend/app/lib/motionx/behaviour.ts` (register five kinds), `frontend/app/lib/motionx/gallery.ts` (`MoveGroup`, `PreviewKind`, `LayerCaps`, tiles, `movesForLayer`, `GROUP_ORDER`), `frontend/app/lib/motionx/bands.ts` (bar labels for the new kinds, if labels are looked up by kind there)
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` (`motionLayerCaps` computed — add `cloner: selectedLocal?.cloner?.enabled ? selectedLocal.cloner.mode : null`)
- Test: `frontend/tests/unit/motionx/behaviour.unit.spec.ts`, `gallery.unit.spec.ts` (append)

**Interfaces:**
- `LayerCaps` gains `cloner: 'linear' | 'radial' | null`. `GalleryMove.needs` gains `'cloner' | 'cloner-linear' | 'cloner-radial'`. `MoveGroup` gains `'Copies'` (after `'Out'`, before `'Gradient'` in `GROUP_ORDER`). `PreviewKind` gains `'copies-build' | 'copies-spread' | 'copies-spin' | 'copies-fan' | 'copies-fade'`.
- Behaviour kinds (each ONE track):
  - `copies.build` `{dir:'in'|'out'}` — path `cloner.count` when `target.get('cloner.count')` is a number else `cloner.countX`; in: 1 → cur, out: cur → 1; ease `'linear'`.
  - `copies.spread` `{dir:'out'|'in', axis?:'x'|'y'}` — radial: `cloner.radius`; linear: `cloner.spacingX` (axis x, default) or `cloner.spacingY`; out: 0 → cur, in: cur → 0.
  - `copies.spin` — `cloner.startAngle` cur → cur + 360, `loop: b.timing.loop ?? true`, ease `'linear'`.
  - `copies.fan` `{dir}` — `cloner.stepRotation`; full = cur if cur ≠ 0 else (radial ? 360 / max(1, count) : 15); in: 0 → full, out: full → 0.
  - `copies.fade` `{dir}` — `cloner.stepOpacity`; in: 0 → cur, out: cur → 0.
- Tiles (group `'Copies'`): `copies-build-in` / `-out` ×2 modes — one tile pair with `needs: 'cloner'` (the compiler picks the path) · `copies-spread-out` / `copies-gather-in` with `needs: 'cloner-radial'` (single kind) AND a second pair with `needs: 'cloner-linear'` whose `recipe` is `[{kind:'copies.spread', params:{dir, axis:'x'}}, {kind:'copies.spread', params:{dir, axis:'y'}}]` · `copies-spin` `needs: 'cloner-radial'`, `cycle: 4` · `copies-fan-in` / `-out` `needs: 'cloner'` · `copies-fade-in` / `-out` `needs: 'cloner'`. Labels: "Copies build in", "Copies build out", "Spread out", "Gather in", "Ring spins", "Fan in", "Fan out", "Fade along in", "Fade along out".

- [ ] **Step 1: Failing tests** — each compiler for a radial target (`get` answers `cloner.count: 6, cloner.radius: 0.3, cloner.startAngle: 0, cloner.stepRotation: 0, cloner.stepOpacity: 1`) and a linear one (`cloner.countX: 4, cloner.spacingX: 0.2, cloner.spacingY: 0.1, …`): exact path and endpoint values, `copies.spin` loops, `copies.fan` fallback 60 for the radial target and 15 for the linear one. `movesForLayer({gradient:false,text:false,cloner:null})` has no Copies group; `cloner:'radial'` offers build ×2, spread/gather (single-kind), spin, fan ×2, fade ×2 = 9; `cloner:'linear'` offers 8 (no spin) and its spread/gather carry a two-part recipe. `groupedMoves` places Copies between Out and Gradient.
- [ ] **Step 2: Run** — fails.
- [ ] **Step 3: Implement** — compilers with `numTrack` / the existing helpers; `movesForLayer` cases for the three `needs`; `GROUP_ORDER`; `defaultDurationFor('Copies')` = 1 (the group falls through to 0.8 today — add the case). Bar labels: check how `bands.ts` labels a bar for a kind (`labelFor` or similar) and add the five; sentence case.
- [ ] **Step 4: Run** `-- motionx`, `-- gallery`, `-- bands`; the modal's `motionLayerCaps` edit typechecks.
- [ ] **Step 5: Commit** `feat(motion): Copies gallery — build, spread/gather, ring spins, fan, fade along`

---

### Task 8: Previews, inspector rows, lab fixture, live verification

**Files:**
- Create: `frontend/app/components/vue-canvas/compositor/MotionCopiesPreview.vue`
- Modify: `frontend/app/components/vue-canvas/compositor/previewCard.ts` / `MotionGallery.vue` (route the five preview kinds), `MotionInspector.vue` (Direction row for `copies.build/spread/fan/fade` — reuse the row the Fade bar shows; `copies.spin` has none), the frame-lab fixture page (add a text layer with a radial cloner of 6 and a linear-grid variant)
- Test: `frontend/tests/unit/motionx/copies-ui.unit.spec.ts` (append: inspector shows Direction for build, not for spin; preview component mounts for all five kinds without throwing)

- [ ] **Step 1: Read** `MotionSettlePreview.vue` + `previewCard.ts` for the preview contract (canvas size, the clock it receives, `mode`).
- [ ] **Step 2: Implement** the preview: dots in a ring (radial) or a row; `build` grows the dot count with floor, `spread` moves the ring radius 0 → r, `spin` rotates, `fan` rotates each dot by k × angle, `fade` scales each dot's alpha by opacity^k. Inspector rows and the fixture.
- [ ] **Step 3: Live check** on `http://127.0.0.1:3002/dev/frame-lab` (never start a server; if `:3002` is not 200, STOP and report): (a) ⌘D on the cloner text layer after adding Fade in + Settle in → two rows for the copy at the same times; ⌘Z removes both; (b) Copies card: Stagger 0.15, Order First to last; scrub to mid-bar; `getImageData` on `[data-testid="compositor-stack-canvas"]` at each copy's centre shows monotonically different progress; Stagger 0 → frame hash equals the pre-change hash; (c) Add property → Copies → Count, band 1 → 6: at 0.5 s three copies; (d) each of the nine tiles applied once, a contact sheet (fetch to `/upload/image`, copy to the scratchpad) — report the path.
- [ ] **Step 4: Run** `npm run test:unit -- motionx`, `-- compositor`; `vue-tsc` grep for every touched `.vue` → no new errors.
- [ ] **Step 5: Commit** `feat(motion): Copies previews, Direction rows, lab cloner layer`

---

## Self-review

- Spec coverage: Part 1 → Tasks 1–2; Part 2 → Tasks 3–5; Part 3 → Task 6; Part 4 → Tasks 7–8; verification → Task 8 step 3. Out-of-scope items untouched.
- Types: `MotionDoc` (Task 1) is what Task 2 passes; `copyClock(t, k, n, cloner)` matches Task 4's call; `expandClones(cloner, aspect, only)` matches Tasks 3/4; `LayerCaps.cloner` matches Task 7's `motionLayerCaps`; `CLONER_PROPERTIES` keys are real `Cloner` fields (useCloner.ts:25-64).
- One open ambiguity resolved here: the Copies card is shown for ANY selected cloned layer (like the Animate panel), not only when nothing is selected on the timeline — simpler and the spec's intent.
