import { describe, expect, it, vi } from 'vitest'
import { nodeCredits, stageEstimate, hasOutputNode, createMetering, type LedgerPort } from '~~/server/runner/metering'
import type { StageCharge } from '~~/server/runner/types'

const img = (model: string) => ({ class_type: 'GenerateImageNode', inputs: { model } })
const vid = (model: string) => ({ class_type: 'GenerateVideoNode', inputs: { model } })

describe('prices', () => {
  it('prices generators from the existing price table and nothing else', () => {
    // P3 fix round 1: fal megapixels round up, so 1:1 (1024 × 1024) bills 2 MP: $0.006, 2 credits.
    expect(nodeCredits(img('flux-schnell'))).toBe(2)
    // Task P3: Nano Banana 2 at fal's $0.08 (1K); Seedream 5 Lite's $0.035 is 7 credits (float noise fixed).
    expect(nodeCredits(img('nano-banana-2'))).toBe(16)
    expect(nodeCredits(img('seedream-5-lite'))).toBe(7)
    expect(nodeCredits(vid('hailuo-h3'))).toBe(45)
    expect(nodeCredits(vid('Veo 3'))).toBe(480)
    expect(nodeCredits({ class_type: 'Image', inputs: {} })).toBe(0)
    expect(nodeCredits({ class_type: 'ComfyGateNode', inputs: {} })).toBe(0)
    expect(() => nodeCredits(img('reve-create'))).toThrow(/no listed price/)
  })
  it('adds the flat render credit only when asked', () => {
    const p = { '1': img('flux-schnell'), '2': { class_type: 'ComfyGateNode', inputs: {} }, '3': vid('hailuo-h3'), '4': { class_type: 'Video', inputs: {} } }
    expect(stageEstimate(p, ['1', '2'], true)).toBe(3)
    expect(stageEstimate(p, ['3', '4'], false)).toBe(45)
    expect(hasOutputNode(p)).toBe(true)
    expect(hasOutputNode({ '1': img('flux-schnell') })).toBe(false)
  })
})

function fakes(available = 100) {
  let seq = 0
  const ledger: LedgerPort = {
    hold: vi.fn(async (_u, credits) => (credits > available ? { ok: false as const, reason: 'insufficient' as const } : { ok: true as const, holdId: ++seq })),
    settle: vi.fn(async () => ({ settled: true })),
    release: vi.fn(async () => {}),
    getAvailable: vi.fn(async () => available),
  }
  const graphRuns = { create: vi.fn(async () => {}), appendOutput: vi.fn(async () => {}), resolve: vi.fn(async () => {}) }
  return { ledger, graphRuns }
}
const charge = (over: Partial<StageCharge> = {}): StageCharge => ({
  stageKey: 'run_x.0.t0', leg: 0, take: 0, estimate: 15, includesBase: true, holdId: 7, state: 'held', actual: null, finished: false, ...over,
})

