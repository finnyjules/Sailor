/**
 * R3.15: Lens · 3D Reframe and Pose Mannequin (family `nano-extras`) — Nano
 * Banana 2 on Replicate at 1K, fal's Nano Banana 2 edit the backup — against
 * what their real Python sends and returns (fixtures/runner-paid-nano-extras.json,
 * scripts/runner_paid_fixtures.py --group nano-extras): every lens pair,
 * Custom at focal 10 and 300, the strengths; every branch of Pose Mannequin's
 * execute, the baked files (EXIF 6, RGBA, missing), the conditioning render
 * Python raises on. Priced as the nano actions' call (14 credits) on both
 * paths, and nothing for a branch that makes no call (ruling (p)).
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { createFakeFal, createFakeReplicate, makeKit, ofType } from './__runner__/kit'
import { normalizeSent, wireText, type PaidCase } from './__runner__/paidParity'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import type { ApiPrompt } from '#shared/runner/graph'
import { RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { IMAGE_OUTPUT_CLASSES, PAID_PICTURE_FAMILY, PROVIDER_TYPES, RUNNER_NODE_RULES, isRunnerEligible, outputKindsFor, runnerTakesNode, valueWiresAllowed } from '#shared/runner/eligibility'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { RUNNER_OUTPUT_CLASSES } from '#shared/runner/validate'
import {
  LENS_CUSTOM, LENS_NAMES, NANO_EXTRAS_CLASSES, NANO_EXTRAS_SLUG, POSE_RESULT_MISSING, bakedNamePresent, poseNoCall, savedPoseRefs,
} from '#shared/runner/nanoExtras'
import { EDIT_RATES } from '#shared/pricing/editRates'
import { SETTING_PRICED_NODE_CLASSES, editCalls } from '#shared/pricing/editSettings'
import { PAID_NODE_CLASSES, paidNoCall } from '#shared/pricing/paidSettings'
import { priceNode } from '#shared/pricing/nodePrice'
import { creditsForUsd } from '#shared/pricing/markup'
import { BASE_RENDER_CREDITS, GRAPH_NODE_CREDITS, PRICE_BOOK_VERSION, priceGraph } from '~~/server/utils/priceBook'
import { PAID_TEXT_INPUTS, extraPromptTexts, nodeCredits, stageEstimate, unpricedProviderNode } from '~~/server/runner/metering'
import { planNode, type Derived, type DeriveIO, type NodePlan, type PlanContext } from '~~/server/runner/executors'
import {
  DEFAULT_POSE, IMAGE_PROMPT, LENSES, MANNEQUIN_PROMPT, TEXT_PROMPT, focalFor, lensIntensity, poseBakedRefusal, poseInstruction, posePlanBranch, reframeInstruction,
} from '~~/server/runner/generators/nanoExtras'
import { NANO_BANANA_2_REPLICATE, RUNNER_ROUTES, nanoBananaOnFal } from '~~/server/runner/generators/twins'
import { collectInputFiles } from '~~/server/runner/inputs'
import { DEFAULT_BACKUP_STALL_MS } from '~~/server/runner/config'
import { ReplicateError } from '~~/server/runner/replicateQueue'
import { PICTURE_CMYK } from '~~/server/runner/pictures/pythonView'
import type { OutputFile } from '~~/server/runner/types'
import { createMemoryKeptBytes } from '~~/server/runner/keptBytes'

interface Catalogue {
  lenses: { name: string; focal_mm: number; look: string }[]
  names: string[]
  custom: string
  intensity: { strength: number; out: string }[]
  focal_for: { name: string; custom: number; out: number }[]
  pose_prompts: { mannequin: string; image: string; text: string; default_pose: string }
  pose_instruction: { source: string; extra: string; pose: string; out: string }[]
}
type Pixels = { shape: number[]; sha256: string }
/** The runner's deliberate deviation (R3.15 fix round 1): the conditioning render makes the call Python's `or` never reaches. */
interface RunnerDeviation { calls: PaidCase['calls']; error: PaidCase['error'] | null; output: unknown; ui: unknown; made: Record<string, Pixels>; reason: string }
type NanoCase = PaidCase & { made?: Record<string, Pixels>; loaded?: Record<string, Pixels>; input_files?: Record<string, string>; runner?: RunnerDeviation }
/** What the runner is held to: Python's case, or its deviation where the fixture records one. */
const heldTo = (c: NanoCase) => (c.runner ? { calls: c.runner.calls, made: c.runner.made, ui: c.runner.ui, output: c.runner.output } : { calls: c.calls, made: c.made ?? {}, ui: c.ui, output: c.output })
const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'runner-paid-nano-extras.json'), 'utf8')) as { cases: NanoCase[]; baked: Record<string, string>; catalogue: Catalogue }
const CASES = FIXTURE.cases
const CAT = FIXTURE.catalogue
const BAKED = Object.fromEntries(Object.entries(FIXTURE.baked).map(([n, b]) => [n, new Uint8Array(Buffer.from(b, 'base64'))]))
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const ON: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'nano-extras'])
const OUT = 'https://r.test/nano/out.png'

const caseNamed = (name: string): NanoCase => {
  const c = CASES.find(x => x.name === name)
  if (!c) throw new Error(`no fixture case ${name}`)
  return c
}
const isPose = (c: PaidCase) => c.class_type === 'PoseMannequin'

/** A LoadImage feeding each picture input (both classes are output nodes: no card needed). */
function withPictures(c: PaidCase, id = 'n'): ApiPrompt {
  const p: ApiPrompt = { [id]: { class_type: c.class_type, inputs: { ...c.widgets } } }
  for (const name of c.pictures ?? []) {
    p[`p_${name}`] = { class_type: 'LoadImage', inputs: { image: `${name}.png`, upload: 'image' } }
    p[id]!.inputs[name] = [`p_${name}`, 0]
  }
  return p
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
/** A PNG's pixels as Python describes an 8-bit array: its shape and the sha256 of its bytes. */
async function pixelsOf(png: Uint8Array, batch = false): Promise<Pixels> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true })
  return { shape: [...(batch ? [1] : []), info.height, info.width, info.channels], sha256: sha(new Uint8Array(data)) }
}

/** A file of the fixture's input folder, as the runner names it (subfolder and file name), or null (not there). */
const fileAt = (f: Pick<OutputFile, 'filename' | 'subfolder'>): Uint8Array | null => BAKED[f.subfolder ? `${f.subfolder}/${f.filename}` : f.filename] ?? null
/** The Python cases' baked files by a hand-off link's file name (top-level or in a subfolder), or null. */
const inputFile = (name: string): Uint8Array | null => BAKED[name] ?? Object.entries(BAKED).find(([k]) => k.endsWith(`/${name}`))?.[1] ?? null

/** planNode as the engine calls it, over the fixture's files; `made`: the bytes handed off by name. */
async function planOf(c: NanoCase, o: { hosted?: boolean; priceInputs?: Record<string, unknown> } = {}) {
  const made = new Map<string, Uint8Array>()
  const prompt = withPictures(c)
  const ctx: PlanContext = {
    prompt, nodeId: 'n', gateOpen: false,
    filesFrom: link => (String(link[0]).startsWith('p_') ? [{ filename: `${String(link[0]).slice(2)}.png`, subfolder: '', type: 'input' }] : []),
    toUrl: async f => `https://fal.storage/${f.filename}`,
    bytesToUrl: async (f, b) => { made.set(f.filename, b); return `https://made/${f.filename}` },
    readFile: async (f) => {
      const b = fileAt(f)
      if (!b) throw new Error('ENOENT')
      return b
    },
    ...(o.hosted ? { hosted: true } : {}),
    ...(o.priceInputs ? { priceInputs: o.priceInputs } : {}),
  }
  return { plan: await planNode(ctx), made }
}

