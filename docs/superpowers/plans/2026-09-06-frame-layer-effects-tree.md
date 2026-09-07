# Frame Layer Effects as an Ordered Stack — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Compositor's per-layer effects into an ordered, duplicable stack of instances shown as child rows under the layer in the left panel and tuned one at a time in the right panel, so the layer inspector stops being fourteen always-visible cards.

**Architecture:** One pure module (`lib/compositor/effectStack.ts`) owns the effect kinds, the canonical order, and a **read-through** function that returns any layer's ordered, id-stamped stack — folding the legacy `tornEdge`/`feather` fields in — so old documents render identically with no write on load. `applyEffectChain` in `postEffects.ts` becomes a loop over an ordered array (`applyPasses`), with the old fixed-order entry point kept as a canonical-sort wrapper for the document-level post stack. `paintLayer` runs the layer's ordered passes over its device-sized offscreen; layer blur becomes a real pass. The left panel gains an `'effect'` row variant in the existing recursive `flatRows` builder; the right panel gains a selected-effect state with a breadcrumb.

**Tech Stack:** Nuxt 4, Vue 3.5, TypeScript, Canvas 2D, Vitest, Playwright.

**Design source:** `docs/superpowers/specs/2026-09-06-frame-layer-effects-tree-design.md`.

## DEVIATION FROM THE SPEC — read this before Task 1

The spec's Section 1 says migration "runs where the document is read into the editor, in the same
place other layer sanitization happens". **There is no such place.** Stored layers are read with a raw
cast and no sanitize step:

```ts
// frontend/app/composables/useLocalLayerEditor.ts:139-140
const localLayers = computed<LocalLayer[]>(() =>
    (node()?.data?.properties?.sailor_localLayers as LocalLayer[]) ?? [])
```

and the same key is read raw in five other places (`VueNodeCanvas.vue:4490,5565,6032`,
`lib/compositor/wiredMigration.ts:186`, `lib/agent/studioTune.ts:108,117`). Inventing a migrate-on-load
would mean writing to every frame just by opening it, and any read site that skipped the migration
would render a layer differently from the others.

**This plan uses read-through instead.** One pure function, `effectStackOf(layer)`, returns the
canonical ordered, id-stamped stack for **any** layer, old shape or new, folding `tornEdge`/`feather`
in. Every consumer (paint, tree, inspector, agent) reads through it. Consequences, all better than
migrate-on-load:

- an old document renders identically with **zero writes** — nothing is touched by opening a frame;
- the one-way move to the new shape happens only when the user actually edits that layer's effects,
  via `writeStackToLayer`;
- there is exactly one definition of "what this layer's stack is", so no read site can disagree.

Everything else in the spec is implemented as written.

## Global Constraints

- **A layer that is not edited must render byte-identically to before this change.** That is the
  acceptance test for Tasks 2 and 3, not an aspiration.
- Old shape vs new shape is decided by one rule: **if every entry in `layer.effects` has a string
  `id`, the layer is new-shape and its array order is the user's order — never re-sort it.** If any
  entry lacks an `id`, the layer is old-shape: stamp deterministic ids, fold in `tornEdge`/`feather`,
  and sort into `EFFECT_ORDER`.
- Ids from a read-through are **deterministic** (`fx:<type>:<ordinal>`), because a random id per read
  would break selection and motion targets. Ids minted by a real mutation are random
  (`fx_<uuid>_<n>`).
- Canonical order, used for sorting old-shape layers, for the add menu, and for where a pinned kind
  sits: `background_blur, dof, inner_shadow, adjust, duotone, gradientMap, bloom, vignette, grain, torn_edge, feather, layer_blur, drop_shadow`.
- Pinned kinds are `background_blur` (first), `dof` (with the content), `drop_shadow` (last). At most
  one of each per layer; they never move.
- The other ten kinds are freely orderable and may repeat on one layer.
- `applyEffectChain(off, effects, opts)` keeps its exact current behaviour (canonical order, one
  instance per type) because `applyStackPost` (`postEffects.ts:392-399`) uses it for the
  document-level stack, whose stored array order is arbitrary. Only the per-layer path uses the new
  ordered entry point.
- Group rows never get a plus button; every layer row does, wired layers included.
- UI copy is sentence case, human names only ("Inner shadow", "Gradient map", "Torn edge",
  "Background blur", "Depth of field"), never the stored `type` string.
- Frontend work is under `frontend/`. Unit tests: `cd frontend && node_modules/.bin/vitest run <spec>`.
  Typecheck is `node_modules/.bin/nuxt typecheck` (there is no `vue-tsc` binary) and the repo has
  hundreds of pre-existing errors — only errors in files you touched count.
- The checkout is shared with other sessions and is dirty with their work. Never `git add -A`, never
  `git stash`, never touch a file outside your task's list. Stage only the exact paths named in the
  task's commit step. Commit messages end with
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## File Structure

**Create**

- `frontend/app/lib/compositor/effectStack.ts` — pure. Effect kinds, canonical order, the four
  layer-local effect interfaces moved here from `useCompositorLayers.ts`, the two new
  `torn_edge`/`feather` effect interfaces, `effectStackOf` read-through, and the list operations
  (add / remove / duplicate / reorder). No Vue, no canvas.
- `frontend/app/components/vue-canvas/compositor/CompositorEffectRow.vue` — one effect row.

**Modify**

- `frontend/app/lib/compositor/postEffects.ts` — extract each per-type block into a pass function;
  add `applyPasses` (ordered loop); `applyEffectChain` becomes a canonical-sort wrapper over it.
- `frontend/app/composables/useCompositorLayers.ts` — re-export the moved interfaces; `paintLayer`
  consumes the ordered stack; layer blur becomes a pass; silhouette cache condition.
- `frontend/app/lib/compositor/silhouetteCache.ts` — the key includes the stack's order.
- `frontend/app/lib/agent/surfaces/compositor.ts` — effect ops address instances by id.
- `frontend/app/components/vue-canvas/CompositorModal.vue` — `'effect'` row variant, add menu, drag
  reorder, selected-effect state, breadcrumb, and removal of the fourteen effect cards.

**Test**

- `frontend/tests/unit/compositor-effect-stack.unit.spec.ts`
- `frontend/tests/unit/compositor-effect-passes.unit.spec.ts`
- `frontend/tests/compositor-layer-effects.spec.ts` (Playwright)

---

### Task 1: The effect stack model (pure)

**Files:**
- Create: `frontend/app/lib/compositor/effectStack.ts`
- Modify: `frontend/app/composables/useCompositorLayers.ts:216-253` (move four interfaces out, re-export)
- Test: `frontend/tests/unit/compositor-effect-stack.unit.spec.ts`

**Interfaces:**
- Consumes: `TornEdgeSpec`, `tornEdgeActive` from `~/lib/compositor/tornEdge`; `FeatherSpec`,
  `featherActive` from `~/lib/compositor/feather`; `PostEffect`, `POST_EFFECT_DEFAULTS` from
  `~/lib/compositor/postEffects`.
- Produces, all exported from `~/lib/compositor/effectStack`:
  - `type EffectKind` (the 13 strings), `EFFECT_ORDER: readonly EffectKind[]`,
    `PINNED_KINDS: readonly EffectKind[]`, `ORDERABLE_KINDS: readonly EffectKind[]`,
    `EFFECT_LABELS: Record<EffectKind, string>`
  - `interface DropShadowEffect | LayerBlurEffect | InnerShadowEffect | BackgroundBlurEffect`
    (moved verbatim from `useCompositorLayers.ts`), `interface TornEdgeEffect`, `interface FeatherEffect`
  - `type LayerEffect` (the union, moved), `type EffectInstance = LayerEffect & { id: string }`
  - `isPinnedKind(k: EffectKind): boolean`, `isEffectKind(v: unknown): v is EffectKind`
  - `newEffectId(): string`
  - `createEffect(kind: EffectKind): EffectInstance`
  - `effectStackOf(layer: StackHost): EffectInstance[]` where
    `interface StackHost { effects?: unknown[]; tornEdge?: TornEdgeSpec; feather?: FeatherSpec }`
  - `writeStackToLayer(stack: EffectInstance[]): { effects: EffectInstance[]; tornEdge: undefined; feather: undefined }`
  - `addEffect(stack, kind): EffectInstance[]`, `removeEffect(stack, id): EffectInstance[]`,
    `duplicateEffect(stack, id): EffectInstance[]`, `reorderEffect(stack, fromId, toId): EffectInstance[]`,
    `canReorder(stack, fromId, toId): boolean`
  - `orderablePasses(stack): EffectInstance[]`, `pinnedEffect(stack, kind): EffectInstance | undefined`

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/unit/compositor-effect-stack.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  EFFECT_ORDER, EFFECT_LABELS, PINNED_KINDS, ORDERABLE_KINDS,
  effectStackOf, writeStackToLayer, createEffect, newEffectId, isPinnedKind,
  addEffect, removeEffect, duplicateEffect, reorderEffect, canReorder,
  orderablePasses, pinnedEffect, type EffectInstance,
} from '~/lib/compositor/effectStack'
import { DEFAULT_TORN_EDGE } from '~/lib/compositor/tornEdge'
import { DEFAULT_FEATHER } from '~/lib/compositor/feather'

describe('effect kinds', () => {
  it('has 13 kinds, 3 pinned and 10 orderable, all labelled in sentence case', () => {
    expect(EFFECT_ORDER).toHaveLength(13)
    expect(PINNED_KINDS).toEqual(['background_blur', 'dof', 'drop_shadow'])
    expect(ORDERABLE_KINDS).toHaveLength(10)
    expect(new Set([...PINNED_KINDS, ...ORDERABLE_KINDS])).toEqual(new Set(EFFECT_ORDER))
    for (const k of EFFECT_ORDER) expect(EFFECT_LABELS[k], k).toMatch(/^[A-Z][a-z]/)
    expect(EFFECT_LABELS.gradientMap).toBe('Gradient map')
    expect(EFFECT_LABELS.dof).toBe('Depth of field')
  })
  it('orders background blur first and drop shadow last', () => {
    expect(EFFECT_ORDER[0]).toBe('background_blur')
    expect(EFFECT_ORDER[EFFECT_ORDER.length - 1]).toBe('drop_shadow')
    expect(isPinnedKind('dof')).toBe(true)
    expect(isPinnedKind('bloom')).toBe(false)
  })
  it('createEffect fills the kind defaults, visible, with a fresh random id', () => {
    const a = createEffect('bloom'), b = createEffect('bloom')
    expect(a.type).toBe('bloom')
    expect(a.visible).toBe(true)
    expect(a.id).toMatch(/^fx_/)
    expect(a.id).not.toBe(b.id)
    expect(newEffectId()).not.toBe(newEffectId())
    expect(createEffect('torn_edge')).toMatchObject({ type: 'torn_edge', style: DEFAULT_TORN_EDGE.style })
    expect(createEffect('feather')).toMatchObject({ type: 'feather', curve: DEFAULT_FEATHER.curve })
  })
})

describe('effectStackOf: old shape', () => {
  it('stamps deterministic ids, folds tornEdge and feather in, and sorts into canonical order', () => {
    const layer = {
      effects: [
        { type: 'grain', amount: 0.2, size: 2, visible: true },
        { type: 'drop_shadow', color: '#000', x: 0, y: 0, blur: 0.01, visible: true },
        { type: 'adjust', brightness: 1.2, contrast: 1, saturation: 1, hue: 0, visible: true },
      ],
      tornEdge: { ...DEFAULT_TORN_EDGE, amount: 12 },
      feather: { ...DEFAULT_FEATHER, amount: 0.2 },
    }
    const stack = effectStackOf(layer)
    expect(stack.map(e => e.type)).toEqual(['adjust', 'grain', 'torn_edge', 'feather', 'drop_shadow'])
    expect(stack.every(e => typeof e.id === 'string' && e.id.length > 0)).toBe(true)
    // deterministic: two reads of the same layer agree, so a selection survives a re-read
    expect(effectStackOf(layer).map(e => e.id)).toEqual(stack.map(e => e.id))
    expect(stack.find(e => e.type === 'torn_edge')).toMatchObject({ amount: 12, visible: true })
    expect(stack.find(e => e.type === 'feather')).toMatchObject({ amount: 0.2, visible: true })
  })
  it('gives same-type duplicates distinct deterministic ids and keeps their relative order', () => {
    const layer = { effects: [
      { type: 'bloom', threshold: 0.1, radius: 0.01, intensity: 1, visible: true },
      { type: 'bloom', threshold: 0.9, radius: 0.02, intensity: 2, visible: true },
    ] }
    const stack = effectStackOf(layer)
    expect(stack).toHaveLength(2)
    expect(stack[0]!.id).not.toBe(stack[1]!.id)
    expect((stack[0] as any).threshold).toBe(0.1)
  })
  it('skips an inactive tornEdge or feather, and unknown kinds', () => {
    const layer = {
      effects: [{ type: 'nope', visible: true }, { type: 'grain', amount: 0.1, size: 2, visible: true }],
      tornEdge: { ...DEFAULT_TORN_EDGE, amount: 0, grain: 0, lipWidth: 0 },
      feather: { ...DEFAULT_FEATHER, amount: 0 },
    }
    expect(effectStackOf(layer).map(e => e.type)).toEqual(['grain'])
  })
  it('a layer with nothing yields an empty stack', () => {
    expect(effectStackOf({})).toEqual([])
    expect(effectStackOf({ effects: [] })).toEqual([])
  })
})

