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
import { PIPELINE_CALL_CHANGED } from '~~/server/runner/engine'
import { userSubfolder } from '~~/server/runner/results'
import { outputKey } from '~~/server/utils/graphRuns'
import type { PipelineIO } from '~~/server/runner/executors'
import type { RunRecord } from '~~/server/runner/types'

/** What the stand-in pipeline does, set by each test. */
const PIPE = vi.hoisted(() => ({
  before: null as null | ((key: string) => void | Promise<void>),
  payloadOf: (key: string, i: number): Record<string, unknown> => ({ prompt: `call ${key}`, n: i }),
}))
const USD = [0.05, 0.03, 0.02]

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
            const got: string[] = []
            for (const [i, key] of ['a', 'b', 'c'].entries()) {
              await PIPE.before?.(key)
              const r = await io.call({ key, provider: 'replicate', endpoint: `test/${key}`, payload: PIPE.payloadOf(key, i), media: 'value', usd: USD[i]! })
              got.push(String((r.result as { output?: unknown }).output))
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
        case 'charge':
          return {
            ...onReplicate, media: 'value' as const,
            valuesOf: (r: any) => ({ 0: { kind: 'text' as const, text: String(r.output.text) } }),
            chargeOf: (r: any) => r.output.credits as number,
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

const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const CARDS: ReadonlySet<RunnerFamily> = new Set(['cards'])
const image = (test: string, seed = 0) => ({ class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'p', aspect_ratio: '1:1', seed, model_options: '{}', test_plan: test } })
const video = (test: string | null, seed = 0, first?: [string, number]) => ({
  class_type: 'GenerateVideoNode',
  inputs: { model: 'hailuo-h3', prompt: 'p', aspect_ratio: '16:9', duration: '5', seed, model_options: '{}', ...(test ? { test_plan: test } : {}), ...(first ? { image: first } : {}) },
})
const TYPES: Record<string, string> = { wav: 'audio/wav', mp3: 'audio/mpeg', glb: 'model/gltf-binary', png: 'image/png', mp4: 'video/mp4' }
/** Downloads the URL's own text as its bytes, typed by its extension (or untyped when `typed` is false). */
const byExt = (typed = true) => vi.fn(async (url: string) => ({
  bytes: new TextEncoder().encode(url),
  contentType: typed ? TYPES[url.slice(url.lastIndexOf('.') + 1)] ?? null : null,
}))
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
    expect(read(k, rec.outputs[0]!).toString()).toBe('https://replicate.delivery/audio.wav')
    expect(download).toHaveBeenCalledWith('https://replicate.delivery/audio.wav', { maxBytes: 512 * 1024 * 1024 })
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
  it('falls back to .wav when neither the type nor the address says', async () => {
    const replicate = createFakeReplicate({ answer: () => 'https://replicate.delivery/sound' })
    const k = makeKit({ replicate, deps: { download: byExt(false) } })
    expect((await run(k, { 1: image('audio') })).takes[0]!.nodes['1']!.outputs.map(f => f.filename)).toEqual(['music_00001_.wav'])
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
    expect(read(k, file).toString()).toBe('https://replicate.delivery/model.glb')
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
    expect(k.deps.download).toHaveBeenCalledWith('https://r.test/1.png', { maxBytes: 512 * 1024 * 1024 })
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
  const holdOf = () => nodeCredits(pipe()['1']!)
  const baseFor = (r: RunRecord) => (r.charges[0]!.includesBase ? BASE_RENDER_CREDITS : 0)
  const reset = () => {
    PIPE.before = null
    PIPE.payloadOf = (key, i) => ({ prompt: `call ${key}`, n: i })
  }

  it('sends all three in order and is charged creditsForUsd(Σ usd)', async () => {
    reset()
    expect(holdOf()).toBeGreaterThanOrEqual(creditsForUsd(0.1))
    const replicate = answers()
    const k = makeKit({ hosted: true, replicate })
    const r = await run(k, pipe())
    const rec = r.takes[0]!.nodes['1']!
    expect(rec.status).toBe('done')
    expect(replicate.submitted().map(q => q.endpoint)).toEqual(['test/a', 'test/b', 'test/c'])
    expect(rec.values).toEqual({ 0: { kind: 'text', text: 'answer test/a|answer test/b|answer test/c' } })
    expect(rec.calls!.map(c => [c.key, c.status])).toEqual([['a', 'done'], ['b', 'done'], ['c', 'done']])
    expect(r.charges[0]!.actual).toBe(creditsForUsd(0.1) + baseFor(r))
    // The hold was the node's price (its ceiling), the charge is never above it.
    expect(r.charges[0]!.estimate).toBe(holdOf() + baseFor(r))
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
    expect(r.charges[0]!.actual).toBe(creditsForUsd(0.05))
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
    expect(r.charges[0]!.actual).toBe(creditsForUsd(0.05))
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
    expect(r.charges[0]!.actual).toBe(creditsForUsd(0.1) + baseFor(r))
  })
  it('a resumed pipeline whose second payload differs fails plainly and cancels the recorded request', async () => {
    reset()
    const replicate = answers()
    const crash = { on: false }
    const k1 = makeKit({ hosted: true, replicate, deps: { sleep: () => crash.on ? new Promise<void>(() => {}) : new Promise<void>(r => setTimeout(r, 1)) } })
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
    expect(r.charges[0]!.actual).toBe(creditsForUsd(0.05))
  })
})

describe('a token-priced answer', () => {
  it('`chargeOf` lowers the charge', async () => {
    const replicate = createFakeReplicate({ answer: () => ({ text: 'short', credits: 1 }) })
    const k = makeKit({ hosted: true, replicate })
    const r = await run(k, { 1: image('charge') })
    const rec = r.takes[0]!.nodes['1']!
    expect(nodeCredits(image('charge'))).toBeGreaterThan(1)
    expect(rec.credits).toBe(1)
    expect(r.charges[0]!.actual).toBe(1 + (r.charges[0]!.includesBase ? BASE_RENDER_CREDITS : 0))
    expect(k.deps.reportError).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ site: 'runner.charge.above-hold' }))
  })
  it('one above the hold is charged the hold and reported', async () => {
    const replicate = createFakeReplicate({ answer: () => ({ text: 'long', credits: 999 }) })
    const k = makeKit({ hosted: true, replicate })
    const r = await run(k, { 1: image('charge') })
    const hold = nodeCredits(image('charge'))
    expect(r.takes[0]!.nodes['1']!.credits).toBe(hold)
    expect(r.charges[0]!.actual).toBe(hold + (r.charges[0]!.includesBase ? BASE_RENDER_CREDITS : 0))
    expect(k.deps.reportError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ site: 'runner.charge.above-hold', charge: 999, hold }))
  })
})