/** A derive plan run with a fake io: what it keeps and shows. */
async function deriveOf(plan: Extract<NodePlan, { kind: 'derive' }>): Promise<{ made: Derived; kept: Map<string, Uint8Array>; shown: Uint8Array[] }> {
  const kept = new Map<string, Uint8Array>()
  const shown: Uint8Array[] = []
  const io = {
    read: async (f: OutputFile) => fileAt(f) ?? (() => { throw new Error('ENOENT') })(),
    keep: async (b: Uint8Array) => { const k = sha(b); kept.set(k, b); return { filename: k, subfolder: 'run', type: 'kept' as const } },
    savePreview: async (b: Uint8Array) => { shown.push(b); return { filename: `live_preview_n_${shown.length}.png`, subfolder: '', type: 'temp' as const } },
    nodeId: 'n', hosted: false, signal: new AbortController().signal,
  } as unknown as DeriveIO
  return { made: await plan.derive(io), kept, shown }
}

/** Python's `IMG:<input>`, and a made picture as its file name (the test compares its pixels). */
const asPython = (c: PaidCase, payload: Record<string, unknown>) => normalizeSent([{ provider: 'replicate', endpoint: '', payload }], c.pictures ?? [])[0]!.payload

async function png(w: number, h: number): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer()
}

const NB2 = loadProviderSchema('replicate', NANO_EXTRAS_SLUG)
const FAL_NB2_EDIT = loadProviderSchema('fal', 'fal-ai/nano-banana-2/edit')

describe('the fixture', () => {
  it('covers every lens pair, Custom at 10 and 300, the strengths, and every Pose branch', () => {
    const names = new Set(CASES.map(c => c.name))
    expect(new Set(CASES.map(c => c.class_type))).toEqual(new Set(NANO_EXTRAS_CLASSES))
    for (const s of LENS_NAMES) for (const t of LENS_NAMES) expect(names.has(`lens · ${s} → ${t}`), `${s} → ${t}`).toBe(true)
    for (const f of ['10', '300']) {
      for (const o of LENS_NAMES) {
        expect(names.has(`lens · Custom ${f} → ${o}`)).toBe(true)
        expect(names.has(`lens · ${o} → Custom ${f}`)).toBe(true)
      }
    }
    for (const s of ['0.0', '1.0', '1.5']) expect(names.has(`lens · strength ${s}`), s).toBe(true)
    // Every Pose branch: a call from each mode, a saved pose (EXIF 6 as PNG and JPEG), the character passed through, a missing file, Python's raise.
    const pose = CASES.filter(isPose)
    const byImages = (n: number) => pose.filter(c => c.calls.length && (c.calls[0]!.payload.image_input as string[]).length === n)
    expect(byImages(2).some(c => (c.calls[0]!.payload.image_input as string[])[1] === 'IMG:pose_image')).toBe(true)
    expect(byImages(2).some(c => (c.calls[0]!.payload.image_input as string[])[1]!.startsWith('PNG:'))).toBe(true)
    expect(byImages(1).length).toBeGreaterThan(5)
    for (const f of ['pose_result_exif6.png', 'pose_result_exif6.jpg']) expect(names.has(`pose · mannequin · baked result ${f}`), f).toBe(true)
    expect(pose.filter(c => (c.output as { tensor?: unknown }[] | null)?.[0]?.tensor).length).toBeGreaterThanOrEqual(6)
    expect(pose.filter(c => JSON.stringify(c.output) === '[{"image":"IMG:character"}]').length).toBeGreaterThanOrEqual(8)
    // Python raises on every loading conditioning render (the runner's deviation, fix round 1).
    expect(pose.filter(c => c.error).map(c => c.name).sort()).toEqual(CASES.filter(c => c.runner).map(c => c.name).sort())
    expect(pose.filter(c => c.error).length).toBe(5)
    for (const t of ['blank', 'spaces', 'unicode blanks']) expect(names.has(`pose · prompt · pose prompt ${t}`)).toBe(true)
    expect(names.has('pose · mannequin · missing result, the mannequin render')).toBe(true)
    // One call at most, always Nano Banana 2 on Replicate.
    expect(CASES.every(c => c.calls.length <= 1)).toBe(true)
    expect(new Set(CASES.flatMap(c => c.calls.map(x => `${x.provider} ${x.endpoint}`)))).toEqual(new Set([`replicate ${NANO_EXTRAS_SLUG}`]))
    expect(CASES.length).toBeGreaterThanOrEqual(160)
  })
})

describe('the catalogue: _lenses.py and _pose_prompts.py, ported line for line', () => {
  it('the lenses, in order, every field; the node\'s options', () => {
    expect(LENSES).toEqual(CAT.lenses)
    expect([...LENS_NAMES]).toEqual(CAT.names)
    expect(LENS_CUSTOM).toBe(CAT.custom)
  })
  it('_intensity at its band edges, focal_for', () => {
    for (const x of CAT.intensity) expect(lensIntensity(x.strength), String(x.strength)).toBe(x.out)
    for (const x of CAT.focal_for) expect(focalFor(x.name, x.custom), `${x.name} ${x.custom}`).toBe(x.out)
  })
  it('the three pose prompts and pose_instruction, byte for byte', () => {
    expect([MANNEQUIN_PROMPT, IMAGE_PROMPT, TEXT_PROMPT, DEFAULT_POSE]).toEqual([CAT.pose_prompts.mannequin, CAT.pose_prompts.image, CAT.pose_prompts.text, CAT.pose_prompts.default_pose])
    expect(CAT.pose_instruction.length).toBeGreaterThan(40)
    for (const x of CAT.pose_instruction) expect(poseInstruction(x.source, x.extra, x.pose), `${x.source} ${JSON.stringify(x.extra)} ${JSON.stringify(x.pose)}`).toBe(x.out)
  })
})

/** The cases that make no call although priced as one: a named render that isn't there. */
const PRICED_AS_CALL_NO_CALL = [
  'pose · mannequin · missing mannequin render (passes the character)',
]
/** A saved pose named but gone, the call Python falls to: priced as a call (fix round 1), refused in hosted. */
const SAVED_POSE_GONE_CALLS = [
  'pose · mannequin · missing result, the mannequin render',
  'pose · mannequin · missing result, the conditioning render',
]
/** Whether Python loaded the case's saved pose (it is the output): what a caller that read the file knows. */
const savedPoseLoaded = (c: NanoCase) => !!(heldTo(c).output as { tensor?: unknown }[] | null)?.[0]?.tensor

