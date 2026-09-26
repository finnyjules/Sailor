/**
 * Task F11b: Blend scene's keep_subject in the runner. A Frame with a
 * protected layer, its protect_mask wired into Blend's keep_subject, runs
 * entirely in the runner for every Blend model the runner takes (Flux Kontext
 * Pro, Flux 2 Pro, Nano Banana, Nano Banana 2): the Frame makes its
 * protect_mask (a 16-bit greyscale PNG beside its composite), and Blend lays
 * the provider's answer under the kept region after the call.
 *
 * Measured against the REAL Python: fixtures/runner-blend-keep.json, written
 * by scripts/blend_keep_fixtures.py (CompositorNode.execute, then
 * BlendSceneNode.execute with the provider replaced by a fixed picture that
 * goes through the real download decode), with the network blocked.
 *
 * Tolerances (stated once, here):
 *   the Frame's 8-bit composite: identical (the Frame port is bit-exact);
 *   the protect_mask: within one 16-bit step (1/65535: its float is within
 *     1e-5 of Python's, runner-compositor.unit.spec.ts);
 *   the Blend result, 8-bit: within 1/255 per channel. Two things may move a
 *     value across one level: Python's `image` is the Frame's float composite
 *     where the runner reads the Frame's 8-bit PNG (as every node after a
 *     Frame does), and torch's conv2d sums the blur in its own order.
 *   the kept region (the blurred mask exactly 1): the Frame's own pixels,
 *     within the same 1/255.
 */
import { inflateSync } from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import {
  RUNNER_NODE_RULES, isRunnerEligible, runnerTakesNode,
} from '#shared/runner/eligibility'
import { RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import type { ApiPrompt } from '#shared/runner/graph'
import { blockedModelUses } from '#shared/runner/blockedModels'
import { pruneInvalidOutputs } from '#shared/runner/validate'
import { nodesNeedingEngine } from '~~/app/lib/runner/needsEngine'
import { core, plane, type Plane, type RawPicture } from '~~/server/runner/compositor/plane'
import { decodeRaw } from '~~/server/runner/compositor/decode'
import {
  KEEP_EDGE_TOO_WIDE, KEEP_FEATHER_DEFAULT, KEEP_MASK_MISSING, keepEdgeFits, keepFeatherOf, keepKernelSize, maskPngFromScanlines, readMaskPng,
} from '~~/server/runner/compositor/keep'
import { __frameWorkerForTests, keepSubjectInWorker } from '~~/server/runner/compositor/worker'
import { nodeCredits } from '~~/server/runner/metering'
import type { OutputFile } from '~~/server/runner/types'
import { createFakeLedger, makeKit, until } from './__runner__/kit'
import { createFileHeldBytes, sha256Hex, type HeldBytes } from '~~/server/runner/heldBytes'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

interface FrameFix { links: Record<string, string>; inputs: Record<string, unknown>; width: number; height: number; image8: string; protect: string }
interface Case {
  name: string
  model: string
  frames: Record<string, FrameFix>
  image: ['frame' | 'card', string]
  mask: string
  feather: number
  edited: string
  width?: number
  height?: number
  out8?: string
  error?: string
}
const FIX = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/runner-blend-keep.json', import.meta.url)), 'utf8')) as {
  assets: Record<string, string>
  cases: Case[]
}
const OK = FIX.cases.filter(c => !c.error)
const REFUSED = FIX.cases.filter(c => c.error)
const MODELS = ['Flux Kontext Pro', 'Flux 2 Pro', 'Nano Banana', 'Nano Banana 2'] as const
const FAMILY_OF: Record<string, RunnerFamily> = {
  'Flux Kontext Pro': 'fal-edit', 'Flux 2 Pro': 'fal-edit', 'Nano Banana': 'nano-actions', 'Nano Banana 2': 'nano-banana-2-blend',
}
const ALL: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES)
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }

const unpack = (b64: string) => inflateSync(Buffer.from(b64, 'base64'))
const asset = (name: string) => new Uint8Array(Buffer.from(FIX.assets[name]!, 'base64'))
function u16raw(b64: string): Uint16Array {
  const raw = unpack(b64)
  const out = new Uint16Array(raw.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = raw.readUInt16LE(i * 2)
  return out
}
/** The mask as the runner reads its file back: x = u / 65535 in float32. */
function maskPlane(f: FrameFix): Plane {
  const u = u16raw(f.protect)
  const p = plane(1, f.height, f.width)
  for (let i = 0; i < u.length; i++) p.data[i] = Math.fround(u[i]! / 65535)
  return p
}
/** An 8-bit RGB picture as the raw RGBA the runner decodes from its PNG. */
function rgbRaw(px: Uint8Array | Buffer, w: number, h: number, source: RawPicture['source']): RawPicture {
  const data = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = px[i * 3]!
    data[i * 4 + 1] = px[i * 3 + 1]!
    data[i * 4 + 2] = px[i * 3 + 2]!
    data[i * 4 + 3] = 255
  }
  return { raw: true, source, w, h, data }
}
function diff(a: Uint8Array | Buffer, b: Uint8Array | Buffer): { max: number; off: number } {
  expect(a.length).toBe(b.length)
  let max = 0
  let off = 0
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!)
    if (d) off++
    max = Math.max(max, d)
  }
  return { max, off }
}
/**
 * The pixels where the mask, blurred as Blend blurs it, is 1 to float32
 * precision: the kept region. (A blurred interior sums the normalised kernel,
 * which lands on 1 or one float32 step below it, in Python too.)
 */
