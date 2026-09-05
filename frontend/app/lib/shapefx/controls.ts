import type { ControlSpec } from '~/lib/spacetype/effect'
import { HARMONY_TYPES } from '~/lib/color/harmony'
import { FILL_TYPES } from '~/lib/spacetype/fillTile'
import { DEFAULT_CONFIG, PRIMS, type ShapeConfig } from './config'
// postControls is three-free by construction (see its own header) — safe to import
// here despite this module's own three-free constraint. Do NOT import chain.ts
// (applyPost) from this file; that lives in engine.ts, the three-aware half of
// this studio.
import { postControls, POST_SECTIONS } from '~/lib/studio/post/controls'

/**
 * The single declarative description of Shape Studio's parameters.
 *
 * Source for the agent's vocabulary (`shapeAgentControls`) and for Collection
 * variable binding / sweeps (`lib/collection/studioControls.ts`). Keys are dotted
 * paths resolved by `makeConfigParams`, so each one must address a real leaf on
 * ShapeConfig — pinned by a test.
 *
 * Deliberately NOT here: the section lock toggles (re-roll metadata, and there is
 * no `switch` kind), the read-only palette preview, the derived base-colour
 * swatch (its three sliders are here individually), the transparent-background
 * union, and canvas size / orbit (both live outside ShapeConfig).
 *
 * Must stay free of `three` imports — this module is dynamically loaded by the
 * Collection control resolver.
 */
export type ShapeControl = ControlSpec & { when?: (cfg: ShapeConfig) => boolean }

/** Emission order; a control whose group is not listed here is dropped.
 *  POST_SECTIONS (Bloom, Color, Duotone, ...) is appended so the shared post
 *  stack's sections land after Style — see the `...postControls(...)` below. */
export const SHAPE_SECTIONS = ['Form', 'Shape', 'Palette', 'Fill', 'Style', ...POST_SECTIONS] as const

const isPrimitive = (c: ShapeConfig) => c.shape.mode === 'primitive'
const isGem = (c: ShapeConfig) => c.shape.mode === 'gem'
const isFacets = (c: ShapeConfig) => c.fillMode === 'facets'
const isSurface = (c: ShapeConfig) => c.fillMode === 'surface'
const isNotScatter = (c: ShapeConfig) => c.palette.coloring !== 'scatter'
// Mirrors ShapeStudioSurface.vue:135-137 exactly.
const fillNeedsB = (c: ShapeConfig) => c.fill.type !== 'solid'
const fillHasAngle = (c: ShapeConfig) => c.fill.type === 'ombre' || c.fill.type === 'stripes'
const fillHasDensity = (c: ShapeConfig) => ['grid', 'checkerboard', 'stripes', 'qr'].includes(c.fill.type)

// Same primitive-kind literal PRIMITIVE_OPTIONS declares locally in
// Derived from config.ts's PRIMS so the two can never drift apart.
const PRIMITIVE_KINDS = [...PRIMS]

const slider = (
  key: string, label: string, min: number, max: number, step: number, group: string,
  def: number, hint?: string, extra: Partial<ShapeControl> = {},
): ShapeControl =>
  ({ key, label, kind: 'slider', min, max, step, default: def, group, ...(hint ? { hint } : {}), ...extra } as ShapeControl)

const select = (
  key: string, label: string, options: string[], def: string, group: string,
  hint?: string, extra: Partial<ShapeControl> = {},
): ShapeControl =>
  ({ key, label, kind: 'select', options, default: def, group, ...(hint ? { hint } : {}), ...extra } as ShapeControl)

const color = (key: string, label: string, def: string, group: string, extra: Partial<ShapeControl> = {}): ShapeControl =>
  ({ key, label, kind: 'color', default: def, group, ...extra } as ShapeControl)

