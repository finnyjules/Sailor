/**
 * Step 3, R8.0: the price before a run (engine.ts quoteRun, POST
 * /api/runs/quote). The quote runs the start's own checks and measurements
 * and the hold's calculation (prepareStart + legPrices, the code startRun
 * runs), with nothing held, stored, kept or sent. For each mini app's
 * workflow, in both places, the quote equals the hold the same run then takes.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { isRunnerEligible } from '#shared/runner/eligibility'
import { BG_REMOVE_CLASS, VOCALS_CLASS, WHISPER_CLASS } from '#shared/runner/localModels'
import { RUNNER_NOT_ELIGIBLE } from '#shared/runner/messages'
import { createMemoryKeptBytes } from '~~/server/runner/keptBytes'
import { NOT_YOURS } from '~~/server/runner/inputs'
import { MeterRefusalError } from '~~/server/utils/requestMeter'
import { quoteAnswerOf } from '~~/server/api/runs/quote.post'
import { makeKit, rgbPng1x1 } from './__runner__/kit'
import { requireMediaTools } from './__runner__/mediaParity'

const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const SAVE_DEFAULTS = { filename_prefix: 'ComfyUI', format: 'png', quality: 90, lossless_webp: false, png_compression: 4, scale: 1, max_dimension: 0, embed_metadata: true }

/** A 16-bit PCM WAV of `seconds` of a quiet tone. */
function wav(seconds: number, rate = 16000, channels = 1): Uint8Array {
  const n = Math.round(seconds * rate) * channels
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(3000 * Math.sin(i / 9)), i * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(data.length, 40)
  return new Uint8Array(Buffer.concat([h, data]))
}

const CUTOUT = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/runner-paid-local-cutout.json'), 'utf8')) as { cases: { name: string; pictures: string[]; widgets: Record<string, unknown> }[] }
const cut = CUTOUT.cases.find(c => c.name === 'cutout · soft alpha · transparent · edge 0')!

interface AppCase {
  name: string
  families: ReadonlySet<RunnerFamily>
  prompt: ApiPrompt
  files: Record<string, Uint8Array>
  media?: true
}

/** Each R8 app's workflow the runner takes today (R8.1–R8.4 add the rest of their chains). */
const APPS: AppCase[] = [
  {
    // FaceSwapApp.vue (awaitRunnerResult.ts buildFaceSwapPrompt).
    name: 'Face swap',
    families: new Set<RunnerFamily>(['cards', 'face-swap']),
    prompt: {
      1: { class_type: 'LoadImage', inputs: { image: 'face.png' } },
      2: { class_type: 'LoadImage', inputs: { image: 'target.png' } },
      3: { class_type: 'FaceSwap', inputs: { source_face: ['1', 0], target_frames: ['2', 0], gender: 'Female', keep_hair_from: 'The face photo' } },
    },
    files: { 'face.png': rgbPng1x1(200, 150, 120), 'target.png': rgbPng1x1(90, 80, 70) },
  },
  {
    // Product shot's cut-out (R8 ruling (a)): Load image → Background remove → Save image.
    name: 'Product shot cut-out',
    families: new Set<RunnerFamily>(['cards', 'bg-remove']),
    prompt: {
      1: { class_type: 'LoadImage', inputs: { image: 'product.png', upload: 'image' } },
      2: { class_type: BG_REMOVE_CLASS, inputs: { frames: ['1', 0], ...cut.widgets } },
      3: { class_type: 'SaveImage', inputs: { images: ['2', 0], ...SAVE_DEFAULTS, filename_prefix: 'product_cutout' } },
    },
    files: { 'product.png': new Uint8Array(Buffer.from(cut.pictures[0]!, 'base64')) },
  },
  {
    // KaraokeMakerApp.vue: Load audio → Vocal separator → two MP3s.
    name: 'Karaoke',
    families: new Set<RunnerFamily>(['cards', 'media-sound', 'vocal-split']),
    prompt: {
      s: { class_type: 'LoadAudio', inputs: { audio: 'song.wav' } },
      n: { class_type: VOCALS_CLASS, inputs: { audio: ['s', 0], model: 'htdemucs', shifts: 1 } },
      v: { class_type: 'SaveAudioMP3', inputs: { audio: ['n', 0], filename_prefix: 'karaoke_vocals', quality: 'V0' } },
      i: { class_type: 'SaveAudioMP3', inputs: { audio: ['n', 1], filename_prefix: 'karaoke_instrumental', quality: 'V0' } },
    },
    files: { 'song.wav': wav(3, 44100, 2) },
    media: true,
  },
  {
    // Auto subtitle's transcription (its Caption track is R8.3's): Load audio → Whisper → its texts.
    name: 'Auto subtitle transcription',
    families: new Set<RunnerFamily>(['cards', 'media-sound', 'whisper-captions']),
    prompt: {
      s: { class_type: 'LoadAudio', inputs: { audio: 'speech.wav' } },
      n: { class_type: WHISPER_CLASS, inputs: { audio: ['s', 0], model_size: 'base', language: 'auto', fps: 30 } },
      t0: { class_type: 'Text', inputs: { source: ['n', 0], text: '' } },
    },
    files: { 'speech.wav': wav(2) },
    media: true,
  },
]