describe('effectStackOf: new shape', () => {
  it('returns the stored order untouched when every entry already has an id', () => {
    const stored: EffectInstance[] = [
      { id: 'a', type: 'grain', amount: 0.2, size: 2, visible: true } as any,
      { id: 'b', type: 'adjust', brightness: 1.2, contrast: 1, saturation: 1, hue: 0, visible: true } as any,
    ]
    const stack = effectStackOf({ effects: stored })
    expect(stack.map(e => e.type)).toEqual(['grain', 'adjust'])
    expect(stack.map(e => e.id)).toEqual(['a', 'b'])
  })
  it('treats a partially id-stamped list as old shape and re-sorts it', () => {
    const stack = effectStackOf({ effects: [
      { id: 'a', type: 'grain', amount: 0.2, size: 2, visible: true },
      { type: 'adjust', brightness: 1, contrast: 1, saturation: 1, hue: 0, visible: true },
    ] })
    expect(stack.map(e => e.type)).toEqual(['adjust', 'grain'])
  })
})

describe('writeStackToLayer', () => {
  it('returns a patch that stores the stack and clears the legacy fields', () => {
    const stack = effectStackOf({ tornEdge: { ...DEFAULT_TORN_EDGE, amount: 8 } })
    expect(writeStackToLayer(stack)).toEqual({ effects: stack, tornEdge: undefined, feather: undefined })
  })
})

