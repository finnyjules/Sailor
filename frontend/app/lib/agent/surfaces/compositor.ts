/**
 * Compositor (Frame) agent surface (F1, 2nd Phase-2 home). Wraps the local-layer
 * model (useCompositorLayers) so the agent can read a frame and change it through
 * named, invertible commands — the same shape as the Smart Layout surface.
 * Pure: every function takes a CompositorState and returns data or a fresh state.
 *
 * State = the local layers + the document background. The composable bridges this
 * to `node.data.properties.sailor_localLayers` + the background, and runs the
 * media ops (generate/edit/remove-bg) which need async backend calls.
 */
import { layerMaskRef, localLayerBox, type LocalLayer, type LocalLayerKind, type Paint, type TextLayer } from '~/composables/useCompositorLayers'
import type { Command, CommandResult, CommandSpec, SurfaceSnapshot } from '~/lib/agent/commandSurface'
import { contrastRatio, parseColor, type LayoutIssue } from '~/lib/agent/verify'
import { SWISS_LIMITS } from '~/lib/agent/designPrinciples'
import { defaultPostEffect, POST_EFFECT_DEFAULTS, POST_FX_PARAM_CLAMP, type PostEffect } from '~/lib/compositor/postEffects'
import { sanitizeTornEdge, tornEdgeActive } from '~/lib/compositor/tornEdge'
import { sanitizeFeather, featherActive } from '~/lib/compositor/feather'
import { maskBreakFromEdge, type MaskBreak, type MaskBreakEdge } from '~/lib/compositor/maskBreak'
import type { LayerGroup } from '~/lib/compositor/layerGroups'
import { readGrid } from '~/lib/frame/gridConfig'
import type { FrameGrid } from '~/lib/frame/grid'
import { normalizeVocab } from '~/lib/compositor/dealVocab'
import { defaultPane, normalizePane, panePresetPatch, PANE_PRESET_NAMES, type PaneParams, type PanePresetName } from '~/lib/compositor/pane'
import { defaultModular, normalizeModular, modularPresetPatch, MODULAR_PRESET_NAMES, type ModularParams, type ModularPresetName } from '~/lib/compositor/modular'
import { defaultParcel, normalizeParcel, parcelPresetPatch, PARCEL_PRESET_NAMES, type ParcelParams, type ParcelPresetName } from '~/lib/compositor/parcel'
import { defaultMosh, normalizeMosh, moshPresetPatch, MOSH_PRESET_NAMES, type MoshParams, type MoshPresetName } from '~/lib/compositor/mosh'
import { placeTemplate, setInstanceSlot, freezeInstance } from '~/lib/frametemplate/apply'
import type { Template, TemplateInstance } from '~/lib/frametemplate/types'
import { shapeById, SHAPES } from '~/lib/shapes/catalog'
import { createShapeLayer, SHAPE_LAYER_DEFAULT_WIDTH } from '~/lib/shapes/pathLayer'
/** Every id addShape accepts — built once, the description hands the same array out each turn. */
const SHAPE_LIBRARY_IDS: readonly string[] = SHAPES.map(s => s.id)

export interface CompositorState {
  layers: LocalLayer[]
  background?: Paint
  /** Doc-level post-processing chain (whole-frame grade/bloom/grain/…). */
  postEffects?: PostEffect[]
  /** Active brand kit's named palette — context only (compositor paints are
   *  literal hexes; the model translates "viridian" → its hex). */
  brandPalette?: { name: string; hex: string }[]
  /** Nested-group registry (id/name/parentId) — only touched by frame-template
   *  placement, which materializes a template as a group. Absent = no groups. */
  groups?: LayerGroup[]
  /** Placed frame-template copies (`node.data.properties.sailor_frametemplates`
   *  round-trips through here). The agent addresses a copy by `instanceId` —
   *  it never edits a template's placed layers directly. */
  templates?: TemplateInstance[]
  /** Doc-level layout grid (guide + snap source) — `sailor_localGrid` round-trips
   *  through here like background/postEffects. Absent = mode 'off' (readGrid's
   *  default), same as an old frame with no grid config saved yet. */
  grid?: FrameGrid
}

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T)
}

/** A short, human-readable rendering of a Paint (colour / gradient / pattern).
 *  Gradients include their stop colours + angle so the model can read and adjust
 *  them (relative colour edits otherwise lose the stops). */
function paintLabel(p: Paint | undefined): string {
  if (p == null || p === '') return 'none'
  if (typeof p === 'string') return p
  if (typeof p === 'object' && 'type' in p) {
    const gg = p as { type: string; shapeId?: string }
    if (gg.type === 'shapes') return `${gg.shapeId ?? 'sparkle'} pattern`
    const g = p as { type: string; angle?: number; stops?: { color?: string }[] }
    const stops = Array.isArray(g.stops) ? g.stops.map(s => s.color).filter(Boolean).join('→') : ''
    const ang = g.type === 'linear' && typeof g.angle === 'number' ? ` ${g.angle}°` : ''
    return `${g.type} gradient${ang}${stops ? ` [${stops}]` : ''}`
  }
  return 'fill'
}

/** Map a MaskBreak's angle back to the edge word it was built from (agent-facing;
 *  a break authored via maskBreakFromEdge always lands on one of these four). */
function maskBreakEdgeLabel(b: MaskBreak): string {
  switch (b.angle) {
    case 0: return 'top'
    case 180: return 'bottom'
    case 270: return 'left'
    case 90: return 'right'
    default: return 'angled'
  }
}

const clamp = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback
}

/** A Paint is a "#RRGGBB" string or a gradient/pattern object — same predicate setFill uses. */
const isValidPaint = (v: unknown): boolean => v != null && (typeof v === 'string' || typeof v === 'object')

/** dealGrid's Pane args as one partial-params patch: `palettePreset` (a named
 *  ordered 8-ink list — Pane's preset names are disjoint from the other generators')
 *  laid under the explicit `pane:{…}` fields, or null when neither was sent. */
function paneArgs(a: Record<string, unknown>): Partial<PaneParams> | null {
  const preset = typeof a.palettePreset === 'string' && (PANE_PRESET_NAMES as string[]).includes(a.palettePreset)
    ? panePresetPatch(a.palettePreset as PanePresetName) : null
  const explicit = a.pane && typeof a.pane === 'object' ? a.pane as Partial<PaneParams> : null
  if (!preset && !explicit) return null
  return { ...(preset ?? {}), ...(explicit ?? {}) }
}
/** dealGrid's Modular args as one partial-params patch: `palettePreset` (a named
 *  bg + rule + inks set) laid under the explicit `modular:{…}` fields, or null when
 *  neither was sent. */
function modularArgs(a: Record<string, unknown>): Partial<ModularParams> | null {
  const preset = typeof a.palettePreset === 'string' && (MODULAR_PRESET_NAMES as string[]).includes(a.palettePreset)
    ? modularPresetPatch(a.palettePreset as ModularPresetName) : null
  const explicit = a.modular && typeof a.modular === 'object' ? a.modular as Partial<ModularParams> : null
  if (!preset && !explicit) return null
  return { ...(preset ?? {}), ...(explicit ?? {}) }
}
/** dealGrid's Parcel args as one partial-params patch: `palettePreset` (a named
 *  ground + ink + hairline triple — Parcel's preset names are disjoint from
 *  Modular's) laid under the explicit `parcel:{…}` fields, or null when neither
 *  was sent. */
function parcelArgs(a: Record<string, unknown>): Partial<ParcelParams> | null {
  const preset = typeof a.palettePreset === 'string' && (PARCEL_PRESET_NAMES as string[]).includes(a.palettePreset)
    ? parcelPresetPatch(a.palettePreset as ParcelPresetName) : null
  const explicit = a.parcel && typeof a.parcel === 'object' ? a.parcel as Partial<ParcelParams> : null
  if (!preset && !explicit) return null
  return { ...(preset ?? {}), ...(explicit ?? {}) }
}
/** dealGrid's Mosh args as one partial-params patch: `palettePreset` (a named
 *  8-ink cube — Mosh's preset names are disjoint from Modular's and Parcel's) laid
 *  under the explicit `mosh:{…}` fields, or null when neither was sent. */
