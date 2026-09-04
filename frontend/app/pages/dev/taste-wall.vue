<script setup lang="ts">
/**
 * /dev/taste-wall — the executable-brand-kit spike's instrument
 * (docs/superpowers/spikes/2026-08-05-executable-brand-kit-spike.md).
 *
 * Rows = three studios (Gradient, Shader, Vector Type), columns =
 * neutral / elicited-A (deterministic) / elicited-A (Fable) / observed /
 * elicited-B (the anti-board control). Fixed composition discipline: same
 * gradient seed, same shader source image (the neutral gradient), same text —
 * only taste-driven params differ between columns.
 *
 * Board A/B come from `input/lora_dataset_*` via /api/dataset-match +
 * /api/training-image; images are downscaled client-side (64×64 RGBA for the
 * free deterministic /api/taste/analyze, ~768px JPEG for the BYOK Fable
 * /api/taste/read). The API key lives in a ref only — never persisted.
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { gradientFx } from '~/lib/gradientfx/renderer'
import { defaultConfig as gradientDefaultConfig } from '~/lib/gradientfx/randomize'
import { cloneConfig, ensureConfigDefaults, type GradientConfig } from '~/lib/gradientfx/types'
import { GRADIENT_GUIDANCE, gradientAgentControls } from '~/lib/gradientfx/agentControls'
import { buildGradientPreset } from '~/lib/gradientfx/presets'
import { makeConfigParams } from '~/lib/agent/configParams'
import { describeControls, validatePatch } from '~/lib/spacetype/controlDescriptor'
import type { ParamValue } from '~/lib/spacetype/effect'
import { defaultConfig as shaderDefaultConfig, type ShaderStudioConfig } from '~/lib/shaderstudio/types'
import { composePasses } from '~/lib/shaderstudio/passes'
import { shaderFx } from '~/lib/shaderfx/renderer'
import { fetchShaderFxCatalog, getEffectSync } from '~/lib/shaderfx/catalog'
import { drawVectorTypeToCanvas } from '~/lib/vectortype/canvas'
import { loadVectorFont, type VtFont } from '~/lib/vectortype/font'
import { DEFAULT_CONFIG, mergeConfig, type VectorTypeConfig } from '~/lib/vectortype/config'
import { applyTasteToConfigs, CONFIDENCE_FLOOR, enforcePaletteOnGradient } from '~/lib/taste/mapping'
import { applyEffectChain, type PostEffect } from '~/lib/compositor/postEffects'
import { tastedPrompt } from '~/lib/taste/styleBlock'
import { IMAGE_MODELS_BY_ID } from '~/data/image-models'
import { observedToConfigs, observedFacetProxies } from '~/lib/taste/observedConfigs'
import observedJson from '~/lib/taste/observed.json'
import { TASTE_FACETS, type TasteReading } from '~~/shared/taste/facets'

definePageMeta({ layout: false })

// ── Fixed composition constants (identical across every column) ─────────────
const CELL_W = 360
const CELL_H = 203 // 16:9, matching the gradient default aspect
const VT_LOGICAL_W = 1440
const VT_LOGICAL_H = 810
const FIXED_TEXT = 'The quiet parts, louder.'
const GRADIENT_SEED = '#tastewall'
const VT_BACKGROUND = '#101014'

type Studio = 'gradient' | 'shader' | 'vectortype'
type Column = 'neutral' | 'elicitedA' | 'fableA' | 'composedA' | 'observed' | 'elicitedB'
const STUDIOS: { id: Studio; label: string }[] = [
  { id: 'gradient', label: 'Gradient' },
  { id: 'shader', label: 'Shader' },
  { id: 'vectortype', label: 'Vector Type' },
]
const COLUMNS: { id: Column; label: string }[] = [
  { id: 'neutral', label: 'Neutral' },
  { id: 'elicitedA', label: 'Elicited A (deterministic)' },
  { id: 'fableA', label: 'Elicited A (Fable)' },
  { id: 'composedA', label: 'Composed (brief → agent)' },
  { id: 'observed', label: 'Observed' },
  { id: 'elicitedB', label: 'Elicited B (anti-board)' },
]

// ── State ───────────────────────────────────────────────────────────────────
interface FolderInfo { name: string; imageCount: number; cover: string | null }
interface Board { folder: string; thumbs: string[]; bigJpegs: string[]; pixels: { w: number; h: number; data: number[] }[] }

const folders = ref<FolderInfo[]>([])
const selA = ref(''), selB = ref('')
const freeA = ref(''), freeB = ref('')
const cap = ref(8)
const apiKey = ref('') // BYOK, memory only — never written to storage
const busy = ref('')
const error = ref('')

const boardA = ref<Board | null>(null)
const boardB = ref<Board | null>(null)
const uploadsA = ref<File[]>([])
const uploadsB = ref<File[]>([])
type PerImage = { palette: string[]; facets: Record<string, number> }
const perImageA = ref<PerImage[]>([])
const perImageB = ref<PerImage[]>([])
const readingA = ref<TasteReading | null>(null)
const readingB = ref<TasteReading | null>(null)
const paletteA = ref<string[]>([])
const paletteB = ref<string[]>([])
const fableA = ref<TasteReading | null>(null)
const fableB = ref<TasteReading | null>(null)
const summaryA = ref('')
const briefsA = ref<{ label: string; text: string }[]>([])
const composedTakes = ref<{ label: string; img: string; rationale: string }[]>([])

/** dataURL per `${studio}-${column}` cell. */
const cells = reactive<Record<string, string>>({})

const folderFor = (side: 'A' | 'B') =>
  (side === 'A' ? freeA.value.trim() || selA.value : freeB.value.trim() || selB.value)

onMounted(async () => {
  try {
    const res = await $fetch<{ folders: FolderInfo[] }>('/api/dataset-match?list=1')
    folders.value = res.folders
  }
  catch (e: any) { error.value = `folder list: ${e?.message ?? e}` }
})

// ── Image loading + client-side downscale ───────────────────────────────────
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`image failed: ${url}`))
    img.src = url
  })
}

