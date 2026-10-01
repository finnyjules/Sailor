/**
 * The size of the picture each size-priced node is sent (Upscale, Enhance
 * detail, FLUX.2 edit), for the hosted /prompt gate's price (P4 fix round 1)
 * and its refusals (Task G1, final re-review finding 1). The price reads it
 * through priceGraph's `inputPixels`.
 *
 * The picture link is followed to its source (pictureRule, up to MAX_HOPS):
 *  - a loaded file (LoadImage, or an Image card holding a file): its header
 *    is read — PNG, JPEG, WebP, GIF and TIFF through sharp's metadata (sniffed
 *    from the first bytes); AVIF and HEIC by walking their ISOBMFF boxes to
 *    the `ispe` (image spatial extents) boxes, no decode (this build's libheif
 *    has no HEVC decoder, so sharp can't open a real HEIC); BMP from its own
 *    header. Each file value once, at most MAX_MEASURED_FILES per prompt.
 *    The gate has already checked the caller owns every file the graph names
 *    (validateGraphFileRefs), before pricing. The runner reads the files it
 *    sends with the same picturePixels (metering.ts);
 *  - a node that hands on a picture sized from its input: an Image card
 *    wired to one, Upscale (× its engine's factor on each side), Enhance
 *    detail (in place), the Frame (its width × height, else its first layer),
 *    Resize / Scale by / Crop, Remove background, a Nano Banana action with
 *    nothing to change (the runner's actionPassThrough), Blend scene keeping
 *    protected layers;
 *  - a node that makes a new picture: its stated largest (madePictureBound,
 *    editSettings.ts: a generator's settings, a Nano Banana tier, FLUX.2's
 *    2048²);
 *  - anything else, a loop, or a chain past MAX_HOPS: unsized.
 *
 * A size-priced node is then priced on an exact size, or a largest at or
 * under the cap. It is refused before any hold when its picture is exactly
 * known above the cap (measuredInputProblems), can't be sized or only to a
 * largest above the cap, or is a file whose size can't be read. The one
 * exception: a file left unread because the read budget ran out is priced
 * at the cap (a parked ruling), unless something enlarges it on the way.
 * Hosted only: the gate never runs locally.
 */
import { open } from 'node:fs/promises'
import sharp from 'sharp'
import { annotatedFilepath, engineFolder, resolveInside } from '../native/paths'
import {
  ENHANCE_ENGINE_SLUGS, LARGEST_INPUT_PIXELS, madePictureBound, sizePricedInput, upscaleSideFactor, type NodeInputs,
} from '../../shared/pricing/editSettings'
import { actionPassThrough } from '../runner/generators/actions'
import { tooManyPicturesWords, unreadableInputWords, unsizedInputWords, type RequestProblem } from '../runner/requestRules'
import { LIPSYNC_MEDIA_READS } from '../../shared/pricing/clipSettings'

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

type Prompt = Record<string, { class_type?: unknown; inputs?: unknown } | undefined>

/**
 * At most this many picture files are read per /prompt; a size-priced node
 * fed by any further file is refused (G1 fix round 1, R6). Each file value
 * is read once (memoised). Lip-sync media have their own reserved slots
 * (LIPSYNC_MEDIA_READS, graphInputSeconds.ts), so a graph full of pictures
 * can't use them up.
 */
export const MAX_MEASURED_FILES = 8

/**
 * At most this many Seedance references are read per /prompt (G1 follow-up);
 * a reference past it is refused. A Seedance node sends at most 3 reference
 * videos and 3 reference sounds, so this covers two such nodes in full.
 */
export const SEEDANCE_REFERENCE_READS = 12

/** The read pools of a /prompt: pictures, lip-sync sound / video, and Seedance references. */
export type GatePool = 'pictures' | 'media' | 'references'

/**
 * One /prompt's file reads: memoised by what is read (`key`, e.g. the kind and
 * the file value), and at most `max[pool]` distinct reads in each pool. A
 * read past its pool's budget, or one that throws, is null.
 */
export interface GateReads {
  measure<T = number>(key: string, read: () => Promise<T | null>, pool?: GatePool): Promise<T | null>
}

export function createGateReads(max: Partial<Record<GatePool, number>> = {}): GateReads {
  const limit: Record<GatePool, number> = { pictures: MAX_MEASURED_FILES, media: LIPSYNC_MEDIA_READS, references: SEEDANCE_REFERENCE_READS, ...max }
  const seen = new Map<string, Promise<unknown>>()
  const used: Record<GatePool, number> = { pictures: 0, media: 0, references: 0 }
  return {
    measure<T>(key: string, read: () => Promise<T | null>, pool: GatePool = 'pictures'): Promise<T | null> {
      const hit = seen.get(`${pool}|${key}`)
      if (hit) return hit as Promise<T | null>
      if (used[pool] >= limit[pool]) return Promise.resolve(null)
      used[pool]++
      const p = read().catch(() => null)
      seen.set(`${pool}|${key}`, p)
      return p
    },
  }
}

/** The raster formats read through sharp's metadata: PNG, JPEG, WebP, GIF and TIFF, by their first bytes. */
export function isMeasurableRaster(head: Uint8Array): boolean {
  const fmt = sniffPictureFormat(head)
  return fmt === 'png' || fmt === 'jpeg' || fmt === 'webp' || fmt === 'gif' || fmt === 'tiff'
}

export type PictureFormat = 'png' | 'jpeg' | 'webp' | 'gif' | 'tiff' | 'bmp' | 'avif' | 'heic'

/**
 * The raster format a picture's first bytes claim to be (never its name), or
 * null for anything else (Task G1 extends this from PNG/JPEG/WebP to GIF,
 * TIFF, BMP, AVIF and HEIC — final re-review finding 1, "same class, lower
 * confidence"). `head` need only be the first 16 bytes for every format but
 * ISOBMFF's brand, which sits at bytes 8–11.
 */
