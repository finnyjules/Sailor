/**
 * Step 3, R10.8: POST /api/image-fetch writes through Sailor's own upload
 * (server/native/uploads.ts via dispatchUpload), never the engine's
 * /upload/image — it works with nothing on the engine's port. The web image
 * is fetched under the one safe-fetch policy; hosted, the caller must be
 * signed in and the stored file is recorded as theirs.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, createError, eventHandler, readBody, toWebHandler } from 'h3'
import sharp from 'sharp'

const fetched = vi.hoisted(() => ({ next: null as null | { status: number; contentType: string | null; data: ArrayBuffer } }))
vi.mock('~~/server/templates/safeFetch', async (orig) => {
  const real = await orig<typeof import('~~/server/templates/safeFetch')>()
  return {
    ...real,
    // A public picture host, faked; anything else goes to the real policy.
    safeFetch: vi.fn(async (url: string, p: Parameters<typeof real.safeFetch>[1], o?: Parameters<typeof real.safeFetch>[2]) => {
      if (url.startsWith('https://pics.example/') && fetched.next) return fetched.next
      return real.safeFetch(url, p, o)
    }),
  }
})

let root = ''
let png: Buffer
const queries: { sql: string; params: unknown[] }[] = []

async function post(body: unknown, userId: string | null = null) {
  vi.stubGlobal('defineEventHandler', eventHandler)
  vi.stubGlobal('readBody', readBody)
  vi.stubGlobal('createError', createError)
  const route = (await import('~~/server/api/image-fetch.post')).default
  const app = createApp()
  if (userId) app.use(eventHandler((e) => { e.context.userId = userId }))
  app.use(route)
  return toWebHandler(app)(new Request('http://x/api/image-fetch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
}

beforeEach(async () => {
  vi.resetModules()
  png ??= await sharp({ create: { width: 3, height: 2, channels: 3, background: '#0a0' } }).png().toBuffer()
  fetched.next = { status: 200, contentType: 'image/png', data: png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer }
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'r108-image-fetch-'))
  for (const t of ['input', 'output', 'temp']) fs.mkdirSync(path.join(root, t))
  const up = await import('~~/server/utils/inputUploads')
  up.__setInputUploadsEngineRootForTests(root)
  queries.length = 0
  up.__setInputUploadsDbForTests({ query: async (sql: string, params: unknown[] = []) => { queries.push({ sql, params }); return { rows: [] } } })
  // Nothing listens on the engine's port.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:8188') }))
})
afterEach(async () => {
  delete process.env.NUXT_CLERK_SECRET_KEY
  vi.unstubAllGlobals()
  const up = await import('~~/server/utils/inputUploads')
  up.__setInputUploadsDbForTests(null)
})

describe('POST /api/image-fetch — nothing on the engine’s port', () => {
  it('writes the picture into the input folder itself and answers its name', async () => {
    const res = await post({ url: 'https://pics.example/photos/cat%20one.jpg' })
    expect(res.status).toBe(200)
    const { name } = await res.json() as { name: string }
    expect(name).toMatch(/^websearch_cat_one_[0-9a-z]+\.png$/)
    expect(fs.readFileSync(path.join(root, 'input', name)).equals(png)).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
    expect(queries).toEqual([]) // local: no ownership rows
  })

  it('never overwrites: a name already taken gets the upload’s own suffix', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234567)
    const first = await (await post({ url: 'https://pics.example/a.png' })).json() as { name: string }
    fs.writeFileSync(path.join(root, 'input', first.name), 'someone else')
    const second = await (await post({ url: 'https://pics.example/a.png' })).json() as { name: string }
    expect(second.name).not.toBe(first.name)
    expect(fs.readFileSync(path.join(root, 'input', first.name), 'utf8')).toBe('someone else')
    vi.restoreAllMocks()
  })

  it('refuses a private address under the safe-fetch policy, before any write', async () => {
    for (const url of ['http://127.0.0.1:8188/view?filename=x.png', 'http://10.0.0.1/x.png', 'http://localhost/x.png']) {
      const res = await post({ url })
      expect(res.status, url).toBe(400)
    }
    expect(fs.readdirSync(path.join(root, 'input'))).toEqual([])
  })

  it('refuses what isn’t a picture', async () => {
    fetched.next = { status: 200, contentType: 'text/html', data: new ArrayBuffer(4) }
    expect((await post({ url: 'https://pics.example/page' })).status).toBe(415)
    expect((await post({ url: 'ftp://pics.example/a.png' })).status).toBe(400)
    expect(fs.readdirSync(path.join(root, 'input'))).toEqual([])
  })

  it('says so when the input folder can’t be found', async () => {
    const up = await import('~~/server/utils/inputUploads')
    up.__setInputUploadsEngineRootForTests(null)
    const res = await post({ url: 'https://pics.example/a.png' })
    expect(res.status).toBe(502)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('hosted: signed out is a 401 before any download', async () => {
    process.env.NUXT_CLERK_SECRET_KEY = 'sk_test_x'
    const { safeFetch } = await import('~~/server/templates/safeFetch')
    ;(safeFetch as any).mockClear()
    expect((await post({ url: 'https://pics.example/a.png' })).status).toBe(401)
    expect(safeFetch).not.toHaveBeenCalled()
  })

  it('hosted: the stored file is recorded as the caller’s own upload', async () => {
    process.env.NUXT_CLERK_SECRET_KEY = 'sk_test_x'
    const res = await post({ url: 'https://pics.example/a.png' }, 'user_1')
    expect(res.status).toBe(200)
    const { name } = await res.json() as { name: string }
    expect(queries.some(q => /INSERT INTO input_uploads/.test(q.sql) && q.params[0] === `input::${name}` && q.params[1] === 'user_1')).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
  })
})
