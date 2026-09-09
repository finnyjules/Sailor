<script setup lang="ts">
/**
 * VoiceTrainerSurface — the "Train a voice" body, rendered inside the Train tab
 * (LoraTrainerSurface) when the kind is 'voice'. Unlike LoRA training this is a
 * single Replicate prediction: upload one sample → minimax/voice-cloning →
 * persist the cloned voice into models/voices so it shows in the Generate-speech
 * voice gallery under "Your voices".
 *
 * Renders sibling <section>s only (no outer container) — the Train tab provides
 * the page chrome.
 */
import { ref, reactive, computed, onBeforeUnmount } from 'vue'
import { Mic, Upload, Check, Loader2, AlertCircle, ChevronDown } from 'lucide-vue-next'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'
import { validateVoiceSample } from '~/lib/voiceSample'

const name = ref('')
const file = ref<File | null>(null)
const fileError = ref<string | null>(null)
const previewUrl = ref<string | null>(null)
const durationSec = ref<number | null>(null)
const dragging = ref(false)

const advanced = reactive({
  open: false,
  noiseReduction: false,
  volumeNormalization: false,
  accuracy: 0.7,
})

type JobStatus = 'idle' | 'uploading' | 'starting' | 'processing' | 'queued' | 'succeeded' | 'failed'
const job = reactive<{ status: JobStatus; error: string | null }>({ status: 'idle', error: null })
const busy = computed(() => job.status === 'uploading' || job.status === 'starting' || job.status === 'processing')
// Name of the last voice added to the queue, shown in the confirmation.
const queuedName = ref<string | null>(null)

const canSubmit = computed(() =>
  !!name.value.trim() && !!file.value && !fileError.value && !busy.value)

function revokePreview() {
  if (previewUrl.value) { URL.revokeObjectURL(previewUrl.value); previewUrl.value = null }
}

function readDuration(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const a = new Audio()
    a.preload = 'metadata'
    a.onloadedmetadata = () => resolve(Number.isFinite(a.duration) ? a.duration : null)
    a.onerror = () => resolve(null)
    a.src = url
  })
}

async function onPick(f: File | null | undefined) {
  if (!f) return
  revokePreview()
  durationSec.value = null
  const url = URL.createObjectURL(f)
  const dur = await readDuration(url)
  const v = validateVoiceSample({ name: f.name, size: f.size }, dur)
  if (!v.ok) {
    fileError.value = v.error ?? 'Invalid file.'
    file.value = null
    URL.revokeObjectURL(url)
    return
  }
  fileError.value = null
  durationSec.value = dur
  file.value = f
  previewUrl.value = url
  if (job.status === 'succeeded' || job.status === 'failed') { job.status = 'idle'; job.error = null }
}

function onDrop(e: DragEvent) {
  dragging.value = false
  onPick(e.dataTransfer?.files?.[0])
}
function onInput(e: Event) {
  onPick((e.target as HTMLInputElement).files?.[0])
}

const fmtDuration = computed(() => {
  const d = durationSec.value
  if (d == null) return ''
  const m = Math.floor(d / 60), s = Math.round(d % 60)
  return m ? `${m}m ${s}s` : `${s}s`
})

async function startClone() {
  if (!canSubmit.value) return
  job.status = 'uploading'
  job.error = null
  const displayName = name.value.trim()
  try {
    const fd = new FormData()
    fd.append('file', file.value!, file.value!.name)
    const up = await $fetch<{ url: string }>('/api/voice-clone/upload', { method: 'POST', body: fd })

    // Hand the clone to the durable server-side queue. It runs/polls/persists
    // independently, so closing this tab (or the whole app) no longer aborts it.
    job.status = 'starting'
    await $fetch('/api/training-queue', {
      method: 'POST',
      body: {
        kind: 'voice',
        datasetUrl: up.url,
        outputName: displayName,
        displayName,
        params: {
          accuracy: advanced.accuracy,
          needNoiseReduction: advanced.noiseReduction,
          needVolumeNormalization: advanced.volumeNormalization,
        },
      },
    })

    window.dispatchEvent(new CustomEvent('sailor:trainingQueueUpdated'))
    job.status = 'queued'
    queuedName.value = displayName
    // Reset for the next voice.
    revokePreview()
    file.value = null
    durationSec.value = null
    name.value = ''
  } catch (e: any) {
    job.status = 'failed'
    job.error = e?.data?.message || e?.message || 'Could not queue voice clone.'
  }
}

// ── Capture from a YouTube timestamp range (additive; independent of the file
// upload path). Grabs a [start,end] segment as the voice sample instead of an
// uploaded file, then feeds the same training queue. ────────────────────────
const ytUrl = ref('')
const ytStart = ref('')   // mm:ss or plain seconds
const ytEnd = ref('')
const ytRights = ref(false)

