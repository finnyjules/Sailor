/**
 * Step 3, R8.2: Karaoke on the runner (lib/runner/karaokeApp.ts, used by
 * components/apps/KaraokeMakerApp.vue).
 *
 * - Fake runner events: both stems land in one take, by node id; the price
 *   shows before the run; Stop; a refusal; a decline (hosted: switched off;
 *   this computer: the engine as before, ruling (d)); a song over the
 *   runner's longest here goes to the engine (ruling (i)).
 * - Through the kit (fake Replicate answering two WAVs, ComfyUI off): the
 *   app's exact prompt makes two MP3 files, the quote equals the hold, and
 *   Stop mid-call releases the hold.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { isRunnerEligible } from '#shared/runner/eligibility'
import { VOCALS_RATE, VOCALS_WORDS } from '#shared/runner/localModels'
import { RUNNER_NOT_ELIGIBLE, RUNNER_SOUND_TOO_LONG } from '#shared/runner/messages'
import { MeterRefusalError } from '~~/server/utils/requestMeter'
import { quoteAnswerOf } from '~~/server/api/runs/quote.post'
import { floatWav } from '~~/server/media/encode'
import { QUOTE_FAILED, useAppRun, type AppQuote, type AppRunDeps } from '~/composables/useAppRun'
import { KARAOKE_STEMS, KARAOKE_WORDS, buildKaraokePrompt, runOnEngine, useKaraokeRun, type KaraokeStems } from '~/lib/runner/karaokeApp'
import type { AppTakeInput } from '~/composables/useAppTakes'
import { mapWsEvent } from '~/lib/graph/wsEventMap'
import { createFakeReplicate, makeKit } from './__runner__/kit'
import { requireMediaTools } from './__runner__/mediaParity'

const ON: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'media-sound', 'vocal-split'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }

function fakeWindow() {
  const handlers = new Set<(e: MessageEvent) => void>()
  return {
    addEventListener: (_: string, h: any) => handlers.add(h),
    removeEventListener: (_: string, h: any) => handlers.delete(h),
    post: (data: Record<string, unknown>) => handlers.forEach(h => h({ data: { type: 'sailor-bridge', ...data } } as MessageEvent)),
    size: () => handlers.size,
  }
}

const file = (filename: string) => ({ filename, subfolder: 'user_1', type: 'output' })

function fakeDeps(o: Partial<AppRunDeps> = {}) {
  return {
    confirm: vi.fn(async () => true),
    postQuote: vi.fn(async (): Promise<AppQuote> => ({ usd: 0.034, credits: 7, upTo: true })),
    start: vi.fn(async () => ({ runId: 'run_1', legId: 'run_1.0', promptIds: ['run_1.0'] })),
    stop: vi.fn(async () => {}),
    ensureEvents: vi.fn(async () => {}),
    ...o,
  }
}

function setup(o: { hosted?: boolean, deps?: Partial<AppRunDeps>, engine?: (p: ApiPrompt) => Promise<KaraokeStems> } = {}) {
  const deps = fakeDeps(o.deps)
  const hosted = o.hosted ?? false
  const w = fakeWindow()
  const song = ref<{ filename: string } | null>(null)
  const takes: AppTakeInput[] = []
  const engine = vi.fn(o.engine ?? (async (): Promise<KaraokeStems> => ({ promptId: 'p1', vocals: file('ev.mp3'), instrumental: file('ei.mp3') })))
  const app = useAppRun({ hosted, debounceMs: 0, deps })
  const k = useKaraokeRun({ song, addTake: t => takes.push(t), hosted, app, engine, wait: { target: w } })
  return { deps, w, song, takes, engine, k }
}

describe('the prompt', () => {
  it('is the app\'s workflow, runner-eligible with its families on in both places, left as before with them off', () => {
    const p = buildKaraokePrompt('song.wav')
    expect(p).toEqual({
      1: { class_type: 'LoadAudio', inputs: { audio: 'song.wav' } },
      2: { class_type: 'VocalSeparator', inputs: { audio: ['1', 0], model: 'htdemucs', shifts: 1 } },
      3: { class_type: 'SaveAudioMP3', inputs: { audio: ['2', 0], filename_prefix: 'karaoke_vocals', quality: 'V0' } },
      4: { class_type: 'SaveAudioMP3', inputs: { audio: ['2', 1], filename_prefix: 'karaoke_instrumental', quality: 'V0' } },
    })
    for (const hosted of [true, false]) {
      expect(isRunnerEligible(p, ON, { hosted })).toBe(true)
      expect(isRunnerEligible(p, new Set<RunnerFamily>(['cards', 'media-sound']), { hosted })).toBe(false)
      expect(isRunnerEligible(p, new Set<RunnerFamily>(), { hosted })).toBe(false)
    }
  })
})

describe('the app, fed fake runner events', () => {
  it('the price shows once the song is uploaded, before the run; both stems land in one take, by node id', async () => {
    const { deps, w, song, takes, k } = setup()
    expect(k.canRun.value).toBe(false)
    song.value = { filename: 'song.wav' }
    await k.quote()
    expect(deps.postQuote).toHaveBeenCalledWith({ takes: [buildKaraokePrompt('song.wav')] }, expect.any(AbortSignal))
    expect(k.priceText.value).toBe('up to $0.03')
    expect(k.canRun.value).toBe(true)

    const done = k.run()
    await vi.waitFor(() => expect(deps.start).toHaveBeenCalled())
    expect(deps.confirm).toHaveBeenCalledWith(expect.objectContaining({ usd: 0.034, approximate: true }))
    expect(k.canStop.value).toBe(true)
    // Names that would fool a file-name match: the stems come by node id.
    w.post({ event: 'executed', prompt_id: 'run_1.0', node_id: KARAOKE_STEMS.instrumental, output: { audio: [file('karaoke_vocals_x.mp3')] } })
    w.post({ event: 'executed', prompt_id: 'run_1.0', node_id: KARAOKE_STEMS.vocals, output: { audio: [file('karaoke_instrumental_x.mp3')] } })
    await done
    expect(k.status.value).toBe('done')
    expect(takes).toHaveLength(1)
    expect(takes[0]!.promptId).toBe('run_1.0')
    expect(takes[0]!.audios![0]).toContain('filename=karaoke_instrumental_x.mp3')
    expect(takes[0]!.audios![1]).toContain('filename=karaoke_vocals_x.mp3')
    expect(takes[0]!.audios![0]).toContain('subfolder=user_1')
    expect(w.size()).toBe(0)
  })

  it('in hosted the price is in credits', async () => {
    const { song, k } = setup({ hosted: true })
    song.value = { filename: 'song.wav' }
    await k.quote()
    expect(k.priceText.value).toBe('up to 7 cr')
  })

  it('Stop ends this run: no take, back to idle, nothing left listening', async () => {
    const { deps, w, song, takes, k } = setup()
    song.value = { filename: 'song.wav' }
    await k.quote()
    const done = k.run()
    await vi.waitFor(() => expect(deps.start).toHaveBeenCalled())
    await vi.waitFor(() => expect(k.canStop.value).toBe(true))
    await new Promise(r => setTimeout(r, 0))
    await k.stop()
    expect(deps.stop).toHaveBeenCalledWith(['run_1'])
    w.post({ event: 'execution_complete', prompt_id: 'run_1.0', stopped: true })
    await done
    expect(k.status.value).toBe('idle')
    expect(k.errorMessage.value).toBeNull()
    expect(takes).toEqual([])
    expect(w.size()).toBe(0)
  })

  it('a refusal shows its words in place of the price, and the button stays off', async () => {
    const { song, k, deps } = setup({ hosted: true, deps: { postQuote: vi.fn(async (): Promise<AppQuote> => ({ refused: VOCALS_WORDS.tooLong })) } })
    song.value = { filename: 'long.wav' }
    await k.quote()
    expect(k.priceText.value).toBeNull()
    expect(k.blocked.value).toBe(VOCALS_WORDS.tooLong)
    expect(k.canRun.value).toBe(false)
    await k.run()
    expect(deps.start).not.toHaveBeenCalled()
  })

  it('a run\'s error shows its own words, never the engine\'s', async () => {
    const { deps, w, song, takes, k } = setup()
    song.value = { filename: 'song.wav' }
    await k.quote()
    const done = k.run()
    await vi.waitFor(() => expect(deps.start).toHaveBeenCalled())
    w.post({ event: 'execution_error', prompt_id: 'run_1.0' })
    await done
    expect(k.status.value).toBe('error')
    expect(k.errorMessage.value).toBe(KARAOKE_WORDS.failed)
    expect(takes).toEqual([])
  })

  it('"no" at the cost gate starts nothing', async () => {
    const { deps, song, k, takes } = setup({ deps: { confirm: vi.fn(async () => false) } })
    song.value = { filename: 'song.wav' }
    await k.quote()
    await k.run()
    expect(deps.start).not.toHaveBeenCalled()
    expect(k.status.value).toBe('idle')
    expect(takes).toEqual([])
  })

  it('a decline in hosted: "switched off", the button off, nothing sent anywhere', async () => {
    const { song, k, deps, engine } = setup({ hosted: true, deps: { postQuote: vi.fn(async (): Promise<AppQuote> => ({ declined: true })) } })
    song.value = { filename: 'song.wav' }
    await k.quote()
    expect(k.blocked.value).toBe('This app is switched off right now.')
    expect(k.canRun.value).toBe(false)
    await k.run()
    expect(deps.start).not.toHaveBeenCalled()
    expect(engine).not.toHaveBeenCalled()
  })

  it('a decline on this computer: the engine as before (ruling (d)), no price, no Stop', async () => {
    let finish!: () => void
    const { song, k, deps, engine, takes } = setup({
      deps: { postQuote: vi.fn(async (): Promise<AppQuote> => ({ declined: true })) },
      engine: () => new Promise((r) => { finish = () => r({ promptId: 'p1', vocals: file('ev.mp3'), instrumental: file('ei.mp3') }) }),
    })
    song.value = { filename: 'song.wav' }
    await k.quote()
    expect(k.blocked.value).toBeNull()
    expect(k.priceText.value).toBeNull()
    expect(k.canRun.value).toBe(true)
    const done = k.run()
    await vi.waitFor(() => expect(engine).toHaveBeenCalledWith(buildKaraokePrompt('song.wav')))
    expect(k.canStop.value).toBe(false)
    finish()
    await done
    expect(deps.start).not.toHaveBeenCalled()
    expect(takes).toHaveLength(1)
    expect(k.status.value).toBe('done')
  })

  it('a decline at the start on this computer goes to the engine too', async () => {
    const declined = Object.assign(new Error('x'), { data: { data: { reason: RUNNER_NOT_ELIGIBLE } } })
    const { song, k, engine, takes } = setup({ deps: { start: vi.fn(async () => { throw declined }) } })
    song.value = { filename: 'song.wav' }
    await k.quote()
    await k.run()
    expect(engine).toHaveBeenCalledTimes(1)
    expect(takes).toHaveLength(1)
  })

  it('a song over the runner\'s longest on this computer goes to the engine (ruling (i)); in hosted it is refused', async () => {
    const refuse = { postQuote: vi.fn(async (): Promise<AppQuote> => ({ refused: VOCALS_WORDS.tooLong, reason: RUNNER_SOUND_TOO_LONG })) }
    const local = setup({ deps: refuse })
    local.song.value = { filename: 'long.wav' }
    await local.k.quote()
    expect(local.k.canRun.value).toBe(true)
    await local.k.run()
    expect(local.engine).toHaveBeenCalledTimes(1)
    expect(local.deps.start).not.toHaveBeenCalled()
    // Any other refusal stays a refusal here.
    const other = setup({ deps: { postQuote: vi.fn(async (): Promise<AppQuote> => ({ refused: 'Sign in to run workflows.' })) } })
    other.song.value = { filename: 'song.wav' }
    await other.k.quote()
    expect(other.k.canRun.value).toBe(false)
  })
})

describe('fix round 1', () => {
  it('the local fallback keys on the reason code, never the words: the same words without the code stay a refusal', async () => {
    const words = setup({ deps: { postQuote: vi.fn(async (): Promise<AppQuote> => ({ refused: VOCALS_WORDS.tooLong })) } })
    words.song.value = { filename: 'long.wav' }
    await words.k.quote()
    expect(words.k.blocked.value).toBe(VOCALS_WORDS.tooLong)
    expect(words.k.canRun.value).toBe(false)
    // Other words, the code: the engine.
    const code = setup({ deps: { postQuote: vi.fn(async (): Promise<AppQuote> => ({ refused: 'Too long.', reason: RUNNER_SOUND_TOO_LONG })) } })
    code.song.value = { filename: 'long.wav' }
    await code.k.quote()
    expect(code.k.canRun.value).toBe(true)
    await code.k.run()
    expect(code.engine).toHaveBeenCalledTimes(1)
    // In hosted the code is a plain refusal.
    const hosted = setup({ hosted: true, deps: { postQuote: vi.fn(async (): Promise<AppQuote> => ({ refused: 'Too long.', reason: RUNNER_SOUND_TOO_LONG })) } })
    hosted.song.value = { filename: 'long.wav' }
    await hosted.k.quote()
    expect(hosted.k.blocked.value).toBe('Too long.')
    expect(hosted.k.canRun.value).toBe(false)
  })

  it('the run\'s own refusal carrying the code, on this computer, goes to the engine too', async () => {
    const tooLong = Object.assign(new Error('x'), { statusCode: 400, data: { message: 'Too long.', data: { reason: RUNNER_SOUND_TOO_LONG } } })
    const { song, k, engine, takes } = setup({ deps: { start: vi.fn(async () => { throw tooLong }) } })
    song.value = { filename: 'song.wav' }
    await k.quote()
    await k.run()
    expect(engine).toHaveBeenCalledTimes(1)
    expect(takes).toHaveLength(1)
  })

  it('the start\'s refusal carries the code next to its words, and the quote route passes it on', async () => {
    await requireMediaTools()
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    // 10 minutes and 2 s of 8 kHz mono: past hosted's longest.
    const n = 8000 * (10 * 60 + 2)
    const data = Buffer.alloc(n * 2)
    const h = Buffer.alloc(44)
    h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12)
    h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24)
    h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40)
    mkdirSync(join(k.root, 'input', 'user_1'), { recursive: true })
    writeFileSync(join(k.root, 'input', 'user_1', 'long.wav'), Buffer.concat([h, data]))
    writeFileSync(join(k.root, 'input', 'long.wav'), Buffer.concat([h, data]))
    const err = await k.engine.quoteRun({ userId: k.userId, takes: [buildKaraokePrompt('long.wav')], ...START }).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(MeterRefusalError)
    expect((err as MeterRefusalError).data).toMatchObject({ reason: RUNNER_SOUND_TOO_LONG })
    expect(quoteAnswerOf(err)).toEqual({ refused: VOCALS_WORDS.tooLong, reason: RUNNER_SOUND_TOO_LONG })
    // The run's start refuses the same way, before any hold.
    const err2 = await k.engine.startRun({ userId: k.userId, takes: [buildKaraokePrompt('long.wav')], ...START }).then(() => null, (e: unknown) => e)
    expect((err2 as MeterRefusalError).data).toMatchObject({ reason: RUNNER_SOUND_TOO_LONG })
    expect(k.ledger.hold).not.toHaveBeenCalled()
    // A refusal with no code answers as before.
    expect(quoteAnswerOf(new MeterRefusalError('Sign in to run workflows.', 401))).toEqual({ refused: 'Sign in to run workflows.' })
  }, 120_000)

  it('a failed price check shows its words and leaves Separate on; pressing it prices again, then runs', async () => {
    let calls = 0
    const postQuote = vi.fn(async (): Promise<AppQuote> => {
      if (calls++ === 0) throw Object.assign(new Error('fetch failed'), { statusCode: 500 })
      return { usd: 0.034, credits: 7, upTo: true }
    })
    const { song, k, deps, w, takes } = setup({ deps: { postQuote } })
    song.value = { filename: 'song.wav' }
    await k.quote()
    expect(k.blocked.value).toBe(QUOTE_FAILED)
    expect(k.priceText.value).toBeNull()
    expect(k.canRun.value).toBe(true)
    const done = k.run()
    await vi.waitFor(() => expect(deps.start).toHaveBeenCalled())
    expect(postQuote).toHaveBeenCalledTimes(2)
    expect(deps.confirm).toHaveBeenCalledWith(expect.objectContaining({ usd: 0.034 }))
    w.post({ event: 'executed', prompt_id: 'run_1.0', node_id: KARAOKE_STEMS.vocals, output: { audio: [file('v.mp3')] } })
    w.post({ event: 'executed', prompt_id: 'run_1.0', node_id: KARAOKE_STEMS.instrumental, output: { audio: [file('i.mp3')] } })
    await done
    expect(takes).toHaveLength(1)
    expect(k.blocked.value).toBeNull()
  })

  it('a price check that fails again at Run starts nothing, says so, and leaves Separate on', async () => {
    const postQuote = vi.fn(async (): Promise<AppQuote> => { throw Object.assign(new Error('fetch failed'), { statusCode: 500 }) })
    const { song, k, deps } = setup({ deps: { postQuote } })
    song.value = { filename: 'song.wav' }
    await k.quote()
    await k.run()
    expect(deps.start).not.toHaveBeenCalled()
    expect(k.errorMessage.value).toBe(QUOTE_FAILED)
    expect(k.canRun.value).toBe(true)
  })
})

describe('the engine stop-gap (this computer only)', () => {
  it('takes the stems by node id; its errors never name the engine', async () => {
    const history = { p1: { status: { status_str: 'success', completed: true }, outputs: { 3: { audio: [file('a.mp3')] }, 4: { audio: [file('b.mp3')] } } } }
    const f = vi.fn(async (url: string) => ({ ok: true, json: async () => (url === '/prompt' ? { prompt_id: 'p1' } : history) })) as unknown as typeof fetch
    const r = await runOnEngine(buildKaraokePrompt('s.wav'), { fetch: f, sleep: async () => {} })
    expect(r).toEqual({ promptId: 'p1', vocals: file('a.mp3'), instrumental: file('b.mp3') })
    const down = vi.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    await expect(runOnEngine(buildKaraokePrompt('s.wav'), { fetch: down })).rejects.toThrow(KARAOKE_WORDS.noStart)
    const bad = vi.fn(async (url: string) => ({ ok: true, json: async () => (url === '/prompt' ? { prompt_id: 'p1' } : { p1: { status: { status_str: 'error' } } }) })) as unknown as typeof fetch
    await expect(runOnEngine(buildKaraokePrompt('s.wav'), { fetch: bad, sleep: async () => {} })).rejects.toThrow(KARAOKE_WORDS.failed)
    for (const words of Object.values(KARAOKE_WORDS)) expect(words).not.toMatch(/comfy|8188|demucs|model/i)
  })
})

// ── Through the kit: ComfyUI off ─────────────────────────────────────────────

const STEM_URLS = { vocals: 'https://replicate.delivery/vocals.wav', no_vocals: 'https://replicate.delivery/no_vocals.wav' }
function stemWav(seconds: number, level: number): Uint8Array {
  const n = Math.round(seconds * VOCALS_RATE)
  const ch = () => Float32Array.from({ length: n }, (_, i) => level * Math.sin(i / 7))
  return floatWav({ rate: VOCALS_RATE, channels: [ch(), ch()] })
}
const stemDownload = (seconds: number) => async (url: string) => {
  if (url === STEM_URLS.vocals) return { bytes: stemWav(seconds, 0.5), contentType: 'audio/wav' }
  if (url === STEM_URLS.no_vocals) return { bytes: stemWav(seconds, 0.25), contentType: 'audio/wav' }
  return { bytes: new TextEncoder().encode(url), contentType: 'image/png' }
}
/** A 16-bit stereo PCM WAV of a quiet tone. */
function songWav(seconds: number, rate = 44100): Uint8Array {
  const n = Math.round(seconds * rate) * 2
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(3000 * Math.sin(i / 9)), i * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(data.length, 40)
  return new Uint8Array(Buffer.concat([h, data]))
}

