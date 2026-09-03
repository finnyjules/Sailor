import type { ControlSpec } from '~/lib/spacetype/effect'
import {
  DEFAULT_CONFIG,
  type GeoShapeConfig,
  type GeoLayout,
  type GeoFillMode,
  type GeoOverlapMode,
  type GeoSymmetryAxis,
  type GeoClipMask,
  type GeoCrossingMode,
  BLEND_EASES,
  FILL_CYCLES,
  PAINT_TARGETS,
} from './config'
import { BASE_SHAPES, type BaseShapeKind } from './shapes'
import type { Paint } from '~/lib/compositor/paint'

/**
 * The single declarative description of geologo's parameters.
 *
 * Mirrors `shapefx/controls.ts`'s posture: source for the agent's vocabulary
 * (`geoAgentControls`, in `agentControls.ts`) and for `StudioControlPanel`.
 * Keys are flat — every leaf on `GeoShapeConfig` is a top-level field, unlike
 * ShapeConfig's nested `shape.*`/`palette.*` — so control keys equal config
 * keys 1:1, pinned by the drift-guard test.
 *
 * Deliberately NOT here: `locks` (section-lock metadata, not a renderable
 * parameter).
 */
export type GeoControl = ControlSpec & { when?: (cfg: GeoShapeConfig) => boolean }

/** Emission order; a control whose group is not listed here is dropped. */
export const GEO_SECTIONS = ['Shape', 'Layout', 'Blend', 'Transform', 'Composite', 'Symmetry', 'Clip', 'Style', 'Paint'] as const

// Mirror of config.ts's own (private) enum lists — kept local rather than
// exported from config.ts because Task 7's commit stages only the new lib
// files, not a config.ts edit. Keep these in sync with config.ts's
// SHAPES/LAYOUTS/FILLMODES/OVERLAPMODES/SYMMETRY_AXES/CLIP_MASKS if that
// file's enums ever grow.
//
// Exported so randomize.ts (and any other geoshape module) shares this one
// copy instead of keeping its own verbatim duplicate.
export const SHAPES: BaseShapeKind[] = BASE_SHAPES
export const LAYOUTS: GeoLayout[] = ['radial', 'grid', 'linear', 'blend']
export const FILLMODES: GeoFillMode[] = ['evenodd', 'unite', 'subtract', 'intersect', 'exclude']
export const OVERLAPMODES: GeoOverlapMode[] = ['hole', 'shape']
export const SYMMETRY_AXES: GeoSymmetryAxis[] = ['vertical', 'horizontal']
export const CLIP_MASKS: GeoClipMask[] = ['none', 'circle', 'square', 'hexagon']
export const CROSSING_MODES: GeoCrossingMode[] = ['depth', 'split']

// --- visibility gates, mirroring shapefx/controls.ts's isPrimitive/isGem/etc. ---
// `sides` drives polygon/star/irregular (baseShapePath's o.sides); hexagon is a
// fixed 6-gon and ignores it (see shapes.ts).
const usesSides = (c: GeoShapeConfig) => c.shape === 'star' || c.shape === 'irregular'
const isStar = (c: GeoShapeConfig) => c.shape === 'star'
const isIrregular = (c: GeoShapeConfig) => c.shape === 'irregular'
const hasRoundCorners = (c: GeoShapeConfig) => c.roundCorners > 0
const isLibrary = (c: GeoShapeConfig) => c.shape === 'library'
const notLibrary = (c: GeoShapeConfig) => c.shape !== 'library'
const isGrid = (c: GeoShapeConfig) => c.layout === 'grid'
const isRadial = (c: GeoShapeConfig) => c.layout === 'radial'
const isGridOrLinear = (c: GeoShapeConfig) => c.layout === 'grid' || c.layout === 'linear'
const hasStagger = (c: GeoShapeConfig) => c.stagger !== 'off' && isGridOrLinear(c)
const hasStaggerGrid = (c: GeoShapeConfig) => c.stagger !== 'off' && c.layout === 'grid'
const isOverlapShape = (c: GeoShapeConfig) => c.overlapMode === 'shape'
const isSingleFill = (c: GeoShapeConfig) => c.fillStrategy === 'single'
const isOverlapShapeAndSingleFill = (c: GeoShapeConfig) => isOverlapShape(c) && isSingleFill(c)
const isMultiFill = (c: GeoShapeConfig) => c.fillStrategy !== 'single'
const isPieces = (c: GeoShapeConfig) => c.fillStrategy === 'pieces'
const hasSymmetry = (c: GeoShapeConfig) => c.symmetry === true
const hasClipMask = (c: GeoShapeConfig) => c.clipMask !== 'none'
const isBlend = (c: GeoShapeConfig) => c.layout === 'blend'
const blendUsesSides = (c: GeoShapeConfig) => isBlend(c) && (c.blendShape === 'star' || c.blendShape === 'irregular')
const blendIsStar = (c: GeoShapeConfig) => isBlend(c) && c.blendShape === 'star'
const blendIsIrregular = (c: GeoShapeConfig) => isBlend(c) && c.blendShape === 'irregular'
const blendIsLibrary = (c: GeoShapeConfig) => isBlend(c) && c.blendShape === 'library'
const hasOutline = (c: GeoShapeConfig) => c.stroke !== null || c.paintTarget !== 'fill'

