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
import { layerMaskRef, localLayerBox, type DealLayer, type LocalLayer, type LocalLayerKind, type Paint, type ScatterLayer, type TextLayer } from '~/composables/useCompositorLayers'
import type { Command, CommandResult, CommandSpec, SurfaceSnapshot } from '~/lib/agent/commandSurface'
import { contrastRatio, parseColor, type LayoutIssue } from '~/lib/agent/verify'
import { SWISS_LIMITS } from '~/lib/agent/designPrinciples'
import { defaultPostEffect, POST_EFFECT_DEFAULTS, POST_FX_PARAM_CLAMP, type PostEffect } from '~/lib/compositor/postEffects'
import { sanitizeTornEdge } from '~/lib/compositor/tornEdge'
import { sanitizeFeather } from '~/lib/compositor/feather'
import { effectStackOf, writeStackToLayer, addEffect, createEffect, EFFECT_LABELS, EFFECT_ORDER, isEffectKind, type EffectInstance } from '~/lib/compositor/effectStack'
import { maskBreakFromEdge, type MaskBreak, type MaskBreakEdge } from '~/lib/compositor/maskBreak'
import {
  strokeStackOf, layerStoresStrokeStack, writeStrokeStackToLayer,
  addStroke as appendStroke, removeStroke as dropStroke,
  strokeSupportsStack, strokeSupportsShapes, STROKE_JOINS, STROKE_STYLES,
  type StrokeInstance, type StrokeAlign,
} from '~/lib/compositor/strokeStack'
import type { LayerGroup } from '~/lib/compositor/layerGroups'
import { readGrid } from '~/lib/frame/gridConfig'
import type { FrameGrid } from '~/lib/frame/grid'
import { normalizeVocab } from '~/lib/compositor/dealVocab'
import {
  mosaicStyleFromArgs, cellFillOfStyle, mosaicStyleOf, DEFAULT_MOSAIC_STYLE, isMosaicCellFill, isMosaicShaderFill,
  mosaicShaderSpec, mosaicLookNames, mosaicLookNameIn, mosaicLookOf, applyMosaicLook, type MosaicCellFill, type MosaicShaderFill,
} from '~/lib/compositor/mosaic'
import type { ShaderSpec } from '~/lib/spacetype/fillTile'
import type { ParamValue } from '~/lib/shaderfx/types'
import { defaultPane, normalizePane, panePresetPatch, panePresetOf, PANE_PRESET_NAMES, type PaneParams, type PanePresetName } from '~/lib/compositor/pane'
import { defaultModular, normalizeModular, modularPresetPatch, modularPresetOf, MODULAR_PRESET_NAMES, type ModularParams, type ModularPresetName } from '~/lib/compositor/modular'
import { defaultParcel, normalizeParcel, parcelPresetPatch, parcelPresetOf, PARCEL_PRESET_NAMES, type ParcelParams, type ParcelPresetName } from '~/lib/compositor/parcel'
import { defaultMosh, normalizeMosh, moshPresetPatch, moshPresetOf, MOSH_PRESET_NAMES, type MoshParams, type MoshPresetName } from '~/lib/compositor/mosh'
import { defaultCarve, normalizeCarve, carvePresetPatch, carvePresetOf, CARVE_PRESET_NAMES, type CarveParams, type CarvePresetName } from '~/lib/compositor/carve'
import { defaultTotem, normalizeTotem, totemPresetPatch, totemPresetOf, TOTEM_PRESET_NAMES, type TotemParams, type TotemPresetName } from '~/lib/compositor/totem'
import { defaultBlueprint, normalizeBlueprint, blueprintPresetPatch, blueprintPresetOf, BLUEPRINT_PRESET_NAMES, type BlueprintParams, type BlueprintPresetName } from '~/lib/compositor/blueprint'
import {
  SCATTER_STYLES, DEFAULT_SCATTER_STYLE, DEFAULT_SCATTER_SEED, scatterStyleRow, scatterStyleOf,
  scatterStyleFromArgs, scatterParams, freshScatterSeed, type ScatterStyle,
} from '~/lib/compositor/scatter'
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
  /** The frame's aspect as H/W (16:9 landscape = 0.5625, portrait > 1). Layer
   *  boxes are width-normalized, so a layer that fills the frame is `w: 1,
   *  h: aspect` — the mosaic op's create reads it. Absent = square (1). */
  aspect?: number
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

/** A Mosaic's internal `cellFill` — the style table in lib/compositor/mosaic maps the
 *  agent's plain style words (tiles | pane | …) onto it; `solid` is the `tiles` style. */
type DealFill = MosaicCellFill
/** The five canvas-generator looks — each has its own tunables object on the
 *  mosaic op's args and its own palette-preset table. The two SHADER styles
 *  (oddgrid / static) are not looks in this sense: their tunables live on a
 *  ShaderSpec and their "palette" is the effect's Looks (mosaicLookNames). */
type DealLook = 'pane' | 'modular' | 'parcel' | 'mosh' | 'carve' | 'totem' | 'blueprint'
const isDealFill = isMosaicCellFill
/** THE precedence order for an implied look — first wins. Shared by create and
 *  reconfigure so `{pane:{}, mosh:{}}` lands on the same fill either way. */
const DEAL_LOOK_ORDER: readonly DealLook[] = ['pane', 'modular', 'parcel', 'mosh', 'carve', 'totem', 'blueprint']
const DEAL_PRESET_NAMES: Record<DealLook, readonly string[]> = {
  pane: PANE_PRESET_NAMES, modular: MODULAR_PRESET_NAMES, parcel: PARCEL_PRESET_NAMES, mosh: MOSH_PRESET_NAMES,
  carve: CARVE_PRESET_NAMES, totem: TOTEM_PRESET_NAMES, blueprint: BLUEPRINT_PRESET_NAMES,
}
/** The canonical preset name `raw` spells in `look`'s table (case-insensitive), or null. */
function presetNameIn(look: DealLook, raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const lc = raw.trim().toLowerCase()
  return DEAL_PRESET_NAMES[look].find(n => n.toLowerCase() === lc) ?? null
}
/** The palette word the model sent: `palettePreset` (the generators' word) or `look`
 *  (the shader styles' word) — one concept, both spellings accepted for every style. */
const paletteArg = (a: Record<string, unknown>): unknown => a.palettePreset ?? a.look
const lookArgs = (a: Record<string, unknown>, look: DealLook): Record<string, unknown> | null =>
  a[look] && typeof a[look] === 'object' ? a[look] as Record<string, unknown> : null

/**
 * The ONE rule for which cell fill the mosaic op's args imply when no explicit
 * `style` (or its `cellFill` alias) was sent (used by create AND reconfigure):
 *   1. a tunables object — pane → modular → parcel → mosh → carve → totem → blueprint, FIRST wins;
 *   2. else a `palettePreset` whose name lives in one look's table (the five
 *      tables are disjoint), same order;
 *   3. else null (create ⇒ the default style, modular; reconfigure ⇒ keep the
 *      current fill).
 * An explicit style always wins over all of this (see resolveDealFill).
 */
export function impliedDealFill(a: Record<string, unknown>): DealFill | null {
  for (const look of DEAL_LOOK_ORDER) if (lookArgs(a, look)) return look
  for (const look of DEAL_LOOK_ORDER) if (presetNameIn(look, paletteArg(a))) return look
  // A shader Look name alone implies its style too (after the generators: "Bloom"
  // is both a Modular preset and an Oddgrid Look, and the generator wins).
  for (const sf of ['oddgrid', 'static'] as const) if (mosaicLookNameIn(sf, paletteArg(a))) return sf
  return null
}

/** The final fill + the palettePreset resolved ONLY against that fill's table. A
 *  preset that names nothing there (wrong table, typo, or a fill with no table) is
 *  an error, never a silent no-op or a recolour of a look that isn't showing. */
function resolveDealFill(a: Record<string, unknown>, current: DealFill): { ok: true; fill: DealFill; preset: string | null } | { ok: false; detail: string } {
  const explicit = mosaicStyleFromArgs(a)
  const fill: DealFill = explicit ? cellFillOfStyle(explicit) : (impliedDealFill(a) ?? current)
  if (paletteArg(a) == null) return { ok: true, fill, preset: null }
  const raw = String(paletteArg(a))
  if (fill === 'solid') {
    return { ok: false, detail: `palettePreset "${raw}" needs a style with inks of its own — send style "pane" | "modular" | "parcel" | "mosh" | "carve" | "totem" | "blueprint" | "oddgrid" | "static" (tiles uses vocab)` }
  }
  if (isMosaicShaderFill(fill)) {
    const look = mosaicLookNameIn(fill, raw)
    if (!look) return { ok: false, detail: `unknown look "${raw}" for ${fill}; options: ${mosaicLookNames(fill).join(' | ')}` }
    return { ok: true, fill, preset: look }
  }
  const preset = presetNameIn(fill, raw)
  if (!preset) return { ok: false, detail: `unknown palettePreset "${raw}" for ${fill}; options: ${DEAL_PRESET_NAMES[fill].join(' | ')}` }
  return { ok: true, fill, preset }
}

/** One look's partial-params patch: the preset patch (only when the preset was
 *  resolved for THIS look) laid under the explicit `<look>:{…}` fields; null when
 *  neither applies, so a look the model never mentioned is left alone. */
