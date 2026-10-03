/**
 * Stage 6 Task 2b — the REST of the `/sailor` engine extension is tenant-gated.
 *
 * THE P0 THIS CLOSES: Task 2 gated `/sailor/projects*` and refused
 * `/sailor/spend`, but its fallback (`match(p,'/sailor') => proxy`) still
 * raw-proxied every OTHER `/sailor` route — ~27 of them across
 * comfy_extras/{nodes_timeline,_lora_training,_model_downloads,nodes_compositor,
 * nodes_shader_effects}.py — cross-tenant to the shared engine for any signed-in
 * user. Those handlers carry no identity: `/sailor/assets` served the GLOBAL
 * timeline_assets.json to everyone, `/sailor/output_listing` walked the shared
 * output dir, DELETE `/sailor/input_file` removed anyone's upload, and the
 * render/lora/model routes ran unmetered compute or wrote operator disk.
 *
 * Each route is now bucketed by a HANDLER AUDIT (classifySailor):
 *   DATA   — reads filtered to the caller's owned files/assets; deletes and
 *            metadata reads ownership-checked, 404 (not 403) when unowned so
 *            the gate can't enumerate ids; engine NEVER touched on a miss.
 *   PROXY  — audited stateless catalog/capability; raw-proxies in hosted.
 *   REFUSE — compute / shared-state write; 403 this stage, fail closed.
 *
 * THE DURABLE DELIVERABLE is the coverage guard at the bottom: it greps the
 * Python modules for every `/sailor` route and asserts each classifies into
 * exactly one non-`unknown` bucket, matching a locked disposition table. A
 * newly-added `/sailor` route fails this suite instead of silently proxying.
 *
 * These tests drive the REAL handler (handleHostedSailorData) and the REAL
 * classifier with faked ownership tables, so they fail against the pre-fix
 * tree rather than describing a helper.
 *
 * Engine-free Phase A: past the ownership decision the data routes are served
 * natively (server/native/media.ts) from a TEMP engine root set per test —
 * never the real input/, output/ or user/. "Engine never touched" is checked
 * on disk (the victim's file survives) and by asserting no fetch; the faked
 * engine fetch now only answers the video/audio work native code hands on.
 */
import fs, { readFileSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
// R5.6: most tests here describe the video/sound routes WITHOUT Sailor's media tools (the engine or 503), so the
// tools are pinned missing whatever this machine has built. The "with the media tools" block switches the real
// build on (R5.6 fix round 1, Minor 5); native-media-video.unit.spec.ts covers the rest.
const gateTools = vi.hoisted(() => ({ real: false }))
vi.mock('../../server/media/tools', async (orig) => {
  const real = await orig() as typeof import('../../server/media/tools')
  return { ...real, mediaTools: async () => (gateTools.real ? real.mediaTools() : null) }
})

const rawBody = vi.fn(async () => undefined as Buffer | undefined)
const requestHeader = vi.fn((_e: any, _n: string) => undefined as string | undefined)
let lastStatus = 0
const lastHeaders: Record<string, string> = {}
vi.mock('h3', async (orig) => {
  const actual = await orig() as any
  return {
    ...actual,
    readRawBody: (...a: any[]) => rawBody(...(a as [])),
    getRequestHeader: (...a: any[]) => requestHeader(...(a as [any, string])),
    setResponseStatus: (_e: any, s: number) => { lastStatus = s },
    setResponseHeader: (_e: any, k: string, v: string) => { lastHeaders[k] = v },
  }
})

let mode: 'local' | 'hosted' = 'hosted'
vi.mock('../../server/utils/deployMode', () => ({
  deployMode: () => mode,
  isHosted: () => mode === 'hosted',
}))

const g = globalThis as any
g.defineEventHandler = (fn: any) => fn
g.createError = (o: { statusCode: number, message?: string, statusMessage?: string }) => {
  const err = new Error(o.message ?? o.statusMessage) as Error & { statusCode: number }
  err.statusCode = o.statusCode
  return err
}
const proxyRequest = vi.fn(async (_e: any, url: string) => ({ proxiedTo: url }))
g.proxyRequest = proxyRequest

const { handleHostedSailorData, sailorDataRoute, SAILOR_ASSET_KIND } = await import('../../server/utils/engineGate')
const { classifySailor, hostedEngineDecision, normalizeEnginePath } = await import('../../server/utils/enginePath')
const { __setResourceOwnersDbForTests } = await import('../../server/utils/resourceOwners')
const { __setInputUploadsDbForTests, __setInputUploadsEngineRootForTests, resolveEngineRoot } = await import('../../server/utils/inputUploads')
const { __setGraphRunsDbForTests } = await import('../../server/utils/graphRuns')
const middleware = (await import('../../server/middleware/comfyui-proxy')).default as any

// ----------------------------------------------------------- fake ownership

const owners = new Map<string, string>() // resource_owners: `${kind}::${id}` -> user
const uploads = new Map<string, string>() // input_uploads: file_key -> user
const runs: { userId: string, outputs: string[] }[] = [] // graph_runs
const okey = (kind: string, id: string) => `${kind}::${id}`

__setResourceOwnersDbForTests({
  async query(sql: string, params: unknown[] = []) {
    if (/insert\s+into\s+resource_owners/i.test(sql)) {
      const [kind, id, user] = params as string[]
      if (!owners.has(okey(kind, id))) owners.set(okey(kind, id), user)
      return { rows: [] }
    }
    if (/delete\s+from\s+resource_owners/i.test(sql)) {
      const [kind, id] = params as string[]
      owners.delete(okey(kind, id))
      return { rows: [] }
    }
    if (/select\s+user_id\s+from\s+resource_owners/i.test(sql)) {
      const [kind, id] = params as string[]
      const u = owners.get(okey(kind, id))
      return { rows: u ? [{ user_id: u }] : [] }
    }
    if (/select\s+resource_id\s+from\s+resource_owners/i.test(sql)) {
      const [kind, user] = params as string[]
      const rows = [...owners.entries()]
        .filter(([k, u]) => k.startsWith(`${kind}::`) && u === user)
        .map(([k]) => ({ resource_id: k.slice(kind.length + 2) }))
      return { rows }
    }
    throw new Error(`unexpected resource_owners sql: ${sql}`)
  },
})

__setInputUploadsDbForTests({
  async query(sql: string, params: unknown[] = []) {
    if (/insert\s+into\s+input_uploads/i.test(sql)) {
      const [key, user] = params as string[]
      if (!uploads.has(key)) uploads.set(key, user)
      return { rows: [] }
    }
    if (/delete\s+from\s+input_uploads/i.test(sql)) {
      const [key] = params as string[]
      uploads.delete(key)
      return { rows: [] }
    }
    if (/select\s+user_id\s+from\s+input_uploads/i.test(sql)) {
      const [key] = params as string[]
      const u = uploads.get(key)
      return { rows: u ? [{ user_id: u }] : [] }
    }
    if (/select\s+file_key\s+from\s+input_uploads/i.test(sql)) {
      const [user] = params as string[]
      return { rows: [...uploads.entries()].filter(([, u]) => u === user).map(([file_key]) => ({ file_key })) }
    }
    throw new Error(`unexpected input_uploads sql: ${sql}`)
  },
})

__setGraphRunsDbForTests({
  async query(sql: string, params: unknown[] = []) {
    if (/select\s+outputs\s+from\s+graph_runs/i.test(sql)) {
      const [user] = params as string[]
      return { rows: runs.filter(r => r.userId === user).map(r => ({ outputs: r.outputs })) }
    }
    throw new Error(`unexpected graph_runs sql: ${sql}`)
  },
})

const fetchMock = vi.fn()
;(globalThis as any).fetch = fetchMock

/** The local engine is up and answers this JSON (only video/audio work reaches it now). */
function upstream(body: unknown, status = 200) {
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } }))
}
/** The local engine is not running. */
function engineDown() {
  fetchMock.mockRejectedValue(new TypeError('fetch failed'))
}

