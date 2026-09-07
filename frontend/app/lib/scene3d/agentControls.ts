import type { ControlSpec } from '~/lib/spacetype/effect'
import { getEffectSync } from '~/lib/shaderfx/catalog'
import { derivedShaderFillControls, shaderFillControls } from '~/lib/shaderfill/controls'
import { SCENE_CONTROLS, visibleSceneControls, type SceneControl } from './controls'
import { MACRO_PRIMITIVE_KINDS, MACRO_NONE, type SceneDoc, type SceneObject, type PrimitiveObject } from './config'
import { isTreatmentHost, treatmentsOf, TREATMENT_LABELS, type Treatment } from '~/lib/scene3d/treatments'
import { treatmentControls, treatmentField } from '~/lib/scene3d/treatmentControls'

/** Strip the schema-only fields (`when`/`agent`/`animatable`/`summary`/`bindable`/
 *  `entry`/`optionLabels`) a `SceneControl` may carry, and drop anything explicitly
 *  withheld from the agent. Mirrors shapefx/agentControls.ts and vectortype/agentControls.ts
 *  exactly. `bindable` is stripped even though nothing in SCENE_CONTROLS sets it false today — a
 *  future `bindable: false` scene entry (effect.ts's schema-level twin of a hand-panel's
 *  `:bindable="false"` row) must not leak into agent vocabulary just because this
 *  strip forgot about it. `entry` (the soft-range opt-in the nine Transform rows carry)
 *  is stripped for exactly the same reason: it tells a ROW how to parse a keystroke and
 *  says nothing to a model, so the vocabulary must not shift when a row opts in.
 *  `optionLabels` (Task 3's select display-text) is stripped for the same reason again —
 *  the Relief source row now carries None/Effect/Image, and the model must still be
 *  offered and write the raw none/shader/image values. */
function stripMeta(specs: ControlSpec[]): ControlSpec[] {
  return specs
    .filter((c) => (c as any).agent !== false)
    .map(({ when, agent, animatable, summary, bindable, entry, optionLabels, ...spec }: any) => spec as ControlSpec)
}

export const OBJECT_PREFIX = 'object.'

/** Where a Scene3D object's shader-fill `ShaderSpec` lives, relative to the active
 *  object. Exported so the surface's shader-fill editor and this vocabulary cannot
 *  drift — mirrors `vectortype/agentControls.ts`'s `VT_LAYER_SHADER_PREFIX`. */
export const OBJECT_SHADER_PREFIX = 'object.material.shader'

/**
 * The `object.*` vocabulary expanded to one ABSOLUTE, ID-ADDRESSED control per
 * scene object — `objects.<id>.material.roughness`, labelled `Sphere · Roughness`.
 *
 * ## Why this exists: the agent could not name an object
 *
 * `object.*` means "the ACTIVE/selected object", and headlessly (a Collection sweep
 * row, a batch render, an agent turn with no live selection) there IS no active
 * object. Even with a selection, "make the sphere rougher" while a light is selected
 * would either write nowhere or, worse, write onto the wrong object. Naming the
 * object fixes both: the same `when(doc, obj)` gate `controls.ts` already declares
 * still runs, but it is asked about EACH object in turn, so a scene with a light and
 * two primitives offers material controls for exactly the two primitives, each under
 * its own name — a material control never dangles off a light.
 *
 * This is also why `SceneControl.when` takes `obj` as a second argument at all:
 * `controls.ts`'s `visibleSceneControls(doc, obj)` only ever evaluates it against
 * ONE object (the current selection), but this function must evaluate it against
 * EVERY object in the scene to know which ones the key legitimately reaches.
 *
 * ## By id, not by index
 *
 * These keys are persisted — a Collection binding stores `params.<key>` — so an
 * index would re-point on reorder and a binding to a deleted object would resolve to
 * whichever object took its slot. `makeConfigParams`/the path resolver refuses an
 * unknown id (see `vectortype/agentControls.ts:78-89`'s identical argument), so a
 * stale key reads `undefined` and writes nothing rather than landing on the wrong
 * object.
 *
 * An object whose id is missing, empty, contains a `.`, or is all digits is SKIPPED
 * rather than addressed positionally: an agent key is a promise about which object
 * it edits, and a positional one cannot keep it. Scene3D's own ids
 * (`config.ts`'s `newId()`) never collide with this refusal — `obj_<uuid>_<n>` is
 * never empty, dotted, or all-digit — so in practice nothing a real document
 * produces is ever skipped; this only guards a hand-edited or malformed `scene_state`.
 */
