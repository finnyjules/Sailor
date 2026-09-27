/**
 * R3.1: the engine's plan shapes for the paid nodes — sounds, 3D files, one
 * URL of several, pictures with their alpha dropped, the answer's body text,
 * several calls in one node (pipelines), and token charges. No R3 node is
 * ported yet, so nodes carrying `test_plan` are turned into stand-in plans
 * here (the vi.mock pattern of runner-value-results.unit.spec.ts).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'
import { createFakeFal, createFakeReplicate, makeKit, until } from './__runner__/kit'
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { creditsForUsd } from '#shared/pricing/markup'
import { BASE_RENDER_CREDITS } from '~~/server/utils/priceBook'
import { nodeCredits } from '~~/server/runner/metering'
import { rawTextOf } from '~~/server/runner/rawJson'
import { PY_JSON_TOO_DEEP, parsePyJson, pyJsonDumps } from '#shared/runner/pyJson'
import { PIPELINE_CALL_CHANGED } from '~~/server/runner/engine'
import { userSubfolder } from '~~/server/runner/results'
import { outputKey } from '~~/server/utils/graphRuns'
import type { PipelineIO } from '~~/server/runner/executors'
import type { RunRecord } from '~~/server/runner/types'
import { ReplicateError } from '~~/server/runner/replicateQueue'
import { downloadResult } from '~~/server/runner/falQueue'
import { FetchRefused } from '~~/server/templates/safeFetch'
import {
  ANSWER_MAX_BYTES, ANSWER_NOT_GLB, ANSWER_NOT_SOUND, ANSWER_REFUSED, answerCap, answerExt, safeAnswerFetch, soundExtOf,
} from '~~/server/runner/answerDownload'

/** What the stand-in pipeline does, set by each test. */
/** A test's own chargeOf figure (NaN can't travel through a JSON answer). */
const CHARGE = vi.hoisted(() => ({ override: null as null | (() => number) }))
const PIPE = vi.hoisted(() => ({
  before: null as null | ((key: string) => void | Promise<void>),
  payloadOf: (key: string, i: number): Record<string, unknown> => ({ prompt: `call ${key}`, n: i }),
  /** The calls, in order; their `usd` is also what the price module plans for the hold. */
  calls: [{ key: 'a', usd: 0.05 }, { key: 'b', usd: 0.03 }, { key: 'c', usd: 0.02 }] as { key: string; usd: number; backup?: boolean }[],
  /** All calls side by side (Promise.all) instead of one after another. */
  parallel: false,
  /** After the calls: download each answer's first file (a sound). */
  download: false,
}))

vi.mock('~~/server/runner/executors', async (importOriginal) => {
  const real = await importOriginal<typeof import('~~/server/runner/executors')>()
  return {
    ...real,
    planNode: async (ctx: Parameters<typeof real.planNode>[0]) => {
      const inputs = ctx.prompt[ctx.nodeId]!.inputs
      const test = inputs.test_plan
      if (test === 'pipeline') {
        return {
          kind: 'pipeline' as const, prefix: 'pipe',
          run: async (io: PipelineIO) => {
            const call = (c: typeof PIPE.calls[number], i: number) => io.call({
              key: c.key, provider: 'replicate', endpoint: `test/${c.key}`, payload: PIPE.payloadOf(c.key, i), media: 'value', usd: c.usd,
              ...(c.backup ? { backup: { provider: 'fal' as const, endpoint: `fal-${c.key}`, payload: PIPE.payloadOf(c.key, i) } } : {}),
            })
            const got: string[] = []
            if (PIPE.parallel) {
              for (const r of await Promise.all(PIPE.calls.map(call))) got.push(String((r.result as { output?: unknown }).output))
            }
            else {
              for (const [i, c] of PIPE.calls.entries()) {
                await PIPE.before?.(c.key)
                const r = await call(c, i)
                got.push(String((r.result as { output?: unknown }).output))
                if (PIPE.download) await io.download(String((r.result as { output?: unknown }).output), { kind: 'audio' })
              }
            }
            return { values: { 0: { kind: 'text' as const, text: got.join('|') } }, ui: null }
          },
        }
      }
      const plan = await real.planNode(ctx)
      if (plan.kind !== 'provider' || typeof test !== 'string') return plan
      const onReplicate = { ...plan, provider: 'replicate' as const, endpoint: `test/${test}`, uiFor: () => null }
      delete (onReplicate as { backup?: unknown }).backup
      switch (test) {
        case 'audio': return { ...onReplicate, media: 'audio' as const, prefix: 'music' }
        case 'glb': return { ...onReplicate, media: 'glb' as const, prefix: 'model3d' }
        case 'first': return { ...onReplicate, media: 'image' as const, take: 'first' as const }
        case 'rgb': return { ...onReplicate, media: 'image' as const, rgb: true as const, prefix: 'flux_lora', uiFor: (files: unknown[]) => ({ images: files, animated: [false] }) }
        case 'raw-replicate':
          return { ...onReplicate, media: 'value' as const, valuesOf: (_r: unknown, raw: string | null) => ({ 0: { kind: 'json' as const, text: raw ?? 'no body' } }) }
        case 'raw-fal':
          return { ...plan, media: 'value' as const, uiFor: () => null, valuesOf: (_r: unknown, raw: string | null) => ({ 0: { kind: 'json' as const, text: raw ?? 'no body' } }) }
        case 'json':
          return { ...onReplicate, media: 'value' as const, valuesOf: (_r: unknown, raw: string | null) => ({ 0: { kind: 'json' as const, text: pyJsonDumps(parsePyJson(raw ?? 'null')) } }) }
        case 'charge':
          return {
            ...onReplicate, media: 'value' as const,
            valuesOf: (r: any) => ({ 0: { kind: 'text' as const, text: String(r.output.text) } }),
            chargeOf: (r: any) => (CHARGE.override ? CHARGE.override() : r.output.credits as number),
          }
      }
      return plan
    },
  }
})