// ------------------------------------------------ temp engine root (on disk)

let engineRoot = ''
const inDir = (...p: string[]) => path.join(engineRoot, 'input', ...p)
const outDir = (...p: string[]) => path.join(engineRoot, 'output', ...p)
const userFile = (...p: string[]) => path.join(engineRoot, 'user', ...p)
function file(full: string, bytes = 'x') {
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, bytes)
}
function writeAssets(assets: unknown[]) {
  file(userFile('timeline_assets.json'), JSON.stringify(assets, null, 2))
}
const readAssets = () => JSON.parse(fs.readFileSync(userFile('timeline_assets.json'), 'utf8'))

beforeEach(() => {
  engineRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sailor-routes-gate-')))
  for (const d of ['input', 'output', 'user']) fs.mkdirSync(path.join(engineRoot, d))
  __setInputUploadsEngineRootForTests(engineRoot)
  mode = 'hosted'
  fetchMock.mockReset()
  engineDown()
  proxyRequest.mockClear()
  rawBody.mockReset(); rawBody.mockResolvedValue(undefined)
  requestHeader.mockReset(); requestHeader.mockReturnValue(undefined)
  owners.clear(); uploads.clear(); runs.length = 0
  for (const k of Object.keys(lastHeaders)) delete lastHeaders[k]
  lastStatus = 0
})
afterEach(() => {
  __setInputUploadsEngineRootForTests(undefined)
  fs.rmSync(engineRoot, { recursive: true, force: true })
})

it('these tests serve from a temp engine root, never the real folders', () => {
  expect(resolveEngineRoot()).toBe(engineRoot)
})

function ev(path: string, method = 'GET', userId: string | null = 'u1') {
  return { path, method, context: userId ? { userId } : {}, node: { req: {}, res: {} } }
}

/** Drive the real handler; return {status, body} or the thrown code. A `body`
 * (object or string) is buffered onto the readRawBody mock the way h3 hands the
 * gate the request bytes — the same bytes forwardSailor re-reads on forward. */