export function sniffPictureFormat(head: Uint8Array): PictureFormat | null {
  const b = (i: number) => head[i]
  const ascii = (from: number, to: number) => String.fromCharCode(...head.subarray(from, to))
  if (head.length >= 4 && b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4E && b(3) === 0x47) return 'png' // \x89PNG
  if (head.length >= 3 && b(0) === 0xFF && b(1) === 0xD8 && b(2) === 0xFF) return 'jpeg' // JPEG SOI
  if (head.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp'
  if (head.length >= 4 && ascii(0, 3) === 'GIF' && b(3) === 0x38) return 'gif' // "GIF8" (87a/89a)
  if (head.length >= 4 && ((b(0) === 0x49 && b(1) === 0x49 && b(2) === 0x2A && b(3) === 0x00) // "II*\0" (little-endian)
    || (b(0) === 0x4D && b(1) === 0x4D && b(2) === 0x00 && b(3) === 0x2A))) return 'tiff' // "MM\0*" (big-endian)
  if (head.length >= 2 && b(0) === 0x42 && b(1) === 0x4D) return 'bmp' // "BM"
  if (head.length >= 12 && ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12)
    if (brand === 'avif' || brand === 'avis') return 'avif'
    if (['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1'].includes(brand)) return 'heic'
  }
  return null
}

