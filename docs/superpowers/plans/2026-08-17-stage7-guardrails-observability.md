# Stage 7: Guardrails & Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** four hosted-only safety nets for the beta — prompt-side moderation, error observability (Sentry), operator spend safety valves (kill-switch + daily ceiling), and nightly cost/ledger reconciliation — with local mode byte-identical.

**Architecture:** reuse the Stage 4–6 chokepoints. Moderation and the safety-valve checks slot into the same points metering already occupies (`preflightForUser` in `requestMeter.ts`, the `runReplicate`/`runFal` provider chokepoints, and `meterGraphSubmit`). Spend controls + reconciliation read a newly-populated `provider_usage` Neon table (it exists in the schema but was never written — Task 1 wires the write). Cron work reuses the `holdSweep` plugin pattern (schedule-only, never blocks boot).

**Tech Stack:** Nitro/h3, `connectLedgerDb` pg driver, OpenAI moderation endpoint (plain `fetch`, no SDK), `@sentry/node` + `@sentry/nuxt`, existing `deployMode`/`MeterRefusalError`/`priceBook` utilities.

## Global Constraints

- **deployMode contract:** no `NUXT_CLERK_SECRET_KEY` ⇒ local mode ⇒ byte-identical. Every new behavior behind `deployMode() === 'hosted'` or an env-presence check. Local `:3000` regression is part of final verification.
- **Secrets:** new keys (`OPENAI_API_KEY`, `SENTRY_DSN`, `NUXT_PUBLIC_SENTRY_DSN`, `SAILOR_DAILY_CREDIT_CEILING`, `ADMIN_CLERK_USER_ID`) live ONLY in gitignored `frontend/.env.hosted`; never printed. Neon schema applies via the DIRECT `DATABASE_URL`.
- **mlly gotcha:** NO commas in trailing comments on `export const` lines under `frontend/server/` — em-dashes only.
- **Ledger session contract:** new tables/reads use their OWN pg session via `connectLedgerDb` (the `graphRuns.ts`/`resourceOwners.ts` pattern) — never `getSharedLedgerDb`, no `ledger.withLock` coupling.
- **Parallel-session hygiene:** other sessions hold uncommitted edits. Check `git status` before every commit; stage ONLY your own files/hunks; never `git add -A`; never stash; commit to main.
- **Run vitest FROM `frontend/`.** Shell cwd resets between Bash calls. Package manager is **pnpm** — never run `pnpm install`/`pnpm add` while a dev server is live (Nitro bundles a stale path → all routes 500).
- **Fail direction (from the design):** moderation fails **OPEN** on OpenAI outage (allow + alert); spend controls fail **CLOSED** on unknown state (pause). These are opposite on purpose.
- **Fail closed for money:** an unpriced/unknown spend, or an unreadable control state, refuses rather than proceeds.

## Design reference

`docs/superpowers/specs/2026-08-17-stage7-guardrails-observability-design.md` — the four components + the fail-direction rationale + the deferrals (output moderation, rich analytics, Stripe Radar). Read it before starting.

## Current-state map (verified 2026-08-17)

- **`provider_usage` table exists but is NEVER written** (`schema.sql:74`; grep finds zero INSERTs). Provider spend today only lands in a local JSONL file (`spendLog.ts` → `.data/spend-events.jsonl`), which is per-machine + not queryable in Neon. Task 1 fixes this.
- **Metering chokepoints:** `preflightMeter(model)` (`requestMeter.ts:388`) → `preflightForUser(userId, model)` (`:333`) takes the ledger HOLD; `runReplicate`/`runFal` (`replicate.ts`/`falRun.ts`) call it, dispatch, then `ticket.settle('rep:'+id)` / `ticket.settle('fal:'+rid)` on success or `ticket.release()` on failure. `meterGraphSubmit` (`meterGraphRun.ts`) is the canvas-graph chokepoint (hold → forward → settle).
- **`MeterRefusalError(message, statusCode, data?)`** (`requestMeter.ts:144`) — h3-shaped (has `static __h3_error__ = true`), the refusal type; a 402/503 body survives Nitro's error handler.
- **`costForModel(model)`** (`priceBook.ts`) → `{ usd, credits, confidence } | null` — the USD cost for `provider_usage.usd`.
- **Cron pattern:** `server/plugins/holdSweep.ts` + `server/utils/holdSweep.ts` — `defineNitroPlugin` guarded by a `globalThis` singleton + a `startX()` that returns false in local mode (nothing scheduled) and only schedules callbacks (never blocks boot).
- **Ledger debits:** `ledger_entries` rows with `kind='debit'`, `reason` like `provider:<model>` / `graph:<promptId>`, `idempotency_key` the job/hold id.
- **Admin route:** `server/api/admin/console.get.ts` 404s in hosted (no admin role yet). Task 4 adds a minimal `ADMIN_CLERK_USER_ID`-guarded controls route.

