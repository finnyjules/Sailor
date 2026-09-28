/**
 * R2.8: masks, blends and Painter (family effects-mask,
 * server/runner/effects/core/mask.ts, effects/painter.ts): Blend, Apply
 * mask, Threshold mask, Color range mask, Matte grow / shrink, Merge alpha
 * and Painter, against the real Python nodes (scripts/runner_effects_fixtures.py
 * --group mask → fixtures/runner-effects-mask.json). Every class is *exact*
 * (float32 bit for bit with Python, by its sha256) except Matte grow /
 * shrink's feather (torchvision's gaussian_blur: *library*, within MATTE_EPS).
 *
 * A mask travels between runner nodes as its float32 tensor (R2.8 fix round
 * 1, controller ruling: as pictures do since R2.1), kept beside the 16-bit
 * PNG it is saved and shown as: every producer (LoadImage's MASK, Image to
 * mask, Text mask, Text on path, Threshold mask, Color range mask, Matte grow
 * / shrink, Painter) keeps it when an effect or a Frame reads the mask, and
 * readers prefer it. `chains` hold the runner to ComfyUI's own float chain,
 * node by node; the standard cases' mask inputs are kept 16-bit masks with
 * no tensor (a mask value that has none), read as u / 65535.
 */
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inflateSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { makeKit } from './__runner__/kit'
import {
  b64, coreOp, filesOfValue, interleaved, loadFixtures, memoryIO, paramsOf, pngPixels, sha256, sourceNode,
  type FxCase, type FxFile, type FxItem,
} from './__runner__/effectsParity'
import type { ApiPrompt } from '#shared/runner/graph'
import { RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { IMAGE_OUTPUT_CLASSES, PICTURE_OUTPUTS, RUNNER_NODE_RULES, isRunnerEligible, runnerTakesNode } from '#shared/runner/eligibility'
import { RUNNER_OUTPUT_CLASSES, runnerTakesWorkflow } from '#shared/runner/validate'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import {
  EFFECT_CLASSES_PORTED, EFFECT_ERROR_MESSAGES, EFFECT_FAMILIES, EFFECT_FAMILY_OF, EFFECT_MAX_WORK, EFFECT_OUTPUT_KINDS, EFFECT_PICTURE_OUTPUTS,
  EFFECT_PICTURE_TOO_LARGE, EFFECT_PICTURE_TOO_LARGE_HOSTED, EFFECT_TOO_MUCH_WORK, painterColourOf, painterFileIsPortable,
} from '#shared/runner/effects'
import { EFFECTS, painterWork } from '~~/server/runner/effects/table'
import { effectCores } from '~~/server/runner/effects/cores'
import type { Tensor } from '~~/server/runner/effects/core/tensor'
import type { PainterFile } from '~~/server/runner/effects/core/mask'
import { PAINTER_COLOUR_UNREAD, PAINTER_FILE_MISSING } from '~~/server/runner/effects/painter'
import { effectParams } from '~~/server/runner/effects/plan'
import { decodeRaw, type PictureSource } from '~~/server/runner/compositor/decode'
import { readMaskPng } from '~~/server/runner/compositor/keep'
import { workerScript } from '~~/server/runner/compositor/worker'
import { compositorCore } from '~~/server/runner/compositor/plane'
import { collectInputFiles } from '~~/server/runner/inputs'
import { planNode, type NodePlan } from '~~/server/runner/executors'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'
import { createMemoryKeptBytes, type KeptBytes } from '~~/server/runner/keptBytes'
import { floatReadBy } from '~~/server/runner/effects/tensorFiles'
import { PICTURE_16_BIT } from '~~/server/runner/pictures/pythonView'
import { effectSchemaOf } from '#shared/runner/effects'

/** The picture decoder and the kept-mask reader, watched (as the other effect specs): a refusal that came before any pixel was decoded. */
const decodeWatch = vi.hoisted(() => ({ calls: 0, refuse: false }))
vi.mock('~~/server/runner/compositor/keep', async (importOriginal) => {
  const real = await importOriginal<typeof import('~~/server/runner/compositor/keep')>()
  return {
    ...real,
    readMaskPng: (...a: Parameters<typeof real.readMaskPng>) => {
      decodeWatch.calls++
      if (decodeWatch.refuse) throw new Error('DECODED')
      return real.readMaskPng(...a)
    },
  }
})
vi.mock('~~/server/runner/compositor/decode', async (importOriginal) => {
  const real = await importOriginal<typeof import('~~/server/runner/compositor/decode')>()
  return {
    ...real,
    decodeRaw: (...a: Parameters<typeof real.decodeRaw>) => {
      decodeWatch.calls++
      if (decodeWatch.refuse) throw new Error('DECODED')
      return real.decodeRaw(...a)
    },
  }
})

// ── The fixtures ─────────────────────────────────────────────────────────────

interface MaskItem extends FxItem { u16_sha256?: string; f32s?: string }
interface MaskCase extends Omit<FxCase, 'outputs' | 'inputs'> {
  inputs: Record<string, { source: 'rgb' | 'provider' | 'card' | 'blank' | 'mask'; files: string[] }>
  library?: true
  outputs?: { kind: 'image' | 'mask'; items: MaskItem[] }[]
}
interface ChainCase extends MaskCase {
  producer: { class_type: string; file?: string; channel?: string; rendered?: string; widgets?: Record<string, unknown>; image?: { source: string; files: string[] } }
  middle: Record<string, number> | null
  kept: { f32_sha256: string; u16_sha256: string; w: number; h: number }
  quantised: { values: number; f32: number; round8: number; trunc8: number }
}
interface NegZeroCase {
  name: string; class_type: string; widgets: Record<string, unknown>
  input: { shape: [number, number, number, number]; seed: number; neg_zero_every: number; top?: { seed: number; neg_zero_every: number }; mask_seed?: number; mask_neg_zero_every?: number; mask_only?: true }
  items: { w: number; h: number; c: number; f32_sha256: string; neg_zeros: number }[]
}
interface MaskFx extends Omit<FxFile, 'cases'> {
  cases: MaskCase[]
  chains: ChainCase[]
  negzero: NegZeroCase[]
  frame: { name: string; inputs: MaskCase['inputs']; effect: { class_type: string; node_id: string; widgets: Record<string, unknown> }; frame: { widgets: Record<string, unknown>; w: number; h: number; image8: string } }
}
const FX = loadFixtures('mask') as unknown as MaskFx

const MASK_CLASSES = ['Blend', 'ApplyMask', 'ThresholdMask', 'ColorRangeMask', 'MatteGrowShrink', 'MergeAlpha', 'Painter']
/**
 * Matte grow / shrink's feather (255-scale): torchvision's gaussian_blur is
 * conv2d (library, R2.2 gaussianBlur, proven to 2⁻⁸ up to ksize 181). The
 * worst |Δ| measured is 1.78 × 10⁻³ (the fixture's worst 1.02 × 10⁻³; the
 * `--sweep`, 63 fresh masks up to 1024² with feathers up to 30): torch's own
 * float sums over the 181² taps of σ 30, bound by the kernel, not the mask's
 * size. 4× that is past 2⁻⁸, so ε is the cap, 2⁻⁸ (2.2× the worst; R2.8 report).
 */
const MATTE_EPS = 2 ** -8

const MASK: ReadonlySet<RunnerFamily> = new Set(['cards', 'effects-mask'])
const MASK_EDIT: ReadonlySet<RunnerFamily> = new Set(['cards', 'effects-mask', 'fal-edit'])
const MASK_FRAME: ReadonlySet<RunnerFamily> = new Set(['cards', 'effects-mask', 'frame'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }

const tk = effectCores.tk
const kn = effectCores.kn
const assetOf = (name: string) => b64(FX.assets[name]!)

type Op = (inp: Record<string, Tensor | PainterFile>, p: Record<string, unknown>, stop?: () => boolean, state?: unknown, index?: number, count?: number) => { outputs: Tensor[]; preview: Tensor | null }

/** A class's widget defaults (the first case of its standard set). */
function defaultsOf(cls: string): Record<string, unknown> {
  const c = FX.cases.find(x => x.class_type === cls && (x.name.startsWith(`${cls}: defaults`)))
  if (!c) throw new Error(`no defaults case for ${cls}`)
  return c.widgets
}

/** Python's raise, as the runner's key (rule 6); 'engine' where eligibility leaves the node to the engine, 'missing' a painter file that isn't there. */
function keyOfError(e: { type: string; message: string }): string {
  if (/must match the size of tensor b \(\d\) at non-singleton dimension 3/.test(e.message)) return 'EFFECT_NEEDS_RGB'
  if (/^operands could not be broadcast together with shapes \(\d+,\d+,3\) \(\d+,\d+,4\)/.test(e.message)) return 'EFFECT_NEEDS_RGB'
  if (/must match the size of tensor b \(\d\) at non-singleton dimension 0/.test(e.message)) return 'EFFECT_BATCHES_DIFFER'
  if (/^Sizes of tensors must match except in dimension 3/.test(e.message)) return 'EFFECT_BATCHES_DIFFER'
  if (/Padding size should be less than the corresponding input dimension/.test(e.message)) return 'EFFECT_PICTURE_TOO_SMALL'
  if (e.type === 'ValueError' && /^invalid literal for int\(\) with base 16/.test(e.message)) return 'engine'
  if (e.type === 'FileNotFoundError') return 'missing'
  throw new Error(`an unmapped Python raise: ${e.type}: ${e.message}`)
}

/** A byte-shuffled, zlib'd float32 (the fixture's `f32s`) back as its floats. */
function unshuffle(s: string): Float32Array {
  const raw = inflateSync(b64(s))
  const n = raw.length / 4
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < n; i++) for (let j = 0; j < 4; j++) out[i * 4 + j] = raw[j * n + i]!
  return new Float32Array(out.buffer)
}

/** A mask's floats as the runner keeps them (pixels/core.ts mask16Of): floor(clip(v) · 65535 + 0.5), little-endian uint16. */
function u16Of(d: ArrayLike<number>): Uint16Array {
  const out = new Uint16Array(d.length)
  for (let i = 0; i < d.length; i++) {
    const v = d[i]!
    out[i] = Math.floor((v < 0 ? 0 : v > 1 ? 1 : v) * 65535 + 0.5)
  }
  return out
}
const shaU16 = (q: Uint16Array) => sha256(new Uint8Array(q.buffer, q.byteOffset, q.byteLength))
const shaF32 = (f: Float32Array) => sha256(new Uint8Array(f.buffer, f.byteOffset, f.byteLength))

/** A kept 16-bit mask PNG's values. */
async function keptU16(png: Uint8Array): Promise<{ w: number; h: number; q: Uint16Array }> {
  const m = await readMaskPng(png)
  const t = tk.fromMask16(m.scanlines, m.w, m.h)
  const q = new Uint16Array(t.data.length)
  for (let i = 0; i < q.length; i++) q[i] = Math.round(t.data[i]! * 65535)
  return { w: m.w, h: m.h, q }
}

/** The painter file a Painter case names, as sharp decodes it for the worker (RGBA, no EXIF turn). */
async function painterOf(c: MaskCase): Promise<PainterFile | undefined> {
  const name = c.widgets.mask
  if (typeof name !== 'string' || !name.trim()) return undefined
  const raw = await decodeRaw(assetOf(name), 'provider')
  return { w: raw.w, h: raw.h, rgba8: raw.data! }
}

/** The core's params for a case: the table's (Painter: its canvas and colour, as effects/painter.ts hands them). */
function coreParams(c: MaskCase): Record<string, unknown> {
  const p = paramsOf(c as unknown as FxCase)
  if (c.class_type !== 'Painter') return p
  return { width: p.width, height: p.height, bg: c.inputs.image ? [0, 0, 0] : painterColourOf(p.bg_color) }
}

/** Each batch index's inputs as the core takes them (Painter: the first picture alone, and its file). */
async function inputsOf(c: MaskCase): Promise<Record<string, Tensor | PainterFile>[]> {
  const n = c.class_type === 'Painter' ? 1 : Math.max(1, ...Object.values(c.inputs).map(i => i.files.length))
  const rows: Record<string, Tensor | PainterFile>[] = []
  for (let i = 0; i < n; i++) {
    const row: Record<string, Tensor | PainterFile> = {}
    for (const [name, inp] of Object.entries(c.inputs)) {
      const file = inp.files[inp.files.length === 1 ? 0 : i]
      if (inp.source === 'mask') {
        const m = await readMaskPng(assetOf(file!))
        row[name] = tk.fromMask16(m.scanlines, m.w, m.h)
      }
      else if (inp.source === 'blank') row[name] = tk.fromPicture(await decodeRaw(null, 'blank'))
      else row[name] = tk.fromPicture(await decodeRaw(assetOf(file!), inp.source as PictureSource))
    }
    if (c.class_type === 'Painter') {
      const f = await painterOf(c)
      if (f) row.painter = f
    }
    rows.push(row)
  }
  return rows
}

/** The case's outputs from the core in this thread, one per batch index, each told its place in the batch. */
async function coreRun(c: MaskCase) {
  const op = coreOp(EFFECTS[c.class_type]!.op) as unknown as Op
  const rows = await inputsOf(c)
  return rows.map((inp, i) => op(inp, coreParams(c), undefined, {}, i, rows.length))
}

/** The worst |Δ| (255-scale) between two floats of the same length. */
function worstOf(a: Float32Array, b: Float32Array): number {
  let w = 0
  for (let i = 0; i < a.length; i++) w = Math.max(w, Math.abs(a[i]! - b[i]!) * 255)
  return w
}

/**
 * A library mask's 16 bits: equal to Python's except where Python's float lies
 * within eps (255-scale) of a 16-bit rounding boundary, there ±1.
 */
function expectMaskBand(got: Uint16Array, py: Float32Array, eps: number, label: string): void {
  const want = u16Of(py)
  expect(got.length, label).toBe(want.length)
  const e16 = eps * 65535 / 255
  let far = -1
  for (let i = 0; i < want.length; i++) {
    const d = Math.abs(got[i]! - want[i]!)
    if (d === 0) continue
    const v = Math.min(1, Math.max(0, py[i]!)) * 65535
    if (d > 1 || Math.abs(v - (Math.floor(v) + 0.5)) >= e16) { far = i; break }
  }
  expect(far, `${label}: first 16-bit value outside the band (got ${got[far]}, want ${want[far]})`).toBe(-1)
}

/** trunc8 of a float (save_live_preview), as bytes. */
function trunc8Of(d: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(d.length)
  for (let i = 0; i < d.length; i++) {
    const v = Math.fround(255 * d[i]!)
    out[i] = v > 0 ? (v > 255 ? 255 : Math.trunc(v)) : 0
  }
  return out
}

/** A mask as the grey RGB preview Matte grow / shrink shows (interleaved). */
function grey3(d: Float32Array): Float32Array {
  const out = new Float32Array(d.length * 3)
  for (let i = 0; i < d.length; i++) out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = d[i]!
  return out
}

// ── A case through planNode ──────────────────────────────────────────────────

const maskNode = () => ({ class_type: 'ImageToMask', inputs: { image: ['src_mask_picture', 0], channel: 'red' } })

/**
 * A case's prompt and store: a source node per picture input (`src_<input>`),
 * a mask producer per mask input whose value is the case's kept masks, and
 * the Painter's file under input.
 */
function promptOf(c: MaskCase) {
  const prompt: ApiPrompt = {}
  const files: Record<string, Uint8Array> = {}
  const wiredFiles: Record<string, string[]> = {}
  const masks: Record<string, string[]> = {}
  const inputs: Record<string, unknown> = { ...c.widgets }
  for (const [name, i] of Object.entries(c.inputs)) {
    const src = `src_${name}`
    if (i.source === 'mask') {
      prompt[src] = maskNode()
      masks[src] = i.files
    }
    else {
      prompt[src] = sourceNode(i.source, i.files[0] ?? '')
      wiredFiles[src] = i.source === 'blank' ? [] : i.files
    }
    inputs[name] = [src, 0]
    for (const f of i.files) files[f] = assetOf(f)
  }
  if (c.class_type === 'Painter' && typeof c.widgets.mask === 'string' && FX.assets[c.widgets.mask]) files[c.widgets.mask] = assetOf(c.widgets.mask)
  prompt[c.node_id] = { class_type: c.class_type, inputs }
  const asFile = (filename: string): OutputFile => ({ filename, subfolder: '', type: 'input' })
  return {
    prompt, files,
    filesOf: (link: [string, number]) => (wiredFiles[link[0]] ?? []).map(asFile),
    valueFrom: (link: [string, number]): RunnerValue | undefined => (masks[link[0]] ? { kind: 'mask', files: masks[link[0]]!.map(asFile) } : undefined),
  }
}

async function runMaskCase(c: MaskCase, o: { families?: ReadonlySet<RunnerFamily>; prompt?: ApiPrompt; hosted?: boolean; signal?: AbortSignal } = {}) {
  const p = promptOf(c)
  const mem = memoryIO(p.files, c.node_id, { hosted: o.hosted, signal: o.signal })
  // Painter's UI.PreviewImage is saved as an asset into temp (as Preview image's files).
  mem.io.saveAsset = async (bytes, a) => {
    const f: OutputFile = { filename: `${a.prefix}_00001_.${a.ext}`, subfolder: a.subfolder ?? '', type: a.folder ?? 'output' }
    mem.store.set(`${f.type}:${f.subfolder ? `${f.subfolder}/` : ''}${f.filename}`, bytes)
    return f
  }
  const plan: NodePlan = await planNode({
    prompt: o.prompt ?? p.prompt, nodeId: c.node_id, families: o.families ?? MASK, gateOpen: false, hosted: o.hosted,
    filesFrom: p.filesOf, valueFrom: p.valueFrom, toUrl: async () => '',
  })
  expect(plan.kind).toBe('derive')
  const made = await (plan as Extract<NodePlan, { kind: 'derive' }>).derive(mem.io)
  return { made, mem, bytes: mem.bytes, previews: mem.previews, prompt: p.prompt }
}

// ── The fixture file itself ──────────────────────────────────────────────────

describe('the mask fixtures', () => {
  it('cover the 7 classes, made by multi-threaded torch', () => {
    expect(FX.threads).toBeGreaterThan(1)
    expect([...new Set(FX.cases.map(c => c.class_type))].sort()).toEqual([...MASK_CLASSES].sort())
    expect(FX.cases.length).toBeGreaterThan(400)
    const bytes = readFileSync(resolve(__dirname, 'fixtures/runner-effects-mask.json')).length
    expect(bytes).toBeLessThan(8 * 1024 * 1024)
    console.info(`mask fixtures: ${FX.cases.length} cases, ${FX.chains.length} producer chains, ${FX.negzero.length} −0 probes, ${(bytes / 1e6).toFixed(2)} MB`)
  })

  it('every class is ported: in the table, in the family, with a row; the mask slots carry masks; Painter is no output node', () => {
    for (const cls of MASK_CLASSES) {
      expect(EFFECTS[cls], cls).toMatchObject({ family: 'effects-mask', op: `mask.${cls}` })
      expect(EFFECT_CLASSES_PORTED, cls).toContain(cls)
      expect(EFFECT_FAMILY_OF[cls], cls).toBe('effects-mask')
      expect(RUNNER_NODE_RULES[cls]?.family, cls).toBe('effects-mask')
      expect(typeof (effectCores.mask as unknown as Record<string, unknown>)[cls], cls).toBe('function')
    }
    expect(EFFECTS.Blend!.batch).toBe('coupled')
    expect(EFFECTS.MergeAlpha!.equalBatches).toBe(true)
    expect(EFFECT_OUTPUT_KINDS).toMatchObject({ ThresholdMask: { 0: 'mask' }, ColorRangeMask: { 0: 'mask' }, MatteGrowShrink: { 0: 'mask' }, Painter: { 1: 'mask' } })
    expect(EFFECT_PICTURE_OUTPUTS).toMatchObject({ Blend: [0], ApplyMask: [0], MergeAlpha: [0], Painter: [0], ThresholdMask: [], MatteGrowShrink: [] })
    for (const cls of MASK_CLASSES.filter(x => x !== 'Painter')) expect(RUNNER_OUTPUT_CLASSES.has(cls), cls).toBe(true)
    expect(RUNNER_OUTPUT_CLASSES.has('Painter')).toBe(false)
    expect(RUNNER_NODE_RULES.Painter!.inputCheck).toEqual(['effect-output-size', 'painter'])
    expect(RUNNER_NODE_RULES.ApplyMask!.valueInputs).toEqual({ mask: ['mask'] })
  })

  it('Python raises where the brief says: 3 against 4 channels, batches that don\'t pair, a feather wider than the mask, a painter colour int() refuses, a missing file', () => {
    const keys = new Map<string, number>()
    for (const c of FX.cases.filter(x => x.error)) {
      const key = keyOfError(c.error!)
      keys.set(key, (keys.get(key) ?? 0) + 1)
    }
    expect([...keys.keys()].sort()).toEqual(['EFFECT_BATCHES_DIFFER', 'EFFECT_NEEDS_RGB', 'EFFECT_PICTURE_TOO_SMALL', 'engine', 'missing'])
  })
})

// ── Every case (rule 12) ─────────────────────────────────────────────────────

/** Whether eligibility leaves this case to the engine: a painter colour Python's int() reads otherwise than as two hex digits (or refuses). */
const leftToEngine = (c: MaskCase) => c.class_type === 'Painter' && !c.inputs.image && painterColourOf(c.widgets.bg_color) === null

describe('each class against Python', () => {
  for (const c of FX.cases) {
    const onlyPlan = leftToEngine(c) || (!!c.error && ['EFFECT_BATCHES_DIFFER', 'missing'].includes(keyOfError(c.error)))
    it(`core: ${c.name}`, async () => {
      if (onlyPlan) return
      if (c.error) {
        await expect(coreRun(c)).rejects.toThrow(keyOfError(c.error))
        return
      }
      const runs = await coreRun(c)
      for (const [slot, out] of c.outputs!.entries()) {
        expect(runs).toHaveLength(out.items.length)
        for (const [i, item] of out.items.entries()) {
          const t = runs[i]!.outputs[slot]!
          const label = `${c.name}, output ${slot}, picture ${i}`
          expect([t.w, t.h, t.c], label).toEqual([item.w, item.h, item.c])
          const got = out.kind === 'mask' ? t.data : interleaved(t)
          if (c.library) {
            const py = unshuffle(item.f32s!)
            expect(worstOf(got, py), label).toBeLessThanOrEqual(MATTE_EPS)
            expectMaskBand(u16Of(got), py, MATTE_EPS, label)
          }
          else {
            expect(shaF32(got), label).toBe(item.f32_sha256)
            if (out.kind === 'mask') expect(shaU16(u16Of(got)), label).toBe(item.u16_sha256)
          }
        }
      }
    })

    it(`planEffect: ${c.name}`, async () => {
      if (leftToEngine(c)) {
        expect(runnerTakesNode(promptOf(c).prompt, c.node_id, MASK)).toBe(false)
        await expect(runMaskCase(c)).rejects.toThrow(PAINTER_COLOUR_UNREAD)
        return
      }
      expect(runnerTakesNode(promptOf(c).prompt, c.node_id, MASK), 'eligible').toBe(true)
      if (c.error) {
        const key = keyOfError(c.error)
        await expect(runMaskCase(c)).rejects.toThrow(key === 'missing' ? PAINTER_FILE_MISSING : EFFECT_ERROR_MESSAGES[key]!)
        return
      }
      const run = await runMaskCase(c)
      for (const [slot, out] of c.outputs!.entries()) {
        const files = filesOfValue(run.made.values[slot])
        expect(run.made.values[slot]!.kind).toBe(out.kind === 'mask' ? 'mask' : 'files')
        expect(files).toHaveLength(out.items.length)
        for (const [i, item] of out.items.entries()) {
          const label = `${c.name}, kept ${slot}.${i}`
          if (out.kind === 'mask') {
            const got = await keptU16(run.bytes(files[i]!))
            expect([got.w, got.h], label).toEqual([item.w, item.h])
            if (c.library) expectMaskBand(got.q, unshuffle(item.f32s!), MATTE_EPS, label)
            else expect(shaU16(got.q), label).toBe(item.u16_sha256)
          }
          else {
            const got = await pngPixels(run.bytes(files[i]!))
            expect([got.w, got.h, got.channels], label).toEqual([item.w, item.h, item.c])
            expect(sha256(got.px), label).toBe(item.round8_sha256)
          }
        }
      }
      if (c.class_type === 'Painter') {
        // UI.PreviewImage: the picture truncated, into temp as ComfyUI_temp_ and five random letters.
        const ui = run.made.ui as { images: OutputFile[]; animated: boolean[] }
        expect(ui.animated).toEqual([false])
        expect(ui.images).toHaveLength(1)
        expect(ui.images[0]!.filename).toMatch(/^ComfyUI_temp_[a-z]{5}_00001_\.png$/)
        expect(c.ui!.images[0]!.filename).toMatch(/^ComfyUI_temp_[a-z]{5}_00001_\.png$/)
        expect(ui.images[0]!.type).toBe('temp')
        const shown = await pngPixels(run.bytes(ui.images[0]!))
        expect([shown.w, shown.h, shown.channels]).toEqual([c.preview!.w, c.preview!.h, c.preview!.mode.length])
        expect(sha256(shown.px)).toBe(c.preview!.px_sha256)
        expect(run.previews).toHaveLength(0)
      }
      else {
        // The live preview: the first picture as save_live_preview writes it.
        expect(run.previews).toHaveLength(1)
        expect(run.previews[0]!.filename).toBe(c.preview!.filename)
        const pv = await pngPixels(run.previews[0]!.bytes)
        expect([pv.w, pv.h, pv.channels]).toEqual([c.preview!.w, c.preview!.h, c.preview!.mode.length])
        if (c.library) {
          const item = c.outputs![0]!.items[0]!
          const py = grey3(unshuffle(item.f32s!))
          const py8 = trunc8Of(py)
          let far = -1
          for (let i = 0; i < py8.length; i++) {
            const d = Math.abs(pv.px[i]! - py8[i]!)
            if (d === 0) continue
            const v = py[i]! * 255
            if (d > 1 || Math.abs(v - Math.round(v)) >= MATTE_EPS) { far = i; break }
          }
          expect(far, 'preview outside the band').toBe(-1)
        }
        else expect(sha256(pv.px)).toBe(c.preview!.px_sha256)
        expect(run.made.ui).toEqual({
          images: c.ui!.images.map(im => ({ filename: im.filename, subfolder: 'sailor_runner', type: im.type })),
          animated: c.ui!.animated,
        })
      }
      // Read only by Save image: a picture kept as save_images writes it (trunc).
      const pictures = c.outputs!.flatMap((o, slot) => (o.kind === 'image' ? [slot] : []))
      if (pictures.length) {
        const slot = pictures[0]!
        const saved = await runMaskCase(c, { prompt: { ...run.prompt, save: saveImage([c.node_id, slot]) } })
        const tfiles = filesOfValue(saved.made.values[slot])
        for (const [i, item] of c.outputs![slot]!.items.entries()) {
          const got = await pngPixels(saved.bytes(tfiles[i]!))
          expect(sha256(got.px), `${c.name}, kept trunc ${i}`).toBe(item.trunc8_sha256)
        }
      }
    }, c.hashed ? 60_000 : 20_000)
  }
})

// ── What the cases pin ───────────────────────────────────────────────────────

describe('what the cases pin', () => {
  const find = (name: string) => {
    const c = FX.cases.find(x => x.name === name)
    if (!c) throw new Error(`no case ${name}`)
    return c
  }

  it('every Blend mode at opacity 0, 0.37 and 1, with a top of another size (resized to the base), each case exact', () => {
    for (const mode of ['normal', 'multiply', 'screen', 'overlay', 'soft_light', 'hard_light', 'difference', 'lighten', 'darken', 'add', 'subtract']) {
      for (const op of ['0.0', '0.37', '1.0']) {
        const c = find(`Blend: ${mode}, opacity ${op}, a top of another size`)
        expect(c.outputs![0]!.items[0]!.w).toBe(37)
      }
    }
    expect(find('Blend: batches 1:2').outputs![0]!.items).toHaveLength(2)
    expect(find('Blend: batches 2:1').outputs![0]!.items).toHaveLength(2)
    expect(find('Blend: batches 2:2').outputs![0]!.items).toHaveLength(2)
    expect(keyOfError(find('Blend: batches 2:3').error!)).toBe('EFFECT_BATCHES_DIFFER')
  })

  it('Merge alpha is always RGBA and its preview RGB; Apply mask keeps the picture\'s channels', () => {
    for (const c of FX.cases.filter(x => x.class_type === 'MergeAlpha' && !x.error)) {
      expect(c.outputs![0]!.items.every(i => i.c === 4), c.name).toBe(true)
      expect(c.preview!.mode, c.name).toBe('RGB')
    }
    expect(find('ApplyMask: defaults, card 23×19 see-through').outputs![0]!.items[0]!.c).toBe(4)
    expect(keyOfError(find('MergeAlpha: two pictures, one mask').error!)).toBe('EFFECT_BATCHES_DIFFER')
    expect(find('ApplyMask: two pictures, one mask').outputs![0]!.items).toHaveLength(2)
  })

  it('Matte grow / shrink: amount 0.4 rounds to nothing (k = 1), −2.5 and 2.5 to 2 (Python\'s round), 50 is a 101-pixel window', () => {
    const same = (a: string, b: string) => expect(find(a).outputs![0]!.items[0]!.f32_sha256).toBe(find(b).outputs![0]!.items[0]!.f32_sha256)
    same('MatteGrowShrink: amount 0.4, feather 0.0, mask 37×23 soft', 'MatteGrowShrink: amount 0.0, feather 0.0, mask 37×23 soft')
    same('MatteGrowShrink: amount -0.4, feather 0.0, mask 29×31 hard', 'MatteGrowShrink: amount 0.0, feather 0.0, mask 29×31 hard')
    expect(find('MatteGrowShrink: amount 2.5, feather 0.0, mask 37×23 soft').outputs![0]!.items[0]!.f32_sha256)
      .not.toBe(find('MatteGrowShrink: amount 1.0, feather 0.0, mask 37×23 soft').outputs![0]!.items[0]!.f32_sha256)
    expect(find('MatteGrowShrink: amount 50.0, feather 30.0, mask 200×190 hard').library).toBe(true)
  })

  it('Matte grow / shrink\'s max pool, taken one side at a time, equals kernels.ts maxPool2d (grow and shrink, windows 3–41, masks with ties and edges); the helper is no op', () => {
    const matte = (m: Tensor, amount: number) => effectCores.mask.MatteGrowShrink({ mask: m }, { amount, feather: 0 }).outputs[0]!
    for (const [w, h, seed] of [[37, 23, 1], [8, 50, 2], [64, 3, 3], [1, 1, 4]] as const) {
      const m = tk.tensor(1, h, w)
      for (let i = 0; i < m.data.length; i++) m.data[i] = ((Math.imul(i + seed, 2654435761) >>> 24) % 5) / 4
      for (const kk of [3, 5, 9, 21, 41]) {
        expect(shaF32(matte(m, (kk - 1) / 2).data), `grow ${w}×${h} k ${kk}`).toBe(shaF32(kn.maxPool2d(m, kk, kk >> 1).data))
        const neg = tk.tensor(1, h, w)
        for (let i = 0; i < m.data.length; i++) neg.data[i] = -m.data[i]!
        const direct = kn.maxPool2d(neg, kk, kk >> 1).data.map(v => -v)
        expect(shaF32(matte(m, -(kk - 1) / 2).data), `shrink ${w}×${h} k ${kk}`).toBe(shaF32(direct))
      }
    }
    expect(Object.keys(effectCores.mask).sort()).toEqual([...MASK_CLASSES].sort())
  })

  it('Painter: the canvas colour as its own hex_to_rgb reads it; the file isn\'t turned by its EXIF; a 4-channel base under a file raises; no file hands the picture on with a zero mask', () => {
    expect(painterColourOf('#ff8000')).toEqual([1, 128 / 255, 0])
    expect(painterColourOf('##c0ffee')).toEqual([0xc0 / 255, 1, 0xee / 255])
    expect(painterColourOf('#abc')).toEqual([0, 0, 0])
    expect(painterColourOf('')).toEqual([0, 0, 0])
    expect(painterColourOf(' #102030')).toEqual([0, 0, 0])
    expect(painterColourOf('#12345G')).toBeNull()
    expect(painterColourOf('+f-f0f')).toBeNull()
    expect(painterColourOf(12)).toBeNull()
    expect(find('Painter: an EXIF orientation 6 file of the canvas size, not turned').outputs![0]!.items[0]).toMatchObject({ w: 64, h: 128 })
    expect(keyOfError(find('Painter: a file over a see-through card picture').error!)).toBe('EFFECT_NEEDS_RGB')
    expect(find('Painter: no file, provider 29×31').outputs![0]!.items[0]!.c).toBe(4)
    expect(find('Painter: no file, a batch of two: the first').outputs![0]!.items).toHaveLength(1)
  })
})

// ── Chains: a mask from each producer, as the runner hands it on ─────────────

const card = (image: string) => ({ class_type: 'Image', inputs: { image, export: false, filename_prefix: 'ComfyUI', batch_index: -1 } })
const SAVE = { filename_prefix: 'ComfyUI', format: 'png', quality: 90, lossless_webp: false, png_compression: 4, scale: 1, max_dimension: 0, embed_metadata: false }
const saveImage = (from: [string, number]) => ({ class_type: 'SaveImage', inputs: { images: from, ...SAVE } })
const editNode = (from: [string, number]) => ({ class_type: 'EditImageNode', inputs: { model: 'Nano Banana 2', input_image: from, prompt: 'warmer', output_format: 'png', seed: 0, resolution: '1K' } })
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
function put(root: string, name: string, bytes: Uint8Array) {
  const path = join(root, 'input', name)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, bytes)
}

