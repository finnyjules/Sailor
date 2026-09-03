import type { ControlSpec } from '~/lib/spacetype/effect'
import { isFill } from '~/lib/compositor/paint'
import { getEffectSync } from '~/lib/shaderfx/catalog'
import { derivedShaderFillControls, shaderFillControls } from '~/lib/shaderfill/controls'
import type { VtAxis } from './font'
import type { VectorTypeConfig, VtMove } from './config'
import { VT_CONTROLS, VT_LAYER_PREFIX, derivedVtControls, visibleVtControls } from './controls'
import { vtLayerLabels } from './layerLabel'
// The moves vocabulary is built from the SAME pure data the shared gallery
// (`movesAdapter.ts`'s `vtMovesAdapter`) draws its tiles from — never from the
// adapter itself, which is Vue-laden (`markRaw`'d `.vue` card bodies) and would
// pull that weight into this module's import graph for every caller, including
// `studioTune.ts`'s plain-unit-spec-imported patch path.
import { presetIdsFor } from '~/lib/motion/evaluate'
import { KINETIC_PRESETS_BY_ID, presetParamDefault } from '~/data/kinetic-presets'
import { VT_PRESET_CAPABILITIES } from './presetMotion'
import { animatableTargets } from './motion'
import type { MoveEaseName } from '~/lib/studio/moves/types'

/** Strip the schema-only fields (`when`/`agent`/`animatable`/`summary`/`entry`/`optionLabels`) a
 *  `VtControl` may carry, and drop anything explicitly withheld from the agent. Mirrors
 *  `shapefx/agentControls.ts` exactly. */
function stripMeta(specs: ControlSpec[]): ControlSpec[] {
  return specs
    .filter((c) => (c as any).agent !== false)
    .map(({ when, agent, animatable, summary, entry, optionLabels, ...spec }: any) => spec as ControlSpec)
}

/** Where a Vector Type layer's `ShaderSpec` lives, relative to the active layer.
 *  Exported so the surface's shader-fill editor and this vocabulary cannot drift. */
export const VT_LAYER_SHADER_PREFIX = 'layer.paint.shader'

/**
 * Vector Type's tune vocabulary for the in-product agent, derived from
 * VT_CONTROLS rather than hand-listed. Only controls that apply to the current
 * config are returned, mirroring the surface's own gating so the agent is never
 * offered a knob the user cannot see.
 *
 * `axes` is the LOADED font's axis list ("declare the frame, derive the
 * contents" — see ./controls.ts). It is a parameter rather than a lookup
 * because `loadVariableFont` exposes promises only, with no synchronous cache to
 * read; `shaderAgentControls(config, effectDef)` takes its `EffectDef` the same
 * way for the same reason. Omit it and the studio's static vocabulary is
 * returned unchanged — the axis sliders are simply not derived yet, which is
 * the honest answer before a font has finished loading.
 *
 * ## The shader-fill branch is NOT free — it has to be written out
 *
 * `visibleVtControls` can only ever return members of `VT_CONTROLS`, and
 * `VT_CONTROLS` declares no shader key at all (the shader vocabulary lives in the
 * shared `~/lib/shaderfill/controls.ts`, so that four host studios do not each
 * keep a copy of it). Measured before writing this branch: on a config whose
 * active layer's paint type is `shader`, `visibleVtControls` emitted
 * `text, fontId, size, tracking, align, layer.paint.type, layer.anchor,
 * motion.stagger.*` — and not one shader key. Nothing derives them; Shape Studio
 * needed the same explicit branch for the same reason
 * (`shapefx/agentControls.ts:35-39`), and this mirrors it line for line.
 *
 * The active effect's own params are appended too, but only when the shader-fx
 * catalog has ALREADY resolved that effect id. This reads the catalog's
 * synchronous cache (`getEffectSync`, never a fetch) rather than taking an
 * `EffectDef` parameter, so the signature stays at `(cfg, axes)` for its three
 * callers. If nothing on the page has fetched the catalog yet the per-effect
 * params are simply absent this call — not wrong, just not derived yet, the same
 * graceful degradation `~/lib/shaderfill/field.ts` accepts for the same reason.
 * (The axes above cannot use that trick: `loadVariableFont` exposes promises
 * only, with no synchronous cache to read, which is why they are a parameter.)
 */
