# Look Library Picker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the plain `Look` dropdown in 3D Studio's Lighting panel with a visual **library picker**: a popover gallery where every Look is a card showing a procedural lighting diagram (a shaded sphere plus the lights plotted at their real angles), grouped by family with Featured first and a search box — mirroring the existing shape-library picker exactly.

**Architecture:** A new `look` row kind, built the way the `shape` kind is: `RowLook.vue` (value side: thumbnail + name, opens the picker) registered in `rows/registry.ts`; `LookPicker.vue` (teleported, viewport-clamped popover with search, a group rail, and a card grid — a near-copy of `ShapePicker.vue`); and `LookPlot.vue`, a pure-SVG procedural diagram drawn from a `LookRecipe` and reused at thumbnail and card size. Recipes gain an optional `rim` position and a `blurb` so the diagram and card are data-driven. The control declaration flips from `select` to `kind: 'look'`; the `ControlSpec` union gains that kind.

**Tech Stack:** Nuxt 4, Vue 3.5, TypeScript, inline SVG, Tailwind, Vitest.

## Global Constraints

- **Mirror `ShapePicker.vue` / `RowShape.vue` / `pickerLayout.ts` conventions** — Teleport to body, fixed position clamped to the viewport, `anchor` + `ignore` props, close on Escape or outside `mousedown` (capture), the same dark panel styling (`bg-[#141414]`, `border-white/10`, `rounded-lg`, `text-[12px]`). Do not invent a second popover convention.
- **The plot is pure SVG drawn from recipe data** — no WebGL, no image assets, no `three` import. It must reuse `warmthToColor` from `~/lib/scene3d/lighting`.
- **Data-driven**: every Look's card, thumbnail, group, featured flag, rim, and blurb come from `LOOK_LIBRARY`. Adding a Look = adding a row of data.
- **Additive** to the schema: `lighting.look` keeps its key, label, default, and group; only its `kind` changes. `setControl`/`readControl` already handle it as a string — do not touch them.
- **Parity test must stay green**: update `tests/unit/scene3d-panel-parity.unit.spec.ts`'s ROW spec for `lighting.look` to the new kind.
- Frontend work in `frontend/`; dev server on `127.0.0.1`.

---

### Task 1: Recipe data — rim positions, blurbs, group labels

**Files:**
- Modify: `frontend/app/lib/scene3d/lighting.ts`
- Test: `frontend/tests/unit/scene3d-lighting.unit.spec.ts` (append)

**Interfaces:**
- Produces on `LookRecipe`: `rim?: { azimuth: number; elevation: number }`, `blurb: string`.
- Produces: `export const LOOK_GROUPS: ReadonlyArray<{ id: LookRecipe['group']; label: string }>` in display order, and `export function looksInGroup(id: LookRecipe['group']): LookRecipe[]`, `export function featuredLooks(): LookRecipe[]`, `export function searchLooks(q: string): LookRecipe[]` (case-insensitive over label + blurb + group label; empty query returns all).

- [ ] **Step 1: Write the failing tests**

Append to `frontend/tests/unit/scene3d-lighting.unit.spec.ts`:

```ts
import { LOOK_GROUPS, looksInGroup, featuredLooks, searchLooks } from '~/lib/scene3d/lighting'

describe('look library metadata for the picker', () => {
  it('every look has a non-empty blurb', () => {
    for (const r of LOOK_LIBRARY) expect(r.blurb.length, r.id).toBeGreaterThan(3)
  })
  it('rim positions, where present, are valid angles', () => {
    for (const r of LOOK_LIBRARY) if (r.rim) {
      expect(r.rim.azimuth).toBeGreaterThanOrEqual(0); expect(r.rim.azimuth).toBeLessThanOrEqual(360)
      expect(r.rim.elevation).toBeGreaterThanOrEqual(5); expect(r.rim.elevation).toBeLessThanOrEqual(90)
    }
    expect(getLook('rim-on-dark').rim).toBeTruthy()
    expect(getLook('three-point').rim).toBeTruthy()
  })
  it('groups cover every look exactly once, in display order', () => {
    expect(LOOK_GROUPS.map(g => g.id)).toEqual(['product', 'portrait', 'cinematic', 'natural'])
    const all = LOOK_GROUPS.flatMap(g => looksInGroup(g.id).map(l => l.id))
    expect(all.length).toBe(LOOK_LIBRARY.length)
    expect(new Set(all).size).toBe(LOOK_LIBRARY.length)
  })
  it('featuredLooks returns the eight featured; searchLooks filters by label/blurb', () => {
    expect(featuredLooks().length).toBe(8)
    expect(searchLooks('').length).toBe(LOOK_LIBRARY.length)
    expect(searchLooks('golden').map(l => l.id)).toEqual(['golden-hour'])
    expect(searchLooks('SNEAKER').some(l => l.id === 'rim-on-dark')).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/scene3d-lighting.unit.spec.ts -t "picker"`
Expected: FAIL — `LOOK_GROUPS` not exported / `blurb` undefined.

- [ ] **Step 3: Implement**

In `lighting.ts`, extend the interface (add after `ambient: number`):

```ts
  /** An extra edge light behind the subject, for looks that have one. Drawn by the
   *  picker's plot; a future rig phase turns it into a real light object. */
  rim?: { azimuth: number; elevation: number }
  /** One line for the picker card — what the look is FOR, in the user's words. */
  blurb: string
```

Add a `blurb` to every recipe and a `rim` to the five that have one. Exact values (append the `blurb` field to each existing row; add `rim` only where listed):

| id | blurb | rim |
|---|---|---|
| softbox-beauty | clean catalog hero shot | — |
| ecommerce-flat | honest, even, shadow-light catalog | — |
| rim-on-dark | premium tech or sneaker, glowing edge on black | `{ azimuth: 200, elevation: 35 }` |
| hard-single-key | editorial, crisp shadow, shows texture | — |
| two-tone-gels | modern two-colour hype look | — |
| three-point | the universal balanced base | `{ azimuth: 180, elevation: 45 }` |
| light-tent | glossy, reflective goods, near shadowless | — |
| backlit | glow and translucency (gum soles, mesh) | — |
| rembrandt | dramatic character, one-source drama | `{ azimuth: 190, elevation: 50 }` |
| loop | everyday flattering portrait light | — |
| butterfly | glamour beauty, symmetric and soft | — |
| clamshell | cosmetics and skin, wrapping soft light | — |
| split | moody half-lit edge | — |
| broad-short | widen or slim the face | — |
| rim-hair | adds edge separation behind the subject | — |
| motivated | naturalistic, one believable source | — |
| low-key-noir | tension, deep blacks, hard shadow | — |
| high-key | airy, bright, near shadowless | — |
| chiaroscuro | painterly extreme light and dark | — |
| silhouette | shape only, subject unlit | — |
| top-light | ominous, sculptural, straight down | — |
| underlight | unsettling light from below | — |
| edge-on-black | logo or tech reveal, rim only | `{ azimuth: 195, elevation: 40 }` |
| golden-hour | warm, low, cinematic, long soft shadow | `{ azimuth: 200, elevation: 20 }` |
| overcast | flattering, soft, shadowless, no-fuss | — |
| blue-hour | cool, quiet twilight | — |
| hard-noon | punchy realism, short hard shadow | — |
| window-light | classic soft interior light | — |
| sunset-backlight | warm rim glow from behind | — |
| moonlight | cool stylised night | — |
| firelight | intimate warm glow from below | — |

Then add after `getLook`:

```ts
export const LOOK_GROUPS: ReadonlyArray<{ id: LookRecipe['group']; label: string }> = [
  { id: 'product',   label: 'Product & commercial' },
  { id: 'portrait',  label: 'Portrait & beauty' },
  { id: 'cinematic', label: 'Cinematic & mood' },
  { id: 'natural',   label: 'Natural & time of day' },
]

export function looksInGroup(id: LookRecipe['group']): LookRecipe[] {
  return LOOK_LIBRARY.filter(l => l.group === id)
}

export function featuredLooks(): LookRecipe[] {
  return LOOK_LIBRARY.filter(l => l.featured)
}

/** Case-insensitive match over label, blurb and group label. Empty query = everything. */
export function searchLooks(q: string): LookRecipe[] {
  const s = q.trim().toLowerCase()
  if (!s) return [...LOOK_LIBRARY]
  const groupLabel = (g: LookRecipe['group']) => LOOK_GROUPS.find(x => x.id === g)?.label ?? ''
  return LOOK_LIBRARY.filter(l =>
    l.label.toLowerCase().includes(s) || l.blurb.toLowerCase().includes(s) || groupLabel(l.group).toLowerCase().includes(s),
  )
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/scene3d-lighting.unit.spec.ts`
Expected: PASS (7 existing + 4 new).

- [ ] **Step 5: Commit**

```bash
cd frontend && git add app/lib/scene3d/lighting.ts tests/unit/scene3d-lighting.unit.spec.ts
git commit -m "feat(scene3d): look recipes gain rim, blurb, groups and search for the picker

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `LookPlot.vue` — the procedural lighting diagram

**Files:**
- Create: `frontend/app/components/vue-canvas/studio/LookPlot.vue`

**Interfaces:**
- Props: `recipe: LookRecipe`, `size?: number` (default 72). Renders one `<svg>` of `size × size`.
- Consumes: `warmthToColor` from `~/lib/scene3d/lighting`.

**Design of the drawing** (viewBox `0 0 100 100`, camera implied at the bottom, looking at a sphere):
- Angles: azimuth 0 = behind camera (front), increasing clockwise around the subject; a light's ring position is `x = 50 + R·sin(az)`, `y = 52 + R·cos(az)·0.45` (foreshortened ring: front = bottom, behind = top), then lifted by elevation `y -= (el/90)·14`. `R = 40`.
- **Sphere** at `(50,52)`, radius 26, shaded by a radial gradient whose focal point sits where the key hits: `hx = 50 + 26·0.7·sin(az)·cos(el)`, `hy = 52 − 26·0.7·sin(el)`. Front-lit-ness `lit = max(0.15, 0.5 + 0.5·cos(az))` scales the highlight; softness sets the gradient spread (soft → highlight stop at 0.85 and gentle falloff; hard → stop at 0.35 with a darker terminator). Highlight colour = `warmthToColor(warmth)`; shadow side `#1b2230`.
- **Key light icon** at its ring position: soft (`softness ≥ 0.55`) → rounded rect `w=14,h=9,rx=2.5` (a softbox); hard → circle `r=3.5` with a tiny ray tick. Fill = `warmthToColor(warmth)`.
- **Rim icon** (if `recipe.rim`): same placement math, `r=2.6` circle, opacity 0.75, white-ish. Also stroke the sphere's upper edge with a thin light arc when a rim exists or `az > 100`.
- **Fill glow**: if `ambient ≥ 0.3`, a faint circle (`r=7`, opacity `0.12 + 0.25·min(1,ambient)`) opposite the key at `az+180`, no elevation lift.
- **Contact shadow**: ellipse at `(50 − 6·sin(az), 83)`, `rx=20, ry=4.5`, opacity `0.55·(1 − 0.5·softness)·(1 − 0.4·min(1,ambient))`.
- **Camera notch**: small upward triangle at `(50, 97)`.
- Background: none (transparent) — the host card supplies it.

- [ ] **Step 1: Create the component**