const readU16LE = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8)
const readU32LE = (b: Uint8Array, i: number) => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0
const readI32LE = (b: Uint8Array, i: number) => readU32LE(b, i) | 0
const readU32BE = (b: Uint8Array, i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0

/**
 * Pixels of a BMP from its own header, no decode: the 14-byte file header
 * (which only carries "BM" and the pixel-data offset, not the size) plus its
 * DIB header — BITMAPCOREHEADER (12 bytes: width/height as u16) when the DIB
 * header size at byte 14 reads 12, else the BITMAPINFOHEADER-and-later family
 * (i32 width/height at bytes 18 and 22; a negative height means the rows run
 * top-down, so its absolute value is the count of them). Null when the
 * header is short or the size reads zero.
 */
export function bmpPixels(head: Uint8Array): number | null {
  const d = bmpDims(head)
  return d ? d.width * d.height : null
}

/** bmpPixels' width and height. */
export function bmpDims(head: Uint8Array): { width: number, height: number } | null {
  if (head.length < 18 || head[0] !== 0x42 || head[1] !== 0x4D) return null
  const dibSize = readU32LE(head, 14)
  let w: number, h: number
  if (dibSize === 12) {
    if (head.length < 22) return null
    w = readU16LE(head, 18)
    h = readU16LE(head, 20)
  }
  else {
    if (head.length < 26) return null
    w = readI32LE(head, 18)
    h = Math.abs(readI32LE(head, 22))
  }
  return w > 0 && h > 0 ? { width: w, height: h } : null
}

/**
 * One ISOBMFF box's type, its payload bounds within `bytes`, and whether its
 * declared size runs past what was read (`truncated`; a size-0 box, "to the
 * end of the file", counts as truncated too, since a header read can't tell).
 */
interface IsoBox { type: string, start: number, end: number, truncated: boolean }

/** Walks the sibling boxes between `from` and `to`; bounded, never throws on a malformed size. */
function* isoBoxes(bytes: Uint8Array, from: number, to: number): Generator<IsoBox> {
  let off = from
  while (off + 8 <= to) {
    const size32 = readU32BE(bytes, off)
    const type = String.fromCharCode(bytes[off + 4]!, bytes[off + 5]!, bytes[off + 6]!, bytes[off + 7]!)
    let headerLen = 8
    let size = size32
    let truncated = false
    if (size32 === 1) {
      // A 64-bit "largesize" follows the type; the high word must be 0 for a
      // box a picture header could hold, else it is taken as running past.
      if (off + 16 > to) { yield { type, start: off + 8, end: to, truncated: true }; return }
      if (readU32BE(bytes, off + 8) !== 0) truncated = true
      size = readU32BE(bytes, off + 12)
      headerLen = 16
    }
    else if (size32 === 0) { size = to - off; truncated = true }
    if (size < headerLen) return // malformed — stop rather than loop or misread
    if (off + size > to) truncated = true
    yield { type, start: off + headerLen, end: Math.min(off + size, to), truncated }
    if (truncated) return
    off += size
  }
}

/** The first `type` box among the siblings, or null; one that runs past the bytes read is returned (marked). */
function findIsoBox(bytes: Uint8Array, from: number, to: number, type: string): IsoBox | null {
  for (const b of isoBoxes(bytes, from, to)) {
    if (b.type === type) return b
    if (b.truncated) return null
  }
  return null
}

/** Width and height of a picture. */
export interface PictureDims { width: number, height: number }

/**
 * The size of an AVIF or HEIC picture from its box structure, no decode (so
 * a HEIC reads whether or not any installed codec could open it). Round 1 of
 * the G1 review (R1): the PRIMARY item's size, as the decoder shows it, not
 * any `ispe` found:
 *  - `meta` (a FullBox) → `pitm`: the primary item's id (u16, or u32 in
 *    version 1);
 *  - `meta` → `iprp` → `ipma` (FullBox; version 0 ids u16, else u32; flags
 *    bit 0: property indices u16 with the top bit "essential", else u8 with
 *    the top bit essential): the 1-based `ipco` property indices associated
 *    with that item;
 *  - `iprp` → `ipco`: the associated `ispe` (FullBox, then width and height
 *    as big-endian u32).
 * Null (can't be sized, so refused on a size-priced node in hosted mode)
 * when `meta`, `pitm`, `iprp`, `ipco` or `ipma` is missing or runs past the
 * bytes read, or the primary item has no `ispe`. A picture turned a quarter
 * (`irot` 1 or 3) keeps its pixel count; its sides are reported as stored,
 * with `rotated` set, since the decoder may or may not turn it.
 */
export function isobmffPrimarySize(bytes: Uint8Array): (PictureDims & { rotated: boolean }) | null {
  try {
    const meta = findIsoBox(bytes, 0, bytes.length, 'meta')
    if (!meta || meta.truncated) return null
    const kids = { from: meta.start + 4, to: meta.end }
    const pitm = findIsoBox(bytes, kids.from, kids.to, 'pitm')
    if (!pitm || pitm.truncated) return null
    const pitmVersion = bytes[pitm.start]!
    if (pitm.start + 4 + (pitmVersion === 0 ? 2 : 4) > pitm.end) return null
    const primary = pitmVersion === 0 ? (bytes[pitm.start + 4]! << 8 | bytes[pitm.start + 5]!) : readU32BE(bytes, pitm.start + 4)
    const iprp = findIsoBox(bytes, kids.from, kids.to, 'iprp')
    if (!iprp || iprp.truncated) return null
    const ipco = findIsoBox(bytes, iprp.start, iprp.end, 'ipco')
    if (!ipco || ipco.truncated) return null
    const properties: IsoBox[] = []
    for (const b of isoBoxes(bytes, ipco.start, ipco.end)) {
      if (b.truncated) return null
      properties.push(b)
    }
    // Every ipma (there may be more than one) — the primary item's indices.
    const indices: number[] = []
    let sawIpma = false
    for (const b of isoBoxes(bytes, iprp.start, iprp.end)) {
      if (b.truncated) return null
      if (b.type !== 'ipma') continue
      sawIpma = true
      const version = bytes[b.start]!
      const wide = (bytes[b.start + 3]! & 1) === 1
      let q = b.start + 4
      if (q + 4 > b.end) return null
      const count = readU32BE(bytes, q)
      q += 4
      for (let e = 0; e < count; e++) {
        const idLen = version < 1 ? 2 : 4
        if (q + idLen + 1 > b.end) return null
        const item = idLen === 2 ? (bytes[q]! << 8 | bytes[q + 1]!) : readU32BE(bytes, q)
        q += idLen
        const n = bytes[q]!
        q += 1
        for (let a = 0; a < n; a++) {
          if (q + (wide ? 2 : 1) > b.end) return null
          const index = wide ? ((bytes[q]! << 8 | bytes[q + 1]!) & 0x7FFF) : (bytes[q]! & 0x7F)
          q += wide ? 2 : 1
          if (item === primary) indices.push(index)
        }
      }
    }
    if (!sawIpma) return null
    let dims: PictureDims | null = null
    let rotated = false
    for (const index of indices) {
      const prop = index > 0 ? properties[index - 1] : undefined
      if (!prop) continue
      if (prop.type === 'ispe' && !dims) {
        const q = prop.start + 4
        if (q + 8 > prop.end) return null
        dims = { width: readU32BE(bytes, q), height: readU32BE(bytes, q + 4) }
      }
      if (prop.type === 'irot' && prop.start < prop.end) rotated = (bytes[prop.start]! & 3) % 2 === 1
    }
    return dims && dims.width > 0 && dims.height > 0 ? { ...dims, rotated } : null
  }
  catch { return null }
}

/** Pixels of an AVIF or HEIC picture's primary item (isobmffPrimarySize), or null. */
export function isobmffIspePixels(bytes: Uint8Array): number | null {
  const d = isobmffPrimarySize(bytes)
  return d ? d.width * d.height : null
}

/**
 * The ISOBMFF major brands read as one still picture (G1 fix round 2). The
 * engine's Pillow 12.1.1 AvifImagePlugin opens major brands avif, avis,
 * mif1 and msf1, and its libavif 1.3.0 (decoder source AUTO) decodes the
 * `moov` track instead of the primary item for `avis`, and for any other
 * brand but `avif` when the file has a track. So:
 *  - `avif` and `mif1` (and HEIC's `heic` / `heix`, which the engine can't
 *    decode at all) are stills: sized from the primary item;
 *  - `avis`, `msf1` and every other brand (the HEVC sequence brands `hevc`,
 *    `hevx`, `hevm`, `hevs`, and the multi-layer `heim`, `heis`) are refused;
 *  - any file with a top-level `moov` box (a track) is refused whatever its
 *    brand, so no decoder can choose the track over the item sized here.
 */
const STILL_BRANDS: ReadonlySet<string> = new Set(['avif', 'mif1', 'heic', 'heix'])
/** At most this many top-level boxes are walked; a file with more is refused. */
const MAX_TOP_LEVEL_BOXES = 256

/** The top-level box types of `file` (headers only, seeking from box to box), or null when they can't all be walked. */
async function topLevelBoxTypes(file: string | Uint8Array): Promise<string[] | null> {
  let total: number
  let read: (off: number, n: number) => Promise<Uint8Array>
  let close = async () => {}
  if (typeof file === 'string') {
    const fh = await open(file, 'r')
    total = (await fh.stat()).size
    read = async (off, n) => {
      const buf = new Uint8Array(n)
      const { bytesRead } = await fh.read(buf, 0, n, off)
      return buf.subarray(0, bytesRead)
    }
    close = () => fh.close()
  }
  else {
    total = file.byteLength
    read = async (off, n) => file.subarray(off, off + n)
  }
  try {
    const types: string[] = []
    let off = 0
    while (off < total) {
      if (types.length >= MAX_TOP_LEVEL_BOXES) return null
      const h = await read(off, 16)
      if (h.length < 8) return null
      const size32 = readU32BE(h, 0)
      const type = String.fromCharCode(h[4]!, h[5]!, h[6]!, h[7]!)
      let size: number
      let header = 8
      if (size32 === 1) {
        if (h.length < 16) return null
        size = readU32BE(h, 8) * 2 ** 32 + readU32BE(h, 12)
        header = 16
      }
      else if (size32 === 0) size = total - off // the last box, to the end of the file
      else size = size32
      if (size < header || off + size > total) return null
      types.push(type)
      off += size
    }
    return types
  }
  finally { await close() }
}

/** Whether an AVIF/HEIC file is read as one still picture: a still major brand and no top-level `moov`. */
export async function isobmffStill(file: string | Uint8Array, head: Uint8Array): Promise<boolean> {
  if (head.length < 12) return false
  const brand = String.fromCharCode(...head.subarray(8, 12))
  if (!STILL_BRANDS.has(brand)) return false
  const types = await topLevelBoxTypes(file)
  return types != null && !types.includes('moov')
}

/** `n` bytes of `file` from `offset` (fewer at its end), from disk or from an in-memory buffer. */
async function bytesAt(file: string | Uint8Array, offset: number, n: number): Promise<Uint8Array> {
  if (typeof file !== 'string') return file.subarray(offset, offset + n)
  const fh = await open(file, 'r')
  try {
    const buf = new Uint8Array(n)
    const { bytesRead } = await fh.read(buf, 0, n, offset)
    return buf.subarray(0, bytesRead)
  }
  finally { await fh.close() }
}

/** At most this many entries in a TIFF's first directory; more is refused. */
const MAX_TIFF_IFD_ENTRIES = 4096

/**
 * Whether a classic TIFF's first image directory (IFD0) names each tag once.
 * libtiff (sharp) keeps the first of a repeated tag and Pillow's
 * ImageFileDirectory_v2 the last, so a file repeating ImageWidth (256) or
 * ImageLength (257) is sized small by sharp and decoded large by the engine
 * (task-G1-rereview2 finding 2). Any repeated tag is refused, as is a
 * directory that can't be read whole: the header (byte order, 42, the IFD0
 * offset), the entry count (u16), then count × 12-byte entries whose first
 * u16 is the tag.
 */
export async function tiffFirstIfdUnique(file: string | Uint8Array): Promise<boolean> {
  try {
    const head = await bytesAt(file, 0, 8)
    if (head.length < 8) return false
    const le = head[0] === 0x49 && head[1] === 0x49
    if (!le && !(head[0] === 0x4D && head[1] === 0x4D)) return false
    const u16 = (b: Uint8Array, i: number) => (le ? b[i]! | b[i + 1]! << 8 : b[i]! << 8 | b[i + 1]!)
    const u32 = (b: Uint8Array, i: number) => (le ? readU32LE(b, i) : readU32BE(b, i))
    if (u16(head, 2) !== 42) return false
    const ifd = u32(head, 4)
    const countBytes = await bytesAt(file, ifd, 2)
    if (countBytes.length < 2) return false
    const count = u16(countBytes, 0)
    if (count < 1 || count > MAX_TIFF_IFD_ENTRIES) return false
    const entries = await bytesAt(file, ifd + 2, count * 12)
    if (entries.length < count * 12) return false
    const seen = new Set<number>()
    for (let e = 0; e < count; e++) {
      const tag = u16(entries, e * 12)
      if (seen.has(tag)) return false
      seen.add(tag)
    }
    return true
  }
  catch { return false }
}

/** A header-sized read of `file`'s first `n` bytes, from disk or from an in-memory buffer. */
async function headBytes(file: string | Uint8Array, n: number): Promise<Uint8Array> {
  if (typeof file !== 'string') return file.subarray(0, n)
  const fh = await open(file, 'r')
  try {
    const buf = new Uint8Array(n)
    const { bytesRead } = await fh.read(buf, 0, n, 0)
    return buf.subarray(0, bytesRead)
  }
  finally { await fh.close() }
}

/**
 * Header-sized reads of a file on disk, never the whole file: the small one
 * covers every signature and BMP's own header; the ISOBMFF box walk
 * (AVIF/HEIC) reads up to ISOBMFF_HEAD_BYTES, and a `meta` that runs past it
 * can't be sized (refused). Bytes already in memory (the runner's) are
 * walked whole.
 */
const SMALL_HEAD_BYTES = 64
export const ISOBMFF_HEAD_BYTES = 256 * 1024

/**
 * A picture's size as the engine loads it, from its header only, or null
 * when it can't be read. `width`/`height` are after the EXIF turn the engine
 * applies (ImageOps.exif_transpose in LoadImage and the Image card): sharp's
 * orientation 5–8 swaps them. An AVIF/HEIC whose primary item is turned a
 * quarter has only its pixel count (`width`/`height` absent), since whether
 * the decoder turns it is not known here.
 */
export async function pictureSize(file: string | Uint8Array): Promise<{ pixels: number, width?: number, height?: number } | null> {
  try {
    const head = await headBytes(file, SMALL_HEAD_BYTES)
    const fmt = sniffPictureFormat(head)
    if (fmt === 'bmp') {
      const d = bmpDims(head)
      return d ? { pixels: d.width * d.height, ...d } : null
    }
    if (fmt === 'avif' || fmt === 'heic') {
      // A sequence is decoded from its track, not the still item sized below (G1 fix round 2).
      if (!(await isobmffStill(file, head))) return null
      const d = isobmffPrimarySize(typeof file === 'string' ? await headBytes(file, ISOBMFF_HEAD_BYTES) : file)
      if (!d) return null
      // A quarter turn (irot) keeps the sides; the gate tries both orders of a file's sides anyway.
      return { pixels: d.width * d.height, width: d.width, height: d.height }
    }
    if (!fmt) return null
    // A TIFF that repeats a tag in its first directory is sized by sharp from
    // the first copy and decoded by the engine's Pillow from the last (G1 fix round 3).
    if (fmt === 'tiff' && !(await tiffFirstIfdUnique(file))) return null
    const m = await sharp(file, { pages: 1 }).metadata()
    if (!m.width || !m.height) return null
    const turned = typeof m.orientation === 'number' && m.orientation >= 5
    return { pixels: m.width * m.height, width: turned ? m.height : m.width, height: turned ? m.width : m.height }
  }
  catch { return null }
}

/** Pixels of a picture (its header only), across every format this reads, or null when it can't. */
export async function picturePixels(file: string | Uint8Array): Promise<number | null> {
  return (await pictureSize(file))?.pixels ?? null
}

/**
 * The size of an engine file named the way LoadImage names it (an optional
 * ` [input]` / ` [output]` / ` [temp]` annotation; input by default), or null.
 */
export async function engineFileSize(value: string): Promise<{ pixels: number, width?: number, height?: number } | null> {
  const { name, type } = annotatedFilepath(value)
  const folder = engineFolder(type ?? 'input')
  if (!folder || !name) return null
  const path = resolveInside(folder, name)
  return path ? pictureSize(path) : null
}

/** engineFileSize's pixel count alone. */
export async function engineFilePixels(value: string): Promise<number | null> {
  return (await engineFileSize(value))?.pixels ?? null
}

const inputsOf = (n: { inputs?: unknown } | undefined): NodeInputs =>
  (n?.inputs && typeof n.inputs === 'object' && !Array.isArray(n.inputs) ? n.inputs as NodeInputs : {})

/**
 * The size of a picture as the gate knows it before the run:
 *  - `px`, `exact: true`: measured from a file, or worked out exactly from
 *    one (an Upscale's factor, a Frame's canvas, Enhance detail in place);
 *  - `px`, `exact: false`: at most this large (a node's stated largest);
 *  - `unknown: 'unsized'`: a node whose picture's size can't be known before
 *    it runs, and has no stated upper bound (or the chain is too long, or
 *    loops);
 *  - `unknown: 'unreadable'`: a loaded file whose size couldn't be read (a
 *    format with no header reader here, a broken file);
 *  - `unknown: 'unread'`: a loaded file left unread because the prompt's
 *    read budget (MAX_MEASURED_FILES) ran out. Priced at the cap and not
 *    refused (a parked ruling: rare, and each file is only ever charged as
 *    its own size up to the cap) — unless something enlarges it on the way,
 *    which makes it 'unsized'.
 */
/** One possible width × height of a picture. */
export type Shape = readonly [number, number]

export type PictureSize =
  // `shapes`: every width × height the picture may have when it runs (G1 fix
  // round 3): a loaded file's sides in both orders, since which one the engine
  // takes as the width is not certain. `px` is the largest of them.
  | { px: number, exact: boolean, shapes?: readonly Shape[] }
  | { unknown: 'unsized' | 'unreadable' | 'unread' }

/** How far back a picture is followed; a longer chain (or a loop) is 'unsized'. */
export const MAX_HOPS = 64

/** Where a node's picture comes from, read from its class and settings. */
export type PictureRule =
  | { file: string }
  | { same: unknown } // the size of the picture on this link
  | { scaled: unknown, side: number, round: 'python' | 'up' } // that picture, `side` times each side
  | { resize: unknown, width: number, height: number } // nodes.py ImageScale
  | { crop: unknown, width: number, height: number, x: unknown, y: unknown } // nodes_images.py ImageCrop
  | { atLeast: unknown, bound: number } // the larger of that picture and `bound`
  | { atMost: number } // no larger than this, whatever comes in
  | { exact: number, width?: number, height?: number }
  | { unsized: true }

const UNSIZED = { unsized: true } as const

/** A whole number above 0 set on the node itself (not linked), else null. */
const literalSize = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null)
/** A whole number of 0 or more set on the node itself, else null. */
const literalCount = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null)