/** A kept store that remembers every kept file's bytes (kept bytes are let go when the run ends). */
function watchedKept(): { kept: KeptBytes; bytes: (f: OutputFile) => Uint8Array } {
  const inner = createMemoryKeptBytes()
  const seen = new Map<string, Uint8Array>()
  return {
    kept: { ...inner, put: async (runId, b, ext) => { const f = await inner.put(runId, b, ext); seen.set(f.filename, b.slice()); return f } },
    bytes: f => seen.get(f.filename)!,
  }
}

/** The producer node of a chain (its picture from an Image card of the same file: a 3-channel PNG loads as 'rgb' does), and a Matte grow / shrink after it when the chain has one. */
function producerNodes(ch: ChainCase): { nodes: ApiPrompt; from: [string, number]; slot: number } {
  const p = ch.producer
  let nodes: ApiPrompt
  let slot = 0
  if (p.class_type === 'LoadImage') { nodes = { prod: { class_type: 'LoadImage', inputs: { image: p.file!, upload: 'image' } } }; slot = 1 }
  else if (p.class_type === 'TextMask') { nodes = { prod: { class_type: 'TextMask', inputs: { params: JSON.stringify({ rendered: p.rendered }) } } }; slot = 1 }
  else if (p.class_type === 'Painter') { nodes = { prod: { class_type: 'Painter', inputs: { ...p.widgets } } }; slot = 1 }
  else if (p.class_type === 'ImageToMask') nodes = { srcp: card(p.image!.files[0]!), prod: { class_type: 'ImageToMask', inputs: { image: ['srcp', 0], channel: p.channel } } }
  else nodes = { srcp: card(p.image!.files[0]!), prod: { class_type: p.class_type, inputs: { image: ['srcp', 0], ...p.widgets } } }
  if (!ch.middle) return { nodes, from: ['prod', slot], slot }
  return { nodes: { ...nodes, mid: { class_type: 'MatteGrowShrink', inputs: { mask: ['prod', slot], ...ch.middle } } }, from: ['mid', 0], slot }
}