/** Parse "mm:ss" or a plain seconds number → seconds, else null. */
function parseTimeSec(s: string): number | null {
  const t = s.trim()
  if (!t) return null
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t)
  const m = t.match(/^(\d+):([0-5]?\d)$/)
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

const ytCanSubmit = computed(() => {
  const a = parseTimeSec(ytStart.value), b = parseTimeSec(ytEnd.value)
  return !!name.value.trim()
    && /^https?:\/\//.test(ytUrl.value.trim())
    && ytRights.value
    && a != null && b != null && (b - a) >= 10 && (b - a) <= 60
    && !busy.value
})

async function startYoutubeClone() {
  if (!ytCanSubmit.value) return
  const startSec = parseTimeSec(ytStart.value)!
  const endSec = parseTimeSec(ytEnd.value)!
  const displayName = name.value.trim()
  job.status = 'uploading'
  job.error = null
  try {
    const cap = await $fetch<{ voiceFileUrl: string }>('/api/voice-clone/from-youtube', {
      method: 'POST', body: { url: ytUrl.value.trim(), startSec, endSec },
    })
    job.status = 'starting'
    await $fetch('/api/training-queue', {
      method: 'POST',
      body: {
        kind: 'voice',
        datasetUrl: cap.voiceFileUrl,
        outputName: displayName,
        displayName,
        params: {
          accuracy: advanced.accuracy,
          needNoiseReduction: advanced.noiseReduction,
          needVolumeNormalization: advanced.volumeNormalization,
        },
      },
    })
    window.dispatchEvent(new CustomEvent('sailor:trainingQueueUpdated'))
    job.status = 'queued'
    queuedName.value = displayName
    ytUrl.value = ''; ytStart.value = ''; ytEnd.value = ''; ytRights.value = false; name.value = ''
  } catch (e: any) {
    job.status = 'failed'
    job.error = e?.data?.message || e?.message || 'Could not capture that YouTube segment.'
  }
}

onBeforeUnmount(revokePreview)
</script>

