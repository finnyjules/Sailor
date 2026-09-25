<script setup lang="ts">
/**
 * Full-screen modal that mounts the visual layout editor (EditorShell) over
 * the canvas. Reads the SmartLayout node's `layout` widget JSON as the
 * initial state, writes it back when the user clicks Save.
 *
 * The editor inside is identical to what the standalone tab used to mount,
 * just with a different data source + lifecycle.
 */
import { X } from 'lucide-vue-next'
import type { ComputedRef } from 'vue'

import type { AnyTemplate, Template } from '~~/server/templates/schema'
import type { BrandKit } from '~~/shared/brand/types'
import { autopopulateV2 } from '~~/shared/template-grid/autopopulate'
import { autopopulateTiers, omitConsumedProps } from '~~/shared/template-grid/generate/tiers'
import { generate, migrateGen } from '~~/shared/template-grid/generate/generate'
import { makeStarterTemplate } from '~~/shared/template-grid/starter'
import type { TemplateV2, TemplateV3 } from '~~/shared/template-grid/types'
import { BINDINGS_PROP, COLLECTION_PROP, VARS_TYPE } from '~/lib/collection/types'
import type { CollectionData, VarBindings } from '~/lib/collection/types'
import { resolveBindings, splitResolvedValues } from '~/lib/collection/resolve'
import type { SmartLayoutBindingContext } from '~/lib/collection/layoutBinding'

const props = defineProps<{
  nodeId: string
  nodes: any[]
  edges: any[]
}>()

const emit = defineEmits<{ close: [] }>()

// -- Find the node + its layout widget -------------------------------------

const node = computed(() => props.nodes.find((n: any) => n.id === props.nodeId))

function widgetIdx(name: string): number {
  return (node.value?.data?.widgetDefs as any[] | undefined)
    ?.findIndex((d: any) => d.name === name) ?? -1
}

function readLayout(): AnyTemplate {
  const i = widgetIdx('layout')
  if (i < 0 || !node.value) return makeStarter()
  const raw = String(node.value.data.widgetsValues?.[i] ?? '').trim()
  if (!raw) return makeStarter()
  try {
    return JSON.parse(raw) as AnyTemplate
  } catch {
    return makeStarter()
  }
}

function writeLayout(layout: AnyTemplate) {
  const i = widgetIdx('layout')
  if (i < 0 || !node.value) return
  node.value.data.widgetsValues[i] = JSON.stringify(layout, null, 2)
}

// Starter layout for a freshly-dropped SmartLayout: the v2 Swiss-grid starter,
// mirroring the Python _STARTER_LAYOUT so editor + execution agree on defaults.
function makeStarter(): AnyTemplate {
  return makeStarterTemplate(`layout_${Math.random().toString(36).slice(2, 8)}`)
}

// The Swiss-grid editor handles both v2 and v3 (sectioned). v1 uses the legacy
// anchor/offset shell.
const isGrid = computed(() => {
  const v = (initial.value as any)?.version
  return v === 2 || v === 3
})

// refsSocket/autopopulateV2 moved to ~~/shared/template-grid/autopopulate —
// shared with the batch-export render path so both mirror the backend.

