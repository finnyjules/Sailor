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
import {
  SHADER_EFFECT_IDS, SHADER_GENERATIVE_IDS, aspectSize, framePlan, resolveShaderEffectId, shaderBakeKey,
  shaderBakedText, shaderSourcesOf, sha256Hex,
} from '#shared/runner/shaderBakeKey'
import { parseParams, resolveUniforms } from '~/lib/shaderfx/params'
import { expandPasses, type ShaderPass } from '~/lib/shaderfx/renderer'
import type { EffectDef, EffectTextureDef, ShaderFxCatalog } from '~/lib/shaderfx/types'

export { shaderBakeKey }

/** A picture ready to upload as a texture, with its size. */
export interface BakePicture { image: TexImageSource; width: number; height: number }

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
  /** The RGBA pixels of the canvas `render` returned, top row first. */
  readPixels(canvas: HTMLCanvasElement, width: number, height: number): Uint8Array
  /** An 8-bit PNG of these RGBA pixels (alpha 255). */
  encodePng(rgba: Uint8Array, width: number, height: number): Promise<Uint8Array>
}

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
 * then the textures' extraUniforms, then u_time, u_seed and u_hasInput.
 */
export function bakeUniforms(def: EffectDef, params: string, o: { time: number; seed: number; hasInput: boolean }): Record<string, number | [number, number, number]> {
  const extra: Record<string, number> = {}
  for (const t of def.textures) for (const [k, v] of Object.entries(t.extraUniforms ?? {})) extra[k] = v
  return { ...resolveUniforms(def, parseParams(params)), ...extra, u_time: o.time, u_seed: o.seed % 10000, u_hasInput: o.hasInput ? 1 : 0 }
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
      inputs.sailor_baked = shaderBakedText(files, await shaderBakeKey(inputs, sources, ctx.catalog.version))
      result.baked.push(nodeId)
    }
    catch (e) {
      delete inputs.sailor_baked
      result.failed.push({ nodeId, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return result
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
 * Bakes the prompt's Shader effects with the page's own catalog, a renderer
 * of its own (the node previews keep theirs) and the /upload/image rail.
 */
export async function bakeShaderEffectsForRun(prompt: ApiPrompt): Promise<ShaderBakeResult> {
  if (!Object.values(prompt).some(n => n.class_type === 'ShaderEffect')) return { baked: [], failed: [] }
  const { fetchShaderFxCatalog, assetUrl } = await import('~/lib/shaderfx/catalog')
  const { ShaderFxRenderer } = await import('~/lib/shaderfx/renderer')
  let catalog: ShaderFxCatalog
  try { catalog = await fetchShaderFxCatalog() }
  catch (e) {
    const ids = Object.entries(prompt).filter(([, n]) => n.class_type === 'ShaderEffect').map(([id]) => id)
    return { baked: [], failed: ids.map(nodeId => ({ nodeId, error: e instanceof Error ? e.message : String(e) })) }
  }
  const renderer = new ShaderFxRenderer()
  const textures = new Map<string, Promise<HTMLImageElement>>()
  try {
    return await bakeShaderEffects(prompt, {
      catalog,
      renderer,
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
        const img = await loadImage(viewUrlOf(file))
        return { image: img, width: img.naturalWidth, height: img.naturalHeight }
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
    })
  }
  finally {
    renderer.dispose()
  }
}
