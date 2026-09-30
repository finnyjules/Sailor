/**
 * R3.17: Turntable with views (family `turntable`, with `media-video`: the
 * stitch is Sailor's own video tools) — one Seedance 2.0 first → last frame
 * call on fal per arc plan_segments plans (2 to 4), then the answers' clips
 * joined as _turntable_stitch.stitch_clips joins them — against what its real
 * Python sends and makes (fixtures/runner-paid-turntable-views.json,
 * scripts/runner_paid_fixtures.py --group turntable-views).
 *
 * The stitch is judged by ruling (c) as R5 applied it (the controller's notes
 * for R3.17): the frame count, rate and length exact; the clips joined in
 * Python's order with the first frame of every clip after the first dropped,
 * exactly; the decoded frames equal, byte for byte, Python's own stitch
 * switched to libopenh264 at OPENH264_FOR[20]; and no further from the source
 * frames (the clips' own, as joined) than Python's libx264 file, within
 * 0.5 dB. Named case: noisy clips (R2.1's synth noise), held to the same.
 * A clip of another size is scaled to the first's: its PSNR has no source
 * of that size, so only the equality with Python's OpenH264 run holds it.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createFakeFal, makeKit, until } from './__runner__/kit'
import { normalizeSent, runPaidCase, wireText, type PaidCase } from './__runner__/paidParity'
import { requireMediaTools, sha256Hex, type PyVideoOut } from './__runner__/mediaParity'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import type { ApiPrompt } from '#shared/runner/graph'
import { RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { isRunnerEligible, outputKindsFor, runnerTakesNode, valueWiresAllowed } from '#shared/runner/eligibility'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { TURNTABLE_CLASS, TURNTABLE_VIEWS_MODEL, planSegments, turntableViews } from '#shared/runner/turntable'
import { paidCalls, turntableArcCall } from '#shared/pricing/paidSettings'
import { paidCallUsd } from '#shared/pricing/paidRates'
import { priceNode } from '#shared/pricing/nodePrice'
import { creditsForUsd } from '#shared/pricing/markup'
import { priceGraph } from '~~/server/utils/priceBook'
import { stageEstimate } from '~~/server/runner/metering'
import { planNode, type PlanContext } from '~~/server/runner/executors'
import { TURNTABLE_STITCH_QUALITY, segmentRequest, stitchRate, turntableSegments } from '~~/server/runner/generators/turntable'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import { createFileKeptBytes } from '~~/server/runner/keptBytes'
import { decodeFrames } from '~~/server/media/decode'
import { probeMedia, pyRawDuration } from '~~/server/media/probe'
import type { OutputFile } from '~~/server/runner/types'

interface ViewsCase extends PaidCase {
  clip_set: 'smooth' | 'noise' | 'sizes'
  /** sha256 of each clip in the order stitch_clips was handed them. */
  stitch_order?: string[]
  stitch?: { x264: PyVideoOut; openh264: PyVideoOut }
}
interface Clip { b64: string; sha256: string; frames: string[] }
const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'runner-paid-turntable-views.json'), 'utf8')) as { cases: ViewsCase[]; clips: Record<string, Clip> }
const CASES = FIXTURE.cases
const STITCHED = CASES.filter(c => !c.error)
const FAILS_AT_3 = 'right+back+left · left · segment 3 fails'
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const ON: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'turntable', 'media-video'])
const SEEDANCE_I2V = 'bytedance/seedance-2.0/image-to-video'
const SCHEMA = loadProviderSchema('fal', SEEDANCE_I2V)
/** One arc: Seedance 2.0 at 720p, 5 s with its sound (fal's default), $0.3034 a second. */
const ARC_CREDITS = 228
const LONG = { timeout: 120_000 }

const scratch = mkdtempSync(join(tmpdir(), 'turntable-views-spec-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
let serial = 0

const caseNamed = (name: string): ViewsCase => {
  const c = CASES.find(x => x.name === name)
  if (!c) throw new Error(`no fixture case ${name}`)
  return c
}
const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))

/** The case's prompt: a LoadImage per picture input, as runPaidCase wires it. */
function promptOf(c: PaidCase): ApiPrompt {
  const p: ApiPrompt = { n: { class_type: c.class_type, inputs: { ...c.widgets } } }
  for (const name of c.pictures ?? []) {
    p[`p_${name}`] = { class_type: 'LoadImage', inputs: { image: `${name}.png`, upload: 'image' } }
    p.n!.inputs[name] = [`p_${name}`, 0]
  }
  return p
}

