<script setup lang="ts">
/**
 * Designer-friendly body for the SmartLayout node on the canvas. Replaces the
 * raw `layout` JSON / `aspects` CSV / `brand` key=value widgets with a single
 * hero "Design layout" button plus a one-line summary. Output formats are now
 * chosen *inside* the editor (the Outputs rail), not on the node face — the
 * node just opens the editor and shows what's designed.
 */
import { Grid3X3, LayoutTemplate } from 'lucide-vue-next'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useNode, useVueFlow } from '@vue-flow/core'
import { VAR_PREVIEW_PROP, BINDINGS_PROP } from '~/lib/collection/types'
import { readTemplateFromNode } from '~/lib/collection/bindables'
import { wiredLayerProps } from '~/lib/collection/wiredProps'
import { autopopulateV2 } from '~~/shared/template-grid/autopopulate'
import NodeOpenBar from '~/components/vue-canvas/surfaces/NodeOpenBar.vue'

const props = defineProps<{ data: any }>()
const emit = defineEmits<{ edit: []; batch: [] }>()

function widgetIdx(name: string): number {
  return (props.data.widgetDefs as any[] | undefined)?.findIndex(d => d.name === name) ?? -1
}

/** Parsed layout JSON (or null) — source of the element + output counts. */
const layout = computed<any | null>(() => {
  const i = widgetIdx('layout')
  const raw = i >= 0 ? String(props.data.widgetsValues?.[i] ?? '').trim() : ''
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
})

const elementCount = computed<number>(() => {
  const els = layout.value?.elements
  return Array.isArray(els) ? els.length : 0
})

/** Deliverables count: the template's explicit `outputs`, else the legacy
 *  `aspects` CSV. */
const outputCount = computed<number>(() => {
  const outs = layout.value?.outputs
  if (Array.isArray(outs) && outs.length) return outs.length
  const i = widgetIdx('aspects')
  const raw = i >= 0 ? String(props.data.widgetsValues?.[i] ?? '') : ''
  return raw.split(',').map(s => s.trim()).filter(Boolean).length
})

// --- Collection-driven live preview ---------------------------------------
// When a Collection is wired into this node's `vars` input with bindings set,
// CollectionDrawer/CollectionNode stamp the resolved row onto
// data.properties.sailor_varPreview. We watch that and render a rendered
// thumbnail (via the same /api/render-template pipeline the layout editor
// uses) so scrubbing rows updates the node face live.
const previewUrl = ref<string | null>(null)
let debounceHandle: ReturnType<typeof setTimeout> | null = null
// Module-instance generation counter: guards against an older in-flight
// /api/render-template response resolving after a newer one and clobbering
// the preview with stale (backwards-flickering) content.
let renderGeneration = 0

const varCount = computed(() => Object.keys(props.data.properties?.[BINDINGS_PROP] ?? {}).length)

// The node's graph context — for resolving wired image/text sockets into the
// scrub preview so it matches what a real run bakes (not a text-only ghost).
const { getNodes, getEdges } = useVueFlow()
const vfNode = useNode()

// Run results replace the scrub preview: once the node has real output
// (ComfyNode's result section below this body), a second — client-rendered —
// preview is just a duplicate, and historically a wrong one.
const hasRunResults = computed(() => !!(props.data.images?.length))

async function renderVarPreview() {
  const preview = props.data.properties?.[VAR_PREVIEW_PROP]
  const template = readTemplateFromNode({ data: props.data }) as any
  if (!preview || !template || hasRunResults.value) return
  const generation = ++renderGeneration
  try {
    // Wired sockets layer UNDER the scrubbed collection values; image URLs
    // absolutized for the server-side renderer.
    const wired: Record<string, string> = {}
    for (const [k, v] of Object.entries(wiredLayerProps(getNodes.value as any[], getEdges.value as any[], String(vfNode.id)))) {
      wired[k] = k.startsWith('image_layer_') ? new URL(v, window.location.origin).toString() : v
    }
    const renderProps = { ...wired, ...(preview.props ?? {}) }
    // Mirror the backend: seed an element for every connected socket the
    // saved layout doesn't reference yet (full-bleed image_layer_1 etc.).
    const clone = JSON.parse(JSON.stringify(template))
    if (clone.version === 2 || clone.version === 3) autopopulateV2(clone, renderProps)
    const res = await fetch('/api/render-template', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ template: clone, aspect: clone.master, props: renderProps, brand: preview.brand ?? {} }),
    })
    if (!res.ok) return
    const blob = await res.blob()
    if (generation !== renderGeneration) return // a newer request superseded this one — drop it
    const nextUrl = URL.createObjectURL(blob)
    if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
    previewUrl.value = nextUrl
  } catch {
    // Best-effort preview — leave the previous thumbnail (or none) on failure.
  }
}

watch(
  () => props.data.properties?.[VAR_PREVIEW_PROP],
  (preview) => {
    if (debounceHandle) clearTimeout(debounceHandle)
    if (!preview || hasRunResults.value) return
    debounceHandle = setTimeout(renderVarPreview, 400)
  },
  { deep: true, immediate: true },
)

onBeforeUnmount(() => {
  if (debounceHandle) clearTimeout(debounceHandle)
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
})

const summary = computed(() =>
  `${elementCount.value} element${elementCount.value === 1 ? '' : 's'} · ${outputCount.value} output${outputCount.value === 1 ? '' : 's'}`
  + (varCount.value ? ` · ${varCount.value} vars` : ''),
)
</script>

<template>
  <div class="px-2.5 pb-2.5 pt-1 nopan nodrag flex flex-col gap-[5px]">
    <template v-if="elementCount">
      <div class="node-well node-openbar-host" :class="previewUrl && !hasRunResults ? 'min-h-[56px]' : 'min-h-[38px]'" :data-selected="!(previewUrl && !hasRunResults) || undefined">
        <img v-if="previewUrl && !hasRunResults" :src="previewUrl" class="block w-full" />
        <NodeOpenBar :meta="summary">
          <button type="button" class="node-btn nopan nodrag" @click.stop="emit('edit')">Open</button>
        </NodeOpenBar>
      </div>
      <!-- Batch export — cartesian render across formats × bound variables. -->
      <button type="button" class="node-btn node-btn--primary w-full justify-center" @click="emit('batch')">
        <Grid3X3 class="size-3.5" />
        Batch export
      </button>
    </template>
    <button v-else type="button" class="node-btn node-btn--primary w-full justify-center" title="Wire layers, then design the layout" @click="emit('edit')">
      <LayoutTemplate class="size-3.5" />
      Design layout
    </button>
  </div>
</template>
