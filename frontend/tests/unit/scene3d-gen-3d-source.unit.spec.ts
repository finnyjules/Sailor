/**
 * Step 3, R10.8: POST /api/scene3d/gen-3d reads a canvas pick (a `/view?…`
 * path) off disk itself, by name, under GET /view's rules — never from the
 * engine's port, so it works with nothing listening there. Hosted, the file
 * must be the caller's own (the /view gate); any other address goes through
 * the safe-fetch policy. fal is faked: no paid call.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, createError, eventHandler, readBody, toWebHandler } from 'h3'

const owned = vi.hoisted(() => ({ keys: new Set<string>() }))
vi.mock('~~/server/utils/graphRuns', async (orig) => ({
  ...(await orig<typeof import('~~/server/utils/graphRuns')>()),
  ownedOutputKeys: vi.fn(async () => owned.keys),
}))
vi.mock('~~/server/utils/engineGate', async (orig) => ({
  ...(await orig<typeof import('~~/server/utils/engineGate')>()),
  harvestPendingOutputs: vi.fn(async () => {}),
}))
vi.mock('~~/server/lib/rateLimit', () => ({ assertRateLimit: () => {} }))

const PICK = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
let root = ''
const uploadToFalStorage = vi.fn(async (_b: Uint8Array, _n: string, _t: string) => 'https://v3.fal.media/files/src.png')
const runFal = vi.fn(async () => ({ glb: 'https://v3.fal.media/files/model.glb' }))

async function post(body: unknown, userId: string | null = null) {
  vi.stubGlobal('defineEventHandler', eventHandler)
  vi.stubGlobal('readBody', readBody)
  vi.stubGlobal('createError', createError)
  vi.stubGlobal('uploadToFalStorage', uploadToFalStorage)
  vi.stubGlobal('runFal', runFal)
  vi.stubGlobal('resolve3dModel', () => ({ app: 'fal-ai/fake-3d', buildInput: (u: string) => ({ image_url: u }), glbUrlFrom: (r: { glb: string }) => r.glb }))
  const route = (await import('~~/server/api/scene3d/gen-3d.post')).default
  const app = createApp()
  if (userId) app.use(eventHandler((e) => { e.context.userId = userId }))
  app.use(route)
  return toWebHandler(app)(new Request('http://x/api/scene3d/gen-3d', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
}

beforeEach(async () => {
  vi.resetModules()
  uploadToFalStorage.mockClear()
  runFal.mockClear()
  owned.keys = new Set()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'r108-gen3d-'))
  for (const t of ['input', 'output', 'temp']) fs.mkdirSync(path.join(root, t))
  fs.mkdirSync(path.join(root, 'output', 'u_1'))
  fs.writeFileSync(path.join(root, 'output', 'pick.png'), PICK)
  fs.writeFileSync(path.join(root, 'output', 'u_1', 'mine.png'), PICK)
  ;(await import('~~/server/utils/inputUploads')).__setInputUploadsEngineRootForTests(root)
  // Nothing is ever fetched.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed: connect ECONNREFUSED') }))
})
afterEach(() => {
  delete process.env.NUXT_CLERK_SECRET_KEY
  vi.unstubAllGlobals()
})

const sent = () => Buffer.from(uploadToFalStorage.mock.calls[0]![0])

describe('POST /api/scene3d/gen-3d — a canvas pick, nothing on the engine’s port', () => {
  it('reads a /view path off disk, by name, and re-hosts those bytes', async () => {
    for (const p of ['/view?filename=pick.png&type=output', '/api/view?filename=pick.png', '/comfyui/view?filename=pick.png']) {
      uploadToFalStorage.mockClear()
      const res = await post({ imageUrl: p })
      expect(res.status, p).toBe(200)
      expect(await res.json()).toEqual({ glbUrl: 'https://v3.fal.media/files/model.glb' })
      expect(sent().equals(PICK)).toBe(true)
      expect(uploadToFalStorage.mock.calls[0]![2]).toBe('image/png')
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('a loopback /view address on the app’s own port is read off disk too, never fetched; the engine’s port no longer (C5)', async () => {
    vi.stubEnv('NUXT_PORT', '3002')
    try {
      const res = await post({ imageUrl: 'http://127.0.0.1:3002/view?filename=pick.png' })
      expect(res.status).toBe(200)
      expect(sent().equals(PICK)).toBe(true)
      expect((await post({ imageUrl: 'http://127.0.0.1:8188/view?filename=pick.png' })).status).toBe(400)
      expect(fetch).not.toHaveBeenCalled()
    }
    finally { vi.unstubAllEnvs() }
  })

  it('GET /view’s rules: a missing file is 404, a name that leaves the folder 400/403 — before any paid call', async () => {
    expect((await post({ imageUrl: '/view?filename=nope.png' })).status).toBe(404)
    expect((await post({ imageUrl: '/view?filename=../secret.png' })).status).toBe(400)
    expect((await post({ imageUrl: '/view?filename=pick.png&subfolder=../..' })).status).toBe(400)
    expect(runFal).not.toHaveBeenCalled()
    expect(uploadToFalStorage).not.toHaveBeenCalled()
  })

  it('only a /view path is read from this server; a private address is refused', async () => {
    for (const p of ['/internal-admin', '//evil.test/view?filename=pick.png', 'http://10.0.0.2/x.png', 'http://127.0.0.1:9999/admin']) {
      expect((await post({ imageUrl: p })).status, p).toBe(400)
    }
    expect(runFal).not.toHaveBeenCalled()
  })

  it('hosted: only the caller’s own output; someone else’s is a 404 before any paid call', async () => {
    process.env.NUXT_CLERK_SECRET_KEY = 'sk_test_x'
    expect((await post({ imageUrl: '/view?filename=mine.png&subfolder=u_1' }, null)).status).toBe(401)
    expect((await post({ imageUrl: '/view?filename=mine.png&subfolder=u_1' }, 'user_1')).status).toBe(404)
    expect((await post({ imageUrl: '/view?filename=mine.png&subfolder=u_1&filename=pick.png' }, 'user_1')).status).toBe(400)
    expect(runFal).not.toHaveBeenCalled()
    const { outputKey } = await import('~~/server/utils/graphRuns')
    owned.keys = new Set([outputKey({ filename: 'mine.png', subfolder: 'u_1', type: 'output' })])
    const res = await post({ imageUrl: '/view?filename=mine.png&subfolder=u_1' }, 'user_1')
    expect(res.status).toBe(200)
    expect(sent().equals(PICK)).toBe(true)
    // Hosted: no loopback exception.
    expect((await post({ imageUrl: 'http://127.0.0.1:8188/view?filename=mine.png&subfolder=u_1' }, 'user_1')).status).toBe(400)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('a fal url passes straight through', async () => {
    const res = await post({ imageUrl: 'https://v3.fal.media/files/already.png' })
    expect(res.status).toBe(200)
    expect(uploadToFalStorage).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
})