---

### Task 1: Record provider spend into `provider_usage` (Neon)

**Files:**
- Create: `frontend/server/utils/providerUsage.ts`
- Modify: `frontend/server/utils/replicate.ts` (settle path), `frontend/server/utils/falRun.ts` (settle path)
- Test: `frontend/tests/unit/provider-usage.unit.spec.ts`

**Interfaces:**
- Produces: `recordProviderUsage(row: { userId: string | null; provider: string; model: string; usd: number | null; jobId: string }): Promise<void>` — inserts one `provider_usage` row (own `connectLedgerDb` session). Local mode / no `DATABASE_URL` → no-op. `__setProviderUsageDbForTests(db)` seam.
- Consumes: `costForModel` from `priceBook.ts` (for the usd value at the call sites).

- [ ] **Step 1: Failing test** (`provider-usage.unit.spec.ts`, fake-db `query` spy per `graph-runs.unit.spec.ts`):

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { recordProviderUsage, __setProviderUsageDbForTests } from '../../server/utils/providerUsage'
import { __setDeployModeForTests } from '../../server/utils/deployMode' // if a seam exists; else set NUXT_CLERK_SECRET_KEY env

const query = vi.fn()
beforeEach(() => { query.mockReset(); __setProviderUsageDbForTests({ query }) })

describe('recordProviderUsage', () => {
  it('inserts a row with the provider/model/usd/job/user', async () => {
    query.mockResolvedValue({ rows: [] })
    await recordProviderUsage({ userId: 'u1', provider: 'replicate', model: 'black-forest-labs/flux-dev', usd: 0.025, jobId: 'rep:abc' })
    const [sql, params] = query.mock.calls[0]
    expect(sql).toMatch(/INSERT INTO provider_usage/i)
    expect(params).toEqual(['u1', 'replicate', 'black-forest-labs/flux-dev', 0.025, 'rep:abc'])
  })
  it('tolerates a null user and null usd', async () => {
    query.mockResolvedValue({ rows: [] })
    await recordProviderUsage({ userId: null, provider: 'fal', model: 'x', usd: null, jobId: 'fal:1' })
    expect(query.mock.calls[0][1]).toEqual([null, 'fal', 'x', null, 'fal:1'])
  })
})
```

Determine how the module reads deployMode/DATABASE_URL (mirror `graphRuns.ts`'s `db()`), and how tests force the local no-op (the graph-runs spec sets the db override; a no-op-in-local test can assert `query` not called when `deployMode()` is local — replicate whatever seam graphRuns uses).

- [ ] **Step 2: Run RED** — `cd frontend && npx vitest run tests/unit/provider-usage.unit.spec.ts` (module-not-found).
- [ ] **Step 3: Implement `providerUsage.ts`** (copy the `graphRuns.ts` own-session + `__set...ForTests` + lazy `db()` shape exactly):

```ts
/**
 * Records confirmed provider spend into the provider_usage Neon table — the
 * data source for the daily spend ceiling (Task 4) and nightly reconciliation
 * (Task 5). Own pg session (connectLedgerDb), never the ledger's. Local mode
 * (no DATABASE_URL) is a no-op — provider spend there still goes to the local
 * spend-events.jsonl as before; this table is hosted-only.
 */
import { connectLedgerDb, type LedgerDbHandle } from './ledgerDb'

