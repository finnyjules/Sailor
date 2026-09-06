# 3D Studio Per-Object Treatments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a 3D Studio user attach effects to ONE model — blur, glow, pixelate, fade (masked family) and rim light, outline, x-ray, wireframe (edge family) — managed as child rows under the model in the left-hand object tree, tuned in the inspector only when a treatment row is selected, and rendered identically in the viewport and the export.

**Architecture:** A treatment is an entry in an optional `treatments` list ON the scene object (never in the flat `doc.objects` array). A pure module owns the types, defaults, parser and the per-frame plan. The edge family becomes shell meshes and a material override attached to the object's own meshes. The masked family goes through a new `TreatmentStage`: the base scene renders with treated objects hidden, each treated object renders alone to an offscreen buffer, 2D passes treat that buffer, and a depth-tested composite lays it back over the base; the result feeds the existing `PostChain` through a new texture input so global post and exports stay on the same path. The tree and inspector wiring lives in the surface; motion and agent vocabularies gain id-addressed paths through one nested-id extension to the shared path resolvers.

**Tech Stack:** Nuxt 4, Vue 3.5, TypeScript, Three.js 0.171 (EffectComposer, FullScreenQuad, TexturePass, DepthTexture), Vitest, Playwright, lucide-vue-next.

**Design source:** `docs/superpowers/specs/2026-09-05-scene3d-object-treatments-design.md`.

## Global Constraints

- Treatments live on the object as `SceneObjectBase.treatments?: Treatment[]`. They are NEVER entries of `doc.objects` and NEVER carry a `parentId`. No module that iterates `doc.objects` learns a new kind.
- Every treatment has a stable string id (`trt_<uuid>_<n>`), never addressed by index. Motion/agent paths are `objects.<objectId>.treatments.<treatmentId>.<dial>`.
- A document without treatments must round-trip byte-identical through `parseDoc(serializeDoc(doc))` — absent or empty lists collapse to `undefined`, never `[]`.
- The masked family renders at most `TREATED_OBJECT_CAP = 8` groups per frame and at most ONE inverted ("Everything else") group. Skipped groups are surfaced in the tree as "Not rendered", never silently dropped.
- Depth and normal export passes skip the masked stage entirely; rim light, outline and wireframe shells are hidden there and a surface hidden by a wireframe is shown there.
- UI copy is sentence case, human names only, never stored identifiers: "Rim light", "X-ray", "Everything else", "Not rendered", "Cell size". Colour spelt "Colour" in labels.
- `StudioColor` emits 8-digit `#rrggbbaa`; every consumer of a treatment colour calls `stripAlpha` from `~/lib/color/convert` before handing it to three (`THREE.Color` renders 8-digit hex WHITE).
- Pure modules (`treatments.ts`, `treatmentControls.ts`) import no `three`, no Vue. `config.ts` may import `treatments.ts` (type-only in the other direction).
- Frontend work is under `frontend/`. Unit tests: `cd frontend && node_modules/.bin/vitest run <spec>`. Typecheck is `node_modules/.bin/nuxt typecheck` (there is no `vue-tsc` binary); the repo has hundreds of pre-existing errors, so only compare errors in touched files. Dev server on `127.0.0.1`, never `localhost`. Run Playwright from a worktree per the recipe in the E2E task; never leave the app open in the Browser pane while Playwright runs.
- Commit per task. Stage only your own files (`git add <paths>`), never `git add -A` and never stash — other sessions share this checkout. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: Treatment data model, parser, per-frame plan, document wiring

**Files:**
- Create: `frontend/app/lib/scene3d/treatments.ts`
- Modify: `frontend/app/lib/scene3d/config.ts` (imports at top ~line 4; `SceneObjectBase` at ~line 220; object parser `common` block at ~line 1200)
- Modify: `frontend/app/components/vue-canvas/Scene3DStudioSurface.vue` (`cloneObject`, ~line 3117)
- Test: `frontend/tests/unit/scene3d-treatments.unit.spec.ts`

**Interfaces:**
- Consumes: `SceneDoc`, `SceneObject` types from `~/lib/scene3d/config`.
- Produces (all exported from `~/lib/scene3d/treatments`):
  - `MASKED_TREATMENT_KINDS`, `EDGE_TREATMENT_KINDS`, `TREATMENT_KINDS` (readonly tuples), types `TreatmentKind`, `MaskedTreatmentKind`, `EdgeTreatmentKind`
  - `TREATMENT_LABELS: Record<TreatmentKind, string>`
  - `type Treatment` = discriminated union `BlurTreatment | GlowTreatment | PixelateTreatment | FadeTreatment | RimLightTreatment | OutlineTreatment | XrayTreatment | WireframeTreatment`, each `{ id: string; kind; enabled: boolean; invert: boolean; …dials }`
  - `TREATMENT_DEFAULTS` (dials per kind), `TREATED_OBJECT_CAP = 8`
  - `isMaskedKind(kind)`, `isTreatmentKind(v)`, `isTreatmentHost(obj)`
  - `newTreatmentId(): string`, `createTreatment(kind): Treatment`
  - `parseTreatment(raw): Treatment | undefined`, `parseTreatments(raw): Treatment[] | undefined`, `cloneTreatments(list): Treatment[] | undefined`
  - `treatmentsOf(obj): Treatment[]`, `findTreatment(doc, objectId, treatmentId): { obj, treatment, index } | null`, `edgeTreatmentsOf(obj): Treatment[]`
  - `interface MaskedGroup { objectId: string; invert: boolean; treatments: Treatment[]; rendered: boolean; skipped?: 'cap' | 'invert' }`
  - `maskedTreatmentPlan(doc): MaskedGroup[]`, `unrenderedTreatmentIds(plan): Set<string>`

- [ ] **Step 1: Write the failing tests**

Create `frontend/tests/unit/scene3d-treatments.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { defaultDoc, createPrimitive, createLight, serializeDoc, parseDoc } from '~/lib/scene3d/config'
import {
  TREATMENT_KINDS, TREATMENT_LABELS, TREATED_OBJECT_CAP, createTreatment, parseTreatment, parseTreatments,
  cloneTreatments, maskedTreatmentPlan, unrenderedTreatmentIds, findTreatment, edgeTreatmentsOf, isMaskedKind,
} from '~/lib/scene3d/treatments'

describe('treatments: model', () => {
  it('createTreatment fills every dial from TREATMENT_DEFAULTS with a fresh trt_ id, enabled and not inverted', () => {
    const t = createTreatment('glow')
    expect(t.id).toMatch(/^trt_/)
    expect(t).toMatchObject({ kind: 'glow', enabled: true, invert: false, strength: 1, threshold: 0.6, tint: '#ffffff' })
    expect(createTreatment('blur').id).not.toBe(createTreatment('blur').id)
  })
  it('every kind has a sentence-case human label', () => {
    for (const k of TREATMENT_KINDS) expect(TREATMENT_LABELS[k]).toMatch(/^[A-Z][a-z]/)
  })
})

describe('treatments: parse', () => {
  it('a document without the field round-trips byte-identical', () => {
    const doc = defaultDoc()
    doc.objects.push(createPrimitive('box', doc.objects))
    const json = serializeDoc(doc)
    expect(serializeDoc(parseDoc(json))).toBe(json)
    expect(parseDoc(json).objects[0]!.treatments).toBeUndefined()
  })
  it('round-trips a treatment list in stack order', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects)
    box.treatments = [createTreatment('blur'), createTreatment('rimLight'), createTreatment('fade')]
    doc.objects.push(box)
    const back = parseDoc(serializeDoc(doc))
    expect(back.objects[0]!.treatments!.map((t) => t.kind)).toEqual(['blur', 'rimLight', 'fade'])
    expect(back).toEqual(doc)
  })
  it('drops an invalid entry but keeps the object and the valid entries', () => {
    const list = parseTreatments([
      { id: 'a', kind: 'blur', amount: 0.3 },
      { id: 'b', kind: 'nope' },
      { kind: 'fade' },
      { id: 'c.d', kind: 'fade' },
      { id: '12', kind: 'fade' },
      'junk',
      { id: 'e', kind: 'pixelate', cellSize: 9.6 },
    ])
    expect(list!.map((t) => t.id)).toEqual(['a', 'e'])
    expect(list![1]).toMatchObject({ kind: 'pixelate', cellSize: 10 })
  })
  it('backfills missing dials, clamps ranges and treats absent flags as enabled / not inverted', () => {
    const t = parseTreatment({ id: 'x', kind: 'blur', amount: 4 })!
    expect(t).toMatchObject({ kind: 'blur', amount: 1, enabled: true, invert: false })
    const w = parseTreatment({ id: 'y', kind: 'wireframe', enabled: false, showSurface: false })!
    expect(w).toMatchObject({ kind: 'wireframe', enabled: false, showSurface: false, color: '#ffffff', lineOpacity: 0.8 })
  })
  it('keeps the first of two entries sharing an id', () => {
    const list = parseTreatments([{ id: 'a', kind: 'blur', amount: 0.1 }, { id: 'a', kind: 'fade' }])!
    expect(list).toHaveLength(1)
    expect(list[0]!.kind).toBe('blur')
  })
  it('an absent or empty list parses to undefined, never []', () => {
    expect(parseTreatments(undefined)).toBeUndefined()
    expect(parseTreatments([])).toBeUndefined()
    expect(parseTreatments(['junk'])).toBeUndefined()
  })
})

describe('treatments: clone / find', () => {
  it('cloneTreatments keeps dials and order but mints fresh ids', () => {
    const src = [createTreatment('blur'), createTreatment('outline')]
    const copy = cloneTreatments(src)!
    expect(copy.map((t) => t.kind)).toEqual(['blur', 'outline'])
    expect(copy[0]!.id).not.toBe(src[0]!.id)
    expect(cloneTreatments(undefined)).toBeUndefined()
    expect(cloneTreatments([])).toBeUndefined()
  })
  it('findTreatment resolves by object id + treatment id and returns the index', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects)
    box.treatments = [createTreatment('blur'), createTreatment('glow')]
    doc.objects.push(box)
    expect(findTreatment(doc, box.id, box.treatments[1]!.id)).toMatchObject({ index: 1, treatment: { kind: 'glow' } })
    expect(findTreatment(doc, box.id, 'nope')).toBeNull()
    expect(findTreatment(doc, 'nope', box.treatments[0]!.id)).toBeNull()
  })
  it('edgeTreatmentsOf returns enabled edge-family entries only, in order', () => {
    const box = createPrimitive('box')
    const off = createTreatment('outline'); off.enabled = false
    box.treatments = [createTreatment('blur'), createTreatment('rimLight'), off, createTreatment('wireframe')]
    expect(edgeTreatmentsOf(box).map((t) => t.kind)).toEqual(['rimLight', 'wireframe'])
    expect(isMaskedKind('fade')).toBe(true)
    expect(isMaskedKind('xray')).toBe(false)
  })
})

describe('treatments: masked plan', () => {
  it('groups one object\'s masked treatments into one group, in stack order, skipping edge kinds and disabled entries', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects)
    const off = createTreatment('pixelate'); off.enabled = false
    box.treatments = [createTreatment('blur'), createTreatment('rimLight'), off, createTreatment('fade')]
    doc.objects.push(box)
    const plan = maskedTreatmentPlan(doc)
    expect(plan).toHaveLength(1)
    expect(plan[0]).toMatchObject({ objectId: box.id, invert: false, rendered: true })
    expect(plan[0]!.treatments.map((t) => t.kind)).toEqual(['blur', 'fade'])
  })
  it('splits normal and inverted treatments of one object into two groups', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects)
    const inv = createTreatment('blur'); inv.invert = true
    box.treatments = [createTreatment('fade'), inv]
    doc.objects.push(box)
    expect(maskedTreatmentPlan(doc).map((g) => g.invert)).toEqual([false, true])
  })
  it('renders only the first inverted group per frame', () => {
    const doc = defaultDoc()
    for (let i = 0; i < 2; i++) {
      const o = createPrimitive('box', doc.objects)
      const inv = createTreatment('blur'); inv.invert = true
      o.treatments = [inv]
      doc.objects.push(o)
    }
    const plan = maskedTreatmentPlan(doc)
    expect(plan[0]!.rendered).toBe(true)
    expect(plan[1]).toMatchObject({ rendered: false, skipped: 'invert' })
  })
  it('caps at TREATED_OBJECT_CAP groups and reports the rest as skipped by cap', () => {
    const doc = defaultDoc()
    for (let i = 0; i < TREATED_OBJECT_CAP + 2; i++) {
      const o = createPrimitive('sphere', doc.objects)
      o.treatments = [createTreatment('blur')]
      doc.objects.push(o)
    }
    const plan = maskedTreatmentPlan(doc)
    expect(plan.filter((g) => g.rendered)).toHaveLength(TREATED_OBJECT_CAP)
    expect(plan.slice(TREATED_OBJECT_CAP).every((g) => g.skipped === 'cap')).toBe(true)
    const ids = unrenderedTreatmentIds(plan)
    expect(ids.size).toBe(2)
    expect(ids.has(plan[TREATED_OBJECT_CAP]!.treatments[0]!.id)).toBe(true)
  })
  it('ignores hidden objects and non-host kinds', () => {
    const doc = defaultDoc()
    const hidden = createPrimitive('box', doc.objects); hidden.visible = false; hidden.treatments = [createTreatment('blur')]
    const light = createLight('point', doc.objects); (light as any).treatments = [createTreatment('blur')]
    doc.objects.push(hidden, light)
    expect(maskedTreatmentPlan(doc)).toEqual([])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && node_modules/.bin/vitest run tests/unit/scene3d-treatments.unit.spec.ts`
Expected: FAIL — `Failed to resolve import "~/lib/scene3d/treatments"`.

- [ ] **Step 3: Create `frontend/app/lib/scene3d/treatments.ts`**

