/**
 * LC10 fix round 1:
 *   - the cancel watch for a Stop while the model runs (animateCancels.ts): a
 *     cancel counts as believed only when fal confirms it, a job that ran
 *     anyway is reported as `runner.cancel.ran-anyway`, and unconfirmed Stops
 *     count against the person (3 in 10 minutes → a pause);
 *   - the keying worker (clipKeyWorker.ts): the same bytes as the main-thread
 *     keyer, a global cap of KEY_WORKERS_MAX, Stop terminates it; its source
 *     text survives an esbuild build as Nitro does it;
 *   - hosted /view of a clip folder answers to the clip's owner row only.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import {
  __setAnimateCancelDepsForTests, ANIMATE_STOP_LIMIT, ANIMATE_STOPS_REFUSED, animateStopsRefusal,
  CANCEL_WATCH_GIVE_UP_MS, CANCEL_WATCH_WAITS_MS, watchAnimateCancel,
} from '../../server/frame/animateCancels'
import * as engine from '../../server/runner/engine'
import { ClipKeyer } from '../../server/frame/clipKey'
import { KEY_WORKERS_MAX, keyWorkers, keyWorkerScript, withKeyWorker } from '../../server/frame/clipKeyWorker'
import { MediaError } from '../../server/media/run'
import { clipOwnerKey, viewGateDecision } from '../../server/utils/engineGate'
import { hostedViewGate } from '../../server/native/viewGate'
import { __setInputUploadsDbForTests } from '../../server/utils/inputUploads'

// ── the cancel watch ────────────────────────────────────────────────────────

type Status = 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED'
function fakeFal(statuses: Status[], errorOnCompleted = false) {
  let i = 0
  return {
    cancel: async () => 'requested' as const,
    status: async () => {
      const s = statuses[Math.min(i++, statuses.length - 1)]!
      return { status: s, queuePosition: null, logs: [], error: s === 'COMPLETED' && errorOnCompleted ? 'cancelled' : null, transient: false }
    },
  }
}
const job = (n: number, userId = 'u1') => ({ userId, endpoint: 'minimax/h3/image-to-video', requestId: `r${n}`, cancelUrl: `c${n}`, statusUrl: `s${n}` })

describe('the Animate cancel watch', () => {
  let clock = 0
  const reports: Array<{ msg: string; site: unknown }> = []
  const setup = (statuses: Status[], errorOnCompleted = false) => {
    reports.length = 0
    clock = 1_000_000
    __setAnimateCancelDepsForTests({
      client: fakeFal(statuses, errorOnCompleted) as any,
      sleep: async (ms) => { clock += ms },
      now: () => clock,
      report: (e, ctx) => reports.push({ msg: e.message, site: ctx.site }),
    })
  }
  afterEach(() => __setAnimateCancelDepsForTests(null))

  it('uses the runner\'s own waits and give-up', () => {
    expect(CANCEL_WATCH_WAITS_MS).toEqual(engine.CANCEL_WATCH_WAITS_MS)
    expect(CANCEL_WATCH_GIVE_UP_MS).toBe(engine.CANCEL_WATCH_GIVE_UP_MS)
  })

  it('a cancel fal confirms at once (it ended with an error) is not counted', async () => {
    setup(['COMPLETED'], true)
    await watchAnimateCancel(job(1))
    expect(animateStopsRefusal('u1')).toBeNull()
    expect(reports).toEqual([])
  })

  it('a job that finished anyway is reported as the runner reports it, and counted', async () => {
    setup(['IN_PROGRESS', 'COMPLETED'])
    await watchAnimateCancel(job(1))
    expect(reports).toEqual([{ msg: expect.stringMatching(/finished after Sailor cancelled it/), site: 'runner.cancel.ran-anyway' }])
    setup(['COMPLETED'])
    await watchAnimateCancel(job(2))
    expect(reports.map(r => r.site)).toEqual(['runner.cancel.ran-anyway'])
  })

  it('unconfirmed Stops count: the third refuses in plain words, later ones confirmed ended stop counting', async () => {
    setup(['IN_PROGRESS'])
    // Never confirmed: each watch runs until it gives up (the fake clock jumps).
    for (let n = 1; n < ANIMATE_STOP_LIMIT; n++) {
      setup(['IN_PROGRESS', 'COMPLETED'], true) // unconfirmed at once, then confirmed ended
      await watchAnimateCancel(job(n))
    }
    expect(animateStopsRefusal('u1')).toBeNull()
    // Three unconfirmed in the window, left unconfirmed.
    reports.length = 0
    const never = { cancel: async () => 'requested' as const, status: async () => ({ status: 'IN_PROGRESS', queuePosition: null, logs: [], error: null, transient: false }) }
    let t = 5_000_000
    const pending: Promise<void>[] = []
    __setAnimateCancelDepsForTests({ client: never as any, sleep: () => new Promise(() => {}), now: () => t, report: (e, ctx) => reports.push({ msg: e.message, site: ctx.site }) })
    for (let n = 10; n < 10 + ANIMATE_STOP_LIMIT; n++) { pending.push(watchAnimateCancel(job(n))); await new Promise(r => setTimeout(r, 1)) }
    expect(animateStopsRefusal('u1')).toBe(ANIMATE_STOPS_REFUSED)
    expect(animateStopsRefusal('u2')).toBeNull()
    // Ten minutes on, the pause is over.
    t += 10 * 60_000 + 1
    expect(animateStopsRefusal('u1')).toBeNull()
  })

  it('gives up after 48 hours and says so', async () => {
    setup(['IN_PROGRESS'])
    await watchAnimateCancel(job(1))
    expect(reports.map(r => r.site)).toEqual(['runner.cancel.gave-up'])
  })
})

// ── the keying worker ───────────────────────────────────────────────────────

const W = 32
function still(): Uint8Array {
  const s = new Uint8Array(W * W * 4)
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) if (Math.hypot(x - 16, y - 16) < 9) s.set([200, 60, 90, 255], (y * W + x) * 4)
  return s
}
function frame(): Uint8Array {
  const f = new Uint8Array(W * W * 3)
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) f.set(Math.hypot(x - 17, y - 16) < 9 ? [200, 60, 90] : [40, 225, 70], (y * W + x) * 3)
  return f
}
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

describe('the keying worker', () => {
  it('keys exactly as the keyer does on the main thread', async () => {
    const ref = new ClipKeyer(still(), W, W, [0, 255, 0], W, W).keyFrame(frame())
    const got = await withKeyWorker(undefined, async (w) => {
      expect(await w.init(still(), W, W, [0, 255, 0], W, W)).toEqual({ ow: W, oh: W })
      return w.key(frame())
    })
    expect(sha(got)).toBe(sha(ref))
    expect(keyWorkers()).toEqual({ running: 0, waiting: 0 })
  })

  it('flattens and picks the key colour', async () => {
    const r = await withKeyWorker(undefined, w => w.flatten(still()))
    expect(r.keyHex).toBe('#00ff00')
    expect([...r.rgb.subarray(0, 3)]).toEqual([0, 255, 0])
  })

  it(`runs at most ${KEY_WORKERS_MAX} at once; Stop ends a waiting one and a running one`, async () => {
    const gates: Array<() => void> = []
    const hold = () => withKeyWorker(undefined, () => new Promise<void>(r => gates.push(r)))
    const a = hold(); const b = hold()
    await new Promise(r => setTimeout(r, 5))
    expect(keyWorkers()).toEqual({ running: KEY_WORKERS_MAX, waiting: 0 })
    const ac = new AbortController()
    const c = withKeyWorker(ac.signal, async () => 'ran')
    await new Promise(r => setTimeout(r, 5))
    expect(keyWorkers().waiting).toBe(1)
    ac.abort()
    await expect(c).rejects.toBeInstanceOf(MediaError)
    expect(keyWorkers().waiting).toBe(0)
    gates.forEach(g => g()); await Promise.all([a, b])
    // Stop while a frame is being keyed: the worker is terminated and the call fails as stopped.
    const ac2 = new AbortController()
    const d = withKeyWorker(ac2.signal, async (w) => {
      await w.init(still(), W, W, [0, 255, 0], W, W)
      const p = w.key(frame())
      ac2.abort()
      return p
    })
    await expect(d).rejects.toMatchObject({ word: 'stopped' })
    expect(keyWorkers()).toEqual({ running: 0, waiting: 0 })
  })

  describe('esbuild guard: the keyer\'s source text survives Nitro\'s build', () => {
    const require = createRequire(import.meta.url)
    const pnpm = fileURLToPath(new URL('../../node_modules/.pnpm/', import.meta.url))
    const builds = readdirSync(pnpm).filter(d => /^esbuild@\d/.test(d)).map(d => join(pnpm, d, 'node_modules', 'esbuild'))
    const src = readFileSync(fileURLToPath(new URL('../../server/frame/clipKey.ts', import.meta.url)), 'utf8')
    const dir = mkdtempSync(join(tmpdir(), 'clipkey-esbuild-'))
    const ref = sha(new ClipKeyer(still(), W, W, [0, 255, 0], W, W).keyFrame(frame()))
    it('finds an esbuild', () => expect(builds.length).toBeGreaterThan(0))
    for (const esbuildDir of builds.slice(-1)) {
      for (const minify of [false, true]) {
        it(`minify ${minify}: the built core keys the same bytes in a Worker`, async () => {
          const esb = require(esbuildDir) as typeof import('esbuild')
          let code = (await esb.transform(src, { loader: 'ts', target: 'es2019', format: 'esm' })).code
          if (minify) code = (await esb.transform(code, { loader: 'js', target: 'es2019', minify: true })).code
          const file = join(dir, `clipKey-${minify}.mjs`)
          writeFileSync(file, code)
          const mod = await import(`${pathToFileURL(file).href}?${Math.random()}`) as { clipKeyCore: () => unknown }
          const w = new Worker(keyWorkerScript(mod.clipKeyCore), { eval: true })
          try {
            const reply = (m: Record<string, unknown>) => new Promise<any>((res) => { w.once('message', res); w.postMessage(m) })
            const r1 = await reply({ id: 1, op: 'init', still: still().buffer, sw: W, sh: W, key: [0, 255, 0], fw: W, fh: W })
            expect(r1.error).toBeUndefined()
            expect(r1.value).toEqual({ ow: W, oh: W })
            const out = await reply({ id: 2, op: 'key', frame: frame().buffer })
            expect(sha(new Uint8Array(out.value))).toBe(ref)
          }
          finally { await w.terminate() }
        }, 30_000)
      }
    }
  })
})

// ── hosted /view of a clip folder ───────────────────────────────────────────

describe('hosted /view of an Animate clip', () => {
  const rows = new Map<string, string>([['input:sailor_clips/clip_1_abc:clip.json', 'owner']])
  afterEach(() => __setInputUploadsDbForTests(null))
  const gate = (userId: string, subfolder: string, filename = '000000.png', type = 'input') => {
    __setInputUploadsDbForTests({ query: async (_sql: string, p?: unknown[]) => ({ rows: rows.has(String(p![0])) ? [{ user_id: rows.get(String(p![0])) }] : [] }) })
    return hostedViewGate(userId, { filename, type, subfolder })
  }

  it('keys every path into a clip folder to its one owner row', () => {
    for (const sub of ['sailor_clips/clip_1_abc', 'sailor_clips/clip_1_abc/', './sailor_clips/clip_1_abc', 'sailor_clips//clip_1_abc', 'x/../sailor_clips/clip_1_abc', 'sailor_clips/clip_1_abc/deeper']) {
      expect(clipOwnerKey(sub), sub).toBe('input:sailor_clips/clip_1_abc:clip.json')
    }
    expect(clipOwnerKey('sailor_clips')).toBe('input:sailor_clips:')
    expect(clipOwnerKey('other')).toBeNull()
    expect(clipOwnerKey('')).toBeNull()
    expect(viewGateDecision({ filename: 'a.png', type: 'input', subfolder: 'sailor_clips/clip_1_abc' })).toEqual({ kind: 'owner', key: 'input:sailor_clips/clip_1_abc:clip.json' })
    expect(viewGateDecision({ filename: 'a.png [input]', subfolder: 'sailor_clips/clip_1_abc' })).toMatchObject({ kind: 'owner' })
    expect(viewGateDecision({ filename: 'a.png', type: 'input', subfolder: 'masks' })).toEqual({ kind: 'ungated' })
  })

  it('serves the owner, and 404s anyone else, a missing row and sailor_clips itself alike', async () => {
    await expect(gate('owner', 'sailor_clips/clip_1_abc')).resolves.toBeUndefined()
    await expect(gate('owner', 'sailor_clips/clip_1_abc', 'source.mp4')).resolves.toBeUndefined()
    await expect(gate('other', 'sailor_clips/clip_1_abc')).rejects.toMatchObject({ statusCode: 404 })
    await expect(gate('other', 'sailor_clips/clip_9_zzz')).rejects.toMatchObject({ statusCode: 404 })
    await expect(gate('owner', 'sailor_clips', 'clip.json')).rejects.toMatchObject({ statusCode: 404 })
  })
})
