import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createLimiter } from '~~/server/runner/engine'
import { createFileRunStore, type RunStore } from '~~/server/runner/store'
import { deliveredToOutput, outputReadsOf } from '~~/server/utils/renderCredit'
import type { RunRecord } from '~~/server/runner/types'
import { createFakeFal, makeKit, gatedFlow, ofType, types, until } from './__runner__/kit'
import type { ApiPrompt } from '#shared/runner/graph'
import { showing } from './__runner__/paidParity'

describe('limiter', () => {
  it('lets four through per user and queues the rest in order', async () => {
    const l = createLimiter(4)
    const ctl = new AbortController()
    for (let i = 0; i < 4; i++) await l.acquire('u', ctl.signal)
    const order: number[] = []
    const fifth = l.acquire('u', ctl.signal).then(() => order.push(5))
    const sixth = l.acquire('u', ctl.signal).then(() => order.push(6))
    await l.acquire('other', ctl.signal) // another user is not held up
    expect(l.inFlight('u')).toBe(4)
    expect(l.waiting('u')).toBe(2)
    l.release('u'); await fifth
    l.release('u'); await sixth
    expect(order).toEqual([5, 6])
  })
  it('a stopped run leaves the queue', async () => {
    const l = createLimiter(1)
    await l.acquire('u', new AbortController().signal)
    const ctl = new AbortController()
    const p = l.acquire('u', ctl.signal)
    ctl.abort()
    await expect(p).rejects.toThrow('Stopped')
    expect(l.waiting('u')).toBe(0)
  })
})

