# 3D Studio Shape Library Shelf Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Shape library…" row in 3D Studio's primitives menu opens the shared picker and extrudes the picked shape through the existing SVG import path.

**Architecture:** One pure helper turns a manifest shape into a one-path SVG string (fill = source colour). The surface hands that string to `importSvgSource`, which already parses, normalises, names, groups and selects. A flag gate in the surface's capture-phase Escape handler keeps Escape inside the picker from touching the scene or the modal.

**Tech Stack:** Nuxt 4 / Vue 3 / TypeScript, vitest (node), paper.js (already used by the importer at runtime).

Spec: `docs/superpowers/specs/2026-09-02-scene3d-shape-library-shelf-design.md`

## Global Constraints

- pnpm from `frontend/`; no new dependencies. Only typecheck errors naming touched files count.
- `shapeToSvg` output: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96"><path d="…" fill="…" fill-rule="…"/></svg>`, fill defaulting to `shape.sourceColor`.
- The surface inserts ONLY through `importSvgSource(svg, name)`; no new geometry path.
- Menu: a "Library" group appended after the existing `PRIM_GROUPS` groups, one row "Shape library…" (lucide `Shapes`), `data-testid="prim-menu-library"`.
- `closeAddMenus()` also closes the library picker; the `onKey` Escape branch returns early while the picker is open, BEFORE the menu check.
- Stage own files only; never `git add -A` (a parallel session has unrelated uncommitted edits); trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: `shapeToSvg` + import contract test

**Files:**
- Create: `frontend/app/lib/shapes/svg.ts`
- Test: `frontend/tests/unit/shapes-svg.unit.spec.ts` (new); `frontend/tests/unit/scene3d-svg-import.unit.spec.ts` (extend)

**Interfaces:**
- Produces: `shapeToSvg(shape: LibraryShape, opts?: { fill?: string }): string`.

- [ ] **Step 1: Failing tests**

`frontend/tests/unit/shapes-svg.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { shapeToSvg } from '../../app/lib/shapes/svg'
import { shapeById } from '../../app/lib/shapes/catalog'
import type { LibraryShape } from '../../shared/shape-library'

const tall: LibraryShape = { id: 'tall', name: 'Tall', d: 'M10,10L30,10L30,50L10,50Z', fillRule: 'evenodd', box: [10, 10, 20, 40], sourceColor: '#123456' }

describe('shapeToSvg', () => {
  it('wraps the manifest path in a 96-box SVG with the source colour and fill rule', () => {
    const svg = shapeToSvg(tall)
    expect(svg).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96"><path d="M10,10L30,10L30,50L10,50Z" fill="#123456" fill-rule="evenodd"/></svg>')
  })
  it('takes a fill override', () => {
    expect(shapeToSvg(tall, { fill: '#ffffff' })).toContain('fill="#ffffff"')
    expect(shapeToSvg(tall, { fill: '#ffffff' })).not.toContain('#123456')
  })
  it('round-trips a real manifest shape', () => {
    const s = shapeById('sparkle')!
    const svg = shapeToSvg(s)
    expect(svg).toContain(`d="${s.d}"`)
    expect(svg).toContain(`fill="${s.sourceColor}"`)
    expect(svg.startsWith('<svg ')).toBe(true); expect(svg.endsWith('</svg>')).toBe(true)
  })
})
```

Append to `frontend/tests/unit/scene3d-svg-import.unit.spec.ts` (inside the existing `describe`, reusing its `leaf` helper; add `import { shapeById } from '~/lib/shapes/catalog'`):

```ts
  it('a library shape imports as a group named after the shape with one svgPath child in its colour', () => {
    const s = shapeById('sparkle')!
    const objs = buildSvgObjects([leaf(s.d, s.sourceColor)], [], { name: s.name })
    expect(objs).toHaveLength(2)
    const group = objs.find((o) => o.kind === 'group')!
    expect(group.name).toBe('Sparkle')
    const child = objs.find((o) => o.id !== group.id) as PrimitiveObject
    expect(child.primitive).toBe('svgPath')
    expect(child.content?.d).toBe(s.d)
    expect(String(child.material?.color ?? (child as any).color ?? '').toLowerCase()).toBe(s.sourceColor.toLowerCase())
  })
```

(Read how `buildSvgObjects` seeds the colour — `make(d, fill, …)` → `createSvgPathObject(… { color })` — and adapt the last assertion to the real field path; the assertion must check the seeded colour, not just existence.)

Run: `cd frontend && pnpm vitest run tests/unit/shapes-svg.unit.spec.ts tests/unit/scene3d-svg-import.unit.spec.ts` — Expected: FAIL (module missing; new import test fails only if the colour path differs — fix the assertion path, not the importer).

- [ ] **Step 2: Implement**

`frontend/app/lib/shapes/svg.ts`:

```ts
/**
 * A library shape as a one-path SVG document — the string form every SVG
 * consumer in Sailor already accepts (3D Studio's importer today). The fill
 * defaults to the manifest's `sourceColor`: the one place that hint is worth
 * spending, because an extruded solid needs a starting material colour and the
 * drawing's own beats a default.
 */
import type { LibraryShape } from '~~/shared/shape-library'

export function shapeToSvg(shape: LibraryShape, opts: { fill?: string } = {}): string {
  const fill = opts.fill ?? shape.sourceColor
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96"><path d="${shape.d}" fill="${fill}" fill-rule="${shape.fillRule}"/></svg>`
}
```

- [ ] **Step 3: Run** the two files — PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/lib/shapes/svg.ts frontend/tests/unit/shapes-svg.unit.spec.ts frontend/tests/unit/scene3d-svg-import.unit.spec.ts
git commit -m "feat(shapes): shapeToSvg — a library shape as a one-path SVG (source colour as the seed)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The shelf in 3D Studio

**Files:**
- Modify: `frontend/app/components/vue-canvas/Scene3DStudioSurface.vue` (imports ~line 18–65; menu state ~340–372; `onKey` Escape branch ~1833; primitives menu template ~3536–3575)

**Interfaces:**
- Consumes: `shapeToSvg` (Task 1), `shapeById`, `ShapePicker` (`~/components/vue-canvas/studio/ShapePicker.vue`: props `modelValue`, `allowNone`, `anchor {x,y}`, `ignore?`; emits `update:modelValue`, `close`), `SHAPE_PICKER_WIDTH`, the existing `importSvgSource(source, name)`.

- [ ] **Step 1: Imports** — add `Shapes` to the lucide import list; add:

```ts
import ShapePicker from '~/components/vue-canvas/studio/ShapePicker.vue'
import { shapeById } from '~/lib/shapes/catalog'
import { shapeToSvg } from '~/lib/shapes/svg'
```

- [ ] **Step 2: State + handlers** — next to `primMenuOpen`:

```ts
/** The shape-library picker opened from the primitives menu's "Shape library…" row.
 *  Not a face: a library shape is not a PrimitiveKind, so the last-used face keeps
 *  pointing at a real primitive. */
const libraryPickerOpen = ref(false)
const libraryPickerAnchor = ref({ x: 0, y: 0 })
const primClusterRef = ref<HTMLElement | null>(null)
const LIBRARY_PICKER_APPROX_HEIGHT = 308 + 8   // the picker's panel plus a gap; it clamps itself if the guess is off
function openLibraryPicker() {
  const r = primClusterRef.value?.getBoundingClientRect()
  libraryPickerAnchor.value = r ? { x: r.left, y: Math.max(8, r.top - LIBRARY_PICKER_APPROX_HEIGHT) } : { x: 16, y: 16 }
  closeAddMenus()
  libraryPickerOpen.value = true
}
async function onLibraryPick(id: string) {
  const s = shapeById(id)
  if (!s) return
  await importSvgSource(shapeToSvg(s), s.name)
}
```

In `closeAddMenus()` add `libraryPickerOpen.value = false`. In `onKey`, as the FIRST statement of the `if (e.key === 'Escape') {` branch (the one that checks the four menus), add:

```ts
    // The shape-library picker owns Escape while open. Our capture listener runs
    // BEFORE the picker's (it registered later), so yielding here lets the picker
    // close itself and preventDefault, which the shell already honours.
    if (libraryPickerOpen.value) return
```

- [ ] **Step 3: Template** — add `ref="primClusterRef"` to the primitives cluster wrapper (the `relative` div that contains the face button, the chevron and the `prim-menu` popup). After the `v-for="group in PRIM_GROUPS"` block, still inside the `prim-menu` card, add:

```vue
                <div class="mb-1.5 last:mb-0">
                  <p class="mb-1 px-1 text-[10px] uppercase tracking-[0.12em] text-white/35">Library</p>
                  <button
                    type="button"
                    class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-white/80 transition-colors hover:bg-white/10 hover:text-white cursor-pointer"
                    data-testid="prim-menu-library"
                    @click="openLibraryPicker()"
                  >
                    <Shapes class="size-4 shrink-0 opacity-70" />
                    Shape library…
                  </button>
                </div>
```

After the `prim-menu` popup's closing `</div>` (still inside the cluster wrapper) add:

```vue
              <ShapePicker
                v-if="libraryPickerOpen"
                model-value="none"
                :allow-none="false"
                :anchor="libraryPickerAnchor"
                :ignore="primClusterRef"
                @update:model-value="onLibraryPick"
                @close="libraryPickerOpen = false"
              />
```

- [ ] **Step 4: Verify** — `pnpm nuxt typecheck 2>&1 | grep -E "Scene3DStudioSurface|shapes/svg" || echo "no new errors"` (list any line naming the surface and say whether it is on a touched line); `pnpm vitest run tests/unit/scene3d-toolbar-faces.unit.spec.ts tests/unit/shape-picker.unit.spec.ts tests/unit/shapes-svg.unit.spec.ts` green.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/components/vue-canvas/Scene3DStudioSurface.vue
git commit -m "feat(scene3d): Shape library… row in the primitives menu — the picked shape extrudes through the SVG import path

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Live verification (controller)

- [ ] Browser pane: open a project; start-modal "3D" craft; Edit. Primitives ▾ → "Shape library…" → Sparkle: a group "Sparkle" with an extruded path appears, selected, in the drawing's colour. Escape inside the picker leaves the studio open. Pick Sun rays: a second solid. Screenshot proof; reset viewport; stop the server.

## Self-review

Spec coverage: helper → Task 1; surface row/picker/gate → Task 2; live → Task 3; agent explicitly owed. Types: `shapeToSvg(shape, { fill? })`; `importSvgSource(source: string, name: string)` is the existing surface function.