// Snapshot the initial layout once on mount — the editor mutates its own copy
// and we only commit back on Save.
const initial = ref<AnyTemplate | null>(null)
onMounted(() => {
  const layout = readLayout()
  const version = (layout as any).version
  if (version === 2 || version === 3) {
    const v3 = layout as unknown as TemplateV3
    // Round-1 templates persisted `gen.surface`; migrate on open so the
    // editor's theme UI (and any shuffle/surprise before a fresh re-roll)
    // reads `gen.theme` immediately instead of waiting for the next re-roll.
    // `hasImage` must be threaded through here too — `gen.staging: 'centered'`
    // is part of the `{withImage, without}` split, and without this context a
    // legacy doc with a wired image would migrate to the wrong (imageless)
    // staging id (Round-2b Task 5 fix).
    const hasImage = 'image_layer_1' in initialProps.value
    if (v3.gen) v3.gen = migrateGen(v3.gen, { hasImage })
    const hasStaged = (v3.elements ?? []).some(e => e.origin === 'staging')

    // "Fresh" = a just-created starter with no hand-authored content yet: no
    // top-level elements, no sections, no staged elements, no tiers already
    // seeded (mirrors makeStarterTemplate's `elements: []`). Only a fresh
    // layout is eligible for tier-seed+generate below — autopopulateV2's
    // freeform per-socket placement and generate()'s staged tiers must stay
    // MUTUALLY EXCLUSIVE for the same socket, or a wired text prop renders
    // twice (once as a freeform element, once as a staging tier — Task 15
    // Critical). Any layout that's NOT provably fresh (existing elements,
    // sections, staged elements, or tiers) falls back to today's exact
    // autopopulateV2-only behavior — never generate over hand-authored work.
    const isFresh = (layout.elements?.length ?? 0) === 0
      && (!v3.sections || v3.sections.length === 0)
      && !hasStaged && !v3.tiers

    if (isFresh) {
      // A fresh layout starts with the starter's default (looser) margin —
      // tighten it to a poster-like 3% of the master's short side. Fresh-path
      // only: reopening an existing (already-authored) layout never touches
      // a margin the user may have hand-tuned.
      const masterFmt = v3.formats[v3.master]
      if (masterFmt) v3.grid.margin = Math.round(0.03 * Math.min(masterFmt.w, masterFmt.h))

      // Generation: seed tiers from the wired text sockets and lay out one
      // composition so the editor opens on a real poster rather than a blank
      // grid.
      const tiers = autopopulateTiers(initialProps.value)
      if (Object.keys(tiers).length > 0) {
        v3.tiers = tiers
        // Round-2b: thread the image-socket CONTENT TOKEN (not the resolved
        // preview URL held in `initialProps.value.image_layer_1`) whenever
        // that socket is wired — same presence-vs-value distinction as
        // `useGridEditor`'s `genCtx()`. `undefined` here is fine even though
        // `generate()`'s staging pool at seed 1 is fixed to 'tower' (no
        // needsImage gating on this call) — it keeps this seed call
        // consistent with every later shuffle/surprise/setStaging call.
        const wiredImage = 'image_layer_1' in initialProps.value
          ? '{{ props.image_layer_1 }}'
          : undefined
        const seeded = generate({ ...v3, version: 3, sections: v3.sections ?? [] },
          { staging: 'tower', theme: 'paper', seed: 1, brand: initialBrand.value as any, image: wiredImage })
        Object.assign(layout, seeded)
      }
      // Any socket NOT consumed by tiers (wired images, or extra text layers
      // beyond the 4 importance tiers) still needs its default freeform
      // element placed — same seeding as the non-fresh path, just excluding
      // the sockets tiers already rendered.
      const remainingProps = omitConsumedProps(initialProps.value, tiers)
      autopopulateV2(layout as TemplateV2, remainingProps)
    } else {
      // Seed a default element for each connected socket the layout doesn't
      // yet reference (per-socket, so an image wired into an existing text
      // layout still gets placed). autopopulateV2 skips sockets already
      // referenced, so this is safe to run whether the layout is empty or full.
      //
      // When the layout already has generated tiers (from a prior fresh-open
      // generate), each consumed socket is rendered by the tier as LITERAL
      // content with an id like `tier_hero` — not a `{{ props.text_layer_1
      // }}` binding — so refsSocket() can't see it as referenced here.
      // Exclude tier-consumed sockets the same way the fresh path does, or
      // reopening a saved generated layout duplicates the hero text
      // (Task 15 dedup only covered the fresh path — this is the reopen fix).
      const props2 = v3.tiers ? omitConsumedProps(initialProps.value, v3.tiers) : initialProps.value
      autopopulateV2(layout as TemplateV2, props2)
    }

    initial.value = layout
    jsonDraft.value = JSON.stringify(layout, null, 2)
    return
  }
  // Auto-create one element per connected layer socket if the user hasn't
  // already added one. Images stack on the top half (so they read as the
  // hero area); text stacks on the bottom half. Both centered horizontally.
  // Each element references its own `{{ props.<socket> }}` placeholder and
  // is editable like any other element afterwards.
  for (const key of Object.keys(initialProps.value)) {
    if (layout.elements.find((e: any) => e.id === key)) continue

    if (key.startsWith('text_layer_')) {
      const idx = Number(key.slice('text_layer_'.length))
      layout.elements.push({
        id: key,
        type: 'text',
        role: `TEXT_LAYER_${idx}`,
        anchor: 'top-center',
        // Text starts at ~58% of canvas height, each layer ~12% below.
        offset: { x: 0, y: `${58 + (idx - 1) * 12}%` },
        size: { w: '84%', h: 'auto' },
        style: {
          fontFamily: 'Inter',
          fontSize: idx === 1 ? 72 : 44,
          fontWeight: idx === 1 ? 700 : 400,
          color: '#ffffff',
          align: 'center',
          lineHeight: 1.1,
        },
        content: `{{ props.${key} }}`,
      } as any)
    } else if (key.startsWith('image_layer_')) {
      const idx = Number(key.slice('image_layer_'.length))
      if (idx === 1) {
        // First image fills the canvas as a background. Text layers overlay
        // on top. Matches the Python autopopulate defaults so the editor's
        // canvas preview and the server-side satori render agree.
        layout.elements.push({
          id: key,
          type: 'image',
          role: `IMAGE_LAYER_${idx}`,
          anchor: 'top-left',
          offset: { x: 0, y: 0 },
          size: { w: '100%', h: '100%' },
          style: { fit: 'cover', borderRadius: 0 },
          content: `{{ props.${key} }}`,
        } as any)
      } else {
        // Additional images sit as smaller corner thumbnails.
        layout.elements.push({
          id: key,
          type: 'image',
          role: `IMAGE_LAYER_${idx}`,
          anchor: 'top-right',
          offset: { x: '4%', y: `${4 + (idx - 2) * 14}%` },
          size: { w: '20%', h: '12%' },
          style: { fit: 'cover', borderRadius: 12 },
          content: `{{ props.${key} }}`,
        } as any)
      }
    }
  }
  initial.value = layout
})

