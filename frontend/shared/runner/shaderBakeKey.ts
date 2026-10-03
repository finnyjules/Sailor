/**
 * The Shader effect's bake (step 3, R2.10; decision 9: the browser's bake is
 * reused). The server renders no GL: the browser renders the node at submit,
 * uploads each frame, and names the files in the prompt as
 * `inputs.sailor_baked` = JSON `{ files, key }`. The runner replays them
 * (server/runner/cards/shaderEffect.ts). ComfyUI ignores an input its schema
 * doesn't declare, so the engine path is unchanged.
 *
 * `key` is the sha256 of the canonical JSON of the node's settings as sent,
 * its source picture's file name, the catalog's version and the baked files'
 * names. Each baked name is `shader_bake_<first 32 hex of the PNG's sha256>.png`,
 * which the runner checks against the bytes it reads (cards/shaderEffect.ts).
 * What an agreeing key proves: the bake was made for exactly these settings,
 * this source name and this catalog, and the files replayed are the bytes
 * named. It is not a signature: anyone can work it out, so a hand-made bake of
 * one's own files is replayed (hosted, only one's own files: inputs.ts); and it
 * does not cover the source's bytes, so a source overwritten under the same
 * name after the bake is not noticed. Settings changed after the bake are. The
 * R11.9c (USER ruling (d)): an animated Shader effect (its time setting
 * making several frames, an animated picture, or a clip's frames) is baked
 * the same way, a PNG a frame, and the runner keeps them as one frame batch.
 * LC13: a My effect (one of your own, `mine_…~vN`) is baked the same way;
 * its bake also carries `source`, the digest of the GLSL the browser compiled
 * and the dials it declares (myEffectSourceDigest), which its key covers. The
 * server checks that digest against the My effects store, the person's own
 * (server/runner/myEffectBake.ts), before the hold. The server never compiles
 * or runs the effect's code: it only hashes its text.
 * The key is worked out synchronously here
 * (eligibility is synchronous, in the browser and on the server alike); the
 * browser's `shaderBakeKey` computes the same digest over Web Crypto.
 *
 * Also here, from comfy_extras/nodes_shader_effects.py and _shader_effects.py
 * (pinned by tests/unit/fixtures/runner-effects-shader.json): the catalog's
 * version, the node's effect options, which effects are generative,
 * `_aspect_size` and `frame_plan`. Pure, relative imports only: the browser
 * and the server share it.
 */
import { GATE_CLASS, isLink, type ApiLink, type ApiPrompt } from './graph'
import { pyFloatOf } from './pyText'
import { familyOn, type RunnerFamily } from './families'
import { MEDIA_CAPS } from './media'
import { MY_EFFECT_ID_BODY } from '../myEffects/record'

/** The catalog's `version` (shader_effects/manifest.json) the runner replays bakes of. */
export const SHADER_CATALOG_VERSION = 1

/** Renamed effects (nodes_shader_effects.py LEGACY_EFFECT_IDS). */
export const SHADER_LEGACY_EFFECT_IDS: Readonly<Record<string, string>> = { filament: 'thread_contours' }

/**
 * The catalog's effects, as the node's `effect` options list them (the legacy
 * names apart). An effect not listed (a new one, a draft) is refused; a My
 * effect (LC13) is taken on its own terms (myEffectRefOf).
 */
export const SHADER_EFFECT_IDS: readonly string[] = [
  'noise_distortion', 'halftone', 'risograph', 'wave', 'swirl', 'pinch_bulge', 'water_ripple',
  'crystal_prism', 'liquify', 'pixelate', 'outline', 'ascii_dither', 'glyph_dither', 'blocks',
  'block_glitch', 'slice_shift', 'mondrian', 'recursive_grid', 'aurora', 'nebula', 'plasma', 'mesh_gradient',
  'wisps', 'light_beams', 'fbm', 'rgb_glitch', 'zoom_blur', 'kaleidoscope', 'mirror', 'droste',
  'bayer_dither', 'crosshatch', 'oil_paint', 'holographic', 'holographic_surface', 'prism', 'glass_lens',
  'crystal', 'studio_backdrop', 'nebula_gem', 'heatmap', 'chrome', 'liquid_metal', 'crt_scanlines',
  'vignette', 'gaussian_blur', 'bloom', 'glow', 'tilt_shift', 'chromatic_aberration', 'fisheye',
  'lens_distortion', 'dot_screen', 'defocus_bokeh', 'duotone', 'gradient_map', 'spectrum_map', 'posterize',
  'threshold', 'hue_shift', 'color_temperature', 'caustics', 'voronoi_cells', 'starfield', 'warp_tunnel',
  'edge_glow', 'blinds', 'fbm_warp', 'flag', 'post_adjust', 'post_grain', 'distort', 'topographic',
  'stipple', 'pixel_sort', 'terrain_bands', 'sonar', 'oddgrid', 'static', 'culture', 'mist', 'pixel_bloom',
  'thread_contours', 'sear',
]

