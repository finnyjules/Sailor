<script setup lang="ts">
/**
 * Property panel for the v2 (Swiss grid) editor. Region edits go through
 * setRegion so master vs format-class semantics live in one place; everything
 * else patches the element directly (v2 has no per-aspect style overrides).
 */
import { ChevronLeft, ChevronRight, Layers, Trash2, Type as TypeIcon, Image as ImageIcon, Square, Sparkles, Loader2, Expand, ArrowUp } from 'lucide-vue-next'

import StudioSection from '~/components/vue-canvas/StudioSection.vue'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'
import VariableGlyph from '~/components/vue-canvas/studio/VariableGlyph.vue'
import { useGoogleFontPreview } from '~/composables/useTemplateFonts'
import { useCopyAssist } from '~/composables/useCopyAssist'
import type { GridEditorContext } from '~/composables/useGridEditor'
import type { PhotoTreatment, Region, TextElementV2, TreatmentKind } from '~~/shared/template-grid/types'
import { BRAND_LOGO_SLOT_KEYS } from '~~/shared/brand/types'
import { paletteSlug } from '~~/shared/brand/resolve'
import { defaultExpressiveParams } from '~~/shared/text-layout/expressive'
import { mergeExpressivePatch } from '~~/shared/template-grid/expressive'
import type { GridExpressiveParams } from '~~/shared/template-grid/types'
import { isBoundToken, nextFreeSocket, tokenizeElementContent, columnLabelForElement } from '~/lib/collection/layoutPromote'
import type { SmartLayoutBindingContext } from '~/lib/collection/layoutBinding'
import { COLLECTION_PROP } from '~/lib/collection/types'
import type { CollectionData } from '~/lib/collection/types'
import { resolveBindings } from '~/lib/collection/resolve'
import { pushVarPreview, wiredTargets } from '~/lib/collection/preview'
import { addMediaRows } from '~/lib/collection/upload'
import { useLayoutTextEdit } from '~/composables/useLayoutTextEdit'

const ctx = inject<GridEditorContext>('gridEditor')!
const binding = inject<SmartLayoutBindingContext | null>('smartLayoutBinding', null)
const layoutText = useLayoutTextEdit(ctx, binding)
const {
  metrics, formatClass, isMaster, currentFormat, currentOutput, outputs, regionScope,
  selectedElement, selectedResolved, sampleProps, effectiveBrand,
  setRegion, hasClassRegion, clearClassRegion, hasOutputOverride, clearOutputOverride,
  isHiddenInOutput, setHiddenInOutput,
  hasContentOverride, setImageContentOverride, clearImageContentOverride,
  patchElement, patchStyle, removeElement,
} = ctx

const el = selectedElement

// -- Variable binding (Turn into variable write-through) ---------------------
// Same "live binding" contract the canvas badges use: a bound socket is a
// whole-match `{{ props.x }}` token AND an actual sailor_varBindings entry
// on the node (a hand-typed token with no binding is just literal content).
const boundSocket = computed<string | null>(() => {
  if (!el.value || !binding) return null
  if (el.value.type !== 'text' && el.value.type !== 'image') return null
  const socket = isBoundToken((el.value as any).content)
  if (!socket) return null
  return binding.bindings.value[`props.${socket}`] ? socket : null
})
const boundColumnKey = computed<string | null>(() =>
  (boundSocket.value && binding) ? (binding.bindings.value[`props.${boundSocket.value}`]?.columnKey ?? null) : null)

const wiredCollection = computed<CollectionData | undefined>(() =>
  binding?.collectionNode.value?.data?.properties?.[COLLECTION_PROP] as CollectionData | undefined)

// Display name for the bound column: its current user-editable `label`, not the
// frozen `columnKey`. The key is derived from the label at column-creation and
// never changes, so a renamed column header would otherwise show its old name.
// `boundColumnKey` stays the key for write-through/row logic; this is display-only.
const boundColumnLabel = computed<string | null>(() => {
  const key = boundColumnKey.value
  if (!key) return null
  return wiredCollection.value?.columns.find(col => col.key === key)?.label ?? key
})

/** Resolved cell value for the bound socket — what the write-through text
 *  field should display instead of the raw `{{ props.x }}` token. */
const resolvedBoundValue = computed<string>(() => {
  const socket = boundSocket.value
  const c = wiredCollection.value
  if (!socket || !c || !binding) return ''
  const { values } = resolveBindings(c, binding.bindings.value, c.previewRow)
  const v = values[`props.${socket}`]
  return v !== undefined ? String(v) : ''
})

function goToCollection() {
  const colNode = binding?.collectionNode.value
  if (colNode) window.dispatchEvent(new CustomEvent('sailor:openCollection', { detail: { nodeId: String(colNode.id) } }))
}

function unbindVariable() {
  if (!el.value || !binding || !boundSocket.value) return
  const resolved = resolvedBoundValue.value
  patchElement(el.value.id, { content: resolved || (el.value as any).content } as any)
  window.dispatchEvent(new CustomEvent('sailor:unbindControl', {
    detail: { nodeId: binding.nodeId, path: `props.${boundSocket.value}` },
  }))
}

/** Write-through: editing a bound text field updates the collection cell
 *  (+ pushes a fresh preview to every wired target), never the template's
 *  token content — the element stays `{{ props.<socket> }}` forever.
 *  Delegates the setCell+preview core to useLayoutTextEdit so the inline
 *  canvas text editor writes through identically. */
function writeThroughBoundText(value: string) {
  if (!el.value) return
  layoutText.commitText(el.value as any, value)
}

// -- Copy assistant (AI affordance — gen-pastel treatment) -------------------
// Variations / write-from-brief / translate, applying to the selected text
// element (bound → cell write-through; unbound → literal content) or landing
// as new collection rows. Endpoint contract: Task 4's /api/copy-assist
// (frontend/server/lib/copyAssist.ts) — { options: { text, language? }[] }.

const copyAssist = useCopyAssist()
const copyBrief = ref('')
const showTranslate = ref(false)
const COPY_LANGUAGES = ['EN', 'FR', 'DE', 'ES', 'IT', 'PT', 'NL', 'JA'] as const
const copyLanguages = ref<string[]>([])
const copyLanguageCustom = ref('')

function toggleCopyLanguage(lang: string) {
  const i = copyLanguages.value.indexOf(lang)
  if (i >= 0) copyLanguages.value = copyLanguages.value.filter(l => l !== lang)
  else copyLanguages.value = [...copyLanguages.value, lang]
}
function addCustomCopyLanguage() {
  const v = copyLanguageCustom.value.trim().toUpperCase()
  if (v && !copyLanguages.value.includes(v)) copyLanguages.value = [...copyLanguages.value, v]
  copyLanguageCustom.value = ''
}

/** The text the assistant works from: bound → resolved cell value (never the
 *  raw `{{ props.x }}` token), unbound → the element's literal content. */
const copySourceText = computed(() => {
  if (!textEl.value) return ''
  return boundSocket.value ? resolvedBoundValue.value : textEl.value.content
})

// context.brandTone would add campaign coherence, but no brand-tone field exists
// on the brand kit today (shared/brand/types.ts has colors/fonts/logo only) —
// skipped per the plan's "skip if not cheaply available" clause.

/** Rewrite the current copy: plain (no instruction) or a one-tap nudge
 *  (Shorter / Punchier), always returning a list of options. */
