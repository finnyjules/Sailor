/**
 * Save image and Preview image (step 3, R1.5): the pictures wired in, written
 * as files, here. No provider, no charge; they count as work (spec ruling 5).
 *
 *   SaveImage    — nodes.py SaveImage.save_images: each picture's tensor as
 *                  np.clip(255·x, 0, 255).astype(uint8); `scale`, then
 *                  `max_dimension` (from the first picture's size), resized
 *                  with Pillow's Lanczos (../pixels/core.ts); png
 *                  (compression 0–9, the run's prompt and workflow as tEXt),
 *                  jpeg (flattened onto white when it has alpha, with
 *                  Pillow's paste arithmetic; quality, progressive,
 *                  optimised) or webp (quality, or lossless). Named by
 *                  folder_paths.get_save_image_path: the prefix's `%width%`,
 *                  `%height%`, `%year%` … `%second%`, its subfolder, and the
 *                  counter; `%batch_num%` per picture. Written to the output
 *                  folder as the run's assets (hosted, in the user's own
 *                  folder, owned by the user).
 *   PreviewImage — nodes.py PreviewImage: the same, png at compression 1
 *                  with no resize, into temp under `ComfyUI_temp_` + five
 *                  random letters; not an asset.
 *
 * Differences from Python, known: JPEG and WebP carry no workflow (Python
 * writes it into EXIF UserComment when its PIL build can; the runner never
 * does). The encoders are sharp's (libvips), so JPEG and WebP bytes differ;
 * decoded, they are within the lossy tolerance (spec Open question 3). A
 * picture made here in float reaches this card as the 8-bit PNG it was kept
 * as: the Frame hands on trunc(f32(255·x)) (plane.ts toPreview8), which is
 * exactly what save_images writes, and Text mask with a source keeps that
 * too when only Save image / Preview image read it (utilities.ts
 * onlySavesRead); read by a provider as well, it keeps the hand-off's round,
 * one level apart from Python's save on some edge pixels. Of Python's
 * extra_pnginfo only `workflow` is embedded: it is all the app sends.
 *
 * An SVG (R11.4: a Recraft SVG model's `svg` value, shared/runner/svgImage.ts)
 * is written as it came, `<name>_00001_.svg`, named as a picture is (its
 * width and height from the SVG's own); the format, scale and size settings
 * are a picture's and don't apply to it. Python can't decode it at all.
 *
 * A list value (R1.6) is saved item by item, as ComfyUI runs the node once
 * per item. A loader's animation (Python's batch of frames) is refused at the
 * start of the take (engine.ts, cardPictureFiles) and here again.
 *
 * A clip's frames (R11.9a, row 15, ruling (q): a `frames` value, a kept FFV1
 * batch) are saved one file per frame, as save_images saves a batch: each
 * frame's rgb24 is exactly np.clip(255·x).astype(uint8) of PyAV's frame, so
 * the bytes are Python's; `%batch_num%` and the counter move on per frame.
 * The frames are decoded one at a time (never the whole batch in memory).
 */
import { crc32 } from 'node:zlib'
import sharp from 'sharp'
import type { DeriveIO, Derived, NodePlan, PlanContext } from '../executors'
import type { OutputFile } from '../types'
import { GATE_CLASS, isLink, type ApiLink, type ApiPrompt } from '#shared/runner/graph'
import type { PictureSource } from '../compositor/decode'
import { pyFloatOf, pyIntOf, pyTruthy } from '#shared/runner/pyText'
import { CARD_MAX_PIXELS, outputKindsFor } from '#shared/runner/eligibility'
import { outputKind } from '#shared/runner/values'
import { MEDIA_CAPS } from '#shared/runner/media'
import type { RunnerFamily } from '#shared/runner/families'
import type { FrameShape } from '../video/table'
import { pictureSourceOf } from '../compositor/plan'
import { pixelsInWorker } from '../compositor/worker'
import { PICTURE_ANIMATED, pictureHasFrames, pictureMeta } from '../pictures/pythonView'
import { pixels } from '../pixels/core'
import { SAVE_OUTSIDE } from '../results'
import { filesOf } from '../values'
import { loaderFileBehind } from './bakeReplay'
import type { RunnerValue } from '../types'
import { framesOf } from '../../media/values'
import { mediaLease } from '../../media/run'
import { PICTURE_NOT_MADE, decoded, sizes, type Wired } from './utilities'

