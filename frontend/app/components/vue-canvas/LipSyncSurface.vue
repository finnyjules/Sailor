<script setup lang="ts">
// Lip-Sync Studio — editor surface. Modal chrome mirrors ShotDirectorSurface:
// full-screen overlay, bordered dialog, header with title + esc + close.
// Body is single-column (Face panel, Voice panel, Engine+format row) since
// there's no compiled-prompt preview here — just Generate is left for Task 6.
import { computed, ref } from 'vue'
import { X, Upload, Link as LinkIcon } from 'lucide-vue-next'
import { useLipSync } from '~/composables/useLipSync'
import { useCharacters } from '~/composables/useCharacters'
import { uploadRefFile, viewRefUrl } from '~/lib/shotdirector/refUpload'
import { VOICE_CATALOG, mergeClonedVoices, type VoiceMeta, type ClonedVoice } from '~/lib/voiceCatalog'
import { engineLabel, resolveEngine } from '~/lib/lipsync/compile'
import { NO_FAMILIES, parseFamilies } from '#shared/runner/families'
import { comboMenu, menuHiddenValues, modelMenu } from '#shared/runner/modelMenus'
import { SYNC_3_ENGINE, SYNC_3_SYNC_MODES } from '#shared/runner/lipSync'
import StudioSection from '~/components/vue-canvas/StudioSection.vue'

const props = defineProps<{ nodeId: string; nodes: any[] }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const node = computed(() => props.nodes.find(n => String(n.id) === String(props.nodeId)))

function persist(s: any) {
  const n = node.value
  if (!n) return
  if (!n.data) n.data = {}
  if (!n.data.properties) n.data.properties = {}
  n.data.properties.sailor_lipSync = s
}

const { sheet, result, setFace, setVoice, update } = useLipSync(
  node.value?.data?.properties?.sailor_lipSync,
  persist,
)

const { characters, coverUrl, portraitUrl } = useCharacters()

// ── First-open guide ────────────────────────────────────────────────────────
const showIntro = computed(() => !sheet.value.face.src && !sheet.value.voice.text && !sheet.value.voice.src)

// ── Generate ─────────────────────────────────────────────────────────────────
const hasError = computed(() => result.value.issues.some(i => i.level === 'error'))
// Runtime failures from the Generate handler (voice resolution, missing widget,
// no audio) land on the node's data — surface them so a click isn't silent.
const runtimeError = computed(() => node.value?.data?.lipSyncError as string | null | undefined)
function onGenerate() {
  if (hasError.value) return
  if (node.value?.data) node.value.data.lipSyncError = null
  window.dispatchEvent(new CustomEvent('sailor:lipSyncGenerate', { detail: { sourceNodeId: props.nodeId } }))
}

// ── Face panel ───────────────────────────────────────────────────────────────
type FaceTab = 'character' | 'image' | 'video'
const faceTab = ref<FaceTab>(sheet.value.face.kind ?? 'image')

function selectCharacter(slug: string, name: string) {
  const c = characters.value.find(x => x.slug === slug)
  if (!c) return
  const src = portraitUrl(c, null)
  if (!src) return
  setFace({ kind: 'character', src, characterSlug: slug })
}

const fileInputImage = ref<HTMLInputElement | null>(null)
const fileInputVideo = ref<HTMLInputElement | null>(null)
const uploadingImage = ref(false)
const uploadingVideo = ref(false)
const videoUrlInput = ref('')

async function onImageFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  uploadingImage.value = true
  try {
    const src = await uploadRefFile(file)
    setFace({ kind: 'image', src })
  } catch { /* upload failed — leave face untouched */ }
  finally { uploadingImage.value = false; input.value = '' }
}

async function onVideoFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  uploadingVideo.value = true
  try {
    const src = await uploadRefFile(file)
    setFace({ kind: 'video', src })
  } catch { /* upload failed — leave face untouched */ }
  finally { uploadingVideo.value = false; input.value = '' }
}

function setVideoUrl() {
  const v = videoUrlInput.value.trim()
  if (!v) return
  setFace({ kind: 'video', src: v })
}

// ── Voice panel ──────────────────────────────────────────────────────────────
type VoiceTab = 'tts' | 'upload' | 'clip'
const voiceTab = ref<VoiceTab>(sheet.value.voice.kind === 'audio' ? 'upload' : 'tts')

