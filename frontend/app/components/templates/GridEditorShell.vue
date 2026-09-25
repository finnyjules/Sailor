<script setup lang="ts">
/**
 * Top-level shell for the v2 (Swiss grid) editor: format tabs, canvas,
 * reused LayersPanel, grid property panel, worst-case copy toggle, save.
 *
 * Owns the useGridEditor composable and provides it under BOTH 'gridEditor'
 * (the v2 components) and 'templateEditor' (LayersPanel reuse — it only
 * touches template/selectedId/moveElement/moveElementTo, which the grid
 * context exposes with identical contracts).
 */
import { BookmarkPlus, Columns3, Download, Eye, EyeOff, Frame, ImagePlus, Palette, Redo2, Rows3, Save, Square, Type as TypeIcon, Undo2 } from 'lucide-vue-next'

import { useGoogleFontPreview } from '~/composables/useTemplateFonts'
import { useGridEditor } from '~/composables/useGridEditor'
import { allElements } from '~~/shared/template-grid/sections'
import { BRAND_COLOR_KEYS, isV3 } from '~~/shared/template-grid/types'
import type { AnyGridTemplate, BrandKit, TemplateV2, TemplateV3 } from '~~/shared/template-grid/types'
import { useLayoutAgent } from '~/composables/useLayoutAgent'
import AgentSweep from '~/components/agent/AgentSweep.vue'
import StudioPromptHost from '~/components/prompt/StudioPromptHost.vue'
import { useStudioPrompt, STUDIO_PROMPT_KEY } from '~/composables/useStudioPrompt'
import { frameSelectionLabel } from '~/lib/prompt/studioDispatch'

const props = defineProps<{
  initial: AnyGridTemplate
  initialProps?: Record<string, string>
  initialBrand?: Record<string, string>
  /** Legacy aspects CSV — migrates a pre-outputs template into an outputs list. */
  aspects?: string
  /** The project's active brand kit — slots between template defaults and
   *  the wired socket brand in the shared effectiveBrand merge. */
  activeKit?: BrandKit
  /** Images available on the ComfyUI node graph — the "On canvas" source for
   *  the image picker (the modal derives them from its nodes). */
  canvasImages?: Array<{ url: string; label?: string }>
}>()

const emit = defineEmits<{ save: [layout: AnyGridTemplate] }>()

const ctx = useGridEditor(props.initial, { activeKit: toRef(props, 'activeKit'), aspects: props.aspects })
provide('gridEditor', ctx)
provide('templateEditor', ctx as any)
// Optional per-layer controls consumed by the reused LayersPanel — present
// only in the grid editor, so the v1 editor's panel stays unchanged.
provide('layerControls', {
  toggleHidden: ctx.toggleHidden,
  toggleLocked: ctx.toggleLocked,
  isHidden: ctx.isHidden,
  isLocked: ctx.isLocked,
})

const { template, dirty, selectedElement, selectedId, sampleProps, sampleBrand, selectedSection, wrapSelectionInSection } = ctx

// In-product agent (last-mile of F1): drives the template through the command
// surface. Gated to v3 templates in the UI below.
const { getLocalSetting, setLocalSetting } = useLocalSettings()
const layoutAgent = useLayoutAgent({
  template: template as unknown as Ref<TemplateV3>,
  apiKey: () => getLocalSetting('Sailor.AI.AnthropicApiKey') ?? '',
  sampleProps: () => sampleProps.value,
  sampleBrand: () => sampleBrand.value as BrandKit,
  effectiveBrand: () => ctx.effectiveBrand.value as Record<string, unknown>,
})
// The right panel is always present while designing: it hosts the element /
// stack inspector, or — when nothing is selected — the canvas (grid +
// background) properties. The agent's progress/proposal/answers show above
// the prompt (StudioPromptHost) in the bottom cluster, not here.
const rightPanelOpen = computed(() => true)

// The one prompt (spec §2.1a, §2.4): the template editor's agent, routed as a
// template so copy/layout requests go straight to it (studioDispatch only
// bounces copy/layout to Frame for place:'studio'). The chip is Frame's chip
// (frameSelectionLabel): a text element's own words, quoted and cut
// (“Open late” · text), else its Layers-panel name. The grid editor has no
// multi-select today, so "N layers" has no live path yet.
const templateChip = computed<string | null>(() => {
  const el = selectedElement.value
  if (!el) return null
  return frameSelectionLabel([{ kind: el.type, text: el.type === 'text' ? el.content : '', name: el.name }])
})
const templatePrompt = useStudioPrompt({
  worker: () => layoutAgent,
  place: 'template',
  selectionKind: 'template-element',
  label: () => templateChip.value,
  suggestions: () => ['Tighten spacing', 'Apply brand'],
})
provide(STUDIO_PROMPT_KEY, templatePrompt)

