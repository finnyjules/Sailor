/**
 * R3.16: Turntable, front view only (family `turntable`) — Luma Ray 2 720p on
 * Replicate through the video table, no backup — against what its real
 * Python sends and returns (fixtures/runner-paid-turntable.json,
 * scripts/runner_paid_fixtures.py --group turntable): both directions, blank,
 * spaced, non-ASCII and missing instructions, each answer shape; the prompts
 * and plan_segments for every subset of views (for R3.17). Priced by what it
 * sends on both paths (ruling (b)): 135 credits front only; with views, one
 * Seedance 2.0 720p arc per segment (456, 684 or 912), left to the engine.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { makeKit } from './__runner__/kit'
import { normalizeSent, runPaidCase, wireText, type PaidCase } from './__runner__/paidParity'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import type { ApiPrompt } from '#shared/runner/graph'
import { RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { IMAGE_OUTPUT_CLASSES, PAID_PICTURE_FAMILY, PROVIDER_TYPES, RUNNER_NODE_RULES, isRunnerEligible, outputKindsFor, runnerTakesNode, valueWiresAllowed } from '#shared/runner/eligibility'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { RUNNER_OUTPUT_CLASSES } from '#shared/runner/validate'
import {
  TURNTABLE_CLASS, TURNTABLE_DIRECTIONS, TURNTABLE_FRONT_MODEL, TURNTABLE_VIEWS_MODEL, TURNTABLE_VIEW_INPUTS, planSegments, turntableViews,
} from '#shared/runner/turntable'
import { PAID_NODE_CLASSES, paidCalls, paidNoCall } from '#shared/pricing/paidSettings'
import { priceNode } from '#shared/pricing/nodePrice'
import { creditsForUsd, usdChargedAtCost } from '#shared/pricing/markup'
import { VIDEO_RATES, videoPriceUsd } from '#shared/pricing/videoRates'
import { PRE_R3_FLAT, estimateFloored } from '#shared/pricing/estimateFloor'
import { BASE_RENDER_CREDITS, GRAPH_NODE_CREDITS, PRICE_BOOK_VERSION, priceGraph } from '~~/server/utils/priceBook'
import { PAID_TEXT_INPUTS, extraPromptTexts, nodeCredits, stageEstimate } from '~~/server/runner/metering'
import { planNode, type PlanContext } from '~~/server/runner/executors'
import { SEG, SPIN, segmentInstruction, simpleSpinInstruction } from '~~/server/runner/generators/turntable'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import { RUNNER_REPLICATE_VIDEO_MODELS } from '~~/server/runner/generators/video'
import type { OutputFile } from '~~/server/runner/types'

interface Catalogue {
  spin: string
  seg: string
  simple_spin_instruction: { direction: string; instructions: string | null; out: string }[]
  segment_instruction: { degrees: number; direction: string; instructions: string | null; out: string }[]
  plan_segments: { extra: string[]; direction: string; out: [string, string, number][] }[]
}
const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'runner-paid-turntable.json'), 'utf8')) as { cases: PaidCase[]; catalogue: Catalogue }
const CASES = FIXTURE.cases
const CAT = FIXTURE.catalogue
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const ON: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'turntable'])
const SLUG = RUNNER_REPLICATE_VIDEO_MODELS[TURNTABLE_FRONT_MODEL]!.slug
const LUMA = loadProviderSchema('replicate', SLUG)
const L = ['x', 0]

const caseNamed = (name: string): PaidCase => {
  const c = CASES.find(x => x.name === name)
  if (!c) throw new Error(`no fixture case ${name}`)
  return c
}

/** A LoadImage feeding the front picture (Turntable is an output node: no card needed). */
function withPicture(c: PaidCase, id = 'n'): ApiPrompt {
  const p: ApiPrompt = { [id]: { class_type: c.class_type, inputs: { ...c.widgets } } }
  for (const name of c.pictures ?? []) {
    p[`p_${name}`] = { class_type: 'LoadImage', inputs: { image: `${name}.png`, upload: 'image' } }
    p[id]!.inputs[name] = [`p_${name}`, 0]
  }
  return p
}

