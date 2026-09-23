# Sailor runner and the Gate — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A runner inside Sailor's own server that executes image → Gate → video workflows on fal without the Python engine: every step written down so a restart resumes rather than loses a run, one stage charged at a time, the Gate working in the hosted product with pick-the-best, plus exact costs, reuse of identical requests, real Stop, queue position, a fal webhook to wake the server, and a tab title/icon heads-up.

**Architecture:** A new `frontend/server/runner/` module in Nitro. A run is a JSON document (Postgres in hosted, a file per run locally) holding one or more *takes* (Re-roll ×N), each with a record per node. The engine walks the graph in *legs*: a leg runs every node it can reach until it hits a closed Gate or the end, holding credits per take before it starts and settling the exact amount when it ends. fal requests are submitted with a webhook and polled; their ids are written down before anything else happens, so a restarted server simply polls them again. The browser keeps building the same API prompt (`graphToPrompt.ts`); a routing check sends workflows made only of runner-known nodes and models to `POST /api/runs`, everything else to ComfyUI as today. Run events use ComfyUI's WebSocket message shapes and arrive over one server-sent-events stream, so the canvas code that already understands them keeps working.

**Tech Stack:** Nuxt 4 / Nitro (h3 1.15.8, `createEventStream`), TypeScript, Vue 3, vitest (+ `@electric-sql/pglite` for SQL), node:crypto (sha256, Ed25519), fal queue REST API.

**Spec:** `docs/superpowers/specs/2026-09-22-sailor-runner-and-gate-design.md` (read it first — this plan argues from it).

## Global Constraints

- **Work in the main checkout.** No worktree, no branch, never `git stash`. Several sessions share this checkout.
- **Subagents do not commit.** An implementer finishes a task with tests passing and reports the exact file paths it changed. The controller commits, per task, with the private-index recipe below — whole recipe in ONE Bash call, then the shared-index sync in a SECOND call.
  ```bash
  cd /Users/julien/Documents/GitHub/Sailor && BEFORE=$(git rev-parse HEAD) && export GIT_INDEX_FILE=$(mktemp -u) && git read-tree HEAD && git add -- <paths> && git diff --cached --stat HEAD && git commit -q -F <message-file>; RC=$?; rm -f "$GIT_INDEX_FILE"; unset GIT_INDEX_FILE; echo "exit $RC | HEAD ${BEFORE:0:9} -> $(git rev-parse --short HEAD)"
  ```
  then, separately: `cd /Users/julien/Documents/GitHub/Sailor && git reset -q -- <same paths>`. A commit counts only if the printed HEAD moved and `git show --stat HEAD` lists only the task's files. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Never run `npm run dev` / `pnpm dev`** from a subagent: it collides with the shared dev server on `:3002` and can take ComfyUI down. Browser checks are the controller's, against the server already running.
