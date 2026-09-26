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
  /** The most bytes fetched in all (LAYOUT_MAX_IMAGE_BYTES). */
  maxBytes?: number
}

/** Mutates the tree in place: every http(s) img src becomes a data URI, with
 *  any tagged photo treatment ('duotone'/'grain') baked into the bytes first.
 *  Duplicate URLs are fetched once, and each distinct (URL, treatment) is
 *  baked once and inlined as one shared string. Throws on the first failed
 *  fetch (a dead URL should fail the render loudly). `__treatment` is always
 *  stripped, whether or not it was applied.
 *
 *  Fix round 3: at most LAYOUT_MAX_TREATED distinct treated pictures, each
 *  at most LAYOUT_MAX_TREATED_AREA pixels (read from its header here, before
 *  the bake is queued), and at most `maxBytes` fetched in all; each refused
 *  plainly (ImageLimitError). A bake that fails fails the render: the
 *  picture is never shown untreated in its place. The signal stops fetches
 *  and bakes. */
export async function inlineTreeImages(tree: unknown, fetcher: ImageFetcher = defaultImageFetcher, opts: InlineOptions = {}): Promise<void> {
  const imgs = collectImgNodes(tree)
  const maxBytes = opts.maxBytes ?? LAYOUT_MAX_IMAGE_BYTES
  const keyOf = (src: string, t: TreatmentBakeTag | undefined) => `${src}\u0000${t ? JSON.stringify(t) : ''}`
  const treated = new Set(imgs.filter(n => n.props?.__treatment && /^https?:\/\//.test(n.props.src!)).map(n => keyOf(n.props!.src!, n.props!.__treatment)))
  if (treated.size > LAYOUT_MAX_TREATED) {
    for (const n of imgs) if (n.props && '__treatment' in n.props) delete n.props.__treatment
    throw new ImageLimitError(LAYOUT_TOO_MANY_TREATED)
  }
  const budget: ByteBudget = { left: maxBytes }
  let fetchedBytes = 0
  const fetched = new Map<string, Promise<{ data: ArrayBuffer; contentType: string }>>()
  const inlined = new Map<string, Promise<string>>()
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
  await Promise.all(imgs.map(async (n) => {
    const treatment = n.props?.__treatment
    if (n.props && '__treatment' in n.props) delete n.props.__treatment
    const src = n.props!.src!
    if (!/^https?:\/\//.test(src)) return
    const key = keyOf(src, treatment)
    let uri = inlined.get(key)
    if (!uri) {
      uri = (async () => {
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
        return `data:${contentType};base64,${Buffer.from(data).toString('base64')}`
      })()
      inlined.set(key, uri)
    }
    n.props!.src = await uri
  }))
}