export { SAVE_OUTSIDE }
export const SAVE_FAILED = 'The picture couldn’t be saved under this file name. Try a shorter, plainer name.'
export const SAVE_TOO_LARGE = `The pictures to save are too large (more than ${Math.floor(CARD_MAX_PIXELS / 1_000_000)} million pixels). Use a smaller scale.`

// ── folder_paths.get_save_image_path ─────────────────────────────────────────

/** Python's posixpath.normpath. */
export function pyNormpath(path: string): string {
  if (path === '') return '.'
  let initial = path.startsWith('/') ? 1 : 0
  if (initial && path.startsWith('//') && !path.startsWith('///')) initial = 2
  const out: string[] = []
  for (const comp of path.split('/')) {
    if (comp === '' || comp === '.') continue
    if (comp !== '..' || (!initial && !out.length) || (out.length && out[out.length - 1] === '..')) out.push(comp)
    else if (out.length) out.pop()
  }
  const joined = '/'.repeat(initial) + out.join('/')
  return joined || '.'
}

/** Python's posixpath.dirname and basename. */
function pySplit(p: string): { dir: string; base: string } {
  const i = p.lastIndexOf('/') + 1
  let dir = p.slice(0, i)
  if (dir && dir !== '/'.repeat(dir.length)) dir = dir.replace(/\/+$/, '')
  return { dir, base: p.slice(i) }
}

const two = (n: number) => String(n).padStart(2, '0')

/**
 * get_save_image_path's name for a prefix: the variables filled in (the
 * clock in local time, as time.localtime), then the normalised prefix split
 * into its subfolder and file name. A subfolder outside the output folder
 * (`..`, an absolute path) is refused, as Python refuses it.
 */
export function saveImagePrefix(prefix: string, w: number, h: number, now: Date): { subfolder: string; filename: string } {
  let p = prefix
  if (p.includes('%')) {
    p = p.replaceAll('%width%', String(w)).replaceAll('%height%', String(h))
      .replaceAll('%year%', String(now.getFullYear())).replaceAll('%month%', two(now.getMonth() + 1))
      .replaceAll('%day%', two(now.getDate())).replaceAll('%hour%', two(now.getHours()))
      .replaceAll('%minute%', two(now.getMinutes())).replaceAll('%second%', two(now.getSeconds()))
  }
  if (p.includes('\0')) throw new Error(SAVE_OUTSIDE)
  const { dir, base } = pySplit(pyNormpath(p))
  if (dir.startsWith('/') || dir === '..' || dir.startsWith('../')) throw new Error(SAVE_OUTSIDE)
  return { subfolder: dir, filename: base }
}

// ── PNG text ─────────────────────────────────────────────────────────────────

/** Python's json.dumps output is ASCII (ensure_ascii): everything past `~` as \uXXXX. */
export function asciiJson(v: unknown): string {
  return (JSON.stringify(v) ?? 'null').replace(/[\u007f-￿]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])
}

/**
 * PngInfo.add_text: one tEXt chunk per entry (keyword, NUL, Latin-1 text),
 * inserted before IEND. Text beyond Latin-1 is refused (the callers pass
 * json.dumps-style ASCII).
 */
export function insertPngText(png: Uint8Array, entries: [string, string][]): Uint8Array {
  if (!entries.length) return png
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  let iend = -1
  for (let o = 8; o + 12 <= png.length;) {
    const len = view.getUint32(o)
    if (png[o + 4] === 0x49 && png[o + 5] === 0x45 && png[o + 6] === 0x4E && png[o + 7] === 0x44) { iend = o; break }
    o += 12 + len
  }
  if (iend < 0) throw new Error('This PNG has no end')
  const chunks: Uint8Array[] = []
  for (const [key, text] of entries) {
    const body = new Uint8Array(4 + key.length + 1 + text.length)
    body.set([0x74, 0x45, 0x58, 0x74]) // tEXt
    let i = 4
    for (const s of [key, '\0', text]) {
      for (let k = 0; k < s.length; k++) {
        const c = s.charCodeAt(k)
        if (c > 255) throw new Error('PNG text must be Latin-1')
        body[i++] = c
      }
    }
    chunks.push(u32(body.length - 4), body, u32(crc32(body) >>> 0))
  }
  const size = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(png.length + size)
  out.set(png.subarray(0, iend), 0)
  let o = iend
  for (const c of chunks) { out.set(c, o); o += c.length }
  out.set(png.subarray(iend), o)
  return out
}