async function decodeAll(path: string, roots: string[]): Promise<{ frames: Uint8Array[]; pts: number[] }> {
  const frames: Uint8Array[] = []
  const pts: number[] = []
  await decodeFrames(path, { userId: null, maxFrames: 10_000, roots, onFrame: async (f, _i, t) => { frames.push(f); pts.push(t) } })
  return { frames, pts }
}

function psnr(a: Uint8Array, b: Uint8Array): number {
  let se = 0
  for (let i = 0; i < a.length; i++) { const d = a[i]! - b[i]!; se += d * d }
  const mse = se / a.length
  return mse ? 10 * Math.log10((255 * 255) / mse) : Number.POSITIVE_INFINITY
}
const concat = (list: Uint8Array[]) => {
  const out = new Uint8Array(list.reduce((n, f) => n + f.length, 0))
  let at = 0
  for (const f of list) { out.set(f, at); at += f.length }
  return out
}

/** The source frames of a stitch, decoded by Sailor's own reader: each clip's, the first of every clip after the first dropped. */
async function sourceFrames(c: ViewsCase): Promise<Uint8Array[]> {
  const out: Uint8Array[] = []
  const root = realpathSync(scratch)
  for (let k = 0; k < c.calls.length; k++) {
    const clip = FIXTURE.clips[`${c.clip_set}${k}`]!
    const path = join(root, `src-${++serial}.mp4`)
    writeFileSync(path, b64(clip.b64))
    const { frames } = await decodeAll(path, [root])
    // Sailor's reader decodes the clips as Python's does (R5.1b), frame for frame.
    expect(frames.map(sha256Hex), `${c.name}: clip ${k}`).toEqual(clip.frames)
    out.push(...(k ? frames.slice(1) : frames))
  }
  return out
}

const charged = (k: { ledger: { holds: Map<number, { credits: number; state: string; actual: number | null }> } }) =>
  [...k.ledger.holds.values()].map(h => [h.credits, h.state === 'released' ? 0 : h.actual])

// ── The fixture ──────────────────────────────────────────────────────────────

describe('the fixture', () => {
  it('covers every subset of the three views × both directions, the named cases, and a failure at segment 3', () => {
    const names = new Set(CASES.map(c => c.name))
    for (const sub of ['right', 'back', 'left', 'right+back', 'right+left', 'back+left', 'right+back+left']) {
      for (const d of ['left', 'right']) expect(names.has(`${sub} · ${d}`), `${sub} ${d}`).toBe(true)
    }
    for (const n of ['right+back+left · left · noisy clips', 'back · left · noisy clips', 'right+back+left · left · a clip of another size', FAILS_AT_3]) expect(names.has(n), n).toBe(true)
    // Every call is Seedance 2.0 first → last frame on fal; one per arc; Python's stitched file Σ − (segments − 1) frames.
    for (const c of CASES) {
      expect(c.calls.every(x => x.provider === 'fal' && x.endpoint === SEEDANCE_I2V), c.name).toBe(true)
      if (c.error) continue
      const arcs = planSegments(turntableViews(promptOf(c).n!.inputs), String(c.widgets.direction)).length
      expect(c.calls.length, c.name).toBe(arcs)
      const frames = c.calls.map((_, k) => FIXTURE.clips[`${c.clip_set}${k}`]!.frames.length)
      const want = frames.reduce((a, b) => a + b, 0) - (c.calls.length - 1)
      expect(c.stitch!.x264.frameCount, c.name).toBe(want)
      expect(c.stitch!.openh264.frameCount, c.name).toBe(want)
      // Python handed stitch_clips the clips in segment order.
      expect(c.stitch_order, c.name).toEqual(c.calls.map((_, k) => FIXTURE.clips[`${c.clip_set}${k}`]!.sha256))
      // Turntable returns no ui.
      expect(c.ui, c.name).toBeNull()
    }
    const failed = caseNamed(FAILS_AT_3)
    expect(failed.error).toEqual({ type: 'RuntimeError', message: 'The provider refused this prompt' })
    expect(failed.calls.length).toBe(3)
    expect(failed.stitch).toBeUndefined()
  })
})

// ── Requests ─────────────────────────────────────────────────────────────────

