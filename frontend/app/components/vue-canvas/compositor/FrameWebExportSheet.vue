<script setup lang="ts">
/** The Frame web export sheet. Says — before anything downloads — how big the file is, which
 *  fonts go inside it, what plays live, what is held as a still and what is left out. Pure view:
 *  the modal builds the snapshot and the file, and answers `download` / `copy`. */
import { fitRect } from '~/lib/embed/frame/fit'
import { formatBytes } from '~/lib/embed/frame/gather'
import type { FrameFit, FrameNotice, FrameNoticeGroup } from '~/lib/embed/frame/types'

const props = defineProps<{
  state: 'working' | 'ready' | 'blocked' | 'error'
  notices: FrameNotice[]
  bytes: number
  fit: FrameFit
  transparentAllowed: boolean
  transparent: boolean
  still: boolean
  artAspect: number
  errorText?: string
  /** After Copy embed code: 'copied' for a moment, or 'failed' when the clipboard refused —
   *  then `snippet` is shown so it can be copied by hand. */
  copyStatus?: 'copied' | 'failed' | null
  snippet?: string
}>()
const emit = defineEmits<{
  'update:fit': [fit: FrameFit]
  'update:transparent': [on: boolean]
  download: []
  copy: []
  close: []
}>()

const BOX = { w: 220, h: 150 }
const FIT_HINT: Record<FrameFit, string> = {
  fit: 'Whole Frame stays visible. The background stretches to the edges of the box.',
  fill: 'Frame covers the whole box. The edges get cropped.',
}
const FIT_OPTIONS: { value: FrameFit; label: string }[] = [
  { value: 'fit', label: 'Fit' },
  { value: 'fill', label: 'Fill' },
]