- **The runner ships switched off.** Server side: `NUXT_RUNNER_ENABLED=true`. Browser routing: `NUXT_PUBLIC_RUNNER_ENABLED=true`. Until both are set every workflow goes to ComfyUI exactly as today. Every new API route answers 404 while the server switch is off.
- **Runner model list (exact):** image — `flux-1.1-pro`, `flux-schnell`, `nano-banana-pro`, `nano-banana-2`, `ideogram-v3-quality`, `ideogram-v3-balanced`, `ideogram-v3-turbo`, `seedream-5-lite`, `seedream-4`. Video — `veo-3.1`, `veo-3.1-fast`, `flux-3`, `seedance-2.0`, `hailuo-h3`, `hailuo-h3-max`. `krea-2-large`, `krea-2-medium` and `seedream-5-pro` are **excluded**: they have no price (`pricePerImage: null` in `app/data/image-models.ts`), and a model must not ship without one.
- **Runner node list (exact):** `GenerateImageNode`, `GenerateVideoNode`, `ComfyGateNode`, `Image`, `Video`. A workflow with any other node goes to ComfyUI whole. A workflow is never split.
- **Moodboard reference pictures stay on fal**, through these endpoints (verified against fal's docs 2026-09-23): `nano-banana-2` → `fal-ai/nano-banana-2/edit`, `nano-banana-pro` → `fal-ai/nano-banana-pro/edit`, `seedream-4` → `fal-ai/bytedance/seedream/v4/edit`, `seedream-5-lite` → `fal-ai/bytedance/seedream/v5/lite/edit`; all take `image_urls: string[]`.
- **Never pay twice:** a request is reused only when its payload carries an explicit positive integer `seed`. A random-seed request (seed 0, or a model without a seed) is always sent.
- **Server runner modules import explicitly** (`import { x } from '../utils/y'`, `from 'h3'`), never through Nitro auto-imports, so vitest can load them. Code shared by the browser and the server lives in `frontend/shared/runner/` and is imported as `#shared/runner/...`.
- **Tests:** `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/<file>`. New specs live flat in `frontend/tests/unit/`, named `runner-*.unit.spec.ts`. Nitro's `createError` does not exist under vitest; runner modules throw `MeterRefusalError` (from `server/utils/requestMeter.ts`) instead.
- **Typecheck:** `cd frontend && npx vue-tsc --noEmit -p tsconfig.json 2>/dev/null | grep -E '<paths you touched>'` must show no errors that were not there before your change (`default.vue` has 5 pre-existing, `SettingsModal.vue` 2, `AssetsHistory.vue` 12, `VueNodeCanvas.vue` 16).
- **UI copy:** sentence case, plain words, no internal identifiers.
- **One server process.** The engine's per-run lock is in memory; running two Nitro machines against one database is out of scope.
- **No new npm dependencies.**

## File map

Server (new, `frontend/server/runner/`):

| File | Responsibility |
|---|---|
| `config.ts` | The switch and the public webhook base URL |
| `types.ts` | `RunRecord`, `TakeRecord`, `NodeRecord`, `LegRecord`, `StageCharge`, `OutputFile`, `PendingRequest` |
| `generators/opts.ts` | Python-compatible option readers (`optInt`, `optBool`, `optStr`, `arOr`, `maybeSetSeed`) |
| `generators/types.ts` | `ImageModelDesc`, `VideoModelDesc`, build-argument types |
| `generators/image.ts` | The 9 image models: endpoint, reference-picture endpoint, request builder; prompt composition |
| `generators/video.ts` | The 6 video models: endpoint, per-mode function, request builder |
| `falQueue.ts` | Metering-free fal queue client: submit (with webhook), status (queue position, progress), result, cancel |
| `store.ts` | `RunStore`: file store (local) and Postgres store (hosted); reusable-result lookup |
| `results.ts` | The one doorway for saving and reading result files (ComfyUI output folder today) |
| `handoff.ts` | Our saved file → a fal URL (upload, cached); content hash of a file |
| `inputs.ts` | Files a workflow reads first (moodboard pictures, loaded cards); are they yours |
| `fingerprint.ts` | Canonical fingerprint of a request; the reuse rule |
| `metering.ts` | Per-stage price, hold, settle, release; ownership rows in `graph_runs` |
| `events.ts` | In-process publish/subscribe per user; ComfyUI-shaped message builders |
| `executors.ts` | What each node type does, as a plan: send to a provider, pass files through, or pause |
| `engine.ts` | Runs, legs, the scheduler, polling, per-user limit, Gate actions, Stop, re-attach |
| `records.ts` | Writes generation history records to the project store |
| `webhook.ts` | Verifies fal webhook signatures (Ed25519 over JWKS) |
| `index.ts` | `getEngine()` — the engine wired to the real dependencies |

Server (new routes / plugin): `server/api/runs/index.post.ts`, `events.get.ts`, `gate.post.ts`, `stop.post.ts`, `paused.get.ts`, `record.get.ts`; `server/api/webhooks/fal.post.ts`; `server/plugins/runner.ts`.

Server (modified): `server/lib/nitroApiPaths.ts`, `server/utils/authGuard.ts`, `server/db/schema.sql`, `server/utils/graphRuns.ts`, `server/utils/priceBook.ts`, `server/utils/falRun.ts`.

Shared (new, `frontend/shared/runner/`): `graph.ts` (links, stages, leg calculation), `eligibility.ts` (the routing check and the model/node lists), `messages.ts` (gate choice and message payload types shared by both sides).

Browser (new): `app/lib/runner/client.ts`, `app/lib/runner/gateChoices.ts`, `app/composables/useRunnerEvents.ts`, `app/composables/useTabHeadsUp.ts`, `public/favicon.svg`.

Tests (new): `tests/unit/runner-*.unit.spec.ts`, `tests/unit/tab-heads-up.unit.spec.ts`, and the helper `tests/unit/__runner__/kit.ts` (fake fal, fake ledger, a wired engine).

Browser (modified): `app/lib/graph/wsEventMap.ts`, `app/layouts/default.vue`, `app/components/vue-canvas/VueNodeCanvas.vue`, `app/components/vue-canvas/ComfyGateNode.vue`, `app/components/vue-canvas/ComfyNode.vue`, `app/lib/canvas/capsuleReadout.ts`, `app/components/AssetDetailOverlay.vue`, `nuxt.config.ts`.

Tooling (new): `scripts/runner_builder_fixtures.py` (repo root) → `frontend/tests/unit/fixtures/runner-builders.json`.

## Words used in this plan

- **Take** — one version of the workflow. Re-roll ×4 is one run with 4 takes, each with its own seeds.
- **Leg** — one stretch of running, from Run (or a Gate button) until every take has finished, failed or paused at a Gate. Its id is the `prompt_id` the browser sees in events: `run_<uuid>.<n>`.
- **Stage key** — what one take is charged for in one leg: `run_<uuid>.<n>.t<take>`. It is the ledger hold key suffix, the `graph_runs.prompt_id`, and the generation record's `promptId`.

---

### Task 1: The switch, route plumbing, schema, and two small money helpers

**Files:**
- Create: `frontend/server/runner/config.ts`
- Modify: `frontend/nuxt.config.ts` (the `runtimeConfig.public` block, lines ~20–56)
- Modify: `frontend/server/lib/nitroApiPaths.ts:31-38`
- Modify: `frontend/server/utils/authGuard.ts:30`
- Modify: `frontend/server/db/schema.sql` (append)
- Modify: `frontend/server/utils/graphRuns.ts` (add `appendGraphRunOutput`; `pendingRuns` skips runner rows)
- Modify: `frontend/server/utils/priceBook.ts:18` (export `BASE_RENDER_CREDITS`)
- Test: `frontend/tests/unit/runner-config.unit.spec.ts`, `frontend/tests/unit/runner-schema.unit.spec.ts`, `frontend/tests/unit/graph-runs.unit.spec.ts` (extend)

**Interfaces:**
- Produces: `runnerEnabled(): boolean`, `webhookBaseUrl(): string | null`, `RUNNER_PER_USER_LIMIT = 4` (config.ts); `appendGraphRunOutput(promptId: string, key: string): Promise<void>` (graphRuns.ts); `BASE_RENDER_CREDITS: number` exported from priceBook.ts; tables `runner_runs`, `runner_results`; runtime config `public.runnerEnabled: boolean`.

- [ ] **Step 1: Write the failing tests**

`frontend/tests/unit/runner-config.unit.spec.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest'
import { runnerEnabled, webhookBaseUrl, RUNNER_PER_USER_LIMIT } from '~~/server/runner/config'

const saved = { ...process.env }
afterEach(() => { process.env = { ...saved } })

describe('runner switch', () => {
  it('is off unless NUXT_RUNNER_ENABLED is truthy', () => {
    delete process.env.NUXT_RUNNER_ENABLED
    expect(runnerEnabled()).toBe(false)
    process.env.NUXT_RUNNER_ENABLED = 'false'
    expect(runnerEnabled()).toBe(false)
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) {
      process.env.NUXT_RUNNER_ENABLED = v
      expect(runnerEnabled()).toBe(true)
    }
  })

  it('reads the webhook base URL without a trailing slash', () => {
    delete process.env.NUXT_RUNNER_WEBHOOK_BASE_URL
    expect(webhookBaseUrl()).toBeNull()
    process.env.NUXT_RUNNER_WEBHOOK_BASE_URL = '  https://app.example.com//  '
    expect(webhookBaseUrl()).toBe('https://app.example.com')
  })

  it('limits four provider calls in flight per user', () => {
    expect(RUNNER_PER_USER_LIMIT).toBe(4)
  })
})
```

`frontend/tests/unit/runner-schema.unit.spec.ts`:
```ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

const schema = readFileSync(fileURLToPath(new URL('../../server/db/schema.sql', import.meta.url)), 'utf8')

describe('runner tables', () => {
  it('create idempotently and hold a run document and a reusable result', async () => {
    const db = new PGlite()
    await db.exec(schema)
    await db.exec(schema) // re-running the file must not fail
    await db.query(
      `INSERT INTO runner_runs (run_id, user_id, canvas_id, status, doc) VALUES ($1, $2, $3, $4, $5::jsonb)`,
      ['run_a', 'u1', 'c1', 'paused', JSON.stringify({ id: 'run_a' })])
    const { rows } = await db.query<{ doc: any }>(`SELECT doc FROM runner_runs WHERE status = 'paused'`)
    expect(rows[0]!.doc).toEqual({ id: 'run_a' })
    await db.query(
      `INSERT INTO runner_results (user_id, fingerprint, files) VALUES ($1, $2, $3::jsonb)`,
      ['u1', 'fp1', JSON.stringify([{ filename: 'a.png' }])])
    const r = await db.query<{ files: any }>(`SELECT files FROM runner_results WHERE user_id = 'u1' AND fingerprint = 'fp1'`)
    expect(r.rows[0]!.files).toEqual([{ filename: 'a.png' }])
  })
})
```

Append to `frontend/tests/unit/graph-runs.unit.spec.ts` (inside the existing top-level `describe`, reusing its `query` mock and `beforeEach`; add `appendGraphRunOutput` to the existing import from `~~/server/utils/graphRuns`):
```ts
  it('appendGraphRunOutput adds one output key to the row', async () => {
    query.mockResolvedValueOnce({ rows: [] })
    await appendGraphRunOutput('run_x.0.t0', 'output::generate_image_00001_.png')
    expect(query.mock.calls[0][0]).toMatch(/outputs = outputs \|\| \$1::jsonb/)
    expect(query.mock.calls[0][1]).toEqual([JSON.stringify(['output::generate_image_00001_.png']), 'run_x.0.t0'])
  })

  it('pendingRuns leaves runner rows out of the ComfyUI harvest', async () => {
    query.mockResolvedValueOnce({ rows: [] })
    await pendingRuns('u1')
    expect(query.mock.calls[0][0]).toMatch(/target IS NULL OR target <> 'runner'/)
  })
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/runner-config.unit.spec.ts tests/unit/runner-schema.unit.spec.ts tests/unit/graph-runs.unit.spec.ts`
Expected: FAIL — `server/runner/config` not found; `runner_runs` does not exist; `appendGraphRunOutput` is not exported.

- [ ] **Step 3: Implement**

`frontend/server/runner/config.ts`:
```ts
/**
 * The runner's switch and the public address fal calls back.
 *
 * Read from process.env (not runtimeConfig) so request handlers, background
 * polls and unit tests all see the same value — the same reason deployMode()
 * reads process.env.
 *   NUXT_RUNNER_ENABLED=true                 server side on (routes, engine, plugin)
 *   NUXT_PUBLIC_RUNNER_ENABLED=true          browser routing on (runtimeConfig.public)
 *   NUXT_RUNNER_WEBHOOK_BASE_URL=https://…   public origin fal can reach; unset locally
 */
function truthy(v: string | undefined): boolean {
  if (typeof v !== 'string') return false
  const s = v.trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

export function runnerEnabled(): boolean {
  return truthy(process.env.NUXT_RUNNER_ENABLED)
}

export function webhookBaseUrl(): string | null {
  const v = process.env.NUXT_RUNNER_WEBHOOK_BASE_URL?.trim()
  if (!v) return null
  return v.replace(/\/+$/, '')
}

/** Provider calls one user may have in flight at once; the rest wait in order. */
export const RUNNER_PER_USER_LIMIT = 4
```

`frontend/nuxt.config.ts` — inside `runtimeConfig.public`, after `hostedMode: …,` add:
```ts
      // Sailor runner routing (docs/superpowers/specs/2026-09-22-sailor-runner-and-gate-design.md).
      // Off by default; NUXT_PUBLIC_RUNNER_ENABLED=true turns it on at runtime.
      runnerEnabled: false,
```

`frontend/server/lib/nitroApiPaths.ts` — add `'/api/runs'` to `NITRO_API_PREFIXES`:
```ts
  '/api/wardrobe', '/api/frame', '/api/runs',
```

`frontend/server/utils/authGuard.ts:30`:
```ts
export const PUBLIC_API_PATHS = ['/api/webhooks/clerk', '/api/webhooks/stripe', '/api/webhooks/fal']
```

`frontend/server/db/schema.sql` — append:
```sql

-- Sailor runner (docs/superpowers/specs/2026-09-22-sailor-runner-and-gate-design.md).
-- One row per run; the whole run lives in `doc` (see server/runner/types.ts).
-- No FK to users: a run row is written before any money moves, and the
-- ledger rows it leads to carry their own FK.
CREATE TABLE IF NOT EXISTS runner_runs (
  run_id     text PRIMARY KEY,
  user_id    text,
  canvas_id  text,
  status     text NOT NULL CHECK (status IN ('running', 'paused', 'done', 'error', 'stopped')),
  doc        jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS runner_runs_active ON runner_runs (status) WHERE status IN ('running', 'paused');
CREATE INDEX IF NOT EXISTS runner_runs_user_canvas ON runner_runs (user_id, canvas_id);

-- Results that can be handed back for an identical request (explicit seed only).
CREATE TABLE IF NOT EXISTS runner_results (
  user_id     text NOT NULL,
  fingerprint text NOT NULL,
  files       jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, fingerprint)
);
```

`frontend/server/utils/graphRuns.ts` — change the `pendingRuns` SQL and add a helper after `resolveGraphRun`:
```ts
export async function pendingRuns(userId: string, limit = 20): Promise<{ promptId: string; holdId: number | null; credits: number; target: string | null }[]> {
  // Runner rows (target 'runner') are settled by the runner itself; polling
  // ComfyUI's /history for them would only ever miss.
  const { rows } = await db().query(
    `SELECT prompt_id, hold_id, credits, target FROM graph_runs
     WHERE user_id = $1 AND state = 'pending' AND (target IS NULL OR target <> 'runner')
     ORDER BY created_at DESC
     LIMIT $2`, [userId, limit])
  return rows.map(r => ({
    promptId: String(r.prompt_id),
    holdId: r.hold_id == null ? null : Number(r.hold_id),
    credits: Number(r.credits),
    target: r.target == null ? null : String(r.target),
  }))
}
```
```ts
/** Record one more output file as belonging to this row — the runner calls it
 *  the moment a file is saved, so the image viewer's ownership check passes
 *  before the browser asks for the file. */
export async function appendGraphRunOutput(promptId: string, key: string): Promise<void> {
  await db().query(
    `UPDATE graph_runs SET outputs = outputs || $1::jsonb WHERE prompt_id = $2`,
    [JSON.stringify([key]), promptId])
}
```

`frontend/server/utils/priceBook.ts:18`:
```ts
export const BASE_RENDER_CREDITS = 1
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/runner-config.unit.spec.ts tests/unit/runner-schema.unit.spec.ts tests/unit/graph-runs.unit.spec.ts tests/unit/api-route-reachability.unit.spec.ts tests/unit/price-graph.unit.spec.ts`
Expected: PASS (all files).

- [ ] **Step 5: Commit** (controller)

Paths: `frontend/server/runner/config.ts frontend/nuxt.config.ts frontend/server/lib/nitroApiPaths.ts frontend/server/utils/authGuard.ts frontend/server/db/schema.sql frontend/server/utils/graphRuns.ts frontend/server/utils/priceBook.ts frontend/tests/unit/runner-config.unit.spec.ts frontend/tests/unit/runner-schema.unit.spec.ts frontend/tests/unit/graph-runs.unit.spec.ts`
Message: `feat(runner): switch, route allowlists, runner tables, output-append helper`

---

### Task 2: Shared graph helpers and the routing check

**Files:**
- Create: `frontend/shared/runner/graph.ts`
- Create: `frontend/shared/runner/eligibility.ts`
- Test: `frontend/tests/unit/runner-graph.unit.spec.ts`, `frontend/tests/unit/runner-eligibility.unit.spec.ts`

**Interfaces:**
- Produces (graph.ts): `type ApiLink = [string, number]`; `interface ApiNode { class_type: string; inputs: Record<string, unknown>; _meta?: unknown }`; `type ApiPrompt = Record<string, ApiNode>`; `GATE_CLASS = 'ComfyGateNode'`; `isLink(v): v is ApiLink`; `linksOf(node): { input: string; from: string; slot: number }[]`; `dependenciesOf(prompt, id): string[]`; `upstreamStage(prompt, gateId): Set<string>`; `downstreamNodes(prompt, gateId): Set<string>`; `interface TakeGateState { done: ReadonlySet<string>; open: ReadonlySet<string>; dropped: ReadonlySet<string> }`; `legNodes(prompt, s: TakeGateState): Set<string>`.
- Produces (eligibility.ts): `RUNNER_NODE_TYPES: ReadonlySet<string>`; `GENERATOR_TYPES: ReadonlySet<string>`; `RUNNER_IMAGE_MODEL_IDS: readonly string[]`; `RUNNER_VIDEO_MODEL_IDS: readonly string[]`; `LEGACY_VIDEO_MODEL_REMAP: Record<string, string>`; `resolveVideoModelId(model: unknown): string`; `isRunnerEligible(prompt): boolean`.

- [ ] **Step 1: Write the failing tests**

`frontend/tests/unit/runner-graph.unit.spec.ts`:
```ts
import { describe, expect, it } from 'vitest'
import {
  isLink, dependenciesOf, upstreamStage, downstreamNodes, legNodes, type ApiPrompt,
} from '#shared/runner/graph'

// image(1) -> gate(2) -> video(3) -> videoSink(4); image(1) -> imageSink(5)
const flow = (bypass = false): ApiPrompt => ({
  '1': { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a cat', aspect_ratio: '1:1', seed: 7, model_options: '{}' } },
  '2': { class_type: 'ComfyGateNode', inputs: { data_in: ['1', 0], bypass } },
  '3': { class_type: 'GenerateVideoNode', inputs: { model: 'hailuo-h3', prompt: 'moves', image: ['2', 0], aspect_ratio: '16:9', duration: '5', seed: 0, model_options: '{}' } },
  '4': { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'video/ComfyUI', source: ['3', 0] } },
  '5': { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
})
const none = new Set<string>()

describe('isLink', () => {
  it('matches ComfyUI is_link', () => {
    expect(isLink(['1', 0])).toBe(true)
    expect(isLink(['1', 0.0])).toBe(true)
    expect(isLink([1, 0])).toBe(false)
    expect(isLink(['1'])).toBe(false)
    expect(isLink('1')).toBe(false)
  })
})

describe('stages', () => {
  it('upstreamStage stops at other Gates (server.py _get_upstream_stage)', () => {
    const p = flow()
    expect([...upstreamStage(p, '2')].sort()).toEqual(['1'])
    p['6'] = { class_type: 'ComfyGateNode', inputs: { data_in: ['4', 0], bypass: false } }
    expect([...upstreamStage(p, '6')].sort()).toEqual(['3', '4'])
  })
  it('downstreamNodes walks forward from the Gate', () => {
    expect([...downstreamNodes(flow(), '2')].sort()).toEqual(['3', '4'])
  })
  it('dependenciesOf lists distinct upstream ids that exist', () => {
    expect(dependenciesOf(flow(), '3')).toEqual(['2'])
    expect(dependenciesOf(flow(), '1')).toEqual([])
  })
})

describe('legNodes', () => {
  it('first leg reaches the Gate and stops behind it', () => {
    expect([...legNodes(flow(), { done: none, open: none, dropped: none })].sort()).toEqual(['1', '2', '5'])
  })
  it('after Continue the next leg runs what was behind the Gate', () => {
    const s = { done: new Set(['1', '2', '5']), open: new Set(['2']), dropped: none }
    expect([...legNodes(flow(), s)].sort()).toEqual(['3', '4'])
  })
  it('a Gate with pass-through on does not stop anything', () => {
    expect([...legNodes(flow(true), { done: none, open: none, dropped: none })].sort()).toEqual(['1', '2', '3', '4', '5'])
  })
  it('a dropped Gate and everything behind it stay out', () => {
    const s = { done: new Set(['1', '5']), open: none, dropped: new Set(['2']) }
    expect([...legNodes(flow(), s)]).toEqual([])
  })
})
```

`frontend/tests/unit/runner-eligibility.unit.spec.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { isRunnerEligible, resolveVideoModelId, RUNNER_IMAGE_MODEL_IDS, RUNNER_VIDEO_MODEL_IDS } from '#shared/runner/eligibility'
import type { ApiPrompt } from '#shared/runner/graph'

const img = (model = 'flux-schnell') => ({ class_type: 'GenerateImageNode', inputs: { model, prompt: 'x', aspect_ratio: '1:1', seed: 1, model_options: '{}' } })

describe('isRunnerEligible', () => {
  it('takes an image → Gate → video workflow on runner models', () => {
    const p: ApiPrompt = {
      '1': img(),
      '2': { class_type: 'ComfyGateNode', inputs: { data_in: ['1', 0], bypass: false } },
      '3': { class_type: 'GenerateVideoNode', inputs: { model: 'veo-3.1', prompt: 'y', image: ['2', 0], aspect_ratio: '16:9', duration: '8', seed: 0, model_options: '{}' } },
      '4': { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'v', source: ['3', 0] } },
    }
    expect(isRunnerEligible(p)).toBe(true)
  })
  it('refuses a workflow with any other node type', () => {
    expect(isRunnerEligible({ '1': img(), '2': { class_type: 'ImageBlur', inputs: { image: ['1', 0] } } })).toBe(false)
  })
  it('refuses a model that is not on the runner list', () => {
    expect(isRunnerEligible({ '1': img('imagen-4') })).toBe(false)
    expect(isRunnerEligible({ '1': img('krea-2-large') })).toBe(false)
  })
  it('refuses a workflow with no generator, an empty one, or a dangling link', () => {
    expect(isRunnerEligible({ '1': { class_type: 'Image', inputs: { image: 'a.png' } } })).toBe(false)
    expect(isRunnerEligible({})).toBe(false)
    expect(isRunnerEligible({ '1': { class_type: 'Image', inputs: { images: ['9', 0] } }, '2': img() })).toBe(false)
  })
  it('refuses a video node with sound wired in', () => {
    expect(isRunnerEligible({ '1': { class_type: 'GenerateVideoNode', inputs: { model: 'veo-3.1', audio: ['1', 0] } } })).toBe(false)
  })
  it('maps legacy video labels the way GenerateVideoNode does', () => {
    expect(resolveVideoModelId('Veo 3')).toBe('veo-3.1')
    expect(resolveVideoModelId('Seedance 2.0')).toBe('seedance-2.0')
    expect(resolveVideoModelId('hailuo-h3')).toBe('hailuo-h3')
  })
  it('lists exactly the 9 + 6 runner models', () => {
    expect(RUNNER_IMAGE_MODEL_IDS).toHaveLength(9)
    expect(RUNNER_VIDEO_MODEL_IDS).toHaveLength(6)
  })
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/runner-graph.unit.spec.ts tests/unit/runner-eligibility.unit.spec.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`frontend/shared/runner/graph.ts`:
```ts
/**
 * Pure helpers over the API prompt the canvas builds (app/lib/graph/graphToPrompt.ts):
 * `{ [nodeId]: { class_type, inputs } }`, where an input wired to another node
 * is a link `[sourceNodeId, outputSlot]`. Used by the browser (routing) and
 * by the server (the runner). Keep this file free of imports.
 */
export type ApiLink = [string, number]
export interface ApiNode { class_type: string; inputs: Record<string, unknown>; _meta?: unknown }
export type ApiPrompt = Record<string, ApiNode>

export const GATE_CLASS = 'ComfyGateNode'

/** Port of comfy_execution.graph_utils.is_link. */
export function isLink(v: unknown): v is ApiLink {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number'
}

export function linksOf(node: ApiNode | undefined): { input: string; from: string; slot: number }[] {
  const out: { input: string; from: string; slot: number }[] = []
  for (const [input, v] of Object.entries(node?.inputs ?? {})) {
    if (isLink(v)) out.push({ input, from: v[0], slot: v[1] })
  }
  return out
}

/** Distinct nodes this one reads from that exist in the prompt. */
export function dependenciesOf(prompt: ApiPrompt, nodeId: string): string[] {
  return [...new Set(linksOf(prompt[nodeId]).map(l => l.from))].filter(id => id in prompt)
}

/** Port of server.py _get_upstream_stage: everything between this Gate and
 *  the previous Gate (or the start). Other Gates are the boundary. */
export function upstreamStage(prompt: ApiPrompt, gateId: string): Set<string> {
  const upstream = new Set<string>()
  const visited = new Set<string>()
  const queue = linksOf(prompt[gateId]).map(l => l.from)
  while (queue.length) {
    const id = queue.pop()!
    if (visited.has(id)) continue
    visited.add(id)
    const node = prompt[id]
    if (node?.class_type === GATE_CLASS) continue
    upstream.add(id)
    for (const l of linksOf(node)) queue.push(l.from)
  }
  return upstream
}

/** Port of server.py _get_downstream_nodes. */
export function downstreamNodes(prompt: ApiPrompt, gateId: string): Set<string> {
  const downstream = new Set<string>()
  const visited = new Set<string>()
  const queue = [gateId]
  while (queue.length) {
    const id = queue.pop()!
    if (visited.has(id)) continue
    visited.add(id)
    for (const [otherId, node] of Object.entries(prompt)) {
      if (visited.has(otherId)) continue
      if (linksOf(node).some(l => l.from === id)) {
        downstream.add(otherId)
        queue.push(otherId)
      }
    }
  }
  return downstream
}

export interface TakeGateState {
  /** Nodes already finished (a Gate you continued past counts as finished). */
  done: ReadonlySet<string>
  /** Gates you continued past for this take. */
  open: ReadonlySet<string>
  /** Gates where this take was not picked — nothing behind them runs. */
  dropped: ReadonlySet<string>
}

/**
 * The nodes one leg will execute for one take: not finished, every input
 * either finished or produced in this same leg, and nothing behind a Gate
 * that is still closed or was dropped. A closed Gate is itself in the leg —
 * it is reached, and it pauses. A Gate with pass-through on
 * (`inputs.bypass === true`) never closes.
 */
export function legNodes(prompt: ApiPrompt, s: TakeGateState): Set<string> {
  const leg = new Set<string>()
  const closed = (id: string) =>
    prompt[id]?.class_type === GATE_CLASS && prompt[id]!.inputs?.bypass !== true && !s.open.has(id)
  let changed = true
  while (changed) {
    changed = false
    for (const id of Object.keys(prompt)) {
      if (leg.has(id) || s.done.has(id) || s.dropped.has(id)) continue
      const ok = dependenciesOf(prompt, id).every(d =>
        (s.done.has(d) || leg.has(d)) && !s.dropped.has(d) && !closed(d))
      if (ok) { leg.add(id); changed = true }
    }
  }
  return leg
}
```

`frontend/shared/runner/eligibility.ts`:
```ts
/**
 * Which workflows the Sailor runner takes. Everything else goes to ComfyUI
 * whole — a workflow is never split between the two.
 */
import { isLink, type ApiPrompt } from './graph'

export const RUNNER_NODE_TYPES: ReadonlySet<string> = new Set([
  'GenerateImageNode', 'GenerateVideoNode', 'ComfyGateNode', 'Image', 'Video',
])

export const GENERATOR_TYPES: ReadonlySet<string> = new Set(['GenerateImageNode', 'GenerateVideoNode'])

/** The image models that default to fal AND have a price. krea-2-large,
 *  krea-2-medium and seedream-5-pro are left out until they are priced. */
export const RUNNER_IMAGE_MODEL_IDS = [
  'flux-1.1-pro', 'flux-schnell', 'nano-banana-pro', 'nano-banana-2',
  'ideogram-v3-quality', 'ideogram-v3-balanced', 'ideogram-v3-turbo',
  'seedream-5-lite', 'seedream-4',
] as const

export const RUNNER_VIDEO_MODEL_IDS = [
  'veo-3.1', 'veo-3.1-fast', 'flux-3', 'seedance-2.0', 'hailuo-h3', 'hailuo-h3-max',
] as const

/** GenerateVideoNode._LEGACY_MODEL_REMAP (comfy_api_nodes/nodes_replicate.py). */
export const LEGACY_VIDEO_MODEL_REMAP: Record<string, string> = {
  'Seedance 2.0': 'seedance-2.0',
  'Veo 3': 'veo-3.1',
  'Kling 2.1': 'kling-v2.5-turbo-pro',
}

const IMAGE_IDS: ReadonlySet<string> = new Set(RUNNER_IMAGE_MODEL_IDS)
const VIDEO_IDS: ReadonlySet<string> = new Set(RUNNER_VIDEO_MODEL_IDS)

export function resolveVideoModelId(model: unknown): string {
  const m = typeof model === 'string' ? model : ''
  return LEGACY_VIDEO_MODEL_REMAP[m] ?? m
}

export function isRunnerEligible(prompt: ApiPrompt | null | undefined): boolean {
  if (!prompt) return false
  const nodes = Object.values(prompt)
  if (!nodes.length) return false
  let generators = 0
  for (const n of nodes) {
    if (!n || !RUNNER_NODE_TYPES.has(n.class_type)) return false
    const inputs = n.inputs ?? {}
    if (n.class_type === 'GenerateImageNode') {
      generators++
      if (!IMAGE_IDS.has(String(inputs.model))) return false
    }
    else if (n.class_type === 'GenerateVideoNode') {
      generators++
      if (!VIDEO_IDS.has(resolveVideoModelId(inputs.model))) return false
      if (isLink(inputs.audio)) return false
    }
    for (const v of Object.values(inputs)) {
      if (isLink(v) && !(v[0] in prompt)) return false
    }
  }
  return generators > 0
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/runner-graph.unit.spec.ts tests/unit/runner-eligibility.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (controller)

Paths: `frontend/shared/runner/graph.ts frontend/shared/runner/eligibility.ts frontend/tests/unit/runner-graph.unit.spec.ts frontend/tests/unit/runner-eligibility.unit.spec.ts`
Message: `feat(runner): shared graph helpers and the routing check`

---

### Task 3: Image models — one description each, checked against Python

**Files:**
- Create: `scripts/runner_builder_fixtures.py` (repo root)
- Create: `frontend/tests/unit/fixtures/runner-builders.json` (generated)
- Create: `frontend/server/runner/generators/opts.ts`
- Create: `frontend/server/runner/generators/types.ts`
- Create: `frontend/server/runner/generators/image.ts`
- Test: `frontend/tests/unit/runner-image-models.unit.spec.ts`

**Interfaces:**
- Consumes: `RUNNER_IMAGE_MODEL_IDS` (Task 2).
- Produces (opts.ts): `optInt(adv, key, def): number`, `optBool(adv, key, def): boolean`, `optStr(adv, key, def): string`, `maybeSetSeed(inp, seed): void`, `arOr(allowed: ReadonlySet<string>, ar: string, fallback: string): string`, `parseJsonObject(raw: unknown): Record<string, unknown>`, `asText(v: unknown): string`, `asInt(v: unknown, def: number): number`.
- Produces (types.ts): `ImageBuildArgs { prompt; aspectRatio; seed; adv; refs: string[] | null }`, `ImageModelDesc { id; label; app; refsApp: string | null; build(a: ImageBuildArgs): Record<string, unknown> }`, `VideoBuildArgs { prompt; aspectRatio; duration; seed; image: string | null; adv }`, `VideoModelDesc { id; label; app; defaultDuration; fnByMode: { t2v: string; firstLast: string; reference?: string }; build(a: VideoBuildArgs): Record<string, unknown> }`.
- Produces (image.ts): `RUNNER_IMAGE_MODELS: Record<string, ImageModelDesc>`, `imageAppFor(desc, refs): string`, `falImageSize(ar): string`, `composeImagePrompt(i): string`, `STYLE_REFS_INSTRUCTION: string`.

- [ ] **Step 1: Write the fixture generator**

`scripts/runner_builder_fixtures.py`:
```python
"""Writes frontend/tests/unit/fixtures/runner-builders.json: the fal request
Python builds today for every runner model, for a spread of inputs. The
TypeScript builders in frontend/server/runner/generators/ must produce the
same payloads (tests/unit/runner-image-models.unit.spec.ts,
runner-video-models.unit.spec.ts). Re-run after changing a Python builder:

    cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python scripts/runner_builder_fixtures.py
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from comfy_api_nodes.image_models import IMAGE_MODELS_BY_ID  # noqa: E402
from comfy_api_nodes.video_models import VIDEO_MODELS_BY_ID  # noqa: E402

IMAGE_IDS = [
    "flux-1.1-pro", "flux-schnell", "nano-banana-pro", "nano-banana-2",
    "ideogram-v3-quality", "ideogram-v3-balanced", "ideogram-v3-turbo",
    "seedream-5-lite", "seedream-4",
]
VIDEO_IDS = ["veo-3.1", "veo-3.1-fast", "flux-3", "seedance-2.0", "hailuo-h3", "hailuo-h3-max"]

COMMON_IMAGE_CASES = [
    {"prompt": "a red fox", "ar": "1:1", "seed": 0, "adv": {}},
    {"prompt": "a red fox", "ar": "16:9", "seed": 42, "adv": {}},
    {"prompt": "wide", "ar": "7:3", "seed": 5, "adv": {}},          # unsupported ratio
    {"prompt": "portrait", "ar": "4:5", "seed": 0, "adv": {"output_format": "jpg"}},
]
EXTRA_IMAGE_CASES = {
    "flux-1.1-pro": [{"prompt": "p", "ar": "3:2", "seed": 1, "adv": {"safety_tolerance": 9}},
                     {"prompt": "p", "ar": "3:2", "seed": 1, "adv": {"safety_tolerance": "0"}}],
    "flux-schnell": [{"prompt": "p", "ar": "9:21", "seed": 3, "adv": {"num_outputs": 3, "num_inference_steps": "6"}},
                     {"prompt": "p", "ar": "1:1", "seed": 3, "adv": {"num_outputs": 9}}],
    "nano-banana-2": [{"prompt": "p", "ar": "4:1", "seed": 2, "adv": {"resolution": "4K", "google_search": True}},
                      {"prompt": "p", "ar": "1:1", "seed": 2, "adv": {"resolution": "huge", "google_search": "yes"}}],
    "nano-banana-pro": [{"prompt": "p", "ar": "21:9", "seed": 0, "adv": {"resolution": "1K"}},
                        {"prompt": "p", "ar": "4:1", "seed": 0, "adv": {"resolution": "0.5K"}}],
    "ideogram-v3-quality": [{"prompt": "p", "ar": "3:1", "seed": 4, "adv": {"magic_prompt": "Off", "style_type": "Design"}},
                            {"prompt": "p", "ar": "3:1", "seed": 4, "adv": {"style_type": "Fancy"}}],
    "seedream-5-lite": [{"prompt": "p", "ar": "2:3", "seed": 9, "adv": {"sequential_image_generation": "auto", "max_images": 9}},
                        {"prompt": "p", "ar": "2:3", "seed": 9, "adv": {"sequential_image_generation": "auto"}}],
    "seedream-4": [{"prompt": "p", "ar": "21:9", "seed": 11, "adv": {}}],
}

COMMON_VIDEO_CASES = [
    {"prompt": "a wave", "ar": "16:9", "dur": 5, "seed": 0, "image": None, "adv": {}},
    {"prompt": "a wave", "ar": "9:16", "dur": 7, "seed": 12, "image": "IMAGE_URL", "adv": {}},
    {"prompt": "a wave", "ar": "4:1", "dur": 100, "seed": 0, "image": None, "adv": {}},
]
EXTRA_VIDEO_CASES = {
    "veo-3.1": [{"prompt": "p", "ar": "16:9", "dur": 6, "seed": 3, "image": None,
                 "adv": {"negative_prompt": "blur", "generate_audio": False, "enhance_prompt": False, "resolution": "1080p"}}],
    "flux-3": [{"prompt": "p", "ar": "1:1", "dur": 12, "seed": 0, "image": None, "adv": {"generate_audio": "off"}}],
    "seedance-2.0": [
        {"prompt": "p", "ar": "3:4", "dur": 14, "seed": 0, "image": None,
         "adv": {"image_urls": ["https://r/1.png"], "generate_audio": True}},
        {"prompt": "p", "ar": "3:4", "dur": 5, "seed": 0, "image": None,
         "adv": {"image_url": "https://r/first.png", "end_image_url": "https://r/last.png"}},
    ],
    "hailuo-h3": [{"prompt": "p", "ar": "21:9", "dur": 10, "seed": 8, "image": None,
                   "adv": {"resolution": "4k", "prompt_expansion_mode": "fast"}}],
    "hailuo-h3-max": [{"prompt": "p", "ar": "21:9", "dur": 6, "seed": 8, "image": "IMAGE_URL",
                       "adv": {"prompt_expansion_mode": "fast", "end_image_url": "https://r/last.png"}}],
}


def main() -> None:
    out = {"image": [], "video": []}
    for mid in IMAGE_IDS:
        spec = IMAGE_MODELS_BY_ID[mid]
        for c in COMMON_IMAGE_CASES + EXTRA_IMAGE_CASES.get(mid, []):
            payload = spec.fal_build_input(c["prompt"], c["ar"], int(c["seed"] or 0), dict(c["adv"]), None)
            out["image"].append({"model": mid, "args": c, "payload": payload})
    for mid in VIDEO_IDS:
        spec = VIDEO_MODELS_BY_ID[mid]
        for c in COMMON_VIDEO_CASES + EXTRA_VIDEO_CASES.get(mid, []):
            payload = spec.build_input(c["prompt"], c["ar"], int(c["dur"]), int(c["seed"] or 0),
                                       c["image"], None, dict(c["adv"]))
            out["video"].append({"model": mid, "args": c, "payload": payload})
    dest = os.path.join(ROOT, "frontend", "tests", "unit", "fixtures", "runner-builders.json")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, sort_keys=True)
        f.write("\n")
    print(f"wrote {len(out['image'])} image and {len(out['video'])} video cases to {dest}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Generate the fixtures**

Run: `cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python scripts/runner_builder_fixtures.py`
Expected: `wrote 49 image and 24 video cases to …/frontend/tests/unit/fixtures/runner-builders.json`. (The counts come from the case lists; if Python fails to import `comfy_api_nodes.image_models`, stop and report — do not hand-write the fixture.)

- [ ] **Step 3: Write the failing test**

`frontend/tests/unit/runner-image-models.unit.spec.ts`:
```ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  RUNNER_IMAGE_MODELS, imageAppFor, composeImagePrompt, STYLE_REFS_INSTRUCTION,
} from '~~/server/runner/generators/image'
import { RUNNER_IMAGE_MODEL_IDS } from '#shared/runner/eligibility'
import { IMAGE_MODELS_BY_ID } from '~~/app/data/image-models'

const fixtures = JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/runner-builders.json', import.meta.url)), 'utf8'))

describe('image request builders match Python', () => {
  for (const c of fixtures.image as any[]) {
    it(`${c.model} ${JSON.stringify(c.args)}`, () => {
      const desc = RUNNER_IMAGE_MODELS[c.model]!
      const got = desc.build({ prompt: c.args.prompt, aspectRatio: c.args.ar, seed: c.args.seed, adv: c.args.adv, refs: null })
      expect(got).toEqual(c.payload)
    })
  }
})

describe('image model list', () => {
  it('describes exactly the runner models, each with a price', () => {
    expect(Object.keys(RUNNER_IMAGE_MODELS).sort()).toEqual([...RUNNER_IMAGE_MODEL_IDS].sort())
    for (const id of RUNNER_IMAGE_MODEL_IDS) {
      expect(typeof IMAGE_MODELS_BY_ID[id]?.pricePerImage, id).toBe('number')
    }
  })
})

describe('moodboard pictures on fal', () => {
  const refs = ['https://fal.test/a.png', 'https://fal.test/b.png']
  it('nano-banana-2 goes to its edit endpoint with image_urls and no web search', () => {
    const d = RUNNER_IMAGE_MODELS['nano-banana-2']!
    expect(imageAppFor(d, refs)).toBe('fal-ai/nano-banana-2/edit')
    const p = d.build({ prompt: 'p', aspectRatio: '1:1', seed: 3, adv: { google_search: true }, refs })
    expect(p.image_urls).toEqual(refs)
    expect(p).not.toHaveProperty('enable_web_search')
    expect(p.seed).toBe(3)
  })
  it('nano-banana-pro, seedream-4 and seedream-5-lite have edit endpoints', () => {
    expect(imageAppFor(RUNNER_IMAGE_MODELS['nano-banana-pro']!, refs)).toBe('fal-ai/nano-banana-pro/edit')
    expect(imageAppFor(RUNNER_IMAGE_MODELS['seedream-4']!, refs)).toBe('fal-ai/bytedance/seedream/v4/edit')
    expect(imageAppFor(RUNNER_IMAGE_MODELS['seedream-5-lite']!, refs)).toBe('fal-ai/bytedance/seedream/v5/lite/edit')
    const s5 = RUNNER_IMAGE_MODELS['seedream-5-lite']!.build({ prompt: 'p', aspectRatio: '1:1', seed: 3, adv: {}, refs })
    expect(s5.image_urls).toEqual(refs)
    expect(s5).not.toHaveProperty('seed')
  })
  it('models without a reference endpoint ignore pictures', () => {
    const d = RUNNER_IMAGE_MODELS['flux-schnell']!
    expect(d.refsApp).toBeNull()
    expect(imageAppFor(d, refs)).toBe('fal-ai/flux/schnell')
    expect(d.build({ prompt: 'p', aspectRatio: '1:1', seed: 0, adv: {}, refs })).not.toHaveProperty('image_urls')
  })
})

describe('composeImagePrompt (GenerateImageNode.execute)', () => {
  it('orders taste wire · style block · idea · prompt', () => {
    expect(composeImagePrompt({ prompt: 'a cat', promptIn: 'idea', styleBlock: ' soft light ', styleIn: 'taste', hasRefs: false }))
      .toBe('taste soft light idea a cat')
  })
  it('lets the idea stand alone when the prompt is empty', () => {
    expect(composeImagePrompt({ prompt: '  ', promptIn: 'idea', hasRefs: false })).toBe('idea')
  })
  it('appends the style-only instruction when pictures ride along', () => {
    expect(composeImagePrompt({ prompt: 'a cat', hasRefs: true })).toBe(`a cat ${STYLE_REFS_INSTRUCTION}`)
  })
})
```

- [ ] **Step 4: Run it and confirm it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/runner-image-models.unit.spec.ts`
Expected: FAIL — `server/runner/generators/image` not found.

- [ ] **Step 5: Implement**

`frontend/server/runner/generators/opts.ts`:
```ts
/**
 * Python-compatible readers for the per-model `model_options` bag, ported
 * from comfy_api_nodes/image_models.py (_opt_int, _opt_bool, _opt_str,
 * _maybe_set_seed, _ar_or). `adv.get(key, default)` only falls back when the
 * key is MISSING — a present-but-null value goes through the conversion,
 * which is why each reader checks own-property first.
 */
const has = (adv: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(adv, key)

function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined) return false
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') return v.length > 0
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'object') return Object.keys(v as object).length > 0
  return Boolean(v)
}

export function optInt(adv: Record<string, unknown>, key: string, def: number): number {
  if (!has(adv, key)) return def
  const v = adv[key]
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : def
  if (v === null || v === undefined) return def
  const s = String(v).trim()
  return /^[+-]?\d+$/.test(s) ? Number.parseInt(s, 10) : def
}

export function optBool(adv: Record<string, unknown>, key: string, def: boolean): boolean {
  if (!has(adv, key)) return def
  const v = adv[key]
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return ['true', '1', 'yes', 'on'].includes(v.toLowerCase())
  return pyTruthy(v)
}

export function optStr(adv: Record<string, unknown>, key: string, def: string): string {
  if (!has(adv, key)) return def
  const v = adv[key]
  if (v === null || v === undefined) return def
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  return String(v)
}

export function maybeSetSeed(inp: Record<string, unknown>, seed: number): void {
  if (seed && seed > 0) inp.seed = seed
}

export function arOr(allowed: ReadonlySet<string>, ar: string, fallback: string): string {
  return allowed.has(ar) ? ar : fallback
}

/** `json.loads(model_options or "{}")`, tolerant like GenerateImageNode. */
export function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
  }
  catch {
    return {}
  }
}

export function asText(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** `int(value or 0)` for widget values that are numbers or numeric strings. */
export function asInt(v: unknown, def: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return Number.parseInt(v, 10)
  return def
}

export { pyTruthy }
```

`frontend/server/runner/generators/types.ts`:
```ts
export interface ImageBuildArgs {
  prompt: string
  aspectRatio: string
  seed: number
  adv: Record<string, unknown>
  /** fal URLs of moodboard reference pictures, or null. */
  refs: string[] | null
}

export interface ImageModelDesc {
  id: string
  label: string
  /** fal endpoint for text-to-image. */
  app: string
  /** fal endpoint that takes reference pictures (`image_urls`), or null. */
  refsApp: string | null
  build(a: ImageBuildArgs): Record<string, unknown>
}

export interface VideoBuildArgs {
  prompt: string
  aspectRatio: string
  duration: number
  seed: number
  /** fal URL of the first frame, or null. */
  image: string | null
  adv: Record<string, unknown>
}

export interface VideoModelDesc {
  id: string
  label: string
  /** fal app (the part before the function). */
  app: string
  defaultDuration: number
  /** fal function per mode, as in video_models.py fal_fn_by_mode. '' submits to the app itself. */
  fnByMode: { t2v: string; firstLast: string; reference?: string }
  build(a: VideoBuildArgs): Record<string, unknown>
}
```

`frontend/server/runner/generators/image.ts`:
```ts
/**
 * The runner's image models — one description each. Request builders are
 * ports of the fal builders in comfy_api_nodes/image_models.py and must
 * produce identical payloads (tests/unit/runner-image-models.unit.spec.ts
 * compares against fixtures generated from Python). Reference-picture
 * endpoints are Sailor's own: Python only ever sent moodboard pictures to
 * Replicate.
 */
import { RUNNER_IMAGE_MODEL_IDS } from '#shared/runner/eligibility'
import { arOr, maybeSetSeed, optBool, optInt, optStr } from './opts'
import type { ImageBuildArgs, ImageModelDesc } from './types'

const NANO_BANANA_AR = new Set(['1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9'])
const NANO_BANANA_PRO_AR = new Set(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'])

const FAL_IMAGE_SIZE_BY_AR: Record<string, string> = {
  '1:1': 'square_hd',
  '4:3': 'landscape_4_3',
  '3:4': 'portrait_4_3',
  '16:9': 'landscape_16_9',
  '9:16': 'portrait_16_9',
  '3:2': 'landscape_4_3',
  '5:4': 'landscape_4_3',
  '16:10': 'landscape_16_9',
  '21:9': 'landscape_16_9',
  '2:1': 'landscape_16_9',
  '2:3': 'portrait_4_3',
  '4:5': 'portrait_4_3',
  '10:16': 'portrait_16_9',
  '9:21': 'portrait_16_9',
  '1:2': 'portrait_16_9',
}

export function falImageSize(ar: string): string {
  return FAL_IMAGE_SIZE_BY_AR[ar] ?? 'square_hd'
}

function falOutputFormat(adv: Record<string, unknown>, def = 'png'): string {
  const v = optStr(adv, 'output_format', def)
  return v === 'jpg' ? 'jpeg' : v
}

function withRefs(inp: Record<string, unknown>, refs: string[] | null): Record<string, unknown> {
  if (refs?.length) inp.image_urls = [...refs]
  return inp
}

function fluxProV11({ prompt, aspectRatio, seed, adv }: ImageBuildArgs) {
  const tol = Math.min(6, Math.max(1, optInt(adv, 'safety_tolerance', 2)))
  const inp: Record<string, unknown> = {
    prompt,
    image_size: falImageSize(aspectRatio),
    num_images: 1,
    output_format: optStr(adv, 'output_format', 'png'),
    safety_tolerance: String(tol),
  }
  maybeSetSeed(inp, seed)
  return inp
}

function fluxSchnell({ prompt, aspectRatio, seed, adv }: ImageBuildArgs) {
  const inp: Record<string, unknown> = {
    prompt,
    image_size: falImageSize(aspectRatio),
    num_inference_steps: optInt(adv, 'num_inference_steps', 4),
    num_images: Math.max(1, Math.min(4, optInt(adv, 'num_outputs', 1))),
    output_format: optStr(adv, 'output_format', 'png'),
  }
  maybeSetSeed(inp, seed)
  return inp
}

const FAL_IDEOGRAM_STYLE: Record<string, string> = { Auto: 'AUTO', General: 'GENERAL', Realistic: 'REALISTIC', Design: 'DESIGN' }

function ideogramV3(renderingSpeed: 'QUALITY' | 'BALANCED' | 'TURBO') {
  return ({ prompt, aspectRatio, seed, adv }: ImageBuildArgs) => {
    const inp: Record<string, unknown> = {
      prompt,
      image_size: falImageSize(aspectRatio),
      rendering_speed: renderingSpeed,
      num_images: 1,
      expand_prompt: optStr(adv, 'magic_prompt', 'Auto').toLowerCase() !== 'off',
    }
    const style = optStr(adv, 'style_type', 'None')
    if (style in FAL_IDEOGRAM_STYLE) inp.style = FAL_IDEOGRAM_STYLE[style]
    maybeSetSeed(inp, seed)
    return inp
  }
}

function nanoBanana2({ prompt, aspectRatio, seed, adv, refs }: ImageBuildArgs) {
  let res = optStr(adv, 'resolution', '1K')
  if (!['0.5K', '1K', '2K', '4K'].includes(res)) res = '1K'
  const inp: Record<string, unknown> = {
    prompt,
    aspect_ratio: arOr(NANO_BANANA_AR, aspectRatio, '1:1'),
    resolution: res,
    num_images: 1,
    output_format: falOutputFormat(adv),
  }
  // The edit endpoint (pictures) has no web-search switch.
  if (!refs?.length) inp.enable_web_search = optBool(adv, 'google_search', false)
  maybeSetSeed(inp, seed)
  return withRefs(inp, refs)
}

function nanoBananaPro({ prompt, aspectRatio, seed, adv, refs }: ImageBuildArgs) {
  let res = optStr(adv, 'resolution', '2K')
  if (!['1K', '2K', '4K'].includes(res)) res = '2K'
  const inp: Record<string, unknown> = {
    prompt,
    aspect_ratio: arOr(NANO_BANANA_PRO_AR, aspectRatio, '1:1'),
    resolution: res,
    num_images: 1,
    output_format: falOutputFormat(adv),
  }
  maybeSetSeed(inp, seed)
  return withRefs(inp, refs)
}

function seedream5Lite({ prompt, aspectRatio, adv, refs }: ImageBuildArgs) {
  // No seed parameter on this endpoint (text or edit).
  const inp: Record<string, unknown> = {
    prompt,
    image_size: falImageSize(aspectRatio),
    num_images: 1,
    max_images: 1,
  }
  if (optStr(adv, 'sequential_image_generation', 'disabled') === 'auto') {
    inp.max_images = Math.max(1, Math.min(6, optInt(adv, 'max_images', 1)))
  }
  return withRefs(inp, refs)
}

function seedreamV4({ prompt, aspectRatio, seed, refs }: ImageBuildArgs) {
  const inp: Record<string, unknown> = {
    prompt,
    image_size: falImageSize(aspectRatio),
    num_images: 1,
    max_images: 1,
  }
  maybeSetSeed(inp, seed)
  return withRefs(inp, refs)
}

const D = (id: string, label: string, app: string, refsApp: string | null, build: ImageModelDesc['build']): ImageModelDesc =>
  ({ id, label, app, refsApp, build })

export const RUNNER_IMAGE_MODELS: Record<string, ImageModelDesc> = {
  'flux-1.1-pro': D('flux-1.1-pro', 'Flux 1.1 Pro', 'fal-ai/flux-pro/v1.1', null, fluxProV11),
  'flux-schnell': D('flux-schnell', 'Flux Schnell', 'fal-ai/flux/schnell', null, fluxSchnell),
  'nano-banana-pro': D('nano-banana-pro', 'Nano Banana Pro', 'google/nano-banana-pro', 'fal-ai/nano-banana-pro/edit', nanoBananaPro),
  'nano-banana-2': D('nano-banana-2', 'Nano Banana 2', 'fal-ai/nano-banana-2', 'fal-ai/nano-banana-2/edit', nanoBanana2),
  'ideogram-v3-quality': D('ideogram-v3-quality', 'Ideogram V3 Quality', 'fal-ai/ideogram/v3', null, ideogramV3('QUALITY')),
  'ideogram-v3-balanced': D('ideogram-v3-balanced', 'Ideogram V3 Balanced', 'fal-ai/ideogram/v3', null, ideogramV3('BALANCED')),
  'ideogram-v3-turbo': D('ideogram-v3-turbo', 'Ideogram V3 Turbo', 'fal-ai/ideogram/v3', null, ideogramV3('TURBO')),
  'seedream-5-lite': D('seedream-5-lite', 'Seedream 5 Lite', 'fal-ai/bytedance/seedream/v5/lite/text-to-image', 'fal-ai/bytedance/seedream/v5/lite/edit', seedream5Lite),
  'seedream-4': D('seedream-4', 'Seedream 4', 'fal-ai/bytedance/seedream/v4/text-to-image', 'fal-ai/bytedance/seedream/v4/edit', seedreamV4),
}

// Fail at import if the shared list and this table ever disagree.
for (const id of RUNNER_IMAGE_MODEL_IDS) {
  if (!RUNNER_IMAGE_MODELS[id]) throw new Error(`runner image model ${id} has no description`)
}

export function imageAppFor(desc: ImageModelDesc, refs: string[] | null): string {
  return refs?.length && desc.refsApp ? desc.refsApp : desc.app
}

export const STYLE_REFS_INSTRUCTION
  = 'Use the attached reference images strictly as STYLE references — match '
  + 'their palette, light, grain and mood; do not copy their subjects or '
  + 'composition.'

/** GenerateImageNode.execute's prompt order: style_in · style_block · prompt_in · prompt, then the style-only instruction when pictures ride along. */
export function composeImagePrompt(i: { prompt: string; promptIn?: string; styleBlock?: string; styleIn?: string; hasRefs: boolean }): string {
  let prompt = i.prompt
  const promptIn = (i.promptIn ?? '').trim()
  if (promptIn) prompt = prompt.trim() ? `${promptIn} ${prompt}` : promptIn
  const styleBlock = (i.styleBlock ?? '').trim()
  if (styleBlock) prompt = `${styleBlock} ${prompt}`
  const styleIn = (i.styleIn ?? '').trim()
  if (styleIn) prompt = `${styleIn} ${prompt}`.trim()
  if (i.hasRefs) prompt = `${prompt} ${STYLE_REFS_INSTRUCTION}`.trim()
  return prompt
}
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/runner-image-models.unit.spec.ts`
Expected: PASS (every fixture case). If a fixture case fails, the TypeScript port is wrong — fix the port, never the fixture.

- [ ] **Step 7: Commit** (controller)

Paths: `scripts/runner_builder_fixtures.py frontend/tests/unit/fixtures/runner-builders.json frontend/server/runner/generators/opts.ts frontend/server/runner/generators/types.ts frontend/server/runner/generators/image.ts frontend/tests/unit/runner-image-models.unit.spec.ts`
Message: `feat(runner): image model descriptions, matched to the Python builders`

---

### Task 4: Video models

**Files:**
- Create: `frontend/server/runner/generators/video.ts`
- Test: `frontend/tests/unit/runner-video-models.unit.spec.ts`

**Interfaces:**
- Consumes: `optBool`, `optStr`, `maybeSetSeed`, `arOr`, `pyTruthy` (Task 3); `VideoModelDesc` (Task 3); `RUNNER_VIDEO_MODEL_IDS` (Task 2); fixtures (Task 3).
- Produces: `RUNNER_VIDEO_MODELS: Record<string, VideoModelDesc>`, `falVideoFn(payload, fnByMode): string`, `durOr(allowed, d, fallback): number`.

- [ ] **Step 1: Write the failing test**

`frontend/tests/unit/runner-video-models.unit.spec.ts`:
```ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { RUNNER_VIDEO_MODELS, falVideoFn, durOr } from '~~/server/runner/generators/video'
import { RUNNER_VIDEO_MODEL_IDS } from '#shared/runner/eligibility'
import { VIDEO_MODEL_USD } from '~~/app/data/video-prices'

const fixtures = JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/runner-builders.json', import.meta.url)), 'utf8'))

describe('video request builders match Python', () => {
  for (const c of fixtures.video as any[]) {
    it(`${c.model} ${JSON.stringify(c.args)}`, () => {
      const d = RUNNER_VIDEO_MODELS[c.model]!
      const got = d.build({ prompt: c.args.prompt, aspectRatio: c.args.ar, duration: c.args.dur, seed: c.args.seed, image: c.args.image, adv: c.args.adv })
      expect(got).toEqual(c.payload)
    })
  }
})

describe('video model list', () => {
  it('describes exactly the runner models, each with a price', () => {
    expect(Object.keys(RUNNER_VIDEO_MODELS).sort()).toEqual([...RUNNER_VIDEO_MODEL_IDS].sort())
    for (const id of RUNNER_VIDEO_MODEL_IDS) expect(typeof VIDEO_MODEL_USD[id]?.usd, id).toBe('number')
  })
})

describe('falVideoFn (nodes_replicate._fal_fn_for_input)', () => {
  const seedance = RUNNER_VIDEO_MODELS['seedance-2.0']!.fnByMode
  it('a first frame picks image-to-video', () => {
    expect(falVideoFn({ image_url: 'u' }, seedance)).toBe('image-to-video')
  })
  it('reference arrays pick reference-to-video', () => {
    expect(falVideoFn({ image_urls: ['u'] }, seedance)).toBe('reference-to-video')
  })
  it('otherwise text-to-video; Veo submits to the app itself', () => {
    expect(falVideoFn({}, seedance)).toBe('text-to-video')
    expect(falVideoFn({}, RUNNER_VIDEO_MODELS['veo-3.1']!.fnByMode)).toBe('')
  })
  it('refuses a mode the model has no endpoint for', () => {
    expect(() => falVideoFn({ image_urls: ['u'] }, RUNNER_VIDEO_MODELS['hailuo-h3-max']!.fnByMode)).toThrow()
  })
})

describe('durOr', () => {
  it('keeps a supported value, else the closest, first on a tie', () => {
    expect(durOr([4, 6, 8], 6, 8)).toBe(6)
    expect(durOr([4, 6, 8], 7, 8)).toBe(6)
    expect(durOr([5, 10], 100, 5)).toBe(10)
    expect(durOr([], 3, 5)).toBe(5)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/runner-video-models.unit.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`frontend/server/runner/generators/video.ts`:
```ts
/**
 * The runner's video models. Builders are ports of comfy_api_nodes/video_models.py
 * (the fal-provider entries) and must match the Python payloads exactly
 * (tests/unit/runner-video-models.unit.spec.ts).
 */
import { RUNNER_VIDEO_MODEL_IDS } from '#shared/runner/eligibility'
import { arOr, maybeSetSeed, optBool, optStr, pyTruthy } from './opts'
import type { VideoBuildArgs, VideoModelDesc } from './types'

/** video_models._dur_or: the value if supported, else the closest (first on a tie). */
export function durOr(allowed: number[], d: number, fallback: number): number {
  if (allowed.includes(d)) return d
  if (!allowed.length) return fallback
  let best = allowed[0]!
  for (const a of allowed) if (Math.abs(a - d) < Math.abs(best - d)) best = a
  return best
}

const VEO_AR = new Set(['16:9', '9:16'])
const FLUX3_AR = new Set(['16:9', '9:16', '1:1'])
const SEEDANCE_AR = new Set(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'])
const H3_AR = new Set(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'])
const H3_RES: Record<string, string> = { '480p': '480P', '768p': '768P', '2k': '2K', '4k': '4K' }
const H3_PEM_BASE = new Set(['disabled', 'fast', 'balanced', 'quality'])
const H3_PEM_MAX = new Set(['disabled', 'balanced', 'quality'])

function veo31({ prompt, aspectRatio, duration, seed, image, adv }: VideoBuildArgs) {
  const inp: Record<string, unknown> = {
    prompt,
    duration: `${durOr([4, 6, 8], duration, 8)}s`,
    resolution: optStr(adv, 'resolution', '720p'),
    generate_audio: optBool(adv, 'generate_audio', true),
    auto_fix: optBool(adv, 'enhance_prompt', true),
  }
  const neg = optStr(adv, 'negative_prompt', '')
  if (neg) inp.negative_prompt = neg
  if (image) inp.image_url = image
  else inp.aspect_ratio = arOr(VEO_AR, aspectRatio, '16:9')
  maybeSetSeed(inp, seed)
  return inp
}

function flux3({ prompt, aspectRatio, duration, seed, image, adv }: VideoBuildArgs) {
  const inp: Record<string, unknown> = {
    prompt,
    duration: durOr([5, 10, 15, 20], duration, 10),
    resolution: optStr(adv, 'resolution', '720p'),
    generate_audio: optBool(adv, 'generate_audio', true),
  }
  if (image) inp.image_url = image
  else inp.aspect_ratio = arOr(FLUX3_AR, aspectRatio, '16:9')
  maybeSetSeed(inp, seed)
  return inp
}

function seedance20({ prompt, aspectRatio, duration, image, adv }: VideoBuildArgs) {
  // No seed input on fal's Seedance 2.0.
  const inp: Record<string, unknown> = {
    prompt,
    duration: String(durOr([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15], duration, 5)),
    resolution: optStr(adv, 'resolution', '720p'),
  }
  if (Object.prototype.hasOwnProperty.call(adv, 'generate_audio')) inp.generate_audio = pyTruthy(adv.generate_audio)
  const first = image || optStr(adv, 'image_url', '')
  if (first) {
    inp.image_url = first
    const last = optStr(adv, 'end_image_url', '')
    if (last) inp.end_image_url = last
  }
  else {
    inp.aspect_ratio = arOr(SEEDANCE_AR, aspectRatio, '16:9')
    for (const key of ['image_urls', 'video_urls', 'audio_urls']) {
      const vals = adv[key]
      if (Array.isArray(vals) && vals.length) inp[key] = vals
    }
  }
  return inp
}

function hailuoH3Core(a: VideoBuildArgs, pemAllowed: ReadonlySet<string>) {
  const { prompt, aspectRatio, duration, seed, image, adv } = a
  const pem = optStr(adv, 'prompt_expansion_mode', 'balanced')
  const inp: Record<string, unknown> = {
    prompt,
    duration: durOr([5, 6, 10], duration, 5),
    resolution: H3_RES[optStr(adv, 'resolution', '768p').toLowerCase()] ?? '768P',
    prompt_expansion_mode: pemAllowed.has(pem) ? pem : 'balanced',
  }
  const first = image || optStr(adv, 'image_url', '')
  if (first) {
    inp.image_url = first
    const last = optStr(adv, 'end_image_url', '')
    if (last) inp.end_image_url = last
  }
  else {
    inp.aspect_ratio = arOr(H3_AR, aspectRatio, '16:9')
  }
  maybeSetSeed(inp, seed)
  return inp
}

export const RUNNER_VIDEO_MODELS: Record<string, VideoModelDesc> = {
  'veo-3.1': { id: 'veo-3.1', label: 'Veo 3.1', app: 'fal-ai/veo3.1', defaultDuration: 8, fnByMode: { t2v: '', firstLast: 'image-to-video', reference: 'image-to-video' }, build: veo31 },
  'veo-3.1-fast': { id: 'veo-3.1-fast', label: 'Veo 3.1 Fast', app: 'fal-ai/veo3.1/fast', defaultDuration: 8, fnByMode: { t2v: '', firstLast: 'image-to-video', reference: 'image-to-video' }, build: veo31 },
  'flux-3': { id: 'flux-3', label: 'FLUX 3', app: 'blackforestlabs/flux-3', defaultDuration: 10, fnByMode: { t2v: 'text-to-video', firstLast: 'image-to-video', reference: 'image-to-video' }, build: flux3 },
  'seedance-2.0': { id: 'seedance-2.0', label: 'Seedance 2.0', app: 'bytedance/seedance-2.0', defaultDuration: 5, fnByMode: { t2v: 'text-to-video', firstLast: 'image-to-video', reference: 'reference-to-video' }, build: seedance20 },
  'hailuo-h3': { id: 'hailuo-h3', label: 'Hailuo H3', app: 'minimax/h3', defaultDuration: 5, fnByMode: { t2v: 'text-to-video', firstLast: 'image-to-video', reference: 'reference-to-video' }, build: a => hailuoH3Core(a, H3_PEM_BASE) },
  'hailuo-h3-max': { id: 'hailuo-h3-max', label: 'Hailuo H3 Max', app: 'minimax/h3-max', defaultDuration: 5, fnByMode: { t2v: 'text-to-video', firstLast: 'image-to-video' }, build: a => hailuoH3Core(a, H3_PEM_MAX) },
}

for (const id of RUNNER_VIDEO_MODEL_IDS) {
  if (!RUNNER_VIDEO_MODELS[id]) throw new Error(`runner video model ${id} has no description`)
}

/** nodes_replicate._fal_fn_for_input. */
export function falVideoFn(payload: Record<string, unknown>, fnByMode: VideoModelDesc['fnByMode']): string {
  if (payload.image_url) return fnByMode.firstLast
  const hasRefs = ['image_urls', 'video_urls', 'audio_urls'].some(k => Array.isArray(payload[k]) && (payload[k] as unknown[]).length > 0)
  if (hasRefs) {
    if (fnByMode.reference === undefined) throw new Error('This video model cannot take reference clips or pictures')
    return fnByMode.reference
  }
  return fnByMode.t2v
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/runner-video-models.unit.spec.ts tests/unit/runner-image-models.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (controller)

Paths: `frontend/server/runner/generators/video.ts frontend/tests/unit/runner-video-models.unit.spec.ts`
Message: `feat(runner): video model descriptions, matched to the Python builders`

---
### Task 5: A fal client that only talks to fal

**Files:**
- Create: `frontend/server/runner/falQueue.ts`
- Modify: `frontend/server/utils/falRun.ts` (the `dispatch` function, lines 64–133)
- Test: `frontend/tests/unit/runner-fal-queue.unit.spec.ts`; re-run the existing `frontend/tests/unit/chokepoint-meter.unit.spec.ts`

**Interfaces:**
- Consumes: `getFalToken()` from `server/utils/falStorage.ts`.
- Produces: `FAL_QUEUE_BASE`; `class FalError extends Error { status: number | null }`; `interface FalSubmitted { requestId: string; statusUrl: string; responseUrl: string; cancelUrl: string; queuePosition: number | null }`; `interface FalStatus { status: string; queuePosition: number | null; logs: { message: string }[]; error: string | null; transient: boolean; raw: unknown }`; `falSubmit(endpoint, input, opts?: { webhookUrl?: string | null }): Promise<FalSubmitted>`; `falStatus(statusUrl, opts?: { logs?: boolean }): Promise<FalStatus>`; `falResult<T>(responseUrl): Promise<T>`; `falCancel(cancelUrl): Promise<'cancelled' | 'already-done' | 'not-found'>`; `percentFromLogs(logs): number | null`; `falImageUrls(result): string[]`; `falVideoUrl(result): string | null`; `type FalClient = { submit: typeof falSubmit; status: typeof falStatus; result: typeof falResult; cancel: typeof falCancel }`.

- [ ] **Step 1: Write the failing test**

`frontend/tests/unit/runner-fal-queue.unit.spec.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  falSubmit, falStatus, falResult, falCancel, percentFromLogs, falImageUrls, falVideoUrl, FalError,
} from '~~/server/runner/falQueue'

const res = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300, status, statusText: '',
  json: async () => body, text: async () => JSON.stringify(body),
})
let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => { process.env.FAL_KEY = 'k1'; fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.unstubAllGlobals(); delete process.env.FAL_KEY })

describe('falSubmit', () => {
  it('posts with the key and asks fal to call the webhook', async () => {
    fetchMock.mockResolvedValueOnce(res({ request_id: 'r1', status_url: 'S', response_url: 'R', cancel_url: 'C', queue_position: 2 }))
    const s = await falSubmit('fal-ai/flux/schnell', { prompt: 'x' }, { webhookUrl: 'https://app.test/api/webhooks/fal' })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://queue.fal.run/fal-ai/flux/schnell?fal_webhook=https%3A%2F%2Fapp.test%2Fapi%2Fwebhooks%2Ffal')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Key k1')
    expect(JSON.parse(init.body)).toEqual({ prompt: 'x' })
    expect(s).toEqual({ requestId: 'r1', statusUrl: 'S', responseUrl: 'R', cancelUrl: 'C', queuePosition: 2 })
  })
  it('builds the request urls itself when fal leaves them out', async () => {
    fetchMock.mockResolvedValueOnce(res({ request_id: 'r2' }))
    const s = await falSubmit('minimax/h3/image-to-video', {})
    expect(fetchMock.mock.calls[0]![0]).toBe('https://queue.fal.run/minimax/h3/image-to-video')
    expect(s.statusUrl).toBe('https://queue.fal.run/minimax/h3/image-to-video/requests/r2/status')
    expect(s.responseUrl).toBe('https://queue.fal.run/minimax/h3/image-to-video/requests/r2')
    expect(s.cancelUrl).toBe('https://queue.fal.run/minimax/h3/image-to-video/requests/r2/cancel')
    expect(s.queuePosition).toBeNull()
  })
  it('refuses without a key and reports a rejected submit', async () => {
    delete process.env.FAL_KEY
    await expect(falSubmit('a/b', {})).rejects.toThrow('FAL_KEY is not set')
    process.env.FAL_KEY = 'k1'
    fetchMock.mockResolvedValueOnce(res({ detail: 'bad' }, 422))
    await expect(falSubmit('a/b', {})).rejects.toThrow(/^fal submit 422/)
  })
})

describe('falStatus', () => {
  it('reads queue position and asks for logs only when told to', async () => {
    fetchMock.mockResolvedValueOnce(res({ status: 'IN_QUEUE', queue_position: 3 }, 202))
    const s = await falStatus('https://q/requests/r1/status')
    expect(fetchMock.mock.calls[0]![0]).toBe('https://q/requests/r1/status')
    expect(s).toMatchObject({ status: 'IN_QUEUE', queuePosition: 3, transient: false, error: null })
    fetchMock.mockResolvedValueOnce(res({ status: 'IN_PROGRESS', logs: [{ message: 'step 40%' }] }, 202))
    const p = await falStatus('https://q/requests/r1/status', { logs: true })
    expect(fetchMock.mock.calls[1]![0]).toBe('https://q/requests/r1/status?logs=1')
    expect(p.logs).toEqual([{ message: 'step 40%' }])
  })
  it('treats a 5xx as a blip and a 4xx as final', async () => {
    fetchMock.mockResolvedValueOnce(res({}, 503))
    expect((await falStatus('S')).transient).toBe(true)
    fetchMock.mockResolvedValueOnce(res({ detail: 'gone' }, 404))
    await expect(falStatus('S')).rejects.toBeInstanceOf(FalError)
  })
  it('passes through a completed-with-error answer', async () => {
    fetchMock.mockResolvedValueOnce(res({ status: 'COMPLETED', error: 'NSFW content detected' }))
    expect((await falStatus('S')).error).toBe('NSFW content detected')
  })
})

describe('falResult and falCancel', () => {
  it('returns the body, or throws on failure', async () => {
    fetchMock.mockResolvedValueOnce(res({ images: [{ url: 'u' }] }))
    expect(await falResult('R')).toEqual({ images: [{ url: 'u' }] })
    fetchMock.mockResolvedValueOnce(res({ detail: 'x' }, 500))
    await expect(falResult('R')).rejects.toThrow(/^fal result 500/)
  })
  it('maps cancel answers', async () => {
    fetchMock.mockResolvedValueOnce(res({ status: 'CANCELLATION_REQUESTED' }, 202))
    expect(await falCancel('C')).toBe('cancelled')
    expect(fetchMock.mock.calls[0]![1].method).toBe('PUT')
    fetchMock.mockResolvedValueOnce(res({ status: 'ALREADY_COMPLETED' }, 400))
    expect(await falCancel('C')).toBe('already-done')
    fetchMock.mockResolvedValueOnce(res({}, 404))
    expect(await falCancel('C')).toBe('not-found')
  })
})

describe('helpers', () => {
  it('percentFromLogs takes the last percentage it can find', () => {
    expect(percentFromLogs([])).toBeNull()
    expect(percentFromLogs([{ message: 'loading' }])).toBeNull()
    expect(percentFromLogs([{ message: '10%' }, { message: 'Generating 55% done' }])).toBe(55)
    expect(percentFromLogs([{ message: '250%' }])).toBeNull()
  })
  it('reads result urls', () => {
    expect(falImageUrls({ images: [{ url: 'a' }, { url: '' }, { url: 'b' }] })).toEqual(['a', 'b'])
    expect(falImageUrls({})).toEqual([])
    expect(falVideoUrl({ video: { url: 'v' } })).toBe('v')
    expect(falVideoUrl({ video: {} })).toBeNull()
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/runner-fal-queue.unit.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the client**

`frontend/server/runner/falQueue.ts`:
```ts
/**
 * fal queue client with no money handling — submit, check, fetch, cancel.
 * The runner charges per stage itself; runFal (server/utils/falRun.ts) wraps
 * this with its own per-call hold. Queue API:
 *   POST queue.fal.run/{endpoint}[?fal_webhook=URL] -> {request_id, status_url, response_url, cancel_url, queue_position}
 *   GET  status_url[?logs=1]  -> 202 while IN_QUEUE/IN_PROGRESS, 200 when COMPLETED
 *   GET  response_url         -> the result body
 *   PUT  cancel_url           -> 202 requested / 400 already completed / 404 unknown
 */
import { getFalToken } from '../utils/falStorage'

export const FAL_QUEUE_BASE = 'https://queue.fal.run'

export class FalError extends Error {
  status: number | null
  constructor(message: string, status: number | null) {
    super(message)
    this.name = 'FalError'
    this.status = status
  }
}

export interface FalSubmitted {
  requestId: string
  statusUrl: string
  responseUrl: string
  cancelUrl: string
  queuePosition: number | null
}

export interface FalStatus {
  status: string
  queuePosition: number | null
  logs: { message: string }[]
  error: string | null
  /** A 5xx from fal: try again later, nothing is known. */
  transient: boolean
  raw: unknown
}

function headers(): Record<string, string> {
  const token = getFalToken()
  if (!token) throw new Error('FAL_KEY is not set (add it to frontend/.env)')
  return { Authorization: `Key ${token}`, 'Content-Type': 'application/json' }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

export async function falSubmit(
  endpoint: string,
  input: Record<string, unknown>,
  opts: { webhookUrl?: string | null } = {},
): Promise<FalSubmitted> {
  const h = headers()
  const base = `${FAL_QUEUE_BASE}/${endpoint}`
  const url = opts.webhookUrl ? `${base}?fal_webhook=${encodeURIComponent(opts.webhookUrl)}` : base
  const r = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(input) })
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    throw new FalError(`fal submit ${r.status}: ${t || r.statusText}`, r.status)
  }
  const body = await r.json() as Record<string, unknown>
  const requestId = String(body.request_id ?? '')
  if (!requestId) throw new FalError('fal submit returned no request id', null)
  return {
    requestId,
    statusUrl: str(body.status_url) ?? `${base}/requests/${requestId}/status`,
    responseUrl: str(body.response_url) ?? `${base}/requests/${requestId}`,
    cancelUrl: str(body.cancel_url) ?? `${base}/requests/${requestId}/cancel`,
    queuePosition: num(body.queue_position),
  }
}

export async function falStatus(statusUrl: string, opts: { logs?: boolean } = {}): Promise<FalStatus> {
  const url = opts.logs ? `${statusUrl}${statusUrl.includes('?') ? '&' : '?'}logs=1` : statusUrl
  const r = await fetch(url, { headers: headers() })
  if (r.status !== 200 && r.status !== 202) {
    if (r.status >= 400 && r.status < 500) {
      const t = await r.text().catch(() => '')
      throw new FalError(`fal status ${r.status} (not retryable): ${t}`, r.status)
    }
    return { status: 'UNKNOWN', queuePosition: null, logs: [], error: null, transient: true, raw: null }
  }
  const body = await r.json() as Record<string, unknown>
  const logs = Array.isArray(body.logs)
    ? (body.logs as unknown[]).filter((l): l is { message: string } => !!l && typeof (l as any).message === 'string')
    : []
  return {
    status: String(body.status ?? 'UNKNOWN'),
    queuePosition: num(body.queue_position),
    logs,
    error: str(body.error),
    transient: false,
    raw: body,
  }
}

export async function falResult<T = unknown>(responseUrl: string): Promise<T> {
  const r = await fetch(responseUrl, { headers: headers() })
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    throw new FalError(`fal result ${r.status}: ${t}`, r.status)
  }
  return await r.json() as T
}

export async function falCancel(cancelUrl: string): Promise<'cancelled' | 'already-done' | 'not-found'> {
  const r = await fetch(cancelUrl, { method: 'PUT', headers: headers() })
  if (r.status === 400) return 'already-done'
  if (r.status === 404) return 'not-found'
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    throw new FalError(`fal cancel ${r.status}: ${t}`, r.status)
  }
  return 'cancelled'
}