<template>
  <div>
    <!-- Name -->
    <section class="mb-8">
      <label class="block text-[12px] font-medium text-white/85 tracking-[0.01em] mb-2">Voice name</label>
      <input
        v-model="name"
        type="text"
        placeholder="e.g. My narrator voice"
        class="w-full bg-white/[0.04] border border-white/10 rounded-lg px-3 py-2.5 text-[13px] text-white/90 placeholder-white/30 outline-none focus:bg-white/[0.06] focus:border-white/25 transition-colors"
      />
      <p class="text-[11px] text-white/40 mt-2">How it appears in your voice gallery.</p>
    </section>

    <!-- Audio sample -->
    <section class="mb-8">
      <label class="block text-[12px] font-medium text-white/85 tracking-[0.01em] mb-2">Voice sample</label>
      <label
        class="block rounded-xl border border-dashed px-6 py-8 text-center cursor-pointer transition-colors"
        :class="dragging ? 'border-white/40 bg-white/[0.05]' : 'border-white/15 hover:border-white/25 hover:bg-white/[0.03]'"
        @dragover.prevent="dragging = true"
        @dragleave.prevent="dragging = false"
        @drop.prevent="onDrop"
      >
        <input type="file" accept=".mp3,.m4a,.wav,audio/*" class="hidden" @change="onInput" />
        <Upload class="size-6 mx-auto text-white/40 mb-2" />
        <div class="text-[13px] text-white/75">
          <span v-if="file">{{ file.name }}<span v-if="fmtDuration" class="text-white/45"> · {{ fmtDuration }}</span></span>
          <span v-else>Drop an audio file or click to choose</span>
        </div>
        <div class="text-[11px] text-white/40 mt-1">MP3, M4A or WAV · 10s–5min · under 20 MB</div>
      </label>

      <p v-if="fileError" class="flex items-center gap-1.5 text-[11.5px] text-rose-300/90 mt-2">
        <AlertCircle class="size-3.5 shrink-0" /> {{ fileError }}
      </p>

      <audio v-if="previewUrl && !fileError" :src="previewUrl" controls preload="metadata" class="w-full h-9 mt-3" />
    </section>

    <!-- Or: capture from a YouTube timestamp range -->
    <section class="mb-8">
      <div class="flex items-center gap-2 mb-2">
        <span class="h-px flex-1 bg-white/10" />
        <span class="text-[11px] uppercase tracking-wider text-white/35">or capture from YouTube</span>
        <span class="h-px flex-1 bg-white/10" />
      </div>
      <input
        v-model="ytUrl"
        type="url"
        placeholder="Paste a YouTube URL"
        class="w-full bg-white/[0.04] border border-white/10 rounded-lg px-3 py-2.5 text-[13px] text-white/90 placeholder-white/30 outline-none focus:bg-white/[0.06] focus:border-white/25 transition-colors"
      />
      <div class="flex items-center gap-2 mt-2">
        <input
          v-model="ytStart"
          type="text"
          inputmode="numeric"
          placeholder="Start (0:15)"
          class="w-1/2 bg-white/[0.04] border border-white/10 rounded-lg px-3 py-2 text-[13px] text-white/90 placeholder-white/30 outline-none focus:bg-white/[0.06] focus:border-white/25 transition-colors tabular-nums"
        />
        <input
          v-model="ytEnd"
          type="text"
          inputmode="numeric"
          placeholder="End (0:35)"
          class="w-1/2 bg-white/[0.04] border border-white/10 rounded-lg px-3 py-2 text-[13px] text-white/90 placeholder-white/30 outline-none focus:bg-white/[0.06] focus:border-white/25 transition-colors tabular-nums"
        />
      </div>
      <p class="text-[11px] text-white/40 mt-1.5">Pick 10–60s of clean speech of the voice — mm:ss or seconds.</p>
      <label class="flex items-start gap-2 mt-3 cursor-pointer">
        <input type="checkbox" v-model="ytRights" class="size-3.5 mt-0.5 rounded border-white/20 bg-white/[0.04] cursor-pointer accent-white" />
        <span class="text-[12px] text-white/70">I have the rights to clone this voice (my own content, a voice I’ve licensed, or public-domain audio).</span>
      </label>
      <button
        type="button"
        class="h-9 px-4 mt-3 rounded-lg text-[13px] font-medium transition-colors flex items-center gap-2"
        :class="ytCanSubmit
          ? 'bg-emerald-500/90 text-black hover:bg-emerald-400 cursor-pointer'
          : 'bg-white/[0.06] text-white/35 cursor-not-allowed'"
        :disabled="!ytCanSubmit"
        @click="startYoutubeClone"
      >
        <Loader2 v-if="busy" class="size-4 animate-spin" />
        <Mic v-else class="size-4" />
        {{ busy ? 'Capturing…' : 'Capture & add to queue' }}
      </button>
    </section>

    <!-- Advanced -->
    <section class="mb-8">
      <button
        type="button"
        class="flex items-center gap-1.5 text-[12px] font-medium text-white/65 hover:text-white/85 transition-colors cursor-pointer"
        @click="advanced.open = !advanced.open"
      >
        <ChevronDown class="size-3.5 transition-transform" :class="advanced.open ? '' : '-rotate-90'" />
        Advanced
      </button>
      <div v-if="advanced.open" class="mt-3 space-y-3 pl-1">
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" v-model="advanced.noiseReduction" class="size-3.5 rounded border-white/20 bg-white/[0.04] cursor-pointer accent-white" />
          <span class="text-[12px] text-white/70">Noise reduction — use if the sample has background noise</span>
        </label>
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" v-model="advanced.volumeNormalization" class="size-3.5 rounded border-white/20 bg-white/[0.04] cursor-pointer accent-white" />
          <span class="text-[12px] text-white/70">Volume normalization</span>
        </label>
        <div class="pt-1">
          <StudioSlider v-model="advanced.accuracy" label="Accuracy" :min="0" :max="1" :step="0.05" :bindable="false" />
        </div>
      </div>
    </section>

    <!-- Submit + job state -->
    <section class="mb-10">
      <button
        type="button"
        class="h-10 px-5 rounded-lg text-[13px] font-medium transition-colors flex items-center gap-2"
        :class="canSubmit
          ? 'bg-emerald-500/90 text-black hover:bg-emerald-400 cursor-pointer'
          : 'bg-white/[0.06] text-white/35 cursor-not-allowed'"
        :disabled="!canSubmit"
        @click="startClone"
      >
        <Loader2 v-if="busy" class="size-4 animate-spin" />
        <Mic v-else class="size-4" />
        {{ busy ? 'Adding…' : 'Add to queue' }}
      </button>

      <div v-if="busy" class="text-[11px] text-white/45 mt-3">
        {{ job.status === 'uploading' ? 'Uploading sample…' : 'Adding to the queue…' }}
      </div>

      <div v-else-if="job.status === 'queued'" class="flex items-start gap-2 mt-3 text-[12px] text-emerald-300/90">
        <Check class="size-4 shrink-0 mt-px" />
        <span>“{{ queuedName }}” added to the queue — it’ll keep training even if you close this. When it’s done it appears in the <span class="text-white/85">Generate speech</span> voice gallery. Track it in the Queue panel.</span>
      </div>

      <div v-else-if="job.status === 'failed'" class="flex items-start gap-2 mt-3 text-[12px] text-rose-300/90">
        <AlertCircle class="size-4 shrink-0 mt-px" />
        <span>{{ job.error }}</span>
      </div>
    </section>
  </div>
</template>
