import type { ControlSpec, ParamValue } from '~/lib/spacetype/effect'
import { POST_SECTIONS } from '~/lib/studio/post/controls'
import { showIfVisible } from '~/lib/studio/sections'
import { getByPath } from '~/lib/studio/path'
import {
  DEFAULT_MATERIAL, MATERIAL_DEFAULTS, gradientAngles, screenOf,
  LIGHT_DEFAULTS, DECAL_DEFAULTS, lightIntensityMax, lightIntensityDefault,
  type MaterialType, type SceneDoc, type SceneObject,
} from './config'
import { PRIMITIVE_PARAMS, MODIFIER_SPECS, resolveParam, totalClones } from './primParams'
import { modifierStackOf } from './modifierStack'
import { DEFAULT_HDRI } from './hdri'
import {
  SCENE_CONTROLS, GEOMETRY_PARAM_PREFIX, MODIFIER_PREFIX,
  type SceneControl,
} from './controls'

/**
 * PRESENTATION layer between `SCENE_CONTROLS` and the 3D Studio inspector panel.
 *
 * The schema's `group` strings and declaration order are the AGENT/MOTION/Collection
 * contract (`sceneAgentControls` emits in `SCENE_SECTIONS` order, `animatableTargets`
 * derives an ordered path array from the same list). The shipped hand-written inspector
 * grouped and ordered its rows completely differently: one Material card whose contents
 * change per material type, five collapsible sub-blocks inside it, Transform ahead of
 * everything, and Camera/Lighting/Background at the end.
 *
 * So the surface hands the panel a remapped COPY rather than the schema itself. Keys are
 * never touched — only `group` (including the `Material/<sub>` nesting paths), row order,
 * `label`/`hint`/`options`/`min`/`max`/`step` where the shipped control said something
 * different, and `bindable` (see below).
 *
 * `tests/unit/scene3d-panel-parity.unit.spec.ts` asserts this module against the rows the
 * deleted template drew, per selection state × material type.
 *
 * ## Everything here is `bindable: false`, deliberately
 * The shipped inspector's Transform/Material/Camera/Lighting/Background controls were
 * `StudioSlider`/`StudioColor`/`StudioSegmented`/`StudioSwitch` — none of which emit a
 * `menu`/`promote` event, so NO migrated row ever offered Collection binding. A
 * `StudioRow` would offer it by default (the variable glyph renders whenever
 * `bindable !== false`), which would be a brand-new affordance wired to nothing. Marking
 * every emitted row `bindable: false` reproduces the shipped surface exactly and is the
 * same guard Gradient's `onControlMenu` applies. The post rows are NOT touched: they were
 * already drawn by a `StudioControlPanel` and keep whatever they had.
 *
 * ## Degrees, world size — the units the panel shows are not the units stored
 * `object.rotation.*` is radians on disk and was always EDITED in degrees; `object.scale.*`
 * is a multiplier on disk and was always edited as world Size (`scale × baseSize`). Both
 * conversions lived in the surface's row proxies; they live here now (`readSceneControl` +
 * the `Size`/`Rotation` overrides) so the panel, the parity spec and the write path all
 * read one description of them.
 *
 * ## Transform's SOFT range
 * The nine Position/Rotation/Size rows were migrated once (c9023b9a2) and reverted
 * (e954626f9): a `StudioRow` clamped typed and keyed entry to the declared range, which
 * the `<input type="number">` grid never did. The gizmo puts an object at x = 35 on a
 * ±20 row, and one arrow press rewrote it to 20 AND fanned the −15 delta across the whole
 * selection (`axisDeltaWrites`). They are back because the schema now says
 * `entry: 'unclamped'` on all nine (`lib/studio/row.ts`'s `parseTyped`): the bounds still
 * draw the fill, place the handle and size the drag; they no longer decide what a typed
 * or arrowed number may be. `sizeOverride` rescales them into world units and the flag
 * survives that, because a rescaled description is still a description.
 */

// ── section order + chrome ───────────────────────────────────────────────────

/** The Transform card renders on its own, ABOVE the Geometry panel, so it cannot share
 *  a panel with the rest. */
export const SCENE_TRANSFORM_SECTIONS = ['Transform'] as readonly string[]

/**
 * The Geometry card, in its own panel too — and for a sharper reason than Transform's.
 * `Scene3DSculptPanel` REPLACES exactly this card (and nothing else in the inspector column)
 * for the duration of a stroke session, because `geometryForObject` short-circuits to the
 * session's raw buffer. A sibling can be swapped out; a card in the middle of one
 * StudioControlPanel cannot.
 *
 * The Modifiers and Cloner sub-cards are GONE (S1 Task 6): a modifier's dials moved onto the
 * per-row inspector, read/written on the stack instance rather than the legacy bag. The Geometry
 * card keeps the primitive's own parameters plus the Cloner's cost readout (`ui.cloner.cost`,
 * routed here, its count sourced from the stack).
 */
export const SCENE_GEOMETRY_SECTIONS = ['Geometry'] as readonly string[]

/** Light, Decal, Material (+ its five shipped sub-blocks, as nesting paths) and the
 *  doc-level cards, in the order the shipped inspector drew them. Light and Decal are
 *  mutually exclusive with Material — a light or a decal is never a primitive or a GLB —
 *  so no state ever shows two of the three, whatever the order says. */
export const SCENE_PANEL_ORDER = [
  'Light',
  'Decal',
  'Material',
  'Material/Image placement',
  'Material/Image look',
  'Material/Coat & sheen',
  'Material/Glow',
  'Material/Transparency',
  'Material/Iridescence',
  'Material/Reflection',
  'Material/Surface relief',
  'Material/Screen',
  'Camera',
  'Lighting',
  'Lighting/Gel lighting',
  'Lighting/Fine-tune',
  'Background',
] as readonly string[]

/** …plus the shared post stack's own nested cards, which already rendered through a panel. */
export const SCENE_PANEL_SECTIONS = [...SCENE_PANEL_ORDER, ...POST_SECTIONS] as readonly string[]

/**
 * Per-card chrome, keyed by the ON-SCREEN title (the last path segment, which is what
 * StudioSectionTree looks up). The four sub-blocks the template drew as bare `<details>`
 * with no `open` attribute start collapsed; Transparency reproduces the shipped
 * `transparencyOpen` ref, which seeded itself open for glass and re-seeded on every
 * material-type change.
 *
 * The Modifiers and Cloner sub-cards were removed with S1 Task 6 (their dials moved onto the
 * per-modifier inspector), so their collapsed-by-default chrome went with them.
 */
export function scenePanelChrome(matType: MaterialType | null): Record<string, { badge?: string; open?: boolean }> {
  return {
    'Image placement': { open: false },
    'Image look': { open: false },
    'Coat & sheen': { open: false },
    Glow: { open: false },
    Transparency: { open: matType === 'glass' },
    Iridescence: { open: false },
    Reflection: { open: false },
    Screen: { open: false },
    // Lighting sub-cards — collapsed by default so the card reads as a short primary list.
    'Fine-tune': { open: false },
    'Gel lighting': { open: false },
  }
}