describe('the download cap', () => {
  it('a file over the cap fails plainly, at once, by its length or as it arrives', async () => {
    const { RESULT_TOO_LARGE, downloadResult } = await import('~~/server/runner/falQueue')
    const sleep = vi.fn(async () => {})
    const declared = vi.fn(async () => new Response(new Uint8Array(10), { headers: { 'content-length': '11' } }))
    vi.stubGlobal('fetch', declared)
    await expect(downloadResult('https://x.test/a.glb', { sleep, maxBytes: 10 })).rejects.toThrow(RESULT_TOO_LARGE(10))
    const streamed = vi.fn(async () => new Response(new ReadableStream({
      start(c) { c.enqueue(new Uint8Array(6)); c.enqueue(new Uint8Array(6)); c.close() },
    })))
    vi.stubGlobal('fetch', streamed)
    await expect(downloadResult('https://x.test/a.glb', { sleep, maxBytes: 10 })).rejects.toThrow(RESULT_TOO_LARGE(10))
    expect(sleep).not.toHaveBeenCalled()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(10), { headers: { 'content-type': 'model/gltf-binary' } })))
    const ok = await downloadResult('https://x.test/a.glb', { sleep, maxBytes: 10 })
    expect([ok.bytes.byteLength, ok.contentType]).toEqual([10, 'model/gltf-binary'])
    vi.unstubAllGlobals()
  })
})
