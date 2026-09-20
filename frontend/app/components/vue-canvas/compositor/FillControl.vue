<script setup lang="ts">
/**
 * FillControl — a single fill/stroke picker for the Frame modal that offers the
 * full Type-Studio fill set (solid / gradient / ombre / grid / noise / checkerboard
 * / stripes / qr). A swatch trigger (live preview) expands an inline panel with the
 * type dropdown, colour A/B, angle and density. Emits a `Paint`:
 *   solid → plain hex string · gradient → a compositor Gradient · else → a Fill object
 * so it drops straight into resolvePaint without new render code.
 */
import { ref, reactive, computed, inject, watch, onMounted } from 'vue'
import type { ComputedRef } from 'vue'
import { ChevronDown, Dices } from 'lucide-vue-next'
import StudioColorField from '~/components/vue-canvas/studio/StudioColorField.vue'
import GradientEditor from '~/components/vue-canvas/compositor/GradientEditor.vue'
import ShaderFillEditor from '~/components/vue-canvas/widgets/ShaderFillEditor.vue'
import { type Fill, type FillType, type ShaderSpec, type ShapeFit, SHAPE_FITS, FILL_TYPES, DEFAULT_FILL, DEFAULT_SHADER_SPEC, HOLOGRAPHIC_FILL_PRESET, fillPickerType, fillTileCanvas } from '~/lib/spacetype/fillTile'
import { rollPaintItem, gradientFromPaint } from '~/lib/compositor/fillPalette'
import { type Paint, type Gradient, type ImageFill, isFill, isGradient, isImageFill } from '~/composables/useCompositorLayers'
import type { BrandKit } from '~~/shared/brand/types'
import { brandSwatches as kitSwatches } from '~~/shared/brand/resolve'
import FillImagePicker from '~/components/vue-canvas/compositor/FillImagePicker.vue'
import { getFillBitmap, ensureFillBitmaps } from '~/lib/paint/imageFillCache'
import { imageFillRect } from '~/lib/compositor/paint'
import ShapePicker from '~/components/vue-canvas/studio/ShapePicker.vue'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'
import StudioSegmented from '~/components/vue-canvas/studio/StudioSegmented.vue'
import { shapeById } from '~/lib/shapes/catalog'
import { anchorAbove } from '~/lib/shapes/pickerLayout'

const props = withDefaults(defineProps<{
  modelValue: Paint | undefined
  allowNone?: boolean
  nested?: boolean
  allowImage?: boolean
  /** Pass-through to ShaderFillEditor's own `showAnchor` (see its doc). No default here —
   *  stays `undefined` for every existing caller, so `:show-anchor="undefined"` reaches the
   *  child and its own `showAnchor: true` default still applies untouched. Only hosts without
   *  a frame to anchor to (Shape Studio) pass `false`. */
  showAnchor?: boolean
  /** Pass-through to ShaderFillEditor's own `allowReadsBackdrop` (see its doc) — the
   *  Compositor is the only host with a real layer stack for glass to read, so it's the
   *  only caller that should ever pass `true` here, and only on primary-fill slots
   *  (`fill`/`color`), never stroke/tint/background. Default off. */
  allowReadsBackdrop?: boolean
  /** Pass-through to ShaderFillEditor's own `otherLayers` (see its doc) — the candidate
   *  list for its "A specific layer" picker. Only meaningful alongside `allowReadsBackdrop`. */
  otherLayers?: { key: string; label: string }[]
}>(), { allowNone: false, nested: false, allowImage: false, allowReadsBackdrop: false, otherLayers: () => [] })
const emit = defineEmits<{ 'update:modelValue': [Paint] }>()

/** The type list this instance offers. `nested` is set on the fill editor that
 *  ShaderFillEditor mounts for `spec.input` — excluding 'shader' there is the
 *  depth-1 nesting guard (normalizeFill, fillTile.ts) made visible in the UI
 *  rather than a user picking "shader" again and having it silently collapsed
 *  on save. */
const availableTypes = computed<FillType[]>(() => props.nested ? FILL_TYPES.filter((t) => t !== 'shader') : FILL_TYPES)
// Excludes 'image' when nested — the nested instance edits a shader's `spec.input`,
// and an ImageFill as a shader input reaches descriptor.ts's inputKey / paintTileBox,
// which do not render it (mirrors the 'shader' exclusion above for the same reason).

