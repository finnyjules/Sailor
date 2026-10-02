/**
 * R11.3: Lip-sync's other engines on the runner (family `sound-in`).
 *
 *  - Lip-sync a character on Fabric (`veed/fabric-1.0`) and Kling
 *    (`kwaivgi/kling-lip-sync`, Python's "sync"), resolved as
 *    `_lipsync_resolve_engine` does; Fabric priced on the sound's measured
 *    length, Kling on the face video's, the way sync-3 is priced.
 *  - A sound from a Load or Record audio card into Lip-sync (R5.3 case A):
 *    sent as Python's WAV of its first 60 s, on Fabric, Kling and sync-3.
 *  - Sync lips' "silence" mode (ruling (o)): priced on the face video's
 *    measured length, which bounds what it bills.
 *
 * The requests are checked against the first provider call the REAL
 * LipSyncNode.execute makes (scripts/runner_lipsync_engines_fixtures.py →
 * fixtures/runner-lipsync-engines.json). Nothing reaches a provider.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BufferTarget, EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output } from 'mediabunny'
import { createFakeFal, createFakeReplicate, makeKit, rgbPng1x1, until } from './__runner__/kit'
import { requireMediaTools } from './__runner__/mediaParity'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import { planNode } from '~~/server/runner/executors'
import { mediaNodeKind, nodeMediaCheck } from '~~/server/runner/nodeMedia'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import { requestProblems } from '~~/server/runner/requestRules'
import { priceGraph } from '~~/server/utils/priceBook'
import { priceNode } from '#shared/pricing/nodePrice'
import { creditsForUsd } from '#shared/pricing/markup'
import { remoteVideoCalls } from '#shared/pricing/clipSettings'
import { RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { isRunnerEligible, runnerTakesNode } from '#shared/runner/eligibility'
import { runnerTakesWorkflow } from '#shared/runner/validate'
import {
  FABRIC_LIPSYNC_NEEDS_FACE, FABRIC_LIPSYNC_SLUG, KLING_LIPSYNC_NEEDS_VIDEO, KLING_LIPSYNC_SLUG, KLING_LIPSYNC_SOUND_TOO_LARGE, KLING_LIPSYNC_SOUND_UNSIZED, pythonWavBytesBound,
  LIPSYNC_ENGINE_TOO_LONG, LIPSYNC_NEEDS_SOUND, fabricLipSyncResolution, lipSyncRunEngine,
} from '#shared/runner/lipSyncEngines'
import { LIPSYNC_SILENCE_TOO_LONG, RVC_MODELS, RVC_PITCH_ALGORITHMS, RVC_PITCH_CHANGES, RVC_PRESET_VOICES } from '#shared/runner/soundIn'
import { RUNNER_NOT_ELIGIBLE } from '#shared/runner/messages'
import { upstreamInputSeconds } from '~/lib/costEstimate'
import type { ApiPrompt } from '#shared/runner/graph'
import type { OutputFile } from '~~/server/runner/types'

interface LipCase {
  name: string
  engine: string
  resolution: string
  model_options: string
  wired_audio: boolean
  provider?: string
  endpoint?: string
  payload?: Record<string, unknown>
  error?: string
}
const CASES = (JSON.parse(readFileSync(resolve(__dirname, 'fixtures/runner-lipsync-engines.json'), 'utf8')) as { cases: LipCase[] }).cases
const SENT = CASES.filter(c => !c.error)

const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const ON: ReadonlySet<RunnerFamily> = new Set(['cards', 'media-sound', 'sound-in'])
const ON_SYNC3: ReadonlySet<RunnerFamily> = new Set([...ON, 'sync-3'])
const FABRIC_SCHEMA = loadProviderSchema('replicate', FABRIC_LIPSYNC_SLUG)
const KLING_SCHEMA = loadProviderSchema('replicate', KLING_LIPSYNC_SLUG)

/** Python's stand-ins (the fixture script's): a wired sound's WAV, and Kling's upload of it. */
const PY_WAV = 'data:audio/wav;base64,V0FW'
const PY_KLING_WAV = 'UPLOAD:lipsync-voice.mp3'

/** The case's node: a Load audio → Audio card wired in when the case wires a sound; a Video card reads it. */
function caseGraph(c: Pick<LipCase, 'engine' | 'resolution' | 'model_options' | 'wired_audio'>): ApiPrompt {
  const p: ApiPrompt = {}
  const inputs: Record<string, unknown> = { engine: c.engine, resolution: c.resolution, sync_mode: 'cut_off', model_options: c.model_options }
  if (c.wired_audio) {
    p.snd = { class_type: 'LoadAudio', inputs: { audio: 'voice.wav' } }
    p.card = { class_type: 'Audio', inputs: { audio: '', export: false, filename_prefix: 'audio/ComfyUI', format: 'flac', quality: 'V0', source: ['snd', 0] } }
    inputs.audio = ['card', 0]
  }
  p.n = { class_type: 'LipSyncNode', inputs }
  p.v = { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'v', source: ['n', 0] } }
  return p
}

