/**
 * Task 3 (non-commercial face models replacement): Person swap (video) on
 * fal's Pixverse Swap, family `person-swap-video` (server/runner/generators/pixverseSwap.ts):
 * the video half of the retired InsightFace face swap, built like the
 * topaz-video family (a measured-video node: read + measure the video
 * before the hold, price from the measurement).
 *
 * PersonSwapVideoNode moves the whole node class (eligibility.ts
 * RunnerNodeRule.upgrade), the same pattern as Face swap (Task 2): while the
 * family is on, every Person swap (video) node runs Pixverse Swap's person
 * mode, in the runner only (Ruling 10). Off, the node's Python definition
 * (comfy_extras/nodes_face.py) is definition-only and always fails plainly:
 * there is no ComfyUI path at all.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BufferTarget, EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output } from 'mediabunny'
import sharp from 'sharp'
import type { ApiPrompt } from '#shared/runner/graph'
import { NO_FAMILIES, RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { RUNNER_NODE_RULES, classUpgradeOn, isRunnerEligible, runnerTakesNode } from '#shared/runner/eligibility'
import {
  PERSON_SWAP_MAX_SECONDS, PERSON_SWAP_RESOLUTIONS, PERSON_SWAP_TOO_LONG, PERSON_SWAP_UNKNOWN_SETTING,
  PIXVERSE_SWAP_ENDPOINT, personSwapRateKey, personSwapResolution,
} from '#shared/runner/personSwapVideo'
import { VIEW_REF_REFUSED, personSwapVideoUsd } from '#shared/pricing/clipSettings'
import { FAMILY_PRICED_CLASSES, familyPricedClass, priceNode } from '#shared/pricing/nodePrice'
import { planNode, type NodePlan } from '~~/server/runner/executors'
import {
  PERSON_SWAP_NEEDS_VIDEO, PERSON_SWAP_NOT_A_FILE, pixverseSwap, pixverseSwapNodeProblem, pixverseSwapSource,
} from '~~/server/runner/generators/pixverseSwap'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import {
  PERSON_SWAP_CHANGED, PERSON_SWAP_FILE_MISSING, PERSON_SWAP_MAX_BYTES, PERSON_SWAP_RULE, personSwapInputFiles, personSwapMediaCheck,
} from '~~/server/runner/personSwapMedia'
import { mediaNodeKind, nodeMediaChangedWords, nodeMediaFiles } from '~~/server/runner/nodeMedia'
import { requestProblems } from '~~/server/runner/requestRules'
import { createEngineResultStore } from '~~/server/runner/results'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import { makeKit, ofType, until } from './__runner__/kit'
import type { OutputFile } from '~~/server/runner/types'
import { buildTake, takeHasContent } from '~/composables/useTakes'

const FAMILY: RunnerFamily = 'person-swap-video'
const ON: ReadonlySet<RunnerFamily> = new Set([FAMILY])
const ALL: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES)
const ALL_BUT: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES.filter(f => f !== FAMILY))
const SCHEMA = loadProviderSchema('fal', PIXVERSE_SWAP_ENDPOINT)
const CLIP_VIEW = '/view?filename=clip.mp4&type=input'

/** A picture-only MP4 whose video track lasts `seconds`, muxed without an encoder (same recipe as runner-topaz-video.unit.spec.ts). */
async function mp4(seconds: number, width = 1280, height = 720, fps = 24): Promise<Buffer> {
  const out = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() })
  const src = new EncodedVideoPacketSource('avc')
  out.addVideoTrack(src, { frameRate: fps })
  await out.start()
  const description = new Uint8Array([1, 0x42, 0xC0, 0x1E, 0xFF, 0xE1, 0, 0x0A, 0x67, 0x42, 0xC0, 0x1E, 0xDA, 0x02, 0x80, 0xBF, 0xE5, 0x84, 1, 0, 4, 0x68, 0xCE, 0x3C, 0x80])
  const frames = Math.round(seconds * fps)
  for (let i = 0; i < frames; i++) {
    await src.add(new EncodedPacket(new Uint8Array([0, 0, 0, 1, 0x65]), i === 0 ? 'key' : 'delta', i / fps, 1 / fps),
      i === 0 ? { decoderConfig: { codec: 'avc1.42c01e', codedWidth: width, codedHeight: height, description } } : undefined)
  }
  await out.finalize()
  return Buffer.from((out.target as BufferTarget).buffer!)
}

