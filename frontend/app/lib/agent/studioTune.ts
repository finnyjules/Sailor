/**
 * studioTune — let the CANVAS agent drive a STUDIO node's OWN surface, headlessly.
 *
 * Slice 1: the Frame (Compositor). A Frame's whole state lives on the node as
 * `data.properties.sailor_localLayers` + `sailor_localBg`, and the Frame node
 * re-bakes its thumbnail reactively from those — so we can read the CompositorState
 * off the node, plan against the Compositor surface (the same one the in-modal agent
 * uses), apply the result back onto the node, and the frame updates in place. No
 * modal, no re-implementation of rendering.
 *
 * Returns row summaries for the proposal + an undo closure (Dismiss restores the
 * node's prior state). Media ops (generate/edit/remove-bg inside the frame) need the
 * modal's upload+canvas tooling and are skipped here with a notice.
 */
import { $fetch } from 'ofetch'
import { applyCompositorCommand, describeCompositor, summarizeCompositorChange, verifyCompositor, type CompositorState } from '~/lib/agent/surfaces/compositor'
import { buildAgentPrompt, buildCommandSchema, parseAgentResponse } from '~/lib/agent/protocol'
import type { Command, CommandResult, SurfaceSnapshot } from '~/lib/agent/commandSurface'
import type { LayoutIssue } from '~/lib/agent/verify'
// Command-surface studios (planned like the Frame: describe → plan ops → apply).
import { applyTextureCommand, describeTexture, summarizeTextureChange, verifyTexture, type TextureState } from '~/lib/agent/surfaces/texture'
import { applySmartLayoutCommand, describeSmartLayout, summarizeSmartLayoutChange } from '~/lib/agent/surfaces/smartLayout'
import { verifySmartLayout } from '~/lib/agent/verify'
import { textureDefaults } from '~/lib/texturefx/controls'
import { cloneParams } from '~/lib/texturefx/types'
import type { Params, ParamValue } from '~/lib/spacetype/effect'
import type { TemplateV2, TemplateV3 } from '~~/shared/template-grid/types'
import { isV3 } from '~~/shared/template-grid/types'
import { toV3 } from '~~/shared/template-grid/sections'
import { makeStarterTemplate } from '~~/shared/template-grid/starter'
// Param-patch / "vibe" studios (a single nested config; NL → clamped param patch).
import { makeConfigParams } from '~/lib/agent/configParams'
import { describeControls, validatePatch, type DescribedControl } from '~/lib/spacetype/controlDescriptor'
import type { ControlSpec } from '~/lib/spacetype/effect'
import { defaultConfig as defaultGradientConfig } from '~/lib/gradientfx/randomize'
import { GRADIENT_GUIDANCE, gradientAgentControls } from '~/lib/gradientfx/agentControls'
import { buildGradientPreset } from '~/lib/gradientfx/presets'
import { cloneConfig as cloneGradientConfig, ensureConfigDefaults as ensureGradientConfigDefaults, type GradientConfig } from '~/lib/gradientfx/types'
import { cloneConfig as cloneShaderConfig, defaultConfig as defaultShaderConfig, ensureEffectMasks, hydrateConfig as hydrateShaderConfig, switchStudioEffect, type ShaderStudioConfig } from '~/lib/shaderstudio/types'
import { buildShaderGuidance, shaderAgentControls, SHADER_EFFECT_MACRO_KEY } from '~/lib/shaderstudio/agentControls'
import type { EffectDef as ShaderEffectDef } from '~/lib/shaderfx/types'
import { studioDocFromPersisted } from '~/lib/geoshape/studio'
import { geoAgentControls as shapeAgentControls, GEO_GUIDANCE as SHAPE_GUIDANCE } from '~/lib/geoshape/agentControls'
import { BASE_SHAPES, type BaseShapeKind } from '~/lib/geoshape/shapes'
import type { GeoShapeConfig } from '~/lib/geoshape/config'
// Vector Type's config + control schema are fontkit-free (controls.ts imports
// VtAxis TYPE-only, on purpose); only ./font.ts loads the parser, and that one is
// imported dynamically inside the adapter below.
import { mergeConfig as mergeVtConfig } from '~/lib/vectortype/config'
import { VT_GUIDANCE, vtAgentControls } from '~/lib/vectortype/agentControls'
import type { VtAxis as VtAxisLike } from '~/lib/vectortype/font'
import { fetchShaderFxCatalog, getEffect, getEffectSync } from '~/lib/shaderfx/catalog'
import { isResolvedTexture, resolveTexturePhrase } from '~/lib/scene3d/textures'
// Scene3D (3D Studio): config.ts/agentControls.ts are three-free by construction (same
// constraint controls.ts documents), so — like Gradient/Shape — these import statically
// rather than dynamically; only VectorType's font.ts needs the dynamic-import treatment.
import {
  parseDoc as parseSceneDoc, serializeDoc as serializeSceneDoc,
  addOrTargetPrimitive, setSceneMacroTarget, sceneMacroTargetIndex,
  MATERIAL_TYPES, MACRO_NONE,
  type SceneDoc, type PrimitiveObject, type PrimitiveKind, type MaterialType,
} from '~/lib/scene3d/config'
import {
  SCENE_GUIDANCE, sceneBindableControls, sceneAgentControls,
  scenePrimitiveMacro, SCENE_PRIMITIVE_MACRO_KEY,
} from '~/lib/scene3d/agentControls'

const MEDIA_OPS = new Set(['generateImage', 'editImage', 'removeImageBackground'])

export interface TuneRow { label: string; before: string; after: string; rationale: string }
export interface TuneResult { ok: boolean; rows: TuneRow[]; restore: () => void; notice?: string; error?: string }

/** True when a proposed tune is a no-op — the model reasserted the value the
 *  control already holds (live bug: a Texture proposal read "lattice: square →
 *  square"). `TuneRow.before`/`after` are always display STRINGS (never raw
 *  numbers — every summarize() stringifies before it gets here), so this never
 *  sees a number-vs-string mismatch; what it DOES see is the same numeric value
 *  formatted two different ways (a slider's stringified default vs. the model's
 *  stringified patch, e.g. "8" vs "8.0"), which a bare `===` would wrongly call
 *  a change. Compare trimmed strings first, then fall back to numeric equality
 *  when both sides parse as finite numbers. This is the ONE seam every tuner's
 *  row-builder funnels through (Compositor's own function, the command-surface
 *  path shared by Texture/Smart Layout, and the param-patch path shared by
 *  Gradient/Shader/Shape/Vector Type/Scene3D) — filtering here means every
 *  studio's tune proposals benefit, on the canvas path and any future in-studio
 *  consumer of the same TuneRow rows. */
export function isNoOpTuneChange(before: string, after: string): boolean {
  const b = before.trim()
  const a = after.trim()
  if (b === a) return true
  if (b === '' || a === '') return false
  const bn = Number(b)
  const an = Number(a)
  return Number.isFinite(bn) && Number.isFinite(an) && bn === an
}

/** Push a TuneRow unless it's a no-op — the shared filtering point all three
 *  row-builders below call through. */
