<script setup lang="ts">
import { useHandleConnections } from '@vue-flow/core'
import { RefreshCw, Image, Loader2, PersonStanding, Play } from 'lucide-vue-next'
import { getTypeColor } from '~/composables/useVueNodes'
import { useNodeGlass } from '~/composables/useCanvasGlass'
import NodeOpenBar from '~/components/vue-canvas/surfaces/NodeOpenBar.vue'
import StudioSegmented from '~/components/vue-canvas/studio/StudioSegmented.vue'
import { isStudioControl } from '~/lib/canvas/studioDblclick'

// Pose Mannequin artifact node. Shows ONLY the posed mannequin render (the gray
// figure). The wired character + the generated result live elsewhere: the
// character comes in the input port, and the result flows OUT of the IMAGE
// output into a downstream artifact-image node (created on generate).
const props = defineProps<{
  id: string
  selected?: boolean
  data: {
    nodeType: string
    title: string
    inputs: { name: string; type: string; link: number | null }[]
    outputs: { name: string; type: string; links: number[] | null }[]
    widgetsValues: any[]
    widgetDefs?: any[]
    properties?: Record<string, any>
    mode: number
    running?: boolean
    error?: boolean
    images?: string[]
  }
}>()

const glass = useNodeGlass(() => props.id)

const isMuted = computed(() => props.data.mode === 2)
const isBypassed = computed(() => props.data.mode === 4)
const imageColor = computed(() => getTypeColor('IMAGE'))

function widgetIdx(name: string): number { return props.data.widgetDefs?.findIndex((w: any) => w.name === name) ?? -1 }
function widgetStr(name: string): string { const i = widgetIdx(name); return i >= 0 ? String(props.data.widgetsValues?.[i] ?? '') : '' }
function inputIdx(name: string): number { return props.data.inputs?.findIndex(i => i.name === name) ?? -1 }
function outputIdx(name: string): number { const i = props.data.outputs?.findIndex(o => o.name === name) ?? -1; return i >= 0 ? i : 0 }

const mannequinUrl = computed<string | null>(() => {
  const fn = widgetStr('mannequin_image')
  return fn ? `/view?${new URLSearchParams({ filename: fn, type: 'input' })}` : null
})
const hasPose = computed(() => !!mannequinUrl.value)

type PoseMode = 'mannequin' | 'image' | 'prompt'

const poseSource = computed<PoseMode>(() => {
  const v = widgetStr('pose_source')
  return (v === 'image' || v === 'prompt') ? v : 'mannequin'
})

function setWidget(name: string, v: any) {
  const i = widgetIdx(name)
  if (i < 0) return
  if (!Array.isArray(props.data.widgetsValues)) props.data.widgetsValues = []
  props.data.widgetsValues[i] = v
}

function setMode(m: PoseMode) { setWidget('pose_source', m) }

const posePrompt = computed<string>({
  get: () => widgetStr('pose_prompt'),
  set: (v: string) => setWidget('pose_prompt', v),
})

const poseImageInIdx = computed(() => { const i = inputIdx('pose_image'); return i >= 0 ? i : 1 })
// Source of truth for "is a pose image wired" is VueFlow's live edge store, NOT
// data.inputs[i].link — that field is only populated when loading a saved
// workflow, so a freshly drawn edge would read as unconnected. The node has two
// target handles, so the handle id is required to disambiguate.
const poseImageConnections = useHandleConnections({
  type: 'target',
  id: () => `input-${poseImageInIdx.value}`,
})
const poseImageLinked = computed(() => poseImageConnections.value.length > 0)

const MODES: { id: PoseMode; label: string }[] = [
  { id: 'mannequin', label: 'Mannequin' },
  { id: 'image', label: 'Image' },
  { id: 'prompt', label: 'Prompt' },
]

// Image mode needs a wired pose image before it can generate; the other modes
// can always run (prompt falls back to a default pose, mannequin to passthrough).
const canGenerate = computed(() => !(poseSource.value === 'image' && !poseImageLinked.value))

// Header ▶ Run: ensure a downstream sink + scope-run this node (handled in
// VueNodeCanvas). Mirrors a regular node's run button.
function runThisNode() {
  if (isMuted.value || isBypassed.value || props.data.running || !canGenerate.value) return
  window.dispatchEvent(new CustomEvent('sailor:poseGenerate', { detail: { nodeId: props.id } }))
}
// Header ↻ Re-render: re-pose again for a fresh variation, reusing cached upstream.
function rerollThisNode() {
  if (isMuted.value || isBypassed.value || props.data.running || !canGenerate.value) return
  window.dispatchEvent(new CustomEvent('sailor:poseGenerate', { detail: { nodeId: props.id, rerollScope: 'self' } }))
}

const characterInIdx = computed(() => Math.max(0, inputIdx('character')))
const imageOutIdx = computed(() => outputIdx('image'))

function openEditor() {
  window.dispatchEvent(new CustomEvent('sailor:openPose', { detail: { nodeId: props.id } }))
}

/** Double-click anywhere opens the pose editor — but not while editing the prompt. */
function onCardDblclick(e: MouseEvent) {
  if (poseSource.value !== 'mannequin') return
  if (isStudioControl(e)) return
  openEditor()
}
</script>