async function planOf(inputs: Record<string, unknown>) {
  const ctx: PlanContext = {
    prompt: { n: { class_type: TURNTABLE_CLASS, inputs } }, nodeId: 'n', gateOpen: false,
    filesFrom: link => (String(link[0]).startsWith('p_') ? [{ filename: `${String(link[0]).slice(2)}.png`, subfolder: '', type: 'input' }] : []),
    toUrl: async (f: OutputFile) => `https://fal.storage/${f.filename}`,
  }
  return planNode(ctx)
}

/** A hosted or local kit whose Replicate answers a clip, the front picture in its input folder. */
async function kitFor(o: { hosted?: boolean; families?: ReadonlySet<RunnerFamily>; moderate?: NonNullable<Parameters<typeof makeKit>[0]>['moderate']; download?: (url: string) => Promise<{ bytes: Uint8Array; contentType: string | null }> } = {}) {
  const reportError = vi.fn()
  const k = makeKit({
    hosted: o.hosted, available: 50_000, moderate: o.moderate,
    deps: { families: () => o.families ?? ON, reportError, ...(o.download ? { download: o.download as never } : {}) },
  })
  const png = await sharp({ create: { width: 8, height: 6, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer()
  writeFileSync(join(k.root, 'input', 'image.png'), png)
  return { k, reportError }
}

describe('the fixture', () => {
  it('covers both directions × every instruction text, the missing ones, each answer shape, and every plan_segments subset', () => {
    const names = new Set(CASES.map(c => c.name))
    for (const d of TURNTABLE_DIRECTIONS) {
      for (const t of ['blank', 'spaces', 'padded', 'non-ASCII', 'unicode blanks', 'braces', 'missing', 'None']) expect(names.has(`${d} · instructions ${t}`), `${d} ${t}`).toBe(true)
    }
    expect(names.has('answer list · the first is kept')).toBe(true)
    // One Luma Ray 2 call on Replicate each, and no error.
    for (const c of CASES) {
      expect(c.error, c.name).toBeUndefined()
      expect(c.calls.map(x => `${x.provider} ${x.endpoint}`), c.name).toEqual([`replicate ${SLUG}`])
    }
    // plan_segments: every subset of the three views, both directions.
    expect(CAT.plan_segments.length).toBe(16)
    expect(CASES.length).toBe(18)
  })
})

describe('the catalogue: _turntable_prompts.py and _turntable_plan.py, ported line for line', () => {
  it('_SPIN and _SEG verbatim', () => {
    expect(SPIN).toBe(CAT.spin)
    expect(SEG).toBe(CAT.seg)
  })
  it('simple_spin_instruction and segment_instruction, byte for byte', () => {
    for (const x of CAT.simple_spin_instruction) expect(simpleSpinInstruction(x.direction, x.instructions), `${x.direction} ${JSON.stringify(x.instructions)}`).toBe(x.out)
    for (const x of CAT.segment_instruction) expect(segmentInstruction(x.degrees, x.direction, x.instructions), `${x.degrees} ${x.direction} ${JSON.stringify(x.instructions)}`).toBe(x.out)
  })
  it('plan_segments for every subset of views and both directions (for R3.17)', () => {
    for (const x of CAT.plan_segments) expect(planSegments(x.extra, x.direction), `${x.extra.join('+')} ${x.direction}`).toEqual(x.out)
    // Segment degrees sum to 360, and the arcs close on the front.
    for (const x of CAT.plan_segments) {
      expect(x.out.reduce((s, a) => s + a[2], 0)).toBe(360)
      expect(x.out[x.out.length - 1]![1]).toBe('front')
    }
  })
})

describe('every fixture case: what Python sends and returns', () => {
  it.each(CASES.map(c => [c.name, c] as const))('%s', async (_n, c) => {
    const plan = await planOf(withPicture(c).n!.inputs)
    if (plan.kind !== 'provider') throw new Error(`planned ${plan.kind}`)
    const py = c.calls[0]!
    expect(plan.provider).toBe('replicate')
    expect(plan.endpoint).toBe(py.endpoint)
    const payload = normalizeSent([{ provider: 'replicate', endpoint: plan.endpoint, payload: plan.payload }], c.pictures ?? [])[0]!.payload
    expect(payload).toEqual(py.payload)
    expect(wireText(payload)).toBe(py.payload_json)
    expect(checkPayload(LUMA, plan.payload)).toEqual([])
    // `_first_output_url`: the first URL is the clip; Python returns no ui; Luma Ray 2 has no backup.
    expect(plan.media).toBe('video')
    expect(plan.take).toBe('first')
    expect(plan.backup).toBeUndefined()
    expect(c.ui).toBeNull()
    expect(plan.uiFor([{ filename: 'x.mp4', subfolder: '', type: 'output' }])).toBeNull()
    expect(plan.prefix).toBe('turntable')
    expect((c.output as { video: string }[])[0]!.video).toBe('https://r.test/turntable/spin.mp4')
  })

  it('reuses Generate a video\'s Luma builder: the same request as a Generate a video node set that way', async () => {
    const c = caseNamed('right · instructions padded')
    const t = await planOf(withPicture(c).n!.inputs)
    const v = await planNode({
      prompt: { n: { class_type: 'GenerateVideoNode', inputs: { model: TURNTABLE_FRONT_MODEL, prompt: simpleSpinInstruction('right', c.widgets.instructions as string), image: ['p_image', 0], aspect_ratio: '1:1', duration: 5, seed: 0, model_options: '{"loop": true}' } } },
      nodeId: 'n', gateOpen: false,
      filesFrom: () => [{ filename: 'image.png', subfolder: '', type: 'input' }],
      toUrl: async (f: OutputFile) => `https://fal.storage/${f.filename}`,
    })
    if (t.kind !== 'provider' || v.kind !== 'provider') throw new Error('no call')
    expect([t.provider, t.endpoint, t.payload]).toEqual([v.provider, v.endpoint, v.payload])
  })
})

describe('every fixture case through the engine (cards and turntable on)', () => {
  it.each(CASES.map(c => [c.name, c] as const))('%s', async (_n, c) => {
    expect(runnerTakesNode(withPicture(c), 'n', ON)).toBe(true)
    const r = await runPaidCase(c, { families: ON })
    expect(r.status, r.error ?? '').toBe('done')
    expect(normalizeSent(r.sent, c.pictures).map(s => s.payload)).toEqual(c.calls.map(x => x.payload))
    // The first answer URL only, kept as the node's clip.
    expect(r.files.length).toBe(1)
    expect(r.files[0]!.filename).toMatch(/^turntable.*\.mp4$/)
    expect(r.credits).toBe(135)
  })

  it('into a Video card: the card shows the spin', async () => {
    const c = caseNamed('left · instructions blank')
    const p: ApiPrompt = { ...withPicture(c), v: { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'video/ComfyUI', source: ['n', 0] } } }
    expect(isRunnerEligible(p, ON)).toBe(true)
    const { k } = await kitFor()
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const take = (await k.store.get(runId))!.takes[0]!
    expect(take.nodes.n!.status, take.nodes.n!.error ?? '').toBe('done')
    expect(take.nodes.v!.outputs.map(f => f.filename)).toEqual(take.nodes.n!.outputs.map(f => f.filename))
  })
})

// ── Prices (ruling (b)) ──────────────────────────────────────────────────────

describe('prices: by what it sends, on both paths (ruling (b))', () => {
  const front = withPicture(caseNamed('left · instructions blank')).n!.inputs
  const views = (...names: string[]) => ({ ...front, ...Object.fromEntries(names.map(n => [n, L])) })

  it('front only: Luma Ray 2 720p, 5 s × $0.18 = $0.90 (verified) → 135 credits (was a flat 75)', async () => {
    expect(VIDEO_RATES[TURNTABLE_FRONT_MODEL]).toMatchObject({ confidence: 'verified', service: 'replicate', byResolution: { '*': 0.18 } })
    expect(videoPriceUsd(TURNTABLE_FRONT_MODEL, { seconds: 5, resolution: '720p', audio: false, inputVideoSeconds: 0 })).toBe(0.9)
    expect(paidCalls(TURNTABLE_CLASS, front, {})).toEqual({ steps: [{ call: { endpoint: TURNTABLE_FRONT_MODEL, tier: '720p', outputSeconds: 5, audio: false }, times: 1 }] })
    expect(priceNode(TURNTABLE_CLASS, front)).toEqual({ usd: 0.9, credits: 135 })
    expect(priceGraph({ 1: { class_type: TURNTABLE_CLASS, inputs: front } }).nodes!['1']).toBe(135)
    expect(priceGraph({ 1: { class_type: TURNTABLE_CLASS, inputs: front } }, { families: ON }).nodes!['1']).toBe(135)
    expect(nodeCredits({ class_type: TURNTABLE_CLASS, inputs: front }, undefined, ON)).toBe(135)
    const { nodeCreditEstimate } = await import('~/lib/nodeCreditEstimate')
    expect(nodeCreditEstimate(TURNTABLE_CLASS, front)).toBe(135 + BASE_RENDER_CREDITS)
    // Whatever the direction or the extra direction.
    for (const c of CASES) expect(priceNode(TURNTABLE_CLASS, withPicture(c).n!.inputs), c.name).toEqual({ usd: 0.9, credits: 135 })
  })

  it('with views: one Seedance 2.0 720p arc per segment (5 s × $0.3034, 228 credits each): 456, 684 or 912', () => {
    expect(VIDEO_RATES[TURNTABLE_VIEWS_MODEL]).toMatchObject({ confidence: 'verified' })
    const arc = videoPriceUsd(TURNTABLE_VIEWS_MODEL, { seconds: 5, resolution: '720p', audio: true, inputVideoSeconds: 0 })!
    expect(arc).toBe(1.517)
    expect(creditsForUsd(arc)).toBe(228)
    const want: [string[], number][] = [
      [['right_reference'], 456], [['back_reference'], 456], [['left_reference'], 456],
      [['right_reference', 'back_reference'], 684], [['right_reference', 'left_reference'], 684], [['back_reference', 'left_reference'], 684],
      [['right_reference', 'back_reference', 'left_reference'], 912],
    ]
    for (const [names, credits] of want) {
      for (const direction of [...TURNTABLE_DIRECTIONS, L]) {
        const inputs = { ...views(...names), direction }
        const arcs = planSegments(turntableViews(inputs), typeof direction === 'string' ? direction : 'left').length
        expect(paidCalls(TURNTABLE_CLASS, inputs, {})).toEqual({ steps: [{ call: { endpoint: TURNTABLE_VIEWS_MODEL, tier: '720p', outputSeconds: 5, audio: true }, times: arcs }] })
        expect(priceGraph({ 1: { class_type: TURNTABLE_CLASS, inputs } }).nodes!['1'], `${names.join('+')} ${String(direction)}`).toBe(credits)
        const p = priceNode(TURNTABLE_CLASS, inputs)
        if ('refused' in p) throw new Error(p.refused)
        expect(p.credits).toBe(credits)
        // R3.14: the dollars shown mark up to the credits held.
        expect(creditsForUsd(p.usd)).toBe(credits)
      }
    }
    // Four arcs: the summed basis ($6.068) would mark up to 911, so the dollars shown are the ones that mark up to 912.
    expect(priceNode(TURNTABLE_CLASS, views('right_reference', 'back_reference', 'left_reference'))).toEqual({ usd: usdChargedAtCost(9.12), credits: 912 })
  })

  it('the flat row is gone; no estimate floor (both cards verified); no no-call branch; the price book moved', () => {
    expect(PAID_NODE_CLASSES).toContain(TURNTABLE_CLASS)
    expect(Object.prototype.hasOwnProperty.call(GRAPH_NODE_CREDITS, TURNTABLE_CLASS)).toBe(false)
    expect(PRE_R3_FLAT[TURNTABLE_CLASS]).toEqual({ credits: 75, badgeUsd: 0.5, family: 'turntable' })
    const p = priceNode(TURNTABLE_CLASS, front)
    expect(estimateFloored(TURNTABLE_CLASS, front, p)).toEqual(p)
    expect(paidNoCall(TURNTABLE_CLASS, front)).toBe(false)
    expect(paidNoCall(TURNTABLE_CLASS, {})).toBe(false)
    expect(PRICE_BOOK_VERSION).toBe('r3-turntable')
  })

  it('hosted: held at 135 and charged 135', async () => {
    const c = caseNamed('right · instructions non-ASCII')
    const p = withPicture(c)
    expect(stageEstimate(p, ['n'], false, ON)).toBe(135)
    const { k } = await kitFor({ hosted: true })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const rec = (await k.store.get(runId))!.takes[0]!.nodes.n!
    expect(rec.status, rec.error ?? '').toBe('done')
    expect([...k.ledger.holds.values()].map(h => [h.credits, h.actual])).toEqual([[135, 135]])
  })

  it('a lost download is not charged (Sailor absorbs the call)', async () => {
    const { k, reportError } = await kitFor({ hosted: true, download: async () => { throw new Error('connection reset') } })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [withPicture(caseNamed('left · instructions blank'))], ...START })
    await k.engine.settled(runId)
    const rec = (await k.store.get(runId))!.takes[0]!.nodes.n!
    expect(rec.status).toBe('error')
    expect(k.replicate.client.submit).toHaveBeenCalledTimes(1)
    expect([...k.ledger.holds.values()].map(h => [h.state, h.actual ?? 0])).toEqual([['released', 0]])
    expect(reportError.mock.calls.map(x => (x[1] as { site: string }).site)).toContain('runner.download.lost')
  })
})