// The glb stand-in's slot 0 carries a 3D file, as a paid 3D node's row will (R3.9).
vi.mock('#shared/runner/values', async (importOriginal) => {
  const real = await importOriginal<typeof import('#shared/runner/values')>()
  const OUTPUT_KINDS = { ...real.OUTPUT_KINDS, GenerateVideoNode: { 0: 'glb' as const } }
  return {
    ...real,
    OUTPUT_KINDS,
    outputKind: (p: Parameters<typeof real.outputKind>[0], l: Parameters<typeof real.outputKind>[1], kinds = OUTPUT_KINDS, depth = 0) => real.outputKind(p, l, kinds, depth),
  }
})

// The stand-in pipeline's hold: the price module's plan of its calls (PIPE.calls), priced per call.
vi.mock('#shared/pricing/pipelinePrice', async (importOriginal) => {
  const real = await importOriginal<typeof import('#shared/pricing/pipelinePrice')>()
  return {
    ...real,
    pipelineCallsOf: (classType: string, inputs: Record<string, unknown>) =>
      classType === 'GenerateVideoNode' && inputs.test_plan === 'pipeline' ? PIPE.calls.map(c => ({ usd: c.usd })) : real.pipelineCallsOf(classType, inputs),
  }
})

const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const CARDS: ReadonlySet<RunnerFamily> = new Set(['cards'])
const image = (test: string, seed = 0) => ({ class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'p', aspect_ratio: '1:1', seed, model_options: '{}', test_plan: test } })
const video = (test: string | null, seed = 0, first?: [string, number]) => ({
  class_type: 'GenerateVideoNode',
  inputs: { model: 'hailuo-h3', prompt: 'p', aspect_ratio: '16:9', duration: '5', seed, model_options: '{}', ...(test ? { test_plan: test } : {}), ...(first ? { image: first } : {}) },
})
const TYPES: Record<string, string> = { wav: 'audio/wav', mp3: 'audio/mpeg', glb: 'model/gltf-binary', png: 'image/png', mp4: 'video/mp4' }
/** The header a file of that extension starts with (a sound's or a GLB's kind is checked by it). */
const HEADS: Record<string, string> = { wav: 'RIFF\0\0\0\0WAVE', mp3: 'ID3', glb: 'glTF' }
const extOf = (url: string) => url.slice(url.lastIndexOf('.') + 1)
const bodyOf = (url: string, ext = extOf(url)) => `${HEADS[ext] ?? ''}${url}`
/** Downloads the URL's own text as its bytes (after its kind's header), typed by its extension (or untyped when `typed` is false). */
const byExt = (typed = true) => vi.fn(async (url: string, _o?: unknown) => ({
  bytes: new TextEncoder().encode(bodyOf(url)),
  contentType: typed ? TYPES[extOf(url)] ?? null : null,
}))
const MIB = 1024 * 1024
const opts = (kind: string, maxBytes = 512 * MIB) => ({ maxBytes, signal: expect.any(AbortSignal), kind })
const run = async (k: ReturnType<typeof makeKit>, prompt: ApiPrompt): Promise<RunRecord> => {
  const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })
  await k.engine.settled(runId)
  return (await k.store.get(runId))!
}
const read = (k: ReturnType<typeof makeKit>, f: { filename: string; subfolder: string; type: string }) =>
  readFileSync(join(k.root, f.type, f.subfolder, f.filename))