function keptPixels(c: Case, h: number, w: number): number[] {
  let m = maskPlane(c.frames[c.mask]!)
  if (m.h !== h || m.w !== w) m = core.resizeBilinear(m, h, w)
  const k = keepKernelSize(c.feather)
  if (k) m = core.blurReflect(m, k, c.feather)
  const out: number[] = []
  for (let i = 0; i < h * w; i++) if (m.data[i]! >= 1 - 2 ** -23) out.push(i)
  return out
}

const report: string[] = []
afterAll(() => {
  if (process.env.COMPOSITOR_PARITY_REPORT) console.log(`\n${report.join('\n')}\n`)
})

// ── The fixtures ────────────────────────────────────────────────────────────

describe('the fixtures', () => {
  it('cover every Python Blend model, no feather, rounding halves to even, both resizes, an RGBA answer, and the refusal', () => {
    expect(new Set(FIX.cases.map(c => c.model))).toEqual(new Set(['Flux Kontext Pro', 'Flux 2 Pro', 'Nano Banana']))
    const feathers = new Set(FIX.cases.map(c => c.feather))
    for (const f of [0, 0.5, 1.5, 2, 7.3, 30, 10.5]) expect(feathers.has(f)).toBe(true)
    expect(OK.some(c => c.image[0] === 'card')).toBe(true)
    // An Image card with transparency hands Blend an RGBA picture; Python keeps its colour only.
    expect(OK.some(c => c.image[0] === 'card' && c.image[1] === 'disc.png')).toBe(true)
    expect(OK.some(c => c.mask !== c.image[1])).toBe(true)
    expect(REFUSED).toHaveLength(2)
    for (const c of REFUSED) expect(c.error).toMatch(/Padding size should be less than the corresponding input dimension/)
  })
})

// ── Pure pieces ─────────────────────────────────────────────────────────────

describe('keep_feather', () => {
  it('reads as ComfyUI hands it over; absent is the widget default', () => {
    expect(keepFeatherOf({})).toBe(KEEP_FEATHER_DEFAULT)
    expect(keepFeatherOf({ keep_feather: 3.5 })).toBe(3.5)
    expect(keepFeatherOf({ keep_feather: '1.25' })).toBe(1.25)
    expect(keepFeatherOf({ keep_feather: 0 })).toBe(0)
  })

  it('kernel size is 2·round(3σ)+1 with Python’s round (halves to even); none at 0 or below', () => {
    expect(keepKernelSize(0)).toBe(0)
    expect(keepKernelSize(-1)).toBe(0)
    expect(keepKernelSize(Number.NaN)).toBe(0)
    expect(keepKernelSize(0.1)).toBe(1)
    expect(keepKernelSize(0.5)).toBe(5) // round(1.5) = 2
    expect(keepKernelSize(1.5)).toBe(9) // round(4.5) = 4
    expect(keepKernelSize(2)).toBe(13)
    expect(keepKernelSize(2.5)).toBe(17) // round(7.5) = 8
    expect(keepKernelSize(10.5)).toBe(65) // round(31.5) = 32
    expect(keepKernelSize(30)).toBe(181)
  })

  it('the edge padding must be smaller than each side (torch’s reflect padding)', () => {
    expect(keepEdgeFits(5.2, 48, 32)).toBe(true) // pad 16
    expect(keepEdgeFits(10.5, 48, 32)).toBe(false) // pad 32
    expect(keepEdgeFits(10.5, 48, 33)).toBe(true)
    expect(keepEdgeFits(0, 1, 1)).toBe(true)
    expect(keepEdgeFits(0.5, 2, 2)).toBe(false) // pad 2
  })

  it('the Gaussian kernel is torchvision’s: symmetric, sums to 1', () => {
    const k = core.gaussianKernel(13, 2)
    expect(k).toHaveLength(13)
    for (let i = 0; i < 6; i++) expect(k[i]).toBe(k[12 - i])
    expect(Math.abs(k.reduce((s, v) => s + v, 0) - 1)).toBeLessThan(1e-6)
    expect(k[6]).toBeGreaterThan(k[5]!)
  })
})