function scaled(img: HTMLImageElement, maxSide: number): HTMLCanvasElement {
  const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(img.naturalWidth * k))
  c.height = Math.max(1, Math.round(img.naturalHeight * k))
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
  return c
}

async function loadBoard(folder: string, count: number): Promise<Board> {
  const res = await $fetch<{ files: string[] }>(`/api/dataset-match?folder=${encodeURIComponent(folder)}`)
  const files = (res.files ?? []).slice(0, count)
  if (!files.length) throw new Error(`${folder}: no images`)
  const board: Board = { folder, thumbs: [], bigJpegs: [], pixels: [] }
  for (const file of files) {
    const img = await loadImage(`/api/training-image?folder=${encodeURIComponent(folder)}&file=${encodeURIComponent(file)}`)
    board.thumbs.push(scaled(img, 96).toDataURL('image/jpeg', 0.8))
    board.bigJpegs.push(scaled(img, 768).toDataURL('image/jpeg', 0.85))
    const px = document.createElement('canvas')
    px.width = 64; px.height = 64
    const ctx = px.getContext('2d')!
    ctx.drawImage(img, 0, 0, 64, 64)
    board.pixels.push({ w: 64, h: 64, data: Array.from(ctx.getImageData(0, 0, 64, 64).data) })
  }
  return board
}

/** Uploaded files → the same Board shape, fully client-side (files never leave the browser raw). */
async function loadBoardFromFiles(files: File[], count: number): Promise<Board> {
  const picked = files.slice(0, count)
  if (!picked.length) throw new Error('no images in the drop')
  const board: Board = { folder: `uploaded · ${picked.length} files`, thumbs: [], bigJpegs: [], pixels: [] }
  for (const file of picked) {
    const url = URL.createObjectURL(file)
    try {
      const img = await loadImage(url)
      board.thumbs.push(scaled(img, 96).toDataURL('image/jpeg', 0.8))
      board.bigJpegs.push(scaled(img, 768).toDataURL('image/jpeg', 0.85))
      const px = document.createElement('canvas')
      px.width = 64; px.height = 64
      const ctx = px.getContext('2d')!
      ctx.drawImage(img, 0, 0, 64, 64)
      board.pixels.push({ w: 64, h: 64, data: Array.from(ctx.getImageData(0, 0, 64, 64).data) })
    }
    finally { URL.revokeObjectURL(url) }
  }
  return board
}

