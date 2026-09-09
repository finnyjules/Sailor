<script setup lang="ts">
/**
 * Auto Subtitle app — drop a video, get it back with burned-in captions.
 * Pipeline: LoadVideo → GetVideoComponents → WhisperTranscribe → CaptionTrack
 *           → CreateVideo (audio re-attached) → SaveVideo.
 */
import { ArrowRight, Download, Loader2, RefreshCcw } from 'lucide-vue-next'
import TakesStrip from '~/components/vue-canvas/TakesStrip.vue'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'

interface UploadedFile { file: File; filename: string; previewUrl: string }

const video = ref<UploadedFile | null>(null)
const status = ref<'idle' | 'running' | 'done' | 'error'>('idle')
const errorMessage = ref<string | null>(null)
const progressLabel = ref('')
// Each run stacks as a take; the displayed result is the active take.
const { takes, activeTakeId, activeTake, addTake, selectTake, pinTake, discardTake, reset: resetTakes } = useAppTakes()
const outputUrl = computed<string | null>(() => activeTake.value?.videos?.[0] ?? null)

// User-facing knobs
const language = ref<'auto' | 'en' | 'fr' | 'es' | 'de' | 'ja' | 'zh' | 'pt' | 'it' | 'ko'>('auto')
const position = ref<'bottom' | 'middle' | 'top'>('bottom')
const fontSize = ref(44)

const canRun = computed(() => !!video.value && status.value !== 'running')

function buildPrompt(filename: string) {
  return {
    '1': { class_type: 'LoadVideo', inputs: { file: filename } },
    '2': { class_type: 'GetVideoComponents', inputs: { video: ['1', 0] } },
    '3': {
      class_type: 'WhisperTranscribe',
      inputs: {
        audio: ['2', 1],
        model_size: 'base',
        language: language.value,
        fps: ['2', 2],
      },
    },
    '4': {
      class_type: 'CaptionTrack',
      inputs: {
        frames: ['2', 0],
        captions: ['3', 0],
        font_size: fontSize.value,
        color: '#ffffff',
        outline_color: '#000000',
        outline_width: 3,
        position: position.value,
        y_inset: 0.08,
      },
    },
    '5': {
      class_type: 'CreateVideo',
      inputs: { images: ['4', 0], fps: ['2', 2], audio: ['2', 1] },
    },
    '6': {
      class_type: 'SaveVideo',
      inputs: {
        video: ['5', 0],
        filename_prefix: 'auto_subtitle',
        format: 'auto',
        codec: 'auto',
      },
    },
  }
}

function viewUrl(f: { filename: string; subfolder: string; type: string }): string {
  return `/view?${new URLSearchParams({
    filename: f.filename,
    type: f.type,
    ...(f.subfolder ? { subfolder: f.subfolder } : {}),
    t: String(Date.now()),
  })}`
}

async function run() {
  if (!canRun.value || !video.value) return
  errorMessage.value = null
  status.value = 'running'
  progressLabel.value = 'Submitting…'

  try {
    const res = await fetch('/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: buildPrompt(video.value.filename) }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(text || `Comfy returned ${res.status}`)
    }
    const data = await res.json()
    const promptId: string | undefined = data?.prompt_id
    if (!promptId) throw new Error('No prompt_id returned — is ComfyUI running?')

    progressLabel.value = 'Transcribing speech and burning captions (this can take a couple of minutes)…'
    const output = await pollForOutput(promptId)
    if (!output) throw new Error('Run finished but produced no output.')
    addTake({ videos: [viewUrl(output)], promptId, sig: `${output.subfolder || ''}/${output.filename}` })
    status.value = 'done'
  } catch (e: any) {
    errorMessage.value = humanizeError(e?.message ?? String(e))
    status.value = 'error'
  }
}

async function pollForOutput(promptId: string): Promise<{ filename: string; subfolder: string; type: string } | null> {
  const deadline = Date.now() + 30 * 60 * 1000  // 30 min — Whisper can be slow
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000))
    try {
      const r = await fetch(`/history/${promptId}`)
      if (!r.ok) continue
      const data = await r.json()
      const entry = data?.[promptId]
      if (!entry) continue
      if (entry?.status?.status_str === 'error') {
        throw new Error(extractComfyError(entry))
      }
      const outputs = entry?.outputs
      if (!outputs) continue
      // SaveVideo could emit under images / video / videos depending on Comfy version.
      for (const node of Object.values(outputs) as any[]) {
        for (const k of ['images', 'video', 'videos']) {
          const list = node?.[k]
          if (Array.isArray(list) && list.length > 0) return list[0]
        }
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Comfy:')) throw e
    }
  }
  throw new Error('Timed out waiting for the video to finish.')
}

function extractComfyError(entry: any): string {
  const messages: any[] = entry?.status?.messages ?? []
  const errMsg = messages.find((m) => m[0] === 'execution_error')?.[1]
  if (errMsg?.exception_message) return `Comfy: ${errMsg.exception_message}`
  return 'Comfy: execution failed.'
}

function humanizeError(msg: string): string {
  if (msg.includes('No prompt_id')) return "Couldn't reach the engine. Is ComfyUI running on port 8188?"
  if (msg.toLowerCase().includes('no audio') || msg.toLowerCase().includes('audio stream')) {
    return "Couldn't find an audio track in your video. Auto Subtitle needs spoken audio to transcribe."
  }
  if (msg.includes('whisper') || msg.includes('Whisper')) {
    return 'Speech recognition failed. The clip may be too quiet or contain no speech.'
  }
  return msg
}

function reset() {
  video.value = null
  resetTakes()
  errorMessage.value = null
  status.value = 'idle'
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
          Drop a video with speech, get it back with captions burned in. Whisper transcribes,
          captions burn in over the original frames, audio stays untouched.
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
        <p v-else-if="errorMessage" class="text-[12px] text-rose-400 max-w-md">
          {{ errorMessage }}
        </p>
        <span v-else class="text-[12px] text-white/35">
          {{ video ? 'Ready to transcribe.' : 'Add a video above to start.' }}
        </span>
        <button
          class="inline-flex items-center gap-2 h-10 px-5 rounded-full bg-white text-[#0a0a0a] font-medium text-[13px] hover:bg-white/90 transition-colors cursor-pointer disabled:bg-white/15 disabled:text-white/40 disabled:cursor-not-allowed"
          :disabled="!canRun"
          @click="run"
        >
          <span>{{ status === 'running' ? 'Working…' : 'Add captions' }}</span>
          <ArrowRight v-if="status !== 'running'" class="size-4" />
          <Loader2 v-else class="size-4 animate-spin" />
        </button>
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
            <div class="text-[12px] text-white/40 text-center px-6 max-w-md">{{ progressLabel || 'Working…' }}</div>
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
