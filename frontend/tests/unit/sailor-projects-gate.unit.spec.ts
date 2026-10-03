/**
 * Stage 6 Task 2 — the `/sailor` projects extension is tenant-gated.
 *
 * THE LIVE P0 THIS CLOSES: `/sailor` sat on `HOSTED_RAW_ALLOW`, so every route
 * in `comfy_extras/nodes_sailor_projects.py` was reachable RAW by any signed-in
 * hosted user. Those handlers take the project uuid straight off the path and
 * check exactly one thing — `_is_safe_id` (path traversal). There is no
 * identity in the request at all, and no identity on disk. So a signed-in
 * tenant could:
 *
 *   GET    /sailor/projects              → every tenant's project index
 *   GET    /sailor/projects/<uuid>       → someone else's graph, verbatim
 *   PUT    /sailor/projects/<uuid>       → rename someone else's project
 *   DELETE /sailor/projects/<uuid>       → destroy it
 *   POST   /sailor/projects/<uuid>/versions → overwrite their rolling save
 *   GET    /sailor/spend/summary         → the whole install's spend ledger
 *
 * This is the product's saved-work store, so the gate is written like security
 * code: fail closed, and a resource the caller does not own answers 404 rather
 * than 403 — a 403 would confirm the uuid exists, turning the gate into an
 * enumeration oracle for the very ids it protects.
 *
 * PROJECTS ARE PERSONAL. The Stage-6 "unowned = curated/global, readable by
 * all" rule (resourceOwners.hostedCanRead) deliberately does NOT apply here:
 * an unowned project is somebody's orphaned saved work, not house content, so
 * it is invisible in the list and 404s on read. The only thing an unowned uuid
 * permits is a WRITE that creates it (that is how a brand-new project is born;
 * a project owned by anyone else refuses the same write).
 *
 * These tests drive the REAL middleware and the REAL handler (the harness from
 * engine-upload-ownership.unit.spec.ts) with a faked ownership table, so they
 * fail against the pre-fix tree instead of merely describing a new helper.
 *
 * Engine-free Phase A: the projects are no longer forwarded to ComfyUI — the
 * gate hands the request to Sailor's native storage (server/native/projects.ts)
 * AFTER its ownership decision. The storage here is a temp engine root, and
 * "engine untouched" is asserted on disk (and no fetch is ever made).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The cached engine-health check (server/native/engineHealth.ts) is stubbed:
// its 3 s process-wide cache would otherwise carry one test's engine state
// into the next, and a real probe would reach whatever is on :8188. 'up'
// (the default) defers to each test's own fetch stub, as before the check.
const engineHealthState = vi.hoisted(() => ({ value: 'up' as 'up' | 'down' }))
vi.mock('../../server/native/engineHealth', async orig => ({
  ...(await orig() as object),
  engineHealth: async () => engineHealthState.value,
}))
beforeEach(() => { engineHealthState.value = 'up' })
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const rawBody = vi.fn(async () => undefined as Buffer | undefined)
const requestHeader = vi.fn((_e: any, _n: string) => undefined as string | undefined)
vi.mock('h3', async (orig) => {
  const actual = await orig() as any
  return {
    ...actual,
    readRawBody: (...a: any[]) => rawBody(...(a as [])),
    getRequestHeader: (...a: any[]) => requestHeader(...(a as [any, string])),
    setResponseStatus: (_e: any, s: number) => { lastStatus = s },
  }
})

let lastStatus = 0

let mode: 'local' | 'hosted' = 'hosted'
vi.mock('../../server/utils/deployMode', () => ({
  deployMode: () => mode,
  isHosted: () => mode === 'hosted',
}))

// Nitro auto-imports the real middleware uses at module scope.
const g = globalThis as any
g.defineEventHandler = (fn: any) => fn
g.createError = (o: { statusCode: number, message?: string, statusMessage?: string }) => {
  const err = new Error(o.message ?? o.statusMessage) as Error & { statusCode: number }
  err.statusCode = o.statusCode
  return err
}
const proxyRequest = vi.fn(async (_e: any, url: string) => ({ proxiedTo: url }))
g.proxyRequest = proxyRequest

const { handleHostedSailor, sailorProjectsRoute } = await import('../../server/utils/engineGate')
const { hostedEngineDecision, normalizeEnginePath } = await import('../../server/utils/enginePath')
const { __setResourceOwnersDbForTests } = await import('../../server/utils/resourceOwners')
const middleware = (await import('../../server/middleware/comfyui-proxy')).default as any
const { __setInputUploadsEngineRootForTests } = await import('../../server/utils/inputUploads')
const P = await import('../../server/native/projects')

// ---------------------------------------------------------------- fake table

const owners = new Map<string, string>()
const queries: string[] = []
const key = (kind: string, id: string) => `${kind}::${id}`

__setResourceOwnersDbForTests({
  async query(sql: string, params: unknown[] = []) {
    queries.push(sql)
    if (/insert\s+into\s+resource_owners/i.test(sql)) {
      const [kind, id, user] = params as string[]
      if (!owners.has(key(kind, id))) owners.set(key(kind, id), user) // ON CONFLICT DO NOTHING
      return { rows: [] }
    }
    if (/delete\s+from\s+resource_owners/i.test(sql)) {
      const [kind, id] = params as string[]
      owners.delete(key(kind, id))
      return { rows: [] }
    }
    if (/select\s+user_id\s+from\s+resource_owners/i.test(sql)) {
      const [kind, id] = params as string[]
      const u = owners.get(key(kind, id))
      return { rows: u ? [{ user_id: u }] : [] }
    }
    if (/select\s+resource_id\s+from\s+resource_owners/i.test(sql)) {
      const [kind, user] = params as string[]
      const rows = [...owners.entries()]
        .filter(([k, u]) => k.startsWith(`${kind}::`) && u === user)
        .map(([k]) => ({ resource_id: k.slice(kind.length + 2) }))
      return { rows }
    }
    throw new Error(`unexpected sql: ${sql}`)
  },
})

const fetchMock = vi.fn()
;(globalThis as any).fetch = fetchMock

/** Upstream answers with this JSON + status unless a test overrides it. */
function upstream(body: unknown, status = 200) {
  fetchMock.mockResolvedValue({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) })
}

