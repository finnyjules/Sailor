/**
 * The measured size of the picture each size-priced node is sent (Upscale,
 * Enhance detail, FLUX.2 edit), for the hosted /prompt gate's price (P4 fix
 * round 1). The price reads it through priceGraph's `inputPixels`; a node
 * this cannot measure is priced at the input cap (editSettings.ts).
 *
 * The picture link is followed to its source:
 *  - a loaded file (LoadImage, or an Image card holding a file): its header
 *    is read with sharp. The gate has already checked the caller owns every
 *    file the graph names (validateGraphFileRefs), before pricing;
 *  - an upstream GenerateImageNode: the largest picture its settings make
 *    (sourceOutputPixels, the same function the canvas badge reads);
 *  - an Image card whose picture is itself a link: followed on;
 *  - anything else: not measured (the cap).
 */
import sharp from 'sharp'
import { annotatedFilepath, engineFolder, resolveInside } from '../native/paths'
import { sizePricedInput, sourceOutputPixels } from '../../shared/pricing/editSettings'

type Prompt = Record<string, { class_type?: unknown; inputs?: unknown } | undefined>

const MAX_HOPS = 8

/** Pixels of a picture file (its header only), or null when it can't be read. */
export async function picturePixels(file: string | Uint8Array): Promise<number | null> {
  try {
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
      if ((sct === 'LoadImage' || sct === 'Image') && typeof si.image === 'string' && si.image) px = await readFile(si.image)
      else if (typeof sct === 'string') px = sourceOutputPixels(sct, si)
      break
    }
    if (px != null && px > 0) out[id] = px
  }
  return out
}
