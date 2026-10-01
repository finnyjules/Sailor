/**
 * Step 3, R8.3: Auto subtitle on the runner (lib/runner/autoSubtitleApp.ts,
 * used by components/apps/AutoSubtitleApp.vue).
 *
 * - The prompt: runner-eligible with its families on, in both places; left
 *   as before with any of them off.
 * - Fake runner events: the captioned video lands in a take, by node id; the
 *   price shows before the run; Stop; a refusal; a decline (hosted: switched
 *   off; this computer: the engine as before, ruling (d)); a sound longer
 *   than Whisper takes here goes to the engine locally.
 * - Through the kit (fake fal answering Whisper's captions, ComfyUI off):
 *   the app's exact prompt makes the captioned video with its sound, the
 *   quote equals the hold, and Stop mid-call releases the hold.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { isRunnerEligible } from '#shared/runner/eligibility'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { RUNNER_SOUND_TOO_LONG } from '#shared/runner/messages'
import { probeMedia } from '~~/server/media/probe'
import { useAppRun, type AppQuote, type AppRunDeps } from '~/composables/useAppRun'
import {
  AUTO_SUBTITLE_OUT, AUTO_SUBTITLE_WORDS, buildAutoSubtitlePrompt, runOnEngine, useAutoSubtitleRun, type AutoSubtitleResult, type AutoSubtitleSettings,
} from '~/lib/runner/autoSubtitleApp'
import type { AppTakeInput } from '~/composables/useAppTakes'
import { mapWsEvent } from '~/lib/graph/wsEventMap'
import { createFakeFal, makeKit } from './__runner__/kit'
import { clipPath, requireMediaTools } from './__runner__/mediaParity'

const ON: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'media-sound', 'media-video', 'whisper-captions', 'video-text'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const SETTINGS: AutoSubtitleSettings = { language: 'auto', position: 'bottom', fontSize: 44 }

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
    postQuote: vi.fn(async (): Promise<AppQuote> => ({ usd: 0.004, credits: 2, upTo: true })),
    start: vi.fn(async () => ({ runId: 'run_1', legId: 'run_1.0', promptIds: ['run_1.0'] })),
    stop: vi.fn(async () => {}),
    ensureEvents: vi.fn(async () => {}),
    ...o,
  }
}

function setup(o: { hosted?: boolean, deps?: Partial<AppRunDeps>, engine?: (p: ApiPrompt) => Promise<AutoSubtitleResult> } = {}) {
  const deps = fakeDeps(o.deps)
  const hosted = o.hosted ?? false
  const w = fakeWindow()
  const video = ref<{ filename: string } | null>(null)
  const settings = ref<AutoSubtitleSettings>({ ...SETTINGS })
  const takes: AppTakeInput[] = []
  const engine = vi.fn(o.engine ?? (async (): Promise<AutoSubtitleResult> => ({ promptId: 'p1', video: file('engine.mp4') })))
  const app = useAppRun({ hosted, debounceMs: 0, deps })
  const a = useAutoSubtitleRun({ video, settings: () => settings.value, addTake: t => takes.push(t), hosted, app, engine, wait: { target: w } })
  return { deps, w, video, settings, takes, engine, a }
}

describe('the prompt', () => {
  it('is the app\'s workflow, runner-eligible with its families on in both places, left as before with any off', () => {
    const p = buildAutoSubtitlePrompt('clip.mp4', SETTINGS)
    expect(p).toEqual({
      1: { class_type: 'LoadVideo', inputs: { file: 'clip.mp4' } },
      2: { class_type: 'GetVideoComponents', inputs: { video: ['1', 0] } },
      3: { class_type: 'WhisperTranscribe', inputs: { audio: ['2', 1], model_size: 'base', language: 'auto', fps: ['2', 2] } },
      4: { class_type: 'CaptionTrack', inputs: { frames: ['2', 0], captions: ['3', 0], font_size: 44, color: '#ffffff', outline_color: '#000000', outline_width: 3, position: 'bottom', y_inset: 0.08 } },
      5: { class_type: 'CreateVideo', inputs: { images: ['4', 0], fps: ['2', 2], audio: ['2', 1] } },
      6: { class_type: 'SaveVideo', inputs: { video: ['5', 0], filename_prefix: 'auto_subtitle', format: 'auto', codec: 'auto' } },
    })
    for (const hosted of [true, false]) {
      expect(isRunnerEligible(p, ON, { hosted })).toBe(true)
      for (const off of ON) {
        const fam = new Set<RunnerFamily>([...ON].filter(f => f !== off))
        expect(isRunnerEligible(p, fam, { hosted }), `${off} off`).toBe(false)
      }
      expect(isRunnerEligible(p, new Set<RunnerFamily>(), { hosted })).toBe(false)
    }
    // With video-text off, Caption track is named (and Create video, which reads its frames); Whisper and the rest are not.
    const named = nodesNeedingEngine(p, { runnerOn: true, families: new Set<RunnerFamily>([...ON].filter(f => f !== 'video-text')), titleOf: id => id })
    expect(named).toContain('4')
    expect(named).not.toContain('3')
  })
})

describe('the app, fed fake runner events', () => {
  it('the price shows once the video is uploaded, before the run; the video lands in a take, by node id', async () => {
    const { deps, w, video, takes, a } = setup()
    expect(a.canRun.value).toBe(false)
    video.value = { filename: 'clip.mp4' }
    await a.quote()
    expect(deps.postQuote).toHaveBeenCalledWith({ takes: [buildAutoSubtitlePrompt('clip.mp4', SETTINGS)] }, expect.any(AbortSignal))
    expect(a.priceText.value).toBe('up to <$0.01')
    expect(a.canRun.value).toBe(true)

    const done = a.run()
    await vi.waitFor(() => expect(deps.start).toHaveBeenCalled())
    expect(deps.confirm).toHaveBeenCalledWith(expect.objectContaining({ usd: 0.004, approximate: true }))
    expect(a.canStop.value).toBe(true)
    // Caption track's own preview comes first: the video is Save video's, by node id.
    w.post({ event: 'executed', prompt_id: 'run_1.0', node_id: '4', output: { images: [file('preview_4.png')], animated: [false] } })
    w.post({ event: 'executed', prompt_id: 'run_1.0', node_id: AUTO_SUBTITLE_OUT, output: { images: [file('auto_subtitle_00001_.mp4')], animated: [true] } })
    await done
    expect(a.status.value).toBe('done')
    expect(takes).toHaveLength(1)
    expect(takes[0]!.promptId).toBe('run_1.0')
    expect(takes[0]!.videos![0]).toContain('filename=auto_subtitle_00001_.mp4')
    expect(takes[0]!.videos![0]).toContain('subfolder=user_1')
    expect(w.size()).toBe(0)
  })

  it('in hosted the price is in credits; a new setting asks for the price of the new prompt', async () => {
    const { deps, video, settings, a } = setup({ hosted: true })
    video.value = { filename: 'clip.mp4' }
    await a.quote()
    expect(a.priceText.value).toBe('up to 2 cr')
    settings.value = { ...SETTINGS, position: 'top', language: 'fr' }
    await a.quote()
    expect(deps.postQuote).toHaveBeenLastCalledWith({ takes: [buildAutoSubtitlePrompt('clip.mp4', { ...SETTINGS, position: 'top', language: 'fr' })] }, expect.any(AbortSignal))
  })

  it('Stop ends this run: no take, back to idle, nothing left listening', async () => {
    const { deps, w, video, takes, a } = setup()
    video.value = { filename: 'clip.mp4' }
    await a.quote()
    const done = a.run()
    await vi.waitFor(() => expect(deps.start).toHaveBeenCalled())
    await new Promise(r => setTimeout(r, 0))
    await a.stop()
    expect(deps.stop).toHaveBeenCalledWith(['run_1'])
    w.post({ event: 'execution_complete', prompt_id: 'run_1.0', stopped: true })
    await done
    expect(a.status.value).toBe('idle')
    expect(a.errorMessage.value).toBeNull()
    expect(takes).toEqual([])
    expect(w.size()).toBe(0)
  })

  it('a refusal shows its words in place of the price, and the button stays off', async () => {
    const words = 'This video is too long to work on here.'
    const { video, a, deps } = setup({ hosted: true, deps: { postQuote: vi.fn(async (): Promise<AppQuote> => ({ refused: words })) } })
    video.value = { filename: 'long.mp4' }
    await a.quote()
    expect(a.priceText.value).toBeNull()
    expect(a.blocked.value).toBe(words)
    expect(a.canRun.value).toBe(false)
    await a.run()
    expect(deps.start).not.toHaveBeenCalled()
  })

  it('a run\'s error shows the app\'s words, never the engine\'s or a model\'s', async () => {
    const { deps, w, video, takes, a } = setup()
    video.value = { filename: 'clip.mp4' }
    await a.quote()
    const done = a.run()
    await vi.waitFor(() => expect(deps.start).toHaveBeenCalled())
    w.post({ event: 'execution_error', prompt_id: 'run_1.0' })
    await done
    expect(a.status.value).toBe('error')
    expect(a.errorMessage.value).toBe(AUTO_SUBTITLE_WORDS.failed)
    expect(takes).toEqual([])
    for (const words of Object.values(AUTO_SUBTITLE_WORDS)) expect(words).not.toMatch(/comfy|whisper|port|8188/i)
  })

  it('"no" at the cost gate starts nothing', async () => {
    const { deps, video, a, takes } = setup({ deps: { confirm: vi.fn(async () => false) } })
    video.value = { filename: 'clip.mp4' }
    await a.quote()
    await a.run()
    expect(deps.start).not.toHaveBeenCalled()
    expect(a.status.value).toBe('idle')
    expect(takes).toEqual([])
  })

  it('a decline in hosted: "switched off", the button off, nothing sent anywhere', async () => {
    const { video, a, deps, engine } = setup({ hosted: true, deps: { postQuote: vi.fn(async (): Promise<AppQuote> => ({ declined: true })) } })
    video.value = { filename: 'clip.mp4' }
    await a.quote()
    expect(a.blocked.value).toBe('This app is switched off right now.')
    expect(a.canRun.value).toBe(false)
    await a.run()
    expect(deps.start).not.toHaveBeenCalled()
    expect(engine).not.toHaveBeenCalled()
  })

  it('a decline on this computer: the engine as before (ruling (d)), no price, no Stop', async () => {
    const { video, a, deps, engine, takes } = setup({ deps: { postQuote: vi.fn(async (): Promise<AppQuote> => ({ declined: true })) } })
    video.value = { filename: 'clip.mp4' }
    await a.quote()
    expect(a.blocked.value).toBeNull()
    expect(a.priceText.value).toBeNull()
    expect(a.canRun.value).toBe(true)
    await a.run()
    expect(engine).toHaveBeenCalledWith(buildAutoSubtitlePrompt('clip.mp4', SETTINGS))
    expect(deps.start).not.toHaveBeenCalled()
    expect(takes[0]!.videos![0]).toContain('filename=engine.mp4')
  })

  it('a sound longer than Whisper takes here: the engine on this computer, a plain refusal in hosted', async () => {
    const tooLong = vi.fn(async (): Promise<AppQuote> => ({ refused: 'This sound is too long to transcribe here.', reason: RUNNER_SOUND_TOO_LONG }))
    const local = setup({ deps: { postQuote: tooLong } })
    local.video.value = { filename: 'clip.mp4' }
    await local.a.quote()
    expect(local.a.blocked.value).toBeNull()
    await local.a.run()
    expect(local.engine).toHaveBeenCalled()
    const hosted = setup({ hosted: true, deps: { postQuote: tooLong } })
    hosted.video.value = { filename: 'clip.mp4' }
    await hosted.a.quote()
    expect(hosted.a.blocked.value).toBe('This sound is too long to transcribe here.')
    expect(hosted.a.canRun.value).toBe(false)
  })

  it('the engine stop-gap takes the video from Save video by node id, and words its errors plainly', async () => {
    const history = (entry: unknown) => async (url: string) => (url === '/prompt'
      ? { ok: true, json: async () => ({ prompt_id: 'p9' }) }
      : { ok: true, json: async () => ({ p9: entry }) }) as unknown as Response
    const got = await runOnEngine(buildAutoSubtitlePrompt('clip.mp4', SETTINGS), {
      sleep: async () => {},
      fetch: history({ outputs: { 4: { images: [file('preview.png')] }, 6: { images: [file('auto_subtitle_00002_.mp4')], animated: [true] } }, status: { completed: true } }) as typeof fetch,
    })
    expect(got).toEqual({ promptId: 'p9', video: file('auto_subtitle_00002_.mp4') })
    await expect(runOnEngine({}, { sleep: async () => {}, fetch: history({ status: { status_str: 'error' } }) as typeof fetch })).rejects.toThrow(AUTO_SUBTITLE_WORDS.failed)
    await expect(runOnEngine({}, { sleep: async () => {}, fetch: (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch })).rejects.toThrow(AUTO_SUBTITLE_WORDS.noStart)
  })
})

// ── Through the kit: ComfyUI off ─────────────────────────────────────────────

const CLIP = 'v_stereo_aac.mp4'

function kitApp(o: { hold?: boolean } = {}) {
  const fal = createFakeFal({ answer: () => ({ text: 'Hello there', chunks: [{ timestamp: [0, 0.6], text: ' Hello there ' }], languages: ['en'] }) })
  if (o.hold) fal.holdNext(1)
  const k = makeKit({ hosted: true, fal, deps: { families: () => ON } })
  const bytes = readFileSync(clipPath(CLIP))
  mkdirSync(join(k.root, 'input', 'user_1'), { recursive: true })
  writeFileSync(join(k.root, 'input', 'user_1', CLIP), bytes)
  writeFileSync(join(k.root, 'input', CLIP), bytes)
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
  const video = ref<{ filename: string } | null>({ filename: CLIP })
  const takes: AppTakeInput[] = []
  const app = useAppRun({ hosted: true, debounceMs: 0, deps })
  const a = useAutoSubtitleRun({ video, settings: () => SETTINGS, addTake: t => takes.push(t), hosted: true, app, engine: async () => { throw new Error('the engine must not be used') }, wait: { target: w } })
  return { k, fal, a, takes, w, started }
}

describe('through the kit (ComfyUI off): the app\'s exact prompt', () => {
  it('quoted, then run: the quote equals the hold; the captioned video with its sound lands in a take; charged no more than held', async () => {
    await requireMediaTools()
    const { k, fal, a, takes, started } = kitApp()
    await a.quote()
    expect(a.blocked.value).toBeNull()
    expect(a.priceText.value).toMatch(/^up to \d+ cr$/)
    const quoted = Number(/(\d+) cr/.exec(a.priceText.value!)![1])
    await a.run()
    expect(a.errorMessage.value).toBeNull()
    expect(a.status.value).toBe('done')
    expect(fal.submitted().length).toBe(1)
    expect(takes).toHaveLength(1)
    const url = decodeURIComponent(takes[0]!.videos![0]!)
    expect(url).toMatch(/filename=auto_subtitle.*\.mp4/)
    expect(started).toHaveLength(1)
    const runId = started[0]!
    await k.engine.settled(runId)
    const take = (await k.store.get(runId))!.takes[0]!
    for (const id of ['1', '2', '3', '4', '5', '6']) expect(take.nodes[id]!.status, `${id}: ${take.nodes[id]!.error ?? ''}`).toBe('done')
    // Whisper's captions reached Caption track by wire: it drew them (no pass-through: a batch of its own).
    expect((take.nodes['3']!.values![0] as { text: string }).text).toMatch(/^0 \d+ Hello there$/)
    const batchOf = (id: string) => take.nodes[id]!.values![0] as { kind: string, file: { filename: string } }
    expect(batchOf('4').kind).toBe('frames')
    expect(batchOf('4').file.filename).not.toBe(batchOf('2').file.filename)
    // The video kept its sound.
    const name = /filename=([^&]+)/.exec(url)![1]!
    const sub = /subfolder=([^&]+)/.exec(url)?.[1] ?? ''
    const dir = join(k.root, 'output', sub)
    const probed = await probeMedia(join(dir, name), { userId: null, roots: [dir] })
    expect(probed.video.length).toBe(1)
    expect(probed.sound.length).toBe(1)
    const holds = [...k.ledger.holds.values()]
    expect(holds.reduce((n, h) => n + h.credits, 0)).toBe(quoted)
    expect(holds.every(h => h.actual !== null && h.actual <= h.credits)).toBe(true)
  }, 180_000)

  it('Stop mid-call: the call cancelled, the hold released, no take', async () => {
    await requireMediaTools()
    const { k, fal, a, takes } = kitApp({ hold: true })
    await a.quote()
    const done = a.run()
    for (let n = 0; n < 4000 && fal.submitted().length < 1; n++) await new Promise(r => setTimeout(r, 5))
    expect(fal.submitted().length).toBe(1)
    await a.stop()
    await done
    expect(a.status.value).toBe('idle')
    expect(takes).toEqual([])
    expect(fal.submitted()[0]!.cancelled).toBe(true)
    expect([...k.ledger.holds.values()].map(h => (h.state === 'released' ? 0 : h.actual))).toEqual([0])
  }, 120_000)
})
