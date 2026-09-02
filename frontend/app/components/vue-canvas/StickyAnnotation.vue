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
// A touch of blur softens the dots into foil rather than confetti.
const DOT_BLUR = 'blur(0.2px)'
const glitterStyle = computed(() => ({
  filter: `${DOT_BLUR} hue-rotate(${hueTurn.value})`,
}))
const glintStyle = computed(() => ({
  filter: `${DOT_BLUR} hue-rotate(${hueTurn.value})`,
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
  background-image: url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='96'%20height='96'%3E%3Ccircle%20cx='4.98'%20cy='1.24'%20r='0.73'%20fill='%23f5e6be'/%3E%3Ccircle%20cx='8.04'%20cy='1.55'%20r='0.61'%20fill='%23fcf196'/%3E%3Ccircle%20cx='14.1'%20cy='1.43'%20r='0.73'%20fill='%23f9dadc'/%3E%3Ccircle%20cx='17.94'%20cy='1.46'%20r='0.98'%20fill='%23c4fcda'/%3E%3Ccircle%20cx='24.15'%20cy='1.32'%20r='0.94'%20fill='%23e9f7e8'/%3E%3Ccircle%20cx='26.74'%20cy='1.44'%20r='0.65'%20fill='%23f7e9b7'/%3E%3Ccircle%20cx='30.88'%20cy='2.09'%20r='0.98'%20fill='%23e8f7eb'/%3E%3Ccircle%20cx='33.77'%20cy='1.19'%20r='0.8'%20fill='%23edf7e8'/%3E%3Ccircle%20cx='37.0'%20cy='1.2'%20r='0.82'%20fill='%23e2fc9b'/%3E%3Ccircle%20cx='39.94'%20cy='1.89'%20r='0.91'%20fill='%23cee5f7'/%3E%3Ccircle%20cx='42.89'%20cy='1.44'%20r='0.6'%20fill='%23bdf8da'/%3E%3Ccircle%20cx='46.51'%20cy='1.74'%20r='0.72'%20fill='%23ebf7e8'/%3E%3Ccircle%20cx='49.83'%20cy='1.79'%20r='0.61'%20fill='%23e9e1fd'/%3E%3Ccircle%20cx='52.68'%20cy='1.38'%20r='0.56'%20fill='%23e8f4f7'/%3E%3Ccircle%20cx='58.75'%20cy='1.71'%20r='0.94'%20fill='%23e3e5fb'/%3E%3Ccircle%20cx='62.42'%20cy='1.96'%20r='0.86'%20fill='%23ebdffc'/%3E%3Ccircle%20cx='65.57'%20cy='1.23'%20r='0.87'%20fill='%23fcdbfd'/%3E%3Ccircle%20cx='69.15'%20cy='1.22'%20r='0.62'%20fill='%23f9daf4'/%3E%3Ccircle%20cx='72.21'%20cy='1.64'%20r='0.74'%20fill='%23f1d9fd'/%3E%3Ccircle%20cx='74.96'%20cy='1.3'%20r='0.95'%20fill='%23fadade'/%3E%3Ccircle%20cx='78.1'%20cy='1.31'%20r='0.72'%20fill='%23e9dbfc'/%3E%3Ccircle%20cx='81.58'%20cy='1.6'%20r='0.83'%20fill='%23fadada'/%3E%3Ccircle%20cx='87.97'%20cy='1.11'%20r='0.68'%20fill='%23f9ddd6'/%3E%3Ccircle%20cx='91.48'%20cy='1.33'%20r='0.73'%20fill='%23fddee4'/%3E%3Ccircle%20cx='94.47'%20cy='1.29'%20r='0.59'%20fill='%23fcd5eb'/%3E%3Ccircle%20cx='1.49'%20cy='4.98'%20r='0.69'%20fill='%23f3f1ae'/%3E%3Ccircle%20cx='5.01'%20cy='4.35'%20r='0.66'%20fill='%23dafdb9'/%3E%3Ccircle%20cx='7.99'%20cy='5.3'%20r='0.66'%20fill='%23f7f0e8'/%3E%3Ccircle%20cx='14.31'%20cy='4.84'%20r='0.57'%20fill='%23f7f5e8'/%3E%3Ccircle%20cx='17.58'%20cy='4.78'%20r='0.75'%20fill='%23dafcbb'/%3E%3Ccircle%20cx='20.47'%20cy='4.39'%20r='0.7'%20fill='%23befba2'/%3E%3Ccircle%20cx='24.44'%20cy='4.98'%20r='0.74'%20fill='%23d0f4be'/%3E%3Ccircle%20cx='27.52'%20cy='5.04'%20r='0.73'%20fill='%23b3f6f0'/%3E%3Ccircle%20cx='30.04'%20cy='4.89'%20r='0.75'%20fill='%23bdfa99'/%3E%3Ccircle%20cx='33.44'%20cy='5.26'%20r='0.65'%20fill='%23bcf7b8'/%3E%3Ccircle%20cx='36.53'%20cy='4.56'%20r='0.63'%20fill='%23bef5ec'/%3E%3Ccircle%20cx='39.77'%20cy='5.08'%20r='0.9'%20fill='%23e8f7f0'/%3E%3Ccircle%20cx='43.19'%20cy='4.65'%20r='0.79'%20fill='%239becf5'/%3E%3Ccircle%20cx='46.75'%20cy='4.85'%20r='0.69'%20fill='%23bfe9f9'/%3E%3Ccircle%20cx='49.69'%20cy='5.07'%20r='0.8'%20fill='%23bcf2f9'/%3E%3Ccircle%20cx='53.16'%20cy='5.28'%20r='0.79'%20fill='%23dae5f9'/%3E%3Ccircle%20cx='56.32'%20cy='5.17'%20r='0.79'%20fill='%23e9e8f7'/%3E%3Ccircle%20cx='59.16'%20cy='4.43'%20r='0.63'%20fill='%23ede2fd'/%3E%3Ccircle%20cx='62.56'%20cy='4.49'%20r='0.77'%20fill='%23e8ebf7'/%3E%3Ccircle%20cx='65.81'%20cy='5.04'%20r='0.62'%20fill='%23dbddfd'/%3E%3Ccircle%20cx='68.59'%20cy='4.47'%20r='0.84'%20fill='%23ebe8f7'/%3E%3Ccircle%20cx='71.85'%20cy='4.48'%20r='0.93'%20fill='%23f8d7ec'/%3E%3Ccircle%20cx='75.1'%20cy='4.81'%20r='0.58'%20fill='%23f7e8f2'/%3E%3Ccircle%20cx='82.07'%20cy='5.16'%20r='0.61'%20fill='%23f9d5f6'/%3E%3Ccircle%20cx='84.66'%20cy='4.71'%20r='0.97'%20fill='%23e8dffd'/%3E%3Ccircle%20cx='88.06'%20cy='5.22'%20r='0.56'%20fill='%23fcdeed'/%3E%3Ccircle%20cx='91.19'%20cy='4.64'%20r='0.85'%20fill='%23f7e8ea'/%3E%3Ccircle%20cx='94.13'%20cy='4.95'%20r='0.71'%20fill='%23fad6ed'/%3E%3Ccircle%20cx='1.67'%20cy='8.48'%20r='0.75'%20fill='%23f7e8f2'/%3E%3Ccircle%20cx='5.1'%20cy='8.45'%20r='0.7'%20fill='%23f9deb7'/%3E%3Ccircle%20cx='8.05'%20cy='8.27'%20r='0.76'%20fill='%23f6f7e8'/%3E%3Ccircle%20cx='11.68'%20cy='8.44'%20r='0.86'%20fill='%23f5eea0'/%3E%3Ccircle%20cx='14.59'%20cy='8.46'%20r='0.73'%20fill='%23e8f5f7'/%3E%3Ccircle%20cx='17.37'%20cy='7.54'%20r='0.82'%20fill='%23c5f5dc'/%3E%3Ccircle%20cx='20.86'%20cy='7.95'%20r='0.76'%20fill='%23dcf7b8'/%3E%3Ccircle%20cx='23.67'%20cy='7.84'%20r='0.97'%20fill='%2399fae6'/%3E%3Ccircle%20cx='27.37'%20cy='7.99'%20r='0.58'%20fill='%23a9f5a5'/%3E%3Ccircle%20cx='30.28'%20cy='8.37'%20r='0.89'%20fill='%23e8f4f7'/%3E%3Ccircle%20cx='33.19'%20cy='7.57'%20r='0.8'%20fill='%23e8f7f3'/%3E%3Ccircle%20cx='36.59'%20cy='7.62'%20r='0.92'%20fill='%23a6f0e8'/%3E%3Ccircle%20cx='40.04'%20cy='8.38'%20r='1.0'%20fill='%23c1f7b8'/%3E%3Ccircle%20cx='43.52'%20cy='8.32'%20r='0.79'%20fill='%23a2f7ea'/%3E%3Ccircle%20cx='46.82'%20cy='8.07'%20r='0.58'%20fill='%23b5fbca'/%3E%3Ccircle%20cx='49.18'%20cy='7.75'%20r='0.81'%20fill='%23a9f8f2'/%3E%3Ccircle%20cx='52.35'%20cy='7.86'%20r='0.72'%20fill='%23f2dafd'/%3E%3Ccircle%20cx='55.7'%20cy='7.86'%20r='0.89'%20fill='%23d7e3f8'/%3E%3Ccircle%20cx='58.99'%20cy='8.37'%20r='0.73'%20fill='%23e0e0fa'/%3E%3Ccircle%20cx='62.32'%20cy='7.82'%20r='0.83'%20fill='%23ebe8f7'/%3E%3Ccircle%20cx='65.91'%20cy='8.06'%20r='0.95'%20fill='%23e7e3fd'/%3E%3Ccircle%20cx='69.03'%20cy='7.84'%20r='0.71'%20fill='%23f5d9fb'/%3E%3Ccircle%20cx='72.06'%20cy='7.71'%20r='0.92'%20fill='%23ecdcfc'/%3E%3Ccircle%20cx='75.62'%20cy='7.87'%20r='0.69'%20fill='%23fcdfd8'/%3E%3Ccircle%20cx='78.21'%20cy='7.91'%20r='0.81'%20fill='%23fbdaf8'/%3E%3Ccircle%20cx='81.21'%20cy='8.33'%20r='0.93'%20fill='%23f7e8ee'/%3E%3Ccircle%20cx='84.87'%20cy='8.5'%20r='0.59'%20fill='%23fad9ed'/%3E%3Ccircle%20cx='87.74'%20cy='8.41'%20r='0.8'%20fill='%23e7dafa'/%3E%3Ccircle%20cx='94.63'%20cy='8.34'%20r='0.7'%20fill='%23e3f8ba'/%3E%3Ccircle%20cx='1.3'%20cy='10.99'%20r='0.71'%20fill='%23c5faaa'/%3E%3Ccircle%20cx='5.15'%20cy='11.25'%20r='0.8'%20fill='%23ebf7a0'/%3E%3Ccircle%20cx='8.19'%20cy='11.21'%20r='0.92'%20fill='%23c4f59d'/%3E%3Ccircle%20cx='10.89'%20cy='11.48'%20r='0.56'%20fill='%23e6f2b4'/%3E%3Ccircle%20cx='14.2'%20cy='11.18'%20r='0.9'%20fill='%23e0f2b3'/%3E%3Ccircle%20cx='17.76'%20cy='11.53'%20r='0.89'%20fill='%23c6f7ce'/%3E%3Ccircle%20cx='20.44'%20cy='11.23'%20r='0.77'%20fill='%23fcd6db'/%3E%3Ccircle%20cx='24.41'%20cy='10.96'%20r='0.68'%20fill='%23adfbc1'/%3E%3Ccircle%20cx='30.09'%20cy='11.06'%20r='0.58'%20fill='%23eef7e8'/%3E%3Ccircle%20cx='33.81'%20cy='10.71'%20r='0.6'%20fill='%23bdfcce'/%3E%3Ccircle%20cx='39.68'%20cy='11.16'%20r='0.96'%20fill='%23b6ebf3'/%3E%3Ccircle%20cx='43.3'%20cy='10.84'%20r='0.89'%20fill='%23e8e9f7'/%3E%3Ccircle%20cx='45.91'%20cy='11.66'%20r='0.83'%20fill='%23ade9fb'/%3E%3Ccircle%20cx='49.57'%20cy='11.6'%20r='0.57'%20fill='%23e2ddfa'/%3E%3Ccircle%20cx='53.16'%20cy='10.98'%20r='0.69'%20fill='%23fad5ed'/%3E%3Ccircle%20cx='55.55'%20cy='11.37'%20r='0.81'%20fill='%23dde1fc'/%3E%3Ccircle%20cx='59.06'%20cy='11.21'%20r='0.84'%20fill='%23eeddfb'/%3E%3Ccircle%20cx='61.94'%20cy='11.11'%20r='0.91'%20fill='%23f9d9f9'/%3E%3Ccircle%20cx='65.23'%20cy='10.89'%20r='0.93'%20fill='%23eee0fc'/%3E%3Ccircle%20cx='68.84'%20cy='11.6'%20r='0.92'%20fill='%23fdd8e1'/%3E%3Ccircle%20cx='71.86'%20cy='11.68'%20r='0.97'%20fill='%23e8e9f7'/%3E%3Ccircle%20cx='75.52'%20cy='11.61'%20r='0.69'%20fill='%23f0ddfb'/%3E%3Ccircle%20cx='78.73'%20cy='11.29'%20r='0.64'%20fill='%23fad9e9'/%3E%3Ccircle%20cx='82.09'%20cy='11.24'%20r='0.86'%20fill='%23f5ddf9'/%3E%3Ccircle%20cx='84.33'%20cy='10.9'%20r='0.86'%20fill='%23f9d8f1'/%3E%3Ccircle%20cx='88.18'%20cy='11.11'%20r='0.82'%20fill='%23fdd8f0'/%3E%3Ccircle%20cx='91.58'%20cy='10.95'%20r='1.0'%20fill='%23f7dea5'/%3E%3Ccircle%20cx='94.6'%20cy='11.69'%20r='0.63'%20fill='%23fdd9f3'/%3E%3Ccircle%20cx='1.52'%20cy='14.27'%20r='0.94'%20fill='%23f8eac5'/%3E%3Ccircle%20cx='8.5'%20cy='14.9'%20r='0.74'%20fill='%23abf9a7'/%3E%3Ccircle%20cx='11.52'%20cy='14.47'%20r='0.66'%20fill='%23cdf6b9'/%3E%3Ccircle%20cx='14.23'%20cy='14.35'%20r='0.57'%20fill='%23b0fcc1'/%3E%3Ccircle%20cx='17.31'%20cy='14.05'%20r='0.62'%20fill='%23a9fba4'/%3E%3Ccircle%20cx='21.25'%20cy='14.41'%20r='0.76'%20fill='%23b4f5e4'/%3E%3Ccircle%20cx='24.34'%20cy='14.02'%20r='0.87'%20fill='%23aff7d1'/%3E%3Ccircle%20cx='29.91'%20cy='14.89'%20r='0.99'%20fill='%23a8eaf1'/%3E%3Ccircle%20cx='33.51'%20cy='14.77'%20r='0.91'%20fill='%23ece8f7'/%3E%3Ccircle%20cx='36.63'%20cy='14.8'%20r='0.7'%20fill='%23bfeaf8'/%3E%3Ccircle%20cx='39.85'%20cy='14.48'%20r='0.69'%20fill='%23f1e8f7'/%3E%3Ccircle%20cx='43.2'%20cy='14.64'%20r='0.86'%20fill='%23bdf3eb'/%3E%3Ccircle%20cx='46.09'%20cy='14.04'%20r='0.84'%20fill='%23e5dcfb'/%3E%3Ccircle%20cx='49.89'%20cy='14.65'%20r='0.98'%20fill='%23e8f3f7'/%3E%3Ccircle%20cx='56.11'%20cy='14.21'%20r='0.6'%20fill='%23eadbfb'/%3E%3Ccircle%20cx='59.0'%20cy='14.34'%20r='0.64'%20fill='%23e3dcfc'/%3E%3Ccircle%20cx='62.41'%20cy='14.05'%20r='0.64'%20fill='%23f7d6fd'/%3E%3Ccircle%20cx='65.28'%20cy='14.74'%20r='0.57'%20fill='%23f5e8f7'/%3E%3Ccircle%20cx='69.06'%20cy='14.01'%20r='0.62'%20fill='%23f8d6e8'/%3E%3Ccircle%20cx='71.52'%20cy='14.56'%20r='0.85'%20fill='%23f9d8e2'/%3E%3Ccircle%20cx='75.46'%20cy='14.8'%20r='0.8'%20fill='%23f9d8f2'/%3E%3Ccircle%20cx='78.65'%20cy='14.52'%20r='0.79'%20fill='%23fcddf3'/%3E%3Ccircle%20cx='81.29'%20cy='14.23'%20r='0.77'%20fill='%23f7e8ef'/%3E%3Ccircle%20cx='85.22'%20cy='14.32'%20r='0.76'%20fill='%23ebf1a3'/%3E%3Ccircle%20cx='87.74'%20cy='14.32'%20r='0.92'%20fill='%23fad9c3'/%3E%3Ccircle%20cx='90.82'%20cy='14.72'%20r='0.9'%20fill='%23f7ede8'/%3E%3Ccircle%20cx='94.39'%20cy='14.32'%20r='0.92'%20fill='%23d3fcc4'/%3E%3Ccircle%20cx='1.63'%20cy='17.66'%20r='0.65'%20fill='%23fbdeca'/%3E%3Ccircle%20cx='4.64'%20cy='17.25'%20r='0.98'%20fill='%23bef599'/%3E%3Ccircle%20cx='11.42'%20cy='17.79'%20r='0.98'%20fill='%23f6e5bc'/%3E%3Ccircle%20cx='14.02'%20cy='17.17'%20r='0.59'%20fill='%23ebf7e8'/%3E%3Ccircle%20cx='17.87'%20cy='17.83'%20r='0.97'%20fill='%23d2f4b5'/%3E%3Ccircle%20cx='20.32'%20cy='17.12'%20r='0.97'%20fill='%23baf9df'/%3E%3Ccircle%20cx='23.92'%20cy='17.69'%20r='0.59'%20fill='%23a3f3d7'/%3E%3Ccircle%20cx='27.7'%20cy='17.82'%20r='0.59'%20fill='%23e8f6f7'/%3E%3Ccircle%20cx='30.3'%20cy='17.41'%20r='0.99'%20fill='%23a8efe9'/%3E%3Ccircle%20cx='34.07'%20cy='17.75'%20r='0.61'%20fill='%23d4e4fa'/%3E%3Ccircle%20cx='36.45'%20cy='17.37'%20r='0.86'%20fill='%23b1f7e8'/%3E%3Ccircle%20cx='43.6'%20cy='18.07'%20r='0.75'%20fill='%23eee8f7'/%3E%3Ccircle%20cx='46.64'%20cy='17.69'%20r='0.82'%20fill='%23ebe1fc'/%3E%3Ccircle%20cx='49.17'%20cy='17.48'%20r='0.77'%20fill='%23bae9f9'/%3E%3Ccircle%20cx='52.52'%20cy='17.93'%20r='0.86'%20fill='%23e8eff7'/%3E%3Ccircle%20cx='56.35'%20cy='17.86'%20r='0.98'%20fill='%23e9d9fb'/%3E%3Ccircle%20cx='59.66'%20cy='17.48'%20r='0.58'%20fill='%23f9ddec'/%3E%3Ccircle%20cx='62.67'%20cy='17.58'%20r='0.64'%20fill='%23f0e8f7'/%3E%3Ccircle%20cx='65.99'%20cy='17.82'%20r='0.72'%20fill='%23fbd5f9'/%3E%3Ccircle%20cx='68.59'%20cy='17.49'%20r='0.89'%20fill='%23fbdcf3'/%3E%3Ccircle%20cx='72.21'%20cy='18.01'%20r='0.7'%20fill='%23fbdad0'/%3E%3Ccircle%20cx='75.22'%20cy='17.14'%20r='0.57'%20fill='%23f7ef9f'/%3E%3Ccircle%20cx='78.71'%20cy='17.33'%20r='0.69'%20fill='%23fbdab5'/%3E%3Ccircle%20cx='81.69'%20cy='17.43'%20r='0.66'%20fill='%23f6e4b0'/%3E%3Ccircle%20cx='84.96'%20cy='17.33'%20r='0.88'%20fill='%23f7ddd4'/%3E%3Ccircle%20cx='88.37'%20cy='17.37'%20r='0.95'%20fill='%23fcdbd0'/%3E%3Ccircle%20cx='91.24'%20cy='17.56'%20r='0.83'%20fill='%23fbd7fb'/%3E%3Ccircle%20cx='1.21'%20cy='21.2'%20r='0.63'%20fill='%23b2f2ae'/%3E%3Ccircle%20cx='4.55'%20cy='20.73'%20r='0.75'%20fill='%23fcdbad'/%3E%3Ccircle%20cx='8.48'%20cy='20.84'%20r='0.94'%20fill='%23c9fbbf'/%3E%3Ccircle%20cx='11.54'%20cy='20.39'%20r='0.94'%20fill='%23d1f7c0'/%3E%3Ccircle%20cx='14.61'%20cy='20.56'%20r='0.95'%20fill='%23d5fa9a'/%3E%3Ccircle%20cx='17.41'%20cy='20.98'%20r='0.97'%20fill='%239bfbc5'/%3E%3Ccircle%20cx='21.05'%20cy='20.78'%20r='0.89'%20fill='%23e8f7ef'/%3E%3Ccircle%20cx='24.27'%20cy='20.44'%20r='0.95'%20fill='%23adf8e6'/%3E%3Ccircle%20cx='27.59'%20cy='21.17'%20r='0.85'%20fill='%23b8eaf5'/%3E%3Ccircle%20cx='30.25'%20cy='20.39'%20r='0.7'%20fill='%239cfaa1'/%3E%3Ccircle%20cx='33.94'%20cy='20.51'%20r='0.62'%20fill='%23eedbfd'/%3E%3Ccircle%20cx='36.44'%20cy='21.2'%20r='0.81'%20fill='%23a7f1d2'/%3E%3Ccircle%20cx='39.74'%20cy='20.3'%20r='0.86'%20fill='%23e5defc'/%3E%3Ccircle%20cx='46.51'%20cy='21.12'%20r='0.71'%20fill='%23e2dcfd'/%3E%3Ccircle%20cx='49.77'%20cy='20.91'%20r='0.95'%20fill='%23e8ddfc'/%3E%3Ccircle%20cx='52.45'%20cy='21.04'%20r='0.66'%20fill='%23fad6f6'/%3E%3Ccircle%20cx='56.34'%20cy='21.28'%20r='0.7'%20fill='%23dcdefe'/%3E%3Ccircle%20cx='59.67'%20cy='20.46'%20r='0.83'%20fill='%23fbdae4'/%3E%3Ccircle%20cx='62.43'%20cy='21.11'%20r='0.65'%20fill='%23fad8dc'/%3E%3Ccircle%20cx='66.0'%20cy='21.11'%20r='0.9'%20fill='%23f5e8f7'/%3E%3Ccircle%20cx='69.16'%20cy='20.55'%20r='0.56'%20fill='%23fcdde3'/%3E%3Ccircle%20cx='74.97'%20cy='20.49'%20r='0.81'%20fill='%23f7ece8'/%3E%3Ccircle%20cx='78.49'%20cy='20.36'%20r='0.99'%20fill='%23f9dac3'/%3E%3Ccircle%20cx='82.02'%20cy='20.69'%20r='0.71'%20fill='%23fad6dc'/%3E%3Ccircle%20cx='88.2'%20cy='20.64'%20r='0.97'%20fill='%23ecf9b0'/%3E%3Ccircle%20cx='91.15'%20cy='20.41'%20r='0.7'%20fill='%23f2f9c0'/%3E%3Ccircle%20cx='94.39'%20cy='21.16'%20r='0.78'%20fill='%23f7f5e8'/%3E%3Ccircle%20cx='1.75'%20cy='24.32'%20r='0.65'%20fill='%23f3f9af'/%3E%3Ccircle%20cx='4.43'%20cy='24.43'%20r='0.82'%20fill='%23a7f1f1'/%3E%3Ccircle%20cx='8.33'%20cy='23.97'%20r='0.56'%20fill='%23bbf9ec'/%3E%3Ccircle%20cx='10.92'%20cy='24.07'%20r='0.84'%20fill='%23c9e3f8'/%3E%3Ccircle%20cx='14.64'%20cy='23.74'%20r='0.61'%20fill='%23c2fdf2'/%3E%3Ccircle%20cx='17.66'%20cy='23.64'%20r='0.74'%20fill='%23a1fbbc'/%3E%3Ccircle%20cx='21.08'%20cy='24.36'%20r='0.96'%20fill='%23cfe3fb'/%3E%3Ccircle%20cx='27.65'%20cy='24.1'%20r='0.81'%20fill='%23e8f7f2'/%3E%3Ccircle%20cx='30.22'%20cy='23.92'%20r='0.65'%20fill='%23e7dffa'/%3E%3Ccircle%20cx='33.71'%20cy='24.4'%20r='0.69'%20fill='%23abf4f4'/%3E%3Ccircle%20cx='36.58'%20cy='24.25'%20r='0.6'%20fill='%23d5e4fd'/%3E%3Ccircle%20cx='39.7'%20cy='24.44'%20r='0.85'%20fill='%23e1dcfc'/%3E%3Ccircle%20cx='43.38'%20cy='24.46'%20r='0.71'%20fill='%23e7e2fc'/%3E%3Ccircle%20cx='45.96'%20cy='23.84'%20r='0.72'%20fill='%23d5e4f8'/%3E%3Ccircle%20cx='49.61'%20cy='24.39'%20r='0.74'%20fill='%23e1dffd'/%3E%3Ccircle%20cx='52.8'%20cy='24.23'%20r='0.78'%20fill='%23f9d9f7'/%3E%3Ccircle%20cx='55.81'%20cy='24.1'%20r='0.65'%20fill='%23f3e8f7'/%3E%3Ccircle%20cx='58.88'%20cy='23.66'%20r='0.89'%20fill='%23fbd6e2'/%3E%3Ccircle%20cx='62.3'%20cy='23.82'%20r='0.89'%20fill='%23fbdbdf'/%3E%3Ccircle%20cx='65.69'%20cy='24.01'%20r='0.7'%20fill='%23f1e0fb'/%3E%3Ccircle%20cx='71.68'%20cy='24.37'%20r='0.99'%20fill='%23f6df9f'/%3E%3Ccircle%20cx='75.33'%20cy='24.28'%20r='0.98'%20fill='%23faeaaa'/%3E%3Ccircle%20cx='78.8'%20cy='24.3'%20r='0.65'%20fill='%23f9d8d3'/%3E%3Ccircle%20cx='81.22'%20cy='24.24'%20r='0.67'%20fill='%23f3f7c7'/%3E%3Ccircle%20cx='85.03'%20cy='24.03'%20r='0.97'%20fill='%23cbf5be'/%3E%3Ccircle%20cx='87.91'%20cy='23.78'%20r='0.92'%20fill='%23e0f0a9'/%3E%3Ccircle%20cx='91.46'%20cy='23.61'%20r='0.83'%20fill='%23fdd8d9'/%3E%3Ccircle%20cx='94.2'%20cy='23.81'%20r='0.8'%20fill='%23f8dec3'/%3E%3Ccircle%20cx='1.76'%20cy='27.32'%20r='0.75'%20fill='%23aef4e1'/%3E%3Ccircle%20cx='5.07'%20cy='27.03'%20r='0.82'%20fill='%23ecf7e8'/%3E%3Ccircle%20cx='8.21'%20cy='27.65'%20r='0.92'%20fill='%23aefadc'/%3E%3Ccircle%20cx='11.28'%20cy='27.4'%20r='0.94'%20fill='%23c2f3aa'/%3E%3Ccircle%20cx='13.96'%20cy='27.58'%20r='0.91'%20fill='%23a7f1f6'/%3E%3Ccircle%20cx='20.58'%20cy='27.43'%20r='0.94'%20fill='%23b8f2e5'/%3E%3Ccircle%20cx='23.52'%20cy='27.2'%20r='0.69'%20fill='%23dcddfe'/%3E%3Ccircle%20cx='26.75'%20cy='27.59'%20r='0.75'%20fill='%23dfe4fb'/%3E%3Ccircle%20cx='30.01'%20cy='27.59'%20r='0.8'%20fill='%23e8f7ee'/%3E%3Ccircle%20cx='33.46'%20cy='26.99'%20r='0.68'%20fill='%23fcd8fb'/%3E%3Ccircle%20cx='36.95'%20cy='27.32'%20r='0.83'%20fill='%23f0e8f7'/%3E%3Ccircle%20cx='40.32'%20cy='27.15'%20r='0.71'%20fill='%23fddddb'/%3E%3Ccircle%20cx='43.58'%20cy='27.22'%20r='0.69'%20fill='%23f7e8f3'/%3E%3Ccircle%20cx='46.48'%20cy='27.21'%20r='0.78'%20fill='%23c4fae6'/%3E%3Ccircle%20cx='49.37'%20cy='27.4'%20r='0.69'%20fill='%23f4d5fb'/%3E%3Ccircle%20cx='52.91'%20cy='26.87'%20r='0.63'%20fill='%23fcd6e7'/%3E%3Ccircle%20cx='56.22'%20cy='27.31'%20r='0.55'%20fill='%23f7e8f3'/%3E%3Ccircle%20cx='59.11'%20cy='26.91'%20r='0.65'%20fill='%23e9e1fa'/%3E%3Ccircle%20cx='62.65'%20cy='27.03'%20r='0.83'%20fill='%23fbd6e5'/%3E%3Ccircle%20cx='68.72'%20cy='26.81'%20r='0.61'%20fill='%23fadee3'/%3E%3Ccircle%20cx='72.01'%20cy='27.54'%20r='0.67'%20fill='%23fbe0a9'/%3E%3Ccircle%20cx='75.69'%20cy='26.78'%20r='0.67'%20fill='%23f9dec3'/%3E%3Ccircle%20cx='78.1'%20cy='27.24'%20r='0.9'%20fill='%23f7f5e8'/%3E%3Ccircle%20cx='81.88'%20cy='27.44'%20r='0.73'%20fill='%23f8dec4'/%3E%3Ccircle%20cx='84.82'%20cy='27.57'%20r='0.62'%20fill='%23f7f2e8'/%3E%3Ccircle%20cx='88.06'%20cy='27.52'%20r='0.93'%20fill='%23fae1c3'/%3E%3Ccircle%20cx='91.28'%20cy='27.42'%20r='0.82'%20fill='%23f9ecbe'/%3E%3Ccircle%20cx='94.01'%20cy='27.47'%20r='0.69'%20fill='%23ccfbbc'/%3E%3Ccircle%20cx='1.59'%20cy='30.68'%20r='0.96'%20fill='%23c2f7e8'/%3E%3Ccircle%20cx='5.01'%20cy='30.19'%20r='0.68'%20fill='%23f4f7e8'/%3E%3Ccircle%20cx='8.0'%20cy='30.8'%20r='0.96'%20fill='%23aef0a6'/%3E%3Ccircle%20cx='11.56'%20cy='30.89'%20r='0.76'%20fill='%239ef3a2'/%3E%3Ccircle%20cx='14.25'%20cy='30.77'%20r='0.67'%20fill='%23c8e8fb'/%3E%3Ccircle%20cx='17.17'%20cy='30.51'%20r='0.96'%20fill='%23b5f2e2'/%3E%3Ccircle%20cx='21.06'%20cy='30.63'%20r='0.65'%20fill='%23d9e1f8'/%3E%3Ccircle%20cx='24.47'%20cy='30.53'%20r='0.65'%20fill='%23dce1fb'/%3E%3Ccircle%20cx='27.0'%20cy='30.89'%20r='0.99'%20fill='%23e8f7f5'/%3E%3Ccircle%20cx='30.5'%20cy='30.22'%20r='0.91'%20fill='%23b5f7e9'/%3E%3Ccircle%20cx='33.8'%20cy='30.26'%20r='0.59'%20fill='%23f8d5f2'/%3E%3Ccircle%20cx='36.35'%20cy='30.37'%20r='0.98'%20fill='%23e8eff7'/%3E%3Ccircle%20cx='40.01'%20cy='30.48'%20r='0.69'%20fill='%23fdd9f9'/%3E%3Ccircle%20cx='43.58'%20cy='30.08'%20r='0.93'%20fill='%23f1d8fc'/%3E%3Ccircle%20cx='46.34'%20cy='30.66'%20r='0.9'%20fill='%23fdd8e9'/%3E%3Ccircle%20cx='49.85'%20cy='29.93'%20r='0.77'%20fill='%23f7e8ee'/%3E%3Ccircle%20cx='52.58'%20cy='30.0'%20r='0.97'%20fill='%23fbddf3'/%3E%3Ccircle%20cx='55.76'%20cy='30.17'%20r='0.67'%20fill='%23fdd4ed'/%3E%3Ccircle%20cx='58.77'%20cy='30.85'%20r='0.71'%20fill='%23fadbe0'/%3E%3Ccircle%20cx='62.81'%20cy='30.4'%20r='0.77'%20fill='%23f9deca'/%3E%3Ccircle%20cx='66.03'%20cy='30.53'%20r='0.91'%20fill='%23fcd8cc'/%3E%3Ccircle%20cx='69.02'%20cy='30.62'%20r='0.76'%20fill='%23f9efa9'/%3E%3Ccircle%20cx='72.44'%20cy='30.19'%20r='0.75'%20fill='%23f9dcf2'/%3E%3Ccircle%20cx='78.66'%20cy='30.45'%20r='0.69'%20fill='%23f9d8cb'/%3E%3Ccircle%20cx='81.84'%20cy='29.99'%20r='0.76'%20fill='%23f9ddd5'/%3E%3Ccircle%20cx='84.31'%20cy='30.02'%20r='0.86'%20fill='%23f6e1b9'/%3E%3Ccircle%20cx='88.28'%20cy='30.18'%20r='0.81'%20fill='%23b5f3c4'/%3E%3Ccircle%20cx='91.0'%20cy='30.42'%20r='0.93'%20fill='%23ecf7e8'/%3E%3Ccircle%20cx='1.89'%20cy='33.87'%20r='0.76'%20fill='%239df5f0'/%3E%3Ccircle%20cx='4.78'%20cy='33.24'%20r='0.83'%20fill='%23d5fb95'/%3E%3Ccircle%20cx='7.5'%20cy='34.06'%20r='0.66'%20fill='%23d3e3fc'/%3E%3Ccircle%20cx='11.53'%20cy='33.12'%20r='0.67'%20fill='%23cee1fa'/%3E%3Ccircle%20cx='14.16'%20cy='33.61'%20r='0.84'%20fill='%23c4fbc0'/%3E%3Ccircle%20cx='21.04'%20cy='33.91'%20r='0.65'%20fill='%23cae7f8'/%3E%3Ccircle%20cx='23.87'%20cy='33.92'%20r='0.64'%20fill='%23d6e4f9'/%3E%3Ccircle%20cx='27.59'%20cy='33.91'%20r='0.74'%20fill='%23cbe5f9'/%3E%3Ccircle%20cx='33.93'%20cy='33.15'%20r='0.72'%20fill='%23f4d8fb'/%3E%3Ccircle%20cx='39.59'%20cy='33.5'%20r='0.68'%20fill='%23e6dcfb'/%3E%3Ccircle%20cx='43.09'%20cy='34.06'%20r='0.84'%20fill='%23f3e8f7'/%3E%3Ccircle%20cx='46.01'%20cy='33.27'%20r='0.99'%20fill='%23fbd6e6'/%3E%3Ccircle%20cx='49.42'%20cy='33.61'%20r='0.97'%20fill='%23e5dcf9'/%3E%3Ccircle%20cx='52.74'%20cy='33.28'%20r='0.81'%20fill='%23f9d8f5'/%3E%3Ccircle%20cx='56.19'%20cy='34.0'%20r='0.64'%20fill='%23fcd9e2'/%3E%3Ccircle%20cx='59.01'%20cy='33.98'%20r='0.57'%20fill='%23f8dbb0'/%3E%3Ccircle%20cx='62.88'%20cy='33.79'%20r='0.56'%20fill='%23fcdbe9'/%3E%3Ccircle%20cx='65.92'%20cy='33.98'%20r='0.92'%20fill='%23faded7'/%3E%3Ccircle%20cx='69.27'%20cy='33.29'%20r='0.83'%20fill='%23f7eee8'/%3E%3Ccircle%20cx='71.6'%20cy='33.63'%20r='0.55'%20fill='%23faeac1'/%3E%3Ccircle%20cx='75.17'%20cy='33.3'%20r='0.97'%20fill='%23f8f8c2'/%3E%3Ccircle%20cx='78.38'%20cy='33.84'%20r='0.98'%20fill='%23bbf3e4'/%3E%3Ccircle%20cx='81.74'%20cy='33.92'%20r='0.75'%20fill='%23d7f6c8'/%3E%3Ccircle%20cx='84.82'%20cy='33.81'%20r='0.93'%20fill='%23f5f7e8'/%3E%3Ccircle%20cx='90.86'%20cy='33.66'%20r='0.66'%20fill='%23e8f8c7'/%3E%3Ccircle%20cx='94.28'%20cy='33.38'%20r='0.88'%20fill='%23bcf9b2'/%3E%3Ccircle%20cx='1.65'%20cy='37.3'%20r='0.83'%20fill='%23b4ecf8'/%3E%3Ccircle%20cx='5.1'%20cy='37.29'%20r='0.65'%20fill='%23e9f7e8'/%3E%3Ccircle%20cx='7.9'%20cy='37.12'%20r='0.98'%20fill='%23a9edf3'/%3E%3Ccircle%20cx='11.22'%20cy='37.14'%20r='0.93'%20fill='%23a6f9ac'/%3E%3Ccircle%20cx='14.11'%20cy='36.61'%20r='0.59'%20fill='%23b6fbd4'/%3E%3Ccircle%20cx='17.45'%20cy='36.98'%20r='0.93'%20fill='%23bbf9da'/%3E%3Ccircle%20cx='21.04'%20cy='37.06'%20r='0.91'%20fill='%23e8f7f1'/%3E%3Ccircle%20cx='24.46'%20cy='36.58'%20r='0.72'%20fill='%23e5e4fa'/%3E%3Ccircle%20cx='27.36'%20cy='36.5'%20r='0.79'%20fill='%23baf3fb'/%3E%3Ccircle%20cx='30.02'%20cy='36.89'%20r='0.81'%20fill='%23e8ddfc'/%3E%3Ccircle%20cx='33.11'%20cy='36.39'%20r='0.99'%20fill='%23eaddfb'/%3E%3Ccircle%20cx='37.12'%20cy='36.5'%20r='0.98'%20fill='%23efdcfc'/%3E%3Ccircle%20cx='40.48'%20cy='36.69'%20r='0.82'%20fill='%23f4e8f7'/%3E%3Ccircle%20cx='43.13'%20cy='36.36'%20r='0.67'%20fill='%23f7e8f6'/%3E%3Ccircle%20cx='46.6'%20cy='37.0'%20r='0.84'%20fill='%23e8e1fc'/%3E%3Ccircle%20cx='49.86'%20cy='37.16'%20r='0.7'%20fill='%23fcd9fc'/%3E%3Ccircle%20cx='53.29'%20cy='36.66'%20r='0.94'%20fill='%23fcd6dd'/%3E%3Ccircle%20cx='56.24'%20cy='37.18'%20r='0.95'%20fill='%23fcdbe0'/%3E%3Ccircle%20cx='59.17'%20cy='36.87'%20r='0.82'%20fill='%23f1f0a6'/%3E%3Ccircle%20cx='61.9'%20cy='37.09'%20r='0.86'%20fill='%23f7e9e8'/%3E%3Ccircle%20cx='65.52'%20cy='37.06'%20r='0.91'%20fill='%23bef6bd'/%3E%3Ccircle%20cx='69.08'%20cy='36.52'%20r='0.85'%20fill='%23f7eca1'/%3E%3Ccircle%20cx='71.91'%20cy='36.89'%20r='0.87'%20fill='%23f9d9c4'/%3E%3Ccircle%20cx='75.65'%20cy='36.34'%20r='0.72'%20fill='%23f7dccd'/%3E%3Ccircle%20cx='78.85'%20cy='36.71'%20r='0.64'%20fill='%23f5f7e8'/%3E%3Ccircle%20cx='81.61'%20cy='37.26'%20r='0.89'%20fill='%23ecf2b8'/%3E%3Ccircle%20cx='84.96'%20cy='36.85'%20r='0.59'%20fill='%23dff1af'/%3E%3Ccircle%20cx='88.43'%20cy='36.96'%20r='0.6'%20fill='%23e5f9bd'/%3E%3Ccircle%20cx='91.44'%20cy='36.9'%20r='0.55'%20fill='%23b0f2d2'/%3E%3Ccircle%20cx='1.38'%20cy='39.78'%20r='0.58'%20fill='%23e8f7f0'/%3E%3Ccircle%20cx='5.09'%20cy='40.07'%20r='0.57'%20fill='%23d8e6fd'/%3E%3Ccircle%20cx='11.68'%20cy='40.1'%20r='0.71'%20fill='%23c3f8f2'/%3E%3Ccircle%20cx='17.62'%20cy='40.15'%20r='0.7'%20fill='%23d9e4fa'/%3E%3Ccircle%20cx='20.34'%20cy='39.68'%20r='0.93'%20fill='%23e8e1f9'/%3E%3Ccircle%20cx='23.91'%20cy='40.44'%20r='0.93'%20fill='%23e4ddf9'/%3E%3Ccircle%20cx='27.13'%20cy='40.33'%20r='0.79'%20fill='%23e9defb'/%3E%3Ccircle%20cx='30.17'%20cy='39.99'%20r='0.92'%20fill='%23cde6f9'/%3E%3Ccircle%20cx='33.1'%20cy='40.26'%20r='0.84'%20fill='%23ecdafb'/%3E%3Ccircle%20cx='36.87'%20cy='39.66'%20r='0.88'%20fill='%23e3defa'/%3E%3Ccircle%20cx='39.66'%20cy='39.59'%20r='0.59'%20fill='%23f9d5e6'/%3E%3Ccircle%20cx='43.66'%20cy='39.94'%20r='0.76'%20fill='%23ece0f9'/%3E%3Ccircle%20cx='46.05'%20cy='40.25'%20r='0.72'%20fill='%23f0e8f7'/%3E%3Ccircle%20cx='56.45'%20cy='39.93'%20r='0.77'%20fill='%23fdd8e1'/%3E%3Ccircle%20cx='59.15'%20cy='39.95'%20r='0.58'%20fill='%23f9dde9'/%3E%3Ccircle%20cx='62.64'%20cy='39.61'%20r='0.99'%20fill='%23f5f7e8'/%3E%3Ccircle%20cx='65.54'%20cy='40.45'%20r='0.62'%20fill='%23e8f4b1'/%3E%3Ccircle%20cx='69.29'%20cy='39.93'%20r='0.69'%20fill='%23f9d9d8'/%3E%3Ccircle%20cx='71.91'%20cy='40.25'%20r='0.72'%20fill='%23c8fab8'/%3E%3Ccircle%20cx='75.53'%20cy='40.23'%20r='0.88'%20fill='%23fce7b8'/%3E%3Ccircle%20cx='78.82'%20cy='40.39'%20r='0.57'%20fill='%23a7f6bd'/%3E%3Ccircle%20cx='81.75'%20cy='40.17'%20r='0.7'%20fill='%23e3f9b5'/%3E%3Ccircle%20cx='85.21'%20cy='40.26'%20r='0.55'%20fill='%23e8f6af'/%3E%3Ccircle%20cx='88.2'%20cy='40.31'%20r='0.81'%20fill='%2397f6f8'/%3E%3Ccircle%20cx='91.2'%20cy='39.52'%20r='0.63'%20fill='%23bdfcc3'/%3E%3Ccircle%20cx='94.2'%20cy='39.55'%20r='0.7'%20fill='%23caf8b5'/%3E%3Ccircle%20cx='1.8'%20cy='43.33'%20r='0.7'%20fill='%23a6f5d9'/%3E%3Ccircle%20cx='5.03'%20cy='42.93'%20r='0.57'%20fill='%23b5f5c2'/%3E%3Ccircle%20cx='7.58'%20cy='43.61'%20r='0.85'%20fill='%23cae4fc'/%3E%3Ccircle%20cx='11.67'%20cy='43.7'%20r='0.73'%20fill='%23e8f7f7'/%3E%3Ccircle%20cx='14.62'%20cy='43.7'%20r='0.71'%20fill='%23bbfcd3'/%3E%3Ccircle%20cx='17.29'%20cy='42.91'%20r='0.98'%20fill='%23e7defa'/%3E%3Ccircle%20cx='20.89'%20cy='43.57'%20r='0.91'%20fill='%23eae8f7'/%3E%3Ccircle%20cx='23.51'%20cy='43.02'%20r='0.76'%20fill='%23fddaf6'/%3E%3Ccircle%20cx='26.77'%20cy='42.74'%20r='0.71'%20fill='%23e3e2fd'/%3E%3Ccircle%20cx='30.38'%20cy='43.31'%20r='0.68'%20fill='%23f9dbe9'/%3E%3Ccircle%20cx='33.26'%20cy='43.54'%20r='0.58'%20fill='%23fdd6fa'/%3E%3Ccircle%20cx='36.41'%20cy='43.45'%20r='0.83'%20fill='%23f9d6f3'/%3E%3Ccircle%20cx='40.18'%20cy='43.09'%20r='0.92'%20fill='%23fad8fc'/%3E%3Ccircle%20cx='43.13'%20cy='43.56'%20r='0.59'%20fill='%23fad6ef'/%3E%3Ccircle%20cx='46.14'%20cy='43.64'%20r='0.57'%20fill='%23fcd5e3'/%3E%3Ccircle%20cx='49.42'%20cy='43.18'%20r='0.58'%20fill='%23fadce3'/%3E%3Ccircle%20cx='52.41'%20cy='43.7'%20r='0.61'%20fill='%23f7ebe8'/%3E%3Ccircle%20cx='55.88'%20cy='43.66'%20r='0.87'%20fill='%23fcd8db'/%3E%3Ccircle%20cx='58.98'%20cy='43.47'%20r='0.6'%20fill='%23fbdbe2'/%3E%3Ccircle%20cx='62.14'%20cy='43.17'%20r='0.93'%20fill='%23dcf8bc'/%3E%3Ccircle%20cx='65.91'%20cy='42.93'%20r='0.98'%20fill='%23f8d9c2'/%3E%3Ccircle%20cx='71.75'%20cy='42.84'%20r='0.76'%20fill='%23d3f8a5'/%3E%3Ccircle%20cx='75.4'%20cy='43.21'%20r='0.57'%20fill='%23f7f2b9'/%3E%3Ccircle%20cx='78.72'%20cy='43.66'%20r='0.72'%20fill='%23fcd9c5'/%3E%3Ccircle%20cx='84.32'%20cy='43.42'%20r='0.64'%20fill='%23c6f7bd'/%3E%3Ccircle%20cx='87.54'%20cy='43.42'%20r='0.88'%20fill='%23bcfbea'/%3E%3Ccircle%20cx='91.33'%20cy='42.75'%20r='0.72'%20fill='%23abf2e3'/%3E%3Ccircle%20cx='94.11'%20cy='43.29'%20r='0.87'%20fill='%23baf3b1'/%3E%3Ccircle%20cx='1.5'%20cy='46.72'%20r='0.81'%20fill='%23dbe5fb'/%3E%3Ccircle%20cx='4.43'%20cy='46.4'%20r='0.96'%20fill='%23e1dffd'/%3E%3Ccircle%20cx='8.28'%20cy='46.51'%20r='0.72'%20fill='%23dbe2fc'/%3E%3Ccircle%20cx='11.12'%20cy='46.05'%20r='0.74'%20fill='%23e2e4fb'/%3E%3Ccircle%20cx='14.32'%20cy='46.79'%20r='0.62'%20fill='%23e7defe'/%3E%3Ccircle%20cx='17.24'%20cy='46.36'%20r='0.59'%20fill='%23fbdafb'/%3E%3Ccircle%20cx='20.98'%20cy='46.48'%20r='0.92'%20fill='%23e6dcfd'/%3E%3Ccircle%20cx='23.97'%20cy='46.66'%20r='0.68'%20fill='%23eee8f7'/%3E%3Ccircle%20cx='30.63'%20cy='46.17'%20r='0.79'%20fill='%23f7e8f1'/%3E%3Ccircle%20cx='33.99'%20cy='46.11'%20r='0.71'%20fill='%23f9d7f8'/%3E%3Ccircle%20cx='36.58'%20cy='46.11'%20r='0.95'%20fill='%23fbd7fd'/%3E%3Ccircle%20cx='40.24'%20cy='46.62'%20r='0.8'%20fill='%23f6dcc7'/%3E%3Ccircle%20cx='43.24'%20cy='46.53'%20r='0.96'%20fill='%23f7e8ee'/%3E%3Ccircle%20cx='46.65'%20cy='46.6'%20r='0.59'%20fill='%23f9dadc'/%3E%3Ccircle%20cx='49.64'%20cy='46.21'%20r='0.64'%20fill='%23f7eee8'/%3E%3Ccircle%20cx='52.35'%20cy='45.99'%20r='0.56'%20fill='%23fddcca'/%3E%3Ccircle%20cx='55.9'%20cy='46.79'%20r='0.71'%20fill='%23eafca6'/%3E%3Ccircle%20cx='59.7'%20cy='46.06'%20r='0.89'%20fill='%23c9f49f'/%3E%3Ccircle%20cx='62.66'%20cy='46.77'%20r='0.84'%20fill='%23f1fbaf'/%3E%3Ccircle%20cx='65.36'%20cy='46.2'%20r='0.64'%20fill='%23f7f6e8'/%3E%3Ccircle%20cx='68.46'%20cy='46.74'%20r='0.57'%20fill='%23cef4be'/%3E%3Ccircle%20cx='71.95'%20cy='46.16'%20r='0.88'%20fill='%23def9b9'/%3E%3Ccircle%20cx='75.45'%20cy='46.14'%20r='0.72'%20fill='%23aff9b3'/%3E%3Ccircle%20cx='78.64'%20cy='46.57'%20r='0.74'%20fill='%23a9f5af'/%3E%3Ccircle%20cx='81.85'%20cy='46.23'%20r='0.75'%20fill='%23e8faa3'/%3E%3Ccircle%20cx='84.56'%20cy='45.9'%20r='0.64'%20fill='%23cce8fc'/%3E%3Ccircle%20cx='88.25'%20cy='46.06'%20r='0.82'%20fill='%23e8f7ec'/%3E%3Ccircle%20cx='91.58'%20cy='46.04'%20r='0.7'%20fill='%23fadfac'/%3E%3Ccircle%20cx='94.56'%20cy='46.89'%20r='0.84'%20fill='%2393fcde'/%3E%3Ccircle%20cx='1.77'%20cy='49.58'%20r='0.62'%20fill='%23d3e7fd'/%3E%3Ccircle%20cx='5.29'%20cy='49.76'%20r='0.92'%20fill='%23cee5f6'/%3E%3Ccircle%20cx='8.04'%20cy='49.37'%20r='0.55'%20fill='%23e8eff7'/%3E%3Ccircle%20cx='11.44'%20cy='49.57'%20r='0.73'%20fill='%23e8edf7'/%3E%3Ccircle%20cx='14.56'%20cy='49.97'%20r='0.61'%20fill='%23e8edf7'/%3E%3Ccircle%20cx='17.34'%20cy='49.5'%20r='0.74'%20fill='%23dbe5fa'/%3E%3Ccircle%20cx='23.89'%20cy='49.88'%20r='0.88'%20fill='%23f7e8f1'/%3E%3Ccircle%20cx='30.22'%20cy='49.15'%20r='0.76'%20fill='%23eed7fc'/%3E%3Ccircle%20cx='33.29'%20cy='49.95'%20r='0.67'%20fill='%23f5e0c4'/%3E%3Ccircle%20cx='36.48'%20cy='49.22'%20r='0.85'%20fill='%23f6e8f7'/%3E%3Ccircle%20cx='40.23'%20cy='50.02'%20r='0.92'%20fill='%23fadbfd'/%3E%3Ccircle%20cx='43.33'%20cy='49.76'%20r='0.9'%20fill='%23d7fbbb'/%3E%3Ccircle%20cx='45.93'%20cy='49.41'%20r='0.76'%20fill='%23f9dddb'/%3E%3Ccircle%20cx='49.92'%20cy='49.45'%20r='0.61'%20fill='%23fddee5'/%3E%3Ccircle%20cx='53.25'%20cy='49.68'%20r='0.99'%20fill='%23f9d9cf'/%3E%3Ccircle%20cx='56.29'%20cy='49.29'%20r='0.98'%20fill='%23fcd6d6'/%3E%3Ccircle%20cx='59.31'%20cy='49.57'%20r='0.73'%20fill='%23bef7be'/%3E%3Ccircle%20cx='62.57'%20cy='49.89'%20r='0.79'%20fill='%23fadbda'/%3E%3Ccircle%20cx='65.77'%20cy='49.31'%20r='0.91'%20fill='%23f8dfc6'/%3E%3Ccircle%20cx='68.78'%20cy='49.68'%20r='0.82'%20fill='%23fbe6c4'/%3E%3Ccircle%20cx='72.47'%20cy='49.14'%20r='0.78'%20fill='%23f6dcb6'/%3E%3Ccircle%20cx='75.09'%20cy='49.71'%20r='0.88'%20fill='%23e8f7ea'/%3E%3Ccircle%20cx='78.81'%20cy='49.6'%20r='0.78'%20fill='%23c1f5de'/%3E%3Ccircle%20cx='81.58'%20cy='49.12'%20r='0.96'%20fill='%23f7f69a'/%3E%3Ccircle%20cx='84.6'%20cy='49.32'%20r='0.95'%20fill='%23ebf7e8'/%3E%3Ccircle%20cx='87.58'%20cy='49.3'%20r='0.98'%20fill='%23bef9cb'/%3E%3Ccircle%20cx='91.35'%20cy='49.38'%20r='0.9'%20fill='%23c3fbd2'/%3E%3Ccircle%20cx='94.23'%20cy='49.48'%20r='0.68'%20fill='%23aeebf2'/%3E%3Ccircle%20cx='1.83'%20cy='52.82'%20r='0.56'%20fill='%23a0f2fb'/%3E%3Ccircle%20cx='4.54'%20cy='52.93'%20r='0.8'%20fill='%23b4fafb'/%3E%3Ccircle%20cx='8.06'%20cy='53.28'%20r='0.75'%20fill='%23e8f6f7'/%3E%3Ccircle%20cx='11.2'%20cy='53.03'%20r='0.74'%20fill='%23d5e6f8'/%3E%3Ccircle%20cx='14.04'%20cy='52.56'%20r='0.67'%20fill='%23c9e3fb'/%3E%3Ccircle%20cx='17.51'%20cy='52.36'%20r='0.8'%20fill='%23f9dbf3'/%3E%3Ccircle%20cx='21.19'%20cy='52.54'%20r='0.99'%20fill='%23e0ddfb'/%3E%3Ccircle%20cx='23.84'%20cy='52.37'%20r='0.89'%20fill='%23f9d5f6'/%3E%3Ccircle%20cx='26.84'%20cy='52.41'%20r='0.65'%20fill='%23fddaf2'/%3E%3Ccircle%20cx='29.93'%20cy='53.03'%20r='1.0'%20fill='%23fdd4f2'/%3E%3Ccircle%20cx='33.9'%20cy='52.71'%20r='0.57'%20fill='%23fbd7e0'/%3E%3Ccircle%20cx='36.61'%20cy='53.29'%20r='0.56'%20fill='%23fcd7eb'/%3E%3Ccircle%20cx='40.29'%20cy='53.05'%20r='0.75'%20fill='%23fad8d0'/%3E%3Ccircle%20cx='43.47'%20cy='52.75'%20r='0.65'%20fill='%23fbdee8'/%3E%3Ccircle%20cx='46.44'%20cy='52.84'%20r='0.73'%20fill='%23f8d9f4'/%3E%3Ccircle%20cx='49.35'%20cy='52.81'%20r='0.85'%20fill='%23ebf5a8'/%3E%3Ccircle%20cx='52.71'%20cy='53.2'%20r='0.58'%20fill='%23fcd9c2'/%3E%3Ccircle%20cx='55.54'%20cy='52.91'%20r='0.63'%20fill='%23f6dcb0'/%3E%3Ccircle%20cx='59.0'%20cy='52.92'%20r='0.77'%20fill='%23fddcda'/%3E%3Ccircle%20cx='61.92'%20cy='52.32'%20r='0.61'%20fill='%23f1f7e8'/%3E%3Ccircle%20cx='65.5'%20cy='53.09'%20r='0.91'%20fill='%23e9f7e8'/%3E%3Ccircle%20cx='69.28'%20cy='52.79'%20r='0.65'%20fill='%23bff698'/%3E%3Ccircle%20cx='71.59'%20cy='52.39'%20r='0.81'%20fill='%239ff5b0'/%3E%3Ccircle%20cx='74.81'%20cy='52.3'%20r='0.92'%20fill='%23a7efc4'/%3E%3Ccircle%20cx='77.91'%20cy='52.84'%20r='0.67'%20fill='%23d2e6fa'/%3E%3Ccircle%20cx='81.5'%20cy='52.97'%20r='0.9'%20fill='%2399fbf1'/%3E%3Ccircle%20cx='85.04'%20cy='52.44'%20r='0.62'%20fill='%23b8f4eb'/%3E%3Ccircle%20cx='88.33'%20cy='53.09'%20r='0.63'%20fill='%23d0e6fa'/%3E%3Ccircle%20cx='91.57'%20cy='52.53'%20r='0.93'%20fill='%23adf9ef'/%3E%3Ccircle%20cx='94.79'%20cy='53.16'%20r='0.69'%20fill='%23a5faf3'/%3E%3Ccircle%20cx='1.46'%20cy='55.61'%20r='0.7'%20fill='%23e8e8f7'/%3E%3Ccircle%20cx='5.15'%20cy='55.86'%20r='0.75'%20fill='%23e8f2f7'/%3E%3Ccircle%20cx='8.23'%20cy='55.85'%20r='0.89'%20fill='%23e8f1f7'/%3E%3Ccircle%20cx='11.51'%20cy='56.1'%20r='0.98'%20fill='%23f7e8f7'/%3E%3Ccircle%20cx='14.83'%20cy='55.57'%20r='0.6'%20fill='%23f1e8f7'/%3E%3Ccircle%20cx='17.86'%20cy='55.94'%20r='0.78'%20fill='%23d2e5fb'/%3E%3Ccircle%20cx='20.56'%20cy='56.07'%20r='0.96'%20fill='%23f3defa'/%3E%3Ccircle%20cx='24.23'%20cy='56.34'%20r='0.72'%20fill='%23f6dcf9'/%3E%3Ccircle%20cx='27.04'%20cy='56.24'%20r='0.76'%20fill='%23fad5f8'/%3E%3Ccircle%20cx='30.19'%20cy='55.81'%20r='0.65'%20fill='%23e4ddfb'/%3E%3Ccircle%20cx='33.64'%20cy='55.66'%20r='0.62'%20fill='%23fcd5ea'/%3E%3Ccircle%20cx='37.04'%20cy='55.62'%20r='0.97'%20fill='%23fcd7e7'/%3E%3Ccircle%20cx='39.87'%20cy='55.54'%20r='0.93'%20fill='%23fbdacf'/%3E%3Ccircle%20cx='43.25'%20cy='55.75'%20r='0.55'%20fill='%23f7dbd0'/%3E%3Ccircle%20cx='46.84'%20cy='55.6'%20r='0.65'%20fill='%23fddaee'/%3E%3Ccircle%20cx='49.65'%20cy='55.95'%20r='0.71'%20fill='%23f6e2a0'/%3E%3Ccircle%20cx='52.55'%20cy='55.84'%20r='0.79'%20fill='%23f3f6c8'/%3E%3Ccircle%20cx='56.12'%20cy='55.64'%20r='0.74'%20fill='%23f8faa6'/%3E%3Ccircle%20cx='59.24'%20cy='55.85'%20r='0.85'%20fill='%23f1f7e8'/%3E%3Ccircle%20cx='62.46'%20cy='56.05'%20r='0.99'%20fill='%23d0f8bc'/%3E%3Ccircle%20cx='65.45'%20cy='55.85'%20r='0.76'%20fill='%23f2f7e8'/%3E%3Ccircle%20cx='69.16'%20cy='55.89'%20r='0.66'%20fill='%23b3f9af'/%3E%3Ccircle%20cx='71.69'%20cy='55.95'%20r='0.65'%20fill='%23ebf7e8'/%3E%3Ccircle%20cx='74.95'%20cy='56.28'%20r='0.76'%20fill='%23bef4cb'/%3E%3Ccircle%20cx='78.1'%20cy='56.05'%20r='0.98'%20fill='%23efe9a2'/%3E%3Ccircle%20cx='81.44'%20cy='55.79'%20r='0.99'%20fill='%23edf7e8'/%3E%3Ccircle%20cx='84.7'%20cy='56.46'%20r='0.97'%20fill='%23c1e9f7'/%3E%3Ccircle%20cx='88.34'%20cy='55.92'%20r='0.8'%20fill='%23e8f7f1'/%3E%3Ccircle%20cx='90.81'%20cy='55.68'%20r='0.56'%20fill='%23e8f7f7'/%3E%3Ccircle%20cx='93.97'%20cy='56.4'%20r='0.64'%20fill='%23dae5f9'/%3E%3Ccircle%20cx='1.55'%20cy='59.01'%20r='0.74'%20fill='%23e8dafa'/%3E%3Ccircle%20cx='4.5'%20cy='59.66'%20r='0.92'%20fill='%23bde8f9'/%3E%3Ccircle%20cx='7.95'%20cy='59.48'%20r='0.82'%20fill='%23e9d9f9'/%3E%3Ccircle%20cx='11.08'%20cy='59.19'%20r='0.76'%20fill='%23e6e2fd'/%3E%3Ccircle%20cx='14.83'%20cy='59.67'%20r='0.92'%20fill='%23fddddf'/%3E%3Ccircle%20cx='17.84'%20cy='59.44'%20r='0.87'%20fill='%23fbe0e1'/%3E%3Ccircle%20cx='20.75'%20cy='59.64'%20r='0.75'%20fill='%23ece0fc'/%3E%3Ccircle%20cx='24.42'%20cy='58.88'%20r='0.78'%20fill='%23fad8f0'/%3E%3Ccircle%20cx='27.15'%20cy='59.38'%20r='0.67'%20fill='%23fcddea'/%3E%3Ccircle%20cx='30.27'%20cy='58.71'%20r='0.93'%20fill='%23f7e8f3'/%3E%3Ccircle%20cx='33.42'%20cy='59.15'%20r='0.73'%20fill='%23f3e7b4'/%3E%3Ccircle%20cx='37.18'%20cy='58.72'%20r='0.79'%20fill='%23f8dbb6'/%3E%3Ccircle%20cx='39.53'%20cy='59.24'%20r='0.65'%20fill='%23f2e79c'/%3E%3Ccircle%20cx='43.18'%20cy='59.48'%20r='0.97'%20fill='%23fad9dd'/%3E%3Ccircle%20cx='46.38'%20cy='58.92'%20r='0.75'%20fill='%23fbdada'/%3E%3Ccircle%20cx='50.06'%20cy='59.44'%20r='0.66'%20fill='%23f7dfca'/%3E%3Ccircle%20cx='58.96'%20cy='59.54'%20r='0.94'%20fill='%23bff1a3'/%3E%3Ccircle%20cx='62.16'%20cy='59.28'%20r='0.86'%20fill='%23f8dbc0'/%3E%3Ccircle%20cx='65.98'%20cy='59.56'%20r='0.66'%20fill='%23b4f3ec'/%3E%3Ccircle%20cx='68.71'%20cy='58.73'%20r='0.72'%20fill='%239bf6a8'/%3E%3Ccircle%20cx='71.93'%20cy='59.16'%20r='0.92'%20fill='%23b0fc9a'/%3E%3Ccircle%20cx='75.48'%20cy='59.15'%20r='0.58'%20fill='%23caf6c0'/%3E%3Ccircle%20cx='77.95'%20cy='59.1'%20r='0.75'%20fill='%23d5f6b6'/%3E%3Ccircle%20cx='84.75'%20cy='59.36'%20r='0.67'%20fill='%23e8f7ee'/%3E%3Ccircle%20cx='87.6'%20cy='58.96'%20r='0.73'%20fill='%23a7f0f0'/%3E%3Ccircle%20cx='91.15'%20cy='59.38'%20r='0.95'%20fill='%23bae7fa'/%3E%3Ccircle%20cx='93.98'%20cy='59.36'%20r='0.6'%20fill='%23befcf1'/%3E%3Ccircle%20cx='1.5'%20cy='62.15'%20r='0.94'%20fill='%23d1e0f9'/%3E%3Ccircle%20cx='4.39'%20cy='62.14'%20r='0.55'%20fill='%23fad6fa'/%3E%3Ccircle%20cx='7.66'%20cy='62.41'%20r='0.87'%20fill='%23eae4fe'/%3E%3Ccircle%20cx='10.79'%20cy='62.68'%20r='0.96'%20fill='%23f7e8f4'/%3E%3Ccircle%20cx='14.31'%20cy='62.89'%20r='0.75'%20fill='%23dbdef8'/%3E%3Ccircle%20cx='18.05'%20cy='62.88'%20r='0.72'%20fill='%23fdd5f6'/%3E%3Ccircle%20cx='20.49'%20cy='62.74'%20r='0.98'%20fill='%23f7dbc2'/%3E%3Ccircle%20cx='23.52'%20cy='62.82'%20r='0.93'%20fill='%23f6d6fa'/%3E%3Ccircle%20cx='30.15'%20cy='62.48'%20r='0.74'%20fill='%23fbd8df'/%3E%3Ccircle%20cx='33.78'%20cy='62.1'%20r='0.83'%20fill='%23fbddbb'/%3E%3Ccircle%20cx='36.58'%20cy='62.16'%20r='0.58'%20fill='%23fcd6e3'/%3E%3Ccircle%20cx='39.98'%20cy='62.49'%20r='0.96'%20fill='%23ccf997'/%3E%3Ccircle%20cx='43.35'%20cy='62.69'%20r='0.94'%20fill='%23ecf4a7'/%3E%3Ccircle%20cx='49.34'%20cy='62.79'%20r='0.82'%20fill='%23cdf6ac'/%3E%3Ccircle%20cx='53.0'%20cy='62.63'%20r='0.81'%20fill='%23f3f7e8'/%3E%3Ccircle%20cx='55.85'%20cy='62.16'%20r='1.0'%20fill='%23c0fbab'/%3E%3Ccircle%20cx='59.33'%20cy='62.61'%20r='0.74'%20fill='%23f5e8c6'/%3E%3Ccircle%20cx='62.85'%20cy='62.48'%20r='0.99'%20fill='%23e6f4a4'/%3E%3Ccircle%20cx='65.49'%20cy='62.49'%20r='0.55'%20fill='%23bdf7a2'/%3E%3Ccircle%20cx='68.82'%20cy='62.22'%20r='0.85'%20fill='%23c1f9be'/%3E%3Ccircle%20cx='71.85'%20cy='62.61'%20r='0.92'%20fill='%23a7f99c'/%3E%3Ccircle%20cx='75.28'%20cy='62.85'%20r='0.71'%20fill='%23b4f5ec'/%3E%3Ccircle%20cx='78.2'%20cy='62.01'%20r='0.65'%20fill='%23e8f4f7'/%3E%3Ccircle%20cx='81.41'%20cy='62.29'%20r='0.89'%20fill='%23c6f7eb'/%3E%3Ccircle%20cx='84.33'%20cy='62.33'%20r='0.87'%20fill='%23e5e4fb'/%3E%3Ccircle%20cx='87.55'%20cy='62.61'%20r='0.97'%20fill='%23e8e9f7'/%3E%3Ccircle%20cx='91.66'%20cy='61.97'%20r='0.58'%20fill='%23f9d5fb'/%3E%3Ccircle%20cx='1.87'%20cy='65.72'%20r='0.65'%20fill='%23e8eff7'/%3E%3Ccircle%20cx='5.09'%20cy='65.11'%20r='0.92'%20fill='%23fad5fd'/%3E%3Ccircle%20cx='8.18'%20cy='66.1'%20r='0.64'%20fill='%23ece8f7'/%3E%3Ccircle%20cx='11.65'%20cy='65.6'%20r='0.57'%20fill='%23e7ddfd'/%3E%3Ccircle%20cx='14.32'%20cy='66.04'%20r='0.6'%20fill='%23f3d7fd'/%3E%3Ccircle%20cx='17.77'%20cy='65.81'%20r='0.57'%20fill='%23fcd4f5'/%3E%3Ccircle%20cx='21.12'%20cy='65.59'%20r='0.6'%20fill='%23fad8e3'/%3E%3Ccircle%20cx='24.4'%20cy='65.55'%20r='0.91'%20fill='%23f6d9f9'/%3E%3Ccircle%20cx='27.43'%20cy='65.59'%20r='0.91'%20fill='%23f9d7e3'/%3E%3Ccircle%20cx='30.86'%20cy='66.04'%20r='0.98'%20fill='%23f8dfb2'/%3E%3Ccircle%20cx='34.07'%20cy='65.15'%20r='0.93'%20fill='%23faddd8'/%3E%3Ccircle%20cx='37.1'%20cy='65.54'%20r='0.98'%20fill='%23f8dbca'/%3E%3Ccircle%20cx='39.77'%20cy='65.24'%20r='0.9'%20fill='%23f7f1e8'/%3E%3Ccircle%20cx='43.38'%20cy='65.27'%20r='0.92'%20fill='%23f7f7e8'/%3E%3Ccircle%20cx='46.32'%20cy='65.99'%20r='0.61'%20fill='%23f2f7c0'/%3E%3Ccircle%20cx='49.87'%20cy='65.59'%20r='0.65'%20fill='%23e0f69f'/%3E%3Ccircle%20cx='52.77'%20cy='65.15'%20r='0.71'%20fill='%23f4f7e8'/%3E%3Ccircle%20cx='55.54'%20cy='65.97'%20r='0.81'%20fill='%23caf1ae'/%3E%3Ccircle%20cx='58.76'%20cy='65.64'%20r='0.82'%20fill='%23d4f9b9'/%3E%3Ccircle%20cx='62.22'%20cy='65.71'%20r='0.71'%20fill='%23bcf5cb'/%3E%3Ccircle%20cx='65.87'%20cy='65.83'%20r='0.76'%20fill='%23c4f4fc'/%3E%3Ccircle%20cx='68.44'%20cy='65.4'%20r='0.66'%20fill='%23bff7b9'/%3E%3Ccircle%20cx='72.08'%20cy='65.93'%20r='0.7'%20fill='%23a4f6d7'/%3E%3Ccircle%20cx='74.94'%20cy='65.59'%20r='0.81'%20fill='%23b9f3da'/%3E%3Ccircle%20cx='78.39'%20cy='65.56'%20r='0.71'%20fill='%23e8f7f6'/%3E%3Ccircle%20cx='81.21'%20cy='65.38'%20r='0.6'%20fill='%23aef6e5'/%3E%3Ccircle%20cx='84.62'%20cy='65.34'%20r='0.74'%20fill='%23cce5f8'/%3E%3Ccircle%20cx='87.6'%20cy='65.91'%20r='0.7'%20fill='%23e8e3fb'/%3E%3Ccircle%20cx='91.16'%20cy='65.72'%20r='0.99'%20fill='%23d0e1f9'/%3E%3Ccircle%20cx='93.92'%20cy='66.02'%20r='0.76'%20fill='%23e6dbfc'/%3E%3Ccircle%20cx='1.75'%20cy='68.41'%20r='0.9'%20fill='%23fbdbec'/%3E%3Ccircle%20cx='4.39'%20cy='68.31'%20r='0.97'%20fill='%23fddbf4'/%3E%3Ccircle%20cx='7.55'%20cy='69.16'%20r='0.95'%20fill='%23d6defb'/%3E%3Ccircle%20cx='10.87'%20cy='68.67'%20r='0.98'%20fill='%23fcdbf4'/%3E%3Ccircle%20cx='14.23'%20cy='68.98'%20r='0.93'%20fill='%23f9d8f1'/%3E%3Ccircle%20cx='17.73'%20cy='69.27'%20r='0.9'%20fill='%23e6daf9'/%3E%3Ccircle%20cx='20.33'%20cy='68.96'%20r='0.94'%20fill='%23f7e8f7'/%3E%3Ccircle%20cx='24.46'%20cy='68.4'%20r='0.77'%20fill='%23f9d9d7'/%3E%3Ccircle%20cx='27.4'%20cy='69.22'%20r='0.69'%20fill='%23fdd5f2'/%3E%3Ccircle%20cx='30.56'%20cy='68.73'%20r='0.62'%20fill='%23fdd7d7'/%3E%3Ccircle%20cx='33.15'%20cy='68.67'%20r='0.61'%20fill='%23e0f89a'/%3E%3Ccircle%20cx='36.99'%20cy='68.65'%20r='0.58'%20fill='%23fad8e5'/%3E%3Ccircle%20cx='39.65'%20cy='68.9'%20r='0.67'%20fill='%2399fb98'/%3E%3Ccircle%20cx='43.15'%20cy='68.53'%20r='0.79'%20fill='%23a8f9ab'/%3E%3Ccircle%20cx='49.97'%20cy='68.92'%20r='0.78'%20fill='%23dff7be'/%3E%3Ccircle%20cx='52.63'%20cy='68.97'%20r='0.97'%20fill='%23fcdcc7'/%3E%3Ccircle%20cx='56.05'%20cy='69.03'%20r='0.55'%20fill='%23e8f7ef'/%3E%3Ccircle%20cx='59.29'%20cy='68.38'%20r='0.74'%20fill='%23f4f7e8'/%3E%3Ccircle%20cx='62.58'%20cy='69.2'%20r='0.75'%20fill='%23d4e0fd'/%3E%3Ccircle%20cx='65.57'%20cy='68.34'%20r='0.69'%20fill='%23ecf7e8'/%3E%3Ccircle%20cx='69.07'%20cy='68.96'%20r='0.68'%20fill='%23b9f5b2'/%3E%3Ccircle%20cx='72.24'%20cy='68.47'%20r='0.65'%20fill='%23bef8c6'/%3E%3Ccircle%20cx='74.76'%20cy='69.23'%20r='0.8'%20fill='%23cee4fb'/%3E%3Ccircle%20cx='78.0'%20cy='68.64'%20r='0.95'%20fill='%23d2e4fb'/%3E%3Ccircle%20cx='81.61'%20cy='68.54'%20r='0.81'%20fill='%23e8e9f7'/%3E%3Ccircle%20cx='85.18'%20cy='68.78'%20r='0.78'%20fill='%23e8f7ea'/%3E%3Ccircle%20cx='87.62'%20cy='68.46'%20r='0.77'%20fill='%23dfe5fc'/%3E%3Ccircle%20cx='94.67'%20cy='68.61'%20r='0.95'%20fill='%239debfb'/%3E%3Ccircle%20cx='1.43'%20cy='72.32'%20r='0.66'%20fill='%23ecdffa'/%3E%3Ccircle%20cx='5.24'%20cy='71.78'%20r='0.56'%20fill='%23ebdffd'/%3E%3Ccircle%20cx='8.43'%20cy='72.42'%20r='0.79'%20fill='%23f0ddfd'/%3E%3Ccircle%20cx='10.73'%20cy='72.38'%20r='0.9'%20fill='%23fcdbe7'/%3E%3Ccircle%20cx='14.62'%20cy='71.79'%20r='0.81'%20fill='%23fbdfd8'/%3E%3Ccircle%20cx='18.06'%20cy='72.4'%20r='0.68'%20fill='%23f5ddc9'/%3E%3Ccircle%20cx='24.12'%20cy='72.31'%20r='0.9'%20fill='%23f8d8e4'/%3E%3Ccircle%20cx='27.45'%20cy='72.26'%20r='0.99'%20fill='%23fdd9e6'/%3E%3Ccircle%20cx='33.38'%20cy='71.98'%20r='0.6'%20fill='%23faddd7'/%3E%3Ccircle%20cx='36.83'%20cy='72.25'%20r='0.75'%20fill='%23d0f5bf'/%3E%3Ccircle%20cx='40.22'%20cy='71.81'%20r='0.74'%20fill='%23fcdad0'/%3E%3Ccircle%20cx='42.86'%20cy='72.15'%20r='0.61'%20fill='%23dbf4a2'/%3E%3Ccircle%20cx='45.96'%20cy='72.39'%20r='0.71'%20fill='%23def7c1'/%3E%3Ccircle%20cx='49.45'%20cy='72.27'%20r='0.98'%20fill='%23effcad'/%3E%3Ccircle%20cx='52.99'%20cy='72.19'%20r='0.88'%20fill='%2397fad1'/%3E%3Ccircle%20cx='56.41'%20cy='71.58'%20r='0.65'%20fill='%23e8f3f7'/%3E%3Ccircle%20cx='59.09'%20cy='72.21'%20r='0.56'%20fill='%23f0f7e8'/%3E%3Ccircle%20cx='62.53'%20cy='72.24'%20r='0.83'%20fill='%239ff6b0'/%3E%3Ccircle%20cx='68.36'%20cy='71.84'%20r='0.67'%20fill='%23c2fafd'/%3E%3Ccircle%20cx='72.33'%20cy='71.7'%20r='0.6'%20fill='%23c5e4f9'/%3E%3Ccircle%20cx='75.66'%20cy='71.5'%20r='0.71'%20fill='%23c6e4f7'/%3E%3Ccircle%20cx='78.4'%20cy='71.89'%20r='0.6'%20fill='%23d5e6fb'/%3E%3Ccircle%20cx='81.33'%20cy='71.66'%20r='0.85'%20fill='%23e0e2fd'/%3E%3Ccircle%20cx='84.79'%20cy='71.56'%20r='0.77'%20fill='%23d2e3fd'/%3E%3Ccircle%20cx='88.43'%20cy='71.69'%20r='0.94'%20fill='%23dee2fb'/%3E%3Ccircle%20cx='91.1'%20cy='71.71'%20r='0.68'%20fill='%23e1e2fd'/%3E%3Ccircle%20cx='94.73'%20cy='72.31'%20r='0.65'%20fill='%23fddaee'/%3E%3Ccircle%20cx='2.01'%20cy='75.09'%20r='0.56'%20fill='%23f9d9e2'/%3E%3Ccircle%20cx='4.99'%20cy='75.56'%20r='0.9'%20fill='%23f7e8ea'/%3E%3Ccircle%20cx='7.88'%20cy='75.2'%20r='0.75'%20fill='%23f0e8f7'/%3E%3Ccircle%20cx='11.33'%20cy='75.26'%20r='0.81'%20fill='%23f7e8f3'/%3E%3Ccircle%20cx='14.34'%20cy='75.23'%20r='0.75'%20fill='%23fbd6e0'/%3E%3Ccircle%20cx='17.83'%20cy='74.8'%20r='0.97'%20fill='%23f7e8e8'/%3E%3Ccircle%20cx='20.37'%20cy='75.46'%20r='0.91'%20fill='%23f5eec4'/%3E%3Ccircle%20cx='29.94'%20cy='75.62'%20r='0.69'%20fill='%23fadde2'/%3E%3Ccircle%20cx='33.12'%20cy='75.22'%20r='0.96'%20fill='%23f9dcab'/%3E%3Ccircle%20cx='37.16'%20cy='75.41'%20r='0.97'%20fill='%23bff5d4'/%3E%3Ccircle%20cx='39.77'%20cy='74.85'%20r='1.0'%20fill='%23d4fbbf'/%3E%3Ccircle%20cx='42.71'%20cy='75.04'%20r='0.68'%20fill='%23d0f5b8'/%3E%3Ccircle%20cx='46.51'%20cy='74.99'%20r='0.84'%20fill='%23d4f6a7'/%3E%3Ccircle%20cx='49.42'%20cy='74.92'%20r='0.91'%20fill='%23e4f4a0'/%3E%3Ccircle%20cx='53.14'%20cy='75.62'%20r='0.87'%20fill='%23c8faba'/%3E%3Ccircle%20cx='56.05'%20cy='75.07'%20r='0.69'%20fill='%23c2f3bd'/%3E%3Ccircle%20cx='59.58'%20cy='75.37'%20r='0.94'%20fill='%23a3edfb'/%3E%3Ccircle%20cx='62.76'%20cy='75.0'%20r='0.66'%20fill='%23e7f8c7'/%3E%3Ccircle%20cx='65.68'%20cy='75.48'%20r='0.61'%20fill='%23bbeaf4'/%3E%3Ccircle%20cx='69.09'%20cy='74.89'%20r='0.92'%20fill='%23c2faf6'/%3E%3Ccircle%20cx='71.86'%20cy='75.03'%20r='0.59'%20fill='%239decf2'/%3E%3Ccircle%20cx='74.88'%20cy='75.22'%20r='0.69'%20fill='%23c0eff9'/%3E%3Ccircle%20cx='78.36'%20cy='75.67'%20r='0.62'%20fill='%23e9e8f7'/%3E%3Ccircle%20cx='81.24'%20cy='75.62'%20r='0.96'%20fill='%23e8ebf7'/%3E%3Ccircle%20cx='84.39'%20cy='75.49'%20r='0.66'%20fill='%23c4e5fd'/%3E%3Ccircle%20cx='87.85'%20cy='75.2'%20r='0.65'%20fill='%23dadff9'/%3E%3Ccircle%20cx='91.17'%20cy='75.34'%20r='0.93'%20fill='%23fdd9ee'/%3E%3Ccircle%20cx='93.91'%20cy='75.16'%20r='0.75'%20fill='%23e9e8f7'/%3E%3Ccircle%20cx='1.43'%20cy='78.44'%20r='0.65'%20fill='%23fddcda'/%3E%3Ccircle%20cx='4.49'%20cy='78.0'%20r='0.64'%20fill='%23fadbf2'/%3E%3Ccircle%20cx='7.65'%20cy='78.26'%20r='0.94'%20fill='%23fad7fa'/%3E%3Ccircle%20cx='10.85'%20cy='78.07'%20r='0.85'%20fill='%23f3e8f7'/%3E%3Ccircle%20cx='14.15'%20cy='78.48'%20r='0.89'%20fill='%23fbdee1'/%3E%3Ccircle%20cx='17.37'%20cy='78.29'%20r='0.74'%20fill='%23e0defd'/%3E%3Ccircle%20cx='20.56'%20cy='77.94'%20r='0.78'%20fill='%23f8d9d7'/%3E%3Ccircle%20cx='24.07'%20cy='78.0'%20r='0.86'%20fill='%23f7f3e8'/%3E%3Ccircle%20cx='26.73'%20cy='78.14'%20r='0.93'%20fill='%23f8d8e8'/%3E%3Ccircle%20cx='30.16'%20cy='78.17'%20r='0.8'%20fill='%23f7f2e8'/%3E%3Ccircle%20cx='33.38'%20cy='78.43'%20r='0.77'%20fill='%23b4fcb8'/%3E%3Ccircle%20cx='36.57'%20cy='77.96'%20r='0.65'%20fill='%23ccfdc2'/%3E%3Ccircle%20cx='39.62'%20cy='78.85'%20r='0.86'%20fill='%23c5f9c4'/%3E%3Ccircle%20cx='42.71'%20cy='78.74'%20r='0.84'%20fill='%23a6f7b4'/%3E%3Ccircle%20cx='46.84'%20cy='78.29'%20r='0.68'%20fill='%23f9f89b'/%3E%3Ccircle%20cx='49.89'%20cy='78.25'%20r='0.72'%20fill='%23b6fca9'/%3E%3Ccircle%20cx='52.75'%20cy='78.62'%20r='0.76'%20fill='%23a9fba9'/%3E%3Ccircle%20cx='56.09'%20cy='78.51'%20r='0.67'%20fill='%23adfbd6'/%3E%3Ccircle%20cx='59.19'%20cy='78.85'%20r='0.74'%20fill='%23aff9d4'/%3E%3Ccircle%20cx='62.14'%20cy='78.82'%20r='0.9'%20fill='%23eae2fd'/%3E%3Ccircle%20cx='65.39'%20cy='78.05'%20r='0.96'%20fill='%23e8ecf7'/%3E%3Ccircle%20cx='72.35'%20cy='78.01'%20r='0.67'%20fill='%23e8ebf7'/%3E%3Ccircle%20cx='75.47'%20cy='77.99'%20r='0.72'%20fill='%23e3ddfb'/%3E%3Ccircle%20cx='78.83'%20cy='78.46'%20r='0.69'%20fill='%23e1e5fe'/%3E%3Ccircle%20cx='81.87'%20cy='78.18'%20r='0.65'%20fill='%239ef9c9'/%3E%3Ccircle%20cx='84.71'%20cy='78.0'%20r='0.9'%20fill='%23acf2df'/%3E%3Ccircle%20cx='88.29'%20cy='78.84'%20r='0.6'%20fill='%23dfdefa'/%3E%3Ccircle%20cx='91.29'%20cy='78.83'%20r='0.96'%20fill='%23efe8f7'/%3E%3Ccircle%20cx='94.1'%20cy='78.85'%20r='0.95'%20fill='%23e8eef7'/%3E%3Ccircle%20cx='1.58'%20cy='81.52'%20r='0.66'%20fill='%23eadafa'/%3E%3Ccircle%20cx='4.86'%20cy='82.03'%20r='0.87'%20fill='%23f7e8f5'/%3E%3Ccircle%20cx='7.89'%20cy='82.09'%20r='0.63'%20fill='%23fcdfe4'/%3E%3Ccircle%20cx='11.34'%20cy='81.7'%20r='0.75'%20fill='%23fcd8de'/%3E%3Ccircle%20cx='13.94'%20cy='81.22'%20r='0.72'%20fill='%23fcd3f4'/%3E%3Ccircle%20cx='18.08'%20cy='81.32'%20r='0.63'%20fill='%23f6dbc0'/%3E%3Ccircle%20cx='20.93'%20cy='82.01'%20r='0.69'%20fill='%23f5f7e8'/%3E%3Ccircle%20cx='24.14'%20cy='81.69'%20r='0.86'%20fill='%23fddccf'/%3E%3Ccircle%20cx='27.64'%20cy='81.73'%20r='0.58'%20fill='%23faf7c5'/%3E%3Ccircle%20cx='30.79'%20cy='81.85'%20r='0.76'%20fill='%23d9f4bd'/%3E%3Ccircle%20cx='33.22'%20cy='81.11'%20r='0.98'%20fill='%23f2f7e8'/%3E%3Ccircle%20cx='40.23'%20cy='81.61'%20r='0.95'%20fill='%23d3efa7'/%3E%3Ccircle%20cx='43.62'%20cy='82.07'%20r='0.67'%20fill='%23fbe592'/%3E%3Ccircle%20cx='46.15'%20cy='81.72'%20r='0.76'%20fill='%23a7f5dd'/%3E%3Ccircle%20cx='50.08'%20cy='81.78'%20r='0.96'%20fill='%23bcfcaa'/%3E%3Ccircle%20cx='52.66'%20cy='81.84'%20r='0.58'%20fill='%23bbfce6'/%3E%3Ccircle%20cx='55.77'%20cy='82.06'%20r='0.97'%20fill='%23c0e6fa'/%3E%3Ccircle%20cx='59.1'%20cy='81.27'%20r='0.66'%20fill='%23eef7e8'/%3E%3Ccircle%20cx='62.4'%20cy='81.44'%20r='0.67'%20fill='%23b0f9bb'/%3E%3Ccircle%20cx='65.54'%20cy='81.39'%20r='0.7'%20fill='%23b2f9e6'/%3E%3Ccircle%20cx='69.14'%20cy='81.51'%20r='0.6'%20fill='%23c3f7fc'/%3E%3Ccircle%20cx='71.52'%20cy='81.14'%20r='0.84'%20fill='%23c3e7f8'/%3E%3Ccircle%20cx='74.74'%20cy='81.35'%20r='0.94'%20fill='%23d9e0f8'/%3E%3Ccircle%20cx='78.1'%20cy='81.15'%20r='0.84'%20fill='%23eee8f7'/%3E%3Ccircle%20cx='82.05'%20cy='82.09'%20r='0.73'%20fill='%23dddcfc'/%3E%3Ccircle%20cx='84.33'%20cy='81.33'%20r='0.63'%20fill='%23fedeea'/%3E%3Ccircle%20cx='88.06'%20cy='81.71'%20r='0.73'%20fill='%23f9d5ee'/%3E%3Ccircle%20cx='91.54'%20cy='81.72'%20r='0.87'%20fill='%23f7e8f4'/%3E%3Ccircle%20cx='94.36'%20cy='81.77'%20r='0.88'%20fill='%23f7d6f5'/%3E%3Ccircle%20cx='1.74'%20cy='84.34'%20r='0.84'%20fill='%23f7e8ee'/%3E%3Ccircle%20cx='4.83'%20cy='84.81'%20r='0.98'%20fill='%23f9dbf1'/%3E%3Ccircle%20cx='8.45'%20cy='84.41'%20r='0.72'%20fill='%23fbd5f2'/%3E%3Ccircle%20cx='11.25'%20cy='85.08'%20r='0.93'%20fill='%23f7f0e8'/%3E%3Ccircle%20cx='13.93'%20cy='85.2'%20r='0.88'%20fill='%23f7f3e8'/%3E%3Ccircle%20cx='17.21'%20cy='84.78'%20r='0.74'%20fill='%23fdd7eb'/%3E%3Ccircle%20cx='21.03'%20cy='84.39'%20r='0.66'%20fill='%23f8e8c3'/%3E%3Ccircle%20cx='24.03'%20cy='84.64'%20r='0.76'%20fill='%23f2ddb8'/%3E%3Ccircle%20cx='27.66'%20cy='84.44'%20r='0.9'%20fill='%23faf2a9'/%3E%3Ccircle%20cx='30.83'%20cy='84.64'%20r='0.92'%20fill='%23f7e7b2'/%3E%3Ccircle%20cx='33.97'%20cy='84.64'%20r='0.96'%20fill='%23aff7fc'/%3E%3Ccircle%20cx='36.37'%20cy='84.99'%20r='0.73'%20fill='%23cdfba7'/%3E%3Ccircle%20cx='39.84'%20cy='85.21'%20r='0.76'%20fill='%23aafbd1'/%3E%3Ccircle%20cx='43.41'%20cy='85.25'%20r='0.98'%20fill='%23b7f3ca'/%3E%3Ccircle%20cx='46.54'%20cy='84.89'%20r='0.77'%20fill='%23a6f6a6'/%3E%3Ccircle%20cx='49.54'%20cy='85.07'%20r='0.76'%20fill='%23b5f8d2'/%3E%3Ccircle%20cx='52.54'%20cy='84.77'%20r='0.99'%20fill='%23e8f7ec'/%3E%3Ccircle%20cx='55.56'%20cy='84.9'%20r='0.67'%20fill='%239ff0cb'/%3E%3Ccircle%20cx='59.39'%20cy='85.06'%20r='0.71'%20fill='%23aceefa'/%3E%3Ccircle%20cx='62.74'%20cy='84.99'%20r='0.97'%20fill='%23d5e3fb'/%3E%3Ccircle%20cx='65.37'%20cy='84.62'%20r='0.7'%20fill='%23e3e3fb'/%3E%3Ccircle%20cx='68.53'%20cy='85.15'%20r='0.61'%20fill='%23cfe1fa'/%3E%3Ccircle%20cx='72.22'%20cy='85.24'%20r='0.84'%20fill='%23d0e1f9'/%3E%3Ccircle%20cx='75.55'%20cy='84.37'%20r='0.84'%20fill='%23c2e6fa'/%3E%3Ccircle%20cx='78.16'%20cy='84.33'%20r='0.95'%20fill='%23f0d7f8'/%3E%3Ccircle%20cx='81.52'%20cy='84.46'%20r='0.68'%20fill='%23f5e8f7'/%3E%3Ccircle%20cx='84.57'%20cy='84.77'%20r='0.97'%20fill='%23f4e8f7'/%3E%3Ccircle%20cx='91.23'%20cy='84.92'%20r='0.85'%20fill='%23f9d7ee'/%3E%3Ccircle%20cx='93.98'%20cy='84.36'%20r='0.66'%20fill='%23fddce8'/%3E%3Ccircle%20cx='1.53'%20cy='87.69'%20r='0.57'%20fill='%23f8dbc6'/%3E%3Ccircle%20cx='5.23'%20cy='88.16'%20r='0.69'%20fill='%23f7e9e8'/%3E%3Ccircle%20cx='8.37'%20cy='88.1'%20r='0.87'%20fill='%23fbdc98'/%3E%3Ccircle%20cx='11.7'%20cy='87.71'%20r='0.88'%20fill='%23fddae4'/%3E%3Ccircle%20cx='14.19'%20cy='87.85'%20r='0.96'%20fill='%23f2fcb5'/%3E%3Ccircle%20cx='18.04'%20cy='87.82'%20r='0.63'%20fill='%23f5f0c3'/%3E%3Ccircle%20cx='20.84'%20cy='88.09'%20r='0.58'%20fill='%23e9f7e8'/%3E%3Ccircle%20cx='24.24'%20cy='88.32'%20r='0.69'%20fill='%23f9dede'/%3E%3Ccircle%20cx='26.74'%20cy='88.08'%20r='0.73'%20fill='%23f9e697'/%3E%3Ccircle%20cx='33.71'%20cy='87.55'%20r='0.93'%20fill='%23c1f29e'/%3E%3Ccircle%20cx='36.34'%20cy='87.71'%20r='0.77'%20fill='%23b7f5d7'/%3E%3Ccircle%20cx='40.03'%20cy='88.34'%20r='0.72'%20fill='%23d1f5a6'/%3E%3Ccircle%20cx='42.72'%20cy='88.27'%20r='0.89'%20fill='%23b5f1a7'/%3E%3Ccircle%20cx='46.74'%20cy='88.22'%20r='0.97'%20fill='%23b6fae3'/%3E%3Ccircle%20cx='49.84'%20cy='87.63'%20r='0.78'%20fill='%239bf9f2'/%3E%3Ccircle%20cx='52.72'%20cy='87.73'%20r='1.0'%20fill='%23b3f3ef'/%3E%3Ccircle%20cx='56.38'%20cy='88.39'%20r='0.84'%20fill='%23e8f7f1'/%3E%3Ccircle%20cx='58.97'%20cy='87.98'%20r='0.87'%20fill='%23bafae0'/%3E%3Ccircle%20cx='62.0'%20cy='87.86'%20r='0.74'%20fill='%23d2e6f8'/%3E%3Ccircle%20cx='68.76'%20cy='87.93'%20r='1.0'%20fill='%23ebe0fd'/%3E%3Ccircle%20cx='72.21'%20cy='88.25'%20r='0.57'%20fill='%23eae0fc'/%3E%3Ccircle%20cx='74.88'%20cy='88.06'%20r='0.76'%20fill='%23d4e2fc'/%3E%3Ccircle%20cx='78.67'%20cy='88.32'%20r='0.62'%20fill='%23fad7e9'/%3E%3Ccircle%20cx='81.95'%20cy='87.77'%20r='0.64'%20fill='%23f7e8ea'/%3E%3Ccircle%20cx='85.25'%20cy='88.05'%20r='0.58'%20fill='%23f7e8f4'/%3E%3Ccircle%20cx='87.78'%20cy='87.9'%20r='0.67'%20fill='%23e9defc'/%3E%3Ccircle%20cx='91.56'%20cy='87.7'%20r='0.76'%20fill='%23f8d8de'/%3E%3Ccircle%20cx='94.61'%20cy='88.49'%20r='0.95'%20fill='%23fdd4fd'/%3E%3Ccircle%20cx='1.37'%20cy='91.38'%20r='0.94'%20fill='%23fddade'/%3E%3Ccircle%20cx='11.5'%20cy='91.44'%20r='0.69'%20fill='%23f7dfb5'/%3E%3Ccircle%20cx='14.15'%20cy='91.58'%20r='0.86'%20fill='%23f4dfbf'/%3E%3Ccircle%20cx='17.15'%20cy='91.4'%20r='0.96'%20fill='%23f6f2b3'/%3E%3Ccircle%20cx='20.84'%20cy='91.23'%20r='0.81'%20fill='%23c8fab6'/%3E%3Ccircle%20cx='24.44'%20cy='90.73'%20r='0.6'%20fill='%23def6bd'/%3E%3Ccircle%20cx='27.5'%20cy='91.49'%20r='0.83'%20fill='%23c4f4c3'/%3E%3Ccircle%20cx='30.5'%20cy='91.18'%20r='0.87'%20fill='%23e8f7f1'/%3E%3Ccircle%20cx='33.38'%20cy='90.97'%20r='0.64'%20fill='%23e8f7f1'/%3E%3Ccircle%20cx='36.6'%20cy='91.7'%20r='0.82'%20fill='%23a8f0b0'/%3E%3Ccircle%20cx='39.77'%20cy='91.35'%20r='0.84'%20fill='%23b3f9a0'/%3E%3Ccircle%20cx='42.81'%20cy='91.37'%20r='0.94'%20fill='%23a8f9fc'/%3E%3Ccircle%20cx='46.19'%20cy='91.44'%20r='0.98'%20fill='%23bafce0'/%3E%3Ccircle%20cx='49.57'%20cy='90.8'%20r='0.88'%20fill='%23c4f5ee'/%3E%3Ccircle%20cx='52.8'%20cy='91.53'%20r='0.88'%20fill='%23bff7c0'/%3E%3Ccircle%20cx='56.18'%20cy='91.14'%20r='0.58'%20fill='%23e8f5f7'/%3E%3Ccircle%20cx='62.48'%20cy='91.41'%20r='0.86'%20fill='%23e5e6fc'/%3E%3Ccircle%20cx='65.28'%20cy='90.92'%20r='0.94'%20fill='%23beeaf3'/%3E%3Ccircle%20cx='69.17'%20cy='90.89'%20r='0.9'%20fill='%23e4dcfa'/%3E%3Ccircle%20cx='72.26'%20cy='91.24'%20r='0.75'%20fill='%23e9def9'/%3E%3Ccircle%20cx='75.67'%20cy='90.9'%20r='0.58'%20fill='%23f8d4fa'/%3E%3Ccircle%20cx='78.68'%20cy='90.74'%20r='0.76'%20fill='%23eae3fd'/%3E%3Ccircle%20cx='81.26'%20cy='91.68'%20r='0.82'%20fill='%23e2e2fa'/%3E%3Ccircle%20cx='85.12'%20cy='91.28'%20r='0.79'%20fill='%23f9dfda'/%3E%3Ccircle%20cx='87.73'%20cy='91.34'%20r='0.99'%20fill='%23e9def9'/%3E%3Ccircle%20cx='91.65'%20cy='91.59'%20r='0.73'%20fill='%23f9dccd'/%3E%3Ccircle%20cx='94.4'%20cy='90.83'%20r='0.63'%20fill='%23f7ece8'/%3E%3Ccircle%20cx='4.54'%20cy='94.37'%20r='1.0'%20fill='%23fddcd7'/%3E%3Ccircle%20cx='7.86'%20cy='94.86'%20r='0.64'%20fill='%23fdd8be'/%3E%3Ccircle%20cx='10.95'%20cy='93.97'%20r='0.7'%20fill='%23f9ded8'/%3E%3Ccircle%20cx='14.82'%20cy='94.27'%20r='0.93'%20fill='%23f7f5e8'/%3E%3Ccircle%20cx='17.54'%20cy='94.62'%20r='0.62'%20fill='%23f6e6b9'/%3E%3Ccircle%20cx='20.77'%20cy='94.27'%20r='0.57'%20fill='%23fcd7d0'/%3E%3Ccircle%20cx='23.56'%20cy='94.56'%20r='0.7'%20fill='%23f9e9a5'/%3E%3Ccircle%20cx='27.31'%20cy='94.15'%20r='0.56'%20fill='%23c9f8c0'/%3E%3Ccircle%20cx='29.91'%20cy='94.45'%20r='0.7'%20fill='%23c4f8c4'/%3E%3Ccircle%20cx='33.12'%20cy='94.42'%20r='0.68'%20fill='%23a3f99a'/%3E%3Ccircle%20cx='36.98'%20cy='94.55'%20r='0.84'%20fill='%23c2f9cb'/%3E%3Ccircle%20cx='40.06'%20cy='94.15'%20r='0.77'%20fill='%23b6f7f1'/%3E%3Ccircle%20cx='42.89'%20cy='93.96'%20r='0.74'%20fill='%23baf6ea'/%3E%3Ccircle%20cx='46.15'%20cy='94.55'%20r='0.82'%20fill='%23bbfaca'/%3E%3Ccircle%20cx='49.1'%20cy='94.53'%20r='0.92'%20fill='%23e8f7f2'/%3E%3Ccircle%20cx='52.89'%20cy='94.29'%20r='0.7'%20fill='%23bae8f3'/%3E%3Ccircle%20cx='55.92'%20cy='94.43'%20r='0.98'%20fill='%23e9e8f7'/%3E%3Ccircle%20cx='59.34'%20cy='94.81'%20r='0.59'%20fill='%23f1dcfd'/%3E%3Ccircle%20cx='62.54'%20cy='94.08'%20r='0.66'%20fill='%23d6e2f9'/%3E%3Ccircle%20cx='65.42'%20cy='94.37'%20r='0.73'%20fill='%23e8eef7'/%3E%3Ccircle%20cx='68.7'%20cy='94.76'%20r='0.96'%20fill='%23b0f4c2'/%3E%3Ccircle%20cx='71.61'%20cy='94.4'%20r='0.89'%20fill='%23f9ddf2'/%3E%3Ccircle%20cx='74.71'%20cy='94.46'%20r='0.86'%20fill='%23e9e1fb'/%3E%3Ccircle%20cx='78.87'%20cy='93.96'%20r='0.79'%20fill='%23f9dafb'/%3E%3Ccircle%20cx='81.33'%20cy='93.91'%20r='0.74'%20fill='%23f8d9f5'/%3E%3Ccircle%20cx='84.68'%20cy='94.08'%20r='0.59'%20fill='%23fbd6f2'/%3E%3Ccircle%20cx='88.07'%20cy='94.52'%20r='0.69'%20fill='%23f8f0b1'/%3E%3Ccircle%20cx='91.05'%20cy='94.58'%20r='0.61'%20fill='%23f7e8e9'/%3E%3Ccircle%20cx='93.96'%20cy='94.79'%20r='0.93'%20fill='%23f6d5f9'/%3E%3C/svg%3E");
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
