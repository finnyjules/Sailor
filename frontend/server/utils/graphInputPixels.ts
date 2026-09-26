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
import { unreadableInputWords, unsizedInputWords, type RequestProblem } from '../runner/requestRules'
import { LIPSYNC_MEDIA_READS } from '../../shared/pricing/clipSettings'

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

type Prompt = Record<string, { class_type?: unknown; inputs?: unknown } | undefined>

/**
 * At most this many picture files are read per /prompt; any further
 * size-priced picture is priced at the cap. Each file value is read once
 * (memoised). Lip-sync media have their own reserved slots
 * (LIPSYNC_MEDIA_READS, graphInputSeconds.ts), so a graph full of pictures
 * can't use them up — and pictures already fail safe to the cap.
 */
export const MAX_MEASURED_FILES = 8

/** The two read pools of a /prompt: pictures, and lip-sync sound / video. */
export type GatePool = 'pictures' | 'media'

/**
 * One /prompt's file reads: memoised by what is read (`key`, e.g. the kind and
 * the file value), and at most `max[pool]` distinct reads in each pool. A
 * read past its pool's budget, or one that throws, is null (priced at the cap).
 */
export interface GateReads {
  measure(key: string, read: () => Promise<number | null>, pool?: GatePool): Promise<number | null>
}