describe('a sound plan', () => {
  it('downloads the WAV, saves it .wav, and hands it to the next node', async () => {
    const replicate = createFakeReplicate({ answer: ({ model }) => `https://replicate.delivery/${model.split('/')[1]}.wav` })
    const download = byExt()
    const k = makeKit({ replicate, deps: { download } })
    const r = await run(k, { 1: image('audio'), 2: video(null, 0, ['1', 0]) })
    const rec = r.takes[0]!.nodes['1']!
    expect(rec.status).toBe('done')
    expect(rec.outputs).toEqual([{ filename: 'music_00001_.wav', subfolder: '', type: 'output' }])
    expect(read(k, rec.outputs[0]!).toString()).toBe(bodyOf('https://replicate.delivery/audio.wav'))
    expect(download).toHaveBeenCalledWith('https://replicate.delivery/audio.wav', opts('audio'))
    // The next node gets the sound handed off (uploaded as a WAV) in its request.
    expect(k.upload).toHaveBeenCalledWith(expect.any(Uint8Array), 'music_00001_.wav', 'audio/wav')
    expect(r.takes[0]!.nodes['2']!.status).toBe('done')
    expect(JSON.stringify(k.fal.submitted()[0]!.payload)).toContain('https://fal.storage/music_00001_.wav')
  })
  it('saves an MP3 answer .mp3 (by its type, or by its address when untyped)', async () => {
    for (const typed of [true, false]) {
      const replicate = createFakeReplicate({ answer: () => 'https://replicate.delivery/speech.mp3' })
      const k = makeKit({ replicate, deps: { download: byExt(typed) } })
      const rec = (await run(k, { 1: image('audio') })).takes[0]!.nodes['1']!
      expect(rec.outputs.map(f => f.filename)).toEqual(['music_00001_.mp3'])
    }
  })
  it('is saved by its header, never by what its address says', async () => {
    const replicate = createFakeReplicate({ answer: () => 'https://replicate.delivery/sound.html' })
    const download = vi.fn(async (url: string) => ({ bytes: new TextEncoder().encode(bodyOf(url, 'wav')), contentType: 'text/html' }))
    const k = makeKit({ replicate, deps: { download } })
    expect((await run(k, { 1: image('audio') })).takes[0]!.nodes['1']!.outputs.map(f => f.filename)).toEqual(['music_00001_.wav'])
  })
  it('an answer that isn’t a sound is refused plainly, reported lost, and not charged', async () => {
    const replicate = createFakeReplicate({ answer: () => 'https://replicate.delivery/page.wav' })
    const download = vi.fn(async () => ({ bytes: new TextEncoder().encode('<html>'), contentType: 'audio/wav' }))
    const k = makeKit({ hosted: true, replicate, deps: { download } })
    const r = await run(k, { 1: image('audio') })
    const rec = r.takes[0]!.nodes['1']!
    expect(rec.status).toBe('error')
    expect(rec.error).toBe(ANSWER_NOT_SOUND)
    expect(r.charges[0]!.actual).toBe(0)
    expect(k.deps.reportError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ site: 'runner.download.lost', node: '1' }))
  })
  it('waits as a picture does: past the picture limit it is cancelled, in a sound’s words', async () => {
    const replicate = createFakeReplicate({ answer: () => 'https://replicate.delivery/a.wav' })
    const k = makeKit({ replicate, deps: { download: byExt(), timeouts: { imageMs: 30, videoMs: 1_800_000 } } })
    replicate.holdNext(1)
    const rec = (await run(k, { 1: image('audio') })).takes[0]!.nodes['1']!
    expect(rec.status).toBe('error')
    expect(rec.error).toMatch(/^The service took more than 0 minutes to make this sound/)
  })
})

describe('a 3D file plan', () => {
  const glbAnswer = () => createFakeReplicate({ answer: () => ['https://replicate.delivery/model.glb', 'https://replicate.delivery/preview.png'] })

  it('saves Sailor’s own .glb and hands on a glb value naming it; a 3D model card reads it', async () => {
    const k = makeKit({ replicate: glbAnswer(), deps: { download: byExt(), families: () => CARDS } })
    const r = await run(k, { 1: video('glb'), 2: { class_type: 'Model3D', inputs: { glb_url: ['1', 0] } } })
    const rec = r.takes[0]!.nodes['1']!
    const file = { filename: 'model3d_00001_.glb', subfolder: '', type: 'output' as const }
    expect(rec.status).toBe('done')
    expect(rec.outputs).toEqual([file])
    expect(rec.values).toEqual({ 0: { kind: 'glb', url: '/view?filename=model3d_00001_.glb&subfolder=&type=output', file } })
    expect(read(k, file).toString()).toBe(bodyOf('https://replicate.delivery/model.glb'))
    expect(k.deps.download).toHaveBeenCalledWith('https://replicate.delivery/model.glb', opts('glb'))
    // Only the first URL is the model (Python's `_first_output_url`).
    expect(k.deps.download).toHaveBeenCalledTimes(1)
    expect(r.takes[0]!.nodes['2']!.values).toEqual({ 0: { kind: 'text', text: '/view?filename=model3d_00001_.glb&subfolder=&type=output' } })
  })
  it('gives the same value back when the same request is reused', async () => {
    const replicate = glbAnswer()
    const k = makeKit({ replicate, deps: { download: byExt() } })
    const a = (await run(k, { 1: video('glb', 7) })).takes[0]!.nodes['1']!
    const b = (await run(k, { 1: video('glb', 7) })).takes[0]!.nodes['1']!
    expect(b.reused).toBe(true)
    expect(b.values).toEqual(a.values)
    expect(replicate.client.submit).toHaveBeenCalledTimes(1)
  })
  it('hosted: saved in the user’s own folder and recorded as the user’s output', async () => {
    const k = makeKit({ hosted: true, replicate: glbAnswer(), deps: { download: byExt() } })
    const rec = (await run(k, { 1: video('glb') })).takes[0]!.nodes['1']!
    const sub = userSubfolder(k.userId, true)
    expect(sub).not.toBe('')
    const file = { filename: 'model3d_00001_.glb', subfolder: sub, type: 'output' as const }
    expect(rec.values![0]).toEqual({ kind: 'glb', url: `/view?filename=model3d_00001_.glb&subfolder=${encodeURIComponent(sub)}&type=output`, file })
    expect(k.graphRuns.appendOutput.mock.calls.map(c => (c as unknown[])[1])).toEqual([outputKey(file)])
  })
  it('bytes that aren’t a GLB are refused plainly and not charged', async () => {
    const download = vi.fn(async () => ({ bytes: new TextEncoder().encode('not a model'), contentType: 'model/gltf-binary' }))
    const k = makeKit({ hosted: true, replicate: glbAnswer(), deps: { download } })
    const r = await run(k, { 1: video('glb') })
    expect(r.takes[0]!.nodes['1']!.error).toBe(ANSWER_NOT_GLB)
    expect(r.charges[0]!.actual).toBe(0)
  })
  it('waits as a video does', async () => {
    const replicate = glbAnswer()
    const k = makeKit({ replicate, deps: { download: byExt(), timeouts: { imageMs: 30, videoMs: 1_800_000 } } })
    replicate.holdNext(1)
    const { runId } = await k.engine.startRun({ userId: null, takes: [{ 1: video('glb') }], ...START })
    await new Promise(r => setTimeout(r, 80))
    replicate.release()
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.takes[0]!.nodes['1']!.status).toBe('done')
  })
})

