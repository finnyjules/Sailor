import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createLimiter } from '~~/server/runner/engine'
import { makeKit, gatedFlow, ofType, types, until } from './__runner__/kit'
import type { ApiPrompt } from '#shared/runner/graph'

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
    expect(paused[0]!.data).toEqual({ prompt_id: legId, run_id: runId, node_id: '2', choices: [{ take: 0, files: [img] }], picked: [0] })
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
    expect(k.ledger.hold).toHaveBeenCalledWith('user_1', 2, `runner:${promptIds[0]}`)
    expect(k.ledger.settle).toHaveBeenCalledWith(1, 2, `runner:${promptIds[0]}`)
    expect(ofType(k.seen, 'execution_success')[0]!.data.credits).toBe(2)
    expect(k.graphRuns.appendOutput).toHaveBeenCalledWith(promptIds[0], expect.stringMatching(/^output:u_[0-9a-f]{12}:generate_image_00001_\.png$/))
  })
  it('refuses before anything runs when credits are short', async () => {
    const k = makeKit({ hosted: true, available: 1 })
    await expect(k.engine.startRun({ userId: 'user_1', takes: [gatedFlow()], workflow: null, canvasId: null, projectUuid: null, projectName: null }))
      .rejects.toMatchObject({ statusCode: 402, data: { required: 2, available: 1 } })
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

describe('parallel work', () => {
  const twoBranches: ApiPrompt = {
    '1': { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a', aspect_ratio: '1:1', seed: 0, model_options: '{}' } },
    '2': { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'b', aspect_ratio: '1:1', seed: 0, model_options: '{}' } },
  }
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
    const { runId } = await k.engine.startRun({ userId: null, takes: [five], workflow: null, canvasId: null, projectUuid: null, projectName: null })
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
  it('seed 0 always asks again', async () => {
    const k = makeKit()
    for (let i = 0; i < 2; i++) {
      const r = await k.engine.startRun({ userId: null, takes: [gatedFlow({ imageSeed: 0 })], workflow: null, canvasId: null, projectUuid: null, projectName: null })
      await k.engine.settled(r.runId)
    }
    expect(k.fal.submitted()).toHaveLength(2)
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