describe('every fixture case: what Python sends and returns', () => {
  const offSchema: string[] = []

  it.each(CASES.map(c => [c.name, c] as const))('%s', async (_n, c) => {
    const inputs = withPictures(c).n!.inputs
    const held = heldTo(c)
    // Python raises only where the runner deviates (the conditioning render), and the deviation calls.
    if (c.error) {
      expect(c.error.message).toMatch(/Boolean value of Tensor/)
      expect(c.runner?.error ?? null).toBeNull()
      expect(c.runner!.calls.length).toBe(1)
    }
    else expect(c.runner).toBeUndefined()
    // What the price says (paidNoCall, rule 8) matches the branch, given what reading the saved pose found.
    const free = paidNoCall(c.class_type, inputs, { savedPoseLoads: savedPoseLoaded(c) })
    if (PRICED_AS_CALL_NO_CALL.includes(c.name)) expect(free).toBe(false)
    else expect(free, 'paidNoCall').toBe(!held.calls.length)
    // Not read, a named saved pose is never free where a render would make the call Python falls to (fix round 1).
    if (isPose(c) && savedPoseRefs(withPictures(c))['n'] && (bakedNamePresent(inputs.pose_cond_image) || bakedNamePresent(inputs.mannequin_image))) {
      expect(paidNoCall(c.class_type, inputs), 'unread saved pose').toBe(false)
    }
    const { plan, made } = await planOf(c)
    if (held.calls.length) {
      if (plan.kind !== 'provider') throw new Error(`${c.name}: planned ${plan.kind}`)
      expect(plan.provider).toBe('replicate')
      expect(plan.endpoint).toBe(NANO_EXTRAS_SLUG)
      expect(plan.media).toBe('image')
      expect(plan.take).toBe('first')
      const py = held.calls[0]!
      // A mannequin render goes as `_load_input_image`'s RGB PNG: the same pixels as Python's PNG:<sha>.
      const payload = asPython(c, plan.payload)
      const images = payload.image_input as string[]
      const pyImages = py.payload.image_input as string[]
      for (const [i, u] of images.entries()) {
        // Made here (turned, alpha dropped), or the saved file itself when it already is that PNG.
        const bytes = u.startsWith('https://made/') ? made.get(u.slice('https://made/'.length))!
          : u.startsWith('https://fal.storage/pose_') ? inputFile(u.slice('https://fal.storage/'.length))! : null
        if (!bytes) continue
        expect(await pixelsOf(bytes), `${c.name} picture ${i}`).toEqual(held.made[pyImages[i]!])
        images[i] = pyImages[i]!
      }
      expect(payload).toEqual(py.payload)
      expect(wireText(payload)).toBe(py.payload_json)
      const errs = checkPayload(NB2, plan.payload)
      if (errs.length) offSchema.push(`${c.name}: ${errs.join('; ')}`)
      // The backup: fal's Nano Banana 2 edit, the same prompt and pictures (nanoBananaOnFal), within its schema.
      expect(plan.backup).toEqual(nanoBananaOnFal(NANO_BANANA_2_REPLICATE, plan.payload))
      expect(plan.backup!.payload.prompt).toBe(plan.payload.prompt)
      expect(plan.backup!.payload.image_urls).toEqual(plan.payload.image_input)
      expect(checkPayload(FAL_NB2_EDIT, plan.backup!.payload)).toEqual([])
      // Python's ui: save_generation_output(result, "reframe" | "pose").
      const prefix = c.class_type === 'LensReframe' ? 'reframe' : 'pose'
      expect((held.ui as { images: { prefix: string }[] }).images[0]!.prefix).toBe(prefix)
      expect(plan.prefix).toBe(prefix)
      const files = [{ filename: 'x.png', subfolder: '', type: 'output' as const }]
      expect(plan.uiFor(files)).toEqual({ images: files, animated: [false] })
      return
    }
    // No call. A saved pose: `_load_input_image`'s tensor, shown as a unique live preview.
    const out = (c.output as { tensor?: Pixels; image?: string }[])[0]!
    if (out.tensor) {
      if (plan.kind !== 'derive') throw new Error(`${c.name}: planned ${plan.kind}`)
      const { made: d, kept, shown } = await deriveOf(plan)
      const v = d.values[0]!
      if (v.kind !== 'files') throw new Error('not files')
      const bytes = v.files[0]!.type === 'kept' ? kept.get(v.files[0]!.filename)! : fileAt(v.files[0]!)!
      expect(await pixelsOf(bytes, true)).toEqual(out.tensor)
      expect(shown.length).toBe(1)
      expect(await pixelsOf(shown[0]!, true)).toEqual(out.tensor)
      expect(d.ui).toEqual({ images: [{ filename: 'live_preview_n_1.png', subfolder: '', type: 'temp' }] })
      return
    }
    // The character, passed through as it came (no loader walk here: families not given).
    expect(out.image).toBe('IMG:character')
    expect(plan).toEqual({ kind: 'pass', files: [{ filename: 'character.png', subfolder: '', type: 'input' }], ui: { images: [{ filename: 'character.png', subfolder: '', type: 'input' }] } })
  })

  it('every payload fits Nano Banana 2\'s saved schema', () => {
    expect(offSchema).toEqual([])
  })
})

describe('Pose Mannequin\'s branch, as execute takes it', () => {
  const at = (inputs: Record<string, unknown>, loads: string[] = []) => posePlanBranch(inputs, async n => loads.includes(n))
  const L = ['p', 0]
  it('files are asked for lazily, in Python\'s order', async () => {
    const asked: string[] = []
    await posePlanBranch({ character: L, result_image: 'a.png', pose_cond_image: 'b.png', mannequin_image: 'c.png' }, async (n) => { asked.push(n); return n === 'result_image' })
    expect(asked).toEqual(['result_image'])
    asked.length = 0
    await posePlanBranch({ character: L, pose_source: 'image', pose_image: L, result_image: 'a.png' }, async (n) => { asked.push(n); return true })
    expect(asked).toEqual([])
  })
  it('each branch', async () => {
    expect((await at({ character: L, pose_source: 'image', pose_image: L })).kind).toBe('call')
    expect((await at({ character: L, pose_source: 'image' })).kind).toBe('pass')
    expect((await at({ character: L, pose_source: 'prompt', pose_prompt: ' x ' })).kind).toBe('call')
    expect((await at({ character: L, pose_source: 'prompt', pose_prompt: '　' })).kind).toBe('pass')
    expect((await at({ character: L }, ['result_image'])).kind).toBe('baked')
    // RUNNER DEVIATION (fix round 1): the conditioning render calls (Python raises); else the mannequin render.
    expect(await at({ character: L }, ['pose_cond_image', 'mannequin_image'])).toMatchObject({ kind: 'call', pictures: ['character', 'pose_cond_image'] })
    expect(await at({ character: L }, ['pose_cond_image'])).toMatchObject({ kind: 'call', pictures: ['character', 'pose_cond_image'] })
    expect(await at({ character: L }, ['mannequin_image'])).toMatchObject({ kind: 'call', pictures: ['character', 'mannequin_image'] })
    expect((await at({ character: L })).kind).toBe('pass')
    // No character (the engine's blank): a saved pose still wins; nothing else calls.
    expect((await at({}, ['result_image'])).kind).toBe('baked')
    expect((await at({}, ['mannequin_image'])).kind).toBe('pass')
  })
})

// ── Through the engine (cards and nano-extras on) ────────────────────────────

/** A kit with every baked file in its input folder and each picture input a LoadImage of `<name>.png`. */
async function kitFor(c: NanoCase, o: { hosted?: boolean; families?: ReadonlySet<RunnerFamily>; backup?: boolean; moderate?: NonNullable<Parameters<typeof makeKit>[0]>['moderate']; fal?: ReturnType<typeof createFakeFal> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'nano-extras-root-'))
  mkdirSync(join(root, 'input'), { recursive: true })
  for (const [n, b] of Object.entries(BAKED)) {
    mkdirSync(dirname(join(root, 'input', n)), { recursive: true })
    writeFileSync(join(root, 'input', n), b)
  }
  for (const name of c.pictures ?? []) writeFileSync(join(root, 'input', `${name}.png`), new Uint8Array(Buffer.from(c.picture_files![name]!, 'base64')))
  const answer = c.answers[0] as { output: unknown } | undefined
  const replicate = createFakeReplicate({ bodyText: () => JSON.stringify({ id: 'p', status: 'succeeded', output: answer?.output ?? [OUT] }) })
  const download = async (url: string) => {
    const b64 = c.files?.[url]
    if (!b64) throw new Error(`GET ${url} is not served by the case`)
    return { bytes: new Uint8Array(Buffer.from(b64, 'base64')), contentType: 'image/png' }
  }
  const kept = createMemoryKeptBytes()
  const k = makeKit({
    root, hosted: o.hosted, replicate, moderate: o.moderate, ...(o.fal ? { fal: o.fal } : {}),
    deps: { download, kept, families: () => o.families ?? ON, ...(o.backup ? { backup: () => ({ enabled: true, stallMs: DEFAULT_BACKUP_STALL_MS }) } : {}) },
  })
  return { ...k, kept }
}

async function run(c: NanoCase, o: Parameters<typeof kitFor>[1] = {}, prompt = withPictures(c)) {
  const k = await kitFor(c, o)
  const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })
  await k.engine.settled(runId)
  const rec = (await k.store.get(runId))!.takes[0]!.nodes.n!
  return { k, rec, runId }
}

