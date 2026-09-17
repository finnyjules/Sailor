// F8 · The declarative table of which per-layer EFFECT dials can be animated.
//
// Today's effect inspector rows are hand-written per kind; this module is the one
// place that says, for every EffectKind, which of its interface fields is an
// animatable motion target and how it behaves. `effectTracks.ts` reads it to
// enumerate a layer's targets (`effectDialTargets`); Task 2's evaluator and Task 3's
// fold read the `kind` to know whether to lerp (number), colour-mix (color), or step.
//
// The guard that keeps this honest (a unit, the F8 acceptance gate): EVERY `key` here
// must be a real top-level field on the matching effect's interface — proven by
// constructing `createEffect(kind)` and asserting `key in it`. A dead key (a renamed
// or removed field) would name a dial that resolves to nothing, exactly the trap the
// id-path resolver was built to refuse.
//
// v1 scope (resolved with Julien 2026-09-15): NUMBERS and COLOURS only. Excluded, on
// purpose, and never listed here:
//   - seeds (`seed`) — a deterministic knob, not a value to interpolate;
//   - enum / pick fields (boolean `op`, warp `field`, overlay `blend`, stroke `align`,
//     torn-edge `style`, feather `curve`) and sibling refs (`refLayerId`) — stepped
//     dials whose authoring UX is a deferred follow-up;
//   - nested / complex fields (gradient overlay is from/to not stops, shader/
//     backdrop_shader `params` objects, the shader instance `id`);
//   - `visible` — the show/hide toggle, not a dial.
// `enum` and `bool` stay in `DialKind` for when those land; the SCHEMA emits `number`,
// `color`, and — for gradientMap's `stops` (Plan 3) — `gradient` this slice.
//
// Pure: no Vue, no canvas, no DOM.
import type { EffectKind } from './effectStack'

export type DialKind = 'number' | 'color' | 'enum' | 'bool' | 'gradient'

export interface DialSpec {
  key: string
  label: string
  kind: DialKind
  min?: number
  max?: number
}

const num = (key: string, label: string, min: number, max: number): DialSpec => ({ key, label, kind: 'number', min, max })
const col = (key: string, label: string): DialSpec => ({ key, label, kind: 'color' })
const grad = (key: string, label: string): DialSpec => ({ key, label, kind: 'gradient' })

/**
 * The animatable dials of every effect kind. A TOTAL record over `EffectKind` — TS
 * refuses to compile if a kind is missing an entry, so a new effect kind cannot be
 * added without a deliberate decision about its dials (`[]` when it has none, e.g.
 * `boolean`, whose only fields are an op enum and a sibling ref). Ranges mirror the
 * inspector clamps (`POST_FX_PARAM_CLAMP` for the F4/dof post effects; the interface
 * comments for the rest).
 */