/** A 16-bit mono PCM WAV of `seconds` (a file that isn't a video). */
function wav(seconds: number, rate = 8000): Buffer {
  const n = Math.round(seconds * rate)
  const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12)
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24)
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40)
  return b
}

/** A PersonSwapVideo node as the canvas sends it, its default resolution unless told. */
function node(inputs: Record<string, unknown> = {}) {
  return { class_type: 'PersonSwapVideo', inputs: { image: ['1', 0], video_url: CLIP_VIEW, resolution: '720p', ...inputs } }
}
const imageCard = () => ({ class_type: 'Image', inputs: { image: 'person.png' } })

async function plan(n = node(), measured: Record<string, number | null> | null = { video: 3 }): Promise<Extract<NodePlan, { kind: 'provider' }>> {
  const p = await planNode({
    prompt: { 1: imageCard(), 2: n }, nodeId: '2', gateOpen: false,
    filesFrom: () => [{ filename: 'person.png', subfolder: '', type: 'output' }],
    toUrl: async (f: OutputFile) => `https://fal.storage/${f.filename}`, families: ON,
    ...(measured ? { measured } : {}),
  })
  if (p.kind !== 'provider') throw new Error('no call')
  return p
}

describe('the saved schema and the route', () => {
  it('fal-ai/pixverse/swap, read 2026-09-27, with fal\'s pricing text', () => {
    expect(PIXVERSE_SWAP_ENDPOINT).toBe('fal-ai/pixverse/swap')
    expect(SCHEMA.endpoint).toBe(PIXVERSE_SWAP_ENDPOINT)
    expect(SCHEMA.pricingText).toContain('$0.15** for 360p and 540p')
  })

  it('the route: fal first, no backup, and why', () => {
    expect(RUNNER_ROUTES['PersonSwapVideo+person-swap-video']!.first).toBe('fal')
    expect(RUNNER_ROUTES['PersonSwapVideo+person-swap-video']!.backup).toBeNull()
    expect(RUNNER_ROUTES['PersonSwapVideo+person-swap-video']!.why).toContain('Pixverse Swap')
  })
})

describe('the result on its own node', () => {
  it('a lone Person swap node shows the swapped video as a take (the Video card\'s shape)', async () => {
    const p = await plan()
    const clip: OutputFile = { filename: 'person_swap_video_00001_.mp4', subfolder: '', type: 'output' }
    const ui = p.uiFor([clip])
    expect(ui).toEqual({ images: [clip], animated: [true] })
    const take = buildTake('prompt-1', ui, f => `/view?filename=${f.filename}`)
    expect(takeHasContent(take)).toBe(true)
    expect(take.images).toEqual(['/view?filename=person_swap_video_00001_.mp4'])
    expect(take.animated).toBe(true)
  })
})

