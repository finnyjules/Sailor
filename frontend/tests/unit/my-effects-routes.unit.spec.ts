/**
 * Stage 5 Task 4: real route-handler integration for /api/my-effects — the
 * per-user store of saved shader-gen effects. Drives the ACTUAL list/get/put/
 * patch/delete handlers against a faked resource_owners table and a temp
 * SAILOR_DATA_DIR (owned-stores-routes.unit.spec.ts pattern), with local mode
 * (everything visible) and hosted mode (strictly the caller's own — an
 * unowned record is never shown to anyone, unlike the curated stores).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __setResourceOwnersDbForTests } from '../../server/utils/resourceOwners'
import { SPIKE_TAKES } from '../../app/lib/shadergen/__eval__/spikeTakes'
import { MY_EFFECT_LIMITS } from '../../shared/myEffects/record'
import { NITRO_API_PREFIXES, isNitroApiPath } from '../../server/lib/nitroApiPaths'

const g = globalThis as any
g.defineEventHandler = (fn: any) => fn
g.readBody = async (event: any) => event.body ?? {}
g.getQuery = (event: any) => event.query ?? {}
g.getRouterParam = (event: any, k: string) => event.params?.[k]
g.createError = (opts: { statusCode: number, message?: string, statusMessage?: string }) => {
  const err = new Error(opts.message ?? opts.statusMessage ?? 'error') as Error & { statusCode: number }
  err.statusCode = opts.statusCode
  return err
}

const CLERK_KEY = 'NUXT_CLERK_SECRET_KEY'
const savedClerk = process.env[CLERK_KEY]
const savedDataDir = process.env.SAILOR_DATA_DIR
function setHosted(): void { process.env[CLERK_KEY] = 'sk_test_hosted' }
function setLocal(): void { delete process.env[CLERK_KEY] }

// In-memory resource_owners table.
const owners = new Map<string, string>()
const query = vi.fn(async (sql: string, params: any[] = []) => {
  if (/INSERT INTO resource_owners/i.test(sql)) {
    const [kind, id, uid] = params
    const k = `${kind}:${id}`
    if (!owners.has(k)) owners.set(k, uid)
    return { rows: [] }
  }
  if (/SELECT user_id FROM resource_owners/i.test(sql)) {
    const [kind, id] = params
    const v = owners.get(`${kind}:${id}`)
    return { rows: v ? [{ user_id: v }] : [] }
  }
  if (/SELECT resource_id FROM resource_owners/i.test(sql)) {
    const [kind, uid] = params
    const rows = [...owners.entries()]
      .filter(([k, u]) => k.startsWith(`${kind}:`) && u === uid)
      .map(([k]) => ({ resource_id: k.slice(kind.length + 1) }))
    return { rows }
  }
  if (/DELETE FROM resource_owners/i.test(sql)) {
    const [kind, id] = params
    owners.delete(`${kind}:${id}`)
    return { rows: [] }
  }
  return { rows: [] }
})

const t = SPIKE_TAKES.rain![2]!
const rec = (id: string, name = 'Rain on glass') => ({
  id, name, from: null, animated: true, generative: false, createdAt: 'x', updatedAt: 'x',
  versions: [{ label: 'v1', body: t.body, params: t.params, values: {}, note: 'rain', createdAt: 'x' }],
})
const A = 'mine_aaaaaaaaaaaa', B = 'mine_bbbbbbbbbbbb'

let dataDir: string
let list: any, get: any, put: any, patch: any, del: any

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'sailor-my-effects-'))
  process.env.SAILOR_DATA_DIR = dataDir
  list = (await import('../../server/api/my-effects/index.get')).default
  get = (await import('../../server/api/my-effects/[id].get')).default
  put = (await import('../../server/api/my-effects/[id].put')).default
  patch = (await import('../../server/api/my-effects/[id].patch')).default
  del = (await import('../../server/api/my-effects/[id].delete')).default
})
afterAll(() => {
  if (savedDataDir === undefined) delete process.env.SAILOR_DATA_DIR
  else process.env.SAILOR_DATA_DIR = savedDataDir
})

beforeEach(() => {
  owners.clear()
  query.mockClear()
  __setResourceOwnersDbForTests({ query } as any)
  rmSync(join(dataDir, 'my-effects'), { recursive: true, force: true })
  setLocal()
})
afterEach(() => {
  if (savedClerk === undefined) delete process.env[CLERK_KEY]
  else process.env[CLERK_KEY] = savedClerk
})

const ev = (o: { id?: string, body?: any, userId?: string | null } = {}) => ({ params: o.id ? { id: o.id } : {}, body: o.body, context: { userId: o.userId ?? null } })

describe('/api/my-effects (local)', () => {
  it('is a Nitro route', () => {
    expect(NITRO_API_PREFIXES).toContain('/api/my-effects')
    expect(isNitroApiPath('/api/my-effects')).toBe(true)
    expect(isNitroApiPath(`/api/my-effects/${A}`)).toBe(true)
  })

  it('save, list, get, rename, delete', async () => {
    const saved = await put(ev({ id: A, body: rec(A) }))
    expect(saved.id).toBe(A)
    expect(saved.updatedAt).not.toBe('x')
    expect((await list(ev())).effects.map((e: any) => e.id)).toEqual([A])
    expect((await get(ev({ id: A }))).name).toBe('Rain on glass')
    expect((await patch(ev({ id: A, body: { name: '  Wet   glass ' } }))).name).toBe('Wet glass')
    expect(await del(ev({ id: A }))).toEqual({ ok: true, id: A })
    await expect(get(ev({ id: A }))).rejects.toMatchObject({ statusCode: 404 })
  })

  it('refuses a mismatched id, a bad record, and an unknown id to rename', async () => {
    await expect(put(ev({ id: A, body: rec(B) }))).rejects.toMatchObject({ statusCode: 400 })
    await expect(put(ev({ id: A, body: { ...rec(A), versions: [] } }))).rejects.toMatchObject({ statusCode: 400 })
    await expect(put(ev({ id: 'rain', body: rec('rain') }))).rejects.toMatchObject({ statusCode: 400 })
    await expect(patch(ev({ id: A, body: { name: 'x' } }))).rejects.toMatchObject({ statusCode: 404 })
  })

  it('stops at the effect cap for a NEW id, never for an update', async () => {
    const dir = join(dataDir, 'my-effects'); mkdirSync(dir, { recursive: true })
    for (let i = 0; i < MY_EFFECT_LIMITS.maxEffects; i++) {
      const id = `mine_${String(i).padStart(12, '0')}`
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(rec(id)))
    }
    await expect(put(ev({ id: A, body: rec(A) }))).rejects.toMatchObject({ statusCode: 409 })
    await expect(put(ev({ id: 'mine_000000000000', body: rec('mine_000000000000', 'Renamed') }))).resolves.toBeTruthy()
  })
})

describe('/api/my-effects (hosted): strictly your own', () => {
  beforeEach(setHosted)

  it('lists and reads only the caller’s effects (no unowned ones)', async () => {
    await put(ev({ id: A, body: rec(A), userId: 'u1' }))
    await put(ev({ id: B, body: rec(B), userId: 'u2' }))
    const dir = join(dataDir, 'my-effects')
    writeFileSync(join(dir, 'mine_cccccccccccc.json'), JSON.stringify(rec('mine_cccccccccccc'))) // no owner row
    expect((await list(ev({ userId: 'u1' }))).effects.map((e: any) => e.id)).toEqual([A])
    await expect(get(ev({ id: B, userId: 'u1' }))).rejects.toMatchObject({ statusCode: 404 })
    await expect(get(ev({ id: 'mine_cccccccccccc', userId: 'u1' }))).rejects.toMatchObject({ statusCode: 404 })
  })

  it('can’t overwrite, rename or delete someone else’s', async () => {
    await put(ev({ id: A, body: rec(A), userId: 'u1' }))
    await expect(put(ev({ id: A, body: rec(A, 'Mine now'), userId: 'u2' }))).rejects.toMatchObject({ statusCode: 404 })
    await expect(patch(ev({ id: A, body: { name: 'x' }, userId: 'u2' }))).rejects.toMatchObject({ statusCode: 404 })
    await expect(del(ev({ id: A, userId: 'u2' }))).rejects.toMatchObject({ statusCode: 404 })
  })

  it('a signed-out request sees nothing', async () => {
    await put(ev({ id: A, body: rec(A), userId: 'u1' }))
    expect((await list(ev({ userId: null }))).effects).toEqual([])
  })
})