function moshArgs(a: Record<string, unknown>): Partial<MoshParams> | null {
  const preset = typeof a.palettePreset === 'string' && (MOSH_PRESET_NAMES as string[]).includes(a.palettePreset)
    ? moshPresetPatch(a.palettePreset as MoshPresetName) : null
  const explicit = a.mosh && typeof a.mosh === 'object' ? a.mosh as Partial<MoshParams> : null
  if (!preset && !explicit) return null
  return { ...(preset ?? {}), ...(explicit ?? {}) }
}
type DealFill = 'solid' | 'pane' | 'modular' | 'parcel' | 'mosh'
const isDealFill = (v: unknown): v is DealFill => v === 'solid' || v === 'pane' || v === 'modular' || v === 'parcel' || v === 'mosh'
/** The cell fill a NEW deal gets: an explicit cellFill wins; else sending pane /
 *  modular / parcel / mosh tunables implies that fill; else solid. */
function newDealFill(a: Record<string, unknown>): DealFill {
  if (isDealFill(a.cellFill)) return a.cellFill
  if (paneArgs(a)) return 'pane'
  if (modularArgs(a)) return 'modular'
  if (parcelArgs(a)) return 'parcel'
  if (moshArgs(a)) return 'mosh'
  return 'solid'
}

/** Merge model-provided effect params over current/defaults with clamps; null = invalid type. */
function sanitizePostEffect(raw: unknown, cur?: PostEffect): PostEffect | null {
  const r = (raw ?? {}) as Record<string, unknown>
  const type = r.type as PostEffect['type']
  if (!type || !(type in POST_EFFECT_DEFAULTS)) return null
  const base: Record<string, unknown> = { ...defaultPostEffect(type), ...(cur ? clone(cur) : {}) }
  const clamps = POST_FX_PARAM_CLAMP[type] ?? {}
  for (const [k, v] of Object.entries(r)) {
    if (k === 'type' || k === 'visible') continue
    if (k in clamps && typeof v === 'number' && Number.isFinite(v)) {
      const [lo, hi] = clamps[k]!
      base[k] = Math.min(hi, Math.max(lo, v))
    } else if (type === 'duotone' && (k === 'shadows' || k === 'highlights')
      && typeof v === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v)) {
      base[k] = v
    }
  }
  base.visible = true
  return base as unknown as PostEffect
}

/** Which field carries the FILL paint for each layer kind (null = no fill). */
function fillField(kind: LocalLayerKind): string | null {
  if (kind === 'text') return 'color'
  if (kind === 'image') return 'tint'
  if (kind === 'rect' || kind === 'ellipse' || kind === 'path') return 'fill'
  return null // line has stroke only
}

/** Which field carries the STROKE paint for each kind (null = no stroke). */
function strokeField(kind: LocalLayerKind): string | null {
  if (kind === 'text') return 'strokeColor'
  if (kind === 'image') return null
  return 'stroke' // rect/ellipse/path/line
}

/** Whitelisted common (transform) props every layer accepts. */
const COMMON_PROPS = new Set(['x', 'y', 'rotation', 'opacity', 'blend', 'visible', 'locked', 'skewX', 'skewY', 'radius'])
// Props that must stay within bounds (0..1 fractions / sane ranges) so a bad model
// value can't break rendering.
// `radius` is clamped as a NUMBER on purpose: a rect may store four per-corner
// radii, but the agent vocabulary stays uniform-only (an array patch fails the
// finite-number check and falls back to the layer's current value, so a model
// can never half-write a corner tuple).
const PROP_CLAMP: Record<string, [number, number]> = { x: [-1, 2], y: [-1, 2], opacity: [0, 1], rotation: [-360, 360], radius: [0, 1] }

/** The agent-facing command menu. Media ops (generateImage/editImage/
 *  removeImageBackground) are listed so the model can emit them; the composable
 *  resolves them async (they call the canvas tools). `restore` is internal. */