/** A `Paint` reduced to a `color`-control default: solids pass through,
 *  gradients/patterns/images fall back to a plain swatch — the schema's `fill`/
 *  `overlapFill` controls stay declared as `kind: 'color'` (drift-guard + agent
 *  vocabulary need them there) even though the surface renders them bespoke via
 *  FillControl, which can hold the full `Paint`. */
const paintDefault = (p: Paint): string => (typeof p === 'string' ? p : '#111111')

const slider = (
  key: string, label: string, min: number, max: number, step: number, group: string,
  def: number, hint?: string, extra: Partial<GeoControl> = {},
): GeoControl =>
  ({ key, label, kind: 'slider', min, max, step, default: def, group, ...(hint ? { hint } : {}), ...extra } as GeoControl)

const select = (
  key: string, label: string, options: string[], def: string, group: string,
  hint?: string, extra: Partial<GeoControl> = {},
): GeoControl =>
  ({ key, label, kind: 'select', options, default: def, group, ...(hint ? { hint } : {}), ...extra } as GeoControl)

const color = (key: string, label: string, def: string, group: string, extra: Partial<GeoControl> = {}): GeoControl =>
  ({ key, label, kind: 'color', default: def, group, ...extra } as GeoControl)

const switchC = (key: string, label: string, def: boolean, group: string, extra: Partial<GeoControl> = {}): GeoControl =>
  ({ key, label, kind: 'switch', default: def, group, ...extra } as GeoControl)

/** A shape-library picker row (ControlSpec `kind: 'shape'`). `allowNone` defaults
 *  to false — every consumer here needs an actual shape — and stays overridable
 *  through `extra`, exactly like the other builders' optional fields. */
const shapeC = (
  key: string, label: string, def: string, group: string,
  hint?: string, extra: Partial<GeoControl> = {},
): GeoControl =>
  ({ key, label, kind: 'shape', allowNone: false, default: def, group, ...(hint ? { hint } : {}), ...extra } as GeoControl)

