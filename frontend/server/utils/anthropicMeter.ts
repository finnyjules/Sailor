/**
 * Flat-rate metering for the Anthropic "assist" family (accounts spec
 * Stage 4, Task 6) — vibe, explain, copy-assist, font-suggest,
 * pipeline-suggest, agent-plan, agent-review, wardrobe/describe,
 * style-profile/fable, and taste/read. These are short single-message
 * Claude calls (Haiku/Sonnet/Fable, <=2048 tokens) that don't route through
 * runReplicate/runFal or the graph pricer, so — like Task 4's bypass routes
 * — they need their own chokepoint. This mirrors requestMeter.ts's
 * preflight-then-debit shape but skips the settle-on-success ticket: see
 * meterAssist's own doc for why.
 *
 * holdForModelCall (below) is the per-call TOKEN meter for Anthropic calls too
 * large for the flat rate (/api/shader-gen): hold the worst case, settle to the
 * real usage — priced by anthropicPrices.ts.
 */
import { randomUUID } from 'node:crypto'
import type { H3Event } from 'h3'
import { deployMode } from './deployMode'
import { currentMeterContext, getLedger, holdOrRefuse, MeterRefusalError } from './requestMeter'
import { assertSpendAllowed } from './systemControls'
import { captureError } from './observe'
import { creditsForUsd, usdForUsage, type AnthropicUsage } from './anthropicPrices'

// Flat rate — covers ~$0.01 median at 2x markup; per-token metering is noise at this price
export const ANTHROPIC_ASSIST_CREDITS = 2

/**
 * Call after a route's auth/rate-limit section, before its Anthropic fetch.
 *
 * Local mode: no-op (byte-identical to pre-metering behavior — no ledger
 * touched at all).
 *
 * Hosted mode: reads the userId the auth middleware already bound to this
 * request's meter context (requestMeter.ts's currentMeterContext). A
 * missing context here means an authed route ran with no bound identity —
 * an invariant break in our own wiring, not a client mistake (a genuinely
 * unauthenticated caller is already turned away with 401 by the auth
 * middleware before this ever runs) — so this fails closed with 500 rather
 * than a 401, per requestMeter's own "unmetered spend refused" convention
 * for preflightMeter.
 *
 * Preflights available balance >= ANTHROPIC_ASSIST_CREDITS (402 with
 * {required, available} on shortfall), then debits IMMEDIATELY rather than
 * returning a settle-later ticket: these calls are cheap and sub-second,
 * and the ten call sites don't share a single success/failure shape the way
 * a provider-job ticket would. Worst case a failed Anthropic call still
 * over-charges 2cr — accepted for now; a settle-on-success variant is a
 * fair hardening rider if that proves costly in practice.
 */
export async function meterAssist(event: H3Event): Promise<void> {
  void event // signature parity with other per-request gates (assertRateLimit); no per-event data needed today

  if (deployMode() === 'local') return

  const ctx = currentMeterContext()
  if (!ctx) throw new MeterRefusalError('unmetered spend refused', 500)

  // Operator safety valves (Stage 7 final review C1, secondary bypass): the
  // flat-rate assist path debited without ever consulting the kill-switch /
  // per-user disable / daily ceiling, so a paused system kept spending here.
  // Refuse (503) BEFORE the debit. assertSpendAllowed is a no-op in local mode.
  await assertSpendAllowed(ctx.userId)

  const ledger = getLedger()
  const available = await ledger.getAvailable(ctx.userId)
  if (available < ANTHROPIC_ASSIST_CREDITS) {
    throw new MeterRefusalError('insufficient credits', 402, { required: ANTHROPIC_ASSIST_CREDITS, available })
  }

  await ledger.debit(ctx.userId, ANTHROPIC_ASSIST_CREDITS, 'anthropic_assist', `assist:${randomUUID()}`)
}

/**
 * A ledger hold on one Anthropic call, metered from the call's REAL token
 * usage. Exactly one of settleUsage/release must be called:
 *  - settleUsage(usage) — the model answered (even if its answer is later
 *    unusable: the tokens were still paid for). Charges the real cost × markup,
 *    capped at the hold, and returns the credits charged. Never throws.
 *  - release() — the call failed before the model produced a reply. Never
 *    throws.
 */
