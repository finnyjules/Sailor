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
 * key is worked out synchronously here
 * (eligibility is synchronous, in the browser and on the server alike); the
 * browser's `shaderBakeKey` computes the same digest over Web Crypto.
 *
 * Also here, from comfy_extras/nodes_shader_effects.py and _shader_effects.py
 * (pinned by tests/unit/fixtures/runner-effects-shader.json): the catalog's
 * version, the node's effect options, which effects are generative,
 * `_aspect_size` and `frame_plan`. Pure, relative imports only: the browser
 * and the server share it.
 */
import { isLink, type ApiLink, type ApiPrompt } from './graph'
import { pyFloatOf } from './pyText'
import { familyOn, type RunnerFamily } from './families'

/** The catalog's `version` (shader_effects/manifest.json) the runner replays bakes of. */
export const SHADER_CATALOG_VERSION = 1

/** Renamed effects (nodes_shader_effects.py LEGACY_EFFECT_IDS). */
export const SHADER_LEGACY_EFFECT_IDS: Readonly<Record<string, string>> = { filament: 'thread_contours' }

/**
 * The catalog's effects, as the node's `effect` options list them (the legacy
 * names apart). An effect not listed (a new one, a My effect, a draft) is left
 * to the engine.
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

/** The node's `aspect` options. */
export const SHADER_ASPECTS = ['1:1', '16:9', '9:16', '4:5', '3:2'] as const

/** The needs-engine reason of a Shader effect whose picture is made in the same run (ruling: refused for now). */
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

