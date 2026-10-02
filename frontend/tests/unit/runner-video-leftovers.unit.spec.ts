/**
 * R11.2: Generate a video's last two gaps on the runner.
 *
 *  - `model_options` takes a text wire. A wire hands the node the same
 *    string a typed widget would, read at the node's turn; the price holds a
 *    wired value at the model's dearest setting (nodePrice.ts), and the
 *    charge is the same calculation (the prompt as sent, wires as wires).
 *  - VEED Fabric 1.0 runs with a linked picture and a linked sound (family
 *    replicate-video): the sound goes as Python's WAV of it, its first 60 s,
 *    through the sound-in hand-off (soundWav.ts), and is measured before the
 *    hold; the hold and the charge are its seconds × the resolution's rate.
 *
 * The requests are checked against the first provider call the REAL
 * GenerateVideoNode.execute makes (scripts/runner_video_leftovers_fixtures.py
 * → fixtures/runner-video-leftovers.json). Nothing here reaches a provider
 * (fake fal, fake Replicate).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createFakeReplicate, makeKit, rgbPng1x1 } from './__runner__/kit'
import { requireMediaTools } from './__runner__/mediaParity'
import { expectPythonParity } from './helpers/pythonParity'
import { planNode } from '~~/server/runner/executors'
import { withWiredValues } from '~~/server/runner/values'
import { FABRIC_NEEDS_AUDIO, FABRIC_NEEDS_IMAGE, RUNNER_REPLICATE_VIDEO_MODELS } from '~~/server/runner/generators/video'
import { isFabricVideo, mediaNodeKind } from '~~/server/runner/nodeMedia'
import { priceGraph } from '~~/server/utils/priceBook'
import { priceNode } from '#shared/pricing/nodePrice'
import { creditsForUsd } from '#shared/pricing/markup'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { FABRIC_VIDEO_MODEL_ID, RUNNER_NODE_RULES, isRunnerEligible, runnerTakesNode } from '#shared/runner/eligibility'
import { staticValueOf } from '#shared/runner/staticValues'
import { runnerTakesWorkflow } from '#shared/runner/validate'

interface LeftoverCase {
  name: string
  model: string
  model_options: string
  image: boolean
  audio: boolean
  provider?: string
  endpoint?: string
  payload?: Record<string, unknown>
  error?: string
}
const CASES = (JSON.parse(readFileSync(resolve(__dirname, 'fixtures/runner-video-leftovers.json'), 'utf8')) as { cases: LeftoverCase[] }).cases
const FABRIC = CASES.filter(c => c.model === FABRIC_VIDEO_MODEL_ID && !c.error)
const OTHERS = CASES.filter(c => c.model !== FABRIC_VIDEO_MODEL_ID)

/** Python's picture and sound stand-ins (`IMG:<input>`, `WAV:<input>:<max_seconds>`), as the runner's hand-off links here. */
const IMAGE_URL = 'IMG:image'
const SOUND_URL = 'WAV:audio:60'

const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const VIDEO: ReadonlySet<RunnerFamily> = new Set(['replicate-video'])
const WIRED: ReadonlySet<RunnerFamily> = new Set(['cards', 'replicate-video'])
const SOUND: ReadonlySet<RunnerFamily> = new Set(['cards', 'media-sound', 'replicate-video'])

/** The case's node, its picture and sound linked from cards, its options typed or wired from a text card. */
function caseGraph(c: LeftoverCase, wired: boolean): ApiPrompt {
  const p: ApiPrompt = {}
  const inputs: Record<string, unknown> = { model: c.model, prompt: 'a person talking', aspect_ratio: '16:9', duration: '5', seed: 0, model_options: c.model_options }
  if (c.image) {
    p.src = { class_type: 'Image', inputs: { image: 'image.png' } }
    inputs.image = ['src', 0]
  }
  if (c.audio) {
    p.snd = { class_type: 'LoadAudio', inputs: { audio: 'audio.wav' } }
    inputs.audio = ['snd', 0]
  }
  if (wired) {
    // A Text card hands on '' for blank text; any other text comes from a PrimitiveString as it is.
    const v = c.model_options
    p.opts = v === v.trim() && v !== '' ? { class_type: 'Text', inputs: { text: v } } : { class_type: 'PrimitiveString', inputs: { value: v } }
    inputs.model_options = ['opts', 0]
  }
  p.n = { class_type: 'GenerateVideoNode', inputs }
  p.v = { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'v', source: ['n', 0] } }
  return p
}

const valueAt = (p: ApiPrompt) => (link: [string, number]): RunnerValue | undefined => staticValueOf(p, link) as RunnerValue | undefined