function lookPatch<T>(a: Record<string, unknown>, look: DealLook, presetPatch: Partial<T> | null): Partial<T> | null {
  const explicit = lookArgs(a, look) as Partial<T> | null
  if (!presetPatch && !explicit) return null
  return { ...(presetPatch ?? {}), ...(explicit ?? {}) }
}
/** All five looks' patches for one mosaic call, given the resolved fill + preset. */
function dealLookPatches(a: Record<string, unknown>, fill: DealFill, preset: string | null) {
  const on = (look: DealLook) => fill === look && preset ? preset : null
  const paneName = on('pane'); const modName = on('modular'); const parName = on('parcel')
  const moshName = on('mosh'); const carveName = on('carve'); const totemName = on('totem'); const blueprintName = on('blueprint')
  return {
    pane: lookPatch<PaneParams>(a, 'pane', paneName ? panePresetPatch(paneName as PanePresetName) : null),
    modular: lookPatch<ModularParams>(a, 'modular', modName ? modularPresetPatch(modName as ModularPresetName) : null),
    parcel: lookPatch<ParcelParams>(a, 'parcel', parName ? parcelPresetPatch(parName as ParcelPresetName) : null),
    mosh: lookPatch<MoshParams>(a, 'mosh', moshName ? moshPresetPatch(moshName as MoshPresetName) : null),
    carve: lookPatch<CarveParams>(a, 'carve', carveName ? carvePresetPatch(carveName as CarvePresetName) : null),
    totem: lookPatch<TotemParams>(a, 'totem', totemName ? totemPresetPatch(totemName as TotemPresetName) : null),
    blueprint: lookPatch<BlueprintParams>(a, 'blueprint', blueprintName ? blueprintPresetPatch(blueprintName as BlueprintPresetName) : null),
  }
}

/** The model's `shader: { params }` patch, sanitized: only string / number / stop-list
 *  values, keyed as the ShaderSpec stores them (with or without the `u_` prefix —
 *  resolveEffectParams drops anything the effect doesn't declare). */
function shaderParamsPatch(a: Record<string, unknown>): Record<string, ParamValue> | null {
  const sh = a.shader && typeof a.shader === 'object' ? a.shader as Record<string, unknown> : null
  const raw = sh?.params && typeof sh.params === 'object' ? sh.params as Record<string, unknown> : null
  if (!raw) return null
  const out: Record<string, ParamValue> = {}
  for (const [k, v] of Object.entries(raw)) {
    const key = k.startsWith('u_') ? k.slice(2) : k
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v
    else if (typeof v === 'string') out[key] = v
    else if (Array.isArray(v)) out[key] = v as ParamValue
  }
  return out
}
/** The ShaderSpec a shader-style mosaic ends up with after one mosaic call: the
 *  current spec re-targeted / re-seeded (mosaicShaderSpec keeps a same-effect spec),
 *  the resolved Look laid over it, then the explicit `shader.params` on top. */
function shaderSpecAfter(a: Record<string, unknown>, fill: MosaicShaderFill, seed: number, look: string | null, prev?: ShaderSpec): ShaderSpec {
  let spec = mosaicShaderSpec(fill, seed, prev)
  if (look) spec = applyMosaicLook(spec, look)
  const patch = shaderParamsPatch(a)
  if (patch) spec = { ...spec, params: { ...spec.params, ...patch } }
  return spec
}

/** A look's params for the agent snapshot: the tunables WITHOUT the ink arrays
 *  (long, and the model edits them by preset name anyway) plus the preset name the
 *  current colours match — "custom" when none does, "vocab" when the look is
 *  drawing from the deal vocabulary instead of its own inks. */
function describeDealLook(l: DealLayer, fill: DealLook): Record<string, unknown> {
  if (fill === 'pane') {
    const { inks, ...rest } = l.pane ?? defaultPane()
    return { palettePreset: panePresetOf({ ...rest, inks }) ?? ((inks?.length ?? 0) < 2 ? 'vocab' : 'custom'), ...rest }
  }
  if (fill === 'modular') {
    const { inks, ...rest } = l.modular ?? defaultModular()
    return { palettePreset: modularPresetOf({ ...rest, inks }) ?? (inks.length === 0 ? 'vocab' : 'custom'), ...rest }
  }
  if (fill === 'parcel') {
    const p = l.parcel ?? defaultParcel()
    return { palettePreset: parcelPresetOf(p) ?? 'custom', ...p }
  }
  if (fill === 'carve') {
    const { inks, ...rest } = l.carve ?? defaultCarve()
    return { palettePreset: carvePresetOf({ ...rest, inks }) ?? 'custom', ...rest }
  }
  if (fill === 'totem') {
    const { inks, ...rest } = l.totem ?? defaultTotem()
    return { palettePreset: totemPresetOf({ ...rest, inks }) ?? 'custom', ...rest }
  }
  if (fill === 'blueprint') {
    const { paper, ink, inkDim, ...rest } = l.blueprint ?? defaultBlueprint()
    return { palettePreset: blueprintPresetOf({ paper, ink, inkDim }) ?? 'custom', ...rest }
  }
  const { inks, ...rest } = l.mosh ?? defaultMosh()
  return { palettePreset: moshPresetOf({ ...rest, inks }) ?? 'custom', ...rest }
}

// ── The Scatter element (kind 'scatter') ──────────────────────────────────────
// A Scatter is a SIBLING of the Mosaic, not one of its styles, so it gets its own
// op. Everything per-style is read off the registry (lib/compositor/scatter): the
// style words, the dials, the palette tables and the paint. The ONE thing a person
// still has to write per style is its sentence for the model — see SCATTER_BLURBS.

/** One plain sentence per style, for the `scatter` op's hint. */
const SCATTER_BLURBS: Record<string, string> = {
  chaff: 'a litter of curved blades strewn over the sheet, most modest with a few running huge (crescent: a spindle fattest at its middle; leaf: full width at the head, falling away to a tip; bar: flat-topped with a short ramp at each end), printed in two inks through a speckled mask that breaks up both the blades and the bare sheet',
  strand: 'chains of short rods set one after the next along a wandering line, a nick showing at every join, splitting into side arms as they travel; each rod carries a freehand contour rather than a stroked one, so no two of them match; they print in a third ink over a second impression of the same shapes offset a little down and to the left, and the ink is allowed to break up near each rod\'s rim — as loose specks, as long streaks running one way, or as the dots of a halftone screen',
  husk: 'lumpy ovals scattered over the sheet in three inks — a ground, a dark body and a lighter fill inside each body; overlapping husks share one outline but keep separate fills; Bite removes part of each fill, as crumble (noise-shaped holes, more of the fill lost as Eat rises) or as dots (a screen of round dots sized by how far inside the husk they sit)',
}

/** The style's `<style>: {…}` args object, when the model sent one. */
const scatterArgs = (a: Record<string, unknown>, style: string): Record<string, unknown> | null =>
  a[style] && typeof a[style] === 'object' ? a[style] as Record<string, unknown> : null

/** The canonical preset name `raw` spells in `style`'s table (case-insensitive), or null. */
function scatterPresetNameIn(style: string, raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const lc = raw.trim().toLowerCase()
  return scatterStyleRow(style).presetNames.find(n => n.toLowerCase() === lc) ?? null
}

/**
 * Which style the args imply when no explicit `style` was sent (create AND
 * reconfigure): a tunables object first, in registry order, then a palettePreset
 * whose name lives in one style's table; else null (create ⇒ the default style,
 * reconfigure ⇒ keep the current one). An explicit style always wins.
 */
export function impliedScatterStyle(a: Record<string, unknown>): ScatterStyle | null {
  for (const row of SCATTER_STYLES) if (scatterArgs(a, row.id)) return row.id
  for (const row of SCATTER_STYLES) if (scatterPresetNameIn(row.id, paletteArg(a))) return row.id
  return null
}

/** The final style + the palettePreset resolved ONLY against that style's table. A
 *  name that is in no table is an error, never a silent no-op. */
function resolveScatterStyle(a: Record<string, unknown>, current: ScatterStyle):
{ ok: true; style: ScatterStyle; preset: string | null } | { ok: false; detail: string } {
  const ids = SCATTER_STYLES.map(r => r.id)
  const explicit = scatterStyleFromArgs(a)
  if (a.style != null && !explicit) {
    return { ok: false, detail: `unknown style "${String(a.style)}"; options: ${ids.join(' | ')}` }
  }
  const style = explicit ?? impliedScatterStyle(a) ?? current
  if (paletteArg(a) == null) return { ok: true, style, preset: null }
  const raw = String(paletteArg(a))
  const preset = scatterPresetNameIn(style, raw)
  if (!preset) {
    return { ok: false, detail: `unknown palettePreset "${raw}" for ${style}; options: ${scatterStyleRow(style).presetNames.join(' | ')}` }
  }
  return { ok: true, style, preset }
}

/** One style's params after a scatter call: the preset's colours (only when the
 *  preset was resolved for THIS style) laid under the explicit `<style>:{…}` fields,
 *  normalized onto whatever the layer already carries. null = the model never
 *  mentioned this style, so leave it alone. */
function scatterParamsAfter(a: Record<string, unknown>, style: string, preset: string | null, cur: unknown): Record<string, unknown> | null {
  const row = scatterStyleRow(style)
  const explicit = scatterArgs(a, style)
  const presetPatch = preset ? row.presetPatch(preset) : null
  if (!explicit && !presetPatch) return null
  return row.normalize({ ...row.normalize(cur), ...(presetPatch ?? {}), ...(explicit ?? {}) })
}

/** A scatter's dials for describeCompositor: the preset NAME rather than the ink
 *  list (the model reads and writes palettes by name, and an ink array is noise). */
function describeScatter(l: ScatterLayer): Record<string, unknown> {
  const row = scatterStyleRow(l.style)
  const params = scatterParams(l as unknown as { style: string; seed: number }) as Record<string, unknown>
  const { inks, ...rest } = params
  void inks
  return { palettePreset: row.presetOf(params) ?? 'custom', ...rest }
}

/**
 * The `scatter` op's hint, built from the registry so a new style's dials, ranges and
 * palettes reach the model from its own module — only its sentence (SCATTER_BLURBS)
 * is written by hand.
 */
