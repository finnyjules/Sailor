/**
 * Request meter core (accounts spec Stage 4, Task 1): per-request billing
 * context + fail-closed price resolution. This is the chokepoint every
 * paid-provider route funnels through before dispatch (preflight) and after
 * a job completes (settle) — later tasks wire auth middleware and routes to
 * these exact names.
 *
 * Context is carried via AsyncLocalStorage rather than threaded through
 * every call signature, because provider dispatch runs many layers below
 * the route handler (agent tools, node executors, etc.) and none of those
 * layers should need a userId parameter added just to make metering work.
 *
 * CRITICAL ALS propagation gotcha (found live during Task 3, verified
 * against real h3 dispatch — see requestMeter.unit.spec.ts's h3-shaped
 * regression test and tests/unit/meter-context-h3-integration.unit.spec.ts):
 * AsyncLocalStorage#enterWith mutates the store for "whatever is currently
 * the active async context frame". A sibling h3 middleware/route handler
 * invoked via a SEPARATE `await` from Nitro's dispatcher subscribes its own
 * continuation once the handler's synchronous prefix suspends — i.e. the
 * dispatcher's continuation is created AFTER that synchronous prefix
 * (which includes the internal `await resolveHostedUserId(event)`'s own
 * suspension), not before it. If bindMeterContext called a *fresh*
 * enterWith AFTER that internal await (the naive approach), the enterWith
 * would run on a continuation descended from the internal await — a frame
 * the dispatcher's own (already-created) continuation is not an ancestor
 * of — so the new store would never reach the next middleware/route
 * handler: verified with a minimal real-h3 repro where a downstream
 * handler saw `null` despite enterWith having already run. enterWith
 * called BEFORE a callee's first internal await, by contrast, DOES
 * propagate correctly to the awaiting caller and everything scheduled
 * after it — because invoking a function runs its synchronous prefix
 * (including any enterWith there) before the caller's `await` even
 * subscribes.
 *
 * The fix: never re-enter after the first await. Store a single mutable
 * BOX (`{ current: MeterContext | null }`) via enterWith, always as the
 * very first synchronous operation of a request (clearMeterContext, called
 * first in auth.ts, before any internal await). Every later update
 * (bindMeterContext, setMeterPriceHint) MUTATES that same box's `.current`
 * in place instead of calling enterWith again — so the box reference
 * already correctly propagated to every downstream continuation simply
 * reflects the new value when read, no re-entry required.
 *
 * clearMeterContext ALWAYS creates a brand-new box (never mutates an
 * inherited one) — this is also what makes clear-then-bind safe against
 * cross-request bleed: enterWith is not call-scoped, so a later request on
 * the same async chain could otherwise inherit a PREVIOUS request's box
 * object; starting every request with a fresh box severs that link before
 * anything of this request's own gets attached to it.
 *
 * Nothing here can auto-clear the context at request end; Nitro's
 * per-request entry point (auth.ts calling clearMeterContext first) is
 * what provides that isolation. Test code must reset explicitly (see
 * __resetMeterContextForTests).
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { deployMode } from './deployMode'
import { costForModel, LORA_RENDER_CREDITS, LORA_SLUG_OWNERS, MODEL_COSTS } from './priceBook'
import { getLiveLedger } from './ledgerLive'
import { assertSpendAllowed } from './systemControls'
import { captureError } from './observe'

/**
 * Operator safety-valve guard (Stage 7 Task 4), injected behind a seam so the
 * request-meter unit tests can run in hosted mode without a live controls db.
 * Defaults to the real assertSpendAllowed; a null override restores the real
 * one. Referenced only at call time to avoid any circular-init ordering.
 */
let spendGuardOverride: ((userId: string) => Promise<void>) | null = null
export function __setSpendGuardForTests(fn: ((userId: string) => Promise<void>) | null): void {
  spendGuardOverride = fn
}

export interface MeterContext { userId: string; priceHintCredits?: number }

interface MeterContextBox { current: MeterContext | null }

const als = new AsyncLocalStorage<MeterContextBox>()

/**
 * auth middleware calls this once per request (after resolving the user).
 * Mutates the box already bound by clearMeterContext in place — see the
 * module doc's ALS propagation gotcha for why this must NOT call
 * enterWith itself in the common (already-cleared) case. Falls back to
 * enterWith only when no box exists yet (standalone/test callers that
 * invoke this without a prior clearMeterContext in the same call).
 */