function kitApp(o: { hold?: boolean } = {}) {
  const replicate = createFakeReplicate({ answer: () => STEM_URLS })
  if (o.hold) replicate.holdNext(1)
  const k = makeKit({ hosted: true, replicate, deps: { families: () => ON, download: stemDownload(2) } })
  const bytes = songWav(2)
  mkdirSync(join(k.root, 'input', 'user_1'), { recursive: true })
  writeFileSync(join(k.root, 'input', 'user_1', 'song.wav'), bytes)
  writeFileSync(join(k.root, 'input', 'song.wav'), bytes)
  const w = fakeWindow()
  const started: string[] = []
  // The runner's events, as the browser's event stream hands them to the app.
  k.deps.events.subscribe(k.userId!, (m) => {
    const e = mapWsEvent(m as { type: string, data: any }, 'browser')
    if (e) w.post(e as unknown as Record<string, unknown>)
  })
  const deps: Partial<AppRunDeps> = {
    confirm: vi.fn(async () => true),
    postQuote: async body => k.engine.quoteRun({ userId: k.userId, takes: body.takes, ...START }),
    start: async (body) => {
      const leg = await k.engine.startRun({ userId: k.userId, ...body })
      started.push(leg.runId)
      return leg
    },
    stop: async ids => { await k.engine.stop(k.userId, ids) },
    ensureEvents: async () => {},
  }
  const song = ref<{ filename: string } | null>({ filename: 'song.wav' })
  const takes: AppTakeInput[] = []
  const app = useAppRun({ hosted: true, debounceMs: 0, deps })
  const ka = useKaraokeRun({ song, addTake: t => takes.push(t), hosted: true, app, engine: async () => { throw new Error('the engine must not be used') }, wait: { target: w } })
  return { k, replicate, ka, takes, w, started }
}