// Opening step: a fresh, empty layout shows the format picker first (pick the
// deliverables, then design on a blank canvas). An existing layout — any
// elements or sections — skips straight into editing.
const started = ref(allElements(template.value).length > 0 || ctx.sections.value.length > 0)
function onFormatsChosen(keys: string[]) {
  ctx.setWorkingFormats(keys)
  ctx.convertToV3()   // design on the fine grid from the start
  started.value = true
}

// Reserve space for the floating panels so the artboard fits the gap between
// them (left: formats panel; right: inspector, only when an element is
// selected; bottom: tool toolbar). The canvas measures this padded box.
const canvasArea = computed(() => ({
  top: '24px',
  left: '272px',                                     // left-4 + w-60 + gap
  // Right column (agent results and/or the element inspector) is w-80 = 320px.
  right: rightPanelOpen.value ? '344px' : '32px', // right-4 + w-80 + gap
  bottom: '88px',                                    // bottom toolbar + gap
}))

// Centre the bottom cluster (agent prompt + tool/zoom toolbars) on the SAME box
// as the artboard, not the full modal — otherwise the asymmetric left/right
// panel widths push the toolbar off the canvas's centre line.
const bottomBarStyle = computed(() => ({
  left: `calc((${canvasArea.value.left} + (100% - ${canvasArea.value.right})) / 2)`,
}))

if (props.initialProps && Object.keys(props.initialProps).length > 0) {
  Object.assign(sampleProps.value, props.initialProps)
}
if (props.initialBrand && Object.keys(props.initialBrand).length > 0) {
  Object.assign(sampleBrand.value, props.initialBrand)
}
watch(() => props.initialProps, (next) => {
  if (next && Object.keys(next).length > 0) Object.assign(sampleProps.value, next)
}, { deep: true })

// Make sure the browser can render every family the template references —
// curated families are bundled; anything else lazy-loads from Google Fonts.
const { ensure: ensureFont } = useGoogleFontPreview()
watch(template, (tpl) => {
  for (const el of allElements(tpl)) {
    if (el.type === 'text' && el.style?.fontFamily) ensureFont(el.style.fontFamily)
  }
}, { immediate: true, deep: true })

function handleSave() {
  emit('save', JSON.parse(JSON.stringify(template.value)))
  dirty.value = false
}

// -- Save as reusable template ------------------------------------------------

const saveAsOpen = ref(false)
const saveAsName = ref('')
const saveAsState = ref<'idle' | 'saving' | 'done' | 'error'>('idle')

function openSaveAs() {
  saveAsName.value = template.value.name && template.value.name !== 'New Layout' ? template.value.name : ''
  saveAsState.value = 'idle'
  saveAsOpen.value = true
}

