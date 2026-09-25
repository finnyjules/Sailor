<script setup lang="ts">
/**
 * NodeInspector — right-hand panel that edits the *mechanical* settings of the
 * currently-selected canvas node (seed, aspect ratio, advanced knobs), leaving
 * the creative surface (prompt, character/style cards, result, re-roll) on the
 * node itself. Renders the node's own widget definitions through the same
 * `ComfyNodeWidget` the node body uses, writing straight back to
 * `node.data.widgetsValues` — so edits here and on the canvas stay in lock-step.
 *
 * Phase 1 is additive: these widgets still render on the node too. A later pass
 * hides them on the node so they live only here.
 */
import { computed } from 'vue'
import { X } from 'lucide-vue-next'
import { isLoraSlotWidgetVisible } from '~/lib/graph/loraSlotVisibility'
import { NO_FAMILIES, parseFamilies } from '#shared/runner/families'
import { upgradeHidesWidget } from '#shared/runner/eligibility'

const props = defineProps<{ node: any | null }>()
defineEmits<{ close: [] }>()

// The "mechanical" set that belongs in the inspector: anything flagged advanced,
// seed widgets, and aspect_ratio. Everything else (prompt, lora pickers, …) is
// the node's creative surface and stays on the canvas.
function isSeedWidgetDef(w: any): boolean {
  return !!w && w.type === 'INT' && (w.control_after_generate || /seed/i.test(String(w.name || '')))
}
function isInspectorWidget(w: any): boolean {
  if (!w || w.hidden || w.sailor_widget === 'internal' || w.sailor_widget === 'lora_picker') return false
  if (w.advanced) return true
  if (isSeedWidgetDef(w)) return true
  if (w.name === 'aspect_ratio') return true
  return false
}

// The runner families on (none while the runner is off), as the node's badge
// reads them: a node moved onto a newer model hides the settings that model
// can't honour, here as on the node (Product shot on Bria Product Shot, Task F12).
const inspectorPublic = useRuntimeConfig().public as { runnerEnabled?: boolean, runnerFamilies?: unknown }
const inspectorFamilies = inspectorPublic.runnerEnabled ? parseFamilies(inspectorPublic.runnerFamilies) : NO_FAMILIES

// Mirror ComfyNode's index-aligned iteration: widgetDefs[i] ↔ widgetsValues[i].
// Also respects the same progressive-disclosure rule ComfyNode applies on the
// node body (WIDGET_VISIBILITY's FluxMultiLoRARemoteNode entry) — otherwise a
// fresh multi-LoRA node shows lora_c_url/lora_d_url here even though slots C/D
// are hidden on the node until B is filled.
const inspectorWidgets = computed(() => {
  const defs = (props.node?.data?.widgetDefs || []) as any[]
  const values = (props.node?.data?.widgetsValues || []) as any[]
  return defs
    .map((widget, index) => ({ widget, index }))
    .filter(({ widget }) => isInspectorWidget(widget))
    // Properties ride along: a moodboard-held slot's only trace is
    // properties.sailor_moodboard_<letter> (widgets stay '[None]'/blank).
    .filter(({ widget }) => isLoraSlotWidgetVisible(widget.name, values, defs, props.node?.data?.properties))
    .filter(({ widget }) => !upgradeHidesWidget(String(props.node?.data?.nodeType || ''), widget.name, inspectorFamilies))
})

const nodeTitle = computed(() =>
  props.node?.data?.title || props.node?.data?.nodeType || 'Inspector')

// FluxLoRARemoteNode/FluxMultiLoRARemoteNode "Style"/aesthetic — a node PROPERTY
// (not a ComfyUI input) folded into the prompt at submit. Mirrors ComfyNode's
// old getter/setter; `tasteProfile` fallback keeps pre-rename workflows working.
const hasStyleField = computed(() =>
  props.node?.data?.nodeType === 'FluxLoRARemoteNode'
  || props.node?.data?.nodeType === 'FluxMultiLoRARemoteNode')
