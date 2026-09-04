import type { Params } from '~/lib/spacetype/effect'
// Three-free settings home (see settings.ts's own header) — safe for the Collection
// resolver's dynamic import graph, since controls.ts (which imports this file)
// is dynamically imported by collection/studioControls.ts.
import { DEFAULT_POST, type PostSettings } from '~/lib/studio/post/settings'

export const LATTICES = ['square', 'brick', 'diagonal'] as const
// Procedural motifs. Appended entries keep the original indices stable (the GLSL
// mirror in renderer.ts dispatches on u_motif by index, and saved scenes store the
// string). rings/squares/diamonds are concentric-band figures; waves/zigzag are
// wavy line rows; cross is a per-cell plus; graph is graph-paper (minor+major grid).
export const MOTIFS = ['checker', 'stripes', 'dots', 'grid', 'rings', 'squares', 'diamonds', 'waves', 'zigzag', 'cross', 'graph'] as const

export type Lattice = typeof LATTICES[number]
export type Motif = typeof MOTIFS[number]

// JSON clone — safe on Vue reactive proxies (structuredClone is not).
export function cloneParams<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

// Content modes. APPEND ONLY — renderer.ts dispatches on MODES.indexOf(mode) and
// saved scenes store the string. 'chips' (index 4) is the first non-lattice mode:
// irregular scattered cells (terrazzo/mosaic/pebbles), see pattern.ts's chipSample.
// 'dealtgrid' (index 5) is the tileable cousin of the Frame's generative deal — a
// rigid cells×cells grid where each cell hashes a colour role, a density drop, and
// a size-variance inset; see pattern.ts's dealtGridSample.
export const MODES = ['procedural', 'truchet', 'raster', 'shapes', 'chips', 'dealtgrid'] as const
// Truchet tile families. multiscale MUST stay at index 3 — the GLSL reads it as a
// bounded band (u_family in [2.5,3.5]) and the render() state-texture path keys on
// the 'multiscale' string. maze/arcs2/arcdot are appended (indices 4-6): maze =
// 10-PRINT straight diagonals, arcs2 = double concentric arcs, arcdot = arcs + a
// centre dot. All three flow through the same placement/coherence state machinery.
export const TILE_FAMILIES = ['arcs', 'diagonal', 'weave', 'multiscale', 'maze', 'arcs2', 'arcdot'] as const
export const SEAM_METHODS = ['mirror', 'feather', 'direct'] as const
export const SHAPE_FAMILIES = ['octagon', 'pinwheel', 'chevron', 'basketweave', 'herringbone', 'fishscale', 'pythagorean', 'hex', 'cairo', 'cubes', 'weave3d', 'tripods', 'triangles', 'diamond', 'shippou', 'seigaiha'] as const

export type Mode = typeof MODES[number]
export type SeamMethod = typeof SEAM_METHODS[number]
export type TileFamily = typeof TILE_FAMILIES[number]
export type ShapeFamily = typeof SHAPE_FAMILIES[number]

export const PLACEMENTS = ['random', 'structured'] as const
export type Placement = typeof PLACEMENTS[number]

export const STYLIZE_KINDS = ['none', 'dither', 'posterize', 'duotone'] as const
export type StylizeKind = typeof STYLIZE_KINDS[number]

// Curated, tileable dither patterns (label → bayer_dither u_pattern value).
export const DITHER_PATTERNS: Record<string, number> = {
  'Bayer 4×4': 1, 'Fine 8×8': 2, 'Coarse 2×2': 0, 'Clustered': 3,
  'Blue noise': 8, 'Blue noise 2×': 9, 'Blue noise ½×': 10,
}
// Pattern value → tiling period (cells-across must be a multiple of this for seamlessness).
export const DITHER_PERIOD: Record<number, number> = { 0: 2, 1: 4, 2: 8, 3: 8, 8: 64, 9: 128, 10: 32 }

export const STYLIZE_EFFECT_ID: Record<string, string> = {
  dither: 'bayer_dither', posterize: 'posterize', duotone: 'duotone',
}

export const FILL_TYPES = ['solid', 'gradient', 'image', 'pattern', 'link'] as const
export const FILL_FRAMES = ['cell', 'tile'] as const
export const GRADIENT_KINDS = ['linear', 'radial'] as const
export type FillType = typeof FILL_TYPES[number]
export type Frame = typeof FILL_FRAMES[number]
export type GradientStop = { c: string; p: number }
export type Fill =
  | { type: 'solid'; color: string; opacity?: number }
  | { type: 'gradient'; frame: Frame; kind: 'linear' | 'radial'; angle: number; stops: GradientStop[]; opacity?: number }
  | { type: 'image'; frame: Frame; src: string; seam: string; scale: number; opacity?: number }
  | { type: 'pattern'; frame: Frame; scale: number; sub: Record<string, unknown>; opacity?: number }
  | { type: 'link'; to: string }
export type FillsByRole = Record<string, Fill>

// Shared post-processing stack — see ~/lib/studio/post. Texture has no nested
// config object (Params is flat, see ~~/shared/spacetype/state.ts), so unlike
// Gradient's `cfg.post: PostSettings` field + ensureConfigDefaults backfill,
// post settings live as flat `post.<key>` entries in Params (added to
// TEXTURE_CONTROLS by controls.ts's `...postControls({ host: 'gl2d' })`, so
// textureDefaults()/loadParams()'s `{ ...textureDefaults(), ...cloneParams(p) }`
// merge already backfills a legacy config's missing post.* keys the same way
// it backfills any other control default — see TextureStudioSurface.vue's
// loadParams()).
//
// This function is the OTHER half of that defaulting: it builds the nested
// PostSettings object applyPost() needs out of the flat Params the renderer
// actually has, falling back to DEFAULT_POST key-by-key for a Params object
// that was never merged against textureDefaults() at all (e.g. a raw
// agent/Collection patch, or exportBlob's overrides path in
// TextureStudioSurface.vue, which writes `params[key] = value` directly).
export function postSettingsFromParams(p: Params): PostSettings {
  const out = { ...DEFAULT_POST }
  for (const key of Object.keys(DEFAULT_POST) as (keyof PostSettings)[]) {
    const v = p[`post.${key}`]
    if (v === undefined) continue
    const dflt = DEFAULT_POST[key]
    if (typeof dflt === 'boolean') (out[key] as boolean) = Boolean(v)
    else if (typeof dflt === 'number') (out[key] as number) = Number(v)
    else (out[key] as string) = String(v)
  }
  return out
}