async function runVariations(instruction?: string) {
  if (!textEl.value) return
  await copyAssist.run({ mode: 'variations', text: copySourceText.value, instruction, count: 5 })
}
/** Write fresh copy for the slot from the free-text brief. */
async function runBrief() {
  if (!textEl.value || !copyBrief.value.trim()) return
  await copyAssist.run({ mode: 'brief', text: copySourceText.value, brief: copyBrief.value, count: 5 })
}
/** Localize the current copy into the picked languages (one option each). */
async function runTranslate() {
  if (!textEl.value || !copyLanguages.value.length) return
  await copyAssist.run({ mode: 'translate', text: copySourceText.value, languages: copyLanguages.value })
}

/** Click an option: apply to the element (bound → cell write-through,
 *  unbound → literal content patch). */
function applyCopyOption(text: string) {
  if (!el.value) return
  if (boundSocket.value) writeThroughBoundText(text)
  else patchElement(el.value.id, { content: text } as any)
}

/** Bound footer action: append one new row per option, override the bound
 *  column, and push a fresh preview to every wired target. */
function addCopyOptionsAsRows() {
  const c = wiredCollection.value
  const columnKey = boundColumnKey.value
  if (!c || !columnKey || !copyAssist.options.value.length) return
  addMediaRows(c, columnKey, copyAssist.options.value.map(o => o.text))
  const colNode = binding?.collectionNode.value
  if (colNode) {
    pushVarPreview(colNode, wiredTargets(String(colNode.id), binding!.nodesAccessor(), binding!.edgesAccessor()), binding!.nodesAccessor())
    window.dispatchEvent(new CustomEvent('sailor:openCollection', { detail: { nodeId: String(colNode.id) } }))
  }
}

/** Unbound footer action: run the same promote flow as the context menu's
 *  "Turn into variable" (Task 3), then add rows. The VueNodeCanvas handler is
 *  synchronous, so the binding exists immediately after the dispatch. */
function promoteThenAddCopyOptionsAsRows() {
  if (!el.value || !binding || el.value.type !== 'text') return
  const texts = copyAssist.options.value.map(o => o.text)
  if (!texts.length) return

  const socketName = nextFreeSocket(ctx.template.value, 'text')
  const { priorContent } = tokenizeElementContent(el.value as any, socketName)
  const label = columnLabelForElement(el.value as any, priorContent, socketName)
  patchElement(el.value.id, { content: `{{ props.${socketName} }}` } as any)
  window.dispatchEvent(new CustomEvent('sailor:promoteLayoutElement', {
    detail: { nodeId: binding.nodeId, socketName, columnLabel: label, currentValue: priorContent, kind: 'text' },
  }))

  const c = wiredCollection.value
  const columnKey = boundColumnKey.value
  if (!c || !columnKey) return
  addMediaRows(c, columnKey, texts)
  const colNode = binding.collectionNode.value
  if (colNode) {
    pushVarPreview(colNode, wiredTargets(String(colNode.id), binding.nodesAccessor(), binding.edgesAccessor()), binding.nodesAccessor())
    window.dispatchEvent(new CustomEvent('sailor:openCollection', { detail: { nodeId: String(colNode.id) } }))
  }
}

// Clear assistant results/mode state on element switch — stale options from a
// different element must never linger into the newly-selected one.
watch(() => el.value?.id, () => {
  copyAssist.clear()
  copyBrief.value = ''
  copyLanguages.value = []
  copyLanguageCustom.value = ''
  showTranslate.value = false
})

/** Display name for the current output (variation-aware). */
const outputLabel = computed(() =>
  currentOutput.value?.label ?? ctx.template.value.formats[currentFormat.value]?.label ?? currentFormat.value)
const region = computed<Region | null>(() => selectedResolved.value?.region ?? null)

function setRegionField(field: keyof Region, raw: string) {
  if (!el.value || !region.value) return
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n)) return
  const m = metrics.value
  const next = { ...region.value, [field]: n }
  next.col = Math.min(m.cols, Math.max(1, next.col))
  next.row = Math.min(m.rows, Math.max(1, next.row))
  next.colSpan = Math.min(m.cols - next.col + 1, Math.max(1, next.colSpan))
  next.rowSpan = Math.min(m.rows - next.row + 1, Math.max(1, next.rowSpan))
  setRegion(el.value.id, next)
}

/** Give a slotless (culled) element a region in the current class. */
function placeHere() {
  if (!el.value) return
  const m = metrics.value
  setRegion(el.value.id, { col: 1, colSpan: Math.min(3, m.cols), row: 1, rowSpan: 1 })
}

function styleOf(): Record<string, any> {
  return (el.value as any)?.style ?? {}
}

// -- Photo treatment (opt-in, image elements only) ---------------------------
// Never touched by generate/shuffle/surprise (see
// shared/template-grid/treatment.ts) — a plain style-field write here.
const imageTreatment = computed<PhotoTreatment>(() => (styleOf().treatment as PhotoTreatment | undefined) ?? { kind: 'none' })

function setTreatment(kind: TreatmentKind) {
  if (!el.value) return
  patchStyle(el.value.id, {
    treatment: kind === 'none' ? undefined : { kind, intensity: imageTreatment.value.intensity ?? 1 },
  })
}

function setTreatmentIntensity(intensity: number) {
  if (!el.value || imageTreatment.value.kind === 'none') return
  patchStyle(el.value.id, { treatment: { kind: imageTreatment.value.kind, intensity } })
}

const textEl = computed(() => (el.value?.type === 'text' ? el.value as TextElementV2 : null))

// -- Variant cycler (multi-entry upstream Text nodes) ------------------------
// Provided by SmartLayoutEditorModal; layer ids match element ids.
const variantCtx = inject<{
  variantsByLayer: { value: Record<string, string[]> }
  activeVariantByLayer: { value: Record<string, number> }
} | null>('smartLayoutVariants', null)

const variantsForSelected = computed<string[]>(() => {
  if (!variantCtx || !el.value) return []
  return variantCtx.variantsByLayer.value[el.value.id] ?? []
})
const activeVariantIdx = computed<number>({
  get() {
    if (!variantCtx || !el.value) return 0
    const n = variantsForSelected.value.length
    return Math.min(Math.max(0, variantCtx.activeVariantByLayer.value[el.value.id] ?? 0), Math.max(0, n - 1))
  },
  set(v) {
    if (!variantCtx || !el.value) return
    variantCtx.activeVariantByLayer.value = {
      ...variantCtx.activeVariantByLayer.value,
      [el.value.id]: v,
    }
  },
})
function cycleVariant(dir: 1 | -1) {
  const n = variantsForSelected.value.length
  if (n < 2) return
  activeVariantIdx.value = (activeVariantIdx.value + dir + n) % n
}

// -- Font preview loading -----------------------------------------------------
const { ensure: ensureFont } = useGoogleFontPreview()
function setFontFamily(family: string) {
  if (!el.value) return
  ensureFont(family)
  patchStyle(el.value.id, { fontFamily: family })
}

// -- Brand binding -----------------------------------------------------------
// A style value bound to a brand slot is stored as a `{{ brand.<key> }}` token
// and resolved live from the brand kit. Only show swatches for slots the kit
// actually defines.

const BRAND_COLOR_SLOTS = ['primary', 'secondary', 'accent', 'foreground', 'background'] as const
const brandColorSlots = computed(() =>
  BRAND_COLOR_SLOTS.filter(k => typeof (effectiveBrand.value as any)[k] === 'string'))