/** planNode with Python's stand-ins as the hand-off: Fabric's files as data links, Kling's as uploads. */
async function plan(p: ApiPrompt, extra: { recordedPayload?: Record<string, unknown>, wavBytes?: number } = {}) {
  const engine = lipSyncRunEngine(p.n!.inputs ?? {})
  const soundWav = vi.fn(async () => ({ wav: new Uint8Array(extra.wavBytes ?? 3), seconds: 3 }) as never)
  const bytesToUrl = vi.fn(async () => (engine === 'kling' ? PY_KLING_WAV : PY_WAV))
  const toUrl = vi.fn(async (f: OutputFile) => (engine === 'kling' ? `UPLOAD:${f.filename}` : `FILE:${f.filename}`))
  const planned = await planNode({
    prompt: p, nodeId: 'n', filesFrom: () => [], valueFrom: () => undefined, toUrl, gateOpen: false, soundWav, bytesToUrl,
    ...(extra.recordedPayload ? { recordedPayload: extra.recordedPayload } : {}),
  })
  if (planned.kind !== 'provider') throw new Error(`expected a provider call, got ${planned.kind}`)
  return { planned, soundWav, bytesToUrl, toUrl }
}

/** What the runner sends for Fabric's resolution where Python sends it as typed (the S1b rule). */
const runnerResolution = (v: unknown) => (typeof v === 'string' && ['480p', '720p'].includes(v.toLowerCase()) ? v.toLowerCase() : '720p')

// ── 1. Schemas and routes ────────────────────────────────────────────────

describe('schemas and routes', () => {
  it('Kling\'s saved schema: video_url and audio_file, the 2–10 s video and 5 MB sound limits', () => {
    expect(KLING_SCHEMA.endpoint).toBe(KLING_LIPSYNC_SLUG)
    const input = KLING_SCHEMA.components.schemas.Input as { properties: Record<string, { description?: string }> }
    expect(Object.keys(input.properties)).toEqual(expect.arrayContaining(['video_url', 'audio_file']))
    expect(input.properties.video_url!.description).toContain('2-10 seconds')
    expect(input.properties.audio_file!.description).toContain('less than 5MB')
  })

  it('both engines are on Replicate, with no backup', () => {
    for (const k of ['LipSyncNode:fabric', 'LipSyncNode:kling']) {
      expect(RUNNER_ROUTES[k]!.first, k).toBe('replicate')
      expect(RUNNER_ROUTES[k]!.backup, k).toBeNull()
    }
  })
})

// ── 2. Python's requests ─────────────────────────────────────────────────