let engineRoot = ''
let root = ''

/** Put a project on disk the way the storage writes it. */
function seed(uuid: string, fields: Record<string, unknown> = {}) {
  P.ensureProject(root, uuid, { name: String(fields.name ?? uuid), now: 1 })
  if (Object.keys(fields).length) P.writeProject(root, { ...P.readProject(root, uuid), ...fields })
}
const onDisk = (uuid: string) => fs.existsSync(path.join(root, uuid))
const body = (json: string) => rawBody.mockResolvedValue(Buffer.from(json))

afterEach(() => {
  __setInputUploadsEngineRootForTests(undefined)
  fs.rmSync(engineRoot, { recursive: true, force: true })
})

beforeEach(() => {
  engineRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sailor-projects-gate-'))
  root = path.join(engineRoot, 'user', 'sailor', 'projects')
  __setInputUploadsEngineRootForTests(engineRoot)
  mode = 'hosted'
  fetchMock.mockReset()
  upstream({ ok: true })
  proxyRequest.mockClear()
  rawBody.mockReset()
  rawBody.mockResolvedValue(undefined)
  requestHeader.mockReset()
  requestHeader.mockReturnValue(undefined)
  owners.clear()
  queries.length = 0
  lastStatus = 0
  owners.set(key('project', 'p-mine'), 'u1')
  owners.set(key('project', 'p-theirs'), 'u2')
  // 'p-orphan' deliberately has NO row — unowned.
})

function ev(path: string, method = 'GET', userId: string | null = 'u1') {
  return { path, method, context: userId ? { userId } : {}, node: { req: {}, res: {} } }
}

/** Drive the real handler; return the status code on refusal, else the body. */
async function call(path: string, method = 'GET', userId: string | null = 'u1'): Promise<any> {
  try {
    return { body: await handleHostedSailor(ev(path, method, userId) as any), status: lastStatus }
  }
  catch (e: any) {
    return { status: e?.statusCode ?? 'threw', message: e?.message }
  }
}