function kitFor(c: AppCase, hosted: boolean) {
  const kept = createMemoryKeptBytes()
  const k = makeKit({ hosted, deps: { families: () => c.families, kept } })
  for (const [name, bytes] of Object.entries(c.files)) {
    writeFileSync(join(k.root, 'input', name), bytes)
    mkdirSync(join(k.root, 'input', 'user_1'), { recursive: true })
    writeFileSync(join(k.root, 'input', 'user_1', name), bytes)
  }
  return { k, kept }
}

/** Spies on everything a quote must never touch. */
function spies(k: ReturnType<typeof makeKit>, kept: ReturnType<typeof createMemoryKeptBytes>) {
  return {
    hold: vi.spyOn(k.deps.metering, 'hold'),
    finish: vi.spyOn(k.deps.metering, 'finish'),
    moderate: vi.spyOn(k.deps.metering, 'moderate'),
    save: vi.spyOn(k.store, 'save'),
    put: vi.spyOn(kept, 'put'),
  }
}

function expectUntouched(k: ReturnType<typeof makeKit>, s: ReturnType<typeof spies>) {
  expect(s.hold).not.toHaveBeenCalled()
  expect(s.finish).not.toHaveBeenCalled()
  expect(s.moderate).not.toHaveBeenCalled()
  expect(s.save).not.toHaveBeenCalled()
  expect(s.put).not.toHaveBeenCalled()
  expect(k.ledger.hold).not.toHaveBeenCalled()
  expect(k.ledger.settle).not.toHaveBeenCalled()
  expect(k.ledger.release).not.toHaveBeenCalled()
  expect(k.graphRuns.create).not.toHaveBeenCalled()
  expect(k.fal.client.submit).not.toHaveBeenCalled()
  expect(k.replicate.client.submit).not.toHaveBeenCalled()
  expect(k.upload).not.toHaveBeenCalled()
}

describe('the quote equals the hold, for every app\'s workflow, in both places', () => {
  for (const c of APPS) {
    for (const hosted of [true, false]) {
      it(`${c.name} (${hosted ? 'hosted' : 'this computer'})`, async () => {
        if (c.media) await requireMediaTools()
        expect(isRunnerEligible(c.prompt, c.families, { hosted })).toBe(true)
        const { k, kept } = kitFor(c, hosted)
        const s = spies(k, kept)
        const quote = await k.engine.quoteRun({ userId: k.userId, takes: [c.prompt], ...START })
        expectUntouched(k, s)
        expect(await k.store.listActive()).toEqual([])
        expect(quote.credits).toBeGreaterThan(0)
        expect(quote.usd).toBeGreaterThan(0)

        const { runId } = await k.engine.startRun({ userId: k.userId, takes: [c.prompt], ...START })
        const run = (await k.store.get(runId))!
        const held = run.charges.reduce((n, ch) => n + ch.estimate, 0)
        expect(quote.credits).toBe(held)
        if (hosted) expect([...k.ledger.holds.values()].reduce((n, h) => n + h.credits, 0)).toBe(quote.credits)
        await k.engine.stop(k.userId, [runId])
        await k.engine.settled(runId)
      }, 120_000)
    }
  }

  it('several takes: the sum of each take\'s hold', async () => {
    const c = APPS[0]!
    const { k } = kitFor(c, true)
    const quote = await k.engine.quoteRun({ userId: k.userId, takes: [c.prompt, c.prompt], ...START })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [c.prompt, c.prompt], ...START })
    expect([...k.ledger.holds.values()].reduce((n, h) => n + h.credits, 0)).toBe(quote.credits)
    await k.engine.stop(k.userId, [runId])
    await k.engine.settled(runId)
  })

  it('a node held on a bound says "up to"; one priced flat does not', async () => {
    await requireMediaTools()
    const karaoke = APPS.find(a => a.name === 'Karaoke')!
    const { k } = kitFor(karaoke, true)
    expect((await k.engine.quoteRun({ userId: k.userId, takes: [karaoke.prompt], ...START })).upTo).toBe(true)
    const face = APPS[0]!
    const f = kitFor(face, true)
    expect((await f.k.engine.quoteRun({ userId: f.k.userId, takes: [face.prompt], ...START })).upTo).toBe(false)
  }, 120_000)
})

