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

// Foil glitter (Pokémon-card style, à la simeydotme): a static field of tiny
// specks. At rest they're barely there; a light band sweeps across and the
// specks UNDER it flash saturated iridescent colour — the shimmer lives on
// the flecks, never as a wash over the paper. Nothing animates on its own:
// the band and the hue cycle are driven by the CANVAS PAN, so the foil only
// glints while the user moves the canvas, like light raking over a card.
// Each sticky adds its own canvas position into the phase so neighbours
// glint at different moments instead of in lockstep.
const shimmerPhase = computed(() => {
  const vp = viewport.value
  return (vp.x + vp.y) * 0.7
    + (props.annotation.x + props.annotation.y) * (vp.zoom || 1) * 0.35
})
const glitterStyle = computed(() => ({
  backgroundPosition: `${shimmerPhase.value.toFixed(1)}px 0px`,
}))
// The glint layer carries TWO masks (specks ∩ moving band): the speck mask
// stays put, the band mask slides with the pan at 1.6× so it rakes across.
const glintStyle = computed(() => {
  const band = `0px 0px, ${(shimmerPhase.value * 1.6).toFixed(1)}px 0px`
  return {
    backgroundPosition: `${shimmerPhase.value.toFixed(1)}px 0px`,
    maskPosition: band,
    WebkitMaskPosition: band,
  }
})
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
      <div class="sticky-annotation__glint sticky-annotation__glint--glow" :style="glintStyle" />
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
   Two layers over one static speck field (SVG feTurbulence mask), neither
   self-animating — positions slide with the canvas pan via inline styles
   (see shimmerPhase in the script).
   - glitter: the resting flecks — the iridescent gradient through the speck
     mask at very low opacity, so the paper reads white with a faint
     texture until light hits it.
   - glint: the SAME specks, but additionally masked by a moving light band
     (mask-composite intersect), showing a saturated iridescent gradient at
     near-full opacity. Only the flecks under the band flash — the shimmer
     is on the speck, never a wash over the paper. The hue gradient slides
     with the pan too, so a fleck changes colour as the band crosses it. */
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
  /* Short hue period so one light band holds several colours at once —
     multi-colour glitter, not a monochrome streak. */
  background-size: 110px 100%;
}
.sticky-annotation__glitter {
  background-image: linear-gradient(100deg,
    #f6a5c0, #f7d08a, #a9e8bf, #9fd0f7, #cdb4f6, #f6a5c0);
  -webkit-mask-image: url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='130'%20height='130'%3E%3Cfilter%20id='s'%3E%3CfeTurbulence%20type='turbulence'%20baseFrequency='0.75'%20numOctaves='2'%20seed='11'/%3E%3CfeComponentTransfer%3E%3CfeFuncA%20type='discrete'%20tableValues='0%200%200%200%200%200%200%200%201%201%201%201%201%201%201%201%201%201%201%201'/%3E%3C/feComponentTransfer%3E%3C/filter%3E%3Crect%20width='130'%20height='130'%20filter='url(%23s)'/%3E%3C/svg%3E");
  mask-image: url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='130'%20height='130'%3E%3Cfilter%20id='s'%3E%3CfeTurbulence%20type='turbulence'%20baseFrequency='0.75'%20numOctaves='2'%20seed='11'/%3E%3CfeComponentTransfer%3E%3CfeFuncA%20type='discrete'%20tableValues='0%200%200%200%200%200%200%200%201%201%201%201%201%201%201%201%201%201%201%201'/%3E%3C/feComponentTransfer%3E%3C/filter%3E%3Crect%20width='130'%20height='130'%20filter='url(%23s)'/%3E%3C/svg%3E");
  -webkit-mask-repeat: repeat;
  mask-repeat: repeat;
  -webkit-mask-size: 130px 130px;
  mask-size: 130px 130px;
  opacity: 0.14;
}
.sticky-annotation__glint {
  background-image: linear-gradient(100deg,
    #ff5f9e, #ffbf2e, #3ddc84, #3fa9ff, #a86bff, #ff5f9e);
  -webkit-mask-image:
    url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='130'%20height='130'%3E%3Cfilter%20id='s'%3E%3CfeTurbulence%20type='turbulence'%20baseFrequency='0.75'%20numOctaves='2'%20seed='11'/%3E%3CfeComponentTransfer%3E%3CfeFuncA%20type='discrete'%20tableValues='0%200%200%200%200%200%200%200%201%201%201%201%201%201%201%201%201%201%201%201'/%3E%3C/feComponentTransfer%3E%3C/filter%3E%3Crect%20width='130'%20height='130'%20filter='url(%23s)'/%3E%3C/svg%3E"),
    linear-gradient(115deg, rgba(0, 0, 0, 0) 22%, #000 50%, rgba(0, 0, 0, 0) 78%);
  mask-image:
    url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='130'%20height='130'%3E%3Cfilter%20id='s'%3E%3CfeTurbulence%20type='turbulence'%20baseFrequency='0.75'%20numOctaves='2'%20seed='11'/%3E%3CfeComponentTransfer%3E%3CfeFuncA%20type='discrete'%20tableValues='0%200%200%200%200%200%200%200%201%201%201%201%201%201%201%201%201%201%201%201'/%3E%3C/feComponentTransfer%3E%3C/filter%3E%3Crect%20width='130'%20height='130'%20filter='url(%23s)'/%3E%3C/svg%3E"),
    linear-gradient(115deg, rgba(0, 0, 0, 0) 22%, #000 50%, rgba(0, 0, 0, 0) 78%);
  -webkit-mask-repeat: repeat, repeat;
  mask-repeat: repeat, repeat;
  -webkit-mask-size: 130px 130px, 520px 100%;
  mask-size: 130px 130px, 520px 100%;
  -webkit-mask-composite: source-in;
  mask-composite: intersect;
  opacity: 1;
}
/* Bloom: a blurred twin of the glint under it, so lit flecks glow instead
   of sitting flat on the paper. */
.sticky-annotation__glint--glow {
  filter: blur(2.5px);
  opacity: 0.9;
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
