import type { ControlSpec } from '~/lib/spacetype/effect'
import { postControls, POST_SECTIONS } from '~/lib/studio/post/controls'
import {
  MATERIAL_TYPES, MATERIAL_DEFAULTS, DEFAULT_MATERIAL, LIGHTING_PRESETS, ENVIRONMENT_KINDS, defaultDoc,
  PRIMITIVE_KINDS, LIGHT_DEFAULTS, DECAL_DEFAULTS, DECAL_BLENDS, lightIntensityMax, TEXTURE_TILING_RANGE,
  SCREEN_PATTERNS, SCREEN_GAPS, SCREEN_INKS, IMAGE_WRAPS, IMAGE_TILING_RANGE, IMAGE_FITS,
  IMAGE_PROJECTIONS, IMAGE_AXES, NO_BASE_COLOR,
  type SceneDoc, type SceneObject, type MaterialType, MATERIAL_TYPE_LABELS_ORDERED } from './config'
import { PRIMITIVE_PARAMS, MODIFIER_SPECS, modifierValue, totalClones, type ParamSpec } from './primParams'

/**
 * The single declarative description of Scene3D (3D Studio)'s parameters.
 *
 * Source for the agent's vocabulary and for Collection variable binding / sweeps
 * (`lib/collection/studioControls.ts`), same seam Shape/Gradient use. Keys are dotted
 * paths resolved by `makeConfigParams`, so each one must address a real leaf on
 * `SceneDoc` (doc-level groups: Lighting/Camera/Post) or on the ACTIVE object (the
 * `object.` prefix, mirroring Gradient's `layer.` — resolved by Task 2/3's studioControls
 * wiring, not by this file).
 *
 * It is a SUPERSET, but each consumer is opt-OUT, not opt-in: a new slider is
 * agent-visible and motion-animatable by default. `agent: false` withholds a control
 * from the agent; `animatable: false` (or an explicit `{min,max}` widening) governs
 * motion. `summary` is the opposite polarity — opt-IN, absent means never shown on the
 * collapsed node capsule; only the two lowest ranks render.
 *
 * Keys are FROZEN: persisted Collection bindings are `params.<key>`.
 *
 * ## Booleans (read before adding a toggle)
 * `ControlSpec` DOES have a `switch` kind now (`~/lib/spacetype/effect.ts`) — it was
 * added for the shared post stack's effect enables, which are booleans. Never model a
 * boolean as a two-option `select('on'|'off')`: that writes the STRING `'on'` into a
 * BOOLEAN field, and `makeConfigParams` writes straight through the proxy with no
 * coercion, corrupting the document. Use `switch`.
 *
 * Scene3D's post-processing block is now DERIVED from the shared manifest
 * (`postControls({ host: 'three-depth' })`, spliced in below) rather than hand-declared,
 * matching Gradient/Shape/Texture — so every `post.*` effect enable (bloom/color/duotone/
 * chroma/blur/film/halftone/dotScreen/glitch/grain/vignette/gtao) IS an agent- and
 * inspector-reachable `switch` control, not a gap.
 *
 * `material.unlit` now joins the schema too (`object.material.unlit`, gated to
 * shaderFill exactly like the surface's own Unlit switch) — so the agent can flip
 * lit↔unlit on a shaderFill material, not just tune its roughness while stuck one way.
 * `material.relief.invert` has since joined too — the inspector always drew it — as an
 * `agent: false` switch: declared for the inspector, still withheld from the agent.
 * `GlbObject.materialOverride` remains hand-omitted.
 *
 * `showFloor` (scene-level, doc.showFloor) also joins here, under a new 'Background'
 * group — the grid + shadow-catcher ground toggle from the surface's Background panel.
 *
 * ## The inspector-only tail: Geometry, Light, Decal
 * Three whole panel sections used to be hand-written markup, outside this schema
 * entirely: the per-primitive geometry `params`, the shared modifier/cloner stack, the
 * `LightObject` fields, and the `DecalObject` projection fields. They are all declared
 * here now, so the 3D inspector draws NOTHING by hand except genuine editors (the object
 * tree, sculpt/merge, the object-motion pickers, the add menus).
 *
 * Every one of those entries is `agent: false, animatable: false`. Declaring a control so
 * the INSPECTOR can draw it must not silently widen what a model may change nor what the
 * motion picker offers — granting the agent geometry/light/decal knobs is a separate,
 * later decision. The same two-flags-move-together rule the per-type material branches
 * above already follow.
 *
 * Two of them are derived rather than hand-listed, because the TEMPLATE derived them too
 * (it iterated the same two tables): see `geometryParamControls` and
 * `modifierControls` below.
 *
 * ## Deliberately NOT in this schema
 * - GLB `url` (an asset reference, not a tunable) and `GlbObject.materialOverride`
 *   (boolean — see the booleans note above; whether it's ON gates every `object.material.*`
 *   control via `when`, but the flag itself isn't a control).
 * - The option-valued modifiers (`taperAxis`/`twistAxis`/`bendAxis`/`jitterMode`/
 *   `cloneMode`/`cloneAxis`). They store the option's INDEX in the same flat number bag
 *   as the sliders, so a `select` here would write the STRING 'y' where a 1 belongs —
 *   the exact corruption the booleans note above warns about, one type over. They stay
 *   bespoke segmented controls behind a panel anchor.
 * - A decal's text/font and a text primitive's string/font (`content.text`/`content.font`)
 *   — a text field and a font picker, not parameters.
 * - Per-object motion presets (`ObjectMotion` — loop/in/out/offset) and camera motion
 *   presets — these are their own editor (`app/lib/scene3d/motion/`), not param sliders.
 * - `background` (the colour/transparency value itself — a stateful proxy with
 *   last-colour memory over `doc.background === 'transparent'`, Scene3DStudioSurface.vue:
 *   475-483, not a plain doc leaf) and `output.width/height` — outside the "at minimum"
 *   list this schema was scoped to; add them here in a follow-on if the agent/Collection
 *   story needs them.
 *
 * Must stay free of `three` imports — this module is dynamically imported by the
 * Collection control resolver (see shapefx/controls.ts's identical constraint).
 */
export type SceneControl = ControlSpec & {
  when?: (doc: SceneDoc, obj?: SceneObject) => boolean
}

/** Emission order; a control whose group is not listed here is silently dropped by
 *  visibleSceneControls. POST_SECTIONS ('Effects', 'Effects/Bloom', ...) is appended so
 *  the shared post stack's nested sections land after the hand-declared groups — mirrors
 *  texturefx/sections.ts's `...POST_SECTIONS` append. */
export const SCENE_SECTIONS = [
  'Material', 'Lighting', 'Camera', 'Background', 'Transform', 'Geometry', 'Light', 'Decal',
  ...POST_SECTIONS,
] as const

// ── `when` predicates ────────────────────────────────────────────────────────────
// Material controls only make sense on an object that actually renders `.material`:
// a primitive always does, a GLB only once `materialOverride` is on, and a light never
// does (LightObject carries a dummy DEFAULT_MATERIAL — see config.ts's sceneHasShaderFill
// doc — that is never fed to a real THREE material). Mirrors the inspector panel's own
// `editable` rule (lib/scene3d/panelPresentation.ts). No active object (`obj` undefined,
// e.g. a Collection binding evaluated without a live selection) defaults to visible —
// the schema still needs to describe what the control WOULD do.
const isEditableMaterial = (_doc: SceneDoc, obj?: SceneObject): boolean =>
  !obj || obj.kind === 'primitive' || (obj.kind === 'glb' && obj.materialOverride === true)

const materialTypeOf = (obj?: SceneObject): MaterialType =>
  obj && obj.kind !== 'light' ? obj.material.type : DEFAULT_MATERIAL.type

// Mirrors the Surface/Coat/Glow/Transparency/Iridescence/Reflection block, which the
// inspector only renders for standard + glass.
const isPhysicalMaterial = (doc: SceneDoc, obj?: SceneObject): boolean =>
  isEditableMaterial(doc, obj) && (materialTypeOf(obj) === 'standard' || materialTypeOf(obj) === 'glass')

// Phong's own specular/shininess model — deliberately distinct from the PBR types, see
// MaterialType's doc in config.ts.
const isPhongMaterial = (doc: SceneDoc, obj?: SceneObject): boolean =>
  isEditableMaterial(doc, obj) && materialTypeOf(obj) === 'phong'