const POST_GROUPS = new Set<string>(POST_SECTIONS)
const isScenePostGroup = (group: string | undefined): boolean => POST_GROUPS.has(String(group ?? ''))

// ── reading a control's value off the document ───────────────────────────────

const RELIEF_DEFAULTS: Record<string, ParamValue> = {
  source: 'none',
  scale: MATERIAL_DEFAULTS.reliefScale,
  contrast: MATERIAL_DEFAULTS.reliefContrast,
  tiling: MATERIAL_DEFAULTS.reliefTiling,
  invert: false,
}

const SCREEN_DEFAULTS = screenOf({}) as unknown as Record<string, ParamValue>

const RAD2DEG = 180 / Math.PI

/**
 * Whether a Transform commit carries exactly what its row is already SHOWING — in which
 * case it is not an edit and must not touch the document.
 *
 * `RowSlider` seeds its typed-entry draft from the displayed value and commits on blur
 * unconditionally, so clicking a readout and clicking away sends that value back through
 * `@set`. Rounding the read (below) makes the row self-consistent but cannot make this
 * write a no-op on its own: `axisDeltaWrites` takes its delta from the object's RAW stored
 * value, so a row reading 2.4 over a stored 2.38472 still moves the primary and still fans
 * the 0.01528 across the selection. Comparing against the row's OWN reading is what closes
 * that, and it keeps the stored precision: 2.38472 stays 2.38472.
 *
 * Lives here rather than inline in the surface so it is testable without mounting the
 * component — the same reason `writeMaterialField` was pulled out. `writeTransform` is its
 * only caller.
 */
export function isNoOpTransformCommit(
  doc: SceneDoc,
  obj: SceneObject | null | undefined,
  prop: 'position' | 'rotation' | 'scale',
  axis: 0 | 1 | 2,
  value: number,
  ctx: SceneReadCtx = {},
): boolean {
  return value === readSceneControl(doc, obj, `object.${prop}.${axis}`, ctx)
}

/** Round to `1 / perUnit`, normalising negative zero away. `Math.round(-0.049 * 10) / 10`
 *  is `-0`, which is `=== 0` but not `Object.is` 0 — enough for the row's readout to
 *  render "-0.0" where the document holds a plain small negative, and enough to make a
 *  round-trip assertion fail on a value that is arithmetically identical. */
const roundTo = (v: number, perUnit: number): number => {
  const r = Math.round(v * perUnit) / perUnit
  return r === 0 ? 0 : r
}

/** World size ÷ scale for one axis, i.e. the primitive's un-scaled extent. The surface
 *  measures it off the built geometry; every other caller (the parity spec, a headless
 *  read) has no geometry and uses 1, which makes Size read as the raw scale. */
export type SceneReadCtx = { baseSize?: readonly number[] }

const materialField = (mat: SceneObject['material'], field: string): ParamValue => {
  if (field === 'gradientYaw' || field === 'gradientPitch') {
    return gradientAngles(mat)[field === 'gradientYaw' ? 'yaw' : 'pitch']
  }
  if (field.startsWith('relief.')) {
    const sub = field.slice('relief.'.length)
    const v = (mat.relief as Record<string, unknown> | undefined)?.[sub]
    return (v ?? RELIEF_DEFAULTS[sub] ?? 0) as ParamValue
  }
  if (field.startsWith('screen.')) {
    const sub = field.slice('screen.'.length)
    const v = (mat.screen as Record<string, unknown> | undefined)?.[sub]
    return (v ?? SCREEN_DEFAULTS[sub] ?? 0) as ParamValue
  }
  const v = (mat as unknown as Record<string, unknown>)[field]
  if (v !== undefined && v !== null) return v as ParamValue
  const d = (MATERIAL_DEFAULTS as unknown as Record<string, unknown>)[field]
    ?? (DEFAULT_MATERIAL as unknown as Record<string, unknown>)[field]
  return (d ?? 0) as ParamValue
}

/**
 * The generic single-field write `setMaterialControl`'s fallback applies to every selected
 * object (Scene3DStudioSurface.vue's `applyMaterial((m) => writeMaterialField(m, field,
 * value))`), pulled out here so a test can exercise the SAME assignment `setControl`'s
 * `object.material.*` branch performs — the plain field a `materialField` read of the same
 * key sees straight back — without mounting the surface component.
 */
export function writeMaterialField(mat: SceneObject['material'], field: string, value: ParamValue): void {
  (mat as unknown as Record<string, unknown>)[field] = value
}

/**
 * One canonical reader for every migrated key — the panel's `value` prop, the `showIf`
 * evaluation inside `scenePanelVisible`, and the parity spec all go through it.
 *
 * `post.*` is NOT handled here: `doc.post` is a plain PostSettings object the surface
 * already reads with `readPost`, and folding it in would duplicate that.
 *
 * The final `getByPath(doc, key)` fallback mirrors `setControl`'s generic
 * `setByPath(doc, key, value)` default case (Scene3DStudioSurface.vue) — every doc-level
 * key that isn't one of the special cases above (a novel Camera or Background control,
 * for instance) reads back exactly where the generic writer put it, keeping read and
 * write symmetric for keys neither side special-cases. `object.*` keys are excluded from
 * this fallback: they need an active `obj` and have no meaning read off `doc` directly.
 */
