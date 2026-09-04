import { defaultsFromControls, type ControlSpec, type Params } from '~/lib/spacetype/effect'
import { DITHER_PATTERNS, LATTICES, MODES, MOTIFS, PLACEMENTS, SEAM_METHODS, SHAPE_FAMILIES, STYLIZE_KINDS, TILE_FAMILIES } from '~/lib/texturefx/types'
import { SHEET_PRESET_CUSTOM, SHEET_PRESET_TILE, SHEET_PRESETS, TILE_PX_OPTIONS } from '~/lib/texturefx/sheet'
import { postControls } from '~/lib/studio/post/controls'

// Texture controls extend the shared ControlSpec with an optional `when`
// predicate for contextual reveal (e.g. show procedural controls only in
// procedural mode). The predicate reads the live params object.
export type TextureControl = ControlSpec & { when?: (p: Params) => boolean }

// Positive checks — `mode` is always defined (textureDefaults sets it).
const isProcedural = (p: Params) => String(p.mode) === 'procedural'
const isTruchet = (p: Params) => String(p.mode) === 'truchet'
const isRaster = (p: Params) => String(p.mode) === 'raster'
const isShapes = (p: Params) => String(p.mode) === 'shapes'
const isChips = (p: Params) => String(p.mode) === 'chips'
const isDealtGrid = (p: Params) => String(p.mode) === 'dealtgrid'

// Which figure motifs read which knob. `bands` = concentric-band / wave-hump count;
// `waveAmp` = wave amplitude; `lineWeight` = mark thickness (grid + the line figures).
const FIGURE_BANDS = new Set(['rings', 'squares', 'diamonds', 'waves', 'zigzag'])
const FIGURE_WAVE = new Set(['waves', 'zigzag'])
const FIGURE_LINEWEIGHT = new Set(['grid', 'waves', 'zigzag', 'cross', 'graph'])

