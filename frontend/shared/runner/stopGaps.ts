/**
 * R11.9a: the long tail, refused in plain words (USER ruling (e)) instead of
 * left to the engine. Pure helpers, relative imports only: the server's start
 * (server/runner/engine.ts prepareStart) and the browser's needs-the-engine
 * words (./needsEngine.ts) share them, so there is one rule.
 *
 * A node the runner takes only with `plainRefusals` (./eligibility.ts) is
 * refused here, before anything is held, naming the field where there is one:
 *   - row 15: a clip's frames wired into an input that takes one picture
 *     (Save image and Preview image save each frame instead, as Python does);
 *   - row 16: typed click points SAM 3 can't be sent (SAM_MASK_WORDS.pointsFail);
 *   - row 17: a setting read as typed, wired;
 *   - row 18: text Python reads its own way (colour text, NaN, a painter
 *     file's name or colour, a moodboard's reading, a bake card's settings);
 *   - row 19: letters outside the glyph atlas;
 *   - R11.3's stop-gaps 1–3 and 6: a lip-sync medium given as a web address
 *     or a data: link ("Upload … to Sailor").
 * Row 25 (a family off) is named by `switchedOffNodes`: those still go to the
 * engine until R10, with words.
 */
import { GATE_CLASS, isLink, linksOf, type ApiLink, type ApiPrompt } from './graph'
import { staticValueOf } from './staticValues'
import { EVERY_KNOWN_FAMILY, familyOn, type RunnerFamily } from './families'
import {
  INPUT_CHECKS, PLAIN_REFUSAL_CHECKS, clipIntoPictureInput, outputKindsFor, ownRuleFamilies, runnerRuleFor, runnerTakesNode, widgetError,
  type InputCheckContext, type InputCheckName, type RunnerEligibilityOptions, type RunnerNodeRule, type RunnerWidgetSpec,
} from './eligibility'
import { outputKind } from './values'
import { EFFECT_FAMILY_OF, asciiRampOf, effectTextNotPortable, painterFileIsPortable } from './effects'
import { SAM_MASK_WORDS, VOCALS_CLASS, WHISPER_CLASS, isLocalModelClass } from './localModels'
import { parseMaskPoints } from './samInput'
import { LIPSYNC_UPLOAD_SOUND, lipSyncEngineMediaWords } from './lipSyncEngines'
import { LIPSYNC_SILENCE_NEEDS_UPLOAD } from './soundIn'
import {
  CLIP_INTO_PICTURE_WORDS, LETTERS_WORDS, ODD_SETTING_WORDS, oddSettingWords, oddTextWords, wiredSettingWords, wiredValueOutOfRangeWords, type RunnerReasonCode,
} from './messages'

export interface StopGapRefusal {
  nodeId: string
  classType: string
  code: RunnerReasonCode
  message: string
}

/**
 * Fix round 1 (m1): a widget's label as the node shows it, the canvas's own
 * rule (app/components/vue-canvas/ComfyNodeWidget.vue formatLabel): its
 * per-node overrides, else the name's words in sentence case, "(frames)"
 * after a widget that counts frames. Held to the canvas by
 * tests/unit/runner-stop-gaps.unit.spec.ts.
 */
export const SHOWN_LABEL_OVERRIDES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  RestyleWithLoRANode: { style_strength: 'Transformation' },
}
export const FRAME_WIDGET_NAMES: ReadonlySet<string> = new Set([
  'duration', 'length', 'total_duration', 'frame_count', 'start', 'start_frame', 'end_frame', 'fade_in', 'fade_out', 'radius',
])
export function shownLabel(classType: string, name: string): string {
  const override = SHOWN_LABEL_OVERRIDES[classType]?.[name]
  if (override) return override
  const pretty = name.split(/[_\s]+/).map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join(' ')
  return FRAME_WIDGET_NAMES.has(name) ? `${pretty} (frames)` : pretty
}

/** Row 17 (as ruled in fix round 1): settings the brief names, refused whenever their value is made in the run. */
export const ROW_17_NAMED: Readonly<Record<string, readonly string[]>> = {
  [VOCALS_CLASS]: ['model', 'shifts'],
  [WHISPER_CLASS]: ['model_size'],
}

/**
 * Fix round 1 (M1), fix round 2 (N1): whether a setting wired to a value the
 * run makes has a dearest bound the price and the start can rest on: a number
 * with both a least and a most (a setting can be dearest at either end, e.g.
 * speech's speed), a choice, a switch, on a paid node (priced at its dearest,
 * R3) or a picture effect (its work judged at its turn, before any pixel).
 * What is sent is held to that bound at the node's turn
 * (server/runner/stopGapWords.ts wiredValueOutOfRange): out of it, the node
 * fails before any call. Anything else (a free text, a model choice that picks
 * the service, a setting the start passes must read: video and sound effects,
 * R7's local-model nodes, cards) has none.
 */
