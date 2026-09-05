/**
 * The Scatter element's STYLE registry — the one table the inspector's Style
 * control, the agent's `scatter` op, the paint branch and the unit suite all read.
 *
 * A Scatter is the `scatter` layer kind (useCompositorLayers): ONE self-painting
 * layer holding a scatter of thrown marks. Which marks is the layer's `style`:
 *
 *   style     what it is
 *   chaff     blades strewn over a sheet, printed through a mottled two-ink mask
 *   strand    branching chains of stubby rods, printed over a plate that sits off true
 *   husk      warped ovals dropped into one depth field, the fill inside them eaten
 *
 * It is a SIBLING of the Mosaic element (`deal`), not one of its styles: a mosaic
 * is a composition — a frame divided and filled — while a scatter is loose marks
 * littered over a sheet. The architecture mirrors the deal's exactly, though: one layer,
 * one seed, clipped to its own box, both box dims normalized to the frame WIDTH.
 *
 * A style is DATA + A PAINT FUNCTION. A row carries its own defaults, its
 * normalizer, its dial list and its palette table, so:
 *  - the inspector renders a style's dials straight off `controls` (no per-style
 *    block to write), and its Palette straight off `presetNames`;
 *  - the agent reads the same lists for its arg validation and its read-back;
 *  - adding a style is ONE module (its own file, ported like `chaff.ts`) plus ONE
 *    line at each `// STYLE: <name>` anchor — here, in the layer interface
 *    (useCompositorLayers), and in the agent's style table.
 */
import {
  defaultChaff, normalizeChaff, paintChaff, chaffPresetPatch, chaffPresetOf,
  CHAFF_LIMITS, CHAFF_PRESET_NAMES, CHAFF_SHAPES, type ChaffParams, type ChaffCtx,
} from '~/lib/compositor/chaff'
import {
  defaultStrand, normalizeStrand, paintStrand, strandPresetPatch, strandPresetOf,
  STRAND_LIMITS, STRAND_PRESET_NAMES, STRAND_TEXTURES, type StrandParams,
} from '~/lib/compositor/strand'
import {
  defaultHusk, normalizeHusk, paintHusk, huskPresetPatch, huskPresetOf,
  HUSK_LIMITS, HUSK_PRESET_NAMES, HUSK_BITES, type HuskParams,
} from '~/lib/compositor/husk'

/** The context a style's paint needs. Every scatter generator prints one sheet into
 *  the box, so this is deliberately the smallest surface a recording stub can fake. */
export type ScatterPaintCtx = ChaffCtx

/** One dial the inspector draws for a style. `key` names a field of that style's
 *  params — a control whose key is not a real param is a DEAD control, and the unit
 *  suite fails it. */
export interface ScatterSliderControl {
  kind: 'slider'
  key: string
  /** Plain-language label (the tool's own control name where it is plain). */
  label: string
  min: number
  max: number
  step: number
}
export interface ScatterSelectControl {
  kind: 'select'
  key: string
  label: string
  options: readonly { value: string; label: string }[]
}
export type ScatterControl = ScatterSliderControl | ScatterSelectControl

/** A style: its identity, its params, its dials, its palettes and its paint. */
export interface ScatterStyleRow<Id extends string = string, P = Record<string, unknown>> {
  readonly id: Id
  /** The inspector's Style option text. */
  readonly label: string
  defaults(): P
  /** Total: garbage / partial / absent params all come back as a usable set. */
  normalize(partial: unknown, base?: P): P
  /** The dials, in the order the inspector shows them. */
  readonly controls: readonly ScatterControl[]
  /** The style's named palettes (its roles, in order), in table order. */
  readonly presetNames: readonly string[]
  presetPatch(name: string): Partial<P>
  presetOf(params: P): string | null
  /** Paint one sheet at the ctx origin over `boxW × boxH`. Must not write an absolute
   *  `globalAlpha` / composite op — the layer's own already ride on the ctx. */
  paint(ctx: ScatterPaintCtx, params: P, boxW: number, boxH: number, seed: number): void
}