describe('first URL only, and pictures with their alpha dropped', () => {
  it('`take: first` downloads one of three URLs', async () => {
    const replicate = createFakeReplicate({ answer: () => ['https://r.test/1.png', 'https://r.test/2.png', 'https://r.test/3.png'] })
    const k = makeKit({ replicate, deps: { download: byExt() } })
    const rec = (await run(k, { 1: image('first') })).takes[0]!.nodes['1']!
    expect(k.deps.download).toHaveBeenCalledTimes(1)
    expect(k.deps.download).toHaveBeenCalledWith('https://r.test/1.png', opts('image'))
    expect(rec.outputs).toHaveLength(1)
  })
  it('`rgb` keeps an RGB PNG whose pixels are the decoded RGB of an RGBA answer (trunc rule)', async () => {
    const w = 4
    const h = 3
    const rgba = new Uint8Array(w * h * 4)
    for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37 + 11) % 256
    const answer = new Uint8Array(await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer())
    const replicate = createFakeReplicate({ answer: () => ['https://r.test/rgba.png'] })
    const k = makeKit({ replicate, deps: { download: vi.fn(async () => ({ bytes: answer, contentType: 'image/png' })) } })
    const r = await run(k, { 1: image('rgb') })
    const rec = r.takes[0]!.nodes['1']!
    expect(rec.outputs).toEqual([{ filename: 'flux_lora_00001_.png', subfolder: '', type: 'output' }])
    const { data, info } = await sharp(read(k, rec.outputs[0]!)).raw().toBuffer({ resolveWithObject: true })
    expect([info.width, info.height, info.channels]).toEqual([w, h, 3])
    const want = new Uint8Array(w * h * 3)
    for (let p = 0; p < w * h; p++) {
      for (let c = 0; c < 3; c++) want[p * 3 + c] = Math.trunc(Math.fround(255 * Math.fround(rgba[p * 4 + c]! / 255)))
    }
    expect(new Uint8Array(data)).toEqual(want)
  })
})

describe('the answer’s body text', () => {
  const BODY = '{"id": "pred1", "status": "succeeded", "output": {"n": 1.0, "big": 9007199254740993, "t": "caf\\u00e9 ☃"}, "a": 1, "a": 2}'
  it('Replicate: rawTextOf gives the prediction’s body text, and a value plan reads it', async () => {
    const replicate = createFakeReplicate({ bodyText: () => BODY })
    const k = makeKit({ replicate })
    const rec = (await run(k, { 1: image('raw-replicate') })).takes[0]!.nodes['1']!
    expect(rec.values).toEqual({ 0: { kind: 'json', text: BODY } })
    const status = await replicate.client.status('replicate://pred1')
    expect(rawTextOf(status.raw)).toBe(BODY)
  })
  it('fal: rawTextOf gives the result’s body text, and a value plan reads it', async () => {
    const FAL_BODY = '{"output": "x", "score": 1e5, "list": [1.0, -0.0]}'
    const fal = createFakeFal({ bodyText: () => FAL_BODY })
    const k = makeKit({ fal })
    const rec = (await run(k, { 1: image('raw-fal') })).takes[0]!.nodes['1']!
    expect(rec.values).toEqual({ 0: { kind: 'json', text: FAL_BODY } })
    expect(rawTextOf(await fal.client.result('fal://req1'))).toBe(FAL_BODY)
  })
  it('an answer nested past 1,000 levels fails the node in plain words', async () => {
    const deep = `${'['.repeat(5000)}${']'.repeat(5000)}`
    const replicate = createFakeReplicate({ bodyText: () => `{"id": "pred1", "status": "succeeded", "output": ${deep}}` })
    const k = makeKit({ replicate })
    const rec = (await run(k, { 1: image('json') })).takes[0]!.nodes['1']!
    expect([rec.status, rec.error]).toEqual(['error', PY_JSON_TOO_DEEP])
  })
  it('a programmed answer (no body text given) is remembered as its JSON', async () => {
    const replicate = createFakeReplicate({ answer: () => ['a', 'b'] })
    const k = makeKit({ replicate })
    const rec = (await run(k, { 1: image('raw-replicate') })).takes[0]!.nodes['1']!
    expect(JSON.parse((rec.values![0] as { text: string }).text).output).toEqual(['a', 'b'])
  })
})

