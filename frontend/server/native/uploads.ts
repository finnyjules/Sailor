/**
 * POST /upload/image and POST /upload/mask, served by Sailor instead of
 * ComfyUI — a port of `image_upload`, `upload_image` and `upload_mask` in
 * server.py.
 *
 * Form fields: `image` (the file), `type` (input | temp | output, default
 * input), `subfolder`, `overwrite` ("true" or "1"), and for a mask
 * `original_ref` (JSON `{filename, type, subfolder}`).
 * Response: `{ name, subfolder, type }` — `name` is the name actually stored.
 *
 * Without overwrite, a name that is taken becomes `name (1).ext`,
 * `name (2).ext`, … — unless the file already there has the same bytes, in
 * which case nothing is written and that name is answered (ComfyUI #3465).
 *
 * A mask upload writes the ORIGINAL image with its alpha channel replaced by
 * the mask's alpha (PIL: `original.convert('RGBA').putalpha(mask.convert(
 * 'RGBA').getchannel('A'))`), saved as PNG with the original's text chunks
 * and ICC profile. When the original can't be found the Python quietly wrote
 * nothing and still answered 200 with the name; so does this.
 *
 * Differences from the Python, on purpose:
 * - `type`, `subfolder` are trimmed (the hosted ownership gate reads them
 *   trimmed, and the file written must be the file it checked).
 * - an unknown `type` is a 400 (the Python crashed with a 500).
 * - a `subfolder` that leaves the folder is refused even when the filename
 *   walks back in (the Python created the outside folder first).
 * - an empty file part is a 400 (the Python wrote an empty file).
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import sharp from 'sharp'
import type { UploadForm } from '../utils/multipart'
import { annotatedFilepath, engineFolder, resolveInside } from './paths'

export const UPLOAD_PREFIXES = ['/upload/image', '/upload/mask']

export type UploadKind = 'image' | 'mask'

export type UploadMatch =
  | { kind: 'route', upload: UploadKind }
  | { kind: 'notFound' }
  | { kind: 'badMethod' }

/** The two aiohttp routes; both are POST only. */
export function matchUploadRoute(p: string, method: string): UploadMatch {
  const upload: UploadKind | null = p === '/upload/image' ? 'image' : p === '/upload/mask' ? 'mask' : null
  if (!upload) return { kind: 'notFound' }
  return method === 'POST' ? { kind: 'route', upload } : { kind: 'badMethod' }
}

export interface UploadResult {
  status: number
  body: unknown
  /** A plain-text (here: empty) body, as aiohttp's bare `web.Response(status=400)`. */
  text?: boolean
}

type Folders = Record<'input' | 'output' | 'temp', string>

/** The three engine folders, or null when the engine root can't be found. */
export function uploadFolders(): Folders | null {
  const input = engineFolder('input')
  const output = engineFolder('output')
  const temp = engineFolder('temp')
  return input && output && temp ? { input, output, temp } : null
}

const BAD_REQUEST: UploadResult = { status: 400, body: '', text: true }

/** aiohttp `post.get(name)`: the first text part under exactly that name. */
function firstText(form: UploadForm, name: string): string | undefined {
  return form.textEntries().find(([n]) => n === name)?.[1]
}

/** `os.path.splitext`: a leading run of dots is part of the name, not an extension. */
export function pySplitext(p: string): [string, string] {
  const sep = p.lastIndexOf('/')
  const dot = p.lastIndexOf('.')
  if (dot > sep) {
    for (let i = sep + 1; i < dot; i++) {
      if (p[i] !== '.') return [p.slice(0, dot), p.slice(dot)]
    }
  }
  return [p, '']
}

/** `os.path.exists`: follows symlinks; any error is False. */
function pyExists(p: string): boolean {
  try { return fs.statSync(p, { throwIfNoEntry: false }) !== undefined }
  catch { return false }
}

/** `compare_image_hash`: does the file already at `p` hold exactly these bytes? */
function sameBytes(p: string, data: Buffer): boolean {
  return pyExists(p) && fs.readFileSync(p).equals(data)
}

/**
 * The upload itself (`image_upload`). Throws on the failures the Python
 * turned into a 500 (a bad `original_ref`, an unreadable image); the router
 * answers those the way aiohttp did.
 */