describe('every fixture case through the engine (cards and nano-extras on)', () => {
  // A pose source ComfyUI's validation refuses (not one of the options) never runs on either path.
  const taken = CASES.filter(c => runnerTakesNode(withPictures(c), 'n', ON))
  it('the runner takes every case but an unknown pose source', () => {
    expect(CASES.filter(c => !taken.includes(c)).map(c => c.name).sort()).toEqual(['pose · unknown source · baked result', 'pose · unknown source · reads as mannequin'])
  })

  it.each(taken.map(c => [c.name, c] as const))('%s', async (_n, c) => {
    const held = heldTo(c)
    const { k, rec } = await run(c)
    expect(rec.status, rec.error ?? '').toBe('done')
    const sent = [...k.replicate.reqs.values()]
    expect(sent.length).toBe(held.calls.length)
    if (held.calls.length) {
      const pyImages = held.calls[0]!.payload.image_input as string[]
      const payload = asPython(c, sent[0]!.payload)
      const images = payload.image_input as string[]
      for (const [i, u] of images.entries()) {
        if (!u.startsWith('https://fal.storage/pose_')) continue
        const call = k.upload.mock.calls.find(x => `https://fal.storage/${x[1]}` === u)!
        expect(await pixelsOf(call[0] as Uint8Array)).toEqual(held.made[pyImages[i]!])
        images[i] = pyImages[i]!
      }
      expect(payload).toEqual(held.calls[0]!.payload)
      expect(rec.outputs.length).toBe(1)
      expect(rec.outputs[0]!.filename).toMatch(c.class_type === 'LensReframe' ? /^reframe/ : /^pose/)
      // Every call is priced as one (a saved pose gone included, fix round 1: locally Python's fallback runs).
      expect(rec.credits).toBe(14)
      const price = priceNode(c.class_type, withPictures(c).n!.inputs)
      if ('refused' in price) throw new Error(price.refused)
      expect(rec.credits).toBe(price.credits)
      return
    }
    // No call: nothing charged; the saved pose's pixels, or the character's own file (a plain RGB PNG: the loader's view).
    expect(rec.credits).toBe(0)
    const out = (held.output as { tensor?: Pixels; image?: string }[])[0]!
    const file = rec.outputs[0]!
    if (out.tensor) {
      const bytes = file.type === 'kept' ? await k.kept.read(file) : new Uint8Array(readFileSync(join(k.root, 'input', file.filename)))
      expect(await pixelsOf(bytes, true)).toEqual(out.tensor)
    }
    else expect(file.filename).toBe('character.png')
  })
})

// ── Prices (ruling (a)) and no-call branches (ruling (p)) ────────────────────

describe('prices', () => {
  const call = withPictures(caseNamed('pose · image · with a pose picture')).n!.inputs
  const baked = withPictures(caseNamed('pose · mannequin · baked result pose_result.png')).n!.inputs
  const lens = withPictures(caseNamed('lens · Normal 50mm Planar → Portrait 85mm GM')).n!.inputs

  it('the nano actions\' call: Replicate\'s Nano Banana 2 at 1K ($0.067, verified), fal\'s edit covered at cost', () => {
    expect(EDIT_RATES[NANO_EXTRAS_SLUG]).toMatchObject({ confidence: 'verified' })
    for (const ct of NANO_EXTRAS_CLASSES) {
      expect(SETTING_PRICED_NODE_CLASSES).toContain(ct)
      expect(PAID_NODE_CLASSES).not.toContain(ct)
      expect(Object.prototype.hasOwnProperty.call(GRAPH_NODE_CREDITS, ct), ct).toBe(false)
      expect(editCalls(ct, {})).toEqual(editCalls('RemoveObjectNode', {}))
    }
    expect(creditsForUsd(0.067)).toBe(14)
    expect(PRICE_BOOK_VERSION).toBe('r3-sound-in')
  })

  it('14 credits for a call on both paths and the badge; nothing for a branch that makes none (was a flat 10)', async () => {
    const { nodeCreditEstimate } = await import('~/lib/nodeCreditEstimate')
    for (const [ct, inputs] of [['LensReframe', lens], ['PoseMannequin', call]] as const) {
      expect(priceNode(ct, inputs), ct).toEqual({ usd: 0.067, credits: 14 })
      expect(priceGraph({ 1: { class_type: ct, inputs } }).nodes!['1'], ct).toBe(14)
      expect(priceGraph({ 1: { class_type: ct, inputs } }, { families: ON }).nodes!['1'], ct).toBe(14)
      expect(nodeCreditEstimate(ct, inputs), ct).toBe(14 + BASE_RENDER_CREDITS)
    }
    // A saved pose: nothing on either path once read and found loading (the hosted ComfyUI gate's
    // `savedPoses`, the runner's start of the take); named but not read (or gone, or unreadable), the
    // call Python falls to: 14 (fix round 1, never free).
    expect(paidNoCall('PoseMannequin', baked, { savedPoseLoads: true })).toBe(true)
    expect(paidNoCall('PoseMannequin', baked)).toBe(false)
    expect(priceGraph({ 1: { class_type: 'PoseMannequin', inputs: baked } }, { savedPoses: { 1: true } }).nodes!['1']).toBe(0)
    expect(priceGraph({ 1: { class_type: 'PoseMannequin', inputs: baked } }, { savedPoses: { 1: false } }).nodes!['1']).toBe(14)
    expect(priceGraph({ 1: { class_type: 'PoseMannequin', inputs: baked } }, { savedPoses: { 2: true } }).nodes!['1']).toBe(14)
    expect(priceGraph({ 1: { class_type: 'PoseMannequin', inputs: baked } }).nodes!['1']).toBe(14)
    expect(nodeCredits({ class_type: 'PoseMannequin', inputs: baked }, undefined, ON)).toBe(14)
    expect(stageEstimate({ n: { class_type: 'PoseMannequin', inputs: baked } }, ['n'], true, ON, { n: { seconds: {}, savedPose: true } })).toBe(0)
    expect(stageEstimate({ n: { class_type: 'PoseMannequin', inputs: baked } }, ['n'], false, ON)).toBe(14)
    // Nothing named at all: free without reading anything.
    const nothing = withPictures(caseNamed('pose · mannequin · nothing to pose with (passes the character)')).n!.inputs
    expect(priceGraph({ 1: { class_type: 'PoseMannequin', inputs: nothing } }).nodes!['1']).toBe(0)
    // The price is the ceiling a call makes: the badge shows it (a bare badge can't see which branch runs).
    expect(priceNode('PoseMannequin', baked)).toEqual({ usd: 0.067, credits: 14 })
  })

  it('every no-call rule, from the inputs as sent; a wired decider is priced as a call', () => {
    const L = ['x', 0]
    const free = (i: Record<string, unknown>) => poseNoCall({ character: L, ...i })
    expect(poseNoCall({})).toBe(true)
    expect(free({ pose_source: 'image' })).toBe(true)
    expect(free({ pose_source: 'image', pose_image: L })).toBe(false)
    expect(free({ pose_source: 'prompt', pose_prompt: '  ' })).toBe(true)
    expect(free({ pose_source: 'prompt', pose_prompt: 'a' })).toBe(false)
    expect(free({ pose_source: 'prompt', pose_prompt: L })).toBe(false)
    // A saved pose: free only once read and loading; not read, the renders decide.
    expect(poseNoCall({ character: L, result_image: 'a.png' }, { savedPoseLoads: true })).toBe(true)
    expect(poseNoCall({ character: L, result_image: 'a.png [input]', mannequin_image: 'b.png' }, { savedPoseLoads: true })).toBe(true)
    expect(free({ result_image: 'a.png', mannequin_image: 'b.png' })).toBe(false)
    expect(poseNoCall({ character: L, result_image: 'a.png', mannequin_image: 'b.png' }, { savedPoseLoads: false })).toBe(false)
    expect(free({ result_image: 'a.png' })).toBe(true)
    expect(free({ result_image: '   ', mannequin_image: 'b.png' })).toBe(false)
    expect(free({ result_image: '../a.png', mannequin_image: 'b.png' })).toBe(false)
    expect(free({ pose_cond_image: 'c.png' })).toBe(false)
    expect(free({})).toBe(true)
    expect(free({ pose_source: L })).toBe(false)
    expect(free({ result_image: L })).toBe(false)
    // The LLM text nodes' blank typed text is free on the ComfyUI path too (R3.3's rule 8).
    expect(priceGraph({ 1: { class_type: 'SummarizeTextNode', inputs: { text: '  ', length: 'Short', model: 'Gemini 3 Flash' } } }).nodes!['1']).toBe(0)
    expect(priceGraph({ 1: { class_type: 'SummarizeTextNode', inputs: { text: 'hi', length: 'Short', model: 'Gemini 3 Flash' } } }).nodes!['1']).toBeGreaterThan(0)
  })

  it('a no-call node is not "unpriced": hosted doesn\'t refuse it', () => {
    const p: ApiPrompt = { n: { class_type: 'PoseMannequin', inputs: baked } }
    expect(PROVIDER_TYPES.has('PoseMannequin')).toBe(true)
    const nothing = withPictures(caseNamed('pose · mannequin · nothing to pose with (passes the character)')).n!.inputs
    expect(unpricedProviderNode({ n: { class_type: 'PoseMannequin', inputs: nothing } }, undefined, n => nodeCredits(n, undefined, ON))).toBeNull()
    // A named saved pose is priced as a call until read (14): not unpriced either.
    expect(unpricedProviderNode(p, undefined, n => nodeCredits(n, undefined, ON))).toBeNull()
    // A provider priced at 0 for any other reason still is.
    expect(unpricedProviderNode({ n: { class_type: 'PoseMannequin', inputs: call } }, undefined, () => 0)).toBe('n')
  })

  it('hosted: a call is held at its price and charged the same; a saved pose holds and charges nothing', async () => {
    // The stage's hold is the ComfyUI path's graph price (no render credit: neither class is one of the price
    // book's output classes, on either path).
    for (const name of ['pose · prompt · pose prompt padded', 'lens · Wide 24mm Art → Long 200mm']) {
      const c = caseNamed(name)
      const want = priceGraph(withPictures(c)).credits
      expect(want, name).toBe(14)
      const one = await run(c, { hosted: true })
      expect(one.rec.status, one.rec.error ?? '').toBe('done')
      expect([...one.k.ledger.holds.values()].map(h => [h.credits, h.actual]), name).toEqual([[want, want]])
    }
    for (const name of ['pose · mannequin · baked result pose_result_exif6.jpg', 'pose · image · no pose picture (passes the character)', 'pose · prompt · pose prompt spaces']) {
      const free = await run(caseNamed(name), { hosted: true })
      expect(free.rec.status, free.rec.error ?? '').toBe('done')
      expect(free.k.ledger.hold).not.toHaveBeenCalled()
      expect(free.k.replicate.client.submit).not.toHaveBeenCalled()
      expect(free.rec.credits).toBe(0)
    }
  })

  it('a wired pose prompt is held as a call; blank at the node\'s turn, the hold is let go and nothing is charged', async () => {
    const c = caseNamed('pose · prompt · pose prompt padded')
    for (const [text, calls] of [['   ', 0], ['kneeling', 1]] as const) {
      const p: ApiPrompt = { ...withPictures(c), t: { class_type: 'PrimitiveStringMultiline', inputs: { value: text } } }
      p.n!.inputs.pose_prompt = ['t', 0]
      expect(isRunnerEligible(p, ON)).toBe(true)
      expect(stageEstimate(p, ['n'], false, ON)).toBe(14)
      const { k, rec } = await run(c, { hosted: true }, p)
      expect(rec.status, rec.error ?? '').toBe('done')
      expect(k.replicate.reqs.size).toBe(calls)
      expect([...k.ledger.holds.values()].map(h => [h.credits, h.actual ?? 0])).toEqual([[14, calls ? 14 : 0]])
      if (calls) expect([...k.replicate.reqs.values()][0]!.payload.prompt).toBe(poseInstruction('prompt', '', 'kneeling'))
    }
  })
})