async function confirmSaveAs() {
  const name = saveAsName.value.trim()
  if (!name) return
  // Slugify to a filesystem-safe id; the saved template keeps its own id so it
  // can be reloaded from the gallery without colliding with the node's id.
  const id = `user-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'template'}`
  const payload = { ...JSON.parse(JSON.stringify(template.value)), id, name }
  saveAsState.value = 'saving'
  try {
    const res = await fetch(`/api/templates/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    saveAsState.value = res.ok ? 'done' : 'error'
    if (res.ok) setTimeout(() => { saveAsOpen.value = false }, 900)
  } catch {
    saveAsState.value = 'error'
  }
}

// -- Keyboard shortcuts -------------------------------------------------------
// Scoped to the editor root; ignored while typing in a field so the property
// panel's inputs keep working.

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

function onKeydown(e: KeyboardEvent) {
  const mod = e.metaKey || e.ctrlKey
  // While typing in a field, let the browser own Cmd+Z (native text undo) and
  // arrow keys (caret movement) — don't hijack them for the canvas.
  if (isTyping(e.target)) return

  // Escape — deselect first; only if nothing is selected does the modal close
  // (this handler runs in the capture phase, ahead of the modal's Escape).
  if (e.key === 'Escape') {
    if (selectedId.value || ctx.selectedSectionId.value) {
      e.stopPropagation()
      selectedId.value = null
      ctx.selectedSectionId.value = null
    }
    return
  }

  // A request is out (or a stopped one's reply is due): its reply puts the
  // pre-request template back, so no edits meanwhile (see editLocked).
  if (templatePrompt.editLocked.value) return

  if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); e.shiftKey ? ctx.redo() : ctx.undo(); return }
  if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); ctx.redo(); return }

  // Copy / paste.
  if (mod && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); ctx.copySelected(); return }
  if (mod && (e.key === 'v' || e.key === 'V')) { e.preventDefault(); ctx.pasteClipboard(); return }

  // Group / ungroup (⌘G / ⇧⌘G).
  if (mod && (e.key === 'g' || e.key === 'G')) {
    e.preventDefault()
    if (e.shiftKey) ctx.ungroupSelectedSection()
    else wrapSelectionInSection()
    return
  }

  // Z-order (⌘] forward / ⌘[ back, ⇧ = to front/back).
  if (mod && (e.key === ']' || e.key === '}')) { e.preventDefault(); e.shiftKey ? ctx.bringToFront() : ctx.bringForward(); return }
  if (mod && (e.key === '[' || e.key === '{')) { e.preventDefault(); e.shiftKey ? ctx.sendToBack() : ctx.sendBackward(); return }

  const nudges: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
  }
  const nudge = nudges[e.key]
  const step = e.shiftKey ? 4 : 1

  // A selected frame (section) — duplicate / delete / nudge, like an element.
  const secId = ctx.selectedSectionId.value
  if (secId && !selectedId.value) {
    if (mod && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); ctx.duplicateSection(secId); return }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); ctx.removeSection(secId); return }
    if (nudge) { e.preventDefault(); ctx.nudgeSection(nudge[0] * step, nudge[1] * step); return }
    return
  }

  const id = selectedId.value
  if (mod && (e.key === 'd' || e.key === 'D')) {
    if (id) { e.preventDefault(); ctx.duplicateElement(id) }
    return
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && id && !ctx.isLocked(id)) {
    e.preventDefault(); ctx.removeElement(id); return
  }
  if (id && nudge && !ctx.isLocked(id)) {
    e.preventDefault()
    ctx.nudgeSelected(nudge[0] * step, nudge[1] * step)
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown, true))
onUnmounted(() => window.removeEventListener('keydown', onKeydown, true))

// -- Canvas properties (grid + background) ------------------------------------
// These live in the right panel (shown when nothing is selected), not the
// toolbar: the grid overlays, column/row counts, gutter/margin spacing, and
// the canvas background.

const { metrics, gridColumns, gridRows, margins, gutters } = ctx

// Overlay visibility toggles — persisted so the placement aids stay how the
// designer left them across sessions. Both default ON. Columns = vertical grid
// bands, Rows = horizontal grid lines. Each also carries its count.
const COLUMN_GUIDES_KEY = 'Sailor.SmartLayout.ColumnGuides'
const ROW_GUIDES_KEY = 'Sailor.SmartLayout.RowGuides'
const columnGuidesOn = ref(getLocalSetting(COLUMN_GUIDES_KEY) !== 'false')
const rowGuidesOn = ref(getLocalSetting(ROW_GUIDES_KEY) !== 'false')
// Round-2b-drama (2026-08-09): discoverability rename — the toolbar's "+"
// buttons used to read "Headline / Anchor / List / Detail", which don't
// match the TierId vocabulary (`hero`/`anchor`/`support`/`fineprint`) used
// everywhere else in Smart Layout (knobs, `dramaticType`, the content
// panel). Renamed to the tier names themselves so a user can connect what
// they click here to what they see elsewhere.
const TIER_DISPLAY_NAMES: Record<'hero' | 'anchor' | 'support' | 'fineprint', string> = {
  hero: 'Hero', anchor: 'Anchor', support: 'Support', fineprint: 'Fine print',
}
function tierDisplayName(tier: 'hero' | 'anchor' | 'support' | 'fineprint'): string {
  return TIER_DISPLAY_NAMES[tier]
}

function toggleColumnGuides() {
  columnGuidesOn.value = !columnGuidesOn.value
  setLocalSetting(COLUMN_GUIDES_KEY, String(columnGuidesOn.value))
}
function toggleRowGuides() {
  rowGuidesOn.value = !rowGuidesOn.value
  setLocalSetting(ROW_GUIDES_KEY, String(rowGuidesOn.value))
}

function onColumns(raw: string) {
  const v = Number(raw)
  if (Number.isFinite(v)) ctx.setGridColumns(v)
}
function onRows(raw: string) {
  const v = Number(raw)
  if (Number.isFinite(v)) ctx.setGridRows(v)
}
function onGutter(axis: 'column' | 'row', raw: string) {
  const v = Number(raw)
  if (Number.isFinite(v)) ctx.setGutter(axis, v)
}
function onMargin(side: 'top' | 'right' | 'bottom' | 'left', raw: string) {
  const v = Number(raw)
  if (Number.isFinite(v)) ctx.setMargin(side, v)
}

// -- Brand kit popover --------------------------------------------------------

const brandPanelOpen = ref(false)
const COLOR_KEYS = BRAND_COLOR_KEYS
const COLOR_LABELS: Record<string, string> = {
  primary: 'Primary', secondary: 'Secondary', accent: 'Accent', accent2: 'Accent 2',
  foreground: 'Text', background: 'Background',
}
function brandVal(key: string): string {
  return (template.value.brand as any)?.[key] ?? ''
}

// -- Background (canvas properties panel) -------------------------------------

const bgFill = computed(() => template.value.background?.fill ?? '')
const hasBgImage = computed(() => !!template.value.background?.image)
const bgColorHex = computed(() => (/^#[0-9a-f]{6}$/i.test(bgFill.value) ? bgFill.value : '#000000'))
/** A fill (colour/gradient) replaces any image so it actually shows. */
function setBgFill(v: string) { ctx.setBackground({ fill: v, image: '' }) }
function clearBackground() { ctx.setBackground({ fill: '', image: '' }) }

const exportOpen = ref(false)
function setBrandFont(key: 'fontDisplay' | 'fontBody', family: string) {
  ensureFont(family)
  ctx.setBrand({ [key]: family })
}

// -- Section tool -------------------------------------------------------------
// With a selection, wrap it in a frame; otherwise arm draw-a-frame (the next
// canvas drag draws the frame at that region).
function onSectionTool() {
  if (selectedId.value) wrapSelectionInSection()
  else ctx.frameDrawArmed.value = true
}

// -- Image picker -------------------------------------------------------------
// The Image tool opens a picker (canvas-graph images + asset library); selecting
// a source adds an image element with that URL. Empty selection = placeholder.
const imagePickerOpen = ref(false)
function onPickImage(url: string) {
  ctx.addImage(url)
  imagePickerOpen.value = false
}
</script>

<template>
  <div class="h-full w-full flex flex-col bg-[#0a0a0a]">
    <!-- Top bar. pr-12 keeps the host modal's absolute close button clear. -->
    <div class="shrink-0 h-14 pl-4 pr-12 border-b border-white/[0.06] flex items-center gap-3">
      <input
        :value="template.name"
        class="w-40 h-8 px-2 bg-transparent border border-transparent hover:border-white/[0.06] focus:border-white/30 rounded text-[13px] text-white font-medium focus:outline-none"
        @change="(e: any) => { template.name = e.target.value; dirty = true }"
      >

      <div class="flex items-center gap-0.5 shrink-0" :inert="templatePrompt.editLocked.value">
        <button
          class="size-8 rounded-md flex items-center justify-center transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed text-white/65 hover:text-white hover:bg-white/[0.08]"
          title="Undo (⌘Z)"
          :disabled="!ctx.canUndo.value"
          @click="ctx.undo()"
        >
          <Undo2 class="size-4" />
        </button>
        <button
          class="size-8 rounded-md flex items-center justify-center transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed text-white/65 hover:text-white hover:bg-white/[0.08]"
          title="Redo (⇧⌘Z)"
          :disabled="!ctx.canRedo.value"
          @click="ctx.redo()"
        >
          <Redo2 class="size-4" />
        </button>
      </div>

      <div class="flex-1 min-w-0" />

      <div class="flex items-center gap-2">
        <span v-if="dirty" class="size-1.5 rounded-full bg-amber-400" title="Unsaved changes" />
        <button
          class="h-8 px-2.5 rounded-md bg-white/[0.04] hover:bg-white/[0.08] flex items-center gap-1.5 text-[12px] text-white/65 hover:text-white transition-colors cursor-pointer disabled:opacity-30"
          title="Export the ad set (PNG/JPEG/WebP, ZIP)"
          :disabled="allElements(template).length === 0"
          @click="exportOpen = true"
        >
          <Download class="size-4" /> Export
        </button>
        <div class="relative">
          <button
            class="size-8 rounded-md bg-white/[0.04] hover:bg-white/[0.08] flex items-center justify-center text-white/65 hover:text-white transition-colors cursor-pointer"
            title="Save as a reusable template"
            @click="saveAsOpen ? (saveAsOpen = false) : openSaveAs()"
          >
            <BookmarkPlus class="size-4" />
          </button>
          <div
            v-if="saveAsOpen"
            class="absolute top-10 right-0 z-20 w-64 rounded-lg bg-[#161616] border border-white/10 shadow-2xl p-3"
          >
            <p class="text-[10px] uppercase tracking-[0.12em] text-white/35 mb-1.5">Save as template</p>
            <input
              v-model="saveAsName"
              placeholder="Template name"
              class="w-full h-8 px-2 bg-white/[0.04] border border-white/[0.06] rounded text-[12px] text-white focus:outline-none focus:border-white/30"
              @keydown.enter="confirmSaveAs"
            >
            <div class="flex items-center gap-2 mt-2">
              <button
                class="px-3 h-7 rounded-md bg-white/10 hover:bg-white/20 text-[12px] text-white transition-colors cursor-pointer disabled:opacity-40"
                :disabled="!saveAsName.trim() || saveAsState === 'saving'"
                @click="confirmSaveAs"
              >
                {{ saveAsState === 'saving' ? 'Saving…' : saveAsState === 'done' ? 'Saved ✓' : 'Save' }}
              </button>
              <span v-if="saveAsState === 'error'" class="text-[11px] text-red-400">Save failed</span>
              <span class="text-[10px] text-white/30">Appears in the gallery.</span>
            </div>
          </div>
        </div>
        <button
          class="h-8 px-3 rounded-md bg-white hover:bg-white/90 flex items-center gap-1.5 text-[12px] text-black transition-colors cursor-pointer"
          @click="handleSave"
        >
          <Save class="size-3.5" /> Save & close
        </button>
        <slot name="topbar-end" />
      </div>
    </div>

    <!-- Body: canvas fills; panels float over it; tools in a bottom toolbar. -->
    <div class="flex-1 relative min-h-0 overflow-hidden bg-[#121212]">
      <!-- While the prompt works (or a stopped reply is due) the template is
           inert: the reply restores the pre-request template, so edits made
           meanwhile would be lost. -->
      <div
        class="absolute transition-all duration-150" :style="canvasArea"
        data-testid="template-edit-surface"
        :inert="templatePrompt.editLocked.value" :aria-busy="templatePrompt.editLocked.value"
      >
        <TemplatesGridEditorCanvas />
        <!-- Glimm "citrus" sweep over the artboard while the agent is working. -->
        <AgentSweep :active="templatePrompt.working.value" />
      </div>
      <p
        v-if="started && templatePrompt.editLocked.value"
        data-testid="template-locked-note"
        class="pointer-events-none absolute top-4 z-40 -translate-x-1/2 rounded-full border border-white/10 bg-[#1a1a1a]/95 px-3 py-1.5 text-[12px] text-white/70 shadow-lg"
        :style="bottomBarStyle"
        role="status"
      >{{ templatePrompt.lockedNote.value }}</p>
      <TemplatesFormatPicker v-if="!started" @confirm="onFormatsChosen" />
      <TemplatesExportPanel v-if="exportOpen" @close="exportOpen = false" />
      <TemplatesImagePicker
        v-if="imagePickerOpen"
        :canvas-images="canvasImages ?? []"
        @select="onPickImage"
        @close="imagePickerOpen = false"
      />

      <!-- Left floating panel: formats + elements (only once designing) -->
      <div
        v-if="started"
        :inert="templatePrompt.editLocked.value" :aria-busy="templatePrompt.editLocked.value"
        class="absolute top-4 left-4 bottom-4 z-20 w-60 flex flex-col rounded-xl border border-white/10 bg-[#0e0e10]/80 backdrop-blur-md shadow-2xl overflow-hidden"
      >
        <div class="flex-1 min-h-0 overflow-y-auto">
          <TemplatesFormatList />
          <TemplatesVariablesPanel />
          <div class="border-t border-white/[0.06]" />
          <TemplatesLayersPanel />
        </div>
      </div>

      <!-- Right panel: hosts the element / stack inspector. The prompt itself
           (and what it brings back — changes, answers) lives in the bottom
           cluster, above the toolbar; it no longer takes this panel over. -->
      <div
        v-if="started && rightPanelOpen"
        data-testid="template-inspector"
        :inert="templatePrompt.editLocked.value" :aria-busy="templatePrompt.editLocked.value"
        class="absolute top-4 right-4 bottom-4 z-30 flex w-80 flex-col overflow-hidden rounded-xl border border-white/10 bg-[#0e0e10]/80 shadow-2xl backdrop-blur-md"
      >
        <template v-if="selectedElement || selectedSection">
          <div class="min-h-0 flex-1 overflow-y-auto pt-2">
            <TemplatesTierTypePanel v-if="ctx.editorMode.value === 'layout'" />
            <TemplatesGridPropertyPanel v-if="selectedElement" />
            <TemplatesSectionInspector v-if="selectedSection" />
          </div>
        </template>
        <!-- Nothing selected: canvas-level properties (grid + background). -->
        <template v-else>
          <div class="shrink-0 border-b border-white/[0.06] px-4 py-3">
            <p class="text-sm font-medium text-white/85">Canvas</p>
            <p class="text-[11px] text-white/35 mt-0.5">Grid, spacing and background</p>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto">
            <TemplatesLayoutControlsPanel v-if="ctx.editorMode.value === 'layout'" />
            <!-- Grid -->
            <div class="px-4 py-3.5 flex flex-col gap-3 border-b border-white/[0.06]">
              <p class="text-[10px] uppercase tracking-[0.12em] text-white/35">Grid</p>
              <div class="flex flex-col gap-0.5">
                <div class="flex items-center gap-2.5 h-8 px-1.5 rounded-md" :class="columnGuidesOn ? 'bg-white/[0.06]' : ''">
                  <button
                    class="flex items-center gap-2.5 flex-1 min-w-0 h-full cursor-pointer"
                    title="Show/hide the vertical column guides"
                    @click="toggleColumnGuides"
                  >
                    <component :is="columnGuidesOn ? Eye : EyeOff" class="size-4" :class="columnGuidesOn ? 'text-white/85' : 'text-white/35'" />
                    <Columns3 class="size-3.5" :class="columnGuidesOn ? 'text-white/55' : 'text-white/30'" />
                    <span class="text-[12px]" :class="columnGuidesOn ? 'text-white/90' : 'text-white/45'">Columns</span>
                  </button>
                  <input
                    type="number" min="1" max="240" :value="gridColumns"
                    class="w-11 h-6 px-1.5 bg-white/[0.04] border border-white/[0.06] rounded text-[11px] text-right text-white tabular-nums focus:outline-none focus:border-white/30"
                    title="Number of columns — fixed across every format"
                    @change="(e: any) => onColumns(e.target.value)"
                  >
                </div>
                <div class="flex items-center gap-2.5 h-8 px-1.5 rounded-md" :class="rowGuidesOn ? 'bg-white/[0.06]' : ''">
                  <button
                    class="flex items-center gap-2.5 flex-1 min-w-0 h-full cursor-pointer"
                    title="Show/hide the horizontal row guides"
                    @click="toggleRowGuides"
                  >
                    <component :is="rowGuidesOn ? Eye : EyeOff" class="size-4" :class="rowGuidesOn ? 'text-white/85' : 'text-white/35'" />
                    <Rows3 class="size-3.5" :class="rowGuidesOn ? 'text-white/55' : 'text-white/30'" />
                    <span class="text-[12px]" :class="rowGuidesOn ? 'text-white/90' : 'text-white/45'">Rows</span>
                  </button>
                  <input
                    type="number" min="1" max="240" :value="gridRows"
                    class="w-11 h-6 px-1.5 bg-white/[0.04] border border-white/[0.06] rounded text-[11px] text-right text-white tabular-nums focus:outline-none focus:border-white/30"
                    title="Number of rows — fixed across every format"
                    @change="(e: any) => onRows(e.target.value)"
                  >
                </div>
              </div>
              <div>
                <p class="text-[10px] uppercase tracking-[0.12em] text-white/35 mb-1.5">Gutter <span class="text-white/25 normal-case tracking-normal">· between cells, master px</span></p>
                <div class="grid grid-cols-2 gap-1.5 mb-3">
                  <label class="flex flex-col gap-1">
                    <span class="text-[10px] text-white/40 text-center">Column</span>
                    <input
                      type="number" min="0" :value="gutters.column"
                      class="w-full h-7 px-1.5 bg-white/[0.04] border border-white/[0.06] rounded text-[12px] text-center text-white tabular-nums focus:outline-none focus:border-white/30"
                      title="Horizontal gap between columns (master px)"
                      @change="(e: any) => onGutter('column', e.target.value)"
                    >
                  </label>
                  <label class="flex flex-col gap-1">
                    <span class="text-[10px] text-white/40 text-center">Row</span>
                    <input
                      type="number" min="0" :value="gutters.row"
                      class="w-full h-7 px-1.5 bg-white/[0.04] border border-white/[0.06] rounded text-[12px] text-center text-white tabular-nums focus:outline-none focus:border-white/30"
                      title="Vertical gap between rows (master px)"
                      @change="(e: any) => onGutter('row', e.target.value)"
                    >
                  </label>
                </div>
                <p class="text-[10px] uppercase tracking-[0.12em] text-white/35 mb-1.5">Margin <span class="text-white/25 normal-case tracking-normal">· per side, master px</span></p>
                <div class="grid grid-cols-4 gap-1.5">
                  <label v-for="side in (['top', 'right', 'bottom', 'left'] as const)" :key="side" class="flex flex-col gap-1">
                    <span class="text-[10px] text-white/40 text-center capitalize">{{ side }}</span>
                    <input
                      type="number" min="0" :value="margins[side]"
                      class="w-full h-7 px-1.5 bg-white/[0.04] border border-white/[0.06] rounded text-[12px] text-center text-white tabular-nums focus:outline-none focus:border-white/30"
                      @change="(e: any) => onMargin(side, e.target.value)"
                    >
                  </label>
                </div>
                <p class="mt-1.5 text-[10px] text-white/30 leading-snug tabular-nums">
                  Here: gutter {{ Math.round(metrics.gutterX) }}×{{ Math.round(metrics.gutterY) }}px · cell {{ Math.round(metrics.cellW) }}×{{ Math.round(metrics.cellH) }}px
                </p>
              </div>
            </div>

            <!-- Background -->
            <div class="px-4 py-3.5 flex flex-col gap-2.5">
              <p class="text-[10px] uppercase tracking-[0.12em] text-white/35">Background</p>
              <div class="flex items-center gap-2">
                <input
                  type="color" :value="bgColorHex" title="Background colour"
                  class="h-8 w-9 shrink-0 cursor-pointer rounded border border-white/10 bg-transparent"
                  @input="(e: any) => setBgFill(e.target.value)"
                >
                <input
                  type="text" :value="bgFill" placeholder="#0a0a0a or linear-gradient(135deg,#FF6EB4,#FF8C42)"
                  class="h-8 w-full rounded border border-white/[0.06] bg-white/[0.04] px-2 text-[12px] text-white focus:border-white/30 focus:outline-none"
                  @change="(e: any) => setBgFill(e.target.value)"
                >
              </div>
              <p v-if="hasBgImage" class="text-[11px] text-white/45">
                An image background is set —
                <button class="cursor-pointer text-white/70 underline underline-offset-2 hover:text-white" @click="setBgFill(bgFill || '#0a0a0a')">replace with colour</button>.
              </p>
              <div class="flex items-center justify-between">
                <p class="text-[10px] leading-snug text-white/30">Solid colour or any CSS gradient.</p>
                <button
                  v-if="bgFill || hasBgImage"
                  class="cursor-pointer text-[11px] text-white/55 underline underline-offset-2 hover:text-white"
                  @click="clearBackground()"
                >Clear</button>
              </div>
            </div>
          </div>
        </template>
      </div>

      <!-- Bottom cluster: the one prompt (v3 only) sits above the tools + zoom
           toolbars. The column shrink-wraps to the toolbar row, so the bare
           prompt matches its width — the same layout the Compositor uses. -->
      <div v-if="started" class="absolute bottom-4 -translate-x-1/2 z-30 flex flex-col items-stretch gap-2" :style="bottomBarStyle">
        <div v-if="isV3(template)" class="w-full">
          <StudioPromptHost :prompt="templatePrompt" />
        </div>
        <div class="flex items-center gap-2" :inert="templatePrompt.editLocked.value" :aria-busy="templatePrompt.editLocked.value">
        <div class="flex items-center gap-1 bg-[#1a1a1a]/95 rounded-[12px] p-1.5 border border-[#2a2a2a] shadow-lg">

        <!-- Mode toggle: Layout (generatable) vs Freeform (manual) -->
        <div class="flex items-center bg-white/[0.05] rounded-lg p-0.5 mr-1">
          <button class="h-7 px-2.5 rounded-md text-[11px] font-semibold transition-colors cursor-pointer"
            :class="ctx.editorMode.value === 'layout' ? 'bg-action text-white' : 'text-white/50 hover:text-white'"
            @click="ctx.editorMode.value = 'layout'">Layout</button>
          <button class="h-7 px-2.5 rounded-md text-[11px] font-semibold transition-colors cursor-pointer"
            :class="ctx.editorMode.value === 'freeform' ? 'bg-action text-white' : 'text-white/50 hover:text-white'"
            @click="ctx.editorMode.value = 'freeform'">Freeform</button>
        </div>
        <div class="w-px h-5 bg-white/10 mx-0.5" />

        <!-- Brand -->
        <div class="relative">
          <button
            class="h-8 px-2.5 rounded-md flex items-center gap-1.5 text-[12px] transition-colors cursor-pointer"
            :class="brandPanelOpen ? 'bg-white/15 text-white' : 'text-white/70 hover:bg-white/10 hover:text-white'"
            title="Brand kit — colours, fonts and logo bound across every format"
            @click="brandPanelOpen = !brandPanelOpen"
          >
            <Palette class="size-4" /> Brand
          </button>
          <div
            v-if="brandPanelOpen"
            class="absolute bottom-full mb-2 left-0 z-30 w-72 rounded-lg bg-[#161616] border border-white/10 shadow-2xl p-3 flex flex-col gap-3"
          >
            <div v-if="activeKit" class="text-[10px] text-white/40 px-1">
              Project kit overrides these template defaults.
            </div>
            <div>
              <p class="text-[10px] uppercase tracking-[0.12em] text-white/35 mb-2">Brand colours</p>
              <div class="flex flex-col gap-1.5">
                <label v-for="k in COLOR_KEYS" :key="k" class="flex items-center gap-2">
                  <input
                    type="color" :value="brandVal(k) || '#888888'"
                    class="size-6 shrink-0 rounded border border-white/[0.06] bg-transparent cursor-pointer"
                    @input="(e: any) => ctx.setBrand({ [k]: e.target.value })"
                  >
                  <span class="text-[11px] text-white/55 w-20">{{ COLOR_LABELS[k] }}</span>
                  <input
                    :value="brandVal(k)" placeholder="unset"
                    class="flex-1 h-7 px-2 bg-white/[0.04] border border-white/[0.06] rounded text-[11px] text-white focus:outline-none focus:border-white/30 font-mono"
                    @change="(e: any) => ctx.setBrand({ [k]: e.target.value })"
                  >
                </label>
              </div>
            </div>
            <div>
              <p class="text-[10px] uppercase tracking-[0.12em] text-white/35 mb-1.5">Brand fonts</p>
              <div class="flex flex-col gap-1.5">
                <div>
                  <span class="text-[10px] text-white/40">Display</span>
                  <TemplatesFontPicker :model-value="brandVal('fontDisplay') || 'Inter'" @update:model-value="(f) => setBrandFont('fontDisplay', f)" />
                </div>
                <div>
                  <span class="text-[10px] text-white/40">Body</span>
                  <TemplatesFontPicker :model-value="brandVal('fontBody') || 'Inter'" @update:model-value="(f) => setBrandFont('fontBody', f)" />
                </div>
              </div>
            </div>
            <div>
              <p class="text-[10px] uppercase tracking-[0.12em] text-white/35 mb-1.5">Logo URL</p>
              <input
                :value="brandVal('logo')" placeholder="https://…  (bind on an image element)"
                class="w-full h-7 px-2 bg-white/[0.04] border border-white/[0.06] rounded text-[11px] text-white focus:outline-none focus:border-white/30"
                @change="(e: any) => ctx.setBrand({ logo: e.target.value })"
              >
            </div>
            <p class="text-[10px] text-white/30 leading-snug">
              Bind an element's colour/font to a brand slot in its properties — swap the kit here and every format re-skins.
            </p>
          </div>
        </div>

        <div class="w-px h-5 bg-white/10 mx-0.5" />

        <template v-if="ctx.editorMode.value === 'layout'">
          <button v-for="tier in (['hero','anchor','support','fineprint'] as const)" :key="tier"
            class="h-8 px-2.5 rounded-md flex items-center gap-1.5 text-[12px] text-white/70 hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
            :title="`Add another ${tierDisplayName(tier).toLowerCase()} item — each click appends`"
            @click="ctx.addTierItem(tier)">+ {{ tierDisplayName(tier) }}</button>
          <button class="h-8 px-2.5 rounded-md flex items-center gap-1.5 text-[12px] text-white/70 hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
            title="Add an image" @click="imagePickerOpen = true">
            <ImagePlus class="size-3.5" /> Image
          </button>
        </template>
        <template v-else>
          <button
            class="h-8 px-2.5 rounded-md flex items-center gap-1.5 text-[12px] text-white/70 hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
            @click="ctx.addText()"
          >
            <TypeIcon class="size-3.5" /> Text
          </button>
          <button
            class="h-8 px-2.5 rounded-md flex items-center gap-1.5 text-[12px] text-white/70 hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
            title="Add an image — pick from the canvas or your assets"
            @click="imagePickerOpen = true"
          >
            <ImagePlus class="size-3.5" /> Image
          </button>
          <button
            class="h-8 px-2.5 rounded-md flex items-center gap-1.5 text-[12px] text-white/70 hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
            @click="ctx.addShape()"
          >
            <Square class="size-3.5" /> Shape
          </button>
          <button
            class="h-8 px-2.5 rounded-md flex items-center gap-1.5 text-[12px] transition-colors cursor-pointer"
            :class="ctx.frameDrawArmed.value ? 'bg-white/15 text-white' : selectedId ? 'text-emerald-300 hover:bg-emerald-500/15 hover:text-emerald-200' : 'text-white/70 hover:bg-white/10 hover:text-white'"
            :title="selectedId ? 'Wrap the selection in a Section frame' : 'Draw a frame — click, then drag on the canvas'"
            @click="onSectionTool()"
          >
            <Frame class="size-3.5" /> Section
          </button>
        </template>
        </div>

        <!-- Zoom -->
        <div class="flex items-center gap-0.5 bg-[#1a1a1a]/95 rounded-[12px] p-1.5 border border-[#2a2a2a] shadow-lg">
          <button
            class="size-8 rounded-md flex items-center justify-center text-white/70 hover:bg-white/10 hover:text-white transition-colors cursor-pointer text-base leading-none"
            title="Zoom out"
            @click="ctx.zoomBy(1 / 1.2)"
          >−</button>
          <button
            class="px-2 h-8 rounded-md flex items-center justify-center text-[11px] tabular-nums text-white/70 hover:bg-white/10 hover:text-white transition-colors cursor-pointer min-w-[3rem]"
            :title="ctx.isZoomFitted.value ? 'Fitted to view' : 'Click to fit to view'"
            @click="ctx.zoomFit()"
          >
            {{ Math.round(ctx.scale.value * 100) }}%
          </button>
          <button
            class="size-8 rounded-md flex items-center justify-center text-white/70 hover:bg-white/10 hover:text-white transition-colors cursor-pointer text-base leading-none"
            title="Zoom in"
            @click="ctx.zoomBy(1.2)"
          >+</button>
        </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Crossfade the agent progress line out and the proposed changes in. */
.agent-fade-enter-active,
.agent-fade-leave-active { transition: opacity 0.25s ease; }
.agent-fade-enter-from,
.agent-fade-leave-to { opacity: 0; }
</style>
