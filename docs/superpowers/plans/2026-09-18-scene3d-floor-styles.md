# 3D Studio Floor Styles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the 3D Studio floor four looks — Off, Shadow only, Reflection (fades to transparent), Polished — replacing today's single `showFloor` boolean.

**Architecture:** A pure mapping module (`floor.ts`) turns a `floorMode` enum into visibility flags and cinematic-floor material params. The raster viewport gains a customized three `Reflector` plane whose fragment shader either fades the reflection to transparent (Reflection) or paints an opaque glossy surface (Polished). Cinematic (path-traced) mode owns the floor itself and only tunes the existing `cinematicFloor` material — no Reflector there. Migration from `showFloor` is lossless.

**Tech Stack:** Nuxt 4 / Vue 3 / TypeScript, three r0.171 (`three/examples/jsm/objects/Reflector.js`), Vitest unit tests, Playwright live tests.

## Global Constraints

- **Work in the main checkout.** No worktree, no branch. Stage only your own hunks by exact path; never `git stash`.
- **Commit with a private git index** (shared index is hostile here): each commit uses `GIT_INDEX_FILE`. See the commit recipe in each Commit step.
- **Never run `npm run dev` from a subagent** — it kills the shared `:3002` server and can take ComfyUI with it. For live tests use the existing dev server if healthy (`lsof -nP -iTCP -sTCP:LISTEN | grep node`, confirm cwd), else tell the user.
- **Verify Reflection/Polished in the REAL visible browser pane** — a hidden pane pauses rAF, so the reflection render target never updates and the floor reads black.
- **UI copy:** sentence case, no lowercase-start labels, no internal identifiers surfaced. A select over lowercase stored values needs `optionLabels`.
- **three version floor:** stay on r0.171-compatible APIs (do not bump three; the path tracer is pinned to it).
- Spec: `docs/superpowers/specs/2026-09-18-scene3d-floor-styles-design.md`.

---

### Task 1: Pure floor mapping module

**Files:**
- Create: `frontend/app/lib/scene3d/floor.ts`
- Test: `frontend/tests/unit/scene3d-floor.unit.spec.ts`

**Interfaces:**
- Produces:
  - `FLOOR_MODES: readonly ['off','shadow','reflection','polished']`
  - `type FloorMode = 'off' | 'shadow' | 'reflection' | 'polished'`
  - `interface FloorVisibility { grid: boolean; shadow: boolean; reflector: boolean }`
  - `floorVisibility(mode: FloorMode): FloorVisibility`
  - `cinematicFloorVisible(mode: FloorMode): boolean`
  - `cinematicFloorRoughness(mode: FloorMode, reflectivity: number): number`
  - `migrateFloorMode(raw: unknown): FloorMode`

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/unit/scene3d-floor.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  FLOOR_MODES, floorVisibility, cinematicFloorVisible,
  cinematicFloorRoughness, migrateFloorMode,
} from '~/lib/scene3d/floor'

describe('floorVisibility', () => {
  it('off shows nothing', () => {
    expect(floorVisibility('off')).toEqual({ grid: false, shadow: false, reflector: false })
  })
  it('shadow keeps today’s grid + catcher', () => {
    expect(floorVisibility('shadow')).toEqual({ grid: true, shadow: true, reflector: false })
  })
  it('reflection keeps grounding under the reflector', () => {
    expect(floorVisibility('reflection')).toEqual({ grid: true, shadow: true, reflector: true })
  })
  it('polished is a clean reflective surface (no grid/catcher)', () => {
    expect(floorVisibility('polished')).toEqual({ grid: false, shadow: false, reflector: true })
  })
})

describe('cinematic mapping', () => {
  it('floor hidden only when off', () => {
    expect(cinematicFloorVisible('off')).toBe(false)
    expect(cinematicFloorVisible('shadow')).toBe(true)
    expect(cinematicFloorVisible('reflection')).toBe(true)
  })
  it('shadow is matte; reflection/polished glossier as reflectivity rises', () => {
    expect(cinematicFloorRoughness('shadow', 1)).toBeCloseTo(0.5)
    expect(cinematicFloorRoughness('reflection', 0)).toBeCloseTo(0.5)
    expect(cinematicFloorRoughness('reflection', 1)).toBeCloseTo(0.05)
    expect(cinematicFloorRoughness('polished', 1)).toBeCloseTo(0.05)
  })
  it('clamps reflectivity out of range', () => {
    expect(cinematicFloorRoughness('reflection', 2)).toBeCloseTo(0.05)
    expect(cinematicFloorRoughness('reflection', -1)).toBeCloseTo(0.5)
  })
})

