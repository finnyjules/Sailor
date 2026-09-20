<script setup lang="ts">
// Shot Director — canvas card. Mirrors TextureStudioNode pattern:
// compact summary with live-compiled word count, baker registration, Edit event.
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import { Clapperboard, Pencil } from 'lucide-vue-next'
import { hydrateShotSheet } from '~/lib/shotdirector/hydrate'
import { compileShot } from '~/lib/shotdirector/compile'
import { getProfile } from '~/lib/shotdirector/profiles'
import { registerStudioBaker, unregisterStudioBaker } from '~/lib/studio/cascade'
import { useCharacters } from '~/composables/useCharacters'

const props = defineProps<{
  id: string
  data: {
    nodeType: string
    title?: string
    properties?: Record<string, any>
    studioBusy?: boolean
    shotError?: string | null
  }
}>()

const profile = getProfile('seedance-2.0')
const { stateDescriptors } = useCharacters()

const config = computed(() => hydrateShotSheet(props.data?.properties?.sailor_shotDirector))

const compiled = computed(() => {
  const castDescriptors = stateDescriptors(config.value.cast.map(m => ({ slug: m.slug, stateId: m.stateId })))
  return compileShot(config.value, profile, { castDescriptors })
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
  <div
    class="studio-node relative w-[220px] overflow-hidden rounded-xl border border-white/10 bg-neutral-900 text-white shadow-lg"
    @dblclick.stop="openEditor"
  >
    <!-- Output handle -->
    <Handle
      id="output-0" type="source" :position="Position.Right"
      class="!h-3 !w-3 !rounded-full !border-2 !border-white/30 !bg-[#1a1a1a]"
      :style="{ top: '50%' }"
    />

    <!-- Cast input handles (CHARACTER) — plain handles without text labels -->
    <Handle
      v-for="i in 3" :key="i"
      :id="`input-${i - 1}`"
      type="target"
      :position="Position.Left"
      class="!h-3 !w-3 !rounded-full !border-2 !border-white/30 !bg-[#1a1a1a]"
      :style="{ top: `${38 + (i - 1) * 18}px` }"
      :title="`Cast ${i}`"
    />

    <!-- Header -->
    <div class="flex items-center gap-2 border-b border-white/10 px-3 py-2">
      <Clapperboard class="h-3.5 w-3.5 text-white/70" />
      <span class="text-xs font-medium text-white/80">Shot Director</span>
    </div>

    <!-- Summary body -->
    <div class="space-y-2 px-3 py-2.5">
      <!-- Model chip -->
      <div class="flex items-center gap-1.5">
        <span class="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] text-white/50 tracking-tight">
          Seedance 2.0
        </span>
      </div>

      <!-- Subject line -->
      <p class="truncate text-[11px] text-white/80" :title="subject">{{ subject }}</p>

      <!-- Reference count chips -->
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

      <!-- Word count + status dot -->
      <div class="flex items-center gap-1.5">
        <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="wordDotClass" />
        <span class="text-[10px] text-white/40">{{ compiled.wordCount }} words</span>
      </div>
    </div>

    <!-- Edit + Generate buttons -->
    <div class="flex gap-1.5 border-t border-white/10 p-2">
      <button
        class="flex flex-1 items-center justify-center gap-1.5 rounded bg-white/10 px-2.5 py-1.5 text-[11px] text-white/80 transition hover:bg-white/20"
        @click.stop="openEditor"
      >
        <Pencil class="h-3 w-3" /> Edit
      </button>
      <button
        class="rounded bg-action/15 px-2 py-1 text-[11px] font-medium text-action hover:bg-action/25"
        title="Compile the shot and run Seedance"
        @click.stop="generate"
      >
        Generate
      </button>
    </div>

    <div v-if="data?.shotError" class="px-2 pb-1.5 text-[10px] leading-tight text-red-400/90">
      {{ data.shotError }}
    </div>
  </div>
</template>
