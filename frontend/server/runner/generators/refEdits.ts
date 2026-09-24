/**
 * References, camera and product shot (family `ref-edits`, Task B7).
 *
 * Ports, verbatim:
 *   comfy_api_nodes/image_edit_models.py       the four builders and _clamp_size
 *   nodes_replicate.py _run_image_edit_prediction (:1226)  Nano Banana 2's
 *     read-back onto fal (only its first link: fal nano-banana-2/edit)
 *   nodes_replicate.py _yaw_phrase, _pitch_phrase, _roll_phrase,
 *     _camera_to_phrase and RotateCameraNode.execute's tolerant camera JSON
 *   nodes_replicate.py _PRODUCT_SHOT_ASPECTS, _PRODUCT_SHOT_DEFAULT_PROMPT and
 *     ProductShotNode.execute's input dict (catacolabs/sdxl-ad-inpaint, a
 *     community model: the Replicate client finds its latest version)
 */
import { pyMod, pyStrip } from '#shared/runner/pyText'
import { NANO_BANANA_2_EDIT_APP, NANO_BANANA_PRO_EDIT_APP, falNanoBananaEdit } from './edit'
import { maybeSetSeed, pyFloatOf, pyTruthy, textSetting } from './opts'

// ── image_edit_models.py ─────────────────────────────────────────────────

type EditAdv = Record<string, unknown>

/** `value if value in allowed else fallback`. */
function clampSize(value: unknown, allowed: ReadonlySet<string>, fallback: string): string {
  return typeof value === 'string' && allowed.has(value) ? value : fallback
}

export interface ImageEditModelDesc {
  id: string
  slug: string
  /** (prompt, image_urls, seed, advanced) → the Replicate input dict. */
  build(prompt: string, imageUrls: string[], seed: number, adv: EditAdv): Record<string, unknown>
}

function qwenImageEditPlus(prompt: string, imageUrls: string[], seed: number, _adv: EditAdv): Record<string, unknown> {
  const inp: Record<string, unknown> = { prompt, image: [...imageUrls], output_format: 'png', output_quality: 95 }
  maybeSetSeed(inp, seed)
  return inp
}

function seedreamEdit(sizes: ReadonlySet<string>) {
  return (prompt: string, imageUrls: string[], seed: number, adv: EditAdv): Record<string, unknown> => {
    const inp: Record<string, unknown> = { prompt, image_input: [...imageUrls], size: clampSize(adv.size, sizes, '2K') }
    const ar = adv.aspect_ratio
    if (pyTruthy(ar)) inp.aspect_ratio = ar // supports "match_input_image"
    maybeSetSeed(inp, seed)
    return inp
  }
}

function nanoBanana2Edit(prompt: string, imageUrls: string[], seed: number, adv: EditAdv): Record<string, unknown> {
  const inp: Record<string, unknown> = {
    prompt, image_input: [...imageUrls],
    resolution: clampSize(adv.size, new Set(['1K', '2K', '4K']), '2K'),
    output_format: 'png',
  }
  maybeSetSeed(inp, seed)
  return inp
}

export const QWEN_IMAGE_EDIT_PLUS_SLUG = 'qwen/qwen-image-edit-plus'

export const IMAGE_EDIT_MODELS: Readonly<Record<string, ImageEditModelDesc>> = {
  'qwen-image-edit-plus': { id: 'qwen-image-edit-plus', slug: QWEN_IMAGE_EDIT_PLUS_SLUG, build: qwenImageEditPlus },
  'seedream-5-pro': { id: 'seedream-5-pro', slug: 'bytedance/seedream-5-pro', build: seedreamEdit(new Set(['1K', '2K'])) },
  'seedream-5-lite': { id: 'seedream-5-lite', slug: 'bytedance/seedream-5-lite', build: seedreamEdit(new Set(['2K', '3K'])) },
  'nano-banana-2': { id: 'nano-banana-2', slug: 'google/nano-banana-2', build: nanoBanana2Edit },
}

/** GenerateFromReferencesNode's models (REFERENCE_MODEL_IDS), in display order. */
export const REFERENCE_MODEL_IDS = ['seedream-5-pro', 'seedream-5-lite', 'nano-banana-2'] as const

