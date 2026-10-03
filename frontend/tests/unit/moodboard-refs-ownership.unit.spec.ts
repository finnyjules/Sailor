/**
 * Stage 6 final review I1 — the moodboard refs/images routes must not read or
 * write another tenant's `moodboard_<ts>` folder.
 *
 * `POST /api/moodboards/refs` copied the first N images out of ANY folder into
 * the input ROOT and recorded them as the CALLER's owned inputs — a cross-tenant
 * read that launders ownership (the source files belong to another tenant).
 * `POST /api/moodboards/images` accepted an arbitrary existing folder and wrote
 * into it — a cross-tenant write. Both are now gated in hosted mode by the SAME
 * per-file ownership read `images.get.ts` already enforces (own-or-curated via
 * uploadOwner): a folder whose files belong to another tenant → 404, nothing
 * copied/written/recorded. Local mode is byte-identical (no registry at all).
 *
 * refs.post is driven as a plain event (global readBody); images.post rides a
 * real h3 app (it parses multipart via readUploadForm) with a middleware that
 * injects event.context.userId.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp, eventHandler, toWebHandler } from 'h3'
import { __setInputUploadsDbForTests, canonicalUploadKey } from '../../server/utils/inputUploads'
import { shortUserHash } from '../../server/utils/meterGraphRun'

const g = globalThis as any
g.defineEventHandler = (fn: any) => fn
g.readBody = async (event: any) => event.body ?? {}
g.getQuery = (event: any) => event.query ?? {}
g.createError = (opts: { statusCode: number, message?: string, statusMessage?: string }) => {
  const err = new Error(opts.message ?? opts.statusMessage ?? 'error') as Error & { statusCode: number }
  err.statusCode = opts.statusCode
  return err
}

const CLERK_KEY = 'NUXT_CLERK_SECRET_KEY'
const savedClerk = process.env[CLERK_KEY]
function setHosted(): void { process.env[CLERK_KEY] = 'sk_test_hosted' }
function setLocal(): void { delete process.env[CLERK_KEY] }

// In-memory input_uploads table (models-store pattern).
const uploads = new Map<string, string>()
const query = vi.fn(async (sql: string, params: any[] = []) => {
  if (/INSERT INTO input_uploads/i.test(sql)) {
    const [fileKey, uid] = params
    if (!uploads.has(fileKey)) uploads.set(fileKey, uid)
    return { rows: [] }
  }
  if (/SELECT user_id FROM input_uploads/i.test(sql)) {
    const [fileKey] = params
    const v = uploads.get(fileKey)
    return { rows: v ? [{ user_id: v }] : [] }
  }
  return { rows: [] }
})

let tmp: string
let cwd: string
let inputDir: string
let refsHandler: any
let imagesHandler: any

beforeAll(async () => {
  refsHandler = (await import('../../server/api/moodboards/refs.post')).default
  imagesHandler = (await import('../../server/api/moodboards/images.post')).default
})
afterAll(() => { process.chdir(cwd) })

beforeEach(async () => {
  cwd = process.cwd()
  tmp = mkdtempSync(path.join(os.tmpdir(), 'mb-refs-'))
  inputDir = path.join(tmp, 'input')
  await fs.mkdir(inputDir, { recursive: true })
  await fs.mkdir(path.join(tmp, 'frontend'), { recursive: true })
  process.chdir(path.join(tmp, 'frontend'))
  uploads.clear()
  query.mockClear()
  __setInputUploadsDbForTests({ query })
})
afterEach(async () => {
  process.chdir(cwd)
  await fs.rm(tmp, { recursive: true, force: true })
  __setInputUploadsDbForTests(null)
  if (savedClerk === undefined) delete process.env[CLERK_KEY]
  else process.env[CLERK_KEY] = savedClerk
})

async function seedFolder(folder: string, files: string[], owner: string | null): Promise<void> {
  const dir = path.join(inputDir, folder)
  await fs.mkdir(dir, { recursive: true })
  for (const f of files) {
    await fs.writeFile(path.join(dir, f), 'imgbytes')
    if (owner) uploads.set(canonicalUploadKey('input', folder, f), owner)
  }
}
function ev(opts: { body?: any, userId?: string | null }) {
  return { body: opts.body, context: { userId: opts.userId ?? null } }
}
async function statusOf(run: Promise<unknown>): Promise<number> {
  try { await run } catch (e: any) { return e.statusCode }
  throw new Error('expected the handler to throw, but it resolved')
}

// ---- refs.post ----
describe('refs.post — cross-tenant folder read is refused', () => {
  it('hosted: referencing ANOTHER tenant\'s folder → 404, nothing copied, nothing recorded', async () => {
    setHosted()
    await seedFolder('moodboard_111', ['a.png', 'b.png'], 'u2')
    expect(await statusOf(refsHandler(ev({ body: { folder: 'moodboard_111', slug: 'board-x' }, userId: 'u1' })))).toBe(404)
    // no flat mb_ files landed in the input root
    const root = await fs.readdir(inputDir)
    expect(root.filter(n => n.startsWith('mb_'))).toEqual([])
    // nothing recorded as u1's
    expect([...uploads.values()].filter(v => v === 'u1')).toEqual([])
  })

  it('hosted: own folder → copies the images and records them as the caller\'s inputs', async () => {
    setHosted()
    await seedFolder('moodboard_222', ['a.png', 'b.png'], 'u1')
    const res = await refsHandler(ev({ body: { folder: 'moodboard_222', slug: 'mine' }, userId: 'u1' }))
    const h = shortUserHash('u1')
    expect(res.files).toEqual([`mb_${h}_mine_0.png`, `mb_${h}_mine_1.png`])
    await fs.access(path.join(inputDir, `mb_${h}_mine_0.png`))
    expect(uploads.get(canonicalUploadKey('input', '', `mb_${h}_mine_0.png`))).toBe('u1')
  })

  it('hosted: curated folder (no owner rows) → still copyable (own-or-curated read)', async () => {
    setHosted()
    await seedFolder('moodboard_333', ['a.png'], null)
    const res = await refsHandler(ev({ body: { folder: 'moodboard_333', slug: 'curated' }, userId: 'u1' }))
    expect(res.files).toEqual([`mb_${shortUserHash('u1')}_curated_0.png`])
  })

  it('local mode: unchanged — copies regardless of ownership, no registry read', async () => {
    setLocal()
    await seedFolder('moodboard_444', ['a.png'], 'u2')
    const res = await refsHandler(ev({ body: { folder: 'moodboard_444', slug: 'anyx' }, userId: null }))
    expect(res.files).toEqual(['mb_anyx_0.png'])
    expect(query).not.toHaveBeenCalled()
  })
})

// ---- images.post (real h3 app so readUploadForm parses multipart) ----
describe('images.post — cross-tenant folder write is refused', () => {
  function handlerFor(userId: string | null) {
    const app = createApp()
    app.use(eventHandler(async (event) => {
      event.context.userId = userId
      try { return await imagesHandler(event) }
      catch (e: any) { event.node.res.statusCode = e.statusCode || 500; return { error: e.message } }
    }))
    return toWebHandler(app)
  }
  function upload(folder: string, filename = 'p.png') {
    const body = new FormData()
    body.append('images', new File([new Uint8Array([1, 2, 3])], filename, { type: 'image/png' }))
    body.append('folder', folder)
    return new Request('http://localhost/api/moodboards/images', { method: 'POST', body })
  }

  it('hosted: writing into ANOTHER tenant\'s existing folder → 404, no file written', async () => {
    setHosted()
    await seedFolder('moodboard_555', ['00_existing.png'], 'u2')
    const res = await handlerFor('u1')(upload('moodboard_555'))
    expect(res.status).toBe(404)
    const names = await fs.readdir(path.join(inputDir, 'moodboard_555'))
    expect(names).toEqual(['00_existing.png']) // nothing new landed
  })

  it('hosted: minting a NEW folder writes fine and records ownership', async () => {
    setHosted()
    const res = await handlerFor('u1')(upload('moodboard_666'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.files.length).toBe(1)
    expect(uploads.get(canonicalUploadKey('input', 'moodboard_666', body.files[0]))).toBe('u1')
  })
})

describe('LC11 fix round 1: a flat copy never overwrites another person\'s file (two accounts)', () => {
  it('hosted: A and B saving the same slug get their own copies; neither overwrites the other', async () => {
    setHosted()
    await seedFolder('moodboard_501', ['a.png'], 'uA')
    await fs.writeFile(path.join(inputDir, 'moodboard_501', 'a.png'), 'A-bytes')
    await seedFolder('moodboard_502', ['b.png'], 'uB')
    await fs.writeFile(path.join(inputDir, 'moodboard_502', 'b.png'), 'B-bytes')
    const a = await refsHandler(ev({ body: { folder: 'moodboard_501', slug: 'shared' }, userId: 'uA' }))
    const b = await refsHandler(ev({ body: { folder: 'moodboard_502', slug: 'shared' }, userId: 'uB' }))
    expect(a.files[0]).not.toBe(b.files[0])
    expect(await fs.readFile(path.join(inputDir, a.files[0]), 'utf8')).toBe('A-bytes')
    expect(await fs.readFile(path.join(inputDir, b.files[0]), 'utf8')).toBe('B-bytes')
    expect(uploads.get(canonicalUploadKey('input', '', a.files[0]))).toBe('uA')
    expect(uploads.get(canonicalUploadKey('input', '', b.files[0]))).toBe('uB')
    // A's re-save of its own copy still overwrites in place.
    await fs.writeFile(path.join(inputDir, 'moodboard_501', 'a.png'), 'A-bytes-2')
    expect((await refsHandler(ev({ body: { folder: 'moodboard_501', slug: 'shared' }, userId: 'uA' }))).files).toEqual(a.files)
    expect(await fs.readFile(path.join(inputDir, a.files[0]), 'utf8')).toBe('A-bytes-2')
  })

  it('hosted: a target name owned by someone else (B planted it) is refused 404 before any write', async () => {
    setHosted()
    await seedFolder('moodboard_601', ['a.png', 'b.png'], 'uA')
    const planted = `mb_${shortUserHash('uA')}_board_1.png`
    await fs.writeFile(path.join(inputDir, planted), 'B-bytes')
    uploads.set(canonicalUploadKey('input', '', planted), 'uB')
    expect(await statusOf(refsHandler(ev({ body: { folder: 'moodboard_601', slug: 'board' }, userId: 'uA' })))).toBe(404)
    expect(await fs.readFile(path.join(inputDir, planted), 'utf8')).toBe('B-bytes')
    // Nothing else was written either: the check runs before the first copy.
    expect((await fs.readdir(inputDir)).filter(n => n.startsWith('mb_'))).toEqual([planted])
  })

  it('hosted: a target already on disk that nobody recorded is refused (fail closed)', async () => {
    setHosted()
    await seedFolder('moodboard_701', ['a.png'], 'uA')
    const name = `mb_${shortUserHash('uA')}_board_0.png`
    await fs.writeFile(path.join(inputDir, name), 'somebody')
    expect(await statusOf(refsHandler(ev({ body: { folder: 'moodboard_701', slug: 'board' }, userId: 'uA' })))).toBe(404)
    expect(await fs.readFile(path.join(inputDir, name), 'utf8')).toBe('somebody')
  })

  it('hosted: an old-style copy (`mb_<slug>_<i>`) stays its owner\'s and is never overwritten by B', async () => {
    setHosted()
    await fs.writeFile(path.join(inputDir, 'mb_old_0.png'), 'A-old')
    uploads.set(canonicalUploadKey('input', '', 'mb_old_0.png'), 'uA')
    await seedFolder('moodboard_801', ['a.png'], 'uB')
    const b = await refsHandler(ev({ body: { folder: 'moodboard_801', slug: 'old' }, userId: 'uB' }))
    expect(b.files[0]).toBe(`mb_${shortUserHash('uB')}_old_0.png`)
    expect(await fs.readFile(path.join(inputDir, 'mb_old_0.png'), 'utf8')).toBe('A-old')
    expect(uploads.get(canonicalUploadKey('input', '', 'mb_old_0.png'))).toBe('uA')
  })
})