export interface ModelCallTicket {
  readonly holdId: number
  readonly credits: number
  settleUsage(usage: AnthropicUsage | null | undefined): Promise<number>
  release(): Promise<void>
}

function hasTokenCounts(usage: AnthropicUsage | null | undefined): usage is AnthropicUsage {
  return !!usage && (typeof usage.input_tokens === 'number' || typeof usage.output_tokens === 'number')
}

/**
 * Per-call token metering for Anthropic routes whose calls are too large for
 * meterAssist's flat 2 credits (today /api/shader-gen: up to 10,000 output
 * tokens per call). Holds the call's worst case (`maxCredits`, from
 * anthropicPrices.maxCreditsForCall) BEFORE the call, then settles to the real
 * usage — the same hold → settle / release flow and failure semantics as
 * requestMeter's preflightMeter:
 *  - local mode: null, no ledger touched;
 *  - hosted, no bound context: 500 "unmetered spend refused" (fail closed);
 *  - operator spend guard BEFORE the hold;
 *  - no wallet / not enough credits: 402 {required, available}.
 *
 * The route must refuse an unpriced model BEFORE calling this (so a hold is
 * never taken for a call we can't price).
 */
export async function holdForModelCall(model: string, maxCredits: number): Promise<ModelCallTicket | null> {
  if (deployMode() === 'local') return null

  const ctx = currentMeterContext()
  if (!ctx) throw new MeterRefusalError('unmetered spend refused', 500)
  const userId = ctx.userId

  await assertSpendAllowed(userId)

  const ledger = getLedger()
  const holdId = await holdOrRefuse(ledger, userId, maxCredits, `anthropic:${randomUUID()}`, model)
  const reason = `anthropic:${model}`

  return {
    holdId,
    credits: maxCredits,
    async settleUsage(usage): Promise<number> {
      let charge = maxCredits
      if (!hasTokenCounts(usage)) {
        // A reply with no usage is still a paid call — charge the hold, never free.
        console.error('[meter] ANTHROPIC REPLY WITHOUT USAGE — charging the full hold', { userId, model, holdId, credits: maxCredits })
        captureError(new Error('meter: anthropic reply without usage — charged the full hold'), { site: 'holdForModelCall', userId, model, holdId, credits: maxCredits })
      } else {
        const usd = usdForUsage(model, usage)
        if (usd === null) {
          console.error('[meter] UNPRICED MODEL AT SETTLE — charging the full hold', { userId, model, holdId, credits: maxCredits })
          captureError(new Error('meter: unpriced anthropic model at settle — charged the full hold'), { site: 'holdForModelCall', userId, model, holdId, credits: maxCredits })
        } else {
          const actual = creditsForUsd(usd)
          if (actual > maxCredits) {
            // The hold is the ceiling: the estimate undershot, Sailor absorbs the rest.
            console.warn('[meter] anthropic call cost more than its hold — charging the hold', { userId, model, holdId, actualCredits: actual, heldCredits: maxCredits })
          } else {
            charge = actual
          }
        }
      }

      try {
        const r = await ledger.settleHold(holdId, charge, reason)
        if (!r.settled) {
          // Already released (holdSweep's TTL, or a double-release) — the
          // reply shipped and nobody paid.
          console.error('[meter] SETTLE ON RELEASED HOLD — output shipped uncharged', { userId, model, credits: charge, holdId })
          captureError(new Error('meter: settle on released hold — output shipped uncharged'), { site: 'holdForModelCall', userId, model, credits: charge, holdId })
        }
      } catch (e) {
        // Never turn a delivered reply into a user-facing error.
        console.error('[meter] SETTLE FAILED after successful anthropic call', { userId, model, credits: charge, holdId, error: e })
        captureError(e, { site: 'holdForModelCall', userId, model, credits: charge, holdId })
      }
      return charge
    },
    async release(): Promise<void> {
      // Runs on failure paths that are already throwing — never replace the
      // caller's real error with a ledger error.
      try {
        await ledger.releaseHold(holdId)
      } catch (e) {
        console.error('[meter] HOLD RELEASE FAILED', { userId, model, holdId, error: e })
      }
    },
  }
}
