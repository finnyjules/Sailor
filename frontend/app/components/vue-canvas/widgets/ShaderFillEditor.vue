<script setup lang="ts">
/**
 * ShaderFillEditor — the authoring UI for a `ShaderSpec` (a `Fill` of type
 * 'shader'). Four sections: an effect picker (the app's canonical CatalogModal,
 * merging the live 63-effect catalog), the selected effect's own derived params
 * (`derivedShaderFillControls`), an anchor toggle, a speed slider — then the one
 * genuinely new piece, the NESTED INPUT FILL EDITOR: the same `FillControl` used
 * everywhere else in the app, bound to `spec.input`, with `'shader'` excluded
 * from its own type list (`nested` prop). That exclusion is the depth-1 nesting
 * guard already enforced in `normalizeFill` (fillTile.ts) made visible in the
 * UI, rather than a user picking "shader" again and having it silently
 * collapsed on save.
 *
 * Hand-written, not derived from ControlSpec — this editor's layout is fixed
 * (picker → params → anchor → speed → nested fill), matching the note at
 * `~/lib/gradientfx/controls.ts:9-11` that ControlSpec is a description for
 * OTHER consumers (agent config, var-bindings), not a template for generating
 * inspector markup.
 *
 * Reused by every fill-picker call site (`grep -rl FILL_TYPES app`): Space
 * Type's fill list, Shape Studio's surface fill, and the Compositor's
 * `FillControl` itself (mounted internally there when `fill.type === 'shader'`).
 */
import { computed, onMounted, ref } from 'vue'
import { ChevronRight, RefreshCw, Sparkles } from 'lucide-vue-next'
import CatalogModal from '~/components/CatalogModal.vue'
import FillControl from '~/components/vue-canvas/compositor/FillControl.vue'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'
import StudioButton from '~/components/vue-canvas/studio/StudioButton.vue'
import StudioSegmented from '~/components/vue-canvas/studio/StudioSegmented.vue'
import StudioColor from '~/components/vue-canvas/studio/StudioColor.vue'
import PalettePicker from '~/components/vue-canvas/studio/PalettePicker.vue'
import { type ShaderSpec, DEFAULT_SHADER_SPEC } from '~/lib/spacetype/fillTile'
import { type Paint, isFill } from '~/composables/useCompositorLayers'
import { fetchShaderFxCatalog, resolveEffectId } from '~/lib/shaderfx/catalog'
import type { EffectDef, GradientStop, ParamValue, ShaderFxCatalog } from '~/lib/shaderfx/types'
import { cleanStops } from '~/lib/shaderfx/params'
import { derivedShaderFillControls } from '~/lib/shaderfill/controls'
import { unprefixedKey } from '~/lib/shaderfill/descriptor'
import { retryFieldCatalog } from '~/lib/shaderfill/field'

const props = withDefaults(defineProps<{
  modelValue: ShaderSpec
  /** Space Type / Shape Studio anchor a shader fill to either the object's own UVs or the
   *  containing frame; Scene3D has no frame to anchor to at all (materials.ts never reads
   *  `spec.anchor` — see SceneMaterial.shader's own doc in config.ts). Offering the toggle
   *  there would silently do nothing, which is worse than not offering it — Shape Studio
   *  already has exactly that dead-toggle bug today. Defaults to shown so the three existing
   *  hosts (Space Type, Shape Studio, Compositor) are unaffected. */
  showAnchor?: boolean
}>(), { showAnchor: true })
const emit = defineEmits<{ 'update:modelValue': [ShaderSpec] }>()

/** Spread, never a listed-field rebuild — a `ShaderSpec` (or `Fill`) rebuilt by
 *  listing fields has silently dropped one six times in this feature already
 *  (see fillTile.ts / FillControl.vue's own notes on the same trap). */
function patch(partial: Partial<ShaderSpec>) {
  emit('update:modelValue', { ...props.modelValue, ...partial })
}

// ── Catalog ──────────────────────────────────────────────────────────────────
const catalog = ref<ShaderFxCatalog | null>(null)
// Item 4 fix (final review): field.ts's own `retryFieldCatalog` had NO production caller —
// once `kickCatalogFetch` gives up after CATALOG_RETRY_MAX attempts (~15.5s total), nothing
// ever retries, and every shader fill on the page is stuck showing its input fill until a
// full page reload. This editor is the one place a user can KNOW an effect isn't resolving
// (its params/picker never populate) and can act on it, so it's the natural place to re-arm
// the retry: on open (a ComfyUI restart mid-session is exactly the case the give-up budget
// can't outlast), on repointing the effect (the doc for CATALOG_RETRY_MAX names this case
// explicitly), and via the manual "Retry" affordance below.
function loadCatalog() {
  retryFieldCatalog()
  fetchShaderFxCatalog().then((c) => { catalog.value = c }).catch(() => { /* picker falls back to the raw id */ })
}
onMounted(loadCatalog)

