/**
 * The browser's half of the Shader effect bake (step 3, R2.10; decision 9).
 * The server renders no GL, so at a runner submit the browser renders each
 * Shader effect it can, as it renders the node's own preview
 * (ShaderEffectNode.vue: the catalog's source, `resolveUniforms`,
 * `expandPasses`, ShaderFxRenderer), at the size and with the uniforms
 * comfy_extras/nodes_shader_effects.py uses; reads the RGBA back, drops
 * alpha, encodes a PNG, uploads it to input under its content hash (a repeat
 * dedupes) and writes `inputs.sailor_baked` = `{ files, key }` into the
 * prompt. The runner replays the file (server/runner/cards/shaderEffect.ts).
 *
 * A node it can't bake is left without `sailor_baked`, and so to the engine
 * (or named as needing it): an effect the runner doesn't know (a My effect,
 * a draft), an animated one (ruling f), a picture made in the same run
 * (ruling: refused for now), settings Python reads differently from the
 * browser (paramsPortable). A render or upload that fails is reported back
 * (`failed`), for a toast.
 */
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { runnerTakesNode } from '#shared/runner/eligibility'
import {
  SHADER_EFFECT_IDS, SHADER_GENERATIVE_IDS, aspectSize, framePlan, resolveShaderEffectId, shaderBakeKey,
  shaderBakedText, shaderSeedUniform, shaderSourcesOf, sha256Hex,
} from '#shared/runner/shaderBakeKey'
import { parseParams, resolveUniforms } from '~/lib/shaderfx/params'
import { expandPasses, type ShaderPass } from '~/lib/shaderfx/renderer'
import type { EffectDef, EffectTextureDef, ShaderFxCatalog } from '~/lib/shaderfx/types'

export { shaderBakeKey }

/**
 * A picture ready to upload as a texture, with its size. `animated`: the file
 * has several frames (Python renders one per frame; the batch path is
 * deferred with ruling f), so the node is not baked and goes to the engine.
 */
export interface BakePicture { image: TexImageSource; width: number; height: number; animated?: boolean }

/** What a bake needs from the page (the tests give fakes). */
export interface ShaderBakeContext {
  catalog: ShaderFxCatalog
  renderer: { render(passes: ShaderPass[], base: TexImageSource, width: number, height: number): HTMLCanvasElement }
  /** Uploads a PNG to input under `name`; the stored name as a card's widget holds it ('sub/name.png'). */
  upload(bytes: Uint8Array, name: string): Promise<string>
  /** The picture a source file names (a card's widget text, 'name.png [input]'), EXIF turned. */
  sourceFile(file: string): Promise<BakePicture>
  /** A catalog texture (a glyph atlas), loaded. */
  texture(def: EffectDef, t: EffectTextureDef): Promise<TexImageSource>
  /** An opaque black picture of this size: a generative effect's base (Python's zeros). */
  blank(width: number, height: number): TexImageSource
  /** The RGBA pixels of the canvas `render` returned, top row first; throws when the drawing buffer isn't that size (the browser clamped it). */
  readPixels(canvas: HTMLCanvasElement, width: number, height: number): Uint8Array
  /** An 8-bit PNG of these RGBA pixels (alpha 255). */
  encodePng(rgba: Uint8Array, width: number, height: number): Promise<Uint8Array>
}

/** A run's context: made once for the run, released (its WebGL context lost) when the run's bakes are done. */
export interface ShaderBakeRunContext extends ShaderBakeContext { release(): void }

export interface ShaderBakeResult {
  /** The nodes given a bake. */
  baked: string[]
  /** The nodes whose render or upload failed (left to the engine). */
  failed: { nodeId: string; error: string }[]
}

/** A colour both Python's parse_hex and the browser's hexVec3 read the same: 3, 6 or 8 hex digits, one optional '#'. */
const portableHex = (x: unknown) => typeof x === 'string' && /^#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(x)

/**
 * Whether Python's resolve_params and the browser's resolveValues read these
 * params alike: JSON text of an object (or blank), each of the effect's
 * params a finite number (float, enum), a portable colour, a list of stops
 * with finite positions and portable colours, or null. Anything else (a
 * number as text, a 4-digit colour, a ramp as text, NaN) is read one way by
 * Python and another by the browser, so it is not baked.
 */