// ── The settings ─────────────────────────────────────────────────────────────

type Format = 'png' | 'webp' | 'jpeg'

interface SaveSettings {
  prefix: string
  format: Format
  quality: number
  lossless: boolean
  compression: number
  scale: number
  maxDimension: number
  embed: boolean
}

/** Python's str() of a widget value (validate_inputs converts STRING with str()). */
function pyStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  if (v === null || v === undefined) return 'None'
  return String(v)
}

function intOf(v: unknown, name: string): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'boolean') return Number(v)
  const n = typeof v === 'string' ? pyIntOf(v) : null
  if (n === null) throw new Error(`Save image’s ${name} is not a whole number`)
  return n
}

function floatOf(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return Number(v)
  const n = typeof v === 'string' ? pyFloatOf(v) : null
  if (n === null) throw new Error('Save image’s scale is not a number')
  return n
}

function saveSettings(inputs: Record<string, unknown>): SaveSettings {
  const f = String(inputs.format ?? 'png').toLowerCase()
  return {
    prefix: pyStr(inputs.filename_prefix ?? 'ComfyUI'),
    format: f === 'webp' || f === 'jpeg' ? f : 'png',
    quality: intOf(inputs.quality ?? 90, 'quality'),
    lossless: pyTruthy(inputs.lossless_webp ?? false),
    compression: intOf(inputs.png_compression ?? 4, 'PNG compression'),
    scale: floatOf(inputs.scale ?? 1),
    maxDimension: intOf(inputs.max_dimension ?? 0, 'largest side'),
    embed: pyTruthy(inputs.embed_metadata ?? true),
  }
}

/** Python's round() on a float: halves to the even neighbour. */
const pyRound = (x: number) => pixels.roundHalfEven(x)

/** save_images' output size from the first picture's: `scale`, then `max_dimension` (never up). */
export function saveSize(w: number, h: number, scale: number, maxDimension: number): { w: number; h: number } {
  let ow = w
  let oh = h
  if (scale && scale > 0 && scale !== 1) {
    ow = Math.max(1, pyRound(w * scale))
    oh = Math.max(1, pyRound(h * scale))
  }
  if (maxDimension > 0) {
    const longest = Math.max(ow, oh)
    if (longest > maxDimension) {
      const ratio = maxDimension / longest
      ow = Math.max(1, pyRound(ow * ratio))
      oh = Math.max(1, pyRound(oh * ratio))
    }
  }
  return { w: ow, h: oh }
}

// ── The pictures wired in ────────────────────────────────────────────────────

const keyOf = (f: OutputFile) => `${f.type}:${f.subfolder}:${f.filename}`

/**
 * Whether a picture wire brings a Text mask's clipped picture (followed back
 * through what hands a picture on unchanged). Its kept PNG already holds the
 * tensor's alpha: read with an Image card source, the card's 1 − mask round
 * trip would be applied a second time.
 */
export function fromTextMask(prompt: ApiPrompt, link: ApiLink, depth = 0): boolean {
  const node = prompt[link[0]]
  if (!node || depth > 64) return false
  const inputs = node.inputs ?? {}
  if (node.class_type === 'TextMask') return link[1] === 0 && isLink(inputs.source)
  if (node.class_type === 'Image' && isLink(inputs.images)) return fromTextMask(prompt, inputs.images, depth + 1)
  if (node.class_type === GATE_CLASS && isLink(inputs.data_in)) return fromTextMask(prompt, inputs.data_in, depth + 1)
  return false
}