export function bindMeterContext(ctx: MeterContext): void {
  const box = als.getStore()
  if (box) {
    box.current = ctx
  } else {
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[meter] bindMeterContext without a cleared box — context may not propagate; call clearMeterContext() first')
    }
    als.enterWith({ current: ctx })
  }
}

/**
 * Clears any bound context by entering a FRESH box (never mutates an
 * inherited one — see the module doc). Review escalation 2026-08-14: auth
 * middleware must call this on EVERY hosted request, before any
 * short-circuit, so no request can ever inherit a predecessor's identity —
 * only requests that pass the guard and resolve a user get a freshly bound
 * context afterward (via bindMeterContext mutating THIS box).
 */
export function clearMeterContext(): void {
  als.enterWith({ current: null })
}

/** Chokepoints (preflightMeter, routes) read the currently bound context. */
export function currentMeterContext(): MeterContext | null {
  return als.getStore()?.current ?? null
}

/**
 * Routes that know their own price (e.g. a route-level flat fee) call this
 * AFTER bindMeterContext has already run for the request, to attach a hint
 * resolveCredits can fall back to when the model itself is unpriced.
 */
export function setMeterPriceHint(credits: number): void {
  const box = als.getStore()
  if (!box?.current) return
  box.current.priceHintCredits = credits
}

/** Test-only seam: clears the bound context so tests don't bleed into each
 * other via enterWith's non-call-scoped persistence. Thin alias over the
 * production clearMeterContext — kept as a separate export so test call
 * sites read as test-only regardless of what production code does. */
export function __resetMeterContextForTests(): void {
  clearMeterContext()
}

/**
 * h3's `isError` is a duck-check — `input?.constructor?.__h3_error__ ===
 * true` (h3@1.15.8 dist/index.mjs ~line 140) — NOT `instanceof H3Error`.
 * Without the static marker below, `toNodeListener`'s catch (same file,
 * ~line 2318/2419) sees `isError(_error) === false`, wraps this error in a
 * FRESH H3Error via `createError`, and — critically — sets `unhandled =
 * true` on that wrapper because the original wasn't recognized as an H3
 * error. Nitro's prod error handler (nitropack/dist/runtime/internal/
 * error/prod.mjs) treats `unhandled` as `isSensitive` and replaces
 * `message`/`data` with a generic "Server Error" + `undefined` before the
 * response ever reaches the client — so a 402 with {required, available}
 * silently became an opaque 500-shaped body. The fields below mirror
 * h3's real `H3Error` class (same file, ~line 36) closely enough that
 * `isError` recognizes this class AND h3/Nitro's serialization path finds
 * everything it expects: `statusMessage` (used for the HTTP status line
 * and echoed into the JSON body), `fatal`/`unhandled` (both must stay
 * `false` so this error is never treated as sensitive). `cause` is also on
 * H3Error, but it's already declared on the base `Error` class (ES2022
 * lib) — no re-declaration needed, `super(message)` covers it.
 */
export class MeterRefusalError extends Error {
  static __h3_error__ = true
  statusCode: number
  statusMessage?: string
  data?: unknown
  fatal = false
  unhandled = false
  constructor(message: string, statusCode: number, data?: unknown) {
    super(message)
    this.name = 'MeterRefusalError'
    this.statusCode = statusCode
    this.statusMessage = message
    this.data = data
  }
}

/**
 * The price of THIS request, else MODEL_COSTS[model].credits, else hint, else
 * LoRA category for personal slugs (a slug whose owner segment is not a known
 * public provider org), else null. KNOWN_PUBLIC_ORGS is derived from
 * Object.keys(MODEL_COSTS) at call time — never hardcode a second list that
 * can drift from the price book.
 *
 * `requestCredits` (Task P5) is the price the shared calculation gave the
 * request actually being sent — per second of the clip it asks for (runFal:
 * shared/pricing/clipSettings.ts requestPrice). It wins over the model's flat
 * row: a flat row priced for one length must never silently replace the price
 * of the length asked for (a 12 s Animate clip used to be held at the 5 s row).
 * Only a positive whole number of credits counts; anything else is ignored and
 * the row (or a refusal) applies.
 */
export function resolveCredits(model: string, hint?: number, requestCredits?: number): number | null {
  if (typeof requestCredits === 'number' && Number.isInteger(requestCredits) && requestCredits > 0) return requestCredits
  const priced = costForModel(model)
  if (priced) return priced.credits

  if (typeof hint === 'number') return hint

  const owner = model.split('/')[0]
  const hasOwnerSegment = owner.length > 0 && owner !== model
  if (hasOwnerSegment && LORA_SLUG_OWNERS.includes(owner)) return LORA_RENDER_CREDITS
  // Unknown owner that is neither a booked public org nor an allowlisted
  // personal-LoRA org: REFUSE (null). A typo'd public slug must fail loudly
  // upstream rather than silently underprice as an 8cr LoRA render.
  return null
}

