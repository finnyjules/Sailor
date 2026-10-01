<script setup lang="ts">
/**
 * Face Swap app page — the first single-purpose surface built on the node engine.
 *
 * This is intentionally a *page* design (hero, copy, generous spacing), not a
 * canvas. The same FaceSwap node powers it under the hood, but the run itself
 * goes through the Sailor runner (family face-swap + cards) via useAppRun
 * (lib/runner/faceSwapApp.ts, R8.4): its price before the run, and Stop.
 */
import { ArrowRight, Download, Image as ImageIcon, Loader2, RefreshCcw, Square, Upload, X } from 'lucide-vue-next'
import TakesStrip from '~/components/vue-canvas/TakesStrip.vue'
import StudioSelect from '~/components/vue-canvas/studio/StudioSelect.vue'
import StudioSegmented from '~/components/vue-canvas/studio/StudioSegmented.vue'
import { useFaceSwapRun } from '~/lib/runner/faceSwapApp'
import {
  FACE_SWAP_GENDER_DEFAULT,
  FACE_SWAP_GENDER_OPTIONS,
  FACE_SWAP_HAIR_DEFAULT,
  FACE_SWAP_HAIR_OPTIONS,
} from '#shared/runner/faceSwap'

interface UploadedFile {
  file: File
  filename: string  // server-side filename returned by /upload/image
  previewUrl: string
}

const sourceFace = ref<UploadedFile | null>(null)
const targetImage = ref<UploadedFile | null>(null)
const uploading = ref(false)
const uploadError = ref<string | null>(null)
// Each run stacks as a take; the displayed result is the active take.
const { takes, activeTakeId, activeTake, addTake, selectTake, pinTake, discardTake, reset: resetTakes } = useAppTakes()
const outputUrl = computed<string | null>(() => activeTake.value?.images?.[0] ?? null)
const progressLabel = 'Swapping the face…'

// ----- Upload helpers ----------------------------------------------------

async function uploadFile(file: File): Promise<UploadedFile> {
  const fd = new FormData()
  fd.append('image', file)
  fd.append('overwrite', 'true')
  const res = await fetch('/upload/image', { method: 'POST', body: fd })
  if (!res.ok) throw new Error(`Upload failed (${res.status})`)
  const data = await res.json()
  return {
    file,
    filename: data?.name ?? file.name,
    previewUrl: URL.createObjectURL(file),
  }
}

async function pickFile(role: 'source' | 'target', file: File | undefined | null) {
  if (!file) return
  uploadError.value = null
  if (!swap.running.value) swap.reset()
  uploading.value = true
  try {
    const uploaded = await uploadFile(file)
    if (role === 'source') sourceFace.value = uploaded
    else targetImage.value = uploaded
  } catch (e: any) {
    uploadError.value = e?.message ?? 'Upload failed.'
  } finally {
    uploading.value = false
  }
}

function clearSlot(role: 'source' | 'target') {
  const ref = role === 'source' ? sourceFace : targetImage
  if (ref.value) URL.revokeObjectURL(ref.value.previewUrl)
  ref.value = null
  resetTakes()
  if (!swap.running.value) swap.reset()
}

// ----- Face's gender + hair choice ----------------------------------------

const GENDER_STORAGE_KEY = 'sailor.faceSwap.gender'
const HAIR_STORAGE_KEY = 'sailor.faceSwap.hair'

function readSavedGender(): typeof FACE_SWAP_GENDER_OPTIONS[number] {
  try {
    const saved = localStorage.getItem(GENDER_STORAGE_KEY)
    if (saved && (FACE_SWAP_GENDER_OPTIONS as readonly string[]).includes(saved)) return saved as typeof FACE_SWAP_GENDER_OPTIONS[number]
  } catch { /* localStorage unavailable — fall back to the default */ }
  return FACE_SWAP_GENDER_DEFAULT
}

function readSavedHair(): typeof FACE_SWAP_HAIR_OPTIONS[number] {
  try {
    const saved = localStorage.getItem(HAIR_STORAGE_KEY)
    if (saved && (FACE_SWAP_HAIR_OPTIONS as readonly string[]).includes(saved)) return saved as typeof FACE_SWAP_HAIR_OPTIONS[number]
  } catch { /* localStorage unavailable — fall back to the default */ }
  return FACE_SWAP_HAIR_DEFAULT
}

const gender = ref<typeof FACE_SWAP_GENDER_OPTIONS[number]>(readSavedGender())
const keepHairFrom = ref<typeof FACE_SWAP_HAIR_OPTIONS[number]>(readSavedHair())

watch(gender, (v) => {
  try { localStorage.setItem(GENDER_STORAGE_KEY, v) } catch { /* best effort only */ }
})

watch(keepHairFrom, (v) => {
  try { localStorage.setItem(HAIR_STORAGE_KEY, v) } catch { /* best effort only */ }
})

// ----- Price, run and Stop (Sailor runner, useAppRun) ---------------------