export function readSceneControl(
  doc: SceneDoc, obj: SceneObject | null | undefined, key: string, ctx: SceneReadCtx = {},
): ParamValue {
  if (key === 'showFloor') return doc.showFloor
  if (key === 'camera.fov') return doc.camera.fov
  if (key === 'lighting.environment') return ENV_LABEL[doc.lighting.environment] ?? 'room'
  // Synthetic: the light-source mode is derived from whether an HDRI is chosen.
  if (key === 'lighting.lightSource') return doc.lighting.hdri ? 'HDRI' : 'Studio look'
  // The `hdri` row binds the raw Poly Haven slug (RowHdri renders its name/thumbnail).
  if (key === 'lighting.hdri') return doc.lighting.hdri ?? DEFAULT_HDRI
  if (key.startsWith('lighting.')) {
    return (doc.lighting as unknown as Record<string, ParamValue>)[key.slice('lighting.'.length)] ?? 0
  }
  if (key.startsWith('object.')) {
    if (!obj) return 0
    if (key.startsWith('object.material.')) return materialField(obj.material, key.slice('object.material.'.length))
    if (key.startsWith(GEOMETRY_PARAM_PREFIX)) return geometryParamField(obj, key.slice(GEOMETRY_PARAM_PREFIX.length))
    if (key.startsWith(MODIFIER_PREFIX)) return modifierField(obj, key.slice(MODIFIER_PREFIX.length))
    // A decal's spin is radians on disk and degrees in the panel — the same split
    // `object.rotation.*` has, and the same rounding the deleted `decalSpinDeg` proxy did.
    if (key === 'object.spin') return Math.round(((obj as { spin?: number }).spin ?? 0) * RAD2DEG)
    // The two conversions the deleted row proxies did, in the read direction. `writeAxis`
    // in the surface is their exact inverse.
    //
    // ROUNDED TO THE ROW'S OWN PRECISION, all three of them, and it is not cosmetic.
    // `RowSlider` seeds its typed-entry draft from `formatValue(value, step)` and commits
    // on blur unconditionally — so whatever the row DISPLAYS is what a click-and-click-away
    // sends back. Returning a raw 2.38472 on a step-0.1 row meant the row showed 2.4 and
    // then wrote 2.4: a gesture that changed nothing moved the object. Rounding here makes
    // the read a fixed point of format∘parse, so the value coming back is the value that
    // went out (the parity spec asserts exactly that round-trip). `object.spin` above and
    // `object.scale.*` below already did this; position and rotation were the two that did
    // not. Nothing downstream of the panel reads this — the engine, the gizmo and
    // `axisDeltaWrites` all read the document's own exact numbers.
    const axis = Number(key.slice(-1)) as 0 | 1 | 2
    if (key.startsWith('object.position.')) return roundTo(obj.position[axis] ?? 0, 10)
    if (key.startsWith('object.rotation.')) return roundTo((obj.rotation[axis] ?? 0) * RAD2DEG, 1)
    if (key.startsWith('object.scale.')) {
      const base = ctx.baseSize?.[axis] || 1
      return Math.round((obj.scale[axis] ?? 1) * base * 100) / 100
    }
    // Everything else `object.`-prefixed is a plain leaf ON the object — a light's
    // colour/intensity/…, a decal's size/wrap/opacity, a text decal's `content.color`.
    // The defaults mirror the deleted `lightParam`/`decalParam` proxies: an untouched
    // optional field reads its shipped default, never `undefined` (which would leave a
    // slider with no number at all).
    return objectLeaf(obj, key.slice('object.'.length))
  }
  return (getByPath(doc, key) as ParamValue | undefined) ?? 0
}

/** One geometry parameter, resolved the way the engine resolves it: the stored value
 *  clamped to the SELECTED KIND's spec, else that spec's default. A toggle spec stores
 *  0 | 1 in the same flat number bag but draws as a switch, so it reads back boolean —
 *  `setControl`'s writer is the exact inverse. */
function geometryParamField(obj: SceneObject, sub: string): ParamValue {
  if (obj.kind !== 'primitive') return 0
  const specs = PRIMITIVE_PARAMS[obj.primitive]
  const spec = specs.find((s) => s.key === sub)
  if (!spec) return 0
  const v = resolveParam(specs, obj.params, sub)
  if (spec.control === 'options') return spec.options?.[Math.round(v)] ?? spec.options?.[0] ?? ''
  return spec.control === 'toggle' ? v > 0.5 : v
}

/** One modifier value. Guarded by its own spec lookup rather than calling
 *  `modifierValue` straight: that throws on an undeclared key, and a reader the panel
 *  calls for whatever key it is handed must not. */
function modifierField(obj: SceneObject, sub: string): ParamValue {
  if (obj.kind !== 'primitive') return 0
  const spec = MODIFIER_SPECS.find((s) => s.key === sub)
  if (!spec) return 0
  return resolveParam(MODIFIER_SPECS, obj.modifiers, sub)
}

const LEAF_DEFAULTS: Record<SceneObject['kind'], Record<string, ParamValue>> = {
  light: { ...LIGHT_DEFAULTS },
  decal: { size: DECAL_DEFAULTS.size, depth: DECAL_DEFAULTS.depth, spin: DECAL_DEFAULTS.spin,
    opacity: DECAL_DEFAULTS.opacity, blend: DECAL_DEFAULTS.blend, 'content.color': DECAL_DEFAULTS.color },
  primitive: {}, glb: {}, group: {},
}

function objectLeaf(obj: SceneObject, rest: string): ParamValue {
  const v = getByPath(obj, rest)
  if (v !== undefined && v !== null) return v as ParamValue
  return LEAF_DEFAULTS[obj.kind][rest] ?? 0
}

// ── the environment segmented's display labels ───────────────────────────────

/** The shipped Environment control was a `StudioSegmented` over four SHORT labels, not
 *  over `ENVIRONMENT_KINDS` — 'darkStrips' read as 'dark', 'colorGels' as 'gels'. Kept
 *  here (rather than left in the surface) so the row's `options`, the reader and the
 *  writer cannot drift apart. */
export const ENV_OPTIONS = ['room', 'dark', 'softbox', 'studio', 'gels'] as const
export const ENV_BY_LABEL: Record<string, SceneDoc['lighting']['environment']> = {
  room: 'room', dark: 'darkStrips', softbox: 'softbox', studio: 'studio', gels: 'colorGels',
}
const ENV_LABEL: Record<string, string> = {
  room: 'room', darkStrips: 'dark', softbox: 'softbox', studio: 'studio', colorGels: 'gels',
}

// ── bespoke-block anchors ────────────────────────────────────────────────────

/**
 * A block the schema never described — a picker grid, a ramp editor, an upload row, a
 * caption. It carries no value and no binding; it exists so the surface can supply a
 * `#control-<key>` slot that lands at the exact position the shipped card had it.
 * `#section-<Title>` cannot serve: it renders at the END of a card's body.
 */
interface ScenePanelAnchor {
  key: string
  label: string
  visible: (doc: SceneDoc, obj: SceneObject | null | undefined) => boolean
}

const typeOf = (obj: SceneObject | null | undefined): MaterialType | null =>
  obj && obj.kind !== 'light' ? obj.material.type : null

/** Whether the selection actually renders `.material`: a primitive always does, a GLB only
 *  once its override switch is on, and nothing else ever does. Unlike the schema's
 *  `isEditableMaterial` this is FALSE with no selection — the panel has no card to draw. */
const editable = (obj: SceneObject | null | undefined): boolean =>
  !!obj && (obj.kind === 'primitive' || (obj.kind === 'glb' && obj.materialOverride === true))

/** Whether relief has any lighting to perturb: an unlit shaderFill or image is a
 *  MeshBasicMaterial with no bump slot at all, so the card shows a notice instead of the
 *  dials. */
const reliefOn = (obj: SceneObject | null | undefined): boolean => {
  const t = typeOf(obj)
  return editable(obj) && !((t === 'shaderFill' || t === 'image') && obj!.material.unlit === true)
}

const isType = (obj: SceneObject | null | undefined, ...types: MaterialType[]): boolean =>
  editable(obj) && types.includes(typeOf(obj)!)