export const TEXTURE_CONTROLS: TextureControl[] = [
  // Lattice controls — hidden in raster mode (raster is whole-tile, no lattice),
  // in chips mode (chips scatter on their own grid, sized by 'Chips across'), and
  // in dealt-grid mode (it owns its own grid, sized by 'Cells across').
  { key: 'lattice', label: 'Lattice', kind: 'select', options: [...LATTICES], default: 'square', group: 'Lattice', when: (p) => !isRaster(p) && !isChips(p) && !isDealtGrid(p) },
  { key: 'cells', label: 'Cells', kind: 'slider', min: 2, max: 40, step: 2, default: 8, group: 'Lattice', when: (p) => !isRaster(p) && !isChips(p) && !isDealtGrid(p) },

  { key: 'mode', label: 'Content', kind: 'select', options: [...MODES], default: 'procedural', group: 'Cell' },
  { key: 'shapeFamily', label: 'Shape', kind: 'select', options: [...SHAPE_FAMILIES], default: 'octagon', group: 'Cell', when: isShapes },
  { key: 'pinwheel', label: 'Pinwheel', kind: 'select', options: ['off', 'on'], default: 'on', group: 'Cell', when: (p) => isShapes(p) && String(p.shapeFamily) === 'pinwheel' },
  { key: 'hexOrient', label: 'Orientation', kind: 'select', options: ['pointy', 'flat'], default: 'pointy', group: 'Cell', when: (p) => isShapes(p) && String(p.shapeFamily) === 'hex' },
  // fishscale + seigaiha share the scallop lattice geometry, so they share these knobs.
  { key: 'fsWidth', label: 'Scale width', kind: 'slider', min: 0.4, max: 2.0, step: 0.05, default: 1.0, group: 'Cell', when: (p) => isShapes(p) && (String(p.shapeFamily) === 'fishscale' || String(p.shapeFamily) === 'seigaiha') },
  { key: 'fsRowSpacing', label: 'Row spacing', kind: 'slider', min: 0.2, max: 0.9, step: 0.02, default: 0.5, group: 'Cell', when: (p) => isShapes(p) && (String(p.shapeFamily) === 'fishscale' || String(p.shapeFamily) === 'seigaiha') },
  { key: 'fsRadius', label: 'Arc radius', kind: 'slider', min: 0.55, max: 1.0, step: 0.01, default: 0.78, group: 'Cell', when: (p) => isShapes(p) && (String(p.shapeFamily) === 'fishscale' || String(p.shapeFamily) === 'seigaiha') },
  { key: 'seigaihaRings', label: 'Rings', kind: 'slider', min: 2, max: 8, step: 1, default: 5, group: 'Cell', when: (p) => isShapes(p) && String(p.shapeFamily) === 'seigaiha' },
  { key: 'shippouRadius', label: 'Circle overlap', kind: 'slider', min: 0.5, max: 0.9, step: 0.01, default: 0.62, group: 'Cell', when: (p) => isShapes(p) && String(p.shapeFamily) === 'shippou' },
  { key: 'weaveWidth', label: 'Strand width', kind: 'slider', min: 0.14, max: 0.42, step: 0.01, default: 0.34, group: 'Cell', when: (p) => isShapes(p) && String(p.shapeFamily) === 'weave3d' },
  // Arm reach (radial) sets hole size: ~0.577 = hexagon corner (tiny holes / near-solid
  // cubes); lower = bigger hexagonal recesses. Arm width sets how fat the arms are.
  { key: 'armLength', label: 'Arm reach', kind: 'slider', min: 0.48, max: 0.72, step: 0.01, default: 0.6, group: 'Cell', when: (p) => isShapes(p) && String(p.shapeFamily) === 'tripods' },
  { key: 'armWidth', label: 'Arm width', kind: 'slider', min: 0.25, max: 0.5, step: 0.01, default: 0.4, group: 'Cell', when: (p) => isShapes(p) && String(p.shapeFamily) === 'tripods' },
  { key: 'bevel', label: 'Bevel', kind: 'slider', min: 0, max: 0.7, step: 0.01, default: 0.45, group: 'Cell', when: (p) => isShapes(p) && String(p.shapeFamily) === 'tripods' },

  // Procedural motif controls — shown only in procedural mode.
  { key: 'motif', label: 'Motif', kind: 'select', options: [...MOTIFS], default: 'checker', group: 'Content', when: isProcedural },
  // 'Motif size' only affects dots (radius) + stripes (width); checker/grid are
  // sized by 'Cells'. 'Line weight' is only used by the grid motif. Reveal each
  // only where it does something, so neither reads as a dead slider.
  { key: 'scale', label: 'Motif size', kind: 'slider', min: 0.1, max: 1, step: 0.01, default: 0.7, group: 'Content', when: (p) => isProcedural(p) && (String(p.motif) === 'dots' || String(p.motif) === 'stripes') },
  { key: 'lineWeight', label: 'Line weight', kind: 'slider', min: 0.02, max: 0.5, step: 0.01, default: 0.12, group: 'Content', when: (p) => isProcedural(p) && FIGURE_LINEWEIGHT.has(String(p.motif)) },
  // Figure-motif knobs. 'Repeat' drives concentric-band count (rings/squares/diamonds)
  // and wave-hump count (waves/zigzag); 'Wave depth' is the wave amplitude; 'Major every'
  // is the graph-paper heavy-rule interval.
  { key: 'bands', label: 'Repeat', kind: 'slider', min: 2, max: 16, step: 1, default: 6, group: 'Content', when: (p) => isProcedural(p) && FIGURE_BANDS.has(String(p.motif)) },
  { key: 'waveAmp', label: 'Wave depth', kind: 'slider', min: 0, max: 0.45, step: 0.01, default: 0.3, group: 'Content', when: (p) => isProcedural(p) && FIGURE_WAVE.has(String(p.motif)) },
  { key: 'majorEvery', label: 'Major every', kind: 'slider', min: 2, max: 8, step: 1, default: 4, group: 'Content', when: (p) => isProcedural(p) && String(p.motif) === 'graph' },
  // Shared by procedural (swaps the two inks per cell) and chips (shifts each
  // chip's lightness) — see chipTone() in pattern.ts for why they differ.
  { key: 'jitter', label: 'Color jitter', kind: 'slider', min: 0, max: 1, step: 0.01, default: 0, group: 'Content', when: (p) => isProcedural(p) || isChips(p) },

  // Truchet controls — shown only in truchet mode.
  { key: 'tileFamily', label: 'Tile family', kind: 'select', options: [...TILE_FAMILIES], default: 'arcs', group: 'Truchet', when: isTruchet },
  { key: 'placement', label: 'Placement', kind: 'select', options: [...PLACEMENTS], default: 'random', group: 'Truchet', when: (p) => isTruchet(p) && String(p.tileFamily) !== 'multiscale' },
  { key: 'rotBias', label: 'Rotation bias', kind: 'slider', min: 0, max: 1, step: 0.01, default: 0.5, group: 'Truchet', when: (p) => isTruchet(p) && String(p.tileFamily) !== 'multiscale' && String(p.placement) === 'random' },
  { key: 'coherence', label: 'Coherence', kind: 'slider', min: 0, max: 1, step: 0.01, default: 0.6, group: 'Truchet', when: (p) => isTruchet(p) && String(p.tileFamily) !== 'multiscale' && String(p.placement) === 'structured' },
  { key: 'subdivide', label: 'Subdivide', kind: 'slider', min: 0, max: 1, step: 0.01, default: 0.5, group: 'Truchet', when: (p) => isTruchet(p) && String(p.tileFamily) === 'multiscale' },
  // 'Line weight' sizes the arc/band stroke — used by arcs, weave, multiscale.
  // Hidden for diagonal (a solid two-tone split has no stroke to size).
  { key: 'truchetWeight', label: 'Line weight', kind: 'slider', min: 0.06, max: 0.5, step: 0.01, default: 0.18, group: 'Truchet', when: (p) => isTruchet(p) && String(p.tileFamily) !== 'diagonal' },

  // Chips controls — irregular scattered cells (terrazzo, mosaic, pebbles,
  // stained glass). 'Chips across' is the wrapped cell-noise grid (chips are
  // roughly one per cell, so it reads as chip count / size); 'Density' is the
  // fraction of those cells that draw a chip at all (1 = fully packed, the
  // original look; lower scatters them on bare ground); 'Grout width' is
  // how wide the ground shows between neighbouring chips; 'Chip size variance'
  // blends every chip identical → wildly mixed sizes. Colour jitter (above)
  // varies each chip's tone. See pattern.ts's chipSample() for the math.
  { key: 'chipCells', label: 'Chips across', kind: 'slider', min: 4, max: 24, step: 1, default: 12, group: 'Chips', when: isChips },
  // Default 1 is load-bearing, not cosmetic: it reproduces the fully-packed field
  // byte for byte, so every terrazzo saved before this control looks unchanged
  // (and double-click reset returns to it). The 0.15 floor keeps the slider's low
  // end usefully sparse rather than near-bare — it does NOT by itself stop a blank
  // tile (it bounds the drop RATE, and 16 cells all dropping is a real 7% of
  // seeds). What guarantees a visible chip is chipKeepCell()'s force-kept cell
  // PLUS its exemption from grout while forced — keeping the cell alone still let
  // a wide Grout width swallow it. See chipSample().
  { key: 'chipDensity', label: 'Density', kind: 'slider', min: 0.15, max: 1, step: 0.01, default: 1, group: 'Chips', when: isChips },
  { key: 'chipGrout', label: 'Grout width', kind: 'slider', min: 0, max: 0.25, step: 0.005, default: 0.05, group: 'Chips', when: isChips },
  { key: 'chipSizeVar', label: 'Chip size variance', kind: 'slider', min: 0, max: 1, step: 0.01, default: 0.7, group: 'Chips', when: isChips },

  // Dealt grid controls — a rigid cells×cells grid, tileable by construction (every
  // per-cell quantity is hashed on the WRAPPED cell index). 'Cells across' sizes the
  // grid; 'Density' is the fraction of cells that draw at all (1 = every cell filled,
  // lower scatters filled cells on the ground); 'Size variance' insets each filled
  // square toward its centre for an irregular-tile / gutter look (0 = flush rigid
  // grid). Colours come from the two inks + ground (roles.ts's dealtgrid family).
  // See pattern.ts's dealtGridSample() for the cell math.
  { key: 'dgCells', label: 'Cells across', kind: 'slider', min: 2, max: 24, step: 1, default: 8, group: 'Dealt grid', when: isDealtGrid },
  { key: 'dgDensity', label: 'Density', kind: 'slider', min: 0.15, max: 1, step: 0.01, default: 1, group: 'Dealt grid', when: isDealtGrid },
  { key: 'dgSizeVar', label: 'Size variance', kind: 'slider', min: 0, max: 1, step: 0.01, default: 0, group: 'Dealt grid', when: isDealtGrid },

  // Stroke controls — outline the boundaries between regions in shapes mode.
  // 'uniform' = one stroke color on all edges; 'per-role' = each region's edge
  // takes its own stroke color (Stroke A/B/C → role 0/1/2).
  { key: 'shapeStroke', label: 'Stroke', kind: 'select', options: ['off', 'uniform', 'per-role'], default: 'off', group: 'Stroke', when: isShapes },
  { key: 'shapeStrokeWidth', label: 'Stroke width', kind: 'slider', min: 0.01, max: 0.4, step: 0.01, default: 0.08, group: 'Stroke', when: (p) => isShapes(p) && String(p.shapeStroke) !== 'off' },
  { key: 'shapeStrokeColor', label: 'Stroke color', kind: 'color', default: '#0e1116', group: 'Stroke', when: (p) => isShapes(p) && String(p.shapeStroke) === 'uniform' },
  { key: 'shapeStrokeA', label: 'Stroke A', kind: 'color', default: '#0e1116', group: 'Stroke', when: (p) => isShapes(p) && String(p.shapeStroke) === 'per-role' },
  { key: 'shapeStrokeB', label: 'Stroke B', kind: 'color', default: '#0e1116', group: 'Stroke', when: (p) => isShapes(p) && String(p.shapeStroke) === 'per-role' },
  { key: 'shapeStrokeC', label: 'Stroke C', kind: 'color', default: '#0e1116', group: 'Stroke', when: (p) => isShapes(p) && String(p.shapeStroke) === 'per-role' },

  { key: 'colorA', label: 'Color A', kind: 'color', default: '#e8eef5', group: 'Fills', when: () => false },
  { key: 'colorB', label: 'Color B', kind: 'color', default: '#7aa2f7', group: 'Fills', when: () => false },
  { key: 'background', label: 'Background', kind: 'color', default: '#0e1116', group: 'Fills', when: () => false },

  // Raster controls — rasterSrc is set by the surface's import button, not here.
  { key: 'seamMethod', label: 'Seamless method', kind: 'select', options: [...SEAM_METHODS], default: 'mirror', group: 'Raster', when: isRaster },
  { key: 'feather', label: 'Seam feather', kind: 'slider', min: 0.02, max: 0.5, step: 0.01, default: 0.15, group: 'Raster', when: (p) => isRaster(p) && String(p.seamMethod) === 'feather' },
  { key: 'rasterScale', label: 'Image scale', kind: 'slider', min: 0.25, max: 4, step: 0.05, default: 1, group: 'Raster', when: isRaster },

  { key: 'stylize', label: 'Stylize', kind: 'select', options: [...STYLIZE_KINDS], default: 'none', group: 'Stylize' },
  { key: 'ditherPattern', label: 'Dither pattern', kind: 'select', options: Object.keys(DITHER_PATTERNS), default: 'Bayer 4×4', group: 'Stylize', when: (p) => String(p.stylize) === 'dither' },
  { key: 'ditherScale', label: 'Dither size', kind: 'slider', min: 0.004, max: 0.05, step: 0.001, default: 0.012, group: 'Stylize', when: (p) => String(p.stylize) === 'dither' },
  { key: 'ditherLevels', label: 'Dither levels', kind: 'slider', min: 2, max: 8, step: 1, default: 3, group: 'Stylize', when: (p) => String(p.stylize) === 'dither' },
  { key: 'ditherColor', label: 'Dither color', kind: 'select', options: ['color', 'mono'], default: 'color', group: 'Stylize', when: (p) => String(p.stylize) === 'dither' },
  { key: 'posterizeLevels', label: 'Posterize levels', kind: 'slider', min: 2, max: 12, step: 1, default: 5, group: 'Stylize', when: (p) => String(p.stylize) === 'posterize' },
  { key: 'duoShadow', label: 'Shadow hue', kind: 'slider', min: 0, max: 1, step: 0.01, default: 0.62, group: 'Stylize', when: (p) => String(p.stylize) === 'duotone' },
  { key: 'duoLight', label: 'Light hue', kind: 'slider', min: 0, max: 1, step: 0.01, default: 0.12, group: 'Stylize', when: (p) => String(p.stylize) === 'duotone' },
  { key: 'duoContrast', label: 'Duotone contrast', kind: 'slider', min: 0, max: 2, step: 0.01, default: 0.5, group: 'Stylize', when: (p) => String(p.stylize) === 'duotone' },

  // --- Output: the exported sheet. `Tile · square` (the default) makes the sheet
  //     exactly one tile — 1024x1024 from a 1024 tile, i.e. what this studio produced
  //     before the sheet existed, so every already-saved pattern exports unchanged.
  //     lib/texturefx/sheet.ts resolves these into the {w,h,tile} every render path uses.
  { key: 'sheetPreset', label: 'Sheet', kind: 'select', options: [...SHEET_PRESETS], default: SHEET_PRESET_TILE, group: 'Output', hint: 'Picks the exported FILE\'s dimensions, not the look of the pattern. To change the motif itself, use the Content/Lattice/Stylize controls instead.' },
  { key: 'sheetW', label: 'Width', kind: 'slider', min: 128, max: 8192, step: 64, default: 1024, group: 'Output', when: (p) => String(p.sheetPreset) === SHEET_PRESET_CUSTOM, hint: 'Sets the exported file\'s pixel width when Sheet is Custom. Does not change the pattern\'s appearance.' },
  { key: 'sheetH', label: 'Height', kind: 'slider', min: 128, max: 8192, step: 64, default: 1024, group: 'Output', when: (p) => String(p.sheetPreset) === SHEET_PRESET_CUSTOM, hint: 'Sets the exported file\'s pixel height when Sheet is Custom. Does not change the pattern\'s appearance.' },
  // Tile size is the density dial: the same motif reads fine or coarse depending on how
  // many times the tile fits the sheet.
  { key: 'tilePx', label: 'Tile size', kind: 'select', options: [...TILE_PX_OPTIONS], default: '1024', group: 'Output', hint: 'Sets how large one repeating tile is in the exported file. To make the motif itself finer or coarser, use Cells instead.' },

  // --- Post (shared stack: bloom/color/duotone/chroma/blur/film/halftone/dotScreen/
  //     glitch/grain/vignette — ambient occlusion withheld, 2D host). Runs INSIDE
  //     TextureFxRenderer.render() (see renderer.ts), before the surface's separate
  //     stylizeTile() dither/posterize/duotone pass — the two are independent stages,
  //     not layered by this control list's order. ---------------------------------
  ...postControls({ host: 'gl2d' }),
]

// Numeric seed lives outside the control list (driven by the Roll button).
export function textureDefaults(): Params {
  return { ...defaultsFromControls(TEXTURE_CONTROLS), seed: 1 }
}