/** Drive the real middleware end to end (decision + handler + proxy). */
async function via(path: string, method = 'GET', userId: string | null = 'u1'): Promise<any> {
  try {
    const res = await middleware(ev(path, method, userId))
    if (res === undefined) return { status: 'passthrough' }
    if (proxyRequest.mock.calls.length) return { status: 'proxied', target: proxyRequest.mock.calls[0]?.[1] }
    return { body: res, status: lastStatus }
  }
  catch (e: any) {
    return { status: e?.statusCode ?? 'threw', message: e?.message }
  }
}

// ------------------------------------------------------------ the decision

describe('hostedEngineDecision: /sailor is no longer a blanket raw allow', () => {
  it('routes every projects route to the tenant gate', () => {
    for (const [p, m] of [
      ['/sailor/projects', 'GET'],
      ['/sailor/projects/abc', 'GET'],
      ['/sailor/projects/abc', 'PUT'],
      ['/sailor/projects/abc', 'DELETE'],
      ['/sailor/projects/abc/versions', 'POST'],
      ['/sailor/projects/abc/versions/v_1', 'GET'],
      ['/sailor/projects/abc/generations', 'POST'],
      ['/sailor/projects/abc/generations', 'GET'],
    ] as const) {
      expect(hostedEngineDecision(p, m).kind, `${m} ${p}`).toBe('sailorProjects')
    }
  })

  it('refuses the install-wide spend summary — operator data', () => {
    for (const p of ['/sailor/spend', '/sailor/spend/summary']) {
      const d = hostedEngineDecision(p, 'GET') as { kind: string, message: string }
      expect(d.kind, p).toBe('forbid')
      expect(d.message).toMatch(/operator/i)
    }
  })

  it('takes the decision on the NORMALIZED path so aliases cannot walk past it', () => {
    expect(hostedEngineDecision(normalizeEnginePath('/comfyui/sailor/projects/abc'), 'DELETE').kind).toBe('sailorProjects')
    expect(hostedEngineDecision(normalizeEnginePath('/comfyui/sailor/spend/summary'), 'GET').kind).toBe('forbid')
    // A dot segment must not carry a projects path into the raw-proxy branch.
    expect(hostedEngineDecision(normalizeEnginePath('/sailor/assets/../projects/abc'), 'DELETE').kind).toBe('sailorProjects')
  })
})

// ------------------------------------------------------------- route parsing