const artRect = computed(() => {
  const a = Number.isFinite(props.artAspect) && props.artAspect > 0 ? props.artAspect : 1
  const r = fitRect(BOX, { w: a, h: 1 }, props.fit)
  return { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` }
})

const byGroup = (g: FrameNoticeGroup) => props.notices.filter(n => n.group === g)
const groups = computed(() => {
  const out: { key: FrameNoticeGroup; title: string; items: FrameNotice[] }[] = [
    { key: 'fonts', title: 'Fonts going into the file', items: byGroup('fonts') },
  ]
  if (!props.still) {
    out.push({ key: 'live', title: 'Plays live', items: byGroup('live') })
    out.push({ key: 'still', title: 'Will be a still', items: byGroup('still') })
  }
  out.push({ key: 'leftOut', title: 'Left out', items: byGroup('leftOut') })
  return out.filter(g => g.items.length > 0)
})
const blocked = computed(() => byGroup('blocked'))
</script>

<template>
  <div
    data-testid="frame-web-export-sheet"
    role="dialog" aria-label="Web export"
    class="absolute bottom-[120px] right-4 w-[640px] max-w-[calc(100%-32px)] z-[60] bg-[#161616] border border-white/10 rounded-lg shadow-2xl text-white/85"
    @pointerdown.stop>
    <div class="flex items-center gap-3 px-4 pt-3 pb-2 border-b border-white/10">
      <span class="text-[13px] font-medium text-white">Web export</span>
      <span v-if="state === 'ready'" class="ml-auto text-[11px] text-white/55 tabular-nums" data-testid="frame-web-export-size">
        One file · plays anywhere · {{ formatBytes(bytes) }}
      </span>
    </div>

    <div class="flex flex-wrap gap-4 p-4">
      <!-- Left: how the Frame sits in the page's box -->
      <div class="w-[220px] shrink-0 flex flex-col gap-2">
        <div class="relative overflow-hidden rounded bg-white/[0.04] border border-white/[0.06]" :style="{ width: `${BOX.w}px`, height: `${BOX.h}px` }">
          <div class="absolute grid place-items-center border border-dashed border-white/50 bg-white/[0.06] text-[11px] text-white/60" :style="artRect">
            Your Frame
          </div>
        </div>
        <div class="flex gap-1">
          <button
            v-for="o in FIT_OPTIONS" :key="o.value" type="button"
            class="flex-1 bg-white/[0.04] border border-white/[0.06] rounded py-1 text-[11px] cursor-pointer"
            :class="fit === o.value ? 'text-yellow-400 border-yellow-400/50' : 'text-white/60 hover:text-white/85'"
            :aria-pressed="fit === o.value"
            @click="fit !== o.value && emit('update:fit', o.value)">{{ o.label }}</button>
        </div>
        <p class="text-[11px] leading-snug text-white/50" data-testid="frame-web-export-fit-hint">{{ FIT_HINT[fit] }}</p>
        <label class="flex items-center gap-2 text-[12px]" :class="transparentAllowed ? 'text-white/80 cursor-pointer' : 'text-white/35'">
          <input
            type="checkbox" class="accent-white/80"
            :checked="transparent && transparentAllowed" :disabled="!transparentAllowed"
            @change="emit('update:transparent', ($event.target as HTMLInputElement).checked)">
          Transparent background
        </label>
        <p v-if="!transparentAllowed" class="-mt-1 text-[11px] text-white/40">This Frame has a background</p>
      </div>

      <!-- Right: what goes in the file -->
      <div class="flex-1 min-w-[240px] flex flex-col gap-3 max-h-[260px] overflow-y-auto">
        <p v-if="state === 'working'" class="text-[12px] text-white/55">Working out what goes in the file…</p>
        <p v-else-if="state === 'error'" class="text-[12px] text-rose-400">{{ errorText }}</p>
        <template v-else>
          <p v-if="still" class="text-[12px] text-white/70">This Frame doesn't move. The export will be a single sharp image that scales to any size.</p>
          <section v-for="g in groups" :key="g.key" :data-testid="`frame-web-export-group-${g.key}`">
            <h4 class="mb-1 text-[11px] font-medium text-white/45">{{ g.title }}</h4>
            <ul class="flex flex-col gap-0.5">
              <li v-for="(n, i) in g.items" :key="i" class="text-[12px] text-white/80">{{ n.text }}</li>
            </ul>
          </section>
          <section v-if="blocked.length" data-testid="frame-web-export-group-blocked">
            <h4 class="mb-1 text-[11px] font-medium text-rose-400">Can't export yet</h4>
            <ul class="flex flex-col gap-0.5">
              <li v-for="(n, i) in blocked" :key="i" class="text-[12px] text-rose-400">{{ n.text }}</li>
            </ul>
          </section>
        </template>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-2 px-4 py-3 border-t border-white/10">
      <span class="text-[11px] text-white/45">Upload this file to your site, then embed it</span>
      <button
        type="button"
        class="h-8 px-3 rounded text-[12px] font-medium flex items-center gap-1.5 cursor-pointer disabled:opacity-50 bg-white/[0.06] hover:bg-white/12 text-white/85"
        data-testid="frame-web-export-copy"
        :disabled="state !== 'ready'"
        @click="emit('copy')">Copy embed code</button>
      <span v-if="copyStatus === 'copied'" class="text-[11px] text-white/60" role="status" data-testid="frame-web-export-copied">Copied</span>
      <span class="flex-1" />
      <button
        type="button"
        class="h-8 px-3 rounded text-[12px] font-medium flex items-center gap-1.5 cursor-pointer disabled:opacity-50 bg-white/[0.06] hover:bg-white/12 text-white/85"
        @click="emit('close')">Cancel</button>
      <button
        type="button"
        class="h-8 px-3 rounded text-[12px] font-medium flex items-center gap-1.5 cursor-pointer disabled:opacity-50 bg-white hover:bg-white/90 text-neutral-900"
        data-testid="frame-web-export-download"
        :disabled="state !== 'ready'"
        @click="emit('download')">Download</button>
    </div>
    <div v-if="copyStatus === 'failed'" class="px-4 pb-3 -mt-1 flex flex-col gap-1.5" data-testid="frame-web-export-copy-failed">
      <p class="text-[11px] text-rose-400" role="status">Couldn't copy. Select the code below and copy it by hand.</p>
      <textarea
        readonly rows="2" :value="snippet" aria-label="Embed code"
        class="w-full resize-none rounded bg-white/[0.04] border border-white/[0.08] px-2 py-1 font-mono text-[11px] text-white/80"
        @focus="($event.target as HTMLTextAreaElement).select()" />
    </div>
  </div>
</template>