export function createGateReads(max: Partial<Record<GatePool, number>> = {}): GateReads {
  const limit: Record<GatePool, number> = { pictures: MAX_MEASURED_FILES, media: LIPSYNC_MEDIA_READS, ...max }
  const seen = new Map<string, Promise<number | null>>()
  const used: Record<GatePool, number> = { pictures: 0, media: 0 }
  return {
    measure(key, read, pool = 'pictures') {
      const hit = seen.get(`${pool}|${key}`)
      if (hit) return hit
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
  return w > 0 && h > 0 ? w * h : null
}

/** One ISOBMFF box's type and its payload bounds within `bytes`. */
interface IsoBox { type: string, start: number, end: number }

/** Walks the sibling boxes between `from` and `to`; bounded, never throws on a malformed size. */
function* isoBoxes(bytes: Uint8Array, from: number, to: number): Generator<IsoBox> {
  let off = from
  while (off + 8 <= to) {
    const size32 = readU32BE(bytes, off)
    const type = String.fromCharCode(bytes[off + 4]!, bytes[off + 5]!, bytes[off + 6]!, bytes[off + 7]!)
    let headerLen = 8
    let size = size32
    if (size32 === 1) {
      // A 64-bit "largesize" follows the type; a header region is never that
      // large, so its low 32 bits are read and the high word is assumed 0.
      if (off + 16 > to) return
      size = readU32BE(bytes, off + 12)
      headerLen = 16
    }
    else if (size32 === 0) size = to - off // extends to the end of the parent
    if (size < headerLen) return // malformed — stop rather than loop or misread
    const end = Math.min(off + size, to)
    yield { type, start: off + headerLen, end }
    off += size
  }
}

function findIsoBox(bytes: Uint8Array, from: number, to: number, type: string): IsoBox | null {
  for (const b of isoBoxes(bytes, from, to)) if (b.type === type) return b
  return null
}

/**
 * Pixels of an AVIF or HEIC picture from its `ispe` (ImageSpatialExtents)
 * property box, walked ISOBMFF-fashion — no decode, so this reads a HEIC
 * whether or not any installed codec could ever open it: `ftyp` → `meta`
 * (a FullBox: 4 bytes of version/flags, then children) → `iprp` → `ipco` →
 * the largest `ispe` (also a FullBox; its payload is two big-endian u32s,
 * width then height). `bytes` need only be a header-sized read (the boxes
 * this walks sit before the picture's own encoded data); null when any box
 * is missing, truncated, or outside the bytes read.
 */
export function isobmffIspePixels(bytes: Uint8Array): number | null {
  try {
    const meta = findIsoBox(bytes, 0, bytes.length, 'meta')
    if (!meta) return null
    const iprp = findIsoBox(bytes, meta.start + 4, meta.end, 'iprp')
    if (!iprp) return null
    const ipco = findIsoBox(bytes, iprp.start, iprp.end, 'ipco')
    if (!ipco) return null
    // Every `ispe` in the property container, the largest taken: a tiled
    // (grid) picture — every iPhone HEIC — lists its tiles' size as well as
    // the whole picture's, and a thumbnail's, so the first can be a 512 × 512
    // tile. The largest is never below the picture itself.
    let largest = 0
    for (const box of isoBoxes(bytes, ipco.start, ipco.end)) {
      if (box.type !== 'ispe') continue
      const p = box.start + 4
      if (p + 8 > bytes.length || p + 8 > box.end) continue
      const px = readU32BE(bytes, p) * readU32BE(bytes, p + 4)
      if (px > largest) largest = px
    }
    return largest > 0 ? largest : null
  }
  catch { return null }
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
 * Header-sized reads only, never the whole file: the small one covers every
 * signature and BMP's own header; the ISOBMFF box walk (AVIF/HEIC) reads
 * further because `meta`/`iprp`/`ipco`/`ispe` can sit a little into the file
 * (still nowhere near the encoded picture data itself).
 */
const SMALL_HEAD_BYTES = 64
const ISOBMFF_HEAD_BYTES = 65536

/** Pixels of a picture (its header only), across every format this reads, or null when it can't. */
export async function picturePixels(file: string | Uint8Array): Promise<number | null> {
  try {
    const head = await headBytes(file, SMALL_HEAD_BYTES)
    const fmt = sniffPictureFormat(head)
    if (fmt === 'bmp') return bmpPixels(head)
    if (fmt === 'avif' || fmt === 'heic') return isobmffIspePixels(await headBytes(file, ISOBMFF_HEAD_BYTES))
    if (!fmt) return null
    const m = await sharp(file, { pages: 1 }).metadata()
    return m.width && m.height ? m.width * m.height : null
  }
  catch { return null }
}

/**
 * Pixels of an engine file named the way LoadImage names it (an optional
 * ` [input]` / ` [output]` / ` [temp]` annotation; input by default), or null.
 */
export async function engineFilePixels(value: string): Promise<number | null> {
  const { name, type } = annotatedFilepath(value)
  const folder = engineFolder(type ?? 'input')
  if (!folder || !name) return null
  const path = resolveInside(folder, name)
  return path ? picturePixels(path) : null
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
export type PictureSize =
  | { px: number, exact: boolean }
  | { unknown: 'unsized' | 'unreadable' | 'unread' }

/** How far back a picture is followed; a longer chain (or a loop) is 'unsized'. */
export const MAX_HOPS = 64

/** Where a node's picture comes from, read from its class and settings. */
type PictureRule =
  | { file: string }
  | { same: unknown } // the size of the picture on this link
  | { scaled: unknown, side: number } // that picture, `side` times larger on each side
  | { atMost: number } // no larger than this, whatever comes in
  | { exact: number }
  | { unsized: true }

const UNSIZED = { unsized: true } as const

/** A whole number above 0 set on the node itself (not linked), else null. */
const literalSize = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null)

/**
 * The first connected Frame layer, in slot order: nodes_compositor.py (and
 * the runner's compositor/render.ts) size the canvas from it when no width
 * and height are set.
 */
const FRAME_LAYERS = 16

/**
 * How a node's output picture is sized (Task G1). Each rule is read from the
 * node's own Python (named per case); anything not here is 'unsized'.
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
    // nodes_replicate.py UpscaleImageNode: the input enlarged per side by its engine's factor.
    case 'UpscaleImageNode': {
      const side = typeof inputs.model === 'string' ? upscaleSideFactor(inputs.model, inputs) : null
      return side == null ? UNSIZED : { scaled: inputs.image, side }
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
      if (w > 0 && h > 0) return { exact: w * h }
      for (let i = 1; i <= FRAME_LAYERS; i++) {
        const layer = inputs[`layer${i}`]
        if (layer !== undefined && layer !== null) return { same: layer }
      }
      return { exact: 16 * 16 }
    }
    // nodes.py ImageScale: width × height when both are set (0 keeps the
    // input's aspect, which the gate can't see from a pixel count).
    case 'ImageScale': {
      const w = literalSize(inputs.width)
      const h = literalSize(inputs.height)
      return w && h ? { exact: w * h } : UNSIZED
    }
    // nodes.py ImageScaleBy: `scale_by` per side (0.01–8; linked: 8).
    case 'ImageScaleBy': {
      const s = typeof inputs.scale_by === 'number' && inputs.scale_by > 0 ? inputs.scale_by : isLinkValue(inputs.scale_by) ? 8 : null
      return s == null ? UNSIZED : { scaled: inputs.image, side: s }
    }
    // nodes_images.py ImageCrop: never larger than width × height.
    case 'ImageCrop': {
      const w = literalSize(inputs.width)
      const h = literalSize(inputs.height)
      return w && h ? { atMost: w * h } : UNSIZED
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
  // runner plans by (actionPassThrough).
  const through = actionPassThrough(classType, inputs)
  if (through) return { same: inputs[through] }
  const bound = madePictureBound(classType, inputs)
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

/**
 * Sizes the pictures of one prompt, memoised per node. `measure` reads a
 * loaded file's size: null when it wasn't read (the budget), -1 when it
 * was read and couldn't be sized.
 */
function pictureSizer(prompt: Prompt, measure: (value: string) => Promise<number | null>) {
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
  const size = async (id: string, path: ReadonlySet<string>): Promise<PictureSize> => {
    const node = prompt[id]
    const ct = node?.class_type
    if (typeof ct !== 'string') return { unknown: 'unsized' }
    const rule = pictureRule(ct, inputsOf(node))
    if ('file' in rule) {
      const px = await measure(rule.file)
      if (px == null) return { unknown: 'unread' }
      return px > 0 ? { px, exact: true } : { unknown: 'unreadable' }
    }
    if ('same' in rule) return onLink(rule.same, path)
    if ('scaled' in rule) {
      const input = await onLink(rule.scaled, path)
      if ('unknown' in input) return rule.side <= 1 ? input : { unknown: input.unknown === 'unreadable' ? 'unreadable' : 'unsized' }
      return { px: Math.ceil(input.px * rule.side * rule.side), exact: input.exact }
    }
    if ('atMost' in rule) return { px: rule.atMost, exact: false }
    if ('exact' in rule) return { px: rule.exact, exact: true }
    return { unknown: 'unsized' }
  }
  return { ofLink: (link: unknown) => onLink(link, new Set()) }
}

/**
 * What the gate knows of the picture each size-priced node is sent:
 * `pixels`, node id → its size (exact, or a stated largest at or under the
 * input cap), which the price reads; and `problems`, the size-priced nodes
 * the gate refuses before any hold (Task G1), apart from those whose
 * picture is exactly known and above the cap, which are in `pixels` and
 * refused by measuredInputProblems in its own words, as before:
 *  - it can't be sized before the run, or only to a largest above the cap
 *    (unsizedInputWords);
 *  - it is a loaded file whose size can't be read (unreadableInputWords).
 * A node whose picture isn't wired (a literal or missing input) is neither
 * priced on a size nor refused here: the engine refuses it itself.
 * The ComfyUI path runs no runner family, so Rotate camera is never size-priced here.
 */
export async function graphInputSizes(
  prompt: Prompt,
  readFile: (value: string) => Promise<number | null> = engineFilePixels,
  reads: GateReads = createGateReads(),
): Promise<{ pixels: Record<string, number>, problems: RequestProblem[] }> {
  const pixels: Record<string, number> = {}
  const problems: RequestProblem[] = []
  if (!prompt || typeof prompt !== 'object') return { pixels, problems }
  // One read per file value, and at most MAX_MEASURED_FILES picture reads per
  // prompt (lip-sync media read from their own pool of the same `reads`).
  // A file read but not sized is -1, so the budget's null stays apart.
  const measure = (value: string): Promise<number | null> =>
    reads.measure(`pixels:${value}`, async () => (await readFile(value)) ?? -1, 'pictures')
  const sizer = pictureSizer(prompt, measure)
  for (const [id, node] of Object.entries(prompt)) {
    const ct = node?.class_type
    if (typeof ct !== 'string') continue
    const inputs = inputsOf(node)
    const name = sizePricedInput(ct, inputs)
    if (!name || !Array.isArray(inputs[name])) continue
    const s = await sizer.ofLink(inputs[name])
    if ('px' in s) {
      // Exact (above the cap too: measuredInputProblems refuses it in its own
      // words), or a largest at or under the cap: priced on it.
      if (s.exact || s.px <= LARGEST_INPUT_PIXELS) pixels[id] = s.px
      else problems.push({ nodeId: id, classType: ct, input: name, message: unsizedInputWords(ct) })
    }
    else if (s.unknown === 'unsized') problems.push({ nodeId: id, classType: ct, input: name, message: unsizedInputWords(ct) })
    else if (s.unknown === 'unreadable') problems.push({ nodeId: id, classType: ct, input: name, message: unreadableInputWords(ct) })
  }
  return { pixels, problems }
}

/** Node id → the size of the picture each size-priced node is sent, where the gate knows it (graphInputSizes). */
export async function graphInputPixels(
  prompt: Prompt,
  readFile: (value: string) => Promise<number | null> = engineFilePixels,
  reads: GateReads = createGateReads(),
): Promise<Record<string, number>> {
  return (await graphInputSizes(prompt, readFile, reads)).pixels
}

/** The size-priced nodes the gate refuses on their picture's size (graphInputSizes). */
export async function graphInputPixelProblems(
  prompt: Prompt,
  readFile: (value: string) => Promise<number | null> = engineFilePixels,
  reads: GateReads = createGateReads(),
): Promise<RequestProblem[]> {
  return (await graphInputSizes(prompt, readFile, reads)).problems
}