// ── Geometry / Light / Decal helpers ─────────────────────────────────────────
// `kind` narrows to a primitive; the optional second argument narrows further to one
// PrimitiveKind (the two per-kind editors below).
const isPrim = (obj: SceneObject | null | undefined, primitive?: string): boolean =>
  !!obj && obj.kind === 'primitive' && (primitive === undefined || obj.primitive === primitive)

const isDecalContent = (obj: SceneObject | null | undefined, type: 'text' | 'image'): boolean =>
  !!obj && obj.kind === 'decal' && obj.content.type === type

/** The clone count from the object's modifier STACK (the enabled cloner row), not the legacy
 *  bag — the bag's count is stale once the stack is edited. Used only to gate the cost readout. */
const stackCloneCount = (obj: SceneObject | null | undefined): number => {
  if (!isPrim(obj)) return 0
  // `isPrim` is a runtime guard, not a type predicate; the object is a primitive here, which carries
  // the `modifiers` / `modifierStack` fields modifierStackOf reads.
  const cloner = modifierStackOf(obj as { modifiers?: Record<string, number>; modifierStack?: unknown })
    .find((m) => m.kind === 'cloner' && m.enabled !== false)
  return cloner ? totalClones(cloner as unknown as Record<string, number>) : 0
}

const SCENE_PANEL_ANCHORS: readonly ScenePanelAnchor[] = [
  // Material card
  { key: 'ui.material.override', label: 'Override materials', visible: (_d, o) => o?.kind === 'glb' },
  { key: 'ui.material.surface', label: 'Surface', visible: (_d, o) => isType(o, 'standard', 'glass') },
  { key: 'ui.material.textureSet', label: 'Surface texture', visible: (_d, o) => isType(o, 'standard', 'glass', 'opalescent') },
  { key: 'ui.material.matcap', label: 'Matcap', visible: (_d, o) => isType(o, 'matcap') },
  {
    key: 'ui.material.harmony', label: 'Harmony',
    visible: (_d, o) => isType(o, 'gradient') && materialField(o!.material, 'paletteMode') === 'harmony',
  },
  {
    key: 'ui.material.gradientStops', label: 'Colours',
    visible: (_d, o) => isType(o, 'gradient') && materialField(o!.material, 'paletteMode') !== 'harmony',
  },
  {
    key: 'ui.material.gradientDirection', label: 'Direction',
    visible: (_d, o) => isType(o, 'gradient') && materialField(o!.material, 'gradientType') === 'linear',
  },
  // Shared by opalescent and holographic — both read the same spectrum (opalStopsOf), and
  // the surface's `matOpalStops` binding is type-agnostic.
  { key: 'ui.material.opalStops', label: 'Spectrum', visible: (_d, o) => isType(o, 'opalescent', 'holographic') },
  { key: 'ui.material.image', label: 'Texture', visible: (_d, o) => isType(o, 'image') },
  { key: 'ui.material.shader', label: 'Effect', visible: (_d, o) => isType(o, 'shaderFill') },
  // Transparency sub-card
  { key: 'ui.material.prism', label: 'Prism look', visible: (_d, o) => isType(o, 'standard', 'glass') },
  // Surface relief sub-card
  { key: 'ui.relief.unavailable', label: 'Relief unavailable', visible: (_d, o) => editable(o) && !reliefOn(o) },
  {
    key: 'ui.relief.normalMapBound', label: 'Normal map bound',
    visible: (_d, o) => reliefOn(o) && !!o!.material.normalImage,
  },
  {
    key: 'ui.relief.image', label: 'Relief image',
    visible: (_d, o) => reliefOn(o) && materialField(o!.material, 'relief.source') === 'image',
  },
  {
    key: 'ui.relief.shader', label: 'Relief effect',
    visible: (_d, o) => reliefOn(o) && materialField(o!.material, 'relief.source') === 'shader',
  },
  // Geometry card — the two bespoke per-kind editors. Text's string + font picker (+ its
  // weight selects) and mesh's vertex readout / Remesh / Solidify block are editors, not
  // parameters: `content` is a string and a font token, and Resolution/Thickness are
  // transient inputs to an ACTION, not fields on the document at all.
  { key: 'ui.geometry.text', label: 'Text', visible: (_d, o) => isPrim(o, 'text') },
  { key: 'ui.geometry.mesh', label: 'Mesh', visible: (_d, o) => isPrim(o, 'mesh') },
  // Cloner cost — the ONLY modifier/cloner row still on the always-on Geometry card (S1 Task 6:
  // every dial moved to the per-modifier inspector). The live copies/vertices readout, shown only
  // once there is more than one copy — and its count reads the STACK's cloner, not the stale bag.
  { key: 'ui.cloner.cost', label: 'Clone cost', visible: (_d, o) => stackCloneCount(o) > 1 },
  // Decal card — a text sticker's label + font picker, an image sticker's thumbnail +
  // Replace button, and Reposition (a decal has no gizmo; re-placing it re-arms the
  // click-to-place flow).
  { key: 'ui.decal.text', label: 'Label', visible: (_d, o) => isDecalContent(o, 'text') },
  { key: 'ui.decal.image', label: 'Sticker', visible: (_d, o) => isDecalContent(o, 'image') },
  { key: 'ui.decal.reposition', label: 'Reposition', visible: (_d, o) => o?.kind === 'decal' },
  // Camera / Background
  { key: 'ui.camera.output', label: 'Output', visible: () => true },
  { key: 'ui.background.transparent', label: 'Transparent', visible: () => true },
  { key: 'ui.background.color', label: 'Color', visible: (d) => d.background !== 'transparent' },
]

export const SCENE_PANEL_ANCHOR_KEYS: ReadonlySet<string> = new Set(SCENE_PANEL_ANCHORS.map((a) => a.key))

// ── card membership + row order ──────────────────────────────────────────────

/** Rows the shipped Material card drew in its own body, per material type, in order.
 *  Everything above the per-type body is shared; everything below it lives in one of
 *  the sub-cards. Opalescent (and holographic after it) is the type that MOVES rows: clearcoat /
 *  coat roughness / reflection intensity sat in the main body for it, not in the
 *  Coat/Reflection blocks. */
const MATERIAL_HEAD = ['ui.material.override', 'object.material.type']