export function wiredDearestBound(classType: string, rule: RunnerNodeRule, spec: RunnerWidgetSpec | undefined): boolean {
  if (!spec) return false
  const bounded = spec.type === 'BOOLEAN' || (spec.type === 'COMBO' && !!spec.options?.length)
    || ((spec.type === 'INT' || spec.type === 'FLOAT') && spec.min !== undefined && spec.max !== undefined)
  if (!bounded) return false
  // R7's local-model nodes: their start passes read the setting as a number (no bound): refused instead.
  if (isLocalModelClass(classType)) return false
  return rule.local === undefined || Object.prototype.hasOwnProperty.call(EFFECT_FAMILY_OF, classType)
}

/**
 * Fix round 2 (N1): a card's own value (withStaticWiredSettings's) that the
 * setting can't take, with its words, or null. Never sent: refused before the
 * hold, as ComfyUI refuses it.
 */
export function staticWiredValueError(prompt: ApiPrompt, classType: string, name: string, link: ApiLink, spec: RunnerWidgetSpec): string | null {
  const known = staticValueOf(prompt, throughGates(prompt, link))
  if (!known) return null
  const value = known.kind === 'text' ? known.text : known.value
  const err = widgetError({ [name]: value }, name, spec)
  return err === null || err === 'wired' ? null : wiredValueOutOfRangeWords(shownLabel(classType, name), value, spec)
}

/** The input a row keyed by model reads its model from, where it is a plain `model` setting (not Lip-sync's engine). */
const modelSetting = (classType: string, rule: RunnerNodeRule | undefined): string | null =>
  rule?.models && classType !== 'LipSyncNode' ? 'model' : null

/** Follows a wire back through Gates (a Gate hands its value on as it came). */
function throughGates(prompt: ApiPrompt, link: ApiLink): ApiLink {
  let l = link
  for (let i = 0; i < 64; i++) {
    const n = prompt[l[0]]
    const d = n?.class_type === GATE_CLASS ? n.inputs?.data_in : undefined
    if (!isLink(d)) return l
    l = d
  }
  return l
}

/**
 * Fix round 1 (M1): the workflow with every wired setting whose value a card
 * decides before the run (a Primitive, a Text card, through Gates;
 * #shared/runner/staticValues) put in as if typed, where it is a valid value
 * for that setting. The run then judges, prices and runs it as typed (the
 * node's turn would substitute the same value, server/runner/values.ts
 * withWiredValues). A value the run makes stays wired.
 */
export function withStaticWiredSettings(prompt: ApiPrompt, families: ReadonlySet<RunnerFamily>): ApiPrompt {
  let out: ApiPrompt | null = null
  for (const [id, node] of Object.entries(prompt)) {
    const rule = runnerRuleFor(node.class_type, node.inputs ?? {}, families)
    if (!rule) continue
    let inputs: Record<string, unknown> | null = null
    for (const [name, v] of Object.entries(node.inputs ?? {})) {
      if (!isLink(v) || rule.valueInputs?.[name]) continue
      const spec = rule.widgets?.[name]
      if (!spec && modelSetting(node.class_type, rule) !== name) continue
      const known = staticValueOf(prompt, throughGates(prompt, v))
      if (!known) continue
      const value = known.kind === 'text' ? known.text : known.value
      if (spec && widgetError({ [name]: value }, name, spec) !== null) continue
      inputs ??= { ...node.inputs }
      inputs[name] = value
    }
    if (inputs) {
      out ??= { ...prompt }
      out[id] = { ...node, inputs }
    }
  }
  return out ?? prompt
}

/** The plain words for a refusing input check that failed (PLAIN_REFUSAL_CHECKS). */
function checkRefusal(check: InputCheckName, classType: string, inputs: Record<string, unknown>): { code: RunnerReasonCode; message: string } {
  switch (check) {
    // Fix round 1 (m3): a label SAM 3 can't be sent has its own words; anything else, the brief's pointsFail.
    case 'sam-points': {
      const read = parseMaskPoints(inputs.points, 2, 2)
      return { code: 'click-points', message: !read.ok && read.why === 'label' ? SAM_MASK_WORDS.pointsLabel : SAM_MASK_WORDS.pointsFail }
    }
    case 'ascii-glyphs':
      return asciiRampOf(inputs.preset, inputs.characters) === null
        ? { code: 'odd-text', message: oddSettingWords(shownLabel(classType, 'characters')) }
        : { code: 'letters', message: LETTERS_WORDS }
    case 'effect-text': {
      const field = effectTextNotPortable(classType, inputs)
      return { code: 'odd-text', message: field ? oddSettingWords(shownLabel(classType, field)) : ODD_SETTING_WORDS }
    }
    case 'painter': return { code: 'odd-text', message: painterFileIsPortable(inputs.mask) ? oddSettingWords(shownLabel(classType, 'bg_color')) : oddTextWords('painter file’s name') }
    case 'moodboard-reading': return { code: 'odd-text', message: oddTextWords('moodboard’s reading') }
    case 'bake-params': return { code: 'odd-text', message: 'This node’s saved settings can’t be read here. Set them again on the node.' }
    case 'lip-sync-media': return { code: 'not-a-file', message: lipSyncEngineMediaWords(inputs) ?? LIPSYNC_UPLOAD_SOUND }
    case 'lipsync-silence-video': return { code: 'not-a-file', message: LIPSYNC_SILENCE_NEEDS_UPLOAD }
    default: return { code: 'odd-text', message: ODD_SETTING_WORDS }
  }
}