export const SHAPE_CONTROLS: ShapeControl[] = [
  // --- Form ---------------------------------------------------------------
  select('fillMode', 'Fill mode', ['facets', 'surface'], DEFAULT_CONFIG.fillMode, 'Form',
    'Facets = per-face colours from the palette; Surface = one tiled fill over the whole solid'),

  // --- Shape ----------------------------------------------------------------
  select('shape.mode', 'Mode', ['primitive', 'gem'], DEFAULT_CONFIG.shape.mode, 'Shape'),
  select('shape.primitive', 'Primitive', PRIMITIVE_KINDS, DEFAULT_CONFIG.shape.primitive, 'Shape', undefined, { when: isPrimitive }),
  slider('shape.density', 'Density', 0, 4, 1, 'Shape', DEFAULT_CONFIG.shape.density, undefined, { when: isPrimitive }),
  slider('shape.vertices', 'Vertices', 4, 40, 1, 'Shape', DEFAULT_CONFIG.shape.vertices, undefined, { when: isGem }),
  slider('shape.depth', 'Depth', 0.2, 2, 0.05, 'Shape', DEFAULT_CONFIG.shape.depth, undefined, { when: isGem }),
  slider('shape.spread', 'Spread', 0.1, 1, 0.05, 'Shape', DEFAULT_CONFIG.shape.spread, undefined, { when: isGem }),
  slider('shape.jitter', 'Jitter', 0, 100, 1, 'Shape', DEFAULT_CONFIG.shape.jitter),
  slider('shape.scale', 'Scale', 0.25, 3, 0.05, 'Shape', DEFAULT_CONFIG.shape.scale),
  select('shape.projection', 'Projection', ['orthographic', 'perspective'], DEFAULT_CONFIG.shape.projection, 'Shape'),

  // --- Palette (facets only) -------------------------------------------------
  select('palette.harmony', 'Harmony', [...HARMONY_TYPES], DEFAULT_CONFIG.palette.harmony, 'Palette', undefined, { when: isFacets }),
  slider('palette.baseHue', 'Hue', 0, 360, 1, 'Palette', DEFAULT_CONFIG.palette.baseHue, undefined, { when: isFacets }),
  slider('palette.saturation', 'Saturation', 0, 100, 1, 'Palette', DEFAULT_CONFIG.palette.saturation, undefined, { when: isFacets }),
  slider('palette.lightness', 'Lightness', 0, 100, 1, 'Palette', DEFAULT_CONFIG.palette.lightness, undefined, { when: isFacets }),
  select('palette.coloring', 'Coloring', ['prismatic', 'smooth', 'faceted', 'ombre', 'scatter'], DEFAULT_CONFIG.palette.coloring, 'Palette', undefined, { when: isFacets }),
  select('palette.direction', 'Direction', ['vertical', 'depth', 'radial', 'angular'], DEFAULT_CONFIG.palette.direction, 'Palette', undefined,
    { when: (c) => isFacets(c) && isNotScatter(c) }),

  // --- Fill (surface only) ----------------------------------------------------
  select('fill.type', 'Fill type', [...FILL_TYPES], DEFAULT_CONFIG.fill.type, 'Fill', undefined, { when: isSurface }),
  color('fill.a', 'Color 1', DEFAULT_CONFIG.fill.a, 'Fill', { when: isSurface }),
  color('fill.b', 'Color 2', DEFAULT_CONFIG.fill.b, 'Fill', { when: (c) => isSurface(c) && fillNeedsB(c) }),
  slider('fill.angle', 'Angle', 0, 360, 1, 'Fill', DEFAULT_CONFIG.fill.angle, undefined, { when: (c) => isSurface(c) && fillHasAngle(c) }),
  slider('fill.density', 'Density', 2, 32, 1, 'Fill', DEFAULT_CONFIG.fill.density, undefined, { when: (c) => isSurface(c) && fillHasDensity(c) }),

  // --- Style ------------------------------------------------------------------
  // Grain retired (Task 8) — moved into the shared post stack's own Grain section below.
  slider('style.distortion', 'Distortion', 0, 100, 1, 'Style', DEFAULT_CONFIG.style.distortion),
  color('style.background', 'Background', DEFAULT_CONFIG.style.background, 'Style'),

  // --- Shared post stack (Bloom/Color/Duotone/...) -----------------------------
  // host: 'gl2d' — Shape is 3D-rendered but has no depth/normal buffers wired for
  // ambient occlusion (see engine.ts's applyPost call), so gtao's controls are
  // withheld the same way Gradient/Texture withhold them.
  ...postControls({ host: 'gl2d' }),
]

/** Controls applicable to this config, in SHAPE_SECTIONS order. */
export function visibleShapeControls(cfg: ShapeConfig): ShapeControl[] {
  const out: ShapeControl[] = []
  for (const section of SHAPE_SECTIONS) {
    for (const c of SHAPE_CONTROLS) {
      if (c.group !== section) continue
      if (c.when && !c.when(cfg)) continue
      out.push(c)
    }
  }
  return out
}

/**
 * Domain guidance for the in-product agent (consumed by a later task's
 * `shapeAgentControls` / `studioTune` wiring). Teaches the model how Shape
 * Studio's knobs combine — a faceted low-poly solid (gems and primitives)
 * coloured either by a per-facet palette or a tiled surface fill.
 */
export const SHAPE_GUIDANCE = `This is a PROCEDURAL FACETED 3D SHAPE generator — low-poly gems and primitives, not text or a flat gradient.

SHAPE FIRST: shape.mode picks the family. "primitive" = shape.primitive (cube/sphere/cone/cylinder/prism/torus/icosahedron/octahedron) + shape.density (facet subdivision, 0=coarsest). "gem" = a randomized hull from shape.vertices, shape.depth (Z elongation) and shape.spread (point-cloud spread) — use this for asymmetric crystal/gem looks. shape.jitter crumples the vertices (0=clean, higher=organic/broken). shape.scale is overall size; shape.projection switches the camera between orthographic (flat, graphic) and perspective (depth).

COLOUR: fillMode picks ONE of two mutually exclusive colouring systems.
- "facets" — each face gets its own colour from a generated HARMONY_TYPES palette (palette.harmony + palette.baseHue/saturation/lightness set the ramp). palette.coloring picks how the ramp maps onto the solid: prismatic (per-facet gradient, cut-gem shimmer), smooth (one gradient sweeps the surface), faceted (flat per-facet tone progressing smoothly), ombre (grainy dither), scatter (random discrete swatch per facet — the low-poly confetti look, ignores palette.direction). palette.direction (vertical/depth/radial/angular) sets which axis smooth/faceted ramps follow.
- "surface" — one tiled fill.type (solid/gradient/ombre/grid/noise/checkerboard/stripes/qr) painted over the whole solid using fill.a (+ fill.b for anything but solid). fill.angle applies to ombre/stripes; fill.density (tile count) applies to grid/checkerboard/stripes/qr.

STYLE: style.distortion warps the render, style.background is the canvas colour behind the shape. Grain is post.grain (on/off) + post.grainAmount (0-1) in the shared post stack, not a Style control.

Set fillMode + its matching colour controls together; don't set palette.* while fillMode is "surface" or fill.* while it's "facets" — the other set is invisible to the user.`