export function paramsPortable(def: EffectDef, text: unknown): boolean {
  if (typeof text !== 'string') return false
  if (!text.trim()) return true
  let v: unknown
  try { v = JSON.parse(text) }
  catch { return false }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const o = v as Record<string, unknown>
  for (const p of def.params) {
    if (!Object.prototype.hasOwnProperty.call(o, p.uniform)) continue
    const x = o[p.uniform]
    if (x === null) continue
    if (p.type === 'color') { if (!portableHex(x)) return false }
    else if (p.type === 'gradient') {
      if (!Array.isArray(x)) return false
      for (const s of x) {
        if (!s || typeof s !== 'object' || Array.isArray(s)) return false
        const { pos, color } = s as { pos?: unknown; color?: unknown }
        if (typeof pos !== 'number' || !Number.isFinite(pos) || !portableHex(color)) return false
      }
    }
    else if (typeof x !== 'number' || !Number.isFinite(x)) return false
  }
  return true
}

/**
 * The uniforms Python uploads for one frame: to_uniforms(resolve_params),
 * then the textures' extraUniforms, then u_time, u_seed (`int(seed) % 10000`) and u_hasInput.
 */
export function bakeUniforms(def: EffectDef, params: string, o: { time: number; seed: number; hasInput: boolean }): Record<string, number | [number, number, number]> {
  const extra: Record<string, number> = {}
  for (const t of def.textures) for (const [k, v] of Object.entries(t.extraUniforms ?? {})) extra[k] = v
  return { ...resolveUniforms(def, parseParams(params)), ...extra, u_time: o.time, u_seed: shaderSeedUniform(o.seed), u_hasInput: o.hasInput ? 1 : 0 }
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** The built-in effect a node names, when the runner can replay it. */
function bakeableEffect(catalog: ShaderFxCatalog, raw: unknown): EffectDef | null {
  if (typeof raw !== 'string') return null
  const id = resolveShaderEffectId(raw)
  if (!SHADER_EFFECT_IDS.includes(id)) return null
  return catalog.effects.find(e => e.id === id && !e.mine && !e.draft && !e.versionOf) ?? null
}

/**
 * Bakes every Shader effect of the prompt the runner can replay, writing
 * `sailor_baked` into its inputs. Never throws: a node that fails is listed.
 */
export async function bakeShaderEffects(prompt: ApiPrompt, ctx: ShaderBakeContext): Promise<ShaderBakeResult> {
  const result: ShaderBakeResult = { baked: [], failed: [] }
  for (const [nodeId, node] of Object.entries(prompt)) {
    if (node.class_type !== 'ShaderEffect') continue
    const inputs = node.inputs ?? {}
    delete inputs.sailor_baked
    const def = bakeableEffect(ctx.catalog, inputs.effect)
    if (!def) continue
    const { time, duration, fps, seed, resolution, aspect, params } = inputs
    if (!num(time) || !num(duration) || !num(fps) || !num(seed) || !num(resolution) || typeof aspect !== 'string') continue
    // An animated still (a duration) stays on the engine for now (ruling f).
    if (duration > 0) continue
    const sources = shaderSourcesOf(prompt, nodeId)
    if (!sources) continue
    if (!sources.length && !SHADER_GENERATIVE_IDS.includes(def.id)) continue
    if (!paramsPortable(def, params)) continue
    try {
      const picture = sources.length ? await ctx.sourceFile(sources[0]!) : null
      // An animated source: Python renders a frame per frame; not baked, so it goes to the engine as before.
      if (picture?.animated) continue
      const size = picture ? { w: picture.width, h: picture.height } : aspectSize(Math.trunc(resolution), aspect)
      const textures: Record<string, TexImageSource> = {}
      for (const t of def.textures) textures[t.uniform] = await ctx.texture(def, t)
      const base = picture?.image ?? ctx.blank(size.w, size.h)
      const files: string[] = []
      for (const [, t] of framePlan(1, time, duration, fps)) {
        const uniforms = bakeUniforms(def, typeof params === 'string' ? params : '', { time: t, seed, hasInput: !!picture })
        const canvas = ctx.renderer.render(expandPasses(def.id, def.source, uniforms, textures, def.passes ?? 1), base, size.w, size.h)
        const rgba = ctx.readPixels(canvas, size.w, size.h)
        // Python keeps o[..., :3]: the alpha the shader wrote is dropped.
        for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255
        const png = await ctx.encodePng(rgba, size.w, size.h)
        files.push(await ctx.upload(png, `shader_bake_${(await sha256Hex(png)).slice(0, 32)}.png`))
      }
      inputs.sailor_baked = shaderBakedText(files, await shaderBakeKey(inputs, sources, ctx.catalog.version, files))
      result.baked.push(nodeId)
    }
    catch (e) {
      delete inputs.sailor_baked
      result.failed.push({ nodeId, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return result
}

/**
 * Whether a take goes to the runner once its Shader effects are baked: it has
 * a Shader effect, and every other node passes `runnerTakesNode`. A take bound
 * for the engine anyway is not baked (nothing rendered, nothing uploaded).
 */
export function takeWantsShaderBake(prompt: ApiPrompt | null | undefined, families: ReadonlySet<RunnerFamily>): prompt is ApiPrompt {
  if (!prompt) return false
  const ids = Object.keys(prompt)
  if (!ids.some(id => prompt[id]!.class_type === 'ShaderEffect')) return false
  return ids.every(id => prompt[id]!.class_type === 'ShaderEffect' || runnerTakesNode(prompt, id, families))
}

/**
 * Bakes a run's takes: only the takes going to the runner (takeWantsShaderBake),
 * with one context for the whole run, made only when a take needs it and
 * released in `finally` whatever happens.
 */
export async function bakeShaderTakes(
  prompts: readonly (ApiPrompt | null | undefined)[],
  families: ReadonlySet<RunnerFamily>,
  makeContext: () => Promise<ShaderBakeRunContext>,
): Promise<ShaderBakeResult> {
  const result: ShaderBakeResult = { baked: [], failed: [] }
  const wanted = prompts.filter((p): p is ApiPrompt => takeWantsShaderBake(p, families))
  if (!wanted.length) return result
  let ctx: ShaderBakeRunContext
  try { ctx = await makeContext() }
  catch (e) {
    for (const p of wanted) {
      for (const [nodeId, n] of Object.entries(p)) if (n.class_type === 'ShaderEffect') result.failed.push({ nodeId, error: e instanceof Error ? e.message : String(e) })
    }
    return result
  }
  try {
    for (const p of wanted) {
      const r = await bakeShaderEffects(p, ctx)
      result.baked.push(...r.baked)
      result.failed.push(...r.failed)
    }
  }
  finally {
    ctx.release()
  }
  return result
}

// ── Animated sources ─────────────────────────────────────────────────────────

/** A GIF's image count (image descriptors), walking its blocks; 0 when it isn't a readable GIF. */
function gifFrames(b: Uint8Array): number {
  if (b.length < 13 || String.fromCharCode(b[0]!, b[1]!, b[2]!) !== 'GIF') return 0
  let i = 13
  if (b[10]! & 0x80) i += 3 * (1 << ((b[10]! & 7) + 1))
  const subBlocks = () => { while (i < b.length && b[i] !== 0) i += b[i]! + 1; i++ }
  let frames = 0
  while (i < b.length) {
    const tag = b[i]
    if (tag === 0x3B) break
    if (tag === 0x21) { i += 2; subBlocks() }
    else if (tag === 0x2C) {
      if (i + 10 > b.length) break
      const packed = b[i + 9]!
      i += 10
      if (packed & 0x80) i += 3 * (1 << ((packed & 7) + 1))
      i++ // LZW minimum code size
      subBlocks()
      frames++
      if (frames > 1) return frames
    }
    else break
  }
  return frames
}

/** An APNG: an `acTL` chunk before the first IDAT. */
function pngAnimated(b: Uint8Array): boolean {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10]
  if (b.length < 8 || sig.some((v, k) => b[k] !== v)) return false
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  for (let i = 8; i + 8 <= b.length;) {
    const len = view.getUint32(i)
    const type = String.fromCharCode(b[i + 4]!, b[i + 5]!, b[i + 6]!, b[i + 7]!)
    if (type === 'acTL') return true
    if (type === 'IDAT' || type === 'IEND') return false
    i += 12 + len
  }
  return false
}

/** An animated WebP: a VP8X header with the animation flag, or an ANIM chunk. */
function webpAnimated(b: Uint8Array): boolean {
  const tag = (k: number) => String.fromCharCode(b[k]!, b[k + 1]!, b[k + 2]!, b[k + 3]!)
  if (b.length < 16 || tag(0) !== 'RIFF' || tag(8) !== 'WEBP') return false
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  for (let i = 12; i + 8 <= b.length;) {
    const type = tag(i)
    const len = view.getUint32(i + 4, true)
    if (type === 'ANIM' || type === 'ANMF') return true
    if (type === 'VP8X' && i + 8 < b.length && (b[i + 8]! & 0x02)) return true
    i += 8 + len + (len & 1)
  }
  return false
}

/** Whether a picture file has several frames (a GIF of several images, an APNG, an animated WebP). */
export function pictureIsAnimated(bytes: Uint8Array): boolean {
  return gifFrames(bytes) > 1 || pngAnimated(bytes) || webpAnimated(bytes)
}

// ── The page's own context ───────────────────────────────────────────────────

/** A card's widget text ('sub/name.png [input]') → the /view link. */
export function viewUrlOf(file: string): string {
  let name = file.trim()
  let type = 'input'
  const m = /^(.*?)\s*\[(input|output|temp)\]$/.exec(name)
  if (m) { name = m[1]!; type = m[2]! }
  const parts = name.replace(/\\/g, '/').split('/')
  const filename = parts.pop() ?? ''
  return `/view?${new URLSearchParams({ filename, subfolder: parts.join('/'), type })}`
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('A picture for the shader couldn’t be loaded'))
    img.src = url
  })
}

/**
 * Bakes a run's takes (bakeShaderTakes) with the page's own catalog, one
 * renderer for the run (the node previews keep theirs; its WebGL context is
 * lost when the run's bakes are done) and the /upload/image rail.
 */
export async function bakeShaderEffectsForRun(prompts: readonly (ApiPrompt | null | undefined)[], families: ReadonlySet<RunnerFamily>): Promise<ShaderBakeResult> {
  return bakeShaderTakes(prompts, families, async () => {
    const { fetchShaderFxCatalog, assetUrl } = await import('~/lib/shaderfx/catalog')
    const { ShaderFxRenderer } = await import('~/lib/shaderfx/renderer')
    const catalog = await fetchShaderFxCatalog()
    const renderer = new ShaderFxRenderer()
    const textures = new Map<string, Promise<HTMLImageElement>>()
    return {
      catalog,
      renderer,
      release() {
        // dispose() deletes every GL object and loses the context (WEBGL_lose_context), so runs don't pile up contexts.
        const gl = renderer.outputCanvas?.getContext('webgl2') ?? null
        renderer.dispose()
        if (gl && !gl.isContextLost()) gl.getExtension('WEBGL_lose_context')?.loseContext()
      },
      async upload(bytes, name) {
        const fd = new FormData()
        fd.append('image', new File([bytes as BlobPart], name, { type: 'image/png' }))
        fd.append('overwrite', 'true')
        const res = await fetch('/upload/image', { method: 'POST', body: fd })
        if (!res.ok) throw new Error(`The shader’s picture couldn’t be uploaded (${res.status})`)
        const data = await res.json() as { name?: string; subfolder?: string }
        if (!data.name) throw new Error('The shader’s picture couldn’t be uploaded')
        return data.subfolder ? `${data.subfolder}/${data.name}` : data.name
      },
      async sourceFile(file) {
        const res = await fetch(viewUrlOf(file))
        if (!res.ok) throw new Error('A picture for the shader couldn’t be loaded')
        const bytes = new Uint8Array(await res.arrayBuffer())
        if (pictureIsAnimated(bytes)) return { image: null as unknown as TexImageSource, width: 0, height: 0, animated: true }
        const url = URL.createObjectURL(new Blob([bytes as BlobPart]))
        try {
          const img = await loadImage(url)
          await img.decode().catch(() => {})
          return { image: img, width: img.naturalWidth, height: img.naturalHeight }
        }
        finally { URL.revokeObjectURL(url) }
      },
      texture(_def, t) {
        let p = textures.get(t.file)
        if (!p) { p = loadImage(assetUrl(t.file, t.v)); textures.set(t.file, p) }
        return p
      },
      blank(width, height) {
        const c = document.createElement('canvas')
        c.width = width
        c.height = height
        const g = c.getContext('2d')!
        g.fillStyle = '#000'
        g.fillRect(0, 0, width, height)
        return c
      },
      readPixels(canvas, width, height) {
        // The renderer's own context (getContext hands back the one it made); GL rows run bottom up.
        const gl = canvas.getContext('webgl2')
        if (!gl) throw new Error('The shader’s picture couldn’t be read')
        // A browser may clamp a large canvas silently: then this is not Python's size, and nothing is uploaded.
        if (gl.drawingBufferWidth !== width || gl.drawingBufferHeight !== height) throw new Error('The picture is too large for this browser to render the shader')
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        const up = new Uint8Array(width * height * 4)
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, up)
        const out = new Uint8Array(up.length)
        const row = width * 4
        for (let y = 0; y < height; y++) out.set(up.subarray((height - 1 - y) * row, (height - y) * row), y * row)
        return out
      },
      async encodePng(rgba, width, height) {
        const c = document.createElement('canvas')
        c.width = width
        c.height = height
        const data = new Uint8ClampedArray(rgba.length)
        data.set(rgba)
        c.getContext('2d')!.putImageData(new ImageData(data, width, height), 0, 0)
        const blob = await new Promise<Blob | null>(resolve => c.toBlob(resolve, 'image/png'))
        if (!blob) throw new Error('The shader’s picture couldn’t be saved')
        return new Uint8Array(await blob.arrayBuffer())
      },
    }
  })
}