const SCATTER_HINT: string = (() => {
  const styles = SCATTER_STYLES.map((row) => {
    const dials = row.controls.map((c) => {
      if (c.kind === 'select') return `${c.key} (${c.options.map(o => o.value).join(" | ")})`
      const step = c.step >= 1 ? 'whole numbers' : ''
      return `${c.key} (${c.min}..${c.max}${step ? ', ' + step : ''})`
    }).join(', ')
    return `"${row.id}" — ${SCATTER_BLURBS[row.id] ?? row.label}. ${row.id}: { ${dials} }; palettePreset: ${row.presetNames.join(' | ')}`
  }).join('. ')
  return 'Add a SCATTER — a generative element of thrown marks as ONE self-painting layer that BAKES into the render — or restyle one. '
    + 'This is what "scatter some blades over it", "add a printed leaf pattern", "throw marks across the frame", "re-roll the scatter", "more blades", "bigger marks" mean. '
    + 'To CREATE one, omit target (it fills the whole frame: w 1, h = the frame aspect; default style '
    + `${DEFAULT_SCATTER_STYLE}); to restyle or reconfigure an existing one, target = the scatter layer's id (its box is left alone). `
    + `style: ${styles}. `
    + 'An explicit style always wins; without one, a tunables object implies its style, then a palettePreset name does. '
    + 'palettePreset is checked against the FINAL style\'s table only — a name from another style\'s table is an error, not a silent recolour. '
    + 'args: { style (see above), <style>: { … its dials … }, palettePreset (a palette by name), seed (integer 1..9999 — the variation), '
    + 'generate (bool — re-roll a fresh seed for a new variation; the style, box and dials are kept), id? (choose one to target it later) }. '
    + 'A Scatter is NOT a Mosaic: a mosaic is a composition (a frame divided and filled), a scatter is loose marks with no layout — use the `mosaic` op for the former.'
})()

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

type LocalEffectKind = 'drop_shadow' | 'inner_shadow' | 'layer_blur' | 'background_blur'

/** Merge model-provided params for the four layer-local effect kinds (shadows bound to
 *  the layer's own silhouette, and the two blurs) over current/defaults with clamps —
 *  mirrors sanitizeTornEdge/sanitizeFeather's shape. These kinds have no
 *  POST_EFFECT_DEFAULTS entry, so sanitizePostEffect can't validate them; their
 *  canonical defaults instead come from effectStack's `createEffect`. */
function sanitizeLocalEffect(type: LocalEffectKind, raw: unknown, cur?: EffectInstance): Record<string, unknown> {
  const base = (cur ?? createEffect(type)) as unknown as Record<string, unknown>
  const r = (raw ?? {}) as Record<string, unknown>
  if (type === 'drop_shadow' || type === 'inner_shadow') {
    return {
      color: typeof r.color === 'string' ? r.color : (base.color as string),
      x: clamp(r.x, -1, 1, base.x as number),
      y: clamp(r.y, -1, 1, base.y as number),
      blur: clamp(r.blur, 0, 1, base.blur as number),
      visible: true,
    }
  }
  return {
    radius: clamp(r.radius, 0, 1, base.radius as number),
    visible: true,
  }
}

type GeometryEffectKind = 'trim' | 'offset' | 'round_corners' | 'roughen'

/** Merge model-provided params for the four geometry kinds (they transform a vector
 *  layer's outline before it rasterises) over current/defaults with clamps — same
 *  merge-over-`createEffect`-defaults shape as sanitizeLocalEffect. These have no
 *  POST_EFFECT_DEFAULTS entry, so their canonical defaults come from effectStack. */
function sanitizeGeometryEffect(type: GeometryEffectKind, raw: unknown, cur?: EffectInstance): Record<string, unknown> {
  const base = (cur ?? createEffect(type)) as unknown as Record<string, unknown>
  const r = (raw ?? {}) as Record<string, unknown>
  if (type === 'trim') {
    return {
      start: clamp(r.start, 0, 1, base.start as number),
      end: clamp(r.end, 0, 1, base.end as number),
      offset: clamp(r.offset, -1, 1, base.offset as number),
      visible: true,
    }
  }
  if (type === 'offset') {
    return { distance: clamp(r.distance, -1, 1, base.distance as number), visible: true }
  }
  if (type === 'round_corners') {
    return { radius: clamp(r.radius, 0, 1, base.radius as number), visible: true }
  }
  return {
    amount: clamp(r.amount, 0, 1, base.amount as number),
    detail: Math.round(clamp(r.detail, 1, 32, base.detail as number)),
    seed: Math.round(clamp(r.seed, 0, 1e6, base.seed as number)),
    visible: true,
  }
}

/** Which field carries the FILL paint for each layer kind (null = no fill). */
function fillField(kind: LocalLayerKind): string | null {
  if (kind === 'text') return 'color'
  if (kind === 'image') return 'tint'
  if (kind === 'rect' || kind === 'ellipse' || kind === 'path') return 'fill'
  return null // line has stroke only
}

/**
 * Where a kind keeps its outline(s).
 *
 * This replaced `strokeField(kind)`, which answered "which ONE field carries this kind's
 * stroke paint" and could therefore only ever describe or set one outline. A stroked kind
 * now keeps an ordered LIST, read through `strokeStackOf` — the same reader the painter,
 * the inspector and the SVG writer use, so none of them can disagree about what a layer's
 * strokes are.
 *
 * `'line'` is its own answer rather than a member of the stack: a line has no interior to
 * offset a band from, and its painter arm reads `layer.stroke` / `layer.strokeWidth`
 * directly (see `strokeSupportsStack`'s note on why that is deliberate). `null` is every
 * kind with no outline at all — an image, a mosaic, a scatter, a brush, a wired layer.
 * `strokeField` answered `'stroke'` for all of those, so `setStroke` used to write a field
 * nothing would ever read.
 */
function strokeHome(kind: LocalLayerKind): 'stack' | 'line' | null {
  if (strokeSupportsStack(kind)) return 'stack'
  return kind === 'line' ? 'line' : null
}

/** The legacy paint field a stackable kind reads through — see `strokeStackOf`. */
const legacyStrokeField = (kind: LocalLayerKind): string => (kind === 'text' ? 'strokeColor' : 'stroke')

/**
 * True when this layer's strokes come from the ARRAY, not from the legacy pair.
 *
 * The distinction decides whether `setStroke` may keep writing the old fields. It matters
 * in one direction only, and badly: writing `stroke`/`strokeWidth` onto a layer that has a
 * stack makes `legacyLive` true inside `strokeStackOf`, which sends the whole array down
 * the legacy branch — every other outline gone, from one unrelated recolour.
 *
 * This used to read `stack[0].id !== 'legacy'`, which asks a DIFFERENT question — what the
 * first entry is called — and got the answer wrong for the one layer it most had to get
 * right. `addStroke` folds a legacy layer's synthesised entry into the new list, so the
 * stored list was led by an entry still carrying the reading sentinel; the predicate said
 * "no stack", `setStroke` wrote the legacy pair back over the array, and the outline the
 * user had just added disappeared. Whether a layer stores a list is a fact about the LAYER,
 * so it is asked of the layer — and `writeStrokeStackToLayer` no longer lets the sentinel
 * reach storage in the first place, so either fix alone would close it.
 */
const storesStrokeStack = (layer: LocalLayer): boolean => layerStoresStrokeStack(layer as never)

/** Every key `setStrokeProps` (and `addStroke`'s optional patch) accepts. */
const STROKE_PROPS = new Set(['paint', 'width', 'distance', 'align', 'dash', 'join', 'style', 'shapes', 'visible'])

/**
 * One stroke with a model's patch applied, or the reason to refuse the whole command.
 *
 * Refusing rather than dropping a bad key is the same choice `setTextStyle` makes: a
 * silently ignored key teaches a model that the key works. The two REFUSALS that are about
 * this feature rather than about typing are worth naming — a shapes outline on a kind that
 * has no exact outline to march along (text), and a `shapeId` that is not in the library.
 * Both would otherwise store a well-formed stroke that paints nothing.
 */
function strokePatch(
  kind: LocalLayerKind, cur: StrokeInstance, raw: unknown,
): { ok: true; stroke: StrokeInstance } | { ok: false; detail: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, detail: 'missing args.patch' }
  const p = raw as Record<string, unknown>
  const bad = Object.keys(p).filter(k => !STROKE_PROPS.has(k))
  if (bad.length) return { ok: false, detail: `stroke key(s) not valid: ${bad.join(', ')}` }
  const next: StrokeInstance = clone(cur)

  if ('paint' in p) {
    if (!isValidPaint(p.paint)) return { ok: false, detail: 'paint must be a colour, a gradient object, or "none"' }
    next.paint = clone(p.paint) as Paint
  }
  if ('width' in p) next.width = clamp(p.width, 0, 1, next.width)
  // Both signs are real: positive is outside the edge, negative inside it.
  if ('distance' in p) next.distance = clamp(p.distance, -1, 1, next.distance ?? 0)
  if ('visible' in p) next.visible = p.visible !== false
  if ('align' in p) {
    if (p.align !== 'center' && p.align !== 'inside' && p.align !== 'outside') {
      return { ok: false, detail: 'align must be "center", "inside" or "outside"' }
    }
    next.align = p.align as StrokeAlign
  }
  if ('join' in p) {
    if (!STROKE_JOINS.includes(p.join as never)) return { ok: false, detail: `join must be ${STROKE_JOINS.map(j => `"${j}"`).join(' or ')}` }
    next.join = p.join as StrokeInstance['join']
  }
  if ('dash' in p) {
    // `null` is how a model turns a dash back off; anything else must be the real pair.
    if (p.dash == null) delete next.dash
    else {
      const d = p.dash as Record<string, unknown>
      if (typeof d !== 'object' || !Number.isFinite(Number(d.dash))) return { ok: false, detail: 'dash must be { dash, gap } or null' }
      next.dash = { dash: clamp(d.dash, 0, 1, 0), gap: clamp(d.gap, 0, 1, 0) }
    }
  }
  if ('style' in p) {
    if (!STROKE_STYLES.includes(p.style as never)) return { ok: false, detail: `style must be ${STROKE_STYLES.map(x => `"${x}"`).join(' or ')}` }
    next.style = p.style as StrokeInstance['style']
  }
  if ('shapes' in p) {
    const raws = p.shapes as Record<string, unknown> | null | undefined
    if (!raws || typeof raws !== 'object') return { ok: false, detail: 'shapes must be { shapeId, size, spacing, follow? }' }
    if (typeof raws.shapeId !== 'string' || !shapeById(raws.shapeId)) {
      return { ok: false, detail: `unknown shape id '${String(raws.shapeId)}' — use one from document.shapeLibrary` }
    }
    next.shapes = {
      shapeId: raws.shapeId,
      size: clamp(raws.size, 0, 1, next.shapes?.size ?? 0),
      spacing: clamp(raws.spacing, 0, 1, next.shapes?.spacing ?? 0),
      ...(typeof raws.follow === 'boolean' ? { follow: raws.follow } : {}),
    }
  }
  if ((next.style ?? 'band') === 'shapes') {
    if (!strokeSupportsShapes(kind)) {
      return { ok: false, detail: `a ${kind} layer cannot take a shapes outline — it has no exact outline for the marks to march along; use style "band"` }
    }
    if (!next.shapes?.shapeId) return { ok: false, detail: 'a shapes outline needs shapes: { shapeId, size, spacing }' }
  }
  return { ok: true, stroke: next }
}