describe('each engine\'s request equals Python\'s (fixtures)', () => {
  it('covers both engines, auto, the options over the widget, a wired sound and Python\'s three raises', () => {
    expect(SENT.filter(c => c.endpoint === FABRIC_LIPSYNC_SLUG).length).toBeGreaterThanOrEqual(12)
    expect(SENT.filter(c => c.endpoint === KLING_LIPSYNC_SLUG).length).toBeGreaterThanOrEqual(6)
    expect(SENT.filter(c => c.wired_audio).length).toBe(3)
    expect(CASES.filter(c => c.error).length).toBe(5)
  })

  for (const c of SENT) {
    it(c.name, async () => {
      const p = caseGraph(c)
      expect(lipSyncRunEngine(p.n!.inputs!)).toBe(c.endpoint === FABRIC_LIPSYNC_SLUG ? 'fabric' : 'kling')
      expect(runnerTakesNode(p, 'n', ON)).toBe(true)
      const { planned, soundWav } = await plan(p)
      expect([planned.provider, planned.endpoint, planned.backup]).toEqual([c.provider, c.endpoint, undefined])
      const expected = c.endpoint === FABRIC_LIPSYNC_SLUG ? { ...c.payload, resolution: runnerResolution(c.payload!.resolution) } : c.payload
      expect(planned.payload).toEqual(expected)
      // Every payload fits the saved schema once the stand-ins are real links.
      const asLinks = Object.fromEntries(Object.entries(planned.payload).map(([k, v]) => [k, k === 'resolution' ? v : `https://x.test/${encodeURIComponent(String(v))}`]))
      expect(checkPayload(c.endpoint === FABRIC_LIPSYNC_SLUG ? FABRIC_SCHEMA : KLING_SCHEMA, asLinks)).toEqual([])
      if (c.wired_audio) expect(soundWav).toHaveBeenCalledWith(['card', 0])
      else expect(soundWav).not.toHaveBeenCalled()
    })
  }

  it('the only differences from Python: a resolution the schema doesn\'t take goes as 720p (480P as 480p)', () => {
    const differ = SENT.filter(c => c.endpoint === FABRIC_LIPSYNC_SLUG && c.payload!.resolution !== runnerResolution(c.payload!.resolution)).map(c => c.name)
    expect(differ.sort()).toEqual(['Fabric from the studio, 1080p', 'Fabric, a number for the resolution', 'Fabric, an upper-case resolution'].sort())
  })

  it('Python\'s raises are refused before the hold, in plain words', () => {
    const refusal = (c: LipCase) => requestProblems(caseGraph(c), { runner: true }).map(x => x.message)
    expect(CASES.find(c => c.name === 'no sound')!.error).toBe('Lip-sync requires an audio clip.')
    expect(refusal(CASES.find(c => c.name === 'no sound')!)).toEqual([LIPSYNC_NEEDS_SOUND])
    expect(refusal(CASES.find(c => c.name === 'Fabric with no face picture')!)).toEqual([FABRIC_LIPSYNC_NEEDS_FACE])
    expect(refusal(CASES.find(c => c.name === 'Kling with no face video')!)).toEqual([KLING_LIPSYNC_NEEDS_VIDEO])
    // Options that aren't an object read as {} (the widget's engine, no sound): refused, as Python raises.
    expect(refusal(CASES.find(c => c.name === 'options that are not an object')!)).toEqual([LIPSYNC_NEEDS_SOUND])
    // Options Python can't read either: the engine is unknown before the run, so the engine keeps it (Python raises too).
    expect(runnerTakesNode(caseGraph(CASES.find(c => c.name === 'broken options')!), 'n', ON)).toBe(false)
  })

  it('a resumed node takes the links written down when it was sent: nothing is read or decoded again', async () => {
    const c = SENT.find(x => x.name === 'Kling, a wired sound')!
    const { planned, soundWav, toUrl } = await plan(caseGraph(c), { recordedPayload: { video_url: 'https://fal.storage/v.mp4', audio_file: 'https://fal.storage/a.wav' } })
    expect(planned.payload).toEqual({ video_url: 'https://fal.storage/v.mp4', audio_file: 'https://fal.storage/a.wav' })
    expect(soundWav).not.toHaveBeenCalled()
    expect(toUrl).not.toHaveBeenCalled()
  })

  it('Kling: a wired sound\'s WAV is judged before the hold (fix round 1); the plan keeps a last guard', async () => {
    // The bound of Python's WAV from the source's shape: its first 60 s, 16-bit, at most stereo.
    expect(pythonWavBytesBound({ rate: 44100, channels: 1, samples: 44100 * 61, exact: true })).toBe(128 + 60 * 44100 * 2)
    expect(pythonWavBytesBound({ rate: 8000, channels: 2, samples: 8000 * 10, exact: false })).toBe(128 + 11 * 8000 * 2 * 2)
    expect(pythonWavBytesBound({ rate: 48000, channels: 6, samples: 48000, exact: true })).toBe(128 + 48000 * 2 * 2)
    const c = SENT.find(x => x.name === 'Kling, a wired sound')!
    const p = caseGraph(c)
    const reads = (shape: unknown) => ({ read: async () => new Uint8Array(), strict: true, soundShape: async () => shape as never })
    // The start of the run (no WAV yet): a long 44.1 kHz sound is over 5 MB, a sound with no shape can't be judged.
    expect(await nodeMediaCheck(p, 'n', reads({ rate: 44100, channels: 1, samples: 44100 * 61, exact: true }))).toEqual({ problem: KLING_LIPSYNC_SOUND_TOO_LARGE })
    expect(await nodeMediaCheck(p, 'n', reads(null))).toEqual({ problem: KLING_LIPSYNC_SOUND_UNSIZED })
    // The node's turn: the WAV itself.
    const big = { read: async () => new Uint8Array(), strict: true, soundWav: async () => ({ wav: new Uint8Array(5_000_001), seconds: 57 }) as never }
    expect(await nodeMediaCheck(p, 'n', big)).toEqual({ problem: KLING_LIPSYNC_SOUND_TOO_LARGE })
    await expect(plan(caseGraph(c), { wavBytes: 5_000_001 })).rejects.toThrow(KLING_LIPSYNC_SOUND_TOO_LARGE)
  })
})

// ── 3. What the runner takes ─────────────────────────────────────────────

const fabricOpts = (o: Record<string, unknown> = {}) => JSON.stringify({ engine: 'fabric', resolution: '480p', audio: '/view?filename=voice.wav&type=input', face_image: '/view?filename=face.png&type=input', ...o })
const klingOpts = (o: Record<string, unknown> = {}) => JSON.stringify({ engine: 'sync', resolution: '720p', audio: '/view?filename=voice.wav&type=input', face_video: '/view?filename=face.mp4&type=input', sync_mode: 'cut_off', ...o })
const node = (model_options: string, wired_audio = false) => caseGraph({ engine: 'auto', resolution: '720p', model_options, wired_audio })

