# Node design, stage 5 (print: Frame and Timeline) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Frame and Timeline cards become prints: the artwork in a thin frame of light glass tinted by the artwork itself, the name above with the size beside it, no header or footer, and Render / Open in the bar that rises over the artwork on hover.

**Architecture:** The shared `surfaces/PrintSurface.vue` (built in stage 1, unused until now) gains the pieces real cards need: a size slot, an unclipped overlay for ports/badge/grip, a slot below the glass, state rings, and a cheap glass tint. It draws the tint into a tiny 64px canvas with the blur baked in (`ctx.filter`). A card calls `capture(canvas)` when its artwork changes. That copy is GPU-side with no pixel read-back, and nothing on screen carries a CSS blur, so panning costs the same as a plain picture. `ArtifactFrameNode` and `ArtifactTimelineNode` wrap their existing artwork in it. Their header and footer controls move into the Open bar and a size panel, and each button calls the same function it calls today.

**Tech Stack:** Nuxt 4, Vue 3 `<script setup>` + TS, Tailwind v4 (`node-surfaces.css` is unlayered and beats utilities), `@vue-flow/core`, Vitest + @vue/test-utils (happy-dom), Playwright on the shared `:3002`.

**Spec:** `docs/superpowers/specs/2026-09-27-node-design-design.md`, section **"Print: Frame and Timeline"**:
- *Thin light-glass edge: an even 6px of frosted light glass around the artwork (8px outer corners, 3px on the artwork).*
- *The glass takes its colour from the artwork itself: the node's own picture, heavily blurred (~28px, saturation 1.6, ~75% opacity) behind a white veil.*
- *The edge is one even ring (a single 1px inner line), no separate top highlight.*
- *Name above ("Frame", Semibold) with the size beside it ("4:5 · 1080 × 1350", quiet, even-width numbers).*
- *No header, no footer. Render and Open live in the bar that rises over the bottom of the artwork on hover.*
- *Larger than other nodes by default (Frame 320px wide).*
- *Timeline: the same treatment; its preview is its clip strip.*
- *Tune the blur and veil in the build; don't add a control for it.*

## Global Constraints

- **Do not change** selection, running or failed looks, wires, or the Note node.
  - The selection outline keeps its look (2px `var(--action)`, 3px offset) and moves onto the glass (Task 2).
  - Running keeps a 2px `--port-color` ring and failed keeps a red 2px ring, both drawn on the glass by shared CSS.
  - Muted keeps 45% + grayscale. Bypassed keeps 85% plus a dashed amber edge.
- **Do not change logic.** Every handler keeps its name and body. This covers:
  - Frame: `openEditor`, `toggleEdit`, `exitEdit`, `downloadImage`, `stopVideoExport`, `onPresetChange`, `setDim`, `onResizeDown`, `onArtboardDblClick`, `onArtboardPointerDown`, and the drag/drop and hover handlers.
  - Timeline: `openEditor`, `runThisNode`, `onResizeDown`.
  
  A control that moves calls the **same function** it called before. Script edits are limited to what a task names.
- **Pinned by tests — keep:**
  - The exact string `<StudioRenderButton class="shrink-0" :node-id="id" :busy="!!data?.studioBusy || !!data?.running" />` in `ArtifactFrameNode.vue` (studio-render-button unit spec).
  - Exactly one `data-testid="frame-card-stack-canvas"` per Frame (frame-generative-fill spec).
  - The signatures of `renderStack`, `renderCompositeAtTime` and `exportCompositeCanvas` (frame-card-export-clock unit spec).
  - A click at the Frame's centre still selects it (start-modal, prompt-results, `_helpers.ts`).
  - The root classes `artifact-frame-node` / `artifact-timeline`.
- **Port ids never change:** Frame `input-${slot}` / `output-${imageOutIdx}`; Timeline `input-${slot}`, `output-${framesOutIdx}`, `output-${videoOutIdx}`. Saved wires reference them.
- **Glass tint cost:**
  - No CSS `filter: blur` on anything that is on screen in Chrome. The blur is baked into the 64px tint canvas; the CSS blur is only the fallback for browsers without `ctx.filter`.
  - Never read pixels back (`getImageData`, `toDataURL`, `toBlob`) for the tint.
  - Never capture per animation frame: Frame captures only on non-`live` paints, Timeline only on still paints.
- UI copy: sentence case, no identifiers, no new explanatory small text. A hint becomes a `title` tooltip.
- **Shared checkout:**
  - Implementers never commit, never touch the git index, never run `npm run dev`, never restart `:3002`.
  - `VueNodeCanvas.vue` is edited by other sessions. Touch only the selection rule Task 2 names, and report the exact lines.