// Named palette entries → one-click {{ brand.palette.<slug> }} binds, next to
// the role-slot binds. Names carry user meaning ("viridian"), roles carry
// template meaning — both stay available. Legacy kits have no `palette` field
// on effectiveBrand, so this is naturally empty and the buttons stay hidden.
const brandPaletteEntries = computed(() =>
  (((effectiveBrand.value as any).palette ?? []) as { id: string; name: string; hex: string }[])
    .filter(e => e.name && e.hex && paletteSlug(e.name)))
function paletteTokenFor(name: string): string {
  return `{{ brand.palette.${paletteSlug(name)} }}`
}

function brandTokenKey(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const m = v.match(/^\{\{\s*brand\.([\w.]+)\s*\}\}$/)
  return m ? m[1] : null
}
function brandSwatch(key: string): string {
  return String((effectiveBrand.value as any)[key] ?? '#888')
}
/** Resolve a style colour through the brand kit for the native colour input. */
function resolvedColor(v: unknown, fallback: string): string {
  const k = brandTokenKey(v)
  if (k) return brandSwatch(k)
  return typeof v === 'string' && v.startsWith('#') ? v : fallback
}
function bindColorToBrand(styleKey: 'color' | 'fill', slot: string) {
  if (el.value) patchStyle(el.value.id, { [styleKey]: `{{ brand.${slot} }}` })
}
/** Sibling to bindColorToBrand for palette entries, which bind to a full
 *  `{{ brand.palette.<slug> }}` token rather than a role slot key. */
function bindColorToken(styleKey: 'color' | 'fill', token: string) {
  if (el.value) patchStyle(el.value.id, { [styleKey]: token })
}

const brandFontSlots = computed(() => {
  const out: Array<{ slot: 'fontDisplay' | 'fontBody'; label: string; family: string }> = []
  const b = effectiveBrand.value as any
  if (typeof b.fontDisplay === 'string') out.push({ slot: 'fontDisplay', label: 'Brand display', family: b.fontDisplay })
  if (typeof b.fontBody === 'string') out.push({ slot: 'fontBody', label: 'Brand body', family: b.fontBody })
  return out
})
const fontBoundLabel = computed(() => {
  const k = brandTokenKey(styleOf().fontFamily)
  return k === 'fontDisplay' ? 'Brand display' : k === 'fontBody' ? 'Brand body' : null
})
function bindFontToBrand(slot: 'fontDisplay' | 'fontBody') {
  if (el.value) patchStyle(el.value.id, { fontFamily: `{{ brand.${slot} }}` })
}
const hasBrandLogo = computed(() => typeof (effectiveBrand.value as any).logo === 'string')
const usingBrandLogo = computed(() => el.value?.type === 'image' && (el.value as any).content === '{{ brand.logo }}')
// Non-primary logo slots available on the effective brand (primary is covered
// by the existing "Use brand logo" button via the legacy back-fill).
const brandLogoSlots = computed(() => {
  const logos = (effectiveBrand.value as any).logos as Record<string, string> | undefined
  if (!logos) return [] as string[]
  return BRAND_LOGO_SLOT_KEYS.filter(s => s !== 'primary' && typeof logos[s] === 'string')
})
const brandAssets = computed(() =>
  (((effectiveBrand.value as any).assets ?? []) as { id: string; name: string; path: string }[]))
function usingSlot(slot: string) {
  return el.value?.type === 'image' && (el.value as any).content === `{{ brand.logos.${slot} }}`
}

// -- Text panel / scrim ------------------------------------------------------
const panel = computed(() => textEl.value?.style?.panel ?? null)
function setPanel(patch: Record<string, unknown> | null) {
  if (!el.value) return
  if (patch === null) { patchStyle(el.value.id, { panel: undefined }); return }
  patchStyle(el.value.id, { panel: { ...(panel.value ?? { fill: '#000000', opacity: 0.5 }), ...patch } })
}
function bindPanelToBrand(slot: string) {
  setPanel({ fill: `{{ brand.${slot} }}` })
}
/** Sibling to bindPanelToBrand for palette entries — full token, not a slot key. */
function bindPanelToToken(token: string) {
  setPanel({ fill: token })
}

// -- Expressive text layout --------------------------------------------------
const expressive = computed<GridExpressiveParams | undefined>(() => styleOf().expressive)
function setExpressive(patch: Partial<GridExpressiveParams>) {
  if (!el.value) return
  // mergeExpressivePatch drops manual word nudges on any engine-param change
  // (Shuffle, placement, words-per-line, jitter) — "re-roll means start over".
  patchStyle(el.value.id, { expressive: mergeExpressivePatch(expressive.value ?? defaultExpressiveParams(), patch) })
}
function toggleExpressive(on: boolean) {
  if (!el.value) return
  patchStyle(el.value.id, { expressive: on ? defaultExpressiveParams() : undefined })
}
function rerollExpressive() {
  if (expressive.value) setExpressive({ seed: (expressive.value.seed | 0) + 1 })
}

/** Placeholder for the size input: the level-derived size in master px. */
const levelSizePlaceholder = computed(() => {
  if (!textEl.value) return ''
  const t = ctx.template.value
  const idx = ['caption', 'body', 'subhead', 'headline', 'display'].indexOf(textEl.value.level)
  return String(Math.round(t.typeScale.base * t.typeScale.ratio ** idx))
})

const focalSrc = computed(() => {
  if (el.value?.type !== 'image') return undefined
  const resolved = String(el.value.content ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
    const [scope, key] = path.split('.')
    return scope === 'props' ? String((sampleProps.value as any)[key] ?? '') : ''
  })
  return resolved.startsWith('http') || resolved.startsWith('/') ? resolved : undefined
})

// -- Outpaint to fit ---------------------------------------------------------
// Generatively extend the image to the current format's aspect and store it as
// a per-output content override (this format only; others keep the original).
const outpaint = useOutpaintFit()
const outpaintAspect = computed(() => {
  const f = ctx.template.value.formats[currentFormat.value]
  return f && f.h ? f.w / f.h : 1
})
async function runOutpaint() {
  if (!el.value || el.value.type !== 'image' || !focalSrc.value) return
  try {
    const url = await outpaint.run(focalSrc.value, outpaintAspect.value)
    setImageContentOverride(el.value.id, url)
  } catch { /* error surfaced via outpaint.error.value */ }
}

const inputCls = 'w-full h-7 px-2 bg-white/[0.04] border border-white/[0.06] rounded text-[12px] text-white focus:outline-none focus:border-action/50'
const labelCls = 'panel-label'
const btnRowCls = 'flex-1 h-7 rounded text-[11px] transition-colors cursor-pointer'
</script>