/**
 * Walk back from one of this SmartLayout's named inputs to whatever's wired
 * into it. Returns the upstream Text node's widget value, or null if nothing
 * is wired or the upstream isn't a Text node.
 *
 * Only Text nodes are introspectable today — pulling live values from
 * Claude/Gemini/Whisper would require running the upstream graph. Defer.
 */
function readUpstreamText(inputName: string): string | null {
  const node = props.nodes.find((n: any) => n.id === props.nodeId)
  if (!node) return null
  const inputs = node.data?.inputs as any[] | undefined
  if (!inputs) return null

  const idx = inputs.findIndex((i: any) => i.name === inputName)
  if (idx < 0) return null

  const edge = props.edges.find((e: any) =>
    e.target === props.nodeId && e.targetHandle === `input-${idx}`)
  if (!edge) return null

  const source = props.nodes.find((n: any) => n.id === edge.source)
  if (!source || source.data?.nodeType !== 'Text') return null

  const defs = source.data.widgetDefs as any[] | undefined
  const wv = source.data.widgetsValues as any[] | undefined
  if (!defs || !wv) return null
  const textIdx = defs.findIndex((d: any) => d.name === 'text')
  if (textIdx < 0) return null
  const raw = String(wv[textIdx] ?? '').trim()
  return raw || null
}

/** Same as readUpstreamText but parses the result as key=value pairs (for brand). */
function readUpstreamKv(inputName: string): Record<string, string> {
  const raw = readUpstreamText(inputName)
  if (!raw) return {}
  const out: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#') || !t.includes('=')) continue
    const [k, v] = t.split('=', 2)
    out[k.trim()] = v.trim()
  }
  return out
}

// One placeholder per connected text_layer_<N> socket. Indexed by socket id
// (text_layer_1, text_layer_2, …). The editor auto-creates a text element
// per entry below, and the renderer substitutes via `{{ props.text_layer_N }}`.
const _MAX_TEXT_LAYERS = 8
const _MAX_IMAGE_LAYERS = 8

/** All entries of an upstream multi-entry Text node (the canvas Text artifact
 * stores them on data.properties.textEntries), falling back to the single
 * widget value. At run time the node fans out one render per entry; in the
 * editor the active variant drives the preview via the cycler. */
function readUpstreamTextVariants(inputName: string): string[] {
  const node = props.nodes.find((n: any) => n.id === props.nodeId)
  if (!node) return []
  const inputs = node.data?.inputs as any[] | undefined
  if (!inputs) return []
  const idx = inputs.findIndex((i: any) => i.name === inputName)
  if (idx < 0) return []
  const edge = props.edges.find((e: any) =>
    e.target === props.nodeId && e.targetHandle === `input-${idx}`)
  if (!edge) return []
  const source = props.nodes.find((n: any) => n.id === edge.source)
  if (!source || source.data?.nodeType !== 'Text') return []
  const entries = (source.data.properties?.textEntries as unknown[] | undefined)
    ?.map(s => String(s ?? '').trim()).filter(Boolean)
  if (entries?.length) return entries
  const single = readUpstreamText(inputName)
  return single ? [single] : []
}