const styleValue = computed<string>({
  get: () => String(props.node?.data?.properties?.aesthetic ?? props.node?.data?.properties?.tasteProfile ?? ''),
  set: (v: string) => {
    if (!props.node) return
    if (!props.node.data.properties) props.node.data.properties = {}
    props.node.data.properties.aesthetic = v
  },
})

// Seed lock — mirrors ComfyNode.isSeedFixed / setSeedFixed. The lock lives at
// widgetsValues[i+1] for Comfy-standard seeds (control_after_generate) or in
// properties.seedLocks for non-standard (Replicate / custom) seeds.
function isSeedFixed(widget: any, i: number): boolean {
  if (!isSeedWidgetDef(widget)) return false
  if (widget.control_after_generate) return props.node?.data?.widgetsValues?.[i + 1] === 'fixed'
  return !!props.node?.data?.properties?.seedLocks?.[widget.name]
}
function setSeedFixed(widget: any, i: number, fixed: boolean) {
  if (!isSeedWidgetDef(widget) || !props.node) return
  const data = props.node.data
  if (widget.control_after_generate) {
    if (data.widgetsValues) data.widgetsValues[i + 1] = fixed ? 'fixed' : 'randomize'
    return
  }
  if (!data.properties) data.properties = {}
  ;(data.properties.seedLocks ??= {})[widget.name] = fixed
}
function setValue(i: number, val: any) {
  if (props.node?.data?.widgetsValues) props.node.data.widgetsValues[i] = val
}
</script>

<template>
  <div class="h-full flex flex-col bg-[#141414] border-l border-[#2a2a2a]">
    <div class="flex items-center gap-2 px-3 h-11 border-b border-[#2a2a2a] shrink-0">
      <span class="size-1.5 rounded-full shrink-0" :class="node ? 'bg-[#5b7cff]' : 'bg-white/20'" />
      <span class="text-[12px] font-medium text-white/90 truncate flex-1">{{ nodeTitle }}</span>
      <button
        class="text-white/40 hover:text-white/80 transition-colors cursor-pointer"
        title="Close"
        @click="$emit('close')"
      >
        <X class="size-4" />
      </button>
    </div>

    <div class="flex-1 overflow-y-auto p-3">
      <p v-if="!node" class="text-[12px] text-white/40 text-center px-2 py-8 leading-relaxed">
        Select a node to edit its settings.
      </p>
      <p v-else-if="!inspectorWidgets.length && !hasStyleField" class="text-[12px] text-white/40 text-center px-2 py-8 leading-relaxed">
        This node has no inspector settings.
      </p>
      <div v-else class="flex flex-col gap-5">
        <div v-if="inspectorWidgets.length" class="flex flex-col gap-3.5">
          <div class="text-[9.5px] font-medium uppercase tracking-[0.08em] text-white/35">Settings</div>
          <div v-for="{ widget, index } in inspectorWidgets" :key="widget.name" class="nopan nodrag">
            <VueCanvasComfyNodeWidget
              :widget-def="widget"
              :node-type="node.data.nodeType"
              :node-id="node.id"
              :model-value="node.data.widgetsValues?.[index]"
              :is-fixed="isSeedFixed(widget, index)"
              @update:model-value="setValue(index, $event)"
              @update:is-fixed="setSeedFixed(widget, index, $event)"
            />
          </div>
        </div>

        <div v-if="hasStyleField" class="flex flex-col gap-2">
          <div class="text-[9.5px] font-medium uppercase tracking-[0.08em] text-white/35">Style</div>
          <textarea
            v-model="styleValue"
            rows="5"
            placeholder="Style / aesthetic — added to the front of your prompt at run time."
            class="w-full bg-white/5 border border-white/10 rounded-md px-2.5 py-2 text-[12px] leading-relaxed text-foreground placeholder:text-white/25 outline-none focus-visible:border-ring resize-y"
          />
          <p class="text-[10px] text-white/35 leading-snug">Prepended to your prompt when you run.</p>
        </div>
      </div>
    </div>
  </div>
</template>