// ── Chaff ─────────────────────────────────────────────────────────────────────

const CHAFF_STYLE: ScatterStyleRow<'chaff', ChaffParams> = {
  id: 'chaff',
  label: 'Chaff',
  defaults: defaultChaff,
  normalize: normalizeChaff,
  // The tool's own three groups, in its own order: the throw, the blade, the print.
  controls: [
    { kind: 'slider', key: 'count', label: 'Blades', min: CHAFF_LIMITS.count[0], max: CHAFF_LIMITS.count[1], step: 1 },
    { kind: 'slider', key: 'size', label: 'Size', min: 0, max: 1, step: 0.01 },
    { kind: 'slider', key: 'vary', label: 'Variation', min: 0, max: 1, step: 0.01 },
    { kind: 'slider', key: 'apart', label: 'Separation', min: 0, max: 1, step: 0.01 },
    { kind: 'select', key: 'shape', label: 'Shape', options: CHAFF_SHAPES.map(s => ({ value: s, label: s[0]!.toUpperCase() + s.slice(1) })) },
    { kind: 'slider', key: 'curve', label: 'Curve', min: 0, max: 1, step: 0.01 },
    { kind: 'slider', key: 'slim', label: 'Width', min: 0, max: 1, step: 0.01 },
    { kind: 'slider', key: 'taper', label: 'Taper', min: 0, max: 1, step: 0.01 },
    { kind: 'slider', key: 'mottle', label: 'Mottle', min: 0, max: 1, step: 0.01 },
    { kind: 'slider', key: 'coarse', label: 'Coarseness', min: 0, max: 1, step: 0.01 },
    { kind: 'slider', key: 'grain', label: 'Grain', min: 0, max: 1, step: 0.01 },
  ],
  presetNames: CHAFF_PRESET_NAMES,
  presetPatch: name => chaffPresetPatch(name as Parameters<typeof chaffPresetPatch>[0]),
  presetOf: chaffPresetOf,
  paint: paintChaff,
}

// ── Strand ────────────────────────────────────────────────────────────────────

const STRAND_STYLE: ScatterStyleRow<'strand', StrandParams> = {
  id: 'strand',
  label: 'Strand',
  defaults: defaultStrand,
  normalize: normalizeStrand,
  // The tool's own three groups, in its own order: the chains, the rods, the print.
  controls: [
    { kind: 'slider', key: 'count', label: 'Chains', min: STRAND_LIMITS.count[0], max: STRAND_LIMITS.count[1], step: 1 },
    { kind: 'slider', key: 'len', label: 'Length', min: STRAND_LIMITS.len[0], max: STRAND_LIMITS.len[1], step: 1 },
    { kind: 'slider', key: 'wander', label: 'Wander', min: 0, max: 1, step: 0.01 },
    { kind: 'slider', key: 'branch', label: 'Branching', min: 0, max: 1, step: 0.01 },
    { kind: 'slider', key: 'thick', label: 'Thickness', min: 0, max: 1, step: 0.01 },
    { kind: 'slider', key: 'rod', label: 'Rod length', min: 0, max: 1, step: 0.01 },
    { kind: 'slider', key: 'notch', label: 'Notch', min: 0, max: 1, step: 0.01 },
    { kind: 'slider', key: 'rough', label: 'Roughness', min: 0, max: 1, step: 0.01 },
    { kind: 'slider', key: 'offset', label: 'Off-register', min: 0, max: 1, step: 0.01 },
    { kind: 'slider', key: 'edge', label: 'Plate spread', min: 0, max: 1, step: 0.01 },
    { kind: 'select', key: 'texKind', label: 'Ink texture', options: STRAND_TEXTURES.map(t => ({ value: t, label: t[0]!.toUpperCase() + t.slice(1) })) },
    { kind: 'slider', key: 'tex', label: 'Coverage', min: 0, max: 1, step: 0.01 },
    { kind: 'slider', key: 'grain', label: 'Grain', min: 0, max: 1, step: 0.01 },
  ],
  presetNames: STRAND_PRESET_NAMES,
  presetPatch: name => strandPresetPatch(name as Parameters<typeof strandPresetPatch>[0]),
  presetOf: strandPresetOf,
  paint: paintStrand,
}

