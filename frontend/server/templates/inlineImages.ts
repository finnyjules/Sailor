/** Pre-fetch every http(s) image in a satori tree and inline it as a data
 * URI — BEFORE satori renders. Two reasons:
 *  1. satori's own remote-image loading fails SILENTLY (a 404/timeout just
 *     skips the image and yields a plausible-but-wrong PNG — batch exports
 *     shipped imageless outputs this way);
 *  2. inlining makes failures loud: a dead URL rejects the whole render so
 *     the caller (runBatch item, backend run) surfaces a retryable error.
 * `data:` URIs pass through untouched; non-http schemes are left as-is.
 *
 * Also the choke point for the photo-treatment SERVER BAKE (see
 * shared/template-grid/treatment.ts): translate.ts tags an `<img>` node's
 * props with `__treatment` when its kind ('duotone'/'grain') can't be
 * expressed as a satori CSS filter. This module bakes it into the actual
 * pixels with `sharp` right here, before the data URI is built — and always
 * strips the tag so satori never sees a prop it doesn't understand.
 */

import { createHash, randomUUID } from 'node:crypto'

import sharp from 'sharp'

import { bakeInProcess } from './renderProcess'

import type { TreatmentBakeTag } from '../../shared/template-grid/treatment'
import {
  LAYOUT_IMAGES_TOO_LARGE, LAYOUT_MAX_IMAGE_BYTES, LAYOUT_MAX_TREATED, LAYOUT_MAX_TREATED_AREA,
  LAYOUT_TOO_MANY_TREATED, LAYOUT_TREATED_TOO_LARGE, LAYOUT_TREATMENT_FAILED,
} from '../../shared/template-grid/limits'

interface TreeNode {
  type?: string
  props?: { src?: string; children?: unknown; __treatment?: TreatmentBakeTag }
}

function collectImgNodes(node: unknown, out: TreeNode[] = []): TreeNode[] {
  if (!node || typeof node !== 'object') return out
  const n = node as TreeNode
  if (n.type === 'img' && typeof n.props?.src === 'string') out.push(n)
  const kids = n.props?.children
  if (Array.isArray(kids)) kids.forEach(k => collectImgNodes(k, out))
  else if (kids && typeof kids === 'object') collectImgNodes(kids, out)
  return out
}

/** The bytes the render may still fetch (fix round 3): a fetcher that streams takes from it as bytes arrive. */
export interface ByteBudget { left: number }

export type ImageFetcher = (url: string, o?: { signal?: AbortSignal; budget?: ByteBudget }) => Promise<{ data: ArrayBuffer; contentType: string }>

/** A limit on the layout's pictures (their total size, how many are treated and how big): the route answers 400. */
export class ImageLimitError extends Error {}

export async function defaultImageFetcher(url: string): Promise<{ data: ArrayBuffer; contentType: string }> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`image fetch failed (${res.status}): ${url}`)
  return { data: await res.arrayBuffer(), contentType: res.headers.get('content-type') || 'image/png' }
}

/**
 * The photo-treatment bake, self-contained: it takes sharp as an argument and
 * refers to nothing outside itself, because its source text is what the
 * render process runs (./renderProcess.ts, R1.6 fix round 2), keeping the
 * per-pixel noise loop and the big buffers off the server's main thread and
 * out of its memory. Same code, same bytes.
 *
 * Bakes a treatment satori/resvg can't express as a CSS filter into the
 * actual image bytes. 'grayscale' never reaches here — it's a plain CSS
 * `filter` set directly in translate.ts (confirmed by the render-path GATE
 * probe). Always returns PNG bytes regardless of the source format.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function bakeTreatmentCore(sharp: any, data: ArrayBuffer, treatment: TreatmentBakeTag): Promise<ArrayBuffer> {
  const hexToRgb = (hex: string): { r: number; g: number; b: number } => {
    const clean = hex.replace('#', '').trim()
    const full = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean
    const n = Number.parseInt(full, 16) || 0
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
  }
  // Deterministic per-pixel noise (dims-seeded, not Math.random) — a re-render
  // of the SAME source image is stable rather than shimmering between runs.
  const makeNoiseTile = (w: number, h: number, alpha: number): Buffer => {
    const out = Buffer.alloc(w * h * 4)
    let seed = (w * 374761393 + h * 668265263) >>> 0
    const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
    const a = Math.round(255 * alpha)
    for (let i = 0; i < w * h; i++) {
      const v = Math.floor(next() * 255)
      out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = a
    }
    return out
  }

  const intensity = Math.max(0, Math.min(1, treatment.intensity))
  const input = Buffer.from(data)
  let out: Buffer

  if (treatment.kind === 'duotone') {
    const ink = hexToRgb(treatment.ink)
    // NOTE: don't pre-`.greyscale()` — sharp's `.tint()` already extracts
    // luminance and recolours from it; feeding it an already-greyscaled
    // (chroma-stripped) source makes the LAB colorize step a no-op and the
    // output stays flat gray (verified empirically against sharp 0.35).
    const duotoned = await sharp(input).tint(ink).png().toBuffer()
    out = intensity >= 0.999
      ? duotoned
      : await sharp(input)
          .composite([{ input: await sharp(duotoned).ensureAlpha(intensity).toBuffer(), blend: 'over' }])
          .png()
          .toBuffer()
  } else {
    const meta = await sharp(input).metadata()
    const w = meta.width ?? 1
    const h = meta.height ?? 1
    const noisePng = await sharp(makeNoiseTile(w, h, intensity), { raw: { width: w, height: h, channels: 4 } })
      .png()
      .toBuffer()
    out = await sharp(input).composite([{ input: noisePng, blend: 'overlay' }]).png().toBuffer()
  }
  // sharp's toBuffer() is typed as Node's Buffer, whose `.buffer` is
  // `ArrayBufferLike` (ArrayBuffer | SharedArrayBuffer) — this cast matches
  // the same slice-to-ArrayBuffer pattern used in render-template.post.ts.
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer
}

/** The bake, run in the render process (./renderProcess.ts). */
export async function bakeTreatment(data: ArrayBuffer, treatment: TreatmentBakeTag, signal?: AbortSignal): Promise<ArrayBuffer> {
  return bakeInProcess(data, treatment, signal)
}

