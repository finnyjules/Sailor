/**
 * A2 follow-up fix, item 2: `useClipPreview`'s in-memory caches used to treat
 * a 503 ("this needs the local engine") exactly like a real empty result —
 * `thumbCache`/`waveformCache` got `[]` written into them, permanently, for
 * the rest of the session. A clip whose thumbnail request raced the engine's
 * own startup (or landed on a request that briefly 503'd) would then never
 * show a thumbnail again without a full reload, even once the engine came up.
 *
 * The fix: a 503 is remembered in a SEPARATE map (key -> the timestamp of
 * that 503), never written into thumbCache/waveformCache. While that entry
 * is younger than 60s, getThumbs/getWaveform return null (same as "never
 * fetched yet") instead of re-fetching; past 60s the next call tries again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetClipPreviewCachesForTests, useClipPreview } from '../../app/composables/useClipPreview'

function res(status: number, body: unknown) {
  return { status, json: async () => body } as any
}

/** Drain the fetch(...).then().then().catch().finally() microtask chain. */
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe('useClipPreview: a 503 is suppressed, not cached as an empty result', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let now: number

  beforeEach(() => {
    __resetClipPreviewCachesForTests()
    now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    __resetClipPreviewCachesForTests()
  })

  it('getThumbs: does not refetch within 60s of a 503, and null does not become a cached []', async () => {
    fetchMock.mockResolvedValue(res(503, {}))
    const { getThumbs } = useClipPreview()

    expect(getThumbs('a1', 5)).toBeNull()
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Still inside the 60s window: no second request, still null (not []).
    now = 59_000
    expect(getThumbs('a1', 5)).toBeNull()
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Past the window: retried.
    now = 60_001
    expect(getThumbs('a1', 5)).toBeNull()
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('getWaveform: same suppression behaviour, tracked independently of thumbnails', async () => {
    fetchMock.mockResolvedValue(res(503, {}))
    const { getThumbs, getWaveform } = useClipPreview()

    expect(getThumbs('a2', 5)).toBeNull()
    expect(getWaveform('a2', 256)).toBeNull()
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(2) // one for each — independent maps

    now = 10_000
    expect(getThumbs('a2', 5)).toBeNull()
    expect(getWaveform('a2', 256)).toBeNull()
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(2) // both still suppressed
  })

  it('a success once the engine is back populates the cache normally, past the 503 window', async () => {
    fetchMock.mockResolvedValueOnce(res(503, {}))
    const { getThumbs } = useClipPreview()
    expect(getThumbs('a3', 5)).toBeNull()
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    now = 60_001
    fetchMock.mockResolvedValueOnce(res(200, { thumbnails: ['data:x'] }))
    expect(getThumbs('a3', 5)).toBeNull() // still null on the call that triggers the retry
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(getThumbs('a3', 5)).toEqual(['data:x']) // now served from the real cache
  })

  it('a normal 200 answer is cached exactly as before (unaffected by the 503 path)', async () => {
    fetchMock.mockResolvedValue(res(200, { thumbnails: ['data:y', 'data:z'] }))
    const { getThumbs } = useClipPreview()
    expect(getThumbs('a4', 3)).toBeNull()
    await flush()
    expect(getThumbs('a4', 3)).toEqual(['data:y', 'data:z'])
    // Cached — no second fetch even well past any suppression window.
    now = 1_000_000
    expect(getThumbs('a4', 3)).toEqual(['data:y', 'data:z'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
