/**
 * The provider seam (Phase B, Task B1): a plan names its provider, a saved
 * request without one is fal, and a Replicate plan goes to Replicate (the
 * client landed in B3; runner-replicate-engine covers it in depth). Plus the
 * runner-only moderation of the edit nodes' own text inputs.
 */
import { describe, expect, it, vi } from 'vitest'
import { createFakeFal, createFakeLedger, makeKit, until } from './__runner__/kit'
import { createMetering, RUNNER_EXTRA_TEXT_INPUTS } from '~~/server/runner/metering'
import type { ApiPrompt } from '#shared/runner/graph'

// A plan for the prompt "on replicate" is turned into a Replicate plan: no
// real node plans one yet.
vi.mock('~~/server/runner/executors', async (importOriginal) => {
  const real = await importOriginal<typeof import('~~/server/runner/executors')>()
  return {
    ...real,
    planNode: async (ctx: Parameters<typeof real.planNode>[0]) => {
      const plan = await real.planNode(ctx)
      if (plan.kind === 'provider' && plan.payload.prompt === 'on replicate') return { ...plan, provider: 'replicate' as const }
      return plan
    },
  }
})

const image = (prompt: string): ApiPrompt => ({
  '1': { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt, aspect_ratio: '1:1', seed: 0, model_options: '{}' } },
  '2': { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
})

describe('which provider', () => {
  it('a fal plan is sent to fal and its request says so', async () => {
    const k = makeKit()
    const { runId } = await k.engine.startRun({ userId: null, takes: [image('a red fox')], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await k.engine.settled(runId)
    const rec = (await k.store.get(runId))!.takes[0]!.nodes['1']!
    expect(rec.status).toBe('done')
    expect(rec.request!.provider).toBe('fal')
  })

  it('a Replicate plan is sent to Replicate, not fal, and its request says so', async () => {
    const k = makeKit({ hosted: true })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [image('on replicate')], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.takes[0]!.nodes['1']!.status).toBe('done')
    expect(run.takes[0]!.nodes['1']!.request!.provider).toBe('replicate')
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    expect(k.replicate.client.submit).toHaveBeenCalledTimes(1)
    expect([...k.ledger.holds.values()].map(h => h.state)).toEqual(['settled'])
  })

  it('a run saved before requests named their provider resumes on fal after a restart', async () => {
    const fal = createFakeFal()
    const ledger = createFakeLedger()
    const state = { crashed: false }
    const k1 = makeKit({
      hosted: true, fal, ledger,
      deps: { sleep: () => (state.crashed ? new Promise<void>(() => {}) : new Promise<void>(r => setTimeout(r, 1))) },
    })
    fal.holdNext(1)
    const { runId } = await k1.engine.startRun({ userId: 'user_1', takes: [image('a red fox')], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await until(() => (fal.submitted()[0]?.polls ?? 0) >= 2)
    state.crashed = true
    await new Promise(r => setTimeout(r, 20))

    // Rewrite the saved run the way an older server wrote it: no `provider`.
    const old = (await k1.store.get(runId))!
    const req = old.takes[0]!.nodes['1']!.request!
    expect(req).toBeTruthy()
    delete (req as { provider?: unknown }).provider
    await k1.store.save(old)

    const k2 = makeKit({ hosted: true, dir: k1.dir, root: k1.root, fal, ledger })
    expect(await k2.engine.reattach()).toBe(1)
    fal.release()
    await k2.engine.settled(runId)
    expect(fal.submitted()).toHaveLength(1) // polled on fal, not sent again
    const run = (await k2.store.get(runId))!
    expect(run.takes[0]!.nodes['1']!.status).toBe('done')
    expect([...ledger.holds.values()].map(h => h.state)).toEqual(['settled'])
  })
})

describe('moderation of the edit nodes’ own text', () => {
  const metering = (moderate: (t: string) => Promise<{ ok: true } | { ok: false; categories: string[] }>) => createMetering({
    hosted: () => true,
    ledger: () => createFakeLedger(),
    graphRuns: { create: async () => {}, appendOutput: async () => {}, resolve: async () => {} },
    spendGuard: async () => {},
    moderate,
  })

  it('lists the six text inputs', () => {
    expect([...RUNNER_EXTRA_TEXT_INPUTS].sort()).toEqual(['color', 'find', 'instructions', 'replace', 'scene_prompt', 'target'])
  })

  it('sees target and instructions, next to the usual prompt text', async () => {
    const moderate = vi.fn(async () => ({ ok: true as const }))
    await metering(moderate).moderate([{
      '1': { class_type: 'Image', inputs: { image: 'a.png' } },
      '2': { class_type: 'RemoveObjectNode', inputs: { image: ['1', 0], target: 'the red cup', instructions: 'keep the table' } },
      '3': { class_type: 'GenerateImageNode', inputs: { prompt: 'a fox', model: 'flux-schnell' } },
    }])
    expect(moderate).toHaveBeenCalledTimes(1)
    const text = (moderate.mock.calls[0] as unknown as [string])[0]
    expect(text).toContain('a fox')
    expect(text).toContain('the red cup')
    expect(text).toContain('keep the table')
  })

  it('sees find, replace, color and scene_prompt; skips links and blanks', async () => {
    const moderate = vi.fn(async () => ({ ok: true as const }))
    await metering(moderate).moderate([{
      '1': { class_type: 'TextEditNode', inputs: { find: 'SALE', replace: 'OPEN', instructions: '  ' } },
      '2': { class_type: 'RecolorObjectNode', inputs: { target: ['9', 0], color: 'teal' } },
      '3': { class_type: 'SwapBackgroundNode', inputs: { scene_prompt: 'a beach at dusk' } },
    }])
    const text = (moderate.mock.calls[0] as unknown as [string])[0]
    for (const w of ['SALE', 'OPEN', 'teal', 'a beach at dusk']) expect(text).toContain(w)
    expect(text).not.toContain('9')
  })

  it('a blocked edit instruction refuses the run', async () => {
    const m = metering(async () => ({ ok: false, categories: ['violence'] }))
    await expect(m.moderate([{ '1': { class_type: 'RemoveObjectNode', inputs: { target: 'bad words' } } }]))
      .rejects.toMatchObject({ statusCode: 400, message: 'This prompt was blocked by content moderation' })
  })
})
