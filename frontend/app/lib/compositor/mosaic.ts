/**
 * The Mosaic element's STYLE vocabulary — the one table the inspector's Style
 * control, the agent's `mosaic` op and the unit suite all read.
 *
 * A Mosaic is the `deal` layer kind (useCompositorLayers): ONE self-painting
 * layer holding a playgrnd-style generative composition. Which composition is the
 * layer's `cellFill` — an internal field name kept for every saved frame's sake.
 * People (and the agent) speak in STYLES: plain words, one per composition.
 *
 *   style     cellFill    what it is
 *   tiles     solid       the seeded grid, one vocabulary fill per kept cell
 *   pane      pane        rows of flush panes, each a two-ink ramp
 *   modular   modular     a merged module grid over a background, with hairlines
 *   parcel    parcel      a coarse two-tone block field with survey-grid hairlines
 *   mosh      mosh        a corrupted signal: bands of glitch in hard inks
 *
 * `tiles` is the only style whose word differs from its cellFill ('solid' was
 * named for HOW cells paint, not what a person sees). Everything else maps 1:1.
 */

/** A deal layer's `cellFill` value. Mirrors `DealLayer['cellFill']` (kept here so
 *  this module stays import-light — the agent surface and specs import it too). */
export type MosaicCellFill = 'solid' | 'pane' | 'modular' | 'parcel' | 'mosh'
/** The agent-facing / inspector-facing style word. */
export type MosaicStyle = 'tiles' | 'pane' | 'modular' | 'parcel' | 'mosh'

export interface MosaicStyleRow {
  style: MosaicStyle
  cellFill: MosaicCellFill
  /** The inspector's Style option text. */
  label: string
}

/** Inspector order, top to bottom. */
export const MOSAIC_STYLES: readonly MosaicStyleRow[] = [
  { style: 'tiles', cellFill: 'solid', label: 'Tiles' },
  { style: 'pane', cellFill: 'pane', label: 'Pane' },
  { style: 'modular', cellFill: 'modular', label: 'Modular' },
  { style: 'parcel', cellFill: 'parcel', label: 'Parcel' },
  { style: 'mosh', cellFill: 'mosh', label: 'Mosh' },
]

/** The Style control's option strings, in table order. */
export const MOSAIC_STYLE_LABELS: readonly string[] = MOSAIC_STYLES.map(r => r.label)

/** The style a freshly stamped / agent-created Mosaic wears. */
export const DEFAULT_MOSAIC_STYLE: MosaicStyle = 'modular'

export function isMosaicStyle(v: unknown): v is MosaicStyle {
  return MOSAIC_STYLES.some(r => r.style === v)
}
export function isMosaicCellFill(v: unknown): v is MosaicCellFill {
  return MOSAIC_STYLES.some(r => r.cellFill === v)
}

/** cellFill → style word. An absent cellFill is 'solid' (see DealLayer), i.e. tiles. */
export function mosaicStyleOf(cellFill: MosaicCellFill | undefined): MosaicStyle {
  return MOSAIC_STYLES.find(r => r.cellFill === (cellFill ?? 'solid'))?.style ?? 'tiles'
}
/** style word → cellFill. */
export function cellFillOfStyle(style: MosaicStyle): MosaicCellFill {
  return MOSAIC_STYLES.find(r => r.style === style)!.cellFill
}
/** Inspector label → cellFill (unknown label ⇒ tiles, so a stale option can never
 *  write an unknown fill). */
export function cellFillOfLabel(label: string): MosaicCellFill {
  return MOSAIC_STYLES.find(r => r.label === label)?.cellFill ?? 'solid'
}
/** cellFill → inspector label. */
export function mosaicLabelOf(cellFill: MosaicCellFill | undefined): string {
  return MOSAIC_STYLES.find(r => r.cellFill === (cellFill ?? 'solid'))?.label ?? 'Tiles'
}

/**
 * Read a style out of loosely-typed agent args: `style` (preferred, the plain
 * word) or `cellFill` (the older alias, also accepting the raw field values). Case-
 * insensitive. Returns null when neither names a known style. `style` wins when both
 * are sent, so a model that learned the new word is never overridden by the old one.
 */
export function mosaicStyleFromArgs(a: Record<string, unknown>): MosaicStyle | null {
  for (const key of ['style', 'cellFill'] as const) {
    const raw = a[key]
    if (typeof raw !== 'string') continue
    const lc = raw.trim().toLowerCase()
    if (isMosaicStyle(lc)) return lc
    if (isMosaicCellFill(lc)) return mosaicStyleOf(lc)
  }
  return null
}
