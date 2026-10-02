/**
 * The native dispatcher serves the nine project + spend routes that
 * comfy_extras/nodes_sailor_projects.py served (:456–:561), with the same
 * paths, verbs, response shapes and status codes — driven through a real h3
 * app, against a temp engine root.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp, eventHandler, toWebHandler } from 'h3'
import { __setInputUploadsEngineRootForTests } from '../../server/utils/inputUploads'
import { nativeEngineRoute, nativeEnginePath, nativeGenerationPost } from '../../server/native/router'

let engineRoot: string
let projects: string
const NOW = 1_781_481_600_000 // 2026-06-15T00:00:00Z

const app = createApp()
app.use(eventHandler(async (e) => {
  const r = await nativeEngineRoute(e)
  if (r !== undefined) return r
}))
app.use(eventHandler(() => ({ fallthrough: true })))
const handler = toWebHandler(app)

function call(method: string, p: string, body?: unknown, raw?: string) {
  const init: RequestInit = { method }
  if (raw !== undefined) init.body = raw
  else if (body !== undefined) init.body = JSON.stringify(body)
  if (init.body !== undefined) init.headers = { 'content-type': 'application/json' }
  return handler(new Request(`http://x${p}`, init))
}
async function json(method: string, p: string, body?: unknown, raw?: string) {
  const res = await call(method, p, body, raw)
  const text = await res.text()
  let parsed: unknown = text
  try { parsed = JSON.parse(text) }
  catch {}
  return { status: res.status, body: parsed as any, type: res.headers.get('content-type') }
}

beforeEach(() => {
  engineRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'native-router-'))
  projects = path.join(engineRoot, 'user', 'sailor', 'projects')
  __setInputUploadsEngineRootForTests(engineRoot)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
  __setInputUploadsEngineRootForTests(undefined)
  fs.rmSync(engineRoot, { recursive: true, force: true })
})

describe('which paths are native', () => {
  it('owns the projects and spend namespaces under every engine spelling', () => {
    for (const p of ['/sailor/projects', '/comfyui/sailor/projects', '/api/sailor/projects', '/comfyui/api/sailor/projects', '/sailor/projects/a/versions/v?x=1', '/sailor/spend/summary', '/sailor/assets/../projects/a']) {
      expect(nativeEnginePath(p), p).not.toBeNull()
    }
    expect(nativeEnginePath('/comfyui/sailor/projects/a?x=2')).toBe('/sailor/projects/a')
  })

  it('leaves every other path to the proxy', () => {
    for (const p of ['/sailor/render_timeline', '/sailor/projectsX', '/sailor/spacetype_encode', '/prompt', '/api/wallet', '/api/sailor/render_timeline']) {
      expect(nativeEnginePath(p), p).toBeNull()
    }
  })

  it('falls through for a path it does not own', async () => {
    expect((await json('GET', '/sailor/spacetype_encode')).body).toEqual({ fallthrough: true })
  })
})

describe('GET /sailor/projects', () => {
  it('lists nothing when there is no projects folder yet', async () => {
    expect(await json('GET', '/sailor/projects')).toMatchObject({ status: 200, body: { projects: [] } })
  })

  it('lists metadata newest first, under the /api and /comfyui spellings too', async () => {
    await json('PUT', '/sailor/projects/a', { name: 'A' })
    vi.setSystemTime(NOW + 10)
    await json('PUT', '/sailor/projects/b', { name: 'B' })
    const expected = { projects: [
      { uuid: 'b', name: 'B', cover: null, updatedAt: NOW + 10 },
      { uuid: 'a', name: 'A', cover: null, updatedAt: NOW },
    ] }
    for (const p of ['/sailor/projects', '/api/sailor/projects', '/comfyui/sailor/projects', '/comfyui/api/sailor/projects']) {
      expect((await json('GET', p)).body, p).toEqual(expected)
    }
  })
})

describe('/sailor/projects/{uuid}', () => {
  it('404s a project that does not exist', async () => {
    expect(await json('GET', '/sailor/projects/nope')).toMatchObject({ status: 404, body: { error: 'not found' } })
  })

  it('PUT creates the project, GET returns it with no current version', async () => {
    const put = await json('PUT', '/sailor/projects/p1', { name: 'Fox' })
    expect(put.status).toBe(200)
    const project = { uuid: 'p1', name: 'Fox', cover: null, createdAt: NOW, updatedAt: NOW, currentVersionId: null, versionIndex: [] }
    expect(put.body).toEqual({ project })
    expect(await json('GET', '/sailor/projects/p1')).toMatchObject({ status: 200, body: { project, currentVersion: null } })
  })

  it('PUT without a name creates "Untitled project"', async () => {
    expect((await json('PUT', '/sailor/projects/p1', { cover: 'c.png' })).body.project).toMatchObject({ name: 'Untitled project', cover: 'c.png' })
  })

  it('a cover-only PUT does not bump updatedAt; any other key does', async () => {
    await json('PUT', '/sailor/projects/p1', { name: 'Fox' })
    vi.setSystemTime(NOW + 500)
    expect((await json('PUT', '/sailor/projects/p1', { cover: 'c.png' })).body.project).toMatchObject({ cover: 'c.png', updatedAt: NOW })
    expect((await json('PUT', '/sailor/projects/p1', { name: 'Fox 2' })).body.project).toMatchObject({ name: 'Fox 2', updatedAt: NOW + 500 })
  })

  it('PUT with a body that is not JSON is a 400 "bad json"', async () => {
    const r = await json('PUT', '/sailor/projects/p1', undefined, '{ nope')
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/^bad json: /)
    expect(fs.existsSync(path.join(projects, 'p1'))).toBe(false)
  })

  it('PUT to an unsafe id is a 500, as the unguarded Python ensure_project raised', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await json('PUT', '/sailor/projects/.hidden', { name: 'x' })
    expect(r.status).toBe(500)
    expect(logged).toHaveBeenCalledOnce()
    logged.mockRestore()
    expect(fs.existsSync(path.join(projects, '.hidden'))).toBe(false)
  })

  it('DELETE removes the folder and always answers ok', async () => {
    await json('PUT', '/sailor/projects/p1', { name: 'Fox' })
    expect(await json('DELETE', '/sailor/projects/p1')).toMatchObject({ status: 200, body: { ok: true } })
    expect(fs.existsSync(path.join(projects, 'p1'))).toBe(false)
    expect(await json('DELETE', '/sailor/projects/p1')).toMatchObject({ status: 200, body: { ok: true } })
    expect(await json('DELETE', '/sailor/projects/..x')).toMatchObject({ status: 200, body: { ok: true } })
  })

  it('decodes the id the way aiohttp does', async () => {
    await json('PUT', '/sailor/projects/%70-abc', { name: 'Encoded' })
    expect((await json('GET', '/sailor/projects/p-abc')).body.project.name).toBe('Encoded')
  })
})

describe('versions', () => {
  it('POST fills id, createdAt, name and parentId, creates the project, and GET returns the body', async () => {
    const r = await json('POST', '/sailor/projects/p1/versions', { projectName: 'Fox', version: { workflow: { nodes: [] } } })
    expect(r.status).toBe(200)
    expect(r.body.id).toMatch(/^v_[0-9a-f]{12}$/)
    const got = await json('GET', `/sailor/projects/p1/versions/${r.body.id}`)
    expect(got).toMatchObject({ status: 200, body: { version: { workflow: { nodes: [] }, id: r.body.id, createdAt: NOW, name: '', parentId: null } } })
    const proj = (await json('GET', '/sailor/projects/p1')).body
    expect(proj.project).toMatchObject({ name: 'Fox', currentVersionId: r.body.id })
    expect(proj.currentVersion.id).toBe(r.body.id)
  })

  it('POST with no "version" key stores the whole body as the version (Python quirk)', async () => {
    const r = await json('POST', '/sailor/projects/p1/versions', { id: 'v_1', projectName: 'Fox', workflow: {} })
    expect(r.body).toEqual({ id: 'v_1' })
    expect((await json('GET', '/sailor/projects/p1/versions/v_1')).body.version).toEqual({ id: 'v_1', projectName: 'Fox', workflow: {}, createdAt: NOW, name: '', parentId: null })
  })

  it('an explicit null createdAt is kept (setdefault only fills missing keys)', async () => {
    await json('POST', '/sailor/projects/p1/versions', { version: { id: 'v_1', createdAt: null } })
    expect((await json('GET', '/sailor/projects/p1/versions/v_1')).body.version.createdAt).toBeNull()
  })

  it('a stale rolling save is a 409 with the stored stamp', async () => {
    await json('POST', '/sailor/projects/p1/versions', { version: { id: 'current', workflow: { savedAt: 2000 } } })
    const r = await json('POST', '/sailor/projects/p1/versions', { version: { id: 'current', workflow: { savedAt: 1000 } } })
    expect(r).toMatchObject({ status: 409, body: { error: 'stale', storedSavedAt: 2000 } })
  })

  it('an unsafe version id is a 400', async () => {
    expect(await json('POST', '/sailor/projects/p1/versions', { version: { id: '../evil' } })).toMatchObject({ status: 400, body: { error: 'invalid version id' } })
  })

  it('404s a missing version and an unsafe version id', async () => {
    await json('PUT', '/sailor/projects/p1', { name: 'Fox' })
    expect(await json('GET', '/sailor/projects/p1/versions/nope')).toMatchObject({ status: 404, body: { error: 'not found' } })
    expect(await json('GET', '/sailor/projects/p1/versions/.x')).toMatchObject({ status: 404, body: { error: 'not found' } })
  })
})

describe('generations and spend', () => {
  it('POST records a run, writes the ledger line, bumps updatedAt; a repeat promptId is deduped', async () => {
    await json('PUT', '/sailor/projects/p1', { name: 'Fox' })
    vi.setSystemTime(NOW + 1000)
    const r = await json('POST', '/sailor/projects/p1/generations', { generation: { id: 'g_1', promptId: 'pr1', usd: 0.04 } })
    expect(r).toMatchObject({ status: 200, body: { id: 'g_1' } })
    expect((await json('GET', '/sailor/projects/p1')).body.project.updatedAt).toBe(NOW + 1000)
    expect(fs.readFileSync(path.join(engineRoot, 'user', 'sailor', 'spend.jsonl'), 'utf8'))
      .toBe(`{"ts": ${NOW + 1000}, "projectUuid": "p1", "promptId": "pr1", "usd": 0.04, "credits": null}\n`)

    const dup = await json('POST', '/sailor/projects/p1/generations', { generation: { id: 'g_2', promptId: 'pr1', usd: 9 } })
    expect(dup).toMatchObject({ status: 200, body: { id: 'g_2', deduped: true } })
    expect((await json('GET', '/sailor/projects/p1/generations')).body).toEqual({ generations: [{ id: 'g_1', promptId: 'pr1', usd: 0.04, ts: NOW + 1000 }] })

    expect((await json('GET', '/sailor/spend/summary')).body).toEqual({
      month: { usd: 0.04, credits: 0 },
      total: { usd: 0.04, credits: 0 },
      byProject: [{ uuid: 'p1', usd: 0.04, credits: 0 }],
    })
  })

  it('POST creates the project when needed and fills id + ts', async () => {
    const r = await json('POST', '/sailor/projects/fresh/generations', { projectName: 'New one', generation: {} })
    expect(r.body.id).toMatch(/^g_[0-9a-f]{12}$/)
    expect((await json('GET', '/sailor/projects/fresh')).body.project.name).toBe('New one')
    expect((await json('GET', '/sailor/projects/fresh/generations')).body.generations[0]).toEqual({ id: r.body.id, ts: NOW })
  })

  it('POST to an unsafe id is a 400 "invalid project uuid"', async () => {
    expect(await json('POST', '/sailor/projects/.hidden/generations', { generation: {} })).toMatchObject({ status: 400, body: { error: 'invalid project uuid' } })
  })

  it('the runner records a generation natively, without HTTP', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const r = await nativeGenerationPost('p9', { projectName: undefined, generation: { promptId: 'run_a.0', usd: null, credits: 3, extra: undefined } })
    expect(r.status).toBe(200)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
    const gens = (await json('GET', '/sailor/projects/p9/generations')).body.generations
    expect(gens).toHaveLength(1)
    expect(gens[0]).toMatchObject({ promptId: 'run_a.0', usd: null, credits: 3 })
    expect('extra' in gens[0]).toBe(false)
    expect((await json('GET', '/sailor/projects/p9')).body.project.name).toBe('Untitled project')
  })

  it('the spend summary is empty with no ledger', async () => {
    expect((await json('GET', '/sailor/spend/summary')).body).toEqual({ month: { usd: 0, credits: 0 }, total: { usd: 0, credits: 0 }, byProject: [] })
  })
})

describe('the route table', () => {
  it('answers aiohttp\'s 405 for a verb the route does not serve', async () => {
    for (const [m, p] of [['POST', '/sailor/projects'], ['POST', '/sailor/projects/p1'], ['GET', '/sailor/projects/p1/versions'], ['DELETE', '/sailor/projects/p1/generations'], ['POST', '/sailor/spend/summary']] as const) {
      const r = await json(m, p, m === 'GET' ? undefined : {})
      expect(r.status, `${m} ${p}`).toBe(405)
      expect(r.body, `${m} ${p}`).toBe('405: Method Not Allowed')
    }
  })

  it('answers aiohttp\'s 404 for an unknown path in its namespace', async () => {
    for (const p of ['/sailor/projects/', '/sailor/projects/p1/secrets', '/sailor/projects/p1/versions/v/extra', '/sailor/spend', '/sailor/spend/other']) {
      const r = await json('GET', p)
      expect(r.status, p).toBe(404)
      expect(r.body, p).toBe('404: Not Found')
    }
  })

  it('says so in plain words when the engine folder cannot be found', async () => {
    __setInputUploadsEngineRootForTests(null)
    const r = await json('GET', '/sailor/projects')
    expect(r.status).toBe(503)
    expect(r.body.error).toMatch(/data folder/i)
  })

  it('refuses a body over 100 MB', async () => {
    const r = await handler(new Request('http://x/sailor/projects/p1', { method: 'PUT', headers: { 'content-type': 'application/json', 'content-length': String(101 * 1024 * 1024) }, body: '{}' }))
    expect(r.status).toBe(413)
  })
})
