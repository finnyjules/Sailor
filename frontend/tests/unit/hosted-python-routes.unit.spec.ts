/**
 * Step 3, LC7: the hosted image has no Python (R10.10). The route that still
 * runs a repo-venv script — voice clone from YouTube
 * (scripts/youtube_voice_clip.py) — must refuse in hosted FIRST: before the
 * body is read, before the rate limit counts, before any paid call or hold,
 * and without ever starting a child process. Locally it still validates and
 * runs as before. (Frame Animate left this list in LC10: its keyer is ported
 * to Node, server/frame/clipKey.ts; frame-animate-route.unit.spec.ts covers it
 * locally and in hosted.)
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const spawned = vi.hoisted(() => ({ calls: [] as unknown[][] }))
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return {
    ...real,
    execFile: (...args: unknown[]) => { spawned.calls.push(args); throw new Error('no child process in this spec') },
  }
})
const fal = vi.hoisted(() => ({ uploads: 0 }))
vi.mock('../../server/utils/falStorage', () => ({
  uploadToFalStorage: async () => { fal.uploads++; throw new Error('no upload in this spec') },
}))

const g = globalThis as any
g.createError = (opts: { statusCode: number, message?: string }) => {
  const err = new Error(opts.message) as Error & { statusCode: number }
  err.statusCode = opts.statusCode
  return err
}
g.defineEventHandler = (fn: any) => fn
g.readBody = async (event: any) => {
  event.__bodyRead = true
  return event.__body
}

type Mod = { default: (e: any) => Promise<unknown> }
let youtube: Mod & { YOUTUBE_VOICE_HOSTED_REFUSAL: string }

beforeAll(async () => {
  youtube = await import('../../server/api/voice-clone/from-youtube.post') as any
})

const CLERK_KEY = 'NUXT_CLERK_SECRET_KEY'
const saved = process.env[CLERK_KEY]
let n = 0
const event = (body: unknown) => ({
  __body: body,
  __bodyRead: false,
  // A fresh address each time, so the rate limiter never carries over between cases.
  node: { req: { headers: {}, socket: { remoteAddress: `10.9.${(n >> 8) & 255}.${n++ & 255}` } }, res: {} },
  context: { userId: 'user_lc7' },
})

beforeEach(() => { spawned.calls.length = 0; fal.uploads = 0 })
afterEach(() => { if (saved === undefined) delete process.env[CLERK_KEY]; else process.env[CLERK_KEY] = saved })

async function refusal(run: () => Promise<unknown>): Promise<{ statusCode: number, message: string }> {
  try { await run() } catch (e) { return e as any }
  throw new Error('expected a refusal')
}

describe('voice clone from YouTube in hosted', () => {
  it('refuses plainly before reading the body or starting a capture', async () => {
    process.env[CLERK_KEY] = 'sk_test_hosted'
    const ev = event({ url: 'https://www.youtube.com/watch?v=x', startSec: 0, endSec: 20 })
    const err = await refusal(() => youtube.default(ev))
    expect(err.statusCode).toBe(501)
    expect(err.message).toBe(youtube.YOUTUBE_VOICE_HOSTED_REFUSAL)
    expect(err.message).toMatch(/Upload an audio file instead\.$/)
    expect(ev.__bodyRead).toBe(false)
    expect(fal.uploads).toBe(0)
    expect(spawned.calls).toHaveLength(0)
  })

  it('still validates locally (no refusal)', async () => {
    delete process.env[CLERK_KEY]
    const err = await refusal(() => youtube.default(event({ url: 'not a url', startSec: 0, endSec: 20 })))
    expect(err.statusCode).toBe(400)
    expect(err.message).toBe('A valid YouTube URL is required')
    expect(spawned.calls).toHaveLength(0)
  })
})