const ttsText = ref(sheet.value.voice.text ?? '')
const selectedVoiceId = ref(sheet.value.voice.voiceId ?? 'Wise_Woman')

function commitTts() {
  setVoice({ kind: 'tts', text: ttsText.value, voiceId: selectedVoiceId.value })
}

const clonedVoices = ref<ClonedVoice[]>([])
async function loadClonedVoices() {
  try {
    const r = await $fetch<{ voices: ClonedVoice[] }>('/api/voices-local')
    clonedVoices.value = r.voices ?? []
  } catch { clonedVoices.value = [] }
}
loadClonedVoices()

const allVoiceOptions = computed<VoiceMeta[]>(() => [...VOICE_CATALOG, ...mergeClonedVoices(clonedVoices.value)])

const fileInputAudio = ref<HTMLInputElement | null>(null)
const uploadingAudio = ref(false)
const clipUrlInput = ref(sheet.value.voice.kind === 'audio' ? (sheet.value.voice.src ?? '') : '')

async function onAudioFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  uploadingAudio.value = true
  try {
    const src = await uploadRefFile(file)
    setVoice({ kind: 'audio', src })
  } catch { /* upload failed — leave voice untouched */ }
  finally { uploadingAudio.value = false; input.value = '' }
}

function setClipUrl() {
  const v = clipUrlInput.value.trim()
  if (!v) return
  setVoice({ kind: 'audio', src: v })
}

// ── Engine + format ────────────────────────────────────────────────────────
const resolvedEngine = computed(() => resolveEngine(sheet.value))
const RESOLUTIONS = ['480p', '720p', '1080p']
const SYNC_MODES = ['cut_off', 'loop', 'bounce', 'silence', 'remap']

// The engines on offer (shared/runner/modelMenus.ts "LipSyncNode.engine"):
// sync-3 runs only in Sailor's runner, so it shows while its switch is on,
// and otherwise only when this studio already holds it (tagged "hidden").
const runtimePublic = useRuntimeConfig().public as { runnerEnabled?: boolean, runnerFamilies?: unknown }
const lipSyncFamilies = runtimePublic.runnerEnabled ? parseFamilies(runtimePublic.runnerFamilies) : NO_FAMILIES
const engineMenu = computed(() => {
  const menu = modelMenu('LipSyncNode', 'engine')
  if (!menu) return { options: ['auto', 'fabric', 'sync'], labels: ['Auto', 'Fabric', 'Sync'] }
  const m = comboMenu(menu.entries.map(e => e.value), menuHiddenValues(menu, lipSyncFamilies), sheet.value.engine, engineLabel)
  return { options: m.options, labels: m.labels ?? m.options.map(engineLabel) }
})
// sync-3 can't use "silence" (its clip would be the whole video): it shows only while picked, to be changed.
const syncModes = computed(() => resolvedEngine.value !== SYNC_3_ENGINE
  ? SYNC_MODES
  : [...SYNC_3_SYNC_MODES, ...(SYNC_3_SYNC_MODES.includes(sheet.value.syncMode) ? [] : [sheet.value.syncMode])])
// What each engine bills: Fabric and Kling's lip-sync about $1 per 30 s; sync-3 $8 a minute (shared/pricing/clipRates.ts).
const priceHint = computed(() => resolvedEngine.value === SYNC_3_ENGINE
  ? { text: '~$4 / 30s', title: 'sync-3 bills $8 per minute of video it makes' }
  : { text: '~$1 / 30s', title: 'Both engines bill about $1 per 30 seconds of output' })

function humanizeSyncMode(m: string): string {
  const words = m.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}
</script>

