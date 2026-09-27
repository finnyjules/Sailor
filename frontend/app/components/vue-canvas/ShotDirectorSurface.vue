<script setup lang="ts">
// Shot Director — editor surface. Two-column layout inside a custom modal:
// LEFT = references-first editing controls; RIGHT = always-visible compiled preview.
// All mutations go through update/addReference/removeReference from useShotDirector.
import { computed, ref } from 'vue'
import { X, Plus, Copy, Check, Sparkles } from 'lucide-vue-next'
import { useShotDirector } from '~/composables/useShotDirector'
import { useCharacters, missingStateIssues } from '~/composables/useCharacters'
import {
  SHOT_TYPE_PHRASE, CAMERA_MOVE_PHRASE, ROLES_BY_KIND,
  type RefKind, type RefRole, type CastMember,
} from '~/lib/shotdirector/types'
import { formatShotUSD } from '~/lib/shotdirector/price'
import { buildKeyframePrompt, startFrameImages, KEYFRAME_COST_USD } from '~/lib/shotdirector/keyframe'
import { uploadRefFile, viewRefUrl } from '~/lib/shotdirector/refUpload'
import { pickState } from '#shared/characters/types'
import { castMemberPictures } from '~/lib/shotdirector/cast'
import { SHOT_MODEL_CHOICES } from '~/lib/shotdirector/profiles'
import StudioSection from '~/components/vue-canvas/StudioSection.vue'
import CharacterPickerModal from '~/components/vue-canvas/CharacterPickerModal.vue'
import ShotViewfinder from '~/components/vue-canvas/ShotViewfinder.vue'
import ShotCameraPicker from '~/components/vue-canvas/ShotCameraPicker.vue'
import { emitCharacterEvent } from '~/lib/characters/bus'
import { latestShotTakeScores, faceScoreChip } from '~/lib/shotdirector/takeScores'

const props = defineProps<{ nodeId: string; nodes: any[]; edges?: any[] }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const node = computed(() => props.nodes.find(n => String(n.id) === String(props.nodeId)))

function persist(s: any) {
  const n = node.value
  if (!n) return
  if (!n.data) n.data = {}
  if (!n.data.properties) n.data.properties = {}
  n.data.properties.sailor_shotDirector = s
}

const { resolveCastSets, coverUrl, characters } = useCharacters()
const { sheet, result, profile, addReference, removeReference, update, rerollSeed, setModel, addCastMember, removeCastMember } = useShotDirector(
  node.value?.data?.properties?.sailor_shotDirector,
  persist,
  picks => resolveCastSets(picks),
  picks => missingStateIssues(picks, characters.value),
)

/** True when this member's picked variant was deleted (falls back to Default). */
function variantMissing(m: CastMember): boolean {
  if (!m.stateId) return false
  const c = characters.value.find(x => x.slug === m.slug)
  return !!c && !c.states.some(v => v.id === m.stateId)
}

// ── First-open guide ───────────────────────────────────────────────────────────
// Visible only on a blank sheet; disappears the moment any real input lands.
const showIntro = computed(() =>
  !sheet.value.subject.trim() && !sheet.value.action.trim()
  && !sheet.value.cast.length && !sheet.value.references.length
  && !sheet.value.firstFrame,
)

// ── Cast ───────────────────────────────────────────────────────────────────────
const castPickerOpen = ref(false)
function castCover(m: CastMember): string | null {
  const c = characters.value.find(x => x.slug === m.slug)
  return c ? coverUrl(c, m.stateId) : null
}
/** Variant label for a non-default pick, e.g. "Vera · Raincoat" in the chip. */
function variantLabel(m: CastMember): string | null {
  if (!m.stateId) return null
  const c = characters.value.find(x => x.slug === m.slug)
  const v = c?.states.find(x => x.id === m.stateId)
  return v ? v.label : null
}
/** The photos each cast member contributes, with the tag the chosen model
 *  reads them by (@Image1–2, image 3, @Element1) — so "what is @Image2?" is
 *  answerable by looking at the Cast section. */
const castRefRows = computed(() => {
  const p = profile.value
  let slot = 1
  const resolved = resolveCastSets(sheet.value.cast.map(m => ({ slug: m.slug, stateId: m.stateId })))
  return sheet.value.cast.map((m) => {
    // What is actually sent to the chosen model (same pick as materializeCast).
    const urls = castMemberPictures(resolved[m.slug], p)
    const start = slot
    let tags: string[]
    let tag: string
    if (p.castMode === 'elements') {
      // one element per character, all its pictures under one tag
      tag = urls.length ? p.refTag('image', slot++) : ''
      tags = urls.map(() => tag)
    } else {
      tags = urls.map((_, i) => p.refTag('image', start + i))
      slot += urls.length
      tag = urls.length > 1 ? `${tags[0]}–${slot - 1}` : (tags[0] ?? '')
    }
    return { slug: m.slug, name: m.name, variantLabel: variantLabel(m), urls, tag, tags }
  })
})
function onRemoveCast(m: CastMember) {
  // One gesture, both representations: ask the canvas to drop any same-slug edge
  // (it no-ops when there isn't one), then remove the cast entry directly for an
  // instant surface. Dispatch UNCONDITIONALLY — even for a picker-via member, a
  // same-slug wire can be lingering (picker-add then wire: dedupe keeps the
  // picker entry but the edge stays), and a stray edge left behind would
  // resurrect the cast member on the next edge sync.
  emitCharacterEvent('uncastCharacter', { nodeId: props.nodeId, slug: m.slug })
  removeCastMember(m.slug)
}

// ── Generate / New take ───────────────────────────────────────────────────────
// `update`/`rerollSeed` call `persist` synchronously (no debounce), so by the time
// we dispatch the canvas event the node's properties already hold the fresh sheet.
const hasErrors = computed(() => result.value.issues.some(i => i.level === 'error'))

function onGenerate() {
  // The sheet is already persisted on the node (update/rerollSeed persist
  // synchronously), so the canvas handler reads the fresh sheet regardless.
  // Close the modal so the user returns to the canvas and can actually SEE the
  // spawned FilmShotNode run — otherwise the full-screen modal hides it and the
  // launch looks like it did nothing. Handler errors surface on the node card.
  window.dispatchEvent(new CustomEvent('sailor:shotDirectorGenerate', { detail: { sourceNodeId: props.nodeId } }))
  emit('close')
}

function onNewTake() {
  rerollSeed()
  onGenerate()
}

/** The latest take's face scores, one chip per cast member. */
const takeScoreChips = computed(() =>
  latestShotTakeScores(props.nodes, props.edges ?? [], props.nodeId).map(s => ({ key: s.slug, ...faceScoreChip(s) })),
)

// ── Copy actions ──────────────────────────────────────────────────────────────
const copiedPrompt = ref(false)
const copiedJson = ref(false)

function copyPrompt() {
  navigator.clipboard.writeText(result.value.prompt).then(() => {
    copiedPrompt.value = true
    setTimeout(() => { copiedPrompt.value = false }, 1800)
  })
}
function copyJson() {
  navigator.clipboard.writeText(JSON.stringify(result.value.input, null, 2)).then(() => {
    copiedJson.value = true
    setTimeout(() => { copiedJson.value = false }, 1800)
  })
}