/** A kept tensor file's float32 body (tensor.ts tensorFileOf: a 16-byte header, then the planar floats). */
const tensorBody = (b: Uint8Array) => new Float32Array(b.slice(16).buffer)

describe('chains: a mask from each producer, handed on as its float32 tensor, as ComfyUI runs the chain node by node', () => {
  for (const ch of FX.chains) {
    it(`${ch.name}: the producer keeps Python's float mask (and its 16 bits), and the consumer is Python's own chain, through the engine`, async () => {
      for (const save of [false, true]) {
        const w = watchedKept()
        const k = makeKit({ hosted: false, deps: { families: () => MASK, kept: w.kept } })
        for (const [name, b64s] of Object.entries(FX.assets)) put(k.root, name, b64(b64s))
        const { nodes, from, slot } = producerNodes(ch)
        const pic = ch.inputs.image!.files[0]!
        const p: ApiPrompt = { ...nodes, img: card(pic), [ch.node_id]: { class_type: ch.class_type, inputs: { image: ['img', 0], mask: from, ...ch.widgets } }, ...(save ? { s: saveImage([ch.node_id, 0]) } : {}) }
        expect(isRunnerEligible(p, MASK)).toBe(true)
        const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
        await k.engine.settled(runId)
        const run = (await k.store.get(runId))!
        expect(run.status, JSON.stringify(run.takes[0]!.nodes[ch.node_id])).toBe('done')
        const mv = run.takes[0]!.nodes.prod!.values![slot] as Extract<RunnerValue, { kind: 'mask' }>
        expect(mv.kind).toBe('mask')
        // The producer's mask: saved as 16 bits, handed on as its float.
        const kept = await keptU16(w.bytes(mv.files[0]!))
        expect([kept.w, kept.h]).toEqual([ch.kept.w, ch.kept.h])
        expect(shaU16(kept.q), 'the producer\'s 16-bit mask').toBe(ch.kept.u16_sha256)
        expect(mv.tensors, 'the producer kept its float mask').toHaveLength(1)
        expect(shaF32(tensorBody(w.bytes(mv.tensors![0]!))), 'the producer\'s float mask').toBe(ch.kept.f32_sha256)
        const item = ch.outputs![0]!.items[0]!
        if (save) {
          // Save image writes Python's own chain, truncated (Text mask → Merge alpha → Save among them).
          const saved = await pngPixels(new Uint8Array(readFileSync(join(k.root, 'output', 'ComfyUI_00001_.png'))))
          expect([saved.w, saved.h, saved.channels]).toEqual([item.w, item.h, item.c])
          expect(sha256(saved.px), 'saved').toBe(item.trunc8_sha256)
        }
        else {
          const v = run.takes[0]!.nodes[ch.node_id]!.values![0] as Extract<RunnerValue, { kind: 'files' }>
          const got = await pngPixels(w.bytes(v.files[0]!))
          expect([got.w, got.h, got.channels]).toEqual([item.w, item.h, item.c])
          expect(sha256(got.px), 'the consumer\'s kept picture').toBe(item.round8_sha256)
        }
      }
      console.info(`mask chain ${ch.name}: exact; the old 16-bit hand-off would differ in ${ch.quantised.f32}/${ch.quantised.values} floats, ${ch.quantised.round8} round-8 and ${ch.quantised.trunc8} trunc-8 values`)
    }, 120_000)
  }

  it('the −0 probes reach the masks\' clamps: Matte grow / shrink and Threshold mask keep some −0 (torch\'s scalar tails)', () => {
    const negs = (cls: string) => FX.negzero.filter(x => x.class_type === cls).flatMap(x => x.items.map(i => i.neg_zeros))
    expect(negs('MatteGrowShrink').some(n => n > 0)).toBe(true)
    expect(negs('ThresholdMask').some(n => n > 0)).toBe(true)
  })

  it('the chains cover every mask producer the runner has, through Matte grow / shrink too; the 16-bit hand-off they replace was off', () => {
    const producers = new Set(FX.chains.map(c => c.producer.class_type))
    expect([...producers].sort()).toEqual(['ColorRangeMask', 'ImageToMask', 'LoadImage', 'Painter', 'TextMask', 'ThresholdMask'])
    expect(FX.chains.filter(c => c.middle).length).toBeGreaterThan(0)
    const tm = FX.chains.find(c => c.name === 'Text mask → MergeAlpha, same size')!
    expect(tm.quantised.trunc8).toBeGreaterThan(0)
    // A hard threshold is 0 or 1: 16 bits held it exactly anyway.
    expect(FX.chains.find(c => c.name === 'Threshold mask (softness 0.0) → ApplyMask, rgb 320×200')!.quantised.f32).toBe(0)
  })
})