const COMPOSITOR_COMMANDS: CommandSpec[] = [
  { op: 'setLayerProps', hint: 'Move/transform a layer. target = layer id; args: { patch }. Keys: x, y (0..1 of canvas, layer CENTER), rotation (deg), opacity (0..1, so "50%"=0.5), blend ("normal"|"multiply"|"screen"|…), visible (bool), skewX/skewY (deg), radius (0..1, rectangle corner rounding). Positional presets (account for the layer\'s own size): centre 0.5,0.5; top-left ~0.15,0.12; top-centre 0.5,0.12; top-right ~0.85,0.12; bottom-left ~0.15,0.88; bottom-centre 0.5,0.88; bottom-right ~0.85,0.88. Relative moves ("up a bit") = adjust the CURRENT x/y shown.' },
  { op: 'setText', hint: 'Change a TEXT layer\'s copy. target = layer id; args: { text }. You may write/rewrite the copy yourself.' },
  { op: 'setTextStyle', hint: 'Style a TEXT layer. target = layer id; args: { patch }. Keys: fontFamily (ANY Google Font by name — for an Impact-style / bold condensed poster headline use "Anton" (also good: "Oswald", "Archivo Black", "Bebas Neue"); for body use "Inter"), fontWeight (100..900), fontSize (fraction of canvas WIDTH: body ~0.03, a normal heading ~0.08, a big headline ~0.15, a HUGE poster headline that fills the frame 0.25–0.45), align ("left"|"center"|"right"), lineHeight (multiplier), boxW (0..1 wrap width). For "huge headline" set fontSize ≥ 0.25 and usually fontWeight 700–900.' },
  { op: 'setFill', hint: 'Set a layer\'s FILL — text colour, shape fill, or image tint. target = layer id; args: { paint }. paint is a "#RRGGBB" colour OR a gradient object {type:"linear",angle,stops:[{offset,color}]} / {type:"radial",stops}. "none"/"" = no fill. A SHAPE PATTERN is {type:"shapes", shapeId (a library shape id like "sparkle"), a (shape colour), b (background "#RRGGBB" or "none" for transparent), angle, shapeSize, shapeGap}. shapeSize and shapeGap are 0..1 fractions of the tile — bigger shapeSize = larger shapes, bigger shapeGap = more space between them; count is automatic. This is what "make it blue", "give it a sunset gradient", "fill it with sparkles" mean.' },
  { op: 'setStroke', hint: 'Set a layer\'s STROKE/outline. target = layer id; args: { paint, width? }. paint as in setFill (or "none"); width is 0..1 of canvas width.' },
  { op: 'setSize', hint: 'Resize a SHAPE/image/line layer. target = layer id; args: { w?, h?, scale? } (0..1 of canvas width; line uses w as length; path uses scale). TEXT size is NOT here — use setTextStyle fontSize.' },
  { op: 'addLayer', hint: 'Add a NEW layer. args: { layer }. layer needs: kind ("text"|"rect"|"ellipse"|"line"), x, y (0..1, center). text also: text + you may set fontFamily/fontWeight/fontSize/color inline (a HUGE headline = fontSize 0.25–0.45, fontWeight 800; Impact-style font = "Anton"). Give the layer an id you choose so you can target it next. New layers land ON TOP by default — to put one BEHIND the image/other layers, follow with setLayerDepth …"back". (For images use generateImage.)' },
  { op: 'addShape', hint: 'Add a SHAPE from the shape library (sparkle, sun-rays, leaf, heart, plus, stairs, hexagon, swirl…) as a vector layer. args: { shape (an id from document.shapeLibrary), x?, y? (0..1, centre; default 0.5,0.5), w? (ink width as a fraction of the canvas width, 0.02..2 — 1 = the full width; default 0.3), fill? ("#RRGGBB" or a gradient object), id? (choose one so you can target it next) }. This is what "add a sparkle", "put a sun top-right", "drop in a heart" mean. Recolour later with setFill, resize with setSize scale, rotate with setLayerProps.' },
  { op: 'removeLayer', hint: 'Delete a layer by id. target = layer id.' },
  { op: 'setLayerDepth', hint: 'Change a layer\'s stacking depth (z-order). target = layer id; args: { to: "back" | "front" }. "back" puts it BEHIND every other layer including the connected/wired image — use this for "put the headline BEHIND the image". "front" brings it to the top.' },
  { op: 'setBackground', hint: 'Set the FRAME background that sits behind every layer. args: { paint } — a "#RRGGBB" colour, a gradient object, or "none". Use for "make the background blue / a sunset gradient".' },
  { op: 'setGrid', hint: 'Set the layout grid on a Frame — a Swiss-style guide layers can snap to (editor-only, never baked/exported). args: { patch: {...}, generate? }. patch keys: mode ("off" | "explicit" | "generated"), baseModule (0..1 of canvas width, the alignment unit), gutter (0..1), margin (0..1), columns/rows (explicit mode counts), gen: { colRange/rowRange ([min,max] column/row counts, generated mode), regularity (0..1: 0 = loose/free spacing, 1 = strict/equal), merge (bool, merge adjacent cells into larger regions), mergeMaxSpan (max cells a merged region spans), symmetry ("none" | "mirror"), seed (integer) }, overlay (bool, show the guide lines). Omitted keys keep their current value. generate:true (or reroll:true) re-rolls a fresh random seed for a new generated-grid variation; switching mode to "generated" without giving gen.seed also rolls a fresh seed. This is what "add a layout grid", "give it a 6-column grid", "generate a new grid variation", "re-roll the grid" mean.' },
  { op: 'dealGrid', hint: `Deal a decorative modular grid as ONE self-painting layer: every cell gets a fill from a weighted palette, keyed by a seed. This is a dense generative grid ("mosaic", "modular grid", "tiled pattern", "oddgrid") as a single layer that BAKES into the render (unlike setGrid's editor-only guide). To CREATE a new deal, omit target; to reconfigure an existing one, target = the deal layer's id. A one-word LOOK ("pane", "modular", "parcel", "mosh") is a cellFill — send cellFill or the matching empty tunables object (pane:{} / modular:{} / parcel:{} / mosh:{}) plus a palettePreset if a named colour set is wanted; there is no separate template word. args: { vocab ("brand" | "mono" | "warm" | "cool" — the palette), density (0..1, fraction of cells filled; the rest are transparent; default 1 = every cell), cellInset (0..0.4, gap inset per cell), cellFill ("solid" | "pane" | "modular" | "parcel" | "mosh"; default "solid"; "pane" = the Pane look: rows of flush panes with their OWN row-masonry — grid/density/cellInset are ignored — each pane a two-colour ramp running corner to corner or edge to edge, inks drawn by distance along the palette; "modular" = the Modular look: a flush grid of modules, some merged 2×2 / 2-wide / 2-tall, over a background colour — each module empty, solid, a block field, a corner dot cluster, a fine line grid or a two-colour ramp — with faint hairlines over the whole grid; grid/density/cellInset are ignored; "parcel" = the Parcel look: a coarse two-tone field of chunky ink blocks on a ground colour — every cell is one or the other, hard cell edges, no gutter — with a few ragged rectangular clusters of fine hairline lattices ("survey grids") floating on top that darken whatever they cross; grid/density/cellInset are ignored; "mosh" = the Mosh look: a corrupted signal / datamosh / glitch texture — the frame stacked as uneven horizontal bands, each a different failure: confetti (short horizontal runs of colour), mosaic (coarse blocks cut by hard diagonal tears that go dark), smear (long thin runs held far past where they should change), scan (full-width rows of one colour, some cut by a short bright segment) and chevron (a herringbone motif) — every mark a hard-edged rect snapped to a column grid, in full-strength colour-cube inks with plenty of near-black dead patches; grid/density/cellInset are ignored), pane ({ rows (1..8, default 3), cells (nominal cells per row, 1..12, default 6; each row varies it), vary (0..1 how uneven rows/cells are, default 0.55), diag (0..1 share of corner-to-corner ramps vs flat ones, default 0.45), soft (0..1 how much of each pane is the blend; 0 = hard line, default 0.85), spread (0..1 how far apart in the palette the two inks are; 0 = neighbours, default 0.55), inks (ordered hex list the spread walks — the ORDER is the look; omitted = the tool's first palette; fewer than 2 = the vocab palette) } — sending pane implies cellFill "pane"; palettePreset also takes a Pane palette by name: "Hot pink" | "Electric" | "Deep" | "Sorbet" | "Candy" — the tool's five ordered 8-ink lists; explicit pane.inks override it; implies cellFill "pane"), modular ({ gcols (module columns 2..12, default 6; rows follow the frame aspect), unit (sub-cells per module side 2..8, default 4), merge (0..1 how often modules merge, default 0.45), w ({ empty, solid, blocks, dots, lines, grad } relative weights 0..50, defaults 34/20/24/14/12/10 — empty is most common on purpose), blockFill (0..1 coverage of block/dot fields, default 0.5), dot (0..1 dot diameter within its sub-cell, default 0.62), rules (0..1 hairline opacity over the whole grid, default 0.22; 0 = none), ruleW (1..3 line width, default 1), bg (hex background), rule (hex hairline colour), inks (ordered hex list; omitted = the vocab palette) } — sending modular implies cellFill "modular"), palettePreset ("Digital" | "Riso" | "Bloom" | "Heat" | "Mono" — a named Modular colour set: background + hairline colour + 4 inks; explicit modular.bg/rule/inks override it; also implies cellFill "modular"), parcel ({ cells (grid width in cells 8..40, default 16; rows follow the frame aspect), cover (0..1 how much of the field is ink, default 0.5), chunk (0.5..3 block scale — bigger = bigger blobs, default 1), grids (0..8 how many survey grids float on top, default 4), blend ("multiply" | "normal"; multiply = the hairlines darken ink and ground alike, default), ground (hex ground colour), ink (hex block colour), hairline (hex survey-line colour) } — sending parcel implies cellFill "parcel"; palettePreset also takes a Parcel triple by name: "Lime on grey" | "Blue on cream" | "Acid on black" | "Orange on cream" | "Cyan on stone" | "Blue on olive" — ground + ink + hairline; explicit parcel colours override it; implies cellFill "parcel"), mosh ({ bands (1..8 how many horizontal bands, default 6), cols (24..300 cells across — everything snaps to these columns, default 150), mix (0..1 how much of the palette each band draws from, default 0.62), tears (0..1 how many diagonal tears cut the mosaic bands, default 0.55; 0 = none), runs (0..1 how long the smear bands hold a value, default 0.5), bright (0..1 how often the bright ink cuts in — white cells in smears, white segments across scan rows — default 0.3), inks (ordered hex list of 8 full-strength inks; inks[1] is the bright one; omitted = the pure colour cube) } — sending mosh implies cellFill "mosh"; palettePreset also takes a Mosh cube by name: "Pure cube" | "Soft cube" | "Print cube" | "Warm cube" | "Cool cube" — 8 inks; explicit mosh.inks override it; implies cellFill "mosh"), grid ({ colRange:[min,max], rowRange:[min,max], regularity (0..1), merge (bool), symmetry ("none"|"mirror") } — the cell layout; omitted keeps the current/frame grid), seed (integer, the variation), generate (bool — re-roll a fresh seed for a new variation), id? (choose one to target it later) }. "make a colourful mosaic", "deal a warm modular grid", "re-roll the pattern", "sparser grid" all mean this.` },
  { op: 'generateImage', hint: 'Generate a PHOTOGRAPHIC/illustrative AI image and add it as a layer — "generate a picture of a dog", "add a city photo". Not for gradients/colours (use setBackground/setFill). args: { prompt (vivid), aspectRatio? }.' },
  { op: 'removeImageBackground', hint: 'Cut out the subject of an existing IMAGE layer (transparent background). target = image layer id.' },
  { op: 'editImage', hint: 'Edit an existing IMAGE layer from an instruction (Flux Kontext) — "make it brighter", "change the sky". target = image layer id; args: { instruction }.' },
  { op: 'setLayerEffect', hint: 'Add/update/remove a post-processing effect ON ONE LAYER. target = layer id; args: { effect: { type: "adjust"|"bloom"|"grain"|"vignette"|"duotone"|"dof", ...params }, remove? }. adjust (colour grade): brightness/contrast/saturation 0..2 (1 = neutral), hue -180..180. bloom (glow from bright areas): threshold 0..1, radius ~0.02, intensity 0..2. grain (film noise): amount 0..1, size 1..8. vignette (darkened edges): amount/size/softness 0..1. duotone (two-colour map): shadows "#RRGGBB", highlights "#RRGGBB", mix 0..1. dof (depth of field, IMAGE LAYERS ONLY — uses an estimated depth map where BRIGHT = NEAR, so focus 1 is the closest thing and focus 0 the furthest): focus 0..1 picks the plane that stays sharp, range 0..1 widens the sharp band, aperture 0..1 sets blur strength (~0.02-0.05 is a normal lens, 0.1+ is extreme), bladeCount 0..12 shapes the bokeh (6 = hexagonal, under 3 = circular), bladeRotation 0..360, bloomThreshold 0..1 and bloomStrength 0..4 control how much bright defocused points bloom into discs. This is what "blur the background", "shallow depth of field", "make the subject pop" mean. Omitted params keep their current value. remove:true deletes that effect type. This is also what "make the logo glow", "desaturate the photo" mean.' },
  { op: 'setPostEffect', hint: 'Add/update/remove a post-processing effect on the WHOLE FRAME — applied after all layers composite. Same args and effect vocabulary as setLayerEffect (no target), EXCEPT dof, which is per-image-layer only because it needs that image\'s depth map. This is what "make the whole thing warmer", "add film grain", "give it a vignette", "cinematic colour grade" mean.' },
  { op: 'setLayerTornEdge', hint: 'Give a layer a TORN-PAPER edge (ragged, grain-dissolved boundary with an optional white "lip"). target = layer id; args: { patch: {...}, remove? }. patch keys: style ("ripped"=organic meandering tear | "deckle"=soft handmade-paper edge | "shredded"=aggressive spiky rip), amount (tear depth in px, ~10 subtle … 60 deep), roughness (0..1 fray detail), grain (px, edge crumble/dissolve; 0 = crisp), grainTexture (0..1 paper-fibre texture on the lip only), lipWidth (px white underside band; 0 = no lip), lipVariation (0..1 how uneven the lip width is), lipColor ("#RRGGBB", warm white default), seed (integer; change it for a different random tear). Omitted keys keep their current value. remove:true removes the torn edge. This is what "torn paper edge", "ripped edges", "rough deckle border" mean.' },
  { op: 'setLayerFeather', hint: 'Feather (soften) a layer\'s edges so they fade smoothly to transparent — a soft edge-mask, uniform on all sides. target = layer id; args: { patch: {...}, remove? }. patch keys: amount (0..1, feather depth relative to the element\'s OWN size; ~0.1 subtle … 0.4 strong … 1 fades the edge in to the element\'s center), curve ("linear" = even fade | "smooth" = eased fade). Omitted keys keep their current value. remove:true removes the feather. This is what "feather the edges", "soften the edges", "fade the edges" mean.' },
  { op: 'setLayerMaskBreak', hint: 'Let a SUBJECT masked to a shape BREAK OUT of one edge — the head pops over the top of the circle while the rest stays clipped. target = the MASKED layer id (must already be masked to a shape, see maskBreak in its description). args: { edge ("top"|"bottom"|"left"|"right"), offset? (0..1, how far the break line sits into the shape from that edge; default 0 = the shape edge), remove? }. This is what "let his head pop out of the top", "break him out of the circle" mean.' },
  { op: 'placeTemplate', hint: 'Place a saved FRAME TEMPLATE into this frame as a linked copy — "use my <name> template", "drop in my poster template". NEVER build the template\'s look from raw layers yourself; this op is the only way to place one. args: { template (the full Template object for the named template), slotValues? (Record<slotId, value> — text/color hex/image filename; omitted slots keep the template\'s own defaults) }. Materializes the template\'s layers as a group and records a linked copy the user can later edit via setTemplateSlot or detach via freezeTemplate.' },
  { op: 'setTemplateSlot', hint: 'Fill one SLOT on an already-placed template copy — "set the headline to …", "swap the photo", "make the accent color orange". target = the copy\'s instance id (from a placeTemplate result / the document\'s templates list). args: { template (that copy\'s Template object), slotId, value (text string, "#RRGGBB" for a color slot, or a filename for an image slot) }. Edits ONLY the slot value through the template recipe — never patches the placed layer directly.' },
  { op: 'freezeTemplate', hint: 'Detach a placed template copy from its template — "freeze this", "unlink this from the template". target = the copy\'s instance id. The copy\'s layers stay on the frame exactly as they are, as ordinary editable layers; it just stops tracking the template (no more slot edits or template-version updates).' },
]