describe('what the runner takes', () => {
  it('with sound-in on; with it off (any other families) the engine keeps Fabric and Kling, as before', () => {
    for (const opts of [fabricOpts(), klingOpts()]) {
      expect(runnerTakesWorkflow(node(opts), ON), opts).toBe(true)
      const off = new Set(RUNNER_FAMILIES.filter(f => f !== 'sound-in'))
      expect(runnerTakesNode(node(opts), 'n', off), opts).toBe(false)
      expect(runnerTakesWorkflow(node(opts), off), opts).toBe(false)
      expect(isRunnerEligible(node(opts), new Set<RunnerFamily>(['sync-3', 'cards', 'media-sound'])), opts).toBe(false)
    }
  })

  it('what it can\'t read before the run stays with the engine (a stop-gap, named in the report)', () => {
    // Fabric: a sound at a web address (its length is the price).
    expect(runnerTakesNode(node(fabricOpts({ audio: 'https://example.com/v.mp3' })), 'n', ON)).toBe(false)
    expect(runnerTakesNode(node(fabricOpts({ face_image: 'data:image/png;base64,AA' })), 'n', ON)).toBe(false)
    // Kling: a face video at a web address (its length is the price).
    expect(runnerTakesNode(node(klingOpts({ face_video: 'https://example.com/f.mp4' })), 'n', ON)).toBe(false)
    expect(runnerTakesNode(node(klingOpts({ audio: 'http://example.com/v.mp3' })), 'n', ON)).toBe(false)
    // A wired face picture.
    const p = node(fabricOpts())
    p.img = { class_type: 'Image', inputs: { image: 'face.png' } }
    p.n!.inputs!.image = ['img', 0]
    expect(runnerTakesNode(p, 'n', ON)).toBe(false)
    // An https face (Fabric) and an https sound (Kling) are sent as typed: taken.
    expect(runnerTakesNode(node(fabricOpts({ face_image: 'https://example.com/f.png' })), 'n', ON)).toBe(true)
    expect(runnerTakesNode(node(klingOpts({ audio: 'https://example.com/v.mp3' })), 'n', ON)).toBe(true)
  })

  it('the media check: Fabric reads its sound, Kling its face video', () => {
    expect(mediaNodeKind(node(fabricOpts()).n)).toBe('lip-sync-engine')
    expect(mediaNodeKind(node(klingOpts()).n)).toBe('lip-sync-engine')
    expect(mediaNodeKind(node(JSON.stringify({ engine: 'sync-3' })).n)).toBe('sync-3')
  })

  it('R5.3 case A: Load audio → Audio card → Lip-sync is taken with sound-in on (Fabric, Kling, sync-3); off, the engine keeps it', () => {
    for (const opts of [fabricOpts({ audio: '' }), klingOpts({ audio: '' })]) {
      expect(runnerTakesWorkflow(node(opts, true), ON), opts).toBe(true)
      expect(runnerTakesWorkflow(node(opts, true), new Set<RunnerFamily>(['cards', 'media-sound', 'sync-3'])), opts).toBe(false)
    }
    const s3 = node(klingOpts({ engine: 'sync-3', audio: '' }), true)
    s3.n!.inputs!.engine = 'sync-3'
    expect(runnerTakesWorkflow(s3, ON_SYNC3)).toBe(true)
    expect(runnerTakesWorkflow(s3, new Set<RunnerFamily>(['cards', 'media-sound', 'sync-3']))).toBe(false)
  })

  it('Sync lips in silence: taken only on an uploaded face video', () => {
    const sync = (video_url: string, sync_mode = 'silence'): ApiPrompt => ({
      snd: { class_type: 'LoadAudio', inputs: { audio: 'voice.wav' } },
      n: { class_type: 'LipsyncNode', inputs: { model: 'sync.so 2-pro', audio: ['snd', 0], video_url, sync_mode } },
      v: { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'v', source: ['n', 0] } },
    })
    expect(runnerTakesWorkflow(sync('/view?filename=face.mp4&type=input'), ON)).toBe(true)
    expect(runnerTakesWorkflow(sync('https://example.com/face.mp4'), ON)).toBe(false)
    expect(runnerTakesWorkflow(sync('https://example.com/face.mp4', 'cut_off'), ON)).toBe(true)
    expect(runnerTakesWorkflow(sync('/view?filename=face.mp4&type=input'), new Set<RunnerFamily>(['cards', 'media-sound']))).toBe(false)
  })
})

// ── 4. Prices ────────────────────────────────────────────────────────────