describe('a pipeline of three calls', () => {
  const answers = () => createFakeReplicate({ answer: ({ model }) => `answer ${model}` })
  const pipe = (): ApiPrompt => ({ 1: video('pipeline') })
  const baseFor = (r: RunRecord) => (r.charges[0]!.includesBase ? BASE_RENDER_CREDITS : 0)
  /** Credits of the calls, each priced on its own (the one per-call calculation). */
  const per = (...usd: number[]) => usd.reduce((s, u) => s + creditsForUsd(u), 0)
  const reset = () => {
    PIPE.before = null
    PIPE.payloadOf = (key, i) => ({ prompt: `call ${key}`, n: i })
    PIPE.calls = [{ key: 'a', usd: 0.05 }, { key: 'b', usd: 0.03 }, { key: 'c', usd: 0.02 }]
    PIPE.parallel = false
    PIPE.download = false
  }
  /** The first server "crashes": its sleeps never return (runner-value-results' pattern). */
  const crashable = () => {
    const crash = { on: false }
    return { crash, sleep: () => crash.on ? new Promise<void>(() => {}) : new Promise<void>(r => setTimeout(r, 1)) }
  }

  it('sends all three in order; the hold and the charge are the sum of each call’s credits', async () => {
    reset()
    const replicate = answers()
    const k = makeKit({ hosted: true, replicate })
    const r = await run(k, pipe())
    const rec = r.takes[0]!.nodes['1']!
    expect(rec.status).toBe('done')
    expect(replicate.submitted().map(q => q.endpoint)).toEqual(['test/a', 'test/b', 'test/c'])
    expect(rec.values).toEqual({ 0: { kind: 'text', text: 'answer test/a|answer test/b|answer test/c' } })
    expect(rec.calls!.map(c => [c.key, c.status])).toEqual([['a', 'done'], ['b', 'done'], ['c', 'done']])
    expect(nodeCredits(pipe()['1']!)).toBe(per(0.05, 0.03, 0.02))
    expect(r.charges[0]!.estimate).toBe(per(0.05, 0.03, 0.02) + baseFor(r))
    expect(r.charges[0]!.actual).toBe(per(0.05, 0.03, 0.02) + baseFor(r))
  })
  it('two $0.08 calls: held and charged 16 + 16, never the markup of their $0.16 sum', async () => {
    reset()
    PIPE.calls = [{ key: 'a', usd: 0.08 }, { key: 'b', usd: 0.08 }]
    const k = makeKit({ hosted: true, replicate: answers() })
    const r = await run(k, pipe())
    expect(creditsForUsd(0.08)).toBe(16)
    expect(creditsForUsd(0.16)).toBe(24)
    expect(r.charges[0]!.estimate).toBe(32 + baseFor(r))
    expect(r.charges[0]!.actual).toBe(32 + baseFor(r))
    expect(k.deps.reportError).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ site: 'runner.charge.above-hold' }))
  })
  it('the second call fails: charged for the first only, the third never sent', async () => {
    reset()
    const replicate = answers()
    const k = makeKit({ hosted: true, replicate })
    PIPE.before = (key) => { if (key === 'b') replicate.failNext(1) }
    const r = await run(k, pipe())
    const rec = r.takes[0]!.nodes['1']!
    expect(rec.status).toBe('error')
    expect(replicate.submitted().map(q => q.endpoint)).toEqual(['test/a', 'test/b'])
    expect(rec.calls!.map(c => c.status)).toEqual(['done', 'error'])
    expect(r.charges[0]!.actual).toBe(per(0.05))
  })
  it('Stop during the second: the second is cancelled, charged the first', async () => {
    reset()
    const replicate = answers()
    const k = makeKit({ hosted: true, replicate })
    PIPE.before = (key) => { if (key === 'b') replicate.holdNext(1) }
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [pipe()], ...START })
    await until(() => (replicate.submitted()[1]?.polls ?? 0) >= 2)
    await k.engine.stop(k.userId)
    await k.engine.settled(runId)
    const r = (await k.store.get(runId))!
    const rec = r.takes[0]!.nodes['1']!
    expect(rec.status).toBe('stopped')
    expect(replicate.reqs.get('pred2')!.cancelled).toBe(true)
    expect(replicate.submitted()).toHaveLength(2)
    expect(r.charges[0]!.actual).toBe(per(0.05))
  })
  it('side by side, one refused: the node fails, every sibling is cancelled or never sent, and nothing is written after', async () => {
    reset()
    PIPE.parallel = true
    const replicate = answers()
    // Two calls at a time: a and b go out, c waits for a slot (the reviewer's case).
    const k = makeKit({ hosted: true, replicate, deps: { perUserLimit: 2 } })
    replicate.holdNext(3)
    replicate.failNext(1)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [pipe()], ...START })
    await until(() => replicate.submitted().length === 2 && replicate.submitted().every(q => q.polls >= 2))
    replicate.release('pred1') // a now fails at the provider
    await k.engine.settled(runId)
    const r = (await k.store.get(runId))!
    const rec = r.takes[0]!.nodes['1']!
    expect(rec.status).toBe('error')
    expect(rec.error).toContain('The input or output was flagged as sensitive')
    // b was cancelled; c was never sent, or cancelled if its send was under way.
    expect(replicate.reqs.get('pred2')!.cancelled).toBe(true)
    for (const q of replicate.submitted().slice(2)) expect(q.cancelled).toBe(true)
    expect(rec.calls!.find(c => c.key === 'a')!.status).toBe('error')
    expect(rec.calls!.filter(c => c.status === 'done')).toEqual([])
    expect(r.charges[0]!.actual).toBe(0)
    // Nothing moves after the node's final save and its charge.
    const before = JSON.stringify(r.takes[0]!.nodes['1'])
    await new Promise(res => setTimeout(res, 50))
    expect(JSON.stringify((await k.store.get(runId))!.takes[0]!.nodes['1'])).toBe(before)
    expect(replicate.submitted().length).toBeLessThanOrEqual(3)
  })
  it('a restart after the second call’s answer: resumed, the first two never sent again, the third sent once', async () => {
    reset()
    const replicate = answers()
    const hang = { on: true }
    PIPE.before = async (key) => { if (key === 'c' && hang.on) await new Promise<void>(() => {}) }
    const k1 = makeKit({ hosted: true, replicate })
    const { runId } = await k1.engine.startRun({ userId: k1.userId, takes: [pipe()], ...START })
    await until(() => replicate.submitted().length === 2 && replicate.submitted()[1]!.polls >= 2)
    // The first server stops right after writing down call b's answer (its pipeline hangs before call c).
    await new Promise(r => setTimeout(r, 30))
    const saved = (await k1.store.get(runId))!.takes[0]!.nodes['1']!
    expect(saved.calls!.map(c => c.status)).toEqual(['done', 'done'])
    hang.on = false
    const k2 = makeKit({ hosted: true, dir: k1.dir, root: k1.root, replicate, ledger: k1.ledger })
    expect(await k2.engine.reattach()).toBe(1)
    await k2.engine.settled(runId)
    const r = (await k2.store.get(runId))!
    expect(r.takes[0]!.nodes['1']!.status).toBe('done')
    expect(replicate.submitted().map(q => q.endpoint)).toEqual(['test/a', 'test/b', 'test/c'])
    expect(r.takes[0]!.nodes['1']!.values).toEqual({ 0: { kind: 'text', text: 'answer test/a|answer test/b|answer test/c' } })
    expect(r.charges[0]!.actual).toBe(per(0.05, 0.03, 0.02) + baseFor(r))
  })
  it('a restart while the second call is in flight, the same call: waits on its recorded request, never sends it again', async () => {
    reset()
    const replicate = answers()
    const { crash, sleep } = crashable()
    const k1 = makeKit({ hosted: true, replicate, deps: { sleep } })
    PIPE.before = (key) => { if (key === 'b') replicate.holdNext(1) }
    const { runId } = await k1.engine.startRun({ userId: k1.userId, takes: [pipe()], ...START })
    await until(() => (replicate.submitted()[1]?.polls ?? 0) >= 2)
    crash.on = true
    await new Promise(r => setTimeout(r, 20))
    PIPE.before = null
    replicate.release()
    const k2 = makeKit({ hosted: true, dir: k1.dir, root: k1.root, replicate, ledger: k1.ledger })
    expect(await k2.engine.reattach()).toBe(1)
    await k2.engine.settled(runId)
    const r = (await k2.store.get(runId))!
    expect(r.takes[0]!.nodes['1']!.status).toBe('done')
    expect(replicate.submitted().map(q => q.endpoint)).toEqual(['test/a', 'test/b', 'test/c'])
    expect(replicate.reqs.get('pred2')!.cancelled).toBe(false)
    expect(r.charges[0]!.actual).toBe(per(0.05, 0.03, 0.02) + baseFor(r))
  })
  it('a crash after the call was written down but before its request was: sent exactly once on resume', async () => {
    reset()
    const replicate = answers()
    const realSubmit = replicate.client.submit
    // The first server's send of call b never comes back.
    const first = { ...replicate, client: { ...replicate.client, submit: vi.fn((slug: string, p: Record<string, unknown>, o?: unknown) => slug === 'test/b' ? new Promise(() => {}) : (realSubmit as any)(slug, p, o)) as any } }
    const k1 = makeKit({ hosted: true, replicate: first })
    const { runId } = await k1.engine.startRun({ userId: k1.userId, takes: [pipe()], ...START })
    await until(() => (first.client.submit as any).mock.calls.length === 2)
    await new Promise(r => setTimeout(r, 20))
    const saved = (await k1.store.get(runId))!.takes[0]!.nodes['1']!
    expect(saved.calls!.map(c => [c.key, c.status, c.request])).toEqual([['a', 'done', expect.anything()], ['b', 'sent', null]])
    const k2 = makeKit({ hosted: true, dir: k1.dir, root: k1.root, replicate, ledger: k1.ledger })
    expect(await k2.engine.reattach()).toBe(1)
    await k2.engine.settled(runId)
    const r = (await k2.store.get(runId))!
    expect(r.takes[0]!.nodes['1']!.status).toBe('done')
    expect(replicate.submitted().map(q => q.endpoint)).toEqual(['test/a', 'test/b', 'test/c'])
  })
  it('a call whose first service is down moves to its backup once, and is charged once', async () => {
    reset()
    PIPE.calls = [{ key: 'a', usd: 0.05 }, { key: 'b', usd: 0.03, backup: true }, { key: 'c', usd: 0.02 }]
    const replicate = answers()
    const realSubmit = replicate.client.submit
    replicate.client.submit = vi.fn((slug: string, p: Record<string, unknown>, o?: unknown) =>
      slug === 'test/b' ? Promise.reject(new ReplicateError('Replicate predictions API HTTP 503: down', 503)) : (realSubmit as any)(slug, p, o)) as any
    const k = makeKit({ hosted: true, replicate, deps: { backup: () => ({ enabled: true, stallMs: 0 }) } })
    const r = await run(k, pipe())
    const rec = r.takes[0]!.nodes['1']!
    expect(rec.status).toBe('done')
    expect(k.fal.submitted().map(q => q.endpoint)).toEqual(['fal-b'])
    const b = rec.calls!.find(c => c.key === 'b')!
    expect([b.provider, b.endpoint, b.status, b.switchedFrom]).toEqual(['fal', 'fal-b', 'done', { provider: 'replicate', requestId: null }])
    expect(r.charges[0]!.actual).toBe(per(0.05, 0.03, 0.02) + baseFor(r))
  })
  it('a call whose file can’t be downloaded is not charged, and is reported lost', async () => {
    reset()
    PIPE.calls = [{ key: 'a', usd: 0.05 }, { key: 'b', usd: 0.03 }]
    PIPE.download = true
    const replicate = createFakeReplicate({ answer: ({ model }) => `https://r.test/${model.split('/')[1]}.wav` })
    const download = vi.fn(async (url: string) => {
      if (url.endsWith('/b.wav')) throw new Error('Could not download the result (404)')
      return { bytes: new TextEncoder().encode(bodyOf(url)), contentType: 'audio/wav' }
    })
    const k = makeKit({ hosted: true, replicate, deps: { download } })
    const r = await run(k, pipe())
    const rec = r.takes[0]!.nodes['1']!
    expect(rec.status).toBe('error')
    expect(rec.calls!.map(c => [c.key, c.status, c.lost ?? false])).toEqual([['a', 'done', false], ['b', 'done', true]])
    expect(r.charges[0]!.actual).toBe(per(0.05))
    expect(k.deps.reportError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ site: 'runner.download.lost', call: 'b' }))
    // The pipeline's download is capped at its kind's cap, whatever it asks.
    expect(download).toHaveBeenCalledWith('https://r.test/a.wav', opts('audio'))
  })
  it('a resumed pipeline whose second payload differs fails plainly and cancels the recorded request', async () => {
    reset()
    const replicate = answers()
    const { crash, sleep } = crashable()
    const k1 = makeKit({ hosted: true, replicate, deps: { sleep } })
    PIPE.before = (key) => { if (key === 'b') replicate.holdNext(1) }
    const { runId } = await k1.engine.startRun({ userId: k1.userId, takes: [pipe()], ...START })
    await until(() => (replicate.submitted()[1]?.polls ?? 0) >= 2)
    crash.on = true
    await new Promise(r => setTimeout(r, 20))
    PIPE.before = null
    PIPE.payloadOf = (key, i) => ({ prompt: key === 'b' ? 'changed' : `call ${key}`, n: i })
    const k2 = makeKit({ hosted: true, dir: k1.dir, root: k1.root, replicate, ledger: k1.ledger })
    expect(await k2.engine.reattach()).toBe(1)
    await k2.engine.settled(runId)
    const r = (await k2.store.get(runId))!
    const rec = r.takes[0]!.nodes['1']!
    expect(rec.status).toBe('error')
    expect(rec.error).toBe(PIPELINE_CALL_CHANGED)
    expect(replicate.reqs.get('pred2')!.cancelled).toBe(true)
    expect(replicate.submitted()).toHaveLength(2)
    expect(r.charges[0]!.actual).toBe(per(0.05))
  })
})

