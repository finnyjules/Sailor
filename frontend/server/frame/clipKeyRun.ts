/**
 * Frame Animate's still preparation and clip keying, around the pure keyer in
 * ./clipKey.ts (step 3, LC10: what scripts/clip_key.py's `flatten` and `key`
 * did, with no Python).
 *
 *   - `readStill`: the layer's PNG as RGBA (sharp), its size checked first.
 *   - `flattenStill`: the key colour, and the still flattened onto it, as PNG.
 *   - `keyClip`: the model's clip decoded with Sailor's own ffmpeg
 *     (server/media/decode.ts `decodeFrames`, one frame in memory at a time),
 *     every frame keyed and written as 000000.png … (sharp), then clip.json
 *     and a copy of the source clip (source.mp4), into `outDir`. The last
 *     frame is dropped when `trimLast` (first = last on the loop models), so
 *     one frame is held back until the next arrives. Stop (`signal`) kills the
 *     decode (runMedia) and fails; the caller removes `outDir`.
 */
import { copyFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { decodeFrames } from '../media/decode'
import { MediaError } from '../media/run'
import { probeMedia } from '../media/probe'
import { ClipKeyer, flattenOnto, fromHex, hexOf, pickKeyColour, type RGB } from './clipKey'

export interface Still { rgba: Uint8Array; w: number; h: number }

/** The still's size from its header alone (no decode), or null when sharp can't read it. */
export async function stillSize(png: Uint8Array): Promise<{ w: number; h: number } | null> {
  try {
    const m = await sharp(png).metadata()
    return m.width && m.height ? { w: m.width, h: m.height } : null
  }
  catch { return null }
}

/** The still as straight RGBA bytes (PIL's .convert("RGBA")). */
export async function readStill(png: Uint8Array): Promise<Still> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  if (info.channels !== 4) throw new Error('Could not read the still')
  return { rgba: new Uint8Array(data.buffer, data.byteOffset, data.length), w: info.width, h: info.height }
}

/** The key colour for this still and the still flattened onto it (PNG bytes). */
export async function flattenStill(still: Still): Promise<{ keyHex: string; flat: Buffer }> {
  const keyHex = pickKeyColour(still.rgba)
  const rgb = flattenOnto(still.rgba, fromHex(keyHex))
  const flat = await sharp(rgb, { raw: { width: still.w, height: still.h, channels: 3 } }).png().toBuffer()
  return { keyHex, flat }
}

export interface KeyClipOptions {
  /** The model's clip: an absolute path inside one of `roots`. */
  video: string
  roots: readonly string[]
  still: Still
  key: RGB | string
  /** An existing, empty folder the frames go into. */
  outDir: string
  trimLast: boolean
  userId: string | null
  signal?: AbortSignal
  /** At most this many decoded frames (MEDIA_WORDS.tooManyFrames past it). */
  maxFrames: number
  /** At most this many bytes written (PNGs, clip.json, source.mp4), else it fails. */
  maxBytes?: number
}

export interface ClipMeta { frames: number; fps: number; width: number; height: number }

const frameName = (i: number) => `${String(i).padStart(6, '0')}.png`

/** Fails (MEDIA_WORDS.tooBig) once more than `max` bytes have been written. */
class ByteBudget {
  used = 0
  constructor(private readonly max: number) {}
  add(n: number): void {
    this.used += n
    if (this.used > this.max) throw new MediaError('tooBig')
  }
}

export async function keyClip(o: KeyClipOptions): Promise<ClipMeta> {
  const key = typeof o.key === 'string' ? fromHex(o.key) : o.key
  const budget = new ByteBudget(o.maxBytes ?? Number.POSITIVE_INFINITY)
  const probe = await probeMedia(o.video, { userId: o.userId, signal: o.signal, roots: o.roots, kind: 'video' })
  const v = probe.video[0]
  if (!v) throw new MediaError('noVideo')
  // imageio's meta "fps": the stream's average rate, 24 when it doesn't say.
  const fps = v.averageRate && v.averageRate.den ? v.averageRate.num / v.averageRate.den : 24.0

  let keyer: ClipKeyer | null = null
  let held: Uint8Array | null = null
  let written = 0
  const writeFrame = async (rgb: Uint8Array) => {
    if (o.signal?.aborted) throw new MediaError('stopped')
    keyer ??= new ClipKeyer(o.still.rgba, o.still.w, o.still.h, key, v.w, v.h)
    const rgba = keyer.keyFrame(rgb)
    const png = await sharp(rgba, { raw: { width: keyer.ow, height: keyer.oh, channels: 4 } }).png().toBuffer()
    budget.add(png.length)
    if (o.signal?.aborted) throw new MediaError('stopped')
    await writeFile(path.join(o.outDir, frameName(written)), png, { flag: 'wx' })
    written++
  }

  const { count } = await decodeFrames(probe.path, {
    userId: o.userId, signal: o.signal, roots: o.roots, probe, maxFrames: o.maxFrames,
    onFrame: async (rgb) => {
      if (held) await writeFrame(held)
      held = rgb
    },
  })
  if (!count || !held) throw new MediaError('noVideo')
  // first == last on a first/last-frame model: don't hold it twice.
  if (!(o.trimLast && count > 1)) await writeFrame(held)
  held = null

  const k = keyer as ClipKeyer | null
  if (!k) throw new MediaError('noVideo')
  const meta: ClipMeta = { frames: written, fps, width: k.ow, height: k.oh }
  budget.add(probe.bytes)
  // So tuning the keyer never costs another model call.
  await copyFile(probe.path, path.join(o.outDir, 'source.mp4'))
  const json = JSON.stringify({ ...meta, key: hexOf(key) })
  budget.add(json.length)
  await writeFile(path.join(o.outDir, 'clip.json'), json, { flag: 'wx' })
  return meta
}
