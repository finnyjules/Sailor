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
   in pale pastel tints (procedural SVG tile, jittered grid, ~26% coverage)
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
  background-image: url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='120'%20height='120'%3E%3Ccircle%20cx='3.7'%20cy='1.5'%20r='1.5'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='13.7'%20cy='2.1'%20r='2.1'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='31.3'%20cy='2.1'%20r='2.1'%20fill='%23f2b895'/%3E%3Ccircle%20cx='39.4'%20cy='1.4'%20r='1.4'%20fill='%2392dba8'/%3E%3Ccircle%20cx='49.4'%20cy='1.6'%20r='1.6'%20fill='%23efd486'/%3E%3Ccircle%20cx='55.3'%20cy='3.3'%20r='1.9'%20fill='%2392dba8'/%3E%3Ccircle%20cx='61.1'%20cy='1.8'%20r='1.8'%20fill='%2392dba8'/%3E%3Ccircle%20cx='70.2'%20cy='2.8'%20r='1.8'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='73.6'%20cy='4.2'%20r='1.6'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='82.7'%20cy='4.0'%20r='1.8'%20fill='%23efd486'/%3E%3Ccircle%20cx='87.1'%20cy='1.5'%20r='1.5'%20fill='%23efd486'/%3E%3Ccircle%20cx='91.0'%20cy='3.7'%20r='1.8'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='100.4'%20cy='2.3'%20r='2.0'%20fill='%23efd486'/%3E%3Ccircle%20cx='104.8'%20cy='4.5'%20r='1.9'%20fill='%23efd486'/%3E%3Ccircle%20cx='109.1'%20cy='3.9'%20r='1.9'%20fill='%23f2b895'/%3E%3Ccircle%20cx='116.8'%20cy='4.0'%20r='1.9'%20fill='%23f2b895'/%3E%3Ccircle%20cx='2.4'%20cy='9.5'%20r='2.2'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='13.9'%20cy='8.5'%20r='1.5'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='20.6'%20cy='8.0'%20r='1.5'%20fill='%2392dba8'/%3E%3Ccircle%20cx='26.0'%20cy='8.6'%20r='2.1'%20fill='%23efd486'/%3E%3Ccircle%20cx='31.8'%20cy='7.2'%20r='1.7'%20fill='%2392dba8'/%3E%3Ccircle%20cx='38.9'%20cy='9.4'%20r='1.6'%20fill='%23efd486'/%3E%3Ccircle%20cx='45.2'%20cy='9.5'%20r='1.5'%20fill='%23efd486'/%3E%3Ccircle%20cx='51.1'%20cy='9.5'%20r='2.0'%20fill='%23f2b895'/%3E%3Ccircle%20cx='58.6'%20cy='11.0'%20r='1.8'%20fill='%23f2b895'/%3E%3Ccircle%20cx='62.6'%20cy='7.3'%20r='1.7'%20fill='%23f2b895'/%3E%3Ccircle%20cx='71.1'%20cy='8.7'%20r='1.6'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='72.8'%20cy='7.5'%20r='1.4'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='79.1'%20cy='7.7'%20r='1.9'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='86.3'%20cy='8.4'%20r='1.6'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='98.9'%20cy='8.2'%20r='2.2'%20fill='%2392dba8'/%3E%3Ccircle%20cx='112.4'%20cy='7.5'%20r='1.6'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='116.4'%20cy='9.8'%20r='2.2'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='3.6'%20cy='13.2'%20r='1.6'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='7.5'%20cy='16.2'%20r='1.7'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='15.6'%20cy='15.5'%20r='1.8'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='22.3'%20cy='16.4'%20r='2.1'%20fill='%23f2b895'/%3E%3Ccircle%20cx='27.0'%20cy='16.0'%20r='1.6'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='31.7'%20cy='15.5'%20r='1.8'%20fill='%23efd486'/%3E%3Ccircle%20cx='41.1'%20cy='17.0'%20r='2.1'%20fill='%23efd486'/%3E%3Ccircle%20cx='56.9'%20cy='17.1'%20r='1.7'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='63.7'%20cy='16.3'%20r='1.8'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='68.5'%20cy='15.9'%20r='1.5'%20fill='%2392dba8'/%3E%3Ccircle%20cx='76.3'%20cy='14.3'%20r='1.5'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='80.8'%20cy='16.1'%20r='2.0'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='85.4'%20cy='13.5'%20r='1.5'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='94.4'%20cy='17.1'%20r='1.5'%20fill='%23f2b895'/%3E%3Ccircle%20cx='99.2'%20cy='12.9'%20r='1.5'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='105.1'%20cy='16.9'%20r='1.9'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='112.6'%20cy='12.9'%20r='1.6'%20fill='%2392dba8'/%3E%3Ccircle%20cx='117.4'%20cy='13.9'%20r='1.6'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='4.1'%20cy='22.7'%20r='1.4'%20fill='%23f2b895'/%3E%3Ccircle%20cx='8.7'%20cy='22.8'%20r='2.1'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='15.0'%20cy='22.6'%20r='1.5'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='22.3'%20cy='19.6'%20r='1.4'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='25.1'%20cy='21.8'%20r='1.5'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='31.3'%20cy='21.3'%20r='2.0'%20fill='%2392dba8'/%3E%3Ccircle%20cx='37.2'%20cy='20.8'%20r='1.4'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='44.8'%20cy='21.5'%20r='2.1'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='50.0'%20cy='21.0'%20r='1.6'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='57.9'%20cy='22.7'%20r='2.2'%20fill='%23efd486'/%3E%3Ccircle%20cx='61.7'%20cy='20.8'%20r='2.1'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='67.1'%20cy='19.9'%20r='1.8'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='73.3'%20cy='22.2'%20r='1.6'%20fill='%23f2b895'/%3E%3Ccircle%20cx='79.9'%20cy='19.4'%20r='1.7'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='86.6'%20cy='20.9'%20r='2.2'%20fill='%23f2b895'/%3E%3Ccircle%20cx='92.7'%20cy='21.1'%20r='1.5'%20fill='%23efd486'/%3E%3Ccircle%20cx='97.2'%20cy='20.4'%20r='1.7'%20fill='%23efd486'/%3E%3Ccircle%20cx='102.9'%20cy='20.3'%20r='1.8'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='109.3'%20cy='22.8'%20r='2.2'%20fill='%2392dba8'/%3E%3Ccircle%20cx='116.0'%20cy='19.0'%20r='1.5'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='4.4'%20cy='28.5'%20r='2.0'%20fill='%23f2b895'/%3E%3Ccircle%20cx='7.5'%20cy='28.8'%20r='1.6'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='14.0'%20cy='28.3'%20r='1.7'%20fill='%2392dba8'/%3E%3Ccircle%20cx='22.9'%20cy='27.6'%20r='1.5'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='25.8'%20cy='26.0'%20r='1.9'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='33.2'%20cy='28.9'%20r='1.7'%20fill='%23efd486'/%3E%3Ccircle%20cx='39.9'%20cy='28.9'%20r='1.4'%20fill='%2392dba8'/%3E%3Ccircle%20cx='46.9'%20cy='27.6'%20r='1.5'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='51.0'%20cy='25.6'%20r='1.6'%20fill='%23efd486'/%3E%3Ccircle%20cx='55.0'%20cy='24.9'%20r='2.2'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='62.9'%20cy='28.9'%20r='1.6'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='69.7'%20cy='27.2'%20r='1.9'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='73.7'%20cy='25.8'%20r='1.6'%20fill='%2392dba8'/%3E%3Ccircle%20cx='81.6'%20cy='26.6'%20r='2.0'%20fill='%23efd486'/%3E%3Ccircle%20cx='84.9'%20cy='27.6'%20r='2.1'%20fill='%23efd486'/%3E%3Ccircle%20cx='93.7'%20cy='26.5'%20r='1.4'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='97.9'%20cy='26.1'%20r='1.6'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='102.8'%20cy='26.4'%20r='1.6'%20fill='%23efd486'/%3E%3Ccircle%20cx='109.9'%20cy='29.0'%20r='1.8'%20fill='%23efd486'/%3E%3Ccircle%20cx='116.3'%20cy='25.2'%20r='1.5'%20fill='%23efd486'/%3E%3Ccircle%20cx='3.0'%20cy='30.8'%20r='1.6'%20fill='%23efd486'/%3E%3Ccircle%20cx='9.4'%20cy='32.5'%20r='1.5'%20fill='%23efd486'/%3E%3Ccircle%20cx='15.4'%20cy='33.1'%20r='1.6'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='22.2'%20cy='33.4'%20r='2.1'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='25.5'%20cy='34.0'%20r='2.2'%20fill='%23f2b895'/%3E%3Ccircle%20cx='33.9'%20cy='33.1'%20r='2.1'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='37.4'%20cy='33.1'%20r='2.0'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='42.9'%20cy='33.8'%20r='2.1'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='51.9'%20cy='31.8'%20r='1.9'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='62.5'%20cy='32.8'%20r='2.2'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='69.8'%20cy='33.0'%20r='1.9'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='76.9'%20cy='34.8'%20r='1.5'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='82.0'%20cy='31.9'%20r='1.5'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='88.1'%20cy='31.8'%20r='1.6'%20fill='%23f2b895'/%3E%3Ccircle%20cx='92.5'%20cy='32.9'%20r='1.8'%20fill='%23f2b895'/%3E%3Ccircle%20cx='99.6'%20cy='31.7'%20r='1.4'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='106.1'%20cy='32.1'%20r='1.6'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='110.9'%20cy='35.1'%20r='1.8'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='116.1'%20cy='33.1'%20r='1.9'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='5.2'%20cy='39.2'%20r='2.0'%20fill='%23efd486'/%3E%3Ccircle%20cx='6.9'%20cy='38.8'%20r='2.1'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='17.2'%20cy='38.5'%20r='2.2'%20fill='%2392dba8'/%3E%3Ccircle%20cx='32.4'%20cy='39.5'%20r='1.6'%20fill='%23f2b895'/%3E%3Ccircle%20cx='39.9'%20cy='37.8'%20r='2.1'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='47.0'%20cy='39.8'%20r='1.5'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='50.3'%20cy='38.2'%20r='1.5'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='56.3'%20cy='38.6'%20r='1.7'%20fill='%2392dba8'/%3E%3Ccircle%20cx='62.1'%20cy='38.4'%20r='2.1'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='67.1'%20cy='40.9'%20r='2.1'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='73.2'%20cy='40.5'%20r='1.4'%20fill='%23efd486'/%3E%3Ccircle%20cx='83.1'%20cy='38.7'%20r='1.5'%20fill='%23efd486'/%3E%3Ccircle%20cx='89.0'%20cy='40.7'%20r='1.7'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='94.7'%20cy='39.2'%20r='1.7'%20fill='%2392dba8'/%3E%3Ccircle%20cx='100.0'%20cy='38.8'%20r='1.4'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='104.9'%20cy='40.8'%20r='2.1'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='110.3'%20cy='38.1'%20r='1.8'%20fill='%23f2b895'/%3E%3Ccircle%20cx='116.6'%20cy='37.9'%20r='1.9'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='1.7'%20cy='43.5'%20r='1.7'%20fill='%2392dba8'/%3E%3Ccircle%20cx='9.2'%20cy='44.8'%20r='2.0'%20fill='%23efd486'/%3E%3Ccircle%20cx='13.4'%20cy='43.6'%20r='1.8'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='20.2'%20cy='44.4'%20r='1.8'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='28.1'%20cy='44.6'%20r='2.1'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='32.0'%20cy='46.1'%20r='1.6'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='37.4'%20cy='45.0'%20r='2.2'%20fill='%23f2b895'/%3E%3Ccircle%20cx='43.2'%20cy='46.7'%20r='2.1'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='53.0'%20cy='46.5'%20r='1.8'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='56.7'%20cy='46.2'%20r='1.5'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='60.8'%20cy='44.5'%20r='1.9'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='68.8'%20cy='46.2'%20r='1.8'%20fill='%2392dba8'/%3E%3Ccircle%20cx='75.8'%20cy='46.9'%20r='1.8'%20fill='%23f2b895'/%3E%3Ccircle%20cx='82.7'%20cy='43.2'%20r='2.1'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='94.8'%20cy='45.6'%20r='1.6'%20fill='%23efd486'/%3E%3Ccircle%20cx='99.1'%20cy='44.7'%20r='1.9'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='116.5'%20cy='43.8'%20r='1.9'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='8.0'%20cy='50.2'%20r='2.2'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='13.8'%20cy='49.9'%20r='1.8'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='18.9'%20cy='51.0'%20r='1.6'%20fill='%23f2b895'/%3E%3Ccircle%20cx='25.8'%20cy='50.7'%20r='1.5'%20fill='%23efd486'/%3E%3Ccircle%20cx='32.3'%20cy='50.7'%20r='1.4'%20fill='%23f2b895'/%3E%3Ccircle%20cx='38.1'%20cy='52.5'%20r='1.4'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='44.2'%20cy='52.4'%20r='2.2'%20fill='%2392dba8'/%3E%3Ccircle%20cx='52.7'%20cy='49.3'%20r='1.6'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='55.8'%20cy='50.6'%20r='1.5'%20fill='%23f2b895'/%3E%3Ccircle%20cx='67.0'%20cy='48.9'%20r='2.1'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='73.1'%20cy='50.5'%20r='1.4'%20fill='%23f2b895'/%3E%3Ccircle%20cx='83.2'%20cy='52.9'%20r='2.0'%20fill='%23efd486'/%3E%3Ccircle%20cx='87.1'%20cy='50.9'%20r='1.9'%20fill='%23efd486'/%3E%3Ccircle%20cx='92.4'%20cy='50.3'%20r='1.7'%20fill='%2392dba8'/%3E%3Ccircle%20cx='117.3'%20cy='52.1'%20r='2.1'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='4.4'%20cy='56.7'%20r='2.1'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='9.2'%20cy='56.8'%20r='1.6'%20fill='%23efd486'/%3E%3Ccircle%20cx='12.9'%20cy='56.6'%20r='2.1'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='20.5'%20cy='56.8'%20r='1.7'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='28.1'%20cy='58.8'%20r='1.6'%20fill='%23efd486'/%3E%3Ccircle%20cx='35.0'%20cy='55.0'%20r='1.7'%20fill='%23f2b895'/%3E%3Ccircle%20cx='38.0'%20cy='54.8'%20r='1.7'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='47.0'%20cy='55.1'%20r='2.0'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='53.0'%20cy='59.0'%20r='1.8'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='58.4'%20cy='55.4'%20r='2.1'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='64.0'%20cy='58.4'%20r='2.0'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='70.6'%20cy='56.8'%20r='1.6'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='73.7'%20cy='58.1'%20r='1.5'%20fill='%2392dba8'/%3E%3Ccircle%20cx='80.9'%20cy='57.2'%20r='1.9'%20fill='%2392dba8'/%3E%3Ccircle%20cx='89.1'%20cy='56.0'%20r='2.1'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='95.1'%20cy='59.1'%20r='1.7'%20fill='%2392dba8'/%3E%3Ccircle%20cx='99.5'%20cy='57.8'%20r='1.7'%20fill='%23f2b895'/%3E%3Ccircle%20cx='106.1'%20cy='58.2'%20r='2.0'%20fill='%23efd486'/%3E%3Ccircle%20cx='110.4'%20cy='58.0'%20r='1.9'%20fill='%2392dba8'/%3E%3Ccircle%20cx='115.8'%20cy='56.0'%20r='1.5'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='1.9'%20cy='61.9'%20r='1.5'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='9.7'%20cy='65.2'%20r='2.0'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='20.8'%20cy='62.4'%20r='1.6'%20fill='%23efd486'/%3E%3Ccircle%20cx='27.4'%20cy='64.4'%20r='1.4'%20fill='%2392dba8'/%3E%3Ccircle%20cx='34.6'%20cy='62.8'%20r='1.7'%20fill='%23efd486'/%3E%3Ccircle%20cx='36.8'%20cy='63.6'%20r='1.9'%20fill='%23f2b895'/%3E%3Ccircle%20cx='44.4'%20cy='61.4'%20r='1.6'%20fill='%2392dba8'/%3E%3Ccircle%20cx='52.0'%20cy='64.8'%20r='1.4'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='61.6'%20cy='62.2'%20r='1.9'%20fill='%2392dba8'/%3E%3Ccircle%20cx='74.6'%20cy='64.3'%20r='1.8'%20fill='%23f2b895'/%3E%3Ccircle%20cx='79.2'%20cy='61.5'%20r='1.9'%20fill='%23f2b895'/%3E%3Ccircle%20cx='87.7'%20cy='62.6'%20r='2.2'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='92.4'%20cy='62.6'%20r='1.9'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='99.6'%20cy='62.5'%20r='2.0'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='106.8'%20cy='62.7'%20r='1.4'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='118.2'%20cy='61.4'%20r='1.7'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='4.8'%20cy='67.2'%20r='1.9'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='7.6'%20cy='68.3'%20r='2.0'%20fill='%2392dba8'/%3E%3Ccircle%20cx='13.3'%20cy='69.0'%20r='2.1'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='20.1'%20cy='70.5'%20r='2.0'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='25.0'%20cy='70.9'%20r='1.8'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='40.7'%20cy='69.6'%20r='2.0'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='46.5'%20cy='70.4'%20r='1.7'%20fill='%2392dba8'/%3E%3Ccircle%20cx='52.9'%20cy='67.5'%20r='1.4'%20fill='%23efd486'/%3E%3Ccircle%20cx='58.0'%20cy='70.7'%20r='1.6'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='63.8'%20cy='69.7'%20r='2.1'%20fill='%23efd486'/%3E%3Ccircle%20cx='75.6'%20cy='68.1'%20r='1.8'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='80.5'%20cy='68.4'%20r='1.6'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='87.5'%20cy='69.0'%20r='1.4'%20fill='%2392dba8'/%3E%3Ccircle%20cx='94.4'%20cy='70.5'%20r='1.9'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='97.4'%20cy='68.7'%20r='1.5'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='105.7'%20cy='67.0'%20r='1.8'%20fill='%2392dba8'/%3E%3Ccircle%20cx='117.1'%20cy='67.0'%20r='2.0'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='4.3'%20cy='72.9'%20r='1.9'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='10.4'%20cy='73.7'%20r='2.0'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='16.3'%20cy='75.8'%20r='2.0'%20fill='%23f2b895'/%3E%3Ccircle%20cx='20.3'%20cy='76.1'%20r='1.5'%20fill='%2392dba8'/%3E%3Ccircle%20cx='28.8'%20cy='74.8'%20r='1.9'%20fill='%23efd486'/%3E%3Ccircle%20cx='31.7'%20cy='74.0'%20r='2.1'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='37.7'%20cy='74.6'%20r='1.7'%20fill='%23f2b895'/%3E%3Ccircle%20cx='46.7'%20cy='73.5'%20r='1.9'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='49.0'%20cy='76.6'%20r='2.0'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='57.8'%20cy='76.7'%20r='1.8'%20fill='%23efd486'/%3E%3Ccircle%20cx='62.5'%20cy='76.3'%20r='1.9'%20fill='%23efd486'/%3E%3Ccircle%20cx='67.4'%20cy='74.3'%20r='1.7'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='76.1'%20cy='73.0'%20r='1.5'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='83.1'%20cy='76.6'%20r='1.6'%20fill='%23f2b895'/%3E%3Ccircle%20cx='88.1'%20cy='73.8'%20r='2.0'%20fill='%23efd486'/%3E%3Ccircle%20cx='93.1'%20cy='76.7'%20r='1.7'%20fill='%2392dba8'/%3E%3Ccircle%20cx='97.0'%20cy='73.0'%20r='1.9'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='104.4'%20cy='73.8'%20r='1.5'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='110.4'%20cy='76.4'%20r='1.5'%20fill='%2392dba8'/%3E%3Ccircle%20cx='115.9'%20cy='73.5'%20r='2.1'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='8.0'%20cy='82.4'%20r='1.9'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='21.4'%20cy='81.3'%20r='2.1'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='25.9'%20cy='82.8'%20r='2.0'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='46.8'%20cy='79.3'%20r='1.5'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='49.4'%20cy='79.7'%20r='2.2'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='56.6'%20cy='81.5'%20r='1.9'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='61.0'%20cy='82.7'%20r='1.6'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='68.5'%20cy='80.7'%20r='1.8'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='83.2'%20cy='80.0'%20r='1.5'%20fill='%23f2b895'/%3E%3Ccircle%20cx='93.9'%20cy='82.5'%20r='2.0'%20fill='%23f2b895'/%3E%3Ccircle%20cx='105.8'%20cy='82.8'%20r='1.9'%20fill='%23efd486'/%3E%3Ccircle%20cx='112.7'%20cy='79.2'%20r='2.1'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='4.1'%20cy='89.0'%20r='1.6'%20fill='%23f2b895'/%3E%3Ccircle%20cx='8.5'%20cy='87.4'%20r='1.6'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='15.8'%20cy='87.7'%20r='1.9'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='21.9'%20cy='88.6'%20r='2.1'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='28.7'%20cy='88.3'%20r='1.6'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='34.8'%20cy='85.4'%20r='1.5'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='47.1'%20cy='87.9'%20r='1.5'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='57.9'%20cy='88.0'%20r='1.9'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='61.7'%20cy='89.0'%20r='2.0'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='70.6'%20cy='88.8'%20r='1.5'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='79.0'%20cy='88.5'%20r='1.5'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='88.1'%20cy='87.6'%20r='1.5'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='104.2'%20cy='86.7'%20r='1.6'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='109.0'%20cy='88.1'%20r='2.1'%20fill='%23efd486'/%3E%3Ccircle%20cx='116.9'%20cy='86.1'%20r='1.9'%20fill='%23f2b895'/%3E%3Ccircle%20cx='10.2'%20cy='92.3'%20r='1.7'%20fill='%23f2b895'/%3E%3Ccircle%20cx='22.4'%20cy='93.3'%20r='2.0'%20fill='%23efd486'/%3E%3Ccircle%20cx='25.7'%20cy='94.2'%20r='1.4'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='40.3'%20cy='91.6'%20r='1.8'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='45.1'%20cy='93.3'%20r='2.2'%20fill='%2392dba8'/%3E%3Ccircle%20cx='51.9'%20cy='93.0'%20r='1.6'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='57.0'%20cy='95.2'%20r='2.0'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='62.4'%20cy='92.6'%20r='1.9'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='68.7'%20cy='93.6'%20r='2.0'%20fill='%23efd486'/%3E%3Ccircle%20cx='76.8'%20cy='93.0'%20r='1.6'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='83.0'%20cy='91.4'%20r='1.9'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='87.6'%20cy='92.3'%20r='2.0'%20fill='%23efd486'/%3E%3Ccircle%20cx='92.8'%20cy='93.2'%20r='2.1'%20fill='%23efd486'/%3E%3Ccircle%20cx='100.2'%20cy='93.3'%20r='1.8'%20fill='%2392dba8'/%3E%3Ccircle%20cx='105.9'%20cy='93.0'%20r='1.9'%20fill='%23efd486'/%3E%3Ccircle%20cx='112.5'%20cy='91.5'%20r='2.0'%20fill='%2392dba8'/%3E%3Ccircle%20cx='117.5'%20cy='92.3'%20r='2.0'%20fill='%2392dba8'/%3E%3Ccircle%20cx='5.1'%20cy='100.0'%20r='1.6'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='7.7'%20cy='97.5'%20r='1.9'%20fill='%2392dba8'/%3E%3Ccircle%20cx='14.7'%20cy='97.7'%20r='2.0'%20fill='%23f2b895'/%3E%3Ccircle%20cx='22.7'%20cy='98.8'%20r='1.6'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='27.9'%20cy='99.0'%20r='2.0'%20fill='%23f2b895'/%3E%3Ccircle%20cx='31.9'%20cy='100.0'%20r='1.4'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='38.7'%20cy='99.3'%20r='2.1'%20fill='%23f2b895'/%3E%3Ccircle%20cx='45.7'%20cy='99.7'%20r='2.1'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='49.8'%20cy='97.6'%20r='1.9'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='57.6'%20cy='97.2'%20r='1.7'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='63.9'%20cy='97.5'%20r='1.7'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='69.5'%20cy='98.6'%20r='1.8'%20fill='%23f2b895'/%3E%3Ccircle%20cx='76.7'%20cy='98.2'%20r='2.1'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='83.1'%20cy='97.0'%20r='1.8'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='89.0'%20cy='97.7'%20r='2.0'%20fill='%23efd486'/%3E%3Ccircle%20cx='100.0'%20cy='99.1'%20r='1.8'%20fill='%23f2b895'/%3E%3Ccircle%20cx='104.3'%20cy='100.1'%20r='1.7'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='110.5'%20cy='100.2'%20r='1.9'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='117.6'%20cy='97.9'%20r='1.9'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='2.6'%20cy='104.7'%20r='1.4'%20fill='%23f2b895'/%3E%3Ccircle%20cx='7.3'%20cy='104.1'%20r='1.9'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='13.8'%20cy='106.3'%20r='1.8'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='22.9'%20cy='103.1'%20r='1.5'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='27.3'%20cy='103.8'%20r='1.8'%20fill='%2392dba8'/%3E%3Ccircle%20cx='34.4'%20cy='106.4'%20r='1.9'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='39.7'%20cy='106.2'%20r='2.0'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='44.0'%20cy='104.5'%20r='2.1'%20fill='%23efd486'/%3E%3Ccircle%20cx='50.9'%20cy='106.3'%20r='1.9'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='56.1'%20cy='104.9'%20r='1.6'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='64.7'%20cy='103.5'%20r='1.5'%20fill='%23efd486'/%3E%3Ccircle%20cx='70.4'%20cy='106.8'%20r='1.4'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='74.3'%20cy='105.4'%20r='1.8'%20fill='%23f2b895'/%3E%3Ccircle%20cx='85.9'%20cy='103.2'%20r='1.9'%20fill='%2392dba8'/%3E%3Ccircle%20cx='92.8'%20cy='106.3'%20r='1.5'%20fill='%2392dba8'/%3E%3Ccircle%20cx='97.5'%20cy='106.7'%20r='2.0'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='106.8'%20cy='105.2'%20r='1.5'%20fill='%23f2b895'/%3E%3Ccircle%20cx='111.8'%20cy='105.1'%20r='1.6'%20fill='%23f2b895'/%3E%3Ccircle%20cx='115.3'%20cy='103.3'%20r='1.9'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='3.0'%20cy='109.1'%20r='1.5'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='7.9'%20cy='109.5'%20r='2.0'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='16.5'%20cy='110.9'%20r='1.4'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='20.8'%20cy='110.7'%20r='1.6'%20fill='%23f2b895'/%3E%3Ccircle%20cx='30.9'%20cy='111.5'%20r='1.9'%20fill='%23f2b895'/%3E%3Ccircle%20cx='40.4'%20cy='109.2'%20r='2.2'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='42.9'%20cy='112.0'%20r='2.1'%20fill='%23f2b895'/%3E%3Ccircle%20cx='51.7'%20cy='110.3'%20r='1.5'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='55.7'%20cy='110.7'%20r='2.0'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='62.1'%20cy='110.4'%20r='1.4'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='68.0'%20cy='111.0'%20r='1.8'%20fill='%2392dba8'/%3E%3Ccircle%20cx='74.3'%20cy='110.2'%20r='2.0'%20fill='%23efd486'/%3E%3Ccircle%20cx='79.2'%20cy='113.2'%20r='2.2'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='87.2'%20cy='109.0'%20r='2.1'%20fill='%23efd486'/%3E%3Ccircle%20cx='106.2'%20cy='109.1'%20r='1.8'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='111.5'%20cy='111.6'%20r='1.9'%20fill='%23f2b895'/%3E%3Ccircle%20cx='115.2'%20cy='109.0'%20r='2.1'%20fill='%23f2b895'/%3E%3Ccircle%20cx='2.0'%20cy='115.6'%20r='2.0'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='10.9'%20cy='114.9'%20r='1.5'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='15.3'%20cy='115.9'%20r='2.0'%20fill='%23efd486'/%3E%3Ccircle%20cx='18.9'%20cy='117.3'%20r='1.4'%20fill='%2396cdf0'/%3E%3Ccircle%20cx='27.3'%20cy='115.0'%20r='1.4'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='33.9'%20cy='116.6'%20r='1.7'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='46.9'%20cy='118.1'%20r='1.9'%20fill='%23b9a6ea'/%3E%3Ccircle%20cx='49.2'%20cy='116.9'%20r='1.8'%20fill='%2392dba8'/%3E%3Ccircle%20cx='54.8'%20cy='117.7'%20r='1.7'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='66.9'%20cy='118.0'%20r='1.5'%20fill='%2392dba8'/%3E%3Ccircle%20cx='76.9'%20cy='116.4'%20r='2.0'%20fill='%23f2b895'/%3E%3Ccircle%20cx='82.0'%20cy='115.2'%20r='2.1'%20fill='%23f2b895'/%3E%3Ccircle%20cx='87.7'%20cy='118.2'%20r='1.8'%20fill='%23ee9fc3'/%3E%3Ccircle%20cx='90.9'%20cy='117.7'%20r='1.4'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='98.2'%20cy='117.4'%20r='1.7'%20fill='%23a7e3dc'/%3E%3Ccircle%20cx='104.2'%20cy='118.1'%20r='1.9'%20fill='%23f2b895'/%3E%3Ccircle%20cx='109.4'%20cy='118.1'%20r='1.9'%20fill='%23efd486'/%3E%3Ccircle%20cx='118.3'%20cy='116.9'%20r='1.5'%20fill='%23a7e3dc'/%3E%3C/svg%3E");
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