export async function runUpload(kind: UploadKind, form: UploadForm, folders: Folders): Promise<UploadResult> {
  const image = await form.file('image')
  if (!image) return BAD_REQUEST

  const typeRaw = firstText(form, 'type')
  const type = typeRaw === undefined ? 'input' : typeRaw.trim()
  if (type !== 'input' && type !== 'output' && type !== 'temp') return BAD_REQUEST
  const uploadDir = folders[type]

  let filename = image.filename || ''
  if (!filename) return BAD_REQUEST

  const subfolder = form.text('subfolder')
  const fullOutputFolder = resolveInside(uploadDir, subfolder)
  let filepath = resolveInside(uploadDir, subfolder, filename)
  if (!fullOutputFolder || !filepath) return BAD_REQUEST

  fs.mkdirSync(fullOutputFolder, { recursive: true })

  const overwrite = firstText(form, 'overwrite')
  let duplicate = false
  if (overwrite !== 'true' && overwrite !== '1') {
    const [stem, ext] = pySplitext(filename)
    for (let i = 1; pyExists(filepath); i++) {
      if (sameBytes(filepath, image.data)) {
        duplicate = true
        break
      }
      filename = `${stem} (${i})${ext}`
      filepath = path.join(fullOutputFolder, filename)
    }
  }

  if (!duplicate) {
    if (kind === 'mask') await saveMaskedOriginal(form, image.data, filepath, folders)
    else fs.writeFileSync(filepath, image.data)
  }
  return { status: 200, body: { name: filename, subfolder, type } }
}

// ----------------------------------------------------------------- the mask

/**
 * `upload_mask`'s `image_save_function`: find the original named by
 * `original_ref` with /view's own checks, and write it to `dest` with the
 * mask's alpha. A ref that fails a check writes nothing (the Python returned a
 * 400/403 from inside the save function, which image_upload ignored).
 */
async function saveMaskedOriginal(form: UploadForm, mask: Buffer, dest: string, folders: Folders): Promise<void> {
  const refRaw = firstText(form, 'original_ref')
  if (refRaw === undefined) throw new Error('original_ref is missing')
  const ref = JSON.parse(refRaw) as Record<string, unknown>
  if (!ref || typeof ref !== 'object' || typeof ref.filename !== 'string') throw new Error('original_ref.filename must be a string')

  const { name, type: annotated } = annotatedFilepath(ref.filename)
  if (!name) return
  if (name[0] === '/' || name.includes('..')) return

  const refType = annotated ?? ('type' in ref ? ref.type : 'output')
  let dir: string | null = refType === 'input' || refType === 'output' || refType === 'temp' ? folders[refType] : null
  if (!dir) return

  const sub = 'subfolder' in ref ? ref.subfolder : ''
  if (sub !== '') {
    if (typeof sub !== 'string') throw new Error('original_ref.subfolder must be a string')
    const inside = resolveInside(dir, sub)
    if (!inside) return
    dir = inside
  }

  const file = path.join(dir, name)
  let isFile = false
  try { isFile = fs.statSync(file).isFile() }
  catch { isFile = false }
  if (!isFile) return

  fs.writeFileSync(dest, await maskOriginal(fs.readFileSync(file), mask))
}

/** Decode to 8-bit RGBA the way PIL's `convert('RGBA')` sees the pixels: no ICC transform, no EXIF rotation. */
async function rgba(bytes: Buffer): Promise<{ data: Buffer, width: number, height: number }> {
  const { data, info } = await sharp(bytes, { ignoreIcc: true })
    .toColourspace('srgb')
    .ensureAlpha()
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true })
  if (info.channels !== 4) throw new Error(`expected 4 channels, got ${info.channels}`)
  return { data, width: info.width, height: info.height }
}

/**
 * The original's pixels with the mask's alpha, as a PNG carrying the
 * original's ICC profile and text chunks (PIL writes both from the copied
 * `info` / `pnginfo`). Sizes must match — PIL's putalpha raised otherwise.
 */
export async function maskOriginal(original: Buffer, mask: Buffer): Promise<Buffer> {
  const o = await rgba(original)
  const m = await rgba(mask)
  if (o.width !== m.width || o.height !== m.height) throw new Error('images do not match')
  for (let i = 3; i < o.data.length; i += 4) o.data[i] = m.data[i]!

  const encoded = await sharp(o.data, { raw: { width: o.width, height: o.height, channels: 4 } })
    .png({ compressionLevel: 4 })
    .toBuffer()

  const extra: Buffer[] = []
  const icc = (await sharp(original).metadata()).icc
  if (icc) extra.push(pngChunk('iCCP', Buffer.concat([Buffer.from('ICC Profile\0\0', 'latin1'), zlib.deflateSync(icc)])))
  if (isPng(original)) {
    for (const [key, value] of pngText(original)) extra.push(textChunk(key, value))
  }
  return rebuildPng(encoded, extra)
}

