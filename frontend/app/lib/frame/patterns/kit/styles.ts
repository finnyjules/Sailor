// ═══════════════════════ styles: rule sets on the same kit ═══════════════════════
// Ported from the prototype's `STYLES` (docs/superpowers/specs/assets/2026-09-23-frame-layout-system/
// layout-pane.html ~1121). A style sets the display and information type's weight, letter spacing,
// line height and letter case; the button's look; the order of the levels; and a suggested title
// face (applied only when the user accepts it — never by a layout).
// Swiss is Stages 1–2 exactly: a sheet with no style, or `'swiss'`, is byte-identical to before.

export type StyleId = 'swiss' | 'performance' | 'editorial' | 'street'
export type LevelKey = 'title' | 'details' | 'date' | 'action' | 'caption'

export interface StyleSpec {
  id: StyleId
  label: string
  display: { wt: number; ls: number; lh: number; upper?: boolean }
  info: { wt: number; ls: number; lh: number; upper?: boolean }
  button?: { shape: 'pill' | 'box' | 'link'; wt: number; ls: number }
  /** Level order, most important first (Stage 2 `carries` uses it). */
  levels: LevelKey[]
  face?: { family: string; wt: number; ls: number; note: string }
  /** No text on a raw image (Performance, Street — see S5). */
  textOffImage?: boolean
}

export const STYLES: Record<StyleId, StyleSpec> = {
  swiss: {
    id: 'swiss', label: 'Swiss',
    display: { wt: 600, ls: -0.05, lh: 0.9 },
    info: { wt: 400, ls: 0, lh: 1.3 },
    levels: ['title', 'details', 'date', 'action', 'caption'],
  },
  performance: {
    id: 'performance', label: 'Performance',
    display: { wt: 700, ls: -0.035, lh: 0.94 },
    info: { wt: 500, ls: 0, lh: 1.3 },
    button: { shape: 'pill', wt: 600, ls: 0 },
    // The offer outranks the product name.
    levels: ['title', 'date', 'details', 'action', 'caption'],
    textOffImage: true,
  },
  editorial: {
    id: 'editorial', label: 'Editorial',
    display: { wt: 400, ls: -0.015, lh: 1.04 },
    info: { wt: 500, ls: 0.16, lh: 1.6, upper: true },
    button: { shape: 'link', wt: 500, ls: 0.16 },
    levels: ['title', 'details', 'date', 'action', 'caption'],
    face: { family: 'Instrument Serif', wt: 400, ls: -0.01, note: 'A serif for the title' },
  },
  street: {
    id: 'street', label: 'Street',
    display: { wt: 700, ls: -0.045, lh: 0.84, upper: true },
    info: { wt: 600, ls: 0.04, lh: 1.25, upper: true },
    button: { shape: 'box', wt: 700, ls: 0.06 },
    levels: ['title', 'details', 'date', 'action', 'caption'],
    face: { family: 'Anton', wt: 400, ls: 0, note: 'A heavy condensed face for the title' },
    textOffImage: true,
  },
}
