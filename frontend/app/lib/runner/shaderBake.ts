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
 * R11.9c (USER ruling (d)): an animated Shader effect is baked the same way,
 * every frame: its time setting's frames (`frame_plan`, u_time stepped by
 * 1 / fps), an animated picture's frames (ImageDecoder), or a clip's frames
 * (Mediabunny, picked as Load video frames or Get video components picks
 * them), a PNG each, uploaded only once every frame is rendered. The frame
 * cap (hosted 300, locally 900) is checked before any render; Stop
 * (`stopShaderBakes`) ends the bake and uploads nothing more; a failure is
 * reported `animated`, for a plain error at Run (never the engine).
 *
 * A node it can't bake is left without `sailor_baked`, and so to the engine
 * (or named as needing it): an effect the runner doesn't know (a My effect,
 * a draft), a picture made in the same run (ruling: refused for now),
 * settings Python reads differently from the browser (paramsPortable). A
 * still's render or upload that fails is reported back (`failed`), for a toast.
 */
import type { ApiPrompt } from '#shared/runner/graph'
import { familyOn, type RunnerFamily } from '#shared/runner/families'
import { runnerTakesNode } from '#shared/runner/eligibility'
import {
  SHADER_EFFECT_IDS, SHADER_GENERATIVE_IDS, aspectSize, framePlan, resolveShaderEffectId, shaderBakeKey,
  shaderBakedText, shaderFrameCap, shaderSeedUniform, shaderSourceOfNode, shaderSourcesOf, shaderTooManyFramesWords, sha256Hex,
  type ShaderClipSource,
} from '#shared/runner/shaderBakeKey'
import { parseParams, resolveUniforms } from '~/lib/shaderfx/params'
import { expandPasses, type ShaderPass } from '~/lib/shaderfx/renderer'
import type { EffectDef, EffectTextureDef, ShaderFxCatalog } from '~/lib/shaderfx/types'

export { shaderBakeKey }

/**
 * A picture ready to upload as a texture, with its size. `animated`: the file
 * has several frames (Python's LoadImage makes a batch of them): R11.9c bakes
 * each one, read through `sourceFrames`.
 */
export interface BakePicture { image: TexImageSource; width: number; height: number; animated?: boolean }

/** R11.9c: a source of several frames, as the bake reads it: an animated picture, or a clip. */
export type BakeFramesSource = { kind: 'picture'; file: string } | { kind: 'clip'; clip: ShaderClipSource }

/**
 * R11.9c: a source's frames. `count`: how many it holds, at most (a clip's
 * packets, picked as its loader picks them), checked against the cap before
 * any render. Each frame stays valid until the next is asked for, and the
 * last one until `close()`.
 */
export interface BakeFrames {
  count: number
  width: number
  height: number
  frames: AsyncIterable<TexImageSource>
  close(): void
}