const MATERIAL_BODY: Record<MaterialType, readonly string[]> = {
  standard: [
    'ui.material.surface', 'object.material.color', 'object.material.roughness', 'object.material.metalness',
    'ui.material.textureSet', 'object.material.textureTiling',
  ],
  glass: [
    'ui.material.surface', 'object.material.color', 'object.material.roughness', 'object.material.metalness',
    'ui.material.textureSet', 'object.material.textureTiling',
  ],
  // Gemstone is preset-driven: the stone picker is the whole body.
  gemstone: ['object.material.stone'],
  phong: ['object.material.color', 'object.material.shininess', 'object.material.specular'],
  toon: ['object.material.color', 'object.material.toonSteps'],
  matcap: ['ui.material.matcap'],
  fresnel: ['object.material.color', 'object.material.fresnelColor', 'object.material.fresnelPower'],
  gradient: [
    'object.material.paletteMode',
    'object.material.paletteHue', 'object.material.paletteSat', 'object.material.paletteLight',
    'ui.material.harmony', 'ui.material.gradientStops',
    'object.material.gradientType',
    'ui.material.gradientDirection', 'object.material.gradientYaw', 'object.material.gradientPitch',
    'object.material.gradientOffset', 'object.material.gradientSpread', 'object.material.gradientShading',
  ],
  opalescent: [
    'ui.material.opalStops', 'object.material.color',
    'object.material.opalHueShift', 'object.material.opalFrequency', 'object.material.opalAngleMix',
    'object.material.opalStrength', 'object.material.opalFlowSpeed',
    'object.material.roughness', 'object.material.metalness',
    'object.material.clearcoat', 'object.material.clearcoatRoughness', 'object.material.envMapIntensity',
    'ui.material.textureSet', 'object.material.textureTiling',
  ],
  // No roughness / metalness / texture set: a foil is metal (metalness pinned at 1) and its
  // roughness is the Gloss dial, so the shared PBR rows would be dead controls.
  holographic: [
    'ui.material.opalStops', 'object.material.color',
    'object.material.holoStrength', 'object.material.holoBands', 'object.material.holoAngle',
    'object.material.holoFlakes', 'object.material.holoFlakeSize', 'object.material.holoGloss',
    'object.material.holoHueShift',
    'object.material.clearcoat', 'object.material.clearcoatRoughness', 'object.material.envMapIntensity',
  ],
  image: [
    'ui.material.image', 'object.material.unlit',
    'object.material.imageProjection', 'object.material.imageProjectionAxis', 'object.material.imageBoxBlend',
    'object.material.imageFit', 'object.material.imageWrap',
    'object.material.imageTiling', 'object.material.imageTilingLinked', 'object.material.imageTilingY',
    'object.material.roughness', 'object.material.metalness',
    // Note: image offset, rotation, and flip controls are in Material/Image placement sub-card
  ],
  shaderFill: [
    'ui.material.shader', 'object.material.unlit',
    'object.material.roughness', 'object.material.metalness',
  ],
}

const SUB_CARDS: Record<string, readonly string[]> = {
  // Lighting sub-groups: the raw fine-tune trio (collapsed — replaces the old Advanced toggle) and
  // the whole gel rig (kept next to, and clearly owned by, the Gels environment picker).
  'Lighting/Fine-tune': ['lighting.preset', 'lighting.sunIntensity', 'lighting.ambient'],
  'Lighting/Gel lighting': [
    'lighting.gelColorA', 'lighting.gelBrightnessA', 'lighting.gelSizeA', 'lighting.gelAzimuthA',
    'lighting.gelHeightA', 'lighting.gelDistanceA',
    'lighting.gelColorB', 'lighting.gelBrightnessB', 'lighting.gelSizeB', 'lighting.gelAzimuthB',
    'lighting.gelHeightB', 'lighting.gelDistanceB',
    'lighting.gelRim', 'lighting.gelRimColor', 'lighting.gelRimBrightness',
    'lighting.gelSoftness', 'lighting.gelBackground', 'lighting.gelExposure',
  ],
  'Material/Image placement': [
    'object.material.imageOffsetX', 'object.material.imageOffsetY', 'object.material.imageRotation',
    'object.material.imageFlipX', 'object.material.imageFlipY', 'object.material.imageSeamless',
  ],
  'Material/Image look': [
    'object.material.imageTint',
    'object.material.imageBrightness', 'object.material.imageContrast', 'object.material.imageSaturation',
    'object.material.imageGlow',
  ],
  'Material/Coat & sheen': [
    'object.material.clearcoat', 'object.material.clearcoatRoughness',
    'object.material.sheen', 'object.material.sheenColor',
  ],
  'Material/Glow': ['object.material.emissive', 'object.material.emissiveIntensity'],
  'Material/Transparency': [
    'object.material.imageAlpha', 'object.material.imageCutout',
    'ui.material.prism', 'object.material.opacity', 'object.material.transmission',
    'object.material.ior', 'object.material.thickness', 'object.material.dispersion',
    'object.material.attenuationColor', 'object.material.attenuationDistance',
  ],
  'Material/Iridescence': ['object.material.iridescence', 'object.material.iridescenceIOR'],
  'Material/Reflection': ['object.material.envMapIntensity'],
  'Material/Surface relief': [
    'ui.relief.unavailable', 'object.material.relief.source', 'ui.relief.normalMapBound',
    'object.material.relief.scale', 'object.material.relief.contrast', 'object.material.relief.tiling',
    'object.material.relief.invert', 'ui.relief.image', 'ui.relief.shader',
  ],
  'Material/Screen': [
    'object.material.screen.pattern', 'object.material.screen.density', 'object.material.screen.angle',
    'object.material.screen.contrast', 'object.material.screen.softness', 'object.material.screen.misregister',
    'object.material.screen.invert', 'object.material.screen.gap', 'object.material.screen.gapColor',
    'object.material.screen.ink', 'object.material.screen.inkColor',
  ],
}

/** The Light and Decal cards, in the order the shipped `<template v-if>` chains drew
 *  them. Both are flat lists — nothing here depends on the object beyond the `when`
 *  gates the schema already carries. */
const KIND_CARDS: Record<string, readonly string[]> = {
  Light: [
    'object.color', 'object.intensity', 'object.distance', 'object.decay', 'object.castShadow',
    'object.angle', 'object.penumbra', 'object.width', 'object.height',
  ],
  Decal: [
    'ui.decal.text', 'object.content.color', 'ui.decal.image',
    'object.size', 'object.spin', 'object.depth', 'object.opacity', 'object.blend',
    'ui.decal.reposition',
  ],
}

/** The Geometry card. Unlike every other card it depends on the SELECTION — which primitive kind
 *  is selected decides the parameter rows outright — so it is computed, not tabulated. The Cloner
 *  cost readout is the one modifier row still here (its count sourced from the stack); every dial
 *  moved to the per-modifier inspector (S1 Task 6). */
function geometryCardOrder(obj: SceneObject | null | undefined): readonly string[] {
  const params = isPrim(obj)
    ? PRIMITIVE_PARAMS[(obj as { primitive: keyof typeof PRIMITIVE_PARAMS }).primitive]
    : []
  return ['ui.geometry.text', 'ui.geometry.mesh', ...params.map((s) => `${GEOMETRY_PARAM_PREFIX}${s.key}`), 'ui.cloner.cost']
}