export const EFFECT_DIAL_SCHEMA: Record<EffectKind, DialSpec[]> = {
  // ── backdrop / pinned ──────────────────────────────────────────────────────────
  background_blur: [num('radius', 'Blur radius', 0, 0.5)],
  backdrop_shader: [num('speed', 'Speed', 0, 4)],
  backdrop_luminance_mask: [num('threshold', 'Threshold', 0, 1), num('softness', 'Softness', 0, 1)],
  dof: [
    num('focus', 'Focus', 0, 1),
    num('range', 'Range', 0, 1),
    num('aperture', 'Aperture', 0, 1),
    num('bladeCount', 'Blade count', 0, 12),
    num('bladeRotation', 'Blade rotation', 0, 360),
    num('bloomThreshold', 'Bloom threshold', 0, 1),
    num('bloomStrength', 'Bloom strength', 0, 4),
  ],
  // ── geometry (F2/F3) ───────────────────────────────────────────────────────────
  trim: [num('start', 'Start', 0, 1), num('end', 'End', 0, 1), num('offset', 'Offset', 0, 1)],
  offset: [num('distance', 'Distance', -0.2, 0.2)],
  round_corners: [num('radius', 'Radius', 0, 0.5)],
  roughen: [num('amount', 'Amount', 0, 0.5), num('detail', 'Detail', 1, 32)],
  boolean: [], // op (enum) + refLayerId (sibling ref) only — nothing to animate.
  morph: [num('amount', 'Amount', 0, 1)], // refLayerId excluded (sibling ref).
  warp: [num('amount', 'Amount', -1, 1), num('frequency', 'Frequency', 0, 12)], // field excluded (enum).
  shatter: [num('cells', 'Cells', 0, 64), num('gap', 'Gap', 0, 0.05)], // seed excluded.
  long_shadow: [num('angle', 'Angle', 0, 360), num('length', 'Length', 0, 0.5), col('color', 'Colour')],
  // ── pixel — shadows / glows ──────────────────────────────────────────────────────
  inner_shadow: [num('x', 'Offset X', -0.1, 0.1), num('y', 'Offset Y', -0.1, 0.1), num('blur', 'Blur', 0, 0.2), col('color', 'Colour')],
  inner_glow: [num('radius', 'Radius', 0, 0.5), num('intensity', 'Intensity', 0, 2), col('color', 'Colour')],
  // ── pixel — tone / colour (F4) ───────────────────────────────────────────────────
  adjust: [num('brightness', 'Brightness', 0, 2), num('contrast', 'Contrast', 0, 2), num('saturation', 'Saturation', 0, 2), num('hue', 'Hue', -180, 180)],
  levels: [num('black', 'Black point', 0, 1), num('white', 'White point', 0, 1), num('gamma', 'Gamma', 0.1, 5)],
  posterise: [num('levels', 'Levels', 2, 32)],
  threshold: [num('cutoff', 'Cutoff', 0, 1)],
  invert: [num('amount', 'Amount', 0, 1)],
  duotone: [col('shadows', 'Shadows'), col('highlights', 'Highlights'), num('mix', 'Mix', 0, 1)],
  gradientMap: [num('contrast', 'Contrast', -1, 1), num('mix', 'Mix', 0, 1), num('scrollPhase', 'Scroll', 0, 1), grad('stops', 'Ramp')], // scroll rides a scalar phase; stops is a gradient-kind dial (a stop array, not a scalar).
  color_overlay: [col('color', 'Colour'), num('opacity', 'Opacity', 0, 1)], // blend excluded (enum).
  gradient_overlay: [col('from', 'From colour'), col('to', 'To colour'), num('angle', 'Angle', 0, 360), num('opacity', 'Opacity', 0, 1)], // blend excluded.
  stroke_from_alpha: [num('width', 'Width', 0, 0.2), col('color', 'Colour')], // align excluded (enum).
  shader: [num('speed', 'Speed', 0, 4)], // effectId/params/seed/id excluded.
  // ── pixel — post (F4) ────────────────────────────────────────────────────────────
  bloom: [num('threshold', 'Threshold', 0, 1), num('radius', 'Radius', 0, 0.5), num('intensity', 'Intensity', 0, 2)],
  vignette: [num('amount', 'Amount', 0, 1), num('size', 'Size', 0, 1), num('softness', 'Softness', 0, 1)],
  grain: [num('amount', 'Amount', 0, 1), num('size', 'Size', 1, 8)],
  // Torn edge distances are in px (not normalised, unlike everything else) — ranges reflect that.
  torn_edge: [
    num('amount', 'Amount', 0, 100),
    num('roughness', 'Roughness', 0, 1),
    num('grain', 'Grain', 0, 50),
    num('grainTexture', 'Grain texture', 0, 1),
    num('lipWidth', 'Lip width', 0, 50),
    num('lipVariation', 'Lip variation', 0, 1),
    col('lipColor', 'Lip colour'),
  ], // style (enum) + seed excluded.
  feather: [num('amount', 'Amount', 0, 1)], // curve excluded (enum).
  rough_edge: [num('amount', 'Amount', 0, 1), num('detail', 'Detail', 1, 32)], // seed excluded.
  ink_bleed: [num('amount', 'Amount', 0, 1), num('softness', 'Softness', 0, 1)], // seed excluded.
  // ── pixel — print recipes (F7) ───────────────────────────────────────────────────
  risograph: [col('ink', 'Ink'), col('inkTwo', 'Second ink'), num('levels', 'Levels', 2, 8), num('grain', 'Grain', 0, 1), num('contrast', 'Contrast', 0.5, 2)],
  photocopy: [num('threshold', 'Threshold', 0, 1), num('dirt', 'Dirt', 0, 1), num('contrast', 'Contrast', 0.5, 3)],
  letterpress: [num('depth', 'Depth', 0, 1), col('ink', 'Ink'), num('paper', 'Paper', 0, 1)],
  // ── pixel — motion blur / trailing blur / stamp ──────────────────────────────────
  directional_blur: [num('angle', 'Angle', 0, 360), num('distance', 'Distance', 0, 0.2)],
  radial_blur: [num('centerX', 'Centre X', 0, 1), num('centerY', 'Centre Y', 0, 1), num('amount', 'Amount', 0, 1)],
  zoom_blur: [num('centerX', 'Centre X', 0, 1), num('centerY', 'Centre Y', 0, 1), num('amount', 'Amount', 0, 1)],
  layer_blur: [num('radius', 'Blur radius', 0, 0.5)],
  outer_glow: [num('radius', 'Radius', 0, 0.5), num('intensity', 'Intensity', 0, 2), col('color', 'Colour')],
  drop_shadow: [num('x', 'Offset X', -0.1, 0.1), num('y', 'Offset Y', -0.1, 0.1), num('blur', 'Blur', 0, 0.2), col('color', 'Colour')],
}

/** The animatable dials of one effect kind (`[]` for a kind with none). */
export function dialSpecsFor(kind: EffectKind): DialSpec[] {
  return EFFECT_DIAL_SCHEMA[kind] ?? []
}
