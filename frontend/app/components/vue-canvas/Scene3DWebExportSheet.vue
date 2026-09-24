<script lang="ts">
import type { AssetFailure, AssetKind } from '~/lib/scene3d/assetTracker'

/** What a person calls each kind of asset. */
const KIND_LABEL: Record<AssetKind, string> = {
  model: 'Model', font: 'Font', mesh: 'Shape', hdri: 'Lighting', texture: 'Image',
  decal: 'Sticker', restyle: 'Restyle', shader: 'Shader effect',
}
// Only a real file extension is dropped, so a plain object name like "Robot v1.2" keeps its dot.
const FILE_EXT = /\.(glb|gltf|bin|ttf|otf|woff2?|json|svg|png|jpe?g|webp|avif|gif|hdr|exr|ktx2)$/i

/** An asset name as a person recognises it: a path or URL becomes its file name (a `/view`
 *  URL's `filename`), without the extension; a texture-library id loses its prefix. */
export function assetDisplayName(name: string): string {
  let n = name.trim().replace(/^ambientcg:/i, '')
  const q = n.match(/[?&]filename=([^&#]+)/)
  if (q) n = decodeURIComponent(q[1]!)
  else if (n.includes('/')) n = n.replace(/[?#].*$/, '').split('/').filter(Boolean).pop() ?? n
  return n.replace(FILE_EXT, '') || name
}

/** The plain sentence for one asset that stopped the export. */
export function failureSentence(f: AssetFailure): string {
  const label = KIND_LABEL[f.kind] ?? 'Something'
  const name = assetDisplayName(f.name)
  // A name that is only the kind again ("Shader effects") reads as the subject on its own.
  const subject = name.toLowerCase().startsWith(label.toLowerCase()) ? name : `${label} "${name}"`
  return `${subject} couldn't load.${f.kind === 'model' ? ' Re-generate or re-upload it.' : ''}`
}
</script>

<script setup lang="ts">
/** 3D Studio's Export embed sheet. Pure view: the surface bakes the frames and builds the one
 *  HTML file; this shows the options, the progress, what stops the export, and answers
 *  `build` / `cancel` / `download` / `copy`. The same family as the Frame's web export sheet. */
import { computed } from 'vue'
import { formatBytes } from '~/lib/embed/frame/gather'
import StudioSegmentedRow from '~/components/vue-canvas/studio/StudioSegmentedRow.vue'
import StudioSwitch from '~/components/vue-canvas/studio/StudioSwitch.vue'
import StudioButton from '~/components/vue-canvas/studio/StudioButton.vue'

const props = defineProps<{
  state: 'idle' | 'working' | 'ready' | 'blocked' | 'error'
  progress?: { done: number; total: number } | null
  size: 'output' | 'sharp'
  fps: 24 | 30
  cinematic: boolean
  transparent: boolean
  still: boolean
  bytes: number
  failures: AssetFailure[]
  cinematicWarning?: string
  outputSize: { width: number; height: number }
  errorText?: string
  /** After Copy embed code: 'copied' for a moment, or 'failed' when the clipboard refused —
   *  then `snippet` is shown so it can be copied by hand. */
  copyStatus?: 'copied' | 'failed' | null
  snippet?: string
}>()
const emit = defineEmits<{
  'update:size': [size: 'output' | 'sharp']
  'update:fps': [fps: 24 | 30]
  'update:cinematic': [on: boolean]
  'update:transparent': [on: boolean]
  build: []
  cancel: []
  download: []
  copy: []
  close: []
}>()

const sizeLabels = computed(() => {
  const { width: w, height: h } = props.outputSize
  return [`Output · ${w}×${h}`, `2× sharp · ${w * 2}×${h * 2}`]
})
const working = computed(() => props.state === 'working')
const lines = computed(() => props.failures.map(f => ({ text: failureSentence(f), reason: f.reason })))
</script>

<template>
  <div
    data-testid="scene3d-web-export-sheet"
    role="dialog" aria-label="Export embed"
    class="absolute bottom-4 right-4 w-[640px] max-w-[calc(100%-32px)] z-[60] bg-[#161616] border border-white/10 rounded-lg shadow-2xl text-white/85"
    @pointerdown.stop>
    <div class="flex items-center gap-3 px-4 pt-3 pb-2 border-b border-white/10">
      <span class="text-[13px] font-medium text-white">Export embed</span>
      <span v-if="state === 'ready'" class="ml-auto text-[11px] text-white/55 tabular-nums" data-testid="scene3d-web-export-size">
        One file · plays anywhere · {{ formatBytes(bytes) }}
      </span>
    </div>

    <div class="flex flex-wrap gap-4 p-4">
      <!-- Left: how the file is made -->
      <div class="w-[300px] shrink-0 flex flex-col gap-2" :class="working ? 'pointer-events-none opacity-50' : ''">
        <StudioSegmentedRow
          label="Size" :options="['output', 'sharp']" :option-labels="sizeLabels"
          :model-value="size" @update:model-value="(v: string) => emit('update:size', v as 'output' | 'sharp')" />
        <p class="text-[11px] leading-snug text-white/50">Sharp looks crisper on high-resolution screens and makes the file about four times bigger.</p>
        <StudioSegmentedRow
          label="Frame rate" :options="['30', '24']" :option-labels="['30 fps', '24 fps']"
          :model-value="String(fps)" @update:model-value="(v: string) => emit('update:fps', Number(v) as 24 | 30)" />
        <StudioSwitch label="Cinematic" :model-value="cinematic" @update:model-value="(v: boolean) => emit('update:cinematic', v)" />
        <p class="-mt-1 text-[11px] leading-snug text-white/50">Path-traced, like the Cinematic view. Much slower to export.</p>
        <p v-if="cinematic && cinematicWarning" class="text-[11px] leading-snug text-amber-200/90" data-testid="scene3d-web-export-cinematic-warning">{{ cinematicWarning }}</p>
        <StudioSwitch label="Transparent background" :model-value="transparent" @update:model-value="(v: boolean) => emit('update:transparent', v)" />
      </div>

      <!-- Right: what is happening, and what stops the file -->
      <div class="flex-1 min-w-[240px] flex flex-col gap-3 max-h-[260px] overflow-y-auto">
        <p v-if="still" class="text-[12px] text-white/70">This scene doesn't move, so it exports as a single picture.</p>
        <p v-if="working" class="text-[12px] text-white/55 tabular-nums" role="status">
          {{ progress ? `Rendering frame ${progress.done} of ${progress.total}` : 'Getting the scene ready…' }}
        </p>
        <p v-else-if="state === 'idle'" class="text-[12px] text-white/55">Render the scene to make the file.</p>
        <p v-else-if="state === 'error'" class="text-[12px] text-rose-400">{{ errorText }}</p>
        <section v-if="lines.length" data-testid="scene3d-web-export-blocked">
          <h4 class="mb-1 text-[11px] font-medium text-rose-400">Can't export yet</h4>
          <ul class="flex flex-col gap-1">
            <li v-for="(l, i) in lines" :key="i" class="text-[12px] text-rose-400">
              {{ l.text }}
              <span class="block text-[11px] text-white/40 break-words">{{ l.reason }}</span>
            </li>
          </ul>
        </section>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-2 px-4 py-3 border-t border-white/10">
      <span class="text-[11px] text-white/45">Upload this file to your site, then embed it</span>
      <StudioButton data-testid="scene3d-web-export-copy" :disabled="state !== 'ready'" @click="emit('copy')">Copy embed code</StudioButton>
      <span v-if="copyStatus === 'copied'" class="text-[11px] text-white/60" role="status" data-testid="scene3d-web-export-copied">Copied</span>
      <span class="flex-1" />
      <StudioButton data-testid="scene3d-web-export-close" @click="emit('close')">Close</StudioButton>
      <StudioButton v-if="working" data-testid="scene3d-web-export-cancel" @click="emit('cancel')">Cancel</StudioButton>
      <StudioButton v-else-if="state !== 'ready'" variant="neutral" data-testid="scene3d-web-export-render" @click="emit('build')">{{ state === 'idle' ? 'Render' : 'Try again' }}</StudioButton>
      <StudioButton variant="neutral" data-testid="scene3d-web-export-download" :disabled="state !== 'ready'" @click="emit('download')">Download</StudioButton>
    </div>
    <div v-if="copyStatus === 'failed'" class="px-4 pb-3 -mt-1 flex flex-col gap-1.5" data-testid="scene3d-web-export-copy-failed">
      <p class="text-[11px] text-rose-400" role="status">Couldn't copy. Select the code below and copy it by hand.</p>
      <textarea
        readonly rows="2" :value="snippet" aria-label="Embed code"
        class="w-full resize-none rounded bg-white/[0.04] border border-white/[0.08] px-2 py-1 font-mono text-[11px] text-white/80"
        @focus="($event.target as HTMLTextAreaElement).select()" />
    </div>
  </div>
</template>