const variantsByLayer = computed<Record<string, string[]>>(() => {
  const out: Record<string, string[]> = {}
  for (let i = 1; i <= _MAX_TEXT_LAYERS; i++) {
    const v = readUpstreamTextVariants(`text_layer_${i}`)
    if (v.length) out[`text_layer_${i}`] = v
  }
  return out
})
const activeVariantByLayer = ref<Record<string, number>>({})

// Consumed by the variant cycler in both property panels (v1 + grid).
provide('smartLayoutVariants', { variantsByLayer, activeVariantByLayer })

const baseInitialProps = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {}
  for (let i = 1; i <= _MAX_TEXT_LAYERS; i++) {
    const key = `text_layer_${i}`
    const variants = variantsByLayer.value[key]
    if (variants?.length) {
      const idx = Math.min(variants.length - 1, Math.max(0, activeVariantByLayer.value[key] ?? 0))
      out[key] = variants[idx]
    }
  }
  // For image layers, the editor doesn't actually need the upstream URL to
  // *create* the element — the renderer fills it at execution time. We only
  // care whether each image_layer_<N> socket is *connected*, so we can
  // auto-create a matching element. The placeholder URL falls back to a
  // gray box; LoadImage upstream gets a real preview via readUpstreamImage.
  for (let i = 1; i <= _MAX_IMAGE_LAYERS; i++) {
    const url = readUpstreamImageUrl(`image_layer_${i}`)
    if (url !== null) out[`image_layer_${i}`] = url
  }
  return out
})

// -- Turn-into-variable: bound elements render live Collection values --------
// The wired collection is whatever Collection node's VARS output feeds this
// SmartLayout node (same edge shape `promoteLayoutElement`/`findWiredCollectionNode`
// use). `node` above already tracks `props.nodes` reactively, so this recomputes
// whenever the node's `data.properties[BINDINGS_PROP]` mutates OR the collection
// node's own `data.properties[COLLECTION_PROP]` mutates (both are read here,
// so Vue's dependency tracking picks up scrubbing the preview row / editing
// cells directly) — verified: `resolveBindings` reads `c.rows[rowIndex]` and
// `c` is read off the reactive `nodes` array via `.find()`, so any deep mutation
// on the node objects (row edits, previewRow changes) re-triggers this computed.
const wiredCollectionNode = computed<any | undefined>(() => {
  const edge = props.edges.find((e: any) =>
    String(e.target) === String(props.nodeId) && e?.data?.dataType === VARS_TYPE)
  if (!edge) return undefined
  return props.nodes.find((n: any) => String(n.id) === String(edge.source))
})

const liveBindings = computed<VarBindings>(() =>
  (node.value?.data?.properties?.[BINDINGS_PROP] as VarBindings | undefined) ?? {})

const resolvedBindingProps = computed<Record<string, string>>(() => {
  const colNode = wiredCollectionNode.value
  const c = colNode?.data?.properties?.[COLLECTION_PROP] as CollectionData | undefined
  if (!c) return {}
  const { values } = resolveBindings(c, liveBindings.value, c.previewRow)
  return splitResolvedValues(values).props
})

// Resolved collection values win over the upstream-socket props: once an
// element is bound, its live cell value is what the editor should show.
const initialProps = computed<Record<string, string>>(() => ({
  ...baseInitialProps.value,
  ...resolvedBindingProps.value,
}))

// Threaded to GridEditorCanvas.vue / GridPropertyPanel.vue (inject, bypassing
// GridEditorShell's props — provide/inject pierces the shell without adding
// SmartLayout-specific plumbing to the generic grid-editor composable). Gives
// the editor everything Task 3's context menu / inspector Variable row need:
// the layout node id (to dispatch sailor:promoteLayoutElement), raw
// nodes/edges accessors (for Go to collection / direct collection writes),
// and the already-computed bindings + wired collection so canvas badges and
// the inspector don't each re-derive the VARS-edge lookup.
const smartLayoutBinding: SmartLayoutBindingContext = {
  nodeId: props.nodeId,
  nodesAccessor: () => props.nodes,
  edgesAccessor: () => props.edges,
  bindings: liveBindings,
  collectionNode: wiredCollectionNode,
}
provide('smartLayoutBinding', smartLayoutBinding)