const swap = useFaceSwapRun({
  choice: computed(() => ({ face: sourceFace.value, target: targetImage.value, gender: gender.value, keepHairFrom: keepHairFrom.value })),
  addTake,
})
const { status, priceText, blocked, quoting, stopError } = swap
// The price follows the exact prompt: both pictures, the gender and the hair choice.
watch(() => [sourceFace.value?.filename, targetImage.value?.filename, gender.value, keepHairFrom.value], () => { void swap.quote() }, { immediate: true })

const canRun = computed(() => swap.canRun.value && !uploading.value)
const errorMessage = computed(() => uploadError.value ?? swap.errorMessage.value ?? stopError.value ?? blocked.value)

function run() { void swap.run() }
function stop() { void swap.stop() }

// ----- File-slot interactions -------------------------------------------

const sourceInputRef = ref<HTMLInputElement | null>(null)
const targetInputRef = ref<HTMLInputElement | null>(null)

function onDrop(role: 'source' | 'target', e: DragEvent) {
  e.preventDefault()
  const file = e.dataTransfer?.files?.[0]
  if (file) pickFile(role, file)
}

function preventDefault(e: Event) { e.preventDefault() }

function reset() {
  if (sourceFace.value) URL.revokeObjectURL(sourceFace.value.previewUrl)
  if (targetImage.value) URL.revokeObjectURL(targetImage.value.previewUrl)
  sourceFace.value = null
  targetImage.value = null
  resetTakes()
  uploadError.value = null
  if (!swap.running.value) swap.reset()
}

function download() {
  if (!outputUrl.value) return
  const a = document.createElement('a')
  a.href = outputUrl.value
  a.download = 'face-swap.png'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}
</script>