/** What a bake needs from the page (the tests give fakes). */
export interface ShaderBakeContext {
  catalog: ShaderFxCatalog
  renderer: { render(passes: ShaderPass[], base: TexImageSource, width: number, height: number): HTMLCanvasElement }
  /** Uploads a PNG to input under `name`; the stored name as a card's widget holds it ('sub/name.png'). Stop aborts it. */
  upload(bytes: Uint8Array, name: string, signal?: AbortSignal): Promise<string>
  /** The picture a source file names (a card's widget text, 'name.png [input]'), EXIF turned. */
  sourceFile(file: string): Promise<BakePicture>
  /** R11.9c: an animated picture's frames, or a clip's frames as its loader picks them. */
  sourceFrames(src: BakeFramesSource, signal: AbortSignal): Promise<BakeFrames>
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

/** A node whose bake failed: `animated` (R11.9c) when it makes several frames, so the run is refused, never sent to the engine. */
export interface ShaderBakeFailure { nodeId: string; error: string; animated?: true }

export interface ShaderBakeResult {
  /** The nodes given a bake. */
  baked: string[]
  /** The nodes whose render or upload failed (a still is left to the engine; an animated one refuses the run). */
  failed: ShaderBakeFailure[]
  /** R11.9c: Stop ended the bake (nothing more uploaded; the run is not sent). */
  stopped?: true
}

/** R11.9c: how a bake is run: where (the frame cap) and Stop. */
export interface ShaderBakeOptions { hosted?: boolean; signal?: AbortSignal }

/** R11.9c: Stop during a bake. */
export const SHADER_BAKE_STOPPED = 'Stopped'
class BakeStopped extends Error { constructor() { super(SHADER_BAKE_STOPPED) } }
/** R11.9c: a bake past the frame cap, in plain words (refused before any render). */
class BakeOverCap extends Error {}
const stopCheck = (signal: AbortSignal | undefined) => { if (signal?.aborted) throw new BakeStopped() }

/** The bakes running now, so Stop reaches them (`stopShaderBakes`). */
const running = new Set<AbortController>()

/** R11.9c: Stop: every bake running now ends, and uploads nothing more. */
export function stopShaderBakes(): void {
  for (const c of running) c.abort()
}

/** A rendered frame, kept as a Blob (the browser may page it out) under its content-hash name until the upload. */
interface BakedFrame { blob: Blob; name: string }

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
 * `sailor_baked` into its inputs. Never throws: a node that fails is listed;
 * Stop ends the whole bake (`stopped`).
 */
export async function bakeShaderEffects(prompt: ApiPrompt, ctx: ShaderBakeContext, o: ShaderBakeOptions = {}): Promise<ShaderBakeResult> {
  const result: ShaderBakeResult = { baked: [], failed: [] }
  const signal = o.signal
  const cap = shaderFrameCap(!!o.hosted)
  for (const [nodeId, node] of Object.entries(prompt)) {
    if (node.class_type !== 'ShaderEffect') continue
    const inputs = node.inputs ?? {}
    delete inputs.sailor_baked
    const def = bakeableEffect(ctx.catalog, inputs.effect)
    if (!def) continue
    const { time, duration, fps, seed, resolution, aspect, params } = inputs
    if (!num(time) || !num(duration) || !num(fps) || !num(seed) || !num(resolution) || typeof aspect !== 'string') continue
    const sources = shaderSourcesOf(prompt, nodeId)
    const src = shaderSourceOfNode(prompt, nodeId)
    if (!sources || !src) continue
    if (src.kind === 'none' && !SHADER_GENERATIVE_IDS.includes(def.id)) continue
    if (!paramsPortable(def, params)) continue
    const plan = framePlan(1, time, duration, fps)
    const step = Math.max(1, Math.trunc(fps))
    let animated = plan.length > 1 || src.kind === 'clip'
    try {
      stopCheck(signal)
      const textures: Record<string, TexImageSource> = {}
      let texturesLoaded = false
      const frames: BakedFrame[] = []
      const render = async (base: TexImageSource, w: number, h: number, t: number, hasInput: boolean) => {
        stopCheck(signal)
        if (frames.length >= cap) throw new BakeOverCap(shaderTooManyFramesWords(cap, plan.length <= cap))
        if (!texturesLoaded) {
          for (const tx of def.textures) textures[tx.uniform] = await ctx.texture(def, tx)
          texturesLoaded = true
        }
        const uniforms = bakeUniforms(def, typeof params === 'string' ? params : '', { time: t, seed, hasInput })
        const canvas = ctx.renderer.render(expandPasses(def.id, def.source, uniforms, textures, def.passes ?? 1), base, w, h)
        const rgba = ctx.readPixels(canvas, w, h)
        // Python keeps o[..., :3]: the alpha the shader wrote is dropped.
        for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255
        const png = await ctx.encodePng(rgba, w, h)
        frames.push({ blob: new Blob([png as BlobPart], { type: 'image/png' }), name: `shader_bake_${(await sha256Hex(png)).slice(0, 32)}.png` })
      }
      const picture = src.kind === 'picture' ? await ctx.sourceFile(src.file) : null
      if (src.kind === 'clip' || picture?.animated) {
        // R11.9c: a batch source (a clip, an animated picture): frame_plan's batch, frame i at time + i / fps.
        animated = true
        const from: BakeFramesSource = src.kind === 'clip' ? src : { kind: 'picture', file: (src as { file: string }).file }
        const many = await ctx.sourceFrames(from, signal ?? new AbortController().signal)
        try {
          if (many.count > cap) throw new BakeOverCap(shaderTooManyFramesWords(cap, true))
          const it = many.frames[Symbol.asyncIterator]()
          const first = await it.next()
          stopCheck(signal)
          if (first.done) throw new Error('The shader’s clip has no frames to render')
          await render(first.value, many.width, many.height, time, true)
          const second = await it.next()
          if (second.done) {
            // One frame: Python's frame_plan of a batch of one (the time setting's frames, all from it).
            if (plan.length > cap) throw new BakeOverCap(shaderTooManyFramesWords(cap, false))
            for (const [, t] of plan.slice(1)) await render(first.value, many.width, many.height, t, true)
          }
          else {
            await render(second.value, many.width, many.height, time + 1 / step, true)
            for (let i = 2, n = await it.next(); !n.done; i++, n = await it.next()) await render(n.value, many.width, many.height, time + i / step, true)
          }
        }
        finally { many.close() }
      }
      else {
        if (plan.length > cap) throw new BakeOverCap(shaderTooManyFramesWords(cap, false))
        const size = picture ? { w: picture.width, h: picture.height } : aspectSize(Math.trunc(resolution), aspect)
        const base = picture?.image ?? ctx.blank(size.w, size.h)
        for (const [, t] of plan) await render(base, size.w, size.h, t, !!picture)
      }
      // Every frame rendered: only now is anything uploaded (Stop before here uploads nothing).
      const files: string[] = []
      for (const f of frames) {
        stopCheck(signal)
        files.push(await ctx.upload(new Uint8Array(await f.blob.arrayBuffer()), f.name, signal))
      }
      stopCheck(signal)
      inputs.sailor_baked = shaderBakedText(files, await shaderBakeKey(inputs, sources, ctx.catalog.version, files))
      result.baked.push(nodeId)
    }
    catch (e) {
      delete inputs.sailor_baked
      if (e instanceof BakeStopped || signal?.aborted) {
        result.stopped = true
        return result
      }
      result.failed.push({ nodeId, error: e instanceof Error ? e.message : String(e), ...(animated ? { animated: true as const } : {}) })
    }
  }
  return result
}

/**
 * Whether a take goes to the runner once its Shader effects are baked: it has
 * a Shader effect, and every other node passes `runnerTakesNode` (R11.9c: a
 * node the runner refuses in plain words still goes to it, to be refused
 * there, never the engine). R11.9c: a reader of an animated Shader effect's
 * frames (Create video) takes them only once they are baked, so the take is
 * also judged as the bake will leave it: each Shader effect handing on
 * several frames where its time setting or its clip makes them, and, failing
 * that, where its picture may be animated (known only once it is read). A
 * take bound for the engine anyway is not baked (nothing rendered, nothing uploaded).
 */
export function takeWantsShaderBake(prompt: ApiPrompt | null | undefined, families: ReadonlySet<RunnerFamily>): prompt is ApiPrompt {
  if (!prompt || !familyOn('shader-bake', families)) return false
  const ids = Object.keys(prompt)
  const shaders = ids.filter(id => prompt[id]!.class_type === 'ShaderEffect')
  if (!shaders.length) return false
  const others = ids.filter(id => prompt[id]!.class_type !== 'ShaderEffect')
  const allTaken = (p: ApiPrompt) => others.every(id => runnerTakesNode(p, id, families, { plainRefusals: true }))
  if (allTaken(prompt)) return true
  const asBaked = (animatedPictures: boolean): ApiPrompt => {
    const p: ApiPrompt = { ...prompt }
    for (const id of shaders) {
      const inputs = prompt[id]!.inputs ?? {}
      const src = shaderSourceOfNode(prompt, id)
      const plan = framePlan(1, num(inputs.time) ? inputs.time : 0, num(inputs.duration) ? inputs.duration : 0, num(inputs.fps) ? inputs.fps : 1).length
      const several = src?.kind === 'clip' || plan > 1 || (animatedPictures && src?.kind === 'picture')
      const files = Array.from({ length: several ? 2 : 1 }, (_, i) => `shader_bake_${String(i).padStart(32, '0')}.png`)
      p[id] = { ...prompt[id]!, inputs: { ...inputs, sailor_baked: shaderBakedText(files, '0'.repeat(64)) } }
    }
    return p
  }
  return allTaken(asBaked(false)) || allTaken(asBaked(true))
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
  o: { hosted?: boolean } = {},
): Promise<ShaderBakeResult> {
  const result: ShaderBakeResult = { baked: [], failed: [] }
  const wanted = prompts.filter((p): p is ApiPrompt => takeWantsShaderBake(p, families))
  if (!wanted.length) return result
  // R11.9c: Stop reaches this run's bake (stopShaderBakes).
  const stop = new AbortController()
  running.add(stop)
  try {
    let ctx: ShaderBakeRunContext
    try { ctx = await makeContext() }
    catch (e) {
      for (const p of wanted) {
        for (const [nodeId, n] of Object.entries(p)) {
          if (n.class_type !== 'ShaderEffect') continue
          const many = (shaderSourceOfNode(p, nodeId)?.kind === 'clip') || framePlan(1, Number(n.inputs?.time) || 0, Number(n.inputs?.duration) || 0, Number(n.inputs?.fps) || 1).length > 1
          result.failed.push({ nodeId, error: e instanceof Error ? e.message : String(e), ...(many ? { animated: true as const } : {}) })
        }
      }
      return result
    }
    try {
      for (const p of wanted) {
        const r = await bakeShaderEffects(p, ctx, { hosted: o.hosted, signal: stop.signal })
        result.baked.push(...r.baked)
        result.failed.push(...r.failed)
        if (r.stopped) {
          result.stopped = true
          break
        }
      }
    }
    finally {
      ctx.release()
    }
    return result
  }
  finally {
    running.delete(stop)
  }
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
export async function bakeShaderEffectsForRun(prompts: readonly (ApiPrompt | null | undefined)[], families: ReadonlySet<RunnerFamily>, o: { hosted?: boolean } = {}): Promise<ShaderBakeResult> {
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
      async upload(bytes, name, signal) {
        const fd = new FormData()
        fd.append('image', new File([bytes as BlobPart], name, { type: 'image/png' }))
        fd.append('overwrite', 'true')
        const res = await fetch('/upload/image', { method: 'POST', body: fd, ...(signal ? { signal } : {}) })
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
      sourceFrames(src, signal) {
        return src.kind === 'picture' ? pictureFrames(src.file, signal) : clipFrames(src.clip, signal)
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
  }, o)
}

// ── R11.9c: frames from an animated picture or a clip, in the page ──────────────

/** A picture file's type, for ImageDecoder, from its first bytes. */
function pictureType(b: Uint8Array): string | null {
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png'
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp'
  return null
}

/** An animated picture's frames, as Python's LoadImage makes its batch (each frame whole, the first frame's size), read with WebCodecs' ImageDecoder. */
async function pictureFrames(file: string, signal: AbortSignal): Promise<BakeFrames> {
  type Decoded = { image: VideoFrame }
  type Decoder = { tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } | null }; completed: Promise<void>; decode(o: { frameIndex: number }): Promise<Decoded>; close(): void }
  const Ctor = (globalThis as { ImageDecoder?: new (init: { data: ArrayBuffer; type: string }) => Decoder }).ImageDecoder
  if (!Ctor) throw new Error('This browser can’t read the frames of an animated picture for a shader. Use Chrome or Edge.')
  const res = await fetch(viewUrlOf(file), { signal })
  if (!res.ok) throw new Error('A picture for the shader couldn’t be loaded')
  const data = await res.arrayBuffer()
  const type = pictureType(new Uint8Array(data))
  if (!type) throw new Error('A picture for the shader couldn’t be read')
  const decoder = new Ctor({ data, type })
  await decoder.tracks.ready
  await decoder.completed
  const count = decoder.tracks.selectedTrack?.frameCount ?? 0
  if (!count) { decoder.close(); throw new Error('A picture for the shader couldn’t be read') }
  const firstFrame = (await decoder.decode({ frameIndex: 0 })).image
  const width = firstFrame.displayWidth
  const height = firstFrame.displayHeight
  let held: VideoFrame | null = firstFrame
  async function* frames(): AsyncIterable<TexImageSource> {
    for (let i = 0; i < count; i++) {
      if (signal.aborted) return
      const next: VideoFrame = i === 0 ? firstFrame : (await decoder.decode({ frameIndex: i })).image
      if (held && held !== next) held.close()
      held = next
      yield next
    }
  }
  return { count, width, height, frames: frames(), close() { held?.close(); held = null; decoder.close() } }
}