export function percentFromLogs(logs: { message: string }[]): number | null {
  for (let i = logs.length - 1; i >= 0; i--) {
    const m = /(\d{1,3})\s*%/.exec(logs[i]!.message)
    if (m) {
      const n = Number(m[1])
      if (n >= 0 && n <= 100) return n
    }
  }
  return null
}

export function falImageUrls(result: unknown): string[] {
  const images = (result as { images?: Array<{ url?: unknown }> })?.images
  if (!Array.isArray(images)) return []
  return images.map(i => i?.url).filter((u): u is string => typeof u === 'string' && u.length > 0)
}

export function falVideoUrl(result: unknown): string | null {
  const url = (result as { video?: { url?: unknown } })?.video?.url
  return typeof url === 'string' && url ? url : null
}

export type FalClient = {
  submit: typeof falSubmit
  status: typeof falStatus
  result: typeof falResult
  cancel: typeof falCancel
}

export const realFalClient: FalClient = { submit: falSubmit, status: falStatus, result: falResult, cancel: falCancel }
```

- [ ] **Step 4: Make `runFal` use it, with identical behaviour**

In `frontend/server/utils/falRun.ts`, add `import { falSubmit, falStatus, falResult } from '../runner/falQueue'`, delete the now-unused `FAL_QUEUE_BASE` constant and `FalSubmit` interface, and replace the whole body of `dispatch` with:
```ts
async function dispatch<T>(
  app: string,
  input: Record<string, unknown>,
  opts: FalRunOptions,
  ticket: Awaited<ReturnType<typeof preflightMeter>>,
): Promise<T> {
  const submit = await falSubmit(app, input)
  const startedAt = Date.now()
  const rid = submit.requestId

  const deadline = Date.now() + (opts.pollDeadlineMs ?? 120_000)
  const interval = opts.pollIntervalMs ?? 1500
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval))
    // 4xx throws (unrecoverable: bad rid / revoked key); 5xx comes back transient.
    const status = await falStatus(submit.statusUrl)
    if (status.transient) continue
    if (status.status === 'IN_QUEUE' || status.status === 'IN_PROGRESS') continue
    if (status.status === 'COMPLETED') {
      logSpend({ provider: 'fal', model: app, ok: true, ms: Date.now() - startedAt })
      // Settle only once the output is genuinely in hand — a body that fails
      // to parse means the caller gets nothing, so it must not be charged.
      const body = await falResult<T>(submit.responseUrl)
      if (ticket) {
        await ticket.settle('fal:' + rid)
        // job_id here is `settle:${holdId}` — see replicate.ts's dispatch()
        // for why (ledger.settle() hardcodes the debit idempotency_key as
        // `settle:${holdId}`, ignoring the jobId string passed to
        // ticket.settle()); Task 5's reconciliation join needs this exact key.
        void recordProviderUsage({
          userId: currentMeterContext()?.userId ?? null,
          provider: 'fal',
          model: app,
          usd: costForModel(app)?.usd ?? null,
          jobId: 'settle:' + ticket.holdId,
        })
      }
      return body
    }
    logSpend({ provider: 'fal', model: app, ok: false, ms: Date.now() - startedAt })
    throw new Error(`fal request ${rid} ended in ${status.status}: ${JSON.stringify(status.raw)}`)
  }
  throw new Error(`fal request timed out (id=${rid})`)
}
```
Leave `runFal`, `firstFalImageUrl`, `firstFalVideoUrl` and the file header untouched.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/runner-fal-queue.unit.spec.ts tests/unit/chokepoint-meter.unit.spec.ts`
Expected: PASS, including every existing chokepoint-meter case (it proves `runFal` still holds, settles and releases exactly as before). Then `grep -rln "falRun" tests/unit | xargs pnpm vitest run` — all PASS.

- [ ] **Step 6: Commit** (controller)

Paths: `frontend/server/runner/falQueue.ts frontend/server/utils/falRun.ts frontend/tests/unit/runner-fal-queue.unit.spec.ts`
Message: `feat(runner): fal queue client without billing; runFal uses it unchanged`

---

### Task 6: The written-down run — types and storage

**Files:**
- Create: `frontend/server/runner/types.ts`
- Create: `frontend/server/runner/store.ts`
- Test: `frontend/tests/unit/runner-store.unit.spec.ts`

**Interfaces:**
- Consumes: `ApiPrompt` (Task 2); `storeDir` (`server/utils/dataDir.ts`); `connectLedgerDb` (`server/utils/ledgerDb.ts`); `isHosted` (`server/utils/deployMode.ts`).
- Produces (types.ts): everything below, used by every later server task.
- Produces (store.ts): `interface RunStore { save(run: RunRecord): Promise<void>; get(runId: string): Promise<RunRecord | null>; listActive(): Promise<RunRecord[]>; listForUser(userId: string | null, opts?: { canvasId?: string | null; statuses?: RunStatus[] }): Promise<RunRecord[]>; getResult(userKey: string, fingerprint: string): Promise<OutputFile[] | null>; putResult(userKey: string, fingerprint: string, files: OutputFile[]): Promise<void> }`; `createFileRunStore(dir: string): RunStore`; `createPgRunStore(db: DbLike): RunStore`; `getRunStore(): RunStore`; `__setRunStoreForTests(s: RunStore | null): void`; `isRunId(v: unknown): v is string`; `runIdOf(promptId: string): string | null`; `userKeyOf(userId: string | null): string`.

- [ ] **Step 1: Write the types** (no test of their own — the store test exercises them)

`frontend/server/runner/types.ts`:
```ts
/**
 * The runner's written-down state. One RunRecord per run, saved after every
 * change, so a restarted server can pick up exactly where it was.
 *
 *   run   — one press of Run (or Re-roll ×N): the workflow plus N takes
 *   take  — one version of the workflow with its own seeds
 *   leg   — one stretch of running (Run, or a Gate button) — `${runId}.${n}`
 *   stage — what one take is charged for in one leg — `${legId}.t${take}`
 */
import type { ApiPrompt } from '#shared/runner/graph'

export type RunStatus = 'running' | 'paused' | 'done' | 'error' | 'stopped'

export interface OutputFile {
  filename: string
  subfolder: string
  type: 'output' | 'input' | 'temp'
}

export interface PendingRequest {
  requestId: string
  statusUrl: string
  responseUrl: string
  cancelUrl: string
  submittedAt: number
  queuePosition: number | null
}

export type NodeStatus = 'waiting' | 'running' | 'done' | 'error' | 'skipped' | 'paused' | 'dropped' | 'stopped'

export interface NodeRecord {
  status: NodeStatus
  classType: string
  /** Leg index this record was last run in. */
  leg: number | null
  /** fal endpoint the request went to. */
  endpoint: string | null
  /** The exact request body sent to fal. */
  payload: Record<string, unknown> | null
  /** Set only when the request may be reused (explicit seed). */
  fingerprint: string | null
  request: PendingRequest | null
  outputs: OutputFile[]
  /** True when an earlier identical result was handed back (charged nothing). */
  reused: boolean
  /** This node's price in credits (0 for result cards and Gates). */
  credits: number
  startedAt: number | null
  endedAt: number | null
  error: string | null
}

export interface TakeRecord {
  index: number
  /** This take's workflow — its own seeds; Redo bumps them here. */
  prompt: ApiPrompt
  nodes: Record<string, NodeRecord>
  /** Gates this take was let through. */
  openGates: string[]
  /** Gates where this take was not picked — nothing behind them runs. */
  droppedGates: string[]
}

export type LegAction = 'run' | 'continue' | 'again' | 'redo' | 'restart'

export interface LegRecord {
  index: number
  id: string
  action: LegAction
  gateId: string | null
  takes: number[]
  status: 'running' | 'done'
  startedAt: number
  endedAt: number | null
}

export interface StageCharge {
  stageKey: string
  leg: number
  take: number
  /** Credits held up front: every generator the stage may run (+ base, once per run). */
  estimate: number
  includesBase: boolean
  holdId: number | null
  /** 'free' = nothing held (local mode, or a stage that costs nothing). */
  state: 'held' | 'free' | 'settled' | 'released'
  /** Credits actually charged, once the stage has finished. */
  actual: number | null
  finished: boolean
}

export interface RunRecord {
  id: string
  userId: string | null
  canvasId: string | null
  projectUuid: string | null
  projectName: string | null
  /** The canvas workflow exactly as it was when Run was pressed (Open workflow reopens it). */
  workflow: unknown
  createdAt: number
  updatedAt: number
  status: RunStatus
  takes: TakeRecord[]
  legs: LegRecord[]
  charges: StageCharge[]
  /** The flat per-render credit has been charged for this run. */
  baseCharged: boolean
  /** Stop was pressed while this run was going. */
  stopRequested: boolean
}

export function stageKeyOf(legId: string, take: number): string {
  return `${legId}.t${take}`
}

export function emptyNodeRecord(classType: string): NodeRecord {
  return {
    status: 'waiting', classType, leg: null, endpoint: null, payload: null, fingerprint: null,
    request: null, outputs: [], reused: false, credits: 0, startedAt: null, endedAt: null, error: null,
  }
}
```

- [ ] **Step 2: Write the failing store test**

`frontend/tests/unit/runner-store.unit.spec.ts`:
```ts
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { createFileRunStore, createPgRunStore, isRunId, runIdOf, userKeyOf, type RunStore } from '~~/server/runner/store'
import type { RunRecord } from '~~/server/runner/types'

const RUN_A = 'run_0b7c6a52-8e0e-4c4e-9c6f-1f2a3b4c5d6e'
const RUN_B = 'run_1b7c6a52-8e0e-4c4e-9c6f-1f2a3b4c5d6e'
const run = (id: string, over: Partial<RunRecord> = {}): RunRecord => ({
  id, userId: 'u1', canvasId: 'c1', projectUuid: null, projectName: null, workflow: { nodes: [] },
  createdAt: 1, updatedAt: 1, status: 'running', takes: [], legs: [], charges: [],
  baseCharged: false, stopRequested: false, ...over,
})

async function contract(store: RunStore) {
  await store.save(run(RUN_A))
  await store.save(run(RUN_B, { status: 'done', canvasId: 'c2' }))
  expect((await store.get(RUN_A))!.status).toBe('running')
  expect(await store.get('run_00000000-0000-0000-0000-000000000000')).toBeNull()
  await store.save(run(RUN_A, { status: 'paused' }))
  expect((await store.get(RUN_A))!.status).toBe('paused')
  expect((await store.listActive()).map(r => r.id)).toEqual([RUN_A])
  expect((await store.listForUser('u1', { canvasId: 'c2' })).map(r => r.id)).toEqual([RUN_B])
  expect((await store.listForUser('u1', { statuses: ['paused'] })).map(r => r.id)).toEqual([RUN_A])
  expect(await store.listForUser('u2')).toEqual([])
  expect(await store.getResult('u1', 'fp')).toBeNull()
  await store.putResult('u1', 'fp', [{ filename: 'a.png', subfolder: '', type: 'output' }])
  expect(await store.getResult('u1', 'fp')).toEqual([{ filename: 'a.png', subfolder: '', type: 'output' }])
  expect(await store.getResult('u2', 'fp')).toBeNull()
}

describe('file run store', () => {
  it('keeps the contract', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'runner-store-'))
    await contract(createFileRunStore(dir))
    // One JSON file per run, readable by a human.
    expect(JSON.parse(readFileSync(join(dir, `${RUN_A}.json`), 'utf8')).status).toBe('paused')
  })
  it('refuses a malformed run id instead of touching the disk', async () => {
    const store = createFileRunStore(mkdtempSync(join(tmpdir(), 'runner-store-')))
    await expect(store.save(run('../evil'))).rejects.toThrow()
    expect(await store.get('../evil')).toBeNull()
  })
})

describe('Postgres run store', () => {
  it('keeps the contract', async () => {
    const db = new PGlite()
    await db.exec(readFileSync(fileURLToPath(new URL('../../server/db/schema.sql', import.meta.url)), 'utf8'))
    await contract(createPgRunStore(db as any))
  })
})

describe('ids', () => {
  it('recognises run ids and finds the run behind a stage key', () => {
    expect(isRunId(RUN_A)).toBe(true)
    expect(isRunId('run_x')).toBe(false)
    expect(runIdOf(`${RUN_A}.2.t3`)).toBe(RUN_A)
    expect(runIdOf(`${RUN_A}.0`)).toBe(RUN_A)
    expect(runIdOf('4f1e-comfy-prompt')).toBeNull()
    expect(userKeyOf(null)).toBe('local')
    expect(userKeyOf('user_1')).toBe('user_1')
  })
})
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/runner-store.unit.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the store**

`frontend/server/runner/store.ts`:
```ts
/**
 * Where runs are written down: Postgres in hosted (runner_runs /
 * runner_results), one JSON file per run under .data/runs locally.
 */
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { storeDir } from '../utils/dataDir'
import { connectLedgerDb } from '../utils/ledgerDb'
import { isHosted } from '../utils/deployMode'
import type { OutputFile, RunRecord, RunStatus } from './types'

type DbLike = { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }

const RUN_ID_RE = /^run_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isRunId(v: unknown): v is string {
  return typeof v === 'string' && RUN_ID_RE.test(v)
}

/** `run_<uuid>.2.t3` → `run_<uuid>`; anything else (a ComfyUI prompt id) → null. */
export function runIdOf(promptId: string): string | null {
  const head = String(promptId).split('.')[0]!
  return isRunId(head) ? head : null
}

export function userKeyOf(userId: string | null): string {
  return userId ?? 'local'
}

export interface RunStore {
  save(run: RunRecord): Promise<void>
  get(runId: string): Promise<RunRecord | null>
  listActive(): Promise<RunRecord[]>
  listForUser(userId: string | null, opts?: { canvasId?: string | null; statuses?: RunStatus[] }): Promise<RunRecord[]>
  getResult(userKey: string, fingerprint: string): Promise<OutputFile[] | null>
  putResult(userKey: string, fingerprint: string, files: OutputFile[]): Promise<void>
}

const ACTIVE: RunStatus[] = ['running', 'paused']

function matches(r: RunRecord, userId: string | null, opts: { canvasId?: string | null; statuses?: RunStatus[] } = {}): boolean {
  if (r.userId !== userId) return false
  if (opts.canvasId !== undefined && r.canvasId !== opts.canvasId) return false
  if (opts.statuses && !opts.statuses.includes(r.status)) return false
  return true
}

export function createFileRunStore(dir: string): RunStore {
  const runPath = (id: string) => join(dir, `${id}.json`)
  const resultDir = (userKey: string) => join(dir, 'results', createHash('sha256').update(userKey).digest('hex').slice(0, 16))
  const fpOk = (fp: string) => /^[0-9a-f]{16,128}$/.test(fp)
  // Writes to one file are serialised so a slow write never lands after a newer one.
  const chains = new Map<string, Promise<void>>()

  async function writeAtomic(path: string, text: string) {
    const tmp = `${path}.${process.pid}.tmp`
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, path)
  }

  async function readAll(): Promise<RunRecord[]> {
    let names: string[] = []
    try { names = await readdir(dir) } catch { return [] }
    const out: RunRecord[] = []
    for (const n of names) {
      if (!n.endsWith('.json') || !isRunId(n.slice(0, -5))) continue
      try { out.push(JSON.parse(await readFile(join(dir, n), 'utf8'))) } catch { /* half-written or foreign file */ }
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  return {
    async save(run) {
      if (!isRunId(run.id)) throw new Error(`refusing to save a run with id ${JSON.stringify(run.id)}`)
      const text = JSON.stringify(run)
      const prev = chains.get(run.id) ?? Promise.resolve()
      const next = prev.catch(() => {}).then(async () => {
        await mkdir(dir, { recursive: true })
        await writeAtomic(runPath(run.id), text)
      })
      chains.set(run.id, next)
      await next
    },
    async get(runId) {
      if (!isRunId(runId)) return null
      try { return JSON.parse(await readFile(runPath(runId), 'utf8')) } catch { return null }
    },
    async listActive() {
      return (await readAll()).filter(r => ACTIVE.includes(r.status))
    },
    async listForUser(userId, opts) {
      return (await readAll()).filter(r => matches(r, userId, opts))
    },
    async getResult(userKey, fp) {
      if (!fpOk(fp)) return null
      try { return JSON.parse(await readFile(join(resultDir(userKey), `${fp}.json`), 'utf8')) } catch { return null }
    },
    async putResult(userKey, fp, files) {
      if (!fpOk(fp)) return
      const d = resultDir(userKey)
      await mkdir(d, { recursive: true })
      await writeAtomic(join(d, `${fp}.json`), JSON.stringify(files))
    },
  }
}

export function createPgRunStore(db: DbLike): RunStore {
  const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v)
  return {
    async save(run) {
      if (!isRunId(run.id)) throw new Error(`refusing to save a run with id ${JSON.stringify(run.id)}`)
      await db.query(
        `INSERT INTO runner_runs (run_id, user_id, canvas_id, status, doc, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, now())
         ON CONFLICT (run_id) DO UPDATE
           SET status = EXCLUDED.status, doc = EXCLUDED.doc, canvas_id = EXCLUDED.canvas_id, updated_at = now()`,
        [run.id, run.userId, run.canvasId, run.status, JSON.stringify(run)])
    },
    async get(runId) {
      if (!isRunId(runId)) return null
      const { rows } = await db.query(`SELECT doc FROM runner_runs WHERE run_id = $1`, [runId])
      return rows[0] ? parse(rows[0].doc) : null
    },
    async listActive() {
      const { rows } = await db.query(
        `SELECT doc FROM runner_runs WHERE status IN ('running', 'paused') ORDER BY (doc->>'createdAt')::bigint`)
      return rows.map(r => parse(r.doc))
    },
    async listForUser(userId, opts = {}) {
      const { rows } = await db.query(
        `SELECT doc FROM runner_runs WHERE user_id IS NOT DISTINCT FROM $1 ORDER BY (doc->>'createdAt')::bigint`, [userId])
      return rows.map(r => parse(r.doc) as RunRecord).filter(r => matches(r, userId, opts))
    },
    async getResult(userKey, fp) {
      const { rows } = await db.query(
        `SELECT files FROM runner_results WHERE user_id = $1 AND fingerprint = $2`, [userKey, fp])
      return rows[0] ? parse(rows[0].files) : null
    },
    async putResult(userKey, fp, files) {
      await db.query(
        `INSERT INTO runner_results (user_id, fingerprint, files) VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (user_id, fingerprint) DO UPDATE SET files = EXCLUDED.files`,
        [userKey, fp, JSON.stringify(files)])
    },
  }
}

let override: RunStore | null = null
let shared: RunStore | null = null

export function __setRunStoreForTests(s: RunStore | null): void { override = s }

export function getRunStore(): RunStore {
  if (override) return override
  if (!shared) {
    if (isHosted()) {
      const url = process.env.DATABASE_URL
      if (!url) throw new Error('runner: DATABASE_URL not set — hosted mode requires it')
      shared = createPgRunStore(connectLedgerDb(url))
    }
    else {
      shared = createFileRunStore(join(storeDir('data'), 'runs'))
    }
  }
  return shared
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/runner-store.unit.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit** (controller)

Paths: `frontend/server/runner/types.ts frontend/server/runner/store.ts frontend/tests/unit/runner-store.unit.spec.ts`
Message: `feat(runner): run records and their storage (Postgres hosted, files local)`

---

### Task 7: Files — the saving doorway, handing files to fal, and whose files they are

**Files:**
- Create: `frontend/server/runner/results.ts`
- Create: `frontend/server/runner/handoff.ts`
- Create: `frontend/server/runner/inputs.ts`
- Test: `frontend/tests/unit/runner-files.unit.spec.ts`

**Interfaces:**
- Consumes: `OutputFile` (Task 6); `ApiPrompt`, `isLink` (Task 2); `shortUserHash` (`server/utils/meterGraphRun.ts`); `engineDirForType` (`server/utils/inputUploads.ts`); `MeterRefusalError` (`server/utils/requestMeter.ts`).
- Produces (results.ts): `interface ResultStore { save(bytes: Uint8Array, o: { userId: string | null; prefix: string; ext: string }): Promise<OutputFile>; read(file: OutputFile): Promise<Uint8Array>; exists(file: OutputFile): Promise<boolean> }`; `createEngineResultStore(o: { dirForType(type: string): string | null; hosted(): boolean }): ResultStore`; `nextCounter(names: string[], prefix: string): number`; `extFor(contentType: string | null, url: string, fallback: string): string`; `userSubfolder(userId: string | null, hosted: boolean): string`.
- Produces (handoff.ts): `interface Handoff { toUrl(file: OutputFile): Promise<string>; hashOf(url: string): string | undefined }`; `createHandoff(d: { read(file: OutputFile): Promise<Uint8Array>; upload(bytes: Uint8Array, name: string, mime: string): Promise<string> }): Handoff`; `sha256Hex(bytes: Uint8Array): string`; `mimeFor(filename: string): string`.
- Produces (inputs.ts): `MOODBOARD_MAX_REFS = 3`; `parseStyleRefs(raw: unknown): { folder: string; files: string[] } | null`; `moodboardFiles(raw: unknown): OutputFile[]`; `parseInputFileRef(raw: unknown): OutputFile | null`; `collectInputFiles(prompt: ApiPrompt): OutputFile[]`; `interface OwnershipCheck { ownsInput(userId: string, file: OutputFile): Promise<boolean>; ownsOutput(userId: string, file: OutputFile): Promise<boolean> }`; `assertFilesOwned(files: OutputFile[], userId: string | null, hosted: boolean, check: OwnershipCheck): Promise<void>`.

- [ ] **Step 1: Write the failing test**

`frontend/tests/unit/runner-files.unit.spec.ts`:
```ts
import { mkdirSync, mkdtempSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createEngineResultStore, nextCounter, extFor, userSubfolder } from '~~/server/runner/results'
import { createHandoff, sha256Hex, mimeFor } from '~~/server/runner/handoff'
import {
  parseStyleRefs, moodboardFiles, parseInputFileRef, collectInputFiles, assertFilesOwned,
} from '~~/server/runner/inputs'
import { shortUserHash } from '~~/server/utils/meterGraphRun'

function engineRoot() {
  const root = mkdtempSync(join(tmpdir(), 'runner-engine-'))
  for (const t of ['input', 'output', 'temp']) mkdirSync(join(root, t))
  return { root, dirForType: (t: string) => join(root, t) }
}

describe('result doorway', () => {
  it('numbers files the way ComfyUI does and never overwrites', async () => {
    const { root, dirForType } = engineRoot()
    writeFileSync(join(root, 'output', 'generate_image_00007_.png'), 'x')
    const store = createEngineResultStore({ dirForType, hosted: () => false })
    const a = await store.save(new Uint8Array([1]), { userId: null, prefix: 'generate_image', ext: 'png' })
    const b = await store.save(new Uint8Array([2]), { userId: null, prefix: 'generate_image', ext: 'png' })
    expect(a).toEqual({ filename: 'generate_image_00008_.png', subfolder: '', type: 'output' })
    expect(b.filename).toBe('generate_image_00009_.png')
    expect([...await store.read(a)]).toEqual([1])
    expect(await store.exists(b)).toBe(true)
    expect(await store.exists({ filename: 'nope.png', subfolder: '', type: 'output' })).toBe(false)
  })
  it('puts hosted results in the per-user folder', async () => {
    const { root, dirForType } = engineRoot()
    const store = createEngineResultStore({ dirForType, hosted: () => true })
    const f = await store.save(new Uint8Array([1]), { userId: 'user_1', prefix: 'generate_video', ext: 'mp4' })
    expect(f.subfolder).toBe(`u_${shortUserHash('user_1')}`)
    expect(readdirSync(join(root, 'output', f.subfolder))).toEqual(['generate_video_00001_.mp4'])
  })
  it('refuses to read outside the engine folders', async () => {
    const { dirForType } = engineRoot()
    const store = createEngineResultStore({ dirForType, hosted: () => false })
    await expect(store.read({ filename: '../../etc/passwd', subfolder: '', type: 'input' })).rejects.toThrow()
    await expect(store.read({ filename: 'a.png', subfolder: '../..', type: 'input' })).rejects.toThrow()
  })
  it('helpers', () => {
    expect(nextCounter(['generate_image_00002_.png', 'generate_image_00010_.jpg', 'other_00050_.png'], 'generate_image')).toBe(11)
    expect(nextCounter([], 'generate_image')).toBe(1)
    expect(extFor('image/jpeg', 'https://x/y', 'png')).toBe('jpg')
    expect(extFor(null, 'https://x/y.webp?sig=1', 'png')).toBe('webp')
    expect(extFor('application/octet-stream', 'https://x/y', 'mp4')).toBe('mp4')
    expect(userSubfolder('user_1', false)).toBe('')
  })
})

describe('handoff', () => {
  it('uploads a file once and remembers what it contained', async () => {
    const upload = vi.fn(async () => 'https://fal.media/abc.png')
    const h = createHandoff({ read: async () => new Uint8Array([9, 9]), upload })
    const f = { filename: 'a.png', subfolder: '', type: 'output' as const }
    expect(await h.toUrl(f)).toBe('https://fal.media/abc.png')
    expect(await h.toUrl(f)).toBe('https://fal.media/abc.png')
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload).toHaveBeenCalledWith(new Uint8Array([9, 9]), 'a.png', 'image/png')
    expect(h.hashOf('https://fal.media/abc.png')).toBe(sha256Hex(new Uint8Array([9, 9])))
    expect(h.hashOf('https://elsewhere')).toBeUndefined()
    expect(mimeFor('clip.MP4')).toBe('video/mp4')
    expect(mimeFor('x.jpeg')).toBe('image/jpeg')
  })
})

describe('inputs', () => {
  it('parseStyleRefs keeps Python’s guards', () => {
    expect(parseStyleRefs('')).toBeNull()
    expect(parseStyleRefs('{bad')).toBeNull()
    expect(parseStyleRefs(JSON.stringify({ folder: 'boards', files: ['a.png'] }))).toBeNull()
    expect(parseStyleRefs(JSON.stringify({ folder: 'moodboard_12', files: ['../x.png', 'a.gif'] }))).toBeNull()
    expect(parseStyleRefs(JSON.stringify({ folder: 'moodboard_12', files: ['a.png', 'b.JPG', 'c.webp', 'd.jpeg'] })))
      .toEqual({ folder: 'moodboard_12', files: ['a.png', 'b.JPG', 'c.webp'] })
    expect(moodboardFiles(JSON.stringify({ folder: 'moodboard_1', files: ['a.png'] })))
      .toEqual([{ filename: 'a.png', subfolder: 'moodboard_1', type: 'input' }])
  })
  it('parseInputFileRef reads plain, nested and annotated names', () => {
    expect(parseInputFileRef('a.png')).toEqual({ filename: 'a.png', subfolder: '', type: 'input' })
    expect(parseInputFileRef('sub/a.png')).toEqual({ filename: 'a.png', subfolder: 'sub', type: 'input' })
    expect(parseInputFileRef('u_abc/x.png [output]')).toEqual({ filename: 'x.png', subfolder: 'u_abc', type: 'output' })
    expect(parseInputFileRef('')).toBeNull()
    expect(parseInputFileRef('../x.png')).toBeNull()
  })
  it('collectInputFiles finds moodboard pictures and loaded files, not wired cards', () => {
    const files = collectInputFiles({
      '1': { class_type: 'GenerateImageNode', inputs: { model: 'nano-banana-2', style_refs: JSON.stringify({ folder: 'moodboard_3', files: ['m.png'] }) } },
      '2': { class_type: 'Image', inputs: { image: 'first.png' } },
      '3': { class_type: 'Image', inputs: { image: 'ignored.png', images: ['1', 0] } },
      '4': { class_type: 'Video', inputs: { file: 'clip.mp4' } },
    })
    expect(files).toEqual([
      { filename: 'm.png', subfolder: 'moodboard_3', type: 'input' },
      { filename: 'first.png', subfolder: '', type: 'input' },
      { filename: 'clip.mp4', subfolder: '', type: 'input' },
    ])
  })
  it('assertFilesOwned refuses someone else’s picture in hosted, not locally', async () => {
    const check = { ownsInput: vi.fn(async (_u: string, f: any) => f.filename !== 'theirs.png'), ownsOutput: vi.fn(async () => false) }
    const mine = { filename: 'mine.png', subfolder: '', type: 'input' as const }
    const theirs = { filename: 'theirs.png', subfolder: '', type: 'input' as const }
    await expect(assertFilesOwned([mine], 'u1', true, check)).resolves.toBeUndefined()
    await expect(assertFilesOwned([mine, theirs], 'u1', true, check)).rejects.toMatchObject({ statusCode: 403 })
    await expect(assertFilesOwned([theirs], null, false, check)).resolves.toBeUndefined()
    await expect(assertFilesOwned([{ filename: 'x.png', subfolder: '', type: 'output' }], 'u1', true, check)).rejects.toMatchObject({ statusCode: 403 })
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/runner-files.unit.spec.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`frontend/server/runner/results.ts`:
```ts
/**
 * The one doorway for saving and reading run files. Today it writes into
 * ComfyUI's output folder with ComfyUI's naming (`generate_image_00001_.png`),
 * so Assets, result cards and /view work unchanged. Moving to cloud storage
 * later means a second implementation of ResultStore plus a /view change —
 * nothing else in the runner reads or writes files directly.
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { shortUserHash } from '../utils/meterGraphRun'
import type { OutputFile } from './types'

export interface ResultStore {
  save(bytes: Uint8Array, o: { userId: string | null; prefix: string; ext: string }): Promise<OutputFile>
  read(file: OutputFile): Promise<Uint8Array>
  exists(file: OutputFile): Promise<boolean>
}

export function userSubfolder(userId: string | null, hosted: boolean): string {
  return hosted && userId ? `u_${shortUserHash(userId)}` : ''
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** folder_paths.get_save_image_path's counter: highest `<prefix>_<digits>_` + 1. */
export function nextCounter(names: string[], prefix: string): number {
  const re = new RegExp(`^${escapeRe(prefix)}_(\\d+)_`)
  let max = 0
  for (const n of names) {
    const m = re.exec(n)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max + 1
}

const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
}

export function extFor(contentType: string | null, url: string, fallback: string): string {
  const ct = (contentType ?? '').split(';')[0]!.trim().toLowerCase()
  if (EXT_BY_TYPE[ct]) return EXT_BY_TYPE[ct]!
  const m = /\.([a-z0-9]{2,4})(?:[?#]|$)/i.exec(url)
  if (m) {
    const e = m[1]!.toLowerCase()
    return e === 'jpeg' ? 'jpg' : e
  }
  return fallback
}

export function createEngineResultStore(o: { dirForType(type: string): string | null; hosted(): boolean }): ResultStore {
  function pathOf(file: OutputFile): string {
    const base = o.dirForType(file.type)
    if (!base) throw new Error('The file store is not available')
    const root = resolve(base)
    const p = resolve(root, file.subfolder || '', file.filename)
    if (!p.startsWith(root + sep)) throw new Error('File path is outside the store')
    return p
  }
  return {
    async save(bytes, { userId, prefix, ext }) {
      const base = o.dirForType('output')
      if (!base) throw new Error('The file store is not available')
      const subfolder = userSubfolder(userId, o.hosted())
      const dir = join(base, subfolder)
      await mkdir(dir, { recursive: true })
      let counter = nextCounter(await readdir(dir).catch(() => []), prefix)
      for (let tries = 0; tries < 1000; tries++, counter++) {
        const filename = `${prefix}_${String(counter).padStart(5, '0')}_.${ext}`
        try {
          await writeFile(join(dir, filename), bytes, { flag: 'wx' })
          return { filename, subfolder, type: 'output' }
        }
        catch (e: any) {
          if (e?.code !== 'EEXIST') throw e
        }
      }
      throw new Error('Could not find a free file name')
    },
    async read(file) {
      return new Uint8Array(await readFile(pathOf(file)))
    },
    async exists(file) {
      try { return (await stat(pathOf(file))).isFile() } catch { return false }
    },
  }
}
```

`frontend/server/runner/handoff.ts`:
```ts
/**
 * Hands one of our saved files to the next model: uploads it to fal storage
 * once and reuses the link. Never base64 in the request, and never fal's own
 * result link (it can expire while a Gate waits). Also remembers what each
 * link contained, so a request's fingerprint depends on the picture, not on
 * which upload link it happened to get.
 */
import { createHash } from 'node:crypto'
import type { OutputFile } from './types'

export interface Handoff {
  toUrl(file: OutputFile): Promise<string>
  hashOf(url: string): string | undefined
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
}

export function mimeFor(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase()
  return MIME[ext] ?? 'application/octet-stream'
}

export function createHandoff(d: {
  read(file: OutputFile): Promise<Uint8Array>
  upload(bytes: Uint8Array, name: string, mime: string): Promise<string>
}): Handoff {
  const byFile = new Map<string, Promise<string>>()
  const hashByUrl = new Map<string, string>()
  return {
    toUrl(file) {
      const key = `${file.type}:${file.subfolder}:${file.filename}`
      let p = byFile.get(key)
      if (!p) {
        p = (async () => {
          const bytes = await d.read(file)
          const url = await d.upload(bytes, file.filename, mimeFor(file.filename))
          hashByUrl.set(url, sha256Hex(bytes))
          return url
        })()
        byFile.set(key, p)
        p.catch(() => byFile.delete(key))
      }
      return p
    },
    hashOf(url) {
      return hashByUrl.get(url)
    },
  }
}
```

`frontend/server/runner/inputs.ts`:
```ts
/**
 * Files a workflow reads before it makes anything: moodboard reference
 * pictures (GenerateImageNode.style_refs) and pictures/clips loaded into an
 * unwired Image or Video card. In hosted, every one must be the user's own.
 */
import { isLink, type ApiPrompt } from '#shared/runner/graph'
import { MeterRefusalError } from '../utils/requestMeter'
import type { OutputFile } from './types'

export const MOODBOARD_MAX_REFS = 3
const MOODBOARD_FOLDER_RE = /^moodboard_\d+$/
const MOODBOARD_IMAGE_EXT_RE = /\.(png|jpe?g|webp)$/i

function safeMoodboardFile(name: unknown): name is string {
  if (typeof name !== 'string' || !name) return false
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return false
  return MOODBOARD_IMAGE_EXT_RE.test(name)
}

/** Port of nodes_replicate._parse_style_refs — never throws, bad input → null. */
export function parseStyleRefs(raw: unknown): { folder: string; files: string[] } | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  let payload: unknown
  try { payload = JSON.parse(raw) } catch { return null }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const { folder, files } = payload as { folder?: unknown; files?: unknown }
  if (typeof folder !== 'string' || !MOODBOARD_FOLDER_RE.test(folder)) return null
  if (!Array.isArray(files)) return null
  const good = files.filter(safeMoodboardFile).slice(0, MOODBOARD_MAX_REFS)
  return good.length ? { folder, files: good } : null
}

export function moodboardFiles(raw: unknown): OutputFile[] {
  const parsed = parseStyleRefs(raw)
  return parsed ? parsed.files.map(f => ({ filename: f, subfolder: parsed.folder, type: 'input' as const })) : []
}

/** 'a.png' | 'sub/a.png' | 'sub/a.png [output]' → a file; anything unsafe → null. */
export function parseInputFileRef(raw: unknown): OutputFile | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  let name = raw.trim()
  let type: OutputFile['type'] = 'input'
  const m = /^(.*?)\s*\[(input|output|temp)\]$/.exec(name)
  if (m) { name = m[1]!; type = m[2] as OutputFile['type'] }
  name = name.replace(/\\/g, '/')
  const parts = name.split('/')
  if (parts.some(p => !p || p === '.' || p === '..')) return null
  const filename = parts.pop()!
  return { filename, subfolder: parts.join('/'), type }
}

export function collectInputFiles(prompt: ApiPrompt): OutputFile[] {
  const out: OutputFile[] = []
  for (const node of Object.values(prompt)) {
    const inputs = node.inputs ?? {}
    if (node.class_type === 'GenerateImageNode') out.push(...moodboardFiles(inputs.style_refs))
    if (node.class_type === 'Image' && !isLink(inputs.images)) {
      const f = parseInputFileRef(inputs.image)
      if (f) out.push(f)
    }
    if (node.class_type === 'Video' && !isLink(inputs.source)) {
      const f = parseInputFileRef(inputs.file)
      if (f) out.push(f)
    }
  }
  return out
}

export interface OwnershipCheck {
  ownsInput(userId: string, file: OutputFile): Promise<boolean>
  ownsOutput(userId: string, file: OutputFile): Promise<boolean>
}

export async function assertFilesOwned(
  files: OutputFile[],
  userId: string | null,
  hosted: boolean,
  check: OwnershipCheck,
): Promise<void> {
  if (!hosted) return
  if (!userId) throw new MeterRefusalError('Sign in to run workflows', 401)
  for (const f of files) {
    const ok = f.type === 'output' ? await check.ownsOutput(userId, f)
      : f.type === 'input' ? await check.ownsInput(userId, f)
        : false
    if (!ok) throw new MeterRefusalError('This workflow uses a picture that isn’t in your files', 403, { file: f.filename })
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/runner-files.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (controller)

Paths: `frontend/server/runner/results.ts frontend/server/runner/handoff.ts frontend/server/runner/inputs.ts frontend/tests/unit/runner-files.unit.spec.ts`
Message: `feat(runner): file doorway, hand-off to fal, and file ownership checks`

---

### Task 8: Fingerprints — never pay twice

**Files:**
- Create: `frontend/server/runner/fingerprint.ts`
- Test: `frontend/tests/unit/runner-fingerprint.unit.spec.ts`

**Interfaces:**
- Produces: `canonicalJson(v: unknown): string`; `requestFingerprint(endpoint: string, payload: Record<string, unknown>, hashOf: (url: string) => string | undefined): string` (64 hex chars); `isReusable(payload: Record<string, unknown>): boolean`.

- [ ] **Step 1: Write the failing test**

`frontend/tests/unit/runner-fingerprint.unit.spec.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { canonicalJson, requestFingerprint, isReusable } from '~~/server/runner/fingerprint'

const none = () => undefined

describe('fingerprint', () => {
  it('ignores key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 0 }] } })).toBe('{"a":{"c":[3,{"e":0,"f":1}],"d":2},"b":1}')
    expect(requestFingerprint('m', { a: 1, b: 2 }, none)).toBe(requestFingerprint('m', { b: 2, a: 1 }, none))
  })
  it('changes with the endpoint or any setting', () => {
    const base = requestFingerprint('fal-ai/flux/schnell', { prompt: 'x', seed: 5 }, none)
    expect(requestFingerprint('fal-ai/flux-pro/v1.1', { prompt: 'x', seed: 5 }, none)).not.toBe(base)
    expect(requestFingerprint('fal-ai/flux/schnell', { prompt: 'x', seed: 6 }, none)).not.toBe(base)
    expect(requestFingerprint('fal-ai/flux/schnell', { prompt: 'x', seed: 5, num_images: 1 }, none)).not.toBe(base)
    expect(base).toMatch(/^[0-9a-f]{64}$/)
  })
  it('depends on what an input picture contains, not on its upload link', () => {
    const hashes: Record<string, string> = { 'https://fal/one': 'h1', 'https://fal/two': 'h1', 'https://fal/three': 'h2' }
    const hashOf = (u: string) => hashes[u]
    const a = requestFingerprint('v', { image_url: 'https://fal/one', image_urls: ['https://fal/one'] }, hashOf)
    const b = requestFingerprint('v', { image_url: 'https://fal/two', image_urls: ['https://fal/two'] }, hashOf)
    const c = requestFingerprint('v', { image_url: 'https://fal/three', image_urls: ['https://fal/one'] }, hashOf)
    expect(a).toBe(b)
    expect(c).not.toBe(a)
  })
  it('reuses only requests with an explicit seed', () => {
    expect(isReusable({ prompt: 'x', seed: 12 })).toBe(true)
    expect(isReusable({ prompt: 'x' })).toBe(false)          // seed 0 → the builder left it out
    expect(isReusable({ prompt: 'x', seed: 0 })).toBe(false)
    expect(isReusable({ prompt: 'x', seed: '12' })).toBe(false)
    expect(isReusable({ prompt: 'x', seed: 1.5 })).toBe(false)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/runner-fingerprint.unit.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`frontend/server/runner/fingerprint.ts`:
```ts
/**
 * A request's fingerprint is built from the FULL body that would be sent to
 * fal (never a hand-picked list of settings), with input-file links replaced
 * by what the files contain. Two requests with the same fingerprint would get
 * the same answer — if, and only if, the seed is fixed.
 */
import { createHash } from 'node:crypto'

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (v && typeof v === 'object') {
    const keys = Object.keys(v as object).filter(k => (v as any)[k] !== undefined).sort()
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson((v as any)[k])}`).join(',')}}`
  }
  return JSON.stringify(v ?? null)
}

function replaceLinks(v: unknown, hashOf: (url: string) => string | undefined): unknown {
  if (typeof v === 'string') {
    const h = hashOf(v)
    return h ? `sha256:${h}` : v
  }
  if (Array.isArray(v)) return v.map(x => replaceLinks(x, hashOf))
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, replaceLinks(x, hashOf)]))
  }
  return v
}

