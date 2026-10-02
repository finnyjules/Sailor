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
import { linksOf, type ApiPrompt } from './graph'
import { EVERY_KNOWN_FAMILY, familyOn, type RunnerFamily } from './families'
import {
  INPUT_CHECKS, PLAIN_REFUSAL_CHECKS, clipIntoPictureInput, outputKindsFor, ownRuleFamilies, runnerRuleFor, runnerTakesNode, widgetError,
  type InputCheckContext, type InputCheckName, type RunnerEligibilityOptions,
} from './eligibility'
import { outputKind } from './values'
import { asciiRampOf, effectTextNotPortable, painterFileIsPortable } from './effects'
import { SAM_MASK_WORDS } from './localModels'
import { LIPSYNC_SILENCE_NEEDS_UPLOAD, LIPSYNC_UPLOAD_SOUND, lipSyncEngineMediaWords } from './lipSyncEngines'
import {
  CLIP_INTO_PICTURE_WORDS, LETTERS_WORDS, oddTextWords, wiredSettingWords, type RunnerReasonCode,
} from './messages'

export interface StopGapRefusal {
  nodeId: string
  classType: string
  code: RunnerReasonCode
  message: string
}

/** A widget's or input's name as the node shows it: plain words, no underscores. */
export function fieldLabel(name: string): string {
  return name.replace(/_/g, ' ').trim().toLowerCase()
}

/** The plain words for a refusing input check that failed (PLAIN_REFUSAL_CHECKS). */
function checkRefusal(check: InputCheckName, classType: string, inputs: Record<string, unknown>): { code: RunnerReasonCode; message: string } {
  switch (check) {
    case 'sam-points': return { code: 'click-points', message: SAM_MASK_WORDS.pointsFail }
    case 'ascii-glyphs':
      return asciiRampOf(inputs.preset, inputs.characters) === null
        ? { code: 'odd-text', message: oddTextWords('characters') }
        : { code: 'letters', message: LETTERS_WORDS }
    case 'effect-text': return { code: 'odd-text', message: oddTextWords(fieldLabel(effectTextNotPortable(classType, inputs) ?? 'colour')) }
    case 'painter': return { code: 'odd-text', message: oddTextWords(painterFileIsPortable(inputs.mask) ? 'background color' : 'painter file’s name') }
    case 'moodboard-reading': return { code: 'odd-text', message: oddTextWords('moodboard’s reading') }
    case 'bake-params': return { code: 'odd-text', message: 'This node’s saved settings can’t be read here. Set them again on the node.' }
    case 'lip-sync-media': return { code: 'not-a-file', message: lipSyncEngineMediaWords(inputs) ?? LIPSYNC_UPLOAD_SOUND }
    case 'lipsync-silence-video': return { code: 'not-a-file', message: LIPSYNC_SILENCE_NEEDS_UPLOAD }
    default: return { code: 'odd-text', message: oddTextWords('setting') }
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
  for (const [name, spec] of Object.entries(rule?.widgets ?? {})) {
    if (rule?.valueInputs?.[name]) continue
    if (widgetError(inputs, name, spec) === 'wired') return out('wired-setting', wiredSettingWords(fieldLabel(name)))
  }
  // Taken only leniently for a reason not named above: the clip wire (a Gate's) is the one left.
  return out('clip-into-picture', CLIP_INTO_PICTURE_WORDS)
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