function pushTuneRow(rows: TuneRow[], row: TuneRow): void {
  if (!isNoOpTuneChange(row.before, row.after)) rows.push(row)
}

/** Read a Frame node's CompositorState from its persisted properties (deep-cloned
 *  so the live node isn't mutated until we write back). */
function readState(node: any): CompositorState {
  const props = node?.data?.properties ?? {}
  return {
    layers: JSON.parse(JSON.stringify(props.sailor_localLayers ?? [])),
    background: props.sailor_localBg,
    postEffects: JSON.parse(JSON.stringify((props as any).sailor_localFx ?? [])),
  }
}
/** Write a CompositorState back onto the node — mirrors useLocalLayerEditor's
 *  commit/writeBg so the Frame re-bakes (and persists) exactly as a hand-edit would. */
function writeState(node: any, s: CompositorState) {
  if (!node.data.properties) node.data.properties = {}
  node.data.properties.sailor_localLayers = s.layers
  const bg = s.background
  if (bg === undefined || bg === 'none' || bg === '') delete node.data.properties.sailor_localBg
  else node.data.properties.sailor_localBg = bg
  if (s.postEffects?.length) node.data.properties.sailor_localFx = s.postEffects
  else delete node.data.properties.sailor_localFx
}

/** The unified wired+local z-order (`sailor_stackOrder`, bottom→top, keys
 *  `l:<id>` / `w:<slot>`). Needed so "send to back" sits a local layer behind the
 *  CONNECTED image — which lives outside CompositorState. */
function readStackOrder(node: any): string[] { return [...((node?.data?.properties?.sailor_stackOrder as string[]) ?? [])] }
function writeStackOrder(node: any, order: string[]) {
  if (!node.data.properties) node.data.properties = {}
  if (order.length) node.data.properties.sailor_stackOrder = order
  else delete node.data.properties.sailor_stackOrder
}