function findLayer(s: CompositorState, id?: string): LocalLayer | undefined {
  return s.layers.find(l => l.id === id)
}

/** Read a Compositor frame as an agent snapshot: each layer + a document object. */
export function describeCompositor(state: CompositorState): SurfaceSnapshot {
  const objects: SurfaceSnapshot['objects'] = state.layers.map((l) => {
    // Expose enough CURRENT state for relative edits ("bigger", "a bit darker",
    // "rotate more") and questions ("what font is the title?") to be answerable.
    const cur: Record<string, unknown> = { x: l.x, y: l.y, opacity: l.opacity }
    if (l.rotation) cur.rotation = l.rotation
    if (l.blend && l.blend !== 'normal') cur.blend = l.blend
    if (l.effects?.length) cur.effects = l.effects.filter(e => e.visible).map(e => e.type).join(', ')
    if (tornEdgeActive(l.tornEdge)) cur.tornEdge = `${l.tornEdge.style} (amount ${l.tornEdge.amount}, lip ${l.tornEdge.lipWidth})`
    if (featherActive(l.feather)) cur.feather = `${l.feather.curve} (amount ${l.feather.amount})`
    if (l.maskBreak) cur.maskBreak = maskBreakEdgeLabel(l.maskBreak)
    if (l.kind === 'text') {
      cur.text = l.text; cur.fontFamily = l.fontFamily; cur.fontWeight = l.fontWeight
      cur.fontSize = l.fontSize; cur.color = paintLabel(l.color); cur.align = l.align; cur.lineHeight = l.lineHeight
      if (l.boxW != null) cur.boxW = l.boxW
      if (l.strokeColor && l.strokeWidth) { cur.outline = paintLabel(l.strokeColor); cur.outlineWidth = l.strokeWidth }
    } else if (l.kind === 'image') { cur.image = l.filename; cur.w = l.w; cur.h = l.h; if (l.tint) cur.tint = paintLabel(l.tint) }
    // `radius` may be per-corner ([tl, tr, br, bl]); describe it as one readable
    // value so the model never learns to emit an array (setLayerProps takes a
    // number only — see PROP_CLAMP).
    else if (l.kind === 'rect') { cur.w = l.w; cur.h = l.h; cur.fill = paintLabel(l.fill); if (l.radius) cur.radius = Array.isArray(l.radius) ? l.radius.join(' / ') : l.radius; if (l.stroke) { cur.stroke = paintLabel(l.stroke); cur.strokeWidth = l.strokeWidth } }
    else if (l.kind === 'ellipse') { cur.w = l.w; cur.h = l.h; cur.fill = paintLabel(l.fill); if (l.stroke) { cur.stroke = paintLabel(l.stroke); cur.strokeWidth = l.strokeWidth } }
    else if (l.kind === 'line') { cur.length = l.w; cur.stroke = paintLabel(l.stroke); cur.strokeWidth = l.strokeWidth }
    else if (l.kind === 'path') { cur.fill = paintLabel(l.fill); if (l.shapeId && shapeById(l.shapeId)) cur.shape = l.shapeId }
    if (l.visible === false) cur.hidden = true
    return { id: l.id, label: l.kind === 'text' ? `“${l.text}”` : l.kind, type: l.kind, current: cur }
  })
  // Placed frame-template copies, addressable by instanceId for setTemplateSlot/
  // freezeTemplate — kept separate from the layer objects above since the agent
  // must never edit a copy's placed layers directly, only through its slots.
  for (const inst of state.templates ?? []) {
    objects.push({
      id: inst.instanceId,
      label: `template copy (${inst.templateId})`,
      type: 'template-instance',
      current: { templateId: inst.templateId, templateVersion: inst.templateVersion, slotValues: inst.slotValues },
    })
  }
  objects.push({
    id: 'document',
    label: 'Frame / document',
    type: 'document',
    current: {
      background: paintLabel(state.background),
      postEffects: state.postEffects?.filter(e => e.visible).map(e => e.type).join(', ') || 'none',
      grid: state.grid && state.grid.mode !== 'off'
        ? (state.grid.mode === 'explicit'
          ? `explicit ${state.grid.columns}×${state.grid.rows}`
          : `generated cols ${state.grid.gen.colRange.join('-')} rows ${state.grid.gen.rowRange.join('-')} regularity ${state.grid.gen.regularity} seed ${state.grid.gen.seed}`)
        : 'off',
      // The frame is a unit square in normalized coords: x/y/sizes are 0..1.
      coordinateSpace: 'normalized 0..1 (0,0 = top-left, 0.5,0.5 = centre)',
      // Every id addShape accepts. ~1.5 KB (measured 1,530 chars serialised); listed so the model never guesses a name.
      shapeLibrary: SHAPE_LIBRARY_IDS,
      ...(state.brandPalette?.length
        ? { brandPalette: state.brandPalette.map(s => `${s.name} ${s.hex}`).join(', ') }
        : {}),
    },
  })
  return { surface: 'compositor', objects, commands: COMPOSITOR_COMMANDS }
}