describe('the mask file: a 16-bit greyscale PNG', () => {
  it('writes round(x·65535) and reads it back exactly; 0 and 1 stay exact', async () => {
    const p = plane(1, 3, 5)
    const vals = [0, 1, 0.5, 0.25, 1 / 3, 0.999999, 1e-6, 0.8, 0.6, 0.123, 0.9, 0.05, 0.75, 2, -1]
    p.data.set(vals)
    const png = await maskPngFromScanlines(core.mask16Scanlines(p), 5, 3)
    const meta = await sharp(png).metadata()
    expect([meta.width, meta.height, meta.depth, meta.channels]).toEqual([5, 3, 'ushort', 1])
    const back = await readMaskPng(png)
    const q = core.maskFromScanlines(back.scanlines, back.w, back.h)
    for (let i = 0; i < vals.length; i++) {
      const want = Math.floor(Math.min(1, Math.max(0, p.data[i]!)) * 65535 + 0.5) / 65535
      expect(q.data[i]).toBe(Math.fround(want))
    }
    expect(q.data[0]).toBe(0)
    expect(q.data[1]).toBe(1)
  })

  it('reads every PNG filter (a file re-saved by another tool)', async () => {
    const w = 7
    const h = 5
    const u = new Uint16Array(w * h).map((_, i) => (i * 7919) % 65536)
    const buf = Buffer.alloc(w * h * 2)
    for (let i = 0; i < u.length; i++) buf.writeUInt16BE(u[i]!, i * 2)
    // Each row through one of the five filters, by hand.
    const stride = 1 + 2 * w
    const lines = new Uint8Array(stride * h)
    const raw = new Uint8Array(buf)
    for (let y = 0; y < h; y++) {
      const ft = y % 5
      lines[y * stride] = ft
      for (let i = 0; i < 2 * w; i++) {
        const x = raw[y * 2 * w + i]!
        const a = i >= 2 ? raw[y * 2 * w + i - 2]! : 0
        const b = y ? raw[(y - 1) * 2 * w + i]! : 0
        const c = y && i >= 2 ? raw[(y - 1) * 2 * w + i - 2]! : 0
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        const pred = ft === 0 ? 0 : ft === 1 ? a : ft === 2 ? b : ft === 3 ? (a + b) >> 1 : (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
        lines[y * stride + 1 + i] = (x - pred) & 255
      }
    }
    const back = core.maskFromScanlines(lines, w, h)
    for (let i = 0; i < u.length; i++) expect(back.data[i]).toBe(Math.fround(u[i]! / 65535))
  })

  it('refuses anything else plainly', async () => {
    await expect(readMaskPng(new Uint8Array([1, 2, 3]))).rejects.toThrow('The kept region from the Frame could not be read')
    const eight = await sharp(Buffer.alloc(12), { raw: { width: 4, height: 3, channels: 1 } }).png().toBuffer()
    await expect(readMaskPng(new Uint8Array(eight))).rejects.toThrow('The kept region from the Frame could not be read')
  })
})

// ── Parity with Python: the composite on its own ───────────────────────────

/** The base the runner reads: the Frame's 8-bit PNG (source rgb), or the Image card's file. */
async function baseOf(c: Case): Promise<RawPicture> {
  if (c.image[0] === 'card') return decodeRaw(asset(c.image[1]), 'card')
  const f = c.frames[c.image[1]]!
  return rgbRaw(unpack(f.image8), f.width, f.height, 'rgb')
}

describe('keep_subject parity: keepSubject vs BlendSceneNode.execute', () => {
  it.each(OK.map(c => [c.name, c] as const))('%s', async (_n, c) => {
    const r = core.keepSubject(await baseOf(c), await decodeRaw(asset(c.edited), 'provider'), maskPlane(c.frames[c.mask]!), c.feather)
    expect([r.w, r.h]).toEqual([c.width, c.height])
    const d = diff(r.px, unpack(c.out8!))
    report.push(`keep ${c.name}: max |Δ| ${d.max}/255, ${d.off} of ${r.px.length} values differ`)
    expect(d.max).toBeLessThanOrEqual(1)
    // The kept region is the Frame's own render.
    if (c.image[0] === 'frame') {
      const frame8 = unpack(c.frames[c.image[1]]!.image8)
      const kept = keptPixels(c, r.h, r.w)
      let worst = 0
      for (const i of kept) for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(r.px[i * 3 + k]! - frame8[i * 3 + k]!))
      expect(worst).toBeLessThanOrEqual(1)
    }
  })

  it('with no soft edge, the kept region is the Frame’s pixels exactly', async () => {
    const c = OK.find(x => x.feather === 0 && x.image[0] === 'frame')!
    const kept = keptPixels(c, c.height!, c.width!)
    expect(kept.length).toBeGreaterThan(50)
    const r = core.keepSubject(await baseOf(c), await decodeRaw(asset(c.edited), 'provider'), maskPlane(c.frames[c.mask]!), c.feather)
    const frame8 = unpack(c.frames[c.image[1]]!.image8)
    const py = unpack(c.out8!)
    for (const i of kept) {
      for (let k = 0; k < 3; k++) {
        expect(r.px[i * 3 + k]).toBe(frame8[i * 3 + k])
        expect(py[i * 3 + k]).toBe(frame8[i * 3 + k])
      }
    }
  })

  it.each(REFUSED.map(c => [c.name, c] as const))('%s: refused, as Python refuses it', async (_n, c) => {
    const f = c.frames[c.mask]!
    expect(keepEdgeFits(c.feather, f.width, f.height)).toBe(false)
    expect(() => core.keepSubject(rgbRaw(unpack(f.image8), f.width, f.height, 'rgb'), rgbRaw(unpack(f.image8), f.width, f.height, 'provider'), maskPlane(f), c.feather))
      .toThrow('KEEP_PAD')
  })

  it('on the worker: the same pixels', async () => {
    const c = OK[0]!
    const f = c.frames[c.mask]!
    const scan = core.mask16Scanlines(maskPlane(f))
    const out = await keepSubjectInWorker({ base: await baseOf(c), edited: await decodeRaw(asset(c.edited), 'provider'), mask: scan, mw: f.width, mh: f.height, feather: c.feather })
    expect(__frameWorkerForTests()).not.toBeNull()
    const inThread = core.keepSubject(await baseOf(c), await decodeRaw(asset(c.edited), 'provider'), maskPlane(f), c.feather)
    expect(Buffer.from(out.px).equals(Buffer.from(inThread.px))).toBe(true)
  })
})