/** The text the key hashes: the node's settings as sent, its source files, the catalog's version, the baked files. */
export function shaderBakeKeyText(inputs: Record<string, unknown>, sources: readonly string[], catalogVersion: unknown, files: readonly string[]): string {
  const o: Record<string, unknown> = {}
  for (const k of KEYED_INPUTS) o[k] = inputs[k]
  o.source = [...sources]
  o.catalogVersion = catalogVersion
  o.files = [...files]
  return canonicalJson(o)
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
export function shaderBakeKeySync(inputs: Record<string, unknown>, sources: readonly string[], catalogVersion: unknown, files: readonly string[]): string {
  return sha256HexSync(new TextEncoder().encode(shaderBakeKeyText(inputs, sources, catalogVersion, files)))
}

/** SHA-256 of bytes over Web Crypto (the browser, and node's global `crypto`), as lowercase hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle
  if (!subtle) return sha256HexSync(bytes)
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
  return [...digest].map(x => x.toString(16).padStart(2, '0')).join('')
}

/** The key over Web Crypto; the same digest as shaderBakeKeySync. */
export async function shaderBakeKey(inputs: Record<string, unknown>, sources: readonly string[], catalogVersion: unknown, files: readonly string[]): Promise<string> {
  return sha256Hex(new TextEncoder().encode(shaderBakeKeyText(inputs, sources, catalogVersion, files)))
}

// ── What the prompt carries ─────────────────────────────────────────────────

export interface ShaderBaked { files: string[]; key: string }

/** `inputs.sailor_baked` as the runner reads it, or null: JSON text of `{ files: [non-empty text…], key: 64 hex }`. */
export function parseShaderBaked(raw: unknown): ShaderBaked | null {
  if (typeof raw !== 'string') return null
  let v: unknown
  try { v = JSON.parse(raw) }
  catch { return null }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const { files, key } = v as { files?: unknown; key?: unknown }
  if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) return null
  if (!Array.isArray(files) || !files.length || files.some(f => typeof f !== 'string' || !f.trim())) return null
  return { files: files as string[], key }
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

/** `inputs.sailor_baked` for these uploaded files and this key. */
export function shaderBakedText(files: readonly string[], key: string): string {
  return JSON.stringify({ files: [...files], key })
}

/** Where a picture wire starts: a card's file, a card with none, or a node that makes it in the run. */
type SourceEnd = { kind: 'file'; nodeId: string; file: string } | { kind: 'empty' } | { kind: 'made' }

function sourceEnd(prompt: ApiPrompt, link: ApiLink, depth = 0): SourceEnd {
  const node = prompt[link[0]]
  if (!node || depth > 64) return { kind: 'made' }
  const inputs = node.inputs ?? {}
  const own = (v: unknown): SourceEnd => typeof v === 'string' && v.trim() ? { kind: 'file', nodeId: link[0], file: v } : { kind: 'empty' }
  if (node.class_type === 'Image') return isLink(inputs.images) ? sourceEnd(prompt, inputs.images, depth + 1) : own(inputs.image)
  if (node.class_type === 'LoadImage') return link[1] === 0 ? own(inputs.image) : { kind: 'made' }
  if (node.class_type === 'ComfyGateNode' && link[1] === 0 && isLink(inputs.data_in)) return sourceEnd(prompt, inputs.data_in, depth + 1)
  return { kind: 'made' }
}

/**
 * The file a picture wire brings when the browser has it before the run: an
 * Image card's own file or a LoadImage's picture, followed back through Image
 * cards fed by a wire and Gates (the card's widget text, as sent). Null when
 * the picture is made in the run (or the card holds none).
 */
export function shaderSourceOf(prompt: ApiPrompt, link: ApiLink): { nodeId: string; file: string } | null {
  const end = sourceEnd(prompt, link)
  return end.kind === 'file' ? { nodeId: end.nodeId, file: end.file } : null
}

/**
 * The source files a Shader effect's key covers: none with no picture wired
 * (a generative effect), the one file the browser had before the run, or
 * null when its picture is made in the run.
 */
export function shaderSourcesOf(prompt: ApiPrompt, nodeId: string): string[] | null {
  const image = prompt[nodeId]?.inputs?.image
  if (!isLink(image)) return []
  const src = shaderSourceOf(prompt, image)
  return src ? [src.file] : null
}

/** A number widget as Python's float() reads it (the widgets are already valid), or null. */
function floatOf(v: unknown): number | null {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return Number(v)
  if (typeof v === 'string') return pyFloatOf(v)
  return null
}

/**
 * Whether the runner replays this Shader effect's bake (eligibility's
 * 'shader-bake'): an effect of the catalog; a still (`duration` 0; an animated
 * one stays on the engine for now, ruling f); its picture unwired (a
 * generative effect) or one the browser had before the run; and a bake of one
 * frame, named as the bake names its files, whose key agrees with the prompt
 * as sent. (A source's frames can't be seen here: the browser doesn't bake an
 * animated one, which goes to the engine; the batch path is deferred with
 * ruling f.)
 */
export function shaderBakeTaken(prompt: ApiPrompt, nodeId: string): boolean {
  const inputs = prompt[nodeId]?.inputs ?? {}
  if (typeof inputs.effect !== 'string') return false
  const effect = resolveShaderEffectId(inputs.effect)
  if (!SHADER_EFFECT_IDS.includes(effect)) return false
  const duration = floatOf(inputs.duration)
  if (duration === null || duration > 0 || Number.isNaN(duration)) return false
  const sources = shaderSourcesOf(prompt, nodeId)
  if (!sources) return false
  if (!sources.length && !SHADER_GENERATIVE_IDS.includes(effect)) return false
  const baked = parseShaderBaked(inputs.sailor_baked)
  if (!baked || baked.files.length !== 1) return false
  // A name that isn't one of the bake's own input files is left to the engine now, not failed late.
  if (baked.files.some(f => bakedFileHash(f) === null)) return false
  return baked.key === shaderBakeKeySync(inputs, sources, SHADER_CATALOG_VERSION, baked.files)
}

/** Why the runner leaves a Shader effect to the engine, when there is a plain reason to give (else null). */
export function shaderEngineReason(prompt: ApiPrompt, nodeId: string, families: ReadonlySet<RunnerFamily>): string | null {
  const node = prompt[nodeId]
  if (node?.class_type !== 'ShaderEffect' || !familyOn('shader-bake', families)) return null
  const image = node.inputs?.image
  return isLink(image) && sourceEnd(prompt, image).kind === 'made' ? SHADER_NEEDS_PICTURE_FIRST : null
}
