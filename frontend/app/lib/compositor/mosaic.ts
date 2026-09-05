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
 *   carve     carve       one rectangle carved into panels, each a printed treatment
 *   oddgrid   oddgrid     the Oddgrid SHADER (shader_effects/oddgrid.frag) as a fill
 *   static    static      the Static SHADER (shader_effects/static.frag) as a fill
 *
 * `tiles` is the only style whose word differs from its cellFill ('solid' was
 * named for HOW cells paint, not what a person sees). Everything else maps 1:1.
 *
 * The two SHADER styles are the shader-as-fill bridge: the layer carries a
 * `ShaderSpec` (`DealLayer.shader`) and paints its box through the SAME
 * `resolvePaint` path a rect with a shader fill uses, so the shader-field pre-pass
 * (`layerPaints` in useCompositorLayers) registers the field like any other shader
 * fill. Their "Palette" is the effect's Looks (EFFECT_LOOKS in shaderstudio/presets).
 */
import type { ShaderSpec } from '~/lib/spacetype/fillTile'
import { DEFAULT_FILL, DEFAULT_SHADER_SPEC, type Fill } from '~/lib/spacetype/fillTile'
import { EFFECT_LOOKS, type EffectLook } from '~/lib/shaderstudio/presets'
import { unprefixedKey } from '~/lib/shaderfill/descriptor'
import type { ParamValue } from '~/lib/shaderfx/types'
import type { DealLayer } from '~/composables/useCompositorLayers'
import { defaultPane } from '~/lib/compositor/pane'
import { defaultModular } from '~/lib/compositor/modular'
import { defaultParcel } from '~/lib/compositor/parcel'
import { defaultMosh } from '~/lib/compositor/mosh'
import { defaultCarve } from '~/lib/compositor/carve'

/** A deal layer's `cellFill` value. Mirrors `DealLayer['cellFill']` (kept here so
 *  this module stays import-light — the agent surface and specs import it too). */
export type MosaicCellFill = 'solid' | 'pane' | 'modular' | 'parcel' | 'mosh' | 'carve' | 'oddgrid' | 'static'
/** The agent-facing / inspector-facing style word. */
export type MosaicStyle = 'tiles' | 'pane' | 'modular' | 'parcel' | 'mosh' | 'carve' | 'oddgrid' | 'static'
/** The styles painted by a shader field rather than a canvas generator. */
export type MosaicShaderFill = 'oddgrid' | 'static'

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
  { style: 'carve', cellFill: 'carve', label: 'Carve' },
  { style: 'oddgrid', cellFill: 'oddgrid', label: 'Oddgrid' },
  { style: 'static', cellFill: 'static', label: 'Static' },
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

// ── The shader styles (Oddgrid / Static) ──────────────────────────────────────

export const MOSAIC_SHADER_FILLS: readonly MosaicShaderFill[] = ['oddgrid', 'static']
export function isMosaicShaderFill(v: unknown): v is MosaicShaderFill {
  return v === 'oddgrid' || v === 'static'
}

/** A Look's params keyed the way a ShaderSpec stores them (WITHOUT the `u_`
 *  prefix — see resolveEffectParams / unprefixedKey in shaderfill/descriptor). */
function lookParams(look: EffectLook): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {}
  for (const [k, v] of Object.entries(look.params)) out[unprefixedKey(k)] = v
  return out
}

/** The Looks an effect declares (the shader styles' "Palette"), in preset order. */
export function mosaicLooks(effectId: string): readonly EffectLook[] {
  return EFFECT_LOOKS[effectId] ?? []
}
export function mosaicLookNames(effectId: string): string[] {
  return mosaicLooks(effectId).map(l => l.name)
}

/**
 * The ShaderSpec a shader style paints with. Seeded from the effect's FIRST Look
 * (the rest of the effect's params fall to the manifest defaults at resolve time —
 * resolveEffectParams fills every declared param), with:
 *  - `seed` = the layer's `grid.gen.seed`, so New variation re-rolls the shader like
 *    every other style (the seed is part of the field cache key — fieldKey /
 *    specIdentityKey in shaderfill/descriptor);
 *  - `speed: 0`: a mosaic is a still composition, and a non-zero speed would make
 *    hasAnimatedShaderFill start a wall clock for it;
 *  - `anchor: 'frame'`: an object-anchored field is a fixed 1024² stretched to the
 *    box (OBJECT_SHADER_FIELD_PX in paint/resolve), which would squash the shader's
 *    square cells on any non-square mosaic. Frame-anchored, the field renders at the
 *    frame's own aspect. The deal branch in useCompositorLayers then swaps the frame
 *    for the BOX (its size and base transform) while it paints, so the field is
 *    really rendered at the box's own aspect and travels with the box; the
 *    inspector hides the Anchor toggle for a mosaic since the box is the frame.
 * `prev` (the layer's current spec) is kept when it already targets `effectId` —
 * only its seed is re-synced — so hopping Pane → Oddgrid → Pane → Oddgrid keeps the
 * dials a person set.
 */