// ── Word budget meter ──────────────────────────────────────────────────────────
const wordCountClass = computed(() => {
  if (result.value.issues.some(i => i.code === 'word-budget-exceeded')) return 'text-red-400'
  if (result.value.wordCount > 100) return 'text-amber-400'
  return 'text-emerald-400'
})

// ── Viewfinder subject ──────────────────────────────────────────────────────────
// The single representative photo the frame composes: the lead cast member's
// cover, else the strongest image reference (identity/composition lock reads as
// "the subject"), else the first image. First/last-frame mode draws its own pair.
const subjectImage = computed<string | null>(() => {
  const lead = sheet.value.cast[0]
  if (lead) {
    const cover = castCover(lead)
    if (cover) return cover
  }
  // Exclude the location plate — it is the backdrop, never the subject.
  const imgs = sheet.value.references.filter(r => r.kind === 'image' && r.src && r.role !== 'location')
  const locked = imgs.find(r => r.role === 'identity-lock' || r.role === 'composition-lock')
  return (locked ?? imgs[0])?.src ?? null
})
const subjectLabel = computed(() => sheet.value.cast[0]?.name ?? 'Reference')

// ── Environment plate ────────────────────────────────────────────────────────
// A single 'location'-role image ref: the backdrop the viewfinder composes over
// and a real reference sent to the model. Surfaced only on the Environment field
// (filtered out of the Images rail), one at a time.
const environmentRef = computed(() => sheet.value.references.find(r => r.role === 'location') ?? null)
const environmentImage = computed(() => environmentRef.value?.src ?? null)
const envGenerating = ref(false)
const envError = ref<string | null>(null)
const fileInputEnv = ref<HTMLInputElement | null>(null)

function setLocationRef(src: string) {
  const existing = environmentRef.value
  if (existing) removeReference('image', existing.slot)
  addReference('image', src, 'location')
}

async function onEnvironmentFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  envError.value = null
  const src = await uploadRefFile(file).catch(() => fileToDataUrl(file))
  setLocationRef(src)
  input.value = ''
}

async function generateEnvironment() {
  const parts = [sheet.value.environment, sheet.value.lighting, sheet.value.style]
    .map(s => s.trim()).filter(Boolean)
  if (!parts.length) return
  envGenerating.value = true
  envError.value = null
  try {
    const prompt = `${parts.join(', ')}, empty establishing location, no people, cinematic`
    const res = await $fetch<{ images?: string[] }>('/api/inpaint/text2img', {
      method: 'POST',
      body: { prompt, aspect_ratio: sheet.value.format.aspectRatio, count: 1 },
    })
    const src = res.images?.[0]
    if (!src) throw new Error('No image returned')
    setLocationRef(src)
  } catch (err) {
    envError.value = err instanceof Error ? err.message : 'Generation failed'
  } finally {
    envGenerating.value = false
  }
}

// ── Keyframe preview ─────────────────────────────────────────────────────────
// A photoreal still generated from the SAME references + intent Seedance will use
// — a ~$0.05 proxy for the slow, ~$2.25 run. On-demand (explicit button); editing
// never spends, it just marks the shown keyframe stale.
const previewCost = `~$${KEYFRAME_COST_USD.toFixed(2)}`
const previewFrame = ref<string | null>(null)
const previewBusy = ref(false)
const previewError = ref<string | null>(null)
const previewKey = ref<string | null>(null)

// With a cast, the frame is made from each member's clean pictures (front,
// full-body front, their look's clothes) with a line naming who is which image
// — never the combined sheet grid. Without a cast: the subject image, as before.
const castStartFrame = computed(() => {
  if (!sheet.value.cast.length) return null
  const sets = resolveCastSets(sheet.value.cast.map(m => ({ slug: m.slug, stateId: m.stateId })))
  const members = sheet.value.cast.flatMap((m) => {
    const set = sets[m.slug]
    if (!set) return []
    const c = characters.value.find(x => x.slug === m.slug)
    const clothes = c ? (pickState(c, m.stateId)?.clothes ?? []).map(g => viewRefUrl(g.filename)) : []
    return [{ name: m.name, set, clothes }]
  })
  const made = startFrameImages(members, environmentImage.value)
  return made.urls.length ? made : null
})

// What the keyframe depends on — when this drifts from previewKey, it's stale.
const previewSignature = computed(() =>
  JSON.stringify([result.value.prompt, subjectImage.value, environmentImage.value, sheet.value.format.aspectRatio, castStartFrame.value]))
const keyframeStale = computed(() => !!previewFrame.value && previewKey.value !== previewSignature.value)
const canPreview = computed(() => !!(subjectImage.value || environmentImage.value || sheet.value.subject.trim()))

function fetchImageAsDataUrl(url: string): Promise<string> {
  return fetch(url).then(r => r.blob()).then(blob => new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  }))
}

async function generatePreview() {
  if (previewBusy.value) return
  previewBusy.value = true
  previewError.value = null
  const sig = previewSignature.value
  try {
    const location = environmentImage.value
    const made = castStartFrame.value
    const person = made ? null : subjectImage.value
    const urls = made ? made.urls : [person, location].filter((u): u is string => !!u)
    const images = await Promise.all(urls.map(fetchImageAsDataUrl))
    const prompt = buildKeyframePrompt(sheet.value, {
      hasPerson: made ? true : !!person,
      hasLocation: !!location,
      castLine: made?.castLine,
    })
    const res = await $fetch<{ images?: string[] }>('/api/inpaint/nano-gen', {
      method: 'POST',
      body: { prompt, images, aspect_ratio: sheet.value.format.aspectRatio },
    })
    const out = res.images?.[0]
    if (!out) throw new Error('No image returned')
    previewFrame.value = out
    previewKey.value = sig
  } catch (err) {
    previewError.value = err instanceof Error ? err.message : 'Preview failed'
  } finally {
    previewBusy.value = false
  }
}

// ── Use the preview as the first frame ────────────────────────────────────────
const firstFrameBusy = ref(false)
async function useAsFirstFrame() {
  const frame = previewFrame.value
  if (!frame || firstFrameBusy.value) return
  firstFrameBusy.value = true
  previewError.value = null
  try {
    const blob = await fetch(frame).then(r => r.blob())
    const url = await uploadRefFile(new File([blob], 'first-frame.png', { type: blob.type || 'image/png' }))
    update(s => ({ ...s, firstFrame: url, mode: 'firstLastFrame' }))
  } catch (err) {
    previewError.value = err instanceof Error ? err.message : 'Upload failed'
  } finally {
    firstFrameBusy.value = false
  }
}

// ── Reference helpers ─────────────────────────────────────────────────────────
const imageRefs = computed(() =>
  sheet.value.references.filter(r => r.kind === 'image' && r.role !== 'location').sort((a, b) => a.slot - b.slot))
const videoRefs = computed(() =>
  sheet.value.references.filter(r => r.kind === 'video').sort((a, b) => a.slot - b.slot))
const audioRefs = computed(() =>
  sheet.value.references.filter(r => r.kind === 'audio').sort((a, b) => a.slot - b.slot))