/** Each run of the node: the batch it saves (a list value: one run per item). */
function batchesOf(ctx: PlanContext): Wired[] {
  const v = ctx.prompt[ctx.nodeId]!.inputs?.images
  if (!isLink(v)) throw new Error('There is no picture wired in')
  const link: ApiLink = v
  const found = pictureSourceOf(ctx.prompt, link)
  const source: PictureSource = found === 'card' && fromTextMask(ctx.prompt, link) ? 'made' : found
  if (source === 'blank') return [{ source, files: [] }]
  const value = ctx.valueFrom?.(link)
  const files = value ? filesOf(value) : ctx.filesFrom(link)
  if (!files.length) throw new Error(PICTURE_NOT_MADE)
  if (value?.kind === 'files' && value.list) return files.map(f => ({ source, files: [f] }))
  return [{ source, files }]
}

/** Backstop for the start-of-take check: a loader's animation is a batch Python saves frame by frame. */
async function refuseAnimation(io: DeriveIO, prompt: ApiPrompt, link: unknown): Promise<void> {
  if (!isLink(link)) return
  const behind = loaderFileBehind(prompt, link)
  if (!behind) return
  let bytes: Uint8Array
  try { bytes = await io.read(behind.file) }
  catch { return }
  let frames = false
  try { frames = pictureHasFrames(await pictureMeta(bytes), bytes) }
  catch { return }
  if (frames) throw new Error(PICTURE_ANIMATED)
}

// ── Saving ───────────────────────────────────────────────────────────────────

/** One picture's file bytes in the chosen format, from the 8-bit pixels save_images encodes. */
async function encode(p: { w: number; h: number; channels: 3 | 4; px: Uint8Array }, s: SaveSettings, text: [string, string][]): Promise<Uint8Array> {
  const img = sharp(p.px, { raw: { width: p.w, height: p.h, channels: p.channels }, limitInputPixels: false })
  if (s.format === 'jpeg') return new Uint8Array(await img.jpeg({ quality: s.quality, progressive: true, optimiseCoding: true }).toBuffer())
  if (s.format === 'webp') return new Uint8Array(await img.webp({ quality: s.quality, lossless: s.lossless }).toBuffer())
  const png = new Uint8Array(await img.png({ compressionLevel: s.compression }).toBuffer())
  return insertPngText(png, text)
}

const EXT: Readonly<Record<Format, string>> = { png: 'png', webp: 'webp', jpeg: 'jpg' }

/**
 * save_images over each batch: the size from the first picture, the name
 * worked out once, each distinct file decoded and encoded once, then one
 * file per picture with the counter moving on.
 */
async function saveAll(io: DeriveIO, batches: Wired[], s: SaveSettings, o: { folder: 'output' | 'temp'; prefixAppend: string; now: Date }): Promise<Derived> {
  const text: [string, string][] = []
  if (s.embed) {
    text.push(['prompt', asciiJson(io.runPrompt)])
    if (io.runWorkflow != null) text.push(['workflow', asciiJson(io.runWorkflow)])
  }
  const images: OutputFile[] = []
  for (const batch of batches) {
    const known = await sizes(io, batch, true)
    const first = batch.files.length ? known.get(keyOf(batch.files[0]!))! : { w: 1, h: 1 }
    const out = saveSize(first.w, first.h, s.scale, s.maxDimension)
    if (Math.max(1, batch.files.length) * out.w * out.h > CARD_MAX_PIXELS) throw new Error(SAVE_TOO_LARGE)
    const { subfolder, filename } = saveImagePrefix(s.prefix + o.prefixAppend, out.w, out.h, o.now)
    const encoded = await pixelsInWorker(io.signal, async (worker) => {
      const made = new Map<string, Uint8Array>()
      for (const file of batch.files.length ? batch.files : [null]) {
        const key = file ? keyOf(file) : 'blank'
        if (made.has(key)) continue
        if (io.signal.aborted) throw new Error('Stopped')
        const p = await worker.savePixels(await decoded(io, batch.source, file), out.w, out.h, s.format === 'jpeg')
        made.set(key, await encode(p, s, text))
      }
      return made
    })
    const files = batch.files.length ? batch.files : [null]
    for (let i = 0; i < files.length; i++) {
      if (io.signal.aborted) throw new Error('Stopped')
      const bytes = encoded.get(files[i] ? keyOf(files[i]!) : 'blank')!
      const named = filename.replaceAll('%batch_num%', String(i))
      try {
        images.push(await io.saveAsset(bytes, {
          prefix: named, ext: EXT[s.format], subfolder, folder: o.folder,
          ...(named !== filename ? { counter: { prefix: filename, offset: i } } : {}),
        }))
      }
      catch (e) {
        // The file system's own words name the server's folders: never shown on a node.
        if (e instanceof Error && (e.message === SAVE_OUTSIDE || e.message === 'The file store is not available')) throw e
        throw new Error(SAVE_FAILED)
      }
    }
  }
  return { values: {}, ui: { images: images.map(f => ({ filename: f.filename, subfolder: f.subfolder, type: f.type })) } }
}

