/** The product's shader-generation request (spec §7.2, decided 2026-09-24):
 *  three takes, the user's picture, two fixed quality examples (loop-correct
 *  since 2026-09-26, `productExamples.ts`), where the take will live, no revise
 *  and (by the caller) no visual review. */
import type { GenParam } from '~~/shared/shadergen/contract'
import { SHADER_GEN_TAKES } from '~~/shared/shadergen/model'
import type { EffectDef } from '~/lib/shaderfx/types'
import type { EngineInput } from './engine'
import type { GenBase, GenPlace, GenRequest, GenTarget } from './prompt'

export const PRODUCT_IMAGE_EDGE = 512
const CONTRACT_TYPES = new Set(['float', 'enum', 'color'])

/** A JPEG data URL of the picture, long edge ≤ 512 px; null when there is none. */
export function imageForModel(src: CanvasImageSource | null): string | null {
  if (!src) return null
  const w = (src as any).naturalWidth ?? (src as any).videoWidth ?? (src as any).width
  const h = (src as any).naturalHeight ?? (src as any).videoHeight ?? (src as any).height
  if (!w || !h) return null
  const k = Math.min(1, PRODUCT_IMAGE_EDGE / Math.max(w, h))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k))
  const ctx = c.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(src, 0, 0, c.width, c.height)
  try { return c.toDataURL('image/jpeg', 0.85) } catch { return null } // a tainted canvas
}

let placeholder: HTMLCanvasElement | null = null
/** A soft neutral gradient to judge takes on when the target has no picture. */
export function placeholderSource(): HTMLCanvasElement {
  if (placeholder) return placeholder
  const c = document.createElement('canvas'); c.width = 256; c.height = 256
  const ctx = c.getContext('2d')
  if (ctx) {
    const g = ctx.createLinearGradient(0, 0, 256, 256)
    g.addColorStop(0, '#3a4a5c'); g.addColorStop(0.5, '#c9a27a'); g.addColorStop(1, '#1f2a36')
    ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 256)
  }
  return (placeholder = c)
}

/** The base a take starts from. A My effect also brings the request that first made it (its v1
 *  note, the quoted request its Recipe shows) and the effect it was made from. */
export function baseFromEffect(def: EffectDef | null): GenBase | null {
  if (!def || (def as any).draft) return null
  const base: GenBase = { name: def.name, source: def.source, params: def.params.filter(p => CONTRACT_TYPES.has(p.type)) as unknown as GenParam[] }
  const request = def.mine ? def.versions?.[0]?.note?.trim() : ''
  if (request) base.request = request
  if (def.mine && def.from) base.from = def.from
  return base
}

/** Lazily loaded, like the spike fixture before it: the bodies stay out of the main bundle. */
export async function productExamples(): Promise<NonNullable<GenRequest['examples']>> {
  const { PRODUCT_EXAMPLES } = await import('./productExamples')
  return PRODUCT_EXAMPLES.map(e => ({ ...e }))
}

const PLACES = new Set<string>(['shader-studio', 'frame-background'])
/** Where takes for an EffectTarget (by its key) will live, and the aspect of its picture. */
export function targetContext(key: string, picture: CanvasImageSource | null): GenTarget {
  const place: GenPlace = PLACES.has(key) ? key as GenPlace : 'canvas-node'
  const w = picture ? Number((picture as any).naturalWidth || (picture as any).videoWidth || (picture as any).width) : 0
  const h = picture ? Number((picture as any).naturalHeight || (picture as any).videoHeight || (picture as any).height) : 0
  return w > 0 && h > 0 ? { place, aspect: w / h } : { place }
}

/** `image` null: the target has no picture, so the prompt asks for a standalone (generative)
 *  effect — takes are still judged over `placeholderSource()`.
 *  `reference`: a picture of the look to aim for (the prompt's paste or drop), sent after the
 *  picture the effect runs over, and named as such in the prompt. */
export async function productEngineInput(o: { request: string; base: EffectDef | null; image: string | null; reference?: string | null; target?: GenTarget | null; signal?: AbortSignal }): Promise<EngineInput> {
  const images = [o.image, o.reference].filter((x): x is string => !!x)
  return {
    request: o.request,
    base: baseFromEffect(o.base),
    count: SHADER_GEN_TAKES,
    images: images.length ? images : undefined,
    ...(o.reference ? { referencePicture: (o.image ? 2 : 1) as 1 | 2 } : {}),
    // No picture to run over (a reference, if any, is only the look): ask for a standalone effect.
    ...(o.image ? {} : { noSourcePicture: true }),
    ...(o.target ? { target: o.target } : {}),
    examples: await productExamples(),
    signal: o.signal,
  }
}
