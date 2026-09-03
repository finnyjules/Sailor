/** Data for the Compositor toolbar's collapsed menus.
 *
 *  The bar used to carry five shape stamps, a lone Import-SVG button and three
 *  ungrouped AI flows. They now live behind three menus (Shapes ▾, Insert ▾,
 *  AI ✦ ▾). Only the *lists* and the tiny bits of logic live here — the icons
 *  and the handlers stay in the SFC, because they are components and closures
 *  over the editor. Keeping the lists pure lets the unit suite pin the menu
 *  contents and the last-used-face reducer without mounting the modal. */

export type ToolbarShapeId = 'rect' | 'ellipse' | 'line' | 'polygon' | 'star' | 'library'

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

export type ToolbarAiId = 'vector' | 'region' | 'smart'

export interface ToolbarAiRow {
  id: ToolbarAiId
  label: string
  /** Subtitle under the label — the old button's tooltip text, verbatim. */
  hint: string
}

export const TOOLBAR_AI: readonly ToolbarAiRow[] = [
  { id: 'vector', label: 'AI vector', hint: 'Generate from text or vectorize a selected image' },
  { id: 'region', label: 'Generate in region', hint: 'Mark an area (box, brush, or shape) and regenerate just that part of an image' },
  { id: 'smart', label: 'Smart select', hint: 'Scribble over an object, AI refines the selection' },
]

/** Smart select only works against an image layer. While it is already active
 *  the row stays live so it can be switched off from the same place. */
export function smartSelectRowState(hasImageSelection: boolean, active: boolean): { disabled: boolean, hint: string } {
  if (active || hasImageSelection) return { disabled: false, hint: TOOLBAR_AI[2]!.hint }
  return { disabled: true, hint: 'Select an image layer first' }
}

/** The AI face a freshly-opened modal wears. Not persisted, same as Shapes. */
export const DEFAULT_AI_FACE: ToolbarAiId = 'vector'

/** Last-used-face reducer for AI ✦. Unknown ids fall back to the default so a
 *  stale value can never leave the button without an icon or a handler. */
export function resolveAiFace(id: string | null | undefined): ToolbarAiId {
  return TOOLBAR_AI.some(r => r.id === id) ? id as ToolbarAiId : DEFAULT_AI_FACE
}

/** Label for an AI face id (used in the face button's tooltip). */
export function aiFaceLabel(id: string | null | undefined): string {
  const face = resolveAiFace(id)
  return TOOLBAR_AI.find(r => r.id === face)!.label
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