// ── An effect's picture read by the picture utilities that work on its float (fix round 2) ──

interface EffectChain {
  name: string
  blend: { base: string; top: string; widgets: Record<string, unknown> }
  reader: { class_type: 'ImageToMask' | 'TextMask'; channel?: string; rendered?: string }
  consumer: { class_type: string; node_id: string; widgets: Record<string, unknown>; image: string } | null
  outputs: { kind: 'image' | 'mask'; items: MaskItem[] }[]
}
const EFFECT_CHAINS = (FX as unknown as { effect_chains: EffectChain[] }).effect_chains

describe('an effect\'s picture into Image to mask and Text mask\'s source: read as its float tensor, as ComfyUI\'s chain', () => {
  for (const ch of EFFECT_CHAINS) {
    it(`${ch.name}: exact, kept and saved`, async () => {
      for (const save of [false, true]) {
        const w = watchedKept()
        const k = makeKit({ hosted: false, deps: { families: () => MASK, kept: w.kept } })
        for (const [name, b64s] of Object.entries(FX.assets)) put(k.root, name, b64(b64s))
        const p: ApiPrompt = {
          b: card(ch.blend.base), t: card(ch.blend.top),
          bl: { class_type: 'Blend', inputs: { base: ['b', 0], top: ['t', 0], ...ch.blend.widgets } },
        }
        let last: string
        if (ch.reader.class_type === 'ImageToMask') {
          p.itm = { class_type: 'ImageToMask', inputs: { image: ['bl', 0], channel: ch.reader.channel } }
          p.img = card(ch.consumer!.image)
          p.c = { class_type: ch.consumer!.class_type, inputs: { image: ['img', 0], mask: ['itm', 0], ...ch.consumer!.widgets } }
          last = 'c'
        }
        else {
          p.tm = { class_type: 'TextMask', inputs: { params: JSON.stringify({ rendered: ch.reader.rendered }), source: ['bl', 0] } }
          last = 'tm'
        }
        if (save) p.s = saveImage([last, 0])
        // Unsaved, a Preview image shows it: only what an output reads runs (R3.8 fix round 1).
        else if (last === 'tm') p.pv = { class_type: 'PreviewImage', inputs: { images: [last, 0] } }
        expect(isRunnerEligible(p, MASK)).toBe(true)
        const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
        await k.engine.settled(runId)
        const run = (await k.store.get(runId))!
        expect(run.status, JSON.stringify(run.takes[0]!.nodes[last])).toBe('done')
        // Blend kept its float for the utility that reads it.
        expect((run.takes[0]!.nodes.bl!.values![0] as Extract<RunnerValue, { kind: 'files' }>).tensors).toHaveLength(1)
        const item = ch.outputs[0]!.items[0]!
        if (save) {
          const saved = await pngPixels(new Uint8Array(readFileSync(join(k.root, 'output', 'ComfyUI_00001_.png'))))
          expect([saved.w, saved.h, saved.channels]).toEqual([item.w, item.h, item.c])
          expect(sha256(saved.px), 'saved').toBe(item.trunc8_sha256)
        }
        else {
          const v = run.takes[0]!.nodes[last]!.values![0] as Extract<RunnerValue, { kind: 'files' }>
          // Text mask's picture is kept as the Preview image reading it saves it (truncated, as Python's
          // Preview does); Image to mask's consumer reads the round-8 PNG.
          expect(sha256((await pngPixels(w.bytes(v.files[0]!))).px), 'kept').toBe(last === 'tm' ? item.trunc8_sha256 : item.round8_sha256)
          if (ch.reader.class_type === 'TextMask') {
            const mv = run.takes[0]!.nodes.tm!.values![1] as Extract<RunnerValue, { kind: 'mask' }>
            expect(shaU16((await keptU16(w.bytes(mv.files[0]!))).q)).toBe(ch.outputs[1]!.items[0]!.u16_sha256)
          }
        }
      }
    }, 120_000)
  }
})

