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
import { computed, onMounted, ref, watch } from 'vue'
import { ChevronRight, RefreshCw, Sparkles, Plus, Trash2, Palette } from 'lucide-vue-next'
import CatalogModal from '~/components/CatalogModal.vue'
import FillControl from '~/components/vue-canvas/compositor/FillControl.vue'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'
import StudioButton from '~/components/vue-canvas/studio/StudioButton.vue'
import StudioSelect from '~/components/vue-canvas/studio/StudioSelect.vue'
import StudioSegmented from '~/components/vue-canvas/studio/StudioSegmented.vue'
import StudioColor from '~/components/vue-canvas/studio/StudioColor.vue'
import StudioColorField from '~/components/vue-canvas/studio/StudioColorField.vue'
import PalettePicker from '~/components/vue-canvas/studio/PalettePicker.vue'
import { type ShaderSpec, DEFAULT_SHADER_SPEC } from '~/lib/spacetype/fillTile'
import { type Paint, isFill } from '~/composables/useCompositorLayers'
import { fetchShaderFxCatalog, resolveEffectId } from '~/lib/shaderfx/catalog'
import { effectReadsInput } from '~/lib/shaderfx/catalogStore'
import type { EffectDef, GradientStop, ParamValue, ShaderFxCatalog } from '~/lib/shaderfx/types'
import { cleanStops } from '~/lib/shaderfx/params'
import { buildShaderParamRows, type ShaderParamRow } from '~/lib/shaderfill/controls'
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
  /** A host whose EFFECT is fixed by something else (the Compositor's Mosaic element:
   *  its Style IS the effect — Oddgrid / Static) hides the picker so the spec can't be
   *  repointed at an effect the host doesn't mean. Default off: every fill host lets
   *  the person pick. */
  lockEffect?: boolean
  /** Hide the Speed slider: a host whose fill is a still (a Mosaic, speed pinned at 0)
   *  would be offering a dead dial. Default shown. */
  showSpeed?: boolean
  /** Hide the Variation row: a host that owns the seed (a Mosaic mirrors its layer seed
   *  into the spec, with its own New variation button) would otherwise show a second,
   *  competing re-roll. Default shown. */
  showSeed?: boolean
  /** Hide the nested Input fill: a generative effect (Oddgrid / Static) mostly ignores
   *  its input, and a Mosaic has no reason to expose it. Default shown. */
  showInput?: boolean
  /** Other layers in the host's stack, already excluding this one — feeds the "A specific
   *  layer" Reads picker below (label + the key to write into `readsLayerKey`, e.g. `'l:<id>'`
   *  — the same cross-source StackKey format CompositorModal's mask-source picker uses, since
   *  `resolveGlassSource` (useCompositorLayers.ts) resolves it through the identical `byKey`
   *  map as a mask ref). Wired end-to-end for the Compositor: FillControl.vue passes this prop
   *  through, and CompositorModal.vue feeds it `glassCandidates` on each glass-capable `.fill`
   *  slot. Every other host leaves it at the `[]` default — the picker below is fully
   *  functional but renders empty (with its own hint) rather than fabricating a list. */
  otherLayers?: { key: string; label: string }[]
  /** Glass paint (reading the backdrop or another layer instead of this fill's own pixels)
   *  only exists in the Compositor's per-layer paint path — `isGlassLayer`/`primaryFillOf`
   *  resolve against the local layer stack that only the Compositor builds. Every other host
   *  (Scene3D materials, Vector Type, Space Type, the Compositor's own Mosaic element) has no
   *  backdrop or layer stack for this to read, so "Layers behind" / "A specific layer" would be
   *  dead controls there. Default off; the Compositor opts in explicitly per fill slot. */
  allowReadsBackdrop?: boolean
}>(), { showAnchor: true, lockEffect: false, showSpeed: true, showSeed: true, showInput: true, otherLayers: () => [], allowReadsBackdrop: false })
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

type ParamRow = ShaderParamRow

const paramRows = computed<ParamRow[]>(() => {
  const eff = effectDef.value
  if (!eff) return []
  // The row-building walk itself (derivedShaderFillControls → ParamRow) is shared with
  // CompositorModal.vue's F5 shader-PASS inspector — see buildShaderParamRows's own doc.
  // `mix` is filtered here rather than there: it blends the effect with its Input paint,
  // a fill-only concept (a shader PASS has no separate Input paint to blend with) — when
  // this host hides the Input rows the dial would silently blend in a paint nobody can
  // see or change.
  return buildShaderParamRows(eff, PREFIX).filter((row) => row.key !== 'mix' || props.showInput)
})