/**
 * Python's round() of a float to an int: halves go to the even neighbour
 * (round(2.5) is 2, round(3.5) is 4). `x` is the same IEEE double Python
 * computes, so the half test is exact.
 */
export function pyRound(x: number): number {
  const f = Math.floor(x)
  const d = x - f
  if (d > 0.5) return f + 1
  if (d < 0.5) return f
  return f % 2 === 0 ? f : f + 1
}

/**
 * The first connected Frame layer, in slot order: nodes_compositor.py (and
 * the runner's compositor/render.ts) size the canvas from it when no width
 * and height are set.
 */
const FRAME_LAYERS = 16

/**
 * The Nano Banana actions whose call-or-hand-on choice rests on text the
 * gate can't read before the run (R3): a deciding text input that is linked.
 * Python then decides at run time, after the link resolves, so the picture
 * is either handed on unchanged or made at 1K: the larger of the two. The
 * input named is the picture handed on. (A blank or missing text is
 * actionPassThrough's certain hand-on; a wrapped value was unwrapped by the
 * hosted normalisation before this is read.)
 */
function actionMaybePassThrough(classType: string, inputs: NodeInputs): string | null {
  switch (classType) {
    case 'RemoveObjectNode': return isLinkValue(inputs.target) ? 'image' : null
    case 'TextEditNode': return isLinkValue(inputs.find) || isLinkValue(inputs.replace) ? 'image' : null
    case 'RecolorObjectNode': return isLinkValue(inputs.target) || isLinkValue(inputs.color) ? 'image' : null
    // `not has_reference and not scene_prompt.strip()`: with no reference wired, a linked scene prompt decides.
    case 'SwapBackgroundNode': return !isLinkValue(inputs.background_reference) && isLinkValue(inputs.scene_prompt) ? 'product' : null
    default: return null
  }
}

