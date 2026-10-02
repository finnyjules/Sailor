/**
 * Durable prompt_id → owner registry for metered canvas runs (Stage 5).
 * Replaces the in-memory meterStore so ownership and settlement state
 * survive a server restart. Uses its OWN pg session (connectLedgerDb) —
 * never the ledger's shared session, so no withLock coupling.
 */
import { connectLedgerDb, type LedgerDbHandle } from './ledgerDb'

type DbLike = { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }

let dbOverride: DbLike | null = null
let shared: LedgerDbHandle | null = null

export function __setGraphRunsDbForTests(db: DbLike | null): void { dbOverride = db }

function db(): DbLike {
  if (dbOverride) return dbOverride
  if (!shared) {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('graphRuns: DATABASE_URL not set — hosted mode requires it')
    shared = connectLedgerDb(url)
  }
  return shared
}

export function outputKey(o: { filename: string; subfolder?: string; type?: string }): string {
  return `${o.type || 'output'}:${o.subfolder || ''}:${o.filename}`
}

/**
 * The record kind of an input file the runner saved itself (R3.6 fix round
 * 1: Layerize an image's layers): written only by the runner's own save
 * (metering.addSavedInput), never harvested from ComfyUI's history
 * (meterGraphRun.ts historyOutputKeys skips it), so it can't be claimed
 * through a node's ui.
 */
export const RUNNER_SAVED_INPUT = 'runner-saved-input'

/** The graph_runs key of an input file the runner saved: `runner-saved-input:<subfolder>:<filename>`. */
export function savedInputKey(o: { filename: string; subfolder?: string }): string {
  return outputKey({ filename: o.filename, subfolder: o.subfolder ?? '', type: RUNNER_SAVED_INPUT })
}

/**
 * `target` (review I4) is the engine base URL that actually ran the prompt
 * (`http://127.0.0.1:8188`). The /view race-window harvest polls it.
 * Nullable so pre-existing rows (and any caller that doesn't know) fall back
 * to the main engine.
 */
export async function createGraphRun(r: { promptId: string; userId: string; credits: number; holdId: number | null; target?: string | null }): Promise<void> {
  await db().query(
    `INSERT INTO graph_runs (prompt_id, user_id, credits, hold_id, target)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (prompt_id) DO NOTHING`,
    [r.promptId, r.userId, r.credits, r.holdId, r.target ?? null])
}

export async function resolveGraphRun(promptId: string, state: 'settled' | 'voided', outputs: string[] = []): Promise<void> {
  await db().query(
    `UPDATE graph_runs SET state = $1, outputs = $2::jsonb WHERE prompt_id = $3`,
    [state, JSON.stringify(outputs), promptId])
}

/** Mark a row finished without touching its outputs (the runner appends them as files are saved). */
export async function setGraphRunState(promptId: string, state: 'settled' | 'voided'): Promise<void> {
  await db().query(`UPDATE graph_runs SET state = $1 WHERE prompt_id = $2`, [state, promptId])
}

export async function ownsPrompt(userId: string, promptId: string): Promise<boolean> {
  const { rows } = await db().query(
    `SELECT 1 AS ok FROM graph_runs WHERE user_id = $1 AND prompt_id = $2`, [userId, promptId])
  return rows.length > 0
}

export async function ownedPromptIds(userId: string): Promise<Set<string>> {
  const { rows } = await db().query(
    `SELECT prompt_id FROM graph_runs WHERE user_id = $1`, [userId])
  return new Set(rows.map(r => String(r.prompt_id)))
}

export async function ownedOutputKeys(userId: string): Promise<Set<string>> {
  const { rows } = await db().query(
    `SELECT outputs FROM graph_runs WHERE user_id = $1`, [userId])
  const out = new Set<string>()
  for (const r of rows) for (const k of (r.outputs ?? [])) out.add(String(k))
  return out
}

/**
 * Review I3: the harvest caller caps how many pending rows it will poll.
 * Unordered, that cap selected an ARBITRARY subset — a user carrying a
 * backlog of stale pendings (a wedged worker, an interrupted run) could have
 * their just-completed run fall outside the window that settles it, forever.
 * Newest-first, capped in SQL, riding the existing (user_id, created_at DESC)
 * index.
 */
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

/** Record one more output file as belonging to this row — the runner calls it
 *  the moment a file is saved, so the image viewer's ownership check passes
 *  before the browser asks for the file. */
export async function appendGraphRunOutput(promptId: string, key: string): Promise<void> {
  await db().query(
    `UPDATE graph_runs SET outputs = outputs || $1::jsonb WHERE prompt_id = $2`,
    [JSON.stringify([key]), promptId])
}