async function plan(p: ApiPrompt, extra: { recordedPayload?: Record<string, unknown> } = {}) {
  const soundWav = vi.fn(async () => ({ wav: new Uint8Array([1, 2, 3]), seconds: 3 }) as never)
  const bytesToUrl = vi.fn(async () => SOUND_URL)
  const planned = await planNode({
    prompt: withWiredValues(p, 'n', valueAt(p)).prompt,
    nodeId: 'n',
    filesFrom: () => [{ filename: 'image.png', subfolder: '', type: 'input' } as OutputFile],
    valueFrom: valueAt(p),
    toUrl: async () => IMAGE_URL,
    gateOpen: false,
    soundWav,
    bytesToUrl,
    ...extra,
  })
  if (planned.kind !== 'provider') throw new Error(`expected a provider call, got ${planned.kind}`)
  return { planned, soundWav, bytesToUrl }
}

/** The Replicate request (a model that moved to fal first carries it as its backup). */
const onReplicate = (p: Awaited<ReturnType<typeof plan>>['planned']) => (p.provider === 'replicate' ? p : p.backup!)

describe('the eligibility row', () => {
  it('model_options takes a text wire; Fabric needs its picture and its sound linked', () => {
    const row = RUNNER_NODE_RULES.GenerateVideoNode!
    expect(row.mustNotLink).toEqual(['prompt'])
    expect(row.valueInputs).toEqual({ prompt: ['text'], model_options: ['text'] })
    expect(row.models![FABRIC_VIDEO_MODEL_ID]).toEqual({ family: 'replicate-video', mustLink: ['image', 'audio'] })
    expect(RUNNER_REPLICATE_VIDEO_MODELS[FABRIC_VIDEO_MODEL_ID]).toMatchObject({ slug: 'veed/fabric-1.0', modes: ['i2v'], defaultDuration: 60 })
  })

  it('Fabric with a picture and a runner sound is taken; without either, or with replicate-video off, the engine keeps it', () => {
    const c = FABRIC[0]!
    expect(isRunnerEligible(caseGraph(c, false), SOUND)).toBe(true)
    expect(isRunnerEligible(caseGraph({ ...c, audio: false }, false), SOUND)).toBe(false)
    expect(isRunnerEligible(caseGraph({ ...c, image: false }, false), SOUND)).toBe(false)
    expect(isRunnerEligible(caseGraph(c, false), new Set<RunnerFamily>(['cards', 'media-sound']))).toBe(false)
    // The sound's own family off: its source isn't taken, so neither is the workflow.
    expect(isRunnerEligible(caseGraph(c, false), VIDEO)).toBe(false)
    // A "sound" from a picture card is refused.
    const fromPicture = caseGraph(c, false)
    fromPicture.n!.inputs!.audio = ['src', 0]
    delete fromPicture.snd
    expect(runnerTakesNode(fromPicture, 'n', SOUND)).toBe(false)
  })

  it('any other video model still leaves a linked sound to the engine', () => {
    const p = caseGraph({ ...OTHERS[0]!, audio: true }, false)
    expect(runnerTakesNode(p, 'n', SOUND)).toBe(false)
  })

  it('Fabric with its sound is a sound-measured node; without its sound, or another model, it is not', () => {
    const c = FABRIC[0]!
    expect(isFabricVideo(caseGraph(c, false).n)).toBe(true)
    expect(mediaNodeKind(caseGraph(c, false).n)).toBe('sound-in')
    expect(mediaNodeKind(caseGraph({ ...c, audio: false }, false).n)).toBeNull()
    expect(mediaNodeKind(caseGraph({ ...OTHERS[0]!, audio: true }, false).n)).toBeNull()
  })

  it('a wired model_options is taken with cards on; with cards off, or wired from a picture, the engine keeps it', () => {
    for (const c of OTHERS) {
      const p = caseGraph(c, true)
      expect(runnerTakesNode(p, 'n', WIRED), c.name).toBe(true)
      expect(runnerTakesWorkflow(p, WIRED), c.name).toBe(true)
      expect(isRunnerEligible(p, VIDEO), c.name).toBe(false)
    }
    const fromPicture = caseGraph({ ...OTHERS[1]! }, false)
    fromPicture.n!.inputs!.model_options = ['src', 0]
    expect(runnerTakesNode(fromPicture, 'n', WIRED)).toBe(false)
  })
})