/**
 * Best-effort URL extraction for an upstream IMAGE source. Today we only
 * recognise LoadImage (we can read its filename widget). Anything else is
 * opaque (a generated tensor) and gets a placeholder — the actual render at
 * execution time will use the real image. Returns null if not connected,
 * '' if connected but unknown source (caller renders a placeholder tile).
 */
function readUpstreamImageUrl(inputName: string): string | null {
  const node = props.nodes.find((n: any) => n.id === props.nodeId)
  if (!node) return null
  const inputs = node.data?.inputs as any[] | undefined
  if (!inputs) return null
  const idx = inputs.findIndex((i: any) => i.name === inputName)
  if (idx < 0) return null
  const edge = props.edges.find((e: any) =>
    e.target === props.nodeId && e.targetHandle === `input-${idx}`)
  if (!edge) return null

  const source = props.nodes.find((n: any) => n.id === edge.source)
  if (!source) return null

  // LoadImage or an `Image` artifact node (e.g. a pasted/uploaded image): surface
  // the picked filename via /view so the editor shows a realistic preview while
  // authoring. Both store the filename in the `image` widget (resolved by name),
  // and an Image node has no data.images until it has executed.
  if (source.data?.nodeType === 'LoadImage' || source.data?.nodeType === 'Image') {
    const defs = source.data.widgetDefs as any[] | undefined
    const wv = source.data.widgetsValues as any[] | undefined
    const wIdx = defs?.findIndex((d: any) => d.name === 'image') ?? -1
    const filename = wIdx >= 0 ? wv?.[wIdx] : undefined
    if (filename) return `/view?${new URLSearchParams({ filename: String(filename), type: 'input' })}`
  }
  // Generated images: once the upstream node has executed, its output lands
  // in data.images (same source the node-body thumbnails use) — borrow the
  // latest frame so the editor previews real campaign imagery.
  if (source.data?.images?.length) return String(source.data.images[0])
  // Connected but never run and not introspectable — return empty so the
  // editor places a placeholder element. Actual image fills at render time.
  return ''
}

// What `{{ brand.x }}` placeholders see. Wire `primary=#0a0a0a\naccent=…`
// into the brand socket.
const initialBrand = computed<Record<string, string>>(() =>
  readUpstreamKv('brand'),
)

// The node's legacy `aspects` CSV. Used only to migrate pre-outputs templates
// into an explicit `outputs` list inside the editor; once saved, the template
// carries its own outputs and this is ignored.
const initialAspects = computed<string>(() => {
  const i = widgetIdx('aspects')
  if (i < 0 || !node.value) return ''
  return String(node.value.data.widgetsValues?.[i] ?? '')
})

// The project's active brand kit, provided by the layout (default.vue).
// Slots between template defaults and the wired socket brand in the editor's
// shared effectiveBrand merge.
const projectBrand = inject<{ activeKit: ComputedRef<BrandKit | undefined> } | null>('sailor:brand', null)
const activeKit = computed(() => projectBrand?.activeKit.value)

// Close on Escape — unless something inside already used it (the prompt's Esc
// clears its mode chip or leaves the field and calls preventDefault).
function onKey(e: KeyboardEvent) {
  if (e.defaultPrevented) return
  if (e.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))

// The EditorShell saves via fetch — but we want it to save to the node, not
// to a file. So we listen for a custom save event the shell dispatches.
//
// Write the layout to the node AND refresh its live preview. Re-run ONLY this
// node (+ its cached upstream), not the whole canvas — a filtered live run.
// `live` skips the cost confirm/watchdog; the reactive widget-watch's auto-run
// is unreliable here (its guard bails when an optional socket like Brand is
// left unconnected), so we trigger explicitly: saving is exactly when the user
// expects the node preview to reflect their edits.
function commitLayout(layout: AnyTemplate) {
  writeLayout(layout)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('sailor:runFiltered', {
      detail: { targetIds: [props.nodeId], live: true },
    }))
  }
  emit('close')
}

function onLayoutSaved(layout: AnyTemplate) {
  commitLayout(layout)
}

// -- v2 (Swiss grid) editing --------------------------------------------------
// Default view is the visual grid editor; the JSON panel stays available as
// an escape hatch (per-format-key overrides have no UI yet).

const v2View = ref<'visual' | 'json'>('visual')
const gridShellKey = ref(0)