describe('every case: the segments Python sends, built by the runner', () => {
  it.each(CASES.map(c => [c.name, c] as const))('%s', (_n, c) => {
    const inputs = promptOf(c).n!.inputs
    const segs = turntableSegments(inputs)
    // Python stops at the failed call: the planned segments go on past it.
    expect(segs.length).toBeGreaterThanOrEqual(c.calls.length)
    for (const [i, py] of c.calls.entries()) {
      const s = segs[i]!
      expect(s.key).toBe(`seg-${i + 1}`)
      const name = (v: string) => (v === 'front' ? 'image' : `${v}_reference`)
      const req = segmentRequest(s.prompt, `IMG:${name(s.start)}`, `IMG:${name(s.end)}`)
      expect([req.provider, req.endpoint, req.payload], `${c.name} call ${i + 1}`).toEqual([py.provider, py.endpoint, py.payload])
      expect(wireText(req.payload)).toBe(py.payload_json)
      // Every payload passes its saved schema (with a real link in the picture fields).
      expect(checkPayload(SCHEMA, segmentRequest(s.prompt, 'https://fal.storage/a.png', 'https://fal.storage/b.png').payload)).toEqual([])
    }
  })

  it('reuses Generate a video\'s Seedance 2.0 builder: the same request as a Generate a video node set that way', async () => {
    const c = caseNamed('back · right · instructions non-ASCII')
    const s = turntableSegments(promptOf(c).n!.inputs)[0]!
    const v = await planNode({
      prompt: { n: { class_type: 'GenerateVideoNode', inputs: { model: TURNTABLE_VIEWS_MODEL, prompt: s.prompt, image: ['p_image', 0], aspect_ratio: '1:1', duration: 5, seed: 0, model_options: JSON.stringify({ end_image_url: 'https://fal.storage/back_reference.png' }) } } },
      nodeId: 'n', gateOpen: false,
      filesFrom: () => [{ filename: 'image.png', subfolder: '', type: 'input' }],
      toUrl: async (f: OutputFile) => `https://fal.storage/${f.filename}`,
    })
    if (v.kind !== 'provider') throw new Error('no call')
    const t = segmentRequest(s.prompt, 'https://fal.storage/image.png', 'https://fal.storage/back_reference.png')
    expect([t.provider, t.endpoint, t.payload]).toEqual([v.provider, v.endpoint, v.payload])
    // No backup: Seedance 2.0 has none.
    expect(v.backup).toBeUndefined()
    expect(RUNNER_ROUTES['video:seedance-2.0']).toMatchObject({ first: 'fal', backup: null })
  })

  it('plans a pipeline under the node\'s own prefix', async () => {
    const c = caseNamed('right+back+left · left')
    const ctx: PlanContext = {
      prompt: promptOf(c), nodeId: 'n', gateOpen: false, families: ON,
      filesFrom: link => [{ filename: `${String(link[0]).slice(2)}.png`, subfolder: '', type: 'input' }],
      toUrl: async (f: OutputFile) => `https://fal.storage/${f.filename}`,
    }
    const plan = await planNode(ctx)
    expect(plan.kind).toBe('pipeline')
    if (plan.kind === 'pipeline') expect(plan.prefix).toBe('turntable')
  })
})

// ── Through the engine: requests, the stitch, the charge ─────────────────────