describe('a quote refuses as the start would, before anything', () => {
  const face = APPS[0]!

  it('a workflow the runner wouldn\'t take: the not-eligible marker (the route answers { declined: true })', async () => {
    const { k, kept } = kitFor({ ...face, families: new Set<RunnerFamily>(['cards']) }, true)
    const s = spies(k, kept)
    const err = await k.engine.quoteRun({ userId: k.userId, takes: [face.prompt], ...START }).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(MeterRefusalError)
    expect(quoteAnswerOf(err)).toEqual({ declined: true })
    expectUntouched(k, s)
  })

  it('a refusal in plain words (the route answers { refused })', async () => {
    const { k, kept } = kitFor(face, true)
    const s = spies(k, kept)
    const noGender = { ...face.prompt, 3: { ...face.prompt[3]!, inputs: { ...face.prompt[3]!.inputs, gender: 'Not chosen' } } }
    const err = await k.engine.quoteRun({ userId: k.userId, takes: [noGender], ...START }).then(() => null, (e: unknown) => e)
    const answer = quoteAnswerOf(err)
    expect(answer).toHaveProperty('refused')
    expect((answer as { refused: string }).refused).not.toMatch(/FaceSwap|gender_0|class/)
    expectUntouched(k, s)
  })

  it('hosted: signed out is refused', async () => {
    const { k } = kitFor(face, true)
    const err = await k.engine.quoteRun({ userId: null, takes: [face.prompt], ...START }).then(() => null, (e: unknown) => e)
    expect(quoteAnswerOf(err)).toEqual({ refused: 'Sign in to run workflows' })
  })

  it('hosted: another person\'s file is refused, judged by its name before any disk read', async () => {
    const { k } = kitFor(face, true)
    const owns = vi.fn(async () => false)
    k.deps.ownership.ownsInput = owns
    const reads = vi.spyOn(k.deps.results, 'read')
    const err = await k.engine.quoteRun({ userId: k.userId, takes: [face.prompt], ...START }).then(() => null, (e: unknown) => e)
    expect(err).toMatchObject({ statusCode: 403, message: NOT_YOURS })
    expect(owns).toHaveBeenCalled()
    expect(reads).not.toHaveBeenCalled()
  })

  it('hosted: a name that climbs out of its folder is refused by name, before any disk read', async () => {
    const karaoke = APPS.find(a => a.name === 'Karaoke')!
    const { k, kept } = kitFor(karaoke, true)
    const s = spies(k, kept)
    const reads = vi.spyOn(k.deps.results, 'read')
    const exists = vi.spyOn(k.deps.results, 'exists')
    const climbing: ApiPrompt = {
      f: { class_type: 'LoadVideoFrames', inputs: { file: 'clip.mp4', max_seconds: 10, max_frames: 3, max_size: 64, start_frame: 0, stride: 1 } },
      s: { class_type: 'SaveVideoFrames', inputs: { frames: ['f', 0], fps: 24, filename_prefix: 'video', audio_file: '../../../etc/song.wav', preset: 'veryfast', crf: 20 } },
    }
    const fam = new Set<RunnerFamily>(['cards', 'media-video'])
    expect(isRunnerEligible(climbing, fam, { hosted: true })).toBe(true)
    const k2 = makeKit({ hosted: true, deps: { families: () => fam } })
    const reads2 = vi.spyOn(k2.deps.results, 'read')
    const exists2 = vi.spyOn(k2.deps.results, 'exists')
    const err = await k2.engine.quoteRun({ userId: k2.userId, takes: [climbing], ...START }).then(() => null, (e: unknown) => e)
    expect(err).toMatchObject({ statusCode: 403, message: NOT_YOURS })
    expect(reads2).not.toHaveBeenCalled()
    expect(exists2).not.toHaveBeenCalled()
    // A loaded sound's own name, the same way: never read, refused as not the person's.
    const owns = vi.fn(async () => false)
    k.deps.ownership.ownsInput = owns
    const err2 = await k.engine.quoteRun({ userId: k.userId, takes: [{ ...karaoke.prompt, s: { class_type: 'LoadAudio', inputs: { audio: 'other_user/song.wav' } } }], ...START }).then(() => null, (e: unknown) => e)
    expect(err2).toMatchObject({ statusCode: 403, message: NOT_YOURS })
    expect(reads).not.toHaveBeenCalled()
    expect(exists).not.toHaveBeenCalled()
    expectUntouched(k, s)
  })

  it('the route answers a fault by throwing it on (never a price)', () => {
    expect(() => quoteAnswerOf(new Error('boom'))).toThrow('boom')
    expect(quoteAnswerOf(new MeterRefusalError('x', 400, { reason: RUNNER_NOT_ELIGIBLE }))).toEqual({ declined: true })
  })
})
