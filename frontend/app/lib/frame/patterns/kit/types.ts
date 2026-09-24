import type { Sheet } from './sheet'
import type { StyleId } from './styles'

// Layout kit types. Units: percent of frame width (W = 100, H = 100 × frameH / frameW).

/** A text role: the four levels and the action (Stages 1–3), and the Stage 4 content roles (a
 *  review's `quote`/`by`/`rating`, a `list`, a `stat` and its `statline`, a comparison's `them`).
 *  Only the first five are measured faces and levels a format carries (`faceOf`, `styles.ts`). */
export type RoleKey = 'title' | 'details' | 'date' | 'caption' | 'action'
  | 'quote' | 'by' | 'rating' | 'list' | 'stat' | 'statline' | 'them'
/** The roles that have a face of their own (the Stage 1–3 text roles). */
export type FaceKey = 'title' | 'details' | 'date' | 'caption' | 'action'
export type Colour = 'ink' | 'accent' | 'field'
/** Text style. `role` picks whose face is measured (the user's real family/weight). */
export interface Style { role?: RoleKey; size?: number; wt?: number; ls: number; lh: number
  /** Measured (and drawn) in capitals — the style's letter case. */
  upper?: boolean }
interface Base { role?: string; over?: string[]; ok?: boolean; bleed?: boolean; opacity?: number; blend?: boolean }
export interface TextEl extends Base { k: 't'; s: string; x: number; w?: number; top?: number; base?: number; size: number; wt?: number; ls: number; lh: number; align?: 'left' | 'center' | 'right'; color?: Colour; pre?: boolean; just?: boolean; rot?: number; origin?: string; inside?: string
  /** Set in capitals: measured upper-cased, and toOps writes `textTransform: 'uppercase'`. */
  upper?: boolean
  /** Ruling D2 (layout decisions, Task 4): not the user's layer but the layout's own accent COPY of
   *  the line of this `role` — same words, measured and drawn in that line's face, weight and size
   *  (an exception to ruling R10). toOps draws it as an owned text layer in `color`; the user's
   *  line itself is placed elsewhere by the same layout, as an ordinary small line. */
  copy?: true }
export interface PhotoEl extends Base { k: 'p'; x: number; y: number; w: number; h: number; stand?: boolean; filter?: string; radius?: number
  /** Layout decisions, Task 7: one of the Frame's extra images (the planner's tiles, never a
   *  layout's own) — its index in `RoleTargets.extras`. */
  extra?: number }
/** `prefer` (ruling R12, Task 4 fix round 1): the role the contrast picker tries FIRST for an owned
 *  piece that carries text — kept only if it passes the same thresholds, else the picker's own order. */
export interface CircleEl extends Base { k: 'c'; cx: number; cy: number; r: number; color?: Colour; photo?: boolean; prefer?: Colour }
/** `hex` (Stage 4, ruling R6): a fixed fill by design (the Notes app's paper, the Post-it's note) —
 *  drawn in exactly that colour, never a palette role; the text on it is only checked against it. */
export interface RectEl extends Base { k: 'r'; x: number; y: number; w: number; h: number; color?: Colour; rot?: number; radius?: number; prefer?: Colour; hex?: string }
export interface RuleEl extends Base { k: 'l'; x: number; y: number; w: number }
export interface RingEl extends Base { k: 'ring'; cx: number; cy: number; R: number; size: number; s: string }
export interface MissingEl { k: 'missing'; why?: string }
/** A band of page colour rising from an edge (the prototype's `scrim`): solid (the `field` colour
 *  at 94%) from the outer edge to `solid` (a fraction of `h`), then fading to transparent. */
export interface BandEl extends Base { k: 'band'; side: 'top' | 'bottom'; y: number; h: number; solid: number }
/** A button: a padded shape that grows with its label. The label is the user's own action text,
 *  placed separately as a text element with role `'action'` and `over: ['btn']` (ruling S1).
 *  `bg`: the fill role the prototype draws with recolour on. */