<template>
  <!-- Full-screen modal overlay -->
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
    <div
      role="dialog"
      aria-modal="true"
      class="flex h-[680px] max-h-[94vh] w-[720px] max-w-[97vw] flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-[#0e0e10] text-white shadow-2xl outline-none"
    >
      <!-- Header -->
      <div class="flex shrink-0 items-center gap-2 border-b border-white/[0.06] px-4 pt-3 pb-2.5">
        <span class="text-[13px] font-medium tracking-[-0.01em] text-white/90">Lip-Sync Studio</span>
        <span class="ml-1 rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-white/40">{{ engineLabel(resolvedEngine) }}</span>
        <span class="flex-1" />
        <span class="rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-white/30">esc</span>
        <button type="button" aria-label="Close" class="ml-1 text-white/40 transition hover:text-white/80" @click="emit('close')">
          <X class="h-4 w-4" />
        </button>
      </div>

      <!-- Body (single column, scrollable) -->
      <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">

        <!-- First-open guide -->
        <div v-if="showIntro" class="rounded-lg border border-white/[0.08] bg-white/[0.02] p-3">
          <p class="text-[12px] font-medium text-white/80">Drive a face with a voice, in three steps</p>
          <ol class="mt-2 space-y-1.5 text-[11px] leading-relaxed text-white/50">
            <li><span class="mr-1.5 text-white/30">1</span><span class="text-white/70">Pick a face</span> — a saved character, an image, or a video.</li>
            <li><span class="mr-1.5 text-white/30">2</span><span class="text-white/70">Add a voice</span> — type a line, upload audio, or link an existing clip.</li>
            <li><span class="mr-1.5 text-white/30">3</span><span class="text-white/70">Generate</span> — the engine resolves automatically from your face.</li>
          </ol>
        </div>

        <!-- ═══ FACE PANEL ═══════════════════════════════════════════════ -->
        <StudioSection title="Face">
          <!-- Tabs -->
          <div class="flex items-center gap-0 rounded-md border border-white/[0.08] p-1">
            <button
              type="button"
              class="flex-1 rounded py-1.5 text-[11px] font-medium transition-colors"
              :class="faceTab === 'character' ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/70'"
              @click="faceTab = 'character'"
            >Character</button>
            <button
              type="button"
              class="flex-1 rounded py-1.5 text-[11px] font-medium transition-colors"
              :class="faceTab === 'image' ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/70'"
              @click="faceTab = 'image'"
            >Image</button>
            <button
              type="button"
              class="flex-1 rounded py-1.5 text-[11px] font-medium transition-colors"
              :class="faceTab === 'video' ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/70'"
              @click="faceTab = 'video'"
            >Video</button>
          </div>

          <!-- Character tab -->
          <div v-if="faceTab === 'character'" class="space-y-2">
            <div v-if="!characters.length" class="rounded border border-dashed border-white/10 py-3 text-center text-[11px] text-white/25">
              No saved characters yet.
            </div>
            <div v-else class="grid grid-cols-4 gap-2">
              <button
                v-for="c in characters" :key="c.slug"
                type="button"
                class="group flex flex-col items-center gap-1 rounded border p-1.5 transition-colors"
                :class="sheet.face.characterSlug === c.slug
                  ? 'border-white/30 bg-white/10'
                  : 'border-white/[0.08] hover:border-white/20 hover:bg-white/[0.04]'"
                @click="selectCharacter(c.slug, c.name)"
              >
                <img v-if="coverUrl(c)" :src="coverUrl(c)!" class="h-14 w-14 rounded object-cover" :alt="c.name" />
                <div v-else class="h-14 w-14 rounded bg-white/5" />
                <span class="w-full truncate text-center text-[10px] text-white/60">{{ c.name }}</span>
              </button>
            </div>
          </div>

          <!-- Image tab -->
          <div v-else-if="faceTab === 'image'" class="space-y-2">
            <input ref="fileInputImage" type="file" accept="image/*" class="hidden" @change="onImageFile" />
            <div
              class="relative flex h-28 cursor-pointer items-center justify-center overflow-hidden rounded-lg border border-dashed border-white/15 bg-white/[0.03] transition hover:border-white/30"
              @click="fileInputImage?.click()"
            >
              <img v-if="sheet.face.kind === 'image' && sheet.face.src" :src="sheet.face.src" class="absolute inset-0 h-full w-full object-cover" alt="" />
              <span v-else class="flex items-center gap-1.5 text-[11px] text-white/25">
                <Upload class="h-3.5 w-3.5" /> {{ uploadingImage ? 'Uploading…' : 'Upload an image' }}
              </span>
            </div>
          </div>

          <!-- Video tab -->
          <div v-else class="space-y-2">
            <input ref="fileInputVideo" type="file" accept="video/*" class="hidden" @change="onVideoFile" />
            <div
              class="relative flex h-28 cursor-pointer items-center justify-center overflow-hidden rounded-lg border border-dashed border-white/15 bg-white/[0.03] transition hover:border-white/30"
              @click="fileInputVideo?.click()"
            >
              <video v-if="sheet.face.kind === 'video' && sheet.face.src" :src="sheet.face.src" class="absolute inset-0 h-full w-full object-cover" muted />
              <span v-else class="flex items-center gap-1.5 text-[11px] text-white/25">
                <Upload class="h-3.5 w-3.5" /> {{ uploadingVideo ? 'Uploading…' : 'Upload a video' }}
              </span>
            </div>
            <div class="flex gap-1.5">
              <input
                v-model="videoUrlInput"
                type="text"
                placeholder="or paste a video URL…"
                class="min-w-0 flex-1 rounded border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[11px] text-white/80 placeholder:text-white/25 outline-none focus:border-white/25"
                @keydown.enter.prevent="setVideoUrl"
              />
              <button
                type="button"
                class="shrink-0 rounded border border-white/10 px-2.5 py-1.5 text-[11px] text-white/50 transition hover:bg-white/10 hover:text-white/80"
                @click="setVideoUrl"
              >Use URL</button>
            </div>
          </div>
        </StudioSection>

        <!-- ═══ VOICE PANEL ══════════════════════════════════════════════ -->
        <StudioSection title="Voice">
          <!-- Tabs -->
          <div class="flex items-center gap-0 rounded-md border border-white/[0.08] p-1">
            <button
              type="button"
              class="flex-1 rounded py-1.5 text-[11px] font-medium transition-colors"
              :class="voiceTab === 'tts' ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/70'"
              @click="voiceTab = 'tts'"
            >Type to speak</button>
            <button
              type="button"
              class="flex-1 rounded py-1.5 text-[11px] font-medium transition-colors"
              :class="voiceTab === 'upload' ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/70'"
              @click="voiceTab = 'upload'"
            >Upload audio</button>
            <button
              type="button"
              class="flex-1 rounded py-1.5 text-[11px] font-medium transition-colors"
              :class="voiceTab === 'clip' ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/70'"
              @click="voiceTab = 'clip'"
            >Existing clip</button>
          </div>

          <!-- Type to speak -->
          <div v-if="voiceTab === 'tts'" class="space-y-2">
            <textarea
              v-model="ttsText"
              rows="3"
              placeholder="Type the line this face will speak…"
              class="w-full resize-none rounded border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[12px] text-white/90 placeholder:text-white/25 outline-none focus:border-white/25"
              @blur="commitTts"
            />
            <div>
              <label class="mb-1 block text-[11px] text-white/45">Voice</label>
              <select
                v-model="selectedVoiceId"
                class="w-full rounded border border-white/10 bg-[#0e0e10] px-2.5 py-1.5 text-[12px] text-white/80 outline-none focus:border-white/25"
                @change="commitTts"
              >
                <optgroup label="Built-in" class="bg-neutral-900">
                  <option v-for="v in VOICE_CATALOG" :key="v.id" :value="v.id" class="bg-neutral-900">{{ v.label }}</option>
                </optgroup>
                <optgroup v-if="clonedVoices.length" label="Your voices" class="bg-neutral-900">
                  <option v-for="v in clonedVoices" :key="v.id" :value="v.id" class="bg-neutral-900">{{ v.name }}</option>
                </optgroup>
              </select>
            </div>
          </div>

          <!-- Upload audio -->
          <div v-else-if="voiceTab === 'upload'" class="space-y-2">
            <input ref="fileInputAudio" type="file" accept="audio/*" class="hidden" @change="onAudioFile" />
            <div
              class="flex h-16 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-dashed border-white/15 bg-white/[0.03] text-[11px] text-white/25 transition hover:border-white/30"
              @click="fileInputAudio?.click()"
            >
              <Upload class="h-3.5 w-3.5" />
              {{ uploadingAudio ? 'Uploading…' : (sheet.voice.kind === 'audio' && sheet.voice.src ? 'Replace audio' : 'Upload audio') }}
            </div>
            <audio v-if="sheet.voice.kind === 'audio' && sheet.voice.src" :src="sheet.voice.src" controls class="w-full" style="height: 32px" />
          </div>

          <!-- Existing clip -->
          <div v-else class="flex gap-1.5">
            <input
              v-model="clipUrlInput"
              type="text"
              placeholder="Paste an audio URL…"
              class="min-w-0 flex-1 rounded border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[11px] text-white/80 placeholder:text-white/25 outline-none focus:border-white/25"
              @keydown.enter.prevent="setClipUrl"
            />
            <button
              type="button"
              class="flex shrink-0 items-center gap-1 rounded border border-white/10 px-2.5 py-1.5 text-[11px] text-white/50 transition hover:bg-white/10 hover:text-white/80"
              @click="setClipUrl"
            ><LinkIcon class="h-3 w-3" /> Use URL</button>
          </div>
        </StudioSection>

        <!-- ═══ ENGINE + FORMAT ══════════════════════════════════════════ -->
        <StudioSection title="Engine + format">
          <div class="grid grid-cols-2 gap-x-3 gap-y-2.5">
            <div>
              <label class="mb-1 block text-[11px] text-white/45">Engine</label>
              <select
                :value="sheet.engine"
                class="w-full rounded border border-white/10 bg-[#0e0e10] px-2.5 py-1.5 text-[12px] text-white/80 outline-none focus:border-white/25"
                @change="update(s => ({ ...s, engine: ($event.target as HTMLSelectElement).value as typeof s.engine }))"
              >
                <option v-for="(e, i) in engineMenu.options" :key="e" :value="e" class="bg-neutral-900">{{ engineMenu.labels[i] }}</option>
              </select>
            </div>
            <div v-if="resolvedEngine === 'fabric'">
              <label class="mb-1 block text-[11px] text-white/45">Resolution</label>
              <select
                :value="sheet.resolution"
                class="w-full rounded border border-white/10 bg-[#0e0e10] px-2.5 py-1.5 text-[12px] text-white/80 outline-none focus:border-white/25"
                @change="update(s => ({ ...s, resolution: ($event.target as HTMLSelectElement).value as typeof s.resolution }))"
              >
                <option v-for="r in RESOLUTIONS" :key="r" :value="r" class="bg-neutral-900">{{ r }}</option>
              </select>
            </div>
            <div v-if="resolvedEngine === 'sync' || resolvedEngine === SYNC_3_ENGINE">
              <label class="mb-1 block text-[11px] text-white/45">Sync mode</label>
              <select
                :value="sheet.syncMode"
                class="w-full rounded border border-white/10 bg-[#0e0e10] px-2.5 py-1.5 text-[12px] text-white/80 outline-none focus:border-white/25"
                @change="update(s => ({ ...s, syncMode: ($event.target as HTMLSelectElement).value as typeof s.syncMode }))"
              >
                <option v-for="m in syncModes" :key="m" :value="m" class="bg-neutral-900">{{ humanizeSyncMode(m) }}</option>
              </select>
            </div>
          </div>

          <p class="text-[11px] text-white/35">
            Resolved engine: <span class="text-white/60">{{ engineLabel(resolvedEngine) }}</span>
            <span v-if="sheet.engine === 'auto'" class="text-white/25"> (auto — video faces use Sync, image/character faces use Fabric)</span>
          </p>

          <!-- Issues -->
          <div v-if="result.issues.length" class="space-y-1">
            <div
              v-for="(issue, i) in result.issues" :key="i"
              class="flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-[11px]"
              :class="issue.level === 'error'
                ? 'border-red-500/20 bg-red-500/[0.06] text-red-300'
                : 'border-amber-500/20 bg-amber-500/[0.06] text-amber-300'"
            >
              <span class="mt-px shrink-0 text-[9px] font-bold uppercase">{{ issue.level }}</span>
              <span>{{ issue.message }}</span>
            </div>
          </div>
        </StudioSection>

      </div><!-- /body -->

      <!-- Footer -->
      <div v-if="runtimeError" class="shrink-0 border-t border-red-500/20 bg-red-500/[0.06] px-4 py-2 text-[11px] text-red-300">
        {{ runtimeError }}
      </div>
      <div class="flex shrink-0 items-center justify-end gap-2 border-t border-white/[0.06] px-4 py-2.5">
        <span class="mr-auto text-[11px] text-white/30" :title="priceHint.title">{{ priceHint.text }}</span>
        <button
          type="button"
          class="rounded border border-white/10 px-3 py-1.5 text-[12px] text-white/70 transition enabled:hover:border-white/25 enabled:hover:text-white/90 disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="hasError"
          title="Regenerate — a fresh voice + take"
          @click="onGenerate"
        >New take</button>
        <button
          type="button"
          class="rounded bg-action px-3.5 py-1.5 text-[12px] font-medium text-white transition enabled:hover:bg-action/85 disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="hasError"
          @click="onGenerate"
        >Generate</button>
      </div>
    </div>
  </div>
</template>
