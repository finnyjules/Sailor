/**
 * Stage 5 Task 2: the stale-hold sweep. Holds reserve credits at preflight
 * and are settled or released by the chokepoint that took them — but a
 * process that dies between hold and settle/release leaves the reservation
 * open forever, silently shrinking that user's spendable balance with no
 * corresponding charge. The sweep is the backstop: anything still 'open'
 * past HOLD_TTL_MS gets released.
 *
 * All I/O is injected (the settleWatcher.ts DI style) so this is a pure,
 * fast unit — no DATABASE_URL, no timers, no ledger session.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import {
  HOLD_SWEEP_FIRST_RUN_MS,
  HOLD_SWEEP_INTERVAL_MS,
  HOLD_TTL_MS,
  RUNNER_HOLD_TTL_MS,
  listStaleHoldIds,
  startHoldSweeperWith,
  sweepStaleHoldsWith,
} from '../../server/utils/holdSweep'
import { createLedger } from '../../server/utils/ledger'

let errorSpy: ReturnType<typeof vi.spyOn>
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  errorSpy.mockRestore()
  warnSpy.mockRestore()
})

const NOW = new Date('2026-08-17T12:00:00.000Z')

describe('sweepStaleHoldsWith', () => {
  it('releases every stale hold and returns the count', async () => {
    const release = vi.fn(async (_id: number) => {})
    const released = await sweepStaleHoldsWith(
      { listStaleHoldIds: async () => [11, 12, 13], release }, NOW,
    )

    expect(released).toBe(3)
    expect(release.mock.calls.map(c => c[0])).toEqual([11, 12, 13])
  })

  it('asks for holds older than exactly now - HOLD_TTL_MS', async () => {
    const listStaleHoldIds = vi.fn(async (_cutoff: Date) => [] as number[])
    await sweepStaleHoldsWith({ listStaleHoldIds, release: async () => {} }, NOW)

    const cutoff = listStaleHoldIds.mock.calls[0][0]
    expect(cutoff.getTime()).toBe(NOW.getTime() - HOLD_TTL_MS)
  })

  it('runner holds get 24 hours: the listing is also given now - RUNNER_HOLD_TTL_MS', async () => {
    const listStaleHoldIds = vi.fn(async (_cutoff: Date, _runnerCutoff: Date) => [] as number[])
    await sweepStaleHoldsWith({ listStaleHoldIds, release: async () => {} }, NOW)

    expect(RUNNER_HOLD_TTL_MS).toBe(24 * 60 * 60 * 1000)
    expect(listStaleHoldIds.mock.calls[0]![1].getTime()).toBe(NOW.getTime() - RUNNER_HOLD_TTL_MS)
  })

  it('nothing stale: returns 0 and stays quiet', async () => {
    const released = await sweepStaleHoldsWith(
      { listStaleHoldIds: async () => [], release: async () => {} }, NOW,
    )
    expect(released).toBe(0)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('one failing release is logged and does NOT abort the rest of the sweep', async () => {
    const release = vi.fn(async (id: number) => {
      if (id === 12) throw new Error('hold 12 vanished')
    })
    const released = await sweepStaleHoldsWith(
      { listStaleHoldIds: async () => [11, 12, 13], release }, NOW,
    )

    expect(release).toHaveBeenCalledTimes(3) // 13 still got its turn
    expect(released).toBe(2) // only the successful ones are counted
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[holdSweep] release failed'),
      expect.anything(),
    )
  })

  it('a listing failure surfaces to the caller rather than reporting a clean sweep', async () => {
    await expect(sweepStaleHoldsWith(
      { listStaleHoldIds: async () => { throw new Error('db down') }, release: async () => {} }, NOW,
    )).rejects.toThrow('db down')
  })

  it('the TTL is far longer than any legitimate job (2h)', () => {
    expect(HOLD_TTL_MS).toBe(2 * 60 * 60 * 1000)
  })
})

describe('listStaleHoldIds (the real query)', () => {
  it('a runner hold is swept only after 24 hours; any other hold after 2', async () => {
    const schema = readFileSync(fileURLToPath(new URL('../../server/db/schema.sql', import.meta.url)), 'utf8')
    const db = new PGlite()
    await db.exec(schema)
    const ledger = createLedger(db)
    await ledger.ensureUser('u1')
    await ledger.credit('u1', 1000, 'topup', 'seed')
    const ids: Record<string, number> = {}
    for (const key of ['runner:run_a.0.t0', 'runner:run_b.0.t0', 'train:job1', 'fal:call1']) {
      const h = await ledger.hold('u1', 10, key)
      if (!h.ok) throw new Error('hold failed')
      ids[key] = h.holdId
    }
    const ago = async (key: string, hours: number) =>
      db.query(`UPDATE holds SET created_at = $1 WHERE id = $2`, [new Date(NOW.getTime() - hours * 3600_000), ids[key]])
    await ago('runner:run_a.0.t0', 3) // queued at fal for 3 hours: not stale yet
    await ago('runner:run_b.0.t0', 25)
    await ago('train:job1', 3)
    await ago('fal:call1', 1)

    const stale = await listStaleHoldIds(db, new Date(NOW.getTime() - HOLD_TTL_MS), new Date(NOW.getTime() - RUNNER_HOLD_TTL_MS))
    expect(stale).toEqual([ids['runner:run_b.0.t0'], ids['train:job1']].sort((a, b) => a! - b!))
  })
})

describe('startHoldSweeperWith (what the Nitro plugin wires up)', () => {
  function deps(over: Record<string, unknown> = {}) {
    return {
      isHosted: () => true,
      sweep: vi.fn(async () => 0),
      setTimeout: vi.fn((_fn: () => void, _ms: number) => 't' as unknown as ReturnType<typeof setTimeout>),
      setInterval: vi.fn((_fn: () => void, _ms: number) => 'i' as unknown as ReturnType<typeof setInterval>),
      ...over,
    }
  }

  it('local mode: schedules nothing at all (never opens a ledger session)', () => {
    const d = deps({ isHosted: () => false })
    const started = startHoldSweeperWith(d as any)

    expect(started).toBe(false)
    expect(d.setTimeout).not.toHaveBeenCalled()
    expect(d.setInterval).not.toHaveBeenCalled()
    expect(d.sweep).not.toHaveBeenCalled()
  })

  it('hosted: schedules a delayed first run and a repeating interval, and sweeps nothing synchronously (boot is never blocked)', () => {
    const d = deps()
    const started = startHoldSweeperWith(d as any)

    expect(started).toBe(true)
    expect(d.sweep).not.toHaveBeenCalled() // nothing runs during boot
    expect(d.setTimeout).toHaveBeenCalledWith(expect.any(Function), HOLD_SWEEP_FIRST_RUN_MS)
    expect(d.setInterval).toHaveBeenCalledWith(expect.any(Function), HOLD_SWEEP_INTERVAL_MS)
  })

  it('hosted: the scheduled callbacks actually run the sweep', async () => {
    const d = deps()
    startHoldSweeperWith(d as any)

    await (d.setTimeout.mock.calls[0][0] as () => Promise<void>)()
    await (d.setInterval.mock.calls[0][0] as () => Promise<void>)()

    expect(d.sweep).toHaveBeenCalledTimes(2)
  })

  it('a sweep that throws on its tick is swallowed (an unhandled rejection would take the server down)', async () => {
    const d = deps({ sweep: vi.fn(async () => { throw new Error('db down') }) })
    startHoldSweeperWith(d as any)

    await expect((d.setInterval.mock.calls[0][0] as () => Promise<void>)()).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[holdSweep] sweep failed'),
      expect.anything(),
    )
  })

  it('first run is delayed past boot, and the interval is well inside the TTL', () => {
    expect(HOLD_SWEEP_FIRST_RUN_MS).toBe(60_000)
    expect(HOLD_SWEEP_INTERVAL_MS).toBe(15 * 60_000)
    expect(HOLD_SWEEP_INTERVAL_MS).toBeLessThan(HOLD_TTL_MS)
  })
})

/**
 * Review finding 4: HOLD_TTL_MS and the provider poll deadlines were two
 * unrelated numbers. If a route ever waits longer for a provider than the
 * sweep waits before reclaiming a hold, the sweep releases a reservation for
 * a job that is still running — and when that job finally succeeds, settle
 * lands on a released hold and the output ships UNCHARGED (requestMeter logs
 * 'SETTLE ON RELEASED HOLD', which is a report of lost money, not a fix).
 * This guard reads the deadlines out of the source so raising one without
 * raising the TTL fails a test instead of quietly leaking revenue.
 */