export interface InlineOptions {
  /** Stops the fetches and the bakes (the render's Stop, disconnect or deadline). */
  signal?: AbortSignal
  /** The most picture bytes per render (LAYOUT_MAX_IMAGE_BYTES): fetched, and shown (bytes × uses). */
  maxBytes?: number
}

/**
 * Each distinct picture of a render, once (fix round 4), keyed by the
 * placeholder its img nodes carry (`sailor-image:<render nonce>:<sha-256>`):
 * fetched (or baked) bytes, or a `data:` URI the layout already held. The
 * render process builds each data URI once and puts it in the nodes
 * (substituteImagesCore), so the tree sent to it never holds a picture more
 * than once, however many elements show it.
 */
export type ImageTable = Record<string, { contentType: string; data: Uint8Array } | { uri: string }>

/**
 * Puts each picture of `images` into the img nodes whose src is its key, as
 * a data URI built once per picture. Self-contained (it refers to nothing
 * outside itself) because its source text runs in the render process too.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function substituteImagesCore(tree: any, images: any): void {
  const uris = new Map<string, string>()
  const uriOf = (key: string): string | undefined => {
    let u = uris.get(key)
    if (u !== undefined) return u
    const e = images[key]
    if (!e) return undefined
    const made: string = typeof e.uri === 'string' ? e.uri : `data:${e.contentType};base64,${Buffer.from(e.data.buffer, e.data.byteOffset, e.data.byteLength).toString('base64')}`
    uris.set(key, made)
    return made
  }
  const stack = [tree]
  while (stack.length) {
    const n = stack.pop()
    if (!n || typeof n !== 'object') continue
    const p = n.props
    if (!p || typeof p !== 'object') continue
    if (n.type === 'img' && typeof p.src === 'string' && Object.prototype.hasOwnProperty.call(images, p.src)) {
      const u = uriOf(p.src)
      if (u !== undefined) p.src = u
    }
    const kids = p.children
    if (Array.isArray(kids)) for (const k of kids) stack.push(k)
    else if (kids && typeof kids === 'object') stack.push(kids)
  }
}

/** Mutates the tree in place: every http(s) img src becomes a data URI, with
 *  any tagged photo treatment baked in first (see tableTreeImages). Kept for
 *  callers that render in this process; the route and runner send the table
 *  to the render process instead. */
export async function inlineTreeImages(tree: unknown, fetcher: ImageFetcher = defaultImageFetcher, opts: InlineOptions = {}): Promise<void> {
  const images = await tableTreeImages(tree, fetcher, opts)
  substituteImagesCore(tree, images)
}

/** Every http(s) or data: picture of the tree into a table, each img node's
 *  src swapped for its picture's key; any tagged photo treatment
 *  ('duotone'/'grain') baked into the bytes first. Duplicate URLs are
 *  fetched once, each distinct (URL, treatment) is baked once, and equal
 *  bytes share one entry. Throws on the first failed fetch (a dead URL
 *  should fail the render loudly), leaving every src as it was.
 *  `__treatment` is always stripped, whether or not it was applied.
 *
 *  Fix round 3: at most LAYOUT_MAX_TREATED distinct treated pictures, each
 *  at most LAYOUT_MAX_TREATED_AREA pixels (read from its header here, before
 *  the bake is queued), and at most `maxBytes` fetched in all; each refused
 *  plainly (ImageLimitError). A bake that fails fails the render: the
 *  picture is never shown untreated in its place. The signal stops fetches
 *  and bakes.
 *  Fix round 4: the pictures as shown count too — each distinct picture's
 *  final bytes (baked ones included) times the elements showing it, at most
 *  `maxBytes` in all. */