const DEFAULT_ROLE_BY_KIND: Record<RefKind, RefRole> = {
  image: 'identity-lock',
  video: 'camera-copy',
  audio: 'mood',
}

function humanizeRole(role: string): string {
  return role.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// File input refs per kind
const fileInputImage = ref<HTMLInputElement | null>(null)
const fileInputVideo = ref<HTMLInputElement | null>(null)
const fileInputAudio = ref<HTMLInputElement | null>(null)

function fileInputForKind(kind: RefKind): HTMLInputElement | null {
  if (kind === 'image') return fileInputImage.value
  if (kind === 'video') return fileInputVideo.value
  return fileInputAudio.value
}

function triggerFileAdd(kind: RefKind) {
  fileInputForKind(kind)?.click()
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

async function onFileAdd(kind: RefKind, e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  // Upload to the input dir and store the small /view URL; data-URL fallback
  // only when the backend is unreachable (keeps the surface usable offline).
  const src = await uploadRefFile(file).catch(() => fileToDataUrl(file))
  addReference(kind, src, DEFAULT_ROLE_BY_KIND[kind])
  input.value = ''
}

function updateRefRole(kind: RefKind, slot: number, role: RefRole) {
  update(s => ({
    ...s,
    references: s.references.map(r =>
      r.kind === kind && r.slot === slot ? { ...r, role } : r
    ),
  }))
}

// First/last frame file add
const fileInputFirst = ref<HTMLInputElement | null>(null)
const fileInputLast = ref<HTMLInputElement | null>(null)

async function onFrameFile(which: 'firstFrame' | 'lastFrame', e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const src = await uploadRefFile(file).catch(() => fileToDataUrl(file))
  update(s => ({ ...s, [which]: src }))
  input.value = ''
}

// ── Lighting presets ───────────────────────────────────────────────────────────
const LIGHTING_PRESETS = ['golden hour', 'rim light', 'backlit', 'neon', 'soft daylight']

// ── Constraints chip editor ────────────────────────────────────────────────────
const newConstraint = ref('')
function addConstraint() {
  const v = newConstraint.value.trim()
  if (!v) return
  update(s => ({ ...s, constraints: [...s.constraints, v] }))
  newConstraint.value = ''
}
function removeConstraint(i: number) {
  update(s => ({ ...s, constraints: s.constraints.filter((_, idx) => idx !== i) }))
}

// ── Beats ──────────────────────────────────────────────────────────────────────
const beatsOpen = ref(false)

function addBeat() {
  if (sheet.value.format.durationS === -1 || sheet.value.beats.length >= 3) return
  const dur = sheet.value.format.durationS
  const lastEnd = sheet.value.beats.length > 0
    ? Math.max(...sheet.value.beats.map(b => b.endS))
    : 0
  const start = lastEnd
  const end = Math.min(start + Math.round(dur / 3), dur)
  const id = `beat-${Date.now()}`
  update(s => ({
    ...s,
    beats: [...s.beats, { id, startS: start, endS: end, action: '' }],
  }))
}

function removeBeat(id: string) {
  update(s => ({ ...s, beats: s.beats.filter(b => b.id !== id) }))
}

function patchBeat(id: string, patch: Record<string, unknown>) {
  update(s => ({
    ...s,
    beats: s.beats.map(b => b.id === id ? { ...b, ...patch } : b),
  }))
}

// ── Format helpers ─────────────────────────────────────────────────────────────
// 'adaptive' removed for v1: neither the FilmShotNode combo
// (_VIDEO_GEN_ASPECT_RATIOS) nor _SEEDANCE_AR accepts it — it silently
// coerces to 16:9. Re-add once the FilmShotNode combo + _SEEDANCE_AR are
// widened to support it (follow-up).
const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']
const DURATIONS = [5, 10, 15]
/** The lengths the chosen model can render; Auto only where it takes any length. */
const durationChoices = computed(() => profile.value.durations ?? DURATIONS)
// One line per model for the Model label's tooltip: what it is good at.
const MODEL_TIPS: Record<string, string> = {
  'seedance-2.0': 'Takes the most reference pictures, plus video and sound',
  'kling-v3': 'Keeps characters steady, starting from a first frame',
  'veo-3.1': 'Lifelike motion and sound, in 8-second clips',
  'veo-3.1-fast': 'Veo, quicker and cheaper',
}
const RESOLUTIONS = ['720p', '1080p']

const durationLabel = computed(() =>
  sheet.value.format.durationS === -1 ? 'Auto' : String(sheet.value.format.durationS) + 's'
)

function setDuration(v: string) {
  const n = v === 'auto' || v === '-1' ? -1 : Number(v)
  update(s => ({ ...s, format: { ...s.format, durationS: n } }))
}

// ── Dialogue lines ─────────────────────────────────────────────────────────────
function addDialogueLine() {
  update(s => ({
    ...s,
    audio: { ...s.audio, dialogue: [...(s.audio.dialogue ?? []), { speaker: '', line: '' }] },
  }))
}
function removeDialogueLine(i: number) {
  update(s => ({
    ...s,
    audio: { ...s.audio, dialogue: (s.audio.dialogue ?? []).filter((_, idx) => idx !== i) },
  }))
}
function patchDialogue(i: number, patch: { speaker?: string; line?: string }) {
  update(s => ({
    ...s,
    audio: {
      ...s.audio,
      dialogue: (s.audio.dialogue ?? []).map((d, idx) => idx === i ? { ...d, ...patch } : d),
    },
  }))
}
</script>

<template>
  <!-- Full-screen modal overlay -->
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
    <div
      role="dialog"
      aria-modal="true"
      class="flex h-[720px] max-h-[94vh] w-[1160px] max-w-[97vw] flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-[#0e0e10] text-white shadow-2xl outline-none"
    >
      <!-- Header -->
      <div class="flex shrink-0 items-center gap-2 border-b border-white/[0.06] px-4 pt-3 pb-2.5">
        <span class="text-[13px] font-medium tracking-[-0.01em] text-white/90">Shot Director</span>
        <select
          :value="profile.id"
          :title="MODEL_TIPS[profile.id]"
          aria-label="Model"
          class="ml-1 cursor-pointer rounded border border-white/15 bg-white/[0.06] px-1.5 py-0.5 text-[11px] text-white/80 outline-none hover:border-white/25 focus:border-white/30"
          @change="setModel(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="m in SHOT_MODEL_CHOICES" :key="m.id" :value="m.id" class="bg-neutral-900">{{ m.label }}</option>
        </select>
        <span class="flex-1" />
        <span class="rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-white/30">esc</span>
        <button type="button" aria-label="Close" class="ml-1 text-white/40 transition hover:text-white/80" @click="emit('close')">
          <X class="h-4 w-4" />
        </button>
      </div>

      <!-- Two-column body -->
      <div class="flex min-h-0 flex-1 gap-0">

        <!-- LEFT: editing controls (scrollable) -->
        <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto border-r border-white/[0.06] p-4">

          <!-- First-open guide: teaches the flow, disappears the moment work starts -->
          <div v-if="showIntro" class="rounded-lg border border-white/[0.08] bg-white/[0.02] p-3">
            <p class="text-[12px] font-medium text-white/80">Direct a shot in three steps</p>
            <ol class="mt-2 space-y-1.5 text-[11px] leading-relaxed text-white/50">
              <li><span class="mr-1.5 text-white/30">1</span><span class="text-white/70">Cast a character</span> or add reference photos — the model follows images far more than words.</li>
              <li><span class="mr-1.5 text-white/30">2</span><span class="text-white/70">Describe the shot</span> — a subject and one clear action. Everything else is optional.</li>
              <li><span class="mr-1.5 text-white/30">3</span><span class="text-white/70">Generate</span> — the cost shows on the button; a failed run isn't charged.</li>
            </ol>
          </div>

          <!-- ═══ REFERENCE RAIL (primary, top) ═════════════════════════════ -->
          <div class="rounded-lg border border-white/[0.12] bg-white/[0.03]">
            <!-- Mode toggle -->
            <div class="flex items-center gap-0 border-b border-white/[0.08] p-1">
              <button
                type="button"
                class="flex-1 rounded py-1.5 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-white/40"
                :class="sheet.mode === 'reference' ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/70'"
                :disabled="profile.requiresFirstFrame"
                :title="profile.requiresFirstFrame ? `${profile.label} starts from a first frame.` : undefined"
                @click="update(s => ({ ...s, mode: 'reference' }))"
              >Reference</button>
              <button
                type="button"
                class="flex-1 rounded py-1.5 text-[11px] font-medium transition-colors"
                :class="sheet.mode === 'firstLastFrame' ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/70'"
                @click="update(s => ({ ...s, mode: 'firstLastFrame' }))"
              >First / Last frame</button>
            </div>

            <!-- Cast (every mode), then the mode's own references -->
            <div class="space-y-4 p-3">

              <!-- Hidden file inputs -->
              <input ref="fileInputImage" type="file" accept="image/*" class="hidden" @change="onFileAdd('image', $event)" />
              <input ref="fileInputVideo" type="file" accept="video/*" class="hidden" @change="onFileAdd('video', $event)" />
              <input ref="fileInputAudio" type="file" accept="audio/*" class="hidden" @change="onFileAdd('audio', $event)" />

              <!-- Cast: registry-linked characters; refs materialize at compile time -->
              <div class="mb-3">
                <div class="mb-1.5 flex items-center justify-between">
                  <span class="text-[11px] font-medium uppercase tracking-wide text-white/50">Cast <span class="normal-case">≤3</span></span>
                  <button
                    class="rounded bg-white/[0.06] px-2 py-1 text-[11px] text-white/70 hover:bg-white/10 disabled:opacity-40"
                    :disabled="sheet.cast.length >= 3"
                    @click="castPickerOpen = true"
                  >+ Cast</button>
                </div>
                <div v-if="sheet.cast.length" class="flex flex-wrap gap-1.5">
                  <span
                    v-for="m in sheet.cast" :key="m.slug"
                    class="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.05] py-0.5 pl-0.5 pr-2 text-[11px] text-white/80"
                  >
                    <img v-if="castCover(m)" :src="castCover(m)!" class="h-5 w-5 rounded-full object-cover" :alt="m.name">
                    {{ m.name }}<span v-if="variantLabel(m)" class="text-white/50"> · {{ variantLabel(m) }}</span>
                    <span v-if="variantMissing(m)" class="text-[10px] text-amber-400/90" title="The selected look was deleted — this shot will use their Default look">· Default (look deleted)</span>
                    <span v-if="m.via === 'wire'" class="text-[9px] text-white/35" title="Cast by canvas wire — remove by unwiring or here">⌁</span>
                    <button class="text-white/35 hover:text-white/80" @click="onRemoveCast(m)">×</button>
                  </span>
                </div>
                <p v-else class="text-[11px] text-white/30">No one cast yet — pick a saved character and their reference photos attach automatically.</p>

                <!-- What the cast actually sends: each member's photos + their [ImageN] tags -->
                <div v-if="sheet.cast.length" class="mt-2 space-y-1.5">
                  <div v-for="row in castRefRows" :key="'refs-' + row.slug" class="flex items-center gap-2">
                    <span class="w-16 shrink-0 truncate text-[10px] text-white/40">{{ row.name }}</span>
                    <img
                      v-for="(u, i) in row.urls" :key="u" :src="u"
                      class="h-9 w-9 rounded border border-white/[0.08] object-cover"
                      :title="row.tags[i]"
                    >
                    <span v-if="row.urls.length" class="text-[10px] tabular-nums text-white/30">{{ row.tag }}</span>
                    <span v-else class="text-[10px] text-red-400/80">{{ row.variantLabel ? `${row.variantLabel} — ` : '' }}no photos yet — add some to their sheet</span>
                  </div>
                  <p class="text-[10px] leading-relaxed text-white/35">
                    Face and clothing follow these photos. Change the look in their character sheet (Characters panel) —
                    or restyle just this shot by describing the outfit in Subject (e.g. “{{ sheet.cast[0]?.name }} in a yellow raincoat”).
                  </p>
                </div>
              </div>

              <CharacterPickerModal
                v-if="castPickerOpen"
                :exclude-slugs="sheet.cast.map(m => m.slug)"
                @pick="(slug, name, stateId) => { addCastMember(slug, name, 'picker', stateId); castPickerOpen = false }"
                @close="castPickerOpen = false"
              />

            <!-- Reference mode -->
            <template v-if="sheet.mode === 'reference'">

              <!-- Images (≤9) -->
              <div>
                <div class="mb-1.5 flex items-center justify-between">
                  <span class="text-[10px] font-medium uppercase tracking-widest text-white/35">Images <span class="text-white/20">≤9</span></span>
                  <button
                    v-if="imageRefs.length < 9"
                    type="button"
                    class="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-white/40 transition hover:bg-white/10 hover:text-white/70"
                    @click="triggerFileAdd('image')"
                  ><Plus class="h-3 w-3" /> Add</button>
                </div>
                <div v-if="imageRefs.length === 0" class="rounded border border-dashed border-white/10 py-3 text-center text-[11px] text-white/25">
                  No images — Add uploads a photo. References steer the result more than words do.
                </div>
                <div class="space-y-1.5">
                  <div
                    v-for="ref in imageRefs" :key="ref.slot"
                    class="flex items-center gap-2 rounded-md border border-white/[0.07] bg-white/[0.03] px-2 py-1.5"
                  >
                    <!-- Tag -->
                    <span class="shrink-0 rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] text-white/60">[Image{{ ref.slot }}]</span>
                    <!-- Thumbnail (data URL or hosted URL) -->
                    <img
                      v-if="ref.src"
                      :src="ref.src"
                      class="h-10 w-10 shrink-0 rounded object-cover border border-white/10"
                      alt=""
                    />
                    <!-- Role dropdown -->
                    <select
                      :value="ref.role"
                      class="min-w-0 flex-1 rounded border border-white/10 bg-transparent px-1.5 py-0.5 text-[11px] text-white/70 outline-none focus:border-white/30"
                      @change="updateRefRole('image', ref.slot, ($event.target as HTMLSelectElement).value as RefRole)"
                    >
                      <option
                        v-for="role in ROLES_BY_KIND.image" :key="role"
                        :value="role"
                        class="bg-neutral-900"
                      >{{ humanizeRole(role) }}</option>
                    </select>
                    <!-- Remove -->
                    <button type="button" class="shrink-0 rounded p-0.5 text-white/30 transition hover:bg-white/10 hover:text-white/70" @click="removeReference('image', ref.slot)">
                      <X class="h-3 w-3" />
                    </button>
                  </div>
                </div>
              </div>

              <!-- Videos (≤3) -->
              <div>
                <div class="mb-1.5 flex items-center justify-between">
                  <span class="text-[10px] font-medium uppercase tracking-widest text-white/35">Videos <span class="text-white/20">≤3</span></span>
                  <button
                    v-if="videoRefs.length < 3"
                    type="button"
                    class="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-white/40 transition hover:bg-white/10 hover:text-white/70"
                    @click="triggerFileAdd('video')"
                  ><Plus class="h-3 w-3" /> Add</button>
                </div>
                <div v-if="videoRefs.length === 0" class="rounded border border-dashed border-white/10 py-3 text-center text-[11px] text-white/25">
                  No videos
                </div>
                <div class="space-y-1.5">
                  <div
                    v-for="ref in videoRefs" :key="ref.slot"
                    class="flex items-center gap-2 rounded-md border border-white/[0.07] bg-white/[0.03] px-2 py-1.5"
                  >
                    <span class="shrink-0 rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] text-white/60">[Video{{ ref.slot }}]</span>
                    <select
                      :value="ref.role"
                      class="min-w-0 flex-1 rounded border border-white/10 bg-transparent px-1.5 py-0.5 text-[11px] text-white/70 outline-none focus:border-white/30"
                      @change="updateRefRole('video', ref.slot, ($event.target as HTMLSelectElement).value as RefRole)"
                    >
                      <option
                        v-for="role in ROLES_BY_KIND.video" :key="role"
                        :value="role"
                        class="bg-neutral-900"
                      >{{ humanizeRole(role) }}</option>
                    </select>
                    <button type="button" class="shrink-0 rounded p-0.5 text-white/30 transition hover:bg-white/10 hover:text-white/70" @click="removeReference('video', ref.slot)">
                      <X class="h-3 w-3" />
                    </button>
                  </div>
                </div>
              </div>

              <!-- Audio (≤3) -->
              <div>
                <div class="mb-1.5 flex items-center justify-between">
                  <span class="text-[10px] font-medium uppercase tracking-widest text-white/35">Audio <span class="text-white/20">≤3</span></span>
                  <button
                    v-if="audioRefs.length < 3"
                    type="button"
                    class="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-white/40 transition hover:bg-white/10 hover:text-white/70"
                    @click="triggerFileAdd('audio')"
                  ><Plus class="h-3 w-3" /> Add</button>
                </div>
                <div v-if="audioRefs.length === 0" class="rounded border border-dashed border-white/10 py-3 text-center text-[11px] text-white/25">
                  No audio
                </div>
                <div class="space-y-1.5">
                  <div
                    v-for="ref in audioRefs" :key="ref.slot"
                    class="flex items-center gap-2 rounded-md border border-white/[0.07] bg-white/[0.03] px-2 py-1.5"
                  >
                    <span class="shrink-0 rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] text-white/60">[Audio{{ ref.slot }}]</span>
                    <select
                      :value="ref.role"
                      class="min-w-0 flex-1 rounded border border-white/10 bg-transparent px-1.5 py-0.5 text-[11px] text-white/70 outline-none focus:border-white/30"
                      @change="updateRefRole('audio', ref.slot, ($event.target as HTMLSelectElement).value as RefRole)"
                    >
                      <option
                        v-for="role in ROLES_BY_KIND.audio" :key="role"
                        :value="role"
                        class="bg-neutral-900"
                      >{{ humanizeRole(role) }}</option>
                    </select>
                    <button type="button" class="shrink-0 rounded p-0.5 text-white/30 transition hover:bg-white/10 hover:text-white/70" @click="removeReference('audio', ref.slot)">
                      <X class="h-3 w-3" />
                    </button>
                  </div>
                </div>
              </div>
            </template>

            <!-- First / Last frame mode -->
            <div v-else class="space-y-3">
              <input ref="fileInputFirst" type="file" accept="image/*" class="hidden" @change="onFrameFile('firstFrame', $event)" />
              <input ref="fileInputLast" type="file" accept="image/*" class="hidden" @change="onFrameFile('lastFrame', $event)" />
              <div class="flex gap-3">
                <div class="flex-1">
                  <p class="mb-1.5 text-[11px] text-white/40">First frame</p>
                  <div
                    class="relative flex h-20 cursor-pointer items-center justify-center overflow-hidden rounded-lg border border-dashed border-white/15 bg-white/[0.03] transition hover:border-white/30"
                    @click="fileInputFirst?.click()"
                  >
                    <img v-if="sheet.firstFrame" :src="sheet.firstFrame" class="absolute inset-0 h-full w-full object-cover" alt="" />
                    <span v-else class="text-[11px] text-white/25">+ Add image</span>
                  </div>
                  <button v-if="sheet.firstFrame" type="button" class="mt-1 text-[10px] text-white/30 hover:text-white/60" @click="update(s => ({ ...s, firstFrame: undefined }))">Remove</button>
                </div>
                <div class="flex-1">
                  <p class="mb-1.5 text-[11px] text-white/40">Last frame</p>
                  <div
                    class="relative flex h-20 cursor-pointer items-center justify-center overflow-hidden rounded-lg border border-dashed border-white/15 bg-white/[0.03] transition hover:border-white/30"
                    @click="fileInputLast?.click()"
                  >
                    <img v-if="sheet.lastFrame" :src="sheet.lastFrame" class="absolute inset-0 h-full w-full object-cover" alt="" />
                    <span v-else class="text-[11px] text-white/25">+ Add image</span>
                  </div>
                  <button v-if="sheet.lastFrame" type="button" class="mt-1 text-[10px] text-white/30 hover:text-white/60" @click="update(s => ({ ...s, lastFrame: undefined }))">Remove</button>
                </div>
              </div>
            </div>
            </div>
          </div>

          <!-- ═══ SHOT FIELDS ═══════════════════════════════════════════════ -->
          <StudioSection title="Shot">
            <p class="text-[11px] leading-relaxed text-white/35">Who + one clear action — short beats long, under 100 words reads best. Cast members are referred to by name.</p>
            <!-- Subject -->
            <div>
              <label class="mb-1 block text-[11px] text-white/45">Subject</label>
              <input
                type="text"
                :value="sheet.subject"
                placeholder="e.g. A woman in a red coat"
                class="w-full rounded border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[12px] text-white/90 placeholder:text-white/25 outline-none focus:border-white/25"
                @input="update(s => ({ ...s, subject: ($event.target as HTMLInputElement).value }))"
              />
            </div>
            <!-- Action -->
            <div>
              <label class="mb-1 block text-[11px] text-white/45">Action</label>
              <input
                type="text"
                :value="sheet.action"
                placeholder="e.g. walks slowly toward camera"
                class="w-full rounded border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[12px] text-white/90 placeholder:text-white/25 outline-none focus:border-white/25"
                @input="update(s => ({ ...s, action: ($event.target as HTMLInputElement).value }))"
              />
            </div>
            <!-- Environment -->
            <div>
              <label class="mb-1 block text-[11px] text-white/45">Environment</label>
              <input
                type="text"
                :value="sheet.environment"
                placeholder="e.g. rainy street, neon signs"
                class="w-full rounded border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[12px] text-white/90 placeholder:text-white/25 outline-none focus:border-white/25"
                @input="update(s => ({ ...s, environment: ($event.target as HTMLInputElement).value }))"
              />
              <!-- Location plate: reference mode only; steers the setting + backs the frame -->
              <div v-if="sheet.mode === 'reference'" class="mt-1.5">
                <input ref="fileInputEnv" type="file" accept="image/*" class="hidden" @change="onEnvironmentFile" />
                <div v-if="environmentImage" class="flex items-center gap-2 rounded-md border border-white/[0.07] bg-white/[0.03] px-2 py-1.5">
                  <img :src="environmentImage" class="h-9 w-14 shrink-0 rounded border border-white/10 object-cover" alt="" />
                  <span class="flex-1 text-[10px] leading-relaxed text-white/40">Location plate — steers the setting, and backs the frame.</span>
                  <button type="button" class="rounded px-1.5 py-0.5 text-[10px] text-white/45 transition hover:bg-white/10 hover:text-white/80" @click="fileInputEnv?.click()">Replace</button>
                  <button type="button" class="rounded p-0.5 text-white/30 transition hover:bg-white/10 hover:text-white/70" @click="removeReference('image', environmentRef!.slot)">
                    <X class="h-3 w-3" />
                  </button>
                </div>
                <div v-else class="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    class="flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-[10px] text-white/50 transition hover:bg-white/10 hover:text-white/80"
                    @click="fileInputEnv?.click()"
                  ><Plus class="h-3 w-3" /> Attach location</button>
                  <button
                    type="button"
                    class="gen-pastel flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium text-neutral-900 transition disabled:opacity-40 disabled:cursor-not-allowed"
                    :class="{ 'animate-pulse': envGenerating }"
                    :disabled="!sheet.environment.trim() || envGenerating"
                    :title="sheet.environment.trim() ? 'Generate a location plate from the environment text' : 'Describe the environment first'"
                    @click="generateEnvironment"
                  ><Sparkles class="h-3 w-3" /> {{ envGenerating ? 'Generating…' : 'Generate ~$0.01' }}</button>
                  <span class="text-[10px] text-white/30">an image steers the setting far more than words</span>
                </div>
                <p v-if="envError" class="mt-1 text-[10px] text-red-400/80">{{ envError }}</p>
              </div>
            </div>
            <!-- Lighting (prominent + presets) -->
            <div>
              <label class="mb-1 block text-[11px] text-white/45">Lighting</label>
              <input
                type="text"
                :value="sheet.lighting"
                placeholder="e.g. golden hour"
                class="w-full rounded border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[12px] text-white/90 placeholder:text-white/25 outline-none focus:border-white/25"
                @input="update(s => ({ ...s, lighting: ($event.target as HTMLInputElement).value }))"
              />
              <div class="mt-1.5 flex flex-wrap gap-1">
                <button
                  v-for="preset in LIGHTING_PRESETS" :key="preset"
                  type="button"
                  class="rounded border px-2 py-0.5 text-[10px] transition-colors"
                  :class="sheet.lighting === preset
                    ? 'border-white/30 bg-white/10 text-white/80'
                    : 'border-white/10 text-white/35 hover:border-white/20 hover:text-white/60'"
                  @click="update(s => ({ ...s, lighting: sheet.lighting === preset ? '' : preset }))"
                >{{ preset }}</button>
              </div>
            </div>
            <!-- Style -->
            <div>
              <label class="mb-1 block text-[11px] text-white/45">Style</label>
              <input
                type="text"
                :value="sheet.style"
                placeholder="e.g. cinematic, 35mm film grain"
                class="w-full rounded border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[12px] text-white/90 placeholder:text-white/25 outline-none focus:border-white/25"
                @input="update(s => ({ ...s, style: ($event.target as HTMLInputElement).value }))"
              />
            </div>
          </StudioSection>

          <!-- ═══ CAMERA (visual pickers) ════════════════════════════════════ -->
          <StudioSection title="Camera">
            <p class="text-[11px] leading-relaxed text-white/35">One move per shot — the model follows a single camera instruction far better than a compound one.</p>
            <ShotCameraPicker
              :shot-type="sheet.camera.shotType"
              :move="sheet.camera.move"
              :pacing="sheet.camera.pacing"
              :direction="sheet.camera.direction"
              @update:shot-type="v => update(s => ({ ...s, camera: { ...s.camera, shotType: v } }))"
              @update:move="v => update(s => ({ ...s, camera: { ...s.camera, move: v } }))"
              @update:direction="v => update(s => ({ ...s, camera: { ...s.camera, direction: v } }))"
              @update:pacing="v => update(s => ({ ...s, camera: { ...s.camera, pacing: v } }))"
            />
          </StudioSection>

          <!-- ═══ CONSTRAINTS ════════════════════════════════════════════════ -->
          <StudioSection title="Constraints">
            <div class="flex flex-wrap gap-1.5">
              <span
                v-for="(c, i) in sheet.constraints" :key="i"
                class="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.05] px-2 py-0.5 text-[11px] text-white/60"
              >
                {{ c }}
                <button type="button" class="ml-0.5 text-white/30 hover:text-white/70" @click="removeConstraint(i)">×</button>
              </span>
            </div>
            <div class="flex gap-1.5">
              <input
                v-model="newConstraint"
                type="text"
                placeholder="e.g. no camera shake"
                class="min-w-0 flex-1 rounded border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[11px] text-white/80 placeholder:text-white/25 outline-none focus:border-white/25"
                @keydown.enter.prevent="addConstraint"
              />
              <button
                type="button"
                class="shrink-0 rounded border border-white/10 px-2.5 py-1.5 text-[11px] text-white/50 transition hover:bg-white/10 hover:text-white/80"
                @click="addConstraint"
              >Add</button>
            </div>
          </StudioSection>

          <!-- ═══ BEAT BOARD (collapsible) ══════════════════════════════════ -->
          <StudioSection title="Beats" :open="beatsOpen">
            <div class="space-y-2">
              <div
                v-for="beat in sheet.beats" :key="beat.id"
                class="rounded-md border border-white/[0.08] bg-white/[0.03] p-2.5 space-y-2"
              >
                <!-- Time range -->
                <div class="flex items-center gap-2">
                  <label class="shrink-0 text-[10px] text-white/40">Start</label>
                  <input
                    type="number"
                    :value="beat.startS"
                    min="0"
                    :max="sheet.format.durationS > 0 ? sheet.format.durationS : 999"
                    class="w-16 rounded border border-white/10 bg-transparent px-1.5 py-0.5 text-[11px] text-white/80 outline-none"
                    @change="patchBeat(beat.id, { startS: Number(($event.target as HTMLInputElement).value) })"
                  />
                  <label class="shrink-0 text-[10px] text-white/40">End</label>
                  <input
                    type="number"
                    :value="beat.endS"
                    min="0"
                    :max="sheet.format.durationS > 0 ? sheet.format.durationS : 999"
                    class="w-16 rounded border border-white/10 bg-transparent px-1.5 py-0.5 text-[11px] text-white/80 outline-none"
                    @change="patchBeat(beat.id, { endS: Number(($event.target as HTMLInputElement).value) })"
                  />
                  <button type="button" class="ml-auto text-white/25 hover:text-white/60" @click="removeBeat(beat.id)">
                    <X class="h-3 w-3" />
                  </button>
                </div>
                <!-- Action -->
                <input
                  type="text"
                  :value="beat.action"
                  placeholder="What happens in this beat"
                  class="w-full rounded border border-white/10 bg-transparent px-2 py-1 text-[11px] text-white/80 placeholder:text-white/25 outline-none focus:border-white/25"
                  @input="patchBeat(beat.id, { action: ($event.target as HTMLInputElement).value })"
                />
                <!-- Optional overrides -->
                <div class="flex gap-1.5">
                  <select
                    :value="beat.shotType ?? ''"
                    class="flex-1 rounded border border-white/10 bg-[#0e0e10] px-1.5 py-1 text-[10px] text-white/60 outline-none"
                    @change="patchBeat(beat.id, { shotType: ($event.target as HTMLSelectElement).value || undefined })"
                  >
                    <option value="" class="bg-neutral-900">Shot (inherit)</option>
                    <option v-for="(label, key) in SHOT_TYPE_PHRASE" :key="key" :value="key" class="bg-neutral-900">{{ label }}</option>
                  </select>
                  <select
                    :value="beat.move ?? ''"
                    class="flex-1 rounded border border-white/10 bg-[#0e0e10] px-1.5 py-1 text-[10px] text-white/60 outline-none"
                    @change="patchBeat(beat.id, { move: ($event.target as HTMLSelectElement).value || undefined })"
                  >
                    <option value="" class="bg-neutral-900">Move (inherit)</option>
                    <option v-for="(label, key) in CAMERA_MOVE_PHRASE" :key="key" :value="key" class="bg-neutral-900">{{ label }}</option>
                  </select>
                </div>
              </div>

              <button
                type="button"
                class="flex w-full items-center justify-center gap-1.5 rounded border border-dashed border-white/10 py-1.5 text-[11px] text-white/35 transition hover:border-white/25 hover:text-white/60 disabled:opacity-30 disabled:cursor-not-allowed"
                :disabled="sheet.format.durationS === -1 || sheet.beats.length >= 3"
                @click="addBeat"
              >
                <Plus class="h-3 w-3" />
                Add beat
                <span v-if="sheet.format.durationS === -1" class="text-white/25">(set duration first)</span>
                <span v-else-if="sheet.beats.length >= 3" class="text-white/25">(max 3)</span>
              </button>
            </div>
          </StudioSection>

          <!-- ═══ FORMAT BAR ══════════════════════════════════════════════════ -->
          <StudioSection title="Format">
            <div class="grid grid-cols-2 gap-x-3 gap-y-2.5">
              <!-- Aspect ratio -->
              <div v-if="sheet.mode === 'reference'">
                <label class="mb-1 block text-[11px] text-white/45">Aspect ratio</label>
                <select
                  :value="sheet.format.aspectRatio"
                  class="w-full rounded border border-white/10 bg-[#0e0e10] px-2 py-1.5 text-[11px] text-white/80 outline-none focus:border-white/25"
                  @change="update(s => ({ ...s, format: { ...s.format, aspectRatio: ($event.target as HTMLSelectElement).value } }))"
                >
                  <option v-for="ar in ASPECT_RATIOS" :key="ar" :value="ar" class="bg-neutral-900">{{ ar }}</option>
                </select>
              </div>
              <!-- Duration -->
              <div>
                <label class="mb-1 block text-[11px] text-white/45">Duration</label>
                <select
                  :value="sheet.format.durationS === -1 ? 'auto' : String(sheet.format.durationS)"
                  class="w-full rounded border border-white/10 bg-[#0e0e10] px-2 py-1.5 text-[11px] text-white/80 outline-none focus:border-white/25"
                  @change="setDuration(($event.target as HTMLSelectElement).value)"
                >
                  <option v-if="!profile.durations" value="auto" class="bg-neutral-900">Auto</option>
                  <option v-for="d in durationChoices" :key="d" :value="String(d)" class="bg-neutral-900">{{ d }}s</option>
                </select>
              </div>
              <!-- Resolution -->
              <div>
                <label class="mb-1 block text-[11px] text-white/45">Resolution</label>
                <select
                  :value="sheet.format.resolution"
                  class="w-full rounded border border-white/10 bg-[#0e0e10] px-2 py-1.5 text-[11px] text-white/80 outline-none focus:border-white/25"
                  @change="update(s => ({ ...s, format: { ...s.format, resolution: ($event.target as HTMLSelectElement).value } }))"
                >
                  <option v-for="r in RESOLUTIONS" :key="r" :value="r" class="bg-neutral-900">{{ r }}</option>
                </select>
              </div>
              <!-- Seed -->
              <div>
                <label class="mb-1 block text-[11px] text-white/45">Seed <span class="text-white/20">(optional)</span></label>
                <input
                  type="number"
                  :value="sheet.format.seed ?? ''"
                  placeholder="random"
                  class="w-full rounded border border-white/10 bg-white/[0.04] px-2 py-1.5 text-[11px] text-white/80 placeholder:text-white/25 outline-none focus:border-white/25"
                  @input="update(s => ({ ...s, format: { ...s.format, seed: ($event.target as HTMLInputElement).value ? Number(($event.target as HTMLInputElement).value) : undefined } }))"
                />
              </div>
            </div>

            <!-- Generate audio toggle -->
            <div class="flex items-center justify-between pt-1">
              <span class="text-[11px] text-white/50">Generate audio</span>
              <button
                type="button"
                class="h-5 w-9 rounded-full transition-colors"
                :class="sheet.audio.generate ? 'bg-white/30' : 'bg-white/10'"
                @click="update(s => ({ ...s, audio: { ...s.audio, generate: !s.audio.generate } }))"
              >
                <span
                  class="block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform mx-0.5"
                  :class="sheet.audio.generate ? 'translate-x-4' : 'translate-x-0'"
                />
              </button>
            </div>

            <!-- Dialogue lines editor -->
            <div v-if="sheet.audio.generate" class="space-y-1.5">
              <div class="flex items-center justify-between">
                <label class="text-[11px] text-white/40">Dialogue lines</label>
                <button type="button" class="flex items-center gap-0.5 text-[10px] text-white/35 hover:text-white/60" @click="addDialogueLine">
                  <Plus class="h-3 w-3" /> Add line
                </button>
              </div>
              <div
                v-for="(line, i) in (sheet.audio.dialogue ?? [])" :key="i"
                class="flex gap-1.5"
              >
                <input
                  type="text"
                  :value="line.speaker ?? ''"
                  placeholder="Speaker"
                  class="w-24 shrink-0 rounded border border-white/10 bg-white/[0.04] px-1.5 py-1 text-[11px] text-white/70 placeholder:text-white/20 outline-none"
                  @input="patchDialogue(i, { speaker: ($event.target as HTMLInputElement).value })"
                />
                <input
                  type="text"
                  :value="line.line"
                  placeholder="Line…"
                  class="min-w-0 flex-1 rounded border border-white/10 bg-white/[0.04] px-1.5 py-1 text-[11px] text-white/80 placeholder:text-white/20 outline-none"
                  @input="patchDialogue(i, { line: ($event.target as HTMLInputElement).value })"
                />
                <button type="button" class="shrink-0 text-white/25 hover:text-white/60" @click="removeDialogueLine(i)">
                  <X class="h-3 w-3" />
                </button>
              </div>
            </div>
          </StudioSection>

        </div><!-- /left column -->

        <!-- RIGHT: viewfinder-first preview -->
        <div class="flex w-[380px] shrink-0 flex-col gap-3 overflow-y-auto p-4">

          <!-- Viewfinder — the frame is the loudest thing on screen -->
          <ShotViewfinder
            :aspect-ratio="sheet.format.aspectRatio"
            :duration-label="durationLabel"
            :shot-type="sheet.camera.shotType"
            :move="sheet.camera.move"
            :direction="sheet.camera.direction"
            :mode="sheet.mode"
            :subject-image="subjectImage"
            :subject-label="subjectLabel"
            :environment-image="environmentImage"
            :keyframe="previewFrame"
            :keyframe-stale="keyframeStale"
            :first-frame="sheet.firstFrame"
            :last-frame="sheet.lastFrame"
          />

          <!-- Keyframe preview: a photoreal still from the same refs Seedance uses -->
          <div class="flex flex-col gap-1">
            <button
              type="button"
              class="gen-pastel flex items-center justify-center gap-1.5 rounded px-3 py-1.5 text-[11px] font-medium text-neutral-900 transition disabled:opacity-40 disabled:cursor-not-allowed"
              :class="{ 'animate-pulse': previewBusy }"
              :disabled="previewBusy || !canPreview"
              title="Generate a photoreal preview frame from the same references Seedance uses"
              @click="generatePreview"
            >
              <Sparkles class="h-3 w-3" />
              {{ previewBusy
                ? 'Rendering preview…'
                : previewFrame
                  ? (keyframeStale ? `Update preview · ${previewCost}` : `Refresh preview · ${previewCost}`)
                  : `Preview frame · ${previewCost}` }}
            </button>
            <p v-if="previewError" class="text-[10px] text-red-400/80">{{ previewError }}</p>
            <p v-else class="text-[10px] leading-relaxed text-white/30">A quick photoreal still from your references — a real look before the slow full run.</p>
          </div>

          <button
            v-if="previewFrame && !previewBusy"
            type="button"
            class="-mt-2 flex items-center justify-center gap-1.5 rounded border border-white/10 px-3 py-1.5 text-[11px] text-white/70 transition hover:bg-white/10 hover:text-white/90 disabled:opacity-40 disabled:cursor-not-allowed"
            :disabled="firstFrameBusy"
            @click="useAsFirstFrame"
          >{{ firstFrameBusy ? 'Saving…' : 'Use as first frame' }}</button>

          <!-- Issues (errors block generate) -->
          <div v-if="result.issues.length > 0" class="space-y-1">
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

          <!-- Compiled prompt — kept visible, demoted below the frame. The word
               count rides here as a quiet hint rather than a full meter. -->
          <div class="flex min-h-0 flex-1 flex-col gap-1.5">
            <div class="flex items-center justify-between">
              <span class="text-[11px] text-white/40">Compiled prompt <span class="text-white/25">— what gets sent</span></span>
              <span class="text-[10px] tabular-nums" :class="wordCountClass" title="≤100 words reads best">{{ result.wordCount }} words</span>
            </div>
            <div class="min-h-0 flex-1 overflow-y-auto rounded-lg border border-white/[0.08] bg-black/30 p-3">
              <pre class="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-white/75">{{ result.prompt || '(empty — fill in Subject and Action on the left and the prompt builds itself)' }}</pre>
            </div>
            <!-- Copy actions: secondary, ghost, side-by-side -->
            <div class="flex gap-1.5">
              <button
                type="button"
                class="flex flex-1 items-center justify-center gap-1.5 rounded border px-2 py-1.5 text-[11px] transition-colors"
                :class="copiedPrompt
                  ? 'border-action/40 bg-action/10 text-action'
                  : 'border-white/10 text-white/50 hover:border-white/20 hover:text-white/80'"
                @click="copyPrompt"
              >
                <Check v-if="copiedPrompt" class="h-3 w-3" />
                <Copy v-else class="h-3 w-3" />
                {{ copiedPrompt ? 'Copied' : 'Prompt' }}
              </button>
              <button
                type="button"
                class="flex flex-1 items-center justify-center gap-1.5 rounded border px-2 py-1.5 text-[11px] transition-colors"
                :class="copiedJson
                  ? 'border-action/40 bg-action/10 text-action'
                  : 'border-white/10 text-white/50 hover:border-white/20 hover:text-white/80'"
                @click="copyJson"
              >
                <Check v-if="copiedJson" class="h-3 w-3" />
                <Copy v-else class="h-3 w-3" />
                {{ copiedJson ? 'Copied' : 'JSON' }}
              </button>
            </div>
          </div>

        </div><!-- /right column -->

      </div><!-- /two-column body -->

      <!-- Footer -->
      <div class="flex shrink-0 items-center gap-2 border-t border-white/[0.06] px-4 py-2.5">
        <span class="text-[10px] text-white/25">Failed runs aren't charged.</span>
        <span class="flex-1" />
        <span
          v-for="c in takeScoreChips" :key="c.key"
          class="rounded-full border px-2 py-0.5 text-[11px] tabular-nums"
          :class="c.tone === 'amber' ? 'border-amber-400/30 bg-amber-400/10 text-amber-300/90' : 'border-white/10 bg-white/[0.05] text-white/70'"
          :title="c.tip"
        >{{ c.text }}</span>
        <button
          type="button"
          class="rounded bg-white/[0.06] px-2.5 py-1.5 text-[12px] text-white/70 transition hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed"
          :disabled="hasErrors"
          title="Reroll the seed and generate a new variant"
          @click="onNewTake"
        >
          New take
        </button>
        <button
          type="button"
          class="rounded bg-action/15 px-3.5 py-1.5 text-[12px] font-medium text-action tabular-nums transition hover:bg-action/25 disabled:opacity-40 disabled:cursor-not-allowed"
          :disabled="hasErrors"
          :title="'Estimated provider cost for this shot'"
          @click="onGenerate"
        >
          Generate · {{ formatShotUSD(sheet, sheet.model) }}
        </button>
      </div>
    </div>
  </div>
</template>
