<script setup lang="ts">
// Shot Director — canvas card. Mirrors TextureStudioNode pattern:
// compact summary with live-compiled word count, baker registration, Edit event.
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { Clapperboard, Play } from 'lucide-vue-next'
import { hydrateShotSheet } from '~/lib/shotdirector/hydrate'
import { compileShot } from '~/lib/shotdirector/compile'
import { sheetProfile } from '~/lib/shotdirector/prepare'
import { registerStudioBaker, unregisterStudioBaker } from '~/lib/studio/cascade'
import { useCharacters } from '~/composables/useCharacters'
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
    studioBusy?: boolean
    shotError?: string | null
    inputs?: { type: string }[]
    outputs?: { type: string }[]
  }
}>()

const glass = useNodeGlass(() => props.id)

const { stateDescriptors } = useCharacters()

const config = computed(() => hydrateShotSheet(props.data?.properties?.sailor_shotDirector))
const profile = computed(() => sheetProfile(config.value))

const compiled = computed(() => {
  const castDescriptors = stateDescriptors(config.value.cast.map(m => ({ slug: m.slug, stateId: m.stateId })))
  return compileShot(config.value, profile.value, { castDescriptors })
})

const subject = computed(() => config.value.subject.trim() || 'Untitled shot')

const refCounts = computed(() => {
  const refs = config.value.references
  const img = refs.filter(r => r.kind === 'image').length
  const vid = refs.filter(r => r.kind === 'video').length
  const aud = refs.filter(r => r.kind === 'audio').length
  return { img, vid, aud }
})

// Word count status: emerald ≤100, amber >100, red if word-budget-exceeded
const wordDotClass = computed(() => {
  const issues = compiled.value.issues
  if (issues.some(i => i.code === 'word-budget-exceeded')) return 'bg-red-400'
  if (compiled.value.wordCount > 100) return 'bg-amber-400'
  return 'bg-emerald-400'
})

async function bakeOutput(): Promise<Blob | null> {
  return null
}

onMounted(() => {
  registerStudioBaker(props.id, bakeOutput)
})
onBeforeUnmount(() => {
  unregisterStudioBaker(props.id)
})

function openEditor() {
  window.dispatchEvent(new CustomEvent('sailor:openShotDirector', { detail: { nodeId: props.id } }))
}

function generate() {
  window.dispatchEvent(new CustomEvent('sailor:shotDirectorGenerate', { detail: { sourceNodeId: props.id } }))
}
</script>

<template>
  <div class="studio-node relative w-fit">
    <VueCanvasNodePort
      v-for="i in 3" :key="i"
      :id="`input-${i - 1}`" type="target" side="left"
      :data-type="data.inputs?.[i - 1]?.type ?? 'CHARACTER'"
      :label="`Cast ${i}`" :index="i - 1"
    />
    <VueCanvasNodePort
      id="output-0" type="source" side="right"
      :data-type="data.outputs?.[0]?.type ?? '*'" label="Shot" :index="0"
    />
    <div
      class="shot-director-card node-shell relative z-10 w-[240px]"
      :data-glass-blur="glass || undefined"
      :data-selected="selected || undefined"
      @dblclick.stop="(e) => { if (!isStudioControl(e)) openEditor() }"
    >
      <div class="node-shell__head">
        <Clapperboard class="node-shell__icon" />
        <span class="node-shell__title">Shot Director</span>
      </div>
      <div class="node-shell__body">
        <div class="node-well node-openbar-host min-h-[92px] px-3 py-2.5 flex flex-col gap-2">
          <p class="text-[13px] leading-snug text-white/85 line-clamp-2">{{ subject }}</p>
          <div class="flex flex-wrap items-center gap-1">
            <span class="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-white/45">
              {{ refCounts.img }} img
            </span>
            <span class="text-[10px] text-white/25">·</span>
            <span class="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-white/45">
              {{ refCounts.vid }} vid
            </span>
            <span class="text-[10px] text-white/25">·</span>
            <span class="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-white/45">
              {{ refCounts.aud }} aud
            </span>
          </div>
          <NodeOpenBar :meta="profile.label">
            <button type="button" class="node-btn nopan nodrag" @click.stop="openEditor">Open</button>
          </NodeOpenBar>
        </div>
      </div>
      <p v-if="data?.shotError" class="px-3.5 pb-2 text-[11px] leading-tight text-red-400/90">{{ data.shotError }}</p>
      <div class="node-shell__foot">
        <span class="shrink-0 size-1.5 rounded-full" :class="wordDotClass" aria-hidden="true" />
        <span class="flex-1 min-w-0 truncate text-[12px] text-white/55">{{ compiled.wordCount }} words</span>
        <button
          type="button"
          class="nopan nodrag node-btn node-btn--primary"
          :title="`Compile the shot and run ${profile.label}`"
          @click.stop="generate"
        >
          <Play class="size-2.5" fill="currentColor" />
          <span>Generate</span>
        </button>
      </div>
    </div>
  </div>
</template>
