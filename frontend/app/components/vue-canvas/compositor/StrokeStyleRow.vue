<!-- frontend/app/components/vue-canvas/compositor/StrokeStyleRow.vue -->
<script setup lang="ts">
/**
 * The outline-style rows every stroked layer shares in the Frame inspector:
 *
 *  - Wobble (`showWobble`): Off, Wave or Zigzag — a displacement of the LINE itself, so it
 *    reaches both a Band and marching Shapes. Needs a real outline to flatten, so it is
 *    hidden on text — same requirement `showStyle` already has (`strokeSupportsShapes`).
 *  - Amount / Every / Phase (`showWobbleAmount` / `showWobbleLength` / `showWobblePhase`):
 *    only mean anything once Wobble is on, so each is its own gate from the same host rule
 *    rather than a local `wobble !== 'off'` check here — the wiring test needs a real prop
 *    per row to be able to catch one wired to the wrong gate.
 *  - Corners (`showJoin`): how a stroke set at a DISTANCE turns a corner — Sharp (miter)
 *    or Rounded. Reached at a non-zero distance, because `strokeAligned` — the distance-0
 *    path — never touches `lineJoin`; ALSO reached with Wobble on, because a wobbled band
 *    flattens the outline and strokes a real path, which does honour the join. See
 *    `strokeInspectorRows`.
 *  - Align (closed shapes only): where the outline sits relative to the edge —
 *    Center (what shapes always did), Inside, Outside.
 *  - Solid / Dashed (`showDash`, on by default): picking Dashed reveals the dash and gap
 *    lengths, in pixels of the output width, exactly like every other size field here.
 *    Hidden — never greyed — for a stroke at a distance, whose band construction has no
 *    offset curve to run a dash pattern along.
 *  - Style (`showStyle`): a continuous Band, or library Shapes marching along the edge.
 *
 * Emits patches for the layer's own `strokeAlign` / `strokeDash` fields (or, in the stroke
 * stack, for one instance's); the host writes them with its usual setLocal, so undo and
 * persistence are unchanged. `showJoin` / `showStyle` / `showWobble*` are off by default, so
 * the six single-stroke call sites that predate the stack (and the wobble feature) are
 * untouched.
 *
 * Every select over an internal value carries human words — house rule: a raw slug must
 * never reach the DOM.
 */
import { computed } from 'vue'
import type { StrokeAlign, StrokeDash } from '~/composables/useCompositorLayers'
import {
  STROKE_JOIN_OPTIONS, STROKE_STYLE_OPTIONS, STROKE_WOBBLE_OPTIONS, strokeWobbleOf,
  type StrokeWobbleChoice,
} from '~/lib/compositor/strokeInspector'
import type { StrokeJoin, StrokeStyle, StrokeWobble } from '~/lib/compositor/strokeStack'