const effectDef = computed<EffectDef | null>(
  () => catalog.value?.effects.find((e) => e.id === resolveEffectId(props.modelValue.effectId)) ?? null,
)

function titleCase(s: string): string {
  return s.replace(/(^|[_\s])(\w)/g, (_, sep, c) => (sep ? ' ' : '') + c.toUpperCase()).trim()
}

// ── Effect picker (CatalogModal, merged with the live catalog — SHADER_FILL_
// CONTROLS.effectId declares options:[] on purpose; this is the caller that
// merges in the live ids, per that control's own doc) ──────────────────────
const pickerOpen = ref(false)
const pickerSearch = ref('')
const pickerFilter = ref('all')

const pickerFilters = computed(() => {
  const counts = new Map<string, number>()
  for (const e of catalog.value?.effects ?? []) counts.set(e.category, (counts.get(e.category) ?? 0) + 1)
  return [
    { id: 'all', label: 'All', count: catalog.value?.effects.length ?? 0 },
    ...[...counts].map(([id, count]) => ({ id, label: titleCase(id), count })),
  ]
})

const pickerItems = computed<EffectDef[]>(() => {
  const q = pickerSearch.value.trim().toLowerCase()
  return (catalog.value?.effects ?? []).filter((e) =>
    (pickerFilter.value === 'all' || e.category === pickerFilter.value)
    && (!q || e.name.toLowerCase().includes(q) || e.category.toLowerCase().includes(q)))
})

function openPicker() {
  pickerSearch.value = ''
  pickerFilter.value = 'all'
  pickerOpen.value = true
}

function pickEffect(id: string) {
  // Params are per-effect (a different effect's param list means different
  // keys/meanings) — reset rather than carry stale values across the switch,
  // mirroring ShaderEffectNode's own pickEffect.
  patch({ effectId: id, params: {} })
  pickerOpen.value = false
  // Item 4 fix (final review): repointing effectId means a DIFFERENT effect may need
  // resolving that this module already gave up retrying for (CATALOG_RETRY_MAX reached,
  // e.g. after a long ComfyUI restart) — re-arm the retry so the newly-picked effect's
  // shader field doesn't sit on its input-fill fallback until an unrelated page reload.
  retryFieldCatalog()
}

// ── Derived per-effect params ────────────────────────────────────────────────
// Prefix only shapes each control's `.key` (unused here beyond stripping back
// off to the bare param id); it doesn't need to match where this ShaderSpec
// actually lives in its host (Fill.shader vs Scene3D's bare material.shader).
const PREFIX = 'fill.shader'
const PARAM_PREFIX = `${PREFIX}.params.`

interface ParamRow {
  key: string
  label: string
  kind: 'slider' | 'select' | 'color' | 'gradientStops'
  maxStops?: number
  min?: number
  max?: number
  step?: number
  /** number for slider/select · hex string for color · JSON stops for gradientStops */
  default: number | string
  options?: { value: number; label: string }[]
}

const paramRows = computed<ParamRow[]>(() => {
  const eff = effectDef.value
  if (!eff) return []
  // derivedShaderFillControls emits 'slider', 'select', 'color' and
  // 'gradientStops' (see its own source); its return type is the full ControlSpec
  // union (shared with every other control kind in the app) — flatMap + an
  // explicit kind check on each branch narrows properly instead of asserting past
  // the type checker. A branch MISSING here is not a type error, it just returns
  // [] — which is how colour params silently had no editor on this widget for a
  // commit. Any new derived kind needs a branch here AND in StudioControlPanel.
  return derivedShaderFillControls(eff, PREFIX).flatMap((c): ParamRow[] => {
    const key = c.key.startsWith(PARAM_PREFIX) ? c.key.slice(PARAM_PREFIX.length) : c.key
    if (c.kind === 'select') {
      // The control's own `options` are stringified NUMBERS — the stored value
      // domain (ShaderSpec.params is Record<string, number>; resolveEffectParams
      // only ever accepts a number). Display labels aren't on the ControlSpec at
      // all (`select` has no value/label channel — see controls.ts's documented
      // gap); resolved here instead, from the live EffectDef's own option list,
      // by matching back on the same unprefixedKey the control was built from.
      const orig = eff.params.find((p) => unprefixedKey(p.uniform) === key)
      return [{
        key, label: c.label, kind: 'select', default: Number(c.default),
        options: (orig?.options ?? []).map((o) => ({ value: o.value, label: o.label })),
      }]
    }
    if (c.kind === 'slider') {
      return [{ key, label: c.label, kind: 'slider', default: c.default, min: c.min, max: c.max, step: c.step }]
    }
    if (c.kind === 'color') {
      return [{ key, label: c.label, kind: 'color', default: c.default }]
    }
    if (c.kind === 'gradientStops') {
      return [{ key, label: c.label, kind: 'gradientStops', default: c.default, maxStops: c.maxStops ?? 8 }]
    }
    return []
  })
})

