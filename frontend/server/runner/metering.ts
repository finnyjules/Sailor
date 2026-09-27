/**
 * Per-stage money for the runner (hosted only). Order before a stage runs is
 * the same as meterGraphSubmit's: spending pause → your files → content check
 * → price → hold. The hold is an upper bound (every generator the stage may
 * run); the charge is exactly what was made. Nothing is held while paused.
 *
 * Prices come from the one price table priceGraph already reads
 * (app/data/image-models.ts, shared/pricing/videoRates.ts) — the runner cannot
 * run a model without a price because priceGraph throws for one, and a
 * provider node that prices at 0 is refused in hosted (unpricedProviderNode).
 */
import type { ApiNode, ApiPrompt } from '#shared/runner/graph'
import { LOCAL_RENDER_TYPES, PROVIDER_TYPES } from '#shared/runner/eligibility'
import { BASE_RENDER_CREDITS, OUTPUT_CLASS_TYPES, priceGraph } from '../utils/priceBook'
import { extractGraphPromptTexts } from '../utils/graphPromptText'
import { MeterRefusalError } from '../utils/requestMeter'
import { moderateTexts, moderationRefusal, type ModerationResult } from '../utils/moderation'
import { outputKey } from '../utils/graphRuns'
import { actionPassThrough } from './generators/actions'
import type { OutputFile, StageCharge } from './types'
import { sizePricedInput } from '#shared/pricing/editSettings'
import { paidNoCall } from '#shared/pricing/paidSettings'
import { isLink } from '#shared/runner/graph'
import { picturePixels } from '../utils/graphInputPixels'
import { NO_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import type { InputSeconds } from '#shared/pricing/clipSettings'

/**
 * Credits for one provider node. `inputPixels`: the measured size of the
 * picture a size-priced node (FLUX.2 edit) is sent — without it, the input cap
 * (the stage hold is taken that way, an upper bound). `families`: the
 * server's switches, so a class moved onto a newer model (Rotate camera on
 * Qwen Image Edit 2511, Task F10) is priced as it is planned. `inputSeconds`:
 * the measured lengths of a lip-sync's sound and video (sync-3, Task F22:
 * sync3Media.ts) — without them, the 60 s cap (the hold).
 */
export function nodeCredits(node: ApiNode, inputPixels?: number, families: ReadonlySet<RunnerFamily> = NO_FAMILIES, inputSeconds?: InputSeconds): number {
  if (!PROVIDER_TYPES.has(node.class_type)) return 0
  const p = priceGraph({ n: { class_type: node.class_type, inputs: node.inputs } }, {
    ...(inputPixels ? { inputPixels: { n: inputPixels } } : {}),
    ...(inputSeconds ? { inputSeconds: { n: inputSeconds } } : {}),
    families,
  })
  return p.breakdown.filter(b => b.action !== 'base_render').reduce((s, b) => s + b.credits, 0)
}

/**
 * The size of the picture a size-priced node is about to be sent: the first
 * file on its linked output slot (the one every builder sends, as Python
 * sends only the first frame of a batch), measured from its header
 * (picturePixels, the gate's own reader: PNG, JPEG, WebP, GIF, TIFF, BMP,
 * AVIF and HEIC). `pixels` is undefined when the node isn't size-priced, has
 * no file, or the file can't be read or sized (it is then priced at the
 * cap); `unreadable` is true only for a file that was read but whose size
 * couldn't be (Task G1: hosted refuses that node, requestRules.ts
 * unreadableInputWords). The runner measures before it submits, so the
 * charge reads the real size, and a picture above the cap is refused
 * (requestRules.ts measuredInputProblem) whatever the batch's length.
 */
export async function measuredInput(
  node: ApiNode,
  filesFrom: (link: [string, number]) => OutputFile[],
  read: (f: OutputFile) => Promise<Uint8Array>,
  families: ReadonlySet<RunnerFamily> = NO_FAMILIES,
): Promise<{ pixels?: number, unreadable: boolean }> {
  const inputs = node.inputs ?? {}
  const name = sizePricedInput(node.class_type, inputs, families)
  const link = name ? inputs[name] : undefined
  if (!isLink(link)) return { unreadable: false }
  const sent = filesFrom(link as [string, number])[0]
  if (!sent) return { unreadable: false }
  let bytes: Uint8Array
  // A file that can't be read is left to the hand-off, which reads it too (and fails).
  try { bytes = await read(sent) }
  catch { return { unreadable: false } }
  const px = await picturePixels(bytes)
  return px != null && px > 0 ? { pixels: px, unreadable: false } : { unreadable: true }
}

/** measuredInput's size alone: undefined when it couldn't be measured (priced at the cap). */
export async function measuredInputPixels(
  node: ApiNode,
  filesFrom: (link: [string, number]) => OutputFile[],
  read: (f: OutputFile) => Promise<Uint8Array>,
  families: ReadonlySet<RunnerFamily> = NO_FAMILIES,
): Promise<number | undefined> {
  return (await measuredInput(node, filesFrom, read, families)).pixels
}

/**
 * The first provider node that prices at 0 or less, or null. The runner's
 * copy of UnpricedGraphError: a class the price book misses by name prices at
 * 0 (priceGraph only refuses the names it knows are providers), and such a
 * node must be refused in hosted, never run free. An unpriced MODEL throws
 * UnpricedGraphError from nodeCredits, as before.
 */
export function unpricedProviderNode(
  prompt: ApiPrompt,
  providers: ReadonlySet<string> = PROVIDER_TYPES,
  price: (node: ApiNode) => number = nodeCredits,
): string | null {
  for (const [id, n] of Object.entries(prompt)) {
    if (providers.has(n.class_type) && !(price(n) > 0)) return id
  }
  return null
}

/**
 * Text inputs the edit nodes carry besides the prompt, moderated by the
 * runner too. Runner only: extractGraphPromptText (the Python path's check)
 * is left as it is (plan decision D8).
 */
export const RUNNER_EXTRA_TEXT_INPUTS: readonly string[] = ['target', 'find', 'replace', 'color', 'instructions', 'scene_prompt']

/**
 * A typed-in taste (a literal style_in) goes into the provider prompt of
 * these classes, so it is moderated too. A wired one (R1.2) is moderated as
 * every wired text is: at the start when a card's settings decide it
 * (staticWiredTexts), else at the node's turn. Every other class's
 * moderation is unchanged.
 */
export const TASTE_TEXT_CLASSES: ReadonlySet<string> = new Set(['RestyleFromImageNode', 'GenerateImageNode'])
export const TASTE_TEXT_INPUTS: readonly string[] = ['style_in']

/**
 * The inputs of each paid-model class (step 3, R3) whose text reaches a
 * provider (rule 10), moderated at the start when typed; a wired one is
 * moderated as every wired text is (at the start when a card's settings
 * decide it, else at the node's turn, R0.5). Text Sailor writes itself
 * (system prompts, templates) is not listed. Filled by each R3 task. Read by
 * both paths' start checks (extraPromptTexts).
 */
export const PAID_TEXT_INPUTS: Readonly<Record<string, readonly string[]>> = {
  // R3.3, the LLM text nodes (Sailor's system prompts are not listed; Translate's custom language is the user's).
  ChatLLMNode: ['prompt', 'system_prompt'],
  ImprovePromptNode: ['idea'],
  SummarizeTextNode: ['text'],
  TranslateTextNode: ['text', 'custom_language'],
  RewriteToneNode: ['text'],
  BrainstormIdeasNode: ['topic'],
  ReasonStepByStepNode: ['question'],
  // R3.4, describe, read and find (Extract text sends no text).
  DescribeImageNode: ['prompt'],
  DescribeImageRemoteNode: ['prompt'],
  DescribeVideoNode: ['prompt'],
  FindObjectsNode: ['query'],
}

/** The non-blank values of RUNNER_EXTRA_TEXT_INPUTS (a typed-in taste, a paid class's PAID_TEXT_INPUTS) across the prompt, each on its own. */
export function extraPromptTexts(prompt: ApiPrompt): string[] {
  const parts: string[] = []
  for (const node of Object.values(prompt ?? {})) {
    const inputs = node?.inputs
    if (!inputs || typeof inputs !== 'object') continue
    const paid = Object.prototype.hasOwnProperty.call(PAID_TEXT_INPUTS, node.class_type) ? PAID_TEXT_INPUTS[node.class_type]! : []
    const names = new Set([...RUNNER_EXTRA_TEXT_INPUTS, ...(TASTE_TEXT_CLASSES.has(node.class_type) ? TASTE_TEXT_INPUTS : []), ...paid])
    for (const name of names) {
      const v = inputs[name]
      if (typeof v === 'string' && v.trim()) parts.push(v)
    }
  }
  return parts
}

/** The same texts joined with spaces (what a generation record shows). */
export function extraPromptText(prompt: ApiPrompt): string {
  return extraPromptTexts(prompt).join(' ')
}

export function hasOutputNode(prompt: ApiPrompt): boolean {
  return Object.values(prompt).some(n => OUTPUT_CLASS_TYPES.has(n.class_type))
}

/**
 * The hold for one stage: every node that may make a call, plus the render
 * credit. A nano-actions node that will hand its picture on (actionPassThrough,
 * the same rule planNode follows) makes no call and is not held, nor is a
 * paid node whose inputs as sent make Python return before calling anyone
 * (paidNoCall, R3 rule 8). The render
 * credit is only ever charged on top of something made (a provider result,
 * or a finished Frame render: the Frame itself is free, but its stage pays
 * the render credit, as on the Python path), so a stage that can make
 * nothing holds nothing. `measured`: the lengths the start of the run
 * measured for sync-3 lip-syncs (TakeRecord.measured, F22 fix round 1), so the
 * hold is their price; a node with none holds the 60 s cap.
 */
export function stageEstimate(
  prompt: ApiPrompt, nodeIds: Iterable<string>, includeBase: boolean, families: ReadonlySet<RunnerFamily> = NO_FAMILIES,
  measured?: Readonly<Record<string, { seconds: InputSeconds }>>,
): number {
  let total = 0
  let renders = false
  for (const id of nodeIds) {
    const n = prompt[id]
    if (!n) continue
    if (LOCAL_RENDER_TYPES.has(n.class_type)) renders = true
    else if (!actionPassThrough(n.class_type, n.inputs ?? {}) && !paidNoCall(n.class_type, n.inputs ?? {})) {
      const m = measured && Object.prototype.hasOwnProperty.call(measured, id) ? measured[id] : undefined
      total += nodeCredits(n, undefined, families, m?.seconds)
    }
  }
  return includeBase && (total > 0 || renders) ? total + BASE_RENDER_CREDITS : total
}

export interface LedgerPort {
  hold(userId: string, credits: number, key: string): Promise<{ ok: true; holdId: number } | { ok: false; reason: 'insufficient' }>
  settle(holdId: number, actual: number, reason: string): Promise<{ settled: boolean }>
  release(holdId: number): Promise<void>
  getAvailable(userId: string): Promise<number>
}

export interface GraphRunsPort {
  create(r: { promptId: string; userId: string; credits: number; holdId: number | null; target: string }): Promise<void>
  appendOutput(promptId: string, key: string): Promise<void>
  resolve(promptId: string, state: 'settled' | 'voided'): Promise<void>
}

export interface Metering {
  spendGuard(userId: string | null): Promise<void>
  /** Hosted: the typed prompts, plus `extra` (texts wired from cards, known at the start). */
  moderate(prompts: ApiPrompt[], extra?: readonly string[]): Promise<void>
  /** Hosted: one text a wire brought into a node at its turn (R0.5). */
  moderateText(text: string): Promise<void>
  /** Returns the hold id, or null when nothing was held. Throws 402 when credits run short. */
  hold(userId: string | null, stageKey: string, credits: number): Promise<number | null>
  addOutput(userId: string | null, stageKey: string, file: OutputFile): Promise<void>
  /** Charge `actual` (0 → drop the hold). Mutates `charge`. */
  finish(userId: string | null, charge: StageCharge, actual: number): Promise<void>
}

export function createMetering(d: {
  hosted(): boolean
  ledger(): LedgerPort
  graphRuns: GraphRunsPort
  spendGuard(userId: string): Promise<void>
  /** Hosted, fail-closed: a not-ok result may be blocked, unavailable or too long (G3). */
  moderate(text: string): Promise<ModerationResult>
}): Metering {
  return {
    async spendGuard(userId) {
      if (!d.hosted()) return
      if (!userId) throw new MeterRefusalError('Sign in to run workflows', 401)
      await d.spendGuard(userId)
    },
    async moderate(prompts, extra = []) {
      if (!d.hosted()) return
      // Each text is its own moderation call — every node's prompt and every
      // extra, never joined across nodes or extras — so a short harmful phrase
      // beside long harmless text is judged on its own, and the size limit is
      // per text (G3 follow-up). Identical texts are checked once; all checks
      // run at once, refusing on the first not-ok result.
      const texts = [...prompts.flatMap(p => [...extractGraphPromptTexts(p), ...extraPromptTexts(p)]), ...extra]
      const mod = await moderateTexts(texts, d.moderate)
      if (!mod.ok) throw moderationRefusal(mod)
    },
    async moderateText(text) {
      if (!d.hosted() || !text.trim()) return
      const mod = await d.moderate(text)
      if (!mod.ok) throw moderationRefusal(mod)
    },
    async hold(userId, stageKey, credits) {
      if (!d.hosted() || !userId) return null
      let holdId: number | null = null
      if (credits > 0) {
        let res: Awaited<ReturnType<LedgerPort['hold']>>
        try {
          res = await d.ledger().hold(userId, credits, `runner:${stageKey}`)
        }
        catch (e) {
          console.error('[runner] hold failed — refusing as insufficient credits', { userId, credits, error: e })
          throw new MeterRefusalError('Not enough credits', 402, { required: credits, available: 0 })
        }
        if (!res.ok) {
          const available = await d.ledger().getAvailable(userId).catch(() => 0)
          throw new MeterRefusalError('Not enough credits', 402, { required: credits, available })
        }
        holdId = res.holdId
      }
      try {
        await d.graphRuns.create({ promptId: stageKey, userId, credits, holdId, target: 'runner' })
      }
      catch (e) {
        console.error('[runner] graph run row failed — results may not be viewable', { stageKey, error: e })
      }
      return holdId
    },
    async addOutput(userId, stageKey, file) {
      if (!d.hosted() || !userId) return
      try {
        await d.graphRuns.appendOutput(stageKey, outputKey(file))
      }
      catch (e) {
        console.error('[runner] output ownership row failed — result may not be viewable', { stageKey, error: e })
      }
    },
    async finish(userId, charge, actual) {
      charge.finished = true
      if (!d.hosted() || !userId) {
        charge.state = charge.holdId == null ? 'free' : charge.state
        return
      }
      if (actual > 0 && charge.holdId != null) {
        const s = await d.ledger().settle(charge.holdId, actual, `runner:${charge.stageKey}`)
        if (!s.settled) {
          // The hold was already released (e.g. a stale retry) — no money moved, so
          // this must not read as a completed charge, even though the files were made.
          console.error('[runner] SETTLE ON RELEASED HOLD — stage shipped uncharged', { stageKey: charge.stageKey, actual })
          charge.state = 'released'
          charge.actual = 0
        }
        else {
          charge.state = 'settled'
          charge.actual = actual
        }
      }
      else {
        if (charge.holdId != null) await d.ledger().release(charge.holdId)
        charge.state = charge.holdId == null ? 'free' : 'released'
        charge.actual = 0
      }
      await d.graphRuns.resolve(charge.stageKey, actual > 0 ? 'settled' : 'voided')
        .catch(e => console.error('[runner] graph run resolve failed', { stageKey: charge.stageKey, error: e }))
    },
  }
}