const props = withDefaults(defineProps<{
  align?: StrokeAlign
  dash?: StrokeDash
  /** Closed shapes get the Align row; a line and a text outline don't. */
  showAlign?: boolean
  /** How a distance band turns a corner. Only meaningful with `showJoin`. */
  join?: StrokeJoin
  /** Corners row — a stroke at a non-zero distance, OR any wobble on (see the header). */
  showJoin?: boolean
  /** Dash row. Default ON, so every pre-stack call site is unchanged; the stroke stack
   *  turns it off for a stroke at a distance, which the painter ignores a dash on. */
  showDash?: boolean
  /** Band or Shapes. Only meaningful with `showStyle`.
   *  NOT named `style`: Vue 3 always treats `class`/`style` as fallthrough attributes, so a
   *  prop by that name never arrives — it would land on this component's root element. */
  strokeStyle?: StrokeStyle
  /** Style row — kinds with a real outline to march shapes along (`strokeSupportsShapes`). */
  showStyle?: boolean
  /** Off / Wave / Zigzag. Only meaningful with `showWobble`. Absent ⇒ off, same convention
   *  as the stored field. */
  wobble?: StrokeWobble
  /** Wobble row — kinds with a real outline to flatten (`strokeSupportsShapes`); hidden on text. */
  showWobble?: boolean
  /** Peak deviation, same units as `width`/`dash`. Only meaningful with `showWobbleAmount`. */
  wobbleAmount?: number
  /** Amount row — only once Wobble is on. */
  showWobbleAmount?: boolean
  /** One full cycle, same units as `wobbleAmount`. Only meaningful with `showWobbleLength`. */
  wobbleLength?: number
  /** Every row — only once Wobble is on. */
  showWobbleLength?: boolean
  /** Degrees, where the cycle starts. Only meaningful with `showWobblePhase`. */
  wobblePhase?: number
  /** Phase row — only once Wobble is on. */
  showWobblePhase?: boolean
  /** Output width in px — the same scale the inspector's other size fields use. */
  outWidth: number
  /**
   * Extra multiplier folded into the px↔norm conversion. A `path` layer paints
   * inside a ctx pre-scaled by `(layer.scale||1)*W`, and stores its dash in the
   * SAME local units as `strokeWidth` (local units at scale=1 — see PathLayer),
   * so its row must divide/multiply by that scale too, or a resized path renders
   * a dash at the wrong size. Every other kind stores dash already normalized to
   * `outWidth` directly (its ctx is never pre-scaled by anything but W), so they
   * omit this and get the no-op default of 1. Ignored — normalizes to a no-op —
   * for a value that isn't a positive finite number.
   */
  scale?: number
  // `showDash` defaults TRUE here and nowhere else: Vue casts an ABSENT Boolean prop to
  // `false`, not `undefined`, so a `showDash !== false` template guard would have silently
  // removed the Dash row from all six single-stroke call sites that never pass it. Every
  // OTHER `show*` prop here — including the four wobble ones — wants that same absent-⇒-false
  // behaviour (none of those rows exist before this feature), so only `showDash` gets a
  // `withDefaults` entry.
}>(), { showDash: true })
const scale = computed(() => {
  const s = props.scale
  return typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : 1
})
const emit = defineEmits<{
  (e: 'update:align', v: StrokeAlign): void
  (e: 'update:dash', v: StrokeDash | undefined): void
  (e: 'update:join', v: StrokeJoin): void
  (e: 'update:style', v: StrokeStyle): void
  (e: 'update:wobble', v: StrokeWobbleChoice): void
  (e: 'update:wobbleAmount', v: number): void
  (e: 'update:wobbleLength', v: number): void
  (e: 'update:wobblePhase', v: number): void
}>()
const join = computed<StrokeJoin>(() => (props.join === 'round' ? 'round' : 'sharp'))
const styleValue = computed<StrokeStyle>(() => (props.strokeStyle === 'shapes' ? 'shapes' : 'band'))
const wobbleValue = computed<StrokeWobbleChoice>(() => strokeWobbleOf({ wobble: props.wobble }))
const JOIN_OPTIONS = STROKE_JOIN_OPTIONS
const STYLE_OPTIONS = STROKE_STYLE_OPTIONS
const WOBBLE_OPTIONS = STROKE_WOBBLE_OPTIONS

const align = computed<StrokeAlign>(() => (props.align === 'inside' || props.align === 'outside' ? props.align : 'center'))
const dashed = computed(() => !!props.dash)
const px = (norm: number) => Math.round(norm * props.outWidth * scale.value)
const norm = (v: number) => Math.max(0, v) / (props.outWidth * scale.value)

function setDashed(on: boolean) {
  // A first switch to Dashed needs visible marks: 12px on, 8px off.
  emit('update:dash', on ? (props.dash ?? { dash: norm(12), gap: norm(8) }) : undefined)
}
function setPart(key: 'dash' | 'gap', valuePx: number) {
  const cur = props.dash ?? { dash: norm(12), gap: norm(8) }
  emit('update:dash', { ...cur, [key]: norm(valuePx) })
}
const numClass = 'w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none'
const selClass = numClass + ' cursor-pointer'
</script>