describe('a token-priced answer', () => {
  const charged = async (credits: unknown) => {
    const replicate = createFakeReplicate({ answer: () => ({ text: 'x', credits }) })
    const k = makeKit({ hosted: true, replicate })
    const r = await run(k, { 1: image('charge') })
    return { k, r, rec: r.takes[0]!.nodes['1']!, base: r.charges[0]!.includesBase ? BASE_RENDER_CREDITS : 0 }
  }
  const hold = () => nodeCredits(image('charge'))

  it('`chargeOf` lowers the charge', async () => {
    expect(hold()).toBeGreaterThan(1)
    const { k, r, rec, base } = await charged(1)
    expect(rec.credits).toBe(1)
    expect(r.charges[0]!.actual).toBe(1 + base)
    expect(k.deps.reportError).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ site: 'runner.charge.above-hold' }))
  })
  it('a fraction is rounded up to whole credits', async () => {
    const { rec, r, base } = await charged(1.2)
    expect(rec.credits).toBe(2)
    expect(r.charges[0]!.actual).toBe(2 + base)
  })
  it('one above the hold is charged the hold and reported', async () => {
    const { k, r, base } = await charged(999)
    expect(r.takes[0]!.nodes['1']!.credits).toBe(hold())
    expect(r.charges[0]!.actual).toBe(hold() + base)
    expect(k.deps.reportError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ site: 'runner.charge.above-hold', charge: 999, hold: hold() }))
  })
  // NaN and Infinity can't travel through a JSON answer: the plan's own figure is tested below.
  for (const bad of [-1, 'lots']) {
    it(`a charge of ${String(bad)} can’t be read: charged the hold and reported`, async () => {
      const { k, r, base } = await charged(bad)
      expect(r.takes[0]!.nodes['1']!.credits).toBe(hold())
      expect(r.charges[0]!.actual).toBe(hold() + base)
      expect(k.deps.reportError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ site: 'runner.charge.unreadable' }))
    })
  }
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`${String(bad)} can’t be read: charged the hold (settled, not released) and reported`, async () => {
      CHARGE.override = () => bad
      try {
        const { k, r, base } = await charged(1)
        expect(r.takes[0]!.nodes['1']!.credits).toBe(hold())
        expect(r.charges[0]!.actual).toBe(hold() + base)
        expect(r.charges[0]!.state).toBe('settled')
        expect(k.deps.reportError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ site: 'runner.charge.unreadable', charge: String(bad) }))
      }
      finally { CHARGE.override = null }
    })
  }
})

