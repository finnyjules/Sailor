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
  await store.putResult('u1', 'fp', { files: [{ filename: 'a.png', subfolder: '', type: 'output' }] })
  expect(await store.getResult('u1', 'fp')).toEqual({ files: [{ filename: 'a.png', subfolder: '', type: 'output' }] })
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
  it('filters by canvas and status in the query, not after reading every run', async () => {
    const db = new PGlite()
    await db.exec(readFileSync(fileURLToPath(new URL('../../server/db/schema.sql', import.meta.url)), 'utf8'))
    const seen: { sql: string; params: unknown[] }[] = []
    const spy = { query: async (sql: string, params: unknown[] = []) => { seen.push({ sql, params }); return db.query(sql, params) } }
    const store = createPgRunStore(spy as any)
    const RUN_C = 'run_2b7c6a52-8e0e-4c4e-9c6f-1f2a3b4c5d6e'
    await store.save(run(RUN_A, { status: 'paused', createdAt: 3 }))
    await store.save(run(RUN_B, { status: 'paused', canvasId: 'c2', createdAt: 2 }))
    await store.save(run(RUN_C, { status: 'done', createdAt: 1 }))
    await store.save(run('run_3b7c6a52-8e0e-4c4e-9c6f-1f2a3b4c5d6e', { status: 'paused', canvasId: null, createdAt: 4 }))
    seen.length = 0
    expect((await store.listForUser('u1', { canvasId: 'c1', statuses: ['paused'] })).map(r => r.id)).toEqual([RUN_A])
    expect(seen[0]!.params).toEqual(['u1', 'c1', ['paused']])
    expect((await store.listForUser('u1', { canvasId: null })).map(r => r.id)).toEqual(['run_3b7c6a52-8e0e-4c4e-9c6f-1f2a3b4c5d6e'])
    // no filters: every run of this user, oldest first
    expect((await store.listForUser('u1')).map(r => r.id)).toEqual([RUN_C, RUN_B, RUN_A, 'run_3b7c6a52-8e0e-4c4e-9c6f-1f2a3b4c5d6e'])
    expect(seen.at(-1)!.params).toEqual(['u1'])
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
