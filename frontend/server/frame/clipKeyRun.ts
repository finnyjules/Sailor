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
 *
 * LC10 fix round 1: the pixel work (flatten, keyer set-up, every frame) runs
 * on a worker thread (./clipKeyWorker.ts), and the decode runs in a media
 * lease (server/media/run.ts `mediaLease`), whose clock counts only the time
 * ffmpeg itself owes frames, never the time a frame waits to be keyed: the
 * keying can't run the decode into its job time limit.
 */
import { copyFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { decodeFrames } from '../media/decode'
import { MediaError, mediaLease } from '../media/run'
import { probeMedia } from '../media/probe'
import { fromHex, hexOf, type RGB } from './clipKey'
import { withKeyWorker } from './clipKeyWorker'

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
export async function flattenStill(still: Still, signal?: AbortSignal): Promise<{ keyHex: string; flat: Buffer }> {
  const { keyHex, rgb } = await withKeyWorker(signal, w => w.flatten(still.rgba))
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

  let size: { ow: number; oh: number } | null = null
  let held: Uint8Array | null = null
  let written = 0
  let count = 0
  await withKeyWorker(o.signal, async (kw) => {
    const writeFrame = async (rgb: Uint8Array) => {
      if (o.signal?.aborted) throw new MediaError('stopped')
      size ??= await kw.init(o.still.rgba, o.still.w, o.still.h, key, v.w, v.h)
      const rgba = await kw.key(rgb)
      const png = await sharp(rgba, { raw: { width: size.ow, height: size.oh, channels: 4 } }).png().toBuffer()
      budget.add(png.length)
      if (o.signal?.aborted) throw new MediaError('stopped')
      await writeFile(path.join(o.outDir, frameName(written)), png, { flag: 'wx' })
      written++
    }
    await mediaLease({ userId: o.userId, signal: o.signal }, async (lease) => {
      ;({ count } = await decodeFrames(probe.path, {
        userId: o.userId, signal: lease.signal, roots: o.roots, probe, maxFrames: o.maxFrames, lease,
        onFrame: async (rgb) => {
          if (held) await writeFrame(held)
          held = rgb
        },
      }))
    })
    if (!count || !held) throw new MediaError('noVideo')
    // first == last on a first/last-frame model: don't hold it twice.
    if (!(o.trimLast && count > 1)) await writeFrame(held)
    held = null
  })

  const k = size as { ow: number; oh: number } | null
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