// ── Views: the engine's until R3.17 ──────────────────────────────────────────

describe('a Turntable with views is left to the engine, priced by its Seedance arcs', () => {
  it('any wired view, or a wired direction, leaves it to the engine; nodesNeedingEngine names it', () => {
    const base = withPicture(caseNamed('left · instructions blank'))
    for (const view of Object.keys(TURNTABLE_VIEW_INPUTS)) {
      const p: ApiPrompt = { ...base, v: { class_type: 'LoadImage', inputs: { image: 'side.png', upload: 'image' } }, n: { ...base.n!, inputs: { ...base.n!.inputs, [view]: ['v', 0] } } }
      expect(runnerTakesNode(p, 'n', ON), view).toBe(false)
      expect(nodesNeedingEngine(p, { runnerOn: true, families: ON, titleOf: id => id }), view).toEqual(['n'])
      expect(priceGraph(p).nodes!.n, view).toBe(456)
    }
    const wired: ApiPrompt = { ...base, t: { class_type: 'Text', inputs: { text: 'left' } }, n: { ...base.n!, inputs: { ...base.n!.inputs, direction: ['t', 0] } } }
    expect(runnerTakesNode(wired, 'n', ON)).toBe(false)
    expect(priceGraph(wired).nodes!.n).toBe(135)
    // With no front picture (Python raises) it stays with the engine too.
    expect(runnerTakesNode({ n: { class_type: TURNTABLE_CLASS, inputs: { direction: 'left', instructions: '' } } }, 'n', ON)).toBe(false)
    // An unknown direction ComfyUI's validation refuses.
    expect(runnerTakesNode({ ...base, n: { ...base.n!, inputs: { ...base.n!.inputs, direction: 'up' } } }, 'n', ON)).toBe(false)
  })

  it('the planner never sends a views path (a backstop behind the rule row)', async () => {
    await expect(planOf({ ...withPicture(caseNamed('left · instructions blank')).n!.inputs, back_reference: ['p_image', 0] })).rejects.toThrow('A Turntable with extra views runs on the engine')
  })
})