describe('through the kit (ComfyUI off): the app\'s exact prompt', () => {
  it('quoted, then run: the quote equals the hold; two MP3 files land in one take; charged no more than held', async () => {
    await requireMediaTools()
    const { k, replicate, ka, takes, started } = kitApp()
    await ka.quote()
    expect(ka.priceText.value).toMatch(/^up to \d+ cr$/)
    const quoted = Number(/(\d+) cr/.exec(ka.priceText.value!)![1])
    await ka.run()
    expect(ka.errorMessage.value).toBeNull()
    expect(ka.status.value).toBe('done')
    expect(replicate.submitted().length).toBe(1)
    expect(takes).toHaveLength(1)
    const [v, i] = takes[0]!.audios!
    expect(decodeURIComponent(v!)).toMatch(/filename=karaoke_vocals.*\.mp3/)
    expect(decodeURIComponent(i!)).toMatch(/filename=karaoke_instrumental.*\.mp3/)
    expect(started).toHaveLength(1)
    const runId = started[0]!
    await k.engine.settled(runId)
    const take = (await k.store.get(runId))!.takes[0]!
    for (const id of ['1', '2', '3', '4']) expect(take.nodes[id]!.status, `${id}: ${take.nodes[id]!.error ?? ''}`).toBe('done')
    const holds = [...k.ledger.holds.values()]
    expect(holds.reduce((n, h) => n + h.credits, 0)).toBe(quoted)
    expect(holds.every(h => h.actual !== null && h.actual <= h.credits)).toBe(true)
  }, 120_000)

  it('Stop mid-call: the call cancelled, the hold released, no take', async () => {
    await requireMediaTools()
    const { k, replicate, ka, takes } = kitApp({ hold: true })
    await ka.quote()
    const done = ka.run()
    for (let n = 0; n < 4000 && replicate.submitted().length < 1; n++) await new Promise(r => setTimeout(r, 5))
    expect(replicate.submitted().length).toBe(1)
    await ka.stop()
    await done
    expect(ka.status.value).toBe('idle')
    expect(takes).toEqual([])
    expect(replicate.submitted()[0]!.cancelled).toBe(true)
    expect([...k.ledger.holds.values()].map(h => (h.state === 'released' ? 0 : h.actual))).toEqual([0])
  }, 60_000)
})
