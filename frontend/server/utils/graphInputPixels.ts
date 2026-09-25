/**
 * The measured size of the picture each size-priced node is sent (Upscale,
 * Enhance detail, FLUX.2 edit), for the hosted /prompt gate's price (P4 fix
 * round 1). The price reads it through priceGraph's `inputPixels`; a node
 * this cannot measure is priced at the input cap (editSettings.ts).
 *
 * The picture link is followed to its source:
 *  - a loaded file (LoadImage, or an Image card holding a file): its header
 *    is read with sharp — PNG, JPEG and WebP only (sniffed from the first
 *    bytes), each file value once, at most MAX_MEASURED_FILES per prompt. The gate has already checked the caller owns every
 *    file the graph names (validateGraphFileRefs), before pricing;
 *  - an upstream GenerateImageNode: the largest picture its settings make
 *    (sourceOutputPixels, the same function the canvas badge reads);
 *  - an Image card whose picture is itself a link: followed on;
 *  - anything else: not measured (the cap).
 */
import { open } from 'node:fs/promises'
import sharp from 'sharp'
import { annotatedFilepath, engineFolder, resolveInside } from '../native/paths'
import { sizePricedInput, sourceOutputPixels } from '../../shared/pricing/editSettings'

type Prompt = Record<string, { class_type?: unknown; inputs?: unknown } | undefined>

const MAX_HOPS = 8

/**
 * At most this many files are read per /prompt; any further size-priced
 * picture is priced at the cap. Each file value is read once (memoised).
 */
export const MAX_MEASURED_FILES = 8

/** The raster formats measured, by their first bytes: PNG, JPEG, WebP. Anything else prices at the cap. */
export function isMeasurableRaster(head: Uint8Array): boolean {
  const b = (i: number) => head[i]
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4E && b(3) === 0x47) return true // \x89PNG
  if (b(0) === 0xFF && b(1) === 0xD8 && b(2) === 0xFF) return true // JPEG SOI
  const ascii = (from: number, to: number) => String.fromCharCode(...head.subarray(from, to))
  return head.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP'
}

/** Pixels of a PNG/JPEG/WebP picture (its header only), or null when it is anything else or can't be read. */
export async function picturePixels(file: string | Uint8Array): Promise<number | null> {
  try {
    let head: Uint8Array
    if (typeof file === 'string') {
      const fh = await open(file, 'r')
      try { head = new Uint8Array(16); await fh.read(head, 0, 16, 0) }
      finally { await fh.close() }
    }
    else head = file.subarray(0, 16)
    if (!isMeasurableRaster(head)) return null
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

const inputsOf = (n: { inputs?: unknown } | undefined): Record<string, unknown> =>
  (n?.inputs && typeof n.inputs === 'object' && !Array.isArray(n.inputs) ? n.inputs as Record<string, unknown> : {})

/** Node id → measured input pixels, for every size-priced node whose picture this can see. */
export async function graphInputPixels(
  prompt: Prompt,
  readFile: (value: string) => Promise<number | null> = engineFilePixels,
): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  if (!prompt || typeof prompt !== 'object') return out
  // One read per file value, and at most MAX_MEASURED_FILES reads per prompt.
  const seen = new Map<string, Promise<number | null>>()
  const measure = (value: string): Promise<number | null> => {
    const hit = seen.get(value)
    if (hit) return hit
    if (seen.size >= MAX_MEASURED_FILES) return Promise.resolve(null)
    const p = readFile(value).catch(() => null)
    seen.set(value, p)
    return p
  }
  for (const [id, node] of Object.entries(prompt)) {
    const ct = node?.class_type
    if (typeof ct !== 'string') continue
    const name = sizePricedInput(ct, inputsOf(node))
    if (!name) continue
    let link = inputsOf(node)[name]
    let px: number | null = null
    for (let hop = 0; hop < MAX_HOPS && Array.isArray(link); hop++) {
      const src = prompt[String(link[0])]
      const sct = src?.class_type
      const si = inputsOf(src)
      if (sct === 'Image' && Array.isArray(si.images)) { link = si.images; continue }
      if ((sct === 'LoadImage' || sct === 'Image') && typeof si.image === 'string' && si.image) px = await measure(si.image)
      else if (typeof sct === 'string') px = sourceOutputPixels(sct, si)
      break
    }
    if (px != null && px > 0) out[id] = px
  }
  return out
}