// The Unlit switch itself only exists inside the shaderFill branch — every other material
// type has no MeshBasicMaterial-vs-MeshStandardMaterial choice at all.
const isShaderFillMaterial = (doc: SceneDoc, obj?: SceneObject): boolean =>
  isEditableMaterial(doc, obj) && materialTypeOf(obj) === 'shaderFill'

// The uploaded-picture branch. Everything under `object.material.image*` is this type
// only — a different material type keeps the stored values and ignores them, exactly as
// `texture`/`textureTiling` behave outside standard/glass/opalescent.
const isImageMaterial = (doc: SceneDoc, obj?: SceneObject): boolean =>
  isEditableMaterial(doc, obj) && materialTypeOf(obj) === 'image'

// The Unlit switch exists on the two types that have a Basic-vs-Standard choice at all:
// shaderFill (a catalog effect that often wants to glow flat) and image (a photo or logo
// that usually wants to be shown as it is). Every other type has no such choice.
const hasUnlitToggle = (doc: SceneDoc, obj?: SceneObject): boolean =>
  isShaderFillMaterial(doc, obj) || isImageMaterial(doc, obj)

// Opacity is a plain Material field every class has, so it reads on the physical types and
// on image. (transmission/ior/thickness and the rest of the physical block stay
// standard+glass only — a picture has no volumetric interior.)
const hasOpacity = (doc: SceneDoc, obj?: SceneObject): boolean =>
  isPhysicalMaterial(doc, obj) || isImageMaterial(doc, obj)

// roughness/metalness apply to standard, glass and opalescent (always) and to image and
// shaderFill only while they aren't unlit (a MeshBasicMaterial has no roughness/metalness
// slot at all). Mirrors the inspector's per-branch rows for these two keys.
const hasPbrSurface = (doc: SceneDoc, obj?: SceneObject): boolean => {
  if (!isEditableMaterial(doc, obj)) return false
  const t = materialTypeOf(obj)
  const unlit = !!obj && obj.kind !== 'light' && obj.material.unlit === true
  if (t === 'standard' || t === 'glass' || t === 'opalescent') return true
  // image and shaderFill both build a MeshBasicMaterial when unlit, which has neither slot.
  if (t === 'image' || t === 'shaderFill') return !unlit
  return false
}

// Opalescent (thin-film / holographic) — its own spectral block. Mirrors the inspector's
// opalescent branch.
const isOpalMaterial = (doc: SceneDoc, obj?: SceneObject): boolean =>
  isEditableMaterial(doc, obj) && materialTypeOf(obj) === 'opalescent'

// Holographic foil — a diffraction-grating rainbow over a metal. Its own dial block; NOT a
// PBR surface (metalness is pinned at 1 and roughness comes from its Gloss dial, so the shared
// roughness/metalness rows would be dead controls on it — hasPbrSurface stays untouched).
const isHoloMaterial = (doc: SceneDoc, obj?: SceneObject): boolean =>
  isEditableMaterial(doc, obj) && materialTypeOf(obj) === 'holographic'

// The glossy-coat / reflection knobs (clearcoat, coat roughness, reflection intensity) apply to
// the physical materials AND to opalescent + holographic (both MeshPhysicalMaterial) — matte
// soap-bubble at clearcoat 0, wet chrome-holo / laminated sticker as it rises. NOT the whole
// physical block (sheen/transmission/etc stay standard+glass only), just these three.
const hasReflectiveCoat = (doc: SceneDoc, obj?: SceneObject): boolean =>
  isPhysicalMaterial(doc, obj) || isOpalMaterial(doc, obj) || isHoloMaterial(doc, obj)

// The ambientCG texture set binds on exactly the types materials.ts's TEXTURE_TYPES names
// (standard / glass / opalescent). Holographic carries the coat knobs but NOT a texture set —
// offering `texture` there would store a value nothing reads — so the texture rows gate on
// this narrower predicate, not on hasReflectiveCoat.
const hasTextureSet = (doc: SceneDoc, obj?: SceneObject): boolean =>
  isPhysicalMaterial(doc, obj) || isOpalMaterial(doc, obj)

// Base `color` reads on standard/glass/phong/toon/fresnel and as the opalescent lit substrate
// tint / the holographic foil's metal tint; matcap/gradient/image/shaderFill materials each
// drive colour a different way (matcap id, gradient ramp, uploaded texture, catalog effect) and
// never read `.color` in the UI.
const COLOR_TYPES: MaterialType[] = ['standard', 'glass', 'phong', 'toon', 'fresnel', 'opalescent', 'holographic']
const hasBaseColor = (doc: SceneDoc, obj?: SceneObject): boolean =>
  isEditableMaterial(doc, obj) && COLOR_TYPES.includes(materialTypeOf(obj))

// Relief sits after the per-type chain and applies to every branch EXCEPT an unlit
// shaderFill or image (both build a MeshBasicMaterial with no bump slot at all — the
// panel draws a "turn off Unlit to use it" notice in that state instead).
const reliefApplies = (doc: SceneDoc, obj?: SceneObject): boolean => {
  if (!isEditableMaterial(doc, obj)) return false
  const t = materialTypeOf(obj)
  if ((t === 'shaderFill' || t === 'image') && obj && obj.kind !== 'light' && obj.material.unlit === true) return false
  return true
}

// The screen finish sits after the per-type chain like relief, on every branch except glass
// (transmission + alpha gaps is out of scope — see ScreenSpec). Dials stay in the schema
// whatever the pattern is, so the agent can set pattern AND density in one patch; the panel
// hides them while the pattern is none (panelPresentation's panelGate, the relief precedent).
const screenApplies = (doc: SceneDoc, obj?: SceneObject): boolean =>
  isEditableMaterial(doc, obj) && materialTypeOf(obj) !== 'glass'

// Per-type branches the inspector draws but the schema had never described. Each is
// `agent: false` AND `animatable: false`: declaring a control so the INSPECTOR can draw it
// must not silently widen what the model may change, nor what the motion picker offers.
// The two flags move together for an inspector-only entry — and four of these are gated
// by `showIf`, which the motion picker does not evaluate, so they would have listed
// themselves as targets in states where the row itself is not even on screen.
const isToonMaterial = (doc: SceneDoc, obj?: SceneObject): boolean =>
  isEditableMaterial(doc, obj) && materialTypeOf(obj) === 'toon'

const isFresnelMaterial = (doc: SceneDoc, obj?: SceneObject): boolean =>
  isEditableMaterial(doc, obj) && materialTypeOf(obj) === 'fresnel'

const isGradientMaterial = (doc: SceneDoc, obj?: SceneObject): boolean =>
  isEditableMaterial(doc, obj) && materialTypeOf(obj) === 'gradient'

// Faceted/prismatic shading needs the per-face extent attributes only primitive
// geometry bakes; an imported GLB always ramps smooth. Mirrors the template's
// `v-if="selectedIsPrimitive"` on the Shading row inside the gradient branch.
const isGradientPrimitive = (doc: SceneDoc, obj?: SceneObject): boolean =>
  isGradientMaterial(doc, obj) && (!obj || obj.kind === 'primitive')

const PALETTE_MODES = ['manual', 'harmony'] as const
const GRADIENT_TYPES = ['linear', 'radial'] as const
const GRADIENT_SHADINGS = ['smooth', 'faceted', 'prismatic', 'scatter', 'ombre'] as const

const RELIEF_SOURCES = ['none', 'shader', 'image'] as const

// ── Local builders (mirrors shapefx/controls.ts's slider/select/color helpers) ──────
const slider = (
  key: string, label: string, min: number, max: number, step: number, group: string,
  def: number, hint?: string, extra: Partial<SceneControl> = {},
): SceneControl =>
  ({ key, label, kind: 'slider', min, max, step, default: def, group, ...(hint ? { hint } : {}), ...extra } as SceneControl)

const select = (
  key: string, label: string, options: string[], def: string, group: string,
  hint?: string, extra: Partial<SceneControl> = {},
): SceneControl =>
  ({ key, label, kind: 'select', options, default: def, group, ...(hint ? { hint } : {}), ...extra } as SceneControl)

const color = (key: string, label: string, def: string, group: string, extra: Partial<SceneControl> = {}): SceneControl =>
  ({ key, label, kind: 'color', default: def, group, ...extra } as SceneControl)

const D = defaultDoc()

// ── Geometry / Light / Decal: the inspector-only tail ───────────────────────────────
// Every entry below carries this pair. See the module doc's "inspector-only tail" note:
// the panel gains a row, the agent and the motion picker gain nothing.
const INSPECTOR_ONLY = { agent: false, animatable: false } as const

