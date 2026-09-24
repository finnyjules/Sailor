/**
 * The runner's money guard (Phase B, Task B1): in hosted, a provider node
 * that prices at 0 is refused before anything is held — the runner's copy of
 * UnpricedGraphError, for a class the price book misses by name.
 *
 * The price book is faked here so a runner class prices at 0: no real class
 * does today, which is the point of the guard.
 */
import { describe, expect, it, vi } from 'vitest'
import { makeKit } from './__runner__/kit'
import { unpricedProviderNode } from '~~/server/runner/metering'
import type { ApiPrompt } from '#shared/runner/graph'

vi.mock('~~/server/utils/priceBook', async (importOriginal) => {
  const real = await importOriginal<typeof import('~~/server/utils/priceBook')>()
  return {
    ...real,
    // flux-schnell is the "free" model in this file: it prices at 0 credits.
    priceGraph: (prompt: Parameters<typeof real.priceGraph>[0]) => {
      const n = Object.values(prompt)[0] as { class_type: string; inputs?: { model?: unknown } } | undefined
      if (n?.class_type === 'GenerateImageNode' && n.inputs?.model === 'flux-schnell') {
        return { credits: 0, version: 'test', breakdown: [{ action: 'GenerateImageNode:flux-schnell', credits: 0 }] }
      }
      return real.priceGraph(prompt)
    },
  }
})

const image = (model: string): ApiPrompt => ({
  '1': { class_type: 'GenerateImageNode', inputs: { model, prompt: 'a red fox', aspect_ratio: '1:1', seed: 0, model_options: '{}' } },
  '2': { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
})
const start = (k: ReturnType<typeof makeKit>, takes: ApiPrompt[]) =>
  k.engine.startRun({ userId: k.userId, takes, workflow: null, canvasId: null, projectUuid: null, projectName: null })

describe('money guard', () => {
  it('names the first provider node that prices at 0 (and only provider nodes)', () => {
    expect(unpricedProviderNode(image('flux-schnell'))).toBe('1')
    expect(unpricedProviderNode(image('nano-banana-2'))).toBeNull()
    // A class outside the provider set is never asked (a result card costs nothing by design).
    expect(unpricedProviderNode({ '1': { class_type: 'Image', inputs: { image: 'a.png' } } })).toBeNull()
    // A fake provider class priced at 0 by a caller's own price.
    const fake: ApiPrompt = { '1': { class_type: 'FakeEditNode', inputs: {} } }
    expect(unpricedProviderNode(fake, new Set(['FakeEditNode']), () => 0)).toBe('1')
    expect(unpricedProviderNode(fake, new Set(['FakeEditNode']), () => 5)).toBeNull()
    expect(unpricedProviderNode(fake, new Set(['FakeEditNode']), () => -1)).toBe('1')
  })

  it('hosted: refuses a run with a free provider node before anything is held or sent', async () => {
    const k = makeKit({ hosted: true })
    await expect(start(k, [image('nano-banana-2'), image('flux-schnell')])).rejects.toMatchObject({
      statusCode: 500, message: 'This step has no price yet, so it can\'t run',
    })
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.graphRuns.create).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    expect(await k.store.listActive()).toEqual([])
  })

  it('hosted: a priced run still goes', async () => {
    const k = makeKit({ hosted: true })
    const { runId } = await start(k, [image('nano-banana-2')])
    await k.engine.settled(runId)
    expect(k.ledger.hold).toHaveBeenCalledTimes(1)
    expect(k.fal.client.submit).toHaveBeenCalledTimes(1)
  })

  it('local: nothing is charged, so a free node runs', async () => {
    const k = makeKit()
    const { runId } = await start(k, [image('flux-schnell')])
    await k.engine.settled(runId)
    expect(k.fal.client.submit).toHaveBeenCalledTimes(1)
    expect((await k.store.get(runId))!.status).toBe('done')
  })
})