/**
 * The id-safety + per-object `when` expansion every `object.`-prefixed consumer needs,
 * factored out so it exists in exactly ONE place. `sceneStackControls` (below) and
 * `animatableTargets` (`motion/targets.ts`, Task 4's motion-track vocabulary) both build
 * their output by calling this rather than re-deriving the id-safety refusal a second time —
 * see this module's own doc for why a missing/empty/dotted/all-digit id must be skipped
 * rather than addressed positionally.
 *
 * `visit` receives the control UNSTRIPPED (still carrying `when`/`agent`/`animatable`/
 * `summary`) — callers that need the agent-facing shape strip it themselves, same as
 * `sceneStackControls` always has; a motion consumer needs `animatable` precisely because
 * `sceneStackControls` would otherwise strip it.
 */
export function iterateObjectControls(
  doc: SceneDoc,
  visit: (control: SceneControl, obj: SceneObject, id: string) => void,
): void {
  const objects = Array.isArray(doc?.objects) ? doc.objects : []
  for (const c of SCENE_CONTROLS) {
    if (!c.key.startsWith(OBJECT_PREFIX)) continue
    for (const obj of objects) {
      const id = obj?.id
      if (typeof id !== 'string' || id === '' || id.includes('.') || /^\d+$/.test(id)) continue
      if (c.when && !c.when(doc, obj)) continue
      visit(c, obj, id)
    }
  }
}

/** "Blur amount" / "Rim light colour": the kind's human label + the row label lowercased. */
function treatmentRowLabel(kind: Treatment['kind'], rowLabel: string): string {
  return `${TREATMENT_LABELS[kind]} ${rowLabel.charAt(0).toLowerCase()}${rowLabel.slice(1)}`
}

/**
 * The treatment counterpart of `iterateObjectControls`: one RELATIVE control per
 * (object, treatment, inspector row), keyed `object.treatments.<treatmentId>.<field>`.
 * Same id-safety refusal on the OBJECT id; treatment ids are already refused at parse time
 * (treatments.ts's parseTreatment drops empty/dotted/all-digit ids), so nothing here can
 * emit a path the nested-id resolvers would misread.
 */
export function iterateTreatmentControls(
  doc: SceneDoc,
  visit: (control: SceneControl, obj: SceneObject, id: string, treatment: Treatment) => void,
): void {
  const objects = Array.isArray(doc?.objects) ? doc.objects : []
  for (const obj of objects) {
    const id = obj?.id
    if (typeof id !== 'string' || id === '' || id.includes('.') || /^\d+$/.test(id)) continue
    // Only primitives and GLBs host treatments (treatments.ts's own rule). A light or group
    // carrying a stray `treatments` array — a hand-edited scene_state, or a doc written before
    // the field was gated — must not mint controls the renderer will never honour.
    if (!isTreatmentHost(obj)) continue
    for (const t of treatmentsOf(obj)) {
      for (const c of treatmentControls(t.kind)) {
        visit({
          ...c,
          key: `${OBJECT_PREFIX}treatments.${t.id}.${treatmentField(c.key)}`,
          label: treatmentRowLabel(t.kind, c.label),
        } as SceneControl, obj, id, t)
      }
    }
  }
}

export function sceneStackControls(doc: SceneDoc): ControlSpec[] {
  const out: ControlSpec[] = []
  iterateObjectControls(doc, (c, obj, id) => {
    if ((c as { agent?: boolean }).agent === false) return
    const rest = c.key.slice(OBJECT_PREFIX.length)
    const { when, agent, animatable, summary, bindable, entry, optionLabels, ...spec } = c as any
    out.push({ ...spec, key: `objects.${id}.${rest}`, label: `${obj.name || 'Object'} · ${c.label}` } as ControlSpec)
  })
  // Deliberately NOT gated on `showIf` (unlike motion/targets.ts's animatableTargets,
  // which now evaluates it against the live treatment): the progressive-blur ramp rows
  // (rampSpace/rampAngle/rampStart/rampEnd) must stay in the agent's vocabulary even
  // while `progressive` is false, so a single patch can turn Progressive on AND set the
  // ramp in one turn. A vocabulary that appeared/disappeared with document state would
  // make that impossible — the model would have to write `progressive: true` first,
  // read back the (now-changed) control list, then write the ramp in a second turn.
  iterateTreatmentControls(doc, (c, obj, id) => {
    if ((c as { agent?: boolean }).agent === false) return
    const rest = c.key.slice(OBJECT_PREFIX.length)
    const { when, agent, animatable, summary, bindable, entry, optionLabels, ...spec } = c as any
    out.push({ ...spec, key: `objects.${id}.${rest}`, label: `${obj.name || 'Object'} · ${c.label}` } as ControlSpec)
  })
  return out
}