/** Python's round(): halves to the even neighbour. */
function pyRound(x: number): number {
  const r = Math.round(x)
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r
}

/** A number setting as sent (a number, or text of one). */
function settingOf(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : fallback
}

/**
 * Load video frames' pick (server/runner/media/frameNodes.ts loadFramesPick,
 * execute :566-577): the size each frame is kept at, the first frame and the
 * stride, and at most how many.
 */
export function loadFramesPickOf(v: { w: number; h: number; fps: number | null }, settings: Record<string, unknown>): { tw: number; th: number; start: number; stride: number; count: number } {
  const maxSeconds = settingOf(settings.max_seconds, 10)
  const scale = Math.min(1, Math.trunc(settingOf(settings.max_size, 720)) / Math.max(v.w, v.h))
  const fps = v.fps && v.fps > 0 ? v.fps : 30
  const stride = Math.max(1, Math.trunc(settingOf(settings.stride, 1)))
  const timeCap = maxSeconds > 0 ? Math.trunc(maxSeconds * fps / stride) : 1e9
  const count = Math.max(1, Math.min(timeCap, Math.max(1, Math.trunc(settingOf(settings.max_frames, 600)))))
  return { tw: Math.max(1, pyRound(v.w * scale)), th: Math.max(1, pyRound(v.h * scale)), start: Math.max(0, Math.trunc(settingOf(settings.start_frame, 0))), stride, count }
}