// ── Refusals before the hold ─────────────────────────────────────────────────

describe('refusals before the hold, in plain words', () => {
  async function refusedAtStart(c: NanoCase, want: string, o: Parameters<typeof kitFor>[1] = {}, prompt = withPictures(c)) {
    const k = await kitFor(c, o)
    await expect(k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })).rejects.toThrow(want)
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
  }

  it('hosted: a saved pose named but gone (Python falls through to a call) is refused; locally Python\'s fallback runs, priced as a call', async () => {
    for (const name of SAVED_POSE_GONE_CALLS) {
      const c = caseNamed(name)
      await refusedAtStart(c, POSE_RESULT_MISSING, { hosted: true })
      const local = await run(c)
      expect(local.rec.status, local.rec.error ?? '').toBe('done')
      expect(local.k.replicate.reqs.size).toBe(1)
      expect(local.rec.credits).toBe(14)
      // Priced as a call on both paths (fix round 1): the ComfyUI path's charge for it, with nothing read.
      expect(priceGraph(withPictures(c)).nodes!.n).toBe(14)
    }
  })

  it('the backstop: a call with a saved pose named is never sent in hosted', async () => {
    for (const name of SAVED_POSE_GONE_CALLS) {
      const c = caseNamed(name)
      await expect(planOf(c, { hosted: true, priceInputs: withPictures(c).n!.inputs })).rejects.toThrow(POSE_RESULT_MISSING)
    }
  })

  it('a saved picture Python reads its own way (CMYK) is refused, only when Python would open it', async () => {
    const cmyk = new Uint8Array(await sharp({ create: { width: 4, height: 4, channels: 3, background: '#808080' } }).toColourspace('cmyk').jpeg().toBuffer())
    const c = caseNamed('pose · mannequin · baked result, no other render')
    const k = await kitFor(c, { hosted: true })
    writeFileSync(join(k.root, 'input', 'pose_result.png'), cmyk)
    await expect(k.engine.startRun({ userId: k.userId, takes: [withPictures(c)], ...START })).rejects.toThrow(poseBakedRefusal(PICTURE_CMYK))
    expect(k.ledger.hold).not.toHaveBeenCalled()
    // In image mode the saved pose is never opened: nothing refused.
    const img = caseNamed('pose · image · a baked result is ignored')
    const k2 = await kitFor(img)
    writeFileSync(join(k2.root, 'input', 'pose_result.png'), cmyk)
    const { runId } = await k2.engine.startRun({ userId: k2.userId, takes: [withPictures(img)], ...START })
    await k2.engine.settled(runId)
    expect((await k2.store.get(runId))!.takes[0]!.nodes.n!.status).toBe('done')
  })

  it('hosted: the saved pictures must be the user\'s own (collectInputFiles), checked before the hold', async () => {
    const c = caseNamed('pose · mannequin · baked result pose_result.png')
    // The character's LoadImage, and the three saved pictures.
    expect(collectInputFiles(withPictures(c)).map(f => f.filename).sort()).toEqual(['character.png', 'pose_cond.png', 'pose_mannequin.png', 'pose_result.png'])
    const k = await kitFor(c, { hosted: true })
    k.deps.ownership = { ownsInput: async (_u, f) => f.filename !== 'pose_cond.png', ownsOutput: async () => true }
    const { createEngine } = await import('~~/server/runner/engine')
    const engine = createEngine(k.deps)
    await expect(engine.startRun({ userId: k.userId, takes: [withPictures(c)], ...START })).rejects.toThrow(/isn’t one of yours/)
    expect(k.ledger.hold).not.toHaveBeenCalled()
  })

  it('the refusals are plain words', () => {
    for (const w of [POSE_RESULT_MISSING, poseBakedRefusal(PICTURE_CMYK)]) expect(w).not.toMatch(/Node|_|\bid\b/)
  })
})

// ── The backup ───────────────────────────────────────────────────────────────

