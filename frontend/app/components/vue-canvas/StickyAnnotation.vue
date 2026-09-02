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
// The glint layer is masked by the moving light band; the band mask slides
// with the pan at 1.6× so it rakes across the paper.
const bandPosition = computed(() => `${(shimmerPhase.value * 1.6).toFixed(1)}px 0px`)
const glitterStyle = computed(() => ({}))
const glintStyle = computed(() => ({
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
   that is essentially invisible until a wide soft light band passes over it
   — the reveal IS the effect; the dots don't change colour. Nothing
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
  background-image: url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='120'%20height='120'%3E%3Ccircle%20cx='2.78'%20cy='1.76'%20r='1.1'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='6.79'%20cy='1.78'%20r='0.97'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='10.19'%20cy='1.16'%20r='0.93'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='14.85'%20cy='1.65'%20r='1.12'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='22.6'%20cy='1.41'%20r='0.92'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='27.45'%20cy='1.33'%20r='1.01'%20fill='%2392dba8'/%3E%3Ccircle%20cx='31.76'%20cy='1.75'%20r='1.07'%20fill='%23efd486'/%3E%3Ccircle%20cx='36.39'%20cy='1.15'%20r='1.09'%20fill='%23efd486'/%3E%3Ccircle%20cx='39.56'%20cy='1.13'%20r='0.98'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='43.77'%20cy='1.13'%20r='0.94'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='47.84'%20cy='2.48'%20r='0.9'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='52.37'%20cy='1.92'%20r='1.15'%20fill='%2392dba8'/%3E%3Ccircle%20cx='56.04'%20cy='1.55'%20r='0.99'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='60.49'%20cy='1.18'%20r='0.94'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='65.39'%20cy='1.32'%20r='1.07'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='68.71'%20cy='2.05'%20r='1.16'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='72.7'%20cy='2.4'%20r='1.25'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='76.93'%20cy='1.32'%20r='1.25'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='81.17'%20cy='1.25'%20r='1.1'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='85.83'%20cy='1.49'%20r='1.17'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='93.72'%20cy='1.61'%20r='1.12'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='98.67'%20cy='1.94'%20r='1.24'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='102.6'%20cy='1.38'%20r='1.12'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='107.48'%20cy='2.52'%20r='0.97'%20fill='%2392dba8'/%3E%3Ccircle%20cx='111.27'%20cy='1.14'%20r='1.04'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='116.24'%20cy='1.4'%20r='0.91'%20fill='%23f2b895'/%3E%3Ccircle%20cx='4.96'%20cy='4.86'%20r='1.23'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='8.58'%20cy='5.1'%20r='1.2'%20fill='%2392dba8'/%3E%3Ccircle%20cx='12.46'%20cy='5.05'%20r='0.92'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='16.92'%20cy='4.87'%20r='1.03'%20fill='%23efd486'/%3E%3Ccircle%20cx='20.73'%20cy='5.83'%20r='1.06'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='24.46'%20cy='4.68'%20r='0.95'%20fill='%23efd486'/%3E%3Ccircle%20cx='28.63'%20cy='5.67'%20r='1.24'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='37.12'%20cy='5.38'%20r='0.95'%20fill='%23efd486'/%3E%3Ccircle%20cx='42.38'%20cy='5.78'%20r='1.22'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='45.54'%20cy='5.41'%20r='1.02'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='50.86'%20cy='6.04'%20r='1.05'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='58.02'%20cy='4.77'%20r='1.03'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='63.61'%20cy='5.82'%20r='1.25'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='67.13'%20cy='5.4'%20r='1.14'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='70.65'%20cy='5.62'%20r='1.16'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='80.25'%20cy='5.71'%20r='0.94'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='83.68'%20cy='5.74'%20r='0.9'%20fill='%2392dba8'/%3E%3Ccircle%20cx='87.95'%20cy='6.14'%20r='1.16'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='92.67'%20cy='4.97'%20r='1.01'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='96.12'%20cy='5.0'%20r='1.16'%20fill='%2392dba8'/%3E%3Ccircle%20cx='100.22'%20cy='5.45'%20r='1.01'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='104.3'%20cy='6.22'%20r='0.91'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='108.84'%20cy='5.0'%20r='1.06'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='113.68'%20cy='5.8'%20r='1.08'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='116.92'%20cy='4.71'%20r='1.06'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='1.75'%20cy='8.86'%20r='1.14'%20fill='%23f2b895'/%3E%3Ccircle%20cx='5.72'%20cy='9.02'%20r='0.91'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='10.95'%20cy='9.57'%20r='0.99'%20fill='%23f2b895'/%3E%3Ccircle%20cx='14.76'%20cy='9.32'%20r='0.94'%20fill='%23efd486'/%3E%3Ccircle%20cx='18.42'%20cy='9.05'%20r='1.14'%20fill='%2392dba8'/%3E%3Ccircle%20cx='23.16'%20cy='8.35'%20r='1.16'%20fill='%2392dba8'/%3E%3Ccircle%20cx='27.62'%20cy='9.13'%20r='1.02'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='32.06'%20cy='9.41'%20r='0.96'%20fill='%2392dba8'/%3E%3Ccircle%20cx='36.06'%20cy='8.5'%20r='1.23'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='39.11'%20cy='9.17'%20r='1.21'%20fill='%23f2b895'/%3E%3Ccircle%20cx='44.81'%20cy='9.04'%20r='1.18'%20fill='%23f2b895'/%3E%3Ccircle%20cx='48.89'%20cy='9.57'%20r='0.93'%20fill='%23f2b895'/%3E%3Ccircle%20cx='52.32'%20cy='8.43'%20r='0.98'%20fill='%23efd486'/%3E%3Ccircle%20cx='56.41'%20cy='9.75'%20r='1.18'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='64.85'%20cy='8.97'%20r='0.91'%20fill='%23efd486'/%3E%3Ccircle%20cx='69.79'%20cy='8.4'%20r='0.91'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='78.37'%20cy='9.05'%20r='1.14'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='82.18'%20cy='9.0'%20r='1.08'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='86.51'%20cy='9.0'%20r='1.14'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='90.52'%20cy='9.13'%20r='1.16'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='94.77'%20cy='9.82'%20r='0.99'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='99.26'%20cy='9.84'%20r='0.97'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='102.76'%20cy='8.48'%20r='1.07'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='107.85'%20cy='9.12'%20r='0.91'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='110.7'%20cy='8.44'%20r='1.25'%20fill='%2392dba8'/%3E%3Ccircle%20cx='3.6'%20cy='12.62'%20r='1.07'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='8.44'%20cy='12.1'%20r='1.22'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='12.01'%20cy='13.18'%20r='1.22'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='20.65'%20cy='13.09'%20r='0.9'%20fill='%2392dba8'/%3E%3Ccircle%20cx='25.57'%20cy='12.13'%20r='0.94'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='29.72'%20cy='13.34'%20r='1.15'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='33.65'%20cy='12.19'%20r='1.04'%20fill='%2392dba8'/%3E%3Ccircle%20cx='37.35'%20cy='12.28'%20r='1.09'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='41.57'%20cy='13.12'%20r='1.2'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='46.37'%20cy='13.36'%20r='0.96'%20fill='%2392dba8'/%3E%3Ccircle%20cx='51.02'%20cy='12.14'%20r='1.25'%20fill='%2392dba8'/%3E%3Ccircle%20cx='54.42'%20cy='12.63'%20r='0.93'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='58.32'%20cy='12.94'%20r='1.15'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='67.86'%20cy='13.48'%20r='1.14'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='71.15'%20cy='13.53'%20r='1.12'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='74.97'%20cy='11.99'%20r='0.92'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='79.77'%20cy='12.23'%20r='1.22'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='84.78'%20cy='13.41'%20r='1.19'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='88.49'%20cy='12.05'%20r='0.95'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='92.42'%20cy='12.62'%20r='1.06'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='95.87'%20cy='12.25'%20r='1.12'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='100.65'%20cy='12.24'%20r='1.16'%20fill='%2392dba8'/%3E%3Ccircle%20cx='104.72'%20cy='12.07'%20r='1.18'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='109.41'%20cy='12.58'%20r='1.2'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='113.15'%20cy='13.15'%20r='1.1'%20fill='%23efd486'/%3E%3Ccircle%20cx='118.04'%20cy='13.23'%20r='1.16'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='2.16'%20cy='16.16'%20r='1.02'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='6.66'%20cy='15.68'%20r='1.04'%20fill='%23efd486'/%3E%3Ccircle%20cx='11.12'%20cy='17.15'%20r='0.94'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='18.58'%20cy='15.91'%20r='1.24'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='22.92'%20cy='17.17'%20r='1.09'%20fill='%23f2b895'/%3E%3Ccircle%20cx='27.13'%20cy='16.49'%20r='0.94'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='31.11'%20cy='16.21'%20r='1.16'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='34.92'%20cy='15.98'%20r='1.13'%20fill='%23efd486'/%3E%3Ccircle%20cx='39.91'%20cy='17.12'%20r='1.09'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='44.01'%20cy='16.6'%20r='0.93'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='47.57'%20cy='17.06'%20r='1.17'%20fill='%2392dba8'/%3E%3Ccircle%20cx='53.07'%20cy='16.44'%20r='1.24'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='60.94'%20cy='16.52'%20r='1.05'%20fill='%23efd486'/%3E%3Ccircle%20cx='64.73'%20cy='17.06'%20r='1.07'%20fill='%23f2b895'/%3E%3Ccircle%20cx='68.52'%20cy='15.96'%20r='1.0'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='73.79'%20cy='15.65'%20r='1.04'%20fill='%23efd486'/%3E%3Ccircle%20cx='78.48'%20cy='17.08'%20r='0.92'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='82.25'%20cy='15.97'%20r='0.98'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='86.8'%20cy='16.72'%20r='1.08'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='89.89'%20cy='16.7'%20r='1.24'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='94.03'%20cy='15.65'%20r='1.06'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='98.12'%20cy='16.24'%20r='1.03'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='102.77'%20cy='16.81'%20r='1.1'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='106.76'%20cy='15.77'%20r='0.95'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='111.75'%20cy='16.57'%20r='1.21'%20fill='%23efd486'/%3E%3Ccircle%20cx='115.86'%20cy='16.69'%20r='1.11'%20fill='%2392dba8'/%3E%3Ccircle%20cx='4.81'%20cy='19.27'%20r='1.22'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='11.86'%20cy='19.56'%20r='0.91'%20fill='%23efd486'/%3E%3Ccircle%20cx='21.08'%20cy='20.21'%20r='1.14'%20fill='%23efd486'/%3E%3Ccircle%20cx='24.94'%20cy='20.0'%20r='1.02'%20fill='%2392dba8'/%3E%3Ccircle%20cx='28.79'%20cy='20.5'%20r='0.93'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='33.51'%20cy='20.4'%20r='1.17'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='38.05'%20cy='20.79'%20r='1.03'%20fill='%23efd486'/%3E%3Ccircle%20cx='42.52'%20cy='19.5'%20r='1.17'%20fill='%23f2b895'/%3E%3Ccircle%20cx='46.8'%20cy='19.33'%20r='0.93'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='50.9'%20cy='19.95'%20r='1.1'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='54.14'%20cy='20.26'%20r='0.93'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='59.22'%20cy='19.73'%20r='1.07'%20fill='%2392dba8'/%3E%3Ccircle%20cx='62.72'%20cy='20.66'%20r='1.13'%20fill='%23efd486'/%3E%3Ccircle%20cx='67.87'%20cy='20.71'%20r='1.1'%20fill='%23efd486'/%3E%3Ccircle%20cx='71.09'%20cy='19.71'%20r='1.18'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='75.63'%20cy='19.34'%20r='1.16'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='79.63'%20cy='19.83'%20r='1.03'%20fill='%2392dba8'/%3E%3Ccircle%20cx='83.82'%20cy='19.45'%20r='1.03'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='88.61'%20cy='20.61'%20r='0.96'%20fill='%23efd486'/%3E%3Ccircle%20cx='91.69'%20cy='19.46'%20r='0.98'%20fill='%23efd486'/%3E%3Ccircle%20cx='97.09'%20cy='19.31'%20r='1.13'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='100.54'%20cy='19.64'%20r='1.09'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='105.21'%20cy='19.44'%20r='0.93'%20fill='%23f2b895'/%3E%3Ccircle%20cx='109.54'%20cy='19.99'%20r='1.05'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='113.16'%20cy='20.5'%20r='1.06'%20fill='%23efd486'/%3E%3Ccircle%20cx='117.66'%20cy='20.36'%20r='1.07'%20fill='%23f2b895'/%3E%3Ccircle%20cx='2.51'%20cy='24.42'%20r='0.92'%20fill='%23efd486'/%3E%3Ccircle%20cx='6.83'%20cy='24.26'%20r='1.18'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='10.84'%20cy='24.13'%20r='1.08'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='14.29'%20cy='23.1'%20r='1.22'%20fill='%23f2b895'/%3E%3Ccircle%20cx='18.43'%20cy='23.52'%20r='0.96'%20fill='%23efd486'/%3E%3Ccircle%20cx='23.05'%20cy='24.01'%20r='1.21'%20fill='%23efd486'/%3E%3Ccircle%20cx='26.79'%20cy='22.94'%20r='1.17'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='35.4'%20cy='23.16'%20r='1.18'%20fill='%23efd486'/%3E%3Ccircle%20cx='40.25'%20cy='23.79'%20r='0.98'%20fill='%2392dba8'/%3E%3Ccircle%20cx='43.94'%20cy='24.3'%20r='1.21'%20fill='%23efd486'/%3E%3Ccircle%20cx='48.38'%20cy='24.21'%20r='1.23'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='52.25'%20cy='23.72'%20r='1.22'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='55.98'%20cy='24.36'%20r='0.98'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='61.37'%20cy='24.08'%20r='1.24'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='64.68'%20cy='22.86'%20r='1.13'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='68.89'%20cy='23.52'%20r='1.06'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='73.21'%20cy='23.26'%20r='0.95'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='78.09'%20cy='23.83'%20r='0.95'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='82.33'%20cy='22.84'%20r='0.95'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='85.51'%20cy='23.41'%20r='0.95'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='90.27'%20cy='23.59'%20r='0.93'%20fill='%23f2b895'/%3E%3Ccircle%20cx='94.19'%20cy='24.11'%20r='1.2'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='99.15'%20cy='23.55'%20r='1.14'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='102.35'%20cy='24.17'%20r='1.08'%20fill='%23efd486'/%3E%3Ccircle%20cx='107.19'%20cy='24.44'%20r='1.04'%20fill='%23f2b895'/%3E%3Ccircle%20cx='111.6'%20cy='23.01'%20r='1.03'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='115.96'%20cy='23.04'%20r='1.16'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='3.78'%20cy='27.38'%20r='1.15'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='8.95'%20cy='27.63'%20r='1.2'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='13.3'%20cy='27.68'%20r='1.12'%20fill='%23efd486'/%3E%3Ccircle%20cx='16.14'%20cy='26.78'%20r='1.09'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='21.71'%20cy='27.38'%20r='1.02'%20fill='%23f2b895'/%3E%3Ccircle%20cx='25.01'%20cy='26.64'%20r='1.06'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='29.73'%20cy='26.77'%20r='1.14'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='37.16'%20cy='26.53'%20r='1.15'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='41.75'%20cy='27.8'%20r='1.17'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='45.64'%20cy='27.59'%20r='0.97'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='49.62'%20cy='27.12'%20r='1.04'%20fill='%23f2b895'/%3E%3Ccircle%20cx='54.19'%20cy='28.06'%20r='1.18'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='63.24'%20cy='26.65'%20r='1.02'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='66.87'%20cy='26.64'%20r='1.02'%20fill='%23f2b895'/%3E%3Ccircle%20cx='72.04'%20cy='27.36'%20r='1.17'%20fill='%23efd486'/%3E%3Ccircle%20cx='75.72'%20cy='26.8'%20r='1.08'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='80.5'%20cy='27.39'%20r='1.15'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='83.33'%20cy='26.87'%20r='0.97'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='87.55'%20cy='27.88'%20r='1.02'%20fill='%23efd486'/%3E%3Ccircle%20cx='93.16'%20cy='26.7'%20r='0.94'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='96.7'%20cy='26.9'%20r='1.1'%20fill='%23f2b895'/%3E%3Ccircle%20cx='100.96'%20cy='26.68'%20r='1.19'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='109.61'%20cy='27.06'%20r='1.03'%20fill='%2392dba8'/%3E%3Ccircle%20cx='112.72'%20cy='26.53'%20r='1.09'%20fill='%2392dba8'/%3E%3Ccircle%20cx='118.4'%20cy='26.7'%20r='1.23'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='1.91'%20cy='31.06'%20r='1.16'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='6.16'%20cy='30.17'%20r='0.96'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='9.98'%20cy='30.95'%20r='1.1'%20fill='%23efd486'/%3E%3Ccircle%20cx='13.99'%20cy='31.37'%20r='1.23'%20fill='%23f2b895'/%3E%3Ccircle%20cx='19.63'%20cy='31.08'%20r='0.95'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='23.76'%20cy='31.02'%20r='1.21'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='28.09'%20cy='31.46'%20r='1.07'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='30.89'%20cy='30.3'%20r='1.19'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='35.57'%20cy='30.16'%20r='1.08'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='39.79'%20cy='30.72'%20r='1.12'%20fill='%23efd486'/%3E%3Ccircle%20cx='44.25'%20cy='30.23'%20r='1.01'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='48.9'%20cy='31.67'%20r='0.98'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='52.08'%20cy='30.61'%20r='1.08'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='57.5'%20cy='31.29'%20r='1.21'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='60.77'%20cy='31.41'%20r='1.2'%20fill='%2392dba8'/%3E%3Ccircle%20cx='64.5'%20cy='30.23'%20r='1.05'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='69.36'%20cy='31.64'%20r='0.94'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='72.74'%20cy='30.39'%20r='1.15'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='77.54'%20cy='30.69'%20r='1.19'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='81.83'%20cy='30.62'%20r='1.01'%20fill='%23efd486'/%3E%3Ccircle%20cx='86.86'%20cy='30.87'%20r='1.23'%20fill='%2392dba8'/%3E%3Ccircle%20cx='90.61'%20cy='30.21'%20r='1.2'%20fill='%23efd486'/%3E%3Ccircle%20cx='94.46'%20cy='30.39'%20r='1.02'%20fill='%23f2b895'/%3E%3Ccircle%20cx='98.91'%20cy='30.42'%20r='0.97'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='103.41'%20cy='31.66'%20r='1.01'%20fill='%23efd486'/%3E%3Ccircle%20cx='106.52'%20cy='31.23'%20r='1.15'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='110.86'%20cy='30.61'%20r='0.93'%20fill='%23f2b895'/%3E%3Ccircle%20cx='115.85'%20cy='30.92'%20r='0.99'%20fill='%23efd486'/%3E%3Ccircle%20cx='3.88'%20cy='35.24'%20r='0.98'%20fill='%23f2b895'/%3E%3Ccircle%20cx='8.67'%20cy='34.49'%20r='0.95'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='12.65'%20cy='33.83'%20r='1.08'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='16.68'%20cy='34.66'%20r='1.09'%20fill='%2392dba8'/%3E%3Ccircle%20cx='20.59'%20cy='34.2'%20r='1.16'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='30.04'%20cy='34.75'%20r='0.95'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='34.23'%20cy='33.85'%20r='0.9'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='37.58'%20cy='34.81'%20r='1.13'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='46.42'%20cy='35.33'%20r='1.19'%20fill='%23f2b895'/%3E%3Ccircle%20cx='50.85'%20cy='34.02'%20r='0.96'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='54.68'%20cy='34.16'%20r='1.13'%20fill='%23f2b895'/%3E%3Ccircle%20cx='58.78'%20cy='34.11'%20r='0.98'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='62.52'%20cy='35.31'%20r='0.99'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='66.69'%20cy='34.0'%20r='1.21'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='71.41'%20cy='34.91'%20r='1.18'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='76.25'%20cy='34.66'%20r='0.93'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='80.0'%20cy='33.84'%20r='1.15'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='88.24'%20cy='34.18'%20r='1.12'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='92.42'%20cy='34.36'%20r='1.13'%20fill='%2392dba8'/%3E%3Ccircle%20cx='97.13'%20cy='35.01'%20r='1.14'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='101.12'%20cy='34.88'%20r='1.06'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='105.16'%20cy='33.97'%20r='1.16'%20fill='%23f2b895'/%3E%3Ccircle%20cx='108.46'%20cy='34.14'%20r='1.16'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='113.08'%20cy='34.43'%20r='1.04'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='117.95'%20cy='35.32'%20r='1.14'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='2.18'%20cy='37.78'%20r='0.99'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='5.99'%20cy='38.91'%20r='0.98'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='10.64'%20cy='38.98'%20r='0.96'%20fill='%23f2b895'/%3E%3Ccircle%20cx='15.28'%20cy='38.34'%20r='1.14'%20fill='%2392dba8'/%3E%3Ccircle%20cx='19.45'%20cy='38.0'%20r='1.04'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='27.77'%20cy='38.68'%20r='0.99'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='31.45'%20cy='37.89'%20r='0.98'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='35.19'%20cy='38.17'%20r='1.12'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='40.21'%20cy='37.97'%20r='0.93'%20fill='%23efd486'/%3E%3Ccircle%20cx='44.49'%20cy='38.21'%20r='1.08'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='47.93'%20cy='37.97'%20r='1.15'%20fill='%2392dba8'/%3E%3Ccircle%20cx='51.92'%20cy='37.78'%20r='1.17'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='56.42'%20cy='38.01'%20r='0.91'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='60.51'%20cy='38.8'%20r='1.03'%20fill='%23f2b895'/%3E%3Ccircle%20cx='68.57'%20cy='37.63'%20r='0.98'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='73.36'%20cy='38.16'%20r='0.97'%20fill='%23f2b895'/%3E%3Ccircle%20cx='77.32'%20cy='38.55'%20r='1.15'%20fill='%23f2b895'/%3E%3Ccircle%20cx='82.44'%20cy='38.25'%20r='1.21'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='86.69'%20cy='37.75'%20r='1.04'%20fill='%23efd486'/%3E%3Ccircle%20cx='89.72'%20cy='38.75'%20r='1.11'%20fill='%23f2b895'/%3E%3Ccircle%20cx='94.99'%20cy='38.95'%20r='1.1'%20fill='%23efd486'/%3E%3Ccircle%20cx='99.26'%20cy='38.28'%20r='0.92'%20fill='%23efd486'/%3E%3Ccircle%20cx='103.49'%20cy='37.77'%20r='1.23'%20fill='%23f2b895'/%3E%3Ccircle%20cx='106.49'%20cy='38.18'%20r='1.18'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='111.3'%20cy='37.84'%20r='1.01'%20fill='%2392dba8'/%3E%3Ccircle%20cx='115.93'%20cy='37.95'%20r='0.97'%20fill='%23f2b895'/%3E%3Ccircle%20cx='4.52'%20cy='41.91'%20r='1.1'%20fill='%23f2b895'/%3E%3Ccircle%20cx='7.79'%20cy='42.48'%20r='1.22'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='13.15'%20cy='41.51'%20r='1.03'%20fill='%23f2b895'/%3E%3Ccircle%20cx='16.04'%20cy='41.58'%20r='0.99'%20fill='%23efd486'/%3E%3Ccircle%20cx='21.27'%20cy='41.33'%20r='0.99'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='25.84'%20cy='41.08'%20r='1.02'%20fill='%23f2b895'/%3E%3Ccircle%20cx='29.6'%20cy='42.02'%20r='1.17'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='32.91'%20cy='41.77'%20r='0.92'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='37.06'%20cy='41.25'%20r='1.22'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='41.96'%20cy='41.06'%20r='1.07'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='46.49'%20cy='41.4'%20r='0.98'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='49.61'%20cy='41.9'%20r='1.24'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='54.8'%20cy='41.93'%20r='1.09'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='58.42'%20cy='41.2'%20r='1.18'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='63.31'%20cy='42.13'%20r='1.15'%20fill='%2392dba8'/%3E%3Ccircle%20cx='67.39'%20cy='41.81'%20r='0.96'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='71.19'%20cy='42.1'%20r='1.05'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='75.32'%20cy='41.31'%20r='0.99'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='80.58'%20cy='42.34'%20r='1.21'%20fill='%23f2b895'/%3E%3Ccircle%20cx='84.02'%20cy='42.12'%20r='1.2'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='88.79'%20cy='41.11'%20r='1.2'%20fill='%23efd486'/%3E%3Ccircle%20cx='92.71'%20cy='41.43'%20r='1.16'%20fill='%23f2b895'/%3E%3Ccircle%20cx='96.32'%20cy='41.56'%20r='1.15'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='100.21'%20cy='42.6'%20r='1.1'%20fill='%23f2b895'/%3E%3Ccircle%20cx='105.53'%20cy='42.31'%20r='1.12'%20fill='%2392dba8'/%3E%3Ccircle%20cx='108.87'%20cy='42.07'%20r='1.12'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='113.87'%20cy='42.51'%20r='1.14'%20fill='%23efd486'/%3E%3Ccircle%20cx='117.81'%20cy='41.66'%20r='1.05'%20fill='%23f2b895'/%3E%3Ccircle%20cx='2.44'%20cy='44.86'%20r='0.92'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='6.36'%20cy='45.95'%20r='1.02'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='10.57'%20cy='45.44'%20r='0.91'%20fill='%23efd486'/%3E%3Ccircle%20cx='19.14'%20cy='45.02'%20r='1.2'%20fill='%23f2b895'/%3E%3Ccircle%20cx='23.87'%20cy='45.29'%20r='1.17'%20fill='%23f2b895'/%3E%3Ccircle%20cx='27.89'%20cy='45.37'%20r='1.0'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='31.1'%20cy='45.45'%20r='1.23'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='35.33'%20cy='45.58'%20r='1.21'%20fill='%23efd486'/%3E%3Ccircle%20cx='39.46'%20cy='45.44'%20r='1.0'%20fill='%23efd486'/%3E%3Ccircle%20cx='43.54'%20cy='44.68'%20r='1.1'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='47.79'%20cy='45.44'%20r='0.93'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='52.47'%20cy='45.33'%20r='1.2'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='56.24'%20cy='45.65'%20r='1.1'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='61.6'%20cy='46.05'%20r='1.0'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='65.46'%20cy='44.95'%20r='1.19'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='69.58'%20cy='45.1'%20r='1.09'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='73.52'%20cy='44.68'%20r='1.01'%20fill='%2392dba8'/%3E%3Ccircle%20cx='81.52'%20cy='45.06'%20r='1.17'%20fill='%23f2b895'/%3E%3Ccircle%20cx='86.15'%20cy='45.73'%20r='1.01'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='91.02'%20cy='45.31'%20r='0.94'%20fill='%23f2b895'/%3E%3Ccircle%20cx='94.7'%20cy='44.68'%20r='1.21'%20fill='%2392dba8'/%3E%3Ccircle%20cx='98.49'%20cy='45.72'%20r='1.04'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='102.82'%20cy='45.17'%20r='1.12'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='106.45'%20cy='45.2'%20r='1.01'%20fill='%23f2b895'/%3E%3Ccircle%20cx='110.71'%20cy='45.15'%20r='0.92'%20fill='%2392dba8'/%3E%3Ccircle%20cx='114.93'%20cy='45.23'%20r='0.94'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='3.55'%20cy='49.82'%20r='0.92'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='9.01'%20cy='48.82'%20r='0.97'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='12.31'%20cy='49.06'%20r='1.1'%20fill='%2392dba8'/%3E%3Ccircle%20cx='17.42'%20cy='49.6'%20r='1.17'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='20.72'%20cy='48.6'%20r='1.23'%20fill='%23efd486'/%3E%3Ccircle%20cx='25.57'%20cy='49.36'%20r='0.9'%20fill='%23f2b895'/%3E%3Ccircle%20cx='33.5'%20cy='49.45'%20r='1.02'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='37.18'%20cy='49.64'%20r='1.1'%20fill='%23f2b895'/%3E%3Ccircle%20cx='41.95'%20cy='49.64'%20r='1.05'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='46.32'%20cy='49.13'%20r='1.11'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='50.05'%20cy='48.38'%20r='1.06'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='54.55'%20cy='49.89'%20r='0.95'%20fill='%23f2b895'/%3E%3Ccircle%20cx='58.75'%20cy='49.19'%20r='0.97'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='63.78'%20cy='49.09'%20r='0.94'%20fill='%2392dba8'/%3E%3Ccircle%20cx='67.66'%20cy='48.53'%20r='1.22'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='72.19'%20cy='48.41'%20r='1.08'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='79.56'%20cy='48.64'%20r='1.08'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='83.65'%20cy='49.33'%20r='0.97'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='88.61'%20cy='49.71'%20r='1.05'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='92.83'%20cy='49.18'%20r='1.2'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='96.39'%20cy='48.46'%20r='0.95'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='100.35'%20cy='48.77'%20r='1.23'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='105.56'%20cy='49.29'%20r='1.04'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='113.61'%20cy='49.71'%20r='0.97'%20fill='%23f2b895'/%3E%3Ccircle%20cx='118.39'%20cy='48.91'%20r='1.1'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='2.31'%20cy='52.39'%20r='1.01'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='6.73'%20cy='52.22'%20r='0.97'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='9.89'%20cy='53.45'%20r='0.95'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='13.91'%20cy='52.05'%20r='1.01'%20fill='%2392dba8'/%3E%3Ccircle%20cx='18.6'%20cy='52.59'%20r='1.03'%20fill='%2392dba8'/%3E%3Ccircle%20cx='27.48'%20cy='52.39'%20r='1.03'%20fill='%2392dba8'/%3E%3Ccircle%20cx='31.25'%20cy='53.07'%20r='1.23'%20fill='%2392dba8'/%3E%3Ccircle%20cx='35.1'%20cy='53.34'%20r='0.94'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='44.06'%20cy='52.26'%20r='0.98'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='47.6'%20cy='52.61'%20r='1.06'%20fill='%23efd486'/%3E%3Ccircle%20cx='52.13'%20cy='53.0'%20r='1.13'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='56.56'%20cy='52.15'%20r='0.99'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='60.65'%20cy='53.25'%20r='1.05'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='65.35'%20cy='52.67'%20r='0.94'%20fill='%2392dba8'/%3E%3Ccircle%20cx='69.1'%20cy='53.1'%20r='1.03'%20fill='%23f2b895'/%3E%3Ccircle%20cx='74.01'%20cy='53.34'%20r='1.25'%20fill='%23f2b895'/%3E%3Ccircle%20cx='77.48'%20cy='52.68'%20r='1.06'%20fill='%23efd486'/%3E%3Ccircle%20cx='81.2'%20cy='52.3'%20r='1.13'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='86.63'%20cy='52.98'%20r='1.04'%20fill='%23f2b895'/%3E%3Ccircle%20cx='91.1'%20cy='52.99'%20r='0.92'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='95.28'%20cy='52.28'%20r='0.98'%20fill='%23efd486'/%3E%3Ccircle%20cx='98.05'%20cy='53.21'%20r='1.08'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='103.1'%20cy='53.13'%20r='1.13'%20fill='%23efd486'/%3E%3Ccircle%20cx='107.06'%20cy='53.36'%20r='1.24'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='111.88'%20cy='53.45'%20r='0.91'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='115.6'%20cy='53.5'%20r='1.04'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='3.54'%20cy='56.4'%20r='0.95'%20fill='%23efd486'/%3E%3Ccircle%20cx='8.55'%20cy='56.32'%20r='0.99'%20fill='%2392dba8'/%3E%3Ccircle%20cx='11.97'%20cy='55.8'%20r='0.96'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='16.23'%20cy='56.48'%20r='1.08'%20fill='%2392dba8'/%3E%3Ccircle%20cx='21.58'%20cy='57.12'%20r='1.11'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='25.68'%20cy='55.75'%20r='0.98'%20fill='%23f2b895'/%3E%3Ccircle%20cx='29.45'%20cy='55.62'%20r='0.95'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='33.67'%20cy='56.8'%20r='1.22'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='41.62'%20cy='55.76'%20r='0.93'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='46.45'%20cy='57.0'%20r='1.07'%20fill='%2392dba8'/%3E%3Ccircle%20cx='51.05'%20cy='56.21'%20r='1.08'%20fill='%23efd486'/%3E%3Ccircle%20cx='54.15'%20cy='55.71'%20r='1.11'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='58.69'%20cy='56.3'%20r='1.03'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='62.46'%20cy='56.19'%20r='1.09'%20fill='%23efd486'/%3E%3Ccircle%20cx='66.56'%20cy='56.17'%20r='0.98'%20fill='%23efd486'/%3E%3Ccircle%20cx='71.43'%20cy='56.42'%20r='1.23'%20fill='%23f2b895'/%3E%3Ccircle%20cx='79.01'%20cy='56.53'%20r='1.24'%20fill='%2392dba8'/%3E%3Ccircle%20cx='83.79'%20cy='56.06'%20r='1.11'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='87.69'%20cy='55.77'%20r='0.92'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='91.75'%20cy='55.98'%20r='0.92'%20fill='%23efd486'/%3E%3Ccircle%20cx='96.84'%20cy='56.18'%20r='1.23'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='100.14'%20cy='57.15'%20r='1.14'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='104.44'%20cy='55.83'%20r='0.91'%20fill='%23efd486'/%3E%3Ccircle%20cx='109.62'%20cy='55.65'%20r='0.92'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='113.14'%20cy='56.73'%20r='0.95'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='117.73'%20cy='55.59'%20r='1.16'%20fill='%23f2b895'/%3E%3Ccircle%20cx='2.3'%20cy='60.68'%20r='1.02'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='10.9'%20cy='59.82'%20r='1.05'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='14.61'%20cy='60.65'%20r='1.18'%20fill='%23f2b895'/%3E%3Ccircle%20cx='23.37'%20cy='60.09'%20r='1.19'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='27.61'%20cy='60.26'%20r='1.04'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='31.36'%20cy='60.07'%20r='0.97'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='35.34'%20cy='59.87'%20r='0.95'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='40.22'%20cy='60.01'%20r='0.97'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='44.55'%20cy='59.38'%20r='1.04'%20fill='%23f2b895'/%3E%3Ccircle%20cx='48.02'%20cy='59.24'%20r='1.17'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='52.65'%20cy='60.05'%20r='1.02'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='56.64'%20cy='60.45'%20r='1.11'%20fill='%2392dba8'/%3E%3Ccircle%20cx='60.62'%20cy='60.33'%20r='1.24'%20fill='%2392dba8'/%3E%3Ccircle%20cx='64.96'%20cy='59.29'%20r='1.02'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='68.89'%20cy='59.56'%20r='0.99'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='77.75'%20cy='59.83'%20r='1.04'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='81.26'%20cy='59.71'%20r='1.16'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='85.86'%20cy='59.47'%20r='1.25'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='91.02'%20cy='60.44'%20r='0.95'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='93.95'%20cy='60.79'%20r='0.99'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='98.09'%20cy='60.44'%20r='1.11'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='102.69'%20cy='59.73'%20r='1.25'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='106.77'%20cy='60.59'%20r='1.15'%20fill='%23f2b895'/%3E%3Ccircle%20cx='111.07'%20cy='59.49'%20r='0.94'%20fill='%23efd486'/%3E%3Ccircle%20cx='115.6'%20cy='59.64'%20r='1.0'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='4.78'%20cy='64.22'%20r='0.96'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='7.86'%20cy='64.05'%20r='1.18'%20fill='%23f2b895'/%3E%3Ccircle%20cx='12.22'%20cy='62.94'%20r='1.17'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='16.37'%20cy='63.58'%20r='1.18'%20fill='%23efd486'/%3E%3Ccircle%20cx='21.22'%20cy='63.29'%20r='0.98'%20fill='%23f2b895'/%3E%3Ccircle%20cx='25.92'%20cy='63.03'%20r='0.98'%20fill='%23f2b895'/%3E%3Ccircle%20cx='28.6'%20cy='64.35'%20r='1.01'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='33.37'%20cy='63.08'%20r='1.03'%20fill='%23f2b895'/%3E%3Ccircle%20cx='37.66'%20cy='63.08'%20r='0.95'%20fill='%23f2b895'/%3E%3Ccircle%20cx='42.67'%20cy='63.72'%20r='1.24'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='46.24'%20cy='63.42'%20r='0.96'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='49.76'%20cy='63.08'%20r='1.21'%20fill='%2392dba8'/%3E%3Ccircle%20cx='59.56'%20cy='63.75'%20r='1.1'%20fill='%2392dba8'/%3E%3Ccircle%20cx='62.55'%20cy='63.29'%20r='0.99'%20fill='%2392dba8'/%3E%3Ccircle%20cx='67.88'%20cy='64.23'%20r='1.23'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='75.9'%20cy='63.83'%20r='1.11'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='80.23'%20cy='63.1'%20r='0.96'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='83.68'%20cy='64.43'%20r='1.0'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='92.43'%20cy='63.78'%20r='1.14'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='96.39'%20cy='64.39'%20r='0.93'%20fill='%2392dba8'/%3E%3Ccircle%20cx='100.65'%20cy='63.39'%20r='1.19'%20fill='%23efd486'/%3E%3Ccircle%20cx='104.59'%20cy='62.93'%20r='1.21'%20fill='%23efd486'/%3E%3Ccircle%20cx='109.48'%20cy='63.58'%20r='1.02'%20fill='%2392dba8'/%3E%3Ccircle%20cx='112.92'%20cy='63.19'%20r='1.04'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='117.33'%20cy='63.23'%20r='1.17'%20fill='%23f2b895'/%3E%3Ccircle%20cx='2.22'%20cy='67.41'%20r='1.11'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='5.98'%20cy='67.02'%20r='0.98'%20fill='%23f2b895'/%3E%3Ccircle%20cx='10.1'%20cy='66.64'%20r='0.91'%20fill='%23f2b895'/%3E%3Ccircle%20cx='14.25'%20cy='67.15'%20r='0.99'%20fill='%2392dba8'/%3E%3Ccircle%20cx='19.56'%20cy='68.07'%20r='1.02'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='23.37'%20cy='66.86'%20r='1.05'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='27.4'%20cy='68.0'%20r='1.22'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='30.72'%20cy='67.29'%20r='1.19'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='35.15'%20cy='66.6'%20r='1.05'%20fill='%2392dba8'/%3E%3Ccircle%20cx='40.59'%20cy='67.04'%20r='1.24'%20fill='%2392dba8'/%3E%3Ccircle%20cx='44.81'%20cy='66.8'%20r='1.15'%20fill='%2392dba8'/%3E%3Ccircle%20cx='48.86'%20cy='67.91'%20r='0.98'%20fill='%23f2b895'/%3E%3Ccircle%20cx='51.89'%20cy='66.93'%20r='1.03'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='60.18'%20cy='66.98'%20r='1.02'%20fill='%2392dba8'/%3E%3Ccircle%20cx='65.14'%20cy='67.8'%20r='1.0'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='70.02'%20cy='66.62'%20r='1.08'%20fill='%2392dba8'/%3E%3Ccircle%20cx='78.39'%20cy='67.57'%20r='1.24'%20fill='%2392dba8'/%3E%3Ccircle%20cx='82.01'%20cy='66.96'%20r='1.02'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='85.86'%20cy='68.09'%20r='1.11'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='91.01'%20cy='68.05'%20r='0.97'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='94.57'%20cy='66.94'%20r='1.1'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='98.24'%20cy='66.52'%20r='1.16'%20fill='%2392dba8'/%3E%3Ccircle%20cx='103.08'%20cy='66.59'%20r='1.24'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='106.79'%20cy='66.56'%20r='0.91'%20fill='%23efd486'/%3E%3Ccircle%20cx='111.6'%20cy='66.89'%20r='1.1'%20fill='%23f2b895'/%3E%3Ccircle%20cx='116.11'%20cy='67.42'%20r='1.02'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='4.39'%20cy='71.55'%20r='1.14'%20fill='%23f2b895'/%3E%3Ccircle%20cx='9.18'%20cy='70.59'%20r='1.08'%20fill='%2392dba8'/%3E%3Ccircle%20cx='12.69'%20cy='70.77'%20r='1.01'%20fill='%23f2b895'/%3E%3Ccircle%20cx='16.16'%20cy='71.23'%20r='1.0'%20fill='%23efd486'/%3E%3Ccircle%20cx='21.39'%20cy='71.41'%20r='0.94'%20fill='%23f2b895'/%3E%3Ccircle%20cx='25.19'%20cy='70.56'%20r='0.9'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='28.69'%20cy='70.64'%20r='1.1'%20fill='%23f2b895'/%3E%3Ccircle%20cx='34.35'%20cy='70.58'%20r='1.12'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='42.13'%20cy='70.77'%20r='0.92'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='46.21'%20cy='70.81'%20r='1.22'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='58.51'%20cy='71.19'%20r='0.95'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='62.54'%20cy='71.46'%20r='0.97'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='66.6'%20cy='70.52'%20r='1.13'%20fill='%23f2b895'/%3E%3Ccircle%20cx='71.88'%20cy='70.41'%20r='1.18'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='74.87'%20cy='71.42'%20r='1.15'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='80.03'%20cy='71.21'%20r='1.06'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='83.3'%20cy='71.2'%20r='1.13'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='88.02'%20cy='70.53'%20r='1.0'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='93.18'%20cy='71.12'%20r='1.17'%20fill='%2392dba8'/%3E%3Ccircle%20cx='96.5'%20cy='70.78'%20r='1.13'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='100.91'%20cy='71.64'%20r='1.21'%20fill='%23f2b895'/%3E%3Ccircle%20cx='105.34'%20cy='70.19'%20r='0.98'%20fill='%2392dba8'/%3E%3Ccircle%20cx='108.77'%20cy='71.12'%20r='1.24'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='113.11'%20cy='70.56'%20r='1.08'%20fill='%2392dba8'/%3E%3Ccircle%20cx='1.47'%20cy='74.29'%20r='1.17'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='7.02'%20cy='74.76'%20r='1.0'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='10.15'%20cy='74.6'%20r='1.02'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='18.18'%20cy='74.98'%20r='1.15'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='23.23'%20cy='74.15'%20r='0.97'%20fill='%23efd486'/%3E%3Ccircle%20cx='28.03'%20cy='74.24'%20r='1.02'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='31.36'%20cy='74.42'%20r='1.12'%20fill='%2392dba8'/%3E%3Ccircle%20cx='35.03'%20cy='74.45'%20r='1.22'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='39.99'%20cy='74.79'%20r='1.17'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='44.17'%20cy='75.36'%20r='0.99'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='49.08'%20cy='74.75'%20r='0.96'%20fill='%2392dba8'/%3E%3Ccircle%20cx='52.85'%20cy='74.93'%20r='1.0'%20fill='%23efd486'/%3E%3Ccircle%20cx='55.97'%20cy='73.86'%20r='1.18'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='60.86'%20cy='75.29'%20r='0.94'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='65.04'%20cy='74.75'%20r='0.9'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='69.42'%20cy='74.96'%20r='1.05'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='74.08'%20cy='74.42'%20r='0.98'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='76.99'%20cy='74.52'%20r='0.94'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='82.27'%20cy='74.76'%20r='1.16'%20fill='%2392dba8'/%3E%3Ccircle%20cx='86.08'%20cy='74.71'%20r='1.2'%20fill='%23efd486'/%3E%3Ccircle%20cx='90.04'%20cy='73.8'%20r='1.12'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='94.36'%20cy='74.4'%20r='1.08'%20fill='%2392dba8'/%3E%3Ccircle%20cx='99.03'%20cy='74.48'%20r='1.18'%20fill='%23efd486'/%3E%3Ccircle%20cx='102.8'%20cy='74.1'%20r='0.97'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='107.54'%20cy='74.49'%20r='1.01'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='111.55'%20cy='74.85'%20r='1.09'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='115.34'%20cy='74.84'%20r='1.17'%20fill='%23f2b895'/%3E%3Ccircle%20cx='3.74'%20cy='77.88'%20r='1.06'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='9.17'%20cy='77.95'%20r='1.09'%20fill='%23f2b895'/%3E%3Ccircle%20cx='12.35'%20cy='78.08'%20r='1.19'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='16.64'%20cy='78.99'%20r='0.98'%20fill='%2392dba8'/%3E%3Ccircle%20cx='21.0'%20cy='77.48'%20r='1.05'%20fill='%2392dba8'/%3E%3Ccircle%20cx='25.34'%20cy='78.54'%20r='1.04'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='29.37'%20cy='77.81'%20r='1.03'%20fill='%23f2b895'/%3E%3Ccircle%20cx='34.38'%20cy='77.62'%20r='1.09'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='37.81'%20cy='77.44'%20r='1.18'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='41.99'%20cy='77.67'%20r='1.08'%20fill='%23f2b895'/%3E%3Ccircle%20cx='46.18'%20cy='78.85'%20r='1.07'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='49.68'%20cy='78.14'%20r='0.93'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='55.33'%20cy='77.97'%20r='1.1'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='66.98'%20cy='77.75'%20r='0.96'%20fill='%23f2b895'/%3E%3Ccircle%20cx='71.46'%20cy='77.44'%20r='1.03'%20fill='%23efd486'/%3E%3Ccircle%20cx='76.06'%20cy='78.4'%20r='1.04'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='79.28'%20cy='77.59'%20r='0.99'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='83.51'%20cy='77.44'%20r='0.91'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='88.71'%20cy='78.78'%20r='0.91'%20fill='%2392dba8'/%3E%3Ccircle%20cx='92.11'%20cy='78.7'%20r='1.03'%20fill='%2392dba8'/%3E%3Ccircle%20cx='95.84'%20cy='78.87'%20r='1.15'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='101.58'%20cy='77.76'%20r='1.11'%20fill='%2392dba8'/%3E%3Ccircle%20cx='105.24'%20cy='78.88'%20r='1.01'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='109.72'%20cy='78.87'%20r='1.05'%20fill='%23f2b895'/%3E%3Ccircle%20cx='113.57'%20cy='77.96'%20r='1.07'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='117.16'%20cy='77.98'%20r='1.21'%20fill='%2392dba8'/%3E%3Ccircle%20cx='2.66'%20cy='82.23'%20r='1.13'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='6.43'%20cy='81.19'%20r='1.09'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='10.49'%20cy='81.89'%20r='1.17'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='19.22'%20cy='81.32'%20r='0.91'%20fill='%23efd486'/%3E%3Ccircle%20cx='26.59'%20cy='82.29'%20r='1.14'%20fill='%2392dba8'/%3E%3Ccircle%20cx='31.28'%20cy='81.44'%20r='1.02'%20fill='%23efd486'/%3E%3Ccircle%20cx='35.48'%20cy='81.71'%20r='0.91'%20fill='%2392dba8'/%3E%3Ccircle%20cx='40.45'%20cy='81.79'%20r='0.94'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='44.71'%20cy='82.44'%20r='1.09'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='48.3'%20cy='81.7'%20r='1.14'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='52.41'%20cy='81.96'%20r='0.99'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='56.36'%20cy='81.51'%20r='1.2'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='64.76'%20cy='81.35'%20r='1.12'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='69.24'%20cy='81.63'%20r='1.09'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='73.06'%20cy='81.97'%20r='1.08'%20fill='%23f2b895'/%3E%3Ccircle%20cx='77.02'%20cy='81.43'%20r='1.19'%20fill='%23efd486'/%3E%3Ccircle%20cx='81.6'%20cy='82.42'%20r='1.08'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='86.15'%20cy='81.22'%20r='1.23'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='90.52'%20cy='81.22'%20r='1.04'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='94.65'%20cy='81.91'%20r='1.21'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='98.64'%20cy='82.48'%20r='0.96'%20fill='%23f2b895'/%3E%3Ccircle%20cx='103.14'%20cy='82.34'%20r='1.23'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='106.32'%20cy='82.19'%20r='1.12'%20fill='%2392dba8'/%3E%3Ccircle%20cx='111.0'%20cy='81.32'%20r='0.98'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='114.99'%20cy='81.34'%20r='1.24'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='3.72'%20cy='84.72'%20r='0.95'%20fill='%2392dba8'/%3E%3Ccircle%20cx='9.18'%20cy='85.96'%20r='1.13'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='11.98'%20cy='84.69'%20r='1.01'%20fill='%23f2b895'/%3E%3Ccircle%20cx='21.52'%20cy='85.08'%20r='1.03'%20fill='%23f2b895'/%3E%3Ccircle%20cx='25.45'%20cy='84.73'%20r='1.05'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='29.68'%20cy='84.78'%20r='1.22'%20fill='%2392dba8'/%3E%3Ccircle%20cx='34.3'%20cy='85.74'%20r='1.03'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='38.0'%20cy='85.29'%20r='1.13'%20fill='%23f2b895'/%3E%3Ccircle%20cx='41.86'%20cy='85.62'%20r='0.9'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='45.44'%20cy='86.25'%20r='0.92'%20fill='%23efd486'/%3E%3Ccircle%20cx='51.11'%20cy='85.71'%20r='1.04'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='54.6'%20cy='85.9'%20r='1.08'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='58.78'%20cy='84.75'%20r='1.06'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='62.5'%20cy='85.43'%20r='0.91'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='66.66'%20cy='85.26'%20r='1.03'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='71.04'%20cy='85.66'%20r='0.92'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='75.03'%20cy='85.82'%20r='1.13'%20fill='%2392dba8'/%3E%3Ccircle%20cx='80.47'%20cy='84.74'%20r='1.11'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='83.92'%20cy='85.38'%20r='0.96'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='87.67'%20cy='85.53'%20r='0.96'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='92.8'%20cy='84.83'%20r='1.03'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='96.78'%20cy='84.99'%20r='0.91'%20fill='%23efd486'/%3E%3Ccircle%20cx='101.26'%20cy='86.04'%20r='1.05'%20fill='%23efd486'/%3E%3Ccircle%20cx='104.41'%20cy='85.29'%20r='1.23'%20fill='%23f2b895'/%3E%3Ccircle%20cx='108.57'%20cy='85.72'%20r='1.22'%20fill='%23efd486'/%3E%3Ccircle%20cx='113.8'%20cy='85.93'%20r='1.0'%20fill='%23f2b895'/%3E%3Ccircle%20cx='117.8'%20cy='86.06'%20r='1.13'%20fill='%23efd486'/%3E%3Ccircle%20cx='2.87'%20cy='89.5'%20r='0.94'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='6.58'%20cy='89.24'%20r='1.11'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='10.07'%20cy='89.09'%20r='1.0'%20fill='%23efd486'/%3E%3Ccircle%20cx='14.55'%20cy='89.22'%20r='0.95'%20fill='%2392dba8'/%3E%3Ccircle%20cx='18.79'%20cy='89.24'%20r='1.13'%20fill='%2392dba8'/%3E%3Ccircle%20cx='22.61'%20cy='89.03'%20r='1.11'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='26.8'%20cy='89.12'%20r='0.91'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='31.02'%20cy='89.2'%20r='1.2'%20fill='%23efd486'/%3E%3Ccircle%20cx='36.0'%20cy='89.32'%20r='0.94'%20fill='%23f2b895'/%3E%3Ccircle%20cx='40.12'%20cy='88.42'%20r='1.25'%20fill='%23f2b895'/%3E%3Ccircle%20cx='43.58'%20cy='89.05'%20r='1.18'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='48.01'%20cy='88.95'%20r='1.05'%20fill='%23efd486'/%3E%3Ccircle%20cx='52.56'%20cy='89.3'%20r='1.17'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='56.1'%20cy='89.27'%20r='1.24'%20fill='%23f2b895'/%3E%3Ccircle%20cx='65.47'%20cy='89.23'%20r='0.96'%20fill='%23f2b895'/%3E%3Ccircle%20cx='69.09'%20cy='89.81'%20r='1.13'%20fill='%2392dba8'/%3E%3Ccircle%20cx='73.79'%20cy='89.19'%20r='1.19'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='76.99'%20cy='89.35'%20r='1.23'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='81.36'%20cy='88.42'%20r='0.91'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='86.42'%20cy='89.69'%20r='0.93'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='90.09'%20cy='89.0'%20r='1.13'%20fill='%23f2b895'/%3E%3Ccircle%20cx='94.78'%20cy='89.87'%20r='1.2'%20fill='%23efd486'/%3E%3Ccircle%20cx='98.58'%20cy='88.65'%20r='1.0'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='103.06'%20cy='89.13'%20r='0.99'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='106.88'%20cy='88.9'%20r='1.09'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='110.96'%20cy='89.04'%20r='1.18'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='116.24'%20cy='89.41'%20r='1.0'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='4.94'%20cy='93.48'%20r='1.09'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='8.56'%20cy='93.17'%20r='1.05'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='12.41'%20cy='93.41'%20r='1.01'%20fill='%23f2b895'/%3E%3Ccircle%20cx='20.41'%20cy='92.17'%20r='1.07'%20fill='%23f2b895'/%3E%3Ccircle%20cx='24.65'%20cy='92.48'%20r='1.1'%20fill='%2392dba8'/%3E%3Ccircle%20cx='30.1'%20cy='92.49'%20r='0.92'%20fill='%2392dba8'/%3E%3Ccircle%20cx='33.68'%20cy='93.51'%20r='0.93'%20fill='%23efd486'/%3E%3Ccircle%20cx='38.27'%20cy='92.28'%20r='1.22'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='41.99'%20cy='92.44'%20r='0.96'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='45.52'%20cy='93.43'%20r='1.13'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='50.76'%20cy='93.4'%20r='1.01'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='54.18'%20cy='93.3'%20r='1.19'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='58.4'%20cy='92.83'%20r='1.2'%20fill='%23efd486'/%3E%3Ccircle%20cx='62.62'%20cy='92.34'%20r='1.11'%20fill='%23f2b895'/%3E%3Ccircle%20cx='67.56'%20cy='92.69'%20r='1.14'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='70.99'%20cy='92.63'%20r='0.98'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='75.39'%20cy='92.23'%20r='1.03'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='80.12'%20cy='92.91'%20r='0.95'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='84.47'%20cy='93.2'%20r='1.19'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='88.0'%20cy='92.61'%20r='1.13'%20fill='%23efd486'/%3E%3Ccircle%20cx='92.34'%20cy='92.85'%20r='0.99'%20fill='%23efd486'/%3E%3Ccircle%20cx='97.15'%20cy='92.57'%20r='1.14'%20fill='%23f2b895'/%3E%3Ccircle%20cx='105.75'%20cy='92.23'%20r='1.1'%20fill='%23efd486'/%3E%3Ccircle%20cx='109.52'%20cy='93.52'%20r='1.12'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='113.01'%20cy='93.17'%20r='0.93'%20fill='%2392dba8'/%3E%3Ccircle%20cx='117.92'%20cy='93.46'%20r='0.92'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='1.75'%20cy='96.76'%20r='1.05'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='6.75'%20cy='96.38'%20r='1.1'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='10.97'%20cy='96.55'%20r='0.93'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='14.68'%20cy='96.1'%20r='1.06'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='19.66'%20cy='96.16'%20r='1.02'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='22.5'%20cy='96.88'%20r='1.1'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='27.31'%20cy='95.87'%20r='1.13'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='31.62'%20cy='97.02'%20r='1.25'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='35.66'%20cy='96.83'%20r='1.13'%20fill='%23f2b895'/%3E%3Ccircle%20cx='40.49'%20cy='96.88'%20r='1.08'%20fill='%23f2b895'/%3E%3Ccircle%20cx='44.21'%20cy='96.85'%20r='1.14'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='48.69'%20cy='96.97'%20r='1.19'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='52.44'%20cy='96.49'%20r='1.05'%20fill='%23efd486'/%3E%3Ccircle%20cx='56.07'%20cy='96.12'%20r='1.11'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='65.71'%20cy='95.7'%20r='0.93'%20fill='%23efd486'/%3E%3Ccircle%20cx='69.71'%20cy='95.88'%20r='1.13'%20fill='%23efd486'/%3E%3Ccircle%20cx='73.44'%20cy='96.0'%20r='0.97'%20fill='%23f2b895'/%3E%3Ccircle%20cx='77.85'%20cy='96.5'%20r='1.09'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='82.68'%20cy='96.93'%20r='0.9'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='86.36'%20cy='96.29'%20r='1.07'%20fill='%23f2b895'/%3E%3Ccircle%20cx='91.0'%20cy='95.92'%20r='1.19'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='95.16'%20cy='95.73'%20r='1.05'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='98.46'%20cy='95.97'%20r='0.94'%20fill='%23f2b895'/%3E%3Ccircle%20cx='102.66'%20cy='97.12'%20r='1.09'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='107.03'%20cy='96.69'%20r='1.03'%20fill='%23f2b895'/%3E%3Ccircle%20cx='111.62'%20cy='95.84'%20r='1.24'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='114.75'%20cy='95.72'%20r='1.03'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='4.66'%20cy='99.32'%20r='0.94'%20fill='%23f2b895'/%3E%3Ccircle%20cx='7.88'%20cy='99.39'%20r='1.03'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='12.1'%20cy='100.53'%20r='1.17'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='16.75'%20cy='99.37'%20r='1.03'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='20.77'%20cy='99.98'%20r='1.06'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='24.5'%20cy='99.7'%20r='1.23'%20fill='%23efd486'/%3E%3Ccircle%20cx='28.87'%20cy='100.81'%20r='1.23'%20fill='%2392dba8'/%3E%3Ccircle%20cx='33.53'%20cy='100.67'%20r='0.98'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='37.33'%20cy='100.66'%20r='1.14'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='41.67'%20cy='100.69'%20r='0.91'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='46.35'%20cy='100.54'%20r='1.23'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='50.56'%20cy='99.93'%20r='1.04'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='62.84'%20cy='100.13'%20r='1.09'%20fill='%23efd486'/%3E%3Ccircle%20cx='66.47'%20cy='100.16'%20r='1.06'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='70.68'%20cy='99.7'%20r='0.99'%20fill='%23efd486'/%3E%3Ccircle%20cx='76.09'%20cy='100.18'%20r='0.98'%20fill='%23f2b895'/%3E%3Ccircle%20cx='79.71'%20cy='100.07'%20r='1.03'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='84.53'%20cy='100.27'%20r='1.04'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='88.21'%20cy='100.49'%20r='1.16'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='91.83'%20cy='99.71'%20r='1.18'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='96.63'%20cy='100.81'%20r='1.19'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='100.86'%20cy='100.12'%20r='1.19'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='104.21'%20cy='100.16'%20r='0.95'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='109.62'%20cy='99.41'%20r='1.21'%20fill='%23f2b895'/%3E%3Ccircle%20cx='112.61'%20cy='99.59'%20r='1.21'%20fill='%23f2b895'/%3E%3Ccircle%20cx='118.04'%20cy='100.76'%20r='1.14'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='1.4'%20cy='104.36'%20r='1.16'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='9.97'%20cy='103.79'%20r='0.99'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='14.61'%20cy='103.3'%20r='0.94'%20fill='%23f2b895'/%3E%3Ccircle%20cx='18.72'%20cy='103.69'%20r='0.96'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='23.8'%20cy='104.35'%20r='1.11'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='26.89'%20cy='103.6'%20r='0.98'%20fill='%23f2b895'/%3E%3Ccircle%20cx='31.75'%20cy='103.33'%20r='1.15'%20fill='%23f2b895'/%3E%3Ccircle%20cx='40.27'%20cy='104.21'%20r='0.97'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='43.49'%20cy='102.99'%20r='0.93'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='49.05'%20cy='104.42'%20r='0.94'%20fill='%23f2b895'/%3E%3Ccircle%20cx='52.26'%20cy='104.32'%20r='0.94'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='56.96'%20cy='103.38'%20r='1.08'%20fill='%23f2b895'/%3E%3Ccircle%20cx='61.62'%20cy='103.14'%20r='0.99'%20fill='%23f2b895'/%3E%3Ccircle%20cx='65.78'%20cy='104.21'%20r='1.23'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='69.59'%20cy='104.28'%20r='1.02'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='73.33'%20cy='103.68'%20r='0.92'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='78.49'%20cy='103.58'%20r='1.21'%20fill='%23f2b895'/%3E%3Ccircle%20cx='81.8'%20cy='102.96'%20r='1.01'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='86.44'%20cy='103.51'%20r='1.03'%20fill='%2392dba8'/%3E%3Ccircle%20cx='90.82'%20cy='104.01'%20r='1.05'%20fill='%2392dba8'/%3E%3Ccircle%20cx='98.26'%20cy='103.22'%20r='0.99'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='102.31'%20cy='104.15'%20r='1.11'%20fill='%23f2b895'/%3E%3Ccircle%20cx='107.47'%20cy='103.85'%20r='1.11'%20fill='%23efd486'/%3E%3Ccircle%20cx='111.06'%20cy='104.45'%20r='1.12'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='115.77'%20cy='103.83'%20r='1.22'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='4.14'%20cy='107.74'%20r='1.19'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='8.98'%20cy='107.48'%20r='1.12'%20fill='%23efd486'/%3E%3Ccircle%20cx='16.79'%20cy='107.28'%20r='1.01'%20fill='%2392dba8'/%3E%3Ccircle%20cx='21.79'%20cy='107.24'%20r='1.17'%20fill='%23f2b895'/%3E%3Ccircle%20cx='24.92'%20cy='107.06'%20r='0.9'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='29.71'%20cy='106.66'%20r='1.0'%20fill='%23efd486'/%3E%3Ccircle%20cx='32.95'%20cy='107.32'%20r='1.16'%20fill='%23efd486'/%3E%3Ccircle%20cx='38.56'%20cy='106.81'%20r='1.02'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='42.04'%20cy='107.17'%20r='1.01'%20fill='%23f2b895'/%3E%3Ccircle%20cx='46.24'%20cy='106.93'%20r='1.07'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='51.03'%20cy='108.02'%20r='1.04'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='54.75'%20cy='107.89'%20r='1.15'%20fill='%23f2b895'/%3E%3Ccircle%20cx='58.4'%20cy='106.66'%20r='1.02'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='62.45'%20cy='107.41'%20r='1.17'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='67.01'%20cy='107.0'%20r='1.06'%20fill='%23efd486'/%3E%3Ccircle%20cx='75.98'%20cy='106.54'%20r='1.19'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='79.97'%20cy='107.01'%20r='1.01'%20fill='%23f2b895'/%3E%3Ccircle%20cx='83.53'%20cy='107.69'%20r='1.1'%20fill='%23f2b895'/%3E%3Ccircle%20cx='87.54'%20cy='107.43'%20r='1.19'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='92.7'%20cy='106.86'%20r='1.08'%20fill='%23f2b895'/%3E%3Ccircle%20cx='97.07'%20cy='106.6'%20r='0.9'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='100.71'%20cy='106.55'%20r='1.07'%20fill='%23f2b895'/%3E%3Ccircle%20cx='104.21'%20cy='107.25'%20r='1.13'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='109.06'%20cy='107.65'%20r='0.96'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='113.44'%20cy='106.94'%20r='1.04'%20fill='%23efd486'/%3E%3Ccircle%20cx='116.94'%20cy='107.13'%20r='1.0'%20fill='%2392dba8'/%3E%3Ccircle%20cx='2.84'%20cy='111.34'%20r='0.9'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='5.76'%20cy='110.22'%20r='0.92'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='11.29'%20cy='110.57'%20r='1.04'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='13.95'%20cy='110.93'%20r='0.95'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='19.51'%20cy='110.63'%20r='1.09'%20fill='%2392dba8'/%3E%3Ccircle%20cx='22.35'%20cy='111.11'%20r='0.94'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='26.7'%20cy='110.65'%20r='0.99'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='31.09'%20cy='110.39'%20r='1.15'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='35.77'%20cy='110.22'%20r='1.22'%20fill='%23efd486'/%3E%3Ccircle%20cx='39.37'%20cy='111.23'%20r='0.98'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='43.43'%20cy='110.71'%20r='1.02'%20fill='%2392dba8'/%3E%3Ccircle%20cx='48.86'%20cy='110.5'%20r='0.98'%20fill='%23efd486'/%3E%3Ccircle%20cx='52.41'%20cy='111.43'%20r='0.92'%20fill='%23efd486'/%3E%3Ccircle%20cx='56.82'%20cy='111.46'%20r='0.94'%20fill='%23efd486'/%3E%3Ccircle%20cx='65.44'%20cy='111.65'%20r='1.09'%20fill='%23f2b895'/%3E%3Ccircle%20cx='68.7'%20cy='111.5'%20r='1.24'%20fill='%2392dba8'/%3E%3Ccircle%20cx='73.81'%20cy='110.8'%20r='0.93'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='77.91'%20cy='110.88'%20r='0.92'%20fill='%23f2b895'/%3E%3Ccircle%20cx='81.37'%20cy='111.3'%20r='1.24'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='85.5'%20cy='110.27'%20r='0.9'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='90.17'%20cy='111.67'%20r='1.19'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='94.65'%20cy='111.17'%20r='0.95'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='98.84'%20cy='110.86'%20r='1.11'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='103.49'%20cy='111.23'%20r='0.91'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='106.6'%20cy='110.93'%20r='1.21'%20fill='%23f2b895'/%3E%3Ccircle%20cx='111.05'%20cy='110.23'%20r='0.98'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='114.92'%20cy='110.58'%20r='1.05'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='4.39'%20cy='113.88'%20r='1.0'%20fill='%23f2b895'/%3E%3Ccircle%20cx='8.59'%20cy='114.66'%20r='1.1'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='16.67'%20cy='115.08'%20r='0.93'%20fill='%23f2b895'/%3E%3Ccircle%20cx='21.01'%20cy='115.05'%20r='1.03'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='25.72'%20cy='114.86'%20r='1.12'%20fill='%23f2b895'/%3E%3Ccircle%20cx='33.48'%20cy='113.99'%20r='0.93'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='46.71'%20cy='115.24'%20r='1.14'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='50.61'%20cy='113.85'%20r='1.13'%20fill='%2392dba8'/%3E%3Ccircle%20cx='55.0'%20cy='113.99'%20r='0.93'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='58.89'%20cy='114.43'%20r='0.92'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='62.23'%20cy='113.82'%20r='0.97'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='67.44'%20cy='114.34'%20r='1.04'%20fill='%23efd486'/%3E%3Ccircle%20cx='72.06'%20cy='114.97'%20r='1.12'%20fill='%23efd486'/%3E%3Ccircle%20cx='75.22'%20cy='114.09'%20r='1.1'%20fill='%23f2b895'/%3E%3Ccircle%20cx='80.43'%20cy='114.33'%20r='1.14'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='84.23'%20cy='114.27'%20r='0.99'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='87.8'%20cy='113.88'%20r='1.1'%20fill='%2392dba8'/%3E%3Ccircle%20cx='92.81'%20cy='114.21'%20r='0.95'%20fill='%23efd486'/%3E%3Ccircle%20cx='96.8'%20cy='114.94'%20r='0.9'%20fill='%2392dba8'/%3E%3Ccircle%20cx='101.0'%20cy='114.71'%20r='1.23'%20fill='%23efd486'/%3E%3Ccircle%20cx='104.65'%20cy='115.36'%20r='1.11'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='108.76'%20cy='113.82'%20r='1.15'%20fill='%23efd486'/%3E%3Ccircle%20cx='113.89'%20cy='114.25'%20r='0.95'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='117.07'%20cy='115.03'%20r='0.91'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='2.0'%20cy='118.83'%20r='0.94'%20fill='%23efd486'/%3E%3Ccircle%20cx='14.99'%20cy='118.73'%20r='1.14'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='18.94'%20cy='117.69'%20r='0.93'%20fill='%23f2b895'/%3E%3Ccircle%20cx='23.55'%20cy='118.17'%20r='1.18'%20fill='%2392dba8'/%3E%3Ccircle%20cx='27.6'%20cy='117.76'%20r='1.06'%20fill='%23f2b895'/%3E%3Ccircle%20cx='31.18'%20cy='117.84'%20r='1.23'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='35.5'%20cy='118.1'%20r='1.0'%20fill='%23f2b895'/%3E%3Ccircle%20cx='39.67'%20cy='117.65'%20r='1.09'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='44.29'%20cy='118.03'%20r='1.25'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='48.7'%20cy='118.78'%20r='1.01'%20fill='%2392dba8'/%3E%3Ccircle%20cx='52.89'%20cy='118.38'%20r='1.05'%20fill='%23f2b895'/%3E%3Ccircle%20cx='57.26'%20cy='117.84'%20r='1.03'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='65.12'%20cy='117.99'%20r='0.96'%20fill='%2392dba8'/%3E%3Ccircle%20cx='72.99'%20cy='118.32'%20r='1.18'%20fill='%2392dba8'/%3E%3Ccircle%20cx='78.27'%20cy='117.42'%20r='0.93'%20fill='%2392dba8'/%3E%3Ccircle%20cx='82.12'%20cy='118.15'%20r='1.06'%20fill='%2392dba8'/%3E%3Ccircle%20cx='85.76'%20cy='118.67'%20r='1.03'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='90.38'%20cy='118.68'%20r='1.07'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='95.28'%20cy='118.5'%20r='0.97'%20fill='%23efd486'/%3E%3Ccircle%20cx='97.97'%20cy='118.45'%20r='1.2'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='102.81'%20cy='117.75'%20r='1.07'%20fill='%2392dba8'/%3E%3Ccircle%20cx='106.73'%20cy='118.4'%20r='1.11'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='110.78'%20cy='118.4'%20r='1.23'%20fill='%23f2b895'/%3E%3Ccircle%20cx='115.11'%20cy='118.55'%20r='1.02'%20fill='%23b9a6ea'/%3E%3C/svg%3E");
  background-repeat: repeat;
  background-size: 120px 120px;
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
