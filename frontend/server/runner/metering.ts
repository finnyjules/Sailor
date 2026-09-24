/**
 * Per-stage money for the runner (hosted only). Order before a stage runs is
 * the same as meterGraphSubmit's: spending pause → your files → content check
 * → price → hold. The hold is an upper bound (every generator the stage may
 * run); the charge is exactly what was made. Nothing is held while paused.
 *
 * Prices come from the one price table priceGraph already reads
 * (app/data/image-models.ts, app/data/video-prices.ts) — the runner cannot
 * run a model without a price because priceGraph throws for one, and a
 * provider node that prices at 0 is refused in hosted (unpricedProviderNode).
 */
import type { ApiNode, ApiPrompt } from '#shared/runner/graph'
import { PROVIDER_TYPES } from '#shared/runner/eligibility'
import { BASE_RENDER_CREDITS, OUTPUT_CLASS_TYPES, priceGraph } from '../utils/priceBook'
import { extractGraphPromptText } from '../utils/graphPromptText'
import { MeterRefusalError } from '../utils/requestMeter'
import { outputKey } from '../utils/graphRuns'
import type { OutputFile, StageCharge } from './types'

export function nodeCredits(node: ApiNode): number {
  if (!PROVIDER_TYPES.has(node.class_type)) return 0
  const p = priceGraph({ n: { class_type: node.class_type, inputs: node.inputs } })
  return p.breakdown.filter(b => b.action !== 'base_render').reduce((s, b) => s + b.credits, 0)
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

/** The non-blank values of RUNNER_EXTRA_TEXT_INPUTS across the prompt, joined. */
export function extraPromptText(prompt: ApiPrompt): string {
  const parts: string[] = []
  for (const node of Object.values(prompt ?? {})) {
    const inputs = node?.inputs
    if (!inputs || typeof inputs !== 'object') continue
    for (const name of RUNNER_EXTRA_TEXT_INPUTS) {
      const v = inputs[name]
      if (typeof v === 'string' && v.trim()) parts.push(v)
    }
  }
  return parts.join(' ')
}

export function hasOutputNode(prompt: ApiPrompt): boolean {
  return Object.values(prompt).some(n => OUTPUT_CLASS_TYPES.has(n.class_type))
}

export function stageEstimate(prompt: ApiPrompt, nodeIds: Iterable<string>, includeBase: boolean): number {
  let total = includeBase ? BASE_RENDER_CREDITS : 0
  for (const id of nodeIds) {
    const n = prompt[id]
    if (n) total += nodeCredits(n)
  }
  return total
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
  moderate(prompts: ApiPrompt[]): Promise<void>
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
  moderate(text: string): Promise<{ ok: true } | { ok: false; categories: string[] }>
}): Metering {
  return {
    async spendGuard(userId) {
      if (!d.hosted()) return
      if (!userId) throw new MeterRefusalError('Sign in to run workflows', 401)
      await d.spendGuard(userId)
    },
    async moderate(prompts) {
      if (!d.hosted()) return
      const text = [...new Set(prompts.flatMap(p => [extractGraphPromptText(p), extraPromptText(p)]).filter(Boolean))].join(' ')
      if (!text) return
      const mod = await d.moderate(text)
      if (!mod.ok) throw new MeterRefusalError('This prompt was blocked by content moderation', 400, { categories: mod.categories })
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