describe('the request', () => {
  it('sends the video, the person and person mode, keeping the sound', () => {
    const call = pixverseSwap({ videoUrl: 'https://x/v.mp4', imageUrl: 'https://x/p.png', resolution: '540p' })
    expect(call).toEqual({
      provider: 'fal', endpoint: 'fal-ai/pixverse/swap',
      payload: { video_url: 'https://x/v.mp4', image_url: 'https://x/p.png', mode: 'person', resolution: '540p', original_sound_switch: true },
    })
    expect(checkPayload(SCHEMA, call.payload)).toEqual([])
  })

  it('every resolution fits the schema', async () => {
    for (const resolution of PERSON_SWAP_RESOLUTIONS) {
      const p = await plan(node({ resolution }))
      expect(p.provider).toBe('fal')
      expect(p.endpoint).toBe(PIXVERSE_SWAP_ENDPOINT)
      expect(p.media).toBe('video')
      expect(p.backup).toBeUndefined()
      expect(checkPayload(SCHEMA, p.payload)).toEqual([])
      expect(p.payload).toEqual({
        video_url: 'https://fal.storage/clip.mp4', image_url: 'https://fal.storage/person.png',
        mode: 'person', resolution, original_sound_switch: true,
      })
    }
  })

  it('the video from Sailor\'s files (the /view link\'s input file), handed off', async () => {
    const n = node({ video_url: '/view?filename=holiday%20clip.mov&type=input&subfolder=' })
    expect(pixverseSwapSource({ 2: n }, '2')).toEqual({ file: { filename: 'holiday clip.mov', subfolder: '', type: 'input' } })
    const handed: OutputFile[] = []
    const p = await planNode({
      prompt: { 1: imageCard(), 2: n }, nodeId: '2', gateOpen: false,
      filesFrom: () => [{ filename: 'person.png', subfolder: '', type: 'output' }], families: ON, measured: { video: 3 },
      toUrl: async (f) => { handed.push(f); return f.filename === 'holiday clip.mov' ? 'https://fal.storage/holiday-clip.mov' : 'https://fal.storage/person.png' },
    })
    expect(handed.map(f => f.filename)).toContain('holiday clip.mov')
    expect((p as any).payload.video_url).toBe('https://fal.storage/holiday-clip.mov')
  })

  it('never planned without a video, or with a web link', async () => {
    await expect(plan(node({ video_url: 'https://example.com/a.mp4' }))).rejects.toThrow(PERSON_SWAP_NOT_A_FILE)
    await expect(plan(node({ video_url: '' }))).rejects.toThrow(PERSON_SWAP_NEEDS_VIDEO)
  })

  it('refuses a web link, a missing video and an unknown resolution before the hold', () => {
    expect(pixverseSwapNodeProblem({ 2: node({ video_url: 'https://example.com/a.mp4' }) }, '2')?.input).toBe('video_url')
    expect(pixverseSwapNodeProblem({ 2: node({ video_url: '' }) }, '2')?.input).toBe('video_url')
    expect(pixverseSwapNodeProblem({ 2: node({ resolution: '1080p' }) }, '2')?.input).toBe('resolution')
    expect(pixverseSwapNodeProblem({ 2: node({}) }, '2')).toBeNull()
  })

  it('a link that names its file twice is refused plainly', () => {
    expect(pixverseSwapNodeProblem({ 2: node({ video_url: '/view?filename=a.mp4&filename=b.mp4&type=input' }) }, '2')).toEqual({ input: 'video_url', message: VIEW_REF_REFUSED })
  })

  it('the node without its own family (ComfyUI path): none of these before-the-hold checks apply', () => {
    expect(requestProblems({ 1: imageCard(), 2: node({ video_url: 'https://example.com/a.mp4' }) })).toEqual([])
  })
})

describe('the price', () => {
  const usd = (resolution: string, video?: number) => personSwapVideoUsd({ resolution }, video === undefined ? {} : { video })

  it('prices by resolution, doubled over 5 s', () => {
    expect(usd('360p', 5)).toBeCloseTo(usd('540p', 5) as number)
    expect(usd('720p', 5)).toBeGreaterThan(usd('540p', 5) as number)
    expect(usd('720p', 5.01)).toBeCloseTo((usd('720p', 5) as number) * 2)
    expect(usd('720p', 5)).toBeCloseTo(usd('720p', 4))
    expect(usd('720p')).toBeCloseTo(usd('720p', PERSON_SWAP_MAX_SECONDS)) // unmeasured = the ceiling
    expect(personSwapRateKey('720p', 6)).toBe('720p/long')
  })

  it('exact table figures at 5 s: $0.15 / $0.15 / $0.20', () => {
    expect(usd('360p', 5)).toBeCloseTo(0.15)
    expect(usd('540p', 5)).toBeCloseTo(0.15)
    expect(usd('720p', 5)).toBeCloseTo(0.20)
    expect(usd('720p', 6)).toBeCloseTo(0.40)
  })

  it('a measured 5.0000001 s is 5 s (the base price), as a 10.0000001 s is 10 s (allowed)', () => {
    expect(personSwapRateKey('720p', 5.0000001)).toBe('720p')
    expect(usd('720p', 5.0000001)).toBe(usd('720p', 5))
    expect(usd('720p', 5.0000001)).toBeCloseTo(0.20)
    expect(usd('720p', 10.0000001)).toBeCloseTo(0.40)
  })

  it('an unknown resolution is refused', () => {
    expect(personSwapVideoUsd({ resolution: '1080p' })).toEqual({ refused: PERSON_SWAP_UNKNOWN_SETTING })
    expect(personSwapResolution({ resolution: '1080p' })).toBeNull()
    expect(personSwapResolution({})).toBe('720p')
  })

  it('over the 10 s cap is refused', () => {
    expect(personSwapVideoUsd({ resolution: '720p' }, { video: 11 })).toEqual({ refused: PERSON_SWAP_TOO_LONG })
  })

  it('FAMILY_PRICED_CLASSES carries both topaz-video and person-swap-video', () => {
    expect(FAMILY_PRICED_CLASSES).toEqual({ EnhanceVideoNode: 'topaz-video', PersonSwapVideo: 'person-swap-video' })
    expect(familyPricedClass('PersonSwapVideo', ON)).toBe(true)
    expect(familyPricedClass('PersonSwapVideo', NO_FAMILIES)).toBe(false)
    expect(familyPricedClass('PersonSwapVideo', ALL_BUT)).toBe(false)
  })

  it('priceNode dispatches to it while the family is on; refused (no flat fallback) while off', () => {
    const price = priceNode('PersonSwapVideo', { resolution: '720p' }, { inputSeconds: { video: 3 }, families: ON })
    expect(price).toEqual({ usd: 0.20, credits: expect.any(Number) })
    expect(priceNode('PersonSwapVideo', { resolution: '720p' }, { inputSeconds: { video: 3 }, families: NO_FAMILIES }))
      .toEqual({ refused: 'not a model-priced class' })
  })
})