// ── Eligibility ─────────────────────────────────────────────────────────────

const card = (image: string) => ({ class_type: 'Image', inputs: { image, export: false, filename_prefix: 'ComfyUI', batch_index: -1 } })
function frameWidgets(over: Record<string, unknown> = {}): Record<string, unknown> {
  const w: Record<string, unknown> = {}
  for (let i = 1; i <= 16; i++) {
    Object.assign(w, {
      [`layer${i}_x`]: 0, [`layer${i}_y`]: 0, [`layer${i}_rotation`]: 0, [`layer${i}_scale`]: 1,
      [`layer${i}_opacity`]: 1, [`layer${i}_blend`]: 'normal', [`layer${i}_z`]: i, [`layer${i}_protect`]: false, [`layer${i}_cloner`]: '',
    })
  }
  return { ...w, width: 0, height: 0, motion_params: '', ...over }
}
const frame = (inputs: Record<string, unknown>) => ({ class_type: 'Compositor', inputs: frameWidgets(inputs) })
function blend(model: string, over: Record<string, unknown> = {}) {
  return {
    class_type: 'BlendSceneNode',
    inputs: {
      model, image: ['3', 0], keep_subject: ['3', 1], unify_lighting: true, contact_shadows: true, match_camera_look: true,
      preserve_identity: true, keep_feather: 2, prompt: '', seed: 0, output_format: 'png', ...over,
    },
  }
}
/** Image cards 1, 2 → Frame 3 (layer 2 protected) → Blend 5 (picture and kept region from the Frame) → Image card 6. */
function keepFlow(model: string, over: Record<string, unknown> = {}): ApiPrompt {
  return {
    1: card('land.png'),
    2: card('disc.png'),
    3: frame({ layer1: ['1', 0], layer2: ['2', 0], layer2_protect: true }),
    5: blend(model, over),
    6: { class_type: 'Image', inputs: { image: '', export: false, images: ['5', 0], batch_index: -1 } },
  }
}