export function mosaicShaderSpec(effectId: MosaicShaderFill, seed: number, prev?: ShaderSpec): ShaderSpec {
  if (prev && prev.effectId === effectId) return prev.seed === seed ? prev : { ...prev, seed }
  const first = mosaicLooks(effectId)[0]
  return {
    effectId,
    params: first ? lookParams(first) : {},
    anchor: 'frame',
    speed: 0,
    seed,
    input: structuredClone(DEFAULT_SHADER_SPEC.input),
  }
}

/** The Fill a shader-style mosaic hands to resolvePaint — and the Paint
 *  `layerPaints('deal')` must return so the shader-field pre-pass renders it. The
 *  Fill's scalar fields are DEFAULT_FILL's (only `.shader` matters for
 *  type 'shader'; `.a` is the last-resort fill when a pattern can't be created). */
export function mosaicShaderFill(spec: ShaderSpec): Fill {
  return { ...DEFAULT_FILL, type: 'shader', shader: spec }
}

/** The shader Fill a deal layer currently paints with, or null for the canvas
 *  styles. Structural so this module never imports the composable at runtime. A
 *  shader style whose layer has no `shader` yet (an agent-made layer, a hand-edited
 *  save) still paints: the spec is derived on the fly at the layer's seed. */
export function dealShaderFill(layer: { cellFill?: string; shader?: ShaderSpec; grid: { gen: { seed: number } } }): Fill | null {
  if (!isMosaicShaderFill(layer.cellFill)) return null
  return mosaicShaderFill(mosaicShaderSpec(layer.cellFill, layer.grid.gen.seed, layer.shader))
}

/** The Look the spec's params currently match, or '' when none does ("Custom"):
 *  a colour entry matches by hex (case-blind), a number by value — the same rule
 *  ShaderStudioSurface's currentLook uses. */
export function mosaicLookOf(spec: ShaderSpec): string {
  const hit = mosaicLooks(spec.effectId).find(look => Object.entries(lookParams(look)).every(([k, v]) => {
    const cur = spec.params[k]
    if (typeof v === 'string') return typeof cur === 'string' && cur.toLowerCase() === v.toLowerCase()
    return typeof cur === 'number' && Math.abs(cur - (v as number)) < 1e-6
  }))
  return hit?.name ?? ''
}

/** The canonical Look name `raw` spells for `effectId` (case-insensitive), or null. */
export function mosaicLookNameIn(effectId: string, raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const lc = raw.trim().toLowerCase()
  return mosaicLookNames(effectId).find(n => n.toLowerCase() === lc) ?? null
}

/** A new spec with the named Look's params laid over the current ones (a Look
 *  names only the params it means to set). Unknown name ⇒ the spec unchanged. */
export function applyMosaicLook(spec: ShaderSpec, name: string): ShaderSpec {
  const look = mosaicLooks(spec.effectId).find(l => l.name === name)
  if (!look) return spec
  return { ...spec, params: { ...spec.params, ...lookParams(look) } }
}

// ── Layer patches shared by the inspector and the agent ───────────────────────

/**
 * The patch that switches a mosaic to `fill`: seeds that style's config with its
 * defaults when absent (a shader style: its ShaderSpec at the layer's seed, kept
 * when it already targets that effect). Never touches the box or `grid.gen.seed`,
 * so a style hop keeps the layer, its placement and its variation.
 */
export function mosaicStylePatch(layer: DealLayer, fill: MosaicCellFill): Partial<DealLayer> {
  const patch: Partial<DealLayer> = { cellFill: fill }
  if (fill === 'pane') patch.pane = layer.pane ?? defaultPane()
  if (fill === 'modular') patch.modular = layer.modular ?? defaultModular()
  if (fill === 'parcel') patch.parcel = layer.parcel ?? defaultParcel()
  if (fill === 'mosh') patch.mosh = layer.mosh ?? defaultMosh()
  if (fill === 'carve') patch.carve = layer.carve ?? defaultCarve()
  if (isMosaicShaderFill(fill)) {
    // Prefer the spec last used for THIS effect (stashed below on the way out), then
    // the live slot when it already targets it, else a fresh one at the layer's seed.
    const stashed = layer.shaderSpecs?.[fill]
    patch.shader = mosaicShaderSpec(fill, layer.grid.gen.seed, stashed ?? layer.shader)
  }
  // Stash the spec of the style being left so the hop back restores its dials.
  if (isMosaicShaderFill(layer.cellFill) && layer.shader && layer.cellFill !== fill) {
    patch.shaderSpecs = { ...layer.shaderSpecs, [layer.cellFill]: layer.shader }
  }
  return patch
}

/** The patch that sets a mosaic's seed: `grid.gen.seed` AND, when the layer carries
 *  a ShaderSpec, its `seed` — the two are one variation. Used by New variation and
 *  the Seed dial alike. */
export function mosaicSeedPatch(layer: DealLayer, seed: number): Partial<DealLayer> {
  const s = Math.max(1, Math.round(seed))
  const patch: Partial<DealLayer> = { grid: { ...layer.grid, gen: { ...layer.grid.gen, seed: s } } }
  if (layer.shader) patch.shader = { ...layer.shader, seed: s }
  return patch
}
/** A fresh random seed in the same 1..9999 range every re-roll in the app uses. */
export function freshMosaicSeed(): number {
  return Math.floor(Math.random() * 9999) + 1
}