<template>
  <div class="space-y-1.5">
    <div v-if="showWobble">
      <div class="panel-label mb-1.5">Wobble</div>
      <select :value="wobbleValue" :class="selClass" data-stroke-wobble
        @change="emit('update:wobble', ($event.target as HTMLSelectElement).value as StrokeWobbleChoice)">
        <option v-for="o in WOBBLE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </div>
    <div v-if="showWobbleAmount">
      <div class="panel-label mb-1">Amount</div>
      <input v-scrubnum type="number" min="0" step="1" :value="px(props.wobbleAmount ?? 0)" :class="numClass" data-stroke-wobble-amount
        @input="emit('update:wobbleAmount', Math.max(0, norm(parseFloat(($event.target as HTMLInputElement).value) || 0)))">
    </div>
    <div v-if="showWobbleLength">
      <div class="panel-label mb-1">Every</div>
      <input v-scrubnum type="number" min="0" step="1" :value="px(props.wobbleLength ?? 0)" :class="numClass" data-stroke-wobble-length
        @input="emit('update:wobbleLength', Math.max(0, norm(parseFloat(($event.target as HTMLInputElement).value) || 0)))">
    </div>
    <div v-if="showWobblePhase">
      <div class="panel-label mb-1">Phase</div>
      <input v-scrubnum type="number" step="1" :value="Math.round(props.wobblePhase ?? 0)" :class="numClass" data-stroke-wobble-phase
        @input="emit('update:wobblePhase', parseFloat(($event.target as HTMLInputElement).value) || 0)">
    </div>
    <div v-if="showJoin">
      <div class="panel-label mb-1.5">Corners</div>
      <select :value="join" :class="selClass" data-stroke-join
        @change="emit('update:join', ($event.target as HTMLSelectElement).value as StrokeJoin)">
        <option v-for="o in JOIN_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </div>
    <div v-if="showAlign">
      <div class="panel-label mb-1.5">Line sits</div>
      <select :value="align" :class="selClass" data-stroke-align
        @change="emit('update:align', ($event.target as HTMLSelectElement).value as StrokeAlign)">
        <option value="center">On the edge</option>
        <option value="inside">Inside the shape</option>
        <option value="outside">Outside the shape</option>
      </select>
    </div>
    <div v-if="showDash">
      <select :value="dashed ? 'dashed' : 'solid'" :class="selClass" data-stroke-dashed
        @change="setDashed(($event.target as HTMLSelectElement).value === 'dashed')">
        <option value="solid">Solid line</option>
        <option value="dashed">Dashed line</option>
      </select>
      <div v-if="dashed" class="grid grid-cols-2 gap-1.5 mt-1.5">
        <div>
          <div class="panel-label mb-1">Dash</div>
          <input v-scrubnum type="number" min="0" step="1" :value="px(props.dash!.dash)" :class="numClass" data-stroke-dash
            @input="setPart('dash', parseFloat(($event.target as HTMLInputElement).value) || 0)">
        </div>
        <div>
          <div class="panel-label mb-1">Gap</div>
          <input v-scrubnum type="number" min="0" step="1" :value="px(props.dash!.gap)" :class="numClass" data-stroke-gap
            @input="setPart('gap', parseFloat(($event.target as HTMLInputElement).value) || 0)">
        </div>
      </div>
    </div>
    <div v-if="showStyle">
      <div class="panel-label mb-1.5">Style</div>
      <select :value="styleValue" :class="selClass" data-stroke-style
        @change="emit('update:style', ($event.target as HTMLSelectElement).value as StrokeStyle)">
        <option v-for="o in STYLE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </div>
  </div>
</template>
