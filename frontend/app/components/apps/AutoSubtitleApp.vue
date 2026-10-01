<script setup lang="ts">
/**
 * Auto Subtitle app — drop a video, get it back with burned-in captions.
 * Pipeline: LoadVideo → GetVideoComponents → WhisperTranscribe → CaptionTrack
 *           → CreateVideo (audio re-attached) → SaveVideo, on the Sailor
 * runner with its price shown before the run and a Stop button (step 3,
 * R8.3; lib/runner/autoSubtitleApp.ts).
 */
import { ArrowRight, Download, Loader2, RefreshCcw, Square } from 'lucide-vue-next'
import TakesStrip from '~/components/vue-canvas/TakesStrip.vue'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'
import { useAutoSubtitleRun, type AutoSubtitleLanguage, type AutoSubtitlePosition } from '~/lib/runner/autoSubtitleApp'

interface UploadedFile { file: File; filename: string; previewUrl: string }

const video = ref<UploadedFile | null>(null)
// Each run stacks as a take; the displayed result is the active take.
const { takes, activeTakeId, activeTake, addTake, selectTake, pinTake, discardTake, reset: resetTakes } = useAppTakes()
const outputUrl = computed<string | null>(() => activeTake.value?.videos?.[0] ?? null)

// User-facing knobs
const language = ref<AutoSubtitleLanguage>('auto')
const position = ref<AutoSubtitlePosition>('bottom')
const fontSize = ref(44)

const hosted = useRuntimeConfig().public?.hostedMode === true
const subtitles = useAutoSubtitleRun({
  video,
  settings: () => ({ language: language.value, position: position.value, fontSize: fontSize.value }),
  addTake,
  hosted,
})
const { status, errorMessage, priceText, blocked, canRun, canStop, quoting, stopError } = subtitles
const run = subtitles.run
const stop = subtitles.stop
const progressLabel = 'Transcribing the speech and adding captions…'

// The price is worked out once the video is uploaded, and again for the exact settings.
watch(() => [video.value?.filename ?? null, language.value, position.value, fontSize.value], () => { void subtitles.quote() }, { immediate: true })

function reset() {
  video.value = null
  resetTakes()
  subtitles.reset()
}

function download() {
  if (!outputUrl.value || !video.value) return
  const a = document.createElement('a')
  a.href = outputUrl.value
  const base = video.value.file.name.replace(/\.[^.]+$/, '')
  a.download = `${base}_captioned.mp4`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}
</script>