// ── A clip's frames (R11.9a, row 15) ─────────────────────────────────────────

type FramesValue = Extract<RunnerValue, { kind: 'frames' }>

/** A clip's frames saved needs the run's media tools. */
export const SAVE_FRAMES_NEEDS_RUN = 'Saving a clip’s frames only works when the workflow runs.'

/** The clip's frames wired into `images`, or null. */
function framesWiredIn(ctx: PlanContext): FramesValue | null {
  const v = ctx.prompt[ctx.nodeId]!.inputs?.images
  if (!isLink(v)) return null
  const value = ctx.valueFrom?.(v)
  return value?.kind === 'frames' ? value : null
}

/** Fix round 1 (I2): saving every frame of a clip would write more than one run keeps here. */
export const SAVE_FRAMES_TOO_MUCH = 'Saving every frame of this clip would write more than one run can keep here'

/** The most bytes one saved frame of `ow` × `oh` can take: an 8-bit RGB PNG at most its raw bytes, a filter byte a row, and a margin. */
export const savedFrameBytesBound = (ow: number, oh: number) => Math.ceil(ow * oh * 3 * 1.01) + oh + 64 * 1024

/**
 * Fix round 1 (I2, ruling (q)): before the hold, what Save image and Preview
 * image would write saving every frame of a clip, against the run's kept room
 * (hosted: MEDIA_CAPS.hosted.keptBytesPerRun): frames × the frame size × the
 * scale (a wired scale at its most, 4; a wired largest side as none). `shapes`:
 * the clips' frame shapes (./video/shapes.ts frameShapes); one not known is
 * held at the place's caps. The first saver past it, or null.
 */
export function saveFramesStartProblem(
  prompt: ApiPrompt, families: ReadonlySet<RunnerFamily>, shapes: ReadonlyMap<string, FrameShape>, o: { hosted: boolean; clipAtCaps: () => FrameShape },
): { message: string; nodeId: string; classType: string } | null {
  const room = (o.hosted ? MEDIA_CAPS.hosted : MEDIA_CAPS.local).keptBytesPerRun
  if (!Number.isFinite(room)) return null
  const kinds = outputKindsFor(families)
  let total = 0
  for (const [nodeId, n] of Object.entries(prompt)) {
    if (n.class_type !== 'SaveImage' && n.class_type !== 'PreviewImage') continue
    const link = n.inputs?.images
    if (!isLink(link) || outputKind(prompt, link, kinds) !== 'frames') continue
    const s = shapes.get(`${link[0]}:${link[1]}`) ?? o.clipAtCaps()
    const inputs = n.inputs ?? {}
    const scale = n.class_type === 'PreviewImage' ? 1 : isLink(inputs.scale) ? 4 : floatOf(inputs.scale ?? 1)
    const maxDimension = n.class_type === 'PreviewImage' || isLink(inputs.max_dimension) ? 0 : intOf(inputs.max_dimension ?? 0, 'largest side')
    const out = saveSize(s.w, s.h, scale, maxDimension)
    total += s.count * savedFrameBytesBound(out.w, out.h)
    if (total > room) return { message: SAVE_FRAMES_TOO_MUCH, nodeId, classType: n.class_type }
  }
  return null
}