describe('the fal backup (NUXT_RUNNER_BACKUP on, Replicate down)', () => {
  for (const name of ['lens · Classic 35mm Summilux → Tele 135mm f/2', 'pose · extra padded · mannequin', 'pose · extra non-ASCII · image']) {
    it(`${name}: fal's Nano Banana 2 edit gets the same prompt and pictures, charged once at the node's price`, async () => {
      const c = caseNamed(name)
      const fal = createFakeFal()
      const k = await kitFor(c, { hosted: true, backup: true, fal })
      k.deps.download = async () => ({ bytes: new Uint8Array(await png(8, 6)), contentType: 'image/png' })
      ;(k.replicate.client.submit as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new ReplicateError('replicate submit 503: unavailable', 503))
      const { runId } = await k.engine.startRun({ userId: k.userId, takes: [withPictures(c)], ...START })
      await k.engine.settled(runId)
      const rec = (await k.store.get(runId))!.takes[0]!.nodes.n!
      expect(rec.status, rec.error ?? '').toBe('done')
      const sent = [...fal.reqs.values()]
      expect(sent.map(r => r.endpoint)).toEqual(['fal-ai/nano-banana-2/edit'])
      const rep = (k.replicate.client.submit as ReturnType<typeof vi.fn>).mock.calls[0]![1] as Record<string, unknown>
      expect(sent[0]!.payload.prompt).toBe(rep.prompt)
      expect(sent[0]!.payload.prompt).toBe(c.calls[0]!.payload.prompt)
      expect(sent[0]!.payload.image_urls).toEqual(rep.image_input)
      expect(rec.servedBy).toBe('fal')
      expect(ofType(k.seen, 'execution_error')).toEqual([])
      expect([...k.ledger.holds.values()].map(h => [h.state, h.actual])).toEqual([['settled', 14]])
    })
  }
})

// ── Moderation ───────────────────────────────────────────────────────────────

describe('moderation', () => {
  it('lists Pose Mannequin\'s extra direction and pose prompt; Lens reframe sends only Sailor\'s text', () => {
    expect(PAID_TEXT_INPUTS.PoseMannequin).toEqual(['prompt', 'pose_prompt'])
    expect(PAID_TEXT_INPUTS.LensReframe).toBeUndefined()
    expect(extraPromptTexts({ n: { class_type: 'PoseMannequin', inputs: { prompt: 'warm light', pose_prompt: 'arms up' } } })).toEqual(['warm light', 'arms up'])
  })

  for (const key of ['prompt', 'pose_prompt']) {
    it(`a hosted flagged ${key} is refused at the start, before the hold`, async () => {
      const c = caseNamed('pose · prompt · pose prompt padded')
      const moderate = vi.fn(async (t: string) => (t.includes('forbidden') ? { ok: false as const, categories: ['violence'] } : { ok: true as const }))
      const k = await kitFor(c, { hosted: true, moderate })
      const p = withPictures({ ...c, widgets: { ...c.widgets, [key]: 'a forbidden thing' } })
      await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START })).rejects.toThrow()
      expect(moderate.mock.calls.map(x => x[0])).toContain('a forbidden thing')
      expect(k.ledger.hold).not.toHaveBeenCalled()
      expect(k.replicate.client.submit).not.toHaveBeenCalled()
    })
  }
})

// ── With nano-extras off (rule 15) ───────────────────────────────────────────

describe('with nano-extras off (rule 15)', () => {
  const OFF_SETS: [string, RunnerFamily[]][] = [
    ['none', []],
    ['cards only', ['cards']],
    ['every family but nano-extras', RUNNER_FAMILIES.filter(f => f !== 'nano-extras')],
  ]
  const isOurs = (ct: string) => (NANO_EXTRAS_CLASSES as readonly string[]).includes(ct)
  /** The same prompt as before R3.15: the classes had no rule row and were no picture (renamed to one that has neither). */
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
  const lens = () => withPictures(caseNamed('lens · Normal 50mm Planar → Portrait 85mm GM'))
  const pose = () => withPictures(caseNamed('pose · image · with a pose picture'))

  it('each class is left to the engine, and named by the needs-the-engine list', () => {
    for (const p of [lens(), pose()]) {
      const ct = p.n!.class_type
      expect(runnerTakesNode(p, 'n', new Set(['cards'])), ct).toBe(false)
      expect(runnerTakesNode(p, 'n', ON), ct).toBe(true)
      expect(nodesNeedingEngine(p, { runnerOn: true, families: new Set(['cards']), titleOf: id => id })).toEqual(['n'])
      expect(RUNNER_OUTPUT_CLASSES.has(ct), ct).toBe(true)
      expect(IMAGE_OUTPUT_CLASSES.has(ct)).toBe(false)
      expect(PAID_PICTURE_FAMILY[ct]).toBe('nano-extras')
      expect(RUNNER_NODE_RULES[ct]!.family).toBe('nano-extras')
      expect(RUNNER_ROUTES[ct]).toEqual({ first: 'replicate', backup: 'fal' })
    }
    // Lens reframe with no picture wired (Python's blank 16×16) stays with the engine.
    expect(runnerTakesNode({ n: { class_type: 'LensReframe', inputs: { ...caseNamed('lens · Normal 50mm Planar → Portrait 85mm GM').widgets } } }, 'n', ON)).toBe(false)
    // So does Pose Mannequin with no character (ComfyUI refuses a missing required input).
    expect(runnerTakesNode({ n: { class_type: 'PoseMannequin', inputs: { ...caseNamed('pose · mannequin · nothing to pose with (passes the character)').widgets } } }, 'n', ON)).toBe(false)
  })

  it('a wire from one of them is a picture only while the family is on; a wired widget leaves the node to the engine', () => {
    const p: ApiPrompt = { ...lens(), u: { class_type: 'PoseMannequin', inputs: { ...caseNamed('pose · image · with a pose picture').widgets, character: ['n', 0], pose_image: ['n', 0] } } }
    expect(runnerTakesNode(p, 'u', ON)).toBe(true)
    expect(runnerTakesNode(p, 'u', new Set<RunnerFamily>(RUNNER_FAMILIES.filter(f => f !== 'nano-extras')))).toBe(false)
    const q = pose()
    expect(runnerTakesNode({ ...q, t: { class_type: 'Text', inputs: { text: 'image' } }, n: { ...q.n!, inputs: { ...q.n!.inputs, pose_source: ['t', 0] } } }, 'n', ON)).toBe(false)
    const l = lens()
    expect(runnerTakesNode({ ...l, n: { ...l.n!, inputs: { ...l.n!.inputs, custom_focal: 400 } } }, 'n', ON)).toBe(false)
  })

  it('over synthetic chains: into a Frame, into each other, a Text card into the prompts', () => {
    for (const p of [lens(), pose()]) {
      const ct = p.n!.class_type
      sameAsBefore(p, `${ct} alone`)
      sameAsBefore({ ...p, f: { class_type: 'Compositor', inputs: { layer1: ['n', 0], width: 0, height: 0 } } }, `${ct} → Frame`)
      sameAsBefore({ ...p, i: { class_type: 'Image', inputs: { image: '', images: ['n', 0] } } }, `${ct} → Image card`)
      sameAsBefore({ ...p, r: { class_type: 'LensReframe', inputs: { ...lens().n!.inputs, image: ['n', 0] } } }, `${ct} → Lens reframe`)
    }
    const q = pose()
    sameAsBefore({ ...q, t: { class_type: 'Text', inputs: { text: 'hi' } }, n: { ...q.n!, inputs: { ...q.n!.inputs, prompt: ['t', 0] } } }, 'Text → Pose')
  })

  const PROJECTS = resolve(__dirname, '../../../user/sailor/projects')
  const projectsIt = existsSync(PROJECTS) ? it : it.skip

  projectsIt('over every saved project graph (with Lens reframe spliced in beside each)', async () => {
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
          d_lr: { class_type: 'LensReframe', inputs: { ...lens().n!.inputs, image: ['d_img', 0] } },
        }, `${uuid} + Lens reframe`)
      }
    }
    expect(graphs).toBeGreaterThanOrEqual(800)
    console.info(`nano-extras families-off invariant: ${graphs} saved graphs`)
  }, 600_000)
})