describe('prices: the hold is the ceiling, the charge the same calculation', () => {
  const usd = (ct: string, inputs: Record<string, unknown>, inputSeconds: Record<string, number> = {}) => {
    const p = priceNode(ct, inputs, { inputSeconds })
    if ('refused' in p) throw new Error(p.refused)
    return p.usd
  }
  const lipInputs = (model_options: string) => ({ engine: 'auto', resolution: '720p', sync_mode: 'cut_off', model_options })

  it('Fabric: the sound\'s seconds (rounded up) × the resolution\'s rate; unmeasured, 60 s', () => {
    expect(usd('LipSyncNode', lipInputs(fabricOpts()), { audio: 4.2 })).toBeCloseTo(5 * 0.08, 10)
    expect(usd('LipSyncNode', lipInputs(fabricOpts({ resolution: '720p' })), { audio: 5 })).toBeCloseTo(5 * 0.15, 10)
    expect(usd('LipSyncNode', lipInputs(fabricOpts()))).toBeCloseTo(60 * 0.08, 10)
    // What the runner sends is what is priced: "480P" goes as 480p, "1080p" as 720p.
    expect(usd('LipSyncNode', lipInputs(fabricOpts({ resolution: '480P' })), { audio: 5 })).toBeCloseTo(5 * 0.08, 10)
    expect(usd('LipSyncNode', lipInputs(fabricOpts({ resolution: '1080p' })), { audio: 5 })).toBeCloseTo(5 * 0.15, 10)
    expect(fabricLipSyncResolution(lipInputs(fabricOpts({ resolution: '1080p' })))).toBe('720p')
  })

  it('Kling: the face video\'s seconds × $0.014; unmeasured, 60 s', () => {
    expect(usd('LipSyncNode', lipInputs(klingOpts()), { video: 5 })).toBeCloseTo(5 * 0.014, 10)
    expect(usd('LipSyncNode', lipInputs(klingOpts()), { video: 4.01, audio: 30 })).toBeCloseTo(5 * 0.014, 10)
    expect(usd('LipSyncNode', lipInputs(klingOpts()))).toBeCloseTo(60 * 0.014, 10)
  })

  it('Sync lips in silence: the longer of the sound and the face video; unmeasured, refused as before; over 60 s, refused', () => {
    const s = { model: 'sync.so 2-pro', audio: ['snd', 0], video_url: '/view?filename=face.mp4&type=input', sync_mode: 'silence' }
    expect(usd('LipsyncNode', s, { audio: 2, video: 5 })).toBeCloseTo(5 * 0.08325, 10)
    expect(usd('LipsyncNode', s, { audio: 7.5, video: 5 })).toBeCloseTo(8 * 0.08325, 10)
    // A sound made in the run (not known): the 60 s ceiling.
    expect(usd('LipsyncNode', s, { videoUpTo: 5 })).toBeCloseTo(60 * 0.08325, 10)
    expect('refused' in priceNode('LipsyncNode', s, {})).toBe(true)
    // With sound-in on, an unmeasured upload is "up to" 60 s (the runner refuses longer before the hold;
    // the ComfyUI path sends the `/view` link as typed, which no provider fetches): the fail-closed check passes.
    const on = priceNode('LipsyncNode', s, { families: ON })
    expect('refused' in on ? on.refused : on.usd).toBeCloseTo(60 * 0.08325, 10)
    expect('refused' in priceNode('LipsyncNode', { ...s, video_url: 'https://example.com/f.mp4' }, { families: ON })).toBe(true)
    expect('refused' in priceNode('LipsyncNode', s, { families: new Set<RunnerFamily>(['cards', 'media-sound']) })).toBe(true)
    expect('refused' in priceNode('LipsyncNode', s, { inputSeconds: { audio: 2, video: 61 } })).toBe(true)
    // The other modes are unchanged.
    expect(usd('LipsyncNode', { ...s, sync_mode: 'cut_off' }, { audio: 2, video: 5 })).toBeCloseTo(2 * 0.08325, 10)
    expect(remoteVideoCalls('LipsyncNode', { ...s, sync_mode: 'loop' }, { audio: 2, video: 50 })).toEqual([{ endpoint: 'sync/lipsync-2-pro', seconds: 2, resolution: null, audio: false }])
  })

  it('the canvas shows silence "up to" 60 s of video on an upload (covering the hold); on a web address it can\'t be priced, as before', () => {
    const canvas = (video_url: string) => ({ id: 'n', data: { nodeType: 'LipsyncNode', widgetDefs: [{ name: 'model' }, { name: 'video_url' }, { name: 'sync_mode' }], widgetsValues: ['sync.so 2-pro', video_url, 'silence'], inputs: [] } })
    const up = upstreamInputSeconds(canvas('/view?filename=face.mp4&type=input'), [], [])
    expect(up).toEqual({ seconds: { videoUpTo: 60 }, upTo: true })
    expect(usd('LipsyncNode', { model: 'sync.so 2-pro', audio: ['snd', 0], video_url: '/view?filename=face.mp4&type=input', sync_mode: 'silence' }, up!.seconds as Record<string, number>)).toBeCloseTo(60 * 0.08325, 10)
    expect(upstreamInputSeconds(canvas('https://example.com/f.mp4'), [], [])!.seconds).toEqual({})
  })
})

// ── 5. The engine ────────────────────────────────────────────────────────

/** A 16-bit mono PCM WAV of `seconds`. */
function wav(seconds: number, rate = 8000): Buffer {
  const n = Math.round(seconds * rate)
  const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12)
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24)
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 10) * 1000), 44 + i * 2)
  return b
}

