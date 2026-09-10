/** Data for the Compositor toolbar's collapsed menus.
 *
 *  The bar used to carry five shape stamps and a lone Import-SVG button. They
 *  now live behind two menus (Shapes ▾, Insert ▾). The AI ✦ menu (vector +
 *  region-generate + smart-select) that used to live here was retired; the
 *  engines it drove (`runRegionFill`, `genActive`, `useSmartSelect`, etc.)
 *  remain in CompositorModal for right-click editing to reuse. Only the
 *  *lists* and the tiny bits of logic live here — the icons and the handlers
 *  stay in the SFC, because they are components and closures over the editor.
 *  Keeping the lists pure lets the unit suite pin the menu contents and the
 *  last-used-face reducer without mounting the modal. */

export type ToolbarShapeId = 'rect' | 'ellipse' | 'line' | 'polygon' | 'star' | 'mosaic' | 'scatter' | 'library'

export interface ToolbarShapeRow {
  id: ToolbarShapeId
  /** Menu row text, also the face button's title. */
  label: string
}

/** Menu order, top to bottom. Rectangle first: it is the default face. */
export const TOOLBAR_SHAPES: readonly ToolbarShapeRow[] = [
  { id: 'rect', label: 'Rectangle' },
  { id: 'ellipse', label: 'Ellipse' },
  { id: 'line', label: 'Line' },
  { id: 'polygon', label: 'Polygon' },
  { id: 'star', label: 'Star' },
  // A Mosaic is a generative composition ELEMENT (the playgrnd-style ports:
  // Tiles / Pane / Modular / Parcel / Mosh / Oddgrid / Static) — it is added from
  // here like any shape and tuned in the inspector; the frame's Grid section is
  // only the layout guide. Stamps a frame-filling Modular mosaic (see
  // newMosaicLayer in useCompositorLayers).
  { id: 'mosaic', label: 'Mosaic' },
  // A Scatter is a generative SCATTER element (the playgrnd-style ports of thrown
  // marks: Chaff now, Strand and Husk next) — a sibling of Mosaic, not one of its
  // styles: a mosaic is a composition, a scatter is marks thrown across a sheet.
  // Stamps a frame-filling Chaff scatter (see newScatterLayer in useCompositorLayers).
  { id: 'scatter', label: 'Scatter' },
  // Opens the shape library picker instead of stamping; the picked shape then
  // becomes the face so repeat stamping stays one click (see CompositorModal).
  { id: 'library', label: 'Shape library…' },
]

/** The face a freshly-opened modal wears. Last-used is NOT persisted (spec). */
export const DEFAULT_SHAPE_FACE: ToolbarShapeId = 'rect'

/** Last-used-face reducer: anything unknown falls back to the default, so a
 *  stale or hand-set value can never leave the button without an icon. The
 *  library face is only valid while the modal knows which library shape to
 *  stamp (`hasLibraryShape`); a fresh modal has none, so it falls back too. */
export function resolveShapeFace(id: string | null | undefined, hasLibraryShape = false): ToolbarShapeId {
  if (id === 'library') return hasLibraryShape ? 'library' : DEFAULT_SHAPE_FACE
  return TOOLBAR_SHAPES.some(s => s.id === id) ? id as ToolbarShapeId : DEFAULT_SHAPE_FACE
}

/** Label for a face id (used in the face button's tooltip). */
export function shapeFaceLabel(id: string | null | undefined, hasLibraryShape = false): string {
  const face = resolveShapeFace(id, hasLibraryShape)
  return TOOLBAR_SHAPES.find(s => s.id === face)!.label
}

export type ToolbarInsertId = 'upload' | 'canvas' | 'svg'

export interface ToolbarInsertRow {
  id: ToolbarInsertId
  label: string
  /** Upload and Import SVG act immediately; the canvas picker is a second hop
   *  (it opens the picker surface), which the ellipsis in its label signals. */
  secondHop?: boolean
}

/** Menu order, top to bottom. Upload first: it is the default face. */
export const TOOLBAR_INSERT: readonly ToolbarInsertRow[] = [
  { id: 'upload', label: 'Upload image' },
  { id: 'canvas', label: 'Pick from canvas…', secondHop: true },
  { id: 'svg', label: 'Import SVG' },
]

/** The Insert face a freshly-opened modal wears. Not persisted. */
export const DEFAULT_INSERT_FACE: ToolbarInsertId = 'upload'

export function resolveInsertFace(id: string | null | undefined): ToolbarInsertId {
  return TOOLBAR_INSERT.some(r => r.id === id) ? id as ToolbarInsertId : DEFAULT_INSERT_FACE
}

export function insertFaceLabel(id: string | null | undefined): string {
  const face = resolveInsertFace(id)
  return TOOLBAR_INSERT.find(r => r.id === face)!.label
}