export const GEO_CONTROLS: GeoControl[] = [
  // --- Shape (baseShapePath's BaseShapeOpts) --------------------------------
  select('shape', 'Shape', SHAPES, DEFAULT_CONFIG.shape, 'Shape',
    'polygon/star/irregular use Sides; hexagon is a fixed 6-gon; library clones one of the 100 drawn shapes (Library shape)'),
  shapeC('libraryShape', 'Library shape', DEFAULT_CONFIG.libraryShape, 'Shape',
    'library only: which of the 100 drawn shapes is cloned (sparkle, sun-rays, leaf, heart, swirl…)', { when: isLibrary }),
  slider('sides', 'Sides', 3, 24, 1, 'Shape', DEFAULT_CONFIG.sides, undefined, { when: usesSides }),
  // DEFAULT_CONFIG.starInner is 0.45, already inside starVertices' own
  // [0.01, 0.99] clamp (polygonGeometry.ts), so this control's default sits
  // inside its own declared range without needing help.
  slider('starInner', 'Star inner', 0.01, 0.99, 0.01, 'Shape', DEFAULT_CONFIG.starInner, undefined, { when: isStar }),
  slider('irregularSeed', 'Irregular seed', 1, 9999, 1, 'Shape', DEFAULT_CONFIG.irregularSeed, undefined, { when: isIrregular }),
  slider('size', 'Size', 20, 600, 1, 'Shape', DEFAULT_CONFIG.size),
  slider('roundCorners', 'Round corners', 0, 100, 1, 'Shape', DEFAULT_CONFIG.roundCorners,
    '0 = sharp corners; above 0 rounds by Round radius', { when: notLibrary }),
  slider('roundRadius', 'Round radius', 0, 100, 1, 'Shape', DEFAULT_CONFIG.roundRadius, undefined, { when: (c) => hasRoundCorners(c) && notLibrary(c) }),

  // --- Layout (arrange.ts) --------------------------------------------------
  select('layout', 'Layout', LAYOUTS, DEFAULT_CONFIG.layout, 'Layout'),
  slider('count', 'Count', 1, 200, 1, 'Layout', DEFAULT_CONFIG.count, undefined, { when: (c) => !isGrid(c) }),
  slider('gridCols', 'Grid columns', 1, 24, 1, 'Layout', DEFAULT_CONFIG.gridCols, undefined, { when: isGrid }),
  slider('gridRows', 'Grid rows', 1, 24, 1, 'Layout', DEFAULT_CONFIG.gridRows, undefined, { when: isGrid }),
  slider('radius', 'Radius', 0, 800, 1, 'Layout', DEFAULT_CONFIG.radius, undefined, { when: isRadial }),
  slider('spacing', 'Spacing', 0, 800, 1, 'Layout', DEFAULT_CONFIG.spacing, undefined, { when: isGridOrLinear }),
  switchC('evenAngle', 'Even spacing', DEFAULT_CONFIG.evenAngle, 'Layout', { when: isRadial }),
  slider('angleStep', 'Angle step', 0, 360, 1, 'Layout', DEFAULT_CONFIG.angleStep, undefined, { when: (c) => isRadial(c) && !c.evenAngle }),
  select('stagger', 'Stagger', ['off', 'incremental', 'alternate'], DEFAULT_CONFIG.stagger, 'Layout',
    'Shift successive columns/rows by a step: incremental cascades (0, s, 2s…); alternate bricks every other one (0, s, 0, s…)',
    { when: isGridOrLinear }),
  slider('stepX', 'Step X', -400, 400, 1, 'Layout', DEFAULT_CONFIG.stepX, undefined, { when: hasStagger }),
  slider('stepY', 'Step Y', -400, 400, 1, 'Layout', DEFAULT_CONFIG.stepY, undefined, { when: hasStagger }),
  select('stepAxis', 'Step by', ['column', 'row'], DEFAULT_CONFIG.stepAxis, 'Layout',
    'Which grid index the stagger steps by — column pushes columns down/over, row does the classic brick offset',
    { when: hasStaggerGrid }),

  // --- Blend (layout 'blend': the steps between shape A and shape B) --------
  select('blendShape', 'Blend to', SHAPES, DEFAULT_CONFIG.blendShape, 'Blend',
    'The shape the steps run toward. Same choices as Shape; Count is the number of steps. Detailed library shapes blend with fewer points per outline, so a many-piece shape stays fast.', { when: isBlend }),
  shapeC('blendLibraryShape', 'Blend to library shape', DEFAULT_CONFIG.blendLibraryShape, 'Blend',
    'library only: which of the 100 drawn shapes the steps run toward', { when: blendIsLibrary }),
  slider('blendSides', 'Blend to sides', 3, 24, 1, 'Blend', DEFAULT_CONFIG.blendSides, undefined, { when: blendUsesSides }),
  slider('blendStarInner', 'Blend to star inner', 0.01, 0.99, 0.01, 'Blend', DEFAULT_CONFIG.blendStarInner, undefined, { when: blendIsStar }),
  slider('blendIrregularSeed', 'Blend to irregular seed', 1, 9999, 1, 'Blend', DEFAULT_CONFIG.blendIrregularSeed, undefined, { when: blendIsIrregular }),
  slider('blendSize', 'Blend to size', 20, 600, 1, 'Blend', DEFAULT_CONFIG.blendSize, 'Size of the shape the steps run toward', { when: isBlend }),
  slider('blendRotate', 'Blend to rotation', -180, 180, 1, 'Blend', DEFAULT_CONFIG.blendRotate, 'Turns the target shape; the steps twist to meet it', { when: isBlend }),
  slider('blendX', 'Blend to X', -800, 800, 1, 'Blend', DEFAULT_CONFIG.blendX, 'Where the target shape sits, left to right. 0 = on top of the base shape', { when: isBlend }),
  slider('blendY', 'Blend to Y', -800, 800, 1, 'Blend', DEFAULT_CONFIG.blendY, 'Where the target shape sits, up and down', { when: isBlend }),
  select('blendEase', 'Spacing', [...BLEND_EASES], DEFAULT_CONFIG.blendEase, 'Blend',
    'How the steps bunch up: even, toward the start, toward the end, or toward both ends',
    { when: isBlend, optionLabels: ['Even', 'Ease in', 'Ease out', 'Ease in-out'] }),
  slider('blendTwist', 'Twist', 0, 1, 0.01, 'Blend', DEFAULT_CONFIG.blendTwist,
    'Rotates which point of the base shape meets which point of the target — small values spiral the outlines', { when: isBlend }),

  // --- Transform (per-clone ramps in arrange.ts) ----------------------------
  slider('rotateBase', 'Rotate base', -180, 180, 1, 'Transform', DEFAULT_CONFIG.rotateBase),
  slider('rotateStep', 'Rotate step', -180, 180, 1, 'Transform', DEFAULT_CONFIG.rotateStep),
  slider('scaleStart', 'Scale start', 0.1, 3, 0.05, 'Transform', DEFAULT_CONFIG.scaleStart),
  slider('scaleEnd', 'Scale end', 0.1, 3, 0.05, 'Transform', DEFAULT_CONFIG.scaleEnd),
  slider('skew', 'Skew', -60, 60, 1, 'Transform', DEFAULT_CONFIG.skew),
  slider('spin', 'Spin', 0, 360, 1, 'Transform', DEFAULT_CONFIG.spin, undefined, { when: isRadial }),

  // --- Composite (boolean.ts's fold + overlap resolution) -------------------
  // Single-mode only: fillMode/overlapMode govern the unified boolean FOLD.
  // perClone and pieces return before the fold (each clone drawn separately /
  // split into pieces), so these have no effect there — hide them so they don't
  // read as ignored knobs.
  select('fillMode', 'Fill mode', FILLMODES, DEFAULT_CONFIG.fillMode, 'Composite',
    'How the clones fold together: evenodd cuts holes where they cross, unite/subtract/intersect/exclude are true boolean ops',
    { when: isSingleFill }),
  select('overlapMode', 'Overlap mode', OVERLAPMODES, DEFAULT_CONFIG.overlapMode, 'Composite',
    'hole = crossings read as a cut-through; shape = crossings paint as their own region in Overlap fill',
    { when: isSingleFill }),
  color('overlapFill', 'Overlap fill', paintDefault(DEFAULT_CONFIG.overlapFill), 'Composite', { when: isOverlapShapeAndSingleFill }),

  // --- Symmetry --------------------------------------------------------------
  switchC('symmetry', 'Symmetry', DEFAULT_CONFIG.symmetry, 'Symmetry'),
  select('symmetryAxis', 'Symmetry axis', SYMMETRY_AXES, DEFAULT_CONFIG.symmetryAxis, 'Symmetry', undefined, { when: hasSymmetry }),
  slider('symmetrySpacing', 'Symmetry spacing', 0, 400, 1, 'Symmetry', DEFAULT_CONFIG.symmetrySpacing, undefined, { when: hasSymmetry }),

  // --- Clip --------------------------------------------------------------------
  select('clipMask', 'Clip mask', CLIP_MASKS, DEFAULT_CONFIG.clipMask, 'Clip'),
  slider('clipMaskSize', 'Clip mask size', 10, 200, 1, 'Clip', DEFAULT_CONFIG.clipMaskSize, undefined, { when: hasClipMask }),
  switchC('invert', 'Invert', DEFAULT_CONFIG.invert, 'Clip'),

  // --- Style -------------------------------------------------------------------
  slider('padding', 'Padding', -400, 200, 1, 'Style', DEFAULT_CONFIG.padding,
    'Space framed around the mark. Lower it to grow the mark toward the canvas edges; 0 fills the canvas edge-to-edge; negative overscans so the mark bleeds past the edges and crops to fill the whole canvas.'),
  slider('strokeWidth', 'Stroke width', 0, 60, 0.25, 'Style', DEFAULT_CONFIG.strokeWidth, 'Outline thickness. Below 1 gives hairlines for stacked outlines', { when: hasOutline }),
  slider('seed', 'Seed', 1, 999999, 1, 'Style', DEFAULT_CONFIG.seed,
    'The random seed behind Re-roll; use Re-roll to generate variations.'),

  // --- Paint ---------------------------------------------------------------
  // `fills` and `overlapFills` (the cycled-list counterparts of `fill` and
  // `overlapFill`, the latter feeding `pieces` mode's overlap palette) have
  // no control of their own — they're edited by bespoke list editors
  // (ShapeStudioSurface's fills-list block), not a single-value row — so
  // they're excluded from the drift guard's expected-key set alongside
  // `locks` (see that test's NON_CONTROL_FIELDS).
  select('fillStrategy', 'Fill', ['single', 'perClone', 'pieces'], DEFAULT_CONFIG.fillStrategy, 'Paint',
    'single = unified holes; perClone = one colour per shape; pieces = colour solo + overlap regions'),
  select('fillOrder', 'Colour order', ['created', 'depth', 'leftRight', 'topBottom', 'rows', 'columns', 'centerOut', 'around'], DEFAULT_CONFIG.fillOrder, 'Paint',
    'order colours are handed out in (rows = reading order; around = colour wheel)', { when: isMultiFill }),
  switchC('overlapSeparate', 'Separate overlap colours', DEFAULT_CONFIG.overlapSeparate, 'Paint', { when: isPieces }),
  select('crossingMode', 'Crossings', ['depth', 'split'], DEFAULT_CONFIG.crossingMode, 'Paint',
    'depth = one colour per overlap depth; split = each crossing its own piece, coloured by the colour order', { when: isPieces }),
  select('fillCycle', 'Colour ramp', [...FILL_CYCLES], DEFAULT_CONFIG.fillCycle, 'Paint',
    'cycle = repeat the colour list; ramp = fade smoothly through it across all the copies',
    { when: isMultiFill, optionLabels: ['Cycle', 'Ramp'] }),
  select('paintTarget', 'Colour applies to', [...PAINT_TARGETS], DEFAULT_CONFIG.paintTarget, 'Paint',
    'fill = solid shapes (the default); outline = thin outlines only, no fill; both = fill and outline in the same colour',
    { optionLabels: ['Fill', 'Outline', 'Both'] }),
  color('fill', 'Fill', paintDefault(DEFAULT_CONFIG.fill), 'Paint', { when: isSingleFill }),
  color('stroke', 'Stroke', DEFAULT_CONFIG.stroke ?? '#000000', 'Paint'),
]