const DOC_CARDS: Record<string, readonly string[]> = {
  Transform: [
    'object.position.0', 'object.position.1', 'object.position.2',
    'object.rotation.0', 'object.rotation.1', 'object.rotation.2',
    'object.scale.0', 'object.scale.1', 'object.scale.2',
  ],
  Camera: ['camera.fov', 'ui.camera.output'],
  // Simple-lighting hierarchy: the Look drives everything so it leads; then where the
  // light comes from; then the three feel dials; then the Advanced toggle, followed by
  // the raw rows it reveals (they carry a `when` gate, so they only draw when it's on).
  Lighting: [
    'lighting.lightSource',
    // Studio-look mode primary (raw preset/sun/ambient live in the Fine-tune sub-card, gels in the
    // Gel lighting sub-card — see SUB_CARDS).
    'lighting.look',
    'lighting.softness', 'lighting.warmth', 'lighting.brightness',
    'lighting.sunAzimuth', 'lighting.sunElevation',
    'lighting.environment',
    // HDRI mode
    'lighting.hdri', 'lighting.hdriExposure', 'lighting.hdriRotation',
  ],
  Background: ['showFloor', 'ui.background.transparent', 'ui.background.color'],
}

/**
 * Which card a key lands in, given the active material type.
 *
 * The allow-lists above (`MATERIAL_HEAD`/`MATERIAL_BODY`/`SUB_CARDS`/`DOC_CARDS`) are
 * ORDER hints, not a gate: a key that isn't in any of them still draws, in the parent
 * card for its schema `group`, appended after the curated rows (`cardOrder`'s sort
 * falls unmapped keys through to `Number.MAX_SAFE_INTEGER`, and `Array.prototype.sort`
 * is stable, so they land in schema-declaration order at the end). This is what makes
 * the panel PERMISSIVE: a new `SCENE_CONTROLS` entry in an already-migrated group draws
 * without anyone touching this file.
 *
 * `group` is only passed for real schema controls (`scenePanelControls`'s main loop);
 * the bespoke-block anchors call this with no third argument; they carry no real schema
 * `group` and must keep resolving through the allow-lists alone.
 *
 * Every group is migrated now, so this returns null only for a key nothing claims —
 * an anchor whose card is not on screen, or a control in a group that does not exist.
 * (Transform was the last hold-out until Task 2's soft-range row; Geometry/Light/Decal
 * until Task 4.)
 *
 * Geometry is the one group that fans out to THREE cards, so its keys are routed by
 * prefix rather than by an allow-list: a parameter belongs to Geometry, a `clone*`
 * modifier to Cloner, any other modifier to Modifiers.
 */
function panelCardOf(key: string, matType: MaterialType | null, group?: string): string | null {
  if (key.startsWith(GEOMETRY_PARAM_PREFIX) || key.startsWith('ui.geometry.')) return 'Geometry'
  // The Cloner cost readout is the one modifier/cloner row kept on the always-on Geometry card
  // (S1 Task 6). Every other ui.mod.* / ui.cloner.* anchor and every object.modifiers.* dial moved
  // onto the per-modifier inspector, read/written on the stack instance, so they no longer render
  // here — dropped (null) rather than routed to a card the panel no longer draws.
  if (key === 'ui.cloner.cost') return 'Geometry'
  if (key.startsWith('ui.mod.') || key.startsWith('ui.cloner.') || key.startsWith(MODIFIER_PREFIX)) return null
  for (const [card, keys] of Object.entries(KIND_CARDS)) if (keys.includes(key)) return card
  for (const [card, keys] of Object.entries(DOC_CARDS)) if (keys.includes(key)) return card
  if (MATERIAL_HEAD.includes(key)) return 'Material'
  if (matType && MATERIAL_BODY[matType].includes(key)) return 'Material'
  for (const [card, keys] of Object.entries(SUB_CARDS)) if (keys.includes(key)) return card
  if (group === 'Material') return 'Material'
  if (group === 'Geometry') return 'Geometry'
  if (group === 'Camera' || group === 'Lighting' || group === 'Background' || group === 'Transform') return group
  if (group === 'Light' || group === 'Decal') return group
  return null
}

function cardOrder(
  card: string, matType: MaterialType | null, obj: SceneObject | null | undefined,
): readonly string[] {
  if (card === 'Material') return [...MATERIAL_HEAD, ...(matType ? MATERIAL_BODY[matType] : [])]
  if (card === 'Geometry') return geometryCardOrder(obj)
  return SUB_CARDS[card] ?? KIND_CARDS[card] ?? DOC_CARDS[card] ?? []
}

// ── the shipped label / hint / range overrides ───────────────────────────────

/**
 * Where the shipped control's caption, tooltip, options or bounds differed from the
 * schema's. The schema describes the PARAMETER (an agent reads `Emissive intensity`);
 * the inspector drew it inside a "Glow" block where `Intensity` was unambiguous.
 *
 * Removals matter as much as replacements: `object.rotation.*` carries the hint
 * 'Radians', which is a lie about a row that has always been edited in degrees, and
 * `showFloor` / `relief.source` were plain rows with no tooltip at all.
 */
type RowPatch = {
  label?: string
  /** `null` REMOVES the schema's hint — the shipped row had no tooltip. */
  hint?: string | null
  min?: number
  max?: number
  step?: number
  options?: string[]
  /** Positionally paired with `options` — supply both or neither. Supplying `options`
   *  alone DROPS whatever labels the schema declared (see `withPresentation`). */
  optionLabels?: string[]
  default?: string | number | boolean
}

const OVERRIDE: Record<string, RowPatch> = {
  'object.material.type': { label: 'Material' },
  'object.material.emissiveIntensity': { label: 'Intensity' },
  'object.material.iridescence': { label: 'Amount' },
  'object.material.iridescenceIOR': { label: 'IOR' },
  'object.material.envMapIntensity': { label: 'Intensity' },
  'object.material.relief.source': { label: 'Relief', hint: null },
  'object.material.relief.scale': { label: 'Depth' },
  'object.material.relief.contrast': {
    label: 'Contrast', hint: 'Deepens the light and dark areas so the relief catches the light.',
  },
  'object.material.relief.tiling': {
    label: 'Tiling', hint: 'How many times the pattern repeats across the surface — higher is finer.',
  },
  'object.material.screen.pattern': { label: 'Pattern', hint: null },
  'object.material.screen.density': { label: 'Density' },
  'object.material.screen.angle': { label: 'Angle' },
  'object.material.screen.contrast': { label: 'Contrast' },
  'object.material.screen.softness': { label: 'Softness' },
  'object.material.screen.invert': { label: 'Invert', hint: null },
  'object.material.screen.gap': { label: 'Gaps', hint: null },
  'object.material.screen.ink': { label: 'Ink', hint: null },
  'camera.fov': { label: 'FOV' },
  // 'Shadow preset', not 'Preset': it sits beside the Look select and a bare 'Preset'
  // read as a second, competing mood picker. It only tunes the shadow/env-intensity bucket.
  'lighting.preset': { label: 'Shadow preset' },
  'lighting.environment': { label: 'Environment', options: [...ENV_OPTIONS], default: 'room' },
  'lighting.hdri': { label: 'Studio HDRI', hint: 'A real studio photo environment (Poly Haven). Its reflections and sparkle carry into cinematic renders.' },
  showFloor: { hint: null },
  // Degrees, and no 'Radians' tooltip: the row has ALWAYS been edited in degrees, so the
  // schema's hint is a lie about what the user is typing into.
  'object.rotation.0': { min: -180, max: 180, step: 1, hint: null },
  'object.rotation.1': { min: -180, max: 180, step: 1, hint: null },
  'object.rotation.2': { min: -180, max: 180, step: 1, hint: null },
  // A decal's spin: the same radians-on-disk / degrees-on-screen split, and the shipped
  // row kept its descriptive tooltip rather than announcing the unit.
  'object.spin': { min: -180, max: 180, step: 1 },
}

