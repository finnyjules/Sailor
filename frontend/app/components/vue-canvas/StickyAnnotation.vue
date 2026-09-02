<script setup lang="ts">
import { useVueFlow } from '@vue-flow/core'
import { Trash2, Palette } from 'lucide-vue-next'
import type { StickyAnnotation } from '~/composables/useCanvasAnnotations'
import { STICKY_COLORS } from '~/composables/useCanvasAnnotations'

const props = defineProps<{
  annotation: StickyAnnotation
}>()

const emit = defineEmits<{
  'drag': [id: string, dx: number, dy: number]
  'resize': [id: string, w: number, h: number]
  'update': [id: string, patch: Partial<StickyAnnotation>]
  'remove': [id: string]
}>()

const { viewport } = useVueFlow()

const isEditing = ref(false)
const textareaRef = ref<HTMLTextAreaElement | null>(null)

// Drag from anywhere on the sticky — including the (readonly) textarea, since
// that occupies most of the body and excluding it would leave a tiny strip
// around the edge as the only drag handle. When editing, drag is suppressed
// so click-to-position-cursor and text selection work normally.
let dragLast: { x: number; y: number } | null = null
function onPointerDown(e: PointerEvent) {
  if (isEditing.value) return
  if (e.button !== 0) return
  // Bail only for actual interactive controls — buttons (toolbar / color
  // picker). The textarea is fine to initiate drag from when readonly.
  const target = e.target as HTMLElement
  if (target.closest('button')) return
  e.stopPropagation()
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  dragLast = { x: e.clientX, y: e.clientY }
}
function onPointerMove(e: PointerEvent) {
  if (!dragLast) return
  const zoom = viewport.value.zoom || 1
  const dx = (e.clientX - dragLast.x) / zoom
  const dy = (e.clientY - dragLast.y) / zoom
  dragLast = { x: e.clientX, y: e.clientY }
  emit('drag', props.annotation.id, dx, dy)
}
function onPointerUp(e: PointerEvent) {
  if (!dragLast) return
  ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
  dragLast = null
}

// Resize from bottom-right.
let resizeLast: { x: number; y: number; w: number; h: number } | null = null
function onResizeDown(e: PointerEvent) {
  if (e.button !== 0) return
  e.stopPropagation()
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  resizeLast = { x: e.clientX, y: e.clientY, w: props.annotation.width, h: props.annotation.height }
}
function onResizeMove(e: PointerEvent) {
  if (!resizeLast) return
  const zoom = viewport.value.zoom || 1
  const dx = (e.clientX - resizeLast.x) / zoom
  const dy = (e.clientY - resizeLast.y) / zoom
  emit('resize', props.annotation.id, resizeLast.w + dx, resizeLast.h + dy)
}
function onResizeUp(e: PointerEvent) {
  ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
  resizeLast = null
}

function startEdit() {
  isEditing.value = true
  nextTick(() => {
    textareaRef.value?.focus()
    textareaRef.value?.select()
  })
}

// Conditional pointerdown on the textarea: only swallow the event while
// editing so the parent drag handler picks it up otherwise.
function onTextareaPointerDown(e: PointerEvent) {
  if (isEditing.value) e.stopPropagation()
}
function commitEdit() {
  isEditing.value = false
  // text is already bound via v-model below; nothing else to do.
}

// Local model for the textarea so we can debounce-emit changes via blur.
const textDraft = ref(props.annotation.text)
watch(() => props.annotation.text, (v) => { textDraft.value = v })
function onTextInput() {
  emit('update', props.annotation.id, { text: textDraft.value })
}

const showColorBar = ref(false)
function pickColor(c: string) {
  emit('update', props.annotation.id, { color: c })
  showColorBar.value = false
}

// Sticky-paper feel: subtle paper-grain via a layered gradient. The rotation
// is per-instance random (set at create time) — small, just enough to feel
// hand-placed rather than software-stamped.
const rotation = computed(() => props.annotation.rotation ?? 0)

// Foil glitter (Pokémon-card style, à la simeydotme): a static field of
// small pastel dots. At rest they're barely there; a wide light band sweeps
// across and the dots UNDER it appear — the shimmer lives on the dots,
// never as a wash over the paper. Nothing animates on its own:
// the band and the hue cycle are driven by the CANVAS PAN, so the foil only
// glints while the user moves the canvas, like light raking over a card.
// Each sticky adds its own canvas position into the phase so neighbours
// glint at different moments instead of in lockstep.
const shimmerPhase = computed(() => {
  const vp = viewport.value
  return (vp.x + vp.y) * 0.7
    + (props.annotation.x + props.annotation.y) * (vp.zoom || 1) * 0.35
})
// The rainbow drift: hue-rotating the whole dot field shifts every dot's
// colour together, so the trend slides across while the scatter holds.
const hueTurn = computed(() => `${(shimmerPhase.value * 0.9).toFixed(1)}deg`)
// The glint layer is masked by the moving light band; the band mask slides
// with the pan at 1.6× so it rakes across the paper.
const bandPosition = computed(() => `${(shimmerPhase.value * 1.6).toFixed(1)}px 0px`)
const glitterStyle = computed(() => ({
  filter: `hue-rotate(${hueTurn.value})`,
}))
const glintStyle = computed(() => ({
  filter: `hue-rotate(${hueTurn.value})`,
  maskPosition: bandPosition.value,
  WebkitMaskPosition: bandPosition.value,
}))
</script>

<template>
  <div
    class="sticky-annotation absolute pointer-events-auto"
    :style="{
      left: `${annotation.x}px`,
      top: `${annotation.y}px`,
      width: `${annotation.width}px`,
      height: `${annotation.height}px`,
      transform: `rotate(${rotation}deg)`,
      background: annotation.color,
    }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @dblclick.stop="startEdit"
  >
    <!-- Foil shimmer: glitter specks + sheen band, both positioned by the
         canvas pan (see shimmerPhase). Purely decorative — sits under the
         text, ignores the pointer. -->
    <div class="sticky-annotation__shimmer" aria-hidden="true">
      <div class="sticky-annotation__glitter" :style="glitterStyle" />
      <div class="sticky-annotation__glint" :style="glintStyle" />
    </div>

    <!-- Body: textarea always present; just toggles between read-only and editable.
         pointerdown is conditionally stopped: while editing, we stop it so
         the parent's drag handler doesn't hijack click-to-position-cursor;
         while readonly, we let it bubble so the user can drag from the body. -->
    <textarea
      ref="textareaRef"
      v-model="textDraft"
      class="sticky-annotation__text"
      :readonly="!isEditing"
      placeholder="Type a note…"
      @blur="commitEdit"
      @input="onTextInput"
      @pointerdown="onTextareaPointerDown"
      @keydown.escape.prevent="commitEdit"
    />

    <!-- Toolbar: appears on hover via CSS. Color picker + delete. -->
    <div class="sticky-annotation__toolbar" @pointerdown.stop>
      <button
        v-if="STICKY_COLORS.length > 1"
        type="button"
        class="sticky-annotation__btn"
        title="Color"
        @click.stop="showColorBar = !showColorBar"
      >
        <Palette class="w-3 h-3" />
      </button>
      <button
        type="button"
        class="sticky-annotation__btn sticky-annotation__btn--danger"
        title="Delete"
        @click.stop="emit('remove', annotation.id)"
      >
        <Trash2 class="w-3 h-3" />
      </button>
    </div>

    <!-- Color picker strip. Lives inside the sticky so it inherits the rotation. -->
    <div
      v-if="showColorBar"
      class="sticky-annotation__colors"
      @pointerdown.stop
    >
      <button
        v-for="c in STICKY_COLORS"
        :key="c"
        type="button"
        class="sticky-annotation__swatch"
        :style="{ background: c }"
        :aria-label="`Set color ${c}`"
        @click.stop="pickColor(c)"
      />
    </div>

    <!-- Resize handle. -->
    <div
      class="sticky-annotation__resize"
      @pointerdown="onResizeDown"
      @pointermove="onResizeMove"
      @pointerup="onResizeUp"
      @pointercancel="onResizeUp"
    />
  </div>
</template>

<style scoped>
.sticky-annotation {
  border-radius: 2px;
  /* Layered shadow: a tight contact shadow + a soft cast shadow. Reads as
     physical paper without being heavy on dark backgrounds. */
  box-shadow:
    0 1px 1px rgba(0, 0, 0, 0.18),
    0 6px 14px rgba(0, 0, 0, 0.28);
  /* Subtle paper grain via a faint diagonal gradient overlay. */
  background-image: linear-gradient(135deg, rgba(255, 255, 255, 0.06) 0%, rgba(0, 0, 0, 0.05) 100%);
  background-blend-mode: overlay;
  display: flex;
  flex-direction: column;
}

/* ── Foil glitter ─────────────────────────────────────────────────────────
   Modelled on the reference card: a dense, even scatter of small ROUND dots
   in pale pastel tints (procedural SVG tile: jittered hex lattice, jitter
   bounded so no two dots ever touch, r≈1px, ~24% coverage)
   each with its OWN colour scattered around a diagonal rainbow trend (the
   holo sheen), essentially invisible until a wide soft light band passes
   over it; the whole field hue-drifts as the camera moves. Nothing
   self-animates: the band position is driven by the canvas pan (see
   shimmerPhase), so the foil only glints while the user moves the canvas.
   - glitter: the resting dots at near-zero opacity (a whisper of texture).
   - glint: the same dots at full strength, masked by the moving band. */