export function requestFingerprint(
  endpoint: string,
  payload: Record<string, unknown>,
  hashOf: (url: string) => string | undefined,
): string {
  const body = canonicalJson({ endpoint, payload: replaceLinks(payload, hashOf) })
  return createHash('sha256').update(body).digest('hex')
}

/** Seed 0 means "surprise me": the builders leave `seed` out, and asking again should give something new. */
export function isReusable(payload: Record<string, unknown>): boolean {
  const s = payload.seed
  return typeof s === 'number' && Number.isInteger(s) && s > 0
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/runner-fingerprint.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (controller)

Paths: `frontend/server/runner/fingerprint.ts frontend/tests/unit/runner-fingerprint.unit.spec.ts`
Message: `feat(runner): request fingerprints and the reuse rule`

---

### Task 9: Money — price a stage, hold, charge, drop

**Files:**
- Create: `frontend/server/runner/metering.ts`
- Test: `frontend/tests/unit/runner-metering.unit.spec.ts`

**Interfaces:**
- Consumes: `priceGraph`, `BASE_RENDER_CREDITS`, `OUTPUT_CLASS_TYPES`, `UnpricedGraphError` (`server/utils/priceBook.ts`); `extractGraphPromptText` (`server/utils/graphPromptText.ts`); `MeterRefusalError`; `outputKey` (`server/utils/graphRuns.ts`); `ApiPrompt`, `ApiNode`; `OutputFile`, `StageCharge`.
- Produces: `nodeCredits(node: ApiNode): number`; `stageEstimate(prompt: ApiPrompt, nodeIds: Iterable<string>, includeBase: boolean): number`; `hasOutputNode(prompt: ApiPrompt): boolean`; `interface LedgerPort { hold(userId: string, credits: number, key: string): Promise<{ ok: true; holdId: number } | { ok: false; reason: 'insufficient' }>; settle(holdId: number, actual: number, reason: string): Promise<{ settled: boolean }>; release(holdId: number): Promise<void>; getAvailable(userId: string): Promise<number> }`; `interface GraphRunsPort { create(r: { promptId: string; userId: string; credits: number; holdId: number | null; target: string }): Promise<void>; appendOutput(promptId: string, key: string): Promise<void>; resolve(promptId: string, state: 'settled' | 'voided'): Promise<void> }`; `interface Metering { spendGuard(userId: string | null): Promise<void>; moderate(prompts: ApiPrompt[]): Promise<void>; hold(userId: string | null, stageKey: string, credits: number): Promise<number | null>; addOutput(userId: string | null, stageKey: string, file: OutputFile): Promise<void>; finish(userId: string | null, charge: StageCharge, actual: number): Promise<void> }`; `createMetering(d: { hosted(): boolean; ledger(): LedgerPort; graphRuns: GraphRunsPort; spendGuard(userId: string): Promise<void>; moderate(text: string): Promise<{ ok: true } | { ok: false; categories: string[] }> }): Metering`.

- [ ] **Step 1: Write the failing test**

`frontend/tests/unit/runner-metering.unit.spec.ts`:
```ts
import { describe, expect, it, vi } from 'vitest'
import { nodeCredits, stageEstimate, hasOutputNode, createMetering, type LedgerPort } from '~~/server/runner/metering'
import type { StageCharge } from '~~/server/runner/types'

const img = (model: string) => ({ class_type: 'GenerateImageNode', inputs: { model } })
const vid = (model: string) => ({ class_type: 'GenerateVideoNode', inputs: { model } })

describe('prices', () => {
  it('prices generators from the existing price table and nothing else', () => {
    expect(nodeCredits(img('flux-schnell'))).toBe(1)
    expect(nodeCredits(img('nano-banana-2'))).toBe(14)
    expect(nodeCredits(img('seedream-5-lite'))).toBe(8)
    expect(nodeCredits(vid('hailuo-h3'))).toBe(45)
    expect(nodeCredits(vid('Veo 3'))).toBe(480)
    expect(nodeCredits({ class_type: 'Image', inputs: {} })).toBe(0)
    expect(nodeCredits({ class_type: 'ComfyGateNode', inputs: {} })).toBe(0)
    expect(() => nodeCredits(img('krea-2-large'))).toThrow(/no listed price/)
  })
  it('adds the flat render credit only when asked', () => {
    const p = { '1': img('flux-schnell'), '2': { class_type: 'ComfyGateNode', inputs: {} }, '3': vid('hailuo-h3'), '4': { class_type: 'Video', inputs: {} } }
    expect(stageEstimate(p, ['1', '2'], true)).toBe(2)
    expect(stageEstimate(p, ['3', '4'], false)).toBe(45)
    expect(hasOutputNode(p)).toBe(true)
    expect(hasOutputNode({ '1': img('flux-schnell') })).toBe(false)
  })
})

function fakes(available = 100) {
  let seq = 0
  const ledger: LedgerPort = {
    hold: vi.fn(async (_u, credits) => (credits > available ? { ok: false as const, reason: 'insufficient' as const } : { ok: true as const, holdId: ++seq })),
    settle: vi.fn(async () => ({ settled: true })),
    release: vi.fn(async () => {}),
    getAvailable: vi.fn(async () => available),
  }
  const graphRuns = { create: vi.fn(async () => {}), appendOutput: vi.fn(async () => {}), resolve: vi.fn(async () => {}) }
  return { ledger, graphRuns }
}
const charge = (over: Partial<StageCharge> = {}): StageCharge => ({
  stageKey: 'run_x.0.t0', leg: 0, take: 0, estimate: 15, includesBase: true, holdId: 7, state: 'held', actual: null, finished: false, ...over,
})

describe('hosted metering', () => {
  it('holds with a key that survives retries and writes the ownership row', async () => {
    const { ledger, graphRuns } = fakes()
    const m = createMetering({ hosted: () => true, ledger: () => ledger, graphRuns, spendGuard: async () => {}, moderate: async () => ({ ok: true }) })
    expect(await m.hold('u1', 'run_x.0.t0', 15)).toBe(1)
    expect(ledger.hold).toHaveBeenCalledWith('u1', 15, 'runner:run_x.0.t0')
    expect(graphRuns.create).toHaveBeenCalledWith({ promptId: 'run_x.0.t0', userId: 'u1', credits: 15, holdId: 1, target: 'runner' })
  })
  it('refuses with the numbers when credits run short', async () => {
    const { ledger, graphRuns } = fakes(10)
    const m = createMetering({ hosted: () => true, ledger: () => ledger, graphRuns, spendGuard: async () => {}, moderate: async () => ({ ok: true }) })
    await expect(m.hold('u1', 'k', 15)).rejects.toMatchObject({ statusCode: 402, data: { required: 15, available: 10 } })
  })
  it('a stage that costs nothing still records ownership but holds nothing', async () => {
    const { ledger, graphRuns } = fakes()
    const m = createMetering({ hosted: () => true, ledger: () => ledger, graphRuns, spendGuard: async () => {}, moderate: async () => ({ ok: true }) })
    expect(await m.hold('u1', 'k', 0)).toBeNull()
    expect(ledger.hold).not.toHaveBeenCalled()
    expect(graphRuns.create).toHaveBeenCalledWith({ promptId: 'k', userId: 'u1', credits: 0, holdId: null, target: 'runner' })
  })
  it('charges the exact amount, or drops the hold when nothing was made', async () => {
    const { ledger, graphRuns } = fakes()
    const m = createMetering({ hosted: () => true, ledger: () => ledger, graphRuns, spendGuard: async () => {}, moderate: async () => ({ ok: true }) })
    const c = charge()
    await m.finish('u1', c, 9)
    expect(ledger.settle).toHaveBeenCalledWith(7, 9, 'runner:run_x.0.t0')
    expect(c).toMatchObject({ state: 'settled', actual: 9, finished: true })
    expect(graphRuns.resolve).toHaveBeenCalledWith('run_x.0.t0', 'settled')
    const d = charge({ stageKey: 'run_x.0.t1' })
    await m.finish('u1', d, 0)
    expect(ledger.release).toHaveBeenCalledWith(7)
    expect(d).toMatchObject({ state: 'released', actual: 0, finished: true })
    expect(graphRuns.resolve).toHaveBeenCalledWith('run_x.0.t1', 'voided')
  })
  it('records each saved file against the stage so /view lets its owner see it', async () => {
    const { ledger, graphRuns } = fakes()
    const m = createMetering({ hosted: () => true, ledger: () => ledger, graphRuns, spendGuard: async () => {}, moderate: async () => ({ ok: true }) })
    await m.addOutput('u1', 'k', { filename: 'generate_image_00001_.png', subfolder: 'u_abc', type: 'output' })
    expect(graphRuns.appendOutput).toHaveBeenCalledWith('k', 'output:u_abc:generate_image_00001_.png')
  })
  it('runs the spending check and the content check', async () => {
    const { ledger, graphRuns } = fakes()
    const spendGuard = vi.fn(async () => {})
    const moderate = vi.fn(async () => ({ ok: false as const, categories: ['violence'] }))
    const m = createMetering({ hosted: () => true, ledger: () => ledger, graphRuns, spendGuard, moderate })
    await m.spendGuard('u1')
    expect(spendGuard).toHaveBeenCalledWith('u1')
    await expect(m.moderate([{ '1': { class_type: 'GenerateImageNode', inputs: { prompt: 'bad' } } }]))
      .rejects.toMatchObject({ statusCode: 400, data: { categories: ['violence'] } })
    expect(moderate).toHaveBeenCalledWith('bad')
  })
})

describe('local metering', () => {
  it('moves no money and writes no rows', async () => {
    const { ledger, graphRuns } = fakes()
    const m = createMetering({ hosted: () => false, ledger: () => ledger, graphRuns, spendGuard: async () => { throw new Error('no') }, moderate: async () => ({ ok: false, categories: [] }) })
    await m.spendGuard(null)
    await m.moderate([{}])
    expect(await m.hold(null, 'k', 15)).toBeNull()
    const c = charge({ holdId: null, state: 'free' })
    await m.finish(null, c, 9)
    expect(c).toMatchObject({ state: 'free', actual: null, finished: true })
    expect(ledger.hold).not.toHaveBeenCalled()
    expect(graphRuns.create).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/runner-metering.unit.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`frontend/server/runner/metering.ts`:
```ts
/**
 * Per-stage money for the runner (hosted only). Order before a stage runs is
 * the same as meterGraphSubmit's: spending pause → your files → content check
 * → price → hold. The hold is an upper bound (every generator the stage may
 * run); the charge is exactly what was made. Nothing is held while paused.
 *
 * Prices come from the one price table priceGraph already reads
 * (app/data/image-models.ts, app/data/video-prices.ts) — the runner cannot
 * run a model without a price because priceGraph throws for one.
 */
import type { ApiNode, ApiPrompt } from '#shared/runner/graph'
import { BASE_RENDER_CREDITS, OUTPUT_CLASS_TYPES, priceGraph } from '../utils/priceBook'
import { extractGraphPromptText } from '../utils/graphPromptText'
import { MeterRefusalError } from '../utils/requestMeter'
import { outputKey } from '../utils/graphRuns'
import type { OutputFile, StageCharge } from './types'

const PRICED = new Set(['GenerateImageNode', 'GenerateVideoNode'])

export function nodeCredits(node: ApiNode): number {
  if (!PRICED.has(node.class_type)) return 0
  const p = priceGraph({ n: { class_type: node.class_type, inputs: node.inputs } })
  return p.breakdown.filter(b => b.action !== 'base_render').reduce((s, b) => s + b.credits, 0)
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
      const text = [...new Set(prompts.map(p => extractGraphPromptText(p)).filter(Boolean))].join(' ')
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
      await d.graphRuns.appendOutput(stageKey, outputKey(file))
    },
    async finish(userId, charge, actual) {
      charge.finished = true
      if (!d.hosted() || !userId) {
        charge.state = charge.holdId == null ? 'free' : charge.state
        return
      }
      if (actual > 0 && charge.holdId != null) {
        const s = await d.ledger().settle(charge.holdId, actual, `runner:${charge.stageKey}`)
        if (!s.settled) console.error('[runner] SETTLE ON RELEASED HOLD — stage shipped uncharged', { stageKey: charge.stageKey, actual })
        charge.state = 'settled'
        charge.actual = actual
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
```

The `graphRuns.resolve` port is wired (Task 14) to a small new function, because the existing `resolveGraphRun(promptId, state, outputs)` overwrites `outputs` — the runner has already appended them one by one. Add to `frontend/server/utils/graphRuns.ts` in this task:
```ts
/** Mark a row finished without touching its outputs (the runner appends them as files are saved). */
export async function setGraphRunState(promptId: string, state: 'settled' | 'voided'): Promise<void> {
  await db().query(`UPDATE graph_runs SET state = $1 WHERE prompt_id = $2`, [state, promptId])
}
```
and a case to `frontend/tests/unit/graph-runs.unit.spec.ts`:
```ts
  it('setGraphRunState leaves outputs alone', async () => {
    query.mockResolvedValueOnce({ rows: [] })
    await setGraphRunState('run_x.0.t0', 'settled')
    expect(query.mock.calls[0][0]).toMatch(/^UPDATE graph_runs SET state = \$1 WHERE prompt_id = \$2$/)
    expect(query.mock.calls[0][1]).toEqual(['settled', 'run_x.0.t0'])
  })
```
(add `setGraphRunState` to that file's import).

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/runner-metering.unit.spec.ts tests/unit/graph-runs.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (controller)

Paths: `frontend/server/runner/metering.ts frontend/server/utils/graphRuns.ts frontend/tests/unit/runner-metering.unit.spec.ts frontend/tests/unit/graph-runs.unit.spec.ts`
Message: `feat(runner): per-stage pricing, holds and exact charges`

---

### Task 10: Events — ComfyUI-shaped messages, per user

**Files:**
- Create: `frontend/shared/runner/messages.ts`
- Create: `frontend/server/runner/events.ts`
- Test: `frontend/tests/unit/runner-events.unit.spec.ts`

**Interfaces:**
- Produces (shared/runner/messages.ts, used by both sides): `interface GateChoice { take: number; files: { filename: string; subfolder: string; type: string }[] }`; `interface RunnerMessage { type: string; data: Record<string, unknown> }`; `RUNNER_WORKER = -1`; `isRunnerPromptId(id: unknown): boolean` (starts with `run_`).
- Produces (events.ts): `interface RunEvents { publish(userKey: string, m: RunnerMessage): void; subscribe(userKey: string, fn: (m: RunnerMessage) => void): () => void }`; `createRunEvents(): RunEvents`; builders `ev.start(promptId)`, `ev.executing(promptId, nodeId)`, `ev.progress(promptId, nodeId, percent)`, `ev.queuePosition(promptId, nodeId, position)`, `ev.executed(promptId, nodeId, output)`, `ev.success(promptId, extra: { runId: string; credits: number | null; stopped?: boolean })`, `ev.error(promptId, nodeId, nodeType, message, extra: { runId: string; credits: number | null })`, `ev.gatePaused(legId, runId, nodeId, choices, picked)`.

- [ ] **Step 1: Write the failing test**

`frontend/tests/unit/runner-events.unit.spec.ts`:
```ts
import { describe, expect, it, vi } from 'vitest'
import { createRunEvents, ev } from '~~/server/runner/events'
import { isRunnerPromptId, RUNNER_WORKER } from '#shared/runner/messages'

describe('run events', () => {
  it('delivers only to the same user, and stops after unsubscribe', () => {
    const bus = createRunEvents()
    const a = vi.fn(); const b = vi.fn()
    const offA = bus.subscribe('u1', a)
    bus.subscribe('u2', b)
    bus.publish('u1', ev.start('run_x.0.t0'))
    expect(a).toHaveBeenCalledWith({ type: 'execution_start', data: { prompt_id: 'run_x.0.t0' } })
    expect(b).not.toHaveBeenCalled()
    offA()
    bus.publish('u1', ev.start('run_x.0.t0'))
    expect(a).toHaveBeenCalledTimes(1)
  })
  it('a listener that throws does not stop the others', () => {
    const bus = createRunEvents()
    const ok = vi.fn()
    bus.subscribe('u1', () => { throw new Error('x') })
    bus.subscribe('u1', ok)
    bus.publish('u1', ev.start('p'))
    expect(ok).toHaveBeenCalled()
  })
  it('builds the ComfyUI shapes the canvas already reads', () => {
    expect(ev.executing('p', '3')).toEqual({ type: 'executing', data: { prompt_id: 'p', node: '3', display_node: '3' } })
    expect(ev.progress('p', '3', 40)).toEqual({ type: 'progress', data: { prompt_id: 'p', node: '3', value: 40, max: 100 } })
    expect(ev.queuePosition('p', '3', 2)).toEqual({ type: 'queue_position', data: { prompt_id: 'p', node: '3', position: 2 } })
    expect(ev.executed('p', '3', { images: [] })).toEqual({ type: 'executed', data: { prompt_id: 'p', node: '3', display_node: '3', output: { images: [] } } })
    expect(ev.success('p', { runId: 'run_x', credits: 9 })).toEqual({ type: 'execution_success', data: { prompt_id: 'p', run_id: 'run_x', credits: 9, recorded: true, stopped: false } })
    expect(ev.error('p', '3', 'GenerateImageNode', 'boom', { runId: 'run_x', credits: 0 })).toEqual({
      type: 'execution_error',
      data: { prompt_id: 'p', node_id: '3', node_type: 'GenerateImageNode', exception_message: 'boom', exception_type: 'RunnerError', traceback: [], run_id: 'run_x', credits: 0, recorded: true },
    })
    const choices = [{ take: 0, files: [{ filename: 'a.png', subfolder: '', type: 'output' }] }]
    expect(ev.gatePaused('run_x.0', 'run_x', '2', choices, [0])).toEqual({
      type: 'gate_paused', data: { prompt_id: 'run_x.0', run_id: 'run_x', node_id: '2', choices, picked: [0] },
    })
  })
  it('recognises runner prompt ids', () => {
    expect(isRunnerPromptId('run_abc.0.t1')).toBe(true)
    expect(isRunnerPromptId('8c1d…')).toBe(false)
    expect(isRunnerPromptId(null)).toBe(false)
    expect(RUNNER_WORKER).toBe(-1)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/runner-events.unit.spec.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`frontend/shared/runner/messages.ts`:
```ts
/** Shapes the runner sends to the browser. The browser maps them with mapWsEvent (app/lib/graph/wsEventMap.ts). */
export interface GateChoiceFile { filename: string; subfolder: string; type: string }
export interface GateChoice { take: number; files: GateChoiceFile[] }
export interface RunnerMessage { type: string; data: Record<string, unknown> }

/** Runner runs are registered in the browser's run registry under this worker, so they never make a ComfyUI worker look busy. */
export const RUNNER_WORKER = -1

export function isRunnerPromptId(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith('run_')
}
```

`frontend/server/runner/events.ts`:
```ts
/**
 * In-process publish/subscribe of run events, per user. Messages use
 * ComfyUI's WebSocket shapes so the canvas code that reads them keeps
 * working; the browser receives them over GET /api/runs/events.
 * One server process is assumed (see the plan's Global Constraints).
 */
import type { GateChoice, RunnerMessage } from '#shared/runner/messages'

export interface RunEvents {
  publish(userKey: string, m: RunnerMessage): void
  subscribe(userKey: string, fn: (m: RunnerMessage) => void): () => void
}

export function createRunEvents(): RunEvents {
  const subs = new Map<string, Set<(m: RunnerMessage) => void>>()
  return {
    publish(userKey, m) {
      for (const fn of [...(subs.get(userKey) ?? [])]) {
        try { fn(m) } catch (e) { console.error('[runner] event listener failed', e) }
      }
    },
    subscribe(userKey, fn) {
      let set = subs.get(userKey)
      if (!set) { set = new Set(); subs.set(userKey, set) }
      set.add(fn)
      return () => {
        set!.delete(fn)
        if (!set!.size) subs.delete(userKey)
      }
    },
  }
}

export const ev = {
  start: (promptId: string): RunnerMessage => ({ type: 'execution_start', data: { prompt_id: promptId } }),
  executing: (promptId: string, nodeId: string): RunnerMessage =>
    ({ type: 'executing', data: { prompt_id: promptId, node: nodeId, display_node: nodeId } }),
  progress: (promptId: string, nodeId: string, percent: number): RunnerMessage =>
    ({ type: 'progress', data: { prompt_id: promptId, node: nodeId, value: percent, max: 100 } }),
  queuePosition: (promptId: string, nodeId: string, position: number): RunnerMessage =>
    ({ type: 'queue_position', data: { prompt_id: promptId, node: nodeId, position } }),
  executed: (promptId: string, nodeId: string, output: Record<string, unknown>): RunnerMessage =>
    ({ type: 'executed', data: { prompt_id: promptId, node: nodeId, display_node: nodeId, output } }),
  success: (promptId: string, x: { runId: string; credits: number | null; stopped?: boolean }): RunnerMessage =>
    ({ type: 'execution_success', data: { prompt_id: promptId, run_id: x.runId, credits: x.credits, recorded: true, stopped: !!x.stopped } }),
  error: (promptId: string, nodeId: string | null, nodeType: string | null, message: string, x: { runId: string; credits: number | null }): RunnerMessage => ({
    type: 'execution_error',
    data: {
      prompt_id: promptId, node_id: nodeId, node_type: nodeType, exception_message: message,
      exception_type: 'RunnerError', traceback: [], run_id: x.runId, credits: x.credits, recorded: true,
    },
  }),
  gatePaused: (legId: string, runId: string, nodeId: string, choices: GateChoice[], picked: number[]): RunnerMessage =>
    ({ type: 'gate_paused', data: { prompt_id: legId, run_id: runId, node_id: nodeId, choices, picked } }),
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/runner-events.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (controller)

Paths: `frontend/shared/runner/messages.ts frontend/server/runner/events.ts frontend/tests/unit/runner-events.unit.spec.ts`
Message: `feat(runner): per-user run events in ComfyUI's message shapes`

---

### Task 11: What each node does

**Files:**
- Create: `frontend/server/runner/executors.ts`
- Test: `frontend/tests/unit/runner-executors.unit.spec.ts`

**Interfaces:**
- Consumes: `RUNNER_IMAGE_MODELS`, `imageAppFor`, `composeImagePrompt` (Task 3); `RUNNER_VIDEO_MODELS`, `falVideoFn` (Task 4); `parseJsonObject`, `asText`, `asInt` (Task 3); `resolveVideoModelId` (Task 2); `isLink`, `ApiPrompt`, `GATE_CLASS` (Task 2); `moodboardFiles`, `parseInputFileRef` (Task 7); `OutputFile` (Task 6).
- Produces: `type NodePlan = { kind: 'provider'; endpoint: string; payload: Record<string, unknown>; media: 'image' | 'video'; prefix: string; uiFor(files: OutputFile[]): Record<string, unknown> | null } | { kind: 'pass'; files: OutputFile[]; ui: Record<string, unknown> | null } | { kind: 'pause'; files: OutputFile[] }`; `interface PlanContext { prompt: ApiPrompt; nodeId: string; filesFrom(link: [string, number]): OutputFile[]; toUrl(file: OutputFile): Promise<string>; gateOpen: boolean }`; `planNode(ctx: PlanContext): Promise<NodePlan>`.

- [ ] **Step 1: Write the failing test**

`frontend/tests/unit/runner-executors.unit.spec.ts`:
```ts
import { describe, expect, it, vi } from 'vitest'
import { planNode, type PlanContext } from '~~/server/runner/executors'
import { STYLE_REFS_INSTRUCTION } from '~~/server/runner/generators/image'
import type { ApiPrompt } from '#shared/runner/graph'

const png = (n: string) => ({ filename: n, subfolder: '', type: 'output' as const })
function ctx(prompt: ApiPrompt, nodeId: string, over: Partial<PlanContext> = {}): PlanContext {
  return {
    prompt, nodeId, gateOpen: false,
    filesFrom: ([from]) => ({ '1': [png('a.png'), png('b.png')] } as Record<string, any>)[from] ?? [],
    toUrl: async f => `https://fal.test/${f.subfolder ? `${f.subfolder}/` : ''}${f.filename}`,
    ...over,
  }
}

describe('planNode', () => {
  it('image: builds the request and saves as generate_image', async () => {
    const p: ApiPrompt = { '1': { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a fox', aspect_ratio: '16:9', seed: 4, model_options: '{"num_inference_steps":2}', style_block: 'soft' } } }
    const plan = await planNode(ctx(p, '1'))
    expect(plan).toMatchObject({ kind: 'provider', endpoint: 'fal-ai/flux/schnell', media: 'image', prefix: 'generate_image' })
    if (plan.kind !== 'provider') throw new Error()
    expect(plan.payload).toEqual({ prompt: 'soft a fox', image_size: 'landscape_16_9', num_inference_steps: 2, num_images: 1, output_format: 'png', seed: 4 })
    expect(plan.uiFor([png('x.png')])).toEqual({ images: [png('x.png')], animated: [false] })
  })
  it('image with moodboard pictures goes to the edit endpoint', async () => {
    const refs = JSON.stringify({ folder: 'moodboard_2', files: ['m1.png', 'm2.png'] })
    const p: ApiPrompt = { '1': { class_type: 'GenerateImageNode', inputs: { model: 'nano-banana-2', prompt: 'a fox', aspect_ratio: '1:1', seed: 0, model_options: '{}', style_refs: refs } } }
    const plan = await planNode(ctx(p, '1'))
    if (plan.kind !== 'provider') throw new Error()
    expect(plan.endpoint).toBe('fal-ai/nano-banana-2/edit')
    expect(plan.payload.image_urls).toEqual(['https://fal.test/moodboard_2/m1.png', 'https://fal.test/moodboard_2/m2.png'])
    expect(plan.payload.prompt).toBe(`a fox ${STYLE_REFS_INSTRUCTION}`)
  })
  it('a moodboard picture that cannot be read is skipped, like Python', async () => {
    const refs = JSON.stringify({ folder: 'moodboard_2', files: ['gone.png'] })
    const p: ApiPrompt = { '1': { class_type: 'GenerateImageNode', inputs: { model: 'nano-banana-2', prompt: 'a fox', aspect_ratio: '1:1', seed: 0, model_options: '{}', style_refs: refs } } }
    const plan = await planNode(ctx(p, '1', { toUrl: vi.fn(async () => { throw new Error('ENOENT') }) }))
    if (plan.kind !== 'provider') throw new Error()
    expect(plan.endpoint).toBe('fal-ai/nano-banana-2')
    expect(plan.payload.prompt).toBe('a fox')
  })
  it('video from the picture behind a Gate uses image-to-video', async () => {
    const p: ApiPrompt = { '3': { class_type: 'GenerateVideoNode', inputs: { model: 'hailuo-h3', prompt: 'moves', image: ['1', 0], aspect_ratio: '16:9', duration: '6', seed: 0, model_options: '{}' } } }
    const plan = await planNode(ctx(p, '3'))
    expect(plan).toMatchObject({ kind: 'provider', endpoint: 'minimax/h3/image-to-video', media: 'video', prefix: 'generate_video' })
    if (plan.kind !== 'provider') throw new Error()
    expect(plan.payload).toMatchObject({ image_url: 'https://fal.test/a.png', duration: 6 })
    expect(plan.uiFor([])).toBeNull()
  })
  it('text-to-video on Veo submits to the app itself', async () => {
    const p: ApiPrompt = { '3': { class_type: 'GenerateVideoNode', inputs: { model: 'veo-3.1-fast', prompt: 'waves', aspect_ratio: '9:16', duration: '8', seed: 0, model_options: '{}' } } }
    const plan = await planNode(ctx(p, '3'))
    expect(plan).toMatchObject({ endpoint: 'fal-ai/veo3.1/fast' })
  })
  it('a closed Gate pauses with what it received; an open one passes it on', async () => {
    const p: ApiPrompt = { '2': { class_type: 'ComfyGateNode', inputs: { data_in: ['1', 0], bypass: false } } }
    expect(await planNode(ctx(p, '2'))).toEqual({ kind: 'pause', files: [png('a.png'), png('b.png')] })
    expect(await planNode(ctx(p, '2', { gateOpen: true }))).toEqual({ kind: 'pass', files: [png('a.png'), png('b.png')], ui: null })
    const bypassed: ApiPrompt = { '2': { class_type: 'ComfyGateNode', inputs: { data_in: ['1', 0], bypass: true } } }
    expect((await planNode(ctx(bypassed, '2'))).kind).toBe('pass')
  })
  it('Image card: shows what it is given, one of a batch, or a loaded file', async () => {
    const wired: ApiPrompt = { '5': { class_type: 'Image', inputs: { images: ['1', 0], batch_index: -1 } } }
    expect(await planNode(ctx(wired, '5'))).toEqual({ kind: 'pass', files: [png('a.png'), png('b.png')], ui: { images: [png('a.png'), png('b.png')] } })
    const one: ApiPrompt = { '5': { class_type: 'Image', inputs: { images: ['1', 0], batch_index: 7 } } }
    expect(await planNode(ctx(one, '5'))).toEqual({ kind: 'pass', files: [png('b.png')], ui: { images: [png('b.png')] } })
    const loaded: ApiPrompt = { '5': { class_type: 'Image', inputs: { image: 'mine.png' } } }
    const f = { filename: 'mine.png', subfolder: '', type: 'input' }
    expect(await planNode(ctx(loaded, '5'))).toEqual({ kind: 'pass', files: [f], ui: { images: [f] } })
    const empty: ApiPrompt = { '5': { class_type: 'Image', inputs: { image: '' } } }
    expect(await planNode(ctx(empty, '5'))).toEqual({ kind: 'pass', files: [], ui: { images: [] } })
  })
  it('Video card marks its preview as moving', async () => {
    const p: ApiPrompt = { '4': { class_type: 'Video', inputs: { source: ['1', 0] } } }
    expect(await planNode(ctx(p, '4'))).toEqual({ kind: 'pass', files: [png('a.png'), png('b.png')], ui: { images: [png('a.png'), png('b.png')], animated: [true] } })
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/runner-executors.unit.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`frontend/server/runner/executors.ts`:
```ts
/**
 * What each runner node does, as a plan the engine carries out:
 *   provider — send a request to fal, save what comes back
 *   pass     — hand files on (result cards, an open Gate)
 *   pause    — a closed Gate: stop this branch and show what reached it
 * Mirrors the Python nodes (GenerateImageNode, GenerateVideoNode, Gate,
 * Image, Video) closely enough that the same workflow gives the same result.
 */
import { GATE_CLASS, isLink, type ApiPrompt } from '#shared/runner/graph'
import { resolveVideoModelId } from '#shared/runner/eligibility'
import { RUNNER_IMAGE_MODELS, composeImagePrompt, imageAppFor } from './generators/image'
import { RUNNER_VIDEO_MODELS, falVideoFn } from './generators/video'
import { asInt, asText, parseJsonObject } from './generators/opts'
import { moodboardFiles, parseInputFileRef } from './inputs'
import type { OutputFile } from './types'

export type NodePlan =
  | { kind: 'provider'; endpoint: string; payload: Record<string, unknown>; media: 'image' | 'video'; prefix: string; uiFor(files: OutputFile[]): Record<string, unknown> | null }
  | { kind: 'pass'; files: OutputFile[]; ui: Record<string, unknown> | null }
  | { kind: 'pause'; files: OutputFile[] }

export interface PlanContext {
  prompt: ApiPrompt
  nodeId: string
  /** Files produced by the node a link points at. */
  filesFrom(link: [string, number]): OutputFile[]
  /** Our saved file → a link fal can fetch. */
  toUrl(file: OutputFile): Promise<string>
  /** For a Gate: this take was let through it. */
  gateOpen: boolean
}

export async function planNode(ctx: PlanContext): Promise<NodePlan> {
  const node = ctx.prompt[ctx.nodeId]
  if (!node) throw new Error(`Node ${ctx.nodeId} is missing from the workflow`)
  const inputs = node.inputs ?? {}
  const linked = (name: string): OutputFile[] => {
    const v = inputs[name]
    return isLink(v) ? ctx.filesFrom(v) : []
  }

  switch (node.class_type) {
    case 'GenerateImageNode': {
      const desc = RUNNER_IMAGE_MODELS[String(inputs.model)]
      if (!desc) throw new Error(`Unknown image model: ${String(inputs.model)}`)
      let refs: string[] | null = null
      if (desc.refsApp) {
        const urls: string[] = []
        for (const f of moodboardFiles(inputs.style_refs)) {
          try { urls.push(await ctx.toUrl(f)) }
          catch (e) { console.warn(`[runner] moodboard picture unreadable, skipping: ${f.subfolder}/${f.filename}`, e) }
        }
        refs = urls.length ? urls : null
      }
      const prompt = composeImagePrompt({
        prompt: asText(inputs.prompt),
        promptIn: asText(inputs.prompt_in),
        styleBlock: asText(inputs.style_block),
        styleIn: asText(inputs.style_in),
        hasRefs: !!refs,
      })
      const payload = desc.build({
        prompt,
        aspectRatio: asText(inputs.aspect_ratio) || '1:1',
        seed: asInt(inputs.seed, 0),
        adv: parseJsonObject(inputs.model_options),
        refs,
      })
      return {
        kind: 'provider', endpoint: imageAppFor(desc, refs), payload, media: 'image', prefix: 'generate_image',
        uiFor: files => ({ images: files, animated: [false] }),
      }
    }

    case 'GenerateVideoNode': {
      const id = resolveVideoModelId(inputs.model)
      const desc = RUNNER_VIDEO_MODELS[id]
      if (!desc) throw new Error(`Unknown video model: ${String(inputs.model)}`)
      const first = linked('image')[0]
      const image = first ? await ctx.toUrl(first) : null
      const payload = desc.build({
        prompt: asText(inputs.prompt),
        aspectRatio: asText(inputs.aspect_ratio) || '16:9',
        duration: asInt(inputs.duration, desc.defaultDuration),
        seed: asInt(inputs.seed, 0),
        image,
        adv: parseJsonObject(inputs.model_options),
      })
      const fn = falVideoFn(payload, desc.fnByMode)
      return {
        kind: 'provider', endpoint: fn ? `${desc.app}/${fn}` : desc.app, payload, media: 'video', prefix: 'generate_video',
        // GenerateVideoNode shows nothing itself; the Video card after it does.
        uiFor: () => null,
      }
    }

    case GATE_CLASS: {
      const files = linked('data_in')
      if (inputs.bypass === true || ctx.gateOpen) return { kind: 'pass', files, ui: null }
      return { kind: 'pause', files }
    }

    case 'Image': {
      let files: OutputFile[]
      if (isLink(inputs.images)) {
        files = linked('images')
        const bi = typeof inputs.batch_index === 'number' ? inputs.batch_index : -1
        if (bi >= 0 && files.length > 1) files = [files[Math.min(bi, files.length - 1)]!]
      }
      else {
        const f = parseInputFileRef(inputs.image)
        files = f ? [f] : []
      }
      return { kind: 'pass', files, ui: { images: files } }
    }

    case 'Video': {
      let files: OutputFile[]
      if (isLink(inputs.source)) files = linked('source')
      else {
        const f = parseInputFileRef(inputs.file)
        files = f ? [f] : []
      }
      return { kind: 'pass', files, ui: files.length ? { images: files, animated: [true] } : { images: [] } }
    }

    default:
      throw new Error(`The runner cannot run a ${node.class_type} node`)
  }
}
```

Note for the implementer: the video test's `payload.duration` of `6` is correct for Hailuo (integer duration, from `[5, 6, 10]`).

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/runner-executors.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (controller)

Paths: `frontend/server/runner/executors.ts frontend/tests/unit/runner-executors.unit.spec.ts`
Message: `feat(runner): node plans for image, video, Gate and result cards`

---
### Task 12: The engine — runs, legs, parallel nodes, polling, reuse, charging

**Files:**
- Create: `frontend/server/runner/engine.ts`
- Create: `frontend/tests/unit/__runner__/kit.ts` (test helpers: fake fal, fake ledger, a wired engine)
- Test: `frontend/tests/unit/runner-engine.unit.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–11 by the names listed there; `BASE_RENDER_CREDITS` (Task 1); `MeterRefusalError`.
- Produces:
  - `class RunStopped extends Error`
  - `createLimiter(limit: number): { acquire(key: string, signal: AbortSignal): Promise<void>; release(key: string): void; inFlight(key: string): number; waiting(key: string): number }`
  - `gateStateOf(take: TakeRecord): TakeGateState`
  - `interface StageRecordSummary { run: RunRecord; take: TakeRecord; leg: LegRecord; charge: StageCharge; outputs: OutputFile[]; nodeTypes: string[]; ts: number }`
  - `interface EngineDeps { store: RunStore; fal: FalClient; results: ResultStore; handoff: Handoff; metering: Metering; events: RunEvents; ownership: OwnershipCheck; records: { write(s: StageRecordSummary): Promise<void> }; download(url: string): Promise<{ bytes: Uint8Array; contentType: string | null }>; hosted(): boolean; webhookUrl(): string | null; now(): number; sleep(ms: number, signal: AbortSignal): Promise<void>; newId(): string; perUserLimit: number; maxTakes: number; timeouts: { imageMs: number; videoMs: number }; pollDelayMs(attempt: number): number; reportError(e: unknown, ctx: Record<string, unknown>): void }`
  - `interface StartRunInput { userId: string | null; takes: unknown; workflow: unknown; canvasId: string | null; projectUuid: string | null; projectName: string | null }`
  - `interface LegStarted { runId: string; legId: string; promptIds: string[] }`
  - `type GateActionName = 'continue' | 'redo' | 'restart'`
  - `interface GateActionInput { userId: string | null; runId: string; gateId: string; action: GateActionName; takes?: number[] }`
  - `interface PausedGate { runId: string; promptId: string; nodeId: string; choices: GateChoice[]; picked: number[] }`
  - `interface RunnerRecordView { runId: string; promptId: string; workflow: unknown; createdAt: number; endedAt: number | null; credits: number | null; prompt: string | null; nodeTypes: string[]; projectUuid: string | null; projectName: string | null }`
  - `type Engine = ReturnType<typeof createEngine>` with methods `startRun(i: StartRunInput): Promise<LegStarted>`, `gateAction(i: GateActionInput): Promise<LegStarted>` (Task 13), `stop(userId: string | null, runIds?: string[]): Promise<{ stopped: string[] }>` (Task 13), `reattach(): Promise<number>` (Task 13), `nudge(requestId: string): boolean`, `pausedGates(userId: string | null, canvasId: string | null): Promise<PausedGate[]>` (Task 13), `snapshot(userId: string | null): RunnerMessage[]` (Task 13), `record(userId: string | null, promptId: string): Promise<RunnerRecordView | null>` (Task 13), `settled(runId: string): Promise<void>`, and the property `events: RunEvents`.
  - `applyGateAction(run: RunRecord, gateId: string, action: GateActionName, picked: number[] | undefined): { legAction: LegAction; legTakes: number[] }` (Task 13, exported for tests).

- [ ] **Step 1: Write the test kit**

`frontend/tests/unit/__runner__/kit.ts`:
```ts
/** Test helpers for the runner engine: a fake fal, a fake ledger, and an engine wired to real file storage in a temp folder. */
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { FalClient } from '~~/server/runner/falQueue'
import { createEngine, type EngineDeps } from '~~/server/runner/engine'
import { createFileRunStore } from '~~/server/runner/store'
import { createEngineResultStore } from '~~/server/runner/results'
import { createHandoff } from '~~/server/runner/handoff'
import { createMetering, type LedgerPort } from '~~/server/runner/metering'
import { createRunEvents } from '~~/server/runner/events'
import type { RunnerMessage } from '#shared/runner/messages'
import type { ApiPrompt } from '#shared/runner/graph'

export interface FakeRequest {
  id: string
  endpoint: string
  payload: Record<string, unknown>
  polls: number
  held: boolean
  failWith: string | null
  cancelled: boolean
}

export function createFakeFal() {
  const reqs = new Map<string, FakeRequest>()
  let seq = 0
  const next = { hold: 0, fail: 0 }
  const idOf = (url: string) => /^fal:\/\/(req\d+)/.exec(url)![1]!
  const client: FalClient = {
    submit: vi.fn(async (endpoint: string, payload: Record<string, unknown>) => {
      const id = `req${++seq}`
      const r: FakeRequest = { id, endpoint, payload, polls: 0, held: next.hold > 0, failWith: next.fail > 0 ? 'The provider refused this prompt' : null, cancelled: false }
      if (next.hold > 0) next.hold--
      if (next.fail > 0) next.fail--
      reqs.set(id, r)
      return { requestId: id, statusUrl: `fal://${id}/status`, responseUrl: `fal://${id}`, cancelUrl: `fal://${id}/cancel`, queuePosition: 2 }
    }) as any,
    status: vi.fn(async (url: string) => {
      const r = reqs.get(idOf(url))!
      r.polls++
      const base = { queuePosition: null, logs: [], error: null, transient: false, raw: {} }
      if (r.cancelled) return { ...base, status: 'COMPLETED', error: 'Request was cancelled' }
      if (r.polls === 1) return { ...base, status: 'IN_QUEUE', queuePosition: 1 }
      if (r.held) return { ...base, status: 'IN_PROGRESS', logs: [{ message: 'Generating 50%' }] }
      if (r.failWith) return { ...base, status: 'COMPLETED', error: r.failWith }
      return { ...base, status: 'COMPLETED' }
    }) as any,
    result: vi.fn(async (url: string) => {
      const id = idOf(url)
      return { images: [{ url: `https://fal.media/${id}.png` }], video: { url: `https://fal.media/${id}.mp4` } }
    }) as any,
    cancel: vi.fn(async (url: string) => {
      reqs.get(idOf(url))!.cancelled = true
      return 'cancelled' as const
    }) as any,
  }
  return {
    client,
    reqs,
    /** The next n submitted requests stay "in progress" until released. */
    holdNext(n: number) { next.hold = n },
    failNext(n: number) { next.fail = n },
    release(id?: string) { for (const r of reqs.values()) if (!id || r.id === id) r.held = false },
    submitted: () => [...reqs.values()],
  }
}

export function createFakeLedger(available = 1000) {
  let seq = 0
  const holds = new Map<number, { key: string; credits: number; state: 'open' | 'settled' | 'released'; actual: number | null }>()
  const byKey = new Map<string, number>()
  const ledger: LedgerPort & { holds: typeof holds } = {
    holds,
    hold: vi.fn(async (_u: string, credits: number, key: string) => {
      if (byKey.has(key)) return { ok: true as const, holdId: byKey.get(key)! }
      if (credits > available) return { ok: false as const, reason: 'insufficient' as const }
      available -= credits
      const id = ++seq
      holds.set(id, { key, credits, state: 'open', actual: null })
      byKey.set(key, id)
      return { ok: true as const, holdId: id }
    }),
    settle: vi.fn(async (holdId: number, actual: number) => {
      const h = holds.get(holdId)!
      if (h.state !== 'open') return { settled: h.state === 'settled' }
      h.state = 'settled'; h.actual = actual; available += h.credits - actual
      return { settled: true }
    }),
    release: vi.fn(async (holdId: number) => {
      const h = holds.get(holdId)!
      if (h.state !== 'open') return
      h.state = 'released'; available += h.credits
    }),
    getAvailable: vi.fn(async () => available),
  }
  return ledger
}

let uuidSeq = 0
export const testUuid = () => `00000000-0000-4000-8000-${String(++uuidSeq).padStart(12, '0')}`

export function makeKit(opts: { hosted?: boolean; available?: number; dir?: string; root?: string; fal?: ReturnType<typeof createFakeFal>; ledger?: ReturnType<typeof createFakeLedger>; deps?: Partial<EngineDeps> } = {}) {
  const hosted = !!opts.hosted
  const userId = hosted ? 'user_1' : null
  const root = opts.root ?? mkdtempSync(join(tmpdir(), 'runner-engine-root-'))
  for (const t of ['input', 'output', 'temp']) mkdirSync(join(root, t), { recursive: true })
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'runner-engine-runs-'))
  const store = createFileRunStore(dir)
  const results = createEngineResultStore({ dirForType: t => join(root, t), hosted: () => hosted })
  const fal = opts.fal ?? createFakeFal()
  const ledger = opts.ledger ?? createFakeLedger(opts.available ?? 1000)
  const graphRuns = { create: vi.fn(async () => {}), appendOutput: vi.fn(async () => {}), resolve: vi.fn(async () => {}) }
  const metering = createMetering({ hosted: () => hosted, ledger: () => ledger, graphRuns, spendGuard: async () => {}, moderate: async () => ({ ok: true as const }) })
  const events = createRunEvents()
  const seen: RunnerMessage[] = []
  events.subscribe(userId ?? 'local', m => seen.push(m))
  const upload = vi.fn(async (_b: Uint8Array, name: string) => `https://fal.storage/${name}`)
  const handoff = createHandoff({ read: f => results.read(f), upload })
  const records = { write: vi.fn(async () => {}) }
  const deps: EngineDeps = {
    store, fal: fal.client, results, handoff, metering, events, records,
    ownership: { ownsInput: async () => true, ownsOutput: async () => true },
    download: async (url: string) => ({ bytes: new TextEncoder().encode(url), contentType: url.endsWith('.mp4') ? 'video/mp4' : 'image/png' }),
    hosted: () => hosted,
    webhookUrl: () => null,
    now: () => Date.now(),
    sleep: (_ms, signal) => new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 1)
      signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
    }),
    newId: testUuid,
    perUserLimit: 4,
    maxTakes: 8,
    timeouts: { imageMs: 300_000, videoMs: 1_800_000 },
    pollDelayMs: () => 1,
    reportError: vi.fn(),
    ...opts.deps,
  }
  const engine = createEngine(deps)
  return { engine, deps, fal, ledger, graphRuns, seen, records, upload, root, dir, store, userId }
}

/** image(1) → Gate(2) → video(3) → Video card(4); image(1) → Image card(5) */
export function gatedFlow(o: { imageSeed?: number; videoSeed?: number; imageModel?: string; videoModel?: string; bypass?: boolean } = {}): ApiPrompt {
  return {
    '1': { class_type: 'GenerateImageNode', inputs: { model: o.imageModel ?? 'flux-schnell', prompt: 'a red fox', aspect_ratio: '1:1', seed: o.imageSeed ?? 0, model_options: '{}' } },
    '2': { class_type: 'ComfyGateNode', inputs: { data_in: ['1', 0], bypass: !!o.bypass } },
    '3': { class_type: 'GenerateVideoNode', inputs: { model: o.videoModel ?? 'hailuo-h3', prompt: 'the fox runs', image: ['2', 0], aspect_ratio: '16:9', duration: '5', seed: o.videoSeed ?? 0, model_options: '{}' } },
    '4': { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'video/ComfyUI', source: ['3', 0] } },
    '5': { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
  }
}

export const types = (seen: RunnerMessage[]) => seen.map(m => m.type)
export const ofType = (seen: RunnerMessage[], type: string) => seen.filter(m => m.type === type)

/** Poll until `check` is true (the engine works in the background). */
export async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting for the engine')
    await new Promise(r => setTimeout(r, 2))
  }
}
```

- [ ] **Step 2: Write the failing engine test**

`frontend/tests/unit/runner-engine.unit.spec.ts`:
```ts
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createLimiter } from '~~/server/runner/engine'
import { makeKit, gatedFlow, ofType, types, until } from './__runner__/kit'
import type { ApiPrompt } from '#shared/runner/graph'

describe('limiter', () => {
  it('lets four through per user and queues the rest in order', async () => {
    const l = createLimiter(4)
    const ctl = new AbortController()
    for (let i = 0; i < 4; i++) await l.acquire('u', ctl.signal)
    const order: number[] = []
    const fifth = l.acquire('u', ctl.signal).then(() => order.push(5))
    const sixth = l.acquire('u', ctl.signal).then(() => order.push(6))
    await l.acquire('other', ctl.signal) // another user is not held up
    expect(l.inFlight('u')).toBe(4)
    expect(l.waiting('u')).toBe(2)
    l.release('u'); await fifth
    l.release('u'); await sixth
    expect(order).toEqual([5, 6])
  })
  it('a stopped run leaves the queue', async () => {
    const l = createLimiter(1)
    await l.acquire('u', new AbortController().signal)
    const ctl = new AbortController()
    const p = l.acquire('u', ctl.signal)
    ctl.abort()
    await expect(p).rejects.toThrow('Stopped')
    expect(l.waiting('u')).toBe(0)
  })
})

describe('run → Gate', () => {
  it('makes the image, shows it, pauses at the Gate and does not start the video', async () => {
    const k = makeKit()
    const { runId, legId, promptIds } = await k.engine.startRun({ userId: null, takes: [gatedFlow()], workflow: { nodes: [] }, canvasId: 'c1', projectUuid: null, projectName: null })
    expect(legId).toBe(`${runId}.0`)
    expect(promptIds).toEqual([`${runId}.0.t0`])
    await k.engine.settled(runId)

    expect(k.fal.submitted().map(r => r.endpoint)).toEqual(['fal-ai/flux/schnell'])
    const stage = promptIds[0]!
    expect(types(k.seen)).toContain('execution_start')
    expect(ofType(k.seen, 'queue_position')[0]!.data).toMatchObject({ prompt_id: stage, node: '1', position: 2 })
    const executed = ofType(k.seen, 'executed')
    expect(executed.map(m => m.data.node)).toEqual(['1', '5'])
    const img = (executed[0]!.data.output as any).images[0]
    expect(img).toEqual({ filename: 'generate_image_00001_.png', subfolder: '', type: 'output' })
    expect(existsSync(join(k.root, 'output', img.filename))).toBe(true)
    expect(ofType(k.seen, 'execution_success')[0]!.data).toMatchObject({ prompt_id: stage, run_id: runId, recorded: true, credits: null })
    const paused = ofType(k.seen, 'gate_paused')
    expect(paused).toHaveLength(1)
    expect(paused[0]!.data).toEqual({ prompt_id: legId, run_id: runId, node_id: '2', choices: [{ take: 0, files: [img] }], picked: [0] })
    // the pause is the last word
    expect(k.seen.at(-1)!.type).toBe('gate_paused')

    const saved = await k.store.get(runId)
    expect(saved!.status).toBe('paused')
    expect(saved!.takes[0]!.nodes['3']!.status).toBe('waiting')
    expect(k.records.write).toHaveBeenCalledTimes(1)
  })

  it('a Gate with pass-through on runs everything in one go', async () => {
    const k = makeKit()
    const { runId } = await k.engine.startRun({ userId: null, takes: [gatedFlow({ bypass: true })], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await k.engine.settled(runId)
    expect(k.fal.submitted().map(r => r.endpoint)).toEqual(['fal-ai/flux/schnell', 'minimax/h3/image-to-video'])
    expect(k.fal.submitted()[1]!.payload.image_url).toBe('https://fal.storage/generate_image_00001_.png')
    const videoCard = ofType(k.seen, 'executed').find(m => m.data.node === '4')!
    expect((videoCard.data.output as any)).toEqual({ images: [{ filename: 'generate_video_00001_.mp4', subfolder: '', type: 'output' }], animated: [true] })
    expect(ofType(k.seen, 'gate_paused')).toHaveLength(0)
    expect((await k.store.get(runId))!.status).toBe('done')
  })

  it('refuses a workflow the runner cannot take', async () => {
    const k = makeKit()
    const bad: ApiPrompt = { '1': { class_type: 'ImageBlur', inputs: {} } }
    await expect(k.engine.startRun({ userId: null, takes: [bad], workflow: null, canvasId: null, projectUuid: null, projectName: null }))
      .rejects.toMatchObject({ statusCode: 400 })
    await expect(k.engine.startRun({ userId: null, takes: [], workflow: null, canvasId: null, projectUuid: null, projectName: null }))
      .rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('money (hosted)', () => {
  it('holds only the first stage (+ the render credit once) and charges it exactly', async () => {
    const k = makeKit({ hosted: true })
    const { runId, promptIds } = await k.engine.startRun({ userId: 'user_1', takes: [gatedFlow()], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await k.engine.settled(runId)
    expect(k.ledger.hold).toHaveBeenCalledTimes(1)
    expect(k.ledger.hold).toHaveBeenCalledWith('user_1', 2, `runner:${promptIds[0]}`)
    expect(k.ledger.settle).toHaveBeenCalledWith(1, 2, `runner:${promptIds[0]}`)
    expect(ofType(k.seen, 'execution_success')[0]!.data.credits).toBe(2)
    expect(k.graphRuns.appendOutput).toHaveBeenCalledWith(promptIds[0], expect.stringMatching(/^output:u_[0-9a-f]{12}:generate_image_00001_\.png$/))
  })
  it('refuses before anything runs when credits are short', async () => {
    const k = makeKit({ hosted: true, available: 1 })
    await expect(k.engine.startRun({ userId: 'user_1', takes: [gatedFlow()], workflow: null, canvasId: null, projectUuid: null, projectName: null }))
      .rejects.toMatchObject({ statusCode: 402, data: { required: 2, available: 1 } })
    expect(k.fal.client.submit).not.toHaveBeenCalled()
  })
  it('a failed request drops the hold, skips what comes after and says why', async () => {
    const k = makeKit({ hosted: true })
    k.fal.failNext(1)
    const { runId, promptIds } = await k.engine.startRun({ userId: 'user_1', takes: [gatedFlow({ bypass: true })], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await k.engine.settled(runId)
    expect(k.fal.submitted()).toHaveLength(1) // the video never went out
    expect(k.ledger.release).toHaveBeenCalledWith(1)
    expect(k.ledger.settle).not.toHaveBeenCalled()
    const err = ofType(k.seen, 'execution_error')[0]!
    expect(err.data).toMatchObject({ prompt_id: promptIds[0], node_id: '1', node_type: 'GenerateImageNode', exception_message: 'The provider refused this prompt', credits: 0 })
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('error')
    expect(run.takes[0]!.nodes['3']!.status).toBe('skipped')
  })
})

describe('parallel work', () => {
  const twoBranches: ApiPrompt = {
    '1': { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a', aspect_ratio: '1:1', seed: 0, model_options: '{}' } },
    '2': { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'b', aspect_ratio: '1:1', seed: 0, model_options: '{}' } },
  }
  it('two independent branches go out at the same time', async () => {
    const k = makeKit()
    k.fal.holdNext(2)
    const { runId } = await k.engine.startRun({ userId: null, takes: [twoBranches], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await until(() => k.fal.submitted().length === 2)
    k.fal.release()
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.status).toBe('done')
  })
  it('the fifth call waits for a free slot', async () => {
    const k = makeKit()
    const five: ApiPrompt = {}
    for (let i = 1; i <= 5; i++) five[String(i)] = { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: `p${i}`, aspect_ratio: '1:1', seed: 0, model_options: '{}' } }
    k.fal.holdNext(5)
    const { runId } = await k.engine.startRun({ userId: null, takes: [five], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await until(() => k.fal.submitted().length === 4)
    await new Promise(r => setTimeout(r, 20))
    expect(k.fal.submitted()).toHaveLength(4)
    k.fal.release(k.fal.submitted()[0]!.id)
    await until(() => k.fal.submitted().length === 5)
    k.fal.release()
    await k.engine.settled(runId)
  })
})

describe('never pay twice', () => {
  it('an identical request with a fixed seed reuses the earlier file and charges nothing', async () => {
    const k = makeKit({ hosted: true })
    const a = await k.engine.startRun({ userId: 'user_1', takes: [gatedFlow({ imageSeed: 7 })], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await k.engine.settled(a.runId)
    const b = await k.engine.startRun({ userId: 'user_1', takes: [gatedFlow({ imageSeed: 7 })], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await k.engine.settled(b.runId)
    expect(k.fal.submitted()).toHaveLength(1)
    const first = ofType(k.seen, 'executed').filter(m => m.data.node === '1')
    expect(first[1]!.data.output).toEqual(first[0]!.data.output)
    const successB = ofType(k.seen, 'execution_success').find(m => m.data.prompt_id === b.promptIds[0])!
    expect(successB.data.credits).toBe(0)
    expect(k.ledger.release).toHaveBeenCalledWith(2)
  })
  it('seed 0 always asks again', async () => {
    const k = makeKit()
    for (let i = 0; i < 2; i++) {
      const r = await k.engine.startRun({ userId: null, takes: [gatedFlow({ imageSeed: 0 })], workflow: null, canvasId: null, projectUuid: null, projectName: null })
      await k.engine.settled(r.runId)
    }
    expect(k.fal.submitted()).toHaveLength(2)
  })
})

describe('Re-roll ×4 with a Gate', () => {
  it('makes four pictures at once and pauses once with four choices, none picked', async () => {
    const k = makeKit()
    const takes = [1, 2, 3, 4].map(s => gatedFlow({ imageSeed: s }))
    const { runId, legId, promptIds } = await k.engine.startRun({ userId: null, takes, workflow: null, canvasId: null, projectUuid: null, projectName: null })
    expect(promptIds).toEqual([0, 1, 2, 3].map(t => `${legId}.t${t}`))
    await k.engine.settled(runId)
    expect(k.fal.submitted()).toHaveLength(4)
    expect(k.fal.submitted().map(r => r.payload.seed).sort()).toEqual([1, 2, 3, 4])
    const paused = ofType(k.seen, 'gate_paused')
    expect(paused).toHaveLength(1)
    expect((paused[0]!.data.choices as any[]).map(c => c.take)).toEqual([0, 1, 2, 3])
    expect(paused[0]!.data.picked).toEqual([])
  })
})
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/runner-engine.unit.spec.ts`
Expected: FAIL — `server/runner/engine` not found.

- [ ] **Step 4: Implement the engine**

`frontend/server/runner/engine.ts`:
```ts
/**
 * The Sailor runner. A run is a written-down to-do list: every node's state
 * is saved before and after each outside call, so a restarted server reads
 * the list back and carries on (reattach). A leg runs every node it can
 * reach, in parallel where the graph allows, until each take has finished,
 * failed or paused at a Gate. Money is held per take before a leg starts and
 * charged exactly when it ends. See docs/superpowers/specs/2026-09-22-sailor-runner-and-gate-design.md.
 */
import { isRunnerEligible } from '#shared/runner/eligibility'
import {
  GATE_CLASS, dependenciesOf, downstreamNodes, legNodes, upstreamStage,
  type ApiPrompt, type TakeGateState,
} from '#shared/runner/graph'
import type { GateChoice, RunnerMessage } from '#shared/runner/messages'
import { MeterRefusalError } from '../utils/requestMeter'
import { BASE_RENDER_CREDITS, UnpricedGraphError } from '../utils/priceBook'
import { extractGraphPromptText } from '../utils/graphPromptText'
import { falImageUrls, falVideoUrl, percentFromLogs, type FalClient } from './falQueue'
import { planNode } from './executors'
import { isReusable, requestFingerprint } from './fingerprint'
import { assertFilesOwned, collectInputFiles, type OwnershipCheck } from './inputs'
import { hasOutputNode, nodeCredits, stageEstimate, type Metering } from './metering'
import { ev, type RunEvents } from './events'
import type { Handoff } from './handoff'
import { extFor, type ResultStore } from './results'
import { runIdOf, userKeyOf, type RunStore } from './store'
import {
  emptyNodeRecord, stageKeyOf,
  type LegAction, type LegRecord, type NodeRecord, type OutputFile, type RunRecord, type RunStatus,
  type StageCharge, type TakeRecord,
} from './types'

export class RunStopped extends Error {
  constructor() { super('Stopped'); this.name = 'RunStopped' }
}

export function createLimiter(limit: number) {
  const active = new Map<string, number>()
  const queues = new Map<string, Array<() => void>>()
  return {
    async acquire(key: string, signal: AbortSignal): Promise<void> {
      if (signal.aborted) throw new RunStopped()
      const n = active.get(key) ?? 0
      if (n < limit) { active.set(key, n + 1); return }
      await new Promise<void>((resolve, reject) => {
        const q = queues.get(key) ?? []
        queues.set(key, q)
        const onAbort = () => {
          const i = q.indexOf(grant)
          if (i >= 0) q.splice(i, 1)
          reject(new RunStopped())
        }
        const grant = () => { signal.removeEventListener('abort', onAbort); resolve() }
        signal.addEventListener('abort', onAbort, { once: true })
        q.push(grant)
      })
    },
    release(key: string): void {
      const next = queues.get(key)?.shift()
      if (next) { next(); return } // the slot passes straight to the next in line
      const n = (active.get(key) ?? 1) - 1
      if (n <= 0) active.delete(key)
      else active.set(key, n)
    },
    inFlight: (key: string) => active.get(key) ?? 0,
    waiting: (key: string) => queues.get(key)?.length ?? 0,
  }
}

const FINISHED_BADLY = new Set(['error', 'skipped', 'stopped', 'dropped'])

export function gateStateOf(take: TakeRecord): TakeGateState {
  const done = new Set<string>()
  const dropped = new Set<string>(take.droppedGates)
  for (const [id, n] of Object.entries(take.nodes)) {
    if (n.status === 'done') done.add(id)
    else if (FINISHED_BADLY.has(n.status)) dropped.add(id)
  }
  return { done, open: new Set(take.openGates), dropped }
}

export interface StageRecordSummary {
  run: RunRecord
  take: TakeRecord
  leg: LegRecord
  charge: StageCharge
  outputs: OutputFile[]
  nodeTypes: string[]
  ts: number
}

export interface EngineDeps {
  store: RunStore
  fal: FalClient
  results: ResultStore
  handoff: Handoff
  metering: Metering
  events: RunEvents
  ownership: OwnershipCheck
  records: { write(s: StageRecordSummary): Promise<void> }
  download(url: string): Promise<{ bytes: Uint8Array; contentType: string | null }>
  hosted(): boolean
  webhookUrl(): string | null
  now(): number
  sleep(ms: number, signal: AbortSignal): Promise<void>
  newId(): string
  perUserLimit: number
  maxTakes: number
  timeouts: { imageMs: number; videoMs: number }
  pollDelayMs(attempt: number): number
  reportError(e: unknown, ctx: Record<string, unknown>): void
}

export interface StartRunInput {
  userId: string | null
  takes: unknown
  workflow: unknown
  canvasId: string | null
  projectUuid: string | null
  projectName: string | null
}

export interface LegStarted { runId: string; legId: string; promptIds: string[] }
export type GateActionName = 'continue' | 'redo' | 'restart'
export interface GateActionInput { userId: string | null; runId: string; gateId: string; action: GateActionName; takes?: number[] }
export interface PausedGate { runId: string; promptId: string; nodeId: string; choices: GateChoice[]; picked: number[] }
export interface RunnerRecordView {
  runId: string
  promptId: string
  workflow: unknown
  createdAt: number
  endedAt: number | null
  credits: number | null
  prompt: string | null
  nodeTypes: string[]
  projectUuid: string | null
  projectName: string | null
}

type TakeOutcome = 'done' | 'error' | 'stopped' | 'paused'

interface LiveRun {
  run: RunRecord
  ctl: AbortController
  legPromise: Promise<void> | null
  saving: Promise<void>
}

const GENERATORS = new Set(['GenerateImageNode', 'GenerateVideoNode'])
const refuse = (message: string, status: number, data?: unknown) => new MeterRefusalError(message, status, data)

function plainError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  return m.length > 300 ? `${m.slice(0, 299)}…` : m
}

function pausedChoices(run: RunRecord): Map<string, GateChoice[]> {
  const gates = new Map<string, GateChoice[]>()
  for (const t of run.takes) {
    for (const [id, n] of Object.entries(t.nodes)) {
      if (n.status !== 'paused') continue
      const list = gates.get(id) ?? []
      list.push({ take: t.index, files: n.outputs })
      gates.set(id, list)
    }
  }
  return gates
}

export function createEngine(deps: EngineDeps) {
  const live = new Map<string, LiveRun>()
  const locks = new Map<string, Promise<unknown>>()
  const wakers = new Map<string, () => void>()
  const limiter = createLimiter(deps.perUserLimit)
  const publish = (run: RunRecord, m: RunnerMessage) => deps.events.publish(userKeyOf(run.userId), m)

  function entryFor(run: RunRecord): LiveRun {
    let e = live.get(run.id)
    if (!e) {
      e = { run, ctl: new AbortController(), legPromise: null, saving: Promise.resolve() }
      live.set(run.id, e)
    }
    return e
  }

  async function loadEntry(runId: string): Promise<LiveRun | null> {
    const e = live.get(runId)
    if (e) return e
    const run = await deps.store.get(runId)
    return run ? entryFor(run) : null
  }

  /** Save a snapshot of the run; saves of one run land in order. */
  function persist(run: RunRecord): Promise<void> {
    run.updatedAt = deps.now()
    const snap = JSON.parse(JSON.stringify(run)) as RunRecord
    const e = entryFor(run)
    e.saving = e.saving.catch(() => {}).then(() => deps.store.save(snap))
    return e.saving
  }

  function withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(runId) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(fn)
    locks.set(runId, next)
    return next.finally(() => { if (locks.get(runId) === next) locks.delete(runId) })
  }

  async function sleepOrWake(ms: number, requestId: string, runSignal: AbortSignal): Promise<void> {
    if (runSignal.aborted) return
    const ctl = new AbortController()
    const wake = () => ctl.abort()
    wakers.set(requestId, wake)
    runSignal.addEventListener('abort', wake, { once: true })
    try { await deps.sleep(ms, ctl.signal) }
    finally {
      runSignal.removeEventListener('abort', wake)
      if (wakers.get(requestId) === wake) wakers.delete(requestId)
    }
  }

  // ── Opening a leg: price, hold, write down ─────────────────────────────
  async function openLeg(run: RunRecord, action: LegAction, gateId: string | null, takeIdx: number[]): Promise<LegRecord> {
    const index = run.legs.length
    const legId = `${run.id}.${index}`
    const charges: StageCharge[] = []
    let baseAssigned = false
    try {
      for (const t of takeIdx) {
        const take = run.takes[t]!
        const nodes = legNodes(take.prompt, gateStateOf(take))
        const includesBase = !run.baseCharged && !baseAssigned && hasOutputNode(take.prompt)
        if (includesBase) baseAssigned = true
        let estimate: number
        try { estimate = stageEstimate(take.prompt, nodes, includesBase) }
        catch (e) {
          if (e instanceof UnpricedGraphError) throw refuse('A model in this workflow has no price yet', 500)
          throw e
        }
        const stageKey = stageKeyOf(legId, t)
        const holdId = await deps.metering.hold(run.userId, stageKey, estimate)
        charges.push({ stageKey, leg: index, take: t, estimate, includesBase, holdId, state: holdId == null ? 'free' : 'held', actual: null, finished: false })
      }
    }
    catch (e) {
      for (const c of charges) await deps.metering.finish(run.userId, c, 0).catch(() => {})
      throw e
    }
    const leg: LegRecord = { index, id: legId, action, gateId, takes: takeIdx, status: 'running', startedAt: deps.now(), endedAt: null }
    run.legs.push(leg)
    run.charges.push(...charges)
    run.status = 'running'
    run.stopRequested = false
    return leg
  }

  function launch(run: RunRecord, leg: LegRecord): void {
    const e = entryFor(run)
    e.run = run
    if (e.ctl.signal.aborted) e.ctl = new AbortController()
    const signal = e.ctl.signal
    e.legPromise = runLeg(run, leg, signal).catch((err) => {
      deps.reportError(err, { site: 'runner.leg', runId: run.id, legId: leg.id })
    })
  }

  // ── Running a leg ──────────────────────────────────────────────────────
  async function runLeg(run: RunRecord, leg: LegRecord, signal: AbortSignal): Promise<void> {
    const outcomes = await Promise.all(leg.takes.map(t => runTakeLeg(run, run.takes[t]!, leg, signal)))
    leg.status = 'done'
    leg.endedAt = deps.now()
    const gates = pausedChoices(run)
    let status: RunStatus
    if (gates.size) status = 'paused'
    else if (run.stopRequested || outcomes.includes('stopped')) status = 'stopped'
    else if (outcomes.length && outcomes.every(o => o === 'error')) status = 'error'
    else status = 'done'
    run.status = status
    await persist(run)
    for (const [gateId, choices] of gates) {
      publish(run, ev.gatePaused(leg.id, run.id, gateId, choices, choices.length === 1 ? [choices[0]!.take] : []))
    }
  }

  function takeOutcome(take: TakeRecord, legIndex: number): TakeOutcome {
    const ns = Object.values(take.nodes).filter(n => n.leg === legIndex)
    if (ns.some(n => n.status === 'stopped')) return 'stopped'
    if (ns.some(n => n.status === 'error')) return 'error'
    if (ns.some(n => n.status === 'paused')) return 'paused'
    return 'done'
  }

  async function runTakeLeg(run: RunRecord, take: TakeRecord, leg: LegRecord, signal: AbortSignal): Promise<TakeOutcome> {
    const stageKey = stageKeyOf(leg.id, take.index)
    const charge = run.charges.find(c => c.stageKey === stageKey)!
    if (charge.finished) return takeOutcome(take, leg.index)

    publish(run, ev.start(stageKey))
    const nodes = legNodes(take.prompt, gateStateOf(take))
    for (const id of nodes) {
      const rec = take.nodes[id]!
      if (rec.status !== 'running') rec.status = 'waiting'
      rec.leg = leg.index
    }

    const pending = new Set(nodes)
    const inflight = new Map<string, Promise<void>>()
    const failed = (id: string) => FINISHED_BADLY.has(take.nodes[id]!.status)
    while (pending.size || inflight.size) {
      for (const id of [...pending]) {
        const deps_ = dependenciesOf(take.prompt, id).filter(d => nodes.has(d))
        if (deps_.some(failed)) {
          pending.delete(id)
          const rec = take.nodes[id]!
          rec.status = 'skipped'
          rec.error = 'An earlier step did not finish'
          continue
        }
        if (deps_.some(d => pending.has(d) || inflight.has(d))) continue
        pending.delete(id)
        inflight.set(id, execNode(run, take, leg, id, signal))
      }
      if (!inflight.size) {
        for (const id of pending) take.nodes[id]!.status = 'skipped'
        break
      }
      const doneId = await Promise.race([...inflight].map(([id, p]) => p.then(() => id)))
      inflight.delete(doneId)
    }

    // Charge exactly what was made (reused results are free); the flat
    // render credit rides on the first stage that makes something.
    const legIds = [...nodes]
    let actual = legIds
      .filter(id => take.nodes[id]!.status === 'done' && !take.nodes[id]!.reused)
      .reduce((s, id) => s + take.nodes[id]!.credits, 0)
    if (charge.includesBase && actual > 0) {
      actual += BASE_RENDER_CREDITS
      run.baseCharged = true
    }
    try { await deps.metering.finish(run.userId, charge, actual) }
    catch (e) {
      charge.finished = true
      deps.reportError(e, { site: 'runner.finish', stageKey, actual })
    }
    await persist(run)

    const outcome = takeOutcome(take, leg.index)
    const credits = deps.hosted() ? (charge.actual ?? 0) : null
    const outputs: OutputFile[] = []
    for (const id of legIds) {
      const rec = take.nodes[id]!
      if (rec.status === 'done' && GENERATORS.has(rec.classType)) outputs.push(...rec.outputs.filter(f => f.type === 'output'))
    }
    if (outputs.length) {
      const nodeTypes = [...new Set(legIds.filter(id => take.nodes[id]!.status === 'done').map(id => take.nodes[id]!.classType))]
      await deps.records.write({ run, take, leg, charge, outputs, nodeTypes, ts: deps.now() })
        .catch(e => deps.reportError(e, { site: 'runner.record', stageKey }))
    }
    if (outcome === 'error') {
      const [id, rec] = Object.entries(take.nodes).find(([i, n]) => nodes.has(i) && n.status === 'error')!
      publish(run, ev.error(stageKey, id, rec.classType, rec.error ?? 'Something went wrong', { runId: run.id, credits }))
    }
    else {
      publish(run, ev.success(stageKey, { runId: run.id, credits, stopped: outcome === 'stopped' }))
    }
    return outcome
  }

  async function execNode(run: RunRecord, take: TakeRecord, leg: LegRecord, id: string, signal: AbortSignal): Promise<void> {
    const rec: NodeRecord = take.nodes[id]!
    const stageKey = stageKeyOf(leg.id, take.index)
    const userKey = userKeyOf(run.userId)
    try {
      if (signal.aborted) throw new RunStopped()
      const resuming = rec.status === 'running' && !!rec.request
      rec.status = 'running'
      rec.error = null
      if (!resuming) rec.startedAt = deps.now()
      await persist(run)
      publish(run, ev.executing(stageKey, id))

      const plan = await planNode({
        prompt: take.prompt,
        nodeId: id,
        filesFrom: ([from]) => take.nodes[from]?.outputs ?? [],
        toUrl: f => deps.handoff.toUrl(f),
        gateOpen: take.openGates.includes(id),
      })
      if (plan.kind === 'pass') {
        rec.outputs = plan.files
        rec.status = 'done'
        rec.endedAt = deps.now()
        await persist(run)
        if (plan.ui) publish(run, ev.executed(stageKey, id, plan.ui))
        return
      }
      if (plan.kind === 'pause') {
        rec.outputs = plan.files
        rec.status = 'paused'
        rec.endedAt = deps.now()
        await persist(run)
        return
      }

      rec.endpoint = plan.endpoint
      rec.payload = plan.payload
      rec.credits = nodeCredits(take.prompt[id]!)
      const fp = isReusable(plan.payload) ? requestFingerprint(plan.endpoint, plan.payload, u => deps.handoff.hashOf(u)) : null
      rec.fingerprint = fp

      if (fp && !rec.request) {
        const prior = await deps.store.getResult(userKey, fp)
        if (prior?.length && (await Promise.all(prior.map(f => deps.results.exists(f)))).every(Boolean)) {
          for (const f of prior) await deps.metering.addOutput(run.userId, stageKey, f)
          rec.outputs = prior
          rec.reused = true
          rec.status = 'done'
          rec.endedAt = deps.now()
          await persist(run)
          const ui = plan.uiFor(prior)
          if (ui) publish(run, ev.executed(stageKey, id, ui))
          return
        }
      }
      rec.reused = false

      await limiter.acquire(userKey, signal)
      let result: unknown
      try {
        if (!rec.request) {
          const sub = await deps.fal.submit(plan.endpoint, plan.payload, { webhookUrl: deps.webhookUrl() })
          rec.request = {
            requestId: sub.requestId, statusUrl: sub.statusUrl, responseUrl: sub.responseUrl,
            cancelUrl: sub.cancelUrl, submittedAt: deps.now(), queuePosition: sub.queuePosition,
          }
          await persist(run)
        }
        result = await waitForResult(run, rec, stageKey, id, plan.media, signal)
      }
      finally {
        limiter.release(userKey)
      }

      const urls = plan.media === 'image' ? falImageUrls(result) : [falVideoUrl(result)].filter((u): u is string => !!u)
      if (!urls.length) throw new Error(plan.media === 'image' ? 'The provider returned no image' : 'The provider returned no video')
      const files: OutputFile[] = []
      for (const url of urls) {
        const { bytes, contentType } = await deps.download(url)
        const file = await deps.results.save(bytes, {
          userId: run.userId, prefix: plan.prefix, ext: extFor(contentType, url, plan.media === 'image' ? 'png' : 'mp4'),
        })
        await deps.metering.addOutput(run.userId, stageKey, file)
        files.push(file)
      }
      rec.outputs = files
      rec.status = 'done'
      rec.endedAt = deps.now()
      if (fp) await deps.store.putResult(userKey, fp, files).catch(e => deps.reportError(e, { site: 'runner.putResult' }))
      await persist(run)
      const ui = plan.uiFor(files)
      if (ui) publish(run, ev.executed(stageKey, id, ui))
    }
    catch (e) {
      if (e instanceof RunStopped || signal.aborted) { rec.status = 'stopped'; rec.error = null }
      else { rec.status = 'error'; rec.error = plainError(e) }
      rec.endedAt = deps.now()
      await persist(run).catch(() => {})
    }
  }

  async function waitForResult(run: RunRecord, rec: NodeRecord, stageKey: string, nodeId: string, media: 'image' | 'video', signal: AbortSignal): Promise<unknown> {
    const req = rec.request!
    const deadline = req.submittedAt + (media === 'video' ? deps.timeouts.videoMs : deps.timeouts.imageMs)
    let attempt = 0
    let lastPos: number | null = req.queuePosition
    let lastPct = -1
    let started = false
    if (lastPos != null && lastPos > 0) publish(run, ev.queuePosition(stageKey, nodeId, lastPos))
    for (;;) {
      if (signal.aborted) throw new RunStopped()
      if (deps.now() > deadline) {
        await deps.fal.cancel(req.cancelUrl).catch(() => {})
        throw new Error(media === 'video'
          ? 'The video took longer than 30 minutes, so it was cancelled'
          : 'The image took longer than 5 minutes, so it was cancelled')
      }
      const s = await deps.fal.status(req.statusUrl, { logs: started })
      if (!s.transient) {
        if (s.status === 'IN_QUEUE') {
          if (s.queuePosition != null && s.queuePosition !== lastPos) {
            lastPos = s.queuePosition
            req.queuePosition = lastPos
            publish(run, ev.queuePosition(stageKey, nodeId, lastPos))
          }
        }
        else if (s.status === 'IN_PROGRESS') {
          if (!started) {
            started = true
            req.queuePosition = null
            if (lastPos != null) publish(run, ev.queuePosition(stageKey, nodeId, 0)) // 0 = started
            lastPos = null
          }
          const pct = percentFromLogs(s.logs)
          if (pct != null && pct !== lastPct) {
            lastPct = pct
            publish(run, ev.progress(stageKey, nodeId, pct))
          }
        }
        else if (s.status === 'COMPLETED') {
          if (s.error) throw new Error(s.error)
          return await deps.fal.result(req.responseUrl)
        }
        else {
          throw new Error(`The provider stopped this request (${s.status})`)
        }
      }
      await sleepOrWake(deps.pollDelayMs(attempt++), req.requestId, signal)
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────
  async function startRun(i: StartRunInput): Promise<LegStarted> {
    const takes = i.takes
    if (!Array.isArray(takes) || !takes.length) throw refuse('There is nothing to run', 400)
    if (takes.length > deps.maxTakes) throw refuse(`At most ${deps.maxTakes} versions can run at once`, 400)
    for (const p of takes) {
      if (!p || typeof p !== 'object' || !isRunnerEligible(p as ApiPrompt)) throw refuse('This workflow can’t run on the Sailor runner', 400)
    }
    const prompts = takes as ApiPrompt[]
    await deps.metering.spendGuard(i.userId)
    const files = new Map<string, OutputFile>()
    for (const p of prompts) for (const f of collectInputFiles(p)) files.set(`${f.type}:${f.subfolder}:${f.filename}`, f)
    await assertFilesOwned([...files.values()], i.userId, deps.hosted(), deps.ownership)
    await deps.metering.moderate(prompts)

    const now = deps.now()
    const run: RunRecord = {
      id: `run_${deps.newId()}`,
      userId: i.userId,
      canvasId: i.canvasId,
      projectUuid: i.projectUuid,
      projectName: i.projectName,
      workflow: i.workflow ?? null,
      createdAt: now,
      updatedAt: now,
      status: 'running',
      takes: prompts.map((prompt, index) => ({
        index,
        prompt: JSON.parse(JSON.stringify(prompt)) as ApiPrompt,
        nodes: Object.fromEntries(Object.entries(prompt).map(([id, n]) => [id, emptyNodeRecord(n.class_type)])),
        openGates: [],
        droppedGates: [],
      })),
      legs: [],
      charges: [],
      baseCharged: false,
      stopRequested: false,
    }
    const leg = await openLeg(run, 'run', null, run.takes.map(t => t.index))
    await persist(run)
    launch(run, leg)
    return { runId: run.id, legId: leg.id, promptIds: leg.takes.map(t => stageKeyOf(leg.id, t)) }
  }

  function nudge(requestId: string): boolean {
    const w = wakers.get(requestId)
    if (!w) return false
    w()
    return true
  }

  async function settled(runId: string): Promise<void> {
    for (;;) {
      const p = live.get(runId)?.legPromise
      if (!p) return
      await p
      if (live.get(runId)?.legPromise === p) return
    }
  }

  // Task 13 fills in gateAction, stop, reattach, pausedGates, snapshot and record.
  return { startRun, nudge, settled, events: deps.events }
}

export type Engine = ReturnType<typeof createEngine>
```

Some imports and helpers (`withRunLock`, `loadEntry`, `upstreamStage`, `downstreamNodes`, `GATE_CLASS`, `extractGraphPromptText`, `runIdOf`) are only used from Task 13 on. Leave them in; the project's TypeScript settings do not treat unused names as errors.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/runner-engine.unit.spec.ts`
Expected: PASS. If a test hangs, the likely cause is a node that never leaves `pending` — check `runTakeLeg`'s loop, not the test.

- [ ] **Step 6: Commit** (controller)

Paths: `frontend/server/runner/engine.ts frontend/tests/unit/__runner__/kit.ts frontend/tests/unit/runner-engine.unit.spec.ts`
Message: `feat(runner): the engine — legs, parallel nodes, polling, reuse and per-stage charging`

---

### Task 13: Gate buttons, pick-at-the-Gate, Stop, restart recovery, and lookups

**Files:**
- Modify: `frontend/server/runner/engine.ts`
- Test: `frontend/tests/unit/runner-gate.unit.spec.ts`

**Interfaces:**
- Consumes: Task 12's engine internals (`entryFor`, `loadEntry`, `persist`, `withRunLock`, `openLeg`, `launch`, `pausedChoices`, `live`, `wakers`).
- Produces: the methods listed as "(Task 13)" in Task 12's Interfaces block, plus exported `applyGateAction`.

- [ ] **Step 1: Write the failing test**

`frontend/tests/unit/runner-gate.unit.spec.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { makeKit, gatedFlow, createFakeFal, createFakeLedger, ofType, until } from './__runner__/kit'

async function pausedRun(k: ReturnType<typeof makeKit>, takes = [gatedFlow({ imageSeed: 7 })]) {
  const started = await k.engine.startRun({ userId: k.userId, takes, workflow: { nodes: ['as run'] }, canvasId: 'c1', projectUuid: null, projectName: null })
  await k.engine.settled(started.runId)
  return started
}

describe('Continue', () => {
  it('runs the video from the saved picture and charges only the video', async () => {
    const k = makeKit({ hosted: true })
    const { runId } = await pausedRun(k)
    const next = await k.engine.gateAction({ userId: 'user_1', runId, gateId: '2', action: 'continue' })
    expect(next.legId).toBe(`${runId}.1`)
    await k.engine.settled(runId)
    const video = k.fal.submitted()[1]!
    expect(video.endpoint).toBe('minimax/h3/image-to-video')
    expect(video.payload.image_url).toMatch(/^https:\/\/fal\.storage\/generate_image_00001_\.png$/)
    expect(k.ledger.hold).toHaveBeenLastCalledWith('user_1', 45, `runner:${next.promptIds[0]}`)
    expect(ofType(k.seen, 'executed').some(m => m.data.node === '4')).toBe(true)
    expect((await k.store.get(runId))!.status).toBe('done')
    // image once, video once
    expect([...k.ledger.holds.values()].map(h => [h.state, h.actual])).toEqual([['settled', 2], ['settled', 45]])
  })

  it('works after a server restart', async () => {
    const k1 = makeKit()
    const { runId } = await pausedRun(k1)
    const k2 = makeKit({ dir: k1.dir, root: k1.root, fal: k1.fal })
    await k2.engine.gateAction({ userId: null, runId, gateId: '2', action: 'continue' })
    await k2.engine.settled(runId)
    expect(k1.fal.submitted()).toHaveLength(2)
    expect((await k2.store.get(runId))!.status).toBe('done')
  })

  it('refuses while the run is still going, and for a node that is not a Gate', async () => {
    const k = makeKit()
    k.fal.holdNext(1)
    const { runId } = await k.engine.startRun({ userId: null, takes: [gatedFlow()], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await until(() => k.fal.submitted().length === 1)
    await expect(k.engine.gateAction({ userId: null, runId, gateId: '2', action: 'continue' })).rejects.toMatchObject({ statusCode: 409 })
    k.fal.release()
    await k.engine.settled(runId)
    await expect(k.engine.gateAction({ userId: null, runId, gateId: '1', action: 'continue' })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('someone else’s run is not found', async () => {
    const k = makeKit({ hosted: true })
    const { runId } = await pausedRun(k)
    await expect(k.engine.gateAction({ userId: 'user_2', runId, gateId: '2', action: 'continue' })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('not enough credits: says how many, and the run stays paused', async () => {
    const ledger = createFakeLedger(10) // image stage costs 2, video 45
    const k = makeKit({ hosted: true, ledger })
    const { runId } = await pausedRun(k)
    await expect(k.engine.gateAction({ userId: 'user_1', runId, gateId: '2', action: 'continue' }))
      .rejects.toMatchObject({ statusCode: 402, data: { required: 45, available: 8 } })
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('paused')
    expect(run.takes[0]!.nodes['2']!.status).toBe('paused')
    expect(run.legs).toHaveLength(1)
  })
})

describe('Redo and Restart', () => {
  it('Redo re-makes the picture with the next seed and pauses again', async () => {
    const k = makeKit()
    const { runId } = await pausedRun(k)
    await k.engine.gateAction({ userId: null, runId, gateId: '2', action: 'redo' })
    await k.engine.settled(runId)
    expect(k.fal.submitted().map(r => [r.endpoint, r.payload.seed])).toEqual([['fal-ai/flux/schnell', 7], ['fal-ai/flux/schnell', 8]])
    expect(ofType(k.seen, 'gate_paused')).toHaveLength(2)
    expect((await k.store.get(runId))!.takes[0]!.prompt['1']!.inputs.seed).toBe(8)
  })
  it('Redo leaves a random seed random', async () => {
    const k = makeKit()
    const { runId } = await pausedRun(k, [gatedFlow({ imageSeed: 0 })])
    await k.engine.gateAction({ userId: null, runId, gateId: '2', action: 'redo' })
    await k.engine.settled(runId)
    expect(k.fal.submitted().map(r => r.payload.seed)).toEqual([undefined, undefined])
  })
  it('Restart throws everything away and runs from the start', async () => {
    const k = makeKit()
    const { runId } = await pausedRun(k, [gatedFlow({ imageSeed: 0 })])
    await k.engine.gateAction({ userId: null, runId, gateId: '2', action: 'continue' })
    await k.engine.settled(runId)
    await k.engine.gateAction({ userId: null, runId, gateId: '2', action: 'restart' })
    await k.engine.settled(runId)
    expect(k.fal.submitted().map(r => r.endpoint)).toEqual(['fal-ai/flux/schnell', 'minimax/h3/image-to-video', 'fal-ai/flux/schnell'])
    expect((await k.store.get(runId))!.status).toBe('paused')
  })
})

describe('Continue after the run has finished', () => {
  it('makes another video from the same picture, without re-making the picture', async () => {
    const k = makeKit()
    const { runId } = await pausedRun(k, [gatedFlow({ imageSeed: 7, videoSeed: 3 })])
    await k.engine.gateAction({ userId: null, runId, gateId: '2', action: 'continue' })
    await k.engine.settled(runId)
    const again = await k.engine.gateAction({ userId: null, runId, gateId: '2', action: 'continue' })
    await k.engine.settled(runId)
    const sent = k.fal.submitted()
    expect(sent.map(r => r.endpoint)).toEqual(['fal-ai/flux/schnell', 'minimax/h3/image-to-video', 'minimax/h3/image-to-video'])
    expect(sent[2]!.payload.seed).toBe(4)
    expect(sent[2]!.payload.image_url).toBe(sent[1]!.payload.image_url)
    const run = (await k.store.get(runId))!
    expect(run.legs.at(-1)).toMatchObject({ id: again.legId, action: 'again' })
  })
})

describe('Pick at the Gate', () => {
  it('Continue with two of four ticked runs two videos and charges for two', async () => {
    const k = makeKit({ hosted: true })
    const { runId } = await pausedRun(k, [1, 2, 3, 4].map(s => gatedFlow({ imageSeed: s })))
    await expect(k.engine.gateAction({ userId: 'user_1', runId, gateId: '2', action: 'continue' })).rejects.toMatchObject({ statusCode: 400 })
    const next = await k.engine.gateAction({ userId: 'user_1', runId, gateId: '2', action: 'continue', takes: [1, 3] })
    expect(next.promptIds).toEqual([`${runId}.1.t1`, `${runId}.1.t3`])
    await k.engine.settled(runId)
    const videos = k.fal.submitted().filter(r => r.endpoint.startsWith('minimax'))
    expect(videos).toHaveLength(2)
    const videoHolds = [...k.ledger.holds.values()].filter(h => h.key.includes('.1.'))
    expect(videoHolds.map(h => h.credits)).toEqual([45, 45])
    const run = (await k.store.get(runId))!
    expect(run.takes.map(t => t.nodes['2']!.status)).toEqual(['dropped', 'done', 'dropped', 'done'])
    expect(run.status).toBe('done')
  })
  it('Redo re-makes all four', async () => {
    const k = makeKit()
    // Seeds far apart: after Redo's +1 none matches another take's earlier
    // request, which would (correctly) be reused instead of sent.
    const { runId } = await pausedRun(k, [10, 20, 30, 40].map(s => gatedFlow({ imageSeed: s })))
    await k.engine.gateAction({ userId: null, runId, gateId: '2', action: 'redo' })
    await k.engine.settled(runId)
    expect(k.fal.submitted()).toHaveLength(8)
  })
})

describe('Stop', () => {
  it('cancels at fal, drops the hold for the unfinished stage and keeps what was made', async () => {
    const k = makeKit({ hosted: true })
    const { runId } = await pausedRun(k)
    k.fal.holdNext(1)
    const next = await k.engine.gateAction({ userId: 'user_1', runId, gateId: '2', action: 'continue' })
    await until(() => k.fal.submitted().length === 2)
    const res = await k.engine.stop('user_1')
    expect(res.stopped).toEqual([runId])
    await k.engine.settled(runId)
    expect(k.fal.client.cancel).toHaveBeenCalledWith(`fal://${k.fal.submitted()[1]!.id}/cancel`)
    const holds = [...k.ledger.holds.values()]
    expect(holds.map(h => h.state)).toEqual(['settled', 'released'])
    const done = ofType(k.seen, 'execution_success').find(m => m.data.prompt_id === next.promptIds[0])!
    expect(done.data).toMatchObject({ stopped: true, credits: 0 })
    expect((await k.store.get(runId))!.status).toBe('stopped')
  })
  it('only stops your own runs', async () => {
    const k = makeKit({ hosted: true })
    k.fal.holdNext(1)
    const { runId } = await k.engine.startRun({ userId: 'user_1', takes: [gatedFlow()], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await until(() => k.fal.submitted().length === 1)
    expect((await k.engine.stop('user_2')).stopped).toEqual([])
    k.fal.release()
    await k.engine.settled(runId)
  })
})

describe('restart recovery', () => {
  it('a restarted server asks fal about the request it already sent, and charges once', async () => {
    const fal = createFakeFal()
    const ledger = createFakeLedger()
    // k1 "crashes" by never waking from its next sleep — it stops polling and saving.
    let crashed = false
    const k1 = makeKit({
      hosted: true, fal, ledger,
      deps: { sleep: () => (crashed ? new Promise<void>(() => {}) : new Promise<void>(r => setTimeout(r, 1))) },
    })
    fal.holdNext(1)
    const { runId } = await k1.engine.startRun({ userId: 'user_1', takes: [gatedFlow()], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await until(() => fal.submitted().length === 1)
    await until(() => fal.submitted()[0]!.polls >= 2)
    crashed = true
    await new Promise(r => setTimeout(r, 20))
    // A new engine reads the same storage.
    const k2 = makeKit({ hosted: true, dir: k1.dir, root: k1.root, fal, ledger })
    expect(await k2.engine.reattach()).toBe(1)
    fal.release()
    await k2.engine.settled(runId)
    expect(fal.submitted()).toHaveLength(1)
    expect(ledger.hold).toHaveBeenCalledTimes(1)
    expect([...ledger.holds.values()].map(h => h.state)).toEqual(['settled'])
    expect((await k2.store.get(runId))!.status).toBe('paused')
    expect(ofType(k2.seen, 'gate_paused')).toHaveLength(1)
  })
})

describe('the webhook wakes a waiting poll', () => {
  it('nudge cuts the wait short', async () => {
    const k = makeKit({
      deps: {
        pollDelayMs: () => 60_000,
        sleep: (ms, signal) => new Promise<void>((resolve) => {
          const t = setTimeout(resolve, ms)
          signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
        }),
      },
    })
    const { runId } = await k.engine.startRun({ userId: null, takes: [gatedFlow()], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await until(() => (k.fal.submitted()[0]?.polls ?? 0) === 1)
    expect(k.engine.nudge(k.fal.submitted()[0]!.id)).toBe(true)
    await until(() => ofType(k.seen, 'gate_paused').length === 1, 1000)
    expect(k.engine.nudge('req-unknown')).toBe(false)
    await k.engine.settled(runId)
  })
})

describe('lookups', () => {
  it('lists paused Gates for a canvas and replays them to a new tab', async () => {
    const k = makeKit()
    const { runId, legId } = await pausedRun(k)
    const gates = await k.engine.pausedGates(null, 'c1')
    expect(gates).toEqual([{ runId, promptId: legId, nodeId: '2', choices: [{ take: 0, files: [{ filename: 'generate_image_00001_.png', subfolder: '', type: 'output' }] }], picked: [0] }])
    expect(await k.engine.pausedGates(null, 'c2')).toEqual([])
    expect(k.engine.snapshot(null).map(m => m.type)).toEqual(['gate_paused'])
  })
  it('returns the exact workflow and cost behind a result', async () => {
    const k = makeKit({ hosted: true })
    const { runId, promptIds } = await pausedRun(k)
    const rec = await k.engine.record('user_1', promptIds[0]!)
    expect(rec).toMatchObject({ runId, promptId: promptIds[0], workflow: { nodes: ['as run'] }, credits: 2, prompt: 'a red fox', nodeTypes: ['GenerateImageNode', 'ComfyGateNode', 'Image'] })
    expect(await k.engine.record('user_2', promptIds[0]!)).toBeNull()
    expect(await k.engine.record('user_1', 'not-a-run')).toBeNull()
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/runner-gate.unit.spec.ts`
Expected: FAIL — `gateAction is not a function`.

- [ ] **Step 3: Implement**

In `frontend/server/runner/engine.ts`, add this exported function above `createEngine`:
```ts
/** Applies a Gate button to a copy of the run. Pure; throws a refusal the browser can show. */
export function applyGateAction(
  run: RunRecord,
  gateId: string,
  action: GateActionName,
  picked: number[] | undefined,
): { legAction: LegAction; legTakes: number[] } {
  const paused = run.takes.filter(t => t.nodes[gateId]?.status === 'paused').map(t => t.index)
  // Resetting a node also resets everything that read from it (an Image card
  // showing the old picture), the way ComfyUI re-runs a changed node's dependents.
  const reset = (take: TakeRecord, ids: Iterable<string>) => {
    const all = new Set(ids)
    let grew = true
    while (grew) {
      grew = false
      for (const id of Object.keys(take.prompt)) {
        if (!all.has(id) && dependenciesOf(take.prompt, id).some(d => all.has(d))) { all.add(id); grew = true }
      }
    }
    for (const id of all) take.nodes[id] = emptyNodeRecord(take.prompt[id]!.class_type)
  }
  // Server.py's Redo rule, with the spec's one change: 0 means random and stays 0.
  const bumpSeeds = (take: TakeRecord, ids: Iterable<string>) => {
    for (const id of ids) {
      const inputs = take.prompt[id]!.inputs
      for (const k of ['seed', 'noise_seed']) {
        const v = inputs[k]
        if (typeof v === 'number' && Number.isInteger(v) && v > 0) inputs[k] = v + 1
      }
    }
  }

  if (action === 'continue') {
    if (paused.length) {
      const wanted = picked ?? (paused.length === 1 ? paused : [])
      const chosen = [...new Set(wanted)].filter(i => paused.includes(i)).sort((a, b) => a - b)
      if (!chosen.length) throw refuse('Tick at least one picture to continue with', 400)
      for (const i of paused) {
        const take = run.takes[i]!
        if (chosen.includes(i)) {
          if (!take.openGates.includes(gateId)) take.openGates.push(gateId)
          take.droppedGates = take.droppedGates.filter(g => g !== gateId)
          take.nodes[gateId]!.status = 'done'
        }
        else {
          if (!take.droppedGates.includes(gateId)) take.droppedGates.push(gateId)
          take.nodes[gateId]!.status = 'dropped'
        }
      }
      return { legAction: 'continue', legTakes: chosen }
    }
    // Continue after the run finished: everything after the Gate again, from the kept picture.
    const passed = run.takes
      .filter(t => t.openGates.includes(gateId) && t.nodes[gateId]?.status === 'done')
      .map(t => t.index)
    const chosen = [...new Set(picked ?? passed)].filter(i => passed.includes(i)).sort((a, b) => a - b)
    if (!chosen.length) throw refuse('There is nothing past this Gate to run again', 409)
    for (const i of chosen) {
      const take = run.takes[i]!
      const down = downstreamNodes(take.prompt, gateId)
      reset(take, down)
      bumpSeeds(take, down)
    }
    return { legAction: 'again', legTakes: chosen }
  }

  if (action === 'redo') {
    if (!paused.length) throw refuse('Redo works while the Gate is paused', 409)
    for (const i of paused) {
      const take = run.takes[i]!
      const stage = upstreamStage(take.prompt, gateId)
      reset(take, [...stage, gateId])
      bumpSeeds(take, stage)
    }
    return { legAction: 'redo', legTakes: paused }
  }

  // restart
  for (const take of run.takes) {
    reset(take, Object.keys(take.prompt))
    take.openGates = []
    take.droppedGates = []
  }
  return { legAction: 'restart', legTakes: run.takes.map(t => t.index) }
}
```

Inside `createEngine`, before `return`, add:
```ts
  async function gateAction(i: GateActionInput): Promise<LegStarted> {
    return withRunLock(i.runId, async () => {
      const entry = await loadEntry(i.runId)
      if (!entry || entry.run.userId !== i.userId) throw refuse('Run not found', 404)
      const run = entry.run
      if (run.legs.some(l => l.status === 'running')) throw refuse('This run is still going', 409)
      if (run.takes[0]?.prompt[i.gateId]?.class_type !== GATE_CLASS) throw refuse('That is not a Gate in this run', 400)
      if (!['continue', 'redo', 'restart'].includes(i.action)) throw refuse('Unknown Gate action', 400)

      // Work on a copy: if the hold is refused, the run is exactly as it was.
      const draft = JSON.parse(JSON.stringify(run)) as RunRecord
      const { legAction, legTakes } = applyGateAction(draft, i.gateId, i.action, i.takes)
      await deps.metering.spendGuard(i.userId)
      await deps.metering.moderate(legTakes.map(t => draft.takes[t]!.prompt))
      const leg = await openLeg(draft, legAction, i.gateId, legTakes)
      entry.run = draft
      await persist(draft)
      launch(draft, leg)
      return { runId: draft.id, legId: leg.id, promptIds: leg.takes.map(t => stageKeyOf(leg.id, t)) }
    })
  }

  async function stop(userId: string | null, runIds?: string[]): Promise<{ stopped: string[] }> {
    const targets = [...live.values()].filter(e =>
      e.run.userId === userId
      && e.run.legs.some(l => l.status === 'running')
      && (!runIds || runIds.includes(e.run.id)))
    for (const e of targets) {
      e.run.stopRequested = true
      e.ctl.abort()
      const cancels: Promise<unknown>[] = []
      for (const t of e.run.takes) {
        for (const n of Object.values(t.nodes)) {
          if (n.status === 'running' && n.request) cancels.push(deps.fal.cancel(n.request.cancelUrl).catch(() => {}))
        }
      }
      await Promise.all(cancels)
    }
    await Promise.all(targets.map(e => e.legPromise))
    return { stopped: targets.map(e => e.run.id) }
  }

  /** Server start: pick up every run that was mid-leg. Paused runs need nothing. */
  async function reattach(): Promise<number> {
    let n = 0
    for (const run of await deps.store.listActive()) {
      if (live.has(run.id)) continue
      const leg = run.legs.find(l => l.status === 'running')
      if (!leg) continue
      entryFor(run)
      launch(run, leg)
      n++
    }
    return n
  }

  function gatesOf(run: RunRecord): PausedGate[] {
    const legId = run.legs.at(-1)?.id ?? `${run.id}.0`
    return [...pausedChoices(run)].map(([nodeId, choices]) => ({
      runId: run.id, promptId: legId, nodeId, choices, picked: choices.length === 1 ? [choices[0]!.take] : [],
    }))
  }

  async function pausedGates(userId: string | null, canvasId: string | null): Promise<PausedGate[]> {
    if (!canvasId) return []
    const stored = await deps.store.listForUser(userId, { canvasId, statuses: ['paused'] })
    return stored.flatMap(r => gatesOf(live.get(r.id)?.run ?? r))
  }

  /** What a newly connected tab needs to catch up: runs in progress and paused Gates. */
  function snapshot(userId: string | null): RunnerMessage[] {
    const out: RunnerMessage[] = []
    for (const { run } of live.values()) {
      if (run.userId !== userId) continue
      const leg = run.legs.find(l => l.status === 'running')
      if (leg) {
        for (const t of leg.takes) {
          const stageKey = stageKeyOf(leg.id, t)
          if (run.charges.find(c => c.stageKey === stageKey)?.finished) continue
          out.push(ev.start(stageKey))
          for (const [id, n] of Object.entries(run.takes[t]!.nodes)) {
            if (n.status !== 'running') continue
            out.push(ev.executing(stageKey, id))
            if (n.request?.queuePosition) out.push(ev.queuePosition(stageKey, id, n.request.queuePosition))
          }
        }
      }
      else if (run.status === 'paused') {
        for (const g of gatesOf(run)) out.push(ev.gatePaused(g.promptId, run.id, g.nodeId, g.choices, g.picked))
      }
    }
    return out
  }

  async function record(userId: string | null, promptId: string): Promise<RunnerRecordView | null> {
    const runId = runIdOf(promptId)
    if (!runId) return null
    const run = live.get(runId)?.run ?? await deps.store.get(runId)
    if (!run || run.userId !== userId) return null
    const charge = run.charges.find(c => c.stageKey === promptId) ?? null
    const take = run.takes[charge?.take ?? 0]!
    const legIndex = charge?.leg ?? 0
    const ran = Object.entries(take.nodes).filter(([, n]) => n.leg === legIndex)
    const texts = ran
      .filter(([, n]) => GENERATORS.has(n.classType))
      .map(([id]) => extractGraphPromptText({ [id]: take.prompt[id]! }))
      .filter(Boolean)
    return {
      runId,
      promptId,
      workflow: run.workflow,
      createdAt: run.legs[legIndex]?.startedAt ?? run.createdAt,
      endedAt: run.legs[legIndex]?.endedAt ?? null,
      credits: deps.hosted() ? (charge?.actual ?? null) : null,
      prompt: texts[0] ?? null,
      nodeTypes: [...new Set(ran.filter(([, n]) => n.status === 'done' || n.status === 'paused').map(([, n]) => n.classType))],
      projectUuid: run.projectUuid,
      projectName: run.projectName,
    }
  }
```
and change the `return` line to:
```ts
  return { startRun, gateAction, stop, reattach, nudge, pausedGates, snapshot, record, settled, events: deps.events }
```

Note on `record().nodeTypes` order: it follows the order of `take.nodes` keys, which is the prompt's key order (`'1', '2', '5'` for the test flow — numeric-like keys iterate in ascending order), giving `['GenerateImageNode', 'ComfyGateNode', 'Image']`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/runner-gate.unit.spec.ts tests/unit/runner-engine.unit.spec.ts`
Expected: PASS (both files).

- [ ] **Step 5: Commit** (controller)

Paths: `frontend/server/runner/engine.ts frontend/tests/unit/runner-gate.unit.spec.ts`
Message: `feat(runner): Gate buttons, pick at the Gate, Stop, restart recovery and lookups`

---

### Task 14: Generation records, the fal webhook check, and wiring the real engine

**Files:**
- Create: `frontend/server/runner/records.ts`
- Create: `frontend/server/runner/webhook.ts`
- Create: `frontend/server/runner/index.ts`
- Test: `frontend/tests/unit/runner-records-webhook.unit.spec.ts`

**Interfaces:**
- Consumes: `StageRecordSummary`, `createEngine`, `Engine`, `EngineDeps` (Task 12); `isSafeProjectId` (`server/utils/engineGate.ts`); all real utilities named below.
- Produces (records.ts): `toGenerationRecord(s: StageRecordSummary, hosted: boolean): Record<string, unknown>`; `createGenerationRecords(d: { hosted(): boolean; ownerOf(kind: string, id: string): Promise<string | null>; recordOwner(kind: string, id: string, userId: string): Promise<void>; post(uuid: string, body: unknown): Promise<void> }): { write(s: StageRecordSummary): Promise<void> }`.
- Produces (webhook.ts): `interface FalJwk { kty: string; crv: string; x: string }`; `falWebhookMessage(h: { requestId: string; userId: string; timestamp: string }, rawBody: Uint8Array): Buffer`; `verifyFalWebhook(o: { headers: { requestId?: string; userId?: string; timestamp?: string; signature?: string }; rawBody: Uint8Array; keys: FalJwk[]; nowSec: number; toleranceSec?: number }): boolean`; `createJwksCache(fetchKeys?: () => Promise<FalJwk[]>, ttlMs?: number): { keys(): Promise<FalJwk[]> }`; `FAL_JWKS_URL`.
- Produces (index.ts): `getEngine(): Engine`; `__setEngineForTests(e: Engine | null): void`; `pollDelayMs(attempt: number): number`.

- [ ] **Step 1: Write the failing test**

`frontend/tests/unit/runner-records-webhook.unit.spec.ts`:
```ts
import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { toGenerationRecord, createGenerationRecords } from '~~/server/runner/records'
import { verifyFalWebhook, falWebhookMessage, createJwksCache } from '~~/server/runner/webhook'
import { pollDelayMs } from '~~/server/runner/index'
import type { StageRecordSummary } from '~~/server/runner/engine'

function summary(over: Partial<StageRecordSummary['run']> = {}): StageRecordSummary {
  const run: any = { id: 'run_x', userId: 'u1', canvasId: 'c1', projectUuid: 'p-1', projectName: 'Fox', ...over }
  return {
    run,
    take: { index: 0 } as any,
    leg: { index: 0, id: 'run_x.0' } as any,
    charge: { stageKey: 'run_x.0.t0', actual: 2 } as any,
    outputs: [{ filename: 'generate_image_00001_.png', subfolder: '', type: 'output' }, { filename: 'generate_video_00001_.mp4', subfolder: '', type: 'output' }],
    nodeTypes: ['GenerateImageNode', 'Image'],
    ts: 1234,
  }
}

describe('generation records', () => {
  it('carry the stage key, exact credits and the run id', () => {
    expect(toGenerationRecord(summary(), true)).toEqual({
      promptId: 'run_x.0.t0', runId: 'run_x', ts: 1234, canvasId: 'c1',
      outputs: [
        { kind: 'image', filename: 'generate_image_00001_.png', subfolder: '', type: 'output' },
        { kind: 'video', filename: 'generate_video_00001_.mp4', subfolder: '', type: 'output' },
      ],
      usd: null, usdApproximate: false, credits: 2, nodes: ['GenerateImageNode', 'Image'],
    })
    expect(toGenerationRecord(summary(), false).credits).toBeNull()
  })
  it('write to the project, claiming it if nobody owns it yet, never to someone else’s', async () => {
    const post = vi.fn(async () => {})
    const recordOwner = vi.fn(async () => {})
    const owners: Record<string, string | null> = { 'p-1': null, 'p-2': 'u2', 'p-3': 'u1' }
    const r = createGenerationRecords({ hosted: () => true, ownerOf: async (_k, id) => owners[id] ?? null, recordOwner, post })
    await r.write(summary())
    expect(recordOwner).toHaveBeenCalledWith('project', 'p-1', 'u1')
    expect(post).toHaveBeenCalledWith('p-1', { projectName: 'Fox', generation: expect.objectContaining({ promptId: 'run_x.0.t0' }) })
    await r.write(summary({ projectUuid: 'p-2' }))
    await r.write(summary({ projectUuid: 'p-3' }))
    expect(post.mock.calls.map(c => c[0])).toEqual(['p-1', 'p-3'])
    await r.write(summary({ projectUuid: null }))
    await r.write(summary({ projectUuid: '../x' }))
    expect(post).toHaveBeenCalledTimes(2)
  })
})

describe('fal webhook signature', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const jwk = publicKey.export({ format: 'jwk' }) as any
  const keys = [{ kty: jwk.kty, crv: jwk.crv, x: jwk.x }]
  const body = new TextEncoder().encode(JSON.stringify({ request_id: 'r1', status: 'OK' }))
  const h = { requestId: 'r1', userId: 'fal-user', timestamp: '1700000000' }
  const signature = sign(null, falWebhookMessage(h, body), privateKey).toString('hex')

  it('accepts a correctly signed, fresh call', () => {
    expect(verifyFalWebhook({ headers: { ...h, signature }, rawBody: body, keys, nowSec: 1700000100 })).toBe(true)
  })
  it('refuses anything unsigned, altered, stale or from another key', () => {
    expect(verifyFalWebhook({ headers: { ...h }, rawBody: body, keys, nowSec: 1700000100 })).toBe(false)
    expect(verifyFalWebhook({ headers: { ...h, signature }, rawBody: new TextEncoder().encode('{}'), keys, nowSec: 1700000100 })).toBe(false)
    expect(verifyFalWebhook({ headers: { ...h, signature }, rawBody: body, keys, nowSec: 1700000400 })).toBe(false)
    const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as any
    expect(verifyFalWebhook({ headers: { ...h, signature }, rawBody: body, keys: [{ kty: other.kty, crv: other.crv, x: other.x }], nowSec: 1700000100 })).toBe(false)
    expect(verifyFalWebhook({ headers: { ...h, signature: 'zz' }, rawBody: body, keys, nowSec: 1700000100 })).toBe(false)
  })
  it('caches the key list', async () => {
    const fetchKeys = vi.fn(async () => keys)
    const cache = createJwksCache(fetchKeys, 60_000)
    await cache.keys(); await cache.keys()
    expect(fetchKeys).toHaveBeenCalledTimes(1)
  })
})

describe('poll pacing', () => {
  it('ramps from 350ms to a 2s ceiling, like the Python client', () => {
    expect(pollDelayMs(0)).toBe(350)
    expect(pollDelayMs(1)).toBe(525)
    expect(pollDelayMs(10)).toBe(2000)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/runner-records-webhook.unit.spec.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`frontend/server/runner/records.ts`:
```ts
/**
 * The runner writes one generation-history record per finished stage, with
 * the exact charge, into the project's store (served by the engine at
 * /sailor/projects/{uuid}/generations). The browser sees `recorded: true`
 * on the finish event and does not save its own copy.
 */
import { isSafeProjectId } from '../utils/engineGate'
import type { StageRecordSummary } from './engine'

const VIDEO_RE = /\.(mp4|webm|mov|m4v)$/i

export function toGenerationRecord(s: StageRecordSummary, hosted: boolean): Record<string, unknown> {
  return {
    promptId: s.charge.stageKey,
    runId: s.run.id,
    ts: s.ts,
    canvasId: s.run.canvasId,
    outputs: s.outputs.map(o => ({ kind: VIDEO_RE.test(o.filename) ? 'video' : 'image', ...o })),
    usd: null,
    usdApproximate: false,
    credits: hosted ? (s.charge.actual ?? null) : null,
    nodes: s.nodeTypes,
  }
}

export function createGenerationRecords(d: {
  hosted(): boolean
  ownerOf(kind: string, id: string): Promise<string | null>
  recordOwner(kind: string, id: string, userId: string): Promise<void>
  post(uuid: string, body: unknown): Promise<void>
}) {
  return {
    async write(s: StageRecordSummary): Promise<void> {
      const uuid = s.run.projectUuid
      if (!uuid || !isSafeProjectId(uuid)) return
      if (d.hosted()) {
        const userId = s.run.userId
        if (!userId) return
        const owner = await d.ownerOf('project', uuid)
        if (owner && owner !== userId) return
        if (!owner) await d.recordOwner('project', uuid, userId)
      }
      await d.post(uuid, { projectName: s.run.projectName ?? undefined, generation: toGenerationRecord(s, d.hosted()) })
    },
  }
}
```

`frontend/server/runner/webhook.ts`:
```ts
/**
 * fal webhook signatures (https://docs.fal.ai/model-apis/model-endpoints/webhooks):
 * ED25519 over `request_id \n user_id \n timestamp \n sha256hex(body)`, keys
 * from fal's JWKS, timestamp within ±5 minutes. The call only WAKES a poll —
 * the runner still asks fal for the result itself — so a forged call could
 * at worst cause an early status check, and unsigned calls are ignored anyway.
 */
import { createHash, createPublicKey, verify } from 'node:crypto'

export const FAL_JWKS_URL = 'https://rest.fal.ai/.well-known/jwks.json'

export interface FalJwk { kty: string; crv: string; x: string }

export function falWebhookMessage(h: { requestId: string; userId: string; timestamp: string }, rawBody: Uint8Array): Buffer {
  const digest = createHash('sha256').update(rawBody).digest('hex')
  return Buffer.from([h.requestId, h.userId, h.timestamp, digest].join('\n'), 'utf8')
}

export function verifyFalWebhook(o: {
  headers: { requestId?: string; userId?: string; timestamp?: string; signature?: string }
  rawBody: Uint8Array
  keys: FalJwk[]
  nowSec: number
  toleranceSec?: number
}): boolean {
  const { requestId, userId, timestamp, signature } = o.headers
  if (!requestId || !userId || !timestamp || !signature) return false
  const ts = Number(timestamp)
  if (!Number.isInteger(ts) || Math.abs(o.nowSec - ts) > (o.toleranceSec ?? 300)) return false
  if (!/^[0-9a-f]{128}$/i.test(signature)) return false
  const sig = Buffer.from(signature, 'hex')
  const message = falWebhookMessage({ requestId, userId, timestamp }, o.rawBody)
  for (const k of o.keys) {
    try {
      const key = createPublicKey({ key: { kty: k.kty, crv: k.crv, x: k.x }, format: 'jwk' })
      if (verify(null, message, key, sig)) return true
    }
    catch { /* a malformed key is skipped */ }
  }
  return false
}

async function fetchFalKeys(): Promise<FalJwk[]> {
  const r = await fetch(FAL_JWKS_URL)
  if (!r.ok) throw new Error(`fal JWKS ${r.status}`)
  const body = await r.json() as { keys?: FalJwk[] }
  return Array.isArray(body.keys) ? body.keys : []
}

export function createJwksCache(fetchKeys: () => Promise<FalJwk[]> = fetchFalKeys, ttlMs = 24 * 60 * 60 * 1000) {
  let cached: { keys: FalJwk[]; at: number } | null = null
  return {
    async keys(): Promise<FalJwk[]> {
      if (cached && Date.now() - cached.at < ttlMs) return cached.keys
      cached = { keys: await fetchKeys(), at: Date.now() }
      return cached.keys
    },
  }
}
```

Before relying on `FAL_JWKS_URL`, the implementer checks fal's webhook page (https://docs.fal.ai/model-apis/model-endpoints/webhooks) for the current JWKS address and uses that exact URL; if it differs from the constant above, change the constant (the tests do not depend on it).

`frontend/server/runner/index.ts`:
```ts
/** The runner engine wired to the real world. One per server process. */
import { randomUUID } from 'node:crypto'
import { createEngine, type Engine } from './engine'
import { getRunStore } from './store'
import { realFalClient } from './falQueue'
import { createEngineResultStore } from './results'
import { createHandoff } from './handoff'
import { createMetering } from './metering'
import { createRunEvents } from './events'
import { createGenerationRecords } from './records'
import { webhookBaseUrl, RUNNER_PER_USER_LIMIT } from './config'
import { engineDirForType, uploadOwner, canonicalUploadKey } from '../utils/inputUploads'
import { uploadToFalStorage } from '../utils/falStorage'
import { getLiveLedger } from '../utils/ledgerLive'
import { createGraphRun, appendGraphRunOutput, setGraphRunState, ownedOutputKeys, outputKey } from '../utils/graphRuns'
import { assertSpendAllowed } from '../utils/systemControls'
import { moderatePrompt } from '../utils/moderation'
import { ownerOf, recordOwner } from '../utils/resourceOwners'
import { isHosted } from '../utils/deployMode'
import { captureError } from '../utils/observe'

const ENGINE_ORIGIN = 'http://127.0.0.1:8188'

/** comfy_api_nodes/fal_refs.py's ramp: min(2s, 0.35s × 1.5^attempt). */
export function pollDelayMs(attempt: number): number {
  return Math.min(2000, Math.round(350 * 1.5 ** attempt))
}

const g = globalThis as unknown as { __sailorRunnerEngine?: Engine }
let override: Engine | null = null

export function __setEngineForTests(e: Engine | null): void { override = e }

export function getEngine(): Engine {
  if (override) return override
  if (g.__sailorRunnerEngine) return g.__sailorRunnerEngine
  const results = createEngineResultStore({ dirForType: t => engineDirForType(t), hosted: isHosted })
  const engine = createEngine({
    store: getRunStore(),
    fal: realFalClient,
    results,
    handoff: createHandoff({ read: f => results.read(f), upload: uploadToFalStorage }),
    metering: createMetering({
      hosted: isHosted,
      ledger: () => getLiveLedger(),
      graphRuns: {
        create: r => createGraphRun(r),
        appendOutput: (id, key) => appendGraphRunOutput(id, key),
        resolve: (id, state) => setGraphRunState(id, state),
      },
      spendGuard: assertSpendAllowed,
      moderate: moderatePrompt,
    }),
    events: createRunEvents(),
    ownership: {
      ownsInput: async (userId, f) => (await uploadOwner(canonicalUploadKey('input', f.subfolder, f.filename))) === userId,
      ownsOutput: async (userId, f) => (await ownedOutputKeys(userId)).has(outputKey(f)),
    },
    records: createGenerationRecords({
      hosted: isHosted,
      ownerOf,
      recordOwner,
      post: async (uuid, body) => {
        const r = await fetch(`${ENGINE_ORIGIN}/sailor/projects/${encodeURIComponent(uuid)}/generations`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        })
        if (!r.ok) throw new Error(`generation record ${r.status}`)
      },
    }),
    download: async (url) => {
      const r = await fetch(url)
      if (!r.ok) throw new Error(`Could not download the result (${r.status})`)
      return { bytes: new Uint8Array(await r.arrayBuffer()), contentType: r.headers.get('content-type') }
    },
    hosted: isHosted,
    webhookUrl: () => {
      const base = webhookBaseUrl()
      return base ? `${base}/api/webhooks/fal` : null
    },
    now: () => Date.now(),
    sleep: (ms, signal) => new Promise<void>((resolve) => {
      if (signal.aborted) return resolve()
      const t = setTimeout(resolve, ms)
      signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
    }),
    newId: () => randomUUID(),
    perUserLimit: RUNNER_PER_USER_LIMIT,
    maxTakes: 8,
    timeouts: { imageMs: 5 * 60_000, videoMs: 30 * 60_000 },
    pollDelayMs,
    reportError: (e, ctx) => {
      console.error('[runner]', ctx, e)
      captureError(e, ctx)
    },
  })
  g.__sailorRunnerEngine = engine
  return engine
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/runner-records-webhook.unit.spec.ts`
Expected: PASS. (`pollDelayMs(1)` = round(525) = 525.)

- [ ] **Step 5: Commit** (controller)

Paths: `frontend/server/runner/records.ts frontend/server/runner/webhook.ts frontend/server/runner/index.ts frontend/tests/unit/runner-records-webhook.unit.spec.ts`
Message: `feat(runner): generation records, fal webhook signatures, and the wired engine`

---

### Task 15: The API routes and the start-up plugin

**Files:**
- Create: `frontend/server/api/runs/index.post.ts`, `frontend/server/api/runs/events.get.ts`, `frontend/server/api/runs/gate.post.ts`, `frontend/server/api/runs/stop.post.ts`, `frontend/server/api/runs/paused.get.ts`, `frontend/server/api/runs/record.get.ts`
- Create: `frontend/server/api/webhooks/fal.post.ts`
- Create: `frontend/server/plugins/runner.ts`
- Test: `frontend/tests/unit/runner-routes.unit.spec.ts`

**Interfaces:**
- Consumes: `getEngine`, `__setEngineForTests` (Task 14); `runnerEnabled` (Task 1); `verifyFalWebhook`, `createJwksCache` (Task 14); `userKeyOf` (Task 6); `assertRateLimit` (`server/lib/rateLimit.ts`).
- Produces: `POST /api/runs` `{ takes, workflow, canvasId, projectUuid, projectName }` → `{ runId, legId, promptIds }`; `GET /api/runs/events` (server-sent events, one JSON `RunnerMessage` per `data:` line, `event: ping` every 25 s); `POST /api/runs/gate` `{ runId, nodeId, action, takes? }` → `{ runId, legId, promptIds }`; `POST /api/runs/stop` `{ runIds? }` → `{ stopped }`; `GET /api/runs/paused?canvasId=` → `{ gates: PausedGate[] }`; `GET /api/runs/record?promptId=` → `RunnerRecordView` or 404; `POST /api/webhooks/fal` → `{ ok: true }` or 401. Every route answers 404 while `NUXT_RUNNER_ENABLED` is off.

- [ ] **Step 1: Write the failing test**

`frontend/tests/unit/runner-routes.unit.spec.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, eventHandler, toWebHandler } from 'h3'
import { __setEngineForTests } from '~~/server/runner/index'
import start from '~~/server/api/runs/index.post'
import gate from '~~/server/api/runs/gate.post'
import stop from '~~/server/api/runs/stop.post'
import paused from '~~/server/api/runs/paused.get'
import record from '~~/server/api/runs/record.get'
import falHook from '~~/server/api/webhooks/fal.post'

const engine = {
  startRun: vi.fn(async () => ({ runId: 'run_a', legId: 'run_a.0', promptIds: ['run_a.0.t0'] })),
  gateAction: vi.fn(async () => ({ runId: 'run_a', legId: 'run_a.1', promptIds: ['run_a.1.t0'] })),
  stop: vi.fn(async () => ({ stopped: ['run_a'] })),
  pausedGates: vi.fn(async () => []),
  record: vi.fn(async () => null),
  nudge: vi.fn(() => true),
}

function handler(route: any, userId: string | null = 'user_1') {
  const app = createApp()
  app.use(eventHandler((e) => { if (userId) e.context.userId = userId }))
  app.use(route)
  return toWebHandler(app)
}
const post = (h: any, body: unknown) => h(new Request('http://x/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
const get = (h: any, qs = '') => h(new Request(`http://x/${qs}`))

beforeEach(() => { process.env.NUXT_RUNNER_ENABLED = 'true'; __setEngineForTests(engine as any); vi.clearAllMocks() })
afterEach(() => { delete process.env.NUXT_RUNNER_ENABLED; __setEngineForTests(null) })

describe('runner routes', () => {
  it('are hidden while the switch is off', async () => {
    delete process.env.NUXT_RUNNER_ENABLED
    expect((await post(handler(start), {})).status).toBe(404)
    expect((await post(handler(falHook), {})).status).toBe(404)
  })
  it('start a run as the signed-in user', async () => {
    const res = await post(handler(start), { takes: [{}], workflow: { a: 1 }, canvasId: 'c1', projectUuid: 'p1', projectName: 'Fox' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ runId: 'run_a', legId: 'run_a.0', promptIds: ['run_a.0.t0'] })
    expect(engine.startRun).toHaveBeenCalledWith({ userId: 'user_1', takes: [{}], workflow: { a: 1 }, canvasId: 'c1', projectUuid: 'p1', projectName: 'Fox' })
  })
  it('pass Gate buttons through with the ticked pictures', async () => {
    await post(handler(gate), { runId: 'run_a', nodeId: '2', action: 'continue', takes: [1, 3] })
    expect(engine.gateAction).toHaveBeenCalledWith({ userId: 'user_1', runId: 'run_a', gateId: '2', action: 'continue', takes: [1, 3] })
    const bad = await post(handler(gate), { runId: 'run_a', nodeId: '2', action: 'explode' })
    expect(bad.status).toBe(400)
  })
  it('stop, paused and record', async () => {
    expect(await (await post(handler(stop), {})).json()).toEqual({ stopped: ['run_a'] })
    expect(engine.stop).toHaveBeenCalledWith('user_1', undefined)
    expect(await (await get(handler(paused), '?canvasId=c1')).json()).toEqual({ gates: [] })
    expect(engine.pausedGates).toHaveBeenCalledWith('user_1', 'c1')
    expect((await get(handler(record), '?promptId=run_a.0.t0')).status).toBe(404)
  })
  it('the fal webhook ignores unsigned calls', async () => {
    const res = await post(handler(falHook, null), { request_id: 'r1' })
    expect(res.status).toBe(401)
    expect(engine.nudge).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/runner-routes.unit.spec.ts`
Expected: FAIL — route files not found.

- [ ] **Step 3: Implement the routes**

`frontend/server/api/runs/index.post.ts`:
```ts
/** Start a run on the Sailor runner. Body: { takes: ApiPrompt[], workflow, canvasId, projectUuid, projectName }. */
import { createError, defineEventHandler, readBody } from 'h3'
import { runnerEnabled } from '../../runner/config'
import { getEngine } from '../../runner/index'
import { assertRateLimit } from '../../lib/rateLimit'

const str = (v: unknown) => (typeof v === 'string' && v ? v : null)

export default defineEventHandler(async (event) => {
  if (!runnerEnabled()) throw createError({ statusCode: 404, message: 'Not found' })
  assertRateLimit(event, 'runs-start', 30)
  const body = (await readBody(event)) as Record<string, unknown> | null
  return await getEngine().startRun({
    userId: event.context.userId ?? null,
    takes: body?.takes,
    workflow: body?.workflow ?? null,
    canvasId: str(body?.canvasId),
    projectUuid: str(body?.projectUuid),
    projectName: str(body?.projectName),
  })
})
```

`frontend/server/api/runs/gate.post.ts`:
```ts
/** A Gate button on a runner run. Body: { runId, nodeId, action: 'continue'|'redo'|'restart', takes?: number[] }. */
import { createError, defineEventHandler, readBody } from 'h3'
import { runnerEnabled } from '../../runner/config'
import { getEngine } from '../../runner/index'
import { isRunId } from '../../runner/store'

const ACTIONS = new Set(['continue', 'redo', 'restart'])

export default defineEventHandler(async (event) => {
  if (!runnerEnabled()) throw createError({ statusCode: 404, message: 'Not found' })
  const body = (await readBody(event)) as Record<string, unknown> | null
  const action = String(body?.action ?? '')
  if (!isRunId(body?.runId) || typeof body?.nodeId !== 'string' || !ACTIONS.has(action)) {
    throw createError({ statusCode: 400, message: 'Missing run, Gate or action' })
  }
  const takes = Array.isArray(body?.takes) ? (body!.takes as unknown[]).filter((t): t is number => Number.isInteger(t)) : undefined
  return await getEngine().gateAction({
    userId: event.context.userId ?? null,
    runId: body!.runId as string,
    gateId: body!.nodeId as string,
    action: action as 'continue' | 'redo' | 'restart',
    takes,
  })
})
```

`frontend/server/api/runs/stop.post.ts`:
```ts
/** Stop the caller's runner runs (all of them, or the ones listed). */
import { createError, defineEventHandler, readBody } from 'h3'
import { runnerEnabled } from '../../runner/config'
import { getEngine } from '../../runner/index'
import { isRunId } from '../../runner/store'

export default defineEventHandler(async (event) => {
  if (!runnerEnabled()) throw createError({ statusCode: 404, message: 'Not found' })
  const body = (await readBody(event).catch(() => null)) as Record<string, unknown> | null
  const runIds = Array.isArray(body?.runIds) ? (body!.runIds as unknown[]).filter(isRunId) : undefined
  return await getEngine().stop(event.context.userId ?? null, runIds)
})
```

`frontend/server/api/runs/paused.get.ts`:
```ts
/** Paused Gates on one canvas, so a reopened project shows its pictures and buttons again. */
import { createError, defineEventHandler, getQuery } from 'h3'
import { runnerEnabled } from '../../runner/config'
import { getEngine } from '../../runner/index'

export default defineEventHandler(async (event) => {
  if (!runnerEnabled()) throw createError({ statusCode: 404, message: 'Not found' })
  const canvasId = getQuery(event).canvasId
  if (typeof canvasId !== 'string' || !canvasId) return { gates: [] }
  return { gates: await getEngine().pausedGates(event.context.userId ?? null, canvasId) }
})
```

`frontend/server/api/runs/record.get.ts`:
```ts
/** How a runner result was made: the exact workflow, the charge, the prompt. */
import { createError, defineEventHandler, getQuery } from 'h3'
import { runnerEnabled } from '../../runner/config'
import { getEngine } from '../../runner/index'

export default defineEventHandler(async (event) => {
  if (!runnerEnabled()) throw createError({ statusCode: 404, message: 'Not found' })
  const promptId = getQuery(event).promptId
  if (typeof promptId !== 'string') throw createError({ statusCode: 400, message: 'Missing promptId' })
  const rec = await getEngine().record(event.context.userId ?? null, promptId)
  if (!rec) throw createError({ statusCode: 404, message: 'Not found' })
  return rec
})
```

`frontend/server/api/runs/events.get.ts`:
```ts
/**
 * Live run events for the signed-in user, as server-sent events. Each
 * message's data is a ComfyUI-shaped {type, data} object; the browser feeds
 * it through mapWsEvent onto the same in-page pipe the canvas already reads.
 * On connect it first replays what is in progress and what is paused.
 */
import { createError, createEventStream, defineEventHandler } from 'h3'
import type { RunnerMessage } from '#shared/runner/messages'
import { runnerEnabled } from '../../runner/config'
import { getEngine } from '../../runner/index'
import { userKeyOf } from '../../runner/store'

export default defineEventHandler(async (event) => {
  if (!runnerEnabled()) throw createError({ statusCode: 404, message: 'Not found' })
  const userId = event.context.userId ?? null
  const engine = getEngine()
  const stream = createEventStream(event)
  const send = (m: RunnerMessage) => { void stream.push(JSON.stringify(m)) }
  // Subscribe before replaying so nothing published in between is lost (a duplicate is harmless).
  const off = engine.events.subscribe(userKeyOf(userId), send)
  for (const m of engine.snapshot(userId)) send(m)
  const ping = setInterval(() => { void stream.push({ event: 'ping', data: '{}' }) }, 25_000)
  stream.onClosed(async () => {
    off()
    clearInterval(ping)
    await stream.close()
  })
  return stream.send()
})
```

`frontend/server/api/webhooks/fal.post.ts`:
```ts
/**
 * fal calls this when a runner request finishes. It only wakes the waiting
 * poll — the runner still asks fal for the answer itself. Unsigned or stale
 * calls are refused. Listed in PUBLIC_API_PATHS (no sign-in: fal calls it).
 */
import { createError, defineEventHandler, getHeader, readRawBody } from 'h3'
import { runnerEnabled } from '../../runner/config'
import { getEngine } from '../../runner/index'
import { createJwksCache, verifyFalWebhook } from '../../runner/webhook'

const jwks = createJwksCache()

export default defineEventHandler(async (event) => {
  if (!runnerEnabled()) throw createError({ statusCode: 404, message: 'Not found' })
  const raw = (await readRawBody(event, false)) ?? Buffer.alloc(0)
  const headers = {
    requestId: getHeader(event, 'x-fal-webhook-request-id'),
    userId: getHeader(event, 'x-fal-webhook-user-id'),
    timestamp: getHeader(event, 'x-fal-webhook-timestamp'),
    signature: getHeader(event, 'x-fal-webhook-signature'),
  }
  if (!headers.requestId || !headers.signature) throw createError({ statusCode: 401, message: 'Unsigned' })
  let keys
  try { keys = await jwks.keys() }
  catch { throw createError({ statusCode: 503, message: 'Could not check the signature' }) }
  const ok = verifyFalWebhook({ headers, rawBody: new Uint8Array(raw), keys, nowSec: Math.floor(Date.now() / 1000) })
  if (!ok) throw createError({ statusCode: 401, message: 'Bad signature' })
  getEngine().nudge(headers.requestId)
  return { ok: true }
})
```

`frontend/server/plugins/runner.ts`:
```ts
/**
 * On server start, pick up every runner run that was mid-flight: ask fal
 * again about each request it had sent. Paused runs need nothing — they wait
 * for a Gate button. Off unless NUXT_RUNNER_ENABLED is set.
 */
import { runnerEnabled } from '../runner/config'
import { getEngine } from '../runner/index'

const g = globalThis as unknown as { __sailorRunnerReattached?: boolean }

export default defineNitroPlugin(() => {
  if (!runnerEnabled() || g.__sailorRunnerReattached) return
  g.__sailorRunnerReattached = true
  // Not awaited: boot must not wait on the database or fal.
  setTimeout(() => {
    getEngine().reattach()
      .then(n => { if (n) console.log(`[runner] picked up ${n} run(s) after start-up`) })
      .catch(e => console.error('[runner] could not pick up runs after start-up', e))
  }, 2000)
})
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/runner-routes.unit.spec.ts tests/unit/api-route-reachability.unit.spec.ts`
Expected: PASS (the reachability spec proves `/api/runs/*` and `/api/webhooks/fal` are served by Nitro, not proxied to ComfyUI).

- [ ] **Step 5: Commit** (controller)

Paths: `frontend/server/api/runs/index.post.ts frontend/server/api/runs/events.get.ts frontend/server/api/runs/gate.post.ts frontend/server/api/runs/stop.post.ts frontend/server/api/runs/paused.get.ts frontend/server/api/runs/record.get.ts frontend/server/api/webhooks/fal.post.ts frontend/server/plugins/runner.ts frontend/tests/unit/runner-routes.unit.spec.ts`
Message: `feat(runner): API routes, live event stream, fal webhook, start-up pickup`

---
### Task 16: Browser plumbing — new event shapes, the runner client, the live stream

**Files:**
- Modify: `frontend/app/lib/graph/wsEventMap.ts` (the `BridgeShapedEvent` type, lines 11–26, and the `execution_success`/`gate_paused` cases in `mapWsEvent`)
- Create: `frontend/app/lib/runner/client.ts`
- Create: `frontend/app/composables/useRunnerEvents.ts`
- Test: `frontend/tests/unit/ws-event-map.unit.spec.ts` (extend), `frontend/tests/unit/runner-client.unit.spec.ts`

**Interfaces:**
- Consumes: `isRunnerEligible` (Task 2); `GateChoice`, `RUNNER_WORKER`, `isRunnerPromptId` (Task 10); server routes (Task 15).
- Produces: `BridgeShapedEvent` gains `{ event: 'queue_position'; prompt_id: string | null; node_id: string | null; position: number }`, optional `run_id`/`credits`/`recorded`/`stopped` on `execution_complete`, optional `run_id`/`credits`/`recorded` on `execution_error`, optional `run_id`/`choices`/`picked` on `gate_paused`. `client.ts`: `shouldUseRunner(enabled: boolean, prompts: Array<ApiPrompt | null | undefined>): boolean`; `runIdOfPrompt(promptId: unknown): string | null`; `startRunnerRun(body: { takes: ApiPrompt[]; workflow: unknown; canvasId: string | null; projectUuid: string | null; projectName: string | null }): Promise<{ runId: string; legId: string; promptIds: string[] }>`; `runnerGateAction(body: { runId: string; nodeId: string; action: 'continue' | 'redo' | 'restart'; takes?: number[] }): Promise<{ runId: string; legId: string; promptIds: string[] }>`; `stopRunnerRuns(): Promise<void>`; `fetchPausedGates(canvasId: string): Promise<PausedGateView[]>`; `fetchRunnerRecord(promptId: string): Promise<RunnerRecordView | null>`; types `PausedGateView`, `RunnerRecordView`. `useRunnerEvents.ts`: `runnerMessageToPipe(raw: string): Record<string, unknown> | null`; `useRunnerEvents(): { connect(): void; disconnect(): void }`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/tests/unit/ws-event-map.unit.spec.ts` (inside the existing `describe('mapWsEvent', …)`):
```ts
  it('maps the runner’s queue position', () => {
    expect(mapWsEvent({ type: 'queue_position', data: { prompt_id: 'run_a.0.t0', node: '1', position: 3 } }, CID))
      .toEqual({ event: 'queue_position', prompt_id: 'run_a.0.t0', node_id: '1', position: 3 })
  })
  it('carries the runner’s exact cost on completion, and nothing extra for ComfyUI', () => {
    expect(mapWsEvent({ type: 'execution_success', data: { prompt_id: 'run_a.0.t0', run_id: 'run_a', credits: 47, recorded: true, stopped: false } }, CID))
      .toEqual({ event: 'execution_complete', prompt_id: 'run_a.0.t0', run_id: 'run_a', credits: 47, recorded: true, stopped: false })
    expect(mapWsEvent({ type: 'execution_success', data: { prompt_id: 'p1' } }, CID))
      .toEqual({ event: 'execution_complete', prompt_id: 'p1' })
  })
  it('carries Gate choices', () => {
    const choices = [{ take: 0, files: [{ filename: 'a.png', subfolder: '', type: 'output' }] }]
    expect(mapWsEvent({ type: 'gate_paused', data: { prompt_id: 'run_a.0', run_id: 'run_a', node_id: '2', choices, picked: [0] } }, CID))
      .toEqual({ event: 'gate_paused', prompt_id: 'run_a.0', node_id: '2', run_id: 'run_a', choices, picked: [0] })
    expect(mapWsEvent({ type: 'gate_paused', data: { prompt_id: 'p', node_id: '2' } }, CID))
      .toEqual({ event: 'gate_paused', prompt_id: 'p', node_id: '2' })
  })
  it('keeps the runner’s charge on a failure', () => {
    expect(mapWsEvent({ type: 'execution_error', data: { prompt_id: 'run_a.0.t0', node_id: '1', node_type: 'GenerateImageNode', exception_message: 'x', exception_type: 'RunnerError', traceback: [], run_id: 'run_a', credits: 0, recorded: true } }, CID))
      .toMatchObject({ event: 'execution_error', prompt_id: 'run_a.0.t0', run_id: 'run_a', credits: 0, recorded: true })
  })
```

`frontend/tests/unit/runner-client.unit.spec.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { shouldUseRunner, runIdOfPrompt } from '~/lib/runner/client'
import { runnerMessageToPipe } from '~/composables/useRunnerEvents'

const img = { '1': { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'x' } } }
const blur = { '1': { class_type: 'ImageBlur', inputs: {} } }

describe('shouldUseRunner', () => {
  it('needs the switch on and every take eligible', () => {
    expect(shouldUseRunner(false, [img])).toBe(false)
    expect(shouldUseRunner(true, [img, img])).toBe(true)
    expect(shouldUseRunner(true, [img, blur])).toBe(false)
    expect(shouldUseRunner(true, [img, null])).toBe(false)
    expect(shouldUseRunner(true, [])).toBe(false)
  })
})

describe('runIdOfPrompt', () => {
  it('finds the run behind a stage key or leg id', () => {
    expect(runIdOfPrompt('run_abc.1.t2')).toBe('run_abc')
    expect(runIdOfPrompt('run_abc.1')).toBe('run_abc')
    expect(runIdOfPrompt('4f1e-comfy')).toBeNull()
    expect(runIdOfPrompt(undefined)).toBeNull()
  })
})

describe('runnerMessageToPipe', () => {
  it('wraps a runner message in the page’s event envelope', () => {
    expect(runnerMessageToPipe(JSON.stringify({ type: 'execution_start', data: { prompt_id: 'run_a.0.t0' } })))
      .toEqual({ type: 'sailor-bridge', v: 2, direct: true, event: 'execution_start', prompt_id: 'run_a.0.t0' })
  })
  it('drops junk and messages the canvas does not use', () => {
    expect(runnerMessageToPipe('not json')).toBeNull()
    expect(runnerMessageToPipe(JSON.stringify({ type: 'status', data: {} }))).toBeNull()
  })
})
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/ws-event-map.unit.spec.ts tests/unit/runner-client.unit.spec.ts`
Expected: FAIL — new cases fail; `~/lib/runner/client` not found.

- [ ] **Step 3: Implement**

In `frontend/app/lib/graph/wsEventMap.ts`, add `import type { GateChoice } from '#shared/runner/messages'` at the top and replace the `BridgeShapedEvent` type with:
```ts
export type BridgeShapedEvent =
  | { event: 'execution_start'; prompt_id: string | null }
  | { event: 'progress'; percent: number; prompt_id: string | null; node_id: string | null }
  | { event: 'executing'; node_id: string; display_node: string | undefined; prompt_id: string | null }
  | {
      event: 'execution_complete'
      prompt_id: string | null
      // Runner only: the stage's exact charge; `recorded` = the server already
      // wrote the generation record, so the browser must not save its own.
      run_id?: string | null
      credits?: number | null
      recorded?: boolean
      stopped?: boolean
    }
  | { event: 'executed'; node_id: string; output: any; prompt_id: string | null }
  | {
      event: 'execution_error'
      node_id: string | null
      node_type: string | null
      exception_message: string | null
      exception_type: string | null
      traceback: string | undefined
      prompt_id: string | null
      run_id?: string | null
      credits?: number | null
      recorded?: boolean
    }
  | { event: 'gate_paused'; node_id: string | undefined; prompt_id: string | undefined; run_id?: string; choices?: GateChoice[]; picked?: number[] }
  | { event: 'queue_position'; prompt_id: string | null; node_id: string | null; position: number }
```
In `mapWsEvent`, replace the `execution_error`, `execution_success`/`execution_complete` and `gate_paused` cases with:
```ts
    case 'execution_error': {
      const base = {
        event: 'execution_error' as const,
        node_id: data.node_id ?? data.node ?? null,
        node_type: data.node_type ?? null,
        exception_message: data.exception_message ?? data.message ?? null,
        exception_type: data.exception_type ?? null,
        traceback: Array.isArray(data.traceback) ? data.traceback.join('') : data.traceback,
        prompt_id: data.prompt_id ?? null,
      }
      return data.recorded === true
        ? { ...base, run_id: data.run_id ?? null, credits: typeof data.credits === 'number' ? data.credits : null, recorded: true }
        : base
    }

    case 'execution_success':
    case 'execution_complete': {
      const base = { event: 'execution_complete' as const, prompt_id: data.prompt_id ?? null }
      return data.recorded === true
        ? { ...base, run_id: data.run_id ?? null, credits: typeof data.credits === 'number' ? data.credits : null, recorded: true, stopped: data.stopped === true }
        : base
    }

    case 'gate_paused': {
      const base = { event: 'gate_paused' as const, node_id: data.node_id, prompt_id: data.prompt_id }
      return Array.isArray(data.choices)
        ? { ...base, run_id: data.run_id, choices: data.choices, picked: Array.isArray(data.picked) ? data.picked : [] }
        : base
    }

    case 'queue_position':
      return { event: 'queue_position', prompt_id: data.prompt_id ?? null, node_id: data.node ?? null, position: Number(data.position) || 0 }
```

`frontend/app/lib/runner/client.ts`:
```ts
/**
 * Browser side of the Sailor runner: when to use it, and the calls to
 * /api/runs. Every call degrades quietly — a runner hiccup must never take
 * the canvas down.
 */
import type { ApiPrompt } from '#shared/runner/graph'
import type { GateChoice } from '#shared/runner/messages'
import { isRunnerEligible } from '#shared/runner/eligibility'

export interface PausedGateView { runId: string; promptId: string; nodeId: string; choices: GateChoice[]; picked: number[] }
export interface RunnerRecordView {
  runId: string
  promptId: string
  workflow: unknown
  createdAt: number
  endedAt: number | null
  credits: number | null
  prompt: string | null
  nodeTypes: string[]
  projectUuid: string | null
  projectName: string | null
}
export interface LegStarted { runId: string; legId: string; promptIds: string[] }

export function shouldUseRunner(enabled: boolean, prompts: Array<ApiPrompt | null | undefined>): boolean {
  return enabled && prompts.length > 0 && prompts.every(p => !!p && isRunnerEligible(p))
}

export function runIdOfPrompt(promptId: unknown): string | null {
  if (typeof promptId !== 'string' || !promptId.startsWith('run_')) return null
  return promptId.split('.')[0]!
}

export function startRunnerRun(body: { takes: ApiPrompt[]; workflow: unknown; canvasId: string | null; projectUuid: string | null; projectName: string | null }): Promise<LegStarted> {
  return $fetch<LegStarted>('/api/runs', { method: 'POST', body })
}

export function runnerGateAction(body: { runId: string; nodeId: string; action: 'continue' | 'redo' | 'restart'; takes?: number[] }): Promise<LegStarted> {
  return $fetch<LegStarted>('/api/runs/gate', { method: 'POST', body })
}

export async function stopRunnerRuns(): Promise<void> {
  try { await $fetch('/api/runs/stop', { method: 'POST', body: {} }) }
  catch (e) { console.warn('[runner] stop failed', e) }
}

export async function fetchPausedGates(canvasId: string): Promise<PausedGateView[]> {
  try { return (await $fetch<{ gates: PausedGateView[] }>('/api/runs/paused', { query: { canvasId } })).gates ?? [] }
  catch { return [] }
}

export async function fetchRunnerRecord(promptId: string): Promise<RunnerRecordView | null> {
  try { return await $fetch<RunnerRecordView>('/api/runs/record', { query: { promptId } }) }
  catch { return null }
}
```

`frontend/app/composables/useRunnerEvents.ts`:
```ts
/**
 * The runner's live events (GET /api/runs/events, server-sent) fed onto the
 * same in-page pipe ComfyUI's WebSocket events use, so the canvas and the
 * layout handle both the same way. EventSource reconnects on its own; on
 * reconnect the server replays what is running and what is paused.
 */
import { mapWsEvent } from '~/lib/graph/wsEventMap'

export function runnerMessageToPipe(raw: string): Record<string, unknown> | null {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  // Runner messages carry no client id, so no id of ours can mark them foreign.
  const mapped = mapWsEvent(parsed as { type: string; data: any }, '')
  return mapped ? { type: 'sailor-bridge', v: 2, direct: true, ...mapped } : null
}

let source: EventSource | null = null

export function useRunnerEvents() {
  function connect(): void {
    if (source || typeof EventSource === 'undefined') return
    source = new EventSource('/api/runs/events')
    source.onmessage = (m) => {
      const env = runnerMessageToPipe(String(m.data))
      if (env) window.postMessage(env, window.location.origin)
    }
  }
  function disconnect(): void {
    source?.close()
    source = null
  }
  return { connect, disconnect }
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/ws-event-map.unit.spec.ts tests/unit/runner-client.unit.spec.ts tests/unit/direct-execution-drain.unit.spec.ts`
Expected: PASS (all old `ws-event-map` cases still pass unchanged).

- [ ] **Step 5: Commit** (controller)

Paths: `frontend/app/lib/graph/wsEventMap.ts frontend/app/lib/runner/client.ts frontend/app/composables/useRunnerEvents.ts frontend/tests/unit/ws-event-map.unit.spec.ts frontend/tests/unit/runner-client.unit.spec.ts`
Message: `feat(runner): browser client, live event stream, new event shapes`

---

### Task 17: The layout — route eligible runs, Gate buttons, Stop, no double records

**Files:**
- Modify: `frontend/app/layouts/default.vue`

**Interfaces:**
- Consumes: Task 16 client functions; `RUNNER_WORKER`, `isRunnerPromptId` (Task 10).
- Produces: window event `sailor:runnerGateAction` (detail `{ nodeId: string; promptId: string; action: 'continue' | 'redo' | 'restart'; takes?: number[] }`) handled here; window event `sailor:runnerGateActionFailed` (detail `{ nodeId: string }`) dispatched here; `fetchWorkflowFromHistory` understands runner prompt ids.

There is no unit test for this file (it is a 4000-line layout; its pure pieces were tested in Task 16). It is checked by typecheck here and in the browser in Task 21.

- [ ] **Step 1: Imports and the switch**

Next to the other `~/lib/graph` imports near the top of the `<script setup>`:
```ts
import { shouldUseRunner, startRunnerRun, runnerGateAction, stopRunnerRuns, fetchRunnerRecord, runIdOfPrompt } from '~/lib/runner/client'
import { useRunnerEvents } from '~/composables/useRunnerEvents'
import { RUNNER_WORKER, isRunnerPromptId } from '#shared/runner/messages'
```
Right after `const hostedShell = hostedModeEnabled(useRuntimeConfig().public)` (line ~76):
```ts
// Sailor runner (docs/superpowers/specs/2026-09-22-sailor-runner-and-gate-design.md).
// Off unless NUXT_PUBLIC_RUNNER_ENABLED=true; then eligible workflows go to /api/runs.
const runnerEnabled = !!(useRuntimeConfig().public as { runnerEnabled?: boolean }).runnerEnabled
const runnerEvents = useRunnerEvents()
```

- [ ] **Step 2: Route eligible runs to the runner**

In `runVueWorkflow`'s dispatch block (`if (useDirect) { try { const registerResult = …`), change `registerResult` so runner runs skip the ComfyUI stall watchdog (a video can wait in fal's queue for minutes with no events):
```ts
      const registerResult = (res: import('~/composables/useDirectExecution').QueueResult) => {
        if (!res.prompt_id) return
        registerRun(
          { promptId: res.prompt_id, tabId: runTabId, live: !!opts.live, worker: res.worker ?? workerIdx, canvasId: runCanvasId },
          res.reservationId,
        )
        perRun(res.prompt_id).estimateNodes = runEstimateNodes
        if (!opts.live && !isRunnerPromptId(res.prompt_id)) armDirectRunWatchdog(res.prompt_id, runTabId)
      }
```
and put the runner branch in front of the existing `if (takeCount > 1) {`:
```ts
      const runnerPrompts = [firstTake, ...extraTakes].map(tk => tk.directPrompt)
      if (shouldUseRunner(runnerEnabled, runnerPrompts)) {
        // One run for all takes: with a Gate they pause once and you pick;
        // without one they simply all finish.
        const started = await startRunnerRun({
          takes: runnerPrompts as import('~/lib/graph/graphToPrompt').ApiPrompt[],
          workflow: plainWorkflow,
          canvasId: runCanvasId,
          projectUuid: activeTab.value?.projectUuid ?? null,
          projectName: activeTab.value?.label ?? null,
        })
        for (const promptId of started.promptIds) registerResult({ prompt_id: promptId, worker: RUNNER_WORKER })
      } else if (takeCount > 1) {
```
(the rest of the existing `if (takeCount > 1) { … } else { … }` stays as it is). A refusal from `/api/runs` (402 not enough credits, 403 not your picture, 400 moderation) lands in the existing `catch (err)` below, which already turns an h3 refusal body into the right message.

- [ ] **Step 3: Gate buttons for runner runs**

Add near `handleStopRun`:
```ts
// A Gate on a runner run: the Gate node asks, the layout calls the runner and
// registers the new stage(s) so their events find this tab.
async function handleRunnerGateAction(e: Event) {
  const d = (e as CustomEvent).detail as { nodeId: string; promptId: string; action: 'continue' | 'redo' | 'restart'; takes?: number[] }
  const runId = runIdOfPrompt(d?.promptId)
  if (!runId) return
  const runTabId = activeTab.value?.id || ''
  const runDoc = savedWorkflows[runTabId]
  const canvasId = isProjectDoc(runDoc) ? runDoc.activeCanvasId : null
  try {
    const res = await runnerGateAction({ runId, nodeId: d.nodeId, action: d.action, takes: d.takes })
    for (const promptId of res.promptIds) {
      registerRun({ promptId, tabId: runTabId, live: false, worker: RUNNER_WORKER, canvasId })
    }
  }
  catch (err) {
    const body = (err as any)?.data
    const refusal = isH3RefusalBody(body)
    const statusCode = refusal && typeof body.statusCode === 'number' ? body.statusCode : undefined
    const message = refusal ? body.message : String((err as any)?.message || err)
    surfaceQueueError(null, message, { refusal, statusCode })
    window.dispatchEvent(new CustomEvent('sailor:runnerGateActionFailed', { detail: { nodeId: d.nodeId } }))
  }
}
```
Register it next to the existing `window.addEventListener('sailor:stopRun', handleStopRun)` (line ~1283) and remove it wherever that listener is removed:
```ts
window.addEventListener('sailor:runnerGateAction', handleRunnerGateAction)
```
```ts
window.removeEventListener('sailor:runnerGateAction', handleRunnerGateAction)
```

- [ ] **Step 4: Stop also stops runner runs**

Replace `stopVueWorkflow`'s body:
```ts
async function stopVueWorkflow() {
  try {
    await Promise.all([
      fetch('/interrupt', { method: 'POST' }),
      fetch('/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clear: true }) }),
      // Runner runs: cancelled at fal; holds for unfinished stages dropped.
      ...(runnerEnabled ? [stopRunnerRuns()] : []),
    ])
  }
  catch (err) {
    console.error('[VueNodes] Failed to interrupt:', err)
  }
}
```

- [ ] **Step 5: Connect the live stream**

In `onMounted`, right after the existing `if (directExecutionEnabled.value) direct.connect()` line:
```ts
  if (runnerEnabled) runnerEvents.connect()
```
and in the matching `onUnmounted`, add `runnerEvents.disconnect()`.

- [ ] **Step 6: Don't save a second record; show the exact cost**

In `handleBridgeEvent`'s `execution_complete` branch:
1. Right after `const runProjectUuid = …`, add:
   ```ts
    // The runner already wrote this stage's generation record, with its exact charge.
    const recordedByRunner = data.recorded === true
   ```
2. Change `if (runProjectUuid && validatedRun && (runOutputs.length || replicateEstimate)) {` to
   ```ts
    if (runProjectUuid && validatedRun && !recordedByRunner && (runOutputs.length || replicateEstimate)) {
   ```
3. Change `const armCreditWatch = validatedRun && !isReplicate && lastRunResult.value?.kind !== 'error'` to
   ```ts
    const armCreditWatch = validatedRun && !isReplicate && !recordedByRunner && lastRunResult.value?.kind !== 'error'
   ```
4. Change the `if (validatedRun && lastRunResult.value?.kind !== 'error') { setRunResult({ … }) }` block to:
   ```ts
      if (validatedRun && !data.stopped && lastRunResult.value?.kind !== 'error') {
        setRunResult({
          kind: 'success',
          durationMs,
          at: Date.now(),
          usd: replicateEstimate?.usd ?? null,
          usdApproximate: replicateEstimate?.approximate ?? false,
          ...(recordedByRunner && typeof data.credits === 'number' && data.credits > 0 ? { cost: data.credits } : {}),
        })
      }
   ```

- [ ] **Step 7: "Open workflow" on a runner result loads the exact graph**

Replace `fetchWorkflowFromHistory`:
```ts
async function fetchWorkflowFromHistory(promptId: string): Promise<any> {
  // Runner results keep the exact workflow they were made from.
  if (isRunnerPromptId(promptId)) return (await fetchRunnerRecord(promptId))?.workflow ?? null
  try {
    const res = await fetch(`/history/${promptId}`)
    const data = await res.json()
    const entry = data?.[promptId]
    return entry?.prompt?.[3]?.extra_pnginfo?.workflow || null
  }
  catch { return null }
}
```

- [ ] **Step 8: Typecheck**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vue-tsc --noEmit -p tsconfig.json 2>/dev/null | grep -E "app/layouts/default.vue|app/lib/runner|app/composables/useRunnerEvents|app/lib/graph/wsEventMap"`
Expected: the same errors `default.vue` had before this task (5 on 2026-09-23 — record the exact count before Step 1 and compare). No new errors.

- [ ] **Step 9: Commit** (controller)

Paths: `frontend/app/layouts/default.vue`
Message: `feat(runner): route eligible workflows to the runner; Gate actions, Stop and records`

---

### Task 18: The canvas — Gate pictures and tick boxes, paused Gates come back, "3rd in line"

**Files:**
- Modify: `frontend/app/lib/canvas/capsuleReadout.ts` (`ReadoutInput`, the running branch of `resolveReadout`)
- Modify: `frontend/app/components/vue-canvas/ComfyNode.vue` (the `capsuleReadout` computed, line ~276)
- Modify: `frontend/app/components/vue-canvas/ComfyGateNode.vue`
- Modify: `frontend/app/components/vue-canvas/VueNodeCanvas.vue` (the `executing`, `progress` and `gate_paused` handlers in `handleBridgeMessage`; the `props.workflow` watch at ~2184)
- Modify: `frontend/app/components/CanvasStatusBar.vue` and its use in `default.vue`
- Test: `frontend/tests/unit/capsule-readout.unit.spec.ts` (extend), `frontend/tests/unit/runner-gate-choices.unit.spec.ts`

**Interfaces:**
- Consumes: `fetchPausedGates` (Task 16); `sailor:runnerGateAction` / `sailor:runnerGateActionFailed` (Task 17); `isRunnerPromptId` (Task 10).
- Produces: `inLineLabel(position: number): string` and `ReadoutInput.queuePosition?: number | null`, `ReadoutInput.progress?: number | null` in `capsuleReadout.ts`; `app/lib/runner/gateChoices.ts` with `initialTicks(choices: GateChoice[] | null | undefined, picked: number[] | null | undefined): number[]`, `continueLabel(choiceCount: number, ticked: number): string`, `viewUrl(f: GateChoiceFile): string`, `isVideoFile(name: string): boolean`; node `data.queuePosition`, `data.choices`, `data.picked`, `data.runnerRunId`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/tests/unit/capsule-readout.unit.spec.ts`:
```ts
describe('waiting in line and real progress', () => {
  it('shows place in line while queued', () => {
    expect(resolveReadout({ running: true, runningSince: 1000, now: 5000, queuePosition: 3 })).toBe('3rd in line')
    expect(resolveReadout({ running: true, queuePosition: 1 })).toBe('1st in line')
    expect(resolveReadout({ running: true, queuePosition: 12 })).toBe('12th in line')
    expect(resolveReadout({ running: true, queuePosition: 22 })).toBe('22nd in line')
  })
  it('shows the provider’s percentage once it starts', () => {
    expect(resolveReadout({ running: true, runningSince: 1000, now: 14000, progress: 40 }))
      .toBe(`rendering${READOUT_SEPARATOR}40%${READOUT_SEPARATOR}13s`)
  })
  it('ignores both when not running, and a failure still wins', () => {
    expect(resolveReadout({ running: false, queuePosition: 3 })).toBeNull()
    expect(resolveReadout({ running: true, queuePosition: 3, errorMessage: 'boom' })).toBe('boom')
  })
})
```

`frontend/tests/unit/runner-gate-choices.unit.spec.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { initialTicks, continueLabel, viewUrl, isVideoFile } from '~/lib/runner/gateChoices'

describe('Gate choices', () => {
  it('one picture is ticked for you; several start unticked', () => {
    expect(initialTicks([{ take: 0, files: [] }], [0])).toEqual([0])
    expect(initialTicks([{ take: 0, files: [] }, { take: 1, files: [] }], [])).toEqual([])
    expect(initialTicks(null, null)).toEqual([])
    expect(initialTicks([{ take: 2, files: [] }], [5])).toEqual([])
  })
  it('names the Continue button by how many are ticked', () => {
    expect(continueLabel(1, 1)).toBe('Continue')
    expect(continueLabel(4, 2)).toBe('Continue with 2')
    expect(continueLabel(4, 0)).toBe('Tick to continue')
  })
  it('builds viewer links', () => {
    expect(viewUrl({ filename: 'a b.png', subfolder: 'u_1', type: 'output' })).toBe('/view?filename=a+b.png&type=output&subfolder=u_1')
    expect(viewUrl({ filename: 'a.png', subfolder: '', type: 'output' })).toBe('/view?filename=a.png&type=output')
    expect(isVideoFile('x.MP4')).toBe(true)
    expect(isVideoFile('x.png')).toBe(false)
  })
})
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/capsule-readout.unit.spec.ts tests/unit/runner-gate-choices.unit.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the pure parts**

In `frontend/app/lib/canvas/capsuleReadout.ts`, add to `ReadoutInput` (after `runningSince`):
```ts
  /** Runner: place in the provider's queue while waiting (null once started). */
  queuePosition?: number | null
  /** Runner: the provider's own percentage, when it reports one. */
  progress?: number | null
```
Add above `resolveReadout`:
```ts
/** 1 → "1st in line", 3 → "3rd in line", 12 → "12th in line". */
export function inLineLabel(position: number): string {
  const n = Math.max(1, Math.floor(position))
  const tens = n % 100
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'
  return `${n}${suffix} in line`
}
```
Replace step 2 of `resolveReadout`:
```ts
  // 2. Running. Waiting in the provider's queue first, then live progress.
  if (input.running) {
    if (typeof input.queuePosition === 'number' && input.queuePosition > 0) return inLineLabel(input.queuePosition)
    const started = input.runningSince
    const pct = typeof input.progress === 'number' && input.progress > 0 && input.progress < 100
      ? `${READOUT_SEPARATOR}${Math.round(input.progress)}%` : ''
    if (!started) return `rendering${pct}`
    const now = input.now ?? Date.now()
    return `rendering${pct}${READOUT_SEPARATOR}${fmtSec(elapsedSince(started, now))}`
  }
```

Create `frontend/app/lib/runner/gateChoices.ts`:
```ts
/** Small helpers for the Gate's pick-the-best row. */
import type { GateChoice, GateChoiceFile } from '#shared/runner/messages'

export function initialTicks(choices: GateChoice[] | null | undefined, picked: number[] | null | undefined): number[] {
  const takes = new Set((choices ?? []).map(c => c.take))
  return (picked ?? []).filter(t => takes.has(t))
}

export function continueLabel(choiceCount: number, ticked: number): string {
  if (choiceCount <= 1) return 'Continue'
  return ticked > 0 ? `Continue with ${ticked}` : 'Tick to continue'
}

export function viewUrl(f: GateChoiceFile): string {
  const params = new URLSearchParams({ filename: f.filename, type: f.type })
  if (f.subfolder) params.set('subfolder', f.subfolder)
  return `/view?${params}`
}

export function isVideoFile(name: string): boolean {
  return /\.(mp4|webm|mov|m4v)$/i.test(name)
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/capsule-readout.unit.spec.ts tests/unit/runner-gate-choices.unit.spec.ts`
Expected: PASS (all old readout cases still pass).

- [ ] **Step 5: Wire the node readout and the status bar**

`ComfyNode.vue`, in the `capsuleReadout` computed, after `runningSince: props.data.runningSince,`:
```ts
  queuePosition: props.data.queuePosition ?? null,
  progress: props.data.progress ?? null,
```
(add `queuePosition?: number | null` beside `progress` in the component's `data` prop type).

`CanvasStatusBar.vue`: add prop `queuePosition?: number | null`, import `inLineLabel` from `~/lib/canvas/capsuleReadout`, and in the running template replace `{{ currentNode || 'Starting…' }}` with:
```vue
          {{ queuePosition && queuePosition > 0 ? `${currentNode ? `${currentNode} · ` : ''}${inLineLabel(queuePosition)}` : (currentNode || 'Starting…') }}
```
`default.vue`: add `const promptQueuePos = ref<Record<string, number>>({})` next to `promptProgress`; in `handleBridgeEvent`, add a branch before `else if (evt === 'executed')`:
```ts
  } else if (evt === 'queue_position') {
    if (prompt_id) {
      if (data.position > 0) promptQueuePos.value[prompt_id] = data.position
      else delete promptQueuePos.value[prompt_id]
    }
```
delete `promptQueuePos.value[prompt_id]` in the `execution_complete` and `execution_error` branches next to `delete promptProgress.value[prompt_id]`; add `queuePosition: promptQueuePos.value[<the promptId activeRunDisplay picked>] ?? null` to the object `activeRunDisplay` returns; and pass `:queue-position="activeRunDisplay?.queuePosition ?? null"` to `<CanvasStatusBar>`.

- [ ] **Step 6: Canvas handlers**

In `VueNodeCanvas.vue` `handleBridgeMessage`:
1. In the `executing` branch, where `target.data = { ...target.data, running: true, error: false, errorMessage: null, runningSince: Date.now() }`, add `queuePosition: null,` so a new run never shows the last run's place in line.
2. After the `progress` branch, add:
   ```ts
  if (evt === 'queue_position') {
    const target = (nodes.value as any[]).find((n: any) => n.id === String(nodeId))
    const pos = Number((event.data as any).position) || 0
    if (target) target.data = { ...target.data, queuePosition: pos > 0 ? pos : null }
  }
   ```
3. Replace the `gate_paused` branch with:
   ```ts
  if (evt === 'gate_paused') {
    const promptId = event.data.prompt_id
    const target = (nodes.value as any[]).find((n: any) => n.id === String(nodeId))
    if (target) {
      target.data = {
        ...target.data,
        paused: true,
        promptId,
        running: false,
        // Runner only: the pictures that reached the Gate, one per take.
        choices: Array.isArray((event.data as any).choices) ? (event.data as any).choices : null,
        picked: Array.isArray((event.data as any).picked) ? (event.data as any).picked : [],
        runnerRunId: (event.data as any).run_id ?? null,
      }
    }
  }
   ```
4. Paused Gates come back when a canvas is shown. Add near `applyPendingTakesForDisplayedCanvas`:
   ```ts
const runnerOn = !!(useRuntimeConfig().public as { runnerEnabled?: boolean }).runnerEnabled
async function restoreRunnerGates(): Promise<void> {
  const canvasId = props.displayedCanvasId
  if (!runnerOn || !canvasId) return
  const gates = await fetchPausedGates(canvasId)
  if (props.displayedCanvasId !== canvasId) return // switched away while asking
  for (const g of gates) {
    const target = (nodes.value as any[]).find((n: any) => n.id === g.nodeId && n.data?.nodeType === 'ComfyGateNode')
    if (!target) continue
    target.data = { ...target.data, paused: true, running: false, promptId: g.promptId, choices: g.choices, picked: g.picked, runnerRunId: g.runId }
  }
}
   ```
   (import `fetchPausedGates` from `~/lib/runner/client`), and in the `props.workflow` watch, right after `applyPendingTakesForDisplayedCanvas()`, add `void restoreRunnerGates()`.

- [ ] **Step 7: The Gate node**

In `ComfyGateNode.vue`:

Script — extend the `data` prop type with:
```ts
    choices?: { take: number; files: { filename: string; subfolder: string; type: string }[] }[] | null
    picked?: number[]
    runnerRunId?: string | null
```
add imports and state:
```ts
import { initialTicks, continueLabel, viewUrl, isVideoFile } from '~/lib/runner/gateChoices'
import { isRunnerPromptId } from '#shared/runner/messages'

const isRunner = computed(() => isRunnerPromptId(props.data.promptId))
const choices = computed(() => props.data.choices ?? [])
const ticked = ref<number[]>(initialTicks(props.data.choices, props.data.picked))
watch(() => props.data.choices, () => { ticked.value = initialTicks(props.data.choices, props.data.picked) })
function toggleTick(take: number) {
  ticked.value = ticked.value.includes(take) ? ticked.value.filter(t => t !== take) : [...ticked.value, take].sort((a, b) => a - b)
}
// A finished runner run keeps its pictures, so Continue can make another
// video from the same picture ("Continue after the run has finished").
const showActions = computed(() => !isBypassed.value && (!!props.data.paused
  || (isRunner.value && !props.data.running && choices.value.length > 0)))
const canContinue = computed(() => !props.data.paused || choices.value.length <= 1 || ticked.value.length > 0)

function onActionFailed(e: Event) {
  if ((e as CustomEvent).detail?.nodeId === props.id && wasPaused) props.data.paused = true
}
let wasPaused = false
onMounted(() => window.addEventListener('sailor:runnerGateActionFailed', onActionFailed))
onBeforeUnmount(() => window.removeEventListener('sailor:runnerGateActionFailed', onActionFailed))
```
and make `resumeGate` hand runner Gates to the layout:
```ts
async function resumeGate(action: 'continue' | 'redo' | 'restart') {
  const fromPause = !!props.data.paused
  if (isRunner.value) {
    wasPaused = fromPause
    props.data.paused = false
    window.dispatchEvent(new CustomEvent('sailor:runnerGateAction', {
      detail: {
        nodeId: props.id,
        promptId: props.data.promptId,
        action,
        takes: fromPause && action === 'continue' && choices.value.length > 1 ? [...ticked.value] : undefined,
      },
    }))
    return
  }
  props.data.paused = false
  // … the existing /gate/resume body stays exactly as it is …
}
```

Template — between the pass-through strip and the bypass/action section, add the pictures row:
```vue
    <!-- Runner: the pictures that reached the Gate. With several, tick the ones worth continuing. -->
    <div v-if="choices.length && (data.paused || isRunner)" class="grid gap-1.5 px-2 pt-2 nopan nodrag" :class="choices.length > 1 ? 'grid-cols-2' : 'grid-cols-1'">
      <button
        v-for="c in choices"
        :key="c.take"
        type="button"
        class="relative rounded-md overflow-hidden border cursor-pointer bg-black/30 aspect-square"
        :class="ticked.includes(c.take) ? 'border-white/70' : 'border-white/10'"
        :aria-pressed="ticked.includes(c.take)"
        :disabled="!data.paused || choices.length <= 1"
        @click="toggleTick(c.take)"
      >
        <video v-if="c.files[0] && isVideoFile(c.files[0].filename)" :src="viewUrl(c.files[0])" class="size-full object-cover" muted loop autoplay playsinline />
        <img v-else-if="c.files[0]" :src="viewUrl(c.files[0])" alt="" class="size-full object-cover" draggable="false">
        <span
          v-if="data.paused && choices.length > 1"
          class="absolute top-1 right-1 size-4 rounded-sm border flex items-center justify-center text-[10px]"
          :class="ticked.includes(c.take) ? 'bg-white text-black border-white' : 'bg-black/50 border-white/50'"
        >{{ ticked.includes(c.take) ? '✓' : '' }}</span>
      </button>
    </div>
```
Change the action row's `v-if="data.paused && !isBypassed"` to `v-if="showActions"`; show Redo only while paused (`v-if="data.paused"` on the Redo button); and make the Continue button:
```vue
        <button
          class="gate-btn flex items-center justify-center gap-1.5 flex-1 h-9 rounded bg-action text-white shadow-sm cursor-pointer hover:bg-action/85 transition-colors text-[11px] font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
          :data-tooltip="data.paused ? 'Continue downstream' : 'Run the steps after this Gate again'"
          :disabled="!canContinue"
          @click="resumeGate('continue')"
        >
          <Play class="size-3.5" :fill="'currentColor'" />
          <span>{{ data.paused ? continueLabel(choices.length, ticked.length) : 'Again' }}</span>
        </button>
```

- [ ] **Step 8: Typecheck and unit tests**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/capsule-readout.unit.spec.ts tests/unit/runner-gate-choices.unit.spec.ts && npx vue-tsc --noEmit -p tsconfig.json 2>/dev/null | grep -E "ComfyGateNode|ComfyNode.vue|VueNodeCanvas|CanvasStatusBar|capsuleReadout|gateChoices|default.vue" | wc -l`
Expected: tests PASS; the error count equals the count recorded before this task (VueNodeCanvas 16 + default.vue 5 = 21, ComfyNode/ComfyGateNode/CanvasStatusBar 0).

- [ ] **Step 9: Commit** (controller)

Paths: `frontend/app/lib/canvas/capsuleReadout.ts frontend/app/lib/runner/gateChoices.ts frontend/app/components/vue-canvas/ComfyNode.vue frontend/app/components/vue-canvas/ComfyGateNode.vue frontend/app/components/vue-canvas/VueNodeCanvas.vue frontend/app/components/CanvasStatusBar.vue frontend/app/layouts/default.vue frontend/tests/unit/capsule-readout.unit.spec.ts frontend/tests/unit/runner-gate-choices.unit.spec.ts`
Message: `feat(runner): Gate pictures with tick boxes, paused Gates restored, place in line`

---

### Task 19: The tab heads-up — title and icon

**Files:**
- Create: `frontend/public/favicon.svg`
- Create: `frontend/app/composables/useTabHeadsUp.ts`
- Modify: `frontend/nuxt.config.ts` (new top-level `app.head`)
- Modify: `frontend/app/layouts/default.vue` (`handleBridgeEvent`)
- Test: `frontend/tests/unit/tab-heads-up.unit.spec.ts`

**Interfaces:**
- Produces: `BASE_TITLE = 'Sailor'`; `type HeadsUpKind = 'image' | 'video' | 'paused' | 'failed'`; `headsUpTitle(kind: HeadsUpKind): string`; `FAVICON_URL = '/favicon.svg'`; `FAVICON_DOT_URL: string` (data URL); `createHeadsUp(page: { isHidden(): boolean; setTitle(t: string): void; setIcon(href: string): void }): { notify(kind: HeadsUpKind): void; clear(): void }`; `useTabHeadsUp(): { notify(kind: HeadsUpKind): void }`.

- [ ] **Step 1: Write the failing test**

`frontend/tests/unit/tab-heads-up.unit.spec.ts`:
```ts
import { describe, expect, it, vi } from 'vitest'
import { createHeadsUp, headsUpTitle, BASE_TITLE, FAVICON_URL, FAVICON_DOT_URL } from '~/composables/useTabHeadsUp'

function page(hidden: boolean) {
  return { hidden, isHidden() { return this.hidden }, setTitle: vi.fn(), setIcon: vi.fn() }
}

describe('tab heads-up', () => {
  it('titles say what happened, in plain words', () => {
    expect(headsUpTitle('image')).toBe('✓ Image ready · Sailor')
    expect(headsUpTitle('video')).toBe('✓ Video ready · Sailor')
    expect(headsUpTitle('paused')).toBe('Ready to review · Sailor')
    expect(headsUpTitle('failed')).toBe('Run failed · Sailor')
  })
  it('only changes a tab you are not looking at, and clears when you come back', () => {
    const p = page(true)
    const h = createHeadsUp(p)
    h.notify('video')
    expect(p.setTitle).toHaveBeenLastCalledWith('✓ Video ready · Sailor')
    expect(p.setIcon).toHaveBeenLastCalledWith(FAVICON_DOT_URL)
    h.clear()
    expect(p.setTitle).toHaveBeenLastCalledWith(BASE_TITLE)
    expect(p.setIcon).toHaveBeenLastCalledWith(FAVICON_URL)
    const q = page(false)
    createHeadsUp(q).notify('image')
    expect(q.setTitle).not.toHaveBeenCalled()
  })
  it('clearing twice does nothing the second time', () => {
    const p = page(true)
    const h = createHeadsUp(p)
    h.clear()
    expect(p.setTitle).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/tab-heads-up.unit.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`frontend/public/favicon.svg` (a placeholder mark — a sail — until there is a real one):
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#111"/><path d="M15 5v18H7z" fill="#fff"/><path d="M17.5 9v14H25z" fill="#fff" opacity=".7"/><path d="M6 26h20" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>
```

`frontend/app/composables/useTabHeadsUp.ts`:
```ts
/**
 * When a run finishes (or pauses at a Gate) while Sailor is in a background
 * tab, the tab title and icon say so. Both clear when you come back.
 * No notifications, no sound — just the tab.
 */
export const BASE_TITLE = 'Sailor'
export const FAVICON_URL = '/favicon.svg'

const DOT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#111"/><path d="M15 5v18H7z" fill="#fff"/><path d="M17.5 9v14H25z" fill="#fff" opacity=".7"/><path d="M6 26h20" stroke="#fff" stroke-width="2" stroke-linecap="round"/><circle cx="25" cy="7" r="6" fill="#ff6b57" stroke="#111" stroke-width="2"/></svg>'
export const FAVICON_DOT_URL = `data:image/svg+xml,${encodeURIComponent(DOT_SVG)}`

export type HeadsUpKind = 'image' | 'video' | 'paused' | 'failed'

export function headsUpTitle(kind: HeadsUpKind): string {
  switch (kind) {
    case 'image': return `✓ Image ready · ${BASE_TITLE}`
    case 'video': return `✓ Video ready · ${BASE_TITLE}`
    case 'paused': return `Ready to review · ${BASE_TITLE}`
    case 'failed': return `Run failed · ${BASE_TITLE}`
  }
}

export function createHeadsUp(page: { isHidden(): boolean; setTitle(t: string): void; setIcon(href: string): void }) {
  let showing = false
  return {
    notify(kind: HeadsUpKind): void {
      if (!page.isHidden()) return
      page.setTitle(headsUpTitle(kind))
      page.setIcon(FAVICON_DOT_URL)
      showing = true
    },
    clear(): void {
      if (!showing) return
      page.setTitle(BASE_TITLE)
      page.setIcon(FAVICON_URL)
      showing = false
    },
  }
}

export function useTabHeadsUp() {
  const h = createHeadsUp({
    isHidden: () => typeof document !== 'undefined' && document.hidden,
    setTitle: (t) => { document.title = t },
    setIcon: (href) => {
      let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
      if (!link) {
        link = document.createElement('link')
        link.rel = 'icon'
        document.head.appendChild(link)
      }
      link.type = 'image/svg+xml'
      link.href = href
    },
  })
  const onVisible = () => { if (!document.hidden) h.clear() }
  onMounted(() => {
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
  })
  onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', onVisible)
    window.removeEventListener('focus', onVisible)
  })
  return { notify: h.notify }
}
```

`frontend/nuxt.config.ts` — add a top-level key (next to `runtimeConfig`):
```ts
  app: {
    head: {
      title: 'Sailor',
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    },
  },
```

`frontend/app/layouts/default.vue`:
- import `useTabHeadsUp` from `~/composables/useTabHeadsUp` and add `const headsUp = useTabHeadsUp()` next to `runnerEvents`.
- In `handleBridgeEvent`'s `execution_complete` branch, inside `if (!wasSilent) {`, before its first line:
  ```ts
      if (validatedRun && !data.stopped) headsUp.notify(runOutputs.some(o => o.kind === 'video') ? 'video' : 'image')
  ```
- In the `execution_error` branch, inside `if (!wasSilent) {`: `headsUp.notify('failed')`.
- Add a `gate_paused` branch to the chain (before `else if (evt === 'executed')`):
  ```ts
  } else if (evt === 'gate_paused') {
    headsUp.notify('paused')
  ```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/tab-heads-up.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (controller)

Paths: `frontend/public/favicon.svg frontend/app/composables/useTabHeadsUp.ts frontend/nuxt.config.ts frontend/app/layouts/default.vue frontend/tests/unit/tab-heads-up.unit.spec.ts`
Message: `feat(app): tab title and icon say when a run is ready in a background tab`

---

### Task 20: Result details for runner results — exact cost, and "Open workflow" opens the graph as it ran

**Files:**
- Modify: `frontend/app/components/AssetDetailOverlay.vue`

**Interfaces:**
- Consumes: `fetchRunnerRecord`, `RunnerRecordView` (Task 16); `isRunnerPromptId` (Task 10); Task 17's `fetchWorkflowFromHistory` change (a tab opened with a runner `promptId` and no `projectUuid` loads the run's own workflow).

- [ ] **Step 1: Script changes**

Add imports:
```ts
import { fetchRunnerRecord, type RunnerRecordView } from '~/lib/runner/client'
import { isRunnerPromptId } from '#shared/runner/messages'
```
Add state after `runUsd`:
```ts
// Runner results: how the result was made comes from the run itself, not /history.
const runnerRecord = ref<RunnerRecordView | null>(null)
const runCredits = computed(() => runnerRecord.value?.credits ?? null)
```
In `onMounted`, before `// Fetch history for this prompt`:
```ts
  if (isRunnerPromptId(props.promptId)) {
    runnerRecord.value = await fetchRunnerRecord(props.promptId)
    loadingHistory.value = false
    return
  }
```
Make the four read-outs fall back to the runner record — add as the first line of each computed:
```ts
// timestamp
  if (runnerRecord.value) return runnerRecord.value.createdAt
// executionTime
  if (runnerRecord.value?.endedAt) return ((runnerRecord.value.endedAt - runnerRecord.value.createdAt) / 1000).toFixed(1)
// outputNodeType
  if (runnerRecord.value) return runnerRecord.value.nodeTypes.find(t => t.startsWith('Generate')) ?? null
// promptText
  if (runnerRecord.value) return runnerRecord.value.prompt
```
In `openWorkflow`, right after `openingWorkflow.value = true` / `try {`:
```ts
    // A runner result reopens the exact graph it was made from, in its own tab.
    if (runnerRecord.value?.workflow) {
      openTab({
        type: 'project',
        label: `${runnerRecord.value.projectName || props.projectName || 'Untitled project'} (as it ran)`,
        promptId: props.promptId,
      })
      emit('close')
      return
    }
```

- [ ] **Step 2: Template change**

Right after the `runUsd` line (`<div v-if="runUsd" …>Cost ~$…</div>`):
```vue
            <div v-if="runCredits != null && runCredits > 0" class="text-xs text-white/40 tabular-nums">
              Cost {{ runCredits.toLocaleString() }} credits
            </div>
```

- [ ] **Step 3: Typecheck**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vue-tsc --noEmit -p tsconfig.json 2>/dev/null | grep -c "AssetDetailOverlay"`
Expected: `0`.

- [ ] **Step 4: Commit** (controller)

Paths: `frontend/app/components/AssetDetailOverlay.vue`
Message: `feat(runner): result details show the exact cost; Open workflow reopens the graph as it ran`

---

### Task 21: Prove it

**Files:**
- Test: all `frontend/tests/unit/runner-*.unit.spec.ts` plus the touched existing specs
- Modify: `docs/STATE.md` (one entry), the build dashboard artifact (controller)

This task is the controller's. It does not run `npm run dev` from a subagent and does not spend money without asking.

- [ ] **Step 1: The whole runner suite, twice**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run tests/unit/runner- tests/unit/ws-event-map.unit.spec.ts tests/unit/capsule-readout.unit.spec.ts tests/unit/graph-runs.unit.spec.ts tests/unit/chokepoint-meter.unit.spec.ts tests/unit/api-route-reachability.unit.spec.ts tests/unit/tab-heads-up.unit.spec.ts tests/unit/price-graph.unit.spec.ts`
Expected: all PASS; run it a second time to catch timing-dependent tests (the engine tests use real timers).

- [ ] **Step 2: The full unit suite**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && pnpm vitest run`
Expected: green (the suite was green on 2026-09-20). Any red spec: run it alone before blaming this work (memory: counts lie under load).

- [ ] **Step 3: Switch off = nothing changed (browser)**

With the switch off (default), on the existing `:3002` dev server (check it with `lsof -nP -iTCP -sTCP:LISTEN | grep node` first; restart only if it is broken, and re-check `127.0.0.1:8188/system_stats` afterwards): run an image → Gate → video workflow with a free/local model or with `/prompt` blocked by a route mock; confirm the request goes to `/prompt` (network panel), not `/api/runs`, and that `GET /api/runs/events` answers 404.

- [ ] **Step 4: Switch on, fake money (browser)**

Set `NUXT_RUNNER_ENABLED=true` and `NUXT_PUBLIC_RUNNER_ENABLED=true` in `frontend/.env`, restart the `:3002` server (same checks as above). Without running anything paid, confirm: `GET /api/runs/events` stays open (EventSource in the network panel); the page title is "Sailor" and the tab shows the new icon; a workflow with a Toolbox node still posts to `/prompt` (spec proof 3).

- [ ] **Step 5: Real runs — ASK THE USER FIRST**

Ask in plain words, with the price: "Ready to spend about $1.30 on real test runs: Flux Schnell ×4 through a Gate, then Hailuo H3 video for 2 of the 4 pictures ($0.012 + 2 × $0.30), plus one moodboard-picture request on each of Nano Banana 2 (~$0.07), Nano Banana Pro (~$0.15), Seedream 4 (~$0.03) and Seedream 5 Lite (~$0.035). OK?" Only after a clear yes:
  1. Re-roll ×4 on the gated workflow → four pictures on the Gate, none ticked, Continue disabled; tick two → "Continue with 2" → two videos; the status bar and node show "…in line"/percent while waiting; switch to another browser tab before it finishes → the title turns "✓ Video ready · Sailor" and the icon gets a dot; come back → both clear.
  2. Reload the page while a Gate is paused → the pictures and buttons come back.
  3. Stop during a video → it stops; Assets shows only what finished.
  4. Open workflow on one of the new videos → a new tab "… (as it ran)" with the graph exactly as it was run.
  5. One moodboard-picture request per model above; confirm each finishes and looks styled by the board.
  Record every result, pass or fail, in the report to the user.

- [ ] **Step 6: Write it down**

Add a `docs/STATE.md` entry (what landed, the two switches, what was checked live and what was not), update the build dashboard artifact, and commit `docs/STATE.md` with the private-index recipe.

---

## Self-review notes (for whoever executes this plan)

**Spec coverage.** How a workflow finds its way → Tasks 2, 16, 17. §1 one description per generator → Tasks 3, 4 (descriptions + Python parity fixtures; prices from the one existing price table, and a test that every runner model has one). §2 how a run works → Tasks 6, 12 (written down before/after each call; parallel nodes; files handed on by our own copy via fal storage). §3 full run records → Tasks 12 (node records keep settings, endpoint, request id, outputs, credits, timings, workflow), 13 (`record`), 14 (generation records), 17/20 (Open workflow). §4 the Gate, including Redo/Restart/Continue-after-finish/pass-through/pick-at-the-Gate/pause survives restarts → Tasks 12, 13, 18. §5 money, including exact cost and never pay twice → Tasks 8, 9, 12, 13. §6 storage doorway → Task 7. §7 events, queue position, choices, tab heads-up → Tasks 10, 15, 16, 18, 19. §8 Stop → Tasks 13, 17. §9 webhook → Tasks 14, 15. §10 several runs at once, per-user limit 4 → Tasks 1, 12. "When things go wrong" table → Tasks 12 (fal error, timeout), 13 (restart, not enough credits, stop), 9 (moderation), 8 (reuse). Proof list → Tasks 12–15 (automated), 21 (live, after asking).

**Deliberate differences from the spec** (tell the user):
1. Nine image models, not twelve: Krea 2 Large, Krea 2 Medium and Seedream 5 Pro have no price in `app/data/image-models.ts`, so they stay on Python until priced. That also means four reference-picture models, not five.
2. "The price book reads prices from the descriptions" became: prices stay in the one table `priceGraph` already reads, and a test fails if any runner model lacks one. Same guarantee, no second price list.
3. The live stream is one per signed-in user (`/api/runs/events`), not one per run — simpler, and it covers several runs at once.
4. The flat render credit is charged once per run, so Re-roll ×4 on the runner costs 3 credits less than four separate runs today.
5. If the server dies in the instant between fal accepting a request and the runner writing its id down, that one job is orphaned: fal is paid, the user is not charged, and the run shows an error after restart. Rare; noted, not engineered away.
6. The cost check before Run still prices the whole workflow, including what is behind a Gate. It over-warns for gated runs; the charge itself is per stage.
7. The favicon is a placeholder sail mark until there is a real one.

**Known limits kept on purpose.** One server process (the per-run lock and the event hub are in memory). Holds are swept after 2 hours by the existing sweeper; the longest stage (a 30-minute video) is well inside that.