// ------------------------------------------------------------ PNG chunks

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])

function isPng(b: Buffer): boolean {
  return b.length >= 8 && b.subarray(0, 8).equals(PNG_SIGNATURE)
}

function* chunks(png: Buffer): Generator<{ type: string, data: Buffer }> {
  let off = 8
  while (off + 8 <= png.length) {
    const len = png.readUInt32BE(off)
    const type = png.toString('latin1', off + 4, off + 8)
    if (off + 12 + len > png.length) return
    yield { type, data: png.subarray(off + 8, off + 8 + len) }
    off += 12 + len
    if (type === 'IEND') return
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xFFFFFFFF
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF]! ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** An iTXt value keeps its language tag and translated keyword, as PIL's `iTXt` str does. */
interface ITxt { text: string, lang: string, tkey: string }
type TextValue = string | ITxt

/**
 * PIL's `PngImageFile.text`: every tEXt / zTXt / iTXt chunk, keyed by keyword
 * (a later chunk replaces an earlier value but keeps its place).
 */
export function pngText(png: Buffer): Map<string, TextValue> {
  const out = new Map<string, TextValue>()
  for (const { type, data } of chunks(png)) {
    try {
      if (type === 'tEXt') {
        const z = data.indexOf(0)
        const k = z === -1 ? data : data.subarray(0, z)
        const v = z === -1 ? Buffer.alloc(0) : data.subarray(z + 1)
        out.set(k.toString('latin1'), v.toString('latin1'))
      }
      else if (type === 'zTXt') {
        const z = data.indexOf(0)
        if (z === -1) continue
        const method = data[z + 1] ?? 0
        if (method !== 0) continue
        out.set(data.subarray(0, z).toString('latin1'), zlib.inflateSync(data.subarray(z + 2)).toString('latin1'))
      }
      else if (type === 'iTXt') {
        const z = data.indexOf(0)
        if (z === -1) continue
        const k = data.subarray(0, z).toString('latin1')
        const flag = data[z + 1]
        const method = data[z + 2]
        const rest = data.subarray(z + 3)
        const z1 = rest.indexOf(0)
        const z2 = z1 === -1 ? -1 : rest.indexOf(0, z1 + 1)
        if (z2 === -1) continue
        let v = rest.subarray(z2 + 1)
        if (flag) {
          if (method !== 0) continue
          v = zlib.inflateSync(v)
        }
        out.set(k, {
          text: new TextDecoder('utf-8', { fatal: true }).decode(v),
          lang: new TextDecoder('utf-8', { fatal: true }).decode(rest.subarray(0, z1)),
          tkey: new TextDecoder('utf-8', { fatal: true }).decode(rest.subarray(z1 + 1, z2)),
        })
      }
    }
    catch { /* PIL skips a chunk it can't decode */ }
  }
  return out
}

/** `PngInfo.add_text(key, value)`: tEXt when the value is latin-1, iTXt otherwise (or when it was iTXt). */
function textChunk(key: string, value: TextValue): Buffer {
  const k = Buffer.from(key, 'latin1')
  if (typeof value === 'string' && /^[\u0000-ÿ]*$/.test(value)) {
    return pngChunk('tEXt', Buffer.concat([k, Buffer.from([0]), Buffer.from(value, 'latin1')]))
  }
  const v = typeof value === 'string' ? { text: value, lang: '', tkey: '' } : value
  return pngChunk('iTXt', Buffer.concat([
    k, Buffer.from([0, 0, 0]),
    Buffer.from(v.lang, 'utf8'), Buffer.from([0]),
    Buffer.from(v.tkey, 'utf8'), Buffer.from([0]),
    Buffer.from(v.text, 'utf8'),
  ]))
}

/** Keep only IHDR / IDAT / IEND from sharp's PNG and put `extra` straight after IHDR, where PIL writes them. */
function rebuildPng(encoded: Buffer, extra: Buffer[]): Buffer {
  const parts: Buffer[] = [PNG_SIGNATURE]
  for (const { type, data } of chunks(encoded)) {
    if (type === 'IHDR') parts.push(pngChunk(type, data), ...extra)
    else if (type === 'IDAT' || type === 'IEND') parts.push(pngChunk(type, data))
  }
  return Buffer.concat(parts)
}