describe('hosted metering', () => {
  it('holds with a key that survives retries and writes the ownership row', async () => {
    const { ledger, graphRuns } = fakes()
    const m = createMetering({ hosted: () => true, ledger: () => ledger, graphRuns, spendGuard: async () => {}, moderate: async () => ({ ok: true }) })
    expect(await m.hold('u1', 'run_x.0.t0', 15)).toBe(1)
    expect(ledger.hold).toHaveBeenCalledWith('u1', 15, 'runner:run_x.0.t0')
    expect(graphRuns.create).toHaveBeenCalledWith({ promptId: 'run_x.0.t0', userId: 'u1', credits: 15, holdId: 1, target: 'runner' })
  })
  it('refuses with the numbers when credits run short', async () => {
    const { ledger, graphRuns } = fakes(10)
    const m = createMetering({ hosted: () => true, ledger: () => ledger, graphRuns, spendGuard: async () => {}, moderate: async () => ({ ok: true }) })
    await expect(m.hold('u1', 'k', 15)).rejects.toMatchObject({ statusCode: 402, data: { required: 15, available: 10 } })
  })
  it('a stage that costs nothing still records ownership but holds nothing', async () => {
    const { ledger, graphRuns } = fakes()
    const m = createMetering({ hosted: () => true, ledger: () => ledger, graphRuns, spendGuard: async () => {}, moderate: async () => ({ ok: true }) })
    expect(await m.hold('u1', 'k', 0)).toBeNull()
    expect(ledger.hold).not.toHaveBeenCalled()
    expect(graphRuns.create).toHaveBeenCalledWith({ promptId: 'k', userId: 'u1', credits: 0, holdId: null, target: 'runner' })
  })
  it('charges the exact amount, or drops the hold when nothing was made', async () => {
    const { ledger, graphRuns } = fakes()
    const m = createMetering({ hosted: () => true, ledger: () => ledger, graphRuns, spendGuard: async () => {}, moderate: async () => ({ ok: true }) })
    const c = charge()
    await m.finish('u1', c, 9)
    expect(ledger.settle).toHaveBeenCalledWith(7, 9, 'runner:run_x.0.t0')
    expect(c).toMatchObject({ state: 'settled', actual: 9, finished: true })
    expect(graphRuns.resolve).toHaveBeenCalledWith('run_x.0.t0', 'settled')
    const d = charge({ stageKey: 'run_x.0.t1' })
    await m.finish('u1', d, 0)
    expect(ledger.release).toHaveBeenCalledWith(7)
    expect(d).toMatchObject({ state: 'released', actual: 0, finished: true })
    expect(graphRuns.resolve).toHaveBeenCalledWith('run_x.0.t1', 'voided')
  })
  it('does not record a charge when the hold was already released — files still stay viewable', async () => {
    const { ledger, graphRuns } = fakes()
    ledger.settle = vi.fn(async () => ({ settled: false }))
    const m = createMetering({ hosted: () => true, ledger: () => ledger, graphRuns, spendGuard: async () => {}, moderate: async () => ({ ok: true }) })
    const c = charge()
    await m.finish('u1', c, 9)
    expect(c).toMatchObject({ state: 'released', actual: 0, finished: true })
    expect(graphRuns.resolve).toHaveBeenCalledWith('run_x.0.t0', 'settled')
  })
  it('records each saved file against the stage so /view lets its owner see it', async () => {
    const { ledger, graphRuns } = fakes()
    const m = createMetering({ hosted: () => true, ledger: () => ledger, graphRuns, spendGuard: async () => {}, moderate: async () => ({ ok: true }) })
    await m.addOutput('u1', 'k', { filename: 'generate_image_00001_.png', subfolder: 'u_abc', type: 'output' })
    expect(graphRuns.appendOutput).toHaveBeenCalledWith('k', 'output:u_abc:generate_image_00001_.png')
  })
  it('never throws when the output ownership row fails to write', async () => {
    const { ledger, graphRuns } = fakes()
    graphRuns.appendOutput = vi.fn(async () => { throw new Error('db down') })
    const m = createMetering({ hosted: () => true, ledger: () => ledger, graphRuns, spendGuard: async () => {}, moderate: async () => ({ ok: true }) })
    await expect(m.addOutput('u1', 'k', { filename: 'a.png', subfolder: '', type: 'output' })).resolves.toBeUndefined()
  })
  it('runs the spending check and the content check', async () => {
    const { ledger, graphRuns } = fakes()
    const spendGuard = vi.fn(async () => {})
    const moderate = vi.fn(async () => ({ ok: false as const, categories: ['violence'] }))
    const m = createMetering({ hosted: () => true, ledger: () => ledger, graphRuns, spendGuard, moderate })
    await m.spendGuard('u1')
    expect(spendGuard).toHaveBeenCalledWith('u1')
    await expect(m.moderate([{ '1': { class_type: 'GenerateImageNode', inputs: { prompt: 'bad' } } }]))
      .rejects.toMatchObject({ statusCode: 400, data: { categories: ['violence'] } })
    expect(moderate).toHaveBeenCalledWith('bad')
  })
})

describe('local metering', () => {
  it('moves no money and writes no rows', async () => {
    const { ledger, graphRuns } = fakes()
    const m = createMetering({ hosted: () => false, ledger: () => ledger, graphRuns, spendGuard: async () => { throw new Error('no') }, moderate: async () => ({ ok: false, categories: [] }) })
    await m.spendGuard(null)
    await m.moderate([{}])
    expect(await m.hold(null, 'k', 15)).toBeNull()
    const c = charge({ holdId: null, state: 'free' })
    await m.finish(null, c, 9)
    expect(c).toMatchObject({ state: 'free', actual: null, finished: true })
    expect(ledger.hold).not.toHaveBeenCalled()
    expect(graphRuns.create).not.toHaveBeenCalled()
  })
})