function paramValue(row: ParamRow): number {
  const raw = props.modelValue.params[row.key]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : (row.default as number)
}
function colorValue(row: ParamRow): string {
  const raw = props.modelValue.params[row.key]
  return typeof raw === 'string' && raw ? raw : String(row.default)
}
/** Through `cleanStops`, which takes the stored array OR a `gradientStops` control's
 *  JSON text — the picker below only speaks arrays. */
function stopsValue(row: ParamRow): GradientStop[] {
  const fallback = cleanStops(row.default, row.maxStops ?? 8, [])
  return cleanStops(props.modelValue.params[row.key], row.maxStops ?? 8, fallback)
}
function rampCss(stops: GradientStop[]): string {
  const s = [...stops].sort((a, b) => a.pos - b.pos)
  if (!s.length) return 'transparent'
  return `linear-gradient(to right, ${s.map(x => `${x.color} ${Math.round(x.pos * 100)}%`).join(', ')})`
}
function applyRowStops(row: ParamRow, v: GradientStop[]) {
  setParam(row.key, v.slice(0, row.maxStops ?? 8).map(s => ({ pos: s.pos, color: s.color })))
}
function setParam(key: string, v: ParamValue) {
  patch({ params: { ...props.modelValue.params, [key]: v } })
}

// ── Anchor / speed ────────────────────────────────────────────────────────────
const anchor = computed<string>({
  get: () => props.modelValue.anchor,
  set: (v) => patch({ anchor: v === 'frame' ? 'frame' : 'object' }),
})
const speed = computed<number>({
  get: () => props.modelValue.speed,
  set: (v) => patch({ speed: v }),
})
const seed = computed<number>({
  get: () => props.modelValue.seed,
  set: (v) => patch({ seed: Math.max(1, Math.round(v)) }),
})
function rerollSeed() {
  patch({ seed: Math.floor(Math.random() * 9999) + 1 })
}

// ── Nested input fill ─────────────────────────────────────────────────────────
// `ShaderSpec.input` is `Paint` now (fillTile.ts), the same union FillControl
// edits, so no adapter is needed either direction. Depth-1 nesting (a shader
// fill's input can never itself be shader-typed) is enforced at the parse
// boundary by normalizeFill/normalizePaint (fillTile.ts) — but edits from this
// editor patch `spec.input` directly and never pass through normalizePaint, so
// that enforcement alone wouldn't catch a nested shader fill until the next
// load. `nested` on the child FillControl already excludes 'shader' from its
// type list, so `p.type === 'shader'` shouldn't be reachable from any current
// caller; guarded here anyway as the same runtime backstop `fillFromPaint`
// used to provide, rather than trusting that invariant end-to-end.
function onInputChange(p: Paint) {
  patch({ input: isFill(p) && p.type === 'shader' ? { ...p, type: 'gradient' } : p })
}
</script>