/**
 * Scene3D's tune vocabulary for the in-product agent, derived from SCENE_CONTROLS
 * rather than hand-listed. `activeObj` is the current selection, if any — mirroring
 * `visibleSceneControls`'s own gating so the agent is never offered a knob the user
 * cannot see on the currently-selected object.
 *
 * Ships BOTH namespaces, and they are not interchangeable:
 *   - the relative `object.*`/doc-level keys follow the current selection
 *     ("make *this* one rougher");
 *   - the absolute `objects.<id>.*` keys from `sceneStackControls` name a specific
 *     object outright ("make the sphere rougher"), reachable even with nothing
 *     selected.
 *
 * ## The shader-fill branch is NOT free — it has to be written out
 *
 * `visibleSceneControls` can only ever return members of SCENE_CONTROLS, and
 * SCENE_CONTROLS declares no `object.material.shader.*` key at all (the shader
 * vocabulary lives in the shared `~/lib/shaderfill/controls.ts`, so host studios
 * don't each keep a copy — see controls.ts's own module doc). So when the active
 * object's material type is `shaderFill`, this appends the three declared keys
 * (`shaderFillControls(OBJECT_SHADER_PREFIX)`) plus the active effect's own params,
 * mirroring `shapefx/agentControls.ts:33-41` and `vectortype/agentControls.ts:124-136`
 * line for line. The per-effect params are appended only when the shader-fx catalog
 * has ALREADY resolved that effect id (`getEffectSync`, never a fetch) — if nothing
 * on the page has fetched the catalog yet, they are simply absent this call, the same
 * graceful degradation the other two studios accept for the same reason.
 *
 * This branch is deliberately NOT mirrored into `sceneStackControls`/
 * `sceneBindableControls`: naming a shader-fill object's effect params by id would
 * need a live catalog read per OBJECT rather than per active selection, and Vector
 * Type's own `vtStackControls`/`vtBindableControls` make the identical choice not to
 * expand shader-fill for a NAMED (non-active) layer. Follow-on work if a named
 * shader-fill object turns out to be needed.
 */
export function sceneAgentControls(doc: SceneDoc, activeObj?: SceneObject): ControlSpec[] {
  const out: ControlSpec[] = [
    ...stripMeta(visibleSceneControls(doc, activeObj)),
    ...sceneStackControls(doc),
  ]
  const material = activeObj && activeObj.kind !== 'light' ? activeObj.material : undefined
  if (material?.type === 'shaderFill' && material.shader) {
    out.push(...stripMeta(shaderFillControls(OBJECT_SHADER_PREFIX)))
    const effectDef = getEffectSync(material.shader.effectId)
    if (effectDef) out.push(...derivedShaderFillControls(effectDef, OBJECT_SHADER_PREFIX))
  }
  return out
}

/**
 * The macro key. NOT a config path — `runParamPatch` intercepts it, adds the
 * primitive through the studio's own `addOrTargetPrimitive` seam and deletes the
 * key before any write-through, exactly as it does Gradient's `preset` and
 * Shader's `effect`. Anything that maps this vocabulary onto real config leaves
 * (the Collections bind menu, via `sceneBindableControls`) must NOT offer it:
 * bound to a column it would write a dead `doc.primitive` property on every
 * sweep row.
 */
export const SCENE_PRIMITIVE_MACRO_KEY = 'primitive'