```ts
// Per-object treatments: the data model, defaults, parser and the per-frame plan for
// the masked family. Deliberately three-free and Vue-free so config.ts (whose import
// graph must never drag in three — see its own header) can import it, and so every
// rule here unit-tests headless.
//
// Treatments live ON the object (`SceneObjectBase.treatments`), never as entries in
// the flat `doc.objects` array: eight modules iterate that array and the agent/motion
// path space is built over it, and none of them should have to learn a new kind.
// Design: docs/superpowers/specs/2026-09-05-scene3d-object-treatments-design.md
import type { SceneDoc, SceneObject } from './config'

export const MASKED_TREATMENT_KINDS = ['blur', 'glow', 'pixelate', 'fade'] as const
export const EDGE_TREATMENT_KINDS = ['rimLight', 'outline', 'xray', 'wireframe'] as const
export const TREATMENT_KINDS = [...MASKED_TREATMENT_KINDS, ...EDGE_TREATMENT_KINDS] as const
export type MaskedTreatmentKind = typeof MASKED_TREATMENT_KINDS[number]
export type EdgeTreatmentKind = typeof EDGE_TREATMENT_KINDS[number]
export type TreatmentKind = MaskedTreatmentKind | EdgeTreatmentKind

/** Human names — UI copy for tree rows, inspector card titles and motion target labels.
 *  Sentence case, never the stored `kind`. */
export const TREATMENT_LABELS: Record<TreatmentKind, string> = {
  blur: 'Blur', glow: 'Glow', pixelate: 'Pixelate', fade: 'Fade',
  rimLight: 'Rim light', outline: 'Outline', xray: 'X-ray', wireframe: 'Wireframe',
}

interface TreatmentBase {
  /** Stable id (`trt_<uuid>_<n>`). Motion tracks and agent keys address a treatment by
   *  this, never by position, so reordering the stack re-points nothing. */
  id: string
  /** The eye toggle in the tree. */
  enabled: boolean
  /** "Everything else": apply to the rest of the scene instead of this object. Stored
   *  for every kind for schema simplicity; only the masked family honours it. */
  invert: boolean
}
export interface BlurTreatment extends TreatmentBase { kind: 'blur'; amount: number }
export interface GlowTreatment extends TreatmentBase { kind: 'glow'; strength: number; threshold: number; tint: string }
export interface PixelateTreatment extends TreatmentBase { kind: 'pixelate'; cellSize: number }
export interface FadeTreatment extends TreatmentBase { kind: 'fade'; opacity: number }
export interface RimLightTreatment extends TreatmentBase { kind: 'rimLight'; color: string; width: number; strength: number }
export interface OutlineTreatment extends TreatmentBase { kind: 'outline'; color: string; thickness: number }
export interface XrayTreatment extends TreatmentBase { kind: 'xray'; color: string; opacity: number }
export interface WireframeTreatment extends TreatmentBase { kind: 'wireframe'; color: string; lineOpacity: number; showSurface: boolean }
export type Treatment =
  | BlurTreatment | GlowTreatment | PixelateTreatment | FadeTreatment
  | RimLightTreatment | OutlineTreatment | XrayTreatment | WireframeTreatment

/** Dial defaults per kind — everything except id/kind/enabled/invert. The ONE source the
 *  parser, `createTreatment` and the inspector controls all read. */
export const TREATMENT_DEFAULTS = {
  blur: { amount: 0.5 },
  glow: { strength: 1, threshold: 0.6, tint: '#ffffff' },
  pixelate: { cellSize: 12 },
  fade: { opacity: 0.5 },
  rimLight: { color: '#ffffff', width: 0.5, strength: 1 },
  outline: { color: '#000000', thickness: 0.5 },
  xray: { color: '#6fd3ff', opacity: 0.35 },
  wireframe: { color: '#ffffff', lineOpacity: 0.8, showSurface: true },
} as const

/** How many masked-treatment groups the stage draws per frame. */
export const TREATED_OBJECT_CAP = 8

export function isMaskedKind(kind: TreatmentKind): kind is MaskedTreatmentKind {
  return (MASKED_TREATMENT_KINDS as readonly string[]).includes(kind)
}
export function isTreatmentKind(v: unknown): v is TreatmentKind {
  return typeof v === 'string' && (TREATMENT_KINDS as readonly string[]).includes(v)
}
/** Only primitives and imported models carry treatments — never lights, groups or decals. */
export function isTreatmentHost(obj: SceneObject): boolean {
  return obj.kind === 'primitive' || obj.kind === 'glb'
}

let idCounter = 0
export function newTreatmentId(): string {
  // Same recipe as config.ts's newId(): randomUUID everywhere we run, counter guards a mock.
  return `trt_${(globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2))}_${++idCounter}`
}

export function createTreatment(kind: TreatmentKind): Treatment {
  return { id: newTreatmentId(), kind, enabled: true, invert: false, ...TREATMENT_DEFAULTS[kind] } as Treatment
}

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const str = (v: unknown, d: string): string => (typeof v === 'string' && v ? v : d)
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

/** One stored entry, validated field by field. `undefined` when unusable (no id, an id the
 *  path resolvers would refuse — empty, dotted, all digits — or an unknown kind). Missing
 *  dials backfill from TREATMENT_DEFAULTS, so a partially valid entry is kept, not dropped. */
export function parseTreatment(raw: unknown): Treatment | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || r.id === '' || r.id.includes('.') || /^\d+$/.test(r.id)) return undefined
  if (!isTreatmentKind(r.kind)) return undefined
  const base = { id: r.id, enabled: r.enabled !== false, invert: r.invert === true }
  const D = TREATMENT_DEFAULTS
  switch (r.kind) {
    case 'blur': return { ...base, kind: 'blur', amount: clamp01(num(r.amount, D.blur.amount)) }
    case 'glow': return {
      ...base, kind: 'glow', strength: Math.max(0, num(r.strength, D.glow.strength)),
      threshold: clamp01(num(r.threshold, D.glow.threshold)), tint: str(r.tint, D.glow.tint),
    }
    case 'pixelate': return { ...base, kind: 'pixelate', cellSize: Math.max(1, Math.round(num(r.cellSize, D.pixelate.cellSize))) }
    case 'fade': return { ...base, kind: 'fade', opacity: clamp01(num(r.opacity, D.fade.opacity)) }
    case 'rimLight': return {
      ...base, kind: 'rimLight', color: str(r.color, D.rimLight.color),
      width: clamp01(num(r.width, D.rimLight.width)), strength: Math.max(0, num(r.strength, D.rimLight.strength)),
    }
    case 'outline': return { ...base, kind: 'outline', color: str(r.color, D.outline.color), thickness: clamp01(num(r.thickness, D.outline.thickness)) }
    case 'xray': return { ...base, kind: 'xray', color: str(r.color, D.xray.color), opacity: clamp01(num(r.opacity, D.xray.opacity)) }
    case 'wireframe': return {
      ...base, kind: 'wireframe', color: str(r.color, D.wireframe.color),
      lineOpacity: clamp01(num(r.lineOpacity, D.wireframe.lineOpacity)), showSurface: r.showSurface !== false,
    }
  }
  return undefined
}

/** The stored list. Absent, non-array or empty-after-filtering collapses to `undefined`
 *  (never `[]`) so a document without treatments round-trips byte-identical — the same
 *  posture config.ts's parseMotionTracks takes. Duplicate ids keep the first entry. */
export function parseTreatments(raw: unknown): Treatment[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<string>()
  const out: Treatment[] = []
  for (const entry of raw) {
    const t = parseTreatment(entry)
    if (!t || seen.has(t.id)) continue
    seen.add(t.id)
    out.push(t)
  }
  return out.length ? out : undefined
}

/** A copy for a duplicated object: same dials, same order, FRESH ids — a shared id would
 *  make one motion track drive both copies. */
export function cloneTreatments(list: Treatment[] | undefined): Treatment[] | undefined {
  if (!list?.length) return undefined
  return list.map((t) => ({ ...t, id: newTreatmentId() }))
}

export function treatmentsOf(obj: SceneObject | null | undefined): Treatment[] {
  return obj?.treatments ?? []
}

export function findTreatment(
  doc: SceneDoc, objectId: string, treatmentId: string,
): { obj: SceneObject; treatment: Treatment; index: number } | null {
  const obj = doc.objects.find((o) => o.id === objectId)
  if (!obj) return null
  const list = treatmentsOf(obj)
  const index = list.findIndex((t) => t.id === treatmentId)
  if (index === -1) return null
  return { obj, treatment: list[index]!, index }
}

/** Enabled edge-family treatments, in stack order. */
export function edgeTreatmentsOf(obj: SceneObject): Treatment[] {
  return treatmentsOf(obj).filter((t) => t.enabled && !isMaskedKind(t.kind))
}

export interface MaskedGroup {
  objectId: string
  invert: boolean
  /** Stack order — applied one after another to ONE offscreen draw of the object. */
  treatments: Treatment[]
  rendered: boolean
  skipped?: 'cap' | 'invert'
}

/**
 * The per-frame plan for the masked family, in doc order (the tree draws `doc.objects`
 * grouped by parent, each level in array order, so this IS tree order). One group per
 * (object, invert) pair. Rules:
 *  - hidden objects, disabled treatments and non-host kinds contribute nothing;
 *  - at most ONE inverted group renders per frame — two "everything else" blurs stacked
 *    have no meaning — later ones are `skipped: 'invert'`;
 *  - at most TREATED_OBJECT_CAP groups render; the rest are `skipped: 'cap'`.
 * Callers MUST surface skipped groups (the tree does) — a silent skip reads as a bug.
 */
export function maskedTreatmentPlan(doc: SceneDoc): MaskedGroup[] {
  const groups: MaskedGroup[] = []
  for (const obj of doc.objects) {
    if (!obj.visible || !isTreatmentHost(obj)) continue
    const masked = treatmentsOf(obj).filter((t) => t.enabled && isMaskedKind(t.kind))
    const normal = masked.filter((t) => !t.invert)
    const inverted = masked.filter((t) => t.invert)
    if (normal.length) groups.push({ objectId: obj.id, invert: false, treatments: normal, rendered: false })
    if (inverted.length) groups.push({ objectId: obj.id, invert: true, treatments: inverted, rendered: false })
  }
  let rendered = 0
  let invertUsed = false
  for (const g of groups) {
    if (g.invert && invertUsed) { g.skipped = 'invert'; continue }
    if (rendered >= TREATED_OBJECT_CAP) { g.skipped = 'cap'; continue }
    g.rendered = true
    rendered++
    if (g.invert) invertUsed = true
  }
  return groups
}

/** Ids of every treatment in a group the stage will NOT draw this frame — the tree marks them. */
export function unrenderedTreatmentIds(plan: MaskedGroup[]): Set<string> {
  const out = new Set<string>()
  for (const g of plan) if (!g.rendered) for (const t of g.treatments) out.add(t.id)
  return out
}
```

- [ ] **Step 4: Wire the field into `config.ts`**

At the top of `frontend/app/lib/scene3d/config.ts`, next to the `primParams` import (line 4), add:

```ts
import { parseTreatments, type Treatment } from './treatments'
```

In `interface SceneObjectBase` (around line 220), after the `parentId?: string` member, add:

```ts
  /** Per-object treatments (blur, glow, rim light…), in stack order. Lives HERE, never
   *  as entries of `doc.objects` — see treatments.ts. Absent means none. */
  treatments?: Treatment[]
```

In the object parser (around line 1200, the `const common: SceneObjectBase = {` block inside `raw.objects.flatMap`), add a local before `common` and spread it in:

```ts
        const om = parseObjectMotion(o.motion)
        const treatments = parseTreatments(o.treatments)
        const common: SceneObjectBase = {
          // …existing fields unchanged…
          ...(om ? { motion: om } : {}),
          ...(treatments ? { treatments } : {}),
        }
```

- [ ] **Step 5: Copy treatments with fresh ids in `cloneObject`**

In `frontend/app/components/vue-canvas/Scene3DStudioSurface.vue`, inside `cloneObject`'s `Object.assign(copy, { … })` (around line 3132), after the `...(src.motion ? { motion: … } : {})` line, add:

```ts
    // Treatments travel with the copy under FRESH ids — a shared id would let one motion
    // track drive both copies (cloneTreatments's own doc).
    ...(src.treatments ? { treatments: cloneTreatments(src.treatments) } : {}),
```

Add `cloneTreatments` to the surface's imports: find the existing `} from '~/lib/scene3d/config'` import block (line ~25) and add a new line below it:

```ts
import { cloneTreatments } from '~/lib/scene3d/treatments'
```

(Task 8 extends this import line; keep it as one import statement.)

- [ ] **Step 6: Run the tests**

Run: `cd frontend && node_modules/.bin/vitest run tests/unit/scene3d-treatments.unit.spec.ts tests/unit/scene3d-config.unit.spec.ts tests/unit/scene3d-hierarchy.unit.spec.ts`
Expected: all PASS (the two existing specs prove the round-trip and hierarchy invariants still hold).

- [ ] **Step 7: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/lib/scene3d/treatments.ts frontend/app/lib/scene3d/config.ts frontend/app/components/vue-canvas/Scene3DStudioSurface.vue frontend/tests/unit/scene3d-treatments.unit.spec.ts
git commit -m "feat(scene3d): treatment data model, parser and masked-plan rules

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Treatment inspector controls (one card per kind)

**Files:**
- Create: `frontend/app/lib/scene3d/treatmentControls.ts`
- Test: `frontend/tests/unit/scene3d-treatment-controls.unit.spec.ts`

**Interfaces:**
- Consumes: `ControlSpec` from `~/lib/spacetype/effect`; `TREATMENT_DEFAULTS`, `TREATMENT_LABELS`, `isMaskedKind`, `TreatmentKind` from Task 1.
- Produces:
  - `TREATMENT_KEY_PREFIX = 'treatment.'`
  - `treatmentControls(kind: TreatmentKind): ControlSpec[]` — every row's `key` is `treatment.<field>` where `<field>` is the dial's property name on the `Treatment` object; every row's `group` is `TREATMENT_LABELS[kind]` so `StudioControlPanel` draws ONE card titled with the human name; masked kinds end with a `switch` row `treatment.invert` labelled "Everything else". All rows carry `bindable: false`.
  - `treatmentField(key: string): string` — strips the prefix.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/unit/scene3d-treatment-controls.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { TREATMENT_KINDS, TREATMENT_LABELS, TREATMENT_DEFAULTS, createTreatment, isMaskedKind } from '~/lib/scene3d/treatments'
import { treatmentControls, treatmentField, TREATMENT_KEY_PREFIX } from '~/lib/scene3d/treatmentControls'

