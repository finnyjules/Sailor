import type { Sheet } from './sheet'
import type { StyleId } from './styles'

// Layout kit types. Units: percent of frame width (W = 100, H = 100 × frameH / frameW).

export type RoleKey = 'title' | 'details' | 'date' | 'caption' | 'action'
export type Colour = 'ink' | 'accent' | 'field'
/** Text style. `role` picks whose face is measured (the user's real family/weight). */
export interface Style { role?: RoleKey; size?: number; wt?: number; ls: number; lh: number
  /** Measured (and drawn) in capitals — the style's letter case. */
  upper?: boolean }
interface Base { role?: string; over?: string[]; ok?: boolean; bleed?: boolean; opacity?: number; blend?: boolean }
export interface TextEl extends Base { k: 't'; s: string; x: number; w?: number; top?: number; base?: number; size: number; wt?: number; ls: number; lh: number; align?: 'left' | 'center' | 'right'; color?: Colour; pre?: boolean; just?: boolean; rot?: number; origin?: string; inside?: string
  /** Set in capitals: measured upper-cased, and toOps writes `textTransform: 'uppercase'`. */
  upper?: boolean }
export interface PhotoEl extends Base { k: 'p'; x: number; y: number; w: number; h: number; stand?: boolean; filter?: string; radius?: number }
export interface CircleEl extends Base { k: 'c'; cx: number; cy: number; r: number; color?: Colour; photo?: boolean }
export interface RectEl extends Base { k: 'r'; x: number; y: number; w: number; h: number; color?: Colour; rot?: number; radius?: number }
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
export type El = TextEl | PhotoEl | CircleEl | RectEl | RuleEl | RingEl | BandEl | ButtonEl | LogoEl | MissingEl
/** The brand kit's logo (ruling S2): `aspect` is h / w; `onDarkUrl` for a dark field. */
export interface BrandLogo { url: string; aspect: number; onDarkUrl?: string }
export interface Content { title: string; details?: string; date?: string; caption?: string
  /** The action line's text ("Shop now") — ruling S3. No Swiss layout reads it. */
  action?: string
  /** The project's brand kit logo — ruling S2. No Swiss layout reads it. */
  logo?: BrandLogo }
/** The content keys that hold a line of text (every key but `logo`). */
export type TextKey = Exclude<keyof Content, 'logo'>
export type Kind = 'word' | 'phrase' | 'sentence'
export interface LayoutCtx { c: Content; kind: Kind; ph: boolean; r: () => number; words: string[]; lines: string[]; arr: number }
export interface LayoutOut { els: El[]; did: string }
export interface LayoutDef {
  id: string; name: string; fits: Kind[]
  /** The style the layout belongs to. Absent: `'swiss'`. */
  style?: StyleId
  needs?: { image?: boolean; shape?: boolean; number?: boolean }
  oneLineFirst?: boolean; keepScale?: boolean; ownPhoto?: boolean
  /** Built around the smaller text (the prototype's list): does not fit a format that carries
   *  fewer than three levels. */
  smallText?: boolean
  /** One row for wide formats (the prototype's `wideOnly`): offered only when the sheet the
   *  layout composes on is wide (`H < 70` — the band a format leaves uncovered, if it has one). */
  wideOnly?: boolean
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

/** The face an element is measured in, from its `role`: `details`/`date`/`caption`/`title`
 *  map to themselves; `action`, `info` and anything else map to `caption` (the info face). */
export function faceOf(role: string | undefined): RoleKey {
  // `title1`, `title2` … are further lines of the same layer: measure them in its face.
  const base = role?.replace(/\d+$/, '')
  return base === 'title' || base === 'details' || base === 'date' || base === 'caption' ? base : 'caption'
}

export type { Sheet } from './sheet'