describe('every stitched case through the engine (cards, turntable and media-video on)', () => {
  it.each(STITCHED.map(c => [c.name, c] as const))('%s', LONG, async (_n, c) => {
    await requireMediaTools()
    const root = mkdtempSync(join(tmpdir(), 'turntable-views-root-'))
    try {
      expect(runnerTakesNode(promptOf(c), 'n', ON)).toBe(true)
      const r = await runPaidCase(c, { families: ON, root })
      expect(r.status, r.error ?? '').toBe('done')
      // The requests: Python's, in order.
      expect(normalizeSent(r.sent, c.pictures).map(s => [s.provider, s.endpoint, s.payload])).toEqual(c.calls.map(x => [x.provider, x.endpoint, x.payload]))
      // Priced by its arcs: 228 credits each.
      expect(r.credits).toBe(ARC_CREDITS * c.calls.length)
      // One stitched video, saved as the node's clip.
      expect(r.files.length).toBe(1)
      const f = r.files[0]!
      expect(f.type).toBe('output')
      expect(f.filename).toMatch(/^turntable.*\.mp4$/)
      const out = join(root, 'output', f.subfolder, f.filename)
      const outRoot = realpathSync(join(root, 'output'))
      const p = await probeMedia(out, { userId: null, roots: [outRoot] })
      const py = c.stitch!
      // Frame count, rate and length: exactly Python's (both of its runs).
      expect(p.video[0]!.frames).toBe(py.openh264.frameCount)
      expect(p.video[0]!.frames).toBe(py.x264.frameCount)
      expect(p.video[0]!.averageRate).toEqual(py.openh264.frameRate)
      expect(p.video[0]!.averageRate).toEqual(py.x264.frameRate)
      expect(pyRawDuration(p)).toBe(py.openh264.duration)
      expect(pyRawDuration(p)).toBe(py.x264.duration)
      expect([p.video[0]!.w, p.video[0]!.h]).toEqual([py.x264.header.video[0]!.w, py.x264.header.video[0]!.h])
      const got = await decodeAll(out, [outRoot])
      expect(got.pts).toEqual(got.pts.map((_, i) => i / 24))
      // Byte for byte, Python's own stitch switched to libopenh264 (same frames, same settings).
      expect(got.frames.map(sha256Hex), 'equal to Python’s stitch on libopenh264').toEqual(py.openh264.frames)
      // No further from the source frames than Python's libx264 file, within 0.5 dB.
      if (py.x264.psnr != null) {
        const src = concat(await sourceFrames(c))
        const ours = psnr(src, concat(got.frames))
        expect(ours, 'no further from the source than libx264').toBeGreaterThanOrEqual(py.x264.psnr - 0.5)
        console.info(`[turntable-views] ${c.name}: PSNR ours ${ours.toFixed(2)} dB, libx264 ${py.x264.psnr.toFixed(2)} dB`)
      }
      else expect(c.clip_set).toBe('sizes')
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('joins the clips in Python\'s order: each segment\'s clip kept by its bytes, stitched in segment order', LONG, async () => {
    await requireMediaTools()
    const c = caseNamed('right+back+left · right')
    const { k, runId } = await runKit(c)
    await k.engine.settled(runId)
    const rec = (await k.store.get(runId))!.takes[0]!.nodes.n!
    expect(rec.status, rec.error ?? '').toBe('done')
    expect(rec.calls!.map(x => x.key)).toEqual(['seg-1', 'seg-2', 'seg-3', 'seg-4'])
    const kept = rec.calls!.map(x => (x.saved as Record<string, OutputFile>).clip!)
    expect(kept.map(f => f.type)).toEqual(['kept', 'kept', 'kept', 'kept'])
    expect(kept.map(f => f.filename)).toEqual(c.stitch_order!.map(s => `${s}.mp4`))
  })

  it('the stitch: the first clip\'s rate (PyAV\'s average_rate, else 24), CRF 20 veryfast', () => {
    expect(TURNTABLE_STITCH_QUALITY).toEqual({ crf: 20, preset: 'veryfast' })
    const probe = (averageRate: { num: number; den: number } | null) => ({ video: [{ averageRate }] }) as never
    expect(stitchRate(probe({ num: 30000, den: 1001 }))).toEqual({ num: 30000, den: 1001 })
    expect(stitchRate(probe(null))).toEqual({ num: 24, den: 1 })
  })
})

/** A kit whose fal answers each segment with its clip (served by URL), the case's pictures in its input folder. */
async function runKit(c: ViewsCase, o: { hosted?: boolean; failAt?: number; lostAt?: number; kept?: ReturnType<typeof createFileKeptBytes>; dir?: string; root?: string; hangAt?: number } = {}) {
  const urlOf = (k: number) => `https://f.test/turntable/seg${k}.mp4`
  let n = 0
  const fal = createFakeFal({ answer: ({ input }) => ({ video: { url: urlOf(Number((input as { __seg?: number }).__seg ?? 0)) } }) })
  const submit = fal.client.submit
  const byPayload = new Map<unknown, number>()
  fal.client.submit = (async (endpoint: string, payload: Record<string, unknown>, ...rest: unknown[]) => {
    n++
    if (o.failAt === n) fal.failNext(1)
    byPayload.set(payload, n)
    return (submit as (...a: unknown[]) => Promise<unknown>)(endpoint, payload, ...rest)
  }) as typeof submit
  const result = fal.client.result
  fal.client.result = (async (url: string) => {
    const id = /^fal:\/\/(req\d+)/.exec(url)![1]!
    const seg = byPayload.get(fal.reqs.get(id)!.payload)!
    await (result as (u: string) => Promise<unknown>)(url)
    return { video: { url: urlOf(seg) } }
  }) as typeof result
  const gets: string[] = []
  const download = async (url: string) => {
    gets.push(url)
    const seg = Number(/seg(\d)\.mp4$/.exec(url)![1])
    if (o.lostAt === seg) throw new Error('connection reset')
    return { bytes: b64(FIXTURE.clips[`${c.clip_set}${seg - 1}`]!.b64), contentType: 'video/mp4' }
  }
  const reportError = vi.fn()
  // `hangAt`: this server follows that segment's job no further (its polls never answer), as a server going away.
  const status = fal.client.status
  const hung = (async (url: string, ...rest: unknown[]) => {
    const id = /^fal:\/\/(req\d+)/.exec(url)![1]!
    if (byPayload.get(fal.reqs.get(id)!.payload) === o.hangAt) return new Promise<never>(() => {})
    return (status as (...a: unknown[]) => Promise<unknown>)(url, ...rest)
  }) as typeof status
  const k = makeKit({
    hosted: o.hosted, available: 50_000, fal: o.hangAt ? { ...fal, client: { ...fal.client, status: hung } } : fal, dir: o.dir, root: o.root,
    deps: { families: () => ON, download, reportError, ...(o.kept ? { kept: o.kept } : {}) },
  })
  for (const name of c.pictures ?? []) writeFileSync(join(k.root, 'input', `${name}.png`), b64(c.picture_files![name]!))
  const { runId } = await k.engine.startRun({ userId: k.userId, takes: [promptOf(c)], ...START })
  return { k, runId, fal, gets, reportError }
}

// ── Money (rules 7 and 12) ───────────────────────────────────────────────────

describe('money: the hold is every arc, the charge the arcs that finished and were delivered', () => {
  it('each arc is one Seedance 2.0 720p call, 5 s × $0.3034 (with its sound) = 228 credits; 2, 3 or 4 arcs hold 456, 684 or 912', () => {
    expect(turntableArcCall()).toEqual({ endpoint: TURNTABLE_VIEWS_MODEL, tier: '720p', outputSeconds: 5, audio: true })
    expect(paidCallUsd(turntableArcCall())).toBe(1.517)
    expect(creditsForUsd(1.517)).toBe(ARC_CREDITS)
    for (const c of STITCHED) {
      const inputs = promptOf(c).n!.inputs
      expect(paidCalls(TURNTABLE_CLASS, inputs, {})).toEqual({ steps: [{ call: turntableArcCall(), times: c.calls.length }] })
      expect((priceNode(TURNTABLE_CLASS, inputs) as { credits: number }).credits, c.name).toBe(ARC_CREDITS * c.calls.length)
      expect(priceGraph({ n: { class_type: TURNTABLE_CLASS, inputs } }).nodes!.n, c.name).toBe(ARC_CREDITS * c.calls.length)
    }
  })

  it('hosted, four arcs: held at 912 and charged 912', LONG, async () => {
    await requireMediaTools()
    const c = caseNamed('right+back+left · left')
    expect(stageEstimate(promptOf(c), ['n'], false, ON)).toBe(912)
    const { k, runId } = await runKit(c, { hosted: true })
    await k.engine.settled(runId)
    const rec = (await k.store.get(runId))!.takes[0]!.nodes.n!
    expect(rec.status, rec.error ?? '').toBe('done')
    expect(charged(k)).toEqual([[912, 912]])
  })

  it('a failure at segment 3: segments 1–2 charged (456 of 912), segment 4 never sent, no render credit', LONG, async () => {
    await requireMediaTools()
    const c = caseNamed('right+back+left · left')
    const { k, runId, fal } = await runKit(c, { hosted: true, failAt: 3 })
    await k.engine.settled(runId)
    const rec = (await k.store.get(runId))!.takes[0]!.nodes.n!
    expect(rec.status).toBe('error')
    expect(fal.submitted().length).toBe(3)
    expect(rec.calls!.map(x => [x.key, x.status])).toEqual([['seg-1', 'done'], ['seg-2', 'done'], ['seg-3', 'error']])
    expect(rec.outputs).toEqual([])
    expect(charged(k)).toEqual([[912, 456]])
  })

  it('a clip that can\'t be downloaded: its arc is not delivered, so not charged (228 of 912: segment 1 only)', LONG, async () => {
    await requireMediaTools()
    const c = caseNamed('right+back+left · left')
    const { k, runId, fal, reportError } = await runKit(c, { hosted: true, lostAt: 2 })
    await k.engine.settled(runId)
    const rec = (await k.store.get(runId))!.takes[0]!.nodes.n!
    expect(rec.status).toBe('error')
    expect(fal.submitted().length).toBe(2)
    expect(charged(k)).toEqual([[912, ARC_CREDITS]])
    expect(reportError.mock.calls.map(x => (x[1] as { site: string }).site)).toContain('runner.download.lost')
  })
})

// ── Resume (rule 12) ─────────────────────────────────────────────────────────

describe('resumed after a restart', () => {
  it('with segment 3 in flight: segments 1–2 never sent again, their clips never downloaded again; done and charged 912', LONG, async () => {
    await requireMediaTools()
    const c = caseNamed('right+back+left · left')
    const dir = mkdtempSync(join(tmpdir(), 'turntable-views-resume-'))
    const kept = createFileKeptBytes(join(dir, 'kept'))
    // The first server follows segment 3 no further (its polls never answer), as a server going away.
    const one = await runKit(c, { hosted: true, dir, kept, hangAt: 3 })
    const callOf = async (key: string) => ((await one.k.store.get(one.runId))!.takes[0]!.nodes.n!.calls ?? []).find(x => x.key === key)
    await until(() => one.fal.submitted().length === 3, 20_000)
    for (let i = 0; i < 400 && !(await callOf('seg-3'))?.request; i++) await new Promise(r => setTimeout(r, 5))
    expect((await callOf('seg-3'))?.request).toBeTruthy()
    // The second server, over the same run store, kept files and provider.
    const k2 = makeKit({
      hosted: true, available: 50_000, dir, root: one.k.root, fal: one.fal, ledger: one.k.ledger,
      deps: { families: () => ON, kept, download: async (url: string) => {
        one.gets.push(url)
        const seg = Number(/seg(\d)\.mp4$/.exec(url)![1])
        return { bytes: b64(FIXTURE.clips[`${c.clip_set}${seg - 1}`]!.b64), contentType: 'video/mp4' }
      } },
    })
    expect(await k2.engine.reattach()).toBe(1)
    await k2.engine.settled(one.runId)
    const rec = (await k2.store.get(one.runId))!.takes[0]!.nodes.n!
    expect(rec.status, rec.error ?? '').toBe('done')
    expect(one.fal.submitted().length).toBe(4)
    for (const seg of [1, 2]) expect(one.gets.filter(u => u.endsWith(`seg${seg}.mp4`)).length, `segment ${seg}`).toBe(1)
    expect(charged(one.k)).toEqual([[912, 912]])
    rmSync(dir, { recursive: true, force: true })
  })
})

// ── Refusals before the hold, and moderation ─────────────────────────────────

describe('refusals before the hold', () => {
  it('hosted: a view that isn\'t the user\'s own is refused before the hold, nothing sent', async () => {
    const c = caseNamed('back · left')
    const k = makeKit({ hosted: true, available: 50_000, deps: { families: () => ON, ownership: { ownsInput: async (_u: string, f: OutputFile) => f.filename !== 'back_reference.png', ownsOutput: async () => true } } })
    for (const name of c.pictures ?? []) writeFileSync(join(k.root, 'input', `${name}.png`), b64(c.picture_files![name]!))
    await expect(k.engine.startRun({ userId: k.userId, takes: [promptOf(c)], ...START })).rejects.toThrow('isn’t one of yours')
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
  })

  it('a hosted flagged extra direction is refused at the start, before the hold', async () => {
    const moderate = vi.fn(async (t: string) => (t.includes('forbidden') ? { ok: false as const, categories: ['violence'] } : { ok: true as const }))
    const c = caseNamed('back · left')
    const k = makeKit({ hosted: true, available: 50_000, moderate, deps: { families: () => ON } })
    for (const name of c.pictures ?? []) writeFileSync(join(k.root, 'input', `${name}.png`), b64(c.picture_files![name]!))
    const p = promptOf({ ...c, widgets: { ...c.widgets, instructions: 'a forbidden thing' } })
    await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START })).rejects.toThrow()
    expect(moderate.mock.calls.map(x => x[0])).toContain('a forbidden thing')
    expect(k.ledger.hold).not.toHaveBeenCalled()
  })
})

