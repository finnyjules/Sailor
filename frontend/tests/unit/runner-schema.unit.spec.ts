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