/**
 * Build the `primitive` macro control over the PLACEABLE kinds — the same list
 * the studio's own add menu enumerates, derived from PRIMITIVE_KINDS minus
 * NOT_PLACEABLE_KINDS so the two can never drift.
 *
 * This is what makes a FRESH node tunable at all: `defaultDoc()` has
 * `objects: []`, so without it the vocabulary is doc-level lighting and nothing
 * else, and "a 3d iridescent diamond" has no object to be iridescent.
 */
export function scenePrimitiveMacro(doc: SceneDoc): ControlSpec {
  const current = doc.objects.find((o): o is PrimitiveObject => o.kind === 'primitive')
  return {
    key: SCENE_PRIMITIVE_MACRO_KEY,
    label: 'Primitive',
    kind: 'select',
    options: [...MACRO_PRIMITIVE_KINDS],
    // An EMPTY scene must read as empty. Falling back to the first option told
    // the model a box was already there — and paired with the "already in the
    // scene is TARGETED" hint below, that is an invitation to skip the macro,
    // which lands straight back on the reported bug. MACRO_NONE is display-only:
    // it is absent from `options`, and validatePatch keeps a select value only
    // when options contains it, so it can never be submitted back.
    default: current?.primitive ?? MACRO_NONE,
    group: 'Object',
    hint: `Put a shape in the scene. Set this FIRST when the scene has no object yet (the current value reads "${MACRO_NONE}"), or when the ask names a shape that is not there; then address it with the object.* keys in the same patch. A kind already in the scene is TARGETED, not duplicated. This only ADDS — it never converts an existing object to another kind.`,
  }
}

/**
 * The vocabulary a COLLECTION BINDING may be made against.
 *
 * `sceneAgentControls` minus the relative `object.*` keys, plus the same
 * `sceneStackControls` expansion. The difference is not cosmetic:
 *
 *   an agent patch is applied ONCE, in the moment, against the object the user is
 *   looking at — `object.material.roughness` is exactly right for it;
 *
 *   a Collection binding is PERSISTED and re-resolved on every sweep row, every
 *   preview and every batch render, almost always with NO live selection at all.
 *   `params.object.material.roughness` would mean "whichever object happens to be
 *   selected then" — undefined outside the editor, and even inside it, a different
 *   object depending on where the user last clicked. So the bindable list names its
 *   object: `params.objects.<id>.material.roughness`. When that object is deleted
 *   the key is simply no longer in this list, and the binding degrades to IGNORED
 *   rather than landing on whatever object took its slot — see `sceneStackControls`'s
 *   doc and `vectortype/agentControls.ts:141-161`'s identical argument.
 *
 * Doc-level groups (Lighting/Camera/Post) need no object at all, so they pass
 * through unchanged — only the `object.*`-prefixed keys are relative.
 */
export function sceneBindableControls(doc: SceneDoc): ControlSpec[] {
  return [
    ...stripMeta(visibleSceneControls(doc)).filter((c) => !c.key.startsWith(OBJECT_PREFIX)),
    // Treatment rows are `bindable: false` by contract, but `sceneStackControls` strips that
    // flag (like every other schema-only field) before the bind menu ever sees it — so the
    // refusal has to be re-stated here, by key, or a Collection column could bind a dial that
    // the treatment editor owns.
    ...sceneStackControls(doc).filter((c) => !c.key.includes('.treatments.')),
  ]
}

/**
 * Domain guidance injected into the /api/vibe prompt. Co-located here (rather than
 * in controls.ts, unlike VT_GUIDANCE/SHAPE_GUIDANCE) because this task's scope is
 * this file alone — controls.ts is Task 1's file and carries no guidance constant
 * yet; a future pass can hoist this alongside it if Scene3D ever needs the split.
 */
