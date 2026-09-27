/**
 * The Shader effect, replayed from the browser's bake (step 3, R2.10;
 * decision 9). comfy_extras/nodes_shader_effects.py renders the node's GLSL
 * with moderngl; the server here renders no GL. The browser renders the node
 * at submit, as it renders the node's own preview (app/lib/runner/shaderBake.ts),
 * uploads each frame and names them in `inputs.sailor_baked`; eligibility
 * takes the node only when the bake's key agrees with the prompt as sent
 * (#shared/runner/shaderBakeKey.ts). Here each baked file is read, refused
 * unless it is an 8-bit RGB or RGBA PNG of the size Python renders (the
 * picture's own size, EXIF turned as its loader turns it; with no picture,
 * `_aspect_size`), whose sha256 starts with the hex its name carries (the
 * name the key covers), and kept as an 8-bit RGB PNG (Python keeps `o[..., :3]`).
 * The first frame is the node's live preview under a new name every run
 * (`save_live_preview(unique=True)`). The picture is read downstream as the
 * tensor it is (compositor/plan.ts pictureSourceOf: 'tensor'): bytes / 255,
 * three channels.
 */
import sharp from 'sharp'
import type { DeriveIO, NodePlan, PlanContext } from '../executors'
import type { OutputFile, RunnerValue } from '../types'
import { parseInputFileRef } from '../inputs'
import { isLink } from '#shared/runner/graph'
import { pyIntOf } from '#shared/runner/pyText'
import { aspectSize, bakedFileHash, parseShaderBaked } from '#shared/runner/shaderBakeKey'
import { sha256Hex } from '../handoff'
import { EFFECT_PICTURE_ANIMATED, effectPictureCap } from '#shared/runner/effects'
import { pictureHasFrames, pictureMeta, pictureRefusalOf, pngChunksBeforePixels } from '../pictures/pythonView'
import { PICTURE_NOT_MADE, PICTURE_UNREAD } from '../effects/io'

export const SHADER_BAKE_MISSING = 'The shader’s baked picture is missing. Run it again.'
export const SHADER_BAKE_WRONG_SIZE = 'The shader’s baked picture is the wrong size. Run it again.'
export const SHADER_BAKE_UNREADABLE = 'The shader’s baked picture can’t be read. Run it again.'
/** The bytes read aren't the ones the bake named (its name is their hash). */
export const SHADER_BAKE_CHANGED = 'The shader’s baked picture has changed since it was made. Run it again.'
/** `render_effect` refuses a side over MAX_RENDER_DIM (8192). */
export const SHADER_PICTURE_TOO_WIDE = 'This picture is too large for a shader (more than 8192 pixels on a side). Use a smaller picture.'
const MAX_RENDER_DIM = 8192

const stopped = (io: DeriveIO) => { if (io.signal.aborted) throw new Error('Stopped') }

/** Python's int() of a valid INT widget. */
function intOf(v: unknown): number {
  if (typeof v === 'number') return Math.trunc(v)
  if (typeof v === 'boolean') return Number(v)
  const n = typeof v === 'string' ? pyIntOf(v) : null
  if (n === null) throw new Error('The shader’s settings can’t be read')
  return n
}

/** An 8-bit RGB or RGBA PNG's size from its IHDR, or null for anything else. */
export function bakedPngSize(b: Uint8Array): { w: number; h: number } | null {
  if (pngChunksBeforePixels(b)?.[0] !== 'IHDR' || b.length < 33) return null
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const w = view.getUint32(16)
  const h = view.getUint32(20)
  const depth = b[24]
  const colourType = b[25]
  if (depth !== 8 || (colourType !== 2 && colourType !== 6) || !w || !h) return null
  return { w, h }
}

