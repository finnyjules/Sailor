# Frame Inspector — Colour Rows and Section Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (1) The Colours section shows the frame's colours as Figma-style rows — swatch, editable hex, opacity — where the swatch opens the house colour picker and any change rewrites that colour everywhere it is used. (2) Every block of the Frame's Design tab sits in a `StudioSection` card, so the inspector reads as separated sections instead of a run of grey labels.

**Architecture:** Alpha plumbing in the pure recolour modules (`slots.ts` learns a slot's uniform alpha, `sites.ts`'s `set` accepts an alpha override, `apply.ts`'s `recolourSlot` takes an optional alpha). `ColourSlots.vue` is rewritten as rows over `StudioColor`. The modal's two Design-tab branches get wrapped in `StudioSection` cards, markup only, in two separate by-hunk commits (nothing selected; a layer selected).

**Tech Stack:** Vue 3 / Nuxt 4 / TypeScript, Vitest, Playwright. `StudioSection` (`~/components/vue-canvas/StudioSection.vue`, props `title`, `badge?`, `open?`), `StudioColor` (`~/components/vue-canvas/studio/StudioColor.vue`, `defineModel<string>` — emits 8-digit hex when alpha < 1, 6-digit otherwise), `parseHexA`/`withAlpha`/`isHex` (`~/lib/color/convert`).

## Global Constraints

- **Structure preserved:** a slot edit rewrites every use of that colour; alpha per use is kept unless the opacity field is edited, in which case every use takes the new alpha. Own undo step (`recordHistory(); commit(layers); editor.writeBackground(bg)`), image gradient maps untouched.
- **Rows:** heaviest first; row `data-testid="colour-slot"` + `data-hex`; hex input `colour-slot-hex`; opacity input `colour-slot-alpha` (read-only with value `Mixed` when the slot's uses differ in alpha). Invalid hex reverts on blur. UI copy sentence case; no identifiers.
- **Cards:** `StudioSection` with `open` default; titles exactly: nothing selected → Background, Colours, Post-processing, Grid, Arrange; layer selected → Text, Fill and outline, Style, Image, Transform, Distort and blend, Mask and crop. The layer-name row stays above the cards. Effect-row and outline-row branches untouched. **Markup only**: no `@update`, `v-model`, `:model-value`, default, or copy inside a block changes; the by-hunk diff must show only wrapper open/close tags, the removal of the block's own top `panel-label`/hairline, and indentation.
- **Existing tests stay green:** `frontend/tests/frame-recolour.spec.ts`, `frame-layout-tab.spec.ts`, `frame-templates.spec.ts`, and the multi-stroke spec (`ls frontend/tests | grep -i stroke`) against the running dev server for this checkout (`http://127.0.0.1:3002`, `PW_BASE_URL`; never start another).
- **Commit hygiene (shared checkout):** whole private-index recipe in ONE shell call; `CompositorModal.vue` BY HUNK (`git diff -- <file> > /tmp/cm.diff`, trim, `git apply --cached`; resync `git reset -q -- <file>`); separate-call status check; never `git add -A`/`.`/`git stash`/`cp .git/index`.

---

## File Structure

- `frontend/app/lib/compositor/recolour/sites.ts` (modify) — `set(root, hex, alpha?)`.
- `frontend/app/lib/compositor/recolour/slots.ts` (modify) — `Slot.alpha: string | 'mixed'`.
- `frontend/app/lib/compositor/recolour/apply.ts` (modify) — `recolourSlot(..., alpha?)`.
- `frontend/app/components/vue-canvas/compositor/ColourSlots.vue` (rewrite) — rows.
- `frontend/app/components/vue-canvas/CompositorModal.vue` (modify, by hunk, three commits) — `reassignSlot` signature; no-selection cards; layer cards.
- Tests: `frontend/tests/unit/recolour-sites.unit.spec.ts`, `recolour-map.unit.spec.ts`, `recolour-apply.unit.spec.ts` (extend); `frontend/tests/frame-recolour.spec.ts` (update the reassign case, add an opacity case).

---

### Task 1: Alpha plumbing (pure)

**Files:**
- Modify: `frontend/app/lib/compositor/recolour/sites.ts`, `slots.ts`, `apply.ts`
- Test: extend `frontend/tests/unit/recolour-sites.unit.spec.ts`, `recolour-map.unit.spec.ts` (slots live there), `recolour-apply.unit.spec.ts`

**Interfaces:**
- `ColourSite.set: (root, hex, alpha?: string) => void` — when `alpha` is given it replaces the captured one; `'ff'` (or `undefined` after normalisation) writes a 6-digit hex; the `join` helper becomes `join(hex, alpha)` → `alpha && alpha !== 'ff' ? hex + alpha : hex`.
- `Slot.alpha: string | 'mixed'` — `'ff'` when every site's `alpha` is undefined or `'ff'`; the shared two-digit value when uniform; `'mixed'` otherwise.
- `recolourSlot(layers, background, slotHex, toHex, frameAspect, alpha?: string)` — when `alpha` is given, every site of the slot is written with it.
- `recolourFrame` unchanged (family applies keep per-use alpha).

- [ ] **Step 1: Write the failing tests**

Append to `recolour-sites.unit.spec.ts`:
```ts
describe('site.set with an alpha override', () => {
  it('replaces the captured alpha, and ff writes a 6-digit hex', () => {
    const layers: any[] = [{ id: 'r', kind: 'rect', x: .5, y: .5, w: .4, h: .2, rotation: 0, opacity: 1, fill: '#ff000080', stroke: '', strokeWidth: 0 }]
    const [site] = colourSites(layers as any, undefined, 1)
    const c1 = JSON.parse(JSON.stringify(layers[0])); site!.set(c1, '#123456', '40'); expect(c1.fill).toBe('#12345640')
    const c2 = JSON.parse(JSON.stringify(layers[0])); site!.set(c2, '#123456', 'ff'); expect(c2.fill).toBe('#123456')
    const c3 = JSON.parse(JSON.stringify(layers[0])); site!.set(c3, '#123456'); expect(c3.fill).toBe('#12345680')   // no override → captured alpha kept
  })
})
```
Append to `recolour-map.unit.spec.ts` (the `slotsOf` describe):
```ts
  it('reports a slot\'s alpha: ff when opaque, the shared value when uniform, mixed otherwise', () => {
    const s = (owner: string, alpha?: string) => ({ ...site(owner, '#ff0000', 0.1), alpha })
    expect(slotsOf([s('a'), s('b')])[0]!.alpha).toBe('ff')
    expect(slotsOf([s('a', '80'), s('b', '80')])[0]!.alpha).toBe('80')
    expect(slotsOf([s('a', '80'), s('b')])[0]!.alpha).toBe('mixed')
    expect(slotsOf([s('a', 'ff'), s('b')])[0]!.alpha).toBe('ff')
  })
```
Append to `recolour-apply.unit.spec.ts`:
```ts
  it('recolourSlot with an alpha writes that alpha on every use; without one, keeps each use\'s own', () => {
    const layers: any[] = [rect('a', '#ff0000'), rect('b', '#ff000080')]
    const withA = recolourSlot(layers as any, undefined, '#ff0000', '#00aa00', 1, '40')
    expect((withA.layers[0] as any).fill).toBe('#00aa0040'); expect((withA.layers[1] as any).fill).toBe('#00aa0040')
    const noA = recolourSlot(layers as any, undefined, '#ff0000', '#00aa00', 1)
    expect((noA.layers[0] as any).fill).toBe('#00aa00'); expect((noA.layers[1] as any).fill).toBe('#00aa0080')
  })
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run tests/unit/recolour-sites.unit.spec.ts tests/unit/recolour-map.unit.spec.ts tests/unit/recolour-apply.unit.spec.ts`
Expected: FAIL — `set` ignores a third argument; `alpha` undefined on slots; `recolourSlot` ignores alpha.

- [ ] **Step 3: Implement**

`sites.ts`: change `const join = (hex, alpha?) => alpha ? hex + alpha : hex` to `const join = (hex: string, alpha?: string) => alpha && alpha !== 'ff' ? hex + alpha : hex`, widen the `ColourSite.set` type to `(root: any, hex: string, alpha?: string) => void`, and in every `set` closure use `join(hex, alpha ?? h.alpha)` (there are several: solid paint, gradient stop, Fill a/b/textColor, ink arrays, ink fields). Grep `join(hex, h.alpha)` and replace each with `join(hex, alpha ?? h.alpha)` after adding the `alpha` parameter to the closure signature.

`slots.ts`:
```ts
export interface Slot { hex: string; weight: number; textWeight: number; sites: ColourSite[]; alpha: string | 'mixed' }
// in slotsOf, after grouping:
for (const slot of m.values()) {
  const alphas = new Set(slot.sites.map(s => (s.alpha ?? 'ff').toLowerCase()))
  slot.alpha = alphas.size === 1 ? [...alphas][0]! : 'mixed'
}
```
(initialise `alpha: 'ff'` in the object literal so the type holds before the pass).

`apply.ts`:
```ts
export function recolourSlot(layers: LocalLayer[], background: Paint | undefined, slotHex: string, toHex: string, frameAspect: number, alpha?: string) {
  const from = slotHex.toLowerCase(), to = toHex.toLowerCase()
  const nextLayers: LocalLayer[] = JSON.parse(JSON.stringify(layers))
  const bgRoot = { background: background == null ? undefined : JSON.parse(JSON.stringify(background)) as Paint }
  const byId = new Map(nextLayers.map(l => [l.id, l as any]))
  for (const site of colourSites(nextLayers, bgRoot.background, frameAspect)) {
    if (site.hex !== from) continue
    const root = site.owner === 'bg' ? bgRoot : byId.get(site.owner)
    if (root) site.set(root, to, alpha)
  }
  return { layers: nextLayers, background: bgRoot.background }
}
```
(`recolourFrame` stays as is; `recolourSlot` no longer delegates to it because it needs the alpha argument.)

- [ ] **Step 4: Run to verify they pass** — `cd frontend && npx vitest run tests/unit/recolour-*.unit.spec.ts` → all green (32 + 3). Typecheck grep `lib/compositor/recolour` → no errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor && export GIT_INDEX_FILE=$(mktemp /tmp/pe-idx.XXXXXX) && git read-tree HEAD && git add frontend/app/lib/compositor/recolour/sites.ts frontend/app/lib/compositor/recolour/slots.ts frontend/app/lib/compositor/recolour/apply.ts frontend/tests/unit/recolour-sites.unit.spec.ts frontend/tests/unit/recolour-map.unit.spec.ts frontend/tests/unit/recolour-apply.unit.spec.ts && git diff --cached --name-only && git commit -m "feat(frame): recolour slots know their alpha; a slot edit can set it everywhere" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && unset GIT_INDEX_FILE && git add -- frontend/app/lib/compositor/recolour/sites.ts frontend/app/lib/compositor/recolour/slots.ts frontend/app/lib/compositor/recolour/apply.ts frontend/tests/unit/recolour-sites.unit.spec.ts frontend/tests/unit/recolour-map.unit.spec.ts frontend/tests/unit/recolour-apply.unit.spec.ts
```

---

### Task 2: Colour rows (Figma-style) and the modal wiring

**Files:**
- Rewrite: `frontend/app/components/vue-canvas/compositor/ColourSlots.vue`
- Modify (by hunk): `frontend/app/components/vue-canvas/CompositorModal.vue` — `reassignSlot(slotHex, toHex, alpha?)`, the `<ColourSlots>` usage (drop `:family`, bind `@recolour`).
- Modify: `frontend/tests/frame-recolour.spec.ts` — replace the reassign case; add an opacity case.

**Interfaces:**
- `ColourSlots` props: `slots: { hex: string; weight: number; alpha: string | 'mixed' }[]`; emits `recolour(slotHex: string, toHex: string, alpha?: string)`.
- Modal: `reassignSlot(slotHex, toHex, alpha?)` → `recolourSlot(layers, bg, slotHex, toHex, aspect, alpha)` → one undo step → memory `applied` updated as today. `frameColourSlots` already carries `alpha` after Task 1.

- [ ] **Step 1: Write the component**

```vue
<!-- frontend/app/components/vue-canvas/compositor/ColourSlots.vue -->
<script setup lang="ts">
// The frame's colours as rows — swatch, hex, opacity — heaviest first (the Figma
// "selection colours" presentation). Editing a row rewrites that colour everywhere
// it is used: the swatch opens the house picker, the hex is typed, the opacity
// field sets one alpha on every use (read-only while the uses disagree).
import { ref, watch } from 'vue'
import StudioColor from '~/components/vue-canvas/studio/StudioColor.vue'
import { isHex, parseHexA, withAlpha } from '~/lib/color/convert'

const props = defineProps<{ slots: { hex: string; weight: number; alpha: string | 'mixed' }[] }>()
const emit = defineEmits<{ (e: 'recolour', slotHex: string, toHex: string, alpha?: string): void }>()

const alphaPct = (a: string | 'mixed') => a === 'mixed' ? null : Math.round(parseInt(a, 16) / 255 * 100)
const swatchValue = (s: { hex: string; alpha: string | 'mixed' }) => s.alpha === 'mixed' || s.alpha === 'ff' ? s.hex : withAlpha(s.hex, parseInt(s.alpha, 16) / 255)

// Local drafts so typing does not fight the reactive slot list mid-edit.
const hexDraft = ref<Record<string, string>>({})
const pctDraft = ref<Record<string, string>>({})
watch(() => props.slots, (list) => {
  const h: Record<string, string> = {}, p: Record<string, string> = {}
  for (const s of list) { h[s.hex] = s.hex.slice(1).toUpperCase(); const pc = alphaPct(s.alpha); p[s.hex] = pc == null ? 'Mixed' : String(pc) }
  hexDraft.value = h; pctDraft.value = p
}, { immediate: true, deep: true })

function onSwatch(slotHex: string, v: string) {
  const { hex, alpha } = parseHexA(v)                       // 6-digit → alpha 1
  const a = Math.round(alpha * 255).toString(16).padStart(2, '0')
  if (hex.toLowerCase() === slotHex && a === 'ff') return
  emit('recolour', slotHex, hex.toLowerCase(), a === 'ff' ? undefined : a)
}
function commitHex(slotHex: string) {
  const raw = (hexDraft.value[slotHex] ?? '').trim().replace(/^#/, '')
  const candidate = '#' + raw.toLowerCase()
  if (!isHex(candidate) || candidate.length !== 7) { hexDraft.value[slotHex] = slotHex.slice(1).toUpperCase(); return }
  if (candidate === slotHex) return
  emit('recolour', slotHex, candidate)
}
function commitAlpha(slotHex: string, current: string | 'mixed') {
  if (current === 'mixed') return
  const n = Math.round(Number((pctDraft.value[slotHex] ?? '').replace('%', '')))
  if (!Number.isFinite(n) || n < 0 || n > 100) { pctDraft.value[slotHex] = String(alphaPct(current)); return }
  const a = Math.round(n / 100 * 255).toString(16).padStart(2, '0')
  if (a === current) return
  emit('recolour', slotHex, slotHex, a)
}
</script>

<template>
  <div class="flex flex-col gap-1" aria-label="Frame colours">
    <div
      v-for="s in slots" :key="s.hex" data-testid="colour-slot" :data-hex="s.hex"
      class="flex h-8 items-center gap-1.5 rounded-md bg-white/[0.04] pl-1.5 pr-1"
    >
      <StudioColor :model-value="swatchValue(s)" @update:model-value="(v: string) => onSwatch(s.hex, v)" />
      <input
        data-testid="colour-slot-hex" type="text" spellcheck="false" :aria-label="`Colour ${s.hex}`"
        class="h-6 min-w-0 flex-1 rounded bg-transparent px-1 font-mono text-[11.5px] uppercase text-white/85 outline-none focus:bg-white/[0.06]"
        v-model="hexDraft[s.hex]" @keydown.enter.prevent="($event.target as HTMLInputElement).blur()" @blur="commitHex(s.hex)"
      />
      <div class="flex h-6 w-16 items-center rounded bg-white/[0.04] px-1.5 text-[11.5px] text-white/70">
        <input
          data-testid="colour-slot-alpha" type="text" inputmode="numeric" :aria-label="`Opacity of ${s.hex}`"
          class="w-full min-w-0 bg-transparent text-right outline-none disabled:text-white/40"
          :disabled="s.alpha === 'mixed'" v-model="pctDraft[s.hex]"
          @keydown.enter.prevent="($event.target as HTMLInputElement).blur()" @blur="commitAlpha(s.hex, s.alpha)"
        />
        <span v-if="s.alpha !== 'mixed'" class="ml-0.5 text-white/40">%</span>
      </div>
    </div>
  </div>
</template>
```
Read `StudioColor.vue` first: it is `defineModel<string>({ required: true })` — bind with `:model-value` + `@update:model-value` as above (a `v-model` on a computed would need a writable computed). If `StudioColor` renders a full-size swatch button, it fits the 32 px row; if it renders a labelled row, use its bare (no-label) form. Check `parseHexA(v)` returns `{ hex, alpha }` with alpha 0..1 (`convert.ts:158`).

- [ ] **Step 2: Modal** — `reassignSlot(slotHex: string, toHex: string, alpha?: string)`: pass `alpha` to `recolourSlot(...)`; replace `<ColourSlots :slots="frameColourSlots" :family="…" @reassign="reassignSlot" />` with `<ColourSlots :slots="frameColourSlots" @recolour="reassignSlot" />`. Nothing else.

- [ ] **Step 3: E2E** — in `frame-recolour.spec.ts` replace the "a slot can be sent to another colour of the applied family" case with:
```ts
  test('typing a hex into a colour row changes that colour everywhere; opacity sets one alpha on every use', async ({ page }) => {
    const row = page.locator('[data-testid="colour-slot"]').nth(1)
    const slotHex = (await row.getAttribute('data-hex'))!
    const hexInput = row.locator('[data-testid="colour-slot-hex"]')
    await hexInput.fill('12abef'); await hexInput.press('Enter')
    const after = await frame(page)
    const all = [...solidColours(after.layers), typeof after.bg === 'string' ? after.bg : null].filter(Boolean).map(h => (h as string).toLowerCase().slice(0, 7))
    expect(all).not.toContain(slotHex); expect(all).toContain('#12abef')
    // opacity: the row now reads #12abef; set 50 %
    const row2 = page.locator('[data-testid="colour-slot"][data-hex="#12abef"]')
    const alphaInput = row2.locator('[data-testid="colour-slot-alpha"]')
    await expect(alphaInput).toBeEnabled()
    await alphaInput.fill('50'); await alphaInput.press('Enter')
    const after2 = await frame(page)
    const uses = [...solidColours(after2.layers), typeof after2.bg === 'string' ? after2.bg : null].filter(h => typeof h === 'string' && h.toLowerCase().startsWith('#12abef')) as string[]
    expect(uses.length).toBeGreaterThan(0)
    for (const u of uses) expect(u.toLowerCase()).toBe('#12abef80')
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')   // one step: back to opaque
    const undone = await frame(page)
    expect([...solidColours(undone.layers)].filter(h => typeof h === 'string' && h.toLowerCase().startsWith('#12abef')).every(h => (h as string).length === 7)).toBe(true)
  })
```
(`solidColours` reads `color`/`fill` strings; a slot that lives only in gradient stops would not show — pick row index 1, which on the frame-lab fixture is a solid text/fill colour; if it is not, choose the first row whose hex appears in `solidColours(before.layers)`.)

- [ ] **Step 4: Runs** — unit suite green; typecheck grep `ColourSlots|CompositorModal.vue.*reassignSlot` → no new errors; `cd frontend && npx playwright test tests/frame-recolour.spec.ts --reporter=line` → 4 passed; browser-pane smoke: rows render with swatch/hex/opacity, the swatch opens the picker, a pick recolours everywhere, Cmd+Z restores.

- [ ] **Step 5: Commit** — `ColourSlots.vue` + the E2E whole; the modal BY HUNK; ONE call:
```bash
cd /Users/julien/Documents/GitHub/Sailor && git diff -- frontend/app/components/vue-canvas/CompositorModal.vue > /tmp/cm.diff
```
trim → `/tmp/cm-mine.diff`, then
```bash
cd /Users/julien/Documents/GitHub/Sailor && export GIT_INDEX_FILE=$(mktemp /tmp/pe-idx.XXXXXX) && git read-tree HEAD && git add frontend/app/components/vue-canvas/compositor/ColourSlots.vue frontend/tests/frame-recolour.spec.ts && git apply --cached /tmp/cm-mine.diff && git diff --cached --name-only && git diff --cached --stat && git commit -m "feat(frame): the frame's colours as rows — swatch, hex, opacity — editable everywhere at once" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && unset GIT_INDEX_FILE && git add -- frontend/app/components/vue-canvas/compositor/ColourSlots.vue frontend/tests/frame-recolour.spec.ts && git reset -q -- frontend/app/components/vue-canvas/CompositorModal.vue
```

---

### Task 3: Section cards — nothing selected

**Files:**
- Modify (by hunk): `frontend/app/components/vue-canvas/CompositorModal.vue` — the `<template v-else>` no-selection branch (~:9170–9290; grep `No selection`).

- [ ] **Step 1: Wrap** each block in `<StudioSection title="…">` (import `StudioSection from '~/components/vue-canvas/StudioSection.vue'` if the modal does not already — grep): Background (drop its `panel-label`), Colours (drop the label; keep `data-testid="frame-colours"` on the section's inner wrapper div), Post-processing (drop the label and the `border-t … pt-3` classes), Grid (same), Arrange (the "Expressive arrange" block; keep its `v-if`). The container `div.p-4.flex.flex-col.gap-4` becomes `gap-2.5` so the cards sit like the 3D panel's. Keep every inner sub-label (Symmetry, Placement, Justify…). Keep the hint paragraphs inside their cards.

- [ ] **Step 2: Prove markup-only** — `git diff -- frontend/app/components/vue-canvas/CompositorModal.vue | grep '^[-+]' | grep -v '^[-+][-+]' | grep -E '@update|v-model|:model-value|model-value=|@click|:min=|:max=|:step=' ` must print NOTHING except lines that merely moved indentation (compare `-`/`+` pairs; if a bound expression changed, that is a defect).

- [ ] **Step 3: Runs** — typecheck grep `CompositorModal.vue.*StudioSection` → no new errors; `cd frontend && npx playwright test tests/frame-recolour.spec.ts tests/frame-layout-tab.spec.ts tests/frame-templates.spec.ts --reporter=line` → all green; browser-pane screenshot of the Design tab with nothing selected → save as `/private/tmp/claude-501/-Users-julien-Documents-GitHub-Sailor/e5877d60-d99a-4de2-beb0-85558ebb41e8/scratchpad/inspector-frame-after.png` (a one-off Playwright script, 1440×900, `/dev/frame-lab`, not committed). Also capture the BEFORE by running the same script at the parent commit is not possible without checkout — instead capture the before at the start of the task, before editing.

- [ ] **Step 4: Commit BY HUNK** (message: `feat(frame): the frame-level inspector reads as section cards`).

---

### Task 4: Section cards — a layer selected

**Files:**
- Modify (by hunk): `frontend/app/components/vue-canvas/CompositorModal.vue` — the `v-else-if="selectedLocal && !activeEffect && !activeStroke"` branch (~:8020–9170).

The label map at the time of writing (lines drift; grep the text):
- 8035 Text · 8043 Font · 8053 Size · 8059 Weight · 8069 Align · 8080 V-align · 8091 width · 8098 height · 8108 Follow a path (+ Radius, Start, Height, Waves, Shape, Size, Start, Baseline, Side, Fit) · 8242 Line height · 8248 Letter spacing · 8255 Style · 8280 Expressive (+ Words / line, Placement) · 8325 Color · 8330 Outline → **Text** (one card; the current "Text" heading becomes the card title).
- 8347 Fill · 8352 Stroke · 8364 Corner radius · 8393/8398 · 8410 Sides · 8423/8428 · 8440 Points · 8456 Color · 8461 Thickness · 8475 Shape · 8497/8502 · 8515 Fill · 7421 Library (the shape-library row if it sits in this branch — check) → **Fill and outline** (one card per kind's block; several `v-if` blocks may each get their own card with the same title — that is fine, only one shows at a time).
- 8595 Blend · 8627 Module mix · 8645 Palette · 8662 Treatments · 8690 Plate · 8706 Centre · 8715 Inks · 8726 Grid · 8739 Origin & fan · 8758 Arcs & labels · 8772 Line widths · 8786 Line style · 8796 Inks · 8828 Inks · 8869 Inks/Palette · 8905 Inks → **Style** (the deal / scatter element block(s)).
- 8929 Tint → **Image**.
- 8947 Size · 8974 Length · 8983 Rotation · 8989 Opacity → **Transform**.
- 8998 Distort · 9019 Blend · 9030 Displacement map (+ Read, Amount, Softness) → **Distort and blend**.
- 9082 Mask · 9112 Crop → **Mask and crop**.
- 7379 Name stays outside the cards, above them.

- [ ] **Step 1: Wrap** as above, keeping every `v-if`/`v-else-if` block boundary intact (a card wraps a whole conditional block; never split a `<template v-if>` across cards). Drop each block's own top-level `panel-label` only when it duplicates the card title (e.g. "Text", "Fill" as the block heading); keep sub-labels ("Size", "Weight", "Corner radius"…).

- [ ] **Step 2: Prove markup-only** — same grep as Task 3; plus `git diff --stat` should show insertions ≈ deletions + the number of cards × 2.

- [ ] **Step 3: Runs** — typecheck grep; the four Frame E2Es (`frame-recolour`, `frame-layout-tab`, `frame-templates`, the multi-stroke spec) green; a screenshot of the Design tab with a TEXT layer selected → `…/scratchpad/inspector-text-after.png` (select via the layer list in the lab: click the row "Plain Text"), and one with a rect selected → `…/scratchpad/inspector-rect-after.png`.

- [ ] **Step 4: Commit BY HUNK** (message: `feat(frame): the layer inspector reads as section cards — Text, Fill and outline, Style, Image, Transform, Distort and blend, Mask and crop`).

---

## Notes for the executor

- Verified 2026-09-10: `StudioSection` at `frontend/app/components/vue-canvas/StudioSection.vue` (props `title`, `badge?`, `open?`; `<details>`-based, open by default, `space-y-3 px-3 pb-3` content); `StudioColor` is `defineModel<string>` and emits an 8-digit hex when alpha < 1; `.panel-label` is `text-[11px] text-white/55` (`app/assets/css/main.css:52`); the no-selection branch opens at `CompositorModal.vue:~9170` with Background at :9181, Colours :9188, Post-processing :9201, Grid :9209; the layer branch at :~8020. Lines drift — grep.
- `<details>` content is in the DOM whether open or closed; Playwright can still click inside because cards default open. Do NOT set `open="false"` on any card.
- The modal is edited by other sessions all day: three separate by-hunk commits (Tasks 2, 3, 4), each `git diff HEAD --` based, each verified with `git show --stat` and a changed-line count.
