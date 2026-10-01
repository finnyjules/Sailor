/**
 * Step 3, R8.0: the mini apps' run helper (composables/useAppRun.ts) and its
 * wait (lib/runner/awaitRunnerResult.ts awaitRunnerOutputs), fed fake runner
 * events. Face swap's own wait (awaitRunnerImage) is face-swap-app-runner's.
 */
import { effectScope } from 'vue'
import { describe, expect, it, vi, type Mock } from 'vitest'
import type { ApiPrompt } from '#shared/runner/graph'
import { AppRunStopped, AppRunTimedOut, awaitRunnerOutputs, nodeOutputOf } from '~/lib/runner/awaitRunnerResult'
import { AppRunCancelled, AppRunDeclined, AppRunRefused, QUOTE_BUSY, QUOTE_FAILED, QUOTE_FRESH_MS, STILL_GOING, STOP_FAILED, TIMED_OUT_STOP_FAILED, appPriceText, useAppRun, type AppQuote, type AppRunDeps } from '~/composables/useAppRun'

function fakeWindow() {
  const handlers = new Set<(e: MessageEvent) => void>()
  return {
    addEventListener: (_: string, h: any) => handlers.add(h),
    removeEventListener: (_: string, h: any) => handlers.delete(h),
    post: (data: Record<string, unknown>) => handlers.forEach(h => h({ data: { type: 'sailor-bridge', ...data } } as MessageEvent)),
    size: () => handlers.size,
  }
}

const file = (filename: string, type = 'output') => ({ filename, subfolder: '', type })
const PROMPT: ApiPrompt = { 1: { class_type: 'LoadAudio', inputs: { audio: 'song.wav' } } }

describe('awaitRunnerOutputs', () => {
  it('returns each listed node\'s output, sorted by kind, and ignores other runs and other nodes', async () => {
    const w = fakeWindow()
    const done = awaitRunnerOutputs('run1.0', ['v', 'i', 'clip'], { target: w })
    w.post({ event: 'executed', prompt_id: 'other', node_id: 'v', output: { audio: [file('x.mp3')] } })
    w.post({ event: 'executed', prompt_id: 'run1.0', node_id: 'n', output: { images: [file('n.png')] } })
    w.post({ event: 'executed', prompt_id: 'run1.0', node_id: 'v', output: { audio: [file('vocals.mp3')] } })
    w.post({ event: 'executed', prompt_id: 'run1.0', node_id: 'i', output: { audio: [file('inst.mp3')] } })
    w.post({ event: 'executed', prompt_id: 'run1.0', node_id: 'clip', output: { images: [file('auto_subtitle_00001.mp4')], animated: [true] } })
    const out = await done
    expect(Object.keys(out).sort()).toEqual(['clip', 'i', 'v'])
    expect(out.v!.audio).toEqual([file('vocals.mp3')])
    expect(out.i!.audio).toEqual([file('inst.mp3')])
    expect(out.clip!.videos).toEqual([file('auto_subtitle_00001.mp4')])
    expect(out.clip!.images).toEqual([])
    expect(w.size()).toBe(0)
  })

  it('keeps events that arrive before the id is known', async () => {
    const w = fakeWindow()
    let give!: (id: string) => void
    const done = awaitRunnerOutputs(new Promise<string>((r) => { give = r }), ['3'], { target: w })
    w.post({ event: 'executed', prompt_id: 'run1.0', node_id: '3', output: { images: [file('cut.png')] } })
    w.post({ event: 'execution_complete', prompt_id: 'run1.0' })
    give('run1.0')
    await expect(done).resolves.toMatchObject({ 3: { images: [file('cut.png')] } })
    expect(w.size()).toBe(0)
  })

  it('rejects on the run\'s error, in its own words', async () => {
    const w = fakeWindow()
    const done = awaitRunnerOutputs('run1.0', ['3'], { target: w })
    w.post({ event: 'execution_error', prompt_id: 'run1.0', exception_message: 'This song is longer than 10 minutes.' })
    await expect(done).rejects.toThrow('This song is longer than 10 minutes.')
    expect(w.size()).toBe(0)
  })

  it('rejects a run that finished without a listed node\'s output', async () => {
    const w = fakeWindow()
    const done = awaitRunnerOutputs('run1.0', ['v', 'i'], { target: w, words: { empty: 'The song came back empty.' } })
    w.post({ event: 'executed', prompt_id: 'run1.0', node_id: 'v', output: { audio: [file('v.mp3')] } })
    w.post({ event: 'execution_complete', prompt_id: 'run1.0' })
    await expect(done).rejects.toThrow('The song came back empty.')
  })

  it('rejects with AppRunStopped when Stop ended the run', async () => {
    const w = fakeWindow()
    const done = awaitRunnerOutputs('run1.0', ['v'], { target: w })
    w.post({ event: 'execution_complete', prompt_id: 'run1.0', stopped: true, recorded: true })
    await expect(done).rejects.toBeInstanceOf(AppRunStopped)
  })

  it('rejects on the timeout and leaves no listener', async () => {
    vi.useFakeTimers()
    try {
      const w = fakeWindow()
      const done = awaitRunnerOutputs('run1.0', ['v'], { target: w, timeoutMs: 1000, words: { slow: 'Too slow.' } })
      const caught = done.catch(e => e)
      await vi.advanceTimersByTimeAsync(1001)
      expect(await caught).toMatchObject({ message: 'Too slow.' })
      expect(w.size()).toBe(0)
    }
    finally { vi.useRealTimers() }
  })

  it('reads the video keys and a lone picture', () => {
    expect(nodeOutputOf({ gifs: [file('a.mp4')], video: [file('b.webm')] }).videos.map(f => f.filename)).toEqual(['a.mp4', 'b.webm'])
    expect(nodeOutputOf({ images: [file('a.png')], animated: [false] }).images).toEqual([file('a.png')])
    expect(nodeOutputOf(null)).toEqual({ images: [], audio: [], videos: [], ui: {} })
  })
})