/** The size Python renders at: the picture's own (EXIF turned as its loader turns it), or `_aspect_size`. */
async function renderSize(ctx: PlanContext, io: DeriveIO, inputs: Record<string, unknown>): Promise<{ w: number; h: number }> {
  if (!isLink(inputs.image)) return aspectSize(intOf(inputs.resolution), String(inputs.aspect))
  const files = ctx.filesFrom(inputs.image)
  if (!files.length) throw new Error(PICTURE_NOT_MADE)
  let bytes: Uint8Array
  try { bytes = await io.read(files[0]!) }
  catch { throw new Error(PICTURE_UNREAD) }
  const meta = await pictureMeta(bytes)
  const why = pictureRefusalOf(meta, bytes)
  if (why) throw new Error(why)
  // Python's loader makes a batch of every frame, and the node a frame of each (the start of the take refuses it first).
  if (files.length > 1 || pictureHasFrames(meta, bytes)) throw new Error(EFFECT_PICTURE_ANIMATED)
  if (!meta.width || !meta.height) throw new Error(PICTURE_UNREAD)
  return (meta.orientation ?? 1) >= 5 ? { w: meta.height, h: meta.width } : { w: meta.width, h: meta.height }
}

/** The PNG of 8-bit RGB pixels. */
async function rgbPng(px: Uint8Array, w: number, h: number, compressionLevel: number): Promise<Uint8Array> {
  return new Uint8Array(await sharp(px, { raw: { width: w, height: h, channels: 3 } }).png({ compressionLevel }).toBuffer())
}

export function planShaderEffect(ctx: PlanContext): NodePlan {
  const inputs = ctx.prompt[ctx.nodeId]!.inputs ?? {}
  // Eligibility took the node for its bake; a prompt without one never gets here.
  const baked = parseShaderBaked(inputs.sailor_baked)
  const names = baked?.files ?? []
  const files = names.map(parseInputFileRef)
  const hashes = names.map(bakedFileHash)
  if (!files.length || files.some(f => !f) || hashes.some(h => !h)) throw new Error(SHADER_BAKE_MISSING)
  return {
    kind: 'derive',
    async derive(io) {
      const size = await renderSize(ctx, io, inputs)
      if (size.w > MAX_RENDER_DIM || size.h > MAX_RENDER_DIM) throw new Error(SHADER_PICTURE_TOO_WIDE)
      const cap = effectPictureCap('ShaderEffect', io.hosted)
      if (size.w * size.h > cap.max) throw new Error(cap.message)
      const kept: OutputFile[] = []
      let preview: OutputFile | null = null
      for (const [i, file] of (files as OutputFile[]).entries()) {
        stopped(io)
        let bytes: Uint8Array
        try { bytes = await io.read(file) }
        catch { throw new Error(SHADER_BAKE_MISSING) }
        // The name the key covers is the bytes' hash: other bytes under it are not the bake.
        if (sha256Hex(bytes).slice(0, 32) !== hashes[i]) throw new Error(SHADER_BAKE_CHANGED)
        // From the header, before any pixel is decoded.
        const got = bakedPngSize(bytes)
        if (!got) throw new Error(SHADER_BAKE_UNREADABLE)
        if (got.w !== size.w || got.h !== size.h) throw new Error(SHADER_BAKE_WRONG_SIZE)
        let rgb: Uint8Array
        try {
          const { data, info } = await sharp(bytes, { ignoreIcc: true, limitInputPixels: false })
            .removeAlpha().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true })
          if (info.channels !== 3 || info.width !== size.w || info.height !== size.h) throw new Error(SHADER_BAKE_UNREADABLE)
          rgb = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        }
        catch { throw new Error(SHADER_BAKE_UNREADABLE) }
        stopped(io)
        const png = await rgbPng(rgb, size.w, size.h, 6)
        stopped(io)
        kept.push(await io.keep(png, 'png'))
        // save_live_preview(unique=True): the first frame, compress level 1, a new name each run.
        if (!preview) preview = await io.savePreview(await rgbPng(rgb, size.w, size.h, 1), { nodeId: ctx.nodeId })
      }
      const value: RunnerValue = { kind: 'files', files: kept }
      return { values: { 0: value }, ui: { images: [preview!], animated: [false] } }
    },
  }
}
