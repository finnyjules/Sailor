import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ApiPrompt } from '#shared/runner/graph'
import { makeKit, gatedFlow, createFakeFal, createFakeLedger, ofType, until } from './__runner__/kit'

async function pausedRun(k: ReturnType<typeof makeKit>, takes = [gatedFlow({ imageSeed: 7 })]) {
  const started = await k.engine.startRun({ userId: k.userId, takes, workflow: { nodes: ['as run'] }, canvasId: 'c1', projectUuid: null, projectName: null })
  await k.engine.settled(started.runId)
  return started
}

describe('Continue', () => {
  it('runs the video from the saved picture and charges only the video', async () => {
    const k = makeKit({ hosted: true })
    const { runId } = await pausedRun(k)
    const next = await k.engine.gateAction({ userId: 'user_1', runId, gateId: '2', action: 'continue' })
    expect(next.legId).toBe(`${runId}.1`)
    await k.engine.settled(runId)
    const video = k.fal.submitted()[1]!
    expect(video.endpoint).toBe('minimax/h3/image-to-video')
    expect(video.payload.image_url).toMatch(/^https:\/\/fal\.storage\/generate_image_00001_\.png$/)
    expect(k.ledger.hold).toHaveBeenLastCalledWith('user_1', 45, `runner:${next.promptIds[0]}`)
    expect(ofType(k.seen, 'executed').some(m => m.data.node === '4')).toBe(true)
    expect((await k.store.get(runId))!.status).toBe('done')
    // image once, video once
    expect([...k.ledger.holds.values()].map(h => [h.state, h.actual])).toEqual([['settled', 3], ['settled', 45]])
  })

  it('works after a server restart', async () => {
    const k1 = makeKit()
    const { runId } = await pausedRun(k1)
    const k2 = makeKit({ dir: k1.dir, root: k1.root, fal: k1.fal })
    await k2.engine.gateAction({ userId: null, runId, gateId: '2', action: 'continue' })
    await k2.engine.settled(runId)
    expect(k1.fal.submitted()).toHaveLength(2)
    expect((await k2.store.get(runId))!.status).toBe('done')
  })

  it('refuses while the run is still going, and for a node that is not a Gate', async () => {
    const k = makeKit()
    k.fal.holdNext(1)
    const { runId } = await k.engine.startRun({ userId: null, takes: [gatedFlow()], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await until(() => k.fal.submitted().length === 1)
    await expect(k.engine.gateAction({ userId: null, runId, gateId: '2', action: 'continue' })).rejects.toMatchObject({ statusCode: 409 })
    k.fal.release()
    await k.engine.settled(runId)
    await expect(k.engine.gateAction({ userId: null, runId, gateId: '1', action: 'continue' })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('someone else’s run is not found', async () => {
    const k = makeKit({ hosted: true })
    const { runId } = await pausedRun(k)
    await expect(k.engine.gateAction({ userId: 'user_2', runId, gateId: '2', action: 'continue' })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('not enough credits: says how many, and the run stays paused', async () => {
    const ledger = createFakeLedger(10) // image stage costs 3 (flux-schnell 1:1 is 2 MP: 2 + the render), video 45
    const k = makeKit({ hosted: true, ledger })
    const { runId } = await pausedRun(k)
    await expect(k.engine.gateAction({ userId: 'user_1', runId, gateId: '2', action: 'continue' }))
      .rejects.toMatchObject({ statusCode: 402, data: { required: 45, available: 7 } })
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('paused')
    expect(run.takes[0]!.nodes['2']!.status).toBe('paused')
    expect(run.legs).toHaveLength(1)
  })
})

describe('Redo and Restart', () => {
  it('Redo re-makes the picture with the next seed and pauses again', async () => {
    const k = makeKit()
    const { runId } = await pausedRun(k)
    await k.engine.gateAction({ userId: null, runId, gateId: '2', action: 'redo' })
    await k.engine.settled(runId)
    expect(k.fal.submitted().map(r => [r.endpoint, r.payload.seed])).toEqual([['fal-ai/flux/schnell', 7], ['fal-ai/flux/schnell', 8]])
    expect(ofType(k.seen, 'gate_paused')).toHaveLength(2)
    expect((await k.store.get(runId))!.takes[0]!.prompt['1']!.inputs.seed).toBe(8)
  })
  it('Redo leaves a random seed random', async () => {
    const k = makeKit()
    const { runId } = await pausedRun(k, [gatedFlow({ imageSeed: 0 })])
    await k.engine.gateAction({ userId: null, runId, gateId: '2', action: 'redo' })
    await k.engine.settled(runId)
    expect(k.fal.submitted().map(r => r.payload.seed)).toEqual([undefined, undefined])
  })
  it('Restart throws everything away and runs from the start', async () => {
    const k = makeKit()
    const { runId } = await pausedRun(k, [gatedFlow({ imageSeed: 0 })])
    await k.engine.gateAction({ userId: null, runId, gateId: '2', action: 'continue' })
    await k.engine.settled(runId)
    await k.engine.gateAction({ userId: null, runId, gateId: '2', action: 'restart' })
    await k.engine.settled(runId)
    expect(k.fal.submitted().map(r => r.endpoint)).toEqual(['fal-ai/flux/schnell', 'minimax/h3/image-to-video', 'fal-ai/flux/schnell'])
    expect((await k.store.get(runId))!.status).toBe('paused')
  })
})

describe('Continue after the run has finished', () => {
  it('makes another video from the same picture, without re-making the picture', async () => {
    const k = makeKit()
    const { runId } = await pausedRun(k, [gatedFlow({ imageSeed: 7, videoSeed: 3 })])
    await k.engine.gateAction({ userId: null, runId, gateId: '2', action: 'continue' })
    await k.engine.settled(runId)
    const again = await k.engine.gateAction({ userId: null, runId, gateId: '2', action: 'continue' })
    await k.engine.settled(runId)
    const sent = k.fal.submitted()
    expect(sent.map(r => r.endpoint)).toEqual(['fal-ai/flux/schnell', 'minimax/h3/image-to-video', 'minimax/h3/image-to-video'])
    expect(sent[2]!.payload.seed).toBe(4)
    expect(sent[2]!.payload.image_url).toBe(sent[1]!.payload.image_url)
    const run = (await k.store.get(runId))!
    expect(run.legs.at(-1)).toMatchObject({ id: again.legId, action: 'again' })
  })

  it('a later Gate closes again, so the new video is reviewed there too', async () => {
    // image(1) → Gate A(2) → video(3) → Gate B(6) → Video card(4)
    const flow = gatedFlow({ imageSeed: 7, videoSeed: 3 })
    flow['6'] = { class_type: 'ComfyGateNode', inputs: { data_in: ['3', 0], bypass: false } }
    flow['4']!.inputs.source = ['6', 0]
    const k = makeKit()
    const { runId } = await pausedRun(k, [flow])
    await k.engine.gateAction({ userId: null, runId, gateId: '2', action: 'continue' })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.takes[0]!.nodes['6']!.status).toBe('paused')
    await k.engine.gateAction({ userId: null, runId, gateId: '6', action: 'continue' })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.status).toBe('done')

    await k.engine.gateAction({ userId: null, runId, gateId: '2', action: 'continue' })
    await k.engine.settled(runId)
    expect(k.fal.submitted().map(r => r.endpoint)).toEqual(['fal-ai/flux/schnell', 'minimax/h3/image-to-video', 'minimax/h3/image-to-video'])
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('paused')
    expect(run.takes[0]!.nodes['6']!.status).toBe('paused')
    expect(run.takes[0]!.nodes['4']!.status).toBe('waiting')
    expect(run.takes[0]!.openGates).toEqual(['2'])
    const lastPause = ofType(k.seen, 'gate_paused').at(-1)!
    expect(lastPause.data).toMatchObject({ node_id: '6' })
  })
})

describe('Pick at the Gate', () => {
  it('Continue with two of four ticked runs two videos and charges for two', async () => {
    const k = makeKit({ hosted: true })
    const { runId } = await pausedRun(k, [1, 2, 3, 4].map(s => gatedFlow({ imageSeed: s })))
    await expect(k.engine.gateAction({ userId: 'user_1', runId, gateId: '2', action: 'continue' })).rejects.toMatchObject({ statusCode: 400 })
    const next = await k.engine.gateAction({ userId: 'user_1', runId, gateId: '2', action: 'continue', takes: [1, 3] })
    expect(next.promptIds).toEqual([`${runId}.1.t1`, `${runId}.1.t3`])
    await k.engine.settled(runId)
    const videos = k.fal.submitted().filter(r => r.endpoint.startsWith('minimax'))
    expect(videos).toHaveLength(2)
    const videoHolds = [...k.ledger.holds.values()].filter(h => h.key.includes('.1.'))
    expect(videoHolds.map(h => h.credits)).toEqual([45, 45])
    const run = (await k.store.get(runId))!
    expect(run.takes.map(t => t.nodes['2']!.status)).toEqual(['dropped', 'done', 'dropped', 'done'])
    expect(run.status).toBe('done')
  })
  it('Redo re-makes all four', async () => {
    const k = makeKit()
    // Seeds far apart: after Redo's +1 none matches another take's earlier
    // request, which would (correctly) be reused instead of sent.
    const { runId } = await pausedRun(k, [10, 20, 30, 40].map(s => gatedFlow({ imageSeed: s })))
    await k.engine.gateAction({ userId: null, runId, gateId: '2', action: 'redo' })
    await k.engine.settled(runId)
    expect(k.fal.submitted()).toHaveLength(8)
  })
})

describe('Stop', () => {
  it('cancels at fal, drops the hold for the unfinished stage and keeps what was made', async () => {
    const k = makeKit({ hosted: true })
    const { runId } = await pausedRun(k)
    k.fal.holdNext(1)
    const next = await k.engine.gateAction({ userId: 'user_1', runId, gateId: '2', action: 'continue' })
    await until(() => k.fal.submitted().length === 2)
    const res = await k.engine.stop('user_1')
    expect(res.stopped).toEqual([runId])
    await k.engine.settled(runId)
    expect(k.fal.client.cancel).toHaveBeenCalledWith(`fal://${k.fal.submitted()[1]!.id}/cancel`)
    const holds = [...k.ledger.holds.values()]
    expect(holds.map(h => h.state)).toEqual(['settled', 'released'])
    const done = ofType(k.seen, 'execution_success').find(m => m.data.prompt_id === next.promptIds[0])!
    expect(done.data).toMatchObject({ stopped: true, credits: 0 })
    expect((await k.store.get(runId))!.status).toBe('stopped')
  })
  it('only stops your own runs', async () => {
    const k = makeKit({ hosted: true })
    k.fal.holdNext(1)
    const { runId } = await k.engine.startRun({ userId: 'user_1', takes: [gatedFlow()], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await until(() => k.fal.submitted().length === 1)
    expect((await k.engine.stop('user_2')).stopped).toEqual([])
    k.fal.release()
    await k.engine.settled(runId)
  })
  it('a Stop between opening a leg and starting it sticks: nothing is sent and the hold is dropped', async () => {
    const k = makeKit({ hosted: true })
    const { runId } = await pausedRun(k)
    // Hold the first save of the Continue leg: the leg is open (and held) but not started.
    const realSave = k.store.save.bind(k.store)
    let letSaveFinish!: () => void
    const saveHeld = new Promise<void>((r) => { letSaveFinish = r })
    let holding = false
    k.store.save = async (run) => {
      if (!holding && run.legs.length === 2) { holding = true; await saveHeld }
      return realSave(run)
    }
    const continuing = k.engine.gateAction({ userId: 'user_1', runId, gateId: '2', action: 'continue' })
    await until(() => holding)
    expect((await k.engine.stop('user_1')).stopped).toEqual([runId])
    letSaveFinish()
    await continuing
    await k.engine.settled(runId)
    expect(k.fal.submitted().map(r => r.endpoint)).toEqual(['fal-ai/flux/schnell'])
    expect([...k.ledger.holds.values()].map(h => [h.credits, h.state])).toEqual([[3, 'settled'], [45, 'released']])
    const run = (await k.store.get(runId))!
    expect(run.takes[0]!.nodes['3']!.status).toBe('stopped')
    expect(run.status).toBe('stopped')
  })
  it('a request still being sent when Stop lands is cancelled once it has an id', async () => {
    const k = makeKit()
    const realSubmit = k.fal.client.submit
    let letSubmitFinish!: () => void
    const submitHeld = new Promise<void>((r) => { letSubmitFinish = r })
    let submitting = false
    k.fal.client.submit = (async (...a: Parameters<typeof realSubmit>) => {
      submitting = true
      await submitHeld
      return realSubmit(...a)
    }) as typeof realSubmit
    const { runId } = await k.engine.startRun({ userId: null, takes: [gatedFlow()], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await until(() => submitting)
    const stopping = k.engine.stop(null)
    letSubmitFinish()
    expect((await stopping).stopped).toEqual([runId])
    await k.engine.settled(runId)
    expect(k.fal.submitted()).toHaveLength(1)
    expect(k.fal.client.cancel).toHaveBeenCalledWith(`fal://${k.fal.submitted()[0]!.id}/cancel`)
    const run = (await k.store.get(runId))!
    expect(run.takes[0]!.nodes['1']!.status).toBe('stopped')
    expect(run.status).toBe('stopped')
  })
  it('a Stop that lands as a queued call gets its slot sends nothing, and the slot is freed', async () => {
    // One call at a time: take 1 waits for take 0's slot. Take 0's download
    // starts in the same tick its slot passes to take 1 — Stop is pressed there.
    let pressed = false
    const k: ReturnType<typeof makeKit> = makeKit({
      deps: {
        perUserLimit: 1,
        download: async (url: string) => {
          if (!pressed) { pressed = true; void k.engine.stop(null) }
          return { bytes: new TextEncoder().encode(url), contentType: 'image/png' }
        },
      },
    })
    const { runId } = await k.engine.startRun({ userId: null, takes: [gatedFlow(), gatedFlow()], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await k.engine.settled(runId)
    expect(pressed).toBe(true)
    expect(k.fal.submitted()).toHaveLength(1)
    const run = (await k.store.get(runId))!
    expect(run.takes.map(t => t.nodes['1']!.status).sort()).toEqual(['done', 'stopped'])
    expect(run.status).toBe('stopped')
    // R3.18 ruling: the image was made but its card was stopped before showing it: no render credit (local, so no money moves; was set).
    expect(run.baseCharged).toBe(false)
    // The slot came back: a new run is not left waiting behind the stopped one.
    const again = await k.engine.startRun({ userId: null, takes: [gatedFlow()], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await k.engine.settled(again.runId)
    expect((await k.store.get(again.runId))!.status).toBe('paused')
  })
})

describe('restart recovery', () => {
  it('a restarted server asks fal about the request it already sent, and charges once', async () => {
    const fal = createFakeFal()
    const ledger = createFakeLedger()
    // k1 "crashes" by never waking from its next sleep — it stops polling and saving.
    let crashed = false
    const k1 = makeKit({
      hosted: true, fal, ledger,
      deps: { sleep: () => (crashed ? new Promise<void>(() => {}) : new Promise<void>(r => setTimeout(r, 1))) },
    })
    fal.holdNext(1)
    const { runId } = await k1.engine.startRun({ userId: 'user_1', takes: [gatedFlow()], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await until(() => fal.submitted().length === 1)
    await until(() => fal.submitted()[0]!.polls >= 2)
    crashed = true
    await new Promise(r => setTimeout(r, 20))
    // A new engine reads the same storage.
    const k2 = makeKit({ hosted: true, dir: k1.dir, root: k1.root, fal, ledger })
    expect(await k2.engine.reattach()).toBe(1)
    fal.release()
    await k2.engine.settled(runId)
    expect(fal.submitted()).toHaveLength(1)
    expect(ledger.hold).toHaveBeenCalledTimes(1)
    expect([...ledger.holds.values()].map(h => h.state)).toEqual(['settled'])
    expect((await k2.store.get(runId))!.status).toBe('paused')
    expect(ofType(k2.seen, 'gate_paused')).toHaveLength(1)
  })

  it('an image fal finished while the server was down is kept, even past the time limit', async () => {
    const fal = createFakeFal()
    let crashed = false
    const k1 = makeKit({
      fal,
      deps: { sleep: () => (crashed ? new Promise<void>(() => {}) : new Promise<void>(r => setTimeout(r, 1))) },
    })
    fal.holdNext(1)
    const { runId } = await k1.engine.startRun({ userId: null, takes: [gatedFlow()], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await until(() => (fal.submitted()[0]?.polls ?? 0) >= 2)
    crashed = true
    await new Promise(r => setTimeout(r, 20))
    fal.release() // fal finishes the image while the server is down
    // The server comes back ten minutes later — past the five-minute image limit.
    const later = () => Date.now() + 10 * 60_000
    const k2 = makeKit({ dir: k1.dir, root: k1.root, fal, deps: { now: later } })
    expect(await k2.engine.reattach()).toBe(1)
    await k2.engine.settled(runId)
    expect(fal.client.cancel).not.toHaveBeenCalled()
    const run = (await k2.store.get(runId))!
    expect(run.takes[0]!.nodes['1']!.status).toBe('done')
    expect(run.status).toBe('paused')
    const file = run.takes[0]!.nodes['1']!.outputs[0]!
    expect(existsSync(join(k2.root, 'output', file.filename))).toBe(true)
  })

  // A leg interrupted after one of its generators finished: the restarted
  // server must still charge and record the work finished before the crash.
  const crashingKit = (fal: ReturnType<typeof createFakeFal>, ledger: ReturnType<typeof createFakeLedger>) => {
    const state = { crashed: false }
    const k = makeKit({
      hosted: true, fal, ledger,
      deps: { sleep: () => (state.crashed ? new Promise<void>(() => {}) : new Promise<void>(r => setTimeout(r, 1))) },
    })
    return { k, state }
  }
  const reqFor = (fal: ReturnType<typeof createFakeFal>, prompt: string) => fal.submitted().find(r => r.payload.prompt === prompt)!

  it.each([
    ['', false],
    [' (a run saved before the leg wrote down its nodes)', true],
  ])('a restart mid-leg charges and records both generators of the leg, once%s', async (_label, legacy) => {
    const fal = createFakeFal()
    const ledger = createFakeLedger()
    const { k: k1, state } = crashingKit(fal, ledger)
    const twoGenerators: ApiPrompt = {
      '1': { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'first', aspect_ratio: '1:1', seed: 0, model_options: '{}' } },
      '2': { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'second', aspect_ratio: '1:1', seed: 0, model_options: '{}' } },
      '3': { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
      // The second shown too: only what an output reads runs (R3.8 fix round 1).
      '4': { class_type: 'Image', inputs: { image: '', export: false, images: ['2', 0], batch_index: -1 } },
    }
    fal.holdNext(2)
    const { runId, promptIds } = await k1.engine.startRun({ userId: 'user_1', takes: [twoGenerators], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await until(() => fal.submitted().length === 2)
    fal.release(reqFor(fal, 'first').id)
    let saved: Awaited<ReturnType<typeof k1.store.get>> = null
    for (const end = Date.now() + 3000; Date.now() < end;) {
      saved = await k1.store.get(runId)
      if (saved?.takes[0]!.nodes['1']!.status === 'done') break
      await new Promise(r => setTimeout(r, 2))
    }
    expect(saved!.takes[0]!.nodes['1']!.status).toBe('done')
    state.crashed = true
    await new Promise(r => setTimeout(r, 20))
    if (legacy) {
      const old = (await k1.store.get(runId))!
      expect(old.charges[0]!.nodeIds).toEqual(['1', '2', '3', '4'])
      delete old.charges[0]!.nodeIds
      await k1.store.save(old)
    }

    const k2 = makeKit({ hosted: true, dir: k1.dir, root: k1.root, fal, ledger })
    expect(await k2.engine.reattach()).toBe(1)
    fal.release()
    await k2.engine.settled(runId)
    expect(fal.submitted()).toHaveLength(2)
    expect(ledger.hold).toHaveBeenCalledTimes(1)
    expect(ledger.settle).toHaveBeenCalledTimes(1)
    // two images (2 each: 1:1 is 2 MP) + the render credit (1)
    expect([...ledger.holds.values()].map(h => [h.state, h.actual])).toEqual([['settled', 5]])
    const run = (await k2.store.get(runId))!
    expect(run.charges[0]!.actual).toBe(5)
    expect(ofType(k2.seen, 'execution_success').find(m => m.data.prompt_id === promptIds[0])!.data.credits).toBe(5)
    expect(k2.records.write).toHaveBeenCalledTimes(1)
    const summary = (k2.records.write.mock.calls[0] as unknown[])[0] as { outputs: unknown[] }
    expect(summary.outputs).toHaveLength(2)
  })

  it('after a restart mid-leg, the image before a Gate is still charged', async () => {
    const fal = createFakeFal()
    const ledger = createFakeLedger()
    const { k: k1, state } = crashingKit(fal, ledger)
    // image(1) → Gate(2) …, plus a second, independent generator (6) that is still going at the crash
    const flow: ApiPrompt = {
      ...gatedFlow(),
      '6': { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'the other one', aspect_ratio: '1:1', seed: 0, model_options: '{}' } },
      // Shown by a card: only what an output reads runs (R3.8 fix round 1).
      '7': { class_type: 'Image', inputs: { image: '', export: false, images: ['6', 0], batch_index: -1 } },
    }
    fal.holdNext(2)
    const { runId } = await k1.engine.startRun({ userId: 'user_1', takes: [flow], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await until(() => fal.submitted().length === 2)
    fal.release(reqFor(fal, 'a red fox').id)
    let saved: Awaited<ReturnType<typeof k1.store.get>> = null
    for (const end = Date.now() + 3000; Date.now() < end;) {
      saved = await k1.store.get(runId)
      if (saved?.takes[0]!.nodes['2']!.status === 'paused') break
      await new Promise(r => setTimeout(r, 2))
    }
    expect(saved!.takes[0]!.nodes['1']!.status).toBe('done')
    expect(saved!.takes[0]!.nodes['2']!.status).toBe('paused')
    state.crashed = true
    await new Promise(r => setTimeout(r, 20))

    const k2 = makeKit({ hosted: true, dir: k1.dir, root: k1.root, fal, ledger })
    expect(await k2.engine.reattach()).toBe(1)
    fal.release()
    await k2.engine.settled(runId)
    expect(fal.submitted()).toHaveLength(2)
    // image (2) + the other image (2) + the render credit (1)
    expect([...ledger.holds.values()].map(h => [h.state, h.actual])).toEqual([['settled', 5]])
    const run = (await k2.store.get(runId))!
    expect(run.status).toBe('paused')
    expect(ofType(k2.seen, 'gate_paused')).toHaveLength(1)
  })

  it('the time limit still holds once fal has been asked', async () => {
    let clock = 1_000_000
    const k = makeKit({ deps: { now: () => clock } })
    k.fal.holdNext(1)
    const { runId } = await k.engine.startRun({ userId: null, takes: [gatedFlow()], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await until(() => (k.fal.submitted()[0]?.polls ?? 0) >= 1)
    clock += 6 * 60_000
    await k.engine.settled(runId)
    expect(k.fal.client.cancel).toHaveBeenCalledWith(`fal://${k.fal.submitted()[0]!.id}/cancel`)
    const run = (await k.store.get(runId))!
    expect(run.takes[0]!.nodes['1']!).toMatchObject({ status: 'error', error: 'The service took more than 5 minutes to make this image, so it was cancelled' })
    expect(run.status).toBe('error')
  })
})

describe('the webhook wakes a waiting poll', () => {
  it('nudge cuts the wait short', async () => {
    const k = makeKit({
      deps: {
        pollDelayMs: () => 60_000,
        sleep: (ms, signal) => new Promise<void>((resolve) => {
          const t = setTimeout(resolve, ms)
          signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
        }),
      },
    })
    const { runId } = await k.engine.startRun({ userId: null, takes: [gatedFlow()], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await until(() => (k.fal.submitted()[0]?.polls ?? 0) === 1)
    expect(k.engine.nudge(k.fal.submitted()[0]!.id)).toBe(true)
    await until(() => ofType(k.seen, 'gate_paused').length === 1, 1000)
    expect(k.engine.nudge('req-unknown')).toBe(false)
    await k.engine.settled(runId)
  })
})

describe('lookups', () => {
  it('lists paused Gates for a canvas and replays them to a new tab', async () => {
    const k = makeKit()
    const { runId, legId } = await pausedRun(k)
    const gates = await k.engine.pausedGates(null, 'c1')
    expect(gates).toEqual([{ runId, promptId: legId, nodeId: '2', choices: [{ take: 0, files: [{ filename: 'generate_image_00001_.png', subfolder: '', type: 'output' }] }], picked: [0] }])
    expect(await k.engine.pausedGates(null, 'c2')).toEqual([])
    expect(k.engine.snapshot(null).map(m => m.type)).toEqual(['gate_paused'])
  })
  it('returns the exact workflow and cost behind a result', async () => {
    const k = makeKit({ hosted: true })
    const { runId, promptIds } = await pausedRun(k)
    const rec = await k.engine.record('user_1', promptIds[0]!)
    expect(rec).toMatchObject({ runId, promptId: promptIds[0], workflow: { nodes: ['as run'] }, credits: 3, prompt: 'a red fox', nodeTypes: ['GenerateImageNode', 'ComfyGateNode', 'Image'] })
    expect(await k.engine.record('user_2', promptIds[0]!)).toBeNull()
    expect(await k.engine.record('user_1', 'not-a-run')).toBeNull()
  })
})