describe('eligibility: a Frame’s protect_mask into Blend’s keep_subject', () => {
  it('keep_subject is no longer refused; keep_feather is read, so it must not be wired', () => {
    const rule = RUNNER_NODE_RULES.BlendSceneNode!
    expect(rule.mustNotLink).toEqual(['prompt', 'keep_feather'])
    expect(rule.linkSources).toEqual({ keep_subject: [['Compositor', 1]] })
    expect(RUNNER_NODE_RULES.Compositor!.outputsNotLinked).toEqual([2])
    expect(RUNNER_NODE_RULES.Compositor!.outputReaders).toEqual({ 1: [['BlendSceneNode', 'keep_subject']] })
  })

  it.each(MODELS)('%s: taken with frame and its own family on, and not without either', (model) => {
    const p = keepFlow(model)
    expect(isRunnerEligible(p, new Set<RunnerFamily>(['frame', FAMILY_OF[model]!]))).toBe(true)
    expect(isRunnerEligible(p, ALL)).toBe(true)
    expect(isRunnerEligible(p, new Set<RunnerFamily>([FAMILY_OF[model]!]))).toBe(false)
    expect(isRunnerEligible(p, new Set<RunnerFamily>(['frame']))).toBe(false)
    expect(nodesNeedingEngine(p, { runnerOn: true, families: ALL, titleOf: id => `#${id}` })).toEqual([])
  })

  it('Nano Banana 2 with a Frame’s kept region is no longer refused on a runner run (it stays refused on ComfyUI)', () => {
    const p = keepFlow('Nano Banana 2')
    expect(blockedModelUses(p, { families: ALL, runnerTakes: true })).toEqual([])
    expect(blockedModelUses(p, { families: ALL })).toHaveLength(1)
  })

  const refused: [string, ApiPrompt, string][] = [
    ['keep_subject from an Image card', { ...keepFlow('Flux 2 Pro'), 5: blend('Flux 2 Pro', { keep_subject: ['1', 1] }) }, '5'],
    ['keep_subject from the Frame’s picture (output 0)', { ...keepFlow('Flux 2 Pro'), 5: blend('Flux 2 Pro', { keep_subject: ['3', 0] }) }, '5'],
    ['keep_subject from a LoadImage mask', { ...keepFlow('Flux 2 Pro'), 7: { class_type: 'LoadImage', inputs: { image: 'm.png', upload: 'image' } }, 5: blend('Flux 2 Pro', { keep_subject: ['7', 1] }) }, '5'],
    ['keep_feather wired', keepFlow('Flux 2 Pro', { keep_feather: ['1', 0] }), '5'],
    ['keep_feather above 30', keepFlow('Flux 2 Pro', { keep_feather: 31 }), '5'],
    ['keep_feather below 0', keepFlow('Flux 2 Pro', { keep_feather: -1 }), '5'],
    ['keep_feather not a number', keepFlow('Flux 2 Pro', { keep_feather: 'soft' }), '5'],
    ['the protect_mask read by a Gate', { ...keepFlow('Flux 2 Pro'), 8: { class_type: 'ComfyGateNode', inputs: { data_in: ['3', 1], bypass: false } } }, '3'],
    ['the protect_mask read by another Blend input', { ...keepFlow('Flux 2 Pro'), 5: blend('Flux 2 Pro', { image: ['3', 1] }) }, '3'],
    ['the video output read', { ...keepFlow('Flux 2 Pro'), 8: { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'v', source: ['3', 2] } } }, '3'],
  ]
  it.each(refused)('%s → ComfyUI', (_l, p, badId) => {
    expect(runnerTakesNode(p, badId, ALL)).toBe(false)
    expect(isRunnerEligible(p, ALL)).toBe(false)
  })

  it('keep_feather is validated as ComfyUI does: a value above 30 drops Blend’s output', () => {
    const p = keepFlow('Flux 2 Pro', { keep_feather: 31 })
    const r = pruneInvalidOutputs(p, ALL)
    expect(r.dropped).toContain('5')
    expect(r.nodeErrors['5']!.errors[0]!.type).toBe('value_bigger_than_max')
    // Absent: fine (the runner reads the widget default).
    const q = keepFlow('Flux 2 Pro')
    delete (q['5']!.inputs as Record<string, unknown>).keep_feather
    expect(isRunnerEligible(q, ALL)).toBe(true)
  })

  it('the price is the same with or without the kept region (the composite is local)', () => {
    for (const model of MODELS) {
      const withKeep = keepFlow(model)['5']!
      const without = { ...withKeep, inputs: { ...withKeep.inputs } }
      delete (without.inputs as Record<string, unknown>).keep_subject
      expect(nodeCredits(withKeep, undefined, ALL)).toBe(nodeCredits(without, undefined, ALL))
      expect(nodeCredits(withKeep, undefined, ALL)).toBeGreaterThan(0)
    }
  })
})

// ── The engine, end to end ─────────────────────────────────────────────────

/** A fixture case as a runner prompt: its Frames on Image cards, then Blend and a card after it. */
function promptOf(c: Case, model = c.model, over: Record<string, unknown> = {}): { prompt: ApiPrompt; frameIds: Record<string, string>; files: string[] } {
  const p: ApiPrompt = {}
  const files = new Set<string>()
  let next = 1
  const cardFor = new Map<string, string>()
  const cardOf = (name: string) => {
    if (!cardFor.has(name)) {
      const id = String(next++)
      p[id] = card(name)
      cardFor.set(name, id)
      files.add(name)
    }
    return cardFor.get(name)!
  }
  const frameIds: Record<string, string> = {}
  for (const [key, f] of Object.entries(c.frames)) {
    const links: Record<string, unknown> = {}
    for (const [slot, name] of Object.entries(f.links)) links[slot] = [cardOf(name), 0]
    const id = String(next++)
    p[id] = frame({ ...links, ...f.inputs })
    frameIds[key] = id
  }
  const image = c.image[0] === 'frame' ? [frameIds[c.image[1]]!, 0] : [cardOf(c.image[1]), 0]
  p['90'] = blend(model, { image, keep_subject: [frameIds[c.mask]!, 1], keep_feather: c.feather, seed: 7, ...over })
  p['91'] = { class_type: 'Image', inputs: { image: '', export: false, images: ['90', 0], batch_index: -1 } }
  return { prompt: p, frameIds, files: [...files] }
}