<template>
  <div class="h-full overflow-y-auto bg-[#0a0a0a]">
    <div class="max-w-[920px] mx-auto px-10 py-12">
      <!-- Header -->
      <div class="mb-14">
        <div class="text-[11px] uppercase tracking-[0.16em] text-white/35 font-medium mb-3">
          App · Image
        </div>
        <h1 class="text-[44px] font-medium text-white tracking-tight leading-[1.05] mb-4">
          Face Swap
        </h1>
        <p class="text-[15px] text-white/60 max-w-[560px] leading-relaxed">
          Drop a reference photo of the face you want to use, then drop the photo you want to put it into.
          Works best when the reference is well-lit and looking roughly at camera.
        </p>
      </div>

      <!-- Inputs -->
      <div class="grid grid-cols-2 gap-5 mb-8">
        <!-- Source face -->
        <div>
          <div class="flex items-center justify-between mb-2">
            <label class="text-[12px] font-medium text-white/85 tracking-[0.01em]">Reference face</label>
            <span class="text-[11px] text-white/35">Step 1</span>
          </div>
          <input
            ref="sourceInputRef"
            type="file"
            accept="image/*"
            class="hidden"
            @change="(e) => pickFile('source', (e.target as HTMLInputElement).files?.[0])"
          />
          <div
            v-if="!sourceFace"
            class="group relative aspect-[4/3] rounded-xl border border-dashed border-white/12 bg-white/[0.015] hover:bg-white/[0.04] hover:border-white/25 cursor-pointer transition-colors flex flex-col items-center justify-center gap-3"
            @click="sourceInputRef?.click()"
            @dragover="preventDefault"
            @drop="(e) => onDrop('source', e)"
          >
            <div class="size-10 rounded-full bg-white/[0.04] flex items-center justify-center">
              <Upload class="size-4 text-white/45 group-hover:text-white/70 transition-colors" :stroke-width="1.75" />
            </div>
            <div class="text-center">
              <div class="text-[13px] text-white/70 mb-0.5">Drop a face photo</div>
              <div class="text-[11px] text-white/35">or click to browse</div>
            </div>
          </div>
          <div
            v-else
            class="relative aspect-[4/3] rounded-xl overflow-hidden bg-black border border-white/10"
          >
            <img :src="sourceFace.previewUrl" class="absolute inset-0 size-full object-cover" />
            <button
              class="absolute top-2 right-2 size-7 rounded-full bg-black/70 hover:bg-black/90 backdrop-blur-sm flex items-center justify-center text-white/80 hover:text-white transition-colors cursor-pointer"
              @click="clearSlot('source')"
            >
              <X class="size-3.5" />
            </button>
            <div class="absolute bottom-0 left-0 right-0 px-3 py-2 bg-gradient-to-t from-black/80 to-transparent">
              <div class="text-[11px] text-white/80 truncate">{{ sourceFace.file.name }}</div>
            </div>
          </div>
        </div>

        <!-- Target image -->
        <div>
          <div class="flex items-center justify-between mb-2">
            <label class="text-[12px] font-medium text-white/85 tracking-[0.01em]">Target photo</label>
            <span class="text-[11px] text-white/35">Step 2</span>
          </div>
          <input
            ref="targetInputRef"
            type="file"
            accept="image/*"
            class="hidden"
            @change="(e) => pickFile('target', (e.target as HTMLInputElement).files?.[0])"
          />
          <div
            v-if="!targetImage"
            class="group relative aspect-[4/3] rounded-xl border border-dashed border-white/12 bg-white/[0.015] hover:bg-white/[0.04] hover:border-white/25 cursor-pointer transition-colors flex flex-col items-center justify-center gap-3"
            @click="targetInputRef?.click()"
            @dragover="preventDefault"
            @drop="(e) => onDrop('target', e)"
          >
            <div class="size-10 rounded-full bg-white/[0.04] flex items-center justify-center">
              <ImageIcon class="size-4 text-white/45 group-hover:text-white/70 transition-colors" :stroke-width="1.75" />
            </div>
            <div class="text-center">
              <div class="text-[13px] text-white/70 mb-0.5">Drop the photo to edit</div>
              <div class="text-[11px] text-white/35">or click to browse</div>
            </div>
          </div>
          <div
            v-else
            class="relative aspect-[4/3] rounded-xl overflow-hidden bg-black border border-white/10"
          >
            <img :src="targetImage.previewUrl" class="absolute inset-0 size-full object-cover" />
            <button
              class="absolute top-2 right-2 size-7 rounded-full bg-black/70 hover:bg-black/90 backdrop-blur-sm flex items-center justify-center text-white/80 hover:text-white transition-colors cursor-pointer"
              @click="clearSlot('target')"
            >
              <X class="size-3.5" />
            </button>
            <div class="absolute bottom-0 left-0 right-0 px-3 py-2 bg-gradient-to-t from-black/80 to-transparent">
              <div class="text-[11px] text-white/80 truncate">{{ targetImage.file.name }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Face's gender + hair choice -->
      <div class="grid grid-cols-2 gap-5 mb-8">
        <div>
          <label class="text-[12px] font-medium text-white/85 tracking-[0.01em] mb-2 block">Face's gender</label>
          <StudioSelect
            v-model="gender"
            :options="[...FACE_SWAP_GENDER_OPTIONS]"
            :option-labels="['Choose…', 'Male', 'Female', 'Non-binary']"
          />
        </div>
        <div>
          <label class="text-[12px] font-medium text-white/85 tracking-[0.01em] mb-2 block" title="Whose hair shows in the result">Keep hair from</label>
          <StudioSegmented v-model="keepHairFrom" :options="[...FACE_SWAP_HAIR_OPTIONS]" />
        </div>
      </div>

      <!-- Run -->
      <div class="flex items-center justify-between mb-12">
        <p v-if="status === 'running' && !stopError" class="text-[12px] text-white/55 flex items-center gap-2">
          <Loader2 class="size-3.5 animate-spin" />
          <span>{{ progressLabel }}</span>
        </p>
        <p v-else-if="uploading" class="text-[12px] text-white/55 flex items-center gap-2">
          <Loader2 class="size-3.5 animate-spin" />
          <span>Uploading…</span>
        </p>
        <p v-else-if="errorMessage" class="text-[12px] text-rose-400 max-w-md">
          {{ errorMessage }}
        </p>
        <span v-else class="text-[12px] text-white/35">
          {{ !sourceFace || !targetImage ? 'Add both photos above to start.' : gender === FACE_SWAP_GENDER_DEFAULT ? 'Choose the face’s gender.' : 'Ready to swap.' }}
        </span>
        <div class="flex items-center gap-3">
          <span
            v-if="status !== 'running' && (quoting || priceText)"
            class="text-[12px] text-white/55 tabular-nums"
            title="The most this run can cost"
          >{{ quoting ? '…' : priceText }}</span>
          <button
            v-if="status === 'running'"
            class="inline-flex items-center gap-2 h-10 px-5 rounded-full bg-white/[0.08] text-white font-medium text-[13px] hover:bg-white/[0.14] transition-colors cursor-pointer"
            @click="stop"
          >
            <Square class="size-3.5" :stroke-width="2" />
            <span>Stop</span>
          </button>
          <button
            v-else
            class="inline-flex items-center gap-2 h-10 px-5 rounded-full bg-white text-[#0a0a0a] font-medium text-[13px] hover:bg-white/90 transition-colors cursor-pointer disabled:bg-white/15 disabled:text-white/40 disabled:cursor-not-allowed"
            :disabled="!canRun"
            @click="run"
          >
            <span>Swap faces</span>
            <ArrowRight class="size-4" />
          </button>
        </div>
      </div>

      <!-- Output -->
      <div v-if="outputUrl || status === 'running'" class="border-t border-white/[0.06] pt-10">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-[20px] font-medium text-white tracking-tight">Result</h2>
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
          <img v-if="outputUrl" :src="outputUrl" class="w-full max-h-[640px] object-contain" />
          <div v-else class="flex flex-col items-center gap-3 py-16">
            <Loader2 class="size-6 text-white/30 animate-spin" />
            <div class="text-[12px] text-white/40">{{ progressLabel || 'Working…' }}</div>
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
