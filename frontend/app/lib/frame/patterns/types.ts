import type { Rect } from '~/lib/frame/grid'

/** What the user brought, inferred from the title's word count. */
export type PosterKind = 'word' | 'phrase' | 'sentence'

/** Inferred role of an element on the poster. */
export type Role = 'title' | 'details' | 'caption' | 'date'

/** Classify a title by its word count: 1 = word, 2–4 = phrase, 5+ = sentence. */
export function kindOf(wordCount: number): PosterKind {
  if (wordCount <= 1) return 'word'
  if (wordCount <= 4) return 'phrase'
  return 'sentence'
}

/** The read-only view of a Frame layer the engine needs. The app (plan 1b) maps
 *  a full LocalLayer down to this; tests build it directly. */
export interface PosterLayerView {
  id: string
  kind: 'text' | 'image' | 'shape'
  /** Present for text layers: the words. */
  text?: string
  /** Present for text layers: font size normalized to frame width (as LocalLayer stores it). */
  fontSize?: number
  /** Present for shape layers: the library shape id. */
  shapeId?: string
}

export interface TextEl { role: Role; id: string; text: string; words: string[] }
export interface ImageEl { id: string }
export interface ShapeEl { id: string; shapeId: string }

/** The user's elements, hierarchy-inferred. Faces/palette are NOT here — the
 *  engine places geometry only; `ctx.measure` closes over the title face, and
 *  colours are emitted as roles. `shapeMode` says which library shape to use
 *  when a pattern wants one and no shape layer was placed. */
export interface FrameElements {
  title?: TextEl
  details?: TextEl
  caption?: TextEl
  date?: TextEl
  images: ImageEl[]
  shapes: ShapeEl[]
  shapeMode: { id: string } | { family: string } | null
}

/** Exactly the shape `resolveGrid` returns. `null` when grid mode is 'off'. */
export type ResolvedGrid = { xs: number[]; ys: number[]; regions: Rect[] }

export type ColorRole = 'ink' | 'accent' | 'field'

/** One placement instruction. Positions are normalized-centre (0..1 of frame
 *  w/h); sizes normalized to frame width. Never carries a face/weight/colour. */
export interface LayerOp {
  /** Which element this moves: a role, or the literal element id for images/shapes. */
  target: Role | string
  kind: 'text' | 'image' | 'shape'
  x: number
  y: number
  w?: number
  h?: number
  fontSize?: number
  rotation?: number
  align?: 'left' | 'center' | 'right' | 'justify'
  colorRole?: ColorRole
  blend?: 'normal' | 'multiply'
  /** The text re-broken with '\n' inserted (text ops only). */
  lineBreak?: string
  /** For a shape op: which library shape to draw (from shapeMode/element). */
  shapeId?: string
  /** Shape/image fill treatment. */
  fill?: 'solid' | 'outline' | 'photo'
  /** Relative stacking hint: lower renders behind. Default 0. */
  z?: number
}

export interface PatternPlacement {
  ops: LayerOp[]
  /** Plain-language label of what the pattern did (drives the sheet tile label). */
  did: string
}

/** Injected width oracle: width in px of `text` set at fontSize 100 in the
 *  title face. The app passes a canvas-backed measurer; tests pass a stub. */
export type Measure = (text: string) => number

export interface PatternContext {
  frame: { w: number; h: number }
  grid: ResolvedGrid | null
  /** Frame margin, normalized to width (from the grid, or a default when off). */
  margin: number
  elements: FrameElements
  seed: number
  measure: Measure
}

export interface Pattern {
  id: string
  name: string
  fits: PosterKind[]
  needs?: { shape?: boolean; image?: boolean }
  place(ctx: PatternContext): PatternPlacement
}