/**
 * Why the runner refuses this one node in plain words (it takes it only with
 * `plainRefusals`), or null: the node is taken as it is, or not at all.
 */
export function nodeStopGap(prompt: ApiPrompt, id: string, families: ReadonlySet<RunnerFamily>, opts: RunnerEligibilityOptions = {}): StopGapRefusal | null {
  const n = prompt[id]
  if (!n) return null
  const strict = { ...opts, plainRefusals: false }
  if (runnerTakesNode(prompt, id, families, strict)) return null
  if (!runnerTakesNode(prompt, id, families, { ...opts, plainRefusals: true })) return null
  const inputs = n.inputs ?? {}
  const out = (code: RunnerReasonCode, message: string): StopGapRefusal => ({ nodeId: id, classType: n.class_type, code, message })
  // Row 15: a clip's frames into a picture input.
  const kinds = outputKindsFor(families)
  for (const l of linksOf(n)) {
    if (outputKind(prompt, [l.from, l.slot], kinds) === 'frames' && clipIntoPictureInput(n.class_type, l.input, families)) return out('clip-into-picture', CLIP_INTO_PICTURE_WORDS)
  }
  const rule = runnerRuleFor(n.class_type, inputs, families)
  if (rule?.inputCheck) {
    const ctx: InputCheckContext = { classType: n.class_type, nodeId: id, hosted: !!opts.hosted, prompt, families }
    const names: readonly InputCheckName[] = typeof rule.inputCheck === 'string' ? [rule.inputCheck] : rule.inputCheck
    for (const name of names) {
      if (PLAIN_REFUSAL_CHECKS.has(name) && !INPUT_CHECKS[name]!(inputs, ctx)) {
        const r = checkRefusal(name, n.class_type, inputs)
        return out(r.code, r.message)
      }
    }
  }
  // Row 17, as ruled in fix round 1 (M1): what is still wired here is a value the run makes (a card's own value
  // was put in before the start, withStaticWiredSettings), or an object where a value belongs.
  const wiredSettings: [string, RunnerWidgetSpec | undefined][] = Object.entries(rule?.widgets ?? {})
  const model = modelSetting(n.class_type, rule)
  if (model) wiredSettings.push([model, undefined])
  let lenient = false
  for (const [name, spec] of wiredSettings) {
    if (rule?.valueInputs?.[name]) continue
    const v = inputs[name]
    if (spec ? widgetError(inputs, name, spec) !== 'wired' : !isLink(v)) continue
    lenient = true
    // m2: an object value (`{"__value__": …}`) isn't wired: its value can't be read.
    if (!isLink(v)) return out('odd-text', oddSettingWords(shownLabel(n.class_type, name)))
    // N1: a card's own value the setting can't take (left wired by withStaticWiredSettings): refused, never sent.
    const badStatic = spec ? staticWiredValueError(prompt, n.class_type, name, v, spec) : null
    if (badStatic) return out('wired-setting', badStatic)
    const named = ROW_17_NAMED[n.class_type]?.includes(name) ?? false
    if (named || !rule || !wiredDearestBound(n.class_type, rule, spec)) return out('wired-setting', wiredSettingWords(shownLabel(n.class_type, name)))
  }
  // A value the run makes, with a dearest bound: taken (priced at its dearest, substituted at the node's turn).
  if (lenient) return null
  // m4: taken only leniently for a reason no word above names.
  return out('odd-text', ODD_SETTING_WORDS)
}

/** The first node of the prompt the runner refuses in plain words (nodeStopGap), in prompt order, or null. */
export function stopGapRefusal(prompt: ApiPrompt | null | undefined, families: ReadonlySet<RunnerFamily>, opts: RunnerEligibilityOptions = {}): StopGapRefusal | null {
  if (!prompt) return null
  for (const id of Object.keys(prompt)) {
    const r = nodeStopGap(prompt, id, families, opts)
    if (r) return r
  }
  return null
}

/**
 * Row 25: the nodes the runner doesn't take only because a family is off
 * (with every family on, it would take them), in prompt order. Until R10.0
 * switches every family on, these still go to the engine, with words.
 * `on`: the families that would be on (default: every family Sailor knows).
 */
export function switchedOffNodes(prompt: ApiPrompt | null | undefined, families: ReadonlySet<RunnerFamily>, on: ReadonlySet<RunnerFamily> = EVERY_KNOWN_FAMILY): string[] {
  if (!prompt) return []
  const all = new Set<RunnerFamily>([...families, ...on])
  const lenient = { plainRefusals: true }
  return Object.keys(prompt).filter((id) => {
    if (runnerTakesNode(prompt, id, families, lenient) || !runnerTakesNode(prompt, id, all, lenient)) return false
    // Its own family is the one off (not only a neighbour's: that neighbour is named instead).
    const own = ownRuleFamilies(prompt[id]!.class_type, prompt[id]!.inputs ?? {}, all)
    return own.length > 0 && own.every(f => !familyOn(f, families))
  })
}