/**
 * How a node's output picture is sized (Task G1). Each rule is read from the
 * node's own Python (named per case); anything not here is 'unsized'. The
 * inputs are the hosted normalisation's (hostedPrompt.ts): unwrapped and
 * coerced as ComfyUI's validation does, so a number here is the number that runs.
 */
export function pictureRule(classType: string, inputs: NodeInputs): PictureRule {
  switch (classType) {
    // nodes.py LoadImage: the file.
    case 'LoadImage':
      return typeof inputs.image === 'string' && inputs.image ? { file: inputs.image } : UNSIZED
    // nodes_image.py Image: a wired picture takes priority and is handed on
    // at its size (`scale` / `max_dimension` apply to the exported copy only);
    // else the file.
    case 'Image':
      if (inputs.images !== undefined) return Array.isArray(inputs.images) ? { same: inputs.images } : UNSIZED
      return typeof inputs.image === 'string' && inputs.image ? { file: inputs.image } : UNSIZED
    // nodes_replicate.py UpscaleImageNode: the input enlarged per side by its
    // engine's factor. A whole factor is exact; a fractional one is rounded
    // up per side (the service's own rounding isn't stated), so never below.
    case 'UpscaleImageNode': {
      const side = typeof inputs.model === 'string' ? upscaleSideFactor(inputs.model, inputs) : null
      return side == null ? UNSIZED : { scaled: inputs.image, side, round: 'up' }
    }
    // build_enhance_input: every engine runs in place.
    case 'EnhanceDetailNode':
      return typeof inputs.model === 'string' && hasOwn(ENHANCE_ENGINE_SLUGS, inputs.model) ? { same: inputs.image } : UNSIZED
    // nodes_compositor.py (the Frame): width × height when both are set,
    // else the first connected layer's size, else a 16 × 16 blank. A Frame
    // baked for motion hands on its baked frames instead, whose size the
    // gate can't see.
    case 'Compositor': {
      if (bakedForMotion(inputs.motion_params)) return UNSIZED
      if (isLinkValue(inputs.width) || isLinkValue(inputs.height)) return UNSIZED
      const w = literalSize(inputs.width) ?? 0
      const h = literalSize(inputs.height) ?? 0
      if (w > 0 && h > 0) return { exact: w * h, width: w, height: h }
      for (let i = 1; i <= FRAME_LAYERS; i++) {
        const layer = inputs[`layer${i}`]
        if (layer !== undefined && layer !== null) return { same: layer }
      }
      return { exact: 16 * 16, width: 16, height: 16 }
    }
    // nodes.py ImageScale: width × height; one side 0 keeps the input's
    // aspect (round(), at least 1); both 0 hands the picture on.
    case 'ImageScale': {
      const w = literalCount(inputs.width)
      const h = literalCount(inputs.height)
      return w == null || h == null ? UNSIZED : { resize: inputs.image, width: w, height: h }
    }
    // nodes.py ImageScaleBy: round(side × scale_by) each side (0.01–8; linked: 8, rounded up).
    case 'ImageScaleBy': {
      if (isLinkValue(inputs.scale_by)) return { scaled: inputs.image, side: 8, round: 'up' }
      const s = typeof inputs.scale_by === 'number' && inputs.scale_by > 0 ? inputs.scale_by : null
      return s == null ? UNSIZED : { scaled: inputs.image, side: s, round: 'python' }
    }
    // nodes_images.py ImageCrop: the slice from (min(x, W−1), min(y, H−1)), width × height at most.
    case 'ImageCrop': {
      const w = literalSize(inputs.width)
      const h = literalSize(inputs.height)
      return w && h ? { crop: inputs.image, width: w, height: h, x: inputs.x, y: inputs.y } : UNSIZED
    }
    // nodes.py EmptyImage: width × height, every frame (R1.4 fix round 1).
    case 'EmptyImage': {
      const w = literalSize(inputs.width)
      const h = literalSize(inputs.height)
      return w && h ? { exact: w * h, width: w, height: h } : UNSIZED
    }
    // nodes_replicate.py RemoveBackgroundNode: a cut-out of the same picture.
    case 'RemoveBackgroundNode':
      return { same: inputs.image }
    // nodes_replicate.py BlendSceneNode: with protected layers, the blend is
    // resized back onto the input's size before they are laid over it.
    case 'BlendSceneNode':
      if (inputs.keep_subject !== undefined && inputs.keep_subject !== null) return { same: inputs.image }
      break
  }
  // The Nano Banana actions (nodes_edit_actions.py and friends) hand their
  // picture on unchanged when there is nothing to change: the rule the
  // runner plans by (actionPassThrough). With the deciding text linked, the
  // larger of that and the 1K picture (R3).
  const through = actionPassThrough(classType, inputs)
  if (through) return { same: inputs[through] }
  const bound = madePictureBound(classType, inputs)
  const maybe = actionMaybePassThrough(classType, inputs)
  if (maybe) return bound == null ? UNSIZED : { atLeast: inputs[maybe], bound }
  return bound == null ? UNSIZED : { atMost: bound }
}