describe('sailorProjectsRoute — the pure path/verb table', () => {
  it('maps each engine route to its access class', () => {
    expect(sailorProjectsRoute('/sailor/projects', 'GET')).toEqual({ kind: 'list' })
    expect(sailorProjectsRoute('/sailor/projects/abc', 'GET')).toEqual({ kind: 'project', uuid: 'abc', access: 'read' })
    expect(sailorProjectsRoute('/sailor/projects/abc', 'PUT')).toEqual({ kind: 'project', uuid: 'abc', access: 'write' })
    expect(sailorProjectsRoute('/sailor/projects/abc', 'DELETE')).toEqual({ kind: 'project', uuid: 'abc', access: 'delete' })
    expect(sailorProjectsRoute('/sailor/projects/abc/versions', 'POST')).toEqual({ kind: 'project', uuid: 'abc', access: 'write' })
    expect(sailorProjectsRoute('/sailor/projects/abc/versions/v_1', 'GET')).toEqual({ kind: 'project', uuid: 'abc', access: 'read' })
    expect(sailorProjectsRoute('/sailor/projects/abc/generations', 'POST')).toEqual({ kind: 'project', uuid: 'abc', access: 'write' })
    expect(sailorProjectsRoute('/sailor/projects/abc/generations', 'GET')).toEqual({ kind: 'project', uuid: 'abc', access: 'read' })
  })

  it('rejects a verb the aiohttp route table does not serve', () => {
    for (const [p, m] of [
      ['/sailor/projects', 'PUT'], ['/sailor/projects', 'POST'], ['/sailor/projects', 'DELETE'],
      ['/sailor/projects/abc', 'POST'], ['/sailor/projects/abc', 'PATCH'],
      ['/sailor/projects/abc/versions', 'GET'], ['/sailor/projects/abc/versions', 'DELETE'],
      ['/sailor/projects/abc/versions/v_1', 'PUT'], ['/sailor/projects/abc/generations', 'DELETE'],
    ] as const) {
      expect(sailorProjectsRoute(p, m).kind, `${m} ${p}`).toBe('reject')
    }
  })

  it('rejects an unknown subroute rather than forwarding it', () => {
    for (const p of ['/sailor/projects/abc/secrets', '/sailor/projects/abc/versions/v_1/extra', '/sailor/projects/a/b/c/d']) {
      const r = sailorProjectsRoute(p, 'GET') as { kind: string, status: number }
      expect(r.kind, p).toBe('reject')
      expect(r.status, p).toBe(404)
    }
  })

  it('decodes the uuid the way aiohttp will — one resource, one ownership key', () => {
    // aiohttp percent-decodes match_info, so `%70-mine` and `p-mine` are the
    // SAME project on disk. Keying ownership off the raw segment would let the
    // encoded spelling walk past the owner check.
    expect(sailorProjectsRoute('/sailor/projects/%70-mine', 'GET')).toEqual({ kind: 'project', uuid: 'p-mine', access: 'read' })
  })

  it('refuses an id the engine would treat as unsafe, and malformed encodings', () => {
    for (const p of ['/sailor/projects/..%2fetc', '/sailor/projects/.hidden', '/sailor/projects/%2e%2e%2fx', '/sailor/projects/a%2fb', '/sailor/projects/%zz']) {
      const r = sailorProjectsRoute(p, 'GET') as { kind: string, status: number }
      expect(r.kind, p).toBe('reject')
      expect(r.status, p).toBe(400)
    }
  })
})


// -------------------------------------------------------------- the list

describe('GET /sailor/projects — the index shows only the caller\'s projects', () => {
  it('drops other tenants\' projects AND unowned ones', async () => {
    seed('p-mine', { updatedAt: 3 })
    seed('p-theirs', { updatedAt: 2 })
    seed('p-orphan', { updatedAt: 1 })
    const { body } = await call('/sailor/projects')
    expect(body.projects.map((p: any) => p.uuid)).toEqual(['p-mine'])
  })

  it('an UNOWNED project is invisible — projects are personal, not curated content', async () => {
    // The Stage-6 unowned-is-global READ rule (hostedCanRead) must not reach
    // this list: an orphaned project is someone's saved work.
    seed('p-orphan', { updatedAt: 1 })
    const { body } = await call('/sailor/projects')
    expect(body.projects).toEqual([])
  })

  it('serves each surviving entry as the index view and adds no other top-level keys', async () => {
    seed('p-mine', { name: 'Mine', cover: 'c.png', updatedAt: 7, secretTotals: { usd: 12 } })
    const { body } = await call('/sailor/projects')
    expect(body).toEqual({ projects: [{ uuid: 'p-mine', name: 'Mine', cover: 'c.png', updatedAt: 7 }] })
  })

  it('is empty — not unfiltered — when the caller owns nothing', async () => {
    owners.clear()
    seed('p-theirs')
    seed('p-orphan')
    const { body } = await call('/sailor/projects')
    expect(body.projects).toEqual([])
  })

  it('skips a corrupt project file rather than failing the list', async () => {
    seed('p-mine', { updatedAt: 3 })
    fs.mkdirSync(path.join(root, 'p-broken'), { recursive: true })
    fs.writeFileSync(path.join(root, 'p-broken', 'project.json'), '{ nope')
    owners.set(key('project', 'p-broken'), 'u1')
    const { body } = await call('/sailor/projects')
    expect(body.projects.map((p: any) => p.uuid)).toEqual(['p-mine'])
  })

  it('503s when the data folder cannot be found rather than serving anything', async () => {
    __setInputUploadsEngineRootForTests(null)
    expect((await call('/sailor/projects')).status).toBe(503)
  })

  // A2 follow-up fix, item 7 (carried from A1): listOwnedProjects reads
  // projectsRoot(userDir()) directly rather than going through
  // dispatchNative/context() — the ONLY other place ensureBootMigrationsRan
  // is called — so a volume that still has its pre-rebrand `user/comfynext`
  // dir (never yet renamed to `user/sailor`) served an EMPTY list on the very
  // first `GET /sailor/projects`, even though the data is right there.
  it('runs the boot migration before reading, so a legacy comfynext user dir is found on the first list request', async () => {
    // No `user/sailor` yet at all — only the pre-rename `user/comfynext`,
    // exactly the shape of an old Fly volume that predates the rebrand.
    const legacyProjectDir = path.join(engineRoot, 'user', 'comfynext', 'projects', 'p-legacy')
    fs.mkdirSync(legacyProjectDir, { recursive: true })
    fs.writeFileSync(
      path.join(legacyProjectDir, 'project.json'),
      JSON.stringify({ uuid: 'p-legacy', name: 'Legacy', updatedAt: 1 }),
    )
    owners.set(key('project', 'p-legacy'), 'u1')

    const { body } = await call('/sailor/projects')

    expect(body.projects.map((p: any) => p.uuid)).toEqual(['p-legacy'])
    expect(fs.existsSync(path.join(engineRoot, 'user', 'comfynext'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'p-legacy', 'project.json'))).toBe(true)
  })
})