/**
 * A layer's outlines as short lines the model can read AND target: each one starts with the
 * `strokeId` that `setStrokeProps` / `removeStroke` take, so "make the outer one thinner" is
 * answerable without a second round trip.
 *
 * A shapes outline is described by its SHAPE, never by the band `width` its row still
 * carries — that number is stale for a shapes stroke, and reading it back would teach the
 * model to tune the wrong dial.
 */
function describeStrokes(l: LocalLayer): string[] | undefined {
  if (strokeHome(l.kind) !== 'stack') return undefined
  const stack = strokeStackOf(l as never)
  if (!stack.length) return undefined
  return stack.map((s) => {
    const bits: string[] = []
    if ((s.style ?? 'band') === 'shapes' && s.shapes) {
      bits.push(`${s.shapes.shapeId || 'no shape'} marks`, `size ${s.shapes.size}`, `every ${s.shapes.spacing}`)
      if (s.shapes.follow === false) bits.push('upright')
    } else {
      bits.push(paintLabel(s.paint), `width ${s.width}`)
    }
    const d = s.distance ?? 0
    if (d) bits.push(`${Math.abs(d)} ${d > 0 ? 'out' : 'in'}`)
    if (s.align && s.align !== 'center') bits.push(s.align)
    if (s.dash) bits.push(`dashed ${s.dash.dash}/${s.dash.gap}`)
    if (s.join === 'round') bits.push('round join')
    if (s.visible === false) bits.push('hidden')
    return `${s.id}: ${bits.join(', ')}`
  })
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

/**
 * Stated ceiling for the WHOLE Compositor command menu (characters of `hint`, summed).
 * Pinned by a test in `tests/unit/compositor-stroke-agent.unit.spec.ts`.
 *
 * **This is the first pin, and it is a debt, not a clean bill.** The multi-stroke plan asked
 * for the stroke ops to be paid for by compressing an existing hint against a ceiling of
 * 21,500 with 21,399 spent. Neither number was real: no such constant had ever existed in
 * this repo (it appears only in the plan document), and the menu measured **25,462** the day
 * the stroke ops were written — the `mosaic` hint alone is 11 KB of it.
 *
 * What was actually paid: the `mosaic` hint's per-style boilerplate — seven copies of
 * "sending X implies style X" and seven of "explicit X override it" — was hoisted into one
 * sentence beside the style-resolution rules it belongs with, and the four stroke hints were
 * written as tight as they go. That is 520 chars recovered against 1,274 spent, so the menu
 * grew by 754 and this ceiling is set above the old usage rather than at it.
 *
 * Closing the remaining 754 means deleting mosaic PRODUCT content — the ~60 `, default X`
 * values, or a style's prose — and that is a decision for whoever owns the mosaic surface,
 * not a side effect of a stroke feature. The next op to run this out should make it, rather
 * than move this number again: a ceiling that only ever goes up is not a budget.
 *
 * 26,250 is the measured 26,216 rounded up to the next 50, matching
 * `SHADER_GUIDANCE_CEILING`'s convention.
 */
export const COMPOSITOR_HINT_CEILING = 26250

/** The agent-facing command menu. Media ops (generateImage/editImage/
 *  removeImageBackground) are listed so the model can emit them; the composable
 *  resolves them async (they call the canvas tools). `restore` is internal. */
const COMPOSITOR_COMMANDS: CommandSpec[] = [
  { op: 'setLayerProps', hint: 'Move/transform a layer. target = layer id; args: { patch }. Keys: x, y (0..1 of canvas, layer CENTER), rotation (deg), opacity (0..1, so "50%"=0.5), blend ("normal"|"multiply"|"screen"|…), visible (bool), skewX/skewY (deg), radius (0..1, rectangle corner rounding). Positional presets (account for the layer\'s own size): centre 0.5,0.5; top-left ~0.15,0.12; top-centre 0.5,0.12; top-right ~0.85,0.12; bottom-left ~0.15,0.88; bottom-centre 0.5,0.88; bottom-right ~0.85,0.88. Relative moves ("up a bit") = adjust the CURRENT x/y shown.' },
  { op: 'setText', hint: 'Change a TEXT layer\'s copy. target = layer id; args: { text }. You may write/rewrite the copy yourself.' },
  { op: 'setTextStyle', hint: 'Style a TEXT layer. target = layer id; args: { patch }. Keys: fontFamily (ANY Google Font by name — for an Impact-style / bold condensed poster headline use "Anton" (also good: "Oswald", "Archivo Black", "Bebas Neue"); for body use "Inter"), fontWeight (100..900), fontSize (fraction of canvas WIDTH: body ~0.03, a normal heading ~0.08, a big headline ~0.15, a HUGE poster headline that fills the frame 0.25–0.45), align ("left"|"center"|"right"), lineHeight (multiplier), boxW (0..1 wrap width). For "huge headline" set fontSize ≥ 0.25 and usually fontWeight 700–900.' },
  { op: 'setFill', hint: 'Set a layer\'s FILL — text colour, shape fill, or image tint. target = layer id; args: { paint }. paint is a "#RRGGBB" colour OR a gradient object {type:"linear",angle,stops:[{offset,color}]} / {type:"radial",stops}. "none"/"" = no fill. A SHAPE PATTERN is {type:"shapes", shapeId (a library shape id like "sparkle"), a (shape colour), b (background "#RRGGBB" or "none" for transparent), angle, shapeSize, shapeGap, shapeFit}. shapeFit is "tile" (default — repeat the shape on a grid), "fill" (ONE shape scaled to cover the box, overflow cropped) or "contain" (ONE shape fitted wholly inside). shapeSize and shapeGap only apply when tiling: they are 0..1 fractions of the tile — bigger shapeSize = larger shapes, bigger shapeGap = more space between them (0 = shapes touching); count is automatic. This is what "make it blue", "give it a sunset gradient", "fill it with sparkles" mean.' },
  { op: 'setStroke', hint: 'Set a layer\'s main OUTLINE. target = layer id; args: { paint, width? }. paint as in setFill (or "none"); width is 0..1 of canvas width. Changes the topmost outline only; addStroke/setStrokeProps reach the rest of its strokes list.' },
  { op: 'addStroke', hint: 'Give a layer ANOTHER outline — "a second thin outline", "a dotted ring outside it". target = layer id (rect/ellipse/polygon/star/path/text; a line keeps one). args: { patch? }, the setStrokeProps keys. It lands UNDER the existing ones.' },
  { op: 'removeStroke', hint: 'Delete one of a layer\'s outlines. target = layer id; args: { strokeId } — an id from that layer\'s strokes list.' },
  { op: 'setStrokeProps', hint: 'Change ONE outline — "thicker outer ring", "push it further out", "dot the edge with sparkles". target = layer id; args: { strokeId (from its strokes list), patch }. patch keys: paint (as setFill; "none" keeps the row and paints nothing), width (0..1 of canvas width), distance (0..1 OUT from the edge, negative = in, 0 = on it), align ("center"|"inside"|"outside"; on text it bites only at a distance), dash ({dash,gap} same units, null = solid), join ("sharp" keeps a star\'s spikes | "round" holds every point exactly `distance` away), style ("band" = continuous | "shapes" = library shapes marching the edge; text is band-only), shapes ({ shapeId from document.shapeLibrary, size, spacing (centre-to-centre), both 0..1 of canvas width; follow (default true: marks turn to the edge) }), visible (bool). Omitted keys keep their value.' },
  { op: 'setSize', hint: 'Resize a SHAPE/image/line layer. target = layer id; args: { w?, h?, scale? } (0..1 of canvas width; line uses w as length; path uses scale). TEXT size is NOT here — use setTextStyle fontSize.' },
  { op: 'addLayer', hint: 'Add a NEW layer. args: { layer }. layer needs: kind ("text"|"rect"|"ellipse"|"line"), x, y (0..1, center). text also: text + you may set fontFamily/fontWeight/fontSize/color inline (a HUGE headline = fontSize 0.25–0.45, fontWeight 800; Impact-style font = "Anton"). Give the layer an id you choose so you can target it next. New layers land ON TOP by default — to put one BEHIND the image/other layers, follow with setLayerDepth …"back". (For images use generateImage.)' },
  { op: 'addShape', hint: 'Add a SHAPE from the shape library (sparkle, sun-rays, leaf, heart, plus, stairs, hexagon, swirl…) as a vector layer. args: { shape (an id from document.shapeLibrary), x?, y? (0..1, centre; default 0.5,0.5), w? (ink width as a fraction of the canvas width, 0.02..2 — 1 = the full width; default 0.3), fill? ("#RRGGBB" or a gradient object), id? (choose one so you can target it next) }. This is what "add a sparkle", "put a sun top-right", "drop in a heart" mean. Recolour later with setFill, resize with setSize scale, rotate with setLayerProps.' },
  { op: 'removeLayer', hint: 'Delete a layer by id. target = layer id.' },
  { op: 'setLayerDepth', hint: 'Change a layer\'s stacking depth (z-order). target = layer id; args: { to: "back" | "front" }. "back" puts it BEHIND every other layer including the connected/wired image — use this for "put the headline BEHIND the image". "front" brings it to the top.' },
  { op: 'setBackground', hint: 'Set the FRAME background that sits behind every layer. args: { paint } — a "#RRGGBB" colour, a gradient object, or "none". Use for "make the background blue / a sunset gradient".' },
  { op: 'setGrid', hint: 'Set the layout grid on a Frame — a Swiss-style guide layers can snap to (editor-only, never baked/exported). args: { patch: {...}, generate? }. patch keys: mode ("off" | "explicit" | "generated"), baseModule (0..1 of canvas width, the alignment unit), gutter (0..1), margin (0..1), columns/rows (explicit mode counts), gen: { colRange/rowRange ([min,max] column/row counts, generated mode), regularity (0..1: 0 = loose/free spacing, 1 = strict/equal), merge (bool, merge adjacent cells into larger regions), mergeMaxSpan (max cells a merged region spans), symmetry ("none" | "mirror"), seed (integer) }, overlay (bool, show the guide lines). Omitted keys keep their current value. generate:true (or reroll:true) re-rolls a fresh random seed for a new generated-grid variation; switching mode to "generated" without giving gen.seed also rolls a fresh seed. This is what "add a layout grid", "give it a 6-column grid", "generate a new grid variation", "re-roll the grid" mean.' },
  { op: 'mosaic', hint: `Add a MOSAIC — a generative composition element (playgrnd-style: a whole dense pattern as ONE self-painting layer that BAKES into the render) — or restyle one. This is what "make a colourful mosaic", "add a modular grid", "a glitchy texture", "deal a warm grid", "re-roll the pattern", "sparser tiles" mean. To CREATE a new mosaic, omit target (it fills the whole frame: w 1, h = the frame aspect; default style modular); to restyle or reconfigure an existing one, target = the mosaic layer's id (its box is left alone). style (the plain word for which composition it is): "tiles" (the seeded grid itself: every kept cell one flat fill from a palette — vocab, density and cellInset apply only here) | "pane" (rows of flush panes, each a two-colour ramp running corner to corner or edge to edge, inks drawn by distance along the palette) | "modular" (a flush grid of modules, some merged 2×2 / 2-wide / 2-tall, over a background colour — each module empty, solid, a block field, a corner dot cluster, a fine line grid or a two-colour ramp — with faint hairlines over the whole grid) | "parcel" (a coarse two-tone field of chunky ink blocks on a ground colour — every cell one or the other, hard edges, no gutter — with a few ragged rectangular clusters of fine hairline lattices, "survey grids", floating on top and darkening what they cross) | "mosh" (a corrupted signal / datamosh / glitch texture — the frame stacked as uneven horizontal bands, each a different failure: confetti runs, coarse mosaic blocks cut by hard diagonal tears that go dark, long thin smears, full-width scan rows some cut by a short bright segment, a chevron herringbone — every mark a hard-edged rect snapped to a column grid, in full-strength colour-cube inks with near-black dead patches) | "carve" (a panel collage / report cover — ONE rectangle carved into panels by repeated splits, each cut taken across the long side of one of the biggest panels, and every panel given a printed treatment in two inks: flat, hard stripes that change pitch partway across (the dropped signal), stacked chevron arrows, a grainy photographic ramp, or a single fine hairline grid with dots) | "totem" (a screenprinted totem / emblem poster — a wide mat with a speckled border band around a dark rectangular plate; inside the plate the left half is chopped into rectangles, each one flat or filled with a hard two-colour cell pattern — checks, stripes either way, diagonals, brickwork, dashes, lattices, concentric bands, scatter — and then reflected onto the right half so the whole thing reads symmetrical, with a small nested rectangle of alternating rings at the dead centre; everything snaps to one coarse pixel grid) | "blueprint" (a technical drafting grid — bright lines on a dark ground: a cartesian minor/major square lattice, plus a POLAR overlay struck from an origin that hangs off one corner (may sit just outside the box) — dashed radial spokes fanning across a quarter by default, concentric arcs with little perpendicular hatch ticks, and small angle labels like "15°"/"30°" at each spoke; still, seeded — the seed moves the origin) | "oddgrid" (a SHADER: an uneven patchwork of coloured cells on a paper ground — some cells blocky clusters, some grainy, with optional small marks — dots, rings, squares, wedges — scattered in; still, seeded) | "static" (a SHADER: riso-print static — one ink on one paper colour, coarse noise cells in a few horizontal bands with glitch tears; still, seeded). cellFill is accepted as an alias of style. Each style's own dials and its palettePreset names are listed with it below; sending a style's tunables object implies that style, and any colour or ink list inside that object overrides the preset. An explicit style always wins; without one, the first tunables object in the order pane → modular → parcel → mosh → carve → totem → blueprint implies the style, then a palettePreset name does; a create with none of those is modular. palettePreset is checked against the FINAL style's table only — a name from another style's table is an error, not a silent recolour; tiles has no presets (it uses vocab). For the two shader styles the palette is a LOOK: send look (or palettePreset — same thing) with one of oddgrid: "Patchwork" | "Bloom" | "Quilt" | "Scatter" | "Drift", static: "Wine on Periwinkle" | "Pink on Straw" | "Maroon on Orange" | "Blue on Cream" | "Green on Yellow" | "Blue on Pink" | "Black on Lime" | "Purple on Gold"; fine-tune with shader: { params: { … } } — oddgrid params: cols (cells across 8..96), scale (feature size 2..30), density (coverage 0..1), block (blockiness 0..1), bsize (block size 2..12), speck (0..0.5), grain (0..1), variety (0..1), balance (spread -1.5..1.5), motif (mark: 0 none, 1 dot, 2 ring, 3 square, 4 wedge, 5 mixed), motifAmt (marks 0..1), bg (paper hex), ramp (inks: [{pos,color}] up to 8); static params: ink (hex), bg (paper hex), res (cells across 24..160), regions (bands 1..6), glitch (0..1), mix (0..1). args: { style (see above), vocab ("brand" | "mono" | "warm" | "cool" — the palette tiles draws from; also what pane / modular draw from when they have no inks of their own), density (0..1, fraction of tiles filled; the rest are transparent; default 1), cellInset (0..0.4, gap inset per tile), pane ({ rows (1..8, default 3), cells (nominal cells per row, 1..12, default 6; each row varies it), vary (0..1 how uneven rows/cells are, default 0.55), diag (0..1 share of corner-to-corner ramps vs flat ones, default 0.45), soft (0..1 how much of each pane is the blend; 0 = hard line, default 0.85), spread (0..1 how far apart in the palette the two inks are; 0 = neighbours, default 0.55), inks (ordered hex list the spread walks — the ORDER is the look; omitted = the tool's first palette; fewer than 2 = the vocab palette) }; palettePreset: "Hot pink" | "Electric" | "Deep" | "Sorbet" | "Candy"), modular ({ gcols (module columns 2..12, default 6; rows follow the frame aspect), unit (sub-cells per module side 2..8, default 4), merge (0..1 how often modules merge, default 0.45), w ({ empty, solid, blocks, dots, lines, grad } relative weights 0..50, defaults 34/20/24/14/12/10 — empty is most common on purpose), blockFill (0..1 coverage of block/dot fields, default 0.5), dot (0..1 dot diameter within its sub-cell, default 0.62), rules (0..1 hairline opacity over the whole grid, default 0.22; 0 = none), ruleW (1..3 line width, default 1), bg (hex background), rule (hex hairline colour), inks (ordered hex list; omitted = the vocab palette) }; palettePreset: "Digital" | "Riso" | "Bloom" | "Heat" | "Mono"), parcel ({ cells (grid width in cells 8..40, default 16; rows follow the frame aspect), cover (0..1 how much of the field is ink, default 0.5), chunk (0.5..3 block scale — bigger = bigger blobs, default 1), grids (0..8 how many survey grids float on top, default 4), blend ("multiply" | "normal"; multiply = the hairlines darken ink and ground alike, default), ground (hex ground colour), ink (hex block colour), hairline (hex survey-line colour) }; palettePreset: "Lime on grey" | "Blue on cream" | "Acid on black" | "Orange on cream" | "Cyan on stone" | "Blue on olive"), mosh ({ bands (1..8 horizontal bands, default 6), cols (24..300 cells across — everything snaps to these columns, default 150), mix (0..1 how much of the palette each band draws from, default 0.62), tears (0..1 how many diagonal tears cut the mosaic bands, default 0.55; 0 = none), runs (0..1 how long the smear bands hold a value, default 0.5), bright (0..1 how often the bright ink cuts in, default 0.3), inks (ordered hex list of 8 full-strength inks; inks[1] is the bright one; omitted = the pure colour cube) }; palettePreset: "Pure cube" | "Soft cube" | "Print cube" | "Warm cube" | "Cool cube"), carve ({ cuts (1..16 how many times the frame is cut; panels = cuts + 1, default 7), uneven (0..1 how far off centre a cut may fall, default 0.55; 0 = every cut dead centre), gap (0..1 space between panels, default 0), mix (0..1 fraction of panels that are patterned rather than flat, default 0.7), stripePitch (0..1 band width on the striped panels, default 0.4), grain (0..1 noise on the photographic panels, default 0.5), gridDetail (0..1 how fine the one hairline grid panel is, default 0.5), inks (ordered hex list — two neutrals, inks[0] being the ground, then four loud inks) }; palettePreset: "Report" | "Signal" | "Playbill" | "Almanac" | "Broadsheet"), totem ({ border (0..0.4 how wide the mat band around the plate is, as a share of the short side, default 0.15), mat (0..0.7 how much of that band is speckled, default 0.36; 0 = a clean band), matGrain (1..6 how chunky the speckles are, default 2), keyline (0..10 how far the artwork sits in from the plate edge, in grid steps, default 3), regions (1..30 how many rectangles the half is chopped into, default 14), grain (16..220 how fine the pixel grid is — higher = finer, default 110), mirror (0..1 how often the reflected side repeats its partner's pattern rather than being given its own, default 1 = a true mirror), variety (0..1 how many of the eleven cell patterns are in play, default 0.7), core (0..0.6 the centre emblem's width as a share of the short side, default 0.22; 0 = no emblem), coreRings (0..8 rings nested around it, default 3), inks (ordered hex list of five — the ORDER hands out the jobs: whichever is darkest prints the plate and the rules, the first of the others is the mat, the second from the end is the speckle, and all of them fill the rectangles) }; palettePreset: "Arcade" | "Lagoon" | "Carnival" | "Kiosk" | "Neon" | "Harbour"), blueprint ({ cells (6..64 minor cells across the SHORT side, default 24), major (2..12 every Nth line is a heavy major line, default 5), minorAlpha (0..1 the minor grid's opacity, default 0.35), majorWidth (1..3 the major line width as a multiple of the minor, default 1.6), corner ("auto" | "bl" | "br" | "tr" | "tl" which corner the polar origin hangs off; "auto" lets the seed pick, default "bl" = bottom-left), originX / originY (-0.5..0.5 hand-nudge the origin, box fractions, default 0), angleStart (0..90 the first spoke's angle within the fan, default 0), angleStep (5..45 degrees between spokes, default 15), angleSpread (15..360 total fan span, default 90 = a quarter), arcs (0..10 concentric arcs, default 4), arcGap (0.05..0.6 even radial step between arcs as a short-side fraction, default 0.22), tickStep (1..30 degrees between the arc hatch ticks, default 5), labels (0..1 angle-label opacity, 0 = hidden, default 1), paper (hex dark ground), ink (hex line/arc/label colour), inkDim (hex minor-grid colour) }; palettePreset: "Blueprint" | "Cyan on navy" | "Black on cream" | "Amber on charcoal" | "White on slate"), grid ({ colRange:[min,max], rowRange:[min,max], regularity (0..1), merge (bool), symmetry ("none"|"mirror") } — the tiles layout; omitted keeps the current/frame grid), seed (integer, the variation — every style reads it), generate (bool — re-roll a fresh seed for a new variation; the style, box and dials are kept), id? (choose one to target it later) }.` },
  { op: 'scatter', hint: SCATTER_HINT },
  { op: 'generateImage', hint: 'Generate a PHOTOGRAPHIC/illustrative AI image and add it as a layer — "generate a picture of a dog", "add a city photo". Not for gradients/colours (use setBackground/setFill). args: { prompt (vivid), aspectRatio? }.' },
  { op: 'removeImageBackground', hint: 'Cut out the subject of an existing IMAGE layer (transparent background). target = image layer id.' },
  { op: 'editImage', hint: 'Edit an existing IMAGE layer from an instruction (Flux Kontext) — "make it brighter", "change the sky". target = image layer id; args: { instruction }.' },
  { op: 'setLayerEffect', hint: 'Add/update/remove an effect ON ONE LAYER — a post-processing look, a layer-local effect bound to the layer\'s own silhouette, or a geometry effect that reshapes a vector outline. target = layer id; args: { effect: { type: "adjust"|"bloom"|"grain"|"vignette"|"duotone"|"gradientMap"|"dof"|"trim"|"offset"|"round_corners"|"roughen"|"background_blur"|"inner_shadow"|"layer_blur"|"drop_shadow"|"torn_edge"|"feather", ...params }, remove? }. adjust (colour grade): brightness/contrast/saturation 0..2 (1 = neutral), hue -180..180. bloom (glow from bright areas): threshold 0..1, radius ~0.02, intensity 0..2. grain (film noise): amount 0..1, size 1..8. vignette (darkened edges): amount/size/softness 0..1. duotone (two-colour map): shadows "#RRGGBB", highlights "#RRGGBB", mix 0..1. gradientMap (map luminance through a colour ramp): stops [{pos,color}], contrast -1..1, mix 0..1. dof (depth of field, IMAGE LAYERS ONLY — estimated depth map, BRIGHT = NEAR so focus 1 is nearest, 0 furthest): focus 0..1 the sharp plane, range 0..1 widens the sharp band, aperture 0..1 blur strength (~0.02-0.05 normal, 0.1+ extreme), bladeCount 0..12 bokeh shape (6 = hexagonal, <3 = circular), bladeRotation 0..360, bloomThreshold 0..1 + bloomStrength 0..4 bloom of bright defocused points. trim (reveal only part of the outline): start/end 0..1 along the path. offset (grow or shrink the outline): distance 0..1 of canvas width, negative = inward. round_corners: radius 0..1 of canvas width. roughen (jitter the outline): amount 0..1 of canvas width, seed integer. trim/offset/round_corners/roughen are geometry effects — vector layers only (rect/ellipse/path/polygon/star and outlined text), no-op elsewhere. drop_shadow / inner_shadow (shadow from the layer\'s silhouette, outward or inward): color "rgba(...)"/"#RRGGBB", x/y -1..1 (fraction of canvas width), blur 0..1. layer_blur (blur the layer itself): radius 0..1. background_blur (blur what shows through behind the layer, within its silhouette): radius 0..1. torn_edge and feather take the same patch keys as setLayerTornEdge/setLayerFeather. Omitted params keep their current value. remove:true deletes that effect kind. This is what "blur the background", "trim the outline", "round the corners", "roughen the edges" mean.' },
  { op: 'setPostEffect', hint: 'Add/update/remove a post-processing effect on the WHOLE FRAME — applied after all layers composite. Same args and effect vocabulary as setLayerEffect (no target), EXCEPT dof, which is per-image-layer only because it needs that image\'s depth map. This is what "make it warmer", "add film grain", "cinematic colour grade" mean.' },
  { op: 'setLayerTornEdge', hint: 'Give a layer a TORN-PAPER edge (ragged, grain-dissolved boundary with an optional white "lip"). target = layer id; args: { patch: {...}, remove? }. patch keys: style ("ripped"=organic tear | "deckle"=soft handmade-paper edge | "shredded"=spiky rip), amount (tear depth px, ~10 subtle … 60 deep), roughness (0..1 fray detail), grain (px, edge crumble; 0 = crisp), grainTexture (0..1 paper-fibre on the lip), lipWidth (px white underside band; 0 = none), lipVariation (0..1 lip unevenness), lipColor ("#RRGGBB", warm white default), seed (integer, for a different tear). Omitted keys keep their value. remove:true removes it. This is what "torn paper edge" means.' },
  { op: 'setLayerFeather', hint: 'Feather (soften) a layer\'s edges so they fade smoothly to transparent — a soft edge-mask, uniform on all sides. target = layer id; args: { patch: {...}, remove? }. patch keys: amount (0..1, feather depth relative to the element\'s OWN size; ~0.1 subtle … 0.4 strong … 1 fades in to the centre), curve ("linear" = even fade | "smooth" = eased fade). Omitted keys keep their value. remove:true removes it. This is what "feather the edges" means.' },
  { op: 'setLayerMaskBreak', hint: 'Let a SUBJECT masked to a shape BREAK OUT of one edge — the head pops over the top of the circle while the rest stays clipped. target = the MASKED layer id (must already be masked to a shape, see maskBreak in its description). args: { edge ("top"|"bottom"|"left"|"right"), offset? (0..1, how far the break line sits into the shape from that edge; default 0 = the shape edge), remove? }. This is what "let his head pop out of the top" means.' },
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
    const st = effectStackOf(l)
    if (st.length) cur.effects = st.filter(e => e.visible).map(e => EFFECT_LABELS[e.type]).join(', ')
    if (l.maskBreak) cur.maskBreak = maskBreakEdgeLabel(l.maskBreak)
    if (l.kind === 'text') {
      cur.text = l.text; cur.fontFamily = l.fontFamily; cur.fontWeight = l.fontWeight
      cur.fontSize = l.fontSize; cur.color = paintLabel(l.color); cur.align = l.align; cur.lineHeight = l.lineHeight
      if (l.boxW != null) cur.boxW = l.boxW
    } else if (l.kind === 'image') { cur.image = l.filename; cur.w = l.w; cur.h = l.h; if (l.tint) cur.tint = paintLabel(l.tint) }
    // `radius` may be per-corner ([tl, tr, br, bl]); describe it as one readable
    // value so the model never learns to emit an array (setLayerProps takes a
    // number only — see PROP_CLAMP).
    else if (l.kind === 'rect') { cur.w = l.w; cur.h = l.h; cur.fill = paintLabel(l.fill); if (l.radius) cur.radius = Array.isArray(l.radius) ? l.radius.join(' / ') : l.radius }
    else if (l.kind === 'ellipse') { cur.w = l.w; cur.h = l.h; cur.fill = paintLabel(l.fill) }
    else if (l.kind === 'line') { cur.length = l.w; cur.stroke = paintLabel(l.stroke); cur.strokeWidth = l.strokeWidth }
    else if (l.kind === 'path') { cur.fill = paintLabel(l.fill); if (l.shapeId && shapeById(l.shapeId)) cur.shape = l.shapeId }
    // A Mosaic (kind 'deal' internally) reads back as its style word + that
    // style's tunables (preset name instead of ink arrays) so "sparser",
    // "re-roll", "make it Riso" are answerable. `style` is the same vocabulary the
    // mosaic op's args take (tiles for the internal 'solid').
    else if (l.kind === 'deal') {
      const fill: DealFill = l.cellFill ?? 'solid'
      cur.style = mosaicStyleOf(fill); cur.vocab = l.vocab; cur.density = l.density; cur.cellInset = l.cellInset
      cur.seed = l.grid.gen.seed
      if (isMosaicShaderFill(fill)) {
        // A shader style reads back as its Look name + the spec's own params.
        const spec = mosaicShaderSpec(fill, l.grid.gen.seed, l.shader)
        cur[fill] = { look: mosaicLookOf(spec) || 'custom', ...spec.params }
      } else if (fill !== 'solid') cur[fill] = describeDealLook(l, fill)
    }
    // A Scatter reads back as its style word, its seed and that style's dials (the
    // palette by NAME), so "more blades", "re-roll", "make it Pine" are answerable.
    else if (l.kind === 'scatter') {
      const style = scatterStyleOf(l.style)
      cur.style = style
      cur.seed = l.seed
      cur[style] = describeScatter(l)
    }
    // Outlines, for EVERY stackable kind — rect, ellipse, polygon, star, path and text
    // all answer through one reader, so the describe pass cannot report a text layer's
    // outline in a different shape from a rect's (it used to: `outline`/`outlineWidth`
    // against `stroke`/`strokeWidth`, and neither could show a second one).
    const strokes = describeStrokes(l)
    if (strokes) cur.strokes = strokes
    if (l.visible === false) cur.hidden = true
    // The agent never sees the internal kind 'deal': that layer is a "mosaic".
    const type = l.kind === 'deal' ? 'mosaic' : l.kind
    return { id: l.id, label: l.kind === 'text' ? `“${l.text}”` : type, type, current: cur }
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
      const home = strokeHome(layer.kind)
      if (!home) return { ok: false, reason: 'invalid', detail: `${layer.kind} layers have no stroke` }
      const L = layer as unknown as Record<string, unknown>
      const width = typeof cmd.args?.width === 'number' ? cmd.args.width : null
      // A layer that ALREADY stores a stack is edited through the stack, and only its top
      // (first-painted) outline is touched. Writing the legacy pair here instead would make
      // `legacyLive` true and send the whole array down `strokeStackOf`'s legacy branch —
      // every other outline deleted by a recolour that never mentioned them.
      if (home === 'stack' && storesStrokeStack(layer)) {
        const stack = strokeStackOf(layer as never)
        const top: StrokeInstance = { ...stack[0]!, paint: clone(paint) }
        if (width != null) top.width = clamp(width, 0, 1, top.width)
        Object.assign(L, writeStrokeStackToLayer([top, ...stack.slice(1)]))
        return { ok: true, template: state, inverse: snapshot() }
      }
      // Legacy (or unstroked) layer: keep writing the legacy pair. `strokeStackOf` reads it
      // back as a one-entry stack, so nothing downstream can tell — and migrating a saved
      // layer on an edit that did not need it is exactly what `strokeStack.ts` refuses to do.
      L[legacyStrokeField(layer.kind)] = clone(paint)
      if (width != null) L.strokeWidth = width
      return { ok: true, template: state, inverse: snapshot() }
    }
    case 'addStroke': {
      const layer = findLayer(state, cmd.target)
      if (!layer) return { ok: false, reason: 'invalid', detail: `no layer '${String(cmd.target)}'` }
      if (strokeHome(layer.kind) !== 'stack') {
        return { ok: false, reason: 'invalid', detail: `a ${layer.kind} layer keeps a single outline — use setStroke` }
      }
      // Appended, so the new outline paints UNDER the existing ones: adding one never
      // changes what is already visible.
      const stack = appendStroke(strokeStackOf(layer as never))
      if (cmd.args?.patch != null) {
        const patched = strokePatch(layer.kind, stack[stack.length - 1]!, cmd.args.patch)
        if (!patched.ok) return { ok: false, reason: 'invalid', detail: patched.detail }
        stack[stack.length - 1] = patched.stroke
      }
      Object.assign(layer, writeStrokeStackToLayer(stack))
      return { ok: true, template: state, inverse: snapshot() }
    }
    case 'removeStroke': {
      const layer = findLayer(state, cmd.target)
      if (!layer) return { ok: false, reason: 'invalid', detail: `no layer '${String(cmd.target)}'` }
      if (strokeHome(layer.kind) !== 'stack') {
        return { ok: false, reason: 'invalid', detail: `a ${layer.kind} layer keeps a single outline — setStroke "none" clears it` }
      }
      const id = String(cmd.args?.strokeId ?? '')
      const stack = strokeStackOf(layer as never)
      const next = dropStroke(stack, id)
      // `removeStroke` returns the SAME array when nothing matched — say so rather than
      // reporting a successful edit that changed nothing.
      if (next === stack) return { ok: false, reason: 'invalid', detail: `no outline '${id}' on layer '${String(cmd.target)}'` }
      Object.assign(layer, writeStrokeStackToLayer(next))
      return { ok: true, template: state, inverse: snapshot() }
    }
    case 'setStrokeProps': {
      const layer = findLayer(state, cmd.target)
      if (!layer) return { ok: false, reason: 'invalid', detail: `no layer '${String(cmd.target)}'` }
      if (strokeHome(layer.kind) !== 'stack') {
        return { ok: false, reason: 'invalid', detail: `a ${layer.kind} layer keeps a single outline — use setStroke` }
      }
      const id = String(cmd.args?.strokeId ?? '')
      const stack = strokeStackOf(layer as never)
      const i = stack.findIndex(s => s.id === id)
      if (i < 0) return { ok: false, reason: 'invalid', detail: `no outline '${id}' on layer '${String(cmd.target)}' — the ids are in its strokes list` }
      const patched = strokePatch(layer.kind, stack[i]!, cmd.args?.patch)
      if (!patched.ok) return { ok: false, reason: 'invalid', detail: patched.detail }
      stack[i] = patched.stroke
      Object.assign(layer, writeStrokeStackToLayer(stack))
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
    // `dealGrid` is the op's old name — kept as a silent alias so a model (or a
    // saved plan) that learned it still lands on the same handler. Not listed in
    // COMPOSITOR_COMMANDS: the menu only teaches `mosaic`.
    case 'mosaic':
    case 'dealGrid': {
      const a = (cmd.args ?? {}) as Record<string, unknown>
      const gridPatch = (a.grid ?? {}) as Partial<FrameGrid['gen']> & Partial<FrameGrid>
      const reroll = a.generate === true || a.reroll === true
      const target = cmd.target ? findLayer(state, cmd.target) : undefined
      if (cmd.target && (!target || target.kind !== 'deal')) return { ok: false, reason: 'invalid', detail: `no mosaic layer '${String(cmd.target)}'` }

      if (target && target.kind === 'deal') {
        // Reconfigure (restyle) an existing mosaic in place.
        const d = target as unknown as Record<string, unknown>
        if (a.vocab != null) d.vocab = normalizeVocab(a.vocab)
        if (typeof a.density === 'number') d.density = clamp(a.density, 0, 1, 1)
        if (typeof a.cellInset === 'number') d.cellInset = clamp(a.cellInset, 0, 0.4, 0)
        // The fill is decided ONCE, by the same rule create uses (explicit style
        // > first tunables object in pane → modular → parcel → mosh → carve → totem → blueprint > a preset's
        // table > keep the current fill); the palettePreset resolves against that
        // final fill's table only. Every look's tunables the model sent still merge
        // onto that look's params — a model may pre-set several — but only the
        // showing look receives the preset's colours. The box (w/h) is left alone.
        const resolved = resolveDealFill(a, isDealFill(d.cellFill) ? d.cellFill : 'solid')
        if (!resolved.ok) return { ok: false, reason: 'invalid', detail: resolved.detail }
        d.cellFill = resolved.fill
        const patches = dealLookPatches(a, resolved.fill, resolved.preset)
        if (patches.pane) d.pane = normalizePane(patches.pane, (d.pane as PaneParams | undefined) ?? defaultPane())
        if (patches.modular) d.modular = normalizeModular(patches.modular, (d.modular as ModularParams | undefined) ?? defaultModular())
        if (patches.parcel) d.parcel = normalizeParcel(patches.parcel, (d.parcel as ParcelParams | undefined) ?? defaultParcel())
        if (patches.mosh) d.mosh = normalizeMosh(patches.mosh, (d.mosh as MoshParams | undefined) ?? defaultMosh())
        if (patches.carve) d.carve = normalizeCarve(patches.carve, (d.carve as CarveParams | undefined) ?? defaultCarve())
        if (patches.totem) d.totem = normalizeTotem(patches.totem, (d.totem as TotemParams | undefined) ?? defaultTotem())
        if (patches.blueprint) d.blueprint = normalizeBlueprint(patches.blueprint, (d.blueprint as BlueprintParams | undefined) ?? defaultBlueprint())
        const g = clone((target as { grid: FrameGrid }).grid)
        // gen-level grid keys the model may send (colRange/rowRange/regularity/merge/symmetry).
        g.gen = { ...g.gen, ...(gridPatch as Partial<FrameGrid['gen']>) }
        if (typeof a.seed === 'number') g.gen.seed = Math.round(a.seed)
        if (reroll) g.gen.seed = Math.floor(Math.random() * 9999) + 1
        d.grid = g
        // A shader style carries its spec at the layer's seed (one variation); a
        // canvas style keeps any spec it had so hopping back restores the dials.
        if (isMosaicShaderFill(resolved.fill)) d.shader = shaderSpecAfter(a, resolved.fill, g.gen.seed, resolved.preset, d.shader as ShaderSpec | undefined)
        else if (d.shader) d.shader = { ...(d.shader as ShaderSpec), seed: g.gen.seed }
        return { ok: true, template: state, inverse: snapshot() }
      }

      // Create a new mosaic filling the frame, seeded from the frame's current grid.
      // Default style: modular — the same default the toolbar stamp uses.
      const id = typeof a.id === 'string' && a.id ? a.id : `l_${state.layers.length + 1}_mosaic`
      if (state.layers.some(l => l.id === id)) return { ok: false, reason: 'invalid', detail: `layer id '${id}' already exists` }
      const resolved = resolveDealFill(a, cellFillOfStyle(DEFAULT_MOSAIC_STYLE))
      if (!resolved.ok) return { ok: false, reason: 'invalid', detail: resolved.detail }
      const patches = dealLookPatches(a, resolved.fill, resolved.preset)
      const base = readGrid(state.grid ? { sailor_localGrid: state.grid } : undefined)
      const grid: FrameGrid = clone(base)
      if (grid.mode === 'off') grid.mode = 'generated'
      grid.gen = { ...grid.gen, ...(gridPatch as Partial<FrameGrid['gen']>) }
      if (typeof a.seed === 'number') grid.gen.seed = Math.round(a.seed)
      if (reroll) grid.gen.seed = Math.floor(Math.random() * 9999) + 1
      // Boxes are width-normalized, so filling the frame is h = aspect (H/W) —
      // the same `h: aspect` the toolbar's Mosaic stamp uses; a square frame is 1.
      const aspect = typeof state.aspect === 'number' && Number.isFinite(state.aspect) && state.aspect > 0 ? state.aspect : 1
      const layer = {
        id, kind: 'deal', x: 0.5, y: 0.5, rotation: 0, opacity: 1,
        w: 1, h: aspect,
        vocab: normalizeVocab(a.vocab ?? 'brand'),
        density: clamp(a.density, 0, 1, 1),
        cellInset: clamp(a.cellInset, 0, 0.4, 0),
        cellFill: resolved.fill,
        pane: normalizePane(patches.pane ?? {}),
        modular: normalizeModular(patches.modular ?? {}),
        parcel: normalizeParcel(patches.parcel ?? {}),
        mosh: normalizeMosh(patches.mosh ?? {}),
        carve: normalizeCarve(patches.carve ?? {}),
        totem: normalizeTotem(patches.totem ?? {}),
        blueprint: normalizeBlueprint(patches.blueprint ?? {}),
        grid,
        ...(isMosaicShaderFill(resolved.fill) ? { shader: shaderSpecAfter(a, resolved.fill, grid.gen.seed, resolved.preset) } : {}),
      } as unknown as LocalLayer
      return { ok: true, template: { ...state, layers: [...state.layers, layer] }, inverse: snapshot() }
    }
    case 'scatter': {
      const a = (cmd.args ?? {}) as Record<string, unknown>
      const reroll = a.generate === true || a.reroll === true
      const seedOf = (v: unknown, fb: number) => typeof v === 'number' && Number.isFinite(v)
        ? Math.max(1, Math.min(9999, Math.round(v))) : fb
      const target = cmd.target ? findLayer(state, cmd.target) : undefined
      if (cmd.target && (!target || target.kind !== 'scatter')) {
        return { ok: false, reason: 'invalid', detail: `no scatter layer '${String(cmd.target)}'` }
      }

      if (target && target.kind === 'scatter') {
        // Reconfigure (restyle) an existing scatter in place. The style is decided
        // ONCE, by the same rule create uses (explicit style > the first tunables
        // object in registry order > a preset's table > keep the current style), and
        // the palettePreset resolves against that final style's table only. Every
        // style's dials the model sent still merge onto that style's params — a model
        // may pre-set several — but only the showing style receives the preset's
        // colours. The box (w/h) is left alone.
        const d = target as unknown as Record<string, unknown>
        const resolved = resolveScatterStyle(a, scatterStyleOf(d.style))
        if (!resolved.ok) return { ok: false, reason: 'invalid', detail: resolved.detail }
        d.style = resolved.style
        for (const row of SCATTER_STYLES) {
          const next = scatterParamsAfter(a, row.id, resolved.style === row.id ? resolved.preset : null, d[row.id])
          if (next) d[row.id] = next
        }
        d.seed = reroll ? freshScatterSeed() : seedOf(a.seed, seedOf(d.seed, DEFAULT_SCATTER_SEED))
        return { ok: true, template: state, inverse: snapshot() }
      }

      // Create a new scatter filling the frame, in the default style.
      const id = typeof a.id === 'string' && a.id ? a.id : `l_${state.layers.length + 1}_scatter`
      if (state.layers.some(l => l.id === id)) return { ok: false, reason: 'invalid', detail: `layer id '${id}' already exists` }
      const resolved = resolveScatterStyle(a, DEFAULT_SCATTER_STYLE)
      if (!resolved.ok) return { ok: false, reason: 'invalid', detail: resolved.detail }
      // Boxes are width-normalized, so filling the frame is h = aspect (H/W) — the
      // same `h: aspect` the toolbar's Scatter stamp uses; a square frame is 1.
      const aspect = typeof state.aspect === 'number' && Number.isFinite(state.aspect) && state.aspect > 0 ? state.aspect : 1
      const styleParams: Record<string, unknown> = {}
      for (const row of SCATTER_STYLES) {
        styleParams[row.id] = scatterParamsAfter(a, row.id, resolved.style === row.id ? resolved.preset : null, undefined)
          ?? row.defaults()
      }
      const layer = {
        id, kind: 'scatter', x: 0.5, y: 0.5, rotation: 0, opacity: 1,
        w: 1, h: aspect,
        seed: reroll ? freshScatterSeed() : seedOf(a.seed, DEFAULT_SCATTER_SEED),
        style: resolved.style,
        ...styleParams,
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
      if (!type || !isEffectKind(type)) return { ok: false, reason: 'invalid', detail: `effect.type must be one of ${EFFECT_ORDER.join('|')}` }
      const stack = effectStackOf(layer)
      if (cmd.args?.remove === true) {
        Object.assign(layer, writeStackToLayer(stack.filter(e => e.type !== type)))
        return { ok: true, template: state, inverse: snapshot() }
      }
      const cur = stack.find(e => e.type === type)
      // Torn edge / feather validate through their own sanitizers (same clamps the
      // old setLayerTornEdge/setLayerFeather handlers used); the four layer-local
      // kinds (shadows + blurs) go through sanitizeLocalEffect; every other kind
      // goes through the shared post-effect sanitizer, same as before.
      const sanitized =
        type === 'torn_edge' ? sanitizeTornEdge(raw, cur as any)
        : type === 'feather' ? sanitizeFeather(raw, cur as any)
        : type === 'drop_shadow' || type === 'inner_shadow' || type === 'layer_blur' || type === 'background_blur'
          ? sanitizeLocalEffect(type, raw, cur)
        : type === 'trim' || type === 'offset' || type === 'round_corners' || type === 'roughen'
          ? sanitizeGeometryEffect(type, raw, cur)
        : sanitizePostEffect(raw, cur as PostEffect | undefined)
      if (!sanitized) return { ok: false, reason: 'invalid', detail: 'invalid effect' }
      const next: Record<string, unknown> = { ...sanitized, type, visible: true }
      const withEffect = cur
        ? stack.map(e => (e.id === cur.id ? ({ ...next, id: cur.id } as unknown as EffectInstance) : e))     // edit in place, order kept
        : addEffect(stack, type)
      const applied: EffectInstance[] = cur
        ? withEffect
        : withEffect.map(e => (e.type === type && !stack.some(s => s.id === e.id) ? ({ ...e, ...next } as unknown as EffectInstance) : e))
      Object.assign(layer, writeStackToLayer(applied))
      return { ok: true, template: state, inverse: snapshot() }
    }
    // Thin aliases: torn edge and feather are now just two more entries in the
    // stack, reachable through setLayerEffect — kept as named ops so an existing
    // agent recipe (and the command hints) keep working unchanged.
    case 'setLayerTornEdge': {
      const a = cmd.args ?? {}
      const patch = (a.patch ?? {}) as Record<string, unknown>
      return applyCompositorCommand(state, { ...cmd, op: 'setLayerEffect', args: { effect: { ...patch, type: 'torn_edge' }, remove: a.remove } })
    }
    case 'setLayerFeather': {
      const a = cmd.args ?? {}
      const patch = (a.patch ?? {}) as Record<string, unknown>
      return applyCompositorCommand(state, { ...cmd, op: 'setLayerEffect', args: { effect: { ...patch, type: 'feather' }, remove: a.remove } })
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
    case 'addStroke': return { label: `${name} outline`, before: '', after: 'added' }
    case 'removeStroke': return { label: `${name} outline`, before: String(a.strokeId ?? ''), after: 'removed' }
    case 'setStrokeProps': { const p = (a.patch ?? {}) as Record<string, unknown>; return { label: `${name} outline ${String(a.strokeId ?? '')}`, before: '', after: Object.keys(p).map(k => `${k}: ${typeof p[k] === 'object' ? JSON.stringify(p[k]) : String(p[k])}`).join(', ') } }
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
      const had = effectStackOf(layer).some(e => e.type === type)
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
