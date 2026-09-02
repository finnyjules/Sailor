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
  background-image: url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='96'%20height='96'%3E%3Ccircle%20cx='4.98'%20cy='1.24'%20r='0.73'%20fill='%23f3e2b3'/%3E%3Ccircle%20cx='8.04'%20cy='1.55'%20r='0.61'%20fill='%23fbef83'/%3E%3Ccircle%20cx='14.1'%20cy='1.43'%20r='0.73'%20fill='%23f3aaaf'/%3E%3Ccircle%20cx='17.94'%20cy='1.46'%20r='0.98'%20fill='%23bafbd4'/%3E%3Ccircle%20cx='24.15'%20cy='1.32'%20r='0.94'%20fill='%23e9f7e8'/%3E%3Ccircle%20cx='26.74'%20cy='1.44'%20r='0.65'%20fill='%23f5e5ab'/%3E%3Ccircle%20cx='30.88'%20cy='2.09'%20r='0.98'%20fill='%23e8f7eb'/%3E%3Ccircle%20cx='33.77'%20cy='1.19'%20r='0.8'%20fill='%23edf7e8'/%3E%3Ccircle%20cx='37.0'%20cy='1.2'%20r='0.82'%20fill='%23ddfb89'/%3E%3Ccircle%20cx='39.94'%20cy='1.89'%20r='0.91'%20fill='%2391c5ed'/%3E%3Ccircle%20cx='42.89'%20cy='1.44'%20r='0.6'%20fill='%23b2f7d3'/%3E%3Ccircle%20cx='46.51'%20cy='1.74'%20r='0.72'%20fill='%23ebf7e8'/%3E%3Ccircle%20cx='49.83'%20cy='1.79'%20r='0.61'%20fill='%23cdbafb'/%3E%3Ccircle%20cx='52.68'%20cy='1.38'%20r='0.56'%20fill='%23e8f4f7'/%3E%3Ccircle%20cx='58.75'%20cy='1.71'%20r='0.94'%20fill='%23939df1'/%3E%3Ccircle%20cx='62.42'%20cy='1.96'%20r='0.86'%20fill='%23cdadf7'/%3E%3Ccircle%20cx='65.57'%20cy='1.23'%20r='0.87'%20fill='%23f9a7fc'/%3E%3Ccircle%20cx='69.15'%20cy='1.22'%20r='0.62'%20fill='%23f0a0e2'/%3E%3Ccircle%20cx='72.21'%20cy='1.64'%20r='0.74'%20fill='%23d182f8'/%3E%3Ccircle%20cx='74.96'%20cy='1.3'%20r='0.95'%20fill='%23f39ea9'/%3E%3Ccircle%20cx='78.1'%20cy='1.31'%20r='0.72'%20fill='%23b485f8'/%3E%3Ccircle%20cx='81.58'%20cy='1.6'%20r='0.83'%20fill='%23f09493'/%3E%3Ccircle%20cx='87.97'%20cy='1.11'%20r='0.68'%20fill='%23f6c5ba'/%3E%3Ccircle%20cx='91.48'%20cy='1.33'%20r='0.73'%20fill='%23fa9fb1'/%3E%3Ccircle%20cx='94.47'%20cy='1.29'%20r='0.59'%20fill='%23f8a0d2'/%3E%3Ccircle%20cx='1.49'%20cy='4.98'%20r='0.69'%20fill='%23f1efa0'/%3E%3Ccircle%20cx='5.01'%20cy='4.35'%20r='0.66'%20fill='%23d4fcad'/%3E%3Ccircle%20cx='7.99'%20cy='5.3'%20r='0.66'%20fill='%23f7f0e8'/%3E%3Ccircle%20cx='14.31'%20cy='4.84'%20r='0.57'%20fill='%23f7f5e8'/%3E%3Ccircle%20cx='17.58'%20cy='4.78'%20r='0.75'%20fill='%23d4fbb0'/%3E%3Ccircle%20cx='20.47'%20cy='4.39'%20r='0.7'%20fill='%23b2fa92'/%3E%3Ccircle%20cx='24.44'%20cy='4.98'%20r='0.74'%20fill='%23c8f2b3'/%3E%3Ccircle%20cx='27.52'%20cy='5.04'%20r='0.73'%20fill='%23a5f5ee'/%3E%3Ccircle%20cx='30.04'%20cy='4.89'%20r='0.75'%20fill='%23b1f987'/%3E%3Ccircle%20cx='33.44'%20cy='5.26'%20r='0.65'%20fill='%23b0f6ac'/%3E%3Ccircle%20cx='36.53'%20cy='4.56'%20r='0.63'%20fill='%23b3f3e8'/%3E%3Ccircle%20cx='39.77'%20cy='5.08'%20r='0.9'%20fill='%23e8f7f0'/%3E%3Ccircle%20cx='43.19'%20cy='4.65'%20r='0.79'%20fill='%2389e9f3'/%3E%3Ccircle%20cx='46.75'%20cy='4.85'%20r='0.69'%20fill='%23b4e6f9'/%3E%3Ccircle%20cx='49.69'%20cy='5.07'%20r='0.8'%20fill='%23b1f0f8'/%3E%3Ccircle%20cx='53.16'%20cy='5.28'%20r='0.79'%20fill='%23bfd2f5'/%3E%3Ccircle%20cx='56.32'%20cy='5.17'%20r='0.79'%20fill='%23e9e8f7'/%3E%3Ccircle%20cx='59.16'%20cy='4.43'%20r='0.63'%20fill='%23ceaffb'/%3E%3Ccircle%20cx='62.56'%20cy='4.49'%20r='0.77'%20fill='%23e8ebf7'/%3E%3Ccircle%20cx='65.81'%20cy='5.04'%20r='0.62'%20fill='%23858cf8'/%3E%3Ccircle%20cx='68.59'%20cy='4.47'%20r='0.84'%20fill='%23ebe8f7'/%3E%3Ccircle%20cx='71.85'%20cy='4.48'%20r='0.93'%20fill='%23ee9dd1'/%3E%3Ccircle%20cx='75.1'%20cy='4.81'%20r='0.58'%20fill='%23f7e8f2'/%3E%3Ccircle%20cx='82.07'%20cy='5.16'%20r='0.61'%20fill='%23f5b9f1'/%3E%3Ccircle%20cx='84.66'%20cy='4.71'%20r='0.97'%20fill='%23a989fa'/%3E%3Ccircle%20cx='88.06'%20cy='5.22'%20r='0.56'%20fill='%23f689bf'/%3E%3Ccircle%20cx='91.19'%20cy='4.64'%20r='0.85'%20fill='%23f7e8ea'/%3E%3Ccircle%20cx='94.13'%20cy='4.95'%20r='0.71'%20fill='%23f6aedc'/%3E%3Ccircle%20cx='1.67'%20cy='8.48'%20r='0.75'%20fill='%23f7e8f2'/%3E%3Ccircle%20cx='5.1'%20cy='8.45'%20r='0.7'%20fill='%23f8d8ab'/%3E%3Ccircle%20cx='8.05'%20cy='8.27'%20r='0.76'%20fill='%23f6f7e8'/%3E%3Ccircle%20cx='11.68'%20cy='8.44'%20r='0.86'%20fill='%23f3eb8f'/%3E%3Ccircle%20cx='14.59'%20cy='8.46'%20r='0.73'%20fill='%23e8f5f7'/%3E%3Ccircle%20cx='17.37'%20cy='7.54'%20r='0.82'%20fill='%23bcf4d6'/%3E%3Ccircle%20cx='20.86'%20cy='7.95'%20r='0.76'%20fill='%23d6f6ac'/%3E%3Ccircle%20cx='23.67'%20cy='7.84'%20r='0.97'%20fill='%2386fae1'/%3E%3Ccircle%20cx='27.37'%20cy='7.99'%20r='0.58'%20fill='%239af395'/%3E%3Ccircle%20cx='30.28'%20cy='8.37'%20r='0.89'%20fill='%23e8f4f7'/%3E%3Ccircle%20cx='33.19'%20cy='7.57'%20r='0.8'%20fill='%23e8f7f3'/%3E%3Ccircle%20cx='36.59'%20cy='7.62'%20r='0.92'%20fill='%2396ede3'/%3E%3Ccircle%20cx='40.04'%20cy='8.38'%20r='1.0'%20fill='%23b6f6ac'/%3E%3Ccircle%20cx='43.52'%20cy='8.32'%20r='0.79'%20fill='%2392f6e7'/%3E%3Ccircle%20cx='46.82'%20cy='8.07'%20r='0.58'%20fill='%23a8fbc1'/%3E%3Ccircle%20cx='49.18'%20cy='7.75'%20r='0.81'%20fill='%239af6f0'/%3E%3Ccircle%20cx='52.35'%20cy='7.86'%20r='0.72'%20fill='%23d98ff9'/%3E%3Ccircle%20cx='55.7'%20cy='7.86'%20r='0.89'%20fill='%23bbd0f3'/%3E%3Ccircle%20cx='58.99'%20cy='8.37'%20r='0.73'%20fill='%239b9bf1'/%3E%3Ccircle%20cx='62.32'%20cy='7.82'%20r='0.83'%20fill='%23ebe8f7'/%3E%3Ccircle%20cx='65.91'%20cy='8.06'%20r='0.95'%20fill='%239582f9'/%3E%3Ccircle%20cx='69.03'%20cy='7.84'%20r='0.71'%20fill='%23e9a7f5'/%3E%3Ccircle%20cx='72.06'%20cy='7.71'%20r='0.92'%20fill='%23be89f4'/%3E%3Ccircle%20cx='75.62'%20cy='7.87'%20r='0.69'%20fill='%23f69882'/%3E%3Ccircle%20cx='78.21'%20cy='7.91'%20r='0.81'%20fill='%23f6a8f0'/%3E%3Ccircle%20cx='81.21'%20cy='8.33'%20r='0.93'%20fill='%23f7e8ee'/%3E%3Ccircle%20cx='84.87'%20cy='8.5'%20r='0.59'%20fill='%23f092cd'/%3E%3Ccircle%20cx='87.74'%20cy='8.41'%20r='0.8'%20fill='%23ba94f0'/%3E%3Ccircle%20cx='94.63'%20cy='8.34'%20r='0.7'%20fill='%23def7ae'/%3E%3Ccircle%20cx='1.3'%20cy='10.99'%20r='0.71'%20fill='%23bbf99a'/%3E%3Ccircle%20cx='5.15'%20cy='11.25'%20r='0.8'%20fill='%23e7f58f'/%3E%3Ccircle%20cx='8.19'%20cy='11.21'%20r='0.92'%20fill='%23baf48b'/%3E%3Ccircle%20cx='10.89'%20cy='11.48'%20r='0.56'%20fill='%23e2f0a7'/%3E%3Ccircle%20cx='14.2'%20cy='11.18'%20r='0.9'%20fill='%23dbefa6'/%3E%3Ccircle%20cx='17.76'%20cy='11.53'%20r='0.89'%20fill='%23bcf6c6'/%3E%3Ccircle%20cx='20.44'%20cy='11.23'%20r='0.77'%20fill='%23f9aeb8'/%3E%3Ccircle%20cx='24.41'%20cy='10.96'%20r='0.68'%20fill='%239efbb6'/%3E%3Ccircle%20cx='30.09'%20cy='11.06'%20r='0.58'%20fill='%23eef7e8'/%3E%3Ccircle%20cx='33.81'%20cy='10.71'%20r='0.6'%20fill='%23b2fcc6'/%3E%3Ccircle%20cx='39.68'%20cy='11.16'%20r='0.96'%20fill='%2394e2ee'/%3E%3Ccircle%20cx='43.3'%20cy='10.84'%20r='0.89'%20fill='%23e8e9f7'/%3E%3Ccircle%20cx='45.91'%20cy='11.66'%20r='0.83'%20fill='%2393e2fb'/%3E%3Ccircle%20cx='49.57'%20cy='11.6'%20r='0.57'%20fill='%23c2b7f6'/%3E%3Ccircle%20cx='53.16'%20cy='10.98'%20r='0.69'%20fill='%23f6addd'/%3E%3Ccircle%20cx='55.55'%20cy='11.37'%20r='0.81'%20fill='%23b7bef9'/%3E%3Ccircle%20cx='59.06'%20cy='11.21'%20r='0.84'%20fill='%23d1a0f5'/%3E%3Ccircle%20cx='61.94'%20cy='11.11'%20r='0.91'%20fill='%23f3b3f4'/%3E%3Ccircle%20cx='65.23'%20cy='10.89'%20r='0.93'%20fill='%23c799f5'/%3E%3Ccircle%20cx='68.84'%20cy='11.6'%20r='0.92'%20fill='%23faa3b9'/%3E%3Ccircle%20cx='71.86'%20cy='11.68'%20r='0.97'%20fill='%23e8e9f7'/%3E%3Ccircle%20cx='75.52'%20cy='11.61'%20r='0.69'%20fill='%23cc8bf1'/%3E%3Ccircle%20cx='78.73'%20cy='11.29'%20r='0.64'%20fill='%23f39dc7'/%3E%3Ccircle%20cx='82.09'%20cy='11.24'%20r='0.86'%20fill='%23e5a3f0'/%3E%3Ccircle%20cx='84.33'%20cy='10.9'%20r='0.86'%20fill='%23f3b2e4'/%3E%3Ccircle%20cx='88.18'%20cy='11.11'%20r='0.82'%20fill='%23fb7fcd'/%3E%3Ccircle%20cx='91.58'%20cy='10.95'%20r='1.0'%20fill='%23f5d895'/%3E%3Ccircle%20cx='94.6'%20cy='11.69'%20r='0.63'%20fill='%23fa99e0'/%3E%3Ccircle%20cx='1.52'%20cy='14.27'%20r='0.94'%20fill='%23f7e7bc'/%3E%3Ccircle%20cx='8.5'%20cy='14.9'%20r='0.74'%20fill='%239cf898'/%3E%3Ccircle%20cx='11.52'%20cy='14.47'%20r='0.66'%20fill='%23c4f5ac'/%3E%3Ccircle%20cx='14.23'%20cy='14.35'%20r='0.57'%20fill='%23a3fbb6'/%3E%3Ccircle%20cx='17.31'%20cy='14.05'%20r='0.62'%20fill='%239afa94'/%3E%3Ccircle%20cx='21.25'%20cy='14.41'%20r='0.76'%20fill='%23a7f3e0'/%3E%3Ccircle%20cx='24.34'%20cy='14.02'%20r='0.87'%20fill='%23a1f5ca'/%3E%3Ccircle%20cx='29.91'%20cy='14.89'%20r='0.99'%20fill='%238de4ed'/%3E%3Ccircle%20cx='33.51'%20cy='14.77'%20r='0.91'%20fill='%23ece8f7'/%3E%3Ccircle%20cx='36.63'%20cy='14.8'%20r='0.7'%20fill='%23b4e7f7'/%3E%3Ccircle%20cx='39.85'%20cy='14.48'%20r='0.69'%20fill='%23f1e8f7'/%3E%3Ccircle%20cx='43.2'%20cy='14.64'%20r='0.86'%20fill='%23b2f2e7'/%3E%3Ccircle%20cx='46.09'%20cy='14.04'%20r='0.84'%20fill='%23b095f3'/%3E%3Ccircle%20cx='49.89'%20cy='14.65'%20r='0.98'%20fill='%23e8f3f7'/%3E%3Ccircle%20cx='56.11'%20cy='14.21'%20r='0.6'%20fill='%23c094f3'/%3E%3Ccircle%20cx='59.0'%20cy='14.34'%20r='0.64'%20fill='%23c3b5f9'/%3E%3Ccircle%20cx='62.41'%20cy='14.05'%20r='0.64'%20fill='%23eda1fb'/%3E%3Ccircle%20cx='65.28'%20cy='14.74'%20r='0.57'%20fill='%23f5e8f7'/%3E%3Ccircle%20cx='69.06'%20cy='14.01'%20r='0.62'%20fill='%23efa6cc'/%3E%3Ccircle%20cx='71.52'%20cy='14.56'%20r='0.85'%20fill='%23ef91af'/%3E%3Ccircle%20cx='75.46'%20cy='14.8'%20r='0.8'%20fill='%23f5bce9'/%3E%3Ccircle%20cx='78.65'%20cy='14.52'%20r='0.79'%20fill='%23f9aae1'/%3E%3Ccircle%20cx='81.29'%20cy='14.23'%20r='0.77'%20fill='%23f7e8ef'/%3E%3Ccircle%20cx='85.22'%20cy='14.32'%20r='0.76'%20fill='%23e7ee93'/%3E%3Ccircle%20cx='87.74'%20cy='14.32'%20r='0.92'%20fill='%23fad3b9'/%3E%3Ccircle%20cx='90.82'%20cy='14.72'%20r='0.9'%20fill='%23f7ede8'/%3E%3Ccircle%20cx='94.39'%20cy='14.32'%20r='0.92'%20fill='%23ccfbba'/%3E%3Ccircle%20cx='1.63'%20cy='17.66'%20r='0.65'%20fill='%23f7b488'/%3E%3Ccircle%20cx='4.64'%20cy='17.25'%20r='0.98'%20fill='%23b2f386'/%3E%3Ccircle%20cx='11.42'%20cy='17.79'%20r='0.98'%20fill='%23f5e1b0'/%3E%3Ccircle%20cx='14.02'%20cy='17.17'%20r='0.59'%20fill='%23ebf7e8'/%3E%3Ccircle%20cx='17.87'%20cy='17.83'%20r='0.97'%20fill='%23caf2a8'/%3E%3Ccircle%20cx='20.32'%20cy='17.12'%20r='0.97'%20fill='%23aef8d9'/%3E%3Ccircle%20cx='23.92'%20cy='17.69'%20r='0.59'%20fill='%2393f0d0'/%3E%3Ccircle%20cx='27.7'%20cy='17.82'%20r='0.59'%20fill='%23e8f6f7'/%3E%3Ccircle%20cx='30.3'%20cy='17.41'%20r='0.99'%20fill='%2398ede5'/%3E%3Ccircle%20cx='34.07'%20cy='17.75'%20r='0.61'%20fill='%23a1c5f4'/%3E%3Ccircle%20cx='36.45'%20cy='17.37'%20r='0.86'%20fill='%23a3f6e4'/%3E%3Ccircle%20cx='43.6'%20cy='18.07'%20r='0.75'%20fill='%23eee8f7'/%3E%3Ccircle%20cx='46.64'%20cy='17.69'%20r='0.82'%20fill='%23b48ef5'/%3E%3Ccircle%20cx='49.17'%20cy='17.48'%20r='0.77'%20fill='%238cdaf5'/%3E%3Ccircle%20cx='52.52'%20cy='17.93'%20r='0.86'%20fill='%23e8eff7'/%3E%3Ccircle%20cx='56.35'%20cy='17.86'%20r='0.98'%20fill='%23bf91f4'/%3E%3Ccircle%20cx='59.66'%20cy='17.48'%20r='0.58'%20fill='%23f1aed2'/%3E%3Ccircle%20cx='62.67'%20cy='17.58'%20r='0.64'%20fill='%23f0e8f7'/%3E%3Ccircle%20cx='65.99'%20cy='17.82'%20r='0.72'%20fill='%23f7acf3'/%3E%3Ccircle%20cx='68.59'%20cy='17.49'%20r='0.89'%20fill='%23f289d9'/%3E%3Ccircle%20cx='72.21'%20cy='18.01'%20r='0.7'%20fill='%23f4a085'/%3E%3Ccircle%20cx='75.22'%20cy='17.14'%20r='0.57'%20fill='%23f6ec8e'/%3E%3Ccircle%20cx='78.71'%20cy='17.33'%20r='0.69'%20fill='%23f9c385'/%3E%3Ccircle%20cx='81.69'%20cy='17.43'%20r='0.66'%20fill='%23f4e0a3'/%3E%3Ccircle%20cx='84.96'%20cy='17.33'%20r='0.88'%20fill='%23eeae98'/%3E%3Ccircle%20cx='88.37'%20cy='17.37'%20r='0.95'%20fill='%23fab29a'/%3E%3Ccircle%20cx='91.24'%20cy='17.56'%20r='0.83'%20fill='%23f6a5f6'/%3E%3Ccircle%20cx='1.21'%20cy='21.2'%20r='0.63'%20fill='%23a4f09f'/%3E%3Ccircle%20cx='4.55'%20cy='20.73'%20r='0.75'%20fill='%23fbca87'/%3E%3Ccircle%20cx='8.48'%20cy='20.84'%20r='0.94'%20fill='%23c0fab4'/%3E%3Ccircle%20cx='11.54'%20cy='20.39'%20r='0.94'%20fill='%23caf5b6'/%3E%3Ccircle%20cx='14.61'%20cy='20.56'%20r='0.95'%20fill='%23cdf988'/%3E%3Ccircle%20cx='17.41'%20cy='20.98'%20r='0.97'%20fill='%2389fabb'/%3E%3Ccircle%20cx='21.05'%20cy='20.78'%20r='0.89'%20fill='%23e8f7ef'/%3E%3Ccircle%20cx='24.27'%20cy='20.44'%20r='0.95'%20fill='%239ff6e2'/%3E%3Ccircle%20cx='27.59'%20cy='21.17'%20r='0.85'%20fill='%23a1e3f1'/%3E%3Ccircle%20cx='30.25'%20cy='20.39'%20r='0.7'%20fill='%238af990'/%3E%3Ccircle%20cx='33.94'%20cy='20.51'%20r='0.62'%20fill='%23dbb2fc'/%3E%3Ccircle%20cx='36.44'%20cy='21.2'%20r='0.81'%20fill='%2397eeca'/%3E%3Ccircle%20cx='39.74'%20cy='20.3'%20r='0.86'%20fill='%23c6b7fa'/%3E%3Ccircle%20cx='46.51'%20cy='21.12'%20r='0.71'%20fill='%23b7a8fb'/%3E%3Ccircle%20cx='49.77'%20cy='20.91'%20r='0.95'%20fill='%23bea1f6'/%3E%3Ccircle%20cx='52.45'%20cy='21.04'%20r='0.66'%20fill='%23f299ea'/%3E%3Ccircle%20cx='56.34'%20cy='21.28'%20r='0.7'%20fill='%238f95fc'/%3E%3Ccircle%20cx='59.67'%20cy='20.46'%20r='0.83'%20fill='%23f8b3c9'/%3E%3Ccircle%20cx='62.43'%20cy='21.11'%20r='0.65'%20fill='%23f3a7b1'/%3E%3Ccircle%20cx='66.0'%20cy='21.11'%20r='0.9'%20fill='%23f5e8f7'/%3E%3Ccircle%20cx='69.16'%20cy='20.55'%20r='0.56'%20fill='%23f6899b'/%3E%3Ccircle%20cx='74.97'%20cy='20.49'%20r='0.81'%20fill='%23f7ece8'/%3E%3Ccircle%20cx='78.49'%20cy='20.36'%20r='0.99'%20fill='%23f4b98d'/%3E%3Ccircle%20cx='82.02'%20cy='20.69'%20r='0.71'%20fill='%23f18f9e'/%3E%3Ccircle%20cx='88.2'%20cy='20.64'%20r='0.97'%20fill='%23e8f8a2'/%3E%3Ccircle%20cx='91.15'%20cy='20.41'%20r='0.7'%20fill='%23f0f9b6'/%3E%3Ccircle%20cx='94.39'%20cy='21.16'%20r='0.78'%20fill='%23f7f5e8'/%3E%3Ccircle%20cx='1.75'%20cy='24.32'%20r='0.65'%20fill='%23f1f8a1'/%3E%3Ccircle%20cx='4.43'%20cy='24.43'%20r='0.82'%20fill='%2398eeef'/%3E%3Ccircle%20cx='8.33'%20cy='23.97'%20r='0.56'%20fill='%23aff8e9'/%3E%3Ccircle%20cx='10.92'%20cy='24.07'%20r='0.84'%20fill='%2389c2f0'/%3E%3Ccircle%20cx='14.64'%20cy='23.74'%20r='0.61'%20fill='%23b8fcf0'/%3E%3Ccircle%20cx='17.66'%20cy='23.64'%20r='0.74'%20fill='%2390fbb1'/%3E%3Ccircle%20cx='21.08'%20cy='24.36'%20r='0.96'%20fill='%2383b6f6'/%3E%3Ccircle%20cx='27.65'%20cy='24.1'%20r='0.81'%20fill='%23e8f7f2'/%3E%3Ccircle%20cx='30.22'%20cy='23.92'%20r='0.65'%20fill='%23ccbaf4'/%3E%3Ccircle%20cx='33.71'%20cy='24.4'%20r='0.69'%20fill='%239cf2f2'/%3E%3Ccircle%20cx='36.58'%20cy='24.25'%20r='0.6'%20fill='%2388b4fa'/%3E%3Ccircle%20cx='39.7'%20cy='24.44'%20r='0.85'%20fill='%23b5a9f9'/%3E%3Ccircle%20cx='43.38'%20cy='24.46'%20r='0.71'%20fill='%23bfb1f7'/%3E%3Ccircle%20cx='45.96'%20cy='23.84'%20r='0.72'%20fill='%2399bfee'/%3E%3Ccircle%20cx='49.61'%20cy='24.39'%20r='0.74'%20fill='%239188fa'/%3E%3Ccircle%20cx='52.8'%20cy='24.23'%20r='0.78'%20fill='%23ee93e9'/%3E%3Ccircle%20cx='55.81'%20cy='24.1'%20r='0.65'%20fill='%23f3e8f7'/%3E%3Ccircle%20cx='58.88'%20cy='23.66'%20r='0.89'%20fill='%23f8bace'/%3E%3Ccircle%20cx='62.3'%20cy='23.82'%20r='0.89'%20fill='%23f8b5bd'/%3E%3Ccircle%20cx='65.69'%20cy='24.01'%20r='0.7'%20fill='%23ce90f0'/%3E%3Ccircle%20cx='71.68'%20cy='24.37'%20r='0.99'%20fill='%23f5da8d'/%3E%3Ccircle%20cx='75.33'%20cy='24.28'%20r='0.98'%20fill='%23f9e69c'/%3E%3Ccircle%20cx='78.8'%20cy='24.3'%20r='0.65'%20fill='%23f1968b'/%3E%3Ccircle%20cx='81.22'%20cy='24.24'%20r='0.67'%20fill='%23f1f5be'/%3E%3Ccircle%20cx='85.03'%20cy='24.03'%20r='0.97'%20fill='%23c2f3b3'/%3E%3Ccircle%20cx='87.91'%20cy='23.78'%20r='0.92'%20fill='%23dbed9a'/%3E%3Ccircle%20cx='91.46'%20cy='23.61'%20r='0.83'%20fill='%23faa3a6'/%3E%3Ccircle%20cx='94.2'%20cy='23.81'%20r='0.8'%20fill='%23f4cca3'/%3E%3Ccircle%20cx='1.76'%20cy='27.32'%20r='0.75'%20fill='%239ff2db'/%3E%3Ccircle%20cx='5.07'%20cy='27.03'%20r='0.82'%20fill='%23ecf7e8'/%3E%3Ccircle%20cx='8.21'%20cy='27.65'%20r='0.92'%20fill='%23a0f9d6'/%3E%3Ccircle%20cx='11.28'%20cy='27.4'%20r='0.94'%20fill='%23b7f19b'/%3E%3Ccircle%20cx='13.96'%20cy='27.58'%20r='0.91'%20fill='%2397eef5'/%3E%3Ccircle%20cx='20.58'%20cy='27.43'%20r='0.94'%20fill='%23acf0e1'/%3E%3Ccircle%20cx='23.52'%20cy='27.2'%20r='0.69'%20fill='%239093fc'/%3E%3Ccircle%20cx='26.75'%20cy='27.59'%20r='0.75'%20fill='%23b9c4f7'/%3E%3Ccircle%20cx='30.01'%20cy='27.59'%20r='0.8'%20fill='%23e8f7ee'/%3E%3Ccircle%20cx='33.46'%20cy='26.99'%20r='0.68'%20fill='%23faaff7'/%3E%3Ccircle%20cx='36.95'%20cy='27.32'%20r='0.83'%20fill='%23f0e8f7'/%3E%3Ccircle%20cx='40.32'%20cy='27.15'%20r='0.71'%20fill='%23f88b85'/%3E%3Ccircle%20cx='43.58'%20cy='27.22'%20r='0.69'%20fill='%23f7e8f3'/%3E%3Ccircle%20cx='46.48'%20cy='27.21'%20r='0.78'%20fill='%23baf9e2'/%3E%3Ccircle%20cx='49.37'%20cy='27.4'%20r='0.69'%20fill='%23ebadf7'/%3E%3Ccircle%20cx='52.91'%20cy='26.87'%20r='0.63'%20fill='%23f9a1c8'/%3E%3Ccircle%20cx='56.22'%20cy='27.31'%20r='0.55'%20fill='%23f7e8f3'/%3E%3Ccircle%20cx='59.11'%20cy='26.91'%20r='0.65'%20fill='%23b79cf1'/%3E%3Ccircle%20cx='62.65'%20cy='27.03'%20r='0.83'%20fill='%23f58cb6'/%3E%3Ccircle%20cx='68.72'%20cy='26.81'%20r='0.61'%20fill='%23f1a5b2'/%3E%3Ccircle%20cx='72.01'%20cy='27.54'%20r='0.67'%20fill='%23fbdb99'/%3E%3Ccircle%20cx='75.69'%20cy='26.78'%20r='0.67'%20fill='%23f5cca2'/%3E%3Ccircle%20cx='78.1'%20cy='27.24'%20r='0.9'%20fill='%23f7f5e8'/%3E%3Ccircle%20cx='81.88'%20cy='27.44'%20r='0.73'%20fill='%23f6d3af'/%3E%3Ccircle%20cx='84.82'%20cy='27.57'%20r='0.62'%20fill='%23f7f2e8'/%3E%3Ccircle%20cx='88.06'%20cy='27.52'%20r='0.93'%20fill='%23f9dcb9'/%3E%3Ccircle%20cx='91.28'%20cy='27.42'%20r='0.82'%20fill='%23f8e9b3'/%3E%3Ccircle%20cx='94.01'%20cy='27.47'%20r='0.69'%20fill='%23c4fab0'/%3E%3Ccircle%20cx='1.59'%20cy='30.68'%20r='0.96'%20fill='%23b8f6e4'/%3E%3Ccircle%20cx='5.01'%20cy='30.19'%20r='0.68'%20fill='%23f4f7e8'/%3E%3Ccircle%20cx='8.0'%20cy='30.8'%20r='0.96'%20fill='%239fed96'/%3E%3Ccircle%20cx='11.56'%20cy='30.89'%20r='0.76'%20fill='%238df091'/%3E%3Ccircle%20cx='14.25'%20cy='30.77'%20r='0.67'%20fill='%239cd7f8'/%3E%3Ccircle%20cx='17.17'%20cy='30.51'%20r='0.96'%20fill='%23a9f0dd'/%3E%3Ccircle%20cx='21.06'%20cy='30.63'%20r='0.65'%20fill='%2394adec'/%3E%3Ccircle%20cx='24.47'%20cy='30.53'%20r='0.65'%20fill='%238a98f3'/%3E%3Ccircle%20cx='27.0'%20cy='30.89'%20r='0.99'%20fill='%23e8f7f5'/%3E%3Ccircle%20cx='30.5'%20cy='30.22'%20r='0.91'%20fill='%23a8f5e6'/%3E%3Ccircle%20cx='33.8'%20cy='30.26'%20r='0.59'%20fill='%23f0a5e2'/%3E%3Ccircle%20cx='36.35'%20cy='30.37'%20r='0.98'%20fill='%23e8eff7'/%3E%3Ccircle%20cx='40.01'%20cy='30.48'%20r='0.69'%20fill='%23fa8ded'/%3E%3Ccircle%20cx='43.58'%20cy='30.08'%20r='0.93'%20fill='%23e3affa'/%3E%3Ccircle%20cx='46.34'%20cy='30.66'%20r='0.9'%20fill='%23fcaed1'/%3E%3Ccircle%20cx='49.85'%20cy='29.93'%20r='0.77'%20fill='%23f7e8ee'/%3E%3Ccircle%20cx='52.58'%20cy='30.0'%20r='0.97'%20fill='%23f4a1de'/%3E%3Ccircle%20cx='55.76'%20cy='30.17'%20r='0.67'%20fill='%23fcb6e0'/%3E%3Ccircle%20cx='58.77'%20cy='30.85'%20r='0.71'%20fill='%23f39fac'/%3E%3Ccircle%20cx='62.81'%20cy='30.4'%20r='0.77'%20fill='%23f4bc95'/%3E%3Ccircle%20cx='66.03'%20cy='30.53'%20r='0.91'%20fill='%23faad95'/%3E%3Ccircle%20cx='69.02'%20cy='30.62'%20r='0.76'%20fill='%23f8ec9a'/%3E%3Ccircle%20cx='72.44'%20cy='30.19'%20r='0.75'%20fill='%23efa2dd'/%3E%3Ccircle%20cx='78.66'%20cy='30.45'%20r='0.69'%20fill='%23f7cab7'/%3E%3Ccircle%20cx='81.84'%20cy='29.99'%20r='0.76'%20fill='%23f4bdae'/%3E%3Ccircle%20cx='84.31'%20cy='30.02'%20r='0.86'%20fill='%23f5dcac'/%3E%3Ccircle%20cx='88.28'%20cy='30.18'%20r='0.81'%20fill='%23a8f1ba'/%3E%3Ccircle%20cx='91.0'%20cy='30.42'%20r='0.93'%20fill='%23ecf7e8'/%3E%3Ccircle%20cx='1.89'%20cy='33.87'%20r='0.76'%20fill='%238bf3ed'/%3E%3Ccircle%20cx='4.78'%20cy='33.24'%20r='0.83'%20fill='%23cefb81'/%3E%3Ccircle%20cx='7.5'%20cy='34.06'%20r='0.66'%20fill='%2387b1f9'/%3E%3Ccircle%20cx='11.53'%20cy='33.12'%20r='0.67'%20fill='%23bbd6f9'/%3E%3Ccircle%20cx='14.16'%20cy='33.61'%20r='0.84'%20fill='%23bafbb6'/%3E%3Ccircle%20cx='21.04'%20cy='33.91'%20r='0.65'%20fill='%23abdaf5'/%3E%3Ccircle%20cx='23.87'%20cy='33.92'%20r='0.64'%20fill='%23bad1f6'/%3E%3Ccircle%20cx='27.59'%20cy='33.91'%20r='0.74'%20fill='%238cc7f1'/%3E%3Ccircle%20cx='33.93'%20cy='33.15'%20r='0.72'%20fill='%23e7a6f6'/%3E%3Ccircle%20cx='39.59'%20cy='33.5'%20r='0.68'%20fill='%23ad89f2'/%3E%3Ccircle%20cx='43.09'%20cy='34.06'%20r='0.84'%20fill='%23f3e8f7'/%3E%3Ccircle%20cx='46.01'%20cy='33.27'%20r='0.99'%20fill='%23f8bad4'/%3E%3Ccircle%20cx='49.42'%20cy='33.61'%20r='0.97'%20fill='%23c1acf1'/%3E%3Ccircle%20cx='52.74'%20cy='33.28'%20r='0.81'%20fill='%23f4b2ec'/%3E%3Ccircle%20cx='56.19'%20cy='34.0'%20r='0.64'%20fill='%23f89ab1'/%3E%3Ccircle%20cx='59.01'%20cy='33.98'%20r='0.57'%20fill='%23f6d097'/%3E%3Ccircle%20cx='62.88'%20cy='33.79'%20r='0.56'%20fill='%23f79dc4'/%3E%3Ccircle%20cx='65.92'%20cy='33.98'%20r='0.92'%20fill='%23f5beb0'/%3E%3Ccircle%20cx='69.27'%20cy='33.29'%20r='0.83'%20fill='%23f7eee8'/%3E%3Ccircle%20cx='71.6'%20cy='33.63'%20r='0.55'%20fill='%23f9e7b6'/%3E%3Ccircle%20cx='75.17'%20cy='33.3'%20r='0.97'%20fill='%23f7f7b8'/%3E%3Ccircle%20cx='78.38'%20cy='33.84'%20r='0.98'%20fill='%23aff1e0'/%3E%3Ccircle%20cx='81.74'%20cy='33.92'%20r='0.75'%20fill='%23d0f5bf'/%3E%3Ccircle%20cx='84.82'%20cy='33.81'%20r='0.93'%20fill='%23f5f7e8'/%3E%3Ccircle%20cx='90.86'%20cy='33.66'%20r='0.66'%20fill='%23e4f7bd'/%3E%3Ccircle%20cx='94.28'%20cy='33.38'%20r='0.88'%20fill='%23b0f8a4'/%3E%3Ccircle%20cx='1.65'%20cy='37.3'%20r='0.83'%20fill='%23a7e9f7'/%3E%3Ccircle%20cx='5.1'%20cy='37.29'%20r='0.65'%20fill='%23e9f7e8'/%3E%3Ccircle%20cx='7.9'%20cy='37.12'%20r='0.98'%20fill='%239aeaf1'/%3E%3Ccircle%20cx='11.22'%20cy='37.14'%20r='0.93'%20fill='%2396f89d'/%3E%3Ccircle%20cx='14.11'%20cy='36.61'%20r='0.59'%20fill='%23aafacd'/%3E%3Ccircle%20cx='17.45'%20cy='36.98'%20r='0.93'%20fill='%23b0f8d4'/%3E%3Ccircle%20cx='21.04'%20cy='37.06'%20r='0.91'%20fill='%23e8f7f1'/%3E%3Ccircle%20cx='24.46'%20cy='36.58'%20r='0.72'%20fill='%23bab7f2'/%3E%3Ccircle%20cx='27.36'%20cy='36.5'%20r='0.79'%20fill='%23aef1fa'/%3E%3Ccircle%20cx='30.02'%20cy='36.89'%20r='0.81'%20fill='%23b993f7'/%3E%3Ccircle%20cx='33.11'%20cy='36.39'%20r='0.99'%20fill='%23be95f4'/%3E%3Ccircle%20cx='37.12'%20cy='36.5'%20r='0.98'%20fill='%23d8a9f7'/%3E%3Ccircle%20cx='40.48'%20cy='36.69'%20r='0.82'%20fill='%23f4e8f7'/%3E%3Ccircle%20cx='43.13'%20cy='36.36'%20r='0.67'%20fill='%23f7e8f6'/%3E%3Ccircle%20cx='46.6'%20cy='37.0'%20r='0.84'%20fill='%23c3b1f7'/%3E%3Ccircle%20cx='49.86'%20cy='37.16'%20r='0.7'%20fill='%23f88ef7'/%3E%3Ccircle%20cx='53.29'%20cy='36.66'%20r='0.94'%20fill='%23faaebb'/%3E%3Ccircle%20cx='56.24'%20cy='37.18'%20r='0.95'%20fill='%23f9a8b5'/%3E%3Ccircle%20cx='59.17'%20cy='36.87'%20r='0.82'%20fill='%23efee96'/%3E%3Ccircle%20cx='61.9'%20cy='37.09'%20r='0.86'%20fill='%23f7e9e8'/%3E%3Ccircle%20cx='65.52'%20cy='37.06'%20r='0.91'%20fill='%23b3f4b1'/%3E%3Ccircle%20cx='69.08'%20cy='36.52'%20r='0.85'%20fill='%23f5e990'/%3E%3Ccircle%20cx='71.91'%20cy='36.89'%20r='0.87'%20fill='%23f4be98'/%3E%3Ccircle%20cx='75.65'%20cy='36.34'%20r='0.72'%20fill='%23f4ceba'/%3E%3Ccircle%20cx='78.85'%20cy='36.71'%20r='0.64'%20fill='%23f5f7e8'/%3E%3Ccircle%20cx='81.61'%20cy='37.26'%20r='0.89'%20fill='%23e8f0ac'/%3E%3Ccircle%20cx='84.96'%20cy='36.85'%20r='0.59'%20fill='%23d9efa1'/%3E%3Ccircle%20cx='88.43'%20cy='36.96'%20r='0.6'%20fill='%23e0f8b2'/%3E%3Ccircle%20cx='91.44'%20cy='36.9'%20r='0.55'%20fill='%23a2f0cb'/%3E%3Ccircle%20cx='1.38'%20cy='39.78'%20r='0.58'%20fill='%23e8f7f0'/%3E%3Ccircle%20cx='5.09'%20cy='40.07'%20r='0.57'%20fill='%238bb5fb'/%3E%3Ccircle%20cx='11.68'%20cy='40.1'%20r='0.71'%20fill='%23b9f7f0'/%3E%3Ccircle%20cx='17.62'%20cy='40.15'%20r='0.7'%20fill='%23a8c2f3'/%3E%3Ccircle%20cx='20.34'%20cy='39.68'%20r='0.93'%20fill='%23c5b3f1'/%3E%3Ccircle%20cx='23.91'%20cy='40.44'%20r='0.93'%20fill='%23bfaef1'/%3E%3Ccircle%20cx='27.13'%20cy='40.33'%20r='0.79'%20fill='%23c8aef5'/%3E%3Ccircle%20cx='30.17'%20cy='39.99'%20r='0.92'%20fill='%23badcf7'/%3E%3Ccircle%20cx='33.1'%20cy='40.26'%20r='0.84'%20fill='%23c992f3'/%3E%3Ccircle%20cx='36.87'%20cy='39.66'%20r='0.88'%20fill='%239e8df0'/%3E%3Ccircle%20cx='39.66'%20cy='39.59'%20r='0.59'%20fill='%23f3a4c9'/%3E%3Ccircle%20cx='43.66'%20cy='39.94'%20r='0.76'%20fill='%23d0b1f2'/%3E%3Ccircle%20cx='46.05'%20cy='40.25'%20r='0.72'%20fill='%23f0e8f7'/%3E%3Ccircle%20cx='56.45'%20cy='39.93'%20r='0.77'%20fill='%23fc97ae'/%3E%3Ccircle%20cx='59.15'%20cy='39.95'%20r='0.58'%20fill='%23f2adcb'/%3E%3Ccircle%20cx='62.64'%20cy='39.61'%20r='0.99'%20fill='%23f5f7e8'/%3E%3Ccircle%20cx='65.54'%20cy='40.45'%20r='0.62'%20fill='%23e4f2a4'/%3E%3Ccircle%20cx='69.29'%20cy='39.93'%20r='0.69'%20fill='%23f1a9a7'/%3E%3Ccircle%20cx='71.91'%20cy='40.25'%20r='0.72'%20fill='%23bff9ac'/%3E%3Ccircle%20cx='75.53'%20cy='40.23'%20r='0.88'%20fill='%23fce3ac'/%3E%3Ccircle%20cx='78.82'%20cy='40.39'%20r='0.57'%20fill='%2397f4b2'/%3E%3Ccircle%20cx='81.75'%20cy='40.17'%20r='0.7'%20fill='%23dff8a8'/%3E%3Ccircle%20cx='85.21'%20cy='40.26'%20r='0.55'%20fill='%23e4f5a1'/%3E%3Ccircle%20cx='88.2'%20cy='40.31'%20r='0.81'%20fill='%2385f5f7'/%3E%3Ccircle%20cx='91.2'%20cy='39.52'%20r='0.63'%20fill='%23b2fcb9'/%3E%3Ccircle%20cx='94.2'%20cy='39.55'%20r='0.7'%20fill='%23c1f7a8'/%3E%3Ccircle%20cx='1.8'%20cy='43.33'%20r='0.7'%20fill='%2397f3d3'/%3E%3Ccircle%20cx='5.03'%20cy='42.93'%20r='0.57'%20fill='%23a8f3b8'/%3E%3Ccircle%20cx='7.58'%20cy='43.61'%20r='0.85'%20fill='%239ecdfa'/%3E%3Ccircle%20cx='11.67'%20cy='43.7'%20r='0.73'%20fill='%23e8f7f7'/%3E%3Ccircle%20cx='14.62'%20cy='43.7'%20r='0.71'%20fill='%23affbcc'/%3E%3Ccircle%20cx='17.29'%20cy='42.91'%20r='0.98'%20fill='%23b499f0'/%3E%3Ccircle%20cx='20.89'%20cy='43.57'%20r='0.91'%20fill='%23eae8f7'/%3E%3Ccircle%20cx='23.51'%20cy='43.02'%20r='0.76'%20fill='%23fbb2ec'/%3E%3Ccircle%20cx='26.77'%20cy='42.74'%20r='0.71'%20fill='%23928df7'/%3E%3Ccircle%20cx='30.38'%20cy='43.31'%20r='0.68'%20fill='%23f5c0d9'/%3E%3Ccircle%20cx='33.26'%20cy='43.54'%20r='0.58'%20fill='%23fbb9f6'/%3E%3Ccircle%20cx='36.41'%20cy='43.45'%20r='0.83'%20fill='%23f5baeb'/%3E%3Ccircle%20cx='40.18'%20cy='43.09'%20r='0.92'%20fill='%23f5affa'/%3E%3Ccircle%20cx='43.13'%20cy='43.56'%20r='0.59'%20fill='%23f38dd2'/%3E%3Ccircle%20cx='46.14'%20cy='43.64'%20r='0.57'%20fill='%23f9a0c1'/%3E%3Ccircle%20cx='49.42'%20cy='43.18'%20r='0.58'%20fill='%23f5b6c6'/%3E%3Ccircle%20cx='52.41'%20cy='43.7'%20r='0.61'%20fill='%23f7ebe8'/%3E%3Ccircle%20cx='55.88'%20cy='43.66'%20r='0.87'%20fill='%23f8a4ac'/%3E%3Ccircle%20cx='58.98'%20cy='43.47'%20r='0.6'%20fill='%23f7b4c3'/%3E%3Ccircle%20cx='62.14'%20cy='43.17'%20r='0.93'%20fill='%23d7f6b1'/%3E%3Ccircle%20cx='65.91'%20cy='42.93'%20r='0.98'%20fill='%23f5c5a2'/%3E%3Ccircle%20cx='71.75'%20cy='42.84'%20r='0.76'%20fill='%23ccf795'/%3E%3Ccircle%20cx='75.4'%20cy='43.21'%20r='0.57'%20fill='%23f5f0ad'/%3E%3Ccircle%20cx='78.72'%20cy='43.66'%20r='0.72'%20fill='%23faac80'/%3E%3Ccircle%20cx='84.32'%20cy='43.42'%20r='0.64'%20fill='%23bcf6b2'/%3E%3Ccircle%20cx='87.54'%20cy='43.42'%20r='0.88'%20fill='%23b1fae6'/%3E%3Ccircle%20cx='91.33'%20cy='42.75'%20r='0.72'%20fill='%239cf0de'/%3E%3Ccircle%20cx='94.11'%20cy='43.29'%20r='0.87'%20fill='%23adf1a3'/%3E%3Ccircle%20cx='1.5'%20cy='46.72'%20r='0.81'%20fill='%2388abf2'/%3E%3Ccircle%20cx='4.43'%20cy='46.4'%20r='0.96'%20fill='%23b2acfa'/%3E%3Ccircle%20cx='8.28'%20cy='46.51'%20r='0.72'%20fill='%239cb0f8'/%3E%3Ccircle%20cx='11.12'%20cy='46.05'%20r='0.74'%20fill='%23a7aef4'/%3E%3Ccircle%20cx='14.32'%20cy='46.79'%20r='0.62'%20fill='%23b091fc'/%3E%3Ccircle%20cx='17.24'%20cy='46.36'%20r='0.59'%20fill='%23f386f2'/%3E%3Ccircle%20cx='20.98'%20cy='46.48'%20r='0.92'%20fill='%23ba9df9'/%3E%3Ccircle%20cx='23.97'%20cy='46.66'%20r='0.68'%20fill='%23eee8f7'/%3E%3Ccircle%20cx='30.63'%20cy='46.17'%20r='0.79'%20fill='%23f7e8f1'/%3E%3Ccircle%20cx='33.99'%20cy='46.11'%20r='0.71'%20fill='%23f1a7ef'/%3E%3Ccircle%20cx='36.58'%20cy='46.11'%20r='0.95'%20fill='%23f8b9fb'/%3E%3Ccircle%20cx='40.24'%20cy='46.62'%20r='0.8'%20fill='%23f1c9a9'/%3E%3Ccircle%20cx='43.24'%20cy='46.53'%20r='0.96'%20fill='%23f7e8ee'/%3E%3Ccircle%20cx='46.65'%20cy='46.6'%20r='0.59'%20fill='%23ee959c'/%3E%3Ccircle%20cx='49.64'%20cy='46.21'%20r='0.64'%20fill='%23f7eee8'/%3E%3Ccircle%20cx='52.35'%20cy='45.99'%20r='0.56'%20fill='%23fcb792'/%3E%3Ccircle%20cx='55.9'%20cy='46.79'%20r='0.71'%20fill='%23e7fb96'/%3E%3Ccircle%20cx='59.7'%20cy='46.06'%20r='0.89'%20fill='%23c0f28e'/%3E%3Ccircle%20cx='62.66'%20cy='46.77'%20r='0.84'%20fill='%23eefaa1'/%3E%3Ccircle%20cx='65.36'%20cy='46.2'%20r='0.64'%20fill='%23f7f6e8'/%3E%3Ccircle%20cx='68.46'%20cy='46.74'%20r='0.57'%20fill='%23c6f2b3'/%3E%3Ccircle%20cx='71.95'%20cy='46.16'%20r='0.88'%20fill='%23d8f8ad'/%3E%3Ccircle%20cx='75.45'%20cy='46.14'%20r='0.72'%20fill='%23a0f8a5'/%3E%3Ccircle%20cx='78.64'%20cy='46.57'%20r='0.74'%20fill='%2399f3a0'/%3E%3Ccircle%20cx='81.85'%20cy='46.23'%20r='0.75'%20fill='%23e4f992'/%3E%3Ccircle%20cx='84.56'%20cy='45.9'%20r='0.64'%20fill='%23acd9fa'/%3E%3Ccircle%20cx='88.25'%20cy='46.06'%20r='0.82'%20fill='%23e8f7ec'/%3E%3Ccircle%20cx='91.58'%20cy='46.04'%20r='0.7'%20fill='%23f9d99e'/%3E%3Ccircle%20cx='94.56'%20cy='46.89'%20r='0.84'%20fill='%2380fbd8'/%3E%3Ccircle%20cx='1.77'%20cy='49.58'%20r='0.62'%20fill='%2390c3fb'/%3E%3Ccircle%20cx='5.29'%20cy='49.76'%20r='0.92'%20fill='%23b1d6f2'/%3E%3Ccircle%20cx='8.04'%20cy='49.37'%20r='0.55'%20fill='%23e8eff7'/%3E%3Ccircle%20cx='11.44'%20cy='49.57'%20r='0.73'%20fill='%23e8edf7'/%3E%3Ccircle%20cx='14.56'%20cy='49.97'%20r='0.61'%20fill='%23e8edf7'/%3E%3Ccircle%20cx='17.34'%20cy='49.5'%20r='0.74'%20fill='%23b6caf4'/%3E%3Ccircle%20cx='23.89'%20cy='49.88'%20r='0.88'%20fill='%23f7e8f1'/%3E%3Ccircle%20cx='30.22'%20cy='49.15'%20r='0.76'%20fill='%23ce8cf8'/%3E%3Ccircle%20cx='33.29'%20cy='49.95'%20r='0.67'%20fill='%23edc48f'/%3E%3Ccircle%20cx='36.48'%20cy='49.22'%20r='0.85'%20fill='%23f6e8f7'/%3E%3Ccircle%20cx='40.23'%20cy='50.02'%20r='0.92'%20fill='%23ef8efb'/%3E%3Ccircle%20cx='43.33'%20cy='49.76'%20r='0.9'%20fill='%23d0faaf'/%3E%3Ccircle%20cx='45.93'%20cy='49.41'%20r='0.76'%20fill='%23f1b1ab'/%3E%3Ccircle%20cx='49.92'%20cy='49.45'%20r='0.61'%20fill='%23f99fb5'/%3E%3Ccircle%20cx='53.25'%20cy='49.68'%20r='0.99'%20fill='%23f3b19c'/%3E%3Ccircle%20cx='56.29'%20cy='49.29'%20r='0.98'%20fill='%23fbb9b9'/%3E%3Ccircle%20cx='59.31'%20cy='49.57'%20r='0.73'%20fill='%23b3f5b3'/%3E%3Ccircle%20cx='62.57'%20cy='49.89'%20r='0.79'%20fill='%23f19893'/%3E%3Ccircle%20cx='65.77'%20cy='49.31'%20r='0.91'%20fill='%23f1c191'/%3E%3Ccircle%20cx='68.78'%20cy='49.68'%20r='0.82'%20fill='%23fae1ba'/%3E%3Ccircle%20cx='72.47'%20cy='49.14'%20r='0.78'%20fill='%23f5d6a9'/%3E%3Ccircle%20cx='75.09'%20cy='49.71'%20r='0.88'%20fill='%23e8f7ea'/%3E%3Ccircle%20cx='78.81'%20cy='49.6'%20r='0.78'%20fill='%23b6f4d9'/%3E%3Ccircle%20cx='81.58'%20cy='49.12'%20r='0.96'%20fill='%23f5f488'/%3E%3Ccircle%20cx='84.6'%20cy='49.32'%20r='0.95'%20fill='%23ebf7e8'/%3E%3Ccircle%20cx='87.58'%20cy='49.3'%20r='0.98'%20fill='%23b3f8c2'/%3E%3Ccircle%20cx='91.35'%20cy='49.38'%20r='0.9'%20fill='%23bafbcb'/%3E%3Ccircle%20cx='94.23'%20cy='49.48'%20r='0.68'%20fill='%2395e5ee'/%3E%3Ccircle%20cx='1.83'%20cy='52.82'%20r='0.56'%20fill='%238ff0fb'/%3E%3Ccircle%20cx='4.54'%20cy='52.93'%20r='0.8'%20fill='%23a7fafb'/%3E%3Ccircle%20cx='8.06'%20cy='53.28'%20r='0.75'%20fill='%23e8f6f7'/%3E%3Ccircle%20cx='11.2'%20cy='53.03'%20r='0.74'%20fill='%23b9d5f4'/%3E%3Ccircle%20cx='14.04'%20cy='52.56'%20r='0.67'%20fill='%2387c0f7'/%3E%3Ccircle%20cx='17.51'%20cy='52.36'%20r='0.8'%20fill='%23f3b6e6'/%3E%3Ccircle%20cx='21.19'%20cy='52.54'%20r='0.99'%20fill='%23aaa1f5'/%3E%3Ccircle%20cx='23.84'%20cy='52.37'%20r='0.89'%20fill='%23f2a3ec'/%3E%3Ccircle%20cx='26.84'%20cy='52.41'%20r='0.65'%20fill='%23f883d2'/%3E%3Ccircle%20cx='29.93'%20cy='53.03'%20r='1.0'%20fill='%23fbaae5'/%3E%3Ccircle%20cx='33.9'%20cy='52.71'%20r='0.57'%20fill='%23f7a4b9'/%3E%3Ccircle%20cx='36.61'%20cy='53.29'%20r='0.56'%20fill='%23fbbadd'/%3E%3Ccircle%20cx='40.29'%20cy='53.05'%20r='0.75'%20fill='%23f5b6a7'/%3E%3Ccircle%20cx='43.47'%20cy='52.75'%20r='0.65'%20fill='%23f6b8cf'/%3E%3Ccircle%20cx='46.44'%20cy='52.84'%20r='0.73'%20fill='%23ed95e1'/%3E%3Ccircle%20cx='49.35'%20cy='52.81'%20r='0.85'%20fill='%23e7f398'/%3E%3Ccircle%20cx='52.71'%20cy='53.2'%20r='0.58'%20fill='%23fbd3b8'/%3E%3Ccircle%20cx='55.54'%20cy='52.91'%20r='0.63'%20fill='%23f4d197'/%3E%3Ccircle%20cx='59.0'%20cy='52.92'%20r='0.77'%20fill='%23fb9f9a'/%3E%3Ccircle%20cx='61.92'%20cy='52.32'%20r='0.61'%20fill='%23f1f7e8'/%3E%3Ccircle%20cx='65.5'%20cy='53.09'%20r='0.91'%20fill='%23e9f7e8'/%3E%3Ccircle%20cx='69.28'%20cy='52.79'%20r='0.65'%20fill='%23b4f585'/%3E%3Ccircle%20cx='71.59'%20cy='52.39'%20r='0.81'%20fill='%238ef3a2'/%3E%3Ccircle%20cx='74.81'%20cy='52.3'%20r='0.92'%20fill='%2398edba'/%3E%3Ccircle%20cx='77.91'%20cy='52.84'%20r='0.67'%20fill='%2393c3f4'/%3E%3Ccircle%20cx='81.5'%20cy='52.97'%20r='0.9'%20fill='%2386faef'/%3E%3Ccircle%20cx='85.04'%20cy='52.44'%20r='0.62'%20fill='%23abf2e8'/%3E%3Ccircle%20cx='88.33'%20cy='53.09'%20r='0.63'%20fill='%2391c3f5'/%3E%3Ccircle%20cx='91.57'%20cy='52.53'%20r='0.93'%20fill='%239ff8ec'/%3E%3Ccircle%20cx='94.79'%20cy='53.16'%20r='0.69'%20fill='%2395f9f1'/%3E%3Ccircle%20cx='1.46'%20cy='55.61'%20r='0.7'%20fill='%23e8e8f7'/%3E%3Ccircle%20cx='5.15'%20cy='55.86'%20r='0.75'%20fill='%23e8f2f7'/%3E%3Ccircle%20cx='8.23'%20cy='55.85'%20r='0.89'%20fill='%23e8f1f7'/%3E%3Ccircle%20cx='11.51'%20cy='56.1'%20r='0.98'%20fill='%23f7e8f7'/%3E%3Ccircle%20cx='14.83'%20cy='55.57'%20r='0.6'%20fill='%23f1e8f7'/%3E%3Ccircle%20cx='17.86'%20cy='55.94'%20r='0.78'%20fill='%2387baf4'/%3E%3Ccircle%20cx='20.56'%20cy='56.07'%20r='0.96'%20fill='%23dfa3f3'/%3E%3Ccircle%20cx='24.23'%20cy='56.34'%20r='0.72'%20fill='%23ecb7f4'/%3E%3Ccircle%20cx='27.04'%20cy='56.24'%20r='0.76'%20fill='%23f4a3f0'/%3E%3Ccircle%20cx='30.19'%20cy='55.81'%20r='0.65'%20fill='%23b5a1f5'/%3E%3Ccircle%20cx='33.64'%20cy='55.66'%20r='0.62'%20fill='%23f68bc5'/%3E%3Ccircle%20cx='37.04'%20cy='55.62'%20r='0.97'%20fill='%23f68dbc'/%3E%3Ccircle%20cx='39.87'%20cy='55.54'%20r='0.93'%20fill='%23f8c3b1'/%3E%3Ccircle%20cx='43.25'%20cy='55.75'%20r='0.55'%20fill='%23eead93'/%3E%3Ccircle%20cx='46.84'%20cy='55.6'%20r='0.65'%20fill='%23fa82c8'/%3E%3Ccircle%20cx='49.65'%20cy='55.95'%20r='0.71'%20fill='%23f4dd8f'/%3E%3Ccircle%20cx='52.55'%20cy='55.84'%20r='0.79'%20fill='%23f1f4bf'/%3E%3Ccircle%20cx='56.12'%20cy='55.64'%20r='0.74'%20fill='%23f7f996'/%3E%3Ccircle%20cx='59.24'%20cy='55.85'%20r='0.85'%20fill='%23f1f7e8'/%3E%3Ccircle%20cx='62.46'%20cy='56.05'%20r='0.99'%20fill='%23c8f7b0'/%3E%3Ccircle%20cx='65.45'%20cy='55.85'%20r='0.76'%20fill='%23f2f7e8'/%3E%3Ccircle%20cx='69.16'%20cy='55.89'%20r='0.66'%20fill='%23a6f8a1'/%3E%3Ccircle%20cx='71.69'%20cy='55.95'%20r='0.65'%20fill='%23ebf7e8'/%3E%3Ccircle%20cx='74.95'%20cy='56.28'%20r='0.76'%20fill='%23b3f3c2'/%3E%3Ccircle%20cx='78.1'%20cy='56.05'%20r='0.98'%20fill='%23ece592'/%3E%3Ccircle%20cx='81.44'%20cy='55.79'%20r='0.99'%20fill='%23edf7e8'/%3E%3Ccircle%20cx='84.7'%20cy='56.46'%20r='0.97'%20fill='%23a1def4'/%3E%3Ccircle%20cx='88.34'%20cy='55.92'%20r='0.8'%20fill='%23e8f7f1'/%3E%3Ccircle%20cx='90.81'%20cy='55.68'%20r='0.56'%20fill='%23e8f7f7'/%3E%3Ccircle%20cx='93.97'%20cy='56.4'%20r='0.64'%20fill='%23bfd2f6'/%3E%3Ccircle%20cx='1.55'%20cy='59.01'%20r='0.74'%20fill='%23c49ef2'/%3E%3Ccircle%20cx='4.5'%20cy='59.66'%20r='0.92'%20fill='%239bdcf6'/%3E%3Ccircle%20cx='7.95'%20cy='59.48'%20r='0.82'%20fill='%23c094ee'/%3E%3Ccircle%20cx='11.08'%20cy='59.19'%20r='0.76'%20fill='%23bbaffa'/%3E%3Ccircle%20cx='14.83'%20cy='59.67'%20r='0.92'%20fill='%23f99399'/%3E%3Ccircle%20cx='17.84'%20cy='59.44'%20r='0.87'%20fill='%23f29a9d'/%3E%3Ccircle%20cx='20.75'%20cy='59.64'%20r='0.75'%20fill='%23c097f8'/%3E%3Ccircle%20cx='24.42'%20cy='58.88'%20r='0.78'%20fill='%23f291d6'/%3E%3Ccircle%20cx='27.15'%20cy='59.38'%20r='0.67'%20fill='%23f694be'/%3E%3Ccircle%20cx='30.27'%20cy='58.71'%20r='0.93'%20fill='%23f7e8f3'/%3E%3Ccircle%20cx='33.42'%20cy='59.15'%20r='0.73'%20fill='%23f1e3a7'/%3E%3Ccircle%20cx='37.18'%20cy='58.72'%20r='0.79'%20fill='%23f5c993'/%3E%3Ccircle%20cx='39.53'%20cy='59.24'%20r='0.65'%20fill='%23efe38a'/%3E%3Ccircle%20cx='43.18'%20cy='59.48'%20r='0.97'%20fill='%23f0939e'/%3E%3Ccircle%20cx='46.38'%20cy='58.92'%20r='0.75'%20fill='%23f59e9d'/%3E%3Ccircle%20cx='50.06'%20cy='59.44'%20r='0.66'%20fill='%23edbb8c'/%3E%3Ccircle%20cx='58.96'%20cy='59.54'%20r='0.94'%20fill='%23b3ee93'/%3E%3Ccircle%20cx='62.16'%20cy='59.28'%20r='0.86'%20fill='%23f6cfaa'/%3E%3Ccircle%20cx='65.98'%20cy='59.56'%20r='0.66'%20fill='%23a7f0e9'/%3E%3Ccircle%20cx='68.71'%20cy='58.73'%20r='0.72'%20fill='%2388f599'/%3E%3Ccircle%20cx='71.93'%20cy='59.16'%20r='0.92'%20fill='%23a2fb88'/%3E%3Ccircle%20cx='75.48'%20cy='59.15'%20r='0.58'%20fill='%23c2f4b5'/%3E%3Ccircle%20cx='77.95'%20cy='59.1'%20r='0.75'%20fill='%23cef5a9'/%3E%3Ccircle%20cx='84.75'%20cy='59.36'%20r='0.67'%20fill='%23e8f7ee'/%3E%3Ccircle%20cx='87.6'%20cy='58.96'%20r='0.73'%20fill='%2397eded'/%3E%3Ccircle%20cx='91.15'%20cy='59.38'%20r='0.95'%20fill='%238cd7f8'/%3E%3Ccircle%20cx='93.98'%20cy='59.36'%20r='0.6'%20fill='%23b3fbef'/%3E%3Ccircle%20cx='1.5'%20cy='62.15'%20r='0.94'%20fill='%2393b7f1'/%3E%3Ccircle%20cx='4.39'%20cy='62.14'%20r='0.55'%20fill='%23f6aef5'/%3E%3Ccircle%20cx='7.66'%20cy='62.41'%20r='0.87'%20fill='%23c4b1fc'/%3E%3Ccircle%20cx='10.79'%20cy='62.68'%20r='0.96'%20fill='%23f7e8f4'/%3E%3Ccircle%20cx='14.31'%20cy='62.89'%20r='0.75'%20fill='%23b6bdf2'/%3E%3Ccircle%20cx='18.05'%20cy='62.88'%20r='0.72'%20fill='%23fdb6f0'/%3E%3Ccircle%20cx='20.49'%20cy='62.74'%20r='0.98'%20fill='%23f0bc8c'/%3E%3Ccircle%20cx='23.52'%20cy='62.82'%20r='0.93'%20fill='%23eeaff6'/%3E%3Ccircle%20cx='30.15'%20cy='62.48'%20r='0.74'%20fill='%23f9bcc8'/%3E%3Ccircle%20cx='33.78'%20cy='62.1'%20r='0.83'%20fill='%23fbd7b0'/%3E%3Ccircle%20cx='36.58'%20cy='62.16'%20r='0.58'%20fill='%23f995b8'/%3E%3Ccircle%20cx='39.98'%20cy='62.49'%20r='0.96'%20fill='%23c3f884'/%3E%3Ccircle%20cx='43.35'%20cy='62.69'%20r='0.94'%20fill='%23e9f397'/%3E%3Ccircle%20cx='49.34'%20cy='62.79'%20r='0.82'%20fill='%23c4f59d'/%3E%3Ccircle%20cx='53.0'%20cy='62.63'%20r='0.81'%20fill='%23f3f7e8'/%3E%3Ccircle%20cx='55.85'%20cy='62.16'%20r='1.0'%20fill='%23b5fa9c'/%3E%3Ccircle%20cx='59.33'%20cy='62.61'%20r='0.74'%20fill='%23f3e5bd'/%3E%3Ccircle%20cx='62.85'%20cy='62.48'%20r='0.99'%20fill='%23e1f394'/%3E%3Ccircle%20cx='65.49'%20cy='62.49'%20r='0.55'%20fill='%23b1f592'/%3E%3Ccircle%20cx='68.82'%20cy='62.22'%20r='0.85'%20fill='%23b6f8b3'/%3E%3Ccircle%20cx='71.85'%20cy='62.61'%20r='0.92'%20fill='%2397f88a'/%3E%3Ccircle%20cx='75.28'%20cy='62.85'%20r='0.71'%20fill='%23a7f3e9'/%3E%3Ccircle%20cx='78.2'%20cy='62.01'%20r='0.65'%20fill='%23e8f4f7'/%3E%3Ccircle%20cx='81.41'%20cy='62.29'%20r='0.89'%20fill='%23bcf6e8'/%3E%3Ccircle%20cx='84.33'%20cy='62.33'%20r='0.87'%20fill='%23a4a0f1'/%3E%3Ccircle%20cx='87.55'%20cy='62.61'%20r='0.97'%20fill='%23e8e9f7'/%3E%3Ccircle%20cx='91.66'%20cy='61.97'%20r='0.58'%20fill='%23f2a2f6'/%3E%3Ccircle%20cx='1.87'%20cy='65.72'%20r='0.65'%20fill='%23e8eff7'/%3E%3Ccircle%20cx='5.09'%20cy='65.11'%20r='0.92'%20fill='%23f188f9'/%3E%3Ccircle%20cx='8.18'%20cy='66.1'%20r='0.64'%20fill='%23ece8f7'/%3E%3Ccircle%20cx='11.65'%20cy='65.6'%20r='0.57'%20fill='%23b293f8'/%3E%3Ccircle%20cx='14.32'%20cy='66.04'%20r='0.6'%20fill='%23dc8afa'/%3E%3Ccircle%20cx='17.77'%20cy='65.81'%20r='0.57'%20fill='%23f9abeb'/%3E%3Ccircle%20cx='21.12'%20cy='65.59'%20r='0.6'%20fill='%23f290af'/%3E%3Ccircle%20cx='24.4'%20cy='65.55'%20r='0.91'%20fill='%23eeb3f3'/%3E%3Ccircle%20cx='27.43'%20cy='65.59'%20r='0.91'%20fill='%23ef91b1'/%3E%3Ccircle%20cx='30.86'%20cy='66.04'%20r='0.98'%20fill='%23f6d59a'/%3E%3Ccircle%20cx='34.07'%20cy='65.15'%20r='0.93'%20fill='%23f39e8f'/%3E%3Ccircle%20cx='37.1'%20cy='65.54'%20r='0.98'%20fill='%23f4bfa1'/%3E%3Ccircle%20cx='39.77'%20cy='65.24'%20r='0.9'%20fill='%23f7f1e8'/%3E%3Ccircle%20cx='43.38'%20cy='65.27'%20r='0.92'%20fill='%23f7f7e8'/%3E%3Ccircle%20cx='46.32'%20cy='65.99'%20r='0.61'%20fill='%23f0f6b5'/%3E%3Ccircle%20cx='49.87'%20cy='65.59'%20r='0.65'%20fill='%23daf58e'/%3E%3Ccircle%20cx='52.77'%20cy='65.15'%20r='0.71'%20fill='%23f4f7e8'/%3E%3Ccircle%20cx='55.54'%20cy='65.97'%20r='0.81'%20fill='%23c0efa0'/%3E%3Ccircle%20cx='58.76'%20cy='65.64'%20r='0.82'%20fill='%23cdf8ad'/%3E%3Ccircle%20cx='62.22'%20cy='65.71'%20r='0.71'%20fill='%23b1f3c2'/%3E%3Ccircle%20cx='65.87'%20cy='65.83'%20r='0.76'%20fill='%23baf2fc'/%3E%3Ccircle%20cx='68.44'%20cy='65.4'%20r='0.66'%20fill='%23b4f6ac'/%3E%3Ccircle%20cx='72.08'%20cy='65.93'%20r='0.7'%20fill='%2394f4d0'/%3E%3Ccircle%20cx='74.94'%20cy='65.59'%20r='0.81'%20fill='%23adf1d4'/%3E%3Ccircle%20cx='78.39'%20cy='65.56'%20r='0.71'%20fill='%23e8f7f6'/%3E%3Ccircle%20cx='81.21'%20cy='65.38'%20r='0.6'%20fill='%23a0f5e1'/%3E%3Ccircle%20cx='84.62'%20cy='65.34'%20r='0.74'%20fill='%23aed6f4'/%3E%3Ccircle%20cx='87.6'%20cy='65.91'%20r='0.7'%20fill='%23a993f0'/%3E%3Ccircle%20cx='91.16'%20cy='65.72'%20r='0.99'%20fill='%239dc0f2'/%3E%3Ccircle%20cx='93.92'%20cy='66.02'%20r='0.76'%20fill='%23ccb3f9'/%3E%3Ccircle%20cx='1.75'%20cy='68.41'%20r='0.9'%20fill='%23f6b4d8'/%3E%3Ccircle%20cx='4.39'%20cy='68.31'%20r='0.97'%20fill='%23fa9be2'/%3E%3Ccircle%20cx='7.55'%20cy='69.16'%20r='0.95'%20fill='%238da3f3'/%3E%3Ccircle%20cx='10.87'%20cy='68.67'%20r='0.98'%20fill='%23f99ce2'/%3E%3Ccircle%20cx='14.23'%20cy='68.98'%20r='0.93'%20fill='%23f4bce8'/%3E%3Ccircle%20cx='17.73'%20cy='69.27'%20r='0.9'%20fill='%23b894f0'/%3E%3Ccircle%20cx='20.33'%20cy='68.96'%20r='0.94'%20fill='%23f7e8f7'/%3E%3Ccircle%20cx='24.46'%20cy='68.4'%20r='0.77'%20fill='%23f4b5b0'/%3E%3Ccircle%20cx='27.4'%20cy='69.22'%20r='0.69'%20fill='%23fcabe6'/%3E%3Ccircle%20cx='30.56'%20cy='68.73'%20r='0.62'%20fill='%23fba2a2'/%3E%3Ccircle%20cx='33.15'%20cy='68.67'%20r='0.61'%20fill='%23dbf788'/%3E%3Ccircle%20cx='36.99'%20cy='68.65'%20r='0.58'%20fill='%23f291b4'/%3E%3Ccircle%20cx='39.65'%20cy='68.9'%20r='0.67'%20fill='%2387fa86'/%3E%3Ccircle%20cx='43.15'%20cy='68.53'%20r='0.79'%20fill='%2399f89d'/%3E%3Ccircle%20cx='49.97'%20cy='68.92'%20r='0.78'%20fill='%23daf5b3'/%3E%3Ccircle%20cx='52.63'%20cy='68.97'%20r='0.97'%20fill='%23fccfb2'/%3E%3Ccircle%20cx='56.05'%20cy='69.03'%20r='0.55'%20fill='%23e8f7ef'/%3E%3Ccircle%20cx='59.29'%20cy='68.38'%20r='0.74'%20fill='%23f4f7e8'/%3E%3Ccircle%20cx='62.58'%20cy='69.2'%20r='0.75'%20fill='%2393b0fa'/%3E%3Ccircle%20cx='65.57'%20cy='68.34'%20r='0.69'%20fill='%23ecf7e8'/%3E%3Ccircle%20cx='69.07'%20cy='68.96'%20r='0.68'%20fill='%23acf4a4'/%3E%3Ccircle%20cx='72.24'%20cy='68.47'%20r='0.65'%20fill='%23b3f7bd'/%3E%3Ccircle%20cx='74.76'%20cy='69.23'%20r='0.8'%20fill='%238dc0f7'/%3E%3Ccircle%20cx='78.0'%20cy='68.64'%20r='0.95'%20fill='%23a9cbf8'/%3E%3Ccircle%20cx='81.61'%20cy='68.54'%20r='0.81'%20fill='%23e8e9f7'/%3E%3Ccircle%20cx='85.18'%20cy='68.78'%20r='0.78'%20fill='%23e8f7ea'/%3E%3Ccircle%20cx='87.62'%20cy='68.46'%20r='0.77'%20fill='%238ca1f4'/%3E%3Ccircle%20cx='94.67'%20cy='68.61'%20r='0.95'%20fill='%2380e5fa'/%3E%3Ccircle%20cx='1.43'%20cy='72.32'%20r='0.66'%20fill='%23c9a6f1'/%3E%3Ccircle%20cx='5.24'%20cy='71.78'%20r='0.56'%20fill='%23c3a0fb'/%3E%3Ccircle%20cx='8.43'%20cy='72.42'%20r='0.79'%20fill='%23d091fb'/%3E%3Ccircle%20cx='10.73'%20cy='72.38'%20r='0.9'%20fill='%23f8a8c6'/%3E%3Ccircle%20cx='14.62'%20cy='71.79'%20r='0.81'%20fill='%23f6b5a6'/%3E%3Ccircle%20cx='18.06'%20cy='72.4'%20r='0.68'%20fill='%23edbe96'/%3E%3Ccircle%20cx='24.12'%20cy='72.31'%20r='0.9'%20fill='%23f0a8c3'/%3E%3Ccircle%20cx='27.45'%20cy='72.26'%20r='0.99'%20fill='%23fbb0cb'/%3E%3Ccircle%20cx='33.38'%20cy='71.98'%20r='0.6'%20fill='%23f5bbb0'/%3E%3Ccircle%20cx='36.83'%20cy='72.25'%20r='0.75'%20fill='%23c8f4b4'/%3E%3Ccircle%20cx='40.22'%20cy='71.81'%20r='0.74'%20fill='%23f8af9b'/%3E%3Ccircle%20cx='42.86'%20cy='72.15'%20r='0.61'%20fill='%23d5f291'/%3E%3Ccircle%20cx='45.96'%20cy='72.39'%20r='0.71'%20fill='%23d8f6b7'/%3E%3Ccircle%20cx='49.45'%20cy='72.27'%20r='0.98'%20fill='%23ecfc9f'/%3E%3Ccircle%20cx='52.99'%20cy='72.19'%20r='0.88'%20fill='%2385f9c9'/%3E%3Ccircle%20cx='56.41'%20cy='71.58'%20r='0.65'%20fill='%23e8f3f7'/%3E%3Ccircle%20cx='59.09'%20cy='72.21'%20r='0.56'%20fill='%23f0f7e8'/%3E%3Ccircle%20cx='62.53'%20cy='72.24'%20r='0.83'%20fill='%238ef4a2'/%3E%3Ccircle%20cx='68.36'%20cy='71.84'%20r='0.67'%20fill='%23b8fafc'/%3E%3Ccircle%20cx='72.33'%20cy='71.7'%20r='0.6'%20fill='%239ad0f4'/%3E%3Ccircle%20cx='75.66'%20cy='71.5'%20r='0.71'%20fill='%23bcdff5'/%3E%3Ccircle%20cx='78.4'%20cy='71.89'%20r='0.6'%20fill='%23a1c8f7'/%3E%3Ccircle%20cx='81.33'%20cy='71.66'%20r='0.85'%20fill='%23a2a6fa'/%3E%3Ccircle%20cx='84.79'%20cy='71.56'%20r='0.77'%20fill='%239cc1fb'/%3E%3Ccircle%20cx='88.43'%20cy='71.69'%20r='0.94'%20fill='%238b9af4'/%3E%3Ccircle%20cx='91.1'%20cy='71.71'%20r='0.68'%20fill='%23989afa'/%3E%3Ccircle%20cx='94.73'%20cy='72.31'%20r='0.65'%20fill='%23faa6d8'/%3E%3Ccircle%20cx='2.01'%20cy='75.09'%20r='0.56'%20fill='%23f3a8bc'/%3E%3Ccircle%20cx='4.99'%20cy='75.56'%20r='0.9'%20fill='%23f7e8ea'/%3E%3Ccircle%20cx='7.88'%20cy='75.2'%20r='0.75'%20fill='%23f0e8f7'/%3E%3Ccircle%20cx='11.33'%20cy='75.26'%20r='0.81'%20fill='%23f7e8f3'/%3E%3Ccircle%20cx='14.34'%20cy='75.23'%20r='0.75'%20fill='%23f8b9ca'/%3E%3Ccircle%20cx='17.83'%20cy='74.8'%20r='0.97'%20fill='%23f7e8e8'/%3E%3Ccircle%20cx='20.37'%20cy='75.46'%20r='0.91'%20fill='%23f3ebba'/%3E%3Ccircle%20cx='29.94'%20cy='75.62'%20r='0.69'%20fill='%23ee8ca0'/%3E%3Ccircle%20cx='33.12'%20cy='75.22'%20r='0.96'%20fill='%23f7cd86'/%3E%3Ccircle%20cx='37.16'%20cy='75.41'%20r='0.97'%20fill='%23b5f4cd'/%3E%3Ccircle%20cx='39.77'%20cy='74.85'%20r='1.0'%20fill='%23cdfab4'/%3E%3Ccircle%20cx='42.71'%20cy='75.04'%20r='0.68'%20fill='%23c8f3ac'/%3E%3Ccircle%20cx='46.51'%20cy='74.99'%20r='0.84'%20fill='%23ccf597'/%3E%3Ccircle%20cx='49.42'%20cy='74.92'%20r='0.91'%20fill='%23dff290'/%3E%3Ccircle%20cx='53.14'%20cy='75.62'%20r='0.87'%20fill='%23bff9ae'/%3E%3Ccircle%20cx='56.05'%20cy='75.07'%20r='0.69'%20fill='%23b8f1b2'/%3E%3Ccircle%20cx='59.58'%20cy='75.37'%20r='0.94'%20fill='%2387e8f9'/%3E%3Ccircle%20cx='62.76'%20cy='75.0'%20r='0.66'%20fill='%23e3f7be'/%3E%3Ccircle%20cx='65.68'%20cy='75.48'%20r='0.61'%20fill='%238fdcee'/%3E%3Ccircle%20cx='69.09'%20cy='74.89'%20r='0.92'%20fill='%23b8f9f4'/%3E%3Ccircle%20cx='71.86'%20cy='75.03'%20r='0.59'%20fill='%238be9f0'/%3E%3Ccircle%20cx='74.88'%20cy='75.22'%20r='0.69'%20fill='%23b5ecf8'/%3E%3Ccircle%20cx='78.36'%20cy='75.67'%20r='0.62'%20fill='%23e9e8f7'/%3E%3Ccircle%20cx='81.24'%20cy='75.62'%20r='0.96'%20fill='%23e8ebf7'/%3E%3Ccircle%20cx='84.39'%20cy='75.49'%20r='0.66'%20fill='%237fc7fb'/%3E%3Ccircle%20cx='87.85'%20cy='75.2'%20r='0.65'%20fill='%239eacf1'/%3E%3Ccircle%20cx='91.17'%20cy='75.34'%20r='0.93'%20fill='%23fb81c8'/%3E%3Ccircle%20cx='93.91'%20cy='75.16'%20r='0.75'%20fill='%23e9e8f7'/%3E%3Ccircle%20cx='1.43'%20cy='78.44'%20r='0.65'%20fill='%23fbaba6'/%3E%3Ccircle%20cx='4.49'%20cy='78.0'%20r='0.64'%20fill='%23f4aae0'/%3E%3Ccircle%20cx='7.65'%20cy='78.26'%20r='0.94'%20fill='%23f6bbf7'/%3E%3Ccircle%20cx='10.85'%20cy='78.07'%20r='0.85'%20fill='%23f3e8f7'/%3E%3Ccircle%20cx='14.15'%20cy='78.48'%20r='0.89'%20fill='%23f6adb5'/%3E%3Ccircle%20cx='17.37'%20cy='78.29'%20r='0.74'%20fill='%238d87fb'/%3E%3Ccircle%20cx='20.56'%20cy='77.94'%20r='0.78'%20fill='%23efa29c'/%3E%3Ccircle%20cx='24.07'%20cy='78.0'%20r='0.86'%20fill='%23f7f3e8'/%3E%3Ccircle%20cx='26.73'%20cy='78.14'%20r='0.93'%20fill='%23ee9ec7'/%3E%3Ccircle%20cx='30.16'%20cy='78.17'%20r='0.8'%20fill='%23f7f2e8'/%3E%3Ccircle%20cx='33.38'%20cy='78.43'%20r='0.77'%20fill='%23a7fcac'/%3E%3Ccircle%20cx='36.57'%20cy='77.96'%20r='0.65'%20fill='%23c4fcb8'/%3E%3Ccircle%20cx='39.62'%20cy='78.85'%20r='0.86'%20fill='%23bbf8ba'/%3E%3Ccircle%20cx='42.71'%20cy='78.74'%20r='0.84'%20fill='%2397f5a7'/%3E%3Ccircle%20cx='46.84'%20cy='78.29'%20r='0.68'%20fill='%23f8f789'/%3E%3Ccircle%20cx='49.89'%20cy='78.25'%20r='0.72'%20fill='%23a9fb9a'/%3E%3Ccircle%20cx='52.75'%20cy='78.62'%20r='0.76'%20fill='%239afa9a'/%3E%3Ccircle%20cx='56.09'%20cy='78.51'%20r='0.67'%20fill='%239ffacf'/%3E%3Ccircle%20cx='59.19'%20cy='78.85'%20r='0.74'%20fill='%23a1f8cd'/%3E%3Ccircle%20cx='62.14'%20cy='78.82'%20r='0.9'%20fill='%23a480f9'/%3E%3Ccircle%20cx='65.39'%20cy='78.05'%20r='0.96'%20fill='%23e8ecf7'/%3E%3Ccircle%20cx='72.35'%20cy='78.01'%20r='0.67'%20fill='%23e8ebf7'/%3E%3Ccircle%20cx='75.47'%20cy='77.99'%20r='0.72'%20fill='%23a896f3'/%3E%3Ccircle%20cx='78.83'%20cy='78.46'%20r='0.69'%20fill='%23b9c3fd'/%3E%3Ccircle%20cx='81.87'%20cy='78.18'%20r='0.65'%20fill='%238cf8bf'/%3E%3Ccircle%20cx='84.71'%20cy='78.0'%20r='0.9'%20fill='%239ef0d9'/%3E%3Ccircle%20cx='88.29'%20cy='78.84'%20r='0.6'%20fill='%23bcbaf4'/%3E%3Ccircle%20cx='91.29'%20cy='78.83'%20r='0.96'%20fill='%23efe8f7'/%3E%3Ccircle%20cx='94.1'%20cy='78.85'%20r='0.95'%20fill='%23e8eef7'/%3E%3Ccircle%20cx='1.58'%20cy='81.52'%20r='0.66'%20fill='%23c293f2'/%3E%3Ccircle%20cx='4.86'%20cy='82.03'%20r='0.87'%20fill='%23f7e8f5'/%3E%3Ccircle%20cx='7.89'%20cy='82.09'%20r='0.63'%20fill='%23f8adb9'/%3E%3Ccircle%20cx='11.34'%20cy='81.7'%20r='0.75'%20fill='%23f8a4b2'/%3E%3Ccircle%20cx='13.94'%20cy='81.22'%20r='0.72'%20fill='%23f887e3'/%3E%3Ccircle%20cx='18.08'%20cy='81.32'%20r='0.63'%20fill='%23f3cfaa'/%3E%3Ccircle%20cx='20.93'%20cy='82.01'%20r='0.69'%20fill='%23f5f7e8'/%3E%3Ccircle%20cx='24.14'%20cy='81.69'%20r='0.86'%20fill='%23fbc6b0'/%3E%3Ccircle%20cx='27.64'%20cy='81.73'%20r='0.58'%20fill='%23f9f6bb'/%3E%3Ccircle%20cx='30.79'%20cy='81.85'%20r='0.76'%20fill='%23d3f2b1'/%3E%3Ccircle%20cx='33.22'%20cy='81.11'%20r='0.98'%20fill='%23f2f7e8'/%3E%3Ccircle%20cx='40.23'%20cy='81.61'%20r='0.95'%20fill='%23cbed97'/%3E%3Ccircle%20cx='43.62'%20cy='82.07'%20r='0.67'%20fill='%23fbe07e'/%3E%3Ccircle%20cx='46.15'%20cy='81.72'%20r='0.76'%20fill='%2398f3d7'/%3E%3Ccircle%20cx='50.08'%20cy='81.78'%20r='0.96'%20fill='%23b1fc9b'/%3E%3Ccircle%20cx='52.66'%20cy='81.84'%20r='0.58'%20fill='%23b0fbe2'/%3E%3Ccircle%20cx='55.77'%20cy='82.06'%20r='0.97'%20fill='%23aaddf8'/%3E%3Ccircle%20cx='59.1'%20cy='81.27'%20r='0.66'%20fill='%23eef7e8'/%3E%3Ccircle%20cx='62.4'%20cy='81.44'%20r='0.67'%20fill='%23a2f8af'/%3E%3Ccircle%20cx='65.54'%20cy='81.39'%20r='0.7'%20fill='%23a5f8e2'/%3E%3Ccircle%20cx='69.14'%20cy='81.51'%20r='0.6'%20fill='%23b9f6fc'/%3E%3Ccircle%20cx='71.52'%20cy='81.14'%20r='0.84'%20fill='%23b9e3f7'/%3E%3Ccircle%20cx='74.74'%20cy='81.35'%20r='0.94'%20fill='%23a9baf1'/%3E%3Ccircle%20cx='78.1'%20cy='81.15'%20r='0.84'%20fill='%23eee8f7'/%3E%3Ccircle%20cx='82.05'%20cy='82.09'%20r='0.73'%20fill='%23b7b5fa'/%3E%3Ccircle%20cx='84.33'%20cy='81.33'%20r='0.63'%20fill='%23fb86b3'/%3E%3Ccircle%20cx='88.06'%20cy='81.71'%20r='0.73'%20fill='%23f5b9e2'/%3E%3Ccircle%20cx='91.54'%20cy='81.72'%20r='0.87'%20fill='%23f7e8f4'/%3E%3Ccircle%20cx='94.36'%20cy='81.77'%20r='0.88'%20fill='%23ed9be8'/%3E%3Ccircle%20cx='1.74'%20cy='84.34'%20r='0.84'%20fill='%23f7e8ee'/%3E%3Ccircle%20cx='4.83'%20cy='84.81'%20r='0.98'%20fill='%23ee96d8'/%3E%3Ccircle%20cx='8.45'%20cy='84.41'%20r='0.72'%20fill='%23f596df'/%3E%3Ccircle%20cx='11.25'%20cy='85.08'%20r='0.93'%20fill='%23f7f0e8'/%3E%3Ccircle%20cx='13.93'%20cy='85.2'%20r='0.88'%20fill='%23f7f3e8'/%3E%3Ccircle%20cx='17.21'%20cy='84.78'%20r='0.74'%20fill='%23fa96cc'/%3E%3Ccircle%20cx='21.03'%20cy='84.39'%20r='0.66'%20fill='%23f6e4b9'/%3E%3Ccircle%20cx='24.03'%20cy='84.64'%20r='0.76'%20fill='%23eed2a1'/%3E%3Ccircle%20cx='27.66'%20cy='84.44'%20r='0.9'%20fill='%23f9f09a'/%3E%3Ccircle%20cx='30.83'%20cy='84.64'%20r='0.92'%20fill='%23f5e3a5'/%3E%3Ccircle%20cx='33.97'%20cy='84.64'%20r='0.96'%20fill='%23a1f6fc'/%3E%3Ccircle%20cx='36.37'%20cy='84.99'%20r='0.73'%20fill='%23c5fa97'/%3E%3Ccircle%20cx='39.84'%20cy='85.21'%20r='0.76'%20fill='%239bfaca'/%3E%3Ccircle%20cx='43.41'%20cy='85.25'%20r='0.98'%20fill='%23aaf1c1'/%3E%3Ccircle%20cx='46.54'%20cy='84.89'%20r='0.77'%20fill='%2396f496'/%3E%3Ccircle%20cx='49.54'%20cy='85.07'%20r='0.76'%20fill='%23a9f7cb'/%3E%3Ccircle%20cx='52.54'%20cy='84.77'%20r='0.99'%20fill='%23e8f7ec'/%3E%3Ccircle%20cx='55.56'%20cy='84.9'%20r='0.67'%20fill='%238dedc2'/%3E%3Ccircle%20cx='59.39'%20cy='85.06'%20r='0.71'%20fill='%239debfa'/%3E%3Ccircle%20cx='62.74'%20cy='84.99'%20r='0.97'%20fill='%23b9cff8'/%3E%3Ccircle%20cx='65.37'%20cy='84.62'%20r='0.7'%20fill='%23a09ef2'/%3E%3Ccircle%20cx='68.53'%20cy='85.15'%20r='0.61'%20fill='%2390baf4'/%3E%3Ccircle%20cx='72.22'%20cy='85.24'%20r='0.84'%20fill='%239dc0f2'/%3E%3Ccircle%20cx='75.55'%20cy='84.37'%20r='0.84'%20fill='%238acef6'/%3E%3Ccircle%20cx='78.16'%20cy='84.33'%20r='0.95'%20fill='%23e1b1f2'/%3E%3Ccircle%20cx='81.52'%20cy='84.46'%20r='0.68'%20fill='%23f5e8f7'/%3E%3Ccircle%20cx='84.57'%20cy='84.77'%20r='0.97'%20fill='%23f4e8f7'/%3E%3Ccircle%20cx='91.23'%20cy='84.92'%20r='0.85'%20fill='%23f5bce3'/%3E%3Ccircle%20cx='93.98'%20cy='84.36'%20r='0.66'%20fill='%23fa84b1'/%3E%3Ccircle%20cx='1.53'%20cy='87.69'%20r='0.57'%20fill='%23f5cfb1'/%3E%3Ccircle%20cx='5.23'%20cy='88.16'%20r='0.69'%20fill='%23f7e9e8'/%3E%3Ccircle%20cx='8.37'%20cy='88.1'%20r='0.87'%20fill='%23fad686'/%3E%3Ccircle%20cx='11.7'%20cy='87.71'%20r='0.88'%20fill='%23fb99b7'/%3E%3Ccircle%20cx='14.19'%20cy='87.85'%20r='0.96'%20fill='%23effba8'/%3E%3Ccircle%20cx='18.04'%20cy='87.82'%20r='0.63'%20fill='%23f3edb8'/%3E%3Ccircle%20cx='20.84'%20cy='88.09'%20r='0.58'%20fill='%23e9f7e8'/%3E%3Ccircle%20cx='24.24'%20cy='88.32'%20r='0.69'%20fill='%23f1b0af'/%3E%3Ccircle%20cx='26.74'%20cy='88.08'%20r='0.73'%20fill='%23f7e284'/%3E%3Ccircle%20cx='33.71'%20cy='87.55'%20r='0.93'%20fill='%23b6f08d'/%3E%3Ccircle%20cx='36.34'%20cy='87.71'%20r='0.77'%20fill='%23abf3d0'/%3E%3Ccircle%20cx='40.03'%20cy='88.34'%20r='0.72'%20fill='%23c8f497'/%3E%3Ccircle%20cx='42.72'%20cy='88.27'%20r='0.89'%20fill='%23a8ef97'/%3E%3Ccircle%20cx='46.74'%20cy='88.22'%20r='0.97'%20fill='%23aaf9df'/%3E%3Ccircle%20cx='49.84'%20cy='87.63'%20r='0.78'%20fill='%238af8f0'/%3E%3Ccircle%20cx='52.72'%20cy='87.73'%20r='1.0'%20fill='%23a5f1ec'/%3E%3Ccircle%20cx='56.38'%20cy='88.39'%20r='0.84'%20fill='%23e8f7f1'/%3E%3Ccircle%20cx='58.97'%20cy='87.98'%20r='0.87'%20fill='%23aef9db'/%3E%3Ccircle%20cx='62.0'%20cy='87.86'%20r='0.74'%20fill='%23b6d5f4'/%3E%3Ccircle%20cx='68.76'%20cy='87.93'%20r='1.0'%20fill='%23bd95fa'/%3E%3Ccircle%20cx='72.21'%20cy='88.25'%20r='0.57'%20fill='%23b38cf5'/%3E%3Ccircle%20cx='74.88'%20cy='88.06'%20r='0.76'%20fill='%2394b7f9'/%3E%3Ccircle%20cx='78.67'%20cy='88.32'%20r='0.62'%20fill='%23f5a5ce'/%3E%3Ccircle%20cx='81.95'%20cy='87.77'%20r='0.64'%20fill='%23f7e8ea'/%3E%3Ccircle%20cx='85.25'%20cy='88.05'%20r='0.58'%20fill='%23f7e8f4'/%3E%3Ccircle%20cx='87.78'%20cy='87.9'%20r='0.67'%20fill='%23d0b7f9'/%3E%3Ccircle%20cx='91.56'%20cy='87.7'%20r='0.76'%20fill='%23ef9eab'/%3E%3Ccircle%20cx='94.61'%20cy='88.49'%20r='0.95'%20fill='%23fb86f9'/%3E%3Ccircle%20cx='1.37'%20cy='91.38'%20r='0.94'%20fill='%23fa9aa4'/%3E%3Ccircle%20cx='11.5'%20cy='91.44'%20r='0.69'%20fill='%23f3d092'/%3E%3Ccircle%20cx='14.15'%20cy='91.58'%20r='0.86'%20fill='%23efcf9f'/%3E%3Ccircle%20cx='17.15'%20cy='91.4'%20r='0.96'%20fill='%23f4f0a6'/%3E%3Ccircle%20cx='20.84'%20cy='91.23'%20r='0.81'%20fill='%23bef9aa'/%3E%3Ccircle%20cx='24.44'%20cy='90.73'%20r='0.6'%20fill='%23d9f4b2'/%3E%3Ccircle%20cx='27.5'%20cy='91.49'%20r='0.83'%20fill='%23baf2b9'/%3E%3Ccircle%20cx='30.5'%20cy='91.18'%20r='0.87'%20fill='%23e8f7f1'/%3E%3Ccircle%20cx='33.38'%20cy='90.97'%20r='0.64'%20fill='%23e8f7f1'/%3E%3Ccircle%20cx='36.6'%20cy='91.7'%20r='0.82'%20fill='%2398eda2'/%3E%3Ccircle%20cx='39.77'%20cy='91.35'%20r='0.84'%20fill='%23a6f88f'/%3E%3Ccircle%20cx='42.81'%20cy='91.37'%20r='0.94'%20fill='%2399f8fc'/%3E%3Ccircle%20cx='46.19'%20cy='91.44'%20r='0.98'%20fill='%23aefbdb'/%3E%3Ccircle%20cx='49.57'%20cy='90.8'%20r='0.88'%20fill='%23baf3ec'/%3E%3Ccircle%20cx='52.8'%20cy='91.53'%20r='0.88'%20fill='%23b5f6b5'/%3E%3Ccircle%20cx='56.18'%20cy='91.14'%20r='0.58'%20fill='%23e8f5f7'/%3E%3Ccircle%20cx='62.48'%20cy='91.41'%20r='0.86'%20fill='%23aaabf7'/%3E%3Ccircle%20cx='65.28'%20cy='90.92'%20r='0.94'%20fill='%2393ddec'/%3E%3Ccircle%20cx='69.17'%20cy='90.89'%20r='0.9'%20fill='%23bfacf3'/%3E%3Ccircle%20cx='72.26'%20cy='91.24'%20r='0.75'%20fill='%23c3a5ef'/%3E%3Ccircle%20cx='75.67'%20cy='90.9'%20r='0.58'%20fill='%23f1a2f4'/%3E%3Ccircle%20cx='78.68'%20cy='90.74'%20r='0.76'%20fill='%23c5b1fa'/%3E%3Ccircle%20cx='81.26'%20cy='91.68'%20r='0.82'%20fill='%23a09fef'/%3E%3Ccircle%20cx='85.12'%20cy='91.28'%20r='0.79'%20fill='%23eea495'/%3E%3Ccircle%20cx='87.73'%20cy='91.34'%20r='0.99'%20fill='%23c4a4f0'/%3E%3Ccircle%20cx='91.65'%20cy='91.59'%20r='0.73'%20fill='%23f5bfa4'/%3E%3Ccircle%20cx='94.4'%20cy='90.83'%20r='0.63'%20fill='%23f7ece8'/%3E%3Ccircle%20cx='4.54'%20cy='94.37'%20r='1.0'%20fill='%23fcb9ad'/%3E%3Ccircle%20cx='7.86'%20cy='94.86'%20r='0.64'%20fill='%23fcbd8f'/%3E%3Ccircle%20cx='10.95'%20cy='93.97'%20r='0.7'%20fill='%23f2b6a7'/%3E%3Ccircle%20cx='14.82'%20cy='94.27'%20r='0.93'%20fill='%23f7f5e8'/%3E%3Ccircle%20cx='17.54'%20cy='94.62'%20r='0.62'%20fill='%23f5e2ac'/%3E%3Ccircle%20cx='20.77'%20cy='94.27'%20r='0.57'%20fill='%23faaa9a'/%3E%3Ccircle%20cx='23.56'%20cy='94.56'%20r='0.7'%20fill='%23f8e695'/%3E%3Ccircle%20cx='27.31'%20cy='94.15'%20r='0.56'%20fill='%23c0f7b5'/%3E%3Ccircle%20cx='29.91'%20cy='94.45'%20r='0.7'%20fill='%23baf7ba'/%3E%3Ccircle%20cx='33.12'%20cy='94.42'%20r='0.68'%20fill='%2393f888'/%3E%3Ccircle%20cx='36.98'%20cy='94.55'%20r='0.84'%20fill='%23b8f8c2'/%3E%3Ccircle%20cx='40.06'%20cy='94.15'%20r='0.77'%20fill='%23aaf5ee'/%3E%3Ccircle%20cx='42.89'%20cy='93.96'%20r='0.74'%20fill='%23aef5e6'/%3E%3Ccircle%20cx='46.15'%20cy='94.55'%20r='0.82'%20fill='%23aff9c0'/%3E%3Ccircle%20cx='49.1'%20cy='94.53'%20r='0.92'%20fill='%23e8f7f2'/%3E%3Ccircle%20cx='52.89'%20cy='94.29'%20r='0.7'%20fill='%238fd9ec'/%3E%3Ccircle%20cx='55.92'%20cy='94.43'%20r='0.98'%20fill='%23e9e8f7'/%3E%3Ccircle%20cx='59.34'%20cy='94.81'%20r='0.59'%20fill='%23e2b4fc'/%3E%3Ccircle%20cx='62.54'%20cy='94.08'%20r='0.66'%20fill='%23a5bff2'/%3E%3Ccircle%20cx='65.42'%20cy='94.37'%20r='0.73'%20fill='%23e8eef7'/%3E%3Ccircle%20cx='68.7'%20cy='94.76'%20r='0.96'%20fill='%23a2f2b7'/%3E%3Ccircle%20cx='71.61'%20cy='94.4'%20r='0.89'%20fill='%23f1aee1'/%3E%3Ccircle%20cx='74.71'%20cy='94.46'%20r='0.86'%20fill='%23ac90f2'/%3E%3Ccircle%20cx='78.87'%20cy='93.96'%20r='0.79'%20fill='%23ef9cf6'/%3E%3Ccircle%20cx='81.33'%20cy='93.91'%20r='0.74'%20fill='%23f4beee'/%3E%3Ccircle%20cx='84.68'%20cy='94.08'%20r='0.59'%20fill='%23f8aee5'/%3E%3Ccircle%20cx='88.07'%20cy='94.52'%20r='0.69'%20fill='%23f7eda4'/%3E%3Ccircle%20cx='91.05'%20cy='94.58'%20r='0.61'%20fill='%23f7e8e9'/%3E%3Ccircle%20cx='93.96'%20cy='94.79'%20r='0.93'%20fill='%23e78eef'/%3E%3C/svg%3E");
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