/** Default layer factory so addLayer only needs kind + position + (text). */
function defaultLayer(kind: LocalLayerKind, id: string): Record<string, unknown> {
  const base = { id, kind, x: 0.5, y: 0.5, rotation: 0, opacity: 1 }
  if (kind === 'text') return { ...base, text: 'New text', fontFamily: 'Inter', fontWeight: 400, fontSize: 0.08, color: '#ffffff', align: 'center', lineHeight: 1.1, strokeColor: '', strokeWidth: 0 }
  if (kind === 'rect') return { ...base, w: 0.3, h: 0.2, fill: '#96b4ff', stroke: '', strokeWidth: 0, radius: 0 }
  if (kind === 'ellipse') return { ...base, w: 0.25, h: 0.25, fill: '#96b4ff', stroke: '', strokeWidth: 0 }
  if (kind === 'line') return { ...base, w: 0.3, stroke: '#ffffff', strokeWidth: 0.004 }
  if (kind === 'image') return { ...base, filename: '', w: 0.5, h: 0.5 }
  return base
}

/** Apply one command to a Compositor frame, returning the new state + an inverse.
 *  Pure — the input is never mutated. */
export function applyCompositorCommand(input: CompositorState, cmd: Command): CommandResult<CompositorState> {
  const state = clone(input)
  const snapshot = (): Command => ({ op: 'restore', args: { layers: clone(input.layers), background: clone(input.background), postEffects: clone(input.postEffects), groups: clone(input.groups), templates: clone(input.templates) } })

  switch (cmd.op) {
    case 'setLayerProps': {
      const patch = cmd.args?.patch as Record<string, unknown> | undefined
      if (!patch || typeof patch !== 'object') return { ok: false, reason: 'invalid', detail: 'missing args.patch' }
      const bad = Object.keys(patch).filter(k => !COMMON_PROPS.has(k))
      if (bad.length) return { ok: false, reason: 'invalid', detail: `prop(s) not valid: ${bad.join(', ')}` }
      const layer = findLayer(state, cmd.target)
      if (!layer) return { ok: false, reason: 'invalid', detail: `no layer '${String(cmd.target)}'` }
      const safe = clone(patch)
      // Rects may store four per-corner radii, but the agent vocabulary is
      // uniform-only: drop a non-numeric radius instead of clobbering the
      // corners the user set in the inspector. A numeric one re-links all four.
      if ('radius' in safe && !Number.isFinite(Number(safe.radius))) delete safe.radius
      for (const [k, [lo, hi]] of Object.entries(PROP_CLAMP)) if (k in safe) safe[k] = clamp(safe[k], lo, hi, ((layer as unknown as Record<string, unknown>)[k] as number) ?? 0)
      Object.assign(layer, safe)
      return { ok: true, template: state, inverse: snapshot() }
    }
    case 'setText': {
      const text = cmd.args?.text
      if (typeof text !== 'string') return { ok: false, reason: 'invalid', detail: 'missing args.text' }
      const layer = findLayer(state, cmd.target)
      if (!layer) return { ok: false, reason: 'invalid', detail: `no layer '${String(cmd.target)}'` }
      if (layer.kind !== 'text') return { ok: false, reason: 'invalid', detail: `layer '${String(cmd.target)}' is not text` }
      layer.text = text
      return { ok: true, template: state, inverse: snapshot() }
    }
    case 'setTextStyle': {
      const patch = cmd.args?.patch as Record<string, unknown> | undefined
      if (!patch || typeof patch !== 'object') return { ok: false, reason: 'invalid', detail: 'missing args.patch' }
      const allowed = new Set(['fontFamily', 'fontWeight', 'fontSize', 'align', 'lineHeight', 'boxW'])
      const bad = Object.keys(patch).filter(k => !allowed.has(k))
      if (bad.length) return { ok: false, reason: 'invalid', detail: `text style key(s) not valid: ${bad.join(', ')}` }
      const layer = findLayer(state, cmd.target)
      if (!layer || layer.kind !== 'text') return { ok: false, reason: 'invalid', detail: `no text layer '${String(cmd.target)}'` }
      const safe = clone(patch)
      if ('fontSize' in safe) safe.fontSize = clamp(safe.fontSize, 0.005, 1, layer.fontSize)
      if ('fontWeight' in safe) safe.fontWeight = clamp(safe.fontWeight, 100, 900, layer.fontWeight)
      if ('lineHeight' in safe) safe.lineHeight = clamp(safe.lineHeight, 0.5, 4, layer.lineHeight)
      if ('boxW' in safe) safe.boxW = clamp(safe.boxW, 0.02, 1, layer.boxW ?? 1)
      Object.assign(layer, safe)
      return { ok: true, template: state, inverse: snapshot() }
    }
    case 'setFill': {
      const paint = cmd.args?.paint as Paint | undefined
      if (!isValidPaint(paint)) return { ok: false, reason: 'invalid', detail: 'missing args.paint' }
      const layer = findLayer(state, cmd.target)
      if (!layer) return { ok: false, reason: 'invalid', detail: `no layer '${String(cmd.target)}'` }
      const field = fillField(layer.kind)
      if (!field) return { ok: false, reason: 'invalid', detail: `${layer.kind} layers have no fill (use setStroke)` }
      ;(layer as unknown as Record<string, unknown>)[field] = clone(paint)
      return { ok: true, template: state, inverse: snapshot() }
    }
    case 'setStroke': {
      const paint = cmd.args?.paint as Paint | undefined
      if (paint == null) return { ok: false, reason: 'invalid', detail: 'missing args.paint' }
      const layer = findLayer(state, cmd.target)
      if (!layer) return { ok: false, reason: 'invalid', detail: `no layer '${String(cmd.target)}'` }
      const field = strokeField(layer.kind)
      if (!field) return { ok: false, reason: 'invalid', detail: `${layer.kind} layers have no stroke` }
      ;(layer as unknown as Record<string, unknown>)[field] = clone(paint)
      if (typeof cmd.args?.width === 'number') (layer as unknown as Record<string, unknown>).strokeWidth = cmd.args.width
      return { ok: true, template: state, inverse: snapshot() }
    }
    case 'setSize': {
      const layer = findLayer(state, cmd.target)
      if (!layer) return { ok: false, reason: 'invalid', detail: `no layer '${String(cmd.target)}'` }
      const a = cmd.args ?? {}
      const L = layer as unknown as Record<string, unknown>
      let touched = false
      if (layer.kind === 'text') return { ok: false, reason: 'invalid', detail: 'text size is fontSize — use setTextStyle, not setSize' }
      if (typeof a.w === 'number' && ('w' in layer)) { L.w = clamp(a.w, 0.002, 3, (L.w as number) ?? 0.3); touched = true }
      if (typeof a.h === 'number' && (layer.kind === 'rect' || layer.kind === 'ellipse' || layer.kind === 'image')) { L.h = clamp(a.h, 0.002, 3, (L.h as number) ?? 0.3); touched = true }
      if (typeof a.scale === 'number' && layer.kind === 'path') { L.scale = clamp(a.scale, 0.05, 10, (L.scale as number) ?? 1); touched = true }
      if (!touched) return { ok: false, reason: 'invalid', detail: `no resizable dimension for ${layer.kind} in args` }
      return { ok: true, template: state, inverse: snapshot() }
    }
    case 'addLayer': {
      const raw = cmd.args?.layer as Record<string, unknown> | undefined
      const kind = raw?.kind as LocalLayerKind | undefined
      // 'image' is allowed for the composable's media path (generateImage) — it
      // needs a filename; the model is steered to generateImage via the hint.
      if (!raw || !kind || !['text', 'rect', 'ellipse', 'line', 'image'].includes(kind)) return { ok: false, reason: 'invalid', detail: 'layer needs a kind of text|rect|ellipse|line' }
      if (kind === 'image' && (typeof raw.filename !== 'string' || !raw.filename)) return { ok: false, reason: 'invalid', detail: 'image layer needs a non-empty filename (use generateImage to create one)' }
      const id = typeof raw.id === 'string' ? raw.id : `l_${state.layers.length + 1}_${kind}`
      if (state.layers.some(l => l.id === id)) return { ok: false, reason: 'invalid', detail: `layer id '${id}' already exists` }
      const layer = { ...defaultLayer(kind, id), ...clone(raw), id, kind } as unknown as LocalLayer
      return { ok: true, template: { ...state, layers: [...state.layers, layer] }, inverse: snapshot() }
    }
    case 'addShape': {
      const a = (cmd.args ?? {}) as Record<string, unknown>
      const shape = typeof a.shape === 'string' ? shapeById(a.shape) : undefined
      if (!shape) return { ok: false, reason: 'invalid', detail: `unknown shape id '${String(a.shape)}' — use one from document.shapeLibrary` }
      const id = typeof a.id === 'string' && a.id ? a.id : `l_${state.layers.length + 1}_shape`
      if (state.layers.some(l => l.id === id)) return { ok: false, reason: 'invalid', detail: `layer id '${id}' already exists` }
      const layer = createShapeLayer(shape, {
        id,
        x: clamp(a.x, PROP_CLAMP.x![0], PROP_CLAMP.x![1], 0.5),
        y: clamp(a.y, PROP_CLAMP.y![0], PROP_CLAMP.y![1], 0.5),
        targetWidth: clamp(a.w, 0.02, 2, SHAPE_LAYER_DEFAULT_WIDTH),
        fill: isValidPaint(a.fill) ? (a.fill as Paint) : undefined,
      })
      return { ok: true, template: { ...state, layers: [...state.layers, layer] }, inverse: snapshot() }
    }
    case 'removeLayer': {
      if (!state.layers.some(l => l.id === cmd.target)) return { ok: false, reason: 'invalid', detail: `no layer '${String(cmd.target)}'` }
      return { ok: true, template: { ...state, layers: state.layers.filter(l => l.id !== cmd.target) }, inverse: snapshot() }
    }
    case 'setLayerDepth': {
      // Reorder among the LOCAL layers; the composable also writes the unified
      // wired+local stack order so "back" sits behind a connected image too.
      const to = String(cmd.args?.to ?? '')
      if (to !== 'back' && to !== 'front') return { ok: false, reason: 'invalid', detail: 'args.to must be "back" | "front"' }
      const idx = state.layers.findIndex(l => l.id === cmd.target)
      if (idx < 0) return { ok: false, reason: 'invalid', detail: `no layer '${String(cmd.target)}'` }
      const [moved] = state.layers.splice(idx, 1)
      if (to === 'back') state.layers.unshift(moved!)
      else state.layers.push(moved!)
      return { ok: true, template: state, inverse: snapshot() }
    }
    case 'setBackground': {
      const paint = cmd.args?.paint
      if (paint == null) return { ok: false, reason: 'invalid', detail: 'missing args.paint' }
      const bg = (paint === 'none' || paint === '') ? undefined : clone(paint as Paint)
      return { ok: true, template: { ...state, background: bg }, inverse: snapshot() }
    }
    case 'setGrid': {
      const patch = (cmd.args?.patch ?? {}) as Partial<FrameGrid>
      const g = readGrid(state.grid ? { sailor_localGrid: state.grid } : undefined)
      const merged: FrameGrid = { ...g, ...patch, gen: { ...g.gen, ...(patch.gen ?? {}) } }
      const reroll = cmd.args?.generate === true || cmd.args?.reroll === true
      const enteringGeneratedNoSeed = patch.mode === 'generated' && patch.gen?.seed == null
      if (reroll || enteringGeneratedNoSeed) merged.gen = { ...merged.gen, seed: Math.floor(Math.random() * 9999) + 1 }
      return { ok: true, template: { ...state, grid: merged }, inverse: snapshot() }
    }
    case 'dealGrid': {
      const a = (cmd.args ?? {}) as Record<string, unknown>
      const gridPatch = (a.grid ?? {}) as Partial<FrameGrid['gen']> & Partial<FrameGrid>
      const reroll = a.generate === true || a.reroll === true
      const target = cmd.target ? findLayer(state, cmd.target) : undefined
      if (cmd.target && (!target || target.kind !== 'deal')) return { ok: false, reason: 'invalid', detail: `no deal layer '${String(cmd.target)}'` }

      if (target && target.kind === 'deal') {
        // Reconfigure an existing deal in place.
        const d = target as unknown as Record<string, unknown>
        if (a.vocab != null) d.vocab = normalizeVocab(a.vocab)
        if (typeof a.density === 'number') d.density = clamp(a.density, 0, 1, 1)
        if (typeof a.cellInset === 'number') d.cellInset = clamp(a.cellInset, 0, 0.4, 0)
        if (isDealFill(a.cellFill)) d.cellFill = a.cellFill
        // Pane tunables merge onto the current ones; sending them implies the Pane
        // fill unless the model named another fill in the same breath. A Pane-named
        // palettePreset lays the 8 ordered inks under whatever explicit inks were sent.
        const panePatch = paneArgs(a)
        if (panePatch) {
          d.pane = normalizePane(panePatch, (d.pane as PaneParams | undefined) ?? defaultPane())
          if (!isDealFill(a.cellFill)) d.cellFill = 'pane'
        }
        // Modular tunables likewise; a palettePreset lays bg + rule + inks under
        // whatever explicit colours were sent alongside.
        const modPatch = modularArgs(a)
        if (modPatch) {
          d.modular = normalizeModular(modPatch, (d.modular as ModularParams | undefined) ?? defaultModular())
          if (!isDealFill(a.cellFill)) d.cellFill = 'modular'
        }
        // Parcel tunables likewise; a Parcel-named palettePreset lays the three
        // colours under whatever explicit colours were sent alongside.
        const parPatch = parcelArgs(a)
        if (parPatch) {
          d.parcel = normalizeParcel(parPatch, (d.parcel as ParcelParams | undefined) ?? defaultParcel())
          if (!isDealFill(a.cellFill)) d.cellFill = 'parcel'
        }
        // Mosh tunables likewise; a Mosh-named palettePreset lays the 8 inks under
        // whatever explicit inks were sent alongside.
        const moshPatch = moshArgs(a)
        if (moshPatch) {
          d.mosh = normalizeMosh(moshPatch, (d.mosh as MoshParams | undefined) ?? defaultMosh())
          if (!isDealFill(a.cellFill)) d.cellFill = 'mosh'
        }
        const g = clone((target as { grid: FrameGrid }).grid)
        // gen-level grid keys the model may send (colRange/rowRange/regularity/merge/symmetry).
        g.gen = { ...g.gen, ...(gridPatch as Partial<FrameGrid['gen']>) }
        if (typeof a.seed === 'number') g.gen.seed = Math.round(a.seed)
        if (reroll) g.gen.seed = Math.floor(Math.random() * 9999) + 1
        d.grid = g
        return { ok: true, template: state, inverse: snapshot() }
      }

      // Create a new deal filling the frame, seeded from the frame's current grid.
      const id = typeof a.id === 'string' && a.id ? a.id : `l_${state.layers.length + 1}_deal`
      if (state.layers.some(l => l.id === id)) return { ok: false, reason: 'invalid', detail: `layer id '${id}' already exists` }
      const base = readGrid(state.grid ? { sailor_localGrid: state.grid } : undefined)
      const grid: FrameGrid = clone(base)
      if (grid.mode === 'off') grid.mode = 'generated'
      grid.gen = { ...grid.gen, ...(gridPatch as Partial<FrameGrid['gen']>) }
      if (typeof a.seed === 'number') grid.gen.seed = Math.round(a.seed)
      if (reroll) grid.gen.seed = Math.floor(Math.random() * 9999) + 1
      const layer = {
        id, kind: 'deal', x: 0.5, y: 0.5, rotation: 0, opacity: 1,
        w: 1, h: 1,
        vocab: normalizeVocab(a.vocab ?? 'brand'),
        density: clamp(a.density, 0, 1, 1),
        cellInset: clamp(a.cellInset, 0, 0.4, 0),
        cellFill: newDealFill(a),
        pane: normalizePane(paneArgs(a) ?? {}),
        modular: normalizeModular(modularArgs(a) ?? {}),
        parcel: normalizeParcel(parcelArgs(a) ?? {}),
        mosh: normalizeMosh(moshArgs(a) ?? {}),
        grid,
      } as unknown as LocalLayer
      return { ok: true, template: { ...state, layers: [...state.layers, layer] }, inverse: snapshot() }
    }
    case 'setImage': { // internal — used by the composable's edit/remove-bg media path
      const filename = cmd.args?.filename
      if (typeof filename !== 'string') return { ok: false, reason: 'invalid', detail: 'missing args.filename' }
      const layer = findLayer(state, cmd.target)
      if (!layer || layer.kind !== 'image') return { ok: false, reason: 'invalid', detail: `no image layer '${String(cmd.target)}'` }
      ;(layer as unknown as Record<string, unknown>).filename = filename
      return { ok: true, template: state, inverse: snapshot() }
    }
    case 'setLayerEffect': {
      const layer = findLayer(state, cmd.target)
      if (!layer) return { ok: false, reason: 'invalid', detail: `no layer '${String(cmd.target)}'` }
      const raw = cmd.args?.effect as Record<string, unknown> | undefined
      const type = raw?.type as string | undefined
      if (!type || !(type in POST_EFFECT_DEFAULTS)) return { ok: false, reason: 'invalid', detail: `effect.type must be one of ${Object.keys(POST_EFFECT_DEFAULTS).join('|')}` }
      const others = (layer.effects ?? []).filter(e => e.type !== type)
      if (cmd.args?.remove === true) { layer.effects = others; return { ok: true, template: state, inverse: snapshot() } }
      const cur = (layer.effects ?? []).find(e => e.type === type) as PostEffect | undefined
      const next = sanitizePostEffect(raw, cur)
      if (!next) return { ok: false, reason: 'invalid', detail: 'invalid effect' }
      layer.effects = [...others, next]
      return { ok: true, template: state, inverse: snapshot() }
    }
    case 'setLayerTornEdge': {
      const layer = findLayer(state, cmd.target)
      if (!layer) return { ok: false, reason: 'invalid', detail: `no layer '${String(cmd.target)}'` }
      if (cmd.args?.remove === true) { delete layer.tornEdge; return { ok: true, template: state, inverse: snapshot() } }
      const patch = (cmd.args?.patch ?? {}) as Record<string, unknown>
      layer.tornEdge = sanitizeTornEdge(patch, layer.tornEdge)
      return { ok: true, template: state, inverse: snapshot() }
    }
    case 'setLayerFeather': {
      const layer = findLayer(state, cmd.target)
      if (!layer) return { ok: false, reason: 'invalid', detail: `no layer '${String(cmd.target)}'` }
      if (cmd.args?.remove === true) { delete layer.feather; return { ok: true, template: state, inverse: snapshot() } }
      const patch = (cmd.args?.patch ?? {}) as Record<string, unknown>
      layer.feather = sanitizeFeather(patch, layer.feather)
      return { ok: true, template: state, inverse: snapshot() }
    }
    case 'setLayerMaskBreak': {
      const layer = findLayer(state, cmd.target)
      if (!layer) return { ok: false, reason: 'invalid', detail: `no layer '${String(cmd.target)}'` }
      const ref = layerMaskRef(layer)
      if (!ref) return { ok: false, reason: 'invalid', detail: `layer ${String(cmd.target)} is not masked to a shape — set a shape mask first` }
      const a = cmd.args ?? {}
      if (a.remove === true) { delete layer.maskBreak; return { ok: true, template: state, inverse: snapshot() } }
      const edge = a.edge as MaskBreakEdge | undefined
      if (edge !== 'top' && edge !== 'bottom' && edge !== 'left' && edge !== 'right') {
        return { ok: false, reason: 'invalid', detail: 'args.edge must be "top" | "bottom" | "left" | "right"' }
      }
      const maskLayer = ref.startsWith('l:') ? state.layers.find(x => `l:${x.id}` === ref) : undefined
      const box = maskLayer
        ? { x: maskLayer.x, y: maskLayer.y, ...localLayerBox(null, maskLayer, 1, 1) }
        : { x: 0.5, y: 0.5, w: 1, h: 1 }
      layer.maskBreak = maskBreakFromEdge(edge, box, clamp(a.offset, 0, 1, 0))
      return { ok: true, template: state, inverse: snapshot() }
    }
    case 'setPostEffect': {
      const raw = cmd.args?.effect as Record<string, unknown> | undefined
      const type = raw?.type as string | undefined
      if (!type || !(type in POST_EFFECT_DEFAULTS)) return { ok: false, reason: 'invalid', detail: `effect.type must be one of ${Object.keys(POST_EFFECT_DEFAULTS).join('|')}` }
      const others = (state.postEffects ?? []).filter(e => e.type !== type)
      if (cmd.args?.remove === true) return { ok: true, template: { ...state, postEffects: others }, inverse: snapshot() }
      const cur = (state.postEffects ?? []).find(e => e.type === type)
      const next = sanitizePostEffect(raw, cur)
      if (!next) return { ok: false, reason: 'invalid', detail: 'invalid effect' }
      return { ok: true, template: { ...state, postEffects: [...others, next] }, inverse: snapshot() }
    }
    case 'restore': {
      const next: CompositorState = { ...state }
      if ('layers' in (cmd.args ?? {})) next.layers = clone(cmd.args!.layers as LocalLayer[])
      if ('background' in (cmd.args ?? {})) next.background = clone(cmd.args!.background as Paint | undefined)
      if ('postEffects' in (cmd.args ?? {})) next.postEffects = clone(cmd.args!.postEffects as PostEffect[] | undefined)
      if ('groups' in (cmd.args ?? {})) next.groups = clone(cmd.args!.groups as LayerGroup[] | undefined)
      if ('templates' in (cmd.args ?? {})) next.templates = clone(cmd.args!.templates as TemplateInstance[] | undefined)
      return { ok: true, template: next, inverse: snapshot() }
    }
    case 'placeTemplate': {
      const t = cmd.args?.template as Template | undefined
      if (!t || typeof t !== 'object' || !Array.isArray(t.layers) || !Array.isArray(t.slots)) {
        return { ok: false, reason: 'invalid', detail: 'missing/invalid args.template (needs the full Template object)' }
      }
      const slotValues = (cmd.args?.slotValues && typeof cmd.args.slotValues === 'object') ? cmd.args.slotValues as Record<string, string> : {}
      // Deterministic id minting (no external counters/state available to a pure
      // function): seeded from the current layer count, matching addLayer's
      // existing `l_${state.layers.length + 1}_${kind}` pattern.
      const base = state.layers.length
      let li = 0
      let gi = 0
      const r = placeTemplate({ layers: state.layers, groups: state.groups ?? [] }, t, slotValues, {
        mkLayerId: () => `tpl_${base}_${li++}_l`,
        mkGroupId: () => `tpl_${base}_${gi++}_g`,
        mkInstanceId: () => (typeof cmd.args?.instanceId === 'string' && cmd.args.instanceId) || `tpl_${base}_${(state.templates ?? []).length}_inst`,
      })
      const next: CompositorState = { ...state, layers: r.layers, groups: r.groups, templates: [...(state.templates ?? []), r.instance] }
      return { ok: true, template: next, inverse: snapshot() }
    }
    case 'setTemplateSlot': {
      const t = cmd.args?.template as Template | undefined
      if (!t || typeof t !== 'object' || !Array.isArray(t.slots)) return { ok: false, reason: 'invalid', detail: 'missing/invalid args.template (needs the full Template object)' }
      const slotId = cmd.args?.slotId
      if (typeof slotId !== 'string' || !slotId) return { ok: false, reason: 'invalid', detail: 'missing args.slotId' }
      const value = cmd.args?.value
      if (typeof value !== 'string') return { ok: false, reason: 'invalid', detail: 'missing args.value' }
      const instance = (state.templates ?? []).find(i => i.instanceId === cmd.target)
      if (!instance) return { ok: false, reason: 'invalid', detail: `no placed template copy '${String(cmd.target)}'` }
      if (!t.slots.some(s => s.id === slotId)) return { ok: false, reason: 'invalid', detail: `template '${t.id}' has no slot '${slotId}'` }
      const r = setInstanceSlot(state.layers, t, instance, slotId, value)
      const next: CompositorState = { ...state, layers: r.layers, templates: (state.templates ?? []).map(i => (i.instanceId === instance.instanceId ? r.instance : i)) }
      return { ok: true, template: next, inverse: snapshot() }
    }
    case 'freezeTemplate': {
      const instance = (state.templates ?? []).find(i => i.instanceId === cmd.target)
      if (!instance) return { ok: false, reason: 'invalid', detail: `no placed template copy '${String(cmd.target)}'` }
      const next: CompositorState = { ...state, templates: freezeInstance(state.templates ?? [], instance.instanceId) }
      return { ok: true, template: next, inverse: snapshot() }
    }
    default:
      return { ok: false, reason: 'out-of-vocabulary', detail: `unknown op '${cmd.op}'` }
  }
}