/** Controls applicable to this config, in GEO_SECTIONS order. */
export function visibleGeoControls(cfg: GeoShapeConfig): GeoControl[] {
  const out: GeoControl[] = []
  for (const section of GEO_SECTIONS) {
    for (const c of GEO_CONTROLS) {
      if (c.group !== section) continue
      if (c.when && !c.when(cfg)) continue
      out.push(c)
    }
  }
  return out
}

/**
 * Domain guidance for the in-product agent (consumed by `geoAgentControls` /
 * `studioTune` wiring). Teaches the model how geologo's knobs combine — a
 * single base shape, cloned and arranged, then boolean-folded into one mark.
 */
export const GEO_GUIDANCE = `This is a PROCEDURAL 2D-VECTOR "clone and arrange" LOGO generator — one base shape, repeated and folded into a single flat mark, not a raster illustration.

BASE SHAPE: "shape" picks the family — polygon (regular N-gon via sides), star (N points via sides + starInner, the inner-vertex radius as a fraction of the outer radius, 0.01=needle-thin points, 0.99=almost a polygon), hexagon (fixed 6-gon, ignores sides), irregular (a polygon jittered per-vertex by irregularSeed — same seed always gives the same silhouette), library (one of the 100 drawn library shapes, chosen by libraryShape — sparkle, sun-rays, leaf, heart, swirl…; sides and corner rounding do not apply). size is the shape's full width/height (its larger side) before any clone spread. roundCorners (0=off) gates roundRadius, the corner-rounding fraction.

LAYOUT: count is how many clones to place (grid layout instead uses gridCols × gridRows and ignores count). layout picks the placement curve: "radial" rings the clones around the center at radius; by default (evenAngle) they spread evenly (360/count) so any count forms a clean ring, and turning evenAngle off spaces them by angleStep degrees instead (for fans/spirals). spin is the ring's starting angle offset. "grid" tiles gridCols × gridRows clones spacing apart. "linear" strings count clones in a row, spacing apart. "blend" draws the steps between the base shape and a second shape (see BLEND). For grid/linear, stagger (incremental|alternate) shifts successive columns/rows by (stepX, stepY) — incremental cascades progressively (a diagonal shear), alternate offsets every other one (a brick/zigzag); stepAxis chooses whether a grid steps by column or row.

TRANSFORM: rotateBase + i*rotateStep rotates each successive clone (a spiral/fan feel as rotateStep grows). scaleStart→scaleEnd ramps clone size across the sequence (shrink/grow trails). skew shears every clone; spin only matters for radial layout.

COMPOSITE: fillMode is the boolean fold across all clones (evenodd = classic cut-hole overlap; unite/subtract/intersect/exclude are true boolean ops). overlapMode governs crossings specifically — "hole" cuts through, "shape" paints the crossing itself in overlapFill (a spot-color trick: use it to highlight where clones intersect).

SYMMETRY mirrors the whole composed mark across symmetryAxis (vertical/horizontal), offset by symmetrySpacing. CLIP crops the finished mark to clipMask (circle/square/hexagon) sized by clipMaskSize; invert swaps the mark's fill/ground so the shape reads as negative space.

STYLE: padding is the margin framed around the mark in the preview, the PNG, and the SVG alike — lower it to grow the mark toward the canvas edges, 0 fills the canvas edge-to-edge, and NEGATIVE padding overscans so the mark bleeds past the edges and crops to fill the whole canvas on both axes (this is the lever for "make it bigger / fill the canvas / bleed off the edges", NOT size, which is the base shape's own width/height and is auto-fit into the frame). strokeWidth is the outline width wherever stroke is set. seed drives irregularSeed-style jitter and re-roll — same seed, same mark.

PAINT: fill colors the mark, stroke outlines it (leave stroke unset for a fill-only flat mark, the common logo case), overlapFill only matters when overlapMode is "shape". fillStrategy switches between one flat fill (single), one colour per clone (per-clone), or per-piece colouring with its own overlap regions (pieces); fillOrder sets the sequence those colours are handed out in (creation order, depth, left-to-right, top-to-bottom, row-by-row, column-by-column, center-out, or around like a colour wheel) whenever fillStrategy isn't single, and overlapSeparate (pieces only) gives crossing regions their own colours instead of reusing the piece colours. crossingMode (pieces only) picks how those crossings are cut: "depth" gives every overlap depth one shared colour, "split" breaks each crossing into its own piece coloured by fillOrder.

BLEND: layout "blend" draws count steps between the base shape and a second shape. blendShape picks the target's family (same choices as shape; blendSides / blendStarInner / blendIrregularSeed / blendLibraryShape apply the same way), blendSize its size, blendRotate turns it, blendX / blendY put its centre relative to the base shape (0,0 = concentric — the classic ring-of-outlines look), blendEase bunches the steps (linear / ease in / ease out / ease in-out), and blendTwist rotates which point of the base meets which point of the target so the stacked outlines spiral and moiré. The rotation and scale ramps still apply on top.

STACKED OUTLINES RECIPE: "blend", "stacked outlines", "moiré lines", "die doing", "gradient made of lines", "line art blend" all mean ONE look — layout "blend" with fillStrategy set to the per-clone strategy, paintTarget "outline", fillCycle "ramp", count 80–200, strokeWidth 0.5–1, two or three vivid fills, stroke unset, blendTwist 0.05–0.2. Worked example (add fillStrategy set to the per-clone strategy alongside this JSON): {"layout":"blend","paintTarget":"outline","fillCycle":"ramp","count":140,"strokeWidth":0.75,"blendShape":"circle","blendSize":260,"blendX":90,"blendTwist":0.1}. paintTarget also works in every other layout: "outline only" / "just the outlines" = paintTarget "outline"; fillCycle "ramp" turns a two-colour fills list into a smooth fade across the copies in any layout.`