/**
 * Bounds and captions that depend on the SELECTION, not just on the key — the two the
 * template computed per row rather than writing down.
 *
 * Geometry is the big one: one schema entry per param KEY (keys are unique, see
 * `geometryParamControls`), but `detail` means 4..64 segments on a sphere and 0..3
 * subdivisions on an icosahedron. The row the user sees is the SELECTED kind's own
 * `ParamSpec`, verbatim — which is what the template drew, since it iterated
 * `PRIMITIVE_PARAMS[kind]` directly.
 *
 * Light intensity is the small one: `lightIntensityMaxValue` scaled the ceiling to the
 * light kind, because point/spot are physical (candela, inverse-square) and an area panel
 * is not.
 *
 * ## `default` is part of the narrowing, not decoration
 * A StudioRow resets to `spec.default` on double-click, and `resolveParam` falls back to
 * it for an untouched bag — so a row carrying the WRONG default is a live write, not a
 * cosmetic slip. Narrowing min/max/step without it produced exactly that: an icosahedron's
 * Detail row is 0..3 subdivisions, but the union entry's default is the sphere's 48, so a
 * double-click reset asked for 48 and the row clamped it to 3 — the MAXIMUM subdivision
 * where the kind's own default is 0. Same class on plane (→32), pyramid (→12),
 * cone/pyramid radiusTop (→0.5 where the kind says 0), gem depth, torusKnot tube, and on
 * a light's Intensity, whose schema default is the area panel's 8 while `createLight`
 * spawns a point/spot at 80. Every branch below now carries the default its bounds belong
 * to.
 */
function dynamicPatch(key: string, obj: SceneObject | null | undefined): RowPatch | null {
  if (key.startsWith(GEOMETRY_PARAM_PREFIX) && isPrim(obj)) {
    const sub = key.slice(GEOMETRY_PARAM_PREFIX.length)
    const spec = PRIMITIVE_PARAMS[(obj as { primitive: keyof typeof PRIMITIVE_PARAMS }).primitive]
      .find((s) => s.key === sub)
    if (!spec) return null
    return {
      label: spec.label, hint: spec.hint, min: spec.min, max: spec.max, step: spec.step,
      // A toggle spec stores 0 | 1 but draws as a switch, so its default is boolean here;
      // an options spec stores an index but draws as a select, so its default is the option
      // LABEL — both mirror the conversion `geometryParamField` does on the way out.
      default: spec.control === 'toggle' ? spec.default > 0.5
        : spec.control === 'options' ? (spec.options ?? [])[Math.round(spec.default)]
        : spec.default,
    }
  }
  if (key === 'object.intensity' && obj?.kind === 'light') {
    return { max: lightIntensityMax(obj.light), default: lightIntensityDefault(obj.light) }
  }
  return null
}

/** Opalescent moves three rows into the main body AND re-captions them — the shipped
 *  branch spelled out what each one does to a rainbow rather than to a PBR surface. */
const OPAL_OVERRIDE: Record<string, RowPatch> = {
  'object.material.color': { label: 'Base tint' },
  'object.material.metalness': {
    hint: 'Blends between plastic-like and metal reflections — high turns the rainbow into chrome',
  },
  'object.material.clearcoat': { hint: 'Adds a thin glossy varnish layer on top — the wet look' },
  'object.material.envMapIntensity': { label: 'Reflection intensity' },
}

/** Holographic foil moves the same three coat/reflection rows into its body and re-captions
 *  them for a metal foil — the coat is the sticker's laminate, the colour is the metal's tint. */
const HOLO_OVERRIDE: Record<string, RowPatch> = {
  'object.material.color': { label: 'Base tint' },
  'object.material.clearcoat': { hint: 'Adds a thin glossy laminate on top' },
  'object.material.envMapIntensity': { label: 'Reflection intensity' },
}

/** The per-type re-caption tables, keyed by the material type they apply to. */
const TYPE_OVERRIDE: Partial<Record<MaterialType, Record<string, RowPatch>>> = {
  opalescent: OPAL_OVERRIDE,
  holographic: HOLO_OVERRIDE,
}

/**
 * Size rows: the schema's scale multiplier bounds, expressed in the world units the
 * row actually shows. Label follows — the shipped inputs said Size, not Scale. The
 * soft-range flag is NOT touched here: rescaling a description leaves it a description.
 *
 * STEP 0.01, not the schema's 0.05, and it has to be: `readSceneControl` rounds world
 * Size to TWO DECIMALS, so a 1.37-wide object's row reads "1.37" — while `parseTyped`
 * snaps to the step. At 0.05 the row therefore advertised a number it would not write:
 * click the readout of that object and click away (RowSlider commits on blur, and the
 * draft it seeds is the displayed 1.37) and the object silently shrank to 1.35, fanned
 * across the whole selection. The `<input type="number">` it replaces snapped nothing.
 * 0.01 is the same two decimals the readout shows, so the row writes what it says.
 *
 * DEFAULT rescales with the bounds, and for the same reason `dynamicPatch` carries one
 * (see its own note): a narrowing patch that moves a row's units but leaves its default
 * behind makes double-click write a number from the OLD units. The schema's default is
 * 1 — the scale MULTIPLIER — so on an object whose base extent is 2.4 a reset asked for
 * "1 world unit", i.e. scale 0.42, when what "reset the size" means is scale 1. `1 × base`
 * is that, expressed in the units this row shows.
 *
 * Deliberately NOT rounded to the readout's two decimals, unlike `readSceneControl`'s
 * display value: `resetValue` (lib/studio/row.ts) emits the default verbatim — no step
 * snap, no clamp — and `writeTransform` divides it straight back by the same base. The
 * exact base therefore restores scale to exactly 1; a 2dp base of 1.3733… would restore
 * 1.37 / 1.3733… = 0.9976 instead, which is a reset that does not quite reset.
 */