/** A picture-only MP4 whose video track lasts `seconds` (10 fps), muxed without an encoder (runner-sync-3's). */
async function mp4(seconds: number, width = 1280, height = 720): Promise<Buffer> {
  const out = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() })
  const src = new EncodedVideoPacketSource('avc')
  out.addVideoTrack(src, { frameRate: 10 })
  await out.start()
  const description = new Uint8Array([1, 0x42, 0xC0, 0x1E, 0xFF, 0xE1, 0, 0x0A, 0x67, 0x42, 0xC0, 0x1E, 0xDA, 0x02, 0x80, 0xBF, 0xE5, 0x84, 1, 0, 4, 0x68, 0xCE, 0x3C, 0x80])
  const frames = Math.round(seconds * 10)
  for (let i = 0; i < frames; i++) {
    await src.add(new EncodedPacket(new Uint8Array([0, 0, 0, 1, 0x65]), i === 0 ? 'key' : 'delta', i / 10, 0.1),
      i === 0 ? { decoderConfig: { codec: 'avc1.42c01e', codedWidth: width, codedHeight: height, description } } : undefined)
  }
  await out.finalize()
  return Buffer.from((out.target as BufferTarget).buffer!)
}

async function kitWith(hosted: boolean, files: Record<string, Uint8Array | Buffer>, families: ReadonlySet<RunnerFamily> = ON) {
  const fal = createFakeFal()
  const k = makeKit({ hosted, available: 50_000, fal, replicate: createFakeReplicate(), deps: { families: () => families } })
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(k.root, 'input', name), bytes)
  return k
}

async function runOf(k: Awaited<ReturnType<typeof kitWith>>, p: ApiPrompt) {
  const started = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
  await k.engine.settled(started.runId)
  return { ...started, run: (await k.store.get(started.runId))! }
}