/**
 * The `layer.*` vocabulary expanded to one ABSOLUTE, ID-ADDRESSED control per
 * appearance layer — `appearance.Lstroke.width`, labelled `Stroke · Stroke width`.
 *
 * ## Why this exists: the agent could not reach a stroke
 *
 * `layer.*` means "the ACTIVE layer", and headlessly the active layer is 0
 * (`studioTune` and the Collection resolver both pass no index — the convention
 * `controls.ts` documents). `layer.width` is `when`-gated to stroke layers, and
 * on every migrated node layer 0 is the FILL. So between the stack landing and
 * this function, "make the outline thicker" reached nothing: the key the agent
 * needed was withheld by a predicate asked about the wrong layer. Un-gating
 * `layer.width` would have been the other failure — a dead width control offered
 * on every fill layer.
 *
 * Naming the layer fixes both. The gate still runs, but it is asked about EACH
 * layer in turn, so a stack with a stroke anywhere in it offers exactly one
 * width key and it names the stroke.
 *
 * ## By id, not by index
 *
 * These keys are persisted — a Collection binding stores `params.<key>` — so an
 * index would re-point on reorder and a binding to a deleted layer would resolve
 * to whichever layer took its slot. `makeConfigParams` resolves the id and
 * refuses an unknown one, so a stale key reads `undefined` and writes nothing.
 *
 * A layer whose id is missing or ambiguous (never produced by `mergeConfig`, but
 * a raw blob can be anything) is SKIPPED rather than addressed positionally: an
 * agent key is a promise about which layer it edits, and a positional one cannot
 * keep it. Motion makes the opposite trade for the same case — a track that
 * already exists is worth resolving, a new key is not worth minting.
 */
export function vtStackControls(cfg: VectorTypeConfig): ControlSpec[] {
  const stack = Array.isArray(cfg?.appearance) ? cfg.appearance : []
  const names = vtLayerLabels(stack)
  const out: ControlSpec[] = []
  for (const c of VT_CONTROLS) {
    if (!c.key.startsWith(VT_LAYER_PREFIX)) continue
    if ((c as { agent?: boolean }).agent === false) continue
    const rest = c.key.slice(VT_LAYER_PREFIX.length)
    stack.forEach((l, i) => {
      const id = l?.id
      if (typeof id !== 'string' || id === '' || id.includes('.') || /^\d+$/.test(id)) return
      if (c.when && !c.when(cfg, l)) return
      const { when, agent, animatable, summary, entry, optionLabels, ...spec } = c as any
      out.push({ ...spec, key: `appearance.${id}.${rest}`, label: `${names[i] ?? `Layer ${i + 1}`} · ${c.label}` } as ControlSpec)
    })
  }
  return out
}

/**
 * ## Moves: add / remove / edit
 *
 * Task 10's vocabulary over `cfg.motion.moves` (`~/lib/studio/moves/types`'s
 * `Move[]`, narrowed to `VtMove` — see `config.ts`). Follows the SAME
 * id-addressed posture `vtStackControls` above already established for
 * `appearance`: a word that names something by its own STABLE id, so a stale
 * word degrades to IGNORED rather than landing on whatever took the deleted
 * move's place.
 *
 * ADD and REMOVE are the one shape neither `ControlSpec` nor `vtStackControls`
 * had to solve before — there is no "insert" or "delete" control kind, only
 * settable leaves. The established answer elsewhere in this codebase is a
 * MACRO: a `kind: 'select'` control whose key is not a real config path and
 * whose value is a VERB, not a stored leaf (`scene3d/agentControls.ts`'s
 * `primitive`, `gradientfx`'s `preset`, `shaderstudio`'s `effect` — all
 * intercepted by `~/lib/agent/studioTune.ts`'s `runParamPatch` before the
 * generic per-key write-through runs). `VT_MOVE_ADD_KEY`/`VT_MOVE_REMOVE_KEY`
 * follow that same shape so a future wiring of `vectorTypeAdapter` in
 * `studioTune.ts` (not part of this task — see its own file for the current,
 * add/remove-less adapter) has a ready-made macro to intercept, exactly the
 * seam Scene3D's `primitive` already demonstrates working end to end.
 *
 * `options` is what makes degradation automatic and free: `/api/vibe`'s
 * `validatePatch` keeps a `select` value only when it is still IN `options` at
 * the moment of validation (every macro above relies on this the same way) —
 * so a `moves.remove` value naming an id that is no longer in the stack is
 * dropped before it ever reaches a write, with no bespoke "does this move
 * still exist" check needed here.
 */