<template>
  <div class="h-full overflow-y-auto bg-[#0a0a0a]">
    <div class="max-w-[920px] mx-auto px-10 py-12">
      <div class="mb-14">
        <div class="text-[11px] uppercase tracking-[0.16em] text-white/35 font-medium mb-3">
          App · Video
        </div>
        <h1 class="text-[44px] font-medium text-white tracking-tight leading-[1.05] mb-4">
          Auto Subtitle
        </h1>
        <p class="text-[15px] text-white/60 max-w-[560px] leading-relaxed">
          Drop a video with speech, get it back with captions burned in. The speech is transcribed,
          captions burn in over the original frames, and the sound stays untouched.
        </p>
      </div>

      <div class="grid grid-cols-[1fr_280px] gap-6 mb-8">
        <AppsAppFileSlot
          v-model="video"
          label="Video"
          step="Step 1"
          accept="video/*"
          kind="video"
          hint="Drop a video with speech"
        />

        <div class="flex flex-col gap-5">
          <div>
            <label class="text-[12px] font-medium text-white/85 mb-2 block">Language</label>
            <select
              v-model="language"
              class="w-full h-9 bg-[#18181b] border border-[#3f3f46] rounded text-[13px] text-white px-3 cursor-pointer focus:outline-none focus:border-[#525258]"
            >
              <option value="auto">Auto-detect</option>
              <option value="en">English</option>
              <option value="fr">French</option>
              <option value="es">Spanish</option>
              <option value="de">German</option>
              <option value="it">Italian</option>
              <option value="pt">Portuguese</option>
              <option value="ja">Japanese</option>
              <option value="ko">Korean</option>
              <option value="zh">Chinese</option>
            </select>
            <p class="text-[11px] text-white/35 mt-1.5 leading-relaxed">
              Auto is fine for most clips, but setting the language is faster and more accurate.
            </p>
          </div>

          <div>
            <label class="text-[12px] font-medium text-white/85 mb-2 block">Position</label>
            <div class="grid grid-cols-3 gap-1">
              <button
                v-for="p in (['top', 'middle', 'bottom'] as const)"
                :key="p"
                class="h-9 rounded text-[12px] transition-colors cursor-pointer"
                :class="position === p
                  ? 'bg-white/10 text-white'
                  : 'bg-white/[0.04] hover:bg-white/[0.08] text-white/55'"
                @click="position = p"
              >
                {{ p.charAt(0).toUpperCase() + p.slice(1) }}
              </button>
            </div>
          </div>

          <div>
            <StudioSlider v-model="fontSize" label="Font size" :min="20" :max="96" :step="2" :bindable="false" />
          </div>
        </div>
      </div>

      <div class="flex items-center justify-between mb-12">
        <p v-if="status === 'running'" class="text-[12px] text-white/55 flex items-center gap-2">
          <Loader2 class="size-3.5 animate-spin" />
          <span>{{ progressLabel }}</span>
        </p>
        <p v-else-if="errorMessage || stopError" class="text-[12px] text-rose-400 max-w-md">
          {{ stopError || errorMessage }}
        </p>
        <p v-else-if="video && blocked" class="text-[12px] text-rose-400 max-w-md">
          {{ blocked }}
        </p>
        <span v-else class="text-[12px] text-white/35">
          {{ video ? 'Ready to transcribe.' : 'Add a video above to start.' }}
        </span>
        <div class="flex items-center gap-3">
          <span v-if="status !== 'running' && video && (quoting || priceText)" class="text-[12px] text-white/55 tabular-nums" title="The most this run can cost">
            {{ quoting ? '…' : priceText }}
          </span>
          <button
            v-if="canStop"
            class="inline-flex items-center gap-2 h-10 px-5 rounded-full bg-white/[0.08] text-white font-medium text-[13px] hover:bg-white/[0.14] transition-colors cursor-pointer"
            @click="stop"
          >
            <Square class="size-3.5" />
            <span>Stop</span>
          </button>
          <button
            v-else
            class="inline-flex items-center gap-2 h-10 px-5 rounded-full bg-white text-[#0a0a0a] font-medium text-[13px] hover:bg-white/90 transition-colors cursor-pointer disabled:bg-white/15 disabled:text-white/40 disabled:cursor-not-allowed"
            :disabled="!canRun"
            @click="run"
          >
            <span>{{ status === 'running' ? 'Working…' : 'Add captions' }}</span>
            <ArrowRight v-if="status !== 'running'" class="size-4" />
            <Loader2 v-else class="size-4 animate-spin" />
          </button>
        </div>
      </div>

      <div v-if="outputUrl || status === 'running'" class="border-t border-white/[0.06] pt-10">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-[20px] font-medium text-white tracking-tight">Captioned video</h2>
          <div v-if="outputUrl" class="flex items-center gap-2">
            <button
              class="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-white/[0.06] hover:bg-white/[0.12] text-[12px] text-white/80 hover:text-white transition-colors cursor-pointer"
              @click="reset"
            >
              <RefreshCcw class="size-3.5" />
              Start over
            </button>
            <button
              class="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-action hover:bg-[#a8c2ff] text-[#0a0a0a] text-[12px] font-medium transition-colors cursor-pointer"
              @click="download"
            >
              <Download class="size-3.5" />
              Download
            </button>
          </div>
        </div>
        <div class="rounded-xl overflow-hidden bg-black border border-white/[0.06] min-h-[320px] flex items-center justify-center">
          <video
            v-if="outputUrl"
            :src="outputUrl"
            class="w-full max-h-[640px] object-contain"
            controls
            autoplay
            playsinline
          />
          <div v-else class="flex flex-col items-center gap-3 py-16">
            <Loader2 class="size-6 text-white/30 animate-spin" />
            <div class="text-[12px] text-white/40 text-center px-6 max-w-md">{{ progressLabel }}</div>
          </div>
        </div>
        <TakesStrip
          v-if="takes.length >= 1"
          :takes="takes"
          :active-take-id="activeTakeId"
          class="mt-3 rounded-lg bg-black/40 border border-white/10"
          @select="selectTake"
          @pin="pinTake"
          @discard="discardTake"
        />
      </div>
    </div>
  </div>
</template>