/** Postcondition checks on a frame (parity with Smart Layout's verify): a layer
 *  off-canvas, text too small or low-contrast against the background, a busy
 *  palette, or an all-centred composition (un-Swiss). Pure; warnings only. */
export function verifyCompositor(state: CompositorState): LayoutIssue[] {
  const issues: LayoutIssue[] = []
  const bg = typeof state.background === 'string' ? parseColor(state.background) : null
  const colours = new Set<string>()
  const addColour = (p?: Paint) => { if (typeof p === 'string') { const c = parseColor(p); if (c) colours.add(`${c.r},${c.g},${c.b}`) } }
  addColour(state.background)
  const texts: TextLayer[] = []

  for (const l of state.layers) {
    if (l.visible === false) continue
    const name = l.kind === 'text' ? `“${(l as TextLayer).text}”` : l.kind
    if (l.x < -0.02 || l.x > 1.02 || l.y < -0.02 || l.y > 1.02) {
      issues.push({ level: 'warn', target: l.id, message: `${name} is off-canvas (its centre is outside the frame)` })
    }
    if (l.kind === 'text') {
      const t = l as TextLayer
      texts.push(t)
      addColour(t.color)
      if (t.fontSize < 0.018) issues.push({ level: 'warn', target: l.id, message: `${name} is very small — likely unreadable` })
      const txt = typeof t.color === 'string' ? parseColor(t.color) : null
      if (txt && bg) {
        const ratio = contrastRatio(txt, bg)
        if (ratio < 2.5) issues.push({ level: 'warn', target: l.id, message: `${name} may be hard to read — low contrast (${ratio.toFixed(1)}:1) on the background` })
      }
    } else if (l.kind === 'rect' || l.kind === 'ellipse' || l.kind === 'path') {
      addColour((l as unknown as { fill?: Paint }).fill)
    }
  }
  if (colours.size > SWISS_LIMITS.maxColours) {
    issues.push({ level: 'warn', message: `${colours.size} colours in use — Swiss style favours restraint (one accent)` })
  }
  if (texts.length >= 2 && texts.every(t => t.align === 'center')) {
    issues.push({ level: 'warn', message: 'all text is centred — Swiss style favours a flush-left, asymmetric composition' })
  }
  return issues
}