describe('migrateFloorMode', () => {
  it('honours an explicit floorMode', () => {
    expect(migrateFloorMode({ floorMode: 'polished' })).toBe('polished')
  })
  it('legacy showFloor:false → off', () => {
    expect(migrateFloorMode({ showFloor: false })).toBe('off')
  })
  it('legacy showFloor:true or absent → shadow', () => {
    expect(migrateFloorMode({ showFloor: true })).toBe('shadow')
    expect(migrateFloorMode({})).toBe('shadow')
  })
  it('rejects a garbage floorMode, falling back through showFloor', () => {
    expect(migrateFloorMode({ floorMode: 'nope', showFloor: false })).toBe('off')
  })
  expect(FLOOR_MODES.length).toBe(4)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/scene3d-floor.unit.spec.ts`
Expected: FAIL — `Cannot find module '~/lib/scene3d/floor'`.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/app/lib/scene3d/floor.ts`:

```ts
// Pure mapping from the floor-style enum to viewport visibility + cinematic-floor material
// params. Kept free of three/GL so it unit-tests without a canvas; the engine reads it.

export const FLOOR_MODES = ['off', 'shadow', 'reflection', 'polished'] as const
export type FloorMode = typeof FLOOR_MODES[number]

export interface FloorVisibility {
  grid: boolean       // reference grid (GridHelper)
  shadow: boolean     // transparent shadow-catcher ground (ShadowMaterial)
  reflector: boolean  // the raster Reflector plane
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n))

export function floorVisibility(mode: FloorMode): FloorVisibility {
  switch (mode) {
    case 'off':        return { grid: false, shadow: false, reflector: false }
    case 'shadow':     return { grid: true,  shadow: true,  reflector: false }
    case 'reflection': return { grid: true,  shadow: true,  reflector: true  }
    case 'polished':   return { grid: false, shadow: false, reflector: true  }
  }
}

/** Cinematic owns the floor via the existing matte `cinematicFloor`; the enum only tunes it. */
export function cinematicFloorVisible(mode: FloorMode): boolean {
  return mode !== 'off'
}

/** Shadow = matte 0.5. Reflection/Polished go glossier (→ 0.05) as reflectivity rises to 1. */
export function cinematicFloorRoughness(mode: FloorMode, reflectivity: number): number {
  if (mode === 'reflection' || mode === 'polished') return 0.5 - 0.45 * clamp01(reflectivity)
  return 0.5
}

/** Read a stored doc: honour an explicit floorMode, else migrate the legacy showFloor boolean. */
export function migrateFloorMode(raw: unknown): FloorMode {
  const r = (raw ?? {}) as { floorMode?: unknown; showFloor?: unknown }
  if (typeof r.floorMode === 'string' && (FLOOR_MODES as readonly string[]).includes(r.floorMode)) {
    return r.floorMode as FloorMode
  }
  return r.showFloor === false ? 'off' : 'shadow'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/scene3d-floor.unit.spec.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor && IDX=$(mktemp /tmp/sailor-idx.XXXXXX) && cp .git/index "$IDX"
GIT_INDEX_FILE=$IDX git add frontend/app/lib/scene3d/floor.ts frontend/tests/unit/scene3d-floor.unit.spec.ts
GIT_INDEX_FILE=$IDX git commit -m "feat(scene3d): pure floor-mode mapping module

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
rm -f "$IDX"
```

---

### Task 2: Swap the doc field `showFloor` → `floorMode` + new fields

**Files:**
- Modify: `frontend/app/lib/scene3d/config.ts` (type at :627, defaults at :982, sanitiser at :1621)
- Test: `frontend/tests/unit/scene3d-config.unit.spec.ts` (add cases)

**Interfaces:**
- Consumes: `FloorMode`, `migrateFloorMode` from Task 1.
- Produces: `SceneDoc.floorMode: FloorMode`, `SceneDoc.floorReflectivity: number`, `SceneDoc.floorColor: string`. The `showFloor` key is removed from `SceneDoc`.

- [ ] **Step 1: Write the failing test**

Add to `frontend/tests/unit/scene3d-config.unit.spec.ts` (find the existing `parseDoc`/`sanitize` import already used in that file; reuse it — do not add a second import):

```ts
describe('floor migration (parseDoc/sanitize)', () => {
  it('new default is shadow with reflectivity + colour', () => {
    const d = defaultDoc()
    expect(d.floorMode).toBe('shadow')
    expect(d.floorReflectivity).toBeCloseTo(0.6)
    expect(d.floorColor).toBe('#15151a')
    expect((d as Record<string, unknown>).showFloor).toBeUndefined()
  })
  it('legacy showFloor:false sanitises to floorMode off', () => {
    const doc = sanitizeSceneDoc({ showFloor: false } as never)
    expect(doc.floorMode).toBe('off')
  })
  it('legacy showFloor:true sanitises to floorMode shadow', () => {
    const doc = sanitizeSceneDoc({ showFloor: true } as never)
    expect(doc.floorMode).toBe('shadow')
  })
  it('an explicit floorMode round-trips', () => {
    const doc = sanitizeSceneDoc({ floorMode: 'reflection', floorReflectivity: 0.9, floorColor: '#101014' } as never)
    expect(doc.floorMode).toBe('reflection')
    expect(doc.floorReflectivity).toBeCloseTo(0.9)
    expect(doc.floorColor).toBe('#101014')
  })
})
```

> Note: the existing spec already imports the sanitiser. Match its name — it is `sanitizeSceneDoc` if that's what the file uses, or the exported alias the file already imports. Check the top of `scene3d-config.unit.spec.ts` and use the same symbol; do not introduce a new name.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/scene3d-config.unit.spec.ts`
Expected: FAIL — `floorMode` is undefined / `showFloor` still present.

- [ ] **Step 3: Write minimal implementation**

In `config.ts`, add the import near the other local imports (top of file, beside `DEFAULT_POST` etc.):

```ts
import { migrateFloorMode, type FloorMode } from './floor'
```

Replace the type field at config.ts:627:

```ts
  // was: showFloor: boolean
  floorMode: FloorMode      // off = clean float; shadow = grid + catcher; reflection = fading mirror; polished = glossy surface
  floorReflectivity: number // 0..1, used by reflection + polished
  floorColor: string        // hex, used by polished
```

Replace the defaults line at config.ts:982 (`showFloor: true,`):

```ts
    floorMode: 'shadow',
    floorReflectivity: 0.6,
    floorColor: '#15151a',
```

Replace the sanitiser line at config.ts:1621 (`showFloor: raw.showFloor !== false,`):

```ts
    floorMode: migrateFloorMode(raw),
    floorReflectivity: typeof raw.floorReflectivity === 'number' ? raw.floorReflectivity : d.floorReflectivity,
    floorColor: typeof raw.floorColor === 'string' ? raw.floorColor : d.floorColor,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/scene3d-config.unit.spec.ts`
Expected: PASS.

Note: the typecheck and other files will now break (engine/controls/panelPresentation/Vue still say `showFloor`). That is fixed in Task 3 — do not run a full typecheck yet.

- [ ] **Step 5: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor && IDX=$(mktemp /tmp/sailor-idx.XXXXXX) && cp .git/index "$IDX"
GIT_INDEX_FILE=$IDX git add frontend/app/lib/scene3d/config.ts frontend/tests/unit/scene3d-config.unit.spec.ts
GIT_INDEX_FILE=$IDX git commit -m "feat(scene3d): doc.floorMode replaces showFloor (lossless migration)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
rm -f "$IDX"
```

---

### Task 3: Re-point consumers so the tree is green (behaviour-preserving)

Renames the `showFloor` references in the engine, controls, panel presentation, and the Vue surface to the new fields, WITHOUT building the Reflector yet. After this task the app compiles and behaves as today for Off/Shadow; selecting Reflection degrades to the Shadow look and Polished to the Off look (the Reflector object lands in Task 5).

**Files:**
- Modify: `frontend/app/lib/scene3d/engine.ts` (:1075-1078, :943)
- Modify: `frontend/app/lib/scene3d/controls.ts` (:838-841)
- Modify: `frontend/app/lib/scene3d/panelPresentation.ts` (:245, :618, :726)
- Modify: `frontend/app/components/vue-canvas/Scene3DStudioSurface.vue` (:1945, :2743)
- Test: `frontend/tests/unit/scene3d-controls.unit.spec.ts` (add gating cases)

**Interfaces:**
- Consumes: `floorVisibility`, `cinematicFloorVisible`, `cinematicFloorRoughness`, `FloorMode` from Task 1; the new doc fields from Task 2.

- [ ] **Step 1: Write the failing test**

Add to `frontend/tests/unit/scene3d-controls.unit.spec.ts` (reuse the existing controls import in that file — it already builds the control list; match its accessor). If the file exposes the controls array as `SCENE_CONTROLS` or via a builder, use that same symbol:

```ts
describe('floor controls', () => {
  const byKey = (k: string) => SCENE_CONTROLS.find((c) => c.key === k)!
  const doc = (floorMode: string) => ({ ...defaultDoc(), floorMode } as never)

  it('floorMode is a select with four sentence-case labels', () => {
    const c = byKey('floorMode')
    expect(c.kind).toBe('select')
    expect(c.options).toEqual(['off', 'shadow', 'reflection', 'polished'])
    expect((c as { optionLabels?: string[] }).optionLabels)
      .toEqual(['Off', 'Shadow only', 'Reflection', 'Polished'])
  })
  it('reflectivity shows for reflection and polished only', () => {
    const c = byKey('floorReflectivity')
    expect(c.when!(doc('off'))).toBe(false)
    expect(c.when!(doc('shadow'))).toBe(false)
    expect(c.when!(doc('reflection'))).toBe(true)
    expect(c.when!(doc('polished'))).toBe(true)
  })
  it('floor colour shows for polished only', () => {
    const c = byKey('floorColor')
    expect(c.when!(doc('polished'))).toBe(true)
    expect(c.when!(doc('reflection'))).toBe(false)
  })
})
```

> Match `SCENE_CONTROLS` / `defaultDoc` to whatever the existing spec imports at its top; do not add a competing import.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/scene3d-controls.unit.spec.ts`
Expected: FAIL — no `floorMode` control (still `showFloor`).

- [ ] **Step 3: Write minimal implementation**

**controls.ts** — replace the block at controls.ts:838-841:

```ts
  select('floorMode', 'Floor', ['off', 'shadow', 'reflection', 'polished'], D.floorMode, 'Background',
    'How the ground reads — off, a soft contact shadow, a fading reflection, or a polished surface',
    { optionLabels: ['Off', 'Shadow only', 'Reflection', 'Polished'] }),
  slider('floorReflectivity', 'Reflection', 0, 1, 0.01, 'Background', D.floorReflectivity,
    'How strong the reflection reads',
    { when: (doc) => doc.floorMode === 'reflection' || doc.floorMode === 'polished' }),
  color('floorColor', 'Floor colour', D.floorColor, 'Background',
    { when: (doc) => doc.floorMode === 'polished' }),
```

**panelPresentation.ts** — at :245 replace `if (key === 'showFloor') return doc.showFloor` with:

```ts
  if (key === 'floorMode') return doc.floorMode
  if (key === 'floorReflectivity') return doc.floorReflectivity
  if (key === 'floorColor') return doc.floorColor
```

At :618 replace the Background group list entry `'showFloor'` with the three keys:

```ts
  Background: ['floorMode', 'floorReflectivity', 'floorColor', 'ui.background.transparent', 'ui.background.color'],
```

At :726 replace `showFloor: { hint: null },` with:

```ts
  floorColor: { hint: null },
```

**engine.ts** — add to the imports near line 14:

```ts
import { floorVisibility, cinematicFloorVisible, cinematicFloorRoughness } from './floor'
```

Replace engine.ts:1075-1078 (the four `grid/shadowGround/cinematicFloor` lines):

```ts
    const fv = floorVisibility(doc.floorMode)
    this.grid.visible = fv.grid
    this.shadowGround.visible = fv.shadow
    // Reflector lands in Task 5; for now reflection/shadow share the catcher look and
    // polished/off share the clean look, so nothing else is needed here yet.
    this.cinematicFloor.visible = this._cinematic && cinematicFloorVisible(doc.floorMode)
    if (this.cinematicFloor.visible) {
      const m = this.cinematicFloor.material as THREE.MeshStandardMaterial
      m.roughness = cinematicFloorRoughness(doc.floorMode, doc.floorReflectivity)
      m.color.set(doc.floorMode === 'polished' ? stripAlpha(doc.floorColor) : '#15151a')
    }
```

Replace engine.ts:943 (`this.cinematicFloor.visible = this.lastDoc?.showFloor ?? true`):

```ts
      this.cinematicFloor.visible = cinematicFloorVisible(this.lastDoc?.floorMode ?? 'shadow') // real floor instead of the catcher
```

**Scene3DStudioSurface.vue** — at :1945 replace `if (key === 'showFloor') { doc.showFloor = value === true; return }` with:

```ts
  if (key === 'floorMode') { doc.floorMode = String(value) as typeof doc.floorMode; return }
  if (key === 'floorReflectivity') { doc.floorReflectivity = Number(value); return }
  if (key === 'floorColor') { doc.floorColor = String(value); return }
```

At :2743 (inside `applySnapshot`) replace `doc.showFloor = p.showFloor` with:

```ts
  doc.floorMode = p.floorMode
  doc.floorReflectivity = p.floorReflectivity
  doc.floorColor = p.floorColor
```

(`p` comes from `parseDoc`, which runs the sanitiser, so these fields are always present.)

- [ ] **Step 4: Run test + full typecheck to verify green**

Run: `cd frontend && npx vitest run tests/unit/scene3d-controls.unit.spec.ts tests/unit/scene3d-config.unit.spec.ts tests/unit/scene3d-floor.unit.spec.ts`
Expected: PASS.

Run: `cd frontend && grep -rn "showFloor" app/ && echo "STILL PRESENT" || echo "clean"`
Expected: `clean` (no `showFloor` left anywhere in `app/`).

Run: `cd frontend && npx vue-tsc --noEmit -p tsconfig.json 2>&1 | grep -iE "floor|scene3d" | head`
Expected: no floor/scene3d type errors. (Compare total error count to the typecheck baseline — do not chase pre-existing unrelated errors.)

- [ ] **Step 5: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor && IDX=$(mktemp /tmp/sailor-idx.XXXXXX) && cp .git/index "$IDX"
GIT_INDEX_FILE=$IDX git add frontend/app/lib/scene3d/engine.ts frontend/app/lib/scene3d/controls.ts frontend/app/lib/scene3d/panelPresentation.ts frontend/app/components/vue-canvas/Scene3DStudioSurface.vue frontend/tests/unit/scene3d-controls.unit.spec.ts
GIT_INDEX_FILE=$IDX git commit -m "feat(scene3d): surface floorMode control; re-point consumers off showFloor

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
rm -f "$IDX"
```

---

### Task 4: Shared raster-only-helper predicate (DRY the reflection/tracer hide set)

Factors the path tracer's inline "hide this helper" test into one exported predicate so the Reflector (Task 5) reflects exactly what the tracer skips.

**Files:**
- Modify: `frontend/app/lib/scene3d/passes.ts` (add `isRasterOnlyHelper`)
- Modify: `frontend/app/lib/scene3d/pathtrace/PathTracer.ts` (:42-55 use the predicate)
- Test: `frontend/tests/unit/scene3d-raster-helper.unit.spec.ts`

**Interfaces:**
- Produces: `isRasterOnlyHelper(o: THREE.Object3D): boolean` from `passes.ts`.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/unit/scene3d-raster-helper.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { isRasterOnlyHelper } from '~/lib/scene3d/passes'

describe('isRasterOnlyHelper', () => {
  it('flags the shadow-catcher (ShadowMaterial)', () => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial())
    expect(isRasterOnlyHelper(m)).toBe(true)
  })
  it('flags grid lines', () => {
    expect(isRasterOnlyHelper(new THREE.GridHelper(2, 2))).toBe(true)
  })
  it('flags a gizmo helper by userData', () => {
    const o = new THREE.Object3D(); o.userData.isGizmoHelper = true
    expect(isRasterOnlyHelper(o)).toBe(true)
  })
  it('does NOT flag a real object', () => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial())
    expect(isRasterOnlyHelper(m)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/scene3d-raster-helper.unit.spec.ts`
Expected: FAIL — `isRasterOnlyHelper` not exported.

- [ ] **Step 3: Write minimal implementation**

In `passes.ts`, add (import `isTreatmentShell` from `~/lib/scene3d/treatmentShells` if not already imported there — check the file's existing imports first and reuse):

```ts
import { isTreatmentShell } from '~/lib/scene3d/treatmentShells'

/** True for objects that belong only to the raster preview and must be excluded from the
 *  path-trace BVH AND from the floor Reflector's render (grid, shadow-catcher, gizmos,
 *  treatment shells). One predicate so the tracer and the reflector stay in sync. */
export function isRasterOnlyHelper(o: THREE.Object3D): boolean {
  const mat = (o as THREE.Mesh).material
  const isShadowCatcher = !!mat && (Array.isArray(mat)
    ? mat.some((m) => (m as THREE.Material & { isShadowMaterial?: boolean }).isShadowMaterial)
    : (mat as THREE.Material & { isShadowMaterial?: boolean }).isShadowMaterial === true)
  const isLine = (o as THREE.Line).isLine === true
  return isTreatmentShell(o) || o.userData.isGizmoHelper === true || isShadowCatcher || isLine
}
```

In `PathTracer.ts`, replace the traverse body at :42-55 with the predicate:

```ts
    scene.traverse((o) => {
      // Raster-only helpers (shadow-catcher ShadowMaterial, GridHelper lines, gizmos,
      // treatment shells) are meaningless/harmful to the tracer — hide them. See
      // isRasterOnlyHelper (the floor Reflector hides the same set).
      if (isRasterOnlyHelper(o) && o.visible) { o.visible = false; this.hidden.push(o) }
    })
```

Add the import at the top of `PathTracer.ts` (it already imports `isTreatmentShell` at :12 — replace that import with the predicate, since the inline uses move to `passes.ts`):

```ts
import { collectEditorHelpers, isRasterOnlyHelper } from '~/lib/scene3d/passes'
```

Remove the now-unused `import { isTreatmentShell } from '~/lib/scene3d/treatmentShells'` at PathTracer.ts:12 if nothing else in the file uses it (grep first: `grep -n isTreatmentShell app/lib/scene3d/pathtrace/PathTracer.ts`).

- [ ] **Step 4: Run tests to verify green**

Run: `cd frontend && npx vitest run tests/unit/scene3d-raster-helper.unit.spec.ts tests/unit/scene3d-pathtrace-env.unit.spec.ts`
Expected: PASS. The tracer's moiré-guard behaviour is unchanged (same predicate, refactored).

- [ ] **Step 5: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor && IDX=$(mktemp /tmp/sailor-idx.XXXXXX) && cp .git/index "$IDX"
GIT_INDEX_FILE=$IDX git add frontend/app/lib/scene3d/passes.ts frontend/app/lib/scene3d/pathtrace/PathTracer.ts frontend/tests/unit/scene3d-raster-helper.unit.spec.ts
GIT_INDEX_FILE=$IDX git commit -m "refactor(scene3d): shared isRasterOnlyHelper for tracer + reflector

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
rm -f "$IDX"
```

---

### Task 5: The Reflector floor (build + engine wiring)

Builds the customized `Reflector` plane and wires it into the engine so Reflection fades to transparent and Polished paints a glossy surface, both in the live viewport and in raster export.

**Files:**
- Create: `frontend/app/lib/scene3d/reflectorFloor.ts`
- Modify: `frontend/app/lib/scene3d/engine.ts` (construct + add to scene near :743-751; visibility in `syncFromDoc`; beauty-bake visibility in `renderPasses`)
- Test: covered by the live Task 6 (GL — no headless unit test)

**Interfaces:**
- Consumes: `isRasterOnlyHelper` (Task 4), `FloorMode` (Task 1), `stripAlpha` (`~/lib/color/convert`).
- Produces:
  - `createReflectorFloor(): Reflector`
  - `updateReflectorFloor(reflector: Reflector, mode: FloorMode, reflectivity: number, color: string): void`

- [ ] **Step 1: Create the reflector module**

Create `frontend/app/lib/scene3d/reflectorFloor.ts`:

```ts
// A customized three Reflector used as the raster floor. One shader serves both looks,
// branched on uPolished:
//   Reflection — premultiplied reflection that fades to transparent with view distance
//                (no visible surface; composites cleanly over any background + transparent export).
//   Polished   — an opaque base colour tinted by the reflection, with reflectivity strength.
// The reflection render-target render hides raster-only helpers (grid/catcher/gizmos/shells)
// so the mirror never shows the grid or feeds back on itself.
import * as THREE from 'three'
import { Reflector } from 'three/examples/jsm/objects/Reflector.js'
import { isRasterOnlyHelper } from '~/lib/scene3d/passes'
import { stripAlpha } from '~/lib/color/convert'
import type { FloorMode } from '~/lib/scene3d/floor'

const vertexShader = /* glsl */`
  uniform mat4 textureMatrix;
  varying vec4 vUv;
  varying float vViewDist;
  void main() {
    vUv = textureMatrix * vec4(position, 1.0);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewDist = -mv.z;                    // camera-space depth for the fade
    gl_Position = projectionMatrix * mv;
  }
`

const fragmentShader = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform vec3 color;                     // required by Reflector (unused here)
  uniform vec3 uBaseColor;
  uniform float uReflectivity;
  uniform float uFadeStart;               // view distance where the reflection is full
  uniform float uFadeEnd;                 // view distance where it has faded out
  uniform float uPolished;                // 0 = reflection, 1 = polished
  varying vec4 vUv;
  varying float vViewDist;
  void main() {
    vec3 refl = texture2DProj(tDiffuse, vUv).rgb;
    float fade = 1.0 - smoothstep(uFadeStart, uFadeEnd, vViewDist);
    if (uPolished > 0.5) {
      gl_FragColor = vec4(mix(uBaseColor, refl, uReflectivity), 1.0);
    } else {
      float a = clamp(uReflectivity * fade, 0.0, 1.0);
      gl_FragColor = vec4(refl * a, a);   // premultiplied
    }
  }
`

export function createReflectorFloor(): Reflector {
  const reflector = new Reflector(new THREE.PlaneGeometry(200, 200), {
    textureWidth: 1024,
    textureHeight: 1024,
    clipBias: 0.003,
    shader: {
      name: 'FloorReflector',
      uniforms: {
        color: { value: null },
        tDiffuse: { value: null },
        textureMatrix: { value: new THREE.Matrix4() },
        uBaseColor: { value: new THREE.Color('#15151a') },
        uReflectivity: { value: 0.6 },
        uFadeStart: { value: 2.0 },
        uFadeEnd: { value: 14.0 },
        uPolished: { value: 0.0 },
      },
      vertexShader,
      fragmentShader,
    },
  })
  reflector.rotation.x = -Math.PI / 2
  reflector.position.y = -0.005
  reflector.visible = false
  reflector.renderOrder = -1
  const mat = reflector.material as THREE.ShaderMaterial
  mat.transparent = true
  mat.premultipliedAlpha = true
  mat.depthWrite = false

  // Hide raster-only helpers during the reflection RT render (Reflector's onBeforeRender
  // renders the whole scene from the mirrored camera). Wrap the closure it installed.
  const orig = reflector.onBeforeRender
  reflector.onBeforeRender = function (renderer, scene, camera, geometry, material, group) {
    const hidden: THREE.Object3D[] = []
    scene.traverse((o) => {
      if (o !== reflector && o.visible && isRasterOnlyHelper(o)) { o.visible = false; hidden.push(o) }
    })
    try { orig.call(this, renderer, scene, camera, geometry, material, group) }
    finally { for (const o of hidden) o.visible = true }
  }
  return reflector
}

export function updateReflectorFloor(
  reflector: Reflector, mode: FloorMode, reflectivity: number, color: string,
): void {
  const u = (reflector.material as THREE.ShaderMaterial).uniforms
  u.uPolished.value = mode === 'polished' ? 1 : 0
  u.uReflectivity.value = Math.max(0, Math.min(1, reflectivity))
  ;(u.uBaseColor.value as THREE.Color).set(stripAlpha(color))
  ;(reflector.material as THREE.ShaderMaterial).transparent = mode !== 'polished'
}
```

- [ ] **Step 2: Wire it into the engine — construction**

In `engine.ts`, add the imports near :14:

```ts
import { createReflectorFloor, updateReflectorFloor } from './reflectorFloor'
import type { Reflector } from 'three/examples/jsm/objects/Reflector.js'
```

Add a field beside `cinematicFloor` (near engine.ts:612):

```ts
  private readonly reflectorFloor: Reflector
```

In the constructor, after `this.cinematicFloor` is built and before the `this.scene.add(...)` at :751, add:

```ts
    this.reflectorFloor = createReflectorFloor()
```

Change the scene-add at :751 to include it:

```ts
    this.scene.add(this.sun, this.ambient, this.grid, this.shadowGround, this.cinematicFloor, this.reflectorFloor)
```

- [ ] **Step 3: Wire it into `syncFromDoc`**

Extend the block written in Task 3 (engine.ts, right after `this.shadowGround.visible = fv.shadow`) to drive the reflector — replace the Task-3 placeholder comment lines with:

```ts
    // Raster Reflector: only when the mode asks for it and cinematic isn't owning the floor.
    this.reflectorFloor.visible = fv.reflector && !this._cinematic
    if (this.reflectorFloor.visible) {
      updateReflectorFloor(this.reflectorFloor, doc.floorMode, doc.floorReflectivity, doc.floorColor)
    }
```

- [ ] **Step 4: Keep the reflector out of the path trace**

The tracer already hides `isRasterOnlyHelper` objects, but the Reflector is a real Mesh, not a helper. Simplest correct rule: the reflector is never visible while cinematic is active (Step 3 gates on `!this._cinematic`), and `setCinematic` re-runs `syncFromDoc`. Confirm `setCinematic` calls `syncFromDoc(this.lastDoc)` (or equivalent) so toggling cinematic hides the reflector. If it does not, add after it sets `this._cinematic`:

```ts
    if (this.lastDoc) this.reflectorFloor.visible = false
```

Run: `grep -n "setCinematic" app/lib/scene3d/engine.ts` and read that method to place this correctly.

- [ ] **Step 5: Beauty-bake visibility (export)**

Find `renderPasses` (engine.ts — the beauty bake for export/thumbnails). It currently hides the grid for the bake and renders with the ground's current visibility (see the comment at engine.ts:1072-1074). The Reflector must RENDER in the beauty bake (Reflection is the hero export), but the grid must not. Read the hide/restore list in `renderPasses` and confirm: grid hidden, `shadowGround` per current behaviour, `reflectorFloor` left visible when its mode is active. If `renderPasses` builds a hide list via `collectEditorHelpers`, the Reflector is not in it (good — it stays visible). If it hides by a broad rule, explicitly keep the reflector visible. Add a one-line comment documenting the intent:

```ts
    // Reflector floor stays visible in the beauty bake (Reflection/Polished are export looks);
    // only the reference grid is hidden.
```

Run: `grep -n "renderPasses\|renderBeauty\|collectEditorHelpers\|grid.visible" app/lib/scene3d/engine.ts` and make the minimal edit that satisfies the above.

- [ ] **Step 6: Typecheck**

Run: `cd frontend && npx vue-tsc --noEmit -p tsconfig.json 2>&1 | grep -iE "reflector|floor|scene3d" | head`
Expected: no new floor/reflector errors.

- [ ] **Step 7: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor && IDX=$(mktemp /tmp/sailor-idx.XXXXXX) && cp .git/index "$IDX"
GIT_INDEX_FILE=$IDX git add frontend/app/lib/scene3d/reflectorFloor.ts frontend/app/lib/scene3d/engine.ts
GIT_INDEX_FILE=$IDX git commit -m "feat(scene3d): reflector floor — fading reflection + polished surface

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
rm -f "$IDX"
```

---

### Task 6: Live verification + transparent export

No new production code — this task proves the four modes in the real browser pane and captures screenshots for the user.

**Files:**
- (verification only; may add a Playwright spec under `frontend/tests/` if one fits the existing scene3d live-test pattern)

- [ ] **Step 1: Confirm a healthy dev server (do not start one from a subagent)**

Run: `lsof -nP -iTCP -sTCP:LISTEN | grep node` and confirm a server on `:3002` serving this checkout (`lsof -a -p <pid> -d cwd`). If healthy, use `http://127.0.0.1:3002` (not `localhost` — 426). If broken or absent, STOP and tell the user; do not start a competing server.

- [ ] **Step 2: Open the 3D Studio in the visible browser pane**

Use `preview_start`/`navigate` to the 3D Studio route with a scene that has one glossy object above y=0. The pane MUST be visible (hidden pane → paused rAF → black reflection).

- [ ] **Step 3: Exercise each mode**

For each of Off, Shadow only, Reflection, Polished: set the Floor control, then screenshot. Confirm by eye + console:
- Off: no grid, no shadow, clean float.
- Shadow only: grid + soft contact shadow (identical to old default).
- Reflection: a mirror image beneath the object fading out with distance; no hard floor edge.
- Polished: a visible glossy floor tinted by `floorColor`, reflecting the object.
Run `read_console_messages` — expect no shader-compile or WebGL errors.

- [ ] **Step 4: Reflectivity + colour controls**

In Reflection, drag `floorReflectivity` 0→1 and confirm the reflection strengthens. In Polished, confirm `floorColor` changes the surface and `floorReflectivity` changes the mirror strength. Confirm both controls are HIDDEN in Off and Shadow only.

- [ ] **Step 5: Cinematic parity**

Toggle Cinematic on in Reflection and Polished. Confirm: the path-traced floor shows a true reflection, no triangular moiré, and the reflector plane is not double-drawn. Use the `__scene3dCineHelperCheck` dev hook if present to confirm visible shadow-catcher count is 0.

- [ ] **Step 6: Transparent export**

Set background transparent, mode Reflection, export a PNG. Confirm the far field is transparent and the reflection band is present (open the PNG; check corner alpha = 0). Switch to Polished and confirm the floor fills the frame (documents the trade-off; the hint steers users to Reflection for transparent shots).

- [ ] **Step 7: Full suite + send proof**

Run: `cd frontend && npx vitest run tests/unit/scene3d-floor.unit.spec.ts tests/unit/scene3d-config.unit.spec.ts tests/unit/scene3d-controls.unit.spec.ts tests/unit/scene3d-raster-helper.unit.spec.ts`
Expected: all PASS.

Send the four mode screenshots + the transparent-export PNG to the user (SendUserFile). Do not claim success without the screenshots.

---

## Self-Review

**Spec coverage:**
- Data model (floorMode + reflectivity + color) → Task 2. ✓
- Lossless migration → Task 1 (`migrateFloorMode`) + Task 2 (sanitiser). ✓
- Four raster modes + Reflector fade/polished shader → Task 5. ✓
- Self-reflection/feedback guard (shared hide set) → Task 4 + Task 5 onBeforeRender wrap. ✓
- Cinematic mapping (material-only, moiré intact) → Task 3 (mapping) + Task 4 (predicate) + Task 6 (verify). ✓
- Transparent export (Reflection alpha; Polished trade-off + hint) → Task 5 (premultiplied) + Task 6. ✓
- UI in Background group, sentence-case optionLabels, `when` gating → Task 3. ✓
- Tests (config, gating, mapping, predicate, live) → Tasks 1–6. ✓
- Non-goals (blur, grid-as-toggle) → not implemented, as specified. ✓

**Placeholder scan:** none — every code step shows the code; verification steps name exact commands/hooks. Two spec "open details" (fade function = camera-space depth; RT resolution = 1024²/half-ish) are resolved to concrete values in Task 5.

**Type consistency:** `FloorMode`, `floorVisibility`, `cinematicFloorVisible`, `cinematicFloorRoughness`, `migrateFloorMode` (Task 1) are consumed with the same names/signatures in Tasks 2/3/5. `createReflectorFloor`/`updateReflectorFloor` (Task 5) match their call sites. `isRasterOnlyHelper` (Task 4) matches its use in Task 5 and PathTracer. Doc fields `floorMode`/`floorReflectivity`/`floorColor` are consistent across config, controls, panelPresentation, Vue, engine.

**Note for the implementer:** several tests reuse symbols already imported in the target spec files (`sanitizeSceneDoc`/`defaultDoc`/`SCENE_CONTROLS`). Confirm the exact exported names at the top of each existing spec before adding cases; match them rather than introducing new imports.