/** The generative effects: with no picture wired in, they render at `_aspect_size`; any other effect raises. */
export const SHADER_GENERATIVE_IDS: readonly string[] = [
  'aurora', 'caustics', 'culture', 'fbm', 'holographic_surface', 'light_beams', 'mesh_gradient', 'mist',
  'nebula', 'oddgrid', 'pixel_bloom', 'plasma', 'prism', 'sear', 'sonar', 'starfield', 'static',
  'studio_backdrop', 'terrain_bands', 'thread_contours', 'voronoi_cells', 'warp_tunnel', 'wisps',
]

/**
 * R11.9c fix round 1 (M1): the plain words for each Shader effect the runner doesn't take, by cause.
 * R10.2: each is a refusal now, everywhere: the words say what to change. Fix round 1 (c): one of your
 * own effects still goes to the local engine, locally with it up (NEEDS_LOCAL_ENGINE's toast), until the
 * browser bakes them; these words are for where it can't go.
 */
export const SHADER_ENGINE_WORDS = {
  /**
   * LC13: one of your own effects that wasn't drawn for this run (its run bound for the local engine, which
   * can't run them: Python's node knows only the catalogue). Sailor runs them, drawn in your browser.
   */
  myEffect: 'This shader is one of your own effects, and the local engine can’t run those. Run it in a workflow without local-engine nodes, or pick one of Sailor’s effects.',
  /** An effect id the runner's catalog doesn't list. */
  unknownEffect: 'This shader effect isn’t one Sailor knows yet. Pick another effect.',
  /** A setting wired in from another node. */
  wired: 'This shader’s settings are wired in from another node. Type them into the shader instead.',
  /** Params text Python reads one way and the browser another. */
  oddParams: 'This shader’s settings are written in a way Sailor can’t read. Change any setting in the shader to rewrite them.',
  /** A bake whose key doesn't agree with the prompt as sent. */
  keyMismatch: 'This shader changed after its frames were drawn. Run it again.',
  /** Fix round 1: an effect that works on a picture, with none wired in (Python raises; never ran anywhere). */
  needsPicture: 'This shader effect works on a picture. Wire one into it, or pick an effect that makes its own.',
} as const

/**
 * LC13: a My effect bake the server can't accept, in plain words (checked before the hold against the My
 * effects store: server/runner/myEffectBake.ts; the browser says `missing` too when its page doesn't have it).
 */
export const SHADER_MY_EFFECT_WORDS = {
  /** Not in the person's My effects: removed, or (hosted) someone else's. */
  missing: 'This shader’s effect isn’t in your My effects: it was removed, or it belongs to someone else. Pick another effect.',
  /** The effect's code or dials differ from what the frames were drawn with. */
  changed: 'This shader’s effect changed after its frames were drawn. Run it again.',
} as const

/** The node's `aspect` options. */
export const SHADER_ASPECTS = ['1:1', '16:9', '9:16', '4:5', '3:2'] as const

/** Why a Shader effect whose picture is made in the same run is refused (ruling: refused for now; R10.2: everywhere). */
export const SHADER_NEEDS_PICTURE_FIRST = 'This shader needs its picture before the run. Put the picture in an Image card first.'

/** An effect id as the node reads it: a legacy name → its current one. */
export function resolveShaderEffectId(id: string): string {
  return Object.prototype.hasOwnProperty.call(SHADER_LEGACY_EFFECT_IDS, id) ? SHADER_LEGACY_EFFECT_IDS[id]! : id
}

// ── Python's pure helpers ────────────────────────────────────────────────────

/** Python's round() of a float: half to even. */
function pyRound(x: number): number {
  const f = Math.floor(x)
  const d = x - f
  if (d > 0.5) return f + 1
  if (d < 0.5) return f
  return f % 2 === 0 ? f : f + 1
}

