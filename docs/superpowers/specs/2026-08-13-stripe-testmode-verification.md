# Stripe test-mode verification — run-book + results

**Plain summary:** Stripe's signed webhooks were fired at a real hosted Sailor server and the money landed in (and left) the real Neon ledger correctly: a Creator-pack purchase granted exactly 2,750 credits once (a replayed delivery granted nothing), and refunds clawed credits back — including the partial-shortfall path, live. Two real bugs were found and fixed by doing this live: an auth-middleware deadlock on webhook bodies, and Stripe's current API not embedding itemized refunds. After the operator re-pasted a valid key, every remaining leg was verified live: the itemized per-refund-id clawback (two partial refunds on one charge clawed exactly their own deltas, keyed by `re_` ids), and the real browser purchase — Julien bought the Studio pack through the actual checkout route, Stripe's hosted page, and the test card; 7,200 credits landed in Neon.

## Setup used (repeatable)

1. Worktree server (NEVER a second dev server in the main checkout — and NEVER `pnpm add/install` in the main checkout while both run; see the phantom-export outage):
   `git worktree add --detach /private/tmp/claude-501/sailor-stripe-verify HEAD && ln -s <main>/frontend/node_modules <worktree>/frontend/node_modules`
   Boot: `cd <worktree>/frontend && env $(grep -vE '^#|^$' <main>/frontend/.env.hosted | xargs) ./node_modules/.bin/nuxt dev --port 3100`
2. Forwarder: `stripe listen --forward-to 127.0.0.1:3100/api/webhooks/stripe` (get `whsec_` once via `stripe listen --print-secret` — NOTE: `--print-secret` prints and EXITS; run the persistent listen separately). Secret stored as `STRIPE_WEBHOOK_SECRET` in `.env.hosted`.
3. Grant events with real metadata, no browser needed:
   `stripe trigger checkout.session.completed --override "checkout_session:metadata[userId]=<id>" --override "checkout_session:metadata[packId]=creator" --override "checkout_session:metadata[credits]=2750"`

## VERIFIED (2026-08-13 21:0x–21:3x, all against live Neon)

- **Signature gate:** unsigned POST → 400; missing-secret would 500 (secret present).
- **Auth guard vs webhooks:** public paths short-circuit before session resolution — this was BROKEN (deadlock: Clerk's `toWebRequest` wrapped the body every request; `readRawBody` then hung; every forwarder delivery timed out). Fixed in `59afa6bab`, verified live.
- **Grant:** `checkout.session.completed` (paid, Creator metadata) → wallet 200 → 2,950; exactly one `pack_purchase:creator|2750` ledger row keyed by the event id.
- **Idempotency:** `stripe events resend <same evt>` → 200, balance unchanged, still exactly 1 row for that key.
- **Refund clawback (single):** $5.00 refund on a mapped customer → `refund_clawback|500` debit, wallet 2,950 → 2,450.
- **Shortfall path:** refund larger than available → debit capped at available, `[stripe] REFUND CLAWBACK SHORTFALL` logged loudly, action `clawback_partial`. Observed live.
- **Fetch-failure fallback:** with a broken API key, `[stripe] REFUND LIST FETCH FAILED` logged (twice) and the documented cumulative fallback ran — loud, never silent.

## FOUND + FIXED during this run

1. `fix(auth) 59afa6bab` — public-path body-stream deadlock (above). The Stage 1 smoke could not have caught it (no signed-body POST to a public path existed before Stripe).
2. `fix(billing) 88669c4ab` — **current Stripe API versions do NOT embed `refunds.data` on the charge**, so the multi-partial-refund-safe path never ran; the handler now fetches itemized refunds via `stripe.refunds.list` (dep-injected), keeping debits keyed by `re_` ids. Unit-proven (10/10); live proof pending the key fix below.

## COMPLETED after the key fix (2026-08-13 late / 2026-08-14)

- **Invalid-key interlude:** the first `sk_test_` paste was malformed (128 chars vs ~107). While broken, the fetch-failure fallback proved itself live (`REFUND LIST FETCH FAILED` ×2, loud, cumulative fallback ran). Re-pasted, validated via `balance.retrieve` (livemode:false) without printing.
- **Itemized clawback live:** one $10 payment, partial refunds of 250¢ then 400¢ → debits `250|re_…sKwHq7p` and `400|re_…2Ny6xB3` — keyed by refund ids, second refund clawed only its own delta. Replay of the charge.refunded event: balance unchanged.
- **Real browser purchase (Julien):** Studio pack via /account → checkout route → Stripe hosted page → 4242 test card → webhook → `pack_purchase:studio|7200` keyed by event id; wallet 1,800 → 9,000.
- **Three human-caught defects fixed along the way** (each invisible to compile/200 checks): (1) guarded-POST body-stream deadlock — Clerk auth wrapped the body, `readBody` hung, buttons froze silently; fixed with a body-less synthetic Request (a56320b8b + defensive follow-up); (2) I-beam cursor + chip-looking buttons — `select-none` + `enabled:cursor-pointer` + new `outline` StudioButton variant (940c86188); (3) `<StudioButton>` silently unresolved — NOT auto-imported, rendered as inert text; explicit import (5bbc1c566); the SSR log had `Failed to resolve component` ×7 the whole time.
- **Final-review blockers landed:** `stripe_customers` write serialized under the ledger mutex (`ledger.withLock`, ON CONFLICT DO NOTHING — a raw write on the shared session could interleave into an open money transaction) and `payment_method_types: ['card']` enforced in code (async payment methods would complete `unpaid` + fire an unhandled `async_payment_succeeded` — money taken, credits never granted — one dashboard toggle away if left to defaults).

## Stale-server gotchas that burned this run (teardown section is the cure)

Two rounds of "the fix didn't work" were a PRE-FIX server still holding :3100 — `pkill -f <worktree-path>` does not match node children (relative argv) and the replacement server silently took another port. Kill by open-file discovery, verify the listener pid's start time, purge `.nuxt` if in doubt.

## Test-wallet bookkeeping

The pre-fix runs over-clawed the test wallet to 0 (old cumulative code — exactly the bug the fix addresses; kept in ledger history deliberately as evidence). Restored via a proper ledger credit: `admin_grant:test-wallet-reset|2450` keyed `admin:reset-overclawed-testing-1`. Balance after the final browser purchase: **9,000**.

## Teardown

`pkill` is NOT sufficient for the worktree server (node children's argv lacks the worktree path — this bit us twice; a stale pre-fix server silently kept port 3100 while the "new" one took another port). Kill by open-file discovery:
`for p in $(lsof -nP | awk '/sailor-stripe-verify/ {print $2}' | sort -u); do kill $p; done`
then `git worktree remove --force /private/tmp/claude-501/sailor-stripe-verify`. The forwarder is a background `stripe listen` — kill it the same way (`pgrep -fl "stripe listen"`).