type DbLike = { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }
let dbOverride: DbLike | null = null
let shared: LedgerDbHandle | null = null
export function __setProviderUsageDbForTests(db: DbLike | null): void { dbOverride = db }
function db(): DbLike | null {
  if (dbOverride) return dbOverride
  const url = process.env.DATABASE_URL
  if (!url) return null
  if (!shared) shared = connectLedgerDb(url)
  return shared
}

export async function recordProviderUsage(row: { userId: string | null; provider: string; model: string; usd: number | null; jobId: string }): Promise<void> {
  const d = db()
  if (!d) return
  try {
    await d.query(
      `INSERT INTO provider_usage (user_id, provider, model, usd, job_id) VALUES ($1, $2, $3, $4, $5)`,
      [row.userId, row.provider, row.model, row.usd, row.jobId])
  } catch (e) {
    console.error('[providerUsage] insert failed', { jobId: row.jobId, model: row.model, error: e })
  }
}
```

(Insert failures are swallowed+logged — recording spend must never fail a settled job. Note: `db()` returning null on missing `DATABASE_URL` gives the local no-op; check `graphRuns.ts` — if it throws on missing URL instead, match graphRuns and instead gate the CALL SITES on `deployMode()==='hosted'`. Pick the approach graphRuns uses and stay consistent.)

- [ ] **Step 4: Wire the two call sites.** In `replicate.ts` and `falRun.ts`, at the SUCCESS settle path (right where `ticket.settle('rep:'+id)` / `ticket.settle('fal:'+rid)` runs), also call `recordProviderUsage({ userId: <the metered userId>, provider: 'replicate'|'fal', model: <the app/model slug>, usd: costForModel(model)?.usd ?? null, jobId: 'rep:'+id })`. Read each file to find the userId in scope (it's in the meter context — `currentMeterContext()?.userId` from `requestMeter.ts`, or thread it). Fire-and-forget (`void recordProviderUsage(...)`) so it never delays the response. Add a call-site test if practical, else rely on the unit + the Task-7 live check.
- [ ] **Step 5: GREEN + apply schema** — the table already exists in `schema.sql`; confirm it's live in Neon (`node`/pg one-liner: `SELECT to_regclass('provider_usage')` using the DIRECT `DATABASE_URL` from `.env.hosted`, never printed). **Step 6: Commit** — `feat(stage7): record provider spend into provider_usage (Neon)`.

---

### Task 2: Moderation module (`moderation.ts`)

**Files:**
- Create: `frontend/server/utils/moderation.ts`
- Test: `frontend/tests/unit/moderation.unit.spec.ts`

**Interfaces:**
- Produces: `moderatePrompt(text: string): Promise<{ ok: true } | { ok: false, categories: string[] }>` — local/no `OPENAI_API_KEY` → `{ ok: true }`; empty text → `{ ok: true }`; OpenAI flagged → `{ ok: false, categories }`; OpenAI error/timeout → `{ ok: true }` (FAIL-OPEN) + `console.error`. `__setModerationFetchForTests(fn)` seam (injects the fetch used).

- [ ] **Step 1: Failing test:**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { moderatePrompt, __setModerationFetchForTests } from '../../server/utils/moderation'

beforeEach(() => { __setModerationFetchForTests(null); delete process.env.OPENAI_API_KEY })

describe('moderatePrompt', () => {
  it('no key → ok (no-op, no fetch)', async () => {
    const spy = vi.fn(); __setModerationFetchForTests(spy)
    expect(await moderatePrompt('anything')).toEqual({ ok: true })
    expect(spy).not.toHaveBeenCalled()
  })
  it('empty text → ok, no fetch', async () => {
    process.env.OPENAI_API_KEY = 'sk-x'; const spy = vi.fn(); __setModerationFetchForTests(spy)
    expect(await moderatePrompt('   ')).toEqual({ ok: true })
    expect(spy).not.toHaveBeenCalled()
  })
  it('flagged → not ok with categories', async () => {
    process.env.OPENAI_API_KEY = 'sk-x'
    __setModerationFetchForTests(vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [{ flagged: true, categories: { violence: true, hate: false } }] }) }))
    expect(await moderatePrompt('bad')).toEqual({ ok: false, categories: ['violence'] })
  })
  it('OpenAI error → FAIL-OPEN (ok:true)', async () => {
    process.env.OPENAI_API_KEY = 'sk-x'
    __setModerationFetchForTests(vi.fn().mockRejectedValue(new Error('down')))
    expect(await moderatePrompt('x')).toEqual({ ok: true })
  })
  it('non-200 → FAIL-OPEN', async () => {
    process.env.OPENAI_API_KEY = 'sk-x'
    __setModerationFetchForTests(vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }))
    expect(await moderatePrompt('x')).toEqual({ ok: true })
  })
})
```