function kitFor(c: Case, o: { hosted?: boolean; held?: HeldBytes; root?: string; dir?: string; fal?: ReturnType<typeof makeKit>['fal']; ledger?: ReturnType<typeof createFakeLedger>; hangAfterSubmit?: boolean } = {}) {
  const answer = asset(c.edited)
  let fal: ReturnType<typeof makeKit>['fal'] | undefined = o.fal
  const k = makeKit({
    hosted: !!o.hosted,
    ...(o.root ? { root: o.root } : {}),
    ...(o.dir ? { dir: o.dir } : {}),
    ...(o.fal ? { fal: o.fal } : {}),
    ...(o.ledger ? { ledger: o.ledger } : {}),
    deps: {
      families: () => ALL,
      download: async () => ({ bytes: answer, contentType: c.edited.endsWith('.jpg') ? 'image/jpeg' : 'image/png' }),
      ...(o.held ? { held: o.held } : {}),
      // A server that "dies" once its request is sent: its waits never return.
      ...(o.hangAfterSubmit
        ? {
            sleep: (_ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
              if (fal && fal.submitted().length) return
              const t = setTimeout(resolve, 1)
              signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
            }),
          }
        : {}),
    },
  })
  fal = k.fal
  return k
}
async function pixels(root: string, f: OutputFile): Promise<Buffer> {
  return sharp(join(root, f.type, f.subfolder, f.filename)).raw().toBuffer()
}