describe('a float tensor is kept only for a reader whose family is on (fix round 2)', () => {
  const on = (fam: RunnerFamily[]) => new Set<RunnerFamily>(fam)
  it('floatReadBy: effects by their family, the Frame for pictures only, Image to mask and Text mask\'s source with cards', () => {
    const p: ApiPrompt = withSources({ a: { class_type: 'ApplyMask', inputs: { image: ['0', 0], mask: ['l', 1], invert: false } } })
    expect(floatReadBy(p, 'l', 1, on(['cards']), 'mask')).toBe(false)
    expect(floatReadBy(p, 'l', 1, on(['cards', 'effects-tone']), 'mask')).toBe(false)
    expect(floatReadBy(p, 'l', 1, MASK, 'mask')).toBe(true)
    expect(floatReadBy(p, 'l', 1, undefined, 'mask')).toBe(false)
    const f: ApiPrompt = withSources({ f: { class_type: 'Compositor', inputs: frameWidgets({ layer1: ['0', 0], layer1_mask: ['l', 1] }) } })
    expect(floatReadBy(f, 'l', 1, on([...RUNNER_FAMILIES]), 'mask')).toBe(false)
    const e: ApiPrompt = { 0: card('a.png'), bl: nodeOf('Blend', ['0', 0]), i: { class_type: 'ImageToMask', inputs: { image: ['bl', 0], channel: 'red' } } }
    expect(floatReadBy(e, 'bl', 0, MASK)).toBe(true)
    expect(floatReadBy(e, 'bl', 0, on(['effects-mask']))).toBe(false)
  })

  it('with every effects family off, LoadImage → Frame keeps no tensor and the Frame reads the PNG, as before this task', async () => {
    const w = watchedKept()
    const families = on(['cards', 'frame'])
    const k = makeKit({ hosted: false, deps: { families: () => families, kept: w.kept } })
    const file = 'synth_37x23x4_21.png'
    put(k.root, file, assetOf(file))
    const p: ApiPrompt = { l: loadImage(file), f: { class_type: 'Compositor', inputs: frameWidgets({ layer1: ['l', 0], layer1_mask: ['l', 1] }) } }
    expect(isRunnerEligible(p, families)).toBe(true)
    const put0 = w.kept.put
    const exts: string[] = []
    w.kept.put = async (r, b, ext) => { exts.push(ext); return put0(r, b, ext) }
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    expect((run.takes[0]!.nodes.l!.values![1] as Extract<RunnerValue, { kind: 'mask' }>).tensors).toBeUndefined()
    expect(exts).not.toContain('bin')
  })
})

// ── −0 through the last clamp ────────────────────────────────────────────────

function hashedValues(n: number, seed: number): Float32Array {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = (((Math.imul(i, 2654435761) + seed * 40503) >>> 0) >>> 8) / 16777216
  return out
}

describe('−0 through each node\'s clamps (as a Dither upstream leaves it), pictures and masks: kept only where torch\'s loop keeps it', () => {
  const planar = (v: Float32Array, b: number, H: number, W: number, C: number) => {
    const t = tk.tensor(C, H, W)
    const n = H * W
    for (let i = 0; i < n; i++) for (let k = 0; k < C; k++) t.data[k * n + i] = v[(b * n + i) * C + k]!
    return t
  }
  for (const nz of FX.negzero) {
    it(nz.name, () => {
      const [B, H, W, C] = nz.input.shape
      const withNeg = (seed: number) => {
        const v = hashedValues(B * H * W * C, seed)
        for (let i = 0; i < v.length; i += nz.input.neg_zero_every) v[i] = -0
        return v
      }
      const x = withNeg(nz.input.seed)
      const top = nz.input.top ? withNeg(nz.input.top.seed) : null
      const m = nz.input.mask_seed !== undefined ? hashedValues(B * H * W, nz.input.mask_seed) : null
      if (m && nz.input.mask_neg_zero_every) for (let i = 0; i < m.length; i += nz.input.mask_neg_zero_every) m[i] = -0
      const op = coreOp(EFFECTS[nz.class_type]!.op) as unknown as Op
      const p = paramsOf({ class_type: nz.class_type, widgets: nz.widgets } as unknown as FxCase)
      for (let b = 0; b < B; b++) {
        const inp: Record<string, Tensor> = top
          ? { base: planar(x, b, H, W, C), top: planar(top, b, H, W, C) }
          : nz.input.mask_only ? { mask: planar(x, b, H, W, 1) }
            : m ? { image: planar(x, b, H, W, C), mask: { c: 1, h: H, w: W, data: m.slice(b * H * W, (b + 1) * H * W) } }
              : { image: planar(x, b, H, W, C) }
        const got = interleaved(op(inp, p, undefined, {}, b, B).outputs[0]!)
        let negs = 0
        for (const v of got) if (Object.is(v, -0)) negs++
        expect(negs, `picture ${b}: −0s`).toBe(nz.items[b]!.neg_zeros)
        expect(shaF32(got), `picture ${b}`).toBe(nz.items[b]!.f32_sha256)
      }
    })
  }
})

// ── Eligibility and families (rule 12) ───────────────────────────────────────

const loadImage = (image: string) => ({ class_type: 'LoadImage', inputs: { image, upload: 'image' } })
/** A node of each class, its pictures from node '0' (an Image card) and its masks from 'l' (a LoadImage's MASK). */
function nodeOf(cls: string, from: [string, number], over: Record<string, unknown> = {}): ApiPrompt[string] {
  const w = { ...defaultsOf(cls), ...over }
  switch (cls) {
    case 'Blend': return { class_type: cls, inputs: { base: from, top: from, ...w } }
    case 'ApplyMask': case 'MergeAlpha': return { class_type: cls, inputs: { image: from, mask: ['l', 1], ...w } }
    case 'MatteGrowShrink': return { class_type: cls, inputs: { mask: ['l', 1], ...w } }
    default: return { class_type: cls, inputs: { image: from, ...w } }
  }
}
const withSources = (p: ApiPrompt): ApiPrompt => ({ 0: card('a.png'), l: loadImage('m.png'), ...p })

describe('families', () => {
  it('with the family off, a workflow with the class is left to the engine and nodesNeedingEngine names it', () => {
    for (const cls of MASK_CLASSES) {
      const p = withSources({ fx: nodeOf(cls, ['0', 0]), ...(cls === 'Painter' ? { s: saveImage(['fx', 0]) } : {}) })
      expect(runnerTakesWorkflow(p, MASK), cls).toBe(true)
      expect(nodesNeedingEngine(p, { runnerOn: true, families: MASK, titleOf: id => id }), cls).toEqual([])
      for (const fam of [new Set<RunnerFamily>(['cards']), new Set<RunnerFamily>(['cards', 'effects-blur', 'effects-tone', 'effects-warp']), new Set<RunnerFamily>(['effects-mask'])]) {
        expect(runnerTakesWorkflow(p, fam), `${cls} ${[...fam]}`).toBe(false)
        expect(nodesNeedingEngine(p, { runnerOn: true, families: fam, titleOf: id => id }), `${cls} ${[...fam]}`).toContain('fx')
      }
    }
  })

  it('node by node: each class, its sources and its reader, with cards and the family on and off', () => {
    for (const cls of MASK_CLASSES) {
      const q = withSources({ fx: nodeOf(cls, ['0', 0]), e: editNode(['fx', 0]) })
      if (cls === 'ThresholdMask' || cls === 'ColorRangeMask' || cls === 'MatteGrowShrink') {
        q.e = { class_type: 'ApplyMask', inputs: { image: ['0', 0], mask: ['fx', 0], invert: false } }
      }
      const take = (fam: RunnerFamily[]) => Object.fromEntries(['fx', 'e'].map(id => [id, runnerTakesNode(q, id, new Set(fam))]))
      expect(take(['cards', 'effects-mask', 'fal-edit']), cls).toEqual({ fx: true, e: true })
      expect(isRunnerEligible(q, MASK_EDIT), cls).toBe(true)
      for (const fam of [['effects-mask', 'fal-edit'], ['cards', 'fal-edit'], ['cards', 'effects-tone', 'fal-edit']] as RunnerFamily[][]) {
        expect(take(fam).fx, `${cls} ${fam}`).toBe(false)
        expect(isRunnerEligible(q, new Set(fam)), `${cls} ${fam}`).toBe(false)
      }
    }
  })

  it('widgets ComfyUI would refuse leave it to the engine', () => {
    const take = (cls: string, over: Record<string, unknown>) => runnerTakesNode(withSources({ fx: nodeOf(cls, ['0', 0], over) }), 'fx', MASK)
    expect(take('Blend', { mode: 'color_dodge' })).toBe(false)
    expect(take('Blend', { opacity: 1.01 })).toBe(false)
    expect(take('ThresholdMask', { softness: 0.51 })).toBe(false)
    expect(take('MatteGrowShrink', { amount: 50.5 })).toBe(false)
    expect(take('MatteGrowShrink', { feather: 30 })).toBe(true)
    expect(take('Painter', { width: 4097 })).toBe(false)
    expect(take('Painter', { width: 32 })).toBe(false)
    expect(take('Painter', { width: 4096, height: 4096 })).toBe(true)
  })

  it('Painter\'s file name and colour are taken only as Python reads them; the colour only matters with no picture wired in', () => {
    const take = (over: Record<string, unknown>, image = false) =>
      runnerTakesNode({ 0: card('a.png'), fx: { class_type: 'Painter', inputs: { ...defaultsOf('Painter'), ...(image ? { image: ['0', 0] } : {}), ...over } } }, 'fx', MASK)
    expect(take({ mask: 'painter/p.png [temp]' })).toBe(true)
    expect(take({ mask: 'p.png' })).toBe(true)
    expect(take({ mask: '   ' })).toBe(true)
    for (const bad of [' p.png', 'p.png ', 'a/../p.png', '/abs/p.png', 'a\\p.png', 'p.png[temp]', 'p.png  [temp]', 'p\tq.png', 12]) {
      expect(take({ mask: bad }), JSON.stringify(bad)).toBe(false)
      expect(painterFileIsPortable(bad), JSON.stringify(bad)).toBe(false)
    }
    expect(take({ bg_color: '#12345G' })).toBe(false)
    expect(take({ bg_color: '#12345G' }, true)).toBe(true)
    expect(take({ bg_color: 'abc' })).toBe(true)
  })

  it('collectInputFiles names the painter file (hosted ownership), and none for a blank one', () => {
    expect(collectInputFiles({ fx: { class_type: 'Painter', inputs: { ...defaultsOf('Painter'), mask: 'painter/p.png [temp]' } } }))
      .toEqual([{ filename: 'p.png', subfolder: 'painter', type: 'temp' }])
    expect(collectInputFiles({ fx: { class_type: 'Painter', inputs: { ...defaultsOf('Painter'), mask: '' } } })).toEqual([])
  })
})