/** Human-readable summary of a command for the proposal UI. */
export function summarizeCompositorChange(state: CompositorState, cmd: Command): { label: string; before: string; after: string } | null {
  const layer = findLayer(state, cmd.target)
  const name = layer ? (layer.kind === 'text' ? `“${layer.text}”` : layer.kind) : (cmd.target ?? '')
  const a = cmd.args ?? {}
  switch (cmd.op) {
    case 'setText': return { label: name || 'Text', before: layer && layer.kind === 'text' ? layer.text : '', after: String(a.text ?? '') }
    case 'setFill': return { label: `${name} fill`, before: layer ? paintLabel((layer as unknown as Record<string, Paint>)[fillField(layer.kind) ?? ''] as Paint) : '', after: paintLabel(a.paint as Paint) }
    case 'setStroke': return { label: `${name} stroke`, before: '', after: paintLabel(a.paint as Paint) }
    case 'setTextStyle': { const p = (a.patch ?? {}) as Record<string, unknown>; return { label: `${name} type`, before: '', after: Object.keys(p).map(k => `${k}: ${String(p[k])}`).join(', ') } }
    case 'setLayerProps': { const p = (a.patch ?? {}) as Record<string, unknown>; return { label: name || 'Layer', before: '', after: Object.keys(p).map(k => `${k}: ${String(p[k])}`).join(', ') } }
    case 'setSize': return { label: `${name} size`, before: '', after: ['w', 'h', 'scale'].filter(k => k in a).map(k => `${k}: ${String((a as Record<string, unknown>)[k])}`).join(', ') }
    case 'addLayer': { const l = a.layer as { kind?: string; text?: string } | undefined; return { label: 'Add layer', before: '', after: l?.kind === 'text' ? `text “${String(l.text ?? '')}”` : (l?.kind ?? 'layer') } }
    case 'addShape': return { label: 'Add shape', before: '', after: String(a.shape ?? 'shape') }
    case 'removeLayer': return { label: 'Remove layer', before: name, after: 'deleted' }
    case 'setLayerDepth': return { label: `${name} order`, before: '', after: String(a.to ?? '') === 'back' ? 'behind everything' : 'bring to front' }
    case 'setBackground': return { label: 'Frame background', before: paintLabel(state.background), after: paintLabel(a.paint as Paint) }
    case 'generateImage': return { label: 'Add image', before: '', after: String(a.prompt ?? 'generated') }
    case 'removeImageBackground': return { label: name, before: '', after: 'cut out' }
    case 'editImage': return { label: name, before: '', after: String(a.instruction ?? 'edited') }
    case 'setLayerEffect': {
      const type = String((a.effect as Record<string, unknown> | undefined)?.type ?? '')
      const had = !!layer?.effects?.some(e => e.type === type)
      return { label: `${type} effect (layer ${name || String(cmd.target ?? '')})`, before: had ? type : 'none', after: a.remove === true ? 'removed' : 'updated' }
    }
    case 'setPostEffect': {
      const type = String((a.effect as Record<string, unknown> | undefined)?.type ?? '')
      const had = !!state.postEffects?.some(e => e.type === type)
      return { label: `${type} effect (frame)`, before: had ? type : 'none', after: a.remove === true ? 'removed' : 'updated' }
    }
    case 'setLayerMaskBreak': return { label: `${name} break-out`, before: '', after: a.remove === true ? 'removed' : String(a.edge ?? '') }
    case 'placeTemplate': { const t = a.template as { name?: string } | undefined; return { label: 'Place template', before: '', after: t?.name ?? 'template' } }
    case 'setTemplateSlot': {
      const inst = state.templates?.find(i => i.instanceId === cmd.target)
      return { label: `Template slot ${String(a.slotId ?? '')}`, before: inst?.slotValues[String(a.slotId ?? '')] ?? '', after: String(a.value ?? '') }
    }
    case 'freezeTemplate': return { label: 'Freeze template copy', before: 'linked', after: 'detached' }
    default: return { label: cmd.op, before: '', after: a ? JSON.stringify(a) : '' }
  }
}