// ── Refusals before the hold ─────────────────────────────────────────────────

describe('refusals before the hold', () => {
  it('hosted: a front picture that isn\'t the user\'s own is refused before the hold, nothing sent', async () => {
    const k = makeKit({ hosted: true, available: 50_000, deps: { families: () => ON, ownership: { ownsInput: async () => false, ownsOutput: async () => false } } })
    writeFileSync(join(k.root, 'input', 'image.png'), await sharp({ create: { width: 8, height: 6, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer())
    await expect(k.engine.startRun({ userId: k.userId, takes: [withPicture(caseNamed('left · instructions blank'))], ...START })).rejects.toThrow('isn’t one of yours')
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
  })
})

// ── Moderation ───────────────────────────────────────────────────────────────

describe('moderation', () => {
  it('lists the extra direction (Sailor\'s own spin text is not the user\'s)', () => {
    expect(PAID_TEXT_INPUTS.TurntableNode).toEqual(['instructions'])
    expect(extraPromptTexts({ n: { class_type: TURNTABLE_CLASS, inputs: { direction: 'left', instructions: 'matte black' } } })).toEqual(['matte black'])
  })

  it('a hosted flagged extra direction is refused at the start, before the hold', async () => {
    const moderate = vi.fn(async (t: string) => (t.includes('forbidden') ? { ok: false as const, categories: ['violence'] } : { ok: true as const }))
    const { k } = await kitFor({ hosted: true, moderate })
    const c = caseNamed('left · instructions blank')
    const p = withPicture({ ...c, widgets: { ...c.widgets, instructions: 'a forbidden thing' } })
    await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START })).rejects.toThrow()
    expect(moderate.mock.calls.map(x => x[0])).toContain('a forbidden thing')
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
  })

  it('a wired extra direction from a Text card arrives as typed, and is moderated', async () => {
    const moderate = vi.fn(async (t: string) => (t.includes('forbidden') ? { ok: false as const, categories: ['violence'] } : { ok: true as const }))
    const base = withPicture(caseNamed('left · instructions blank'))
    const p: ApiPrompt = { ...base, t: { class_type: 'Text', inputs: { text: '  glossy  ' } }, n: { ...base.n!, inputs: { ...base.n!.inputs, instructions: ['t', 0] } } }
    expect(runnerTakesNode(p, 'n', ON)).toBe(true)
    const { k } = await kitFor({ hosted: true, moderate })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.takes[0]!.nodes.n!.status).toBe('done')
    expect([...k.replicate.reqs.values()][0]!.payload.prompt).toBe(simpleSpinInstruction('left', '  glossy  '))
    expect(moderate.mock.calls.map(x => x[0])).toContain('  glossy  ')
    const bad: ApiPrompt = { ...p, t: { class_type: 'Text', inputs: { text: 'a forbidden thing' } } }
    const two = await kitFor({ hosted: true, moderate })
    await expect(two.k.engine.startRun({ userId: two.k.userId, takes: [bad], ...START })).rejects.toThrow()
    expect(two.k.ledger.hold).not.toHaveBeenCalled()
  })
})