export const SCENE_GUIDANCE = `This is a 3D SCENE COMPOSITOR — primitives, GLBs and lights arranged in space and lit, not a flat 2D generator.

OBJECT vs SCENE: most controls edit ONE OBJECT (material, transform) and are addressed two ways.
- \`object.*\` follows the CURRENT SELECTION — reach for it when the user says "this", "it", or is clearly talking about whatever is selected ("make it rougher", "move it up").
- \`objects.<id>.*\` NAMES an object outright by its own id, labelled with the object's name in the control list ("Sphere · Roughness", "Torus · Position X") — reach for this when the user names an object ("make the sphere rougher", "move the torus back") or when several objects need different treatment in one turn. Never invent an id; only use one that appears in the control list you were given.
Doc-level groups — Lighting, Camera, Post — apply to the whole scene and need no object at all.

MATERIAL: \`object.material.type\` picks the shading model (standard/phong/toon/matcap/glass/fresnel/gradient/opalescent/holographic/image/shaderFill); most of the other material sliders only apply to SOME types and are withheld from the control list otherwise (roughness/metalness need a PBR type, clearcoat/sheen/transmission need standard or glass, shininess/specular are phong-only, opalHueShift/opalFrequency/opalAngleMix/opalFlowSpeed/opalStrength are opalescent-only, holoStrength/holoBands/holoAngle/holoFlakes/holoFlakeSize/holoGloss/holoHueShift are holographic-only) — never set a control that isn't offered for the object's current type. \`object.material.color\` is the base colour on standard/glass/phong/toon/fresnel, the lit substrate tint under an opalescent material and the metal tint under a holographic one; the other types derive colour a different way (matcap id, gradient ramp, image, shader) and ignore it. OPALESCENT is the thin-film look — a rainbow that flows across the surface with viewing angle: its spectrum comes from the same gradient-stop ramp, then opalHueShift rotates it, opalFrequency sets how many bands wrap the form, opalAngleMix blends shape-driven ↔ view-driven flow, opalFlowSpeed animates it over time (0 = still), and opalStrength fades the rainbow over the base colour. Opalescent also takes the glossy-coat knobs — clearcoat / clearcoatRoughness / envMapIntensity (shared with standard/glass) — plus metalness: clearcoat 0 is a matte soap-bubble, and raising clearcoat + reflection + metalness with low roughness turns it into a wet chrome-holo.
HOLOGRAPHIC FOIL: \`object.material.type\` = 'holographic' is the rainbow-diffraction foil of stickers, laminated packaging and chrome-holo nail polish — a bright METAL base (metalness is always 1, so there is no metalness or roughness row) with a rainbow streak that sweeps across it as the light or the camera moves. holoStrength is how bright the streak glows (0 leaves a clean metal, up to 2 for a blown-out glow), holoBands how many rainbow repeats fit in one sweep (fine foil is high), holoAngle turns the direction the streak runs in (degrees), holoFlakes breaks the clean foil into randomly turned glitter flakes (0 = clean linear foil, 1 = full glitter) and holoFlakeSize sizes those flakes, holoGloss goes from brushed (0) to polished mirror (1), holoHueShift rotates the whole rainbow. It takes the same coat knobs as opalescent (clearcoat is the sticker's laminate, envMapIntensity its reflection) and \`object.material.color\` tints the metal.

ADDING A SHAPE — the \`primitive\` MACRO: \`primitive\` is a VERB, not a stored value. Set it to put a shape in the scene (gem, box, sphere, torus…), then address that shape with the RELATIVE \`object.*\` keys in the SAME patch — you cannot know its \`objects.<id>.\` name, because it does not exist until the macro runs. Set it FIRST whenever the scene is empty, or when the ask names a shape that is not in it. A kind already present is TARGETED, never duplicated, so re-sending it is safe and preserves that object's tuning. It only ADDS — it never converts an existing object into another kind (no control changes an object's kind), so "turn the box into a gem" adds a gem and leaves the box; say so rather than implying the box changed. When several objects share a kind, the FIRST in the scene is the one addressed.
NO 3D TEXT FROM HERE: \`text\` is not offered, because the words themselves are not a control — a text solid added this way would read "Text" forever. For 3D lettering, say the 3D Studio needs to be opened to type the word; do not substitute a shape for it.

GEM / IRIDESCENT RECIPE: "iridescent", "opalescent", "opal", "oil-slick", "soap bubble" and "rainbow sheen" all mean ONE thing — \`object.material.type\` = 'opalescent'. "holographic", "holo", "holographic foil", "holographic sticker", "glitter foil" and "chrome holo" mean the OTHER rainbow — \`object.material.type\` = 'holographic' (a metal foil with a light-driven streak; add holoFlakes for glitter). Never answer any of those words with a gradient material or a plain colour change. A gem/diamond ask is \`primitive\` = 'gem' plus the opalescent material, low \`roughness\`, high \`clearcoat\`, and \`lighting.environment\` = 'darkStrips', whose bright bars are what make facets read. The gem's CUT is geometry, not material: \`object.params.points\` (more points = more, smaller facets), \`spread\` (wider stone) and \`depth\` (flat cut-gem slab ↔ chunky stone) — a "sharper cut" / "more brilliant" ask is those.
WORKED EXAMPLE — "a 3d iridescent diamond" on an empty scene: {"primitive":"gem", "object.material.type":"opalescent", "object.material.opalStrength":0.9, "object.material.clearcoat":1, "object.material.roughness":0.05, "object.params.points":24, "lighting.environment":"darkStrips"}.
WORKED EXAMPLE — "a glitter holographic sphere" on an empty scene: {"primitive":"sphere", "object.material.type":"holographic", "object.material.holoFlakes":0.8}.

RELIEF NEEDS LIGHT: \`object.material.relief.*\` is a bump/height field that perturbs how the surface catches light — it is INVISIBLE on a flat-shaded or unlit material (an unlit shaderFill has no lighting response at all, so relief there does nothing). Reach for relief only once the material is a lit type (standard/glass/phong/etc, or a shaderFill with unlit off), and pair \`relief.scale\` (how raised the detail looks) with \`relief.contrast\` (how much it catches the light) — a flat-looking relief usually needs MORE contrast, not more scale.

SURFACE TEXTURES: \`object.material.texture\` takes a plain material word (wood, brick, marble, concrete, leather, fabric, metal, tiles, grass, sand, rock, plaster) or an exact set id and dresses the object in a real photographed PBR surface — colour, roughness, normal and relief together. It needs a lit PBR type (standard, glass, opalescent). When the ask names a material by what it is MADE OF ("a wooden box", "a brick wall", "a marble sphere"), reach for this rather than a flat colour. Pair with \`object.material.textureTiling\` when the pattern should repeat more or less across the object.
WORKED EXAMPLE — "a wooden box" on an empty scene: {"primitive":"box", "object.material.type":"standard", "object.material.texture":"wood", "object.material.roughness":0.8}.

SCREEN FINISH: \`object.material.screen.pattern\` ('dots' / 'lines' / 'cross') lays a print-style screen over ANY material except glass — the dots wrap the object's surface and shrink into its shadows, so the shading becomes dot density. "halftone", "dot screen", "print dots", "engraved lines", "risograph sphere", "die doing", "dots that wrap the object", "dissolves into the background" all mean this. Pair it with \`screen.density\` (40–80 reads as print), \`screen.misregister\` (0.3–0.6 gives the red/blue misprint fringe) and an \`opalescent\` material underneath for colour — its \`opalStrength\` IS reachable from here, whereas the gradient material's stop colours are not agent-writable today; gaps are transparent by default so the background shows through — set \`screen.gap\` = 'colour' + \`screen.gapColor\` for paper. Contrast with the post-stack \`post.dotScreen\`, which screens the WHOLE picture flat: reach for \`screen\` when the dots should follow the form.
WORKED EXAMPLE — "an iridescent dotted sphere dissolving into the background": {"primitive":"sphere", "object.material.type":"opalescent", "object.material.opalStrength":0.9, "object.material.screen.pattern":"dots", "object.material.screen.density":60, "object.material.screen.misregister":0.4}.

TRANSFORM: \`object.position/rotation/scale\` (or their \`objects.<id>.*\` twins) are plain XYZ triples addressed as \`.0\`/\`.1\`/\`.2\` (not \`.x\`/\`.y\`/\`.z\`) — rotation is in RADIANS. These are one-shot placement, not motion — Scene3D's separate per-object motion presets (loop/in/out) own animation and are not reachable through this vocabulary.

LIGHTING/CAMERA/POST are scene-wide: \`lighting.preset\` picks the overall setup, \`sunAzimuth/sunElevation/sunIntensity/ambient\` tune it further; \`lighting.environment\` picks the world the scene reflects — 'room' (neutral), 'darkStrips' (black studio with bright light bars — THE choice for prismatic/dispersive glass), 'softbox' (product-photo panels), 'colorGels' (magenta/cyan neon); \`camera.fov\` is the lens; \`post.*\` are render effects (bloom/grain/halftone/dot-screen/exposure/contrast/saturation/hue/chroma/blur/vignette/duotone/ambient-occlusion) — both the enable switch and the strength params for each are agent-controllable.`