// ── Which families take it ───────────────────────────────────────────────────

describe('who takes a Turntable with views', () => {
  const views = () => promptOf(caseNamed('right+back+left · left'))
  const front = (): ApiPrompt => ({
    n: { class_type: TURNTABLE_CLASS, inputs: { direction: 'left', instructions: '', image: ['p_image', 0] } },
    p_image: { class_type: 'LoadImage', inputs: { image: 'image.png', upload: 'image' } },
  })
  const titleOf = (id: string) => id

  it('the runner, with turntable and media-video on (the stitch is Sailor\'s own video tools)', () => {
    expect(runnerTakesNode(views(), 'n', ON)).toBe(true)
    expect(isRunnerEligible(views(), ON)).toBe(true)
    expect(nodesNeedingEngine(views(), { runnerOn: true, families: ON, titleOf })).toEqual([])
  })

  it('the engine, with media-video off (switched off, or the video tools missing): switching turntable on never makes it fail', () => {
    const without = new Set<RunnerFamily>(['cards', 'turntable'])
    expect(runnerTakesNode(views(), 'n', without)).toBe(false)
    expect(nodesNeedingEngine(views(), { runnerOn: true, families: without, titleOf })).toEqual(['n'])
    // The front-only spin needs no video tools: taken either way.
    expect(runnerTakesNode(front(), 'n', without)).toBe(true)
    expect(runnerTakesNode(front(), 'n', ON)).toBe(true)
  })

  it('the engine, with turntable off (media-video on or off)', () => {
    for (const fam of [['cards', 'media-video'], ['cards'], [...RUNNER_FAMILIES.filter(f => f !== 'turntable'), 'media-video']] as RunnerFamily[][]) {
      expect(runnerTakesNode(views(), 'n', new Set(fam)), fam.join(',')).toBe(false)
    }
  })

  it('the engine, when a view is not a picture (a video wired in), or the front is missing', () => {
    const p = views()
    const withVideo: ApiPrompt = { ...p, v: { class_type: 'GenerateVideoNode', inputs: { model: 'seedance-2.0', prompt: 'x', aspect_ratio: '1:1', duration: '5', seed: 0, model_options: '{}' } }, n: { ...p.n!, inputs: { ...p.n!.inputs, back_reference: ['v', 0] } } }
    expect(runnerTakesNode(withVideo, 'n', ON)).toBe(false)
    const noFront: ApiPrompt = { ...p, n: { ...p.n!, inputs: { ...p.n!.inputs, image: undefined as never } } }
    delete noFront.n!.inputs.image
    expect(runnerTakesNode(noFront, 'n', ON)).toBe(false)
  })

  it('with turntable off, a Turntable answers exactly as before R3.17 whatever media-video is (rule 15)', () => {
    const before = (p: ApiPrompt): ApiPrompt => Object.fromEntries(Object.entries(p).map(([id, n]) => [id, n.class_type === TURNTABLE_CLASS ? { ...n, class_type: `${n.class_type}Before` } : n]))
    for (const fam of [['media-video'], ['cards', 'media-video'], [...RUNNER_FAMILIES.filter(f => f !== 'turntable'), 'media-video']] as RunnerFamily[][]) {
      const families = new Set(fam)
      for (const p of [views(), front(), { ...views(), c: { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'video/ComfyUI', source: ['n', 0] } } } as ApiPrompt]) {
        expect(nodesNeedingEngine(p, { runnerOn: true, families, titleOf }), fam.join(',')).toEqual(nodesNeedingEngine(before(p), { runnerOn: true, families, titleOf }))
        expect(isRunnerEligible(p, families)).toBe(isRunnerEligible(before(p), families))
        for (const id of Object.keys(p)) {
          expect(runnerTakesNode(p, id, families), id).toBe(runnerTakesNode(before(p), id, families))
          if (p[id]!.class_type !== TURNTABLE_CLASS) expect(valueWiresAllowed(p, id, outputKindsFor(families))).toBe(valueWiresAllowed(before(p), id, outputKindsFor(families)))
        }
      }
    }
  })
})