const open = ref(false)
const previewRef = ref<HTMLCanvasElement | null>(null)

/** Normalize whatever Paint we were handed into an editable Fill. */
function toFill(p: Paint | undefined): Fill {
  if (isImageFill(p)) return { ...DEFAULT_FILL, type: 'solid', a: '#3b82f6' }  // parked; image UI reads imageFill ref, not this
  if (isFill(p)) return { ...DEFAULT_FILL, ...p }
  if (isGradient(p)) {
    const stops = p.stops ?? []
    return {
      ...DEFAULT_FILL, type: 'gradient',
      a: stops[0]?.color ?? '#ffffff',
      b: stops[stops.length - 1]?.color ?? '#000000',
      angle: (p as { angle?: number }).angle ?? 45,
    }
  }
  const s = typeof p === 'string' && p && p !== 'none' ? p : '#3b82f6'
  return { ...DEFAULT_FILL, type: 'solid', a: s }
}

const isNone = computed(() => !!props.allowNone && (props.modelValue === 'none' || props.modelValue === '' || props.modelValue == null))

/** Normalize whatever Paint we were handed into an editable multi-stop Gradient. */
function toGrad(p: Paint | undefined, f: Fill): Gradient {
  return gradientFromPaint(p, f.a, f.b, f.angle)
}

const fill = reactive<Fill>(toFill(props.modelValue))
const grad = ref<Gradient>(toGrad(props.modelValue, fill))
watch(() => props.modelValue, (v) => { Object.assign(fill, toFill(v)); grad.value = toGrad(v, fill); drawPreview() })

// The type dropdown offers synthetic 'image' and 'holographic' entries on top of the
// Fill types. 'holographic' is a PRESET (see HOLOGRAPHIC_FILL_PRESET's doc in fillTile.ts),
// not a FILL_TYPES member — picking it assigns a whole `shader` fill in one step.
type UiType = FillType | 'image' | 'holographic'
const imageFill = ref<ImageFill | null>(isImageFill(props.modelValue) ? { ...props.modelValue } : null)
const pickerOpen = ref(false)
const currentType = computed<UiType>(() => {
  if (isImageFill(props.modelValue)) return 'image'
  return fillPickerType(fill)
})

watch(() => props.modelValue, (v) => {
  if (isImageFill(v)) { imageFill.value = { ...v }; pickerOpen.value = false }
})

function setUiType(t: UiType) {
  if (t === 'image') {
    if (!imageFill.value) { imageFill.value = { type: 'image', src: '', fit: 'cover', scale: 1, offset: { x: 0, y: 0 } }; pickerOpen.value = true }
    emit('update:modelValue', { ...imageFill.value })
    return
  }
  if (t === 'holographic') {
    // One-click preset: assigns the whole shader fill, same pattern as `shuffle` below
    // (Object.assign onto the reactive `fill`, then emit via paintFromFill).
    imageFill.value = null
    Object.assign(fill, structuredClone(HOLOGRAPHIC_FILL_PRESET))
    push()
    return
  }
  // leaving image → fall back to the normal Fill path
  imageFill.value = null
  // Leaving 'holographic' via the plain 'shader' option: fill.shader is already set
  // (to the holographic_surface spec), so setType's `!fill.shader` guard below would
  // never reseed it and the picker would appear stuck on Holographic. Reseed here so
  // the select actually lands on a plain shader fill.
  if (t === 'shader' && fill.shader?.effectId === 'holographic_surface') fill.shader = structuredClone(DEFAULT_SHADER_SPEC)
  setType(t as FillType)
}

function pushImage(patch: Partial<ImageFill>) {
  const next: ImageFill = { type: 'image', src: '', fit: 'cover', scale: 1, offset: { x: 0, y: 0 }, ...imageFill.value, ...patch }
  imageFill.value = next
  emit('update:modelValue', { ...next })
}
function onPick(src: string) { pickerOpen.value = false; pushImage({ src }) }

