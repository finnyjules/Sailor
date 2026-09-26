/**
 * The pictures a card or an effect reads (step 3, R1.4; moved here for R2.1,
 * re-exported from cards/utilities.ts): what a picture wire brings, each
 * file's size from its header, and each file decoded as its source.
 *
 * A picture wired in is read as the tensor Python holds: decodeRaw with the
 * wire's source (compositor/plan.ts pictureSourceOf), which decides its
 * channels and whether it is EXIF turned.
 */
import type { DeriveIO, PlanContext } from '../executors'
import type { OutputFile } from '../types'
import { isLink, type ApiLink } from '#shared/runner/graph'
import { CARD_MAX_PIXELS } from '#shared/runner/eligibility'
import { pictureSourceOf } from '../compositor/plan'
import { decodeRaw, type PictureSource } from '../compositor/decode'
import type { RawPicture } from '../compositor/plane'
import { pictureMeta, pictureRefusalOf } from '../pictures/pythonView'

export const PICTURE_NOT_MADE = 'The picture this card reads was not made'
export const PICTURE_UNREAD = 'The picture this card reads could not be read'
export const PICTURES_TOO_LARGE = 'The pictures this card reads are too large to work on together (more than 268 million pixels). Use fewer or smaller pictures.'

/** A file's identity within a run. */
export const keyOf = (f: OutputFile) => `${f.type}:${f.subfolder}:${f.filename}`

/** What a picture wire brings: its source kind, and its files (none for Python's 1×1 blank). */
export interface Wired { source: PictureSource; files: OutputFile[] }

/** The picture wired into the node's input `name`. */
export function wired(ctx: PlanContext, name: string): Wired {
  const v = ctx.prompt[ctx.nodeId]!.inputs?.[name]
  if (!isLink(v)) throw new Error('There is no picture wired in')
  const link: ApiLink = v
  const source = pictureSourceOf(ctx.prompt, link)
  if (source === 'blank') return { source, files: [] }
  const files = ctx.filesFrom(link)
  if (!files.length) throw new Error(PICTURE_NOT_MADE)
  return { source, files }
}

const stopped = (io: DeriveIO) => { if (io.signal.aborted) throw new Error('Stopped') }

/**
 * Each distinct file's size as the tensor holds it (EXIF turned for an Image
 * card and LoadImage), from its header only. A file the runner can't read
 * exactly is refused in the words the start of a run uses; with `cap`, more
 * than CARD_MAX_PIXELS in all is refused before any pixel is decoded.
 */
export async function sizes(io: DeriveIO, w: Wired, cap: boolean): Promise<Map<string, { w: number; h: number }>> {
  const out = new Map<string, { w: number; h: number }>()
  let total = 0
  for (const file of w.files) {
    const key = keyOf(file)
    if (out.has(key)) continue
    stopped(io)
    const bytes = await io.read(file)
    const meta = await pictureMeta(bytes)
    const why = pictureRefusalOf(meta, bytes)
    if (why) throw new Error(why)
    if (!meta.width || !meta.height) throw new Error(PICTURE_UNREAD)
    const turned = (w.source === 'card' || w.source === 'load') && (meta.orientation ?? 1) >= 5
    const size = turned ? { w: meta.height, h: meta.width } : { w: meta.width, h: meta.height }
    total += size.w * size.h
    if (cap && total > CARD_MAX_PIXELS) throw new Error(PICTURES_TOO_LARGE)
    out.set(key, size)
  }
  return out
}

/** One file as sharp decodes it for its source (RGBA8), or Python's blank. */
export async function decoded(io: DeriveIO, source: PictureSource, file: OutputFile | null): Promise<RawPicture> {
  if (!file) return decodeRaw(null, 'blank')
  try { return await decodeRaw(await io.read(file), source) }
  catch (e) {
    if (e instanceof Error && /larger than 8192/.test(e.message)) throw new Error('This picture is larger than 8192 × 8192, too large to read here')
    throw new Error(PICTURE_UNREAD)
  }
}