export const VT_MOVE_ADD_KEY = 'moves.add'
export const VT_MOVE_REMOVE_KEY = 'moves.remove'

/** `blink`/`scatter` are the two moves this studio adds that are not a
 *  `presetId` from the shared kinetic engine — see `movesAdapter.ts`'s
 *  `blinkOffer`/`scatterOffer`. Listed here under `loop` alongside it so
 *  "make the letters blink" and "make it fade in" are the same VERB. */
const VT_MOVE_ADD_MARKER_TOKENS: { token: string; label: string }[] = [
  { token: 'loop:blink', label: 'Blink (loop)' },
  { token: 'loop:scatter', label: 'Scatter (loop)' },
]

/**
 * The `moves.add` macro. Value is `"<phase>:<presetId>"` — a preset id ALONE
 * is not enough to place the move (`vtKnowsPreset` needs both, and the same
 * kinetic id can differ in meaning across a studio's tables), so the token
 * carries both halves the way `presetCrossing` in `migrateKinetic.ts` derives
 * them from a stored Kinetic node, except here the model picks the phase
 * itself because there is no saved category to read.
 *
 * Built from `presetIdsFor`/`VT_PRESET_CAPABILITIES` — the exact same
 * capability-gated id set `vtKnowsPreset`/`vtMovesAdapter`'s gallery use — so
 * an id offered here is always one the studio can actually render (no
 * `copies`-only preset, nothing GSAP-only ever crosses to this table at all).
 * Axis and track-preset tiles (font-dependent, layer-dependent) are left to
 * the visual gallery; this is the "make it fade/wave/spin/glitch/blink/
 * scatter" vocabulary an agent turn realistically reaches for.
 */
export function vtMoveAddControl(): ControlSpec {
  const options: string[] = []
  const optionLabels: string[] = []
  for (const phase of ['in', 'loop', 'out'] as const) {
    for (const id of presetIdsFor(phase, VT_PRESET_CAPABILITIES)) {
      const meta = KINETIC_PRESETS_BY_ID[id]
      options.push(`${phase}:${id}`)
      optionLabels.push(`${meta?.label ?? id} (${phase})`)
    }
  }
  for (const m of VT_MOVE_ADD_MARKER_TOKENS) { options.push(m.token); optionLabels.push(m.label) }
  return {
    key: VT_MOVE_ADD_KEY,
    label: 'Add move',
    kind: 'select',
    options,
    optionLabels,
    default: '',
    group: 'Motion',
    hint: 'Add a move to the motion stack — pick ONE option, never invent a value. '
      + '"in:*" plays once at the start, "out:*" once at the end, "loop:*" repeats for the '
      + 'whole clip. "loop:blink"/"loop:scatter" turn on letter-blink / per-glyph scatter.',
  }
}

/** A short, human label for a move — the same "name it something readable"
 *  job `moveCardLabel.ts` does for the panel, restated here pure (no
 *  `MovesAdapter`) so this module stays as light as `vtStackControls` above. */
function vtMoveLabel(mv: VtMove): string {
  if (mv.kind === 'blink') return 'Blink'
  if (mv.kind === 'scatter') return 'Scatter'
  if (mv.kind === 'tracks' && (!mv.presetId || mv.presetId === 'custom')) {
    const path = mv.tracks?.[0]?.path
    return path ? `Custom · ${path.split('.').pop()}` : 'Custom'
  }
  return KINETIC_PRESETS_BY_ID[mv.presetId ?? '']?.label ?? mv.presetId ?? mv.kind
}

/**
 * The `moves.remove` macro — `null` when the stack is empty, so an agent
 * turn on a config with no motion is never offered a verb with nothing to
 * name (the same posture `vtMoveFieldControls` below takes per move, and
 * `vtStackControls` takes for an unresolvable layer id).
 */