const uiTypes = computed<UiType[]>(() => {
  // 'holographic' is a shader fill under the hood (see setUiType/currentType), so it
  // gets the same depth-1 nesting exclusion as 'shader' itself in availableTypes.
  const types: UiType[] = props.nested ? [...availableTypes.value] : [...availableTypes.value, 'holographic']
  return (props.allowImage && !props.nested) ? [...types, 'image'] : types
})

/** Editable Fill → the Paint we emit (solid → hex, patterns → Fill object). Gradient
 *  is emitted from `grad` (the native multi-stop Gradient), not collapsed here.
 *  Spreads `f` rather than listing fields — a shader fill's `.shader` spec (or any
 *  field added later) must survive round-tripping through this control, not be
 *  silently dropped by an incomplete field list (see Task 6's known-blocker note). */
function paintFromFill(f: Fill): Paint {
  if (f.type === 'solid') return f.a
  return { ...f }
}
function push() {
  if (!isNone.value) emit('update:modelValue', fill.type === 'gradient' ? grad.value : paintFromFill(fill))
  drawPreview()
}
function setType(t: FillType) {
  // Switching INTO gradient seeds it from the current colours; an authored gradient
  // is preserved while you stay on the gradient type.
  if (t === 'gradient' && fill.type !== 'gradient') grad.value = toGrad(undefined, fill)
  // Switching INTO shader seeds a fresh spec (cloned — DEFAULT_SHADER_SPEC is a
  // shared module constant, never mutated in place) so the editor has something
  // real to bind to immediately, rather than relying on the `?? DEFAULT_SHADER_SPEC`
  // fallback below until the user's first edit.
  if (t === 'shader' && !fill.shader) fill.shader = structuredClone(DEFAULT_SHADER_SPEC)
  // Switching INTO shapes seeds a default library shape plus Size/Spacing so the tile
  // and both dials have real values immediately, rather than the fallbacks inside
  // fillTileCanvas / paintShapesTile.
  if (t === 'shapes') {
    if (!fill.shapeId) fill.shapeId = 'sparkle'
    if (!fill.shapeFit) fill.shapeFit = 'tile'
    fill.shapeSize = 0.1
    fill.shapeGap = 0.03
  }
  // Switching INTO paper seeds a grain amount plus tasteful paper colours + a fine grain scale,
  // but only overwrites colours/density still at their solid defaults (never a user's own values).
  if (t === 'paper') {
    if (typeof fill.grain !== 'number') fill.grain = 0.4
    if (fill.a === '#ffffff') fill.a = '#f3efe6'
    if (fill.b === '#000000') fill.b = '#8b7d68'
    if (fill.density === 8) fill.density = 12
  }
  fill.type = t; push()
}
function onGrad(g: Gradient) { grad.value = g; push() }
function onShaderSpec(spec: ShaderSpec) { fill.shader = spec; push() }

// ── Shuffle: roll a tasteful fill from the Vessell palette (patterns + a few
// brand gradients). A rolling counter seeds the pick so repeated clicks vary. ──
let rollN = 0
function shuffle() {
  rollN += 1
  const pick = rollPaintItem(rollN)
  if (isGradient(pick)) {
    grad.value = pick
    fill.type = 'gradient'
    emit('update:modelValue', grad.value)
  } else {
    Object.assign(fill, pick)
    emit('update:modelValue', paintFromFill(fill))
  }
  drawPreview()
}
function setColor(key: 'a' | 'b', v: string) { fill[key] = v; push() }
function setNum(key: 'angle' | 'density' | 'shapeSize' | 'shapeGap' | 'grain', v: number) { fill[key] = v; push() }
function toggleNone() {
  // Adding a fill from the none state: emit the editable fill DIRECTLY, not via
  // push() — push()'s `if (!isNone.value)` guard (which stops colour edits from
  // leaking out while the swatch reads "none") is still true here because the
  // prop hasn't flipped yet, so routing through it would emit nothing and the
  // "Add" button would do nothing (the bug that made a shape's stroke un-addable).
  if (isNone.value) emit('update:modelValue', fill.type === 'gradient' ? grad.value : paintFromFill(fill))
  else emit('update:modelValue', 'none')
}