export async function tableTreeImages(tree: unknown, fetcher: ImageFetcher = defaultImageFetcher, opts: InlineOptions = {}): Promise<ImageTable> {
  const imgs = collectImgNodes(tree)
  const maxBytes = opts.maxBytes ?? LAYOUT_MAX_IMAGE_BYTES
  const nonce = randomUUID()
  const keyOf = (src: string, t: TreatmentBakeTag | undefined) => `${src}\u0000${t ? JSON.stringify(t) : ''}`
  const treated = new Set(imgs.filter(n => n.props?.__treatment && /^https?:\/\//.test(n.props.src!)).map(n => keyOf(n.props!.src!, n.props!.__treatment)))
  if (treated.size > LAYOUT_MAX_TREATED) {
    for (const n of imgs) if (n.props && '__treatment' in n.props) delete n.props.__treatment
    throw new ImageLimitError(LAYOUT_TOO_MANY_TREATED)
  }
  const budget: ByteBudget = { left: maxBytes }
  let fetchedBytes = 0
  const fetched = new Map<string, Promise<{ data: ArrayBuffer; contentType: string }>>()
  const fetchOnce = (src: string) => {
    let pending = fetched.get(src)
    if (!pending) {
      pending = fetcher(src, { signal: opts.signal, budget }).then((got) => {
        fetchedBytes += got.data.byteLength
        if (fetchedBytes > maxBytes) throw new ImageLimitError(LAYOUT_IMAGES_TOO_LARGE)
        return got
      }, (e: unknown) => {
        if ((e as Error)?.message === LAYOUT_IMAGES_TOO_LARGE) throw new ImageLimitError(LAYOUT_IMAGES_TOO_LARGE)
        throw e
      })
      fetched.set(src, pending)
    }
    return pending
  }
  interface Entry { key: string; size: number; value: ImageTable[string] }
  const entries = new Map<string, Promise<Entry>>()
  const entryFor = (src: string, treatment: TreatmentBakeTag | undefined): Promise<Entry> => {
    const k = keyOf(src, treatment)
    let e = entries.get(k)
    if (e) return e
    e = (async (): Promise<Entry> => {
      if (/^data:/i.test(src)) {
        // A picture the layout carries itself: one copy, its decoded size counted.
        return { key: `sailor-image:${nonce}:${createHash('sha256').update(src).digest('hex')}`, size: Math.floor(src.length * 3 / 4), value: { uri: src } }
      }
      let { data, contentType } = await fetchOnce(src)
      if (treatment) {
        let area = 0
        try {
          const meta = await sharp(Buffer.from(data), { limitInputPixels: false }).metadata()
          area = (meta.width ?? 0) * (meta.height ?? 0)
        }
        catch { throw new Error(LAYOUT_TREATMENT_FAILED) }
        if (!area) throw new Error(LAYOUT_TREATMENT_FAILED)
        if (area > LAYOUT_MAX_TREATED_AREA) throw new ImageLimitError(LAYOUT_TREATED_TOO_LARGE)
        try {
          data = await bakeTreatment(data, treatment, opts.signal)
        }
        catch (err) {
          if (opts.signal?.aborted) throw err
          console.warn(`[inlineImages] treatment bake failed (kind=${treatment.kind}, src=${src.slice(0, 200)})`, err)
          throw new Error(LAYOUT_TREATMENT_FAILED)
        }
        contentType = 'image/png'
      }
      const bytes = new Uint8Array(data)
      const hash = createHash('sha256').update(contentType).update('\u0000').update(bytes).digest('hex')
      return { key: `sailor-image:${nonce}:${hash}`, size: bytes.byteLength, value: { contentType, data: bytes } }
    })()
    entries.set(k, e)
    return e
  }
  const shown: { n: TreeNode; entry: Promise<Entry> }[] = []
  for (const n of imgs) {
    const treatment = n.props?.__treatment
    if (n.props && '__treatment' in n.props) delete n.props.__treatment
    const src = n.props!.src!
    if (!/^https?:\/\//.test(src) && !/^data:/i.test(src)) continue
    shown.push({ n, entry: entryFor(src, treatment) })
  }
  const got = await Promise.all(shown.map(s => s.entry))
  // What the render holds: each picture's bytes once per element showing it.
  let total = 0
  for (const e of got) total += e.size
  if (total > maxBytes) throw new ImageLimitError(LAYOUT_IMAGES_TOO_LARGE)
  const table: ImageTable = {}
  got.forEach((e, i) => {
    table[e.key] = e.value
    shown[i]!.n.props!.src = e.key
  })
  return table
}
