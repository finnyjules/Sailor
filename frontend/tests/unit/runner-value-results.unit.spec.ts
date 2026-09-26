// frontend/tests/unit/runner-value-results.unit.spec.ts
/**
 * R0.6: a paid node whose answer is a value. No real node answers with a
 * value before R3, so a Generate-an-image node carrying `test_value: true`
 * is turned into a value plan here (the vi.mock pattern of
 * runner-replicate-engine.unit.spec.ts).
 */
import { describe, expect, it, vi } from 'vitest'
import { createFakeFal, makeKit, until } from './__runner__/kit'
import type { ApiPrompt } from '#shared/runner/graph'
import { createFileRunStore } from '~~/server/runner/store'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('~~/server/runner/executors', async (importOriginal) => {
  const real = await importOriginal<typeof import('~~/server/runner/executors')>()
  return {
    ...real,
    planNode: async (ctx: Parameters<typeof real.planNode>[0]) => {
      const plan = await real.planNode(ctx)
      if (plan.kind === 'provider' && ctx.prompt[ctx.nodeId]!.inputs.test_value === true) {
        return {
          ...plan, media: 'value' as const, uiFor: () => null,
          valuesOf: (result: any) => ({ 0: { kind: 'text' as const, text: `made ${String(result.images[0].url)}` } }),
        }
      }
      return plan
    },
  }
})

const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const one = (seed: number): ApiPrompt => ({
  '1': { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'describe', aspect_ratio: '1:1', seed, model_options: '{}', test_value: true } },
})

describe('a paid node whose answer is a value', () => {
  it('keeps the value, downloads nothing, and is charged once', async () => {
    const download = vi.fn()
    const k = makeKit({ hosted: true, deps: { download } })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [one(0)], ...START })
    await k.engine.settled(runId)
    const rec = (await k.store.get(runId))!.takes[0]!.nodes['1']!
    expect(rec.status).toBe('done')
    expect(rec.values).toEqual({ 0: { kind: 'text', text: 'made https://fal.media/req1.png' } })
    expect(rec.outputs).toEqual([])
    expect(download).not.toHaveBeenCalled()
    expect([...k.ledger.holds.values()].filter(h => h.state === 'settled')).toHaveLength(1)
  })
  it('gives the value back when the same request is reused (seed set)', async () => {
    const k = makeKit({ hosted: false })
    const a = await k.engine.startRun({ userId: null, takes: [one(5)], ...START })
    await k.engine.settled(a.runId)
    const b = await k.engine.startRun({ userId: null, takes: [one(5)], ...START })
    await k.engine.settled(b.runId)
    const rec = (await k.store.get(b.runId))!.takes[0]!.nodes['1']!
    expect(rec.reused).toBe(true)
    expect(rec.values).toEqual({ 0: { kind: 'text', text: 'made https://fal.media/req1.png' } })
    expect(k.fal.client.submit).toHaveBeenCalledTimes(1)
  })
  it('picks the job up again after a restart and still reads its value', async () => {
    // The first server "crashes" (its sleeps never return), as runner-sync-3.unit.spec.ts does it.
    const fal = createFakeFal()
    const crash = { on: false }
    const k1 = makeKit({ hosted: false, fal, deps: { sleep: () => crash.on ? new Promise<void>(() => {}) : new Promise<void>(r => setTimeout(r, 1)) } })
    fal.holdNext(1)
    const { runId } = await k1.engine.startRun({ userId: null, takes: [one(0)], ...START })
    await until(() => (fal.submitted()[0]?.polls ?? 0) >= 2)
    crash.on = true
    await new Promise(r => setTimeout(r, 20))
    fal.release()
    const k2 = makeKit({ hosted: false, dir: k1.dir, root: k1.root, fal })
    expect(await k2.engine.reattach()).toBe(1)
    await k2.engine.settled(runId)
    expect(fal.client.submit).toHaveBeenCalledTimes(1)
    expect((await k2.store.get(runId))!.takes[0]!.nodes['1']!.values?.[0]).toEqual({ kind: 'text', text: 'made https://fal.media/req1.png' })
  })
})

describe('the reuse cache', () => {
  it('reads an old array as files, and writes an entry without values as the old array', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'runs-'))
    const s = createFileRunStore(dir)
    const f = { filename: 'a.png', subfolder: '', type: 'output' as const }
    await s.putResult('local', 'fp1', { files: [f] })
    expect(await s.getResult('local', 'fp1')).toEqual({ files: [f] })
    // Written byte-identical to before R0.6: the plain array.
    const [userDir] = readdirSync(join(dir, 'results'))
    expect(readFileSync(join(dir, 'results', userDir!, 'fp1.json'), 'utf8')).toBe(JSON.stringify([f]))
    await s.putResult('local', 'fp2', { files: [], values: { 0: { kind: 'text', text: 'x' } } })
    expect(await s.getResult('local', 'fp2')).toEqual({ files: [], values: { 0: { kind: 'text', text: 'x' } } })
  })
})