<template>
  <div class="space-y-2.5 rounded-lg border border-white/10 bg-white/[0.02] p-2.5">
    <!-- Effect picker -->
    <div>
      <div class="mb-1 flex items-center justify-between gap-2">
        <label class="block text-[9px] uppercase tracking-[0.1em] text-white/35">Effect</label>
        <!-- Item 4 fix (final review): manual escape hatch for CATALOG_RETRY_MAX give-up —
             shown only once the catalog HAS loaded but this fill's own effect isn't in it
             (unresolved id / a backend that was still down at mount), the same signal the
             picker itself falls back on (raw effectId text) below. -->
        <button
          v-if="catalog && !effectDef"
          type="button"
          title="Retry loading this effect"
          class="nopan nodrag flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[9px] uppercase tracking-[0.06em] text-white/40 transition-colors hover:bg-white/10 hover:text-white/70"
          @click="loadCatalog"
        >
          <RefreshCw class="size-2.5" :stroke-width="2" /> Retry
        </button>
      </div>
      <button
        type="button"
        class="flex w-full cursor-pointer items-center gap-2 rounded border border-white/10 bg-white/[0.04] px-2 py-1.5 text-left transition-colors hover:border-white/20 hover:bg-white/[0.08]"
        @click="openPicker"
      >
        <Sparkles class="size-3.5 shrink-0 text-white/60" :stroke-width="1.75" />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-[11px] font-medium leading-tight text-white/90">{{ effectDef?.name ?? modelValue.effectId }}</span>
          <span v-if="effectDef" class="block truncate text-[9px] uppercase leading-tight tracking-[0.06em] text-white/40">{{ titleCase(effectDef.category) }}</span>
        </span>
        <ChevronRight class="size-3.5 shrink-0 text-white/30" />
      </button>
    </div>

    <!-- Effect params (derived per catalog effect) -->
    <div v-for="row in paramRows" :key="row.key">
      <template v-if="row.kind === 'select'">
        <label class="mb-1 block text-[9px] uppercase tracking-[0.1em] text-white/35">{{ row.label }}</label>
        <select
          class="w-full cursor-pointer rounded bg-white/10 px-2 py-1.5 text-xs text-white/90 outline-none"
          :value="String(paramValue(row))"
          @change="setParam(row.key, Number(($event.target as HTMLSelectElement).value))"
        >
          <option v-for="o in row.options" :key="o.value" :value="o.value" class="bg-neutral-900">{{ o.label }}</option>
        </select>
      </template>
      <template v-else-if="row.kind === 'color'">
        <label class="mb-1 block text-[9px] uppercase tracking-[0.1em] text-white/35">{{ row.label }}</label>
        <StudioColor :model-value="colorValue(row)" @update:model-value="(v: string) => setParam(row.key, v)" />
      </template>
      <template v-else-if="row.kind === 'gradientStops'">
        <label class="mb-1 block text-[9px] uppercase tracking-[0.1em] text-white/35">{{ row.label }}</label>
        <div class="mb-1.5 h-5 overflow-hidden rounded border border-white/10" :style="{ background: rampCss(stopsValue(row)) }" />
        <PalettePicker
          mode="stops"
          :stop-count="stopsValue(row).length || 3"
          :seed="stopsValue(row)[0]?.color ?? '#4f8ad9'"
          @apply-stops="(v: GradientStop[]) => applyRowStops(row, v)"
          @apply-literal-stops="(v: GradientStop[]) => applyRowStops(row, v)"
        />
      </template>
      <StudioSlider
        v-else
        :model-value="paramValue(row)"
        :label="row.label" :min="row.min ?? 0" :max="row.max ?? 1" :step="row.step ?? 0.01" :default="Number(row.default)"
        @update:model-value="(v: number) => setParam(row.key, v)"
      />
    </div>

    <!-- Anchor: hidden entirely (not disabled) when the host has no frame to anchor to —
         see `showAnchor` doc above. -->
    <div v-if="showAnchor">
      <label class="mb-1 block text-[9px] uppercase tracking-[0.1em] text-white/35">Anchor</label>
      <StudioSegmented v-model="anchor" :options="['object', 'frame']" />
    </div>

    <!-- Speed -->
    <StudioSlider v-model="speed" label="Speed" :min="0" :max="4" :step="0.05" :default="DEFAULT_SHADER_SPEC.speed" />

    <!-- Variation: re-rolls the field's seed. -->
    <div class="flex items-center gap-2">
      <StudioButton variant="secondary" @click="rerollSeed">New variation</StudioButton>
      <div class="min-w-0 flex-1">
        <StudioSlider v-model="seed" label="Variation" :min="1" :max="9999" :step="1" :default="DEFAULT_SHADER_SPEC.seed" />
      </div>
    </div>

    <!-- Nested input fill: the recursive half, depth-limited to 1 via `nested`. -->
    <div class="border-t border-white/10 pt-2.5">
      <label class="mb-1.5 block text-[9px] uppercase tracking-[0.1em] text-white/35">Input fill</label>
      <FillControl nested :model-value="modelValue.input" @update:model-value="onInputChange" />
    </div>

    <CatalogModal
      :open="pickerOpen"
      title="Shader Effects"
      subtitle="Pick an effect for this fill"
      :items="pickerItems"
      :selected-id="modelValue.effectId"
      :filters="pickerFilters"
      :active-filter-id="pickerFilter"
      :search-query="pickerSearch"
      search-placeholder="Search effects…"
      confirm-label="Use effect"
      empty-message="No effects match your search."
      @close="pickerOpen = false"
      @confirm="pickEffect(($event as EffectDef).id)"
      @update:active-filter-id="pickerFilter = $event"
      @update:search-query="pickerSearch = $event"
    >
      <template #card="{ item }">
        <div class="flex aspect-video items-center justify-center bg-white/[0.03]">
          <Sparkles class="size-5 text-white/25" :stroke-width="1.5" />
        </div>
        <div class="px-2 py-1.5">
          <div class="truncate text-[11px] text-white/85">{{ (item as EffectDef).name }}</div>
          <div class="truncate text-[10px] capitalize text-white/35">{{ (item as EffectDef).category }}</div>
        </div>
      </template>
    </CatalogModal>
  </div>
</template>