type FakeDeps = { [K in keyof AppRunDeps]: Mock<AppRunDeps[K]> }

function fakeDeps(o: Partial<FakeDeps> = {}): FakeDeps {
  return {
    confirm: vi.fn(async () => true),
    postQuote: vi.fn(async (): Promise<AppQuote> => ({ usd: 0.05, credits: 10, upTo: false })),
    start: vi.fn(async () => ({ runId: 'run_1', legId: 'run_1.0', promptIds: ['run_1.0'] })),
    stop: vi.fn(async () => {}),
    ensureEvents: vi.fn(async () => {}),
    ...o,
  }
}

describe('useAppRun', () => {
  it('quotes after a pause, latest wins, and shows the price in the badge\'s format', async () => {
    const deps = fakeDeps({ postQuote: vi.fn(async (b: { takes: ApiPrompt[] }): Promise<AppQuote> => ({ usd: b.takes[0]![1] ? 0.034 : 0.05, credits: 7, upTo: true })) })
    const a = useAppRun({ hosted: false, debounceMs: 5, deps })
    void a.quote({ 9: { class_type: 'X', inputs: {} } })
    await a.quote(PROMPT)
    expect(deps.postQuote).toHaveBeenCalledTimes(1)
    expect(deps.postQuote).toHaveBeenCalledWith({ takes: [PROMPT] }, expect.any(AbortSignal))
    expect(a.price.value).toEqual({ usd: 0.034, credits: 7, upTo: true })
    expect(a.priceText.value).toBe('up to $0.03')
    const h = useAppRun({ hosted: true, debounceMs: 0, deps: fakeDeps() })
    await h.quote(PROMPT)
    expect(h.priceText.value).toBe('10 cr')
  })

  it('a refusal shows its words in place of the price; a decline sets declined', async () => {
    const a = useAppRun({ hosted: true, debounceMs: 0, deps: fakeDeps({ postQuote: vi.fn(async () => ({ refused: 'This song is too long.' })) }) })
    await a.quote(PROMPT)
    expect(a.price.value).toBeNull()
    expect(a.refused.value).toBe('This song is too long.')
    const d = useAppRun({ hosted: true, debounceMs: 0, deps: fakeDeps({ postQuote: vi.fn(async (): Promise<AppQuote> => ({ declined: true })) }) })
    await d.quote(PROMPT)
    expect(d.declined.value).toBe(true)
    expect(d.priceText.value).toBeNull()
    // The runner off (404) is a decline too; a busy or failed route says so plainly.
    const off = useAppRun({ debounceMs: 0, deps: fakeDeps({ postQuote: vi.fn(async () => { throw Object.assign(new Error('Not found'), { statusCode: 404 }) }) }) })
    await off.quote(PROMPT)
    expect(off.declined.value).toBe(true)
    const busy = useAppRun({ debounceMs: 0, deps: fakeDeps({ postQuote: vi.fn(async () => { throw Object.assign(new Error('Too many'), { statusCode: 429 }) }) }) })
    await busy.quote(PROMPT)
    expect(busy.refused.value).toBe(QUOTE_BUSY)
    const broken = useAppRun({ debounceMs: 0, deps: fakeDeps({ postQuote: vi.fn(async () => { throw new Error('500') }) }) })
    await broken.quote(PROMPT)
    expect(broken.refused.value).toBe(QUOTE_FAILED)
  })

  it('runs with no canvas, opens the event stream first, and returns the listed outputs', async () => {
    const w = fakeWindow()
    const deps = fakeDeps()
    const a = useAppRun({ debounceMs: 0, deps })
    const done = a.run(PROMPT, ['v'], { target: w })
    // Posted as soon as the start is sent: before it answers.
    await vi.waitFor(() => expect(deps.start).toHaveBeenCalled())
    w.post({ event: 'executed', prompt_id: 'run_1.0', node_id: 'v', output: { audio: [file('v.mp3')] } })
    const r = await done
    expect(deps.ensureEvents).toHaveBeenCalledBefore(deps.start)
    expect(deps.start).toHaveBeenCalledWith({ takes: [PROMPT], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    expect(r).toEqual({ promptId: 'run_1.0', outputs: { v: { images: [], audio: [file('v.mp3')], videos: [], ui: { audio: [file('v.mp3')] } } } })
    expect(a.running.value).toBe(false)
  })

  it('Stop calls stopRunnerRuns on this run only; the wait ends as stopped', async () => {
    const w = fakeWindow()
    const deps = fakeDeps()
    const a = useAppRun({ debounceMs: 0, deps })
    const done = a.run(PROMPT, ['v'], { target: w }).catch(e => e)
    await vi.waitFor(() => expect(a.runId.value).toBe('run_1'))
    await a.stop()
    expect(deps.stop).toHaveBeenCalledWith(['run_1'])
    w.post({ event: 'execution_complete', prompt_id: 'run_1.0', stopped: true })
    expect(await done).toBeInstanceOf(AppRunStopped)
  })

  it('Stop pressed before the start answered stops the run as soon as its id is known', async () => {
    const w = fakeWindow()
    let answer!: (l: { runId: string, legId: string, promptIds: string[] }) => void
    const deps = fakeDeps({ start: vi.fn(() => new Promise<{ runId: string, legId: string, promptIds: string[] }>(r => { answer = r })) })
    const a = useAppRun({ debounceMs: 0, deps })
    const done = a.run(PROMPT, ['v'], { target: w }).catch(e => e)
    await vi.waitFor(() => expect(deps.start).toHaveBeenCalled())
    await a.stop()
    expect(deps.stop).not.toHaveBeenCalled()
    answer({ runId: 'run_2', legId: 'run_2.0', promptIds: ['run_2.0'] })
    await vi.waitFor(() => expect(deps.stop).toHaveBeenCalledWith(['run_2']))
    w.post({ event: 'execution_complete', prompt_id: 'run_2.0', stopped: true })
    expect(await done).toBeInstanceOf(AppRunStopped)
  })

  it('the cost-confirm gate sees the quoted hold; a "no" starts nothing', async () => {
    const deps = fakeDeps({ confirm: vi.fn(async () => false) })
    const a = useAppRun({ hosted: true, debounceMs: 0, deps })
    await a.quote(PROMPT)
    await expect(a.run(PROMPT, ['v'], { target: fakeWindow() })).rejects.toBeInstanceOf(AppRunCancelled)
    expect(deps.confirm).toHaveBeenCalledWith(expect.objectContaining({ usd: 0.05, hostedCredits: 10, approximate: false }))
    expect(deps.start).not.toHaveBeenCalled()
    expect(deps.ensureEvents).not.toHaveBeenCalled()
    expect(a.running.value).toBe(false)
  })

  it('a runner that says no: declined, AppRunDeclined', async () => {
    const notEligible = Object.assign(new Error('no'), { data: { data: { reason: 'not-eligible' } } })
    const a = useAppRun({ debounceMs: 0, deps: fakeDeps({ start: vi.fn(async () => { throw notEligible }) }) })
    await expect(a.run(PROMPT, ['v'], { target: fakeWindow() })).rejects.toBeInstanceOf(AppRunDeclined)
    expect(a.declined.value).toBe(true)
  })

  it('a start refusal rejects in its own words', async () => {
    const a = useAppRun({ debounceMs: 0, deps: fakeDeps({ start: vi.fn(async () => { throw new Error('Not enough credits') }) }) })
    await expect(a.run(PROMPT, ['v'], { target: fakeWindow() })).rejects.toThrow('Not enough credits')
    expect(a.declined.value).toBe(false)
  })

  it('the price text: free shows nothing; under a cent; credits never re-marked up', () => {
    expect(appPriceText({ usd: 0, credits: 0, upTo: false }, false)).toBeNull()
    expect(appPriceText({ usd: 0.0008, credits: 1, upTo: false }, false)).toBe('<$0.01')
    expect(appPriceText({ usd: 0.0008, credits: 1, upTo: true }, true)).toBe('up to 1 cr')
  })
})

describe('useAppRun, fix round 1', () => {
  const OTHER: ApiPrompt = { 1: { class_type: 'LoadAudio', inputs: { audio: 'long_song.wav' } } }

  it('I1: Run prices exactly the prompt it runs: a stale quote for another prompt is never confirmed on', async () => {
    const postQuote = vi.fn(async (b: { takes: ApiPrompt[] }): Promise<AppQuote> =>
      (b.takes[0]![1]!.inputs!.audio === 'long_song.wav' ? { usd: 2.4, credits: 360, upTo: false } : { usd: 0.03, credits: 6, upTo: false }))
    const deps = fakeDeps({ postQuote })
    const a = useAppRun({ hosted: true, debounceMs: 0, deps })
    await a.quote(PROMPT)
    expect(a.priceText.value).toBe('6 cr')
    // Run pressed with another prompt before its own quote landed.
    const w = fakeWindow()
    const done = a.run(OTHER, ['v'], { target: w })
    await vi.waitFor(() => expect(deps.start).toHaveBeenCalled())
    expect(postQuote).toHaveBeenLastCalledWith({ takes: [OTHER] }, undefined)
    expect(deps.confirm).toHaveBeenCalledWith(expect.objectContaining({ usd: 2.4, hostedCredits: 360 }))
    w.post({ event: 'executed', prompt_id: 'run_1.0', node_id: 'v', output: { audio: [file('v.mp3')] } })
    await done
  })

  it('I1: a fresh quote for the same prompt (keys in any order) is used; an old one is asked again', async () => {
    let t = 0
    const deps = fakeDeps()
    const a = useAppRun({ debounceMs: 0, deps, now: () => t })
    await a.quote({ 1: { inputs: { audio: 'song.wav' }, class_type: 'LoadAudio' } })
    const w = fakeWindow()
    const one = a.run(PROMPT, ['v'], { target: w })
    await vi.waitFor(() => expect(deps.start).toHaveBeenCalledTimes(1))
    expect(deps.postQuote).toHaveBeenCalledTimes(1)
    w.post({ event: 'executed', prompt_id: 'run_1.0', node_id: 'v', output: {} })
    await one
    t += QUOTE_FRESH_MS + 1
    const two = a.run(PROMPT, ['v'], { target: w })
    await vi.waitFor(() => expect(deps.start).toHaveBeenCalledTimes(2))
    expect(deps.postQuote).toHaveBeenCalledTimes(2)
    w.post({ event: 'executed', prompt_id: 'run_1.0', node_id: 'v', output: {} })
    await two
  })

  it('I1: a quote that fails or refuses starts nothing, in its words; a free run still asks the gate', async () => {
    const failing = fakeDeps({ postQuote: vi.fn(async () => { throw Object.assign(new Error('500'), { statusCode: 500 }) }) })
    const a = useAppRun({ debounceMs: 0, deps: failing })
    await expect(a.run(PROMPT, ['v'], { target: fakeWindow() })).rejects.toEqual(new AppRunRefused(QUOTE_FAILED))
    expect(failing.confirm).not.toHaveBeenCalled()
    expect(failing.start).not.toHaveBeenCalled()
    expect(a.refused.value).toBe(QUOTE_FAILED)
    expect(a.running.value).toBe(false)
    const refusing = fakeDeps({ postQuote: vi.fn(async (): Promise<AppQuote> => ({ refused: 'This song is longer than 10 minutes.' })) })
    const r = useAppRun({ debounceMs: 0, deps: refusing })
    await expect(r.run(PROMPT, ['v'], { target: fakeWindow() })).rejects.toThrow('This song is longer than 10 minutes.')
    expect(refusing.start).not.toHaveBeenCalled()
    const free = fakeDeps({ postQuote: vi.fn(async (): Promise<AppQuote> => ({ usd: 0, credits: 0, upTo: false })), confirm: vi.fn(async () => false) })
    const f = useAppRun({ debounceMs: 0, deps: free })
    await expect(f.run(PROMPT, ['v'], { target: fakeWindow() })).rejects.toBeInstanceOf(AppRunCancelled)
    expect(free.confirm).toHaveBeenCalled()
  })

  it('I2: a wait that gives up stops the run, as Stop does, and says so', async () => {
    const deps = fakeDeps()
    const a = useAppRun({ debounceMs: 0, deps })
    const err = await a.run(PROMPT, ['v'], { target: fakeWindow(), timeoutMs: 20 }).catch(e => e)
    expect(err).toBeInstanceOf(AppRunTimedOut)
    expect(err.message).toBe('This took too long, so it was stopped.')
    expect(deps.stop).toHaveBeenCalledWith(['run_1'])
    expect(a.running.value).toBe(false)
  })

  it('I2: if that Stop fails, no second run starts until a Stop goes through', async () => {
    const deps = fakeDeps({ stop: vi.fn(async () => { throw new Error('offline') }) })
    const a = useAppRun({ debounceMs: 0, deps })
    const err = await a.run(PROMPT, ['v'], { target: fakeWindow(), timeoutMs: 20 }).catch(e => e)
    expect(err).toEqual(new AppRunTimedOut(TIMED_OUT_STOP_FAILED))
    expect(a.running.value).toBe(true)
    expect(a.stopError.value).toBe(STOP_FAILED)
    await expect(a.run(PROMPT, ['v'], { target: fakeWindow() })).rejects.toThrow(STILL_GOING)
    expect(deps.start).toHaveBeenCalledTimes(1)
    deps.stop.mockImplementation(async () => {})
    await a.stop()
    expect(a.stopError.value).toBeNull()
    expect(a.running.value).toBe(false)
  })

  it('M1: closing the app mid-run stops the run and drops the listener', async () => {
    const w = fakeWindow()
    const deps = fakeDeps()
    const scope = effectScope()
    const a = scope.run(() => useAppRun({ debounceMs: 0, deps }))!
    const done = a.run(PROMPT, ['v'], { target: w }).catch(e => e)
    await vi.waitFor(() => expect(a.runId.value).toBe('run_1'))
    expect(w.size()).toBe(1)
    scope.stop()
    expect(await done).toBeInstanceOf(AppRunStopped)
    expect(w.size()).toBe(0)
    expect(deps.stop).toHaveBeenCalledWith(['run_1'])
  })

  it('M1: closed before the start answered: stopped once its id is known', async () => {
    let answer!: (l: { runId: string, legId: string, promptIds: string[] }) => void
    const deps = fakeDeps({ start: vi.fn(() => new Promise<{ runId: string, legId: string, promptIds: string[] }>(r => { answer = r })) })
    const scope = effectScope()
    const a = scope.run(() => useAppRun({ debounceMs: 0, deps }))!
    const done = a.run(PROMPT, ['v'], { target: fakeWindow() }).catch(e => e)
    await vi.waitFor(() => expect(deps.start).toHaveBeenCalled())
    scope.stop()
    answer({ runId: 'run_3', legId: 'run_3.0', promptIds: ['run_3.0'] })
    await vi.waitFor(() => expect(deps.stop).toHaveBeenCalledWith(['run_3']))
    expect(await done).toBeInstanceOf(AppRunStopped)
  })

  it('M2: a Stop that fails says so, and nothing is left unhandled', async () => {
    const deps = fakeDeps({ stop: vi.fn(async () => { throw new Error('offline') }) })
    const a = useAppRun({ debounceMs: 0, deps })
    const done = a.run(PROMPT, ['v'], { target: fakeWindow() }).catch(e => e)
    await vi.waitFor(() => expect(a.runId.value).toBe('run_1'))
    await a.stop()
    expect(a.stopError.value).toBe(STOP_FAILED)
    expect(a.running.value).toBe(true)
    // The early-Stop path, too.
    let answer!: (l: { runId: string, legId: string, promptIds: string[] }) => void
    const early = fakeDeps({ stop: vi.fn(async () => { throw new Error('offline') }), start: vi.fn(() => new Promise<{ runId: string, legId: string, promptIds: string[] }>(r => { answer = r })) })
    const b = useAppRun({ debounceMs: 0, deps: early })
    void b.run(PROMPT, ['v'], { target: fakeWindow() }).catch(() => {})
    await vi.waitFor(() => expect(early.start).toHaveBeenCalled())
    await b.stop()
    answer({ runId: 'run_4', legId: 'run_4.0', promptIds: ['run_4.0'] })
    await vi.waitFor(() => expect(b.stopError.value).toBe(STOP_FAILED))
    void done
  })

  it('M3: a quote a newer one replaces is aborted', async () => {
    const signals: (AbortSignal | undefined)[] = []
    const postQuote = vi.fn((_b: { takes: ApiPrompt[] }, signal?: AbortSignal) => {
      signals.push(signal)
      return new Promise<AppQuote>((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')))
        setTimeout(() => resolve({ usd: 0.05, credits: 10, upTo: false }), signals.length === 1 ? 5_000 : 10)
      })
    })
    const a = useAppRun({ debounceMs: 0, deps: fakeDeps({ postQuote }) })
    const first = a.quote(PROMPT)
    await vi.waitFor(() => expect(postQuote).toHaveBeenCalledTimes(1))
    const second = a.quote(OTHER)
    await Promise.all([first, second])
    expect(signals[0]!.aborted).toBe(true)
    expect(signals[1]!.aborted).toBe(false)
    expect(a.price.value).toEqual({ usd: 0.05, credits: 10, upTo: false })
    expect(a.refused.value).toBeNull()
  })

  it('M5: the start\'s refusal shows its own words, from the route\'s body', async () => {
    const fetchError = Object.assign(new Error('[POST] "/api/runs": 400 Bad Request'), { statusCode: 400, data: { message: 'This song is longer than 10 minutes.' } })
    const a = useAppRun({ debounceMs: 0, deps: fakeDeps({ start: vi.fn(async () => { throw fetchError }) }) })
    await expect(a.run(PROMPT, ['v'], { target: fakeWindow() })).rejects.toThrow('This song is longer than 10 minutes.')
    const q = useAppRun({ debounceMs: 0, deps: fakeDeps({ postQuote: vi.fn(async () => { throw Object.assign(new Error('[POST] "/api/runs/quote": 413'), { statusCode: 413, data: { message: 'This request is too large' } }) }) }) })
    await q.quote(PROMPT)
    expect(q.refused.value).toBe('This request is too large')
  })
})