<template>
  <div v-if="el" class="h-full overflow-y-auto p-3 flex flex-col gap-2.5">
    <!-- Header -->
    <div class="flex items-center gap-2">
      <component
        :is="el.type === 'text' ? TypeIcon : el.type === 'image' ? ImageIcon : Square"
        class="size-3.5 text-white/45 shrink-0"
      />
      <input
        :value="el.id"
        :class="inputCls"
        @change="(e: any) => patchElement(el!.id, { id: e.target.value })"
      >
      <button
        class="size-7 shrink-0 rounded flex items-center justify-center text-white/40 hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
        title="Delete element"
        @click="removeElement(el.id)"
      >
        <Trash2 class="size-3.5" />
      </button>
    </div>

    <TemplatesAlignControls />

    <!-- Variant cycler — visible when this element is wired to a multi-entry
         Text node. Picks which variant the canvas previews; run time still
         fans out one image per variant. -->
    <div v-if="variantsForSelected.length > 1" class="rounded-md bg-action/[0.06] border border-action/15 px-2.5 py-2 flex flex-col gap-1.5">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.12em] text-[#c9d6ff]/85 font-medium">
          <Layers class="size-3" />
          <span>Variant {{ activeVariantIdx + 1 }} of {{ variantsForSelected.length }}</span>
        </div>
        <div class="flex items-center gap-0.5">
          <button class="size-6 rounded hover:bg-action/15 flex items-center justify-center text-white/65 hover:text-white cursor-pointer transition-colors" title="Previous variant" @click="cycleVariant(-1)">
            <ChevronLeft class="size-3.5" />
          </button>
          <button class="size-6 rounded hover:bg-action/15 flex items-center justify-center text-white/65 hover:text-white cursor-pointer transition-colors" title="Next variant" @click="cycleVariant(1)">
            <ChevronRight class="size-3.5" />
          </button>
        </div>
      </div>
      <div class="text-[11px] text-white/65 leading-snug italic line-clamp-3 font-mono">
        "{{ variantsForSelected[activeVariantIdx] }}"
      </div>
      <div class="text-[10px] text-white/35 leading-snug">
        Run time renders one image per variant — this just picks which one to lay out against.
      </div>
    </div>

    <!-- Edit scope + per-output controls. Shown whenever there's more than one
         output to diverge between (variations or different formats). -->
    <div v-if="outputs.length > 1" class="rounded-md bg-action/[0.08] border border-action/20 px-2.5 py-2 leading-snug">
      <div class="flex gap-1 mb-2">
        <button
          v-for="opt in (['class', 'output'] as const)" :key="opt"
          class="flex-1 h-6 rounded text-[10px] transition-colors cursor-pointer"
          :class="regionScope === opt ? 'bg-action/30 text-white' : 'bg-white/[0.04] text-white/50 hover:bg-white/[0.08]'"
          @click="regionScope = opt"
        >{{ opt === 'class' ? (isMaster ? 'All formats' : `All ${formatClass}`) : 'Only this' }}</button>
      </div>
      <p class="text-[11px] text-[#c9d6ff]/90">
        <template v-if="regionScope === 'class'">
          <template v-if="isMaster">Edits apply to <span class="font-medium">all formats</span>.</template>
          <template v-else>Region edits apply to every <span class="font-medium">{{ formatClass }}</span> format.</template>
        </template>
        <template v-else>
          Edits apply only to <span class="font-medium">{{ outputLabel }}</span> — diverge this variation.
        </template>
      </p>
      <button
        v-if="regionScope === 'class' && !isMaster && hasClassRegion(el.id)"
        class="mt-1.5 block text-[11px] text-action hover:text-white transition-colors cursor-pointer underline underline-offset-2"
        @click="clearClassRegion(el.id)"
      >
        Reset {{ formatClass }} to automatic
      </button>
      <button
        v-if="regionScope === 'output' && hasOutputOverride(el.id)"
        class="mt-1.5 block text-[11px] text-action hover:text-white transition-colors cursor-pointer underline underline-offset-2"
        @click="clearOutputOverride(el.id)"
      >
        Clear this output's override
      </button>
      <label class="mt-2 pt-2 border-t border-white/[0.06] flex items-center gap-2 text-[11px] text-white/70 cursor-pointer">
        <input
          type="checkbox" :checked="isHiddenInOutput(el.id)"
          @change="(e: any) => setHiddenInOutput(el!.id, e.target.checked)"
        >
        <span>Hide in <span class="font-medium">{{ outputLabel }}</span> only</span>
      </label>
    </div>

    <!-- Position & size -->
    <StudioSection title="Layout" :badge="el.type">
      <div>
        <p :class="labelCls" class="mb-1.5">Grid region</p>
        <div v-if="region" class="grid grid-cols-2 gap-2">
          <label class="flex items-center gap-1.5">
            <span
              class="text-[11px] text-white/40 w-8"
              v-scrub="{ get: () => region!.col, set: (v: number) => setRegionField('col', String(v)), min: 1, max: metrics.cols, step: 1 }"
            >Col</span>
            <input type="number" min="1" :max="metrics.cols" :value="region.col" :class="inputCls" @change="(e: any) => setRegionField('col', e.target.value)">
          </label>
          <label class="flex items-center gap-1.5">
            <span
              class="text-[11px] text-white/40 w-8"
              v-scrub="{ get: () => region!.colSpan, set: (v: number) => setRegionField('colSpan', String(v)), min: 1, max: metrics.cols, step: 1 }"
            >Span</span>
            <input type="number" min="1" :max="metrics.cols" :value="region.colSpan" :class="inputCls" @change="(e: any) => setRegionField('colSpan', e.target.value)">
          </label>
          <label class="flex items-center gap-1.5">
            <span
              class="text-[11px] text-white/40 w-8"
              v-scrub="{ get: () => region!.row, set: (v: number) => setRegionField('row', String(v)), min: 1, max: metrics.rows, step: 1 }"
            >Row</span>
            <input type="number" min="1" :max="metrics.rows" :value="region.row" :class="inputCls" @change="(e: any) => setRegionField('row', e.target.value)">
          </label>
          <label class="flex items-center gap-1.5">
            <span
              class="text-[11px] text-white/40 w-8"
              v-scrub="{ get: () => region!.rowSpan, set: (v: number) => setRegionField('rowSpan', String(v)), min: 1, max: metrics.rows, step: 1 }"
            >Span</span>
            <input type="number" min="1" :max="metrics.rows" :value="region.rowSpan" :class="inputCls" @change="(e: any) => setRegionField('rowSpan', e.target.value)">
          </label>
        </div>
        <button
          v-else
          class="w-full h-8 rounded-md bg-amber-500/10 border border-amber-500/25 text-[11px] text-amber-200/90 hover:bg-amber-500/20 transition-colors cursor-pointer"
          @click="placeHere"
        >
          Culled in this format — place it here
        </button>
        <label class="mt-2 flex items-center gap-2 text-[12px] text-white/70 cursor-pointer">
          <input
            type="checkbox" :checked="el.bleed === true"
            @change="(e: any) => patchElement(el!.id, { bleed: e.target.checked || undefined })"
          >
          <span>Bleed past margin <span class="text-white/35">(extend to canvas edge on the sides it borders)</span></span>
        </label>
      </div>
      <div>
        <p :class="labelCls" class="mb-1.5">Priority</p>
        <input
          type="number" min="1" max="9" :value="el.priority" :class="inputCls"
          @change="(e: any) => patchElement(el!.id, { priority: Math.max(1, Math.round(Number(e.target.value)) || 1) })"
        >
        <p class="mt-1 text-[10px] text-white/30">1 = most important; survives longest on small formats.</p>
      </div>
    </StudioSection>

    <!-- Variable binding — image elements bound to a Collection column. (Text
         elements fold this into the pink row in the Text section below, so the
         binding actions aren't duplicated.) -->
    <StudioSection v-if="boundSocket && el?.type !== 'text'" title="Variable" badge="Bound">
      <div class="flex items-center justify-between gap-2">
        <div class="min-w-0 flex items-center gap-1.5">
          <VariableGlyph :bound="boundColumnKey" />
          <div class="min-w-0">
            <p class="text-[12px] truncate" style="color: var(--var-accent-text)">{{ boundColumnLabel }}</p>
            <p class="text-[10px] text-white/35">Editing writes to this column's row.</p>
          </div>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <button
            class="h-7 px-2 rounded text-[11px] bg-white/[0.06] hover:bg-white/[0.12] text-white/75 hover:text-white transition-colors cursor-pointer"
            @click="goToCollection"
          >
            Go to collection
          </button>
          <button
            class="h-7 px-2 rounded text-[11px] bg-white/[0.06] hover:bg-red-500/15 text-white/60 hover:text-red-300 transition-colors cursor-pointer"
            @click="unbindVariable"
          >
            Unbind
          </button>
        </div>
      </div>
    </StudioSection>

    <!-- Text -->
    <template v-if="textEl">
      <StudioSection :title="boundSocket ? 'Text' : 'Content'" :badge="boundSocket ? 'Bound' : 'Text'">
        <!-- Bound: pink read-only row — the variable name, never the resolved
             literal text. Editing happens in the collection table, not here. -->
        <div v-if="boundSocket" class="flex items-center justify-between gap-2">
          <div class="min-w-0 flex items-center gap-1.5">
            <VariableGlyph :bound="boundColumnKey" />
            <p class="text-[12px] truncate" style="color: var(--var-accent-text)">{{ boundColumnLabel }}</p>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <button
              class="h-7 px-2 rounded text-[11px] bg-white/[0.06] hover:bg-white/[0.12] text-white/75 hover:text-white transition-colors cursor-pointer"
              @click="goToCollection"
            >
              Edit in table
            </button>
            <button
              class="h-7 px-2 rounded text-[11px] bg-white/[0.06] hover:bg-red-500/15 text-white/60 hover:text-red-300 transition-colors cursor-pointer"
              @click="unbindVariable"
            >
              Unbind
            </button>
          </div>
        </div>
        <textarea
          v-else
          :value="textEl.content"
          rows="3"
          :class="inputCls"
          class="h-auto py-1.5 resize-y"
          @change="(e: any) => patchElement(el!.id, { content: e.target.value })"
        />
      </StudioSection>

      <!-- Copy assistant — content-first: attached right under the text it edits.
           One instruction input (brief) + quick chips (variations / shorter /
           punchier / translate). All still return a list of options to pick from. -->
      <div class="pastel-hairline rounded-lg p-2.5 flex flex-col gap-2.5" style="--pastel-hairline-bg: #15151a">
          <div class="flex items-center gap-1.5">
            <Sparkles class="size-3.5 text-white/70" />
            <p class="text-[11px] font-medium text-white/85">Rewrite copy</p>
          </div>

          <!-- Brief: describe the copy you want (arrow embedded, composer-style) -->
          <div class="relative">
            <input
              v-model="copyBrief"
              placeholder="Describe the copy you want…"
              :class="inputCls"
              class="pr-9"
              :disabled="copyAssist.loading.value"
              @keydown.enter.prevent="runBrief"
            >
            <button
              class="gen-pastel absolute right-1 top-1/2 -translate-y-1/2 size-[22px] rounded-md text-neutral-900 flex items-center justify-center cursor-pointer disabled:opacity-40 disabled:cursor-default"
              title="Write from this brief"
              :disabled="copyAssist.loading.value || !copyBrief.trim()"
              @click="runBrief"
            >
              <Loader2 v-if="copyAssist.loading.value" class="size-3 animate-spin" />
              <ArrowUp v-else class="size-3.5" />
            </button>
          </div>

          <!-- Quick actions on the current text -->
          <div class="flex flex-wrap gap-1">
            <button
              class="h-6 px-2 rounded-full text-[10.5px] flex items-center gap-1 transition-colors cursor-pointer bg-[#d7f5e6]/[0.12] border border-[#d7f5e6]/25 text-[#cdeede] hover:bg-[#d7f5e6]/20 disabled:opacity-40 disabled:cursor-default"
              title="Generate variations of the current copy"
              :disabled="copyAssist.loading.value || !copySourceText.trim()"
              @click="runVariations()"
            >
              <Sparkles class="size-3" /> 4 variations
            </button>
            <button
              class="h-6 px-2 rounded-full text-[10.5px] bg-white/[0.05] border border-white/[0.09] text-white/60 hover:bg-white/[0.1] hover:text-white transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default"
              :disabled="copyAssist.loading.value || !copySourceText.trim()"
              @click="runVariations('Make each option noticeably shorter and tighter than the original.')"
            >Shorter</button>
            <button
              class="h-6 px-2 rounded-full text-[10.5px] bg-white/[0.05] border border-white/[0.09] text-white/60 hover:bg-white/[0.1] hover:text-white transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default"
              :disabled="copyAssist.loading.value || !copySourceText.trim()"
              @click="runVariations('Make each option punchier, bolder, and more energetic.')"
            >Punchier</button>
            <button
              class="h-6 px-2 rounded-full text-[10.5px] transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default"
              :class="showTranslate ? 'bg-white/15 text-white border border-white/20' : 'bg-white/[0.05] border border-white/[0.09] text-white/60 hover:bg-white/[0.1] hover:text-white'"
              :disabled="copyAssist.loading.value || !copySourceText.trim()"
              @click="showTranslate = !showTranslate"
            >Translate…</button>
          </div>

          <!-- Translate disclosure -->
          <div v-if="showTranslate" class="flex flex-col gap-1.5 rounded-md bg-white/[0.03] p-2">
            <div class="flex flex-wrap gap-1">
              <button
                v-for="lang in COPY_LANGUAGES" :key="lang"
                class="h-6 px-1.5 rounded text-[10.5px] transition-colors cursor-pointer"
                :class="copyLanguages.includes(lang) ? 'bg-white/20 text-white' : 'bg-white/[0.04] text-white/50 hover:bg-white/[0.08]'"
                @click="toggleCopyLanguage(lang)"
              >{{ lang }}</button>
            </div>
            <div class="flex gap-1">
              <input
                v-model="copyLanguageCustom"
                placeholder="Add a language…"
                :class="inputCls"
                @keydown.enter.prevent="addCustomCopyLanguage"
              >
              <button
                class="h-7 px-2 rounded text-[11px] bg-white/[0.06] hover:bg-white/[0.12] text-white/70 hover:text-white transition-colors cursor-pointer shrink-0"
                @click="addCustomCopyLanguage"
              >Add</button>
            </div>
            <div v-if="copyLanguages.length" class="flex flex-wrap gap-1">
              <span
                v-for="lang in copyLanguages" :key="lang"
                class="h-5 px-1.5 rounded-full bg-white/10 text-[9.5px] text-white/70 flex items-center gap-1"
              >
                {{ lang }}
                <button class="text-white/40 hover:text-white/80 cursor-pointer" @click="toggleCopyLanguage(lang)">×</button>
              </span>
            </div>
            <button
              class="gen-pastel h-7 rounded-md text-neutral-900 text-[11px] font-semibold cursor-pointer disabled:opacity-40 disabled:cursor-default flex items-center justify-center gap-1.5"
              :disabled="copyAssist.loading.value || !copyLanguages.length"
              @click="runTranslate"
            >
              <Loader2 v-if="copyAssist.loading.value" class="size-3.5 animate-spin" />
              <span>Translate to {{ copyLanguages.length || '…' }}</span>
            </button>
          </div>

          <p v-if="copyAssist.error.value" class="text-[10.5px] text-red-300/90">{{ copyAssist.error.value }}</p>

          <!-- Results -->
          <div v-if="copyAssist.options.value.length" class="flex flex-col gap-1 mt-0.5">
            <button
              v-for="(opt, i) in copyAssist.options.value" :key="i"
              class="w-full text-left px-2 py-1.5 rounded bg-white/[0.04] hover:bg-white/[0.09] transition-colors cursor-pointer flex items-start gap-1.5"
              @click="applyCopyOption(opt.text)"
            >
              <span v-if="opt.language" class="shrink-0 mt-0.5 h-4 px-1 rounded-full bg-white/10 text-[9px] text-white/60 uppercase tracking-wide">{{ opt.language }}</span>
              <span class="text-[11.5px] text-white/80 leading-snug">{{ opt.text }}</span>
            </button>

            <button
              v-if="boundSocket"
              class="mt-1 h-7 rounded-md bg-white/[0.06] hover:bg-white/[0.12] text-[11px] text-white/75 hover:text-white transition-colors cursor-pointer"
              @click="addCopyOptionsAsRows"
            >
              Add all as rows
            </button>
            <button
              v-else-if="binding"
              class="mt-1 h-7 rounded-md bg-white/[0.06] hover:bg-white/[0.12] text-[11px] text-white/75 hover:text-white transition-colors cursor-pointer"
              @click="promoteThenAddCopyOptionsAsRows"
            >
              Make variable + add as rows
            </button>
          </div>
      </div>

      <StudioSection title="Typography">
        <div>
          <p :class="labelCls" class="mb-1.5">Font</p>
        <TemplatesFontPicker
          :model-value="fontBoundLabel ? (effectiveBrand as any)[brandTokenKey(styleOf().fontFamily)!] : (styleOf().fontFamily ?? 'Inter')"
          @update:model-value="setFontFamily"
        />
        <div v-if="brandFontSlots.length" class="flex items-center gap-1 mt-1.5">
          <span class="text-[10px] text-white/30">Brand:</span>
          <button
            v-for="f in brandFontSlots"
            :key="f.slot"
            class="px-1.5 h-6 rounded text-[10px] transition-colors cursor-pointer"
            :class="fontBoundLabel === f.label ? 'bg-action/25 text-[#c9d6ff]' : 'bg-white/[0.04] text-white/45 hover:bg-white/[0.08]'"
            :title="`Bind to ${f.label} (${f.family})`"
            @click="bindFontToBrand(f.slot)"
          >{{ f.label.replace('Brand ', '') }}</button>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-2">
        <div>
          <p :class="labelCls" class="mb-1.5">Level</p>
          <select :value="textEl.level" :class="inputCls" @change="(e: any) => patchElement(el!.id, { level: e.target.value })">
            <option v-for="l in ['display', 'headline', 'subhead', 'body', 'caption']" :key="l" :value="l">{{ l }}</option>
          </select>
        </div>
        <div>
          <p :class="labelCls" class="mb-1.5" title="Exact master-format px (scales down on smaller formats). Leave blank to auto-size from the level and fit the region.">Size (px)</p>
          <input
            type="number" min="1" :value="styleOf().fontSize ?? ''" :placeholder="levelSizePlaceholder" :class="inputCls"
            @change="(e: any) => patchStyle(el!.id, { fontSize: e.target.value ? Math.max(1, Math.round(Number(e.target.value))) : undefined })"
          >
        </div>
        <div>
          <p :class="labelCls" class="mb-1.5">Weight</p>
          <select :value="styleOf().fontWeight ?? 400" :class="inputCls" @change="(e: any) => patchStyle(el!.id, { fontWeight: Number(e.target.value) })">
            <option :value="400">Regular</option>
            <option :value="700">Bold</option>
          </select>
        </div>
        <div>
          <p :class="labelCls" class="mb-1.5">Case</p>
          <select :value="styleOf().transform ?? 'none'" :class="inputCls" @change="(e: any) => patchStyle(el!.id, { transform: e.target.value === 'none' ? undefined : e.target.value })">
            <option value="none">As typed</option>
            <option value="uppercase">UPPERCASE</option>
          </select>
        </div>
        <div>
          <p :class="labelCls" class="mb-1.5" title="Unitless multiplier">Line height</p>
          <input
            type="number" step="0.05" min="0.5" :value="styleOf().lineHeight ?? 1.1" :class="inputCls"
            @change="(e: any) => patchStyle(el!.id, { lineHeight: Math.max(0.5, Number(e.target.value) || 1.1) })"
          >
        </div>
        <div>
          <p :class="labelCls" class="mb-1.5" title="Kerning, px">Letter spacing</p>
          <input
            type="number" step="0.5" :value="styleOf().letterSpacing ?? 0" :class="inputCls"
            @change="(e: any) => patchStyle(el!.id, { letterSpacing: Number(e.target.value) || 0 })"
          >
        </div>
        <div>
          <p :class="labelCls" class="mb-1.5">Overflow</p>
          <select :value="textEl.overflow ?? 'shrink-then-truncate'" :class="inputCls" @change="(e: any) => patchElement(el!.id, { overflow: e.target.value })">
            <option value="shrink-then-truncate">Shrink, then …</option>
            <option value="shrink">Shrink only</option>
            <option value="grow">Grow downward</option>
          </select>
        </div>
        <div>
          <p :class="labelCls" class="mb-1.5">Max lines</p>
          <input
            type="number" min="1" :value="textEl.maxLines ?? ''" placeholder="auto" :class="inputCls"
            @change="(e: any) => patchElement(el!.id, { maxLines: e.target.value ? Math.max(1, Math.round(Number(e.target.value))) : undefined })"
          >
        </div>
      </div>
      </StudioSection>
      <StudioSection title="Alignment">
      <div>
        <div class="flex gap-1 mb-2">
          <button
            v-for="a in ['left', 'center', 'right', 'justify']" :key="a" :class="[btnRowCls, (styleOf().align ?? 'left') === a ? 'bg-action/20 text-[#c9d6ff]' : 'bg-white/[0.04] text-white/50 hover:bg-white/[0.08]']"
            @click="patchStyle(el!.id, { align: a })"
          >{{ a }}</button>
        </div>
        <div class="flex gap-1">
          <button
            v-for="v in ['top', 'middle', 'bottom', 'justify']" :key="v" :class="[btnRowCls, (styleOf().valign ?? 'top') === v ? 'bg-action/20 text-[#c9d6ff]' : 'bg-white/[0.04] text-white/50 hover:bg-white/[0.08]']"
            @click="patchStyle(el!.id, { valign: v })"
          >{{ v }}</button>
        </div>
      </div>
      </StudioSection>
      <StudioSection title="Expressive layout">
      <div>
        <label class="flex items-center gap-1.5 cursor-pointer mb-2">
          <input type="checkbox" :checked="!!expressive" @change="(e: any) => toggleExpressive(e.target.checked)">
          <span class="text-[11px] text-white/60">Place words individually (overrides align)</span>
        </label>
        <template v-if="expressive">
          <div class="grid grid-cols-2 gap-2 mb-2">
            <div>
              <p :class="labelCls" class="mb-1">Words / line</p>
              <input type="number" min="1" max="12" :value="expressive.wordsPerLine" :class="inputCls"
                @input="(e: any) => setExpressive({ wordsPerLine: Math.max(1, Math.round(Number(e.target.value) || 1)) })">
            </div>
            <div>
              <p :class="labelCls" class="mb-1">Placement</p>
              <select :value="expressive.placement" :class="inputCls"
                @change="(e: any) => setExpressive({ placement: e.target.value })">
                <option value="random">Random</option>
                <option value="edges">Edges</option>
                <option value="staircase">Staircase</option>
                <option value="alternate">Alternate</option>
              </select>
            </div>
          </div>
          <div class="grid grid-cols-2 gap-2 mb-2">
            <StudioSlider label="Jitter X" :min="0" :max="1" :step="0.05" :bindable="false"
              :model-value="expressive.jitterX" @update:model-value="(v) => setExpressive({ jitterX: v })" />
            <StudioSlider label="Jitter Y" :min="0" :max="1" :step="0.05" :bindable="false"
              :model-value="expressive.jitterY" @update:model-value="(v) => setExpressive({ jitterY: v })" />
          </div>
          <button :class="[btnRowCls, 'w-full bg-white/[0.04] text-white/70 hover:bg-white/[0.08]']"
            @click="rerollExpressive()">⟳ Reroll</button>
        </template>
      </div>
      </StudioSection>
      <StudioSection title="Colour">
      <div>
        <p :class="labelCls" class="mb-1.5">Color</p>
        <div class="flex gap-2 items-center">
          <input
            type="color" :value="resolvedColor(styleOf().color, '#ffffff')"
            class="size-7 shrink-0 rounded border border-white/[0.06] bg-transparent cursor-pointer"
            @input="(e: any) => patchStyle(el!.id, { color: e.target.value })"
          >
          <input
            :value="brandTokenKey(styleOf().color) ? `brand.${brandTokenKey(styleOf().color)}` : (styleOf().color ?? '#ffffff')"
            :class="[inputCls, brandTokenKey(styleOf().color) ? 'text-[#c9d6ff]' : '']"
            @change="(e: any) => patchStyle(el!.id, { color: e.target.value })"
          >
        </div>
        <div v-if="brandColorSlots.length" class="flex items-center gap-1 mt-1.5">
          <span class="text-[10px] text-white/30">Brand:</span>
          <button
            v-for="slot in brandColorSlots"
            :key="slot"
            class="size-5 rounded-full border cursor-pointer transition"
            :class="brandTokenKey(styleOf().color) === slot ? 'border-white ring-1 ring-action' : 'border-white/20 hover:border-white/50'"
            :style="{ background: brandSwatch(slot) }"
            :title="`Bind to brand.${slot}`"
            @click="bindColorToBrand('color', slot)"
          />
          <button
            v-for="e in brandPaletteEntries" :key="e.id"
            class="px-1.5 h-6 rounded text-[10px] flex items-center gap-1 transition-colors cursor-pointer"
            :class="brandTokenKey(styleOf().color) === 'palette.' + paletteSlug(e.name) ? 'bg-action/25 text-[#c9d6ff]' : 'bg-white/[0.04] text-white/45 hover:bg-white/[0.08]'"
            :title="`Bind to ${e.name}`"
            @click="bindColorToken('color', paletteTokenFor(e.name))"
          >
            <span class="size-3 rounded-sm border border-white/10" :style="{ background: e.hex }" />
            {{ e.name }}
          </button>
        </div>
      </div>

      <!-- Legibility panel / scrim -->
      <div>
        <div class="flex items-center justify-between mb-1.5">
          <p :class="labelCls">Panel / scrim</p>
          <label class="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" :checked="!!panel" @change="(e: any) => setPanel(e.target.checked ? {} : null)">
            <span class="text-[11px] text-white/50">behind text</span>
          </label>
        </div>
        <template v-if="panel">
          <div class="flex gap-2 items-center">
            <input
              type="color" :value="resolvedColor(panel.fill, '#000000')"
              class="size-7 shrink-0 rounded border border-white/[0.06] bg-transparent cursor-pointer"
              @input="(e: any) => setPanel({ fill: e.target.value })"
            >
            <input
              :value="brandTokenKey(panel.fill) ? `brand.${brandTokenKey(panel.fill)}` : (panel.fill ?? '#000000')"
              :class="[inputCls, brandTokenKey(panel.fill) ? 'text-[#c9d6ff]' : '']"
              @change="(e: any) => setPanel({ fill: e.target.value })"
            >
          </div>
          <div v-if="brandColorSlots.length" class="flex items-center gap-1 mt-1.5">
            <span class="text-[10px] text-white/30">Brand:</span>
            <button
              v-for="slot in brandColorSlots"
              :key="slot"
              class="size-5 rounded-full border cursor-pointer transition"
              :class="brandTokenKey(panel.fill) === slot ? 'border-white ring-1 ring-action' : 'border-white/20 hover:border-white/50'"
              :style="{ background: brandSwatch(slot) }"
              :title="`Bind panel to brand.${slot}`"
              @click="bindPanelToBrand(slot)"
            />
            <button
              v-for="e in brandPaletteEntries" :key="e.id"
              class="px-1.5 h-6 rounded text-[10px] flex items-center gap-1 transition-colors cursor-pointer"
              :class="brandTokenKey(panel.fill) === 'palette.' + paletteSlug(e.name) ? 'bg-action/25 text-[#c9d6ff]' : 'bg-white/[0.04] text-white/45 hover:bg-white/[0.08]'"
              :title="`Bind panel to ${e.name}`"
              @click="bindPanelToToken(paletteTokenFor(e.name))"
            >
              <span class="size-3 rounded-sm border border-white/10" :style="{ background: e.hex }" />
              {{ e.name }}
            </button>
          </div>
          <div class="grid grid-cols-2 gap-2 mt-2">
            <StudioSlider
              label="Opacity" :min="0" :max="1" :step="0.05" :bindable="false"
              :model-value="panel.opacity ?? 0.5" @update:model-value="(v) => setPanel({ opacity: v })"
            />
            <div>
              <p :class="labelCls" class="mb-1">Radius</p>
              <input
                type="number" min="0" :value="panel.radius ?? 0" :class="inputCls"
                @change="(e: any) => setPanel({ radius: Math.max(0, Number(e.target.value) || 0) })"
              >
            </div>
          </div>
        </template>
      </div>
      </StudioSection>
    </template>

    <!-- Image -->
    <template v-else-if="el.type === 'image'">
      <StudioSection title="Image" badge="Image">
      <div>
        <p :class="labelCls" class="mb-1.5">Source</p>
        <input
          :value="el.content" placeholder="URL or {{ props.image_layer_1 }}" :class="inputCls"
          @change="(e: any) => patchElement(el!.id, { content: e.target.value })"
        >
        <button
          v-if="hasBrandLogo"
          class="mt-1.5 px-2 h-6 rounded text-[10px] transition-colors cursor-pointer"
          :class="usingBrandLogo ? 'bg-action/25 text-[#c9d6ff]' : 'bg-white/[0.04] text-white/45 hover:bg-white/[0.08]'"
          @click="patchElement(el!.id, { content: '{{ brand.logo }}' })"
        >
          Use brand logo
        </button>
        <button
          v-for="slot in brandLogoSlots" :key="slot"
          class="mt-1.5 ml-1.5 px-2 h-6 rounded text-[10px] transition-colors cursor-pointer"
          :class="usingSlot(slot) ? 'bg-action/25 text-[#c9d6ff]' : 'bg-white/[0.04] text-white/45 hover:bg-white/[0.08]'"
          @click="patchElement(el!.id, { content: `{{ brand.logos.${slot} }}` })"
        >
          {{ slot === 'onDark' ? 'On-dark logo' : slot[0].toUpperCase() + slot.slice(1) }}
        </button>
        <div v-if="brandAssets.length" class="mt-2">
          <p :class="labelCls" class="mb-1.5">Brand assets</p>
          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="a in brandAssets" :key="a.id"
              class="flex items-center gap-1.5 px-1.5 h-7 rounded bg-white/[0.04] hover:bg-white/[0.08] transition-colors cursor-pointer"
              :class="el!.content === a.path ? 'bg-action/25' : ''"
              :title="a.name" @click="patchElement(el!.id, { content: a.path })"
            >
              <span class="size-5 rounded-sm border border-white/10 bg-[#1a1a1a] bg-center bg-contain bg-no-repeat"
                    :style="{ backgroundImage: `url(${JSON.stringify(a.path)})` }" />
              <span class="max-w-24 truncate text-[10px] text-white/60">{{ a.name }}</span>
            </button>
          </div>
        </div>
      </div>
      <!-- Outpaint to fit: generatively extend to this format's aspect -->
      <div>
        <button
          :disabled="!focalSrc || outpaint.busy.value"
          class="w-full h-8 rounded-md flex items-center justify-center gap-1.5 text-[12px] font-medium transition-colors cursor-pointer border border-action/20 bg-action/15 text-[#c9d6ff] hover:bg-action/25 disabled:opacity-40 disabled:cursor-not-allowed"
          :title="focalSrc ? `Generatively extend this image to fill the ${outputLabel} format` : 'Set an image source first'"
          @click="runOutpaint"
        >
          <Loader2 v-if="outpaint.busy.value" class="size-3.5 animate-spin" />
          <Expand v-else class="size-3.5" />
          {{ outpaint.busy.value ? 'Extending…' : `Outpaint to fit ${outputLabel}` }}
        </button>
        <p v-if="hasContentOverride(el.id) && !outpaint.busy.value" class="mt-1 text-[11px] text-white/45">
          Fitted to {{ outputLabel }} ·
          <button class="text-action hover:underline cursor-pointer" @click="clearImageContentOverride(el!.id)">Revert to original</button>
        </p>
        <p v-if="outpaint.error.value" class="mt-1 text-[11px] text-rose-400/80">{{ outpaint.error.value }}</p>
      </div>
      <div class="grid grid-cols-2 gap-2">
        <div>
          <p :class="labelCls" class="mb-1.5">Fit</p>
          <select :value="styleOf().fit ?? 'cover'" :class="inputCls" @change="(e: any) => patchStyle(el!.id, { fit: e.target.value })">
            <option value="cover">Cover</option>
            <option value="contain">Contain</option>
            <option value="stretch">Stretch</option>
          </select>
        </div>
        <div>
          <p :class="labelCls" class="mb-1.5">Radius</p>
          <input
            type="number" min="0" :value="styleOf().borderRadius ?? 0" :class="inputCls"
            @change="(e: any) => patchStyle(el!.id, { borderRadius: Math.max(0, Number(e.target.value) || 0) })"
          >
        </div>
      </div>
      <label class="flex items-center gap-2 text-[12px] text-white/70 cursor-pointer">
        <input
          type="checkbox" :checked="el.collapse === 'mark'"
          @change="(e: any) => patchElement(el!.id, { collapse: e.target.checked ? 'mark' : undefined })"
        >
        Collapse to square mark on small formats (logo behaviour)
      </label>
      <div>
        <p :class="labelCls" class="mb-1.5">Focal point</p>
        <TemplatesFocalPointPicker
          :focal="el.focal ?? { x: 0.5, y: 0.5 }"
          :src="focalSrc"
          @change="(f) => patchElement(el!.id, { focal: f })"
        />
      </div>
      </StudioSection>

      <!-- Treatment: OPT-IN only — absent/none is the default, and neither
           generate/shuffle/surprise ever touch this (see
           shared/template-grid/treatment.ts). -->
      <StudioSection title="Treatment" badge="FX">
        <div>
          <p :class="labelCls" class="mb-1.5">Kind</p>
          <select
            :value="imageTreatment.kind ?? 'none'" :class="inputCls"
            @change="(e: any) => setTreatment(e.target.value)"
          >
            <option value="none">None</option>
            <option value="grayscale">Grayscale</option>
            <option value="duotone">Duotone</option>
            <option value="grain">Grain</option>
          </select>
        </div>
        <div v-if="imageTreatment.kind && imageTreatment.kind !== 'none'">
          <StudioSlider
            label="Intensity" :min="0" :max="1" :step="0.05" :bindable="false"
            :model-value="imageTreatment.intensity ?? 1" @update:model-value="(v) => setTreatmentIntensity(v)"
          />
          <p v-if="imageTreatment.kind === 'duotone' || imageTreatment.kind === 'grain'" class="mt-1 text-[11px] text-white/35">
            Preview approximates; the final render bakes the true {{ imageTreatment.kind }}.
          </p>
        </div>
      </StudioSection>
    </template>

    <!-- Shape -->
    <template v-else-if="el.type === 'shape'">
      <StudioSection title="Shape" badge="Shape">
      <div>
        <p :class="labelCls" class="mb-1.5">Shape</p>
        <div class="flex gap-1">
          <button
            v-for="s in ['rect', 'circle']" :key="s" :class="[btnRowCls, el.shape === s ? 'bg-action/20 text-[#c9d6ff]' : 'bg-white/[0.04] text-white/50 hover:bg-white/[0.08]']"
            @click="patchElement(el!.id, { shape: s })"
          >{{ s }}</button>
        </div>
      </div>
      <div>
        <p :class="labelCls" class="mb-1.5">Fill</p>
        <div class="flex gap-2 items-center">
          <input
            type="color" :value="resolvedColor(styleOf().fill, '#000000').slice(0, 7)"
            class="size-7 shrink-0 rounded border border-white/[0.06] bg-transparent cursor-pointer"
            @input="(e: any) => patchStyle(el!.id, { fill: e.target.value })"
          >
          <input
            :value="brandTokenKey(styleOf().fill) ? `brand.${brandTokenKey(styleOf().fill)}` : (styleOf().fill ?? '#000000')"
            :class="[inputCls, brandTokenKey(styleOf().fill) ? 'text-[#c9d6ff]' : '']"
            @change="(e: any) => patchStyle(el!.id, { fill: e.target.value })"
          >
        </div>
        <div v-if="brandColorSlots.length" class="flex items-center gap-1 mt-1.5">
          <span class="text-[10px] text-white/30">Brand:</span>
          <button
            v-for="slot in brandColorSlots"
            :key="slot"
            class="size-5 rounded-full border cursor-pointer transition"
            :class="brandTokenKey(styleOf().fill) === slot ? 'border-white ring-1 ring-action' : 'border-white/20 hover:border-white/50'"
            :style="{ background: brandSwatch(slot) }"
            :title="`Bind to brand.${slot}`"
            @click="bindColorToBrand('fill', slot)"
          />
          <button
            v-for="e in brandPaletteEntries" :key="e.id"
            class="px-1.5 h-6 rounded text-[10px] flex items-center gap-1 transition-colors cursor-pointer"
            :class="brandTokenKey(styleOf().fill) === 'palette.' + paletteSlug(e.name) ? 'bg-action/25 text-[#c9d6ff]' : 'bg-white/[0.04] text-white/45 hover:bg-white/[0.08]'"
            :title="`Bind to ${e.name}`"
            @click="bindColorToken('fill', paletteTokenFor(e.name))"
          >
            <span class="size-3 rounded-sm border border-white/10" :style="{ background: e.hex }" />
            {{ e.name }}
          </button>
        </div>
      </div>
      <div v-if="el.shape === 'rect'">
        <p :class="labelCls" class="mb-1.5">Radius</p>
        <input
          type="number" min="0" :value="styleOf().borderRadius ?? 0" :class="inputCls"
          @change="(e: any) => patchStyle(el!.id, { borderRadius: Math.max(0, Number(e.target.value) || 0) })"
        >
      </div>
      </StudioSection>
    </template>
  </div>
</template>