/** Where a primitive's per-kind geometry parameters live (`PrimitiveObject.params`,
 *  keyed by `ParamSpec.key`). Exported so the panel's read/write plumbing and this
 *  schema cannot disagree about the prefix. */
export const GEOMETRY_PARAM_PREFIX = 'object.params.'
/** …and the shared deformation/cloner bag (`PrimitiveObject.modifiers`). */
export const MODIFIER_PREFIX = 'object.modifiers.'

const isPrimitiveObj = (obj?: SceneObject): obj is Extract<SceneObject, { kind: 'primitive' }> =>
  !!obj && obj.kind === 'primitive'

/** A primitive's live clone mode as an index (0 linear, 1 radial, 2 grid). Mirrors the
 *  template's own `cloneMode` computed, which is what swapped the Cloner's rows. */
const cloneModeOf = (obj?: SceneObject): number =>
  isPrimitiveObj(obj) ? Math.round(modifierValue(obj.modifiers, 'cloneMode')) : 0

/**
 * The per-primitive geometry parameters, DERIVED from `PRIMITIVE_PARAMS` rather than
 * re-typed — exactly as the deleted template derived them (`geoSpecs` was
 * `PRIMITIVE_PARAMS[o.primitive]`, drawn one StudioSlider per spec).
 *
 * One entry per distinct param KEY, not per (kind, key) pair: the keys are the schema's
 * identity (`scene3d-controls.unit.spec.ts` asserts they are unique, and a duplicate
 * would make `object.params.detail` mean two different things). But `detail` genuinely
 * IS two different things — 4..64 segments on a sphere, 0..3 subdivisions on an
 * icosahedron, 32..256 on a torus knot — so what a single entry can honestly declare is
 * the UNION: the widest range any kind allows, the finest step any kind uses, and the
 * first declaring kind's caption and default. The panel then narrows each row to the
 * SELECTED kind's own spec (`panelPresentation.ts`'s per-kind patch), which is what the
 * user sees and what the parity spec pins. Nothing else reads these bounds — the entries
 * are `agent: false, animatable: false`.
 */
function geometryParamControls(): SceneControl[] {
  const byKey = new Map<string, ParamSpec[]>()
  for (const kind of PRIMITIVE_KINDS) {
    for (const spec of PRIMITIVE_PARAMS[kind]) {
      if (!byKey.has(spec.key)) byKey.set(spec.key, [])
      byKey.get(spec.key)!.push(spec)
    }
  }
  const out: SceneControl[] = []
  for (const [key, specs] of byKey) {
    const first = specs[0]!
    const declares = (_doc: SceneDoc, obj?: SceneObject): boolean =>
      isPrimitiveObj(obj) && PRIMITIVE_PARAMS[obj.primitive].some((s) => s.key === key)
    // A toggle spec stores 0 | 1 in the same flat number bag; `switch` is still the
    // right KIND (the template drew a checkbox), and the panel's reader/writer convert
    // at the seam so the bag stays numbers. See panelPresentation's own note.
    if (specs.some((s) => s.control === 'toggle')) {
      out.push({
        key: `${GEOMETRY_PARAM_PREFIX}${key}`, label: first.label, kind: 'switch',
        default: first.default > 0.5, group: 'Geometry', hint: first.hint,
        when: declares, ...INSPECTOR_ONLY,
      } as SceneControl)
      continue
    }
    out.push(slider(
      `${GEOMETRY_PARAM_PREFIX}${key}`, first.label,
      Math.min(...specs.map((s) => s.min)), Math.max(...specs.map((s) => s.max)),
      Math.min(...specs.map((s) => s.step)), 'Geometry', first.default, first.hint,
      { when: declares, ...INSPECTOR_ONLY },
    ))
  }
  return out
}

/**
 * The deformation + cloner stack, derived from `MODIFIER_SPECS` the same way. Unlike the
 * geometry params these are shared by every primitive kind, so each spec's own bounds are
 * the truth and no per-kind narrowing is needed.
 *
 * `control: 'options'` specs are skipped — they store an index (see the module doc's
 * "Deliberately NOT in this schema"). The cloner's placement rows carry the template's
 * own mode gating: `CLONER_KEYS` swapped them with the mode, and grid dropped
 * `cloneCount` outright in favour of its three axis counts.
 */
const CLONE_MODE_GATE: Record<string, number[]> = {
  cloneCount: [0, 1],
  cloneOffsetX: [0], cloneOffsetY: [0], cloneOffsetZ: [0],
  cloneRadius: [1],
  cloneCountX: [2], cloneCountY: [2], cloneCountZ: [2],
  cloneSpacingX: [2], cloneSpacingY: [2], cloneSpacingZ: [2],
}

/** Vary's own gating — the same job as CLONE_MODE_GATE above, but predicate-valued
 *  because these rows depend on more than the clone mode.
 *
 *  Every vary row needs MORE THAN ONE COPY: there is nothing to vary across a single
 *  object, and an always-present block would clutter the Cloner card for the common case.
 *  `panelPresentation.ts` gates its three bespoke option ANCHORS (varyMode / varyColour /
 *  Spread, which store an index and so get no schema row at all) with these very
 *  functions rather than a second copy — hence the export below. */
export const varyOn = (obj?: SceneObject): boolean =>
  isPrimitiveObj(obj) && totalClones(obj.modifiers) > 1

/** The driver, as a stored index: 0 sequence, 1 random, 2 falloff. */
export const varyModeOf = (obj?: SceneObject): number =>
  isPrimitiveObj(obj) ? Math.round(modifierValue(obj.modifiers, 'varyMode')) : 0

/** Whether the colour HALF of Vary applies at all. Some materials have no base colour
 *  for a per-copy tint to mix against, so offering the control would be offering a dead
 *  one; the render side already refuses them. Read straight off config.ts's
 *  `NO_BASE_COLOR` — the same set `materials.ts`'s `hasVertexTint` consults — so the two
 *  cannot disagree about which types those are. */
export const varyColorable = (obj?: SceneObject): boolean =>
  varyOn(obj) && isPrimitiveObj(obj) && !NO_BASE_COLOR.has(obj.material.type)

/** …and whether the user has actually turned it on. */
export const varyColorOn = (obj?: SceneObject): boolean =>
  varyColorable(obj) && isPrimitiveObj(obj) && Math.round(modifierValue(obj.modifiers, 'varyColor')) === 1

const VARY_GATE: Record<string, (obj?: SceneObject) => boolean> = {
  varySeed: (o) => varyOn(o) && varyModeOf(o) === 1,
  varyFalloffCenter: (o) => varyOn(o) && varyModeOf(o) === 2,
  varyFalloffRadius: (o) => varyOn(o) && varyModeOf(o) === 2,
  varyColorStrength: (o) => varyColorOn(o),
}

function modifierControls(): SceneControl[] {
  const out: SceneControl[] = []
  for (const spec of MODIFIER_SPECS) {
    if (spec.control === 'options') continue
    const modes = CLONE_MODE_GATE[spec.key]
    const varyGate = VARY_GATE[spec.key]
    const when = varyGate
      ? (_doc: SceneDoc, obj?: SceneObject) => varyGate(obj)
      : modes
        ? (_doc: SceneDoc, obj?: SceneObject) => isPrimitiveObj(obj) && modes.includes(cloneModeOf(obj))
        : (_doc: SceneDoc, obj?: SceneObject) => isPrimitiveObj(obj)
    out.push(slider(
      `${MODIFIER_PREFIX}${spec.key}`, spec.label, spec.min, spec.max, spec.step,
      'Geometry', spec.default, spec.hint, { when, ...INSPECTOR_ONLY },
    ))
  }
  return out
}

// Light fields sit FLAT on `LightObject` (config.ts), not under a `light.` sub-object —
// `object.light` is already taken, it holds the KIND ('point' | 'spot' | 'rect'). So the
// keys are `object.color`, `object.intensity`, … addressing real leaves on the object.
const isLight = (_doc: SceneDoc, obj?: SceneObject): boolean => !!obj && obj.kind === 'light'
const isPointOrSpot = (_doc: SceneDoc, obj?: SceneObject): boolean =>
  !!obj && obj.kind === 'light' && (obj.light === 'point' || obj.light === 'spot')
const isSpotLight = (_doc: SceneDoc, obj?: SceneObject): boolean =>
  !!obj && obj.kind === 'light' && obj.light === 'spot'
