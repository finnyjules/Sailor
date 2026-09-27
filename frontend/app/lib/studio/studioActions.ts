// Studio inspector actions (spec §1.4, §2.4, §7.3), redesigned 2026-09-25 after
// Julien's review ("every button seems to do the same thing"): a short list of
// rows that each do something DIFFERENT, each with a plain name, a one-line
// description of what comes back, and the price. No Edit / Develop headings.
//
// What is NOT a row: "Tune…". It only put a Tune chip in the prompt, and typing
// in the prompt already does that — so the rows end with a hint line pointing at
// the prompt instead (StudioActionRows). A studio adds its own non-AI rows
// (Randomize, Try layouts) as `local`; they follow the AI rows.
import type { ActionLands } from '~/lib/canvas/nodeActions'
import { shaderGenEstimateText } from '~/lib/shadergen/estimate'
import { assistEstimateText } from '~/lib/pricing'
import type { StudioPromptApi } from '~/composables/useStudioPrompt'

/** `add`: a mode whose takes land on a new layer (Shader's "Describe a new layer"). */
export type StudioActionRun = { mode: string; add?: boolean } | { kind: 'tweak'; fromMenu: true } | { call: () => void }
/**
 * One inspector row. `description`: one plain line under the name saying what comes back.
 * `priceFor`: the row's price in credits (local and hosted alike, "30–63 credits") —
 * absent on a row that spends nothing. `lands`: where the result goes (takes / a step), kept
 * for the prompt's own bookkeeping; the row says it in its description.
 * `disabled`: shown but off, with `disabledHint` saying why in a plain sentence.
 */
export interface StudioAction {
  id: string; label: string; description: string; ai: boolean; lands: ActionLands
  priceFor?: (hosted: boolean) => string; run: StudioActionRun
  disabled?: boolean; disabledHint?: string
}

/** The Shader studio's stack is full (LAYER_MAX): no room for a new layer. */
export const LAYERS_FULL = 'The studio holds six layers. Remove one to add another.'
export type StudioActionPlace = 'shader' | 'gradient' | 'shape' | 'texture' | 'vectortype' | 'spacetype' | 'frame'

/** What "Same …" names in each studio's "Try other settings" description. */
const THING: Record<StudioActionPlace, string> = {
  shader: 'effect', gradient: 'gradient', shape: 'shape', texture: 'pattern',
  vectortype: 'lettering', spacetype: 'type', frame: 'frame',
}

/** The line under the rows: typing is how you ask for anything else. */
export const PROMPT_HINT = 'Or type what you want in the prompt below'
/** The same line when a studio has no rows at all (Space type). */
export const PROMPT_HINT_ALONE = 'Type what you want in the prompt below'

/** New dial values, three takes (the prompt's Vary: one takes call, plus a recipe pass or a
 *  see-first review). Only where the studio can show takes. */
function tryOtherSettings(place: StudioActionPlace): StudioAction {
  return {
    id: 'vary', label: 'Try other settings', description: `Same ${THING[place]}, 3 new sets of dial values`,
    ai: true, lands: 'takes', priceFor: h => assistEstimateText(h), run: { kind: 'tweak', fromMenu: true },
  }
}

/** Shader's Remix: new effect code, three takes (spec §7.3). A mode chip; the effect takes run it. */
export const REMIX_ACTION: StudioAction = {
  id: 'remix', label: 'Rewrite the effect', description: '3 new versions of the code itself',
  ai: true, lands: 'takes', priceFor: shaderGenEstimateText, run: { mode: 'Remix' },
}

/** `backgroundIsShader` (Frame): the background is a shader fill, so it can be rewritten. */
export function studioActions(o: { place: StudioActionPlace; canTakes: boolean; local?: StudioAction[]; backgroundIsShader?: boolean }): StudioAction[] {
  const rows: StudioAction[] = []
  if (o.place === 'frame') rows.push({ id: 'write-copy', label: 'Write copy', description: 'New words for the text, from what you ask', ai: true, lands: null, run: { mode: 'Write copy' } })
  if (o.canTakes) rows.push(tryOtherSettings(o.place))
  if (o.place === 'shader') rows.push(REMIX_ACTION)
  // Frame's background is where new effects show in Frame (stage 5, Ruling 10).
  if (o.place === 'frame') {
    rows.push({ id: 'new-background', label: 'Describe a new background', description: '3 new effects, made from your words', ai: true, lands: 'takes', priceFor: shaderGenEstimateText, run: { mode: 'New effect' } })
    if (o.backgroundIsShader) rows.push({ id: 'remix-background', label: 'Rewrite the background', description: '3 new versions of its effect code', ai: true, lands: 'takes', priceFor: shaderGenEstimateText, run: { mode: 'Remix' } })
  }
  return [...rows, ...(o.local ?? [])]
}

/**
 * The Shader studio's Layers "+" menu: an empty layer, or a new one described in words
 * (the old inspector row "New layer from a description…"). `layersFull`: no room, so both
 * are off and say why (the + hides itself then, but the prompt can still ask).
 */
export function layerAddActions(o: { addEmpty: () => void; layersFull?: boolean }): StudioAction[] {
  const full = o.layersFull ? { disabled: true, disabledHint: LAYERS_FULL } : {}
  return [
    { id: 'empty-layer', label: 'Empty layer', description: 'Pick its effect after', ai: false, lands: null, run: { call: o.addEmpty }, ...full },
    { id: 'new-layer', label: 'Describe a new layer', description: '3 new effects, made from your words', ai: true, lands: 'takes', priceFor: shaderGenEstimateText, run: { mode: 'New effect', add: true }, ...full },
  ]
}

export function runStudioAction(a: StudioAction, prompt: Pick<StudioPromptApi, 'setMode' | 'runKind'> | null): void {
  if (a.disabled) return
  const r = a.run
  if ('call' in r) { r.call(); return }
  if ('mode' in r) { prompt?.setMode(r.mode, { add: r.add }); return }
  void prompt?.runKind(r.kind, { fromMenu: true })
}