describe('eligibility', () => {
  const alone = (n = node()): ApiPrompt => ({ 1: imageCard(), 2: n })

  it('the row: moved by person-swap-video (Ruling 10), the video_url and resolution widgets required', () => {
    const rule = RUNNER_NODE_RULES.PersonSwapVideo!
    expect(rule.family).toBeUndefined()
    expect(rule.models).toBeUndefined()
    expect(rule.upgrade).toEqual({ family: 'person-swap-video', label: 'Person swap (video)' })
    expect(classUpgradeOn('PersonSwapVideo', ON)).toEqual(rule.upgrade)
    expect(classUpgradeOn('PersonSwapVideo', ALL_BUT)).toBeNull()
  })

  it('on: taken; off (no families, or every other one): not', () => {
    expect(isRunnerEligible(alone(), ON)).toBe(true)
    expect(isRunnerEligible(alone(), ALL)).toBe(true)
    expect(isRunnerEligible(alone(), NO_FAMILIES)).toBe(false)
    expect(isRunnerEligible(alone(), ALL_BUT)).toBe(false)
  })

  it('what it reads before the run must not be wired', () => {
    for (const name of ['video_url', 'resolution']) {
      const p = { ...alone(node({ [name]: ['5', 0] })), 5: { class_type: 'PrimitiveString', inputs: { value: 'x' } } }
      expect(runnerTakesNode(p, '2', ALL), name).toBe(false)
    }
    expect(runnerTakesNode(alone(node({ resolution: '1080p' })), '2', ALL)).toBe(false)
  })
})

describe('the video: read, measured and judged (personSwapMediaCheck)', () => {
  const file = (bytes: Buffer | null, size?: number | null) => {
    const read = vi.fn(async () => { if (!bytes) throw new Error('gone'); return new Uint8Array(bytes) })
    return { read, ...(size !== undefined ? { size: async () => size } : {}), strict: false }
  }

  it('the rule: MP4, MOV or WebM, 100 MB, 4K', () => {
    expect(PERSON_SWAP_RULE).toMatchObject({ kind: 'video', formats: ['mp4', 'mov', 'webm'], maxBytes: 100_000_000, maxLongSide: 4096, maxShortSide: 2160 })
    expect(PERSON_SWAP_RULE.frameRate).toBeUndefined()
    expect(PERSON_SWAP_MAX_BYTES).toBe(100_000_000)
  })

  it('fits: the file, what was measured (with the sha256 of the bytes)', async () => {
    const bytes = await mp4(3, 1280, 720, 24)
    const c = await personSwapMediaCheck({ 2: node() }, '2', file(bytes))
    if (c.problem !== null) throw new Error(c.problem)
    expect(c.video).toEqual({ filename: 'clip.mp4', subfolder: '', type: 'input' })
    expect(c.measured.seconds.video).toBeCloseTo(3, 1)
    expect(c.measured.sha.video).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refused plainly: too long, the wrong format, too big (never read), missing, too large in pixels', async () => {
    expect(await personSwapMediaCheck({ 2: node() }, '2', file(await mp4(11, 640, 360, 10)))).toEqual({ problem: PERSON_SWAP_TOO_LONG })
    expect(await personSwapMediaCheck({ 2: node() }, '2', file(wav(3)))).toEqual({ problem: PERSON_SWAP_RULE.words.wrongFormat })
    const big = file(await mp4(1), PERSON_SWAP_MAX_BYTES + 1)
    expect(await personSwapMediaCheck({ 2: node() }, '2', big)).toEqual({ problem: PERSON_SWAP_RULE.words.tooLarge })
    expect(big.read.mock.calls.length).toBe(0)
    expect(await personSwapMediaCheck({ 2: node() }, '2', file(null))).toEqual({ problem: PERSON_SWAP_FILE_MISSING })
    expect(await personSwapMediaCheck({ 2: node() }, '2', file(await mp4(1, 4096, 2304, 10)))).toEqual({ problem: PERSON_SWAP_RULE.words.tooManyPixels })
  })

  it('the media node dispatch: person-swap-video is its own kind; the files for the ownership check; the change words', () => {
    expect(mediaNodeKind(node())).toBe('person-swap-video')
    expect(nodeMediaFiles({ 2: node() }, '2')).toEqual([{ filename: 'clip.mp4', subfolder: '', type: 'input' }])
    expect(personSwapInputFiles({ 2: node({ video_url: 'https://x' }) }, '2')).toEqual([])
    expect(nodeMediaChangedWords(node())).toBe(PERSON_SWAP_CHANGED)
  })
})