export interface ButtonEl extends Base { k: 'btn'; x: number; y: number; w: number; h: number; size: number; shape: 'pill' | 'box' | 'link'; bg?: Colour }
/** The brand kit's logo (ruling S2), `w × h` with the logo's own aspect. */
export interface LogoEl extends Base { k: 'logo'; x: number; y: number; w: number; h: number }
/** A layout's OWN words (Stage 4: ✓ ✕, list numbers, "Before"/"After", the Notes app's chrome) —
 *  never the user's text. Drawn as an owned text layer in the Frame's caption layer's family AND
 *  weight (ruling R10: what is measured is what is drawn; `wt` only when the Frame has no caption
 *  or title layer), in its palette role `color` (default ink) or a fixed `hex` (ruling R6). Set as
 *  placed lines (no wrapping: `s` breaks at '\n'), measured in the caption face. `x` is the left edge
 *  of the widest line (`align` places the others); `top` is the first cap top, `base` the last baseline. */
export interface OwnTextEl extends Base { k: 'own'; s: string; x: number; top?: number; base?: number; size: number; wt: number; ls: number; lh: number; align?: 'left' | 'center' | 'right'; color?: Colour; hex?: string; rot?: number; role: string }
/** Five owned stars filled to `value` (0..5), the prototype's `.stars`: each star `size` square,
 *  0.08 × size apart, starting at `x`, top at `y`. The number is not part of it (the user's rating
 *  line, when placed, is a text element of its own). */
export interface StarsEl extends Base { k: 'stars'; x: number; y: number; size: number; value: number; role: string }
/** An owned leader line from (x1, y1) to (x2, y2) (Feature callouts), 0.2 thick, in ink. Lines
 *  never collide with anything (the checker skips them for overlaps and the logo's clear space). */
export interface LineEl extends Base { k: 'ln'; x1: number; y1: number; x2: number; y2: number }
export type El = TextEl | PhotoEl | CircleEl | RectEl | RuleEl | RingEl | BandEl | ButtonEl | LogoEl | OwnTextEl | StarsEl | LineEl | MissingEl
/** The brand kit's logo (ruling S2): `aspect` is h / w; `onDarkUrl` for a dark field. */
export interface BrandLogo { url: string; aspect: number; onDarkUrl?: string
  /** The on-dark file's own h/w (it can differ from the main logo's). Absent: `aspect`. */
  onDarkAspect?: number }
export interface Content { title: string; details?: string; date?: string; caption?: string
  /** The action line's text ("Shop now") — ruling S3. No Swiss layout reads it. */
  action?: string
  /** The project's brand kit logo — ruling S2. No Swiss layout reads it. */
  logo?: BrandLogo
  /** Stage 4 content shapes (`kit/content.ts`, ruling R2): present only when the Frame has them. */
  review?: { stars?: number; quote: string; by?: string }
  /** The list's items, markers stripped (the user's layer keeps them). */
  list?: string[]
  compare?: { them: string; rows: { label: string; us: boolean; them: boolean }[] }
  stat?: { value: string; line?: string }
  /** Stage 4: each content line's text exactly as its layer holds it (markers, "vs", the rating's
   *  "★"), for the layouts that place those layers — they measure what the layer draws. Present
   *  only for a layout that reads the content view (`needsContent`). */
  raw?: Partial<Record<ContentLineKey, string>> }
/** The Stage 4 roles a text layer can hold (a layout places the layer itself). */
export type ContentLineKey = 'quote' | 'by' | 'rating' | 'list' | 'stat' | 'statline' | 'them'
/** The content keys that hold a line of text (every key but the logo and the Stage 4 shapes). */
export type TextKey = Exclude<keyof Content, 'logo' | 'review' | 'list' | 'compare' | 'stat' | 'raw'>
export type Kind = 'word' | 'phrase' | 'sentence'
export interface LayoutCtx { c: Content; kind: Kind; ph: boolean; r: () => number; words: string[]; lines: string[]; arr: number
  /** Ruling D2: the planner draws this layout's `accentCopy` line as an owned accent copy (recolour
   *  off, and the accent differs visibly from that line's own colour). The layout then sets the big
   *  crossing line as a `copy` element and places the user's own line as an ordinary small one.
   *  Absent: the layout runs exactly as before (recolour on, or no copy possible). */
  accentCopy?: true }