```vue
<script setup lang="ts">
// Procedural lighting diagram for one Look: a shaded sphere with the lights plotted
// at their real angles. Pure SVG from recipe data — no WebGL, no assets — so it stays
// exact for all 31 looks and re-draws itself if a recipe changes.
import { computed } from 'vue'
import { warmthToColor, type LookRecipe } from '~/lib/scene3d/lighting'

const props = withDefaults(defineProps<{ recipe: LookRecipe; size?: number }>(), { size: 72 })

const rad = (d: number) => (d * Math.PI) / 180
const R = 40
const CX = 50, CY = 52, SR = 26

function ringPos(az: number, el: number) {
  const a = rad(az)
  return { x: CX + R * Math.sin(a), y: CY + R * Math.cos(a) * 0.45 - (el / 90) * 14 }
}

const key = computed(() => ringPos(props.recipe.azimuth, props.recipe.elevation))
const rim = computed(() => props.recipe.rim ? ringPos(props.recipe.rim.azimuth, props.recipe.rim.elevation) : null)
const fill = computed(() => props.recipe.ambient >= 0.3 ? ringPos(props.recipe.azimuth + 180, 0) : null)

const soft = computed(() => props.recipe.softness >= 0.55)
const tint = computed(() => warmthToColor(props.recipe.warmth))
const lit = computed(() => Math.max(0.15, 0.5 + 0.5 * Math.cos(rad(props.recipe.azimuth))))
const hx = computed(() => CX + SR * 0.7 * Math.sin(rad(props.recipe.azimuth)) * Math.cos(rad(props.recipe.elevation)))
const hy = computed(() => CY - SR * 0.7 * Math.sin(rad(props.recipe.elevation)))
const highlightStop = computed(() => soft.value ? 0.85 : 0.35)
const edgeLit = computed(() => !!props.recipe.rim || props.recipe.azimuth > 100)
const shadowOpacity = computed(() =>
  0.55 * (1 - 0.5 * props.recipe.softness) * (1 - 0.4 * Math.min(1, props.recipe.ambient)))
const fillOpacity = computed(() => 0.12 + 0.25 * Math.min(1, props.recipe.ambient))
// Unique gradient id per instance so several plots on one page never share a <defs> entry.
const gid = `lookplot-${Math.random().toString(36).slice(2, 9)}`
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 100 100" aria-hidden="true" class="block">
    <defs>
      <radialGradient :id="gid" gradientUnits="userSpaceOnUse" :cx="hx" :cy="hy" :fx="hx" :fy="hy" r="34">
        <stop offset="0" :stop-color="tint" :stop-opacity="lit" />
        <stop :offset="highlightStop" :stop-color="tint" :stop-opacity="lit * 0.35" />
        <stop offset="1" stop-color="#1b2230" stop-opacity="1" />
      </radialGradient>
    </defs>

    <!-- fill glow, opposite the key -->
    <circle v-if="fill" :cx="fill.x" :cy="fill.y" r="7" :fill="tint" :fill-opacity="fillOpacity" />

    <!-- contact shadow, cast away from the key -->
    <ellipse :cx="50 - 6 * Math.sin((recipe.azimuth * Math.PI) / 180)" cy="83" rx="20" ry="4.5" fill="#000" :fill-opacity="shadowOpacity" />

    <!-- the subject -->
    <circle :cx="CX" :cy="CY" :r="SR" fill="#1b2230" />
    <circle :cx="CX" :cy="CY" :r="SR" :fill="`url(#${gid})`" />
    <!-- edge light when lit from behind or a rim exists -->
    <path v-if="edgeLit" d="M 27 44 A 26 26 0 0 1 73 44" fill="none" stroke="#dfe7ff" stroke-width="1.6" stroke-opacity="0.75" stroke-linecap="round" />

    <!-- rim light -->
    <circle v-if="rim" :cx="rim.x" :cy="rim.y" r="2.6" fill="#e8eeff" fill-opacity="0.8" />

    <!-- key light: softbox rect when soft, point when hard -->
    <rect v-if="soft" :x="key.x - 7" :y="key.y - 4.5" width="14" height="9" rx="2.5" :fill="tint" />
    <g v-else>
      <circle :cx="key.x" :cy="key.y" r="3.5" :fill="tint" />
      <line :x1="key.x" :y1="key.y - 6.5" :x2="key.x" :y2="key.y - 4.6" :stroke="tint" stroke-width="1.2" stroke-linecap="round" />
    </g>

    <!-- camera -->
    <path d="M 46 99 L 50 93 L 54 99 Z" fill="#8a94a6" fill-opacity="0.9" />
  </svg>
</template>
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx vue-tsc --noEmit -p tsconfig.json 2>&1 | grep -i "LookPlot" || echo "no new errors in LookPlot"`
Expected: `no new errors in LookPlot`.

- [ ] **Step 3: Commit**

```bash
cd frontend && git add app/components/vue-canvas/studio/LookPlot.vue
git commit -m "feat(scene3d): LookPlot — procedural lighting diagram from a Look recipe

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `LookPicker.vue` — the popover library

**Files:**
- Create: `frontend/app/components/vue-canvas/studio/LookPicker.vue`
- Modify: `frontend/app/lib/shapes/pickerLayout.ts` (add `LOOK_PICKER_WIDTH`)

**Interfaces:**
- Props: `modelValue: string`, `anchor: { x: number; y: number }`, `ignore?: HTMLElement | null`.
- Emits: `update:modelValue(id: string)`, `close()`.
- Consumes: `LOOK_LIBRARY`, `LOOK_GROUPS`, `looksInGroup`, `featuredLooks`, `searchLooks`, `getLook` from `~/lib/scene3d/lighting`; `LookPlot`.

- [ ] **Step 1: Add the width constant**

Append to `frontend/app/lib/shapes/pickerLayout.ts`:

```ts
// The Look library is wider than the shape picker: 4 card columns (~104px each) + the group rail.
export const LOOK_PICKER_WIDTH = 540
```

- [ ] **Step 2: Create the picker**

Mirror `ShapePicker.vue`'s structure (Teleport, clamp on mount, Escape + outside-mousedown close, `ignore`). Differences: a rail of **Featured + the four groups** (Featured is the default), a **4-column card grid**, each card = `LookPlot` (72px) + label + blurb, current card highlighted, additive looks badged `+`. Search overrides the rail when non-empty.

```vue
<script setup lang="ts">
/**
 * The Look library picker — the visual replacement for the Lighting panel's Look
 * dropdown. Same popover conventions as ShapePicker (teleported, viewport-clamped,
 * Escape / click-outside to close, `ignore` for the trigger). Every card is drawn
 * from its LookRecipe by LookPlot, so the library is data, not images.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { LOOK_GROUPS, featuredLooks, looksInGroup, searchLooks, type LookRecipe } from '~/lib/scene3d/lighting'
import { LOOK_PICKER_WIDTH } from '~/lib/shapes/pickerLayout'
import LookPlot from './LookPlot.vue'

const props = defineProps<{
  modelValue: string
  anchor: { x: number; y: number }
  ignore?: HTMLElement | null
}>()
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void; (e: 'close'): void }>()

type RailId = 'featured' | LookRecipe['group']
const query = ref('')
const rail = ref<RailId>('featured')
const railItems = computed(() => [{ id: 'featured' as RailId, label: 'Featured' }, ...LOOK_GROUPS.map(g => ({ id: g.id as RailId, label: g.label }))])

/** Search wins over the rail: a typed query searches the whole library. */
const visible = computed<LookRecipe[]>(() => {
  if (query.value.trim()) return searchLooks(query.value)
  if (rail.value === 'featured') return featuredLooks()
  return looksInGroup(rail.value)
})

function pick(id: string) { emit('update:modelValue', id); emit('close') }

const rootRef = ref<HTMLDivElement | null>(null)
const searchRef = ref<HTMLInputElement | null>(null)
const pos = ref({ x: props.anchor.x, y: props.anchor.y })
onMounted(() => {
  nextTick(() => {
    const el = rootRef.value
    if (!el) return
    const r = el.getBoundingClientRect()
    let x = props.anchor.x, y = props.anchor.y
    if (x + r.width + 8 > window.innerWidth) x = Math.max(8, window.innerWidth - r.width - 8)
    if (y + r.height + 8 > window.innerHeight) y = Math.max(8, window.innerHeight - r.height - 8)
    pos.value = { x: Math.max(8, x), y: Math.max(8, y) }
    searchRef.value?.focus()
  })
})
function onKeydown(e: KeyboardEvent) { if (e.key === 'Escape') { e.preventDefault(); emit('close') } }
function onOutside(e: MouseEvent) {
  const t = e.target as Node
  if (rootRef.value?.contains(t)) return
  if (props.ignore?.contains(t)) return
  emit('close')
}
onMounted(() => { window.addEventListener('keydown', onKeydown, true); window.addEventListener('mousedown', onOutside, true) })
onBeforeUnmount(() => { window.removeEventListener('keydown', onKeydown, true); window.removeEventListener('mousedown', onOutside, true) })

const card = 'flex flex-col items-center gap-1 rounded-md p-1.5 text-center transition-colors'
const cardIdle = 'hover:bg-white/[0.07]'
const cardOn = 'bg-white/[0.12] ring-1 ring-white/40'
</script>

<template>
  <Teleport to="body">
    <div
      ref="rootRef"
      class="fixed z-[210] rounded-lg border border-white/10 bg-[#141414] p-2 text-[12px] text-white/90 shadow-2xl"
      :style="{ left: `${pos.x}px`, top: `${pos.y}px`, width: `${LOOK_PICKER_WIDTH}px` }"
      role="dialog"
      aria-label="Choose a lighting look"
    >
      <input
        ref="searchRef"
        v-model="query"
        type="search"
        placeholder="Search looks — softbox, rim, golden hour…"
        spellcheck="false"
        class="mb-2 h-7 w-full rounded-[6px] bg-white/[0.06] px-2 text-[11px] text-white/90 outline-none placeholder:text-white/30 focus:bg-white/[0.10]"
      />
      <div class="flex gap-2">
        <div class="flex w-28 shrink-0 flex-col gap-0.5">
          <button
            v-for="r in railItems" :key="r.id" type="button"
            class="rounded px-2 py-1 text-left text-[11px] transition-colors"
            :class="rail === r.id && !query.trim() ? 'bg-white text-neutral-900' : 'text-white/55 hover:bg-white/10 hover:text-white/90'"
            @click="rail = r.id; query = ''"
          >{{ r.label }}</button>
        </div>
        <div class="grid max-h-[340px] flex-1 grid-cols-4 content-start gap-1 overflow-y-auto pr-1" role="listbox" aria-label="Looks">
          <button
            v-for="l in visible" :key="l.id" type="button" role="option" :data-look="l.id"
            :aria-selected="modelValue === l.id ? 'true' : 'false'"
            :title="l.blurb"
            :class="[card, modelValue === l.id ? cardOn : cardIdle]"
            @click="pick(l.id)"
          >
            <span class="relative rounded-md bg-[#0d1016] p-1">
              <LookPlot :recipe="l" :size="72" />
              <span v-if="l.additive" class="absolute right-1 top-1 rounded bg-white/15 px-1 text-[9px] leading-4 text-white/80" title="Adds to the current look">+</span>
              <span v-if="l.featured" class="absolute left-1 top-1 text-[10px] leading-4 text-amber-300/90" title="Featured">★</span>
            </span>
            <span class="w-full truncate text-[11px] leading-tight text-white/90">{{ l.label }}</span>
            <span class="w-full truncate text-[9.5px] leading-tight text-white/45">{{ l.blurb }}</span>
          </button>
          <p v-if="!visible.length" class="col-span-4 py-6 text-center text-[11px] text-white/40">No looks match.</p>
        </div>
      </div>
    </div>
  </Teleport>
</template>
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npx vue-tsc --noEmit -p tsconfig.json 2>&1 | grep -iE "LookPicker|pickerLayout" || echo "no new errors"`
Expected: `no new errors`.

- [ ] **Step 4: Commit**

```bash
cd frontend && git add app/components/vue-canvas/studio/LookPicker.vue app/lib/shapes/pickerLayout.ts
git commit -m "feat(scene3d): LookPicker — the Look library popover (featured, groups, search, plotted cards)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `RowLook.vue` + registry + control kind + parity test

**Files:**
- Create: `frontend/app/components/vue-canvas/studio/rows/RowLook.vue`
- Modify: `frontend/app/components/vue-canvas/studio/rows/registry.ts`
- Modify: `frontend/app/lib/spacetype/effect.ts` (the `ControlSpec` union, next to the `shape` variant ~line 109)
- Modify: `frontend/app/lib/scene3d/controls.ts` (the `lighting.look` declaration)
- Modify: `frontend/tests/unit/scene3d-panel-parity.unit.spec.ts` (the `lighting.look` ROW spec)

**Interfaces:**
- `RowLook` has the standard value-side contract: props `{ value: string | number | boolean; spec: ControlSpec; step: number; editing: boolean }`, emits `update:value(v: string)` — identical to `RowShape`.
- `ControlSpec` gains `| { key: string; label: string; kind: 'look'; default: string; group: string }`.

- [ ] **Step 1: Add the `look` kind to the union**

In `frontend/app/lib/spacetype/effect.ts`, directly after the `shape` variant line (`| { key: string; label: string; kind: 'shape'; default: string; allowNone?: boolean; group: string }`), add:

```ts
  | { key: string; label: string; kind: 'look'; default: string; group: string }
```

- [ ] **Step 2: Create the row**

```vue
<script setup lang="ts">
// Value side of a `look` row: the current Look as a small plotted thumbnail plus
// its name, which opens the LookPicker under the row. Mirrors RowShape exactly.
import { computed, ref } from 'vue'
import type { ControlSpec } from '~/lib/spacetype/effect'
import { getLook } from '~/lib/scene3d/lighting'
import { LOOK_PICKER_WIDTH } from '~/lib/shapes/pickerLayout'
import LookPlot from '../LookPlot.vue'
import LookPicker from '../LookPicker.vue'

const props = defineProps<{ value: string | number | boolean; spec: ControlSpec; step: number; editing: boolean }>()
const emit = defineEmits<{ (e: 'update:value', v: string): void }>()

const current = computed(() => getLook(String(props.value)))
const open = ref(false)
const anchor = ref({ x: 0, y: 0 })
const btnRef = ref<HTMLButtonElement | null>(null)

// The button is passed to the picker as `ignore`, so a press on it is not an
// outside click; this toggle is the only thing that decides open/closed.
function togglePicker() {
  if (open.value) { open.value = false; return }
  const el = btnRef.value
  if (!el) return
  const r = el.getBoundingClientRect()
  anchor.value = { x: r.right - LOOK_PICKER_WIDTH, y: r.bottom + 4 }
  open.value = true
}
</script>

<template>
  <span class="contents">
    <button
      ref="btnRef"
      type="button"
      :aria-label="spec.label"
      class="flex h-6 items-center gap-1.5 rounded-[6px] px-1.5 text-[11px] text-white/90 transition-colors hover:bg-white/[0.06]"
      @pointerdown.stop
      @click="togglePicker"
    >
      <span class="rounded-[4px] bg-[#0d1016]"><LookPlot :recipe="current" :size="18" /></span>
      <span>{{ current.label }}</span>
      <span class="text-white/40" aria-hidden="true">▾</span>
    </button>
    <LookPicker
      v-if="open"
      :model-value="String(value)"
      :anchor="anchor"
      :ignore="btnRef"
      @update:model-value="(v: string) => emit('update:value', v)"
      @close="open = false"
    />
  </span>
</template>
```

- [ ] **Step 3: Register the kind**

In `registry.ts`: add `import RowLook from './RowLook.vue'` and the entry `look: RowLook,` in `rowRenderers`.

- [ ] **Step 4: Flip the control declaration**

In `frontend/app/lib/scene3d/controls.ts`, replace
```ts
  select('lighting.look', 'Look', LOOK_LIBRARY.map((l) => l.id), D.lighting.look, 'Lighting'),
```
with
```ts
  // A `look` row: thumbnail + name that opens the Look library picker (RowLook/LookPicker).
  { key: 'lighting.look', label: 'Look', kind: 'look', default: D.lighting.look, group: 'Lighting' } as SceneControl,
```
If `LOOK_LIBRARY` is now unused in `controls.ts`, remove its import to keep the file lint-clean.

- [ ] **Step 5: Update the parity ROW spec**

In the parity test, change
```ts
  'lighting.look': { label: 'Look', kind: 'select', options: LOOK_LIBRARY.map((l) => l.id) },
```
to
```ts
  'lighting.look': { label: 'Look', kind: 'look' },
```
and remove the now-unused `LOOK_LIBRARY` import from the test if nothing else uses it.

- [ ] **Step 6: Verify**

Run: `cd frontend && npx vitest run tests/unit/scene3d-panel-parity.unit.spec.ts tests/unit/scene3d-lighting.unit.spec.ts 2>&1 | grep -E "Tests |Test Files"`
Expected: both files pass (parity 130, lighting 11).

Run: `cd frontend && npx vue-tsc --noEmit -p tsconfig.json 2>&1 | grep -iE "RowLook|registry|effect.ts|controls.ts|parity" || echo "no new errors in touched files"`
Expected: `no new errors in touched files`.

- [ ] **Step 7: Commit**

```bash
cd frontend && git add app/components/vue-canvas/studio/rows/RowLook.vue app/components/vue-canvas/studio/rows/registry.ts app/lib/spacetype/effect.ts app/lib/scene3d/controls.ts tests/unit/scene3d-panel-parity.unit.spec.ts
git commit -m "feat(scene3d): Look row opens the visual Look library instead of a dropdown

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Live verification (controller)

- [ ] Reload the dev server pane, open a 3D node's editor.
- [ ] The Lighting panel's **Look** row shows a small plotted thumbnail + the look's name + a caret (not a native select).
- [ ] Click it: the library popover opens under the row, clamped to the viewport, **Featured** selected by default with 8 cards, each showing a plotted sphere + lights, name, blurb; the current look is highlighted; additive looks carry a `+`.
- [ ] Click **Product & commercial** → 8 cards; type "golden" → 1 card regardless of rail.
- [ ] Pick **Rim on dark** → picker closes, row updates, viewport lighting changes; the card's plot showed the key and a rim behind.
- [ ] Escape and outside-click both close it; `read_console_messages` shows no errors.

## Self-Review

**Spec coverage:** visual library (Task 3), images that explain the preset and light placement (Task 2's plot: shaded sphere = effect, plotted icons = placement, data-driven from Task 1's rim/blurb), grouped + featured + searchable (Task 1 helpers + Task 3 rail/search), replaces the dropdown (Task 4).

**Placeholder scan:** none — every component and data table is written out.

**Type consistency:** `LookRecipe.rim`/`blurb` (Task 1) are read by `LookPlot` (Task 2) and `LookPicker` (Task 3); `LOOK_GROUPS`/`featuredLooks`/`looksInGroup`/`searchLooks` (Task 1) are consumed verbatim in Task 3; `LOOK_PICKER_WIDTH` (Task 3) is used by `RowLook` (Task 4); the `look` kind (Task 4) is what `controls.ts` declares and the registry resolves.

## Flagged follow-ons

- **Taste pass** on the plot geometry (icon sizes, sphere shading curve, card density) — best judged with your eyes on real cards.
- **Rig phase**: the `rim` field now stored on recipes is the seed for real rim light objects later.
- Optional: hover-to-preview (apply a look on hover, revert on leave) once the basics feel right.