// ── Husk ──────────────────────────────────────────────────────────────────────

const HUSK_STYLE: ScatterStyleRow<'husk', HuskParams> = {
  id: 'husk',
  label: 'Husk',
  defaults: defaultHusk,
  normalize: normalizeHusk,
  // The tool's own three groups, in its own order: the husks, the bite, the finish.
  controls: [
    { kind: 'slider', key: 'count', label: 'Count', min: HUSK_LIMITS.count[0], max: HUSK_LIMITS.count[1], step: 1 },
    { kind: 'slider', key: 'size', label: 'Size', min: 0, max: 1, step: 0.01 },
    { kind: 'slider', key: 'vary', label: 'Size range', min: 0, max: 1, step: 0.01 },
    { kind: 'slider', key: 'lump', label: 'Lumpiness', min: 0, max: 1, step: 0.01 },
    { kind: 'select', key: 'bite', label: 'Bite', options: HUSK_BITES.map(b => ({ value: b, label: b[0]!.toUpperCase() + b.slice(1) })) },
    { kind: 'slider', key: 'eat', label: 'Bite amount', min: 0, max: 1, step: 0.01 },
    { kind: 'slider', key: 'tex', label: 'Bite texture', min: 0, max: 1, step: 0.01 },
    { kind: 'slider', key: 'grain', label: 'Grain', min: 0, max: 1, step: 0.01 },
  ],
  presetNames: HUSK_PRESET_NAMES,
  presetPatch: name => huskPresetPatch(name as Parameters<typeof huskPresetPatch>[0]),
  presetOf: huskPresetOf,
  paint: paintHusk,
}

// ── The registry ──────────────────────────────────────────────────────────────

/** Inspector order, top to bottom. ONE line per style. */
export const SCATTER_STYLES = [
  CHAFF_STYLE,
  STRAND_STYLE,
  HUSK_STYLE,
] as const

/** The style words, derived from the table — a new row widens this union for free. */
export type ScatterStyle = typeof SCATTER_STYLES[number]['id']
/** A style's params as the inspector and the agent hold them: a bag keyed by the
 *  style's own control keys. Each style's module has the real, exact type. */
export type ScatterParamsBag = Record<string, unknown>
/** A row with its params erased — what a consumer that walks the table holds. `any`
 *  is deliberate and confined to this alias: a table of rows with DIFFERENT param
 *  types can only be walked with the params erased, and every real call site goes
 *  back through that style's own module for the exact type. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyScatterStyleRow = ScatterStyleRow<ScatterStyle, any>

/** The Style control's option strings, in table order. */
export const SCATTER_STYLE_LABELS: readonly string[] = SCATTER_STYLES.map(r => r.label)

/** The style a freshly stamped / agent-created Scatter wears. */
export const DEFAULT_SCATTER_STYLE: ScatterStyle = 'chaff'

/** The seed a fresh Scatter carries — the tool's own default variation. */
export const DEFAULT_SCATTER_SEED = 9

export function isScatterStyle(v: unknown): v is ScatterStyle {
  return SCATTER_STYLES.some(r => r.id === v)
}

/** Any input → a real style word (unknown ⇒ the default, so a stale save or a typo
 *  can never leave a layer with a style nothing paints). */
export function scatterStyleOf(v: unknown): ScatterStyle {
  return isScatterStyle(v) ? v : DEFAULT_SCATTER_STYLE
}