describe('on the engine (fake Replicate and fal)', () => {
  for (const hosted of [false, true]) {
    it(`${hosted ? 'hosted' : 'locally'}: Fabric 480p with Load audio → Audio card: Python's WAV sent, held and charged on 4 s`, async () => {
      await requireMediaTools()
      const k = await kitWith(hosted, { 'face.png': rgbPng1x1(9, 9, 9), 'voice.wav': wav(3.5) })
      const p = node(fabricOpts({ audio: '' }), true)
      const { run, promptIds } = await runOf(k, p)
      expect(run.status, JSON.stringify(run.takes[0]?.nodes)).toBe('done')
      const sent = k.replicate.submitted()
      expect(sent.map(s => s.endpoint)).toEqual([FABRIC_LIPSYNC_SLUG])
      expect(sent[0]!.payload).toEqual({ image: 'https://fal.storage/face.png', audio: 'https://fal.storage/audio.wav', resolution: '480p' })
      const held = priceGraph(p, { families: ON, inputSeconds: { n: { audio: 3.5 } } })
      expect(held.nodes!.n).toBe(creditsForUsd(4 * 0.08))
      if (hosted) expect(k.ledger.hold).toHaveBeenCalledWith(k.userId, held.credits, `runner:${promptIds[0]}`)
      expect(run.takes[0]!.nodes.n!.credits).toBe(held.nodes!.n)
      // The badge (unmeasured: 60 s) covers the hold.
      expect(priceGraph(p, { families: ON }).credits).toBeGreaterThanOrEqual(held.credits)
    }, 60_000)

    it(`${hosted ? 'hosted' : 'locally'}: Kling with an uploaded 5 s face video and sound: held and charged on 5 s`, async () => {
      await requireMediaTools()
      const k = await kitWith(hosted, { 'face.mp4': await mp4(5), 'voice.wav': wav(2) })
      const p = node(klingOpts())
      const { run, promptIds } = await runOf(k, p)
      expect(run.status, JSON.stringify(run.takes[0]?.nodes)).toBe('done')
      const sent = k.replicate.submitted()
      expect(sent.map(s => s.endpoint)).toEqual([KLING_LIPSYNC_SLUG])
      expect(sent[0]!.payload).toEqual({ video_url: 'https://fal.storage/face.mp4', audio_file: 'https://fal.storage/voice.wav' })
      const held = priceGraph(p, { families: ON, inputSeconds: { n: { video: 5 } } })
      expect(held.nodes!.n).toBe(creditsForUsd(5 * 0.014))
      if (hosted) expect(k.ledger.hold).toHaveBeenCalledWith(k.userId, held.credits, `runner:${promptIds[0]}`)
      expect(run.takes[0]!.nodes.n!.credits).toBe(held.nodes!.n)
    }, 60_000)
  }

  it('hosted: a face video over 60 s, or a Fabric sound over 60 s, is refused before the hold', async () => {
    await requireMediaTools()
    const k = await kitWith(true, { 'face.mp4': await mp4(61), 'voice.wav': wav(61), 'face.png': rgbPng1x1(1, 1, 1) })
    await expect(k.engine.startRun({ userId: k.userId, takes: [node(klingOpts())], ...START })).rejects.toThrow(LIPSYNC_ENGINE_TOO_LONG)
    await expect(k.engine.startRun({ userId: k.userId, takes: [node(fabricOpts())], ...START })).rejects.toThrow(LIPSYNC_ENGINE_TOO_LONG)
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.replicate.submitted()).toEqual([])
  }, 60_000)

  it('Kling: an uploaded sound over 5 MB is refused before the hold', async () => {
    await requireMediaTools()
    const k = await kitWith(true, { 'face.mp4': await mp4(5), 'voice.wav': wav(320) })
    await expect(k.engine.startRun({ userId: k.userId, takes: [node(klingOpts())], ...START })).rejects.toThrow(KLING_LIPSYNC_SOUND_TOO_LARGE)
    expect(k.ledger.hold).not.toHaveBeenCalled()
  }, 60_000)

  it('Kling with Load audio → Audio card: a WAV bound over 5 MB is refused before the hold; a short one runs', async () => {
    await requireMediaTools()
    const k = await kitWith(true, { 'face.mp4': await mp4(5), 'voice.wav': wav(61, 44100), 'short.wav': wav(3) })
    const long = node(klingOpts({ audio: '' }), true)
    await expect(k.engine.startRun({ userId: k.userId, takes: [long], ...START })).rejects.toThrow(KLING_LIPSYNC_SOUND_TOO_LARGE)
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.replicate.submitted()).toEqual([])
    const short = node(klingOpts({ audio: '' }), true)
    short.snd!.inputs!.audio = 'short.wav'
    const { run } = await runOf(k, short)
    expect(run.status, JSON.stringify(run.takes[0]?.nodes)).toBe('done')
    expect(k.replicate.submitted()[0]!.payload).toEqual({ video_url: 'https://fal.storage/face.mp4', audio_file: 'https://fal.storage/audio.wav' })
  }, 60_000)

  it('Kling with a sound made in the run: bounded by its maker (R11.8, music by its duration), taken and held; one no maker bounds is still refused', async () => {
    await requireMediaTools()
    const k = await kitWith(true, { 'face.mp4': await mp4(5) }, new Set<RunnerFamily>([...ON, 'audio-gen']))
    const p = node(klingOpts({ audio: '' }), true)
    p.snd = { class_type: 'GenerateMusicNode', inputs: { model: 'MusicGen', prompt: 'calm piano', duration: 5, model_version: 'stereo-melody-large', temperature: 1, top_p: 0, seed: 0 } }
    k.replicate.holdNext(1)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    expect(k.ledger.hold).toHaveBeenCalledTimes(1)
    await k.engine.stop(k.userId)
    await k.engine.settled(runId)
    // 6 s of 32 kHz stereo as Python's 16-bit WAV is well under Kling's 5 MB; a sound no maker bounds keeps the words.
    expect(KLING_LIPSYNC_SOUND_UNSIZED).toContain('can’t tell this sound’s size before the run')
  }, 60_000)

  it('fix round 1 (I3): Kling with a cloned voice over about 26 s (its bound past 5 MB as a WAV): refused before the hold, nothing charged, as before the task', async () => {
    await requireMediaTools()
    const fams = new Set<RunnerFamily>([...ON, 'audio-gen', 'media-sound'])
    const k = await kitWith(true, { 'face.mp4': await mp4(5), 'long.wav': wav(40) }, fams)
    const p = node(klingOpts({ audio: '' }), true)
    p.la = { class_type: 'LoadAudio', inputs: { audio: 'long.wav' } }
    p.snd = {
      class_type: 'CloneSingingVoiceNode',
      inputs: {
        audio: ['la', 0], model: RVC_MODELS[0], rvc_model: RVC_PRESET_VOICES[0], custom_rvc_model_url: '', pitch_change: RVC_PITCH_CHANGES[0],
        pitch_shift_semitones: 0, pitch_detection_algorithm: RVC_PITCH_ALGORITHMS[0], output_format: 'mp3',
      },
    }
    expect(runnerTakesWorkflow(p, fams)).toBe(true)
    const err = await k.engine.startRun({ userId: k.userId, takes: [p], ...START }).catch(e => e)
    expect(err?.message).toBe(KLING_LIPSYNC_SOUND_UNSIZED)
    expect(err?.data?.reason).not.toBe(RUNNER_NOT_ELIGIBLE)
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.replicate.submitted()).toEqual([])
    // A short clone (10 s: 11 s at most, 2.1 MB as a WAV) is taken.
    writeFileSync(join(k.root, 'input', 'long.wav'), wav(10))
    k.replicate.holdNext(1)
    const started = await k.engine.startRun({ userId: k.userId, takes: [p], ...START }).catch(e => e)
    expect(started, started?.message).toHaveProperty('runId')
    await k.engine.stop(k.userId)
    await k.engine.settled(started.runId)
  }, 60_000)

  it('Stop while Kling runs (its video and WAV handed off): cancelled on Replicate, the hold released, nothing left behind', async () => {
    await requireMediaTools()
    const k = await kitWith(true, { 'face.mp4': await mp4(5), 'voice.wav': wav(3) })
    k.replicate.holdNext(1)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [node(klingOpts({ audio: '' }), true)], ...START })
    await until(() => (k.replicate.submitted()[0]?.polls ?? 0) >= 2)
    // The new uploads went out before the call: the face video and the WAV.
    expect(k.upload.mock.calls.map(c => c[1]).sort()).toEqual(['audio.wav', 'face.mp4'])
    await k.engine.stop(k.userId)
    await k.engine.settled(runId)
    expect(k.replicate.client.cancel).toHaveBeenCalledWith('replicate://pred1/cancel')
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('stopped')
    expect(run.takes[0]!.nodes.n!.status).toBe('stopped')
    expect([...k.ledger.holds.values()].map(h => h.state)).toEqual(['released'])
    // No lip-sync file, no kept WAV, no partial file: output is empty, and temp holds only the Audio card's
    // own finished preview (Python's FLAC, shown before the lip-sync started).
    const left = (dir: string) => (readdirSync(join(k.root, dir), { recursive: true }) as string[]).filter(f => /\.[a-z0-9]+$/i.test(f))
    expect(left('output')).toEqual([])
    expect(left('temp').map(f => f.replace(/^.*\//, '').replace(/_[a-z0-9]+_\d+_\./, '_*.'))).toEqual(['ComfyUI_temp_*.flac'])
    expect(run.takes[0]!.nodes.card!.status).toBe('done')
    expect(k.upload).toHaveBeenCalledTimes(2)
  }, 60_000)

  it('sync-3 with Load audio → Audio card (R5.3 case A): Python\'s WAV sent, charged on the measured sound', async () => {
    await requireMediaTools()
    const k = await kitWith(true, { 'face.mp4': await mp4(5), 'voice.wav': wav(2.5) }, ON_SYNC3)
    const p = node(klingOpts({ engine: 'sync-3', audio: '', sync_mode: 'loop' }), true)
    p.n!.inputs!.engine = 'sync-3'
    p.n!.inputs!.sync_mode = 'loop'
    const { run } = await runOf(k, p)
    expect(run.status, JSON.stringify(run.takes[0]?.nodes)).toBe('done')
    const sent = k.fal.submitted()
    expect(sent.map(s => s.endpoint)).toEqual(['fal-ai/sync-lipsync/v3'])
    expect(sent[0]!.payload).toEqual({ video_url: 'https://fal.storage/face.mp4', audio_url: 'https://fal.storage/audio.wav', sync_mode: 'loop' })
    const held = priceGraph(p, { families: ON_SYNC3, inputSeconds: { n: { audio: 2.5, video: 5 } } })
    expect(run.takes[0]!.nodes.n!.credits).toBe(held.nodes!.n)
    expect(held.nodes!.n).toBe(creditsForUsd(3 * 8 / 60))
  }, 60_000)

  describe('Sync lips in silence', () => {
    const sync = (): ApiPrompt => ({
      snd: { class_type: 'LoadAudio', inputs: { audio: 'voice.wav' } },
      n: { class_type: 'LipsyncNode', inputs: { model: 'sync.so 2-pro', audio: ['snd', 0], video_url: '/view?filename=face.mp4&type=input', sync_mode: 'silence' } },
      v: { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'v', source: ['n', 0] } },
    })
    for (const hosted of [false, true]) {
      it(`${hosted ? 'hosted' : 'locally'}: the upload handed off, held and charged on the 5 s video (the longer)`, async () => {
        await requireMediaTools()
        const k = await kitWith(hosted, { 'face.mp4': await mp4(5), 'voice.wav': wav(2) })
        const { run, promptIds } = await runOf(k, sync())
        expect(run.status, JSON.stringify(run.takes[0]?.nodes)).toBe('done')
        const sent = k.replicate.submitted()
        expect(sent.map(s => s.endpoint)).toEqual(['sync/lipsync-2-pro'])
        expect(sent[0]!.payload).toEqual({ video: 'https://fal.storage/face.mp4', audio: 'https://fal.storage/audio.wav', sync_mode: 'silence' })
        const held = priceGraph(sync(), { families: ON, inputSeconds: { n: { audio: 2, video: 5 } } })
        expect(held.nodes!.n).toBe(creditsForUsd(5 * 0.08325))
        if (hosted) expect(k.ledger.hold).toHaveBeenCalledWith(k.userId, held.credits, `runner:${promptIds[0]}`)
        expect(run.takes[0]!.nodes.n!.credits).toBe(held.nodes!.n)
      }, 60_000)
    }

    it('a face video over 60 s is refused before the hold', async () => {
      await requireMediaTools()
      const k = await kitWith(true, { 'face.mp4': await mp4(61), 'voice.wav': wav(2) })
      await expect(k.engine.startRun({ userId: k.userId, takes: [sync()], ...START })).rejects.toThrow(LIPSYNC_SILENCE_TOO_LONG)
      expect(k.ledger.hold).not.toHaveBeenCalled()
    }, 60_000)

    it('the check measures the video (and the sound) the price reads', async () => {
      await requireMediaTools()
      const v = await mp4(5)
      const c = await nodeMediaCheck(sync(), 'n', {
        read: async () => new Uint8Array(v), strict: true,
        soundWav: async () => ({ wav: new Uint8Array(wav(2)), seconds: 2, frames: 16000, rate: 8000, channels: 1 }) as never,
      })
      expect(c).toMatchObject({ problem: null, measured: { seconds: { audio: 2, video: 5 } } })
    }, 60_000)
  })
})