// Active project brand kit → one-click swatches. Null-safe: FillControl also
// renders in contexts without a project (dev labs), where the inject is absent.
const projectBrand = inject<{ activeKit: ComputedRef<BrandKit | undefined> } | null>('sailor:brand', null)
const brandSwatches = computed(() => kitSwatches(projectBrand?.activeKit.value))
function applyBrandColor(hex: string) {
  if (fill.type === 'gradient') fill.type = 'solid'
  setColor('a', hex)
}

// Gradient gets its own editor; patterns keep the A/B + angle + density controls.
const needsB = computed(() => fill.type !== 'solid' && fill.type !== 'gradient')
const needsAngle = computed(() => fill.type === 'ombre' || fill.type === 'stripes' || fill.type === 'shapes' || fill.type === 'paper')
const needsDensity = computed(() => fill.type === 'grid' || fill.type === 'checkerboard' || fill.type === 'stripes' || fill.type === 'noise' || fill.type === 'qr' || fill.type === 'paper')
// Shapes steers count via Size + Spacing (tile fractions) instead of a raw Density — but only
// when it is TILED. Both dials are grid dials, so in the single-shape fits ('fill'/'contain')
// they would be controls that store a value nothing reads: hidden, not shown-and-inert.
const needsShapeGrid = computed(() => fill.type === 'shapes' && (fill.shapeFit ?? 'tile') === 'tile')
// Paper exposes a grain-amount slider (0..1) on top of the shared A/B + density + angle rows.
const needsGrain = computed(() => fill.type === 'paper')

// Shapes fill: pick the library shape tiled across the grid, and let the tile
// sit on a transparent background instead of a solid `b`.
const shapePickerOpen = ref(false)
const shapePickerAnchor = ref({ x: 0, y: 0 })
const shapeBtnRef = ref<HTMLElement | null>(null)
const currentShape = computed(() => (fill.type === 'shapes' ? shapeById(fill.shapeId ?? '') : undefined))
function openShapePicker() {
  shapePickerAnchor.value = anchorAbove(shapeBtnRef.value?.getBoundingClientRect() ?? null)
  shapePickerOpen.value = true
}
function setShape(id: string) { fill.shapeId = id; push() }
/** Image-fill fits, in picker order — the same list the `ImageFill['fit']` union carries. */
const IMAGE_FITS: string[] = ['cover', 'contain', 'tile', 'stretch']
const shapeFit = computed<ShapeFit>(() => fill.shapeFit ?? 'tile')
function setShapeFit(v: string) { fill.shapeFit = v as ShapeFit; push() }
const bgTransparent = computed(() => fill.type === 'shapes' && (fill.b === 'none' || fill.b === ''))
function setBgTransparent(on: boolean) { fill.b = on ? 'none' : '#000000'; push() }

function drawGradientPreview(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const g = grad.value
  const stops = [...g.stops].sort((a, b) => a.offset - b.offset)
  let cg: CanvasGradient
  if (g.type === 'radial') cg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) / 2)
  else {
    const rad = (g.angle * Math.PI) / 180, hx = (Math.cos(rad) * w) / 2, hy = (Math.sin(rad) * h) / 2
    cg = ctx.createLinearGradient(w / 2 - hx, h / 2 - hy, w / 2 + hx, h / 2 + hy)
  }
  for (const s of stops) cg.addColorStop(Math.max(0, Math.min(1, s.offset)), s.color)
  ctx.fillStyle = cg; ctx.fillRect(0, 0, w, h)
}
function drawPreview() {
  const cv = previewRef.value; if (!cv) return
  const ctx = cv.getContext('2d'); if (!ctx) return
  ctx.clearRect(0, 0, cv.width, cv.height)
  if (currentType.value === 'image' && imageFill.value?.src) {
    const img = getFillBitmap(imageFill.value.src)
    if (img) {
      const { dx, dy, dw, dh } = imageFillRect('cover', img.naturalWidth || img.width, img.naturalHeight || img.height, cv.width, cv.height)
      ctx.drawImage(img, dx, dy, dw, dh)
    } else {
      ctx.fillStyle = '#333'; ctx.fillRect(0, 0, cv.width, cv.height)
      // onReady fires ONCE, only on a genuine successful decode — never for an
      // empty / failed / still-loading src. A `.then(drawPreview)` re-arm here
      // is an infinite microtask loop (empty/in-flight srcs resolve instantly),
      // which hard-freezes the tab. Do NOT reintroduce it.
      ensureFillBitmaps([imageFill.value.src], drawPreview)
    }
    return
  }
  if (isNone.value) {
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(1, cv.height - 1); ctx.lineTo(cv.width - 1, 1); ctx.stroke()
    return
  }
  if (fill.type === 'gradient') { drawGradientPreview(ctx, cv.width, cv.height); return }
  try { ctx.drawImage(fillTileCanvas(fill, 28), 0, 0, cv.width, cv.height) } catch { /* no canvas */ }
}
onMounted(drawPreview)
watch(fill, drawPreview, { deep: true })
watch(grad, drawPreview, { deep: true })
watch(imageFill, drawPreview, { deep: true })
</script>