const ASPECT_RATIOS: Readonly<Record<string, readonly [number, number]>> = {
  '1:1': [1, 1], '16:9': [16, 9], '9:16': [9, 16], '4:5': [4, 5], '3:2': [3, 2],
}

/** `_aspect_size`: a generative effect's size, the longest edge `resolution`, both sides even (≥ 2). */
export function aspectSize(resolution: number, aspect: string): { w: number; h: number } {
  const [rw, rh] = Object.prototype.hasOwnProperty.call(ASPECT_RATIOS, aspect) ? ASPECT_RATIOS[aspect]! : [1, 1]
  let w: number, h: number
  if (rw >= rh) { w = resolution; h = pyRound(resolution * rh / rw) }
  else { w = pyRound(resolution * rw / rh); h = resolution }
  return { w: Math.max(2, w - (w % 2)), h: Math.max(2, h - (h % 2)) }
}

/** `frame_plan`: (input frame, u_time) per output frame. */
export function framePlan(batch: number, time: number, duration: number, fps: number): [number, number][] {
  const f = Math.max(1, Math.trunc(fps))
  if (batch > 1) return Array.from({ length: batch }, (_, i) => [i, time + i / f] as [number, number])
  if (duration > 0) return Array.from({ length: Math.max(1, pyRound(duration * f)) }, (_, i) => [0, time + i / f] as [number, number])
  return [[0, time]]
}

// ── The key ─────────────────────────────────────────────────────────────────

