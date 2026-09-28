<script setup lang="ts">
// Lip-Sync Studio — canvas card. Mirrors ShotDirectorNode: compact summary
// card + an Open button that dispatches the surface-open event.
import { computed } from 'vue'
import { AudioLines, Play } from 'lucide-vue-next'
import { hydrateLipSyncSheet } from '~/lib/lipsync/hydrate'
import { compileLipSync, engineLabel as labelOf, resolveEngine } from '~/lib/lipsync/compile'
import { useNodeGlass } from '~/composables/useCanvasGlass'
import { isStudioControl } from '~/lib/canvas/studioDblclick'
import NodeOpenBar from '~/components/vue-canvas/surfaces/NodeOpenBar.vue'

const props = defineProps<{
  id: string
  selected?: boolean
  data: {
    nodeType: string
    title?: string
    properties?: Record<string, any>
    lipSyncError?: string | null
    inputs?: { type: string }[]
    outputs?: { type: string }[]
  }
}>()

const glass = useNodeGlass(() => props.id)

const sheet = computed(() => hydrateLipSyncSheet(props.data?.properties?.sailor_lipSync))
const compiled = computed(() => compileLipSync(sheet.value))
const engineLabel = computed(() => labelOf(resolveEngine(sheet.value)))

const faceLabel = computed(() => {
  const f = sheet.value.face
  if (!f.src) return 'No face'
  if (f.kind === 'character') return 'Character'
  if (f.kind === 'video') return 'Video'
  return 'Image'
})

const voiceLabel = computed(() => {
  const v = sheet.value.voice
  if (v.kind === 'tts') return v.text?.trim() ? 'Type to speak' : 'No voice'
  return v.src ? 'Audio clip' : 'No voice'
})

const statusDotClass = computed(() => {
  if (compiled.value.issues.some(i => i.level === 'error')) return 'bg-red-400'
  if (compiled.value.issues.some(i => i.level === 'warning')) return 'bg-amber-400'
  return 'bg-emerald-400'
})

function openEditor() {
  window.dispatchEvent(new CustomEvent('sailor:openLipSync', { detail: { nodeId: props.id } }))
}

const hasError = computed(() => compiled.value.issues.some(i => i.level === 'error'))
function generate() {
  if (hasError.value) return
  window.dispatchEvent(new CustomEvent('sailor:lipSyncGenerate', { detail: { sourceNodeId: props.id } }))
}
</script>

<template>
  <div class="studio-node relative w-fit">
    <VueCanvasNodePort
      id="output-0" type="source" side="right"
      :data-type="data.outputs?.[0]?.type ?? '*'" label="Lip-sync" :index="0"
    />
    <div
      class="lip-sync-card node-shell relative z-10 w-[240px]"
      :data-glass-blur="glass || undefined"
      :data-selected="selected || undefined"
      @dblclick.stop="(e) => { if (!isStudioControl(e)) openEditor() }"
    >
      <div class="node-shell__head">
        <AudioLines class="node-shell__icon" />
        <span class="node-shell__title">Lip-Sync Studio</span>
      </div>
      <div class="node-shell__body">
        <div class="node-well node-openbar-host min-h-[92px] px-3 py-2.5 flex flex-col gap-1.5">
          <div class="flex items-center gap-1.5">
            <span class="text-[12px] text-white/75">{{ faceLabel }}</span>
            <span class="text-[10px] text-white/25">·</span>
            <span class="text-[12px] text-white/75">{{ voiceLabel }}</span>
          </div>
          <NodeOpenBar :meta="`${engineLabel} · ${sheet.resolution}`">
            <button type="button" class="node-btn nopan nodrag" @click.stop="openEditor">Open</button>
          </NodeOpenBar>
        </div>
      </div>
      <p v-if="data?.lipSyncError" class="px-3.5 pb-2 text-[11px] leading-tight text-red-400/90">{{ data.lipSyncError }}</p>
      <div class="node-shell__foot">
        <span class="shrink-0 size-1.5 rounded-full" :class="statusDotClass" aria-hidden="true" />
        <span class="flex-1 min-w-0 truncate text-[12px] text-white/55">{{ compiled.issues.length ? `${compiled.issues.length} issue${compiled.issues.length > 1 ? 's' : ''}` : 'Ready' }}</span>
        <button
          type="button"
          class="nopan nodrag node-btn node-btn--primary disabled:opacity-40 disabled:cursor-not-allowed"
          :disabled="hasError"
          title="Generate the lip-synced clip"
          @click.stop="generate"
        >
          <Play class="size-2.5" fill="currentColor" />
          <span>Generate</span>
        </button>
      </div>
    </div>
  </div>
</template>
