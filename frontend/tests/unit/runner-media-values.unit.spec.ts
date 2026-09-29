/**
 * Task R5.2: video, frame batches and sound between runner nodes
 * (server/media/values.ts; the `frames` and `video` values; kept `.mkv` and
 * `.wav` files by path). No user-facing class makes these values yet, so
 * stand-in classes play them (the vi.mock pattern of
 * runner-value-results.unit.spec.ts): TestFramesMaker hands on a frame
 * batch, TestVideoMaker a made video, TestFramesReader reads either. The
 * stand-ins' rows are added to the real tables before any module reads them;
 * no saved project names them, so the families-off invariant below runs over
 * the real graphs untouched.
 *
 * The parity parts need the real tools (R5.1a): they fail, never skip, when
 * the tools are missing.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeKit } from './__runner__/kit'
import { synth } from './__runner__/effectsParity'
import { clipPath, mediaFixture, requireMediaTools, sha256Hex, smoothFrame, soundBytes, type DecodeCase, type PySound } from './__runner__/mediaParity'
import { GATE_CLASS, type ApiPrompt } from '#shared/runner/graph'
import { BASE_VALUE_INPUTS, VALUE_KINDS_ALL, type ValueKind } from '#shared/runner/values'
import { RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { isRunnerEligible, outputKindsFor, runnerTakesNode, valueWiresAllowed } from '#shared/runner/eligibility'
import { runnerTakesWorkflow } from '#shared/runner/validate'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { MEDIA_WORDS } from '#shared/runner/media'
import { filesOf, withWiredValues } from '~~/server/runner/values'
import { KEPT_GONE, KEPT_TOO_MUCH, createFileKeptBytes, createMemoryKeptBytes, withRunCap } from '~~/server/runner/keptBytes'
import { createEngineResultStore } from '~~/server/runner/results'
import { createFileAccess } from '~~/server/runner/fileAccess'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'
import { decodeAudio, decodeFrames, type DecodedSound } from '~~/server/media/decode'
import { PYAV_H264_DEFAULT, encodeVideo, pyStreamRate } from '~~/server/media/encode'
import {
  SOUND_DOWNLOAD_CLASSES, dropVideoFile, keepFrames, keepSound, madeVideoSoundCut, readFrames, readSound, soundNoteOf, videoFileFor,
  type MediaValueIO,
} from '~~/server/media/values'

// ── The stand-ins ────────────────────────────────────────────────────────────

const MAKER = 'TestFramesMaker'
const VIDEO_MAKER = 'TestVideoMaker'
const READER = 'TestFramesReader'
const STAND_INS = [MAKER, VIDEO_MAKER, READER]

vi.mock('#shared/runner/values', async (importOriginal) => {
  const real = await importOriginal<typeof import('#shared/runner/values')>()
  // Added to the real table before eligibility.ts copies it (its OUTPUT_KINDS_BASE).
  Object.assign(real.OUTPUT_KINDS, { TestFramesMaker: { 0: 'frames' }, TestVideoMaker: { 0: 'video' } })
  return real
})

vi.mock('#shared/runner/eligibility', async (importOriginal) => {
  const real = await importOriginal<typeof import('#shared/runner/eligibility')>()
  Object.assign(real.RUNNER_NODE_RULES, {
    TestFramesMaker: { family: 'cards', local: 'render' },
    TestVideoMaker: { family: 'cards', local: 'render' },
    TestFramesReader: { family: 'cards', local: 'render', mustLink: ['frames'], valueInputs: { frames: ['frames', 'video'] } },
  })
  for (const c of ['TestFramesMaker', 'TestVideoMaker', 'TestFramesReader']) (real.LOCAL_RENDER_TYPES as Set<string>).add(c)
  return real
})

// Every stand-in (and a Gate carrying `test_keep`) counts as an output for ComfyUI's pruning.
vi.mock('#shared/runner/validate', async (importOriginal) => {
  const real = await importOriginal<typeof import('#shared/runner/validate')>()
  const { pruneWithStandIns } = await import('./__runner__/standIns')
  return {
    ...real,
    pruneInvalidOutputs: (p: ApiPrompt, f?: Parameters<typeof real.pruneInvalidOutputs>[1]) =>
      pruneWithStandIns(real.pruneInvalidOutputs, p, f, n => n.class_type.startsWith('Test') || n.inputs?.test_keep === true),
  }
})

/** The caps as a test sets them (the real ones by default). */
const CAPS = vi.hoisted(() => ({ over: { local: {} as Record<string, number>, hosted: {} as Record<string, number> } }))
vi.mock('#shared/runner/media', async (importOriginal) => {
  const real = await importOriginal<typeof import('#shared/runner/media')>()
  return {
    ...real,
    MEDIA_CAPS: {
      get local() { return { ...real.MEDIA_CAPS.local, ...CAPS.over.local } },
      get hosted() { return { ...real.MEDIA_CAPS.hosted, ...CAPS.over.hosted } },
    },
  }
})

/** The frames each stand-in maker hands on: `count` smooth frames of w × h, from frame `seed`. */
function makerFrames(w: number, h: number, count: number, seed: number): Uint8Array[] {
  return Array.from({ length: count }, (_, i) => smoothFrame(w, h, seed + i))
}
async function* stream(list: Uint8Array[]): AsyncIterable<Uint8Array> { for (const f of list) yield f }