- [ ] **Step 2: Run RED.** **Step 3: Implement:**

```ts
/**
 * Prompt-side moderation via OpenAI's free moderation endpoint. FAIL-OPEN by
 * design (design doc Component 1): on any error/timeout/non-200 the prompt is
 * ALLOWED and the failure is logged (Sentry-captured in Task 6) — a moderation
 * blip must not take all generation down for a watched beta. No OPENAI_API_KEY
 * (local mode) → no-op { ok: true }, byte-identical.
 */
let fetchOverride: typeof fetch | null = null
export function __setModerationFetchForTests(fn: typeof fetch | null): void { fetchOverride = fn }

const MODERATION_TIMEOUT_MS = 4000

export async function moderatePrompt(text: string): Promise<{ ok: true } | { ok: false, categories: string[] }> {
  const key = process.env.OPENAI_API_KEY
  if (!key || !text || !text.trim()) return { ok: true }
  const doFetch = fetchOverride ?? fetch
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), MODERATION_TIMEOUT_MS)
    let res: any
    try {
      res = await doFetch('https://api.openai.com/v1/moderations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: 'omni-moderation-latest', input: text }),
        signal: ctrl.signal,
      })
    } finally { clearTimeout(t) }
    if (!res?.ok) { console.error('[moderation] non-200 — failing open', { status: res?.status }); return { ok: true } }
    const data = await res.json()
    const result = data?.results?.[0]
    if (result?.flagged) {
      const categories = Object.entries(result.categories ?? {}).filter(([, v]) => v === true).map(([k]) => k)
      return { ok: false, categories }
    }
    return { ok: true }
  } catch (e) {
    console.error('[moderation] error — failing open', e)
    return { ok: true }
  }
}
```

- [ ] **Step 4: GREEN.** **Step 5: Commit** — `feat(stage7): OpenAI prompt-moderation module (fail-open, no-op local)`.

---

### Task 3: Wire moderation into the two chokepoints

**Files:**
- Create: `frontend/server/utils/graphPromptText.ts` (pure prompt extraction from a graph)
- Modify: `frontend/server/utils/replicate.ts` + `frontend/server/utils/falRun.ts` (moderate before dispatch), `frontend/server/utils/meterGraphRun.ts` (`meterGraphSubmit` — moderate before hold)
- Test: `frontend/tests/unit/graph-prompt-text.unit.spec.ts`, extend `frontend/tests/unit/meter-graph-run.unit.spec.ts`

**Interfaces:**
- Consumes: `moderatePrompt` (Task 2), `MeterRefusalError`.
- Produces: `extractGraphPromptText(prompt: Record<string, { class_type: string; inputs?: any }>): string` — joins the string values of prompt-bearing inputs (`prompt`, `text`, `positive`, `negative`) across all nodes, space-separated. Node-link values (arrays `[nodeId, slot]`) and non-strings are skipped.

- [ ] **Step 1: Failing test for `extractGraphPromptText`:**

```ts
import { describe, it, expect } from 'vitest'
import { extractGraphPromptText } from '../../server/utils/graphPromptText'

describe('extractGraphPromptText', () => {
  it('joins prompt-bearing string inputs, skips links + non-prompt fields', () => {
    const g = {
      '1': { class_type: 'CLIPTextEncode', inputs: { text: 'a red cat' } },
      '2': { class_type: 'GenerateImageNode', inputs: { prompt: 'a dog', model: 'flux', seed: 5 } },
      '3': { class_type: 'KSampler', inputs: { positive: ['1', 0], negative: 'blurry' } },
    }
    const t = extractGraphPromptText(g as any)
    expect(t).toContain('a red cat'); expect(t).toContain('a dog'); expect(t).toContain('blurry')
    expect(t).not.toContain('flux'); expect(t).not.toContain('5')
  })
  it('empty graph → empty string', () => { expect(extractGraphPromptText({} as any)).toBe('') })
})
```

