<script setup lang="ts">
// Lip-Sync Studio — canvas card. Mirrors ShotDirectorNode: compact summary
// card + an Open button that dispatches the surface-open event. No baker
// (nothing renders on this card) and no Generate button yet (Task 6).
import { computed } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import { AudioLines, Pencil } from 'lucide-vue-next'
import { hydrateLipSyncSheet } from '~/lib/lipsync/hydrate'
import { compileLipSync, resolveEngine } from '~/lib/lipsync/compile'

const props = defineProps<{
  id: string
  data: {
    nodeType: string
    title?: string
    properties?: Record<string, any>
    lipSyncError?: string | null
  }
}>()

const sheet = computed(() => hydrateLipSyncSheet(props.data?.properties?.sailor_lipSync))
const compiled = computed(() => compileLipSync(sheet.value))
const engineLabel = computed(() => resolveEngine(sheet.value) === 'sync' ? 'Sync' : 'Fabric')

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

    <!-- Header -->
    <div class="flex items-center gap-2 border-b border-white/10 px-3 py-2">
      <AudioLines class="h-3.5 w-3.5 text-white/70" />
      <span class="text-xs font-medium text-white/80">Lip-Sync Studio</span>
    </div>

    <!-- Summary body -->
    <div class="space-y-2 px-3 py-2.5">
      <!-- Engine chip -->
      <div class="flex items-center gap-1.5">
        <span class="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] text-white/50 tracking-tight">
          {{ engineLabel }}
        </span>
        <span class="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] text-white/50 tracking-tight">
          {{ sheet.resolution }}
        </span>
      </div>

      <!-- Face / voice summary -->
      <div class="flex items-center gap-1.5">
        <span class="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-white/45">{{ faceLabel }}</span>
        <span class="text-[10px] text-white/25">·</span>
        <span class="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-white/45">{{ voiceLabel }}</span>
      </div>

      <!-- Status dot -->
      <div class="flex items-center gap-1.5">
        <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="statusDotClass" />
        <span class="text-[10px] text-white/40">{{ compiled.issues.length ? `${compiled.issues.length} issue${compiled.issues.length > 1 ? 's' : ''}` : 'Ready' }}</span>
      </div>
    </div>

    <!-- Generate error (silent failures otherwise: bad voice, missing widget) -->
    <div v-if="data?.lipSyncError" class="border-t border-white/10 px-2 pt-1.5 text-[10px] leading-tight text-red-400/90">
      {{ data.lipSyncError }}
    </div>

    <!-- Edit + Generate buttons -->
    <div class="flex gap-1.5 border-t border-white/10 p-2">
      <button
        class="flex flex-1 items-center justify-center gap-1.5 rounded bg-white/10 px-2.5 py-1.5 text-[11px] text-white/80 transition hover:bg-white/20"
        @click.stop="openEditor"
      >
        <Pencil class="h-3 w-3" /> Open
      </button>
      <button
        class="flex flex-1 items-center justify-center gap-1.5 rounded bg-action px-2.5 py-1.5 text-[11px] font-medium text-white transition enabled:hover:bg-action/85 disabled:cursor-not-allowed disabled:opacity-40"
        :disabled="hasError"
        title="Generate the lip-synced clip"
        @click.stop="generate"
      >
        Generate
      </button>
    </div>
  </div>
</template>
