import type { ResolvedPalette } from './palette'
import { autoInk, contrastRatio } from './palette'
import { isHex } from '~/lib/color/convert'
import { posterLayerViews } from './frameContext'
import { inferElements } from './hierarchy'

const PAPER = '#f2f0ef'
const INK = '#0e0e0e'
const hex = (v: unknown): string | undefined => (typeof v === 'string' && isHex(v)) ? v.toLowerCase() : undefined

/** The frame's own colours as the role palette, so a layout changes no colour:
 *  field = the solid background, ink = the title's colour, accent = the first
 *  shape's fill. Anything that is not a plain hex falls back; an unreadable ink
 *  is auto-contrasted against the field. */
export function paletteFromFrame(props: Record<string, unknown> | undefined): ResolvedPalette {
  const layers = (props?.sailor_localLayers as any[] | undefined) ?? []
  const field = hex(props?.sailor_localBg) ?? PAPER
  const titleId = inferElements(posterLayerViews(props)).title?.id
  const title = layers.find(l => l?.id === titleId)
  const inkWanted = hex(title?.color) ?? INK
  // Keep the user's ink whenever it is readable; only an unreadable one is replaced.
  // (autoInk picks the HIGHEST contrast in its pool, so it must not be the first resort.)
  const ink = contrastRatio(field, inkWanted) >= 4.5 ? inkWanted : autoInk(field, [inkWanted]).ink
  const shape = layers.find(l => l?.kind === 'path' || l?.kind === 'rect' || l?.kind === 'ellipse')
  const accent = hex(shape?.fill) ?? ink
  return { field, ink, accent }
}