- [ ] **Step 2: RED → implement `graphPromptText.ts`:**

```ts
/**
 * Pull the human-authored prompt text out of a ComfyUI API-format graph for
 * moderation. Only known prompt-bearing input names; node-link values
 * (arrays) and non-strings skipped.
 */
const PROMPT_INPUT_NAMES = new Set(['prompt', 'text', 'positive', 'negative'])
export function extractGraphPromptText(prompt: Record<string, { class_type: string; inputs?: any }>): string {
  const parts: string[] = []
  for (const node of Object.values(prompt ?? {})) {
    const inputs = node?.inputs
    if (!inputs || typeof inputs !== 'object') continue
    for (const [name, value] of Object.entries(inputs)) {
      if (PROMPT_INPUT_NAMES.has(name) && typeof value === 'string' && value.trim()) parts.push(value)
    }
  }
  return parts.join(' ')
}
```

- [ ] **Step 3: Wire canvas graph.** In `meterGraphSubmit` (`meterGraphRun.ts`), AFTER the 401/shape checks and the Stage-6 file-ref validation, BEFORE pricing/hold: `const promptText = extractGraphPromptText(body.prompt); const mod = await deps.moderatePrompt(promptText); if (!mod.ok) throw new MeterRefusalError('This prompt was blocked by content moderation', 400, { categories: mod.categories })`. Add `moderatePrompt` to the `GraphRunDeps` interface + wire the real `moderatePrompt` in `handleMeteredPrompt`'s deps. Extend `meter-graph-run.unit.spec.ts`: a flagged prompt → 400, NO hold, engine never forwarded (assert order — reuse the existing no-hold-on-refusal assertions).
- [ ] **Step 4: Wire provider routes.** In `runReplicate`/`runFal`, after the ticket is obtained (hold placed) but BEFORE `dispatch`, extract the prompt from the input dict (the `prompt`/`text` field of `input`) and `moderatePrompt` it; on `!ok` → `await ticket?.release()` then throw `MeterRefusalError('This prompt was blocked by content moderation', 400, { categories })`. NOTE: provider-route holds are placed by preflight before the input is inspected, so release-on-refusal is required (mirror the existing failure-path release). If the input has no obvious prompt field, moderate the concatenation of its string values (keep it simple — a small `extractProviderPromptText(input)` helper or inline). Add one chokepoint test: flagged input → release called, dispatch never called.
- [ ] **Step 5: GREEN across meter-graph-run + chokepoint specs.** **Step 6: Commit** — `feat(stage7): moderate prompts at the canvas + provider chokepoints (refusal costs nothing)`.

---

### Task 4: Operator safety valves — kill-switch + daily ceiling

**Files:**
- Modify: `frontend/server/db/schema.sql` (system_controls table), `frontend/server/utils/requestMeter.ts` (preflight check)
- Create: `frontend/server/utils/systemControls.ts`, `frontend/server/api/admin/controls.post.ts`, `frontend/server/api/admin/controls.get.ts`
- Test: `frontend/tests/unit/system-controls.unit.spec.ts`, extend `frontend/tests/unit/request-meter.unit.spec.ts`

**Interfaces:**
- Produces (`systemControls.ts`):
  - `assertSpendAllowed(userId: string): Promise<void>` — throws `MeterRefusalError('Sailor is temporarily paused', 503)` if globally paused, the user is disabled, or today's total ledger debit CREDITS ≥ `SAILOR_DAILY_CREDIT_CEILING`. Local mode → returns immediately (no-op). Unreadable control state → THROWS (fail closed).

**Ceiling source — decided during Task 1 (read this):** the ceiling sums today's `ledger_entries` DEBITS (credits), NOT `provider_usage.usd`. Reason: canvas-graph provider spend happens inside the Python engine and never flows through the Nitro `runReplicate`/`runFal` chokepoint, so `provider_usage` (Nitro-only) is an incomplete spend picture — it would undercount the biggest spend surface. The ledger captures EVERY paid action (both surfaces) since Stages 4-6 metered them all, so it is the complete + exact signal for a runaway-bug budget backstop. Env is a daily CREDIT ceiling (`SAILOR_DAILY_CREDIT_CEILING`, integer; unset/0 ⇒ no ceiling). `provider_usage` stays as the per-provider USD detail for Task 5's digest.
  - `getControls()` / `setGlobalPaused(bool)` / `setUserDisabled(userId, bool)` for the admin route.
  - `__setSystemControlsDbForTests(db)`.

