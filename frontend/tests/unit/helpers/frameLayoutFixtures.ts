// The content fixtures and the Frame-building helper shared by the layout matrices
// (`frame-layout-matrix.unit.spec.ts`, Stage 1, and `frame-layout-format-matrix.unit.spec.ts`,
// Stage 2). Extracted verbatim from the Stage 1 matrix; `frameLayers` gained an optional `date`
// override for the number fixture, and with it absent builds exactly the Stage 1 Frame.
import type { Kind } from '~/lib/frame/patterns/kit/types'
import { createEllipseLayer, createImageLayer, createTextLayer } from '~/composables/useCompositorLayers'
import type { LocalLayer } from '~/composables/useCompositorLayers'

export const KIND_TITLES: Record<Kind, string> = {
  word: 'Echoes',
  phrase: 'Weather Report',
  sentence: 'Everything slow is still moving',
}
export const TEXTS = {
  details: 'Ines Vollmer',
  date: '19.09.–15.11.2026',
  caption: 'Kunstraum Lenz\nLenzgasse 14, 4056 Basel',
}
export const palette = { field: '#f2f0ef', ink: '#121212', accent: '#dd2200' }

/** A real Frame: four TextLayers (sizes make the inference unambiguous), plus an image layer
 *  when `image`, plus a shape layer when the layout needs one. `date` replaces the date's text. */
export function frameLayers(kind: Kind, o: { image: boolean; shape: boolean; date?: string }): LocalLayer[] {
  const t = (id: string, text: string, fontSize: number) =>
    createTextLayer({ id, text, fontSize, fontFamily: 'Inter', fontWeight: 600, color: '#111111' }) as LocalLayer
  const out = [
    t('t', KIND_TITLES[kind], 0.12),
    t('d', TEXTS.details, 0.04),
    t('dt', o.date ?? TEXTS.date, 0.03),
    t('c', TEXTS.caption, 0.02),
  ]
  if (o.image) out.push(createImageLayer('x.png', 1.25, { id: 'img', w: 0.5, h: 0.625 }) as LocalLayer)
  if (o.shape) out.push(createEllipseLayer({ id: 'shp', x: 0.5, y: 0.5, w: 0.3, h: 0.3 }) as LocalLayer)
  return out
}