// ── With every effects family off, nothing changes (rule 12) ─────────────────

/** The graph with the class spliced in after every picture output (its masks from a LoadImage added). */
function spliceAfterPictures(p: ApiPrompt, cls: string): { prompt: ApiPrompt; count: number } {
  const out: ApiPrompt = JSON.parse(JSON.stringify(p))
  let count = 0
  for (const [id, n] of Object.entries(p)) {
    const slots = Object.prototype.hasOwnProperty.call(PICTURE_OUTPUTS, n.class_type) ? PICTURE_OUTPUTS[n.class_type]! : IMAGE_OUTPUT_CLASSES.has(n.class_type) ? [0] : []
    for (const slot of slots) {
      const fx = `fx_${id}_${slot}`
      for (const r of Object.values(out)) {
        for (const [name, v] of Object.entries(r.inputs ?? {})) {
          if (Array.isArray(v) && v.length === 2 && v[0] === id && v[1] === slot) r.inputs[name] = [fx, 0]
        }
      }
      out[fx] = nodeOf(cls, [id, slot])
      count++
    }
  }
  if (count) out.l = loadImage('m.png')
  return { prompt: out, count }
}
function withoutEffects(p: ApiPrompt): ApiPrompt {
  return Object.fromEntries(Object.entries(p).map(([id, n]) => [id, Object.prototype.hasOwnProperty.call(EFFECT_FAMILY_OF, n.class_type) ? { ...n, class_type: `${n.class_type}__unknown` } : n]))
}
const OFF_SETS: [string, RunnerFamily[]][] = [
  ['none', []],
  ['cards', ['cards']],
  ['cards, frame, fal-edit', ['cards', 'frame', 'fal-edit']],
  ['every family but the effects', RUNNER_FAMILIES.filter(f => !(EFFECT_FAMILIES as readonly string[]).includes(f))],
  ['every family but cards', RUNNER_FAMILIES.filter(f => f !== 'cards')],
]
function sameAsBefore(p: ApiPrompt, label: string) {
  const old = withoutEffects(p)
  for (const [name, fam] of OFF_SETS) {
    const families = new Set(fam)
    const titleOf = (id: string) => id
    expect(nodesNeedingEngine(p, { runnerOn: true, families, titleOf }), `${label}, ${name}`).toEqual(nodesNeedingEngine(old, { runnerOn: true, families, titleOf }))
    expect(runnerTakesWorkflow(p, families), `${label}, ${name}`).toBe(runnerTakesWorkflow(old, families))
    expect(isRunnerEligible(p, families), `${label}, ${name}`).toBe(isRunnerEligible(old, families))
  }
}

describe('with every effects family off, the needs-the-engine lists are as before R2.1', () => {
  it('over synthetic graphs with each class in each place', () => {
    for (const cls of MASK_CLASSES) {
      sameAsBefore(withSources({ fx: nodeOf(cls, ['0', 0]) }), `${cls} alone`)
      sameAsBefore(withSources({ fx: nodeOf(cls, ['0', 0]), e: editNode(['fx', 0]) }), `${cls} → edit`)
      sameAsBefore(withSources({ fx: nodeOf(cls, ['0', 0]), s: saveImage(['fx', 0]) }), `${cls} → save`)
      sameAsBefore(withSources({ fx: nodeOf(cls, ['0', 0]), f: { class_type: 'Compositor', inputs: frameWidgets({ layer1: ['fx', 0] }) } }), `${cls} → Frame`)
      sameAsBefore(withSources({ fx: nodeOf(cls, ['0', 0]), a: { class_type: 'ApplyMask', inputs: { image: ['0', 0], mask: ['fx', cls === 'Painter' ? 1 : 0], invert: false } } }), `${cls} → Apply mask`)
    }
  })

  const PROJECTS = resolve(__dirname, '../../../user/sailor/projects')
  const projectsIt = existsSync(PROJECTS) ? it : it.skip

  projectsIt('over every saved project graph, each with one of the 7 classes (in turn) spliced in after every picture', async () => {
    const { gunzipSync } = await import('node:zlib')
    const { graphToPrompt } = await import('~/lib/graph/graphToPrompt')
    const catalog = JSON.parse(gunzipSync(readFileSync(resolve(__dirname, '../../server/native/objectInfo.baseline.json.gz'))).toString('utf8'))
    let graphs = 0
    let spliced = 0
    let changedWhenOn = 0
    const used = new Set<string>()
    for (const uuid of readdirSync(PROJECTS).sort()) {
      let wf: { canvases?: { workflow: unknown }[] } | undefined
      try { wf = JSON.parse(readFileSync(join(PROJECTS, uuid, 'versions', 'current.json'), 'utf8')).workflow }
      catch { continue }
      for (const c of wf?.canvases ?? []) {
        let p: ApiPrompt
        try { p = graphToPrompt(c.workflow as never, catalog) }
        catch { continue }
        const cls = MASK_CLASSES[graphs % MASK_CLASSES.length]!
        graphs++
        const s = spliceAfterPictures(p, cls)
        if (!s.count) continue
        sameAsBefore(s.prompt, `${uuid} with ${cls}`)
        const on = new Set<RunnerFamily>(RUNNER_FAMILIES)
        if (JSON.stringify(nodesNeedingEngine(s.prompt, { runnerOn: true, families: on, titleOf: id => id })) !== JSON.stringify(nodesNeedingEngine(withoutEffects(s.prompt), { runnerOn: true, families: on, titleOf: id => id }))) changedWhenOn++
        spliced++
        used.add(cls)
      }
    }
    expect(graphs).toBeGreaterThanOrEqual(800)
    expect(spliced).toBeGreaterThanOrEqual(400)
    expect([...used].sort()).toEqual([...MASK_CLASSES].sort())
    expect(changedWhenOn).toBeGreaterThan(0)
    console.info(`mask families-off invariant: ${graphs} saved graphs, ${spliced} with a mask class spliced in, ${changedWhenOn} read differently with the effects on`)
  }, 300_000)
})

// ── The engine ───────────────────────────────────────────────────────────────

/** A Blend case with a see-through card under a see-through card (both Image cards in a run). */
const CARD_BLEND = FX.cases.find(x => x.name === 'Blend: mode soft_light, card 23×19 see-through')!

/** The Blend case's prompt, with its reader. */
function blendPrompt(cc: MaskCase, reader: Record<string, ApiPrompt[string]>): ApiPrompt {
  return { b: card(cc.inputs.base!.files[0]!), t: card(cc.inputs.top!.files[0]!), [cc.node_id]: { class_type: 'Blend', inputs: { base: ['b', 0], top: ['t', 0], ...cc.widgets } }, ...reader }
}