/**
 * A reservation on the caller's wallet, taken BEFORE the provider is
 * dispatched. Exactly one of settle/release must eventually be called:
 *  - settle(jobId) — the job confirmed success; convert the reservation
 *    into a real charge.
 *  - release() — the job never shipped output (submit threw, provider
 *    reported failure, polling gave up); give the reservation back.
 * A ticket that is neither settled nor released (crashed process) is swept
 * by holdSweep.ts after HOLD_TTL_MS rather than locking credits forever.
 */
export interface MeterTicket {
  settle(jobId: string): Promise<void>
  release(): Promise<void>
  /**
   * The reservation's ledger id and amount. Exposed so a route whose job
   * completes on a LATER request (voice-clone: start creates the prediction,
   * status.get.ts confirms it minutes later) can hand this ticket's identity
   * to that later request and settle THIS hold there — see
   * settleRecordedHold and voiceCloneOwners.ts. Everything else should use
   * settle()/release() and never touch these.
   */
  readonly holdId: number
  readonly credits: number
}

/**
 * Stage 5 Task 2: the provider path moved from debit-only preflight to
 * ledger HOLDS. The old shape read getAvailable and compared — which meant
 * N parallel expensive requests each preflighted against the SAME untouched
 * balance and all passed, then all debited: a real overspend leak. `hold`
 * reserves inside the ledger's own transaction, so the second request sees
 * the first request's reservation.
 *
 * `debit` stays on this type on purpose — settleModel (async jobs confirmed
 * on a later request), anthropicMeter's flat-rate assist gate, and the
 * training providers keep their debit-only paths.
 */
export type LedgerLike = {
  getAvailable(userId: string): Promise<number>
  hold(userId: string, estimate: number, idempotencyKey: string): Promise<{ ok: true; holdId: number } | { ok: false; reason: 'insufficient' }>
  settleHold(holdId: number, actual: number, reason: string): Promise<{ ok: true; balance: number; settled: boolean }>
  releaseHold(holdId: number): Promise<void>
  debit(userId: string, amount: number, reason: string, idempotencyKey: string): Promise<{ ok: boolean }>
}

// Test-only injection point (mirrors __setClerkClientForTests in auth.ts /
// __setStripeForTests in stripeClient.ts) — tests never need DATABASE_URL.
let ledgerOverride: LedgerLike | null = null
export function __setLedgerForTests(ledger: LedgerLike | null): void {
  ledgerOverride = ledger
}
/**
 * Exported so other chokepoints (e.g. anthropicMeter.ts's flat-rate assist
 * metering) can share this exact ledger resolution — including the
 * __setLedgerForTests override above — instead of importing ledgerLive
 * directly and bypassing that test seam.
 */
export function getLedger(): LedgerLike {
  if (ledgerOverride) return ledgerOverride
  // Adapter over the real ledger: its hold/settle/release are named for the
  // ledger's own vocabulary, LedgerLike names them for the meter's. Kept
  // inline (rather than in ledgerLive.ts) so the shape the test seam has to
  // satisfy lives next to the code that consumes it.
  const live = getLiveLedger()
  return {
    getAvailable: userId => live.getAvailable(userId),
    hold: (userId, estimate, idempotencyKey) => live.hold(userId, estimate, idempotencyKey),
    settleHold: (holdId, actual, reason) => live.settle(holdId, actual, reason),
    releaseHold: holdId => live.release(holdId),
    debit: (userId, amount, reason, idempotencyKey) => live.debit(userId, amount, reason, idempotencyKey),
  }
}

/**
 * Convert a hold into a real charge, logging every way that can go wrong.
 * Shared by MeterTicket.settle (same request) and settleRecordedHold (a
 * later request settling a hold taken by an earlier one) so both report the
 * two money-losing outcomes identically: a hold that was already released
 * (the output shipped and nobody paid) and a ledger error after a delivered
 * job. Never throws — a delivered job is never turned into a user-facing
 * error by a ledger problem.
 */