/**
 * A clip's frames, decoded with Mediabunny as its loader picks them: Get video
 * components every frame at its coded size; Load video frames from
 * `start_frame`, every `stride`-th, at most its count, resized to its size.
 * Frames are drawn unturned (PyAV's rgb24 frames ignore rotation metadata).
 */
async function clipFrames(clip: ShaderClipSource, signal: AbortSignal): Promise<BakeFrames> {
  const { Input, UrlSource, ALL_FORMATS, VideoSampleSink } = await import('mediabunny')
  const input = new Input({ source: new UrlSource(viewUrlOf(clip.file)), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('The shader’s clip has no video in it')
    const w = track.codedWidth
    const h = track.codedHeight
    const stats = await track.computePacketStats()
    const pick = clip.loader === 'LoadVideoFrames'
      ? loadFramesPickOf({ w, h, fps: stats.averagePacketRate }, clip.settings)
      : { tw: w, th: h, start: 0, stride: 1, count: stats.packetCount }
    const count = Math.min(pick.count, Math.max(0, Math.ceil((stats.packetCount - pick.start) / pick.stride)))
    const canvas = document.createElement('canvas')
    canvas.width = pick.tw
    canvas.height = pick.th
    const g = canvas.getContext('2d')!
    g.imageSmoothingQuality = 'medium'
    const sink = new VideoSampleSink(track)
    async function* frames(): AsyncIterable<TexImageSource> {
      let index = -1
      let kept = 0
      for await (const sample of sink.samples()) {
        try {
          if (signal.aborted) return
          index++
          if (index < pick.start || (index - pick.start) % pick.stride !== 0) continue
          const frame = sample.toVideoFrame()
          try { g.drawImage(frame, 0, 0, pick.tw, pick.th) }
          finally { frame.close() }
          kept++
          yield canvas
          if (kept >= pick.count) return
        }
        finally { sample.close() }
      }
    }
    return { count, width: pick.tw, height: pick.th, frames: frames(), close() { input.dispose() } }
  }
  catch (e) {
    input.dispose()
    throw e
  }
}