describe('the engine (cards and effects-mask on)', () => {
  it('an effect feeding Edit an image hands off its kept round-8 PNG', async () => {
    const cc = CARD_BLEND
    const k = makeKit({ hosted: false, deps: { families: () => MASK_EDIT } })
    for (const f of [...cc.inputs.base!.files, ...cc.inputs.top!.files]) put(k.root, f, assetOf(f))
    // The edit's picture shown by a card: only what an output reads runs (R3.8 fix round 1).
    const p = blendPrompt(cc, { e: editNode([cc.node_id, 0]), o: { class_type: 'Image', inputs: { image: '', export: false, images: ['e', 0], batch_index: -1 } } })
    expect(isRunnerEligible(p, MASK_EDIT)).toBe(true)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    const v = run.takes[0]!.nodes[cc.node_id]!.values![0] as Extract<RunnerValue, { kind: 'files' }>
    const uploads = (k.upload.mock.calls as unknown as [Uint8Array, string][]).filter(([, name]) => name === v.files[0]!.filename)
    expect(uploads).toHaveLength(1)
    const sent = await pngPixels(uploads[0]![0])
    expect(sent.channels).toBe(4)
    expect(sha256(sent.px)).toBe(cc.outputs![0]!.items[0]!.round8_sha256)
  })

  it('an effect → Save image saves the trunc picture', async () => {
    const cc = CARD_BLEND
    const k = makeKit({ hosted: false, deps: { families: () => MASK } })
    for (const f of [...cc.inputs.base!.files, ...cc.inputs.top!.files]) put(k.root, f, assetOf(f))
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [blendPrompt(cc, { s: saveImage([cc.node_id, 0]) })], ...START })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.status).toBe('done')
    const saved = await pngPixels(new Uint8Array(readFileSync(join(k.root, 'output', 'ComfyUI_00001_.png'))))
    expect(saved.channels).toBe(4)
    expect(sha256(saved.px)).toBe(cc.outputs![0]!.items[0]!.trunc8_sha256)
  })

  it('Merge alpha → Save image saves RGBA (its mask from Image to mask, as the fixture chain)', async () => {
    const ch = FX.chains.find(x => x.name === 'Image to mask (alpha) → MergeAlpha, same size')!
    const k = makeKit({ hosted: false, deps: { families: () => MASK } })
    for (const [name, s] of Object.entries(FX.assets)) put(k.root, name, b64(s))
    const { nodes, from } = producerNodes(ch)
    const p: ApiPrompt = { ...nodes, img: card(ch.inputs.image!.files[0]!), m: { class_type: 'MergeAlpha', inputs: { image: ['img', 0], mask: from, ...ch.widgets } }, s: saveImage(['m', 0]) }
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.status).toBe('done')
    const saved = await pngPixels(new Uint8Array(readFileSync(join(k.root, 'output', 'ComfyUI_00001_.png'))))
    expect(saved.channels).toBe(4)
    expect(sha256(saved.px)).toBe(ch.outputs![0]!.items[0]!.trunc8_sha256)
  })

  it('an effect → Frame: the Frame reads Blend\'s float tensor (a top of another size) and renders Python\'s picture exactly', async () => {
    const ch = FX.frame
    const k = makeKit({ hosted: false, deps: { families: () => MASK_FRAME, kept: createMemoryKeptBytes() } })
    const [base, top] = [ch.inputs.base!.files[0]!, ch.inputs.top!.files[0]!]
    put(k.root, base, assetOf(base))
    put(k.root, top, assetOf(top))
    const fx = ch.effect
    const p: ApiPrompt = { b: card(base), t: card(top), [fx.node_id]: { class_type: 'Blend', inputs: { base: ['b', 0], top: ['t', 0], ...fx.widgets } }, f: { class_type: 'Compositor', inputs: frameWidgets({ ...ch.frame.widgets, layer1: [fx.node_id, 0] }) } }
    expect(isRunnerEligible(p, MASK_FRAME)).toBe(true)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    expect((run.takes[0]!.nodes[fx.node_id]!.values![0] as Extract<RunnerValue, { kind: 'files' }>).tensors).toHaveLength(1)
    const frameFile = run.takes[0]!.nodes.f!.outputs[0]!
    const frame = await pngPixels(new Uint8Array(readFileSync(join(k.root, frameFile.type, frameFile.subfolder, frameFile.filename))))
    expect([frame.w, frame.h, frame.channels]).toEqual([ch.frame.w, ch.frame.h, 3])
    expect(Buffer.compare(frame.px, b64(ch.frame.image8))).toBe(0)
  })

  const painter = (over: Record<string, unknown>) => ({ class_type: 'Painter', inputs: { ...defaultsOf('Painter'), width: 64, height: 64, ...over } })
  const refused16 = () => {
    const values = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/runner-values.json'), 'utf8')) as { refused: { name: string; file: string }[] }
    return b64(values.refused.find(c => c.name === 'a 16-bit greyscale PNG')!.file)
  }

  it('Painter\'s painter file owned by someone else is refused 403 before any hold (hosted)', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => MASK } })
    put(k.root, 'painter_64x64_rgba.png', assetOf('painter_64x64_rgba.png'))
    const owned: string[] = []
    k.deps.ownership.ownsInput = async (_u, f) => { owned.push(f.filename); return f.filename !== 'painter_64x64_rgba.png' }
    const p: ApiPrompt = { fx: painter({ mask: 'painter_64x64_rgba.png' }), s: saveImage(['fx', 0]) }
    await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START })).rejects.toMatchObject({ message: 'This workflow uses a file that isn’t one of yours', statusCode: 403 })
    expect(owned).toContain('painter_64x64_rgba.png')
    expect(k.ledger.holds.size).toBe(0)
  })

  it('a painter file a card would refuse (16-bit) is refused at the start of the take, before any hold; one that isn\'t there fails the node plainly', async () => {
    const k = makeKit({ hosted: false, deps: { families: () => MASK } })
    put(k.root, 'deep.png', refused16())
    await expect(k.engine.startRun({ userId: k.userId, takes: [{ fx: painter({ mask: 'deep.png' }), s: saveImage(['fx', 0]) }], ...START })).rejects.toThrow(PICTURE_16_BIT)
    expect(k.ledger.holds.size).toBe(0)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [{ fx: painter({ mask: 'gone.png' }), s: saveImage(['fx', 0]) }], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('error')
    expect(JSON.stringify(run.takes[0]!.nodes.fx)).toContain(PAINTER_FILE_MISSING)
  })

  it('Painter → Save image: the canvas under the file, saved as Python saves it; the mask its alpha', async () => {
    const c = FX.cases.find(x => x.name === 'Painter: a file of another size (Lanczos)')!
    const w = watchedKept()
    const k = makeKit({ hosted: false, deps: { families: () => MASK, kept: w.kept } })
    put(k.root, c.widgets.mask as string, assetOf(c.widgets.mask as string))
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [{ fx: { class_type: 'Painter', inputs: c.widgets }, s: saveImage(['fx', 0]) }], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    const saved = await pngPixels(new Uint8Array(readFileSync(join(k.root, 'output', 'ComfyUI_00001_.png'))))
    expect(sha256(saved.px)).toBe(c.outputs![0]!.items[0]!.trunc8_sha256)
    const m = run.takes[0]!.nodes.fx!.values![1] as Extract<RunnerValue, { kind: 'mask' }>
    expect(shaU16((await keptU16(w.bytes(m.files[0]!))).q)).toBe(c.outputs![1]!.items[0]!.u16_sha256)
    // UI.PreviewImage's file, in temp.
    const shown = (readdirSync(join(k.root, 'temp'), { recursive: true }) as string[]).filter(f => /ComfyUI_temp_[a-z]{5}_00001_\.png$/.test(f))
    expect(shown).toHaveLength(1)
    expect(sha256((await pngPixels(new Uint8Array(readFileSync(join(k.root, 'temp', shown[0]!))))).px)).toBe(c.preview!.px_sha256)
  })
})

// ── Work (rule 7) ────────────────────────────────────────────────────────────

const solids = new Map<string, Promise<Uint8Array>>()
function solidPng(side: number, channels: 3 | 4 = 3): Promise<Uint8Array> {
  const key = `${side}:${channels}`
  if (!solids.has(key)) {
    solids.set(key, sharp({ create: { width: side, height: side, channels, background: { r: 90, g: 120, b: 200, alpha: 0.5 } }, limitInputPixels: false })
      .png({ compressionLevel: 1 }).toBuffer().then(b => new Uint8Array(b)))
  }
  return solids.get(key)!
}
const masks16 = new Map<number, Promise<Uint8Array>>()
function maskPng(side: number): Promise<Uint8Array> {
  if (!masks16.has(side)) {
    masks16.set(side, sharp(Buffer.alloc(side * side, 0x80), { raw: { width: side, height: side, channels: 1 }, limitInputPixels: false })
      .toColourspace('grey16').png({ compressionLevel: 1 }).toBuffer().then(b => new Uint8Array(b)))
  }
  return masks16.get(side)!
}

/** A case over side × side inputs (a Frame's picture, a kept mask), for the caps and the budget. */
async function bigCase(cls: string, widgets: Record<string, unknown>, side: number, o: { hosted?: boolean } = {}) {
  const schema = effectSchemaOf(cls)!
  const inputs: MaskCase['inputs'] = {}
  for (const i of schema.images) inputs[i.name] = { source: 'rgb', files: ['big.png'] }
  for (const m of schema.masks) inputs[m.name] = { source: 'mask', files: ['bigmask.png'] }
  const c: MaskCase = { name: cls, class_type: cls, node_id: 'fx', widgets, inputs }
  const p = promptOf({ ...c, inputs: {} })
  const files = { 'big.png': await solidPng(side), 'bigmask.png': await maskPng(side) }
  const prompt: ApiPrompt = { ...p.prompt }
  const wired: Record<string, string[]> = {}
  const masks: Record<string, string[]> = {}
  for (const [name, i] of Object.entries(inputs)) {
    const src = `src_${name}`
    prompt[src] = i.source === 'mask' ? maskNode() : sourceNode('rgb', 'big.png')
    if (i.source === 'mask') masks[src] = i.files
    else wired[src] = i.files
    prompt.fx!.inputs[name] = [src, 0]
  }
  const asFile = (filename: string): OutputFile => ({ filename, subfolder: '', type: 'input' })
  const mem = memoryIO(files, 'fx', { hosted: o.hosted })
  const plan: NodePlan = await planNode({
    prompt, nodeId: 'fx', families: MASK, gateOpen: false, hosted: o.hosted, toUrl: async () => '',
    filesFrom: link => (wired[link[0]] ?? []).map(asFile),
    valueFrom: link => (masks[link[0]] ? { kind: 'mask', files: masks[link[0]]!.map(asFile) } : undefined),
  })
  return { mem, derive: () => (plan as Extract<NodePlan, { kind: 'derive' }>).derive(mem.io) }
}

/** What the caps and budget make of this node on side × side inputs, the decoders refusing to run ('accepted': it got to a decode). */
async function gate(cls: string, widgets: Record<string, unknown>, side: number, o: { hosted?: boolean } = {}): Promise<string> {
  const { mem, derive } = await bigCase(cls, widgets, side, o)
  const before = decodeWatch.calls
  decodeWatch.refuse = true
  try {
    await derive()
    throw new Error('the decoder was not reached')
  }
  catch (e) {
    if (decodeWatch.calls - before > 0) return 'accepted'
    expect(mem.kept()).toBe(0)
    expect(mem.previews).toHaveLength(0)
    return (e as Error).message
  }
  finally { decodeWatch.refuse = false }
}

describe('work', () => {
  const HEAVIEST: Record<string, Record<string, unknown>> = {
    Blend: { mode: 'soft_light', opacity: 0.5 }, ApplyMask: { invert: true }, ThresholdMask: { softness: 0.3 }, ColorRangeMask: { tolerance: 0.5 },
    MatteGrowShrink: { amount: 50, feather: 30 }, MergeAlpha: { invert_mask: true },
  }

  it('every class\'s defaults are accepted at 4096² (and 8192²), its heaviest setting accepted or refused before decoding', async () => {
    const report: string[] = []
    for (const cls of MASK_CLASSES.filter(x => x !== 'Painter')) {
      expect(await gate(cls, defaultsOf(cls), 4096), `${cls} defaults at 4096²`).toBe('accepted')
      const d8 = await gate(cls, defaultsOf(cls), 8192)
      expect(d8, `${cls} defaults at 8192²`).toBe('accepted')
      const h4 = await gate(cls, { ...defaultsOf(cls), ...HEAVIEST[cls] }, 4096)
      expect(['accepted', EFFECT_TOO_MUCH_WORK], `${cls} heaviest at 4096²`).toContain(h4)
      report.push(`${cls} ${h4 === 'accepted' ? 'ok' : 'over'}`)
    }
    console.info(`mask budget through plan.ts (heaviest at 4096²): ${report.join(', ')}`)
  }, 300_000)

  it('Matte grow / shrink: the widest window with the widest feather fits at 4096², not past the budget at 8192²; the hosted cap is 4096²', async () => {
    expect(EFFECTS.MatteGrowShrink!.work!({ amount: 50, feather: 30 }, { w: 4096, h: 4096 })).toBeLessThan(EFFECT_MAX_WORK)
    expect(await gate('MatteGrowShrink', { amount: 50, feather: 30 }, 4096)).toBe('accepted')
    expect(await gate('ApplyMask', { invert: false }, 8192, { hosted: true })).toBe(EFFECT_PICTURE_TOO_LARGE_HOSTED)
    expect(await gate('ApplyMask', { invert: false }, 8193)).toBe(EFFECT_PICTURE_TOO_LARGE)
  }, 300_000)

  it('Painter\'s work: a 4096² canvas from an 8192² file (Lanczos down) and from a 64² file (up), within the budget', () => {
    expect(painterWork({ width: 4096, height: 4096 }, null, { w: 8192, h: 8192 })).toBeLessThan(EFFECT_MAX_WORK)
    expect(painterWork({ width: 4096, height: 4096 }, null, { w: 64, h: 64 })).toBeLessThan(EFFECT_MAX_WORK)
    expect(painterWork({ width: 64, height: 64 }, null, null)).toBeGreaterThan(0)
  })

  it('time check: Matte grow / shrink at amount 50, feather 30 on a 2048² mask, on the worker (decode, work, encode, keep)', async () => {
    const side = 2048
    const w = { amount: 50, feather: 30 }
    const work = EFFECTS.MatteGrowShrink!.work!(w, { w: side, h: side })
    const { derive } = await bigCase('MatteGrowShrink', w, side)
    const t0 = performance.now()
    const made = await derive()
    const s = (performance.now() - t0) / 1000
    expect(filesOfValue(made.values[0])).toHaveLength(1)
    console.info(`time check: Matte 50/30 on 2048² on the worker: ${s.toFixed(1)} s; work ${(work / 1e9).toFixed(2)} × 10⁹ (the budget's rate: ${(work / 0.37e9).toFixed(1)} s)`)
    expect(s).toBeLessThan(60)
  }, 180_000)

  it('time check: Blend (soft light, a top of another size) on 2048² pictures, on the worker', async () => {
    const side = 2048
    const w = { mode: 'soft_light', opacity: 0.5 }
    const work = EFFECTS.Blend!.work!(w, { w: side, h: side })
    const { derive } = await bigCase('Blend', w, side)
    const t0 = performance.now()
    await derive()
    const s = (performance.now() - t0) / 1000
    console.info(`time check: Blend on 2048² on the worker: ${s.toFixed(1)} s; work ${(work / 1e9).toFixed(2)} × 10⁹ (the budget's rate: ${(work / 0.37e9).toFixed(1)} s)`)
    expect(s).toBeLessThan(60)
  }, 180_000)
})