// ── Fix round 1 ──────────────────────────────────────────────────────────────

describe('the runner\'s deliberate deviation: the conditioning render makes the call (fix round 1)', () => {
  const deviations = CASES.filter(c => c.runner)
  it('exactly the cases where Python raises on the conditioning render, each with its reason', () => {
    expect(deviations.map(c => c.name).sort()).toEqual([
      'pose · mannequin · conditioning and mannequin renders', 'pose · mannequin · conditioning render',
      'pose · mannequin · conditioning render EXIF 6', 'pose · mannequin · conditioning render RGBA',
      'pose · mannequin · missing result, the conditioning render',
    ])
    for (const c of deviations) {
      expect(c.error!.message, c.name).toMatch(/Boolean value of Tensor/)
      expect(c.calls, c.name).toEqual([])
      expect(c.runner!.reason).toMatch(/runner only \(R3\.15 fix round 1\)/)
      expect(c.runner!.calls[0]!.payload.prompt, c.name).toBe(poseInstruction('mannequin', String(c.widgets.prompt ?? ''), ''))
    }
  })

  it('hosted: held and charged as a call (14), sent with the conditioning render as `_load_input_image` loads it', async () => {
    const c = caseNamed('pose · mannequin · conditioning render EXIF 6')
    const { k, rec } = await run(c, { hosted: true })
    expect(rec.status, rec.error ?? '').toBe('done')
    expect([...k.ledger.holds.values()].map(h => [h.credits, h.actual])).toEqual([[14, 14]])
    expect(paidNoCall('PoseMannequin', withPictures(c).n!.inputs)).toBe(false)
  })

  it('the ComfyUI path is unchanged: Python still raises there (priced as a call, charged only if it finished, which it never does)', () => {
    const c = caseNamed('pose · mannequin · conditioning render')
    expect(priceGraph(withPictures(c)).nodes!.n).toBe(14)
    const src = readFileSync(resolve(__dirname, '../../../comfy_extras/nodes_pose_mannequin.py'), 'utf8')
    expect(src).toContain('cond = _load_input_image(pose_cond_image) or _load_input_image(mannequin_image)')
  })
})

describe('the hosted ComfyUI gate reads a saved pose before pricing it free (fix round 1)', () => {
  it('savedPoseRefs: the saved poses whose branch they decide', () => {
    const L = ['c', 0]
    expect(savedPoseRefs({
      a: { class_type: 'PoseMannequin', inputs: { character: L, result_image: 'r.png' } },
      b: { class_type: 'PoseMannequin', inputs: { character: L, pose_source: 'image', pose_image: L, result_image: 'r.png' } },
      c: { class_type: 'PoseMannequin', inputs: { result_image: 'r.png' } },
      d: { class_type: 'PoseMannequin', inputs: { character: L, result_image: '  ' } },
      e: { class_type: 'PoseMannequin', inputs: { character: L, pose_source: L, result_image: 'r.png' } },
      f: { class_type: 'LoadImage', inputs: { image: 'r.png' } },
    })).toEqual({ a: 'r.png', d: '  ' }) // spaces: a name Python tries (fix round 2), read like any other
  })

  const baked = (): ApiPrompt => ({ p: { class_type: 'LoadImage', inputs: { image: 'c.png' } }, n: { class_type: 'PoseMannequin', inputs: { character: ['p', 0], result_image: 'pose_result.png', pose_source: 'mannequin', prompt: '', pose_prompt: '', pose_state: '', mannequin_image: 'pose_mannequin.png', pose_cond_image: '' } } })
  const deps = (savedPoses?: Record<string, boolean>) => ({
    priceGraph: vi.fn(priceGraph),
    spendGuard: vi.fn(async () => {}),
    validateFileRefs: vi.fn(async () => {}),
    moderatePrompt: vi.fn(async () => ({ ok: true as const })),
    hold: vi.fn(async () => ({ ok: true as const, holdId: 7 })),
    getAvailable: vi.fn(async () => 100),
    forward: vi.fn(async () => ({ status: 200, body: { prompt_id: 'p1', number: 1, node_errors: {} } })),
    registerRun: vi.fn(async () => {}),
    startSettle: vi.fn(),
    releaseHold: vi.fn(async () => {}),
    ...(savedPoses ? { measureSavedPoses: vi.fn(async () => savedPoses) } : {}),
  })

  it('a saved pose the gate found loading: nothing held; one it didn\'t (gone, unreadable, not read): held as the call', async () => {
    const { meterGraphSubmit } = await import('~~/server/utils/meterGraphRun')
    const free = deps({ n: true })
    expect((await meterGraphSubmit('u1', { prompt: baked() }, free as any)).status).toBe(200)
    expect(free.measureSavedPoses).toHaveBeenCalled()
    expect(free.hold).not.toHaveBeenCalled()
    for (const d of [deps({ n: false }), deps({}), deps()]) {
      expect((await meterGraphSubmit('u1', { prompt: baked() }, d as any)).status).toBe(200)
      expect(d.hold).toHaveBeenCalledWith('u1', 14)
    }
  })

  it('ComfyUI reads the very copy the gate read: the saved pose is renamed to it in the forwarded prompt', async () => {
    const { rewriteMeasuredInputs } = await import('~~/server/utils/gateSnapshots')
    const out = rewriteMeasuredInputs(baked(), { nameFor: s => (s.value === 'pose_result.png' ? 'gate_copy_1.png' : null) })
    if ('problems' in out) throw new Error('refused')
    expect(out.prompt.n.inputs.result_image).toBe('gate_copy_1.png')
    // The renders it doesn't read are left as they are.
    expect(out.prompt.n.inputs.mannequin_image).toBe('pose_mannequin.png')
  })
})

// ── Fix round 2 ──────────────────────────────────────────────────────────────

const TMP = mkdtempSync(join(tmpdir(), 'nano-extras-r2-'))
const tmpFile = (name: string, bytes: Uint8Array): string => { const p = join(TMP, name); writeFileSync(p, bytes); return p }
const CORRUPT = BAKED['pose_result_corrupt.png']!
const TRUNCATED = BAKED['pose_result_truncated.png']!