/** Colour params (the inks, a background) answer "what is it made of"; sliders and
 *  enums answer "how is it shaped". Rule the two apart wherever they meet, rather
 *  than reordering — the effect author's order is kept, we just let it breathe. */
const isColourParam = (r: ParamRow) => r.kind === 'color' || r.kind === 'gradientStops'
function dividesAbove(i: number): boolean {
  const rows = paramRows.value
  const prev = rows[i - 1]
  return i > 0 && !!prev && isColourParam(rows[i]!) !== isColourParam(prev)
}

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
// Manual per-stop editing — edit a stop's colour/position, add or remove one.
// The generated PalettePicker below is a shortcut, not the only way in.
const clampUnit = (n: number) => Math.max(0, Math.min(1, n))
function editRowStopColor(row: ParamRow, i: number, color: string) {
  applyRowStops(row, stopsValue(row).map((s, j) => (j === i ? { ...s, color } : s)))
}
function editRowStopPos(row: ParamRow, i: number, pos: number) {
  applyRowStops(row, stopsValue(row).map((s, j) => (j === i ? { ...s, pos: clampUnit(pos) } : s)))
}
function removeRowStop(row: ParamRow, i: number) {
  const s = stopsValue(row)
  if (s.length > 2) applyRowStops(row, s.filter((_, j) => j !== i))
}
// The palette generator is a TOOL, not the content. Folded away by default so the
// inks block reads as one thing (bar → inks → add) instead of being buried under a
// 12-tile shelf — same disclosure the node gradient editor uses. Keyed per row.
const openPickers = ref<Record<string, boolean>>({})
function togglePicker(key: string) {
  openPickers.value = { ...openPickers.value, [key]: !openPickers.value[key] }
}
function addRowStop(row: ParamRow) {
  const s = [...stopsValue(row)].sort((a, b) => a.pos - b.pos)
  // Drop the new stop into the widest gap so it doesn't stack on an existing one.
  let gap = -1, at = 0.5
  for (let i = 0; i < s.length - 1; i++) {
    const g = s[i + 1]!.pos - s[i]!.pos
    if (g > gap) { gap = g; at = (s[i]!.pos + s[i + 1]!.pos) / 2 }
  }
  applyRowStops(row, [...stopsValue(row), { pos: at, color: s[Math.floor(s.length / 2)]?.color ?? '#888888' }])
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

// ── Reads (glass lens): self-fill vs. reading the backdrop / one bound layer ──
// Eligibility mirrors `effectDef`'s own load state: before the catalog resolves
// (or for an unknown id) `effectDef` is null and we genuinely don't know yet
// whether this effect samples its input at all — treated as eligible rather than
// flashing the backdrop options disabled for an effect that turns out to read
// input once the catalog lands. `catalog.value` is read as a dependency (not
// just `modelValue.effectId`) purely so this recomputes once `loadCatalog`'s
// fetch resolves, exactly like `effectDef` above.
const eligible = computed<boolean>(() => {
  void catalog.value
  return !effectDef.value || effectReadsInput(props.modelValue.effectId)
})

type ReadsMode = 'self' | 'behind' | 'specific'
// Set the instant the person clicks "A specific layer", cleared by any other
// click — kept separate from the derived value below so the picker stays open
// (mode 'specific') the moment it's revealed, before a layer has been chosen,
// rather than `readsLayerKey` being unset deriving straight back to "Layers
// behind" and closing the picker that was just opened.
const pendingSpecific = ref(false)

const readsMode = computed<ReadsMode>(() => {
  if (!props.modelValue.readsBackdrop) return 'self'
  if (props.modelValue.readsLayerKey) return 'specific'
  return pendingSpecific.value ? 'specific' : 'behind'
})

// The Reads control is a dropdown (three long labels overflow a segmented row).
// When the shader can't read anything behind it, only "Its own fill" is offered
// (the note below the control explains why).
const readsOptions = computed<ReadsMode[]>(() => (eligible.value ? ['self', 'behind', 'specific'] : ['self']))
const readsOptionLabels = computed(() => (eligible.value ? ['Its own fill', 'Layers behind', 'A specific layer'] : ['Its own fill']))

function setReadsMode(mode: ReadsMode) {
  pendingSpecific.value = mode === 'specific'
  if (mode === 'self') { patch({ readsBackdrop: false, readsLayerKey: undefined }); return }
  // 'behind' and the initial click into 'specific' both start from the same
  // patch (no layer chosen yet) — `pendingSpecific` is what keeps the picker
  // showing for the latter until `pickReadsLayer` below sets a real key.
  patch({ readsBackdrop: true, readsLayerKey: undefined })
}

function pickReadsLayer(key: string) {
  patch({ readsLayerKey: key || undefined })
}

// If the effect changes (via `pickEffect` above) — or the catalog resolves —
// to/as something that can't read input at all, a lingering backdrop mode would
// be a dead setting the paint path silently ignores (`isGlassLayer` checks the
// effect too). Force it back to the plain self-fill default instead.
watch(eligible, (ok) => {
  if (!ok && props.modelValue.readsBackdrop) {
    pendingSpecific.value = false
    patch({ readsBackdrop: false, readsLayerKey: undefined })
  }
})
</script>

<template>
  <div class="space-y-2.5 rounded-lg border border-white/10 bg-white/[0.02] p-2.5">
    <!-- Reads: self-fill (today's behaviour) vs. a glass lens onto the backdrop or one
         bound layer. Gated by `effectReadsInput` — a purely generative effect (Oddgrid,
         Static, …) has nothing behind its own fill to read. -->
    <div v-if="allowReadsBackdrop">
      <label class="mb-1 block panel-label">Reads</label>
      <StudioSelect
        :model-value="readsMode"
        @update:model-value="(v) => setReadsMode(v as ReadsMode)"
        :options="readsOptions"
        :option-labels="readsOptionLabels"
      />
      <p v-if="!eligible" class="mt-1 text-[10px] leading-snug text-white/40">This shader has nothing to read behind it.</p>
      <div v-if="readsMode === 'specific'" class="mt-1.5">
        <select
          class="w-full cursor-pointer rounded bg-white/10 px-2 py-1.5 text-xs text-white/90 outline-none"
          :value="modelValue.readsLayerKey ?? ''"
          @change="pickReadsLayer(($event.target as HTMLSelectElement).value)"
        >
          <option value="" disabled>Pick a layer…</option>
          <option v-for="o in otherLayers" :key="o.key" :value="o.key" class="bg-neutral-900">{{ o.label }}</option>
        </select>
        <p v-if="!otherLayers.length" class="mt-1 text-[10px] leading-snug text-white/40">No other layers in this frame yet.</p>
      </div>
    </div>

    <!-- Effect picker (hidden when the host fixes the effect — see `lockEffect`) -->
    <div v-if="!lockEffect">
      <div class="mb-1 flex items-center justify-between gap-2">
        <label class="block panel-label">Effect</label>
        <!-- Item 4 fix (final review): manual escape hatch for CATALOG_RETRY_MAX give-up —
             shown only once the catalog HAS loaded but this fill's own effect isn't in it
             (unresolved id / a backend that was still down at mount), the same signal the
             picker itself falls back on (raw effectId text) below. -->
        <button
          v-if="catalog && !effectDef"
          type="button"
          title="Retry loading this effect"
          class="nopan nodrag flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-white/40 transition-colors hover:bg-white/10 hover:text-white/70"
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
          <span v-if="effectDef" class="block truncate text-[10px] leading-tight text-white/40">{{ titleCase(effectDef.category) }}</span>
        </span>
        <ChevronRight class="size-3.5 shrink-0 text-white/30" />
      </button>
    </div>

    <!-- Effect params (derived per catalog effect). A hairline rules the colour
         params off from the shape/number ones wherever the two meet. -->
    <div
      v-for="(row, i) in paramRows" :key="row.key"
      :class="dividesAbove(i) ? 'border-t border-white/[0.06] pt-2.5' : ''"
    >
      <!-- Every param is the same 28px studio row — label left, control right — so a
           colour or an enum sits flush with the sliders instead of a bare swatch /
           full-width select floating under its own header. -->
      <template v-if="row.kind === 'select'">
        <StudioSelect
          :label="row.label"
          :options="(row.options ?? []).map((o) => String(o.value))"
          :option-labels="(row.options ?? []).map((o) => o.label)"
          :model-value="String(paramValue(row))"
          @update:model-value="(v: string) => setParam(row.key, Number(v))"
        />
      </template>
      <template v-else-if="row.kind === 'color'">
        <StudioColorField
          :label="row.label"
          :model-value="colorValue(row)"
          @update:model-value="(v: string) => setParam(row.key, v)"
        />
      </template>
      <template v-else-if="row.kind === 'gradientStops'">
        <label class="mb-1 block panel-label">{{ row.label }}</label>
        <div class="mb-1.5 h-5 overflow-hidden rounded border border-white/10" :style="{ background: rampCss(stopsValue(row)) }" />
        <!-- Manual per-stop editor: edit each ink's colour + position, add / remove. -->
        <div class="mb-2 flex flex-col gap-1">
          <div v-for="(s, i) in stopsValue(row)" :key="i" class="flex items-center gap-2">
            <StudioColor :model-value="s.color" @update:model-value="(c: string) => editRowStopColor(row, i, c)" />
            <div class="min-w-0 flex-1">
              <StudioSlider :model-value="Math.round(s.pos * 100)" @update:model-value="(v: number) => editRowStopPos(row, i, v / 100)"
                :min="0" :max="100" :step="1" :bindable="false" />
            </div>
            <button class="shrink-0 rounded p-0.5 text-white/30 hover:bg-white/10 hover:text-white/70 disabled:opacity-20"
              :disabled="stopsValue(row).length <= 2" title="Remove ink" @click="removeRowStop(row, i)"><Trash2 :size="12" /></button>
          </div>
          <button class="mt-0.5 flex items-center justify-center gap-1 rounded border border-dashed border-white/15 py-1 text-[11px] text-white/50 hover:border-white/30 hover:text-white/80 disabled:opacity-30"
            :disabled="stopsValue(row).length >= (row.maxStops ?? 8)" @click="addRowStop(row)"><Plus :size="12" /> Add ink</button>
        </div>
        <!-- Generator, folded: the inks above are the content; this is the shortcut. -->
        <button
          class="flex w-full items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-1.5 text-[11px] text-white/70 transition hover:bg-white/[0.08] hover:text-white/90"
          @click="togglePicker(row.key)"
        >
          <Palette :size="12" class="shrink-0 opacity-70" />
          <span>Generate a palette</span>
          <ChevronRight :size="12" class="ml-auto shrink-0 opacity-60 transition-transform" :class="openPickers[row.key] ? 'rotate-90' : ''" />
        </button>
        <div v-if="openPickers[row.key]" class="mt-1.5 rounded border border-white/10 bg-white/[0.02] p-2">
          <PalettePicker
            mode="stops" manual-stops
            :stop-count="stopsValue(row).length || 3"
            :seed="stopsValue(row)[0]?.color ?? '#4f8ad9'"
            @apply-stops="(v: GradientStop[]) => applyRowStops(row, v)"
            @apply-literal-stops="(v: GradientStop[]) => applyRowStops(row, v)"
          />
        </div>
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
      <label class="mb-1 block panel-label">Anchor</label>
      <StudioSegmented v-model="anchor" :options="['object', 'frame']" />
    </div>

    <!-- Speed -->
    <StudioSlider v-if="showSpeed" v-model="speed" label="Speed" :min="0" :max="4" :step="0.05" :default="DEFAULT_SHADER_SPEC.speed" />

    <!-- Variation: re-rolls the field's seed. -->
    <div v-if="showSeed" class="flex items-center gap-2">
      <StudioButton variant="secondary" @click="rerollSeed">New variation</StudioButton>
      <div class="min-w-0 flex-1">
        <StudioSlider v-model="seed" label="Variation" :min="1" :max="9999" :step="1" :default="DEFAULT_SHADER_SPEC.seed" />
      </div>
    </div>

    <!-- Nested input fill: the recursive half, depth-limited to 1 via `nested`. Hidden
         whenever Reads is in a backdrop mode — the effect samples the backdrop/bound layer
         instead, so this control would otherwise sit there configuring a paint nobody sees. -->
    <div v-if="showInput && !modelValue.readsBackdrop" class="border-t border-white/10 pt-2.5">
      <label class="mb-1.5 block panel-label">Input fill</label>
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