export function vtMoveRemoveControl(cfg: VectorTypeConfig): ControlSpec | null {
  const moves = Array.isArray(cfg?.motion?.moves) ? cfg.motion.moves : []
  if (!moves.length) return null
  return {
    key: VT_MOVE_REMOVE_KEY,
    label: 'Remove move',
    kind: 'select',
    options: moves.map(mv => mv.id),
    optionLabels: moves.map(mv => `${vtMoveLabel(mv)} (${mv.phase})`),
    default: '',
    group: 'Motion',
    hint: 'Remove one move from the stack by id — pick ONE option, never invent a value.',
  }
}

const MOVE_EASE_NAMES: readonly MoveEaseName[] =
  ['none', 'smooth', 'natural', 'slowDown', 'accelerate', 'overshoot', 'elastic', 'bounce', 'swing', 'steps']

/**
 * One id-addressed word per EXISTING move's `duration`/`ease`, plus its
 * `params.<key>` (a `'preset'` move whose preset takes tunable knobs — the
 * same `KineticPreset.params` the studio's own gallery card reads) and its
 * `tracks.<i>.from`/`.to` (a `'tracks'` move — addressed by INDEX, since a
 * bare track carries no id of its own; `MoveTrack` never grew one because
 * nothing before this needed to name one individually).
 *
 * `blink`/`scatter` moves are skipped: they are DERIVED markers
 * (`movesAdapter.ts`'s `derivedMoves`) that never live in `cfg.motion.moves`
 * in practice, and their real settings (`motion.blink.*`/`motion.scatter.*`)
 * already have their own keys in `VT_CONTROLS`'s Motion group.
 *
 * Ranges for `tracks.<i>.from/.to` come from `animatableTargets` — the SAME
 * per-path min/max the studio's own track editor and `vtMovesAdapter`'s
 * `availability` check use — so a glyph offset dial and an axis dial each get
 * a range that means something, not one generic guess across every path.
 */
function vtMoveFieldControls(cfg: VectorTypeConfig, axes: VtAxis[] = []): ControlSpec[] {
  const moves = Array.isArray(cfg?.motion?.moves) ? cfg.motion.moves : []
  if (!moves.length) return []
  const targets = animatableTargets(cfg, axes)
  const out: ControlSpec[] = []
  for (const mv of moves) {
    if (typeof mv?.id !== 'string' || !mv.id || mv.kind === 'blink' || mv.kind === 'scatter') continue
    const label = vtMoveLabel(mv)
    out.push({
      key: `moves.${mv.id}.duration`,
      label: `${label} · Duration`,
      kind: 'slider',
      min: 0.05, max: 20, step: 0.05,
      default: mv.duration,
      group: 'Motion',
    })
    out.push({
      key: `moves.${mv.id}.ease`,
      label: `${label} · Ease`,
      kind: 'select',
      options: [...MOVE_EASE_NAMES],
      default: mv.ease?.kind === 'named' ? mv.ease.name : 'smooth',
      group: 'Motion',
    })
    if (mv.kind === 'preset' && mv.presetId) {
      for (const p of KINETIC_PRESETS_BY_ID[mv.presetId]?.params ?? []) {
        out.push({
          key: `moves.${mv.id}.params.${p.key}`,
          label: `${label} · ${p.label}`,
          kind: 'slider',
          min: p.min, max: p.max, step: p.step,
          default: mv.params?.[p.key] ?? presetParamDefault(mv.presetId, p.key),
          group: 'Motion',
        })
      }
    }
    if (mv.kind === 'tracks' && Array.isArray(mv.tracks)) {
      mv.tracks.forEach((t, i) => {
        const target = targets.find(x => x.path === t.path)
        const range = target ? { min: target.min, max: target.max } : { min: -400, max: 400 }
        const trackLabel = target?.label ?? t.path
        out.push({
          key: `moves.${mv.id}.tracks.${i}.from`, label: `${label} · ${trackLabel} · From`,
          kind: 'slider', step: 1, default: t.from, ...range, group: 'Motion',
        })
        out.push({
          key: `moves.${mv.id}.tracks.${i}.to`, label: `${label} · ${trackLabel} · To`,
          kind: 'slider', step: 1, default: t.to, ...range, group: 'Motion',
        })
      })
    }
  }
  return out
}