- [ ] **Step 1: Schema.** Append to `schema.sql`:

```sql
-- Operator safety valves (Stage 7). A single-row global flag table + a
-- per-user disable set. Read at preflight before every paid action.
CREATE TABLE IF NOT EXISTS system_controls (
  id            int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  global_paused boolean NOT NULL DEFAULT false,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
INSERT INTO system_controls (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS disabled_users (
  user_id    text PRIMARY KEY REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Failing tests** (`system-controls.unit.spec.ts`, fake db): `assertSpendAllowed` resolves when not paused + user not disabled + spend under ceiling; throws 503 when `global_paused`; throws 503 when the user is in `disabled_users`; throws 503 when today's summed ledger debit credits ≥ `SAILOR_DAILY_CREDIT_CEILING`; **throws (fail closed) when the controls query itself throws**; local mode (no DATABASE_URL / deployMode local) → resolves without any query. Cache the ceiling-sum read ~30s (a module-level `{ value, at }` memo) — test that two calls within the window issue ONE spend query (spy call count).
- [ ] **Step 3: RED → implement `systemControls.ts`** (own `connectLedgerDb` session; `assertSpendAllowed` reads system_controls + disabled_users + the daily-credits sum `SELECT COALESCE(SUM(amount),0) AS c FROM ledger_entries WHERE kind='debit' AND created_at >= date_trunc('day', now())`, memoized ~30s). Gate on hosted (mirror graphRuns/resourceOwners). The ceiling env: `const ceiling = Number(process.env.SAILOR_DAILY_CREDIT_CEILING || 0)` — 0/unset ⇒ no ceiling (skip the sum query). Fail-closed: wrap the reads; on throw, throw `MeterRefusalError('Sailor is temporarily paused', 503)`.
- [ ] **Step 4: Wire into preflight.** In `preflightForUser` (`requestMeter.ts:333`), FIRST line after the local-mode short-circuit: `await assertSpendAllowed(userId)` (before resolveCredits/hold). Extend `request-meter.unit.spec.ts`: a paused system → preflight throws 503, NO hold taken (assert the ledger `hold` fake is never called). Import `assertSpendAllowed` behind the test seam so existing tests inject a no-op.
- [ ] **Step 5: Admin route.** `controls.post.ts` + `controls.get.ts` under `/api/admin` (already a NITRO_API_PREFIX). Guard: hosted + `event.context.userId === process.env.ADMIN_CLERK_USER_ID` (else 404 — not 403, don't reveal). POST body `{ globalPaused?: boolean, disableUser?: string, enableUser?: string }` → the setters. GET → current controls + today's spend + ceiling. A unit test for the guard (non-admin → 404; admin → acts). NOTE: `/api/admin` is 404'd wholesale in hosted by `console.get.ts`'s own check — this new route does its OWN admin check and must NOT inherit console's blanket 404; verify the routing (each route file self-guards).
- [ ] **Step 6: GREEN + schema to Neon** (apply the two tables via the DIRECT URL; verify `to_regclass`). **Step 7: Commit** — `feat(stage7): operator kill-switch + daily provider-spend ceiling at preflight`.

---

### Task 5: Nightly reconciliation cron

**Files:**
- Create: `frontend/server/utils/reconcile.ts`, `frontend/server/plugins/reconcile.ts`
- Test: `frontend/tests/unit/reconcile.unit.spec.ts`

**Interfaces:**
- Produces: `reconcileDay(deps): Promise<{ unmatchedJobIds: string[]; providerUsd: number; chargedCredits: number; byProvider: Record<string, number> }>` (pure core, injected db + now) — a daily SPEND DIGEST: today's total ledger debit credits (`chargedCredits`), the `provider_usage` USD total + per-provider breakdown (`providerUsd`, `byProvider`) — labeled DIRECT-PROVIDER-ROUTE detail, since provider_usage is wired only at replicate/falRun and misses training/canvas/bypass spend (the COMPLETE total comes from the ledger `chargedCredits`, not provider_usage) — and a narrow leak check: any `provider_usage.job_id` (= `settle:<holdId>`) with NO matching `ledger_entries` debit `idempotency_key` (`unmatchedJobIds`). `startReconcileCron(): boolean` (false in local; hosted → daily timer, mirroring `holdSweep`).

**Why a digest, not a true reconciliation:** `provider_usage` and the ledger are both written at the same metering chokepoint, so they match by construction — the join can only catch a code regression that writes one without the other (still worth the cheap check). The genuinely useful output is the daily digest: total credits charged + per-provider USD, logged/alerted so the operator sees the day's spend at a glance and a pricing regression shows as an anomalous number. A TRUE external reconciliation (vs the provider's actual invoice) is a manual monthly task — out of scope.

- [ ] **Step 1: Failing tests** (`reconcile.unit.spec.ts`, injected fake db returning canned rows): given 3 provider_usage rows and ledger debits matching 2 of their job_ids → `unmatchedJobIds` = the third; `providerUsd`/`chargedCredits` summed correctly; empty day → empty result, no alert. The join: `provider_usage.job_id` vs `ledger_entries.idempotency_key`. Task 1 established (verified in ledger.ts) that BOTH are `settle:<holdId>` — the ledger `settle()` hardcodes `idempotency_key = settle:${holdId}` and Task 1 records `job_id = settle:${ticket.holdId}` to match. So the join is `pu.job_id = le.idempotency_key AND le.kind='debit'`. The daily-credits total is `SUM(amount) WHERE kind='debit' AND created_at >= date_trunc('day', now())` (same as Task 4's ceiling source — consider a tiny shared helper). Alert path: `unmatchedJobIds.length > 0` → `console.error('[reconcile] UNMATCHED provider spend', ...)` (Sentry-captured in Task 6).
- [ ] **Step 2: RED → implement** `reconcile.ts` (pure core + a `runReconcile()` that wires the real shared session + logs the summary + alerts on unmatched) and `plugins/reconcile.ts` (the `holdSweep` plugin shape: globalThis singleton, `startReconcileCron()` returns false in local, schedules a ~24h timer + one run ~60s after boot, never awaits at top level).
- [ ] **Step 3: GREEN.** **Step 4: Commit** — `feat(stage7): nightly cost/ledger reconciliation cron (unmatched-spend + margin alert)`.

---

### Task 6: Sentry observability (server + client)

**Files:**
- Modify: `frontend/package.json` (add `@sentry/node`, `@sentry/nuxt`), `frontend/nuxt.config.ts` (client init), key chokepoints for `captureException`
- Create: `frontend/server/plugins/sentry.ts` (server init), `frontend/server/utils/observe.ts` (a thin `captureError(err, ctx)` wrapper)
- Test: `frontend/tests/unit/observe.unit.spec.ts`

**Interfaces:**
- Produces: `captureError(err: unknown, context?: Record<string, unknown>): void` — forwards to Sentry when a DSN is configured, else no-op; NEVER throws; strips prompt text (drop any `prompt`/`text` keys from context). Used at the money/engine `console.error` sites.

- [ ] **Step 1: Add deps.** `cd frontend && pnpm add @sentry/node @sentry/nuxt` — ONLY when no dev server is live (kill any first; the pnpm-under-live-server trap 500s all routes). Confirm the lockfile updated.
- [ ] **Step 2: Failing test** (`observe.unit.spec.ts`): `captureError` with no DSN → no-op, never throws (inject a Sentry stub via a `__setSentryForTests` seam; assert not called when DSN absent, called when present); a context containing `{ prompt: 'x', model: 'y' }` → the forwarded context has NO `prompt`/`text` key but keeps `model`.
- [ ] **Step 3: RED → implement `observe.ts`** (reads `process.env.SENTRY_DSN`; lazy `Sentry.captureException` via the server SDK; scrub `prompt`/`text`/`negative`/`positive` keys; wrap in try/catch so it never throws). **Server init** `plugins/sentry.ts`: `defineNitroPlugin` → `Sentry.init({ dsn })` only when `SENTRY_DSN` set (hosted-only by construction). **Client init** in `nuxt.config.ts`: wire `@sentry/nuxt` gated on `NUXT_PUBLIC_SENTRY_DSN` (follow the module's docs; must be inert when the env is absent → local unaffected).
- [ ] **Step 4: Replace the loud `console.error`s at the money/engine chokepoints** (metering debit-failed, settle-on-released-hold, moderation-unavailable, reconcile-unmatched, providerUsage-insert-failed) with `captureError(err, {...})` ALONGSIDE the existing `console.error` (keep the log; add the capture). Don't churn unrelated logs.
- [ ] **Step 5: GREEN + local boot check** — boot the LOCAL dev server (no DSN): no Sentry init, no resolve warnings, app unchanged. **Step 6: Commit** — `feat(stage7): Sentry error observability (hosted-only via DSN, PII-scrubbed)`.

---

### Task 7: Verification, docs, final review

**Files:**
- Create: `docs/superpowers/specs/2026-08-17-stage7-guardrails-verification.md`
- Modify: `docs/STATE.md`, `.superpowers/sdd/progress.md`, the ⛵ dashboard (fetch LIVE first, merge, republish)

- [ ] **Step 1: Refresh the hosted worktree server** on `:3100` to HEAD (kill by lsof open-file discovery — never pkill -f; checkout; verify fresh pid + port). It needs the new env for a full test: add `OPENAI_API_KEY`, `SENTRY_DSN`, `SAILOR_DAILY_CREDIT_CEILING`, `ADMIN_CLERK_USER_ID` to `.env.hosted` IF available; if a key is absent, that component is inert (fail-open/no-op) — note which were exercised.
- [ ] **Step 2: Automated probes** (write to `.superpowers/sdd/stage7-probes.md`): local `:3000` byte-identity (no moderation call, no Sentry, no controls query, `/api/wallet` → `{"mode":"local"}`, generation still works); hosted: `/api/admin/controls` GET as non-admin → 404; the full Stage-7 unit family twice (provider-usage, moderation, graph-prompt-text, system-controls, reconcile, observe, request-meter, meter-graph-run) with identical counts.
- [ ] **Step 3: Julien checklist** (into the verification doc): flip the kill-switch via `/api/admin/controls` (or SQL) → next generation returns "temporarily paused"; un-pause → works; submit an obviously-violating prompt → blocked, nothing charged; set `SAILOR_DAILY_CREDIT_CEILING` to 1, generate → paused after the first spend; check Sentry received a test event.
- [ ] **Step 4: Docs** — verification spec (plain summary first; what's exercised vs inert-without-a-key; the fail-open/fail-closed split; deferrals carried); update `docs/STATE.md` (Stage 7 entry) + `.superpowers/sdd/progress.md`; fetch the LIVE ⛵ dashboard, merge a Stage-7 row, republish to the same URL.
- [ ] **Step 5: Final whole-branch review** (fable) over the Stage-7 commit range; dispatch ONE fix subagent for any Critical/Important; re-review; then this stage is READY.

## Self-review notes

- Spec coverage: Component 1 → Tasks 2+3; Component 2 → Task 6; Component 3 → Task 4 (+ Task 1 data foundation the design assumed existed); Component 4 → Task 5 (+ Task 1); verification → Task 7. The `provider_usage`-never-written gap is filled by Task 1 (design assumed it was populated — corrected here).
- Type consistency: `recordProviderUsage` row shape (Task 1) ↔ the reconcile join key (Task 5) ↔ the ledger settle key (verified in Task 5 Step 1 before writing). `moderatePrompt`'s `{ok, categories}` shape is consumed identically in Task 3's two sites. `assertSpendAllowed(userId)` (Task 4) is called once, in preflight. `captureError(err, ctx)` (Task 6) scrubs the same prompt-key set `extractGraphPromptText` reads.
- Fail-direction: moderation fail-OPEN (Task 2), spend-controls fail-CLOSED (Task 4) — asserted in each task's tests.
- Local byte-identity: every task's deliverable is hosted-gated or env-gated with a local no-op test.
