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

import { bakeInProcess } from './renderProcess'

import type { TreatmentBakeTag } from '../../shared/template-grid/treatment'

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

export type ImageFetcher = (url: string) => Promise<{ data: ArrayBuffer; contentType: string }>

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
export async function bakeTreatment(data: ArrayBuffer, treatment: TreatmentBakeTag): Promise<ArrayBuffer> {
  return bakeInProcess(data, treatment)
}

/** Mutates the tree in place: every http(s) img src becomes a data URI, with
 *  any tagged photo treatment ('duotone'/'grain') baked into the bytes first.
 *  Duplicate URLs are fetched once, and each distinct (URL, treatment) is
 *  baked once and inlined as one shared string (R1.6 fix round 2: a layout
 *  repeating a treated picture no longer bakes it per element). Throws on the
 *  first failed fetch (a dead URL should fail the render loudly). Treatment
 *  is cosmetic and opt-in, so a bake failure (corrupt/unsupported source
 *  image, e.g. a CMYK JPEG sharp can't decode) does NOT fail the render — it
 *  falls back to the untreated fetched image and logs a warning instead.
 *  `__treatment` is always stripped, whether or not it was applied. */
export async function inlineTreeImages(tree: unknown, fetcher: ImageFetcher = defaultImageFetcher): Promise<void> {
  const imgs = collectImgNodes(tree)
  const fetched = new Map<string, Promise<{ data: ArrayBuffer; contentType: string }>>()
  const inlined = new Map<string, Promise<string>>()
  await Promise.all(imgs.map(async (n) => {
    const treatment = n.props?.__treatment
    if (n.props && '__treatment' in n.props) delete n.props.__treatment
    const src = n.props!.src!
    if (!/^https?:\/\//.test(src)) return
    const key = `${src}\u0000${treatment ? JSON.stringify(treatment) : ''}`
    let uri = inlined.get(key)
    if (!uri) {
      uri = (async () => {
        let pending = fetched.get(src)
        if (!pending) { pending = fetcher(src); fetched.set(src, pending) }
        let { data, contentType } = await pending
        if (treatment) {
          try {
            data = await bakeTreatment(data, treatment)
            contentType = 'image/png'
          } catch (err) {
            console.warn(`[inlineImages] treatment bake failed (kind=${treatment.kind}, src=${src.slice(0, 200)}) — falling back to untreated image`, err)
          }
        }
        return `data:${contentType};base64,${Buffer.from(data).toString('base64')}`
      })()
      inlined.set(key, uri)
    }
    n.props!.src = await uri
  }))
}