.sticky-annotation__shimmer {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  overflow: hidden;
  pointer-events: none;
}
.sticky-annotation__glitter,
.sticky-annotation__glint {
  position: absolute;
  inset: 0;
  /* Every dot carries its own colour: a diagonal hue TREND across the tile
     (exactly one cycle per edge, so the repeat is seamless) plus a wide
     per-dot scatter in hue, lightness and size — the way the reference's
     foil reads, not a banded gradient. */
  background-image: url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='96'%20height='96'%3E%3Ccircle%20cx='4.98'%20cy='1.24'%20r='0.73'%20fill='%23f4d06a'/%3E%3Ccircle%20cx='8.04'%20cy='1.55'%20r='0.61'%20fill='%23feea38'/%3E%3Ccircle%20cx='14.1'%20cy='1.43'%20r='0.73'%20fill='%23ff0a1b'/%3E%3Ccircle%20cx='17.65'%20cy='2.05'%20r='0.81'%20fill='%2348f590'/%3E%3Ccircle%20cx='20.33'%20cy='1.84'%20r='1.0'%20fill='%230aff0c'/%3E%3Ccircle%20cx='23.69'%20cy='1.74'%20r='0.88'%20fill='%23ffe90a'/%3E%3Ccircle%20cx='30.3'%20cy='1.75'%20r='0.7'%20fill='%2363fee5'/%3E%3Ccircle%20cx='33.72'%20cy='1.65'%20r='0.63'%20fill='%23f1d54b'/%3E%3Ccircle%20cx='37.0'%20cy='1.2'%20r='0.82'%20fill='%23cbfe3f'/%3E%3Ccircle%20cx='39.94'%20cy='1.89'%20r='0.91'%20fill='%2346a6f1'/%3E%3Ccircle%20cx='42.89'%20cy='1.44'%20r='0.6'%20fill='%2369f9af'/%3E%3Ccircle%20cx='46.51'%20cy='1.74'%20r='0.72'%20fill='%23e6f7e2'/%3E%3Ccircle%20cx='49.83'%20cy='1.79'%20r='0.61'%20fill='%239a71fc'/%3E%3Ccircle%20cx='52.68'%20cy='1.38'%20r='0.56'%20fill='%230aceff'/%3E%3Ccircle%20cx='58.75'%20cy='1.71'%20r='0.94'%20fill='%23485bf4'/%3E%3Ccircle%20cx='62.42'%20cy='1.96'%20r='0.86'%20fill='%23a364f9'/%3E%3Ccircle%20cx='65.57'%20cy='1.23'%20r='0.87'%20fill='%23f85dfe'/%3E%3Ccircle%20cx='69.15'%20cy='1.22'%20r='0.62'%20fill='%23f355d8'/%3E%3Ccircle%20cx='72.21'%20cy='1.64'%20r='0.74'%20fill='%23ba37fc'/%3E%3Ccircle%20cx='74.96'%20cy='1.3'%20r='0.95'%20fill='%23f65469'/%3E%3Ccircle%20cx='78.1'%20cy='1.31'%20r='0.72'%20fill='%23893afb'/%3E%3Ccircle%20cx='81.58'%20cy='1.6'%20r='0.83'%20fill='%23f44948'/%3E%3Ccircle%20cx='87.97'%20cy='1.11'%20r='0.68'%20fill='%23f78b72'/%3E%3Ccircle%20cx='91.48'%20cy='1.33'%20r='0.73'%20fill='%23fd5677'/%3E%3Ccircle%20cx='94.47'%20cy='1.29'%20r='0.59'%20fill='%23fa57b4'/%3E%3Ccircle%20cx='1.49'%20cy='4.98'%20r='0.69'%20fill='%23f4ef56'/%3E%3Ccircle%20cx='5.01'%20cy='4.35'%20r='0.66'%20fill='%23b0fe63'/%3E%3Ccircle%20cx='7.99'%20cy='5.3'%20r='0.66'%20fill='%23ff930a'/%3E%3Ccircle%20cx='14.31'%20cy='4.84'%20r='0.57'%20fill='%23f7f5e2'/%3E%3Ccircle%20cx='17.58'%20cy='4.78'%20r='0.75'%20fill='%23aefd66'/%3E%3Ccircle%20cx='20.47'%20cy='4.39'%20r='0.7'%20fill='%2380fd47'/%3E%3Ccircle%20cx='24.44'%20cy='4.98'%20r='0.74'%20fill='%2398f36b'/%3E%3Ccircle%20cx='27.52'%20cy='5.04'%20r='0.73'%20fill='%235cf7ea'/%3E%3Ccircle%20cx='30.04'%20cy='4.89'%20r='0.75'%20fill='%2383fd3c'/%3E%3Ccircle%20cx='33.44'%20cy='5.26'%20r='0.65'%20fill='%236cf862'/%3E%3Ccircle%20cx='36.53'%20cy='4.56'%20r='0.63'%20fill='%236af5dd'/%3E%3Ccircle%20cx='39.77'%20cy='5.08'%20r='0.9'%20fill='%23e2f7ee'/%3E%3Ccircle%20cx='43.19'%20cy='4.65'%20r='0.79'%20fill='%233ee5f7'/%3E%3Ccircle%20cx='46.75'%20cy='4.85'%20r='0.69'%20fill='%236bd3fa'/%3E%3Ccircle%20cx='49.69'%20cy='5.07'%20r='0.8'%20fill='%2368eaf9'/%3E%3Ccircle%20cx='53.16'%20cy='5.28'%20r='0.79'%20fill='%2377a5f5'/%3E%3Ccircle%20cx='56.32'%20cy='5.17'%20r='0.79'%20fill='%23200aff'/%3E%3Ccircle%20cx='59.16'%20cy='4.43'%20r='0.63'%20fill='%23a366fd'/%3E%3Ccircle%20cx='62.56'%20cy='4.49'%20r='0.77'%20fill='%23e2e7f7'/%3E%3Ccircle%20cx='65.81'%20cy='5.04'%20r='0.62'%20fill='%233a46fb'/%3E%3Ccircle%20cx='68.59'%20cy='4.47'%20r='0.84'%20fill='%23e7e2f7'/%3E%3Ccircle%20cx='71.85'%20cy='4.48'%20r='0.93'%20fill='%23f152b8'/%3E%3Ccircle%20cx='75.1'%20cy='4.81'%20r='0.58'%20fill='%23ff0ab9'/%3E%3Ccircle%20cx='82.07'%20cy='5.16'%20r='0.61'%20fill='%23f670ec'/%3E%3Ccircle%20cx='84.66'%20cy='4.71'%20r='0.97'%20fill='%23743efd'/%3E%3Ccircle%20cx='88.06'%20cy='5.22'%20r='0.56'%20fill='%23f93e9b'/%3E%3Ccircle%20cx='91.19'%20cy='4.64'%20r='0.85'%20fill='%23ff0a31'/%3E%3Ccircle%20cx='94.13'%20cy='4.95'%20r='0.71'%20fill='%23f865c2'/%3E%3Ccircle%20cx='1.67'%20cy='8.48'%20r='0.75'%20fill='%23f7e2f1'/%3E%3Ccircle%20cx='5.1'%20cy='8.45'%20r='0.7'%20fill='%23f9bb61'/%3E%3Ccircle%20cx='8.05'%20cy='8.27'%20r='0.76'%20fill='%23f6f7e2'/%3E%3Ccircle%20cx='11.68'%20cy='8.44'%20r='0.86'%20fill='%23f7e844'/%3E%3Ccircle%20cx='14.59'%20cy='8.46'%20r='0.73'%20fill='%23e2f5f7'/%3E%3Ccircle%20cx='17.37'%20cy='7.54'%20r='0.82'%20fill='%2374f4af'/%3E%3Ccircle%20cx='20.86'%20cy='7.95'%20r='0.76'%20fill='%23b7f862'/%3E%3Ccircle%20cx='23.67'%20cy='7.84'%20r='0.97'%20fill='%233cfdd4'/%3E%3Ccircle%20cx='27.37'%20cy='7.99'%20r='0.58'%20fill='%2354f74a'/%3E%3Ccircle%20cx='30.28'%20cy='8.37'%20r='0.89'%20fill='%230acdff'/%3E%3Ccircle%20cx='33.19'%20cy='7.57'%20r='0.8'%20fill='%23e2f7f3'/%3E%3Ccircle%20cx='36.59'%20cy='7.62'%20r='0.92'%20fill='%234af1df'/%3E%3Ccircle%20cx='40.04'%20cy='8.38'%20r='1.0'%20fill='%2377f863'/%3E%3Ccircle%20cx='43.52'%20cy='8.32'%20r='0.79'%20fill='%2347f9de'/%3E%3Ccircle%20cx='46.82'%20cy='8.07'%20r='0.58'%20fill='%235efd8f'/%3E%3Ccircle%20cx='49.18'%20cy='7.75'%20r='0.81'%20fill='%2350f9ee'/%3E%3Ccircle%20cx='52.35'%20cy='7.86'%20r='0.72'%20fill='%23c544fc'/%3E%3Ccircle%20cx='55.7'%20cy='7.86'%20r='0.89'%20fill='%2373a4f3'/%3E%3Ccircle%20cx='58.99'%20cy='8.37'%20r='0.73'%20fill='%235151f4'/%3E%3Ccircle%20cx='62.32'%20cy='7.82'%20r='0.83'%20fill='%23460aff'/%3E%3Ccircle%20cx='65.91'%20cy='8.06'%20r='0.95'%20fill='%235637fc'/%3E%3Ccircle%20cx='69.03'%20cy='7.84'%20r='0.71'%20fill='%23e05ef7'/%3E%3Ccircle%20cx='72.06'%20cy='7.71'%20r='0.92'%20fill='%239b3df8'/%3E%3Ccircle%20cx='75.62'%20cy='7.87'%20r='0.69'%20fill='%23fa5b37'/%3E%3Ccircle%20cx='78.21'%20cy='7.91'%20r='0.81'%20fill='%23f85fec'/%3E%3Ccircle%20cx='81.21'%20cy='8.33'%20r='0.93'%20fill='%23f7e2eb'/%3E%3Ccircle%20cx='84.87'%20cy='8.5'%20r='0.59'%20fill='%23f447b2'/%3E%3Ccircle%20cx='87.74'%20cy='8.41'%20r='0.8'%20fill='%239049f4'/%3E%3Ccircle%20cx='94.63'%20cy='8.34'%20r='0.7'%20fill='%23c7f965'/%3E%3Ccircle%20cx='1.3'%20cy='10.99'%20r='0.71'%20fill='%238bfb50'/%3E%3Ccircle%20cx='5.15'%20cy='11.25'%20r='0.8'%20fill='%23dff945'/%3E%3Ccircle%20cx='8.19'%20cy='11.21'%20r='0.92'%20fill='%2391f740'/%3E%3Ccircle%20cx='10.89'%20cy='11.48'%20r='0.56'%20fill='%23d6f25d'/%3E%3Ccircle%20cx='14.2'%20cy='11.18'%20r='0.9'%20fill='%23c8f25c'/%3E%3Ccircle%20cx='17.76'%20cy='11.53'%20r='0.89'%20fill='%2374f78b'/%3E%3Ccircle%20cx='20.44'%20cy='11.23'%20r='0.77'%20fill='%23fb6479'/%3E%3Ccircle%20cx='24.41'%20cy='10.96'%20r='0.68'%20fill='%2354fd7f'/%3E%3Ccircle%20cx='30.09'%20cy='11.06'%20r='0.58'%20fill='%23ecf7e2'/%3E%3Ccircle%20cx='33.81'%20cy='10.71'%20r='0.6'%20fill='%2369fe91'/%3E%3Ccircle%20cx='39.68'%20cy='11.16'%20r='0.96'%20fill='%2349daf2'/%3E%3Ccircle%20cx='43.3'%20cy='10.84'%20r='0.89'%20fill='%23e2e4f7'/%3E%3Ccircle%20cx='45.91'%20cy='11.66'%20r='0.83'%20fill='%2349d2fd'/%3E%3Ccircle%20cx='49.57'%20cy='11.6'%20r='0.57'%20fill='%23876ff7'/%3E%3Ccircle%20cx='53.16'%20cy='10.98'%20r='0.69'%20fill='%23f764c6'/%3E%3Ccircle%20cx='55.55'%20cy='11.37'%20r='0.81'%20fill='%236e7efb'/%3E%3Ccircle%20cx='59.06'%20cy='11.21'%20r='0.84'%20fill='%23b356f7'/%3E%3Ccircle%20cx='61.94'%20cy='11.11'%20r='0.91'%20fill='%23f26af6'/%3E%3Ccircle%20cx='65.23'%20cy='10.89'%20r='0.93'%20fill='%23a34ef8'/%3E%3Ccircle%20cx='68.84'%20cy='11.6'%20r='0.92'%20fill='%23fd5a83'/%3E%3Ccircle%20cx='71.86'%20cy='11.68'%20r='0.97'%20fill='%23e2e4f7'/%3E%3Ccircle%20cx='75.52'%20cy='11.61'%20r='0.69'%20fill='%23b240f5'/%3E%3Ccircle%20cx='78.73'%20cy='11.29'%20r='0.64'%20fill='%23f652a3'/%3E%3Ccircle%20cx='82.09'%20cy='11.24'%20r='0.86'%20fill='%23db59f3'/%3E%3Ccircle%20cx='84.33'%20cy='10.9'%20r='0.86'%20fill='%23f469d5'/%3E%3Ccircle%20cx='88.18'%20cy='11.11'%20r='0.82'%20fill='%23fe34b4'/%3E%3Ccircle%20cx='91.58'%20cy='10.95'%20r='1.0'%20fill='%23f8c34b'/%3E%3Ccircle%20cx='94.6'%20cy='11.69'%20r='0.63'%20fill='%23fd4fce'/%3E%3Ccircle%20cx='1.52'%20cy='14.27'%20r='0.94'%20fill='%23f8d374'/%3E%3Ccircle%20cx='8.5'%20cy='14.9'%20r='0.74'%20fill='%2355fb4d'/%3E%3Ccircle%20cx='11.52'%20cy='14.47'%20r='0.66'%20fill='%2393f663'/%3E%3Ccircle%20cx='14.23'%20cy='14.35'%20r='0.57'%20fill='%2359fe7d'/%3E%3Ccircle%20cx='17.31'%20cy='14.05'%20r='0.62'%20fill='%2354fd4a'/%3E%3Ccircle%20cx='21.25'%20cy='14.41'%20r='0.76'%20fill='%235df6ce'/%3E%3Ccircle%20cx='24.34'%20cy='14.02'%20r='0.87'%20fill='%2357f8a4'/%3E%3Ccircle%20cx='29.91'%20cy='14.89'%20r='0.99'%20fill='%2342e2f1'/%3E%3Ccircle%20cx='33.51'%20cy='14.77'%20r='0.91'%20fill='%23520aff'/%3E%3Ccircle%20cx='36.63'%20cy='14.8'%20r='0.7'%20fill='%236bd6f8'/%3E%3Ccircle%20cx='39.85'%20cy='14.48'%20r='0.69'%20fill='%23efe2f7'/%3E%3Ccircle%20cx='43.2'%20cy='14.64'%20r='0.86'%20fill='%2369f3dd'/%3E%3Ccircle%20cx='46.09'%20cy='14.04'%20r='0.84'%20fill='%237c4af6'/%3E%3Ccircle%20cx='49.89'%20cy='14.65'%20r='0.98'%20fill='%23e2f1f7'/%3E%3Ccircle%20cx='56.11'%20cy='14.21'%20r='0.6'%20fill='%239949f6'/%3E%3Ccircle%20cx='59.0'%20cy='14.34'%20r='0.64'%20fill='%238a6cfb'/%3E%3Ccircle%20cx='62.41'%20cy='14.05'%20r='0.64'%20fill='%23e357fe'/%3E%3Ccircle%20cx='65.28'%20cy='14.74'%20r='0.57'%20fill='%23f5e2f7'/%3E%3Ccircle%20cx='69.06'%20cy='14.01'%20r='0.62'%20fill='%23f25daa'/%3E%3Ccircle%20cx='71.52'%20cy='14.56'%20r='0.85'%20fill='%23f3467d'/%3E%3Ccircle%20cx='75.46'%20cy='14.8'%20r='0.8'%20fill='%23f574db'/%3E%3Ccircle%20cx='78.65'%20cy='14.52'%20r='0.79'%20fill='%23fb61cc'/%3E%3Ccircle%20cx='81.29'%20cy='14.23'%20r='0.77'%20fill='%23f7e2ec'/%3E%3Ccircle%20cx='85.22'%20cy='14.32'%20r='0.76'%20fill='%23e5f248'/%3E%3Ccircle%20cx='87.74'%20cy='14.32'%20r='0.92'%20fill='%23fba870'/%3E%3Ccircle%20cx='90.82'%20cy='14.72'%20r='0.9'%20fill='%23ff5b0a'/%3E%3Ccircle%20cx='94.39'%20cy='14.32'%20r='0.92'%20fill='%2398fd71'/%3E%3Ccircle%20cx='1.63'%20cy='17.66'%20r='0.65'%20fill='%23fb893e'/%3E%3Ccircle%20cx='4.64'%20cy='17.25'%20r='0.98'%20fill='%2387f73b'/%3E%3Ccircle%20cx='11.42'%20cy='17.79'%20r='0.98'%20fill='%23f6cd67'/%3E%3Ccircle%20cx='14.02'%20cy='17.17'%20r='0.59'%20fill='%23e7f7e2'/%3E%3Ccircle%20cx='17.87'%20cy='17.83'%20r='0.97'%20fill='%23a4f45e'/%3E%3Ccircle%20cx='20.32'%20cy='17.12'%20r='0.97'%20fill='%2365fabc'/%3E%3Ccircle%20cx='23.92'%20cy='17.69'%20r='0.59'%20fill='%2348f4b8'/%3E%3Ccircle%20cx='27.7'%20cy='17.82'%20r='0.59'%20fill='%23e2f6f7'/%3E%3Ccircle%20cx='30.3'%20cy='17.41'%20r='0.99'%20fill='%234df0e2'/%3E%3Ccircle%20cx='34.07'%20cy='17.75'%20r='0.61'%20fill='%23579cf6'/%3E%3Ccircle%20cx='36.45'%20cy='17.37'%20r='0.86'%20fill='%235af8d6'/%3E%3Ccircle%20cx='43.6'%20cy='18.07'%20r='0.75'%20fill='%23720aff'/%3E%3Ccircle%20cx='46.64'%20cy='17.69'%20r='0.82'%20fill='%238644f9'/%3E%3Ccircle%20cx='49.17'%20cy='17.48'%20r='0.77'%20fill='%2341caf8'/%3E%3Ccircle%20cx='52.52'%20cy='17.93'%20r='0.86'%20fill='%230a86ff'/%3E%3Ccircle%20cx='56.35'%20cy='17.86'%20r='0.98'%20fill='%239946f7'/%3E%3Ccircle%20cx='59.66'%20cy='17.48'%20r='0.58'%20fill='%23f364b2'/%3E%3Ccircle%20cx='62.67'%20cy='17.58'%20r='0.64'%20fill='%23eee2f7'/%3E%3Ccircle%20cx='65.99'%20cy='17.82'%20r='0.72'%20fill='%23f963f0'/%3E%3Ccircle%20cx='68.59'%20cy='17.49'%20r='0.89'%20fill='%23f63eca'/%3E%3Ccircle%20cx='72.21'%20cy='18.01'%20r='0.7'%20fill='%23f8683a'/%3E%3Ccircle%20cx='75.22'%20cy='17.14'%20r='0.57'%20fill='%23f9e843'/%3E%3Ccircle%20cx='78.71'%20cy='17.33'%20r='0.69'%20fill='%23fca23b'/%3E%3Ccircle%20cx='81.69'%20cy='17.43'%20r='0.66'%20fill='%23f7cf59'/%3E%3Ccircle%20cx='84.96'%20cy='17.33'%20r='0.88'%20fill='%23f1774d'/%3E%3Ccircle%20cx='88.37'%20cy='17.37'%20r='0.95'%20fill='%23fd7c50'/%3E%3Ccircle%20cx='91.24'%20cy='17.56'%20r='0.83'%20fill='%23f85bf8'/%3E%3Ccircle%20cx='1.21'%20cy='21.2'%20r='0.63'%20fill='%235ef355'/%3E%3Ccircle%20cx='4.55'%20cy='20.73'%20r='0.75'%20fill='%23feac3d'/%3E%3Ccircle%20cx='8.48'%20cy='20.84'%20r='0.94'%20fill='%2383fb6b'/%3E%3Ccircle%20cx='11.54'%20cy='20.39'%20r='0.94'%20fill='%2399f66d'/%3E%3Ccircle%20cx='14.61'%20cy='20.56'%20r='0.95'%20fill='%23b3fc3d'/%3E%3Ccircle%20cx='17.41'%20cy='20.98'%20r='0.97'%20fill='%233efd92'/%3E%3Ccircle%20cx='21.05'%20cy='20.78'%20r='0.89'%20fill='%23e2f7ed'/%3E%3Ccircle%20cx='24.27'%20cy='20.44'%20r='0.95'%20fill='%2355f9d3'/%3E%3Ccircle%20cx='27.59'%20cy='21.17'%20r='0.85'%20fill='%2357d8f4'/%3E%3Ccircle%20cx='30.25'%20cy='20.39'%20r='0.7'%20fill='%2340fd49'/%3E%3Ccircle%20cx='33.94'%20cy='20.51'%20r='0.62'%20fill='%23bc69fe'/%3E%3Ccircle%20cx='36.44'%20cy='21.2'%20r='0.81'%20fill='%234cf2ad'/%3E%3Ccircle%20cx='39.74'%20cy='20.3'%20r='0.86'%20fill='%238e6efb'/%3E%3Ccircle%20cx='46.51'%20cy='21.12'%20r='0.71'%20fill='%237c5efd'/%3E%3Ccircle%20cx='49.77'%20cy='20.91'%20r='0.95'%20fill='%238f57f8'/%3E%3Ccircle%20cx='52.45'%20cy='21.04'%20r='0.66'%20fill='%23f54ee6'/%3E%3Ccircle%20cx='56.34'%20cy='21.28'%20r='0.7'%20fill='%23454efe'/%3E%3Ccircle%20cx='59.67'%20cy='20.46'%20r='0.83'%20fill='%23f96a97'/%3E%3Ccircle%20cx='62.43'%20cy='21.11'%20r='0.65'%20fill='%23f55e70'/%3E%3Ccircle%20cx='66.0'%20cy='21.11'%20r='0.9'%20fill='%23f5e2f7'/%3E%3Ccircle%20cx='69.16'%20cy='20.55'%20r='0.56'%20fill='%23f93e5e'/%3E%3Ccircle%20cx='74.97'%20cy='20.49'%20r='0.81'%20fill='%23ff4d0a'/%3E%3Ccircle%20cx='78.49'%20cy='20.36'%20r='0.99'%20fill='%23f79042'/%3E%3Ccircle%20cx='82.02'%20cy='20.69'%20r='0.71'%20fill='%23f5445f'/%3E%3Ccircle%20cx='88.2'%20cy='20.64'%20r='0.97'%20fill='%23ddfa59'/%3E%3Ccircle%20cx='91.15'%20cy='20.41'%20r='0.7'%20fill='%23e7fa6d'/%3E%3Ccircle%20cx='94.39'%20cy='21.16'%20r='0.78'%20fill='%23f7f5e2'/%3E%3Ccircle%20cx='1.75'%20cy='24.32'%20r='0.65'%20fill='%23eefb57'/%3E%3Ccircle%20cx='4.43'%20cy='24.43'%20r='0.82'%20fill='%234df1f2'/%3E%3Ccircle%20cx='8.33'%20cy='23.97'%20r='0.56'%20fill='%2366fadc'/%3E%3Ccircle%20cx='10.92'%20cy='24.07'%20r='0.84'%20fill='%233ea2f4'/%3E%3Ccircle%20cx='14.64'%20cy='23.74'%20r='0.61'%20fill='%236efee5'/%3E%3Ccircle%20cx='17.66'%20cy='23.64'%20r='0.74'%20fill='%2346fe7e'/%3E%3Ccircle%20cx='21.08'%20cy='24.36'%20r='0.96'%20fill='%23388efa'/%3E%3Ccircle%20cx='27.65'%20cy='24.1'%20r='0.81'%20fill='%23e2f7f1'/%3E%3Ccircle%20cx='30.22'%20cy='23.92'%20r='0.65'%20fill='%239b72f5'/%3E%3Ccircle%20cx='33.71'%20cy='24.4'%20r='0.69'%20fill='%2351f4f5'/%3E%3Ccircle%20cx='36.58'%20cy='24.25'%20r='0.6'%20fill='%233d88fd'/%3E%3Ccircle%20cx='39.7'%20cy='24.44'%20r='0.85'%20fill='%237760fb'/%3E%3Ccircle%20cx='43.38'%20cy='24.46'%20r='0.71'%20fill='%238568f9'/%3E%3Ccircle%20cx='45.96'%20cy='23.84'%20r='0.72'%20fill='%234e98f2'/%3E%3Ccircle%20cx='49.61'%20cy='24.39'%20r='0.74'%20fill='%234c3efd'/%3E%3Ccircle%20cx='52.8'%20cy='24.23'%20r='0.78'%20fill='%23f248e8'/%3E%3Ccircle%20cx='55.81'%20cy='24.1'%20r='0.65'%20fill='%23f2e2f7'/%3E%3Ccircle%20cx='58.88'%20cy='23.66'%20r='0.89'%20fill='%23f9719e'/%3E%3Ccircle%20cx='62.3'%20cy='23.82'%20r='0.89'%20fill='%23f96c7d'/%3E%3Ccircle%20cx='65.69'%20cy='24.01'%20r='0.7'%20fill='%23a60aff'/%3E%3Ccircle%20cx='68.31'%20cy='24.38'%20r='0.61'%20fill='%23f5b771'/%3E%3Ccircle%20cx='71.66'%20cy='24.3'%20r='0.8'%20fill='%23fde44e'/%3E%3Ccircle%20cx='75.15'%20cy='24.2'%20r='0.89'%20fill='%23fd656d'/%3E%3Ccircle%20cx='77.95'%20cy='24.31'%20r='0.71'%20fill='%23f59e6a'/%3E%3Ccircle%20cx='82.06'%20cy='23.91'%20r='0.64'%20fill='%23fbf257'/%3E%3Ccircle%20cx='85.05'%20cy='23.61'%20r='0.63'%20fill='%23effc69'/%3E%3Ccircle%20cx='87.74'%20cy='23.99'%20r='0.56'%20fill='%23fb8a3d'/%3E%3Ccircle%20cx='91.3'%20cy='24.11'%20r='0.92'%20fill='%23f7d06e'/%3E%3Ccircle%20cx='94.4'%20cy='23.9'%20r='0.71'%20fill='%23dafa5d'/%3E%3Ccircle%20cx='1.5'%20cy='27.3'%20r='0.67'%20fill='%23f5e74b'/%3E%3Ccircle%20cx='5.13'%20cy='27.41'%20r='0.72'%20fill='%23bcfb65'/%3E%3Ccircle%20cx='8.38'%20cy='27.28'%20r='0.6'%20fill='%2343fe46'/%3E%3Ccircle%20cx='11.5'%20cy='26.76'%20r='0.85'%20fill='%237afa56'/%3E%3Ccircle%20cx='14.14'%20cy='27.57'%20r='0.58'%20fill='%235bf999'/%3E%3Ccircle%20cx='20.62'%20cy='26.72'%20r='0.85'%20fill='%237378fb'/%3E%3Ccircle%20cx='23.94'%20cy='26.75'%20r='0.6'%20fill='%235e58f4'/%3E%3Ccircle%20cx='27.25'%20cy='26.81'%20r='0.91'%20fill='%2344f1b3'/%3E%3Ccircle%20cx='30.19'%20cy='26.76'%20r='0.71'%20fill='%239046fc'/%3E%3Ccircle%20cx='33.72'%20cy='26.79'%20r='0.84'%20fill='%236cdef7'/%3E%3Ccircle%20cx='37.29'%20cy='27.42'%20r='0.58'%20fill='%237b70f7'/%3E%3Ccircle%20cx='40.13'%20cy='27.21'%20r='0.59'%20fill='%23575df8'/%3E%3Ccircle%20cx='43.3'%20cy='27.65'%20r='0.78'%20fill='%23da51fb'/%3E%3Ccircle%20cx='46.34'%20cy='26.87'%20r='0.87'%20fill='%23ed40f2'/%3E%3Ccircle%20cx='49.83'%20cy='27.25'%20r='0.82'%20fill='%23c93bf9'/%3E%3Ccircle%20cx='52.71'%20cy='26.91'%20r='0.65'%20fill='%23fb4afa'/%3E%3Ccircle%20cx='56.4'%20cy='27.33'%20r='0.7'%20fill='%23f841cc'/%3E%3Ccircle%20cx='62.32'%20cy='26.81'%20r='0.61'%20fill='%23f673f5'/%3E%3Ccircle%20cx='65.97'%20cy='26.97'%20r='0.76'%20fill='%23b74ffd'/%3E%3Ccircle%20cx='69.29'%20cy='26.78'%20r='0.67'%20fill='%23ff0a18'/%3E%3Ccircle%20cx='71.97'%20cy='27.21'%20r='0.89'%20fill='%23ff0ae1'/%3E%3Ccircle%20cx='74.77'%20cy='27.1'%20r='0.59'%20fill='%23fb765c'/%3E%3Ccircle%20cx='78.34'%20cy='27.44'%20r='0.69'%20fill='%23fdb440'/%3E%3Ccircle%20cx='81.66'%20cy='27.52'%20r='0.93'%20fill='%23defa5f'/%3E%3Ccircle%20cx='84.86'%20cy='27.3'%20r='0.97'%20fill='%23fa7e6a'/%3E%3Ccircle%20cx='87.61'%20cy='27.47'%20r='0.69'%20fill='%23ffb20a'/%3E%3Ccircle%20cx='91.46'%20cy='27.51'%20r='0.99'%20fill='%2348fbba'/%3E%3Ccircle%20cx='94.38'%20cy='26.98'%20r='0.95'%20fill='%23f6e95f'/%3E%3Ccircle%20cx='1.97'%20cy='30.81'%20r='0.6'%20fill='%23f1bf4b'/%3E%3Ccircle%20cx='5.16'%20cy='30.89'%20r='0.76'%20fill='%2352f976'/%3E%3Ccircle%20cx='8.1'%20cy='30.16'%20r='0.58'%20fill='%238cfb52'/%3E%3Ccircle%20cx='10.77'%20cy='30.51'%20r='0.96'%20fill='%236ea2f7'/%3E%3Ccircle%20cx='17.32'%20cy='30.66'%20r='0.9'%20fill='%23e2f7f3'/%3E%3Ccircle%20cx='20.51'%20cy='30.87'%20r='0.77'%20fill='%238efc5b'/%3E%3Ccircle%20cx='23.57'%20cy='30.9'%20r='0.76'%20fill='%235f6af4'/%3E%3Ccircle%20cx='27.02'%20cy='30.26'%20r='0.82'%20fill='%234fa8fc'/%3E%3Ccircle%20cx='29.99'%20cy='30.6'%20r='0.96'%20fill='%23e2f6f7'/%3E%3Ccircle%20cx='34.05'%20cy='29.95'%20r='0.75'%20fill='%23dd65f7'/%3E%3Ccircle%20cx='40.01'%20cy='30.48'%20r='0.69'%20fill='%237085f4'/%3E%3Ccircle%20cx='42.93'%20cy='30.4'%20r='0.63'%20fill='%2366c2fc'/%3E%3Ccircle%20cx='46.34'%20cy='30.66'%20r='0.9'%20fill='%23fa5665'/%3E%3Ccircle%20cx='49.13'%20cy='30.28'%20r='0.57'%20fill='%23e2e2f7'/%3E%3Ccircle%20cx='52.58'%20cy='30.0'%20r='0.97'%20fill='%23a244fe'/%3E%3Ccircle%20cx='55.74'%20cy='29.97'%20r='0.67'%20fill='%23fd6dc8'/%3E%3Ccircle%20cx='58.77'%20cy='30.85'%20r='0.71'%20fill='%23fe50e8'/%3E%3Ccircle%20cx='61.95'%20cy='30.28'%20r='0.78'%20fill='%23f74ab0'/%3E%3Ccircle%20cx='66.03'%20cy='30.53'%20r='0.91'%20fill='%23eb59f5'/%3E%3Ccircle%20cx='69.13'%20cy='30.8'%20r='0.88'%20fill='%23fa4f9f'/%3E%3Ccircle%20cx='72.44'%20cy='30.19'%20r='0.75'%20fill='%23f3a56b'/%3E%3Ccircle%20cx='75.25'%20cy='30.55'%20r='0.89'%20fill='%23fbdf53'/%3E%3Ccircle%20cx='78.37'%20cy='30.64'%20r='0.6'%20fill='%2396fb68'/%3E%3Ccircle%20cx='81.22'%20cy='30.23'%20r='0.55'%20fill='%23a6f84e'/%3E%3Ccircle%20cx='84.87'%20cy='30.68'%20r='0.89'%20fill='%23f7f7e2'/%3E%3Ccircle%20cx='88.34'%20cy='30.2'%20r='0.6'%20fill='%235af48f'/%3E%3Ccircle%20cx='1.89'%20cy='33.87'%20r='0.76'%20fill='%23e2f7f5'/%3E%3Ccircle%20cx='4.78'%20cy='33.24'%20r='0.83'%20fill='%2363fe6d'/%3E%3Ccircle%20cx='8.3'%20cy='33.35'%20r='0.58'%20fill='%23693cfc'/%3E%3Ccircle%20cx='11.53'%20cy='33.12'%20r='0.67'%20fill='%2341fdd8'/%3E%3Ccircle%20cx='14.86'%20cy='33.75'%20r='0.98'%20fill='%236cfcfc'/%3E%3Ccircle%20cx='21.04'%20cy='33.91'%20r='0.65'%20fill='%236f50f0'/%3E%3Ccircle%20cx='23.88'%20cy='33.3'%20r='0.84'%20fill='%2372f6d6'/%3E%3Ccircle%20cx='27.59'%20cy='33.91'%20r='0.74'%20fill='%23c452f8'/%3E%3Ccircle%20cx='29.93'%20cy='33.5'%20r='0.58'%20fill='%23e2f5f7'/%3E%3Ccircle%20cx='33.67'%20cy='33.12'%20r='0.76'%20fill='%23f243f4'/%3E%3Ccircle%20cx='36.37'%20cy='33.55'%20r='0.8'%20fill='%23360aff'/%3E%3Ccircle%20cx='40.46'%20cy='33.24'%20r='0.72'%20fill='%23bb39fe'/%3E%3Ccircle%20cx='43.47'%20cy='33.32'%20r='0.93'%20fill='%2347c7fe'/%3E%3Ccircle%20cx='45.99'%20cy='33.71'%20r='0.85'%20fill='%23e853f9'/%3E%3Ccircle%20cx='49.19'%20cy='33.93'%20r='0.74'%20fill='%23f566b1'/%3E%3Ccircle%20cx='53.02'%20cy='33.51'%20r='0.85'%20fill='%23f7ebe2'/%3E%3Ccircle%20cx='59.61'%20cy='33.75'%20r='0.95'%20fill='%23f43e7a'/%3E%3Ccircle%20cx='62.5'%20cy='33.76'%20r='0.86'%20fill='%23f96be4'/%3E%3Ccircle%20cx='65.51'%20cy='33.1'%20r='0.94'%20fill='%23f85f8e'/%3E%3Ccircle%20cx='68.5'%20cy='33.63'%20r='0.63'%20fill='%23f7f2e2'/%3E%3Ccircle%20cx='71.66'%20cy='33.18'%20r='0.79'%20fill='%23f5b875'/%3E%3Ccircle%20cx='75.27'%20cy='33.57'%20r='0.64'%20fill='%2394fa72'/%3E%3Ccircle%20cx='77.94'%20cy='34.08'%20r='0.88'%20fill='%23f4e558'/%3E%3Ccircle%20cx='81.91'%20cy='33.22'%20r='0.92'%20fill='%23c4fe68'/%3E%3Ccircle%20cx='84.95'%20cy='33.42'%20r='0.87'%20fill='%2392f347'/%3E%3Ccircle%20cx='87.86'%20cy='34.08'%20r='0.77'%20fill='%237ffb4d'/%3E%3Ccircle%20cx='91.21'%20cy='33.94'%20r='0.67'%20fill='%239cff0a'/%3E%3Ccircle%20cx='94.9'%20cy='34.06'%20r='0.8'%20fill='%23c9fa65'/%3E%3Ccircle%20cx='2.09'%20cy='36.75'%20r='0.91'%20fill='%234cfe57'/%3E%3Ccircle%20cx='4.54'%20cy='36.6'%20r='0.98'%20fill='%2355fc9d'/%3E%3Ccircle%20cx='8.33'%20cy='36.95'%20r='0.82'%20fill='%234cf2c4'/%3E%3Ccircle%20cx='11.49'%20cy='37.01'%20r='0.93'%20fill='%234afc9c'/%3E%3Ccircle%20cx='14.8'%20cy='36.69'%20r='0.84'%20fill='%2362fca5'/%3E%3Ccircle%20cx='17.71'%20cy='36.68'%20r='0.6'%20fill='%236bf6c1'/%3E%3Ccircle%20cx='20.35'%20cy='37.1'%20r='0.94'%20fill='%237956f4'/%3E%3Ccircle%20cx='23.98'%20cy='36.88'%20r='0.9'%20fill='%23e2f0f7'/%3E%3Ccircle%20cx='26.75'%20cy='37.01'%20r='0.58'%20fill='%230a51ff'/%3E%3Ccircle%20cx='29.99'%20cy='36.56'%20r='0.56'%20fill='%235381f5'/%3E%3Ccircle%20cx='33.3'%20cy='37.05'%20r='0.92'%20fill='%23fa4f68'/%3E%3Ccircle%20cx='36.69'%20cy='36.3'%20r='0.99'%20fill='%23b057f5'/%3E%3Ccircle%20cx='42.75'%20cy='36.62'%20r='0.86'%20fill='%238956fa'/%3E%3Ccircle%20cx='46.23'%20cy='37.06'%20r='0.69'%20fill='%239c4af6'/%3E%3Ccircle%20cx='49.32'%20cy='37.09'%20r='0.9'%20fill='%23fbe163'/%3E%3Ccircle%20cx='53.19'%20cy='37.04'%20r='0.79'%20fill='%238566f5'/%3E%3Ccircle%20cx='56.16'%20cy='37.19'%20r='0.87'%20fill='%23fc3fcd'/%3E%3Ccircle%20cx='59.39'%20cy='36.3'%20r='0.65'%20fill='%23f675ad'/%3E%3Ccircle%20cx='62.7'%20cy='36.72'%20r='0.9'%20fill='%23fb6d40'/%3E%3Ccircle%20cx='65.32'%20cy='37.15'%20r='0.9'%20fill='%23fc587a'/%3E%3Ccircle%20cx='69.01'%20cy='36.71'%20r='0.8'%20fill='%23f6566f'/%3E%3Ccircle%20cx='71.54'%20cy='36.82'%20r='0.98'%20fill='%23f76f40'/%3E%3Ccircle%20cx='74.9'%20cy='37.25'%20r='0.7'%20fill='%23fbc655'/%3E%3Ccircle%20cx='78.14'%20cy='36.92'%20r='0.83'%20fill='%23eff7e2'/%3E%3Ccircle%20cx='81.18'%20cy='36.96'%20r='0.93'%20fill='%23f7f3e2'/%3E%3Ccircle%20cx='84.42'%20cy='37.23'%20r='0.78'%20fill='%23b8f657'/%3E%3Ccircle%20cx='88.31'%20cy='37.03'%20r='0.81'%20fill='%2342f4df'/%3E%3Ccircle%20cx='91.34'%20cy='36.36'%20r='0.57'%20fill='%234cf453'/%3E%3Ccircle%20cx='93.98'%20cy='36.36'%20r='0.59'%20fill='%2341fe81'/%3E%3Ccircle%20cx='5.28'%20cy='40.1'%20r='0.71'%20fill='%2358f35e'/%3E%3Ccircle%20cx='7.56'%20cy='40.1'%20r='0.96'%20fill='%2346fbb2'/%3E%3Ccircle%20cx='11.55'%20cy='39.54'%20r='0.77'%20fill='%230a2dff'/%3E%3Ccircle%20cx='14.69'%20cy='39.52'%20r='0.71'%20fill='%2373e1f8'/%3E%3Ccircle%20cx='17.73'%20cy='39.84'%20r='0.59'%20fill='%236cf8cc'/%3E%3Ccircle%20cx='20.57'%20cy='39.84'%20r='0.85'%20fill='%235aa4f5'/%3E%3Ccircle%20cx='24.44'%20cy='40.46'%20r='0.75'%20fill='%236dc0f3'/%3E%3Ccircle%20cx='27.42'%20cy='39.96'%20r='0.72'%20fill='%237f42f8'/%3E%3Ccircle%20cx='29.97'%20cy='39.94'%20r='0.67'%20fill='%23f5e2f7'/%3E%3Ccircle%20cx='33.95'%20cy='40.17'%20r='0.59'%20fill='%23b055f9'/%3E%3Ccircle%20cx='37.1'%20cy='39.58'%20r='0.75'%20fill='%23804efa'/%3E%3Ccircle%20cx='40.04'%20cy='40.14'%20r='0.89'%20fill='%23f7e2f6'/%3E%3Ccircle%20cx='43.65'%20cy='39.93'%20r='0.77'%20fill='%23fe4dcd'/%3E%3Ccircle%20cx='46.35'%20cy='39.95'%20r='0.58'%20fill='%23d364f4'/%3E%3Ccircle%20cx='49.84'%20cy='39.61'%20r='0.99'%20fill='%23f7e9e2'/%3E%3Ccircle%20cx='52.74'%20cy='40.45'%20r='0.62'%20fill='%23f5955a'/%3E%3Ccircle%20cx='56.49'%20cy='39.93'%20r='0.69'%20fill='%23f45ed3'/%3E%3Ccircle%20cx='59.11'%20cy='40.25'%20r='0.72'%20fill='%23fbf463'/%3E%3Ccircle%20cx='62.73'%20cy='40.23'%20r='0.88'%20fill='%23fe6273'/%3E%3Ccircle%20cx='66.02'%20cy='40.39'%20r='0.57'%20fill='%23a4f74d'/%3E%3Ccircle%20cx='68.95'%20cy='40.17'%20r='0.7'%20fill='%23fbb05f'/%3E%3Ccircle%20cx='72.41'%20cy='40.26'%20r='0.55'%20fill='%23f79657'/%3E%3Ccircle%20cx='75.4'%20cy='40.31'%20r='0.81'%20fill='%233afa63'/%3E%3Ccircle%20cx='78.4'%20cy='39.52'%20r='0.63'%20fill='%23d3fe69'/%3E%3Ccircle%20cx='81.4'%20cy='39.55'%20r='0.7'%20fill='%23f9e65e'/%3E%3Ccircle%20cx='85.0'%20cy='40.13'%20r='0.7'%20fill='%2388f74c'/%3E%3Ccircle%20cx='88.23'%20cy='39.73'%20r='0.57'%20fill='%23d6f55e'/%3E%3Ccircle%20cx='90.78'%20cy='40.41'%20r='0.85'%20fill='%2354fda6'/%3E%3Ccircle%20cx='94.87'%20cy='40.5'%20r='0.73'%20fill='%230cff0a'/%3E%3Ccircle%20cx='1.82'%20cy='43.7'%20r='0.71'%20fill='%23a6fd66'/%3E%3Ccircle%20cx='4.49'%20cy='42.91'%20r='0.98'%20fill='%234e9df3'/%3E%3Ccircle%20cx='8.09'%20cy='43.57'%20r='0.91'%20fill='%230a9fff'/%3E%3Ccircle%20cx='10.71'%20cy='43.02'%20r='0.76'%20fill='%23a568fd'/%3E%3Ccircle%20cx='13.97'%20cy='42.74'%20r='0.71'%20fill='%2343cefa'/%3E%3Ccircle%20cx='17.58'%20cy='43.31'%20r='0.68'%20fill='%23d379f5'/%3E%3Ccircle%20cx='20.46'%20cy='43.54'%20r='0.58'%20fill='%239770fd'/%3E%3Ccircle%20cx='23.61'%20cy='43.45'%20r='0.83'%20fill='%23a372f6'/%3E%3Ccircle%20cx='27.38'%20cy='43.09'%20r='0.92'%20fill='%237a66fc'/%3E%3Ccircle%20cx='30.33'%20cy='43.56'%20r='0.59'%20fill='%239f42f6'/%3E%3Ccircle%20cx='33.34'%20cy='43.64'%20r='0.57'%20fill='%23df56fb'/%3E%3Ccircle%20cx='36.62'%20cy='43.18'%20r='0.58'%20fill='%23ef6ef6'/%3E%3Ccircle%20cx='39.61'%20cy='43.7'%20r='0.61'%20fill='%23ff0a9c'/%3E%3Ccircle%20cx='43.08'%20cy='43.66'%20r='0.87'%20fill='%23fa5be9'/%3E%3Ccircle%20cx='46.18'%20cy='43.47'%20r='0.6'%20fill='%23f46bf9'/%3E%3Ccircle%20cx='49.34'%20cy='43.17'%20r='0.93'%20fill='%23f8c768'/%3E%3Ccircle%20cx='53.11'%20cy='42.93'%20r='0.98'%20fill='%23f85894'/%3E%3Ccircle%20cx='58.95'%20cy='42.84'%20r='0.76'%20fill='%23faba4a'/%3E%3Ccircle%20cx='62.6'%20cy='43.21'%20r='0.57'%20fill='%23f77664'/%3E%3Ccircle%20cx='65.92'%20cy='43.66'%20r='0.72'%20fill='%23fd358d'/%3E%3Ccircle%20cx='71.52'%20cy='43.42'%20r='0.64'%20fill='%23eff769'/%3E%3Ccircle%20cx='74.74'%20cy='43.42'%20r='0.88'%20fill='%2373fc68'/%3E%3Ccircle%20cx='78.53'%20cy='42.75'%20r='0.72'%20fill='%2354f351'/%3E%3Ccircle%20cx='81.31'%20cy='43.29'%20r='0.87'%20fill='%23e9f359'/%3E%3Ccircle%20cx='84.7'%20cy='43.52'%20r='0.81'%20fill='%233df6b8'/%3E%3Ccircle%20cx='87.63'%20cy='43.2'%20r='0.96'%20fill='%2362effc'/%3E%3Ccircle%20cx='91.48'%20cy='43.31'%20r='0.72'%20fill='%2352fbd7'/%3E%3Ccircle%20cx='94.32'%20cy='42.85'%20r='0.74'%20fill='%235ef6e9'/%3E%3Ccircle%20cx='1.52'%20cy='46.79'%20r='0.62'%20fill='%2347a4fe'/%3E%3Ccircle%20cx='4.44'%20cy='46.36'%20r='0.59'%20fill='%23623bf7'/%3E%3Ccircle%20cx='8.18'%20cy='46.48'%20r='0.92'%20fill='%2353a5fc'/%3E%3Ccircle%20cx='11.17'%20cy='46.66'%20r='0.68'%20fill='%23e2ebf7'/%3E%3Ccircle%20cx='17.83'%20cy='46.17'%20r='0.79'%20fill='%23eee2f7'/%3E%3Ccircle%20cx='21.19'%20cy='46.11'%20r='0.71'%20fill='%23805df4'/%3E%3Ccircle%20cx='23.78'%20cy='46.11'%20r='0.95'%20fill='%238570fd'/%3E%3Ccircle%20cx='27.44'%20cy='46.62'%20r='0.8'%20fill='%23f35f93'/%3E%3Ccircle%20cx='30.44'%20cy='46.53'%20r='0.96'%20fill='%23f2e2f7'/%3E%3Ccircle%20cx='33.85'%20cy='46.6'%20r='0.59'%20fill='%23f24adc'/%3E%3Ccircle%20cx='36.84'%20cy='46.21'%20r='0.64'%20fill='%23f7e2ea'/%3E%3Ccircle%20cx='39.55'%20cy='45.99'%20r='0.56'%20fill='%23fe489b'/%3E%3Ccircle%20cx='43.1'%20cy='46.79'%20r='0.71'%20fill='%23fe934c'/%3E%3Ccircle%20cx='46.9'%20cy='46.06'%20r='0.89'%20fill='%23f6c143'/%3E%3Ccircle%20cx='49.86'%20cy='46.77'%20r='0.84'%20fill='%23fd8f58'/%3E%3Ccircle%20cx='52.56'%20cy='46.2'%20r='0.64'%20fill='%23ff290a'/%3E%3Ccircle%20cx='55.66'%20cy='46.74'%20r='0.57'%20fill='%23f3e56a'/%3E%3Ccircle%20cx='59.15'%20cy='46.16'%20r='0.88'%20fill='%23f9c264'/%3E%3Ccircle%20cx='62.65'%20cy='46.14'%20r='0.72'%20fill='%23d1fa57'/%3E%3Ccircle%20cx='65.84'%20cy='46.57'%20r='0.74'%20fill='%23c7f64f'/%3E%3Ccircle%20cx='69.05'%20cy='46.23'%20r='0.75'%20fill='%23fc9048'/%3E%3Ccircle%20cx='71.76'%20cy='45.9'%20r='0.64'%20fill='%2363fcc3'/%3E%3Ccircle%20cx='75.45'%20cy='46.06'%20r='0.82'%20fill='%23edf7e2'/%3E%3Ccircle%20cx='78.78'%20cy='46.04'%20r='0.7'%20fill='%23fc546d'/%3E%3Ccircle%20cx='81.76'%20cy='46.89'%20r='0.84'%20fill='%2346fe35'/%3E%3Ccircle%20cx='84.97'%20cy='46.38'%20r='0.62'%20fill='%2346fea8'/%3E%3Ccircle%20cx='88.49'%20cy='46.56'%20r='0.92'%20fill='%2368f3a3'/%3E%3Ccircle%20cx='91.24'%20cy='46.17'%20r='0.55'%20fill='%23e2f7ed'/%3E%3Ccircle%20cx='94.64'%20cy='46.37'%20r='0.73'%20fill='%23e2f7ef'/%3E%3Ccircle%20cx='1.76'%20cy='49.97'%20r='0.61'%20fill='%23e2f7f4'/%3E%3Ccircle%20cx='4.54'%20cy='49.5'%20r='0.74'%20fill='%236df6e5'/%3E%3Ccircle%20cx='11.09'%20cy='49.88'%20r='0.88'%20fill='%23efe2f7'/%3E%3Ccircle%20cx='17.42'%20cy='49.15'%20r='0.76'%20fill='%234164fb'/%3E%3Ccircle%20cx='20.49'%20cy='49.95'%20r='0.67'%20fill='%23f1446d'/%3E%3Ccircle%20cx='23.68'%20cy='49.22'%20r='0.85'%20fill='%23e6e2f7'/%3E%3Ccircle%20cx='27.43'%20cy='50.02'%20r='0.92'%20fill='%235644fd'/%3E%3Ccircle%20cx='30.53'%20cy='49.76'%20r='0.9'%20fill='%23fcd766'/%3E%3Ccircle%20cx='33.13'%20cy='49.41'%20r='0.76'%20fill='%23f362c9'/%3E%3Ccircle%20cx='37.12'%20cy='49.45'%20r='0.61'%20fill='%23f455fb'/%3E%3Ccircle%20cx='40.45'%20cy='49.68'%20r='0.99'%20fill='%23f651ad'/%3E%3Ccircle%20cx='43.49'%20cy='49.29'%20r='0.98'%20fill='%23fc70e0'/%3E%3Ccircle%20cx='46.51'%20cy='49.57'%20r='0.73'%20fill='%23daf76a'/%3E%3Ccircle%20cx='49.77'%20cy='49.89'%20r='0.79'%20fill='%23f548c9'/%3E%3Ccircle%20cx='52.97'%20cy='49.31'%20r='0.91'%20fill='%23f5467b'/%3E%3Ccircle%20cx='55.98'%20cy='49.68'%20r='0.82'%20fill='%23fc718b'/%3E%3Ccircle%20cx='59.67'%20cy='49.14'%20r='0.78'%20fill='%23f75f7e'/%3E%3Ccircle%20cx='62.29'%20cy='49.71'%20r='0.88'%20fill='%23eff7e2'/%3E%3Ccircle%20cx='66.01'%20cy='49.6'%20r='0.78'%20fill='%238df56e'/%3E%3Ccircle%20cx='68.78'%20cy='49.12'%20r='0.96'%20fill='%23f9613d'/%3E%3Ccircle%20cx='71.8'%20cy='49.32'%20r='0.95'%20fill='%23f7f7e2'/%3E%3Ccircle%20cx='74.78'%20cy='49.3'%20r='0.98'%20fill='%23befa6a'/%3E%3Ccircle%20cx='78.55'%20cy='49.38'%20r='0.9'%20fill='%23bbfc71'/%3E%3Ccircle%20cx='81.43'%20cy='49.48'%20r='0.68'%20fill='%234af17d'/%3E%3Ccircle%20cx='85.03'%20cy='49.62'%20r='0.56'%20fill='%2344fe57'/%3E%3Ccircle%20cx='87.74'%20cy='49.73'%20r='0.8'%20fill='%235dfd60'/%3E%3Ccircle%20cx='91.26'%20cy='50.08'%20r='0.75'%20fill='%230aff10'/%3E%3Ccircle%20cx='94.4'%20cy='49.83'%20r='0.74'%20fill='%2371f5b6'/%3E%3Ccircle%20cx='1.24'%20cy='52.56'%20r='0.67'%20fill='%233cfabf'/%3E%3Ccircle%20cx='4.71'%20cy='52.36'%20r='0.8'%20fill='%23a46ef4'/%3E%3Ccircle%20cx='8.39'%20cy='52.54'%20r='0.99'%20fill='%2357c6f7'/%3E%3Ccircle%20cx='11.04'%20cy='52.37'%20r='0.89'%20fill='%23845af4'/%3E%3Ccircle%20cx='14.04'%20cy='52.41'%20r='0.65'%20fill='%239f39fc'/%3E%3Ccircle%20cx='17.13'%20cy='53.03'%20r='1.0'%20fill='%23aa60fd'/%3E%3Ccircle%20cx='21.1'%20cy='52.71'%20r='0.57'%20fill='%23f15af9'/%3E%3Ccircle%20cx='23.81'%20cy='53.29'%20r='0.56'%20fill='%23cc71fc'/%3E%3Ccircle%20cx='27.49'%20cy='53.05'%20r='0.75'%20fill='%23f85ebb'/%3E%3Ccircle%20cx='30.67'%20cy='52.75'%20r='0.65'%20fill='%23e070f7'/%3E%3Ccircle%20cx='33.64'%20cy='52.84'%20r='0.73'%20fill='%238249f1'/%3E%3Ccircle%20cx='36.55'%20cy='52.81'%20r='0.85'%20fill='%23f6854e'/%3E%3Ccircle%20cx='39.91'%20cy='53.2'%20r='0.58'%20fill='%23fd6fa6'/%3E%3Ccircle%20cx='42.74'%20cy='52.91'%20r='0.63'%20fill='%23f74c6a'/%3E%3Ccircle%20cx='46.2'%20cy='52.92'%20r='0.77'%20fill='%23fd50d1'/%3E%3Ccircle%20cx='49.12'%20cy='52.32'%20r='0.61'%20fill='%23ff9c0a'/%3E%3Ccircle%20cx='52.7'%20cy='53.09'%20r='0.91'%20fill='%23ebff0a'/%3E%3Ccircle%20cx='56.48'%20cy='52.79'%20r='0.65'%20fill='%23f8cf3a'/%3E%3Ccircle%20cx='58.79'%20cy='52.39'%20r='0.81'%20fill='%23aff743'/%3E%3Ccircle%20cx='62.01'%20cy='52.3'%20r='0.92'%20fill='%238ef04d'/%3E%3Ccircle%20cx='65.11'%20cy='52.84'%20r='0.67'%20fill='%2349f7c5'/%3E%3Ccircle%20cx='68.7'%20cy='52.97'%20r='0.9'%20fill='%233cfd4f'/%3E%3Ccircle%20cx='72.24'%20cy='52.44'%20r='0.62'%20fill='%2362f46a'/%3E%3Ccircle%20cx='75.53'%20cy='53.09'%20r='0.63'%20fill='%2346f8c2'/%3E%3Ccircle%20cx='78.77'%20cy='52.53'%20r='0.93'%20fill='%2355fb60'/%3E%3Ccircle%20cx='81.99'%20cy='53.16'%20r='0.69'%20fill='%234afc60'/%3E%3Ccircle%20cx='84.66'%20cy='52.41'%20r='0.7'%20fill='%23e2f7f7'/%3E%3Ccircle%20cx='88.35'%20cy='52.66'%20r='0.75'%20fill='%23e2f7e9'/%3E%3Ccircle%20cx='91.43'%20cy='52.65'%20r='0.89'%20fill='%23e2f7ea'/%3E%3Ccircle%20cx='94.71'%20cy='52.9'%20r='0.98'%20fill='%230b0aff'/%3E%3Ccircle%20cx='2.03'%20cy='55.57'%20r='0.6'%20fill='%23e2e6f7'/%3E%3Ccircle%20cx='5.06'%20cy='55.94'%20r='0.78'%20fill='%233cf8c6'/%3E%3Ccircle%20cx='7.76'%20cy='56.07'%20r='0.96'%20fill='%235961f5'/%3E%3Ccircle%20cx='11.43'%20cy='56.34'%20r='0.72'%20fill='%23796ff5'/%3E%3Ccircle%20cx='14.24'%20cy='56.24'%20r='0.76'%20fill='%238059f6'/%3E%3Ccircle%20cx='17.39'%20cy='55.81'%20r='0.65'%20fill='%2357b2f8'/%3E%3Ccircle%20cx='20.84'%20cy='55.66'%20r='0.62'%20fill='%23ba40f9'/%3E%3Ccircle%20cx='24.24'%20cy='55.62'%20r='0.97'%20fill='%23cc42f9'/%3E%3Ccircle%20cx='27.07'%20cy='55.54'%20r='0.93'%20fill='%23fa68b7'/%3E%3Ccircle%20cx='30.45'%20cy='55.75'%20r='0.55'%20fill='%23f248a0'/%3E%3Ccircle%20cx='34.04'%20cy='55.6'%20r='0.65'%20fill='%23b237fd'/%3E%3Ccircle%20cx='36.85'%20cy='55.95'%20r='0.71'%20fill='%23f8454a'/%3E%3Ccircle%20cx='39.75'%20cy='55.84'%20r='0.79'%20fill='%23f59978'/%3E%3Ccircle%20cx='43.32'%20cy='55.64'%20r='0.74'%20fill='%23fc744c'/%3E%3Ccircle%20cx='46.44'%20cy='55.85'%20r='0.85'%20fill='%23f7efe2'/%3E%3Ccircle%20cx='49.66'%20cy='56.05'%20r='0.99'%20fill='%23f8e367'/%3E%3Ccircle%20cx='52.65'%20cy='55.85'%20r='0.76'%20fill='%23f7ede2'/%3E%3Ccircle%20cx='56.36'%20cy='55.89'%20r='0.66'%20fill='%23e3fb57'/%3E%3Ccircle%20cx='58.89'%20cy='55.95'%20r='0.65'%20fill='%23f7f6e2'/%3E%3Ccircle%20cx='62.15'%20cy='56.28'%20r='0.76'%20fill='%23b8f46a'/%3E%3Ccircle%20cx='65.3'%20cy='56.05'%20r='0.98'%20fill='%23f05a46'/%3E%3Ccircle%20cx='68.64'%20cy='55.79'%20r='0.99'%20fill='%23f7f4e2'/%3E%3Ccircle%20cx='71.9'%20cy='56.46'%20r='0.97'%20fill='%2357f6a1'/%3E%3Ccircle%20cx='75.54'%20cy='55.92'%20r='0.8'%20fill='%23e6f7e2'/%3E%3Ccircle%20cx='78.01'%20cy='55.68'%20r='0.56'%20fill='%23e2f7e7'/%3E%3Ccircle%20cx='81.17'%20cy='56.4'%20r='0.64'%20fill='%2377f6e2'/%3E%3Ccircle%20cx='84.75'%20cy='55.81'%20r='0.74'%20fill='%2354acf5'/%3E%3Ccircle%20cx='87.7'%20cy='56.46'%20r='0.92'%20fill='%2351f981'/%3E%3Ccircle%20cx='91.15'%20cy='56.28'%20r='0.82'%20fill='%23499ff2'/%3E%3Ccircle%20cx='94.28'%20cy='55.99'%20r='0.76'%20fill='%2366e4fc'/%3E%3Ccircle%20cx='2.03'%20cy='59.67'%20r='0.92'%20fill='%23fc48e3'/%3E%3Ccircle%20cx='5.04'%20cy='59.44'%20r='0.87'%20fill='%23f54fda'/%3E%3Ccircle%20cx='7.95'%20cy='59.64'%20r='0.75'%20fill='%234c8dfa'/%3E%3Ccircle%20cx='11.62'%20cy='58.88'%20r='0.78'%20fill='%239c46f5'/%3E%3Ccircle%20cx='14.35'%20cy='59.38'%20r='0.67'%20fill='%23d24af9'/%3E%3Ccircle%20cx='17.47'%20cy='58.71'%20r='0.93'%20fill='%237f0aff'/%3E%3Ccircle%20cx='20.62'%20cy='59.15'%20r='0.73'%20fill='%23f35f5d'/%3E%3Ccircle%20cx='24.38'%20cy='58.72'%20r='0.79'%20fill='%23ff0a47'/%3E%3Ccircle%20cx='26.93'%20cy='58.91'%20r='0.67'%20fill='%23f7e3e2'/%3E%3Ccircle%20cx='30.18'%20cy='58.71'%20r='0.76'%20fill='%23fce35c'/%3E%3Ccircle%20cx='33.38'%20cy='58.87'%20r='0.81'%20fill='%23f757e3'/%3E%3Ccircle%20cx='36.81'%20cy='59.12'%20r='0.96'%20fill='%23fb4f4f'/%3E%3Ccircle%20cx='39.65'%20cy='58.71'%20r='0.89'%20fill='%23f7e2e9'/%3E%3Ccircle%20cx='46.16'%20cy='59.54'%20r='0.94'%20fill='%23f7eae2'/%3E%3Ccircle%20cx='49.36'%20cy='59.28'%20r='0.86'%20fill='%23f8fe6f'/%3E%3Ccircle%20cx='52.51'%20cy='58.94'%20r='0.84'%20fill='%2370f35d'/%3E%3Ccircle%20cx='55.91'%20cy='58.73'%20r='0.72'%20fill='%23f69c74'/%3E%3Ccircle%20cx='59.41'%20cy='59.53'%20r='0.58'%20fill='%23fed63e'/%3E%3Ccircle%20cx='62.68'%20cy='59.15'%20r='0.58'%20fill='%236cfd5d'/%3E%3Ccircle%20cx='65.78'%20cy='59.15'%20r='0.91'%20fill='%2360f7a0'/%3E%3Ccircle%20cx='71.95'%20cy='59.36'%20r='0.67'%20fill='%2347f68e'/%3E%3Ccircle%20cx='74.8'%20cy='58.96'%20r='0.73'%20fill='%230aff28'/%3E%3Ccircle%20cx='78.35'%20cy='59.38'%20r='0.95'%20fill='%2359f8b4'/%3E%3Ccircle%20cx='81.85'%20cy='58.81'%20r='0.63'%20fill='%2369a2fd'/%3E%3Ccircle%20cx='84.7'%20cy='58.95'%20r='0.94'%20fill='%2372c3fb'/%3E%3Ccircle%20cx='87.92'%20cy='58.7'%20r='0.64'%20fill='%2365a7f8'/%3E%3Ccircle%20cx='90.86'%20cy='59.21'%20r='0.87'%20fill='%2374a4f7'/%3E%3Ccircle%20cx='94.74'%20cy='59.61'%20r='0.94'%20fill='%23980aff'/%3E%3Ccircle%20cx='1.51'%20cy='62.89'%20r='0.75'%20fill='%23b855fa'/%3E%3Ccircle%20cx='7.87'%20cy='62.85'%20r='0.76'%20fill='%23fe557e'/%3E%3Ccircle%20cx='11.54'%20cy='62.84'%20r='0.63'%20fill='%23a24bf9'/%3E%3Ccircle%20cx='17.12'%20cy='62.82'%20r='0.93'%20fill='%238950f1'/%3E%3Ccircle%20cx='20.88'%20cy='62.15'%20r='0.66'%20fill='%23fb5ad9'/%3E%3Ccircle%20cx='24.12'%20cy='62.58'%20r='0.6'%20fill='%23fc4384'/%3E%3Ccircle%20cx='26.96'%20cy='62.22'%20r='0.68'%20fill='%23f79b6b'/%3E%3Ccircle%20cx='30.82'%20cy='62.38'%20r='0.97'%20fill='%23ba71f4'/%3E%3Ccircle%20cx='33.89'%20cy='62.04'%20r='0.84'%20fill='%23f453d9'/%3E%3Ccircle%20cx='37.1'%20cy='62.5'%20r='0.57'%20fill='%23f88953'/%3E%3Ccircle%20cx='40.2'%20cy='62.63'%20r='0.81'%20fill='%2374f24a'/%3E%3Ccircle%20cx='43.05'%20cy='62.16'%20r='1.0'%20fill='%23e0f259'/%3E%3Ccircle%20cx='46.5'%20cy='62.68'%20r='0.87'%20fill='%23f37598'/%3E%3Ccircle%20cx='50.05'%20cy='62.48'%20r='0.99'%20fill='%23ecfe33'/%3E%3Ccircle%20cx='52.9'%20cy='62.08'%20r='0.81'%20fill='%2334ff0a'/%3E%3Ccircle%20cx='56.01'%20cy='62.56'%20r='0.66'%20fill='%23f9e56a'/%3E%3Ccircle%20cx='59.05'%20cy='62.61'%20r='0.92'%20fill='%239ef54f'/%3E%3Ccircle%20cx='62.9'%20cy='62.24'%20r='0.62'%20fill='%23f5a25d'/%3E%3Ccircle%20cx='65.4'%20cy='62.01'%20r='0.65'%20fill='%23c4f342'/%3E%3Ccircle%20cx='68.61'%20cy='62.29'%20r='0.89'%20fill='%235ffeba'/%3E%3Ccircle%20cx='75.43'%20cy='62.74'%20r='0.59'%20fill='%230aff59'/%3E%3Ccircle%20cx='78.84'%20cy='61.95'%20r='0.93'%20fill='%230affbd'/%3E%3Ccircle%20cx='81.17'%20cy='62.82'%20r='0.98'%20fill='%2356fbd3'/%3E%3Ccircle%20cx='84.52'%20cy='62.13'%20r='0.57'%20fill='%230abcff'/%3E%3Ccircle%20cx='88.29'%20cy='61.91'%20r='0.92'%20fill='%235af7ab'/%3E%3Ccircle%20cx='90.94'%20cy='62.1'%20r='0.61'%20fill='%23e2f7ef'/%3E%3Ccircle%20cx='94.85'%20cy='62.4'%20r='0.57'%20fill='%23a1f876'/%3E%3Ccircle%20cx='1.46'%20cy='65.2'%20r='0.69'%20fill='%233ffde5'/%3E%3Ccircle%20cx='4.97'%20cy='65.81'%20r='0.57'%20fill='%23f474dc'/%3E%3Ccircle%20cx='7.75'%20cy='65.22'%20r='0.87'%20fill='%23e045f6'/%3E%3Ccircle%20cx='11.6'%20cy='65.55'%20r='0.91'%20fill='%238169f8'/%3E%3Ccircle%20cx='14.61'%20cy='65.9'%20r='0.89'%20fill='%23e746f2'/%3E%3Ccircle%20cx='18.06'%20cy='66.04'%20r='0.98'%20fill='%23ad59f6'/%3E%3Ccircle%20cx='21.28'%20cy='65.94'%20r='0.72'%20fill='%23f64483'/%3E%3Ccircle%20cx='24.3'%20cy='65.54'%20r='0.98'%20fill='%23f2619f'/%3E%3Ccircle%20cx='27.21'%20cy='65.89'%20r='0.75'%20fill='%23ff0a41'/%3E%3Ccircle%20cx='30.58'%20cy='65.27'%20r='0.92'%20fill='%23f7e9e2'/%3E%3Ccircle%20cx='33.31'%20cy='65.23'%20r='0.55'%20fill='%23f56df7'/%3E%3Ccircle%20cx='37.07'%20cy='65.59'%20r='0.65'%20fill='%23eef258'/%3E%3Ccircle%20cx='39.67'%20cy='65.46'%20r='0.63'%20fill='%23ff670a'/%3E%3Ccircle%20cx='42.74'%20cy='65.97'%20r='0.81'%20fill='%23f2d961'/%3E%3Ccircle%20cx='49.7'%20cy='65.16'%20r='0.7'%20fill='%23fba75e'/%3E%3Ccircle%20cx='52.91'%20cy='65.31'%20r='0.69'%20fill='%23d4f942'/%3E%3Ccircle%20cx='55.98'%20cy='65.87'%20r='0.99'%20fill='%23aefe5a'/%3E%3Ccircle%20cx='59.0'%20cy='65.6'%20r='0.61'%20fill='%23f6c157'/%3E%3Ccircle%20cx='62.24'%20cy='65.68'%20r='0.66'%20fill='%2352e1f4'/%3E%3Ccircle%20cx='65.59'%20cy='65.65'%20r='0.66'%20fill='%23f7e6e2'/%3E%3Ccircle%20cx='68.92'%20cy='65.52'%20r='0.6'%20fill='%2359f354'/%3E%3Ccircle%20cx='71.78'%20cy='65.58'%20r='0.6'%20fill='%230ad2ff'/%3E%3Ccircle%20cx='75.17'%20cy='65.75'%20r='0.75'%20fill='%234bf883'/%3E%3Ccircle%20cx='78.23'%20cy='65.2'%20r='0.8'%20fill='%234ed4fe'/%3E%3Ccircle%20cx='81.28'%20cy='66.03'%20r='0.67'%20fill='%234557fe'/%3E%3Ccircle%20cx='84.77'%20cy='65.12'%20r='0.6'%20fill='%236cd1f5'/%3E%3Ccircle%20cx='88.35'%20cy='65.64'%20r='0.84'%20fill='%23e2e8f7'/%3E%3Ccircle%20cx='91.52'%20cy='65.45'%20r='0.73'%20fill='%2341f1df'/%3E%3Ccircle%20cx='94.56'%20cy='65.99'%20r='0.93'%20fill='%23729df4'/%3E%3Ccircle%20cx='1.24'%20cy='69.25'%20r='0.77'%20fill='%23a154f3'/%3E%3Ccircle%20cx='8.24'%20cy='68.76'%20r='0.93'%20fill='%23db5bfb'/%3E%3Ccircle%20cx='11.61'%20cy='69.08'%20r='0.96'%20fill='%23fe8156'/%3E%3Ccircle%20cx='14.12'%20cy='68.48'%20r='0.84'%20fill='%23e9e2f7'/%3E%3Ccircle%20cx='17.75'%20cy='68.8'%20r='0.57'%20fill='%23a96ef4'/%3E%3Ccircle%20cx='20.56'%20cy='69.02'%20r='0.81'%20fill='%23fd4fa0'/%3E%3Ccircle%20cx='23.73'%20cy='68.46'%20r='0.89'%20fill='%23f77f4c'/%3E%3Ccircle%20cx='27.62'%20cy='68.9'%20r='0.8'%20fill='%23f7e4e2'/%3E%3Ccircle%20cx='30.63'%20cy='68.41'%20r='0.85'%20fill='%23f3687b'/%3E%3Ccircle%20cx='34.05'%20cy='69.13'%20r='0.71'%20fill='%23f7e5e2'/%3E%3Ccircle%20cx='36.9'%20cy='69.27'%20r='0.62'%20fill='%23f3de58'/%3E%3Ccircle%20cx='39.73'%20cy='69.3'%20r='0.75'%20fill='%23f5d83e'/%3E%3Ccircle%20cx='43.57'%20cy='68.92'%20r='0.78'%20fill='%23f76a85'/%3E%3Ccircle%20cx='46.23'%20cy='68.97'%20r='0.97'%20fill='%23fe696a'/%3E%3Ccircle%20cx='49.65'%20cy='69.03'%20r='0.55'%20fill='%23e2f7e3'/%3E%3Ccircle%20cx='52.89'%20cy='68.38'%20r='0.74'%20fill='%23ffc40a'/%3E%3Ccircle%20cx='56.18'%20cy='69.2'%20r='0.75'%20fill='%2349c4fd'/%3E%3Ccircle%20cx='59.17'%20cy='68.34'%20r='0.69'%20fill='%23f1f7e2'/%3E%3Ccircle%20cx='62.67'%20cy='68.96'%20r='0.68'%20fill='%23a8f65b'/%3E%3Ccircle%20cx='65.84'%20cy='68.47'%20r='0.65'%20fill='%238ff96a'/%3E%3Ccircle%20cx='68.36'%20cy='69.23'%20r='0.8'%20fill='%2343e4fa'/%3E%3Ccircle%20cx='71.6'%20cy='68.64'%20r='0.95'%20fill='%2360e0fa'/%3E%3Ccircle%20cx='75.21'%20cy='68.54'%20r='0.81'%20fill='%230a7cff'/%3E%3Ccircle%20cx='78.78'%20cy='68.78'%20r='0.78'%20fill='%2348ff0a'/%3E%3Ccircle%20cx='81.22'%20cy='68.46'%20r='0.77'%20fill='%2341aef8'/%3E%3Ccircle%20cx='88.27'%20cy='68.61'%20r='0.95'%20fill='%2335fdcf'/%3E%3Ccircle%20cx='91.03'%20cy='69.12'%20r='0.66'%20fill='%235c6ff3'/%3E%3Ccircle%20cx='94.84'%20cy='68.58'%20r='0.56'%20fill='%23567afe'/%3E%3Ccircle%20cx='2.03'%20cy='72.42'%20r='0.79'%20fill='%236b47fe'/%3E%3Ccircle%20cx='4.33'%20cy='72.38'%20r='0.9'%20fill='%23fa5ed7'/%3E%3Ccircle%20cx='8.22'%20cy='71.79'%20r='0.81'%20fill='%23f95c7d'/%3E%3Ccircle%20cx='11.66'%20cy='72.4'%20r='0.68'%20fill='%23f1544a'/%3E%3Ccircle%20cx='17.72'%20cy='72.31'%20r='0.9'%20fill='%23f25fd0'/%3E%3Ccircle%20cx='21.05'%20cy='72.26'%20r='0.99'%20fill='%23fd66d9'/%3E%3Ccircle%20cx='26.98'%20cy='71.98'%20r='0.6'%20fill='%23f76789'/%3E%3Ccircle%20cx='30.43'%20cy='72.25'%20r='0.75'%20fill='%23cdf56b'/%3E%3Ccircle%20cx='33.82'%20cy='71.81'%20r='0.74'%20fill='%23fb5171'/%3E%3Ccircle%20cx='36.46'%20cy='72.15'%20r='0.61'%20fill='%23f5e446'/%3E%3Ccircle%20cx='39.56'%20cy='72.39'%20r='0.71'%20fill='%23edf76e'/%3E%3Ccircle%20cx='43.05'%20cy='72.27'%20r='0.98'%20fill='%23fed855'/%3E%3Ccircle%20cx='46.59'%20cy='72.19'%20r='0.88'%20fill='%233afd5e'/%3E%3Ccircle%20cx='50.01'%20cy='71.58'%20r='0.65'%20fill='%23e2f7f4'/%3E%3Ccircle%20cx='52.69'%20cy='72.21'%20r='0.56'%20fill='%23f6f7e2'/%3E%3Ccircle%20cx='56.13'%20cy='72.24'%20r='0.83'%20fill='%2368f743'/%3E%3Ccircle%20cx='61.96'%20cy='71.84'%20r='0.67'%20fill='%230affa7'/%3E%3Ccircle%20cx='65.26'%20cy='71.61'%20r='0.99'%20fill='%23e2f7f2'/%3E%3Ccircle%20cx='68.77'%20cy='71.86'%20r='0.95'%20fill='%2374f8ab'/%3E%3Ccircle%20cx='75.64'%20cy='72.03'%20r='0.66'%20fill='%234a6af3'/%3E%3Ccircle%20cx='78.41'%20cy='72.33'%20r='0.81'%20fill='%23475cf3'/%3E%3Ccircle%20cx='81.68'%20cy='71.64'%20r='0.94'%20fill='%23e2f7f4'/%3E%3Ccircle%20cx='84.66'%20cy='72.45'%20r='0.57'%20fill='%236c77fa'/%3E%3Ccircle%20cx='88.13'%20cy='72.01'%20r='0.64'%20fill='%23b148f6'/%3E%3Ccircle%20cx='91.08'%20cy='72.33'%20r='0.87'%20fill='%23bd49f6'/%3E%3Ccircle%20cx='94.19'%20cy='72.32'%20r='0.91'%20fill='%23e7e2f7'/%3E%3Ccircle%20cx='1.22'%20cy='75.54'%20r='0.72'%20fill='%23b65ef5'/%3E%3Ccircle%20cx='4.99'%20cy='75.56'%20r='0.9'%20fill='%23f65988'/%3E%3Ccircle%20cx='7.69'%20cy='75.57'%20r='0.73'%20fill='%23fa596f'/%3E%3Ccircle%20cx='14.34'%20cy='75.23'%20r='0.75'%20fill='%23f97196'/%3E%3Ccircle%20cx='17.83'%20cy='74.8'%20r='0.97'%20fill='%23f7e2e3'/%3E%3Ccircle%20cx='20.37'%20cy='75.46'%20r='0.91'%20fill='%23f4e172'/%3E%3Ccircle%20cx='29.94'%20cy='75.62'%20r='0.69'%20fill='%23f34165'/%3E%3Ccircle%20cx='33.12'%20cy='75.22'%20r='0.96'%20fill='%23fab33b'/%3E%3Ccircle%20cx='37.16'%20cy='75.41'%20r='0.97'%20fill='%236cf5a1'/%3E%3Ccircle%20cx='39.77'%20cy='74.85'%20r='1.0'%20fill='%239efb6b'/%3E%3Ccircle%20cx='42.71'%20cy='75.04'%20r='0.68'%20fill='%239cf563'/%3E%3Ccircle%20cx='46.51'%20cy='74.99'%20r='0.84'%20fill='%23aef84d'/%3E%3Ccircle%20cx='49.42'%20cy='74.92'%20r='0.91'%20fill='%23d3f645'/%3E%3Ccircle%20cx='53.14'%20cy='75.62'%20r='0.87'%20fill='%2387fb65'/%3E%3Ccircle%20cx='56.05'%20cy='75.07'%20r='0.69'%20fill='%2376f369'/%3E%3Ccircle%20cx='59.58'%20cy='75.37'%20r='0.94'%20fill='%233cdffd'/%3E%3Ccircle%20cx='62.76'%20cy='75.0'%20r='0.66'%20fill='%23caf875'/%3E%3Ccircle%20cx='65.68'%20cy='75.48'%20r='0.61'%20fill='%2344d1f2'/%3E%3Ccircle%20cx='69.09'%20cy='74.89'%20r='0.92'%20fill='%236ffbef'/%3E%3Ccircle%20cx='71.86'%20cy='75.03'%20r='0.59'%20fill='%233fe8f4'/%3E%3Ccircle%20cx='74.88'%20cy='75.22'%20r='0.69'%20fill='%236de1f9'/%3E%3Ccircle%20cx='78.36'%20cy='75.67'%20r='0.62'%20fill='%23260aff'/%3E%3Ccircle%20cx='81.24'%20cy='75.62'%20r='0.96'%20fill='%23e2e7f7'/%3E%3Ccircle%20cx='84.39'%20cy='75.49'%20r='0.66'%20fill='%2334aafe'/%3E%3Ccircle%20cx='87.85'%20cy='75.2'%20r='0.65'%20fill='%23546ef4'/%3E%3Ccircle%20cx='91.17'%20cy='75.34'%20r='0.93'%20fill='%23fe36ab'/%3E%3Ccircle%20cx='93.91'%20cy='75.16'%20r='0.75'%20fill='%23e5e2f7'/%3E%3Ccircle%20cx='1.43'%20cy='78.44'%20r='0.65'%20fill='%23fd675c'/%3E%3Ccircle%20cx='4.49'%20cy='78.0'%20r='0.64'%20fill='%23f661ce'/%3E%3Ccircle%20cx='7.65'%20cy='78.26'%20r='0.94'%20fill='%23f672f8'/%3E%3Ccircle%20cx='10.85'%20cy='78.07'%20r='0.85'%20fill='%23bd0aff'/%3E%3Ccircle%20cx='14.15'%20cy='78.48'%20r='0.89'%20fill='%23f86475'/%3E%3Ccircle%20cx='17.37'%20cy='78.29'%20r='0.74'%20fill='%23463cfe'/%3E%3Ccircle%20cx='20.56'%20cy='77.94'%20r='0.78'%20fill='%23f25d51'/%3E%3Ccircle%20cx='24.07'%20cy='78.0'%20r='0.86'%20fill='%23f7f2e2'/%3E%3Ccircle%20cx='26.73'%20cy='78.14'%20r='0.93'%20fill='%23f153a4'/%3E%3Ccircle%20cx='30.16'%20cy='78.17'%20r='0.8'%20fill='%23f7f0e2'/%3E%3Ccircle%20cx='33.38'%20cy='78.43'%20r='0.77'%20fill='%235efe66'/%3E%3Ccircle%20cx='36.57'%20cy='77.96'%20r='0.65'%20fill='%2388fe6f'/%3E%3Ccircle%20cx='39.62'%20cy='78.85'%20r='0.86'%20fill='%2374f972'/%3E%3Ccircle%20cx='42.71'%20cy='78.74'%20r='0.84'%20fill='%234cf86a'/%3E%3Ccircle%20cx='46.84'%20cy='78.29'%20r='0.68'%20fill='%23fcfa3e'/%3E%3Ccircle%20cx='49.89'%20cy='78.25'%20r='0.72'%20fill='%236afe50'/%3E%3Ccircle%20cx='52.75'%20cy='78.62'%20r='0.76'%20fill='%2350fd50'/%3E%3Ccircle%20cx='56.09'%20cy='78.51'%20r='0.67'%20fill='%2355fcad'/%3E%3Ccircle%20cx='59.19'%20cy='78.85'%20r='0.74'%20fill='%2358faa9'/%3E%3Ccircle%20cx='62.14'%20cy='78.82'%20r='0.9'%20fill='%237136fd'/%3E%3Ccircle%20cx='65.39'%20cy='78.05'%20r='0.96'%20fill='%23e2e8f7'/%3E%3Ccircle%20cx='72.35'%20cy='78.01'%20r='0.67'%20fill='%23e2e7f7'/%3E%3Ccircle%20cx='75.47'%20cy='77.99'%20r='0.72'%20fill='%236c4cf6'/%3E%3Ccircle%20cx='78.83'%20cy='78.46'%20r='0.69'%20fill='%237086fe'/%3E%3Ccircle%20cx='81.87'%20cy='78.18'%20r='0.65'%20fill='%2342fb99'/%3E%3Ccircle%20cx='84.71'%20cy='78.0'%20r='0.9'%20fill='%2353f3c7'/%3E%3Ccircle%20cx='88.29'%20cy='78.84'%20r='0.6'%20fill='%237672f5'/%3E%3Ccircle%20cx='91.29'%20cy='78.83'%20r='0.96'%20fill='%23ece2f7'/%3E%3Ccircle%20cx='94.1'%20cy='78.85'%20r='0.95'%20fill='%23e2eaf7'/%3E%3Ccircle%20cx='1.58'%20cy='81.52'%20r='0.66'%20fill='%239d48f6'/%3E%3Ccircle%20cx='4.86'%20cy='82.03'%20r='0.87'%20fill='%23f7e2f5'/%3E%3Ccircle%20cx='7.89'%20cy='82.09'%20r='0.63'%20fill='%23fa647c'/%3E%3Ccircle%20cx='11.34'%20cy='81.7'%20r='0.75'%20fill='%23fa5b75'/%3E%3Ccircle%20cx='13.94'%20cy='81.22'%20r='0.72'%20fill='%23fb3cd7'/%3E%3Ccircle%20cx='18.08'%20cy='81.32'%20r='0.63'%20fill='%23f5ac61'/%3E%3Ccircle%20cx='20.93'%20cy='82.01'%20r='0.69'%20fill='%23f5f7e2'/%3E%3Ccircle%20cx='24.14'%20cy='81.69'%20r='0.86'%20fill='%23fd9267'/%3E%3Ccircle%20cx='27.64'%20cy='81.73'%20r='0.58'%20fill='%23faf373'/%3E%3Ccircle%20cx='30.79'%20cy='81.85'%20r='0.76'%20fill='%23b1f368'/%3E%3Ccircle%20cx='33.22'%20cy='81.11'%20r='0.98'%20fill='%23b0ff0a'/%3E%3Ccircle%20cx='40.23'%20cy='81.61'%20r='0.95'%20fill='%23aff04c'/%3E%3Ccircle%20cx='43.62'%20cy='82.07'%20r='0.67'%20fill='%23fed333'/%3E%3Ccircle%20cx='46.15'%20cy='81.72'%20r='0.76'%20fill='%234df6c2'/%3E%3Ccircle%20cx='50.08'%20cy='81.78'%20r='0.96'%20fill='%2378fe51'/%3E%3Ccircle%20cx='52.66'%20cy='81.84'%20r='0.58'%20fill='%2366fdcb'/%3E%3Ccircle%20cx='55.77'%20cy='82.06'%20r='0.97'%20fill='%2360c5fa'/%3E%3Ccircle%20cx='59.1'%20cy='81.27'%20r='0.66'%20fill='%2375ff0a'/%3E%3Ccircle%20cx='62.4'%20cy='81.44'%20r='0.67'%20fill='%2358fa71'/%3E%3Ccircle%20cx='65.54'%20cy='81.39'%20r='0.7'%20fill='%235bfad0'/%3E%3Ccircle%20cx='69.14'%20cy='81.51'%20r='0.6'%20fill='%2370f1fe'/%3E%3Ccircle%20cx='71.52'%20cy='81.14'%20r='0.84'%20fill='%2370ccf8'/%3E%3Ccircle%20cx='74.74'%20cy='81.35'%20r='0.94'%20fill='%235f82f3'/%3E%3Ccircle%20cx='78.1'%20cy='81.15'%20r='0.84'%20fill='%23eae2f7'/%3E%3Ccircle%20cx='82.05'%20cy='82.09'%20r='0.73'%20fill='%23716cfc'/%3E%3Ccircle%20cx='84.33'%20cy='81.33'%20r='0.63'%20fill='%23fe3c86'/%3E%3Ccircle%20cx='88.06'%20cy='81.71'%20r='0.73'%20fill='%23f670cd'/%3E%3Ccircle%20cx='91.54'%20cy='81.72'%20r='0.87'%20fill='%23f7e2f4'/%3E%3Ccircle%20cx='94.36'%20cy='81.77'%20r='0.88'%20fill='%23f150e6'/%3E%3Ccircle%20cx='1.74'%20cy='84.34'%20r='0.84'%20fill='%23f7e2ea'/%3E%3Ccircle%20cx='4.83'%20cy='84.81'%20r='0.98'%20fill='%23f14bc9'/%3E%3Ccircle%20cx='8.45'%20cy='84.41'%20r='0.72'%20fill='%23f84cd1'/%3E%3Ccircle%20cx='11.25'%20cy='85.08'%20r='0.93'%20fill='%23f7eee2'/%3E%3Ccircle%20cx='13.93'%20cy='85.2'%20r='0.88'%20fill='%23f7f2e2'/%3E%3Ccircle%20cx='17.21'%20cy='84.78'%20r='0.74'%20fill='%23fd4cab'/%3E%3Ccircle%20cx='21.03'%20cy='84.39'%20r='0.66'%20fill='%23f7ce71'/%3E%3Ccircle%20cx='24.03'%20cy='84.64'%20r='0.76'%20fill='%23f1b857'/%3E%3Ccircle%20cx='27.66'%20cy='84.44'%20r='0.9'%20fill='%23fceb50'/%3E%3Ccircle%20cx='30.83'%20cy='84.64'%20r='0.92'%20fill='%23f7d45b'/%3E%3Ccircle%20cx='33.97'%20cy='84.64'%20r='0.96'%20fill='%2357f3fe'/%3E%3Ccircle%20cx='36.37'%20cy='84.99'%20r='0.73'%20fill='%239dfd4d'/%3E%3Ccircle%20cx='39.84'%20cy='85.21'%20r='0.76'%20fill='%2351fda5'/%3E%3Ccircle%20cx='43.41'%20cy='85.25'%20r='0.98'%20fill='%2361f390'/%3E%3Ccircle%20cx='46.54'%20cy='84.89'%20r='0.77'%20fill='%234cf74b'/%3E%3Ccircle%20cx='49.54'%20cy='85.07'%20r='0.76'%20fill='%235ff9a2'/%3E%3Ccircle%20cx='52.54'%20cy='84.77'%20r='0.99'%20fill='%23e2f7e9'/%3E%3Ccircle%20cx='55.56'%20cy='84.9'%20r='0.67'%20fill='%2342f2a3'/%3E%3Ccircle%20cx='59.39'%20cy='85.06'%20r='0.71'%20fill='%2353e1fc'/%3E%3Ccircle%20cx='62.74'%20cy='84.99'%20r='0.97'%20fill='%2370a1f9'/%3E%3Ccircle%20cx='65.37'%20cy='84.62'%20r='0.7'%20fill='%235754f4'/%3E%3Ccircle%20cx='68.53'%20cy='85.15'%20r='0.61'%20fill='%234590f8'/%3E%3Ccircle%20cx='72.22'%20cy='85.24'%20r='0.84'%20fill='%235396f5'/%3E%3Ccircle%20cx='75.55'%20cy='84.37'%20r='0.84'%20fill='%230aa4ff'/%3E%3Ccircle%20cx='78.3'%20cy='85.18'%20r='0.61'%20fill='%23e6e2f7'/%3E%3Ccircle%20cx='81.2'%20cy='85.0'%20r='0.91'%20fill='%23ae56f5'/%3E%3Ccircle%20cx='85.13'%20cy='85.24'%20r='0.59'%20fill='%23eee2f7'/%3E%3Ccircle%20cx='87.52'%20cy='85.22'%20r='0.6'%20fill='%23f95eab'/%3E%3Ccircle%20cx='91.61'%20cy='84.73'%20r='0.62'%20fill='%23f7e2f7'/%3E%3Ccircle%20cx='94.69'%20cy='85.2'%20r='0.86'%20fill='%23f7e2ed'/%3E%3Ccircle%20cx='1.53'%20cy='87.69'%20r='0.57'%20fill='%23fc488a'/%3E%3Ccircle%20cx='4.49'%20cy='87.97'%20r='0.85'%20fill='%23f7eae2'/%3E%3Ccircle%20cx='8.37'%20cy='88.1'%20r='0.87'%20fill='%23f7e6e2'/%3E%3Ccircle%20cx='11.7'%20cy='87.71'%20r='0.88'%20fill='%23e669fb'/%3E%3Ccircle%20cx='14.32'%20cy='88.41'%20r='0.76'%20fill='%23fe8d5e'/%3E%3Ccircle%20cx='18.04'%20cy='87.82'%20r='0.63'%20fill='%23cfff0a'/%3E%3Ccircle%20cx='20.39'%20cy='88.34'%20r='0.69'%20fill='%23f8ce40'/%3E%3Ccircle%20cx='24.24'%20cy='88.32'%20r='0.69'%20fill='%23d2fb58'/%3E%3Ccircle%20cx='30.3'%20cy='87.54'%20r='0.96'%20fill='%23f0bc42'/%3E%3Ccircle%20cx='33.71'%20cy='87.55'%20r='0.93'%20fill='%23cef747'/%3E%3Ccircle%20cx='36.55'%20cy='87.99'%20r='0.58'%20fill='%2361f57f'/%3E%3Ccircle%20cx='40.03'%20cy='88.34'%20r='0.72'%20fill='%2374f887'/%3E%3Ccircle%20cx='43.19'%20cy='88.25'%20r='0.68'%20fill='%234cc1f3'/%3E%3Ccircle%20cx='46.74'%20cy='88.22'%20r='0.97'%20fill='%230aff91'/%3E%3Ccircle%20cx='49.83'%20cy='88.19'%20r='0.84'%20fill='%234df27e'/%3E%3Ccircle%20cx='52.78'%20cy='88.5'%20r='0.61'%20fill='%236db0f6'/%3E%3Ccircle%20cx='55.66'%20cy='87.99'%20r='0.83'%20fill='%233ceefd'/%3E%3Ccircle%20cx='58.97'%20cy='87.98'%20r='0.87'%20fill='%235b4bf5'/%3E%3Ccircle%20cx='62.26'%20cy='87.92'%20r='0.89'%20fill='%236d7ef5'/%3E%3Ccircle%20cx='68.76'%20cy='87.93'%20r='1.0'%20fill='%23e5e2f7'/%3E%3Ccircle%20cx='72.38'%20cy='87.87'%20r='0.71'%20fill='%236c75fc'/%3E%3Ccircle%20cx='75.49'%20cy='87.97'%20r='0.62'%20fill='%23640aff'/%3E%3Ccircle%20cx='78.72'%20cy='88.34'%20r='0.7'%20fill='%23b46cf4'/%3E%3Ccircle%20cx='81.55'%20cy='88.05'%20r='0.76'%20fill='%237570f5'/%3E%3Ccircle%20cx='85.16'%20cy='87.56'%20r='0.57'%20fill='%23f23df8'/%3E%3Ccircle%20cx='87.78'%20cy='87.9'%20r='0.67'%20fill='%23fa5ce8'/%3E%3Ccircle%20cx='90.84'%20cy='87.97'%20r='0.96'%20fill='%23f254ab'/%3E%3Ccircle%20cx='94.61'%20cy='88.49'%20r='0.95'%20fill='%23f674e7'/%3E%3Ccircle%20cx='1.64'%20cy='91.58'%20r='0.62'%20fill='%23fd507f'/%3E%3Ccircle%20cx='11.5'%20cy='91.44'%20r='0.69'%20fill='%23c2f473'/%3E%3Ccircle%20cx='14.21'%20cy='91.39'%20r='0.64'%20fill='%23f2ad55'/%3E%3Ccircle%20cx='17.15'%20cy='91.4'%20r='0.96'%20fill='%230aff1f'/%3E%3Ccircle%20cx='20.68'%20cy='91.26'%20r='0.89'%20fill='%23f86b4c'/%3E%3Ccircle%20cx='23.94'%20cy='90.8'%20r='0.86'%20fill='%23f0f04c'/%3E%3Ccircle%20cx='26.93'%20cy='91.45'%20r='0.8'%20fill='%234afc5d'/%3E%3Ccircle%20cx='33.82'%20cy='91.3'%20r='0.97'%20fill='%23d1f473'/%3E%3Ccircle%20cx='36.51'%20cy='90.98'%20r='0.96'%20fill='%2356f94b'/%3E%3Ccircle%20cx='39.7'%20cy='91.48'%20r='0.9'%20fill='%23e2f7eb'/%3E%3Ccircle%20cx='43.35'%20cy='90.97'%20r='0.74'%20fill='%2365f453'/%3E%3Ccircle%20cx='46.57'%20cy='91.69'%20r='0.6'%20fill='%2380f875'/%3E%3Ccircle%20cx='50.06'%20cy='90.99'%20r='0.6'%20fill='%236dfcdd'/%3E%3Ccircle%20cx='52.4'%20cy='91.46'%20r='0.76'%20fill='%233afd3b'/%3E%3Ccircle%20cx='56.24'%20cy='91.2'%20r='0.75'%20fill='%23565afc'/%3E%3Ccircle%20cx='59.14'%20cy='90.98'%20r='0.86'%20fill='%230aff11'/%3E%3Ccircle%20cx='62.79'%20cy='91.38'%20r='0.57'%20fill='%2361f9d5'/%3E%3Ccircle%20cx='65.28'%20cy='90.92'%20r='0.94'%20fill='%2350c7f6'/%3E%3Ccircle%20cx='72.28'%20cy='91.57'%20r='0.96'%20fill='%23b84af9'/%3E%3Ccircle%20cx='75.24'%20cy='90.9'%20r='0.89'%20fill='%23f83ba8'/%3E%3Ccircle%20cx='77.97'%20cy='91.67'%20r='0.76'%20fill='%23df3ff7'/%3E%3Ccircle%20cx='81.14'%20cy='91.39'%20r='0.9'%20fill='%23fb6491'/%3E%3Ccircle%20cx='84.9'%20cy='90.86'%20r='0.68'%20fill='%23f7e2ea'/%3E%3Ccircle%20cx='88.03'%20cy='91.52'%20r='0.88'%20fill='%23fd6be6'/%3E%3Ccircle%20cx='90.87'%20cy='91.29'%20r='0.62'%20fill='%23f6405e'/%3E%3Ccircle%20cx='94.31'%20cy='91.65'%20r='0.79'%20fill='%23f46eac'/%3E%3Ccircle%20cx='1.63'%20cy='94.08'%20r='0.74'%20fill='%23f7e8e2'/%3E%3Ccircle%20cx='5.01'%20cy='94.9'%20r='0.57'%20fill='%23f7ed56'/%3E%3Ccircle%20cx='11.5'%20cy='94.06'%20r='0.99'%20fill='%23f9dc75'/%3E%3Ccircle%20cx='14.24'%20cy='94.15'%20r='0.99'%20fill='%23f0f7e2'/%3E%3Ccircle%20cx='18.03'%20cy='94.1'%20r='0.62'%20fill='%23fd8c4a'/%3E%3Ccircle%20cx='23.94'%20cy='94.62'%20r='0.62'%20fill='%23d1fb56'/%3E%3Ccircle%20cx='27.12'%20cy='93.94'%20r='0.85'%20fill='%23fdf750'/%3E%3Ccircle%20cx='29.96'%20cy='94.56'%20r='0.7'%20fill='%2360f651'/%3E%3Ccircle%20cx='33.64'%20cy='93.91'%20r='0.7'%20fill='%23a4f86c'/%3E%3Ccircle%20cx='36.31'%20cy='94.45'%20r='0.7'%20fill='%2377f362'/%3E%3Ccircle%20cx='39.75'%20cy='94.2'%20r='0.96'%20fill='%233de2fb'/%3E%3Ccircle%20cx='43.38'%20cy='94.55'%20r='0.84'%20fill='%2365f6ca'/%3E%3Ccircle%20cx='46.42'%20cy='94.39'%20r='0.96'%20fill='%2361f794'/%3E%3Ccircle%20cx='49.29'%20cy='93.96'%20r='0.74'%20fill='%2373f8db'/%3E%3Ccircle%20cx='53.15'%20cy='94.51'%20r='0.86'%20fill='%2366dbfa'/%3E%3Ccircle%20cx='55.5'%20cy='94.53'%20r='0.92'%20fill='%237846f1'/%3E%3Ccircle%20cx='59.29'%20cy='94.29'%20r='0.7'%20fill='%23e2eff7'/%3E%3Ccircle%20cx='62.32'%20cy='94.43'%20r='0.98'%20fill='%230a4cff'/%3E%3Ccircle%20cx='65.51'%20cy='94.0'%20r='0.57'%20fill='%236bedfd'/%3E%3Ccircle%20cx='68.94'%20cy='94.08'%20r='0.66'%20fill='%2364e8f4'/%3E%3Ccircle%20cx='71.67'%20cy='94.31'%20r='0.78'%20fill='%23e3e2f7'/%3E%3Ccircle%20cx='75.1'%20cy='94.76'%20r='0.96'%20fill='%23fe6ad8'/%3E%3Ccircle%20cx='78.5'%20cy='94.66'%20r='0.75'%20fill='%23f365ba'/%3E%3Ccircle%20cx='81.11'%20cy='94.46'%20r='0.86'%20fill='%23f577be'/%3E%3Ccircle%20cx='84.57'%20cy='94.43'%20r='0.63'%20fill='%23f952b4'/%3E%3Ccircle%20cx='87.73'%20cy='93.91'%20r='0.74'%20fill='%23f7e2f1'/%3E%3Ccircle%20cx='94.84'%20cy='94.35'%20r='0.6'%20fill='%23ff5b0a'/%3E%3C/svg%3E");
  background-repeat: repeat;
  background-size: 96px 96px;
}
.sticky-annotation__glitter {
  opacity: 0.06;
}
.sticky-annotation__glint {
  -webkit-mask-image: linear-gradient(115deg, rgba(0, 0, 0, 0) 22%, #000 50%, rgba(0, 0, 0, 0) 78%);
  mask-image: linear-gradient(115deg, rgba(0, 0, 0, 0) 22%, #000 50%, rgba(0, 0, 0, 0) 78%);
  -webkit-mask-repeat: repeat;
  mask-repeat: repeat;
  -webkit-mask-size: 520px 100%;
  mask-size: 520px 100%;
  opacity: 1;
}

.sticky-annotation__text {
  flex: 1;
  margin: 0;
  padding: 14px 14px 16px;
  background: transparent;
  border: none;
  outline: none;
  resize: none;
  /* Match the rest of the UI — system font, slightly heavier weight than
     body text so the note reads as a deliberate label, not a paragraph. */
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
    'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.4;
  letter-spacing: -0.005em;
  color: rgba(20, 20, 20, 0.92);
  cursor: text;
}
.sticky-annotation__text[readonly] {
  cursor: grab;
}
.sticky-annotation__text::placeholder {
  color: rgba(20, 20, 20, 0.42);
  font-weight: 400;
  font-style: italic;
}

.sticky-annotation__toolbar {
  position: absolute;
  top: 4px;
  right: 4px;
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 120ms;
}
.sticky-annotation:hover .sticky-annotation__toolbar {
  opacity: 1;
}

.sticky-annotation__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.1);
  color: rgba(20, 20, 20, 0.7);
  cursor: pointer;
  transition: background 100ms;
}
.sticky-annotation__btn:hover {
  background: rgba(0, 0, 0, 0.18);
  color: rgba(20, 20, 20, 0.95);
}
.sticky-annotation__btn--danger:hover {
  background: rgba(220, 38, 38, 0.22);
  color: rgb(127, 29, 29);
}

.sticky-annotation__colors {
  position: absolute;
  top: 30px;
  right: 4px;
  display: flex;
  gap: 3px;
  padding: 4px;
  background: rgba(255, 255, 255, 0.95);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}
.sticky-annotation__swatch {
  width: 18px;
  height: 18px;
  border-radius: 3px;
  border: 1px solid rgba(0, 0, 0, 0.1);
  cursor: pointer;
  transition: transform 80ms;
}
.sticky-annotation__swatch:hover {
  transform: scale(1.15);
}

.sticky-annotation__resize {
  position: absolute;
  bottom: 0;
  right: 0;
  width: 14px;
  height: 14px;
  cursor: nwse-resize;
  background: linear-gradient(135deg, transparent 50%, rgba(0, 0, 0, 0.25) 50%);
  border-bottom-right-radius: 2px;
}
</style>