// ── With turntable off (rule 15) ─────────────────────────────────────────────

describe('with turntable off (rule 15)', () => {
  const OFF_SETS: [string, RunnerFamily[]][] = [
    ['none', []],
    ['cards only', ['cards']],
    ['every family but turntable', RUNNER_FAMILIES.filter(f => f !== 'turntable')],
  ]
  const isOurs = (ct: string) => ct === TURNTABLE_CLASS
  /** The same prompt as before R3.16: the class had no rule row (renamed to one that has none). */
  const before = (p: ApiPrompt): ApiPrompt => Object.fromEntries(Object.entries(p).map(([id, n]) => [id, isOurs(n.class_type) ? { ...n, class_type: `${n.class_type}Before` } : n]))
  function sameAsBefore(p: ApiPrompt, label: string) {
    const old = before(p)
    for (const [name, fam] of OFF_SETS) {
      const families = new Set(fam)
      const titleOf = (id: string) => id
      expect(nodesNeedingEngine(p, { runnerOn: true, families, titleOf }), `${label}, ${name}`).toEqual(nodesNeedingEngine(old, { runnerOn: true, families, titleOf }))
      expect(isRunnerEligible(p, families), `${label}, ${name}`).toBe(isRunnerEligible(old, families))
      for (const id of Object.keys(p)) {
        expect(runnerTakesNode(p, id, families), `${label} ${id}, ${name}`).toBe(runnerTakesNode(old, id, families))
        if (!isOurs(p[id]!.class_type)) {
          expect(valueWiresAllowed(p, id, outputKindsFor(families)), `${label} ${id}, ${name}`).toBe(valueWiresAllowed(old, id, outputKindsFor(families)))
        }
      }
    }
  }
  const spin = () => withPicture(caseNamed('left · instructions blank'))

  it('the class is left to the engine, and named by the needs-the-engine list', () => {
    const p = spin()
    expect(runnerTakesNode(p, 'n', new Set(['cards']))).toBe(false)
    expect(runnerTakesNode(p, 'n', new Set(['turntable']))).toBe(false)
    expect(runnerTakesNode(p, 'n', ON)).toBe(true)
    expect(nodesNeedingEngine(p, { runnerOn: true, families: new Set(['cards']), titleOf: id => id })).toEqual(['n'])
    expect(RUNNER_OUTPUT_CLASSES.has(TURNTABLE_CLASS)).toBe(true)
    expect(IMAGE_OUTPUT_CLASSES.has(TURNTABLE_CLASS)).toBe(false)
    expect(PAID_PICTURE_FAMILY[TURNTABLE_CLASS]).toBeUndefined()
    expect(PROVIDER_TYPES.has(TURNTABLE_CLASS)).toBe(true)
    expect(RUNNER_NODE_RULES[TURNTABLE_CLASS]!.family).toBe('turntable')
    expect(RUNNER_ROUTES[TURNTABLE_CLASS]).toMatchObject({ first: 'replicate', backup: null })
  })

  it('over synthetic chains: into a Video card, into an Image card, a Text card into the extra direction, with views', () => {
    const p = spin()
    sameAsBefore(p, 'alone')
    sameAsBefore({ ...p, v: { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'video/ComfyUI', source: ['n', 0] } } }, '→ Video card')
    sameAsBefore({ ...p, i: { class_type: 'Image', inputs: { image: '', images: ['n', 0] } } }, '→ Image card')
    sameAsBefore({ ...p, t: { class_type: 'Text', inputs: { text: 'hi' } }, n: { ...p.n!, inputs: { ...p.n!.inputs, instructions: ['t', 0] } } }, 'Text → Turntable')
    sameAsBefore({ ...p, n: { ...p.n!, inputs: { ...p.n!.inputs, back_reference: ['p_image', 0] } } }, 'with a view')
  })

  const PROJECTS = resolve(__dirname, '../../../user/sailor/projects')
  const projectsIt = existsSync(PROJECTS) ? it : it.skip

  projectsIt('over every saved project graph (with a Turntable spliced in beside each)', async () => {
    const { gunzipSync } = await import('node:zlib')
    const { graphToPrompt } = await import('~/lib/graph/graphToPrompt')
    const catalog = JSON.parse(gunzipSync(readFileSync(resolve(__dirname, '../../server/native/objectInfo.baseline.json.gz'))).toString('utf8'))
    let graphs = 0
    for (const uuid of readdirSync(PROJECTS).sort()) {
      let wf: { canvases?: { workflow: unknown }[] } | undefined
      try { wf = JSON.parse(readFileSync(join(PROJECTS, uuid, 'versions', 'current.json'), 'utf8')).workflow }
      catch { continue }
      for (const c of wf?.canvases ?? []) {
        let p: ApiPrompt
        try { p = graphToPrompt(c.workflow as never, catalog) }
        catch { continue }
        graphs++
        sameAsBefore(p, uuid)
        sameAsBefore({
          ...p,
          d_img: { class_type: 'LoadImage', inputs: { image: 'x.png', upload: 'image' } },
          d_tt: { class_type: TURNTABLE_CLASS, inputs: { direction: 'left', instructions: '', image: ['d_img', 0] } },
        }, `${uuid} + Turntable`)
      }
    }
    expect(graphs).toBeGreaterThanOrEqual(800)
    console.info(`turntable families-off invariant: ${graphs} saved graphs`)
  }, 600_000)
})