const isLinkValue = (v: unknown) => Array.isArray(v)

/** nodes_compositor.py's motion path: `motion_params` is JSON whose `rendered` is a non-empty list (or linked: may be). */
function bakedForMotion(v: unknown): boolean {
  if (isLinkValue(v)) return true
  if (typeof v !== 'string' || !v) return false
  try {
    const m = JSON.parse(v) as unknown
    const rendered = m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>).rendered : undefined
    return Array.isArray(rendered) && rendered.length > 0
  }
  // Python's json also reads NaN and Infinity; unsure, take it as baked.
  catch { return v.includes('rendered') }
}

/** What a gate file read gives: its size, 'unread' (the read budget ran out), or 'unreadable'. */
export type FileRead = { pixels: number, width?: number, height?: number } | 'unread' | 'unreadable'

/**
 * `side` × a picture whose sides aren't known, only its pixel count `px`:
 * the largest any shape of that many pixels could come to, each side rounded
 * up — (w·s + 1)(h·s + 1) with w·h = px is largest for a one-pixel-high strip:
 * px·s² + s·(px + 1) + 1.
 */
const scaledBound = (px: number, s: number) => Math.ceil(px * s * s + s * (px + 1) + 1)

/**
 * Sizes the pictures of one prompt, memoised per node. `measure` reads a
 * loaded file.
 */