describe('list operations', () => {
  const base = (): EffectInstance[] => effectStackOf({ effects: [
    { type: 'background_blur', radius: 0.01, visible: true },
    { type: 'adjust', brightness: 1, contrast: 1, saturation: 1, hue: 0, visible: true },
    { type: 'drop_shadow', color: '#000', x: 0, y: 0, blur: 0.01, visible: true },
  ] })

  it('adds an orderable kind at the end of the orderable region, before drop shadow', () => {
    const next = addEffect(base(), 'bloom')
    expect(next.map(e => e.type)).toEqual(['background_blur', 'adjust', 'bloom', 'drop_shadow'])
  })
  it('adds background blur first, dof after it, drop shadow last', () => {
    const s0 = effectStackOf({ effects: [{ type: 'adjust', brightness: 1, contrast: 1, saturation: 1, hue: 0, visible: true }] })
    expect(addEffect(s0, 'background_blur').map(e => e.type)).toEqual(['background_blur', 'adjust'])
    expect(addEffect(addEffect(s0, 'background_blur'), 'dof').map(e => e.type))
      .toEqual(['background_blur', 'dof', 'adjust'])
    expect(addEffect(s0, 'drop_shadow').map(e => e.type)).toEqual(['adjust', 'drop_shadow'])
  })
  it('refuses to add a second instance of a pinned kind, and allows a second orderable one', () => {
    const s = base()
    expect(addEffect(s, 'background_blur')).toEqual(s)
    expect(addEffect(s, 'drop_shadow')).toEqual(s)
    expect(addEffect(s, 'adjust').filter(e => e.type === 'adjust')).toHaveLength(2)
  })
  it('removes by id and leaves the rest in order', () => {
    const s = base()
    const id = s.find(e => e.type === 'adjust')!.id
    expect(removeEffect(s, id).map(e => e.type)).toEqual(['background_blur', 'drop_shadow'])
    expect(removeEffect(s, 'missing')).toEqual(s)
  })
  it('duplicates after the original with a fresh id', () => {
    const s = base()
    const id = s.find(e => e.type === 'adjust')!.id
    const next = duplicateEffect(s, id)
    expect(next.map(e => e.type)).toEqual(['background_blur', 'adjust', 'adjust', 'drop_shadow'])
    expect(next[2]!.id).not.toBe(next[1]!.id)
    expect(duplicateEffect(s, s.find(e => e.type === 'background_blur')!.id)).toEqual(s)
  })
  it('reorders within the orderable region and refuses anything touching a pinned row', () => {
    const s = addEffect(base(), 'bloom')            // bg, adjust, bloom, shadow
    const adjust = s.find(e => e.type === 'adjust')!.id
    const bloom = s.find(e => e.type === 'bloom')!.id
    const bg = s.find(e => e.type === 'background_blur')!.id
    expect(canReorder(s, adjust, bloom)).toBe(true)
    expect(reorderEffect(s, adjust, bloom).map(e => e.type))
      .toEqual(['background_blur', 'bloom', 'adjust', 'drop_shadow'])
    expect(canReorder(s, bg, adjust)).toBe(false)
    expect(canReorder(s, adjust, bg)).toBe(false)
    expect(reorderEffect(s, adjust, bg)).toEqual(s)
    expect(canReorder(s, adjust, adjust)).toBe(false)
  })
  it('orderablePasses and pinnedEffect split the stack', () => {
    const s = addEffect(base(), 'bloom')
    expect(orderablePasses(s).map(e => e.type)).toEqual(['adjust', 'bloom'])
    expect(pinnedEffect(s, 'background_blur')?.type).toBe('background_blur')
    expect(pinnedEffect(s, 'dof')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && node_modules/.bin/vitest run tests/unit/compositor-effect-stack.unit.spec.ts`
Expected: FAIL — `Failed to resolve import "~/lib/compositor/effectStack"`.

- [ ] **Step 3: Create `frontend/app/lib/compositor/effectStack.ts`**

```ts
// The per-layer effect stack: kinds, canonical order, and the one read-through that
// turns ANY layer — old shape or new — into an ordered list of id-stamped instances.
//
// Why read-through rather than migrate-on-load: stored layers are read with a raw cast
// and no sanitize step (useLocalLayerEditor.ts's `localLayers` computed, plus five other
// raw read sites), so a migration would have to write to every frame just by opening it,
// and any read site that skipped it would render a layer differently from the others.
// `effectStackOf` gives every consumer the same answer with no writes at all; the move to
// the stored new shape happens only when the user actually edits a layer's effects
// (`writeStackToLayer`).
//
// Pure: no Vue, no canvas, no `document`. The four layer-local effect interfaces live here
// rather than in useCompositorLayers.ts (which is a composable) so this module can own the
// whole vocabulary without an import cycle; that file re-exports them, so every existing
// consumer is unaffected.
import { DEFAULT_TORN_EDGE, tornEdgeActive, type TornEdgeSpec } from './tornEdge'
import { DEFAULT_FEATHER, featherActive, type FeatherSpec } from './feather'
import { POST_EFFECT_DEFAULTS, type PostEffect } from './postEffects'

// ── the four layer-local effects (moved verbatim from useCompositorLayers.ts) ──────────
// All distances normalized to canvas width, like every other dimension in the Compositor,
// so they survive resize/export unchanged.
export interface DropShadowEffect {
  type: 'drop_shadow'
  color: string   // rgba/hex (alpha allowed)
  x: number       // offset X, normalized to canvas width
  y: number       // offset Y, normalized to canvas width
  blur: number    // blur radius, normalized to canvas width
  visible: boolean
}
export interface LayerBlurEffect {
  type: 'layer_blur'
  radius: number  // blur radius, normalized to canvas width
  visible: boolean
}
/** Shadow cast inward from the layer's silhouette edge (Figma inner shadow). */
export interface InnerShadowEffect {
  type: 'inner_shadow'
  color: string
  x: number
  y: number
  blur: number
  visible: boolean
}
/** Blur what's BEHIND the layer, within its silhouette (Figma background blur). */
export interface BackgroundBlurEffect {
  type: 'background_blur'
  radius: number
  visible: boolean
}
/** Torn edge and feather were fields on the layer (`layer.tornEdge`, `layer.feather`),
 *  which is exactly what pinned them to one position in the pipeline. As effects they
 *  carry the same spec fields and become orderable like everything else. */
export interface TornEdgeEffect extends TornEdgeSpec { type: 'torn_edge'; visible: boolean }
export interface FeatherEffect extends FeatherSpec { type: 'feather'; visible: boolean }

export type LayerEffect =
  | DropShadowEffect | LayerBlurEffect | InnerShadowEffect | BackgroundBlurEffect
  | TornEdgeEffect | FeatherEffect
  | PostEffect

/** A stored effect, addressed by a stable id. */
export type EffectInstance = LayerEffect & { id: string }

export type EffectKind = LayerEffect['type']

/**
 * The order the pipeline applies these in, and therefore: the order an old-shape layer's
 * effects are sorted into (which is what makes an unedited document render identically),
 * the order the add menu lists them, and where a pinned kind sits.
 */
export const EFFECT_ORDER = [
  'background_blur', 'dof', 'inner_shadow', 'adjust', 'duotone', 'gradientMap',
  'bloom', 'vignette', 'grain', 'torn_edge', 'feather', 'layer_blur', 'drop_shadow',
] as const satisfies readonly EffectKind[]

/** Pinned for structural reasons, not convenience:
 *  - background_blur samples the backdrop BEFORE the layer paints, so it has no position
 *    inside the layer's own pass list;
 *  - dof needs its depth map aligned to the layer's own pixels, before the layer is
 *    rotated/scaled into frame space, and runs on the GPU against a box-sized source;
 *  - drop_shadow is derived from the finished silhouette at stamp time.
 *  At most one of each per layer, and they never move. */
export const PINNED_KINDS = ['background_blur', 'dof', 'drop_shadow'] as const satisfies readonly EffectKind[]
export const ORDERABLE_KINDS = EFFECT_ORDER.filter(
  (k): k is Exclude<EffectKind, typeof PINNED_KINDS[number]> => !(PINNED_KINDS as readonly string[]).includes(k),
)

/** UI copy: sentence case, human names, never the stored `type`. */
export const EFFECT_LABELS: Record<EffectKind, string> = {
  background_blur: 'Background blur',
  dof: 'Depth of field',
  inner_shadow: 'Inner shadow',
  adjust: 'Adjust',
  duotone: 'Duotone',
  gradientMap: 'Gradient map',
  bloom: 'Bloom',
  vignette: 'Vignette',
  grain: 'Grain',
  torn_edge: 'Torn edge',
  feather: 'Feather',
  layer_blur: 'Layer blur',
  drop_shadow: 'Drop shadow',
}

const ORDER_INDEX = new Map<string, number>(EFFECT_ORDER.map((k, i) => [k, i]))

export const isEffectKind = (v: unknown): v is EffectKind =>
  typeof v === 'string' && ORDER_INDEX.has(v)
export const isPinnedKind = (k: EffectKind): boolean =>
  (PINNED_KINDS as readonly string[]).includes(k)

/** Dial defaults per kind. The six chain kinds plus dof come from the shared post
 *  defaults; the rest are declared here, matching what the panels create today. */
const LOCAL_DEFAULTS: Record<string, Omit<LayerEffect, 'type'> & Record<string, unknown>> = {
  drop_shadow: { color: 'rgba(0,0,0,0.35)', x: 0, y: 0.01, blur: 0.02, visible: true },
  layer_blur: { radius: 0.01, visible: true },
  inner_shadow: { color: 'rgba(0,0,0,0.35)', x: 0, y: 0.01, blur: 0.02, visible: true },
  background_blur: { radius: 0.02, visible: true },
  torn_edge: { ...DEFAULT_TORN_EDGE, visible: true },
  feather: { ...DEFAULT_FEATHER, visible: true },
}

function defaultsFor(kind: EffectKind): Record<string, unknown> {
  const local = LOCAL_DEFAULTS[kind]
  if (local) return { ...local }
  const post = POST_EFFECT_DEFAULTS[kind as PostEffect['type']]
  return post ? { ...(post as unknown as Record<string, unknown>) } : { visible: true }
}

let idCounter = 0
/** A fresh id for a real mutation. Reads use deterministic ids instead — see `effectStackOf`. */
export function newEffectId(): string {
  return `fx_${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}_${++idCounter}`
}

export function createEffect(kind: EffectKind): EffectInstance {
  return { ...defaultsFor(kind), type: kind, visible: true, id: newEffectId() } as EffectInstance
}

export interface StackHost {
  effects?: unknown[]
  tornEdge?: TornEdgeSpec
  feather?: FeatherSpec
}

/**
 * ANY layer's ordered, id-stamped stack.
 *
 * New shape (every entry carries a string id): the stored array IS the user's order —
 * returned untouched.
 *
 * Old shape (any entry lacks an id): stamp DETERMINISTIC ids (`fx:<type>:<ordinal>` —
 * a random id per read would break selection and motion targets across re-reads), fold
 * the legacy `tornEdge`/`feather` fields in at their pipeline positions, drop unknown
 * kinds, and sort into EFFECT_ORDER. Same-type entries keep their relative order.
 */
export function effectStackOf(layer: StackHost | null | undefined): EffectInstance[] {
  const raw = Array.isArray(layer?.effects) ? layer!.effects : []
  const known = raw.filter(
    (e): e is Record<string, unknown> =>
      !!e && typeof e === 'object' && isEffectKind((e as { type?: unknown }).type),
  )
  const allIded = known.length > 0 && known.every(e => typeof e.id === 'string' && e.id !== '')
  if (allIded && !tornEdgeActive(layer?.tornEdge) && !featherActive(layer?.feather)) {
    return known as EffectInstance[]
  }
  const seen = new Map<string, number>()
  const stamp = (e: Record<string, unknown>): EffectInstance => {
    const type = e.type as EffectKind
    const n = seen.get(type) ?? 0
    seen.set(type, n + 1)
    const id = typeof e.id === 'string' && e.id !== '' ? e.id : `fx:${type}:${n}`
    return { ...e, id, visible: e.visible !== false } as EffectInstance
  }
  const out: EffectInstance[] = known.map(stamp)
  if (tornEdgeActive(layer?.tornEdge)) out.push(stamp({ ...layer!.tornEdge, type: 'torn_edge' }))
  if (featherActive(layer?.feather)) out.push(stamp({ ...layer!.feather, type: 'feather' }))
  return out
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (ORDER_INDEX.get(a.e.type) ?? 0) - (ORDER_INDEX.get(b.e.type) ?? 0) || a.i - b.i)
    .map(x => x.e)
}

/** The patch that stores a stack on a layer and retires the legacy fields. */
export function writeStackToLayer(stack: EffectInstance[]): {
  effects: EffectInstance[]; tornEdge: undefined; feather: undefined
} {
  return { effects: stack, tornEdge: undefined, feather: undefined }
}

export const pinnedEffect = (stack: EffectInstance[], kind: EffectKind): EffectInstance | undefined =>
  stack.find(e => e.type === kind)

/** The freely orderable entries, in list order — what `paintLayer` runs as passes. */
export const orderablePasses = (stack: EffectInstance[]): EffectInstance[] =>
  stack.filter(e => !isPinnedKind(e.type))

/** Insert a new effect. A pinned kind lands at its canonical position and is refused if
 *  already present; an orderable kind is appended after the last orderable entry, which
 *  keeps it before drop shadow. */
export function addEffect(stack: EffectInstance[], kind: EffectKind): EffectInstance[] {
  if (isPinnedKind(kind) && stack.some(e => e.type === kind)) return stack
  const fresh = createEffect(kind)
  const target = ORDER_INDEX.get(kind) ?? 0
  if (isPinnedKind(kind)) {
    const at = stack.findIndex(e => (ORDER_INDEX.get(e.type) ?? 0) > target)
    return at === -1 ? [...stack, fresh] : [...stack.slice(0, at), fresh, ...stack.slice(at)]
  }
  // An orderable kind goes to the END of the orderable region: right after the last orderable
  // entry, which keeps it before a drop shadow and after a background blur / dof.
  const lastOrderable = stack.reduce((acc, e, i) => (isPinnedKind(e.type) ? acc : i), -1)
  if (lastOrderable >= 0) {
    const at = lastOrderable + 1
    return [...stack.slice(0, at), fresh, ...stack.slice(at)]
  }
  // Nothing orderable yet: sit before the first pinned entry that sorts after this kind.
  const at = stack.findIndex(e => (ORDER_INDEX.get(e.type) ?? 0) > target)
  return at === -1 ? [...stack, fresh] : [...stack.slice(0, at), fresh, ...stack.slice(at)]
}

export function removeEffect(stack: EffectInstance[], id: string): EffectInstance[] {
  const next = stack.filter(e => e.id !== id)
  return next.length === stack.length ? stack : next
}

/** A copy directly after the original, with a fresh id. Pinned kinds cannot duplicate. */
export function duplicateEffect(stack: EffectInstance[], id: string): EffectInstance[] {
  const i = stack.findIndex(e => e.id === id)
  if (i === -1 || isPinnedKind(stack[i]!.type)) return stack
  const copy = { ...stack[i]!, id: newEffectId() }
  return [...stack.slice(0, i + 1), copy, ...stack.slice(i + 1)]
}

/** True when `fromId` may be dropped onto `toId`: both exist, both orderable, not the same. */
export function canReorder(stack: EffectInstance[], fromId: string, toId: string): boolean {
  if (fromId === toId) return false
  const from = stack.find(e => e.id === fromId)
  const to = stack.find(e => e.id === toId)
  return !!from && !!to && !isPinnedKind(from.type) && !isPinnedKind(to.type)
}

/** Move `fromId` to `toId`'s position. A move touching a pinned row is a no-op. */
export function reorderEffect(stack: EffectInstance[], fromId: string, toId: string): EffectInstance[] {
  if (!canReorder(stack, fromId, toId)) return stack
  const next = [...stack]
  const from = next.findIndex(e => e.id === fromId)
  const [moved] = next.splice(from, 1)
  const to = next.findIndex(e => e.id === toId)
  next.splice(to, 0, moved!)
  return next
}
```

- [ ] **Step 4: Move the four interfaces out of `useCompositorLayers.ts` and re-export**

In `frontend/app/composables/useCompositorLayers.ts`, delete lines 216-253 — the block from
`export interface DropShadowEffect {` through the `| DofEffect` that closes the `LayerEffect` union,
including the `export type { AdjustEffect, ... }` line at 247 — and replace the whole block with:

```ts
// Layer effects (Figma-style) live in ~/lib/compositor/effectStack, which owns the whole
// vocabulary (kinds, canonical order, the read-through that turns any layer into an ordered
// stack). Imported for this file's own use AND re-exported, so every existing consumer of
// these names is unaffected.
//
// Both lines are needed: `export type { X } from '…'` re-exports X without binding it in this
// module's scope, and this file references these names in its own signatures.
import type {
  DropShadowEffect, LayerBlurEffect, InnerShadowEffect, BackgroundBlurEffect,
  TornEdgeEffect, FeatherEffect, LayerEffect, EffectInstance, EffectKind,
} from '~/lib/compositor/effectStack'
export type {
  DropShadowEffect, LayerBlurEffect, InnerShadowEffect, BackgroundBlurEffect,
  TornEdgeEffect, FeatherEffect, LayerEffect, EffectInstance, EffectKind,
}
export type { AdjustEffect, BloomEffect, DofEffect, DuotoneEffect, GradientMapEffect, GrainEffect, PostEffect, VignetteEffect }
```

Then add the value import next to the existing compositor imports near the top of the file (beside
the `~/lib/compositor/paint` import at line 210-211):

```ts
import { effectStackOf, orderablePasses, pinnedEffect, type EffectInstance } from '~/lib/compositor/effectStack'
```

Leave `LayerCommon`'s `effects?`, `tornEdge?` and `feather?` fields (lines 300, 324, 327) exactly as
they are — read-through means old-shape layers stay legal, so those fields keep their types.

- [ ] **Step 5: Run the tests**

Run: `cd frontend && node_modules/.bin/vitest run tests/unit/compositor-effect-stack.unit.spec.ts tests/unit/compositor.unit.spec.ts tests/unit/post-effects.unit.spec.ts tests/unit/torn-edge.unit.spec.ts tests/unit/compositor-feather.unit.spec.ts`
Expected: all PASS. The four existing specs prove the re-export did not break any consumer.

- [ ] **Step 6: Typecheck the touched files**

Run: `cd frontend && node_modules/.bin/nuxt typecheck 2>&1 | grep -E "effectStack|useCompositorLayers\.ts"`
Expected: no lines mentioning `effectStack`, and no NEW error in `useCompositorLayers.ts` about the
moved names. Pre-existing errors elsewhere are not yours.

- [ ] **Step 7: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/lib/compositor/effectStack.ts frontend/app/composables/useCompositorLayers.ts frontend/tests/unit/compositor-effect-stack.unit.spec.ts
git commit -m "feat(frame): the per-layer effect stack model and read-through

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Ordered passes in postEffects.ts

**Files:**
- Modify: `frontend/app/lib/compositor/postEffects.ts:272-386`
- Test: `frontend/tests/unit/compositor-effect-passes.unit.spec.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (this module must stay importable BY `effectStack.ts`, so it must not
  import from it — keep the dependency one-way).
- Produces:
  - `applyPasses(off: HTMLCanvasElement, passes: { type: string; visible: boolean }[], opts: { W: number; scale?: number }): void`
    — applies in ARRAY ORDER, skipping invisible entries and any kind this module does not own
    (`inner_shadow`, `torn_edge`, `feather`, `layer_blur`, `drop_shadow`, `background_blur`, `dof`
    are applied by the caller, not here).
  - `applyEffectChain` keeps its exact signature and behaviour: it now sorts its input into the
    canonical chain order and delegates to `applyPasses`.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/unit/compositor-effect-passes.unit.spec.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { applyPasses, applyEffectChain } from '~/lib/compositor/postEffects'

/** A canvas stub that records the order of operations we can observe. `filter` writes and
 *  `putImageData` calls are enough to tell adjust (a filter draw) from duotone/gradientMap
 *  (putImageData) and from bloom (a 'lighter' composite). */
function stubCanvas(w = 8, h = 8) {
  const log: string[] = []
  const data = new Uint8ClampedArray(w * h * 4).fill(128)
  const ctx = {
    canvas: null as unknown as HTMLCanvasElement,
    filter: 'none',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '' as unknown,
    save: () => log.push('save'),
    restore: () => log.push('restore'),
    setTransform: () => {},
    clearRect: () => {},
    fillRect: () => log.push('fillRect'),
    drawImage: () => log.push(`draw:${(ctx as any).globalCompositeOperation}`),
    getImageData: () => ({ data, width: w, height: h }),
    putImageData: () => log.push('putImageData'),
    createRadialGradient: () => ({ addColorStop: () => {} }),
    createPattern: () => ({}),
    scale: () => {},
  }
  const canvas = { width: w, height: h, getContext: () => ctx } as unknown as HTMLCanvasElement
  ;(ctx as any).canvas = canvas
  return { canvas, ctx, log }
}

const adjust = (over = {}) => ({ type: 'adjust', brightness: 1.5, contrast: 1, saturation: 1, hue: 0, visible: true, ...over })
const duotone = (over = {}) => ({ type: 'duotone', shadows: '#000000', highlights: '#ffffff', mix: 1, visible: true, ...over })
const grain = (over = {}) => ({ type: 'grain', amount: 0.5, size: 2, visible: true, ...over })

describe('applyPasses', () => {
  it('applies in array order, not canonical order', () => {
    vi.stubGlobal('document', { createElement: () => stubCanvas().canvas })
    const a = stubCanvas()
    applyPasses(a.canvas, [duotone(), adjust()], { W: 100, scale: 1 })
    const b = stubCanvas()
    applyPasses(b.canvas, [adjust(), duotone()], { W: 100, scale: 1 })
    // adjust draws through `filter`; duotone writes pixels back. The two orders therefore
    // produce different operation sequences.
    expect(a.log.indexOf('putImageData')).toBeLessThan(a.log.lastIndexOf('draw:source-over'))
    expect(b.log.indexOf('putImageData')).toBeGreaterThan(b.log.indexOf('draw:source-over'))
    vi.unstubAllGlobals()
  })
  it('applies the same kind more than once', () => {
    vi.stubGlobal('document', { createElement: () => stubCanvas().canvas })
    const { canvas, log } = stubCanvas()
    applyPasses(canvas, [duotone(), duotone()], { W: 100, scale: 1 })
    expect(log.filter(l => l === 'putImageData')).toHaveLength(2)
    vi.unstubAllGlobals()
  })
  it('skips invisible entries and kinds it does not own', () => {
    vi.stubGlobal('document', { createElement: () => stubCanvas().canvas })
    const { canvas, log } = stubCanvas()
    applyPasses(canvas, [
      duotone({ visible: false }),
      { type: 'torn_edge', visible: true } as any,
      { type: 'drop_shadow', visible: true } as any,
    ], { W: 100, scale: 1 })
    expect(log.filter(l => l === 'putImageData')).toHaveLength(0)
    vi.unstubAllGlobals()
  })
  it('does nothing for an empty list', () => {
    const { canvas, log } = stubCanvas()
    applyPasses(canvas, [], { W: 100, scale: 1 })
    expect(log).toEqual([])
  })
})

describe('applyEffectChain keeps canonical order regardless of array order', () => {
  it('runs adjust before grain even when grain is listed first', () => {
    vi.stubGlobal('document', { createElement: () => stubCanvas().canvas })
    const { canvas, log } = stubCanvas()
    applyEffectChain(canvas, [grain(), adjust()] as any, { W: 100, scale: 1 })
    // adjust's filtered draw (source-over) must precede grain's 'overlay' composite
    expect(log.indexOf('draw:source-over')).toBeLessThan(log.indexOf('draw:overlay'))
    vi.unstubAllGlobals()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && node_modules/.bin/vitest run tests/unit/compositor-effect-passes.unit.spec.ts`
Expected: FAIL — `applyPasses` is not exported from `~/lib/compositor/postEffects`.

- [ ] **Step 3: Extract the six per-type blocks into pass functions**

In `frontend/app/lib/compositor/postEffects.ts`, the current `applyEffectChain` body (lines 272-386)
holds six blocks, each shaped `const x = find<XEffect>('x'); if (x && …) { …body… }`. Convert each
into a module-level function, **moving the body verbatim** and changing only the two mechanical
things named below. The exact line ranges to extract, from the current file:

| kind | lines | new function |
|---|---|---|
| adjust | 284-296 | `passAdjust(ctx, off, e, opts)` |
| duotone | 298-306 | `passDuotone(ctx, off, e, opts)` |
| gradientMap | 308-316 | `passGradientMap(ctx, off, e, opts)` |
| bloom | 318-342 | `passBloom(ctx, off, e, opts)` |
| vignette | 344-360 | `passVignette(ctx, off, e, opts)` |
| grain | 362-385 | `passGrain(ctx, off, e, opts)` |

The two mechanical changes, per block:

1. Delete the `const x = find<XEffect>('x')` line; the effect arrives as the parameter `e`.
2. Keep the block's own guard, but drop the leading `x &&` from it and rename `x` to `e`
   throughout the body. So `if (bloom && bloom.intensity > 0 && bloom.radius > 0) { … }` becomes
   `if (!(e.intensity > 0 && e.radius > 0)) return` followed by the unchanged body.

Nothing inside a body changes — the same `cloneCanvas`, `mkCanvas`, `getImageData`, transforms,
composite operations and constants. `scale` becomes `opts.scale ?? 1` at the top of each function
that used it (bloom and grain), and `opts.W` is already written that way.

Worked example — adjust, the first block, as the pattern for the other five:

```ts
type PassOpts = { W: number; scale?: number }

function passAdjust(ctx: CanvasRenderingContext2D, off: HTMLCanvasElement, e: AdjustEffect, _opts: PassOpts): void {
  const f = adjustFilterString(e)
  if (!f) return
  const src = cloneCanvas(off)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, off.width, off.height)
  ctx.filter = f
  ctx.drawImage(src, 0, 0)
  ctx.restore()
}
```

- [ ] **Step 4: Add `applyPasses` and rewrite `applyEffectChain` over it**

Replace what remains of `applyEffectChain` (its signature at 272-276 and whatever is left of its body
after the six extractions) with:

```ts
/** The kinds this module owns as 2D passes over a layer/document offscreen. Everything
 *  else in a layer's stack (inner shadow, torn edge, feather, layer blur, drop shadow,
 *  background blur, dof) is applied by the caller at its own structural position. */
const PASS_TYPES = new Set<string>(['adjust', 'duotone', 'gradientMap', 'bloom', 'vignette', 'grain'])

/**
 * Apply passes in ARRAY ORDER — the per-layer entry point. Order is the caller's, so the
 * same two effects in two orders produce two different images, and a kind may repeat.
 * Entries this module does not own, and invisible entries, are skipped.
 */
export function applyPasses(
  off: HTMLCanvasElement,
  passes: readonly { type: string; visible: boolean }[],
  opts: PassOpts,
): void {
  if (!passes.length) return
  const ctx = off.getContext('2d')
  if (!ctx) return
  for (const e of passes) {
    if (!e.visible || !PASS_TYPES.has(e.type)) continue
    switch (e.type) {
      case 'adjust': passAdjust(ctx, off, e as unknown as AdjustEffect, opts); break
      case 'duotone': passDuotone(ctx, off, e as unknown as DuotoneEffect, opts); break
      case 'gradientMap': passGradientMap(ctx, off, e as unknown as GradientMapEffect, opts); break
      case 'bloom': passBloom(ctx, off, e as unknown as BloomEffect, opts); break
      case 'vignette': passVignette(ctx, off, e as unknown as VignetteEffect, opts); break
      case 'grain': passGrain(ctx, off, e as unknown as GrainEffect, opts); break
    }
  }
}

const CHAIN_ORDER = ['adjust', 'duotone', 'gradientMap', 'bloom', 'vignette', 'grain']

/**
 * The FIXED-ORDER entry point, unchanged in behaviour: one instance per type, applied in
 * the canonical chain order whatever the array says. `applyStackPost` (the document-level
 * post stack) uses this, and that stack's stored array order is arbitrary — sorting here is
 * what keeps every existing document rendering exactly as it did.
 */
export function applyEffectChain(
  off: HTMLCanvasElement,
  effects: PostEffect[],
  opts: PassOpts,
): void {
  const first = new Map<string, PostEffect>()
  for (const e of effects) if (!first.has(e.type)) first.set(e.type, e)
  applyPasses(off, CHAIN_ORDER.map(t => first.get(t)).filter((e): e is PostEffect => !!e), opts)
}
```

- [ ] **Step 5: Run the tests**

Run: `cd frontend && node_modules/.bin/vitest run tests/unit/compositor-effect-passes.unit.spec.ts tests/unit/post-effects.unit.spec.ts tests/unit/post-effects-paint.unit.spec.ts tests/unit/compositor.unit.spec.ts`
Expected: all PASS. `post-effects.unit.spec.ts` and `post-effects-paint.unit.spec.ts` are the
existing coverage of the chain — they must pass **unchanged**, which is the proof that
`applyEffectChain` still behaves exactly as before.

- [ ] **Step 6: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/lib/compositor/postEffects.ts frontend/tests/unit/compositor-effect-passes.unit.spec.ts
git commit -m "feat(frame): apply layer post effects in array order, keeping the chain wrapper

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `paintLayer` runs the ordered stack

This is the task that changes what pixels come out, so its acceptance bar is: **a layer whose stored
shape is untouched renders byte-identically.** Read-through guarantees the *order* is the old
canonical one for such a layer; this task must not change anything else about how the passes run.

**Files:**
- Modify: `frontend/app/lib/compositor/postEffects.ts` (add `applyBlurPass`)
- Modify: `frontend/app/composables/useCompositorLayers.ts:1687-1693, 1718-1724, 1740-1743, 1862, 1894-1918, 1925-1934`
- Test: append to `frontend/tests/unit/compositor-effect-passes.unit.spec.ts`; append to
  `frontend/tests/unit/compositor-silhouette-cache.unit.spec.ts`

**Interfaces:**
- Consumes: `effectStackOf`, `orderablePasses`, `pinnedEffect`, `EffectInstance` (Task 1);
  `applyPasses` (Task 2).
- Produces: `applyBlurPass(off: HTMLCanvasElement, radiusPx: number): void` exported from
  `~/lib/compositor/postEffects` — a whole-offscreen gaussian blur, the `layer_blur` effect as a
  pass. Takes a plain number rather than the effect so `postEffects.ts` keeps its one-way
  independence from `effectStack.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/tests/unit/compositor-effect-passes.unit.spec.ts`:

```ts
import { applyBlurPass } from '~/lib/compositor/postEffects'

describe('applyBlurPass', () => {
  it('redraws the offscreen through a blur filter at the given device radius', () => {
    const inner = stubCanvas()
    vi.stubGlobal('document', { createElement: () => inner.canvas })
    const { canvas, ctx, log } = stubCanvas()
    const seen: string[] = []
    Object.defineProperty(ctx, 'filter', { set: (v: string) => seen.push(v), get: () => 'none' })
    applyBlurPass(canvas, 12)
    expect(seen).toContain('blur(12px)')
    expect(log).toContain('draw:source-over')
    vi.unstubAllGlobals()
  })
  it('is a no-op at radius 0 or below', () => {
    const { canvas, log } = stubCanvas()
    applyBlurPass(canvas, 0)
    applyBlurPass(canvas, -3)
    expect(log).toEqual([])
  })
})
```

Append to `frontend/tests/unit/compositor-silhouette-cache.unit.spec.ts` (match the file's existing
import style for `silhouetteCacheKey`):

```ts
describe('silhouette cache key covers stack order', () => {
  it('two stacks differing only in order produce different keys', () => {
    const a = { effects: [{ id: 'a', type: 'torn_edge', visible: true }, { id: 'b', type: 'feather', visible: true }] }
    const b = { effects: [{ id: 'b', type: 'feather', visible: true }, { id: 'a', type: 'torn_edge', visible: true }] }
    expect(silhouetteCacheKey(a, 2, 100, 100, 1000)).not.toBe(silhouetteCacheKey(b, 2, 100, 100, 1000))
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && node_modules/.bin/vitest run tests/unit/compositor-effect-passes.unit.spec.ts tests/unit/compositor-silhouette-cache.unit.spec.ts`
Expected: the `applyBlurPass` cases FAIL (not exported). **The silhouette-key case may already
pass** — `effects` is not in `SILHOUETTE_KEY_STRIP` and `canonicalize` sorts object keys while
preserving array order, so order is probably already in the key. If it passes, say so in your report
and keep the test as a regression guard. If it fails, add `effects` order to the key in
`frontend/app/lib/compositor/silhouetteCache.ts` and note exactly what you changed.

- [ ] **Step 3: Add `applyBlurPass` to `postEffects.ts`**

Add next to the other pass functions from Task 2:

```ts
/**
 * Gaussian blur of the whole offscreen — the per-layer `layer_blur` effect as a pass.
 * It used to be a CSS filter set on the stamp's `drawImage`; the canvas applies filter,
 * then shadow, then composite, so the drop shadow followed the blurred silhouette. Running
 * the blur here, before the stamp, preserves that exactly.
 *
 * `radiusPx` is already in DEVICE pixels (the caller multiplies by `W * scale`), and takes a
 * number rather than the effect so this module keeps its one-way independence from
 * effectStack.ts.
 */
export function applyBlurPass(off: HTMLCanvasElement, radiusPx: number): void {
  if (!(radiusPx > 0)) return
  const ctx = off.getContext('2d')
  if (!ctx) return
  const src = cloneCanvas(off)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, off.width, off.height)
  ctx.filter = `blur(${radiusPx}px)`
  ctx.drawImage(src, 0, 0)
  ctx.filter = 'none'
  ctx.restore()
}
```

- [ ] **Step 4: Replace the effect lookup block in `paintLayer`**

In `frontend/app/composables/useCompositorLayers.ts`, replace lines 1687-1693 (the block quoted
below, verbatim as it stands today):

```ts
  const fx = (layer.effects ?? []).filter(e => e.visible)
  const shadow = fx.find((e): e is DropShadowEffect => e.type === 'drop_shadow')
  const blur = fx.find((e): e is LayerBlurEffect => e.type === 'layer_blur')
  const inner = fx.find((e): e is InnerShadowEffect => e.type === 'inner_shadow')
  const chain = fx.filter(isChainEffect)
  const tornEdge = tornEdgeActive(layer.tornEdge) ? layer.tornEdge : undefined
  const feather = featherActive(layer.feather) ? layer.feather : undefined
```

with:

```ts
  // The layer's ordered stack, old shape or new — see lib/compositor/effectStack.ts. For an
  // unedited (old-shape) layer this is the legacy canonical order, so the pass sequence below
  // is exactly what the fixed lookups used to produce.
  const stack = effectStackOf(layer).filter(e => e.visible)
  const shadow = pinnedEffect(stack, 'drop_shadow') as DropShadowEffect | undefined
  // Everything between the pinned three, in the user's order. inner shadow / the six chain
  // kinds / torn edge / feather / layer blur all run here.
  const passes = orderablePasses(stack)
  // The silhouette raster bakes torn edge + feather into the layer's own box. Layer blur may
  // ride along ONLY when every blur comes after every edge pass, which is the legacy order —
  // otherwise the raster would apply them the wrong way round.
  const lastEdgePass = passes.reduce((m, e, i) => (e.type === 'torn_edge' || e.type === 'feather' ? i : m), -1)
  const firstBlurPass = passes.findIndex(e => e.type === 'layer_blur')
  const rasterablePasses = passes.length > 0
    && passes.every(e => e.type === 'torn_edge' || e.type === 'feather' || e.type === 'layer_blur')
    && lastEdgePass >= 0
    && (firstBlurPass === -1 || firstBlurPass > lastEdgePass)
```

- [ ] **Step 5: Update the silhouette-cacheable condition**

Replace lines 1718-1724 (`const silhouetteCacheable = …` through `&& silhouetteContentReady(layer, W)`)
with the same condition expressed against the stack. Only the first and fourth lines change; the
other four are unchanged and must be kept verbatim:

```ts
  const silhouetteCacheable = rasterablePasses
    && layer.kind !== 'wired'                                       // graph pixels change under us — no content signature
    && !cp && !dof                                                  // corner-pin / DOF have their own offscreen flows
    && !(layer.kind === 'text' && layer.expressive)                 // expressive layout places words outside localLayerBox
    && !layerPaints(layer).some(p => isFill(p) && fillIsShader(p))  // shader fills are live / frame-anchored
    && silhouetteContentReady(layer, W)
```

(The old `&& !inner && !chain.length` line is gone because `rasterablePasses` already requires the
stack to hold nothing but edge passes and a trailing blur.)

- [ ] **Step 6: Bake the edge passes into the raster in list order**

Inside `silhouetteRaster`, replace these two lines (currently at 1740-1741):

```ts
    if (tornEdge) applyTornEdge(cc, tornEdge, { scale: s })
    if (feather) applyFeather(cc, feather)
```

with:

```ts
    // In list order: a feather before a tear and a tear before a feather are different
    // pictures, and the raster has to agree with the uncached path below.
    for (const e of passes) {
      if (e.type === 'torn_edge') applyTornEdge(cc, e as unknown as TornEdgeSpec, { scale: s })
      else if (e.type === 'feather') applyFeather(cc, e as unknown as FeatherSpec)
    }
```

- [ ] **Step 7: Update the effected-path condition and the DOF lookup**

Replace line 1862:

```ts
    if (shadow || blur || inner || chain.length || tornEdge || feather) {
```

with:

```ts
    if (shadow || passes.length) {
```

And replace the `dof` lookup (currently `const dof = dofRef ? fx.find((e): e is DofEffect => e.type === 'dof') : undefined`) with:

```ts
  const dof = dofRef ? (pinnedEffect(stack, 'dof') as DofEffect | undefined) : undefined
```

- [ ] **Step 8: Run the ordered passes in the two paint branches**

In the raster branch, after the existing `octx.drawImage(raster.canvas, …)` line (currently 1902),
add:

```ts
          // Torn edge / feather are already baked into the raster; a trailing layer blur is
          // not, so apply it here (rasterablePasses guarantees blur comes last).
          for (const e of passes) {
            if (e.type === 'layer_blur') applyBlurPass(off, Math.max(0, (e as LayerBlurEffect).radius * W * s))
          }
```

In the uncached branch, replace lines 1904-1918 — from `drawContent(octx)` through
`if (feather) applyFeather(off, feather)` — with:

```ts
          drawContent(octx)
          // The layer's passes, in the user's order. For an unedited layer that order is the
          // legacy one (inner shadow, then the six chain kinds, then torn edge, feather, blur),
          // so this produces the same canvas operations the fixed sequence did.
          //
          // scale = device px per logical px, so bloom radius / grain size / blur radius land
          // at the right physical size on a device-resolution buffer (mirrors applyStackPost).
          for (const e of passes) {
            switch (e.type) {
              case 'inner_shadow':
                compositeInnerShadow(off, e as unknown as InnerShadowEffect, W, s); break
              // Torn edge carves the offscreen's alpha + paints the lip, in device px, so
              // preview and export tear identically.
              case 'torn_edge':
                applyTornEdge(off, e as unknown as TornEdgeSpec, { scale: s }); break
              // Feather softens whatever silhouette exists (including a torn one) by fading
              // alpha inward. amount is element-relative (derived from the rendered
              // silhouette's own bbox), so no canvas/scale is passed.
              case 'feather':
                applyFeather(off, e as unknown as FeatherSpec); break
              case 'layer_blur':
                applyBlurPass(off, Math.max(0, (e as LayerBlurEffect).radius * W * s)); break
              default:
                applyPasses(off, [e], { W, scale: s })
            }
          }
```

- [ ] **Step 9: Drop the blur from the stamp**

In the stamp block (currently 1925-1934), delete this one line:

```ts
        if (blur) ctx.filter = `blur(${Math.max(0, blur.radius * W * s)}px)`
```

Everything else in that block — `globalAlpha`, `globalCompositeOperation`, the four `shadow*`
assignments and the `drawImage` — stays exactly as it is. The drop shadow still follows the blurred
silhouette, because the blur is now already in `off`.

- [ ] **Step 10: Fix the imports**

Add to the imports in `frontend/app/composables/useCompositorLayers.ts`:

```ts
import { applyPasses, applyBlurPass } from '~/lib/compositor/postEffects'
```

(merge into the existing `~/lib/compositor/postEffects` import if there is one). The pass loop in
Step 8 casts to `TornEdgeSpec` and `FeatherSpec`, which this file only references through inline
`import('…')` types today (lines 324, 327) — add real type imports for them:

```ts
import type { TornEdgeSpec } from '~/lib/compositor/tornEdge'
import type { FeatherSpec } from '~/lib/compositor/feather'
```

Then remove any import that is now unused — `isChainEffect`, `tornEdgeActive`, `featherActive`, and
`applyEffectChain` if `paintLayer` was its only caller in this file. Check each with
`grep -n "isChainEffect\|tornEdgeActive\|featherActive\|applyEffectChain" app/composables/useCompositorLayers.ts`
before deleting: `paintLayerStack` still calls `applyStackPost`, and other functions may still use the
type guards.

- [ ] **Step 11: Run the tests**

Run: `cd frontend && node_modules/.bin/vitest run tests/unit/compositor-effect-passes.unit.spec.ts tests/unit/compositor-silhouette-cache.unit.spec.ts tests/unit/compositor.unit.spec.ts tests/unit/post-effects-paint.unit.spec.ts tests/unit/brush-layer-render.unit.spec.ts tests/unit/layer-mask-composite.unit.spec.ts tests/unit/torn-edge.unit.spec.ts tests/unit/compositor-feather.unit.spec.ts tests/unit/wired-layer.unit.spec.ts`
Expected: all PASS.

- [ ] **Step 12: Typecheck**

Run: `cd frontend && node_modules/.bin/nuxt typecheck 2>&1 | grep -E "useCompositorLayers\.ts|postEffects\.ts|effectStack"`
Expected: no NEW errors mentioning `passes`, `stack`, `applyBlurPass`, `rasterablePasses` or
`effectStackOf`.

- [ ] **Step 13: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/lib/compositor/postEffects.ts frontend/app/composables/useCompositorLayers.ts frontend/app/lib/compositor/silhouetteCache.ts frontend/tests/unit/compositor-effect-passes.unit.spec.ts frontend/tests/unit/compositor-silhouette-cache.unit.spec.ts
git commit -m "feat(frame): paint a layer's effects in list order, blur as a pass

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

(Drop `silhouetteCache.ts` from the `git add` if Step 2 showed the key already covers order and you
changed nothing in it.)

---

### Task 4: The agent addresses effects by id

**Files:**
- Modify: `frontend/app/lib/agent/surfaces/compositor.ts:435-438, 457-459, 835-856, 1004`
- Test: `frontend/tests/unit/agent-compositor-surface.unit.spec.ts` (append),
  `frontend/tests/unit/agent-torn-edge.unit.spec.ts` and
  `frontend/tests/unit/agent-feather.unit.spec.ts` (adjust)

**Interfaces:**
- Consumes: `effectStackOf`, `writeStackToLayer`, `addEffect`, `removeEffect`, `EFFECT_LABELS`,
  `isEffectKind` (Task 1).
- Produces: no new exports. `setLayerEffect` keeps its name and its `type` argument, but now writes
  through the stack so torn edge and feather are reachable by the same op, and an existing
  new-shape layer's order survives an edit.

- [ ] **Step 1: Write the failing test**

Append to `frontend/tests/unit/agent-compositor-surface.unit.spec.ts` (match the file's existing
harness for building a doc and running an op — read the top of the file first and reuse it):

```ts
describe('setLayerEffect writes through the effect stack', () => {
  it('adds an effect to a layer that has none, storing an id-stamped list', () => {
    const { doc, run } = makeDoc([{ id: 'L1', kind: 'rect' }])   // reuse this file's own helper
    run({ op: 'setLayerEffect', args: { id: 'L1', type: 'bloom', intensity: 1.5 } })
    const fx = doc.layers[0]!.effects!
    expect(fx.map((e: any) => e.type)).toEqual(['bloom'])
    expect(typeof fx[0]!.id).toBe('string')
    expect((fx[0] as any).intensity).toBe(1.5)
  })
  it('reaches torn edge and feather through the same op', () => {
    const { doc, run } = makeDoc([{ id: 'L1', kind: 'rect' }])
    run({ op: 'setLayerEffect', args: { id: 'L1', type: 'torn_edge', amount: 14 } })
    run({ op: 'setLayerEffect', args: { id: 'L1', type: 'feather', amount: 0.3 } })
    const types = doc.layers[0]!.effects!.map((e: any) => e.type)
    expect(types).toEqual(['torn_edge', 'feather'])
    expect(doc.layers[0]!.tornEdge).toBeUndefined()
    expect(doc.layers[0]!.feather).toBeUndefined()
  })
  it('edits an existing instance in place and keeps the stack order', () => {
    const { doc, run } = makeDoc([{ id: 'L1', kind: 'rect', effects: [
      { id: 'x', type: 'grain', amount: 0.2, size: 2, visible: true },
      { id: 'y', type: 'adjust', brightness: 1, contrast: 1, saturation: 1, hue: 0, visible: true },
    ] }])
    run({ op: 'setLayerEffect', args: { id: 'L1', type: 'adjust', brightness: 1.4 } })
    const fx = doc.layers[0]!.effects!
    expect(fx.map((e: any) => e.type)).toEqual(['grain', 'adjust'])   // order preserved
    expect((fx[1] as any).brightness).toBe(1.4)
    expect(fx[1]!.id).toBe('y')                                       // same instance
  })
  it('removes by type', () => {
    const { doc, run } = makeDoc([{ id: 'L1', kind: 'rect', effects: [
      { id: 'x', type: 'grain', amount: 0.2, size: 2, visible: true },
    ] }])
    run({ op: 'setLayerEffect', args: { id: 'L1', type: 'grain', remove: true } })
    expect(doc.layers[0]!.effects).toEqual([])
  })
  it('migrates a legacy tornEdge field on the first effect edit of that layer', () => {
    const { doc, run } = makeDoc([{ id: 'L1', kind: 'rect', tornEdge: { style: 'ragged', amount: 10, roughness: 0.5, grain: 0, grainTexture: 0, lipWidth: 0, lipVariation: 0, lipColor: '#fff', seed: 1 } }])
    run({ op: 'setLayerEffect', args: { id: 'L1', type: 'bloom', intensity: 1 } })
    const types = doc.layers[0]!.effects!.map((e: any) => e.type)
    expect(types).toEqual(['bloom', 'torn_edge'])
    expect(doc.layers[0]!.tornEdge).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && node_modules/.bin/vitest run tests/unit/agent-compositor-surface.unit.spec.ts`
Expected: the new cases FAIL — today's `setLayerEffect` writes `[...others, next]` with no id and
never touches `tornEdge`.

- [ ] **Step 3: Rewrite the effect mutation**

In `frontend/app/lib/agent/surfaces/compositor.ts`, replace the `setLayerEffect` body (currently
lines 835-840):

```ts
      const others = (layer.effects ?? []).filter(e => e.type !== type)
      if (cmd.args?.remove === true) { layer.effects = others; return { ok: true, template: state, inverse: snapshot() } }
      const cur = (layer.effects ?? []).find(e => e.type === type) as PostEffect | undefined
      ...
      layer.effects = [...others, next]
```

with a stack-based version. Read the surrounding lines first so you keep this file's own `next`
construction (the merge of `cmd.args` over the current effect or the kind's defaults) — only the
read and the write change:

```ts
      const stack = effectStackOf(layer)
      if (cmd.args?.remove === true) {
        const gone = stack.filter(e => e.type !== type)
        Object.assign(layer, writeStackToLayer(gone))
        return { ok: true, template: state, inverse: snapshot() }
      }
      const cur = stack.find(e => e.type === type)
      // …this file's existing `next` construction, merging cmd.args over `cur` or the defaults…
      const withEffect = cur
        ? stack.map(e => (e.id === cur.id ? { ...next, id: cur.id } : e))     // edit in place, order kept
        : addEffect(stack, type)
      const applied = cur
        ? withEffect
        : withEffect.map(e => (e.type === type && !stack.some(s => s.id === e.id) ? { ...e, ...next } : e))
      Object.assign(layer, writeStackToLayer(applied))
```

Retire `setLayerTornEdge` and `setLayerFeather` (lines 437-438) by making them thin aliases that call
the same path with `type: 'torn_edge'` / `type: 'feather'`, so an existing agent recipe keeps working.
Update the summary lines 457-459 to read from the stack:

```ts
    const st = effectStackOf(l)
    if (st.length) cur.effects = st.filter(e => e.visible).map(e => EFFECT_LABELS[e.type]).join(', ')
```

(the two `tornEdge` / `feather` summary lines are deleted — they are in the stack now). Update line
1004's `const had = !!layer?.effects?.some(e => e.type === type)` to
`const had = effectStackOf(layer).some(e => e.type === type)`.

- [ ] **Step 4: Run the tests**

Run: `cd frontend && node_modules/.bin/vitest run tests/unit/agent-compositor-surface.unit.spec.ts tests/unit/agent-torn-edge.unit.spec.ts tests/unit/agent-feather.unit.spec.ts tests/unit/agent-compositor-shape.unit.spec.ts`
Expected: all PASS. The torn-edge and feather agent specs assert the OLD field shape, so they need
their assertions moved to the stack — change the assertions, not the behaviour, and say in your
report exactly which assertions you changed and why.

- [ ] **Step 5: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/lib/agent/surfaces/compositor.ts frontend/tests/unit/agent-compositor-surface.unit.spec.ts frontend/tests/unit/agent-torn-edge.unit.spec.ts frontend/tests/unit/agent-feather.unit.spec.ts
git commit -m "feat(frame): the agent edits layer effects through the ordered stack

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Effect rows in the layer tree

**Files:**
- Create: `frontend/app/components/vue-canvas/compositor/CompositorEffectRow.vue`
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue:1775, 1798-1801, 1802-1841, 5281-5284`, plus the row's trailing controls

**Interfaces:**
- Consumes: `effectStackOf`, `EFFECT_ORDER`, `EFFECT_LABELS`, `PINNED_KINDS`, `isPinnedKind`,
  `addEffect`, `removeEffect`, `duplicateEffect`, `reorderEffect`, `canReorder`,
  `writeStackToLayer`, types `EffectInstance` / `EffectKind` (Task 1).
- Produces (all in `CompositorModal.vue`, consumed by Task 6):
  - `expandedLayers: Ref<Set<string>>`
  - `layerStack(layer): EffectInstance[]`
  - `setLayerStack(layerId: string, stack: EffectInstance[]): void` — writes through
    `setLocal(layerId, writeStackToLayer(stack))`
  - handlers `addLayerEffect(layerId, kind)`, `removeLayerEffect(layerId, effectId)`,
    `duplicateLayerEffect(layerId, effectId)`, `toggleLayerEffect(layerId, effectId)`,
    `reorderLayerEffect(layerId, fromId, toId)`
  - `FlatRow`'s new `'effect'` variant, shape given in Step 3 (the row reads the kind off
    `effect.type`; there is no separate `effectKind` field).
  - `CompositorEffectRow` props `{ effect: EffectInstance; layerId: string; depth: number; selected: boolean; pinned: boolean }`, emits
    `select | remove | duplicate | toggleVisible`, each `[layerId: string, effectId: string]`, plus
    `dragStart` / `dropOn` with the same payload. Test ids: root `data-testid="effect-row"` with
    `data-effect-id`, `data-effect-kind`, `data-layer-id`.

- [ ] **Step 1: Create `frontend/app/components/vue-canvas/compositor/CompositorEffectRow.vue`**

```vue
<script setup lang="ts">
// One effect row under its layer in the Compositor's layer tree. A pseudo-child: it is not a
// layer, so every event is routed to the modal's effect handlers, never the layer ones.
// Drag reorders within the layer's own orderable region — the modal decides whether a drop
// is legal (a pinned row refuses).
import { Eye, EyeOff, Copy, Trash2, Pin } from 'lucide-vue-next'
import { EFFECT_LABELS, type EffectInstance } from '~/lib/compositor/effectStack'

defineProps<{
  effect: EffectInstance
  layerId: string
  depth: number
  selected: boolean
  /** Pinned kinds (background blur, depth of field, drop shadow) cannot move. */
  pinned: boolean
}>()
const emit = defineEmits<{
  select: [layerId: string, effectId: string]
  remove: [layerId: string, effectId: string]
  duplicate: [layerId: string, effectId: string]
  toggleVisible: [layerId: string, effectId: string]
  dragStart: [layerId: string, effectId: string]
  dropOn: [layerId: string, effectId: string]
}>()

function onDragStart(ev: DragEvent, layerId: string, effectId: string) {
  // Firefox refuses to start a drag with no payload.
  ev.dataTransfer?.setData('text/plain', effectId)
  emit('dragStart', layerId, effectId)
}
</script>

<template>
  <div
    class="group/fx flex items-center gap-1.5 pr-2 py-1 rounded transition-colors cursor-pointer"
    data-testid="effect-row"
    :data-effect-id="effect.id"
    :data-effect-kind="effect.type"
    :data-layer-id="layerId"
    :style="{ paddingLeft: (depth * 14 + 4) + 'px' }"
    :class="[
      selected ? 'bg-white/10' : 'hover:bg-white/[0.04]',
      effect.visible ? '' : 'opacity-50',
      'border-l border-white/10',
    ]"
    :draggable="!pinned"
    @click.stop="emit('select', layerId, effect.id)"
    @dragstart="onDragStart($event, layerId, effect.id)"
    @dragover.prevent
    @drop.prevent="emit('dropOn', layerId, effect.id)"
  >
    <span class="w-3 shrink-0" />
    <Pin v-if="pinned" class="size-3 text-white/30 shrink-0" title="Fixed position in the pipeline" />
    <span v-else class="w-3 shrink-0" />
    <span class="text-xs truncate flex-1 text-white/70">{{ EFFECT_LABELS[effect.type] }}</span>
    <button type="button" class="shrink-0 text-white/40 hover:text-white/80"
      :class="effect.visible ? 'opacity-0 group-hover/fx:opacity-100' : 'opacity-100'"
      :aria-label="effect.visible ? 'Hide effect' : 'Show effect'"
      @click.stop="emit('toggleVisible', layerId, effect.id)">
      <component :is="effect.visible ? Eye : EyeOff" class="size-3.5" />
    </button>
    <button v-if="!pinned" type="button" class="shrink-0 opacity-0 group-hover/fx:opacity-100 text-white/40 hover:text-white/80"
      aria-label="Duplicate effect" @click.stop="emit('duplicate', layerId, effect.id)">
      <Copy class="size-3.5" />
    </button>
    <button type="button" class="shrink-0 opacity-0 group-hover/fx:opacity-100 text-white/40 hover:text-white/80"
      aria-label="Remove effect" @click.stop="emit('remove', layerId, effect.id)">
      <Trash2 class="size-3.5" />
    </button>
  </div>
</template>
```

- [ ] **Step 2: Add the state and handlers in `CompositorModal.vue`**

Add the import beside the other compositor imports at the top of the `<script setup>`:

```ts
import CompositorEffectRow from '~/components/vue-canvas/compositor/CompositorEffectRow.vue'
import {
  EFFECT_ORDER, EFFECT_LABELS, isPinnedKind, effectStackOf, writeStackToLayer,
  addEffect, removeEffect, duplicateEffect, reorderEffect, canReorder,
  type EffectInstance, type EffectKind,
} from '~/lib/compositor/effectStack'
```

Immediately after `const expandedGroups = ref<Set<string>>(new Set())` (line 1775), add:

```ts
// Which layers show their effect rows. Local UI state on purpose — persisting it would dirty
// the document on a disclosure click, exactly as expandedGroups already avoids.
const expandedLayers = ref<Set<string>>(new Set())
const layerStack = (layer: any): EffectInstance[] => effectStackOf(layer)
const setLayerStack = (layerId: string, stack: EffectInstance[]) =>
  setLocal(layerId, writeStackToLayer(stack) as any)
const layerById = (layerId: string): any => localLayers.value.find((l: any) => l.id === layerId)

function addLayerEffect(layerId: string, kind: EffectKind) {
  const l = layerById(layerId); if (!l) return
  const next = addEffect(layerStack(l), kind)
  setLayerStack(layerId, next)
  expandedLayers.value = new Set(expandedLayers.value).add(layerId)
  // Select what was just added so its dials are on screen straight away.
  const fresh = next.find(e => !layerStack(l).some(o => o.id === e.id)) ?? next[next.length - 1]
  if (fresh) selectEffect(layerId, fresh.id)
}
function removeLayerEffect(layerId: string, effectId: string) {
  const l = layerById(layerId); if (!l) return
  setLayerStack(layerId, removeEffect(layerStack(l), effectId))
  if (selectedEffect.value?.effectId === effectId) selectedEffect.value = null
}
function duplicateLayerEffect(layerId: string, effectId: string) {
  const l = layerById(layerId); if (!l) return
  setLayerStack(layerId, duplicateEffect(layerStack(l), effectId))
}
function toggleLayerEffect(layerId: string, effectId: string) {
  const l = layerById(layerId); if (!l) return
  setLayerStack(layerId, layerStack(l).map(e => (e.id === effectId ? { ...e, visible: !e.visible } : e)))
}
function reorderLayerEffect(layerId: string, fromId: string, toId: string) {
  const l = layerById(layerId); if (!l) return
  const stack = layerStack(l)
  if (!canReorder(stack, fromId, toId)) return
  setLayerStack(layerId, reorderEffect(stack, fromId, toId))
}

// ── the add-effect menu, anchored to the clicked layer row ─────────────────────────────
const fxMenuLayerId = ref<string | null>(null)
const fxMenuPos = ref({ top: 0, left: 0 })
function onFxMenuOutside(ev: PointerEvent) {
  if ((ev.target as HTMLElement | null)?.closest('[data-fx-menu]')) return
  closeFxMenu()
}
function openFxMenu(layerId: string, ev: MouseEvent) {
  const r = (ev.currentTarget as HTMLElement).getBoundingClientRect()
  fxMenuPos.value = { top: r.bottom + 4, left: r.left }
  fxMenuLayerId.value = layerId
  document.addEventListener('pointerdown', onFxMenuOutside, true)
}
function closeFxMenu() {
  fxMenuLayerId.value = null
  document.removeEventListener('pointerdown', onFxMenuOutside, true)
}
function pickFxKind(kind: EffectKind) {
  if (fxMenuLayerId.value) addLayerEffect(fxMenuLayerId.value, kind)
  closeFxMenu()
}
/** A pinned kind already on the layer cannot be added twice; orderable kinds always can. */
function fxKindDisabled(kind: EffectKind): boolean {
  const l = fxMenuLayerId.value ? layerById(fxMenuLayerId.value) : null
  return !!l && isPinnedKind(kind) && layerStack(l).some(e => e.type === kind)
}
onBeforeUnmount(closeFxMenu)

// Drag state for effect reordering, scoped to one layer.
const fxDragFrom = ref<{ layerId: string; effectId: string } | null>(null)
const onEffectDragStart = (layerId: string, effectId: string) => { fxDragFrom.value = { layerId, effectId } }
function onEffectDrop(layerId: string, effectId: string) {
  const from = fxDragFrom.value
  fxDragFrom.value = null
  if (from && from.layerId === layerId) reorderLayerEffect(layerId, from.effectId, effectId)
}
```

(`selectEffect` and `selectedEffect` are introduced in Task 6. Add them there; this task's handlers
reference them, so implement Task 5 and Task 6 in order and expect a transient unresolved reference
between the two commits — or add the two lines
`const selectedEffect = ref<{ layerId: string; effectId: string } | null>(null)` and
`const selectEffect = (layerId: string, effectId: string) => { selectedEffect.value = { layerId, effectId } }`
in this task and let Task 6 extend them. **Do the latter** — the tree must be usable at the end of
this task.)

- [ ] **Step 3: Add the `'effect'` row variant**

Replace `FlatRow` (lines 1798-1801) with:

```ts
type FlatRow =
  | { rk: string; kind: 'group'; groupId: string; depth: number; count: number }
  | { rk: string; kind: 'child' | 'local'; key: StackKey; layerId: string; groupId?: string; depth: number; layer: any }
  | { rk: string; kind: 'wired'; key: StackKey; slot: number; depth: number; layer: any }
  | { rk: string; kind: 'effect'; layerId: string; effectId: string; depth: number; effect: EffectInstance; pinned: boolean }
```

- [ ] **Step 4: Emit effect rows from `flatRows`**

Inside the `flatRows` computed (1802-1841), add this helper directly after `const rows: FlatRow[] = []`:

```ts
  const pushEffectRows = (layer: any, depth: number) => {
    if (!layer?.id || !expandedLayers.value.has(layer.id)) return
    for (const e of effectStackOf(layer)) {
      rows.push({
        rk: `fx:${layer.id}:${e.id}`, kind: 'effect', layerId: layer.id, effectId: e.id,
        depth, effect: e, pinned: isPinnedKind(e.type),
      })
    }
  }
```

Then add one call after each of the three places a layer row is pushed:

- after the `kind: 'child'` push inside `emitGroup`:
  `pushEffectRows(k.item.layer, depth + 2)`
- after the top-level `kind: 'local'` push:
  `pushEffectRows(t.item.layer, 1)`
- after the top-level `kind: 'wired'` push:
  `pushEffectRows(t.item.layer, 1)`

- [ ] **Step 5: Render the effect rows**

In the template at line 5281-5284, change the shared row `<div>` to be skipped for effect rows and
render the component instead. Replace:

```vue
          <template v-for="(row, idx) in flatRows" :key="row.rk">
            <div v-if="dropIndex === idx" class="h-0.5 bg-white/70 rounded mx-1.5 my-0.5" />
            <div
              class="group/row flex items-center gap-1.5 pr-2 py-1.5 rounded transition-colors"
```

with:

```vue
          <template v-for="(row, idx) in flatRows" :key="row.rk">
            <div v-if="dropIndex === idx" class="h-0.5 bg-white/70 rounded mx-1.5 my-0.5" />
            <CompositorEffectRow
              v-if="row.kind === 'effect'"
              :effect="row.effect"
              :layer-id="row.layerId"
              :depth="row.depth"
              :pinned="row.pinned"
              :selected="selectedEffect?.layerId === row.layerId && selectedEffect?.effectId === row.effectId"
              @select="selectEffect"
              @remove="removeLayerEffect"
              @duplicate="duplicateLayerEffect"
              @toggle-visible="toggleLayerEffect"
              @drag-start="onEffectDragStart"
              @drop-on="onEffectDrop"
            />
            <div
              v-else
              class="group/row flex items-center gap-1.5 pr-2 py-1.5 rounded transition-colors"
```

- [ ] **Step 6: Add the plus button and the disclosure chevron to layer rows**

Find the per-layer delete button inside the shared row `<div>` (search the 5281-5448 block for the
delete handler used by a `'local'`/`'child'` row) and insert immediately **before** it:

```vue
              <button
                v-if="row.kind === 'local' || row.kind === 'child' || row.kind === 'wired'"
                type="button" data-testid="add-effect" aria-label="Add effect"
                class="shrink-0 opacity-0 group-hover/row:opacity-100 text-white/40 hover:text-white/80"
                :class="fxMenuLayerId === row.layer.id ? '!opacity-100' : ''"
                @click.stop="fxMenuLayerId === row.layer.id ? closeFxMenu() : openFxMenu(row.layer.id, $event)"
              ><Plus class="size-3.5" /></button>
```

Find the group disclosure chevron (the `toggleGroup` control) and add a sibling for layers,
immediately after it:

```vue
              <button
                v-if="(row.kind === 'local' || row.kind === 'child' || row.kind === 'wired') && effectStackOf(row.layer).length"
                type="button" data-testid="layer-fx-toggle"
                class="-ml-1 shrink-0 text-white/40 hover:text-white/80"
                @click.stop="expandedLayers = new Set(expandedLayers).has(row.layer.id)
                  ? new Set([...expandedLayers].filter(x => x !== row.layer.id))
                  : new Set(expandedLayers).add(row.layer.id)"
              ><component :is="expandedLayers.has(row.layer.id) ? ChevronDown : ChevronRight" class="size-3" /></button>
```

Make sure `Plus`, `ChevronDown` and `ChevronRight` are in this file's `lucide-vue-next` import list;
add whichever are missing.

- [ ] **Step 7: Render the add menu**

Add at the end of the template, just before the component's closing root element, a Teleported menu —
teleported because the layer panel scrolls and would clip an absolutely positioned popover:

```vue
    <Teleport to="body">
      <div v-if="fxMenuLayerId" data-fx-menu
        class="fixed z-[200] w-48 rounded-lg border border-white/10 bg-[#161616] p-1 shadow-2xl"
        :style="{ top: `${fxMenuPos.top}px`, left: `${fxMenuPos.left}px` }" @pointerdown.stop>
        <button v-for="kind in EFFECT_ORDER" :key="kind" type="button"
          data-testid="add-effect-item" :data-kind="kind" :disabled="fxKindDisabled(kind)"
          class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-white/80 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:pointer-events-none cursor-pointer"
          @click.stop="pickFxKind(kind)">{{ EFFECT_LABELS[kind] }}</button>
      </div>
    </Teleport>
```

- [ ] **Step 8: Typecheck**

Run: `cd frontend && node_modules/.bin/nuxt typecheck 2>&1 | grep -E "CompositorModal\.vue|CompositorEffectRow\.vue"`
Expected: no lines mentioning `effectStackOf`, `EffectInstance`, `fxMenu`, `expandedLayers` or
`selectedEffect`. Pre-existing errors in `CompositorModal.vue` are not yours — compare against
`git stash`-free baseline by grepping for your own identifiers only.

- [ ] **Step 9: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/components/vue-canvas/compositor/CompositorEffectRow.vue frontend/app/components/vue-canvas/CompositorModal.vue
git commit -m "feat(frame): effect rows and an add menu in the layer tree

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: The right panel tunes one effect at a time

**Files:**
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue:6683, 7550, 7595, 7637, 7652, 7712-7715, 7778-7787`

**Interfaces:**
- Consumes: `selectedEffect`, `selectEffect`, `layerById`, `layerStack`, `setLayerStack`,
  `EFFECT_LABELS` (Task 5).
- Produces: `activeEffect` computed, `updateActiveEffect(patch)`, `isPanelKind(kind)`.

- [ ] **Step 1: Add the selected-effect plumbing**

Extend what Task 5 added (near `expandedLayers`):

```ts
/** The effect being tuned, if any. A separate concept from the layer selection: picking an
 *  effect row clears nothing about which layer is selected (the breadcrumb needs it), but the
 *  inspector shows only the effect. Picking a layer row clears the effect. */
const activeEffect = computed<EffectInstance | null>(() => {
  const sel = selectedEffect.value
  if (!sel) return null
  const l = layerById(sel.layerId)
  return l ? (layerStack(l).find(e => e.id === sel.effectId) ?? null) : null
})
const activeEffectLayer = computed(() => (selectedEffect.value ? layerById(selectedEffect.value.layerId) : null))

/** Write a patch onto the selected instance, by id, keeping the stack's order. */
function updateActiveEffect(patch: Record<string, unknown>) {
  const sel = selectedEffect.value
  const l = sel ? layerById(sel.layerId) : null
  if (!sel || !l) return
  setLayerStack(sel.layerId, layerStack(l).map(e => (e.id === sel.effectId ? { ...e, ...patch } : e)))
}
/** The seven kinds `PostEffectsControls` already renders. */
const isPanelKind = (k: EffectKind) =>
  ['adjust', 'duotone', 'gradientMap', 'bloom', 'vignette', 'grain', 'dof'].includes(k)
```

Then make a layer selection clear the effect selection. Find `onRowClick` (line 1852) and add as its
first statement:

```ts
  if (row.kind !== 'effect') selectedEffect.value = null
```

- [ ] **Step 2: Gate the layer inspector on there being no selected effect**

At line 6683, change:

```vue
<template v-else-if="selectedLocal">
```

to:

```vue
<template v-else-if="selectedLocal && !activeEffect">
```

and add, immediately before it, the effect inspector:

```vue
        <!-- One effect, tuned on its own. Reached by selecting an effect row in the layer
             tree; the fourteen always-on effect cards are gone from the layer view above. -->
        <template v-else-if="activeEffect">
          <div class="mb-2 flex items-center gap-1.5 px-1 text-[11px] text-white/50" data-testid="effect-breadcrumb">
            <button type="button" class="truncate hover:text-white/80"
              @click="selectedEffect = null">{{ activeEffectLayer?.name || 'Layer' }}</button>
            <ChevronRight class="size-3 shrink-0 opacity-60" />
            <span class="truncate text-white/80">{{ EFFECT_LABELS[activeEffect.type] }}</span>
          </div>
          <PostEffectsControls
            v-if="isPanelKind(activeEffect.type)"
            :effects="[activeEffect] as any"
            :only="[activeEffect.type] as any"
            :depth-source="activeEffectLayer ? localDepthSource(activeEffectLayer) : undefined"
            @update="(fx: any[]) => { const n = fx[0]; if (n) updateActiveEffect(n) }" />
        </template>
```

- [ ] **Step 3: Move the six local-kind cards into the effect view**

Six cards currently render inside the layer view and look their effect up by type. Each moves into
the `activeEffect` branch added in Step 2 and binds to the selected **instance** instead, so a second
inner shadow or layer blur edits the right one. The anchors, and the transformation for each:

| card | line | new guard |
|---|---|---|
| Drop shadow | 7550 | `v-if="activeEffect.type === 'drop_shadow'"` |
| Inner shadow | 7595 | `v-if="activeEffect.type === 'inner_shadow'"` |
| Layer blur | 7637 | `v-if="activeEffect.type === 'layer_blur'"` |
| Background blur | 7652 | `v-if="activeEffect.type === 'background_blur'"` |
| Torn edge (`CompositorTornEdgePanel`) | 7778-7782 | `v-if="activeEffect.type === 'torn_edge'"` |
| Feather (`CompositorFeatherPanel`) | 7783-7787 | `v-if="activeEffect.type === 'feather'"` |

For each: cut the card's markup out of the layer view, paste it inside the `activeEffect` branch,
replace its `v-if`/`v-show` with the guard above, and change every read and write:

- a read of the form `(selectedLocal as any).effects?.find(e => e.type === 'x')?.field` becomes
  `(activeEffect as any).field`;
- a write of the form `setLocalEffect(selectedLocal!.id, 'x', { field: v })` (or whatever this file's
  per-card writer is called) becomes `updateActiveEffect({ field: v })`;
- the card's own Add/Remove button is deleted — adding is the tree's plus menu, removing is the row's
  trash icon.

The two panel components take a `value` and emit `update`, so they become:

```vue
          <CompositorTornEdgePanel
            v-if="activeEffect.type === 'torn_edge'"
            :value="(activeEffect as any)"
            @update="(patch: any) => updateActiveEffect(patch)" />
          <CompositorFeatherPanel
            v-if="activeEffect.type === 'feather'"
            :value="(activeEffect as any)"
            @update="(patch: any) => updateActiveEffect(patch)" />
```

Their `@toggle` handlers are dropped — the row's eye toggle owns visibility now. If either panel
requires `value` to be non-null to render, the guard above already guarantees it.

- [ ] **Step 4: Remove the old per-layer `PostEffectsControls` block**

Delete lines 7712-7715 (the per-layer usage quoted below) — its job is now done by the
`isPanelKind` block from Step 2. Leave the document-level usage at ~7844 untouched:

```vue
          <PostEffectsControls class="mt-3"
            :effects="(((selectedLocal as any).effects || []).filter(isPanelEffect) as any)"
            :depth-source="localDepthSource(selectedLocal)"
            @update="(fx: any[]) => setLocal(selectedLocal!.id, { effects: [...((selectedLocal as any).effects || []).filter((e: any) => !isPanelEffect(e)), ...fx] } as any)" />
```

If `isPanelEffect` (declared at line 106) has no other caller after this deletion, remove it too.

- [ ] **Step 5: Typecheck and compile-check**

Run: `cd frontend && node_modules/.bin/nuxt typecheck 2>&1 | grep -E "CompositorModal\.vue" | grep -iE "activeEffect|updateActiveEffect|isPanelKind|selectedEffect"`
Expected: no output.

Run: `cd frontend && node_modules/.bin/vitest run tests/unit/compositor-toolbar-menus.unit.spec.ts tests/unit/compositor-setup-tdz.unit.spec.ts`
Expected: PASS — these two cover the modal's own setup and menu wiring, so they catch a broken
`<script setup>`.

- [ ] **Step 6: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/components/vue-canvas/CompositorModal.vue
git commit -m "feat(frame): tune one layer effect at a time, with a breadcrumb

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Playwright proof

The claim that matters is the one a screenshot cannot argue with: **an old-shape layer and the
equivalent explicit new-shape layer render the same pixels.** That is read-through's whole promise,
and it is what protects every saved frame. It is testable in a single run, so this task proves it
directly rather than comparing against a golden captured at an earlier commit.

This task also **fixes `tests/compositor-post-effects.spec.ts`**, which Task 6 breaks: its per-layer
half clicks `[data-testid="postfx-add-adjust"]` inside the layer inspector, and that block is gone.

**Files:**
- Create: `frontend/tests/compositor-layer-effects.spec.ts`
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` (two dev test hooks)
- Modify: `frontend/tests/compositor-post-effects.spec.ts` (route its per-layer half through the tree)

**Interfaces:**
- Consumes: the tree and inspector from Tasks 5 and 6; test ids `effect-row`, `add-effect`,
  `add-effect-item`, `effect-breadcrumb`, `layer-fx-toggle`, and the existing
  `compositor-stack-canvas`.
- Produces: `window.__compositorLayers(): LocalLayer[]` and
  `window.__compositorSetLayers(layers: LocalLayer[]): void` — dev test hooks on the open modal,
  mirroring the 3D Studio's `__scene3dDoc` precedent, registered in `onMounted` and deleted in
  `onBeforeUnmount`.

- [ ] **Step 1: Add the test hooks**

In `CompositorModal.vue`, in the same `onMounted` that registers this file's other window listeners,
add:

```ts
  // Test hooks (mirrors Scene3DStudioSurface's __scene3dDoc): read and replace the open
  // document's layers, so a spec can seed a legacy-shaped layer without a save/reload cycle.
  ;(window as any).__compositorLayers = () => JSON.parse(JSON.stringify(localLayers.value))
  ;(window as any).__compositorSetLayers = (next: any[]) => { setLocalLayers(next) }
```

Use whichever setter this file already owns for replacing the whole array — read
`useLocalLayerEditor.ts:145` (`n.data.properties.sailor_localLayers = next`) and use the composable's
exported writer rather than assigning the property directly, so the normal reactivity and history
paths run. Add the matching cleanup to `onBeforeUnmount`:

```ts
  delete (window as any).__compositorLayers
  delete (window as any).__compositorSetLayers
```

- [ ] **Step 2: Write the spec**

Create `frontend/tests/compositor-layer-effects.spec.ts`:

```ts
import { test, expect, type Page } from '@playwright/test'
import { openBlankWorkflow, dropNode, waitForBackend } from './_helpers'

/**
 * Per-layer effects as an ordered stack — end to end.
 *
 * The load-bearing test is `read-through parity`: a layer stored in the LEGACY shape (no ids,
 * torn edge and feather as their own fields) and the same layer stored explicitly in the new
 * shape must render identical pixels. That is what protects every saved frame, and it cannot
 * be argued with by looking at a screenshot.
 */

async function stackPixels(page: Page): Promise<string> {
  await page.waitForTimeout(600) // let the watch → renderStack settle
  return page.evaluate(() => {
    const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
    return cv.toDataURL()
  })
}

async function openCompositor(page: Page): Promise<void> {
  await openBlankWorkflow(page)
  await waitForBackend(page)
  await dropNode(page, 'Compositor')
  const nodeId = await page.locator('.vue-flow__node').first().getAttribute('data-id')
  expect(nodeId).toBeTruthy()
  await page.evaluate((id) =>
    window.dispatchEvent(new CustomEvent('sailor:openCompositor', { detail: { nodeId: id } })), nodeId)
  await page.locator('[data-testid="compositor-stack-canvas"]').waitFor({ state: 'visible', timeout: 10_000 })
  await expect.poll(() => page.evaluate(() => typeof (window as any).__compositorSetLayers === 'function'),
    { timeout: 10_000 }).toBe(true)
}

/** Add a rectangle through the toolbar; it becomes the selected layer. */
async function addRect(page: Page): Promise<void> {
  await page.getByTitle('Add rectangle').click()
}

const layerRow = (page: Page) => page.locator('[data-testid="object-row"], [data-testid="layer-row"]').first()

test.describe('Frame per-layer effect stack', () => {
  test('read-through parity: a legacy-shaped layer renders exactly like the explicit stack', async ({ page }) => {
    await openCompositor(page)
    await addRect(page)

    // Explicit new shape: ids, canonical order, torn edge and feather as entries.
    await page.evaluate(() => {
      const ls = (window as any).__compositorLayers()
      ls[0].effects = [
        { id: 'e1', type: 'adjust', brightness: 1.4, contrast: 1, saturation: 1, hue: 0, visible: true },
        { id: 'e2', type: 'grain', amount: 0.5, size: 3, visible: true },
        { id: 'e3', type: 'torn_edge', style: 'ragged', amount: 14, roughness: 0.5, grain: 2, grainTexture: 0.3, lipWidth: 3, lipVariation: 0.4, lipColor: '#f7f3ea', seed: 7, visible: true },
        { id: 'e4', type: 'feather', amount: 0.18, curve: 'smooth', visible: true },
        { id: 'e5', type: 'drop_shadow', color: 'rgba(0,0,0,0.4)', x: 0.01, y: 0.01, blur: 0.02, visible: true },
      ]
      delete ls[0].tornEdge; delete ls[0].feather
      ;(window as any).__compositorSetLayers(ls)
    })
    const explicit = await stackPixels(page)

    // The same layer in the LEGACY shape: no ids, effects in an arbitrary order, torn edge and
    // feather back on their own fields.
    await page.evaluate(() => {
      const ls = (window as any).__compositorLayers()
      ls[0].effects = [
        { type: 'drop_shadow', color: 'rgba(0,0,0,0.4)', x: 0.01, y: 0.01, blur: 0.02, visible: true },
        { type: 'grain', amount: 0.5, size: 3, visible: true },
        { type: 'adjust', brightness: 1.4, contrast: 1, saturation: 1, hue: 0, visible: true },
      ]
      ls[0].tornEdge = { style: 'ragged', amount: 14, roughness: 0.5, grain: 2, grainTexture: 0.3, lipWidth: 3, lipVariation: 0.4, lipColor: '#f7f3ea', seed: 7 }
      ls[0].feather = { amount: 0.18, curve: 'smooth' }
      ;(window as any).__compositorSetLayers(ls)
    })
    const legacy = await stackPixels(page)

    expect(legacy).toBe(explicit)
  })

  test('order matters: swapping two effects changes the pixels', async ({ page }) => {
    await openCompositor(page)
    await addRect(page)
    const set = (order: string[]) => page.evaluate((ord) => {
      const ls = (window as any).__compositorLayers()
      const byType: Record<string, any> = {
        gradientMap: { id: 'g', type: 'gradientMap', stops: [{ pos: 0, color: '#001133' }, { pos: 1, color: '#ffcc00' }], contrast: 0, mix: 1, visible: true },
        adjust: { id: 'a', type: 'adjust', brightness: 1, contrast: 1.9, saturation: 1, hue: 0, visible: true },
      }
      ls[0].effects = ord.map(t => byType[t])
      ;(window as any).__compositorSetLayers(ls)
    }, order)

    await set(['gradientMap', 'adjust'])
    const mapThenAdjust = await stackPixels(page)
    await set(['adjust', 'gradientMap'])
    const adjustThenMap = await stackPixels(page)
    expect(adjustThenMap).not.toBe(mapThenAdjust)
  })

  test('two instances of one kind both apply', async ({ page }) => {
    await openCompositor(page)
    await addRect(page)
    const withN = (n: number) => page.evaluate((count) => {
      const ls = (window as any).__compositorLayers()
      ls[0].effects = Array.from({ length: count }, (_, i) => ({
        id: `b${i}`, type: 'bloom', threshold: 0.2, radius: 0.02, intensity: 1, visible: true,
      }))
      ;(window as any).__compositorSetLayers(ls)
    }, n)
    await withN(1)
    const one = await stackPixels(page)
    await withN(2)
    expect(await stackPixels(page)).not.toBe(one)
  })

  test('tree flow: add from the plus menu, tune, reorder by drag, remove', async ({ page }) => {
    await openCompositor(page)
    await addRect(page)

    const row = page.locator('[data-testid="add-effect"]').first()
    await row.hover()
    await row.click()
    await page.locator('[data-testid="add-effect-item"][data-kind="bloom"]').click()

    const bloomRow = page.locator('[data-testid="effect-row"][data-effect-kind="bloom"]')
    await expect(bloomRow).toBeVisible()
    await expect(bloomRow).toHaveText(/Bloom/)
    await expect(page.getByTestId('effect-breadcrumb')).toBeVisible()

    // A second kind, then reorder them by dragging the first onto the second.
    await row.click()
    await page.locator('[data-testid="add-effect-item"][data-kind="grain"]').click()
    const kinds = () => page.evaluate(() =>
      ((window as any).__compositorLayers()[0].effects || []).map((e: any) => e.type))
    expect(await kinds()).toEqual(['bloom', 'grain'])
    await bloomRow.dragTo(page.locator('[data-testid="effect-row"][data-effect-kind="grain"]'))
    expect(await kinds()).toEqual(['grain', 'bloom'])

    // Eye toggle writes visible:false; trash removes the instance.
    await bloomRow.hover()
    await bloomRow.getByRole('button', { name: 'Hide effect' }).click()
    expect(await page.evaluate(() =>
      ((window as any).__compositorLayers()[0].effects || []).find((e: any) => e.type === 'bloom').visible)).toBe(false)
    await bloomRow.hover()
    await bloomRow.getByRole('button', { name: 'Remove effect' }).click()
    await expect(bloomRow).toHaveCount(0)
    expect(await kinds()).toEqual(['grain'])
  })

  test('a pinned effect cannot be dragged out of position', async ({ page }) => {
    await openCompositor(page)
    await addRect(page)
    await page.evaluate(() => {
      const ls = (window as any).__compositorLayers()
      ls[0].effects = [
        { id: 'bg', type: 'background_blur', radius: 0.02, visible: true },
        { id: 'a', type: 'adjust', brightness: 1.2, contrast: 1, saturation: 1, hue: 0, visible: true },
      ]
      ;(window as any).__compositorSetLayers(ls)
    })
    const bg = page.locator('[data-testid="effect-row"][data-effect-kind="background_blur"]')
    const adj = page.locator('[data-testid="effect-row"][data-effect-kind="adjust"]')
    await expect(bg).toBeVisible()
    await adj.dragTo(bg)
    expect(await page.evaluate(() =>
      ((window as any).__compositorLayers()[0].effects || []).map((e: any) => e.type)))
      .toEqual(['background_blur', 'adjust'])
  })
})
```

**Note on `layerRow`:** the helper above lists two candidate test ids because the Compositor's layer
row is inline markup and may carry neither. Before writing the tree-flow test, read the row markup at
`CompositorModal.vue:5281-5448` and use whatever selector actually identifies a layer row; if none
exists, add `data-testid="layer-row"` to the shared row `<div>` in the same commit and delete the
unused half of the helper.

- [ ] **Step 3: Fix `compositor-post-effects.spec.ts`**

Its per-layer half (the `postfx-add-adjust` / `postfx-adjust-brightness` clicks near the top) targets
markup Task 6 deleted. Route it through the tree instead: hover the layer row, click
`[data-testid="add-effect"]`, pick `[data-testid="add-effect-item"][data-kind="adjust"]`, then fill
`[data-testid="postfx-adjust-brightness"]` (which now renders inside the effect inspector). Remove by
clicking the effect row's "Remove effect" button rather than the old Add/Remove toggle. **The
whole-frame (document-level) half of that spec must not change** — the document post stack is
untouched by this work, and its passing unchanged is the proof.

- [ ] **Step 4: Run both specs**

```bash
cd /Users/julien/Documents/GitHub/Sailor/frontend
lsof -nP -iTCP:3103 -sTCP:LISTEN -t   # pick 3104+ if taken
node_modules/.bin/nuxt dev --port 3103 --host 127.0.0.1 > /tmp/fx-dev.log 2>&1 &
# wait for BOTH:
#   grep -m1 "Local:" /tmp/fx-dev.log      → confirm it really is 3103 (Nuxt silently picks another port)
#   curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3103/   → 200
PW_BASE_URL=http://127.0.0.1:3103 node_modules/.bin/playwright test tests/compositor-layer-effects.spec.ts tests/compositor-post-effects.spec.ts --project=chromium
```

Expected: all pass. Do **not** open the app in a browser pane while Playwright runs — the
BroadcastChannel leader election makes the Playwright window a follower and its UI unclickable. Kill
the server afterwards and confirm the port is free.

If `read-through parity` fails, that is a real defect in Task 3 or Task 1, not a test to loosen:
dump both layer shapes and the two data URLs, find which pass differs, and report it.

- [ ] **Step 5: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/tests/compositor-layer-effects.spec.ts frontend/tests/compositor-post-effects.spec.ts frontend/app/components/vue-canvas/CompositorModal.vue
git commit -m "test(frame): layer effect stack renders, orders, stacks and reads through

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Finish — full suite, typecheck delta, motion-path check

- [ ] **Step 1: Confirm the motion path honours list order**

`lib/motion/paint.ts`'s `composeEffectiveLayer` (line 49) spreads `...layer`, so `effects`,
`tornEdge` and `feather` reach `drawLocalLayer` — and therefore `paintLayer` — unchanged. That means
an animated layer picks up the ordered stack for free. **Verify, do not assume:**

```bash
cd /Users/julien/Documents/GitHub/Sailor/frontend
grep -n "effects\|tornEdge\|feather" app/lib/motion/paint.ts app/lib/motion/animatedText.ts
```

`drawAnimatedTextLayer` (`app/lib/motion/animatedText.ts`) is the one branch that does NOT go through
`drawLocalLayer` — per-character animated text draws itself. If it applies effects at all, it must
read them through `effectStackOf` like everything else.

The spec asks for a browser test on this seam. Which proof is owed depends on what you find:

- **The path is pure pass-through** (nothing in either file reads `effects`/`tornEdge`/`feather`):
  say so with the grep output, and no browser test is owed — an animated layer reaches `paintLayer`
  through `drawLocalLayer` with the same layer object a static one does, and Task 7 already proves
  `paintLayer` honours order.
- **Either file reads effects directly**: that is a real second implementation of the pipeline. Fix
  it to read through `effectStackOf`, and add a Playwright case to
  `tests/compositor-layer-effects.spec.ts` that animates a layer carrying two order-sensitive
  effects and asserts the rendered pixels match the static layer with the same stack.

- [ ] **Step 2: Full unit suite**

Run: `cd frontend && node_modules/.bin/vitest run tests/unit 2>&1 | tail -8`
Expected: no failing file that this work touched. The repo carries pre-existing failures from other
sessions — list any failing file names so the controller can judge, and re-run a suspicious file on
its own before concluding (counts are unreliable under load).

- [ ] **Step 3: Typecheck delta**

```bash
cd frontend && node_modules/.bin/nuxt typecheck 2>&1 | grep -E "effectStack|postEffects\.ts|useCompositorLayers\.ts|CompositorModal\.vue|CompositorEffectRow\.vue|agent/surfaces/compositor\.ts|silhouetteCache\.ts"
```
Expected: no line that mentions an identifier this plan introduced.

- [ ] **Step 4: Report**

Summarise per task: what landed, which tests prove it, and the two known limitations to carry
forward — the document-level post stack is still fixed-order and one-instance-per-type (deliberate,
so existing documents are untouched), and dragging an effect between layers is not supported. Update
the ⛵ build dashboard artifact in place per the standing rule: **read the live one first** (it was
republished by another session), then replace, never append.