/** A made video's sound: a stereo tone of `n` samples at `rate` (a fixed formula). */
function tone(rate: number, n: number, channels = 2): DecodedSound {
  return {
    rate,
    channels: Array.from({ length: channels }, (_, c) => Float32Array.from({ length: n }, (_, i) => Math.fround(0.5 * Math.sin((2 * Math.PI * (220 * (c + 1)) * i) / rate)))),
  }
}

vi.mock('~~/server/runner/executors', async (importOriginal) => {
  const real = await importOriginal<typeof import('~~/server/runner/executors')>()
  const media = await import('~~/server/media/values')
  const { isLink } = await import('#shared/runner/graph')
  return {
    ...real,
    planNode: async (ctx: Parameters<typeof real.planNode>[0]) => {
      const n = ctx.prompt[ctx.nodeId]!
      const i = n.inputs as Record<string, number>
      if (n.class_type === 'TestFramesMaker' || n.class_type === 'TestVideoMaker') {
        return {
          kind: 'derive' as const,
          derive: async (io: Parameters<Extract<Awaited<ReturnType<typeof real.planNode>>, { kind: 'derive' }>['derive']>[0]) => {
            const m = io.media!
            const frames = await media.keepFrames(m.runId, stream(makerFrames(i.w!, i.h!, i.count!, i.seed!)), i.w!, i.h!, m)
            if (n.class_type === 'TestFramesMaker') return { values: { 0: frames }, ui: null }
            const sound = await media.keepSound(m.runId, tone(i.rate!, i.samples!), m.kept) as Extract<RunnerValue, { kind: 'files' }>
            const video: RunnerValue = {
              kind: 'video', frames: { file: frames.file, count: frames.count, w: frames.w, h: frames.h }, fps: i.fps!,
              sound: { file: sound.files[0]!, note: sound.sound! },
            }
            return { values: { 0: video }, ui: null }
          },
        }
      }
      if (n.class_type === 'TestFramesReader') {
        return {
          kind: 'derive' as const,
          derive: async (io: Parameters<Extract<Awaited<ReturnType<typeof real.planNode>>, { kind: 'derive' }>['derive']>[0]) => {
            const link = n.inputs.frames
            const v = isLink(link) ? ctx.valueFrom?.(link) : undefined
            if (!v) throw new Error('no value')
            const m = io.media!
            const hashes: string[] = []
            if (v.kind === 'frames') {
              await media.readFrames(v, m, async (rgb) => { hashes.push(createHash('sha256').update(rgb).digest('hex')) })
            }
            else {
              const f = await media.videoFileFor(v, m)
              hashes.push(createHash('sha256').update(readFileSync(f.path)).digest('hex'))
              await media.dropVideoFile(f)
            }
            return { values: { 0: { kind: 'text' as const, text: hashes.join(',') } }, ui: null }
          },
        }
      }
      return real.planNode(ctx)
    },
  }
})

// ── Helpers ──────────────────────────────────────────────────────────────────