/** save_images over a clip's frames: one file per frame, decoded one at a time, sized from the first (they are all one size). */
function saveFrames(v: FramesValue, s: SaveSettings, o: { folder: 'output' | 'temp'; prefixAppend: string; now: Date }): NodePlan {
  return {
    kind: 'derive',
    async derive(io) {
      const media = io.media
      if (!media) throw new Error(SAVE_FRAMES_NEEDS_RUN)
      const text: [string, string][] = []
      if (s.embed) {
        text.push(['prompt', asciiJson(io.runPrompt)])
        if (io.runWorkflow != null) text.push(['workflow', asciiJson(io.runWorkflow)])
      }
      const out = saveSize(v.w, v.h, s.scale, s.maxDimension)
      if (out.w * out.h > CARD_MAX_PIXELS) throw new Error(SAVE_TOO_LARGE)
      const { subfolder, filename } = saveImagePrefix(s.prefix + o.prefixAppend, out.w, out.h, o.now)
      const images: OutputFile[] = []
      await mediaLease({ userId: media.userId, signal: io.signal }, async (lease) => {
        let i = 0
        for await (const rgb of framesOf(v, media, lease)) {
          if (io.signal.aborted) throw new Error('Stopped')
          const rgba = new Uint8Array(v.w * v.h * 4)
          for (let k = 0, j = 0; k < rgb.length; k += 3, j += 4) {
            rgba[j] = rgb[k]!
            rgba[j + 1] = rgb[k + 1]!
            rgba[j + 2] = rgb[k + 2]!
            rgba[j + 3] = 255
          }
          const p = await pixelsInWorker(io.signal, worker => worker.savePixels({ raw: true, source: 'rgb', w: v.w, h: v.h, data: rgba }, out.w, out.h, s.format === 'jpeg'))
          const bytes = await encode(p, s, text)
          const named = filename.replaceAll('%batch_num%', String(i))
          try {
            images.push(await io.saveAsset(bytes, {
              prefix: named, ext: EXT[s.format], subfolder, folder: o.folder,
              ...(named !== filename ? { counter: { prefix: filename, offset: i } } : {}),
            }))
          }
          catch (e) {
            if (e instanceof Error && (e.message === SAVE_OUTSIDE || e.message === 'The file store is not available')) throw e
            throw new Error(SAVE_FAILED)
          }
          i++
        }
      })
      return { values: {}, ui: { images: images.map(f => ({ filename: f.filename, subfolder: f.subfolder, type: f.type })) } }
    },
  }
}

// ── An SVG (R11.4) ───────────────────────────────────────────────────────────

/** The SVG wired into `images` (a Recraft SVG model's value), or null for pictures. */
function svgWiredIn(ctx: PlanContext): OutputFile | null {
  const v = ctx.prompt[ctx.nodeId]!.inputs?.images
  if (!isLink(v)) return null
  const value = ctx.valueFrom?.(v)
  return value?.kind === 'svg' ? value.file : null
}

/** A length attribute as a whole number of pixels (`512`, `512px`, `512.4`), or null for anything else (`100%`, `10cm`). */
function svgLength(raw: string | undefined): number | null {
  const m = raw ? /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/i.exec(raw) : null
  return m ? Math.max(0, Math.round(Number(m[1]))) : null
}

/**
 * An SVG's size for the name's `%width%` and `%height%`: its root's `width`
 * and `height` in pixels, else its `viewBox`'s, else 0 × 0.
 */