const DEADLINE_IDENTIFIER = /\b(pollDeadlineMs|timeoutMs|deadlineMs|maxWaitMs|pollTimeoutMs)\b/
const NUMERIC_LITERAL = /\b\d[\d_]*\b/g

interface DeadlineHit { file: string; line: number; ms: number; text: string }

/**
 * Every line in `dir` that names a deadline option and carries a numeric
 * literal, paired with the LARGEST literal on that line — which covers both
 * `{ timeoutMs: 120_000 }` at a call site and `opts.timeoutMs ?? 90_000`
 * defaults inside the runners.
 */
export function scanDeadlines(dir: string): DeadlineHit[] {
  const files: string[] = []
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (p.endsWith('.ts')) files.push(p)
    }
  }
  walk(dir)

  const hits: DeadlineHit[] = []
  for (const file of files) {
    readFileSync(file, 'utf8').split('\n').forEach((text, i) => {
      if (!DEADLINE_IDENTIFIER.test(text)) return
      const nums = (text.match(NUMERIC_LITERAL) ?? []).map(n => Number(n.replace(/_/g, '')))
      if (!nums.length) return
      hits.push({ file: relative(dir, file), line: i + 1, ms: Math.max(...nums), text: text.trim() })
    })
  }
  return hits
}

describe('poll deadlines vs the hold TTL', () => {
  const serverRoot = fileURLToPath(new URL('../../server', import.meta.url))
  const hits = scanDeadlines(serverRoot)

  it('the scan is not vacuous: it finds the real minute-scale provider deadlines', () => {
    expect(hits.length).toBeGreaterThan(5)
    // The longest today is scene3d's text-to-3D at 300s; don't pin that exact
    // number (it may legitimately move), just refuse to pass on an empty scan.
    expect(Math.max(...hits.map(h => h.ms))).toBeGreaterThanOrEqual(60_000)
    expect(hits.some(h => h.file.includes('scene3d'))).toBe(true)
  })

  it('every provider poll deadline in server/ finishes well before the sweep reclaims its hold', () => {
    const longest = hits.reduce((a, b) => (b.ms > a.ms ? b : a))
    expect(
      longest.ms,
      `${longest.file}:${longest.line} waits ${longest.ms}ms for a provider, but holdSweep ` +
      `releases holds after ${HOLD_TTL_MS}ms — the sweep would reclaim the reservation while ` +
      `the job is still running, and the finished job would then ship uncharged.\n  ${longest.text}`,
    ).toBeLessThan(HOLD_TTL_MS)
  })

  it('and with real headroom, not by a hair (a job may be queued before it starts polling)', () => {
    const longestMs = Math.max(...hits.map(h => h.ms))
    expect(longestMs * 4).toBeLessThan(HOLD_TTL_MS)
  })

  it('the guard actually catches a 3h deadline (self-test against a synthetic tree)', () => {
    // Without this, a scanner that silently stopped matching would make the
    // assertions above vacuously true forever.
    const dir = mkdtempSync(join(tmpdir(), 'deadline-guard-'))
    try {
      writeFileSync(join(dir, 'slow.post.ts'), 'const out = await runFal(app, input, { pollDeadlineMs: 10_800_000 })\n')
      const found = scanDeadlines(dir)

      expect(found).toHaveLength(1)
      expect(found[0].ms).toBe(3 * 60 * 60 * 1000)
      expect(found[0].ms).toBeGreaterThan(HOLD_TTL_MS) // i.e. the real assertion would fail
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