const isRectLight = (_doc: SceneDoc, obj?: SceneObject): boolean =>
  !!obj && obj.kind === 'light' && obj.light === 'rect'

const isDecal = (_doc: SceneDoc, obj?: SceneObject): boolean => !!obj && obj.kind === 'decal'
const isTextDecal = (_doc: SceneDoc, obj?: SceneObject): boolean =>
  !!obj && obj.kind === 'decal' && obj.content.type === 'text'

export const SCENE_CONTROLS: SceneControl[] = [
  // --- Material (prefix object.material.) ----------------------------------------
  color('object.material.color', 'Color', DEFAULT_MATERIAL.color, 'Material', { when: hasBaseColor }),
  slider('object.material.roughness', 'Roughness', 0, 1, 0.01, 'Material', DEFAULT_MATERIAL.roughness,
    'How matte or glossy the surface is', {
      when: hasPbrSurface, summary: 2,
      // Mirrors the inspector's own withholding of the Roughness row once Unlit is on.
      // `notEquals: true`, NOT `equals: false`: `unlit` is
      // absent (undefined) on every material type but shaderFill, and showIfVisible compares
      // with `===` — `equals: false` would read undefined !== false and wrongly hide this row
      // for standard/glass/image/opalescent, which `hasPbrSurface` already keeps visible and
      // have no unlit concept at all. `notEquals: true` reads undefined !== true → stays
      // visible, and true !== true → hides only once unlit is actually flipped on.
      showIf: { key: 'object.material.unlit', notEquals: true },
    }),
  slider('object.material.metalness', 'Metalness', 0, 1, 0.01, 'Material', DEFAULT_MATERIAL.metalness,
    'Blends between plastic-like and metal reflections', {
      when: hasPbrSurface,
      showIf: { key: 'object.material.unlit', notEquals: true },
    }),
  // Without optionLabels the row title-cases the stored id and shows "ShaderFill". The labels
  // are derived from MATERIAL_TYPE_LABELS (config.ts) in MATERIAL_TYPES order, so adding a
  // material is a compile error until it is named rather than a silently shifted list.
  select('object.material.type', 'Material type', [...MATERIAL_TYPES], DEFAULT_MATERIAL.type, 'Material', undefined,
    { when: isEditableMaterial, summary: 1, optionLabels: MATERIAL_TYPE_LABELS_ORDERED }),
  {
    key: 'object.material.unlit', label: 'Unlit', kind: 'switch', default: MATERIAL_DEFAULTS.unlit, group: 'Material',
    hint: 'Glows flat instead of being shaded by scene lights',
    when: hasUnlitToggle,
  } as SceneControl,

  // Physical block — standard + glass only.
  slider('object.material.clearcoat', 'Clearcoat', 0, 1, 0.01, 'Material', MATERIAL_DEFAULTS.clearcoat,
    'Adds a thin glossy varnish layer on top', { when: hasReflectiveCoat }),
  slider('object.material.clearcoatRoughness', 'Coat roughness', 0, 1, 0.01, 'Material', MATERIAL_DEFAULTS.clearcoatRoughness,
    'How blurred or sharp that varnish coat looks', { when: hasReflectiveCoat }),
  slider('object.material.sheen', 'Sheen', 0, 1, 0.01, 'Material', MATERIAL_DEFAULTS.sheen,
    'Soft fabric-like edge highlight', { when: isPhysicalMaterial }),
  color('object.material.sheenColor', 'Sheen colour', MATERIAL_DEFAULTS.sheenColor, 'Material', { when: isPhysicalMaterial }),
  color('object.material.emissive', 'Emissive', MATERIAL_DEFAULTS.emissive, 'Material', { when: isPhysicalMaterial }),
  slider('object.material.emissiveIntensity', 'Emissive intensity', 0, 5, 0.05, 'Material', MATERIAL_DEFAULTS.emissiveIntensity,
    'How brightly the material glows on its own', { when: isPhysicalMaterial }),
  slider('object.material.opacity', 'Opacity', 0, 1, 0.01, 'Material', MATERIAL_DEFAULTS.opacity,
    'How see-through the whole surface is', { when: hasOpacity }),
  slider('object.material.iridescence', 'Iridescence', 0, 1, 0.01, 'Material', MATERIAL_DEFAULTS.iridescence,
    'Strength of the soap-bubble colour shift', { when: isPhysicalMaterial }),
  slider('object.material.iridescenceIOR', 'Iridescence IOR', 1, 2.33, 0.01, 'Material', MATERIAL_DEFAULTS.iridescenceIOR,
    'Tunes which colours the bubble film shifts to', { when: isPhysicalMaterial }),
  slider('object.material.envMapIntensity', 'Reflection intensity', 0, 3, 0.05, 'Material', MATERIAL_DEFAULTS.envMapIntensity,
    'How strongly reflections from the surroundings show', { when: hasReflectiveCoat }),
  slider('object.material.ior', 'IOR', 1, 2.33, 0.01, 'Material', MATERIAL_DEFAULTS.ior,
    'How strongly light bends passing through', { when: isPhysicalMaterial }),
  slider('object.material.transmission', 'Transmission', 0, 1, 0.01, 'Material', MATERIAL_DEFAULTS.transmission,
    'Lets light pass through, like glass', { when: isPhysicalMaterial }),
  slider('object.material.thickness', 'Thickness', 0, 2, 0.05, 'Material', MATERIAL_DEFAULTS.thickness,
    'How solid the glass feels as light travels in', { when: isPhysicalMaterial }),

  // Phong — its own specular/shininess model, no roughness/metalness equivalent.
  slider('object.material.shininess', 'Shininess', 0, 200, 1, 'Material', MATERIAL_DEFAULTS.shininess,
    'How tight and glossy the highlight is — higher is sharper', { when: isPhongMaterial }),
  color('object.material.specular', 'Specular', MATERIAL_DEFAULTS.specular, 'Material', { when: isPhongMaterial }),

  // Opalescent — thin-film / holographic. The spectrum itself is the shared `gradientStops`
  // ramp (edited in the surface's stop editor, like the gradient material); these five scalars
  // steer how it maps onto the surface and are the agent-/motion-animatable knobs.
  slider('object.material.opalHueShift', 'Hue shift', 0, 360, 1, 'Material', MATERIAL_DEFAULTS.opalHueShift!,
    'Rotates the whole rainbow around the colour wheel', { when: isOpalMaterial, summary: 2 }),
  slider('object.material.opalFrequency', 'Spectrum bands', 0.5, 5, 0.05, 'Material', MATERIAL_DEFAULTS.opalFrequency!,
    'How many rainbow bands wrap the surface', { when: isOpalMaterial }),
  slider('object.material.opalAngleMix', 'Angle response', 0, 1, 0.01, 'Material', MATERIAL_DEFAULTS.opalAngleMix!,
    'Blends the flow from surface-shape-driven to viewing-angle-driven', { when: isOpalMaterial }),
  slider('object.material.opalFlowSpeed', 'Flow speed', 0, 2, 0.01, 'Material', MATERIAL_DEFAULTS.opalFlowSpeed!,
    'Animates the spectrum over time — 0 keeps it still', { when: isOpalMaterial }),
  slider('object.material.opalStrength', 'Rainbow strength', 0, 1, 0.01, 'Material', MATERIAL_DEFAULTS.opalStrength!,
    'How much rainbow shows over the base colour', { when: isOpalMaterial, summary: 1 }),

  // Holographic foil — a diffraction-grating rainbow streak over a metal base (see config.ts's
  // holo* field doc). Same spectrum ramp as opalescent (the surface's stop editor); these seven
  // scalars steer the streak and are the agent-/motion-animatable knobs.
  slider('object.material.holoStrength', 'Rainbow strength', 0, 2, 0.01, 'Material', MATERIAL_DEFAULTS.holoStrength!,
    'How bright the rainbow streak glows over the metal', { when: isHoloMaterial, summary: 1 }),
  slider('object.material.holoBands', 'Bands', 0.5, 8, 0.05, 'Material', MATERIAL_DEFAULTS.holoBands!,
    'How many rainbow repeats fit in one sweep — fine foil is high', { when: isHoloMaterial }),
  slider('object.material.holoAngle', 'Grating angle', 0, 180, 1, 'Material', MATERIAL_DEFAULTS.holoAngle!,
    'Turns the direction the rainbow streak runs in', { when: isHoloMaterial }),
  slider('object.material.holoFlakes', 'Flakes', 0, 1, 0.01, 'Material', MATERIAL_DEFAULTS.holoFlakes!,
    '0 is a clean foil; higher breaks it into randomly turned glitter flakes', { when: isHoloMaterial, summary: 2 }),
  slider('object.material.holoFlakeSize', 'Flake size', 0.01, 0.5, 0.005, 'Material', MATERIAL_DEFAULTS.holoFlakeSize!,
    'Size of each glitter flake', { when: isHoloMaterial }),
  slider('object.material.holoGloss', 'Gloss', 0, 1, 0.01, 'Material', MATERIAL_DEFAULTS.holoGloss!,
    'Polished mirror foil at high, brushed at low', { when: isHoloMaterial }),
  slider('object.material.holoHueShift', 'Hue shift', 0, 360, 1, 'Material', MATERIAL_DEFAULTS.holoHueShift!,
    'Rotates the whole rainbow around the colour wheel', { when: isHoloMaterial }),

  // Surface relief — a grayscale height field perturbing the lit normal (see config.ts's
  // ReliefSpec doc). `source` picks the origin; scale/contrast/tiling tune it. Orthogonal
  // to material type, so gated only by reliefApplies (isEditableMaterial + not-unlit-
  // shaderFill), not by isPhysicalMaterial/isPhongMaterial.
  // optionLabels: template truth (64492f314, the three-button grid at ~4241-4250)
  // showed 'None' / 'Effect' / 'Image', not the raw 'none'/'shader'/'image' values.
  select('object.material.relief.source', 'Relief source', [...RELIEF_SOURCES], 'none', 'Material',
    'Where the height field comes from — a catalog effect or an uploaded image',
    { when: reliefApplies, optionLabels: ['None', 'Effect', 'Image'] }),
  slider('object.material.relief.scale', 'Relief scale', 0, 4, 0.01, 'Material', MATERIAL_DEFAULTS.reliefScale,
    'How raised or recessed the surface detail looks', { when: reliefApplies }),
  slider('object.material.relief.contrast', 'Relief contrast', 1, 6, 0.1, 'Material', MATERIAL_DEFAULTS.reliefContrast,
    'Deepens the light and dark areas so the relief catches the light', { when: reliefApplies }),
  slider('object.material.relief.tiling', 'Relief tiling', 0.25, 12, 0.25, 'Material', MATERIAL_DEFAULTS.reliefTiling,
    'How many times the pattern repeats across the surface — higher is finer', { when: reliefApplies }),

  // Glass extras the Transparency block drew: dispersion + the attenuation pair.
  slider('object.material.dispersion', 'Dispersion', 0, 5, 0.05, 'Material', MATERIAL_DEFAULTS.dispersion,
    'Splits refracted light into rainbow fringes', { when: isPhysicalMaterial, agent: false, animatable: false }),
  color('object.material.attenuationColor', 'Attenuation', MATERIAL_DEFAULTS.attenuationColor, 'Material',
    { when: isPhysicalMaterial, agent: false }),
  slider('object.material.attenuationDistance', 'Attenuation dist', 0, 10, 0.1, 'Material', MATERIAL_DEFAULTS.attenuationDistance,
    'How deep light travels before tinting (0 = off)', { when: isPhysicalMaterial, agent: false, animatable: false }),

  // Toon — cel bands.
  slider('object.material.toonSteps', 'Steps', 2, 5, 1, 'Material', MATERIAL_DEFAULTS.toonSteps,
    'Number of flat cel-shading bands', { when: isToonMaterial, agent: false, animatable: false }),

  // Fresnel — rim glow.
  color('object.material.fresnelColor', 'Rim colour', MATERIAL_DEFAULTS.fresnelColor, 'Material',
    { when: isFresnelMaterial, agent: false }),
  slider('object.material.fresnelPower', 'Power', 1, 8, 0.1, 'Material', MATERIAL_DEFAULTS.fresnelPower,
    'How tightly the rim glow hugs the edges', { when: isFresnelMaterial, agent: false, animatable: false }),

  // Gradient — palette source, ramp direction and mapping. The ramp/stop editors and the
  // harmony scheme picker stay bespoke widgets (the inspector's own blocks); these are the
  // scalar/enum rows around them. `paletteHarmony` is deliberately absent: its options carry
  // display labels (HARMONY_LABELS) a bare `select` row cannot show.
  select('object.material.paletteMode', 'Palette', [...PALETTE_MODES], MATERIAL_DEFAULTS.paletteMode, 'Material', undefined,
    { when: isGradientMaterial, agent: false }),
  slider('object.material.paletteHue', 'Hue', 0, 360, 1, 'Material', MATERIAL_DEFAULTS.paletteHue,
    'Seed hue the harmony scheme is built from',
    { when: isGradientMaterial, agent: false, animatable: false, showIf: { key: 'object.material.paletteMode', equals: 'harmony' } }),
  slider('object.material.paletteSat', 'Saturation', 0, 1, 0.01, 'Material', MATERIAL_DEFAULTS.paletteSat,
    'How vivid the generated colours are',
    { when: isGradientMaterial, agent: false, animatable: false, showIf: { key: 'object.material.paletteMode', equals: 'harmony' } }),
  slider('object.material.paletteLight', 'Lightness', 0.2, 0.9, 0.01, 'Material', MATERIAL_DEFAULTS.paletteLight,
    'How light or dark the generated colours are',
    { when: isGradientMaterial, agent: false, animatable: false, showIf: { key: 'object.material.paletteMode', equals: 'harmony' } }),
  select('object.material.gradientType', 'Type', [...GRADIENT_TYPES], MATERIAL_DEFAULTS.gradientType, 'Material', undefined,
    { when: isGradientMaterial, agent: false }),
  slider('object.material.gradientYaw', 'Yaw', 0, 360, 1, 'Material', MATERIAL_DEFAULTS.gradientYaw,
    'Ramp direction around the Y axis',
    { when: isGradientMaterial, agent: false, animatable: false, showIf: { key: 'object.material.gradientType', equals: 'linear' } }),
  slider('object.material.gradientPitch', 'Pitch', -90, 90, 1, 'Material', MATERIAL_DEFAULTS.gradientPitch,
    'Ramp direction elevation, up or down',
    { when: isGradientMaterial, agent: false, animatable: false, showIf: { key: 'object.material.gradientType', equals: 'linear' } }),
  slider('object.material.gradientOffset', 'Offset', -1, 1, 0.01, 'Material', MATERIAL_DEFAULTS.gradientOffset,
    'Slides the ramp along its direction', { when: isGradientMaterial, agent: false, animatable: false }),
  slider('object.material.gradientSpread', 'Spread', 0.1, 3, 0.01, 'Material', MATERIAL_DEFAULTS.gradientSpread,
    'Compresses (<1) or stretches (>1) the ramp', { when: isGradientMaterial, agent: false, animatable: false }),
  select('object.material.gradientShading', 'Shading', [...GRADIENT_SHADINGS], MATERIAL_DEFAULTS.gradientShading, 'Material', undefined,
    { when: isGradientPrimitive, agent: false }),

  // Relief invert — the surface's own Invert switch. Was hand-omitted (see this module's
  // "Deliberately NOT in this schema" note, now one item shorter): it is a plain boolean on
  // ReliefSpec, so `switch` models it correctly.
  {
    key: 'object.material.relief.invert', label: 'Invert', kind: 'switch', default: false, group: 'Material',
    when: reliefApplies, agent: false,
  } as SceneControl,

  // Screen finish — print-style dots/lines/cross anchored to the surface, sized by the lit shading.
  select('object.material.screen.pattern', 'Screen', [...SCREEN_PATTERNS], 'none', 'Material',
    'Print-style dots that wrap the object and shrink in shadow',
    { when: screenApplies, optionLabels: ['None', 'Dots', 'Lines', 'Cross'] }),
  slider('object.material.screen.density', 'Screen density', 4, 200, 1, 'Material', MATERIAL_DEFAULTS.screenDensity,
    'How many dots across the surface', { when: screenApplies }),
  slider('object.material.screen.angle', 'Screen angle', 0, 180, 1, 'Material', MATERIAL_DEFAULTS.screenAngle,
    'Rotates the dot grid', { when: screenApplies }),
  slider('object.material.screen.contrast', 'Screen contrast', 0.25, 4, 0.05, 'Material', MATERIAL_DEFAULTS.screenContrast,
    'How fast dots shrink into shadow. Brightness is measured before display gamma, so values around 0.45 spread dots into the midtones', { when: screenApplies }),
  slider('object.material.screen.softness', 'Screen softness', 0, 1, 0.01, 'Material', MATERIAL_DEFAULTS.screenSoftness,
    'Edge blur on each dot', { when: screenApplies }),
  slider('object.material.screen.misregister', 'Misregister', 0, 1, 0.01, 'Material', MATERIAL_DEFAULTS.screenMisregister,
    'Offsets red and blue so edges fringe like a misprint', { when: screenApplies }),
  {
    key: 'object.material.screen.invert', label: 'Invert screen', kind: 'switch', default: false, group: 'Material',
    hint: 'Dark areas get the big dots instead of bright ones', when: screenApplies, agent: false,
  } as SceneControl,
  select('object.material.screen.gap', 'Screen gaps', [...SCREEN_GAPS], 'transparent', 'Material',
    'What shows between the dots — the background, or one colour',
    { when: screenApplies, optionLabels: ['Transparent', 'Colour'] }),
  color('object.material.screen.gapColor', 'Gap colour', MATERIAL_DEFAULTS.screenGapColor, 'Material',
    { when: screenApplies, showIf: { key: 'object.material.screen.gap', equals: 'colour' } }),
  select('object.material.screen.ink', 'Screen ink', [...SCREEN_INKS], 'lit', 'Material',
    "Dot colour: the material's own shading, or one ink",
    { when: screenApplies, optionLabels: ['Lit colour', 'Colour'] }),
  color('object.material.screen.inkColor', 'Ink colour', MATERIAL_DEFAULTS.screenInkColor, 'Material',
    { when: screenApplies, showIf: { key: 'object.material.screen.ink', equals: 'colour' } }),

  // ambientCG texture set — a photographed PBR surface (see lib/scene3d/textures.ts).
  // Physical types only: it binds map/roughnessMap/normalMap/aoMap/metalnessMap, which
  // only the physical pipeline reads. The row itself is bespoke (thumbnail + picker,
  // `ui.material.textureSet` in panelPresentation); this entry is the AGENT's handle and
  // the Collections binding — `text` kind, opted in via aiEditable because the value is a
  // free phrase the apply path resolves server-side (studioTune's resolveTexturePatches).
  {
    key: 'object.material.texture', label: 'Texture', kind: 'text', default: '', group: 'Material',
    aiEditable: true, animatable: false,
    hint: 'A real-world surface from the ambientCG library. Write a plain material word such as wood, brick, marble, concrete, leather, fabric, metal, tiles, grass, or an exact set id. Needs a standard, glass, or opalescent material type.',
    when: hasTextureSet,
  } as SceneControl,
  slider('object.material.textureTiling', 'Texture tiling', TEXTURE_TILING_RANGE.min, TEXTURE_TILING_RANGE.max, TEXTURE_TILING_RANGE.step, 'Material', MATERIAL_DEFAULTS.textureTiling,
    'How many times the surface pattern repeats across the object', { when: hasTextureSet }),

  // --- Image material: how the picture lands on the surface -------------------------
  // Placed BEFORE Fit: projection decides which coordinate is used; fit and tiling then
  // shape it. Derives the texture coordinate from object-space position instead of the
  // mesh's own UV attribute — the real gap on ExtrudeGeometry (text, SVG import) sidewalls
  // and ConvexGeometry (no UV attribute at all).
  select('object.material.imageProjection', 'Wrapping', [...IMAGE_PROJECTIONS], MATERIAL_DEFAULTS.imageProjection, 'Material',
    'How the picture is laid onto the shape. Use the model follows the shape\'s own texture coordinates; the others ignore them and project the picture on from outside, which is what you want on text, imported shapes and anything with poor coordinates',
    {
      when: isImageMaterial,
      optionLabels: ['Use the model', 'Flat', 'Cylinder', 'Sphere', 'Box'],
    }),
  select('object.material.imageProjectionAxis', 'Facing', [...IMAGE_AXES], MATERIAL_DEFAULTS.imageProjectionAxis, 'Material',
    'Which way the flat projection faces, or which axis the cylinder spins around',
    {
      when: isImageMaterial,
      optionLabels: ['X', 'Y', 'Z'],
      showIf: { key: 'object.material.imageProjection', in: ['planar', 'cylindrical'] },
    }),
  slider('object.material.imageBoxBlend', 'Box blend', 0, 1, 0.01, 'Material', MATERIAL_DEFAULTS.imageBoxBlend,
    'How softly the three box faces fade into each other at an edge', {
      when: isImageMaterial,
      showIf: { key: 'object.material.imageProjection', equals: 'box' },
    }),
  select('object.material.imageFit', 'Fit', [...IMAGE_FITS], MATERIAL_DEFAULTS.imageFit, 'Material',
    'How the picture shape is reconciled with the surface: squash it to fit, fill and crop, or fit the whole thing in',
    { when: isImageMaterial, optionLabels: ['Stretch', 'Cover', 'Contain'] }),
  select('object.material.imageWrap', 'Edges', [...IMAGE_WRAPS], MATERIAL_DEFAULTS.imageWrap, 'Material',
    'What happens outside the picture: hold the edge pixel, repeat it, or repeat it mirrored so the seam disappears',
    { when: isImageMaterial, optionLabels: ['Clamp', 'Tile', 'Mirror'] }),
  slider('object.material.imageSeamless', 'Seamless edges', 0, 0.45, 0.01, 'Material', MATERIAL_DEFAULTS.imageSeamless,
    'Blends the picture opposite edges into each other so it tiles with no visible join — only matters once the picture actually repeats, from tiling above one or edges set to tile or mirror', {
      when: isImageMaterial,
    }),
  slider('object.material.imageTiling', 'Tiling', IMAGE_TILING_RANGE.min, IMAGE_TILING_RANGE.max, IMAGE_TILING_RANGE.step,
    'Material', MATERIAL_DEFAULTS.imageTiling,
    'How many times the picture repeats across the surface', { when: isImageMaterial }),
  {
    key: 'object.material.imageTilingLinked', label: 'Link tiling', kind: 'switch',
    default: MATERIAL_DEFAULTS.imageTilingLinked, group: 'Material',
    hint: 'One tiling number drives both directions', when: isImageMaterial,
  } as SceneControl,
  slider('object.material.imageTilingY', 'Vertical tiling', IMAGE_TILING_RANGE.min, IMAGE_TILING_RANGE.max,
    IMAGE_TILING_RANGE.step, 'Material', MATERIAL_DEFAULTS.imageTilingY,
    'How many times the picture repeats top to bottom', {
      when: isImageMaterial,
      showIf: { key: 'object.material.imageTilingLinked', equals: false },
    }),
  slider('object.material.imageOffsetX', 'Horizontal offset', -1, 1, 0.01, 'Material', MATERIAL_DEFAULTS.imageOffsetX,
    'Slides the picture across the surface, in picture widths', { when: isImageMaterial }),
  slider('object.material.imageOffsetY', 'Vertical offset', -1, 1, 0.01, 'Material', MATERIAL_DEFAULTS.imageOffsetY,
    'Slides the picture up and down the surface, in picture heights', { when: isImageMaterial }),
  slider('object.material.imageRotation', 'Rotation', -180, 180, 1, 'Material', MATERIAL_DEFAULTS.imageRotation,
    'Turns the picture about its own middle', { when: isImageMaterial }),
  {
    key: 'object.material.imageFlipX', label: 'Flip horizontally', kind: 'switch',
    default: MATERIAL_DEFAULTS.imageFlipX, group: 'Material',
    hint: 'Mirrors the picture left to right', when: isImageMaterial,
  } as SceneControl,
  {
    key: 'object.material.imageFlipY', label: 'Flip vertically', kind: 'switch',
    default: MATERIAL_DEFAULTS.imageFlipY, group: 'Material',
    hint: 'Mirrors the picture top to bottom', when: isImageMaterial,
  } as SceneControl,
  color('object.material.imageTint', 'Tint', MATERIAL_DEFAULTS.imageTint, 'Material', { when: isImageMaterial }),
  slider('object.material.imageBrightness', 'Brightness', -1, 1, 0.01, 'Material', MATERIAL_DEFAULTS.imageBrightness,
    'Lifts or lowers the whole picture', { when: isImageMaterial }),
  slider('object.material.imageContrast', 'Contrast', 0, 2, 0.01, 'Material', MATERIAL_DEFAULTS.imageContrast,
    'Pushes the light and dark parts of the picture apart', { when: isImageMaterial }),
  slider('object.material.imageSaturation', 'Saturation', 0, 2, 0.01, 'Material', MATERIAL_DEFAULTS.imageSaturation,
    'Drains the picture toward grey, or pushes its colours further', { when: isImageMaterial }),
  slider('object.material.imageGlow', 'Glow', 0, 5, 0.05, 'Material', MATERIAL_DEFAULTS.imageGlow,
    'Makes the picture light itself, like a screen or a sign', {
      when: isImageMaterial,
      showIf: { key: 'object.material.unlit', notEquals: true },
    }),
  {
    key: 'object.material.imageAlpha', label: 'Use image transparency', kind: 'switch',
    default: MATERIAL_DEFAULTS.imageAlpha, group: 'Material',
    hint: 'Honours the see-through parts of the file, such as a PNG with a cut-out background',
    when: isImageMaterial,
  } as SceneControl,
  slider('object.material.imageCutout', 'Cutout', 0, 1, 0.01, 'Material', MATERIAL_DEFAULTS.imageCutout,
    'Anything fainter than this is cut away completely, giving a hard edge instead of a soft blend', {
      when: isImageMaterial,
      showIf: { key: 'object.material.imageAlpha', equals: true },
    }),

  // --- Lighting (doc-level; no active object needed) -------------------------------
  // Simple layer: pick a Look, then nudge three dials. Direction stays visible, so it's
  // the one raw pair that stays ungated even in the simple view.
  // A `look` row: thumbnail + name that opens the Look library picker (RowLook/LookPicker).
  { key: 'lighting.look', label: 'Look', kind: 'look', default: D.lighting.look, group: 'Lighting' } as SceneControl,
  slider('lighting.softness', 'Softness', 0, 1, 0.01, 'Lighting', D.lighting.softness),
  slider('lighting.warmth', 'Warmth', 0, 1, 0.01, 'Lighting', D.lighting.warmth),
  slider('lighting.brightness', 'Brightness', 0.25, 3, 0.05, 'Lighting', D.lighting.brightness),
  slider('lighting.sunAzimuth', 'Light direction', 0, 360, 1, 'Lighting', D.lighting.sunAzimuth,
    'Compass direction the sunlight comes from'),
  slider('lighting.sunElevation', 'Light height', 5, 90, 1, 'Lighting', D.lighting.sunElevation,
    'How high the sun sits above the horizon'),
  { key: 'lighting.advanced', label: 'Advanced lighting', kind: 'switch', default: D.lighting.advanced, group: 'Lighting',
    hint: 'Show the raw shadow preset, environment, sun intensity, and ambient controls' } as SceneControl,
  // Raw controls kept behind Advanced — nothing is removed, they just gain a `when` gate.
  select('lighting.preset', 'Shadow preset', [...LIGHTING_PRESETS], D.lighting.preset, 'Lighting', undefined,
    { when: (doc: SceneDoc) => !!doc.lighting.advanced }),
  select('lighting.environment', 'Environment', [...ENVIRONMENT_KINDS], D.lighting.environment, 'Lighting', undefined,
    { when: (doc: SceneDoc) => !!doc.lighting.advanced }),
  slider('lighting.sunIntensity', 'Sun intensity', 0, 3, 0.05, 'Lighting', D.lighting.sunIntensity,
    'How bright the main sunlight is', { when: (doc: SceneDoc) => !!doc.lighting.advanced }),
  slider('lighting.ambient', 'Ambient', 0, 2, 0.05, 'Lighting', D.lighting.ambient,
    'Soft fill light that lifts the shadows', { when: (doc: SceneDoc) => !!doc.lighting.advanced }),
  // Granular shaping of the `colorGels` world — shown only when it's the live environment.
  // ALL of these are inspector-only: editing any re-bakes the env (see engine.buildEnvironment),
  // so none may be animatable (a per-frame PMREM rebuild), and they're not part of the agent's
  // documented lighting surface. `GEL` carries that gate + those two flags for every row.
  ...(() => {
    const when = (doc: SceneDoc) => doc.lighting.environment === 'colorGels'
    const GEL = { when, agent: false, animatable: false } as const
    const L = D.lighting
    return [
      // Gel A
      color('lighting.gelColorA', 'Gel A colour', L.gelColorA, 'Lighting', GEL),
      slider('lighting.gelBrightnessA', 'Gel A brightness', 0, 20, 0.5, 'Lighting', L.gelBrightnessA,
        'How bright the first panel glows', GEL),
      slider('lighting.gelSizeA', 'Gel A size', 0.2, 3, 0.05, 'Lighting', L.gelSizeA,
        'Panel size — small hard streak to broad soft wash', GEL),
      slider('lighting.gelAzimuthA', 'Gel A angle', -180, 180, 1, 'Lighting', L.gelAzimuthA,
        'Where it sits around the object (0° = front)', GEL),
      slider('lighting.gelHeightA', 'Gel A height', -6, 8, 0.1, 'Lighting', L.gelHeightA,
        'How high the panel sits', GEL),
      slider('lighting.gelDistanceA', 'Gel A distance', 1, 10, 0.1, 'Lighting', L.gelDistanceA,
        'How far the panel is from the object', GEL),
      // Gel B
      color('lighting.gelColorB', 'Gel B colour', L.gelColorB, 'Lighting', GEL),
      slider('lighting.gelBrightnessB', 'Gel B brightness', 0, 20, 0.5, 'Lighting', L.gelBrightnessB,
        'How bright the second panel glows', GEL),
      slider('lighting.gelSizeB', 'Gel B size', 0.2, 3, 0.05, 'Lighting', L.gelSizeB,
        'Panel size — small hard streak to broad soft wash', GEL),
      slider('lighting.gelAzimuthB', 'Gel B angle', -180, 180, 1, 'Lighting', L.gelAzimuthB,
        'Where it sits around the object (0° = front)', GEL),
      slider('lighting.gelHeightB', 'Gel B height', -6, 8, 0.1, 'Lighting', L.gelHeightB,
        'How high the panel sits', GEL),
      slider('lighting.gelDistanceB', 'Gel B distance', 1, 10, 0.1, 'Lighting', L.gelDistanceB,
        'How far the panel is from the object', GEL),
      // Rim strip
      { key: 'lighting.gelRim', label: 'Rim light', kind: 'switch', default: L.gelRim, group: 'Lighting',
        hint: 'The bright accent strip along the top', ...GEL } as SceneControl,
      color('lighting.gelRimColor', 'Rim colour', L.gelRimColor, 'Lighting', GEL),
      slider('lighting.gelRimBrightness', 'Rim brightness', 0, 15, 0.5, 'Lighting', L.gelRimBrightness,
        'How bright the top accent strip glows', GEL),
      // Whole-world
      slider('lighting.gelSoftness', 'Reflection softness', 0, 1, 0.01, 'Lighting', L.gelSoftness,
        'Sharp mirror reflections to a diffuse sheen', GEL),
      color('lighting.gelBackground', 'Backdrop tint', L.gelBackground, 'Lighting', GEL),
      slider('lighting.gelExposure', 'Exposure', 0, 3, 0.05, 'Lighting', L.gelExposure,
        'Master brightness over the whole gel world', GEL),
    ]
  })(),

  // --- Camera (doc-level) -----------------------------------------------------------
  slider('camera.fov', 'Field of view', 15, 100, 1, 'Camera', D.camera.fov,
    'Camera field of view — how wide the lens sees'),

  // --- Background (doc-level) -------------------------------------------------------
  // `background` itself (colour/transparent) stays a bespoke row — see this module's
  // doc for why (a stateful proxy, not a plain doc leaf). `showFloor` IS one: a plain
  // boolean on SceneDoc (config.ts), so it joins here as a switch.
  {
    key: 'showFloor', label: 'Floor', kind: 'switch', default: D.showFloor, group: 'Background',
    hint: 'Grid + shadow-catcher ground — off gives a clean floating look',
  } as SceneControl,

  // --- Post (doc-level; derived from the shared manifest, not hand-declared) -------
  // Includes ambient occlusion (gtao needs a depth buffer — `three-depth` is the only
  // host that asks for it) plus every other shared effect (bloom/color/duotone/chroma/
  // blur/film/halftone/dotScreen/glitch/grain/vignette), each with its own `switch`
  // enable now that the agent/inspector read from this manifest instead of a hand-list.
  ...postControls({ host: 'three-depth' }),

  // --- Transform (prefix object.) ---------------------------------------------------
  // NOT animatable: Scene3D's existing ObjectMotion preset system (app/lib/scene3d/
  // motion/) already owns transforms, composing per-frame deltas onto the home
  // transform read at bake time. A second system (motion tracks driven off THIS
  // schema) writing the same position/rotation/scale would fight it. Ranges are
  // intentionally generous (not per-object) since this is a general-purpose control,
  // not a per-primitive-kind one. Rotation is stored in radians (SceneObjectBase.
  // rotation), NOT the degrees the Selection UI displays — the UI's rotX/rotY/rotZ
  // computed props convert at the edge; this schema addresses the underlying radian
  // value makeConfigParams writes straight through.
  //
  // Keys use numeric array indices (e.g., `object.position.0` not `.x`) because
  // Vec3 is a plain array `[number, number, number]` with no `.x/.y/.z` properties.
  // The path resolver (lib/studio/path.ts) reads these via `o[k]` which works for
  // numeric string keys on arrays. Labels stay human-readable ("Position X", etc.);
  // keys are dotted paths addressing the data, nothing else.
  //
  // SOFT RANGE (`entry: 'unclamped'`), and it is what makes the inspector's Transform
  // card safe to draw from this schema at all. The ranges above are DESCRIPTIVE — the
  // gizmo puts an object at x = 35 every day, and the number grid these rows replaced
  // accepted anything. A hard-range row would have shown "35.0" and then rewritten it to
  // 20 on one arrow press, fanning the −15 difference across the whole selection via
  // `axisDeltaWrites`. That is exactly why the first migration was reverted (e954626f9).
  // The flag is presentation only: it is stripped from every derived agent vocabulary.
  slider('object.position.0', 'Position X', -20, 20, 0.1, 'Transform', 0, undefined, { animatable: false, entry: 'unclamped' }),
  slider('object.position.1', 'Position Y', -20, 20, 0.1, 'Transform', 0, undefined, { animatable: false, entry: 'unclamped' }),
  slider('object.position.2', 'Position Z', -20, 20, 0.1, 'Transform', 0, undefined, { animatable: false, entry: 'unclamped' }),
  slider('object.rotation.0', 'Rotation X', -Math.PI, Math.PI, 0.01, 'Transform', 0, 'Radians', { animatable: false, entry: 'unclamped' }),
  slider('object.rotation.1', 'Rotation Y', -Math.PI, Math.PI, 0.01, 'Transform', 0, 'Radians', { animatable: false, entry: 'unclamped' }),
  slider('object.rotation.2', 'Rotation Z', -Math.PI, Math.PI, 0.01, 'Transform', 0, 'Radians', { animatable: false, entry: 'unclamped' }),
  slider('object.scale.0', 'Scale X', 0.05, 10, 0.05, 'Transform', 1, undefined, { animatable: false, entry: 'unclamped' }),
  slider('object.scale.1', 'Scale Y', 0.05, 10, 0.05, 'Transform', 1, undefined, { animatable: false, entry: 'unclamped' }),
  slider('object.scale.2', 'Scale Z', 0.05, 10, 0.05, 'Transform', 1, undefined, { animatable: false, entry: 'unclamped' }),

  // --- Geometry (prefix object.params. / object.modifiers.) -------------------------
  // Derived, not hand-listed — see the two functions' own docs. The panel splits this
  // ONE schema group into three cards (Geometry / Modifiers / Cloner), exactly as
  // Material's five sub-blocks come out of the single 'Material' group.
  ...geometryParamControls(),
  ...modifierControls(),

  // --- Light (prefix object., flat on LightObject) ----------------------------------
  color('object.color', 'Color', LIGHT_DEFAULTS.color, 'Light', { when: isLight, ...INSPECTOR_ONLY }),
  // The ceiling is the ONE bound the template computed per light kind
  // (`lightIntensityMaxValue`): point/spot are physical (candela, inverse-square) and run
  // to 600, an area panel to 60. Declared at the point/spot ceiling — the wider of the
  // two, so the declaration contains every reachable value — and narrowed to the SELECTED
  // light's own maximum by panelPresentation.
  slider('object.intensity', 'Intensity', 0, lightIntensityMax('point'), 1, 'Light', LIGHT_DEFAULTS.intensity,
    'Brightness of this light — point/spot use physical falloff, so they scale much higher',
    { when: isLight, ...INSPECTOR_ONLY }),
  slider('object.distance', 'Distance', 0, 30, 0.5, 'Light', LIGHT_DEFAULTS.distance,
    'How far the light reaches — 0 means infinite', { when: isPointOrSpot, ...INSPECTOR_ONLY }),
  slider('object.decay', 'Decay', 0, 3, 0.1, 'Light', LIGHT_DEFAULTS.decay,
    'How quickly the light fades over distance', { when: isPointOrSpot, ...INSPECTOR_ONLY }),
  {
    key: 'object.castShadow', label: 'Cast shadow', kind: 'switch', default: LIGHT_DEFAULTS.castShadow,
    group: 'Light', when: isPointOrSpot, ...INSPECTOR_ONLY,
  } as SceneControl,
  slider('object.angle', 'Angle', 0.05, 1.4, 0.01, 'Light', LIGHT_DEFAULTS.angle,
    'Cone half-angle of the spot beam', { when: isSpotLight, ...INSPECTOR_ONLY }),
  slider('object.penumbra', 'Penumbra', 0, 1, 0.05, 'Light', LIGHT_DEFAULTS.penumbra,
    "Softness of the spot beam's edge", { when: isSpotLight, ...INSPECTOR_ONLY }),
  slider('object.width', 'Width', 0.2, 10, 0.1, 'Light', LIGHT_DEFAULTS.width,
    'Width of the area light panel', { when: isRectLight, ...INSPECTOR_ONLY }),
  slider('object.height', 'Height', 0.2, 10, 0.1, 'Light', LIGHT_DEFAULTS.height,
    'Height of the area light panel', { when: isRectLight, ...INSPECTOR_ONLY }),

  // --- Decal (prefix object., flat on DecalObject) ----------------------------------
  // `spin` is RADIANS on disk (the engine feeds it straight to the projector) and was
  // ALWAYS edited in degrees, exactly like `object.rotation.*` above: the schema
  // addresses the stored radian value, and the panel's own override rescales the row to
  // −180..180. `depth` is captioned "Wrap" in the inspector — it is the projection box's
  // depth, i.e. how far the sticker wraps around curvature.
  color('object.content.color', 'Color', DECAL_DEFAULTS.color, 'Decal', { when: isTextDecal, ...INSPECTOR_ONLY }),
  slider('object.size', 'Size', 0.05, 3, 0.01, 'Decal', DECAL_DEFAULTS.size,
    'Sticker width on the surface', { when: isDecal, ...INSPECTOR_ONLY }),
  slider('object.spin', 'Spin', -Math.PI, Math.PI, 0.01, 'Decal', DECAL_DEFAULTS.spin,
    'Rotation around the surface normal', { when: isDecal, ...INSPECTOR_ONLY }),
  slider('object.depth', 'Wrap', 0.05, 2, 0.01, 'Decal', DECAL_DEFAULTS.depth,
    'How far the sticker wraps around curved surfaces', { when: isDecal, ...INSPECTOR_ONLY }),
  slider('object.opacity', 'Opacity', 0, 1, 0.01, 'Decal', DECAL_DEFAULTS.opacity,
    'How solid the sticker sits on the surface', { when: isDecal, ...INSPECTOR_ONLY }),
  select('object.blend', 'Blend', [...DECAL_BLENDS], DECAL_DEFAULTS.blend, 'Decal',
    'How the sticker mixes with the surface beneath',
    { when: isDecal, optionLabels: ['Normal', 'Add (glow)', 'Multiply (ink)', 'Screen', 'Darken', 'Lighten'], ...INSPECTOR_ONLY }),
]

/** Controls applicable to `doc`/`obj`, in SCENE_SECTIONS order — the single gate
 *  everything downstream (agent vocabulary, Collection binding UI, motion targets)
 *  derives from. `obj` is the active/selected SceneObject, if any. */
export function visibleSceneControls(doc: SceneDoc, obj?: SceneObject): SceneControl[] {
  const out: SceneControl[] = []
  for (const section of SCENE_SECTIONS) {
    for (const c of SCENE_CONTROLS) {
      if (c.group !== section) continue
      if (c.when && !c.when(doc, obj)) continue
      out.push(c)
    }
  }
  return out
}