describe('ruling 1: a saved pose "loads" only if it decodes fully and strictly (fix round 2)', () => {
  it('decodesStrictly: the corrupt-IDAT and cut-short PNGs fail; good PNG, JPEG, 16-bit PNG and AVIF decode', async () => {
    const { decodesStrictly, pictureRefusal } = await import('~~/server/runner/pictures/pythonView')
    // Both broken files still pass a header read (what the gate used to trust).
    for (const b of [CORRUPT, TRUNCATED]) {
      expect(await pictureRefusal(b)).toBeNull()
      expect(await decodesStrictly(b)).toBe(false)
    }
    const rgb = await sharp({ create: { width: 9, height: 7, channels: 3, background: { r: 200, g: 10, b: 60 } } })
    const good = [
      new Uint8Array(await rgb.clone().png().toBuffer()),
      new Uint8Array(await rgb.clone().jpeg().toBuffer()),
      new Uint8Array(await rgb.clone().toColourspace('rgb16').png().toBuffer()),
      new Uint8Array(await rgb.clone().avif().toBuffer()),
      BAKED['pose_result_exif6.jpg']!,
    ]
    for (const [i, b] of good.entries()) {
      expect(await decodesStrictly(b), `good ${i}`).toBe(true)
      expect(await decodesStrictly(tmpFile(`good_${i}`, b)), `good ${i} by path`).toBe(true)
    }
    expect(await decodesStrictly(tmpFile('corrupt.png', CORRUPT))).toBe(false)
    expect(await decodesStrictly(tmpFile('truncated.png', TRUNCATED))).toBe(false)
  })

  it('the hosted ComfyUI gate: both broken saved poses priced 14 (Python falls through to the call); a good one 0', async () => {
    const { savedPosesLoading } = await import('~~/server/utils/meterGraphRun')
    const L = ['p', 0]
    const prompt = (result: string): ApiPrompt => ({ n: { class_type: 'PoseMannequin', inputs: { character: L, result_image: result, mannequin_image: 'pose_mannequin.png', pose_source: 'mannequin' } } })
    const copies: Record<string, string> = {
      'corrupt.png': tmpFile('gate_corrupt.png', CORRUPT),
      'truncated.png': tmpFile('gate_truncated.png', TRUNCATED),
      'good.png': tmpFile('gate_good.png', BAKED['pose_result.png']!),
    }
    for (const [name, want] of [['corrupt.png', 14], ['truncated.png', 14], ['good.png', 0], ['gone.png', 14]] as const) {
      const p = prompt(name)
      const savedPoses = await savedPosesLoading(p, async v => copies[v] ?? null)
      expect(savedPoses, name).toEqual({ n: want === 0 })
      expect(priceGraph(p, { savedPoses }).nodes!.n, name).toBe(want)
    }
    // A copy that can't be read is a call too.
    expect(await savedPosesLoading(prompt('x.png'), async () => { throw new Error('gone') })).toEqual({ n: false })
    // Python itself: both broken files fall through to the call (the fixture).
    for (const f of ['pose_result_corrupt.png', 'pose_result_truncated.png']) {
      expect(caseNamed(`pose · mannequin · saved pose ${f}, the mannequin render`).calls.length, f).toBe(1)
      expect(caseNamed(`pose · mannequin · saved pose ${f}, nothing else`).calls.length, f).toBe(0)
    }
  })

  it('the runner: never hands a broken saved pose on; hosted refuses the call it would make; with nothing else, the character passes', async () => {
    for (const f of ['pose_result_corrupt.png', 'pose_result_truncated.png']) {
      const withRender = caseNamed(`pose · mannequin · saved pose ${f}, the mannequin render`)
      const k = await kitFor(withRender, { hosted: true })
      await expect(k.engine.startRun({ userId: k.userId, takes: [withPictures(withRender)], ...START })).rejects.toThrow(POSE_RESULT_MISSING)
      expect(k.ledger.hold).not.toHaveBeenCalled()
      const alone = await run(caseNamed(`pose · mannequin · saved pose ${f}, nothing else`), { hosted: true })
      expect(alone.rec.status, alone.rec.error ?? '').toBe('done')
      expect(alone.rec.outputs[0]!.filename).toBe('character.png')
      expect(alone.k.replicate.client.submit).not.toHaveBeenCalled()
      // At the node's turn too (the file broken after the start): no saved pose, the fallback.
      const { plan } = await planOf(withRender)
      expect(plan.kind).toBe('provider')
    }
  })
})

describe('ruling 2: any non-empty render name is present for the price, as Python\'s `if not filename` (fix round 2)', () => {
  const L = ['p', 0]
  const NAMES = ['./x.png', 'sub/./x.png', 'sub//x.png', 'sub/../x.png', '/abs/x.png', '   ', 'x.png[input]', '../x.png']
  it('a named render is a call; a named saved pose is free only once proven to load', () => {
    for (const name of NAMES) {
      expect(bakedNamePresent(name), name).toBe(true)
      expect(poseNoCall({ character: L, mannequin_image: name }), name).toBe(false)
      expect(poseNoCall({ character: L, pose_cond_image: name }), name).toBe(false)
      expect(priceGraph({ n: { class_type: 'PoseMannequin', inputs: { character: L, mannequin_image: name } } }).nodes!.n, name).toBe(14)
      expect(poseNoCall({ character: L, result_image: name, mannequin_image: 'm.png' }), name).toBe(false)
      expect(poseNoCall({ character: L, result_image: name, mannequin_image: 'm.png' }, { savedPoseLoads: true }), name).toBe(true)
    }
    expect(bakedNamePresent('')).toBe(false)
    expect(poseNoCall({ character: L, mannequin_image: '' })).toBe(true)
  })

  it('pythonInputRef: the file Python opens (get_annotated_filepath, os.path.join), or outside', async () => {
    const { pythonInputRef } = await import('~~/server/runner/inputs')
    const f = (filename: string, subfolder = '', type = 'input') => ({ file: { filename, subfolder, type } })
    expect(pythonInputRef('./x.png')).toEqual(f('x.png'))
    expect(pythonInputRef('sub/./x.png')).toEqual(f('x.png', 'sub'))
    expect(pythonInputRef('sub//x.png')).toEqual(f('x.png', 'sub'))
    expect(pythonInputRef('sub/../x.png')).toEqual(f('x.png'))
    expect(pythonInputRef('x.png [input]')).toEqual(f('x.png'))
    expect(pythonInputRef('x.png[input]')).toEqual(f('x.pn'))
    expect(pythonInputRef('x.png [output]')).toEqual(f('x.png', '', 'output'))
    expect(pythonInputRef('   ')).toEqual(f('   '))
    expect(pythonInputRef('/abs/x.png')).toEqual({ outside: true })
    expect(pythonInputRef('../x.png')).toEqual({ outside: true })
    expect(pythonInputRef('sub/../../x.png')).toEqual({ outside: true })
    expect(pythonInputRef('')).toBeNull()
    expect(pythonInputRef('sub/')).toBeNull()
  })

  it('every such name reaches the same file Python opened, and the same call (the fixture)', () => {
    for (const name of ['./pose_mannequin.png', 'sub/../pose_mannequin.png', 'sub//pose_sub.png', 'sub/./pose_sub.png', './sub/pose_sub.png [input]']) {
      const c = caseNamed(`pose · mannequin · render named ${name}`)
      expect(c.calls.length, name).toBe(1)
      expect(paidNoCall('PoseMannequin', withPictures(c).n!.inputs), name).toBe(false)
    }
  })

  it('hosted ownership: a saved picture named outside the user\'s folders is refused before the hold, in any mode', async () => {
    for (const [base, name] of [['pose · mannequin · render named ./pose_mannequin.png', '/etc/passwd'], ['pose · image · with a pose picture', '../other_user/x.png']] as const) {
      const c = caseNamed(base)
      for (const key of ['mannequin_image', 'result_image']) {
        const k = await kitFor(c, { hosted: true })
        const p = withPictures({ ...c, widgets: { ...c.widgets, [key]: name } })
        await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START })).rejects.toThrow(/isn’t one of yours/)
        expect(k.ledger.hold).not.toHaveBeenCalled()
        expect(k.replicate.client.submit).not.toHaveBeenCalled()
      }
    }
    // A `./` name is the user's own file: listed for the ownership check as that file.
    const c = caseNamed('pose · mannequin · render named ./pose_mannequin.png')
    expect(collectInputFiles(withPictures(c)).map(f => `${f.subfolder}|${f.filename}`).sort()).toEqual(['|character.png', '|pose_mannequin.png'])
  })
})

describe('ruling 3: the hosted backstop only where a saved pose decides the branch (fix round 2)', () => {
  it('image and prompt modes carrying a leftover saved pose run normally in hosted, held and charged as their call', async () => {
    for (const name of ['pose · image · a baked result is ignored', 'pose · prompt · a baked result is ignored']) {
      const c = caseNamed(name)
      expect(c.widgets.result_image).toBe('pose_result.png')
      const { k, rec } = await run(c, { hosted: true })
      expect(rec.status, rec.error ?? '').toBe('done')
      expect(k.replicate.reqs.size).toBe(1)
      expect([...k.ledger.holds.values()].map(h => [h.credits, h.actual])).toEqual([[14, 14]])
      // And the planNode backstop itself lets them through.
      const { plan } = await planOf(c, { hosted: true, priceInputs: withPictures(c).n!.inputs })
      expect(plan.kind).toBe('provider')
    }
  })
})