async function settleHoldOrLog(
  ledger: LedgerLike, holdId: number, credits: number, model: string, jobId: string, userId?: string,
): Promise<void> {
  try {
    const r = await ledger.settleHold(holdId, credits, `provider:${model}`)
    if (!r.settled) {
      // The hold was already released (holdSweep's TTL, or a double-release
      // on a failure path) — the provider output shipped and nobody paid.
      console.error('[meter] SETTLE ON RELEASED HOLD — output shipped uncharged', { userId, model, credits, jobId, holdId })
      captureError(new Error('meter: settle on released hold — output shipped uncharged'), { site: 'settleModelHold', userId, model, credits, jobId, holdId })
    }
  } catch (e) {
    console.error('[meter] SETTLE FAILED after successful job', { userId, model, credits, jobId, holdId, error: e })
  }
}

/**
 * Settle a hold whose ticket belongs to an EARLIER request. Only for the
 * async-job shape where the provider call is started by one request and
 * confirmed by another (voice-clone start → status poll): the starter
 * records the ticket's `holdId`/`credits` alongside its ownership binding,
 * and the poll that sees `succeeded` settles that exact reservation. Callers
 * must do their own ownership check first — this function trusts the holdId
 * it is given. Local mode: no-op (no ledger, no holds).
 */
export async function settleRecordedHold(
  hold: { holdId: number, credits: number }, model: string, jobId: string,
): Promise<void> {
  if (deployMode() === 'local') return
  await settleHoldOrLog(getLedger(), hold.holdId, hold.credits, model, jobId)
}

/**
 * Release a hold whose ticket belongs to an EARLIER request, on a terminal
 * failure/cancel observed later (review fix, Stage 5 Task 2): mirrors
 * settleRecordedHold's shape and logging discipline, but gives the
 * reservation back instead of charging it. Before this, a failed/canceled
 * async job (voice-clone start → status poll observing `failed`) left its
 * hold open for the full 2h sweep TTL even though the poll already knew the
 * job would never settle. Never throws — a terminal status must still reach
 * the poller even if the ledger release itself errors; log loudly instead so
 * the sweep is the backstop. Callers must do their own ownership check first
 * — this function trusts the holdId it is given. Local mode: no-op (no
 * ledger, no holds).
 */
export async function releaseRecordedHold(
  hold: { holdId: number, credits: number }, model: string, jobId: string,
): Promise<void> {
  if (deployMode() === 'local') return
  try {
    await getLedger().releaseHold(hold.holdId)
  } catch (e) {
    console.error('[meter] RELEASE FAILED on terminal failure — hold stays open until sweep', { model, credits: hold.credits, jobId, holdId: hold.holdId, error: e })
  }
}

/**
 * Reserve `credits` on the user's wallet or refuse with a 402 — the one hold
 * step every hold-based meter shares (preflightForUser here, and
 * anthropicMeter's holdForModelCall), so the refusal semantics can't drift.
 * Returns the hold id.
 */
export async function holdOrRefuse(
  ledger: LedgerLike, userId: string, credits: number, idempotencyKey: string, model: string,
): Promise<number> {
  let res: Awaited<ReturnType<LedgerLike['hold']>>
  try {
    res = await ledger.hold(userId, credits, idempotencyKey)
  } catch (e) {
    // Review fix (Stage 5 Task 2): ledger.hold THROWS a plain Error for a
    // user with no wallet row ("no wallet for <id> — call ensureUser
    // first"). A non-h3 error escaping here is stripped by Nitro's prod
    // handler to an opaque 500, so a user who simply has no wallet saw
    // "Server Error" instead of a credits refusal. No wallet means zero
    // credits: that is a refusal, not a server fault. Fail closed — the
    // spend never happens either way — but say so honestly. `available: 0`
    // is asserted rather than read back, because getAvailable would throw
    // for exactly the same reason.
    console.error('[meter] HOLD FAILED — refusing as insufficient credits', { userId, model, credits, error: e })
    throw new MeterRefusalError('insufficient credits', 402, { required: credits, available: 0 })
  }
  if (!res.ok) {
    // The refusal body still quotes a real number for the UI, read after
    // the refused hold (which reserved nothing, so this is the true figure).
    const available = await ledger.getAvailable(userId)
    throw new MeterRefusalError('insufficient credits', 402, { required: credits, available })
  }
  return res.holdId
}

/**
 * Shared core for both preflightMeter (ALS-bound userId) and preflightMeterFor
 * (explicit userId, for callers with no request/ALS context). Local mode →
 * null (no-op ticket, no ledger touched at all). Hosted mode fails closed at
 * every step: no price or a refused hold both refuse rather than letting
 * spend through unpriced or unmetered.
 *
 * The hold's idempotency key is a fresh UUID per preflight — deliberately
 * NOT derived from (userId, model), because the ledger dedupes holds on
 * (user_id, idempotency_key): a shared key would silently collapse two
 * genuinely concurrent renders into ONE reservation and reopen the very leak
 * this replaces. The key exists only to make a retried hold call idempotent
 * within a single preflight, which is exactly one call.
 */