describe('Fabric plans Python\'s request (fixtures)', () => {
  it('covers Fabric\'s options, its two refusals, and other models\' options as text', () => {
    expect(FABRIC.length).toBeGreaterThanOrEqual(8)
    expect(FABRIC.every(c => c.provider === 'replicate' && c.endpoint === 'veed/fabric-1.0')).toBe(true)
    expect(CASES.filter(c => c.error).map(c => c.name)).toEqual(['Fabric, no sound', 'Fabric, no picture'])
    expect(OTHERS.length).toBe(3)
  })

  it('the refusals are Python\'s words', () => {
    const d = RUNNER_REPLICATE_VIDEO_MODELS[FABRIC_VIDEO_MODEL_ID]!
    expect(CASES.find(c => c.name === 'Fabric, no sound')!.error).toBe(FABRIC_NEEDS_AUDIO)
    expect(() => d.build({ prompt: '', aspectRatio: '16:9', duration: 5, seed: 0, image: IMAGE_URL, adv: {} })).toThrow(FABRIC_NEEDS_AUDIO)
    expect(() => d.build({ prompt: '', aspectRatio: '16:9', duration: 5, seed: 0, image: null, adv: {}, audio: SOUND_URL })).toThrow(FABRIC_NEEDS_IMAGE)
  })

  for (const c of FABRIC) {
    it(c.name, async () => {
      for (const wired of [false, true]) {
        const p = caseGraph(c, wired)
        expect(runnerTakesNode(p, 'n', SOUND)).toBe(true)
        const { planned, soundWav, bytesToUrl } = await plan(p)
        expect([planned.provider, planned.endpoint]).toEqual([c.provider, c.endpoint])
        expect(planned.backup).toBeUndefined()
        expectPythonParity('replicate', 'veed/fabric-1.0', planned.payload, c.payload!)
        // Python sends any resolution as typed; the schema takes 480p or 720p, so anything else goes as 720p.
        expect(planned.payload).toEqual({ ...c.payload, resolution: ['480p', '720p'].includes(String(c.payload!.resolution)) ? c.payload!.resolution : '720p' })
        expect(soundWav).toHaveBeenCalledWith(['snd', 0])
        expect(bytesToUrl).toHaveBeenCalledWith({ filename: 'audio.wav', subfolder: '', type: 'kept' }, new Uint8Array([1, 2, 3]))
      }
    })
  }

  it('a resumed Fabric takes the sound link written down when it was sent: nothing is decoded again', async () => {
    const { planned, soundWav } = await plan(caseGraph(FABRIC[1]!, false), { recordedPayload: { audio: 'https://fal.storage/sent.wav' } })
    expect(planned.payload.audio).toBe('https://fal.storage/sent.wav')
    expect(soundWav).not.toHaveBeenCalled()
  })
})

describe('a wired model_options plans as typed', () => {
  for (const c of OTHERS) {
    it(c.name, async () => {
      const typed = await plan(caseGraph(c, false))
      const wired = await plan(caseGraph(c, true))
      expect(wired.planned.payload).toEqual(typed.planned.payload)
      expect(wired.planned.backup).toEqual(typed.planned.backup)
      const sent = onReplicate(wired.planned)
      expect(sent.endpoint).toBe(c.endpoint)
      expectPythonParity('replicate', c.endpoint!, sent.payload, c.payload!)
    })
  }
})

describe('prices: the hold is the ceiling, the charge the same calculation', () => {
  const fabricInputs = (res?: string, extra: Record<string, unknown> = {}) => ({
    model: FABRIC_VIDEO_MODEL_ID, prompt: '', aspect_ratio: '16:9', duration: '5', seed: 0,
    model_options: JSON.stringify(res ? { resolution: res } : {}), image: ['src', 0], audio: ['snd', 0], ...extra,
  })
  const usd = (inputs: Record<string, unknown>, inputSeconds?: Record<string, number>) => {
    const p = priceNode('GenerateVideoNode', inputs, inputSeconds ? { inputSeconds } : {})
    if ('refused' in p) throw new Error(p.refused)
    return p
  }

  it('Fabric: the sound\'s measured seconds (rounded up) × the resolution\'s rate; unmeasured, Python\'s 60 s', () => {
    expect(usd(fabricInputs('480p'), { audio: 4.2 }).usd).toBeCloseTo(5 * 0.08, 10)
    expect(usd(fabricInputs('720p'), { audio: 4.2 }).usd).toBeCloseTo(5 * 0.15, 10)
    expect(usd(fabricInputs('480p'), { audio: 5 }).usd).toBeCloseTo(0.4, 10)
    // A bound from the sound's maker (no measurement yet) holds on the bound.
    expect(usd(fabricInputs('480p'), { audioUpTo: 12 }).usd).toBeCloseTo(12 * 0.08, 10)
    // Never above 60 s, Python's cut.
    expect(usd(fabricInputs('480p'), { audio: 75 }).usd).toBeCloseTo(60 * 0.08, 10)
    expect(usd(fabricInputs('480p')).usd).toBeCloseTo(60 * 0.08, 10)
    expect(usd(fabricInputs()).usd).toBeCloseTo(60 * 0.15, 10)
    // A resolution the schema doesn't take goes as 720p, and is priced as 720p.
    expect(usd(fabricInputs('1080p'), { audio: 5 }).usd).toBe(usd(fabricInputs('720p'), { audio: 5 }).usd)
  })

  it('Fabric with wired options: the dearest resolution, on the measured sound', () => {
    const wired = fabricInputs(undefined, { model_options: ['opts', 0] })
    expect(usd(wired, { audio: 5 }).usd).toBeCloseTo(5 * 0.15, 10)
    expect(usd(wired).usd).toBeCloseTo(60 * 0.15, 10)
    for (const r of ['480p', '720p']) expect(usd(wired, { audio: 5 }).credits).toBeGreaterThanOrEqual(usd(fabricInputs(r), { audio: 5 }).credits)
  })

  it('every other model: a wired model_options is priced at its dearest, never below any typed option the fixture sends', () => {
    for (const c of OTHERS) {
      const typed = priceGraph(caseGraph(c, false), { families: WIRED }).nodes!.n!
      const wired = priceGraph(caseGraph(c, true), { families: WIRED }).nodes!.n!
      expect(wired, c.name).toBeGreaterThanOrEqual(typed)
    }
  })

  it('the price only reads a measured sound for Generate a video (Film a shot refuses Fabric)', () => {
    const p = priceNode('FilmShotNode', { ...fabricInputs('480p'), preset: 'slow_push_in' }, { inputSeconds: { audio: 5 } })
    if (!('refused' in p)) expect(p.usd).toBeCloseTo(60 * 0.08, 10)
  })
})