- Never add `will-change`, `translateZ`, forced layer promotion, or any new `backdrop-filter` (the Open bar's existing one only applies while it is up).

---

## File map

| File | Change | Task |
|---|---|---|
| `frontend/app/components/vue-canvas/surfaces/PrintSurface.vue` | Size slot, `__frame` wrapper with an `overlay` slot, `below` slot, a tint canvas plus `capture()`. | 1 |
| `frontend/app/assets/css/node-surfaces.css` (print surface block) | Ring moved to `::after` above the tint, tint canvas styles, state rings, bypassed edge. | 1 |
| `frontend/app/lib/nodeSnapshots.ts` | Export `pickPreviewElement`; skip anything inside `.print-surface__glow`. | 1 |
| `frontend/app/pages/dev/node-lab.vue` | None (its `PrintSurface` call keeps working). | — |
| `frontend/app/lib/canvas/printSize.ts` | New: `formatPrintSize(w, h, opts)`, the label beside "Frame". | 2 |
| `frontend/app/components/vue-canvas/ArtifactFrameNode.vue` | On PrintSurface: size button + size panel, Open bar, NodePort ports, state attributes, default display edge 308, tint capture. | 2 |
| `frontend/app/components/vue-canvas/VueNodeCanvas.vue` (the artifact selection rule, ~9161) | The two print roots come out of the old rule; add `.print-surface__glass`. | 2 |
| `frontend/tests/shader-fill.spec.ts` (:325, :389) | "Edit" → hover the Frame, click "Open". | 2 |
| `frontend/app/components/vue-canvas/ArtifactTimelineNode.vue` | On PrintSurface: summary beside the name, Open bar (Open + Render), state attributes, tint capture. | 3 |
| `frontend/app/components/vue-canvas/TimelineNodePreview.vue` | Emit `still` after each still paint; wrapper loses its own corners/ring. | 3 |
| `frontend/tests/timeline-save-video.spec.ts` (:123) | `text=Open timeline` → the "Open" button. | 3 |

---

### Task 1: PrintSurface — slots, state rings, and a tint that costs nothing on pan

**Files:**
- Modify: `frontend/app/components/vue-canvas/surfaces/PrintSurface.vue` (whole file, 19 lines)
- Modify: `frontend/app/assets/css/node-surfaces.css` (the `/* ---------- print surface (Frame, Timeline) ---------- */` block, ~239-270)
- Modify: `frontend/app/lib/nodeSnapshots.ts:58-70`
- Test: `frontend/tests/unit/node-surfaces.unit.spec.ts` (the `describe('PrintSurface'` block, ~132-140)
- Test: `frontend/tests/unit/node-snapshots.unit.spec.ts` (append)

**Interfaces:**
- Produces:
  - `PrintSurface` props `{ name: string; size?: string; artwork?: string; selected?: boolean }` (unchanged).
  - Slots:
    - `default` (the artwork)
    - `size` (replaces the size text)
    - `openbar`
    - `overlay` (unclipped, positioned against the glass box: ports, ready badge, resize grip, mode badge)
    - `below` (after the glass)
  - Exposed `capture(src: HTMLCanvasElement | HTMLImageElement): void`.
  - Fallthrough attributes land on the root `.print-surface`. Cards set `data-running`, `data-error`, `data-editing`, `data-bypassed` there, and the CSS draws them.
  - `export function pickPreviewElement(nodeEl: Element)` from `lib/nodeSnapshots.ts`.

- [ ] **Step 1: Write the failing tests**

Replace the `describe('PrintSurface', …)` block in `tests/unit/node-surfaces.unit.spec.ts` with:

```ts
describe('PrintSurface', () => {
  it('shows the name and size, and the artwork once (the glass tint is a canvas, not a second picture)', () => {
    const w = mount(PrintSurface, { props: { name: 'Frame', size: '4:5 · 1080 × 1350', artwork: '/a.jpg' } })
    expect(w.find('.print-surface__name').text()).toBe('Frame')
    expect(w.find('.print-surface__size').text()).toBe('4:5 · 1080 × 1350')
    expect(w.findAll('img').map(i => i.attributes('src'))).toEqual(['/a.jpg'])
    expect(w.find('.print-surface__glow canvas').exists()).toBe(true)
    expect(w.find('.print-surface__glow').attributes('aria-hidden')).toBe('true')
  })

  it('puts the overlay outside the clipping glass and the below slot after it', () => {
    const w = mount(PrintSurface, {
      props: { name: 'Frame' },
      slots: { overlay: '<i class="ov" />', below: '<i class="bl" />', size: '<b class="sz">Set size</b>' },
    })
    expect(w.find('.print-surface__glass .ov').exists()).toBe(false)
    expect(w.find('.print-surface__frame > .ov').exists()).toBe(true)
    expect(w.find('.print-surface > .bl').exists()).toBe(true)
    expect(w.find('.print-surface__label .sz').text()).toBe('Set size')
  })

  it('passes state attributes to the root', () => {
    const w = mount(PrintSurface, { props: { name: 'Frame' }, attrs: { 'data-running': '' } })
    expect(w.find('.print-surface').attributes('data-running')).toBe('')
  })

  it('draws the tint small, with the blur baked in, once per frame however often it is asked', () => {
    const q: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { q.push(cb); return q.length })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    const draws: unknown[][] = []
    const ctx: any = { filter: 'none', clearRect() {}, drawImage: (...a: unknown[]) => { draws.push([ctx.filter, ...a]) } }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx)
    const w = mount(PrintSurface, { props: { name: 'Frame' } })
    const src = document.createElement('canvas'); src.width = 1080; src.height = 1350
    ;(w.vm as any).capture(src); (w.vm as any).capture(src)
    expect(q.length).toBe(1)
    q.shift()!(0)
    expect(draws.length).toBe(1)
    expect(draws[0]![0]).toMatch(/blur\(/)
    const tint = w.find('.print-surface__glow canvas').element as HTMLCanvasElement
    expect(Math.max(tint.width, tint.height)).toBe(64)
    vi.unstubAllGlobals(); vi.restoreAllMocks()
  })
})

describe('print surface CSS guards', () => {
  it('draws the ring above the tint, not under it', () => {
    expect(rule('.print-surface__glass::after')).toMatch(/inset 0 0 0 calc\(1px/)
    expect(rule('.print-surface__glass')).not.toMatch(/inset/)
  })
  it('never blurs the on-screen tint with CSS, except in the fallback', () => {
    expect(rule('.print-surface__glow > canvas')).not.toMatch(/filter/)
    expect(rule('.print-surface__glow--css > canvas')).toMatch(/blur\(28px\)/)
  })
})
```

Make sure the spec's `vitest` import includes `vi`. Add it if missing.

Append to `tests/unit/node-snapshots.unit.spec.ts`:

```ts
import { pickPreviewElement } from '~/lib/nodeSnapshots'

describe('pickPreviewElement', () => {
  it('ignores a print surface tint, however large it is', () => {
    const node = document.createElement('div')
    node.innerHTML = '<div class="print-surface__glow"><canvas class="tint"></canvas></div><canvas class="art"></canvas>'
    const size = (el: Element, s: number) => { (el as any).getBoundingClientRect = () => ({ width: s, height: s }) }
    size(node.querySelector('.tint')!, 500)
    size(node.querySelector('.art')!, 300)
    expect(pickPreviewElement(node)).toBe(node.querySelector('.art'))
  })
})
```

Put the `import` beside the file's other imports at the top, not mid-file.

- [ ] **Step 2: Run them to see them fail**

Run: `cd frontend && npx vitest run tests/unit/node-surfaces.unit.spec.ts tests/unit/node-snapshots.unit.spec.ts`
Expected: FAIL. The glow is an `img`, there are no slots, no `capture`, no `pickPreviewElement` export, and no `::after` rule.

- [ ] **Step 3: Write `PrintSurface.vue`**

```vue
<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue'

/**
 * Frame and Timeline: the artwork in a thin frame of light glass, tinted by the artwork itself.
 *
 * The tint is a tiny copy of the artwork with the blur baked in (`ctx.filter`), drawn when the
 * artwork changes (`capture`). Copying one canvas into another stays on the GPU — no pixel
 * read-back — and nothing on screen carries a CSS blur, so a pan costs what a plain picture does.
 */
const props = defineProps<{ name: string; size?: string; artwork?: string; selected?: boolean }>()

// At 64px the tint is drawn ~8× smaller than it shows, so 3px here reads as ~28px on screen.
const TINT_EDGE = 64
const TINT_FILTER = 'blur(3px) saturate(1.6) brightness(1.1)'

const tintEl = ref<HTMLCanvasElement | null>(null)
// Browsers without canvas filters get the CSS blur instead (slower on pan, same look).
const cssBlur = ref(false)
let raf = 0
let pending: HTMLCanvasElement | HTMLImageElement | null = null

function drawTint() {
  raf = 0
  const src = pending
  pending = null
  const cv = tintEl.value
  if (!cv || !src) return
  const sw = src instanceof HTMLImageElement ? src.naturalWidth : src.width
  const sh = src instanceof HTMLImageElement ? src.naturalHeight : src.height
  if (!sw || !sh) return
  const k = TINT_EDGE / Math.max(sw, sh)
  const w = Math.max(1, Math.round(sw * k))
  const h = Math.max(1, Math.round(sh * k))
  if (cv.width !== w) cv.width = w
  if (cv.height !== h) cv.height = h
  const ctx = cv.getContext('2d')
  if (!ctx) return
  cssBlur.value = !('filter' in ctx)
  ctx.clearRect(0, 0, w, h)
  if (!cssBlur.value) ctx.filter = TINT_FILTER
  ctx.drawImage(src, 0, 0, w, h)
  if (!cssBlur.value) ctx.filter = 'none'
}

/** Copy `src` into the glass tint. Coalesced to one draw per frame. Call it when the artwork
 *  changes — never once per animation frame. */
function capture(src: HTMLCanvasElement | HTMLImageElement) {
  pending = src
  if (!raf) raf = requestAnimationFrame(drawTint)
}

watch(() => props.artwork, (url) => {
  if (!url) return
  const im = new Image()
  im.onload = () => { if (props.artwork === url) capture(im) }
  im.src = url
}, { immediate: true })

onBeforeUnmount(() => { if (raf) cancelAnimationFrame(raf) })

defineExpose({ capture })
</script>

<template>
  <div class="print-surface" :data-selected="selected || undefined">
    <div class="print-surface__label">
      <span class="print-surface__name">{{ name }}</span>
      <slot name="size"><span v-if="size" class="print-surface__size">{{ size }}</span></slot>
    </div>
    <div class="print-surface__frame">
      <div class="print-surface__glass node-openbar-host" :data-selected="selected || undefined">
        <div class="print-surface__glow" :class="{ 'print-surface__glow--css': cssBlur }" aria-hidden="true"><canvas ref="tintEl" /></div>
        <div class="print-surface__art"><slot><img v-if="artwork" :src="artwork" alt="" class="block w-full"></slot></div>
        <slot name="openbar" />
      </div>
      <slot name="overlay" />
    </div>
    <slot name="below" />
  </div>
</template>
```

- [ ] **Step 4: Replace the print surface CSS block**

In `node-surfaces.css`, replace everything from `/* ---------- print surface (Frame, Timeline) ---------- */` through the `.print-surface__art { … }` line with:

```css
/* ---------- print surface (Frame, Timeline) ---------- */
.print-surface { position: relative; font-weight: 500; }
.print-surface__label { display: flex; align-items: baseline; gap: 8px; height: 26px; font-size: 13px; }
.print-surface__name { font-weight: 600; color: rgba(255, 255, 255, 0.92); }
.print-surface__size { font-size: 12px; color: rgba(255, 255, 255, 0.4); font-variant-numeric: tabular-nums; }
.print-surface__frame { position: relative; }
.print-surface__glass {
  position: relative;
  padding: 6px;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 26px 70px rgba(0, 0, 0, 0.55), 0 4px 14px rgba(0, 0, 0, 0.35);
}
/* One even ring, nothing along the top: the same rule as the shells. On a pseudo-element so it
   sits above the tint (an inset shadow on the glass itself would paint under it). */
.print-surface__glass::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  box-shadow: inset 0 0 0 calc(1px / var(--canvas-zoom, 1)) rgba(255, 255, 255, 0.24);
  pointer-events: none;
  z-index: 2;
}
/* The glass takes its colour from the artwork: a tiny copy with the blur baked in (PrintSurface),
   stretched past the edges, under a white veil. Nothing here blurs on screen. */
.print-surface__glow { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.print-surface__glow > canvas {
  position: absolute;
  left: -30%;
  top: -30%;
  width: 160%;
  height: 160%;
  object-fit: cover;
  opacity: 0.75;
}
.print-surface__glow--css > canvas { filter: blur(28px) saturate(1.6) brightness(1.1); }
.print-surface__glow::after {
  content: '';
  position: absolute;
  inset: 0;
  background: rgba(255, 255, 255, 0.2);
}
.print-surface__art { position: relative; z-index: 1; border-radius: 3px; overflow: hidden; }
/* States, drawn on the glass edge. Later rules win: running < editing < failed. */
.print-surface[data-running] .print-surface__glass::after { box-shadow: inset 0 0 0 2px var(--port-color, #fff); }
.print-surface[data-editing] .print-surface__glass::after { box-shadow: inset 0 0 0 2px rgba(34, 211, 238, 0.7); }
.print-surface[data-error] .print-surface__glass::after { box-shadow: inset 0 0 0 2px rgb(239, 68, 68); }
.print-surface[data-bypassed] .print-surface__glass::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  border: 1px dashed rgba(251, 191, 36, 0.35);
  pointer-events: none;
  z-index: 2;
}
```

Note that the spec's `rule()` helper finds `".print-surface__glass {"` by exact text. The `::after`/`::before` rules must keep their own selectors as written above so the guard finds the right block.

- [ ] **Step 5: Export `pickPreviewElement` and skip the tint**

In `lib/nodeSnapshots.ts`, change `function pickPreviewElement(` to `export function pickPreviewElement(`. As the first line inside the `for` loop, add:

```ts
    // A print surface's glass tint is a stretched, blurred copy of the art — never the picture.
    if (el.closest('.print-surface__glow')) continue
```

- [ ] **Step 6: Run the tests**

Run: `cd frontend && npx vitest run tests/unit/node-surfaces.unit.spec.ts tests/unit/node-snapshots.unit.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit (controller)**

`feat(print): the print surface tints its glass from a tiny pre-blurred copy of the artwork, takes an unclipped overlay, a size slot and state rings; snapshots skip the tint`

---

### Task 2: The Frame card is a print

**Files:**
- Create: `frontend/app/lib/canvas/printSize.ts`
- Test: `frontend/tests/unit/print-size.unit.spec.ts`
- Modify: `frontend/app/components/vue-canvas/ArtifactFrameNode.vue`:
  - script: imports, the `displayEdge` default at :131, `renderStack` end at ~:571, and a few new display refs/computeds;
  - template: :1163-1335;
  - scoped style: :1338-1351.
- Modify: `frontend/app/components/vue-canvas/VueNodeCanvas.vue` (~9158-9166, the artifact selection rule)
- Modify: `frontend/tests/shader-fill.spec.ts:325` and `:389`

**Interfaces:**
- Consumes (Task 1):
  - `PrintSurface`: slots `size`, `default`, `openbar`, `overlay`, `below`; exposed `capture(src)`; root attributes `data-running`, `data-error`, `data-editing`, `data-bypassed`.
  - `NodeOpenBar` (`surfaces/NodeOpenBar.vue`, prop `meta`), with buttons classed `node-btn`.
  - `VueCanvasNodePort` (props `id`, `type`, `side`, `index`, `data-type`, `label`).
- Produces: `formatPrintSize(w: number, h: number, opts?: { responsive?: boolean; loopSec?: number }): string`.

- [ ] **Step 1: Write the failing test for the size label**

`tests/unit/print-size.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { formatPrintSize } from '~/lib/canvas/printSize'

describe('formatPrintSize', () => {
  it('reduces the ratio and shows the pixel size', () => {
    expect(formatPrintSize(1080, 1350)).toBe('4:5 · 1080 × 1350')
    expect(formatPrintSize(1920, 1080)).toBe('16:9 · 1920 × 1080')
    expect(formatPrintSize(1000, 1000)).toBe('1:1 · 1000 × 1000')
  })
  it('falls back to a decimal ratio when the whole numbers are unwieldy', () => {
    expect(formatPrintSize(1200, 628)).toBe('1.91:1 · 1200 × 628')
    expect(formatPrintSize(628, 1200)).toBe('1:1.91 · 628 × 1200')
  })
  it('says when a Frame is responsive, and how long it loops', () => {
    expect(formatPrintSize(1080, 1350, { responsive: true })).toBe('Responsive · 1080 × 1350')
    expect(formatPrintSize(1080, 1350, { loopSec: 6.4 })).toBe('4:5 · 1080 × 1350 · loops 6s')
  })
  it('asks for a size when there is none', () => {
    expect(formatPrintSize(0, 0)).toBe('Set size')
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd frontend && npx vitest run tests/unit/print-size.unit.spec.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `lib/canvas/printSize.ts`**

```ts
/** The quiet label beside a Frame's name: "4:5 · 1080 × 1350". */
export function formatPrintSize(w: number, h: number, opts: { responsive?: boolean; loopSec?: number } = {}): string {
  if (!(w > 0 && h > 0)) return 'Set size'
  const g = gcd(Math.round(w), Math.round(h))
  const a = Math.round(w) / g, b = Math.round(h) / g
  const ratio = opts.responsive
    ? 'Responsive'
    : a <= 32 && b <= 32 ? `${a}:${b}`
      : w >= h ? `${trim(w / h)}:1` : `1:${trim(h / w)}`
  const loop = opts.loopSec && opts.loopSec > 0 ? ` · loops ${Math.round(opts.loopSec)}s` : ''
  return `${ratio} · ${Math.round(w)} × ${Math.round(h)}${loop}`
}

function gcd(a: number, b: number): number { return b ? gcd(b, a % b) : a }
function trim(n: number): string { return String(Math.round(n * 100) / 100) }
```

- [ ] **Step 4: Run it to see it pass**

Run: `cd frontend && npx vitest run tests/unit/print-size.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Script edits in `ArtifactFrameNode.vue` (only these)**

1. Imports: add `PrintSurface` (`~/components/vue-canvas/surfaces/PrintSurface.vue`), `NodeOpenBar` (`~/components/vue-canvas/surfaces/NodeOpenBar.vue`), `formatPrintSize` (`~/lib/canvas/printSize`). Remove `Pencil` and `FrameIcon` from the icon imports only if nothing else uses them; keep every other import.
2. `:131` — the display edge default goes from `300` to `308`, so a square Frame is 320 wide with its glass (6px each side):
   ```ts
   const displayEdge = computed(() => Number((props.data.properties as any)?.sailor_frame?.displayEdge) || 308)
   ```
3. Beside `stackCanvas` (~:526), add:
   ```ts
   const printRef = ref<{ capture: (src: HTMLCanvasElement) => void } | null>(null)
   const sizeOpen = ref(false)
   const sizeLabel = computed(() => formatPrintSize(frameW.value, frameH.value, {
     responsive: isResponsive.value,
     loopSec: masterClock.value?.duration,
   }))
   const loopTitle = computed(() => masterClock.value && masterClock.value.duration > 0
     ? `Loops every ${Math.round(masterClock.value.duration)}s${masterClock.value.capped ? ' (capped)' : ''}`
     : undefined)
   ```
   Place these after `masterClock` is declared (~:580). A computed that reads `masterClock` before its `const` line is a TDZ error.
4. At the very end of `renderStack` (after the `withWiredContent(...)` call), add:
   ```ts
     // The glass takes its tint from the artwork at rest. Live (hover-play) paints are skipped: a
     // tint that followed every frame would be a copy per frame for a colour nobody sees change.
     if (!live) printRef.value?.capture(cv)
   ```
5. `sizeOpen` closes on Escape and on a pointerdown outside the panel. Use the existing `onMounted`/`onBeforeUnmount` pattern in the file, and gate the listener on `sizeOpen` with a `watch`:
   ```ts
   const sizePanelEl = ref<HTMLElement | null>(null)
   function onSizeOutside(e: PointerEvent) {
     if (sizePanelEl.value && !sizePanelEl.value.contains(e.target as Node)) sizeOpen.value = false
   }
   function onSizeKey(e: KeyboardEvent) { if (e.key === 'Escape') sizeOpen.value = false }
   watch(sizeOpen, (open) => {
     if (open) { window.addEventListener('pointerdown', onSizeOutside, true); window.addEventListener('keydown', onSizeKey) }
     else { window.removeEventListener('pointerdown', onSizeOutside, true); window.removeEventListener('keydown', onSizeKey) }
   })
   onBeforeUnmount(() => { window.removeEventListener('pointerdown', onSizeOutside, true); window.removeEventListener('keydown', onSizeKey) })
   ```
   The size button itself must be inside `sizePanelEl`'s wrapper (see the template), so clicking it to close doesn't reopen it.
6. Delete `handleTop` (~:194) only if nothing else uses it after the template change. `portOffset`'s import goes too if it is then unused.

- [ ] **Step 6: Replace the template (:1163-1335)**

The artboard's inner content moves as-is. That covers the stack canvas, grid overlay, empty state, edit overlays and textarea, from `<canvas ref="stackCanvas" …>` through the closing `</textarea>`. Only the "Edit here" hover button leaves the artboard; it goes into the Open bar. The `<Teleport to="body">` toolbar block stays at the end, unchanged.

```vue
<template>
  <div
    ref="rootEl"
    class="artifact-frame-node relative select-none"
    :class="{ 'opacity-45 grayscale': isMuted, 'opacity-85': isBypassed }"
    :style="{ width: (box.w + 12) + 'px', '--port-color': imageColor } as any"
    @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop"
    @pointerenter="onFrameHoverEnter" @pointerleave="onFrameHoverLeave"
  >
    <PrintSurface
      ref="printRef"
      name="Frame"
      :selected="selected || exportingVideo"
      :data-running="data.running || undefined"
      :data-error="data.error ? '' : undefined"
      :data-editing="editMode ? '' : undefined"
      :data-bypassed="isBypassed ? '' : undefined"
    >
      <template #size>
        <span ref="sizePanelEl" class="relative">
          <button
            type="button"
            class="print-surface__size nopan nodrag cursor-pointer hover:text-white/70"
            :title="loopTitle"
            @click.stop="sizeOpen = !sizeOpen"
          >{{ sizeLabel }}</button>
          <div
            v-if="sizeOpen"
            class="frame-size-panel nopan nodrag absolute left-0 top-full z-50 mt-1 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] text-white/60 tabular-nums"
          >
            <select
              class="bg-transparent text-white/80 outline-none cursor-pointer max-w-[140px]"
              :value="activePresetId" @change="onPresetChange"
            >
              <option value="" disabled hidden>Size…</option>
              <optgroup v-for="g in PRESET_GROUPS" :key="g.heading" :label="g.heading">
                <option v-for="p in g.items" :key="p.id" :value="p.id">{{ p.label }}</option>
              </optgroup>
              <option value="responsive">Responsive</option>
              <option value="custom" disabled hidden>Custom</option>
            </select>
            <span class="text-white/40">{{ isResponsive ? 'Designed at' : 'Size' }}</span>
            <input type="number" min="0" :value="frameW || ''" placeholder="W" aria-label="Width"
              class="w-14 bg-white/[0.06] rounded px-1.5 py-0.5 text-right text-white/80 outline-none focus:bg-white/[0.1] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              @change="setDim('width', $event)" />
            <span>×</span>
            <input type="number" min="0" :value="frameH || ''" placeholder="H" aria-label="Height"
              class="w-14 bg-white/[0.06] rounded px-1.5 py-0.5 text-right text-white/80 outline-none focus:bg-white/[0.1] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              @change="setDim('height', $event)" />
          </div>
        </span>
      </template>

      <!-- Artboard -->
      <div
        ref="artboardRef"
        class="artboard relative bg-checker overflow-hidden"
        :class="editMode ? 'nopan nodrag cursor-default' : 'cursor-pointer'"
        :style="{ width: box.w + 'px', height: box.h + 'px' }"
        @dblclick.capture="onArtboardDblClick"
        @pointerdown.capture="onArtboardPointerDown"
      >
        <!-- …the artboard's existing children, unchanged, minus the "Edit here" button… -->
      </div>

      <template v-if="!editMode" #openbar>
        <NodeOpenBar :meta="videoStatus || ''">
          <button v-if="exportingVideo" type="button" class="node-btn node-btn--icon nopan nodrag" title="Stop" aria-label="Stop" @click.stop="stopVideoExport"><X class="size-3.5" /></button>
          <button v-else type="button" class="node-btn node-btn--icon nopan nodrag" :disabled="!hasAnyLayer && !compositeUrl" title="Download" aria-label="Download" @click.stop="downloadImage"><Download class="size-3.5" /></button>
          <button type="button" class="node-btn node-btn--icon nopan nodrag" title="Edit here" aria-label="Edit here" @pointerdown.stop @click.stop="toggleEdit"><MousePointer2 class="size-3.5" /></button>
          <button type="button" class="node-btn nopan nodrag" title="Open the full editor" @click.stop="openEditor">Open</button>
          <StudioRenderButton class="shrink-0" :node-id="id" :busy="!!data?.studioBusy || !!data?.running" />
        </NodeOpenBar>
      </template>

      <template #overlay>
        <VueCanvasNodeReadyBadge :node-id="id" />
        <VueCanvasNodePort
          v-for="(slot, i) in layerSlots" :id="`input-${slot}`" :key="slot"
          type="target" side="left" :index="i" data-type="IMAGE" label="layer"
        />
        <VueCanvasNodePort
          :id="`output-${imageOutIdx}`" type="source" side="right"
          :index="0" data-type="IMAGE" label="image"
        />
        <!-- Corner resize grip — sets the on-canvas display size (not output res) -->
        <div
          class="nopan nodrag absolute -bottom-1.5 -right-1.5 z-[7] size-4 cursor-nwse-resize group/resize"
          title="Resize frame (display size)"
          @pointerdown="onResizeDown"
        >
          <div class="absolute bottom-1 right-1 size-2 border-b-2 border-r-2 border-white/30 group-hover/resize:border-cyan-400 rounded-[1px]" />
        </div>
      </template>

      <template v-if="editMode" #below>
        <!-- Inline edit toolbar: the existing toolbar's children, unchanged -->
        <div class="frame-edit-bar mt-1.5 flex items-center gap-0.5 rounded-lg px-1.5 py-1">
          <!-- …the existing toolbar buttons, AddImageSourcePopover, file input, BrandImagePicker, divider,
               delete, spacer and "Done" button, unchanged… -->
        </div>
      </template>
    </PrintSurface>

    <!-- Floating contextual toolbar: the existing <Teleport to="body"> block, unchanged -->
  </div>
</template>
```

Notes for this step:
- `selected` is Vue Flow's node prop. Add `selected?: boolean` to the props type if the file doesn't declare it; don't change anything else about props.
- `:selected="selected || exportingVideo"` keeps the bar up while a video export runs, so Stop and the status stay visible.
- `data-running` moves from the root to `PrintSurface`. The old root `:data-running` goes, and the scoped rule that read it is deleted.
- The artboard's `group` class goes because nothing reads `group-hover` any more. Keep it if any remaining child still uses `group-hover:`.
- `node-btn--icon`: if `node-surfaces.css` has no icon-button modifier, add one in this task's CSS, beside `.node-btn`:
  ```css
  .node-btn--icon { width: 28px; padding: 0; justify-content: center; }
  ```
  Check the existing `.node-btn` rule first and match its display (flex/inline-flex).

- [ ] **Step 7: Scoped style (:1338-1351)**

Delete the `.frame-shell` and `.artifact-frame-node[data-running] .frame-shell` rules; the glass draws both now. Keep `.bg-checker`. Add:

```css
.frame-size-panel,
.frame-edit-bar {
  background: rgba(22, 22, 22, 0.92);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08), 0 8px 24px rgba(0, 0, 0, 0.45);
}
```

- [ ] **Step 8: Selection rule in `VueNodeCanvas.vue` (~9158-9166)**

The Frame and Timeline roots now carry the name row, so an outline on the root would wrap the name. Replace the rule

```css
.vue-node-canvas .vue-flow__node.selected .artifact-frame-node,
.vue-node-canvas .vue-flow__node.selected .artifact-timeline {
  outline: 2px solid var(--action);
  outline-offset: 3px;
  border-radius: 12px;
}
```

with

```css
.vue-node-canvas .vue-flow__node.selected .print-surface__glass {
  outline: 2px solid var(--action);
  outline-offset: 3px;
}
```

Keep its comment and adjust the wording to "…on the glass, not the name above it". Leave the `box-shadow: none` rule above it alone. Report the exact lines.

- [ ] **Step 9: Update `tests/shader-fill.spec.ts` :325 and :389**

Each `await page.getByRole('button', { name: 'Edit', exact: true }).first().click()` becomes:

```ts
    const frameCard = page.locator('.vue-flow__node-artifact-frame').first()
    await frameCard.hover()
    await frameCard.getByRole('button', { name: 'Open', exact: true }).click()
```

If the second site is in the same test scope as the first, reuse the variable instead of redeclaring it.

- [ ] **Step 10: Run the unit specs that pin this file**

Run: `cd frontend && npx vitest run tests/unit/print-size.unit.spec.ts tests/unit/studio-render-button.unit.spec.ts tests/unit/frame-card-export-clock.unit.spec.ts tests/unit/node-surfaces.unit.spec.ts tests/unit/frame-new-grid.unit.spec.ts`
Expected: PASS.

Then run: `cd frontend && npx vue-tsc --noEmit -p . 2>&1 | grep -E "ArtifactFrameNode|printSize|PrintSurface" || echo clean`
Expected: `clean`.

- [ ] **Step 11: Playwright (shared :3002, never restart it)**

Run: `cd frontend && npx playwright test tests/frame-generative-fill.spec.ts tests/start-modal.spec.ts --reporter=line`
Expected: PASS. If `:3002` is down or answers 500, report BLOCKED and don't restart it.

- [ ] **Step 12: Commit (controller)**

`feat(frame): the Frame card is a print — light glass tinted by the artwork, name and size above, Download / Edit here / Open / Render in the bar that rises on hover, size settings behind the size label`

---

### Task 3: The Timeline card is a print

**Files:**
- Modify: `frontend/app/components/vue-canvas/ArtifactTimelineNode.vue` (imports; template :~150-215; scoped style)
- Modify: `frontend/app/components/vue-canvas/TimelineNodePreview.vue`: `defineEmits`, a one-line emit at the end of `paint(still)`, and the template wrapper at :424-434
- Modify: `frontend/tests/timeline-save-video.spec.ts:123`
- Test: `frontend/tests/unit/timeline-print.unit.spec.ts` (new, source-level guards)

**Interfaces:**
- Consumes (Task 1): `PrintSurface` slots `size`, `default`, `openbar`, `overlay`; exposed `capture(src)`; root attributes `data-running`, `data-error`, `data-bypassed`.
- Produces: `TimelineNodePreview` emits `still` with its `HTMLCanvasElement` after each still (poster) paint.

**Ruling carried from the plan:** the spec says the Timeline's preview "is its clip strip". The card's preview today is a live composite that plays on hover, not a strip. Building a strip would be new behaviour, not a restyle, so the existing preview stays and becomes the print's artwork. This is recorded as a ruling for Julien.

- [ ] **Step 1: Write the failing source guards**

`tests/unit/timeline-print.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const src = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')

describe('Timeline card is a print', () => {
  const node = src('app/components/vue-canvas/ArtifactTimelineNode.vue')
  const preview = src('app/components/vue-canvas/TimelineNodePreview.vue')

  it('wears the print surface, not the old bordered frame', () => {
    expect(node).toMatch(/<PrintSurface[\s\S]*name="Timeline"/)
    expect(node).not.toMatch(/class="artifact-frame /)
  })
  it('keeps Open and Render in the bar, calling the same functions', () => {
    expect(node).toMatch(/<NodeOpenBar/)
    expect(node).toMatch(/@click\.stop="openEditor"[^>]*>Open</)
    expect(node).toMatch(/@click\.stop="runThisNode"/)
  })
  it('tints the glass from the preview only when it paints a still', () => {
    expect(preview).toMatch(/emit\('still'/)
    expect(node).toMatch(/@still="/)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd frontend && npx vitest run tests/unit/timeline-print.unit.spec.ts`
Expected: FAIL.

- [ ] **Step 3: `TimelineNodePreview.vue`**

1. Add `const emit = defineEmits<{ still: [canvas: HTMLCanvasElement] }>()` after the props declaration. If the file has no props declaration, put it after the imports.
2. At the very end of `paint(still)` (after the last draw), emit the canvas when it painted a still:
   ```ts
     // The card tints its glass from the poster frame; the playing loop never emits.
     if (still) emit('still', canvas)
   ```
   This covers every still paint (mount poster, `onIdle`, and any other `paint(true)` site) with one line. Do **not** emit for `paint()` / `paint(false)`.
3. The template wrapper becomes the print's artwork, so it drops its own corners and ring and becomes the positioning parent for the "Connect clips" overlay:
   ```vue
   <div ref="rootEl" class="relative w-full bg-black">
   ```
   Everything inside it stays unchanged.

- [ ] **Step 4: `ArtifactTimelineNode.vue` template**

Imports: add `PrintSurface` and `NodeOpenBar` (same paths as Task 2). Keep `Loader2`. Drop `Pencil`, `Clapperboard` and `RefreshCw` if nothing else uses them.

Script: add `selected?: boolean` to the props type if it isn't declared, and add

```ts
const printRef = ref<{ capture: (src: HTMLCanvasElement) => void } | null>(null)
```

Nothing else changes in the script.

Template: replace from the root `<div ref="portSyncRoot" …>` through its closing `</div>`:

```vue
<template>
  <div
    ref="portSyncRoot"
    class="artifact-timeline relative select-none"
    :class="{ 'artifact-timeline--muted': isMuted, 'artifact-timeline--bypassed': isBypassed }"
    :style="{ width: nodeW + 'px', '--port-color': imageColor } as any"
  >
    <PrintSurface
      ref="printRef"
      name="Timeline"
      :size="summary || undefined"
      :selected="selected"
      :data-running="data.running || undefined"
      :data-error="data.error ? '' : undefined"
      :data-bypassed="isBypassed ? '' : undefined"
    >
      <div ref="shellRef">
        <VueCanvasTimelineNodePreview :node-id="id" @still="(c: HTMLCanvasElement) => printRef?.capture(c)" />
      </div>

      <template #openbar>
        <NodeOpenBar>
          <button type="button" class="node-btn nopan nodrag" title="Open the timeline editor" @click.stop="openEditor">Open</button>
          <button
            type="button" class="node-btn node-btn--primary nopan nodrag"
            :disabled="data.running || isMuted || isBypassed"
            :title="data.running ? 'Running…' : 'Render frames'"
            @click.stop="runThisNode"
          ><Loader2 v-if="data.running" class="size-3.5 animate-spin" />Render</button>
        </NodeOpenBar>
      </template>

      <template #overlay>
        <VueCanvasNodeReadyBadge :node-id="id" />
        <VueCanvasNodePort
          v-for="(slot, i) in clipSlots" :id="`input-${slot}`" :key="slot"
          type="target" side="left" :index="i" data-type="IMAGE" label="clip"
        />
        <VueCanvasNodePort
          :id="`output-${framesOutIdx}`" type="source" side="right"
          :index="0" data-type="IMAGE" label="frames"
        />
        <VueCanvasNodePort
          v-if="videoOutIdx >= 0"
          :id="`output-${videoOutIdx}`" type="source" side="right"
          :index="1" data-type="VIDEO" label="video"
        />
        <!-- Mode badge -->
        <div
          v-if="isMuted || isBypassed"
          class="pointer-events-none absolute top-1.5 right-1.5 z-[6] text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full"
          :class="isBypassed ? 'bg-amber-500/25 text-amber-200 border border-amber-400/30' : 'bg-white/15 text-white/70 border border-white/15'"
        >{{ isBypassed ? 'Bypass' : 'Mute' }}</div>
        <!-- Corner resize grip — on-canvas display size -->
        <div
          class="nopan nodrag absolute -bottom-1.5 -right-1.5 size-4 cursor-nwse-resize group/resize z-[7]"
          title="Resize timeline card"
          @pointerdown="onResizeDown"
        >
          <div class="absolute bottom-1 right-1 size-2 border-b-2 border-r-2 border-white/30 group-hover/resize:border-white/70 rounded-[1px]" />
        </div>
      </template>
    </PrintSurface>
  </div>
</template>
```

Notes:
- `shellRef` must keep measuring the artwork's width, because `onResizeDown` divides its on-screen width by `nodeW` to get the zoom. It now wraps the preview inside the glass: the glass is `nodeW` wide and the preview is `nodeW - 12`. Change the zoom line in `onResizeDown` from `r.width / nodeW.value` to `r.width / (nodeW.value - 12)`. That is the one script-logic edit this task allows. Its behaviour is unchanged: the same zoom comes out.
- If `node-btn--primary` doesn't exist in `node-surfaces.css`, use whatever class `StudioRenderButton` uses for its primary look (read `StudioRenderButton.vue`). Don't invent a new class.
- The old header's `Clapperboard` icon and the footer are gone. The summary moves beside the name.

- [ ] **Step 5: Scoped style**

Replace the scoped block with:

```css
.artifact-timeline--muted { opacity: 0.45; filter: grayscale(0.8); }
.artifact-timeline--bypassed { opacity: 0.85; }
```

Running, the bypassed edge and the default shadow are drawn by the glass now.

- [ ] **Step 6: Update `tests/timeline-save-video.spec.ts:123`**

```ts
    await expect(timeline.getByRole('button', { name: 'Open', exact: true })).toHaveCount(1)
```

- [ ] **Step 7: Run the unit specs**

Run: `cd frontend && npx vitest run tests/unit/timeline-print.unit.spec.ts tests/unit/node-surfaces.unit.spec.ts`
Expected: PASS.

Then run: `cd frontend && npx vue-tsc --noEmit -p . 2>&1 | grep -E "ArtifactTimelineNode|TimelineNodePreview" || echo clean`
Expected: `clean`.

- [ ] **Step 8: Commit (controller)**

`feat(timeline): the Timeline card is a print — its preview in tinted light glass, the clip summary beside the name, Open and Render in the bar that rises on hover`

---

### Task 4: Look and pan check (controller, in the browser pane on :3002)

Not dispatched. The controller does this after Task 3 lands, using the harness tab on `:3002`. The server is never restarted, and HMR carries the edits.

- [ ] **Step 1:** Put two Frames (one with a strongly coloured picture wired in, one empty) and one Timeline on a canvas. Screenshot at rest, with one hovered (bar up), with a Frame in edit mode, and with one selected.
- [ ] **Step 2:** Check in the page:
  - `getComputedStyle` on the tint canvas shows `filter: none` (Chrome has `ctx.filter`).
  - The tint canvas measures 64px on its long edge.
  - Ports sit centred on the artwork.
  - The size label opens the panel, and the panel closes on Escape.
- [ ] **Step 3:** Measure the pan the way the dot-grid work did: 60 synthetic `wheel` pan steps with a rAF frame-time recorder. Compare that canvas against the same canvas with `.print-surface__glow` hidden. The glass must add < 1 ms to the median frame. If it does not, the tint is at fault: rule on it (raise `TINT_EDGE` cost or drop the tint opacity path) and record the numbers.
- [ ] **Step 4:** Tune the look by eye, blur and veil only (`TINT_FILTER` in `PrintSurface.vue`, the veil alpha in CSS). Don't add a control. Save the before/after screenshots to the scratchpad `stage5/` folder.