/** The reference inputs, in the order Python sends them (empty slots skipped). */
export const REFERENCE_SLOTS = ['image_1', 'image_2', 'image_3', 'image_4', 'image_5', 'image_6'] as const

/**
 * Where _run_image_edit_prediction sends a slug first: the Nano Banana slugs
 * with a fal twin (_NANO_BANANA_FAL_EDIT) go to fal; every other slug,
 * google/nano-banana included, runs on Replicate. Pro is used by Restyle (B8).
 */
const FAL_TWIN: Readonly<Record<string, string>> = {
  'google/nano-banana-2': NANO_BANANA_2_EDIT_APP,
  'google/nano-banana-pro': NANO_BANANA_PRO_EDIT_APP,
}

/**
 * The first call _run_image_edit_prediction makes for a Replicate-shaped
 * input: for a fal twin, `image_input` / `resolution` / `output_format` /
 * `seed` read back onto fal Nano Banana edit; otherwise the slug on Replicate.
 */
export function imageEditCall(slug: string, input: Record<string, unknown>): { provider: 'fal' | 'replicate'; endpoint: string; payload: Record<string, unknown> } {
  const app = Object.prototype.hasOwnProperty.call(FAL_TWIN, slug) ? FAL_TWIN[slug] : undefined
  if (!app) return { provider: 'replicate', endpoint: slug, payload: input }
  const seed = typeof input.seed === 'number' && Number.isFinite(input.seed) ? Math.trunc(input.seed) : 0
  return {
    provider: 'fal',
    endpoint: app,
    payload: falNanoBananaEdit({
      imageUrls: Array.isArray(input.image_input) ? input.image_input as string[] : [],
      prompt: typeof input.prompt === 'string' ? input.prompt : '',
      resolution: typeof input.resolution === 'string' ? input.resolution : '1K',
      outputFormat: typeof input.output_format === 'string' ? input.output_format : 'png',
      seed,
    }),
  }
}

// ── Camera angle → English (nodes_replicate.py :3536–3597) ───────────────

export function yawPhrase(yawDeg: number): string {
  const y = pyMod(yawDeg + 180, 360) - 180
  const absY = Math.abs(y)
  if (absY < 22.5) return 'the front'
  if (absY > 157.5) return 'directly behind'
  if (y > 0) {
    if (absY < 67.5) return 'the front-right'
    if (absY < 112.5) return 'the right side'
    return 'the back-right'
  }
  if (absY < 67.5) return 'the front-left'
  if (absY < 112.5) return 'the left side'
  return 'the back-left'
}

export function pitchPhrase(pitchDeg: number): string | null {
  // max(-90.0, min(90.0, pitch)), with Python's argument order (NaN reads as 90).
  const lo = pitchDeg < 90 ? pitchDeg : 90
  const p = lo > -90 ? lo : -90
  if (Math.abs(p) < 7.5) return null // eye level — omit
  if (p > 0) {
    if (p < 30) return 'at a slight high angle'
    if (p < 60) return 'at a high angle'
    if (p < 80) return 'from a very high angle'
    return 'nearly top-down'
  }
  const ap = Math.abs(p)
  if (ap < 30) return 'at a slight low angle'
  if (ap < 60) return 'at a low angle'
  if (ap < 80) return 'from a very low angle'
  return 'nearly worm\'s-eye'
}

export function rollPhrase(rollDeg: number): string | null {
  const r = pyMod(rollDeg + 180, 360) - 180
  const ar = Math.abs(r)
  if (ar < 5) return null // level — omit
  const direction = r > 0 ? 'clockwise' : 'counter-clockwise'
  if (ar < 20) return `with the camera tilted slightly ${direction}`
  if (ar < 60) return `with a Dutch tilt ${direction}`
  return `with a heavy Dutch tilt ${direction}`
}

export function cameraToPhrase(yawDeg: number, pitchDeg: number, rollDeg: number): string {
  const parts = [`viewed from ${yawPhrase(yawDeg)}`]
  const p = pitchPhrase(pitchDeg)
  if (p) parts.push(p)
  const r = rollPhrase(rollDeg)
  if (r) parts.push(r)
  return parts.join(', ')
}

const CAMERA_UNREADABLE = 'The camera setting can’t be read'