/** Plan + apply a natural-language tweak to a Frame (Compositor) node in place. */
export async function tuneCompositorNode(node: any, request: string, apiKey: string, tier = 'plan'): Promise<TuneResult> {
  const prior = readState(node)
  const priorOrder = readStackOrder(node)
  const restore = () => { writeState(node, prior); writeStackOrder(node, priorOrder) }
  // Guard: only a Frame (Compositor) has the layer/background state this reads &
  // writes — never scribble those keys onto another node type.
  if (node?.data?.nodeType !== 'Compositor') {
    return { ok: false, rows: [], restore, notice: `I can only tune a Frame in place — “${node?.data?.title ?? 'this node'}” isn’t one.` }
  }
  let state = readState(node)
  const snapshot = describeCompositor(state)
  let res: { text: string }
  try {
    res = await $fetch<{ text: string }>('/api/agent-plan', {
      method: 'POST',
      body: { apiKey, tier, prompt: buildAgentPrompt(snapshot, request), schema: buildCommandSchema(snapshot.commands) },
      timeout: 60_000,
    })
  } catch (e) {
    return { ok: false, rows: [], restore, error: e instanceof Error ? e.message : String(e) }
  }
  const { commands, changeRationales, message, parseFailed } = parseAgentResponse(res.text)
  if (parseFailed) return { ok: false, rows: [], restore, error: 'The model reply could not be read — please try again.' }
  const rows: TuneRow[] = []
  const backIds: string[] = []
  const frontIds: string[] = []
  let droppedMedia = false
  commands.forEach((cmd, i) => {
    if (MEDIA_OPS.has(cmd.op)) { droppedMedia = true; return }
    const test = applyCompositorCommand(state, cmd)
    if (!test.ok) return
    const sum = summarizeCompositorChange(state, cmd) ?? { label: cmd.op, before: '', after: '' }
    pushTuneRow(rows, { ...sum, rationale: changeRationales[i] ?? '' })
    state = test.template
    if (cmd.op === 'setLayerDepth' && cmd.target) {
      const to = String(cmd.args?.to ?? '')
      if (to === 'back') backIds.push(String(cmd.target))
      else if (to === 'front') frontIds.push(String(cmd.target))
    }
  })
  if (rows.length) {
    writeState(node, state) // apply as preview — the frame re-bakes
    // Push "back" layers behind the connected image in the unified stack. The Frame
    // reconciles: listed keys keep their order, present-but-unlisted keys (the wired
    // image, "front" layers) float ON TOP — so listing only the back keys is enough.
    if (backIds.length || frontIds.length) {
      const backKeys = backIds.map(id => `l:${id}`)
      const drop = new Set([...backKeys, ...frontIds.map(id => `l:${id}`)])
      writeStackOrder(node, [...backKeys, ...readStackOrder(node).filter(k => !drop.has(k))])
    }
  }
  // Additive notice: a dropped media op must NOT hide that other edits applied; a
  // verify warning (off-canvas / low-contrast) rides along too.
  const parts: string[] = []
  if (!rows.length && message) parts.push(message)
  if (droppedMedia) parts.push('Generating or editing images inside a frame isn’t available from the canvas yet — open the frame to do that.')
  if (rows.length) {
    const warn = verifyCompositor(state).find(i => i.level === 'warn')
    if (warn) parts.push(`Heads up: ${warn.message}`)
  }
  return { ok: rows.length > 0, rows, restore, notice: parts.length ? parts.join(' ') : undefined }
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic COMMAND-SURFACE tuner — Texture + Smart Layout plan exactly like the
// Frame (describe state → plan ops via /api/agent-plan → apply). An adapter binds
// the studio's node-state read/write to its surface's describe/apply/summarize/
// verify, so this stays one code path. (The Frame keeps its own function above —
// it has bespoke unified-stack-order handling this generic path doesn't need.)
// ─────────────────────────────────────────────────────────────────────────────
interface CommandAdapter<S> {
  read(node: any): S
  write(node: any, state: S): void
  describe(state: S): SurfaceSnapshot
  apply(state: S, cmd: Command): CommandResult<S>
  summarize(state: S, cmd: Command): { label: string; before: string; after: string } | null
  verify?(state: S): LayoutIssue[]
  /** Notice appended if the plan included a media op we can't run headlessly. */
  mediaNotice?: string
  /** Optional extra instruction appended to the plan prompt (mirrors PatchAdapter's
   *  `guidance` below) — e.g. Texture's honesty-about-approximation clause. Any
   *  command-surface studio can set one. */
  guidance?: string
}

async function runCommandSurface<S>(node: any, request: string, apiKey: string, tier: string, a: CommandAdapter<S>): Promise<TuneResult> {
  const prior = a.read(node) // read twice: `prior` for undo, `state` as the live probe
  const restore = () => a.write(node, prior)
  let state = a.read(node)
  const snapshot = a.describe(state)
  const prompt = buildAgentPrompt(snapshot, request) + (a.guidance ? `\n${a.guidance}` : '')
  let res: { text: string }
  try {
    res = await $fetch<{ text: string }>('/api/agent-plan', {
      method: 'POST',
      body: { apiKey, tier, prompt, schema: buildCommandSchema(snapshot.commands) },
      timeout: 60_000,
    })
  } catch (e) {
    return { ok: false, rows: [], restore, error: e instanceof Error ? e.message : String(e) }
  }
  const { commands, changeRationales, message, parseFailed } = parseAgentResponse(res.text)
  if (parseFailed) return { ok: false, rows: [], restore, error: 'The model reply could not be read — please try again.' }
  const rows: TuneRow[] = []
  let droppedMedia = false
  commands.forEach((cmd, i) => {
    if (MEDIA_OPS.has(cmd.op)) { droppedMedia = true; return }
    const test = a.apply(state, cmd)
    if (!test.ok) return
    const sum = a.summarize(state, cmd) ?? { label: cmd.op, before: '', after: '' }
    pushTuneRow(rows, { ...sum, rationale: changeRationales[i] ?? '' })
    state = test.template
  })
  if (rows.length) a.write(node, state) // apply as preview — the studio node re-bakes
  const parts: string[] = []
  if (!rows.length && message) parts.push(message)
  if (droppedMedia && a.mediaNotice) parts.push(a.mediaNotice)
  if (rows.length && a.verify) {
    const warn = a.verify(state).find(i => i.level === 'warn')
    if (warn) parts.push(`Heads up: ${warn.message}`)
  }
  return { ok: rows.length > 0, rows, restore, notice: parts.length ? parts.join(' ') : undefined }
}

/** Honesty-about-approximation clause for command-surface studios: when the
 *  requested look isn't in the vocabulary, approximate — don't refuse — but say
 *  so plainly. Generic on purpose so another command-surface studio's adapter
 *  can reuse it verbatim via its own `guidance`. */
export const APPROXIMATION_HONESTY_GUIDANCE = 'If the requested look is not achievable with the modes and controls available here, do not force an exact match: configure the closest approximation you can with the commands above, and say so in "message" — name the requested look and state plainly that this only approximates it. Never present an approximation as an exact match.'

/**
 * Texture's own guidance: the honesty clause plus look recipes for the CHIPS
 * mode, whose four sliders are not self-describing (nothing in "Chips across /
 * Density / Grout width / Chip size variance" says "terrazzo"). Recipes are prose the model
 * reads, deliberately NOT hardcoded logic — a phrase that only half-matches
 * should still be free to land between two of these.
 *
 * Chip colours are set through the ROLE commands (setFillColor on chipA / chipB /
 * ground), not setParam — colorA/colorB/background are hidden controls.
 * Chips carries exactly TWO ink colours plus the ground, by decision; a request
 * for "four colours of chip" is an approximation case (see the clause above),
 * and colour jitter is what supplies the rest of the variety.
 */
export const TEXTURE_GUIDANCE = `${APPROXIMATION_HONESTY_GUIDANCE}
Chips-mode look recipes (mode "chips" scatters irregular cells; its chip colours are the roles chipA/chipB with the grout on ground, so set them with setFillColor, not setParam):
- "terrazzo" / "speckled stone": chipCells 10-14, chipGrout thin (0.03-0.06), chipSizeVar high (0.7-0.9), ground an off-white, chipA/chipB two muted stone inks, jitter 0.5-0.8 so no two chips share a tone. Chips holds two ink colours plus the ground — the tonal spread comes from jitter, so say so rather than promising more colours. Leave chipDensity at 1 (packed) unless the ask is for a sparse look.
- "mosaic" / "tile work": tighter, more regular grid (chipCells 16-22), chipSizeVar low (0.1-0.3), grout stronger (0.08-0.12) in a darker ground. chipDensity stays 1 — tile work has no bare patches.
- "pebbles" / "river stones": few big chips (chipCells 5-8), chipSizeVar high (0.8-1), grout wide (0.1-0.18). Drop chipDensity a little (0.7-0.9) for stones strewn on sand rather than packed.
- "sparse speckle" / "scattered confetti" / "flecks": chipDensity low (0.3-0.5) so most cells fall to bare ground, chipCells high (14-22) for small flecks, chipGrout 0 (the ground already surrounds each fleck), chipSizeVar 0.4-0.8, jitter 0.4-0.7. Dropped cells show the ground colour, so set ground with setFillColor to the paper/backdrop you want.`

/** Texture Studio: state is a single `Params` bag under sailor_textureStudio
 *  (merged over defaults so pre-newer-key nodes still describe cleanly). No media
 *  ops. */
export async function tuneTextureNode(node: any, request: string, apiKey: string, tier = 'plan'): Promise<TuneResult> {
  return runCommandSurface<TextureState>(node, request, apiKey, tier, {
    read: (n) => {
      const saved = n?.data?.properties?.sailor_textureStudio as Params | undefined
      return { params: saved ? { ...textureDefaults(), ...cloneParams(saved) } : textureDefaults() }
    },
    write: (n, s) => { if (!n.data.properties) n.data.properties = {}; n.data.properties.sailor_textureStudio = cloneParams(s.params) },
    describe: describeTexture,
    apply: applyTextureCommand,
    summarize: summarizeTextureChange,
    verify: verifyTexture,
    guidance: TEXTURE_GUIDANCE,
  })
}

/** Smart Layout: state is a `TemplateV3` JSON string on the `layout` widget. A
 *  fresh/legacy node may hold a v2 (or empty) template — upgrade it to v3 the same
 *  way the editor does (`toV3`) so the surface, which is v3-only, can plan on it. */
function smartLayoutWidgetIndex(node: any): number {
  const defs = (node?.data?.widgetDefs ?? []) as any[]
  return defs.findIndex(d => d?.name === 'layout')
}
function readSmartLayout(node: any): TemplateV3 {
  const i = smartLayoutWidgetIndex(node)
  const raw = i >= 0 ? String(node?.data?.widgetsValues?.[i] ?? '').trim() : ''
  let t: TemplateV2 | TemplateV3
  if (raw) { try { t = JSON.parse(raw) as TemplateV2 | TemplateV3 } catch { t = makeStarterTemplate(`layout_${Math.random().toString(36).slice(2, 8)}`) as TemplateV2 } }
  else t = makeStarterTemplate(`layout_${Math.random().toString(36).slice(2, 8)}`) as TemplateV2
  return isV3(t) ? t : toV3(t as TemplateV2)
}
function writeSmartLayout(node: any, t: TemplateV3): void {
  const i = smartLayoutWidgetIndex(node)
  if (i < 0) return
  if (!Array.isArray(node.data.widgetsValues)) node.data.widgetsValues = []
  node.data.widgetsValues[i] = JSON.stringify(t, null, 2)
}
export async function tuneSmartLayoutNode(node: any, request: string, apiKey: string, tier = 'plan'): Promise<TuneResult> {
  return runCommandSurface<TemplateV3>(node, request, apiKey, tier, {
    read: readSmartLayout,
    write: writeSmartLayout,
    describe: describeSmartLayout,
    apply: applySmartLayoutCommand,
    summarize: summarizeSmartLayoutChange,
    verify: verifySmartLayout,
    mediaNotice: 'Generating or editing images inside a layout isn’t available from the canvas yet — open Smart Layout to do that.',
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic PARAM-PATCH tuner — Gradient + Shader keep one nested `config` and tune
// via the same "vibe" path the in-studio copilot uses: flatten config → dotted
// Params, offer the applicable controls, POST /api/vibe, clamp the returned patch
// (validatePatch), then write each key back through the flattening proxy.
// ─────────────────────────────────────────────────────────────────────────────
interface PatchAdapter {
  /** Read (cloned) config off the node + the controls applicable to it. May be
   *  async (Shader resolves its effect def + the whole catalog). `guidance` may
   *  be returned here when it is DERIVED from what `read` just loaded (Shader's
   *  effect index) rather than a module constant; it wins over `a.guidance`. */
  read(node: any): { config: any; controls: ControlSpec[]; guidance?: string } | Promise<{ config: any; controls: ControlSpec[]; guidance?: string }>
  /** Flat dotted-path view of the config (writes mutate the config in place). */
  params(config: any): Params
  write(node: any, config: any): void
  clone(config: any): any
  /** Human label for the studio (also the /api/vibe effectLabel). */
  label: string
  /** Optional per-domain guidance block for the vibe prompt (recipes). */
  guidance?: string
  /** Which control key is the MACRO (see `applyPreset`). Gradient's is `preset`,
   *  Shader's is `effect`. */
  macroKey?: string
  /** Optional macro: given the macro value + the current config, return the new
   *  base config (or null for a value that resolves to nothing). Applied BEFORE
   *  the scalar overrides, and the key is never written through to the config —
   *  it is a verb, not a leaf. */
  applyPreset?: (name: string, config: any) => any
  /** Display value of the macro BEFORE it was applied (the tune row's "before").
   *  Receives the macro VALUE too, because "before" is not always a single
   *  current selection: Scene3D's `primitive` ADDS rather than switches, so the
   *  honest before is "is the kind being asked for already present?" — anything
   *  else makes an ADD read as a CONVERSION. */
  macroBefore?: (config: any, macroValue: string) => string
  /** Re-derive the control list after the macro swapped the config. Declaring
   *  this changes the ordering contract for THIS adapter — see runParamPatch.
   *
   *  `raw` is the model's UNVALIDATED patch. Scene3D needs it because one of its
   *  scalars GATES the others: `object.material.type` decides whether the opal*
   *  knobs are offered at all, and it arrives in the same patch that wants to set
   *  them. Describing without looking at it would drop every gated override. */
  recontrol?: (config: any, raw: Record<string, ParamValue>) => ControlSpec[] | Promise<ControlSpec[]>
  /** Control keys that GATE which OTHER controls exist, and that arrive in the
   *  SAME patch as the keys they unlock. Unlike the macro they are ordinary
   *  leaves — they are written through with everything else and produce their own
   *  tune rows — but the rest of the patch has to be re-validated against the
   *  vocabulary they imply, or every key they gate is dropped as unknown.
   *  Requires `recontrol` (the re-describe seam); see runParamPatch. */
  gateKeys?: string[]
}

/** Scene3D texture phrases: the model writes `object.material.texture: "wood"`; the engine
 *  only binds RESOLVED ids (`ambientcg:Wood095`). Resolve every such key server-side before
 *  the patch lands, drop misses, and say so in plain words. Pure over an injected resolver
 *  so it is unit-testable without the network. */
export async function resolveTexturePatches(
  patch: Record<string, ParamValue>,
  resolve: (phrase: string) => Promise<{ id: string | null; name: string | null }> = resolveTexturePhrase,
): Promise<{ patch: Record<string, ParamValue>; notes: string[] }> {
  const out: Record<string, ParamValue> = { ...patch }
  const notes: string[] = []
  for (const [key, value] of Object.entries(patch)) {
    if (!key.endsWith('.material.texture') || typeof value !== 'string' || isResolvedTexture(value)) continue
    try {
      const r = await resolve(value)
      if (r.id) out[key] = r.id
      else { delete out[key]; notes.push(`No texture set matched '${value}'`) }
    } catch {
      delete out[key]
      notes.push(`The texture library couldn't be reached, so '${value}' was skipped`)
    }
  }
  return { patch: out, notes }
}

async function runParamPatch(node: any, request: string, apiKey: string, a: PatchAdapter): Promise<TuneResult> {
  const read0 = await a.read(node)
  let config = read0.config
  const prior = a.clone(config)
  const restore = () => a.write(node, prior)
  let params = a.params(config)
  const described: DescribedControl[] = describeControls(read0.controls, params)
  if (!described.length) return { ok: false, rows: [], restore, notice: `“${a.label}” has no AI-adjustable controls for that yet.` }
  let res: { changes?: { key: string; value: ParamValue }[]; rationale?: string }
  try {
    res = await $fetch('/api/vibe', {
      method: 'POST',
      body: { apiKey, controls: described, phrase: request, effectLabel: a.label, guidance: read0.guidance ?? a.guidance },
      timeout: 60_000,
    })
  } catch (e) {
    return { ok: false, rows: [], restore, error: e instanceof Error ? e.message : String(e) }
  }
  const raw: Record<string, ParamValue> = {}
  for (const c of res.changes ?? []) raw[c.key] = c.value
  let patch = validatePatch(raw, described)
  let byPath = new Map(described.map(d => [d.path, d]))
  const rationale = res.rationale ?? ''
  const rows: TuneRow[] = []

  // ── MACRO ORDERING CONTRACT ────────────────────────────────────────────────
  // A macro (Gradient's `preset`, Shader's `effect`) swaps the whole base config
  // FIRST; the scalar overrides in the same patch then land on top of the NEW
  // config. Gradient can stop there, because a preset swap only changes which of
  // a FIXED key set is applicable.
  //
  // Shader cannot: switching effect changes which `effects.N.params.*` keys even
  // EXIST. The patch was validated against the OLD effect's vocabulary, so the
  // new effect's uniforms would all be dropped as unknown keys and the old
  // effect's uniforms would be written onto a bag where they mean nothing. So an
  // adapter that declares `recontrol` gets the second half of the contract:
  // re-describe against the swapped config and re-validate the ORIGINAL raw
  // patch. Overrides for the NEW effect survive; overrides naming the OLD
  // effect's uniforms are dropped, which is the honest outcome — the model was
  // told (guidance) to send only the picked effect's uniforms.
  const macroKey = a.macroKey ?? 'preset'
  const macroHandled = !!a.applyPreset && typeof patch[macroKey] === 'string'
  if (a.applyPreset && typeof patch[macroKey] === 'string') {
    const macroValue = patch[macroKey] as string
    // Read the "before" FIRST: an adapter is free to swap IN PLACE (Shader's does,
    // through the studio's own switch seam), so asking afterwards would report the
    // new value as the old one and pushTuneRow would filter the row as a no-op.
    const before = a.macroBefore ? a.macroBefore(config, macroValue) : String(config?.canvas?.layout ?? '')
    const swapped = a.applyPreset(macroValue, config)
    if (swapped) {
      pushTuneRow(rows, { label: byPath.get(macroKey)?.label ?? 'Style preset', before, after: macroValue, rationale })
      config = swapped
      params = a.params(config) // re-bind the flat view to the new config
      if (a.recontrol) {
        const described2 = describeControls(await a.recontrol(config, raw), params)
        patch = validatePatch(raw, described2)
        byPath = new Map(described2.map(d => [d.path, d]))
      }
    }
    delete patch[macroKey]
  }

  // ── GATING FIELDS CONTRACT ─────────────────────────────────────────────────
  // The macro above covers ONE key that decides the vocabulary. Some studios have
  // several, and they are plain leaves rather than verbs: Shape's `layout`
  // ('blend' is what makes the blend* controls exist at all), `fillStrategy`
  // (anything but 'single' is what makes `fillCycle` exist) and `paintTarget`
  // ('outline'/'both' is what makes `strokeWidth` reachable with no stroke set).
  // They arrive in the SAME patch as the keys they unlock — the whole
  // stacked-outlines recipe is one turn — so validating the rest against the
  // PRE-patch vocabulary drops every gated key silently.
  //
  // So: apply the gate values to a CLONE, re-describe against that, and
  // re-validate the model's original raw patch. The gates themselves are NOT
  // written here — they flow through the ordinary write loop below like any other
  // key, so their tune rows still read honestly ("radial → blend").
  if (a.gateKeys?.length && a.recontrol) {
    const gates: Record<string, ParamValue> = {}
    for (const k of a.gateKeys) { const v = patch[k]; if (v !== undefined) gates[k] = v }
    if (Object.keys(gates).length) {
      const probe = a.clone(config)
      const probeParams = a.params(probe)
      for (const [k, v] of Object.entries(gates)) probeParams[k] = v
      const describedGated = describeControls(await a.recontrol(probe, raw), probeParams)
      // Re-merge the gate values themselves: they were already validated against
      // the pre-patch vocabulary (they are unconditional controls) and must not
      // depend on surviving the second pass.
      patch = { ...validatePatch(raw, describedGated), ...gates }
      byPath = new Map(describedGated.map(d => [d.path, d]))
      // The macro is a verb, never a leaf — the second validation pass would put
      // its key back into the patch.
      if (macroHandled) delete patch[macroKey]
    }
  }

  const resolved = await resolveTexturePatches(patch)
  patch = resolved.patch
  for (const [key, value] of Object.entries(patch)) {
    const before = params[key]
    params[key] = value // write-through the proxy → mutates the live config
    pushTuneRow(rows, { label: byPath.get(key)?.label ?? key, before: String(before ?? ''), after: String(value), rationale })
  }
  const noteText = resolved.notes.length ? resolved.notes.join(' · ') : undefined
  if (rows.length) a.write(node, config)
  return { ok: rows.length > 0, rows, restore, notice: noteText ?? (rows.length ? undefined : (rationale || 'No adjustable change for that — try naming a colour, style or amount.')) }
}

/** Gradient Studio: config under sailor_gradientStudio; controls depend on the
 *  current layout. Fresh node → a default gradient to tune from. Layer 0 is the
 *  headless active layer (the `layer.` control prefix resolves against it). */
export async function tuneGradientNode(node: any, request: string, apiKey: string): Promise<TuneResult> {
  return runParamPatch(node, request, apiKey, {
    read: (n) => {
      const saved = n?.data?.properties?.sailor_gradientStudio as GradientConfig | undefined
      // ensureConfigDefaults must run before this config is handed to the write-through
      // proxy: resolvePost's legacy-relief.grain-wins-at-render rule (types.ts) means a
      // write of post.grainAmount on a config that still carries relief.grain would be
      // silently overridden on every subsequent render otherwise. See resolvePost's doc
      // comment for the full invariant and the other writers that must honour it.
      const config = saved ? ensureGradientConfigDefaults(cloneGradientConfig(saved)) : defaultGradientConfig()
      // includePreset: the canvas tuner can swap the whole base config (buildGradientPreset).
      return { config, controls: gradientAgentControls(config, { includePreset: true }) }
    },
    params: (config) => makeConfigParams(() => config, () => 0),
    write: (n, config) => { if (!n.data.properties) n.data.properties = {}; n.data.properties.sailor_gradientStudio = cloneGradientConfig(config) },
    clone: cloneGradientConfig,
    label: 'Gradient studio',
    guidance: GRADIENT_GUIDANCE,
    applyPreset: (name) => buildGradientPreset(name),
  })
}

/**
 * The whole effect catalog, or null when it cannot be reached.
 *
 * `fetchShaderFxCatalog` calls Nuxt's ambient `$fetch`, which does not exist in a
 * node/unit environment — so this THROWS SYNCHRONOUSLY there rather than
 * rejecting, and a bare `.catch()` on the returned promise would not catch it.
 * Hence the try/await. Returning null (never `[]`) is the signal the rest of the
 * shader vocabulary keys off: no macro control, and guidance that says the effect
 * cannot be changed this turn instead of an empty effect index.
 */
async function shaderCatalogEffects(): Promise<ShaderEffectDef[] | null> {
  try { return (await fetchShaderFxCatalog()).effects } catch { return null }
}

/**
 * Shader Studio: config under sailor_shaderStudio. Beyond the active effect's own
 * uniforms, the canvas tuner is handed the WHOLE catalog — so it can offer the
 * `effect` macro (switch to any of the catalog's effects, seeding that effect's
 * defaults through the studio's own `switchStudioEffect` seam) and a guidance
 * index derived from that same list.
 */
const shaderAdapter: PatchAdapter = {
  read: async (n: any) => {
    const saved = n?.data?.properties?.sailor_shaderStudio
    // CLONE, then hydrate. `hydrateConfig`'s deepMerge returns ARRAYS BY
    // REFERENCE, so a hydrated config shares `effects` with the live node — and
    // both `ensureEffectMasks` below and every write-through param patch would
    // mutate the persisted blob in place. Merely READING the vocabulary (an empty
    // tune, a failed one, the Collections bind menu) must leave the saved config
    // byte-identical; this repo has a 409 stale-write guard, so an unrequested
    // persisted diff is not benign. Cloning HERE rather than fixing deepMerge is
    // the narrower fix: deepMerge is also on the surface's loadConfig and the node
    // bake path, and changing array identity for those is a behaviour change this
    // work has no way to verify (ShaderStudioSurface.vue has foreign WIP).
    const config: ShaderStudioConfig = saved && typeof saved === 'object'
      ? cloneShaderConfig(hydrateShaderConfig(saved))
      : defaultShaderConfig()
    // Materialize resting masks BEFORE describing, so every mask key the
    // vocabulary offers lands on a real object rather than fabricating a
    // half-built one through the dotted-path writer (see ensureEffectMasks).
    ensureEffectMasks(config)
    const catalog = await shaderCatalogEffects()
    const activeId = config.effects[0]?.id ?? ''
    // Prefer the list we already have; fall back to the by-id fetch (which is the
    // same cached promise) so a null catalog still resolves the CURRENT effect.
    const effectDef = activeId ? (catalog?.find(e => e.id === activeId) ?? await getEffect(activeId).catch(() => null)) : null
    return {
      config,
      controls: shaderAgentControls(config, effectDef, 0, { catalog }),
      guidance: buildShaderGuidance(catalog),
    }
  },
  params: (config: any) => makeConfigParams(() => config),
  write: (n: any, config: any) => { if (!n.data.properties) n.data.properties = {}; n.data.properties.sailor_shaderStudio = cloneShaderConfig(config) },
  clone: cloneShaderConfig,
  label: 'Shader studio',
  macroKey: SHADER_EFFECT_MACRO_KEY,
  macroBefore: (config: ShaderStudioConfig) => config.effects[0]?.id ?? '',
  // The macro runs through the studio's own switch seam, so the swap is
  // field-for-field what picking the effect in the picker would have done.
  applyPreset: (id: string, config: ShaderStudioConfig) => {
    const def = getEffectSync(id)
    if (!def) return null
    return switchStudioEffect(config, 0, def)
  },
  // Switching effect changes which effects.0.params.* keys exist — re-describe so
  // the same patch's uniform overrides validate against the NEW effect. Sync:
  // getEffectSync reads the catalog `read` already resolved. No `catalog` is
  // passed: this list only validates the scalar overrides, and the macro has
  // already fired (runParamPatch deletes its key straight after), so re-offering
  // `effect` here would be vocabulary nothing can act on.
  recontrol: (config: ShaderStudioConfig) => shaderAgentControls(
    config,
    config.effects[0]?.id ? getEffectSync(config.effects[0].id) : null,
    0,
  ),
}

/** Exposed for tests only — the adapter is otherwise reached via the registry. */
export const __shaderAdapterForTest = shaderAdapter

export async function tuneShaderNode(node: any, request: string, apiKey: string): Promise<TuneResult> {
  return runParamPatch(node, request, apiKey, shaderAdapter)
}

/**
 * Shape Studio's persisted property is a WRAPPER — { config, canvasW, canvasH,
 * aspectKey, orbit } — unlike gradient's bare config. `write` merges the tuned
 * config back into the existing wrapper so canvas size and camera orbit survive.
 */
const shapeAdapter: PatchAdapter = {
  read: (n: any) => {
    // Shape Studio persists a LAYERED `doc` now (legacy `{config}` blobs migrate
    // via studioDocFromPersisted). The canvas tuner edits the BASE layer's mark
    // (layer 0) — the same flat GeoShapeConfig the agent vocabulary describes.
    const doc = studioDocFromPersisted(n?.data?.properties?.sailor_shapeStudio)
    const mark = doc.layers[0]!.mark
    return { config: mark, controls: shapeAgentControls(mark) }
  },
  params: (mark: any) => makeConfigParams(() => mark),
  write: (n: any, mark: any) => {
    if (!n.data) n.data = {}
    if (!n.data.properties) n.data.properties = {}
    const prev = n.data.properties.sailor_shapeStudio ?? {}
    // Re-load the doc (migrating legacy), drop the tuned mark back into layer 0,
    // and persist `doc` — preserving canvasW/H/aspectKey and dropping any stale
    // legacy `config` key so the node bake (which prefers `doc`) stays consistent.
    const doc = studioDocFromPersisted(prev)
    doc.layers[0] = { ...doc.layers[0]!, mark: JSON.parse(JSON.stringify(mark)) }
    const { config: _legacyConfig, ...rest } = prev as Record<string, any>
    n.data.properties.sailor_shapeStudio = { ...rest, doc: JSON.parse(JSON.stringify(doc)) }
  },
  clone: (mark: any) => JSON.parse(JSON.stringify(mark)),
  label: 'Shape studio',
  guidance: SHAPE_GUIDANCE,
  // `shape` is a MACRO for the same reason Shader's `effect` is: it decides which
  // of the other Shape keys are described at all. geoAgentControls only offers
  // `libraryShape` while cfg.shape === 'library' (and `sides`/`starInner`/
  // `irregularSeed` only under their own families), so a patch that switches the
  // family AND sets the family's own knob — the natural one-turn request, "make
  // it the swirl shape" → { shape: 'library', libraryShape: 'swirl' } — used to
  // lose its second half as an unknown key, leaving the mark on whichever library
  // id happened to be stored. Applying `shape` first and re-describing fixes the
  // whole family of those, not just library's.
  macroKey: 'shape',
  macroBefore: (config: GeoShapeConfig) => String(config.shape),
  // A pure field swap (the base mark is one flat config — nothing to re-seed),
  // guarded so an off-vocabulary kind resolves to nothing rather than writing a
  // shape the renderer cannot draw. validatePatch already snaps `shape` to the
  // select's options; this is the floor for a future caller that does not.
  applyPreset: (value: string, config: GeoShapeConfig) =>
    (BASE_SHAPES as string[]).includes(value)
      ? { ...config, shape: value as BaseShapeKind }
      : null,
  // Re-describe against the SWAPPED config so the same patch's family-specific
  // keys validate against the new family's vocabulary (runParamPatch re-validates
  // the original raw patch against this list). Keys naming the OLD family's knobs
  // drop out, which is the honest outcome — they mean nothing on the new shape.
  // Also the re-describe seam for `gateKeys` below.
  recontrol: (config: GeoShapeConfig) => shapeAgentControls(config),
  // The three OTHER vocabulary-deciding fields (see runParamPatch's gating-fields
  // contract). They are ordinary leaves, not macros — nothing needs re-seeding
  // when they change, they just decide which controls geoAgentControls offers:
  //   layout 'blend'        → the whole Blend group exists
  //   fillStrategy != single → fillCycle exists
  //   paintTarget != fill   → strokeWidth is reachable with no stroke set
  // GEO_GUIDANCE's stacked-outlines recipe sets all three plus the keys they
  // unlock in a single patch, so without this it lands as a bare layout switch.
  gateKeys: ['layout', 'fillStrategy', 'paintTarget'],
}

/** Exposed for tests only — the adapter is otherwise reached via the registry. */
export const __shapeAdapterForTest = shapeAdapter

/** Shape Studio: the mark lives nested under sailor_shapeStudio.doc.layers[0].mark,
 *  alongside canvas size (NOT tune-adjustable) — the tuner edits the base layer's
 *  mark and merges it back into the doc rather than replacing the wrapper (see
 *  shapeAdapter above). */
export async function tuneShapeNode(node: any, request: string, apiKey: string): Promise<TuneResult> {
  return runParamPatch(node, request, apiKey, shapeAdapter)
}

/**
 * `moves.<id>.ease` is a `kind:'select'` control whose `options` are bare
 * `MoveEaseName` strings (`agentControls.ts`'s `vtMoveFieldControls` —
 * there is no `bezier` option in that list, a bezier ease is not
 * agent-settable through this select at all), but the config actually
 * stores a `MoveEase` OBJECT — `{kind:'named', name} | {kind:'bezier', cps}`
 * — because every reader of a move's ease (`mergeEase`, `EasePicker.vue`,
 * `easeToEngineName`, `presetMotion.ts`) expects that shape. Before this
 * wrapper, a write landed the bare string straight into
 * `cfg.motion.moves[i].ease`: `easeToEngineName` reads `.kind`/`.name` off a
 * plain string as `undefined` and silently falls back to `power2.out`, and
 * the stored shape no longer matched `MoveEase` for every other reader.
 *
 * Wraps the flat `Params` proxy `makeConfigParams` returns so ONLY
 * `moves.<id>.ease` keys are translated: a WRITE of a bare name coerces it
 * to `{kind:'named', name}` before it reaches the underlying config, and a
 * READ renders the stored object back down to its name — the same value
 * `vtMoveFieldControls`'s own `default` already computes
 * (`mv.ease?.kind === 'named' ? mv.ease.name : 'smooth'`) — so
 * `describeControls`'s `current` and `runParamPatch`'s tune-row "before"
 * text (both `String()` whatever `params[key]` hands back) stop rendering
 * "[object Object]". Every other key passes straight through to `base`
 * unchanged; a `bezier` ease already in the config (never written by this
 * select) reads back as itself, not coerced.
 */
function vtMoveEaseAwareParams(base: Params): Params {
  const EASE_KEY = /^moves\.[^.]+\.ease$/
  return new Proxy(base, {
    get: (target, key) => {
      if (typeof key !== 'string' || !EASE_KEY.test(key)) return (target as any)[key]
      const v = (target as any)[key]
      return v && typeof v === 'object' && (v as any).kind === 'named' ? (v as any).name : v
    },
    set: (target, key, value) => {
      if (typeof key === 'string' && EASE_KEY.test(key) && typeof value === 'string') {
        (target as any)[key] = { kind: 'named', name: value }
      } else {
        (target as any)[key] = value
      }
      return true
    },
    has: (target, key) => key in target,
  })
}

/**
 * Vector Type: a WRAPPER property like Shape's — { config, canvasW, canvasH,
 * aspectKey, background } — so `write` merges back rather than replacing.
 *
 * The one studio whose control vocabulary is only half declared: `axes.<tag>`
 * sliders are DERIVED from the loaded font's own `fvar`, so `read` loads the
 * font before it can describe them. The import is dynamic to keep fontkit out of
 * this module's import graph (studioTune is imported by plain unit specs), and a
 * failed load falls back to the static vocabulary — the agent then simply cannot
 * reach the axes this turn, rather than the whole tune failing.
 */
const vectorTypeAdapter: PatchAdapter = {
  read: async (n: any) => {
    const config = mergeVtConfig(n?.data?.properties?.sailor_vectorType?.config)
    let axes: VtAxisLike[] = []
    try {
      const { loadVectorFont } = await import('~/lib/vectortype/font')
      axes = (await loadVectorFont(config.fontId)).axes
    } catch { /* offline / unknown family — static vocabulary only */ }
    return { config, controls: vtAgentControls(config, axes as any) }
  },
  // `listKey: 'appearance'` — the DEFAULT ('layers') never matched this
  // studio's stack, so every `layer.*`/`appearance.<id>.*` key `vtAgentControls`
  // offers was silently DEAD through this adapter (read `undefined`, write
  // fabricating a stray property on the array) until now; caught while wiring
  // moves below, fixed alongside it rather than left for its own turn.
  // `extraLists: [{ key: 'moves', at: 'motion.moves' }]` is Task 10's own
  // addition — it is what makes `moves.<id>.duration`/`.ease`/`.params.<key>`/
  // `.tracks.<i>.from` (`agentControls.ts`'s `vtMoveFieldControls`) resolve
  // rather than fabricate a dead `config.moves.<id>` property: the control's
  // own key is the short `moves.<id>.…` (matching `appearance.<id>.…`'s
  // grammar), but the array it actually addresses lives at `motion.moves` —
  // `at` is what tells `makeConfigParams` where to really look (see its own
  // `ExtraIdList` doc).
  params: (config: any) => vtMoveEaseAwareParams(makeConfigParams(
    () => config, () => 0, 'appearance', 'id', 'layer', [{ key: 'moves', at: 'motion.moves' }],
  )),
  write: (n: any, config: any) => {
    if (!n.data) n.data = {}
    if (!n.data.properties) n.data.properties = {}
    const prev = n.data.properties.sailor_vectorType ?? {}
    // Re-merged, not stored verbatim: `makeConfigParams` writes whatever the
    // agent names straight onto the live config, and a `text` control like
    // `fontId` accepts any string — but Vector Type can only LOAD the three
    // token shapes. `mergeConfig` is the same gate every stored config passes
    // on the way in, so putting it here means a patch cannot persist a value
    // the studio would have to fall back from on every later load.
    n.data.properties.sailor_vectorType = { ...prev, config: JSON.parse(JSON.stringify(mergeVtConfig(config))) }
  },
  clone: (config: any) => JSON.parse(JSON.stringify(config)),
  label: 'Vector Type',
  guidance: VT_GUIDANCE,
}

/** Exposed for tests only — the adapter is otherwise reached via the registry. */
export const __vectorTypeAdapterForTest = vectorTypeAdapter

/** Vector Type: config lives nested under sailor_vectorType.config, alongside a
 *  canvas box that is NOT tune-adjustable (see vectorTypeAdapter above). */
export async function tuneVectorTypeNode(node: any, request: string, apiKey: string): Promise<TuneResult> {
  return runParamPatch(node, request, apiKey, vectorTypeAdapter)
}

/** Locates the `scene_state` WIDGET on a Scene3DStudio node — mirrors
 *  `smartLayoutWidgetIndex` above. Unlike every other PatchAdapter's studio,
 *  Scene3D is a REAL backend node (see comfy_extras/nodes_scene3d.py): its
 *  state lives in `data.widgetDefs`/`widgetsValues`, not `data.properties`. */
function scene3dWidgetIndex(node: any): number {
  const defs = (node?.data?.widgetDefs ?? []) as any[]
  return defs.findIndex((d) => d?.name === 'scene_state')
}

/**
 * Scene3D (3D Studio): the persisted blob is the `scene_state` widget's
 * STRING value — a serialized `SceneDoc` (parseDoc/serializeDoc round-trip),
 * not a bare/wrapped object on `data.properties` like the other adapters.
 * `write` re-serializes the WHOLE mutated doc and writes it back into ONLY
 * that one widget slot, leaving beauty_image/depth_image/normal_image/
 * glb_url untouched — the same "merge, don't replace" discipline Shape's
 * `{ config, canvasW, canvasH, aspectKey, orbit }` wrapper needs, just
 * against a widgets array instead of a properties object.
 *
 * `params` passes `listKey: 'objects'` (configParams.ts's parameter, matching
 * `SceneDoc.objects`) so `objects.<id>.*` keys resolve id→index against the
 * live doc.
 *
 * THE RESTING vocabulary is still absolute-only: `sceneBindableControls` — the
 * `objects.<id>.*` + doc-level (Lighting/Camera/Post) keys — because there is no
 * live selection headlessly, so a relative `object.*` key would have nothing to
 * point AT. What changed is that "nothing to point at" is now expressible: the
 * `primitive` macro records the object it created (`sceneMacroTargetIndex`) and
 * `makeConfigParams`'s relative prefix is parameterized to `'object'`, so
 * `object.*` resolves to THAT object and — when no macro ran — to index -1,
 * which makes the key dead rather than fabricating a bogus top-level `object`
 * property on the SceneDoc (configParams' `write` creates missing containers).
 *
 * The relative keys are OFFERED only in the post-macro `recontrol` list, which
 * is the one moment they mean something: the model has just asked for a shape
 * that did not exist when it wrote the patch, so it cannot name the new id.
 */
const scene3dAdapter: PatchAdapter = {
  read: (n: any) => {
    const i = scene3dWidgetIndex(n)
    const raw = i >= 0 ? String(n?.data?.widgetsValues?.[i] ?? '') : ''
    const config = parseSceneDoc(raw)
    // The `primitive` macro rides ON TOP of the bindable list rather than inside
    // it: `sceneBindableControls` also feeds the Collections bind menu, where a
    // persisted binding to a verb would write a dead `doc.primitive` property.
    // Same split as Shader's catalog-gated `effect` and Gradient's
    // `includePreset`.
    return { config, controls: [scenePrimitiveMacro(config), ...sceneBindableControls(config)] }
  },
  // `object.` is the RELATIVE prefix (configParams' 5th arg), resolving to
  // whatever the macro created or targeted this run — see sceneMacroTargetIndex.
  // With no macro it resolves to -1 → every relative key dead, which is what the
  // old hard-coded 'layer' prefix could not express.
  params: (config: any) => makeConfigParams(
    () => config, () => sceneMacroTargetIndex(config), 'objects', 'id', 'object',
  ),
  write: (n: any, config: any) => {
    const i = scene3dWidgetIndex(n)
    if (i < 0) return
    if (!Array.isArray(n.data.widgetsValues)) n.data.widgetsValues = []
    n.data.widgetsValues[i] = serializeSceneDoc(config)
  },
  clone: (config: any) => parseSceneDoc(serializeSceneDoc(config)),
  label: '3D Studio',
  guidance: SCENE_GUIDANCE,
  macroKey: SCENE_PRIMITIVE_MACRO_KEY,
  // Presence of THE ASKED-FOR kind, not "the first primitive". Sourcing it from
  // the first primitive of any kind made an ADD to a scene holding a box read
  // "Primitive: box -> gem" — a conversion, the one thing this macro never does —
  // and made a REDUNDANT macro read "gem -> gem" with ok:true while nothing
  // changed. Now an add reads "(none) -> gem", and a redundant one is before ===
  // after, which pushTuneRow filters as the no-op it is.
  macroBefore: (config: SceneDoc, kind: string) =>
    config.objects.some(o => o.kind === 'primitive' && o.primitive === kind) ? kind : MACRO_NONE,
  // Runs through the studio's own add seam, so the object is field-for-field
  // what the add menu would have placed. Records the target so the relative
  // `object.*` keys in the SAME patch resolve to it.
  applyPreset: (kind: string, config: SceneDoc) => {
    const out = addOrTargetPrimitive(config, kind as PrimitiveKind)
    if (!out) return null
    setSceneMacroTarget(out.doc, out.targetId)
    return out.doc
  },
  // Adding an object changes which keys EXIST (`objects.<newid>.*` did not exist
  // when the patch was written — the model cannot know an id that has not been
  // minted yet). So re-describe, and re-validate the ORIGINAL raw patch against
  // the new list: the relative `object.*` overrides the guidance asks for are
  // recovered here even though the first validation pass dropped them.
  recontrol: (config: SceneDoc, raw: Record<string, ParamValue>) => {
    const i = sceneMacroTargetIndex(config)
    const target = i >= 0 ? config.objects[i] : undefined
    // ONE scalar in this patch gates the others. `object.material.type` decides
    // which material knobs `visibleSceneControls` offers at all — opalHueShift &
    // friends are opalescent-only — and it arrives in the SAME patch that wants
    // to set them. The object we just created still wears DEFAULT_MATERIAL, so
    // describing against it as-is would offer no opal* key and validatePatch
    // would drop every one of them. "a 3d iridescent diamond" would come back a
    // plain grey stone.
    //
    // So describe against the material the patch is ABOUT to install, then put
    // the real value back: the write-through loop below still performs the type
    // change for real, which keeps its proposal row honest (a pre-applied type
    // would read opalescent → opalescent and be filtered as a no-op).
    let restore: (() => void) | undefined
    if (target && target.kind !== 'light') {
      const want = raw['object.material.type'] ?? raw[`objects.${target.id}.material.type`]
      if (typeof want === 'string' && (MATERIAL_TYPES as string[]).includes(want)) {
        const prev = target.material.type
        target.material.type = want as MaterialType
        restore = () => { target.material.type = prev }
      }
    }
    try {
      // `sceneAgentControls` already spreads `sceneStackControls` and the
      // doc-level keys, so it is the WHOLE vocabulary plus the relative
      // `object.*` namespace — adding sceneBindableControls here only duplicated
      // every absolute key.
      return sceneAgentControls(config, target)
    } finally {
      // Restore even if describing throws, or the temporary material type would
      // be written to the node as if the user had asked for it.
      restore?.()
    }
  },
  // Simple lighting hides the raw sun/ambient dials behind `lighting.advanced`, so a
  // patch that flips the switch AND sets `lighting.sunIntensity` in the same turn would
  // otherwise keep only the switch — the dial keys are validated against the pre-patch
  // vocabulary, where they are withheld. Same second-pass contract as Shape's layout gate.
  gateKeys: ['lighting.advanced'],
}

/** Exposed for tests only — the adapter is otherwise reached via the registry. */
export const __scene3dAdapterForTest = scene3dAdapter

/** Scene3D (3D Studio): scene state lives on the `scene_state` widget as a
 *  serialized SceneDoc (see scene3dAdapter above), not a node property. */
export async function tuneScene3DNode(node: any, request: string, apiKey: string): Promise<TuneResult> {
  return runParamPatch(node, request, apiKey, scene3dAdapter)
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry — the canvas agent dispatches a tuneNode by the target's nodeType.
// ─────────────────────────────────────────────────────────────────────────────
export type StudioTuner = (node: any, request: string, apiKey: string, tier?: string) => Promise<TuneResult>

export const STUDIO_TUNERS: Record<string, StudioTuner> = {
  Compositor: tuneCompositorNode,
  TextureStudio: tuneTextureNode,
  SmartLayout: tuneSmartLayoutNode,
  GradientStudio: tuneGradientNode,
  ShaderStudio: tuneShaderNode,
  ShapeStudio: tuneShapeNode,
  VectorType: tuneVectorTypeNode,
  Scene3DStudio: tuneScene3DNode,
}

/** The in-place tuner for a node type, or undefined if that node has no canvas
 *  tune surface (the caller then tells the user it can't be tuned from here). */
export function studioTunerFor(nodeType: string | undefined | null): StudioTuner | undefined {
  return nodeType ? STUDIO_TUNERS[nodeType] : undefined
}