function takeFiles(side: 'A' | 'B', list: FileList | File[] | null | undefined) {
  const files = Array.from(list ?? []).filter(f => /^image\//.test(f.type))
  if (!files.length) return
  ;(side === 'A' ? uploadsA : uploadsB).value = files
}

// ── Fixed bases + renderers ─────────────────────────────────────────────────
const deepClone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

function bases(): { gradient: GradientConfig; shader: ShaderStudioConfig; vectortype: VectorTypeConfig } {
  return {
    gradient: ensureConfigDefaults(gradientDefaultConfig(GRADIENT_SEED)),
    shader: shaderDefaultConfig(),
    vectortype: mergeConfig({ ...deepClone(DEFAULT_CONFIG), text: FIXED_TEXT, fontId: 'roboto-flex', size: 150 }),
  }
}

let vtFont: VtFont | null = null
async function ensureFont(): Promise<VtFont> {
  if (!vtFont) vtFont = await loadVectorFont('roboto-flex')
  return vtFont
}

/** The fixed shader source: the NEUTRAL gradient render, snapshotted once. */
let shaderSource: HTMLCanvasElement | null = null
function ensureShaderSource(neutralGradient: GradientConfig): HTMLCanvasElement {
  if (shaderSource) return shaderSource
  const rendered = gradientFx.render(neutralGradient, CELL_W, CELL_H, 0)
  const copy = document.createElement('canvas')
  copy.width = rendered.width; copy.height = rendered.height
  copy.getContext('2d')!.drawImage(rendered, 0, 0)
  shaderSource = copy
  return copy
}

function renderGradientCell(cfg: GradientConfig): string {
  return gradientFx.render(cfg, CELL_W, CELL_H, 0).toDataURL('image/jpeg', 0.9)
}

function renderShaderCell(cfg: ShaderStudioConfig, source: HTMLCanvasElement): string {
  const passes = composePasses(cfg, getEffectSync, 0)
  return shaderFx.render(passes, source, CELL_W, CELL_H).toDataURL('image/jpeg', 0.9)
}

function renderVectorCell(cfg: VectorTypeConfig, font: VtFont): string {
  const canvas = document.createElement('canvas')
  drawVectorTypeToCanvas(canvas, font, cfg, 0, {
    width: VT_LOGICAL_W, height: VT_LOGICAL_H, padding: 60,
    pixelRatio: CELL_W / VT_LOGICAL_W, background: VT_BACKGROUND,
  })
  return canvas.toDataURL('image/jpeg', 0.9)
}

function renderColumn(
  col: Column,
  cfgs: { gradient: GradientConfig; shader: ShaderStudioConfig; vectortype: VectorTypeConfig },
  source: HTMLCanvasElement,
  font: VtFont,
) {
  cells[`gradient-${col}`] = renderGradientCell(cfgs.gradient)
  cells[`shader-${col}`] = renderShaderCell(cfgs.shader, source)
  cells[`vectortype-${col}`] = renderVectorCell(cfgs.vectortype, font)
}

// ── The two runs ────────────────────────────────────────────────────────────
async function runAnalyze() {
  const fA = folderFor('A'), fB = folderFor('B')
  if (!uploadsA.value.length && !fA) { error.value = 'drop images on Board A or pick a dataset first'; return }
  error.value = ''
  try {
    busy.value = 'loading boards…'
    boardA.value = uploadsA.value.length
      ? await loadBoardFromFiles(uploadsA.value, cap.value)
      : await loadBoard(fA, cap.value)
    const wantB = uploadsB.value.length > 0 || !!fB
    boardB.value = wantB
      ? (uploadsB.value.length ? await loadBoardFromFiles(uploadsB.value, cap.value) : await loadBoard(fB, cap.value))
      : null

    busy.value = 'analyzing…'
    const resA = await $fetch<{ reading: TasteReading; palette: string[]; perImage: PerImage[] }>('/api/taste/analyze', {
      method: 'POST', body: { pixels: boardA.value.pixels },
    })
    readingA.value = resA.reading; paletteA.value = resA.palette; perImageA.value = resA.perImage ?? []
    if (boardB.value) {
      const resB = await $fetch<{ reading: TasteReading; palette: string[]; perImage: PerImage[] }>('/api/taste/analyze', {
        method: 'POST', body: { pixels: boardB.value.pixels },
      })
      readingB.value = resB.reading; paletteB.value = resB.palette; perImageB.value = resB.perImage ?? []
    }
    else { readingB.value = null; paletteB.value = []; perImageB.value = [] }

    busy.value = 'rendering wall…'
    await fetchShaderFxCatalog()
    const font = await ensureFont()
    const neutral = bases()
    const source = ensureShaderSource(neutral.gradient)
    renderColumn('neutral', neutral, source, font)
    renderColumn('elicitedA', applyTasteToConfigs(resA.reading, resA.palette, bases()), source, font)
    if (readingB.value) renderColumn('elicitedB', applyTasteToConfigs(readingB.value, paletteB.value, bases()), source, font)
    renderColumn('observed', observedToConfigs(observedJson as any, bases()), source, font)
    if (fableA.value) renderColumn('fableA', applyTasteToConfigs(fableA.value, paletteA.value, bases()), source, font)
  }
  catch (e: any) { error.value = e?.data?.statusMessage ?? e?.message ?? String(e) }
  finally { busy.value = '' }
}

async function runFable() {
  if (!apiKey.value.trim()) { error.value = 'Fable read needs an Anthropic API key (BYOK — no server key configured)'; return }
  if (!boardA.value) { error.value = 'run Analyze first (it loads the boards)'; return }
  error.value = ''
  try {
    busy.value = 'reading A with Fable…'
    const resA = await $fetch<{ reading: TasteReading; summary: string; briefs: { label: string; text: string }[] }>('/api/taste/read', {
      method: 'POST', body: { images: boardA.value.bigJpegs.slice(0, 8), apiKey: apiKey.value.trim() },
    })
    fableA.value = resA.reading
    summaryA.value = resA.summary
    briefsA.value = resA.briefs ?? []
    if (boardB.value) {
      busy.value = 'reading B with Fable…'
      const resB = await $fetch<{ reading: TasteReading }>('/api/taste/read', {
        method: 'POST', body: { images: boardB.value.bigJpegs.slice(0, 8), apiKey: apiKey.value.trim() },
      })
      fableB.value = resB.reading
    }

    busy.value = 'rendering…'
    await fetchShaderFxCatalog()
    const font = await ensureFont()
    const source = ensureShaderSource(bases().gradient)
    renderColumn('fableA', applyTasteToConfigs(resA.reading, paletteA.value, bases()), source, font)

    composedTakes.value = []
    for (const brief of briefsA.value.slice(0, 3)) {
      busy.value = `composing “${brief.label || '?'}”…`
      try { composedTakes.value = [...composedTakes.value, await composeFromBrief(brief)] }
      catch (e: any) { composedTakes.value = [...composedTakes.value, { label: brief.label, img: '', rationale: e?.data?.statusMessage ?? e?.message ?? String(e) }] }
    }
  }
  catch (e: any) { error.value = e?.data?.statusMessage ?? e?.message ?? String(e) }
  finally { busy.value = '' }
}

/**
 * The actuator-gap fix (finding from run 2): each brief goes through the REAL
 * gradient agent path — preset macro + recipe guidance — so taste can COMPOSE
 * a config (layout, shape, softness), not just nudge params on a frozen one.
 * Mirrors /dev/gradient-agent-eval exactly. Three briefs = three translation
 * angles (atmosphere / structure / essence); the person picks, per the explore
 * thesis — one guess was the wrong shape for taste.
 */
async function composeFromBrief(brief: { label: string; text: string }): Promise<{ label: string; img: string; rationale: string }> {
  const config = cloneConfig(ensureConfigDefaults(gradientDefaultConfig(GRADIENT_SEED)))
  const controls = gradientAgentControls(config, { includePreset: true })
  const described = describeControls(controls, makeConfigParams(() => config, () => 0))
  // Run-4 fix: the avoids ride along with every composition brief.
  // Run-5 fix: simplicity bias — the agent overcomposes (mesh/marble reflex)
  // when the wanted look is often the simplest config that satisfies the brief.
  const avoids = fableA.value?.avoids ?? []
  const phrase = `${brief.text}${avoids.length ? ` — avoid: ${avoids.join(', ')}` : ''}`
    + ' — Prefer the SIMPLEST structure that satisfies this: for soft sky/atmosphere washes a plain linear or radial ramp with 3-4 stops and high blur beats fancy presets; do not reach for mesh or marble unless the brief demands visible structure.'
  const res = await $fetch<{ changes: { key: string; value: ParamValue }[]; rationale: string }>('/api/vibe', {
    method: 'POST',
    body: { apiKey: apiKey.value.trim(), controls: described, phrase, effectLabel: 'Gradient studio', guidance: GRADIENT_GUIDANCE },
  })
  const raw: Record<string, ParamValue> = {}
  for (const c of res.changes ?? []) raw[c.key] = c.value
  const patch = validatePatch(raw, described)
  let cfg = config
  if (typeof patch.preset === 'string') { const swapped = buildGradientPreset(patch.preset); if (swapped) cfg = swapped }
  const params = makeConfigParams(() => cfg, () => 0)
  for (const [k, v] of Object.entries(patch)) { if (k !== 'preset') params[k] = v }
  // Run-4 fix: compose-then-enforce — the agent proposes structure, the
  // board's extracted palette disposes (stops + background), so a preset's
  // leftover dark stops can never override a bright board again.
  const lightBias = fableA.value?.facets.valueBias?.value ?? readingA.value?.facets.valueBias?.value ?? 0.5
  enforcePaletteOnGradient(cfg, paletteA.value, lightBias)

  // Run-5 fix: see-and-correct. One visual review round — the composer looks
  // at its own render against the brief and emits fix commands (the shipped
  // F4 machinery, applied to the compose path for the first time).
  let rationale = res.rationale ?? ''
  try {
    const img1 = renderGradientCell(cfg)
    const described2 = describeControls(gradientAgentControls(cfg, { includePreset: false }), makeConfigParams(() => cfg, () => 0))
    const review = await $fetch<{ text: string }>('/api/agent-review', {
      method: 'POST',
      body: {
        apiKey: apiKey.value.trim(),
        image: img1,
        prompt: `This abstract gradient was composed to match the brief: "${brief.text}". Look at it honestly. If the render already matches the brief's mood, return an empty changes array. Otherwise return up to 6 changes that move it closer — favouring SIMPLIFICATION (less structure, softer, calmer) over addition. Use ONLY these controls (current values and ranges): ${JSON.stringify(described2)}`,
        schema: {
          type: 'object', additionalProperties: false, required: ['assessment', 'changes'],
          properties: {
            assessment: { type: 'string' },
            changes: { type: 'array', maxItems: 6, items: { type: 'object', additionalProperties: false, required: ['key', 'value'], properties: { key: { type: 'string' }, value: { type: ['string', 'number', 'boolean'] } } } },
          },
        },
      },
    })
    const parsed = JSON.parse(review.text) as { assessment?: string; changes?: { key: string; value: ParamValue }[] }
    if (parsed.changes?.length) {
      const raw2: Record<string, ParamValue> = {}
      for (const c of parsed.changes) raw2[c.key] = c.value
      const fixes = validatePatch(raw2, described2)
      const params2 = makeConfigParams(() => cfg, () => 0)
      for (const [k, v] of Object.entries(fixes)) params2[k] = v
      enforcePaletteOnGradient(cfg, paletteA.value, lightBias)
      rationale += ` · reviewed: ${parsed.assessment ?? ''} (${parsed.changes.length} fixes)`
    }
    else if (parsed.assessment) { rationale += ` · reviewed: ${parsed.assessment}` }
  }
  catch { rationale += ' · review skipped' }

  return { label: brief.label, img: renderGradientCell(cfg), rationale: `${rationale} · palette enforced` }
}

// ── Generation row: fixed subject ± taste (diffusion twin of the wall) ──────
// Endpoint: POST /api/inpaint/text2img — FLUX schnell on Replicate, no LoRA,
// returns base64 data URLs. Same request shape as useInpaint.text2img. Same
// seed for both calls so only the prompt differs (the fixed-composition
// discipline, generation edition).
const GEN_SEED = 424242
const GEN_ASPECT = '16:9' // matches the wall's cell aspect
const GEN_MODELS = ['flux-schnell', 'flux-dev', 'flux-2-pro', 'seedream-4.5', 'nano-banana-pro'] as const
const GEN_MODEL_BLURB: Record<string, string> = {
  'flux-schnell': 'fast, texture-blind',
  'flux-dev': 'renders some texture',
  'flux-2-pro': 'newest BFL — best prompt adherence',
  'seedream-4.5': 'cinematic; reads hexes literally',
  'nano-banana-pro': 'takes the BOARD as style refs · no seed control',
}

// Nano Banana ingests reference images natively — the tasted leg attaches the
// board itself (channel 4: prose + pixels, the sref mechanism proper).
const NANO = 'nano-banana-pro'
const STYLE_REF_NOTE = ' Use the attached reference images strictly as STYLE references — match their palette, light, grain and mood; do not copy their subjects or composition.'
function boardRefs(): string[] { return boardA.value?.bigJpegs.slice(0, 4) ?? [] }

async function genOnce(prompt: string, withRefs: boolean, seed: number): Promise<string> {
  if (genModel.value === NANO) {
    const refs = withRefs ? boardRefs() : []
    const res = await $fetch<{ images: string[] }>('/api/inpaint/nano-gen', {
      method: 'POST',
      body: { prompt: refs.length ? prompt + STYLE_REF_NOTE : prompt, images: refs, aspect_ratio: GEN_ASPECT },
    })
    return res.images?.[0] ?? ''
  }
  const res = await $fetch<{ images: string[] }>('/api/inpaint/text2img', {
    method: 'POST',
    body: { prompt, aspect_ratio: GEN_ASPECT, count: 1, seed, model: genModel.value },
  })
  return res.images?.[0] ?? ''
}
const genModel = ref<(typeof GEN_MODELS)[number]>('flux-schnell')
const genPricePerImage = computed(() => IMAGE_MODELS_BY_ID[genModel.value]?.pricePerImage ?? 0.003)
const GEN_PAIR_PRICE = computed(() => `~$${(genPricePerImage.value * 2).toFixed(3)}`)

const genPrompt = ref('a small lighthouse on a rocky coast, morning')
const genBusy = ref(false)
interface GenSlot { label: string; prompt: string; img: string; error: string; loading: boolean }
const genNeutral = reactive<GenSlot>({ label: 'neutral', prompt: '', img: '', error: '', loading: false })
const genTasted = reactive<GenSlot>({ label: 'tasted', prompt: '', img: '', error: '', loading: false })

async function generatePair() {
  if (!summaryA.value) { error.value = 'generation pair needs a Fable reading (run "Read with Fable" first)'; return }
  const subject = genPrompt.value.trim()
  if (!subject) { error.value = 'subject prompt is empty'; return }
  genBusy.value = true
  Object.keys(finished).forEach(k => delete finished[k])
  genNeutral.prompt = subject
  genTasted.prompt = tastedPrompt(subject, { summary: summaryA.value, palette: paletteA.value, avoids: fableA.value?.avoids })
  // Sequential on purpose: cheap, and errors stay attributable per image.
  for (const slot of [genNeutral, genTasted]) {
    slot.loading = true; slot.img = ''; slot.error = ''
    try {
      slot.img = await genOnce(slot.prompt, slot === genTasted, GEN_SEED)
      if (!slot.img) slot.error = 'endpoint returned no image'
    }
    catch (e: any) {
      // Result-stage failures matter as much as submit-stage ones — show whatever arrived.
      slot.error = e?.data?.message ?? e?.data?.statusMessage ?? e?.message ?? String(e)
    }
    finally { slot.loading = false }
  }
  genBusy.value = false
}

// Consistency check: the SAME tasted prompt across three fresh seeds — the
// dimension where prose-styles are suspected of losing to LoRAs. If the three
// read as one style, the reading holds; if they scatter, that's the finding.
const GEN_TRIO_PRICE = computed(() => `~$${(genPricePerImage.value * 3).toFixed(3)}`)
const genTrio = reactive<GenSlot[]>([1, 2, 3].map(i => ({ label: `seed ${i}`, prompt: '', img: '', error: '', loading: false })))
const trioRan = ref(false)

async function generateTrio() {
  if (!summaryA.value) { error.value = 'needs a Fable reading (run "Read with Fable" first)'; return }
  const subject = genPrompt.value.trim()
  if (!subject) { error.value = 'subject prompt is empty'; return }
  genBusy.value = true
  Object.keys(finished).forEach(k => delete finished[k])
  trioRan.value = true
  const prompt = tastedPrompt(subject, { summary: summaryA.value, palette: paletteA.value, avoids: fableA.value?.avoids })
  for (let i = 0; i < genTrio.length; i++) {
    const slot = genTrio[i]!
    slot.prompt = prompt
    slot.loading = true; slot.img = ''; slot.error = ''
    try {
      slot.img = await genOnce(prompt, true, GEN_SEED + 1 + i)
      if (!slot.img) slot.error = 'endpoint returned no image'
    }
    catch (e: any) { slot.error = e?.data?.message ?? e?.data?.statusMessage ?? e?.message ?? String(e) }
    finally { slot.loading = false }
  }
  genBusy.value = false
}

// Kit finish: the doctrine demo — the model does world and light, the KIT does
// finish. Runs the tasted renders through the Compositor's own deterministic
// grain (applyEffectChain, the real product renderer) at the intensity the
// reading measured. Free, client-side, and no diffusion-only tool can do it.
const kitFinish = ref(false)
const finished = reactive<Record<string, string>>({})

function grainIntensity(): number {
  const texture = fableA.value?.facets.texture?.value ?? readingA.value?.facets.texture?.value ?? 0.5
  return Math.min(1, Math.max(0.1, texture * 0.6)) // measured texture → grain amount
}

async function finishOne(key: string, src: string): Promise<void> {
  if (!src || finished[key]) return
  const img = await loadImage(src)
  const c = document.createElement('canvas')
  c.width = img.naturalWidth; c.height = img.naturalHeight
  c.getContext('2d')!.drawImage(img, 0, 0)
  const grain: PostEffect = { ...POST_GRAIN_BASE, amount: grainIntensity() }
  applyEffectChain(c, [grain], { W: c.width })
  finished[key] = c.toDataURL('image/jpeg', 0.92)
}
const POST_GRAIN_BASE = { type: 'grain', size: 2, visible: true } as PostEffect

async function toggleKitFinish() {
  kitFinish.value = !kitFinish.value
  if (!kitFinish.value) return
  const slots: [string, string][] = [['tasted', genTasted.img], ...genTrio.map((g, i) => [`seed${i}`, g.img] as [string, string])]
  for (const [key, src] of slots) await finishOne(key, src)
}

/** What to display for a gen slot, honoring the kit-finish toggle. */
function genDisplay(key: string, raw: string): string {
  return kitFinish.value && finished[key] ? finished[key]! : raw
}

// ── Readings + divergence view models ───────────────────────────────────────
function facetRows(reading: TasteReading | null) {
  return TASTE_FACETS.map((f) => {
    const r = reading?.facets[f.id]
    return {
      id: f.id, label: f.label, low: f.low, high: f.high,
      value: r?.value ?? null, confidence: r?.confidence ?? 0,
      read: !!r && r.confidence >= CONFIDENCE_FLOOR,
    }
  })
}

const divergence = computed(() => {
  const proxies = observedFacetProxies(observedJson as any)
  return TASTE_FACETS.map((f) => {
    const a = readingA.value?.facets[f.id]
    const elicited = a && a.confidence >= CONFIDENCE_FLOOR ? a.value : null
    const observed = (proxies as Record<string, number>)[f.id] ?? null
    return {
      id: f.id, label: f.label,
      elicited, observed,
      delta: elicited !== null && observed !== null ? Math.abs(elicited - observed) : null,
    }
  })
})

const fmt = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toFixed(2))
</script>