describe('the engine: Frame → Blend scene with the kept region (every model)', () => {
  it.each(OK.map(c => [c.name, c] as const))('%s', async (_n, c) => {
    const k = kitFor(c)
    const { prompt, frameIds, files } = promptOf(c)
    for (const f of files) writeFileSync(join(k.root, 'input', f), asset(f))
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    const nodes = run.takes[0]!.nodes
    expect(nodes['90']!.error ?? null).toBeNull()
    expect(run.status).toBe('done')

    // Each Frame made its composite exactly as Python did, and the one Blend reads its kept region from, the mask too.
    for (const [key, id] of Object.entries(frameIds)) {
      const f = c.frames[key]!
      const rec = nodes[id]!
      expect((await pixels(k.root, rec.outputs[0]!)).equals(unpack(f.image8))).toBe(true)
      if (key === c.mask) {
        const maskFile = rec.slotOutputs![1]![0]!
        expect(maskFile.filename).toMatch(new RegExp(`^live_preview_${id}_protect_mask_\\d{5}\\.png$`))
        expect(maskFile.type).toBe('temp')
        const m = await readMaskPng(new Uint8Array(readFileSync(join(k.root, 'temp', maskFile.subfolder, maskFile.filename))))
        const ours = core.maskFromScanlines(m.scanlines, m.w, m.h)
        const theirs = u16raw(f.protect)
        let worst = 0
        for (let i = 0; i < theirs.length; i++) worst = Math.max(worst, Math.abs(Math.round(ours.data[i]! * 65535) - theirs[i]!))
        expect(worst).toBeLessThanOrEqual(1)
      }
      else expect(rec.slotOutputs).toBeUndefined()
    }

    // Blend: one PNG in the output folder, as the runner saves Blend results; Python's pixels within 1/255.
    const out = nodes['90']!.outputs
    expect(out).toHaveLength(1)
    expect(out[0]!.type).toBe('output')
    expect(out[0]!.filename).toMatch(/^blend_scene_\d{5}_\.png$/)
    const meta = await sharp(join(k.root, 'output', out[0]!.subfolder, out[0]!.filename)).metadata()
    expect([meta.width, meta.height, meta.channels]).toEqual([c.width, c.height, 3])
    const d = diff(await pixels(k.root, out[0]!), unpack(c.out8!))
    report.push(`engine ${c.name}: max |Δ| ${d.max}/255, ${d.off} values differ`)
    expect(d.max).toBeLessThanOrEqual(1)
    // The card after Blend shows the same file.
    expect(nodes['91']!.outputs).toEqual(out)
  })

  it.each(MODELS)('%s: the request is the one without the kept region, the charge is the node’s own, the result is kept', async (model) => {
    const c = OK[0]!
    const k = kitFor(c, { hosted: true })
    const { prompt, frameIds, files } = promptOf(c, model)
    for (const f of files) writeFileSync(join(k.root, 'input', f), asset(f))
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    const rec = run.takes[0]!.nodes['90']!
    // The provider was sent the Frame's composite, never the mask.
    const composite = run.takes[0]!.nodes[frameIds[c.image[1]]!]!.outputs[0]!
    const sent = [...k.fal.submitted(), ...k.replicate.submitted()]
    expect(sent).toHaveLength(1)
    const body = JSON.stringify(sent[0]!.payload)
    expect(body).toContain(composite.filename)
    expect(body).not.toContain('protect_mask')
    // Planned and charged exactly as without keep_subject: same endpoint, body and credits.
    const plain = promptOf(c, model).prompt
    delete (plain['90']!.inputs as Record<string, unknown>).keep_subject
    const k2 = kitFor(c, { hosted: true })
    for (const f of files) writeFileSync(join(k2.root, 'input', f), asset(f))
    const r2 = await k2.engine.startRun({ userId: k2.userId, takes: [plain], ...START })
    await k2.engine.settled(r2.runId)
    const plainRun = (await k2.store.get(r2.runId))!
    const plainRec = plainRun.takes[0]!.nodes['90']!
    const plainSent = [...k2.fal.submitted(), ...k2.replicate.submitted()]
    expect(sent[0]!.endpoint).toBe(plainSent[0]!.endpoint)
    expect(JSON.stringify(sent[0]!.payload)).toBe(JSON.stringify(plainSent[0]!.payload))
    expect(rec.credits).toBe(plainRec.credits)
    expect(rec.credits).toBeGreaterThan(0)
    const total = run.charges.reduce((s, ch) => s + (ch.actual ?? 0), 0)
    expect(total).toBe(plainRun.charges.reduce((s, ch) => s + (ch.actual ?? 0), 0))
    const d = diff(await pixels(k.root, rec.outputs[0]!), unpack(c.out8!))
    expect(d.max).toBeLessThanOrEqual(1)
    // An asset, recorded like any Blend result.
    expect(k.records.write).toHaveBeenCalled()
  })

  it.each(REFUSED.map(c => [c.name, c] as const))('%s: refused before the call, charged nothing', async (_n, c) => {
    const k = kitFor(c, { hosted: true })
    const { prompt, files } = promptOf(c)
    for (const f of files) writeFileSync(join(k.root, 'input', f), asset(f))
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    const rec = run.takes[0]!.nodes['90']!
    expect(rec.status).toBe('error')
    expect(rec.error).toBe(KEEP_EDGE_TOO_WIDE)
    // Nothing handed off, nothing sent.
    expect(k.upload.mock.calls.length).toBe(0)
    expect(k.fal.submitted()).toHaveLength(0)
    expect(k.replicate.submitted()).toHaveLength(0)
    expect(run.charges.reduce((s, ch) => s + (ch.actual ?? 0), 0)).toBe(1)
  })

  it('a reused result needs the same kept region and edge: another feather makes a new call', async () => {
    const c = OK[0]!
    const k = kitFor(c)
    const { prompt, files } = promptOf(c, 'Flux Kontext Pro')
    for (const f of files) writeFileSync(join(k.root, 'input', f), asset(f))
    const runOnce = async (p: ApiPrompt) => {
      const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
      await k.engine.settled(runId)
      return (await k.store.get(runId))!.takes[0]!.nodes['90']!
    }
    const first = await runOnce(prompt)
    expect(first.reused).toBe(false)
    const same = await runOnce(prompt)
    expect(same.reused).toBe(true)
    expect(same.outputs).toEqual(first.outputs)
    const softer = promptOf(c, 'Flux Kontext Pro', { keep_feather: 1 }).prompt
    const other = await runOnce(softer)
    expect(other.reused).toBe(false)
    expect(k.fal.submitted()).toHaveLength(2)
  })

  it('a kept region whose file is gone fails plainly before the call', async () => {
    const c = OK[1]!
    const k = kitFor(c)
    const { prompt, frameIds, files } = promptOf(c)
    for (const f of files) writeFileSync(join(k.root, 'input', f), asset(f))
    // A Frame that ran without making the mask (as if nothing read it then).
    const orig = k.deps.results.saveLivePreview
    k.deps.results.saveLivePreview = async (bytes, o) => {
      const file = await orig(bytes, o)
      if (o.nodeId.endsWith('_protect_mask')) {
        const { rmSync } = await import('node:fs')
        rmSync(join(k.root, 'temp', file.subfolder, file.filename))
      }
      return file
    }
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.takes[0]!.nodes[frameIds[c.mask]!]!.status).toBe('done')
    expect(run.takes[0]!.nodes['90']!.error).toBe(KEEP_MASK_MISSING)
    expect(k.fal.submitted()).toHaveLength(0)
  })

  it('a Frame no node reads the kept region of makes no mask (the ComfyUI-free path is unchanged)', async () => {
    const c = OK[0]!
    const k = kitFor(c)
    const { prompt, frameIds, files } = promptOf(c)
    for (const f of files) writeFileSync(join(k.root, 'input', f), asset(f))
    delete (prompt['90']!.inputs as Record<string, unknown>).keep_subject
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    // Its record is as before: no per-slot files at all.
    expect(run.takes[0]!.nodes[frameIds.A!]!.slotOutputs).toBeUndefined()
    expect('slotOutputs' in run.takes[0]!.nodes[frameIds.A!]!).toBe(false)
    // Without keep_subject the answer is saved as downloaded.
    const out = run.takes[0]!.nodes['90']!.outputs[0]!
    expect(new Uint8Array(readFileSync(join(k.root, 'output', out.subfolder, out.filename)))).toEqual(asset(c.edited))
  })

  // ── Fix round 1: the kept bytes live outside ComfyUI's temp folder ──

  it('bytes composited are the bytes sent: the picture’s sha is the hand-off’s, the mask’s is the Frame file’s', async () => {
    const c = OK[0]!
    const heldDir = mkdtempSync(join(tmpdir(), 'runner-held-'))
    const store = createFileHeldBytes(heldDir)
    const puts: { sha: string; bytes: Uint8Array }[] = []
    const spy: HeldBytes = { ...store, put: async (r, h, b) => { const sha = await store.put(r, h, b); puts.push({ sha, bytes: b }); return sha } }
    const k = kitFor(c, { held: spy })
    const { prompt, frameIds, files } = promptOf(c)
    for (const f of files) writeFileSync(join(k.root, 'input', f), asset(f))
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    const rec = run.takes[0]!.nodes['90']!
    expect(rec.status).toBe('done')
    const sentUrl = (k.fal.submitted()[0]!.payload as { image_url: string }).image_url
    expect(rec.keepHeld!.base).toBe(k.deps.handoff.hashOf(sentUrl))
    const maskFile = run.takes[0]!.nodes[frameIds[c.mask]!]!.slotOutputs![1]![0]!
    expect(rec.keepHeld!.mask).toBe(sha256Hex(new Uint8Array(readFileSync(join(k.root, 'temp', maskFile.subfolder, maskFile.filename)))))
    expect(puts.map(p => p.sha).sort()).toEqual([rec.keepHeld!.base, rec.keepHeld!.mask].sort())
    for (const p of puts) expect(sha256Hex(p.bytes)).toBe(p.sha)
    // Let go once the node finished.
    expect(readdirSync(heldDir)).toEqual([])
  })

  it('ComfyUI empties its temp folder during the provider wait: the result is still composited from the kept bytes', async () => {
    const c = OK[0]!
    const k = kitFor(c)
    const { prompt, files } = promptOf(c)
    for (const f of files) writeFileSync(join(k.root, 'input', f), asset(f))
    k.fal.holdNext(1)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })
    await until(() => k.fal.submitted().length === 1)
    // main.py cleanup_temp(): the Frame's composite and its mask are gone.
    rmSync(join(k.root, 'temp'), { recursive: true, force: true })
    k.fal.release()
    await k.engine.settled(runId)
    const rec = (await k.store.get(runId))!.takes[0]!.nodes['90']!
    expect(rec.error ?? null).toBeNull()
    expect(rec.status).toBe('done')
    const d = diff(await pixels(k.root, rec.outputs[0]!), unpack(c.out8!))
    expect(d.max).toBeLessThanOrEqual(1)
  })

  it('a restart mid-wait (temp emptied too): the resumed Blend keeps its one job and composites correctly', async () => {
    const c = OK[0]!
    const heldDir = mkdtempSync(join(tmpdir(), 'runner-held-'))
    const k1 = kitFor(c, { held: createFileHeldBytes(heldDir), hangAfterSubmit: true })
    const { prompt, files } = promptOf(c)
    for (const f of files) writeFileSync(join(k1.root, 'input', f), asset(f))
    k1.fal.holdNext(1)
    const { runId } = await k1.engine.startRun({ userId: k1.userId, takes: [prompt], ...START })
    await until(() => k1.fal.submitted().length === 1)
    await new Promise(r => setTimeout(r, 20))
    expect(readdirSync(heldDir)).toEqual([runId])
    // The server and ComfyUI restart: temp is emptied; the job finishes meanwhile.
    rmSync(join(k1.root, 'temp'), { recursive: true, force: true })
    k1.fal.release()
    const k2 = kitFor(c, { held: createFileHeldBytes(heldDir), root: k1.root, dir: k1.dir, fal: k1.fal, ledger: k1.ledger })
    expect(await k2.engine.reattach()).toBe(1)
    await k2.engine.settled(runId)
    const rec = (await k2.store.get(runId))!.takes[0]!.nodes['90']!
    expect(rec.error ?? null).toBeNull()
    expect(rec.status).toBe('done')
    expect(k1.fal.submitted()).toHaveLength(1)
    expect(k1.fal.submitted()[0]!.cancelled).toBe(false)
    const d = diff(await pixels(k1.root, rec.outputs[0]!), unpack(c.out8!))
    expect(d.max).toBeLessThanOrEqual(1)
    expect(readdirSync(heldDir)).toEqual([])
  })

  it('at server start, held bytes of runs no longer in progress are let go', async () => {
    const heldDir = mkdtempSync(join(tmpdir(), 'runner-held-'))
    const store = createFileHeldBytes(heldDir)
    const sha = await store.put('run_00000000-0000-4000-8000-000000000999', 't0_5', new Uint8Array([1, 2, 3]))
    expect(await store.get('run_00000000-0000-4000-8000-000000000999', 't0_5', sha)).toEqual(new Uint8Array([1, 2, 3]))
    const k = kitFor(OK[0]!, { held: store })
    await k.engine.reattach()
    expect(readdirSync(heldDir)).toEqual([])
  })
})
