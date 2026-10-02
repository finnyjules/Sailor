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
 *
 * R11.9c (USER ruling (d)): an animated Shader effect (its time setting
 * making several frames, an animated picture, a clip's frames) is baked a
 * PNG a frame; here they are counted against what the node makes from its
 * source (`frame_plan`: the source's frames, else the time setting's), each
 * checked as above, and kept as one frame batch (`frames`, FFV1) within the
 * batch caps and the run's kept room. Shaders are free: nothing is held or charged.
 */
import sharp from 'sharp'
import type { DeriveIO, NodePlan, PlanContext } from '../executors'
import type { OutputFile, RunnerValue } from '../types'
import { parseInputFileRef } from '../inputs'
import { isLink } from '#shared/runner/graph'
import { pyIntOf } from '#shared/runner/pyText'
import { aspectSize, bakedFileHash, parseShaderBaked, shaderBakeProblem, shaderFrameCount, shaderMakesBatch } from '#shared/runner/shaderBakeKey'
import { keepFrames } from '../../media/values'
import { FRAMES_NEED_RUN } from '../media/frameNodes'
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

/** R11.9c: Python's LoadImage frame count of an animated picture: an APNG's acTL (plus its default image when that isn't a frame, as PIL counts it), else sharp's pages. */
export function pictureFrameCount(meta: { pages?: number }, b: Uint8Array): number {
  const chunks = pngChunksBeforePixels(b)
  if (chunks?.includes('acTL')) {
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
    for (let o = 8; o + 12 <= b.length;) {
      const len = view.getUint32(o)
      const type = String.fromCharCode(b[o + 4]!, b[o + 5]!, b[o + 6]!, b[o + 7]!)
      if (type === 'acTL' && len >= 8) {
        const n = view.getUint32(o + 8)
        // PIL: an IDAT with no fcTL before it is a default image, not a frame, and is counted as one more.
        return n + (chunks.includes('fcTL') ? 0 : 1)
      }
      if (type === 'IDAT') break
      o += 12 + len
    }
  }
  return Math.max(1, meta.pages ?? 1)
}

/** What the node renders over, as the run has it: its size, and its frames (1 for a still or no picture). */
async function sourceOf(ctx: PlanContext, io: DeriveIO, inputs: Record<string, unknown>): Promise<{ w: number; h: number; frames: number; clip: boolean }> {
  if (!isLink(inputs.image)) return { ...aspectSize(intOf(inputs.resolution), String(inputs.aspect)), frames: 1, clip: false }
  // R11.9c: a clip's frames (Load video frames, Get video components): the batch as the run made it.
  const value = ctx.valueFrom?.(inputs.image)
  if (value?.kind === 'frames') return { w: value.w, h: value.h, frames: value.count, clip: true }
  const files = ctx.filesFrom(inputs.image)
  if (!files.length) throw new Error(PICTURE_NOT_MADE)
  // Python's loader makes a batch of every file's frames; the runner hands one file on (an Image card, LoadImage).
  if (files.length > 1) throw new Error(EFFECT_PICTURE_ANIMATED)
  let bytes: Uint8Array
  try { bytes = await io.read(files[0]!) }
  catch { throw new Error(PICTURE_UNREAD) }
  const meta = await pictureMeta(bytes)
  const why = pictureRefusalOf(meta, bytes)
  if (why) throw new Error(why)
  if (!meta.width || !meta.height) throw new Error(PICTURE_UNREAD)
  // R11.9c: an animated picture is a batch of its frames (LoadImage), each its first frame's size.
  const frames = pictureHasFrames(meta, bytes) ? pictureFrameCount(meta, bytes) : 1
  const size = (meta.orientation ?? 1) >= 5 ? { w: meta.height, h: meta.width } : { w: meta.width, h: meta.height }
  return { ...size, frames, clip: false }
}

/** The PNG of 8-bit RGB pixels. */
async function rgbPng(px: Uint8Array, w: number, h: number, compressionLevel: number): Promise<Uint8Array> {
  return new Uint8Array(await sharp(px, { raw: { width: w, height: h, channels: 3 } }).png({ compressionLevel }).toBuffer())
}

/** R11.9c: the baked frames don't match what the node makes from its source (their count). */
export const SHADER_BAKE_FRAMES = 'The shader’s frames don’t match its picture or clip here. Try a different clip, or trim it.'

export function planShaderEffect(ctx: PlanContext): NodePlan {
  const inputs = ctx.prompt[ctx.nodeId]!.inputs ?? {}
  // Eligibility took the node for its bake; a prompt without one never gets here.
  const baked = parseShaderBaked(inputs.sailor_baked)
  const names = baked?.files ?? []
  const files = names.map(parseInputFileRef)
  const hashes = names.map(bakedFileHash)
  if (!files.length || files.some(f => !f) || hashes.some(h => !h)) throw new Error(SHADER_BAKE_MISSING)
  const batch = shaderMakesBatch(ctx.prompt, ctx.nodeId)
  return {
    kind: 'derive',
    async derive(io) {
      const src = await sourceOf(ctx, io, inputs)
      const size = { w: src.w, h: src.h }
      if (size.w > MAX_RENDER_DIM || size.h > MAX_RENDER_DIM) throw new Error(SHADER_PICTURE_TOO_WIDE)
      const cap = effectPictureCap('ShaderEffect', io.hosted)
      if (size.w * size.h > cap.max) throw new Error(cap.message)
      // frame_plan: a batch's own frames when it has more than one, else the time setting's (fix round 1, I1:
      // a clip of one frame with a duration too), the count the browser bakes (#shared shaderFrameCount).
      const expected = shaderFrameCount(src.frames, inputs)
      // R11.9c: the caps the start checked before the hold, again here (a backstop; the shared check).
      const tooMuch = shaderBakeProblem(files.length, size.w, size.h, io.hosted, src.clip || src.frames > 1)
      if (tooMuch) throw new Error(tooMuch)
      if (expected !== files.length) throw new Error(SHADER_BAKE_FRAMES)
      let preview: OutputFile | null = null
      /** Each baked file, checked against its name and the size, as 8-bit RGB. */
      const frameAt = async (i: number): Promise<Uint8Array> => {
        stopped(io)
        let bytes: Uint8Array
        try { bytes = await io.read(files[i]!) }
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
        // save_live_preview(unique=True): the first frame, compress level 1, a new name each run.
        if (!preview) preview = await io.savePreview(await rgbPng(rgb, size.w, size.h, 1), { nodeId: ctx.nodeId })
        return rgb
      }
      if (batch) {
        // R11.9c: an animated shader's frames, kept as one frame batch (FFV1, server/media/values.ts keepFrames),
        // within the batch caps and the run's kept room as they stream; Stop ends the stream and keeps nothing.
        const media = io.media
        if (!media) throw new Error(FRAMES_NEED_RUN)
        async function* stream(): AsyncIterable<Uint8Array> {
          for (let i = 0; i < files.length; i++) yield await frameAt(i)
        }
        const value = await keepFrames(media.runId, stream(), size.w, size.h, media)
        return { values: { 0: value }, ui: { images: [preview!], animated: [false] } }
      }
      const kept: OutputFile[] = []
      for (let i = 0; i < files.length; i++) {
        const rgb = await frameAt(i)
        const png = await rgbPng(rgb, size.w, size.h, 6)
        stopped(io)
        kept.push(await io.keep(png, 'png'))
      }
      const value: RunnerValue = { kind: 'files', files: kept }
      return { values: { 0: value }, ui: { images: [preview!], animated: [false] } }
    },
  }
}