// ── The esbuild guard ────────────────────────────────────────────────────────

describe('esbuild guard: the mask core survives Nitro’s build, with its kernels and the pixels core', () => {
  const require = createRequire(import.meta.url)
  const pnpm = fileURLToPath(new URL('../../node_modules/.pnpm/', import.meta.url))
  const builds = readdirSync(pnpm).filter(d => /^esbuild@\d/.test(d)).map(d => join(pnpm, d, 'node_modules', 'esbuild'))
  const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../../server/runner/${rel}`, import.meta.url)), 'utf8')
  const dir = mkdtempSync(join(tmpdir(), 'mask-esbuild-'))
  const painterCase = FX.cases.find(x => x.name === 'Painter: a file of another size (Lanczos)')!

  it('finds an esbuild to build with', () => {
    expect(builds.length).toBeGreaterThan(0)
  })

  for (const esbuildDir of builds) {
    for (const minify of [false, true]) {
      it(`${esbuildDir.split('/').at(-3)} target es2019, minify ${minify}: the source-text cores run, in a Worker too`, async () => {
        const esb = require(esbuildDir) as typeof import('esbuild')
        const build = async (rel: string, name: string) => {
          let code = (await esb.transform(src(rel), { loader: 'ts', target: 'es2019', format: 'esm' })).code
          if (minify) code = (await esb.transform(code, { loader: 'js', target: 'es2019', minify: true })).code
          const file = join(dir, `${name}-${minify}.mjs`)
          writeFileSync(file, code)
          return await import(`${pathToFileURL(file).href}?${Math.random()}`) as Record<string, (...a: unknown[]) => unknown>
        }
        const px = await build('pixels/core.ts', 'pixels')
        const tkm = await build('effects/core/tensor.ts', 'tensor')
        const knm = await build('effects/core/kernels.ts', 'kernels')
        const mm = await build('effects/core/mask.ts', 'mask')
        const pxB = new Function(`return (${px.pixelsCore!.toString()})()`)()
        const tkB = new Function('px', `return (${tkm.tensorCore!.toString()})(px)`)(pxB)
        const knB = new Function('k', 'px', `return (${knm.kernelsCore!.toString()})(k, px)`)(tkB, pxB)
        const maskB = new Function('k', 'kn', 'px', `return (${mm.maskCore!.toString()})(k, kn, px)`)(tkB, knB, pxB) as Record<string, Op>
        const [inp] = await inputsOf(painterCase)
        const out = maskB.Painter!(inp!, coreParams(painterCase), undefined, {}, 0, 1)
        expect(shaF32(interleaved(out.outputs[0]!))).toBe(painterCase.outputs![0]!.items[0]!.f32_sha256)
        expect(shaU16(u16Of(out.outputs[1]!.data))).toBe(painterCase.outputs![1]!.items[0]!.u16_sha256)
        const cores = [
          { name: 'tk', fn: tkm.tensorCore as never, args: ['px'] },
          { name: 'kn', fn: knm.kernelsCore as never, args: ['tk', 'px'] },
          { name: 'mask', fn: mm.maskCore as never, args: ['tk', 'kn', 'px'] },
        ]
        const w = new Worker(workerScript(compositorCore, px.pixelsCore as never, cores), { eval: true, workerData: { stop: new SharedArrayBuffer(4) } })
        try {
          const reply = (m: Record<string, unknown>) => new Promise<any>((res) => { w.once('message', res); w.postMessage(m) })
          const f = (inp as Record<string, PainterFile>).painter!
          expect((await reply({ id: 1, op: 'fx.begin', cls: 'Painter', fn: 'mask.Painter', params: coreParams(painterCase), count: 1 })).error).toBeUndefined()
          const r = await reply({ id: 2, op: 'fx.run', index: 0, inputs: { painter: { rgba8: f.rgba8.slice(), w: f.w, h: f.h } }, first: false, masks: [false, true], want: { round: [true, false], trunc: [true, false] } })
          expect(r.error).toBeUndefined()
          expect(sha256(r.value.outputs[0].round8)).toBe(painterCase.outputs![0]!.items[0]!.round8_sha256)
          expect(sha256(r.value.outputs[0].trunc8)).toBe(painterCase.outputs![0]!.items[0]!.trunc8_sha256)
        }
        finally { await w.terminate() }
      }, 30_000)
    }
  }
})

// ── Stop ─────────────────────────────────────────────────────────────────────

describe('Stop', () => {
  const PATHS: [string, Record<string, unknown>][] = [
    ['Blend', { mode: 'overlay', opacity: 0.4 }], ['ApplyMask', { invert: true }], ['ThresholdMask', { softness: 0 }], ['ThresholdMask', { softness: 0.2, invert: true }],
    ['ColorRangeMask', { invert: true }], ['MatteGrowShrink', { amount: 3, feather: 0 }], ['MatteGrowShrink', { amount: -3, feather: 2 }], ['MatteGrowShrink', { amount: 0, feather: 1 }],
    ['MergeAlpha', { invert_mask: true }], ['Painter', {}],
  ]
  const x = tk.tensor(3, 256, 40)
  for (let i = 0; i < x.data.length; i++) x.data[i] = (i % 97) / 97
  const small = tk.tensor(3, 100, 30)
  for (let i = 0; i < small.data.length; i++) small.data[i] = (i % 89) / 89
  const m = tk.tensor(1, 256, 40)
  for (let i = 0; i < m.data.length; i++) m.data[i] = (i % 13) / 13
  const painterFile: PainterFile = { w: 30, h: 100, rgba8: new Uint8Array(30 * 100 * 4).map((_v, i) => (i * 37) & 255) }

  for (const [cls, over] of PATHS) {
    it(`${cls} ${JSON.stringify(over)}: every Stop check along the run stops it`, () => {
      const op = coreOp(EFFECTS[cls]!.op) as unknown as Op
      const w = { ...defaultsOf(cls), ...over }
      const p = cls === 'Painter' ? { width: 40, height: 256, bg: [0, 0, 0] } : effectParams(effectSchemaOf(cls)!, w)
      const inp: Record<string, Tensor | PainterFile> = cls === 'Blend' ? { base: x, top: small }
        : cls === 'MatteGrowShrink' ? { mask: m }
          : cls === 'Painter' ? { painter: painterFile }
            : cls === 'ApplyMask' || cls === 'MergeAlpha' ? { image: x, mask: { c: 1, h: 100, w: 30, data: small.data.slice(0, 3000) } }
              : { image: x }
      let total = 0
      op(inp, p, () => { total++; return false })
      expect(total, 'checks in a whole run').toBeGreaterThanOrEqual(3)
      for (const at of [1, 2, Math.ceil(total / 2), total - 1, total]) {
        let calls = 0
        expect(() => op(inp, p, () => ++calls >= at), `stopped at check ${at} of ${total}`).toThrow('Stopped')
        expect(calls).toBe(at)
      }
    })
  }
})

// ── The ε sweep (`--group mask --sweep`) ─────────────────────────────────────

const SWEEP = process.env.MASK_SWEEP_FILE
describe.skipIf(!SWEEP)('the mask ε sweep (fresh masks from scripts/runner_effects_fixtures.py --group mask --sweep)', () => {
  it('the mask ε sweep: Matte grow / shrink\'s feather within MATTE_EPS on every fresh mask', async () => {
    const { cases } = JSON.parse(readFileSync(SWEEP!, 'utf8')) as { cases: { w: number; h: number; seed: number; kind: string; widgets: Record<string, number>; f32s?: string; error?: string }[] }
    let worst = 0
    let worstAt = ''
    let n = 0
    for (const sc of cases) {
      if (sc.error) continue
      const q = synthMask(sc.w, sc.h, sc.seed, sc.kind)
      const t = tk.tensor(1, sc.h, sc.w)
      for (let i = 0; i < q.length; i++) t.data[i] = Math.fround(q[i]! / 65535)
      const out = effectCores.mask.MatteGrowShrink({ mask: t }, sc.widgets).outputs[0]!
      const py = unshuffle(sc.f32s!)
      const d = worstOf(out.data, py)
      if (d > worst) { worst = d; worstAt = `${sc.w}×${sc.h} ${sc.kind} ${JSON.stringify(sc.widgets)}` }
      expectMaskBand(u16Of(out.data), py, MATTE_EPS, `${sc.w}×${sc.h} seed ${sc.seed}`)
      n++
    }
    console.info(`mask ε sweep: ${n} masks, worst |Δ|·255 ${worst.toExponential(2)} (${worstAt}); MATTE_EPS ${MATTE_EPS.toExponential(2)} = ${(MATTE_EPS / Math.max(worst, 1e-30)).toFixed(1)}× the worst`)
    expect(worst).toBeLessThanOrEqual(MATTE_EPS)
  }, 600_000)
})

/** The fixture script's synth_mask (the sweep's masks), from `synth`'s bytes. */
function synthMask(w: number, h: number, seed: number, kind: string): Uint16Array {
  let s = (seed >>> 0) || 0x9E3779B9
  const next = () => {
    s ^= s << 13; s >>>= 0
    s ^= s >>> 17
    s ^= s << 5; s >>>= 0
    return s
  }
  const out = new Uint16Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = ((x * 37 + y * 11) & 255) ^ (next() & 31)
      if (kind === 'hard') out[y * w + x] = (((Math.floor(x / 4) + Math.floor(y / 3) + seed) % 3 === 0) || v < 40) ? 65535 : 0
      else {
        let q = Math.min(v * 257 + (((x * y * 31 + seed) >>> 0) & 255), 65535)
        if ((x + y) % 7 === 0) q = 0
        if ((x * 3 + y) % 11 === 0) q = 65535
        out[y * w + x] = q
      }
    }
  }
  return out
}