function pictureSizer(prompt: Prompt, measure: (value: string) => Promise<FileRead>) {
  const memo = new Map<string, Promise<PictureSize>>()
  const onLink = (link: unknown, path: ReadonlySet<string>): Promise<PictureSize> => {
    if (!Array.isArray(link) || link.length < 1) return Promise.resolve({ unknown: 'unsized' })
    return ofNode(String(link[0]), path)
  }
  const ofNode = (id: string, path: ReadonlySet<string>): Promise<PictureSize> => {
    // A loop, or a chain past MAX_HOPS: 'unsized' (and not memoised, since the
    // same node reached along a shorter path may still be sized).
    if (path.has(id) || path.size >= MAX_HOPS) return Promise.resolve({ unknown: 'unsized' })
    const hit = memo.get(id)
    if (hit) return hit
    const p = size(id, new Set([...path, id]))
    memo.set(id, p)
    return p
  }
  /**
   * A picture from its possible shapes (G1 fix round 3, R1): duplicates
   * dropped; `px` is the largest pixel count among them, and it is exact only
   * when every shape has that count and the step (`exact`) is exact. The set
   * is kept whole through every later step, never merged into one shape: a
   * side-by-side largest is not an upper bound for a step that keeps the
   * aspect (a taller picture resized to a width comes out SHORTER).
   */
  const fromShapes = (shapes: readonly Shape[], exact: boolean): PictureSize => {
    const unique = shapes.filter((a, i) => shapes.findIndex(b => b[0] === a[0] && b[1] === a[1]) === i)
    const counts = unique.map(([w, h]) => w * h)
    const px = Math.max(...counts)
    return { px, exact: exact && counts.every(c => c === px), shapes: unique }
  }
  const size = async (id: string, path: ReadonlySet<string>): Promise<PictureSize> => {
    const node = prompt[id]
    const ct = node?.class_type
    if (typeof ct !== 'string') return { unknown: 'unsized' }
    const rule = pictureRule(ct, inputsOf(node))
    if ('file' in rule) {
      const r = await measure(rule.file)
      if (r === 'unread' || r === 'unreadable') return { unknown: r }
      // A file's side ORDER is never certain: the engine's exif_transpose also
      // reads orientation from PNG text chunks and XMP, which sharp doesn't.
      // Both orders are carried on.
      if (r.width && r.height) return fromShapes([[r.width, r.height], [r.height, r.width]], true)
      return { px: r.pixels, exact: true }
    }
    if ('same' in rule) return onLink(rule.same, path)
    if ('exact' in rule) return rule.width && rule.height ? fromShapes([[rule.width, rule.height]], true) : { px: rule.exact, exact: true }
    if ('atMost' in rule) return { px: rule.atMost, exact: false }
    if ('unsized' in rule) return { unknown: 'unsized' }
    const input = await onLink('scaled' in rule ? rule.scaled : 'resize' in rule ? rule.resize : 'crop' in rule ? rule.crop : rule.atLeast, path)
    if ('unknown' in input) return input
    if ('atLeast' in rule) return { px: Math.max(input.px, rule.bound), exact: false }
    const shapes = input.shapes
    if ('scaled' in rule) {
      const s = rule.side
      if (shapes) {
        if (rule.round === 'python') return fromShapes(shapes.map(([w, h]) => [pyRound(w * s), pyRound(h * s)] as const), input.exact)
        return fromShapes(shapes.map(([w, h]) => [Math.ceil(w * s), Math.ceil(h * s)] as const), input.exact && Number.isInteger(s))
      }
      if (Number.isInteger(s)) return { px: input.px * s * s, exact: input.exact }
      return { px: scaledBound(input.px, s), exact: false }
    }
    if ('resize' in rule) {
      if (rule.width === 0 && rule.height === 0) return input
      if (rule.width > 0 && rule.height > 0) return fromShapes([[rule.width, rule.height]], true)
      if (!shapes) return { unknown: 'unsized' }
      return fromShapes(shapes.map(([W, H]): Shape => (rule.width === 0
        ? [Math.max(1, pyRound(W * rule.height / H)), rule.height]
        : [rule.width, Math.max(1, pyRound(H * rule.width / W))])), input.exact)
    }
    // Crop: with the input's shapes and set offsets, each slice exactly; else at most width × height.
    const x = literalCount(rule.x) ?? (rule.x === undefined ? 0 : null)
    const y = literalCount(rule.y) ?? (rule.y === undefined ? 0 : null)
    if (shapes && x != null && y != null) {
      return fromShapes(shapes.map(([W, H]) => [
        Math.max(0, Math.min(rule.width, W - Math.min(x, W - 1))),
        Math.max(0, Math.min(rule.height, H - Math.min(y, H - 1))),
      ] as const), input.exact)
    }
    return { px: Math.min(rule.width * rule.height, input.px), exact: false }
  }
  return { ofLink: (link: unknown) => onLink(link, new Set()) }
}

/** A gate file reader: the picture's size (a pixel count, or with its sides), or null when it can't be sized. */
export type GateFileReader = (value: string) => Promise<number | { pixels: number, width?: number, height?: number } | null>

