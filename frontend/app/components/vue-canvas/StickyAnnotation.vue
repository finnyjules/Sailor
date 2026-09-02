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
  background-image: url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='120'%20height='120'%3E%3Ccircle%20cx='2.53'%20cy='1.64'%20r='1.46'%20fill='%23de80a0'/%3E%3Ccircle%20cx='6.25'%20cy='1.58'%20r='0.92'%20fill='%23eedddc'/%3E%3Ccircle%20cx='10.51'%20cy='2.36'%20r='1.07'%20fill='%23edc091'/%3E%3Ccircle%20cx='14.55'%20cy='2.39'%20r='1.48'%20fill='%23ebed92'/%3E%3Ccircle%20cx='18.87'%20cy='2.34'%20r='0.81'%20fill='%23dfac7e'/%3E%3Ccircle%20cx='22.77'%20cy='1.68'%20r='1.36'%20fill='%23eeebdc'/%3E%3Ccircle%20cx='31.85'%20cy='1.91'%20r='1.18'%20fill='%23cdf087'/%3E%3Ccircle%20cx='36.01'%20cy='2.33'%20r='0.83'%20fill='%2391e5aa'/%3E%3Ccircle%20cx='40.39'%20cy='1.73'%20r='1.19'%20fill='%23a5e5b9'/%3E%3Ccircle%20cx='44.44'%20cy='2.59'%20r='1.48'%20fill='%2390f5b0'/%3E%3Ccircle%20cx='48.16'%20cy='1.76'%20r='1.48'%20fill='%2338d7ee'/%3E%3Ccircle%20cx='52.19'%20cy='1.66'%20r='1.46'%20fill='%2393e2e4'/%3E%3Ccircle%20cx='56.61'%20cy='2.54'%20r='0.94'%20fill='%239cf3c0'/%3E%3Ccircle%20cx='61.11'%20cy='2.46'%20r='1.06'%20fill='%2383bee2'/%3E%3Ccircle%20cx='65.16'%20cy='2.15'%20r='1.33'%20fill='%2390bbe7'/%3E%3Ccircle%20cx='69.8'%20cy='1.64'%20r='0.94'%20fill='%2378c6e8'/%3E%3Ccircle%20cx='73.44'%20cy='2.34'%20r='1.1'%20fill='%23c0a6e8'/%3E%3Ccircle%20cx='77.34'%20cy='2.04'%20r='1.26'%20fill='%239d9ee4'/%3E%3Ccircle%20cx='81.94'%20cy='2.16'%20r='1.27'%20fill='%23a7bce7'/%3E%3Ccircle%20cx='86.4'%20cy='2.29'%20r='1.12'%20fill='%23a583e3'/%3E%3Ccircle%20cx='90.81'%20cy='1.93'%20r='0.98'%20fill='%239a8dea'/%3E%3Ccircle%20cx='94.05'%20cy='1.79'%20r='0.96'%20fill='%23ee38c6'/%3E%3Ccircle%20cx='98.27'%20cy='2.06'%20r='1.13'%20fill='%23f073a3'/%3E%3Ccircle%20cx='103.43'%20cy='2.25'%20r='0.94'%20fill='%23eedcdf'/%3E%3Ccircle%20cx='106.95'%20cy='1.71'%20r='0.96'%20fill='%23ea96ba'/%3E%3Ccircle%20cx='111.76'%20cy='2.27'%20r='0.81'%20fill='%23ee389a'/%3E%3Ccircle%20cx='115.15'%20cy='1.57'%20r='1.43'%20fill='%23ec97bb'/%3E%3Ccircle%20cx='1.7'%20cy='5.85'%20r='1.0'%20fill='%23e3998b'/%3E%3Ccircle%20cx='6.34'%20cy='6.69'%20r='1.21'%20fill='%23f2a89f'/%3E%3Ccircle%20cx='11.03'%20cy='6.83'%20r='1.41'%20fill='%23d7ee38'/%3E%3Ccircle%20cx='15.06'%20cy='5.79'%20r='1.33'%20fill='%23e89277'/%3E%3Ccircle%20cx='18.7'%20cy='6.22'%20r='0.79'%20fill='%2390eb82'/%3E%3Ccircle%20cx='23.29'%20cy='6.24'%20r='0.99'%20fill='%2382f485'/%3E%3Ccircle%20cx='27.42'%20cy='6.76'%20r='1.07'%20fill='%2382edd2'/%3E%3Ccircle%20cx='31.38'%20cy='6.17'%20r='1.38'%20fill='%238ff593'/%3E%3Ccircle%20cx='35.45'%20cy='5.94'%20r='1.25'%20fill='%2397e2a1'/%3E%3Ccircle%20cx='39.48'%20cy='5.82'%20r='1.16'%20fill='%239ce794'/%3E%3Ccircle%20cx='44.13'%20cy='5.97'%20r='1.2'%20fill='%2370f2ba'/%3E%3Ccircle%20cx='48.35'%20cy='6.62'%20r='1.12'%20fill='%23dceee1'/%3E%3Ccircle%20cx='52.94'%20cy='5.92'%20r='1.18'%20fill='%23c08bf4'/%3E%3Ccircle%20cx='57.22'%20cy='5.87'%20r='1.44'%20fill='%23dce9ee'/%3E%3Ccircle%20cx='61.4'%20cy='6.45'%20r='1.29'%20fill='%2392d8e6'/%3E%3Ccircle%20cx='65.51'%20cy='5.97'%20r='1.23'%20fill='%23dce5ee'/%3E%3Ccircle%20cx='68.99'%20cy='5.82'%20r='0.88'%20fill='%23ace9d8'/%3E%3Ccircle%20cx='77.78'%20cy='6.38'%20r='1.32'%20fill='%238f38ee'/%3E%3Ccircle%20cx='81.99'%20cy='6.31'%20r='1.02'%20fill='%23a0c2ec'/%3E%3Ccircle%20cx='86.29'%20cy='6.42'%20r='0.99'%20fill='%23da6ded'/%3E%3Ccircle%20cx='90.82'%20cy='6.43'%20r='1.19'%20fill='%23c49ced'/%3E%3Ccircle%20cx='94.6'%20cy='6.78'%20r='1.15'%20fill='%23ee389d'/%3E%3Ccircle%20cx='98.94'%20cy='6.8'%20r='1.37'%20fill='%239d92e2'/%3E%3Ccircle%20cx='102.9'%20cy='6.83'%20r='0.9'%20fill='%23ee3890'/%3E%3Ccircle%20cx='107.06'%20cy='5.93'%20r='1.41'%20fill='%23de74b8'/%3E%3Ccircle%20cx='111.6'%20cy='6.56'%20r='1.49'%20fill='%23efaa81'/%3E%3Ccircle%20cx='1.65'%20cy='10.42'%20r='1.0'%20fill='%23d0ef7d'/%3E%3Ccircle%20cx='6.56'%20cy='10.14'%20r='1.03'%20fill='%23ddeedc'/%3E%3Ccircle%20cx='10.71'%20cy='10.07'%20r='1.33'%20fill='%23f08c8c'/%3E%3Ccircle%20cx='14.85'%20cy='10.97'%20r='1.46'%20fill='%23c1efa5'/%3E%3Ccircle%20cx='19.03'%20cy='10.99'%20r='1.22'%20fill='%2393f08b'/%3E%3Ccircle%20cx='22.72'%20cy='9.96'%20r='1.0'%20fill='%23e8eedc'/%3E%3Ccircle%20cx='27.77'%20cy='10.81'%20r='1.01'%20fill='%2374efa4'/%3E%3Ccircle%20cx='31.2'%20cy='11.03'%20r='1.21'%20fill='%23eee338'/%3E%3Ccircle%20cx='35.91'%20cy='10.23'%20r='1.22'%20fill='%238cf5eb'/%3E%3Ccircle%20cx='39.51'%20cy='10.75'%20r='1.49'%20fill='%238eecbc'/%3E%3Ccircle%20cx='43.96'%20cy='10.3'%20r='0.79'%20fill='%2398db79'/%3E%3Ccircle%20cx='48.23'%20cy='10.9'%20r='0.84'%20fill='%2391e7d4'/%3E%3Ccircle%20cx='52.76'%20cy='10.63'%20r='1.09'%20fill='%239ed0f2'/%3E%3Ccircle%20cx='56.71'%20cy='10.8'%20r='0.96'%20fill='%2385b1f1'/%3E%3Ccircle%20cx='60.88'%20cy='10.75'%20r='0.78'%20fill='%237ef1c1'/%3E%3Ccircle%20cx='65.27'%20cy='10.16'%20r='1.41'%20fill='%23e9ade7'/%3E%3Ccircle%20cx='69.64'%20cy='10.23'%20r='1.32'%20fill='%23ae97e5'/%3E%3Ccircle%20cx='73.08'%20cy='10.18'%20r='1.34'%20fill='%23a598f6'/%3E%3Ccircle%20cx='77.4'%20cy='10.21'%20r='1.37'%20fill='%23a57ce2'/%3E%3Ccircle%20cx='81.56'%20cy='10.95'%20r='0.88'%20fill='%23ee38a8'/%3E%3Ccircle%20cx='85.96'%20cy='10.76'%20r='0.75'%20fill='%23eedced'/%3E%3Ccircle%20cx='90.28'%20cy='10.64'%20r='0.99'%20fill='%23ee5538'/%3E%3Ccircle%20cx='94.05'%20cy='10.16'%20r='0.85'%20fill='%23eedcdf'/%3E%3Ccircle%20cx='98.25'%20cy='10.89'%20r='0.85'%20fill='%23c866ed'/%3E%3Ccircle%20cx='107.11'%20cy='10.64'%20r='0.76'%20fill='%23de8ea2'/%3E%3Ccircle%20cx='110.79'%20cy='10.78'%20r='1.19'%20fill='%23f3e599'/%3E%3Ccircle%20cx='115.05'%20cy='10.82'%20r='1.12'%20fill='%23ec837a'/%3E%3Ccircle%20cx='2.55'%20cy='14.21'%20r='0.93'%20fill='%23dbf19f'/%3E%3Ccircle%20cx='6.31'%20cy='14.4'%20r='0.82'%20fill='%23dcb27a'/%3E%3Ccircle%20cx='10.24'%20cy='14.58'%20r='0.79'%20fill='%23a4e5b0'/%3E%3Ccircle%20cx='14.22'%20cy='14.97'%20r='1.3'%20fill='%237be085'/%3E%3Ccircle%20cx='19.21'%20cy='14.32'%20r='1.39'%20fill='%2369f2b1'/%3E%3Ccircle%20cx='22.76'%20cy='14.74'%20r='0.77'%20fill='%23bcee38'/%3E%3Ccircle%20cx='27.26'%20cy='15.16'%20r='1.02'%20fill='%23cae8a1'/%3E%3Ccircle%20cx='31.45'%20cy='14.75'%20r='1.36'%20fill='%23deeedc'/%3E%3Ccircle%20cx='36.19'%20cy='15.14'%20r='1.23'%20fill='%238cf48c'/%3E%3Ccircle%20cx='39.37'%20cy='14.77'%20r='1.41'%20fill='%2389b3f3'/%3E%3Ccircle%20cx='43.59'%20cy='14.98'%20r='0.87'%20fill='%2338e4ee'/%3E%3Ccircle%20cx='48.33'%20cy='14.53'%20r='0.9'%20fill='%2376ecb6'/%3E%3Ccircle%20cx='52.99'%20cy='14.32'%20r='1.17'%20fill='%239ddeed'/%3E%3Ccircle%20cx='56.63'%20cy='14.78'%20r='1.29'%20fill='%237974e9'/%3E%3Ccircle%20cx='61.21'%20cy='14.81'%20r='1.05'%20fill='%2338ee64'/%3E%3Ccircle%20cx='68.85'%20cy='14.96'%20r='1.27'%20fill='%23eedcea'/%3E%3Ccircle%20cx='72.97'%20cy='14.63'%20r='1.22'%20fill='%23f386c7'/%3E%3Ccircle%20cx='77.57'%20cy='14.92'%20r='1.01'%20fill='%23bc70eb'/%3E%3Ccircle%20cx='81.6'%20cy='14.28'%20r='0.99'%20fill='%23d59fe3'/%3E%3Ccircle%20cx='86.6'%20cy='15.24'%20r='0.81'%20fill='%23d990f2'/%3E%3Ccircle%20cx='93.97'%20cy='14.85'%20r='0.93'%20fill='%23db82e1'/%3E%3Ccircle%20cx='99.09'%20cy='14.69'%20r='0.93'%20fill='%23f38dce'/%3E%3Ccircle%20cx='102.44'%20cy='14.6'%20r='1.48'%20fill='%23f2ca93'/%3E%3Ccircle%20cx='107.3'%20cy='14.87'%20r='0.95'%20fill='%23efa3cb'/%3E%3Ccircle%20cx='111.39'%20cy='14.37'%20r='0.91'%20fill='%23ea9ea8'/%3E%3Ccircle%20cx='115.6'%20cy='14.41'%20r='1.03'%20fill='%23eba297'/%3E%3Ccircle%20cx='2.5'%20cy='19.07'%20r='1.08'%20fill='%23ead096'/%3E%3Ccircle%20cx='5.99'%20cy='18.41'%20r='0.8'%20fill='%23eee7dc'/%3E%3Ccircle%20cx='10.45'%20cy='18.57'%20r='1.03'%20fill='%238fee38'/%3E%3Ccircle%20cx='14.99'%20cy='18.42'%20r='1.12'%20fill='%23dceee2'/%3E%3Ccircle%20cx='19.05'%20cy='18.75'%20r='1.42'%20fill='%2365eed6'/%3E%3Ccircle%20cx='22.98'%20cy='19.34'%20r='1.34'%20fill='%23ddeedc'/%3E%3Ccircle%20cx='27.2'%20cy='19.26'%20r='1.22'%20fill='%237aee38'/%3E%3Ccircle%20cx='31.28'%20cy='18.45'%20r='0.86'%20fill='%23dceee2'/%3E%3Ccircle%20cx='35.67'%20cy='18.73'%20r='0.78'%20fill='%2338a1ee'/%3E%3Ccircle%20cx='39.72'%20cy='18.41'%20r='1.16'%20fill='%236ef2f0'/%3E%3Ccircle%20cx='43.82'%20cy='18.94'%20r='1.19'%20fill='%2384d4dc'/%3E%3Ccircle%20cx='48.11'%20cy='19.45'%20r='1.33'%20fill='%237785f0'/%3E%3Ccircle%20cx='52.91'%20cy='18.5'%20r='1.09'%20fill='%236ae0ef'/%3E%3Ccircle%20cx='56.22'%20cy='18.49'%20r='0.88'%20fill='%23dedcee'/%3E%3Ccircle%20cx='61.35'%20cy='19.07'%20r='1.07'%20fill='%23827be5'/%3E%3Ccircle%20cx='68.81'%20cy='18.9'%20r='1.45'%20fill='%233859ee'/%3E%3Ccircle%20cx='73.51'%20cy='19.15'%20r='0.78'%20fill='%23bcabe7'/%3E%3Ccircle%20cx='78.1'%20cy='18.76'%20r='1.41'%20fill='%23e38fea'/%3E%3Ccircle%20cx='81.69'%20cy='18.97'%20r='1.39'%20fill='%23e585cf'/%3E%3Ccircle%20cx='85.72'%20cy='18.95'%20r='1.29'%20fill='%23ea79c5'/%3E%3Ccircle%20cx='90.41'%20cy='18.96'%20r='1.46'%20fill='%23ee38de'/%3E%3Ccircle%20cx='94.12'%20cy='18.7'%20r='1.11'%20fill='%23d59cf4'/%3E%3Ccircle%20cx='98.59'%20cy='19.16'%20r='1.23'%20fill='%23e56ec0'/%3E%3Ccircle%20cx='102.66'%20cy='18.85'%20r='0.82'%20fill='%23ee3843'/%3E%3Ccircle%20cx='107.13'%20cy='19.07'%20r='1.08'%20fill='%23ee6238'/%3E%3Ccircle%20cx='111.25'%20cy='19.29'%20r='1.0'%20fill='%23eee2dc'/%3E%3Ccircle%20cx='115.76'%20cy='19.28'%20r='0.87'%20fill='%23e4eedc'/%3E%3Ccircle%20cx='1.69'%20cy='23.27'%20r='0.8'%20fill='%23ceee38'/%3E%3Ccircle%20cx='6.35'%20cy='22.93'%20r='1.13'%20fill='%238de084'/%3E%3Ccircle%20cx='9.97'%20cy='22.82'%20r='1.23'%20fill='%23c5f078'/%3E%3Ccircle%20cx='14.87'%20cy='23.23'%20r='1.36'%20fill='%2387e17f'/%3E%3Ccircle%20cx='18.56'%20cy='22.64'%20r='1.15'%20fill='%23e5eedc'/%3E%3Ccircle%20cx='23.23'%20cy='23.44'%20r='0.87'%20fill='%23c6e5a0'/%3E%3Ccircle%20cx='27.09'%20cy='23.3'%20r='0.86'%20fill='%238ae1a6'/%3E%3Ccircle%20cx='31.85'%20cy='22.71'%20r='1.16'%20fill='%236dee38'/%3E%3Ccircle%20cx='35.84'%20cy='23.07'%20r='1.34'%20fill='%239a9ee3'/%3E%3Ccircle%20cx='40.37'%20cy='23.1'%20r='1.08'%20fill='%2338eeb9'/%3E%3Ccircle%20cx='43.68'%20cy='22.55'%20r='1.29'%20fill='%2396b0e4'/%3E%3Ccircle%20cx='48.27'%20cy='23.62'%20r='1.13'%20fill='%2376beeb'/%3E%3Ccircle%20cx='52.53'%20cy='22.63'%20r='1.28'%20fill='%239886df'/%3E%3Ccircle%20cx='56.99'%20cy='22.71'%20r='1.09'%20fill='%23dce0ee'/%3E%3Ccircle%20cx='60.47'%20cy='22.59'%20r='1.33'%20fill='%233858ee'/%3E%3Ccircle%20cx='65.6'%20cy='22.57'%20r='0.77'%20fill='%239b6eee'/%3E%3Ccircle%20cx='69.69'%20cy='23.42'%20r='1.18'%20fill='%2372aff0'/%3E%3Ccircle%20cx='77.72'%20cy='23.09'%20r='1.31'%20fill='%23e38dec'/%3E%3Ccircle%20cx='81.87'%20cy='23.14'%20r='1.41'%20fill='%23e7a3d5'/%3E%3Ccircle%20cx='85.71'%20cy='23.12'%20r='1.0'%20fill='%23f29ece'/%3E%3Ccircle%20cx='90.76'%20cy='22.81'%20r='1.05'%20fill='%23ee386c'/%3E%3Ccircle%20cx='94.06'%20cy='22.61'%20r='1.26'%20fill='%23eea6ab'/%3E%3Ccircle%20cx='98.75'%20cy='23.32'%20r='1.1'%20fill='%23ee4338'/%3E%3Ccircle%20cx='107.43'%20cy='23.14'%20r='1.16'%20fill='%23eec838'/%3E%3Ccircle%20cx='111.07'%20cy='23.04'%20r='1.36'%20fill='%23e8d77e'/%3E%3Ccircle%20cx='115.58'%20cy='22.63'%20r='0.88'%20fill='%23eee7dc'/%3E%3Ccircle%20cx='1.85'%20cy='27.28'%20r='1.02'%20fill='%23c1ec85'/%3E%3Ccircle%20cx='6.78'%20cy='27.05'%20r='1.01'%20fill='%239ef18e'/%3E%3Ccircle%20cx='14.29'%20cy='26.97'%20r='1.43'%20fill='%2338eec7'/%3E%3Ccircle%20cx='18.9'%20cy='27.51'%20r='0.86'%20fill='%23c6f4a1'/%3E%3Ccircle%20cx='22.61'%20cy='27.07'%20r='1.12'%20fill='%2338eeb0'/%3E%3Ccircle%20cx='26.89'%20cy='27.12'%20r='1.3'%20fill='%239fe999'/%3E%3Ccircle%20cx='31.5'%20cy='27.59'%20r='1.43'%20fill='%2395cef1'/%3E%3Ccircle%20cx='35.83'%20cy='27.54'%20r='1.08'%20fill='%2382e9c7'/%3E%3Ccircle%20cx='39.42'%20cy='26.92'%20r='0.8'%20fill='%23dceeee'/%3E%3Ccircle%20cx='43.99'%20cy='27.75'%20r='1.48'%20fill='%2394f2f5'/%3E%3Ccircle%20cx='48.81'%20cy='27.13'%20r='0.75'%20fill='%23a0f6c6'/%3E%3Ccircle%20cx='52.6'%20cy='27.52'%20r='1.0'%20fill='%23eddcee'/%3E%3Ccircle%20cx='57.13'%20cy='27.7'%20r='1.38'%20fill='%23dc86e8'/%3E%3Ccircle%20cx='60.59'%20cy='27.16'%20r='1.14'%20fill='%23aa96e2'/%3E%3Ccircle%20cx='69.59'%20cy='27.84'%20r='1.09'%20fill='%23e37ff0'/%3E%3Ccircle%20cx='74.02'%20cy='27.68'%20r='1.16'%20fill='%23f5a29d'/%3E%3Ccircle%20cx='77.41'%20cy='26.96'%20r='1.06'%20fill='%23f299d7'/%3E%3Ccircle%20cx='81.37'%20cy='27.3'%20r='1.32'%20fill='%23e7adda'/%3E%3Ccircle%20cx='86.0'%20cy='27.74'%20r='1.49'%20fill='%23eda190'/%3E%3Ccircle%20cx='89.94'%20cy='26.79'%20r='1.2'%20fill='%23eaa7b4'/%3E%3Ccircle%20cx='94.32'%20cy='27.51'%20r='1.29'%20fill='%23ee3842'/%3E%3Ccircle%20cx='99.23'%20cy='27.74'%20r='0.95'%20fill='%23e498d9'/%3E%3Ccircle%20cx='102.69'%20cy='27.0'%20r='1.01'%20fill='%23b1e286'/%3E%3Ccircle%20cx='107.4'%20cy='27.07'%20r='0.95'%20fill='%23edeedc'/%3E%3Ccircle%20cx='111.09'%20cy='27.19'%20r='1.14'%20fill='%23ebda76'/%3E%3Ccircle%20cx='115.58'%20cy='27.15'%20r='1.02'%20fill='%23ccdd78'/%3E%3Ccircle%20cx='2.58'%20cy='31.09'%20r='0.9'%20fill='%23e1d592'/%3E%3Ccircle%20cx='6.83'%20cy='31.5'%20r='1.49'%20fill='%2366ec9c'/%3E%3Ccircle%20cx='10.52'%20cy='31.7'%20r='1.37'%20fill='%23caef72'/%3E%3Ccircle%20cx='15.1'%20cy='31.5'%20r='0.97'%20fill='%2397f1bd'/%3E%3Ccircle%20cx='18.87'%20cy='31.45'%20r='1.14'%20fill='%23a0ee38'/%3E%3Ccircle%20cx='22.83'%20cy='31.41'%20r='1.39'%20fill='%236beb96'/%3E%3Ccircle%20cx='27.15'%20cy='31.07'%20r='1.01'%20fill='%2397d1e9'/%3E%3Ccircle%20cx='31.44'%20cy='31.65'%20r='1.14'%20fill='%238e7be0'/%3E%3Ccircle%20cx='35.79'%20cy='31.29'%20r='0.76'%20fill='%236886f1'/%3E%3Ccircle%20cx='39.75'%20cy='31.03'%20r='0.76'%20fill='%23ba96e4'/%3E%3Ccircle%20cx='43.72'%20cy='31.51'%20r='0.88'%20fill='%23dddcee'/%3E%3Ccircle%20cx='48.72'%20cy='31.08'%20r='1.38'%20fill='%2396cee5'/%3E%3Ccircle%20cx='52.05'%20cy='30.95'%20r='1.26'%20fill='%238792e5'/%3E%3Ccircle%20cx='56.17'%20cy='31.85'%20r='1.11'%20fill='%23e338ee'/%3E%3Ccircle%20cx='60.93'%20cy='31.56'%20r='1.25'%20fill='%23bf90e5'/%3E%3Ccircle%20cx='65.25'%20cy='32.03'%20r='1.22'%20fill='%23e189c0'/%3E%3Ccircle%20cx='69.52'%20cy='31.24'%20r='1.16'%20fill='%23e38aae'/%3E%3Ccircle%20cx='73.35'%20cy='31.32'%20r='1.42'%20fill='%23e090a2'/%3E%3Ccircle%20cx='77.88'%20cy='31.86'%20r='0.93'%20fill='%23f4d187'/%3E%3Ccircle%20cx='81.5'%20cy='31.4'%20r='1.26'%20fill='%23eedce9'/%3E%3Ccircle%20cx='85.77'%20cy='31.47'%20r='1.39'%20fill='%23e289a6'/%3E%3Ccircle%20cx='90.36'%20cy='31.64'%20r='1.34'%20fill='%23e0bd90'/%3E%3Ccircle%20cx='94.62'%20cy='31.51'%20r='1.25'%20fill='%23e2a283'/%3E%3Ccircle%20cx='99.11'%20cy='31.45'%20r='0.97'%20fill='%23d5e86a'/%3E%3Ccircle%20cx='102.88'%20cy='31.4'%20r='1.01'%20fill='%23e89267'/%3E%3Ccircle%20cx='106.96'%20cy='31.15'%20r='1.06'%20fill='%23e5ee38'/%3E%3Ccircle%20cx='111.28'%20cy='31.12'%20r='1.43'%20fill='%23eec138'/%3E%3Ccircle%20cx='114.95'%20cy='31.22'%20r='1.37'%20fill='%23d3f180'/%3E%3Ccircle%20cx='2.33'%20cy='36.06'%20r='1.29'%20fill='%23a6ec81'/%3E%3Ccircle%20cx='6.12'%20cy='35.75'%20r='1.36'%20fill='%2338d8ee'/%3E%3Ccircle%20cx='10.25'%20cy='36.03'%20r='0.81'%20fill='%2338ee62'/%3E%3Ccircle%20cx='15.2'%20cy='35.62'%20r='1.32'%20fill='%239be4f2'/%3E%3Ccircle%20cx='19.15'%20cy='35.45'%20r='1.08'%20fill='%2374f3ee'/%3E%3Ccircle%20cx='23.29'%20cy='36.2'%20r='0.79'%20fill='%2397dce1'/%3E%3Ccircle%20cx='27.05'%20cy='35.29'%20r='1.06'%20fill='%2385f1c2'/%3E%3Ccircle%20cx='31.2'%20cy='35.75'%20r='1.13'%20fill='%2338eeac'/%3E%3Ccircle%20cx='36.19'%20cy='36.03'%20r='0.89'%20fill='%239eecb3'/%3E%3Ccircle%20cx='39.8'%20cy='35.8'%20r='1.19'%20fill='%239885f3'/%3E%3Ccircle%20cx='43.95'%20cy='35.79'%20r='1.08'%20fill='%237173f1'/%3E%3Ccircle%20cx='48.57'%20cy='36.11'%20r='1.08'%20fill='%23db79cb'/%3E%3Ccircle%20cx='56.19'%20cy='36.12'%20r='1.18'%20fill='%23ab76ec'/%3E%3Ccircle%20cx='60.72'%20cy='35.75'%20r='1.17'%20fill='%239b6ff3'/%3E%3Ccircle%20cx='64.59'%20cy='35.54'%20r='1.04'%20fill='%239f7bf1'/%3E%3Ccircle%20cx='68.8'%20cy='35.72'%20r='1.23'%20fill='%23ee7a7f'/%3E%3Ccircle%20cx='73.21'%20cy='35.93'%20r='1.14'%20fill='%23ee4d38'/%3E%3Ccircle%20cx='77.16'%20cy='35.91'%20r='1.36'%20fill='%23e76aae'/%3E%3Ccircle%20cx='81.64'%20cy='36.1'%20r='1.33'%20fill='%23ec7e84'/%3E%3Ccircle%20cx='90.36'%20cy='35.92'%20r='0.97'%20fill='%23ee3846'/%3E%3Ccircle%20cx='94.32'%20cy='35.83'%20r='1.42'%20fill='%23e3b091'/%3E%3Ccircle%20cx='98.78'%20cy='36.02'%20r='1.24'%20fill='%23e5b18a'/%3E%3Ccircle%20cx='103.06'%20cy='35.92'%20r='1.38'%20fill='%23d1ef81'/%3E%3Ccircle%20cx='106.67'%20cy='36.21'%20r='0.91'%20fill='%23e9d28c'/%3E%3Ccircle%20cx='115.04'%20cy='36.19'%20r='1.07'%20fill='%23dcc685'/%3E%3Ccircle%20cx='1.92'%20cy='40.14'%20r='1.25'%20fill='%23dceee0'/%3E%3Ccircle%20cx='6.1'%20cy='40.35'%20r='1.37'%20fill='%23a1f4c8'/%3E%3Ccircle%20cx='10.84'%20cy='40.08'%20r='1.26'%20fill='%23e2eedc'/%3E%3Ccircle%20cx='15.19'%20cy='40.09'%20r='0.8'%20fill='%2381d8ec'/%3E%3Ccircle%20cx='18.45'%20cy='40.27'%20r='1.09'%20fill='%2380dced'/%3E%3Ccircle%20cx='22.89'%20cy='39.55'%20r='1.19'%20fill='%2396bfeb'/%3E%3Ccircle%20cx='31.55'%20cy='39.54'%20r='0.89'%20fill='%2366ebf2'/%3E%3Ccircle%20cx='35.51'%20cy='40.36'%20r='1.43'%20fill='%23c538ee'/%3E%3Ccircle%20cx='39.93'%20cy='40.04'%20r='1.0'%20fill='%23e2dcee'/%3E%3Ccircle%20cx='43.92'%20cy='39.85'%20r='1.31'%20fill='%23a2b6ec'/%3E%3Ccircle%20cx='48.71'%20cy='39.41'%20r='1.11'%20fill='%2387a4e8'/%3E%3Ccircle%20cx='52.24'%20cy='39.83'%20r='1.42'%20fill='%23eedcea'/%3E%3Ccircle%20cx='56.55'%20cy='40.12'%20r='1.01'%20fill='%23de81c4'/%3E%3Ccircle%20cx='61.39'%20cy='39.58'%20r='1.18'%20fill='%23ef9bbe'/%3E%3Ccircle%20cx='64.73'%20cy='39.72'%20r='1.43'%20fill='%23ea92c8'/%3E%3Ccircle%20cx='69.81'%20cy='40.13'%20r='0.84'%20fill='%23ee388b'/%3E%3Ccircle%20cx='73.03'%20cy='40.07'%20r='0.84'%20fill='%23ec977a'/%3E%3Ccircle%20cx='78.1'%20cy='40.23'%20r='0.82'%20fill='%23e9bc6d'/%3E%3Ccircle%20cx='82.41'%20cy='39.48'%20r='0.93'%20fill='%23b7e86d'/%3E%3Ccircle%20cx='85.63'%20cy='40.23'%20r='1.3'%20fill='%23e2bd92'/%3E%3Ccircle%20cx='90.37'%20cy='40.27'%20r='1.35'%20fill='%23eea238'/%3E%3Ccircle%20cx='94.64'%20cy='40.27'%20r='0.99'%20fill='%23ee3938'/%3E%3Ccircle%20cx='102.53'%20cy='39.68'%20r='1.3'%20fill='%23e6b077'/%3E%3Ccircle%20cx='106.84'%20cy='39.51'%20r='1.06'%20fill='%23eec338'/%3E%3Ccircle%20cx='111.32'%20cy='39.47'%20r='0.87'%20fill='%233fee38'/%3E%3Ccircle%20cx='115.29'%20cy='39.51'%20r='0.77'%20fill='%2399eccd'/%3E%3Ccircle%20cx='6.01'%20cy='43.62'%20r='1.43'%20fill='%2397e4c4'/%3E%3Ccircle%20cx='10.96'%20cy='44.3'%20r='0.84'%20fill='%2338eec1'/%3E%3Ccircle%20cx='15.01'%20cy='44.5'%20r='1.04'%20fill='%2395bce1'/%3E%3Ccircle%20cx='19.2'%20cy='43.68'%20r='1.18'%20fill='%23e2dcee'/%3E%3Ccircle%20cx='27.05'%20cy='44.34'%20r='1.3'%20fill='%23dddcee'/%3E%3Ccircle%20cx='36.05'%20cy='43.56'%20r='1.31'%20fill='%2374b9f1'/%3E%3Ccircle%20cx='39.56'%20cy='43.76'%20r='1.34'%20fill='%23e4dcee'/%3E%3Ccircle%20cx='47.94'%20cy='44.55'%20r='1.26'%20fill='%239180e1'/%3E%3Ccircle%20cx='52.89'%20cy='43.63'%20r='1.32'%20fill='%23e4dcee'/%3E%3Ccircle%20cx='56.24'%20cy='44.62'%20r='0.88'%20fill='%23e7dcee'/%3E%3Ccircle%20cx='60.54'%20cy='44.63'%20r='1.04'%20fill='%23ec8bbf'/%3E%3Ccircle%20cx='65.07'%20cy='44.63'%20r='1.18'%20fill='%23eedce4'/%3E%3Ccircle%20cx='69.83'%20cy='44.09'%20r='0.99'%20fill='%23b469e9'/%3E%3Ccircle%20cx='73.01'%20cy='43.59'%20r='0.85'%20fill='%23eb9aa8'/%3E%3Ccircle%20cx='78.23'%20cy='43.64'%20r='0.91'%20fill='%23e9a58f'/%3E%3Ccircle%20cx='82.3'%20cy='43.77'%20r='0.84'%20fill='%23ee5138'/%3E%3Ccircle%20cx='90.27'%20cy='44.6'%20r='1.19'%20fill='%23e7e87c'/%3E%3Ccircle%20cx='94.2'%20cy='44.59'%20r='1.24'%20fill='%23efb994'/%3E%3Ccircle%20cx='98.61'%20cy='44.26'%20r='1.11'%20fill='%23bfee38'/%3E%3Ccircle%20cx='103.09'%20cy='43.65'%20r='1.29'%20fill='%23f0d49e'/%3E%3Ccircle%20cx='107.34'%20cy='44.5'%20r='0.82'%20fill='%23e1bb77'/%3E%3Ccircle%20cx='111.65'%20cy='44.18'%20r='1.34'%20fill='%23c5ed9b'/%3E%3Ccircle%20cx='115.12'%20cy='44.63'%20r='0.91'%20fill='%23f2f295'/%3E%3Ccircle%20cx='2.61'%20cy='48.37'%20r='1.46'%20fill='%237cebbd'/%3E%3Ccircle%20cx='6.17'%20cy='48.28'%20r='0.98'%20fill='%23cbe98a'/%3E%3Ccircle%20cx='10.41'%20cy='48.16'%20r='1.23'%20fill='%237decbe'/%3E%3Ccircle%20cx='14.18'%20cy='48.54'%20r='0.88'%20fill='%23dce3ee'/%3E%3Ccircle%20cx='18.46'%20cy='48.42'%20r='0.92'%20fill='%2396f3d3'/%3E%3Ccircle%20cx='22.87'%20cy='48.13'%20r='1.3'%20fill='%238cb3e6'/%3E%3Ccircle%20cx='27.81'%20cy='48.26'%20r='0.9'%20fill='%233873ee'/%3E%3Ccircle%20cx='31.49'%20cy='48.39'%20r='1.41'%20fill='%23b473e8'/%3E%3Ccircle%20cx='35.42'%20cy='48.34'%20r='1.47'%20fill='%2338eeee'/%3E%3Ccircle%20cx='39.82'%20cy='48.02'%20r='0.95'%20fill='%23e59ff1'/%3E%3Ccircle%20cx='43.72'%20cy='47.84'%20r='0.77'%20fill='%237338ee'/%3E%3Ccircle%20cx='52.68'%20cy='47.96'%20r='1.12'%20fill='%23dfdcee'/%3E%3Ccircle%20cx='56.16'%20cy='48.6'%20r='0.81'%20fill='%23ea7a92'/%3E%3Ccircle%20cx='60.69'%20cy='48.84'%20r='1.18'%20fill='%23ee3853'/%3E%3Ccircle%20cx='64.68'%20cy='48.28'%20r='1.03'%20fill='%239f7be1'/%3E%3Ccircle%20cx='74.04'%20cy='48.53'%20r='1.12'%20fill='%23ee5038'/%3E%3Ccircle%20cx='78.15'%20cy='48.6'%20r='0.75'%20fill='%23eed038'/%3E%3Ccircle%20cx='82.12'%20cy='47.87'%20r='0.83'%20fill='%23e9f69a'/%3E%3Ccircle%20cx='85.96'%20cy='48.33'%20r='1.21'%20fill='%23eccfa7'/%3E%3Ccircle%20cx='89.91'%20cy='48.3'%20r='1.45'%20fill='%23e8a881'/%3E%3Ccircle%20cx='94.38'%20cy='48.03'%20r='1.14'%20fill='%23eceedc'/%3E%3Ccircle%20cx='98.3'%20cy='48.74'%20r='1.26'%20fill='%23e4eedc'/%3E%3Ccircle%20cx='102.42'%20cy='48.51'%20r='0.89'%20fill='%2362ee38'/%3E%3Ccircle%20cx='106.86'%20cy='48.72'%20r='1.18'%20fill='%23eded98'/%3E%3Ccircle%20cx='111.25'%20cy='48.66'%20r='0.88'%20fill='%23a2eec2'/%3E%3Ccircle%20cx='115.74'%20cy='48.49'%20r='1.46'%20fill='%23b2f1a4'/%3E%3Ccircle%20cx='2.22'%20cy='52.27'%20r='1.37'%20fill='%239de7e4'/%3E%3Ccircle%20cx='6.7'%20cy='52.1'%20r='1.31'%20fill='%2386a8f4'/%3E%3Ccircle%20cx='10.99'%20cy='52.5'%20r='1.12'%20fill='%238edeb0'/%3E%3Ccircle%20cx='14.72'%20cy='52.03'%20r='0.76'%20fill='%23b138ee'/%3E%3Ccircle%20cx='18.39'%20cy='52.9'%20r='1.3'%20fill='%23b07cdb'/%3E%3Ccircle%20cx='23.12'%20cy='52.29'%20r='1.25'%20fill='%23b638ee'/%3E%3Ccircle%20cx='27.38'%20cy='52.98'%20r='1.06'%20fill='%23ab73f0'/%3E%3Ccircle%20cx='31.78'%20cy='52.41'%20r='1.26'%20fill='%23df97ec'/%3E%3Ccircle%20cx='35.74'%20cy='52.64'%20r='0.92'%20fill='%23a19af3'/%3E%3Ccircle%20cx='39.76'%20cy='52.13'%20r='0.81'%20fill='%23db82ee'/%3E%3Ccircle%20cx='44.06'%20cy='52.99'%20r='1.03'%20fill='%238238ee'/%3E%3Ccircle%20cx='48.02'%20cy='52.49'%20r='0.77'%20fill='%23e3a395'/%3E%3Ccircle%20cx='52.76'%20cy='52.85'%20r='0.82'%20fill='%23cb7eea'/%3E%3Ccircle%20cx='56.97'%20cy='52.74'%20r='0.81'%20fill='%23e490c7'/%3E%3Ccircle%20cx='61.18'%20cy='52.53'%20r='1.44'%20fill='%23de907d'/%3E%3Ccircle%20cx='64.94'%20cy='52.54'%20r='1.1'%20fill='%23e09689'/%3E%3Ccircle%20cx='69.24'%20cy='52.18'%20r='1.12'%20fill='%23d4ed7d'/%3E%3Ccircle%20cx='73.05'%20cy='52.52'%20r='1.23'%20fill='%23ee8f9f'/%3E%3Ccircle%20cx='77.55'%20cy='52.91'%20r='0.9'%20fill='%23eee0dc'/%3E%3Ccircle%20cx='81.65'%20cy='52.12'%20r='0.8'%20fill='%23ee5938'/%3E%3Ccircle%20cx='85.9'%20cy='52.11'%20r='1.27'%20fill='%23b2e472'/%3E%3Ccircle%20cx='90.23'%20cy='52.98'%20r='1.29'%20fill='%23e9f6a1'/%3E%3Ccircle%20cx='94.96'%20cy='52.82'%20r='1.22'%20fill='%23d1df71'/%3E%3Ccircle%20cx='98.24'%20cy='52.09'%20r='1.05'%20fill='%23e0e493'/%3E%3Ccircle%20cx='103.22'%20cy='53.0'%20r='1.05'%20fill='%238edf8a'/%3E%3Ccircle%20cx='107.31'%20cy='52.36'%20r='1.43'%20fill='%23e3eedc'/%3E%3Ccircle%20cx='110.76'%20cy='52.0'%20r='0.83'%20fill='%23ebc4a3'/%3E%3Ccircle%20cx='116.01'%20cy='52.13'%20r='0.79'%20fill='%237b9bdb'/%3E%3Ccircle%20cx='2.48'%20cy='56.52'%20r='0.82'%20fill='%23dceee5'/%3E%3Ccircle%20cx='6.3'%20cy='56.98'%20r='1.27'%20fill='%239aecce'/%3E%3Ccircle%20cx='10.63'%20cy='56.21'%20r='1.16'%20fill='%23c0a2f4'/%3E%3Ccircle%20cx='14.8'%20cy='56.26'%20r='1.06'%20fill='%239db1ec'/%3E%3Ccircle%20cx='19.42'%20cy='57.15'%20r='1.45'%20fill='%23dce0ee'/%3E%3Ccircle%20cx='23.28'%20cy='57.09'%20r='1.11'%20fill='%23ad80e0'/%3E%3Ccircle%20cx='26.83'%20cy='56.89'%20r='0.99'%20fill='%2384d5ed'/%3E%3Ccircle%20cx='31.5'%20cy='56.78'%20r='1.48'%20fill='%237b38ee'/%3E%3Ccircle%20cx='35.2'%20cy='57.19'%20r='1.46'%20fill='%23c699eb'/%3E%3Ccircle%20cx='39.37'%20cy='57.1'%20r='1.34'%20fill='%236e66ee'/%3E%3Ccircle%20cx='43.9'%20cy='57.06'%20r='1.37'%20fill='%23ee383a'/%3E%3Ccircle%20cx='48.57'%20cy='56.44'%20r='0.77'%20fill='%23e873d7'/%3E%3Ccircle%20cx='52.56'%20cy='56.8'%20r='1.26'%20fill='%23eedcea'/%3E%3Ccircle%20cx='56.83'%20cy='56.18'%20r='1.11'%20fill='%23e57d92'/%3E%3Ccircle%20cx='61.24'%20cy='56.33'%20r='0.93'%20fill='%23f0748f'/%3E%3Ccircle%20cx='64.91'%20cy='56.56'%20r='0.84'%20fill='%23e29f6e'/%3E%3Ccircle%20cx='69.2'%20cy='56.76'%20r='0.95'%20fill='%23f3c098'/%3E%3Ccircle%20cx='73.96'%20cy='56.47'%20r='1.09'%20fill='%23f7b89f'/%3E%3Ccircle%20cx='77.42'%20cy='56.67'%20r='1.09'%20fill='%23ece1ab'/%3E%3Ccircle%20cx='81.51'%20cy='56.23'%20r='1.31'%20fill='%2380e2b4'/%3E%3Ccircle%20cx='86.1'%20cy='56.33'%20r='0.87'%20fill='%23eecb38'/%3E%3Ccircle%20cx='90.42'%20cy='56.56'%20r='1.42'%20fill='%23a1ee38'/%3E%3Ccircle%20cx='94.27'%20cy='56.31'%20r='0.79'%20fill='%23b3f2a2'/%3E%3Ccircle%20cx='99.06'%20cy='57.13'%20r='1.37'%20fill='%23d5e4a1'/%3E%3Ccircle%20cx='103.05'%20cy='56.65'%20r='1.45'%20fill='%23eae982'/%3E%3Ccircle%20cx='107.33'%20cy='56.63'%20r='1.38'%20fill='%2382e891'/%3E%3Ccircle%20cx='111.0'%20cy='57.23'%20r='0.93'%20fill='%239ce8ad'/%3E%3Ccircle%20cx='115.25'%20cy='56.45'%20r='1.21'%20fill='%239fea99'/%3E%3Ccircle%20cx='119.22'%20cy='57.2'%20r='0.78'%20fill='%237eedd1'/%3E%3Ccircle%20cx='2.25'%20cy='60.94'%20r='1.02'%20fill='%236befa6'/%3E%3Ccircle%20cx='6.71'%20cy='60.7'%20r='0.79'%20fill='%23a1bce4'/%3E%3Ccircle%20cx='10.36'%20cy='60.95'%20r='1.0'%20fill='%23aca0f1'/%3E%3Ccircle%20cx='14.22'%20cy='60.91'%20r='1.02'%20fill='%2394e1b6'/%3E%3Ccircle%20cx='18.63'%20cy='61.37'%20r='1.09'%20fill='%233d38ee'/%3E%3Ccircle%20cx='23.28'%20cy='60.71'%20r='1.05'%20fill='%233a38ee'/%3E%3Ccircle%20cx='27.69'%20cy='60.93'%20r='1.06'%20fill='%23a138ee'/%3E%3Ccircle%20cx='31.93'%20cy='61.26'%20r='1.17'%20fill='%23f173c4'/%3E%3Ccircle%20cx='39.46'%20cy='60.57'%20r='1.42'%20fill='%23d038ee'/%3E%3Ccircle%20cx='43.72'%20cy='61.24'%20r='1.47'%20fill='%23e6a883'/%3E%3Ccircle%20cx='48.59'%20cy='60.61'%20r='1.04'%20fill='%23e7a79b'/%3E%3Ccircle%20cx='52.35'%20cy='60.6'%20r='1.06'%20fill='%23eeaf90'/%3E%3Ccircle%20cx='56.22'%20cy='60.6'%20r='1.25'%20fill='%23eedcdc'/%3E%3Ccircle%20cx='60.73'%20cy='61.38'%20r='1.23'%20fill='%23eee0dc'/%3E%3Ccircle%20cx='65.55'%20cy='61.28'%20r='1.47'%20fill='%23e18f97'/%3E%3Ccircle%20cx='69.81'%20cy='61.37'%20r='1.43'%20fill='%23e07f9c'/%3E%3Ccircle%20cx='72.98'%20cy='61.4'%20r='0.77'%20fill='%23e6c69d'/%3E%3Ccircle%20cx='78.0'%20cy='61.24'%20r='1.28'%20fill='%23bfebac'/%3E%3Ccircle%20cx='82.37'%20cy='61.31'%20r='1.08'%20fill='%23eeea38'/%3E%3Ccircle%20cx='86.58'%20cy='60.75'%20r='1.39'%20fill='%23a8ea8c'/%3E%3Ccircle%20cx='90.01'%20cy='61.35'%20r='1.24'%20fill='%23e7eedc'/%3E%3Ccircle%20cx='94.64'%20cy='61.34'%20r='1.44'%20fill='%23a5eee4'/%3E%3Ccircle%20cx='99.03'%20cy='60.56'%20r='0.83'%20fill='%2388f0ca'/%3E%3Ccircle%20cx='103.1'%20cy='60.45'%20r='1.29'%20fill='%238aee38'/%3E%3Ccircle%20cx='106.94'%20cy='60.73'%20r='1.3'%20fill='%23ddeedc'/%3E%3Ccircle%20cx='115.51'%20cy='60.68'%20r='1.17'%20fill='%23dceee9'/%3E%3Ccircle%20cx='10.57'%20cy='65.17'%20r='1.26'%20fill='%234138ee'/%3E%3Ccircle%20cx='15.17'%20cy='65.5'%20r='0.81'%20fill='%23dddcee'/%3E%3Ccircle%20cx='19.04'%20cy='65.01'%20r='1.25'%20fill='%23ee38e7'/%3E%3Ccircle%20cx='22.77'%20cy='64.66'%20r='0.85'%20fill='%23e6a7dd'/%3E%3Ccircle%20cx='26.88'%20cy='65.24'%20r='1.07'%20fill='%23ec83bb'/%3E%3Ccircle%20cx='31.95'%20cy='64.91'%20r='0.77'%20fill='%23c497e7'/%3E%3Ccircle%20cx='35.66'%20cy='64.93'%20r='1.06'%20fill='%23e189f0'/%3E%3Ccircle%20cx='39.99'%20cy='65.53'%20r='1.06'%20fill='%23db80b9'/%3E%3Ccircle%20cx='43.98'%20cy='65.05'%20r='1.35'%20fill='%23f0a0dc'/%3E%3Ccircle%20cx='48.21'%20cy='64.84'%20r='1.42'%20fill='%23e9a2ab'/%3E%3Ccircle%20cx='52.49'%20cy='65.54'%20r='1.28'%20fill='%23db7f7c'/%3E%3Ccircle%20cx='56.28'%20cy='65.31'%20r='1.37'%20fill='%23ee9385'/%3E%3Ccircle%20cx='60.68'%20cy='65.62'%20r='1.21'%20fill='%23c0f398'/%3E%3Ccircle%20cx='64.67'%20cy='65.37'%20r='0.75'%20fill='%23eaf190'/%3E%3Ccircle%20cx='68.77'%20cy='64.63'%20r='1.46'%20fill='%23b9e5a4'/%3E%3Ccircle%20cx='73.98'%20cy='64.58'%20r='1.1'%20fill='%23efcc80'/%3E%3Ccircle%20cx='78.12'%20cy='65.26'%20r='0.92'%20fill='%23e9aea8'/%3E%3Ccircle%20cx='81.44'%20cy='64.95'%20r='1.22'%20fill='%23f092a2'/%3E%3Ccircle%20cx='86.37'%20cy='65.34'%20r='1.44'%20fill='%23e0ea86'/%3E%3Ccircle%20cx='90.41'%20cy='65.64'%20r='1.05'%20fill='%2351ee38'/%3E%3Ccircle%20cx='94.96'%20cy='64.62'%20r='0.77'%20fill='%23dceede'/%3E%3Ccircle%20cx='98.74'%20cy='65.08'%20r='1.25'%20fill='%2340ee38'/%3E%3Ccircle%20cx='103.1'%20cy='64.98'%20r='1.16'%20fill='%2338ee3a'/%3E%3Ccircle%20cx='107.59'%20cy='65.26'%20r='1.13'%20fill='%237cd8df'/%3E%3Ccircle%20cx='110.76'%20cy='65.0'%20r='0.83'%20fill='%237480e9'/%3E%3Ccircle%20cx='115.38'%20cy='65.08'%20r='1.12'%20fill='%2370d2e9'/%3E%3Ccircle%20cx='1.71'%20cy='69.32'%20r='1.45'%20fill='%23e2dcee'/%3E%3Ccircle%20cx='6.72'%20cy='69.17'%20r='0.94'%20fill='%2384cde2'/%3E%3Ccircle%20cx='10.64'%20cy='69.71'%20r='1.07'%20fill='%238938ee'/%3E%3Ccircle%20cx='15.09'%20cy='68.89'%20r='0.94'%20fill='%23ce8cf0'/%3E%3Ccircle%20cx='19.42'%20cy='69.16'%20r='1.28'%20fill='%239bb5f0'/%3E%3Ccircle%20cx='23.08'%20cy='68.97'%20r='1.14'%20fill='%23da72e1'/%3E%3Ccircle%20cx='27.8'%20cy='69.62'%20r='1.02'%20fill='%23aea4ed'/%3E%3Ccircle%20cx='30.98'%20cy='68.86'%20r='0.88'%20fill='%23ee7338'/%3E%3Ccircle%20cx='36.18'%20cy='69.37'%20r='1.47'%20fill='%23e2978c'/%3E%3Ccircle%20cx='39.38'%20cy='69.61'%20r='1.33'%20fill='%23e4dcee'/%3E%3Ccircle%20cx='44.31'%20cy='69.28'%20r='0.83'%20fill='%23eedce6'/%3E%3Ccircle%20cx='48.05'%20cy='69.09'%20r='0.96'%20fill='%23f48396'/%3E%3Ccircle%20cx='52.79'%20cy='69.53'%20r='1.1'%20fill='%23dca885'/%3E%3Ccircle%20cx='56.22'%20cy='69.59'%20r='1.01'%20fill='%23ec9cb2'/%3E%3Ccircle%20cx='61.32'%20cy='69.12'%20r='1.05'%20fill='%23ee7578'/%3E%3Ccircle%20cx='65.05'%20cy='68.86'%20r='1.38'%20fill='%23e972e9'/%3E%3Ccircle%20cx='69.42'%20cy='69.6'%20r='1.22'%20fill='%23a4ee38'/%3E%3Ccircle%20cx='74.01'%20cy='69.64'%20r='1.46'%20fill='%238ad979'/%3E%3Ccircle%20cx='77.89'%20cy='69.48'%20r='1.22'%20fill='%23dfba78'/%3E%3Ccircle%20cx='81.38'%20cy='69.68'%20r='1.11'%20fill='%23e0d976'/%3E%3Ccircle%20cx='86.33'%20cy='69.34'%20r='0.77'%20fill='%23bee99d'/%3E%3Ccircle%20cx='90.5'%20cy='69.55'%20r='0.8'%20fill='%23dceedd'/%3E%3Ccircle%20cx='94.31'%20cy='69.21'%20r='1.48'%20fill='%238ee693'/%3E%3Ccircle%20cx='99.04'%20cy='69.36'%20r='1.44'%20fill='%23dceee0'/%3E%3Ccircle%20cx='102.45'%20cy='68.87'%20r='1.09'%20fill='%2378ee38'/%3E%3Ccircle%20cx='107.63'%20cy='69.64'%20r='1.09'%20fill='%23dcedee'/%3E%3Ccircle%20cx='110.84'%20cy='69.21'%20r='1.11'%20fill='%2378edda'/%3E%3Ccircle%20cx='115.62'%20cy='68.91'%20r='1.46'%20fill='%2382e0bb'/%3E%3Ccircle%20cx='1.69'%20cy='73.7'%20r='1.23'%20fill='%23dceeed'/%3E%3Ccircle%20cx='6.1'%20cy='73.4'%20r='1.31'%20fill='%238fa3e0'/%3E%3Ccircle%20cx='10.44'%20cy='74.01'%20r='0.84'%20fill='%233879ee'/%3E%3Ccircle%20cx='14.53'%20cy='73.51'%20r='1.09'%20fill='%23b099f1'/%3E%3Ccircle%20cx='18.89'%20cy='73.43'%20r='0.77'%20fill='%23ea7de9'/%3E%3Ccircle%20cx='22.7'%20cy='73.51'%20r='0.78'%20fill='%23ee38a0'/%3E%3Ccircle%20cx='27.84'%20cy='73.84'%20r='0.85'%20fill='%23a87ee3'/%3E%3Ccircle%20cx='31.83'%20cy='73.66'%20r='1.02'%20fill='%23f371b8'/%3E%3Ccircle%20cx='35.29'%20cy='73.85'%20r='1.03'%20fill='%23f37b81'/%3E%3Ccircle%20cx='40.33'%20cy='73.51'%20r='1.25'%20fill='%23f08b97'/%3E%3Ccircle%20cx='44.06'%20cy='73.1'%20r='0.91'%20fill='%23f3c687'/%3E%3Ccircle%20cx='48.61'%20cy='73.07'%20r='1.35'%20fill='%23eedfdc'/%3E%3Ccircle%20cx='52.31'%20cy='73.75'%20r='0.87'%20fill='%23eedce4'/%3E%3Ccircle%20cx='56.92'%20cy='73.18'%20r='0.89'%20fill='%23ecef9e'/%3E%3Ccircle%20cx='61.31'%20cy='73.99'%20r='1.47'%20fill='%23ea9273'/%3E%3Ccircle%20cx='65.58'%20cy='73.89'%20r='0.92'%20fill='%23ee384a'/%3E%3Ccircle%20cx='69.18'%20cy='73.36'%20r='1.16'%20fill='%23ace8ad'/%3E%3Ccircle%20cx='73.16'%20cy='73.06'%20r='0.96'%20fill='%2399f18f'/%3E%3Ccircle%20cx='77.8'%20cy='73.84'%20r='1.39'%20fill='%23baed99'/%3E%3Ccircle%20cx='82.39'%20cy='73.13'%20r='1.02'%20fill='%23c0ea70'/%3E%3Ccircle%20cx='85.73'%20cy='73.25'%20r='1.31'%20fill='%237fe28b'/%3E%3Ccircle%20cx='89.9'%20cy='72.97'%20r='1.35'%20fill='%239ac7e5'/%3E%3Ccircle%20cx='94.49'%20cy='73.89'%20r='1.48'%20fill='%2338eeb2'/%3E%3Ccircle%20cx='99.16'%20cy='73.55'%20r='1.48'%20fill='%2381dfa3'/%3E%3Ccircle%20cx='102.44'%20cy='73.59'%20r='1.3'%20fill='%23ade8ca'/%3E%3Ccircle%20cx='106.79'%20cy='73.33'%20r='1.41'%20fill='%239bf0cf'/%3E%3Ccircle%20cx='111.2'%20cy='73.17'%20r='1.26'%20fill='%2338d8ee'/%3E%3Ccircle%20cx='116.01'%20cy='73.43'%20r='1.12'%20fill='%2338b0ee'/%3E%3Ccircle%20cx='2.31'%20cy='78.0'%20r='1.1'%20fill='%23a597f5'/%3E%3Ccircle%20cx='5.91'%20cy='77.76'%20r='0.98'%20fill='%23da6df1'/%3E%3Ccircle%20cx='10.33'%20cy='77.48'%20r='0.87'%20fill='%23a084e7'/%3E%3Ccircle%20cx='14.47'%20cy='77.31'%20r='1.14'%20fill='%238767ee'/%3E%3Ccircle%20cx='18.78'%20cy='77.57'%20r='1.38'%20fill='%23a086dd'/%3E%3Ccircle%20cx='22.81'%20cy='77.97'%20r='1.37'%20fill='%23df85de'/%3E%3Ccircle%20cx='27.26'%20cy='77.33'%20r='1.42'%20fill='%23ee38ba'/%3E%3Ccircle%20cx='32.05'%20cy='77.15'%20r='1.03'%20fill='%23e9d8ab'/%3E%3Ccircle%20cx='35.56'%20cy='77.88'%20r='1.29'%20fill='%23eedce3'/%3E%3Ccircle%20cx='40.36'%20cy='77.55'%20r='1.43'%20fill='%23e582d0'/%3E%3Ccircle%20cx='44.61'%20cy='77.66'%20r='1.14'%20fill='%23e17aaa'/%3E%3Ccircle%20cx='48.68'%20cy='77.55'%20r='1.49'%20fill='%23eedce0'/%3E%3Ccircle%20cx='51.98'%20cy='77.53'%20r='1.32'%20fill='%23ebdf71'/%3E%3Ccircle%20cx='57.14'%20cy='77.42'%20r='1.38'%20fill='%23ee9638'/%3E%3Ccircle%20cx='60.86'%20cy='77.25'%20r='1.04'%20fill='%23e1ef67'/%3E%3Ccircle%20cx='65.01'%20cy='78.13'%20r='1.13'%20fill='%23cbf085'/%3E%3Ccircle%20cx='68.84'%20cy='77.52'%20r='1.2'%20fill='%23dee98c'/%3E%3Ccircle%20cx='73.42'%20cy='77.41'%20r='1.08'%20fill='%23a0f1c1'/%3E%3Ccircle%20cx='82.04'%20cy='78.16'%20r='1.12'%20fill='%23e4eedc'/%3E%3Ccircle%20cx='85.75'%20cy='77.37'%20r='1.19'%20fill='%23e1eedc'/%3E%3Ccircle%20cx='90.06'%20cy='77.52'%20r='1.04'%20fill='%238ff2c9'/%3E%3Ccircle%20cx='94.72'%20cy='78.22'%20r='1.41'%20fill='%237ff06a'/%3E%3Ccircle%20cx='98.52'%20cy='78.23'%20r='1.46'%20fill='%2381ede0'/%3E%3Ccircle%20cx='102.82'%20cy='77.19'%20r='1.46'%20fill='%2380ed82'/%3E%3Ccircle%20cx='111.11'%20cy='77.58'%20r='1.29'%20fill='%237897e2'/%3E%3Ccircle%20cx='114.96'%20cy='77.25'%20r='1.46'%20fill='%2338e9ee'/%3E%3Ccircle%20cx='2.37'%20cy='82.14'%20r='1.07'%20fill='%23a0afe7'/%3E%3Ccircle%20cx='6.58'%20cy='82.26'%20r='0.88'%20fill='%23a5afee'/%3E%3Ccircle%20cx='10.39'%20cy='81.73'%20r='1.04'%20fill='%23c396f0'/%3E%3Ccircle%20cx='15.12'%20cy='81.62'%20r='1.33'%20fill='%23ee38dd'/%3E%3Ccircle%20cx='19.08'%20cy='82.18'%20r='1.01'%20fill='%23d36dec'/%3E%3Ccircle%20cx='22.63'%20cy='82.1'%20r='0.91'%20fill='%23f4a89f'/%3E%3Ccircle%20cx='27.23'%20cy='81.96'%20r='1.13'%20fill='%23e8afe8'/%3E%3Ccircle%20cx='31.87'%20cy='82.14'%20r='1.13'%20fill='%23ee384c'/%3E%3Ccircle%20cx='35.92'%20cy='82.26'%20r='1.24'%20fill='%23ee87d9'/%3E%3Ccircle%20cx='39.94'%20cy='81.8'%20r='1.11'%20fill='%23e385a4'/%3E%3Ccircle%20cx='43.8'%20cy='82.15'%20r='0.78'%20fill='%23ddde76'/%3E%3Ccircle%20cx='48.15'%20cy='82.08'%20r='0.89'%20fill='%23ee3846'/%3E%3Ccircle%20cx='57.18'%20cy='81.59'%20r='1.49'%20fill='%23f3ed89'/%3E%3Ccircle%20cx='61.26'%20cy='81.89'%20r='1.39'%20fill='%23e4eedc'/%3E%3Ccircle%20cx='64.63'%20cy='81.71'%20r='1.0'%20fill='%23edeedc'/%3E%3Ccircle%20cx='69.17'%20cy='82.14'%20r='0.99'%20fill='%23aeed63'/%3E%3Ccircle%20cx='73.58'%20cy='81.5'%20r='1.16'%20fill='%2339ee38'/%3E%3Ccircle%20cx='77.44'%20cy='81.93'%20r='1.48'%20fill='%23adf166'/%3E%3Ccircle%20cx='81.41'%20cy='81.92'%20r='1.42'%20fill='%23a5ecad'/%3E%3Ccircle%20cx='86.37'%20cy='81.79'%20r='0.91'%20fill='%23a8e7ee'/%3E%3Ccircle%20cx='89.83'%20cy='81.74'%20r='1.17'%20fill='%2391d5e3'/%3E%3Ccircle%20cx='98.4'%20cy='82.04'%20r='0.89'%20fill='%238de2ea'/%3E%3Ccircle%20cx='107.07'%20cy='81.51'%20r='1.05'%20fill='%2338eec4'/%3E%3Ccircle%20cx='111.62'%20cy='81.59'%20r='1.4'%20fill='%2338bbee'/%3E%3Ccircle%20cx='115.72'%20cy='81.56'%20r='0.87'%20fill='%2385eeeb'/%3E%3Ccircle%20cx='2.64'%20cy='86.03'%20r='0.97'%20fill='%2393abe9'/%3E%3Ccircle%20cx='6.67'%20cy='85.89'%20r='1.15'%20fill='%23dd7bb0'/%3E%3Ccircle%20cx='10.22'%20cy='86.1'%20r='1.04'%20fill='%23ee3861'/%3E%3Ccircle%20cx='14.57'%20cy='86.58'%20r='0.8'%20fill='%23e491c0'/%3E%3Ccircle%20cx='18.71'%20cy='86.19'%20r='0.95'%20fill='%23f1a7a2'/%3E%3Ccircle%20cx='22.93'%20cy='85.69'%20r='1.44'%20fill='%23f5a2c9'/%3E%3Ccircle%20cx='27.73'%20cy='86.03'%20r='1.1'%20fill='%23e598ce'/%3E%3Ccircle%20cx='31.42'%20cy='85.99'%20r='0.83'%20fill='%23f2a972'/%3E%3Ccircle%20cx='35.86'%20cy='86.14'%20r='1.16'%20fill='%23f2aca0'/%3E%3Ccircle%20cx='40.07'%20cy='86.03'%20r='1.36'%20fill='%23c4eb8f'/%3E%3Ccircle%20cx='44.05'%20cy='86.46'%20r='0.85'%20fill='%23ee3884'/%3E%3Ccircle%20cx='48.68'%20cy='86.18'%20r='0.87'%20fill='%23eee7dc'/%3E%3Ccircle%20cx='52.17'%20cy='85.99'%20r='1.05'%20fill='%23e1eedc'/%3E%3Ccircle%20cx='56.85'%20cy='85.84'%20r='1.23'%20fill='%23e0db80'/%3E%3Ccircle%20cx='60.4'%20cy='86.44'%20r='1.27'%20fill='%23eed538'/%3E%3Ccircle%20cx='65.29'%20cy='86.01'%20r='0.87'%20fill='%23c5f28a'/%3E%3Ccircle%20cx='69.45'%20cy='85.72'%20r='0.8'%20fill='%2396f38f'/%3E%3Ccircle%20cx='73.02'%20cy='86.23'%20r='1.29'%20fill='%236ef267'/%3E%3Ccircle%20cx='77.16'%20cy='86.29'%20r='1.06'%20fill='%23dceee9'/%3E%3Ccircle%20cx='81.95'%20cy='85.82'%20r='1.14'%20fill='%23b3df7e'/%3E%3Ccircle%20cx='86.06'%20cy='86.2'%20r='1.49'%20fill='%23a1edd1'/%3E%3Ccircle%20cx='90.22'%20cy='86.06'%20r='1.03'%20fill='%2397e1ca'/%3E%3Ccircle%20cx='98.47'%20cy='86.23'%20r='1.02'%20fill='%236c77e8'/%3E%3Ccircle%20cx='102.94'%20cy='86.12'%20r='0.95'%20fill='%23adebab'/%3E%3Ccircle%20cx='107.18'%20cy='86.43'%20r='1.42'%20fill='%237ecdea'/%3E%3Ccircle%20cx='111.08'%20cy='86.45'%20r='1.2'%20fill='%238d38ee'/%3E%3Ccircle%20cx='115.13'%20cy='86.31'%20r='1.19'%20fill='%23c86cef'/%3E%3Ccircle%20cx='1.8'%20cy='90.04'%20r='1.05'%20fill='%23e56dd3'/%3E%3Ccircle%20cx='6.62'%20cy='90.28'%20r='1.12'%20fill='%23a8bce6'/%3E%3Ccircle%20cx='10.51'%20cy='90.2'%20r='1.05'%20fill='%23ee38a6'/%3E%3Ccircle%20cx='15.03'%20cy='90.77'%20r='1.36'%20fill='%23e4706e'/%3E%3Ccircle%20cx='19.41'%20cy='90.21'%20r='1.34'%20fill='%239e87df'/%3E%3Ccircle%20cx='23.58'%20cy='89.85'%20r='1.3'%20fill='%23e7bdac'/%3E%3Ccircle%20cx='27.17'%20cy='90.38'%20r='0.95'%20fill='%23ebb59c'/%3E%3Ccircle%20cx='31.68'%20cy='89.87'%20r='0.77'%20fill='%23de87e6'/%3E%3Ccircle%20cx='35.21'%20cy='90.8'%20r='0.78'%20fill='%23f39dcd'/%3E%3Ccircle%20cx='39.58'%20cy='90.23'%20r='1.43'%20fill='%23ef6e70'/%3E%3Ccircle%20cx='44.06'%20cy='90.1'%20r='0.83'%20fill='%23f4c5a2'/%3E%3Ccircle%20cx='48.09'%20cy='90.13'%20r='0.82'%20fill='%23ef62aa'/%3E%3Ccircle%20cx='52.91'%20cy='90.59'%20r='1.1'%20fill='%23ecd79a'/%3E%3Ccircle%20cx='56.61'%20cy='89.9'%20r='1.21'%20fill='%23bce57b'/%3E%3Ccircle%20cx='61.02'%20cy='89.84'%20r='1.22'%20fill='%2389f5d1'/%3E%3Ccircle%20cx='64.71'%20cy='90.5'%20r='0.8'%20fill='%2338ee63'/%3E%3Ccircle%20cx='68.8'%20cy='90.04'%20r='0.88'%20fill='%23e6eedc'/%3E%3Ccircle%20cx='73.17'%20cy='90.63'%20r='1.34'%20fill='%2393f4c8'/%3E%3Ccircle%20cx='77.61'%20cy='90.4'%20r='0.89'%20fill='%2338ee9b'/%3E%3Ccircle%20cx='81.44'%20cy='90.46'%20r='0.96'%20fill='%238eeed0'/%3E%3Ccircle%20cx='86.43'%20cy='89.89'%20r='1.31'%20fill='%2395ecdd'/%3E%3Ccircle%20cx='90.75'%20cy='90.15'%20r='1.25'%20fill='%237ab7da'/%3E%3Ccircle%20cx='93.99'%20cy='89.85'%20r='1.32'%20fill='%237fdfce'/%3E%3Ccircle%20cx='98.84'%20cy='90.04'%20r='1.3'%20fill='%23ae91ee'/%3E%3Ccircle%20cx='103.34'%20cy='90.28'%20r='0.87'%20fill='%23a3b3e6'/%3E%3Ccircle%20cx='106.72'%20cy='90.21'%20r='1.02'%20fill='%2375cddb'/%3E%3Ccircle%20cx='111.74'%20cy='89.79'%20r='1.45'%20fill='%233849ee'/%3E%3Ccircle%20cx='115.56'%20cy='90.26'%20r='1.17'%20fill='%238c7edd'/%3E%3Ccircle%20cx='2.02'%20cy='94.24'%20r='1.32'%20fill='%23f0689a'/%3E%3Ccircle%20cx='6.26'%20cy='94.92'%20r='1.3'%20fill='%23ed86f3'/%3E%3Ccircle%20cx='10.29'%20cy='94.32'%20r='0.88'%20fill='%23f276c0'/%3E%3Ccircle%20cx='14.72'%20cy='94.71'%20r='1.42'%20fill='%23be38ee'/%3E%3Ccircle%20cx='18.84'%20cy='94.64'%20r='1.36'%20fill='%23e37dc6'/%3E%3Ccircle%20cx='23.14'%20cy='94.96'%20r='0.85'%20fill='%23f5e48e'/%3E%3Ccircle%20cx='27.16'%20cy='94.05'%20r='1.42'%20fill='%23e8d6a4'/%3E%3Ccircle%20cx='31.39'%20cy='94.68'%20r='1.02'%20fill='%23e9a099'/%3E%3Ccircle%20cx='36.2'%20cy='94.34'%20r='1.08'%20fill='%23d2f07b'/%3E%3Ccircle%20cx='39.52'%20cy='94.93'%20r='0.98'%20fill='%23e6e471'/%3E%3Ccircle%20cx='43.81'%20cy='94.25'%20r='0.93'%20fill='%23f2bca4'/%3E%3Ccircle%20cx='47.97'%20cy='94.01'%20r='0.84'%20fill='%23edeedc'/%3E%3Ccircle%20cx='52.99'%20cy='94.27'%20r='1.26'%20fill='%23f0b0a2'/%3E%3Ccircle%20cx='56.83'%20cy='94.86'%20r='0.89'%20fill='%23f1dc8d'/%3E%3Ccircle%20cx='60.99'%20cy='94.69'%20r='0.84'%20fill='%23d7ef9c'/%3E%3Ccircle%20cx='65.39'%20cy='94.8'%20r='1.16'%20fill='%23ecef8c'/%3E%3Ccircle%20cx='69.47'%20cy='94.17'%20r='0.85'%20fill='%239ae993'/%3E%3Ccircle%20cx='73.07'%20cy='94.17'%20r='0.91'%20fill='%237ce5ea'/%3E%3Ccircle%20cx='77.55'%20cy='94.13'%20r='1.36'%20fill='%23e5eedc'/%3E%3Ccircle%20cx='81.86'%20cy='94.71'%20r='1.45'%20fill='%2338c0ee'/%3E%3Ccircle%20cx='86.51'%20cy='94.85'%20r='0.97'%20fill='%239eeccd'/%3E%3Ccircle%20cx='90.65'%20cy='94.26'%20r='0.87'%20fill='%2338eee7'/%3E%3Ccircle%20cx='94.26'%20cy='94.0'%20r='1.1'%20fill='%23a5caeb'/%3E%3Ccircle%20cx='98.19'%20cy='94.89'%20r='0.99'%20fill='%23dce0ee'/%3E%3Ccircle%20cx='102.91'%20cy='94.43'%20r='0.81'%20fill='%2382e6cb'/%3E%3Ccircle%20cx='106.83'%20cy='94.36'%20r='1.45'%20fill='%234138ee'/%3E%3Ccircle%20cx='115.97'%20cy='94.93'%20r='1.21'%20fill='%23a3c1e7'/%3E%3Ccircle%20cx='2.64'%20cy='98.21'%20r='1.4'%20fill='%236463f0'/%3E%3Ccircle%20cx='5.75'%20cy='98.21'%20r='1.12'%20fill='%2391d1f2'/%3E%3Ccircle%20cx='10.67'%20cy='98.62'%20r='1.25'%20fill='%23cd9cf5'/%3E%3Ccircle%20cx='14.56'%20cy='99.09'%20r='1.31'%20fill='%23dd9476'/%3E%3Ccircle%20cx='18.47'%20cy='98.78'%20r='0.99'%20fill='%23eed792'/%3E%3Ccircle%20cx='23.24'%20cy='99.13'%20r='0.96'%20fill='%23eededc'/%3E%3Ccircle%20cx='27.4'%20cy='98.84'%20r='0.9'%20fill='%23eedce6'/%3E%3Ccircle%20cx='31.31'%20cy='98.39'%20r='1.35'%20fill='%23e99da7'/%3E%3Ccircle%20cx='35.28'%20cy='99.09'%20r='1.37'%20fill='%23d7de85'/%3E%3Ccircle%20cx='39.91'%20cy='98.7'%20r='1.04'%20fill='%23ef9a6c'/%3E%3Ccircle%20cx='44.54'%20cy='98.69'%20r='0.8'%20fill='%23d3e28c'/%3E%3Ccircle%20cx='47.9'%20cy='98.43'%20r='0.93'%20fill='%23e3e9a7'/%3E%3Ccircle%20cx='52.09'%20cy='98.55'%20r='1.09'%20fill='%2399e9a9'/%3E%3Ccircle%20cx='56.19'%20cy='98.76'%20r='1.32'%20fill='%2377f080'/%3E%3Ccircle%20cx='61.19'%20cy='98.19'%20r='0.93'%20fill='%23a8ede6'/%3E%3Ccircle%20cx='65.31'%20cy='98.99'%20r='0.9'%20fill='%2371f086'/%3E%3Ccircle%20cx='69.31'%20cy='98.81'%20r='0.85'%20fill='%2370f1a6'/%3E%3Ccircle%20cx='73.3'%20cy='98.75'%20r='0.79'%20fill='%2388f59e'/%3E%3Ccircle%20cx='77.4'%20cy='98.19'%20r='1.39'%20fill='%23aef091'/%3E%3Ccircle%20cx='81.64'%20cy='99.19'%20r='1.0'%20fill='%237ec2e1'/%3E%3Ccircle%20cx='85.56'%20cy='98.21'%20r='0.84'%20fill='%236fc2ec'/%3E%3Ccircle%20cx='94.87'%20cy='98.24'%20r='1.45'%20fill='%236cef61'/%3E%3Ccircle%20cx='99.22'%20cy='98.24'%20r='0.9'%20fill='%23e9dcee'/%3E%3Ccircle%20cx='103.2'%20cy='98.29'%20r='1.34'%20fill='%2338eeeb'/%3E%3Ccircle%20cx='106.8'%20cy='99.21'%20r='1.38'%20fill='%238faeea'/%3E%3Ccircle%20cx='111.75'%20cy='99.21'%20r='1.23'%20fill='%23d397ef'/%3E%3Ccircle%20cx='6.81'%20cy='103.43'%20r='1.48'%20fill='%23e2959d'/%3E%3Ccircle%20cx='10.55'%20cy='103.42'%20r='1.23'%20fill='%23eea2bb'/%3E%3Ccircle%20cx='14.53'%20cy='103.44'%20r='1.41'%20fill='%23f08bea'/%3E%3Ccircle%20cx='18.85'%20cy='102.59'%20r='1.19'%20fill='%23ee7938'/%3E%3Ccircle%20cx='22.91'%20cy='103.4'%20r='1.33'%20fill='%23e89279'/%3E%3Ccircle%20cx='26.94'%20cy='103.15'%20r='0.96'%20fill='%23eeecdc'/%3E%3Ccircle%20cx='31.39'%20cy='103.17'%20r='1.34'%20fill='%23dcdd75'/%3E%3Ccircle%20cx='35.99'%20cy='102.43'%20r='0.84'%20fill='%23eed938'/%3E%3Ccircle%20cx='40.07'%20cy='103.11'%20r='1.23'%20fill='%23bce48c'/%3E%3Ccircle%20cx='44.28'%20cy='102.52'%20r='1.07'%20fill='%2355ee38'/%3E%3Ccircle%20cx='47.97'%20cy='103.13'%20r='1.42'%20fill='%23abeea9'/%3E%3Ccircle%20cx='52.29'%20cy='102.88'%20r='1.2'%20fill='%23d8e9a1'/%3E%3Ccircle%20cx='56.19'%20cy='102.74'%20r='1.21'%20fill='%2389f0ad'/%3E%3Ccircle%20cx='65.18'%20cy='102.81'%20r='1.29'%20fill='%233892ee'/%3E%3Ccircle%20cx='69.79'%20cy='102.92'%20r='0.87'%20fill='%23a1e8b4'/%3E%3Ccircle%20cx='73.1'%20cy='102.69'%20r='0.85'%20fill='%2377efd6'/%3E%3Ccircle%20cx='78.25'%20cy='102.8'%20r='0.98'%20fill='%238fe3d0'/%3E%3Ccircle%20cx='82.1'%20cy='103.01'%20r='1.08'%20fill='%2338eed0'/%3E%3Ccircle%20cx='85.95'%20cy='103.07'%20r='1.12'%20fill='%237ea2dd'/%3E%3Ccircle%20cx='90.8'%20cy='102.75'%20r='0.91'%20fill='%23b192ef'/%3E%3Ccircle%20cx='94.0'%20cy='102.51'%20r='0.76'%20fill='%2376c1e4'/%3E%3Ccircle%20cx='99.03'%20cy='103.2'%20r='1.23'%20fill='%23dce2ee'/%3E%3Ccircle%20cx='102.62'%20cy='102.48'%20r='0.98'%20fill='%233862ee'/%3E%3Ccircle%20cx='106.81'%20cy='103.32'%20r='0.98'%20fill='%237383e1'/%3E%3Ccircle%20cx='110.98'%20cy='103.01'%20r='1.05'%20fill='%23dd38ee'/%3E%3Ccircle%20cx='2.64'%20cy='107.47'%20r='1.3'%20fill='%23ee6ec9'/%3E%3Ccircle%20cx='6.06'%20cy='107.57'%20r='1.12'%20fill='%23f0c09c'/%3E%3Ccircle%20cx='10.34'%20cy='106.93'%20r='1.41'%20fill='%23eedcdf'/%3E%3Ccircle%20cx='14.26'%20cy='107.38'%20r='1.22'%20fill='%23db8387'/%3E%3Ccircle%20cx='19.44'%20cy='106.7'%20r='1.02'%20fill='%23eeb938'/%3E%3Ccircle%20cx='23.09'%20cy='107.23'%20r='1.44'%20fill='%23e4a3a4'/%3E%3Ccircle%20cx='26.85'%20cy='107.03'%20r='0.98'%20fill='%23eeeadc'/%3E%3Ccircle%20cx='31.94'%20cy='107.16'%20r='1.25'%20fill='%23c4ee38'/%3E%3Ccircle%20cx='35.41'%20cy='107.19'%20r='0.78'%20fill='%23dceedc'/%3E%3Ccircle%20cx='40.15'%20cy='107.16'%20r='1.29'%20fill='%23ebb7a9'/%3E%3Ccircle%20cx='44.34'%20cy='107.47'%20r='0.9'%20fill='%239be69c'/%3E%3Ccircle%20cx='48.08'%20cy='107.45'%20r='1.11'%20fill='%238ae76b'/%3E%3Ccircle%20cx='57.22'%20cy='107.36'%20r='1.47'%20fill='%23a3eed2'/%3E%3Ccircle%20cx='61.18'%20cy='107.35'%20r='1.41'%20fill='%23389fee'/%3E%3Ccircle%20cx='65.63'%20cy='107.33'%20r='1.44'%20fill='%23acdaea'/%3E%3Ccircle%20cx='69.03'%20cy='107.08'%20r='1.25'%20fill='%2338adee'/%3E%3Ccircle%20cx='73.78'%20cy='107.06'%20r='0.88'%20fill='%23dceee7'/%3E%3Ccircle%20cx='77.17'%20cy='107.09'%20r='1.03'%20fill='%23dce7ee'/%3E%3Ccircle%20cx='81.69'%20cy='107.42'%20r='0.99'%20fill='%23746fee'/%3E%3Ccircle%20cx='86.08'%20cy='107.2'%20r='1.31'%20fill='%23b493e6'/%3E%3Ccircle%20cx='90.51'%20cy='107.17'%20r='1.14'%20fill='%23a376df'/%3E%3Ccircle%20cx='94.29'%20cy='106.99'%20r='1.29'%20fill='%23f495ed'/%3E%3Ccircle%20cx='98.66'%20cy='106.94'%20r='1.12'%20fill='%23ad8fee'/%3E%3Ccircle%20cx='103.35'%20cy='107.37'%20r='1.34'%20fill='%23ce8be5'/%3E%3Ccircle%20cx='107.29'%20cy='107.37'%20r='1.48'%20fill='%23da74ef'/%3E%3Ccircle%20cx='111.03'%20cy='106.82'%20r='1.19'%20fill='%23dcf5a0'/%3E%3Ccircle%20cx='1.98'%20cy='111.56'%20r='0.77'%20fill='%23ee38bf'/%3E%3Ccircle%20cx='6.75'%20cy='111.2'%20r='1.29'%20fill='%23e3cb8b'/%3E%3Ccircle%20cx='10.71'%20cy='111.07'%20r='0.76'%20fill='%23eee9dc'/%3E%3Ccircle%20cx='14.27'%20cy='111.12'%20r='1.28'%20fill='%23f285b5'/%3E%3Ccircle%20cx='18.78'%20cy='110.97'%20r='1.48'%20fill='%23eee4dc'/%3E%3Ccircle%20cx='22.69'%20cy='111.58'%20r='0.83'%20fill='%23eedce3'/%3E%3Ccircle%20cx='27.46'%20cy='111.09'%20r='1.24'%20fill='%23d2ee92'/%3E%3Ccircle%20cx='31.6'%20cy='110.91'%20r='0.9'%20fill='%23e0e9a8'/%3E%3Ccircle%20cx='35.9'%20cy='111.68'%20r='1.06'%20fill='%23a1ee99'/%3E%3Ccircle%20cx='39.52'%20cy='110.88'%20r='0.84'%20fill='%23f5ada1'/%3E%3Ccircle%20cx='44.14'%20cy='111.13'%20r='0.92'%20fill='%23d1e38f'/%3E%3Ccircle%20cx='47.81'%20cy='111.75'%20r='0.75'%20fill='%23eee1a7'/%3E%3Ccircle%20cx='52.72'%20cy='110.82'%20r='1.12'%20fill='%23dceee3'/%3E%3Ccircle%20cx='56.59'%20cy='111.3'%20r='1.14'%20fill='%2391d3e7'/%3E%3Ccircle%20cx='60.48'%20cy='111.14'%20r='1.31'%20fill='%23b1eaaa'/%3E%3Ccircle%20cx='65.25'%20cy='111.53'%20r='0.92'%20fill='%23819cdb'/%3E%3Ccircle%20cx='69.23'%20cy='110.95'%20r='0.89'%20fill='%23bde8a3'/%3E%3Ccircle%20cx='77.21'%20cy='110.81'%20r='1.48'%20fill='%239184ee'/%3E%3Ccircle%20cx='81.46'%20cy='111.06'%20r='1.02'%20fill='%238867f0'/%3E%3Ccircle%20cx='86.17'%20cy='111.74'%20r='1.17'%20fill='%233891ee'/%3E%3Ccircle%20cx='90.03'%20cy='111.79'%20r='1.46'%20fill='%233841ee'/%3E%3Ccircle%20cx='94.58'%20cy='111.77'%20r='1.17'%20fill='%239a85e1'/%3E%3Ccircle%20cx='98.72'%20cy='110.77'%20r='1.07'%20fill='%23a438ee'/%3E%3Ccircle%20cx='102.88'%20cy='110.82'%20r='1.44'%20fill='%23b47deb'/%3E%3Ccircle%20cx='107.17'%20cy='111.62'%20r='0.89'%20fill='%239ee2f3'/%3E%3Ccircle%20cx='111.09'%20cy='111.71'%20r='0.81'%20fill='%23cb6ff3'/%3E%3Ccircle%20cx='115.59'%20cy='110.93'%20r='1.25'%20fill='%23a488e4'/%3E%3Ccircle%20cx='1.58'%20cy='115.11'%20r='1.38'%20fill='%23ea9676'/%3E%3Ccircle%20cx='6.62'%20cy='115.84'%20r='1.02'%20fill='%23e9a99c'/%3E%3Ccircle%20cx='10.49'%20cy='115.95'%20r='1.22'%20fill='%23e59dc0'/%3E%3Ccircle%20cx='14.88'%20cy='115.57'%20r='1.48'%20fill='%23eed938'/%3E%3Ccircle%20cx='19.05'%20cy='115.53'%20r='1.47'%20fill='%239fee38'/%3E%3Ccircle%20cx='27.77'%20cy='115.78'%20r='1.04'%20fill='%23b2dd8a'/%3E%3Ccircle%20cx='31.2'%20cy='115.71'%20r='1.39'%20fill='%23d8ab7b'/%3E%3Ccircle%20cx='35.92'%20cy='115.78'%20r='1.42'%20fill='%2392f1d6'/%3E%3Ccircle%20cx='43.9'%20cy='115.74'%20r='1.14'%20fill='%23ddeea4'/%3E%3Ccircle%20cx='48.08'%20cy='115.45'%20r='1.05'%20fill='%23dceee1'/%3E%3Ccircle%20cx='51.99'%20cy='115.54'%20r='1.33'%20fill='%23dceee2'/%3E%3Ccircle%20cx='57.1'%20cy='116.02'%20r='1.12'%20fill='%238889e4'/%3E%3Ccircle%20cx='61.28'%20cy='115.96'%20r='1.27'%20fill='%237fb8df'/%3E%3Ccircle%20cx='65.46'%20cy='115.88'%20r='0.89'%20fill='%2380ea7e'/%3E%3Ccircle%20cx='69.78'%20cy='115.41'%20r='1.4'%20fill='%23a7e5e6'/%3E%3Ccircle%20cx='73.75'%20cy='115.9'%20r='1.2'%20fill='%23a0d7ec'/%3E%3Ccircle%20cx='77.3'%20cy='115.6'%20r='1.17'%20fill='%23dce4ee'/%3E%3Ccircle%20cx='81.52'%20cy='115.87'%20r='1.06'%20fill='%23de97f0'/%3E%3Ccircle%20cx='85.85'%20cy='115.32'%20r='0.79'%20fill='%23389aee'/%3E%3Ccircle%20cx='90.72'%20cy='115.77'%20r='1.29'%20fill='%23b073f0'/%3E%3Ccircle%20cx='94.71'%20cy='115.9'%20r='0.95'%20fill='%23e8dcee'/%3E%3Ccircle%20cx='99.24'%20cy='115.65'%20r='1.44'%20fill='%23e97be6'/%3E%3Ccircle%20cx='102.73'%20cy='115.56'%20r='1.17'%20fill='%23e87cba'/%3E%3Ccircle%20cx='107.07'%20cy='115.97'%20r='0.9'%20fill='%23e37078'/%3E%3Ccircle%20cx='110.96'%20cy='114.99'%20r='1.35'%20fill='%237698de'/%3E%3Ccircle%20cx='115.31'%20cy='115.47'%20r='0.8'%20fill='%23ee385f'/%3E%3C/svg%3E");
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