// ── The engine, end to end ─────────────────────────────────────────────────

const PERSON_PNG = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#808080' } }).png().toBuffer()

describe('the runner engine', () => {
  const take: ApiPrompt = {
    11: { class_type: 'Image', inputs: { image: 'person.png' } },
    1: { class_type: 'PersonSwapVideo', inputs: { image: ['11', 0], video_url: CLIP_VIEW, resolution: '720p' } },
  }

  const kitWith = async (o: { families?: ReadonlySet<RunnerFamily>, later?: Record<string, Buffer> } = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'person-swap-engine-'))
    for (const t of ['input', 'output', 'temp']) mkdirSync(join(root, t), { recursive: true })
    writeFileSync(join(root, 'input', 'clip.mp4'), await mp4(3, 1280, 720, 24))
    writeFileSync(join(root, 'input', 'person.png'), PERSON_PNG)
    const store = createEngineResultStore({ dirForType: t => join(root, t), hosted: () => true })
    const reads = new Map<string, number>()
    const results = {
      ...store,
      read: async (f: OutputFile) => {
        const n = (reads.get(f.filename) ?? 0) + 1
        reads.set(f.filename, n)
        if (n > 1 && o.later?.[f.filename]) return new Uint8Array(o.later[f.filename]!)
        return store.read(f)
      },
    }
    return { k: makeKit({ hosted: true, deps: { families: () => o.families ?? ON, results } }), reads }
  }

  const start = (k: ReturnType<typeof makeKit>) =>
    k.engine.startRun({ userId: k.userId, takes: [take], workflow: null, canvasId: null, projectUuid: null, projectName: null })
  const done = (k: ReturnType<typeof makeKit>) =>
    until(() => ofType(k.seen, 'execution_success').length + ofType(k.seen, 'execution_error').length >= 1)

  for (const [name, families] of [['the family alone', ON], ['every family', ALL]] as const) {
    it(`${name}: the family's own fal endpoint, held and charged`, async () => {
      const { k } = await kitWith({ families })
      await start(k)
      await done(k)
      expect(ofType(k.seen, 'execution_error')).toEqual([])
      const sent = k.fal.submitted()
      expect(sent.map(r => r.endpoint)).toEqual([PIXVERSE_SWAP_ENDPOINT])
      expect(sent[0]!.payload).toEqual({
        video_url: 'https://fal.storage/clip.mp4', image_url: 'https://fal.storage/person.png',
        mode: 'person', resolution: '720p', original_sound_switch: true,
      })
      expect(checkPayload(SCHEMA, sent[0]!.payload)).toEqual([])
      // 3 s at 720p: under 5 s, the base rate, $0.20 → some positive credit hold, settled at the same figure.
      const holds = [...k.ledger.holds.values()]
      expect(holds.length).toBe(1)
      expect(holds[0]!.credits).toBe(holds[0]!.actual)
    })
  }

  it('off (every other family on): refused, nothing held or sent', async () => {
    const { k } = await kitWith({ families: ALL_BUT })
    await expect(start(k)).rejects.toBeTruthy()
    expect(k.fal.reqs.size).toBe(0)
    expect(k.ledger.holds.size).toBe(0)
  })

  it('a video that changed after the run started fails the node before the hand-off; the hold is released', async () => {
    const { k } = await kitWith({ later: { 'clip.mp4': await mp4(3, 1920, 1080, 24) } })
    await start(k)
    await done(k)
    expect(JSON.stringify(ofType(k.seen, 'execution_error'))).toContain(PERSON_SWAP_CHANGED)
    expect(k.fal.reqs.size).toBe(0)
    expect([...k.ledger.holds.values()].map(h => h.state)).toEqual(['released'])
  })
})
