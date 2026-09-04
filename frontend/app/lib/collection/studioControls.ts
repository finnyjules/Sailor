// Studio → StudioControlDesc[] adapter for the drawer bindings strip
// (`sailor:promoteControl` + CollectionDrawer.vue).
//
// Kept OUT of studioBindables.ts on purpose: resolving a studio's live control
// list touches the same modules the in-studio "vibe" tuner uses (SpaceType's
// effect registry pulls in `three`; Gradient/Shader/Texture pull in their own
// config readers). Those are fine in the browser but risk breaking vitest's
// node environment if imported eagerly from a file a plain unit spec touches.
// This file confines those imports to function bodies (dynamic import) so
// `mapControlSpecToDesc` — the pure, testable part — can be imported on its
// own without dragging in WebGL-adjacent modules.
import type { ControlSpec } from '~/lib/spacetype/effect'
import type { StudioControlDesc } from './studioBindables'

/** Pure shape adapter: a Space Type / Gradient / Shader / Texture `ControlSpec`
 *  (kind/min/max/step/options, possibly a DOTTED `key` for Gradient/Shader) to
 *  the flatter `StudioControlDesc` the Collection bindings strip understands.
 *  Only the AI-editable-ish kinds (slider/select/color/font) carry meaning for
 *  binding — other kinds (text/textList/fillList/path/curve) are passed through
 *  with their raw kind so callers can filter them out via `controlKindToVariableType`
 *  returning null. */
export function mapControlSpecToDesc(spec: ControlSpec): StudioControlDesc {
  const desc: StudioControlDesc = { key: spec.key, label: spec.label, kind: spec.kind }
  if (spec.kind === 'slider') {
    desc.min = spec.min
    desc.max = spec.max
    desc.step = spec.step
  }
  if (spec.kind === 'select') {
    desc.options = [...spec.options]
  }
  return desc
}

function mapAll(specs: ControlSpec[]): StudioControlDesc[] {
  return specs.map(mapControlSpecToDesc)
}

/** Space Type: the active effect's own ControlSpec list (registry lookup by
 *  `sailor_spaceType.effectId`, defaulting like the node/surface do). */
async function spaceTypeControls(node: any): Promise<StudioControlDesc[]> {
  const [{ getEffect }, { defaultSpaceTypeState }] = await Promise.all([
    import('~/lib/spacetype/effects'),
    import('~/lib/spacetype/state'),
  ])
  const saved = node?.data?.properties?.sailor_spaceType
  const effectId = saved?.effectId ?? defaultSpaceTypeState().effectId
  const effect = getEffect(effectId)
  return mapAll(effect.controls)
}

/** Gradient Studio: same config the canvas tuner reads (sailor_gradientStudio,
 *  falling back to a fresh default config), controls scoped to the current layout. */
async function gradientControls(node: any): Promise<StudioControlDesc[]> {
  const [{ cloneConfig }, { defaultConfig }, { gradientAgentControls }] = await Promise.all([
    import('~/lib/gradientfx/types'),
    import('~/lib/gradientfx/randomize'),
    import('~/lib/gradientfx/agentControls'),
  ])
  const saved = node?.data?.properties?.sailor_gradientStudio
  const config = saved ? cloneConfig(saved) : defaultConfig()
  return mapAll(gradientAgentControls(config, { includePreset: true }))
}

/** Shader Studio: same config the canvas tuner reads, plus the active effect's
 *  float uniforms (resolved async from the shader catalog). */
async function shaderControls(node: any): Promise<StudioControlDesc[]> {
  const [{ hydrateConfig, cloneConfig, defaultConfig, ensureEffectMasks }, { shaderAgentControls }, { getEffect }] = await Promise.all([
    import('~/lib/shaderstudio/types'),
    import('~/lib/shaderstudio/agentControls'),
    import('~/lib/shaderfx/catalog'),
  ])
  const saved = node?.data?.properties?.sailor_shaderStudio
  // Clone before touching: hydrateConfig's deepMerge shares ARRAYS with the saved
  // blob, so ensureEffectMasks would write masks straight onto the live node —
  // opening the bind menu is a READ and must not dirty the node. Same reasoning
  // (and the same narrow fix) as studioTune's shader adapter.
  const config = saved && typeof saved === 'object' ? cloneConfig(hydrateConfig(saved)) : defaultConfig()
  ensureEffectMasks(config)
  const effectDef = config.effects[0]?.id ? await getEffect(config.effects[0].id) : null
  // No `catalog` — deliberately WITHOUT the `effect` macro. Unlike every other key
  // here it is not a config leaf but a tuner verb (runParamPatch intercepts it), so
  // a Collection column bound to it would write a dead `config.effect` property.
  return mapAll(shaderAgentControls(config, effectDef))
}