/** The row for a style (unknown ⇒ the default style's row). */
export function scatterStyleRow(style: unknown): AnyScatterStyleRow {
  const id = scatterStyleOf(style)
  return (SCATTER_STYLES.find(r => r.id === id) ?? SCATTER_STYLES[0]) as unknown as AnyScatterStyleRow
}

/** style word → inspector label. */
export function scatterLabelOf(style: unknown): string {
  return scatterStyleRow(style).label
}
/** Inspector label → style word (unknown label ⇒ the default style). */
export function scatterStyleOfLabel(label: string): ScatterStyle {
  return (SCATTER_STYLES.find(r => r.label === label)?.id ?? DEFAULT_SCATTER_STYLE) as ScatterStyle
}

/**
 * Read a style out of loosely-typed agent args: `style` (the plain word), case-
 * insensitive. Returns null when it names no known style, so the caller can tell
 * "not sent" from "sent something wrong".
 */
export function scatterStyleFromArgs(a: Record<string, unknown>): ScatterStyle | null {
  const raw = a.style
  if (typeof raw !== 'string') return null
  const lc = raw.trim().toLowerCase()
  return isScatterStyle(lc) ? lc : null
}

// ── Layer seams shared by the inspector, the paint branch and the agent ───────

/** The shape of a scatter layer this module needs — structural, so it never imports
 *  the composable at runtime (the composable imports THIS). Deliberately WITHOUT an
 *  index signature: `ScatterLayer` is an interface, and TS gives an interface no
 *  implicit index signature, so one here would reject the very type this serves.
 *  The per-style params field (named after the style) is read through `styleField`. */
export interface ScatterLayerLike {
  style: string
  seed: number
}

/** The layer's params object for one style — the field is named after the style id. */
function styleField(layer: ScatterLayerLike, id: string): unknown {
  return (layer as unknown as Record<string, unknown>)[id]
}

/** The NORMALIZED params a layer paints with. Raw layer objects reach paint
 *  un-normalized (a hand-edited save, an imported frame, an agent-made layer with no
 *  style object at all), so every reader starts here. */
export function scatterParams(layer: ScatterLayerLike, style?: unknown): ScatterParamsBag {
  const row = scatterStyleRow(style ?? layer.style)
  return row.normalize(styleField(layer, row.id)) as ScatterParamsBag
}

/**
 * The patch that switches a scatter to `style`, seeding that style's params with its
 * defaults when absent. Never touches the box or the seed, so a style hop keeps the
 * layer, its placement and its variation.
 */
export function scatterStylePatch(layer: ScatterLayerLike, style: unknown): Record<string, unknown> {
  const row = scatterStyleRow(style)
  return { style: row.id, [row.id]: styleField(layer, row.id) ?? row.defaults() }
}

/** The patch that sets a scatter's seed — one variation, one field. */
export function scatterSeedPatch(_layer: ScatterLayerLike, seed: number): { seed: number } {
  return { seed: Math.max(1, Math.min(9999, Math.round(Number.isFinite(seed) ? seed : 1))) }
}

/** A fresh random seed in the same 1..9999 range every re-roll in the app uses. */
export function freshScatterSeed(): number {
  return Math.floor(Math.random() * 9999) + 1
}

/**
 * Paint a scatter layer's sheet at the ctx origin over `boxW × boxH` — the ONE call
 * the draw branch makes. The style's own paint decides everything else; the caller
 * has already translated to the box's top-left and clipped to it.
 */
export function paintScatter(ctx: ScatterPaintCtx, layer: ScatterLayerLike, boxW: number, boxH: number): void {
  const row = scatterStyleRow(layer.style)
  const seed = Number.isFinite(layer.seed) ? Math.round(layer.seed) : DEFAULT_SCATTER_SEED
  row.paint(ctx, scatterParams(layer), boxW, boxH, seed)
}