/** JSON with every object's keys sorted, no spaces; undefined (and a non-finite number) is null. */
export function canonicalJson(v: unknown): string {
  if (v === undefined || v === null) return 'null'
  if (typeof v === 'number') return Number.isFinite(v) ? JSON.stringify(v) : 'null'
  if (typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`
  }
  return 'null'
}

/** The settings the key covers, as the prompt carries them. */
const KEYED_INPUTS = ['effect', 'params', 'time', 'duration', 'fps', 'seed', 'resolution', 'aspect'] as const

/**
 * The text the key hashes: the node's settings as sent, its source files, the catalog's version, the baked
 * files, and (LC13) for a My effect the digest of the code and dials its frames were drawn with
 * (`myEffectSourceDigest`); a built-in effect's text is unchanged.
 */
export function shaderBakeKeyText(inputs: Record<string, unknown>, sources: readonly string[], catalogVersion: unknown, files: readonly string[], effectSource?: string): string {
  const o: Record<string, unknown> = {}
  for (const k of KEYED_INPUTS) o[k] = inputs[k]
  o.source = [...sources]
  o.catalogVersion = catalogVersion
  o.files = [...files]
  if (effectSource !== undefined) o.effectSource = effectSource
  return canonicalJson(o)
}

// ── LC13: My effects ────────────────────────────────────────────────────────

const MY_EFFECT_REF_RE = new RegExp(`^(${MY_EFFECT_ID_BODY})(?:~v([1-9]\\d{0,3}))?$`)

/**
 * LC13: a My effect as a Shader effect names it: its record id and the code version it renders
 * (app/lib/myEffects/defs.ts: `mine_x~vN` is version N's code, `versions[N-1]`; a bare `mine_x`, stored
 * before versions were pinned, is version 1). Null for anything else.
 */
export function myEffectRefOf(effect: unknown): { id: string; codeIndex: number } | null {
  if (typeof effect !== 'string') return null
  const m = MY_EFFECT_REF_RE.exec(effect)
  if (!m) return null
  return { id: m[1]!, codeIndex: m[2] ? Number(m[2]) - 1 : 0 }
}

/** The dial fields a render reads (resolveUniforms): what the digest covers of each dial, undefined left out. */
const DIAL_FIELDS = ['uniform', 'type', 'default', 'min', 'max', 'step', 'options'] as const

/**
 * LC13: the text a My effect's digest hashes: the GLSL source the browser compiles (the version's body
 * assembled with the shared preamble: shared/shadergen/contract.ts assembleSource) and its dials as declared.
 */
export function myEffectSourceText(source: string, params: readonly unknown[]): string {
  const dials = params.map((p) => {
    const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of DIAL_FIELDS) if (o[k] !== undefined) out[k] = o[k]
    return out
  })
  return canonicalJson({ source, dials })
}

/**
 * `u_seed`: Python's `seed % 10000` on `int(seed)` (the INT widget passes 5.5
 * through as 5.5; int() truncates it), a floor-mod as Python's `%`.
 */
export function shaderSeedUniform(seed: number): number {
  const n = Math.trunc(seed)
  return ((n % 10000) + 10000) % 10000
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/** SHA-256 of bytes, as lowercase hex (FIPS 180-4), synchronously. */
export function sha256HexSync(bytes: Uint8Array): string {
  const n = bytes.length
  const padded = new Uint8Array(((n + 9 + 63) >> 6) << 6)
  padded.set(bytes)
  padded[n] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(n / 0x20000000))
  view.setUint32(padded.length - 4, (n << 3) >>> 0)
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const w = new Uint32Array(64)
  const rotr = (x: number, r: number) => (x >>> r) | (x << (32 - r))
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3)
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as [number, number, number, number, number, number, number, number]
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) >>> 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    h[0] = (h[0]! + a) >>> 0; h[1] = (h[1]! + b) >>> 0; h[2] = (h[2]! + c) >>> 0; h[3] = (h[3]! + d) >>> 0
    h[4] = (h[4]! + e) >>> 0; h[5] = (h[5]! + f) >>> 0; h[6] = (h[6]! + g) >>> 0; h[7] = (h[7]! + hh) >>> 0
  }
  return [...h].map(x => x.toString(16).padStart(8, '0')).join('')
}

/** The key, worked out synchronously (eligibility). */
export function shaderBakeKeySync(inputs: Record<string, unknown>, sources: readonly string[], catalogVersion: unknown, files: readonly string[], effectSource?: string): string {
  return sha256HexSync(new TextEncoder().encode(shaderBakeKeyText(inputs, sources, catalogVersion, files, effectSource)))
}

/** LC13: a My effect's digest (sha256 hex of myEffectSourceText), synchronously: the same on the server and in the browser. */
export function myEffectSourceDigest(source: string, params: readonly unknown[]): string {
  return sha256HexSync(new TextEncoder().encode(myEffectSourceText(source, params)))
}

/** SHA-256 of bytes over Web Crypto (the browser, and node's global `crypto`), as lowercase hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle
  if (!subtle) return sha256HexSync(bytes)
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
  return [...digest].map(x => x.toString(16).padStart(2, '0')).join('')
}

/** The key over Web Crypto; the same digest as shaderBakeKeySync. */
export async function shaderBakeKey(inputs: Record<string, unknown>, sources: readonly string[], catalogVersion: unknown, files: readonly string[], effectSource?: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(shaderBakeKeyText(inputs, sources, catalogVersion, files, effectSource)))
}

// ── What the prompt carries ─────────────────────────────────────────────────

/** `source` (LC13): a My effect's digest (myEffectSourceDigest), which the key covers; absent for a built-in effect. */
export interface ShaderBaked { files: string[]; key: string; source?: string }

/**
 * `inputs.sailor_baked` as the runner reads it, or null: JSON text of `{ files: [non-empty text…], key: 64
 * hex }`, plus (LC13) `source`: 64 hex, for a My effect.
 */
export function parseShaderBaked(raw: unknown): ShaderBaked | null {
  if (typeof raw !== 'string') return null
  let v: unknown
  try { v = JSON.parse(raw) }
  catch { return null }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const { files, key, source } = v as { files?: unknown; key?: unknown; source?: unknown }
  if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) return null
  if (!Array.isArray(files) || !files.length || files.some(f => typeof f !== 'string' || !f.trim())) return null
  if (source !== undefined && (typeof source !== 'string' || !/^[0-9a-f]{64}$/.test(source))) return null
  return { files: files as string[], key, ...(source !== undefined ? { source } : {}) }
}

/**
 * A baked file's name as the upload stored it: an input file ('sub/name' or
 * 'name [input]'), no empty, '.' or '..' part (server/runner/inputs.ts
 * parseInputFileRef's rule), named `shader_bake_<32 hex>.png`. Returns the
 * hex (the first 32 of the PNG's sha256), or null for anything else.
 */
export function bakedFileHash(raw: string): string | null {
  let name = raw.trim()
  const m = /^(.*?)\s*\[(input|output|temp)\]$/.exec(name)
  if (m) {
    if (m[2] !== 'input') return null
    name = m[1]!
  }
  const parts = name.replace(/\\/g, '/').split('/')
  if (parts.some(p => !p || p === '.' || p === '..')) return null
  return /^shader_bake_([0-9a-f]{32})\.png$/.exec(parts[parts.length - 1]!)?.[1] ?? null
}

/** `inputs.sailor_baked` for these uploaded files and this key (LC13: and a My effect's digest). */
export function shaderBakedText(files: readonly string[], key: string, source?: string): string {
  return JSON.stringify(source !== undefined ? { files: [...files], key, source } : { files: [...files], key })
}

/**
 * R11.9c: a clip the browser has before the run, as the node's picture: Load
 * video frames of a file (its pick, from its settings as sent), or Get video
 * components of a file (a Load video's, or a Video card's). The browser
 * decodes its frames and renders the shader on each one.
 */
export type ShaderClipSource =
  | { loader: 'LoadVideoFrames'; nodeId: string; file: string; settings: Record<string, unknown> }
  | { loader: 'GetVideoComponents'; nodeId: string; file: string }

/** Load video frames' settings, as the prompt carries them (what picks its frames). */
const LOAD_FRAMES_SETTINGS = ['max_seconds', 'max_frames', 'max_size', 'start_frame', 'stride'] as const

/** Where a picture wire starts: a card's file, a clip's file, a card with none, or a node that makes it in the run. */
type SourceEnd = { kind: 'file'; nodeId: string; file: string } | { kind: 'clip'; clip: ShaderClipSource } | { kind: 'empty' } | { kind: 'made' }

const fileText = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

/** The video file a VIDEO wire brings before the run: a Load video's, or a Video card's own (not one fed by another node). */
function clipFileOf(prompt: ApiPrompt, link: ApiLink, depth = 0): string | null {
  const from = prompt[link[0]]
  if (!from || depth > 64 || link[1] !== 0) return null
  const inputs = from.inputs ?? {}
  if (from.class_type === 'LoadVideo') return isLink(inputs.file) ? null : fileText(inputs.file)
  if (from.class_type === GATE_CLASS) return isLink(inputs.data_in) ? clipFileOf(prompt, inputs.data_in, depth + 1) : null
  if (from.class_type === 'Video') return isLink(inputs.source) ? clipFileOf(prompt, inputs.source, depth + 1) : fileText(inputs.file)
  return null
}

function sourceEnd(prompt: ApiPrompt, link: ApiLink, depth = 0): SourceEnd {
  const node = prompt[link[0]]
  if (!node || depth > 64) return { kind: 'made' }
  const inputs = node.inputs ?? {}
  const own = (v: unknown): SourceEnd => typeof v === 'string' && v.trim() ? { kind: 'file', nodeId: link[0], file: v } : { kind: 'empty' }
  if (node.class_type === 'Image') return isLink(inputs.images) ? sourceEnd(prompt, inputs.images, depth + 1) : own(inputs.image)
  if (node.class_type === 'LoadImage') return link[1] === 0 ? own(inputs.image) : { kind: 'made' }
  if (node.class_type === GATE_CLASS && link[1] === 0 && isLink(inputs.data_in)) return sourceEnd(prompt, inputs.data_in, depth + 1)
  // R11.9c: a clip's frames the browser can decode before the run.
  if (node.class_type === 'LoadVideoFrames' && link[1] === 0) {
    const file = isLink(inputs.file) ? null : fileText(inputs.file)
    if (!file || LOAD_FRAMES_SETTINGS.some(k => isLink(inputs[k]))) return { kind: 'made' }
    const settings: Record<string, unknown> = {}
    for (const k of LOAD_FRAMES_SETTINGS) settings[k] = inputs[k]
    return { kind: 'clip', clip: { loader: 'LoadVideoFrames', nodeId: link[0], file, settings } }
  }
  if (node.class_type === 'GetVideoComponents' && link[1] === 0 && isLink(inputs.video)) {
    const file = clipFileOf(prompt, inputs.video)
    return file ? { kind: 'clip', clip: { loader: 'GetVideoComponents', nodeId: link[0], file } } : { kind: 'made' }
  }
  return { kind: 'made' }
}

/**
 * The file a picture wire brings when the browser has it before the run: an
 * Image card's own file or a LoadImage's picture, followed back through Image
 * cards fed by a wire and Gates (the card's widget text, as sent). Null when
 * the picture is made in the run (or the card holds none, or it is a clip).
 */
export function shaderSourceOf(prompt: ApiPrompt, link: ApiLink): { nodeId: string; file: string } | null {
  const end = sourceEnd(prompt, link)
  return end.kind === 'file' ? { nodeId: end.nodeId, file: end.file } : null
}

/**
 * R11.9c: what a Shader effect renders over, before the run: nothing (no
 * picture wired: a generative effect), a picture file (a still or an
 * animated picture), or a clip; null when its picture is made in the run.
 */
export type ShaderSource = { kind: 'none' } | { kind: 'picture'; file: string } | { kind: 'clip'; clip: ShaderClipSource }

export function shaderSourceOfNode(prompt: ApiPrompt, nodeId: string): ShaderSource | null {
  const image = prompt[nodeId]?.inputs?.image
  if (!isLink(image)) return { kind: 'none' }
  const end = sourceEnd(prompt, image)
  if (end.kind === 'file') return { kind: 'picture', file: end.file }
  if (end.kind === 'clip') return { kind: 'clip', clip: end.clip }
  return null
}

/** A clip's part of the key: its loader and, for Load video frames, the settings that pick its frames (as sent). */
function clipKeyText(clip: ShaderClipSource): string {
  return clip.loader === 'LoadVideoFrames' ? `LoadVideoFrames ${canonicalJson(clip.settings)}` : 'GetVideoComponents'
}

/**
 * The source files a Shader effect's key covers: none with no picture wired
 * (a generative effect), the one file the browser had before the run (R11.9c:
 * a clip's file and how its frames are picked), or null when its picture is
 * made in the run.
 */
export function shaderSourcesOf(prompt: ApiPrompt, nodeId: string): string[] | null {
  const src = shaderSourceOfNode(prompt, nodeId)
  if (!src) return null
  if (src.kind === 'none') return []
  if (src.kind === 'picture') return [src.file]
  return [src.clip.file, clipKeyText(src.clip)]
}

/** A number widget as Python's float() reads it (the widgets are already valid), or null. */
function floatOf(v: unknown): number | null {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return Number(v)
  if (typeof v === 'string') return pyFloatOf(v)
  return null
}

/**
 * R11.9c: how many frames `frame_plan` makes from a still (or with no picture):
 * one, or `duration · fps` of them when the shader moves over time. Null when
 * the settings can't be read.
 */
export function shaderPlanCount(inputs: Record<string, unknown>): number | null {
  const time = floatOf(inputs.time)
  const duration = floatOf(inputs.duration)
  const fps = floatOf(inputs.fps)
  if (time === null || duration === null || fps === null || ![time, duration, fps].every(Number.isFinite)) return null
  return framePlan(1, time, duration, Math.trunc(fps)).length
}

/**
 * R11.9c fix round 1 (I1): how many frames the node makes from a source of
 * `sourceFrames` frames (1 for a still or no picture): `frame_plan`'s count —
 * a batch's own frames when it has more than one, else the time setting's
 * (a clip or animation of one frame with a duration makes `round(duration ·
 * fps)` frames from it, as Python does). Null when the settings can't be read.
 * The browser bakes this many and the runner's turn expects this many.
 */
export function shaderFrameCount(sourceFrames: number, inputs: Record<string, unknown>): number | null {
  return sourceFrames > 1 ? sourceFrames : shaderPlanCount(inputs)
}

/** `render_effect` refuses a side over MAX_RENDER_DIM. */
export const SHADER_MAX_SIDE = 8192

/** R11.9c fix round 1 (I2): the words when a bake's pixels pass the caps. */
export const SHADER_FRAME_TOO_LARGE = 'This picture is too large for a shader here. Use a smaller picture or clip.'
export const SHADER_FRAMES_TOO_MUCH = 'This shader’s frames are too large to work with here. Lower its resolution, use a smaller picture or clip, or make fewer frames.'

/**
 * R11.9c fix round 1 (I2): the one check of a bake's size both the browser
 * (before it draws anything) and the runner (before the hold) make: the
 * frame cap (SHADER_MAX_FRAMES), each frame's side and pixels, and the
 * batch's frames and pixels against R5's batch caps (MEDIA_CAPS, as the
 * start pass and keepFrames hold every batch to). Plain words, or null.
 */
export function shaderBakeProblem(count: number, w: number, h: number, hosted: boolean, overSource: boolean): string | null {
  const caps = hosted ? MEDIA_CAPS.hosted : MEDIA_CAPS.local
  const cap = shaderFrameCap(hosted)
  if (count > cap) return shaderTooManyFramesWords(cap, overSource)
  if (w > SHADER_MAX_SIDE || h > SHADER_MAX_SIDE || w * h > caps.framePixels) return SHADER_FRAME_TOO_LARGE
  if (count > 1 && (count > caps.batchFrames || count * w * h > caps.batchPixels)) return SHADER_FRAMES_TOO_MUCH
  return null
}

/**
 * R11.9c: whether the Shader effect hands on a frame batch (a clip's frames
 * value) rather than one picture, read from its bake: several frames (its
 * time setting's, an animated picture's), or any over a clip (Python's
 * batch). Without a bake (the browser bakes only while `shader-bake` is on)
 * it is one picture, as before R11.9c, so nothing is answered differently
 * for a graph that isn't baked.
 */
export function shaderMakesBatch(prompt: ApiPrompt, nodeId: string): boolean {
  const baked = parseShaderBaked(prompt[nodeId]?.inputs?.sailor_baked)
  if (!baked) return false
  return baked.files.length > 1 || shaderSourceOfNode(prompt, nodeId)?.kind === 'clip'
}

/**
 * R11.9c: the most frames a Shader effect's bake may hold (the per-frame
 * classes' cap: hosted 300, locally 900). Checked in the browser before the
 * bake and by the runner before the hold.
 */
export const SHADER_MAX_FRAMES = { hosted: 300, local: 900 } as const

/** The cap where the run happens. */
export const shaderFrameCap = (hosted: boolean): number => (hosted ? SHADER_MAX_FRAMES.hosted : SHADER_MAX_FRAMES.local)

/** R11.9c: a Shader effect past the cap, in plain words (its source says what to shorten). */
export function shaderTooManyFramesWords(cap: number, overSource: boolean): string {
  return overSource
    ? `This shader would make too many frames here. Use a clip or animation of ${cap} frames or fewer.`
    : `This shader would make too many frames here. Keep it to ${cap} frames or fewer: shorten its duration or lower its frame rate.`
}

/**
 * R11.9c: the start's cap check (before the hold): the frames this Shader
 * effect's bake holds against the place's cap, in plain words; null when
 * within it (or not baked).
 */
export function shaderOverCapWords(prompt: ApiPrompt, nodeId: string, hosted: boolean, size: { w: number; h: number } | null = null): string | null {
  const baked = parseShaderBaked(prompt[nodeId]?.inputs?.sailor_baked)
  if (!baked) return null
  const n = baked.files.length
  const src = shaderSourceOfNode(prompt, nodeId)
  const overSource = src?.kind === 'clip' || (src?.kind === 'picture' && n !== shaderPlanCount(prompt[nodeId]!.inputs ?? {}))
  // Fix round 1 (I2): with frame 0's size, the whole shared check (frames, a frame's pixels, the batch's).
  if (size) return shaderBakeProblem(n, size.w, size.h, hosted, overSource)
  const cap = shaderFrameCap(hosted)
  return n > cap ? shaderTooManyFramesWords(cap, overSource) : null
}

/**
 * Whether the runner replays this Shader effect's bake (eligibility's
 * 'shader-bake'): an effect of the catalog; its picture unwired (a
 * generative effect), one the browser had before the run, or (R11.9c) a clip
 * it decoded; a bake named as the bake names its files, whose key agrees
 * with the prompt as sent; and as many frames as the node makes, where that
 * is known now: `frame_plan`'s from a still or with no picture (R11.9c: an
 * animated one is a frame batch), or several over an animated picture or a
 * clip, counted against the source's own frames at the node's turn
 * (cards/shaderEffect.ts). The cap is the start's, in plain words
 * (shaderOverCapWords), not a reason to leave it to the engine.
 */
export function shaderBakeTaken(prompt: ApiPrompt, nodeId: string): boolean {
  const inputs = prompt[nodeId]?.inputs ?? {}
  if (typeof inputs.effect !== 'string') return false
  const effect = resolveShaderEffectId(inputs.effect)
  // LC13: one of your own effects, baked over the code and dials its digest names (the key covers it); the
  // start checks the digest against the My effects store, the owner's (server/runner/myEffectBake.ts).
  const mine = myEffectRefOf(inputs.effect)
  if (!mine && !SHADER_EFFECT_IDS.includes(effect)) return false
  const plan = shaderPlanCount(inputs)
  if (plan === null) return false
  const src = shaderSourceOfNode(prompt, nodeId)
  if (!src) return false
  // A My effect's own generative flag is the store's, checked at the start.
  if (src.kind === 'none' && !mine && !SHADER_GENERATIVE_IDS.includes(effect)) return false
  const baked = parseShaderBaked(inputs.sailor_baked)
  if (!baked) return false
  if (!!mine !== (baked.source !== undefined)) return false
  const n = baked.files.length
  if (src.kind === 'none' && n !== plan) return false
  if (src.kind === 'picture' && n !== plan && n < 2) return false
  // A name that isn't one of the bake's own input files is left to the engine now, not failed late.
  if (baked.files.some(f => bakedFileHash(f) === null)) return false
  return baked.key === shaderBakeKeySync(inputs, shaderSourcesOf(prompt, nodeId)!, SHADER_CATALOG_VERSION, baked.files, baked.source)
}

/** The settings a Shader effect reads as typed (a wire into any of them leaves it to the engine). */
const SHADER_SETTINGS = ['effect', 'params', 'time', 'duration', 'fps', 'seed', 'resolution', 'aspect'] as const

const LOOKS_HEX = /^#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

/**
 * R11.9c fix round 1 (M1): whether params text has a shape both Python and
 * the browser read alike, without the catalog: blank, or a JSON object whose
 * values are finite numbers, null, portable colours, or lists of stops with
 * number positions and portable colours. (The browser's own check,
 * paramsPortable, also knows each param's type; this one only names the cause.)
 */
export function shaderParamsLookPortable(text: unknown): boolean {
  if (typeof text !== 'string') return false
  if (!text.trim()) return true
  let v: unknown
  try { v = JSON.parse(text) }
  catch { return false }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  for (const x of Object.values(v as Record<string, unknown>)) {
    if (x === null || (typeof x === 'number' && Number.isFinite(x))) continue
    if (typeof x === 'string' && LOOKS_HEX.test(x)) continue
    if (Array.isArray(x) && x.every(s => !!s && typeof s === 'object' && typeof (s as { pos?: unknown }).pos === 'number' && Number.isFinite((s as { pos: number }).pos)
      && typeof (s as { color?: unknown }).color === 'string' && LOOKS_HEX.test((s as { color: string }).color))) continue
    return false
  }
  return true
}

/**
 * Why the runner leaves a Shader effect to the engine, when there is a plain
 * reason to give (else null): its picture made in the run, and (R11.9c fix
 * round 1, M1) an effect the runner doesn't know, a wired setting, params
 * only Python reads, or a bake that no longer agrees with its settings. A
 * node simply not baked (its take bound for the engine) names none, but for
 * (LC13) one of your own effects: the runner takes it once the browser has
 * drawn it, and the local engine can't run it at all.
 */
export function shaderEngineReason(prompt: ApiPrompt, nodeId: string, families: ReadonlySet<RunnerFamily>): string | null {
  const node = prompt[nodeId]
  if (node?.class_type !== 'ShaderEffect' || !familyOn('shader-bake', families)) return null
  const inputs = node.inputs ?? {}
  const image = inputs.image
  if (isLink(image) && sourceEnd(prompt, image).kind === 'made') return SHADER_NEEDS_PICTURE_FIRST
  if (SHADER_SETTINGS.some(k => isLink(inputs[k]))) return SHADER_ENGINE_WORDS.wired
  // LC13: one of your own effects is the runner's (drawn in the browser); a `mine_` name of no shape a My effect has is unknown.
  const mine = myEffectRefOf(inputs.effect)
  if (!mine && typeof inputs.effect === 'string' && !SHADER_EFFECT_IDS.includes(resolveShaderEffectId(inputs.effect))) return SHADER_ENGINE_WORDS.unknownEffect
  if (!mine && !isLink(image) && typeof inputs.effect === 'string' && !SHADER_GENERATIVE_IDS.includes(resolveShaderEffectId(inputs.effect))) return SHADER_ENGINE_WORDS.needsPicture
  if (!shaderParamsLookPortable(inputs.params)) return SHADER_ENGINE_WORDS.oddParams
  const baked = parseShaderBaked(inputs.sailor_baked)
  if (baked && !shaderBakeTaken(prompt, nodeId)) {
    const sources = shaderSourcesOf(prompt, nodeId)
    if (sources && baked.key !== shaderBakeKeySync(inputs, sources, SHADER_CATALOG_VERSION, baked.files, baked.source)) return SHADER_ENGINE_WORDS.keyMismatch
    // LC13: a My effect's bake must name the code it was drawn with (a built-in's names none).
    if (!!mine !== (baked.source !== undefined)) return SHADER_ENGINE_WORDS.keyMismatch
  }
  // LC13: not drawn for this run (the browser draws only a run the runner takes): the local engine can't run it.
  if (mine && !baked) return SHADER_ENGINE_WORDS.myEffect
  return null
}