describe('answer downloads go through the safe-fetch policy', () => {
  it('a private, loopback or non-web address is refused plainly, locally and hosted', async () => {
    for (const hosted of [false, true]) {
      const once = safeAnswerFetch({ hosted, kind: 'image' })
      for (const url of ['http://127.0.0.1:9/a.png', 'http://10.0.0.1/a.png', 'http://[::1]/a.png', 'http://169.254.169.254/latest', 'file:///etc/passwd']) {
        await expect(once(url, {})).rejects.toThrow(ANSWER_REFUSED)
      }
    }
  })
  it('a refusal is final (never tried again); Stop ends a download; a 5xx is tried again', async () => {
    const sleep = vi.fn(async () => {})
    const refused = vi.fn(async () => { throw new FetchRefused(ANSWER_REFUSED) })
    await expect(downloadResult('https://x.test/a.png', { sleep, fetchOnce: refused })).rejects.toThrow(ANSWER_REFUSED)
    expect(refused).toHaveBeenCalledTimes(1)
    const stopped = new AbortController()
    stopped.abort()
    const never = vi.fn()
    await expect(downloadResult('https://x.test/a.png', { sleep, signal: stopped.signal, fetchOnce: never })).rejects.toThrow('Stopped')
    expect(never).not.toHaveBeenCalled()
    const flaky = vi.fn()
      .mockResolvedValueOnce({ status: 502, contentType: null, bytes: new Uint8Array() })
      .mockResolvedValueOnce({ status: 200, contentType: 'image/png', bytes: new Uint8Array([1]) })
    const got = await downloadResult('https://x.test/a.png', { sleep, fetchOnce: flaky, maxBytes: 5 })
    expect(Array.from(got.bytes)).toEqual([1])
    expect(flaky).toHaveBeenLastCalledWith('https://x.test/a.png', { maxBytes: 5 })
  })
  it('caps by kind: 512 MiB for pictures, sounds and 3D, 2 GiB for videos (R3.6: 1 MiB of layer JSON); a larger ask is clamped', () => {
    expect(ANSWER_MAX_BYTES).toEqual({ image: 512 * MIB, audio: 512 * MIB, glb: 512 * MIB, video: 2048 * MIB, json: MIB })
    expect(answerCap('audio', 4096 * MIB)).toBe(512 * MIB)
    expect(answerCap('video')).toBe(2048 * MIB)
    expect(answerCap('glb', 10)).toBe(10)
  })
  it('a video plan downloads under the video cap', async () => {
    const download = byExt()
    const k = makeKit({ deps: { download } })
    await run(k, { 1: video(null) })
    expect(download).toHaveBeenCalledWith('https://fal.media/req1.mp4', opts('video', 2048 * MIB))
  })
  it('an extension comes from its kind’s list, never from the address alone', () => {
    expect(answerExt('image', new Uint8Array(), null, 'https://x.test/a.html')).toBe('png')
    expect(answerExt('image', new Uint8Array(), 'image/jpeg', 'https://x.test/a.svg')).toBe('jpg')
    expect(answerExt('video', new Uint8Array(), null, 'https://x.test/a.exe')).toBe('mp4')
    expect(answerExt('video', new Uint8Array(), 'video/webm', 'https://x.test/a')).toBe('webm')
    expect(soundExtOf(new TextEncoder().encode('fLaC'))).toBe('flac')
    expect(soundExtOf(new Uint8Array([0xff, 0xf1]))).toBe('aac')
    expect(soundExtOf(new Uint8Array([0xff, 0xfb]))).toBe('mp3')
    expect(() => answerExt('glb', new TextEncoder().encode('<svg'), 'model/gltf-binary', 'https://x.test/a.glb')).toThrow(ANSWER_NOT_GLB)
  })
})