// ── The engine ───────────────────────────────────────────────────────────

/** A 16-bit PCM WAV of `seconds` of a quiet tone. */
function wavBytes(seconds: number, rate = 8000): Uint8Array {
  const n = Math.round(seconds * rate)
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin(i / 10) * 1000), i * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(data.length, 40)
  return new Uint8Array(Buffer.concat([h, data]))
}

describe('Fabric on the engine (fake Replicate)', () => {
  const graph = (o: { wired?: boolean, res?: string } = {}) => {
    const c = { ...FABRIC[0]!, model_options: JSON.stringify({ resolution: o.res ?? '480p' }) }
    return caseGraph(c, !!o.wired)
  }
  const kitFor = (hosted: boolean) => {
    const k = makeKit({ hosted, available: 50_000, replicate: createFakeReplicate(), deps: { families: () => SOUND } })
    writeFileSync(join(k.root, 'input', 'image.png'), rgbPng1x1(1, 7, 7))
    writeFileSync(join(k.root, 'input', 'audio.wav'), wavBytes(3.5))
    return k
  }

  for (const hosted of [false, true]) {
    it(`${hosted ? 'hosted' : 'locally'}: one call with the face and Python's WAV; held and charged on the measured 4 s at 480p`, async () => {
      await requireMediaTools()
      const k = kitFor(hosted)
      const p = graph()
      const { runId, promptIds } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
      await k.engine.settled(runId)
      const run = (await k.store.get(runId))!
      expect(run.status).toBe('done')
      const sent = k.replicate.submitted()
      expect(sent.map(s => s.endpoint)).toEqual(['veed/fabric-1.0'])
      expect(sent[0]!.payload).toEqual({ image: expect.stringMatching(/^https:\/\/fal\.storage\//), audio: 'https://fal.storage/audio.wav', resolution: '480p' })
      expect(k.upload.mock.calls.map(c => c[1])).toContain('audio.wav')
      // 3.5 s of sound, billed as 4 s: the hold and the charge are the same, and the shown price covers both.
      const held = priceGraph(p, { families: SOUND, inputSeconds: { n: { audio: 3.5 } } })
      expect(held.nodes!.n).toBe(creditsForUsd(4 * 0.08))
      // Locally nothing is held (no ledger); the node still records what it would charge.
      if (hosted) expect(k.ledger.hold).toHaveBeenCalledWith(k.userId, held.credits, `runner:${promptIds[0]}`)
      else expect(k.ledger.hold).not.toHaveBeenCalled()
      expect(run.takes[0]!.nodes.n!.credits).toBe(held.nodes!.n)
      expect(priceGraph(p, { families: SOUND }).credits).toBeGreaterThanOrEqual(held.credits)
    }, 60_000)
  }

  it('with its options wired: the request as typed, held at the dearest resolution on the measured sound', async () => {
    await requireMediaTools()
    const k = kitFor(true)
    const p = graph({ wired: true })
    const { runId, promptIds } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    expect(k.replicate.submitted()[0]!.payload.resolution).toBe('480p')
    const held = priceGraph(p, { families: SOUND, inputSeconds: { n: { audio: 3.5 } } })
    expect(held.nodes!.n).toBe(creditsForUsd(4 * 0.15))
    expect(k.ledger.hold).toHaveBeenCalledWith(k.userId, held.credits, `runner:${promptIds[0]}`)
    expect(run.takes[0]!.nodes.n!.credits).toBe(held.nodes!.n)
  }, 60_000)

})
