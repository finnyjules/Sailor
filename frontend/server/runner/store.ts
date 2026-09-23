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
  // Guards the disk path (fp is interpolated into a filename): safe identifier
  // characters only, no path separators or traversal — not a hash-shape check,
  // since fingerprints are opaque strings to this store.
  const fpOk = (fp: string) => /^[A-Za-z0-9_-]{1,200}$/.test(fp)
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
      // The filters go into the query, so a user with many runs is not read whole.
      const where = ['user_id IS NOT DISTINCT FROM $1']
      const params: unknown[] = [userId]
      if (opts.canvasId !== undefined) {
        params.push(opts.canvasId)
        where.push(`canvas_id IS NOT DISTINCT FROM $${params.length}`)
      }
      if (opts.statuses) {
        params.push(opts.statuses)
        where.push(`status = ANY($${params.length}::text[])`)
      }
      const { rows } = await db.query(
        `SELECT doc FROM runner_runs WHERE ${where.join(' AND ')} ORDER BY (doc->>'createdAt')::bigint`, params)
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