describe('run → Gate', () => {
  it('makes the image, shows it, pauses at the Gate and does not start the video', async () => {
    const k = makeKit()
    const { runId, legId, promptIds } = await k.engine.startRun({ userId: null, takes: [gatedFlow()], workflow: { nodes: [] }, canvasId: 'c1', projectUuid: null, projectName: null })
    expect(legId).toBe(`${runId}.0`)
    expect(promptIds).toEqual([`${runId}.0.t0`])
    await k.engine.settled(runId)

    expect(k.fal.submitted().map(r => r.endpoint)).toEqual(['fal-ai/flux/schnell'])
    const stage = promptIds[0]!
    expect(types(k.seen)).toContain('execution_start')
    expect(ofType(k.seen, 'queue_position')[0]!.data).toMatchObject({ prompt_id: stage, node: '1', position: 2 })
    const executed = ofType(k.seen, 'executed')
    expect(executed.map(m => m.data.node)).toEqual(['1', '5'])
    const img = (executed[0]!.data.output as any).images[0]
    expect(img).toEqual({ filename: 'generate_image_00001_.png', subfolder: '', type: 'output' })
    expect(existsSync(join(k.root, 'output', img.filename))).toBe(true)
    expect(ofType(k.seen, 'execution_success')[0]!.data).toMatchObject({ prompt_id: stage, run_id: runId, recorded: true, credits: null })
    const paused = ofType(k.seen, 'gate_paused')
    expect(paused).toHaveLength(1)
    expect(paused[0]!.data).toEqual({ prompt_id: legId, run_id: runId, node_id: '2', choices: [{ take: 0, files: [img] }], picked: [0], canvas_id: 'c1' })
    // the pause is the last word
    expect(k.seen.at(-1)!.type).toBe('gate_paused')

    const saved = await k.store.get(runId)
    expect(saved!.status).toBe('paused')
    expect(saved!.takes[0]!.nodes['3']!.status).toBe('waiting')
    expect(k.records.write).toHaveBeenCalledTimes(1)
  })

  it('a Gate with pass-through on runs everything in one go', async () => {
    const k = makeKit()
    const { runId } = await k.engine.startRun({ userId: null, takes: [gatedFlow({ bypass: true })], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await k.engine.settled(runId)
    expect(k.fal.submitted().map(r => r.endpoint)).toEqual(['fal-ai/flux/schnell', 'minimax/h3/image-to-video'])
    expect(k.fal.submitted()[1]!.payload.image_url).toBe('https://fal.storage/generate_image_00001_.png')
    const videoCard = ofType(k.seen, 'executed').find(m => m.data.node === '4')!
    expect((videoCard.data.output as any)).toEqual({ images: [{ filename: 'generate_video_00001_.mp4', subfolder: '', type: 'output' }], animated: [true] })
    expect(ofType(k.seen, 'gate_paused')).toHaveLength(0)
    expect((await k.store.get(runId))!.status).toBe('done')
  })

  it('refuses a workflow the runner cannot take', async () => {
    const k = makeKit()
    const bad: ApiPrompt = { '1': { class_type: 'ImageBlur', inputs: {} } }
    await expect(k.engine.startRun({ userId: null, takes: [bad], workflow: null, canvasId: null, projectUuid: null, projectName: null }))
      .rejects.toMatchObject({ statusCode: 400 })
    await expect(k.engine.startRun({ userId: null, takes: [], workflow: null, canvasId: null, projectUuid: null, projectName: null }))
      .rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('money (hosted)', () => {
  it('holds only the first stage (+ the render credit once) and charges it exactly', async () => {
    const k = makeKit({ hosted: true })
    const { runId, promptIds } = await k.engine.startRun({ userId: 'user_1', takes: [gatedFlow()], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await k.engine.settled(runId)
    expect(k.ledger.hold).toHaveBeenCalledTimes(1)
    // flux-schnell 1:1 is 1024² = 2 MP under the megapixel ruling (ceil(pixels / 1e6)): 2 credits + the render.
    expect(k.ledger.hold).toHaveBeenCalledWith('user_1', 3, `runner:${promptIds[0]}`)
    expect(k.ledger.settle).toHaveBeenCalledWith(1, 3, `runner:${promptIds[0]}`)
    expect(ofType(k.seen, 'execution_success')[0]!.data.credits).toBe(3)
    expect(k.graphRuns.appendOutput).toHaveBeenCalledWith(promptIds[0], expect.stringMatching(/^output:u_[0-9a-f]{12}:generate_image_00001_\.png$/))
  })
  it('the render credit goes to the first take that makes something, not to take 0', async () => {
    const k = makeKit({ hosted: true })
    const a = await k.engine.startRun({ userId: 'user_1', takes: [gatedFlow({ imageSeed: 7 })], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await k.engine.settled(a.runId)
    const b = await k.engine.startRun({ userId: 'user_1', takes: [gatedFlow({ imageSeed: 7 }), gatedFlow({ imageSeed: 8 })], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await k.engine.settled(b.runId)
    expect(k.fal.submitted()).toHaveLength(2) // take 0 was reused
    // every take's hold is an upper bound that includes the render credit
    expect(k.ledger.hold).toHaveBeenCalledWith('user_1', 3, `runner:${b.promptIds[0]}`)
    expect(k.ledger.hold).toHaveBeenCalledWith('user_1', 3, `runner:${b.promptIds[1]}`)
    const run = (await k.store.get(b.runId))!
    expect(run.charges.map(c => [c.state, c.actual])).toEqual([['released', 0], ['settled', 3]])
    expect(run.baseCharged).toBe(true)
    const credits = (i: number) => ofType(k.seen, 'execution_success').find(m => m.data.prompt_id === b.promptIds[i])!.data.credits
    expect([credits(0), credits(1)]).toEqual([0, 3])
  })
  it('refuses before anything runs when credits are short', async () => {
    const k = makeKit({ hosted: true, available: 1 })
    await expect(k.engine.startRun({ userId: 'user_1', takes: [gatedFlow()], workflow: null, canvasId: null, projectUuid: null, projectName: null }))
      .rejects.toMatchObject({ statusCode: 402, data: { required: 3, available: 1 } })
    expect(k.fal.client.submit).not.toHaveBeenCalled()
  })
  it('a failed request drops the hold, skips what comes after and says why', async () => {
    const k = makeKit({ hosted: true })
    k.fal.failNext(1)
    const { runId, promptIds } = await k.engine.startRun({ userId: 'user_1', takes: [gatedFlow({ bypass: true })], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await k.engine.settled(runId)
    expect(k.fal.submitted()).toHaveLength(1) // the video never went out
    expect(k.ledger.release).toHaveBeenCalledWith(1)
    expect(k.ledger.settle).not.toHaveBeenCalled()
    const err = ofType(k.seen, 'execution_error')[0]!
    expect(err.data).toMatchObject({ prompt_id: promptIds[0], node_id: '1', node_type: 'GenerateImageNode', exception_message: 'The provider refused this prompt', credits: 0 })
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('error')
    expect(run.takes[0]!.nodes['3']!.status).toBe('skipped')
  })
})

describe('the render credit on a stage that did not finish (R3.18 ruling: only on something made and shown)', () => {
  const g = (prompt: string): ApiPrompt[string] => ({ class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt, aspect_ratio: '1:1', seed: 0, model_options: '{}' } })
  const card = (from: string): ApiPrompt[string] => ({ class_type: 'Image', inputs: { image: '', export: false, images: [from, 0], batch_index: -1 } })
  const upload = (): ApiPrompt[string] => ({ class_type: 'Image', inputs: { image: 'in.png', export: false, filename_prefix: 'ComfyUI', batch_index: -1 } })

  describe('outputReadsOf and deliveredToOutput (renderCredit.ts, shared with the ComfyUI path)', () => {
    it('an output reads itself and every node upstream of it, through a Gate; a node no output reads is in none', () => {
      const p: ApiPrompt = { ...gatedFlow(), '9': g('dangling') }
      expect(outputReadsOf(p)).toEqual({ '4': ['1', '2', '3', '4'], '5': ['1', '5'] })
    })
    it('delivered only when an output that ran is, or reads, a node that made something', () => {
      const reads = outputReadsOf(gatedFlow())
      expect(deliveredToOutput(reads, new Set(['1', '5']), new Set(['1']))).toBe(true)
      expect(deliveredToOutput(reads, new Set(['1']), new Set(['1'])), 'the image made, its card never ran').toBe(false)
      expect(deliveredToOutput(reads, new Set(['1', '2', '4']), new Set(['1'])), 'the Video card ran, reading the image through the Gate').toBe(true)
      expect(deliveredToOutput(reads, new Set(['5']), new Set()), 'an output ran, but nothing it reads was made').toBe(false)
    })
    it('a Frame render shows its render on the canvas: it is an output, and a finished one delivers itself (R1.5 ruling)', () => {
      const p: ApiPrompt = { f: { class_type: 'Compositor', inputs: {} }, n: g('x'), s: { class_type: 'SaveImage', inputs: { images: ['f', 0] } } }
      const reads = outputReadsOf(p)
      expect(reads).toEqual({ f: ['f'], s: ['f', 's'] })
      expect(deliveredToOutput(reads, new Set(['f']), new Set(['f']))).toBe(true)
    })
    it('a source card (an Image card showing an upload) is an output, but shows nothing the run made', () => {
      const p: ApiPrompt = { c: upload(), n: g('x') }
      const reads = outputReadsOf(p)
      expect(reads).toEqual({ c: ['c'] })
      expect(deliveredToOutput(reads, new Set(['c', 'n']), new Set(['n']))).toBe(false)
    })
  })

  // The image goes out held; the video, sent once it is released, fails at the provider.
  async function imageThenFailedVideo(prompt: ApiPrompt) {
    const k = makeKit({ hosted: true })
    k.fal.holdNext(1)
    const { runId, promptIds } = await k.engine.startRun({ userId: 'user_1', takes: [prompt], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await until(() => k.fal.submitted().length === 1)
    k.fal.failNext(1)
    k.fal.release()
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('error')
    expect(k.fal.submitted().map(r => [r.endpoint, r.failWith !== null])).toEqual([['fal-ai/flux/schnell', false], ['minimax/h3/image-to-video', true]])
    const hold = (k.ledger.hold as any).mock.calls[0]![1] as number
    return { k, run, hold, promptIds, credits: ofType(k.seen, 'execution_error')[0]!.data.credits }
  }

  it('UNCHANGED: a paid picture made and shown by its Image card, another branch failing: the picture and the render credit', async () => {
    const { k, run, credits } = await imageThenFailedVideo(gatedFlow({ bypass: true }))
    expect(run.takes[0]!.nodes['5']!.status).toBe('done')
    // flux-schnell 1:1 is 2 credits; the video failed and is not charged.
    expect(k.ledger.settle).toHaveBeenCalledWith(1, 3, expect.any(String))
    expect(credits).toBe(3)
    expect(run.baseCharged).toBe(true)
  })

  it('CHANGED: a paid picture made but read only by the failed video, nothing shown: the picture only, no render credit (was the picture + 1)', async () => {
    const p: ApiPrompt = {
      '1': g('a red fox'),
      '3': { class_type: 'GenerateVideoNode', inputs: { model: 'hailuo-h3', prompt: 'the fox runs', image: ['1', 0], aspect_ratio: '16:9', duration: '5', seed: 0, model_options: '{}' } },
      '4': { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'video/ComfyUI', source: ['3', 0] } },
    }
    const { k, run, hold, credits } = await imageThenFailedVideo(p)
    expect(run.takes[0]!.nodes['1']!.status).toBe('done')
    expect(run.takes[0]!.nodes['4']!.status).toBe('skipped')
    expect(hold, 'the hold still covers the render credit').toBeGreaterThan(3)
    expect(k.ledger.settle).toHaveBeenCalledWith(1, 2, expect.any(String))
    expect(credits).toBe(2)
    expect(run.baseCharged).toBe(false)
  })

  it('UNCHANGED: a stage that finishes earns the render credit on its charge, as before', async () => {
    const k = makeKit({ hosted: true })
    const { runId } = await k.engine.startRun({ userId: 'user_1', takes: [{ '1': g('a'), '5': card('1') }], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await k.engine.settled(runId)
    expect(k.ledger.settle).toHaveBeenCalledWith(1, 3, expect.any(String))
  })
})

describe('parallel work', () => {
  // Each shown by an Image card: only what an output reads runs (R3.8 fix round 1).
  const twoBranches: ApiPrompt = showing({
    '1': { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a', aspect_ratio: '1:1', seed: 0, model_options: '{}' } },
    '2': { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'b', aspect_ratio: '1:1', seed: 0, model_options: '{}' } },
  })
  it('two independent branches go out at the same time', async () => {
    const k = makeKit()
    k.fal.holdNext(2)
    const { runId } = await k.engine.startRun({ userId: null, takes: [twoBranches], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await until(() => k.fal.submitted().length === 2)
    k.fal.release()
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.status).toBe('done')
  })
  it('the fifth call waits for a free slot', async () => {
    const k = makeKit()
    const five: ApiPrompt = {}
    for (let i = 1; i <= 5; i++) five[String(i)] = { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: `p${i}`, aspect_ratio: '1:1', seed: 0, model_options: '{}' } }
    k.fal.holdNext(5)
    const { runId } = await k.engine.startRun({ userId: null, takes: [showing(five)], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await until(() => k.fal.submitted().length === 4)
    await new Promise(r => setTimeout(r, 20))
    expect(k.fal.submitted()).toHaveLength(4)
    k.fal.release(k.fal.submitted()[0]!.id)
    await until(() => k.fal.submitted().length === 5)
    k.fal.release()
    await k.engine.settled(runId)
  })
})

describe('never pay twice', () => {
  it('an identical request with a fixed seed reuses the earlier file and charges nothing', async () => {
    const k = makeKit({ hosted: true })
    const a = await k.engine.startRun({ userId: 'user_1', takes: [gatedFlow({ imageSeed: 7 })], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await k.engine.settled(a.runId)
    const b = await k.engine.startRun({ userId: 'user_1', takes: [gatedFlow({ imageSeed: 7 })], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await k.engine.settled(b.runId)
    expect(k.fal.submitted()).toHaveLength(1)
    const first = ofType(k.seen, 'executed').filter(m => m.data.node === '1')
    expect(first[1]!.data.output).toEqual(first[0]!.data.output)
    const successB = ofType(k.seen, 'execution_success').find(m => m.data.prompt_id === b.promptIds[0])!
    expect(successB.data.credits).toBe(0)
    expect(k.ledger.release).toHaveBeenCalledWith(2)
  })
  it('a reused result writes no second history record', async () => {
    const k = makeKit()
    for (let i = 0; i < 2; i++) {
      const r = await k.engine.startRun({ userId: null, takes: [gatedFlow({ imageSeed: 7 })], workflow: null, canvasId: null, projectUuid: 'p1', projectName: 'P' })
      await k.engine.settled(r.runId)
    }
    expect(k.fal.submitted()).toHaveLength(1) // the second run was reused
    expect(k.records.write).toHaveBeenCalledTimes(1)
  })
  it('seed 0 always asks again', async () => {
    const k = makeKit()
    for (let i = 0; i < 2; i++) {
      const r = await k.engine.startRun({ userId: null, takes: [gatedFlow({ imageSeed: 0 })], workflow: null, canvasId: null, projectUuid: null, projectName: null })
      await k.engine.settled(r.runId)
    }
    expect(k.fal.submitted()).toHaveLength(2)
  })
})

describe('when things go wrong', () => {
  it('a save that fails after the image is made still ends the leg and sends the closing event', async () => {
    const inner = createFileRunStore(mkdtempSync(join(tmpdir(), 'runner-engine-failing-')))
    let failing = false
    let lastAttempt: RunRecord | null = null
    const store: RunStore = {
      ...inner,
      save: async (run) => {
        lastAttempt = run
        if (failing) throw new Error('disk full')
        return inner.save(run)
      },
    }
    const k = makeKit({
      deps: {
        store,
        download: async (url: string) => {
          failing = true
          return { bytes: new TextEncoder().encode(url), contentType: 'image/png' }
        },
      },
    })
    const { runId, promptIds } = await k.engine.startRun({ userId: null, takes: [gatedFlow()], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await k.engine.settled(runId)
    const closing = k.seen.filter(m => (m.type === 'execution_success' || m.type === 'execution_error') && m.data.prompt_id === promptIds[0])
    expect(closing).toHaveLength(1)
    const last = lastAttempt as RunRecord | null
    expect(last!.legs[0]!.status).toBe('done')
    expect(last!.status).not.toBe('running')
    expect(k.deps.reportError).toHaveBeenCalled()
    // R3.18 ruling: the Image card showing the picture failed, so nothing reached an output: no render credit (local, so no money moves; was set).
    expect(last!.takes[0]!.nodes['5']!.status).toBe('error')
    expect(last!.baseCharged).toBe(false)
  })
  it('a failed save right after the result is kept does not turn the finished node into an error', async () => {
    const inner = createFileRunStore(mkdtempSync(join(tmpdir(), 'runner-engine-failing-once-')))
    let failOnce = false
    const store: RunStore = {
      ...inner,
      save: async (run) => {
        if (failOnce) { failOnce = false; throw new Error('disk hiccup') }
        return inner.save(run)
      },
    }
    const k = makeKit({
      hosted: true,
      deps: {
        store,
        download: async (url: string) => {
          failOnce = true // the next save is the one right after the result is kept
          return { bytes: new TextEncoder().encode(url), contentType: 'image/png' }
        },
      },
    })
    const { runId, promptIds } = await k.engine.startRun({ userId: 'user_1', takes: [gatedFlow()], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await k.engine.settled(runId)
    const run = (await store.get(runId))!
    expect(run.takes[0]!.nodes['1']!.status).toBe('done')
    expect(run.status).toBe('paused')
    expect(ofType(k.seen, 'execution_error')).toHaveLength(0)
    expect(ofType(k.seen, 'executed').some(m => m.data.node === '1')).toBe(true)
    expect(ofType(k.seen, 'execution_success').find(m => m.data.prompt_id === promptIds[0])!.data.credits).toBe(3)
    expect(k.deps.reportError).toHaveBeenCalledWith(expect.objectContaining({ message: 'disk hiccup' }), expect.objectContaining({ site: 'runner.node.save' }))
  })
  it('a finished run lets go of its memory; settled() still answers and the next run works', async () => {
    const k = makeKit()
    const first = await k.engine.startRun({ userId: null, takes: [gatedFlow({ bypass: true })], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await k.engine.settled(first.runId)
    expect((await k.store.get(first.runId))!.status).toBe('done')
    const second = await k.engine.startRun({ userId: null, takes: [gatedFlow({ bypass: true })], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    const quick = await Promise.race([
      k.engine.settled(first.runId).then(() => 'settled'),
      new Promise(r => setTimeout(() => r('late'), 50)),
    ])
    expect(quick).toBe('settled')
    await k.engine.settled(second.runId)
    expect((await k.store.get(second.runId))!.status).toBe('done')
  })
})

describe('too many runs waiting', () => {
  const fiveImages = (tag: string): ApiPrompt => {
    const p: ApiPrompt = {}
    for (let i = 1; i <= 5; i++) p[String(i)] = { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: `${tag}${i}`, aspect_ratio: '1:1', seed: 0, model_options: '{}' } }
    return showing(p)
  }
  const start = (k: ReturnType<typeof makeKit>, n: number, tag: string, userId: string | null = k.userId) =>
    k.engine.startRun({ userId, takes: Array.from({ length: n }, (_, t) => fiveImages(`${tag}${t}-`)), workflow: null, canvasId: null, projectUuid: null, projectName: null })

  it('refuses a run that would put more than 32 provider calls in line for one user', async () => {
    const k = makeKit()
    k.fal.holdNext(100)
    const first = await start(k, 4, 'a') // 20 calls
    await until(() => k.fal.submitted().length === 4)
    await expect(start(k, 3, 'b')).rejects.toMatchObject({ statusCode: 429, message: 'You have too many runs waiting. Try again when one finishes.' })
    const ok = await start(k, 2, 'c') // 20 + 10 = 30: fine
    await expect(start(k, 1, 'd')).rejects.toMatchObject({ statusCode: 429 }) // 30 + 5 = 35
    k.fal.holdNext(0)
    k.fal.release()
    await k.engine.settled(first.runId)
    await k.engine.settled(ok.runId)
    const again = await start(k, 4, 'e') // everything finished: the line is empty again
    k.fal.holdNext(0)
    k.fal.release()
    await k.engine.settled(again.runId)
  })
  it('another user’s runs do not count', async () => {
    const k = makeKit({ hosted: true, available: 100_000 })
    k.fal.holdNext(100)
    const first = await start(k, 6, 'a', 'user_1') // 30 calls
    await until(() => k.fal.submitted().length === 4)
    const other = await start(k, 6, 'b', 'user_2')
    k.fal.holdNext(0)
    k.fal.release()
    await k.engine.settled(first.runId)
    await k.engine.settled(other.runId)
  })
})

describe('the saved workflow', () => {
  it('is kept as sent, unless it is over 2 MB (then Open workflow falls back)', async () => {
    const k = makeKit()
    const small = await k.engine.startRun({ userId: null, takes: [gatedFlow({ bypass: true })], workflow: { nodes: ['as run'] }, canvasId: null, projectUuid: null, projectName: null })
    await k.engine.settled(small.runId)
    expect((await k.store.get(small.runId))!.workflow).toEqual({ nodes: ['as run'] })
    const huge = { nodes: ['x'.repeat(2_000_001)] }
    const big = await k.engine.startRun({ userId: null, takes: [gatedFlow({ bypass: true })], workflow: huge, canvasId: null, projectUuid: null, projectName: null })
    await k.engine.settled(big.runId)
    expect((await k.store.get(big.runId))!.workflow).toBeNull()
  })
})

describe('every message names its canvas', () => {
  it('published messages and the catch-up snapshot carry canvas_id', async () => {
    const k = makeKit()
    k.fal.holdNext(1)
    const { runId } = await k.engine.startRun({ userId: null, takes: [gatedFlow()], workflow: null, canvasId: 'canvas-7', projectUuid: null, projectName: null })
    await until(() => k.fal.submitted().length === 1)
    const snap = k.engine.snapshot(null)
    expect(snap.length).toBeGreaterThan(0)
    expect(snap.every(m => m.data.canvas_id === 'canvas-7')).toBe(true)
    k.fal.release()
    await k.engine.settled(runId)
    for (const t of ['execution_start', 'executing', 'queue_position', 'executed', 'execution_success', 'gate_paused']) expect(types(k.seen)).toContain(t)
    expect(k.seen.every(m => m.data.canvas_id === 'canvas-7')).toBe(true)
    const paused = k.engine.snapshot(null)
    expect(paused.map(m => [m.type, m.data.canvas_id])).toEqual([['gate_paused', 'canvas-7']])
  })
  it('a run without a canvas says so (null)', async () => {
    const k = makeKit()
    const { runId } = await k.engine.startRun({ userId: null, takes: [gatedFlow({ bypass: true })], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await k.engine.settled(runId)
    expect(k.seen.every(m => 'canvas_id' in m.data && m.data.canvas_id === null)).toBe(true)
  })
})

describe('network blips (fal still bills the request)', () => {
  const blip = () => { throw new TypeError('fetch failed') }
  it('a status check that gets no answer is tried again, not failed', async () => {
    const k = makeKit()
    vi.mocked(k.fal.client.status).mockImplementationOnce(async () => blip())
    const { runId } = await k.engine.startRun({ userId: null, takes: [gatedFlow()], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.takes[0]!.nodes['1']!.status).toBe('done')
    expect(run.status).toBe('paused')
    expect(k.fal.submitted()).toHaveLength(1)
  })
  it('fetching the finished result is tried again after a network error', async () => {
    const k = makeKit()
    vi.mocked(k.fal.client.result).mockImplementationOnce(async () => blip())
    const { runId } = await k.engine.startRun({ userId: null, takes: [gatedFlow()], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.takes[0]!.nodes['1']!.status).toBe('done')
    expect(k.fal.client.result).toHaveBeenCalledTimes(2)
    expect(k.fal.submitted()).toHaveLength(1)
  })
  it('an HTTP refusal of the result still fails the node', async () => {
    const k = makeKit()
    const { FalError } = await import('~~/server/runner/falQueue')
    vi.mocked(k.fal.client.result).mockImplementationOnce(async () => { throw new FalError('fal result 422: bad', 422) })
    const { runId } = await k.engine.startRun({ userId: null, takes: [gatedFlow()], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.takes[0]!.nodes['1']!).toMatchObject({ status: 'error', error: 'fal result 422: bad' })
  })
  it('a blip is not an answer: past the time limit, fal is still asked properly once', async () => {
    let clock = 1_000_000
    const k = makeKit({ deps: { now: () => clock } })
    vi.mocked(k.fal.client.status).mockImplementationOnce(async () => {
      clock += 10 * 60_000 // the network was down for ten minutes
      k.fal.submitted()[0]!.polls = 1 // fal finished meanwhile
      return { status: 'UNKNOWN', queuePosition: null, logs: [], error: null, transient: true, raw: null }
    })
    const { runId } = await k.engine.startRun({ userId: null, takes: [gatedFlow()], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await k.engine.settled(runId)
    expect(k.fal.client.cancel).not.toHaveBeenCalled()
    expect((await k.store.get(runId))!.takes[0]!.nodes['1']!.status).toBe('done')
  })

  it('fal never answering (a network error on every poll) ends the node after the grace period, freeing its limiter slot', async () => {
    let clock = 1_000_000
    const fal = createFakeFal()
    const origStatus = fal.client.status.getMockImplementation()!
    let stuck = true // every poll misbehaves while this run is going
    vi.mocked(fal.client.status).mockImplementation(async (url: string, opts?: { logs?: boolean }) => {
      if (stuck) {
        clock += 60_000 // a minute passes on every failed check
        throw new TypeError('fetch failed')
      }
      return origStatus(url, opts)
    })
    const k = makeKit({ fal, deps: { now: () => clock, perUserLimit: 1 } })
    const single = (prompt: string): ApiPrompt => ({
      '1': { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt, aspect_ratio: '1:1', seed: 0, model_options: '{}' } },
      '5': { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
    })
    const { runId } = await k.engine.startRun({ userId: null, takes: [single('never answers')], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await k.engine.settled(runId) // must not hang
    const rec = (await k.store.get(runId))!.takes[0]!.nodes['1']!
    expect(rec).toMatchObject({ status: 'error', error: 'The provider did not answer, so the request was cancelled' })
    expect(fal.client.cancel).toHaveBeenCalled()
    // perUserLimit: 1 — a second, independent run for the same user proves the
    // stuck node's limiter slot was released, not held forever.
    stuck = false
    const { runId: runId2 } = await k.engine.startRun({ userId: null, takes: [single('runs fine after')], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await k.engine.settled(runId2)
    expect((await k.store.get(runId2))!.takes[0]!.nodes['1']!.status).toBe('done')
  })

  it('a status URL stuck returning 5xx (transient forever, never a real answer) also ends the node after the grace period', async () => {
    let clock = 1_000_000
    const fal = createFakeFal()
    vi.mocked(fal.client.status).mockImplementation(async () => {
      clock += 60_000
      return { status: 'UNKNOWN', queuePosition: null, logs: [], error: null, transient: true, raw: null }
    })
    const k = makeKit({ fal, deps: { now: () => clock } })
    const { runId } = await k.engine.startRun({ userId: null, takes: [gatedFlow()], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await k.engine.settled(runId) // must not hang
    const rec = (await k.store.get(runId))!.takes[0]!.nodes['1']!
    expect(rec).toMatchObject({ status: 'error', error: 'The provider did not answer, so the request was cancelled' })
    expect(fal.client.cancel).toHaveBeenCalled()
  })
})

describe('Re-roll ×4 with a Gate', () => {
  it('makes four pictures at once and pauses once with four choices, none picked', async () => {
    const k = makeKit()
    const takes = [1, 2, 3, 4].map(s => gatedFlow({ imageSeed: s }))
    const { runId, legId, promptIds } = await k.engine.startRun({ userId: null, takes, workflow: null, canvasId: null, projectUuid: null, projectName: null })
    expect(promptIds).toEqual([0, 1, 2, 3].map(t => `${legId}.t${t}`))
    await k.engine.settled(runId)
    expect(k.fal.submitted()).toHaveLength(4)
    expect(k.fal.submitted().map(r => r.payload.seed).sort()).toEqual([1, 2, 3, 4])
    const paused = ofType(k.seen, 'gate_paused')
    expect(paused).toHaveLength(1)
    expect((paused[0]!.data.choices as any[]).map(c => c.take)).toEqual([0, 1, 2, 3])
    expect(paused[0]!.data.picked).toEqual([])
  })
})