export function svgSize(bytes: Uint8Array): { w: number; h: number } {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 64 * 1024))
  const root = /<svg\b([^>]*)>/i.exec(text)?.[1] ?? ''
  const attr = (name: string) => new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(root)
  const value = (name: string) => { const m = attr(name); return m ? (m[1] ?? m[2]) : undefined }
  let w = svgLength(value('width'))
  let h = svgLength(value('height'))
  if (w === null || h === null) {
    const box = (value('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
    if (box.length === 4 && box.every(Number.isFinite)) {
      w ??= Math.max(0, Math.round(box[2]!))
      h ??= Math.max(0, Math.round(box[3]!))
    }
  }
  return { w: w ?? 0, h: h ?? 0 }
}

/** Writes the SVG as it came, named as save_images names a picture (one file, `%batch_num%` 0). */
function saveSvg(file: OutputFile, prefix: string, o: { folder: 'output' | 'temp'; prefixAppend: string; now: Date }): NodePlan {
  return {
    kind: 'derive',
    async derive(io) {
      const bytes = await io.read(file)
      const { w, h } = svgSize(bytes)
      const { subfolder, filename } = saveImagePrefix(prefix + o.prefixAppend, w, h, o.now)
      const named = filename.replaceAll('%batch_num%', '0')
      if (io.signal.aborted) throw new Error('Stopped')
      let saved: OutputFile
      try {
        saved = await io.saveAsset(bytes, {
          prefix: named, ext: 'svg', subfolder, folder: o.folder,
          ...(named !== filename ? { counter: { prefix: filename, offset: 0 } } : {}),
        })
      }
      catch (e) {
        if (e instanceof Error && (e.message === SAVE_OUTSIDE || e.message === 'The file store is not available')) throw e
        throw new Error(SAVE_FAILED)
      }
      return { values: {}, ui: { images: [{ filename: saved.filename, subfolder: saved.subfolder, type: saved.type }] } }
    },
  }
}

export function planSaveImage(ctx: PlanContext): NodePlan {
  const node = ctx.prompt[ctx.nodeId]!
  const svg = svgWiredIn(ctx)
  if (svg) return saveSvg(svg, pyStr(node.inputs?.filename_prefix ?? 'ComfyUI'), { folder: 'output', prefixAppend: '', now: new Date() })
  const settings = saveSettings(node.inputs ?? {})
  const frames = framesWiredIn(ctx)
  if (frames) return saveFrames(frames, settings, { folder: 'output', prefixAppend: '', now: new Date() })
  const batches = batchesOf(ctx)
  return {
    kind: 'derive',
    async derive(io) {
      await refuseAnimation(io, ctx.prompt, node.inputs?.images)
      return saveAll(io, batches, settings, { folder: 'output', prefixAppend: '', now: new Date() })
    },
  }
}

/** PreviewImage's letters: 'p' twice and no 'w', as nodes.py has them. */
const PREVIEW_LETTERS = 'abcdefghijklmnopqrstupvxyz'

/** Five of PreviewImage's letters, drawn at random (nodes.py PreviewImage; comfy_api's UI.PreviewImage alike). */
export function previewImageLetters(): string {
  return Array.from({ length: 5 }, () => PREVIEW_LETTERS[Math.floor(Math.random() * PREVIEW_LETTERS.length)]).join('')
}

export function planPreviewImage(ctx: PlanContext): NodePlan {
  const node = ctx.prompt[ctx.nodeId]!
  const letters = previewImageLetters()
  const svg = svgWiredIn(ctx)
  if (svg) return saveSvg(svg, 'ComfyUI', { folder: 'temp', prefixAppend: `_temp_${letters}`, now: new Date() })
  const settings: SaveSettings = { prefix: 'ComfyUI', format: 'png', quality: 90, lossless: false, compression: 1, scale: 1, maxDimension: 0, embed: true }
  const frames = framesWiredIn(ctx)
  if (frames) return saveFrames(frames, settings, { folder: 'temp', prefixAppend: `_temp_${letters}`, now: new Date() })
  const batches = batchesOf(ctx)
  return {
    kind: 'derive',
    async derive(io) {
      await refuseAnimation(io, ctx.prompt, node.inputs?.images)
      return saveAll(io, batches, settings, { folder: 'temp', prefixAppend: `_temp_${letters}`, now: new Date() })
    },
  }
}

// ── The Image card showing a kept picture ────────────────────────────────────

/**
 * An Image card fed a picture the runner made (kept bytes, which /view never
 * serves): it hands the files on as they are and shows a copy of each kept
 * one in temp, named by its bytes (`sailor_<sha256>.<ext>`), as Python's card
 * shows its picture from temp.
 */
export function imageCardShowingKept(files: OutputFile[]): NodePlan {
  return {
    kind: 'derive',
    async derive(io) {
      const shown = new Map<string, OutputFile>()
      for (const f of files) {
        if (f.type !== 'kept' || shown.has(keyOf(f))) continue
        shown.set(keyOf(f), await io.savePreviewAs(await io.read(f), { filename: `sailor_${f.filename}` }))
      }
      const images = files.map(f => shown.get(keyOf(f)) ?? f)
      // Slot 1 reads the files too, as a pass-through card's outputs always did.
      return { values: { 0: { kind: 'files', files }, 1: { kind: 'files', files } }, ui: { images } }
    },
  }
}