describe('treatmentControls', () => {
  it('every kind yields at least one row, all in ONE group named with the kind\'s human label', () => {
    for (const kind of TREATMENT_KINDS) {
      const rows = treatmentControls(kind)
      expect(rows.length, kind).toBeGreaterThan(0)
      expect(new Set(rows.map((r) => r.group)), kind).toEqual(new Set([TREATMENT_LABELS[kind]]))
    }
  })
  it('every row key is treatment.<field> for a field that exists on a fresh treatment of that kind, with the same default', () => {
    for (const kind of TREATMENT_KINDS) {
      const fresh = createTreatment(kind) as unknown as Record<string, unknown>
      for (const row of treatmentControls(kind)) {
        expect(row.key.startsWith(TREATMENT_KEY_PREFIX), row.key).toBe(true)
        const field = treatmentField(row.key)
        expect(field in fresh, `${kind}.${field}`).toBe(true)
        expect(row.default, `${kind}.${field}`).toEqual(fresh[field])
      }
    }
  })
  it('masked kinds end with the "Everything else" switch; edge kinds never offer it', () => {
    for (const kind of TREATMENT_KINDS) {
      const rows = treatmentControls(kind)
      const invert = rows.find((r) => r.key === 'treatment.invert')
      if (isMaskedKind(kind)) {
        expect(invert, kind).toMatchObject({ kind: 'switch', label: 'Everything else', default: false })
        expect(rows[rows.length - 1]!.key).toBe('treatment.invert')
      } else {
        expect(invert, kind).toBeUndefined()
      }
    }
  })
  it('labels are sentence case and colour rows are colour kind', () => {
    for (const kind of TREATMENT_KINDS) for (const row of treatmentControls(kind)) {
      expect(row.label, row.key).toMatch(/^[A-Z]/)
      if (/color|tint/i.test(row.key)) expect(row.kind, row.key).toBe('color')
    }
    expect(treatmentControls('wireframe').find((r) => r.key === 'treatment.showSurface')).toMatchObject({ kind: 'switch', default: TREATMENT_DEFAULTS.wireframe.showSurface })
  })
  it('rows are never Collection-bindable (the panel would draw a dead variable glyph)', () => {
    for (const kind of TREATMENT_KINDS) for (const row of treatmentControls(kind)) expect((row as any).bindable, row.key).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && node_modules/.bin/vitest run tests/unit/scene3d-treatment-controls.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/scene3d/treatmentControls`.

- [ ] **Step 3: Create `frontend/app/lib/scene3d/treatmentControls.ts`**

```ts
// The inspector rows for ONE selected treatment — the source the treatment inspector, the
// motion targets and the agent vocabulary all derive from (agentControls.ts remaps the
// keys to `object.treatments.<id>.<field>`; the surface reads/writes `<field>` directly
// on the selected Treatment). Pure: no three, no Vue.
import type { ControlSpec } from '~/lib/spacetype/effect'
import { TREATMENT_DEFAULTS, TREATMENT_LABELS, isMaskedKind, type TreatmentKind } from './treatments'

export const TREATMENT_KEY_PREFIX = 'treatment.'

type Row = ControlSpec & { hint?: string; bindable?: boolean }
const D = TREATMENT_DEFAULTS

// Every row is `bindable: false`: the treatment inspector offers no Collection binding
// (same guard panelPresentation.ts applies to the migrated object rows).
const slider = (group: string, field: string, label: string, min: number, max: number, step: number, def: number, hint?: string): Row =>
  ({ key: TREATMENT_KEY_PREFIX + field, label, kind: 'slider', min, max, step, default: def, group, bindable: false, ...(hint ? { hint } : {}) })
const color = (group: string, field: string, label: string, def: string): Row =>
  ({ key: TREATMENT_KEY_PREFIX + field, label, kind: 'color', default: def, group, bindable: false })
const toggle = (group: string, field: string, label: string, def: boolean, hint?: string): Row =>
  ({ key: TREATMENT_KEY_PREFIX + field, label, kind: 'switch', default: def, group, bindable: false, ...(hint ? { hint } : {}) })

/** Rows for one kind, in display order. Group = the kind's human label, so the panel draws
 *  a single card titled e.g. "Rim light". Masked kinds end with the "Everything else" switch. */
export function treatmentControls(kind: TreatmentKind): ControlSpec[] {
  const g = TREATMENT_LABELS[kind]
  let rows: Row[]
  switch (kind) {
    case 'blur':
      rows = [slider(g, 'amount', 'Amount', 0, 1, 0.01, D.blur.amount, 'How soft the object goes')]
      break
    case 'glow':
      rows = [
        slider(g, 'strength', 'Strength', 0, 3, 0.01, D.glow.strength),
        slider(g, 'threshold', 'Threshold', 0, 1, 0.01, D.glow.threshold, 'Only parts brighter than this glow'),
        color(g, 'tint', 'Tint', D.glow.tint),
      ]
      break
    case 'pixelate':
      rows = [slider(g, 'cellSize', 'Cell size', 2, 64, 1, D.pixelate.cellSize, 'Pixels per block')]
      break
    case 'fade':
      rows = [slider(g, 'opacity', 'Opacity', 0, 1, 0.01, D.fade.opacity)]
      break
    case 'rimLight':
      rows = [
        color(g, 'color', 'Colour', D.rimLight.color),
        slider(g, 'width', 'Width', 0, 1, 0.01, D.rimLight.width, 'How far the light creeps in from the edge'),
        slider(g, 'strength', 'Strength', 0, 3, 0.01, D.rimLight.strength),
      ]
      break
    case 'outline':
      rows = [
        color(g, 'color', 'Colour', D.outline.color),
        slider(g, 'thickness', 'Thickness', 0, 1, 0.01, D.outline.thickness, 'Stays the same on screen as you zoom'),
      ]
      break
    case 'xray':
      rows = [
        color(g, 'color', 'Colour', D.xray.color),
        slider(g, 'opacity', 'Opacity', 0, 1, 0.01, D.xray.opacity),
      ]
      break
    case 'wireframe':
      rows = [
        color(g, 'color', 'Colour', D.wireframe.color),
        slider(g, 'lineOpacity', 'Line opacity', 0, 1, 0.01, D.wireframe.lineOpacity),
        toggle(g, 'showSurface', 'Show surface', D.wireframe.showSurface, 'Keep the solid surface under the lines'),
      ]
      break
    default:
      rows = []
  }
  if (isMaskedKind(kind)) {
    rows.push(toggle(g, 'invert', 'Everything else', false, 'Apply to the rest of the scene instead of this object'))
  }
  return rows
}

/** `treatment.amount` → `amount`. Keys without the prefix pass through unchanged. */
export function treatmentField(key: string): string {
  return key.startsWith(TREATMENT_KEY_PREFIX) ? key.slice(TREATMENT_KEY_PREFIX.length) : key
}
```

- [ ] **Step 4: Run the test**

Run: `cd frontend && node_modules/.bin/vitest run tests/unit/scene3d-treatment-controls.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/lib/scene3d/treatmentControls.ts frontend/tests/unit/scene3d-treatment-controls.unit.spec.ts
git commit -m "feat(scene3d): inspector control rows per treatment kind

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Nested id-addressed paths in the shared resolvers

The motion writer (`setByIdPath`) and the agent's `makeConfigParams` both resolve `<list>.<id>.<rest>` ONE level deep. A treatment path `objects.<id>.treatments.<tid>.amount` has a second id-addressed list inside `rest`; without this task `setByPath` would create a junk property named `<tid>` ON the treatments array and save it.

**Files:**
- Modify: `frontend/app/lib/studio/idPath.ts` (`resolveIdPath`, ~line 85)
- Modify: `frontend/app/lib/agent/configParams.ts` (`read` ~line 155, `write` ~line 165)
- Test: `frontend/tests/unit/studio-id-path.unit.spec.ts` (append), create `frontend/tests/unit/agent-config-params-nested-ids.unit.spec.ts`

**Interfaces:**
- Consumes: existing `resolveIdPath`, `setByIdPath`, `getByIdPath` signatures (unchanged), existing `indexInList`/`isIndex` helpers inside configParams.ts.
- Produces: same functions, now resolving every array-with-id segment along the path. Behaviour for single-level paths is unchanged. An out-of-range positional segment inside `rest` (`layers.La.stops.9.color` on two stops) now refuses instead of fabricating a sparse slot — the posture the module already documents.

- [ ] **Step 1: Append failing tests to `studio-id-path.unit.spec.ts`**

At the end of `frontend/tests/unit/studio-id-path.unit.spec.ts` add:

```ts
describe('nested id lists (objects.<id>.treatments.<tid>.<dial>)', () => {
  const nested = () => ({
    objects: [
      { id: 'A', treatments: [{ id: 't1', kind: 'blur', amount: 0.2 }, { id: 't2', kind: 'fade', opacity: 0.5 }] },
      { id: 'B' },
    ],
  })
  it('resolves an id inside a nested list to its positional index', () => {
    expect(resolveIdPath(nested(), 'objects.A.treatments.t2.opacity')).toBe('objects.0.treatments.1.opacity')
  })
  it('refuses an unknown nested id rather than fabricating a key on the array', () => {
    expect(resolveIdPath(nested(), 'objects.A.treatments.zzz.opacity')).toBeUndefined()
    const cfg = nested()
    expect(setByIdPath(cfg, 'objects.A.treatments.zzz.opacity', 1)).toBe(false)
    expect(cfg).toEqual(nested())
  })
  it('reads and writes through the nested id', () => {
    const cfg = nested()
    expect(getByIdPath(cfg, 'objects.A.treatments.t1.amount')).toBe(0.2)
    expect(setByIdPath(cfg, 'objects.A.treatments.t1.amount', 0.9)).toBe(true)
    expect(cfg.objects[0]!.treatments![0]!.amount).toBe(0.9)
  })
  it('a nested path on an object with no list refuses', () => {
    expect(resolveIdPath(nested(), 'objects.B.treatments.t1.amount')).toBeUndefined()
  })
  it('an out-of-range positional index inside the rest refuses', () => {
    expect(resolveIdPath(nested(), 'objects.A.treatments.5.amount')).toBeUndefined()
  })
  it('a missing plain (non-array) intermediate is still appended as written', () => {
    expect(resolveIdPath(nested(), 'objects.B.material.roughness')).toBe('objects.1.material.roughness')
  })
})
```

- [ ] **Step 2: Create `agent-config-params-nested-ids.unit.spec.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { makeConfigParams } from '~/lib/agent/configParams'

const doc = () => ({
  objects: [
    { id: 'A', material: { roughness: 0.5 }, treatments: [{ id: 't1', kind: 'blur', amount: 0.2 }] },
  ],
})

describe('makeConfigParams: nested id-addressed lists', () => {
  it('reads and writes objects.<id>.treatments.<tid>.<dial>', () => {
    const cfg = doc()
    const p = makeConfigParams(() => cfg, () => 0, 'objects', 'id', 'object')
    expect(p['objects.A.treatments.t1.amount']).toBe(0.2)
    p['objects.A.treatments.t1.amount'] = 0.7
    expect(cfg.objects[0]!.treatments[0]!.amount).toBe(0.7)
  })
  it('an unknown nested id reads undefined and writes nothing — no key fabricated on the array', () => {
    const cfg = doc()
    const p = makeConfigParams(() => cfg, () => 0, 'objects', 'id', 'object')
    expect(p['objects.A.treatments.zzz.amount']).toBeUndefined()
    p['objects.A.treatments.zzz.amount'] = 1
    expect(cfg).toEqual(doc())
    expect(Object.keys(cfg.objects[0]!.treatments)).toEqual(['0'])
  })
  it('single-level paths are unchanged', () => {
    const cfg = doc()
    const p = makeConfigParams(() => cfg, () => 0, 'objects', 'id', 'object')
    p['objects.A.material.roughness'] = 0.9
    expect(cfg.objects[0]!.material.roughness).toBe(0.9)
  })
})
```

- [ ] **Step 3: Run both to verify failure**

Run: `cd frontend && node_modules/.bin/vitest run tests/unit/studio-id-path.unit.spec.ts tests/unit/agent-config-params-nested-ids.unit.spec.ts`
Expected: the nested cases FAIL (resolve returns `objects.0.treatments.t2.opacity`; the params write fabricates `treatments.zzz`).

- [ ] **Step 4: Make `resolveIdPath` walk nested lists**

Replace the body of `resolveIdPath` in `frontend/app/lib/studio/idPath.ts` with:

```ts
export function resolveIdPath(cfg: unknown, path: string, idKey = DEFAULT_ID_KEY): string | undefined {
  const p = parseIdPath(path)
  if (!p) return undefined
  const arr = listOf(cfg, p.list)
  if (!arr || arr.length === 0) return undefined
  const i = p.positional ? Number(p.key) : indexOfId(cfg, p.list, p.key, idKey)
  // An out-of-range positional index is just as wrong as an unknown id: it is a
  // slot that is not there, and `setByPath` would happily create it.
  if (i === undefined || i < 0 || i >= arr.length) return undefined
  const out: string[] = [p.list, String(i)]
  if (!p.rest) return out.join('.')
  // NESTED lists (`objects.<id>.treatments.<tid>.amount`): keep walking the live config.
  // Whenever the current container is an array and the next segment is not an index, it
  // is an id inside that array — resolve it the same way, refuse if unknown. Segments past
  // the last existing container are appended as written: an optional leaf that has not
  // been backfilled is a legitimate target (setByIdPath's parent guard decides).
  let cur: unknown = arr[i]
  for (const seg of p.rest.split('.')) {
    if (Array.isArray(cur)) {
      const j = isIndex(seg) ? Number(seg) : cur.findIndex((m) => (m as any)?.[idKey] === seg)
      if (j < 0 || j >= cur.length) return undefined
      out.push(String(j))
      cur = cur[j]
      continue
    }
    out.push(seg)
    cur = cur != null && typeof cur === 'object' ? (cur as any)[seg] : undefined
  }
  return out.join('.')
}
```

- [ ] **Step 5: Teach `makeConfigParams` the same rule**

In `frontend/app/lib/agent/configParams.ts`, replace `read` and `write` with:

```ts
  function read(key: string): ParamValue | undefined {
    const { obj, parts } = base(key)
    let cur: unknown = obj
    for (const p of parts) {
      if (cur == null || typeof cur !== 'object') return undefined
      // A non-index segment against an ARRAY is an id inside it
      // (`objects.<id>.treatments.<tid>.amount`) — resolve, refuse if unknown.
      if (Array.isArray(cur) && !isIndex(p)) {
        const i = indexInList(cur, p, 'id')
        if (i === undefined) return undefined
        cur = cur[i]
        continue
      }
      cur = (cur as AnyObj)[p]
    }
    return cur as ParamValue | undefined
  }

  function write(key: string, value: ParamValue): void {
    const { obj, parts } = base(key)
    if (!obj) return
    let cur: AnyObj = obj
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i]!
      if (Array.isArray(cur) && !isIndex(p)) {
        // Same nested-id rule as `read`: never fabricate a named key on an array.
        const j = indexInList(cur, p, 'id')
        if (j === undefined) return
        cur = cur[j] as AnyObj
        continue
      }
      let next = cur[p]
      if (next == null || typeof next !== 'object') { next = {}; cur[p] = next }
      cur = next as AnyObj
    }
    const last = parts[parts.length - 1]!
    if (Array.isArray(cur) && !isIndex(last)) return
    cur[last] = value
  }
```

(`isIndex` and `indexInList` already exist in this file at lines ~66 and ~95.)

- [ ] **Step 6: Run the tests, including the existing consumers**

Run: `cd frontend && node_modules/.bin/vitest run tests/unit/studio-id-path.unit.spec.ts tests/unit/agent-config-params-nested-ids.unit.spec.ts tests/unit/scene3d-motion.unit.spec.ts tests/unit/scene3d-agent-controls.unit.spec.ts && node_modules/.bin/vitest run tests/unit --reporter=dot 2>&1 | tail -5`
Expected: all PASS; the full unit run shows no new failures (compare against `git stash`-free baseline by reading the summary line only — do NOT stash).

- [ ] **Step 7: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/lib/studio/idPath.ts frontend/app/lib/agent/configParams.ts frontend/tests/unit/studio-id-path.unit.spec.ts frontend/tests/unit/agent-config-params-nested-ids.unit.spec.ts
git commit -m "fix(studio): id-addressed paths resolve nested lists instead of fabricating keys

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Motion targets and agent vocabulary for treatments

**Files:**
- Modify: `frontend/app/lib/scene3d/agentControls.ts` (add `iterateTreatmentControls`; extend `sceneStackControls` ~line 97)
- Modify: `frontend/app/lib/scene3d/motion/targets.ts` (extend `animatableTargets` after the `iterateObjectControls` block, ~line 58)
- Test: append to `frontend/tests/unit/scene3d-motion-targets.unit.spec.ts` and `frontend/tests/unit/scene3d-agent-controls.unit.spec.ts`

**Interfaces:**
- Consumes: `treatmentControls`, `treatmentField` (Task 2); `treatmentsOf`, `TREATMENT_LABELS`, `Treatment` (Task 1); existing `OBJECT_PREFIX`, `SceneControl`, `animatableRange`, `setByIdPath` (Task 3 made it nested-aware; `motion/apply.ts` needs no change).
- Produces:
  - `iterateTreatmentControls(doc, visit: (control: SceneControl, obj: SceneObject, id: string, treatment: Treatment) => void): void` — visits one relative control per (object, treatment, row) with key `object.treatments.<tid>.<field>` and label `"<Kind label> <row label lowercased>"` (e.g. `Blur amount`, `Rim light colour`). Same id-safety refusal as `iterateObjectControls`.
  - `sceneStackControls(doc)` additionally emits `objects.<id>.treatments.<tid>.<field>` labelled `"<object name> · Blur amount"`.
  - `animatableTargets(doc)` additionally emits those paths for `slider` rows only (motion tracks are numeric; the on/off flag is NOT a track — key a fade to 0 instead. This is a deliberate narrowing of the spec's "enabled becomes animatable": the track system has no boolean channel).

- [ ] **Step 1: Append failing tests**

To `frontend/tests/unit/scene3d-motion-targets.unit.spec.ts` (inside `describe('animatableTargets')` or as a new describe at the end), add:

```ts
import { createTreatment } from '~/lib/scene3d/treatments'

describe('animatableTargets: treatments', () => {
  it('emits an id-addressed slider path per treatment dial, labelled with the object and kind', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects); box.name = 'Bottle'
    const blur = createTreatment('blur'); const rim = createTreatment('rimLight')
    box.treatments = [blur, rim]
    doc.objects.push(box)
    const targets = animatableTargets(doc)
    const amount = targets.find((t) => t.path === `objects.${box.id}.treatments.${blur.id}.amount`)
    expect(amount).toMatchObject({ label: 'Bottle · Blur amount', min: 0, max: 1 })
    expect(targets.find((t) => t.path === `objects.${box.id}.treatments.${rim.id}.strength`)?.label).toBe('Bottle · Rim light strength')
    // colour rows and switches are not tracks
    expect(targets.find((t) => t.path.endsWith(`.${rim.id}.color`))).toBeUndefined()
    expect(targets.find((t) => t.path.endsWith(`.${blur.id}.invert`))).toBeUndefined()
    expect(targets.find((t) => t.path.endsWith(`.${blur.id}.enabled`))).toBeUndefined()
  })
  it('a track on a treatment dial writes through the id, and survives reordering the stack', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects)
    const a = createTreatment('fade'); const b = createTreatment('blur')
    box.treatments = [a, b]
    doc.objects.push(box)
    doc.motion.tracks = [track({ path: `objects.${box.id}.treatments.${b.id}.amount`, from: 0, to: 0.8 })]
    // Sampled mid-track (t01 = 0.5) rather than at the end, where a looping track wraps back to `from`.
    expect((applyMotionToDoc(doc, 0.5).doc.objects[0]!.treatments![1] as any).amount).toBeCloseTo(0.4, 5)
    box.treatments = [b, a] // reorder: same id, new index
    expect((applyMotionToDoc(doc, 0.5).doc.objects[0]!.treatments![0] as any).amount).toBeCloseTo(0.4, 5)
    expect((applyMotionToDoc(doc, 0.5).doc.objects[0]!.treatments![1] as any).opacity).toBe(0.5) // fade untouched (its default)
  })
})
```

To `frontend/tests/unit/scene3d-agent-controls.unit.spec.ts` add at the end:

```ts
import { createTreatment } from '~/lib/scene3d/treatments'

describe('sceneStackControls: treatments', () => {
  it('names every treatment dial absolutely, by object id and treatment id', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects); box.name = 'Bottle'
    const glow = createTreatment('glow')
    box.treatments = [glow]
    doc.objects.push(box)
    const keys = sceneStackControls(doc).map((c) => c.key)
    expect(keys).toContain(`objects.${box.id}.treatments.${glow.id}.strength`)
    expect(keys).toContain(`objects.${box.id}.treatments.${glow.id}.tint`)
    expect(keys).toContain(`objects.${box.id}.treatments.${glow.id}.invert`)
    const c = sceneStackControls(doc).find((x) => x.key.endsWith(`.${glow.id}.strength`))!
    expect(c.label).toBe('Bottle · Glow strength')
    expect((c as any).when).toBeUndefined()
    expect((c as any).bindable).toBeUndefined()
  })
  it('an object without treatments adds no stack controls', () => {
    const doc = defaultDoc()
    doc.objects.push(createPrimitive('box', doc.objects))
    expect(sceneStackControls(doc).some((c) => c.key.includes('.treatments.'))).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && node_modules/.bin/vitest run tests/unit/scene3d-motion-targets.unit.spec.ts tests/unit/scene3d-agent-controls.unit.spec.ts`
Expected: the new cases FAIL (`toMatchObject` on `undefined`, `toContain` misses).

- [ ] **Step 3: Add `iterateTreatmentControls` and extend `sceneStackControls`**

In `frontend/app/lib/scene3d/agentControls.ts`, add imports near the top:

```ts
import { treatmentsOf, TREATMENT_LABELS, type Treatment } from '~/lib/scene3d/treatments'
import { treatmentControls, treatmentField } from '~/lib/scene3d/treatmentControls'
```

Directly after the `iterateObjectControls` function, add:

```ts
/** "Blur amount" / "Rim light colour": the kind's human label + the row label lowercased. */
function treatmentRowLabel(kind: Treatment['kind'], rowLabel: string): string {
  return `${TREATMENT_LABELS[kind]} ${rowLabel.charAt(0).toLowerCase()}${rowLabel.slice(1)}`
}

/**
 * The treatment counterpart of `iterateObjectControls`: one RELATIVE control per
 * (object, treatment, inspector row), keyed `object.treatments.<treatmentId>.<field>`.
 * Same id-safety refusal on the OBJECT id; treatment ids are already refused at parse time
 * (treatments.ts's parseTreatment drops empty/dotted/all-digit ids), so nothing here can
 * emit a path the nested-id resolvers would misread.
 */
export function iterateTreatmentControls(
  doc: SceneDoc,
  visit: (control: SceneControl, obj: SceneObject, id: string, treatment: Treatment) => void,
): void {
  const objects = Array.isArray(doc?.objects) ? doc.objects : []
  for (const obj of objects) {
    const id = obj?.id
    if (typeof id !== 'string' || id === '' || id.includes('.') || /^\d+$/.test(id)) continue
    for (const t of treatmentsOf(obj)) {
      for (const c of treatmentControls(t.kind)) {
        visit({
          ...c,
          key: `${OBJECT_PREFIX}treatments.${t.id}.${treatmentField(c.key)}`,
          label: treatmentRowLabel(t.kind, c.label),
        } as SceneControl, obj, id, t)
      }
    }
  }
}
```

In `sceneStackControls`, after the existing `iterateObjectControls(doc, …)` call and before `return out`, add:

```ts
  iterateTreatmentControls(doc, (c, obj, id) => {
    const rest = c.key.slice(OBJECT_PREFIX.length)
    const { when, agent, animatable, summary, bindable, entry, optionLabels, ...spec } = c as any
    out.push({ ...spec, key: `objects.${id}.${rest}`, label: `${obj.name || 'Object'} · ${c.label}` } as ControlSpec)
  })
```

- [ ] **Step 4: Extend `animatableTargets`**

In `frontend/app/lib/scene3d/motion/targets.ts`, change the import to:

```ts
import { OBJECT_PREFIX, iterateObjectControls, iterateTreatmentControls } from '~/lib/scene3d/agentControls'
```

After the `iterateObjectControls(doc, …)` block and before `return out`, add:

```ts
  // Treatment dials — slider rows only: a track is numeric, so the on/off flag and colour
  // rows are not targets (key a fade to 0 to switch an effect off over time).
  iterateTreatmentControls(doc, (c, obj, id) => {
    if (c.kind !== 'slider') return
    out.push({
      path: `objects.${id}.${c.key.slice(OBJECT_PREFIX.length)}`,
      label: `${obj.name || 'Object'} · ${c.label}`,
      ...animatableRange(c as any),
    })
  })
```

- [ ] **Step 5: Run the tests**

Run: `cd frontend && node_modules/.bin/vitest run tests/unit/scene3d-motion-targets.unit.spec.ts tests/unit/scene3d-agent-controls.unit.spec.ts tests/unit/scene3d-motion.unit.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/lib/scene3d/agentControls.ts frontend/app/lib/scene3d/motion/targets.ts frontend/tests/unit/scene3d-motion-targets.unit.spec.ts frontend/tests/unit/scene3d-agent-controls.unit.spec.ts
git commit -m "feat(scene3d): treatment dials join the motion targets and agent vocabulary

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Edge family — shell meshes, x-ray override, data-pass view, engine hooks

**Files:**
- Create: `frontend/app/lib/scene3d/treatmentShells.ts`
- Modify: `frontend/app/lib/scene3d/engine.ts` (imports ~line 30; `syncObject` end of the primitive/glb work ~line 1000-1076 and the GLB load `.then` ~line 908; `applyObjectOpacities` ~line 1260)
- Modify: `frontend/app/lib/scene3d/interaction.ts` (constructor, line 180)
- Modify: `frontend/app/lib/scene3d/passes.ts` (`renderPasses`, around the data passes)
- Test: `frontend/tests/unit/scene3d-treatment-shells.unit.spec.ts`

**Interfaces:**
- Consumes: `edgeTreatmentsOf`, `Treatment` (Task 1); `stripAlpha` from `~/lib/color/convert`.
- Produces (from `~/lib/scene3d/treatmentShells`):
  - `SURFACE_HIDDEN_LAYER = 30`, `STAGE_LAYER = 29`
  - `isTreatmentShell(o: THREE.Object3D): boolean` — `typeof o.userData.treatmentShell === 'string'`
  - `ownMeshes(root: THREE.Object3D): THREE.Mesh[]` — the object's own meshes (skips other objects' roots by `userData.sceneId`, shells, gizmo helpers)
  - `syncTreatmentShells(root, obj: SceneObject, opts: { lightView: boolean }): void` — idempotent per (geometry uuid, edge treatments, lightView) key stored in `mesh.userData.treatmentShellKey`
  - `beginDataPassView(scene: THREE.Object3D): () => void` — hides rim/outline/wireframe shells and re-enables layer 0 on wireframe-hidden surfaces; returns the restore function
- Shell contract every later task relies on: shells are CHILDREN of the source mesh, share its geometry by reference (never disposed by the shells module), carry `userData.treatmentShell = <kind>`, `raycast` is a no-op, `castShadow = receiveShadow = false`. An x-ray override stores `mesh.userData.xrayMaterial` / `mesh.userData.xrayPrev`. X-ray materials carry `material.userData.keepTransparent = true`.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/unit/scene3d-treatment-shells.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { createPrimitive } from '~/lib/scene3d/config'
import { createTreatment } from '~/lib/scene3d/treatments'
import {
  syncTreatmentShells, isTreatmentShell, ownMeshes, beginDataPassView, SURFACE_HIDDEN_LAYER,
} from '~/lib/scene3d/treatmentShells'

function primitiveRoot(): { mesh: THREE.Mesh; obj: ReturnType<typeof createPrimitive> } {
  const obj = createPrimitive('box')
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial())
  mesh.userData.sceneId = obj.id
  mesh.userData.realMaterial = mesh.material
  return { mesh, obj }
}
const shells = (m: THREE.Object3D) => m.children.filter(isTreatmentShell) as THREE.Mesh[]
const kinds = (m: THREE.Object3D) => shells(m).map((s) => s.userData.treatmentShell)

describe('syncTreatmentShells', () => {
  it('adds one shell per enabled edge treatment, sharing the source geometry, no raycast, no shadows', () => {
    const { mesh, obj } = primitiveRoot()
    obj.treatments = [createTreatment('rimLight'), createTreatment('outline'), createTreatment('blur')]
    syncTreatmentShells(mesh, obj, { lightView: false })
    expect(kinds(mesh)).toEqual(['rimLight', 'outline'])
    for (const s of shells(mesh)) {
      expect(s.geometry).toBe(mesh.geometry)
      expect(s.castShadow).toBe(false)
      expect(s.receiveShadow).toBe(false)
      const hits: THREE.Intersection[] = []
      s.raycast(new THREE.Raycaster(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, -1)), hits)
      expect(hits).toHaveLength(0)
    }
    expect((shells(mesh)[1]!.material as THREE.Material).side).toBe(THREE.BackSide)
  })
  it('is idempotent: a second sync with the same treatments keeps the same shell instances', () => {
    const { mesh, obj } = primitiveRoot()
    obj.treatments = [createTreatment('rimLight')]
    syncTreatmentShells(mesh, obj, { lightView: false })
    const first = shells(mesh)[0]
    syncTreatmentShells(mesh, obj, { lightView: false })
    expect(shells(mesh)[0]).toBe(first)
  })
  it('rebuilds when a dial changes and when the geometry is swapped, disposing old shell materials', () => {
    const { mesh, obj } = primitiveRoot()
    const rim = createTreatment('rimLight') as Extract<ReturnType<typeof createTreatment>, { kind: 'rimLight' }>
    obj.treatments = [rim]
    syncTreatmentShells(mesh, obj, { lightView: false })
    const oldMat = shells(mesh)[0]!.material as THREE.Material
    let disposed = false
    oldMat.addEventListener('dispose', () => { disposed = true })
    rim.strength = 2
    syncTreatmentShells(mesh, obj, { lightView: false })
    expect(disposed).toBe(true)
    expect(((shells(mesh)[0]!.material as THREE.ShaderMaterial).uniforms.uStrength!.value)).toBe(2)
    const before = shells(mesh)[0]
    mesh.geometry = new THREE.SphereGeometry(1)
    syncTreatmentShells(mesh, obj, { lightView: false })
    expect(shells(mesh)[0]).not.toBe(before)
    expect(shells(mesh)[0]!.geometry).toBe(mesh.geometry)
  })
  it('removes shells and restores layers when treatments go away or are disabled', () => {
    const { mesh, obj } = primitiveRoot()
    const wire = createTreatment('wireframe') as Extract<ReturnType<typeof createTreatment>, { kind: 'wireframe' }>
    wire.showSurface = false
    obj.treatments = [wire]
    syncTreatmentShells(mesh, obj, { lightView: false })
    expect(kinds(mesh)).toEqual(['wireframe'])
    expect(mesh.layers.isEnabled(0)).toBe(false)
    expect(mesh.layers.isEnabled(SURFACE_HIDDEN_LAYER)).toBe(true)
    wire.enabled = false
    syncTreatmentShells(mesh, obj, { lightView: false })
    expect(kinds(mesh)).toEqual([])
    expect(mesh.layers.isEnabled(0)).toBe(true)
    expect(mesh.layers.isEnabled(SURFACE_HIDDEN_LAYER)).toBe(false)
  })
  it('x-ray overrides the mounted material, re-applies after the engine resets it, and restores on removal', () => {
    const { mesh, obj } = primitiveRoot()
    const real = mesh.material
    obj.treatments = [createTreatment('xray')]
    syncTreatmentShells(mesh, obj, { lightView: false })
    expect(mesh.material).not.toBe(real)
    expect((mesh.material as THREE.Material).userData.keepTransparent).toBe(true)
    const xm = mesh.material
    mesh.material = real // what syncObject does every sync
    syncTreatmentShells(mesh, obj, { lightView: false })
    expect(mesh.material).toBe(xm)
    obj.treatments = []
    syncTreatmentShells(mesh, obj, { lightView: false })
    expect(mesh.material).toBe(real)
    expect(mesh.userData.xrayMaterial).toBeUndefined()
  })
  it('x-ray is not applied in Light View', () => {
    const { mesh, obj } = primitiveRoot()
    const real = mesh.material
    obj.treatments = [createTreatment('xray')]
    syncTreatmentShells(mesh, obj, { lightView: true })
    expect(mesh.material).toBe(real)
  })
  it('ownMeshes skips a nested child object\'s root and existing shells', () => {
    const { mesh, obj } = primitiveRoot()
    const child = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())
    child.userData.sceneId = 'other'
    mesh.add(child)
    obj.treatments = [createTreatment('outline')]
    syncTreatmentShells(mesh, obj, { lightView: false })
    expect(ownMeshes(mesh)).toEqual([mesh])
    expect(shells(child)).toHaveLength(0)
  })
})

describe('beginDataPassView', () => {
  it('hides rim/outline/wireframe shells and shows a wireframe-hidden surface, then restores', () => {
    const scene = new THREE.Scene()
    const { mesh, obj } = primitiveRoot()
    scene.add(mesh)
    const wire = createTreatment('wireframe') as Extract<ReturnType<typeof createTreatment>, { kind: 'wireframe' }>
    wire.showSurface = false
    obj.treatments = [createTreatment('rimLight'), wire]
    syncTreatmentShells(mesh, obj, { lightView: false })
    const restore = beginDataPassView(scene)
    expect(shells(mesh).every((s) => !s.visible)).toBe(true)
    expect(mesh.layers.isEnabled(0)).toBe(true)
    restore()
    expect(shells(mesh).every((s) => s.visible)).toBe(true)
    expect(mesh.layers.isEnabled(0)).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && node_modules/.bin/vitest run tests/unit/scene3d-treatment-shells.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/scene3d/treatmentShells`.

- [ ] **Step 3: Create `frontend/app/lib/scene3d/treatmentShells.ts`**

```ts
// Edge-family treatments (rim light, outline, x-ray, wireframe) as attachments on the
// object's OWN meshes — never an edit of the tracked real material, so they work over
// every material type (gradient, shader fill, opal…) and need no offscreen buffers.
//
// Shell meshes share the source geometry by reference and hang as CHILDREN of the source
// mesh, so they inherit its transform for free (GLB interiors carry their own local
// transforms). Each shell is tagged `userData.treatmentShell = <kind>` and raycasts as
// nothing, so clicking a rim halo still selects the object underneath. The engine calls
// `syncTreatmentShells` at the end of every object sync; it is keyed so an unchanged
// object costs one string compare per mesh.
import * as THREE from 'three'
import { stripAlpha } from '~/lib/color/convert'
import type { SceneObject } from './config'
import { edgeTreatmentsOf, type Treatment } from './treatments'

/** Layer a surface moves to when a wireframe hides it: invisible to the default camera
 *  (layer 0) but still raycastable — interaction.ts enables this layer on its raycaster
 *  so the invisible surface remains the click target. Layers do NOT cascade to children,
 *  which is what lets the wireframe shell (a child) stay visible while its parent hides. */
export const SURFACE_HIDDEN_LAYER = 30
/** Private layer the treatment stage uses to draw one object alone (treatmentStage.ts). */
export const STAGE_LAYER = 29

export interface ShellSyncOptions { lightView: boolean }

export const isTreatmentShell = (o: THREE.Object3D): boolean => typeof o.userData.treatmentShell === 'string'

/** Meshes this object owns: its own subtree minus other objects' roots (a child object's
 *  root sits INSIDE its parent's subtree since parenting landed), minus shells, minus
 *  editor helpers. */
export function ownMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = []
  const ownId = root.userData.sceneId
  const stack: THREE.Object3D[] = [root]
  while (stack.length) {
    const n = stack.pop()!
    if (n !== root && n.userData.sceneId && n.userData.sceneId !== ownId) continue
    if (isTreatmentShell(n) || n.userData.isGizmoHelper) continue
    if ((n as THREE.Mesh).isMesh) out.push(n as THREE.Mesh)
    for (const c of n.children) stack.push(c)
  }
  return out
}

const noRaycast = (): void => {}

const VIEW_VERT = /* glsl */ `
  varying vec3 vNormal; varying vec3 vView;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`
const RIM_FRAG = /* glsl */ `
  uniform vec3 uColor; uniform float uPower; uniform float uStrength;
  varying vec3 vNormal; varying vec3 vView;
  void main() {
    float f = pow(1.0 - clamp(dot(normalize(vNormal), normalize(vView)), 0.0, 1.0), uPower);
    gl_FragColor = vec4(uColor * uStrength * f, f);
  }`
const OUTLINE_VERT = /* glsl */ `
  uniform float uThickness;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec3 n = normalize(normalMatrix * normal);
    // Push along the view-space normal by an amount proportional to view depth, so the
    // back-face hull reads the same thickness on screen whatever the zoom.
    mv.xyz += n * uThickness * 0.012 * max(-mv.z, 0.05);
    gl_Position = projectionMatrix * mv;
  }`
const OUTLINE_FRAG = /* glsl */ `uniform vec3 uColor; void main() { gl_FragColor = vec4(uColor, 1.0); }`
const XRAY_FRAG = /* glsl */ `
  uniform vec3 uColor; uniform float uOpacity;
  varying vec3 vNormal; varying vec3 vView;
  void main() {
    float f = pow(1.0 - clamp(dot(normalize(vNormal), normalize(vView)), 0.0, 1.0), 2.0);
    gl_FragColor = vec4(uColor, uOpacity * (0.25 + 0.75 * f));
  }`

function rimMaterial(t: Extract<Treatment, { kind: 'rimLight' }>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(stripAlpha(t.color)) },
      uPower: { value: 6 - 4.5 * t.width }, // width 0 → tight edge (6), 1 → broad wash (1.5)
      uStrength: { value: t.strength },
    },
    vertexShader: VIEW_VERT, fragmentShader: RIM_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  })
}
function outlineMaterial(t: Extract<Treatment, { kind: 'outline' }>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(stripAlpha(t.color)) }, uThickness: { value: t.thickness } },
    vertexShader: OUTLINE_VERT, fragmentShader: OUTLINE_FRAG, side: THREE.BackSide,
  })
}
function xrayMaterial(t: Extract<Treatment, { kind: 'xray' }>): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(stripAlpha(t.color)) }, uOpacity: { value: t.opacity } },
    vertexShader: VIEW_VERT, fragmentShader: XRAY_FRAG,
    transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
  })
  // engine.applyObjectOpacities flips `transparent` off at opacity 1; an x-ray drawn in
  // the opaque pass with depthTest off gets overdrawn by everything after it.
  m.userData.keepTransparent = true
  return m
}
function wireMaterial(t: Extract<Treatment, { kind: 'wireframe' }>): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    wireframe: true, color: stripAlpha(t.color), transparent: true, opacity: t.lineOpacity, toneMapped: false,
  })
}

function shellKey(mesh: THREE.Mesh, edges: Treatment[], lightView: boolean): string {
  return `${mesh.geometry.uuid}|${lightView ? 'lv' : ''}|${JSON.stringify(edges)}`
}

function clearShells(mesh: THREE.Mesh): void {
  for (const c of [...mesh.children]) {
    if (!isTreatmentShell(c)) continue
    mesh.remove(c)
    const m = (c as THREE.Mesh).material
    ;(Array.isArray(m) ? m : [m]).forEach((x) => x.dispose()) // geometry is the source's — never ours to dispose
  }
  mesh.layers.enable(0)
  mesh.layers.disable(SURFACE_HIDDEN_LAYER)
  const xm = mesh.userData.xrayMaterial as THREE.Material | undefined
  if (xm) {
    if (mesh.material === xm) mesh.material = mesh.userData.xrayPrev as THREE.Material
    xm.dispose()
    delete mesh.userData.xrayMaterial
    delete mesh.userData.xrayPrev
  }
}

function addShell(mesh: THREE.Mesh, kind: string, material: THREE.Material): void {
  const shell = new THREE.Mesh(mesh.geometry, material)
  shell.userData.treatmentShell = kind
  shell.raycast = noRaycast
  shell.castShadow = false
  shell.receiveShadow = false
  shell.renderOrder = mesh.renderOrder + 1
  mesh.add(shell)
}

/** The engine re-mounts `mesh.material = real` on EVERY sync, so an unchanged x-ray still
 *  has to be put back each time. */
function reapplyXray(mesh: THREE.Mesh, opts: ShellSyncOptions): void {
  const xm = mesh.userData.xrayMaterial as THREE.Material | undefined
  if (!xm || opts.lightView || mesh.material === xm) return
  mesh.userData.xrayPrev = mesh.material
  mesh.material = xm
}

/** Attach/refresh/remove the edge-family shells for one object. Idempotent per mesh. */
export function syncTreatmentShells(root: THREE.Object3D, obj: SceneObject, opts: ShellSyncOptions): void {
  const edges = edgeTreatmentsOf(obj)
  for (const mesh of ownMeshes(root)) {
    const key = shellKey(mesh, edges, opts.lightView)
    if (mesh.userData.treatmentShellKey === key) { reapplyXray(mesh, opts); continue }
    clearShells(mesh)
    mesh.userData.treatmentShellKey = key
    for (const t of edges) {
      if (t.kind === 'rimLight') addShell(mesh, t.kind, rimMaterial(t))
      else if (t.kind === 'outline') addShell(mesh, t.kind, outlineMaterial(t))
      else if (t.kind === 'wireframe') {
        addShell(mesh, t.kind, wireMaterial(t))
        if (!t.showSurface) { mesh.layers.disable(0); mesh.layers.enable(SURFACE_HIDDEN_LAYER) }
      } else if (t.kind === 'xray' && !opts.lightView) {
        const xm = xrayMaterial(t)
        mesh.userData.xrayPrev = mesh.material
        mesh.userData.xrayMaterial = xm
        mesh.material = xm
      }
    }
  }
}

/**
 * For the depth/normal export passes: rim light, outline and wireframe are lighting and
 * ink, not geometry, so their shells hide; a surface a wireframe hid comes back so the
 * model still registers as solid. X-ray needs nothing — `scene.overrideMaterial` replaces
 * it anyway. Returns the restore function; call it in the bake's `finally`.
 */
export function beginDataPassView(scene: THREE.Object3D): () => void {
  const undo: Array<() => void> = []
  scene.traverse((o) => {
    if (isTreatmentShell(o) && o.visible) { o.visible = false; undo.push(() => { o.visible = true }) }
    if (o.layers.isEnabled(SURFACE_HIDDEN_LAYER) && !o.layers.isEnabled(0)) {
      o.layers.enable(0)
      undo.push(() => { o.layers.disable(0) })
    }
  })
  return () => { for (const u of undo) u() }
}
```

- [ ] **Step 4: Run the unit test**

Run: `cd frontend && node_modules/.bin/vitest run tests/unit/scene3d-treatment-shells.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Hook the engine**

In `frontend/app/lib/scene3d/engine.ts`:

(a) Add the import next to the `collectEditorHelpers` import (line ~27):

```ts
import { syncTreatmentShells } from './treatmentShells'
```

(b) In `syncObject`, the GLB placeholder's load callback (line ~908) currently ends with `syncGlbMaterials(root!, (root!.userData.glbObj as GlbObject | undefined) ?? obj, this.lightView, this.clay, this.id)`. Add directly after that line, inside the same `.then`:

```ts
          // The interior meshes only exist now — attach any edge treatments to them.
          syncTreatmentShells(root!, (root!.userData.glbObj as GlbObject | undefined) ?? obj, { lightView: this.lightView })
```

(c) At the END of `syncObject` — after the whole `if (obj.kind === 'primitive') { … } else if (obj.kind === 'glb') { … } else if (obj.kind === 'light') { … } else if (obj.kind === 'decal') { … }` chain closes and before the method's closing brace (the decal branch ends with `void build.finally(…)`; the method's next sibling is the `settleAsyncAssets` doc comment) — add:

```ts
    // Edge-family treatments ride on the object's own meshes. Runs AFTER the material
    // work above (which re-mounts `mesh.material = real` every sync) so an x-ray override
    // is put back on top, and after geometry swaps so a shell never keeps a disposed
    // geometry (its key includes the geometry uuid).
    if (obj.kind === 'primitive' || obj.kind === 'glb') {
      syncTreatmentShells(root, obj, { lightView: this.lightView })
    }
```

Note the decal branch contains early `return`s; those objects are not hosts, so nothing is lost.

(d) In `applyObjectOpacities` (line ~1260), inside the `while (stack.length)` loop, right after `const mesh = n as THREE.Mesh`, add:

```ts
        // Shells carry their own opacity semantics (additive rim, x-ray alpha) — leave them.
        if (mesh.userData.treatmentShell) continue
```

and change the `mm.transparent = o < 1` line to:

```ts
          mm.transparent = o < 1 || mm.userData?.keepTransparent === true
```

- [ ] **Step 6: Keep hidden surfaces clickable**

In `frontend/app/lib/scene3d/interaction.ts`, add the import:

```ts
import { SURFACE_HIDDEN_LAYER } from '~/lib/scene3d/treatmentShells'
```

and as the first statement inside the `constructor(` body (line 180 onward, after the parameter list closes):

```ts
    // A surface hidden by a wireframe treatment moves to this layer (treatmentShells.ts):
    // invisible, but still the thing you click to select the object.
    this.raycaster.layers.enable(SURFACE_HIDDEN_LAYER)
```

- [ ] **Step 7: Data passes hide shells**

In `frontend/app/lib/scene3d/passes.ts`:

```ts
import { beginDataPassView } from './treatmentShells'
```

Inside `renderPasses`, declare `let restoreDataView: (() => void) | null = null` next to `let dmat`/`let nmat`. After `const beauty = canvas.toDataURL('image/png')` and before the `// Data passes must be raw` comment, add:

```ts
    // Rim/outline/wireframe shells are not geometry; a wireframe-hidden surface is.
    restoreDataView = beginDataPassView(engine.scene)
```

In the `finally` block, add `restoreDataView?.()` before `renderer.toneMapping = prevToneMapping`.

- [ ] **Step 8: Run the engine and passes specs**

Run: `cd frontend && node_modules/.bin/vitest run tests/unit/scene3d-engine.unit.spec.ts tests/unit/scene3d-passes.unit.spec.ts tests/unit/scene3d-treatment-shells.unit.spec.ts tests/unit/scene3d-decals.unit.spec.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/lib/scene3d/treatmentShells.ts frontend/app/lib/scene3d/engine.ts frontend/app/lib/scene3d/interaction.ts frontend/app/lib/scene3d/passes.ts frontend/tests/unit/scene3d-treatment-shells.unit.spec.ts
git commit -m "feat(scene3d): rim light, outline, x-ray and wireframe as per-object shells

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Masked family — PostChain texture input, `TreatmentStage`, engine render path

**Files:**
- Modify: `frontend/app/lib/spacetype/post.ts` (`PostChain`: new `TexturePass`, `setInputTexture`, dispose)
- Create: `frontend/app/lib/scene3d/treatmentStage.ts`
- Modify: `frontend/app/lib/scene3d/engine.ts` (`renderWithPost` ~line 1196; new fields; `dispose`; new `snapshot()`)
- Test: `frontend/tests/unit/scene3d-treatment-stage.unit.spec.ts` (pure helpers only — the GPU path is verified in Task 9)

**Interfaces:**
- Consumes: `MaskedGroup`, `maskedTreatmentPlan` (Task 1); `STAGE_LAYER`, `SURFACE_HIDDEN_LAYER` (Task 5); `collectEditorHelpers` (existing); `PostChain` (existing).
- Produces:
  - `PostChain.setInputTexture(tex: THREE.Texture | null): void` — non-null: the composer starts from `tex` (a `TexturePass`) instead of drawing the scene; null: back to the `RenderPass`.
  - `class TreatmentStage { constructor(renderer: THREE.WebGLRenderer); render(scene, camera, plan: MaskedGroup[], ctx: { objectRoots: Map<string, THREE.Object3D> }): THREE.Texture; readonly stats: { frames: number; groups: number; width: number; height: number }; dispose(): void }`
  - pure helpers exported for tests: `blurPasses(amount: number, height: number): { passes: number; step: number; radiusPx: number }`, `STAGE_SAMPLES = 4`
  - `SceneEngine.treatmentStats: { frames: number; groups: number }` (frames the composer path ran with the stage; groups drawn last frame)
  - `SceneEngine.snapshot(): string` — renders one frame synchronously and returns the canvas PNG data URL (test instrument; `preserveDrawingBuffer` is already on).

- [ ] **Step 1: Write the failing test for the pure helper**

Create `frontend/tests/unit/scene3d-treatment-stage.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { blurPasses } from '~/lib/scene3d/treatmentStage'

describe('blurPasses', () => {
  it('scales the radius with amount and image height', () => {
    expect(blurPasses(0, 1000).radiusPx).toBe(0)
    expect(blurPasses(0.5, 1000).radiusPx).toBeCloseTo(30)
    expect(blurPasses(1, 500).radiusPx).toBeCloseTo(30)
  })
  it('splits a large radius into up to four separable pass pairs so taps never leave gaps', () => {
    const small = blurPasses(0.1, 1000) // 6px
    expect(small.passes).toBe(1)
    expect(small.step * 12).toBeCloseTo(6)
    const big = blurPasses(1, 1000) // 60px
    expect(big.passes).toBeGreaterThan(1)
    expect(big.passes).toBeLessThanOrEqual(4)
    expect(big.step * 12 * big.passes).toBeCloseTo(60)
    expect(big.step).toBeLessThanOrEqual(1.5)
  })
  it('a zero amount asks for zero passes', () => {
    expect(blurPasses(0, 1000).passes).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && node_modules/.bin/vitest run tests/unit/scene3d-treatment-stage.unit.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Give `PostChain` a texture input**

In `frontend/app/lib/spacetype/post.ts`:

Add the import next to the other pass imports:

```ts
import { TexturePass } from 'three/examples/jsm/postprocessing/TexturePass.js'
```

Add a field after `private renderPass: RenderPass`:

```ts
  /** Alternative FIRST pass: copies an already-rendered texture into the chain instead of
   *  drawing the scene — Scene3D's treatment stage hands its composited frame in here so
   *  global bloom/grade/OutputPass run over it unchanged. Disabled unless `setInputTexture`
   *  gave it a texture. */
  private texturePass: TexturePass
```

In the constructor, right after `this.renderPass = new RenderPass(scene, camera)`:

```ts
    this.texturePass = new TexturePass(null as unknown as THREE.Texture)
    this.texturePass.enabled = false
```

and in the `addPass` list, right after `this.composer.addPass(this.renderPass)`:

```ts
    this.composer.addPass(this.texturePass)
```

Add the method before `render(scene, camera)`:

```ts
  /** Start the chain from `tex` (renderPass off) or, with null, from the live scene again. */
  setInputTexture(tex: THREE.Texture | null): void {
    this.texturePass.map = tex as THREE.Texture
    this.texturePass.enabled = !!tex
    this.renderPass.enabled = !tex
  }
```

In `dispose()`, add `this.texturePass.dispose()` after `this.composer.dispose()`.

- [ ] **Step 4: Create `frontend/app/lib/scene3d/treatmentStage.ts`**

```ts
// The masked family (blur, glow, pixelate, fade) — design spec §3.
//
// Per frame: the BASE scene renders with every treated object hidden (colour + depth);
// each rendered MaskedGroup then draws its object ALONE — via a private camera layer, so a
// child object parented under a treated mesh, or a mesh parented under a group, still
// draws exactly once — into a transparent layer buffer with its own depth; 2D passes treat
// that buffer (blur spreads colour AND alpha past the silhouette, pixelate chunks the edge);
// a depth-tested composite lays it back over the base. "Everything else" swaps the roles:
// base = the object alone (with background), layer = the rest. The result feeds PostChain
// through `setInputTexture`, so global post and the export bake see the same frame.
//
// Never write renderer state you do not restore: this runs inside the live loop AND the
// output-resolution bake, both of which assume the renderer comes back as they left it.
import * as THREE from 'three'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'
import { stripAlpha } from '~/lib/color/convert'
import type { MaskedGroup, Treatment } from './treatments'
import { STAGE_LAYER } from './treatmentShells'

/** MSAA samples on the base/layer targets. three ≥ r165 resolves a multisampled target's
 *  depth into its `depthTexture` (`resolveDepthBuffer`, default true), which the composite
 *  reads. If a driver ever hands back an all-1.0 depth here, drop this to 0 and re-verify
 *  the Task 9 screenshots — edges will alias but occlusion returns. */
export const STAGE_SAMPLES = 4
const TAPS = 12 // taps per side per separable pass
const MAX_PAIRS = 4

export interface StageContext { objectRoots: Map<string, THREE.Object3D> }
export interface StageStats { frames: number; groups: number; width: number; height: number }

/** How to realise a blur of `amount` (0–1) on an image `height` px tall: `radiusPx` of
 *  reach, split into `passes` H+V pairs whose taps sit `step` px apart. Pure. */
export function blurPasses(amount: number, height: number): { passes: number; step: number; radiusPx: number } {
  const radiusPx = Math.max(0, amount) * 0.06 * height
  if (radiusPx <= 0) return { passes: 0, step: 0, radiusPx: 0 }
  const passes = Math.min(MAX_PAIRS, Math.max(1, Math.ceil(radiusPx / TAPS)))
  return { passes, step: radiusPx / (passes * TAPS), radiusPx }
}

const VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }'
const COPY_FRAG = 'uniform sampler2D tDiffuse; varying vec2 vUv; void main(){ gl_FragColor = texture2D(tDiffuse, vUv); }'
// Separable Gaussian over PREMULTIPLIED colour so transparent pixels never darken the halo;
// un-premultiplied on the way out because the layer buffers are straight-alpha.
const BLUR_FRAG = `
  uniform sampler2D tDiffuse; uniform vec2 uDir;
  varying vec2 vUv;
  void main(){
    vec4 acc = vec4(0.0); float wsum = 0.0;
    for (int i = -${TAPS}; i <= ${TAPS}; i++) {
      float w = exp(-float(i * i) / 72.0);
      vec4 s = texture2D(tDiffuse, vUv + uDir * float(i));
      acc += vec4(s.rgb * s.a, s.a) * w; wsum += w;
    }
    acc /= wsum;
    gl_FragColor = vec4(acc.a > 1e-5 ? acc.rgb / acc.a : vec3(0.0), acc.a);
  }`
const PIXELATE_FRAG = `
  uniform sampler2D tDiffuse; uniform vec2 uResolution; uniform float uCell;
  varying vec2 vUv;
  void main(){
    vec2 cell = vec2(uCell) / uResolution;
    vec2 uv = (floor(vUv / cell) + 0.5) * cell;
    gl_FragColor = texture2D(tDiffuse, uv);
  }`
const BRIGHT_FRAG = `
  uniform sampler2D tDiffuse; uniform float uThreshold;
  varying vec2 vUv;
  void main(){
    vec4 s = texture2D(tDiffuse, vUv);
    float l = dot(s.rgb, vec3(0.2126, 0.7152, 0.0722));
    float k = smoothstep(uThreshold, uThreshold + 0.2, l) * s.a;
    gl_FragColor = vec4(s.rgb, k);
  }`
const GLOW_MERGE_FRAG = `
  uniform sampler2D tBase; uniform sampler2D tGlow; uniform vec3 uTint; uniform float uStrength;
  varying vec2 vUv;
  void main(){
    vec4 b = texture2D(tBase, vUv);
    vec4 g = texture2D(tGlow, vUv);
    vec3 add = g.rgb * g.a * uTint * uStrength;
    float a = max(b.a, g.a * clamp(uStrength, 0.0, 1.0));
    vec3 rgb = (b.rgb * b.a + add) / max(a, 1e-5);
    gl_FragColor = vec4(rgb, a);
  }`
// Depth-tested composite. Halo pixels (blur/glow spill) have no depth of their own, so they
// borrow the nearest opaque depth within uHaloRadius texels — spec §3 step 2c.
const COMPOSITE_FRAG = `
  uniform sampler2D tLayer; uniform sampler2D tLayerDepth; uniform sampler2D tBaseDepth;
  uniform float uOpacity; uniform vec2 uTexel; uniform float uHaloRadius;
  varying vec2 vUv;
  float nearestDepth(vec2 uv){
    float d = texture2D(tLayerDepth, uv).r;
    if (d < 1.0) return d;
    float best = 1.0;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.785398;
      vec2 o = vec2(cos(a), sin(a)) * uTexel * uHaloRadius;
      best = min(best, texture2D(tLayerDepth, uv + o).r);
      best = min(best, texture2D(tLayerDepth, uv + o * 0.5).r);
    }
    return best;
  }
  void main(){
    vec4 s = texture2D(tLayer, vUv);
    float a = s.a * uOpacity;
    if (a <= 0.001) discard;
    float ld = nearestDepth(vUv);
    float bd = texture2D(tBaseDepth, vUv).r;
    if (ld > bd + 0.00005) discard;
    gl_FragColor = vec4(s.rgb * a, a); // premultiplied — see compositeMat's blend factors
  }`

type RT = THREE.WebGLRenderTarget

function shader(frag: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: frag, depthTest: false, depthWrite: false })
}

export class TreatmentStage {
  readonly stats: StageStats = { frames: 0, groups: 0, width: 0, height: 0 }
  private base!: RT
  private layer!: RT
  private out!: RT
  private scratch: RT[] = []
  private width = 0
  private height = 0
  private readonly quad = new FullScreenQuad()
  private readonly copyMat = shader(COPY_FRAG, { tDiffuse: { value: null } })
  private readonly blurMat = shader(BLUR_FRAG, { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() } })
  private readonly pixelateMat = shader(PIXELATE_FRAG, { tDiffuse: { value: null }, uResolution: { value: new THREE.Vector2(1, 1) }, uCell: { value: 8 } })
  private readonly brightMat = shader(BRIGHT_FRAG, { tDiffuse: { value: null }, uThreshold: { value: 0.6 } })
  private readonly glowMergeMat = shader(GLOW_MERGE_FRAG, { tBase: { value: null }, tGlow: { value: null }, uTint: { value: new THREE.Color(1, 1, 1) }, uStrength: { value: 1 } })
  private readonly compositeMat: THREE.ShaderMaterial
  private readonly tmpSize = new THREE.Vector2()
  private readonly prevClearColor = new THREE.Color()

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.compositeMat = shader(COMPOSITE_FRAG, {
      tLayer: { value: null }, tLayerDepth: { value: null }, tBaseDepth: { value: null },
      uOpacity: { value: 1 }, uTexel: { value: new THREE.Vector2() }, uHaloRadius: { value: 2 },
    })
    // Premultiplied "over": the shader multiplies rgb by alpha itself.
    this.compositeMat.transparent = true
    this.compositeMat.blending = THREE.CustomBlending
    this.compositeMat.blendSrc = THREE.OneFactor
    this.compositeMat.blendDst = THREE.OneMinusSrcAlphaFactor
    this.compositeMat.blendSrcAlpha = THREE.OneFactor
    this.compositeMat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor
  }

  private makeTarget(w: number, h: number, withDepth: boolean): RT {
    const samples = Math.min(STAGE_SAMPLES, this.renderer.capabilities.maxSamples)
    const rt = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, depthBuffer: withDepth, stencilBuffer: false, samples: withDepth ? samples : 0,
    })
    if (withDepth) rt.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType)
    return rt
  }

  private ensureSize(w: number, h: number): void {
    if (w === this.width && h === this.height) return
    this.disposeTargets()
    this.width = w; this.height = h
    this.base = this.makeTarget(w, h, true)
    this.layer = this.makeTarget(w, h, true)
    this.out = this.makeTarget(w, h, false)
    this.scratch = [0, 1, 2].map(() => this.makeTarget(w, h, false))
    this.pixelateMat.uniforms.uResolution!.value.set(w, h)
    this.compositeMat.uniforms.uTexel!.value.set(1 / w, 1 / h)
    this.stats.width = w; this.stats.height = h
  }

  private disposeTargets(): void {
    for (const rt of [this.base, this.layer, this.out, ...this.scratch]) {
      if (!rt) continue
      rt.depthTexture?.dispose()
      rt.dispose()
    }
    this.scratch = []
  }

  /** A scratch target that is none of `used`. Three scratches guarantee one is always free. */
  private free(...used: RT[]): RT {
    const rt = this.scratch.find((s) => !used.includes(s))
    if (!rt) throw new Error('TreatmentStage: no free scratch target')
    return rt
  }

  private pass(mat: THREE.ShaderMaterial, to: RT | null): void {
    this.renderer.setRenderTarget(to)
    this.quad.material = mat
    this.quad.render(this.renderer)
  }

  private blit(tex: THREE.Texture, to: RT): void {
    this.copyMat.uniforms.tDiffuse!.value = tex
    this.pass(this.copyMat, to)
  }

  /** Separable blur of `src` by `radius` px. Returns the target holding the result (never `src`). */
  private blur(src: RT, amount: number, ...reserve: RT[]): { rt: RT; radiusPx: number } {
    const { passes, step, radiusPx } = blurPasses(amount, this.height)
    if (passes === 0) return { rt: src, radiusPx: 0 }
    const a = this.free(src, ...reserve)
    // When `src` is itself a scratch (a previous effect's output, or glow's bright pass) it
    // is free to be overwritten once the first horizontal pass has read it — reusing it as
    // the second ping-pong target keeps three scratches enough for every combination.
    const b = this.scratch.includes(src) ? src : this.free(src, a, ...reserve)
    let cur = src
    for (let i = 0; i < passes; i++) {
      this.blurMat.uniforms.tDiffuse!.value = cur.texture
      this.blurMat.uniforms.uDir!.value.set(step / this.width, 0)
      this.pass(this.blurMat, a)
      this.blurMat.uniforms.tDiffuse!.value = a.texture
      this.blurMat.uniforms.uDir!.value.set(0, step / this.height)
      this.pass(this.blurMat, b)
      cur = b
    }
    return { rt: cur, radiusPx }
  }

  /** Apply one masked treatment to `src`; returns the target with the result and the halo
   *  reach it introduced (px). Fade is handled by the caller as a composite opacity. */
  private applyEffect(src: RT, t: Treatment): { rt: RT; haloPx: number } {
    if (t.kind === 'blur') {
      const { rt, radiusPx } = this.blur(src, t.amount)
      return { rt, haloPx: radiusPx }
    }
    if (t.kind === 'pixelate') {
      const dst = this.free(src)
      this.pixelateMat.uniforms.tDiffuse!.value = src.texture
      this.pixelateMat.uniforms.uCell!.value = Math.max(1, t.cellSize * this.renderer.getPixelRatio())
      this.pass(this.pixelateMat, dst)
      return { rt: dst, haloPx: t.cellSize }
    }
    if (t.kind === 'glow') {
      const bright = this.free(src)
      this.brightMat.uniforms.tDiffuse!.value = src.texture
      this.brightMat.uniforms.uThreshold!.value = t.threshold
      this.pass(this.brightMat, bright)
      const spread = 0.5 * (0.5 + 0.5 * Math.min(2, t.strength)) // 0.25–0.75 of the blur scale
      const { rt: glow, radiusPx } = this.blur(bright, spread, src)
      const dst = this.free(src, glow)
      this.glowMergeMat.uniforms.tBase!.value = src.texture
      this.glowMergeMat.uniforms.tGlow!.value = glow.texture
      ;(this.glowMergeMat.uniforms.uTint!.value as THREE.Color).set(stripAlpha(t.tint))
      this.glowMergeMat.uniforms.uStrength!.value = t.strength
      this.pass(this.glowMergeMat, dst)
      return { rt: dst, haloPx: radiusPx }
    }
    return { rt: src, haloPx: 0 }
  }

  /** Draw `root`'s subtree alone into `target` via the private layer. Subtrees of OTHER
   *  treated roots are left out (their own group draws them); hidden surfaces (no layer 0)
   *  and editor helpers stay out. `background` null ⇒ transparent clear. */
  private drawAlone(
    scene: THREE.Scene, camera: THREE.Camera, root: THREE.Object3D, treatedRoots: THREE.Object3D[],
    target: RT, background: THREE.Scene['background'],
  ): void {
    const touched: THREE.Object3D[] = []
    const stack: THREE.Object3D[] = [root]
    while (stack.length) {
      const o = stack.pop()!
      if (o !== root && treatedRoots.includes(o)) continue
      if (o.layers.isEnabled(0) && !o.userData.isGizmoHelper) { o.layers.enable(STAGE_LAYER); touched.push(o) }
      for (const c of o.children) stack.push(c)
    }
    const prevMask = camera.layers.mask
    const prevBg = scene.background
    try {
      camera.layers.set(STAGE_LAYER)
      scene.background = background
      this.renderer.setRenderTarget(target)
      this.renderer.setClearColor(0x000000, 0)
      this.renderer.clear()
      this.renderer.render(scene, camera)
    } finally {
      camera.layers.mask = prevMask
      scene.background = prevBg
      for (const o of touched) o.layers.disable(STAGE_LAYER)
    }
  }

  private composite(layerTex: THREE.Texture, opacity: number, haloPx: number): void {
    const u = this.compositeMat.uniforms
    u.tLayer!.value = layerTex
    u.tLayerDepth!.value = this.layer.depthTexture
    u.tBaseDepth!.value = this.base.depthTexture
    u.uOpacity!.value = opacity
    u.uHaloRadius!.value = Math.max(2, haloPx)
    this.pass(this.compositeMat, this.out)
  }

  render(scene: THREE.Scene, camera: THREE.Camera, plan: MaskedGroup[], ctx: StageContext): THREE.Texture {
    const r = this.renderer
    const size = r.getDrawingBufferSize(this.tmpSize)
    this.ensureSize(size.x, size.y)
    const groups = plan.filter((g) => g.rendered && ctx.objectRoots.has(g.objectId))
    const treatedRoots = groups.map((g) => ctx.objectRoots.get(g.objectId)!)
    const invertGroup = groups.find((g) => g.invert)

    // Lights must be on the stage layer to light an isolated draw; layers.test is any-overlap
    // so leaving the bit set is harmless for the normal layer-0 render.
    scene.traverse((o) => { if ((o as THREE.Light).isLight) o.layers.enable(STAGE_LAYER) })

    const prevTarget = r.getRenderTarget()
    const prevAutoClear = r.autoClear
    const prevClearAlpha = r.getClearAlpha()
    r.getClearColor(this.prevClearColor)
    const prevBackground = scene.background
    const prevVis = new Map<THREE.Object3D, boolean>()
    const hide = (o: THREE.Object3D): void => { if (!prevVis.has(o)) prevVis.set(o, o.visible); o.visible = false }
    const unhideAll = (): void => { for (const [o, v] of prevVis) o.visible = v; prevVis.clear() }
    try {
      r.autoClear = true
      // 1. Base: everything but the treated objects — or, inverted, the inverted object alone.
      if (invertGroup) {
        this.drawAlone(scene, camera, ctx.objectRoots.get(invertGroup.objectId)!, treatedRoots, this.base, prevBackground)
      } else {
        for (const root of treatedRoots) hide(root)
        r.setRenderTarget(this.base)
        r.setClearColor(0x000000, 0)
        r.clear()
        r.render(scene, camera)
        unhideAll()
      }
      this.blit(this.base.texture, this.out)
      // 2. One layer per group, composited in stack order.
      for (const g of groups) {
        const root = ctx.objectRoots.get(g.objectId)!
        if (g.invert) {
          for (const o of treatedRoots) hide(o) // this object AND the other treated ones (their own groups draw them)
          scene.background = null
          r.setRenderTarget(this.layer)
          r.setClearColor(0x000000, 0)
          r.clear()
          r.render(scene, camera)
          scene.background = prevBackground
          unhideAll()
        } else {
          this.drawAlone(scene, camera, root, treatedRoots, this.layer, null)
        }
        let src: RT = this.layer
        let opacity = 1
        let halo = 0
        for (const t of g.treatments) {
          if (t.kind === 'fade') { opacity *= t.opacity; continue }
          const res = this.applyEffect(src, t)
          src = res.rt
          halo = Math.max(halo, res.haloPx)
        }
        this.composite(src.texture, opacity, halo)
      }
    } finally {
      unhideAll()
      scene.background = prevBackground
      r.setClearColor(this.prevClearColor, prevClearAlpha)
      r.autoClear = prevAutoClear
      r.setRenderTarget(prevTarget)
    }
    this.stats.frames++
    this.stats.groups = groups.length
    return this.out.texture
  }

  dispose(): void {
    this.disposeTargets()
    for (const m of [this.copyMat, this.blurMat, this.pixelateMat, this.brightMat, this.glowMergeMat, this.compositeMat]) m.dispose()
    this.quad.dispose()
  }
}
```

- [ ] **Step 5: Route the engine's render through the stage**

In `frontend/app/lib/scene3d/engine.ts`:

(a) Imports (next to the Task 5 import):

```ts
import { TreatmentStage } from './treatmentStage'
import { maskedTreatmentPlan } from './treatments'
```

(b) Fields, next to `private postChain` (search `postChain: PostChain | null`):

```ts
  private treatmentStage: TreatmentStage | null = null
  /** Test instrument (surface exposes it as window.__scene3dTreatmentStats): how many frames
   *  ran through the composer WITH the stage, and how many groups the last one drew. */
  readonly treatmentStats = { frames: 0, groups: 0 }
```

(c) Replace `renderWithPost` from its signature through the line `finally { for (const h of helpers) h.visible = true }` (i.e. the signature, the `postEnabled` early return, the chain construction, the helper comment, the `if (!helpers.length) { … return }` line, the hide loop and the try/finally) with the block below. Keep everything from `const camMask = camera.layers.mask` onward — the gizmo overlay — exactly as it is:

```ts
  renderWithPost(scene: THREE.Scene, camera: THREE.Camera, post: PostSettings, elapsedSec = 0): void {
    // Per-object masked treatments (blur/glow/pixelate/fade) need the composer path even
    // with every global effect off: the stage's composite is a texture, and only the
    // composer's OutputPass tone-maps a texture to the canvas.
    const plan = this.lastDoc ? maskedTreatmentPlan(this.lastDoc) : []
    const stageGroups = plan.filter((g) => g.rendered).length
    if (!postEnabled(post) && stageGroups === 0) { this.renderer.render(scene, camera); return }
    const s = this.renderer.getSize(new THREE.Vector2())
    if (!this.postChain) { this.postChain = new PostChain(this.renderer, scene, camera, s.x, s.y); this.postW = s.x; this.postH = s.y }
    else if (this.postW !== s.x || this.postH !== s.y) { this.postChain.setSize(s.x, s.y); this.postW = s.x; this.postH = s.y }
    this.postChain.setSettings(post, elapsedSec)
    // Editor gizmos share engine.scene, so they'd otherwise flow through the post
    // chain and pick up bloom/grade (a glowing transform handle). Hide them for the
    // composited pass, then overlay them un-post-processed. The overlay renders only
    // the gizmo by parking it on a private layer the composer camera never sees — a
    // whole-scene re-render would paint crisp geometry back over the bloom halos.
    // The layer swap is bracketed by this synchronous render, and TransformControls
    // picks against layer 0 only on pointer events (which never interleave with a
    // render frame), so dragging is unaffected.
    const helpers = collectEditorHelpers(scene)
    for (const h of helpers) h.visible = false
    try {
      if (stageGroups > 0) {
        if (!this.treatmentStage) this.treatmentStage = new TreatmentStage(this.renderer)
        this.postChain.setInputTexture(this.treatmentStage.render(scene, camera, plan, { objectRoots: this.objectRoots }))
        this.treatmentStats.frames++
      } else {
        this.postChain.setInputTexture(null)
      }
      this.treatmentStats.groups = stageGroups
      this.postChain.render(scene, camera)
    } finally { for (const h of helpers) h.visible = true }
    if (!helpers.length) return
```

(The original returned early when there were no helpers; the new version always brackets the render so the stage never sees a light marker, and returns after the bracket when there is nothing to overlay. Everything from `const camMask = camera.layers.mask` onward is unchanged.)

(d) Add the instrument method right after `render(elapsedSec = 0)`:

```ts
  /** Render one frame NOW and return the canvas as a PNG data URL. A test instrument
   *  (surface: window.__scene3dSnapshot) — synchronous on purpose so the read happens in
   *  the same task as the draw (preserveDrawingBuffer is on regardless). */
  snapshot(): string {
    this.render(0)
    return (this.renderer.domElement as HTMLCanvasElement).toDataURL('image/png')
  }
```

(e) In `dispose()`, next to where `this.postChain?.dispose()` happens (search `postChain?.dispose` — if the chain is disposed elsewhere, add beside it), add:

```ts
    this.treatmentStage?.dispose()
    this.treatmentStage = null
```

- [ ] **Step 6: Run the unit tests and a compile check**

Run: `cd frontend && node_modules/.bin/vitest run tests/unit/scene3d-treatment-stage.unit.spec.ts tests/unit/scene3d-engine.unit.spec.ts tests/unit/scene3d-passes.unit.spec.ts`
Expected: PASS.

Run: `cd frontend && node_modules/.bin/nuxt typecheck 2>&1 | grep -E "treatmentStage|treatmentShells|treatments\.ts|treatmentControls|spacetype/post\.ts|scene3d/engine\.ts" ; echo "exit=$?"`
Expected: no lines printed for the new files (grep exit 1). Any error on `engine.ts` must be a NEW line referencing `treatment`/`TexturePass`/`snapshot` — pre-existing errors elsewhere in the file are not this task's.

- [ ] **Step 7: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/lib/spacetype/post.ts frontend/app/lib/scene3d/treatmentStage.ts frontend/app/lib/scene3d/engine.ts frontend/tests/unit/scene3d-treatment-stage.unit.spec.ts
git commit -m "feat(scene3d): treatment stage renders blur/glow/pixelate/fade per object

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Tree UI — treatment rows and the add menu

**Files:**
- Create: `frontend/app/components/vue-canvas/studio/Scene3DTreatmentRow.vue`
- Modify: `frontend/app/components/vue-canvas/studio/Scene3DObjectRow.vue`

**Interfaces:**
- Consumes: `Treatment`, `TreatmentKind`, `TREATMENT_KINDS`, `TREATMENT_LABELS`, `treatmentsOf`, `isTreatmentHost` (Task 1); lucide icons `Plus, Droplets, Sparkles, Grid3x3, Ghost, Sun, Square, Scan, Hexagon, Eye, EyeOff, Copy, Trash2` (all exist in lucide-vue-next 0.576).
- Produces:
  - `Scene3DTreatmentRow` props `{ treatment: Treatment; objectId: string; depth: number; selected: boolean; notRendered: boolean }`, emits `select | remove | duplicate | toggleEnabled` each `[objectId: string, treatmentId: string]`, plus `dragStart` and `dropOn` with the same payload. Root element: `data-testid="treatment-row"`, `data-treatment-id`, `data-treatment-kind`, `data-object-id`.
  - `Scene3DObjectRow` gains props `selectedTreatment: { objectId: string; treatmentId: string } | null` and `notRendered: Set<string>`, and emits `addTreatment: [objectId: string, kind: TreatmentKind]`, `selectTreatment | removeTreatment | duplicateTreatment | toggleTreatment: [objectId: string, treatmentId: string]`, `reorderTreatment: [objectId: string, fromId: string, toId: string]`. The plus button is `data-testid="add-treatment"`; each menu item is `data-testid="add-treatment-item"` with `data-kind`.

- [ ] **Step 1: Create `Scene3DTreatmentRow.vue`**

Two script blocks: a plain `<script lang="ts">` for the named export (a `<script setup>` cannot export), then the setup block.

```vue
<script lang="ts">
import type { Component } from 'vue'
import { Droplets, Sparkles, Grid3x3, Ghost, Sun, Square, Scan, Hexagon } from 'lucide-vue-next'
import type { TreatmentKind } from '~/lib/scene3d/treatments'
/** Shared with the object row's add menu so a kind has ONE icon everywhere. */
export const TREATMENT_ICONS: Record<TreatmentKind, Component> = {
  blur: Droplets, glow: Sparkles, pixelate: Grid3x3, fade: Ghost,
  rimLight: Sun, outline: Square, xray: Scan, wireframe: Hexagon,
}
</script>

<script setup lang="ts">
// One treatment row under its object in the Objects tree (design spec §2). A pseudo-child:
// it is NOT a scene object, so selection, delete and duplicate are routed to the surface's
// treatment handlers, never the object ones. Drag-and-drop reorders within the parent's
// list only — the parent row decides whether a drop is legal.
import { Eye, EyeOff, Copy, Trash2 } from 'lucide-vue-next'
import { TREATMENT_LABELS, type Treatment } from '~/lib/scene3d/treatments'

defineProps<{
  treatment: Treatment
  objectId: string
  depth: number
  selected: boolean
  /** True when this frame's plan skipped the treatment (cap or second inversion). */
  notRendered: boolean
}>()
const emit = defineEmits<{
  select: [objectId: string, treatmentId: string]
  remove: [objectId: string, treatmentId: string]
  duplicate: [objectId: string, treatmentId: string]
  toggleEnabled: [objectId: string, treatmentId: string]
  dragStart: [objectId: string, treatmentId: string]
  dropOn: [objectId: string, treatmentId: string]
}>()
</script>

<template>
  <div class="group flex items-center gap-2 rounded px-2 py-1 text-xs"
    data-testid="treatment-row" :data-treatment-id="treatment.id" :data-treatment-kind="treatment.kind" :data-object-id="objectId"
    :class="[selected ? 'bg-white/15' : 'hover:bg-white/5', treatment.enabled ? '' : 'opacity-50']"
    :style="{ paddingLeft: `${8 + depth * 12}px` }"
    draggable="true"
    @click.stop="emit('select', objectId, treatment.id)"
    @dragstart="emit('dragStart', objectId, treatment.id)"
    @dragover.prevent
    @drop.prevent="emit('dropOn', objectId, treatment.id)">
    <span class="w-2 shrink-0" />
    <component :is="TREATMENT_ICONS[treatment.kind]" class="h-3.5 w-3.5 shrink-0 opacity-60" />
    <span class="flex-1 truncate">{{ TREATMENT_LABELS[treatment.kind] }}</span>
    <span v-if="notRendered" data-testid="treatment-not-rendered"
      class="shrink-0 text-[10px] text-amber-300/80"
      title="Too many treated objects this frame, or a second Everything else — this one is not drawn">Not rendered</span>
    <button type="button" :class="treatment.enabled ? 'opacity-0 group-hover:opacity-70' : 'opacity-70'"
      :aria-label="treatment.enabled ? 'Hide treatment' : 'Show treatment'"
      @click.stop="emit('toggleEnabled', objectId, treatment.id)">
      <component :is="treatment.enabled ? Eye : EyeOff" class="h-3.5 w-3.5" />
    </button>
    <button type="button" class="opacity-0 group-hover:opacity-70" aria-label="Duplicate treatment"
      @click.stop="emit('duplicate', objectId, treatment.id)"><Copy class="h-3.5 w-3.5" /></button>
    <button type="button" class="opacity-0 group-hover:opacity-70" aria-label="Remove treatment"
      @click.stop="emit('remove', objectId, treatment.id)"><Trash2 class="h-3.5 w-3.5" /></button>
  </div>
</template>
```

- [ ] **Step 2: Extend `Scene3DObjectRow.vue`**

Replace the file with:

```vue
<script setup lang="ts">
// One object-list row plus its subtree. Recursive (`Scene3DObjectRow` refers to
// itself by name), which is why this is a real component rather than more
// markup inside the surface.
//
// Treatments (design spec §2) render as PSEUDO-children between the object row and
// its real children: they are entries of `object.treatments`, not scene objects, so
// every treatment event is a separate emit the surface routes to its own handlers.
import { computed, ref, onBeforeUnmount } from 'vue'
import { Box, Lightbulb, Folder, Sticker, ChevronRight, ChevronDown, Eye, EyeOff, Copy, Trash2, RotateCcw, Plus } from 'lucide-vue-next'
import type { SceneObject } from '~/lib/scene3d/config'
import { childrenOf } from '~/lib/scene3d/hierarchy'
import { TREATMENT_KINDS, TREATMENT_LABELS, treatmentsOf, isTreatmentHost, type TreatmentKind } from '~/lib/scene3d/treatments'
import Scene3DTreatmentRow, { TREATMENT_ICONS } from './Scene3DTreatmentRow.vue'

const props = defineProps<{
  object: SceneObject
  objects: SceneObject[]
  selectedIds: string[]
  glbError: Record<string, boolean>
  depth: number
  selectedTreatment: { objectId: string; treatmentId: string } | null
  /** Treatment ids the current frame's plan skipped (treatments.ts unrenderedTreatmentIds). */
  notRendered: Set<string>
}>()
const emit = defineEmits<{
  select: [id: string, additive: boolean]
  remove: [id: string]
  duplicate: [id: string]
  retry: [id: string]
  toggleVisible: [id: string]
  addTreatment: [objectId: string, kind: TreatmentKind]
  selectTreatment: [objectId: string, treatmentId: string]
  removeTreatment: [objectId: string, treatmentId: string]
  duplicateTreatment: [objectId: string, treatmentId: string]
  toggleTreatment: [objectId: string, treatmentId: string]
  reorderTreatment: [objectId: string, fromId: string, toId: string]
}>()

const children = computed(() => childrenOf(props.objects, props.object.id))
const treatments = computed(() => treatmentsOf(props.object))
const canHost = computed(() => isTreatmentHost(props.object))
// Expand state is LOCAL UI state on purpose: persisting it would dirty the
// document on a disclosure click and sync a cosmetic toggle across windows.
const expanded = ref(true)
const icon = computed(() =>
  props.object.kind === 'light' ? Lightbulb
  : props.object.kind === 'group' ? Folder
  : props.object.kind === 'decal' ? Sticker
  : Box)

// ── Add-treatment menu. Teleported to body: the Objects list scrolls (overflow-y-auto),
// which would clip an absolutely positioned popover. Closes on any outside pointerdown.
const menuOpen = ref(false)
const menuPos = ref({ top: 0, left: 0 })
const addBtn = ref<HTMLButtonElement | null>(null)
function onOutside(e: PointerEvent): void {
  const t = e.target as HTMLElement | null
  if (t?.closest('[data-treatment-menu]') || t === addBtn.value) return
  closeMenu()
}
function openMenu(): void {
  const r = addBtn.value?.getBoundingClientRect()
  if (r) menuPos.value = { top: r.bottom + 4, left: r.left }
  menuOpen.value = true
  document.addEventListener('pointerdown', onOutside, true)
}
function closeMenu(): void {
  menuOpen.value = false
  document.removeEventListener('pointerdown', onOutside, true)
}
function pick(kind: TreatmentKind): void {
  emit('addTreatment', props.object.id, kind)
  closeMenu()
}
onBeforeUnmount(closeMenu)

// ── Drag-reorder within THIS object's treatment list only.
const dragFrom = ref<string | null>(null)
function onDragStart(objectId: string, treatmentId: string): void { dragFrom.value = objectId === props.object.id ? treatmentId : null }
function onDropOn(objectId: string, treatmentId: string): void {
  if (dragFrom.value && objectId === props.object.id && dragFrom.value !== treatmentId) {
    emit('reorderTreatment', props.object.id, dragFrom.value, treatmentId)
  }
  dragFrom.value = null
}
</script>

<template>
  <div>
    <div class="group flex items-center gap-2 rounded px-2 py-1 text-xs"
      data-testid="object-row" :data-object-id="object.id" :data-object-name="object.name"
      :class="selectedIds.includes(object.id) ? 'bg-white/15' : 'hover:bg-white/5'"
      :style="{ paddingLeft: `${8 + depth * 12}px` }"
      @click="emit('select', object.id, $event.shiftKey || $event.metaKey || $event.ctrlKey)">
      <button v-if="children.length || treatments.length" type="button" data-testid="object-row-toggle" class="-ml-1 shrink-0 opacity-60 hover:opacity-100"
        @click.stop="expanded = !expanded">
        <component :is="expanded ? ChevronDown : ChevronRight" class="h-3 w-3" />
      </button>
      <span v-else class="w-2 shrink-0" />
      <component :is="icon" class="h-3.5 w-3.5 shrink-0 opacity-60" />
      <span class="flex-1 truncate" :class="glbError[object.id] ? 'text-red-400' : ''">{{ object.name }}</span>
      <span v-if="children.length" data-testid="object-row-children" class="shrink-0 text-[10px] tabular-nums opacity-40">{{ children.length }}</span>
      <button v-if="glbError[object.id]" type="button" class="text-red-400 opacity-90 hover:opacity-100"
        title="Load failed — retry" @click.stop="emit('retry', object.id)"><RotateCcw class="h-3.5 w-3.5" /></button>
      <button v-if="canHost" ref="addBtn" type="button" data-testid="add-treatment" aria-label="Add treatment"
        class="opacity-0 group-hover:opacity-70" :class="menuOpen ? '!opacity-100' : ''"
        @click.stop="menuOpen ? closeMenu() : openMenu()"><Plus class="h-3.5 w-3.5" /></button>
      <button type="button" class="opacity-0 group-hover:opacity-70" @click.stop="emit('toggleVisible', object.id)">
        <component :is="object.visible ? Eye : EyeOff" class="h-3.5 w-3.5" />
      </button>
      <button type="button" class="opacity-0 group-hover:opacity-70" @click.stop="emit('duplicate', object.id)"><Copy class="h-3.5 w-3.5" /></button>
      <button type="button" class="opacity-0 group-hover:opacity-70" @click.stop="emit('remove', object.id)"><Trash2 class="h-3.5 w-3.5" /></button>
    </div>
    <Teleport to="body">
      <div v-if="menuOpen" data-treatment-menu
        class="fixed z-[200] w-44 rounded-lg border border-white/10 bg-[#161616] p-1 shadow-2xl"
        :style="{ top: `${menuPos.top}px`, left: `${menuPos.left}px` }" @pointerdown.stop>
        <button v-for="kind in TREATMENT_KINDS" :key="kind" type="button" data-testid="add-treatment-item" :data-kind="kind"
          class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-white/80 transition-colors hover:bg-white/10 hover:text-white cursor-pointer"
          @click.stop="pick(kind)">
          <component :is="TREATMENT_ICONS[kind]" class="h-3.5 w-3.5 opacity-70" />
          <span>{{ TREATMENT_LABELS[kind] }}</span>
        </button>
      </div>
    </Teleport>
    <template v-if="expanded">
      <Scene3DTreatmentRow v-for="t in treatments" :key="t.id"
        :treatment="t" :object-id="object.id" :depth="depth + 1"
        :selected="selectedTreatment?.objectId === object.id && selectedTreatment?.treatmentId === t.id"
        :not-rendered="notRendered.has(t.id)"
        @select="(oid, tid) => emit('selectTreatment', oid, tid)"
        @remove="(oid, tid) => emit('removeTreatment', oid, tid)"
        @duplicate="(oid, tid) => emit('duplicateTreatment', oid, tid)"
        @toggle-enabled="(oid, tid) => emit('toggleTreatment', oid, tid)"
        @drag-start="onDragStart"
        @drop-on="onDropOn" />
      <Scene3DObjectRow v-for="c in children" :key="c.id"
        :object="c" :objects="objects" :selected-ids="selectedIds" :glb-error="glbError" :depth="depth + 1"
        :selected-treatment="selectedTreatment" :not-rendered="notRendered"
        @select="(id, additive) => emit('select', id, additive)"
        @remove="(id) => emit('remove', id)"
        @duplicate="(id) => emit('duplicate', id)"
        @retry="(id) => emit('retry', id)"
        @toggle-visible="(id) => emit('toggleVisible', id)"
        @add-treatment="(oid, kind) => emit('addTreatment', oid, kind)"
        @select-treatment="(oid, tid) => emit('selectTreatment', oid, tid)"
        @remove-treatment="(oid, tid) => emit('removeTreatment', oid, tid)"
        @duplicate-treatment="(oid, tid) => emit('duplicateTreatment', oid, tid)"
        @toggle-treatment="(oid, tid) => emit('toggleTreatment', oid, tid)"
        @reorder-treatment="(oid, from, to) => emit('reorderTreatment', oid, from, to)" />
    </template>
  </div>
</template>
```

- [ ] **Step 3: Compile check against the running dev server**

Run (from `frontend/`; Julien's own server on :3000 transforms on demand):

```bash
for f in app/components/vue-canvas/studio/Scene3DTreatmentRow.vue app/components/vue-canvas/studio/Scene3DObjectRow.vue; do
  curl -s -o /tmp/out.js -w "%{http_code} %{size_download} $f\n" "http://127.0.0.1:3000/_nuxt/@fs/$PWD/$f"; grep -c "TREATMENT_ICONS" /tmp/out.js; done
```

Expected: `200` with a size in the tens of KB for each, and a non-zero grep count. A `404` or a 9-byte body means the path is wrong, not that it compiled. If no server is up on :3000, skip and rely on Task 8's typecheck.

- [ ] **Step 4: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/components/vue-canvas/studio/Scene3DTreatmentRow.vue frontend/app/components/vue-canvas/studio/Scene3DObjectRow.vue
git commit -m "feat(scene3d): treatment rows and add menu in the Objects tree

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Surface wiring — selection, handlers, treatment inspector, test hooks, lab seed

**Files:**
- Modify: `frontend/app/components/vue-canvas/Scene3DStudioSurface.vue`
- Modify: `frontend/app/pages/dev/scene3d-lab.vue`

**Interfaces:**
- Consumes: Tasks 1, 2, 6, 7 exports; existing surface state `doc`, `selectedIds`, `sculpting`, `engine`, `onControlsPointerDown`, `StudioControlPanel`, `renderPasses`.
- Produces:
  - Surface state `selectedTreatment: Ref<{ objectId, treatmentId } | null>`, `activeTreatment` computed; handlers `selectTreatment`, `addTreatment`, `removeTreatment`, `duplicateTreatment`, `toggleTreatment`, `reorderTreatment`; `readTreatmentControl(key)`, `setTreatmentControl(key, value)`.
  - Window test hooks (dev-only, alongside `__scene3dDoc`): `__scene3dTreatmentStats(): { frames, groups } | null`, `__scene3dSnapshot(): string`, `__scene3dBeauty(): Promise<string>`.
  - `/dev/scene3d-lab?state=<encoded scene_state JSON>` seeds the surface with that document.

- [ ] **Step 1: Imports**

In `Scene3DStudioSurface.vue`, replace the Task 1 line `import { cloneTreatments } from '~/lib/scene3d/treatments'` with:

```ts
import {
  cloneTreatments, createTreatment, findTreatment, isTreatmentHost, maskedTreatmentPlan, newTreatmentId,
  treatmentsOf, unrenderedTreatmentIds, TREATMENT_LABELS, type Treatment, type TreatmentKind,
} from '~/lib/scene3d/treatments'
import { treatmentControls, treatmentField } from '~/lib/scene3d/treatmentControls'
```

Make sure `ChevronRight` is in the `lucide-vue-next` import list (line ~10-18); add it if absent.

- [ ] **Step 2: State and handlers**

Directly after `const rootObjectList = computed(() => rootObjects(doc.objects))` (line ~169) add:

```ts
// ── Treatments: per-object effects, managed from the tree (design spec §2).
// A treatment selection is a SEPARATE concept from the object selection: picking a
// treatment row clears `selectedIds` (which detaches the gizmo through the selection
// watch) and the inspector shows only that treatment's dials.
const selectedTreatment = ref<{ objectId: string; treatmentId: string } | null>(null)
const activeTreatment = computed(() =>
  selectedTreatment.value ? findTreatment(doc, selectedTreatment.value.objectId, selectedTreatment.value.treatmentId) : null)
/** Treatment ids this frame's plan will not draw — the tree marks them "Not rendered". */
const unrenderedTreatments = computed(() => unrenderedTreatmentIds(maskedTreatmentPlan(doc)))

function selectTreatment(objectId: string, treatmentId: string): void {
  if (sculpting.value) return // same guard as toggleSelected: never re-point a live sculpt session
  selectedIds.value = []
  selectedTreatment.value = { objectId, treatmentId }
}
function addTreatment(objectId: string, kind: TreatmentKind): void {
  const o = doc.objects.find((x) => x.id === objectId)
  if (!o || !isTreatmentHost(o)) return
  const t = createTreatment(kind)
  o.treatments = [...treatmentsOf(o), t]
  selectTreatment(objectId, t.id)
}
function removeTreatment(objectId: string, treatmentId: string): void {
  const o = doc.objects.find((x) => x.id === objectId)
  if (!o) return
  const next = treatmentsOf(o).filter((t) => t.id !== treatmentId)
  if (next.length) o.treatments = next
  else delete o.treatments // absent, never [] — keeps the saved doc byte-identical to before
  if (selectedTreatment.value?.treatmentId === treatmentId) selectedTreatment.value = null
}
function duplicateTreatment(objectId: string, treatmentId: string): void {
  const hit = findTreatment(doc, objectId, treatmentId)
  if (!hit) return
  const copy = { ...hit.treatment, id: newTreatmentId() } as Treatment
  const list = [...treatmentsOf(hit.obj)]
  list.splice(hit.index + 1, 0, copy)
  hit.obj.treatments = list
  selectTreatment(objectId, copy.id)
}
function toggleTreatment(objectId: string, treatmentId: string): void {
  const hit = findTreatment(doc, objectId, treatmentId)
  if (hit) hit.treatment.enabled = !hit.treatment.enabled
}
function reorderTreatment(objectId: string, fromId: string, toId: string): void {
  const o = doc.objects.find((x) => x.id === objectId)
  if (!o) return
  const list = [...treatmentsOf(o)]
  const from = list.findIndex((t) => t.id === fromId)
  const to = list.findIndex((t) => t.id === toId)
  if (from < 0 || to < 0 || from === to) return
  const [moved] = list.splice(from, 1)
  list.splice(to, 0, moved!)
  o.treatments = list
}

// The treatment inspector: ONE card from treatmentControls(kind), read/written straight
// on the selected Treatment. Colour rows arrive as 8-digit #rrggbbaa from StudioColor;
// stored as-is, stripped by every three consumer (treatmentShells.ts / treatmentStage.ts).
const treatmentPanelControls = computed(() => activeTreatment.value ? treatmentControls(activeTreatment.value.treatment.kind) : [])
const treatmentPanelOrder = computed(() => activeTreatment.value ? [TREATMENT_LABELS[activeTreatment.value.treatment.kind]] : [])
function readTreatmentControl(key: string): string | number | boolean {
  const t = activeTreatment.value?.treatment as unknown as Record<string, string | number | boolean> | undefined
  const v = t?.[treatmentField(key)]
  return v === undefined ? '' : v
}
function setTreatmentControl(key: string, value: string | number | boolean): void {
  const t = activeTreatment.value?.treatment as unknown as Record<string, unknown> | undefined
  if (t) t[treatmentField(key)] = value
}
```

In `watch(selectedIds, (ids) => {` (line ~1800), add as the FIRST statement of the callback:

```ts
  if (ids.length) selectedTreatment.value = null // an object selection replaces a treatment selection
```

In `removeObject` (line ~3038), after `selectedIds.value = selectedIds.value.filter(...)`, add:

```ts
  if (selectedTreatment.value && doomed.has(selectedTreatment.value.objectId)) selectedTreatment.value = null
```

- [ ] **Step 3: Test hooks**

Next to `;(window as any).__scene3dDoc = () => JSON.parse(serializeDoc(doc))` (line ~1570) add:

```ts
  ;(window as any).__scene3dTreatmentStats = () => engine ? { ...engine.treatmentStats } : null
  ;(window as any).__scene3dSnapshot = () => engine?.snapshot() ?? ''
  ;(window as any).__scene3dBeauty = async () => engine ? (await renderPasses(engine, doc, 0)).beauty : ''
```

and extend the `onBeforeUnmount` cleanup on line ~1580:

```ts
onBeforeUnmount(() => {
  for (const k of ['__scene3dDoc', '__scene3dCamera', '__scene3dTreatmentStats', '__scene3dSnapshot', '__scene3dBeauty']) delete (window as any)[k]
})
```

- [ ] **Step 4: Template — tree rows**

Replace the `<Scene3DObjectRow v-for="o in rootObjectList" …` element (line ~3915) with:

```vue
          <Scene3DObjectRow v-for="o in rootObjectList" :key="o.id"
            :object="o" :objects="doc.objects" :selected-ids="selectedIds" :glb-error="glbError" :depth="0"
            :selected-treatment="selectedTreatment" :not-rendered="unrenderedTreatments"
            @select="toggleSelected"
            @remove="removeObject"
            @duplicate="duplicateObject"
            @retry="retryGlb"
            @toggle-visible="(id) => { const found = doc.objects.find((x) => x.id === id); if (found) found.visible = !found.visible }"
            @add-treatment="addTreatment"
            @select-treatment="selectTreatment"
            @remove-treatment="removeTreatment"
            @duplicate-treatment="duplicateTreatment"
            @toggle-treatment="toggleTreatment"
            @reorder-treatment="reorderTreatment" />
```

- [ ] **Step 5: Template — treatment inspector**

Find the single occurrence of `<template v-if="activeTab === 'build'">` in the `#controls` slot. Change it to `<template v-if="activeTab === 'build' && !activeTreatment">` and insert directly BEFORE it:

```vue
      <!-- Treatment inspector (design spec §2): a treatment row is selected in the tree, so
           this column shows ONLY that treatment's dials under a breadcrumb naming its object.
           Selecting a treatment cleared the object selection, so none of the object cards
           below apply; clicking the object name in the breadcrumb selects the object again. -->
      <template v-if="activeTab === 'build' && activeTreatment">
        <div class="mb-2 flex items-center gap-1.5 px-1 text-[11px] text-white/50" data-testid="treatment-breadcrumb">
          <button type="button" class="truncate hover:text-white/80" @click="selectedIds = [activeTreatment.obj.id]">{{ activeTreatment.obj.name }}</button>
          <ChevronRight class="h-3 w-3 shrink-0 opacity-60" />
          <span class="truncate text-white/80">{{ TREATMENT_LABELS[activeTreatment.treatment.kind] }}</span>
        </div>
        <div class="flex flex-col gap-2" @pointerdown.capture="onControlsPointerDown">
          <StudioControlPanel
            :controls="treatmentPanelControls"
            :order="treatmentPanelOrder"
            :value="readTreatmentControl"
            @set="setTreatmentControl"
          />
        </div>
      </template>
```

- [ ] **Step 6: Lab page seed**

In `frontend/app/pages/dev/scene3d-lab.vue`, replace the `const glbFile = …` / `const seed = …` block with:

```ts
// ?state=<encoded scene_state JSON> seeds the surface with a whole document (the Playwright
// treatment specs use this); ?glb=<file in ComfyUI's input dir> seeds a single imported
// model as before. `state` wins when both are present.
const route = useRoute()
const stateParam = route.query.state
const glbFile = route.query.glb
const seed = typeof stateParam === 'string' && stateParam
  ? stateParam
  : typeof glbFile === 'string' && glbFile
  ? JSON.stringify({
      version: 1,
      objects: [{
        id: 'lab-glb', kind: 'glb', name: glbFile, visible: true,
        url: `/view?${new URLSearchParams({ filename: glbFile, type: 'input' })}`,
        position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        material: { type: 'standard', color: '#9aa3af', roughness: 0.6, metalness: 0 },
      }],
    })
  : ''
```

- [ ] **Step 7: Typecheck the touched files and run the panel parity spec**

Run:

```bash
cd frontend && node_modules/.bin/nuxt typecheck 2>&1 | grep -E "Scene3DStudioSurface\.vue|Scene3DObjectRow\.vue|Scene3DTreatmentRow\.vue|scene3d-lab\.vue" | grep -iE "treatment|Treatment|selectedTreatment|activeTreatment|__scene3d" ; echo "grep exit=$?"
node_modules/.bin/vitest run tests/unit/scene3d-panel-parity.unit.spec.ts tests/unit/scene3d-treatments.unit.spec.ts
```

Expected: grep prints nothing (exit 1); vitest PASS.

- [ ] **Step 8: Manual smoke in the Browser pane (only if a dev-server slot is free; otherwise Task 9 covers it)**

Open `http://127.0.0.1:<port>/dev/scene3d-lab`, add a sphere from the bottom toolbar, hover its row, click the plus, pick "Blur": a "Blur" row appears under the sphere, the breadcrumb reads "Sphere › Blur", the Amount slider moves the blur live, and the object cards are gone until you click the breadcrumb. Close the Browser pane tab before Task 9 runs Playwright.

- [ ] **Step 9: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/components/vue-canvas/Scene3DStudioSurface.vue frontend/app/pages/dev/scene3d-lab.vue
git commit -m "feat(scene3d): select, add, reorder and tune treatments from the Objects tree

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Playwright proof — blur renders, inversion flips, export matches, tree flow works

**Files:**
- Create: `frontend/tests/scene3d-treatments.spec.ts`

**Interfaces:**
- Consumes: `/dev/scene3d-lab?state=…` (Task 8), window hooks `__scene3dTreatmentStats`, `__scene3dSnapshot`, `__scene3dBeauty`, `__scene3dDoc`; tree test ids from Task 7 (`object-row`, `add-treatment`, `add-treatment-item`, `treatment-row`, `treatment-breadcrumb`).
- Produces: a spec that asserts the stage RAN (stats), not just that pixels look plausible — per the project's verification rule that a graceful fallback must not pass.

- [ ] **Step 1: Write the spec**

```ts
import { test, expect, type Page } from '@playwright/test'

/**
 * Per-object treatments, end to end against the real WebGL path (design spec §5).
 *
 * Instrument: `__scene3dSnapshot()` renders one frame and returns the canvas PNG; the
 * sharpness metric below is the mean absolute horizontal luminance step inside the middle
 * band of each image half. A blurred sphere scores well under a sharp one. Every visual
 * assertion is paired with `__scene3dTreatmentStats()` so a stage that silently fell back
 * to the plain render (frames 0) fails loudly instead of passing on the sharp/sharp case.
 */

const sphere = (id: string, name: string, x: number, color: string, treatments?: unknown[]) => ({
  id, kind: 'primitive', primitive: 'sphere', name, visible: true,
  position: [x, 0.6, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
  material: { type: 'standard', color, roughness: 0.4, metalness: 0 },
  ...(treatments ? { treatments } : {}),
})
const twoSpheres = (leftTreatments?: unknown[]) => ({
  version: 1, background: '#202020', showFloor: false,
  camera: { position: [0, 1.2, 5.5], target: [0, 0.6, 0], fov: 40 },
  objects: [
    sphere('left', 'Left', -1.4, '#d94f3a', leftTreatments),
    sphere('right', 'Right', 1.4, '#3a8ad9'),
  ],
})
const BLUR = { id: 't-blur', kind: 'blur', enabled: true, invert: false, amount: 1 }

async function openLab(page: Page, state: unknown): Promise<void> {
  await page.goto(`/dev/scene3d-lab?state=${encodeURIComponent(JSON.stringify(state))}`)
  await expect.poll(() => page.evaluate(() => typeof (window as any).__scene3dSnapshot === 'function'), { timeout: 30_000 }).toBe(true)
  // Let the engine sync + a few rAF frames run so materials/env are settled.
  await expect.poll(() => page.evaluate(() => (window as any).__scene3dDoc().objects.length), { timeout: 10_000 }).toBe(2)
  await page.waitForTimeout(1500)
}

async function sharpness(page: Page, dataUrl: string): Promise<{ left: number; right: number }> {
  return page.evaluate(async (url) => {
    const img = new Image(); img.src = url; await img.decode()
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0)
    const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height)
    const lum = (i: number) => 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!
    const score = (x0: number, x1: number) => {
      let s = 0, n = 0
      for (let y = Math.floor(height * 0.3); y < height * 0.7; y++) {
        for (let x = x0; x < x1 - 1; x++) { const i = (y * width + x) * 4; s += Math.abs(lum(i) - lum(i + 4)); n++ }
      }
      return s / n
    }
    return { left: score(0, Math.floor(width / 2)), right: score(Math.floor(width / 2), width) }
  }, dataUrl)
}

const stats = (page: Page) => page.evaluate(() => (window as any).__scene3dTreatmentStats() as { frames: number; groups: number })
const snapshot = (page: Page) => page.evaluate(() => (window as any).__scene3dSnapshot() as string)

test.describe('3D Studio treatments', () => {
  test('a blur on the left sphere softens the left half only, and the stage actually ran', async ({ page }) => {
    await openLab(page, twoSpheres([BLUR]))
    const s = await stats(page)
    expect(s.frames).toBeGreaterThan(0)
    expect(s.groups).toBe(1)
    const { left, right } = await sharpness(page, await snapshot(page))
    // The 0.5 floor only proves there IS an edge to measure on the sharp side. If it fails, log
    // both numbers and lower the floor — never loosen the 0.5 blur RATIO below, that is the claim.
    expect(right).toBeGreaterThan(0.5)
    expect(left).toBeLessThan(right * 0.5)
  })

  test('"Everything else" flips which side is blurred', async ({ page }) => {
    await openLab(page, twoSpheres([{ ...BLUR, invert: true }]))
    expect((await stats(page)).groups).toBe(1)
    const { left, right } = await sharpness(page, await snapshot(page))
    expect(left).toBeGreaterThan(0.5)
    expect(right).toBeLessThan(left * 0.5)
  })

  test('the export bake carries the treatment (viewport and still agree)', async ({ page }) => {
    await openLab(page, twoSpheres([BLUR]))
    const live = await sharpness(page, await snapshot(page))
    const beauty = await page.evaluate(() => (window as any).__scene3dBeauty() as Promise<string>)
    expect(beauty.startsWith('data:image/png')).toBe(true)
    const baked = await sharpness(page, beauty)
    expect(live.left).toBeLessThan(live.right * 0.5)
    expect(baked.left).toBeLessThan(baked.right * 0.5)
  })

  test('with no treatment the plain render path is used (stage never runs)', async ({ page }) => {
    await openLab(page, twoSpheres())
    expect((await stats(page)).frames).toBe(0)
    const { left, right } = await sharpness(page, await snapshot(page))
    expect(Math.abs(left - right)).toBeLessThan(Math.max(left, right) * 0.35)
  })

  test('tree flow: add a rim light from the row menu, see the breadcrumb, toggle, remove', async ({ page }) => {
    await openLab(page, twoSpheres())
    const row = page.locator('[data-testid="object-row"][data-object-name="Left"]')
    await row.hover()
    await row.locator('[data-testid="add-treatment"]').click()
    await page.locator('[data-testid="add-treatment-item"][data-kind="rimLight"]').click()
    const trow = page.locator('[data-testid="treatment-row"][data-treatment-kind="rimLight"]')
    await expect(trow).toBeVisible()
    await expect(trow).toHaveText(/Rim light/)
    await expect(page.getByTestId('treatment-breadcrumb')).toHaveText(/Left.*Rim light/)
    await expect(page.getByLabel('Strength')).toBeVisible()
    const docTreatments = () => page.evaluate(() => (window as any).__scene3dDoc().objects[0].treatments)
    expect(await docTreatments()).toHaveLength(1)
    expect((await docTreatments())[0]).toMatchObject({ kind: 'rimLight', enabled: true })
    await trow.hover()
    await trow.getByRole('button', { name: 'Hide treatment' }).click()
    expect((await docTreatments())[0].enabled).toBe(false)
    await trow.hover()
    await trow.getByRole('button', { name: 'Remove treatment' }).click()
    await expect(trow).toHaveCount(0)
    expect(await docTreatments()).toBeUndefined()
    await expect(page.getByTestId('treatment-breadcrumb')).toHaveCount(0)
  })
})
```

- [ ] **Step 2: Run it from a worktree-safe dev server**

Follow the E2E recipe exactly (a parallel session's dev servers must not be disturbed):

```bash
cd /Users/julien/Documents/GitHub/Sailor/frontend
node_modules/.bin/nuxt dev --port 3102 --host 127.0.0.1 > /tmp/treat-dev.log 2>&1 &
sleep 20; grep -m1 "Local:" /tmp/treat-dev.log      # confirm it really is :3102, Nuxt silently picks another port when taken
PW_BASE_URL=http://127.0.0.1:3102 node_modules/.bin/playwright test tests/scene3d-treatments.spec.ts --project=chromium
```

(If this session is running from a `.claude/worktrees/*` checkout, first `ln -sfn /Users/julien/Documents/GitHub/Sailor/frontend/node_modules node_modules` and `node_modules/.bin/nuxt prepare`.)

Expected: 5 passed. If the first test fails on `frames` being 0 the stage never ran — check the browser console for a shader compile error via `test-results/**/trace` or by loading the lab in the Browser pane and reading `read_console_messages`. If `left` is not softer, check `STAGE_SAMPLES` note in treatmentStage.ts (depth all-1.0 ⇒ composite discards everything ⇒ blurred layer invisible).

- [ ] **Step 3: Kill the server and commit**

```bash
kill %1 2>/dev/null; lsof -nP -iTCP:3102 -sTCP:LISTEN -t | xargs -r kill -9
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/tests/scene3d-treatments.spec.ts
git commit -m "test(scene3d): treatments render, invert, export and tree flow end to end

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Finish — full unit run, typecheck delta, dashboard note

**Files:**
- None new. Verification only, plus the build dashboard artifact per the project's working rule.

- [ ] **Step 1: Full unit suite**

Run: `cd frontend && node_modules/.bin/vitest run tests/unit 2>&1 | tail -8`
Expected: the summary shows no failed files. If a count looks off, re-run the single failing file alone before concluding (vitest counts can lie under load).

- [ ] **Step 2: Typecheck delta on touched files only**

```bash
cd frontend && node_modules/.bin/nuxt typecheck 2>&1 | grep -E "treatment|Treatment|idPath\.ts|configParams\.ts|spacetype/post\.ts|scene3d-lab\.vue" ; echo "exit=$?"
```

Expected: exit 1 (no matches).

- [ ] **Step 3: Report**

Summarise per task: what landed, which tests prove it, the two known limitations to carry into the follow-up list (GTAO still computes occlusion from the untreated geometry, so an ambient-occlusion halo around a blurred model stays crisp; the on/off flag is agent-reachable but not a motion track — key a fade instead). Update the ⛵ build dashboard artifact in place per the standing rule (read the live one first, replace, never append).