/**
 * `float(cam.get(key, 0) or 0)`: a missing or falsy value (0, "", null,
 * false, [] or {}) is 0; true is 1; a number is itself; a string is read
 * the way float() reads it. Anything float() raises on fails the node.
 */
function cameraAngle(v: unknown): number {
  if (v === undefined || v === null || v === false || v === 0 || v === '') return 0
  if (typeof v === 'number') return v
  if (v === true) return 1
  if (typeof v === 'string') {
    const f = pyFloatOf(v)
    if (f === null) throw new Error(CAMERA_UNREADABLE)
    return f
  }
  if (Array.isArray(v) && v.length === 0) return 0
  if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0) return 0
  throw new Error(CAMERA_UNREADABLE)
}

// Python's json.loads also reads the bare words NaN, Infinity and -Infinity.
const PY_NUMBER_WORDS: readonly [string, number][] = [['-Infinity', -Infinity], ['Infinity', Infinity], ['NaN', Number.NaN]]
const WORD_MARK = '\u0000py-json-number:'

/** json.loads(text), or undefined where it raises. */
function pyJsonLoads(text: string): unknown {
  try { return JSON.parse(text) }
  catch { /* maybe Python's number words */ }
  // Swap each number word outside a string for a marked string, then map it back.
  let out = ''
  let inString = false
  let found = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      out += ch
      if (ch === '\\') { out += text[i + 1] ?? ''; i++ }
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; out += ch; continue }
    const word = PY_NUMBER_WORDS.find(([w]) => text.startsWith(w, i))
    if (word) {
      out += JSON.stringify(WORD_MARK + word[0])
      i += word[0].length - 1
      found = true
      continue
    }
    out += ch
  }
  if (!found) return undefined
  try {
    return JSON.parse(out, (_k, v: unknown) => {
      if (typeof v !== 'string' || !v.startsWith(WORD_MARK)) return v
      return PY_NUMBER_WORDS.find(([w]) => WORD_MARK + w === v)![1]
    })
  }
  catch { return undefined }
}

/**
 * RotateCameraNode.execute's reading of the gimbal JSON: unreadable text, or
 * JSON that is not an object, is the front view with no rotation.
 */
export function parseCamera(raw: unknown): { yaw: number; pitch: number; roll: number } {
  // ComfyUI hands the node str(value); only a string can hold a JSON object.
  const text = typeof raw === 'string' && raw ? raw : '{}'
  const v = pyJsonLoads(text)
  const cam = v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
  const get = (k: string) => Object.prototype.hasOwnProperty.call(cam, k) ? cam[k] : undefined
  return { yaw: cameraAngle(get('yaw')), pitch: cameraAngle(get('pitch')), roll: cameraAngle(get('roll')) }
}

// ── Product Shot (nodes_replicate.py :3437–3509) ─────────────────────────

export const PRODUCT_SHOT_SLUG = 'catacolabs/sdxl-ad-inpaint'

/** The ad-inpaint model takes a "W, H" string. */
export const PRODUCT_SHOT_ASPECTS: Readonly<Record<string, string>> = {
  Square: '1024, 1024',
  Portrait: '832, 1216',
  Landscape: '1216, 832',
}

export const PRODUCT_SHOT_DEFAULT_PROMPT = (
  'on a clean marble countertop, soft natural window light, minimal studio '
  + 'setting, professional product photography, shallow depth of field'
)

export function productShotInput(o: {
  image: string
  scenePrompt: string
  aspect: unknown
  productSize: unknown
  keepProductExact: boolean
  seed: number
}): Record<string, unknown> {
  const aspect = typeof o.aspect === 'string' && Object.prototype.hasOwnProperty.call(PRODUCT_SHOT_ASPECTS, o.aspect)
    ? PRODUCT_SHOT_ASPECTS[o.aspect]!
    : '1024, 1024'
  const input: Record<string, unknown> = {
    image: o.image,
    prompt: pyStrip(o.scenePrompt) || PRODUCT_SHOT_DEFAULT_PROMPT,
    img_size: aspect,
    product_fill: o.productSize,
    apply_img: o.keepProductExact,
  }
  if (o.seed && o.seed > 0) input.seed = o.seed
  return input
}

// ── Text settings ────────────────────────────────────────────────────────

/** Lives in opts.ts (the nano actions read their text the same way); re-exported for existing callers. */
export { textSetting }