function sizeOverride(axis: 0 | 1 | 2, ctx: SceneReadCtx): RowPatch {
  const base = ctx.baseSize?.[axis] || 1
  const label = ['Size X', 'Size Y', 'Size Z'][axis]!
  return { label, min: 0.05 * base, max: 10 * base, step: 0.01, default: 1 * base }
}

// ── visibility ───────────────────────────────────────────────────────────────

/**
 * Panel-only gates the schema does not carry, and deliberately should not.
 *
 * `relief.scale/contrast/tiling/invert` are agent- and motion-reachable today; adding a
 * `showIf` to hide them would be a schema change with reach beyond the inspector, so the
 * shipped template's own condition (a source is picked, and the picked image is not
 * already a normal map) lives here instead. The Size rows repeat the template's
 * `!selectedIsLight && !selectedIsDecal` — a light's and a decal's `scale` is unused by
 * the engine, so offering the rows would write numbers nothing reads.
 */
function panelGate(key: string, obj: SceneObject | null | undefined): boolean {
  if (key.startsWith('object.scale.')) return !!obj && obj.kind !== 'light' && obj.kind !== 'decal'
  if (key.startsWith('object.material.relief.') && key !== 'object.material.relief.source') {
    const src = materialField(obj!.material, 'relief.source')
    if (src === 'none') return false
    if (src === 'image' && !!obj!.material.normalImage) return false
  }
  if (key.startsWith('object.material.screen.') && key !== 'object.material.screen.pattern') {
    return materialField(obj!.material, 'screen.pattern') !== 'none'
  }
  return true
}

/**
 * Whether a schema control is drawn for this document + selection.
 *
 * Wraps `visibleSceneControls`'s per-entry semantics (`when`) rather than calling it, so
 * one control can be asked about without rebuilding the whole list, plus the two things
 * the list cannot know: that the inspector has NO active object (every `object.*` key is
 * unreachable — `isEditableMaterial` deliberately returns true for `obj === undefined`, so
 * that a Collection binding evaluated headlessly still describes itself), and the `showIf`
 * gates, which resolve against the ACTIVE object's material for `object.*` keys.
 */
export function scenePanelVisible(
  c: SceneControl | ControlSpec,
  doc: SceneDoc,
  obj: SceneObject | null | undefined,
  ctx: SceneReadCtx = {},
): boolean {
  const key = c.key
  if (key.startsWith('object.') && !obj) return false
  const when = (c as SceneControl).when
  if (when && !when(doc, obj ?? undefined)) return false
  if (!panelGate(key, obj)) return false
  return showIfVisible(c as ControlSpec, (k) => readSceneControl(doc, obj, k, ctx))
}

// ── the remap ────────────────────────────────────────────────────────────────

function withPresentation(
  c: SceneControl, card: string, matType: MaterialType | null, ctx: SceneReadCtx,
  obj: SceneObject | null | undefined,
): ControlSpec {
  const out: Record<string, unknown> = { ...c, group: card, bindable: false }
  delete out.when
  const patches: RowPatch[] = []
  if (OVERRIDE[c.key]) patches.push(OVERRIDE[c.key]!)
  const typePatch = matType ? TYPE_OVERRIDE[matType]?.[c.key] : undefined
  if (typePatch) patches.push(typePatch)
  const dyn = dynamicPatch(c.key, obj)
  if (dyn) patches.push(dyn)
  if (c.key.startsWith('object.scale.')) patches.push(sizeOverride(Number(c.key.slice(-1)) as 0 | 1 | 2, ctx))
  for (const p of patches) {
    // `optionLabels` is PAIRED WITH `options` BY POSITION (Task 3), so a patch that
    // replaces the options list orphans any labels the schema declared alongside the old
    // one — silently, and the row would then show label[i] against a value it does not
    // belong to. Replacing the values drops the labels; a patch that wants both supplies
    // both. (`lighting.environment` is the only `options` patch today and carries none.)
    if (p.options && out.optionLabels && !p.optionLabels) delete out.optionLabels
    for (const [k, v] of Object.entries(p)) {
      if (k === 'hint' && v === null) delete out.hint
      else out[k] = v
    }
  }
  return out as unknown as ControlSpec
}

const anchorRow = (a: ScenePanelAnchor, card: string): ControlSpec =>
  ({ key: a.key, label: a.label, kind: 'text', default: '', group: card, bindable: false } as ControlSpec)

/**
 * Every row the shipped inspector drew for this document + selection, carrying its
 * shipped card, caption, bounds and units, in its shipped within-card order, with the
 * bespoke-block anchors spliced in at their positions. Any OTHER `SCENE_CONTROLS` entry
 * whose group is a migrated card draws too — see `panelCardOf`'s doc.
 *
 * Post rows pass through untouched, with their own `Effects/<Label>` group — they were
 * already drawn by a `StudioControlPanel` and are not part of this migration.
 *
 * `controls` defaults to `SCENE_CONTROLS` and exists so a test can exercise the
 * permissive fall-through with an appended novel control without mutating the shared
 * module-level array. `ctx` carries the measured base extent the Size rows are expressed
 * in — the surface has it (it built the geometry), nothing else does.
 */
export function scenePanelControls(
  doc: SceneDoc,
  obj: SceneObject | null | undefined,
  controls: readonly SceneControl[] = SCENE_CONTROLS,
  ctx: SceneReadCtx = {},
): ControlSpec[] {
  const matType = editable(obj) ? typeOf(obj) : null
  const byCard = new Map<string, ControlSpec[]>()
  const push = (card: string, row: ControlSpec) => {
    if (!byCard.has(card)) byCard.set(card, [])
    byCard.get(card)!.push(row)
  }

  const post: ControlSpec[] = []
  for (const c of controls) {
    if (isScenePostGroup(c.group)) { post.push(c); continue }
    // The bespoke `ui.material.textureSet` anchor draws this control's row (thumbnail +
    // picker, Task 9) — the permissive Material-group fall-through below would otherwise
    // ALSO draw the raw `text` schema row, doubling it up.
    if (c.key === 'object.material.texture') continue
    const card = panelCardOf(c.key, matType, c.group)
    if (!card) continue
    if (!scenePanelVisible(c, doc, obj, ctx)) continue
    push(card, withPresentation(c, card, matType, ctx, obj))
  }
  for (const a of SCENE_PANEL_ANCHORS) {
    const card = panelCardOf(a.key, matType)
    if (!card) continue
    if (!a.visible(doc, obj)) continue
    push(card, anchorRow(a, card))
  }

  const out: ControlSpec[] = []
  for (const [card, rows] of byCard) {
    const order = cardOrder(card, matType, obj)
    const at = new Map(order.map((k, i) => [k, i]))
    rows.sort((a, b) => (at.get(a.key) ?? Number.MAX_SAFE_INTEGER) - (at.get(b.key) ?? Number.MAX_SAFE_INTEGER))
    out.push(...rows)
  }
  return [...out, ...post]
}