async function preflightForUser(userId: string, model: string, priceHintCredits?: number, requestCredits?: number): Promise<MeterTicket | null> {
  if (deployMode() === 'local') return null

  // Operator safety valves (Stage 7 Task 4) — BEFORE pricing/hold, so a
  // paused system or a tripped ceiling refuses with NO hold taken. Fails
  // closed on an unreadable control state.
  await (spendGuardOverride ?? assertSpendAllowed)(userId)

  const credits = resolveCredits(model, priceHintCredits, requestCredits)
  if (credits === null) throw new MeterRefusalError(`unpriced model refused: ${model}`, 500)

  const ledger = getLedger()
  const holdId = await holdOrRefuse(ledger, userId, credits, `meter:${randomUUID()}`, model)

  return {
    holdId,
    credits,
    async settle(jobId: string): Promise<void> {
      await settleHoldOrLog(ledger, holdId, credits, model, jobId, userId)
    },
    async release(): Promise<void> {
      // Release runs on failure paths that are already throwing — it must
      // never replace the caller's real error with a ledger error.
      try {
        await ledger.releaseHold(holdId)
      } catch (e) {
        console.error('[meter] HOLD RELEASE FAILED', { userId, model, holdId, error: e })
      }
    },
  }
}

/**
 * Local mode → null (no-op ticket, no ledger touched at all). Hosted mode
 * fails closed at every step: no bound context, no price, or insufficient
 * balance all refuse the request rather than letting spend through unpriced
 * or unmetered.
 *
 * `opts.credits`: the price of this request, where the caller priced what it
 * sends (see resolveCredits). The hold is taken for it, and settle charges it.
 */
export async function preflightMeter(model: string, opts: { credits?: number } = {}): Promise<MeterTicket | null> {
  if (deployMode() === 'local') return null

  const ctx = currentMeterContext()
  if (!ctx) throw new MeterRefusalError('unmetered spend refused', 500)

  return preflightForUser(ctx.userId, model, ctx.priceHintCredits, opts.credits)
}

/**
 * Context-free variant of preflightMeter for callers with no request in
 * flight — e.g. server/plugins/trainingQueueRunner.ts's timer-driven runner,
 * which starts training jobs on a tick with no AsyncLocalStorage context to
 * read a userId from (see this module's doc on ALS propagation). The caller
 * supplies userId explicitly (threaded through from wherever the job was
 * enqueued — see trainingQueue.ts's TrainingJob.userId). Same checks as
 * preflightMeter minus the ALS lookup; ticket shape and settle semantics are
 * identical. Never call this without a real userId — there is no "unbound
 * context" refusal here to catch that mistake for you, unlike preflightMeter.
 */
export async function preflightMeterFor(userId: string, model: string): Promise<MeterTicket | null> {
  return preflightForUser(userId, model)
}

/**
 * Settle a known-priced model for the CURRENT context user without a fresh
 * preflight — for async jobs whose success is confirmed on a later request
 * (e.g. voice-clone status polling). The idempotency key makes repeated
 * status polls after success a no-op. A refused debit (balance drained
 * between start and completion) delivers the job UNCHARGED and logs loudly —
 * never blocks the user's result. Local mode: no-op.
 */
export async function settleModel(model: string, jobId: string): Promise<void> {
  if (deployMode() === 'local') return

  const ctx = currentMeterContext()
  if (!ctx) {
    console.error('[meter] settleModel without context', { model, jobId })
    return
  }

  const credits = resolveCredits(model, ctx.priceHintCredits)
  if (credits === null) {
    console.error('[meter] settleModel: unpriced model', { model, jobId, userId: ctx.userId })
    return
  }

  const userId = ctx.userId
  const ledger = getLedger()
  try {
    const result = await ledger.debit(userId, credits, `provider:${model}`, jobId)
    if (!result.ok) {
      console.error('[meter] DEBIT FAILED after successful job', { userId, model, credits, jobId, result })
      captureError(new Error('meter: debit failed after successful job'), { site: 'settleModel', userId, model, credits, jobId, result })
    }
  } catch (e) {
    console.error('[meter] DEBIT FAILED after successful job', { userId, model, credits, jobId, error: e })
    captureError(e, { site: 'settleModel', userId, model, credits, jobId })
  }
}