// ------------------------------------------------------- per-project reads

describe('GET /sailor/projects/<uuid> — 404 for anything not yours', () => {
  it('serves the owner\'s own project from storage, without calling the engine', async () => {
    seed('p-mine', { name: 'Mine' })
    P.writeVersion(root, 'p-mine', { id: 'current', name: 'Mine', createdAt: 5 }, { now: 5 })
    const { body, status } = await call('/sailor/projects/p-mine')
    expect(status).toBe(200)
    expect(body.project).toMatchObject({ uuid: 'p-mine', name: 'Mine', currentVersionId: 'current' })
    expect(body.currentVersion).toEqual({ id: 'current', name: 'Mine', createdAt: 5 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('404s another tenant\'s project WITHOUT touching the engine', async () => {
    seed('p-theirs')
    const r = await call('/sailor/projects/p-theirs')
    expect(r.status).toBe(404)
    expect(r.message).not.toMatch(/permission|forbidden|owner/i) // must not confirm it exists
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('404s an unowned project — orphaned saved work is not curated content', async () => {
    seed('p-orphan')
    expect((await call('/sailor/projects/p-orphan')).status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('applies the same rule to the version and generation subroutes', async () => {
    seed('p-theirs')
    seed('p-orphan')
    for (const p of [
      '/sailor/projects/p-theirs/versions/v_1',
      '/sailor/projects/p-theirs/generations',
      '/sailor/projects/p-orphan/versions/v_1',
      '/sailor/projects/p-orphan/generations',
    ]) {
      expect((await call(p, 'GET')).status, p).toBe(404)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('serves owned subroutes', async () => {
    seed('p-mine')
    P.writeVersion(root, 'p-mine', { id: 'v_1', createdAt: 5 }, { now: 5 })
    P.appendGeneration(root, 'p-mine', { id: 'g_1', ts: 9 })
    expect((await call('/sailor/projects/p-mine/versions/v_1', 'GET')).body).toEqual({ version: { id: 'v_1', createdAt: 5 } })
    expect((await call('/sailor/projects/p-mine/generations', 'GET')).body).toEqual({ generations: [{ id: 'g_1', ts: 9 }] })
  })

  it('honours the encoded spelling of an id it does not own', async () => {
    seed('p-theirs')
    expect((await call('/sailor/projects/%70-theirs')).status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ------------------------------------------------------ per-project writes

describe('PUT /sailor/projects/<uuid> — writes claim, or are refused', () => {
  it('writes a NEW uuid and records ownership on success', async () => {
    body('{"name":"Fresh"}')
    requestHeader.mockImplementation((_e: any, n: string) => (n === 'content-type' ? 'application/json' : undefined))
    const r = await call('/sailor/projects/p-new', 'PUT')
    expect(r.status).toBe(200)
    expect(r.body.project).toMatchObject({ uuid: 'p-new', name: 'Fresh' })
    expect(P.readProject(root, 'p-new').name).toBe('Fresh')
    expect(owners.get(key('project', 'p-new'))).toBe('u1')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does NOT claim a uuid the storage refused to write', async () => {
    body('{ not json')
    const r = await call('/sailor/projects/p-new', 'PUT')
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/^bad json: /)
    expect(owners.has(key('project', 'p-new'))).toBe(false)
    expect(onDisk('p-new')).toBe(false)
  })

  it('404s a write to another tenant\'s project, storage untouched', async () => {
    seed('p-theirs', { name: 'Theirs' })
    body('{"name":"pwned"}')
    expect((await call('/sailor/projects/p-theirs', 'PUT')).status).toBe(404)
    expect(P.readProject(root, 'p-theirs').name).toBe('Theirs')
    expect(owners.get(key('project', 'p-theirs'))).toBe('u2')
  })

  it('lets the owner keep writing without re-claiming', async () => {
    seed('p-mine')
    body('{"name":"Renamed"}')
    expect((await call('/sailor/projects/p-mine', 'PUT')).body.project).toMatchObject({ uuid: 'p-mine', name: 'Renamed' })
    expect(owners.get(key('project', 'p-mine'))).toBe('u1')
  })

  it('applies the identical rule to version + generation POSTs (they ensure_project too)', async () => {
    seed('p-theirs')
    seed('p-mine')
    body('{"version":{"id":"current"}}')
    // another tenant's project: refused, storage untouched
    for (const p of ['/sailor/projects/p-theirs/versions', '/sailor/projects/p-theirs/generations']) {
      expect((await call(p, 'POST')).status, p).toBe(404)
    }
    expect(P.readProject(root, 'p-theirs').versionIndex).toEqual([])
    expect(P.listGenerations(root, 'p-theirs')).toEqual([])
    // a brand-new uuid: the subroute CREATES the project, so it must claim it
    // — otherwise the project stays unowned and invisible forever.
    expect((await call('/sailor/projects/p-fresh/versions', 'POST')).body).toEqual({ id: 'current' })
    expect(onDisk('p-fresh')).toBe(true)
    expect(owners.get(key('project', 'p-fresh'))).toBe('u1')
    // and the owner's own project keeps working
    const gen = await call('/sailor/projects/p-mine/generations', 'POST')
    expect(gen.status).toBe(200)
    expect(gen.body.id).toMatch(/^g_[0-9a-f]{12}$/)
  })

  it('passes a 409 (stale rolling write) through verbatim', async () => {
    seed('p-mine')
    P.writeVersion(root, 'p-mine', { id: 'current', workflow: { savedAt: 42 } }, { now: 5 })
    body('{"version":{"id":"current","workflow":{"savedAt":1}}}')
    const r = await call('/sailor/projects/p-mine/versions', 'POST')
    expect(r.status).toBe(409)
    expect(r.body).toEqual({ error: 'stale', storedSavedAt: 42 })
  })
})

describe('DELETE /sailor/projects/<uuid>', () => {
  it('deletes the owner\'s project and releases the ownership row', async () => {
    seed('p-mine')
    expect((await call('/sailor/projects/p-mine', 'DELETE')).body).toEqual({ ok: true })
    expect(onDisk('p-mine')).toBe(false)
    expect(owners.has(key('project', 'p-mine'))).toBe(false)
  })

  it('404s another tenant\'s project and an unowned one, storage untouched', async () => {
    seed('p-theirs')
    seed('p-orphan')
    for (const p of ['/sailor/projects/p-theirs', '/sailor/projects/p-orphan']) {
      expect((await call(p, 'DELETE')).status, p).toBe(404)
    }
    expect(onDisk('p-theirs')).toBe(true)
    expect(onDisk('p-orphan')).toBe(true)
    expect(owners.get(key('project', 'p-theirs'))).toBe('u2')
  })

  it('keeps the ownership row when the storage could not delete', async () => {
    seed('p-mine')
    __setInputUploadsEngineRootForTests(null)
    expect((await call('/sailor/projects/p-mine', 'DELETE')).status).toBe(503)
    expect(owners.get(key('project', 'p-mine'))).toBe('u1')
  })
})

// ---------------------------------------------------------------- envelope

describe('the gate\'s envelope: auth, verbs, aliases', () => {
  it('401s an unauthenticated caller before any ownership lookup', async () => {
    expect((await call('/sailor/projects', 'GET', null)).status).toBe(401)
    expect(queries).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('405s a verb the route table does not serve — never a raw proxy', async () => {
    for (const [p, m] of [['/sailor/projects', 'DELETE'], ['/sailor/projects/p-mine', 'POST'], ['/sailor/projects/p-mine/versions', 'DELETE']] as const) {
      expect((await call(p, m)).status, `${m} ${p}`).toBe(405)
    }
    expect(fetchMock).not.toHaveBeenCalled()
    expect(proxyRequest).not.toHaveBeenCalled()
  })

  it('serves the same store whatever the query says', async () => {
    seed('p-mine', { name: 'Mine' })
    expect((await call('/sailor/projects/p-mine?x=2')).body.project.name).toBe('Mine')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('serves the /comfyui alias from the same store', async () => {
    seed('p-mine', { name: 'Mine' })
    expect((await call('/comfyui/sailor/projects/p-mine')).body.project.name).toBe('Mine')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ------------------------------------------------------- middleware wiring

describe('hosted middleware: every alias reaches the gate, none reach the raw proxy', () => {
  it('gates the canonical and /comfyui-aliased projects routes', async () => {
    seed('p-theirs')
    for (const p of ['/sailor/projects/p-theirs', '/comfyui/sailor/projects/p-theirs', '/sailor/assets/../projects/p-theirs']) {
      proxyRequest.mockClear(); fetchMock.mockClear()
      const r = await via(p, 'GET')
      expect(r.status, p).toBe(404)
      expect(proxyRequest, p).not.toHaveBeenCalled()
      expect(fetchMock, p).not.toHaveBeenCalled()
    }
  })

  it('refuses the /api mirror of the projects routes outright', async () => {
    // ComfyUI mirrored EVERY route under /api (server.py:1207-1218), including
    // this extension's. `/sailor` is not in ENGINE_ROUTE_PREFIXES, so the alias
    // never normalizes — and the deny-by-default tail refuses it. Either way it
    // must never raw-proxy, and the native store is never reached ungated.
    seed('p-theirs')
    for (const p of ['/api/sailor/projects', '/api/sailor/projects/p-theirs', '/comfyui/api/sailor/projects/p-theirs']) {
      proxyRequest.mockClear()
      const r = await via(p, 'GET')
      expect(r.status, p).toBe(403)
      expect(proxyRequest, p).not.toHaveBeenCalled()
    }
  })

  it('403s the install-wide spend summary and its aliases', async () => {
    for (const p of ['/sailor/spend/summary', '/comfyui/sailor/spend/summary', '/sailor/spend']) {
      proxyRequest.mockClear()
      expect((await via(p, 'GET')).status, p).toBe(403)
      expect(proxyRequest, p).not.toHaveBeenCalled()
    }
  })

  it('serves the caller\'s own list end to end through the middleware', async () => {
    seed('p-mine', { updatedAt: 2 })
    seed('p-theirs', { updatedAt: 1 })
    const r = await via('/sailor/projects')
    expect(r.body.projects.map((p: any) => p.uuid)).toEqual(['p-mine'])
    expect(proxyRequest).not.toHaveBeenCalled()
  })
})

// ------------------------------------------------------------- local mode

describe('LOCAL MODE — single user: no registry, no filter; projects served natively', () => {
  it('serves every projects + spend route from native storage, never the proxy', async () => {
    mode = 'local'
    seed('p-theirs', { name: 'Theirs' })
    const cases: [string, string, (r: any) => void][] = [
      ['/sailor/projects', 'GET', r => expect(r.body.projects.map((p: any) => p.uuid)).toEqual(['p-theirs'])],
      ['/sailor/projects/p-theirs', 'GET', r => expect(r.body.project.name).toBe('Theirs')],
      ['/comfyui/sailor/projects', 'GET', r => expect(r.body.projects).toHaveLength(1)],
      ['/api/sailor/projects', 'GET', r => expect(r.body.projects).toHaveLength(1)],
      ['/sailor/projects?x=2', 'GET', r => expect(r.body.projects).toHaveLength(1)],
      ['/sailor/projects/p-orphan/generations', 'GET', r => expect(r.body).toEqual({ generations: [] })],
      ['/sailor/spend/summary', 'GET', r => expect(r.body).toEqual({ month: { usd: 0, credits: 0 }, total: { usd: 0, credits: 0 }, byProject: [] })],
    ]
    for (const [p, m, check] of cases) {
      proxyRequest.mockClear()
      const r = await via(p, m, null)
      expect(proxyRequest, `${m} ${p}`).not.toHaveBeenCalled()
      check(r)
    }
    body('{"name":"Renamed"}')
    expect((await via('/sailor/projects/p-theirs', 'PUT', null)).body.project.name).toBe('Renamed')
    body('{"version":{"id":"v_1"}}')
    expect((await via('/sailor/projects/p-orphan/versions', 'POST', null)).body).toEqual({ id: 'v_1' })
    expect((await via('/sailor/projects/p-theirs', 'DELETE', null)).body).toEqual({ ok: true })
    expect(onDisk('p-theirs')).toBe(false)
  })

  it('still raw-proxies the /sailor routes that are not native yet', async () => {
    mode = 'local'
    for (const [p, target] of [
      ['/sailor/render_timeline', 'http://127.0.0.1:8188/sailor/render_timeline'],
      ['/sailor/spacetype_encode?x=2', 'http://127.0.0.1:8188/sailor/spacetype_encode?x=2'],
    ] as const) {
      proxyRequest.mockClear()
      const r = await via(p, 'GET', null)
      expect(r.status, p).toBe('proxied')
      expect(r.target, p).toBe(target)
    }
  })

  it('never consults the ownership registry or makes an engine fetch locally', async () => {
    mode = 'local'
    seed('p-theirs')
    for (const [p, m] of [['/sailor/projects', 'GET'], ['/sailor/projects/p-theirs', 'GET'], ['/sailor/projects/p-theirs', 'DELETE'], ['/sailor/spend/summary', 'GET'], ['/sailor/assets', 'GET']] as const) {
      await via(p, m, null)
    }
    expect(queries, 'local mode must never query resource_owners').toEqual([])
    expect(fetchMock, 'local mode must never fetch the engine for native routes').not.toHaveBeenCalled()
  })
})

// ------------------------------------------------- non-projects /sailor routes

describe('the rest of the /sailor extension is audited (Task 2b)', () => {
  it('audited stateless capability routes are answered by Sailor itself in hosted mode (A3), never raw-proxied', async () => {
    // Task 2b closed the gap this test used to document: only the audited
    // stateless catalog/capability routes pass the hosted gate unchecked. The
    // per-user DATA routes (assets, listings) are gated and the compute/write
    // routes are refused — those are covered end to end in
    // sailor-routes-gate.unit.spec.ts. Since A3 the capability routes are
    // served natively from the same folders instead of proxied.
    for (const p of ['/sailor/shader_effects', '/sailor/space_defaults']) {
      proxyRequest.mockClear()
      const r = await via(p, 'GET')
      expect(r.status, p).not.toBe('proxied')
      expect(proxyRequest, p).not.toHaveBeenCalled()
    }
    expect((await via('/sailor/space_defaults', 'GET')).body).toEqual({})
    // font_subset is a hosted 'proxy' POST: answered natively too (the body is read, checked, never raw-proxied).
    proxyRequest.mockClear()
    body('{"font":"abc","text":"x"}')
    const fs1 = await via('/sailor/font_subset', 'POST')
    expect(fs1.status).not.toBe('proxied')
    expect(fs1.body).toEqual({ error: 'undecodable font: Incorrect padding' })
    expect(proxyRequest).not.toHaveBeenCalled()
  })
})
