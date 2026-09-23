import type { ResolvedPalette } from './palette'
import { autoInk, contrastRatio } from './palette'
import { isHex } from '~/lib/color/convert'
import { posterLayerViews } from './frameContext'
import { inferElements } from './hierarchy'

const PAPER = '#f2f0ef'
const INK = '#0e0e0e'
const hex = (v: unknown): string | undefined => (typeof v === 'string' && isHex(v)) ? v.toLowerCase() : undefined

/** The accent a Frame with no shape colour of its own takes, when the brand kit has none: the
 *  one that best contrasts with both the ink and the page (ruling R7). */
export const ACCENT_POOL = ['#e1251b', '#2b59c3', '#f2b705', '#1f8a4c', '#7b3fe4'] as const

/** Of `pool`, the colour with the best min(contrast vs ink, contrast vs field); ties keep pool order. */
function bestAccent(pool: readonly string[], ink: string, field: string): string {
  let best = pool[0]!, score = -1
  for (const c of pool) {
    const s = Math.min(contrastRatio(c, ink), contrastRatio(c, field))
    if (s > score) { score = s; best = c }
  }
  return best
}

/** The frame's own colours as the role palette, so a layout changes no colour:
 *  field = the solid background, ink = the title's colour, accent = the first
 *  shape's fill. Anything that is not a plain hex falls back; an unreadable ink
 *  is auto-contrasted against the field. A layout's own pieces (bands, tags,
 *  buttons — layers with an `owner`) are not the user's colours and are skipped
 *  (ruling R7). With no shape colour, the accent is the brand kit's `brandAccent`
 *  when given, else the pool colour that best contrasts with both ink and field —
 *  never the ink itself, which left tags and stickers invisible. */
export function paletteFromFrame(props: Record<string, unknown> | undefined, brandAccent?: string): ResolvedPalette {
  const all = (props?.sailor_localLayers as any[] | undefined) ?? []
  const layers = all.filter(l => !l?.owner)
  const field = hex(props?.sailor_localBg) ?? PAPER
  const titleId = inferElements(posterLayerViews({ ...props, sailor_localLayers: layers })).title?.id
  const title = layers.find(l => l?.id === titleId)
  const inkWanted = hex(title?.color) ?? INK
  // Keep the user's ink whenever it is readable; only an unreadable one is replaced.
  // (autoInk picks the HIGHEST contrast in its pool, so it must not be the first resort.)
  const ink = contrastRatio(field, inkWanted) >= 4.5 ? inkWanted : autoInk(field, [inkWanted]).ink
  const shape = layers.find(l => l?.kind === 'path' || l?.kind === 'rect' || l?.kind === 'ellipse')
  const accent = hex(shape?.fill) ?? hex(brandAccent) ?? bestAccent(ACCENT_POOL, ink, field)
  return { field, ink, accent }
}