/** One-way v1 → v2 conversion. Only persists when the user saves afterwards;
 * closing without saving leaves the node's v1 layout untouched. */
function convertToGrid() {
  const v = (initial.value as any)?.version
  if (!initial.value || v === 2 || v === 3) return
  const converted = convertV1toV2(initial.value as Template)
  initial.value = converted
  jsonDraft.value = JSON.stringify(converted, null, 2)
  v2View.value = 'visual'
  gridShellKey.value++
}

function showJsonView() {
  // Pick up whatever the visual editor changed before showing the draft.
  jsonDraft.value = JSON.stringify(initial.value, null, 2)
  v2View.value = 'json'
}

function openBatchExport() {
  // Pass the editor's LIVE draft along — the node widget only updates on
  // Save & close, and the batch sheet must offer the formats/elements the
  // user is looking at right now, not the last-saved state.
  const draft = initial.value ? JSON.parse(JSON.stringify(initial.value)) : undefined
  window.dispatchEvent(new CustomEvent('sailor:openBatchExport', {
    detail: { nodeId: props.nodeId, template: draft },
  }))
}

function showVisualView() {
  // Remount the shell so it picks up a JSON draft applied in the meantime.
  gridShellKey.value++
  v2View.value = 'visual'
}

const jsonDraft = ref('')
const jsonError = ref('')

/** Parse the draft and refresh the previews without closing the modal. */
function applyV2Draft(): TemplateV2 | null {
  try {
    const parsed = JSON.parse(jsonDraft.value)
    if ((parsed?.version !== 2 && parsed?.version !== 3) || typeof parsed.formats !== 'object') {
      jsonError.value = 'Template must have "version": 2 or 3 and a "formats" object.'
      return null
    }
    jsonError.value = ''
    initial.value = parsed
    return parsed as TemplateV2
  } catch (e: any) {
    jsonError.value = `Invalid JSON: ${e?.message ?? e}`
    return null
  }
}

function saveV2() {
  const parsed = applyV2Draft()
  if (!parsed) return
  commitLayout(parsed)
}

/** Props for the preview renders: wired text/image values where readable. */
const v2RenderProps = computed<Record<string, unknown>>(() => {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(initialProps.value)) {
    // Empty string means "connected but not introspectable" — skip so the
    // preview shows the slot culled/empty rather than a broken image.
    if (v) out[k] = k.startsWith('image_layer_') ? new URL(v, window.location.origin).toString() : v
  }
  return out
})

// Images sitting on the ComfyUI node graph — the "On canvas" source for the
// editor's image picker. Gathers executed outputs (node.data.images) and the
// files picked on LoadImage / Image nodes (same sources readUpstreamImageUrl
// recognises, but across every node, not just the wired one).
const canvasImages = computed<Array<{ url: string; label?: string }>>(() => {
  const out: Array<{ url: string; label?: string }> = []
  const seen = new Set<string>()
  const add = (url: unknown, label?: string) => {
    const u = String(url ?? '').trim()
    if (!u || seen.has(u)) return
    seen.add(u)
    out.push({ url: u, label })
  }
  for (const n of props.nodes) {
    const d = (n as any)?.data
    if (!d) continue
    const label = d.title || d.nodeType || undefined
    if (Array.isArray(d.images)) for (const img of d.images) add(img, label)
    if (d.nodeType === 'LoadImage' || d.nodeType === 'Image') {
      const defs = d.widgetDefs as any[] | undefined
      const wv = d.widgetsValues as any[] | undefined
      const wi = defs?.findIndex((x: any) => x.name === 'image') ?? -1
      const filename = wi >= 0 ? wv?.[wi] : undefined
      if (filename) add(`/view?${new URLSearchParams({ filename: String(filename), type: 'input' })}`, label)
    }
  }
  return out
})
</script>