<template>
  <div style="min-height:100vh;background:#0b0b0f;color:#ddd;font-family:sans-serif;padding:20px">
    <h1 style="font-size:16px;margin:0 0 4px">Taste wall</h1>
    <p style="font-size:12px;color:#888;margin:0 0 14px;max-width:860px">
      Executable-brand-kit spike instrument. Fixed composition per studio (same seed, same shader source image, same text)
      — only taste-driven params differ per column. Analyze is free and deterministic; the Fable column needs your Anthropic key (kept in memory only).
    </p>

    <!-- Controls -->
    <div style="display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end;margin-bottom:14px">
      <div v-for="side in (['A', 'B'] as const)" :key="side" style="display:flex;flex-direction:column;gap:4px">
        <label style="font-size:11px;color:#aaa">{{ side === 'A' ? 'Board A (taste)' : 'Board B (anti-board)' }}</label>
        <select :value="side === 'A' ? selA : selB" :data-picker="side"
          @change="side === 'A' ? (selA = ($event.target as HTMLSelectElement).value) : (selB = ($event.target as HTMLSelectElement).value)"
          style="background:#15151c;color:#ddd;border:1px solid #2a2a35;border-radius:6px;padding:5px;min-width:220px">
          <option value="">— pick a dataset —</option>
          <option v-for="f in folders" :key="f.name" :value="f.name">{{ f.name }} ({{ f.imageCount }} imgs)</option>
        </select>
        <input :value="side === 'A' ? freeA : freeB" :data-free="side"
          @input="side === 'A' ? (freeA = ($event.target as HTMLInputElement).value) : (freeB = ($event.target as HTMLInputElement).value)"
          placeholder="…or type a folder name" spellcheck="false"
          style="background:#15151c;color:#ddd;border:1px solid #2a2a35;border-radius:6px;padding:5px;font-size:11px" />
        <label :data-drop="side"
          @dragover.prevent @drop.prevent="takeFiles(side, ($event as DragEvent).dataTransfer?.files)"
          style="border:1px dashed #3a3a48;border-radius:6px;padding:6px 8px;font-size:11px;color:#888;cursor:pointer;text-align:center">
          {{ (side === 'A' ? uploadsA : uploadsB).length ? `${(side === 'A' ? uploadsA : uploadsB).length} files ready — click Analyze` : '…or drop / click to upload images' }}
          <input type="file" multiple accept="image/*" :data-upload="side" style="display:none"
            @change="takeFiles(side, ($event.target as HTMLInputElement).files)" />
        </label>
      </div>
      <label style="font-size:11px;color:#aaa;display:flex;flex-direction:column;gap:4px">Images / board
        <input v-model.number="cap" type="number" min="1" max="32" data-cap
          style="width:70px;background:#15151c;color:#ddd;border:1px solid #2a2a35;border-radius:6px;padding:5px" />
      </label>
      <label style="font-size:11px;color:#aaa;display:flex;flex-direction:column;gap:4px">Anthropic API key (BYOK, memory only)
        <input v-model="apiKey" type="password" autocomplete="off" data-apikey placeholder="sk-ant-…"
          style="width:220px;background:#15151c;color:#ddd;border:1px solid #2a2a35;border-radius:6px;padding:5px" />
      </label>
      <button :disabled="!!busy" data-analyze @click="runAnalyze"
        style="background:#e6e6ea;color:#111;border:none;border-radius:8px;padding:8px 16px;font-weight:600;cursor:pointer">
        {{ busy || 'Analyze (free)' }}
      </button>
      <button :disabled="!!busy" data-fable @click="runFable"
        style="background:#2a2a35;color:#ddd;border:1px solid #3a3a48;border-radius:8px;padding:8px 16px;font-weight:600;cursor:pointer">
        Read with Fable
      </button>
    </div>
    <p v-if="error" data-error style="color:#e66;font-size:12px;margin:0 0 12px">{{ error }}</p>

    <!-- Board strips -->
    <div v-for="(board, i) in [boardA, boardB]" :key="i" style="margin-bottom:6px">
      <template v-if="board">
        <div style="font-size:11px;color:#888;margin-bottom:3px">{{ i === 0 ? 'A' : 'B' }} · {{ board.folder }}</div>
        <div :data-strip="i === 0 ? 'A' : 'B'" style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px">
          <img v-for="(t, j) in board.thumbs" :key="j" :src="t" style="height:48px;border-radius:4px;display:block" />
        </div>
      </template>
    </div>

    <!-- The wall -->
    <div style="overflow-x:auto;margin:14px 0">
      <table style="border-collapse:collapse">
        <thead>
          <tr>
            <th style="font-size:11px;color:#888;text-align:left;padding:4px 8px"></th>
            <th v-for="c in COLUMNS" :key="c.id" style="font-size:11px;color:#aaa;font-weight:600;text-align:left;padding:4px 8px">{{ c.label }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in STUDIOS" :key="s.id">
            <td style="font-size:12px;color:#ddd;font-weight:600;padding:4px 8px;vertical-align:top">{{ s.label }}</td>
            <td v-for="c in COLUMNS" :key="c.id" style="padding:4px 8px;vertical-align:top">
              <div v-if="c.id === 'composedA' && s.id === 'gradient' && composedTakes.length" data-composed-takes
                style="display:flex;flex-direction:column;gap:6px">
                <div v-for="t in composedTakes" :key="t.label">
                  <img v-if="t.img" :src="t.img" :data-take="t.label"
                    :style="{ width: CELL_W + 'px', maxWidth: 'none', display: 'block', borderRadius: '6px', background: '#000' }" />
                  <div style="font-size:10px;color:#8a8;margin-top:2px"><b style="color:#aaa">{{ t.label }}</b> — {{ t.rationale }}</div>
                </div>
              </div>
              <img v-else-if="cells[`${s.id}-${c.id}`]" :src="cells[`${s.id}-${c.id}`]" :data-cell="`${s.id}-${c.id}`"
                :style="{ width: CELL_W + 'px', maxWidth: 'none', display: 'block', borderRadius: '6px', background: '#000' }" />
              <div v-else :data-cell-empty="`${s.id}-${c.id}`"
                :style="{ width: CELL_W + 'px', height: CELL_H + 'px', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px dashed #2a2a35', borderRadius: '6px', color: '#555', fontSize: '11px' }">
                {{ c.id === 'fableA' ? 'needs key — run "Read with Fable"' : c.id === 'composedA' ? (s.id === 'gradient' ? 'runs with Fable — brief → gradient agent' : 'gradient only (spike)') : c.id === 'elicitedB' ? 'optional anti-board' : 'run Analyze' }}
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Generation: fixed subject ± taste -->
    <div data-gen-section style="margin:0 0 18px">
      <h2 style="font-size:13px;margin:0 0 4px">Generation — fixed subject ± taste</h2>
      <p style="font-size:11px;color:#777;margin:0 0 8px;max-width:720px">
        The diffusion twin of the fixed-composition discipline: one subject prompt, rendered neutral vs. with the
        Fable reading's style block (summary + palette + avoids), same seed. FLUX schnell via Replicate — paid, so the button says what it costs.
      </p>
      <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:10px">
        <label style="font-size:11px;color:#aaa;display:flex;flex-direction:column;gap:4px">Fixed subject prompt
          <input v-model="genPrompt" data-gen-prompt spellcheck="false"
            style="width:340px;background:#15151c;color:#ddd;border:1px solid #2a2a35;border-radius:6px;padding:5px;font-size:11px" />
        </label>
        <label style="font-size:11px;color:#aaa;display:flex;flex-direction:column;gap:4px">Model
          <select v-model="genModel" data-gen-model
            style="background:#15151c;color:#ddd;border:1px solid #2a2a35;border-radius:6px;padding:5px;font-size:11px">
            <option v-for="m in GEN_MODELS" :key="m" :value="m">
              {{ IMAGE_MODELS_BY_ID[m]?.label ?? m }} · ${{ (IMAGE_MODELS_BY_ID[m]?.pricePerImage ?? 0).toFixed(3) }}/img · {{ GEN_MODEL_BLURB[m] }}
            </option>
          </select>
        </label>
        <button :disabled="!summaryA || genBusy || !!busy" data-gen-pair @click="generatePair"
          :title="summaryA ? '' : 'needs a Fable reading — run “Read with Fable” first'"
          :style="{ background: summaryA && !genBusy ? '#2a2a35' : '#1a1a22', color: summaryA && !genBusy ? '#ddd' : '#555', border: '1px solid #3a3a48', borderRadius: '8px', padding: '8px 16px', fontWeight: 600, cursor: summaryA && !genBusy ? 'pointer' : 'not-allowed' }">
          {{ genBusy ? 'generating…' : `Generate pair (paid ${GEN_PAIR_PRICE})` }}
        </button>
        <button :disabled="!summaryA || genBusy || !!busy" data-gen-trio @click="generateTrio"
          :title="summaryA ? 'same tasted prompt, three fresh seeds — the consistency check' : 'needs a Fable reading — run “Read with Fable” first'"
          :style="{ background: '#1a1a22', color: summaryA && !genBusy ? '#ddd' : '#555', border: '1px solid #3a3a48', borderRadius: '8px', padding: '8px 16px', fontWeight: 600, cursor: summaryA && !genBusy ? 'pointer' : 'not-allowed' }">
          {{ `Tasted ×3 seeds (paid ${GEN_TRIO_PRICE})` }}
        </button>
        <button :disabled="!genTasted.img" data-kit-finish @click="toggleKitFinish"
          title="run the renders through the Compositor's own deterministic grain at the intensity the reading measured — free"
          :style="{ background: kitFinish ? 'rgba(122,162,247,.18)' : '#1a1a22', color: genTasted.img ? '#ddd' : '#555', border: kitFinish ? '1px solid #7aa2f7' : '1px solid #3a3a48', borderRadius: '8px', padding: '8px 16px', fontWeight: 600, cursor: genTasted.img ? 'pointer' : 'not-allowed' }">
          {{ kitFinish ? '✓ kit finish (procedural grain)' : '＋ kit finish (free)' }}
        </button>
        <span v-if="!summaryA" style="font-size:11px;color:#666">needs a Fable reading first</span>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <div v-for="g in [genNeutral, genTasted]" :key="g.label" :style="{ width: CELL_W + 'px' }">
          <div style="font-size:11px;color:#aaa;font-weight:600;margin-bottom:3px">{{ g.label }}</div>
          <img v-if="g.img" :src="g.label === 'tasted' ? genDisplay('tasted', g.img) : g.img" :data-gen-img="g.label"
            :style="{ width: CELL_W + 'px', maxWidth: 'none', display: 'block', borderRadius: '6px', background: '#000' }" />
          <div v-else :data-gen-empty="g.label"
            :style="{ width: CELL_W + 'px', height: CELL_H + 'px', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px dashed #2a2a35', borderRadius: '6px', color: '#555', fontSize: '11px' }">
            {{ g.loading ? 'generating…' : g.error ? 'failed' : 'not run' }}
          </div>
          <div v-if="g.error" :data-gen-error="g.label" style="color:#e66;font-size:11px;margin-top:4px;line-height:1.4">{{ g.error }}</div>
        </div>
      </div>
      <div v-if="trioRan" style="margin-top:12px">
        <div style="font-size:11px;color:#aaa;font-weight:600;margin-bottom:3px">Consistency — same tasted prompt, three fresh seeds</div>
        <div data-gen-trio-row style="display:flex;gap:10px;flex-wrap:wrap">
          <div v-for="(g, gi) in genTrio" :key="g.label" :style="{ width: CELL_W + 'px' }">
            <img v-if="g.img" :src="genDisplay(`seed${gi}`, g.img)" :data-gen-img="g.label"
              :style="{ width: CELL_W + 'px', maxWidth: 'none', display: 'block', borderRadius: '6px', background: '#000' }" />
            <div v-else
              :style="{ width: CELL_W + 'px', height: CELL_H + 'px', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px dashed #2a2a35', borderRadius: '6px', color: '#555', fontSize: '11px' }">
              {{ g.loading ? 'generating…' : g.error ? 'failed' : '…' }}
            </div>
            <div style="font-size:10px;color:#666;margin-top:3px">{{ g.label }}</div>
            <div v-if="g.error" style="color:#e66;font-size:11px;margin-top:2px;line-height:1.4">{{ g.error }}</div>
          </div>
        </div>
        <div style="font-size:10.5px;color:#666;margin-top:5px;max-width:74ch">If the three read as one style, the reading holds across seeds — the dimension where prose-styles are suspected of losing to trained LoRAs.</div>
      </div>
      <details v-if="genTasted.prompt" data-gen-prompts style="margin-top:8px;max-width:740px">
        <summary style="font-size:12px;color:#888;cursor:pointer">Prompts sent</summary>
        <pre style="font-size:10.5px;color:#9a9;background:#0f0f14;border:1px solid #22222c;border-radius:6px;padding:10px;white-space:pre-wrap;overflow-x:auto">neutral: {{ genNeutral.prompt }}

tasted: {{ genTasted.prompt }}</pre>
      </details>
    </div>

    <!-- Fable: what it sees -->
    <div v-if="summaryA" data-summary style="background:#12121a;border:1px solid #22222c;border-radius:8px;padding:12px 14px;margin:0 0 14px;max-width:860px">
      <div style="font-size:11px;color:#7aa2f7;font-weight:600;margin-bottom:4px">Fable — what it sees</div>
      <p style="font-size:12.5px;color:#ccc;margin:0 0 8px;line-height:1.55">{{ summaryA }}</p>
      <div v-for="b in briefsA" :key="b.label" style="font-size:11px;color:#888;margin-bottom:3px">
        <b style="color:#aaa">{{ b.label }} →</b> {{ b.text }}
      </div>
    </div>

    <!-- Readings panel -->
    <div style="display:flex;gap:28px;flex-wrap:wrap;margin:10px 0 18px">
      <div v-for="side in (['A', 'B'] as const)" :key="side" style="min-width:340px">
        <h2 style="font-size:13px;margin:0 0 6px">Reading {{ side }} <span style="color:#666;font-weight:400">(deterministic{{ (side === 'A' ? fableA : fableB) ? ' + Fable' : '' }})</span></h2>
        <div v-for="which in ((side === 'A' ? [readingA, fableA] : [readingB, fableB]) as (TasteReading | null)[])" :key="which === (side === 'A' ? readingA : readingB) ? 'det' : 'fable'">
          <template v-if="which">
            <div v-for="row in facetRows(which)" :key="row.id" :data-facet="`${side}-${row.id}`" style="display:flex;align-items:center;gap:8px;margin-bottom:2px">
              <span style="font-size:10px;color:#888;width:130px;text-align:right">{{ row.label }}</span>
              <div style="width:150px;height:8px;background:#1a1a22;border-radius:4px;position:relative">
                <div v-if="row.value !== null" :style="{ position: 'absolute', left: 0, top: 0, bottom: 0, width: (row.value * 100) + '%', background: row.read ? '#7aa2f7' : '#3a3a48', borderRadius: '4px' }" />
              </div>
              <span style="font-size:10px;color:#aaa;width:88px" :data-facet-value="`${side}-${row.id}`">
                {{ row.value === null ? 'unread' : `${row.value.toFixed(2)} · c ${row.confidence.toFixed(2)}` }}
              </span>
            </div>
            <div style="font-size:11px;color:#888;margin:6px 0 10px">
              <span v-if="which.avoids?.length">avoids: {{ which.avoids.join(' · ') }}</span>
              <span v-else>avoids: —</span>
              <span v-if="which.clusters?.length"> · clusters: {{ which.clusters.map(c => c.label ?? '?').join(', ') }}</span>
            </div>
          </template>
        </div>
        <div v-if="(side === 'A' ? paletteA : paletteB).length" style="display:flex;gap:4px;margin-top:4px">
          <div v-for="hex in (side === 'A' ? paletteA : paletteB)" :key="hex" :title="hex"
            :style="{ width: '28px', height: '28px', borderRadius: '5px', background: hex, border: '1px solid #2a2a35' }" />
        </div>
      </div>
    </div>

    <!-- Per-image extraction: what the analyzer sees in each image -->
    <div v-for="side in (['A', 'B'] as const)" :key="`per-${side}`" style="margin:0 0 18px">
      <template v-if="(side === 'A' ? perImageA : perImageB).length && (side === 'A' ? boardA : boardB)">
        <h2 style="font-size:13px;margin:0 0 6px">Per-image extraction · {{ side }} <span style="color:#666;font-weight:400">(deterministic, per source)</span></h2>
        <div :data-per-image="side" style="display:flex;gap:10px;flex-wrap:wrap">
          <div v-for="(pi, j) in (side === 'A' ? perImageA : perImageB)" :key="j"
            style="background:#12121a;border:1px solid #22222c;border-radius:8px;padding:8px;width:150px">
            <img :src="(side === 'A' ? boardA : boardB)!.thumbs[j]" style="width:100%;border-radius:5px;display:block;margin-bottom:6px" />
            <div style="display:flex;gap:3px;margin-bottom:6px">
              <div v-for="hex in pi.palette" :key="hex" :title="hex" :style="{ flex: 1, height: '14px', borderRadius: '3px', background: hex }" />
            </div>
            <div v-for="(v, fid) in pi.facets" :key="fid" style="display:flex;justify-content:space-between;font-size:9.5px;color:#999">
              <span>{{ fid }}</span><span style="color:#ccc">{{ (v as number).toFixed(2) }}</span>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- Raw extraction JSON -->
    <details v-if="readingA" style="margin:0 0 18px" data-raw-json>
      <summary style="font-size:12px;color:#888;cursor:pointer">Raw extraction JSON (aggregate readings + Fable)</summary>
      <pre style="font-size:10.5px;color:#9a9;background:#0f0f14;border:1px solid #22222c;border-radius:6px;padding:10px;overflow-x:auto;max-height:400px">{{ JSON.stringify({ deterministicA: readingA, paletteA, fableA, deterministicB: readingB, paletteB, fableB }, null, 2) }}</pre>
    </details>

    <!-- Divergence readout -->
    <h2 style="font-size:13px;margin:0 0 4px">Elicited A vs observed — rough agreement check</h2>
    <p style="font-size:11px;color:#777;margin:0 0 8px;max-width:720px">
      Observed proxies exist only where the mapping is trivially invertible (grain → texture, background luma → value bias).
      This is a sanity read, not science.
    </p>
    <table style="border-collapse:collapse;font-size:11px" data-divergence>
      <thead>
        <tr>
          <th style="text-align:left;color:#888;padding:2px 12px 2px 0">Facet</th>
          <th style="text-align:left;color:#888;padding:2px 12px 2px 0">Elicited A</th>
          <th style="text-align:left;color:#888;padding:2px 12px 2px 0">Observed proxy</th>
          <th style="text-align:left;color:#888;padding:2px 12px 2px 0">|Δ|</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in divergence" :key="row.id">
          <td style="color:#aaa;padding:2px 12px 2px 0">{{ row.label }}</td>
          <td style="color:#ddd;padding:2px 12px 2px 0">{{ fmt(row.elicited) }}</td>
          <td style="color:#ddd;padding:2px 12px 2px 0">{{ row.observed === null ? 'n/a' : fmt(row.observed) }}</td>
          <td style="color:#ddd;padding:2px 12px 2px 0">{{ row.delta === null ? 'n/a' : fmt(row.delta) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