/** Texture Studio: flat Params bag under sailor_textureStudio, static control
 *  list (no per-layout gating like Gradient/Shader — `when` predicates live in
 *  the surface, not here, so this offers the full vocabulary). */
async function textureControls(node: any): Promise<StudioControlDesc[]> {
  const { TEXTURE_CONTROLS } = await import('~/lib/texturefx/controls')
  void node
  return mapAll(TEXTURE_CONTROLS as ControlSpec[])
}

/** Shape Studio: same mark the canvas tuner reads — the base layer of the
 *  persisted `doc` (sailor_shapeStudio.doc), legacy `{config}` blobs migrated,
 *  falling back to a fresh default doc. */
async function shapeControls(node: any): Promise<StudioControlDesc[]> {
  const [{ studioDocFromPersisted }, { geoAgentControls }] = await Promise.all([
    import('~/lib/geoshape/studio'),
    import('~/lib/geoshape/agentControls'),
  ])
  const mark = studioDocFromPersisted(node?.data?.properties?.sailor_shapeStudio).layers[0]!.mark
  return mapAll(geoAgentControls(mark))
}

/**
 * Vector Type: the declared frame (`sailor_vectorType.config`) PLUS the loaded
 * font's own axes.
 *
 * Unique among the studios in that half its vocabulary comes off the wire: Inter
 * declares 2 variation axes, Roboto Flex 13, and `axes.<tag>` keys only exist
 * once the file has parsed. So this awaits the font — the dynamic import keeps
 * fontkit out of any spec that merely touches this module, and a failed load
 * degrades to the static vocabulary rather than to nothing.
 *
 * `vtBindableControls`, NOT `vtAgentControls`: the appearance stack's per-layer
 * keys are offered here ID-ADDRESSED (`appearance.Lstroke.width`) rather than as
 * the active-layer-relative `layer.width`, because a binding is persisted and
 * re-resolved long after the selection that made it has moved. See that
 * function's own doc for the failure the relative key would cause.
 */
async function vectorTypeControls(node: any): Promise<StudioControlDesc[]> {
  const [{ mergeConfig }, { vtBindableControls }] = await Promise.all([
    import('~/lib/vectortype/config'),
    import('~/lib/vectortype/agentControls'),
  ])
  const config = mergeConfig(node?.data?.properties?.sailor_vectorType?.config)
  let axes: any[] = []
  try {
    const { loadVectorFont } = await import('~/lib/vectortype/font')
    axes = (await loadVectorFont(config.fontId)).axes
  } catch {
    // Offline / unknown family — the static controls are still bindable, and an
    // axis binding that cannot be derived yet is better than an empty menu.
  }
  return mapAll(vtBindableControls(config, axes))
}

/**
 * Scene3D (3D Studio): a REAL backend node whose state is the `scene_state`
 * WIDGET value (a serialized SceneDoc via parseDoc), not a `data.properties`
 * config like every other studio here — mirrors how `studioTune.ts`'s own
 * adapter reads it. `sceneBindableControls`, NOT `sceneAgentControls`: a
 * Collection binding is persisted and re-resolved with no live selection, so
 * only the ABSOLUTE `objects.<id>.*` + doc-level (Lighting/Camera/Post) keys
 * are offered — the relative `object.*` namespace would mean "whichever
 * object was selected", which a persisted binding must never mean (see
 * `sceneBindableControls`'s own doc in scene3d/agentControls.ts).
 */
async function scene3dControls(node: any): Promise<StudioControlDesc[]> {
  const [{ parseDoc }, { sceneBindableControls }] = await Promise.all([
    import('~/lib/scene3d/config'),
    import('~/lib/scene3d/agentControls'),
  ])
  const defs = (node?.data?.widgetDefs ?? []) as any[]
  const i = defs.findIndex((d) => d?.name === 'scene_state')
  const raw = i >= 0 ? String(node?.data?.widgetsValues?.[i] ?? '') : ''
  const doc = parseDoc(raw)
  return mapAll(sceneBindableControls(doc))
}

/** Resolve the bindable control list for a studio node, keyed off
 *  `node.data.nodeType`. Returns [] for unknown/non-studio types. */
export async function controlsForStudio(node: any): Promise<StudioControlDesc[]> {
  switch (node?.data?.nodeType) {
    case 'SpaceType': return spaceTypeControls(node)
    case 'GradientStudio': return gradientControls(node)
    case 'ShaderStudio': return shaderControls(node)
    case 'TextureStudio': return textureControls(node)
    case 'ShapeStudio': return shapeControls(node)
    case 'VectorType': return vectorTypeControls(node)
    case 'Scene3DStudio': return scene3dControls(node)
    default: return []
  }
}