async function call(path: string, method = 'GET', userId: string | null = 'u1', body?: unknown): Promise<any> {
  rawBody.mockReset()
  if (body === undefined) rawBody.mockResolvedValue(undefined)
  else rawBody.mockResolvedValue(Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
  try {
    return { body: await handleHostedSailorData(ev(path, method, userId) as any), status: lastStatus }
  }
  catch (e: any) {
    return { status: e?.statusCode ?? 'threw', message: e?.message }
  }
}

// ================================================================ classifier

describe('classifySailor — the audited bucket table', () => {
  it('buckets each representative route', () => {
    const cases: [string, string, string][] = [
      ['/sailor/projects', 'GET', 'projects'],
      ['/sailor/projects/abc', 'DELETE', 'projects'],
      ['/sailor/spend/summary', 'GET', 'spend'],
      ['/sailor/input_listing', 'GET', 'data'],
      ['/sailor/output_listing', 'GET', 'data'],
      ['/sailor/assets', 'GET', 'data'],
      ['/sailor/asset_import', 'POST', 'data'],
      ['/sailor/assets/a-1', 'DELETE', 'data'],
      ['/sailor/asset_thumbnails', 'GET', 'data'],
      ['/sailor/asset_waveform', 'GET', 'data'],
      ['/sailor/input_thumbnail', 'GET', 'data'],
      ['/sailor/input_file', 'DELETE', 'data'],
      ['/sailor/output_file', 'DELETE', 'data'],
      ['/sailor/shader_effects', 'GET', 'proxy'],
      ['/sailor/shader_effects/assets/atlas.png', 'GET', 'proxy'],
      ['/sailor/space_defaults', 'GET', 'proxy'],
      ['/sailor/space_thumbnails', 'GET', 'proxy'],
      ['/sailor/space_thumbnail/burst', 'GET', 'proxy'],
      ['/sailor/font_subset', 'POST', 'proxy'],
      // The engine's Timeline renders (Task R9.3): unlisted, so refused by default.
      ['/sailor/render_timeline', 'POST', 'unknown'],
      ['/sailor/render_timeline_stream', 'POST', 'unknown'],
      ['/sailor/timeline/render_frame', 'POST', 'unknown'],
      // The engine's video encode (Task R10.4): unlisted, so refused by default.
      ['/sailor/spacetype_encode', 'POST', 'unknown'],
      // The model-bundle routes (Task R10.5): unlisted, so refused by default.
      ['/sailor/models/status', 'GET', 'unknown'],
      ['/sailor/models/download', 'GET', 'unknown'],
      ['/sailor/motion/cleanup_frames', 'POST', 'refuse'],
      ['/sailor/lora/save_captions', 'POST', 'refuse'],
      ['/sailor/lora/clear_dataset', 'POST', 'refuse'],
      ['/sailor/space_default/burst', 'POST', 'refuse'],
      ['/sailor/space_thumbnail/burst', 'POST', 'refuse'],
    ]
    for (const [p, m, bucket] of cases) {
      expect(classifySailor(p, m).bucket, `${m} ${p}`).toBe(bucket)
    }
  })

  it('space_thumbnail/{id} splits by verb (GET reads a shared thumb, POST writes one)', () => {
    expect(classifySailor('/sailor/space_thumbnail/x', 'GET').bucket).toBe('proxy')
    expect(classifySailor('/sailor/space_thumbnail/x', 'POST').bucket).toBe('refuse')
  })

  it('the engine video encode is unlisted (R10.4): never proxied, refused by default', () => {
    // It writes a video into the SHARED input directory; Sailor no longer calls it.
    expect(classifySailor('/sailor/spacetype_encode', 'POST').bucket).toBe('unknown')
    expect(hostedEngineDecision('/sailor/spacetype_encode', 'POST').kind).toBe('forbid')
  })

  it('an unrecognised /sailor route is unknown → fail closed', () => {
    expect(classifySailor('/sailor/brand_new_route', 'GET').bucket).toBe('unknown')
    expect(classifySailor('/sailor', 'GET').bucket).toBe('unknown')
    expect(classifySailor('/queue', 'GET').bucket).toBe('unknown')
  })

  it('hostedEngineDecision maps each bucket onto its EngineDecision kind', () => {
    expect(hostedEngineDecision('/sailor/assets', 'GET').kind).toBe('sailorData')
    expect(hostedEngineDecision('/sailor/shader_effects', 'GET').kind).toBe('proxy')
    expect(hostedEngineDecision('/sailor/render_timeline', 'POST').kind).toBe('forbid')
    expect(hostedEngineDecision('/sailor/projects/abc', 'GET').kind).toBe('sailorProjects')
    // deny-by-default: unknown /sailor route → forbid, never proxy
    expect(hostedEngineDecision('/sailor/brand_new_route', 'GET').kind).toBe('forbid')
  })

  it('takes the decision on the NORMALIZED path so /comfyui aliases cannot walk past it', () => {
    expect(hostedEngineDecision(normalizeEnginePath('/comfyui/sailor/assets'), 'GET').kind).toBe('sailorData')
    expect(hostedEngineDecision(normalizeEnginePath('/comfyui/sailor/render_timeline'), 'POST').kind).toBe('forbid')
    // A dot segment must not carry a refused route into the proxy branch.
    expect(hostedEngineDecision(normalizeEnginePath('/sailor/shader_effects/../render_timeline'), 'POST').kind).toBe('forbid')
  })
})

// ============================================================== route parser

describe('sailorDataRoute — path/verb table with decoded query params', () => {
  it('parses each data route', () => {
    expect(sailorDataRoute('/sailor/input_listing', '', 'GET')).toEqual({ kind: 'inputListing' })
    expect(sailorDataRoute('/sailor/output_listing', '', 'GET')).toEqual({ kind: 'outputListing' })
    expect(sailorDataRoute('/sailor/assets', '', 'GET')).toEqual({ kind: 'assetsList' })
    expect(sailorDataRoute('/sailor/asset_import', '', 'POST')).toEqual({ kind: 'assetImport' })
    expect(sailorDataRoute('/sailor/assets/a-1', '', 'DELETE')).toEqual({ kind: 'assetDelete', assetId: 'a-1' })
    expect(sailorDataRoute('/sailor/asset_thumbnails', 'asset_id=a-1&count=5', 'GET')).toEqual({ kind: 'assetThumbnails', assetId: 'a-1' })
    expect(sailorDataRoute('/sailor/asset_waveform', 'asset_id=a-1', 'GET')).toEqual({ kind: 'assetWaveform', assetId: 'a-1' })
    expect(sailorDataRoute('/sailor/input_thumbnail', 'filename=a%20b.png', 'GET')).toEqual({ kind: 'inputThumbnail', filename: 'a b.png' })
    expect(sailorDataRoute('/sailor/input_file', 'filename=a.png', 'DELETE')).toEqual({ kind: 'inputFileDelete', filename: 'a.png' })
    expect(sailorDataRoute('/sailor/output_file', 'filename=a.png&subfolder=sub', 'DELETE')).toEqual({ kind: 'outputFileDelete', filename: 'a.png', subfolder: 'sub' })
  })

  it('refuses an unexpected verb rather than falling through to a proxy', () => {
    expect(sailorDataRoute('/sailor/assets', '', 'POST').kind).toBe('reject')
    expect(sailorDataRoute('/sailor/input_file', 'filename=a.png', 'GET').kind).toBe('reject')
    expect(sailorDataRoute('/sailor/asset_import', '', 'GET').kind).toBe('reject')
  })

  // A2 follow-up fix, item 4: an id that DECODES to contain '/' or '\\' must
  // be refused here the same way server/native/media.ts's matchMediaRoute
  // refuses it — otherwise the gate could check ownership of one string while
  // the native router resolves a different one for the same request.
  it('refuses (404, same as any other miss) an asset id that decodes to contain a slash or backslash', () => {
    for (const encoded of ['a%2Fb', 'a%2fb', 'a%5Cb', encodeURIComponent('../secret'), encodeURIComponent('a\\b')]) {
      expect(sailorDataRoute(`/sailor/assets/${encoded}`, '', 'DELETE')).toEqual({ status: 404, kind: 'reject', message: 'Not found' })
    }
  })

  it('still accepts a plain id with no separators', () => {
    expect(sailorDataRoute('/sailor/assets/abc-123', '', 'DELETE')).toEqual({ kind: 'assetDelete', assetId: 'abc-123' })
  })
})

// ============================================================ input listing

describe('GET /sailor/input_listing filters to the caller\'s owned uploads', () => {
  it('drops files owned by another tenant', async () => {
    uploads.set('input::mine.png', 'u1')
    uploads.set('input::theirs.png', 'u2')
    file(inDir('mine.png'))
    file(inDir('theirs.png'))
    file(inDir('orphan.png')) // no ownership row
    const r = await call('/sailor/input_listing', 'GET', 'u1')
    expect(r.body.items.map((i: any) => i.filename)).toEqual(['mine.png'])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a subfolder upload does not leak into the flat top-level listing', async () => {
    uploads.set('input:sub:nested.png', 'u1') // non-empty subfolder → excluded
    file(inDir('nested.png'))
    const r = await call('/sailor/input_listing', 'GET', 'u1')
    expect(r.body.items).toEqual([])
  })
})

describe('GET /sailor/output_listing filters to the caller\'s owned outputs', () => {
  it('keeps only outputs recorded against the caller\'s graph runs', async () => {
    runs.push({ userId: 'u1', outputs: ['output::a.png', 'output:sub:b.png'] })
    runs.push({ userId: 'u2', outputs: ['output::secret.png'] })
    file(outDir('a.png'))
    file(outDir('sub', 'b.png'))
    file(outDir('secret.png'))
    const r = await call('/sailor/output_listing', 'GET', 'u1')
    expect(r.body.items.map((i: any) => i.filename).sort()).toEqual(['a.png', 'b.png'])
  })
})

// ================================================================== assets

describe('the timeline-asset library is per-user', () => {
  it('GET /sailor/assets returns only the caller\'s owned assets (unowned are invisible)', async () => {
    owners.set(okey(SAILOR_ASSET_KIND, 'a-mine'), 'u1')
    owners.set(okey(SAILOR_ASSET_KIND, 'a-theirs'), 'u2')
    writeAssets([
      { id: 'a-mine', name: 'mine.mp4' },
      { id: 'a-theirs', name: 'theirs.mp4' },
      { id: 'a-orphan', name: 'orphan.mp4' }, // no owner row
    ])
    const r = await call('/sailor/assets', 'GET', 'u1')
    expect(r.body.assets.map((a: any) => a.id)).toEqual(['a-mine'])
  })

  it('POST /sailor/asset_import records ownership from the engine\'s returned asset.id', async () => {
    uploads.set('input::clip.mp4', 'u1') // the caller owns the input file being imported
    file(inDir('clip.mp4'))
    upstream({ asset: { id: 'a-new', name: 'clip.mp4' }, created: true })
    const r = await call('/sailor/asset_import', 'POST', 'u1', { path: 'clip.mp4' })
    expect(r.body.asset.id).toBe('a-new')
    expect(owners.get(okey(SAILOR_ASSET_KIND, 'a-new'))).toBe('u1')
  })

  it('POST /sailor/asset_import served natively records ownership of the id it stored', async () => {
    uploads.set('input::still.png', 'u1')
    file(inDir('still.png'))
    const r = await call('/sailor/asset_import', 'POST', 'u1', { path: 'still.png' })
    expect(r.status).toBe(200)
    const id = r.body.asset.id
    expect(readAssets().map((a: any) => a.id)).toEqual([id])
    expect(owners.get(okey(SAILOR_ASSET_KIND, id))).toBe('u1')
    expect(fetchMock, 'an image never needs the engine').not.toHaveBeenCalled()
  })

  it('asset_import of a nested (subfolder) input the caller owns forwards + records', async () => {
    uploads.set('input:sub:clip.mp4', 'u1')
    file(inDir('sub', 'clip.mp4'))
    upstream({ asset: { id: 'a-nested', name: 'clip.mp4' }, created: true })
    const r = await call('/sailor/asset_import', 'POST', 'u1', { path: 'sub/clip.mp4' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(owners.get(okey(SAILOR_ASSET_KIND, 'a-nested'))).toBe('u1')
  })

  it('asset_import ownership is first-writer-wins on a duplicate path import', async () => {
    uploads.set('input::clip.mp4', 'u1') // u1 owns the input file
    owners.set(okey(SAILOR_ASSET_KIND, 'a-dup'), 'u2') // but u2 imported it as an asset first
    file(inDir('clip.mp4'))
    upstream({ asset: { id: 'a-dup', name: 'clip.mp4' }, created: false })
    await call('/sailor/asset_import', 'POST', 'u1', { path: 'clip.mp4' })
    expect(owners.get(okey(SAILOR_ASSET_KIND, 'a-dup')), 'must not transfer ownership').toBe('u2')
  })

  // --- the Critical: asset_import must not forward an arbitrary caller path ---
  // The engine (comfy_extras/nodes_timeline.py) uses an ABSOLUTE `path` verbatim
  // and joins a relative one onto input_dir with NO `..` rejection, then probes+
  // reads the file and records an asset the CALLER owns pointing at it — which
  // asset_thumbnails/asset_waveform then render back. So the import must name an
  // input file the caller ALREADY owns; anything else never reaches the engine.
  it('an ABSOLUTE path (/etc/hostname) is rejected 400, engine never forwarded, no ownership recorded', async () => {
    const r = await call('/sailor/asset_import', 'POST', 'u1', { path: '/etc/hostname' })
    expect(r.status).toBe(400)
    expect(fetchMock, 'engine must NEVER see an absolute path').not.toHaveBeenCalled()
    expect([...owners.keys()], 'no forged asset ownership').toEqual([])
  })

  it('a single-segment absolute path (/app) is rejected 400, engine never forwarded, no ownership recorded', async () => {
    // Regression for the depth-1 bypass: splitting on the last `/` gives
    // subfolder='' + basename='app' for `/app`, and unsafeUploadTarget('', 'app')
    // only inspects the subfolder for a leading `/` — so a depth-1 absolute path
    // slipped past the old split-based check while `/etc/hostname` (subfolder
    // `/etc`) did not.
    const r = await call('/sailor/asset_import', 'POST', 'u1', { path: '/app' })
    expect(r.status).toBe(400)
    expect(fetchMock, 'engine must NEVER see an absolute path').not.toHaveBeenCalled()
    expect([...owners.keys()], 'no forged asset ownership').toEqual([])
  })

  it('a `..` traversal path is rejected 400, engine never forwarded', async () => {
    const r = await call('/sailor/asset_import', 'POST', 'u1', { path: '../../other-tenant-file.mp4' })
    expect(r.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
    expect([...owners.keys()]).toEqual([])
  })

  it('a backslash-escaped path is rejected 400 (parser-disagreement class), engine never forwarded', async () => {
    const r = await call('/sailor/asset_import', 'POST', 'u1', { path: 'sub\\..\\escape.mp4' })
    expect(r.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a well-formed path to a file the caller does NOT own → 404, engine never forwarded', async () => {
    uploads.set('input::theirs.mp4', 'u2') // exists, but belongs to another tenant
    const r = await call('/sailor/asset_import', 'POST', 'u1', { path: 'theirs.mp4' })
    expect(r.status).toBe(404)
    expect(fetchMock, 'no existence-disclosure forward').not.toHaveBeenCalled()
    expect([...owners.keys()]).toEqual([])
  })

  it('an unclaimed (pre-table) filename → 404, engine never forwarded', async () => {
    const r = await call('/sailor/asset_import', 'POST', 'u1', { path: 'orphan.mp4' })
    expect(r.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a missing / non-string `path` → 400, engine never forwarded', async () => {
    const r = await call('/sailor/asset_import', 'POST', 'u1', { notPath: 'x' })
    expect(r.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
    const r2 = await call('/sailor/asset_import', 'POST', 'u1', 'not json at all {')
    expect(r2.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('DELETE /sailor/assets/{id} of another tenant\'s asset 404s, engine never touched', async () => {
    owners.set(okey(SAILOR_ASSET_KIND, 'a-theirs'), 'u2')
    writeAssets([{ id: 'a-theirs', name: 'theirs.mp4' }])
    const r = await call('/sailor/assets/a-theirs', 'DELETE', 'u1')
    expect(r.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(readAssets().map((a: any) => a.id), 'the victim\'s record survives').toEqual(['a-theirs'])
    expect(owners.has(okey(SAILOR_ASSET_KIND, 'a-theirs')), 'the victim\'s asset row survives').toBe(true)
  })

  it('DELETE of a NON-EXISTENT asset also 404s — same code, no oracle', async () => {
    const r = await call('/sailor/assets/a-ghost', 'DELETE', 'u1')
    expect(r.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('DELETE of the caller\'s own asset removes the record and releases the ownership row', async () => {
    owners.set(okey(SAILOR_ASSET_KIND, 'a-mine'), 'u1')
    writeAssets([{ id: 'a-mine', name: 'mine.mp4' }, { id: 'a-other', name: 'other.mp4' }])
    const r = await call('/sailor/assets/a-mine', 'DELETE', 'u1')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
    expect(readAssets().map((a: any) => a.id)).toEqual(['a-other'])
    expect(owners.has(okey(SAILOR_ASSET_KIND, 'a-mine'))).toBe(false)
  })

  it('asset_thumbnails / asset_waveform of an unowned asset 404, engine never touched', async () => {
    owners.set(okey(SAILOR_ASSET_KIND, 'a-theirs'), 'u2')
    for (const p of ['/sailor/asset_thumbnails?asset_id=a-theirs', '/sailor/asset_waveform?asset_id=a-theirs']) {
      fetchMock.mockClear()
      const r = await call(p, 'GET', 'u1')
      expect(r.status, p).toBe(404)
      expect(fetchMock, p).not.toHaveBeenCalled()
    }
  })

  it('asset_thumbnails of the caller\'s own (video) asset goes to the engine', async () => {
    owners.set(okey(SAILOR_ASSET_KIND, 'a-mine'), 'u1')
    writeAssets([{ id: 'a-mine', path: inDir('mine.mp4'), kind: 'video' }])
    upstream({ thumbnails: ['data:...'], asset_id: 'a-mine' })
    const r = await call('/sailor/asset_thumbnails?asset_id=a-mine&count=5', 'GET', 'u1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(r.body.asset_id).toBe('a-mine')
  })
})

describe('GET /sailor/input_thumbnail is ownership-scoped', () => {
  it('another tenant\'s file → 404, nothing rendered', async () => {
    uploads.set('input::theirs.png', 'u2')
    file(inDir('theirs.png'))
    const r = await call('/sailor/input_thumbnail?filename=theirs.png', 'GET', 'u1')
    expect(r.status).toBe(404)
    expect(fs.existsSync(userFile('timeline_thumbs')), 'no thumbnail rendered for a file that is not yours').toBe(false)
  })

  it('the caller\'s own image → PNG bytes with the thumbnail headers', async () => {
    const sharp = (await import('sharp')).default
    uploads.set('input::mine.png', 'u1')
    await sharp({ create: { width: 96, height: 48, channels: 3, background: '#f00' } }).png().toFile(inDir('mine.png'))
    const r = await call('/sailor/input_thumbnail?filename=mine.png', 'GET', 'u1')
    expect(r.status).toBe(200)
    expect(Buffer.isBuffer(r.body)).toBe(true)
    expect(lastHeaders['content-type']).toBe('image/png')
    expect(lastHeaders['cache-control']).toBe('max-age=86400')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ============================================================ file deletes

describe('DELETE /sailor/input_file is ownership-scoped', () => {
  it('another tenant\'s upload → 404, engine never touched, victim row intact', async () => {
    uploads.set('input::theirs.png', 'u2')
    file(inDir('theirs.png'))
    const r = await call('/sailor/input_file?filename=theirs.png', 'DELETE', 'u1')
    expect(r.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(fs.existsSync(inDir('theirs.png')), 'the victim\'s file survives').toBe(true)
    expect(uploads.get('input::theirs.png')).toBe('u2')
  })

  it('an unclaimed (pre-table) filename → 404, engine never touched', async () => {
    const r = await call('/sailor/input_file?filename=orphan.png', 'DELETE', 'u1')
    expect(r.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the caller\'s own upload is deleted and frees the ownership row', async () => {
    uploads.set('input::mine.png', 'u1')
    file(inDir('mine.png'))
    const r = await call('/sailor/input_file?filename=mine.png', 'DELETE', 'u1')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
    expect(fs.existsSync(inDir('mine.png'))).toBe(false)
    expect(uploads.has('input::mine.png'), 'name freed for the next writer').toBe(false)
  })
})

describe('DELETE /sailor/output_file is ownership-scoped', () => {
  it('an output the caller never produced → 404, engine never touched', async () => {
    runs.push({ userId: 'u2', outputs: ['output::theirs.png'] })
    file(outDir('theirs.png'))
    const r = await call('/sailor/output_file?filename=theirs.png', 'DELETE', 'u1')
    expect(r.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(fs.existsSync(outDir('theirs.png'))).toBe(true)
  })

  it('the caller\'s own output (subfolder-aware) is deleted', async () => {
    runs.push({ userId: 'u1', outputs: ['output:sub:mine.png'] })
    file(outDir('sub', 'mine.png'))
    const r = await call('/sailor/output_file?filename=mine.png&subfolder=sub', 'DELETE', 'u1')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
    expect(fs.existsSync(outDir('sub', 'mine.png'))).toBe(false)
  })
})

// =========================================================== auth + errors

describe('the data gate requires a signed-in tenant', () => {
  it('401s an anonymous caller before any engine contact', async () => {
    const r = await call('/sailor/assets', 'GET', null)
    expect(r.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ============================================================ COVERAGE GUARD

/**
 * The durable deliverable: every `/sailor` route the engine registers must be
 * classified into exactly one non-`unknown` bucket, and match the locked
 * disposition table below. A route added upstream but not classified here
 * fails as `unknown` (fail closed). A route whose bucket drifts fails the
 * table check. Greps ALL of comfy_extras (not just the four named modules) so
 * a route added in any module — shader_effects lives in a fifth — is caught.
 */
const COMFY_EXTRAS = fileURLToPath(new URL('../../../comfy_extras', import.meta.url))
const CUSTOM_NODES = fileURLToPath(new URL('../../../custom_nodes', import.meta.url))

/** `${VERB} ${pathTemplate}` → expected bucket. THE verified disposition table. */
const EXPECTED: Record<string, string> = {
  // projects (Task 2)
  'GET /sailor/projects': 'projects',
  'GET /sailor/projects/{uuid}': 'projects',
  'PUT /sailor/projects/{uuid}': 'projects',
  'DELETE /sailor/projects/{uuid}': 'projects',
  'POST /sailor/projects/{uuid}/versions': 'projects',
  'GET /sailor/projects/{uuid}/versions/{vid}': 'projects',
  'POST /sailor/projects/{uuid}/generations': 'projects',
  'GET /sailor/projects/{uuid}/generations': 'projects',
  'GET /sailor/spend/summary': 'spend',
  // capability / catalog (proxy-allow)
  'GET /sailor/shader_effects': 'proxy',
  'GET /sailor/shader_effects/assets/{name}': 'proxy',
  'GET /sailor/space_defaults': 'proxy',
  'GET /sailor/space_thumbnails': 'proxy',
  'GET /sailor/space_thumbnail/{effect_id}': 'proxy',
  'POST /sailor/font_subset': 'proxy',
  // per-user data
  'GET /sailor/input_listing': 'data',
  'GET /sailor/output_listing': 'data',
  'GET /sailor/assets': 'data',
  'POST /sailor/asset_import': 'data',
  'DELETE /sailor/assets/{asset_id}': 'data',
  'GET /sailor/input_thumbnail': 'data',
  'GET /sailor/asset_thumbnails': 'data',
  'GET /sailor/asset_waveform': 'data',
  'DELETE /sailor/input_file': 'data',
  'DELETE /sailor/output_file': 'data',
  // compute / shared-state write (refuse)
  'POST /sailor/space_default/{effect_id}': 'refuse',
  'POST /sailor/space_thumbnail/{effect_id}': 'refuse',
  'POST /sailor/lora/save_captions': 'refuse',
  'POST /sailor/lora/clear_dataset': 'refuse',
  'POST /sailor/motion/cleanup_frames': 'refuse',
  // Task R9.3: the engine's Timeline renders, which Sailor no longer calls,
  // are deliberately unlisted: hosted refuses them by default (RETIRED_ROUTES).
  'POST /sailor/render_timeline_stream': 'unknown',
  'POST /sailor/render_timeline': 'unknown',
  'POST /sailor/timeline/render_frame': 'unknown',
  // Task R10.4: the engine's video encode, likewise unlisted.
  'POST /sailor/spacetype_encode': 'unknown',
  // Task R10.5: the model-bundle routes, likewise unlisted.
  'GET /sailor/models/status': 'unknown',
  'GET /sailor/models/download': 'unknown',
}

/** Engine routes nothing in Sailor calls any more, left unclassified on purpose (deny by default). */
const RETIRED_ROUTES = new Set([
  'POST /sailor/render_timeline_stream',
  'POST /sailor/render_timeline',
  'POST /sailor/timeline/render_frame',
  'POST /sailor/spacetype_encode',
  'GET /sailor/models/status',
  'GET /sailor/models/download',
])

/** Turn a `{param}` template into a concrete path classifySailor can match. */
function concrete(template: string): string {
  return template.replace(/\{[^}]+\}/g, 'X')
}

/** Every `.py` under a root, recursing subdirs (a route can move into a package
 * subfolder or a custom_nodes plugin), skipping compiled-cache dirs. */
function pyFilesUnder(root: string): string[] {
  const out: string[] = []
  let entries: ReturnType<typeof readdirSync>
  try {
    entries = readdirSync(root, { withFileTypes: true })
  }
  catch {
    return out // a root that does not exist on this checkout contributes nothing
  }
  for (const e of entries as any[]) {
    const full = `${root}/${e.name}`
    if (e.isDirectory()) {
      if (e.name === '__pycache__' || e.name === 'node_modules' || e.name === '.git') continue
      out.push(...pyFilesUnder(full))
    }
    else if (e.isFile() && e.name.endsWith('.py')) {
      out.push(full)
    }
  }
  return out
}

function grepSailorRoutes(): { verb: string, template: string }[] {
  const out: { verb: string, template: string }[] = []
  // Single OR double quotes — aiohttp accepts either and Python style varies.
  const re = /routes\.(get|post|put|delete)\(['"](\/sailor[^'"]*)['"]/g
  const seen = new Set<string>()
  for (const file of [...pyFilesUnder(COMFY_EXTRAS), ...pyFilesUnder(CUSTOM_NODES)]) {
    const src = readFileSync(file, 'utf8')
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) {
      const rec = { verb: m[1]!.toUpperCase(), template: m[2]! }
      const key = `${rec.verb} ${rec.template}`
      if (seen.has(key)) continue // a route defined once but scanned twice
      seen.add(key)
      out.push(rec)
    }
  }
  return out
}

describe('coverage guard: every registered /sailor route is classified', () => {
  const routes = grepSailorRoutes()

  it('finds the full route surface (sanity: the grep matched a realistic count)', () => {
    expect(routes.length).toBeGreaterThanOrEqual(36)
  })

  it('the widened scan matches single OR double quotes and a synthetic unclassified route fails closed', () => {
    // (a) The regex must catch a single-quoted registration, not just double.
    const re = /routes\.(get|post|put|delete)\(['"](\/sailor[^'"]*)['"]/g
    const single = `@routes.post('/sailor/brand_new_single')`
    const double = `@routes.get("/sailor/brand_new_double")`
    expect([...single.matchAll(re)].map(m => `${m[1]} ${m[2]}`)).toEqual(['post /sailor/brand_new_single'])
    re.lastIndex = 0
    expect([...double.matchAll(re)].map(m => `${m[1]} ${m[2]}`)).toEqual(['get /sailor/brand_new_double'])
    // (b) Such a route, unclassified, buckets as unknown — the guard fails closed.
    expect(classifySailor('/sailor/brand_new_single', 'POST').bucket).toBe('unknown')
    expect(classifySailor('/sailor/brand_new_double', 'GET').bucket).toBe('unknown')
  })

  it('classifies every route into exactly one non-unknown bucket', () => {
    const misclassified: string[] = []
    for (const { verb, template } of routes) {
      const key = `${verb} ${template}`
      const bucket = classifySailor(concrete(template), verb).bucket
      if (bucket === 'unknown' && !RETIRED_ROUTES.has(key)) misclassified.push(`${key} → unknown (would fail closed, but MUST be classified)`)
    }
    expect(misclassified, 'every /sailor route must be audited into a bucket').toEqual([])
  })

  it('matches the locked disposition table (bucket drift or a new route fails here)', () => {
    const mismatches: string[] = []
    const seen = new Set<string>()
    for (const { verb, template } of routes) {
      const key = `${verb} ${template}`
      seen.add(key)
      const bucket = classifySailor(concrete(template), verb).bucket
      const expected = EXPECTED[key]
      if (expected === undefined) mismatches.push(`${key}: NOT in the disposition table (new route? classify it)`)
      else if (expected !== bucket) mismatches.push(`${key}: table says ${expected} but classifier says ${bucket}`)
    }
    for (const key of Object.keys(EXPECTED)) {
      if (!seen.has(key)) mismatches.push(`${key}: in the table but NOT found in comfy_extras (route removed/renamed?)`)
    }
    expect(mismatches).toEqual([])
  })
})

// ======================================= R5.6: the media tools present (hosted)

describe('hosted, with the media tools: the gate first, then Sailor reads only the input folder (R5.6 fix round 1)', () => {
  let mediaParity: typeof import('./__runner__/mediaParity')
  let limiter: typeof import('../../server/media/run').mediaLimiter
  beforeEach(async () => {
    gateTools.real = true
    mediaParity = await import('./__runner__/mediaParity')
    limiter = (await import('../../server/media/run')).mediaLimiter
    await mediaParity.requireMediaTools()
  })
  afterEach(() => { gateTools.real = false })
  const clip = (name: string, to: string) => {
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(mediaParity.clipPath(name), to)
  }

  it('the caller\'s own video asset is served natively — thumbnails and waveform — and the engine is never asked', async () => {
    owners.set(okey(SAILOR_ASSET_KIND, 'a-mine'), 'u1')
    clip('v_stereo_aac.mp4', inDir('mine.mp4'))
    writeAssets([{ id: 'a-mine', path: inDir('mine.mp4'), kind: 'video' }])
    const t = await call('/sailor/asset_thumbnails?asset_id=a-mine&count=2', 'GET', 'u1')
    expect(t.status).toBe(200)
    expect(t.body.thumbnails).toHaveLength(2)
    const w = await call('/sailor/asset_waveform?asset_id=a-mine&buckets=16', 'GET', 'u1')
    expect(w.body.peaks).toHaveLength(16)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('asset_import of the caller\'s own video probes it natively and records the owner; the engine is never asked', async () => {
    uploads.set('input::clip.mp4', 'u1')
    clip('v_h264_601.mp4', inDir('clip.mp4'))
    const r = await call('/sailor/asset_import', 'POST', 'u1', { path: 'clip.mp4' })
    expect(r.body.asset).toMatchObject({ kind: 'video', duration_sec: 0.3333333333333333, width: 32, height: 24 })
    expect(owners.get(okey(SAILOR_ASSET_KIND, r.body.asset.id))).toBe('u1')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('an owned asset whose file is outside input/ (a record pointing out, or a symlink out) gives [] and no tool starts', async () => {
    owners.set(okey(SAILOR_ASSET_KIND, 'a-out'), 'u1')
    owners.set(okey(SAILOR_ASSET_KIND, 'a-link'), 'u1')
    clip('v_h264_601.mp4', outDir('elsewhere.mp4'))
    fs.symlinkSync(outDir('elsewhere.mp4'), inDir('link.mp4'))
    writeAssets([{ id: 'a-out', path: outDir('elsewhere.mp4'), kind: 'video' }, { id: 'a-link', path: inDir('link.mp4'), kind: 'video' }])
    const before = limiter().started()
    for (const id of ['a-out', 'a-link']) {
      const r = await call(`/sailor/asset_thumbnails?asset_id=${id}&count=1`, 'GET', 'u1')
      expect(r.body, id).toEqual({ thumbnails: [], asset_id: id, count: 1 })
      const w = await call(`/sailor/asset_waveform?asset_id=${id}&buckets=16`, 'GET', 'u1')
      expect(w.body.peaks, id).toEqual([])
    }
    expect(limiter().started(), 'no ffprobe or ffmpeg ran').toBe(before)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('an import whose probe is refused for Sailor\'s own reason (the person\'s route share busy) saves a marked record the owner row names; its thumbnails work; a re-import fills it in (fix round 2)', async () => {
    const { runMedia } = await import('../../server/media/run')
    const { PROBE_AGAIN } = await import('../../server/native/media')
    uploads.set('input::clip.mp4', 'u1')
    clip('v_h264_601.mp4', inDir('clip.mp4'))
    // Hold u1's whole route share (one running, four waiting): ffmpeg reading a pipe that never brings a byte.
    const never: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Uint8Array>>(() => {}) }) }
    const hold = new AbortController()
    const holders = Array.from({ length: 5 }, () => runMedia({
      tool: 'ffmpeg', args: ['-f', 'f32le', '-ar', '8000', '-ch_layout', 'mono', '-i', 'pipe:0', '-f', 'null', 'pipe:1'],
      userId: 'u1', route: true, stdin: never, signal: hold.signal,
    }).catch(() => 'stopped'))
    await new Promise(r => setTimeout(r, 200))
    let r: any
    try {
      r = await call('/sailor/asset_import', 'POST', 'u1', { path: 'clip.mp4' })
    }
    finally {
      hold.abort()
      await Promise.all(holders)
    }
    expect(r.body).toMatchObject({ created: true, asset: { kind: 'video', duration_sec: null, width: null, height: null, [PROBE_AGAIN]: true } })
    const id = r.body.asset.id
    // The owner row names a saved record.
    expect(owners.get(okey(SAILOR_ASSET_KIND, id))).toBe('u1')
    expect(readAssets()).toEqual([r.body.asset])
    // Its thumbnails come from the file (and the read fills the record in).
    const t = await call(`/sailor/asset_thumbnails?asset_id=${id}&count=1`, 'GET', 'u1')
    expect(t.body.thumbnails).toHaveLength(1)
    expect(readAssets()[0]).toMatchObject({ id, duration_sec: 0.3333333333333333, width: 32, height: 24 })
    expect(PROBE_AGAIN in readAssets()[0]).toBe(false)
    // A re-import names the same asset, filled in; no second owner row.
    const again = await call('/sailor/asset_import', 'POST', 'u1', { path: 'clip.mp4' })
    expect(again.body).toMatchObject({ created: false, asset: { id, duration_sec: 0.3333333333333333 } })
    expect([...owners.keys()]).toEqual([okey(SAILOR_ASSET_KIND, id)])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a marked record is filled in by a re-import too (no route read in between), same id, same owner', async () => {
    const { runMedia } = await import('../../server/media/run')
    const { PROBE_AGAIN } = await import('../../server/native/media')
    uploads.set('input::clip.mp4', 'u1')
    clip('v_h264_709.mp4', inDir('clip.mp4'))
    const never: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Uint8Array>>(() => {}) }) }
    const hold = new AbortController()
    const holders = Array.from({ length: 5 }, () => runMedia({
      tool: 'ffmpeg', args: ['-f', 'f32le', '-ar', '8000', '-ch_layout', 'mono', '-i', 'pipe:0', '-f', 'null', 'pipe:1'],
      userId: 'u1', route: true, stdin: never, signal: hold.signal,
    }).catch(() => 'stopped'))
    await new Promise(r => setTimeout(r, 200))
    let first: any
    try { first = await call('/sailor/asset_import', 'POST', 'u1', { path: 'clip.mp4' }) }
    finally {
      hold.abort()
      await Promise.all(holders)
    }
    expect(first.body.asset[PROBE_AGAIN]).toBe(true)
    const again = await call('/sailor/asset_import', 'POST', 'u1', { path: 'clip.mp4' })
    expect(again.body).toMatchObject({ created: false, asset: { id: first.body.asset.id, duration_sec: 0.3333333333333333, width: 32, height: 24 } })
    expect(PROBE_AGAIN in again.body.asset).toBe(false)
    expect(readAssets()).toEqual([again.body.asset])
    expect(owners.get(okey(SAILOR_ASSET_KIND, first.body.asset.id))).toBe('u1')
  })

  it('another user\'s input_thumbnail and asset_import are refused (404) before any job starts', async () => {
    uploads.set('input::theirs.mp4', 'u2')
    clip('v_h264_601.mp4', inDir('theirs.mp4'))
    const before = limiter().started()
    expect((await call('/sailor/input_thumbnail?filename=theirs.mp4', 'GET', 'u1')).status).toBe(404)
    expect((await call('/sailor/asset_import', 'POST', 'u1', { path: 'theirs.mp4' })).status).toBe(404)
    expect(limiter().started()).toBe(before)
    expect(fs.existsSync(userFile('timeline_thumbs')) ? fs.readdirSync(userFile('timeline_thumbs')) : []).toEqual([])
    expect([...owners.keys()]).toEqual([])
  })
})