export interface LayoutOut { els: El[]; did: string }
export interface LayoutDef {
  id: string; name: string; fits: Kind[]
  /** The style the layout belongs to. Absent: `'swiss'`. */
  style?: StyleId
  needs?: { image?: boolean; shape?: boolean; number?: boolean }
  /** Stage 4 (ruling C2): the layout reads the Frame's CONTENT view (lines claimed as a quote, a
   *  list, a stat… leave their base roles). Absent: the base view — the Stage 1–3 roles exactly.
   *  The content kinds it needs gate it in `fitsFrame` (Task 4). */
  needsContent?: ('number' | 'stat' | 'review' | 'compare' | 'list' | 'image2')[]
  oneLineFirst?: boolean; keepScale?: boolean; ownPhoto?: boolean
  /** Built around the smaller text (the prototype's list): does not fit a format that carries
   *  fewer than three levels. */
  smallText?: boolean
  /** One row for wide formats (the prototype's `wideOnly`): offered only when the sheet the
   *  layout composes on is wide (`H < 70` — the band a format leaves uncovered, if it has one). */
  wideOnly?: boolean
  /** Frame layout decisions, Task 5: the Arrangement pills' words, indexed by `LayoutCtx.arr` —
   *  what the user sees change (Run-off: "Right edge", "Left edge", "Lower"). Required, one per
   *  arrangement, on every layout whose `fn` reads `arr` or the seeded `r` (the seed moves with
   *  `arr`); absent on the rest, whose arrangement never varies. Sentence case, ≤ 14 characters,
   *  distinct within the layout. There is no fallback to letters. */
  arrLabels?: string[]
  /** Frame layout decisions, Task 4 (overlap accent, ruling D2): the role of the line this layout
   *  sets big, in the accent, to cross another (Overprint's details, Number behind's number). With
   *  recolour off the user's line keeps its own colour, so — when the accent differs visibly from
   *  it — the planner runs the layout with `LayoutCtx.accentCopy`: the big line is the layout's own
   *  accent copy (a `copy` element: the same words, face, weight and size — an exception to ruling
   *  R10), and the user's line is placed as an ordinary small line. With recolour on: unchanged. */
  accentCopy?: RoleKey
  /** The layout's promise, asserted by the checker: roles that must overlap, must bleed, must be rotated. */
  premise?: { overlap?: [string, string][]; bleed?: string[]; rotated?: string[] }
  fn(S: Sheet, ctx: LayoutCtx): LayoutOut
}
/** Measurement in kit units (percent of frame width). */
export interface Measure {
  /** width of `text` at size 100 units with letter spacing `ls` (em), in the face of `role` */
  w100(text: string, role: RoleKey, ls: number, upper?: boolean): number
  /** lines the RENDERER would draw for `text` in a box `boxW` units wide.
   *  `upper`: measured in capitals (the style's letter case), whatever the role layer's own case. */
  lines(text: string, role: RoleKey, size: number, ls: number, boxW: number, upper?: boolean): string[]
  /** em-box middle → cap top, and middle → baseline, as fractions of font size, for `role` */
  capAbove(role: RoleKey): number
  baseBelow(role: RoleKey): number
}

/** The face an element is measured in, from its `role`: `details`/`date`/`caption`/`title`/
 *  `action` map to themselves (a measure with no action layer measures it in the caption's face);
 *  Stage 4 (final review I2): each content role (`quote`, `by`, `rating`, `list`, `stat`,
 *  `statline`, `them`) maps to ITSELF — it is drawn by its own layer, so it is measured in that
 *  layer's family and weight (a measure with no layer for it falls back to the details face for
 *  `quote`/`stat`, the caption face for the rest — `makeCanvasMeasure`). `info`, a layout's own
 *  words and anything else map to `caption` (the info face; ruling R10 for owned text). */
export function faceOf(role: string | undefined): RoleKey {
  // `title1`, `title2` … are further lines of the same layer: measure them in its face.
  const base = role?.replace(/\d+$/, '')
  if (base === 'quote' || base === 'by' || base === 'rating' || base === 'list' || base === 'stat' || base === 'statline' || base === 'them') return base
  return base === 'title' || base === 'details' || base === 'date' || base === 'caption' || base === 'action' ? base : 'caption'
}

export type { Sheet } from './sheet'