export function vtAgentControls(cfg: VectorTypeConfig, axes: VtAxis[] = [], active = 0): ControlSpec[] {
  const out = [
    ...stripMeta(visibleVtControls(cfg, active)),
    ...stripMeta(derivedVtControls(cfg, axes)),
    // The relative `layer.*` keys above edit whatever the user has SELECTED
    // ("make this layer red"); these name a layer outright ("make the outline
    // thicker"). Both are needed and they are not interchangeable — see above.
    ...vtStackControls(cfg),
    // `moves.<id>.duration`/`.ease`/`.params.<key>`/`.tracks.<i>.from`/`.to` —
    // these are real, resolving leaves (`cfg.motion.moves[i]…`), so they belong
    // in the same list as every other settable word. `VT_MOVE_ADD_KEY`/
    // `VT_MOVE_REMOVE_KEY` do NOT: they are VERBS with no backing leaf (see
    // their own doc), so — exactly like `scene3d/agentControls.ts`'s
    // `primitive` is deliberately left OUT of `sceneAgentControls` — they are
    // exported separately for whichever caller composes the macro-interception
    // (`vtMoveAddControl()`, `vtMoveRemoveControl(cfg)`), not bundled here.
    ...vtMoveFieldControls(cfg, axes),
  ]
  // The ACTIVE appearance layer's paint is a `Paint`; only its `Fill` arm can
  // carry a shader (a `Gradient` has nowhere to put one), so this narrows before
  // asking the type — the same `isFill` guard `controls.ts`'s own `vtFill` uses.
  const paint = cfg?.appearance?.[active]?.paint
  const fill = isFill(paint) ? paint : null
  if (fill?.type === 'shader' && fill.shader) {
    // The relative prefix, matching the rest of the layer vocabulary: the
    // `ShaderSpec` lives per LAYER now, so a fixed `fill.shader` key would
    // address a field that no longer exists anywhere on the config.
    out.push(...stripMeta(shaderFillControls(VT_LAYER_SHADER_PREFIX)))
    const effectDef = getEffectSync(fill.shader.effectId)
    // Addressed at `layer.paint.shader.params.<paramId>` — the REAL
    // `ShaderSpec.params` path, so `makeConfigParams` and `getByPath`/`setByPath`
    // land on the stored value with no translation layer. See the module doc on
    // `~/lib/shaderfill/controls.ts` for what a key one segment off that path
    // cost last time (a phantom `.p` object, silently never rendered).
    if (effectDef) out.push(...derivedShaderFillControls(effectDef, VT_LAYER_SHADER_PREFIX))
  }
  return out
}


/**
 * The vocabulary a COLLECTION BINDING may be made against.
 *
 * `vtAgentControls` minus the relative `layer.*` keys, plus the same
 * `vtStackControls` expansion. The difference is not cosmetic:
 *
 *   an agent patch is applied ONCE, in the moment, against the layer the user is
 *   looking at — `layer.paint.a` is exactly right for it;
 *
 *   a Collection binding is PERSISTED and re-resolved on every sweep row, every
 *   preview and every batch render. `params.layer.paint.a` would mean "whichever
 *   layer happens to be selected then", so the same saved binding paints a
 *   different layer depending on where the user last clicked — and it would do it
 *   silently, with a real value landing on a real layer.
 *
 * So the bindable list names its layer: `params.appearance.Lstroke.width`. When
 * that layer is deleted the key is simply no longer in this list, and
 * `applyParamsPreview` skips a key it has no control for — the binding degrades
 * to IGNORED. `makeConfigParams` refuses the unknown id underneath it, so the
 * degradation holds even if a caller applies a binding without consulting this
 * list at all.
 */
export function vtBindableControls(cfg: VectorTypeConfig, axes: VtAxis[] = []): ControlSpec[] {
  return [
    ...stripMeta(visibleVtControls(cfg)).filter(c => !c.key.startsWith(VT_LAYER_PREFIX)),
    ...stripMeta(derivedVtControls(cfg, axes)),
    ...vtStackControls(cfg),
  ]
}

/**
 * Domain guidance injected into the /api/vibe prompt. Owned by controls.ts
 * (co-located with the schema it describes); re-exported here so the agent
 * wiring has a single import surface alongside vtAgentControls.
 */
export { VT_GUIDANCE } from './controls'