/** What the gate knows of the pictures a prompt's size-priced nodes are sent (graphInputSizes). */
export interface GraphInputSizes { pixels: Record<string, number>, problems: RequestProblem[] }

/**
 * What the gate knows of the picture each size-priced node is sent:
 * `pixels`, node id → its size (exact, or a stated largest at or under the
 * input cap), which the price reads; and `problems`, the size-priced nodes
 * the gate refuses before any hold (Task G1), apart from those whose
 * picture is exactly known and above the cap, which are in `pixels` and
 * refused by measuredInputProblems in its own words, as before:
 *  - it can't be sized before the run, or only to a largest above the cap
 *    (unsizedInputWords);
 *  - it is a loaded file whose size can't be read, or whose read failed
 *    (unreadableInputWords);
 *  - it is a loaded file left unread because the prompt's read budget
 *    (MAX_MEASURED_FILES) ran out (tooManyPicturesWords; G1 fix round 1, R6:
 *    no longer priced at the cap).
 * A node whose picture isn't wired (a literal or missing input) is neither
 * priced on a size nor refused here: the engine refuses it itself.
 * One walk serves both the price and the refusals (R7).
 * The ComfyUI path runs no runner family, so Rotate camera is never size-priced here.
 */
export async function graphInputSizes(
  prompt: Prompt,
  readFile: GateFileReader = engineFileSize,
  reads: GateReads = createGateReads(),
): Promise<GraphInputSizes> {
  const pixels: Record<string, number> = {}
  const problems: RequestProblem[] = []
  if (!prompt || typeof prompt !== 'object') return { pixels, problems }
  // One read per file value, and at most MAX_MEASURED_FILES picture reads per
  // prompt (lip-sync media read from their own pool of the same `reads`).
  // A read that throws, or a file that can't be sized, is 'unreadable'; the
  // budget's null is 'unread'.
  const measure = async (value: string): Promise<FileRead> => {
    const r = await reads.measure<FileRead>(`pixels:${value}`, async () => {
      try {
        const got = await readFile(value)
        if (typeof got === 'number') return got > 0 ? { pixels: got } : 'unreadable'
        return got && got.pixels > 0 ? got : 'unreadable'
      }
      catch { return 'unreadable' }
    }, 'pictures')
    return r ?? 'unread'
  }
  const sizer = pictureSizer(prompt, measure)
  for (const [id, node] of Object.entries(prompt)) {
    const ct = node?.class_type
    if (typeof ct !== 'string') continue
    const inputs = inputsOf(node)
    const name = sizePricedInput(ct, inputs)
    if (!name || !Array.isArray(inputs[name])) continue
    const s = await sizer.ofLink(inputs[name])
    const refuse = (message: string) => problems.push({ nodeId: id, classType: ct, input: name, message })
    if ('px' in s) {
      // Exact (above the cap too: measuredInputProblems refuses it in its own
      // words), or a largest at or under the cap: priced on it.
      if (s.exact || s.px <= LARGEST_INPUT_PIXELS) pixels[id] = s.px
      else refuse(unsizedInputWords(ct))
    }
    else if (s.unknown === 'unsized') refuse(unsizedInputWords(ct))
    else if (s.unknown === 'unreadable') refuse(unreadableInputWords(ct))
    else refuse(tooManyPicturesWords(ct))
  }
  return { pixels, problems }
}

/**
 * The largest a picture wire can be (pixels), by the same walk (pictureSizer),
 * or null when that can't be known before the run (unsized, unreadable, or
 * left unread by the read budget). R7.2: Upscale (2×)'s size cap at the start
 * of the run (server/runner/localModelStart.ts).
 */
export async function linkPictureBound(
  prompt: Prompt,
  link: unknown,
  readFile: GateFileReader = engineFileSize,
  reads: GateReads = createGateReads(),
): Promise<number | null> {
  const measure = async (value: string): Promise<FileRead> => {
    const r = await reads.measure<FileRead>(`pixels:${value}`, async () => {
      try {
        const got = await readFile(value)
        if (typeof got === 'number') return got > 0 ? { pixels: got } : 'unreadable'
        return got && got.pixels > 0 ? got : 'unreadable'
      }
      catch { return 'unreadable' }
    }, 'pictures')
    return r ?? 'unread'
  }
  const s = await pictureSizer(prompt, measure).ofLink(link)
  return 'px' in s ? s.px : null
}

/**
 * Every width × height a picture wire may have when it runs (the same walk,
 * pictureSizer), or null unless that set is known exactly (a loaded file's
 * sides come in both orders: which one is the width isn't certain). R7.3:
 * Object removal compares its picture's and its mask's before the hold
 * (server/runner/localModelStart.ts).
 */
export async function linkPictureShapes(
  prompt: Prompt,
  link: unknown,
  readFile: GateFileReader = engineFileSize,
  reads: GateReads = createGateReads(),
): Promise<readonly Shape[] | null> {
  const measure = async (value: string): Promise<FileRead> => {
    const r = await reads.measure<FileRead>(`pixels:${value}`, async () => {
      try {
        const got = await readFile(value)
        if (typeof got === 'number') return got > 0 ? { pixels: got } : 'unreadable'
        return got && got.pixels > 0 ? got : 'unreadable'
      }
      catch { return 'unreadable' }
    }, 'pictures')
    return r ?? 'unread'
  }
  const s = await pictureSizer(prompt, measure).ofLink(link)
  return 'px' in s && s.exact && s.shapes?.length ? s.shapes : null
}

/** Node id → the size of the picture each size-priced node is sent, where the gate knows it (graphInputSizes). */
export async function graphInputPixels(
  prompt: Prompt,
  readFile: GateFileReader = engineFileSize,
  reads: GateReads = createGateReads(),
): Promise<Record<string, number>> {
  return (await graphInputSizes(prompt, readFile, reads)).pixels
}