<template>
  <div class="fixed inset-0 z-50 bg-black/55 backdrop-blur-sm flex items-center justify-center p-6">
    <div class="relative w-full max-w-[1440px] h-[88vh] flex rounded-2xl border border-white/10 bg-[#0e0e10] overflow-hidden shadow-[0_24px_80px_rgba(0,0,0,0.6)]">
    <!-- Close button — Escape also works -->
    <button
      class="absolute top-3 right-3 z-10 size-8 rounded bg-white/[0.06] hover:bg-white/[0.12] flex items-center justify-center text-white/70 hover:text-white transition-colors cursor-pointer"
      title="Close (Esc)"
      @click="emit('close')"
    >
      <X class="size-4" />
    </button>

    <!-- The v1 editor. EditorShell receives `initial` and mutates its
         own composable state; we re-read on Save via the @save event. -->
    <TemplatesEditorShell
      v-if="initial && !isGrid"
      :key="nodeId"
      :initial="initial as any"
      :initial-props="initialProps"
      :initial-brand="initialBrand"
      embedded
      @save="onLayoutSaved"
    />

    <!-- v1 → v2 conversion affordance -->
    <button
      v-if="initial && !isGrid"
      class="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 h-8 px-3 rounded-full bg-action/15 hover:bg-action/25 border border-action/25 text-[12px] text-[#c9d6ff] transition-colors cursor-pointer"
      title="One-way conversion to the Swiss grid system (auto-reflow to every ad format). Takes effect when you save."
      @click="convertToGrid"
    >
      Convert to grid layout
    </button>

    <!-- The v2 visual grid editor -->
    <TemplatesGridEditorShell
      v-else-if="initial && v2View === 'visual'"
      :key="`${nodeId}-grid-${gridShellKey}`"
      :initial="initial as any"
      :initial-props="initialProps"
      :initial-brand="initialBrand"
      :aspects="initialAspects"
      :active-kit="activeKit"
      :canvas-images="canvasImages"
      @save="onLayoutSaved"
    >
      <template #topbar-end>
        <button
          class="h-8 px-2.5 rounded bg-white/[0.04] hover:bg-white/[0.08] text-[12px] text-white/70 transition-colors cursor-pointer"
          title="Render every combination of formats × bound variables"
          @click="openBatchExport"
        >
          Batch export
        </button>
        <button
          class="h-8 px-2.5 rounded bg-white/[0.04] hover:bg-white/[0.08] text-[12px] text-white/50 transition-colors cursor-pointer"
          title="Edit the raw layout JSON (escape hatch)"
          @click="showJsonView"
        >
          JSON
        </button>
      </template>
    </TemplatesGridEditorShell>

    <!-- v2 JSON escape hatch: live per-format previews + raw JSON -->
    <div v-else-if="initial" class="flex w-full h-full p-6 gap-4">
      <div class="flex-1 min-w-0 flex flex-col rounded-xl bg-[#121212] border border-white/[0.06] overflow-hidden">
        <div class="px-4 py-3 border-b border-white/[0.06] flex items-baseline gap-2">
          <span class="text-[13px] text-white/85 font-medium">Format previews</span>
          <span class="text-[11px] text-white/35">Swiss grid · one master, every format reflows</span>
        </div>
        <TemplatesGridFormatPreviews
          :template="initial as any"
          :render-props="v2RenderProps"
          :brand="initialBrand"
          class="flex-1"
        />
      </div>
      <div class="w-[420px] shrink-0 flex flex-col rounded-xl bg-[#121212] border border-white/[0.06] overflow-hidden">
        <div class="px-4 py-3 border-b border-white/[0.06]">
          <span class="text-[13px] text-white/85 font-medium">Layout JSON</span>
          <p class="text-[11px] text-white/35 mt-0.5">Visual grid editing is coming; for now edit regions here.</p>
        </div>
        <textarea
          v-model="jsonDraft"
          spellcheck="false"
          class="flex-1 w-full resize-none bg-transparent text-[12px] font-mono text-white/80 p-4 outline-none"
        />
        <div class="px-4 py-3 border-t border-white/[0.06] flex items-center gap-2">
          <button
            class="px-3 h-8 rounded bg-white/[0.06] hover:bg-white/[0.12] text-xs text-white/80 transition-colors cursor-pointer"
            @click="showVisualView"
          >
            Back to visual
          </button>
          <button
            class="px-3 h-8 rounded bg-white/[0.06] hover:bg-white/[0.12] text-xs text-white/80 transition-colors cursor-pointer"
            @click="applyV2Draft"
          >
            Apply to previews
          </button>
          <button
            class="px-3 h-8 rounded bg-action/20 hover:bg-action/30 text-xs text-[#c9d6ff] transition-colors cursor-pointer"
            @click="saveV2"
          >
            Save to node
          </button>
          <span v-if="jsonError" class="text-[11px] text-red-400 truncate">{{ jsonError }}</span>
        </div>
      </div>
    </div>
    </div>
  </div>
</template>