<template>
  <div>
    <div class="flex items-center gap-1.5">
      <button type="button" class="h-8 w-8 shrink-0 rounded border border-[#2a2a2a] overflow-hidden bg-[#1a1a1a] cursor-pointer" @click="open = !open">
        <canvas ref="previewRef" width="28" height="28" class="h-full w-full" />
      </button>
      <button type="button" class="flex-1 h-8 rounded border border-[#2a2a2a] bg-[#1a1a1a] px-2 text-left text-xs text-white/85 capitalize flex items-center justify-between cursor-pointer" @click="open = !open">
        <span>{{ isNone ? 'No fill' : currentType }}</span>
        <ChevronDown class="size-3.5 text-white/35 transition-transform" :class="open ? 'rotate-180' : ''" />
      </button>
      <button type="button" class="h-8 w-8 shrink-0 grid place-items-center rounded border border-[#2a2a2a] bg-[#1a1a1a] text-white/55 hover:text-white cursor-pointer" title="Shuffle a palette fill" @click="shuffle">
        <Dices class="size-4" />
      </button>
      <button v-if="allowNone" type="button" class="h-8 px-2 rounded border border-[#2a2a2a] bg-[#1a1a1a] text-[11px] text-white/70 hover:text-white cursor-pointer" :title="isNone ? 'Add a fill' : 'Remove'" @click="toggleNone">
        {{ isNone ? 'Add' : '✕' }}
      </button>
    </div>

    <div v-if="open && !isNone" class="mt-2 rounded-lg border border-white/10 bg-[#141414] p-2.5 space-y-2.5">
      <div v-if="brandSwatches.length" class="flex items-center gap-1.5">
        <span class="text-[9px] uppercase tracking-[0.1em] text-white/35 shrink-0">Brand</span>
        <button
          v-for="s in brandSwatches" :key="s.name + s.hex" type="button"
          class="size-5 rounded border border-white/15 cursor-pointer hover:scale-110 transition-transform"
          :style="{ background: s.hex }" :title="s.name" @click="applyBrandColor(s.hex)"
        />
      </div>

      <select :value="currentType" class="w-full rounded bg-white/10 px-2 py-1.5 text-xs text-white/90 outline-none capitalize cursor-pointer"
        @change="setUiType(($event.target as HTMLSelectElement).value as any)">
        <option v-for="t in uiTypes" :key="t" :value="t">{{ t }}</option>
      </select>

      <template v-if="currentType === 'image'">
        <div v-if="imageFill?.src && !pickerOpen" class="flex items-center gap-2">
          <div class="h-10 w-10 shrink-0 rounded border border-white/10 overflow-hidden bg-[#1a1a1a]">
            <img :src="imageFill.src" class="h-full w-full object-cover" alt="" />
          </div>
          <button type="button" class="text-[11px] text-white/70 hover:text-white underline cursor-pointer" @click="pickerOpen = true">Replace image</button>
        </div>
        <FillImagePicker v-else @pick="onPick" />

        <template v-if="imageFill?.src">
          <StudioSegmented :model-value="imageFill.fit ?? 'cover'" :options="IMAGE_FITS"
            @update:model-value="(f: string) => pushImage({ fit: f as ImageFill['fit'] })" />
          <StudioSlider label="Scale" :model-value="imageFill.scale ?? 1" :min="0.1" :max="4" :step="0.05" :default="1"
            @update:model-value="(v: number) => pushImage({ scale: v })" />
          <StudioSlider label="Offset X" :model-value="imageFill.offset?.x ?? 0" :min="-0.5" :max="0.5" :step="0.01" :default="0"
            @update:model-value="(v: number) => pushImage({ offset: { x: v, y: imageFill?.offset?.y ?? 0 } })" />
          <StudioSlider label="Offset Y" :model-value="imageFill.offset?.y ?? 0" :min="-0.5" :max="0.5" :step="0.01" :default="0"
            @update:model-value="(v: number) => pushImage({ offset: { x: imageFill?.offset?.x ?? 0, y: v } })" />
        </template>
      </template>

      <GradientEditor v-else-if="fill.type === 'gradient'" :model-value="grad" @update:model-value="onGrad" />

      <ShaderFillEditor v-else-if="fill.type === 'shader'" :model-value="fill.shader ?? DEFAULT_SHADER_SPEC" :show-anchor="showAnchor" :allow-reads-backdrop="allowReadsBackdrop" :other-layers="otherLayers" @update:model-value="onShaderSpec" />

      <div v-else class="space-y-2.5">
        <div v-if="fill.type === 'shapes'" class="mb-1">
          <div class="panel-sublabel mb-1">Shape</div>
          <button ref="shapeBtnRef" type="button"
            class="w-full flex items-center gap-2 h-8 rounded border border-[#2a2a2a] bg-[#1a1a1a] px-2 text-xs text-white/85 cursor-pointer hover:text-white"
            @click="openShapePicker">
            <svg v-if="currentShape" viewBox="0 0 96 96" class="size-4 shrink-0" fill="currentColor" aria-hidden="true"><path :d="currentShape.d" :fill-rule="currentShape.fillRule" /></svg>
            <span class="flex-1 text-left">{{ currentShape ? currentShape.name : 'Sparkle' }}</span>
          </button>
          <ShapePicker v-if="shapePickerOpen" :model-value="fill.shapeId ?? 'sparkle'" :allow-none="false"
            :anchor="shapePickerAnchor" :ignore="shapeBtnRef"
            @update:model-value="(id: string) => setShape(id)" @close="shapePickerOpen = false" />
          <div class="panel-sublabel mt-2 mb-1">Fit</div>
          <StudioSegmented :model-value="shapeFit" :options="SHAPE_FITS" @update:model-value="setShapeFit" />
          <label class="mt-1.5 flex items-center gap-1.5 text-[11px] text-white/60 cursor-pointer select-none">
            <input type="checkbox" :checked="bgTransparent" @change="setBgTransparent((($event.target as HTMLInputElement).checked))" />
            Transparent background
          </label>
        </div>

        <!-- Colour(s) as labelled 28px rows, so they line up with the Angle / Size /
             Spacing sliders instead of reading as a separate bare-swatch control. -->
        <StudioColorField :label="needsB ? 'A' : 'Color'" :model-value="fill.a"
          @update:model-value="(v: string) => setColor('a', v)" />
        <StudioColorField v-if="needsB && !bgTransparent" label="B" :model-value="fill.b"
          @update:model-value="(v: string) => setColor('b', v)" />
      </div>

      <StudioSlider v-if="needsAngle" label="Angle" :model-value="fill.angle" :min="0" :max="180" :step="1" :default="45"
        @update:model-value="(v: number) => setNum('angle', v)" />

      <StudioSlider v-if="needsDensity" label="Density" :model-value="fill.density" :min="1" :max="32" :step="1" :default="8"
        @update:model-value="(v: number) => setNum('density', v)" />

      <StudioSlider v-if="needsGrain" label="Grain" :model-value="fill.grain ?? 0.4" :min="0" :max="1" :step="0.01" :default="0.4"
        @update:model-value="(v: number) => setNum('grain', v)" />

      <StudioSlider v-if="needsShapeGrid" label="Size" :model-value="fill.shapeSize ?? 0.1" :min="0.02" :max="0.5" :step="0.01" :default="0.1"
        @update:model-value="(v: number) => setNum('shapeSize', v)" />

      <StudioSlider v-if="needsShapeGrid" label="Spacing" :model-value="fill.shapeGap ?? 0.03" :min="0" :max="0.4" :step="0.01" :default="0.03"
        @update:model-value="(v: number) => setNum('shapeGap', v)" />
    </div>
  </div>
</template>
