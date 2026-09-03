/**
 * A library shape as a one-path SVG document — the string form every SVG
 * consumer in Sailor already accepts (3D Studio's importer today). The fill
 * defaults to the manifest's `sourceColor`: the one place that hint is worth
 * spending, because an extruded solid needs a starting material colour and the
 * drawing's own beats a default.
 */
import type { LibraryShape } from '~~/shared/shape-library'

export function shapeToSvg(shape: LibraryShape, opts: { fill?: string } = {}): string {
  const fill = opts.fill ?? shape.sourceColor
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96"><path d="${shape.d}" fill="${fill}" fill-rule="${shape.fillRule}"/></svg>`
}