const CARDS: ReadonlySet<RunnerFamily> = new Set(['cards'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const LONG = { timeout: 120_000 }
const BIG = Number.MAX_SAFE_INTEGER

const scratch = mkdtempSync(join(tmpdir(), 'media-values-spec-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
beforeEach(() => { CAPS.over = { local: {}, hosted: {} } })

const maker = (o: { w?: number; h?: number; count?: number; seed?: number } = {}) =>
  ({ class_type: MAKER, inputs: { w: o.w ?? 32, h: o.h ?? 24, count: o.count ?? 4, seed: o.seed ?? 3 } })
const videoMaker = (o: { fps?: number; rate?: number; samples?: number } = {}) =>
  ({ class_type: VIDEO_MAKER, inputs: { w: 32, h: 24, count: 5, seed: 11, fps: o.fps ?? 12.5, rate: o.rate ?? 44100, samples: o.samples ?? 30000 } })
const gate = (from: string, bypass: boolean) => ({ class_type: GATE_CLASS, inputs: { data_in: [from, 0], bypass, test_keep: true } })
const reader = (from: string) => ({ class_type: READER, inputs: { frames: [from, 0] } })
const saveImage = (from: string) => ({
  class_type: 'SaveImage',
  inputs: { images: [from, 0], filename_prefix: 'ComfyUI', format: 'png', quality: 90, lossless_webp: true, png_compression: 6, scale: 1, max_dimension: 0, embed_metadata: true },
})

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
/** A well-formed run id (store.ts isRunId), the n-th of this spec. */
const rid = (n: number) => `run_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

/** A kit on `cards` whose kept store is a real folder beside its run store (as the server's). */
function kit(o: { hosted?: boolean; dir?: string; root?: string } = {}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'media-values-runs-'))
  const kept = createFileKeptBytes(join(dir, 'runner-kept'))
  const k = makeKit({ hosted: o.hosted, dir, root: o.root, deps: { families: () => CARDS, kept } })
  return { ...k, kept, keptDir: join(dir, 'runner-kept') }
}

/** Media IO over a kit's stores, as the engine builds it for a node. */
function ioOf(k: ReturnType<typeof kit>, runId: string, hosted = false): MediaValueIO {
  const results = createEngineResultStore({ dirForType: t => join(k.root, t), hosted: () => hosted })
  return { access: createFileAccess(results, k.kept), kept: k.kept, runId, userId: null, hosted }
}

// ── Eligibility and wires ────────────────────────────────────────────────────

describe('the new kinds on wires', () => {
  const p = (via: 'direct' | 'gate'): ApiPrompt => via === 'gate'
    ? { m: maker(), g: gate('m', true), r: reader('g') }
    : { m: maker(), r: reader('m') }

  it('a Gate hands frames and videos on (VALUE_KINDS_ALL); a reader that lists them takes them', () => {
    expect(VALUE_KINDS_ALL).toEqual(expect.arrayContaining(['frames', 'video']))
    expect(BASE_VALUE_INPUTS[GATE_CLASS]!.data_in).toEqual(expect.arrayContaining(['files', 'frames', 'video']))
    for (const via of ['direct', 'gate'] as const) {
      expect(runnerTakesWorkflow(p(via), CARDS), via).toBe(true)
      for (const id of Object.keys(p(via))) expect(runnerTakesNode(p(via), id, CARDS), `${via} ${id}`).toBe(true)
    }
    const v: ApiPrompt = { m: videoMaker(), g: gate('m', true), r: reader('g') }
    expect(runnerTakesWorkflow(v, CARDS)).toBe(true)
  })

  it('a Save image reading a frames slot (directly or through a Gate) leaves the workflow to the engine, and nodesNeedingEngine names it', () => {
    for (const graph of [{ m: maker(), s: saveImage('m') }, { m: maker(), g: gate('m', true), s: saveImage('g') }, { m: videoMaker(), s: saveImage('m') }] as ApiPrompt[]) {
      expect(runnerTakesNode(graph, 's', CARDS)).toBe(false)
      expect(runnerTakesWorkflow(graph, CARDS)).toBe(false)
      expect(nodesNeedingEngine(graph, { runnerOn: true, families: CARDS, titleOf: id => id })).toContain('s')
    }
    // The control: the same Save image fed a picture is the runner's.
    const picture: ApiPrompt = { c: { class_type: 'LoadImage', inputs: { image: 'a.png', upload: 'image' } }, s: saveImage('c') }
    expect(runnerTakesWorkflow(picture, CARDS)).toBe(true)
    expect(nodesNeedingEngine(picture, { runnerOn: true, families: CARDS, titleOf: id => id })).toEqual([])
    // A reader that lists only frames refuses files (a picture card's slot).
    const files: ApiPrompt = { c: { class_type: 'LoadImage', inputs: { image: 'a.png', upload: 'image' } }, r: reader('c') }
    expect(valueWiresAllowed(files, 'r', outputKindsFor(CARDS), CARDS)).toBe(false)
  })

  it('withWiredValues leaves frames and video wires alone (never WIRED_VALUE_MISSING)', () => {
    for (const graph of [p('direct'), { m: videoMaker(), r: reader('m') } as ApiPrompt]) {
      const r = withWiredValues(graph, 'r', () => undefined)
      expect(r.prompt).toBe(graph)
      expect(r.injected).toEqual([])
    }
  })

  it('filesOf names a frame batch’s kept file, and a made video’s frames and sound', () => {
    const f = (n: string): OutputFile => ({ filename: n, subfolder: 'r', type: 'kept' })
    expect(filesOf({ kind: 'frames', file: f('a.mkv'), count: 1, w: 2, h: 2 })).toEqual([f('a.mkv')])
    expect(filesOf({ kind: 'video', frames: { file: f('a.mkv'), count: 1, w: 2, h: 2 }, fps: 24, sound: null })).toEqual([f('a.mkv')])
    expect(filesOf({ kind: 'video', frames: { file: f('a.mkv'), count: 1, w: 2, h: 2 }, fps: 24, sound: { file: f('s.wav'), note: { decode: 'exact' } } })).toEqual([f('a.mkv'), f('s.wav')])
  })
})

// ── The kept store by path ───────────────────────────────────────────────────

describe('kept files by path (keptBytes.ts, results.ts)', () => {
  const RUN = rid(4)
  it('putPath keeps a tool’s file by its sha256, once; pathOf and verifiedPath find it; a changed or missing one is KEPT_GONE', async () => {
    const dir = mkdtempSync(join(scratch, 'kept-'))
    const kept = createFileKeptBytes(dir)
    const work = await kept.workDir(RUN)
    expect(work.startsWith(join(dir, RUN))).toBe(true)
    const bytes = new TextEncoder().encode('frames')
    writeFileSync(join(work, 'a.mkv'), bytes)
    const f = await kept.putPath(RUN, join(work, 'a.mkv'), 'mkv')
    expect(f).toEqual({ filename: `${sha(bytes)}.mkv`, subfolder: RUN, type: 'kept' })
    expect(existsSync(join(work, 'a.mkv'))).toBe(false)
    writeFileSync(join(work, 'b.mkv'), bytes)
    expect(await kept.putPath(RUN, join(work, 'b.mkv'), 'mkv')).toEqual(f)
    expect(existsSync(join(work, 'b.mkv'))).toBe(false)
    expect(kept.pathOf(f)).toBe(join(dir, RUN, f.filename))
    expect(await kept.verifiedPath(f)).toBe(join(dir, RUN, f.filename))
    expect(kept.rootOf(RUN)).toBe(join(dir, RUN))
    expect(await kept.runBytes(RUN)).toBe(bytes.length)
    writeFileSync(join(dir, RUN, f.filename), 'changed')
    expect(kept.pathOf(f)).toBe(join(dir, RUN, f.filename))
    await expect(kept.verifiedPath(f)).rejects.toThrow(KEPT_GONE)
    rmSync(join(dir, RUN, f.filename))
    expect(() => kept.pathOf(f)).toThrow(KEPT_GONE)
    expect(() => kept.pathOf({ ...f, filename: '../x.mkv' })).toThrow(KEPT_GONE)
    // The sweep lets the run's folder (work folders too) go.
    await kept.keepOnly(new Set())
    expect(existsSync(join(dir, RUN))).toBe(false)
  })

  it('the memory store keeps a tool’s file on disk (the tools read by path)', async () => {
    const kept = createMemoryKeptBytes()
    const work = await kept.workDir(RUN)
    writeFileSync(join(work, 's.wav'), 'wav')
    const f = await kept.putPath(RUN, join(work, 's.wav'), 'wav')
    expect(readFileSync(await kept.verifiedPath(f), 'utf8')).toBe('wav')
    expect(new TextDecoder().decode(await kept.read(f))).toBe('wav')
    expect(await kept.runBytes(RUN)).toBe(3)
  })

  it('withRunCap refuses a put past the run’s cap (and lets a putPath’s file go); the same bytes again cost nothing', async () => {
    const dir = mkdtempSync(join(scratch, 'kept-cap-'))
    const kept = withRunCap(createFileKeptBytes(dir), () => 10)
    const a = await kept.put(RUN, new Uint8Array(8), 'bin')
    expect(await kept.put(RUN, new Uint8Array(8), 'bin')).toEqual(a)
    await expect(kept.put(RUN, new Uint8Array(3), 'bin')).rejects.toThrow(KEPT_TOO_MUCH)
    const work = await kept.workDir(RUN)
    writeFileSync(join(work, 'big.mkv'), new Uint8Array(5))
    await expect(kept.putPath(RUN, join(work, 'big.mkv'), 'mkv')).rejects.toThrow(KEPT_TOO_MUCH)
    expect(existsSync(join(work, 'big.mkv'))).toBe(false)
    const unlimited = withRunCap(createFileKeptBytes(dir), () => Number.POSITIVE_INFINITY)
    await expect(unlimited.put(RUN, new Uint8Array(30), 'bin')).resolves.toBeTruthy()
  })

  it('saveFromPath saves under Python’s names and counters, moving the file, never over an existing one', async () => {
    const root = mkdtempSync(join(scratch, 'store-'))
    const results = createEngineResultStore({ dirForType: t => join(root, t), hosted: () => false })
    const src = (s: string) => { const p = join(scratch, `src-${s}`); writeFileSync(p, s); return p }
    const a = await results.saveFromPath!(src('one'), { userId: null, prefix: 'ComfyUI', ext: 'mp4', subfolder: 'video' })
    expect(a).toEqual({ filename: 'ComfyUI_00001_.mp4', subfolder: 'video', type: 'output' })
    // A name taken by someone else moves the counter on, as `save` does.
    writeFileSync(join(root, 'output', 'video', 'ComfyUI_00002_.mp4'), 'theirs')
    const s3 = src('two')
    const b = await results.save(new Uint8Array(1), { userId: null, prefix: 'ComfyUI', ext: 'mp4', subfolder: 'video' })
    expect(b.filename).toBe('ComfyUI_00003_.mp4')
    const c = await results.saveFromPath!(s3, { userId: null, prefix: 'ComfyUI', ext: 'mp4', subfolder: 'video' })
    expect(c.filename).toBe('ComfyUI_00004_.mp4')
    expect(existsSync(s3)).toBe(false)
    expect(readFileSync(join(root, 'output', 'video', 'ComfyUI_00002_.mp4'), 'utf8')).toBe('theirs')
    expect(readFileSync(results.pathOf!(c), 'utf8')).toBe('two')
    expect(results.rootOf!(c)).toBe(resolve(join(root, 'output')))
    // A counter that lands on taken names (a racing save's) moves on past them, never over one.
    const d = await results.saveFromPath!(src('three'), { userId: null, prefix: 'ComfyUI', ext: 'mp4', subfolder: 'video', counter: { prefix: 'ComfyUI', offset: -3 } })
    expect(d.filename).toBe('ComfyUI_00005_.mp4')
    expect(readFileSync(join(root, 'output', 'video', 'ComfyUI_00002_.mp4'), 'utf8')).toBe('theirs')
    expect(readFileSync(results.pathOf!(c), 'utf8')).toBe('two')
    await expect(results.saveFromPath!(src('x'), { userId: null, prefix: '../x', ext: 'mp4' })).rejects.toThrow()
  })
})

// ── Sound notes ──────────────────────────────────────────────────────────────

const DECODE = mediaFixture<DecodeCase>('decode')
const pySound = (clip: string, which: 'load' | 'download') => DECODE.cases.find(c => c.clip === clip)![which] as PySound

describe('sound notes', () => {
  const file = (filename: string, type: OutputFile['type'] = 'output'): OutputFile => ({ filename, subfolder: '', type })

  it('soundNoteOf: a value’s own note; else its maker’s (the paid sound nodes download, the cards load, a kept WAV exact)', () => {
    const old: RunnerValue = { kind: 'files', files: [file('music_00001_.wav')] }
    expect(soundNoteOf(old, 'GenerateMusicNode')).toEqual({ decode: 'download' })
    expect(soundNoteOf(old, 'Audio')).toEqual({ decode: 'load' })
    expect(soundNoteOf(old, 'LoadAudio')).toEqual({ decode: 'load' })
    for (const c of ['GenerateMusicNode', 'MusicGenRemoteNode', 'GenerateSpeechNode', 'MiniMaxSpeechRemoteNode', 'CloneSingingVoiceNode']) expect(SOUND_DOWNLOAD_CLASSES.has(c)).toBe(true)
    expect(soundNoteOf({ ...old, sound: { decode: 'load' } }, 'GenerateMusicNode')).toEqual({ decode: 'load' })
    expect(soundNoteOf({ kind: 'files', files: [{ filename: `${'a'.repeat(64)}.wav`, subfolder: rid(10), type: 'kept' }] }, 'Whatever')).toEqual({ decode: 'exact' })
  })

  it('readSound gives each decoder’s samples, bit-equal to Python’s (load and download)', LONG, async () => {
    await requireMediaTools()
    const k = kit()
    mkdirSync(join(k.root, 'output'), { recursive: true })
    for (const clip of ['a_mono.mp3', 'a_long_8k.wav', 'a_aac.m4a']) copyFileSync(clipPath(clip), join(k.root, 'output', clip))
    const io = ioOf(k, rid(5))
    for (const clip of ['a_mono.mp3', 'a_long_8k.wav', 'a_aac.m4a']) {
      const v: RunnerValue = { kind: 'files', files: [file(clip)] }
      for (const [maker, which] of [['LoadAudio', 'load'], ['GenerateMusicNode', 'download']] as const) {
        const got = await readSound(v, maker, io)
        const want = pySound(clip, which)
        expect(got.rate, `${clip} ${which}`).toBe(want.rate)
        expect(got.channels.length, `${clip} ${which}`).toBe(want.rows)
        expect(sha256Hex(soundBytes(got.channels)), `${clip} ${which}`).toBe(want.sha256)
        // The note wins over the maker.
        const noted = await readSound({ ...v, sound: { decode: which } }, 'Audio', io)
        expect(sha256Hex(soundBytes(noted.channels)), `${clip} ${which} noted`).toBe(want.sha256)
      }
    }
    // The two decoders differ where Python's do (an s16 WAV: load divides by 32768, download by its peak).
    const v: RunnerValue = { kind: 'files', files: [file('a_long_8k.wav')] }
    expect(sha256Hex(soundBytes((await readSound(v, 'LoadAudio', io)).channels))).not.toBe(sha256Hex(soundBytes((await readSound(v, 'GenerateMusicNode', io)).channels)))
  })

  it('keepSound → readSound is bit-identical (every float as it is), and kept once by its bytes', LONG, async () => {
    await requireMediaTools()
    const k = kit()
    const io = ioOf(k, rid(6))
    const odd = new Float32Array([0, -0, 1, -1, 3.5, -2, 1e-30, -1e-38, 1.401298464324817e-45, 3.4028234663852886e38, Math.fround(Math.PI)])
    const s: DecodedSound = { rate: 22050, channels: [Float32Array.from({ length: 5000 }, (_, i) => odd[i % odd.length]! * (i % 7 ? 1 : 0.25)), tone(22050, 5000).channels[1]!] }
    const v = await keepSound(rid(6), s, k.kept)
    expect(v).toMatchObject({ kind: 'files', sound: { decode: 'exact' } })
    const f = (v as Extract<RunnerValue, { kind: 'files' }>).files[0]!
    expect(f.type).toBe('kept')
    expect(f.filename).toMatch(/^[0-9a-f]{64}\.wav$/)
    const back = await readSound(v, 'Anything', io)
    expect(back.rate).toBe(22050)
    expect(back.channels.map(ch => sha(new Uint8Array(ch.buffer, ch.byteOffset, ch.byteLength)))).toEqual(s.channels.map(ch => sha(new Uint8Array(ch.buffer, ch.byteOffset, ch.byteLength))))
    expect(await keepSound(rid(6), s, k.kept)).toEqual(v)
    // No work folders are left behind.
    expect(readdirSync(join(k.keptDir, rid(6)))).toEqual([f.filename])
  })

  it('keepSound refuses a sound over soundSamples before writing it', async () => {
    CAPS.over.local = { soundSamples: 100 }
    const kept = createMemoryKeptBytes()
    await expect(keepSound(rid(7), tone(8000, 51), kept)).rejects.toThrow(MEDIA_WORDS.tooLong)
    expect(await kept.runBytes(rid(7))).toBe(0)
  })
})

// ── Frame batches and made videos ────────────────────────────────────────────

describe('frame batches and made videos', () => {
  it('keepFrames → readFrames gives the exact frames back, kept once by their bytes', LONG, async () => {
    await requireMediaTools()
    const k = kit()
    const io = ioOf(k, rid(1))
    const frames = [synth(33, 25, 3, 5), smoothFrame(33, 25, 2), synth(33, 25, 3, 6)]
    const v = await keepFrames(rid(1), stream(frames), 33, 25, io)
    expect(v).toMatchObject({ kind: 'frames', count: 3, w: 33, h: 25 })
    expect(v.file.filename).toMatch(/^[0-9a-f]{64}\.mkv$/)
    const got: string[] = []
    await readFrames(v, io, async (rgb, i) => { expect(i).toBe(got.length); got.push(sha(rgb)) })
    expect(got).toEqual(frames.map(sha))
    expect(await keepFrames(rid(1), stream(frames), 33, 25, io)).toEqual(v)
    expect(readdirSync(join(k.keptDir, rid(1)))).toEqual([v.file.filename])
  })

  it('a batch over batchFrames or batchPixels fails as it streams; readFrames refuses one before any decode', LONG, async () => {
    await requireMediaTools()
    const k = kit()
    const io = ioOf(k, rid(2))
    const v = await keepFrames(rid(2), stream(makerFrames(8, 6, 3, 0)), 8, 6, io)
    CAPS.over.local = { batchFrames: 2 }
    await expect(keepFrames(rid(2), stream(makerFrames(8, 6, 3, 0)), 8, 6, io)).rejects.toThrow(MEDIA_WORDS.tooManyFrames)
    await expect(readFrames(v, io, async () => { throw new Error('decoded') })).rejects.toThrow(MEDIA_WORDS.tooManyFrames)
    CAPS.over.local = { batchPixels: 8 * 6 * 2 }
    await expect(readFrames(v, io, async () => { throw new Error('decoded') })).rejects.toThrow(MEDIA_WORDS.tooManyFrames)
    CAPS.over.local = { framePixels: 8 * 6 - 1 }
    await expect(keepFrames(rid(2), stream(makerFrames(8, 6, 1, 0)), 8, 6, io)).rejects.toThrow(MEDIA_WORDS.tooBig)
    // No work folders are left behind by the failures.
    expect(readdirSync(join(k.keptDir, rid(2)))).toEqual([v.file.filename])
  })

  it('a changed kept batch gives KEPT_GONE', LONG, async () => {
    await requireMediaTools()
    const k = kit()
    const io = ioOf(k, rid(3))
    const v = await keepFrames(rid(3), stream(makerFrames(8, 6, 2, 1)), 8, 6, io)
    const p = join(k.keptDir, rid(3), v.file.filename)
    const b = readFileSync(p)
    b[b.length - 1] ^= 1
    writeFileSync(p, b)
    await expect(readFrames(v, io, async () => {})).rejects.toThrow(KEPT_GONE)
    rmSync(p)
    await expect(readFrames(v, io, async () => {})).rejects.toThrow(KEPT_GONE)
  })

  it('videoFileFor of a made video equals encodeVideo of its parts (save_to’s rate, sound cut and layout); of a file video, the file itself', LONG, async () => {
    await requireMediaTools()
    const k = kit()
    const io = ioOf(k, rid(8))
    const frames = makerFrames(32, 24, 5, 11)
    const fv = await keepFrames(rid(8), stream(frames), 32, 24, io)
    const s = tone(44100, 30000)
    const sv = await keepSound(rid(8), s, k.kept) as Extract<RunnerValue, { kind: 'files' }>
    const tags = { prompt: '{"1": {}}', workflow: '{"nodes": []}' }
    for (const [fps, sound] of [[12.5, true], [29.97, true], [24, false]] as const) {
      const v: RunnerValue = { kind: 'video', frames: { file: fv.file, count: 5, w: 32, h: 24 }, fps, sound: sound ? { file: sv.files[0]!, note: sv.sound! } : null }
      const made = await videoFileFor(v, io, { metadata: tags })
      expect(made.temporary).toBe(true)
      const want = join(realpathSync(scratch), `want-${fps}.mp4`)
      await encodeVideo({
        input: { kind: 'rgb', w: 32, h: 24, frames: stream(frames) }, out: want, fps: pyStreamRate(fps), quality: PYAV_H264_DEFAULT,
        sound: sound ? { source: { sound: s }, layout: 'stereo', rate: 44100, cutSamples: madeVideoSoundCut(44100, fps, 5) } : null,
        metadata: tags, userId: null, outRoots: [realpathSync(scratch)],
      })
      expect(sha(readFileSync(made.path)), String(fps)).toBe(sha(readFileSync(want)))
      await dropVideoFile(made)
      expect(existsSync(made.path)).toBe(false)
    }
    // save_to's cut: ceil((rate / Fraction(round(fps · 1000), 1000)) · frames).
    expect(madeVideoSoundCut(44100, 12.5, 5)).toBe(17640)
    expect(madeVideoSoundCut(44100, 29.97, 5)).toBe(7358)
    expect(madeVideoSoundCut(48000, 23.976, 7)).toBe(14015)
    // A file video is the file itself.
    mkdirSync(join(k.root, 'input'), { recursive: true })
    copyFileSync(clipPath('v_h264_601.mp4'), join(k.root, 'input', 'clip.mp4'))
    const file = await videoFileFor({ kind: 'files', files: [{ filename: 'clip.mp4', subfolder: '', type: 'input' }] }, io)
    expect(file).toEqual({ path: resolve(join(k.root, 'input', 'clip.mp4')), temporary: false })
    await dropVideoFile(file)
    expect(existsSync(file.path)).toBe(true)
  })

  it('a made video over the batch caps fails before any encode', async () => {
    CAPS.over.local = { batchFrames: 4 }
    const kept = createMemoryKeptBytes()
    const results = createEngineResultStore({ dirForType: t => join(scratch, t), hosted: () => false })
    const io: MediaValueIO = { access: createFileAccess(results, kept), kept, runId: rid(9), userId: null, hosted: false }
    const v: RunnerValue = { kind: 'video', frames: { file: { filename: `${'b'.repeat(64)}.mkv`, subfolder: rid(9), type: 'kept' }, count: 5, w: 8, h: 8 }, fps: 24, sound: null }
    await expect(videoFileFor(v, io)).rejects.toThrow(MEDIA_WORDS.tooManyFrames)
  })
})

// ── Through the engine ───────────────────────────────────────────────────────

describe('the engine hands the new kinds on', () => {
  it('a frame batch through an open Gate reaches its reader exactly', LONG, async () => {
    await requireMediaTools()
    const k = kit()
    const { runId } = await k.engine.startRun({ userId: null, takes: [{ m: maker({ count: 4, seed: 3 }), g: gate('m', true), r: reader('g') }], ...START })
    await k.engine.settled(runId)
    const t = (await k.store.get(runId))!.takes[0]!
    expect(t.nodes.r!.status, t.nodes.r!.error ?? '').toBe('done')
    expect(t.nodes.m!.values![0]).toMatchObject({ kind: 'frames', count: 4, w: 32, h: 24 })
    expect(t.nodes.g!.values![0]).toEqual(t.nodes.m!.values![0])
    expect(t.nodes.r!.values![0]).toEqual({ kind: 'text', text: makerFrames(32, 24, 4, 3).map(sha).join(',') })
  })

  it('a made video through an open Gate is encoded for its reader as save_to would', LONG, async () => {
    await requireMediaTools()
    const k = kit()
    const { runId } = await k.engine.startRun({ userId: null, takes: [{ m: videoMaker(), g: gate('m', true), r: reader('g') }], ...START })
    await k.engine.settled(runId)
    const t = (await k.store.get(runId))!.takes[0]!
    expect(t.nodes.r!.status, t.nodes.r!.error ?? '').toBe('done')
    const v = t.nodes.m!.values![0] as Extract<RunnerValue, { kind: 'video' }>
    expect(v).toMatchObject({ kind: 'video', fps: 12.5, frames: { count: 5, w: 32, h: 24 }, sound: { note: { decode: 'exact' } } })
    const want = join(realpathSync(scratch), 'engine-want.mp4')
    await encodeVideo({
      input: { kind: 'rgb', w: 32, h: 24, frames: stream(makerFrames(32, 24, 5, 11)) }, out: want, fps: pyStreamRate(12.5), quality: PYAV_H264_DEFAULT,
      sound: { source: { sound: tone(44100, 30000) }, layout: 'stereo', rate: 44100, cutSamples: madeVideoSoundCut(44100, 12.5, 5) },
      userId: null, outRoots: [realpathSync(scratch)],
    })
    expect(t.nodes.r!.values![0]).toEqual({ kind: 'text', text: sha(readFileSync(want)) })
  })

  it('a Gate stopped on a frame batch shows nothing to pick, and after a restart Continue reads the kept .mkv back by path', LONG, async () => {
    await requireMediaTools()
    const k1 = kit()
    const { runId } = await k1.engine.startRun({ userId: null, takes: [{ m: maker({ count: 3, seed: 20 }), g: gate('m', false), r: reader('g') }], ...START })
    await k1.engine.settled(runId)
    const paused = (await k1.store.get(runId))!.takes[0]!.nodes.g!
    expect(paused.status).toBe('paused')
    expect(paused.outputs).toEqual([])
    expect(paused.values![0]).toMatchObject({ kind: 'frames', count: 3 })
    // A new server over the same run store and kept folder.
    const k2 = kit({ dir: k1.dir, root: k1.root })
    await k2.engine.gateAction({ userId: null, runId, gateId: 'g', action: 'continue' })
    await k2.engine.settled(runId)
    const t = (await k2.store.get(runId))!.takes[0]!
    expect(t.nodes.r!.status, t.nodes.r!.error ?? '').toBe('done')
    expect(t.nodes.r!.values![0]).toEqual({ kind: 'text', text: makerFrames(32, 24, 3, 20).map(sha).join(',') })
  })

  it('a changed kept file fails its reader with KEPT_GONE', LONG, async () => {
    await requireMediaTools()
    const k1 = kit()
    const { runId } = await k1.engine.startRun({ userId: null, takes: [{ m: maker({ count: 2 }), g: gate('m', false), r: reader('g') }], ...START })
    await k1.engine.settled(runId)
    const v = (await k1.store.get(runId))!.takes[0]!.nodes.g!.values![0] as Extract<RunnerValue, { kind: 'frames' }>
    const p = join(k1.keptDir, runId, v.file.filename)
    const b = readFileSync(p)
    b[b.length - 1] ^= 1
    writeFileSync(p, b)
    await k1.engine.gateAction({ userId: null, runId, gateId: 'g', action: 'continue' })
    await k1.engine.settled(runId)
    const r = (await k1.store.get(runId))!.takes[0]!.nodes.r!
    expect(r.status).toBe('error')
    expect(r.error).toBe(KEPT_GONE)
  })

  it('a run past keptBytesPerRun fails the node plainly (hosted)', LONG, async () => {
    await requireMediaTools()
    CAPS.over.hosted = { keptBytesPerRun: 1000 }
    const k = kit({ hosted: true })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [{ m: maker({ count: 4 }), g: gate('m', true), r: reader('g') }], ...START })
    await k.engine.settled(runId)
    const m = (await k.store.get(runId))!.takes[0]!.nodes.m!
    expect(m.status).toBe('error')
    expect(m.error).toBe(KEPT_TOO_MUCH)
  })
})

// ── Rule 8: with the media families off, nothing changes ─────────────────────

/** The Gate's value inputs before R5.2. */
const GATE_KINDS_BEFORE: readonly ValueKind[] = ['files', 'mask', 'text', 'number', 'boolean', 'json', 'glb']

/** `fn`'s answer with the Gate taking only what it took before R5.2 (the one eligibility table R5.2 changed). */
function beforeR52<T>(fn: () => T): T {
  const table = BASE_VALUE_INPUTS as Record<string, Record<string, readonly ValueKind[]>>
  const now = table[GATE_CLASS]!
  table[GATE_CLASS] = { data_in: GATE_KINDS_BEFORE }
  try { return fn() }
  finally { table[GATE_CLASS] = now }
}

const OFF_SETS: [string, RunnerFamily[]][] = [
  ['none', []],
  ['cards', ['cards']],
  ['every family', [...RUNNER_FAMILIES]],
]

function answers(p: ApiPrompt, families: ReadonlySet<RunnerFamily>) {
  const kinds = outputKindsFor(families)
  return {
    needs: nodesNeedingEngine(p, { runnerOn: true, families, titleOf: id => id }),
    workflow: runnerTakesWorkflow(p, families),
    eligible: isRunnerEligible(p, families),
    nodes: Object.keys(p).map(id => [runnerTakesNode(p, id, families), valueWiresAllowed(p, id, kinds, families)]),
  }
}

describe('rule 8: the families-off invariant', () => {
  it('no real class hands on a frame batch or a video yet (so no real wire carries one), with any family on', () => {
    for (const [, fam] of OFF_SETS) {
      for (const [cls, row] of Object.entries(outputKindsFor(new Set(fam)))) {
        if (STAND_INS.includes(cls)) continue
        expect(Object.values(row).filter(k => k === 'frames' || k === 'video'), cls).toEqual([])
      }
    }
    // The comparison below has teeth: a Gate on a frame batch reads differently before R5.2.
    const gated: ApiPrompt = { m: maker(), g: gate('m', true), r: reader('g') }
    expect(runnerTakesNode(gated, 'g', CARDS)).toBe(true)
    expect(beforeR52(() => runnerTakesNode(gated, 'g', CARDS))).toBe(false)
    expect(answers(gated, CARDS)).not.toEqual(beforeR52(() => answers(gated, CARDS)))
  })

  const PROJECTS = resolve(__dirname, '../../../user/sailor/projects')
  // The saved projects are this machine's own data: with the folder missing the check is skipped, visibly.
  const projectsIt = existsSync(PROJECTS) ? it : it.skip
  projectsIt('over every saved project graph, what the runner takes and the needs-the-engine lists are as before R5.2', async () => {
    const { gunzipSync } = await import('node:zlib')
    const { graphToPrompt } = await import('~/lib/graph/graphToPrompt')
    const catalog = JSON.parse(gunzipSync(readFileSync(resolve(__dirname, '../../server/native/objectInfo.baseline.json.gz'))).toString('utf8'))
    let graphs = 0
    let gates = 0
    for (const uuid of readdirSync(PROJECTS).sort()) {
      let wf: { canvases?: { workflow: unknown }[] } | undefined
      try { wf = JSON.parse(readFileSync(join(PROJECTS, uuid, 'versions', 'current.json'), 'utf8')).workflow }
      catch { continue }
      for (const c of wf?.canvases ?? []) {
        let p: ApiPrompt
        try { p = graphToPrompt(c.workflow as never, catalog) }
        catch { continue }
        expect(Object.values(p).some(n => STAND_INS.includes(n.class_type)), uuid).toBe(false)
        if (Object.values(p).some(n => n.class_type === GATE_CLASS)) gates++
        for (const [name, fam] of OFF_SETS) {
          const families = new Set(fam)
          expect(answers(p, families), `${uuid}, ${name}`).toEqual(beforeR52(() => answers(p, families)))
        }
        graphs++
      }
    }
    // A lower bound, not an exact count: the folder is live data. On 2026-09-26: 866 graphs.
    expect(graphs).toBeGreaterThanOrEqual(800)
    console.info(`R5.2 families-off invariant: ${graphs} saved graphs (${gates} with a Gate) plan as before`)
  }, 300_000)
})