<template>
  <div class="studio-node relative w-fit">
    <VueCanvasNodePort :id="`input-${characterInIdx}`" type="target" side="left"
      :data-type="data.inputs?.[characterInIdx]?.type ?? 'CHARACTER'" label="Character" :index="0" />
    <VueCanvasNodePort :id="`input-${poseImageInIdx}`" type="target" side="left"
      :data-type="data.inputs?.[poseImageInIdx]?.type ?? 'IMAGE'" label="Pose image" :index="1" />
    <VueCanvasNodePort :id="`output-${imageOutIdx}`" type="source" side="right"
      :data-type="data.outputs?.[imageOutIdx]?.type ?? 'IMAGE'" label="Image" :index="0" />

    <div
      class="pose-node node-shell relative z-10 w-[260px] select-none"
      :style="{ '--port-color': imageColor } as any"
      :data-running="data.running || undefined"
      :data-error="data.error || undefined"
      :data-glass-blur="glass || undefined"
      :data-selected="selected || undefined"
      @dblclick.stop="onCardDblclick"
    >
      <!-- Mode overlay: bypass shows diagonal stripes; mute shows a soft scrim -->
      <div
        v-if="isMuted || isBypassed"
        class="pointer-events-none absolute inset-0 rounded-[inherit] z-[5]"
        :class="isBypassed ? 'pose-node-stripes' : 'bg-black/30'"
      />
      <!-- Mode badge (top-right) -->
      <div
        v-if="isMuted || isBypassed"
        class="pointer-events-none absolute top-1.5 right-1.5 z-[6] text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full"
        :class="isBypassed
          ? 'bg-amber-500/25 text-amber-200 border border-amber-400/30'
          : 'bg-white/15 text-white/70 border border-white/15'"
      >
        {{ isBypassed ? 'Bypass' : 'Mute' }}
      </div>

      <div class="node-shell__head">
        <PersonStanding class="node-shell__icon" />
        <span class="node-shell__title">Pose Mannequin</span>
      </div>
      <div class="node-shell__body">
        <StudioSegmented
          class="nopan nodrag"
          :model-value="poseSource"
          :options="MODES.map(m => m.id)"
          :option-labels="MODES.map(m => m.label)"
          @update:model-value="setMode"
        />

        <!-- Mannequin: posed-figure preview -->
        <div v-if="poseSource === 'mannequin'" class="node-well node-openbar-host bg-checker aspect-[3/4] flex items-center justify-center">
          <img v-if="mannequinUrl" :src="mannequinUrl" class="absolute inset-0 w-full h-full object-contain" draggable="false" />
          <div v-else class="flex flex-col items-center justify-center gap-1.5 text-white/35 pointer-events-none">
            <PersonStanding class="size-8" :stroke-width="1.5" />
            <span class="text-[10px]">No pose yet</span>
          </div>
          <NodeOpenBar>
            <button type="button" class="node-btn nopan nodrag" @click.stop="openEditor">Open</button>
          </NodeOpenBar>
        </div>

        <!-- Image: wired pose-reference status -->
        <div v-else-if="poseSource === 'image'" class="node-well bg-checker aspect-[3/4] flex flex-col items-center justify-center gap-1.5 text-center px-3">
          <Image class="size-8" :class="poseImageLinked ? 'text-white/70' : 'text-white/35'" :stroke-width="1.5" />
          <span class="text-[10px]" :class="poseImageLinked ? 'text-white/70' : 'text-white/35'">
            {{ poseImageLinked ? 'Pose image connected' : 'Wire a pose image →' }}
          </span>
          <span class="text-[9px] text-white/30 leading-tight">Connect any image to the lower-left port; its body pose is copied onto your character.</span>
        </div>

        <!-- Prompt: describe the pose -->
        <div v-else class="node-well bg-checker aspect-[3/4] p-2 flex flex-col">
          <textarea
            v-model="posePrompt"
            class="nopan nodrag flex-1 w-full resize-none bg-transparent text-[11px] text-white/85 p-2 leading-snug placeholder:text-white/30 focus:outline-none"
            placeholder="Describe the pose — e.g. 'sitting cross-legged, leaning back on both hands, looking up'"
            @pointerdown.stop @dblclick.stop
          />
        </div>
      </div>
      <div v-if="!isMuted && !isBypassed" class="node-shell__foot justify-end">
        <button
          type="button"
          class="nopan nodrag node-btn px-2 disabled:opacity-35 disabled:cursor-not-allowed"
          :disabled="data.running || !canGenerate"
          title="Re-render — a fresh pose reusing the same inputs"
          @click.stop="rerollThisNode"
        >
          <RefreshCw class="size-3" />
        </button>
        <button
          type="button"
          class="nopan nodrag node-btn node-btn--primary disabled:opacity-40 disabled:cursor-not-allowed"
          :disabled="data.running || !canGenerate"
          :title="data.running ? 'Running…' : !canGenerate ? 'Wire a pose image first' : 'Generate — re-pose the character'"
          @click.stop="runThisNode"
        >
          <Loader2 v-if="data.running" class="size-3 animate-spin" />
          <Play v-else class="size-2.5" fill="currentColor" />
          <span>Generate</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pose-node[data-running] { box-shadow: 0 0 0 2px var(--port-color, #fff), 0 4px 16px rgba(0, 0, 0, 0.4); }
/* Failed: the red edge it always had (Tailwind ring/border utilities don't reach a .node-shell). */
.pose-node[data-error] { border-color: #ef4444; box-shadow: 0 0 0 2px #ef4444, var(--node-shadow); }
.pose-node[data-error]::after { display: none; }
.pose-node-stripes {
  background-image: repeating-linear-gradient(45deg,
    rgba(245, 158, 11, 0.18) 0, rgba(245, 158, 11, 0.18) 6px,
    transparent 6px, transparent 12px);
}
.bg-checker {
  background-color: #141414;
  background-image:
    linear-gradient(45deg, #1c1c1c 25%, transparent 25%),
    linear-gradient(-45deg, #1c1c1c 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #1c1c1c 75%),
    linear-gradient(-45deg, transparent 75%, #1c1c1c 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
}
</style>
